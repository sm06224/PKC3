/** @vitest-environment happy-dom */
/**
 * 🔴 **関係グラフの大規模表示(GPU)と 3D 表示**(v4.0 Phase 3 / PR-13、ビジョン 1-C。`src/adapter/ui/render/graph-gpu.ts`)。
 * gpu-lease は偽物に差し替え、three は**実物**(InstancedMesh・LineSegments の数と後始末を数える)。
 *
 * 守る主張:
 * 1. 節点は InstancedMesh **1 つ**(count = 節点数)、辺は LineSegments を関係 / 本文のリンクの最大 2 つ
 * 2. ホバーで札が出て、押すと既存の `select-entry`(`data-pkc-entry`)が発火する ── 動かした手では開かない
 * 3. 2D はドラッグで移動・Ctrl + ホイールで拡大、3D はドラッグで回転・ホイールで寄る・0 でリセット
 * 4. 描き直しは `invalidate()` を頼むだけ(ドラッグ中は pinned)。ポスターは 1 コマ描いてから焼く
 * 5. GPU が使えなければ 2D の Canvas に描き、同じ当たり判定で開ける
 * 6. `session.dispose()` で geometry / material を全部返し、`dispose()` で描画面・listener を外す
 * 7. 関係グラフの既定(通常)では Three.js を 1 回も読まない・描画面も作らない。切り替えると前の GPU の図を返す
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GraphGpuView, setGraphGpuTestHooks } from '../../src/adapter/ui/render/graph-gpu';
import { GraphRenderer } from '../../src/adapter/ui/render/graph';
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
import { buildGraphView, GRAPH_GPU_MAX_NODES, type GraphView } from '../../src/features/relation/graph-view';
import { projectGraphPoints } from '../../src/features/relation/graph-gpu-layout';
import { initialState, type AppState } from '../../src/adapter/state/app-state';

interface FakeSurface extends GpuSurface {
  opts: GpuSurfaceOptions;
  invalidates: number;
  pinned: boolean[];
  disposed: number;
}

let surfaces: FakeSurface[] = [];

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
  calls: Array<{ scene: THREE.Scene; camera: THREE.Camera }>;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setPixelRatio(): void;
  setSize(): void;
  dispose(): void;
}

function fakeCtx(): { ctx: GpuContext; renderer: FakeRenderer; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  const renderer: FakeRenderer = {
    calls: [],
    render(scene, camera) {
      renderer.calls.push({ scene, camera });
    },
    setPixelRatio() {},
    setSize() {},
    dispose() {},
  };
  const ctx = { backend: 'webgl2', canvas, three: THREE, renderer, pixelRatio: 1 } as unknown as GpuContext;
  return { ctx, renderer, canvas };
}

const W = 400;
const H = 328;
const SIZE: GpuFrameSize = { width: W, height: H, pixelRatio: 1 };

const titles = (lids: string[]) => {
  const m = new Map(lids.map((l) => [l, `題${l}`]));
  return { has: (l: string) => m.has(l), get: (l: string) => m.get(l) };
};
const e = (a: string, b: string, kind = 'semantic') => ({ fromLid: a, toLid: b, kind });

/** 環 + 弦の大きな図(本文のリンクも少し混ぜる)。 */
function bigView(n: number): GraphView {
  const lids = Array.from({ length: n }, (_, i) => `n${String(i).padStart(4, '0')}`);
  const edges = lids.flatMap((l, i) => [
    e(l, lids[(i + 1) % n]!),
    ...(i % 9 === 0 ? [e(l, lids[(i * 7 + 3) % n]!, 'body-link')] : []),
  ]);
  return buildGraphView({ center: null, depth: 2, edges, titles: titles(lids), maxNodes: GRAPH_GPU_MAX_NODES });
}

let host: HTMLElement;

