/**
 * 🔴 **浮く物の開く動き・ダイアログの暗幕**(#1982 段 6)。
 *
 * 守る主張:
 * 1. 右クリックのメニュー・補完の小窓・目次の小窓・トースト・ダイアログ・ダイアログの暗幕は、
 *    開くとき `pkc-pop-in` / `pkc-fade-in` を `--dur*` / `--ease` で動かす(素の ms を書かない)。
 * 2. 動きは `opacity` / `transform` だけ(`@keyframes` が幅・高さ・位置を動かさない)。
 * 3. reduced-motion では動きのトークンが 0 になり、全要素の animation も止まる。
 * 4. ダイアログの暗幕は各テーマの `--scrim` で塗る(12 テーマ全部が持つ)。`backdrop-filter` は掛けない。
 * 5. 閉じる側の動きを持たない = 閉じかけの物が操作を受けたり焦点を持ったりしない。
 * ⚠ コメントは剥がして読む(注記の字で緑にならない)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { atBlock, blocksFor, mediaBlock, stripComments } from '../helpers/css-blocks';

const APP = stripComments(readFileSync('src/styles/app.css', 'utf-8'));
const TOKENS = stripComments(readFileSync('src/styles/tokens.css', 'utf-8'));

const bodyOf = (sel: string): string => {
  const hits = blocksFor(APP, sel);
  expect(hits.length, `${sel} の規則が無い`).toBeGreaterThan(0);
  return hits.join('\n');
};

const POP = /animation:\s*pkc-pop-in var\(--dur-fast\) var\(--ease\)/;
const POPS = /animation:\s*pkc-pop-in var\(--dur\) var\(--ease\)/;
const FADE = /animation:\s*pkc-fade-in var\(--dur\) var\(--ease\)/;
const POPUPS: Array<[string, RegExp]> = [
  ["[data-pkc-region='context-menu']", POP],
  ["[data-pkc-region='inline-complete']", POP],
  ['.pkc-quick-toc-popover', POP],
  ["[data-pkc-region='paste-toast']", POPS],
  ["[data-pkc-region='app-dialog'][open]", POPS],
  ["[data-pkc-region='app-dialog']::backdrop", FADE],
  ['.pkc-lightbox-backdrop', FADE],
];

describe('🔴 浮く物の開く動き(#1982 段 6)', () => {
  for (const [sel, re] of POPUPS) {
    it(`${sel} はトークンの時間・曲線で開く`, () => {
      expect(bodyOf(sel)).toMatch(re);
    });
  }

  it('@keyframes は opacity / transform だけを動かす(レイアウトを動かさない)', () => {
    for (const name of ['pkc-pop-in', 'pkc-fade-in']) {
      const { body } = atBlock(APP, `@keyframes ${name}`);
      expect(body.length, `${name} が無い`).toBeGreaterThan(10);
      const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]!);
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) expect(['opacity', 'transform'], `${name} が ${p} を動かす`).toContain(p);
    }
    expect(atBlock(APP, '@keyframes pkc-pop-in').body).toMatch(/translateY\(-4px\)/);
  });

  it('動きの規則に素の時間(ms / s)を書かない', () => {
    for (const [sel] of POPUPS) {
      expect(bodyOf(sel).match(/animation:[^;]*\b\d+(\.\d+)?m?s\b/), `${sel} に素の時間`).toBeNull();
    }
  });

  it('閉じる側の動きは持たない(ダイアログに transition / :not([open]) の動きが無い)', () => {
    expect(APP).not.toMatch(/app-dialog'\]:not\(\[open\]\)[^{]*\{[^}]*(animation|transition)/);
    expect(bodyOf("[data-pkc-region='app-dialog']")).not.toMatch(/transition:/);
  });

  it('reduced-motion では動きのトークンが 0 で、全要素の animation も止まる', () => {
    const { body } = mediaBlock(APP, '(prefers-reduced-motion: reduce)');
    expect(body).toMatch(/--dur-fast:\s*0ms/);
    expect(body).toMatch(/--dur:\s*0ms/);
    expect(body).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });
});

describe('🔴 ダイアログの暗幕(#1982 段 6)', () => {
  it('暗幕は --scrim で塗る(素の rgb ではない)・ぼかしは掛けない', () => {
    const b = bodyOf("[data-pkc-region='app-dialog']::backdrop");
    expect(b).toMatch(/background:\s*var\(--scrim\)/);
    expect(b).not.toMatch(/backdrop-filter/);
  });

  it('--scrim は 12 テーマ全部が持ち、暗いテーマほど濃い', () => {
    const themes = [...TOKENS.matchAll(/:root\[data-pkc-theme='([\w-]+)'\]\s*\{([^}]*)\}/g)];
    expect(themes.length).toBe(12);
    const light: number[] = [];
    const dark: number[] = [];
    for (const [, name, body] of themes) {
      const m = body!.match(/--scrim:\s*rgb\([\d ]+\/\s*(\d+)%\)/);
      expect(m, `${name} に --scrim が無い`).not.toBeNull();
      const lg = Number(body!.match(/--shadow-lg:[^;]*\/ (\d+)%\)/)![1]);
      (lg >= 50 ? dark : light).push(Number(m![1]));
    }
    expect(light.length).toBeGreaterThan(0);
    expect(dark.length).toBeGreaterThan(0);
    expect(Math.min(...dark)).toBeGreaterThan(Math.max(...light));
    // ⚠ 大小だけだと「明るい側 0%(暗幕が消える)/ 暗い側 100%(真っ黒)」が通る ── 範囲も pin する(着地前レビュー)
    for (const v of light) {
      expect(v, '明るいテーマの暗幕の濃さ').toBeGreaterThanOrEqual(20);
      expect(v, '明るいテーマの暗幕の濃さ').toBeLessThanOrEqual(45);
    }
    for (const v of dark) {
      expect(v, '暗いテーマの暗幕の濃さ').toBeGreaterThanOrEqual(45);
      expect(v, '暗いテーマの暗幕の濃さ').toBeLessThanOrEqual(70);
    }
  });
});
