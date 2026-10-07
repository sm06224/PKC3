/**
 * AI のツールが保存領域を読む配線(#1407)── `main.ts` から取り出した部分。
 *
 * 🔑 `main.ts` はどの test からも実行されないので、**「どのノートを AI に見せるか」の判断をそこに
 * 置かない**。ここは既存の op(`searchEntries` / `getBodies` / `queryScan('tags')`)を呼ぶだけで、
 * 生の SQL は 1 行も書かない。
 *
 * 🔴 **system 領域のノート(メッセージなど)は読ませない。** 見取り(`meta`)は
 * `entryMetas`(= user 領域だけ)から引くので、system 領域の ID は**見取りに無い**。
 * `getBody` / `getBodies` は領域を見ずに ID で引けてしまうので、**見取りを通った ID だけ**を
 * ツール側が本文の取得へ渡す(`webmcp-tools.ts`)。
 */

import type { EntryMeta } from '@core/model/entry-meta';
import { TAGS_KEY } from '@features/query/group-by';
import type { StoreClientLike } from '@adapter/platform/storage/store-proxy';
import type { AgentToolDeps } from './webmcp-tools';

export interface AgentStoreSource {
  /** いまの user 領域のノートの見取り(`dispatcher.getState().entryMetas`)。呼ぶたびに読む。 */
  entryMetas: () => ReadonlyMap<string, EntryMeta>;
  /** 保存領域の窓口。⚠ 昇格で差し替わる `let` なので、呼ぶたびに引く。 */
  client: () => Pick<StoreClientLike, 'request'>;
  cid: string;
}

export function agentStoreDeps(
  src: AgentStoreSource,
): Pick<AgentToolDeps, 'meta' | 'search' | 'bodies' | 'tags'> {
  return {
    meta: (id) => {
      const m = src.entryMetas().get(id);
      return m === undefined
        ? undefined
        : { title: m.title, archetype: m.archetype, updatedAt: m.updatedAt };
    },
    search: async (query, limit) => {
      const r = await src.client().request({ op: 'searchEntries', cid: src.cid, query, limit });
      return { ids: r.lids, truncated: r.truncated };
    },
    bodies: async (ids) => {
      const rows = await src.client().request({ op: 'getBodies', cid: src.cid, lids: ids });
      return new Map(rows.map((r) => [r.lid, r.body] as const));
    },
    tags: async () => {
      const r = await src.client().request({ op: 'queryScan', cid: src.cid, key: TAGS_KEY });
      return { groups: r.groups?.groups ?? [], omitted: r.groups?.omittedGroups ?? 0 };
    },
  };
}
