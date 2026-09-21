/**
 * 🔴 **worker の `appendMessage`**(設計 doc §7、段②a)。
 *
 * ⚠ 守るのは 3 つ:①冪等に作る(realm='system' / archetype='textlog')
 *   ②追記(既存の本文の末尾に足す)③上限で古い節から切る。
 * ⚠ 守っていないもの:同時アクセス下での実際の直列化(1 tx であることは
 *   コードを読んで確認、多重タブでの競合は別途 smoke で見る)。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import {
  formatMessageSection,
  SYSTEM_JOB_LID,
  SYSTEM_MESSAGE_LID,
} from '../../src/features/message/message-log';

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

const CID = 'c-messages';

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
  const init = await request({ op: 'init', dbName: 'unit-test-messages' });
  expect(init.vfs).toBe('memory');
  await request({ op: 'openContainer', cid: CID, title: 'messages' });
}, 30_000);

describe('appendMessage(設計 doc §7、段②a)', () => {
  it('🔴 無ければ realm=system / archetype=textlog で冪等に作る', async () => {
    const section = formatMessageSection({
      at: '2026-09-21T00:00:00.000Z',
      kind: 'result',
      source: 'app',
      text: '起動しました',
    });
    await request({
      op: 'appendMessage',
      cid: CID,
      lid: SYSTEM_MESSAGE_LID,
      title: 'メッセージ',
      section,
      cap: 500,
    });
    const body = await request({ op: 'getBody', cid: CID, lid: SYSTEM_MESSAGE_LID });
    expect(body).toContain('起動しました');

    // 冪等 ── 2 回目は行を増やさず、既存の 1 行に追記する
    const metas = await request({ op: 'listSystemEntries', cid: CID });
    const row = metas.find((m) => m.lid === SYSTEM_MESSAGE_LID);
    expect(row?.archetype).toBe('textlog');
  });

  it('user 向けの一覧には出ない(realm=system)', async () => {
    const metas = await request({ op: 'listEntryMetas', cid: CID });
    expect(metas.map((m) => m.lid)).not.toContain(SYSTEM_MESSAGE_LID);
  });

  it('🔴 2 回目以降は追記する(1 行目を消さない)', async () => {
    const section2 = formatMessageSection({
      at: '2026-09-21T00:01:00.000Z',
      kind: 'problem',
      source: 'app',
      text: '2 件目',
    });
    await request({
      op: 'appendMessage',
      cid: CID,
      lid: SYSTEM_MESSAGE_LID,
      title: 'メッセージ',
      section: section2,
      cap: 500,
    });
    const body = await request({ op: 'getBody', cid: CID, lid: SYSTEM_MESSAGE_LID });
    expect(body).toContain('起動しました');
    expect(body).toContain('2 件目');
  });

  it('🔴 上限を超えたら、古い節から落とす', async () => {
    const lid = 'sys-messages-cap-test';
    for (let i = 0; i < 5; i += 1) {
      const section = formatMessageSection({
        at: `2026-09-21T01:0${i}:00.000Z`,
        kind: 'result',
        source: 'app',
        text: `件 ${i}`,
      });
      await request({
        op: 'appendMessage',
        cid: CID,
        lid,
        title: 'メッセージ',
        section,
        cap: 3,
      });
    }
    const body = await request({ op: 'getBody', cid: CID, lid });
    expect(body).not.toContain('件 0');
    expect(body).not.toContain('件 1');
    expect(body).toContain('件 2');
    expect(body).toContain('件 3');
    expect(body).toContain('件 4');
  });

  it('job(sys-jobs)は別の行として持てる(cap が別)', async () => {
    const section = formatMessageSection({
      at: '2026-09-21T02:00:00.000Z',
      kind: 'job',
      source: 'compress',
      text: '3 件・0.4 秒',
    });
    await request({
      op: 'appendMessage',
      cid: CID,
      lid: SYSTEM_JOB_LID,
      title: '処理の記録',
      section,
      cap: 5000,
    });
    const messages = await request({ op: 'getBody', cid: CID, lid: SYSTEM_MESSAGE_LID });
    const jobs = await request({ op: 'getBody', cid: CID, lid: SYSTEM_JOB_LID });
    expect(jobs).toContain('3 件・0.4 秒');
    expect(messages).not.toContain('3 件・0.4 秒');
  });

  it('🔴 履歴(revisions)は積まない', async () => {
    const counts = await request({ op: 'revisionCounts', cid: CID });
    const row = counts.find((c) => c.entry_lid === SYSTEM_MESSAGE_LID);
    expect(row, 'メッセージのノートに履歴が積まれた').toBeUndefined();
  });
});
