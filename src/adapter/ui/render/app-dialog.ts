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
 *    `ask-confirm.ts` が**時間で見抜いて理由を出す**だけの緩和である
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
 * ⚠ **多重に開かない** ── 既に開いているときは、その答えを待たずに
 *   `'cancel'` を返す(2 枚重ねると、下の 1 枚が答えを失って永久に待つ)。
 */
export function confirmInApp(
  host: HTMLElement,
  message: string,
  opts: ConfirmOptions = {},
): Promise<DialogAnswer> {
  const f = ensureFrame(host);
  if (f.dialog.open) return Promise.resolve<DialogAnswer>('cancel');
  f.title.textContent = '確認';
  f.body.textContent = message;
  f.ok.textContent = opts.okLabel ?? 'はい';
  f.cancel.textContent = opts.cancelLabel ?? 'やめる';
  if (opts.danger === true) f.ok.setAttribute('data-pkc-danger', '');
  else f.ok.removeAttribute('data-pkc-danger');
  f.cancel.hidden = false;
  return open(f, 'cancel');
}

/**
 * 知らせるだけ(`window.alert` の置き換え)。
 * ⚠ ボタンは 1 つ ── 取り消す先が無いのに「やめる」を出さない。
 */
export function alertInApp(host: HTMLElement, message: string): Promise<DialogAnswer> {
  const f = ensureFrame(host);
  if (f.dialog.open) return Promise.resolve<DialogAnswer>('ok');
  f.title.textContent = 'お知らせ';
  f.body.textContent = message;
  f.ok.textContent = '閉じる';
  f.ok.removeAttribute('data-pkc-danger');
  // ⚠ **消さずに隠す**(器を捨てない)── 消すと次の確認で作り直しになる
  f.cancel.hidden = true;
  return open(f, 'ok');
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
    const done = (): void => {
      f.ok.removeEventListener('click', onOk);
      f.cancel.removeEventListener('click', onCancel);
      f.dialog.removeEventListener('close', onClose);
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

/** test の後始末(器を捨てる)。⚠ 製品からは呼ばない。 */
export function resetAppDialogForTest(): void {
  frame = null;
}
