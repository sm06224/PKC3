/** @vitest-environment happy-dom */
/**
 * 🔴 **手書きの退避先: 左の列の「手書き」タブ**(#1448。CLAUDE.md §2-10)。
 *
 * 別ウィンドウ(「画像に描き込む」「手書きして置く…」)が塞がれたとき、中央の本文を奪わず、**同じ道具**を左のタブに出す。
 *
 * 1. タブ: 描いている間だけ出る / 開くと選ばれ、閉じると前のタブへ戻る(別のタブへ移っていたらそのまま)
 * 2. 面: 窓と同じ部品が面の中に組まれ、描ける・保存できる・手放す。Ctrl+Z は面の中だけ(本体の操作を奪わない)
 * 3. 段取り: 窓が開けたら窓 / 開けなければタブ(知らせを出す)/ 退避先が無い環境は従来どおり断る / 面は 1 枚
 * 4. 描きかけは本体の「離れますか」へ届く(`onDirty`)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openImageDrawInPane,
  type DrawPane,
  type ImageDrawBitmap,
  type ImageDrawWindow,
  type ImageDrawWindowDeps,
} from '../../src/adapter/platform/image-draw-window';
import { createDrawPane } from '../../src/adapter/ui/render/draw-pane';
import {
  createImageDrawer,
  IMAGE_DRAW_PANE_BUSY_TEXT,
  IMAGE_DRAW_PANE_NOTICE,
  IMAGE_DRAW_POPUP_BLOCKED_TEXT,
} from '../../src/adapter/ui/actions/image-draw';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import type { BrowseMode } from '../../src/adapter/ui/render/browse-mode';

beforeEach(() => {
  const ctx = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    arc: () => undefined,
    stroke: () => undefined,
    fill: () => undefined,
    strokeRect: () => undefined,
    font: '',
    textBaseline: 'alphabetic',
    fillText: () => undefined,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => undefined,
    clearRect: () => undefined,
    drawImage: () => undefined,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(((cb: BlobCallback) => {
    cb(new Blob([new Uint8Array([9])], { type: 'image/png' }));
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.textContent = '';
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

function ptr(target: HTMLElement, type: string, p: { id?: number; x?: number; y?: number }): void {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(ev, {
    pointerId: { value: p.id ?? 1 },
    pointerType: { value: 'mouse' },
    button: { value: 0 },
    clientX: { value: p.x ?? 0 },
    clientY: { value: p.y ?? 0 },
  });
  target.dispatchEvent(ev);
}

describe('手書きのタブ(出し入れ)', () => {
  function rig(start: BrowseMode = 'schedule') {
    const root = document.createElement('div');
    document.body.append(root);
    let mode: BrowseMode = start;
    const tab: boolean[] = [];
    const selected: BrowseMode[] = [];
    const pane = createDrawPane({
      root: document.createElement('div'),
      setTab: (v) => void tab.push(v),
      current: () => mode,
      select: (m) => {
        mode = m;
        selected.push(m);
      },
    });
    return { pane, tab, selected, now: () => mode, move: (m: BrowseMode) => (mode = m) };
  }

  it('開くとタブが出て「手書き」が選ばれ、閉じるとタブが畳まれて前のタブへ戻る', () => {
    const r = rig('schedule');
    r.pane.enter();
    expect(r.tab).toEqual([true]);
    expect(r.now()).toBe('draw');
    r.pane.leave();
    expect(r.tab).toEqual([true, false]);
    expect(r.now(), '前に見ていたタブへ戻っていない').toBe('schedule');
  });

  it('描いている途中でもう一度開くと(手前に出す)、戻り先は「手書き」にならない', () => {
    const r = rig('contacts');
    r.pane.enter();
    r.pane.enter();
    r.pane.leave();
    expect(r.now()).toBe('contacts');
  });

  it('描いている間に別のタブへ移っていたら、閉じても勝手に戻さない', () => {
    const r = rig('schedule');
    r.pane.enter();
    r.move('contacts');
    r.pane.leave();
    expect(r.now()).toBe('contacts');
    expect(r.selected, '手書きを見ていないのに選び直した').toEqual(['draw']);
  });

  it('戻り先が分からなければフォルダ', () => {
    const r = rig('draw');
    r.pane.enter();
    r.pane.leave();
    expect(r.now()).toBe('filer');
  });
});

describe('手書きのタブ(BrowseRouter とタブの列)', () => {
  it('🔴 「手書き」のタブは普段は隠れ、setDrawTab で出し入れできる / 面の器も在る', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const router = new BrowseRouter(regions.sidebar, regions.browseHost);
    const tab = root.querySelector<HTMLElement>('[data-pkc-browse="draw"]')!;
    expect(tab, '手書きのタブがタブの列に無い').not.toBeNull();
    expect(tab.hidden, '普段から手書きのタブが出ている').toBe(true);
    router.setDrawTab(true);
    expect(tab.hidden).toBe(false);
    router.setDrawTab(false);
    expect(tab.hidden).toBe(true);
    expect(router.drawPaneRoot().getAttribute('data-pkc-browse-pane')).toBe('draw');
    // 他のタブは出たまま(手書きの追加で隠れていない)
    const others = [...root.querySelectorAll<HTMLElement>('[data-pkc-action="set-browse"]')].filter((b) => b.getAttribute('data-pkc-browse') !== 'draw');
    expect(others.length).toBeGreaterThanOrEqual(8);
    expect(others.every((b) => !b.hidden)).toBe(true);
  });
});

describe('手書きのタブ(面の中の道具)', () => {
  function setup(opts: { save?: () => Promise<{ ok: true } | { ok: false; message: string }>; onDirty?: (d: boolean) => void } = {}) {
    const root = document.createElement('div');
    document.body.append(root);
    const events: string[] = [];
    const pane: DrawPane = {
      root,
      enter: () => void events.push('enter'),
      leave: () => void events.push('leave'),
    };
    const bitmap = { width: 100, height: 50, close: vi.fn() } satisfies ImageDrawBitmap;
    const onClosed = vi.fn();
    const win = openImageDrawInPane(pane, {
      title: '手書き',
      windowName: 'pkc3-draw-blank-x',
      onClosed,
      ...(opts.onDirty === undefined ? {} : { onDirty: opts.onDirty }),
      createBitmap: async () => bitmap,
    });
    const saves: Blob[] = [];
    return {
      root,
      events,
      win,
      bitmap,
      onClosed,
      saves,
      start: () =>
        win.start(new Blob([new Uint8Array(4)]), async (png) => {
          saves.push(png);
          return opts.save ? opts.save() : { ok: true };
        }),
      q: (f: string): HTMLElement => root.querySelector<HTMLElement>(`[data-pkc-field="${f}"]`)!,
    };
  }

  it('🔴 開くとタブが出て、読み込みの間は案内が出る。組み終わると窓と同じ道具が面の中に並ぶ(窓の番人の script は付けない)', async () => {
    const s = setup();
    expect(s.events).toEqual(['enter']);
    expect(s.q('image-draw-loading').textContent).toContain('読み込んでいます');
    await s.start();
    for (const f of ['image-draw-bar', 'image-draw-canvas', 'image-draw-save', 'image-draw-cancel', 'image-draw-undo', 'image-draw-tool-pen'])
      expect(s.q(f), `${f} が面に無い`).not.toBeNull();
    expect(s.root.querySelector('script'), '別ウィンドウ専用の番人が面に入っている').toBeNull();
  });

  it('🔴 描いて保存すると、保存が走り、タブが畳まれ、手放される(画像と台)', async () => {
    const s = setup();
    await s.start();
    const canvas = s.q('image-draw-canvas') as HTMLCanvasElement;
    expect((s.q('image-draw-save') as HTMLButtonElement).disabled, '線が無いのに保存できる').toBe(true);
    ptr(canvas, 'pointerdown', { x: 5, y: 5 });
    ptr(canvas, 'pointermove', { x: 20, y: 20 });
    ptr(canvas, 'pointerup', { x: 20, y: 20 });
    expect((s.q('image-draw-save') as HTMLButtonElement).disabled).toBe(false);
    s.q('image-draw-save').click();
    await flush();
    expect(s.saves).toHaveLength(1);
    expect(s.events).toEqual(['enter', 'leave']);
    expect(s.bitmap.close).toHaveBeenCalledTimes(1);
    expect(s.onClosed).toHaveBeenCalledTimes(1);
    expect(s.win.closed).toBe(true);
    expect(s.root.querySelector('canvas'), '閉じた後も面に台が残っている').toBeNull();
  });

  it('保存を断られたら、面も線も残る(押し直せる)', async () => {
    const s = setup({ save: async () => ({ ok: false, message: '別の保存の最中です' }) });
    await s.start();
    const canvas = s.q('image-draw-canvas') as HTMLCanvasElement;
    ptr(canvas, 'pointerdown', { x: 5, y: 5 });
    ptr(canvas, 'pointerup', { x: 20, y: 20 });
    s.q('image-draw-save').click();
    await flush();
    expect(s.events).toEqual(['enter']);
    expect(s.q('image-draw-status').textContent).toContain('別の保存の最中です');
    expect(s.win.closed).toBe(false);
  });

  it('描きかけは onDirty で本体へ届く(離れますか)/ 閉じると false に戻る', async () => {
    const dirty: boolean[] = [];
    const s = setup({ onDirty: (d) => void dirty.push(d) });
    await s.start();
    const canvas = s.q('image-draw-canvas') as HTMLCanvasElement;
    ptr(canvas, 'pointerdown', { x: 5, y: 5 });
    ptr(canvas, 'pointerup', { x: 20, y: 20 });
    expect(dirty).toEqual([true]);
    s.q('image-draw-cancel').click();
    s.q('image-draw-discard').click();
    await flush();
    expect(dirty).toEqual([true, false]);
    expect(s.events).toEqual(['enter', 'leave']);
  });

  it('🔴 Ctrl+Z は面の中だけで効く(本体のほかの操作を奪わない)', async () => {
    const s = setup();
    await s.start();
    const canvas = s.q('image-draw-canvas') as HTMLCanvasElement;
    ptr(canvas, 'pointerdown', { x: 5, y: 5 });
    ptr(canvas, 'pointerup', { x: 20, y: 20 });
    const undo = s.q('image-draw-undo') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    // 面の外(本体)で押しても取り消されない
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(undo.disabled, '本体の Ctrl+Z で線が消えた').toBe(false);
    // 面の中なら取り消される
    s.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(undo.disabled).toBe(true);
  });

  it('読み込めない画像: 理由と「閉じる」が出て、閉じるとタブが畳まれる', async () => {
    const s = setup();
    s.win.fail('画像の中身が見つかりませんでした');
    expect(s.q('image-draw-loading').textContent).toContain('見つかりませんでした');
    s.q('image-draw-close').click();
    expect(s.events).toEqual(['enter', 'leave']);
  });
});

describe('手書きの段取り(窓 → タブの退避)', () => {
  const meta = {
    lid: 'board',
    title: 'board',
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };

  function harness(over: { popup?: boolean; withPane?: boolean } = {}) {
    const dispatcher = new Dispatcher({
      ...initialState,
      phase: 'ready',
      entryMetas: new Map([['board', meta]]),
      selectedLid: 'board',
    } as AppState);
    const opened: string[] = [];
    const paneOpened: string[] = [];
    const wins: Array<{ closed: boolean }> = [];
    const mk = (kind: string, d: ImageDrawWindowDeps): ImageDrawWindow => {
      const w = { closed: false };
      wins.push(w);
      (kind === 'popup' ? opened : paneOpened).push(d.windowName);
      return {
        get closed() {
          return w.closed;
        },
        focus: () => undefined,
        close: () => {
          w.closed = true;
        },
        start: async () => undefined,
        fail: () => undefined,
      };
    };
    const notes: string[] = [];
    const errors: string[] = [];
    dispatcher.onState((s) => {
      if (s.notice !== null && !notes.includes(s.notice)) notes.push(s.notice);
      if (s.error !== null && !errors.includes(s.error)) errors.push(s.error);
    });
    const drawer = createImageDrawer({
      dispatcher,
      readBlob: async () => null,
      parentOf: () => null,
      attach: async () => null,
      openWindow: (d) => (over.popup === true ? mk('popup', d) : null),
      ...(over.withPane === false ? {} : { openPane: (d: ImageDrawWindowDeps) => mk('pane', d) }),
      notify: () => undefined,
      blank: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }),
    });
    return { drawer, opened, paneOpened, notes, errors, wins };
  }

  it('🔴 窓が開けるなら窓 / 開けなければタブ(知らせを出す)', async () => {
    const a = harness({ popup: true });
    await a.drawer.runBlank('board');
    expect(a.opened).toEqual(['pkc3-draw-blank-board']);
    expect(a.paneOpened).toEqual([]);
    const b = harness({ popup: false });
    await b.drawer.runBlank('board');
    expect(b.opened).toEqual([]);
    expect(b.paneOpened).toEqual(['pkc3-draw-blank-board']);
    expect(b.notes).toContain(IMAGE_DRAW_PANE_NOTICE);
  });

  it('既存の「画像に描き込む」も同じ退避を通る', async () => {
    const h = harness({ popup: false });
    await h.drawer.run('k1', 'a.png', 'image/png', 'board');
    expect(h.paneOpened).toEqual(['pkc3-draw-k1-board']);
  });

  it('退避先が無い環境は従来どおり、ポップアップを許可する案内で断る', async () => {
    const h = harness({ popup: false, withPane: false });
    await h.drawer.runBlank('board');
    expect(h.errors).toContain(IMAGE_DRAW_POPUP_BLOCKED_TEXT);
    expect(h.paneOpened).toEqual([]);
  });

  it('🔴 面は 1 枚: 別の絵を描いている途中の 2 枚目は断る / 同じ絵なら手前に出すだけ / 閉じれば次を開ける', async () => {
    const h = harness({ popup: false });
    await h.drawer.runBlank('board');
    await h.drawer.runBlank('other');
    expect(h.errors).toContain(IMAGE_DRAW_PANE_BUSY_TEXT);
    expect(h.paneOpened).toEqual(['pkc3-draw-blank-board']);
    await h.drawer.runBlank('board');
    expect(h.paneOpened, '同じ絵の押し直しで開き直した').toEqual(['pkc3-draw-blank-board']);
    h.wins[0]!.closed = true;
    await h.drawer.runBlank('other');
    expect(h.paneOpened).toEqual(['pkc3-draw-blank-board', 'pkc3-draw-blank-other']);
  });
});
