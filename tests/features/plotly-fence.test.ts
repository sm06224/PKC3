/**
 * plotly の囲み(#528 ①)── 検め方と、本文 → 器の形、書き出し(HTML / Word)で chart と同じ扱いになること。
 *
 * 守る主張:
 * 1. figure(`{data, layout}`)も、`data` の配列だけも読める。読めない物は**理由が出る**(黙って空にしない)
 * 2. 上限(系列 40 本・原文 1,000,000 字)を超えた分は落とし、`notes` で言う。`__proto__` 等の鍵は落とす
 * 3. 本文では placeholder(原文を属性に持つ)になり、SVG / canvas を本文へ置かない
 * 4. 閲覧用 HTML・Word では、chart と同じに**絵(PNG)として預かり / 焼く**(原文の字のまま出さない)
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_PLOTLY_SOURCE,
  MAX_PLOTLY_TRACES,
  parsePlotlyFence,
  plotlyAltText,
} from '../../src/features/markdown/plotly-fence';
import { RENDERABLE_FENCE_LANGS, parseRenderableFence, renderMarkdown } from '../../src/features/markdown/markdown-render';
import { bakeFigures, type FigureBakers } from '../../src/features/export/figure-bake';

const FIG = '{"data":[{"type":"bar","x":["a","b"],"y":[1,2]}],"layout":{"title":"売上"}}';

describe('plotly の囲みを検める', () => {
  it('🔴 figure({data, layout})と、data の配列だけの両方が読める', () => {
    const a = parsePlotlyFence(FIG);
    expect(a.error).toBeNull();
    expect(a.spec?.data).toHaveLength(1);
    expect(a.spec?.layout).toEqual({ title: '売上' });
    const b = parsePlotlyFence('[{"type":"scatter","y":[1,2,3]}]');
    expect(b.spec?.data).toHaveLength(1);
    expect(b.spec?.layout, 'layout が無いと {} になる').toEqual({});
  });

  it('🔴 読めない物は理由を返す(spec は null)', () => {
    for (const [src, why] of [
      ['', '空'],
      ['{', 'JSON'],
      ['"x"', '{ "data"'],
      ['{"data":[]}', '空'],
      ['{"data":[1,2]}', '{ } で囲んだ系列'],
      ['{"data":[{}],"layout":[]}', 'layout'],
    ] as const) {
      const r = parsePlotlyFence(src);
      expect(r.spec, `${src} が読めてしまう`).toBeNull();
      expect(r.error ?? '', `${src} の理由`).toContain(why);
    }
  });

  it('🔴 上限: 系列は 40 本まで(超えた分は落として notes)/ 原文は 1,000,000 字まで', () => {
    const traces = Array.from({ length: MAX_PLOTLY_TRACES + 3 }, () => ({ y: [1] }));
    const r = parsePlotlyFence(JSON.stringify({ data: traces }));
    expect(r.spec?.data).toHaveLength(MAX_PLOTLY_TRACES);
    expect(r.notes.join('')).toContain('3 本は描いていません');
    // 対照群: ちょうど上限なら notes は空
    expect(parsePlotlyFence(JSON.stringify({ data: traces.slice(0, MAX_PLOTLY_TRACES) })).notes).toEqual([]);
    const big = parsePlotlyFence(`{"data":[{"text":"${'x'.repeat(MAX_PLOTLY_SOURCE)}"}]}`);
    expect(big.spec).toBeNull();
    expect(big.error).toContain('大きすぎ');
  });

  it('🔴 `__proto__` / `constructor` / `prototype` の鍵は読むときに落とす', () => {
    const r = parsePlotlyFence('{"data":[{"y":[1],"__proto__":{"x":1},"constructor":{"y":2},"ok":1}]}');
    const t = r.spec!.data[0]!;
    expect(Object.keys(t).sort()).toEqual(['ok', 'y']);
    expect(Object.getPrototypeOf(t)).toBe(Object.prototype);
  });

  it('config / frames は絵に効かないので読み捨て、notes で言う', () => {
    const r = parsePlotlyFence('{"data":[{"y":[1]}],"config":{"displayModeBar":false}}');
    expect(r.spec).not.toBeNull();
    expect(r.notes.join('')).toContain('config と frames');
  });

  it('読み上げ用の文: 題名・系列の数・種類の名前が入る(絵しか無い面で唯一の情報)', () => {
    const alt = plotlyAltText(parsePlotlyFence('{"data":[{"type":"bar"},{"type":"scatter"},{"type":"bar"}],"layout":{"title":{"text":"月別"}}}').spec!);
    expect(alt).toContain('月別');
    expect(alt).toContain('3 系列');
    expect(alt).toContain('棒グラフ');
    expect(alt).toContain('散布図');
  });
});

describe('本文での姿(features 層)', () => {
  const FENCE = `\`\`\`plotly\n${FIG}\n\`\`\`\n`;

  it('🔴 描ける fence の一覧に居る / 末尾の -norender 等も受ける', () => {
    expect(RENDERABLE_FENCE_LANGS.has('plotly')).toBe(true);
    expect(parseRenderableFence('plotly-norender')?.lang).toBe('plotly');
    expect(parseRenderableFence('plotly-norender')?.mode).toBe('norender');
  });

  it('🔴 placeholder になり、原文が属性に残る。SVG / canvas は本文へ置かない', () => {
    const html = renderMarkdown(FENCE);
    expect(html).toContain('pkc-plotly-placeholder');
    expect(html).toContain('data-pkc-plotly-src');
    expect(html).toContain('pkc-plotly-source');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<canvas');
  });

  it('-norender では原文だけ(描画の経路に入らない)', () => {
    const html = renderMarkdown(FENCE.replace('```plotly', '```plotly-norender'));
    expect(html).not.toContain('pkc-plotly-placeholder');
    expect(html).toContain('language-plotly');
  });
});

describe('書き出しで chart と同じ扱い', () => {
  const html = renderMarkdown(`\`\`\`plotly\n${FIG}\n\`\`\`\n`);

  it('🔴 絵に焼かれ(PNG)、器の属性は外れる ── 産出器には kind=plotly で頼む', async () => {
    const calls: string[] = [];
    const bakers: FigureBakers = {
      vector: async (kind) => {
        calls.push(`vector:${kind}`);
        return null;
      },
      raster: async (kind) => {
        calls.push(`raster:${kind}`);
        return { blob: new Blob([new Uint8Array([137, 80, 78, 71])]), cssWidth: 100 };
      },
    };
    const out = await bakeFigures(html, bakers, new Map());
    expect(out).toContain('<img alt="グラフ" src="data:image/png;base64,');
    expect(out).not.toContain('data-pkc-plotly-src');
    expect(out).toContain('data-pkc-figure-src');
    expect(calls, 'plotly は mermaid ではないので vector を試さない').not.toContain('vector:plotly');
    expect(calls).toContain('raster:plotly');
  });

  it('描けなかったときは器のまま(黙って消さない)', async () => {
    const out = await bakeFigures(html, { vector: async () => null, raster: async () => null }, new Map());
    expect(out).toContain('data-pkc-plotly-src');
  });
});
