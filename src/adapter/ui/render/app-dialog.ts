/**
 * 🔴 **アプリ自身の確認ダイアログ**(#299。user 裁定 2026-08-21)。
 *
 * > 「**正直、ブラウザの方のアラートはマウスの動線が多くてウザいから、
 * > 自前の方が嬉しい**」(user 2026-08-21)
 *
 * ## なぜ差し替えるのか(3 つとも実測が支えている)
 *
 * 1. 🔴 **`window.confirm` はレンダラを止める。** JS ダイアログが開いている間、
 *    Chrome は**ネストしたメッセージループ**に入るので、CDP の
 *    `Input.dispatchKeyEvent` / `Page.captureScreenshot` / `Runtime.evaluate` が
 *    **どれも返らない**。2026-08-21 の実機検証はこれを「**画面全体が固まる**」と
 *    報告し、**存在しない P0 を 1 件追わせた**(自作の対照群で再現済み)
 * 2. 🔴 **Chromium の「このページにこれ以上ダイアログを表示させない」は解除できない。**
 *    選ばれると以後の `confirm` は**何も出さずに即 false** ── 確認つきの操作が
 *    全部「押しても 1 ドットも変わらないボタン」になる。いまは
 *    直す前は**時間で見抜いて理由を出す**だけの緩和しか持てなかった
 *    (`platform/ask-confirm.ts`。#299 段④ で役目を終えて畳んだ)
 * 3. 🔴 **確認の枝が test から見えない。** happy-dom に `window.confirm` は
 *    **無い**(実測)ので unit は「confirm が無い環境」枝へ落ち、smoke は
 *    Playwright が事前に応答するので**モーダルが開いたまま**にならない ──
 *    結果、確認つき操作 8 面が**一度も「開いた状態」で検査されていなかった**
 *
 * ## 作り
 *
 * **素の `<dialog>` を使う。** 自前で overlay を組まない ── ブラウザが
 * 焦点の閉じ込め・`Escape`・背景の不活性化を持っているものを捨てない。
 * ⚠ `showModal()` / `close(値)` / `returnValue` / `open` は **happy-dom にも在る**
 * (実測)ので、**unit と実ブラウザで同じ経路が通る** ── これが差し替えの
 * いちばん大きな取り分である(上の 3 番)。
 *
 * ⚠ **返すのは Promise**。呼び側は「開く → 答えが来たら続きを撃つ」に書き換える
 * (同期の `boolean` を返す形は、`window.confirm` を捨てた時点で作れない)。
 */

/** 押した結果。⚠ `Escape` と「やめる」は**同じ**(取り消し)。 */
import type { SnippetChoice } from '@features/snippet/snippet-menu';

export type DialogAnswer = 'ok' | 'cancel';

export interface ConfirmOptions {
  /** 受ける側のボタンの字。⚠ **何が起きるか**を書く(「はい」にしない)。 */
  okLabel?: string;
  /** 取り消す側の字。 */
  cancelLabel?: string;
  /**
   * 受ける側を**危険色**にするか(削除・掃除など戻しにくい操作)。
   * ⚠ 既定は `false` ── 色は情報にだけ使う(不可侵指示「地は無彩色」)。
   */
  danger?: boolean;
}

/** この器が使う region 名。⚠ **test / smoke はここだけを見る**。 */
export const DIALOG_REGION = 'app-dialog';

