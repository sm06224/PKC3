/**
 * 🔴 **板(`.pkc-place`)の形**(#530 案 A。user 裁定 2026-09-14)。
 *
 * > 置けるのが**四角だけ**なので、「ここは判断」「ここは始まり」といった
 * > 書き分けが図の中でできない。
 *
 * ## なぜ表をここ 1 つに置くか
 *
 * 形の綴りは **4 か所**が読む ── 記法を書く側(`place-notation.ts`)/
 * 画面(`app.css` の `[data-pkc-shape=…]`)/ 書き出しの読み取り(`html-blocks.ts`)/
 * PowerPoint の図形名(`pptx.ts` の `prstGeom`)。⚠ 綴りを 4 か所に散らすと、
 * **足した人が 1 か所だけ書き忘れる**(CLAUDE.md §7)。
 *
 * 🔑 だから**許す綴りはここだけ**が持ち、
 * - PowerPoint 側は `Record<PlaceShape, …>` で受ける(**足したのに書き忘れると tsc が落とす**)
 * - 画面側は CSS なので型が効かない → `tests/features/place-shape.test.ts` が
 *   **`app.css` に規則が在ること**を全数で見る
 *
 * ## ⚠ 許す綴りを閉じる理由(素通しにしない)
 *
 * 形の字は**本文に user が手で書ける**。素通しにすると
 * ① PowerPoint の XML へ知らない図形名が漏れて**壊れた `.pptx`** になる
 * ② 引用符や空白を含む字が開き行へ入って**札の並びが壊れる**。
 * 🔑 知らない字は**四角として描く**(捨てるのではなく、いちばん害の無い形へ倒す)。
 */

/**
 * 板に付けられる形。⚠ **`rect` は既定**(札が無いときと同じ見え方)。
 * 🔑 `rect` も綴りとして持つ ── 「四角にもどす」が**札を消す**のではなく
 *   **`shape=rect` を書く**形になるので、札を消す経路を新しく作らずに済む
 *   (経路が 1 本減ると、そこで起きる失敗も 1 つ減る)。
 */
export const PLACE_SHAPES = ['rect', 'round', 'ellipse', 'diamond', 'arrow'] as const;

export type PlaceShape = (typeof PLACE_SHAPES)[number];

/** その字は板の形として許されるか。⚠ 知らない字は `false`(= 四角で描く)。 */
export function isPlaceShape(value: unknown): value is PlaceShape {
  return typeof value === 'string' && (PLACE_SHAPES as readonly string[]).includes(value);
}

/**
 * 開き行の札から形を読む。⚠ **無い / 知らない字は `'rect'`**。
 * 🔑 読む側の既定をここ 1 か所に置く(画面・書き出しが別々に既定を決めない)。
 */
export function placeShapeOf(value: unknown): PlaceShape {
  return isPlaceShape(value) ? value : 'rect';
}

/**
 * 画面に出す呼び名。⚠ **見たままの言葉**にする(内部の綴りを見せない)。
 * 🔑 頭に形の印を付ける ── 右クリックの一覧は字だけなので、印が無いと
 *   「ひし形」と「矢印」が読み比べになる。
 */
export const PLACE_SHAPE_LABELS: Record<PlaceShape, string> = {
  rect: '■ 四角',
  round: '▢ 角丸',
  ellipse: '● 丸',
  diamond: '◆ ひし形',
  arrow: '➜ 矢印',
};
