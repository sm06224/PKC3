/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GPU_PORTABLE_UNAVAILABLE,
  GPU_UNSUPPORTED,
  GpuLeaseManager,
  createGpuSurface,
  detectGpuCapabilities,
  gpuLeaseStats,
  loadThree,
  probeWebGl2,
  resetGpuCapabilityCache,
  resetGpuLeaseForTest,
  setThreeLoaderForTest,
  type GpuCapabilities,
  type GpuContext,
  type GpuPoster,
  type GpuSession,
  type Three,
  type ThreeWebGpu,
} from '../../src/adapter/platform/render/gpu-lease';

// ───────────── 偽の Three.js(renderer の呼ばれ方だけを記録する)

interface FakeRenderer {
  kind: 'webgl' | 'webgpu';
  disposed: number;
  contextLost: number;
  deviceDestroyed: number;
  setPixelRatio: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
  dispose(): void;
  forceContextLoss(): void;
  init?(): Promise<unknown>;
  backend?: { device: { destroy(): void } };
}

const renderers: FakeRenderer[] = [];

function fakeThree(): Three {
  class WebGLRenderer implements FakeRenderer {
    kind = 'webgl' as const;
    disposed = 0;
    contextLost = 0;
    deviceDestroyed = 0;
    setPixelRatio = vi.fn();
    setSize = vi.fn();
    constructor(readonly params: { canvas: HTMLCanvasElement }) {
      renderers.push(this);
    }
    dispose(): void {
      this.disposed += 1;
    }
    forceContextLoss(): void {
      this.contextLost += 1;
    }
  }
  return { WebGLRenderer } as unknown as Three;
}

function fakeThreeWebGpu(initFails: boolean): ThreeWebGpu {
  class WebGPURenderer implements FakeRenderer {
    kind = 'webgpu' as const;
    disposed = 0;
    contextLost = 0;
    deviceDestroyed = 0;
    setPixelRatio = vi.fn();
    setSize = vi.fn();
    backend = { device: { destroy: (): void => void (this.deviceDestroyed += 1) } };
    constructor() {
      renderers.push(this);
    }
    init(): Promise<unknown> {
      return initFails ? Promise.reject(new Error('アダプタが取れない')) : Promise.resolve(this);
    }
    dispose(): void {
      this.disposed += 1;
    }
    forceContextLoss(): void {
      this.contextLost += 1;
    }
  }
  return { WebGPURenderer } as unknown as ThreeWebGpu;
}

// ───────────── 偽の rAF / タイマー / IntersectionObserver

class Harness {
  frames: Array<{ id: number; cb: () => void }> = [];
  timers: Array<{ id: number; fn: () => void; at: number }> = [];
  t = 0;
  seq = 0;
  ioCallbacks: Array<(entries: Array<{ target: Element; isIntersecting: boolean }>) => void> = [];
  observed = new Set<Element>();
  ioDisconnected = 0;

  requestFrame = (cb: () => void): unknown => {
    const id = ++this.seq;
    this.frames.push({ id, cb });
    return id;
  };
  cancelFrame = (h: unknown): void => {
    this.frames = this.frames.filter((f) => f.id !== h);
  };
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ id, fn, at: this.t + ms });
    return id;
  };
  clearTimer = (h: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  now = (): number => this.t;

  /** 予約されたコマを 1 回分だけ進める。 */
  flushFrame(): number {
    const due = this.frames;
    this.frames = [];
    for (const f of due) f.cb();
    return due.length;
  }

  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const x of due) x.fn();
  }

  IntersectionObserver = ((): unknown => {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const h = this;
    return class {
      constructor(cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
        h.ioCallbacks.push(cb);
      }
      observe(el: Element): void {
        h.observed.add(el);
      }
      unobserve(el: Element): void {
        h.observed.delete(el);
      }
      disconnect(): void {
        h.ioDisconnected += 1;
        h.observed.clear();
      }
    };
  })();

  intersect(target: Element, isIntersecting: boolean): void {
    for (const cb of this.ioCallbacks) cb([{ target, isIntersecting }]);
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

let pageState: 'visible' | 'hidden' = 'visible';

function setPageVisibility(v: 'visible' | 'hidden'): void {
  pageState = v;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  renderers.length = 0;
  resetGpuLeaseForTest();
  pageState = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => pageState });
  document.body.innerHTML = '';
});

