/**
 * 🔴 **フォルダの中で語を打っても、本文の一致を 200 件の上限で取りこぼさない**(#1163 依頼 336 A「200 件で切れる件も直す」)。
 *
 * ⚠ 直す前は全体で先に 200 件集めてから、フォルダの表が中身だけに絞っていた ── 全体の一致が 200 件を超えると、
 *   並びで後ろに居るフォルダの中の一致が 1 件も出なかった(「無い」と読まれる)。
 *
 * - worker: `within` を渡すと、全体の 200 件**に加えて**中の当たりを返す。切れたかは中で言う
 * - 効果の層: 開いているフォルダの配下を `within` にする(`searchWithin`)/ フォルダを移ると探し直す
 *
 * ⚠ worker は本物を node で動かす(`search-entries.test.ts` と同じ手法)。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { StorageRequest } from '../../src/adapter/platform/storage/protocol';
import { searchWithin } from '../../src/adapter/state/store-effects';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';

/* eslint-disable @typescript-eslint/no-explicit-any */

const pending = new Map<number, (resp: any) => void>();
let seq = 0;
const workerSelf: { onmessage: ((ev: { data: any }) => void) | null } = { onmessage: null };

const call = (req: StorageRequest): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) => (resp.ok ? resolve(resp.result) : reject(new Error(resp.error))));
    workerSelf.onmessage!({ data: { id, req } });
  });

const CID = 'c1';
const N = 230;
/** 並びで 200 件より後ろに居る、フォルダの中のノート(全体の先頭 200 件には入らない)。 */
const INSIDE = ['n205', 'n206', 'n207', 'n208', 'n209', 'n210'];

const search = async (query: string, within?: readonly string[]) =>
  (await call({
    op: 'searchEntries',
    cid: CID,
    query,
    ...(within === undefined ? {} : { within }),
  } as StorageRequest)) as { lids: string[]; truncated: boolean };

describe('フォルダの中の本文の一致を、上限で取りこぼさない(依頼 336)', () => {
  beforeAll(async () => {
    (globalThis as any).self = workerSelf;
    (globalThis as any).postMessage = (msg: any) => {
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      cb?.(msg);
    };
    await import('../../src/adapter/platform/storage/storage-worker');
    await call({ op: 'init', dbName: 'search-within-336' } as StorageRequest);
    await call({ op: 'openContainer', cid: CID, title: 't' } as StorageRequest);
    for (let i = 1; i <= N; i++) {
      await call({
        op: 'upsertEntry',
        cid: CID,
        entry: {
          lid: `n${i}`,
          title: `メモ${i}`,
          archetype: 'text',
          entryOrder: i,
          status: null,
          date: null,
          archived: false,
          body: 'りんごの話\n',
        },
        checkpoint: false,
        keepLatest: 1,
      } as StorageRequest);
    }
  }, 120_000);

  it('対照群: 渡さなければ全体の先頭 200 件だけで、フォルダの中の一致は入らない(直す前の姿)', async () => {
    const r = await search('りんご');
    expect(r.lids.length).toBe(200);
    expect(r.truncated).toBe(true);
    expect(r.lids.filter((l) => INSIDE.includes(l)), '前提が崩れている(中のノートが先頭 200 件に入った)').toEqual([]);
  });

  it('🔴 中身を渡すと、全体の 200 件に加えて中の一致が全部返り、中で切れていなければ「ほかにもある」と言わない(FTS)', async () => {
    const r = await search('りんご', INSIDE);
    expect(r.lids.filter((l) => INSIDE.includes(l)).sort(), 'フォルダの中の一致を取りこぼした').toEqual([...INSIDE].sort());
    // 🔑 全体の当たりを読む面(2 ペイン・種類の札)は今までどおり ── 全体の先頭 200 件はそのまま入っている
    expect(r.lids.includes('n1') && r.lids.includes('n200'), '全体の当たりが減った').toBe(true);
    expect(r.truncated, '中の 6 件しかないのに「ほかにもある」と言った').toBe(false);
  });

  it('🔴 2 文字(LIKE の道)でも同じ', async () => {
    const r = await search('りん', INSIDE);
    expect(r.lids.filter((l) => INSIDE.includes(l)).sort()).toEqual([...INSIDE].sort());
    expect(r.truncated).toBe(false);
  });

  it('⚠ 中だけで 200 件を超えたら、切れたと言う', async () => {
    const many = Array.from({ length: 210 }, (_, i) => `n${i + 21}`);
    const r = await search('りんご', many);
    expect(r.truncated, '中で 210 件当たったのに切れたと言わない').toBe(true);
  });

  it('⚠ 中に当たりが無ければ、全体の当たりだけ(足さない)', async () => {
    const r = await search('りんご', ['nope']);
    expect(r.lids.length).toBe(200);
    expect(r.truncated).toBe(false);
  });
});

