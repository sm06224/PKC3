/** @vitest-environment happy-dom */
/**
 * 🔴 **スマートフォルダの見直し**(#1087)。
 *
 * 守る主張:
 * ① 条件の書き換え(足す / 選ぶ / 外す)は、別のタブが編集中のスマートフォルダの本文へは撃たない
 * ② このタブで編集中は、条件の欄を**先に断る**(reducer が黙って捨てるので、打った字が消えるだけだった)
 * ③ ノートを消したら、開いているスマートフォルダの当たり・件数からも落ちる(手元が全部のときは手で、上限で切れているときは集め直し)
 */
import { describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState, type DomainEvent } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';
import { EMPTY_SMART } from '../../src/features/smart/smart-spec';

const meta = (lid: string, order: number, archetype = 'text'): EntryMeta => ({
  lid,
  title: lid,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
  bodyChars: 10,
});
const METAS = [meta('s1', 1, 'smart'), meta('a', 2), meta('b', 3), meta('c', 4)];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function rig(services: Partial<BinderServices>) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  bindActions(root, d, { showStatus: () => {}, ...services });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  d.dispatch({ type: 'SET_SCOPE', lid: 's1' });
  events.length = 0;
  const box = document.createElement('input');
  box.setAttribute('data-pkc-field', 'smart-cond');
  root.append(box);
  const press = (action: string, attrs: Record<string, string> = {}): void => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', action);
    for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
    root.append(b);
    b.click();
  };
  const writes = () =>
    events.filter((e) => e.type === 'REQUEST_SMART_COND' || e.type === 'REQUEST_SMART_FIELD');
  const startEditing = (): void => {
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文\n' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '台の前提: 編集に入れていない').toBe('editing');
    events.length = 0;
  };
  return { d, events, press, box, writes, startEditing, root };
}

const denied = () => ({ acquireEditLock: vi.fn(async () => 'denied' as const), releaseEditLock: vi.fn() });
const granted = () => ({ acquireEditLock: vi.fn(async () => 'granted' as const), releaseEditLock: vi.fn() });

