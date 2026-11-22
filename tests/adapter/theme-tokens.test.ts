/** @vitest-environment node */
/**
 * P8: 配色**トークン**の網羅と、**読めるかどうか**。
 *
 * 🔴 テーマが 9 個になった時点で、**目で確かめるのは不可能**になった。
 * 前回ライトで白 on 淡緑 = **1.80:1** の読めない文字を出荷しており、
 * 面の smoke は `body` の背景しか見ないので **green のまま**だった。
 * ここが「読めない配色を出荷しない」唯一の関門である。
 *
 * ⚠ 閾値は 2 段階(WCAG):
 *   - 文字(地の上の `--fg` / `--muted`)= **4.5:1**
 *   - UI 部品(リンク色・枠)= **3:1** 以下
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { THEMES } from '../../src/adapter/ui/render/theme';

const css = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');

/** `:root[data-pkc-theme='x']` ブロックの中のトークンを読む(light は既定と同居)。 */
function tokensOf(theme: string): Record<string, string> {
  const needle =
    theme === 'light'
      ? ":root,\n:root[data-pkc-theme='light'] {"
      : `:root[data-pkc-theme='${theme}'] {`;
  const at = css.indexOf(needle);
  expect(at, `${theme} のブロックが tokens.css に無い`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const body = css.slice(open, close);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) out[m[1]!] = m[2]!.trim();
  return out;
}

/** `#rgb` / `#rrggbb` → [r,g,b]。⚠ それ以外の記法はこの file では使わせない。 */
function rgb(hex: string): [number, number, number] {
  const h = hex.trim();
  expect(h, `色が 16 進で書かれていない: ${hex}`).toMatch(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);
  const full = h.length === 4 ? `#${h[1]!}${h[1]!}${h[2]!}${h[2]!}${h[3]!}${h[3]!}` : h;
  return [
    parseInt(full.slice(1, 3), 16),
    parseInt(full.slice(3, 5), 16),
    parseInt(full.slice(5, 7), 16),
  ];
}

