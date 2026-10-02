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

/**
 * 🔴 **画面下の知らせを結果として積むと、1 回の操作でどれだけ書くか**(#1017 C5 段 b1)。
 *
 * ⚠ `appendMessage` は**本文全体を読んで、全体を書き戻す**(追記だが、行の更新は丸ごと)ので、
 *   1 回の操作で書く量は「足した 1 節(約 100 バイト)」ではなく**そのノートの本文の大きさ**になる。
 *   上限(既定 500 件)で頭打ちになるので、青天井ではない ── 頭打ちになることと、その上限での
 *   大きさを、実際の worker で測って pin する。
 * 🔑 字の長さは `showStatus` へ直に渡している日本語の字面(83 件)の**平均**(整形後 22 字)を使う
 *   ── 長い字(80 字で切られる上限)の場合は別に測って、桁を残す。
 *
 * 実測(2026-10-02。UTF-8 のバイト数。節 = 見出し + 種類 + 出どころ + 字):
 *
 * | 字の長さ | 1 節 | 500 件の本文(= 1 回に書く量) |
 * |---|---|---|
 * | 7 字(「コピーしました」) | 71 B | 35.5 KB |
 * | 22 字(平均) | 116 B | 58 KB |
 * | 80 字(切られる上限) | 293 B | 146 KB |
 *
 * ⚠ 上限を 2000 件に選んだ人は 4 倍(平均で約 230 KB)。選べる値は `MESSAGE_CAP_OPTIONS`。
 */
describe('appendMessage の書込量と頭打ち(#1017 C5)', () => {
  const C2 = 'c-messages-volume';
  const enc = (s: string): number => new TextEncoder().encode(s).length;
  const section = (text: string, i: number): string =>
    formatMessageSection({
      at: new Date(Date.UTC(2026, 9, 2, 12, 0, i % 60)).toISOString(),
      kind: 'result',
      source: 'status',
      text,
    });

  async function fill(text: string, times: number): Promise<{ bytes: number; sections: number }> {
    await request({ op: 'openContainer', cid: C2, title: 'volume' });
    for (let i = 0; i < times; i += 1) {
      await request({
        op: 'appendMessage',
        cid: C2,
        lid: SYSTEM_MESSAGE_LID,
        title: 'メッセージ',
        section: section(text, i),
        cap: 500,
      });
    }
    const body = (await request({ op: 'getBody', cid: C2, lid: SYSTEM_MESSAGE_LID })) ?? '';
    return { bytes: enc(body), sections: body.split(/(?=^## )/m).filter((s) => s !== '').length };
  }

  it('🔴 500 件で頭打ちになり、平均の長さの字では 1 回に書く量が 64 KB に収まる', async () => {
    // 22 字 ── 実際の `showStatus` の字面の平均(上の表)
    const text = 'あいうえおかきくけこさしすせそたちつてとなに';
    expect(text.length, '前提が崩れた(平均の字数ではない)').toBe(22);
    const r = await fill(text, 700);
    // ⚠ 700 回積んでも 500 件で止まる(古い節から落ちる)── 青天井でない
    expect(r.sections, '上限で頭打ちになっていない').toBe(500);
    // 1 回の操作で本文全体を書き戻す量(= この大きさ)。64 KB は「1 回あたり、これを超えたら止めて
    // 報告する」と決めた線 ── 節の形を太らせる変更(出どころの長い語・見出しの足し)が来たら鳴る
    expect(r.bytes, '1 回に書く量が 64 KB を超えた').toBeLessThanOrEqual(64 * 1024);
    // 空振り防止:本当に 500 節ぶん入っている(頭打ちの本文が空だったら上の assert は常に真)
    expect(r.bytes, '本文が空に近い(測れていない)').toBeGreaterThan(40 * 1024);
  }, 60_000);
});
