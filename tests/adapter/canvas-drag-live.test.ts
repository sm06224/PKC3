/** @vitest-environment happy-dom */
/**
 * 🔴 **無限キャンバスのドラッグ中の追従・スナップ・オートパン・背景ダブルクリック**(v4.0 仕上げ Polish PR-C)。
 *
 * ## 守る主張
 *
 * 1. 掴んで動かしている最中(離す前)に、つながる線の `<path d>`・矢じり・当たりと、ミニマップの付箋が追従する。
 *    更新は 1 コマ 1 回(rAF 集約)── 何回 pointermove が来ても要求は 1 つ。
 * 2. 動かしていない間は rAF を 1 つも要求しない(定常コスト 0)。離した / Esc / 外した後にも残さない。
 * 3. `Esc` で取りやめると、付箋・線・ミニマップが元に戻り、本文は書かない。
 * 4. スナップ: ほかの付箋の端・中央から 6px(画面)以内で吸い付き、補助線を出す。`Alt` で外す。離したら補助線は DOM に残らない。
 *    離したときに書く値は、吸い付いた見た目と同じ。
 * 5. オートパン: 枠の端 40px に入ると rAF でカメラを送り、付箋は手の下に留まる。端から離れた瞬間・離した・外したで止まる。
 *    範囲選択(ラバーバンド)でも同じ。
 * 6. キャンバスの何も無い背景のダブルクリックで、その座標(倍率を割り戻す)に `ADD_PLACE` 1 回。付箋・ミニマップの上では撃たない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { applyPlaceLayout, syncPlaceLinesLive } from '../../src/adapter/ui/render/place-board';
import { installPlaceDrag } from '../../src/adapter/ui/render/place-drag';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import {
  BAR_FIELD,
  canvasCameraOf,
  canvasZoomOf,
  GUIDES_FIELD,
  installCanvasViewport,
  MINIMAP_FIELD,
  resetCanvasMemory,
  syncBoardView,
  syncCanvasMinimapLive,
  VIEWPORT_FIELD,
} from '../../src/adapter/ui/render/canvas-viewport';

const BOARD = [
  ':::format{#p1 .pkc-place x=120 y=40 w=320 h=200}',
  '### 買い出し',
  ':::',
  '',
  ':::format{#p2 .pkc-place x=600 y=40 w=200 h=100}',
  ':::',
].join('\n');

const LINE =
  '<div class="pkc-format-block pkc-line" data-pkc-format-block data-pkc-from="p1" data-pkc-to="p2" data-pkc-arrow="end" data-pkc-source-line="7" data-pkc-source-end="8"></div>';

const RENDERED = [
  '<div class="pkc-format-block pkc-place" id="p1" data-pkc-format-block data-pkc-h="200" data-pkc-w="320" data-pkc-x="120" data-pkc-y="40" data-pkc-source-line="0" data-pkc-source-end="2" data-pkc-place-line="0"><h3>買い出し</h3></div>',
  '<div class="pkc-format-block pkc-place" id="p2" data-pkc-format-block data-pkc-h="100" data-pkc-w="200" data-pkc-x="600" data-pkc-y="40" data-pkc-source-line="4" data-pkc-source-end="5" data-pkc-place-line="4"></div>',
  LINE,
].join('\n');

function meta(lid: string, title: string): EntryMeta {
  return { lid, title, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null };
}

/** rAF を手で回す(呼ばれた数を数える)。 */
const frames = new Map<number, FrameRequestCallback>();
let rafCalls = 0;
let nextId = 1;
function flushFrames(max = 1): void {
  for (let i = 0; i < max; i += 1) {
    const fs = [...frames.values()];
    frames.clear();
    for (const f of fs) f(0);
  }
}

let region: HTMLElement;
let offs: Array<() => void> = [];

beforeEach(() => {
  resetCanvasMemory();
  frames.clear();
  rafCalls = 0;
  const win = document.defaultView!;
  vi.spyOn(win, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    rafCalls += 1;
    const id = nextId++;
    frames.set(id, cb);
    return id;
  });
  vi.spyOn(win, 'cancelAnimationFrame').mockImplementation((id: number) => {
    frames.delete(id);
  });
  region = document.createElement('div');
  document.body.append(region);
});
afterEach(() => {
  for (const f of offs) f();
  offs = [];
  region.remove();
  vi.restoreAllMocks();
});