type Rig = ReturnType<typeof rig>;
const CASES: ReadonlyArray<[string, string]> = [
  ['smart-cond-add', '足す'],
  ['smart-cond-remove', '外す'],
  ['smart-field', '選ぶ'],
];
const pressOf = (t: Rig, action: string): void => {
  if (action === 'smart-cond-add') {
    t.box.value = '請求';
    t.press(action);
  } else if (action === 'smart-cond-remove') {
    t.press(action, { 'data-pkc-tag': '請求' });
  } else {
    // 列で引く条件は <select> の change で来る ── 押し口は同じ data-pkc-action
    const sel = document.createElement('select');
    sel.setAttribute('data-pkc-action', 'smart-field');
    sel.setAttribute('data-pkc-smart-field', 'kind');
    const o = document.createElement('option');
    o.value = 'attachment';
    sel.append(o);
    sel.value = 'attachment';
    t.root.append(sel);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
};

describe('① 条件の書き換えは、別のタブが編集中なら撃たない', () => {
  for (const [action, label] of CASES) {
    it(`🔴 ${label}(${action}): 別のタブが握っていたら何も撃たず、理由を出す`, async () => {
      const lock = denied();
      const t = rig(lock);
      pressOf(t, action);
      await flush();
      expect(lock.acquireEditLock).toHaveBeenCalledWith('s1');
      expect(t.writes(), '断られたのに条件を書く要求を撃った').toHaveLength(0);
      expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
      if (action === 'smart-cond-add') expect(t.box.value, '断ったのに欄を空にした').toBe('請求');
    });

    it(`対照群: ${label}(${action})は、取れたら撃つ`, async () => {
      const lock = granted();
      const t = rig(lock);
      pressOf(t, action);
      await flush();
      expect(t.writes()).toHaveLength(1);
      expect(lock.releaseEditLock).toHaveBeenCalledWith('s1');
    });
  }

  it('確認が落ちたら、次にすることを言う', async () => {
    const t = rig({ acquireEditLock: vi.fn(async () => Promise.reject(new Error('x'))), releaseEditLock: vi.fn() });
    pressOf(t, 'smart-cond-add');
    await flush();
    expect(t.d.getState().error).toContain('もう一度押してください');
    expect(t.writes()).toHaveLength(0);
  });
});

describe('② 編集中は条件の欄を先に断る(打った字を消さない)', () => {
  for (const [action, label] of CASES) {
    it(`🔴 ${label}(${action}): 理由を出し、何も撃たない`, async () => {
      const t = rig({});
      t.startEditing();
      pressOf(t, action);
      await flush();
      expect(t.d.getState().error ?? '').toContain('編集を保存するか、編集をやめてから');
      expect(t.d.getState().error ?? '').toContain('条件を書き換えてください');
      expect(t.writes()).toHaveLength(0);
      if (action === 'smart-cond-add') expect(t.box.value, '打った字が消えた').toBe('請求');
    });
  }

  it('🔴 「ここから外す」(smart-evict)も編集中は理由を出し、何も撃たない', async () => {
    const t = rig({});
    t.startEditing();
    t.press('smart-evict');
    await flush();
    expect(t.d.getState().error ?? '').toContain('編集を保存するか、編集をやめてから外してください');
    expect(t.events.filter((e) => e.type === 'REQUEST_SMART_TAGS')).toHaveLength(0);
  });
});

describe('③ ノートを消したら、開いているスマートフォルダの当たりと件数も更新する', () => {
  const withHit = (lids: string[], total: number): AppState => {
    let st = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] }).state;
    st = reduce(st, { type: 'SMART_SCANNED', lid: 's1', lids, total, spec: EMPTY_SMART } as never).state;
    expect(st.smartHits.get('s1')?.total, '台の前提: 当たりが入っていない').toBe(total);
    return st;
  };
  const scans = (events: DomainEvent[]) => events.filter((e) => e.type === 'REQUEST_SMART_SCAN');

  it('🔴 当たりに居たノートを消すと、一覧から外れて件数が 1 減る(集め直しは要らない)', () => {
    const r = reduce(withHit(['a', 'b'], 2), { type: 'DELETE_ENTRY', lid: 'a' });
    const hit = r.state.smartHits.get('s1')!;
    expect(hit.lids).toEqual(['b']);
    expect(hit.total).toBe(1);
    expect(scans(r.events), '手元が全部なのに集め直しを頼んだ').toHaveLength(0);
  });

  it('まとめて消しても、居た分だけ減る', () => {
    const r = reduce(withHit(['a', 'b', 'c'], 3), { type: 'DELETE_ENTRIES', lids: ['a', 'c'] });
    expect(r.state.smartHits.get('s1')).toMatchObject({ lids: ['b'], total: 1 });
  });

  it('当たりに居ないノートを消しても、何も変えない(参照も保つ)', () => {
    const before = withHit(['a'], 1);
    const r = reduce(before, { type: 'DELETE_ENTRY', lid: 'c' });
    expect(r.state.smartHits).toBe(before.smartHits);
    expect(scans(r.events)).toHaveLength(0);
  });

  it('🔴 上限で切れている入れ物: 当たりに居なかった回は件数を動かさず、集め直しを頼む', () => {
    const r = reduce(withHit(['a', 'b'], 5), { type: 'DELETE_ENTRY', lid: 'c' });
    expect(r.state.smartHits.get('s1')).toMatchObject({ lids: ['a', 'b'], total: 5 });
    expect(scans(r.events)).toEqual([{ type: 'REQUEST_SMART_SCAN', lid: 's1' }]);
  });

  it('🔴 上限で切れている入れ物: 当たりに居た回は外して減らし、穴を埋めるため集め直しも頼む', () => {
    const r = reduce(withHit(['a', 'b'], 5), { type: 'DELETE_ENTRY', lid: 'a' });
    expect(r.state.smartHits.get('s1')).toMatchObject({ lids: ['b'], total: 4 });
    expect(scans(r.events)).toEqual([{ type: 'REQUEST_SMART_SCAN', lid: 's1' }]);
  });
});
