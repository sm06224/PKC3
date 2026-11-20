/**
 * 🔴 左の列の探し方のタブの切れ目(#1982 段 4)は、背景画像ではなく `::before` で描く。
 * 背景画像だと、選択中・hover のタブの `background` 一括指定が画像を消して、目印が消えた(幅は実ブラウザの
 * `layout.smoke.spec.ts` が見る。ここは規則の形をコメントを剥がした CSS で pin する)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blocksFor, stripComments } from '../helpers/css-blocks';

const css = stripComments(readFileSync('src/styles/app.css', 'utf8'));

describe('タブの切れ目の目印', () => {
  it('button + button::before が幅 1px・高さ半分の絶対配置で、基準の button は position: relative', () => {
    const before = blocksFor(css, "[data-pkc-region='browse-tabs'] button + button::before").join('\n');
    expect(before).toMatch(/content:\s*''/);
    expect(before).toMatch(/position:\s*absolute/);
    expect(before).toMatch(/width:\s*1px/);
    expect(before).toMatch(/height:\s*50%/);
    const btn = blocksFor(css, "[data-pkc-region='browse-tabs'] button").join('\n');
    expect(btn).toMatch(/position:\s*relative/);
  });

  it('button + button 本体に背景画像で描かない(地の一括指定で消える)', () => {
    const own = blocksFor(css, "[data-pkc-region='browse-tabs'] button + button").join('\n');
    expect(own).not.toMatch(/background-image/);
  });
});
