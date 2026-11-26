/** @vitest-environment happy-dom */
/**
 * 🔴 **付箋のボードの無限キャンバス**(v4.0 Phase 2 / PR-09、`src/adapter/ui/render/canvas-viewport.ts`)。
 *
 * ## 守る主張
 *
 * 1. 付箋の無いノートでは何も作らない(バー・枠・監視なし = 定常コスト 0)
 * 2. 「無限キャンバス」⇔ 通常表示を往復できる(aria-pressed。片道を作らない)。器は枠に包まれ、戻すと元の場所へ戻る
 * 3. 前書きの `layout: canvas` のノートは最初からキャンバス。「いつもキャンバスで開く」は `SET_CANVAS_LAYOUT` で書く / 外す
 * 4. パン・ズームはステージの transform だけを変える(本文の書換を 1 件も出さない)
 * 5. 🔴 倍率 0.5 / 2.0 で掴んで動かした量は画面の移動量 ÷ 倍率(カーソルに付いてくる)。キャンバスでは負の所へ書ける
 * 6. カリング: 画面の外の付箋に印が付き、戻ると外れる(外形は測った大きさのまま)
 * 7. ミニマップを押すと、その所が枠の真ん中に来る
 * 8. 通常表示で負の位置の付箋があれば器を寄せる(正の位置だけのボードは 1px も変えない)
 * 9. カメラはノートごとに覚え、描き直し・器の作り直しで戻らない
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { applyPlaceLayout } from '../../src/adapter/ui/render/place-board';
import { installPlaceDrag } from '../../src/adapter/ui/render/place-drag';
import {
  BAR_FIELD,
  CANVAS_ATTR,
  canvasBackgroundTarget,
  canvasCameraOf,
  canvasDrawSession,
  canvasZoomOf,
  CULLED_ATTR,
  flushCanvasFrame,
  installCanvasViewport,
  isCanvasHost,
  MINIMAP_FIELD,
  resetCanvasMemory,
  SHIFT_ATTR,
  syncBoardView,
  VIEWPORT_FIELD,
} from '../../src/adapter/ui/render/canvas-viewport';
import { centerCameraOn, minimapGeometry, minimapPointToWorld } from '../../src/features/canvas/viewport';

const BOARD = [
  ':::format{#p1 .pkc-place x=120 y=40 w=320 h=200}',
  '### 買い出し',
  ':::',
  '',
  ':::format{#p2 .pkc-place x=600 y=40 w=200 h=100}',
  ':::',
].join('\n');

const RENDERED = [
  '<div class="pkc-format-block pkc-place" id="p1" data-pkc-format-block data-pkc-h="200" data-pkc-w="320" data-pkc-x="120" data-pkc-y="40" data-pkc-source-line="0" data-pkc-source-end="2"><h3>買い出し</h3></div>',
  '<div class="pkc-format-block pkc-place" id="p2" data-pkc-format-block data-pkc-h="100" data-pkc-w="200" data-pkc-x="600" data-pkc-y="40" data-pkc-source-line="4" data-pkc-source-end="5"></div>',
].join('\n');

function meta(lid: string, title: string): EntryMeta {
  return { lid, title, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null };
}

let region: HTMLElement;
let offs: Array<() => void> = [];

beforeEach(() => {
  resetCanvasMemory();
  region = document.createElement('div');
  document.body.append(region);
});
afterEach(() => {
  for (const f of offs) f();
  offs = [];
  region.remove();
});

function board(html = RENDERED): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  region.append(host);
  applyPlaceLayout(host, () => null, 0);
  return host;
}

function booted(body = BOARD) {
  const d = new Dispatcher();
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '板')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  events.length = 0;
  return { d, events };
}

const bar = (): HTMLElement => region.querySelector<HTMLElement>(`[data-pkc-field="${BAR_FIELD}"]`)!;
const cmd = (c: string): HTMLButtonElement => bar().querySelector<HTMLButtonElement>(`[data-pkc-canvas-cmd="${c}"]`)!;
const vpOf = (): HTMLElement | null => region.querySelector<HTMLElement>(`[data-pkc-field="${VIEWPORT_FIELD}"]`);

/** 枠の大きさを与える(happy-dom は配置を計算しない)。 */
function sizeViewport(w = 800, h = 600): HTMLElement {
  const vp = vpOf()!;
  Object.defineProperty(vp, 'clientWidth', { configurable: true, value: w });
  Object.defineProperty(vp, 'clientHeight', { configurable: true, value: h });
  return vp;
}

function installBar(onDefault: (lid: string, on: boolean) => void = () => {}): void {
  offs.push(installCanvasViewport(document.body, onDefault));
}

describe('起動しない所(定常コスト 0)', () => {
  it('🔴 付箋の無いノートではバーも枠も作らない', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>ふつうの本文</p>';
    region.append(host);
    applyPlaceLayout(host, () => null, 0);
    expect(syncBoardView(host, 'n9', 'ふつうの本文')).toBe(false);
    expect(region.querySelector(`[data-pkc-field="${BAR_FIELD}"]`)).toBeNull();
    expect(vpOf()).toBeNull();
    expect(host.getAttribute('style')).toBeNull();
    expect(isCanvasHost(host)).toBe(false);
    expect(canvasZoomOf(host)).toBe(1);
  });

  it('付箋を全部消した本文では、作った物を外して器を元へ戻す', () => {
    const host = board();
    installBar();
    syncBoardView(host, 'n1', BOARD);
    cmd('mode').click();
    expect(vpOf()).not.toBeNull();
    host.innerHTML = '<p>付箋なし</p>';
    syncBoardView(host, 'n1', '付箋なし');
    expect(vpOf()).toBeNull();
    expect(host.parentElement).toBe(region);
    expect(region.querySelector(`[data-pkc-field="${BAR_FIELD}"]`)).toBeNull();
    expect(host.hasAttribute(CANVAS_ATTR)).toBe(false);
  });
});

