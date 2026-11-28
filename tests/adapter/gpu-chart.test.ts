/** @vitest-environment happy-dom */
/**
 * 🔴 GPU で直接描くグラフ(v4.1 PR-7、#2095)── gpu-lease を偽物に差し替え、three は**実物**(buffer の後始末を数える)。
 *
 * 守ること:
 * - 静的な ` ```chart ` だけのノートでは Three.js を 1 バイトも読まない(描画面も作らない)
 * - 描き直しは操作のときだけ `invalidate()` を 1 回(rAF を自分で回さない ── 静止時 0)
 * - GPU は系列ごとの LineSegments(≤ 12)/ InstancedMesh 1 つで描く
 * - `updateData()` で古い buffer を返して描き直す
 * - 2D の簡易表示でも、拡大・縮小・全体表示・ホバー・PNG で保存が同じ座標で動く
 * - 添付の CSV は呼び側の口で引き、無ければ理由を出す
 * - `dispose()` で全部外す
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  GPU_CHART_SRC_ATTR,
  hydrateGpuChart,
  mountGpuChart,
  renderGpuChartPng,
  setGpuChartTestHooks,
  type GpuChartView,
} from '../../src/adapter/ui/render/gpu-chart';
import {
  gpuLeaseStats,
  resetGpuLeaseForTest,
  setThreeLoaderForTest,
  type GpuContext,
  type GpuFrameSize,
  type GpuSession,
  type GpuSurface,
  type GpuSurfaceOptions,
} from '../../src/adapter/platform/render/gpu-lease';
import { parseGpuChartSpec, type GpuChartSpec } from '../../src/features/chart/gpu-chart-spec';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { hydrateFigures } from '../../src/adapter/ui/render/detail';
import { noteTyping, resetTyping } from '../../src/adapter/ui/render/typing-gate';
import { CHART_CONTEXT_ROOT_MARGIN, liveChartContextWatches } from '../../src/adapter/ui/render/chart-context-watch';
import { hydrateAllNow } from '../../src/adapter/ui/render/mermaid-hydrate';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface FakeSurface extends GpuSurface {
  opts: GpuSurfaceOptions;
  invalidates: number;
  pinned: boolean[];
  disposed: number;
}

let surfaces: FakeSurface[] = [];
let saved: Array<{ name: string; blob: Blob }> = [];

function fakeFactory(opts: GpuSurfaceOptions): GpuSurface {
  const s: FakeSurface = {
    opts,
    invalidates: 0,
    pinned: [],
    disposed: 0,
    state: 'idle',
    invalidate() {
      s.invalidates += 1;
    },
    setPinned(p: boolean) {
      s.pinned.push(p);
    },
    dispose() {
      s.disposed += 1;
    },
  };
  surfaces.push(s);
  return s;
}

interface FakeRenderer {
  scenes: THREE.Scene[];
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setPixelRatio(): void;
  setSize(): void;
  dispose(): void;
}

function fakeCtx(): { ctx: GpuContext; renderer: FakeRenderer } {
  const canvas = document.createElement('canvas');
  const renderer: FakeRenderer = {
    scenes: [],
    render(scene) {
      renderer.scenes.push(scene);
    },
    setPixelRatio() {},
    setSize() {},
    dispose() {},
  };
  return { ctx: { backend: 'webgl2', canvas, three: THREE, renderer, pixelRatio: 1 } as unknown as GpuContext, renderer };
}

/** 2D canvas の偽物(呼ばれた操作を数える・`drawImage` の引数の順を残す・`getImageData` の透明度を選べる)。 */
function fake2d(alpha = 255): { ctx: Record<string, unknown>; calls: Record<string, number>; drawn: unknown[] } {
  const calls: Record<string, number> = {};
  const drawn: unknown[] = [];
  const ctx = new Proxy(
    { fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '', lineJoin: '' } as Record<string, unknown>,
    {
      get(t, k: string) {
        if (k in t) return t[k];
        if (k === 'measureText') return (s: string) => ({ width: s.length * 6 });
        if (k === 'drawImage') return (src: unknown) => drawn.push(src);
        if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray([10, 20, 30, alpha]) });
        return () => {
          calls[k] = (calls[k] ?? 0) + 1;
        };
      },
      set(t, k: string, v) {
        t[k] = v;
        return true;
      },
    },
  );
  return { ctx, calls, drawn };
}

const SIZE: GpuFrameSize = { width: 600, height: 320, pixelRatio: 1 };

function spec(src: string): GpuChartSpec {
  const r = parseGpuChartSpec(src);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function sized(view: GpuChartView): HTMLElement {
  const stage = view.element.querySelector<HTMLElement>('[data-pkc-gpu-chart-stage]')!;
  Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 600 });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 320 });
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 320, width: 600, height: 320, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return stage;
}

const LINE_50K = JSON.stringify({
  type: 'line',
  title: 'センサー',
  datasets: [
    { label: '温度', data: Array.from({ length: 50_000 }, (_, i) => Math.sin(i / 500) * 10) },
    { label: '湿度', data: Array.from({ length: 50_000 }, (_, i) => Math.cos(i / 700) * 5) },
  ],
});

let host: HTMLElement;

