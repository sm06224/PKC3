/** @vitest-environment happy-dom */
/**
 * P8 段⑬: **図の色が配色に従う**。
 *
 * 🔴 直す前に測った(preview ビルドで実際に焼いた PNG の平均輝度):
 * ```
 * light      平均輝度 231.1
 * dark       平均輝度 231.1   ← 同じ
 * dracula    平均輝度 231.1   ← 同じ
 * nord       平均輝度 231.1   ← 同じ
 * terminal   平均輝度 231.1   ← 同じ
 * ```
 * 鍵(`cacheKey`)にはテーマが入っていたので**焼き直しは走っていた**。
 * 走った先の `mermaid.initialize()` に `theme` を渡していなかったので、
 * **焼き上がる絵が全部同じ**だった ── 「キャッシュは効いている」ように見えて、
 * ダーク系 5 テーマで図だけ白い、という壊れ方をしていた。
 *
 * ⚠ ここで見るのは**設定の中身**(mermaid に渡る当のもの)。実際の画素は
 * `tests/smoke/mermaid.smoke.spec.ts` が見る ── 「下流の結果だけを見る test は
 * 別経路に救われる」の逆で、**両端**に観測点を置く。
 */
import { describe, expect, it } from 'vitest';
import {
  configFor,
  isDarkColor,
  readPalette,
  type DiagramPalette,
} from '../../src/adapter/ui/render/mermaid-raster';

const DARK: DiagramPalette = {
  bg: '#14171a',
  alt: '#23282d',
  fg: '#e3e7eb',
  line: '#9aa4af',
  border: '#333a41',
  accent: '#2f8f5b',
  dark: true,
};

describe('地が暗いかの判定', () => {
  it('🔴 テーマ名ではなく**色の明るさ**で決める(新しい配色にも効く)', () => {
    expect(isDarkColor('#14171a')).toBe(true); // dark
    expect(isDarkColor('#282a36')).toBe(true); // dracula
    expect(isDarkColor('#3b4252')).toBe(true); // nord
    expect(isDarkColor('#0d0f0a')).toBe(true); // terminal
    expect(isDarkColor('#ffffff')).toBe(false); // light
    expect(isDarkColor('#fdf6e3')).toBe(false); // solarized
  });

  it('短い hex と rgb() も読む', () => {
    expect(isDarkColor('#000')).toBe(true);
    expect(isDarkColor('#fff')).toBe(false);
    expect(isDarkColor('rgb(20, 23, 26)')).toBe(true);
    expect(isDarkColor('rgb(255, 255, 255)')).toBe(false);
  });

  it('⚠ 読めない値は**明るい側**に倒す(既定は light)', () => {
    expect(isDarkColor('var(--nope)')).toBe(false);
    expect(isDarkColor('')).toBe(false);
  });
});

describe('CSS 変数から配色を読む', () => {
  it('🔴 `tokens.css` の変数がそのまま図の色になる', () => {
    const el = document.createElement('div');
    el.style.setProperty('--surface', '#1c2024');
    el.style.setProperty('--surface-2', '#23282d');
    el.style.setProperty('--fg', '#e3e7eb');
    el.style.setProperty('--muted', '#9aa4af');
    el.style.setProperty('--border', '#333a41');
    el.style.setProperty('--accent', '#2f8f5b');
    document.body.append(el);

    const p = readPalette(el);
    expect(p.bg).toBe('#1c2024');
    expect(p.alt).toBe('#23282d');
    expect(p.fg).toBe('#e3e7eb');
    expect(p.line).toBe('#9aa4af');
    expect(p.border).toBe('#333a41');
    expect(p.accent).toBe('#2f8f5b');
    // 地が暗いことは**書いてもらう**のではなく、地の色から導く
    expect(p.dark).toBe(true);
    el.remove();
  });

  it('⚠ 欠けた変数は**その項目だけ**既定へ落ちる(全部戻らない)', () => {
    const el = document.createElement('div');
    el.style.setProperty('--fg', '#abcdef');
    document.body.append(el);
    const p = readPalette(el);
    expect(p.fg).toBe('#abcdef'); // 在るものは使う
    expect(p.bg).toBe('#ffffff'); // 無いものだけ既定
    el.remove();
  });
});

describe('mermaid へ渡す設定', () => {
  it('🔴 配色が **themeVariables に載る**(載らないと全テーマ同じ絵になる)', () => {
    const c = configFor(DARK) as {
      theme?: string;
      themeVariables?: Record<string, unknown>;
    };
    // 組み込みテーマ名で選ばない ── 名前の対応表は必ず古くなる
    expect(c.theme).toBe('base');
    const v = c.themeVariables ?? {};
    expect(v.textColor).toBe(DARK.fg);
    expect(v.primaryTextColor).toBe(DARK.fg);
    expect(v.mainBkg).toBe(DARK.alt);
    expect(v.lineColor).toBe(DARK.line);
    expect(v.nodeBorder).toBe(DARK.border);
    expect(v.darkMode).toBe(true);
  });

  it('🔴 配色が変われば設定も変わる(定数を返していない)', () => {
    const light: DiagramPalette = { ...DARK, fg: '#16191d', alt: '#f5f6f8', dark: false };
    const a = JSON.stringify(configFor(DARK));
    const b = JSON.stringify(configFor(light));
    expect(a).not.toBe(b);
  });

  it('⚠ canvas を汚さない設定は**残っている**(消すと書き出しが落ちる)', () => {
    // `foreignObject` を含む SVG を canvas に描くと toBlob が SecurityError で死ぬ
    const c = configFor(DARK) as { htmlLabels?: boolean; flowchart?: { htmlLabels?: boolean } };
    expect(c.htmlLabels).toBe(false);
    expect(c.flowchart?.htmlLabels).toBe(false);
  });

  /**
   * 🔴 `journey` は上の 2 行を**読まない**(#528、2026-08-28 実測)── この図だけ
   * `textPlacement` で描き分けており、既定の `'fo'` は `<foreignObject>` である。
   *
   * ⚠ これは**字面の pin なので弱い** ── 「設定が渡っているが絵は変わらない」を
   * 原理的に見られない。焼けるところまでは
   * `tests/smoke/mermaid.smoke.spec.ts` の「UML 4 種と journey」が見る。
   * ここに置くのは、**消したことに 4 秒で気づける**ようにするためである。
   */
  it('🔴 journey は textPlacement で foreignObject を避ける (#528)', () => {
    const c = configFor(DARK) as { journey?: { textPlacement?: string } };
    expect(c.journey?.textPlacement).toBe('tspan');
  });
});