function booted() {
  const d = new Dispatcher();
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '板')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BOARD });
  events.length = 0;
  return { d, events };
}

const bar = (): HTMLElement => region.querySelector<HTMLElement>(`[data-pkc-field="${BAR_FIELD}"]`)!;
const cmd = (c: string): HTMLButtonElement => bar().querySelector<HTMLButtonElement>(`[data-pkc-canvas-cmd="${c}"]`)!;

/** 枠の大きさと外形(happy-dom は配置を計算しない)。 */
function sizeViewport(vp: HTMLElement, w = 800, h = 600): void {
  Object.defineProperty(vp, 'clientWidth', { configurable: true, value: w });
  Object.defineProperty(vp, 'clientHeight', { configurable: true, value: h });
  vp.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) });
}
/** 器の外形はカメラに付いてくる(ステージの transform と同じ)。 */
function liveHostRect(host: HTMLElement): void {
  host.getBoundingClientRect = () => {
    const cam = canvasCameraOf(host) ?? { x: 0, y: 0, zoom: 1 };
    const left = -cam.x * cam.zoom;
    const top = -cam.y * cam.zoom;
    return { left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top, toJSON: () => ({}) } as DOMRect;
  };
}

/** キャンバスで開いた板(倍率 1、カメラは原点)。 */
function canvasBoard(opts: { canvas?: boolean; zoomOut?: number } = {}) {
  const host = document.createElement('div');
  host.innerHTML = RENDERED;
  region.append(host);
  applyPlaceLayout(host, () => null, 0);
  const { d, events } = booted();
  offs.push(installCanvasViewport(document.body, () => {}));
  offs.push(installPlaceDrag(document.body, d));
  syncBoardView(host, 'n1', BOARD);
  let vp: HTMLElement | null = null;
  if (opts.canvas !== false) {
    cmd('mode').click();
    vp = region.querySelector<HTMLElement>(`[data-pkc-field="${VIEWPORT_FIELD}"]`)!;
    sizeViewport(vp);
    cmd('zoom-reset').click();
    for (let i = 0; i < (opts.zoomOut ?? 0); i += 1) cmd('zoom-out').click();
    liveHostRect(host);
    // カメラを原点へ(全体表示の位置に依らない座標で確かめる)
    const cam = canvasCameraOf(host)! as { x: number; y: number };
    cam.x = 0;
    cam.y = 0;
  }
  // 台を組むまでの rAF(カメラのコマ)は数えない
  flushFrames(3);
  rafCalls = 0;
  events.length = 0;
  const grip = host.querySelector<HTMLElement>('#p1 [data-pkc-field="place-grip"]')!;
  const block = host.querySelector<HTMLElement>('#p1')!;
  return { host, vp, d, events, grip, block };
}

const o = { bubbles: true, pointerId: 7, button: 0 };
const lineD = (host: HTMLElement): string =>
  host.querySelector('[data-pkc-field="place-lines"] path[data-pkc-line-from]')!.getAttribute('d')!;
const headD = (host: HTMLElement): string =>
  host.querySelector('[data-pkc-field="place-lines"] path[data-pkc-line-head]')!.getAttribute('d')!;
const hitD = (host: HTMLElement): string =>
  host.querySelector('[data-pkc-field="place-line-hits"] path')!.getAttribute('d')!;
const miniCardX = (vp: HTMLElement): string =>
  vp.querySelector(`[data-pkc-field="${MINIMAP_FIELD}"] rect[data-pkc-minimap-card]`)!.getAttribute('x')!;
const guides = (host: HTMLElement): Element | null => host.querySelector(`[data-pkc-field="${GUIDES_FIELD}"]`);

