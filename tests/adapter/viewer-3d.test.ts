/** @vitest-environment happy-dom */
/**
 * 🔴 3D ビューア(v4.0 PR-12)── gpu-lease を偽物に差し替え、three は**実物**(geometry / material の後始末を数える)。
 *
 * 守ること:
 * - 描き直しは操作・切替のときだけ `invalidate()` を頼む(自分で rAF を回さない)
 * - 操作中は `setPinned(true)`、離したら `false`
 * - ポスターは 1 コマ描いてから焼く
 * - `session.dispose()` で geometry / material を全部返す、`dispose()` で描画面も外す
 * - GPU が使えない・1 枚にまとめた版では 2D に退避して理由を出す
 * - 外部参照は読む前に断る(描画面を作らない)・読み込み中の URL も止める
 * - ` ```3d ` の `asset:鍵` は呼び側の口で引く
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  VIEWER3D_BLOCKED_PREFIX,
  hydrate3d,
  localManager,
  mount3dViewer,
  parseModel,
  precheckModel,
  setViewer3dTestHooks,
  withTrackedObjectUrls,
} from '../../src/adapter/ui/render/viewer-3d';
import type { GpuContext, GpuFrameSize, GpuSession, GpuSurface, GpuSurfaceOptions } from '../../src/adapter/platform/render/gpu-lease';
import { parse3dSceneSpec, type SceneSpec } from '../../src/features/viewer3d/scene-spec';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

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
  calls: Array<{ scene: THREE.Scene; camera: THREE.PerspectiveCamera }>;
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void;
  setPixelRatio(): void;
  setSize(): void;
  dispose(): void;
}

function fakeCtx(): { ctx: GpuContext; renderer: FakeRenderer; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  const renderer: FakeRenderer = {
    calls: [],
    render(scene, camera) {
      renderer.calls.push({ scene, camera: camera.clone() });
    },
    setPixelRatio() {},
    setSize() {},
    dispose() {},
  };
  const ctx = { backend: 'webgl2', canvas, three: THREE, renderer, pixelRatio: 1 } as unknown as GpuContext;
  return { ctx, renderer, canvas };
}

const SIZE: GpuFrameSize = { width: 400, height: 300, pixelRatio: 1 };

function spec(src: string): SceneSpec {
  const r = parse3dSceneSpec(src);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** 最小のバイナリ STL(三角形 1 つ)。 */
function stlBlob(): Blob {
  const bytes = new Uint8Array(84 + 50);
  const v = new DataView(bytes.buffer);
  v.setUint32(80, 1, true);
  const f = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0];
  f.forEach((n, i) => v.setFloat32(84 + i * 4, n, true));
  return new Blob([bytes], { type: 'application/octet-stream' });
}

const OBJ_TEXT = 'o tri\nv 0 0 0\nv 2 0 0\nv 0 3 0\nf 1 2 3\n';

let host: HTMLElement;

beforeEach(() => {
  surfaces = [];
  setViewer3dTestHooks({ createSurface: fakeFactory });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  setViewer3dTestHooks(null);
  host.remove();
  vi.restoreAllMocks();
});

