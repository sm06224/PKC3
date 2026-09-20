/**
 * 🔴 **本当に壊れた DB を worker へ食わせて、救出の口が押せるかを見る**(#971 段③)。
 *
 * ## なぜ file を分けたか
 *
 * 壊れの旗(`dbCorrupt`)は worker の**module の変数**で、一度立つと下ろさない
 * (壊れた DB は次の 1 文で治らないため)。⚠ だから同じ file の後ろに在る test が
 * 全部書けなくなる ── **旗を立てる test は、専用の worker を持つ file に置く**。
 *
 * ## 🔴 1 稿目は空振りだった(足した当日に気づいた)
 *
 * 最初は `storage-worker.test.ts` の中で「壊れの字で落ちる op」を撃って旗を立てた
 * つもりだったが、⚠ **撃った op は壊れの字では落ちない**ので旗は立っておらず、
 * 「壊れていても押せる」の主張は**健全な DB で押しただけ**だった(§1 の空振り)。
 * 🔑 だからここでは **旗が立っていることを前提として assert する** ──
 * 立っていなければ「一致しなかった」ではなく「**前提が崩れている**」で落ちる。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import { CORRUPT_REFUSAL } from '../../src/features/storage/db-corruption';
import { parseQuickCheck } from '../../src/features/storage/db-rescue';
import { CONTAINER_REBUILD_LABEL } from '../../src/features/storage/rescue-labels';
import { runStartupIntegrity } from '../../src/adapter/platform/storage/startup-integrity';

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

/** 壊れた DB の画像を作る。⚠ 壊すのは **PK の自動索引**(= 表は読める側)。 */
async function brokenImage(): Promise<{ image: Uint8Array; rows: number }> {
  const api = (await sqlite3InitModule()) as unknown as {
    oo1: { DB: new (f: string, m: string) => {
      exec: (o: { sql: string; callback?: (r: unknown[]) => void; rowMode?: 'array' }) => void;
      selectValue: (sql: string) => unknown;
      close: () => void;
      pointer: number;
    } };
    capi: Record<string, (...a: never[]) => unknown>;
  };
  const db = new api.oo1.DB(':memory:', 'c');
  // ⚠ 列は**製品と同じ並び**にする(`CREATE TABLE IF NOT EXISTS` を素通りさせる)
  db.exec({
    sql: `CREATE TABLE entries (
       cid TEXT NOT NULL, lid TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
       archetype TEXT NOT NULL DEFAULT 'text', created_at TEXT, updated_at TEXT,
       entry_order INTEGER NOT NULL DEFAULT 0, status TEXT, date TEXT,
       archived INTEGER NOT NULL DEFAULT 0, task_total INTEGER, body_chars INTEGER,
       body_tags TEXT, body TEXT NOT NULL DEFAULT '', PRIMARY KEY (cid, lid))`,
  });
  const ROWS = 400;
  db.exec({ sql: 'BEGIN' });
  for (let i = 0; i < ROWS; i += 1) {
    db.exec({
      sql: `INSERT INTO entries (cid, lid, title, archetype, body)
            VALUES ('c1','k${i}','題 ${i}','text','壊れる前に書いた本文 ${i}')`,
    });
  }
  db.exec({ sql: 'COMMIT' });

  const pageSize = Number(db.selectValue('PRAGMA page_size'));
  let root = 0;
  db.exec({
    sql: "SELECT rootpage FROM sqlite_schema WHERE type='index' AND tbl_name='entries'",
    rowMode: 'array',
    callback: (r: unknown[]): void => {
      if (root === 0) root = Number(r[0]);
    },
  });
  expect(root, 'PK の自動索引を引けていない(壊す場所が決まらない)').toBeGreaterThan(1);
  const image = (api.capi.sqlite3_js_db_export as unknown as (p: number) => Uint8Array)(db.pointer);
  db.close();

  // 🔑 root page の中身を潰す ── 実測でここが `Tree <root> page …` として報告される
  const off = (root - 1) * pageSize;
  for (let i = 0; i < 400; i += 1) image[off + 12 + i] = 0x5a;
  return { image, rows: ROWS };
}

let seeded = 0;

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const { image, rows } = await brokenImage();
  seeded = rows;
  // ⚠ 画像は `memory: true` と一緒でないと受け付けない(製品の作法)
  await request({ op: 'init', dbName: 'unit-corrupt', memory: true, image });
}, 30_000);

