/**
 * 🔴 **3D ビューア**(v4.0 Phase 3 / PR-12、ビジョン 1-B)── 添付の 3D モデル(GLB / glTF / STL / OBJ)と
 * ` ```3d ` の囲み(JSON のシーン記述)の**両方**をこの 1 本で描く(CLAUDE.md §7)。
 *
 * ## 守ること(定常コスト 0・ローカル完結)
 *
 * 1. **描くのは `gpu-lease.ts` の `createGpuSurface` だけ**。renderer を自分で作らない・rAF を自分で回さない。
 *    描き直しは「読み込み完了・操作・大きさの変化・切替・テーマの変化」のときだけ `invalidate()` を 1 回頼む
 *    (静止時の rAF = 0)。操作中は `setPinned(true)`(LRU で畳まれない)。
 * 2. **3D を含まないノートでは 0 バイト**: この module は Three.js もローダーも静的に読まない。
 *    `hydrate3d` は器(`[data-pkc-3d-src]`)が 1 つも無ければ何もしない。
 * 3. **ローダーは使う形式のときだけ**動的 `import()`。各 `import()` の直前に `__PKC_PORTABLE__` の条件を
 *    **その場で直接**書く(1 枚にまとめた版からローダーを枝ごと落とす ── `gpu-lease.ts` と同じ作法)。
 * 4. **外へ取りに行かない**: `.gltf` / `.glb` の JSON を読む前に `validateLocalGltfJson` で検め、
 *    読み込み中の URL は `LoadingManager.setURLModifier` で 1 件ずつ `isAllowedLocal3dUrl` に通す
 *    (外部 URL・相対パス・未許可の `blob:` は例外で止める)。
 * 5. **畳んでも空白にしない**: `capturePoster()` で 1 コマ描いて PNG に焼く(ObjectURL の revoke は gpu-lease)。
 *    ポスターの上で触れば `invalidate()` で静かに GPU へ戻る。
 * 6. **GPU が無い・1 枚にまとめた版**: Canvas 2D の線画(` ```3d `)か、形式と大きさの案内(添付)に退避し、
 *    理由を 1 行出す。クラッシュ・空の枠にしない。
 * 7. **後始末**: `session.dispose()` で geometry / material / texture を全部返し、
 *    `viewer.dispose()` で listener・`ResizeObserver`・`MutationObserver`・描画面を全部外す。
 * 8. **動きを減らす設定**: 慣性・自動回転・遷移の動きを持たない(操作 1 回 → 1 コマ)ので、
 *    `prefers-reduced-motion` のときに止める物が初めから無い。
 */
declare const __PKC_PORTABLE__: boolean | undefined;

import type * as ThreeModule from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import {
  GPU_PORTABLE_UNAVAILABLE,
  createGpuSurface,
  type GpuContext,
  type GpuFrameSize,
  type GpuSession,
  type GpuSurface,
  type GpuSurfaceOptions,
} from '@adapter/platform/render/gpu-lease';
import { cssColorToHex } from './css-color';
import { retryableImport } from '@adapter/platform/render/retryable-import';
import { humanBytes } from '@features/human-bytes';
import {
  MODEL3D_FORMAT_LABEL,
  detect3dModelFormat,
  extractGlbJson,
  isAllowedLocal3dUrl,
  sniff3dModelFormat,
  validateLocalGltfJson,
  type Model3dFormat,
} from '@features/viewer3d/model-format';
import {
  SCENE_DEFAULT_COLOR,
  SCENE_DEFAULT_FOV,
  SCENE_DEFAULT_HEIGHT,
  gridWorldSegments,
  objectExtent,
  parse3dSceneSpec,
  projectScene2d,
  sceneBounds,
  type SceneObjectSpec,
  type SceneSpec,
} from '@features/viewer3d/scene-spec';
import {
  fitBoundsToOrbit,
  orbitCameraPosition,
  orbitFromPosition,
  orbitPan,
  orbitPreset,
  orbitRotate,
  orbitZoom,
  orbitZoomStep,
  wheelDeltaPx,
  wheelZoomsStage,
  type OrbitPreset,
  type OrbitState,
  type Vec3,
} from '@features/viewer3d/orbit-math';
import type { MermaidScope } from './mermaid-hydrate';

type Three = typeof ThreeModule;

// ───────────────────────────── ローダーの遅延読み込み(使う形式のときだけ)

interface LoaderModules {
  gltf: () => Promise<{ GLTFLoader: typeof GLTFLoader }>;
  stl: () => Promise<{ STLLoader: typeof STLLoader }>;
  obj: () => Promise<{ OBJLoader: typeof OBJLoader }>;
}

/** ⚠ 埋めるのは固定の機能名(ファイル名・題名ではない)。 */
const loadError = (feature: string) => (cause: unknown) =>
  new Error(`${feature} を読み込めませんでした: ${cause instanceof Error ? cause.message : String(cause)}`);

const REAL_LOADERS: LoaderModules = {
  gltf: retryableImport(async () => {
    // 🔴 1 枚にまとめた版では枝ごと落とす(条件はこの場で直接書く ── 別 module の定数だと除去が効かない)
    if (typeof __PKC_PORTABLE__ !== 'undefined' && __PKC_PORTABLE__) throw new Error(GPU_PORTABLE_UNAVAILABLE);
    return import('three/examples/jsm/loaders/GLTFLoader.js');
  }, loadError('glTF の読み込み機能')),
  stl: retryableImport(async () => {
    // 🔴 上と同じ ── 1 枚にまとめた版では枝ごと落とす
    if (typeof __PKC_PORTABLE__ !== 'undefined' && __PKC_PORTABLE__) throw new Error(GPU_PORTABLE_UNAVAILABLE);
    return import('three/examples/jsm/loaders/STLLoader.js');
  }, loadError('STL の読み込み機能')),
  obj: retryableImport(async () => {
    // 🔴 上と同じ ── 1 枚にまとめた版では枝ごと落とす
    if (typeof __PKC_PORTABLE__ !== 'undefined' && __PKC_PORTABLE__) throw new Error(GPU_PORTABLE_UNAVAILABLE);
    return import('three/examples/jsm/loaders/OBJLoader.js');
  }, loadError('OBJ の読み込み機能')),
};

