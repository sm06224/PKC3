/**
 * 🔴 **境界で同じ向きに 2 回押すと、次のテキストボックスへ移る**(#524。
 * user 指示 2026-08-28)。
 *
 * > 「**インライン編集のカーソル移動の Alt+上下でのテキストボックス移動を廃止、
 * > 代わりにテキストボックス上端または下端の境界では 2 回同じ方向の上下どちらかの
 * > カーソルを押すことで次のテキストボックスに移動するようにする**」
 *
 * 🔑 **これは動線を減らす削除ではない** ── `Alt+上下` を覚えなくても
 * **素のカーソルだけで**同じことができるようになる(user 自身の指示でもある)。
 *
 * ## 🔴 「2 回」の数え方 ── 起点で回数が変わらない形にした
 *
 * ⚠ issue が「実装前に固める」と書いていた所である。2 通り考えられた:
 *
 * | | 中ほどの行から始めたとき | 端に居るときから始めたとき |
 * |---|---|---|
 * | A: **着いた押下は数えない** | **3 回**(着く 1 + 境界 2) | 2 回 |
 * | B: **着いた押下から数える** | **2 回** | 2 回 |
 *
 * 🔑 **B を採った。理由は好みではなく一貫性である** ── A は
 * 「どこから押し始めたか」で必要な回数が変わるので、user は数えられない。
 * B なら **どこから押しても、端の行に居るあいだの 2 回**で移る。
 *
 * ## ⚠ 時間では切らない
 *
 * issue の指摘どおり、時間で切ると**ゆっくり押す人が永久に移動できない**。
 * 数え直すのは「**別のことをしたとき**」── 向きが変わる / 境界から離れる /
 * 別のキーを打つ / 選び直す。
 *
 * ⚠ **pure module**。browser API を使わない(境界に居るかの判定は adapter 側)。
 */

/** 押した向き。 */
export type StepDir = 'up' | 'down';

/** 数えている途中の状態。⚠ **持ち主は 1 人**(活性の入力欄)。 */
export interface BoundaryStep {
  /** 数えている向き。`null` = 数えていない。 */
  readonly dir: StepDir | null;
  /** その向きで境界に居たまま押した回数。 */
  readonly count: number;
}

/** 何も数えていない状態。 */
export const NO_BOUNDARY_STEP: BoundaryStep = { dir: null, count: 0 };

/**
 * 🔴 **移るのに要る回数**。⚠ 1 にすると「行の中を上下しただけで隣の塊へ飛ぶ」に
 * なる ── user が 2 を選んだのは、事故で飛ばないためである。
 */
export const BOUNDARY_STEPS_TO_MOVE = 2;

/**
 * 1 回ぶん数える。
 *
 * @param prev いまの状態
 * @param dir 押した向き
 * @param atBoundary その向きの端の行に**居るか**(↑ なら 1 行目、↓ なら最終行)。
 *   ⚠ 判定は押した**後**の caret ではなく、**押す前に端の行に居たか**で採る
 *   (上の表の B)
 * @returns `move` が真なら次のテキストボックスへ移る。⚠ 移ったら数えは 0 に戻る
 *   ── 戻さないと、移った先で 1 回押しただけでさらに飛ぶ
 */
export function stepAtBoundary(
  prev: BoundaryStep,
  dir: StepDir,
  atBoundary: boolean,
): { readonly state: BoundaryStep; readonly move: boolean } {
  // 端に居ないなら、ふつうのカーソル移動 ── 数えを捨てる
  if (!atBoundary) return { state: NO_BOUNDARY_STEP, move: false };
  const count = prev.dir === dir ? prev.count + 1 : 1;
  if (count >= BOUNDARY_STEPS_TO_MOVE) return { state: NO_BOUNDARY_STEP, move: true };
  return { state: { dir, count }, move: false };
}
