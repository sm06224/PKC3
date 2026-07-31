/**
 * effect 層(P3 設計メモ §1): DomainEvent を購読して store I/O を行い、
 * SystemCommand で reducer に還流する。reducer は純粋のまま。
 *
 * **直列化(storage review #5 の解消)**: store への op は 1 本の promise chain に
 * 直列化する。worker handler が将来 async 化しても、app 側から見た op 順序は
 * ここで保証される(「init 以外は同期」という暗黙 invariant に依存しない)。
 */
import type { Dispatcher } from './dispatcher';

/**
 * effect 層が必要とする store 面(test では fake を注入)。
 * ⚠ 実装(P3-4/5)の persistBody は「body だけ書く」naive op にしないこと ──
 * 保存経路は必ず FlavorSpec.extract を通して抽出列(status/date/archived)ごと
 * upsert する(review K。抽出列 stale 化 = PKC2 #1022 型乖離の防止)。
 */
export interface StorePort {
  getBody(lid: string): Promise<string | null>;
  persistBody(lid: string, body: string): Promise<void>;
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
      case 'PERSIST_BODY':
        enqueue(async () => {
          if (disposed) return;
          try {
            await store.persistBody(ev.lid, ev.body);
            if (!disposed) dispatcher.dispatch({ type: 'BODY_PERSISTED', lid: ev.lid });
          } catch (e) {
            if (!disposed) dispatcher.dispatch({ type: 'SYS_ERROR', error: String(e) });
          }
        });
        break;
      case 'APP_ERROR':
        break; // 表示系(P3-2 以降)が拾う
    }
  });

  return () => {
    disposed = true;
    unsubscribe();
  };
}
