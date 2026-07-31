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

function loadedA() {
  let s = booted();
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '# A' }).state;
  return s;
}

describe('reducer: lean aggregate', () => {
  it('SYS_BOOTED sorts order by entry_order and holds metas only', () => {
    const s = booted();
    expect(s.phase).toBe('ready');
    expect(s.order).toEqual(['b', 'a']);
    expect(s.entryMetas.size).toBe(2);
  });

  it('re-boot resets selection and openBody (no cross-container carry-over)', () => {
    let s = loadedA();
    s = reduce(s, {
      type: 'SYS_BOOTED',
      cid: 'c2',
      metas: [meta('a', 1)],
      relations: [],
    }).state;
    expect(s.cid).toBe('c2');
    expect(s.selectedLid).toBeNull();
    expect(s.openBody).toBeNull();
  });

  it('SELECT_ENTRY requests body and drops previous openBody', () => {
    const r1 = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' });
    expect(r1.state.selectedLid).toBe('a');
    expect(r1.state.openBody).toBeNull();
    expect(r1.events).toEqual([{ type: 'REQUEST_BODY', lid: 'a' }]);
  });

  it('re-selecting the same entry re-requests body while openBody is absent (retry path)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    // 読み失敗などで openBody が無いまま同じ entry を再クリック → 再要求される
    const retry = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' });
    expect(retry.events).toEqual([{ type: 'REQUEST_BODY', lid: 'a' }]);
    // openBody 確立後の同一選択は no-op
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '# A' }).state;
    expect(reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).events).toEqual([]);
  });

  it('stale BODY_LOADED (selection moved) is discarded', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'b', body: 'stale' }).state;
    expect(s.openBody).toBeNull();
  });

  it('BODY_LOADED during editing is discarded (does not clobber typed input)', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: 'typing…' }).state;
    // 遅延到着した同 lid の応答が入力を巻き戻さない(review B)
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '# A(old)' }).state;
    expect(s.openBody?.body).toBe('typing…');
    expect(s.openBody?.baseline).toBe('# A');
  });

  it('stale BODY_LOAD_FAILED is discarded', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    const r = reduce(s, { type: 'BODY_LOAD_FAILED', lid: 'b', error: 'x' });
    expect(r.events).toEqual([]);
  });

  it('START_EDIT is a no-op until the selected body is loaded (unread-body guard)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    expect(reduce(s, { type: 'START_EDIT' }).state.phase).toBe('ready');
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '# A' }).state;
    expect(reduce(s, { type: 'START_EDIT' }).state.phase).toBe('editing');
  });

  it('editing blocks SELECT_ENTRY / SET_VIEW_MODE / UPDATE outside editing', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;
    expect(reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state.selectedLid).toBe('a');
    expect(reduce(s, { type: 'SET_VIEW_MODE', mode: 'kanban' }).state.viewMode).toBe(
      'detail',
    );
    // editing 外での UPDATE_OPEN_BODY は無効
    const ready = loadedA();
    expect(
      reduce(ready, { type: 'UPDATE_OPEN_BODY', body: 'x' }).state.openBody?.body,
    ).toBe('# A');
  });

  it('COMMIT_EDIT emits PERSIST_BODY from openBody only, and skips when unchanged', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;

    const unchanged = reduce(s, { type: 'COMMIT_EDIT' });
    expect(unchanged.events).toEqual([]);
    expect(unchanged.state.phase).toBe('ready');

    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: '# A2' }).state;
    const committed = reduce(s, { type: 'COMMIT_EDIT' });
    expect(committed.events).toEqual([{ type: 'PERSIST_BODY', lid: 'a', body: '# A2' }]);
    expect(committed.state.openBody?.baseline).toBe('# A2');
  });

  it('CANCEL_EDIT restores baseline', () => {
    let s = loadedA();
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: 'draft' }).state;
    s = reduce(s, { type: 'CANCEL_EDIT' }).state;
    expect(s.phase).toBe('ready');
    expect(s.openBody?.body).toBe('# A');
  });

  it('SET_VIEW_MODE keeps selection (PKC2 convention)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'SET_VIEW_MODE', mode: 'kanban' }).state;
    expect(s.viewMode).toBe('kanban');
    expect(s.selectedLid).toBe('a');
  });
});

