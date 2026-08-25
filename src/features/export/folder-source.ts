/**
 * 🔴 **フォルダ 1 つだけを持ち出す**(#399 ①)。
 *
 * > user の物語:「案件A」フォルダの中身だけを相手に渡したい。いまできるのは
 * > **①コンテナ全部**(渡してはいけない物まで入る)か **②ノート 1 件**
 * > (30 件あったら 30 回押す)だけである。
 *
 * 実装は `singleEntrySource` と**同じ形** ── `ArchiveSource` を**絞り込むだけ**で、
 * writer(`writeArchive`)も読み戻し(`restoreArchive`)も既存のまま使う。
 * 🔑 形式が増えないので「フォルダ書出しだけ壊れている」が起きようがない。
 *
 * ## ⚠ 1 ノート書出しと**違う**ところが 3 つある
 *
 * | | 1 ノート | フォルダ |
 * |---|---|---|
 * | 関連 | **全部落とす**(相手が居ない) | 🔑 **両端が中に居る関連は残す** |
 * | 本文 | 1 件を heap に持つ | 🔴 **持たない**(下記) |
 * | 器 | ノート自身 | 🔑 **フォルダの器も入る**(`collectSubtreeLids`) |
 *
 * ## 🔴 本文を heap に溜めない ── だから 2 周する
 *
 * 添付の走査には**部分木の全本文**が要るが、全部を Map に持つと
 * 「部分木の本文の総量」がそのまま常駐する(user 指示 2026-07-27
 * 「生成とライフサイクル後の速やかな破棄を徹底してください」)。
 *
 * 🔑 だから **1 周目は読んで走査して捨てる**、**2 周目(`listBodies`)で読み直す**。
 * ⚠ 読みは 2 倍になるが、同時に持つ本文は**常に 1 件**である。
 * ⚠ `writeArchive` 側は「バッチぶんを Blob にして手放す」形なので、こちらが
 *   一括で返すとその規律を**こちらから壊す**ことになる ── 予算(`maxBytes`)を
 *   守って刻む。
 */
import { scanAssetRefsInto } from '../asset/asset-ref-scan';
import { collectSubtreeLids } from '../relation/tree';
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import type { ArchiveSource } from './pkc3-archive';

export interface FolderSourceResult {
  source: ArchiveSource;
  /** 書き出せなかったもの(呼び出し側が注意として出す)。 */
  warnings: string[];
  /** 部分木に入った件数(帯に出す ── 押す前後で数が分かるように)。 */
  count: number;
}

/** 本文 1 件を引く。⚠ `getBody` が無い相手(test の fake)では走査で当てる。 */
async function readBody(base: ArchiveSource, lid: string): Promise<string | null> {
  const direct = await base.getBody?.(lid);
  if (direct !== undefined && direct !== null) return direct;
  let after: { entryOrder: number; lid: string } | undefined;
  for (;;) {
    const { rows, done, next } = await base.listBodies(after, 4 * 1024 * 1024);
    const hit = rows.find((r) => r.lid === lid);
    if (hit) return hit.body;
    if (done || !next) return null;
    if (
      after !== undefined &&
      !(
        next.entryOrder > after.entryOrder ||
        (next.entryOrder === after.entryOrder && next.lid > after.lid)
      )
    ) {
      throw new Error('本文の読み出しが進みません(カーソルが前進していません)');
    }
    after = next;
  }
}

/**
 * フォルダ 1 つとその配下だけを含む `ArchiveSource` を作る。
 *
 * @throws フォルダが居ない / フォルダではないときは断る(嘘の名前のアーカイブを作らない)
 */