let loaders: LoaderModules = REAL_LOADERS;
let surfaceFactory: (opts: GpuSurfaceOptions) => GpuSurface = createGpuSurface;

/** test 用: 描画面の作り方・ローダーを差し替える(`null` で実物へ戻す)。 */
export function setViewer3dTestHooks(
  hooks: { createSurface?: (opts: GpuSurfaceOptions) => GpuSurface; loaders?: Partial<LoaderModules> } | null,
): void {
  surfaceFactory = hooks?.createSurface ?? createGpuSurface;
  loaders = { ...REAL_LOADERS, ...(hooks?.loaders ?? {}) };
}

// ───────────────────────────── 外へ取りに行かない(読み込み中の URL を 1 件ずつ検める)

/**
 * 🔴 **glTF が自分で作る `blob:` だけを許す**。GLB に埋め込まれた画像は、GLTFLoader がその場で
 * `URL.createObjectURL` してから読み込む ── それは外部ではないので、読んでいる間に作られた URL だけを許可の
 * 集合へ足す。⚠ 複数の読み込みが重なっても、包むのは 1 回・外すのは最後の 1 つが終わったとき。
 */
const urlTrackers = new Set<Set<string>>();
/** 包む前の本物(⚠ bind した写しではなく、元の関数そのもの ── 外すときに同じ物へ戻す)。 */
let originalCreateObjectURL: typeof URL.createObjectURL | null = null;
let trackingWrapper: typeof URL.createObjectURL | null = null;

/**
 * @param allowed 読んでいる間に作られた `blob:` を入れる集合(`localManager` の許可)。
 * 🔴 **失敗したら、その間に作られた URL を返す**(着地前レビュー R1)── GLTFLoader が自分で revoke するのは
 *   成功した経路だけなので、途中で断った・壊れていた回の埋め込み画像の URL が残る。成功した回の二重の revoke は害が無い。
 */
export async function withTrackedObjectUrls<T>(allowed: Set<string>, fn: () => Promise<T>): Promise<T> {
  if (urlTrackers.size === 0 && typeof URL.createObjectURL === 'function') {
    const original = URL.createObjectURL;
    originalCreateObjectURL = original;
    trackingWrapper = (obj: Blob | MediaSource): string => {
      const u = original.call(URL, obj);
      for (const t of urlTrackers) t.add(u);
      return u;
    };
    URL.createObjectURL = trackingWrapper;
  }
  urlTrackers.add(allowed);
  try {
    return await fn();
  } catch (e) {
    for (const u of allowed) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* 続けて返す */
      }
    }
    throw e;
  } finally {
    urlTrackers.delete(allowed);
    if (urlTrackers.size === 0 && originalCreateObjectURL !== null) {
      // ⚠ 包んでいる間に他が差し替えていたら、そちらを壊さない(戻すのは自分の包みのままのときだけ)
      if (URL.createObjectURL === trackingWrapper) URL.createObjectURL = originalCreateObjectURL;
      originalCreateObjectURL = null;
      trackingWrapper = null;
    }
  }
}

/** 断った参照の理由文。 */
export const VIEWER3D_BLOCKED_PREFIX = '外部の参照は読み込みません';

export function localManager(T: Three, allowed: Set<string>): ThreeModule.LoadingManager {
  const manager = new T.LoadingManager();
  manager.setURLModifier((url: string) => {
    if (isAllowedLocal3dUrl(url, allowed)) return url;
    // ⚠ 例外で止める(差し替えの URL を返すと、その URL を読みに行ってしまう)
    throw new Error(`${VIEWER3D_BLOCKED_PREFIX}(${url.length > 60 ? `${url.slice(0, 57)}…` : url})`);
  });
  return manager;
}

/** 読み込んだモデル(three の物)。 */
export interface Model3dInput {
  readonly blob: Blob;
  readonly format: Model3dFormat;
  readonly name?: string;
}

/**
 * 🔴 **読む前の検め**(pure の検査を通す)。GLB / glTF の外部参照はここで断る ── Three.js を読み込む前。
 * @returns 断る理由。問題なければ `null`。
 */
export async function precheckModel(model: Model3dInput): Promise<string | null> {
  if (model.format === 'glb') {
    // 🔑 JSON 塊の長さを先に読み、その分だけ読む(固定の上限で切ると、data: を埋め込んだ大きな JSON を誤って断る)
    const header = new Uint8Array(await model.blob.slice(0, 20).arrayBuffer());
    if (header.length < 20) return 'GLB の形式が正しくないため読めません';
    const chunkLen = new DataView(header.buffer, header.byteOffset, 20).getUint32(12, true);
    const head = new Uint8Array(await model.blob.slice(0, Math.min(model.blob.size, 20 + chunkLen)).arrayBuffer());
    const json = extractGlbJson(head);
    if (json === null) return 'GLB の形式が正しくないため読めません';
    const v = validateLocalGltfJson(json);
    return v.ok ? null : v.reason;
  }
  if (model.format === 'gltf') {
    const v = validateLocalGltfJson(await model.blob.text());
    return v.ok ? null : v.reason;
  }
  return null;
}

/** モデルを three の物にする。⚠ 外部参照は `localManager` が止める。 */
export async function parseModel(T: Three, model: Model3dInput): Promise<ThreeModule.Object3D> {
  const allowed = new Set<string>();
  const manager = localManager(T, allowed);
  switch (model.format) {
    case 'glb':
    case 'gltf': {
      const { GLTFLoader: Ctor } = await loaders.gltf();
      const loader = new Ctor(manager);
      const data = model.format === 'glb' ? await model.blob.arrayBuffer() : await model.blob.text();
      const gltf = await withTrackedObjectUrls(allowed, () => loader.parseAsync(data, ''));
      return gltf.scene;
    }
    case 'stl': {
      const { STLLoader: Ctor } = await loaders.stl();
      const geometry = new Ctor(manager).parse(await model.blob.arrayBuffer());
      if (geometry.getAttribute('normal') === undefined) geometry.computeVertexNormals();
      const colored = (geometry as unknown as { hasColors?: boolean }).hasColors === true;
      const material = new T.MeshStandardMaterial({
        color: colored ? 0xffffff : SCENE_DEFAULT_COLOR,
        vertexColors: colored,
        roughness: 0.6,
        metalness: 0.05,
      });
      return new T.Mesh(geometry, material);
    }
    case 'obj': {
      const { OBJLoader: Ctor } = await loaders.obj();
      // ⚠ OBJLoader は `mtllib` を自分では読みに行かない(MTLLoader を入れない ── 外部の材質・画像は使わない)
      return new Ctor(manager).parse(await model.blob.text());
    }
  }
}

