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
export const APP_VERSION = '3.2.0';
export const SCHEMA_VERSION = 1;

export type BuildKind = 'dev' | 'stage' | 'product';

const rawKind: unknown = import.meta.env.VITE_PKC_KIND;
export const BUILD_KIND: BuildKind =
  rawKind === 'product' || rawKind === 'stage' ? rawKind : 'dev';

/**
 * 🔴 **このビルドを焼いた時刻**(epoch ms。#789)。⚠ 焼いていなければ `0`。
 *
 * ⚠ `vite.config.ts` の `define` が入れる ── **dev server と test では入らない**ので、
 *   `0` に落ちる形にしておく(そこで版の字に日時は出ない = 正しい)。
 * 🔑 **字ではなく数で持つ** ── 表示のときに端末の時刻へ直す(焼いた箱の時間帯を
 *   そのまま出すと、user の手元と合わない)。
 */
/**
 * ⚠ **`vite.config.ts` の `define` が字ごと置き換える識別子**である。
 * 🔑 だから `globalThis['…']` では受けられない ── `define` が差し替えるのは
 *   **裸の識別子**だけで、添字アクセスは書き換わらない(1 稿目で踏んだ)。
 * ⚠ 焼いていない環境(dev server / test)では**そもそも宣言が無い**ので、
 *   `typeof` で確かめてから触る(`typeof` は未宣言でも例外にならない)。
 */
declare const __PKC_BUILT_AT__: number | undefined;

/**
 * 🔴 **このビルドを焼いた時刻**(epoch ms。#789)。⚠ 焼いていなければ `0`。
 *
 * 🔑 **字ではなく数で持つ** ── 表示のときに端末の時刻へ直す(焼いた箱の時間帯を
 *   そのまま出すと、user の手元と合わない)。
 */
export const BUILT_AT: number =
  typeof __PKC_BUILT_AT__ === 'number' &&
  Number.isFinite(__PKC_BUILT_AT__) &&
  __PKC_BUILT_AT__ > 0
    ? __PKC_BUILT_AT__
    : 0;