/** 見えたことを報告する IntersectionObserver(既定はすぐ「見えた」)。 */
let ioAuto = true;
let ioInstances: FakeIo[] = [];
class FakeIo {
  targets = new Set<Element>();
  constructor(readonly cb: (e: Array<{ target: Element; isIntersecting: boolean }>) => void) {
    ioInstances.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
    if (ioAuto) this.cb([{ target: el, isIntersecting: true }]);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
  show(): void {
    this.cb([...this.targets].map((target) => ({ target, isIntersecting: true })));
  }
}

beforeEach(() => {
  ioAuto = true;
  ioInstances = [];
  vi.stubGlobal('IntersectionObserver', FakeIo);
  surfaces = [];
  saved = [];
  setGpuChartTestHooks({ createSurface: fakeFactory, saveBlob: (name, blob) => saved.push({ name, blob }) });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  setGpuChartTestHooks(null);
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('🔴 静的な chart では GPU を使わない', () => {
  it('通常の ```chart だけのノートでは器が無く、Three.js を 1 回も読まない(実物の gpu-lease)', async () => {
    setGpuChartTestHooks(null);
    resetGpuLeaseForTest();
    const load = vi.fn(async () => THREE);
    setThreeLoaderForTest({ loadThree: load, loadThreeWebGpu: load as never });
    host.innerHTML = renderMarkdown('```chart\n{"type":"bar","labels":["a"],"datasets":[{"label":"x","data":[1]}]}\n```\n');
    expect(host.querySelector('[data-pkc-chart-src]')).not.toBeNull();
    expect(host.querySelector(`[${GPU_CHART_SRC_ATTR}]`)).toBeNull();
    const scope = hydrateGpuChart(host);
    await flush();
    expect(scope.prune()).toBe(0);
    expect(load).not.toHaveBeenCalled();
    expect(gpuLeaseStats()).toMatchObject({ threeLoaded: false, activeContexts: 0, scheduledFrames: 0 });
    scope.dispose();
    resetGpuLeaseForTest();
  });

  it('hydrateFigures に載っている(GPU の器は埋まり、静的な器は触らない)', async () => {
    host.innerHTML =
      renderMarkdown('```chart live\n{"type":"line","datasets":[{"label":"x","data":[1,2,3]}]}\n```\n');
    const scopes = hydrateFigures(host);
    await flush();
    expect(surfaces).toHaveLength(1);
    expect(host.querySelector(`[${GPU_CHART_SRC_ATTR}]`)!.getAttribute('data-pkc-gpu-chart-state')).toBe('ready');
    expect(host.querySelector('[data-pkc-field="gpu-chart-bar"]')).not.toBeNull();
    for (const s of scopes) s.dispose();
    expect(surfaces[0]!.disposed).toBe(1);
  });
});

describe('GPU の描画', () => {
  it('最初の invalidate 1 回だけ・静止時は rAF を頼まない・操作ごとに 1 回', async () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    const v = mountGpuChart(host, spec(LINE_50K));
    sized(v);
    const s = surfaces[0]!;
    expect(s.invalidates).toBe(1);
    const { ctx } = fakeCtx();
    const session = (await s.opts.onAcquire(ctx)) as GpuSession;
    session.render(SIZE);
    await flush();
    expect(s.invalidates).toBe(1);
    v.zoomStep(1);
    expect(s.invalidates).toBe(2);
    v.resetView();
    expect(s.invalidates).toBe(3);
    expect(raf).not.toHaveBeenCalled();
    v.dispose();
  });

  it('折れ線: 系列ごとに LineSegments 1 つ、50,000 点を画面の幅ほどへ間引く', async () => {
    const v = mountGpuChart(host, spec(LINE_50K));
    sized(v);
    const { ctx, renderer } = fakeCtx();
    const session = (await surfaces[0]!.opts.onAcquire(ctx)) as GpuSession;
    session.render(SIZE);
    const scene = renderer.scenes[0]!;
    const lines = scene.children.filter((c) => (c as THREE.LineSegments).isLineSegments) as THREE.LineSegments[];
    expect(lines).toHaveLength(2);
    const verts = lines[0]!.geometry.getAttribute('position').count;
    expect(verts).toBeGreaterThan(200);
    expect(verts).toBeLessThan(2 * 2 * 600 * 2 + 10);
    const info = v.element.querySelector('[data-pkc-gpu-chart-info="points"]')!.textContent;
    expect(info).toMatch(/^100,000 点\(表示 [\d,]+ 点\)$/);
    expect(v.element.getAttribute('data-pkc-gpu-chart-backend')).toBe('webgl2');
    v.dispose();
  });

  it('散布図・棒・ヒートマップ: InstancedMesh 1 つ(描画呼び出し 1 回)', async () => {
    const cases: Array<[string, number]> = [
      [JSON.stringify({ type: 'scatter', datasets: [{ points: Array.from({ length: 3000 }, (_, i) => ({ x: i, y: i % 17 })) }, { data: [1, 2, 3] }] }), 3003],
      [JSON.stringify({ type: 'bar', labels: ['a', 'b', 'c'], datasets: [{ data: [1, 2, 3] }, { data: [3, 2, 1] }] }), 6],
      [JSON.stringify({ type: 'heatmap', matrix: [[1, 2, 3], [4, null, 6]] }), 5],
    ];
    for (const [src, n] of cases) {
      surfaces = [];
      const v = mountGpuChart(host, spec(src));
      sized(v);
      const { ctx, renderer } = fakeCtx();
      const session = (await surfaces[0]!.opts.onAcquire(ctx)) as GpuSession;
      session.render(SIZE);
      const meshes = renderer.scenes[0]!.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[];
      expect(meshes).toHaveLength(1);
      expect(meshes[0]!.count).toBe(n);
      expect(meshes[0]!.instanceColor).not.toBeNull();
      session.dispose();
      v.dispose();
    }
  });

  it('updateData: 古い buffer を返し、invalidate 1 回で描き直す(範囲は保つ / 戻す)', async () => {
    const pts = (n: number) => JSON.stringify({ type: 'scatter', datasets: [{ points: Array.from({ length: n }, (_, i) => ({ x: i, y: i })) }] });
    const v = mountGpuChart(host, spec(pts(100)));
    sized(v);
    const s = surfaces[0]!;
    const { ctx, renderer } = fakeCtx();
    const session = (await s.opts.onAcquire(ctx)) as GpuSession;
    session.render(SIZE);
    const oldMesh = renderer.scenes[0]!.children.find((c) => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    let disposedOld = 0;
    oldMesh.addEventListener('dispose', () => (disposedOld += 1));
    v.zoomStep(1);
    const zoomed = v.range;
    const before = s.invalidates;
    v.updateData(spec(pts(400)));
    expect(s.invalidates).toBe(before + 1);
    session.render(SIZE);
    expect(disposedOld).toBe(1);
    const newMesh = renderer.scenes[0]!.children.find((c) => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    expect(newMesh).not.toBe(oldMesh);
    expect(v.range).toEqual(zoomed);
    expect(v.element.querySelector('[data-pkc-gpu-chart-info="points"]')!.textContent).toContain('400 点');
    v.updateData(spec(pts(400)), { resetViewport: true });
    expect(v.range.xMax - v.range.xMin).toBeGreaterThan(zoomed.xMax - zoomed.xMin);
    v.dispose();
  });

  it('ポスターは 1 コマ描いてから軸と重ねて焼き、軸の層を隠す', async () => {
    const v = mountGpuChart(host, spec(LINE_50K));
    sized(v);
    const { ctx, renderer } = fakeCtx();
    const session = (await surfaces[0]!.opts.onAcquire(ctx)) as GpuSession;
    session.render(SIZE);
    const order: string[] = [];
    const { ctx: c2, drawn } = fake2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => c2 as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
      order.push(`toBlob@${renderer.scenes.length}`);
      cb(new Blob(['png'], { type: 'image/png' }));
    });
    const blob = await session.capturePoster!();
    expect(blob).toBeInstanceOf(Blob);
    expect(order).toEqual(['toBlob@2']);
    // 🔴 GPU の絵 → 軸の層 の順で重ねる(軸だけのポスターにしない)
    expect(drawn).toEqual([ctx.canvas, v.element.querySelector('[data-pkc-gpu-chart-overlay]')]);
    expect(v.element.querySelector<HTMLCanvasElement>('[data-pkc-gpu-chart-overlay]')!.hidden).toBe(true);
    session.render(SIZE);
    expect(v.element.querySelector<HTMLCanvasElement>('[data-pkc-gpu-chart-overlay]')!.hidden).toBe(false);
    v.dispose();
  });

  it('GPU の絵を写せない(透明)ときは、同じ座標の 2D で焼く(空白のポスターにしない)', async () => {
    const v = mountGpuChart(host, spec(LINE_50K));
    sized(v);
    const { ctx } = fakeCtx();
    const session = (await surfaces[0]!.opts.onAcquire(ctx)) as GpuSession;
    session.render(SIZE);
    const { ctx: c2, drawn, calls } = fake2d(0);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => c2 as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })));
    const blob = await session.capturePoster!();
    expect(blob).toBeInstanceOf(Blob);
    // 軸の層は重ねていない(透明の GPU の絵の上に軸だけ、を作らない)・2D で線を描いた
    expect(drawn).toEqual([ctx.canvas]);
    expect(calls.lineTo ?? 0).toBeGreaterThan(100);
    v.dispose();
  });

  it('session.dispose で geometry / material を全部返す', async () => {
    const v = mountGpuChart(host, spec('{"type":"bar","labels":["a","b"],"datasets":[{"data":[1,2]}]}'));
    sized(v);
    const { ctx, renderer } = fakeCtx();
    const session = (await surfaces[0]!.opts.onAcquire(ctx)) as GpuSession;
    session.render(SIZE);
    const disposed = new Set<unknown>();
    renderer.scenes[0]!.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.addEventListener('dispose', () => disposed.add(m.geometry));
      if (m.material) (m.material as THREE.Material).addEventListener('dispose', () => disposed.add(m.material));
    });
    session.dispose();
    expect(disposed.size).toBe(2);
    v.dispose();
    expect(host.querySelector('[data-pkc-gpu-chart]')).toBeNull();
    expect(surfaces[0]!.disposed).toBe(1);
  });
});

