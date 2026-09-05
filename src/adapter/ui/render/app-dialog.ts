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
import type { PaletteRow } from '@features/palette/palette-rows';
import type { EntryPickRow } from '@features/entry-ref/entry-pick';
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
  return pickRowInApp(host, {
    title: '雛形を入れる',
    field: 'pick-snippet',
    indexAttr: 'data-pkc-snippet-index',
    note,
    /**
     * ⚠ 字は「**題名**(短縮語)」── 短縮語を書いてある雛形は、ここで
     *   **覚え直せる**(次からは `Tab` で呼べる)。組み込みには短縮語が無いので
     *   題名だけ。
     */
    rows: choices.map((choice) => ({
      label:
        choice.kind === 'snippet' && choice.abbr !== ''
          ? `${choice.title}(${choice.abbr})`
          : choice.title,
      value: choice,
    })),
  });
}

/**
 * 🔴 **図の種類を選ぶ**(#528 案 B。user 裁定 2026-09-04)。
 *
 * ⚠ 器は雛形の一覧と**同じ 1 本**(`pickRowInApp`)── 「押した行がそのまま答え」
 *   「`Escape` / やめる / 外を押すと `null`」「焦点を返す」が 2 つの一覧で
 *   食い違わないようにする(CLAUDE.md §7)。
 * ⚠ 何が並ぶかは `features/markdown/text-ops.ts` の `DIAGRAM_CHOICES` が正本 ──
 *   ここは字と id を受け取って並べるだけ。
 *
 * @returns 選んだ雛形の id。`Escape` / 「やめる」/ 外なら `null`
 */
export function pickDiagramInApp(
  host: HTMLElement,
  choices: readonly { readonly id: string; readonly label: string }[],
): Promise<string | null> {
  return pickRowInApp(host, {
    title: '図を入れる',
    field: 'pick-diagram',
    indexAttr: 'data-pkc-diagram-index',
    note: '',
    rows: choices.map((c) => ({ label: c.label, value: c.id })),
  });
}

/** 「一覧から 1 行選ぶ」器の中身。⚠ `field` は行の `data-pkc-field`(test / smoke が見る)。 */
interface PickRowsSpec<T> {
  readonly title: string;
  readonly field: string;
  /** 行の何番目かを書く属性名(`data-pkc-…-index`)。 */
  readonly indexAttr: string;
  /** 一覧の上に出す 1 行。空なら出さない。 */
  readonly note: string;
  readonly rows: readonly { readonly label: string; readonly value: T }[];
}

/**
 * 🔴 **一覧から 1 行選ぶ**(雛形 / 図 の共通の器)。
 *
 * ⚠ **押した行がそのまま答え** ── 確定のボタンは隠す(`pickSnippetInApp` の docstring)。
 * ⚠ 閉じ方は器の 1 本を通す(`f.ok.click()` / `f.cancel.click()`)── どこから閉じても
 *   **焦点を返す後始末が 1 か所**で走る(CLAUDE.md §10 ③)。
 *
 * 🔑 **`↑` `↓` で行を移れる**(#528 案 B)── 一覧は縦に読むものなので、
 *   `Tab` だけだと「やめる」まで回ってから戻ることになる。近道であって主の口ではない
 *   (マウスで押せば同じ)。⚠ `Enter` は書かない ── 焦点の在るボタンは
 *   ブラウザが `click` にしてくれる(2 か所に書かない)。
 * 🔑 **外(暗い地)を押したら「やめる」** ── 選ぶだけの器なので、外を押した人は
 *   「やめたい」のである。⚠ 確認(`confirmInApp`)には付けない ── あちらは
 *   **答えを要る**器で、押し損ねで削除の確認が消えると、頼んだ操作が黙って消える。
 */