/** 描画面に大きさを与える(happy-dom は layout しない)。 */
function sized(view: GraphGpuView): void {
  Object.defineProperty(view.stage, 'clientWidth', { configurable: true, value: W });
  Object.defineProperty(view.stage, 'clientHeight', { configurable: true, value: H });
  view.stage.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

function mount(view: GraphView, mode: 'gpu2d' | 'gpu3d', centerLid: string | null = null, selectedLid: string | null = null) {
  const v = new GraphGpuView({ host, view, mode, centerLid, selectedLid });
  sized(v);
  const surface = surfaces[surfaces.length - 1]!;
  return { v, surface };
}

async function acquire(surface: FakeSurface) {
  const f = fakeCtx();
  const session = (await surface.opts.onAcquire(f.ctx)) as GpuSession;
  // 借りられた(畳まれていない)状態
  (surface as { state: string }).state = 'active';
  return { ...f, session };
}

const down = (el: Element, x: number, y: number, extra: PointerEventInit = {}) =>
  el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true, ...extra }));
const move = (el: Element, x: number, y: number, extra: PointerEventInit = {}) =>
  el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: y, bubbles: true, ...extra }));
const up = (el: Element, x: number, y: number) =>
  el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: x, clientY: y, button: 0, bubbles: true }));

/** 押された `select-entry` を拾う(binder の delegation と同じく、host で受ける)。 */
function captureOpens(): string[] {
  const opened: string[] = [];
  host.addEventListener('click', (ev) => {
    const a = (ev.target as Element).closest('[data-pkc-action]');
    if (a?.getAttribute('data-pkc-action') === 'select-entry') opened.push(a.getAttribute('data-pkc-entry') ?? '');
  });
  return opened;
}

/** 映っている節点の 1 つ(画面の座標)。 */
function someNode(v: GraphGpuView): { lid: string; x: number; y: number } {
  const pr = v.project();
  const i = pr.findIndex((p) => p.visible && p.sx > 30 && p.sx < W - 30 && p.sy > 30 && p.sy < H - 30);
  const x = pr[i]!.sx;
  const y = pr[i]!.sy;
  // ⚠ 3D では手前の別の節点が重なりうる ── その点で「当たる」節点(いちばん手前)を答えにする
  const lid = v.pickAt(x, y);
  expect(lid).not.toBeNull();
  return { lid: lid!, x, y };
}

beforeEach(() => {
  surfaces = [];
  setGraphGpuTestHooks({ createSurface: fakeFactory });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  setGraphGpuTestHooks(null);
  host.remove();
  vi.restoreAllMocks();
});

