/**
 * effect 層の StorePort を StoreClient(sqlite worker)へ配線する adapter。
 *
 * persistEntry が受け取るのは reducer が COMMIT_EDIT 時点で確定した行全体
 * (FlavorSpec.extract 済みの抽出列込み ── review K / C-1 の解消形)。
 * ここでは meta の解決も抽出もしない ── 届いた行をそのまま upsert する。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import type { StorePort } from '@adapter/state/store-effects';
import type { EntryMetaRow } from './schema';
import type { RelationRow } from './protocol';
import type { StoreClientLike } from './store-proxy';
import { clearAppStorage } from '@adapter/platform/app-storage';

export function relationFromRow(row: RelationRow): Relation {
  return {
    id: row.id,
    fromLid: row.from_lid,
    toLid: row.to_lid,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function metaFromRow(row: EntryMetaRow): EntryMeta {
  return {
    lid: row.lid,
    title: row.title,
    archetype: row.archetype,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    entryOrder: row.entry_order,
    status: row.status,
    date: row.date,
    archived: row.archived !== 0,
  };
}

/**
 * 生存 entry の保持上限(P5c)。**逆向き差分チェーン**により 1 件あたりの容量が
 * 桁で下がったので、PKC2 相当の全文 20 件から 100 件へ引き上げている
 * (実測は P5c-3 の probe で出す)。settings 表へ移す条件: user が変えたいと言ったとき。
 */
export const REVISION_KEEP_LATEST = 100;

export function createStorePort(client: StoreClientLike, cid: string): StorePort {
  return {
    getBody: (lid) => client.request({ op: 'getBody', cid, lid }),
    /**
     * 本文の全文検索(#181)。⚠ ここは**渡すだけ** ── 引き方(FTS / LIKE)の規則は
     * `features/filter/search-query.ts` が 1 か所で持ち、実行は worker がする。
     */
    searchEntries: async (query) =>
      (await client.request({ op: 'searchEntries', cid, query })).lids,
    /**
     * 集計(#184)。⚠ ここも**渡すだけ** ── 束ね方(並び・上限)の規則は
     * `features/query/group-by.ts` が 1 か所で持つ(PKC2 は描画関数の中に
     * 直書きして 3 実装に増やした)。
     */
    queryKeys: () => client.request({ op: 'queryKeys', cid }),
    queryGroupBy: (key) => client.request({ op: 'queryGroupBy', cid, key }),
    getBodies: (lids) => client.request({ op: 'getBodies', cid, lids }),
    listBodies: (after, maxBytes) =>
      client.request({ op: 'listBodies', cid, maxBytes, ...(after ? { after } : {}) }),
    // 🔑 **刻まれた時刻をそのまま返す**(P9 段①)。捨てると主スレッドは次の boot まで
    // 作成・更新を知らず、情報列が終日「—」になる(実際にそうなっていた)
    persistEntry: (entry, opts) =>
      client.request({
        op: 'upsertEntry',
        cid,
        entry,
        checkpoint: opts?.checkpoint === true,
        keepLatest: REVISION_KEEP_LATEST,
      }),
    /**
     * ノートを消す。⚠ **アプリの保存領域はここでは消さない**(P8 段⑳)。
     *
     * 🔴 段⑯ はここで `clearAppStorage(lid)` を呼んでいたが、**削除は可逆**
     * (ゴミ箱から戻せる)なのに保存領域だけ不可逆に消えていた ── 確認文が
     * 「ゴミ箱から戻せます」と言っているのに、戻すとアプリの中身は 0 件。
     * 家計簿アプリに数か月ぶん貯めた入力が、警告 1 行も無く消える。
     * 後始末は**唯一の不可逆点**(ゴミ箱を空にする)へ移した。
     */
    deleteEntry: async (lid) => {
      await client.request({ op: 'deleteEntry', cid, lid });
    },
    setEntryParent: async (lid, parentLid, relationId) => {
      await client.request({ op: 'setEntryParent', cid, lid, parentLid, relationId });
    },
    listRelations: () => client.request({ op: 'listRelations', cid }),
    // 🔴 #185: 1 件の作成・書き換えは既存の bulk を 1 件で使う(op を 2 つにしない)
    upsertRelation: async (rel) => {
      await client.request({ op: 'bulkUpsertRelations', cid, relations: [rel] });
    },
    deleteRelation: async (id) => {
      await client.request({ op: 'deleteRelation', cid, id });
    },
    listRevisionMetas: (entryLid) =>
      client.request({ op: 'listRevisionMetas', cid, entryLid }),
    getRevision: (revId) => client.request({ op: 'getRevision', cid, id: revId }),
    listTrash: () => client.request({ op: 'listTrash', cid }),
    /**
     * ゴミ箱を空にする(**唯一の不可逆点**)。
     * 🔴 ここでアプリの保存領域も畳む ── 戻せなくなるのはここだけなので、
     * 後始末もここに揃える(削除の可逆性と同じ意味論になる)。
     * ⚠ **消す前に lid を取る** ── 消した後では誰のデータだったか分からない。
     */
    purgeTrash: async () => {
      const trash = await client.request({ op: 'listTrash', cid });
      const res = await client.request({ op: 'purgeTrash', cid });
      for (const lid of new Set(trash.map((r) => r.entry_lid))) clearAppStorage(lid);
      return res;
    },
  };
}