afterEach(() => {
  resetGpuLeaseForTest();
});

interface Built {
  h: Harness;
  mgr: GpuLeaseManager;
  loadThree: ReturnType<typeof vi.fn>;
  loadThreeWebGpu: ReturnType<typeof vi.fn>;
  urls: { created: string[]; revoked: string[] };
}

function build(caps: GpuCapabilities, opts: { webgpuInitFails?: boolean; webglFails?: boolean; useIo?: boolean } = {}): Built {
  const h = new Harness();
  const loadThreeFn = vi.fn(() =>
    opts.webglFails ? Promise.reject(new Error('chunk が取れない')) : Promise.resolve(fakeThree()),
  );
  const loadThreeWebGpuFn = vi.fn(() => Promise.resolve(fakeThreeWebGpu(opts.webgpuInitFails === true)));
  setThreeLoaderForTest({ loadThree: loadThreeFn, loadThreeWebGpu: loadThreeWebGpuFn });
  const urls = { created: [] as string[], revoked: [] as string[] };
  const mgr = new GpuLeaseManager({
    capabilities: () => Promise.resolve(caps),
    requestFrame: h.requestFrame,
    cancelFrame: h.cancelFrame,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
    now: h.now,
    doc: document,
    IntersectionObserver: opts.useIo ? (h.IntersectionObserver as never) : null,
    devicePixelRatio: () => 3,
    createObjectURL: () => {
      const u = `blob:poster-${urls.created.length}`;
      urls.created.push(u);
      return u;
    },
    revokeObjectURL: (u) => void urls.revoked.push(u),
  });
  return { h, mgr, loadThree: loadThreeFn, loadThreeWebGpu: loadThreeWebGpuFn, urls };
}