describe('🔴 1 回の draw call にまとめる(InstancedMesh + LineSegments)', () => {
  it.each(['gpu2d', 'gpu3d'] as const)('%s: 節点 1000 件が InstancedMesh 1 つ、辺は 2 つの LineSegments', async (mode) => {
    const view = bigView(1000);
    const { v, surface } = mount(view, mode);
    expect(surface.invalidates).toBe(1); // 最初の 1 コマだけ頼む
    const { session, renderer } = await acquire(surface);
    session.render(SIZE);
    const scene = renderer.calls[0]!.scene;
    const meshes = scene.children.filter((o) => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[];
    const lines = scene.children.filter((o) => (o as THREE.LineSegments).isLineSegments) as THREE.LineSegments[];
    expect(meshes).toHaveLength(1);
    expect(meshes[0]!.count).toBe(1000);
    expect(lines).toHaveLength(2);
    const rel = view.edges.filter((x) => x.kind !== 'body-link').length;
    const link = view.edges.length - rel;
    expect(lines.map((l) => l.geometry.getAttribute('position').count).sort((a, b) => a - b)).toEqual(
      [rel * 2, link * 2].sort((a, b) => a - b),
    );
    expect(renderer.calls[0]!.camera).toBeInstanceOf(mode === 'gpu3d' ? THREE.PerspectiveCamera : THREE.OrthographicCamera);
    expect(v.state).toBe('ready');
    v.dispose();
  });

  it('2D: 節点の位置は当たり判定の投影と同じ場所(ワールドの px = 画面の px、倍率 1)', async () => {
    const view = bigView(120);
    const { v, surface } = mount(view, 'gpu2d');
    const { session, renderer } = await acquire(surface);
    session.render(SIZE);
    const mesh = renderer.calls[0]!.scene.children.find((o) => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    const cam = renderer.calls[0]!.camera as THREE.OrthographicCamera;
    const pr = projectGraphPoints(v.graphPoints, null, W, H, 'gpu2d', v.camera2d);
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    for (const i of [0, 17, 119]) {
      mesh.getMatrixAt(i, m);
      pos.setFromMatrixPosition(m);
      // ワールド → 画面: x - left, top - y
      // ⚠ 行列は Float32(有効 7 桁)
      expect(pos.x - cam.left).toBeCloseTo(pr[i]!.sx, 3);
      expect(cam.top - pos.y).toBeCloseTo(pr[i]!.sy, 3);
    }
    v.dispose();
  });

  it('選んだ節点とホバーの節点だけアクセントの色、ほかは地の色', async () => {
    const view = bigView(80);
    const sel = view.nodes[3]!.lid;
    const { v, surface } = mount(view, 'gpu2d', null, sel);
    const { session, renderer } = await acquire(surface);
    session.render(SIZE);
    const mesh = renderer.calls[0]!.scene.children.find((o) => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    const c = new THREE.Color();
    const colors = new Set<string>();
    let selColor = '';
    for (let i = 0; i < 80; i += 1) {
      mesh.getColorAt(i, c);
      colors.add(c.getHexString());
      if (i === 3) selColor = c.getHexString();
    }
    expect(colors.size).toBe(2);
    mesh.getColorAt(0, c);
    expect(c.getHexString()).not.toBe(selColor);
    v.dispose();
  });
});

describe('🔴 ホバーと押下(既存の select-entry)', () => {
  it.each(['gpu2d', 'gpu3d'] as const)('%s: ホバーで札が出て、押すとそのノートの select-entry が発火する', async (mode) => {
    const opened = captureOpens();
    const { v, surface } = mount(bigView(200), mode);
    const { session } = await acquire(surface);
    session.render(SIZE);
    const n = someNode(v);
    const before = surface.invalidates;
    move(v.stage, n.x, n.y);
    expect(v.hoverLid).toBe(n.lid);
    expect(v.hoverButton.hidden).toBe(false);
    expect(v.hoverButton.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(v.hoverButton.textContent).toContain(`題${n.lid}`);
    expect(v.hoverButton.textContent).toMatch(/つながり \d+/);
    expect(v.stage.style.cursor).toBe('pointer');
    expect(surface.invalidates).toBe(before + 1); // ホバーの節点が変わった 1 回だけ
    move(v.stage, n.x, n.y); // 同じ節点の上 ── 描き直さない
    expect(surface.invalidates).toBe(before + 1);
    down(v.stage, n.x, n.y);
    up(v.stage, n.x, n.y);
    expect(opened).toEqual([n.lid]);
    v.dispose();
  });

  it('何も無い所を押しても開かない', async () => {
    const opened = captureOpens();
    const { v, surface } = mount(bigView(30), 'gpu2d');
    await acquire(surface);
    const pr = v.project();
    // どの節点からも離れた点を探す
    let spot: { x: number; y: number } | null = null;
    for (let x = 5; x < W && spot === null; x += 7) {
      for (let y = 5; y < H && spot === null; y += 7) {
        if (pr.every((p) => Math.hypot(p.sx - x, p.sy - y) > 30)) spot = { x, y };
      }
    }
    expect(spot).not.toBeNull();
    down(v.stage, spot!.x, spot!.y);
    up(v.stage, spot!.x, spot!.y);
    expect(opened).toEqual([]);
    v.dispose();
  });

  it('🔴 動かした手(DRAG_SLOP 以上)では開かない ── 2D はカメラが動き、離した位置に節点があっても開かない', async () => {
    const opened = captureOpens();
    const { v, surface } = mount(bigView(200), 'gpu2d');
    await acquire(surface);
    const n = someNode(v);
    down(v.stage, n.x - 30, n.y);
    move(v.stage, n.x - 20, n.y, { buttons: 1 });
    move(v.stage, n.x, n.y, { buttons: 1 });
    up(v.stage, n.x, n.y);
    expect(opened).toEqual([]);
    expect(v.camera2d.x).toBeCloseTo(-30, 6); // 右へ 30px 引いた
    expect(surface.pinned).toEqual([true, false]);
    v.dispose();
  });

  it('DRAG_SLOP 未満の揺れはクリックのまま', async () => {
    const opened = captureOpens();
    const { v, surface } = mount(bigView(200), 'gpu2d');
    await acquire(surface);
    const n = someNode(v);
    down(v.stage, n.x, n.y);
    move(v.stage, n.x + 3, n.y + 3, { buttons: 1 });
    up(v.stage, n.x + 3, n.y + 3);
    expect(opened).toEqual([n.lid]);
    expect(v.camera2d).toEqual({ x: 0, y: 0, zoom: 1 });
    v.dispose();
  });

  it('Enter でホバー中のノートを開く', async () => {
    const opened = captureOpens();
    const { v, surface } = mount(bigView(200), 'gpu3d');
    await acquire(surface);
    const n = someNode(v);
    move(v.stage, n.x, n.y);
    v.stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(opened).toEqual([n.lid]);
    v.dispose();
  });
});

describe('🔴 カメラ', () => {
  it('2D: Ctrl + ホイールで拡大(ポインタの下が動かない)、ホイールだけでは何もしない、0 で 100%', async () => {
    const { v, surface } = mount(bigView(100), 'gpu2d');
    await acquire(surface);
    const plain = new WheelEvent('wheel', { deltaY: -200, clientX: 100, clientY: 80, bubbles: true, cancelable: true });
    v.stage.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(v.camera2d.zoom).toBe(1);
    // ⚠ happy-dom の WheelEvent は ctrlKey / clientX を受けない ── 実物と同じ値を event に置く(graph-canvas.test と同じ作法)
    const ctrl = new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true });
    for (const [k, val] of [['ctrlKey', true], ['clientX', 100], ['clientY', 80]] as const) {
      Object.defineProperty(ctrl, k, { value: val });
    }
    v.stage.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(v.camera2d.zoom).toBeGreaterThan(1);
    // 不動点: (100, 80) に映るワールドの点は同じ
    expect(v.camera2d.x + 100 / v.camera2d.zoom).toBeCloseTo(100, 6);
    expect(v.zoomText()).not.toBe('100%');
    v.stage.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    expect(v.camera2d).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(v.zoomText()).toBe('100%');
    v.dispose();
  });

  it('🔴 3D: 有効にしていないただのホイールは奪わず(preventDefault なし・カメラ不変)、Ctrl+ホイール / クリックで有効にした後は寄る。Esc・外側のクリックで抜ける', async () => {
    const { v, surface } = mount(bigView(100), 'gpu3d');
    await acquire(surface);
    const home = v.orbit!;
    const plain = new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true });
    v.stage.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(v.orbit).toEqual(home);
    // Ctrl(ピンチも ctrlKey 付きの wheel で届く)
    const ctrl = new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true });
    Object.defineProperty(ctrl, 'ctrlKey', { value: true });
    v.stage.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(v.orbit!.radius).toBeGreaterThan(home.radius);
    v.resetView();
    // クリックで有効 → 枠が出る
    down(v.stage, 10, 10);
    up(v.stage, 10, 10);
    expect(v.stage.hasAttribute('data-pkc-graph-active')).toBe(true);
    const act = new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true });
    v.stage.dispatchEvent(act);
    expect(act.defaultPrevented).toBe(true);
    // Esc で抜ける(Esc は外へ流さない)
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    v.stage.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(v.stage.hasAttribute('data-pkc-graph-active')).toBe(false);
    const after = new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true });
    v.stage.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    // 外側のクリックで抜ける
    down(v.stage, 10, 10);
    up(v.stage, 10, 10);
    expect(v.stage.hasAttribute('data-pkc-graph-active')).toBe(true);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, bubbles: true }));
    expect(v.stage.hasAttribute('data-pkc-graph-active')).toBe(false);
    v.dispose();
  });

  it('3D: ドラッグで回転・Shift + ドラッグで移動・ホイールで寄る・+ / − / 0 / 矢印', async () => {
    const { v, surface } = mount(bigView(100), 'gpu3d');
    await acquire(surface);
    const home = v.orbit!;
    const n0 = surface.invalidates;
    down(v.stage, 10, 10);
    move(v.stage, 60, 10, { buttons: 1 });
    up(v.stage, 60, 10);
    expect(v.orbit!.theta).not.toBeCloseTo(home.theta, 6);
    expect(v.orbit!.target).toEqual(home.target);
    expect(surface.invalidates).toBe(n0 + 1); // 操作 1 回 → 1 コマ(慣性なし)
    v.stage.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    expect(v.orbit).toEqual(home);
    down(v.stage, 10, 10, { shiftKey: true });
    move(v.stage, 60, 10, { buttons: 1, shiftKey: true });
    up(v.stage, 60, 10);
    expect(v.orbit!.target).not.toEqual(home.target);
    expect(v.orbit!.theta).toBeCloseTo(home.theta, 9);
    v.resetView();
    const wheel = new WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true });
    v.stage.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(v.orbit!.radius).toBeGreaterThan(home.radius);
    v.resetView();
    v.stage.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    expect(v.orbit!.radius).toBeLessThan(home.radius);
    expect(Number.parseInt(v.zoomText(), 10)).toBeGreaterThan(100);
    v.stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(v.orbit!.theta).not.toBeCloseTo(home.theta, 6);
    v.dispose();
  });

  it('3D: 描画は軌道カメラの位置から注視点を見る(orbit-math と連動)', async () => {
    const { v, surface } = mount(bigView(60), 'gpu3d');
    const { session, renderer } = await acquire(surface);
    session.render(SIZE);
    const cam = renderer.calls[0]!.camera as THREE.PerspectiveCamera;
    const o = v.orbit!;
    expect(cam.position.distanceTo(new THREE.Vector3(...o.target))).toBeCloseTo(o.radius, 6);
    expect(cam.aspect).toBeCloseTo(W / H, 9);
    v.dispose();
  });
});

