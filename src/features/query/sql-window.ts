/**
 * 🔴 **答えの表を「見えている分だけ」描くための計算**(#918 段③。
 *   user 要望 2026-09-14「取得件数上限もいらない」)。
 *
 * ## なぜ要るか(2026-09-14 の実測)
 *
 * 実ブラウザで、`sql.ts` と同じ形の表を素の DOM に置いて測った:
 *
 * | 行数 | 最初の描画まで | 引っかかり(long task) | 常駐(プロセス木 Pss) |
 * |---|---|---|---|
 * | 500 | 122〜125ms | **0 本** | 205〜211 MB |
 * | **2000** | 453〜528ms | **0 本** | 262〜276 MB |
 * | 10000 | **2079〜2310ms** | **14〜19 本**(783〜1246ms) | 532〜623 MB |
 * | 50000 | 12.7〜19.7 **秒** | 21 本(5.3 秒) | **1.9〜2.3 GB** |
 * | 100000 | **27〜41 秒** | 21 本(10.6〜12.6 秒) | **4.1〜4.9 GB** |
 *
 * 🔴 **`content-visibility: auto` は 1 つも買えなかった**(同じ実測)── 10000 行で
 *   最初の描画は**同じか遅く**(2475〜5226ms)、引っかかりは同数、常駐はむしろ増えた。
 *   表の行(`display: table-row`)には効きにくいという既知の性質と一致する。
 *   ⚠ 50000 帯で 1 回**固まった**(60 秒超)ので、「効いている」とは書けない。
 *
 * ## 🔴 境目を置くのは「置き換えの作法」(CLAUDE.md §10)のためである
 *
 * ⚠ 窓で描くと、素の表が**ついでに提供していた性質**が落ちる:
 *
 * | 素の表がついでにやっていたこと | 窓にすると |
 * |---|---|
 * | `Ctrl+F` でブラウザが**全部**を探す | 🔴 見えている行しか当たらない |
 * | 全部を選んでコピー | 🔴 見えている行しか取れない |
 * | 列の幅が**中身から**決まる | 🔴 転がすたびに幅が動く(→ 呼び側が固定する) |
 *
 * 🔑 だから**代償を払うのは、本当に必要な行数のときだけ**にする ──
 *   `SQL_WINDOW_MIN` 以下は**いまと 1 ドットも同じ**(窓に入らない)。
 * 🔑 落ちる 2 つには**代わりが在る** ── 「ノートへ」と「ファイルへ」は
 *   どちらも**全行**を出す(#918 段①/段④)。
 *
 * ## ⚠ ここは計算だけを持つ(features 層)
 *
 * 高さの実測(`offsetHeight` / `scrollTop`)は描画器が採る ── happy-dom は
 * **0 を返す**ので、判断をあちらへ書くと **unit から永久に見えない**
 * (CLAUDE.md §2「本命の分岐を、unit は 1 度も通らないことがある」)。
 */

/**
 * 🔴 **これ以下は窓に入れない**(= いまと同じ、全部描く)。
 *
 * 🔑 **測った中で「引っかかり 0 本」だった最大の行数**である。
 * ⚠ **3000〜9000 は測っていない** ── 本当の折れ目はその間のどこかで、
 *   2000 は「**測った範囲で安全と言える線**」でしかない。上げるなら測り直す。
 */
export const SQL_WINDOW_MIN = 2000;

/**
 * 見えている外側にも描いておく行数(上下それぞれ)。
 * ⚠ 0 にすると、転がした瞬間に**白い帯**が見える(描き直しが追いつかない)。
 */
export const SQL_WINDOW_OVERSCAN = 20;

/** 描く範囲と、その上下に空けておく高さ。 */
export interface SqlWindow {
  /** 描き始める行(0 起点・この行を含む)。 */
  readonly from: number;
  /** 描き終わる行(この行は**含まない**)。 */
  readonly to: number;
  /** `from` より上に空ける高さ(px)。 */
  readonly above: number;
  /** `to` より下に空ける高さ(px)。 */
  readonly below: number;
}

/** 全部描く(窓に入らない / 測れない)ときの答え。 */
function whole(total: number): SqlWindow {
  return { from: 0, to: total, above: 0, below: 0 };
}

/**
 * 🔴 **いまどの行を描けばよいか**。
 *
 * @param total 答えの行数
 * @param rowH 1 行の高さ(px)。⚠ **升は折り返さない**(`white-space: pre`)ので
 *   全行が同じ高さである ── これが崩れると窓は成立しない
 * @param scrollTop 器をどこまで転がしたか(px)
 * @param viewH 器の見えている高さ(px)
 *
 * ⚠ **測れない回は全部描く**(`rowH <= 0` / `viewH <= 0`)── happy-dom も、
 *   まだ画面に出ていない面も 0 を返す。ここで窓にすると**1 行も描けない**。
 * ⚠ **少ない回も全部描く**(`total <= SQL_WINDOW_MIN`)── 上の表のとおり、
 *   そこは素の DOM で引っかかりが出ない。
 */
export function sqlWindowOf(
  total: number,
  rowH: number,
  scrollTop: number,
  viewH: number,
): SqlWindow {
  if (total <= SQL_WINDOW_MIN) return whole(total);
  if (rowH <= 0 || viewH <= 0) return whole(total);
  const top = Math.max(0, scrollTop);
  const first = Math.floor(top / rowH);
  const visible = Math.ceil(viewH / rowH);
  const from = Math.max(0, first - SQL_WINDOW_OVERSCAN);
  // ⚠ `+ 1` は**半端に見えている行**(器の下端に頭だけ出ている行)
  const to = Math.min(total, first + visible + 1 + SQL_WINDOW_OVERSCAN);
  return { from, to, above: from * rowH, below: (total - to) * rowH };
}
