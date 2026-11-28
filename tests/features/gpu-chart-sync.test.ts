/**
 * 🔴 GPU グラフの別ウィンドウとの通信の正本(v4.1 PR-9、#2095 後半)── 純関数。
 *
 * - アドレス: `<base>#pkc?chart=<token>` の組み立てと読み取り(往復)・綴りの外れた合図を拒む
 * - 仕様の詰め直し: line / scatter / bar / heatmap / 欠測(NaN)/ highlightX の往復・壊れた物は `null`
 * - 封筒: 種別・token・中身の形が外れた便りは `null`(fail-closed)
 * - クエリ(`?…`)を使わない(`flags.test.ts` の「クエリを抜け穴にしない」と競合しない)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CHART_POPOUT_FEATURES,
  CHART_POPOUT_HELLO_MS,
  CHART_SYNC_CHANNEL,
  CHART_SYNC_TAG,
  chartPopoutTitle,
  deserializeGpuChartSpec,
  formatChartPopoutUrl,
  makeChartSyncMessage,
  parseChartPopoutToken,
  parseChartSyncMessage,
  popoutBindLabel,
  serializeGpuChartSpec,
} from '../../src/features/chart/gpu-chart-sync';
import { parseGpuChartSpec, type GpuChartSpec } from '../../src/features/chart/gpu-chart-spec';
import { VIEW_WINDOW_ANNOUNCE_MS, VIEW_WINDOW_CHANNEL } from '../../src/adapter/platform/view-window';
import { PDF_CHANNEL } from '../../src/adapter/platform/pdf/pdf-window';

function spec(src: string): GpuChartSpec {
  const r = parseGpuChartSpec(src);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

/** 往復させる(structured clone を通す ── 放送路と同じ写し方)。 */
const roundTrip = (s: GpuChartSpec): GpuChartSpec | null => deserializeGpuChartSpec(structuredClone(serializeGpuChartSpec(s)));

const TOKEN = 'cAbc123_-xyz';

describe('アドレス(#pkc?chart=<token>)', () => {
  it('組み立てて読むと同じ合図に戻る', () => {
    const url = formatChartPopoutUrl('https://example.test/pkc3/', TOKEN);
    expect(url).toBe('https://example.test/pkc3/#pkc?chart=cAbc123_-xyz');
    expect(parseChartPopoutToken(url!)).toBe(TOKEN);
    expect(parseChartPopoutToken('#pkc?chart=cAbc123_-xyz')).toBe(TOKEN);
  });

  it('🔴 綴りの外れた合図・base に # がある・合図が無いは拒む', () => {
    expect(formatChartPopoutUrl('https://example.test/#pkc?view=calendar', TOKEN)).toBeNull();
    expect(formatChartPopoutUrl('', TOKEN)).toBeNull();
    expect(formatChartPopoutUrl('https://example.test/', 'short')).toBeNull();
    expect(formatChartPopoutUrl('https://example.test/', 'a'.repeat(65))).toBeNull();
    expect(formatChartPopoutUrl('https://example.test/', 'bad token!')).toBeNull();
    expect(parseChartPopoutToken('https://example.test/#pkc?chart=<script>')).toBeNull();
    expect(parseChartPopoutToken('https://example.test/#pkc?chart=short')).toBeNull();
    expect(parseChartPopoutToken('https://example.test/#pkc?view=calendar')).toBeNull();
    expect(parseChartPopoutToken('https://example.test/?chart=cAbc123_-xyz')).toBeNull(); // ⚠ クエリでは読まない
    expect(parseChartPopoutToken('https://example.test/')).toBeNull();
  });

  it('🔴 クエリ(?…)を使わない ── 断片(#pkc?)だけ', () => {
    const url = formatChartPopoutUrl('https://example.test/app', TOKEN)!;
    expect(new URL(url).search).toBe('');
    expect(new URL(url).hash).toBe('#pkc?chart=cAbc123_-xyz');
  });

  it('🔴 開き方は noopener の小さな窓・放送路は専用の 1 本・名乗りを待つ時間は view-window と同じ実測基準', () => {
    expect(CHART_POPOUT_FEATURES).toBe('popup,noopener,width=900,height=640');
    expect(CHART_SYNC_CHANNEL).toBe('pkc3-chart-sync');
    expect([VIEW_WINDOW_CHANNEL, PDF_CHANNEL]).not.toContain(CHART_SYNC_CHANNEL);
    expect(CHART_POPOUT_HELLO_MS).toBe(VIEW_WINDOW_ANNOUNCE_MS);
  });

  it('⚠ gpu-chart-sync.ts はアドレスを自前で読まない(解くのは permalink.ts、読むのは deep-link.ts)', () => {
    const code = readFileSync('src/features/chart/gpu-chart-sync.ts', 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/location\.|URLSearchParams|searchParams/);
  });
});