function pickRowInApp<T>(host: HTMLElement, spec: PickRowsSpec<T>): Promise<T | null> {
  return enqueue(async () => {
    const f = ensureFrame(host);
    f.title.textContent = spec.title;
    f.body.textContent = '';
    if (spec.note !== '') {
      const line = document.createElement('p');
      line.setAttribute('data-pkc-field', `${spec.field}-note`);
      line.textContent = spec.note;
      f.body.append(line);
    }

    let chosen: T | null = null;
    const rows: HTMLButtonElement[] = [];
    for (const [index, row] of spec.rows.entries()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pkc-field', spec.field);
      btn.setAttribute(spec.indexAttr, String(index));
      btn.textContent = row.label;
      btn.addEventListener('click', () => {
        chosen = row.value;
        // ⚠ 隠してあっても `click()` は届く(閉じ口を 1 本に保つための呼び方)
        f.ok.click();
      });
      rows.push(btn);
      f.body.append(btn);
    }

    // ⚠ 器(`f.dialog`)に付けて、閉じたら外す ── 器は使い回すので、外し忘れると
    //   次の確認でも矢印が行を探しにいく
    const onArrow = (ev: KeyboardEvent): void => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      const at = rows.findIndex((b) => b === f.dialog.ownerDocument.activeElement);
      if (at < 0) return;
      const next = rows[ev.key === 'ArrowDown' ? at + 1 : at - 1];
      if (next === undefined) return;
      ev.preventDefault();
      next.focus();
    };
    const onOutside = (ev: MouseEvent): void => {
      // 🔑 暗い地を押すと `target` は `<dialog>` 自身になる(中身を押せば中身が target)
      if (ev.target === f.dialog) f.cancel.click();
    };
    f.dialog.addEventListener('keydown', onArrow);
    f.dialog.addEventListener('click', onOutside);

    f.ok.textContent = '入れる';
    f.ok.removeAttribute('data-pkc-danger');
    // 🔑 受ける側は**隠す**(`pickSnippetInApp` の docstring)── 消さずに隠す(器を捨てない)
    f.ok.hidden = true;
    f.cancel.textContent = 'やめる';
    f.cancel.hidden = false;

    const answered = open(f, 'cancel');
    // 🔑 焦点は**先頭の行**へ ── 開いた直後にやることは「選ぶ」だからである
    rows[0]?.focus();
    const answer = await answered;
    f.dialog.removeEventListener('keydown', onArrow);
    f.dialog.removeEventListener('click', onOutside);
    // ⚠ 隠したままにしない ── 器は使い回すので、次の確認で受ける側が消える
    f.ok.hidden = false;
    return answer === 'ok' ? chosen : null;
  });
}

/**
 * 🔴 **操作を名前で探して実行する**(#425 段①)。
 *
 * ⚠ **押した行がそのまま答え**(`pickSnippetInApp` と同じ)── 選ぶ以外に
 *   この器ですることが無いので、確定のボタンを置くと必ず 2 回押させるだけになる。
 * ⚠ **押せない行も出す。ただし `disabled` にして理由を並べる** ── 隠すと
 *   「無い」と読まれ、出したまま無反応にすると dead click になる(#425 の規律)。
 * ⚠ 閉じ方は器の 1 本を通す(`f.ok.click()`)── `Escape` / 「やめる」/ 行、
 *   どれで閉じても**焦点を返す後始末が 1 か所**で走る(CLAUDE.md §10 ③)。
 *
 * @param rows 探し語を受けて一覧を返す関数。⚠ **打つたびに呼ぶ**ので、
 *   「いま押せるか」も**そのときの画面**で決まる(開いた瞬間で固めない)
 * @returns 選んだコマンドの id。`Escape` / 「やめる」なら `null`
 */