// ── 効果の層: 何を「中身」として渡すか ───────────────────────────────

function meta(lid: string, archetype = 'text'): EntryMeta {
  return {
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
  };
}
const rel = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

function booted(): AppState {
  const metas = [meta('f1', 'folder'), meta('f2', 'folder'), meta('a'), meta('b'), meta('c')];
  // f1 の中に a と f2、f2 の中に b。c はルート
  const relations = [rel('r1', 'f1', 'a'), rel('r2', 'f1', 'f2'), rel('r3', 'f2', 'b')];
  return reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations }).state;
}

describe('開いているフォルダの中身を渡す(依頼 336)', () => {
  it('ルートでは渡さない(全体がそのまま中身)', () => {
    expect(searchWithin(booted())).toBeUndefined();
  });

  it('🔴 フォルダでは配下の全部(孫まで。フォルダ自身は除く)', () => {
    const st = reduce(booted(), { type: 'SET_SCOPE', lid: 'f1' }).state;
    expect([...(searchWithin(st) ?? [])].sort()).toEqual(['a', 'b', 'f2']);
  });

  it('🔴 語を打ったまま別のフォルダへ移ると、本文を探し直す', () => {
    const typed = reduce(booted(), { type: 'SET_ENTRY_FILTER', query: 'りんご' }).state;
    const r = reduce(typed, { type: 'SET_SCOPE', lid: 'f1' });
    expect(r.events, '探し直していない(前のフォルダの当たりのまま)').toContainEqual({
      type: 'REQUEST_SEARCH',
      query: 'りんご',
      again: true,
    });
  });

  it('⚠ 語が空なら、フォルダを移っても探さない', () => {
    const r = reduce(booted(), { type: 'SET_SCOPE', lid: 'f1' });
    expect(r.events.some((e) => e.type === 'REQUEST_SEARCH')).toBe(false);
  });
});

// ── 配線: 効果の層が worker へ中身を渡す ─────────────────────────────

describe('配線: 開いているフォルダの中身が worker へ届く(依頼 336)', () => {
  it('🔴 フォルダを開いて語を打つと、配下の lid を添えて探し、ルートへ戻ると添えずに探し直す', async () => {
    const { Dispatcher } = await import('../../src/adapter/state/dispatcher');
    const { connectStoreEffects } = await import('../../src/adapter/state/store-effects');
    const { stubStamps } = await import('../helpers/store-stamps');
    const { stubRevisionOps } = await import('../helpers/revision-stub');
    const calls: Array<{ q: string; within: readonly string[] | undefined }> = [];
    const d = new Dispatcher();
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '',
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
      searchEntries: async (q: string, within?: readonly string[]) => {
        calls.push({ q, within });
        return { lids: [], truncated: false };
      },
    });
    const st = booted();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [...st.entryMetas.values()], relations: st.relations });
    d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'りんご' });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length, '探していない(空振り)').toBeGreaterThan(0);
    expect([...(calls.at(-1)!.within ?? [])].sort(), '中身を添えていない').toEqual(['a', 'b', 'f2']);
    d.dispatch({ type: 'SET_SCOPE', lid: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.at(-1), 'ルートへ戻ったのに探し直していない / 中身を添えたまま').toEqual({ q: 'りんご', within: undefined });
  });
});
