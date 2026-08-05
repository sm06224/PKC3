/** @vitest-environment happy-dom */
/**
 * 作成・更新の時刻が **画面に届く**ことを pin する(P9 段①)。
 *
 * 🔴 直したバグ: 情報列の「作成 / 更新」が、そのノートを作ったセッションのあいだ
 * **ずっと「—」**だった。`datetime('now')` を打つのは worker の `UPSERT_SQL` だけで、
 * 主スレッドは `createdAt: null` を入れたまま **次の boot まで**値を知らなかった。
 * 実機で確認: 作成直後は `—`、再読込すると `2026/08/04` が出る。
 *
 * 🔑 3 層で見る。どれか 1 つでは足りない:
 *   ① worker(実 sqlite)… 刻んだ値を**返す**か / 更新で `created_at` を潰さないか
 *   ② 書込経路(7 つ)… **すべて**が state へ流しているか(1 つ忘れるとそこだけ「—」)
 *   ③ 画面 … 情報列に実際に日付が出るか(= user が見る当の振る舞い)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryStamps, EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { SidebarRenderer } from '../../src/adapter/ui/render/sidebar';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { createByUi } from '../helpers/create-entry';
import { createStorePort } from '../../src/adapter/platform/storage/store-port';

// ── ① worker(実 sqlite。node では :memory: fallback)──────────────

type Op = StorageRequest['op'];
const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) =>
      resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
    );
    workerSelf.onmessage!({ data: { id, req } });
  });
}

const upsert = (lid: string, body: string, title = 't') =>
  request({
    op: 'upsertEntry',
    cid: 'c1',
    entry: {
      lid,
      title,
      archetype: 'text',
      body,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
    },
    checkpoint: false,
  });

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'stamp-test' });
  expect(init.vfs).toBe('memory');
  await request({ op: 'openContainer', cid: 'c1', title: 'unit' });
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

/** sqlite の `datetime('now')` の形。 */
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

describe('① worker が刻んだ時刻を返す', () => {
  it('🔴 書込の応答に作成・更新が入っている(null で返らない)', async () => {
    const stamps = await upsert('w1', '# a');
    // ⚠ 「返ってきた」だけでは足りない ── **形**まで見る。主スレッドが自分で
    //    now を作っていたら別の形(ISO)になるので、ここで食い違いが露見する
    expect(stamps.createdAt).toMatch(SQLITE_DATETIME);
    expect(stamps.updatedAt).toMatch(SQLITE_DATETIME);
  });

  it('🔴 返す値は DB の行と一致する(応答だけ作って返していない)', async () => {
    const stamps = await upsert('w2', '# b');
    const rows = await request({ op: 'listEntryMetas', cid: 'c1' });
    const row = rows.find((r) => r.lid === 'w2');
    expect(row, 'w2 の行が無い').toBeDefined();
    expect(stamps.createdAt).toBe(row!.created_at);
    expect(stamps.updatedAt).toBe(row!.updated_at);
  });

  it('🔴 更新しても作成は潰れない(ON CONFLICT に created_at を入れない)', async () => {
    const first = await upsert('w3', '# c1');
    // 🔴 **1 秒以上待つ**。`datetime('now')` は**秒精度**なので、続けて 2 回書くと
    //    上書きされていても同じ文字列が返り、この test は素通りする
    //    (変異試験で実際に生存した ── 差が 0 の次元は「見ていない次元」)。
    await new Promise((r) => setTimeout(r, 1_200));
    const second = await upsert('w3', '# c2');
    // 待ったことの確認(待ちが消されたら、この assert が先に落ちる)
    expect(second.updatedAt, '1 秒待ったのに更新時刻が動いていない').not.toBe(first.updatedAt);
    expect(second.createdAt, '更新で作成時刻が上書きされている').toBe(first.createdAt);
  });
});

describe('①b store-port が worker の値をそのまま渡す', () => {
  it('🔴 時刻を作り直さない(worker が返した値と同一)', async () => {
    // ⚠ ここが無いと「store-port が自分で now を作る」変異が**全部の test を素通り**する
    //    ── ① は worker を直に叩き、② は fake を注入するので、間の層だけ誰も見ていない
    const seen: unknown[] = [];
    const fakeClient = {
      request: async (req: { op: string }) => {
        seen.push(req);
        return { createdAt: '1999-12-31 23:59:58', updatedAt: '1999-12-31 23:59:59' };
      },
    } as unknown as Parameters<typeof createStorePort>[0];
    const port = createStorePort(fakeClient, 'c1');
    const got = await port.persistEntry({
      lid: 'a',
      title: 't',
      archetype: 'text',
      body: '# a',
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
    });
    expect(got).toEqual({ createdAt: '1999-12-31 23:59:58', updatedAt: '1999-12-31 23:59:59' });
    expect(seen).toHaveLength(1);
  });
});

// ── ② 書込経路(7 つ)が state へ流しているか ────────────────────

function meta(lid: string, order: number, over: Partial<EntryMeta> = {}): EntryMeta {
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
    ...over,
  };
}
const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 書込のたびに**違う値**を返す fake ── 「最後の書込の値」まで追える。 */
function stampingStore(bodies: Record<string, string>): {
  port: Parameters<typeof connectStoreEffects>[1];
  writes: number;
} {
  const state = { writes: 0 };
  const store = { ...bodies };
  const port = {
    ...stubRevisionOps(),
    getBody: async (lid: string) => store[lid] ?? null,
    persistEntry: async (e: EntryUpsert): Promise<EntryStamps> => {
      state.writes += 1;
      store[e.lid] = e.body;
      const n = String(state.writes).padStart(2, '0');
      return { createdAt: '2026-03-04 05:06:07', updatedAt: `2026-03-04 05:06:${n}` };
    },
    deleteEntry: async (lid: string) => {
      delete store[lid];
    },
  } as unknown as Parameters<typeof connectStoreEffects>[1];
  return {
    port,
    get writes() {
      return state.writes;
    },
  };
}

