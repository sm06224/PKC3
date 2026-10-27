/**
 * 🔴 **改名のとき、ほかのノートのリンクの字を書き換える worker の口**(#1163 依頼 177、#1648)。
 *
 * 守る主張:
 * 1. 複数のノートを 1 回で書き換え、書き換えたノートと字を直したリンクの数を返す
 * 2. 旧い題名と違う字のリンクだけのノートは書かない(対照群)
 * 3. `skipLids`(編集中)のノートは書かない
 * 4. system 領域のノートには触れない
 * 5. 書き換えるのはラベルだけ(それ以外の byte は同じ)。題名・並びは保つ。履歴に 1 版積む
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

const CID = 'c-link-text';

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

const A = '前\n[旧い題名](entry:target#章) 後\n';
const B = '[旧い題名](entry:target) と [旧い題名](entry:target)\n';
const C = '[自分で付けた字](entry:target)\n';
const EDITING = '[旧い題名](entry:target)\n';
const SYS = '[旧い題名](entry:target)\n';

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  await request({ op: 'init', dbName: 'unit-test-link-text' });
  await request({ op: 'openContainer', cid: CID, title: 'link-text' });
  await put('target', '的\n', { title: '旧い題名', entryOrder: 1 });
  await put('a', A, { entryOrder: 2 });
  await put('b', B, { entryOrder: 3 });
  await put('c', C, { entryOrder: 4 });
  await put('editing', EDITING, { entryOrder: 5 });
  await put('sys', SYS, { entryOrder: 6, realm: 'system' });
}, 30_000);

describe('renameLinkTexts(worker の 1 tx)', () => {
  it('複数のノートを書き換え、ノート数とリンク数を返す。編集中・system・別の字だけのノートは書かない', async () => {
    const r = await request({
      op: 'renameLinkTexts',
      cid: CID,
      lid: 'target',
      oldTitle: '旧い題名',
      newTitle: '新しい題名',
      skipLids: ['editing'],
    });
    expect(r.wrote.map((w) => w.lid).sort()).toEqual(['a', 'b']);
    expect(r.links).toBe(3);

    expect(await bodyOf('a')).toBe('前\n[新しい題名](entry:target#章) 後\n');
    expect(await bodyOf('b')).toBe('[新しい題名](entry:target) と [新しい題名](entry:target)\n');
    // 書かないもの(1 byte も動かない)
    expect(await bodyOf('c')).toBe(C);
    expect(await bodyOf('editing')).toBe(EDITING);
    expect(await bodyOf('sys')).toBe(SYS);
  });

  it('題名・並びは保たれ、履歴に書き換え前の版が 1 つ積まれる', async () => {
    const metas = await request({ op: 'listEntryMetas', cid: CID });
    const a = metas.find((m) => m.lid === 'a')!;
    expect(a.title).toBe('t-a');
    expect(a.entry_order).toBe(2);
    const revs = await request({ op: 'listRevisionMetas', cid: CID, entryLid: 'a' });
    expect(revs.length, '書き換え前の版が履歴に積まれていない').toBeGreaterThanOrEqual(1);
  });

  it('もう一度同じ依頼を出しても、何も書かない(0 件)', async () => {
    const r = await request({
      op: 'renameLinkTexts',
      cid: CID,
      lid: 'target',
      oldTitle: '旧い題名',
      newTitle: '新しい題名',
      skipLids: ['editing'],
    });
    expect(r.wrote).toEqual([]);
    expect(r.links).toBe(0);
  });
});

describe('[[題名]] の書き換え(#1174 段②)', () => {
  const T = 'ウィキ旧題';
  it('🔴 改名で [[旧題]] / [[旧題|表示]] も新しい題名になる(コードの中・別の題名は触らない)', async () => {
    await put('wt', '的\n', { title: T, entryOrder: 10 });
    const fence = '```';
    const body = `前 [[${T}]] と [[${T}|表示]] と [[別の題名]]\n${fence}\n[[${T}]]\n${fence}\n`;
    await put('wl', body, { entryOrder: 11 });
    const r = await request({ op: 'renameLinkTexts', cid: CID, lid: 'wt', oldTitle: T, newTitle: 'ウィキ新題', skipLids: [] });
    expect(r.wrote.map((w) => w.lid)).toEqual(['wl']);
    expect(r.links).toBe(2);
    expect(await bodyOf('wl')).toBe(
      `前 [[ウィキ新題]] と [[ウィキ新題|表示]] と [[別の題名]]\n${fence}\n[[${T}]]\n${fence}\n`,
    );
  });

  it('🔴 [[題名]] で指されたノートの参照元に出る(コードの中・別の題名・同順位の同名・片付け済みは出さない)', async () => {
    await put('bt', '的\n', { title: 'バック題', entryOrder: 60 });
    await put('b1', '見て [[バック題]]\n', { entryOrder: 61 });
    await put('b2', '`[[バック題]]` はコード\n', { entryOrder: 62 });
    await put('b3', '[[別の題]]\n', { entryOrder: 63 });
    const r = await request({ op: 'findBacklinks', cid: CID, lid: 'bt' });
    expect(r.lids, '[[題名]] の参照元').toEqual(['b1']);
    // 同じ題名でより上(entry_order が小さい)のノートが居れば、[[題名]] はそちらを指す ── こちらの参照元ではない
    await put('bt2', '的\n', { title: 'バック題', entryOrder: 59 });
    const r2 = await request({ op: 'findBacklinks', cid: CID, lid: 'bt' });
    expect(r2.lids).toEqual([]);
    const r3 = await request({ op: 'findBacklinks', cid: CID, lid: 'bt2' });
    expect(r3.lids, '上のほうが参照元を受ける').toEqual(['b1']);
    // 対照群: 片付けた同名は数えない
    await put('bt3', '的\n', { title: '片付け同名', entryOrder: 70, archived: true });
    await put('bt4', '的\n', { title: '片付け同名', entryOrder: 71 });
    await put('b4', '[[片付け同名]]\n', { entryOrder: 72 });
    expect((await request({ op: 'findBacklinks', cid: CID, lid: 'bt4' })).lids).toEqual(['b4']);
    expect((await request({ op: 'findBacklinks', cid: CID, lid: 'bt3' })).lids, '片付けたノートは指されない').toEqual([]);
  });

  it('🔴 entry: のリンクと [[旧題]] が同じ行に同居しても、両方が 1 回の書き換えで直る(穴 E)', async () => {
    await put('co', '的\n', { title: '同居旧題', entryOrder: 50 });
    await put('cn', '[同居旧題](entry:co) と [[同居旧題]] と [自分の字](entry:co)\n', { entryOrder: 51 });
    const r = await request({ op: 'renameLinkTexts', cid: CID, lid: 'co', oldTitle: '同居旧題', newTitle: '同居新題', skipLids: [] });
    expect(r.links).toBe(2);
    expect(await bodyOf('cn')).toBe('[同居新題](entry:co) と [[同居新題]] と [自分の字](entry:co)\n');
  });

  it('🔴 新しい題名が既に別のノートの題名なら書き換えない(リンクが別のノートを指してしまう)/ 片付けた・ゴミ箱の同名は数えない(穴 F)', async () => {
    // 衝突: 改名先「衝突先」が在る → [[改名元1]] は書き換えない
    await put('ct', '的\n', { title: '改名元1', entryOrder: 30 });
    await put('cx', '別\n', { title: '衝突先', entryOrder: 31 });
    await put('cl', '[[改名元1]]\n', { entryOrder: 32 });
    const blocked = await request({ op: 'renameLinkTexts', cid: CID, lid: 'ct', oldTitle: '改名元1', newTitle: '衝突先', skipLids: [] });
    expect(blocked.wrote, '改名先が既にあるのに書き換えた').toEqual([]);
    expect(await bodyOf('cl')).toBe('[[改名元1]]\n');

    // 対照群 1: 改名先の同名が「片付けた」(archived)ノートだけなら、画面でも指されない ── 書き換える
    await put('ct2', '的\n', { title: '改名元2', entryOrder: 33 });
    await put('ca', '片付け\n', { title: '片付け済みの題', entryOrder: 34, archived: true });
    await put('cl2', '[[改名元2]]\n', { entryOrder: 35 });
    const ok1 = await request({ op: 'renameLinkTexts', cid: CID, lid: 'ct2', oldTitle: '改名元2', newTitle: '片付け済みの題', skipLids: [] });
    expect(ok1.wrote.map((w) => w.lid)).toEqual(['cl2']);
    expect(await bodyOf('cl2')).toBe('[[片付け済みの題]]\n');

    // 対照群 2: ゴミ箱へ移した同名ノートは `entries` に居ない ── 数えない
    await put('ct3', '的\n', { title: '改名元3', entryOrder: 36 });
    await put('cg', 'ごみ\n', { title: 'ゴミ箱の題', entryOrder: 37 });
    await request({ op: 'deleteEntry', cid: CID, lid: 'cg' });
    await put('cl3', '[[改名元3]]\n', { entryOrder: 38 });
    const ok2 = await request({ op: 'renameLinkTexts', cid: CID, lid: 'ct3', oldTitle: '改名元3', newTitle: 'ゴミ箱の題', skipLids: [] });
    expect(ok2.wrote.map((w) => w.lid)).toEqual(['cl3']);
  });

  it('🔴 新しい題名が ruby: / em: で始まるなら、別の記法に化けるので書き換えない', async () => {
    await put('rt', '的\n', { title: '改名元4', entryOrder: 40 });
    await put('rl', '[[改名元4]]\n', { entryOrder: 41 });
    for (const bad of ['ruby:x', 'em:強調']) {
      const r = await request({ op: 'renameLinkTexts', cid: CID, lid: 'rt', oldTitle: '改名元4', newTitle: bad, skipLids: [] });
      expect(r.wrote, bad).toEqual([]);
    }
    expect(await bodyOf('rl')).toBe('[[改名元4]]\n');
  });

  it('🔴 同じ題名のノートがほかにも在るときは書き換えない(どちらを指していたか分からない)', async () => {
    await put('dt1', '的\n', { title: '重複題', entryOrder: 20 });
    await put('dt2', '的\n', { title: '重複題', entryOrder: 21 });
    await put('dl', '[[重複題]]\n', { entryOrder: 22 });
    const r = await request({ op: 'renameLinkTexts', cid: CID, lid: 'dt2', oldTitle: '重複題', newTitle: '重複題の改', skipLids: [] });
    expect(r.wrote).toEqual([]);
    expect(await bodyOf('dl')).toBe('[[重複題]]\n');
  });
});