describe('操作(スクロールの取り合い 0)', () => {
  it('ただのホイールは奪わない・Ctrl + ホイールで拡大(カーソル中心)', () => {
    const v = mountGpuChart(host, spec(LINE_50K));
    const stage = sized(v);
    const { ctx: c2 } = fake2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => c2 as never);
    surfaces[0]!.opts.onFallback2d(stage, '理由');
    const home = v.range;
    const plain = new WheelEvent('wheel', { deltaY: -100, cancelable: true, bubbles: true });
    stage.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(v.range).toEqual(home);
    const zoom = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, cancelable: true, bubbles: true, clientX: 300, clientY: 150 });
    // ⚠ happy-dom の WheelEvent は初期値の ctrlKey を持たない(環境差)── 実ブラウザと同じ値を載せる
    Object.defineProperty(zoom, 'ctrlKey', { value: true });
    stage.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(true);
    expect(v.range.xMax - v.range.xMin).toBeLessThan(home.xMax - home.xMin);
    v.dispose();
  });

  it('拾ったキー(+ / - / 0 / 矢印)は全体のショートカットへ流さない', () => {
    const v = mountGpuChart(host, spec(LINE_50K));
    const stage = sized(v);
    let reached = 0;
    const onDoc = (): void => void (reached += 1);
    document.addEventListener('keydown', onDoc);
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }));
    expect(v.range.xMax - v.range.xMin).toBeLessThan(50_000);
    expect(reached).toBe(0);
    // 拾わないキーは流す
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(reached).toBe(1);
    document.removeEventListener('keydown', onDoc);
    v.dispose();
  });

  it('ドラッグで移動し、押している間だけ LRU から外す', async () => {
    const v = mountGpuChart(host, spec(LINE_50K));
    const stage = sized(v);
    const { ctx } = fakeCtx();
    const session = (await surfaces[0]!.opts.onAcquire(ctx)) as GpuSession;
    session.render(SIZE);
    v.zoomStep(1);
    const z = v.range;
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 300, clientY: 100 }));
    stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 350, clientY: 100 }));
    expect(v.range.xMin).toBeLessThan(z.xMin);
    stage.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    expect(surfaces[0]!.pinned).toEqual([true, false]);
    v.dispose();
  });
});

describe('2D の簡易表示(GPU と同じ座標・同じ操作)', () => {
  it('理由を 1 行出し、拡大・縮小・全体表示・ホバー・PNG で保存が動く', async () => {
    const v = mountGpuChart(host, spec('{"type":"line","title":"売上","datasets":[{"label":"A","data":[0,10,0,10,0]}]}'));
    const stage = sized(v);
    const { ctx: c2, calls } = fake2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => c2 as never);
    surfaces[0]!.opts.onFallback2d(stage, 'この端末のブラウザでは GPU の描画が使えないため、簡易表示にしています');
    expect(v.state).toBe('fallback');
    expect(stage.querySelector('[data-pkc-gpu-chart-canvas2d]')).not.toBeNull();
    expect(v.element.querySelector('[data-pkc-gpu-chart-note]')!.textContent).toContain('簡易表示');
    expect(v.element.querySelector('[data-pkc-gpu-chart-info="backend"]')!.textContent).toBe('簡易表示(2D)');
    expect(calls.lineTo).toBeGreaterThanOrEqual(4);

    const home = v.range;
    const btn = (op: string) => v.element.querySelector<HTMLButtonElement>(`[data-pkc-gpu-chart-op="${op}"]`)!;
    btn('zoom-in').click();
    expect(v.range.xMax - v.range.xMin).toBeLessThan(home.xMax - home.xMin);
    btn('reset').click();
    expect(v.range).toEqual(home);
    btn('zoom-out').click();
    expect(v.range).toEqual(home); // 全体より外へは縮小しない

    // ホバー: x = 1, y = 10 の点の上へ(描画域は layoutChart と同じ式)
    const { layoutChart } = await import('../../src/adapter/ui/render/gpu-chart');
    const { dataToPxX, dataToPxY } = await import('../../src/features/chart/gpu-chart-viewport');
    const layout = layoutChart(c2 as never, spec('{"type":"line","title":"売上","datasets":[{"label":"A","data":[0,10,0,10,0]}]}'), home, 600, 320);
    stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: dataToPxX(1, home, layout.rect), clientY: dataToPxY(10, home, layout.rect) + 2 }));
    expect(v.element.querySelector('[data-pkc-gpu-chart-info="hover"]')!.textContent).toBe('A: x 1、y 10');
    stage.dispatchEvent(new PointerEvent('pointerleave', {}));
    expect(v.element.querySelector('[data-pkc-gpu-chart-info="hover"]')!.textContent).toBe('');

    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })));
    btn('save').click();
    await flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toMatch(/^売上-\d{8}\.png$/);
    v.dispose();
  });

  it('PNG で保存は ObjectURL を作って、寿命の終わりに必ず revoke する(実物の保存口)', async () => {
    setGpuChartTestHooks({ createSurface: fakeFactory });
    vi.useFakeTimers();
    const v = mountGpuChart(host, spec('{"type":"bar","labels":["a"],"datasets":[{"data":[1]}]}'));
    sized(v);
    const { ctx: c2 } = fake2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => c2 as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })));
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await v.savePng();
    expect(create).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1500);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    v.dispose();
  });
});

