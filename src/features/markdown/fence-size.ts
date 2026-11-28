/**
 * 🔴 **囲みの縦横の固定(`width=` / `height=`)**(v4.2 Phase 0 / PR-1)。
 *
 * ` ```html width=480 height=320 ` / ` ```react width=60% ` / ` ```chart width=640px height=300 ` のように、
 * 囲みの情報行に書いた大きさを読む**ただ 1 つの門**。HTML / React / 添付 HTML のウィジェットと、
 * グラフ(静的 `chart`・GPU)のどれもがここを通す(判定を 2 か所に書かない)。
 *
 * 🔒 **CSS へ入るのは数値と単位(`px` / `%`)だけ**。値は正規表現で数字と単位に分けてから
 *   数値として丸め直すので、`width=1px;background:url(…)` のような字は**丸ごと無視**される(無指定扱い)。
 * ⚠ 無指定のときは何も足さない ── 既存の囲みの出力は 1 バイトも変わらない
 *   (`fenceFrameStyle({})` は今までの `width:100%;border:0;height:0;display:block;` そのもの)。
 */

/** 横幅(px)の下限・上限。 */
export const FENCE_WIDTH_PX_MIN = 160;
export const FENCE_WIDTH_PX_MAX = 2400;
/** 横幅(%)の下限・上限。 */
export const FENCE_WIDTH_PCT_MIN = 20;
export const FENCE_WIDTH_PCT_MAX = 100;
/** 縦幅(px)の下限・上限。⚠ `%` は受けない(高さの基準が決まらない)。 */
export const FENCE_HEIGHT_PX_MIN = 80;
export const FENCE_HEIGHT_PX_MAX = 5000;

export interface FenceWidth {
  readonly value: number;
  readonly unit: 'px' | '%';
}

export interface FenceSize {
  readonly width?: FenceWidth;
  /** px。 */
  readonly height?: number;
}

/** 固定の横幅を書く属性(値は `480px` / `60%`)。 */
export const FIXED_WIDTH_ATTR = 'data-pkc-fixed-width';
/** 固定の縦幅を書く属性(値は px の数字)。🔑 これを持つ箱は、中からの高さの申告で上書きしない。 */
export const FIXED_HEIGHT_ATTR = 'data-pkc-fixed-height';

/** 箱の既定の見た目(今までの 1 本と同じ字)。 */
export const DEFAULT_FRAME_STYLE = 'width:100%;border:0;height:0;display:block;';

const SIZE_TOKEN = /^(width|height)=(["']?)(\d{1,5}(?:\.\d{1,3})?)(px|%)?\2$/i;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** 1 つの値(`480` / `480px` / `60%`)を横幅として読む。読めなければ `undefined`。 */
export function parseFenceWidth(raw: string | number | null | undefined): FenceWidth | undefined {
  if (raw === null || raw === undefined) return undefined;
  const m = SIZE_TOKEN.exec(`width=${typeof raw === 'number' ? String(raw) : raw.trim()}`);
  if (m === null) return undefined;
  const n = Number(m[3]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (m[4] === '%') return { value: Math.round(clamp(n, FENCE_WIDTH_PCT_MIN, FENCE_WIDTH_PCT_MAX)), unit: '%' };
  return { value: Math.round(clamp(n, FENCE_WIDTH_PX_MIN, FENCE_WIDTH_PX_MAX)), unit: 'px' };
}

/** 1 つの値(`320` / `320px`)を縦幅(px)として読む。`%` や読めない値は `undefined`。 */
export function parseFenceHeight(raw: string | number | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const m = SIZE_TOKEN.exec(`height=${typeof raw === 'number' ? String(raw) : raw.trim()}`);
  if (m === null || m[4] === '%') return undefined;
  const n = Number(m[3]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(clamp(n, FENCE_HEIGHT_PX_MIN, FENCE_HEIGHT_PX_MAX));
}

/**
 * 囲みの情報行(言語の後ろ)から `width=` / `height=` を読む。キーの大小は問わない。
 * 🔑 同じキーが 2 度あれば先の方を採る。読めないトークンは無視する(ほかの属性 ── `id=` / `asset:` / `live` ── は触らない)。
 */
export function parseFenceSize(rest: string | null | undefined): FenceSize {
  if (rest === null || rest === undefined || rest === '') return {};
  let width: FenceWidth | undefined;
  let height: number | undefined;
  for (const tok of rest.trim().split(/\s+/)) {
    const m = SIZE_TOKEN.exec(tok);
    if (m === null) continue;
    const key = m[1]!.toLowerCase();
    const value = `${m[3]}${m[4] ?? ''}`;
    if (key === 'width' && width === undefined) width = parseFenceWidth(value);
    else if (key === 'height' && height === undefined) height = parseFenceHeight(value);
  }
  return {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

/** 何も固定していないか。 */
export function isFenceSizeEmpty(size: FenceSize): boolean {
  return size.width === undefined && size.height === undefined;
}

/** 横幅の CSS 値(`480px` / `60%`)。 */
export function fenceWidthCss(w: FenceWidth): string {
  return `${String(w.value)}${w.unit}`;
}

/**
 * 器(placeholder)・箱に添える属性。無指定なら空文字(出力を変えない)。
 * 🔑 値は {@link parseFenceSize} を通った数値だけ ── そのまま属性へ書いても注入の余地は無い。
 */
export function fenceSizeAttrs(size: FenceSize): string {
  let out = '';
  if (size.width !== undefined) out += ` ${FIXED_WIDTH_ATTR}="${fenceWidthCss(size.width)}"`;
  if (size.height !== undefined) out += ` ${FIXED_HEIGHT_ATTR}="${String(size.height)}"`;
  return out;
}

/** 器の属性から読み直す(adapter・閲覧用 HTML の側)。同じ門({@link parseFenceWidth} / {@link parseFenceHeight})を通す。 */
export function fenceSizeFromAttrs(get: (name: string) => string | null): FenceSize {
  const width = parseFenceWidth(get(FIXED_WIDTH_ATTR));
  const height = parseFenceHeight(get(FIXED_HEIGHT_ATTR));
  return {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

/**
 * 箱(iframe)の `style`。無指定は今までの {@link DEFAULT_FRAME_STYLE} そのもの。
 * - 横幅を固定: `width:<値>;max-width:100%` ── 本文の幅を超えてはみ出さない
 * - 縦幅を固定: `height:<px>px` ── 中からの高さの申告では変えない({@link FIXED_HEIGHT_ATTR})。溢れた分は箱の中でスクロールする
 */
export function fenceFrameStyle(size: FenceSize): string {
  if (isFenceSizeEmpty(size)) return DEFAULT_FRAME_STYLE;
  const width = size.width === undefined ? 'width:100%;' : `width:${fenceWidthCss(size.width)};max-width:100%;`;
  const height = size.height === undefined ? 'height:0;' : `height:${String(size.height)}px;`;
  return `${width}border:0;${height}display:block;`;
}

/**
 * 箱(iframe)へ付ける属性の組(adapter が `setAttribute` で付ける)。{@link fenceSizeAttrs} と同じ中身。
 * 🔑 `FIXED_HEIGHT_ATTR` を持つ箱は、高さの申告(`pkc-html-render-resize`)で上書きされない。
 */
export function fenceSizeAttrPairs(size: FenceSize): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  if (size.width !== undefined) out.push([FIXED_WIDTH_ATTR, fenceWidthCss(size.width)]);
  if (size.height !== undefined) out.push([FIXED_HEIGHT_ATTR, String(size.height)]);
  return out;
}
