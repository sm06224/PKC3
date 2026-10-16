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
import { SMART_ARCHETYPE } from '@features/smart/smart-spec';

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

/**
 * 🔑 **親 → 子の索引を 1 度だけ作る**(#1087)。正準親の解決も並べ替えも**ここ 1 か所**で、
 *   `getStructuralChildren`(1 件ぶん)と木を丸ごと歩く呼び手(構成のテキスト)が同じ口を通る
 *   ── 並びの規則を 2 本にしない(§7)。
 * ⚠ 木を歩く側が節点ごとに `getStructuralChildren` を呼ぶと、そのたびに正準親を解き直して
 *   O(N·(R+N)) になる。歩く側はこの索引を 1 度作って引く。
 * 返す関数は、子の無い lid にも空の配列を返す。
 */
export function buildStructuralChildrenIndex(
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): (parentLid: string) => readonly EntryMeta[] {
  const parentOf = resolveCanonicalParents(metas, relations);
  const childrenOf = new Map<string, EntryMeta[]>();
  for (const [child, parent] of parentOf) {
    const m = metas.get(child);
    if (!m) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(m);
    else childrenOf.set(parent, [m]);
  }
  // ⚠ 同値の tie は **lid** で決める(boot / 一覧と同じ規則 ── 揃えないと
  //   並べ替えの「隣」がファイラの見た目と食い違う)
  for (const list of childrenOf.values()) list.sort(byOrder);
  return (parentLid) => childrenOf.get(parentLid) ?? [];
}

/** 親 folder 直下の子(正準親がその folder のもののみ、entryOrder 順)。 */
export function getStructuralChildren(
  parentLid: string,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): EntryMeta[] {
  return [...buildStructuralChildrenIndex(metas, relations)(parentLid)];
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

/**
 * 🔴 **いまの場所の「配下ぜんぶ」を階層を無視して平らに**(#813 段②。「中まで全部出す」)。
 *
 * - `scopeLid === null`(ルート)= **全件**(かつての一覧タブに出ていた集合)
 * - フォルダ = その**配下だけ**(フォルダ自身は含めない ── 現在地はパンくずが言っている。
 *   ⚠ 別の枝は出ない)
 *
 * 🔑 配下の決め方は `collectSubtreeLids`(正準親の解決を 1 度だけ・環の guard 付き)と
 *   **同じ 1 本**を通す ── 木の読み方を 2 本にしない(§7)。
 * ⚠ 並びは entryOrder 順(手動の順)。木の深さ優先にはしない ──
 *   並び順の選択(`sortOrder`)が呼び側で上書きする。
 */
export function getFlatDescendants(
  scopeLid: string | null,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): EntryMeta[] {
  if (scopeLid === null) return Array.from(metas.values()).sort(byOrder);
  const out: EntryMeta[] = [];
  for (const lid of collectSubtreeLids(scopeLid, metas, relations)) {
    if (lid === scopeLid) continue;
    const m = metas.get(lid);
    if (m) out.push(m);
  }
  return out.sort(byOrder);
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
/**
 * 🔴 **押して「中へ入れる」入れ物か**(#421 段①)。⚠ 判定はここ 1 か所 ──
 * 入る口は **3 つ**(左の列の 2 クリック / `Enter` / 2 ペインの `Enter`)あり、
 * 書き忘れた口だけ**押しても何も起きない**(この repo が何度も直した dead click)。
 *
 * ⚠ **「親になれるか」とは別の問い**である ── スマートフォルダは中へ入れるが、
 *   **手で子を入れることはできない**(中身は条件で決まる)。だから
 *   「作る先」「移す先」の判定にこれを使ってはいけない。
 */
export const canEnterScope = (archetype: string | undefined): boolean =>
  archetype === 'folder' || archetype === SMART_ARCHETYPE;

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

/**
 * 🔴 **ゴミ箱から戻すときに合流させる辺のうち、輪を作るものを分ける**(#1087、ゴミ箱の見直し)。
 *
 * ⚠ なぜ要るか:ゴミ箱へ移しても disk の辺は残す(戻したら居場所が戻るように)が、画面の木からは落ちる。
 *   そのため「X > A > B の A をゴミ箱へ → X を B の中へ移す」が通り(画面の木には X → A が無い)、
 *   A を戻すと X → A → B → X の**輪**になる。輪に入ったフォルダはどれも「親を持つ」ので、
 *   中身ごと一覧から消えていた。
 * 🔑 入れる順は**戻すノートの親の辺 → 子の辺**。親を先に決め、後から輪を作る辺を捨てる
 *   (上の例では A は X の中へ戻り、B は今居る場所に留まる)。
 * ⚠ 判定は正準親ではなく**残っている親の辺すべて**で見る(多重親のどれを通っても輪は輪)。
 *   居場所以外の辺(リンクなど)は木を作らないので、そのまま通す。
 */
export function splitRestoredEdges(
  current: readonly Relation[],
  restoredLid: string,
  incoming: readonly Relation[],
): { kept: Relation[]; dropped: Relation[] } {
  const parents = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    const set = parents.get(to);
    if (set === undefined) parents.set(to, new Set([from]));
    else set.add(from);
  };
  for (const r of current) if (r.kind === STRUCTURAL && r.fromLid !== r.toLid) link(r.fromLid, r.toLid);
  /** `target` が `start` 自身か、その祖先(親の辺をたどって届く)か。 */
  const reaches = (start: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of parents.get(cur) ?? []) stack.push(p);
    }
    return false;
  };
  const ordered = [
    ...incoming.filter((r) => r.toLid === restoredLid),
    ...incoming.filter((r) => r.toLid !== restoredLid),
  ];
  const kept: Relation[] = [];
  const dropped: Relation[] = [];
  for (const r of ordered) {
    if (r.kind !== STRUCTURAL) {
      kept.push(r);
      continue;
    }
    // 親 → 子 の辺は、子が親自身か親の祖先なら輪になる
    if (r.fromLid === r.toLid || reaches(r.fromLid, r.toLid)) {
      dropped.push(r);
      continue;
    }
    link(r.fromLid, r.toLid);
    kept.push(r);
  }
  return { kept, dropped };
}

