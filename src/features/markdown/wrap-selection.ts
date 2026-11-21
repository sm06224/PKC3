/**
 * 🔴 **字を選んで括弧・引用符・記号を打つと、置き換えずに囲む**(#2001 段 3、ギャップ #11)。
 *
 * ## 決めたこと
 * - 対象: `(` `[` `{` `"` `'` `「` `『` `（` `【` `` ` `` と、`*` `_`(強調)。
 *   開きと閉じが同じ字(`"` `'` `` ` `` `*` `_`)は同じ字で挟む。
 * - **`*` / `_` も囲む**(選んだ字を消して `*` 1 字にするのは「選んだ字を失う」事故でしかない)。
 *   `*` を続けて 2 回打つと選択が中身に残るので `**太字**` になる。箇条書きの行頭 `* ` は
 *   「選んでいないとき」の打鍵なので影響しない(この関数は**選択があるときだけ**答える)。
 * - 選択は**中身**に残す(続けて打てる)。
 * - 🔴 **字が字のまま読まれる場所では囲まない**(全記号で同じ。`*` `_` `'` `"` `` ` `` はそこでは字面であり、
 *   囲むと本文を壊す): fenced code / 行内コード / 数式 / frontmatter / 表の行(括弧の自動補完を止める場所 =
 *   `pairSuppressed` と同じ判定にコードと frontmatter を足した 1 本)。そこでは今までどおり**置き換える**。
 *   選択の頭と終わりのどちらかがその場所にあれば囲まない。
 * - ⚠ 変換中に呼ばないのは**呼び側の責任**(`ke.isComposing` を 1 か所で見る)。
 *
 * 🔑 pure。`autoPairFor` の選択ありの枝もこの関数を通る(規則 1 本)。
 */
import { codeContextAt } from './code-context';
import { frontmatterLineCount } from './frontmatter';
import { pairSuppressed, type AutoPair, type TextSelection } from './text-ops';

/** 開き → 閉じ。 */
export const WRAP_PAIRS: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
  '「': '」',
  '『': '』',
  '（': '）',
  '【': '】',
  '*': '*',
  _: '_',
};

/** `pos` が frontmatter の中か。 */
function inFrontmatter(text: string, pos: number): boolean {
  const n = frontmatterLineCount(text);
  if (n === 0) return false;
  let end = 0;
  for (let i = 0; i < n; i++) {
    const nl = text.indexOf('\n', end);
    end = nl === -1 ? text.length : nl + 1;
  }
  return pos < end;
}

/** 囲まない場所か(上の「字が字のまま読まれる場所」)。 */
export function wrapSuppressed(text: string, start: number, end: number): boolean {
  for (const pos of [start, end]) {
    if (pairSuppressed(text, pos) || codeContextAt(text, pos) !== null || inFrontmatter(text, pos)) return true;
  }
  return false;
}

/** 選択があり `key` が囲む字なら、囲んだ結果。それ以外は `null`。 */
export function wrapSelection(sel: TextSelection, key: string): AutoPair | null {
  const close = WRAP_PAIRS[key];
  if (close === undefined || sel.start === sel.end) return null;
  if (wrapSuppressed(sel.text, sel.start, sel.end)) return null;
  const inner = sel.text.slice(sel.start, sel.end);
  return {
    kind: 'insert',
    insert: key + inner + close,
    start: sel.start + key.length,
    end: sel.start + key.length + inner.length,
  };
}
