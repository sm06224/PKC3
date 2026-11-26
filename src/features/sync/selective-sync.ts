/**
 * 🔴 **選択同期(#2066 段 5-A)── 同期の対象の閉包(どのノートを運ぶか)を決める純関数**。
 *
 * 人が直接指定したノート(`sel:<lid>`)から、運ぶノートの集合 S を決める。理由は 4 つで、優先は `direct > descendant > related > ancestor`:
 *
 * | 理由 | 決め方 |
 * |---|---|
 * | `direct` | 直接指定された、生きている通常のノート(system 領域・`isReservedSyncLid` は除く) |
 * | `descendant` | `direct` とその子孫を親(`parentLid`)に持つノートを再帰でたどる(輪になっていても止まる) |
 * | `related` | `direct ∪ descendant` を起点に、非 structural のつながり(向きを問わない)と本文の参照(`from → to`)をたどる。`'off'` = 0 段 / `'1hop'` = 1 段 / `'recursive'` = 輪を避けて最大 8 段 |
 * | `ancestor` | ここまでの各ノートから、いちばん上までの親フォルダの鎖(フォルダの骨格。置き場所を相手で再現するため) |
 *
 * 🔴 **`ancestor` で連れてきた親フォルダからは、子孫をたどらない**(親フォルダの中の他のノートを巻き込まない)。
 *   たどるのは `direct` から下だけ。`related` で来たフォルダからも下へはたどらない(関連は「そのノート自身」だけ)。
 *
 * ⚠ pure module。本文は読まない(本文の参照は worker が指紋を測る同じ 1 回の読みで `bodyRefs` に抜き出して渡す)。
 */
import { sha256Hex } from './sha256';
import { isReservedSyncLid, isSyncRelationKind } from './sync-guard';
import type { SyncRelatedMode } from './sync-state';

export type SelectiveReason = 'direct' | 'descendant' | 'related' | 'ancestor';

/** `'recursive'` でたどる段の上限(輪は訪問済みの印で止まる。これは広がりすぎの歯止め)。 */
export const RELATED_MAX_HOPS = 8;

export interface SelectiveNoteMeta {
  readonly lid: string;
  readonly archetype: string;
  /** 親フォルダの lid(ルートは null)。 */
  readonly parentLid: string | null;
}

export interface SelectiveClosureInput {
  /** 生きている全ノート(user 領域)のメタ。 */
  readonly notes: readonly SelectiveNoteMeta[];
  /** つながり(structural・知らない種類は判定で捨てる)。 */
  readonly relations: ReadonlyArray<{ readonly from: string; readonly to: string; readonly kind: string }>;
  /** 本文の参照(`fromLid → toLids`)。 */
  readonly bodyRefs: Readonly<Record<string, readonly string[]>>;
  /** 人が直接指定した lid。 */
  readonly directLids: Iterable<string>;
  readonly relatedMode: SyncRelatedMode;
}

export interface SelectiveClosure {
  /** 対象のノート → 理由。 */
  readonly reasons: ReadonlyMap<string, SelectiveReason>;
  /** 対象の lid(昇順。決定的)。 */
  readonly lids: readonly string[];
  /** `direct ∪ descendant`(受け手の「直接指定に足すか」の判定に使う)。 */
  readonly directAndDescendant: ReadonlySet<string>;
  /** 対象の集合の要約(書き出しの要約に入れる ── 対象を変えたら必ず書き直す)。 */
  readonly digest: string;
}

/** 関連をたどる段の数。 */
export function relatedHops(mode: SyncRelatedMode): number {
  return mode === 'off' ? 0 : mode === '1hop' ? 1 : RELATED_MAX_HOPS;
}

/** 対象の lid の集合の要約(同じ集合なら同じ値)。 */
export function selectionDigest(lids: Iterable<string>): string {
  return sha256Hex(JSON.stringify(['pkc3-sel1', [...new Set(lids)].sort()]));
}

export function resolveSelectiveClosure(input: SelectiveClosureInput): SelectiveClosure {
  const live = new Map<string, SelectiveNoteMeta>();
  for (const n of input.notes) if (n.lid !== '' && !isReservedSyncLid(n.lid)) live.set(n.lid, n);
  const children = new Map<string, string[]>();
  for (const n of live.values()) {
    if (n.parentLid === null || !live.has(n.parentLid)) continue;
    const list = children.get(n.parentLid);
    if (list) list.push(n.lid);
    else children.set(n.parentLid, [n.lid]);
  }
  const reasons = new Map<string, SelectiveReason>();
  // (a) direct
  for (const lid of input.directLids) if (live.has(lid) && !reasons.has(lid)) reasons.set(lid, 'direct');
  // (b) descendant: direct から下だけ(訪問済みの印で輪を止める)
  const stack = [...reasons.keys()];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const c of children.get(cur) ?? []) {
      if (reasons.has(c)) continue;
      reasons.set(c, 'descendant');
      stack.push(c);
    }
  }
  const core = new Set(reasons.keys());
  // (c) related: 向きを問わないつながり + 本文の参照(from → to)
  const hops = relatedHops(input.relatedMode);
  if (hops > 0) {
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string): void => {
      if (a === b || !live.has(a) || !live.has(b)) return;
      const s = adj.get(a);
      if (s) s.add(b);
      else adj.set(a, new Set([b]));
    };
    for (const r of input.relations) {
      if (!isSyncRelationKind(r.kind)) continue;
      link(r.from, r.to);
      link(r.to, r.from);
    }
    for (const [from, tos] of Object.entries(input.bodyRefs)) for (const to of tos) link(from, to);
    let frontier = [...core];
    for (let h = 0; h < hops && frontier.length > 0; h++) {
      const next: string[] = [];
      for (const lid of frontier) {
        for (const nb of adj.get(lid) ?? []) {
          if (reasons.has(nb)) continue;
          reasons.set(nb, 'related');
          next.push(nb);
        }
      }
      frontier = next;
    }
  }
  // (d) ancestor: 親フォルダの鎖だけ(🔴 ここから子孫はたどらない)
  for (const lid of [...reasons.keys()]) {
    const seen = new Set<string>([lid]);
    let p = live.get(lid)?.parentLid ?? null;
    while (p !== null && live.has(p) && !seen.has(p)) {
      seen.add(p);
      if (!reasons.has(p)) reasons.set(p, 'ancestor');
      p = live.get(p)?.parentLid ?? null;
    }
  }
  const lids = [...reasons.keys()].sort();
  return { reasons, lids, directAndDescendant: core, digest: selectionDigest(lids) };
}
