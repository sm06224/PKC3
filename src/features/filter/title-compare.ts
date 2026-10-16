/**
 * 題名・名前の並べ方の**正本**(#1087)。
 *
 * 🔑 数字は数として読む(「2 件」は「10 件」の前)/ ひらがなとカタカナ・全角と半角・大小は
 * 同じ字として並べる(`sensitivity: 'base'`)/ 日本語の読みの順(`ja`)。
 * ⚠ 一覧・2 ペイン・フォルダの面・予定表のノート一覧が**別の答え**を返さないよう、
 *   題名の比較はここ 1 か所を通す(§7)。
 * ⚠ `Intl.Collator` は作るのが重いので、モジュールで 1 度だけ作る。
 * ⚠ 0 は「並びでは同じ」── 同点を割るのは呼び側(lid など)。
 */
const TITLE_COLLATOR = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

export function compareTitles(a: string, b: string): number {
  return TITLE_COLLATOR.compare(a, b);
}
