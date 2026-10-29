/**
 * 🔴 **どの版のビルドか**(ビルド時に焼く定数。#674 / #949)。
 *
 * `__PKC_PORTABLE__` は `vite.config.ts`(通常の版 / Pages / `/dev/`)が false、`build/portable.config.ts`(1 枚にまとめた版)が true で焼く。
 * ⚠ 定義が無い場所(script・古い test の環境)では false(= 通常の版)として読む。
 */
declare const __PKC_PORTABLE__: boolean | undefined;

export const IS_PORTABLE_BUILD: boolean = typeof __PKC_PORTABLE__ !== 'undefined' && __PKC_PORTABLE__ === true;

/** 1 枚にまとめた版で音源分離が使えない理由(画面の字)。 */
export const STEM_PORTABLE_UNAVAILABLE =
  'このビルド(1 枚にまとめた版)では、歌声と楽器に分ける機能は使えません(音源分離の実行ライブラリが大きすぎて畳めないため)。通常の版を使ってください';
