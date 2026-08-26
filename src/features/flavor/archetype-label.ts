/**
 * 🔴 **種別の名前と、名前を持つ種別の一覧**(#421 段② で features 層へ移した)。
 *
 * ## なぜ features 層に在るか
 *
 * ⚠ 元は `adapter/ui/render/sidebar.ts` に在ったが、**スマートフォルダの条件**
 * (「種類が〇〇」)が**同じ一覧**を要る ── 条件は pure module
 * (`features/smart/smart-spec.ts`)が読むので、adapter を import できない
 * (層の規約:core ← features ← adapter)。
 *
 * 🔑 **一覧を 2 つ作らない**(§7)── 作ると「フラグ画面に出る種類」と
 *   「条件にできる種類」が静かに食い違い、**選べるのに 1 件も集まらない**
 *   入れ物ができる(しかも理由が画面のどこにも出ない)。
 * ⚠ `sidebar.ts` は**ここから再輸出する**だけ(呼び側の import は変えない)。
 *
 * ⚠ **pure module**。browser API を持たない ── storage worker からも読める。
 */

/**
 * 名前を持つ種別。⚠ **並びは user に見せる順**(条件を選ぶ一覧がこの順で出る)。
 * ⚠ ここに無い綴り(`generic` / `opaque` / 取り込みが作った独自の語)は
 *   **名前が無いだけ**で、ノートとしては普通に開ける。
 */
export const ARCHETYPE_LABELS: readonly (readonly [string, string])[] = [
  ['text', 'ノート'],
  ['textlog', 'ログ'],
  ['spreadsheet', '表'],
  ['folder', 'フォルダ'],
  ['smart', 'スマートフォルダ'],
  ['attachment', '添付'],
  ['snippet', '雛形'],
  ['todo', 'Todo'],
  ['form', 'フォーム'],
];

const BY_NAME: ReadonlyMap<string, string> = new Map(ARCHETYPE_LABELS);

/**
 * 種別の**名前**(user に見せる語)。⚠ 内部語(archetype / entry)は出さない。
 * ⚠ 知らない綴りは**そのまま返す**(空にしない ── 行の頭が揃わなくなる)。
 */
export function archetypeLabel(archetype: string): string {
  return BY_NAME.get(archetype) ?? archetype;
}

/**
 * その綴りが**名前を持つ種別**か。
 * 🔑 スマートフォルダの条件はこれで検める ── 検めないと、綴りを間違えた入れ物が
 *   **1 件も集めないまま「条件は在る」顔で並ぶ**(silent fail)。
 */
export const isKnownArchetype = (archetype: string): boolean => BY_NAME.has(archetype);
