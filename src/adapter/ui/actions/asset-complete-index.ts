/**
 * 🔴 **`(asset:` の補完が引く添付の一覧**(#2001 段 4)。
 *
 * 添付の key・種類・大きさは**ノートの本文(frontmatter)にしか無い**ので、添付のノートの本文を読んで一覧にする。
 * - 読むのは**添付のノートだけ**(`archetype === 'attachment'`)で、本文は小さい(中身は別の保管庫)。
 * - 🔑 **読んだ結果は `lid + updatedAt` で覚える** ── 打つたびに全部読み直さない。ノートが替われば(`updatedAt` が動く)その 1 件だけ読み直す。
 *   消えたノートの控えは、呼ぶたびに捨てる(控えが育ち続けない)。
 * - 一覧の並びは**ノートの並び順(`order`)**のまま(一覧・`@` の候補と同じ)。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import { readAttachmentMeta } from '@features/flavor/attachment-flavor';
import type { AssetRow } from '@features/markdown/inline-complete';

export interface AssetIndex {
  rows(
    metas: ReadonlyMap<string, EntryMeta>,
    order: readonly string[],
    readBodies: (lids: readonly string[]) => Promise<ReadonlyMap<string, string>>,
  ): Promise<readonly AssetRow[]>;
}

export function createAssetIndex(): AssetIndex {
  // lid → { 読んだときの updatedAt, 行(key が無い添付は null) }
  const cache = new Map<string, { at: string | null; row: AssetRow | null }>();
  // 🔑 読んでいる最中の添付(lid → その読みの Promise)。打鍵が続いても同じ lid を二重に読まない
  const loading = new Map<string, Promise<void>>();
  // 🔑 添付の lid の並びは、状態の参照が同じ間は引き直さない(打鍵のたびに全ノートを歩かない)
  let memo: { metas: ReadonlyMap<string, EntryMeta>; order: readonly string[]; lids: string[] } | null = null;
  return {
    async rows(metas, order, readBodies) {
      if (memo === null || memo.metas !== metas || memo.order !== order) {
        memo = { metas, order, lids: order.filter((lid) => metas.get(lid)?.archetype === 'attachment') };
        // 消えたノートの控えは捨てる(控えが育ち続けない)
        const live = new Set(memo.lids);
        for (const lid of [...cache.keys()]) if (!live.has(lid)) cache.delete(lid);
      }
      const attachments = memo.lids;
      const stale = attachments.filter((lid) => {
        const c = cache.get(lid);
        return c === undefined || c.at !== (metas.get(lid)?.updatedAt ?? null);
      });
      const fresh = stale.filter((lid) => !loading.has(lid));
      if (fresh.length > 0) {
        const batch = readBodies(fresh).then((bodies) => {
          for (const lid of fresh) {
            const body = bodies.get(lid);
            if (body === undefined) continue; // 読めなかった ── 控えず、次に引き直す
            const m = readAttachmentMeta(body);
            cache.set(lid, {
              at: metas.get(lid)?.updatedAt ?? null,
              row:
                m.assetKey === null || m.assetKey === ''
                  ? null
                  : { lid, name: m.name || (metas.get(lid)?.title ?? ''), mime: m.mime, size: m.size, key: m.assetKey },
            });
          }
        });
        for (const lid of fresh) {
          const p = batch.finally(() => {
            if (loading.get(lid) === p) loading.delete(lid);
          });
          loading.set(lid, p);
          // 呼び手が待たない読みの失敗は、呼び手の await が受ける(ここで握りつぶさない・未処理にもしない)
          p.catch(() => undefined);
        }
      }
      if (stale.length > 0) await Promise.all(stale.map((lid) => loading.get(lid)));
      const out: AssetRow[] = [];
      for (const lid of attachments) {
        const r = cache.get(lid)?.row;
        if (r !== undefined && r !== null) out.push(r);
      }
      return out;
    },
  };
}
