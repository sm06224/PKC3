import { describe, expectTypeOf, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { AppState } from '../../src/adapter/state/app-state';

/**
 * pin: 「未読 body を書く経路が型で不在」(P3 設計メモ §1)。
 * EntryMeta / entryMetas に body を足す変更はこの test を落とす ──
 * PKC2 lazy 失敗(S3: 未読 body の空保存)の再発防止線。
 *
 * ⚠ expectTypeOf は **typecheck 時のみ**有効(vitest run 単体では検出しない)。
 * この pin は「tsconfig が tests/ を含み、CI が typecheck を回す」ことに依存する ──
 * tsconfig を分割して tests/ を typecheck 対象から外すと pin が無言で死ぬ。
 */
describe('lean aggregate type pin', () => {
  it('EntryMeta has no body field', () => {
    expectTypeOf<EntryMeta>().not.toHaveProperty('body');
  });

  it('AppState carries body only through openBody', () => {
    expectTypeOf<AppState>().not.toHaveProperty('container');
    expectTypeOf<AppState['openBody']>().exclude<null>().toHaveProperty('body');
    expectTypeOf<AppState['openBody']>().exclude<null>().toHaveProperty('baseline');
  });
});
