/**
 * 🔴 **字を選んで括弧・引用符・記号を打つと、置き換えずに囲む**(#2001 段 3、ギャップ #11)。
 *
 * ## 決めたこと
 * - 対象: `(` `[` `{` `"` `'` `「` `『` `（` `【` `` ` `` と、`*` `_`(強調)。
 *   開きと閉じが同じ字(`"` `'` `` ` `` `*` `_`)は同じ字で挟む。
 * - **`*` / `_` も囲む**(選んだ字を消して `*` 1 字にするのは「選んだ字を失う」事故でしかない)。
 *   `*` を続けて 2 回打つと選択が中身に残るので `**太字**` になる。箇条書きの行頭 `* ` は
 *   「選んでいないとき」の打鍵なので影響しない(この関数は**選択があるときだけ**答える)。
 * - 選択は**中身**に残す(続けて打てる)。表・数式の中でも囲む ── 選んで打つのは明示の操作だから
 *   (`autoPairFor` の「補わない場所」は選択なしの自動補完の話)。
 * - ⚠ 変換中に呼ばないのは**呼び側の責任**(`ke.isComposing` を 1 か所で見る)。
 *
 * 🔑 pure。`autoPairFor` の選択ありの枝もこの関数を通る(規則 1 本)。
 */
import type { AutoPair, TextSelection } from './text-ops';

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

/** 選択があり `key` が囲む字なら、囲んだ結果。それ以外は `null`。 */
export function wrapSelection(sel: TextSelection, key: string): AutoPair | null {
  const close = WRAP_PAIRS[key];
  if (close === undefined || sel.start === sel.end) return null;
  const inner = sel.text.slice(sel.start, sel.end);
  return {
    kind: 'insert',
    insert: key + inner + close,
    start: sel.start + key.length,
    end: sel.start + key.length + inner.length,
  };
}