describe('mount3dViewer(` ```3d ` のシーン)', () => {
  it('置いただけでは借りない ── invalidate を 1 回頼むだけ(Three.js は gpu-lease が見えてから読む)', () => {
    mount3dViewer(host, { kind: 'scene', spec: spec('{"objects":[{"type":"box"}]}') });
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]!.invalidates).toBe(1);
    const root = host.querySelector('[data-pkc-3d-viewer]')!;
    expect(root.getAttribute('data-pkc-3d-state')).toBe('loading');
    expect(root.querySelector('[data-pkc-3d-info="format"]')!.textContent).toBe('3D シーン');
    expect(root.querySelector('[data-pkc-3d-info="size"]')!.textContent).toBe('オブジェクト 1 個');
    expect([...root.querySelectorAll('[data-pkc-3d-op]')].map((b) => b.textContent)).toEqual(['−', '+', '斜め', '正面', '上面', '視点をリセット', 'ワイヤーフレーム', 'グリッド', '拡大']);
    // 描画面は ` ```3d ` の height
    expect((root.querySelector('[data-pkc-3d-stage]') as HTMLElement).style.height).toBe('360px');
  });

  it('借りたら場面を組み、描く。描画方式を出す', async () => {
    mount3dViewer(host, { kind: 'scene', spec: spec('{"objects":[{"type":"box","label":"箱"},{"type":"sphere","position":[2,0,0]}],"axes":true}') });
    const { ctx, renderer } = fakeCtx();
    const session = await surfaces[0]!.opts.onAcquire(ctx);
    session.render(SIZE);
    expect(renderer.calls).toHaveLength(1);
    const meshes: THREE.Mesh[] = [];
    renderer.calls[0]!.scene.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) meshes.push(n as THREE.Mesh);
    });
    expect(meshes).toHaveLength(2);
    expect(host.querySelector('[data-pkc-3d-viewer]')!.getAttribute('data-pkc-3d-state')).toBe('ready');
    expect(host.querySelector('[data-pkc-3d-info="backend"]')!.textContent).toBe('WebGL2');
    // ラベルは重ね合わせの字
    expect(host.querySelector('.pkc-3d-label')!.textContent).toBe('箱');
    // 軸とグリッド
    const helpers: string[] = [];
    renderer.calls[0]!.scene.traverse((n) => helpers.push(n.type));
    expect(helpers).toContain('GridHelper');
    expect(helpers).toContain('AxesHelper');
  });

  it('🔴 ドラッグ・ホイール・キーで視点が変わり、そのたびに invalidate を 1 回頼む。操作中は pinned', async () => {
    mount3dViewer(host, { kind: 'scene', spec: spec('{"objects":[{"type":"box"}]}') });
    const s = surfaces[0]!;
    const { ctx, renderer } = fakeCtx();
    const session = await s.opts.onAcquire(ctx);
    session.render(SIZE);
    const before = renderer.calls[0]!.camera.position.clone();
    const stage = host.querySelector<HTMLElement>('[data-pkc-3d-stage]')!;
    const n0 = s.invalidates;
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, buttons: 1, bubbles: true }));
    expect(s.pinned.at(-1)).toBe(true);
    stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 160, clientY: 120, buttons: 1, bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    expect(s.pinned.at(-1)).toBe(false);
    expect(s.invalidates).toBe(n0 + 2); // 押した(ポスターから戻す)+ 動かした
    session.render(SIZE);
    const after = renderer.calls[1]!.camera.position;
    expect(after.distanceTo(before)).toBeGreaterThan(0.1);
    // ホイール
    const r0 = after.length();
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 500, bubbles: true, cancelable: true }));
    session.render(SIZE);
    expect(renderer.calls[2]!.camera.position.length()).toBeGreaterThan(r0);
    // キー(0 で戻す)
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    session.render(SIZE);
    expect(renderer.calls[3]!.camera.position.distanceTo(before)).toBeLessThan(1e-9);
    expect(s.invalidates).toBe(n0 + 4);
  });

  it('🔴 ホイール: 有効にしていないただのホイールは奪わず、Ctrl+ホイール / クリックで有効にした後だけ寄る。Esc・外側のクリックで抜ける', async () => {
    mount3dViewer(host, { kind: 'scene', spec: spec('{"objects":[{"type":"box"}]}') });
    const s = surfaces[0]!;
    const { ctx, renderer } = fakeCtx();
    const session = await s.opts.onAcquire(ctx);
    session.render(SIZE);
    const stage = host.querySelector<HTMLElement>('[data-pkc-3d-stage]')!;
    const dist = (): number => renderer.calls.at(-1)!.camera.position.length();
    const r0 = dist();
    const n0 = s.invalidates;
    const plain = new WheelEvent('wheel', { deltaY: 500, bubbles: true, cancelable: true });
    stage.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(s.invalidates).toBe(n0); // 何も頼まない(親のスクロールに任せる)
    const ctrl = new WheelEvent('wheel', { deltaY: 500, bubbles: true, cancelable: true });
    Object.defineProperty(ctrl, 'ctrlKey', { value: true });
    stage.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    session.render(SIZE);
    expect(dist()).toBeGreaterThan(r0);
    // クリックで有効
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 5, clientY: 5, buttons: 1, bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    expect(stage.hasAttribute('data-pkc-3d-active')).toBe(true);
    const act = new WheelEvent('wheel', { deltaY: 500, bubbles: true, cancelable: true });
    stage.dispatchEvent(act);
    expect(act.defaultPrevented).toBe(true);
    // Esc で抜ける
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    stage.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(stage.hasAttribute('data-pkc-3d-active')).toBe(false);
    const after = new WheelEvent('wheel', { deltaY: 500, bubbles: true, cancelable: true });
    stage.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    // 外側のクリックで抜ける
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 5, clientY: 5, buttons: 1, bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    expect(stage.hasAttribute('data-pkc-3d-active')).toBe(true);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, bubbles: true }));
    expect(stage.hasAttribute('data-pkc-3d-active')).toBe(false);
  });

  it('🔴 ツールバー: − / + のズーム・視点プリセット・拡大の入り切り(aria-pressed で高さが大きく変わる)', async () => {
    mount3dViewer(host, { kind: 'scene', spec: spec('{"objects":[{"type":"box"}]}') });
    const s = surfaces[0]!;
    const { ctx, renderer } = fakeCtx();
    const session = await s.opts.onAcquire(ctx);
    session.render(SIZE);
    const btn = (op: string): HTMLButtonElement => host.querySelector(`[data-pkc-3d-op="${op}"]`)!;
    expect(btn('zoom-out').getAttribute('aria-label')).toBe('ズームアウト');
    expect(btn('zoom-in').getAttribute('aria-label')).toBe('ズームイン');
    const pos = (): THREE.Vector3 => renderer.calls.at(-1)!.camera.position.clone();
    const r0 = pos().length();
    btn('zoom-in').click();
    session.render(SIZE);
    expect(pos().length()).toBeLessThan(r0);
    btn('zoom-out').click();
    btn('zoom-out').click();
    session.render(SIZE);
    expect(pos().length()).toBeGreaterThan(r0);
    btn('preset-front').click();
    session.render(SIZE);
    const f = pos();
    btn('preset-top').click();
    session.render(SIZE);
    const t = pos();
    btn('preset-oblique').click();
    session.render(SIZE);
    const o = pos();
    expect(Math.abs(f.y)).toBeLessThan(0.5 * f.length());
    expect(t.y).toBeGreaterThan(0.99 * t.length());
    expect(o.distanceTo(f)).toBeGreaterThan(0.1);
    expect(o.distanceTo(t)).toBeGreaterThan(0.1);
    // 拡大
    const stage = host.querySelector<HTMLElement>('[data-pkc-3d-stage]')!;
    expect(btn('expand').getAttribute('aria-pressed')).toBe('false');
    expect(stage.style.height).toBe('360px');
    btn('expand').click();
    expect(btn('expand').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-pkc-3d-viewer]')!.hasAttribute('data-pkc-3d-expanded')).toBe(true);
    btn('expand').click();
    expect(btn('expand').getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('[data-pkc-3d-viewer]')!.hasAttribute('data-pkc-3d-expanded')).toBe(false);
    expect(stage.style.height).toBe('360px');
  });

  it('🔴 ワイヤーフレーム・グリッドの切替は描き直しを頼み、次の 1 コマに効く。リセットは最初の視点', async () => {
    mount3dViewer(host, { kind: 'scene', spec: spec('{"objects":[{"type":"box"}]}') });
    const s = surfaces[0]!;
    const { ctx, renderer } = fakeCtx();
    const session = await s.opts.onAcquire(ctx);
    session.render(SIZE);
    const home = renderer.calls[0]!.camera.position.clone();
    const btn = (op: string): HTMLButtonElement => host.querySelector(`[data-pkc-3d-op="${op}"]`)!;
    const mesh = (): THREE.Mesh => {
      let m: THREE.Mesh | null = null;
      renderer.calls.at(-1)!.scene.traverse((n) => {
        if ((n as THREE.Mesh).isMesh) m = n as THREE.Mesh;
      });
      return m!;
    };
    const grid = (): THREE.Object3D => {
      let g: THREE.Object3D | null = null;
      renderer.calls.at(-1)!.scene.traverse((n) => {
        if (n.type === 'GridHelper') g = n;
      });
      return g!;
    };
    expect((mesh().material as THREE.MeshStandardMaterial).wireframe).toBe(false);
    expect(grid().visible).toBe(true);
    const n0 = s.invalidates;
    btn('wireframe').click();
    btn('grid').click();
    expect(s.invalidates).toBe(n0 + 2);
    expect(btn('wireframe').getAttribute('aria-pressed')).toBe('true');
    expect(btn('grid').getAttribute('aria-pressed')).toBe('false');
    session.render(SIZE);
    expect((mesh().material as THREE.MeshStandardMaterial).wireframe).toBe(true);
    expect(grid().visible).toBe(false);
    // 回してからリセット
    const stage = host.querySelector<HTMLElement>('[data-pkc-3d-stage]')!;
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    session.render(SIZE);
    expect(renderer.calls.at(-1)!.camera.position.distanceTo(home)).toBeGreaterThan(0.01);
    btn('reset').click();
    session.render(SIZE);
    expect(renderer.calls.at(-1)!.camera.position.distanceTo(home)).toBeLessThan(1e-9);
  });

  it('🔴 配色が変わったら描き直しを頼む・無関係な属性の変化では頼まない(畳んだ GPU を借り直さない)', async () => {
    mount3dViewer(host, { kind: 'scene', spec: spec('{"objects":[{"type":"box"}]}') });
    const s = surfaces[0]!;
    const html = document.documentElement;
    const n0 = s.invalidates;
    html.setAttribute('data-pkc-unrelated', String(Math.random()));
    await flush();
    expect(s.invalidates, '無関係な属性で描き直した').toBe(n0);
    html.setAttribute('data-pkc-theme', html.getAttribute('data-pkc-theme') === 'dark' ? 'light' : 'dark');
    await flush();
    expect(s.invalidates).toBe(n0 + 1);
    html.removeAttribute('data-pkc-unrelated');
  });

  it('🔴 ポスター: 1 コマ描いてから PNG に焼く', async () => {
    mount3dViewer(host, { kind: 'scene', spec: spec('{"objects":[{"type":"box"}]}') });
    const { ctx, renderer, canvas } = fakeCtx();
    const png = new Blob(['x'], { type: 'image/png' });
    let renderedBeforeBlob = -1;
    canvas.toBlob = ((cb: BlobCallback, type?: string) => {
      renderedBeforeBlob = renderer.calls.length;
      expect(type).toBe('image/png');
      cb(png);
    }) as HTMLCanvasElement['toBlob'];
    const session = await surfaces[0]!.opts.onAcquire(ctx);
    const poster = await session.capturePoster!();
    expect(poster).toBe(png);
    expect(renderedBeforeBlob).toBe(1);
  });

  it('🔴 session.dispose で geometry / material を全部返す', async () => {
    const geo = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const mat = vi.spyOn(THREE.Material.prototype, 'dispose');
    mount3dViewer(host, { kind: 'scene', spec: spec('{"objects":[{"type":"box"},{"type":"torus"},{"type":"plane"}],"axes":true}') });
    const { ctx } = fakeCtx();
    const session: GpuSession = await surfaces[0]!.opts.onAcquire(ctx);
    session.render(SIZE);
    geo.mockClear();
    mat.mockClear();
    session.dispose();
    // 立体 3 + グリッド 1 + 軸 1
    expect(geo.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(mat.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('🔴 dispose で描画面を返し、listener も外れる(以後の操作は何も頼まない)', () => {
    const moDisconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const v = mount3dViewer(host, { kind: 'scene', spec: spec('{"objects":[{"type":"box"}]}') });
    const s = surfaces[0]!;
    const stage = host.querySelector<HTMLElement>('[data-pkc-3d-stage]')!;
    const removed: string[] = [];
    const rm = stage.removeEventListener.bind(stage);
    stage.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: EventListenerOptions | boolean) => {
      removed.push(type);
      rm(type, fn, o);
    }) as typeof stage.removeEventListener;
    v.dispose();
    // 描画面の上の listener は全部外れる・テーマの見張りも外れる
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'keydown', 'contextmenu', 'dblclick']) {
      expect(removed, t).toContain(t);
    }
    expect(moDisconnect).toHaveBeenCalled();
    expect(s.disposed).toBe(1);
    expect(host.querySelector('[data-pkc-3d-viewer]')).toBeNull();
    const n = s.invalidates;
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
    expect(s.invalidates).toBe(n);
    v.dispose(); // 2 回目も安全
    expect(s.disposed).toBe(1);
  });

  it('🔴 2D の簡易表示: 理由を出し、線画の canvas を置く(空の枠にしない)', () => {
    mount3dViewer(host, { kind: 'scene', spec: spec('{"objects":[{"type":"box"}]}') });
    const s = surfaces[0]!;
    s.opts.onFallback2d(s.opts.host, 'GPU が使えないため、簡易表示にしています');
    const root = host.querySelector('[data-pkc-3d-viewer]')!;
    expect(root.getAttribute('data-pkc-3d-state')).toBe('fallback');
    expect(root.querySelector('[data-pkc-3d-note]')!.textContent).toBe('GPU が使えないため、簡易表示にしています');
    expect(root.querySelector('[data-pkc-3d-info="backend"]')!.textContent).toBe('2D 簡易表示');
    expect(root.querySelector('[data-pkc-3d-canvas2d]')).not.toBeNull();
    // 2D では GPU に頼まない
    const n = s.invalidates;
    root.querySelector<HTMLButtonElement>('[data-pkc-3d-op="grid"]')!.click();
    expect(s.invalidates).toBe(n);
  });
});

