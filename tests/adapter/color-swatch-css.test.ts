/**
 * 🔴 **色の見本の見た目**(#1224)。
 *
 * CSS は**構文で**読む(`helpers/css-blocks.ts`)。⚠ 書き出す HTML の `<style>` に**焼かれない**
 * こと(`.pkc-md-rendered` を起点にしない)── 書き出しには見本の要素が出ないので、
 * 規則だけが載るのは無駄である。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';
import { extractBodyCss } from '../../build/body-css';

const RAW = readFileSync('src/styles/app.css', 'utf8');
const css = withoutMedia(stripComments(RAW));
const SEL = '[data-pkc-prose] .pkc-color-swatch';

describe('色の見本の見た目(#1224)', () => {
  it('🔴 色は --pkc-swatch から塗り、文字の高さに合わせた小さな四角で出る', () => {
    const blocks = blocksFor(css, SEL);
    expect(blocks.length, '見本の規則が無い(空振り)').toBe(1);
    const b = blocks[0]!;
    expect(b).toMatch(decl('background', 'var\\(--pkc-swatch, transparent\\)'));
    expect(b).toMatch(decl('display', 'inline-block'));
    expect(b).toMatch(decl('width', '0\\.9em'));
    expect(b).toMatch(decl('height', '0\\.9em'));
    // 白や黒の見本が地に溶けない縁(無彩色のトークン)
    expect(b).toMatch(decl('border', '1px solid var\\(--border\\)'));
  });

  it('🔴 押して直せる見本(role=button)だけ、ポインタが変わり、触れる・焦点が乗ると枠が出る', () => {
    const btn = "[data-pkc-prose] .pkc-color-swatch[role='button']";
    const base = blocksFor(css, btn);
    expect(base.length, '押せる見本の規則が無い(空振り)').toBe(1);
    expect(base[0]).toMatch(decl('cursor', 'pointer'));
    // 触れたときと、キーボードで焦点が乗ったときの両方に、色の情報でない枠(accent)
    const hover = blocksFor(css, `${btn}:hover`);
    const focus = blocksFor(css, `${btn}:focus-visible`);
    expect(hover.length, 'hover の規則が無い').toBe(1);
    expect(focus.length, 'focus-visible の規則が無い').toBe(1);
    expect(hover[0]).toMatch(decl('outline', '2px solid var\\(--accent\\)'));
    // 押せない見本(role なし)にはポインタを付けない ── 基本の規則は cursor を持たない
    expect(blocksFor(css, SEL)[0]).not.toMatch(/cursor/);
  });

  it('🔴 書き出しの CSS に焼かれない(`.pkc-md-rendered` 起点でない = 読む面の印だけが持つ)', () => {
    const tokens = readFileSync('src/styles/tokens.css', 'utf8');
    const baked = extractBodyCss(RAW, tokens).css;
    expect(baked.length, '空振り(書き出しの CSS が空)').toBeGreaterThan(1000);
    expect(baked, '書き出しの <style> へ焼かれている').not.toContain('pkc-color-swatch');
  });
});
