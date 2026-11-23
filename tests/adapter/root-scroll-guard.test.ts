/** @vitest-environment happy-dom */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { installRootScrollGuard } from '@adapter/ui/render/root-scroll-guard';

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('🔴 文書ルートを 0 の位置から動かさない(画面全体が下へスクロールする不具合)', () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
    document.body.innerHTML = '';
    document.documentElement.scrollTop = 0;
  });

  it('shell がある画面で、ルートが動いたら 0 へ戻す', () => {
    document.body.innerHTML = '<div data-pkc-region="shell"></div>';
    off = installRootScrollGuard(window);
    const root = document.scrollingElement!;
    root.scrollTop = 150;
    window.dispatchEvent(new Event('scroll'));
    expect(root.scrollTop).toBe(0);
  });

  it('shell が無い文書(別の文書)では触らない', () => {
    off = installRootScrollGuard(window);
    const root = document.scrollingElement!;
    root.scrollTop = 150;
    window.dispatchEvent(new Event('scroll'));
    expect(root.scrollTop).toBe(150);
  });

  it('外したら戻さない(片付けの口が効く)', () => {
    document.body.innerHTML = '<div data-pkc-region="shell"></div>';
    installRootScrollGuard(window)();
    const root = document.scrollingElement!;
    root.scrollTop = 150;
    window.dispatchEvent(new Event('scroll'));
    expect(root.scrollTop).toBe(150);
  });

  it('🔴 main.ts が boot で付けている(配線)', () => {
    const main = stripComments(readFileSync('src/main.ts', 'utf-8'));
    expect(main).toMatch(/import \{ installRootScrollGuard \} from '@adapter\/ui\/render\/root-scroll-guard'/);
    expect(main).toMatch(/installRootScrollGuard\(window\);/);
  });

  it('🔴 測るための見えない影の箱は fixed(文書のスクロール範囲に入れない)', () => {
    const src = stripComments(readFileSync('src/adapter/ui/render/current-line.ts', 'utf-8'));
    expect(src).toMatch(/'position:fixed;visibility:hidden;pointer-events:none;top:0;left:-9999px;/);
    expect(src).not.toMatch(/position:absolute;visibility:hidden/);
  });

  it('🔴 CSS: shell の本文の行は minmax(0, 1fr) / アプリの画面ではルートの overflow を hidden', () => {
    const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));
    const shell = /\[data-pkc-region='shell'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(shell, 'shell の規則が引けない(空振り)').toContain('grid-template-areas');
    expect(shell).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media screen\s*\{\s*html:has\(\[data-pkc-region='shell'\]\)\s*\{\s*overflow: hidden;/);
    // 🔴 body には付けない(body がスクロールする箱になり、scrollIntoView で shell ごと持ち上がる)
    expect(css).not.toMatch(/>\s*body\s*\{[^}]*overflow:\s*hidden/);
  });
});