/** WCAG の相対輝度。 */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 前景 / 背景 / 最低比 の組。⚠ **実際に画面で重なる組だけ**を並べる。 */
const PAIRS: readonly { fg: string; bg: string; min: number; what: string }[] = [
  { fg: '--fg', bg: '--surface', min: 4.5, what: '本文' },
  { fg: '--fg', bg: '--bg', min: 4.5, what: '本文(地)' },
  { fg: '--fg', bg: '--surface-2', min: 4.5, what: '本文(見出し帯)' },
  { fg: '--muted', bg: '--surface', min: 4.5, what: '補助文' },
  { fg: '--muted', bg: '--surface-2', min: 4.5, what: '補助文(見出し帯)' },
  /**
   * 🔴 **左右の列は `--bg` の地**(`app.css` の sidebar / inspector)── 補助文・緑・危険の字がそのまま載る。
   * ⚠ 質の悪い液晶向けに `--bg` を沈めたとき(2026-11-21)、この組が無かったので solarized の補助文が 4.41、
   *   github の緑・注意が 4.36 / 4.07 まで落ちても全部緑だった(着地前レビュー)。地を動かす人が気づけるようにここで持つ
   */
  { fg: '--muted', bg: '--bg', min: 4.5, what: '補助文(左右の列の地)' },
  { fg: '--ok', bg: '--bg', min: 4.5, what: '緑(左右の列の地)' },
  { fg: '--danger', bg: '--bg', min: 4, what: '危険な操作(左右の列の地)' },
  // 🔴 この対は**主のボタン**(`button[data-pkc-variant='primary']`。#1982 段 1)の字と地でもある ── 最上部の帯と同じ 4.5:1 を全テーマで課す
  { fg: '--accent-fg', bg: '--accent', min: 4.5, what: '最上部の帯・主のボタン' },
  { fg: '--accent-dim-fg', bg: '--accent-dim', min: 4.5, what: '選択中の行' },
  { fg: '--danger', bg: '--surface', min: 4, what: '危険な操作' },
  // 🔴 危険のボタン(#1982 段 1)の乗せた状態 ── 地が `--danger`、字が `--surface`(`app.css` の `button[data-pkc-variant='danger']:hover`)
  { fg: '--surface', bg: '--danger', min: 4, what: '危険のボタン(乗せたとき)' },
  /**
   * 🔴 **`--ok`(緑)**(#1457)。2 つの使い手が重なる: ① 信号機の列の見出しの丸(`schedule-board-head::before`、地は `--surface`)
   *   ② **履歴の差分の「足した行」の字**(`[data-pkc-diff='add']`、地は `--surface` / `--surface-2`)。
   * ⚠ ② はこれまで `--ok` が**どのテーマにも無く**、`var(--ok, #1a7f37)` の控えの緑(明るい地向け)が全テーマで出ていた。
   *   トークンを置いたので、暗い地でも読める緑に変わる ── だから字として読む 4.5:1 を全テーマで課す。
   */
  { fg: '--ok', bg: '--surface', min: 4.5, what: '緑(差分の足した行・信号機の緑)' },
  { fg: '--ok', bg: '--surface-2', min: 4.5, what: '緑(帯の上)' },
  { fg: '--accent', bg: '--surface', min: 3, what: 'リンク・強調' },
  /**
   * 🔴 **焦点の輪**(#1388。`outline: 2px solid var(--accent)`)が乗る地は `--surface` だけではない ──
   * 帯・ツールバー(`--surface-2`)と全体の地(`--bg`)にも輪は出る。WCAG 2.1 の
   * 非テキスト 3:1 を、輪が実際に重なる 3 つの地すべてで持つ(専用の色は持たない = 強調色と同じ)。
   */
  { fg: '--accent', bg: '--bg', min: 3, what: '焦点の輪(全体の地)' },
  { fg: '--accent', bg: '--surface-2', min: 3, what: '焦点の輪(帯・ツールバー)' },
  { fg: '--accent', bg: '--accent-dim', min: 3, what: '焦点の輪(選択中の行の上)' },
  /**
   * 🔴 **選んでいるタブの下線**(#720 ②。着地前レビュー・実装 1)。
   * ⚠ この PR が**新しく作った重なり**である ── 線は `--fg`、乗る地は
   *   タブ自身の `--accent-dim`(`app.css` の `browse-tabs [data-pkc-active]`)。
   * ⚠ **名前を pin する検査では守れない** ── `shell-a11y.test.ts` は
   *   `var(--fg)` という**綴り**しか見ないので、**名前が同じまま値が変わる**日に
   *   何も鳴らない(CLAUDE.md §1「需要の数を見て供給を見ていない」の色版)。
   * ⚠ terminal は余裕 0.59(3.59)で 9 配色(当時)中いちばん薄い ── 次にこの配色を
   *   触る人が気づけるように、ここで下限を持つ。
   */
  { fg: '--fg', bg: '--accent-dim', min: 3, what: '選んでいるタブの下線' },
  { fg: '--border', bg: '--surface', min: 1.2, what: '枠(見えること)' },
  // コードの色は `pre`(= `--surface-2`)の上に載る。**本文と同じ 4.5:1** を課す
  // ── 「色が付いていれば読める」ではない(solarized の公式 green は 2.6:1)
  { fg: '--code-key', bg: '--surface-2', min: 4.5, what: 'コードの予約語' },
  { fg: '--code-lit', bg: '--surface-2', min: 4.5, what: 'コードの値' },
];

