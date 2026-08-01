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

/** 生存 entry の保持上限(P5 設計 §3)。settings 表へ移す条件: user が変えたいと言ったとき。 */
export const REVISION_KEEP_LATEST = 20;

export function createStorePort(client: StoreClient, cid: string): StorePort {
  return {
    getBody: (lid) => client.request({ op: 'getBody', cid, lid }),
    persistEntry: async (entry) => {
      await client.request({ op: 'upsertEntry', cid, entry });
    },
    deleteEntry: async (lid) => {
      await client.request({ op: 'deleteEntry', cid, lid });
    },
    addRevision: (rev) =>
      client.request({
        op: 'addRevision',
        cid,
        rev,
        keepLatest: REVISION_KEEP_LATEST,
      }),
    listRevisionMetas: (entryLid) =>
      client.request({ op: 'listRevisionMetas', cid, entryLid }),
    getRevision: (revId) => client.request({ op: 'getRevision', cid, id: revId }),
    listTrash: () => client.request({ op: 'listTrash', cid }),
    purgeTrash: () => client.request({ op: 'purgeTrash', cid }),
  };
}
