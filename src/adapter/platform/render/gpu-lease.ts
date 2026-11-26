/**
 * 🔴 **使い捨て GPU 基盤**(v4.0 Phase 3 / PR-11、ビジョン 1-A)── `worker-lease.ts` と対をなす「GPU の貸し出し」。
 *
 * 3D ビューア(PR-12)・大きな関係グラフ / 無限キャンバスの加速(PR-13)が、ここから GPU の描画面を借りる。
 * 判断(どの段で描くか・何倍で描くか・どれを畳むか)は `@features/gpu/gpu-policy` の純関数。ここは実物を持つ。
 *
 * ## 守ること(定常コスト 0)
 *
 * 1. **使うまで 0**: `three` は動的 `import()` の別 chunk。描画面を作っただけでは読み込まず、
 *    コンテキストも作らない。最初の `invalidate()` で初めて借りる。
 * 2. **静止時の rAF = 0**: `invalidate()` が来たときだけ `requestAnimationFrame` を 1 回予約する
 *    (同じコマの中の連続呼び出しは 1 回にまとめる)。描いたら予約し直さない ── ループを回さない。
 * 3. **VRAM を自分で返す**: 画面外(`IntersectionObserver`)・タブが隠れた(`visibilitychange`)・
 *    最後の `invalidate()` から `idleMs`・同時の上限超え(LRU)・`dispose()` で、
 *    静止画(ポスター)へ焼いてから `session.dispose()` → `renderer.dispose()` →
 *    WebGL は `forceContextLoss()`、WebGPU は `device.destroy()` まで呼ぶ。
 *    ⚠ three の `WebGPUBackend.dispose()` は device を destroy しない(r187 で確認)── だからここで呼ぶ。
 * 4. **1 枚にまとめた版には入れない**: `loadThree()` の頭に `stem-worker.ts` と同じ直接の条件を書き、
 *    ビルド時に `import('three')` を枝ごと落とす(`'2d'` へ退避)。
 * 5. **WebGPU の検出は既存の `webGpuAvailable()`**(2 本目のプローブを作らない)。
 * 6. **画面を壊さない**: WebGPU → WebGL2 → 2D と段を下げ、最後は `onFallback2d` に渡す。例外は外へ漏らさない。
 */
declare const __PKC_PORTABLE__: boolean | undefined;

import type * as ThreeModule from 'three';
import type * as ThreeWebGpuModule from 'three/webgpu';
import {
  GPU_IDLE_MS,
  GPU_MAX_ACTIVE_CONTEXTS,
  GPU_MAX_PIXEL_RATIO,
  effectivePixelRatio,
  nextFallbackBackend,
  pickLruEviction,
  selectGpuBackend,
  shouldRunGpuFrame,
  type GpuBackend,
  type GpuCapabilities,
} from '@features/gpu/gpu-policy';
import { IS_PORTABLE_BUILD } from '@features/build-flavor';
import { resetWebGpuProbe, webGpuAvailable } from '../asr/webgpu-probe';
import { retryableImport } from './retryable-import';

export type { GpuBackend, GpuCapabilities } from '@features/gpu/gpu-policy';

/** 1 枚にまとめた版で 3D の描画が使えない理由(画面の字)。 */
export const GPU_PORTABLE_UNAVAILABLE =
  'このビルド(1 枚にまとめた版)では 3D の描画に使うライブラリ(Three.js)を同梱していないため、簡易表示にしています';
/** WebGPU も WebGL2 も使えない端末の理由(画面の字)。 */
export const GPU_UNSUPPORTED = 'この端末のブラウザでは GPU の描画(WebGPU / WebGL2)が使えないため、簡易表示にしています';

// ───────────────────────────── 端末の能力(1 回だけ測る・常駐させない)

/**
 * WebGL2 が使えるかを 1×1 の canvas で測る。
 * 🔴 取れたコンテキストは**その場で失わせる**(`WEBGL_lose_context`)── 測るためだけに 1 枠を握り続けない。
 */