interface Frame {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  body: HTMLElement;
  ok: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

/**
 * 器は **1 つだけ**作って使い回す。
 * ⚠ 開くたびに作り直すと、閉じるアニメーションの途中で参照が入れ替わり、
 *   `returnValue` を取り違える(器を捨てない規律)。
 */
let frame: Frame | null = null;

/**
 * 🔴 **順番に出す**(#299 段⑤。着地前レビュー R7)。
 *
 * ⚠ 段① は「既に開いていたら**待たずに取り消しを返す**」形にしていた ── 2 枚重ねると
 *   下の 1 枚が答えを失って永久に待つ、を避けるためである。**その心配は正しいが、
 *   出した答えが間違っていた** ── 実際に起きるのは「**頼んだ操作が黙って捨てられる**」
 *   ほうだった:
 *   ① 設定の「使っていない添付を消す」を押す(走査は worker で数秒かかる)
 *   ② 走査の間に一覧へ戻ってノートを削除 → 確認が開く
 *   ③ 走査が終わって整理の確認が呼ばれる → **開いているので即 `cancel`** →
 *      `runExplicitPurge` は無言で return ── 帯にも画面にも 1 行も出ない
 *   ④ 知らせるだけの `alert` はもっと悪く、**断りの理由が丸ごと消える**
 * 🔑 **native の `confirm` は直列だった**(レンダラごと止めるので、そもそも重ならない)。
 *   置き換えるなら**そこも真似る** ── 器は 1 つのまま、**出す順番を 1 本の鎖にする**。
 * ⚠ だから「2 枚目は捨てる」規則は要らなくなる(構造として重ならない)。
 */
let chain: Promise<unknown> = Promise.resolve();
let pending = 0;

/**
 * ⚠ **空いているときは同期で開く。** 待ち行列にすると 1 マイクロタスク遅れるが、
 *   それは**押した瞬間に開かない**ということである ── 素のまま起動は
 *   `window.open` を user の操作の続きで呼ぶ必要があり(transient activation)、
 *   間に微少な遅れが挟まると弾かれる実装系がある。**重なったときだけ**並ばせる。
 */
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  // ⚠ 前が転んでも列は進める(`run, run`)── 1 つの例外で以後が永久に止まらないように
  const started = pending === 0 ? run() : chain.then(run, run);
  pending += 1;
  const settle = (): void => {
    pending -= 1;
  };
  chain = started.then(settle, settle);
  return started;
}

/**
 * いま自前のダイアログが開いているか。
 * 🔑 **近道キーの門がこれを読む**(`binder.ts` の `onShortcut`)── 判定を 2 か所に
 *   書くと、片方だけ直した日に片方だけ死ぬ(CLAUDE.md §7)。
 */
export function isAppDialogOpen(): boolean {
  return frame !== null && frame.dialog.open;
}

function ensureFrame(host: HTMLElement): Frame {
  if (frame !== null && host.contains(frame.dialog)) return frame;
  const dialog = document.createElement('dialog');
  dialog.setAttribute('data-pkc-region', DIALOG_REGION);
  const title = document.createElement('h2');
  title.setAttribute('data-pkc-field', 'dialog-title');
  const body = document.createElement('p');
  body.setAttribute('data-pkc-field', 'dialog-body');
  const row = document.createElement('div');
  row.setAttribute('data-pkc-region', 'dialog-buttons');
  /**
   * ⚠ **取り消しが先、受けるのが後**(macOS / GNOME の並び)。
   * ⚠ どちらも `type="button"` ── `<form method="dialog">` を使うと
   *   **Enter で先頭のボタンが暗黙に押される**ので、削除が Enter 1 つで通る。
   */
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.setAttribute('data-pkc-field', 'dialog-cancel');
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.setAttribute('data-pkc-field', 'dialog-ok');
  row.append(cancel, ok);
  dialog.append(title, body, row);
  host.append(dialog);
  frame = { dialog, title, body, ok, cancel };
  return frame;
}

/**
 * 確認を出して、答えを返す。
 *
 * ⚠ **重なったら順番に出す**(上の `enqueue` を見よ)── 捨てない。
 */
export function confirmInApp(
  host: HTMLElement,
  message: string,
  opts: ConfirmOptions = {},
): Promise<DialogAnswer> {
  // ⚠ 器は**自分の番が来てから**掴む ── 待っている間に面ごと作り直されうる
  return enqueue(() => {
    const f = ensureFrame(host);
    f.title.textContent = '確認';
    f.body.textContent = message;
    f.ok.textContent = opts.okLabel ?? 'はい';
    f.cancel.textContent = opts.cancelLabel ?? 'やめる';
    if (opts.danger === true) f.ok.setAttribute('data-pkc-danger', '');
    else f.ok.removeAttribute('data-pkc-danger');
    f.cancel.hidden = false;
    return open(f, 'cancel');
  });
}