/** 立体を作る(` ```3d ` の objects)。 */
function buildPrimitive(T: Three, o: SceneObjectSpec, sceneWire: boolean): ThreeModule.Mesh {
  let geometry: ThreeModule.BufferGeometry;
  switch (o.type) {
    case 'box':
      geometry = new T.BoxGeometry(1, 1, 1);
      break;
    case 'sphere':
      geometry = new T.SphereGeometry(0.5, 32, 16);
      break;
    case 'cylinder':
      geometry = new T.CylinderGeometry(0.5, 0.5, 1, 32);
      break;
    case 'cone':
      geometry = new T.ConeGeometry(0.5, 1, 32);
      break;
    case 'plane':
      geometry = new T.PlaneGeometry(1, 1);
      break;
    case 'torus':
      // 寝かせる(xz 平面)── 2D の簡易表示(`primitiveEdges`)と同じ形
      geometry = new T.TorusGeometry(0.35, 0.15, 16, 48);
      geometry.rotateX(Math.PI / 2);
      break;
  }
  const material = new T.MeshStandardMaterial({
    color: o.color,
    wireframe: o.wireframe || sceneWire,
    transparent: o.opacity < 1,
    opacity: o.opacity,
    roughness: 0.55,
    metalness: 0.05,
    side: o.type === 'plane' ? T.DoubleSide : T.FrontSide,
  });
  const mesh = new T.Mesh(geometry, material);
  const [w, h, d] = objectExtent(o);
  mesh.scale.set(w || 1e-6, h || 1e-6, d || 1e-6);
  const r = o.rotation.map((deg) => (deg * Math.PI) / 180) as [number, number, number];
  mesh.rotation.set(r[0], r[1], r[2], 'XYZ');
  mesh.position.set(o.position[0], o.position[1], o.position[2]);
  mesh.userData.pkcOwnWire = o.wireframe;
  if (o.label !== undefined) mesh.name = o.label;
  return mesh;
}

/** geometry / material / texture を全部返す。 */
export function disposeObject3d(root: ThreeModule.Object3D): void {
  root.traverse((node) => {
    const mesh = node as ThreeModule.Mesh;
    mesh.geometry?.dispose?.();
    const mats = mesh.material === undefined ? [] : Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      for (const v of Object.values(m as unknown as Record<string, unknown>)) {
        if (v !== null && typeof v === 'object' && (v as { isTexture?: boolean }).isTexture === true) {
          (v as ThreeModule.Texture).dispose();
        }
      }
      m.dispose();
    }
  });
  root.clear();
}

// ───────────────────────────── テーマの色

interface ThemeColors {
  surface: string | null;
  hairline: string;
  muted: string;
}

function readTheme(el: HTMLElement): ThemeColors {
  const doc = el.ownerDocument;
  const cs = doc.defaultView?.getComputedStyle(el);
  const get = (name: string): string => cs?.getPropertyValue(name) ?? '';
  return {
    surface: cssColorToHex(doc, get('--surface')),
    hairline: cssColorToHex(doc, get('--hairline')) ?? '#c8c8c8',
    // ⚠ `--text-muted` を先に見て、無ければ `--muted`(tokens.css の名前)
    muted: cssColorToHex(doc, get('--text-muted')) ?? cssColorToHex(doc, get('--muted')) ?? '#888888',
  };
}

// ───────────────────────────── ビューア本体

export type Viewer3dSource =
  | { readonly kind: 'model'; readonly model: Model3dInput }
  | { readonly kind: 'scene'; readonly spec: SceneSpec; readonly model?: Model3dInput | null };

export interface Viewer3dOptions {
  /** 描画面の高さ(px)。既定は ` ```3d ` の `height` か 360。 */
  readonly height?: number;
}

export interface Viewer3dHandle {
  readonly element: HTMLElement;
  dispose(): void;
}

/** 状態の印(`data-pkc-3d-state`)。 */
export type Viewer3dState = 'loading' | 'ready' | 'fallback' | 'failed' | 'disposed';

const BACKEND_LABEL: Readonly<Record<string, string>> = {
  webgpu: 'WebGPU',
  webgl2: 'WebGL2',
  '2d': '2D 簡易表示',
};

/** 数を短く(有効 3 桁)。 */
function short(n: number): string {
  if (!Number.isFinite(n)) return '?';
  const a = Math.abs(n);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return n.toExponential(2);
  return String(Number(n.toPrecision(3)));
}


class Viewer {
  readonly root: HTMLElement;
  readonly stage: HTMLElement;
  readonly labelsLayer: HTMLElement;
  readonly note: HTMLElement;
  readonly info: { format: HTMLElement; size: HTMLElement; backend: HTMLElement };
  readonly buttons: {
    reset: HTMLButtonElement;
    wireframe: HTMLButtonElement;
    grid: HTMLButtonElement;
    zoomOut: HTMLButtonElement;
    zoomIn: HTMLButtonElement;
    expand: HTMLButtonElement;
    presets: Record<OrbitPreset, HTMLButtonElement>;
  };
  /** 🔴 描画面を「有効」にしたか(クリックで入り、Esc・外側のクリックで抜ける)。有効の間だけ、ただのホイールでもズームする。 */
  active = false;
  /** 「拡大」(描画面の高さを大きくする)の入り切り。 */
  expanded = false;

