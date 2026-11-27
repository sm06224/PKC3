/**
 * 🔴 スクロール連動グラフの契約(v4.1 PR-8、#2095 中盤)── 本文(見出し・改ページ・ログの日付)→ 時点のデータ、補間。
 */
import { describe, expect, it } from 'vitest';
import {
  BOUND_EMPTY_REASON,
  cellNum,
  easeOutCubic,
  extractBoundChartFrames,
  frameForSignal,
  interpolateChartSpec,
  logDayOfText,
  scanLines,
  shiftDay,
} from '../../src/features/chart/gpu-chart-bind';
import { parseGpuChartSpec, shouldUseGpuChart, type GpuChartSpec } from '../../src/features/chart/gpu-chart-spec';

function spec(src: string | object): GpuChartSpec {
  const r = parseGpuChartSpec(typeof src === 'string' ? src : JSON.stringify(src));
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

const ys = (s: GpuChartSpec | null, i = 0): number[] => [...(s?.series[i]?.ys ?? [])];

describe('bind の指定', () => {
  it('"bind" があれば GPU の経路へ振り分ける(印の無い短い原文でも)', () => {
    expect(shouldUseGpuChart('', '{"type":"bar","bind":"heading"}')).toBe(true);
    expect(shouldUseGpuChart('', '{"type":"line","bind":{"mode":"page"}}')).toBe(true);
    // 対照群: bind の無い小さな chart は今までどおり静的なまま
    expect(shouldUseGpuChart('', '{"type":"bar","labels":["a"],"datasets":[{"data":[1]}]}')).toBe(false);
  });

  it('文字列の略記は既定値へ揃える / 細かい指定は範囲に収める', () => {
    expect(spec({ type: 'bar', bind: 'heading' }).bind).toEqual({ mode: 'heading', level: 2, sticky: true, windowDays: 7 });
    expect(spec({ type: 'line', bind: { mode: 'log-day', windowDays: 400, sticky: false } }).bind).toEqual({
      mode: 'log-day',
      level: 2,
      sticky: false,
      windowDays: 90,
    });
    expect(spec({ type: 'line', bind: { mode: 'heading', level: 3 } }).bind?.level).toBe(3);
    expect(spec({ type: 'line', bind: { mode: 'heading', level: 9 } }).bind?.level).toBe(2);
  });

  it('知らない種類・source との併用・ヒートマップ・bind の無い frames は理由を出す', () => {
    const bad = (o: object): string => {
      const r = parseGpuChartSpec(JSON.stringify(o));
      return r.ok ? '' : r.error;
    };
    expect(bad({ type: 'bar', bind: 'scroll' })).toContain('bind は');
    expect(bad({ type: 'bar', bind: 'page', source: 'asset:k' })).toContain('source');
    expect(bad({ type: 'heatmap', bind: 'page', matrix: [[1]] })).toContain('line / scatter / bar');
    expect(bad({ type: 'bar', frames: {}, datasets: [{ data: [1] }] })).toContain('frames は bind');
  });

  it('データの無い bind は系列 0 本(本文から作る)・bind の無い仕様には項目自体を持たない', () => {
    const s = spec({ type: 'bar', bind: 'page' });
    expect(s.series).toHaveLength(0);
    const plain = spec({ type: 'bar', engine: 'gpu', datasets: [{ data: [1, 2] }] });
    expect('bind' in plain).toBe(false);
    expect('frameDefs' in plain).toBe(false);
  });
});

describe('heading: 見出しの節ごと', () => {
  const body = [
    '# 売上',
    '```chart live',
    '{"type":"bar","bind":"heading"}',
    '```',
    '## Q1',
    '| 月 | 売上 | 費用 |',
    '|---|---:|---:|',
    '| 1月 | 1,200 | 800 |',
    '| 2月 | 1,500 | 900 |',
    '## Q2',
    '本文だけ(表なし)',
    '### 細目',
    '```csv',
    '月,売上',
    '4月,10',
    '5月,20',
    '```',
    '## Q3',
    '```text',
    '| 偽 | 1 |',
    '|---|---|',
    '| x | 9 |',
    '```',
  ].join('\n');

  it('節の最初の数の表(表 / ```csv)を拾う・深い見出しの中も同じ節', () => {
    const d = extractBoundChartFrames(body, spec({ type: 'bar', bind: 'heading', title: '四半期' }));
    expect(d.frames.map((f) => f.label)).toEqual(['Q1', 'Q2', 'Q3']);
    const q1 = d.frames[0]!.spec!;
    expect(q1.labels).toEqual(['1月', '2月']);
    expect(q1.series.map((s) => s.label)).toEqual(['売上', '費用']);
    expect(ys(q1)).toEqual([1200, 1500]);
    expect(q1.title).toBe('四半期');
    expect(ys(d.frames[1]!.spec)).toEqual([10, 20]);
  });

  it('コードの囲みの中の表は拾わない ── データの無い節は spec: null(古い節の絵を残さない)', () => {
    const d = extractBoundChartFrames(body, spec({ type: 'bar', bind: 'heading' }));
    expect(d.frames[2]!.spec).toBeNull();
    expect(BOUND_EMPTY_REASON.heading).toContain('対象データがありません');
  });

  it('明示の frames(見出し名)が本文の表より先', () => {
    const d = extractBoundChartFrames(
      body,
      spec({ type: 'bar', bind: 'heading', frames: { Q3: { labels: ['x'], datasets: [{ label: 'y', data: [7] }] } } }),
    );
    expect(ys(d.frames[2]!.spec)).toEqual([7]);
    expect(ys(d.frames[0]!.spec)).toEqual([1200, 1500]); // 書いていない節は本文の表
  });

  it('見出しのレベルを選べる / コードの囲みの中の見出しは数えない', () => {
    const d = extractBoundChartFrames(body, spec({ type: 'bar', bind: { mode: 'heading', level: 3 } }));
    expect(d.frames.map((f) => f.label)).toEqual(['細目']);
    expect(extractBoundChartFrames('```\n## 偽\n```\n## 本物\n', spec({ type: 'bar', bind: 'heading' })).frames).toHaveLength(1);
  });
});

describe('page: 改ページ(+++)ごと', () => {
  it('+++ で分けたページの表を拾う(コードの囲みの中の +++ では分けない)', () => {
    const body = [
      '| 品 | 数 |',
      '|---|---|',
      '| a | 1 |',
      '+++',
      '```',
      '+++',
      '```',
      '| 品 | 数 |',
      '|---|---|',
      '| b | 2 |',
      '+++ {role=section}',
      '何もない',
    ].join('\n');
    const d = extractBoundChartFrames(body, spec({ type: 'bar', bind: 'page' }));
    expect(d.frames.map((f) => f.label)).toEqual(['ページ 1 / 3', 'ページ 2 / 3', 'ページ 3 / 3']);
    expect(ys(d.frames[0]!.spec)).toEqual([1]);
    expect(ys(d.frames[1]!.spec)).toEqual([2]);
    expect(d.frames[2]!.spec).toBeNull();
  });

  it('明示の frames はページ番号(1 始まり)の鍵か配列の添字', () => {
    const body = 'a\n+++\nb\n';
    const byKey = extractBoundChartFrames(body, spec({ type: 'line', bind: 'page', frames: { '2': [5, 6, 7] } }));
    expect(byKey.frames[0]!.spec).toBeNull();
    expect(ys(byKey.frames[1]!.spec)).toEqual([5, 6, 7]);
    const byList = extractBoundChartFrames(body, spec({ type: 'line', bind: 'page', frames: [[1, 2], null] }));
    expect(ys(byList.frames[0]!.spec)).toEqual([1, 2]);
    expect(byList.frames[1]!.spec).toBeNull();
  });

  it('frontmatter の中は見ない', () => {
    const d = extractBoundChartFrames('---\ntitle: x\n---\n| a | 1 |\n|---|---|\n| b | 2 |\n', spec({ type: 'bar', bind: 'page' }));
    expect(d.frames).toHaveLength(1);
    expect(ys(d.frames[0]!.spec)).toEqual([2]);
    expect(scanLines('---\na: 1\n---\nx')[0]!.text).toBe('x');
  });
});

describe('log-day: ログの日付ごと', () => {
  const body = [
    '## 2026-11-18 09:00:00',
    'a',
    '## 2026-11-18 12:30:00',
    'b',
    '## 2026-11-20 08:00:00',
    'c',
    '## 2026-11-20',
    'd',
    '## 2026-11-20 10:00:00',
    '```',
    '## 2026-11-19 10:00:00',
    '```',
  ].join('\n');

  it('日ごとに件数を数え、その日を終端とする windowDays 日を切り出し、その日を強調する', () => {
    const d = extractBoundChartFrames(body, spec({ type: 'bar', bind: { mode: 'log-day', windowDays: 3 } }));
    expect(d.frames.map((f) => f.key)).toEqual(['2026-11-18', '2026-11-20']); // 囲みの中の 19 日は数えない
    const last = d.frames[1]!.spec!;
    expect(last.labels).toEqual(['11-18', '11-19', '11-20']);
    expect(ys(last)).toEqual([2, 0, 3]);
    expect(last.highlightX).toBe(2);
    expect(ys(d.frames[0]!.spec)).toEqual([0, 0, 2]);
  });

  it('既定の 7 日の窓・現在地の 1 通は日付で引く', () => {
    const d = extractBoundChartFrames(body, spec({ type: 'line', bind: 'log-day' }));
    expect(d.frames[1]!.spec!.labels).toHaveLength(7);
    expect(frameForSignal(d, { key: '2026-11-20', index: 99 })?.key).toBe('2026-11-20');
    expect(frameForSignal(d, { key: '2026-11-19', index: 0 })).toBeNull();
  });

  it('日付の読み方(時刻つき / 日付だけ / 暦に無い日は読まない)と日のずらし', () => {
    expect(logDayOfText('2026-11-20 09:15:00')).toBe('2026-11-20');
    expect(logDayOfText('2026-11-20')).toBe('2026-11-20');
    expect(logDayOfText('2026-02-30 10:00')).toBeNull();
    expect(logDayOfText('会議 2026-11-20')).toBeNull();
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('表の数', () => {
  it('桁区切り・%・通貨記号・強調を数として読む', () => {
    expect(cellNum('1,200')).toBe(1200);
    expect(cellNum('35%')).toBe(35);
    expect(cellNum('¥1,000')).toBe(1000);
    expect(cellNum('**12**')).toBe(12);
    expect(cellNum('abc')).toBeNaN();
    expect(cellNum('')).toBeNaN();
  });
});

describe('補間', () => {
  const a = spec({ type: 'line', engine: 'gpu', labels: ['x', 'y', 'z'], datasets: [{ data: [0, 10, null] }] });
  const b = spec({ type: 'line', engine: 'gpu', labels: ['x', 'y', 'z'], datasets: [{ data: [10, 20, 30] }] });

  it('t = 0 / 0.5 / 1 で線形に補間する(欠測は補間せず行き先へ切り替える)', () => {
    expect(ys(interpolateChartSpec(a, b, 0))).toEqual([0, 10, 30]);
    expect(ys(interpolateChartSpec(a, b, 0.5))).toEqual([5, 15, 30]);
    expect(ys(interpolateChartSpec(a, b, 1))).toEqual([10, 20, 30]);
    const toMissing = spec({ type: 'line', engine: 'gpu', labels: ['x', 'y', 'z'], datasets: [{ data: [10, null, 30] }] });
    expect(ys(interpolateChartSpec(b, toMissing, 0.5))[1]).toBeNaN();
  });

  it('形が合わなければ null(系列の数・点の数・種類・ヒートマップの次元)', () => {
    const twoSeries = spec({ type: 'line', engine: 'gpu', datasets: [{ data: [1, 2, 3] }, { data: [1, 2, 3] }] });
    const fewer = spec({ type: 'line', engine: 'gpu', datasets: [{ data: [1, 2] }] });
    const bar = spec({ type: 'bar', engine: 'gpu', datasets: [{ data: [1, 2, 3] }] });
    expect(interpolateChartSpec(a, twoSeries, 0.5)).toBeNull();
    expect(interpolateChartSpec(a, fewer, 0.5)).toBeNull();
    expect(interpolateChartSpec(a, bar, 0.5)).toBeNull();
    const h1 = spec({ type: 'heatmap', matrix: [[1, 2]] });
    const h2 = spec({ type: 'heatmap', matrix: [[1], [2]] });
    const h3 = spec({ type: 'heatmap', matrix: [[3, 4]] });
    expect(interpolateChartSpec(h1, h2, 0.5)).toBeNull();
    expect([...interpolateChartSpec(h1, h3, 0.5)!.heatmap!.values]).toEqual([2, 3]);
  });

  it('減速の曲線は 0 → 0、1 → 1、途中は直線より先へ進む', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeOutCubic(2)).toBe(1);
  });
});