describe('🔴 線とミニマップのライブ追従', () => {
  it('syncPlaceLinesLive: style の位置から線・矢じり・当たりを引き直す(描き直した線と同じ d)', () => {
    const host = document.createElement('div');
    host.innerHTML = RENDERED;
    region.append(host);
    applyPlaceLayout(host, () => null, 0);
    const before = { d: lineD(host), head: headD(host) };
    host.querySelector<HTMLElement>('#p1')!.style.top = '400px';
    expect(syncPlaceLinesLive(host)).toBe(1);
    expect(lineD(host)).not.toBe(before.d);
    expect(headD(host)).not.toBe(before.head);
    expect(hitD(host)).toBe(lineD(host));
    // 対照: 本文を y=400 で描き直した線と 1px も違わない
    const ref = document.createElement('div');
    ref.innerHTML = RENDERED.replace('data-pkc-y="40" data-pkc-source-line="0"', 'data-pkc-y="400" data-pkc-source-line="0"');
    region.append(ref);
    applyPlaceLayout(ref, () => null, 0);
    expect(lineD(host)).toBe(lineD(ref));
    expect(headD(host)).toBe(headD(ref));
  });

  it('線が 1 本も無い器では何もしない(仕事 0)', () => {
    const host = document.createElement('div');
    host.innerHTML = RENDERED.replace(LINE, '');
    region.append(host);
    applyPlaceLayout(host, () => null, 0);
    expect(syncPlaceLinesLive(host)).toBe(0);
  });

  it('🔴 離す前に、線の d とミニマップの付箋が動く。要求は 1 コマ 1 回', () => {
    const { host, vp, grip, block } = canvasBoard();
    const d0 = lineD(host);
    const m0 = miniCardX(vp!);
    // ⚠ 枠の端(40px)から離れた所で動かす(端ではオートパンが別に rAF を要求する)
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 400, clientY: 100, altKey: true }));
    for (let i = 1; i <= 5; i += 1) {
      document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 400, clientY: 100 + 60 * i, altKey: true }));
    }
    expect(block.style.top).toBe('340px');
    expect(rafCalls, '5 回動かしても要求は 1 つ').toBe(1);
    expect(lineD(host), 'コマが来る前は引き直さない').toBe(d0);
    flushFrames();
    expect(lineD(host)).not.toBe(d0);
    expect(miniCardX(vp!)).toBe(m0); // x は動かしていない
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 500, clientY: 400, altKey: true }));
    flushFrames();
    expect(miniCardX(vp!)).toBe('220');
  });

  it('ミニマップを閉じているときは何もしない', () => {
    const { host, block } = canvasBoard();
    cmd('minimap').click();
    block.style.left = '900px';
    expect(syncCanvasMinimapLive(host)).toBe(0);
  });

  it('🔴 Esc で取りやめると、付箋・線・ミニマップが元へ戻り、本文は書かない', () => {
    const { host, vp, grip, block, events } = canvasBoard();
    const d0 = lineD(host);
    const m0 = miniCardX(vp!);
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 100, clientY: 100, altKey: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 400, clientY: 400, altKey: true }));
    flushFrames();
    expect(lineD(host)).not.toBe(d0);
    const closed = vi.fn();
    document.body.addEventListener('keydown', closed);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.removeEventListener('keydown', closed);
    expect(closed, 'Esc は開いているノートへ渡さない').not.toHaveBeenCalled();
    expect(block.style.left).toBe('120px');
    expect(block.style.top).toBe('40px');
    flushFrames();
    expect(lineD(host)).toBe(d0);
    expect(miniCardX(vp!)).toBe(m0);
    document.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 400, clientY: 400 }));
    expect(frames.size, 'Esc の後に送りも追従も残らない').toBe(0);
    expect(events.some((e) => e.type === 'REQUEST_BODY_REWRITE')).toBe(false);
  });

  it('🔴 静止時は rAF 0。離した後も残らない', () => {
    const { grip } = canvasBoard();
    expect(rafCalls).toBe(0);
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 30, clientY: 200 }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 30, clientY: 200 }));
    flushFrames(5);
    const after = rafCalls;
    expect(frames.size).toBe(0);
    // 何もしない間は 1 つも要求しない
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 500, clientY: 500 }));
    expect(rafCalls).toBe(after);
  });
});