describe('mount3dViewer(添付の 3D モデル)', () => {
  it('🔴 STL を読み、寸法を出す', async () => {
    mount3dViewer(host, { kind: 'model', model: { blob: stlBlob(), format: 'stl', name: 'tri.stl' } });
    await flush();
    expect(surfaces).toHaveLength(1);
    const { ctx, renderer } = fakeCtx();
    const session = await surfaces[0]!.opts.onAcquire(ctx);
    session.render(SIZE);
    expect(host.querySelector('[data-pkc-3d-info="format"]')!.textContent).toBe('STL');
    expect(host.querySelector('[data-pkc-3d-info="size"]')!.textContent).toBe('寸法 1 × 1 × 0');
    let meshes = 0;
    renderer.calls[0]!.scene.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) meshes += 1;
    });
    expect(meshes).toBe(1);
  });

  it('OBJ を読む', async () => {
    mount3dViewer(host, { kind: 'model', model: { blob: new Blob([OBJ_TEXT], { type: 'text/plain' }), format: 'obj' } });
    await flush();
    const { ctx } = fakeCtx();
    const session = await surfaces[0]!.opts.onAcquire(ctx);
    session.render(SIZE);
    expect(host.querySelector('[data-pkc-3d-info="size"]')!.textContent).toBe('寸法 2 × 3 × 0');
  });

  it('🔴 外部の .bin を指す glTF は、描画面を作る前に理由つきで断る', async () => {
    const gltf = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.com/scene.bin', byteLength: 4 }] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    mount3dViewer(host, { kind: 'model', model: { blob: new Blob([gltf]), format: 'gltf' } });
    await flush();
    expect(surfaces).toHaveLength(0);
    const root = host.querySelector('[data-pkc-3d-viewer]')!;
    expect(root.getAttribute('data-pkc-3d-state')).toBe('failed');
    expect(root.querySelector('[data-pkc-3d-note]')!.textContent).toContain('外部');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('2D の簡易表示: 形式と大きさの案内を出す', async () => {
    mount3dViewer(host, { kind: 'model', model: { blob: stlBlob(), format: 'stl', name: 'tri.stl' } });
    await flush();
    surfaces[0]!.opts.onFallback2d(surfaces[0]!.opts.host, '理由');
    const card = host.querySelector('[data-pkc-3d-card]')!;
    expect(card.textContent).toContain('STL の 3D モデル');
    expect(card.textContent).toContain('tri.stl');
    expect(card.textContent).toContain('添付をダウンロード');
  });
});

