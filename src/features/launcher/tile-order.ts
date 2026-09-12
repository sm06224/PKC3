/**
 * 🔴 **アプリのタイルを、user が自分の手で並べ替える**(#857 段①)。
 *
 * > user 指示 2026-09-12(解釈):アプリの一覧を自分で整えたい ── タイルを
 * > 並べ替えたい。⚠ 裁定は **A「またげる」**(別のグループの下へ落とすと、
 * > そのグループへ移る)。
 *
 * ## 🔴 これは「新機能」ではなく到達不能の解消である
 *
 * ⚠ 並び順の正本は**添付ノートの frontmatter**(`attachment.app_order`)で、
 *   `tiles.ts` は取込のときから**それを読んでいる**。ところが
 *   **PKC3 の中から書く口が 1 つも無かった**(実測: 製品側で `app_order` に
 *   代入する行は **0 件**)── PKC2 から移ってきた人は並びを直せず、
 *   PKC3 だけの人は最初から並べられない。
 *
 * ## なぜ「その群を全部振り直す」のか
 *
 * ⚠ `app_order` **未設定は末尾**(`sortTiles`)なので、動かした 1 件にだけ
 *   数字を付けると**付けていない物が全部下へ飛ぶ**。
 * 🔑 だから**行き先の群を 0..n-1 で振り直し、値が変わる行だけ書く**。
 *   ⚠ 2 度目以降の並べ替えは既に連番なので、書くのは動いた区間だけになる。
 *
 * ## ⚠ 落とし戻したときに 1 件も書かない
 *
 * 掴んで**元の位置へ落とす**のは「何も変えない」であって、
 * 「全部に連番を振る」ではない ── 振ってしまうと、触っていないノートの
 * frontmatter が増え、履歴も動く。だから**並びが変わらない回は空を返す**。
 *
 * 🔑 **pure module**。browser API も state も持たない ── 書くのは adapter。
 */
import { BUILTIN_KINDS, sortTiles, type LauncherTile } from './tiles';

/** 1 件ぶんの書込。⚠ `group` は**変わるときだけ**入る(触らない key を書かない)。 */
export interface TileOrderWrite {
  readonly lid: string;
  readonly order: number;
  readonly group?: string;
}

/**
 * 行き先の指定。
 *
 * | | 何から来るか |
 * |---|---|
 * | `edge` | **掴んで落とした** ── `before` の手前(`null` ならその群の末尾) |
 * | `step` | **右クリックの「上へ / 下へ」** ── 掴めない端末・掴めない人の道 |
 */
export type TileMoveTarget =
  /**
   * 🔴 **掴んで落とした** ── `anchor` のタイルの手前 / 後ろ。
   *
   * ⚠ 1 稿目は `before`(どのタイルの手前か)だけを受けており、呼び側が
   *   「この下へ」を **DOM の次の兄弟**へ読み替えていた。🔴 それは
   *   **判定が 2 か所に分かれている**ということで(§7)、画面の順と
   *   `sortTiles` の順がずれた日(絞り込み・将来の見出しの入れ子)に
   *   **線を引いた所と違う場所へ着く**。
   * 🔑 だから**見たものをそのまま渡す** ── 読み替えるのはここ 1 か所にする。
   * ⚠ 末尾は「**いちばん下のタイルの `after`**」で表せるので、`null` は要らない。
   */
  | {
      readonly kind: 'edge';
      readonly group: string;
      readonly anchor: string;
      readonly edge: 'before' | 'after';
    }
  | { readonly kind: 'step'; readonly by: -1 | 1 };

/** 並べ替えの対象になるのは **entry を持つタイル**だけ(組み込みは末尾に固定)。 */
export function isMovableTile(tile: LauncherTile): boolean {
  return !BUILTIN_KINDS.has(tile.kind);
}

/**
 * 並べ替えの計画を立てる。**書く必要のある行だけ**返す(変わらないなら空)。
 *
 * ⚠ `tiles` は `state.launcherTiles`(組み込み込み)をそのまま渡してよい ──
 *   ここで組み込みを外す。
 */
