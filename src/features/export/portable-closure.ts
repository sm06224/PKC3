/**
 * 🔴 **「PKC3 入り HTML(選んだ N 件)」に何を入れるか**(#1038 A2)。
 *
 * > user の物語: 数件を選んで相手に渡す。相手がそれを開けば PKC3 として読め、書き足せ、取り込み直せる。
 * > ⚠ 選んだ本文だけでは、相手の画面で**リンクが切れ・画像が欠け・フォルダの外に浮く**。だから依存物も入れる。
 *
 * ## 入れる物(閉包)
 *
 * | 物 | 規則 |
 * |---|---|
 * | 選んだノート | 🔑 選んだ**フォルダは中のノートごと**(`selection-source` のバックアップ側と同じ。持ち出す物は欠けない方へ倒す) |
 * | 参照先 | 本文が**画面でリンクとして指している**ノート(`bodyLinkTargets` ── 埋め込み・リンク)を**推移的に** |
 * | 添付 | 入れたノートの本文が指している添付(`scanAssetRefsInto` ── 添付の照合規則は 1 本) |
 * | 祖先フォルダ | 入れたノートの親から根まで(受け手の一覧で、浮かずに元の階層に座る)。⚠ 兄弟は入れない |
 *
 * ## 入れない物(外へ出る参照は件数を警告に出す)
 * - 片端しか中に居ない**つながり**(読み戻しで捨てられるので、こちらで落として件数を言う)
 * - 履歴・ゴミ箱・メッセージ・設定(worker の `exportImage` の `only` が写さない)
 */
import { bodyLinkTargets } from '../entry-ref/body-links';
import { scanAssetRefsInto } from '../asset/asset-ref-scan';
import { collectSubtreeLids, resolveCanonicalParents } from '../relation/tree';
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import type { ArchiveSource } from './pkc3-archive';
import { readBody } from './folder-source';
import { selectionTitle } from './selection-source';

/** 閉包を決めるのに要る、読み口だけ(全部の `ArchiveSource` を組まなくてよい)。 */
export type ClosureSource = Pick<
  ArchiveSource,
  'cid' | 'listEntryMetas' | 'listRelations' | 'listAssetMetas' | 'getBody' | 'listBodies'
>;

/** 参照をたどる回数の上限(循環・病的な入力で止まらなくなるのを防ぐ)。 */
const MAX_FOLLOWED = 20000;

export interface PortableClosure {
  /** worker へ渡す、入れるノートの lid。 */
  readonly lids: string[];
  /** 入れる添付の key。 */
  readonly assetKeys: string[];
  /** 選んだ(フォルダは中へ広げた)件数。 */
  readonly selected: number;
  /** 選んでいないが参照先として入れた件数。 */
  readonly referenced: number;
  /** 選んでいないが祖先フォルダとして入れた件数。 */
  readonly ancestors: number;
  /** 片端しか入らず落としたつながりの件数。 */
  readonly droppedRelations: number;
  readonly title: string;
  readonly warnings: string[];
}

/** 選んだ lid が 1 件も在らない。 */
export class EmptyClosureError extends Error {
  constructor() {
    super('書き出すノートが見つかりません');
    this.name = 'EmptyClosureError';
  }
}

/**
 * 選んだ lid から、PKC3 入り HTML に入れる範囲を決める。
 * 🔑 本文は **1 件ずつ読んで走査して捨てる**(heap に溜めない ── `folderSource` と同じ規律)。
 * @throws 選んだ lid が 1 件も無いとき(`EmptyClosureError`)
 */
export async function portableClosure(
  base: ClosureSource,
  selected: readonly string[],
): Promise<PortableClosure> {
  const rawMetas = await base.listEntryMetas();
  const byLid = new Map(rawMetas.map((m) => [m.lid, m]));
  const picked = selected.filter((l, i) => byLid.has(l) && selected.indexOf(l) === i);
  if (picked.length === 0) throw new EmptyClosureError();
  const rawRelations = await base.listRelations();

  // ⚠ 木の規則は `features/relation/tree.ts` の 1 本(`selection-source` / `folderSource` と同じ写し)
  const metaMap = new Map<string, EntryMeta>(
    rawMetas.map((m) => [
      m.lid,
      {
        lid: m.lid,
        title: m.title,
        archetype: m.archetype,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        entryOrder: m.entry_order,
        status: m.status,
        date: m.date,
        archived: m.archived !== 0,
        bodyChars: null,
      },
    ]),
  );
  const relations: Relation[] = rawRelations.map((r) => ({
    id: r.id,
    fromLid: r.from_lid,
    toLid: r.to_lid,
    kind: r.kind,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  // ① 選んだノート(フォルダは中ごと)
  const inSet = new Set<string>();
  for (const l of picked) {
    if (byLid.get(l)?.archetype === 'folder') {
      for (const x of collectSubtreeLids(l, metaMap, relations)) inSet.add(x);
    } else inSet.add(l);
  }
  const selectedCount = inSet.size;

  // ② 参照先を推移的に。同じ周で添付も数える(本文を 2 度読まない)
  const allAssets = await base.listAssetMetas();
  const remaining = new Set(allAssets.map((a) => a.key).filter((k) => k !== ''));
  const usedAssets = new Set<string>();
  const found = (k: string): void => void usedAssets.add(k);
  const warnings: string[] = [];
  const unreadable: string[] = [];
  const queue = [...inSet];
  let referenced = 0;
  for (let i = 0; i < queue.length && i < MAX_FOLLOWED; i++) {
    const lid = queue[i]!;
    const body = await readBody(base, lid);
    if (body === null) {
      unreadable.push(byLid.get(lid)?.title || lid);
      continue;
    }
    scanAssetRefsInto(body, remaining, found);
    for (const t of bodyLinkTargets(body, base.cid)) {
      if (inSet.has(t) || !byLid.has(t)) continue;
      inSet.add(t);
      queue.push(t);
      referenced += 1;
    }
  }
  if (unreadable.length > 0) warnings.push(`本文を読めなかったノートがあります: ${unreadable.join('、')}`);

  // ③ 祖先フォルダ(兄弟は入れない)。フォルダ自身の本文の添付も数える
  const parentOf = resolveCanonicalParents(metaMap, relations);
  const ancestorLids: string[] = [];
  for (const l of [...inSet]) {
    let cur = parentOf.get(l);
    while (cur !== undefined && !inSet.has(cur)) {
      inSet.add(cur);
      ancestorLids.push(cur);
      cur = parentOf.get(cur);
    }
  }
  for (const l of ancestorLids) {
    if (remaining.size === 0) break;
    const body = await readBody(base, l);
    if (body !== null) scanAssetRefsInto(body, remaining, found);
  }

  // ④ 外へ出るつながり(片端だけ中)
  const droppedRelations = rawRelations.filter((r) => inSet.has(r.from_lid) !== inSet.has(r.to_lid)).length;
  if (droppedRelations > 0) {
    warnings.push(
      `選んだノートの外へ向かうつながり ${droppedRelations} 件は含まれません(つなぐ先のノートが入らないため)`,
    );
  }

  const firstLid = picked[0]!;
  return {
    lids: [...inSet],
    assetKeys: allAssets.filter((a) => usedAssets.has(a.key)).map((a) => a.key),
    selected: selectedCount,
    referenced,
    ancestors: ancestorLids.length,
    droppedRelations,
    title: selectionTitle(byLid.get(firstLid)?.title || firstLid, picked.length),
    warnings,
  };
}