describe('parseModel ── 読み込み中の URL も止める', () => {
  it('🔴 検めをすり抜けた外部参照(相対パス)は URL の検問で止まる', async () => {
    const gltf = JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'scene.bin', byteLength: 4 }],
      bufferViews: [{ buffer: 0, byteLength: 4 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'SCALAR' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(parseModel(THREE, { blob: new Blob([gltf]), format: 'gltf' })).rejects.toThrow(VIEWER3D_BLOCKED_PREFIX);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('埋め込みの glTF(data: のバッファ)は読める', async () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const b64 = Buffer.from(pos.buffer).toString('base64');
    const gltf = JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: `data:application/octet-stream;base64,${b64}`, byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    });
    const obj = await parseModel(THREE, { blob: new Blob([gltf]), format: 'gltf' });
    let meshes = 0;
    obj.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) meshes += 1;
    });
    expect(meshes).toBe(1);
    // 包んだ URL.createObjectURL は元に戻っている
    expect(URL.createObjectURL.name).not.toBe('');
  });
});

describe('hydrate3d(` ```3d ` の器)', () => {
  function render(md: string): HTMLElement {
    const div = document.createElement('div');
    div.className = 'pkc-md-rendered';
    div.innerHTML = renderMarkdown(md);
    host.append(div);
    return div;
  }

  it('🔴 器が無ければ何もしない(描画面を作らない)', () => {
    const div = render('# 見出し\n\n```json\n{"objects":[]}\n```\n');
    const scope = hydrate3d(div);
    expect(surfaces).toHaveLength(0);
    expect(scope.prune()).toBe(0);
  });

  it('器にビューアを置き、prune / dispose で畳む', () => {
    const div = render('```3d\n{"objects":[{"type":"cone"}]}\n```\n');
    const scope = hydrate3d(div);
    const ph = div.querySelector('[data-pkc-3d-src]')!;
    expect(ph.getAttribute('data-pkc-3d-state')).toBe('ready');
    expect(ph.querySelector('[data-pkc-3d-viewer]')).not.toBeNull();
    expect(scope.prune()).toBe(1);
    // 同じ器を 2 度渡しても 2 枚目は置かない
    hydrate3d(div);
    expect(surfaces).toHaveLength(1);
    ph.remove();
    expect(scope.prune()).toBe(0);
    expect(surfaces[0]!.disposed).toBe(1);
    scope.dispose();
  });

  it('🔴 書式の誤り・外部 URL は理由を器に残す(読みに行かない)', () => {
    const getAssetBlob = vi.fn();
    const div = render('```3d\n{"model":"https://example.com/a.glb"}\n```\n\n```3d\n{"objects":[\n```\n');
    hydrate3d(div, { getAssetBlob });
    const hosts = [...div.querySelectorAll('[data-pkc-3d-src]')];
    expect(hosts.map((h) => h.getAttribute('data-pkc-3d-state'))).toEqual(['failed', 'failed']);
    expect(hosts[0]!.getAttribute('data-pkc-3d-error')).toContain('外部の URL');
    expect(hosts[1]!.getAttribute('data-pkc-3d-error')).toContain('JSON が読めません');
    expect(getAssetBlob).not.toHaveBeenCalled();
    expect(surfaces).toHaveLength(0);
  });

  it('🔴 asset:鍵 は呼び側の口で引き、形式は中身から言い当てる', async () => {
    const getAssetBlob = vi.fn(async (key: string) => (key === 'ast-stl' ? { blob: stlBlob() } : null));
    const div = render('```3d\n{"model":"asset:ast-stl","grid":false}\n```\n\n```3d\n{"model":"asset:ast-none"}\n```\n');
    hydrate3d(div, { getAssetBlob });
    await flush();
    expect(getAssetBlob.mock.calls.map((c) => c[0])).toEqual(['ast-stl', 'ast-none']);
    const hosts = [...div.querySelectorAll('[data-pkc-3d-src]')];
    expect(hosts[0]!.getAttribute('data-pkc-3d-state')).toBe('ready');
    expect(hosts[0]!.querySelector('[data-pkc-3d-info="format"]')!.textContent).toBe('STL');
    expect(hosts[1]!.getAttribute('data-pkc-3d-state')).toBe('failed');
    expect(hosts[1]!.getAttribute('data-pkc-3d-error')).toContain('見つかりません');
  });

  it('口を渡さない面では、モデルだけ断る(シーンの立体は描く)', async () => {
    const div = render('```3d\n{"model":"asset:k"}\n```\n\n```3d\n{"objects":[{"type":"box"}]}\n```\n');
    hydrate3d(div);
    await flush();
    const hosts = [...div.querySelectorAll('[data-pkc-3d-src]')];
    expect(hosts[0]!.getAttribute('data-pkc-3d-state')).toBe('failed');
    expect(hosts[1]!.getAttribute('data-pkc-3d-state')).toBe('ready');
  });
});

