/** @vitest-environment happy-dom */
/**
 * 🔴 **関係グラフのズーム・パンと「ボードで開く」**(v4.0 Phase 2 / PR-10、ビジョン 2-B。`src/adapter/ui/render/graph.ts`)。
 *
 * 守る主張:
 * 1. `Ctrl + ホイール` で拡大・縮小、ドラッグで移動(図の transform だけが変わる)。バーの − / 倍率 / + も同じ計算
 * 2. 🔴 節点の押下(`select-entry`)を奪わない ── `GRAPH_DRAG_SLOP` 未満の動きはクリックのまま、越えたら離した後の click を捨てる
 * 3. ズームは描き直し(見方の変更)の後も保つ
 * 4. 「ボードで開く」は節点が 1 件以上のとき押せ、押すと `layout: canvas` のボードのノートを作って開く(編集には入らない)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GRAPH_DRAG_SLOP, GraphRenderer, graphViewOf } from '../../src/adapter/ui/render/graph';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { isCanvasLayout } from '../../src/features/markdown/document-globals';

const meta = (lid: string) =>
  ({ lid, title: `題${lid}`, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null }) as never;
const rel = (a: string, b: string) => ({ id: `${a}${b}`, fromLid: a, toLid: b, kind: 'semantic' }) as never;

function stateOf(extra: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    entryMetas: new Map(['a', 'b', 'c'].map((l) => [l, meta(l)])),
    relations: [rel('a', 'b'), rel('b', 'c')],
    selectedLid: 'a',
    ...extra,
  } as AppState;
}

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  host.remove();
});

function mounted(state = stateOf()) {
  const r = new GraphRenderer(host);
  r.render(state);
  const box = host.querySelector<HTMLElement>('[data-pkc-field="graph-body"]')!;
  const vp = () => host.querySelector<HTMLElement>('[data-pkc-field="graph-viewport"]')!;
  Object.defineProperty(vp(), 'clientWidth', { configurable: true, value: 400 });
  Object.defineProperty(vp(), 'clientHeight', { configurable: true, value: 328 });
  vp().getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 328, width: 400, height: 328, x: 0, y: 0, toJSON: () => ({}) });
  const fig = () => host.querySelector<HTMLElement>('[data-pkc-field="graph-map"]')!;
  const zoomBtn = (k: string) => host.querySelector<HTMLButtonElement>(`[data-pkc-graph-zoom="${k}"]`)!;
  return { r, box, fig, zoomBtn };
}

describe('🔴 関係グラフのズーム・パン', () => {
  it('最初は 100%(transform なし)、− / 倍率 / + がバーにある', () => {
    const { fig, zoomBtn } = mounted();
    expect(fig().style.transform).toBe('');
    expect(zoomBtn('reset').textContent).toBe('100%');
    expect(zoomBtn('in')).not.toBeNull();
    expect(zoomBtn('out')).not.toBeNull();
  });

  it('🔴 Ctrl + ホイールで拡大(ポインタの下を動かさない)/ ホイールだけは横取りしない', () => {
    const { r, box, fig, zoomBtn } = mounted();
    const plain = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    fig().dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(r.camera.zoom).toBe(1);
    // ⚠ happy-dom の WheelEvent は ctrlKey / clientX を受けない ── 実物と同じ値を event に置く(canvas-viewport.test と同じ作法)
    const ctrl = new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true });
    for (const [k, v] of [['ctrlKey', true], ['clientX', 100], ['clientY', 100]] as const)
      Object.defineProperty(ctrl, k, { value: v });
    fig().dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    const cam = r.camera;
    expect(cam.zoom).toBeGreaterThan(1.3);
    // 不動点: 画面 (100, 100) はワールド (100, 100) のまま
    expect((100 - cam.x) * cam.zoom).toBeCloseTo(100);
    expect((100 - cam.y) * cam.zoom).toBeCloseTo(100);
    expect(fig().style.transform).toContain('scale(');
    expect(zoomBtn('reset').textContent).toBe(`${Math.round(cam.zoom * 100)}%`);
    void box;
  });

  it('バーの + / − / 倍率(押すと 100% に戻す)', () => {
    const { r, zoomBtn, fig } = mounted();
    zoomBtn('in').click();
    expect(r.camera.zoom).toBeCloseTo(1.25);
    zoomBtn('out').click();
    zoomBtn('out').click();
    expect(r.camera.zoom).toBeCloseTo(0.8);
    zoomBtn('reset').click();
    expect(r.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(fig().style.transform).toBe('');
  });

  it('🔴 背景のドラッグで移動し、離した後の click を捨てる', () => {
    const { r, fig } = mounted();
    const o = { bubbles: true, pointerId: 1, button: 0 };
    fig().dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 50, clientY: 50 }));
    fig().dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 90, clientY: 70 }));
    fig().dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 90, clientY: 70 }));
    expect(r.camera).toEqual({ x: -40, y: -20, zoom: 1 });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    fig().dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it('🔴 節点のクリックは奪わない(DRAG_SLOP 未満の揺れはクリックのまま、select-entry が届く)', () => {
    const { r } = mounted();
    const node = host.querySelector<HTMLElement>('[data-pkc-action="select-entry"][data-pkc-entry="b"]')!;
    let reached = 0;
    document.body.addEventListener('click', (e) => {
      if ((e.target as Element).closest('[data-pkc-action="select-entry"]') === node) reached += 1;
    });
    const o = { bubbles: true, pointerId: 2, button: 0 };
    node.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 10, clientY: 10 }));
    node.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 10 + GRAPH_DRAG_SLOP - 1, clientY: 10 }));
    node.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 10 + GRAPH_DRAG_SLOP - 1, clientY: 10 }));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    node.dispatchEvent(click);
    expect(reached).toBe(1);
    expect(click.defaultPrevented).toBe(false);
    expect(r.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    // 対照: 節点から境目を越えてドラッグしたら移動になり、その click は捨てる
    node.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 10, clientY: 10 }));
    node.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 10 + GRAPH_DRAG_SLOP + 20, clientY: 10 }));
    node.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 10 + GRAPH_DRAG_SLOP + 20, clientY: 10 }));
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(reached).toBe(1);
    expect(r.camera.x).toBe(-(GRAPH_DRAG_SLOP + 20));
  });

  it('ズームは描き直し(見方の変更)の後も保つ', () => {
    const { r, zoomBtn, fig } = mounted();
    zoomBtn('in').click();
    r.render(reduce(stateOf(), { type: 'SET_GRAPH_VIEW', depth: 3 }).state);
    expect(r.camera.zoom).toBeCloseTo(1.25);
    expect(fig().style.transform).toContain('scale(1.25)');
    expect(zoomBtn('reset').textContent).toBe('125%');
  });
});

describe('🔴 関係グラフ → ボードで開く', () => {
  it('節点があれば押せる / 図にならない見方では押せない', () => {
    mounted();
    expect(host.querySelector<HTMLButtonElement>('[data-pkc-action="graph-open-board"]')!.disabled).toBe(false);
    const h2 = document.createElement('div');
    document.body.append(h2);
    new GraphRenderer(h2).render(stateOf({ selectedLid: null }));
    expect(h2.querySelector<HTMLButtonElement>('[data-pkc-action="graph-open-board"]')!.disabled).toBe(true);
  });

  it('graphViewOf は描画と同じ図(節点の並び)を返す', () => {
    mounted();
    const drawn = [...host.querySelectorAll('[data-pkc-action="select-entry"]')].map((n) => n.getAttribute('data-pkc-entry'));
    expect(graphViewOf(stateOf())!.nodes.map((n) => n.lid)).toEqual(drawn);
    expect(graphViewOf(stateOf({ selectedLid: null }))).toBeNull();
  });

  it('🔴 押すと layout: canvas のボードのノートを作って開く(全ノードが entry= の付箋・全エッジが線)', () => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a'), meta('b'), meta('c')], relations: [rel('a', 'b'), rel('b', 'c')] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    const created: Array<Record<string, unknown>> = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = ((a: { type: string }) => {
      if (a.type === 'CREATE_ENTRY') created.push(a as never);
      return orig(a as never);
    }) as typeof d.dispatch;
    bindActions(host, d);
    const r = new GraphRenderer(host);
    r.render(d.getState());
    host.querySelector<HTMLButtonElement>('[data-pkc-action="graph-open-board"]')!.click();
    expect(created).toHaveLength(1);
    const c = created[0]!;
    expect(c).toMatchObject({ archetype: 'text', title: '関係グラフのボード', edit: false });
    const body = String(c.body);
    expect(isCanvasLayout(body)).toBe(true);
    expect(body.match(/entry=(\w+)/g)!.sort()).toEqual(['entry=a', 'entry=b', 'entry=c']);
    expect(body.match(/\.pkc-line/g)).toHaveLength(2);
    // 作ったノートを選んで開く
    expect(d.getState().selectedLid).toBe(c.lid);
    expect(d.getState().entryMetas.get(String(c.lid))?.title).toBe('関係グラフのボード');
  });

  it('🔴 左のペインの「グラフ」タブでズームのボタン・図の背景を押しても、読んでいるノートを閉じない', () => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a'), meta('b')], relations: [rel('a', 'b')] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    const browse = document.createElement('div');
    browse.setAttribute('data-pkc-region', 'browse-host');
    const pane = document.createElement('div');
    pane.setAttribute('data-pkc-browse-pane', 'graph');
    const other = document.createElement('div');
    other.setAttribute('data-pkc-browse-pane', 'filer');
    browse.append(pane, other);
    host.append(browse);
    bindActions(host, d);
    new GraphRenderer(pane).render(d.getState());
    pane.querySelector<HTMLButtonElement>('[data-pkc-graph-zoom="in"]')!.click();
    pane.querySelector<HTMLElement>('[data-pkc-field="graph-map"]')!.click();
    expect(d.getState().selectedLid).toBe('a');
    // 対照群: 同じ左のペインでも、ほかのタブの何も無い所を押すと閉じる(今までどおり)
    other.click();
    expect(d.getState().selectedLid).toBeNull();
  });

  it('編集中は作らず、理由を出す', () => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a'), meta('b')], relations: [rel('a', 'b')] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: 'x' });
    d.dispatch({ type: 'START_EDIT' } as never);
    bindActions(host, d);
    new GraphRenderer(host).render(d.getState());
    const before = d.getState().entryMetas.size;
    host.querySelector<HTMLButtonElement>('[data-pkc-action="graph-open-board"]')!.click();
    expect(d.getState().phase).toBe('editing');
    expect(d.getState().entryMetas.size).toBe(before);
    expect(d.getState().error).toContain('ボードを作ってください');
  });
});