describe('配色トークン', () => {
  it('🔴 全テーマが**同じトークン一式**を定義している', () => {
    const base = Object.keys(tokensOf('light')).filter((k) => k.startsWith('--'));
    // 空振り防止: 色トークンが実在すること(規則ごと消えても気づく)
    expect(base.length).toBeGreaterThan(8);
    for (const t of THEMES) {
      const got = Object.keys(tokensOf(t.id));
      expect(
        base.filter((k) => !got.includes(k)),
        `${t.id} に足りないトークン`,
      ).toEqual([]);
    }
  });

  it.each(THEMES.map((t) => t.id))('🔴 %s が読める(コントラスト比)', (theme) => {
    const tok = tokensOf(theme);
    for (const { fg, bg, min, what } of PAIRS) {
      const f = tok[fg];
      const b = tok[bg];
      expect(f, `${theme}: ${fg} が無い`).toBeTruthy();
      expect(b, `${theme}: ${bg} が無い`).toBeTruthy();
      const ratio = contrast(f!, b!);
      expect(
        ratio,
        `${theme} の「${what}」が読めない: ${fg}(${f!}) on ${bg}(${b!}) = ${ratio.toFixed(2)}:1(要 ${min}:1)`,
      ).toBeGreaterThanOrEqual(min);
    }
  });

  /**
   * 🔴 **履歴の差分の「字単位の強調」**(`mark[data-pkc-diff-char]`)。字は本文の色(`--fg`)、
   * 地は行の色(`--ok` / `--danger`)の 24% を表の地に重ねた物(`color-mix(in oklab, <色> 30%, transparent)` = 透明度 0.3 の同じ色 → sRGB の混ぜ合わせ)。
   * ⚠ 字を行の色(`inherit`)のままにすると、同じ色の下地に載って全テーマで 3:1 前後まで落ちた ── 字を `--fg` にして 4.5:1 を課す(大きな字ではない)。
   * ⚠ 字の色と割合は app.css から読む(`--fg` / 24 を写さない)── 変えると、ここが鳴る。
   */
  it.each(THEMES.map((t) => t.id))('🔴 %s の差分の字単位の強調(足した / 消した)が読める(4.5:1)', (theme) => {
    const tok = tokensOf(theme);
    const app = readFileSync(new URL('../../src/styles/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [kind, token] of [['add', '--ok'], ['del', '--danger']] as const) {
      const rule = app.match(new RegExp(`mark\\[data-pkc-diff-char='${kind}'\\]\\s*\\{[^}]*color-mix\\(in oklab,\\s*var\\(${token}[^)]*\\)\\s*(\\d+)%`));
      expect(rule, `${kind}: 強調の地の規則が読めない`).not.toBeNull();
      const a = Number(rule![1]) / 100;
      expect(a).toBeGreaterThan(0);
      const base = app.match(/mark\[data-pkc-diff-char\]\s*\{[^}]*?color:\s*var\((--[\w-]+)\)/);
      expect(base, '強調の字の色(var(--…))が読めない').not.toBeNull();
      const textTok = base![1]!;
      const fg = rgb(tok[token]!);
      for (const bgName of ['--surface', '--surface-2']) {
        const bg = rgb(tok[bgName]!);
        const mixed = '#' + fg.map((v, i) => Math.round(v * a + bg[i]! * (1 - a)).toString(16).padStart(2, '0')).join('');
        const ratio = contrast(tok[textTok]!, mixed);
        expect(
          ratio,
          `${theme}: 差分の強調(${kind})の字 ${textTok}(${tok[textTok]!}) on ${bgName} への ${token} ${a * 100}% 混ぜ(${mixed}) = ${ratio.toFixed(2)}:1(要 4.5:1)`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  /**
   * 🔴 **予定の左の縦線の色**(#855 20-A)── `--note-1` 〜 `--note-8` が、全テーマで地に対して見えること。
   * 明るい地と暗い地で同じ色は使えない(両立する色が無い)ので、テーマごとに明暗の組を持つ。
   * 縦線は UI 部品なので 3:1(WCAG の非文字)。
   */
  it.each(THEMES.map((t) => t.id))('🔴 %s の予定の縦線の色 8 つが、地の上で見える(3:1)', (theme) => {
    const tok = tokensOf(theme);
    for (let n = 1; n <= 8; n++) {
      const c = tok[`--note-${n}`];
      expect(c, `${theme}: --note-${n} が無い`).toBeTruthy();
      for (const bg of ['--surface', '--surface-2']) {
        const ratio = contrast(c!, tok[bg]!);
        expect(
          ratio,
          `${theme}: --note-${n}(${c!}) on ${bg}(${tok[bg]!}) = ${ratio.toFixed(2)}:1(要 3:1)`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  /**
   * 🔴 **字のあるボタンの静止の地**(#1982 ①。「Markdown をコピー」が字と見分けられなかった不具合)。
   * 地は `--fg` を `button` の規則が決める割合で透かした無彩色、縁は `--hairline`(縁は地の上に重なる)。
   * ⚠ 割合は app.css / tokens.css から読む(ここへ数字を写さない)。
   * 観測点は 2 つ: ① 字と地(静止 / 乗せた)が 4.5:1 ② **地と縁が、周りの地から見分けられる**
   *   (地 1.10:1 以上 / 縁を重ねた色 1.20:1 以上 ── 12 配色 × 3 つの地の実測の最小は 1.107 / 1.214)。
   *   ③ 乗せた地は静止の地より濃い(段が付く)。
   */
  it.each(THEMES.map((t) => t.id))('🔴 %s の字のあるボタンは、静止の地で読めて周りから見分けられる', (theme) => {
    const tok = tokensOf(theme);
    const app = readFileSync(new URL('../../src/styles/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const base = /\nbutton \{[^}]*?background:\s*color-mix\(in srgb,\s*var\(--fg\)\s*(\d+)%,\s*transparent\)/.exec(app);
    const hover = /\nbutton:hover:not\(:disabled\) \{[^}]*?background:\s*color-mix\(in srgb,\s*var\(--fg\)\s*(\d+)%,\s*transparent\)/.exec(app);
    const hair = /--hairline:\s*color-mix\(in srgb,\s*var\(--fg\)\s*(\d+)%,\s*transparent\)/.exec(css);
    expect(base, '静止の地の規則が読めない').not.toBeNull();
    expect(hover, '乗せた地の規則が読めない').not.toBeNull();
    expect(hair, '--hairline が読めない').not.toBeNull();
    const [aRest, aHover, aEdge] = [base![1]!, hover![1]!, hair![1]!].map((v) => Number(v) / 100) as [number, number, number];
    expect(aRest, '静止の地が無い(透明のまま)').toBeGreaterThan(0.03);
    expect(aHover).toBeGreaterThan(aRest);
    const mix = (f: [number, number, number], a: number, b: [number, number, number]): [number, number, number] =>
      [0, 1, 2].map((i) => f[i]! * a + b[i]! * (1 - a)) as [number, number, number];
    const hex = (c: [number, number, number]): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    const fg = rgb(tok['--fg']!);
    // ボタンが載る地: 本文の紙 / 帯・見出しの地 / 左右の列の地
    for (const surround of ['--surface', '--surface-2', '--bg']) {
      const sc = rgb(tok[surround]!);
      const rest = mix(fg, aRest, sc);
      const hov = mix(fg, aHover, sc);
      const edge = mix(fg, aEdge, rest);
      const where = `${theme}: ${surround}(${tok[surround]!})`;
      expect(contrast(tok['--fg']!, hex(rest)), `${where} 静止の地の上の字`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tok['--fg']!, hex(hov)), `${where} 乗せた地の上の字`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(rest), tok[surround]!), `${where} 静止の地が周りから見分けられない`).toBeGreaterThanOrEqual(1.1);
      expect(contrast(hex(edge), tok[surround]!), `${where} 縁が周りから見分けられない`).toBeGreaterThanOrEqual(1.2);
      // 🔴 乗せた地は静止の地から**はっきり**段が付く(12 配色 × 3 つの地の実測の最小は 1.111。割合を 7% へ下げると 1.03 前後で落ちる)
      expect(contrast(hex(hov), hex(rest)), `${where} 乗せた地が静止の地と見分けにくい`).toBeGreaterThanOrEqual(1.08);
    }
  });

  it('🔴 明暗の宣言が実際の明るさと合っている', () => {
    // ⚠ `color-scheme` を取り違えると、スクロールバーや既定の入力欄だけが
    // 逆の明るさで出る(部分的にちぐはぐになる)
    for (const t of THEMES) {
      const l = luminance(tokensOf(t.id)['--surface']!);
      expect(t.dark ? l < 0.25 : l > 0.5, `${t.id} の dark 宣言が実際と逆`).toBe(true);
    }
  });
});

/**
 * 🔴 **ログの見た目の 3 段**(#2018 8。user 裁定 2026-11-22「全 12 テーマのコントラスト検算 ── 時刻 `--muted` 4.5:1・縦線 3:1」)。
 * 使う組は 4 つだけ(`app.css` の `@media screen` の節。`log-visual.test.ts` が「この 4 つしか使っていない」を見る):
 * - 日の行の字 `--fg` × 段差の地 `--surface-2`(文字 4.5:1)
 * - 時刻の字 `--muted` × 本文の地 `--surface` / `--bg`(文字 4.5:1)
 * - 縦線 `--muted` × 本文の地 `--surface` / `--bg`(部品 3:1)
 */
describe('ログの見た目の 3 段(#2018 8)── 12 テーマ', () => {
  it('前提: テーマは 12 個', () => {
    expect(THEMES).toHaveLength(12);
  });
  it.each(THEMES.map((t) => t.id))('🔴 %s: 日の行・時刻の字・縦線が読める', (theme) => {
    const own = tokensOf(theme);
    const base = tokensOf('light');
    const v = (n: string): string => own[n] ?? base[n]!;
    expect(contrast(v('--fg'), v('--surface-2')), '日の行の字').toBeGreaterThanOrEqual(4.5);
    expect(contrast(v('--muted'), v('--surface-2')), '畳んだ日の行の字').toBeGreaterThanOrEqual(4.5);
    for (const bg of ['--surface', '--bg']) {
      expect(contrast(v('--muted'), v(bg)), `時刻の字(${bg})`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v('--muted'), v(bg)), `縦線(${bg})`).toBeGreaterThanOrEqual(3);
    }
  });
});
