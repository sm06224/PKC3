/**
 * 🔴 **板どうしを繋ぐ線の計算**(#530 段③a。user 裁定 2026-09-14
 *   「線の形は選べるように / 曲線も / 束ねるためのアンカーも」)。
 *
 * ## 🔑 線は「置いた物」ではない
 *
 * ⚠ 線は**座標を持たない** ── `from=` / `to=` で 2 枚の板を指すだけで、
 *   引く場所は**毎回その 2 枚の位置から計算する**。
 * 🔑 だから**板を動かせば線も付いてくる**。座標を書く形にすると、
 *   板を動かした日に線だけ置き去りになる(そして本文には気づく手がかりが無い)。
 *
 * ## ⚠ 段③a が持たないもの(設計 doc の段の切り方どおり)
 *
 * | | いま | いつ |
 * |---|---|---|
 * | 接続点を**手で**指す(`from=a:right`) | 🔑 **綴りは受けるが、まだ効かない**(自動で選ぶ) | 段③b |
 * | 同じ接続点へ来た線を**束ねる** | 無し | 段③b |
 * | 形(直角 / 曲線) | **まっすぐ 1 本**だけ | 段③c |
 *
 * 🔑 **綴りだけ先に受ける**のは、書いた人に「何も起きない」を見せないためである
 *   ── 設計 doc に載っている字なので、user は先に書きうる。
 *
 * ## ⚠ ここは計算だけを持つ(features 層)
 *
 * 実際の大きさ(`offsetWidth`)は描画器が測る ── happy-dom は **0 を返す**ので、
 * 判断をあちらへ書くと **unit から永久に見えない**(CLAUDE.md §2)。
 */

/** 板 1 枚の場所と大きさ(器の左上が原点、px)。 */
export interface PlaceRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 線が止まる所。⚠ **中心は持たない** ── 中心へ刺すと線が板の上を横切る
 * (設計 doc §8.1 が名指しで挙げた、アンカーが無いときの実害そのもの)。
 */
export type PlaceAnchor = 'top' | 'right' | 'bottom' | 'left';

/** ⚠ **並び順が tie-break である**(同じ距離なら先に在るほうを採る)。 */
export const PLACE_ANCHORS: readonly PlaceAnchor[] = ['top', 'right', 'bottom', 'left'];

/** その接続点の座標(辺の真ん中)。 */
export function anchorPoint(r: PlaceRect, a: PlaceAnchor): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  if (a === 'top') return { x: cx, y: r.y };
  if (a === 'bottom') return { x: cx, y: r.y + r.h };
  if (a === 'left') return { x: r.x, y: cy };
  return { x: r.x + r.w, y: cy };
}

/** 引く線 1 本。 */
export interface PlaceLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly from: PlaceAnchor;
  readonly to: PlaceAnchor;
}

/**
 * 🔴 **いちばん近い接続点どうしを結ぶ**(段③a の「接続点は自動」)。
 *
 * 🔑 **16 通り(4 × 4)を総当たりする** ── 板は動くので、向きを決め打つと
 *   動かした瞬間に線が板を横切る。⚠ 総当たりといっても 16 回である。
 * ⚠ **同じ距離のときは `PLACE_ANCHORS` の並び順で決める**(`<` で比べる)──
 *   決めないと、描くたびに違う辺から出る形になりうる。
 */
export function placeLineOf(from: PlaceRect, to: PlaceRect): PlaceLine {
  let best: PlaceLine | null = null;
  let bestD = Infinity;
  for (const a of PLACE_ANCHORS) {
    const p = anchorPoint(from, a);
    for (const b of PLACE_ANCHORS) {
      const q = anchorPoint(to, b);
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x1: p.x, y1: p.y, x2: q.x, y2: q.y, from: a, to: b };
      }
    }
  }
  // ⚠ `PLACE_ANCHORS` が空でない限り必ず入るが、型のために既定を置く
  return best ?? { x1: from.x, y1: from.y, x2: to.x, y2: to.y, from: 'top', to: 'top' };
}

/**
 * 🔑 **`from=a:right` の「どの板か」だけを取り出す**(段③a)。
 *
 * ⚠ 接続点(`:right`)は**段③b まで効かない**が、**綴りは受ける** ──
 *   設計 doc に載っている字なので user は先に書きうる。受けないと
 *   「書いたのに線が 1 本も出ない」になり、**綴りを間違えたと読む**
 *   (いちばん気づけない外し方)。
 * ⚠ 空の名前は `null`(id を持たない板は指せない)。
 */
export function placeLineTargetId(raw: string | null): string | null {
  if (raw === null) return null;
  const id = raw.split(':')[0]?.trim() ?? '';
  return id === '' ? null : id;
}