/**
 * 知らせるだけ(`window.alert` の置き換え)。
 * ⚠ ボタンは 1 つ ── 取り消す先が無いのに「やめる」を出さない。
 * 🔴 **知らせるものは絶対に捨てない** ── 断りの理由(「他のタブで編集中です」等)は
 *   これでしか届かない。重なったら順番に出す。
 */
export function alertInApp(host: HTMLElement, message: string): Promise<DialogAnswer> {
  return enqueue(() => {
    const f = ensureFrame(host);
    f.title.textContent = 'お知らせ';
    f.body.textContent = message;
    f.ok.textContent = '閉じる';
    f.ok.removeAttribute('data-pkc-danger');
    // ⚠ **消さずに隠す**(器を捨てない)── 消すと次の確認で作り直しになる
    f.cancel.hidden = true;
    return open(f, 'ok');
  });
}

/**
 * 開いて、閉じるまで待つ。
 *
 * ⚠ **`close` を 1 か所で受ける** ── ボタン・`Escape`・外からの `close()` の
 *   どれで閉じても、待っている側は必ず 1 回だけ解決される。
 * @param onDismiss `Escape` など「押さずに閉じた」ときの答え
 */
function open(f: Frame, onDismiss: DialogAnswer): Promise<DialogAnswer> {
  return new Promise<DialogAnswer>((resolve) => {
    /**
     * 🔴 **答えは `returnValue` に持たせない**(2026-08-21 の変異試験で判明)。
     *
     * ⚠ `<dialog>.returnValue` は **`close()` しても残る**のが仕様だが、
     *   **happy-dom は素の `close()` で空に戻す**(実測:
     *   `close('ok')` → `'ok'` / 開き直しても `'ok'` / 素の `close()` → `''`)。
     *   つまり「前回の答えを持ち越す」という**実ブラウザだけの壊れ方**が
     *   **unit からは永久に見えない** ── 変異試験で実際に生き延びた
     *   (CLAUDE.md §3「stub が実装より正しいとバグが隠れる」の、環境が
     *   **甘い**側の顔)。
     * 🔑 だから **1 回の呼び出しに閉じた局所変数**で持つ ── 持ち越しは
     *   **構造として起こりえなくなる**(規則を足すのではなく、場所を変える)。
     */
    let answer: DialogAnswer | null = null;
    /**
     * 🔴 **焦点を借りたら返す**(2026-08-21、段② で実際に踏んだ)。
     *
     * ⚠ `showModal()` は焦点を**ダイアログの中へ移す**。native の `confirm` は
     *   閉じたときに勝手に戻してくれるが、`<dialog>` は**戻さない**。
     * ⚠ 実害は「押した後に鍵が死ぬ」形で出た ── ファイラは**組み直す直前に
     *   「表の中に焦点があったか」を見て**戻す作りなので、焦点がダイアログに
     *   居ると `null` と判定され、削除後に焦点が `body` へ落ちて
     *   **Backspace も Delete も Ctrl+A も効かなくなる**。
     * 🔑 **器の側で戻す** ── 呼び出し 8 面それぞれに後始末を書くと、
     *   1 つ書き忘れた面だけが死ぬ(CLAUDE.md §7)。
     * ⚠ 戻すのは**続きを撃つ前** ── 後にすると、続きが起こす再描画のときに
     *   まだダイアログに焦点が在ることになり、同じ穴に落ちる。
     */
    const focusedBefore = f.dialog.ownerDocument.activeElement;
    /**
     * 🔴 **節点が消えても「どの面に居たか」は残す**(#299 段⑤。着地前レビュー R8)。
     *
     * ⚠ 上の戻しは**要素の同一性**で書いてある ── 待っている間に面ごと組み直されると
     *   `isConnected === false` になって**誰も戻さない**。
     * ⚠ そして面の側の持ち越しも働かない ── `filer.ts` は「組み直す**直前**に
     *   焦点が面の中にあったか」で判定するので、焦点がダイアログに居る間は
     *   `null` と読む(2 ペインはそもそも持ち越しを持たない)。
     * ⚠ native の `confirm` はレンダラごと止めるので**この窓は無かった**ものである。
     * 🔑 だから面(region)を控えて、消えていたらそこへ返す ── 「消えた行へ
     *   焦点を当てにいかない」は保ったまま、**鍵が死ぬ**のだけを防ぐ。
     */
    const regionBefore =
      focusedBefore instanceof HTMLElement ? focusedBefore.closest('[data-pkc-region]') : null;
    const done = (): void => {
      f.ok.removeEventListener('click', onOk);
      f.cancel.removeEventListener('click', onCancel);
      f.dialog.removeEventListener('close', onClose);
      // ⚠ 消えていたら**面へ**返す(消えた行そのものへ焦点を当てにはいかない)
      if (focusedBefore instanceof HTMLElement && focusedBefore.isConnected)
        focusedBefore.focus();
      else if (regionBefore instanceof HTMLElement && regionBefore.isConnected)
        // ⚠ `tabindex="-1"` も**焦点は当てられる**(タブで辿れないだけ)── 除くと
        //    2 ペイン(器も行も -1)で 1 つも見つからず、`body` へ落ちたままになる
        (regionBefore.hasAttribute('tabindex')
          ? regionBefore
          : (regionBefore.querySelector<HTMLElement>('[tabindex]') ?? regionBefore)
        ).focus();
      resolve(answer ?? onDismiss);
    };
    const onOk = (): void => {
      answer = 'ok';
      f.dialog.close();
    };
    /**
     * ⚠ **`'cancel'` の記録は、いまは無くても同じ結果になる**(確認の `onDismiss` が
     *   `'cancel'` だから)── 2026-08-21 の変異試験で**等価変異**と分かった。
     * 🔑 それでも残すのは、**2 つのボタンを対称にして `onDismiss` から独立させる**
     *   ため。ここを消すと「取り消した」と「押さずに閉じた」が同じ経路になり、
     *   将来 `onDismiss` を変えた瞬間に**取り消しの意味が黙って変わる**。
     * ⚠ だからここを消す変異が生き延びても、test の穴ではない。
     */
    const onCancel = (): void => {
      answer = 'cancel';
      f.dialog.close();
    };
    // ⚠ ボタン・`Escape`・外からの `close()` の**どれで閉じても 1 回だけ**解決する
    const onClose = (): void => done();
    f.ok.addEventListener('click', onOk);
    f.cancel.addEventListener('click', onCancel);
    f.dialog.addEventListener('close', onClose);
    f.dialog.showModal();
    // 🔑 焦点は**取り消す側**へ ── 戻しにくい操作で Enter が事故にならない
    (f.cancel.hidden ? f.ok : f.cancel).focus();
  });
}

