/**
 * 再生・表示できなかった添付に、理由の 1 行を出す(#1087 A1)。
 *
 * ⚠ ブラウザが読めない形式(.heic / .mkv など)は、壊れた画像や空の再生バーとして出て、
 *   理由がどこにも書かれなかった(マニュアルは「黙らない」と約束している)。
 *   `error` の合図が来たら、その要素を理由の 1 行に差し替える。
 * ⚠ 字は `attachment-pdf-fallback` と同じ言い方(「…出せません。…で保存して開いてください」)。
 */

export type MediaErrorKind = 'image' | 'audio' | 'video';

/** 保存の導線の既定の言い方(添付の面では、上に「添付をダウンロード」が在る)。 */
const SAVE_HINT_ATTACHMENT = '上の「添付をダウンロード」で保存して開いてください';
/** 一覧の行には保存のボタンが無い ── ノートを開いた先に在る。 */
export const SAVE_HINT_OPEN_NOTE = 'ノートを開き、「添付をダウンロード」で保存して開いてください';

/** 「形式: ○○」。種類(mime)が空なら、言える形式が無いので括弧ごと省く。 */
function formatLabel(mime: string): string {
  const m = mime.trim();
  return m === '' ? '' : `(形式: ${m})`;
}

/** 理由の 1 行。 */
export function undecodableText(
  kind: MediaErrorKind,
  mime: string,
  howToSave: string = SAVE_HINT_ATTACHMENT,
): string {
  const verb = kind === 'image' ? '表示' : '再生';
  return `このブラウザでは${verb}できません${formatLabel(mime)}。${howToSave}`;
}

/**
 * `el` が読めなかったら、同じ場所を理由の 1 行に差し替える。
 * 🔑 差し替えた `<p>` は `data-pkc-field="attachment-undecodable"`。
 */
export function replaceOnMediaError(
  el: HTMLElement,
  kind: MediaErrorKind,
  mime: string,
  howToSave?: string,
): void {
  el.addEventListener(
    'error',
    () => {
      if (!el.isConnected) return;
      const p = document.createElement('p');
      p.setAttribute('data-pkc-field', 'attachment-undecodable');
      p.textContent = undecodableText(kind, mime, howToSave);
      el.replaceWith(p);
    },
    { once: true },
  );
}
