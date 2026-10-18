/** @vitest-environment happy-dom */
/**
 * 🔴 **付箋を動かした・大きさ・色・形・回転を変えた直後の「元に戻す」**(依頼 118-2 / 236。Gemini の回答「推薦どおり」= 要る)。
 *
 * 観測点は「書込が履歴に版を積んだか(`checkpoint`)」と「画面の下の知らせ(`notice`)に、積まれた版へ戻す口(`restoreUndo`)が
 * 繋がったか」。対照群: 付箋の字を直す回は別の枝(既に積んでいる)・書いても変わらない回は何も出さない。
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert, EntryStamps } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { placeUndoNotice } from '../../src/features/markdown/place-undo-notice';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const meta: EntryMeta = {
  lid: 'n1',
  title: 't',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
};

const BOARD = [
  ':::format{#p1 .pkc-place x=10 y=10 w=200 h=100}',
  '大事な字',
  ':::',
  '',
  ':::format{#p2 .pkc-place x=300 y=10 w=200 h=100}',
  ':::',
  '',
].join('\n');

async function run(actions: Dispatchable[]): Promise<{ d: Dispatcher; revs: string[]; disk: string }> {
  const d = new Dispatcher();
  let disk = BOARD;
  const revs: string[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    // 積まれた版を、新しい順の番号つきで返す(書く前後の「いちばん新しい版」が変わったかを見る)
    listRevisionMetas: async () => revs.map((id, i) => ({ id, rev_order: i + 1 })) as never,
    getBody: async () => disk,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async (): Promise<EntryStamps> => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async (): Promise<EntryStamps> => stubStamps(),
    persistEntry: async (e: EntryUpsert, opts?: { checkpoint?: boolean }): Promise<EntryStamps> => {
      if (opts?.checkpoint === true) revs.push(`rev${String(revs.length + 1)}`);
      disk = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BOARD });
  for (const a of actions) {
    d.dispatch(a);
    await tick();
  }
  return { d, revs, disk };
}

describe('付箋を動かした直後の「元に戻す」(依頼 118-2 / 236)', () => {
  it('🔴 動かした直後は、知らせの隣から積んだ版へ戻せる(知らせと戻す先が対)', async () => {
    const { d, revs } = await run([{ type: 'MOVE_PLACE', lid: 'n1', line: 0, x: 50, y: 60 }]);
    expect(revs, '前の版を積んでいない(前提)').toEqual(['rev1']);
    const s = d.getState();
    expect(s.notice).toBe('付箋を動かしました');
    expect(s.restoreUndo).toEqual({ lid: 'n1', revId: 'rev1', notice: '付箋を動かしました' });
  });

  it('🔴 続けて動かすと、戻す先は直前の 1 手(新しい版)に替わる', async () => {
    const { d, revs } = await run([
      { type: 'MOVE_PLACE', lid: 'n1', line: 0, x: 50, y: 60 },
      { type: 'RESIZE_PLACE', lid: 'n1', line: 0, w: 220, h: 120 },
    ]);
    expect(revs).toEqual(['rev1', 'rev2']);
    expect(d.getState().restoreUndo).toEqual({ lid: 'n1', revId: 'rev2', notice: '付箋の大きさを変えました' });
  });

  it('色・形・前後も同じ(知らせの字は何をしたかで違う)', async () => {
    const cases: Array<[Dispatchable, string]> = [
      [{ type: 'SET_PLACE_STYLE', lid: 'n1', line: 0, style: { fill: '#ff0000' } }, '色を変えました'],
      [{ type: 'SET_PLACE_STYLE', lid: 'n1', line: 0, style: { rotate: 15 } }, '付箋の回転を変えました'],
      [{ type: 'SET_PLACE_SHAPE', lid: 'n1', line: 0, shape: 'diamond' }, '付箋の形を変えました'],
      [{ type: 'LOWER_PLACE', lid: 'n1', line: 4 }, '付箋を後ろへ送りました'],
    ];
    for (const [action, notice] of cases) {
      const { d } = await run([action]);
      expect(d.getState().restoreUndo?.notice, notice).toBe(notice);
    }
  });

  it('対照群: 付箋の字を直す回は、ここでは出さない(別の枝)/ 本文が変わらない回は何も出さない', async () => {
    const same = await run([{ type: 'MOVE_PLACE', lid: 'n1', line: 0, x: 10, y: 10 }]);
    expect(same.revs, '変わらないのに版を積んだ').toEqual([]);
    expect(same.d.getState().restoreUndo ?? null).toBeNull();
    const text = await run([{ type: 'SET_PLACE_TEXT', lid: 'n1', line: 0, text: '直した字' }]);
    expect(text.d.getState().restoreUndo ?? null, '字を直す回に「付箋を動かした」の戻す口が出た').toBeNull();
  });
});

describe('placeUndoNotice(知らせの字)', () => {
  it('積む回だけ字を返し、消す・字を直す・置く回は null', () => {
    expect(placeUndoNotice({ kind: 'place-move', line: 0, openLine: '', x: 1, y: 1 })).toBe('付箋を動かしました');
    expect(placeUndoNotice({ kind: 'place-style', line: 0, openLine: '', style: { width: 3 } })).toBe('線の太さを変えました');
    expect(placeUndoNotice({ kind: 'place-style', line: 0, openLine: '', style: { arrow: 'end' } })).toBe('線の矢じりを変えました');
    expect(placeUndoNotice({ kind: 'place-style', line: 0, openLine: '', style: { size: 'large' } })).toBe('付箋の文字の大きさを変えました');
    expect(placeUndoNotice({ kind: 'place-remove', line: 0, openLine: '' })).toBeNull();
    expect(placeUndoNotice({ kind: 'place-text', line: 0, openLine: '', before: '', text: 'x' })).toBeNull();
  });
});
