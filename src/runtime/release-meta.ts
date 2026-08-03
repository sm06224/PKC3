/**
 * PKC3 provenance(PKC2 の pkc-meta 流儀を継承 ── 設計 doc §2)。
 * kind はビルド時の VITE_PKC_KIND env で刻印し、Pages の dev / product を機械判別する。
 */
export const APP_ID = 'pkc3' as const;
/**
 * ⚠ **`package.json` の `version` と一致させる**(`tests/release-meta.test.ts` が pin)。
 * release workflow は `v<この値>` の tag しか受けない ── 食い違うと
 * 「配ったものと名乗る版が違う」provenance になる。
 */
export const APP_VERSION = '3.0.0';
export const SCHEMA_VERSION = 1;

export type BuildKind = 'dev' | 'stage' | 'product';

const rawKind: unknown = import.meta.env.VITE_PKC_KIND;
export const BUILD_KIND: BuildKind =
  rawKind === 'product' || rawKind === 'stage' ? rawKind : 'dev';
