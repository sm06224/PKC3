/**
 * 🔴 **計った時間の走査(workLogScan)**(#683 ①)── 実 worker(memory VFS)に対して見る。
 *
 * 見るのは:①本文の「作業」の行だけが行番号つきで返る(対照: 作業の行が無いノートは出ない)
 * ②system 領域のノートは漏れない ③コード囲みの中の行は拾わない ④無関係な本文に「作業 」があっても行にならない
 * ⑤本文は返らない(返るのは行だけ)。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';

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

const CID = 'c-worklog';

const put = (lid: string, body: string, over: Partial<EntryUpsert> = {}) =>
  request({
    op: 'upsertEntry',
    cid: CID,
    entry: {
      lid,
      title: `t-${lid}`,
      archetype: 'text',
      body,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      ...over,
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
  await request({ op: 'init', dbName: 'unit-test-worklog' });
  await request({ op: 'openContainer', cid: CID, title: 'worklog' });
  await put(
    'u-work',
    '会議メモ\n\n- 作業 2026-08-27 06:40–07:03(23:11) 見積\n- 作業 2026-08-28 09:00–09:30(30:00)\n',
    { entryOrder: 2 },
  );
  // 対照群 ── 「作業 」を含むが行の形ではない / 含まない
  await put('u-prose', '今日の作業 はここまで。\n- 作業 メモ\n', { entryOrder: 3 });
  await put('u-plain', '何もない\n', { entryOrder: 4 });
  // コードの囲みの中は読まない
  await put('u-code', '```\n- 作業 2026-08-27 06:40–07:03(23:11)\n```\n', { entryOrder: 5 });
  // system 領域は漏れない
  await put('sys-w', '- 作業 2026-08-27 10:00–10:10(10:00)\n', { entryOrder: 6, realm: 'system' });
}, 30_000);

describe('計った時間の走査(workLogScan)', () => {
  it('🔴 作業の行だけが、行番号と名前つきで返る', async () => {
    const r = await request({ op: 'workLogScan', cid: CID });
    const mine = r.runs.filter((x) => x.lid === 'u-work');
    expect(mine.map((x) => [x.line, x.from, x.to, x.span, x.label])).toEqual([
      [2, '2026-08-27 06:40', '2026-08-27 07:03', '23:11', '見積'],
      [3, '2026-08-28 09:00', '2026-08-28 09:30', '30:00', ''],
    ]);
    expect(mine[0]!.rawLine).toBe('- 作業 2026-08-27 06:40–07:03(23:11) 見積');
    expect(r.truncated).toBe(false);
    expect(r.scannedNotes, '候補を SQL で絞れていない(全部読んでいる)').toBeLessThan(r.totalNotes);
    expect(r.scannedNotes).toBeGreaterThanOrEqual(2);
  });

  it('🔴 作業の行の形でないもの・コードの囲みの中・system 領域は出ない(対照群は出ている)', async () => {
    const r = await request({ op: 'workLogScan', cid: CID });
    const lids = new Set(r.runs.map((x) => x.lid));
    expect(lids.has('u-work'), '対照群が出ていない(検査が空振りしている)').toBe(true);
    expect(lids.has('u-prose'), '行の形でない本文が出た').toBe(false);
    expect(lids.has('u-plain')).toBe(false);
    expect(lids.has('u-code'), 'コードの囲みの中の行が出た').toBe(false);
    expect(lids.has('sys-w'), 'system 領域のノートが計った時間に漏れた').toBe(false);
  });

  it('返るのは行だけで、本文は返らない', async () => {
    const r = await request({ op: 'workLogScan', cid: CID });
    const json = JSON.stringify(r);
    expect(json).not.toContain('会議メモ');
  });
});
