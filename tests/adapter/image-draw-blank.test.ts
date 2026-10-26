/** @vitest-environment happy-dom */
/**
 * 🔴 **白紙に手書きして、板に置く**(#1448)。
 *
 * 守る主張:
 * 1. 窓は押した瞬間(同期)に開き、白紙は窓が開いてから作る / 白紙を作れなければ窓に理由を出す
 * 2. 保存すると新しい画像の添付が 1 件でき、名前は `手書き-日付-時分.png`、置き場は呼び出したノートと同じフォルダ、
 *    読んでいるノートを退かさない(`keepSelection`)
 * 3. 保存した添付の lid が `onSaved` に渡る(板の上では、それを付箋として置く)
 * 4. 同じノートで 2 度押すと窓は 1 枚(手前に出す)/ 白紙の口が無い環境は理由を言う
 * 5. 板の右クリックの「手書きして置く…」→ 窓 → 保存 → `ADD_PLACE`(entry=添付)の線が繋がる
 */
import { describe, expect, it, vi } from 'vitest';
import {
  blankDrawingName,
  createImageDrawer,
} from '../../src/adapter/ui/actions/image-draw';
import type { ImageDrawSaveResult, ImageDrawWindow } from '../../src/adapter/platform/image-draw-window';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { AttachItem } from '../../src/adapter/ui/actions/attach';

const meta = (lid: string, archetype = 'text'): EntryMeta => ({
  lid,
  title: lid,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

function harness(over: { blank?: () => Promise<Blob>; noBlank?: boolean; attachNull?: boolean } = {}) {
  const dispatcher = new Dispatcher({
    ...initialState,
    phase: 'ready',
    entryMetas: new Map([
      ['board', meta('board')],
      ['new', meta('new', 'attachment')],
    ]),
    selectedLid: 'board',
  } as AppState);
  const attached: Array<{ item: AttachItem; place: { parentLid: string | null; keepSelection: boolean } }> = [];
  const events: string[] = [];
  const failed: string[] = [];
  const saved: string[] = [];
  let saveFn: ((png: Blob) => Promise<ImageDrawSaveResult>) | null = null;
  let started: Blob | null = null;
  const opened: Array<{ title: string; windowName: string }> = [];
  const focus = vi.fn();
  let closed = false;
  const drawer = createImageDrawer({
    dispatcher,
    readBlob: async () => null,
    parentOf: (lid) => (lid === 'board' ? 'folderA' : null),
    attach: async (item, place) => {
      attached.push({ item, place });
      return over.attachNull === true ? null : { lid: 'new', assetKey: 'k2', mime: item.type, hash: 'h' };
    },
    openWindow: (deps) => {
      events.push('open');
      opened.push({ title: deps.title, windowName: deps.windowName });
      const win: ImageDrawWindow = {
        get closed() {
          return closed;
        },
        focus,
        close: () => {
          closed = true;
        },
        start: async (blob, save) => {
          started = blob;
          saveFn = save;
        },
        fail: (m) => void failed.push(m),
      };
      return win;
    },
    notify: () => {},
    ...(over.noBlank === true
      ? {}
      : {
          blank:
            over.blank ??
            (async () => {
              events.push('blank');
              return new Blob([new Uint8Array([9])], { type: 'image/png' });
            }),
        }),
    now: () => new Date(2026, 9, 26, 15, 40),
  });
  const errors: string[] = [];
  dispatcher.onState((s) => {
    if (s.error !== null && !errors.includes(s.error)) errors.push(s.error);
  });
  return {
    drawer,
    attached,
    events,
    failed,
    saved,
    errors,
    opened,
    focus,
    started: () => started,
    save: (b: Blob) => saveFn!(b),
  };
}

const png = (): Blob => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

describe('白紙から手書き #1448', () => {
  it('保存名は 手書き-日付-時分.png', () => {
    expect(blankDrawingName(new Date(2026, 0, 5, 9, 3))).toBe('手書き-20260105-0903.png');
  });

  it('窓を先に開き、その後で白紙を作って窓に渡す(窓を開くのを待たせない)', async () => {
    const h = harness();
    await h.drawer.runBlank('board');
    expect(h.events).toEqual(['open', 'blank']);
    expect(h.opened).toEqual([{ title: '手書き', windowName: 'pkc3-draw-blank-board' }]);
    expect(h.started(), '白紙が窓に渡っていない').not.toBeNull();
  });

  it('保存すると添付が 1 件でき、呼び出したノートと同じフォルダ・退かさない / onSaved に添付の lid', async () => {
    const h = harness();
    const onSaved = vi.fn();
    await h.drawer.runBlank('board', onSaved);
    expect(h.attached, '窓を開いただけでは作らない').toHaveLength(0);
    expect(await h.save(png())).toEqual({ ok: true });
    expect(h.attached).toHaveLength(1);
    expect(h.attached[0]!.item.name).toBe('手書き-20261026-1540.png');
    expect(h.attached[0]!.item.type).toBe('image/png');
    expect(h.attached[0]!.place).toEqual({ parentLid: 'folderA', keepSelection: true });
    expect(onSaved).toHaveBeenCalledWith('new');
  });

  it('保存できなかった回(添付にできない)は onSaved を呼ばない ── 板に存在しない添付を置かない', async () => {
    const h = harness({ attachNull: true });
    const onSaved = vi.fn();
    await h.drawer.runBlank('board', onSaved);
    const r = await h.save(png());
    expect(r.ok).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('白紙を作れなければ窓に理由を出す / 白紙の口が無い環境は理由を言う', async () => {
    const h = harness({ blank: async () => Promise.reject(new Error('canvas なし')) });
    await h.drawer.runBlank('board');
    expect(h.failed.join('')).toContain('白紙の画像を作れませんでした');
    const n = harness({ noBlank: true });
    await n.drawer.runBlank('board');
    expect(n.opened).toHaveLength(0);
    expect(n.errors.join('')).toContain('白紙から手書きできません');
  });

  it('同じノートで 2 度押すと窓は 1 枚(手前に出す)/ 別のノートなら別の窓', async () => {
    const h = harness();
    await h.drawer.runBlank('board');
    await h.drawer.runBlank('board');
    expect(h.opened).toHaveLength(1);
    expect(h.focus).toHaveBeenCalledTimes(1);
    await h.drawer.runBlank('other');
    expect(h.opened.map((o) => o.windowName)).toEqual(['pkc3-draw-blank-board', 'pkc3-draw-blank-other']);
  });
});