describe('無限キャンバス ⇔ 通常表示', () => {
  it('🔴 通常表示: バーは「無限キャンバス」1 つ(押していない)、枠は無い', () => {
    const host = board();
    expect(syncBoardView(host, 'n1', BOARD)).toBe(false);
    expect(bar().nextElementSibling).toBe(host);
    expect(cmd('mode').getAttribute('aria-pressed')).toBe('false');
    for (const c of ['zoom-out', 'zoom-reset', 'zoom-in', 'fit', 'minimap', 'default']) expect(cmd(c).hidden).toBe(true);
    expect(vpOf()).toBeNull();
    expect(host.style.transform).toBe('');
  });

  it('🔴 押すとキャンバス、もう一度押すと通常表示へ戻る(片道を作らない)', () => {
    const host = board();
    installBar();
    syncBoardView(host, 'n1', BOARD);
    cmd('mode').click();
    const vp = vpOf()!;
    expect(vp).not.toBeNull();
    expect(host.parentElement).toBe(vp);
    expect(bar().nextElementSibling).toBe(vp);
    expect(host.hasAttribute(CANVAS_ATTR)).toBe(true);
    expect(host.style.transform).toContain('scale(');
    expect(vp.querySelector(`[data-pkc-field="${MINIMAP_FIELD}"]`)).not.toBeNull();
    expect(cmd('mode').getAttribute('aria-pressed')).toBe('true');
    expect(cmd('zoom-in').hidden).toBe(false);
    // 戻す
    cmd('mode').click();
    expect(vpOf()).toBeNull();
    expect(host.parentElement).toBe(region);
    expect(bar().nextElementSibling).toBe(host);
    expect(host.hasAttribute(CANVAS_ATTR)).toBe(false);
    expect(host.style.transform).toBe('');
    expect(cmd('mode').getAttribute('aria-pressed')).toBe('false');
  });

  it('🔴 前書きの layout: canvas のノートは最初からキャンバス。選んだ見え方はノートごとに覚える', () => {
    const body = `---\nlayout: canvas\n---\n${BOARD}`;
    const host = board();
    expect(syncBoardView(host, 'n1', body)).toBe(true);
    expect(cmd('default').getAttribute('aria-pressed')).toBe('true');
    // 別のノート(前書きなし)は通常表示
    const other = board();
    expect(syncBoardView(other, 'n2', BOARD)).toBe(false);
  });

  it('🔴 「いつもキャンバスで開く」は本文へ layout: canvas を書く依頼になる(押すたびに書く / 外すが入れ替わる)', () => {
    const asked: Array<[string, boolean]> = [];
    const host = board();
    installBar((lid, on) => asked.push([lid, on]));
    syncBoardView(host, 'n1', BOARD);
    cmd('mode').click();
    cmd('default').click();
    expect(asked).toEqual([['n1', true]]);
    syncBoardView(host, 'n1', `---\nlayout: canvas\n---\n${BOARD}`);
    cmd('default').click();
    expect(asked).toEqual([['n1', true], ['n1', false]]);
  });
});

describe('SET_CANVAS_LAYOUT(reducer)', () => {
  it('🔴 書く: 前書きの frontmatter 書換 1 本(layout: canvas)', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'SET_CANVAS_LAYOUT', lid: 'n1', on: true });
    expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      lid: 'n1',
      rewrite: { kind: 'frontmatter', keys: { layout: 'canvas' } },
    });
  });
  it('🔴 外す: layout: canvas のときだけ(用紙の layout は消さない)/ すでにその形なら何も出さない', () => {
    const on = booted(`---\nlayout: canvas\n---\n${BOARD}`);
    on.d.dispatch({ type: 'SET_CANVAS_LAYOUT', lid: 'n1', on: false });
    expect(on.events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      rewrite: { kind: 'frontmatter', keys: { layout: undefined } },
    });
    on.events.length = 0;
    on.d.dispatch({ type: 'SET_CANVAS_LAYOUT', lid: 'n1', on: true });
    expect(on.events.some((e) => e.type === 'REQUEST_BODY_REWRITE')).toBe(false);
    const paper = booted(`---\nlayout: a4-2col\n---\n${BOARD}`);
    paper.d.dispatch({ type: 'SET_CANVAS_LAYOUT', lid: 'n1', on: false });
    expect(paper.events.some((e) => e.type === 'REQUEST_BODY_REWRITE')).toBe(false);
  });
  it('編集中は声に出して断る', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'SET_CANVAS_LAYOUT', lid: 'n1', on: true });
    expect(events.some((e) => e.type === 'REQUEST_BODY_REWRITE')).toBe(false);
    expect(d.getState().error).toContain('表示の既定を変えてください');
  });
});

