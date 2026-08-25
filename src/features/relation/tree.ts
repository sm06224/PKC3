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

// ⚠ 正本は `kinds.ts` ── ここで文字列を書き直さない(#185 で 3 か所から寄せた)
import { STRUCTURAL } from './kinds';

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
  // ⚠ 同値の tie は **lid** で決める(boot / 一覧と同じ規則 ── 揃えないと
  //   並べ替えの「隣」がファイラの見た目と食い違う)
  return out.sort(byOrder);
}

/**
 * 🔴 **フォルダ 1 つとその配下ぜんぶ**の lid(#399 ①)。
 *
 * ⚠ **root 自身を含む**(名前が「descendant」ではなく「subtree」なのはそのため)。
 *   含めないと、書き出したアーカイブに**フォルダの器が入らない** ── 取り込み直すと
 *   中身だけが平置きで戻り、user から見て「フォルダごと渡した」ことにならない。
 *
 * 🔑 **正準親の解決は 1 度だけ**(`resolveCanonicalParents`)── 階層ごとに
 *   `getStructuralChildren` を呼ぶと、深さ × relations 件で舐め直すことになる。
 * ⚠ 訪問済み guard を持つ(`getAncestorFolders` と同じ理由 ── 木の不変量は
 *   relation を編集する側が守る。読み手は防御だけする)。
 */
