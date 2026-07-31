/**
 * structural relations で組む folder 木の最小核(P3-7b。PKC2 tree.ts の
 * リーン移植 ── cycle rescue / buildTree 全体は持ち込まず、filer が必要とする
 * 関数だけ)。
 *
 * 規約: folder = archetype 'folder' の entry、辺 = kind 'structural' の
 * relation(fromLid = 親、toLid = 子)。
 *
 * **正準親(canonical parent)への一本化**(P3-7b review #1/#3):
 * 木の解釈はすべて resolveCanonicalParents を通す ── 有効な親辺は
 * 「親が metas に実在する folder で、from ≠ to」のみ。多重親は
 * **親 folder の entryOrder 最小**を正準とする(決定的 ── relations の
 * 物理順に依存しない。PKC2 の first-wins は配列順依存で、児が 2 つの
 * folder に見えてクリックで別 folder へ飛ぶ非対称があった)。
 * 児は正準親の下に**だけ**現れる。
 *
 * ⚠ 並び順は entryOrder 順に正規化(「relations 配列の走査順」という
 * PKC2 の暗黙仕様を持ち込まない)。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';

const STRUCTURAL = 'structural';

/** child lid → 正準親 lid。規約外の辺(非 folder 親 / 不在親 / 自己辺)は無視。 */
export function resolveCanonicalParents(
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const r of relations) {
    if (r.kind !== STRUCTURAL || r.fromLid === r.toLid) continue;
    const parent = metas.get(r.fromLid);
    if (!parent || parent.archetype !== 'folder') continue;
    const cur = parentOf.get(r.toLid);
    if (cur === undefined) {
      parentOf.set(r.toLid, r.fromLid);
      continue;
    }
    // 多重親: 親 folder の entryOrder 最小(tie は lid 辞書順)を正準に
    const curMeta = metas.get(cur)!;
    if (
      parent.entryOrder < curMeta.entryOrder ||
      (parent.entryOrder === curMeta.entryOrder && r.fromLid < cur)
    ) {
      parentOf.set(r.toLid, r.fromLid);
    }
  }
  return parentOf;
}

/** 親 folder 直下の子(正準親がその folder のもののみ、entryOrder 順)。 */
export function getStructuralChildren(
  parentLid: string,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): EntryMeta[] {
  const parentOf = resolveCanonicalParents(metas, relations);
  const out: EntryMeta[] = [];
  for (const [child, parent] of parentOf) {
    if (parent !== parentLid) continue;
    const m = metas.get(child);
    if (m) out.push(m);
  }
  return out.sort((a, b) => a.entryOrder - b.entryOrder);
}

/** 正準親を持たない entry(= root 直下、entryOrder 順)。 */
export function getRootEntries(
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): EntryMeta[] {
  const parentOf = resolveCanonicalParents(metas, relations);
  const out: EntryMeta[] = [];
  for (const m of metas.values()) {
    if (!parentOf.has(m.lid)) out.push(m);
  }
  return out.sort((a, b) => a.entryOrder - b.entryOrder);
}

/**
 * lid から root へ向かう祖先 folder 列(近い順)。cycle / 自己参照は訪問済み
 * guard で打ち切る(木の不変量は将来の relation 編集側で守る ── 読み手は防御のみ)。
 */
export function getAncestorFolders(
  lid: string,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): EntryMeta[] {
  const parentOf = resolveCanonicalParents(metas, relations);
  const out: EntryMeta[] = [];
  const seen = new Set<string>([lid]);
  let cur = parentOf.get(lid);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const m = metas.get(cur);
    if (!m) break; // resolveCanonicalParents が実在 folder に絞っている ── 防御のみ
    out.push(m);
    cur = parentOf.get(cur);
  }
  return out;
}

/**
 * filer の scope 解決: 選択が folder ならそれ、非 folder なら最近傍の祖先
 * folder、無ければ null(= root)。PKC2 resolveFilerScope と同じ意味論。
 * subset profile(表示レンズ、curation 用)を導入する場合はこの解決点が seam。
 */
export function resolveFilerScope(
  selectedLid: string | null,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): EntryMeta | null {
  if (!selectedLid) return null;
  const selected = metas.get(selectedLid);
  if (!selected) return null;
  if (selected.archetype === 'folder') return selected;
  return getAncestorFolders(selectedLid, metas, relations)[0] ?? null;
}