describe('壊れた DB でも救出の口は押せる(#971 段③)', () => {
  /**
   * 🔴 **前提の assert** ── ここが落ちたら「救出できた」ではなく
   *   「**壊れた DB を用意できていない**」と読む。
   */
  it('🔴 前提: 書き込みが壊れを見つけて止まる', async () => {
    await expect(
      request({
        op: 'upsertEntry',
        cid: 'c1',
        entry: {
          lid: 'k1',
          title: '書けないはず',
          archetype: 'text',
          body: '書けないはず',
          entryOrder: 1,
          status: null,
          date: null,
          archived: false,
        },
      }),
      '壊れた DB なのに書けてしまった(= 壊し方が効いていない)',
    ).rejects.toThrow();

    // 🔑 2 回目は**旗が立った後**なので、断り文そのもので断られる
    await expect(
      request({ op: 'reorderEntry', cid: 'c1', lid: 'k1', entryOrder: 9 }),
      '旗が立っていない(この file の主張が空振りしている)',
    ).rejects.toThrow(CORRUPT_REFUSAL);
  });

  it('🔴 止まった後でも「調べる」は押せて、壊れた目次の名前が出る', async () => {
    const res = await request({ op: 'checkIntegrity' });
    expect(res.rows.length, '調べる口まで止まった').toBeGreaterThan(0);
    const report = parseQuickCheck(res.rows, res.schema);
    expect(report.ok, '壊れているのに無事と読んだ').toBe(false);
    // 🔑 壊したのは索引なので、**本文の表を巻き込んでいない**こと
    expect(report.brokenIndexes.length, '壊れた目次を名指しできていない').toBeGreaterThan(0);
  });

  it('🔴 止まった後でも「拾えるだけ取り出す」で本文が返る', async () => {
    const seen = new Map<string, string>();
    let after = 0;
    let pages = 0;
    for (;;) {
      const page = await request({ op: 'rescueEntries', afterRowid: after, chunks: 4 });
      pages += 1;
      for (const r of page.rows) seen.set(r.lid, r.body);
      after = page.lastRowid;
      if (page.done || pages > 60) break;
    }
    // 🔑 索引だけ壊れているときは**1 行も失われない**(実測)── 全部返ることを見る
    expect(seen.size, `拾えた件数が足りない(${seen.size} / ${seeded})`).toBe(seeded);
    expect(seen.get('k7'), '本文が空で返っている').toContain('壊れる前に書いた本文 7');
  });
});

/**
 * 🔴 **起動の検め(#1007 段①)を、本当に壊れた DB で通す**。
 *
 * ⚠ 上の describe で旗が立っている(前提)── ここは**旗が立った後**の振る舞いである:
 *   計画と表ごとの検めは**通り**、印を残す書き込みだけ**断られる**。
 */
describe('起動の検めは、壊れた DB で壊れを名指しし、印を残さない(#1007 段①)', () => {
  it('🔴 表ごとの検めが、壊れた目次をその表の回で名指しする(他の表は ok)', async () => {
    const plan = await request({ op: 'integrityPlan' });
    expect(plan.tables, '本文の表が計画に無い(空振り)').toContain('entries');
    const hit = await request({ op: 'checkIntegrity', table: 'entries' });
    const report = parseQuickCheck(hit.rows, hit.schema);
    expect(report.ok, '壊れているのに entries の回で無事と読んだ').toBe(false);
    expect(report.brokenIndexes.length).toBeGreaterThan(0);
    // 🔑 壊れていない表の回は ok ── 表ごとに分けた意味(壊れが他の表に漏れない)
    for (const table of plan.tables.filter((t) => t !== 'entries')) {
      const res = await request({ op: 'checkIntegrity', table });
      expect(res.rows, `${table} まで壊れと言っている`).toEqual(['ok']);
    }
  });

  it('🔴 旗が立った後は、印を残す書き込みだけ断られる', async () => {
    await expect(request({ op: 'integrityStamp', at: '2026-09-20T00:00:00.000Z' })).rejects.toThrow(
      CORRUPT_REFUSAL,
    );
    expect((await request({ op: 'integrityPlan' })).lastCheckedAt, '断られたのに印が残った').toBeNull();
  });

  it('🔴 駆動部を繋ぐと broken ── 次の一手つきの字が出て、印は残らない', async () => {
    const broken: string[] = [];
    const outcome = await runStartupIntegrity({
      request,
      isHost: () => true,
      now: () => Date.now(),
      wait: async () => {},
      cancelled: () => false,
      visible: () => true,
      onceVisible: async () => {},
      onBroken: (t) => {
        broken.push(t);
      },
    });
    expect(outcome).toBe('broken');
    expect(broken).toHaveLength(1);
    expect(broken[0]).toContain('起動のときに');
    expect(broken[0], '次の一手(画面の字)が無い').toContain(CONTAINER_REBUILD_LABEL);
    expect((await request({ op: 'integrityPlan' })).lastCheckedAt).toBeNull();
  });
});
