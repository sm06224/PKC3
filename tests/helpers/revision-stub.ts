/**
 * StorePort の revision 面(P5b)の無害 stub。revision を扱わないテストの
 * fake StorePort に spread する(`...stubRevisionOps()`)。既定は「何も記録
 * せず・何も見つからない」── revision の挙動を検証するテストは自前で上書きする。
 */
import type { StorePort } from '../../src/adapter/state/store-effects';

type RevisionOps = Pick<
  StorePort,
  'listRevisionMetas' | 'getRevision' | 'listTrash' | 'purgeTrash'
>;

export function stubRevisionOps(): RevisionOps {
  return {
    listRevisionMetas: async () => [],
    getRevision: async () => null,
    listTrash: async () => [],
    purgeTrash: async () => ({ purged: 0 }),
  };
}
