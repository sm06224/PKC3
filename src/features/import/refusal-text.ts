/**
 * 🔴 **取り込めない種類のファイルを選んだときの断り**(#1087)。
 *
 * - ⚠ **1 か所に置く** ── かつては同じ字が受理器 5 つに複製され、「.pptx は取り込み対象ではありません」と
 *   言っていた(pptx は「取り込む」から取り込める)。直すたびに 5 か所を揃える形にしない(§7)。
 * - ⚠ **「失敗」と言わない** ── 対象外のファイルは壊れていない。取り込みの外側の `catch` は
 *   `isImportRefusal` で見分けて、「取り込みに失敗しました: 」を前に付けない。
 * - ⚠ **内部の部品名を出さない**(`#pkc-meta` / `manifest.json` / format 名)── user には読めない。
 */
export const OFFICE_DOC_REFUSAL =
  'これは Word や Excel などの Office 文書なので、取り込めません。ノートに入れたいときは、添付で入れてください(PowerPoint は、名前が .pptx のファイルなら「取り込む」から取り込めます)';

export const NOT_PKC2_HTML_REFUSAL =
  'PKC2 の書き出しではない HTML なので、取り込めません。PKC2 の書き出し(HTML)を選んでください。ウェブページなどは、添付で入れてください';

export const NOT_PKC_ZIP_REFUSAL =
  'PKC の書き出しではない zip なので、取り込めません。PKC2 の書き出し(zip)か、PKC3 のバックアップ(.pkc3-full.zip など)を選んでください';

const REFUSALS: ReadonlySet<string> = new Set([OFFICE_DOC_REFUSAL, NOT_PKC2_HTML_REFUSAL, NOT_PKC_ZIP_REFUSAL]);

/** 例外の字が「対象外の断り」か(= 「失敗しました」を前に付けない)。 */
export function isImportRefusal(message: string): boolean {
  return REFUSALS.has(message);
}
