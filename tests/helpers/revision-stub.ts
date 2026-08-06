/**
 * StorePort のうち **そのテストが関心を持たない面**の無害 stub。
 * fake StorePort に spread する(`...stubRevisionOps()`)。既定は「何も記録
 * せず・何も見つからない」── 挙動を検証するテストは自前で上書きする。
 *
 * 対象: revision 面(P5b)+ 一括読み(P6d の `listBodies` ── 書出し専用なので
 * state のテストには関係しない)+ 指定読み(P7b の `getBodies` ── ランチャー専用)。
 */
import type { StorePort } from '../../src/adapter/state/store-effects';

type RevisionOps = Pick<
  StorePort,
  | 'listRevisionMetas'
  | 'getRevision'
  | 'listTrash'
  | 'purgeTrash'
  | 'listBodies'
  | 'getBodies'
  | 'listRelations'
>;

export function stubRevisionOps(): RevisionOps {
  return {
    listRevisionMetas: async () => [],
    getRevision: async () => null,
    listTrash: async () => [],
    purgeTrash: async () => ({ purged: 0 }),
    listBodies: async () => ({ rows: [], done: true }),
    // ⚠ ランチャー(P7b)専用の読み ── 開かないテストには 1 件も返らないのが正しい。
    // **観測するテストは自前で上書きする**(既定に意味を持たせない)
    getBodies: async () => [],
    // ⚠ 関係を観測するテストは自前で上書きする(既定は「1 件も無い」)
    listRelations: async () => [],
  };
}