export function pickCommandInApp(
  host: HTMLElement,
  rows: (query: string) => readonly PaletteRow[],
): Promise<string | null> {
  return enqueue(async () => {
    const f = ensureFrame(host);
    f.title.textContent = '操作を名前で探す';
    f.body.textContent = '';

    const input = document.createElement('input');
    /**
     * 🔴 **`search` にしない**(2026-08-26。実ブラウザの smoke が拾った)。
     *
     * ⚠ Chromium の `type="search"` は、字が入っているとき **`Escape` を食べて
     *   欄を空にする** ── その打鍵は `<dialog>` まで届かないので、
     *   **`Escape` を押しても器が閉じない**。⚠ しかも画面上は「一覧が元に戻る」
     *   だけなので、user には**押しても閉じない**としか見えない。
     * 🔑 一覧の絞り込み(`entry-filter`)は `search` のままでよい ── あちらは
     *   面に居座る欄なので「Esc で消す」が正しい。**ここは 1 回きりの器**で、
     *   `Escape` は「やめる」の意味である(CLAUDE.md §10 ── native の
     *   `<dialog>` が**ついでにやっていた性質**を、欄が黙って奪っていた)。
     */
    input.type = 'text';
    input.setAttribute('data-pkc-field', 'palette-filter');
    input.placeholder = '操作の名前';
    // ⚠ `placeholder` は名前ではない ── 値を入れると読み上げから消える
    input.setAttribute('aria-label', '操作の名前で絞り込む');
    const list = document.createElement('div');
    list.setAttribute('data-pkc-field', 'palette-list');
    f.body.append(input, list);

    let chosen: string | null = null;
    /** いま並んでいる**押せる**行(Enter が拾う先)。 */
    let firstReady: HTMLButtonElement | null = null;

    const draw = (): void => {
      list.textContent = '';
      firstReady = null;
      const found = rows(input.value);
      if (found.length === 0) {
        const none = document.createElement('p');
        none.setAttribute('data-pkc-field', 'palette-empty');
        // ⚠ 空を黙って出さない ── 「打ち間違いか、そもそも無いのか」が分かる字にする
        none.textContent = 'その名前の操作はありません。別の言い方で探してみてください。';
        list.append(none);
        return;
      }
      for (const r of found) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-pkc-field', 'palette-row');
        btn.setAttribute('data-pkc-command', r.id);
        const name = document.createElement('span');
        name.setAttribute('data-pkc-field', 'palette-label');
        name.textContent = r.label;
        btn.append(name);
        if (r.keys.length > 0) {
          const keys = document.createElement('span');
          keys.setAttribute('data-pkc-field', 'palette-keys');
          // 🔑 割当も出す ──「次はこれで呼べる」が伝わる(#425 段①)
          keys.textContent = r.keys.join(' / ');
          btn.append(keys);
        }
        if (r.why !== '') {
          const why = document.createElement('span');
          why.setAttribute('data-pkc-field', 'palette-why');
          why.textContent = r.why;
          btn.append(why);
        }
        if (!r.ready) {
          // ⚠ 押せないことを**器に言わせる** ── 見た目だけ薄くすると押せてしまう
          btn.disabled = true;
        } else if (firstReady === null) {
          /**
           * ⚠ **`else if` を `if` にする変異は生き延びる**(2026-08-26 の M15)──
           *   `paletteRows` が**押せるものを先に並べる**ので、押せる行が 1 つでも
           *   あれば先頭が押せる行であり、無ければ `.click()` が `disabled` で
           *   不発になる。つまり**いまは等価**である。
           * 🔑 それでも `else` を残すのは、**並び替えを外した日に静かに壊れない**
           *   ようにするため ── ここは「先頭」ではなく「**押せる先頭**」を
           *   拾うと決めた場所である(依存を 1 つ減らす)。
           */
          firstReady = btn;
        }
        btn.addEventListener('click', () => {
          chosen = r.id;
          f.ok.click();
        });
        list.append(btn);
      }
    };

    input.addEventListener('input', draw);
    input.addEventListener('keydown', (ev: KeyboardEvent) => {
      /**
       * ⚠ **打っている最中の Enter は「1 番上の押せる行」** ── 一覧へ焦点を
       *   移してから押させると、絞り込んで即実行という本来の速さが消える。
       * ⚠ `isComposing` の間は拾わない ── 変換確定の Enter で実行してしまう。
       */
      if (ev.key !== 'Enter' || ev.isComposing) return;
      if (firstReady === null) return;
      ev.preventDefault();
      firstReady.click();
    });
    draw();

    f.ok.textContent = '実行';
    f.ok.removeAttribute('data-pkc-danger');
    // 🔑 受ける側は**隠す**(押した行がそのまま答え)── 消さずに隠す(器を捨てない)
    f.ok.hidden = true;
    f.cancel.textContent = 'やめる';
    f.cancel.hidden = false;

    const answered = open(f, 'cancel');
    // 🔑 焦点は**探す欄**へ ── 開いた直後にやることは「名前を打つ」だからである
    input.focus();
    const answer = await answered;
    // ⚠ 隠したままにしない ── 器は使い回すので、次の確認で受ける側が消える
    f.ok.hidden = false;
    return answer === 'ok' ? chosen : null;
  });
}