describe('パンとズーム(transform だけ)', () => {
  function canvas() {
    const host = board();
    const { d, events } = booted();
    installBar();
    syncBoardView(host, 'n1', BOARD);
    cmd('mode').click();
    const vp = sizeViewport();
    return { host, vp, d, events };
  }

  it('🔴 + / − / 100% / 全体を表示', () => {
    const { host } = canvas();
    cmd('zoom-reset').click();
    expect(canvasZoomOf(host)).toBe(1);
    expect(cmd('zoom-reset').textContent).toBe('100%');
    cmd('zoom-in').click();
    expect(canvasZoomOf(host)).toBeCloseTo(1.25);
    expect(host.style.transform).toContain('scale(1.25)');
    expect(cmd('zoom-reset').textContent).toBe('125%');
    cmd('zoom-out').click();
    cmd('zoom-out').click();
    expect(canvasZoomOf(host)).toBeCloseTo(0.8);
    cmd('zoom-reset').click();
    expect(canvasZoomOf(host)).toBe(1);
    // 全体を表示: 付箋の外接四角(120..800 × 40..240)の真ん中が枠の真ん中(400, 300)へ
    cmd('fit').click();
    const cam = canvasCameraOf(host)!;
    expect((460 - cam.x) * cam.zoom).toBeCloseTo(400);
    expect((140 - cam.y) * cam.zoom).toBeCloseTo(300);
    expect(cam.zoom).toBeLessThanOrEqual(1);
  });

  it('🔴 背景を左ドラッグすると移動し、本文の書換は 1 件も出ない', () => {
    const { host, vp, events } = canvas();
    cmd('zoom-reset').click();
    const before = canvasCameraOf(host)!;
    const o = { bubbles: true, pointerId: 7, button: 0 };
    host.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 100, clientY: 100 }));
    vp.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 160, clientY: 70 }));
    vp.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 160, clientY: 70 }));
    const after = canvasCameraOf(host)!;
    expect(after.x).toBeCloseTo(before.x - 60);
    expect(after.y).toBeCloseTo(before.y + 30);
    expect(host.style.transform).toContain('scale(1)');
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toEqual([]);
  });

  it('🔴 付箋の上の左ドラッグはパンにしない(中ボタンはどこでもパン)', () => {
    const { host, vp } = canvas();
    const before = canvasCameraOf(host)!;
    const card = host.querySelector<HTMLElement>('#p1 h3')!;
    const o = { bubbles: true, pointerId: 8, button: 0 };
    card.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 10, clientY: 10 }));
    vp.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 90, clientY: 90 }));
    vp.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 90, clientY: 90 }));
    expect(canvasCameraOf(host)).toEqual(before);
    const m = { bubbles: true, pointerId: 9, button: 1 };
    card.dispatchEvent(new PointerEvent('pointerdown', { ...m, clientX: 10, clientY: 10 }));
    vp.dispatchEvent(new PointerEvent('pointermove', { ...m, clientX: 50, clientY: 10 }));
    vp.dispatchEvent(new PointerEvent('pointerup', { ...m, clientX: 50, clientY: 10 }));
    expect(canvasCameraOf(host)!.x).toBeCloseTo(before.x - 40 / before.zoom);
  });

  it('🔴 Ctrl + ホイールはポインタの下を動かさずに倍率を変える / ホイールだけならパン', () => {
    const { host, vp } = canvas();
    cmd('zoom-reset').click();
    const cam = canvasCameraOf(host)!;
    const wx = cam.x + 200 / cam.zoom;
    // ⚠ happy-dom の WheelEvent は ctrlKey / clientX を受けない ── 実物と同じ値を event に置く
    const zoomEv = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -200 });
    for (const [k, v] of [['ctrlKey', true], ['clientX', 200], ['clientY', 150]] as const)
      Object.defineProperty(zoomEv, k, { value: v });
    vp.dispatchEvent(zoomEv);
    expect(zoomEv.defaultPrevented).toBe(true);
    const z = canvasCameraOf(host)!;
    expect(z.zoom).toBeGreaterThan(1);
    expect(z.x + 200 / z.zoom).toBeCloseTo(wx);
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 50 });
    vp.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(canvasCameraOf(host)!.y).toBeCloseTo(z.y + 50 / z.zoom);
  });

  it('枠の背景(器の外形の外)の右クリックは器を押したと読む', () => {
    const { host, vp } = canvas();
    expect(canvasBackgroundTarget(vp)).toBe(host);
    const card = host.querySelector('#p1')!;
    expect(canvasBackgroundTarget(card)).toBe(card);
  });
});