  surface: GpuSurface | null = null;
  state: Viewer3dState = 'loading';
  mode: 'gpu' | '2d' = 'gpu';
  orbit: OrbitState | null = null;
  home: OrbitState | null = null;
  wireframe: boolean;
  grid: boolean;
  readonly fov: number;
  /** 2D の簡易表示の canvas。 */
  canvas2d: HTMLCanvasElement | null = null;
  /** 描画中の場面(session)が持つ、切替の当て先。 */
  applyToggles: (() => void) | null = null;
  private readonly cleanups: Array<() => void> = [];
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;

  constructor(
    readonly host: HTMLElement,
    readonly source: Viewer3dSource,
    opts: Viewer3dOptions,
  ) {
    const doc = host.ownerDocument;
    const spec = source.kind === 'scene' ? source.spec : null;
    this.wireframe = spec?.wireframe ?? false;
    this.grid = spec?.grid ?? true;
    this.fov = spec?.camera.fov ?? SCENE_DEFAULT_FOV;

    this.root = doc.createElement('div');
    this.root.className = 'pkc-3d-viewer';
    this.root.setAttribute('data-pkc-3d-viewer', '');
    this.root.setAttribute('data-pkc-3d-state', 'loading');

    const bar = doc.createElement('div');
    bar.className = 'pkc-3d-toolbar';
    const mkInfo = (field: string, text: string): HTMLElement => {
      const s = doc.createElement('span');
      s.className = 'pkc-3d-info';
      s.setAttribute('data-pkc-3d-info', field);
      s.textContent = text;
      return s;
    };
    const model = source.kind === 'model' ? source.model : (source.model ?? null);
    const formatText = model !== null ? MODEL3D_FORMAT_LABEL[model.format] : '3D シーン';
    this.info = {
      format: mkInfo('format', formatText),
      size: mkInfo(
        'size',
        spec !== null && model === null ? `オブジェクト ${spec.objects.length} 個` : model !== null ? humanBytes(model.blob.size) : '',
      ),
      backend: mkInfo('backend', '準備中'),
    };
    const mkBtn = (op: string, label: string, title: string, pressed?: boolean, aria?: string): HTMLButtonElement => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'pkc-3d-btn';
      b.setAttribute('data-pkc-3d-op', op);
      b.textContent = label;
      b.title = title;
      if (aria !== undefined) b.setAttribute('aria-label', aria);
      if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
      return b;
    };
    this.buttons = {
      zoomOut: mkBtn('zoom-out', '−', 'ズームアウトします(小さく見せます。キーボードの - でも)', undefined, 'ズームアウト'),
      zoomIn: mkBtn('zoom-in', '+', 'ズームインします(大きく見せます。キーボードの + でも)', undefined, 'ズームイン'),
      presets: {
        oblique: mkBtn('preset-oblique', '斜め', '斜め上から見る視点にします'),
        front: mkBtn('preset-front', '正面', '正面(水平)から見る視点にします'),
        top: mkBtn('preset-top', '上面', '真上から見下ろす視点にします'),
      },
      expand: mkBtn('expand', '拡大', '描画領域を大きくします(もう一度押すと元の大きさに戻ります)', false),
      reset: mkBtn('reset', '視点をリセット', '最初の視点に戻します(キーボードの 0 でも戻せます)'),
      wireframe: mkBtn('wireframe', 'ワイヤーフレーム', '塗りつぶさずに線だけで表示します', this.wireframe),
      grid: mkBtn('grid', 'グリッド', '床のグリッドを表示します', this.grid),
    };
    const spacer = doc.createElement('span');
    spacer.className = 'pkc-3d-spacer';
    bar.append(
      this.info.format,
      this.info.size,
      this.info.backend,
      spacer,
      this.buttons.zoomOut,
      this.buttons.zoomIn,
      this.buttons.presets.oblique,
      this.buttons.presets.front,
      this.buttons.presets.top,
      this.buttons.reset,
      this.buttons.wireframe,
      this.buttons.grid,
      this.buttons.expand,
    );

    this.stage = doc.createElement('div');
    this.stage.className = 'pkc-3d-stage';
    this.stage.setAttribute('data-pkc-3d-stage', '');
    this.stage.tabIndex = 0;
    this.stage.setAttribute('role', 'img');
    this.stage.setAttribute(
      'aria-label',
      `${formatText}。ドラッグで回転、Shift + ドラッグか右ドラッグで移動、Ctrl + ホイールで拡大・縮小(クリックして有効にするとホイールだけでも)、矢印キーでも回せます`,
    );
    const height = Math.round(opts.height ?? spec?.height ?? SCENE_DEFAULT_HEIGHT);
    this.stage.style.height = `${height}px`;
    this.labelsLayer = doc.createElement('div');
    this.labelsLayer.className = 'pkc-3d-labels';
    this.labelsLayer.setAttribute('aria-hidden', 'true');
    this.stage.append(this.labelsLayer);

    this.note = doc.createElement('p');
    this.note.className = 'pkc-3d-note';
    this.note.setAttribute('data-pkc-3d-note', '');
    this.note.hidden = true;

