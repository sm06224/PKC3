/** @vitest-environment happy-dom */
/**
 * 関係を作る・消す(#185 の書き込み側 / 台帳 #180 の A-7)。
 *
 * 🔴 守る主張:
 * 1. **居場所(structural)はここから作れない・消せない** ── ファイラの移動が唯一の作り手
 * 2. 自分自身へ張らない / 同じ組・同じ種類は 2 本にならない(押すたびに増えない)
 * 3. 居ない相手へ張らない
 * 4. **disk まで届く**(常駐 state だけ動いて保存されない、を作らない)
 * 5. 消すのは **id で**(同じ組が複数あっても迷わない)。冪等
 * 6. 時刻は **disk が正**(reducer が現在時刻を作らない)
 */
import { describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

function booted() {
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1'), meta('n2'), meta('n3')],
    relations: [],
  });
  return d;
}

describe('関係を作る(reducer)', () => {
  it('作ると常駐 state に乗り、保存の要求が出る', () => {
    const d = booted();
    const events: string[] = [];
    d.onEvent((e) => events.push(e.type));
    d.dispatch({ type: 'ADD_RELATION', id: 'r1', fromLid: 'n1', toLid: 'n2', kind: 'semantic' });
    expect(d.getState().relations).toHaveLength(1);
    expect(events).toContain('REQUEST_RELATION_UPSERT');
  });

  it('🔴 居場所はここから作れない(作り方を 2 つにしない)', () => {
    const d = booted();
    d.dispatch({ type: 'ADD_RELATION', id: 'r1', fromLid: 'n1', toLid: 'n2', kind: 'structural' });
    expect(d.getState().relations, '居場所が手で作れてしまった').toHaveLength(0);
  });

  it('🔴 同じ組・同じ種類は 2 本にならない(押すたびに増えない)', () => {
    const d = booted();
    d.dispatch({ type: 'ADD_RELATION', id: 'r1', fromLid: 'n1', toLid: 'n2', kind: 'semantic' });
    d.dispatch({ type: 'ADD_RELATION', id: 'r2', fromLid: 'n1', toLid: 'n2', kind: 'semantic' });
    expect(d.getState().relations).toHaveLength(1);
    // ⚠ 種類が違えば別の関係(こちらは通る)
    d.dispatch({ type: 'ADD_RELATION', id: 'r3', fromLid: 'n1', toLid: 'n2', kind: 'temporal' });
    expect(d.getState().relations).toHaveLength(2);
  });

  it('自分自身へは張らない / 居ない相手へも張らない', () => {
    const d = booted();
    d.dispatch({ type: 'ADD_RELATION', id: 'r1', fromLid: 'n1', toLid: 'n1', kind: 'semantic' });
    d.dispatch({ type: 'ADD_RELATION', id: 'r2', fromLid: 'n1', toLid: 'ghost', kind: 'semantic' });
    expect(d.getState().relations).toHaveLength(0);
  });

  it('🔴 時刻は disk が正(reducer が現在時刻を作らない)', () => {
    const d = booted();
    d.dispatch({ type: 'ADD_RELATION', id: 'r1', fromLid: 'n1', toLid: 'n2', kind: 'semantic' });
    const r = d.getState().relations[0]!;
    expect(r.createdAt, 'reducer が時刻を作っている(画面と disk で別の値になる)').toBeNull();
    expect(r.updatedAt).toBeNull();
  });
});

describe('関係を消す(reducer)', () => {
  function withRelation() {
    const d = booted();
    d.dispatch({ type: 'ADD_RELATION', id: 'r1', fromLid: 'n1', toLid: 'n2', kind: 'semantic' });
    return d;
  }

  it('id で消える', () => {
    const d = withRelation();
    d.dispatch({ type: 'REMOVE_RELATION', id: 'r1' });
    expect(d.getState().relations).toHaveLength(0);
  });

  it('居ない id は黙って何もしない(冪等)', () => {
    const d = withRelation();
    d.dispatch({ type: 'REMOVE_RELATION', id: 'r1' });
    expect(() => d.dispatch({ type: 'REMOVE_RELATION', id: 'r1' })).not.toThrow();
    expect(d.getState().relations).toHaveLength(0);
  });

  it('🔴 居場所は消せない(ファイラの階層が壊れる)', () => {
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1'), meta('n2')],
      relations: [
        { id: 's1', fromLid: 'n1', toLid: 'n2', kind: 'structural', createdAt: null, updatedAt: null },
      ],
    });
    d.dispatch({ type: 'REMOVE_RELATION', id: 's1' });
    expect(d.getState().relations, '居場所が消えた').toHaveLength(1);
  });
});

describe('🔴 disk まで届く(常駐だけ動いて保存されない、を作らない)', () => {
  function port(): StorePort & { calls: string[] } {
    const calls: string[] = [];
    const p = {
      calls,
      getBody: async () => null,
      getBodies: async () => [],
      listBodies: async () => ({ rows: [], done: true }),
      persistEntry: async () => ({ createdAt: null, updatedAt: null }),
      deleteEntry: async () => undefined,
      setEntryParent: async () => undefined,
      listRelations: async () => [],
      listRevisionMetas: async () => [],
      getRevision: async () => null,
      listTrash: async () => [],
      purgeTrash: async () => undefined,
      upsertRelation: async (r: { id: string }) => void calls.push(`upsert:${r.id}`),
      deleteRelation: async (id: string) => void calls.push(`delete:${id}`),
    } as unknown as StorePort & { calls: string[] };
    return p;
  }

  it('作ると upsert、消すと delete が呼ばれる', async () => {
    const d = booted();
    const p = port();
    const off = connectStoreEffects(d, p);
    d.dispatch({ type: 'ADD_RELATION', id: 'r1', fromLid: 'n1', toLid: 'n2', kind: 'semantic' });
    d.dispatch({ type: 'REMOVE_RELATION', id: 'r1' });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(p.calls, 'disk へ届いていない').toEqual(['upsert:r1', 'delete:r1']);
    off();
  });

  it('🔴 保存に失敗したら黙らない(画面には在るのに disk に無い、を残さない)', async () => {
    const d = booted();
    const p = port();
    (p as unknown as { upsertRelation: () => Promise<void> }).upsertRelation = () =>
      Promise.reject(new Error('disk full'));
    const off = connectStoreEffects(d, p);
    const seen: string[] = [];
    d.onState((s) => void (s.error && seen.push(s.error)));
    d.dispatch({ type: 'ADD_RELATION', id: 'r1', fromLid: 'n1', toLid: 'n2', kind: 'semantic' });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(seen.join(' '), '失敗が画面に出ていない').toContain('関係を保存できません');
    off();
  });

  it('関係の書き込み口を持たない配線でも落ちない(機能が減るだけ)', async () => {
    const d = booted();
    const p = port();
    delete (p as unknown as { upsertRelation?: unknown }).upsertRelation;
    const off = connectStoreEffects(d, p);
    expect(() =>
      d.dispatch({ type: 'ADD_RELATION', id: 'r1', fromLid: 'n1', toLid: 'n2', kind: 'semantic' }),
    ).not.toThrow();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    off();
    vi.restoreAllMocks();
  });
});