describe('🔴 倍率を割り戻して掴む(place-drag との結合)', () => {
  function mounted(zoomClicks: 'in2' | 'out3' | 'none') {
    const host = board();
    const { d, events } = booted();
    installBar();
    offs.push(installPlaceDrag(document.body, d));
    syncBoardView(host, 'n1', BOARD);
    cmd('mode').click();
    sizeViewport();
    cmd('zoom-reset').click();
    if (zoomClicks === 'in2') {
      cmd('zoom-in').click(); // 1.25
      cmd('zoom-in').click(); // 1.5625
    }
    if (zoomClicks === 'out3') {
      for (let i = 0; i < 3; i += 1) cmd('zoom-out').click(); // 0.512
    }
    events.length = 0;
    const grip = host.querySelector<HTMLElement>('#p1 [data-pkc-field="place-grip"]')!;
    const block = host.querySelector<HTMLElement>('#p1')!;
    return { host, d, events, grip, block };
  }
  const o = { bubbles: true, pointerId: 3, button: 0 };
  function dragBy(grip: HTMLElement, dx: number, dy: number): void {
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: dx, clientY: dy }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: dx, clientY: dy }));
  }

  it('🔴 縮小(0.512 倍)で 256px 動かすと、ワールドでは 500px 動く', () => {
    const { host, events, grip } = mounted('out3');
    const z = canvasZoomOf(host);
    expect(z).toBeCloseTo(0.512);
    dragBy(grip, 256, 128);
    expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      rewrite: { kind: 'place-move', line: 0, x: 120 + 500, y: 40 + 250 },
    });
  });

  it('🔴 拡大(1.5625 倍)で 125px 動かすと、ワールドでは 80px 動く(見た目もカーソルと同じだけ)', () => {
    const { events, grip, block } = mounted('in2');
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 125, clientY: -62.5 }));
    expect(block.style.left).toBe('200px');
    expect(block.style.top).toBe('0px');
    document.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 125, clientY: -62.5 }));
    expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      rewrite: { kind: 'place-move', line: 0, x: 200, y: 0 },
    });
  });

  it('🔴 キャンバスでは負の所へ動かして離すと、負の x= / y= を書く依頼になる', () => {
    const { events, grip } = mounted('out3');
    dragBy(grip, -512, -256); // ワールド −1000 / −500
    expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      rewrite: { kind: 'place-move', line: 0, x: 120 - 1000, y: 40 - 500 },
    });
  });

  it('対照群: 通常表示では左上 0 で止める(今までと同じ)', () => {
    const host = board();
    const { d, events } = booted();
    offs.push(installPlaceDrag(document.body, d));
    syncBoardView(host, 'n1', BOARD);
    const grip = host.querySelector<HTMLElement>('#p1 [data-pkc-field="place-grip"]')!;
    dragBy(grip, -1000, -1000);
    expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      rewrite: { kind: 'place-move', line: 0, x: 0, y: 0 },
    });
  });
});

describe('カリングとミニマップ', () => {
  it('🔴 画面の外の付箋に印が付き、戻ると外れる(外形の大きさを渡す)', () => {
    const host = board();
    installBar();
    syncBoardView(host, 'n1', BOARD);
    cmd('mode').click();
    const vp = sizeViewport(800, 600);
    cmd('zoom-reset').click();
    cmd('fit').click();
    expect(flushCanvasFrame(host)).toBe(0);
    // 遠くへ動かす(右へ 5000px 見る)
    const o = { bubbles: true, pointerId: 4, button: 0 };
    vp.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 6000, clientY: 0 }));
    vp.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 0, clientY: 0 }));
    vp.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 0, clientY: 0 }));
    expect(flushCanvasFrame(host)).toBe(2);
    const p1 = host.querySelector<HTMLElement>('#p1')!;
    expect(p1.getAttribute(CULLED_ATTR)).toBe('1');
    expect(p1.style.getPropertyValue('--pkc-cull-w')).toBe('320px');
    expect(p1.style.getPropertyValue('--pkc-cull-h')).toBe('200px');
    cmd('fit').click();
    expect(flushCanvasFrame(host)).toBe(0);
    expect(p1.hasAttribute(CULLED_ATTR)).toBe(false);
    expect(p1.style.getPropertyValue('--pkc-cull-w')).toBe('');
  });

  it('枠の大きさが測れない(0)ときは印を付けない', () => {
    const host = board();
    installBar();
    syncBoardView(host, 'n1', BOARD);
    cmd('mode').click();
    expect(flushCanvasFrame(host)).toBe(0);
  });

  it('🔴 ミニマップを押すと、その所が枠の真ん中に来る / ミニマップは閉じて開ける', () => {
    const host = board();
    installBar();
    syncBoardView(host, 'n1', BOARD);
    cmd('mode').click();
    const vp = sizeViewport(800, 600);
    cmd('zoom-reset').click();
    flushCanvasFrame(host);
    const cam = canvasCameraOf(host)!;
    const g = minimapGeometry({ x: 120, y: 40, w: 680, h: 200 }, cam, 800, 600, 200, 140);
    const minimap = vp.querySelector<HTMLElement>(`[data-pkc-field="${MINIMAP_FIELD}"]`)!;
    expect(minimap.querySelectorAll('rect[data-pkc-minimap-card]')).toHaveLength(2);
    const svg = minimap.querySelector('svg')!;
    svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 5, button: 0, clientX: 30, clientY: 100 }));
    vp.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 5, button: 0, clientX: 30, clientY: 100 }));
    const p = minimapPointToWorld(g, 30, 100);
    const want = centerCameraOn(cam, p.x, p.y, 800, 600);
    const got = canvasCameraOf(host)!;
    expect(got.x).toBeCloseTo(want.x);
    expect(got.y).toBeCloseTo(want.y);
    expect(cmd('minimap').getAttribute('aria-pressed')).toBe('true');
    cmd('minimap').click();
    expect(minimap.hidden).toBe(true);
    expect(cmd('minimap').getAttribute('aria-pressed')).toBe('false');
    cmd('minimap').click();
    expect(minimap.hidden).toBe(false);
  });
});