export function planTileMove(
  tiles: readonly LauncherTile[],
  lid: string,
  target: TileMoveTarget,
): TileOrderWrite[] {
  const movable = tiles.filter(isMovableTile);
  const moved = movable.find((t) => t.lid === lid);
  if (moved === undefined) return [];

  const toGroup = target.kind === 'edge' ? target.group : moved.group;
  /**
   * ⚠ **`sortTiles` を通した順**で読む ── 呼び側が並べ替え済みの配列を渡す前提に
   *   しない(前提は崩れるが、通し直しは 1 行で済む)。
   */
  const ordered = sortTiles(movable);
  const source = ordered.filter((t) => t.group === toGroup);
  /** 動かす物を抜いた行き先の群。 */
  const rest = source.filter((t) => t.lid !== lid);

  let at: number;
  if (target.kind === 'step') {
    const i = source.findIndex((t) => t.lid === lid);
    const to = i + target.by;
    /**
     * ⚠ 一番上で「上へ」は**何もしない**(輪にしない ── 末尾へ飛ぶと驚く)。
     *
     * 🔑 **下の端に門は要らない**(2026-09-12、着地前レビュー ⚠8 の実測)──
     *   `to === source.length` になると `at` が末尾を指し、`next` が `source` と
     *   同じ並びになるので、下の「**変わらないなら 1 件も書かない**」が空を返す。
     *   ⚠ `i < 0` も起きない(`source` は `moved` の群で絞ってあり、`moved` は
     *   そこに必ず居る)。**外しても振る舞いが 1 つも変わらない門は持たない**
     *   ── 持つと「これが守っている」と誤読される(CLAUDE.md §1)。
     */
    if (to < 0) return [];
    at = to;
  } else {
    const i = rest.findIndex((t) => t.lid === target.anchor);
    /**
     * ⚠ 見つからないときは**何もしない**(末尾へ落とさない ── 狙いと違う所へ動く)。
     * 当たるのは 2 つ:掴んだ物**そのもの**の上へ落とした(= 動いていない)か、
     * 知らない lid。どちらも「動かさない」が正しい。
     */
    if (i < 0) return [];
    at = target.edge === 'before' ? i : i + 1;
  }

  const next = [...rest.slice(0, at), moved, ...rest.slice(at)];

  /**
   * 🔴 **並びが 1 つも変わらない回は、1 件も書かない**(上の注記)。
   * ⚠ 群が変わる回は、並びが同じでも書く(`app_group` を書かないと移らない)。
   */
  const groupChanged = moved.group !== toGroup;
  if (!groupChanged && next.every((t, i) => t.lid === source[i]?.lid)) return [];

  const writes: TileOrderWrite[] = [];
  for (const [i, t] of next.entries()) {
    const needGroup = t.lid === lid && groupChanged;
    if (t.order === i && !needGroup) continue;
    writes.push(needGroup ? { lid: t.lid, order: i, group: toGroup } : { lid: t.lid, order: i });
  }
  return writes;
}

/**
 * 🔴 **計画を画面へ先に当てる**(楽観)。
 *
 * ⚠ disk へ書いて読み直すまで待つと、掴んだ手を離してから**数百 ms 動かない** ──
 *   「掴めたのに動かない」は「掴めない」より悪い。
 * 🔑 並べ方は `sortTiles` **1 本**を通す(規則を 2 本にしない。§7)。
 * ⚠ **組み込みは `sortTiles` に混ぜない** ── 群の名前が第 1 の鍵なので、
 *   混ぜると組み込みが user のタイルの間へ割り込む(`withBuiltinTiles` が
 *   末尾へ固定しているのを崩す)。
 */
export function applyTileWrites(
  tiles: readonly LauncherTile[],
  writes: readonly TileOrderWrite[],
): LauncherTile[] {
  if (writes.length === 0) return [...tiles];
  const by = new Map(writes.map((w) => [w.lid, w]));
  const patched = tiles.filter(isMovableTile).map((t) => {
    const w = by.get(t.lid);
    if (w === undefined) return t;
    return { ...t, order: w.order, group: w.group ?? t.group };
  });
  return [...sortTiles(patched), ...tiles.filter((t) => !isMovableTile(t))];
}
