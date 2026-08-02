/**
 * StorePort のうち **そのテストが関心を持たない面**の無害 stub。
 * fake StorePort に spread する(`...stubRevisionOps()`)。既定は「何も記録
 * せず・何も見つからない」── 挙動を検証するテストは自前で上書きする。
 *
 * 対象: revision 面(P5b)+ 一括読み(P6d の `listBodies` ── 書出し専用なので
 * state のテストには関係しない)。
 */
import type { StorePort } from '../../src/adapter/state/store-effects';

type RevisionOps = Pick<
  StorePort,
  'listRevisionMetas' | 'getRevision' | 'listTrash' | 'purgeTrash' | 'listBodies'
>;

export function stubRevisionOps(): RevisionOps {
  return {
    listRevisionMetas: async () => [],
    getRevision: async () => null,
    listTrash: async () => [],
    purgeTrash: async () => ({ purged: 0 }),
    listBodies: async () => ({ rows: [], done: true }),
  };
}