describe('読んでいる間に作られた blob: だけを許す(着地前レビュー R1 / R2 / W4)', () => {
  it('🔴 包んでいる間に作られた URL は許可に入り、URL の検問を通る。外の blob: は止まる', async () => {
    const allowed = new Set<string>();
    const manager = localManager(THREE, allowed);
    let made = '';
    await withTrackedObjectUrls(allowed, async () => {
      made = URL.createObjectURL(new Blob(['img']));
    });
    expect(allowed.has(made)).toBe(true);
    expect(manager.resolveURL(made)).toBe(made);
    const outside = URL.createObjectURL(new Blob(['x']));
    expect(allowed.has(outside), '包みの外で作った URL まで許した').toBe(false);
    expect(() => manager.resolveURL(outside)).toThrow(VIEWER3D_BLOCKED_PREFIX);
    expect(() => manager.resolveURL('https://example.com/a.png')).toThrow(VIEWER3D_BLOCKED_PREFIX);
    URL.revokeObjectURL(made);
    URL.revokeObjectURL(outside);
  });

  it('🔴 2 本同時に読んでも両方が自分の URL を許し、終われば元の関数そのものへ戻る', async () => {
    const original = URL.createObjectURL;
    const a = new Set<string>();
    const b = new Set<string>();
    let releaseA!: () => void;
    const pa = withTrackedObjectUrls(a, () => new Promise<void>((r) => (releaseA = r)));
    let inB = '';
    let afterA = '';
    const pb = withTrackedObjectUrls(b, async () => {
      inB = URL.createObjectURL(new Blob(['b']));
      releaseA();
      await pa;
      // A が先に終わっても、B の許可は生きている
      afterA = URL.createObjectURL(new Blob(['b2']));
    });
    await pb;
    expect(b.has(inB)).toBe(true);
    expect(b.has(afterA), 'A が終わった時点で B の見張りが外れた').toBe(true);
    expect(URL.createObjectURL, '元の関数へ戻っていない').toBe(original);
    for (const u of [inB, afterA]) URL.revokeObjectURL(u);
  });

  it('🔴 失敗したら、その間に作った URL を返す(GLTFLoader は失敗の経路で revoke しない)', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const allowed = new Set<string>();
    let made = '';
    await expect(
      withTrackedObjectUrls(allowed, async () => {
        made = URL.createObjectURL(new Blob(['img']));
        throw new Error('壊れた');
      }),
    ).rejects.toThrow('壊れた');
    expect(revoke).toHaveBeenCalledWith(made);
  });

  it('包んでいる間に他が差し替えた関数は壊さない', async () => {
    const original = URL.createObjectURL;
    const other = ((o: Blob) => original.call(URL, o)) as typeof URL.createObjectURL;
    await withTrackedObjectUrls(new Set(), async () => {
      URL.createObjectURL = other;
    });
    expect(URL.createObjectURL).toBe(other);
    URL.createObjectURL = original;
  });
});

