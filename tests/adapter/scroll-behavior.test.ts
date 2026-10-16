/** @vitest-environment happy-dom */
/**
 * 滑らかなスクロールは、OS の「視差効果を減らす」を出している人には使わない。
 * 守る主張: ①判定の関数 ②使う場所(ヘルプ / 先頭へ戻る)がその関数を通る ③CSS の受け皿
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { preferredScrollBehavior } from '../../src/adapter/ui/render/scroll-behavior';
import { installBackToTop } from '../../src/adapter/ui/render/back-to-top';

function stubReduce(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: reduce && q.includes('prefers-reduced-motion: reduce'),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preferredScrollBehavior', () => {
  it('視差効果を減らす設定なら auto、そうでなければ smooth', () => {
    stubReduce(true);
    expect(preferredScrollBehavior()).toBe('auto');
    stubReduce(false);
    expect(preferredScrollBehavior()).toBe('smooth');
  });
  it('matchMedia が無い環境では smooth', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(preferredScrollBehavior()).toBe('smooth');
  });
});

describe('使う場所', () => {
  it('先頭へ戻るボタンは、視差効果を減らす設定のとき auto で動かす', () => {
    stubReduce(true);
    const scroller = document.createElement('div');
    const container = document.createElement('div');
    document.body.append(scroller, container);
    const handle = installBackToTop(scroller, container);
    const spy = vi.fn();
    scroller.scrollTo = spy;
    container
      .querySelector('.pkc-back-to-top')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(spy).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
    handle.dispose();
  });
  it('ヘルプと先頭へ戻るに、直書きの smooth が残っていない(判定の関数を通る)', () => {
    for (const f of ['help.ts', 'back-to-top.ts']) {
      const src = readFileSync(`src/adapter/ui/render/${f}`, 'utf8');
      expect(src, f).not.toMatch(/behavior:\s*'smooth'|\?\?\s*'smooth'/);
      expect(src, f).toContain('preferredScrollBehavior()');
    }
  });
  it('CSS に視差効果を減らす設定の受け皿が在る', () => {
    const css = readFileSync('src/styles/app.css', 'utf8');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*scroll-behavior: auto !important/,
    );
  });
});
