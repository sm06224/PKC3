import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
  };
}

function booted() {
  return reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', 2), meta('b', 1)],
    relations: [],
  }).state;
}

describe('reducer: lean aggregate', () => {
  it('SYS_BOOTED sorts order by entry_order and holds metas only', () => {
    const s = booted();
    expect(s.phase).toBe('ready');
    expect(s.order).toEqual(['b', 'a']);
    expect(s.entryMetas.size).toBe(2);
  });

  it('SELECT_ENTRY requests body and drops previous openBody', () => {
    const s1 = booted();
    const r1 = reduce(s1, { type: 'SELECT_ENTRY', lid: 'a' });
    expect(r1.state.selectedLid).toBe('a');
    expect(r1.state.openBody).toBeNull();
    expect(r1.events).toEqual([{ type: 'REQUEST_BODY', lid: 'a' }]);
  });

  it('stale BODY_LOADED (selection moved) is discarded', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'b', body: 'stale' }).state;
    expect(s.openBody).toBeNull();
  });

  it('START_EDIT is a no-op until the selected body is loaded (unread-body guard)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    expect(reduce(s, { type: 'START_EDIT' }).state.phase).toBe('ready');
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '# A' }).state;
    expect(reduce(s, { type: 'START_EDIT' }).state.phase).toBe('editing');
  });

  it('COMMIT_EDIT emits PERSIST_BODY from openBody only, and skips when unchanged', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '# A' }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;

    // 変わっていないなら書かない(#1024 の教訓)
    const unchanged = reduce(s, { type: 'COMMIT_EDIT' });
    expect(unchanged.events).toEqual([]);
    expect(unchanged.state.phase).toBe('ready');

    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: '# A2' }).state;
    const committed = reduce(s, { type: 'COMMIT_EDIT' });
    expect(committed.events).toEqual([{ type: 'PERSIST_BODY', lid: 'a', body: '# A2' }]);
    expect(committed.state.openBody?.baseline).toBe('# A2');
  });

  it('CANCEL_EDIT restores baseline', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '# A' }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: 'draft' }).state;
    s = reduce(s, { type: 'CANCEL_EDIT' }).state;
    expect(s.phase).toBe('ready');
    expect(s.openBody?.body).toBe('# A');
  });

  it('SET_VIEW_MODE keeps selection (PKC2 convention) and is blocked while editing', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'SET_VIEW_MODE', mode: 'kanban' }).state;
    expect(s.viewMode).toBe('kanban');
    expect(s.selectedLid).toBe('a');
  });
});

describe('effect layer: serialized store I/O', () => {
  function fakeStore(log: string[], bodies: Record<string, string>): StorePort {
    return {
      async getBody(lid) {
        log.push('get:' + lid);
        await new Promise((r) => setTimeout(r, lid === 'a' ? 20 : 0)); // a を遅くする
        return bodies[lid] ?? null;
      },
      async persistBody(lid, body) {
        log.push(`put:${lid}:${body}`);
      },
    };
  }

  it('ops run strictly in order even when an earlier op is slower (review #5)', async () => {
    const log: string[] = [];
    const d = new Dispatcher();
    const off = connectStoreEffects(d, fakeStore(log, { a: 'A', b: 'B' }));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1), meta('b', 2)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' }); // 遅い get
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' }); // 速い get ── だが順序は保持される
    await new Promise((r) => setTimeout(r, 60));
    expect(log).toEqual(['get:a', 'get:b']);
    // 遅延到着した a の body は stale として捨てられ、現選択 b の body が載る
    expect(d.getState().openBody?.lid).toBe('b');
    expect(d.getState().openBody?.body).toBe('B');
    off();
  });

  it('load failure reports APP_ERROR without killing the queue', async () => {
    const events: string[] = [];
    const d = new Dispatcher();
    const store: StorePort = {
      async getBody() {
        throw new Error('boom');
      },
      async persistBody() {},
    };
    const off = connectStoreEffects(d, store);
    d.onEvent((e) => events.push(e.type));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toContain('APP_ERROR');
    expect(d.getState().phase).toBe('ready'); // 読み失敗で app は死なない
    off();
  });

  it('commit flows through effects and persists exactly the open body', async () => {
    const log: string[] = [];
    const d = new Dispatcher();
    const off = connectStoreEffects(d, fakeStore(log, { a: 'A' }));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await new Promise((r) => setTimeout(r, 40));
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'A2' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(['get:a', 'put:a:A2']);
    off();
  });
});
