/**
 * 🔴 **設定を探す欄の当たり判定**(#1966 3-1)。⚠ **pure**。
 *
 * 字の均し方は「操作を探す」と同じ `fold`(NFKC・大文字小文字・ひらがなカタカナを潰す)── 探す欄が 2 つあって
 * 片方だけ「ﾌｫﾝﾄ」で当たる、を作らない。⚠ 空白(全角も)で区切った語は**全部**含む物だけ当たる(操作を探すと同じ)。
 */
import { fold } from '@features/palette/palette-rows';

/** 打った字を、当てる語の列にする。空(空白だけ)なら空の列(= 絞らない)。 */
export function settingsQueryWords(query: string): string[] {
  return fold(query)
    .split(/\s+/)
    .filter((w) => w !== '');
}

/** その字が、語を全部含むか。⚠ 語が空なら常に当たる。 */
export function matchesSettingsQuery(text: string, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const t = fold(text);
  return words.every((w) => t.includes(w));
}