describe('dispatcher: re-entrancy linearization', () => {
  it('nested dispatch from a listener is queued, listeners always end on latest state', () => {
    const d = new Dispatcher();
    const seen: Array<string> = [];
    let fired = false;
    d.onState((s) => {
      if (!fired && s.selectedLid === 'a') {
        fired = true;
        d.dispatch({ type: 'SET_VIEW_MODE', mode: 'kanban' }); // listener 内 dispatch
      }
    });
    d.onState((s) => seen.push(`${s.selectedLid}/${s.viewMode}`));
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a', 1)],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    // 逆転しない: 最後に観測した state が最新(review G)
    expect(seen[seen.length - 1]).toBe('a/kanban');
    expect(d.getState().viewMode).toBe('kanban');
  });
});

describe('effect layer: serialized store I/O', () => {
  function fakeStore(log: string[], bodies: Record<string, string>): StorePort {
    return {
      async getBody(lid) {
        log.push('get:' + lid);
        await new Promise((r) => setTimeout(r, lid === 'a' ? 20 : 0)); // a を遅くする
        log.push('done:' + lid); // 完了順を記録(直列化の弁別に必須 ── review A)
        return bodies[lid] ?? null;
      },
      async persistBody(lid, body) {
        log.push(`put:${lid}:${body}`);
      },
    };
  }

  it('ops are strictly serialized: a slow op completes before the next starts (review #5 pin)', async () => {
    const log: string[] = [];
    const d = new Dispatcher();
    const off = connectStoreEffects(d, fakeStore(log, { a: 'A', b: 'B' }));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1), meta('b', 2)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' }); // 遅い get
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' }); // 速い get ── だが先行完了を待つ
    await new Promise((r) => setTimeout(r, 60));
    // 完了順まで含めた非交差 assert: 非直列実装なら done:b が done:a を追い越して落ちる
    expect(log).toEqual(['get:a', 'done:a', 'get:b', 'done:b']);
    expect(d.getState().openBody?.lid).toBe('b');
    expect(d.getState().openBody?.body).toBe('B');
    off();
  });

  it('missing row is a failure, not an empty body (S3-bud guard, review C\')', async () => {
    const events: string[] = [];
    const d = new Dispatcher();
    const off = connectStoreEffects(d, fakeStore([], {})); // 行なし
    d.onEvent((e) => events.push(e.type));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await new Promise((r) => setTimeout(r, 40));
    expect(events).toContain('APP_ERROR');
    expect(d.getState().openBody).toBeNull(); // 「空のノート」に見せない
    off();
  });

  it('load failure reports APP_ERROR without killing the queue', async () => {
    const events: string[] = [];
    const d = new Dispatcher();
    let calls = 0;
    const store: StorePort = {
      async getBody() {
        calls++;
        if (calls === 1) throw new Error('boom');
        return 'recovered';
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
    // 再クリック = retry(review C): queue は生きており復帰できる
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await new Promise((r) => setTimeout(r, 20));
    expect(d.getState().openBody?.body).toBe('recovered');
    off();
  });

  it('persist failure transitions to error phase (no silent loss today)', async () => {
    const d = new Dispatcher();
    const store: StorePort = {
      async getBody() {
        return '# A';
      },
      async persistBody() {
        throw new Error('disk full');
      },
    };
    const off = connectStoreEffects(d, store);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await new Promise((r) => setTimeout(r, 20));
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'A2' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await new Promise((r) => setTimeout(r, 20));
    expect(d.getState().phase).toBe('error'); // 保存失敗は静かに失敗しない
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
    expect(log).toEqual(['get:a', 'done:a', 'put:a:A2']);
    off();
  });

  it('teardown stops in-flight results from dispatching (review H)', async () => {
    const d = new Dispatcher();
    const off = connectStoreEffects(d, {
      async getBody() {
        await new Promise((r) => setTimeout(r, 20));
        return 'late';
      },
      async persistBody() {},
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    off(); // in-flight のまま teardown
    await new Promise((r) => setTimeout(r, 40));
    expect(d.getState().openBody).toBeNull();
  });
});