describe('飛んでいる間に外したら、描画面を作らない(着地前レビュー W1)', () => {
  it('🔴 モデルの検めの途中で dispose → 描画面を作らない', async () => {
    const v = mount3dViewer(host, { kind: 'model', model: { blob: stlBlob(), format: 'stl' } });
    v.dispose();
    await flush();
    expect(surfaces).toHaveLength(0);
  });

  it('🔴 添付を引いている途中で畳む → 描画面を作らない', async () => {
    let resolve!: (v: { blob: Blob }) => void;
    const getAssetBlob = vi.fn(() => new Promise<{ blob: Blob }>((r) => (resolve = r)));
    const div = document.createElement('div');
    div.innerHTML = renderMarkdown('```3d\n{"model":"asset:k"}\n```\n');
    host.append(div);
    const scope = hydrate3d(div, { getAssetBlob });
    expect(getAssetBlob).toHaveBeenCalledTimes(1);
    scope.dispose();
    resolve({ blob: stlBlob() });
    await flush();
    expect(surfaces).toHaveLength(0);
    expect(div.querySelector('[data-pkc-3d-viewer]')).toBeNull();
  });
});

describe('静止時の rAF = 0(描き直しは gpu-lease に頼むだけ)', () => {
  it('🔴 ビューアは自分で requestAnimationFrame を呼ばない(置く・操作・切替・2D 退避)', async () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    mount3dViewer(host, { kind: 'scene', spec: spec('{"objects":[{"type":"box"}]}') });
    const s = surfaces[0]!;
    const { ctx } = fakeCtx();
    const session = await s.opts.onAcquire(ctx);
    session.render(SIZE);
    const stage = host.querySelector<HTMLElement>('[data-pkc-3d-stage]')!;
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, buttons: 1, bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 30, clientY: 0, buttons: 1, bubbles: true }));
    stage.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    host.querySelector<HTMLButtonElement>('[data-pkc-3d-op="wireframe"]')!.click();
    s.opts.onFallback2d(s.opts.host, '理由');
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    await flush();
    expect(raf).not.toHaveBeenCalled();
  });
});

