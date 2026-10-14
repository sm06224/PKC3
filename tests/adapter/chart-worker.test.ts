/**
 * chart を焼くワーカーの判断(R1 散布図 / R9 描けなかった理由の字)。
 *
 * 守る主張:
 * 1. 🔴 散布図は `{x, y}` の点を chart.js へそのまま渡し、点は見える大きさで描く(半径 0 は何も見えない)
 * 2. 🔴 canvas が取れない端末では「この端末ではグラフを描けませんでした」を返す
 *    (書き方の間違いの理由と混ぜない。英語の `2d context` も出さない)
 * 3. 🔴 ワーカーの返事の理由に「Error: 」の前置きが付かない(画面にそのまま出る字なので)
 *
 * chart.js 本体は重いので差し替える(渡された設定だけを見る)。`self` / `OffscreenCanvas` は node に無いので差す。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartJobRequest } from '../../src/adapter/platform/render/chart-worker';

const seen: { config: Record<string, unknown> | null } = { config: null };

vi.mock('chart.js/auto', () => ({
  default: class {
    constructor(_ctx: unknown, config: Record<string, unknown>) {
      seen.config = config;
    }
    destroy(): void {}
  },
}));

const workerSelf: {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage: (msg: unknown) => void;
} = { onmessage: null, postMessage: () => undefined };

let hasContext = true;
class FakeCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): unknown {
    return hasContext ? { fillRect: () => undefined, scale: () => undefined, fillStyle: '' } : null;
  }
  async convertToBlob(): Promise<Blob> {
    return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  }
}

let mod: typeof import('../../src/adapter/platform/render/chart-worker');
beforeAll(async () => {
  vi.stubGlobal('self', workerSelf);
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  mod = await import('../../src/adapter/platform/render/chart-worker');
});
beforeEach(() => {
  hasContext = true;
  seen.config = null;
});

const palette = { text: '#000', grid: '#ccc', bg: '#fff', series: ['#111', '#222'] };

function req(spec: ChartJobRequest['spec']): ChartJobRequest {
  return { id: 1, spec, width: 320, height: 200, dpr: 1, palette };
}

describe('チャートのワーカー', () => {
  it('🔴 散布図は点({x, y})をそのまま渡し、点は見える大きさで描く', async () => {
    await mod.renderChartPng(
      req({
        type: 'scatter',
        labels: [],
        datasets: [{ label: 's', data: [2, 4], points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
      }),
    );
    const ds = (seen.config!.data as { datasets: Array<Record<string, unknown>> }).datasets[0]!;
    expect(ds.data).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(Number(ds.pointRadius), '点の半径が 0 だと散布図は何も見えない').toBeGreaterThan(0);
  });

  it('対照群: 棒グラフは数の並びのまま渡し、点は描かない', async () => {
    await mod.renderChartPng(
      req({ type: 'bar', labels: ['a', 'b'], datasets: [{ label: 'x', data: [1, null] }] }),
    );
    const ds = (seen.config!.data as { datasets: Array<Record<string, unknown>> }).datasets[0]!;
    expect(ds.data).toEqual([1, null]);
    expect(ds.pointRadius).toBe(0);
  });

  it('🔴 pie / doughnut はスライスごとに別の色(全部同じ色だと見分けが付かない)。色指定は優先、棒は系列 1 色のまま', async () => {
    const dsOf = (): Record<string, unknown> =>
      (seen.config!.data as { datasets: Array<Record<string, unknown>> }).datasets[0]!;
    for (const type of ['pie', 'doughnut'] as const) {
      await mod.renderChartPng(
        req({ type, labels: ['a', 'b', 'c'], datasets: [{ label: 'x', data: [1, 2, 3] }] }),
      );
      // 系列色は 2 色 ── 3 つ目は巡る
      expect(dsOf().backgroundColor, type).toEqual(['#111', '#222', '#111']);
      expect(dsOf().borderColor, type).toEqual(['#111', '#222', '#111']);
    }
    await mod.renderChartPng(
      req({ type: 'pie', labels: ['a', 'b'], datasets: [{ label: 'x', data: [1, 2], color: '#abc' }] }),
    );
    expect(dsOf().backgroundColor, '色の指定があればそれを優先').toBe('#abc');
    await mod.renderChartPng(
      req({ type: 'bar', labels: ['a', 'b'], datasets: [{ label: 'x', data: [1, 2] }] }),
    );
    expect(dsOf().backgroundColor, '対照群: 棒は系列の 1 色').toBe('#111');
  });

  it('🔴 canvas が取れない端末では、端末の都合だと分かる 1 文で断る(英語の字を出さない)', async () => {
    hasContext = false;
    const spec = { type: 'bar', labels: [], datasets: [{ label: 'x', data: [1] }] } as const;
    await expect(mod.renderChartPng(req(spec))).rejects.toThrow('この端末ではグラフを描けませんでした');
    await expect(mod.renderChartPng(req(spec))).rejects.not.toThrow(/2d context/);
  });

  it('🔴 返事の理由に「Error: 」の前置きが付かない(窓口は封筒 { id, payload })', async () => {
    hasContext = false;
    const replies: Array<{ id: number; ok: boolean; error?: string }> = [];
    workerSelf.postMessage = (m) => void replies.push(m as never);
    workerSelf.onmessage!({
      data: {
        id: 7,
        payload: req({ type: 'bar', labels: [], datasets: [{ label: 'x', data: [1] }] }),
      },
    });
    await vi.waitFor(() => expect(replies.length).toBe(1));
    expect(replies[0]).toEqual({ id: 7, ok: false, error: 'この端末ではグラフを描けませんでした' });
  });
});
