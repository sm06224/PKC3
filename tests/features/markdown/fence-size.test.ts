/**
 * 🔴 囲みの縦横の固定(`width=` / `height=`。v4.2 Phase 0 / PR-1)── 門は 1 つ(`fence-size.ts`)。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_STYLE,
  fenceFrameStyle,
  fenceSizeAttrPairs,
  fenceSizeAttrs,
  fenceSizeFromAttrs,
  parseFenceHeight,
  parseFenceSize,
  parseFenceWidth,
} from '../../../src/features/markdown/fence-size';
import { renderMarkdown } from '../../../src/features/markdown/markdown-render';

describe('parseFenceSize', () => {
  it('px・単位なし・% を読み、キーの大小・引用符を問わない', () => {
    expect(parseFenceSize('width=480 height=320')).toEqual({ width: { value: 480, unit: 'px' }, height: 320 });
    expect(parseFenceSize('WIDTH=480px Height=320px')).toEqual({ width: { value: 480, unit: 'px' }, height: 320 });
    expect(parseFenceSize('width=60%')).toEqual({ width: { value: 60, unit: '%' } });
    expect(parseFenceSize('id="tracker" width="640" asset:k')).toEqual({ width: { value: 640, unit: 'px' } });
  });

  it('範囲で丸める(px 160〜2400 / % 20〜100 / 高さ 80〜5000)', () => {
    expect(parseFenceWidth('10')).toEqual({ value: 160, unit: 'px' });
    expect(parseFenceWidth('99999')).toEqual({ value: 2400, unit: 'px' });
    expect(parseFenceWidth('5%')).toEqual({ value: 20, unit: '%' });
    expect(parseFenceWidth('150%')).toEqual({ value: 100, unit: '%' });
    expect(parseFenceHeight('10')).toBe(80);
    expect(parseFenceHeight('99999')).toBe(5000);
    expect(parseFenceHeight(240.4)).toBe(240);
  });

  it('🔴 不正な値・負数・NaN・% の高さ・注入の字は丸ごと無視する(無指定扱い)', () => {
    for (const bad of [
      'width=-480',
      'width=abc',
      'width=NaN',
      'width=480em',
      'width=480px;background:red',
      'width=1px)url(x',
      'width=0',
      'height=50%',
      'height=-1',
      'height=1e9',
      'width=',
      'width=480"onload="x',
    ]) {
      expect(parseFenceSize(bad), bad).toEqual({});
    }
    expect(parseFenceHeight('50%')).toBeUndefined();
    expect(parseFenceWidth(Number.NaN)).toBeUndefined();
    expect(parseFenceWidth(null)).toBeUndefined();
  });

  it('同じキーが 2 度あれば先の方', () => {
    expect(parseFenceSize('height=200 height=900')).toEqual({ height: 200 });
  });

  it('箱の style・属性: 無指定は今までの字そのもの', () => {
    expect(fenceFrameStyle({})).toBe('width:100%;border:0;height:0;display:block;');
    expect(fenceFrameStyle({})).toBe(DEFAULT_FRAME_STYLE);
    expect(fenceSizeAttrs({})).toBe('');
    expect(fenceSizeAttrPairs({})).toEqual([]);
    expect(fenceFrameStyle({ width: { value: 60, unit: '%' } })).toBe('width:60%;max-width:100%;border:0;height:0;display:block;');
    expect(fenceFrameStyle({ height: 320 })).toBe('width:100%;border:0;height:320px;display:block;');
  });

  it('属性から読み直すと同じ値(書く側と読む側が対称)── 壊れた属性は無視する', () => {
    const size = parseFenceSize('width=60% height=240');
    const attrs = Object.fromEntries(fenceSizeAttrPairs(size));
    expect(fenceSizeFromAttrs((n) => attrs[n] ?? null)).toEqual(size);
    expect(fenceSizeFromAttrs((n) => (n === 'data-pkc-fixed-width' ? 'calc(1px)' : null))).toEqual({});
  });
});

describe('🔴 markdown の出力', () => {
  it('無指定の ```html / ```react / ```chart の出力は、属性を足さない(今までどおり)', () => {
    const html = renderMarkdown('```html\n<p>x</p>\n```');
    expect(html).not.toContain('data-pkc-fixed-');
    expect(html).toContain('style="width:100%;border:0;height:0;display:block;"');
    expect(renderMarkdown('```react\nexport default () => null\n```')).not.toContain('data-pkc-fixed-');
    expect(renderMarkdown('```chart\n{"type":"bar","labels":["a"],"datasets":[{"data":[1]}]}\n```')).not.toContain('data-pkc-fixed-');
  });

  it('```html width= height= は箱に固定の style と属性を付ける', () => {
    const html = renderMarkdown('```html width=480 height=320\n<p>x</p>\n```');
    expect(html).toContain('style="width:480px;max-width:100%;border:0;height:320px;display:block;"');
    expect(html).toContain('data-pkc-fixed-height="320"');
  });

  it('保存つきの面(liveWidgets)のウィジェットの器・React の器・グラフの器に属性を添える', () => {
    const live = renderMarkdown('```html id="t" width=60% height=200\n<p>x</p>\n```', { liveWidgets: true });
    expect(live).toMatch(/class="pkc-widget-placeholder"[^>]*data-pkc-fixed-width="60%" data-pkc-fixed-height="200"/);
    const react = renderMarkdown('```react height=300\nexport default () => null\n```');
    expect(react).toMatch(/class="pkc-react-placeholder"[^>]*data-pkc-fixed-height="300"/);
    const chart = renderMarkdown('```chart width=640 height=300\n{"type":"bar","labels":["a"],"datasets":[{"data":[1]}]}\n```');
    expect(chart).toMatch(/class="pkc-chart-placeholder"[^>]*data-pkc-md-block-kind="chart" data-pkc-fixed-width="640px" data-pkc-fixed-height="300">/);
    const gpu = renderMarkdown('```chart live height=120\n{"type":"line","datasets":[{"data":[1,2]}]}\n```');
    expect(gpu).toMatch(/class="pkc-gpu-chart-placeholder"[^>]*data-pkc-fixed-height="120">/);
  });
});