    this.root.append(bar, this.stage, this.note);
    host.append(this.root);
    this.bindEvents();
  }

  setState(state: Viewer3dState): void {
    this.state = state;
    this.root.setAttribute('data-pkc-3d-state', state);
  }

  showNote(text: string): void {
    this.note.textContent = text;
    this.note.hidden = text === '';
  }

  /** 描き直しを頼む(GPU なら `invalidate()`、2D ならその場で描く)。 */
  requestDraw(): void {
    if (this.state === 'disposed' || this.state === 'failed') return;
    if (this.mode === '2d') {
      this.draw2d();
      return;
    }
    this.surface?.invalidate();
  }

  // ── 操作

  private on<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    el.addEventListener(type, fn as EventListener, opts);
    this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, opts));
  }

  private bindEvents(): void {
    const stage = this.stage;
    this.on(this.buttons.reset, 'click', () => this.resetView());
    this.on(this.buttons.wireframe, 'click', () => this.toggle('wireframe'));
    this.on(this.buttons.grid, 'click', () => this.toggle('grid'));
    this.on(this.buttons.zoomOut, 'click', () => this.zoomStep(-1));
    this.on(this.buttons.zoomIn, 'click', () => this.zoomStep(1));
    this.on(this.buttons.expand, 'click', () => this.setExpanded(!this.expanded));
    for (const key of Object.keys(this.buttons.presets) as OrbitPreset[]) {
      this.on(this.buttons.presets[key], 'click', () => this.applyPreset(key));
    }
    this.on(stage, 'contextmenu', (e) => e.preventDefault());
    // ⚠ 描画面の上の 2 回押しで、本文の側(編集を開くなど)を動かさない
    this.on(stage, 'dblclick', (e) => e.stopPropagation());
    // 🔴 描画面を「有効」にする(クリックで入る)。外側のクリック・Esc で抜ける ── 抜けている間のホイールは親のスクロールへ流す
    const doc = stage.ownerDocument;
    const onOutside = (e: Event): void => {
      if (e.target instanceof Node && stage.contains(e.target)) return;
      this.setActive(false);
    };
    doc.addEventListener('pointerdown', onOutside, true);
    this.cleanups.push(() => doc.removeEventListener('pointerdown', onOutside, true));
    this.on(stage, 'pointerdown', (e) => {
      this.setActive(true);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        stage.setPointerCapture?.(e.pointerId);
      } catch {
        /* 捕まえられなくても続ける */
      }
      if (this.pointers.size === 2) this.pinchDist = this.pinchDistance();
      this.surface?.setPinned(true);
      // 🔑 ポスターの上で触ったら、静かに GPU へ戻す
      this.requestDraw();
    });
    this.on(stage, 'pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (prev === undefined) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.orbit === null || (dx === 0 && dy === 0)) return;
      if (this.pointers.size >= 2) {
        const d = this.pinchDistance();
        if (this.pinchDist > 0 && d > 0) this.orbit = orbitZoom(this.orbit, (this.pinchDist - d) * 4);
        this.pinchDist = d;
      } else if (e.shiftKey || (e.buttons & 2) !== 0 || (e.buttons & 4) !== 0) {
        this.orbit = orbitPan(this.orbit, dx, dy, stage.clientHeight || 1, this.fov);
      } else {
        this.orbit = orbitRotate(this.orbit, dx, dy);
      }
      this.requestDraw();
    });
    const end = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
      if (this.pointers.size === 0) this.surface?.setPinned(false);
    };
    this.on(stage, 'pointerup', end);
    this.on(stage, 'pointercancel', end);
    this.on(
      stage,
      'wheel',
      (e) => {
        // 🔴 スクロールの取り合いを 0 にする: Ctrl/⌘ + ホイール(ピンチ含む)か有効なときだけ奪う。
        //   ただのホイールは preventDefault せず、親(ノート)のスクロールへ流す。
        //   ⚠ `preventDefault` を呼ぶ経路があるので非 passive で登録する(Ctrl + ホイールのページ拡大も止める)
        if (!wheelZoomsStage(e.ctrlKey || e.metaKey, this.active)) return;
        e.preventDefault();
        if (this.orbit !== null) this.orbit = orbitZoom(this.orbit, wheelDeltaPx(e.deltaY, e.deltaMode));
        this.requestDraw();
      },
      { passive: false },
    );
    this.on(stage, 'keydown', (e) => {
      if (e.key === 'Escape' && this.active) {
        // 有効を抜ける(⚠ 背後のノート選択解除などへ Esc を流さない)
        this.setActive(false);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      let handled = true;
      const o = this.orbit;
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          if (o === null) break;
          const step = 20;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          this.orbit = e.shiftKey ? orbitPan(o, dx, dy, this.stage.clientHeight || 1, this.fov) : orbitRotate(o, dx, dy);
          break;
        }
        case '+':
        case '=':
          if (o !== null) this.orbit = orbitZoomStep(o, 1);
          break;
        case '-':
        case '_':
          if (o !== null) this.orbit = orbitZoomStep(o, -1);
          break;
        case '0':
          this.resetView();
          return void e.preventDefault();
        default:
          handled = false;
      }
      if (!handled) return;
      e.preventDefault();
      this.requestDraw();
    });

    // 大きさが変わったら描き直す(最初の報告で最初の 1 コマも頼む)
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (RO !== undefined) {
      // ⚠ 大きさが本当に変わったときだけ(観測を始めた直後の報告や、同じ大きさの報告で畳んだ GPU を借り直さない)
      let lastW = -1;
      let lastH = -1;
      const ro = new RO((entries) => {
        const r = entries[entries.length - 1]?.contentRect;
        const w = Math.round(r?.width ?? stage.clientWidth);
        const h = Math.round(r?.height ?? stage.clientHeight);
        if (w === lastW && h === lastH) return;
        const first = lastW < 0;
        lastW = w;
        lastH = h;
        // 最初の報告は `start()` の 1 コマで足りる(2D の簡易表示は大きさが分かってから描き直す)
        if (!first || this.mode === '2d') this.requestDraw();
      });
      ro.observe(stage);
      this.cleanups.push(() => ro.disconnect());
    }
    // テーマが変わったら描き直す(背景・グリッドの色を追う)
    const html = this.host.ownerDocument.documentElement;
    const MO = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    if (MO !== undefined && html !== null) {
      const mo = new MO(() => this.requestDraw());
      // ⚠ 配色の属性だけを見る(ほかの属性の変化で畳んだ GPU を借り直さない ── `widget-bridge.ts` と同じ 3 つ)
      mo.observe(html, { attributes: true, attributeFilter: ['data-pkc-theme', 'data-pkc-tone', 'data-pkc-accent'] });
      this.cleanups.push(() => mo.disconnect());
    }
  }

  private pinchDistance(): number {
    const ps = [...this.pointers.values()];
    if (ps.length < 2) return 0;
    return Math.hypot(ps[0]!.x - ps[1]!.x, ps[0]!.y - ps[1]!.y);
  }

  resetView(): void {
    if (this.home !== null) this.orbit = this.home;
    this.requestDraw();
  }

  /** 描画面の有効 / 無効(ホイールでのズームの許可)。 */
  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    if (on) this.stage.setAttribute('data-pkc-3d-active', '');
    else this.stage.removeAttribute('data-pkc-3d-active');
  }

  /** ボタンの 1 段ズーム(+1 = 寄る、-1 = 引く)。 */
  zoomStep(dir: 1 | -1): void {
    if (this.orbit !== null) this.orbit = orbitZoomStep(this.orbit, dir);
    this.requestDraw();
  }

  /** 視点のプリセット(注視点と距離は保つ)。 */
  applyPreset(preset: OrbitPreset): void {
    if (this.orbit !== null) this.orbit = orbitPreset(this.orbit, preset);
    this.requestDraw();
  }

  /** 「拡大」── 描画面の高さを大きくする(大きさの変化は `ResizeObserver` が描き直しに繋ぐ)。 */
  setExpanded(on: boolean): void {
    this.expanded = on;
    this.buttons.expand.setAttribute('aria-pressed', String(on));
    this.root.toggleAttribute('data-pkc-3d-expanded', on);
    // ⚠ 高さは CSS(`[data-pkc-3d-expanded]` の規則)が決める ── 元の高さは inline のまま残し、戻すときは属性を外すだけ
  }

  toggle(which: 'wireframe' | 'grid'): void {
    if (which === 'wireframe') {
      this.wireframe = !this.wireframe;
      this.buttons.wireframe.setAttribute('aria-pressed', String(this.wireframe));
    } else {
      this.grid = !this.grid;
      this.buttons.grid.setAttribute('aria-pressed', String(this.grid));
    }
    this.applyToggles?.();
    this.requestDraw();
  }

  // ── GPU

  start(): void {
    this.surface = surfaceFactory({
      host: this.stage,
      onAcquire: (ctx) => this.acquire(ctx),
      onFallback2d: (_host, reason) => this.enterFallback2d(reason),
    });
    // 最初の 1 コマ(見えるまでは gpu-lease が待つ)
    this.surface.invalidate();
  }

  private modelOf(): Model3dInput | null {
    return this.source.kind === 'model' ? this.source.model : (this.source.model ?? null);
  }

  private async acquire(ctx: GpuContext): Promise<GpuSession> {
    const T = ctx.three as Three;
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(this.fov, 1, 0.01, 1000);
    scene.add(new T.HemisphereLight(0xffffff, 0x8a8a8a, 1.6));
    const sun = new T.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 5, 4);
    scene.add(sun);
    const content = new T.Group();
    scene.add(content);
    const spec = this.source.kind === 'scene' ? this.source.spec : null;
    const model = this.modelOf();
    const empty: GpuSession = { render: () => undefined, dispose: () => disposeObject3d(scene) };
    if (model !== null) {
      try {
        content.add(await parseModel(T, model));
      } catch (e) {
        this.fail(`3D モデルを読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
        return empty;
      }
    }
    if (this.state === 'disposed') return empty;
    if (spec !== null) for (const o of spec.objects) content.add(buildPrimitive(T, o, false));

    // 外接箱 → 最初の視点
    const box = new T.Box3().setFromObject(content);
    const hasBox = !box.isEmpty();
    const min: Vec3 = hasBox ? [box.min.x, box.min.y, box.min.z] : [-0.5, -0.5, -0.5];
    const max: Vec3 = hasBox ? [box.max.x, box.max.y, box.max.z] : [0.5, 0.5, 0.5];
    if (this.home === null) {
      const aspect = (this.stage.clientWidth || 1) / (this.stage.clientHeight || 1);
      const cam = spec?.camera;
      const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      this.home =
        cam?.position !== undefined
          ? orbitFromPosition(cam.position, cam.target ?? center)
          : fitBoundsToOrbit(min, max, this.fov, aspect);
      if (cam?.position === undefined && cam?.target !== undefined) this.home = { ...this.home, target: cam.target };
      this.orbit = this.home;
    }
    if (model !== null) {
      this.info.size.textContent = `寸法 ${short(max[0] - min[0])} × ${short(max[1] - min[1])} × ${short(max[2] - min[2])}`;
    }
    this.info.backend.textContent = BACKEND_LABEL[ctx.backend] ?? ctx.backend;
    this.info.backend.setAttribute('data-pkc-3d-backend', ctx.backend);

    // グリッド(外接箱に合わせた広さ・床の高さ)と軸
    const span = Math.max(max[0] - min[0], max[2] - min[2], 1e-3);
    const gridSize = niceGridSize(span * 2);
    let gridHelper: ThreeModule.GridHelper | null = null;
    let gridColors = '';
    const floorY = spec !== null && model === null ? Math.min(0, min[1]) : min[1];
    const axes = spec?.axes === true ? new T.AxesHelper(gridSize / 2) : null;
    if (axes !== null) scene.add(axes);

    const ensureGrid = (theme: ThemeColors): void => {
      const key = `${theme.muted}|${theme.hairline}`;
      if (gridHelper !== null && gridColors === key) return;
      if (gridHelper !== null) {
        scene.remove(gridHelper);
        disposeObject3d(gridHelper);
      }
      gridHelper = new T.GridHelper(gridSize, 10, theme.muted, theme.hairline);
      gridHelper.position.y = floorY;
      gridColors = key;
      scene.add(gridHelper);
    };

    const applyToggles = (): void => {
      content.traverse((node) => {
        const mesh = node as ThreeModule.Mesh;
        if (mesh.isMesh !== true) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const own = mesh.userData.pkcOwnWire === true;
        for (const m of mats) {
          if ('wireframe' in m) (m as ThreeModule.MeshStandardMaterial).wireframe = this.wireframe || own;
        }
      });
      if (gridHelper !== null) gridHelper.visible = this.grid;
    };
    this.applyToggles = applyToggles;

    const labelTargets: Array<{ name: string; pos: ThreeModule.Vector3 }> = [];
    content.traverse((node) => {
      if (node !== content && node.name !== '' && spec !== null) labelTargets.push({ name: node.name, pos: node.position.clone() });
    });

    let lastSize: GpuFrameSize = { width: 1, height: 1, pixelRatio: 1 };
    const render = (size: GpuFrameSize): void => {
      lastSize = size;
      const theme = readTheme(this.stage);
      const bg = spec !== null && spec.background !== 'theme' ? spec.background : theme.surface;
      scene.background = bg === null ? null : new T.Color(bg);
      ensureGrid(theme);
      applyToggles();
      const o = this.orbit ?? this.home!;
      const p = orbitCameraPosition(o);
      camera.aspect = size.width / Math.max(1, size.height);
      camera.near = Math.max(1e-4, o.radius / 1000);
      camera.far = Math.max(10, o.radius * 100 + gridSize * 4);
      camera.position.set(p[0], p[1], p[2]);
      camera.lookAt(o.target[0], o.target[1], o.target[2]);
      camera.updateProjectionMatrix();
      sun.position.set(p[0] + o.radius, p[1] + o.radius * 1.5, p[2] + o.radius);
      (ctx.renderer as unknown as { render(s: ThreeModule.Scene, c: ThreeModule.Camera): void }).render(scene, camera);
      this.placeLabels(labelTargets, camera, size.width, size.height);
    };
    if (this.state === 'loading') this.setState('ready');
    return {
      render,
      capturePoster: () => {
        // ⚠ WebGL は描画バッファを残さない ── 1 コマ描いてから同じ処理の中で焼く
        render(lastSize);
        return new Promise<Blob | null>((resolve) => {
          try {
            ctx.canvas.toBlob((b) => resolve(b), 'image/png');
          } catch {
            resolve(null);
          }
        });
      },
      dispose: () => {
        if (this.applyToggles === applyToggles) this.applyToggles = null;
        disposeObject3d(scene);
      },
    };
  }

  private placeLabels(
    targets: ReadonlyArray<{ name: string; pos: ThreeModule.Vector3 }>,
    camera: ThreeModule.PerspectiveCamera,
    w: number,
    h: number,
  ): void {
    const layer = this.labelsLayer;
    if (targets.length === 0) {
      if (layer.childElementCount > 0) layer.replaceChildren();
      return;
    }
    const doc = layer.ownerDocument;
    while (layer.childElementCount < targets.length) {
      const s = doc.createElement('span');
      s.className = 'pkc-3d-label';
      layer.append(s);
    }
    targets.forEach((t, i) => {
      const el = layer.children[i] as HTMLElement;
      const v = t.pos.clone().project(camera);
      const inFront = v.z > -1 && v.z < 1;
      el.textContent = t.name;
      el.hidden = !inFront;
      el.style.left = `${((v.x + 1) / 2) * w}px`;
      el.style.top = `${((1 - v.y) / 2) * h}px`;
    });
  }

  fail(message: string): void {
    this.setState('failed');
    this.showNote(message);
    // ⚠ 借りた GPU はその場で返す(読めない物のために枠を握らない)
    const s = this.surface;
    this.surface = null;
    queueMicrotask(() => s?.dispose());
  }

  // ── 2D の簡易表示

  enterFallback2d(reason: string): void {
    if (this.state === 'disposed') return;
    this.mode = '2d';
    this.setState('fallback');
    this.info.backend.textContent = BACKEND_LABEL['2d']!;
    this.info.backend.setAttribute('data-pkc-3d-backend', '2d');
    this.buttons.wireframe.disabled = true;
    this.buttons.wireframe.title = '2D 簡易表示では常にワイヤーフレームで表示します';
    this.showNote(reason);
    const spec = this.source.kind === 'scene' ? this.source.spec : null;
    const doc = this.stage.ownerDocument;
    if (spec !== null && spec.objects.length > 0) {
      const b = sceneBounds(spec);
      const aspect = (this.stage.clientWidth || 1) / (this.stage.clientHeight || 1);
      if (this.home === null) {
        const min: Vec3 = b?.min ?? [-0.5, -0.5, -0.5];
        const max: Vec3 = b?.max ?? [0.5, 0.5, 0.5];
        const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        this.home =
          spec.camera.position !== undefined
            ? orbitFromPosition(spec.camera.position, spec.camera.target ?? center)
            : fitBoundsToOrbit(min, max, this.fov, aspect);
        this.orbit = this.home;
      }
      const canvas = doc.createElement('canvas');
      canvas.className = 'pkc-3d-canvas2d';
      canvas.setAttribute('data-pkc-3d-canvas2d', '');
      this.stage.append(canvas);
      this.canvas2d = canvas;
      this.draw2d();
      return;
    }
    // 添付のモデル(または model だけのシーン)── 形式と大きさの案内
    const model = this.modelOf();
    this.buttons.reset.disabled = true;
    this.buttons.grid.disabled = true;
    const card = doc.createElement('div');
    card.className = 'pkc-3d-card';
    card.setAttribute('data-pkc-3d-card', '');
    const title = doc.createElement('strong');
    title.textContent = model !== null ? `${MODEL3D_FORMAT_LABEL[model.format]} の 3D モデル` : '3D モデル';
    const meta = doc.createElement('span');
    meta.textContent = model !== null ? `${model.name ? `「${model.name}」 ` : ''}${humanBytes(model.blob.size)}` : '';
    const hint = doc.createElement('span');
    hint.textContent = '「添付をダウンロード」で保存すると、3D に対応したアプリで開けます';
    card.append(title, meta, hint);
    this.stage.append(card);
  }

  draw2d(): void {
    const canvas = this.canvas2d;
    const spec = this.source.kind === 'scene' ? this.source.spec : null;
    if (canvas === null || spec === null || this.orbit === null) return;
    const w = Math.max(1, this.stage.clientWidth || 1);
    const h = Math.max(1, this.stage.clientHeight || 1);
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    let ctx: CanvasRenderingContext2D | null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (ctx === null) return;
    const theme = readTheme(this.stage);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bg = spec.background !== 'theme' ? spec.background : theme.surface;
    if (bg !== null) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    }
    const b = sceneBounds(spec);
    const span = b === null ? 1 : Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2], 1e-3);
    const extra = this.grid ? gridWorldSegments(niceGridSize(span * 2)) : [];
    const segs = projectScene2d(spec, w, h, this.orbit, { fovDeg: this.fov, extra, gridColor: theme.hairline });
    ctx.lineWidth = 1;
    for (const s of segs) {
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.setState('disposed');
    for (const c of this.cleanups.splice(0)) c();
    this.pointers.clear();
    const s = this.surface;
    this.surface = null;
    s?.dispose();
    this.applyToggles = null;
    this.canvas2d = null;
    this.root.remove();
  }
}

/** グリッドの広さを 1・2・5 × 10^n に丸める。 */
function niceGridSize(v: number): number {
  const x = Math.max(v, 1e-3);
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

/**
 * 🔴 **共通の 3D ビューアを置く**(添付も ` ```3d ` もこの 1 本)。
 * ⚠ ここでは Three.js を読み込まない ── 描画面が見えて最初の 1 コマを描くときに gpu-lease が読む。
 */
export function mount3dViewer(host: HTMLElement, source: Viewer3dSource, opts: Viewer3dOptions = {}): Viewer3dHandle {
  const viewer = new Viewer(host, source, opts);
  const model = source.kind === 'model' ? source.model : (source.model ?? null);
  if (model === null) {
    viewer.start();
  } else {
    // 🔴 外部参照は Three.js を読む前に断る
    void precheckModel(model)
      .catch((e: unknown) => `3D モデルを読めませんでした: ${e instanceof Error ? e.message : String(e)}`)
      .then((reason) => {
        if (viewer.state === 'disposed') return;
        if (reason !== null) viewer.fail(reason);
        else viewer.start();
      });
  }
  return {
    element: viewer.root,
    dispose: () => viewer.dispose(),
  };
}

// ───────────────────────────── ` ```3d ` の器を埋める(`hydrateFigures` の 1 員)

/** 添付の中身を引く口(` ```3d ` の `model: "asset:鍵"`)。 */
export type GetAssetBlob = (key: string) => Promise<{ blob: Blob; name?: string; mime?: string } | null>;

export interface Hydrate3dOptions {
  readonly getAssetBlob?: GetAssetBlob;
}

const SRC_ATTR = 'data-pkc-3d-src';
const STATE_ATTR = 'data-pkc-3d-state';
const ERROR_ATTR = 'data-pkc-3d-error';

/** 添付から 3D モデルを引いて、形式を決める。読めなければ理由の文。 */
export async function resolveSceneModel(
  key: string,
  getAssetBlob: GetAssetBlob | undefined,
): Promise<Model3dInput | string> {
  if (getAssetBlob === undefined) return 'この画面では添付の 3D モデルを読み込めません';
  const got = await getAssetBlob(key).catch(() => null);
  if (got === null) return `添付(${key})が見つかりません`;
  let format = detect3dModelFormat(got.mime ?? got.blob.type, got.name);
  if (format === null) {
    const head = new Uint8Array(await got.blob.slice(0, 4096).arrayBuffer());
    format = sniff3dModelFormat(head, got.blob.size);
  }
  if (format === null) return `添付(${key})は 3D モデル(GLB / glTF / STL / OBJ)ではありません`;
  return { blob: got.blob, format, ...(got.name ? { name: got.name } : {}) };
}

/**
 * 🔴 **` ```3d ` の器を埋める**。器が無ければ何もしない(Three.js も読まない)。
 * 返す口は図の塊と同じ形(`MermaidScope`)── `prune()` は DOM から外れた器のビューアを畳む。
 */
export function hydrate3d(root: ParentNode | readonly ParentNode[], opts: Hydrate3dOptions = {}): MermaidScope {
  const roots: readonly ParentNode[] = Array.isArray(root) ? (root as readonly ParentNode[]) : [root as ParentNode];
  const hosts: HTMLElement[] = [];
  for (const r of roots) {
    if (r instanceof Element && r.matches(`[${SRC_ATTR}]`)) hosts.push(r as HTMLElement);
    hosts.push(...r.querySelectorAll<HTMLElement>(`[${SRC_ATTR}]`));
  }
  if (hosts.length === 0) return { dispose: () => undefined, prune: () => 0, flush: () => Promise.resolve() };

  const viewers = new Map<HTMLElement, Viewer3dHandle>();
  let disposed = false;
  const failHost = (host: HTMLElement, error: string): void => {
    host.setAttribute(STATE_ATTR, 'failed');
    host.setAttribute(ERROR_ATTR, error);
  };
  for (const host of hosts) {
    // ⚠ 同じ器に 2 枚目を置かない(差分反映で同じ器が 2 度渡ってきても)
    if (host.hasAttribute(STATE_ATTR)) continue;
    const parsed = parse3dSceneSpec(host.getAttribute(SRC_ATTR) ?? '');
    if (!parsed.ok) {
      failHost(host, parsed.error);
      continue;
    }
    const spec = parsed.spec;
    host.setAttribute(STATE_ATTR, 'loading');
    if (spec.modelKey === undefined) {
      viewers.set(host, mount3dViewer(host, { kind: 'scene', spec }));
      host.setAttribute(STATE_ATTR, 'ready');
      continue;
    }
    void resolveSceneModel(spec.modelKey, opts.getAssetBlob).then((model) => {
      if (disposed || !host.isConnected) return;
      if (typeof model === 'string') {
        failHost(host, model);
        return;
      }
      viewers.set(host, mount3dViewer(host, { kind: 'scene', spec, model }));
      host.setAttribute(STATE_ATTR, 'ready');
    });
  }
  return {
    dispose: () => {
      disposed = true;
      for (const v of viewers.values()) v.dispose();
      viewers.clear();
    },
    prune: () => {
      for (const [host, v] of viewers) {
        if (!host.isConnected) {
          v.dispose();
          viewers.delete(host);
        }
      }
      // ⚠ 添付を引いている途中の器も「まだ居る」に数える(早く畳まれて、借りた後に置き場を失わない)
      return hosts.filter((h) => h.isConnected && h.getAttribute(STATE_ATTR) !== 'failed').length;
    },
    flush: () => Promise.resolve(),
  };
}
