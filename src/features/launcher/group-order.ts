/**
 * 🔴 **グループ自体の並べ替え**(#857 段③)。並べる規則は `app-group-spec.ts` の
 * `sortGroupNames`、ここは**動かしたときに何を書くか**を決める。
 *
 * ## 🔴 なぜ「部分的に番号を付ける」が成り立たないか
 *
 * 並べる規則は「**番号のある群が先、無い群は名前順で後ろ**」なので ──
 * `A / B / C`(どれも番号なし)の `C` を 1 つ上へ動かしたいとき、
 * ⚠ **`C` にだけ番号を付けると `C` は全部の先頭へ飛ぶ**。
 * 🔑 だから「**動かした先より上に在る群**」にも番号が要る。
 *
 * | 動かす群 | 書く枚数(最大) |
 * |---|---|
 * | 上から 2 番目を上へ | 2 |
 * | いちばん下(10 群中)を上へ | 9 |
 * | 2 回目以降 | 2(もう番号が付いている) |
 *
 * ⚠ **この代償は黙って払わない** ── 呼び側は「初めての並べ替え」で 1 度だけ user に
 *   聞く(`willCreateNotes` が枚数を出す)。
 *
 * ## ⚠ 組み込みアプリの群は動かさない
 *
 * 末尾に固定のまま(#281 の実害 ── 自分のものが下へ押し下がって見える、を崩さない)。
 * 🔑 判定は呼び側が渡す `names`(= 動かせる群だけ)に閉じ込める ── ここに
 *   組み込みの名前を書かない(user が同じ名前を付けた日にずれる)。
 *
 * ⚠ **pure module**。DOM も保存も知らない。
 */
import { appGroupOrderOf, sortGroupNames, type AppGroupOrders } from './app-group-spec';

/** 1 群ぶんの書込。⚠ **番号だけ**(目印は別の鍵なので触らない)。 */
export interface GroupOrderWrite {
  readonly name: string;
  readonly order: number;
}

/**
 * 「1 つ上へ / 下へ」の計画。**書く必要のある群だけ**返す(動かせないなら空)。
 *
 * @param names 動かせる群の名前(**名前の無い群と組み込みは含めない**)
 * @param orders いまの番号
 * @param name 動かす群
 * @param by `-1` = 上へ / `+1` = 下へ
 */
export function planGroupMove(
  names: readonly string[],
  orders: AppGroupOrders,
  name: string,
  by: -1 | 1,
): readonly GroupOrderWrite[] {
  const ordered = sortGroupNames(names, orders).filter((n) => n !== '');
  const from = ordered.indexOf(name);
  // ⚠ 端では動かさない(**押せて何も起きない**を作らないよう、呼び側は端で出さない)
  if (from < 0) return [];
  const to = from + by;
  if (to < 0 || to >= ordered.length) return [];

  const next = [...ordered];
  next.splice(to, 0, ...next.splice(from, 1));

  /**
   * 🔑 **書くのは「動いた位置より上の全部 + 自分」まで** ── それより下は
   *   番号が無くても名前順のまま後ろに残るので、触らなくてよい。
   * ⚠ ただし**下に番号付きが居るなら、そこまで**書く(番号付きは必ず先に来るので、
   *   間に挟まれた無番号の群が飛び越されてしまう)。
   */
  let last = Math.max(from, to);
  for (let i = next.length - 1; i > last; i -= 1)
    if (appGroupOrderOf(orders, next[i]!) !== undefined) {
      last = i;
      break;
    }

  const writes: GroupOrderWrite[] = [];
  for (let i = 0; i <= last; i += 1) {
    const n = next[i]!;
    // ⚠ 変わらない群は書かない(`planTileMove` と同じ ── 無駄な書込を出さない)
    if (appGroupOrderOf(orders, n) === i) continue;
    writes.push({ name: n, order: i });
  }
  return writes;
}

/**
 * その計画で**新しくノートを作ることになる群**。
 * ⚠ 呼び側はこの数を user に見せてから書く(黙って N 枚増やさない)。
 */
export function groupsNeedingNote(
  writes: readonly GroupOrderWrite[],
  hasNote: (name: string) => boolean,
): readonly string[] {
  return writes.map((w) => w.name).filter((n) => !hasNote(n));
}