describe('仕様の詰め直し(往復)', () => {
  it('折れ線(欠測の NaN と色を保つ)', () => {
    const s = spec(JSON.stringify({ type: 'line', title: '温度', datasets: [{ label: 'A', data: [1, null, 3], color: '#ff0000' }, { label: 'B', data: [4, 5, 6] }] }));
    const r = roundTrip(s)!;
    expect(r).not.toBeNull();
    expect(r.type).toBe('line');
    expect(r.title).toBe('温度');
    expect(r.series).toHaveLength(2);
    expect(r.series[0]!.color).toBe('#ff0000');
    expect(r.series[0]!.ys).toBeInstanceOf(Float64Array);
    expect(Number.isNaN(r.series[0]!.ys[1]!)).toBe(true);
    expect([...r.series[1]!.ys]).toEqual([4, 5, 6]);
    expect(r.source).toBeNull();
  });

  it('散布図・棒(見出し・棒の幅・highlightX)', () => {
    const sc = spec(JSON.stringify({ type: 'scatter', datasets: [{ label: 'P', data: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }] }));
    expect([...roundTrip(sc)!.series[0]!.xs]).toEqual([...sc.series[0]!.xs]);
    const bar = { ...spec(JSON.stringify({ type: 'bar', labels: ['1月', '2月'], datasets: [{ label: '売上', data: [10, 20] }] })), highlightX: 1 };
    const r = roundTrip(bar)!;
    expect(r.type).toBe('bar');
    expect(r.labels).toEqual(['1月', '2月']);
    expect(r.xIsIndex).toBe(true);
    expect(r.barSlot).toBe(bar.barSlot);
    expect(r.highlightX).toBe(1);
  });

  it('ヒートマップ', () => {
    const hm = spec(JSON.stringify({ type: 'heatmap', matrix: [[1, 2, 3], [4, 5, 6]] }));
    const r = roundTrip(hm)!;
    expect(r.heatmap).not.toBeNull();
    expect(r.heatmap!.cols).toBe(3);
    expect(r.heatmap!.rows).toBe(2);
    expect([...r.heatmap!.values]).toEqual([...hm.heatmap!.values]);
    expect(r.heatmap!.xLabels).toEqual(hm.heatmap!.xLabels);
  });

  it('⚠ 連動の指定・明示データ(Map)・添付の指定は運ばない(別ウィンドウは描くだけ)', () => {
    const s = spec('{"type":"bar","bind":"heading","frames":{"Q1":{"labels":["a"],"datasets":[{"label":"x","data":[1]}]}},"labels":["a"],"datasets":[{"label":"x","data":[1]}]}');
    const ser = serializeGpuChartSpec(s) as unknown as Record<string, unknown>;
    expect(ser.bind).toBeUndefined();
    expect(ser.frameDefs).toBeUndefined();
    expect(ser.source).toBeUndefined();
    // 🔑 写しを作らない(放送の structured clone の 1 回だけ)
    expect((ser.series as Array<{ ys: Float64Array }>)[0]!.ys).toBe(s.series[0]!.ys);
  });

  it('🔴 壊れた物は null(fail-closed)', () => {
    const good = serializeGpuChartSpec(spec('{"type":"line","datasets":[{"label":"A","data":[1,2]}]}'));
    const bad = (patch: Record<string, unknown>): unknown => ({ ...good, ...patch });
    expect(deserializeGpuChartSpec(null)).toBeNull();
    expect(deserializeGpuChartSpec('x')).toBeNull();
    expect(deserializeGpuChartSpec(bad({ v: 2 }))).toBeNull();
    expect(deserializeGpuChartSpec(bad({ type: 'pie' }))).toBeNull();
    expect(deserializeGpuChartSpec(bad({ height: 10 }))).toBeNull();
    expect(deserializeGpuChartSpec(bad({ height: Infinity }))).toBeNull();
    expect(deserializeGpuChartSpec(bad({ labels: [1] }))).toBeNull();
    expect(deserializeGpuChartSpec(bad({ barSlot: 0 }))).toBeNull();
    expect(deserializeGpuChartSpec(bad({ series: [] }))).toBeNull();
    expect(deserializeGpuChartSpec(bad({ series: [{ label: 'A', xs: new Float64Array(2), ys: new Float64Array(3) }] }))).toBeNull();
    expect(deserializeGpuChartSpec(bad({ series: [{ label: 'A', xs: ['1'], ys: [1] }] }))).toBeNull();
    expect(deserializeGpuChartSpec(bad({ highlightX: 'x' }))).toBeNull();
    expect(deserializeGpuChartSpec(bad({ type: 'heatmap', heatmap: { cols: 2, rows: 2, values: new Float64Array(3), xLabels: [], yLabels: [], min: 0, max: 1 } }))).toBeNull();
    // 素の配列で来ても受ける(数なら)
    const plain = deserializeGpuChartSpec(bad({ series: [{ label: 'A', xs: [0, 1], ys: [3, 4] }] }));
    expect(plain).not.toBeNull();
    expect(plain!.series[0]!.ys).toBeInstanceOf(Float64Array);
  });
});

