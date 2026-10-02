/**
 * `storage-gauge-judge.mjs` の型(実体は node が直に実行する `.mjs`。理由は `browse-face.d.mts`)。
 */
export interface GaugeLike {
  pageCount: number;
  fileBytes: number;
  freeBytes: number;
  ftsSegments: number | null;
}
export interface GaugeDelta {
  pageCount: number;
  fileBytes: number;
  freeBytes: number;
  ftsSegments: number | null;
}
export interface PathRun {
  name: string;
  n: number;
  before: GaugeLike;
  after: GaugeLike;
}
export interface Fingerprint {
  counts: unknown;
  rowidAgg: unknown;
  head: unknown;
  sets: Record<string, string[]>;
}
export declare function gaugeDelta(before: GaugeLike, after: GaugeLike): GaugeDelta;
export declare function perOp(
  delta: GaugeDelta,
  n: number,
): { fileBytes: number; freeBytes: number; ftsSegments: number | null } | null;
export declare function controlMoved(idle: PathRun | undefined | null): {
  moved: boolean;
  why: string | null;
};
export declare function problemsOfPhaseA(a: { runs: PathRun[] } | undefined): string[];
export declare function problemsOfOptimizeOp(
  g:
    | {
        roundTripMs: number;
        result: { before: GaugeLike; after: GaugeLike };
      }
    | undefined,
): string[];
export declare function compareFingerprints(
  a: Fingerprint,
  b: Fingerprint,
): { same: boolean; diffs: string[] };
export interface KillRecord {
  killAtMs: number;
  patched?: boolean;
  reopen?: string;
  quickCheck?: string[];
  total?: number;
  touched?: number;
}
export declare function stateOfKill(
  k: Omit<KillRecord, 'killAtMs' | 'patched'>,
): 'init-failed' | 'unreadable' | 'completed' | 'rolled-back' | 'half';
export declare function problemsOfReservedLock(
  kills: KillRecord[] | undefined,
  expect: 'patched' | 'unpatched',
): string[];
