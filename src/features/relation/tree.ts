/**
 * structural relations で組む folder 木の最小核(P3-7b。PKC2 tree.ts の
 * リーン移植 ── cycle rescue / buildTree 全体は持ち込まず、filer が必要とする
 * 3 関数だけ)。
 *
 * 規約: folder = archetype 'folder' の entry、辺 = kind 'structural' の
 * relation(fromLid = 親、toLid = 子)。
 *
 * ⚠ 並び順は **entryOrder 順に正規化**する ── PKC2 は「relations 配列の走査順」
 * という暗黙仕様で、storage が物理順を保証しなくなると非決定になる罠だった
 * (surveyor 調査で確定)。PKC3 は順序の正本を entryOrder に一本化する。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';

const STRUCTURAL = 'structural';

/** 親 folder 直下の子(entryOrder 順)。 */
export function getStructuralChildren(
  parentLid: string,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): EntryMeta[] {
  const out: EntryMeta[] = [];
  for (const r of relations) {
    if (r.kind !== STRUCTURAL || r.fromLid !== parentLid) continue;
    const m = metas.get(r.toLid);
    if (m) out.push(m);
  }
  return out.sort((a, b) => a.entryOrder - b.entryOrder);
}

/** structural な親を持たない entry(= root 直下、entryOrder 順)。 */
export function getRootEntries(
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): EntryMeta[] {
  const hasParent = new Set<string>();
  for (const r of relations) {
    if (r.kind === STRUCTURAL) hasParent.add(r.toLid);
  }
  const out: EntryMeta[] = [];
  for (const m of metas.values()) {
    if (!hasParent.has(m.lid)) out.push(m);
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
  const parentOf = new Map<string, string>();
  for (const r of relations) {
    // 複数親は「最初の structural 辺」を採用(PKC2 と同じ first-wins)
    if (r.kind === STRUCTURAL && !parentOf.has(r.toLid)) parentOf.set(r.toLid, r.fromLid);
  }
  const out: EntryMeta[] = [];
  const seen = new Set<string>([lid]);
  let cur = parentOf.get(lid);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const m = metas.get(cur);
    if (!m || m.archetype !== 'folder') break;
    out.push(m);
    cur = parentOf.get(cur);
  }
  return out;
}

/**
 * filer の scope 解決: 選択が folder ならそれ、非 folder なら最近傍の祖先
 * folder、無ければ null(= root)。PKC2 resolveFilerScope と同じ意味論。
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