describe('GLB の検め(着地前レビュー W3)', () => {
  function glbWithJson(json: string): Blob {
    let body = new TextEncoder().encode(json);
    const pad = (4 - (body.length % 4)) % 4;
    if (pad) body = new Uint8Array([...body, ...new Array<number>(pad).fill(0x20)]);
    const out = new Uint8Array(20 + body.length);
    const v = new DataView(out.buffer);
    out.set(new TextEncoder().encode('glTF'), 0);
    v.setUint32(4, 2, true);
    v.setUint32(8, out.length, true);
    v.setUint32(12, body.length, true);
    v.setUint32(16, 0x4e4f534a, true);
    out.set(body, 20);
    return new Blob([out]);
  }
  it('🔴 JSON 塊が 4MB を超える(data: を埋め込んだ)GLB も、壊れていると言わずに通す', async () => {
    const big = 'A'.repeat(5 * 1024 * 1024);
    const blob = glbWithJson(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: `data:application/octet-stream;base64,${big}` }] }));
    expect(blob.size).toBeGreaterThan(5 * 1024 * 1024);
    expect(await precheckModel({ blob, format: 'glb' })).toBeNull();
  });
  it('外部を指す GLB・短すぎる GLB は断る', async () => {
    expect(await precheckModel({ blob: glbWithJson('{"buffers":[{"uri":"x.bin"}]}'), format: 'glb' })).toContain('外部');
    expect(await precheckModel({ blob: new Blob(['glTF']), format: 'glb' })).toContain('正しくない');
  });
});
