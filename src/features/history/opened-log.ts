/**
 * 最近開いたノートの記録(#215 残り①)。**pure module**。
 *
 * 🔴 **アプリのデータに混ぜない。** 置き場は端末ごと(localStorage、
 * `adapter/platform/opened-store.ts`)── `theme.ts` / `flag-store.ts` /
 * `notice-store.ts` / `copy-history-store.ts` と**同じ判断**で、理由も同じである:
 * container に入れると**書き出しに同乗**し、HTML を渡した相手の画面に
 * **こちらが何を読んでいたか**が並ぶ。
 *
 * ⚠ **「更新順」とは別物である。** 更新は**書いた**ときに動くので、
 * 「読み返しただけ」のノートは上がってこない ── user が探しているのは
 * 「さっき見ていたあれ」なので、**開いた時刻**が要る。
 *
 * 🔑 **持つのは lid と時刻だけ**(題名は持たない)── 題名は `entryMetas` に在るので、
 * ここに写すと**改名したときに古い字が残る**(§7「同じ値が複数の場所にある」)。
 */

/**
 * 憶えておく件数。⚠ **上限が要る理由は quota ではなく「意味」である** ──
 * 1 年前に 1 度開いたノートが「最近」に居ても、user は探せない。
 * ⚠ 200 件は実測ではなく見立てである。**これが分かったら覆る**:
 * 200 件で足りない(= 並べ替えても目当てが出てこない)と分かったとき。
 */
export const OPENED_MAX = 200;

export interface OpenedAt {
  readonly lid: string;
  /** epoch ミリ秒。 */
  readonly at: number;
}

/**
 * 開いた記録を積む。**新しい順**の配列を返す。
 *
 * ⚠ **同じノートを 2 行にしない** ── 既に在れば時刻だけ更新して先頭へ動かす。
 *   2 行になると `openedMap` はどちらを採るかで答えが変わる(= 並びが揺れる)。
 * ⚠ **元の配列を壊さない**(state の参照でもありうる)。
 */
export function pushOpened(
  list: readonly OpenedAt[],
  lid: string,
  at: number,
  max = OPENED_MAX,
): OpenedAt[] {
  if (lid === '') return [...list];
  return [{ lid, at }, ...list.filter((o) => o.lid !== lid)].slice(0, max);
}

/**
 * 消えたノートの行を落とす。
 *
 * ⚠ **記録が墓場にならないようにする** ── 消した lid を持ち続けると、上限の 200 件が
 *   いつか全部「もう無いノート」で埋まり、**並べ替えても何も上がってこなくなる**。
 * 🔑 判定は呼び側が渡す(`entryMetas.has`)── ここは純関数のままにする。
 */
export function pruneOpened(
  list: readonly OpenedAt[],
  alive: (lid: string) => boolean,
): OpenedAt[] {
  return list.filter((o) => alive(o.lid));
}

/**
 * 並べ替えが引く形(lid → 開いた時刻)。
 * ⚠ **無い lid は `0`** ── 落とさずに末尾へ回す(一覧から黙って消えるほうが害が大きい。
 *   `entry-sort.ts` の `metaOf` と同じ約束)。
 */
export function openedMap(list: readonly OpenedAt[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of list) if (!m.has(o.lid)) m.set(o.lid, o.at);
  return m;
}

export interface RecentNavOptions {
  /** いま開いているノートを除外するか(既定: true)。 */
  readonly excludeCurrent?: boolean;
  /** 上限件数(既定: 50)。 */
  readonly limit?: number;
}

/**
 * 最近開いたノートの lid を新しい順に並べる(#1107)。
 *
 * 1. `openedAt` の keys(端末ごとの最近開いた順)を優先
 * 2. `selectionPast`(末尾から逆順)および `selectionFuture` から未登録のノートを補完
 * 3. 存在しないノート(`alive` が false)は除外
 * 4. 現在地(`currentLid`)は `excludeCurrent` なら除外
 */
export function recentNavLids(
  openedAt: ReadonlyMap<string, number>,
  selectionPast: readonly string[],
  selectionFuture: readonly string[],
  currentLid: string | null,
  alive: (lid: string) => boolean,
  options: RecentNavOptions = {},
): string[] {
  const excludeCurrent = options.excludeCurrent ?? true;
  const limit = options.limit ?? 50;
  const seen = new Set<string>();
  const out: string[] = [];

  if (excludeCurrent && currentLid !== null) {
    seen.add(currentLid);
  }

  // 1. openedAt の並び順(最近開いた順)
  for (const lid of openedAt.keys()) {
    if (!alive(lid)) continue;
    if (seen.has(lid)) continue;
    seen.add(lid);
    out.push(lid);
    if (out.length >= limit) return out;
  }

  // 2. セッションの直近過去(末尾から手前へ)
  for (let i = selectionPast.length - 1; i >= 0; i--) {
    const lid = selectionPast[i]!;
    if (!alive(lid)) continue;
    if (seen.has(lid)) continue;
    seen.add(lid);
    out.push(lid);
    if (out.length >= limit) return out;
  }

  // 3. セッションの未来(戻るで移動した直近閲覧先)
  for (const lid of selectionFuture) {
    if (!alive(lid)) continue;
    if (seen.has(lid)) continue;
    seen.add(lid);
    out.push(lid);
    if (out.length >= limit) return out;
  }

  return out;
}