/**
 * 🔴 **貼りたいノートを題名で探して選ぶ**(#427 段②)。
 *
 * ⚠ 形は `pickCommandInApp` と**同じ**にしてある(探す欄 + 一覧、押した行が答え、
 *   `Enter` は先頭)── user に 2 通りの探し方を覚えさせない。
 * ⚠ `type="search"` にしない理由は `pickCommandInApp` の注記と同じ
 *   (Chromium が `Escape` を食べ、器が閉じなくなる)。
 *
 * @param rows 探し語を受けて「一覧」と「下に出す 1 行」を返す関数。
 *   ⚠ **打つたびに呼ぶ**(開いた瞬間で固めない)
 * @param opts.title 器の題名。⚠ 省けば「ノートへのリンクを入れる」── 同じ器を
 *   「移す…」(#215)が入れ先のフォルダを選ぶのに使うので、**何を選んでいるか**を題名で言う
 * @returns 選んだノートの lid。`Escape` / 「やめる」なら `null`
 */
export function pickEntryInApp(
  host: HTMLElement,
  rows: (query: string) => { readonly items: readonly EntryPickRow[]; readonly note: string },
  opts: { readonly title?: string } = {},
): Promise<string | null> {
  return enqueue(async () => {
    const f = ensureFrame(host);
    f.title.textContent = opts.title ?? 'ノートへのリンクを入れる';
    f.body.textContent = '';

    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-pkc-field', 'entry-pick-filter');
    input.placeholder = 'ノートの題名';
    input.setAttribute('aria-label', 'ノートの題名で絞り込む');
    const list = document.createElement('div');
    list.setAttribute('data-pkc-field', 'entry-pick-list');
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'entry-pick-note');
    f.body.append(input, list, note);

    let chosen: string | null = null;
    let firstRow: HTMLButtonElement | null = null;

    const draw = (): void => {
      list.textContent = '';
      firstRow = null;
      const { items, note: line } = rows(input.value);
      // ⚠ 切ったこと・0 件であることを**必ず字で出す**(黙って空にしない)
      note.textContent = line;
      note.hidden = line === '';
      for (const r of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-pkc-field', 'entry-pick-row');
        btn.setAttribute('data-pkc-lid', r.lid);
        const name = document.createElement('span');
        name.setAttribute('data-pkc-field', 'entry-pick-title');
        /**
         * ⚠ **題名が空のノートも出す** ── 出さないと「作ったのに選べない」に
         *   なる。字が無いと押す所が消えるので、代わりの字を置く。
         */
        name.textContent = r.title === '' ? '(題名なし)' : r.title;
        const kind = document.createElement('span');
        kind.setAttribute('data-pkc-field', 'entry-pick-kind');
        // 🔑 種類も出す ── 同じ題名が並んだときに、どちらか見分けられる
        kind.textContent = r.kind;
        btn.append(name, kind);
        btn.addEventListener('click', () => {
          chosen = r.lid;
          f.ok.click();
        });
        if (firstRow === null) firstRow = btn;
        list.append(btn);
      }
    };

    input.addEventListener('input', draw);
    input.addEventListener('keydown', (ev: KeyboardEvent) => {
      // ⚠ `isComposing` の間は拾わない ── 変換確定の Enter で選んでしまう
      if (ev.key !== 'Enter' || ev.isComposing) return;
      if (firstRow === null) return;
      ev.preventDefault();
      firstRow.click();
    });
    draw();

    f.ok.textContent = '入れる';
    f.ok.removeAttribute('data-pkc-danger');
    f.ok.hidden = true;
    f.cancel.textContent = 'やめる';
    f.cancel.hidden = false;

    const answered = open(f, 'cancel');
    // 🔑 焦点は**探す欄**へ ── 開いた直後にやることは「題名を打つ」
    input.focus();
    const answer = await answered;
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
