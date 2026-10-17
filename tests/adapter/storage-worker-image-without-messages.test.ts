/** @vitest-environment node */
/**
 * 🔴 **人に渡す PKC3 入り HTML に、メッセージと処理の記録を入れない**(台帳 #1852 束 L1。依頼 216 / 344)。
 *
 * 直す前は、DB の画像をそのまま焼いていたので、送り主の「システム」のメッセージと処理の記録(使った機能と時刻)も入った。
 * 受け取った人が開くと、送り主の知らせが「未読」として出た。
 *
 * 守るもの(実物の sqlite で見る):
 *   ① `withoutMessages` の画像を別の worker で読み直すと、メッセージも処理の記録も無い(ノートは全部ある)
 *   ② 対照群:ふつうの `exportImage` の画像には、メッセージが入っている(①の主張が空振りでないこと)
 *   ③ 書き出した後も、書き出した側の DB のメッセージは減っていない(除くのは書き出す間だけ)
 *   ④ 書き出す側の本文と、メッセージ以外のノートは 1 件も動かない
 * 守っていないもの:`secure_delete` で空きページに名残が残らないこと(sqlite の振る舞いを信じている)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
interface Worker {
  request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]>;
  close(): Promise<void>;
}

/** 生きている worker は常に 1 本(`storage-worker-image.test.ts` と同じ作法 ── 返事が 2 本目へ落ちる)。 */
let live: Worker | null = null;

async function spawn(): Promise<Worker> {
  if (live) {
    await live.close().catch(() => undefined);
    live = null;
  }
  vi.resetModules();
  const pending = new Map<number, (resp: StorageResponse) => void>();
  let seq = 0;
  const workerSelf: { onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null } = {
    onmessage: null,
  };
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const send = <O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (resp) => (resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error))));
      workerSelf.onmessage!({ data: { id, req } });
    });
  const w: Worker = { request: send, close: async () => void (await send({ op: 'close' })) };
  live = w;
  return w;
}

afterEach(async () => {
  if (live) await live.close().catch(() => undefined);
  live = null;
});

const section = (kind: 'problem' | 'job', text: string, i: number): string =>
  formatMessageSection({ at: new Date(Date.UTC(2026, 9, 2, 12, 0, i)).toISOString(), kind, source: 'status', text });

async function seed(w: Worker): Promise<void> {
  await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
  await w.request({
    op: 'upsertEntry',
    cid: 'c1',
    entry: { lid: 'e1', title: '題', archetype: 'text', body: '本文のまま\n', entryOrder: 1, status: null, date: null, archived: false },
    checkpoint: false,
  });
  await w.request({ op: 'appendMessage', cid: 'c1', lid: SYSTEM_MESSAGE_LID, title: 'メッセージ', section: section('problem', '送り主の知らせ', 1), cap: 500 });
  await w.request({ op: 'appendMessage', cid: 'c1', lid: SYSTEM_JOB_LID, title: '処理の記録', section: section('job', '送り主の処理', 2), cap: 500 });
}

describe('人に渡す画像にはメッセージを入れない(依頼 216 / 344)', () => {
  it('🔴 ①② メッセージ抜きの画像には、メッセージも処理の記録も無く、ノートは残る(対照:ふつうの画像には入っている)', async () => {
    const a = await spawn();
    await a.request({ op: 'init', dbName: 'wm1', memory: true });
    await seed(a);

    const full = (await a.request({ op: 'exportImage' })).image;
    const lean = (await a.request({ op: 'exportImage', withoutMessages: true })).image;
    expect(full.byteLength, '前提:画像が出ていない').toBeGreaterThan(1000);

    // 対照群:ふつうの画像を別の worker で開くと、メッセージが在る
    const b = await spawn();
    await b.request({ op: 'init', dbName: 'wm1', memory: true, image: full });
    expect(await b.request({ op: 'getBody', cid: 'c1', lid: SYSTEM_MESSAGE_LID }), '対照:ふつうの画像にメッセージが無い(検査が空振り)').toContain('送り主の知らせ');
    expect(await b.request({ op: 'getBody', cid: 'c1', lid: SYSTEM_JOB_LID })).toContain('送り主の処理');

    // 本体:メッセージ抜きの画像
    const c = await spawn();
    await c.request({ op: 'init', dbName: 'wm1', memory: true, image: lean });
    expect(await c.request({ op: 'getBody', cid: 'c1', lid: SYSTEM_MESSAGE_LID }), 'メッセージが入っている').toBeNull();
    expect(await c.request({ op: 'getBody', cid: 'c1', lid: SYSTEM_JOB_LID }), '処理の記録が入っている').toBeNull();
    expect(await c.request({ op: 'getBody', cid: 'c1', lid: 'e1' }), 'ノートが欠けた').toBe('本文のまま\n');
    // 画像の中に字そのものが残っていない(空きページに名残が無い)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(lean);
    expect(text.includes('送り主の知らせ'), '画像の中に、除いたはずの知らせの字が残っている').toBe(false);
    expect(text.includes('送り主の処理')).toBe(false);
  }, 60_000);

  it('🔴 ③④ 書き出した後も、書き出した側のメッセージは減らず、ノートは動かない', async () => {
    const a = await spawn();
    await a.request({ op: 'init', dbName: 'wm2', memory: true });
    await seed(a);
    const before = await a.request({ op: 'getBody', cid: 'c1', lid: SYSTEM_MESSAGE_LID });
    expect(before, '前提:メッセージが無い').toContain('送り主の知らせ');

    await a.request({ op: 'exportImage', withoutMessages: true });

    expect(await a.request({ op: 'getBody', cid: 'c1', lid: SYSTEM_MESSAGE_LID }), 'メッセージが減った').toBe(before);
    expect(await a.request({ op: 'getBody', cid: 'c1', lid: SYSTEM_JOB_LID })).toContain('送り主の処理');
    expect(await a.request({ op: 'getBody', cid: 'c1', lid: 'e1' })).toBe('本文のまま\n');
    // 戻した行が「システムのノート」のまま(一覧に混ざらない)── realm が保たれている
    const sys = await a.request({ op: 'listSystemEntries', cid: 'c1' });
    expect(sys.map((r) => r.lid).sort()).toEqual([SYSTEM_JOB_LID, SYSTEM_MESSAGE_LID].sort());
    const user = await a.request({ op: 'listEntryMetas', cid: 'c1' });
    expect(user.map((r) => r.lid), 'システムのノートが user の一覧に混ざった').toEqual(['e1']);
  }, 60_000);

  it('メッセージがまだ 1 件も無い入れ物でも、そのまま出せる(何も除かない)', async () => {
    const a = await spawn();
    await a.request({ op: 'init', dbName: 'wm3', memory: true });
    await a.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
    const { image } = await a.request({ op: 'exportImage', withoutMessages: true });
    expect(image.byteLength).toBeGreaterThan(1000);
  }, 60_000);
});