/**
 * 🔴 **`lid` を `newParent` の中へ移すと輪になるか**(#1087)── 居場所の辺を**すべて**辿って見る。
 *
 * ⚠ なぜ正準親だけでは足りないか:親が複数在る(PKC2 から取り込むと在りうる)と、正準親の鎖には
 *   `lid` が出てこなくても、**別の親の鎖**には出てくる。通すと、片方の親をゴミ箱へ移した途端に
 *   `lid` とその中身が木のどこにも出なくなる(最上位の判定は「親を持たない物」)。
 * 🔑 画面側(`app-state.ts`)と書く側(worker の tx)が**この 1 本**を通す ── 規則を 2 本にしない。
 *   親の引き方だけを呼び側が渡す(画面は `relations`、worker は SQL)。
 * ⚠ `newParent` が `lid` 自身のときも、始点で当たるので同じ門で断る。訪問済みで止める
 *   (disk に輪が残っていても回り続けない)。
 */
export function wouldMakeCycle(
  lid: string,
  newParent: string,
  parentsOf: (child: string) => Iterable<string>,
): boolean {
  const seen = new Set<string>();
  const stack = [newParent];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === lid) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of parentsOf(cur)) stack.push(p);
  }
  return false;
}

/** 居場所の辺すべてから「子 → 親たち」を引く関数を作る(`wouldMakeCycle` の画面側の引き方)。 */
export function structuralParentsLookup(
  relations: readonly Relation[],
): (child: string) => Iterable<string> {
  const parents = new Map<string, string[]>();
  for (const r of relations) {
    if (r.kind !== STRUCTURAL || r.fromLid === r.toLid) continue;
    const list = parents.get(r.toLid);
    if (list) list.push(r.fromLid);
    else parents.set(r.toLid, [r.fromLid]);
  }
  return (child) => parents.get(child) ?? [];
}
