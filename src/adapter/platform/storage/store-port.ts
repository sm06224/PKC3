/**
 * effect 層の StorePort を StoreClient(sqlite worker)へ配線する adapter。
 *
 * ⚠ persistBody は暫定で「現 meta を併送して upsert」する(P3-2)。
 * P3-4 で FlavorSpec.extract を唯一の抽出経路としてここを差し替えること
 * (body と抽出列の乖離 = PKC2 #1022 型の防止。state review K の pin)。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import type { StorePort } from '@adapter/state/store-effects';
import type { EntryMetaRow } from './schema';
import type { StoreClient } from './store-client';

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

export function createStorePort(
  client: StoreClient,
  cid: string,
  currentMeta: (lid: string) => EntryMeta | undefined,
): StorePort {
  return {
    getBody: (lid) => client.request({ op: 'getBody', cid, lid }),
    async persistBody(lid, body) {
      const meta = currentMeta(lid);
      if (!meta) throw new Error(`persistBody: unknown entry ${lid}`);
      await client.request({
        op: 'upsertEntry',
        cid,
        entry: {
          lid,
          title: meta.title,
          archetype: meta.archetype,
          body,
          entryOrder: meta.entryOrder,
          // 暫定: meta の値を維持(P3-4 で FlavorSpec.extract(body) に置換)
          status: meta.status,
          date: meta.date,
          archived: meta.archived,
        },
      });
    },
  };
}