/**
 * 🔴 **日付を入れる道具**(user 指示 2026-08-23)。
 *
 * > 「**日付の記法としては入力がめんどくさいから、日付と時刻を簡単に入力できるし、
 * > ついてくるツールとか用意されてもいいかも。アイデアはすごくいいと思うけど足りない**」
 *
 * ## なぜ格子を自作しないのか
 *
 * 中身は **`<input type="date">` / `<input type="time">`** である。⚠ 自作の格子に
 * すると、端末のピッカー・キーボード操作・地域ごとの書式・IME の扱いを**全部
 * 作り直す**ことになる ── CLAUDE.md §10 の裏返しで、**native が「ついでに」
 * 提供している性質**を捨てないほうが強い。
 *
 * ## なぜ近道は「押したら入る」ではなく「日付欄に入る」なのか
 *
 * ⚠ 押した瞬間に閉じる形にすると、**時刻を足したい人が必ず 1 回やり直す**
 * (「明日」を押した → 閉じた → 時刻が無い → もう一度開く)。
 * 🔑 近道は**日付欄を埋めるだけ**にして、確定の口を **「入れる」1 つ**に保つ ──
 *   マウスだけで 2 押し、鍵なら「近道 → Enter」で終わる。
 *
 * ## 返す形
 *
 * `{ date, time }`(時刻は空なら `null`)。⚠ **記法の字は組み立てない** ──
 * 組み立ては `formatLineDate` 1 本(`features/schedule/line-date.ts`)である。
 * ここが字を作ると、読む形と書く形が 2 か所で決まる(CLAUDE.md §7)。
 */
