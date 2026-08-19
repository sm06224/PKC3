/**
 * 🔴 **写す(コピー)の段取りを決める**(#273 段③。user 指摘 2026-08-19
 * 「往年の FD などを見習ってください / OS のファイラと同じことができないと
 * いけません」)。
 *
 * ## なぜ純関数として切り出すか
 *
 * 写すのは「選んだ物」だけではない ── **フォルダを選んだら中身も一緒に**行く。
 * ⚠ ここを adapter に書くと、`main.ts` / `binder.ts` は**どの test からも
 * 実行されない / 実行しにくい**ので、親子の付け替えを間違えても緑のまま通る
 * (CLAUDE.md §2)。だから「何を、どういう親子で作るか」だけを**ここで決める**。
 *
 * ## 決めていること
 *
 * - **子孫まで含める**(フォルダを写したら中身も写る)
 * - **親子は写した先の中で組み直す**(元の親を指したままにしない)
 * - **選んだ物の親が同じ組に居るなら、その親の下へ**(2 重に写さない)
 * - **同じ場所へ写すときだけ題名に印を付ける**(別の場所なら名前は変えない ──
 *   FD もそうであり、名前が勝手に変わるほうが驚く)
 *
 * ⚠ **lid の採番はここでやらない**(呼び側が渡す)── 純関数に乱数を持ち込むと
 * test が書けなくなる。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import { resolveCanonicalParents } from './tree';

/** 写す 1 件ぶんの指示。⚠ 呼び側はこの順に作る(親が先に居る)。 */
export interface CopyStep {
  /** 元の lid(本文を読む相手)。 */
  sourceLid: string;
  /** 新しく作る lid(呼び側が採番して渡した物)。 */
  lid: string;
  title: string;
  archetype: string;
  /** 入れ先。`null` = ルート。⚠ **写した先の lid** で、元の親ではない。 */
  parentLid: string | null;
}

/**
 * 選んだ物と、その子孫を**幅優先**で数え上げる。
 *
 * ⚠ **循環しても止まる** ── 訪問済みを持つ(取込で輪が入りうる。
 * `tree.ts` の `getAncestorFolders` と同じ作法)。
 * ⚠ 並びは「選んだ順 → 子は親のすぐ後」で、**親が必ず先に来る**
 * (呼び側が上から作れば、親の lid が既に決まっている)。
 */
export function collectSubtree(
  lids: readonly string[],
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of resolveCanonicalParents(metas, relations)) {
    if (parent === null) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(child);
    else childrenOf.set(parent, [child]);
  }
  const order = (lid: string): number => metas.get(lid)?.entryOrder ?? 0;
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (lid: string): void => {
    if (seen.has(lid) || !metas.has(lid)) return;
    seen.add(lid);
    out.push(lid);
    const kids = [...(childrenOf.get(lid) ?? [])].sort(
      (a, b) => order(a) - order(b) || a.localeCompare(b),
    );
    for (const k of kids) walk(k);
  };
  for (const lid of lids) walk(lid);
  return out;
}

/**
 * 写す段取りを作る。
 *
 * @param lids 選んだ物(画面に出ている印。呼び側が絞ってから渡す)
 * @param targetScope 入れ先のフォルダ(`null` = ルート)
 * @param mintLid 新しい lid を作る(呼び側の採番器 ── ここでは乱数を持たない)
 */
export function planCopy(
  lids: readonly string[],
  targetScope: string | null,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
  mintLid: () => string,
): CopyStep[] {
  const all = collectSubtree(lids, metas, relations);
  if (all.length === 0) return [];
  const parentOf = resolveCanonicalParents(metas, relations);
  const inSet = new Set(all);
  const mapped = new Map<string, string>();
  const steps: CopyStep[] = [];
  for (const src of all) {
    const meta = metas.get(src);
    if (!meta) continue;
    const lid = mintLid();
    mapped.set(src, lid);
    const origParent = parentOf.get(src) ?? null;
    /**
     * ⚠ **親が同じ組に居るなら、その親の写しの下へ**。居ないなら入れ先へ ──
     * ここを取り違えると、フォルダの中身が**入れ先へ平らに散らばる**
     * (FD で言えば「中身が全部トップに出る」)。
     */
    const parentLid =
      origParent !== null && inSet.has(origParent) ? (mapped.get(origParent) ?? null) : targetScope;
    /**
     * ⚠ **名前を変えるのは、同じ場所へ写すときだけ**。別の場所なら変えない ──
     * 場所で区別が付くのに名前が勝手に変わるほうが驚く(FD も変えない)。
     * 🔑 子は**常に元の名前**(親だけが「のコピー」になる ── 中身の名前まで
     *    変えると、写した先で本文の参照と見た目が食い違う)。
     */
    const isRoot = origParent === null || !inSet.has(origParent);
    const sameSpot = isRoot && origParent === targetScope;
    steps.push({
      sourceLid: src,
      lid,
      title: sameSpot ? `${meta.title} のコピー` : meta.title,
      archetype: meta.archetype,
      parentLid,
    });
  }
  return steps;
}
