/**
 * 🔴 **リンクのない言及の worker の口**(#1966 4-1)── `findUnlinkedMentions` / `linkMentions`。
 *
 * 守る主張:
 * 1. 題名がただの字として出ているノートと、その箇所の数を返す(コード・リンクの中だけのノート、自分、system 領域、
 *    片付けたノートは出さない)
 * 2. 英字の大小を区別せずに探す(LIKE の候補と、合否の文法が食い違わない)
 * 3. `linkMentions` は 1 冊の言及を全部包み、コード・既存のリンクは 1 byte も変えない。題名・並びを保ち、履歴に 1 版積む
 * 4. もう一度頼んでも何も書かない / 包んだノートは言及から消え、参照元へ移る
 * 5. 1 字・日付だけの題名は探さない
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ResultMap, StorageRequest, StorageResponse } from '../../src/adapter/platform/storage/protocol';
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
    pending.set(id, (resp) => (resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error))));
    workerSelf.onmessage!({ data: { id, req } });
  });
}

const CID = 'c-mention';
const T = 'Weekly 会議';
const FENCE = '```';

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

const bodyOf = async (lid: string): Promise<string | null> => request({ op: 'getBody', cid: CID, lid });

const PLAIN = `今日の ${T} は延期\n- weekly 会議 の議事\n`;
const MIXED = `${FENCE}\n${T}\n${FENCE}\n[${T}](entry:target) と ${T}\n`;
const CODE_ONLY = `${FENCE}\n${T}\n${FENCE}\n\`${T}\`\n[${T}](entry:target)\n`;
const SELF = `自分の題名 ${T}\n`;

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  await request({ op: 'init', dbName: 'unit-test-mention' });
  await request({ op: 'openContainer', cid: CID, title: 'mention' });
  await put('target', SELF, { title: T, entryOrder: 1 });
  await put('plain', PLAIN, { entryOrder: 2 });
  await put('mixed', MIXED, { entryOrder: 3 });
  await put('code', CODE_ONLY, { entryOrder: 4 });
  await put('sys', PLAIN, { entryOrder: 5, realm: 'system' });
  await put('old', PLAIN, { entryOrder: 6, archived: true });
}, 30_000);

describe('findUnlinkedMentions', () => {
  it('🔴 ただの字として出ているノートと箇所の数(大小は区別しない)。コード・リンクの中だけ / 自分 / system / 片付け済みは出さない', async () => {
    const r = await request({ op: 'findUnlinkedMentions', cid: CID, lid: 'target' });
    expect(r.items).toEqual([
      { lid: 'plain', count: 2 },
      { lid: 'mixed', count: 1 },
    ]);
    expect(r.truncated).toBe(false);
  });

  it('⚠ 1 字・日付だけの題名は探さない(どこにでも当たる)', async () => {
    await put('day', '本文\n', { title: '2026-11-16', entryOrder: 20 });
    await put('daylog', '2026-11-16 の記録\n', { entryOrder: 21 });
    const r = await request({ op: 'findUnlinkedMentions', cid: CID, lid: 'day' });
    expect(r.items).toEqual([]);
  });
});

describe('🔴 読む量の上限(着地前レビュー ⚠8)', () => {
  it('候補の字数が上限に達したら止めて「ほかにもある」と言う(黙って切らない)', async () => {
    const { MENTION_SCAN_MAX_CHARS } = await import('../../src/adapter/platform/storage/storage-worker');
    await put('cap', '的\n', { title: '上限の題名', entryOrder: 30 });
    await put('big', `上限の題名 ${'あ'.repeat(MENTION_SCAN_MAX_CHARS)}`, { entryOrder: 31 });
    await put('after', '上限の題名 の続き\n', { entryOrder: 32 });
    const r = await request({ op: 'findUnlinkedMentions', cid: CID, lid: 'cap' });
    expect(r.items, '上限の後ろまで読んだ').toEqual([{ lid: 'big', count: 1 }]);
    expect(r.truncated, '切ったのに「ほかにもある」と言わない').toBe(true);
  });

  it('⚠ 対照群: 上限に達しなければ全部読み、切ったとは言わない', async () => {
    await put('cap2', '的\n', { title: '小さい題名', entryOrder: 40 });
    await put('s1', '小さい題名 1\n', { entryOrder: 41 });
    await put('s2', '小さい題名 2\n', { entryOrder: 42 });
    const r = await request({ op: 'findUnlinkedMentions', cid: CID, lid: 'cap2' });
    expect(r.items.map((x) => x.lid)).toEqual(['s1', 's2']);
    expect(r.truncated).toBe(false);
  });
});

describe('linkMentions(worker の 1 tx)', () => {
  it('🔴 1 冊の言及を全部包む ── コード・既存のリンクは 1 byte も変えない', async () => {
    const r = await request({ op: 'linkMentions', cid: CID, lid: 'target', sourceLid: 'mixed' });
    expect(r.links).toBe(1);
    expect(r.wrote?.lid).toBe('mixed');
    const want = `${FENCE}\n${T}\n${FENCE}\n[${T}](entry:target) と [${T}](entry:target)\n`;
    expect(r.wrote?.body).toBe(want);
    expect(await bodyOf('mixed')).toBe(want);
    // 頼んでいないノートは動かない
    expect(await bodyOf('plain')).toBe(PLAIN);
    expect(await bodyOf('code')).toBe(CODE_ONLY);
  });

  it('🔑 包むときは本文の字のまま(大小を変えない)。題名・並びを保ち、履歴に包む前の版を積む', async () => {
    const r = await request({ op: 'linkMentions', cid: CID, lid: 'target', sourceLid: 'plain' });
    expect(r.links).toBe(2);
    expect(await bodyOf('plain')).toBe(`今日の [${T}](entry:target) は延期\n- [weekly 会議](entry:target) の議事\n`);
    const metas = await request({ op: 'listEntryMetas', cid: CID });
    const m = metas.find((x) => x.lid === 'plain')!;
    expect(m.title).toBe('t-plain');
    expect(m.entry_order).toBe(2);
    const revs = await request({ op: 'listRevisionMetas', cid: CID, entryLid: 'plain' });
    expect(revs.length, '包む前の版が履歴に積まれていない').toBeGreaterThanOrEqual(1);
  });

  it('⚠ もう一度頼んでも何も書かない。包んだノートは言及から消え、参照元へ移る', async () => {
    const again = await request({ op: 'linkMentions', cid: CID, lid: 'target', sourceLid: 'plain' });
    expect(again).toEqual({ wrote: null, links: 0 });
    const left = await request({ op: 'findUnlinkedMentions', cid: CID, lid: 'target' });
    expect(left.items).toEqual([]);
    const back = await request({ op: 'findBacklinks', cid: CID, lid: 'target' });
    expect(back.lids).toEqual(expect.arrayContaining(['plain', 'mixed', 'code']));
  });

  it('⚠ system 領域のノート・自分自身は包まない', async () => {
    expect(await request({ op: 'linkMentions', cid: CID, lid: 'target', sourceLid: 'sys' })).toEqual({ wrote: null, links: 0 });
    expect(await bodyOf('sys')).toBe(PLAIN);
    expect(await request({ op: 'linkMentions', cid: CID, lid: 'target', sourceLid: 'target' })).toEqual({
      wrote: null,
      links: 0,
    });
    expect(await bodyOf('target')).toBe(SELF);
  });
});
