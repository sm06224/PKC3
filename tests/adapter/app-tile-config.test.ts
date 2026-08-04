/** @vitest-environment happy-dom */
/**
 * P8 段⑭: **PKC3 の中からタイルを作る**。
 *
 * > user 報告 2026-08-03「**ランチャーの設定導線が消えた**」
 *
 * 🔴 タイルの元データ(`registered_as_app` / `app_group` / `app_icon`)は添付の
 * frontmatter に在るのに、PKC3 には**書く手段が 1 つも無かった** ── binder の
 * action 表にランチャー関連は起動(`open-tile`)だけで、`UserAction` 型にも
 * 添付メタを書くものが無い。PKC2 から取り込んだ user だけがタイルを持てた。
 *
 * ⚠ 観測点は「action が dispatch された」で止めない ── **disk に何が書かれ、
 * ランチャーが読み直したか**まで見る(押しても次にタブを開くまで出ない、を落とす)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';

const tick = (ms = 10): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
  };
}

const BASE = '---\nattachment.name: a.html\nattachment.mime: text/html\nattachment.asset_key: k\n---\n説明\n';

function setup(initial = BASE): {
  d: Dispatcher;
  bodies: Record<string, string>;
  writes: number;
} {
  const bodies: Record<string, string> = { a1: initial };
  const counter = { writes: 0 };
  const d = new Dispatcher();
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    getBodies: async (lids) =>
      lids.filter((l) => bodies[l] !== undefined).map((l) => ({ lid: l, body: bodies[l]! })),
    persistEntry: async (e) => {
      counter.writes += 1;
      bodies[e.lid] = e.body;
    },
    deleteEntry: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a1', 'メモ帳')], relations: [] });
  return {
    d,
    bodies,
    get writes() {
      return counter.writes;
    },
  };
}

describe('タイル設定を書く(P8 段⑭)', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('🔴 登録すると frontmatter に 1 行入り、**ランチャーがその場で読み直す**', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    const fm = parseFrontmatter(h.bodies.a1!).meta;
    expect(fm['attachment.registered_as_app']).toBe(true);
    // ⚠ **タイルが出る**ところまで見る(書いただけで画面に出ないのが元の姿)
    expect(h.d.getState().launcherTiles?.map((t) => t.lid)).toEqual(['a1']);
  });

  it('🔴 本文と他の key を**壊さない**(原文 splice)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    const parsed = parseFrontmatter(h.bodies.a1!);
    expect(parsed.body).toBe('説明\n');
    expect(parsed.meta['attachment.asset_key']).toBe('k');
    expect(parsed.meta['attachment.mime']).toBe('text/html');
  });

  it('🔴 登録を外すと **行ごと消える**(`false` を書き置かない)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: false });
    await tick(20);
    expect(h.bodies.a1).not.toContain('registered_as_app');
    expect(h.d.getState().launcherTiles).toEqual([]);
  });

  it('グループと目印が付き、空にすると消える', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', group: '道具', icon: '🧮' });
    await tick(20);
    expect(h.d.getState().launcherTiles?.[0]?.group).toBe('道具');
    expect(h.d.getState().launcherTiles?.[0]?.icon).toBe('🧮');
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', group: '' });
    await tick(20);
    expect(h.bodies.a1).not.toContain('app_group');
    expect(h.d.getState().launcherTiles?.[0]?.group).toBe('');
  });

  it('⚠ 変わらないなら**書かない**(同じ値で disk を叩かない)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    const before = h.writes;
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    expect(h.writes).toBe(before);
  });

  it('🔴 **開いている body も差し替わる**(画面が古いまま残らない)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    expect(h.d.getState().openBody?.body).toBe(BASE);
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    // ⚠ ここが本丸 ── `BODY_PERSISTED` だけだと `persisted` しか動かず、
    //    「チェックを入れてもグループ欄が出てこない」になる(実測で踏んだ)
    expect(h.d.getState().openBody?.body).toContain('registered_as_app');
    expect(h.d.getState().openBody?.baseline).toBe(h.d.getState().openBody?.body);
  });

  it('⚠ 編集中は開いている body を触らない(打っている draft を潰さない)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    h.d.dispatch({ type: 'START_EDIT' });
    h.d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '打ちかけ' });
    h.d.dispatch({ type: 'APP_TILE_SAVED', lid: 'a1', body: 'よそから来た' });
    expect(h.d.getState().openBody?.body).toBe('打ちかけ');
  });

  it('🔴 書込が飛んでいる間は受け付けない(読んで書き戻す操作なので片方が消える)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    // ⚠ **event を数える** ── 「body が変わっていない」だけを見ると、追記も
    //    タイル書込もまだ非同期で走っていないので**何をしても通る**
    //    (実際それで変異が生き残った)。止まったことを直接見る
    const seen: string[] = [];
    const off = h.d.onEvent((e) => seen.push(e.type));
    h.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a1', text: 'x', heading: null });
    expect(h.d.getState().writeLock, 'writeLock が立っていない(前提が崩れた)').not.toBeNull();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    expect(seen.filter((t) => t === 'REQUEST_TILE_UPDATE'), '書込中なのに受け付けた').toEqual([]);
    // 追記が終わってロックが解けたら、今度は通る
    await tick(30);
    expect(h.d.getState().writeLock).toBeNull();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    expect(seen.filter((t) => t === 'REQUEST_TILE_UPDATE'), 'ロックが解けても通らない').toHaveLength(
      1,
    );
    off();
  });

  it('⚠ 知らない lid は何もしない', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'nope', registered: true });
    await tick(20);
    expect(h.writes).toBe(0);
  });
});