describe('封筒', () => {
  const s = spec('{"type":"line","datasets":[{"label":"A","data":[1,2]}]}');
  const theme = { theme: 'dark', tone: 'dark', accent: null };

  it('全種別が往復する(仕様は詰め直して運ぶ)', () => {
    const msgs = [
      makeChartSyncMessage({ kind: 'hello', token: TOKEN }),
      makeChartSyncMessage({ kind: 'closed', token: TOKEN }),
      makeChartSyncMessage({ kind: 'jump', token: TOKEN, payload: { index: 2, key: '2' } }),
      makeChartSyncMessage({ kind: 'theme', token: TOKEN, payload: theme }),
      makeChartSyncMessage({ kind: 'source-closed', token: TOKEN, payload: { reason: '切り離しました' } }),
      makeChartSyncMessage({
        kind: 'init',
        token: TOKEN,
        payload: { noteTitle: 'ノート', chartTitle: 'グラフ', spec: s, bindMode: 'heading', framesMeta: [{ key: '0', label: 'Q1' }], currentIndex: 0, currentLabel: 'Q1', theme },
      }),
      makeChartSyncMessage({
        kind: 'update',
        token: TOKEN,
        payload: { spec: null, emptyReason: 'この節には対象データがありません', label: 'Q3', index: 2, total: 3, animate: true, requested: true },
      }),
    ];
    const kinds = msgs.map((m) => parseChartSyncMessage(structuredClone(m))?.kind);
    expect(kinds).toEqual(['hello', 'closed', 'jump', 'theme', 'source-closed', 'init', 'update']);
    expect(msgs[0]![CHART_SYNC_TAG]).toBe('hello');
    const init = parseChartSyncMessage(structuredClone(msgs[5]));
    expect(init?.kind === 'init' && init.payload.spec?.series[0]!.ys[1]).toBe(2);
    const upd = parseChartSyncMessage(structuredClone(msgs[6]));
    expect(upd?.kind === 'update' && upd.payload.requested).toBe(true);
    expect(upd?.kind === 'update' && upd.payload.spec).toBeNull();
  });

  it('🔴 種別・token・中身の形が外れた便りは null', () => {
    expect(parseChartSyncMessage(null)).toBeNull();
    expect(parseChartSyncMessage({ [CHART_SYNC_TAG]: 'hello' })).toBeNull();
    expect(parseChartSyncMessage({ [CHART_SYNC_TAG]: 'hello', token: 'short' })).toBeNull();
    expect(parseChartSyncMessage({ [CHART_SYNC_TAG]: 'nuke', token: TOKEN })).toBeNull();
    expect(parseChartSyncMessage({ pkc3Pdf: 'hello', token: TOKEN })).toBeNull();
    expect(parseChartSyncMessage({ [CHART_SYNC_TAG]: 'jump', token: TOKEN, payload: { index: -1, key: '0' } })).toBeNull();
    expect(parseChartSyncMessage({ [CHART_SYNC_TAG]: 'theme', token: TOKEN, payload: { theme: 'x;y', tone: null, accent: null } })).toBeNull();
    expect(
      parseChartSyncMessage({ [CHART_SYNC_TAG]: 'update', token: TOKEN, payload: { spec: { v: 1, type: 'pie' }, label: '', index: 0, total: 1, animate: true } }),
    ).toBeNull();
    expect(parseChartSyncMessage({ [CHART_SYNC_TAG]: 'update', token: TOKEN, payload: { spec: null, label: '', index: 0, total: 1 } })).toBeNull();
    expect(
      parseChartSyncMessage({
        [CHART_SYNC_TAG]: 'init',
        token: TOKEN,
        payload: { noteTitle: 'n', chartTitle: 'c', spec: null, currentIndex: 0, currentLabel: '', theme, bindMode: 'weekly' },
      }),
    ).toBeNull();
  });
});

describe('画面の字', () => {
  it('題名・連動の表示', () => {
    expect(chartPopoutTitle('売上', '週報')).toBe('売上 - 週報 | PKC3');
    expect(chartPopoutTitle('', '週報')).toBe('グラフ - 週報 | PKC3');
    expect(chartPopoutTitle('売上', '')).toBe('売上 | PKC3');
    expect(popoutBindLabel('heading', 'Q2', 1, 4)).toBe('連動: Q2 (2 / 4)');
    expect(popoutBindLabel('page', 'ページ 2 / 4', 1, 4)).toBe('連動: ページ 2 / 4');
    expect(popoutBindLabel('log-day', '', -1, 0)).toBe('連動: (なし)');
    expect(popoutBindLabel(undefined, 'x', 0, 1)).toBe('');
  });
});