export interface PickedDate {
  /** `YYYY-MM-DD`。 */
  readonly date: string;
  /** `HH:MM`。空欄なら `null`。 */
  readonly time: string | null;
}

export function pickDateInApp(
  host: HTMLElement,
  now: Date,
  /** ⚠ 近道の表は features 側が持つ(画面の並びと規則を 2 か所に書かない)。 */
  shortcuts: readonly { id: string; label: string }[],
  toDate: (id: string, now: Date) => string,
): Promise<PickedDate | null> {
  return enqueue(async () => {
    const f = ensureFrame(host);
    f.title.textContent = '日付を入れる';
    // ⚠ 前の中身は捨てる(確認は `textContent` を上書きするので、逆向きも要る)
    f.body.textContent = '';

    const date = document.createElement('input');
    date.type = 'date';
    date.setAttribute('data-pkc-field', 'pick-date');
    // 🔑 開いた時点で**今日**が入っている ── いちばん多い答えを既に選んである
    date.value = toDate('today', now);
    const time = document.createElement('input');
    time.type = 'time';
    time.setAttribute('data-pkc-field', 'pick-time');

    for (const s of shortcuts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pkc-field', 'pick-shortcut');
      btn.setAttribute('data-pkc-shortcut', s.id);
      btn.textContent = s.label;
      /**
       * ⚠ **閉じない。日付欄を埋めるだけ**(上の docstring)。
       * ⚠ そして**押した手応えを出す** ── 埋まったことが画面で分からないと、
       *   user は「押しても何も起きない」と読む(欄の値は小さくて見落とす)。
       */
      btn.addEventListener('click', () => {
        date.value = toDate(s.id, now);
        for (const other of f.body.querySelectorAll('[data-pkc-field="pick-shortcut"]'))
          other.removeAttribute('data-pkc-selected');
        btn.setAttribute('data-pkc-selected', '');
      });
      f.body.append(btn);
    }
    const dateLabel = document.createElement('label');
    dateLabel.append(document.createTextNode('日付 '), date);
    const timeLabel = document.createElement('label');
    // ⚠ 「任意」と書く ── 空欄で通ることが分からないと、user は何か入れようとする
    timeLabel.append(document.createTextNode('時刻(任意) '), time);
    f.body.append(dateLabel, timeLabel);

    f.ok.textContent = '入れる';
    f.ok.removeAttribute('data-pkc-danger');
    f.cancel.textContent = 'やめる';
    f.cancel.hidden = false;

    /**
     * ⚠ **`open()` の中は同期で `showModal()` まで走る**(`new Promise` の
     *   executor は同期)ので、返った直後に焦点を移せる。
     * 🔑 確認と違って焦点は**日付欄**へ ── ここは戻しにくい操作ではないし、
     *   開いた直後にやることは「日を決める」だからである。
     */
    const answered = open(f, 'cancel');
    date.focus();
    const answer = await answered;
    if (answer !== 'ok') return null;
    // ⚠ 日付が空なら**入れない**(空の記法を本文へ挿すと、読めない字が残る)
    return date.value === '' ? null : { date: date.value, time: time.value === '' ? null : time.value };
  });
}