describe('添付の CSV(`"source": "asset:鍵"`)', () => {
  const placeholder = (src: string): void => {
    host.innerHTML = renderMarkdown('```chart\n' + src + '\n```\n');
  };

  it('呼び側の口で引いて描く', async () => {
    placeholder('{"type":"line","source":"asset:ast-csv","yColumns":["v"]}');
    const getAssetBlob = vi.fn(async (key: string) => (key === 'ast-csv' ? { blob: new Blob(['t,v\n0,1\n1,3\n2,2\n']) } : null));
    const scope = hydrateGpuChart(host, { getAssetBlob });
    await flush();
    expect(getAssetBlob).toHaveBeenCalledWith('ast-csv');
    expect(surfaces).toHaveLength(1);
    expect(host.querySelector('[data-pkc-gpu-chart-info="points"]')!.textContent).toBe('3 点');
    scope.dispose();
  });

  it('見つからない・口が無いときは理由を出し、描画面を作らない', async () => {
    placeholder('{"type":"line","source":"asset:missing"}');
    const scope = hydrateGpuChart(host, { getAssetBlob: async () => null });
    await flush();
    const el = host.querySelector(`[${GPU_CHART_SRC_ATTR}]`)!;
    expect(el.getAttribute('data-pkc-gpu-chart-state')).toBe('failed');
    expect(el.getAttribute('data-pkc-gpu-chart-error')).toContain('添付(missing)が見つかりません');
    expect(surfaces).toHaveLength(0);
    scope.dispose();

    host.innerHTML = '';
    placeholder('{"type":"line","source":"asset:missing"}');
    const s2 = hydrateGpuChart(host);
    await flush();
    expect(host.querySelector(`[${GPU_CHART_SRC_ATTR}]`)!.getAttribute('data-pkc-gpu-chart-error')).toContain('読み込めません');
    s2.dispose();
  });

  it('読めない JSON は理由を出す(黙って空にしない)', async () => {
    host.innerHTML = renderMarkdown('```chart live\n{"type":"line"\n```\n');
    const scope = hydrateGpuChart(host);
    await flush();
    expect(host.querySelector(`[${GPU_CHART_SRC_ATTR}]`)!.getAttribute('data-pkc-gpu-chart-error')).toContain('JSON として読めません');
    scope.dispose();
  });
});

describe('同じ器を埋め直す', () => {
  it('塊を畳んだ後に同じ器を渡すと、もう一度置く(「済み」の印で空のまま飛ばさない)', async () => {
    host.innerHTML = renderMarkdown('```chart live\n{"type":"line","datasets":[{"data":[1,2]}]}\n```\n');
    const a = hydrateGpuChart(host);
    await flush();
    expect(host.querySelectorAll('[data-pkc-gpu-chart]')).toHaveLength(1);
    a.dispose();
    expect(host.querySelectorAll('[data-pkc-gpu-chart]')).toHaveLength(0);
    const b = hydrateGpuChart(host);
    await flush();
    expect(host.querySelectorAll('[data-pkc-gpu-chart]')).toHaveLength(1);
    expect(surfaces).toHaveLength(2);
    b.dispose();
  });
});

describe('棒の当たり判定', () => {
  it('系列を横にずらして描いた位置で当たる', async () => {
    const src = '{"type":"bar","labels":["a","b"],"datasets":[{"label":"P","data":[5,5]},{"label":"Q","data":[5,5]}]}';
    const v = mountGpuChart(host, spec(src));
    const stage = sized(v);
    const { ctx: c2 } = fake2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => c2 as never);
    surfaces[0]!.opts.onFallback2d(stage, '理由');
    const { layoutChart } = await import('../../src/adapter/ui/render/gpu-chart');
    const { dataToPxX, dataToPxY } = await import('../../src/features/chart/gpu-chart-viewport');
    const layout = layoutChart(c2 as never, spec(src), v.range, 600, 320);
    // 区分 1 の Q の棒は x = 1 + 0.2 に描く
    stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: dataToPxX(1.2, v.range, layout.rect), clientY: dataToPxY(5, v.range, layout.rect) }));
    expect(v.element.querySelector('[data-pkc-gpu-chart-info="hover"]')!.textContent).toBe('Q: x b、y 5');
    v.dispose();
  });
});

describe('置くのは見えてから・打鍵が止まってから', () => {
  it('画面の外の器にはビューアも描画面も作らない(見えたら置く)', async () => {
    ioAuto = false;
    host.innerHTML = renderMarkdown('```chart live\n{"type":"line","datasets":[{"data":[1,2]}]}\n```\n');
    const scope = hydrateGpuChart(host);
    await flush();
    expect(surfaces).toHaveLength(0);
    expect(host.querySelector('[data-pkc-gpu-chart]')).toBeNull();
    ioInstances[0]!.show();
    expect(surfaces).toHaveLength(1);
    scope.dispose();
  });

  it('打鍵中は置くのを待つ(静かになってから置く)', async () => {
    vi.useFakeTimers();
    noteTyping(performance.now());
    host.innerHTML = renderMarkdown('```chart live\n{"type":"line","datasets":[{"data":[1,2]}]}\n```\n');
    const scope = hydrateGpuChart(host);
    expect(surfaces).toHaveLength(0);
    vi.advanceTimersByTime(1100);
    expect(surfaces).toHaveLength(1);
    scope.dispose();
    resetTyping();
  });
});

