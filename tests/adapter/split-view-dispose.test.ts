/** @vitest-environment happy-dom */
/**
 * 🔴 **外れた留めた枠が、document の購読・ResizeObserver・借りた ObjectURL を残さない**(#1087 L1-L3)。
 *
 * ⚠ 直す前は `SplitView.sync` が `host.remove()` と `frames.delete()` だけで、枠の `DetailRenderer` を
 *   捨てていなかった ── 外すたびに `selectionchange` の購読・目次の click/keydown・ResizeObserver 1 つ・
 *   借りた URL が積み残った。
 * 🔑 観測点は「外した後の数が、始める前に戻る」(個体ではなく差し引き)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { CenterRouter } from '../../src/adapter/ui/render/center';

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
}

const liveUrls = new Set<string>();
/** document に付いている (type, listener) の組。同じ組の二重登録は 1 つ(DOM の規則)。 */
const liveListeners = new Set<string>();
const liveRO = new Set<object>();
const fired: (() => void)[] = [];
const g = globalThis as { ResizeObserver?: unknown };
const hadRO = 'ResizeObserver' in g;
const prevRO = g.ResizeObserver;

function instrument(): void {
  let seq = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const u = `blob:test/${String((seq += 1))}`;
    liveUrls.add(u);
    return u;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => {
    liveUrls.delete(u);
  });
  const ids = new WeakMap<object, number>();
  let n = 0;
  const id = (l: unknown): string => {
    if (typeof l !== 'function') return 'obj';
    let v = ids.get(l);
    if (v === undefined) ids.set(l, (v = n += 1));
    return String(v);
  };
  const add = document.addEventListener.bind(document);
  const rm = document.removeEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation(((t: string, l: never, o?: never) => {
    liveListeners.add(`${t}#${id(l)}`);
    add(t, l, o);
  }) as never);
  vi.spyOn(document, 'removeEventListener').mockImplementation(((t: string, l: never, o?: never) => {
    liveListeners.delete(`${t}#${id(l)}`);
    rm(t, l, o);
  }) as never);
  g.ResizeObserver = class {
    constructor(cb: () => void) {
      fired.push(cb);
      liveRO.add(this);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      liveRO.delete(this);
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (hadRO) g.ResizeObserver = prevRO;
  else delete g.ResizeObserver;
  liveUrls.clear();
  liveListeners.clear();
  liveRO.clear();
  fired.length = 0;
  document.body.textContent = '';
});

const lender = {
  lend: async () => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(8)], { type: 'image/png' }));
    return { url, dispose: () => URL.revokeObjectURL(url) };
  },
  getBlob: async () => new Blob([new Uint8Array(8)], { type: 'image/png' }),
  listMimes: async () => new Map<string, string>(),
};
const body = (i: number): string => `# N${String(i)}\n\n## 小見出し\n\n![a](asset:k1)\n\n本文\n`;

async function boot(): Promise<{ root: HTMLElement; d: Dispatcher; pane: (w: number) => void }> {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-region', 'detail');
  document.body.append(root);
  const center = new CenterRouter(root, undefined, lender as never, undefined, undefined);
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: ['m', 'a', 'b', 'c'].map((lid) => ({ lid, title: lid, archetype: 'text' })) as never,
    relations: [],
  });
  d.onState((s) => center.render(s));
  const paneEl = root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]')!;
  let w = 1600;
  paneEl.getBoundingClientRect = () => ({ width: w, height: 300 }) as DOMRect;
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'm' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'm', body: body(0) });
  await settle();
  return {
    root,
    d,
    pane: (x) => {
      w = x;
    },
  };
}

async function pin(d: Dispatcher, lid: string): Promise<void> {
  d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid });
  d.dispatch({ type: 'SPLIT_BODY_LOADED', lid, body: body(1) });
  await settle();
}

const counts = (): { listeners: number; ro: number; urls: number } => ({
  listeners: liveListeners.size,
  ro: liveRO.size,
  urls: liveUrls.size,
});

describe('外れた留めた枠は借りた物を返す(#1087)', () => {
  it('🔴 × で外す(UNPIN)を繰り返しても、購読・見張り・URL が増えない', async () => {
    instrument();
    const { root, d } = await boot();
    const base = counts();
    await pin(d, 'a');
    const during = counts();
    // 対照群: 留めている間は確かに増えている(数えている物が動くこと)
    expect(root.querySelectorAll('[data-pkc-split-lid]').length, '枠が立っていない').toBe(1);
    expect(during.listeners, '購読が増えない(台が空振り)').toBeGreaterThan(base.listeners);
    expect(during.urls, 'URL を借りていない(台が空振り)').toBeGreaterThan(base.urls);
    d.dispatch({ type: 'UNPIN_SPLIT_ENTRY', lid: 'a' });
    await settle();
    const settled = counts();
    for (let i = 0; i < 5; i += 1) {
      await pin(d, 'a');
      d.dispatch({ type: 'UNPIN_SPLIT_ENTRY', lid: 'a' });
      await settle();
    }
    expect(counts()).toEqual(settled);
    expect(settled.listeners, '外した枠の購読が残っている').toBe(base.listeners);
    expect(settled.urls, '外した枠の URL が残っている').toBe(base.urls);
    expect(settled.ro, '外した枠の ResizeObserver が残っている').toBe(base.ro);
  });

  it('🔴 全部降ろす(CLEAR_SPLIT)でも返す', async () => {
    instrument();
    const { d } = await boot();
    const base = counts();
    await pin(d, 'a');
    await pin(d, 'b');
    expect(counts().listeners, '台の空振り').toBeGreaterThan(base.listeners);
    d.dispatch({ type: 'CLEAR_SPLIT' });
    await settle();
    expect(counts()).toEqual(base);
  });

  it('🔴 窓を狭めて畳まれた枠も返す(refit)', async () => {
    instrument();
    const { root, d, pane } = await boot();
    const base = counts();
    await pin(d, 'a');
    expect(root.querySelectorAll('[data-pkc-split-lid]').length, '台の空振り(広いのに畳んだ)').toBe(1);
    expect(fired.length, '見張りが付いていない').toBeGreaterThan(0);
    pane(1100); // 1 枠しか入らない ── dispatch は起こさず、見張りだけを鳴らす
    for (const cb of [...fired]) cb();
    await settle();
    expect(root.querySelectorAll('[data-pkc-split-lid]').length, '畳まれていない').toBe(0);
    expect(counts()).toEqual(base);
  });

  it('⚠ 主の面は捨てない(留めて外しても、主の本文の画像と URL は生きている)', async () => {
    instrument();
    const { root, d } = await boot();
    const mainImgs = (): number => root.querySelectorAll('[data-pkc-field="detail-body"] img').length;
    const before = mainImgs();
    expect(before, '主の画像が無い(台の空振り)').toBeGreaterThan(0);
    const urlsBefore = counts().urls;
    await pin(d, 'a');
    d.dispatch({ type: 'UNPIN_SPLIT_ENTRY', lid: 'a' });
    await settle();
    expect(mainImgs()).toBe(before);
    expect(counts().urls, '主の URL まで返した').toBe(urlsBefore);
  });
});
