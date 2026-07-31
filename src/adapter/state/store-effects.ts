/**
 * effect 層(P3 設計メモ §1): DomainEvent を購読して store I/O を行い、
 * SystemCommand で reducer に還流する。reducer は純粋のまま。
 *
 * **直列化(storage review #5 の解消)**: store への op は 1 本の promise chain に
 * 直列化する。worker handler が将来 async 化しても、app 側から見た op 順序は
 * ここで保証される(「init 以外は同期」という暗黙 invariant に依存しない)。
 */
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import { extractMeta } from '@features/flavor';
import { withTodoStatus } from '@features/flavor/todo-flavor';
import type { Dispatcher } from './dispatcher';

/**
 * effect 層が必要とする store 面(test では fake を注入)。
 * persistEntry は**行全体(抽出列込み)**を受け取る ── 抽出は reducer の
 * COMMIT_EDIT が FlavorSpec.extract で行い、PERSIST_ENTRY イベントに載せて
 * 届く(review K の解消)。effect 層は実行時に state を参照しない
 * (時間差窓 C-1 の解消 ── 発火時に確定した行をそのまま書く)。
 */
export interface StorePort {
  getBody(lid: string): Promise<string | null>;
  persistEntry(entry: EntryUpsert): Promise<void>;
}

export function connectStoreEffects(
  dispatcher: Dispatcher,
  store: StorePort,
): () => void {
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;

  /** 全 store op を単一 chain に直列化(順序保証)。op の失敗は chain を殺さない。 */
  const enqueue = (op: () => Promise<void>): void => {
    queue = queue.then(op, op);
  };

  const unsubscribe = dispatcher.onEvent((ev) => {
    switch (ev.type) {
      case 'REQUEST_BODY':
        enqueue(async () => {
          if (disposed) return;
          try {
            const body = await store.getBody(ev.lid);
            if (disposed) return;
            if (body === null) {
              // schema 上 body は NOT NULL ── null は「行が存在しない」異常系。
              // 空 body に見せかけない(S3 の芽を摘む ── review C')
              dispatcher.dispatch({
                type: 'BODY_LOAD_FAILED',
                lid: ev.lid,
                error: 'entry row missing',
              });
              return;
            }
            dispatcher.dispatch({ type: 'BODY_LOADED', lid: ev.lid, body });
          } catch (e) {
            if (!disposed)
              dispatcher.dispatch({
                type: 'BODY_LOAD_FAILED',
                lid: ev.lid,
                error: String(e),
              });
          }
        });
        break;
      case 'PERSIST_ENTRY':
        enqueue(async () => {
          if (disposed) return;
          try {
            await store.persistEntry(ev.entry);
            if (!disposed)
              dispatcher.dispatch({
                type: 'BODY_PERSISTED',
                lid: ev.entry.lid,
                body: ev.entry.body,
              });
          } catch (e) {
            if (!disposed) dispatcher.dispatch({ type: 'SYS_ERROR', error: String(e) });
          }
        });
        break;
      case 'REQUEST_TODO_TOGGLE':
        // read→rewrite→write を 1 op として直列 queue に載せる ── 同一 lid の
        // 先行 persist の後に読むことが保証される(基底の取り違え防止)
        enqueue(async () => {
          if (disposed) return;
          try {
            const body = await store.getBody(ev.lid);
            if (disposed) return;
            if (body === null) {
              // 行不在の toggle は不変量違反 ── 黙って何もしないより可視で止める
              dispatcher.dispatch({
                type: 'SYS_ERROR',
                error: `todo toggle: entry row missing (${ev.lid})`,
              });
              return;
            }
            // 原文 splice(本文 byte 無傷)→ 唯一の抽出経路 → 行全体 upsert
            const newBody = withTodoStatus(body, ev.nextStatus);
            const ext = extractMeta('todo', newBody);
            await store.persistEntry({
              lid: ev.lid,
              title: ev.title,
              archetype: 'todo',
              body: newBody,
              entryOrder: ev.entryOrder,
              status: ext.status,
              date: ext.date,
              archived: ext.archived,
            });
            if (!disposed)
              dispatcher.dispatch({
                type: 'TODO_TOGGLED',
                lid: ev.lid,
                body: newBody,
                status: ext.status,
                date: ext.date,
                archived: ext.archived,
              });
          } catch (e) {
            if (!disposed) dispatcher.dispatch({ type: 'SYS_ERROR', error: String(e) });
          }
        });
        break;
    }
  });

  return () => {
    disposed = true;
    unsubscribe();
  };
}