describe('🔴 スナップ補助線', () => {
  // p1(x=120 y=40 h=200)を下へ 53 動かすと上端 93 ── p2 の中央(40 + 50 = 90)から 3px で吸い付く
  it('近い所で吸い付いて補助線を出し、離すと消える。書く値は吸い付いた見た目と同じ', () => {
    const { host, grip, block, events } = canvasBoard();
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 0, clientY: 53 }));
    expect(block.style.top).toBe('90px');
    const g = guides(host);
    expect(g).not.toBeNull();
    const ln = g!.querySelector('line[data-pkc-guide-axis="y"]')!;
    expect(ln.getAttribute('y1')).toBe('90');
    expect(g!.hasAttribute('data-pkc-overlay')).toBe(true);
    document.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 0, clientY: 53 }));
    expect(guides(host)).toBeNull();
    expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      rewrite: { kind: 'place-move', line: 0, x: 120, y: 90 },
    });
  });

  it('🔴 Alt を押している間は吸い付かない(押し離しで、手が止まっていても切り替わる)', () => {
    const { host, grip, block } = canvasBoard();
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 0, clientY: 53, altKey: true }));
    expect(block.style.top).toBe('93px');
    expect(guides(host)).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true }));
    expect(block.style.top).toBe('90px');
    expect(guides(host)).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true }));
    expect(block.style.top).toBe('93px');
    expect(guides(host)).toBeNull();
    document.dispatchEvent(new PointerEvent('pointercancel', { ...o }));
  });

  it('閾値は画面の 6px(縮小中はワールドで広くなる)/ 遠ければ吸い付かない', () => {
    const { host, grip, block } = canvasBoard({ zoomOut: 3 }); // 0.512 倍 → ワールド 11.7px
    expect(canvasZoomOf(host)).toBeCloseTo(0.512);
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 0, clientY: 0 }));
    // ワールド +60(上端 100)── 中央 90 から 10px、画面では 5.1px → 吸い付く
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 0, clientY: 60 * 0.512 }));
    expect(block.style.top).toBe('90px');
    // ワールド +70(上端 110)── 中央から 20px、画面 10px → 吸い付かない
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 0, clientY: 70 * 0.512 }));
    expect(Number.parseFloat(block.style.top)).toBeCloseTo(110);
    expect(guides(host)).toBeNull();
    document.dispatchEvent(new PointerEvent('pointercancel', { ...o }));
    expect(guides(host)).toBeNull();
  });

  it('通常表示のボードでも吸い付き、取りやめ(pointercancel)で補助線を消す', () => {
    const { host, grip, block } = canvasBoard({ canvas: false });
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 0, clientY: 53 }));
    expect(block.style.top).toBe('90px');
    expect(guides(host)).not.toBeNull();
    document.dispatchEvent(new PointerEvent('pointercancel', { ...o }));
    expect(guides(host)).toBeNull();
    expect(block.style.top).toBe('40px');
  });
});

describe('🔴 ドラッグ端のオートパン', () => {
  it('右端 40px に入ると rAF で送り、付箋は手の下に留まる。端から離れた瞬間に止まる', () => {
    const { host, grip, block, events } = canvasBoard();
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 400, clientY: 300, altKey: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 795, clientY: 300, altKey: true }));
    expect(block.style.left).toBe('515px');
    const cam0 = canvasCameraOf(host)!.x;
    flushFrames(); // 線の追従 + 1 コマ目の送り
    const cam1 = canvasCameraOf(host)!.x;
    expect(cam1).toBeGreaterThan(cam0);
    const sent = cam1 - cam0;
    expect(Number.parseFloat(block.style.left)).toBeCloseTo(515 + sent);
    expect(frames.size, '端に居る間は次のコマを待つ').toBeGreaterThan(0);
    flushFrames();
    expect(canvasCameraOf(host)!.x).toBeCloseTo(cam0 + sent * 2);
    // 真ん中へ戻すと、その場で止まる(待っていた送りのコマを取り消す ── 線の追従・カリングのコマは既に待っている)
    const pending = frames.size;
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 400, clientY: 300, altKey: true }));
    expect(frames.size, '端から離れた瞬間に送りのコマを取り消す').toBe(pending - 1);
    flushFrames(); // 線の追従だけ
    expect(frames.size).toBe(0);
    const camStop = canvasCameraOf(host)!.x;
    flushFrames(3);
    expect(canvasCameraOf(host)!.x).toBe(camStop);
    document.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 400, clientY: 300, altKey: true }));
    expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      rewrite: { kind: 'place-move', line: 0, x: Math.round(120 + sent * 2), y: 40 },
    });
  });

  it('🔴 離した / Esc / 外した、のどれでも送りを止める(rAF を残さない)', () => {
    for (const end of ['up', 'esc', 'dispose'] as const) {
      const { host, grip } = canvasBoard();
      grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 400, clientY: 300 }));
      document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 400, clientY: 598 }));
      flushFrames();
      expect(frames.size, `${end}: 端で回っている`).toBeGreaterThan(0);
      if (end === 'up') document.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 400, clientY: 598 }));
      if (end === 'esc') document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (end === 'dispose') {
        for (const f of offs) f();
        offs = [];
      }
      const cam = canvasCameraOf(host)?.y ?? 0;
      flushFrames(3);
      expect(frames.size, `${end}: 止まる`).toBe(0);
      expect(canvasCameraOf(host)?.y ?? 0, `${end}: もう送らない`).toBe(cam);
      for (const f of offs) f();
      offs = [];
      region.textContent = '';
      resetCanvasMemory();
    }
  });

  it('範囲選択を端まで引いても送り、離すと止まる', () => {
    const { host, vp } = canvasBoard();
    const p = { bubbles: true, pointerId: 9, button: 0, shiftKey: true };
    vp!.dispatchEvent(new PointerEvent('pointerdown', { ...p, clientX: 300, clientY: 500 }));
    vp!.dispatchEvent(new PointerEvent('pointermove', { ...p, clientX: 400, clientY: 595 }));
    const cam0 = canvasCameraOf(host)!.y;
    flushFrames();
    expect(canvasCameraOf(host)!.y).toBeGreaterThan(cam0);
    expect(frames.size).toBeGreaterThan(0);
    vp!.dispatchEvent(new PointerEvent('pointerup', { ...p, clientX: 400, clientY: 595 }));
    flushFrames(3);
    expect(frames.size).toBe(0);
  });
});