describe('dispose / prune', () => {
  it('DOM から外れた器のビューアを畳む・dispose で listener も外す', async () => {
    host.innerHTML = renderMarkdown('```chart live\n{"type":"line","datasets":[{"data":[1,2]}]}\n```\n');
    const scope = hydrateGpuChart(host);
    await flush();
    expect(scope.prune()).toBe(1);
    const removeSpy = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    host.innerHTML = '';
    expect(scope.prune()).toBe(0);
    expect(surfaces[0]!.disposed).toBe(1);
    expect(removeSpy.mock.calls.length).toBeGreaterThanOrEqual(10);
    scope.dispose();
  });
});

describe('書き出しの焼き込み', () => {
  it('本文に書いたデータは 2D で PNG に焼く・添付の CSV は断る', async () => {
    const { ctx: c2, calls } = fake2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => c2 as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })));
    const r = await renderGpuChartPng('{"type":"heatmap","matrix":[[1,2],[3,4]]}');
    expect(r.cssWidth).toBe(720);
    expect(calls.fillRect).toBeGreaterThanOrEqual(4);
    await expect(renderGpuChartPng('{"type":"line","source":"asset:k"}')).rejects.toThrow('添付の CSV');
  });
});

// ───────────────────────────── v4.1 PR-8: スクロール連動・補間・印刷の静止画

/** コマの予約を手で回す(rAF の本数を数える)。 */
function rafQueue(): { pending: Map<number, (t: number) => void>; run(t: number): void; hooks: { raf: (cb: (t: number) => void) => number; caf: (id: number) => void } } {
  const pending = new Map<number, (t: number) => void>();
  let id = 0;
  return {
    pending,
    run(t) {
      const cbs = [...pending.values()];
      pending.clear();
      for (const cb of cbs) cb(t);
    },
    hooks: {
      raf: (cb) => {
        id += 1;
        pending.set(id, cb);
        return id;
      },
      caf: (i) => {
        pending.delete(i);
      },
    },
  };
}

const BARS = (vals: number[]): GpuChartSpec =>
  spec(JSON.stringify({ type: 'bar', engine: 'gpu', labels: vals.map((_, i) => `L${i}`), datasets: [{ label: '値', data: vals }] }));

describe('🔴 データの切り替えの補間(静止時の rAF = 0)', () => {
  it('animate: 220ms だけコマを回し、終わったら予約が 0 本・最後は行き先のデータ', () => {
    const q = rafQueue();
    setGpuChartTestHooks({ createSurface: fakeFactory, ...q.hooks, reducedMotion: () => false });
    const v = mountGpuChart(host, BARS([1, 2, 3]));
    sized(v);
    const s = surfaces[0]!;
    expect(q.pending.size).toBe(0); // 置いただけではコマを回さない
    const before = s.invalidates;
    v.updateData(BARS([10, 20, 30]), { animate: true, resetViewport: true });
    expect(v.animating).toBe(true);
    expect(q.pending.size).toBe(1);
    q.run(1000); // 始まりの時刻
    q.run(1100); // 途中
    expect(v.animating).toBe(true);
    expect(q.pending.size).toBe(1);
    q.run(1000 + 220);
    expect(v.animating).toBe(false);
    expect(q.pending.size).toBe(0);
    expect(s.invalidates - before).toBe(3); // 途中 2 コマ + 最後の 1 コマ
    // 静止したら何もしない
    q.run(2000);
    expect(s.invalidates - before).toBe(3);
    expect(v.element.querySelector('[data-pkc-gpu-chart-stage]')!.getAttribute('aria-label')).toContain('値');
    v.dispose();
  });

  it('prefers-reduced-motion: reduce では補間せず即時に切り替える(rAF 0 本・invalidate 1 回)', () => {
    const q = rafQueue();
    setGpuChartTestHooks({ createSurface: fakeFactory, ...q.hooks, reducedMotion: () => true });
    const v = mountGpuChart(host, BARS([1, 2, 3]));
    const s = surfaces[0]!;
    const before = s.invalidates;
    v.updateData(BARS([10, 20, 30]), { animate: true });
    expect(q.pending.size).toBe(0);
    expect(v.animating).toBe(false);
    expect(s.invalidates - before).toBe(1);
    v.dispose();
  });

  it('形が合わない(点の数が違う)ときは即時・途中の割り込みは古い予約を消す・dispose でも消す', () => {
    const q = rafQueue();
    setGpuChartTestHooks({ createSurface: fakeFactory, ...q.hooks, reducedMotion: () => false });
    const v = mountGpuChart(host, BARS([1, 2, 3]));
    v.updateData(BARS([1, 2]), { animate: true });
    expect(q.pending.size).toBe(0);
    v.updateData(BARS([5, 6]), { animate: true });
    expect(q.pending.size).toBe(1);
    v.updateData(BARS([7, 8]), { animate: true }); // 割り込み
    expect(q.pending.size).toBe(1);
    v.dispose();
    expect(q.pending.size).toBe(0);
    expect(v.animating).toBe(false);
  });
});

/** 現在地の見張りを動かせる IntersectionObserver(器の「見えた」はすぐ・本文の目印は手で報告)。 */
let ctxIos: CtxIo[] = [];
class CtxIo {
  targets = new Set<Element>();
  disconnected = false;
  constructor(
    readonly cb: (e: unknown[]) => void,
    readonly opts: { rootMargin?: string } = {},
  ) {
    ctxIos.push(this);
  }
  get forContext(): boolean {
    return this.opts.rootMargin === CHART_CONTEXT_ROOT_MARGIN;
  }
  observe(el: Element): void {
    this.targets.add(el);
    if (!this.forContext) this.cb([{ target: el, isIntersecting: true, boundingClientRect: { top: 0, bottom: 1 }, rootBounds: { top: 0 } }]);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.disconnected = true;
    this.targets.clear();
  }
  /** `at` 番目の目印までを読んだ(それより前は上へ過ぎ、at は帯の中)。 */
  readTo(els: Element[], at: number): void {
    this.cb(
      els.map((target, i) => ({
        target,
        isIntersecting: i === at,
        boundingClientRect: i < at ? { top: -200, bottom: -100 } : { top: 600, bottom: 620 },
        rootBounds: { top: 0 },
      })),
    );
  }
}