export async function folderSource(
  base: ArchiveSource,
  rootLid: string,
): Promise<FolderSourceResult> {
  const warnings: string[] = [];
  const rawMetas = await base.listEntryMetas();
  /**
   * ⚠ 木の規則は `features/relation/tree.ts` の 1 本 ── ここで親子の判定を
   *   書き直さない(§7「同じ判定が 2 か所にある」)。綴りだけ合わせる。
   */
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
  const root = metaMap.get(rootLid);
  if (!root) throw new Error('書き出すフォルダが見つかりません');
  if (root.archetype !== 'folder') throw new Error('フォルダではないので、フォルダ書き出しはできません');

  const rawRelations = await base.listRelations();
  const relations: Relation[] = rawRelations.map((r) => ({
    id: r.id,
    fromLid: r.from_lid,
    toLid: r.to_lid,
    kind: r.kind,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  const lids = collectSubtreeLids(rootLid, metaMap, relations);
  // ⚠ **並びは書出しと同じ規則**(entryOrder → lid)。`listBodies` の cursor は
  //   この順に前進するので、ここで決めた順が正本になる。
  const ordered = rawMetas
    .filter((m) => lids.has(m.lid))
    .sort((a, b) => a.entry_order - b.entry_order || (a.lid < b.lid ? -1 : a.lid > b.lid ? 1 : 0));

  // ── 1 周目: 本文と履歴を**読んで走査して捨てる**(heap に溜めない)
  const allAssets = await base.listAssetMetas();
  const remaining = new Set(allAssets.map((a) => a.key).filter((k) => k !== ''));
  const used = new Set<string>();
  const found = (k: string): void => void used.add(k);
  const revisionLids = (await base.listRevisionLids()).filter((l) => lids.has(l));
  let more = remaining.size > 0;
  for (const m of ordered) {
    if (!more) break;
    const body = await readBody(base, m.lid);
    if (body === null) {
      // ⚠ 黙って落とさない ── 本文が読めない entry が在ったことは言う
      warnings.push(`本文を読めなかったノートがあります: ${m.title || m.lid}`);
      continue;
    }
    more = scanAssetRefsInto(body, remaining, found);
  }
  for (const l of revisionLids) {
    if (!more) break;
    for (const r of await base.getRevisionChain(l)) {
      if (!more) break;
      more = scanAssetRefsInto(r.snapshot, remaining, found);
    }
  }
  const assets = allAssets.filter((a) => used.has(a.key));

  /**
   * 🔴 **両端が中に居る関連だけ残す**(1 ノート書出しとの違い)。
   *
   * ⚠ 片端しか居ない関連を入れると、読み戻し側が捨てて警告する ── それは
   *   「入れたのに消えた」に見えるので、**こちらで落として件数を言う**。
   */
  const kept = rawRelations.filter((r) => lids.has(r.from_lid) && lids.has(r.to_lid));
  const dangling = rawRelations.filter(
    (r) => lids.has(r.from_lid) !== lids.has(r.to_lid),
  );
  if (dangling.length > 0) {
    warnings.push(
      `このフォルダの外へ繋がる関連 ${dangling.length} 件は含まれません(相手のノートが入らないため)`,
    );
  }

  // ── 2 周目の口。⚠ **予算を守って刻む**(一括で返すと writeArchive の規律を壊す)
  const listBodies: ArchiveSource['listBodies'] = async (after, maxBytes) => {
    let start = 0;
    if (after !== undefined) {
      const at = ordered.findIndex(
        (m) =>
          m.entry_order > after.entryOrder ||
          (m.entry_order === after.entryOrder && m.lid > after.lid),
      );
      // ⚠ 見つからない = もう先が無い(`done` で返す ── 先頭へ巻き戻さない)
      if (at < 0) return { rows: [], done: true };
      start = at;
    }
    const rows: Array<{ lid: string; body: string }> = [];
    let bytes = 0;
    let i = start;
    for (; i < ordered.length; i++) {
      const m = ordered[i]!;
      const body = await readBody(base, m.lid);
      // ⚠ 1 周目で言ってあるので、ここでは黙って飛ばす(同じ注意を 2 回出さない)
      if (body === null) continue;
      rows.push({ lid: m.lid, body });
      bytes += body.length;
      // 🔑 **1 件は必ず入れてから**予算を見る ── でないと 1 件が予算を超えたとき
      //    永久に前へ進まない(空の batch を返し続ける)
      if (bytes >= maxBytes) {
        i++;
        break;
      }
    }
    const done = i >= ordered.length;
    const last = rows.length > 0 ? ordered[i - 1]! : null;
    return done || last === null
      ? { rows, done: true }
      : { rows, done: false, next: { entryOrder: last.entry_order, lid: last.lid } };
  };

  return {
    warnings,
    count: ordered.length,
    source: {
      cid: base.cid,
      // 題名はフォルダのもの ── ファイル名がそのままフォルダ名になる
      title: root.title || rootLid,
      listEntryMetas: async () => ordered,
      listBodies,
      listRelations: async () => kept,
      listAssetMetas: async () => assets,
      getAssetBlob: (key) => base.getAssetBlob(key),
      listRevisionLids: async () => revisionLids,
      getRevisionChain: (lid) => base.getRevisionChain(lid),
    },
  };
}