interface Tracked {
  host: HTMLElement;
  session: GpuSession & { render: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  contexts: GpuContext[];
  fallback: ReturnType<typeof vi.fn>;
}

function surfaceOf(mgr: GpuLeaseManager, poster?: () => GpuPoster | Promise<GpuPoster>): Tracked & { s: ReturnType<GpuLeaseManager['createSurface']> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const contexts: GpuContext[] = [];
  const session = {
    render: vi.fn(),
    dispose: vi.fn(),
    ...(poster ? { capturePoster: poster } : {}),
  };
  const fallback = vi.fn();
  const s = mgr.createSurface({
    host,
    onAcquire: (ctx) => {
      contexts.push(ctx);
      return session;
    },
    onFallback2d: fallback,
  });
  return { s, host, session, contexts, fallback };
}

const WEBGL_ONLY: GpuCapabilities = { portable: false, webgpu: false, webgl2: true };
const BOTH: GpuCapabilities = { portable: false, webgpu: true, webgl2: true };

describe('🔴 定常負荷ゼロ — 作っただけでは何も起きない', () => {
  it('描画面を作った直後: Three.js 未読込・コンテキスト 0・予約されたコマ 0', () => {
    const b = build(WEBGL_ONLY);
    const t = surfaceOf(b.mgr);
    expect(b.mgr.stats()).toEqual({
      threeLoaded: false,
      activeContexts: 0,
      scheduledFrames: 0,
      backend: null,
      totalDisposals: 0,
    });
    expect(b.loadThree).not.toHaveBeenCalled();
    expect(b.h.frames.length).toBe(0);
    expect(t.host.querySelector('canvas')).toBeNull();
    expect(t.s.state).toBe('idle');
  });

  it('アプリ全体の台帳: 何も作っていなければ gpuLeaseStats() は全部 0(台帳自体も作らない)', () => {
    expect(gpuLeaseStats()).toEqual({
      threeLoaded: false,
      activeContexts: 0,
      scheduledFrames: 0,
      backend: null,
      totalDisposals: 0,
    });
  });

  it('createGpuSurface でアプリの台帳に載せても、invalidate まで何も読み込まない', () => {
    const loadThreeFn = vi.fn(() => Promise.resolve(fakeThree()));
    setThreeLoaderForTest({ loadThree: loadThreeFn });
    const host = document.createElement('div');
    const s = createGpuSurface({ host, onAcquire: () => ({ render() {}, dispose() {} }), onFallback2d() {} });
    expect(gpuLeaseStats()).toMatchObject({ threeLoaded: false, activeContexts: 0, scheduledFrames: 0 });
    expect(loadThreeFn).not.toHaveBeenCalled();
    s.dispose();
  });
});

describe('🔴 オンデマンド描画 — 静止時の rAF は 0', () => {
  it('最初の invalidate で借り、1 コマだけ描いて止まる(WebGL2 の段)', async () => {
    const b = build(WEBGL_ONLY);
    const t = surfaceOf(b.mgr);
    t.s.invalidate();
    await settle();
    expect(b.loadThree).toHaveBeenCalledTimes(1);
    expect(b.mgr.stats()).toMatchObject({ threeLoaded: true, activeContexts: 1, scheduledFrames: 1, backend: 'webgl2' });
    expect(t.host.querySelector('canvas[data-pkc-gpu-canvas="webgl2"]')).not.toBeNull();
    expect(b.h.flushFrame()).toBe(1);
    expect(t.session.render).toHaveBeenCalledTimes(1);
    // 倍率は上限 2 に収める(端末は DPR 3)
    expect(t.session.render.mock.calls[0]?.[0]).toMatchObject({ pixelRatio: 2 });
    expect(renderers[0]?.setPixelRatio).toHaveBeenCalledWith(2);
    // 描いた後は予約し直さない
    expect(b.mgr.stats().scheduledFrames).toBe(0);
    expect(b.h.flushFrame()).toBe(0);
  });

  it('同じコマの中で invalidate を 5 回呼んでも render は 1 回、その後の予約は 0', async () => {
    const b = build(WEBGL_ONLY);
    const t = surfaceOf(b.mgr);
    t.s.invalidate();
    await settle();
    b.h.flushFrame();
    t.session.render.mockClear();

    for (let i = 0; i < 5; i += 1) t.s.invalidate();
    expect(b.mgr.stats().scheduledFrames).toBe(1);
    expect(b.h.frames.length).toBe(1);
    b.h.flushFrame();
    expect(t.session.render).toHaveBeenCalledTimes(1);
    expect(b.mgr.stats().scheduledFrames).toBe(0);
    // 何も頼まなければ、何コマ進めても描かない
    for (let i = 0; i < 10; i += 1) expect(b.h.flushFrame()).toBe(0);
    expect(t.session.render).toHaveBeenCalledTimes(1);
  });

  it('借りている途中に 5 回呼んでも、借りるのは 1 回・描くのは 1 回', async () => {
    const b = build(WEBGL_ONLY);
    const t = surfaceOf(b.mgr);
    for (let i = 0; i < 5; i += 1) t.s.invalidate();
    await settle();
    expect(b.loadThree).toHaveBeenCalledTimes(1);
    expect(t.contexts.length).toBe(1);
    b.h.flushFrame();
    expect(t.session.render).toHaveBeenCalledTimes(1);
    expect(b.mgr.stats().scheduledFrames).toBe(0);
  });
});

describe('🔴 自動解放 — VRAM を返す', () => {
  async function activeSurface(b: Built, poster?: () => GpuPoster | Promise<GpuPoster>) {
    const t = surfaceOf(b.mgr, poster);
    t.s.invalidate();
    await settle();
    b.h.flushFrame();
    return t;
  }

  it('アイドル(最後の invalidate から 30 秒)で畳む', async () => {
    const b = build(WEBGL_ONLY);
    const t = await activeSurface(b);
    b.h.advance(29_999);
    expect(t.session.dispose).not.toHaveBeenCalled();
    t.s.invalidate(); // 操作が続いている間は延びる
    b.h.flushFrame();
    b.h.advance(29_999);
    expect(t.session.dispose).not.toHaveBeenCalled();
    b.h.advance(1);
    await settle();
    expect(t.session.dispose).toHaveBeenCalledTimes(1);
    expect(renderers[0]?.disposed).toBe(1);
    expect(renderers[0]?.contextLost).toBe(1);
    expect(t.host.querySelector('canvas')).toBeNull();
    expect(b.mgr.stats()).toMatchObject({ activeContexts: 0, totalDisposals: 1, scheduledFrames: 0 });
    expect(t.s.state).toBe('idle');
  });

  it('画面外(IntersectionObserver)で畳み、画面内へ戻ったら透過的に借り直して描く', async () => {
    const b = build(WEBGL_ONLY, { useIo: true });
    const t = surfaceOf(b.mgr);
    // 最初の報告が来るまで借りない
    t.s.invalidate();
    await settle();
    expect(b.loadThree).not.toHaveBeenCalled();
    b.h.intersect(t.host, true);
    await settle();
    b.h.flushFrame();
    expect(t.session.render).toHaveBeenCalledTimes(1);
    expect(b.mgr.stats().activeContexts).toBe(1);

    b.h.intersect(t.host, false);
    await settle();
    expect(t.session.dispose).toHaveBeenCalledTimes(1);
    expect(b.mgr.stats()).toMatchObject({ activeContexts: 0, totalDisposals: 1 });

    b.h.intersect(t.host, true);
    await settle();
    expect(b.mgr.stats().activeContexts).toBe(1);
    b.h.flushFrame();
    expect(t.session.render).toHaveBeenCalledTimes(2);
    expect(t.contexts.length).toBe(2);
  });

  it('タブが隠れたら(visibilitychange: hidden)畳み、見えたら借り直す', async () => {
    const b = build(WEBGL_ONLY);
    const t = await activeSurface(b);
    t.s.invalidate(); // 予約中のコマも取り消されること
    expect(b.mgr.stats().scheduledFrames).toBe(1);
    setPageVisibility('hidden');
    await settle();
    expect(t.session.dispose).toHaveBeenCalledTimes(1);
    expect(b.mgr.stats()).toMatchObject({ activeContexts: 0, scheduledFrames: 0, totalDisposals: 1 });
    // 隠れている間の invalidate は借りない
    t.s.invalidate();
    await settle();
    expect(b.mgr.stats().activeContexts).toBe(0);
    setPageVisibility('visible');
    await settle();
    expect(b.mgr.stats().activeContexts).toBe(1);
  });

  it('dispose() で、タイマー・監視・rAF・GPU をすべて返す(2 回呼んでもよい)', async () => {
    const b = build(WEBGL_ONLY, { useIo: true });
    const t = surfaceOf(b.mgr);
    b.h.intersect(t.host, true);
    t.s.invalidate();
    await settle();
    t.s.invalidate();
    expect(b.h.frames.length).toBe(1);
    expect(b.h.timers.length).toBe(1);
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    t.s.dispose();
    t.s.dispose();
    expect(t.session.dispose).toHaveBeenCalledTimes(1);
    expect(b.h.frames.length).toBe(0);
    expect(b.h.timers.length).toBe(0);
    expect(b.h.ioDisconnected).toBe(1);
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(b.mgr.stats()).toMatchObject({ activeContexts: 0, scheduledFrames: 0, totalDisposals: 1 });
    expect(t.s.state).toBe('disposed');
    // 畳んだ後の invalidate は何もしない
    t.s.invalidate();
    await settle();
    expect(b.loadThree).toHaveBeenCalledTimes(1);
    removeSpy.mockRestore();
  });

  it('能力を測っている間に dispose されたら、何も読み込まない・借りない', async () => {
    const b = build(WEBGL_ONLY);
    const t = surfaceOf(b.mgr);
    t.s.invalidate();
    t.s.dispose();
    await settle();
    expect(b.loadThree).not.toHaveBeenCalled();
    expect(t.contexts.length).toBe(0);
    expect(b.mgr.stats()).toMatchObject({ activeContexts: 0, scheduledFrames: 0, threeLoaded: false });
  });

  it('Three.js を読み込んでいる間に dispose されたら、返ってきた GPU をその場で返す', async () => {
    const b = build(WEBGL_ONLY);
    let release: (m: Three) => void = () => {};
    b.loadThree.mockImplementationOnce(() => new Promise<Three>((r) => (release = r)));
    const t = surfaceOf(b.mgr);
    t.s.invalidate();
    await settle();
    expect(b.loadThree).toHaveBeenCalledTimes(1);
    t.s.dispose();
    release(fakeThree());
    await settle();
    // シーンを組ませない(onAcquire を呼ばない)まま GPU を返す
    expect(t.contexts.length).toBe(0);
    expect(renderers[0]?.disposed).toBe(1);
    expect(renderers[0]?.contextLost).toBe(1);
    expect(b.mgr.stats()).toMatchObject({ activeContexts: 0, scheduledFrames: 0 });
    expect(t.host.querySelector('canvas')).toBeNull();
  });

  it('🔴 同時の上限(4)を超えた 5 個目で、最古の 1 個をポスターに焼いてから畳む(LRU)', async () => {
    const b = build(WEBGL_ONLY);
    const posters = [0, 1, 2, 3, 4].map((i) => vi.fn(() => new Blob([`p${i}`], { type: 'image/png' })));
    const ts: Array<ReturnType<typeof surfaceOf>> = [];
    for (let i = 0; i < 4; i += 1) {
      b.h.t = 100 + i * 10;
      ts.push(await activeSurface(b, posters[i]));
    }
    expect(b.mgr.stats().activeContexts).toBe(4);
    // 2 番目を最近使ったことにする → 最古は 1 番目のまま
    b.h.t = 500;
    ts[1]?.s.invalidate();
    b.h.flushFrame();

    b.h.t = 600;
    const fifth = await activeSurface(b, posters[4]);
    await settle();
    expect(b.mgr.stats()).toMatchObject({ activeContexts: 4, totalDisposals: 1 });
    expect(ts[0]?.session.dispose).toHaveBeenCalledTimes(1);
    expect(posters[0]).toHaveBeenCalledTimes(1);
    for (const other of [ts[1], ts[2], ts[3], fifth]) expect(other?.session.dispose).not.toHaveBeenCalled();
    // 畳んだ 1 個はポスター(<img>)に置き換わっている
    const img = ts[0]?.host.querySelector<HTMLImageElement>('img[data-pkc-gpu-poster]');
    expect(img?.getAttribute('src')).toBe('blob:poster-0');
    expect(ts[0]?.host.querySelector('canvas')).toBeNull();
    expect(b.urls.revoked).toEqual([]);

    // 借り直したらポスターを外し、ObjectURL を revoke する
    ts[0]?.s.invalidate();
    await settle();
    expect(ts[0]?.host.querySelector('img[data-pkc-gpu-poster]')).toBeNull();
    expect(b.urls.revoked).toEqual(['blob:poster-0']);
  });

  it('ピン留めした物は LRU で畳まない', async () => {
    const b = build(WEBGL_ONLY);
    const ts: Array<ReturnType<typeof surfaceOf>> = [];
    for (let i = 0; i < 4; i += 1) {
      b.h.t = 100 + i;
      const t = await activeSurface(b);
      ts.push(t);
    }
    ts[0]?.s.setPinned(true);
    b.h.t = 200;
    await activeSurface(b);
    expect(ts[0]?.session.dispose).not.toHaveBeenCalled();
    expect(ts[1]?.session.dispose).toHaveBeenCalledTimes(1);
  });

  it('ポスターを出したまま dispose したら、ObjectURL を revoke して <img> も外す', async () => {
    const b = build(WEBGL_ONLY);
    const t = await activeSurface(b, () => new Blob(['x'], { type: 'image/png' }));
    b.h.advance(30_000);
    await settle();
    expect(t.host.querySelector('img[data-pkc-gpu-poster]')).not.toBeNull();
    t.s.dispose();
    expect(b.urls.revoked).toEqual(['blob:poster-0']);
    expect(t.host.querySelector('img[data-pkc-gpu-poster]')).toBeNull();
  });

  it('ポスターが要素で返ってきたら、そのまま置く(ObjectURL は作らない)', async () => {
    const b = build(WEBGL_ONLY);
    const t = await activeSurface(b, async () => {
      const el = document.createElement('div');
      el.textContent = 'still';
      return el;
    });
    b.h.advance(30_000);
    await settle();
    expect(t.host.querySelector('[data-pkc-gpu-poster]')?.textContent).toBe('still');
    expect(b.urls.created).toEqual([]);
  });

  it('ポスターの焼き込みが例外でも GPU は返す', async () => {
    const b = build(WEBGL_ONLY);
    const t = await activeSurface(b, () => {
      throw new Error('焼けない');
    });
    b.h.advance(30_000);
    await settle();
    expect(t.session.dispose).toHaveBeenCalledTimes(1);
    expect(b.mgr.stats().activeContexts).toBe(0);
  });
});

describe('借りている途中の畳み(非同期の onAcquire)', () => {
  it('onAcquire の await 中に dispose されたら、返ってきた session も GPU も返す', async () => {
    const b = build(WEBGL_ONLY);
    const host = document.createElement('div');
    let resolve: (s: GpuSession) => void = () => {};
    const session = { render: vi.fn(), dispose: vi.fn() };
    const s = b.mgr.createSurface({
      host,
      onAcquire: () => new Promise<GpuSession>((r) => (resolve = r)),
      onFallback2d: vi.fn(),
    });
    s.invalidate();
    await settle();
    s.dispose();
    resolve(session);
    await settle();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(renderers[0]?.disposed).toBe(1);
    expect(host.querySelector('canvas')).toBeNull();
    expect(b.mgr.stats()).toMatchObject({ activeContexts: 0, scheduledFrames: 0 });
  });
});

describe('🔴 段階フォールバック — WebGPU → WebGL2 → 2D、例外を漏らさない', () => {
  it('WebGPU が使えれば WebGPU で借り、畳むときは device まで destroy する', async () => {
    const b = build(BOTH);
    const t = surfaceOf(b.mgr);
    t.s.invalidate();
    await settle();
    expect(b.loadThreeWebGpu).toHaveBeenCalledTimes(1);
    expect(b.loadThree).not.toHaveBeenCalled();
    expect(t.contexts[0]?.backend).toBe('webgpu');
    expect(b.mgr.stats().backend).toBe('webgpu');
    t.s.dispose();
    expect(renderers[0]?.disposed).toBe(1);
    expect(renderers[0]?.deviceDestroyed).toBe(1);
  });

  it('WebGPU の初期化に失敗 → WebGL2 へ自動で下げる(失敗した WebGPU の renderer も返す)', async () => {
    const b = build(BOTH, { webgpuInitFails: true });
    const t = surfaceOf(b.mgr);
    t.s.invalidate();
    await settle();
    expect(b.loadThreeWebGpu).toHaveBeenCalledTimes(1);
    expect(b.loadThree).toHaveBeenCalledTimes(1);
    expect(t.contexts.map((c) => c.backend)).toEqual(['webgl2']);
    expect(renderers[0]?.kind).toBe('webgpu');
    expect(renderers[0]?.disposed).toBe(1);
    expect(renderers[0]?.deviceDestroyed).toBe(1);
    expect(b.mgr.stats()).toMatchObject({ backend: 'webgl2', activeContexts: 1 });
    expect(t.host.querySelectorAll('canvas').length).toBe(1);
    expect(t.fallback).not.toHaveBeenCalled();
  });

  it('WebGPU も WebGL2 も失敗 → onFallback2d が呼ばれ、例外は漏れない', async () => {
    const b = build(BOTH, { webgpuInitFails: true, webglFails: true });
    const t = surfaceOf(b.mgr);
    const errors: unknown[] = [];
    const onUnhandled = (e: unknown): void => void errors.push(e);
    process.on('unhandledRejection', onUnhandled);
    expect(() => t.s.invalidate()).not.toThrow();
    await settle();
    process.off('unhandledRejection', onUnhandled);
    expect(errors).toEqual([]);
    expect(t.fallback).toHaveBeenCalledTimes(1);
    expect(t.fallback.mock.calls[0]?.[0]).toBe(t.host);
    expect(String(t.fallback.mock.calls[0]?.[1])).toContain('webgl2');
    expect(t.s.state).toBe('fallback2d');
    expect(t.host.querySelector('canvas')).toBeNull();
    expect(b.mgr.stats()).toMatchObject({ activeContexts: 0, scheduledFrames: 0 });
  });

  it('onAcquire が例外でも段を下げる(利用側の初期化の失敗)', async () => {
    const b = build(WEBGL_ONLY);
    const host = document.createElement('div');
    const fallback = vi.fn();
    const s = b.mgr.createSurface({
      host,
      onAcquire: () => {
        throw new Error('シーンが組めない');
      },
      onFallback2d: fallback,
    });
    s.invalidate();
    await settle();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(renderers[0]?.disposed).toBe(1);
    expect(renderers[0]?.contextLost).toBe(1);
  });

  it('WebGPU も WebGL2 も無い端末 → 読み込まずに 2D', async () => {
    const b = build({ portable: false, webgpu: false, webgl2: false });
    const t = surfaceOf(b.mgr);
    t.s.invalidate();
    await settle();
    expect(b.loadThree).not.toHaveBeenCalled();
    expect(b.loadThreeWebGpu).not.toHaveBeenCalled();
    expect(t.fallback).toHaveBeenCalledWith(t.host, GPU_UNSUPPORTED);
    expect(b.mgr.stats()).toMatchObject({ threeLoaded: false, backend: '2d' });
  });

  it('退避口が例外を投げても外へ漏らさない', async () => {
    const b = build({ portable: false, webgpu: false, webgl2: false });
    const host = document.createElement('div');
    const s = b.mgr.createSurface({
      host,
      onAcquire: () => ({ render() {}, dispose() {} }),
      onFallback2d: () => {
        throw new Error('退避口が壊れている');
      },
    });
    s.invalidate();
    await settle();
    expect(s.state).toBe('fallback2d');
  });
});

describe('🔴 1 枚にまとめた版 — Three.js を読み込まない', () => {
  it('portable なら、能力が揃っていてもローダーを呼ばず即 onFallback2d', async () => {
    const b = build({ portable: true, webgpu: true, webgl2: true });
    const t = surfaceOf(b.mgr);
    t.s.invalidate();
    await settle();
    expect(b.loadThree).not.toHaveBeenCalled();
    expect(b.loadThreeWebGpu).not.toHaveBeenCalled();
    expect(t.fallback).toHaveBeenCalledWith(t.host, GPU_PORTABLE_UNAVAILABLE);
    expect(b.mgr.stats()).toMatchObject({ threeLoaded: false, activeContexts: 0, backend: '2d' });
  });
});

describe('端末の能力の検出', () => {
  it('WebGL2 のプローブは取れたコンテキストをその場で失わせる', () => {
    const loseContext = vi.fn();
    const fakeDoc = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: (kind: string) => (kind === 'webgl2' ? { getExtension: () => ({ loseContext }) } : null),
      }),
    } as unknown as Document;
    expect(probeWebGl2(fakeDoc)).toBe(true);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('WebGL2 が取れない・例外なら false', () => {
    const none = { createElement: () => ({ getContext: () => null }) } as unknown as Document;
    const boom = {
      createElement: () => ({
        getContext: () => {
          throw new Error('x');
        },
      }),
    } as unknown as Document;
    expect(probeWebGl2(none)).toBe(false);
    expect(probeWebGl2(boom)).toBe(false);
    expect(probeWebGl2(undefined)).toBe(false);
  });

  it('WebGPU は既存の webGpuAvailable() で測り、1 回だけ測る(控えは reset で捨てる)', async () => {
    const requestAdapter = vi.fn(() => Promise.resolve({}));
    vi.stubGlobal('navigator', { ...navigator, gpu: { requestAdapter } });
    try {
      resetGpuCapabilityCache();
      const a = await detectGpuCapabilities();
      const b = await detectGpuCapabilities();
      expect(a.webgpu).toBe(true);
      expect(a.portable).toBe(false);
      expect(b).toBe(a);
      expect(requestAdapter).toHaveBeenCalledTimes(1);
      resetGpuCapabilityCache();
      await detectGpuCapabilities();
      expect(requestAdapter).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      resetGpuCapabilityCache();
    }
  });
});

describe('Three.js の遅延読み込み', () => {
  it('失敗は覚えない ── 次に要るときにもう一度読みに行く', async () => {
    let n = 0;
    const flaky = vi.fn(() => (n++ === 0 ? Promise.reject(new Error('offline')) : Promise.resolve(fakeThree())));
    setThreeLoaderForTest({ loadThree: flaky });
    await expect(loadThree()).rejects.toThrow('offline');
    expect(gpuLeaseStats().threeLoaded).toBe(false);
    await expect(loadThree()).resolves.toBeDefined();
    expect(gpuLeaseStats().threeLoaded).toBe(true);
  });
});