describe('通常表示の負の位置', () => {
  it('🔴 負の位置の付箋があれば、いちばん左上が 0 に来るまで器を寄せる', () => {
    const html = RENDERED.replace('data-pkc-x="120"', 'data-pkc-x="-300"').replace('data-pkc-y="40" data-pkc-source-line="0"', 'data-pkc-y="-50" data-pkc-source-line="0"');
    const host = board(html);
    syncBoardView(host, 'n1', BOARD);
    expect(host.querySelector<HTMLElement>('#p1')!.style.left).toBe('-300px');
    expect(host.hasAttribute(SHIFT_ATTR)).toBe(true);
    expect(host.style.getPropertyValue('--pkc-board-shift-x')).toBe('300px');
    expect(host.style.getPropertyValue('--pkc-board-shift-y')).toBe('50px');
    // キャンバスへ切り替えると寄せは外れる(カメラが受け持つ)
    installBar();
    cmd('mode').click();
    expect(host.hasAttribute(SHIFT_ATTR)).toBe(false);
  });
  it('🔴 対照群: 正の位置だけのボードには何も足さない', () => {
    const host = board();
    syncBoardView(host, 'n1', BOARD);
    expect(host.hasAttribute(SHIFT_ATTR)).toBe(false);
    expect(host.style.getPropertyValue('--pkc-board-shift-x')).toBe('');
  });
});

describe('カメラの記憶(本文は汚さない)', () => {
  it('🔴 描き直し・器の作り直しでもカメラは戻らない(ノートごと)', () => {
    const host = board();
    installBar();
    syncBoardView(host, 'n1', BOARD);
    cmd('mode').click();
    sizeViewport();
    cmd('zoom-reset').click();
    cmd('zoom-in').click();
    const cam = canvasCameraOf(host)!;
    // 同じ器の描き直し
    applyPlaceLayout(host, () => null, 0);
    syncBoardView(host, 'n1', BOARD);
    expect(canvasCameraOf(host)).toEqual(cam);
    // 器が作り直された(別のノートを見て戻った)
    vpOf()!.remove();
    bar().remove();
    const again = board();
    expect(syncBoardView(again, 'n1', BOARD)).toBe(true);
    expect(canvasCameraOf(again)).toEqual(cam);
  });
});

/* ───────────────── v4.0 Phase 2 / PR-10(ビジョン 2-B): 複数選択・整列・手書き ───────────────── */

/**
 * 器の外形を、実物と同じくカメラ込みで返す(happy-dom は transform を測らない)。
 * 枠の左上 = 画面の (0, 0) としたとき、器の左上 = (−cam.x·zoom, −cam.y·zoom)。
 */
function liveHostRect(host: HTMLElement, offsetTop = 0): void {
  host.getBoundingClientRect = () => {
    const cam = canvasCameraOf(host) ?? { x: 0, y: 0, zoom: 1 };
    const left = -cam.x * cam.zoom;
    const top = -cam.y * cam.zoom + offsetTop;
    return { left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top, toJSON: () => ({}) } as DOMRect;
  };
}