describe('🔴 キャンバスの背景をダブルクリックして付箋を置く', () => {
  function rig() {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    region.append(root);
    const d = new Dispatcher();
    const adds: Array<{ lid: string; x: number; y: number }> = [];
    const real = d.dispatch.bind(d);
    d.dispatch = ((a: { type: string; lid: string; x: number; y: number }) => {
      if (a.type === 'ADD_PLACE') adds.push({ lid: a.lid, x: a.x, y: a.y });
      return real(a as never);
    }) as typeof d.dispatch;
    bindActions(root, d, { showStatus: () => {} });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '板')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BOARD });
    const host = document.createElement('div');
    host.innerHTML = RENDERED;
    root.append(host);
    applyPlaceLayout(host, () => null, 0);
    offs.push(installCanvasViewport(document.body, () => {}));
    syncBoardView(host, 'n1', BOARD);
    cmd('mode').click();
    const vp = region.querySelector<HTMLElement>(`[data-pkc-field="${VIEWPORT_FIELD}"]`)!;
    sizeViewport(vp);
    cmd('zoom-reset').click();
    for (let i = 0; i < 3; i += 1) cmd('zoom-out').click(); // 0.512 倍
    liveHostRect(host);
    const cam = canvasCameraOf(host)! as { x: number; y: number };
    cam.x = -100;
    cam.y = -50;
    return { host, vp, adds };
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const dbl = (el: Element, x: number, y: number): void => {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
  };

  it('🔴 枠の背景: 倍率と負の位置を割り戻した座標で ADD_PLACE 1 回', async () => {
    const { vp, adds } = rig();
    dbl(vp, 256, 128);
    await flush();
    // 器の左上は画面の (51.2, 25.6) ── ワールド = (256 − 51.2) / 0.512 = 400 / (128 − 25.6) / 0.512 = 200
    expect(adds).toEqual([{ lid: 'n1', x: 400, y: 200 }]);
    dbl(vp, 0, 0); // 左上より手前 → 負の所
    await flush();
    expect(adds[1]).toEqual({ lid: 'n1', x: -100, y: -50 });
  });

  it('器(ステージ)そのものの背景でも置ける', async () => {
    const { host, adds } = rig();
    dbl(host, 307.2, 153.6);
    await flush();
    expect(adds).toEqual([{ lid: 'n1', x: 500, y: 250 }]);
  });

  it('🔴 付箋・ミニマップ・バーの上のダブルクリックでは置かない', async () => {
    const { host, vp, adds } = rig();
    dbl(host.querySelector('#p2')!, 400, 100);
    dbl(host.querySelector('#p1 h3')!, 300, 100);
    dbl(vp.querySelector(`[data-pkc-field="${MINIMAP_FIELD}"] svg`)!, 700, 500);
    dbl(bar(), 10, 10);
    await flush();
    expect(adds).toEqual([]);
  });

  it('対照群: 通常表示のボードの背景のダブルクリックでは置かない(キャンバスだけ)', async () => {
    const { host, adds } = rig();
    cmd('mode').click();
    dbl(host, 100, 100);
    await flush();
    expect(adds).toEqual([]);
  });
});
