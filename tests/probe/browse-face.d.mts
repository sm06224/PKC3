/**
 * `browse-face.mjs` の型。
 *
 * ⚠ 実体を `.ts` にはできない ── probe runner は **node が直に実行する `.mjs`** で、
 * ビルド段を通らない(`node tests/probe/run-sidebar-probe.mjs`)。
 * unit(`tests/adapter/probe-browse-face.test.ts`)から型付きで import するために、
 * 宣言だけをここに置く。
 */

/** 一覧の面(タブで入れ替わる)。 */
export declare const LIST_FACES: readonly string[];

export interface ListFace {
  readonly region: string;
  readonly selector: string;
}

/** いま見えている一覧の面を解く(1 つに定まらなければ throw)。 */
export declare function resolveListFace(page: {
  evaluate: (fn: (faces: string[]) => unknown, arg: string[]) => Promise<unknown>;
}): Promise<ListFace>;

/** 面を解いて、行が出そろうのを待つ。 */
export declare function waitForRows(
  page: unknown,
  rows: number,
  timeout?: number,
): Promise<ListFace>;