const BOUND_BODY = [
  '```chart live',
  '{"type":"bar","title":"四半期","bind":"heading"}',
  '```',
  '## Q1',
  '| 月 | 売上 |',
  '|---|---|',
  '| 1月 | 10 |',
  '| 2月 | 20 |',
  '## Q2',
  '| 月 | 件数 |',
  '|---|---|',
  '| 4月 | 3 |',
  '| 5月 | 4 |',
  '## Q3',
  '表はありません',
].join('\n');

function boundNote(body = BOUND_BODY): { root: HTMLElement; scope: ReturnType<typeof hydrateGpuChart>; chart: HTMLElement; heads: Element[] } {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-field', 'detail-body');
  root.className = 'pkc-md-rendered';
  root.innerHTML = renderMarkdown(body, { sourceLineAnchors: true });
  host.append(root);
  const scope = hydrateGpuChart(root, { getNoteBody: () => body, noteLid: 'n1', scrollRoot: null });
  const chart = root.querySelector<HTMLElement>(`[${GPU_CHART_SRC_ATTR}]`)!;
  return { root, scope, chart, heads: [...root.querySelectorAll('h2')] };
}

const keyOf = (chart: HTMLElement): string | null => chart.querySelector('[data-pkc-gpu-chart]')!.getAttribute('data-pkc-gpu-chart-bind-key');
const ariaOf = (chart: HTMLElement): string => chart.querySelector('[data-pkc-gpu-chart-stage]')!.getAttribute('aria-label') ?? '';
const click = (chart: HTMLElement, sel: string): void => chart.querySelector<HTMLButtonElement>(sel)!.click();

