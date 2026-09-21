/**
 * 🔴 **拾い出し(rescueEntries)の realm 除外は、壊れの診断を汚さない**
 * (設計 doc §1.1、段①)。
 *
 * ## なぜ file を分けたか
 *
 * この test だけ rowid の並びを自分で作り込む必要がある(`rescueEntries` に
 * `cid` は無く、DB 全体を rowid で舐めるため)。他の test と同じ file に置くと、
 * 先に作られた行が rowid の頭を取ってしまい、chunk 境界(200 行区切り)を
 * 狙って作れない ── だから専用の worker(専用の :memory: DB)を持つ。
 *
 * ## 何を確かめるか
 *
 * `rescueEntries` は「空だった区画」(`empty`)を**壊れの診断**として返す
 * (`rescue-archive.ts` が `空だった区画 N` として user に出す)。
 * ⚠ 直す前の 1 稿目は `WHERE realm = 'user'` を素朴に足す案だった ──
 *   その形だと、**system のノートだけが並ぶ区画**は raw には行が在るのに
 *   `rows` が 0 件になり、`got === 0` と数えて**壊れていないのに「空だった」と
 *   誤って報告する**(CLAUDE.md §1「後条件は確かめた事実の上にだけ書く」の逆:
 *   「診断の材料を、除外の都合で減らさない」)。
 * 🔑 実装は **`WHERE` では絞らず、`rows` へ積む段だけで選ぶ**(`got` は raw の
 *   行数のまま)── ここではその選択が正しく効いていることを、
 *   **1 chunk を丸ごと system 行で埋めて**確かめる。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import { RESCUE_CHUNK } from '../../src/features/storage/db-rescue';

type Op = StorageRequest['op'];

const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(
  req: Extract<StorageRequest, { op: O }>,
): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) =>
      resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
    );
    workerSelf.onmessage!({ data: { id, req } });
  });
}

const CID = 'c-rescue-realm';

const putSystem = (lid: string) =>
  request({
    op: 'upsertEntry',
    cid: CID,
    entry: {
      lid,
      title: `sys-${lid}`,
      archetype: 'text',
      body: '',
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      realm: 'system',
    },
    checkpoint: false,
  });

const putUser = (lid: string) =>
  request({
    op: 'upsertEntry',
    cid: CID,
    entry: {
      lid,
      title: `usr-${lid}`,
      archetype: 'text',
      body: '',
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
    },
    checkpoint: false,
  });

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (
    msg: StorageResponse,
  ) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-test-rescue-realm' });
  expect(init.vfs).toBe('memory');
  await request({ op: 'openContainer', cid: CID, title: 'rescue-realm' });

  // ⚠ **1 chunk 分(RESCUE_CHUNK 件)を system のノートだけで埋める** ──
  //   entries には他のノートが 1 件も無いので、rowid はここから 1 起番になる。
  //   これで chunk 1(rowid 1..RESCUE_CHUNK)は system だけになる。
  for (let i = 0; i < RESCUE_CHUNK; i += 1) await putSystem(`sys-${i}`);
  // chunk 2 の頭に user のノートを 1 件だけ置く(対照群 ── 空振り防止)
  await putUser('the-user-note');
}, 30_000);

describe('拾い出し(rescueEntries)の realm 除外は診断を汚さない(設計 doc §1.1、段①)', () => {
  it('system だけの chunk は「空だった」に数えない(誤った壊れ診断を作らない)', async () => {
    const r = await request({ op: 'rescueEntries', afterRowid: 0, chunks: 2 });
    const lids = r.rows.map((row) => row.lid);
    // 主張① ── system のノートは 1 件も出力に出ない
    expect(lids.some((l) => l.startsWith('sys-')), 'system のノートが漏れた').toBe(false);
    // 主張② ── 対照群の user ノートは出る(検査が空振りしていないこと)
    expect(lids, '対照群が出ていない(検査が空振りしている)').toContain('the-user-note');
    // 主張③(本題) ── system だけの chunk 1 は「空だった」に数えていない
    expect(
      r.empty,
      'system のノートしか無い区画を「空だった」と誤って数えた(壊れていないのに壊れの警告が出る)',
    ).toBe(0);
    expect(r.skipped, '読めなかった区画が在る(前提が崩れている)').toBe(0);
  });
});
