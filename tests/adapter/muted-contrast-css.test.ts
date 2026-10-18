/** @vitest-environment node */
/**
 * 🔴 **選んだ行・印を付けた行の薄い字が読める**(依頼 244 / 245。Gemini 裁定 = 案どおり)。
 *
 * 画面の物語:一覧で選んでいる行の更新日・予定の出どころのノート名などは `--muted`(薄い字)のまま、選んだ行の地に載っていた。
 * ターミナルの配色では対比が 2.1(目安 4.5)でほぼ読めず、印を付けた行の更新日も多くの配色で 3.3〜4.3 だった。
 *
 * 守るもの:
 * 1. 全テーマで、**選んだ行の字(`--accent-dim-fg`)が地(`--accent-dim`)に対して 4.5 以上**(244 は「行の字と同じ色にする」ので、これが薄い字の対比になる)
 * 2. 全テーマで、**印の薄い字(`--fg` を 6 割混ぜた `--muted`)が印の地(`--pkc-mark-bg`)に対して 4.5 以上**(245)
 * 3. CSS が実際にそう書いてある(選んだ行は `--muted` を行の字に差し替え / 印の 2 つの表は `--pkc-muted-on-mark`)
 *
 * 守っていないもの:ブラウザが `color-mix(in oklab, …)` を実際にどう解くか(ここでは同じ式を計算で再現している。実ブラウザの色は smoke が見る)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync('src/styles/tokens.css', 'utf8');
const app = readFileSync('src/styles/app.css', 'utf8');

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const delin = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const toOk = (rgb: Rgb): Rgb => {
  const [r, g, b] = rgb.map(lin) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};
const fromOk = ([L, a, b]: Rgb): Rgb => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [r, g, bb].map((c) => Math.min(1, Math.max(0, delin(c)))) as Rgb;
};
/** `color-mix(in oklab, a pa, b)` と同じ。 */
const mix = (a: Rgb, b: Rgb, pa: number): Rgb => {
  const A = toOk(a);
  const B = toOk(b);
  return fromOk(A.map((x, i) => x * pa + B[i]! * (1 - pa)) as Rgb);
};
const lum = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map(lin) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb): number => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const themes: Record<string, Record<string, string>> = {};
for (const m of tokens.matchAll(/:root(?:,\s*:root)?\[data-pkc-theme='([a-z-]+)'\]\s*\{([^}]*)\}/g)) {
  const vars: Record<string, string> = {};
  for (const v of m[2]!.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) vars[v[1]!] = v[2]!;
  themes[m[1]!] = vars;
}

describe('依頼 244 / 245:薄い字の対比', () => {
  it('前提:10 テーマ全部を読めている(読めていないテーマを素通りしない)', () => {
    expect(Object.keys(themes).sort()).toEqual(
      ['dark', 'dracula', 'github', 'github-dark', 'light', 'nord', 'retro', 'solarized', 'solarized-dark', 'terminal'].sort(),
    );
    for (const [name, v] of Object.entries(themes)) {
      for (const k of ['fg', 'surface', 'muted', 'accent-dim', 'accent-dim-fg'])
        expect(v[k], `${name} の --${k} が読めない`).toBeDefined();
    }
  });

  it('244:選んだ行の字は、どのテーマでも地に対して 4.5 以上(薄い字をこの色にする)', () => {
    for (const [name, v] of Object.entries(themes)) {
      const r = ratio(hex(v['accent-dim-fg']!), hex(v['accent-dim']!));
      expect(r, `${name}: ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('244 の対照群:直す前の薄い字(--muted)は、選んだ行の地で目安に届かないテーマがある', () => {
    // 「直した」と言える根拠 ── 直す前の値が目安を割っていなければ、この直しは何も守っていない
    const below = Object.entries(themes).filter(([, v]) => ratio(hex(v['muted']!), hex(v['accent-dim']!)) < 4.5);
    expect(below.map(([n]) => n)).toEqual(expect.arrayContaining(['terminal', 'retro', 'github-dark', 'solarized-dark', 'nord']));
    const terminal = themes['terminal']!;
    expect(ratio(hex(terminal['muted']!), hex(terminal['accent-dim']!))).toBeLessThan(2.2);
  });

  it('245:印の薄い字(fg を 6 割寄せた muted)は、どのテーマでも印の地に対して 4.5 以上', () => {
    for (const [name, v] of Object.entries(themes)) {
      const mark = mix(hex(v['fg']!), hex(v['surface']!), 0.18);
      const text = mix(hex(v['fg']!), hex(v['muted']!), 0.6);
      const r = ratio(text, mark);
      expect(r, `${name}: ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('245 の対照群:直す前の --muted は、印の地で目安に届かないテーマがある', () => {
    const below = Object.entries(themes).filter(([, v]) => {
      const mark = mix(hex(v['fg']!), hex(v['surface']!), 0.18);
      return ratio(hex(v['muted']!), mark) < 4.5;
    });
    expect(below.length).toBeGreaterThanOrEqual(6);
  });

  it('CSS:選んだ行は --muted を行の字に差し替える / トークンの 6 割は tokens.css と一致', () => {
    const sel = /\n\[data-pkc-selected\] \{([^}]*)\}/.exec(app);
    expect(sel, '[data-pkc-selected] の規則が見つからない').not.toBeNull();
    expect(sel![1]!.replace(/\/\*[\s\S]*?\*\//g, '')).toContain('--muted: var(--accent-dim-fg);');
    expect(tokens.replace(/\/\*[\s\S]*?\*\//g, '')).toContain(
      '--pkc-muted-on-mark: color-mix(in oklab, var(--fg) 60%, var(--muted));',
    );
  });

  it('CSS:印の行を持つ 2 つの表(フォルダの表・2 ペインの表)が、どちらも印の薄い字を読む', () => {
    const code = app.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const head of [
      "[data-pkc-region='filer-table'] tbody tr[data-pkc-marked] {",
      "[data-pkc-region='dual-table'] tbody tr[data-pkc-marked] td {",
    ]) {
      const at = code.indexOf(head);
      expect(at, `${head} が見つからない`).toBeGreaterThanOrEqual(0);
      const body = code.slice(at, code.indexOf('}', at));
      expect(body, head).toContain('--muted: var(--pkc-muted-on-mark);');
    }
  });
});