describe('② 書込のたびに state の meta が更新される', () => {
  it('🔴 保存(COMMIT_EDIT)で作成・更新が入る', async () => {
    const d = new Dispatcher();
    const s = stampingStore({ a: '# A' });
    connectStoreEffects(d, s.port);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    // 前提を assert(ゼロ件の次元を作らない ── 元が null であることが出発点)
    expect(d.getState().entryMetas.get('a')!.createdAt).toBeNull();

    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# A2' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await tick();

    const m = d.getState().entryMetas.get('a')!;
    expect(m.createdAt).toBe('2026-03-04 05:06:07');
    expect(m.updatedAt).toBe('2026-03-04 05:06:01');

    // 🔴 **2 回目の保存で更新が進むこと**まで見る。1 回だけでは「最初の書込の値を
    //    握ったまま固まる」実装でも通る(変異試験で実際に生存した)
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# A3' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await tick();

    expect(s.writes, '2 回目の保存が書込に到達していない').toBe(2);
    const m2 = d.getState().entryMetas.get('a')!;
    expect(m2.updatedAt, '更新時刻が 1 回目のまま').toBe('2026-03-04 05:06:02');
    expect(m2.createdAt, '作成時刻が書き換わっている').toBe('2026-03-04 05:06:07');
  });

  it('🔴 追記(APPEND_TO_ENTRY)でも更新が進む', async () => {
    const d = new Dispatcher();
    const s = stampingStore({ a: '# A' });
    connectStoreEffects(d, s.port);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text: '追記', heading: null });
    await tick();

    expect(s.writes, '追記が書込に到達していない(前提が崩れている)').toBeGreaterThan(0);
    expect(d.getState().entryMetas.get('a')!.updatedAt).toBe('2026-03-04 05:06:01');
  });

  it('🔴 題名の変更(RENAME)でも更新が進む', async () => {
    const d = new Dispatcher();
    const s = stampingStore({ a: '# A' });
    connectStoreEffects(d, s.port);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'a', title: '新しい題名' });
    await tick();

    expect(s.writes, 'rename が書込に到達していない').toBeGreaterThan(0);
    expect(d.getState().entryMetas.get('a')!.updatedAt).toBe('2026-03-04 05:06:01');
  });

  it('🔴 消えた entry の ack は捨てる(削除と書込の競合で復活させない)', () => {
    const d = new Dispatcher();
    const s = stampingStore({});
    connectStoreEffects(d, s.port);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    d.dispatch({
      type: 'ENTRY_STAMPED',
      lid: 'gone',
      createdAt: '2026-03-04 05:06:07',
      updatedAt: '2026-03-04 05:06:07',
    });
    expect(d.getState().entryMetas.has('gone')).toBe(false);
  });

  it('🔴 null の ack で既存の値を塗り潰さない', () => {
    const d = new Dispatcher();
    const s = stampingStore({});
    connectStoreEffects(d, s.port);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a', 1, { createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' })],
      relations: [],
    });
    d.dispatch({ type: 'ENTRY_STAMPED', lid: 'a', createdAt: null, updatedAt: null });
    expect(d.getState().entryMetas.get('a')!.createdAt).toBe('2026-01-01 00:00:00');
  });

  /**
   * 🔴 **経路を足した人が忘れないための網**。上の behavioral な 3 件は 7 経路のうち
   * 3 つしか通らない ── 残り(復元 / ゴミ箱戻し / トグル / タイル設定)は
   * 駆動に大掛かりな下地が要る。そこは**書込のそばに刻みが在ること**を
   * 原文で見る(「それらしいものが在るか」ではなく「**書込 1 回に対して刻み 1 回**」)。
   */
  it('🔴 persistEntry を呼ぶ経路の数と、刻む呼び出しの数が一致する', () => {
    const src = readFileSync('src/adapter/state/store-effects.ts', 'utf-8');
    const writes = [...src.matchAll(/await store\.persistEntry\(/g)].length;
    const stamps = [...src.matchAll(/^\s*stamp\(/gm)].length;
    expect(writes, '書込経路が 1 つも見つからない(scan が壊れている)').toBeGreaterThanOrEqual(7);
    expect(
      stamps,
      `書込 ${writes} 経路に対して刻みが ${stamps} 個 ── 足した経路が時刻を流していない`,
    ).toBe(writes);
  });
});

// ── ③ 画面(user が見る当の振る舞い)──────────────────────────

describe('③ 情報列に日付が出る', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('🔴 作ったノートの作成・更新が「—」ではなく日付になる', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    const detail = new DetailRenderer(regions.detail);
    const inspector = new InspectorRenderer(regions.inspector);
    d.onState((s) => {
      sidebar.render(s);
      detail.render(s);
      inspector.render(s);
    });
    bindActions(root, d);
    const s = stampingStore({});
    connectStoreEffects(d, s.port);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });

    createByUi(root, 'text');
    await tick(30);

    const created = root.querySelector('[data-pkc-field="inspector-created"]');
    const updated = root.querySelector('[data-pkc-field="inspector-updated"]');
    expect(created, '情報列に作成の行が無い').not.toBeNull();
    // ⚠ 「— ではない」で満足しない ── **日付として読める形**まで見る
    //    (空文字も「— ではない」を満たしてしまう)
    expect(created!.textContent).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
    expect(updated!.textContent).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
  });
});
