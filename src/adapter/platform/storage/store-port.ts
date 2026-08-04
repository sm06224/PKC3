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
import type { StoreClient } from './store-client';
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

export function createStorePort(client: StoreClient, cid: string): StorePort {
  return {
    getBody: (lid) => client.request({ op: 'getBody', cid, lid }),
    getBodies: (lids) => client.request({ op: 'getBodies', cid, lids }),
    listBodies: (after, maxBytes) =>
      client.request({ op: 'listBodies', cid, maxBytes, ...(after ? { after } : {}) }),
    persistEntry: async (entry, opts) => {
      await client.request({
        op: 'upsertEntry',
        cid,
        entry,
        checkpoint: opts?.checkpoint === true,
        keepLatest: REVISION_KEEP_LATEST,
      });
    },
    deleteEntry: async (lid) => {
      await client.request({ op: 'deleteEntry', cid, lid });
      // 🔴 **アプリに貸した保存領域も畳む**(P8 段⑯。レビュー)。
      //    かつて `clearAppStorage` は呼び出し元が 1 件も無く、ノートを消しても
      //    そのアプリのデータが origin の localStorage に**永久に残って**いた
      //    (「後始末がある」と読める死んだ export だった)。
      //    ⚠ 消す順は entry が先 ── 逆にすると、削除が失敗したときに
      //    「ノートは在るのにデータだけ消えた」になる
      clearAppStorage(lid);
    },
    listRevisionMetas: (entryLid) =>
      client.request({ op: 'listRevisionMetas', cid, entryLid }),
    getRevision: (revId) => client.request({ op: 'getRevision', cid, id: revId }),
    listTrash: () => client.request({ op: 'listTrash', cid }),
    purgeTrash: () => client.request({ op: 'purgeTrash', cid }),
  };
}