describe('🔴 スクロール連動(見出しの節)', () => {
  beforeEach(() => {
    ctxIos = [];
    vi.stubGlobal('IntersectionObserver', CtxIo);
    setGpuChartTestHooks({ createSurface: fakeFactory, reducedMotion: () => true });
  });

  it('読み進めると連動先とデータが切り替わる・データの無い節は古い絵を隠して理由を出す', () => {
    const { scope, chart, heads } = boundNote();
    expect(chart.getAttribute('data-pkc-gpu-chart-state')).toBe('ready');
    expect(chart.getAttribute('data-pkc-gpu-chart-bind')).toBe('heading');
    const label = chart.querySelector('[data-pkc-field="gpu-chart-bind-label"]')!;
    expect(label.textContent).toBe('連動: Q1 (1 / 3)');
    expect(ariaOf(chart)).toContain('売上');
    const io = ctxIos.find((i) => i.forContext)!;
    expect([...io.targets]).toEqual(heads);
    io.readTo(heads, 1);
    expect(label.textContent).toBe('連動: Q2 (2 / 3)');
    expect(keyOf(chart)).toBe('1');
    expect(ariaOf(chart)).toContain('件数');
    io.readTo(heads, 2);
    const view = chart.querySelector('[data-pkc-gpu-chart]')!;
    expect(view.hasAttribute('data-pkc-gpu-chart-empty')).toBe(true);
    expect(view.querySelector('[data-pkc-field="gpu-chart-empty"]')!.textContent).toBe('この節には対象データがありません');
    io.readTo(heads, 0);
    expect(view.hasAttribute('data-pkc-gpu-chart-empty')).toBe(false);
    expect(view.querySelector('[data-pkc-field="gpu-chart-empty"]')).toBeNull();
    expect(ariaOf(chart)).toContain('売上');
    scope.dispose();
  });

  it('固定中はスクロールしても切り替わらず、追従に戻すと今読んでいる節へ揃う', () => {
    const { scope, chart, heads } = boundNote();
    const io = ctxIos.find((i) => i.forContext)!;
    const follow = chart.querySelector<HTMLButtonElement>('[data-pkc-field="gpu-chart-follow"]')!;
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    expect(follow.textContent).toBe('追従 ON');
    follow.click();
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    expect(follow.textContent).toBe('固定中');
    io.readTo(heads, 1);
    expect(keyOf(chart)).toBe('0');
    follow.click();
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    expect(keyOf(chart)).toBe('1');
    scope.dispose();
  });

  it('前へ / 次へ: 固定中はグラフだけめくる・追従中は本文もその見出しへ動かす', () => {
    const { scope, chart, heads } = boundNote();
    const scrolled: Element[] = [];
    for (const h of heads) (h as HTMLElement).scrollIntoView = (() => scrolled.push(h)) as never;
    const prev = chart.querySelector<HTMLButtonElement>('[data-pkc-gpu-chart-op="bind-prev"]')!;
    expect(prev.disabled).toBe(true);
    click(chart, '[data-pkc-gpu-chart-op="bind-next"]');
    expect(keyOf(chart)).toBe('1');
    expect(scrolled).toEqual([heads[1]]);
    click(chart, '[data-pkc-field="gpu-chart-follow"]'); // 固定
    click(chart, '[data-pkc-gpu-chart-op="bind-next"]');
    expect(keyOf(chart)).toBe('2');
    expect(scrolled).toHaveLength(1);
    const next = chart.querySelector<HTMLButtonElement>('[data-pkc-gpu-chart-op="bind-next"]')!;
    expect(next.disabled).toBe(true);
    click(chart, '[data-pkc-gpu-chart-op="bind-jump"]'); // ラベルで本文へ
    expect(scrolled).toEqual([heads[1], heads[2]]);
    scope.dispose();
  });

  /** 本文の根の直下で、グラフの器を包む塊(上端に固定する物)。 */
  const topBlock = (root: HTMLElement, chart: HTMLElement): Element => [...root.children].find((c) => c.contains(chart))!;

  it('上端に固定 ⇄ 固定を解除(双方向)── 固定するのは本文の根の直下の塊', () => {
    const { root, scope, chart } = boundNote();
    const block = topBlock(root, chart);
    expect(block).not.toBe(chart); // 器は差分描画の塊に包まれている(器に付けても sticky は効かない)
    const stick = chart.querySelector<HTMLButtonElement>('[data-pkc-field="gpu-chart-sticky"]')!;
    expect(block.classList.contains('pkc-gpu-chart-sticky')).toBe(true); // 既定は固定
    expect(chart.classList.contains('pkc-gpu-chart-sticky')).toBe(false);
    expect(stick.getAttribute('aria-pressed')).toBe('true');
    expect(stick.textContent).toBe('固定を解除');
    stick.click();
    expect(block.classList.contains('pkc-gpu-chart-sticky')).toBe(false);
    expect(stick.getAttribute('aria-pressed')).toBe('false');
    expect(stick.textContent).toBe('上端に固定');
    stick.click();
    expect(block.classList.contains('pkc-gpu-chart-sticky')).toBe(true);
    scope.dispose();
    expect(block.classList.contains('pkc-gpu-chart-sticky')).toBe(false);
  });

  it('包む塊が何段あっても、本文の根の直下の塊に付ける', () => {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-field', 'detail-body');
    root.innerHTML = renderMarkdown(BOUND_BODY, { sourceLineAnchors: true });
    const chartHost = root.querySelector<HTMLElement>(`[${GPU_CHART_SRC_ATTR}]`)!;
    const extra = document.createElement('div');
    chartHost.replaceWith(extra);
    extra.append(chartHost);
    host.append(root);
    const scope = hydrateGpuChart(root, { getNoteBody: () => BOUND_BODY, noteLid: 'n1', scrollRoot: null });
    const block = topBlock(root, chartHost);
    expect(block.classList.contains('pkc-gpu-chart-sticky')).toBe(true);
    expect(extra.classList.contains('pkc-gpu-chart-sticky')).toBe(false);
    expect(root.querySelectorAll('.pkc-gpu-chart-sticky')).toHaveLength(1);
    scope.dispose();
  });

  it('"sticky": false なら最初は流れる配置', () => {
    const { root, scope, chart } = boundNote(BOUND_BODY.replace('"bind":"heading"', '"bind":{"mode":"heading","sticky":false}'));
    expect(topBlock(root, chart).classList.contains('pkc-gpu-chart-sticky')).toBe(false);
    expect(chart.querySelector('[data-pkc-field="gpu-chart-sticky"]')!.getAttribute('aria-pressed')).toBe('false');
    scope.dispose();
  });

  it('🔴 dispose / 器が外れたら見張りを止める・bind の無いノートでは見張りを 1 つも作らない', () => {
    const { scope, chart } = boundNote();
    expect(liveChartContextWatches()).toBe(1);
    chart.remove();
    scope.prune();
    expect(liveChartContextWatches()).toBe(0);
    expect(ctxIos.find((i) => i.forContext)!.disconnected).toBe(true);
    scope.dispose();
    ctxIos = [];
    const plain = boundNote('## A\n```chart live\n{"type":"bar","datasets":[{"data":[1,2]}]}\n```\n');
    expect(ctxIos.some((i) => i.forContext)).toBe(false);
    expect(liveChartContextWatches()).toBe(0);
    plain.scope.dispose();
  });

  it('本文を渡さない面(埋め込み・プレビュー)では連動しない ── データが無ければ理由を出す', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(BOUND_BODY);
    host.append(root);
    const scope = hydrateGpuChart(root);
    await flush();
    const chart = root.querySelector(`[${GPU_CHART_SRC_ATTR}]`)!;
    expect(chart.getAttribute('data-pkc-gpu-chart-state')).toBe('failed');
    expect(chart.getAttribute('data-pkc-gpu-chart-error')).toContain('ノートを読む画面');
    expect(ctxIos.some((i) => i.forContext)).toBe(false);
    scope.dispose();
  });

  it('連動するデータが本文に 1 つも無ければ、書き方を添えて理由を出す', () => {
    const { scope, chart } = boundNote('```chart live\n{"type":"bar","bind":"page"}\n```\n本文だけ\n');
    expect(chart.getAttribute('data-pkc-gpu-chart-state')).toBe('failed');
    expect(chart.getAttribute('data-pkc-gpu-chart-error')).toContain('+++');
    scope.dispose();
  });

  it('🔴 同じ節にいたまま表を保存しても、その場で新しい数に描き直す(古い数のまま残さない)', async () => {
    let body = BOUND_BODY;
    const root = document.createElement('div');
    root.setAttribute('data-pkc-field', 'detail-body');
    root.innerHTML = renderMarkdown(body, { sourceLineAnchors: true });
    host.append(root);
    const scope = hydrateGpuChart(root, { getNoteBody: () => body, noteLid: 'n1', scrollRoot: null });
    const chart = root.querySelector<HTMLElement>(`[${GPU_CHART_SRC_ATTR}]`)!;
    const io = ctxIos.find((i) => i.forContext)!;
    io.readTo([...root.querySelectorAll('h2')], 1);
    expect(ariaOf(chart)).toContain('件数');
    // 保存 ── 表の塊だけが差し替わる(見出しとグラフの塊はそのまま・現在地も同じ)
    body = body.replace('| 月 | 件数 |', '| 月 | 来場 |');
    const table = root.querySelectorAll('table')[1]!;
    const fresh = document.createElement('div');
    (table.closest('[data-pkc-field="detail-body"] > *') ?? table).replaceWith(fresh);
    await vi.waitFor(() => expect(ariaOf(chart)).toContain('来場'));
    expect(keyOf(chart)).toBe('1');
    scope.dispose();
  });

  it('🔴 本文の見出しの数と区切りの数が合わないときは、隣の節のデータを描かない', () => {
    const { root, scope, chart } = boundNote();
    // 本文の外の数え方で h2 が 1 つ増えた(リストの中の見出しなど)── 先頭に差し込む
    const extra = document.createElement('h2');
    extra.setAttribute('data-pkc-source-line', '1');
    extra.textContent = '別の見出し';
    const firstHead = root.querySelector('h2')!;
    (firstHead.closest('[data-pkc-field="detail-body"] > *') ?? firstHead).before(extra);
    const io = ctxIos.find((i) => i.forContext)!;
    return vi.waitFor(() => expect(io.targets.size).toBe(4)).then(() =>
      new Promise<void>((done) => {
        const heads = [...root.querySelectorAll('h2')];
        expect(heads).toHaveLength(4);
        io.readTo(heads, 2); // DOM では 3 番目 = 本文の Q2(番号で引くと Q3 を描いてしまう)
        expect(chart.querySelector('[data-pkc-field="gpu-chart-bind-label"]')!.textContent).toBe('連動: Q2 (2 / 3)');
        expect(ariaOf(chart)).toContain('件数'); // 見出しの字で引き直した
        io.readTo(heads, 0); // 本文に無い見出し ── 特定できないと出す
        const view = chart.querySelector('[data-pkc-gpu-chart]')!;
        expect(view.hasAttribute('data-pkc-gpu-chart-empty')).toBe(true);
        expect(view.querySelector('[data-pkc-field="gpu-chart-empty"]')!.textContent).toContain('特定できません');
        scope.dispose();
        done();
      }),
    );
  });

  it('本文が変わったら(保存)次の現在地で時点のデータを作り直す', () => {
    let body = BOUND_BODY;
    const root = document.createElement('div');
    root.setAttribute('data-pkc-field', 'detail-body');
    root.innerHTML = renderMarkdown(body, { sourceLineAnchors: true });
    host.append(root);
    const scope = hydrateGpuChart(root, { getNoteBody: () => body, noteLid: 'n1', scrollRoot: null });
    const chart = root.querySelector<HTMLElement>(`[${GPU_CHART_SRC_ATTR}]`)!;
    body = body.replace('| 月 | 件数 |', '| 月 | 来客 |');
    const io = ctxIos.find((i) => i.forContext)!;
    io.readTo([...root.querySelectorAll('h2')], 1);
    expect(ariaOf(chart)).toContain('来客');
    scope.dispose();
  });
});