describe('🔴 ポスターと後始末', () => {
  it('ポスターは 1 コマ描いてから焼く', async () => {
    const { v, surface } = mount(bigView(60), 'gpu3d');
    const { session, renderer, canvas } = await acquire(surface);
    session.render(SIZE);
    const order: string[] = [];
    const orig = renderer.render;
    renderer.render = (s, c) => {
      order.push('render');
      orig(s, c);
    };
    canvas.toBlob = ((cb: BlobCallback) => {
      order.push('toBlob');
      cb(new Blob(['png'], { type: 'image/png' }));
    }) as HTMLCanvasElement['toBlob'];
    const blob = await session.capturePoster!();
    expect(blob).toBeInstanceOf(Blob);
    expect(order).toEqual(['render', 'toBlob']);
    v.dispose();
  });

  it('ポスターの上で触ると静かに GPU へ戻す(invalidate を頼む)', async () => {
    const { v, surface } = mount(bigView(60), 'gpu2d');
    const n0 = surface.invalidates;
    // 偽の描画面は state = 'idle'(畳まれた状態)── 借りている間('active')は押しただけでは描かない
    down(v.stage, 5, 5);
    up(v.stage, 5, 5);
    expect(surface.invalidates).toBe(n0 + 1);
    (surface as { state: string }).state = 'active';
    down(v.stage, 5, 5);
    up(v.stage, 5, 5);
    expect(surface.invalidates).toBe(n0 + 1);
    v.dispose();
  });

  it('session.dispose() で InstancedMesh・LineSegments の geometry と material を全部返す', async () => {
    const { v, surface } = mount(bigView(200), 'gpu3d');
    const { session, renderer } = await acquire(surface);
    session.render(SIZE);
    const scene = renderer.calls[0]!.scene;
    const disposed: string[] = [];
    const watch = (o: { dispose(): void }, name: string) => {
      const orig = o.dispose.bind(o);
      o.dispose = () => {
        disposed.push(name);
        orig();
      };
    };
    const mesh = scene.children.find((o) => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    watch(mesh, 'instanced');
    watch(mesh.geometry, 'node-geometry');
    watch(mesh.material as THREE.Material, 'node-material');
    const lines = scene.children.filter((o) => (o as THREE.LineSegments).isLineSegments) as THREE.LineSegments[];
    lines.forEach((l, i) => {
      watch(l.geometry, `line-geometry-${i}`);
      watch(l.material as THREE.Material, `line-material-${i}`);
    });
    session.dispose();
    expect(disposed.sort()).toEqual(
      ['instanced', 'node-geometry', 'node-material', 'line-geometry-0', 'line-geometry-1', 'line-material-0', 'line-material-1'].sort(),
    );
    expect(scene.children.filter((o) => (o as THREE.InstancedMesh).isInstancedMesh)).toHaveLength(0);
    v.dispose();
  });

  it('データの差し替えは同じ描画面のまま(GPU を借り直さない)、古い形は返す', async () => {
    const { v, surface } = mount(bigView(100), 'gpu2d');
    const { session, renderer } = await acquire(surface);
    session.render(SIZE);
    const old = renderer.calls[0]!.scene.children.find((o) => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    const spy = vi.spyOn(old, 'dispose');
    const n0 = surface.invalidates;
    v.update({ view: bigView(150), centerLid: null, selectedLid: null });
    expect(surfaces).toHaveLength(1);
    expect(surface.invalidates).toBe(n0 + 1);
    session.render(SIZE);
    const now = renderer.calls[1]!.scene.children.find((o) => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    expect(now.count).toBe(150);
    expect(spy).toHaveBeenCalledTimes(1);
    v.dispose();
  });

  it('ホバーだけの変化では形を作り直さない(位置・色だけ書き直す)', async () => {
    const { v, surface } = mount(bigView(100), 'gpu2d');
    const { session, renderer } = await acquire(surface);
    session.render(SIZE);
    const meshOf = () =>
      renderer.calls[0]!.scene.children.find((o) => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    // ⚠ 1 コマ目の直後に控える(同じ scene を後から探すと、作り直されても同じ物に見える)
    const a = meshOf();
    const m = new THREE.Matrix4();
    const n = someNode(v);
    const i = v.graphPoints.findIndex((p) => p.lid === n.lid);
    a.getMatrixAt(i, m);
    const before = new THREE.Vector3().setFromMatrixScale(m).x;
    move(v.stage, n.x, n.y);
    expect(v.hoverLid).toBe(n.lid);
    session.render(SIZE);
    expect(meshOf()).toBe(a);
    // 位置・大きさは書き直されている(ホバーの節点はやや大きく)
    a.getMatrixAt(i, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeGreaterThan(before);
    v.dispose();
  });

  it('dispose() で描画面を返し、listener も外す(以後の操作で描き直しを頼まない)', () => {
    const { v, surface } = mount(bigView(60), 'gpu2d');
    const stage = v.stage;
    v.dispose();
    expect(surface.disposed).toBe(1);
    expect(v.state).toBe('disposed');
    expect(host.querySelector('[data-pkc-field="graph-gpu"]')).toBeNull();
    const n0 = surface.invalidates;
    const w = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    Object.defineProperty(w, 'ctrlKey', { value: true });
    stage.dispatchEvent(w);
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    down(stage, 5, 5);
    expect(surface.invalidates).toBe(n0);
    // listener が外れている(カメラも動かない)
    expect(v.camera2d).toEqual({ x: 0, y: 0, zoom: 1 });
    v.dispose(); // 2 回目は何もしない
    expect(surface.disposed).toBe(1);
  });
});

describe('🔴 2D の Canvas の簡易表示', () => {
  it('理由を 1 行添え、Canvas に描き、同じ当たり判定で開ける', () => {
    const opened = captureOpens();
    const { v, surface } = mount(bigView(300), 'gpu3d');
    surface.opts.onFallback2d(v.stage, 'この端末のブラウザでは GPU の描画が使えないため、簡易表示にしています');
    expect(v.state).toBe('fallback');
    expect(v.element.getAttribute('data-pkc-graph-gpu-backend')).toBe('2d');
    expect(v.note.hidden).toBe(false);
    expect(v.note.textContent).toContain('簡易表示');
    const canvas = v.stage.querySelector('[data-pkc-field="graph-gpu-canvas2d"]');
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    const n = someNode(v);
    down(v.stage, n.x, n.y);
    up(v.stage, n.x, n.y);
    expect(opened).toEqual([n.lid]);
    // 操作は GPU を頼まない(その場で 2D に描く)
    const n0 = surface.invalidates;
    v.stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(surface.invalidates).toBe(n0);
    v.dispose();
    expect(surface.disposed).toBe(1);
  });

  it('描くのは辺と節点(Canvas の 2D の呼び出しを数える)', () => {
    const { v, surface } = mount(bigView(120), 'gpu2d');
    const calls = { arc: 0, lineTo: 0, fill: 0 };
    const ctx2d = {
      setTransform() {},
      clearRect() {},
      fillRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {
        calls.lineTo += 1;
      },
      arc() {
        calls.arc += 1;
      },
      stroke() {},
      fill() {
        calls.fill += 1;
      },
      setLineDash() {},
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx2d as never);
    surface.opts.onFallback2d(v.stage, '理由');
    const visible = v.project().filter((p) => p.visible).length;
    expect(calls.arc).toBe(visible);
    expect(calls.lineTo).toBeGreaterThan(100);
    v.dispose();
  });
});

describe('🔴 関係グラフの面(GraphRenderer)の切り替え', () => {
  const meta = (lid: string) =>
    ({ lid, title: `題${lid}`, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null }) as never;
  function bigState(n: number): AppState {
    const lids = Array.from({ length: n }, (_, i) => `n${String(i).padStart(4, '0')}`);
    return {
      ...initialState,
      entryMetas: new Map(lids.map((l) => [l, meta(l)])),
      relations: lids.map((l, i) => ({ id: `r${i}`, fromLid: l, toLid: lids[(i + 1) % n]!, kind: 'semantic' })) as never,
      selectedLid: lids[0]!,
      graphView: { ...initialState.graphView, all: true },
    } as AppState;
  }

  it('🔴 既定(通常)では描画面を作らず、Three.js を 1 回も読まない', async () => {
    setGraphGpuTestHooks(null); // 実物の gpu-lease
    resetGpuLeaseForTest();
    const load = vi.fn(async () => THREE);
    setThreeLoaderForTest({ loadThree: load, loadThreeWebGpu: load as never });
    const r = new GraphRenderer(host);
    r.render(bigState(200));
    await new Promise((res) => setTimeout(res, 0));
    expect(r.renderMode).toBe('dom');
    expect(r.gpuView).toBeNull();
    expect(host.querySelector('[data-pkc-field="graph-gpu"]')).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(gpuLeaseStats().threeLoaded).toBe(false);
    expect(host.querySelectorAll('[data-pkc-field="graph-map"] button')).toHaveLength(60);
    r.dispose();
    resetGpuLeaseForTest();
  });

  it('切れているとき「大規模表示で全部見る」を出し、押すと大規模表示(最大 1,000 件)へ', () => {
    const r = new GraphRenderer(host);
    r.render(bigState(1200));
    const more = host.querySelector<HTMLButtonElement>('[data-pkc-field="graph-more"]')!;
    expect(more.textContent).toBe('大規模表示で全部見る(最大 1,000 件)');
    more.click();
    expect(r.renderMode).toBe('gpu2d');
    expect(r.gpuView).not.toBeNull();
    expect(r.gpuView!.graphPoints).toHaveLength(1000);
    expect(host.querySelector('[data-pkc-field="graph-map"]')).toBeNull();
    expect(host.querySelector('[data-pkc-field="graph-more"]')).toBeNull();
    expect(host.querySelector('[data-pkc-graph-mode="gpu2d"]')!.getAttribute('aria-pressed')).toBe('true');
    r.dispose();
  });

  it('切れていなければ導線を出さない', () => {
    const r = new GraphRenderer(host);
    r.render(bigState(40));
    expect(host.querySelector('[data-pkc-field="graph-more"]')).toBeNull();
    r.dispose();
  });

  it('🔴 通常 → 大規模 → 3D → 通常: 切り替えのたびに前の GPU の図を返し、DOM の図へ双方向に戻れる', () => {
    const r = new GraphRenderer(host);
    r.render(bigState(300));
    const press = (m: string) => host.querySelector<HTMLButtonElement>(`[data-pkc-graph-mode="${m}"]`)!.click();
    press('gpu2d');
    const s2d = surfaces[surfaces.length - 1]!;
    expect(r.gpuView!.mode).toBe('gpu2d');
    press('gpu3d');
    expect(s2d.disposed).toBe(1);
    const s3d = surfaces[surfaces.length - 1]!;
    expect(s3d).not.toBe(s2d);
    expect(r.gpuView!.mode).toBe('gpu3d');
    press('dom');
    expect(s3d.disposed).toBe(1);
    expect(r.gpuView).toBeNull();
    expect(host.querySelector('[data-pkc-field="graph-gpu"]')).toBeNull();
    expect(host.querySelectorAll('[data-pkc-field="graph-map"] button')).toHaveLength(60);
    press('gpu2d');
    expect(r.gpuView!.mode).toBe('gpu2d');
    r.dispose();
    expect(surfaces[surfaces.length - 1]!.disposed).toBe(1);
  });

  it('🔴 大規模のまま図にならなくなった(ノートを選んでいない)ら、GPU の図を返して案内を出す', () => {
    const r = new GraphRenderer(host);
    const st = { ...bigState(100), graphView: { ...initialState.graphView, all: false } } as AppState;
    r.render(st);
    r.setRenderMode('gpu3d');
    const s = surfaces[surfaces.length - 1]!;
    expect(r.gpuView).not.toBeNull();
    r.render({ ...st, selectedLid: null });
    expect(s.disposed).toBe(1);
    expect(r.gpuView).toBeNull();
    expect(host.querySelector('[data-pkc-field="graph-gpu"]')).toBeNull();
    expect(host.querySelector('[data-pkc-field="graph-note"]')!.textContent).toContain('ノートを選ぶと');
    r.dispose();
  });

  it('面から出たら GPU の図を返し、戻れば組み直す(同じ state でも)', () => {
    const r = new GraphRenderer(host);
    const st = bigState(100);
    r.render(st);
    r.setRenderMode('gpu3d');
    const s = surfaces[surfaces.length - 1]!;
    r.onHidden();
    expect(s.disposed).toBe(1);
    expect(r.gpuView).toBeNull();
    r.render(st);
    expect(r.gpuView).not.toBeNull();
    expect(surfaces).toHaveLength(2);
    r.dispose();
  });

  it('選んだノートが変わっても描画面を借り直さない(中身だけ差し替える)', () => {
    const r = new GraphRenderer(host);
    const st = bigState(100);
    r.render(st);
    r.setRenderMode('gpu2d');
    const before = surfaces.length;
    r.render({ ...st, selectedLid: 'n0005' });
    expect(surfaces).toHaveLength(before);
    expect(r.gpuView).not.toBeNull();
    r.dispose();
  });

  it('バーの − / 倍率 / + は GPU の図のカメラを動かす', () => {
    const r = new GraphRenderer(host);
    r.render(bigState(100));
    r.setRenderMode('gpu2d');
    sized(r.gpuView!);
    host.querySelector<HTMLButtonElement>('[data-pkc-graph-zoom="in"]')!.click();
    expect(r.gpuView!.camera2d.zoom).toBeCloseTo(1.25, 9);
    expect(host.querySelector('[data-pkc-graph-zoom="reset"]')!.textContent).toBe('125%');
    // 2D のカメラは通常の図と共有(戻っても倍率を持ち越す)
    expect(r.camera.zoom).toBeCloseTo(1.25, 9);
    host.querySelector<HTMLButtonElement>('[data-pkc-graph-zoom="reset"]')!.click();
    expect(r.gpuView!.camera2d.zoom).toBe(1);
    r.dispose();
  });
});
