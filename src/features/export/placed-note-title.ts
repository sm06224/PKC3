/**
 * 🔴 **板に置いたノートの題名を、書き出した先に残す**(#1163 依頼 278 = A)。
 *
 * 板に別のノートを置いた付箋(`:::format{.pkc-place entry=…}`)の題名と中身は、画面では描画のあとで差し込まれる。
 * 書き出しはその前の HTML を読むので、直す前は
 * - Word … 跡形もなく消え、「入れられませんでした」の知らせも出なかった
 * - 閲覧用 HTML … 中身も題名も無い空の枠になった
 * (どちらも、どのノートを置いたのかが分からない)。
 * 🔑 中身は入れない(置いたノートの本文は別のノートのもの)。題名だけを枠の中に 1 行入れる。
 *   Word には「中身は入れていません」と言い添える ── 空の枠と取り違えないため。
 * ⚠ 題名は HTML に差し込むので、必ず escape する(題名は利用者の字)。
 */

/** 置いたノートの付箋の開きタグ(描画が焼く形。`data-pkc-entry` を持つ `pkc-place` の塊)。 */
const PLACED_OPEN = /<div class="[^"]*\bpkc-place\b[^"]*"[^>]*?\sdata-pkc-entry="([^"]*)"[^>]*>/g;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unesc(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Word の 1 行(置いたノートの題名と、中身を入れていないこと)。 */
export function placedNoteLineForWord(title: string): string {
  return `［置いたノート「${title}」の中身は入れていません］`;
}

/**
 * 置いたノートの付箋の中に、題名の行を差し込む。
 * @param titleOf lid から題名を引く(無い = 差し込まない)
 * @param form `word` = 説明つきの 1 行 / `html` = 題名だけ(太字)
 */
export function insertPlacedNoteTitles(
  html: string,
  titleOf: (lid: string) => string | null,
  form: 'word' | 'html',
): string {
  if (!html.includes('pkc-place')) return html;
  return html.replace(PLACED_OPEN, (open: string, rawLid: string) => {
    const title = titleOf(unesc(rawLid));
    if (title === null) return open;
    const line =
      form === 'word'
        ? `<p>${esc(placedNoteLineForWord(title))}</p>`
        : `<p class="pkc-place-title"><strong>${esc(title)}</strong></p>`;
    return open + line;
  });
}