describe('🔴 印刷の前の静止画(flush)', () => {
  it('画面の外の器も置いてから 2D の PNG を差す・GPU には触らない・刷り終えたら外して revoke', async () => {
    ioAuto = false;
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('```chart live\n{"type":"line","datasets":[{"label":"温度","data":[1,3,2]}]}\n```\n');
    host.append(root);
    const scope = hydrateGpuChart(root);
    expect(surfaces).toHaveLength(0); // まだ見えていない
    const { ctx: c2 } = fake2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => c2 as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })));
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:print');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await hydrateAllNow(root); // 印刷が呼ぶ口(名簿に載っている)
    expect(surfaces).toHaveLength(1);
    const s = surfaces[0]!;
    const inv = s.invalidates;
    const img = root.querySelector<HTMLImageElement>('img.pkc-gpu-chart-print-img')!;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('blob:print');
    expect(img.alt).toContain('温度');
    expect(create).toHaveBeenCalledTimes(1);
    expect(s.invalidates).toBe(inv);
    expect(s.disposed).toBe(0);
    // もう一度刷る用意 ── 古い静止画は返して差し替える(積もらせない)
    await scope.flush!(root);
    expect(root.querySelectorAll('img.pkc-gpu-chart-print-img')).toHaveLength(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('afterprint'));
    expect(root.querySelector('img.pkc-gpu-chart-print-img')).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(2);
    scope.dispose();
  });

  it('補間の途中で焼くと、途中のコマではなく行き先を焼く・刷り終えた口は 1 本だけ', async () => {
    const q = rafQueue();
    setGpuChartTestHooks({ createSurface: fakeFactory, ...q.hooks, reducedMotion: () => false });
    const v = mountGpuChart(host, BARS([1, 2, 3]));
    sized(v);
    const { ctx: c2 } = fake2d();
    // 目盛りの字を拾う(焼いた絵の y の範囲 = 途中のコマか行き先かの観測点)
    const texts: string[] = [];
    const rects: Array<[number, number]> = [];
    const c2t = new Proxy(c2, {
      get(t, k: string) {
        if (k === 'fillText') return (str: string) => texts.push(str);
        if (k === 'fillRect') return (_x: number, _y: number, w: number, h: number) => rects.push([w, h]);
        return (t as Record<string, unknown>)[k];
      },
      set(t, k: string, v) {
        (t as Record<string, unknown>)[k] = v;
        return true;
      },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => c2t as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })));
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:p');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const next = spec(JSON.stringify({ type: 'bar', engine: 'gpu', labels: ['L0', 'L1', 'L2'], datasets: [{ label: '行き先', data: [100, 100, 100] }] }));
    v.updateData(next, { animate: true, resetViewport: true });
    q.run(0);
    q.run(50); // 途中
    expect(v.animating).toBe(true);
    texts.length = 0;
    rects.length = 0;
    expect(await v.bakePrintImage()).toBe(true);
    expect(host.querySelector<HTMLImageElement>('img.pkc-gpu-chart-print-img')!.alt).toContain('行き先');
    // 行き先(100)の目盛りまで出ている ── 途中のコマ(まだ 60 前後)ではない
    expect(texts).toContain('100');
    // 棒の高さも行き先(100 ≒ 描画域の 9 割超)── 途中のコマ(半分ほど)ではない。⚠ 地の塗り(幅いっぱい)は除く
    const plotH = 320 - 8 - 24;
    expect(rects.filter(([w, h]) => w < 500 && h > plotH * 0.85).length).toBe(3);
    v.dispose();
    expect(host.querySelector('img.pkc-gpu-chart-print-img')).toBeNull();

    // 刷り直しても afterprint の口は 1 本
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('```chart live\n{"type":"line","datasets":[{"data":[1,3,2]}]}\n```\n');
    host.append(root);
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const scope = hydrateGpuChart(root);
    await scope.flush!(root);
    await scope.flush!(root);
    const adds = add.mock.calls.filter((c) => (c[0] as string) === 'afterprint').length;
    const removes = remove.mock.calls.filter((c) => (c[0] as string) === 'afterprint').length;
    expect(adds - removes).toBe(1);
    scope.dispose();
    expect(remove.mock.calls.filter((c) => (c[0] as string) === 'afterprint').length - removes).toBe(1);
  });

  it('@media print で canvas の代わりに静止画を出す(画面では出さない)', () => {
    const css = readFileSync(resolve(__dirname, '../../src/styles/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/(^|\n)\.pkc-gpu-chart-print-img\s*\{\s*display:\s*none;/);
    // 印刷の規則は app.css の規約どおり末尾の @media print にある(静止画を出す規則を持つ @media print を探す)
    const blocks = css.split('@media print').slice(1);
    const media = blocks.find((b) => b.includes('.pkc-gpu-chart-print-img')) ?? '';
    expect(media).not.toBe('');
    expect(media).toMatch(/\.pkc-gpu-chart:has\(> \.pkc-gpu-chart-print-img\) > \.pkc-gpu-chart-stage\s*\{\s*display:\s*none;/);
    expect(media).toMatch(/\.pkc-gpu-chart-print-img\s*\{\s*display:\s*block;/);
  });
});
