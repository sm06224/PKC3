/** @vitest-environment happy-dom */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { installRootScrollGuard } from '@adapter/ui/render/root-scroll-guard';
import { buildShell, showRootText } from '@adapter/ui/render/shell';

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function shellDoc(layout?: 'phone' | 'tablet'): void {
  document.body.innerHTML = '<div data-pkc-region="shell"></div>';
  if (layout) document.querySelector('[data-pkc-region="shell"]')!.setAttribute('data-pkc-layout', layout);
  document.documentElement.setAttribute('data-pkc-shell', '');
}

function scrollRootTo(top: number, left = 0): Element {
  const root = document.scrollingElement!;
  root.scrollTop = top;
  root.scrollLeft = left;
  window.dispatchEvent(new Event('scroll'));
  return root;
}

describe('🔴 文書ルートを 0 の位置から動かさない(画面全体が下へスクロールする不具合)', () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-pkc-shell');
    document.documentElement.scrollTop = 0;
    document.documentElement.scrollLeft = 0;
  });

  it('shell の印がある画面で、ルートが縦にも横にも動いたら 0 へ戻す', () => {
    shellDoc();
    off = installRootScrollGuard(window);
    const root = scrollRootTo(150, 40);
    expect(root.scrollTop).toBe(0);
    expect(root.scrollLeft).toBe(0);
  });

  it('shell の要素があっても、html の印が無い文書では触らない(印で判定する)', () => {
    document.body.innerHTML = '<div data-pkc-region="shell"></div>';
    off = installRootScrollGuard(window);
    expect(scrollRootTo(150).scrollTop).toBe(150);
  });

  it('印刷中は戻さない(紙は全部刷る)', () => {
    shellDoc();
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: q === 'print', media: q }) as unknown as MediaQueryList,
    );
    off = installRootScrollGuard(window);
    expect(scrollRootTo(150).scrollTop).toBe(150);
  });

  it('スマホ・タブレットの版面では戻さない(ソフトキーボードがルートを動かす)', () => {
    for (const layout of ['phone', 'tablet'] as const) {
      shellDoc(layout);
      off = installRootScrollGuard(window);
      expect(scrollRootTo(150).scrollTop, layout).toBe(150);
      off();
      off = null;
      document.documentElement.scrollTop = 0;
    }
  });

  it('外したら戻さない(片付けの口が効く)', () => {
    shellDoc();
    installRootScrollGuard(window)();
    expect(scrollRootTo(150).scrollTop).toBe(150);
  });

  it('🔴 buildShell が html に印を立て、showRootText(起動失敗の字の画面)が外す', () => {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    expect(document.documentElement.hasAttribute('data-pkc-shell')).toBe(true);
    showRootText(root, '起動に失敗しました');
    expect(document.documentElement.hasAttribute('data-pkc-shell')).toBe(false);
  });

  it('🔴 main.ts が boot の ready の直後に付けている(配線)', () => {
    const main = stripComments(readFileSync('src/main.ts', 'utf-8'));
    expect(main).toMatch(/import \{ installRootScrollGuard \} from '@adapter\/ui\/render\/root-scroll-guard'/);
    // ⚠ 呼ばれない場所へ移しても通らないよう、boot の印を立てる行と booted() の間にあることを見る
    const ready = main.indexOf("root.setAttribute('data-pkc-boot', 'ready');");
    const booted = main.indexOf('preboot?.booted();', ready);
    expect(ready, 'boot の印の行が引けない(空振り)').toBeGreaterThan(0);
    expect(booted).toBeGreaterThan(ready);
    expect(main.slice(ready, booted)).toContain('installRootScrollGuard(window);');
  });

  it('🔴 測るための見えない箱は fixed(文書のスクロール範囲に入れない)── 影の箱と図案の書き出しの両方', () => {
    const line = stripComments(readFileSync('src/adapter/ui/render/current-line.ts', 'utf-8'));
    expect(line).toMatch(/'position:fixed;visibility:hidden;pointer-events:none;top:0;left:-9999px;/);
    const icon = stripComments(readFileSync('src/adapter/platform/export/icon-raster.ts', 'utf-8'));
    expect(icon).toContain("'position:fixed;visibility:hidden;pointer-events:none'");
    for (const src of [line, icon]) expect(src).not.toMatch(/position:absolute;visibility:hidden/);
  });

  it('🔴 CSS: shell の本文の行は minmax(0, 1fr) / 画面では html[data-pkc-shell] の overflow を hidden(:has は使わない)', () => {
    const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));
    const shell = /\[data-pkc-region='shell'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(shell, 'shell の規則が引けない(空振り)').toContain('grid-template-areas');
    expect(shell).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media screen\s*\{\s*html\[data-pkc-shell\]\s*\{\s*overflow: hidden;/);
    // 🔴 #1467 段 3-h: root より上を :has() の主語にしない
    expect(css).not.toMatch(/html:has\(/);
    // 🔴 body には付けない(body がスクロールする箱になり、scrollIntoView で shell ごと持ち上がる)
    expect(css).not.toMatch(/>\s*body\s*\{[^}]*overflow:\s*hidden/);
  });
});