export function probeWebGl2(doc: Document | undefined = globalThis.document): boolean {
  if (doc === undefined) return false;
  try {
    const canvas = doc.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (gl === null || gl === undefined) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

let capsCache: Promise<GpuCapabilities> | null = null;

/** 端末の能力。アプリ全体で 1 回だけ測る(端末は実行中に変わらない)。 */
export function detectGpuCapabilities(): Promise<GpuCapabilities> {
  capsCache ??= (async (): Promise<GpuCapabilities> => {
    if (IS_PORTABLE_BUILD) return { portable: true, webgpu: false, webgl2: false };
    const webgpu = await webGpuAvailable().catch(() => false);
    return { portable: false, webgpu, webgl2: probeWebGl2() };
  })();
  return capsCache;
}

/** この端末で最初に試す段。 */
export async function resolveGpuBackend(): Promise<GpuBackend> {
  return selectGpuBackend(await detectGpuCapabilities());
}

/** test 用: 測り直せるよう控えを捨てる(WebGPU のプローブの控えも)。 */
export function resetGpuCapabilityCache(): void {
  capsCache = null;
  resetWebGpuProbe();
}

// ───────────────────────────── Three.js の遅延読み込み

export type Three = typeof ThreeModule;
export type ThreeWebGpu = typeof ThreeWebGpuModule;

export interface ThreeLoaders {
  loadThree?: () => Promise<Three>;
  loadThreeWebGpu?: () => Promise<ThreeWebGpu>;
}

let testLoaders: ThreeLoaders | null = null;
let threeLoaded = false;

const importThree = retryableImport<Three>(
  async () => {
    /**
     * 🔴 1 枚にまとめた版では、この先(Three.js 本体)を**丸ごと落とす**(ビルド時に枝ごと消える ── `build/portable.config.ts`)。
     * ⚠ 条件はこの場で直接書く(別 module の定数だと、枝の除去が効かず `import('three')` が inline される)。
     */
    if (typeof __PKC_PORTABLE__ !== 'undefined' && __PKC_PORTABLE__) {
      throw new Error(GPU_PORTABLE_UNAVAILABLE);
    }
    return import('three');
  },
  (cause) => new Error(`Three.js を読み込めませんでした: ${cause instanceof Error ? cause.message : String(cause)}`),
);

const importThreeWebGpu = retryableImport<ThreeWebGpu>(
  async () => {
    // 🔴 上と同じ ── 1 枚にまとめた版では枝ごと落とす(条件はこの場で直接書く)
    if (typeof __PKC_PORTABLE__ !== 'undefined' && __PKC_PORTABLE__) {
      throw new Error(GPU_PORTABLE_UNAVAILABLE);
    }
    return import('three/webgpu');
  },
  (cause) => new Error(`Three.js(WebGPU)を読み込めませんでした: ${cause instanceof Error ? cause.message : String(cause)}`),
);

/** Three.js(WebGL2 の段)。⚠ 失敗は覚えない ── 次に要るときにもう一度読みに行く。 */
export async function loadThree(): Promise<Three> {
  const m = await (testLoaders?.loadThree ?? importThree)();
  threeLoaded = true;
  return m;
}

/** Three.js の WebGPU 版(`three/webgpu`)。失敗したら呼び側が WebGL2 の段へ下げる。 */
export async function loadThreeWebGpu(): Promise<ThreeWebGpu> {
  const m = await (testLoaders?.loadThreeWebGpu ?? importThreeWebGpu)();
  threeLoaded = true;
  return m;
}

/** test 用: 読み込みを差し替える(`null` で実物へ戻す)。 */
export function setThreeLoaderForTest(loaders: ThreeLoaders | null): void {
  testLoaders = loaders;
  threeLoaded = false;
}

// ───────────────────────────── 利用側との契約

/** three の renderer のうち、この層が触る部分だけ。 */
export interface GpuRendererLike {
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  dispose(): void;
  forceContextLoss?(): void;
  init?(): Promise<unknown>;
  /** WebGPU の backend(device を destroy するため)。 */
  backend?: { device?: { destroy?(): void } | null } | null;
}

export interface GpuContext {
  readonly backend: Exclude<GpuBackend, '2d'>;
  readonly canvas: HTMLCanvasElement;
  /** `three`(WebGL2 の段)または `three/webgpu`(WebGPU の段)。どちらも three の全部を含む。 */
  readonly three: Three | ThreeWebGpu;
  /** 借りた renderer。⚠ 破棄はこの層がやる(`session.dispose()` の後に必ず)。 */
  readonly renderer: GpuRendererLike;
  readonly pixelRatio: number;
}

export interface GpuFrameSize {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

/** ポスター(畳むときの静止画)。Blob は `<img>` にして出す(ObjectURL は外すときに revoke)。 */
export type GpuPoster = Blob | HTMLElement | null | undefined;

export interface GpuSession {
  /** 1 コマ描く。`invalidate()` 1 回につき高々 1 回呼ばれる。 */
  render(size: GpuFrameSize): void;
  /**
   * 畳む直前に今の絵を静止画へ焼く(任意)。「図は描いたら焼く」── 畳んでも画面を空白にしない。
   * ⚠ WebGL は既定で描画バッファを残さない(`preserveDrawingBuffer: false`)── ここで 1 コマ描いてから
   *   **同じ処理の中で** `canvas.toBlob()` を呼ぶ(呼んだ時点の絵が焼かれる)。返した Blob の ObjectURL はこの層が revoke する。
   */
  capturePoster?(): GpuPoster | Promise<GpuPoster>;
  /** 利用側が作った geometry / material / texture などを返す。 */
  dispose(): void;
}

export interface GpuSurfaceOptions {
  /** 描画面を置く要素(可視の監視もこれを見る)。 */
  host: HTMLElement;
  onAcquire(ctx: GpuContext): GpuSession | Promise<GpuSession>;
  /** GPU が使えない・1 枚にまとめた版のときに呼ばれる退避口。 */
  onFallback2d(host: HTMLElement, reason: string): void;
}

export interface GpuSurface {
  /** 描き直しを頼む。同じコマの中で何度呼んでも 1 回。借りていなければ借りる。 */
  invalidate(): void;
  /** LRU で畳まれないようにする(操作中など)。 */
  setPinned(pinned: boolean): void;
  /** すべて返す(タイマー・監視・rAF・ObjectURL・GPU)。2 回呼んでもよい。 */
  dispose(): void;
  /** test・計測用の状態。 */
  readonly state: GpuSurfaceState;
}

export type GpuSurfaceState = 'idle' | 'acquiring' | 'active' | 'fallback2d' | 'disposed';
export type GpuReleaseReason = 'offscreen' | 'hidden' | 'idle' | 'lru' | 'dispose';

export interface GpuLeaseStats {
  threeLoaded: boolean;
  activeContexts: number;
  scheduledFrames: number;
  backend: GpuBackend | null;
  totalDisposals: number;
}

// ───────────────────────────── 貸し出しの台帳

type IoCtor = new (cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) => {
  observe(el: Element): void;
  unobserve(el: Element): void;
  disconnect(): void;
};

export interface GpuLeaseManagerOptions {
  idleMs?: number;
  maxContexts?: number;
  maxPixelRatio?: number;
  /** 端末の能力(既定 `detectGpuCapabilities`)。 */
  capabilities?: () => Promise<GpuCapabilities>;
  requestFrame?: (cb: () => void) => unknown;
  cancelFrame?: (h: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  now?: () => number;
  /** `visibilitychange` を見る document。 */
  doc?: Document;
  /** `IntersectionObserver`(無い環境では常に画面内とみなす)。 */
  IntersectionObserver?: IoCtor | null;
  devicePixelRatio?: () => number;
  createObjectURL?: (b: Blob) => string;
  revokeObjectURL?: (u: string) => void;
}

interface Lease {
  ctx: GpuContext;
  session: GpuSession;
}

class Surface implements GpuSurface {
  state: GpuSurfaceState = 'idle';
  lastUsedAt = 0;
  pinned = false;
  /** 画面内か(IntersectionObserver の最後の報告)。 */
  visible = true;
  /** 描き直しを頼まれたが、まだ描いていない。 */
  dirty = false;
  /** 畳んだ理由(画面内・タブ復帰で戻すかの判断)。 */
  releasedBy: GpuReleaseReason | null = null;
  frame: unknown = null;
  idleTimer: unknown = null;
  lease: Lease | null = null;
  /** 借りる・畳むの世代。古い世代の借用が後から返ってきたら、その場で捨てる。 */
  gen = 0;
  poster: { el: HTMLElement; url: string | null } | null = null;

  constructor(
    readonly mgr: GpuLeaseManager,
    readonly opts: GpuSurfaceOptions,
  ) {}

  invalidate(): void {
    if (this.state === 'disposed' || this.state === 'fallback2d') return;
    this.lastUsedAt = this.mgr.now();
    this.dirty = true;
    if (!this.canDraw()) return;
    if (this.state === 'idle') {
      void this.mgr.acquire(this);
      return;
    }
    if (this.state === 'active') {
      this.mgr.scheduleFrame(this);
      this.mgr.armIdle(this);
    }
    // acquiring: 借りられた時点で 1 コマ描く(dirty が覚えている)
  }

  setPinned(pinned: boolean): void {
    this.pinned = pinned;
  }

  dispose(): void {
    this.mgr.disposeSurface(this);
  }

  canDraw(): boolean {
    return shouldRunGpuFrame({
      visible: this.visible,
      pageVisible: this.mgr.pageVisible(),
      disposed: this.state === 'disposed',
    });
  }
}

export class GpuLeaseManager {
  private readonly idleMs: number;
  private readonly maxContexts: number;
  private readonly maxPixelRatio: number;
  private readonly caps: () => Promise<GpuCapabilities>;
  private readonly requestFrame: (cb: () => void) => unknown;
  private readonly cancelFrame: (h: unknown) => void;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  readonly now: () => number;
  private readonly doc: Document | undefined;
  private readonly IoCtor: IoCtor | null;
  private readonly dpr: () => number;
  private readonly createUrl: (b: Blob) => string;
  private readonly revokeUrl: (u: string) => void;

  private readonly surfaces = new Set<Surface>();
  private readonly active = new Set<Surface>();
  private io: InstanceType<IoCtor> | null = null;
  private readonly byHost = new Map<Element, Surface>();
  private visibilityBound = false;
  private lastBackend: GpuBackend | null = null;
  private disposals = 0;
  private scheduled = 0;

  constructor(opts: GpuLeaseManagerOptions = {}) {
    this.idleMs = opts.idleMs ?? GPU_IDLE_MS;
    this.maxContexts = opts.maxContexts ?? GPU_MAX_ACTIVE_CONTEXTS;
    this.maxPixelRatio = opts.maxPixelRatio ?? GPU_MAX_PIXEL_RATIO;
    this.caps = opts.capabilities ?? detectGpuCapabilities;
    this.requestFrame = opts.requestFrame ?? ((cb) => globalThis.requestAnimationFrame(cb));
    this.cancelFrame = opts.cancelFrame ?? ((h) => globalThis.cancelAnimationFrame(h as number));
    this.setTimer = opts.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = opts.now ?? (() => Date.now());
    this.doc = opts.doc ?? globalThis.document;
    this.IoCtor =
      opts.IntersectionObserver !== undefined
        ? opts.IntersectionObserver
        : ((globalThis as { IntersectionObserver?: IoCtor }).IntersectionObserver ?? null);
    this.dpr = opts.devicePixelRatio ?? (() => globalThis.devicePixelRatio ?? 1);
    this.createUrl = opts.createObjectURL ?? ((b) => URL.createObjectURL(b));
    this.revokeUrl = opts.revokeObjectURL ?? ((u) => URL.revokeObjectURL(u));
  }

  /** 描画面を作る。⚠ ここでは何も読み込まない・何も借りない(最初の `invalidate()` まで 0)。 */
  createSurface(opts: GpuSurfaceOptions): GpuSurface {
    const s = new Surface(this, opts);
    this.surfaces.add(s);
    this.byHost.set(opts.host, s);
    this.bindWatchers();
    if (this.io !== null) {
      // 最初の報告が来るまでは「画面外」── 見えていない物のために借りない
      s.visible = false;
      this.io.observe(opts.host);
    }
    return s;
  }

  stats(): GpuLeaseStats {
    return {
      threeLoaded,
      activeContexts: this.active.size,
      scheduledFrames: this.scheduled,
      backend: this.lastBackend,
      totalDisposals: this.disposals,
    };
  }

  pageVisible(): boolean {
    return this.doc === undefined || this.doc.visibilityState !== 'hidden';
  }

  // ── 監視は描画面があるあいだだけ(無ければ listener も observer も 0)

  private readonly onVisibility = (): void => {
    if (!this.pageVisible()) {
      for (const s of this.surfaces) {
        this.cancelScheduled(s);
        if (s.state === 'active' || s.state === 'acquiring') void this.release(s, 'hidden');
      }
      return;
    }
    for (const s of this.surfaces) {
      if (s.releasedBy === 'hidden' || (s.dirty && s.state !== 'acquiring')) this.resume(s);
    }
  };

  private bindWatchers(): void {
    if (!this.visibilityBound && this.doc !== undefined) {
      this.doc.addEventListener('visibilitychange', this.onVisibility);
      this.visibilityBound = true;
    }
    if (this.io === null && this.IoCtor !== null) {
      this.io = new this.IoCtor((entries) => {
        for (const e of entries) {
          const s = this.byHost.get(e.target);
          if (s === undefined || s.state === 'disposed') continue;
          s.visible = e.isIntersecting;
          if (!s.visible) {
            this.cancelScheduled(s);
            if (s.state === 'active' || s.state === 'acquiring') void this.release(s, 'offscreen');
          } else if (s.releasedBy === 'offscreen' || s.dirty) {
            this.resume(s);
          }
        }
      });
    }
  }

  private unbindWatchersIfEmpty(): void {
    if (this.surfaces.size > 0) return;
    if (this.visibilityBound && this.doc !== undefined) {
      this.doc.removeEventListener('visibilitychange', this.onVisibility);
      this.visibilityBound = false;
    }
    this.io?.disconnect();
    this.io = null;
  }

  /** 画面内・タブ復帰で、畳んだ物を透過的に戻す。 */
  private resume(s: Surface): void {
    if (s.state === 'disposed' || s.state === 'fallback2d') return;
    s.releasedBy = null;
    s.dirty = true;
    s.invalidate();
  }

  // ── コマの予約(オンデマンド描画)

  scheduleFrame(s: Surface): void {
    if (s.frame !== null) return; // 同じコマの中の連続呼び出しは 1 回にまとめる
    this.scheduled += 1;
    s.frame = this.requestFrame(() => {
      s.frame = null;
      this.scheduled -= 1;
      this.drawFrame(s);
    });
  }

  private cancelScheduled(s: Surface): void {
    if (s.frame === null) return;
    this.cancelFrame(s.frame);
    s.frame = null;
    this.scheduled -= 1;
  }

  private drawFrame(s: Surface): void {
    const lease = s.lease;
    if (lease === null || s.state !== 'active') return;
    if (!s.canDraw()) return; // dirty は残す(見えたら描く)
    s.dirty = false;
    const size = this.frameSize(s);
    try {
      lease.ctx.renderer.setPixelRatio(size.pixelRatio);
      lease.ctx.renderer.setSize(size.width, size.height, false);
      lease.session.render(size);
    } catch {
      // ⚠ 1 コマの失敗で画面を落とさない(次の invalidate でもう一度描く)
      s.dirty = true;
    }
    // 🔴 ここで rAF を予約し直さない ── 静止時の rAF = 0
  }

  private frameSize(s: Surface): GpuFrameSize {
    const host = s.opts.host;
    return {
      width: Math.max(1, Math.round(host.clientWidth || 1)),
      height: Math.max(1, Math.round(host.clientHeight || 1)),
      pixelRatio: effectivePixelRatio(this.dpr(), this.maxPixelRatio),
    };
  }

  armIdle(s: Surface): void {
    if (s.idleTimer !== null) this.clearTimer(s.idleTimer);
    s.idleTimer = this.setTimer(() => {
      s.idleTimer = null;
      if (s.state === 'active') void this.release(s, 'idle');
    }, this.idleMs);
  }

  private clearIdle(s: Surface): void {
    if (s.idleTimer === null) return;
    this.clearTimer(s.idleTimer);
    s.idleTimer = null;
  }

  // ── 借りる(WebGPU → WebGL2 → 2D)

  async acquire(s: Surface): Promise<void> {
    if (s.state !== 'idle') return;
    s.state = 'acquiring';
    const gen = ++s.gen;
    let caps: GpuCapabilities;
    try {
      caps = await this.caps();
    } catch {
      caps = { portable: false, webgpu: false, webgl2: false };
    }
    if (s.gen !== gen) return; // 待っている間に畳まれた
    let backend: GpuBackend = selectGpuBackend(caps);
    let reason = caps.portable ? GPU_PORTABLE_UNAVAILABLE : GPU_UNSUPPORTED;
    while (backend !== '2d') {
      let ctx: GpuContext | null = null;
      try {
        ctx = await this.createContext(s, backend);
        if (s.gen !== gen) {
          // 読み込んでいる間に畳まれた ── シーンを組ませずに返す
          this.destroyContext(ctx);
          return;
        }
        const session = await s.opts.onAcquire(ctx);
        if (s.gen !== gen) {
          // 借りている間に畳まれた(画面外へ出た・dispose)── 借りた物をその場で返す
          this.destroyLease({ ctx, session });
          return;
        }
        this.lastBackend = backend;
        this.removePoster(s);
        s.lease = { ctx, session };
        s.state = 'active';
        s.releasedBy = null;
        s.lastUsedAt = this.now();
        this.active.add(s);
        this.evictOverLimit(s);
        if (s.state !== 'active') return;
        this.armIdle(s);
        if (s.dirty && s.canDraw()) this.scheduleFrame(s);
        return;
      } catch (e) {
        if (ctx !== null) this.destroyContext(ctx);
        if (s.gen !== gen) return;
        reason = `GPU の初期化に失敗しました(${backend}): ${e instanceof Error ? e.message : String(e)}`;
        backend = nextFallbackBackend(backend, caps) ?? '2d';
      }
    }
    this.enterFallback2d(s, reason);
  }

  private async createContext(s: Surface, backend: Exclude<GpuBackend, '2d'>): Promise<GpuContext> {
    const host = s.opts.host;
    const doc = host.ownerDocument;
    const canvas = doc.createElement('canvas');
    canvas.setAttribute('data-pkc-gpu-canvas', backend);
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    const pixelRatio = effectivePixelRatio(this.dpr(), this.maxPixelRatio);
    const partial: { canvas: HTMLCanvasElement; renderer: GpuRendererLike | null } = { canvas, renderer: null };
    try {
      let three: Three | ThreeWebGpu;
      let renderer: GpuRendererLike;
      if (backend === 'webgpu') {
        const m = await loadThreeWebGpu();
        three = m;
        renderer = new m.WebGPURenderer({ canvas, antialias: true, alpha: true }) as unknown as GpuRendererLike;
        partial.renderer = renderer;
        // ⚠ アダプタ・device の取得はここで起きる。失敗(例外)は呼び側が WebGL2 の段へ下げる
        await renderer.init?.();
      } else {
        const m = await loadThree();
        three = m;
        renderer = new m.WebGLRenderer({ canvas, antialias: true, alpha: true }) as unknown as GpuRendererLike;
        partial.renderer = renderer;
      }
      renderer.setPixelRatio(pixelRatio);
      host.appendChild(canvas);
      return { backend, canvas, three, renderer, pixelRatio };
    } catch (e) {
      this.destroyContext({ backend, canvas, renderer: partial.renderer });
      throw e;
    }
  }

  private enterFallback2d(s: Surface, reason: string): void {
    s.state = 'fallback2d';
    if (this.lastBackend === null) this.lastBackend = '2d';
    try {
      s.opts.onFallback2d(s.opts.host, reason);
    } catch {
      // ⚠ 退避口の失敗でも画面を落とさない
    }
  }

  private evictOverLimit(newcomer: Surface): void {
    const list = [...this.active].map((x, i) => ({ id: String(i), x, lastUsedAt: x.lastUsedAt, pinned: x.pinned || x === newcomer }));
    for (const victim of pickLruEviction(list, this.maxContexts)) void this.release(victim.x, 'lru');
  }

  // ── 畳む(ポスターに焼いてから GPU を返す)

  async release(s: Surface, reason: GpuReleaseReason): Promise<void> {
    s.gen += 1; // 借りている途中なら、返ってきた物はその場で捨てられる
    this.cancelScheduled(s);
    this.clearIdle(s);
    if (s.state === 'acquiring') {
      s.state = reason === 'dispose' ? 'disposed' : 'idle';
      s.releasedBy = reason;
      return;
    }
    const lease = s.lease;
    if (lease === null || s.state !== 'active') return;
    s.lease = null;
    this.active.delete(s);
    s.state = reason === 'dispose' ? 'disposed' : 'idle';
    s.releasedBy = reason;
    if (reason !== 'dispose' && lease.session.capturePoster !== undefined) {
      const poster = await Promise.resolve()
        .then(() => lease.session.capturePoster?.())
        .catch((): GpuPoster => null);
      // 焼いている間に dispose された・借り直された ── ポスターは出さない(ObjectURL も作らない)
      if ((s.state as GpuSurfaceState) !== 'disposed' && s.lease === null) this.showPoster(s, poster);
    }
    this.destroyLease(lease);
  }

  private destroyLease(lease: Lease): void {
    try {
      lease.session.dispose();
    } catch {
      // 利用側の失敗でも GPU は返す
    }
    this.destroyContext(lease.ctx);
  }

  private destroyContext(ctx: { backend: GpuBackend; canvas: HTMLCanvasElement; renderer: GpuRendererLike | null }): void {
    const r = ctx.renderer;
    if (r !== null) {
      try {
        r.dispose();
      } catch {
        /* 続けて返す */
      }
      if (ctx.backend === 'webgl2') {
        try {
          r.forceContextLoss?.();
        } catch {
          /* 続けて返す */
        }
      } else if (ctx.backend === 'webgpu') {
        try {
          r.backend?.device?.destroy?.();
        } catch {
          /* 続けて返す */
        }
      }
    }
    ctx.canvas.remove();
    this.disposals += 1;
  }

  private showPoster(s: Surface, poster: GpuPoster): void {
    this.removePoster(s);
    if (poster === null || poster === undefined) return;
    const doc = s.opts.host.ownerDocument;
    if (poster instanceof Blob) {
      const url = this.createUrl(poster);
      const img = doc.createElement('img');
      img.setAttribute('data-pkc-gpu-poster', '');
      img.alt = '';
      img.decoding = 'async';
      img.style.display = 'block';
      img.style.width = '100%';
      img.style.height = '100%';
      img.src = url;
      s.opts.host.appendChild(img);
      s.poster = { el: img, url };
      return;
    }
    poster.setAttribute('data-pkc-gpu-poster', '');
    s.opts.host.appendChild(poster);
    s.poster = { el: poster, url: null };
  }

  /** ポスターを外す。🔴 ObjectURL はここで必ず revoke する(ライフサイクルの終端)。 */
  private removePoster(s: Surface): void {
    const p = s.poster;
    if (p === null) return;
    s.poster = null;
    p.el.remove();
    if (p.url !== null) this.revokeUrl(p.url);
  }

  disposeSurface(s: Surface): void {
    if (!this.surfaces.has(s)) return;
    void this.release(s, 'dispose');
    s.state = 'disposed';
    this.removePoster(s);
    this.surfaces.delete(s);
    this.byHost.delete(s.opts.host);
    this.io?.unobserve(s.opts.host);
    this.unbindWatchersIfEmpty();
  }
}

// ───────────────────────────── アプリ全体の 1 台(作るのは最初に使ったとき)

let defaultManager: GpuLeaseManager | null = null;

/** 描画面を作る(アプリ全体の台帳に載せる)。⚠ 作っただけでは読み込まない・借りない。 */
export function createGpuSurface(opts: GpuSurfaceOptions): GpuSurface {
  defaultManager ??= new GpuLeaseManager();
  return defaultManager.createSurface(opts);
}

/** 観測点(test・計測用)。台帳がまだ無ければ全部 0。 */
export function gpuLeaseStats(): GpuLeaseStats {
  if (defaultManager === null) {
    return { threeLoaded, activeContexts: 0, scheduledFrames: 0, backend: null, totalDisposals: 0 };
  }
  return defaultManager.stats();
}

/** test 用: 台帳・能力の控え・読み込みの差し替えを全部捨てる。 */
export function resetGpuLeaseForTest(): void {
  defaultManager = null;
  testLoaders = null;
  threeLoaded = false;
  resetGpuCapabilityCache();
}
