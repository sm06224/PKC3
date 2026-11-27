/**
 * 🔴 GPU で直接描くグラフ(v4.1 PR-7、#2095)の仕様 ── 振り分け・allowlist・上限・CSV。
 */
import { describe, expect, it } from 'vitest';
import {
  GPU_CHART_MAX_DATASETS,
  GPU_CHART_MAX_HEATMAP_CELLS,
  GPU_CHART_MAX_POINTS,
  fenceAsksGpu,
  gpuChartPointCount,
  parseGpuChartCsv,
  parseGpuChartSpec,
  shouldUseGpuChart,
  splitCsvLine,
  type GpuChartSpec,
} from '../../src/features/chart/gpu-chart-spec';
import { MAX_POINTS } from '../../src/features/markdown/chart-fence';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const lineSrc = (n: number): string =>
  JSON.stringify({ type: 'line', datasets: [{ label: 'a', data: Array.from({ length: n }, (_, i) => i % 7) }] });

function ok(src: string): GpuChartSpec {
  const r = parseGpuChartSpec(src);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

describe('shouldUseGpuChart ── 静的 chart との線引き', () => {
  it('2,000 点以下の通常の chart は偽(今までの PNG のまま)', () => {
    expect(MAX_POINTS).toBe(2000);
    expect(shouldUseGpuChart('', lineSrc(MAX_POINTS))).toBe(false);
    expect(shouldUseGpuChart('', '{"type":"bar","labels":["a"],"datasets":[{"label":"x","data":[1]}]}')).toBe(false);
    expect(shouldUseGpuChart('', '{"type":"pie","datasets":[{"data":[1,2]}]}')).toBe(false);
  });
  it('2,001 点で真(line / scatter / bar)', () => {
    expect(shouldUseGpuChart('', lineSrc(MAX_POINTS + 1))).toBe(true);
    const sc = JSON.stringify({ type: 'scatter', datasets: [{ points: Array.from({ length: 2001 }, (_, i) => ({ x: i, y: i })) }] });
    expect(shouldUseGpuChart('', sc)).toBe(true);
    // ⚠ pie は点の数で振り分けない(GPU では描けない形)
    const pie = JSON.stringify({ type: 'pie', datasets: [{ data: Array.from({ length: 2001 }, () => 1) }] });
    expect(shouldUseGpuChart('', pie)).toBe(false);
  });
  it('見出しの live / gpu・interactive・engine・heatmap・asset: で真', () => {
    expect(shouldUseGpuChart('live', '{}')).toBe(true);
    expect(shouldUseGpuChart('GPU', '{}')).toBe(true);
    expect(shouldUseGpuChart('', '{"type":"line","interactive":true,"datasets":[]}')).toBe(true);
    expect(shouldUseGpuChart('', '{"type":"line","engine":"gpu","datasets":[]}')).toBe(true);
    expect(shouldUseGpuChart('', '{"type":"heatmap","matrix":[[1]]}')).toBe(true);
    expect(shouldUseGpuChart('', '{"type":"line","source":"asset:k1"}')).toBe(true);
  });
  it('印が文字列の中にあるだけなら偽(JSON を読んで判定する)', () => {
    expect(shouldUseGpuChart('', '{"type":"bar","title":"\\"type\\": \\"heatmap\\"","datasets":[{"data":[1]}]}')).toBe(false);
    expect(shouldUseGpuChart('', '{"type":"bar","interactive":false,"datasets":[{"data":[1]}]}')).toBe(false);
    expect(shouldUseGpuChart('', 'not json')).toBe(false);
  });
  it('fenceAsksGpu はトークン単位(livex は偽)', () => {
    expect(fenceAsksGpu('noheader live')).toBe(true);
    expect(fenceAsksGpu('livex')).toBe(false);
  });
});

describe('markdown の器', () => {
  it('静的 chart は今までどおり data-pkc-chart-src、GPU は data-pkc-gpu-chart-src', () => {
    const plain = renderMarkdown('```chart\n{"type":"bar","labels":["a"],"datasets":[{"label":"x","data":[1]}]}\n```\n');
    expect(plain).toContain('class="pkc-chart-placeholder" data-pkc-chart-src=');
    expect(plain).not.toContain('data-pkc-gpu-chart-src');
    const live = renderMarkdown('```chart live\n{"type":"line","datasets":[{"label":"x","data":[1,2]}]}\n```\n');
    expect(live).toContain('class="pkc-gpu-chart-placeholder" data-pkc-gpu-chart-src=');
    expect(live).toContain('data-pkc-md-block-kind="chart"');
    expect(live).not.toContain('data-pkc-chart-src');
  });
  it('静的 chart の HTML は 1 バイトも変わらない(固定の期待値)', () => {
    const src = '{"type":"bar","labels":["a"],"datasets":[{"label":"x","data":[1]}]}';
    // ⚠ 囲みの中身は末尾の改行を含む(markdown-it の fence の content)
    const esc = src.replace(/"/g, '&quot;') + '\n';
    expect(renderMarkdown('```chart\n' + src + '\n```\n')).toContain(
      `<div class="pkc-chart-placeholder" data-pkc-chart-src="${esc}" data-pkc-md-block-kind="chart"><pre class="pkc-chart-source"><code class="language-chart">${esc}</code></pre></div>`,
    );
  });
});

describe('parseGpuChartSpec', () => {
  it('line: 欠測は NaN、x は番号', () => {
    const s = ok('{"type":"line","title":"t","datasets":[{"label":"a","data":[1,null,"x",3]}]}');
    expect(s.series[0]!.xs).toEqual(Float64Array.from([0, 1, 2, 3]));
    expect(Number.isNaN(s.series[0]!.ys[1]!)).toBe(true);
    expect(Number.isNaN(s.series[0]!.ys[2]!)).toBe(true);
    expect(s.series[0]!.ys[3]).toBe(3);
    expect(s.title).toBe('t');
    expect(gpuChartPointCount(s)).toBe(2);
  });
  it('line: xs を渡すと昇順に並べ直す', () => {
    const s = ok('{"type":"line","xs":[3,1,2],"datasets":[{"label":"a","data":[30,10,20]}]}');
    expect([...s.series[0]!.xs]).toEqual([1, 2, 3]);
    expect([...s.series[0]!.ys]).toEqual([10, 20, 30]);
    expect(s.xIsIndex).toBe(false);
  });
  it('scatter: points / data の {x,y} / 数だけ、読めない点は飛ばす', () => {
    const s = ok('{"type":"scatter","datasets":[{"points":[{"x":1,"y":2},{"x":"a","y":1},{"x":3,"y":4}]},{"data":[5,null,7]}]}');
    expect([...s.series[0]!.xs]).toEqual([1, 3]);
    expect([...s.series[1]!.xs]).toEqual([0, 2]);
    expect([...s.series[1]!.ys]).toEqual([5, 7]);
  });
  it('bar: labels つきは区分の軸', () => {
    const s = ok('{"type":"bar","labels":["a","b"],"datasets":[{"label":"x","data":[1,2]},{"label":"y","data":[3,4]}]}');
    expect(s.xIsIndex).toBe(true);
    expect(s.barSlot).toBeCloseTo(0.8);
  });
  it('heatmap: matrix と values', () => {
    const m = ok('{"type":"heatmap","xLabels":["a","b"],"yLabels":["r1","r2"],"matrix":[[1,2],[3,null]]}');
    expect(m.heatmap!.cols).toBe(2);
    expect(m.heatmap!.rows).toBe(2);
    expect(m.heatmap!.min).toBe(1);
    expect(m.heatmap!.max).toBe(3);
    expect(Number.isNaN(m.heatmap!.values[3]!)).toBe(true);
    const v = ok('{"type":"heatmap","values":[[0,0,1],[2,1,5],[-1,0,9],["a",0,1]]}');
    expect(v.heatmap!.cols).toBe(3);
    expect(v.heatmap!.rows).toBe(2);
    expect(v.heatmap!.values[1 * 3 + 2]).toBe(5);
  });
  it('不正な JSON・型・空は具体的な理由', () => {
    expect(parseGpuChartSpec('')).toEqual({ ok: false, error: 'グラフを描けません: 中身が空です' });
    expect(parseGpuChartSpec('{').ok).toBe(false);
    const t = parseGpuChartSpec('{"type":"pie","datasets":[{"data":[1]}]}');
    expect(t.ok === false && t.error).toContain('line / scatter / bar / heatmap');
    const d = parseGpuChartSpec('{"type":"line","datasets":[{"data":["a"]}]}');
    expect(d.ok === false && d.error).toContain('数値の data がありません');
    const hm = parseGpuChartSpec('{"type":"heatmap"}');
    expect(hm.ok === false && hm.error).toContain('matrix');
    const src = parseGpuChartSpec('{"type":"line","source":"http://evil"}');
    expect(src.ok === false && src.error).toContain('asset:');
  });
  it('上限: 系列 12 本・1 系列 200,000 点・セル 250,000 個(切って注記)', () => {
    const many = ok(JSON.stringify({ type: 'line', datasets: Array.from({ length: 15 }, () => ({ data: [1] })) }));
    expect(many.series).toHaveLength(GPU_CHART_MAX_DATASETS);
    expect(many.notes.join()).toContain('3 本は描いていません');
    const big = ok(JSON.stringify({ type: 'line', datasets: [{ data: new Array(GPU_CHART_MAX_POINTS + 5).fill(1) }] }));
    expect(big.series[0]!.ys.length).toBe(GPU_CHART_MAX_POINTS);
    expect(big.notes.join()).toContain('200,000');
    const row = new Array(600).fill(1);
    const hm = ok(JSON.stringify({ type: 'heatmap', matrix: new Array(600).fill(row) }));
    expect(hm.heatmap!.cols * hm.heatmap!.rows).toBeLessThanOrEqual(GPU_CHART_MAX_HEATMAP_CELLS);
    expect(hm.notes.join()).toContain('250,000');
  });
  it('allowlist: 関数・未知の key は写さない', () => {
    const s = ok('{"type":"line","options":{"onClick":"alert(1)"},"__proto__":{"x":1},"datasets":[{"data":[1],"formatter":"x"}]}');
    expect(Object.keys(s).sort()).toEqual(['barSlot', 'heatmap', 'height', 'labels', 'notes', 'series', 'source', 'type', 'xIsIndex']);
    expect(Object.keys(s.series[0]!).sort()).toEqual(['label', 'xs', 'ys']);
  });
  it('height は上下限で止める', () => {
    expect(ok('{"type":"line","height":9999,"datasets":[{"data":[1]}]}').height).toBe(900);
    expect(ok('{"type":"line","height":10,"datasets":[{"data":[1]}]}').height).toBe(160);
  });
  it('source: asset: の指定を読む(データは CSV を待つ)', () => {
    const s = ok('{"type":"line","source":"asset:ast-1","xColumn":"t","yColumns":["a",2],"seriesColumn":"g"}');
    expect(s.source).toEqual({ key: 'ast-1', xColumn: 't', yColumns: ['a', 2], seriesColumn: 'g' });
    expect(s.series).toHaveLength(0);
  });
});

describe('parseGpuChartCsv', () => {
  const base = (extra = ''): GpuChartSpec => ok(`{"type":"line","source":"asset:k"${extra}}`);
  it('見出しあり・複数系列・欠測は外す', () => {
    const r = parseGpuChartCsv('t,a,b\n0,1,2\n1,,3\n2,5,x\n', base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.series.map((s) => s.label)).toEqual(['a', 'b']);
    expect([...r.spec.series[0]!.xs]).toEqual([0, 2]);
    expect([...r.spec.series[1]!.ys]).toEqual([2, 3]);
  });
  it('見出しなし・列の番号で指定', () => {
    const r = parseGpuChartCsv('0,10\n1,20\n', base(',"xColumn":0,"yColumns":[1]'));
    expect(r.ok && [...r.spec.series[0]!.ys]).toEqual([10, 20]);
  });
  it('seriesColumn で系列を分ける・x が字なら見出しにする', () => {
    const r = parseGpuChartCsv('day,g,v\n月,A,1\n火,B,2\n水,A,3\n', base(',"xColumn":"day","seriesColumn":"g","yColumns":["v"]'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.series.map((s) => s.label)).toEqual(['A', 'B']);
    expect(r.spec.labels).toEqual(['月', '火', '水']);
    expect([...r.spec.series[0]!.xs]).toEqual([0, 2]);
  });
  it('引用符の中のカンマ・タブ区切り', () => {
    expect(splitCsvLine('"a,b",c,"d""e"', ',')).toEqual(['a,b', 'c', 'd"e']);
    const r = parseGpuChartCsv('x\ty\n1\t2\n', base());
    expect(r.ok && [...r.spec.series[0]!.ys]).toEqual([2]);
  });
  it('列が無い・空は理由を返す', () => {
    const r = parseGpuChartCsv('a,b\n1,2\n', base(',"yColumns":["zzz"]'));
    expect(r.ok === false && r.error).toContain('「zzz」');
    expect(parseGpuChartCsv('', base()).ok).toBe(false);
  });
  it('大量(200,000 行 + 超過)を TypedArray に読み、上限で切る', () => {
    const rows = ['t,v'];
    for (let i = 0; i < GPU_CHART_MAX_POINTS + 10; i++) rows.push(`${i},${Math.sin(i)}`);
    const t0 = performance.now();
    const r = parseGpuChartCsv(rows.join('\n'), base());
    const ms = performance.now() - t0;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.series[0]!.xs).toBeInstanceOf(Float64Array);
    expect(r.spec.series[0]!.xs.length).toBe(GPU_CHART_MAX_POINTS);
    expect(r.spec.notes.join()).toContain('200,000');
    expect(ms).toBeLessThan(3000);
  });
  it('heatmap の CSV(行と列の見出し)', () => {
    const hm = ok('{"type":"heatmap","source":"asset:k"}');
    const r = parseGpuChartCsv(',c1,c2\nr1,1,2\nr2,3,4\n', hm);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.heatmap!.xLabels).toEqual(['c1', 'c2']);
    expect(r.spec.heatmap!.yLabels).toEqual(['r1', 'r2']);
    expect(r.spec.heatmap!.max).toBe(4);
  });
});