describe('🔴 複数選択(Shift + クリック / 範囲選択)→ 一括移動・整列・グループ', () => {
  function canvasWithPorts() {
    const host = board();
    const { d, events } = booted();
    const moves: Array<{ lid: string; moves: ReadonlyArray<{ line: number; x: number; y: number }> }> = [];
    const groups: Array<{ lid: string; lines: readonly number[] }> = [];
    offs.push(
      installCanvasViewport(document.body, {
        setDefault: () => {},
        movePlaces: (lid, m) => {
          moves.push({ lid, moves: m });
          d.dispatch({ type: 'MOVE_PLACES', lid, moves: m });
        },
        groupPlaces: (lid, lines) => groups.push({ lid, lines }),
      }),
    );
    offs.push(installPlaceDrag(document.body, d));
    syncBoardView(host, 'n1', BOARD);
    cmd('mode').click();
    const vp = sizeViewport(800, 600);
    cmd('zoom-reset').click();
    // 枠の左上を画面の (0, 0)、カメラを原点へ(ワールド = 画面)
    vp.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    cmd('fit').click();
    liveHostRect(host);
    events.length = 0;
    return { host, vp, d, events, moves, groups };
  }
  const p1 = (host: HTMLElement) => host.querySelector<HTMLElement>('#p1')!;
  const p2 = (host: HTMLElement) => host.querySelector<HTMLElement>('#p2')!;
  function shiftClick(el: HTMLElement, id = 21): void {
    const o = { bubbles: true, pointerId: id, button: 0, shiftKey: true, clientX: 5, clientY: 5 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
  }

  it('付箋が 1 枚も選ばれていない間は「整列 ▾」「グループにする」を出さない(1 段奥)', () => {
    const { host } = canvasWithPorts();
    expect(cmd('align').hidden).toBe(true);
    expect(cmd('group').hidden).toBe(true);
    expect(host.querySelectorAll('[data-pkc-canvas-selected]')).toHaveLength(0);
  });

  it('🔴 Shift + クリックで足す・外す。2 枚選ぶと「整列 ▾」が出る', () => {
    const { host } = canvasWithPorts();
    shiftClick(p1(host).querySelector('h3')!);
    expect(p1(host).getAttribute('data-pkc-canvas-selected')).toBe('1');
    expect(cmd('align').hidden).toBe(true);
    shiftClick(p2(host));
    expect(p2(host).getAttribute('data-pkc-canvas-selected')).toBe('1');
    expect(cmd('align').hidden).toBe(false);
    expect(cmd('group').hidden).toBe(false);
    shiftClick(p1(host));
    expect(p1(host).hasAttribute('data-pkc-canvas-selected')).toBe(false);
    expect(cmd('align').hidden).toBe(true);
  });

  it('🔴 Shift + 背景のドラッグで範囲選択(重なる付箋だけ)。背景のクリックで外す', () => {
    const { host, vp } = canvasWithPorts();
    const cam = canvasCameraOf(host)!;
    // ワールド (100, 30)〜(500, 300) ── p1(120..440)だけに重なる
    const s = { x: (100 - cam.x) * cam.zoom, y: (30 - cam.y) * cam.zoom };
    const e = { x: (500 - cam.x) * cam.zoom, y: (300 - cam.y) * cam.zoom };
    const o = { bubbles: true, pointerId: 31, button: 0, shiftKey: true };
    vp.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: s.x, clientY: s.y }));
    vp.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: e.x, clientY: e.y }));
    expect(vp.querySelector('[data-pkc-field="canvas-marquee"]')).not.toBeNull();
    vp.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: e.x, clientY: e.y }));
    expect(vp.querySelector('[data-pkc-field="canvas-marquee"]')).toBeNull();
    expect(p1(host).getAttribute('data-pkc-canvas-selected')).toBe('1');
    expect(p2(host).hasAttribute('data-pkc-canvas-selected')).toBe(false);
    // 背景を押しただけ(動かさない)で外れる
    const c = { bubbles: true, pointerId: 32, button: 0 };
    vp.dispatchEvent(new PointerEvent('pointerdown', { ...c, clientX: 700, clientY: 590 }));
    vp.dispatchEvent(new PointerEvent('pointerup', { ...c, clientX: 700, clientY: 590 }));
    expect(host.querySelectorAll('[data-pkc-canvas-selected]')).toHaveLength(0);
  });

  it('「選択」を押している間は、Shift なしの背景のドラッグも範囲選択(パンしない)', () => {
    const { host, vp } = canvasWithPorts();
    cmd('select').click();
    expect(cmd('select').getAttribute('aria-pressed')).toBe('true');
    const before = canvasCameraOf(host)!;
    const o = { bubbles: true, pointerId: 33, button: 0 };
    vp.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 1, clientY: 1 }));
    vp.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 799, clientY: 599 }));
    vp.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 799, clientY: 599 }));
    expect(canvasCameraOf(host)).toEqual(before);
    expect(host.querySelectorAll('[data-pkc-canvas-selected="1"]')).toHaveLength(2);
    cmd('select').click();
    expect(cmd('select').getAttribute('aria-pressed')).toBe('false');
  });

  it('Esc で選択を外す(何も選んでいなければ Esc を素通しにする)', () => {
    const { host, vp } = canvasWithPorts();
    shiftClick(p1(host));
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    vp.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(host.querySelectorAll('[data-pkc-canvas-selected]')).toHaveLength(0);
    const esc2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    vp.dispatchEvent(esc2);
    expect(esc2.defaultPrevented).toBe(false);
  });

  it('🔴 選んだ 1 枚の ⠿ を掴むと全員が動き、書くのは MOVE_PLACES 1 回(place-move-group)', () => {
    const { host, events } = canvasWithPorts();
    shiftClick(p1(host));
    shiftClick(p2(host));
    const z = canvasZoomOf(host);
    const grip = p1(host).querySelector<HTMLElement>('[data-pkc-field="place-grip"]')!;
    const o = { bubbles: true, pointerId: 41, button: 0 };
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 50 * z, clientY: 20 * z }));
    expect(p2(host).style.left).toBe('650px');
    document.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 50 * z, clientY: 20 * z }));
    const rewrites = events.filter((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]).toMatchObject({
      rewrite: {
        kind: 'place-move-group',
        moves: [
          { line: 0, x: 170, y: 60 },
          { line: 4, x: 650, y: 60 },
        ],
      },
    });
  });

  it('対照群: 選んでいない付箋を掴んでも 1 枚だけ動く(MOVE_PLACE)', () => {
    const { host, events } = canvasWithPorts();
    shiftClick(p2(host));
    const z = canvasZoomOf(host);
    const grip = p1(host).querySelector<HTMLElement>('[data-pkc-field="place-grip"]')!;
    const o = { bubbles: true, pointerId: 42, button: 0 };
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 50 * z, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 50 * z, clientY: 0 }));
    expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({
      rewrite: { kind: 'place-move', line: 0, x: 170, y: 40 },
    });
  });

  it('🔴 「整列 ▾ → 左揃え」は MOVE_PLACES 1 回。2 枚では等間隔が押せない', () => {
    const { host, events, moves } = canvasWithPorts();
    shiftClick(p1(host));
    shiftClick(p2(host));
    cmd('align').click();
    const menu = bar().querySelector('[data-pkc-field="canvas-align-menu"]')!;
    expect(menu).not.toBeNull();
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[data-pkc-canvas-align]')];
    expect(items.map((b) => b.textContent)).toEqual([
      '左揃え',
      '左右中央揃え',
      '右揃え',
      '上揃え',
      '上下中央揃え',
      '下揃え',
      '左右に等間隔',
      '上下に等間隔',
    ]);
    expect(items.filter((b) => b.disabled).map((b) => b.getAttribute('data-pkc-canvas-align'))).toEqual([
      'distribute-x',
      'distribute-y',
    ]);
    items[0]!.click();
    expect(bar().querySelector('[data-pkc-field="canvas-align-menu"]')).toBeNull();
    // 動くのは p2 だけ(p1 はもう左端)
    expect(moves).toEqual([{ lid: 'n1', moves: [{ line: 4, x: 120, y: 40 }] }]);
    const rewrites = events.filter((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]).toMatchObject({ rewrite: { kind: 'place-move-group', moves: [{ line: 4, x: 120, y: 40 }] } });
  });

  it('上揃えはすでに揃っていれば何も書かない(空の書込を出さない)', () => {
    const { host, moves } = canvasWithPorts();
    shiftClick(p1(host));
    shiftClick(p2(host));
    cmd('align').click();
    bar().querySelector<HTMLButtonElement>('[data-pkc-canvas-align="top"]')!.click();
    expect(moves).toEqual([]);
  });

  it('「グループにする」は選んだ付箋の開き行で GROUP_PLACES の口を呼ぶ', () => {
    const { host, groups } = canvasWithPorts();
    shiftClick(p1(host));
    shiftClick(p2(host));
    cmd('group').click();
    expect(groups).toEqual([{ lid: 'n1', lines: [0, 4] }]);
  });

  it('選択は描き直し(syncBoardView)の後も保ち、通常表示へ戻すと外れる', () => {
    const { host } = canvasWithPorts();
    shiftClick(p1(host));
    syncBoardView(host, 'n1', BOARD);
    expect(p1(host).getAttribute('data-pkc-canvas-selected')).toBe('1');
    cmd('mode').click();
    expect(host.querySelectorAll('[data-pkc-canvas-selected]')).toHaveLength(0);
  });
});

