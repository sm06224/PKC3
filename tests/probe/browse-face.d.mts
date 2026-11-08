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
export declare function resolveListFace(
  page: {
    evaluate: (fn: (faces: string[]) => unknown, arg: string[]) => Promise<unknown>;
  },
  /** 既定は `LIST_FACES`。面が複数のときの判断を unit で見るために差せる(#813 段③)。 */
  faces?: readonly string[],
): Promise<ListFace>;

/**
 * 面を解いて、全件が state に載り、見えている塊の行が組み上がって落ち着くのを待つ
 * (#1924 で一覧が塊ごとの仮想化になったので、DOM の行の数で全件は待てない ── #1928)。
 */
export declare function waitForRows(
  page: unknown,
  rows: number,
  timeout?: number,
  opts?: { readonly mustShow?: string },
): Promise<ListFace & { readonly stateCount: number; readonly renderedRows: number }>;
