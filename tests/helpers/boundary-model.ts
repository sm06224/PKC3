/**
 * 面の境目(地の段差)が**質の悪い液晶**でも見えるかを測る模型(依頼 2026-11-21)。
 *
 * 模型(2 段。どちらも sRGB の 0〜1 の符号化値に掛ける):
 *   ① ガンマのずれ: out = in^(1/1.5)   … 中間調が持ち上がる(明るい側ほど差が潰れる = 白に寄って見える)
 *   ② 黒浮き・コントラスト圧縮: out = 0.15 + 0.85 * out … 黒が浮き、全域の差が 85% に縮む
 * 🔑 質の悪い TN / 安価な IPS の典型(ガンマ 2.2 の信号が 1.5 前後で出る・黒が浮く)を粗く写した物。
 *   物差しは CIELAB の L*(D65)の差 ΔL*。人が「段」と感じる最小の差はおよそ 1〜2、
 *   「はっきり見える」は 3 以上。
 */
export type Rgb = [number, number, number];

export const GAMMA = 1.5;
export const BLACK_LIFT = 0.15;

/** `#rgb` / `#rrggbb` / `rgb(r g b / a%)` → [r,g,b,a](0〜255, a は 0〜1)。それ以外は投げる。 */
export function parseColor(src: string): [number, number, number, number] {
  const s = src.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const h = m[1]!;
    return [0, 1, 2].map((i) => parseInt(h[i]! + h[i]!, 16)).concat(1) as [number, number, number, number];
  }
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const h = m[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+)(%?))?\s*\)$/i.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  throw new Error(`解けない色の記法: ${src}`);
}

export function toRgb(c: string): Rgb {
  const p = parseColor(c);
  return [p[0], p[1], p[2]];
}

/** 前景を割合 alpha で背景の上へ重ねる(`color-mix(in srgb, X p%, transparent)` を地に重ねた結果と同じ)。 */
export function over(fg: string, alpha: number, bg: string): Rgb {
  const f = toRgb(fg);
  const b = toRgb(bg);
  return [0, 1, 2].map((i) => f[i]! * alpha + b[i]! * (1 - alpha)) as Rgb;
}

/** 質の悪い液晶に通した後の sRGB(0〜255、丸めない)。 */
export function poor(rgb: Rgb, gamma = GAMMA, lift = BLACK_LIFT): Rgb {
  return rgb.map((v) => {
    const g = (v / 255) ** (1 / gamma);
    return (lift + (1 - lift) * g) * 255;
  }) as Rgb;
}

/** CIELAB の L*(D65)。 */
export function lstar(rgb: Rgb): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const Y = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y;
}

export const dL = (a: Rgb, b: Rgb): number => Math.abs(lstar(a) - lstar(b));

/** `:root[data-pkc-theme='x']` のブロックのトークン(light は既定と同居。コメントは剥がす)。 */
export function themeTokens(css: string, theme: string): Record<string, string> {
  const re =
    theme === 'light'
      ? /:root,\s*:root\[data-pkc-theme='light'\]\s*\{([^}]*)\}/
      : new RegExp(`:root\\[data-pkc-theme='${theme}'\\]\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  if (!m) throw new Error(`テーマのブロックが無い: ${theme}`);
  const out: Record<string, string> = {};
  for (const v of m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    out[v[1]!] = v[2]!.trim();
  }
  return out;
}

/** 隣り合う層の組(名前 → [一方, 他方] の sRGB)。割合は tokens.css / app.css の値(hover 8% / 標準ボタン 6% / 選択 10%)。 */
export function layerPairs(t: Record<string, string>): Record<string, [Rgb, Rgb]> {
  const bg = toRgb(t['--bg']!);
  const s = toRgb(t['--surface']!);
  const s2 = toRgb(t['--surface-2']!);
  const fg = t['--fg']!;
  const sf = t['--surface']!;
  return {
    'bg|surface': [bg, s],
    'surface|surface-2': [s, s2],
    'surface|hover': [s, over(fg, 0.08, sf)],
    'surface|button': [s, over(fg, 0.06, sf)],
    'surface|selected': [s, over(fg, 0.1, sf)],
  };
}