describe('🔴 手書き(描く面の生成・置く・終了時の破棄)', () => {
  function drawCanvas(opts: { blocked?: string | null; place?: (png: Blob, rect: unknown) => Promise<boolean> } = {}) {
    const host = board();
    const placed: Array<{ lid: string; png: Blob; rect: unknown }> = [];
    offs.push(
      installCanvasViewport(document.body, {
        setDefault: () => {},
        writeBlocked: () => opts.blocked ?? null,
        placeDrawing: async (lid, png, rect) => {
          placed.push({ lid, png, rect });
          return opts.place ? opts.place(png, rect) : true;
        },
      }),
    );
    syncBoardView(host, 'n1', BOARD);
    cmd('mode').click();
    const vp = sizeViewport(800, 600);
    vp.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    cmd('zoom-reset').click();
    liveHostRect(host);
    return { host, vp, placed };
  }
  const surfaceOf = (vp: HTMLElement) => vp.querySelector<HTMLCanvasElement>('[data-pkc-field="canvas-draw-surface"]');
  function stroke(el: HTMLElement, pts: Array<[number, number]>, id = 51): void {
    const o = { bubbles: true, pointerId: id, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: pts[0]![0], clientY: pts[0]![1] }));
    for (const [x, y] of pts.slice(1)) el.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x, clientY: y }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: pts.at(-1)![0], clientY: pts.at(-1)![1] }));
  }
  /** happy-dom は 2D の描画も PNG 化も持たない ── 呼ばれたことだけ記録する偽物を当てる。 */
  function fakeCanvas2d(): () => void {
    const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
    const had = { getContext: proto.getContext, toBlob: proto.toBlob };
    const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
    proto.getContext = function () {
      return ctx;
    };
    proto.toBlob = function (cb: (b: Blob | null) => void) {
      cb(new Blob(['png'], { type: 'image/png' }));
    };
    return () => {
      proto.getContext = had.getContext;
      proto.toBlob = had.toBlob;
    };
  }

  it('🔴 押すまで <canvas> は DOM に無い(定常コスト 0)', () => {
    const { vp } = drawCanvas();
    expect(vp.querySelector('canvas')).toBeNull();
    expect(cmd('draw').hidden).toBe(false);
    expect(cmd('draw').disabled).toBe(false);
  });

  it('書けないノート(編集中など)では押せず、理由を題に出す', () => {
    const { vp } = drawCanvas({ blocked: '編集中です' });
    expect(cmd('draw').disabled).toBe(true);
    expect(cmd('draw').title).toContain('編集中です');
    cmd('draw').click();
    expect(vp.querySelector('canvas')).toBeNull();
  });

  it('🔴 描いて「やめる」と、保存せずに <canvas> ごと DOM から外す', () => {
    const { host, vp, placed } = drawCanvas();
    cmd('draw').click();
    expect(cmd('draw').getAttribute('aria-pressed')).toBe('true');
    const surface = surfaceOf(vp)!;
    expect(surface).not.toBeNull();
    const bar2 = vp.querySelector('[data-pkc-field="canvas-draw-bar"]')!;
    expect(bar2.querySelectorAll('[data-pkc-draw-color]')).toHaveLength(4);
    expect(bar2.querySelectorAll('[data-pkc-draw-width]')).toHaveLength(3);
    stroke(surface, [[10, 10], [60, 40]]);
    expect(canvasDrawSession(host)!.strokes).toHaveLength(1);
    bar2.querySelector<HTMLButtonElement>('[data-pkc-draw-cmd="cancel"]')!.click();
    expect(vp.querySelector('canvas')).toBeNull();
    expect(vp.querySelector('[data-pkc-field="canvas-draw"]')).toBeNull();
    expect(canvasDrawSession(host)).toBeNull();
    expect(placed).toEqual([]);
    expect(cmd('draw').getAttribute('aria-pressed')).toBe('false');
  });

  it('Esc でも保存せずに閉じる(開いているノートへ Esc を渡さない)', () => {
    const { vp, placed } = drawCanvas();
    cmd('draw').click();
    let leaked = false;
    const spy = (): void => {
      leaked = true;
    };
    document.addEventListener('keydown', spy);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.removeEventListener('keydown', spy);
    expect(leaked).toBe(false);
    expect(vp.querySelector('canvas')).toBeNull();
    expect(placed).toEqual([]);
  });

  it('1 手戻す: 最後の線だけ消す。線が無ければ「ボードに置く」は押せない', () => {
    const { host, vp } = drawCanvas();
    cmd('draw').click();
    const bar2 = vp.querySelector('[data-pkc-field="canvas-draw-bar"]')!;
    const place = bar2.querySelector<HTMLButtonElement>('[data-pkc-draw-cmd="place"]')!;
    expect(place.disabled).toBe(true);
    stroke(surfaceOf(vp)!, [[10, 10], [20, 20]], 61);
    stroke(surfaceOf(vp)!, [[30, 30], [40, 40]], 62);
    expect(place.disabled).toBe(false);
    bar2.querySelector<HTMLButtonElement>('[data-pkc-draw-cmd="undo"]')!.click();
    expect(canvasDrawSession(host)!.strokes).toHaveLength(1);
  });

  it('🔴 「ボードに置く」: 描いた場所のワールド座標の四角と PNG を渡し、置けたら <canvas> を破棄する', async () => {
    const restore = fakeCanvas2d();
    try {
      const { host, vp, placed } = drawCanvas();
      // 倍率 2、カメラ (−100, −50)── 画面 (100, 100) はワールド (−50, 0)
      for (let i = 0; i < 3; i += 1) cmd('zoom-in').click();
      cmd('zoom-reset').click();
      cmd('draw').click();
      const session = canvasDrawSession(host)!;
      const bar2 = vp.querySelector('[data-pkc-field="canvas-draw-bar"]')!;
      bar2.querySelector<HTMLButtonElement>('[data-pkc-draw-width="8"]')!.click();
      bar2.querySelector<HTMLButtonElement>('[data-pkc-draw-color="#dc2626"]')!.click();
      const cam = canvasCameraOf(host)!;
      stroke(surfaceOf(vp)!, [[100, 100], [300, 200]]);
      expect(session.strokes[0]).toMatchObject({ color: '#dc2626', width: 8 });
      expect(session.strokes[0]!.points[0]).toEqual({ x: cam.x + 100 / cam.zoom, y: cam.y + 100 / cam.zoom });
      await session.place();
      expect(placed).toHaveLength(1);
      expect(placed[0]!.lid).toBe('n1');
      expect(placed[0]!.png.type).toBe('image/png');
      const wx = cam.x + 100 / cam.zoom;
      const wy = cam.y + 100 / cam.zoom;
      expect(placed[0]!.rect).toEqual({
        x: Math.floor(wx - 4 - 12),
        y: Math.floor(wy - 4 - 12),
        w: Math.ceil(wx + 200 / cam.zoom + 4 + 12) - Math.floor(wx - 4 - 12),
        h: Math.ceil(wy + 100 / cam.zoom + 4 + 12) - Math.floor(wy - 4 - 12),
      });
      expect(vp.querySelector('canvas')).toBeNull();
      expect(canvasDrawSession(host)).toBeNull();
    } finally {
      restore();
    }
  });

  it('🔴 器が枠の左上からずれていても(外から余白が当たる)、描いた所のワールド座標で置く(実ブラウザで踏んだ 16px のずれ)', async () => {
    const restore = fakeCanvas2d();
    try {
      const { host, vp, placed } = drawCanvas();
      liveHostRect(host, 16); // 器だけが 16px 下にある(カメラの式では見えないずれ)
      cmd('draw').click();
      stroke(surfaceOf(vp)!, [[200, 216], [260, 266]]);
      await canvasDrawSession(host)!.place();
      const cam = canvasCameraOf(host)!;
      // 器の実際の位置から引く: ワールド y = (216 − 器の上端) / 倍率
      const wy = (216 - (-cam.y * cam.zoom + 16)) / cam.zoom;
      expect((placed[0]!.rect as { y: number }).y).toBe(Math.floor(wy - 2 - 12));
    } finally {
      restore();
    }
  });

  it('置けなかった(口が false)なら面を閉じない(描いた線を失わせない)', async () => {
    const restore = fakeCanvas2d();
    try {
      const { host, vp } = drawCanvas({ place: async () => false });
      cmd('draw').click();
      stroke(surfaceOf(vp)!, [[10, 10], [50, 50]]);
      await canvasDrawSession(host)!.place();
      expect(surfaceOf(vp)).not.toBeNull();
      expect(canvasDrawSession(host)!.strokes).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('🔴 キャンバスを閉じる(通常表示へ戻す)と、手書きの面も <canvas> ごと外す', () => {
    const { vp } = drawCanvas();
    cmd('draw').click();
    expect(vp.querySelector('canvas')).not.toBeNull();
    cmd('mode').click();
    expect(document.querySelector('[data-pkc-field="canvas-draw-surface"]')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
  });
});