export function collectSubtreeLids(
  rootLid: string,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): Set<string> {
  const parentOf = resolveCanonicalParents(metas, relations);
  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of parentOf) {
    const list = childrenOf.get(parent);
    if (list) list.push(child);
    else childrenOf.set(parent, [child]);
  }
  const out = new Set<string>();
  // ⚠ **実在しない lid では空を返す**(在ることにしない ── 呼び側が断れる)
  if (!metas.has(rootLid)) return out;
  out.add(rootLid);
  const queue = [rootLid];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of childrenOf.get(cur) ?? []) {
      // 訪問済み = 環(または既に別の道で入った)── 2 度足さない
      if (out.has(child) || !metas.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
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
  return out.sort(byOrder);
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

/** 移動先の候補 1 件(`depth` は字下げ表示用、`path` は取り違え防止の全体像)。 */
export interface FolderPath {
  lid: string;
  title: string;
  /** ルートからの深さ(0 = ルート直下)。 */
  depth: number;
  /** `仕事 / 資料` のような道。⚠ **同名フォルダの取り違え**はこれで防ぐ。 */
  path: string;
}

/**
 * すべての folder を「ルートからの道」つきで、**画面に並ぶ順**(深さ優先・
 * 各段は entryOrder 順)で列挙する。
 *
 * ⚠ **輪の中に居る folder も必ず出す**。木から辿れないからと落とすと、
 * その folder は移動先に選べず、中身を出すことも入れることもできない
 * ── 壊れたデータを**直せない**状態に固定してしまう。
 */
export function listFolderPaths(
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): FolderPath[] {
  const parentOf = resolveCanonicalParents(metas, relations);
  const folders: EntryMeta[] = [];
  for (const m of metas.values()) if (m.archetype === 'folder') folders.push(m);

  const byParent = new Map<string | null, EntryMeta[]>();
  for (const f of folders) {
    // ⚠ 親の正しさの判定は `resolveCanonicalParents` に一本化されている
    //    (非 folder 親 / 不在親は既に落ちている)── ここで二重に判定しない
    const key = parentOf.get(f.lid) ?? null;
    const arr = byParent.get(key);
    if (arr) arr.push(f);
    else byParent.set(key, [f]);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.entryOrder - b.entryOrder);

  const out: FolderPath[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number, prefix: string): void => {
    for (const f of byParent.get(parent) ?? []) {
      if (seen.has(f.lid)) continue; // 輪の防御(自己辺は resolveCanonicalParents が落とす)
      seen.add(f.lid);
      const path = prefix === '' ? f.title : `${prefix} / ${f.title}`;
      out.push({ lid: f.lid, title: f.title, depth, path });
      walk(f.lid, depth + 1, path);
    }
  };
  walk(null, 0, '');
  for (const f of folders) {
    if (!seen.has(f.lid)) out.push({ lid: f.lid, title: f.title, depth: 0, path: f.title });
  }
  return out;
}

/**
 * `lid` の移動先になれる folder の一覧。
 *
 * ⚠ **自分自身と、自分の子孫を除く** ── 入れると輪ができて木でなくなり、
 * その枝がまるごとどの画面からも見えなくなる(reducer 側にも同じ判定があるが、
 * こちらは「そもそも選ばせない」ための一覧 ── 押してから黙って断られるのは
 * 「無言の操作拒否」になる)。
 */
export function listMoveTargets(
  lid: string,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): FolderPath[] {
  const parentOf = resolveCanonicalParents(metas, relations);
  const isSelfOrUnder = (candidate: string): boolean => {
    const seen = new Set<string>();
    let cur: string | undefined = candidate;
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === lid) return true;
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return false;
  };
  return listFolderPaths(metas, relations).filter((f) => !isSelfOrUnder(f.lid));
}

/** 並びの規則は **1 つ**(boot / 復元の挿入 / 一覧と同じ)── entryOrder 昇順、同値は lid。 */
function byOrder(a: EntryMeta, b: EntryMeta): number {
  return a.entryOrder - b.entryOrder || a.lid.localeCompare(b.lid);
}

/** 同じ親の下に居るもの(自分を含む)を並び順で返す。root 直下は親 = null。 */
export function listSiblings(
  lid: string,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): EntryMeta[] {
  if (!metas.has(lid)) return [];
  const parentOf = resolveCanonicalParents(metas, relations);
  const parent = parentOf.get(lid) ?? null;
  const out: EntryMeta[] = [];
  for (const m of metas.values()) {
    if ((parentOf.get(m.lid) ?? null) === parent) out.push(m);
  }
  return out.sort(byOrder);
}

/** 並べ替えで書き換える `entryOrder`(空 = 動かせない)。 */
export interface OrderMove {
  lid: string;
  entryOrder: number;
}

/**
 * 🔴 **並べ替え**(2026-08-06。user 報告 2-10)。直す前は `entryOrder` が
 * **作成順に固定**で、並べ替えの手段が action・reducer・UI のどこにも無かった。
 *
 * 形は「**隣と入れ替える**」1 手だけにする(任意位置への drag は持ち込まない ──
 * プライム・ディレクティブ「新機能を盛り込みすぎない」)。
 *
 * ⚠ 動かすのは**同じ親の下**だけ。別の親へ動かすのは居場所の変更(`SET_ENTRY_PARENT`)
 *   であって並べ替えではない ── 1 つの操作に 2 つの意味を持たせない。
 * ⚠ **値は交換する**(付け直さない)。同じ多重集合のまま入れ替えるので、
 *   **他のフォルダの並びに一切触らない** ── `entryOrder` は container 全体で 1 本の
 *   数直線なので、兄弟を 0..n-1 で振り直すと**別のフォルダの entry と噛み合う**。
 * ⚠ 値が**同値**のときは交換しても何も起きない(並びは lid で決まっているから)。
 *   そこだけ隣の外側へ 1 つずらす ── 第三者と同値になることはあるが、その場合も
 *   lid の tie-break で決まるので**並びは決定的**である。
 */
export function reorderSibling(
  lid: string,
  direction: 'up' | 'down',
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): OrderMove[] {
  const siblings = listSiblings(lid, metas, relations);
  const at = siblings.findIndex((m) => m.lid === lid);
  if (at < 0) return [];
  const other = siblings[at + (direction === 'up' ? -1 : 1)];
  const me = siblings[at]!;
  if (!other) return []; // 端 ── 動かせない
  if (me.entryOrder !== other.entryOrder) {
    return [
      { lid: me.lid, entryOrder: other.entryOrder },
      { lid: other.lid, entryOrder: me.entryOrder },
    ];
  }
  return [
    { lid: me.lid, entryOrder: other.entryOrder + (direction === 'up' ? -1 : 1) },
  ];
}