/**
 * 🔴 **雛形を一覧から選ぶ**(#196 / B-2 段②-b)。
 *
 * ⚠ **押した行がそのまま答え**である ── 「選ぶ → 入れる」の 2 段にしない。
 *   選ぶ以外にこの器ですることが無いので、確定のボタンを置くと**必ず 2 回押させる**
 *   だけになる(`pickDateInApp` が 2 段なのは、日付を選んだ後に**時刻を足せる**からで、
 *   ここには足す物が無い)。だから受ける側のボタンは**隠す**。
 * ⚠ ただし閉じ方は器の 1 本を通す(`f.ok.click()`)── `Escape` / 「やめる」/ 行、
 *   どれで閉じても**焦点を返す後始末が 1 か所**で走る(CLAUDE.md §10 ③)。
 *
 * @param note 一覧の上に出す 1 行(切ったときの断り等)。空なら出さない
 * @returns 選んだ行。`Escape` / 「やめる」なら `null`
 */
export function pickSnippetInApp(
  host: HTMLElement,
  choices: readonly SnippetChoice[],
  note: string,
): Promise<SnippetChoice | null> {
  return enqueue(async () => {
    const f = ensureFrame(host);
    f.title.textContent = '雛形を入れる';
    f.body.textContent = '';
    if (note !== '') {
      const line = document.createElement('p');
      line.setAttribute('data-pkc-field', 'pick-snippet-note');
      line.textContent = note;
      f.body.append(line);
    }

    let chosen: SnippetChoice | null = null;
    const rows: HTMLButtonElement[] = [];
    for (const [index, choice] of choices.entries()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pkc-field', 'pick-snippet');
      btn.setAttribute('data-pkc-snippet-index', String(index));
      /**
       * ⚠ 字は「**題名**(短縮語)」── 短縮語を書いてある雛形は、ここで
       *   **覚え直せる**(次からは `Tab` で呼べる)。組み込みには短縮語が無いので
       *   題名だけ。
       */
      btn.textContent =
        choice.kind === 'snippet' && choice.abbr !== ''
          ? `${choice.title}(${choice.abbr})`
          : choice.title;
      btn.addEventListener('click', () => {
        chosen = choice;
        // ⚠ 隠してあっても `click()` は届く(閉じ口を 1 本に保つための呼び方)
        f.ok.click();
      });
      rows.push(btn);
      f.body.append(btn);
    }

    f.ok.textContent = '入れる';
    f.ok.removeAttribute('data-pkc-danger');
    // 🔑 受ける側は**隠す**(上の docstring)── 消さずに隠す(器を捨てない)
    f.ok.hidden = true;
    f.cancel.textContent = 'やめる';
    f.cancel.hidden = false;

    const answered = open(f, 'cancel');
    // 🔑 焦点は**先頭の行**へ ── 開いた直後にやることは「選ぶ」だからである
    rows[0]?.focus();
    const answer = await answered;
    // ⚠ 隠したままにしない ── 器は使い回すので、次の確認で受ける側が消える
    f.ok.hidden = false;
    return answer === 'ok' ? chosen : null;
  });
}

/** test の後始末(器を捨てる)。⚠ 製品からは呼ばない。 */
export function resetAppDialogForTest(): void {
  /**
   * 🔴 **開いたままの器を、DOM から片付ける**(2026-08-23 に踏んだ)。
   *
   * ⚠ 直す前は参照を捨てるだけだったので、**閉じずに終わった it の `<dialog>` が
   *   `open` のまま document に残っていた** ── 次の it の `openDialog()` は
   *   「開いているものを探す」ので**前の it の残骸に当たり**、押すと
   *   **前の it の Promise が解決される**(いまの it は永久に待つ)。
   * ⚠ 症状は「入れたのに本文が変わらない」で、**単独で走らせると通る** ──
   *   いちばん読み違えやすい形である(CLAUDE.md §5「環境差」の test 内版)。
   * 🔑 器は 1 つに寄せてあるので、**片付けもここ 1 か所**でよい。
   */
  if (frame !== null) {
    if (frame.dialog.open) frame.dialog.close();
    frame.dialog.remove();
  }
  frame = null;
  // ⚠ 列も戻す ── 閉じ損ねた it が 1 つあると、以後の it が全部その後ろで待つ
  chain = Promise.resolve();
  pending = 0;
}
