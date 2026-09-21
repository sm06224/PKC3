/**
 * 🔴 **postMessage の口**(設計 doc §7、段②a)。
 *
 * ⚠ 守るのは:①中身を漏らさない(括弧の中身を潰す・80字で切る)②書けなければ
 *   控えへ積む ③控えは書けるようになった時点で流し込む ④未読の増減。
 * ⚠ 守っていないもの:実 IndexedDB との結線(`IdbMessageSpool` は fake で置換 ──
 *   実 IDB の作法は `asset-blob-store.ts` と同じ形なので、そちらの実績に乗る)。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MessagePost,
  type MessageSpool,
  type SpoolItem,
} from '../../src/adapter/platform/message-post';
import { SYSTEM_JOB_LID, SYSTEM_MESSAGE_LID } from '../../src/features/message/message-log';

/** in-memory の控え(実 IDB の代わり)。 */
class FakeSpool implements MessageSpool {
  private seq = 0;
  private map = new Map<number, SpoolItem>();

  async list(): Promise<ReadonlyArray<{ id: number; item: SpoolItem }>> {
    return [...this.map.entries()].map(([id, item]) => ({ id, item }));
  }
  async push(item: SpoolItem): Promise<void> {
    this.map.set(++this.seq, item);
  }
  async remove(id: number): Promise<void> {
    this.map.delete(id);
  }
  size(): number {
    return this.map.size;
  }
}

describe('MessagePost.post(中身を漏らさない)', () => {
  it('🔴 括弧の中身を潰し、80 字で切ってから書く', async () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    post.attach({ cid: 'c1', appendMessage });
    post.post({ kind: 'problem', source: 'app', text: '「秘密のノート」を開けません' });
    await Promise.resolve();
    await Promise.resolve();
    expect(appendMessage).toHaveBeenCalledTimes(1);
    const call = appendMessage.mock.calls[0]?.[0] as { section: string };
    expect(call.section).toContain('「…」を開けません');
    expect(call.section).not.toContain('秘密のノート');
  });

  it('種類で行き先が変わる(job は sys-jobs)', async () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    post.attach({ cid: 'c1', appendMessage });
    post.post({ kind: 'job', source: 'compress', text: '3 件' });
    // ⚠ job は束ねる(段②b)── 明示的に流さないと書かれない
    post.flushJobBuffer();
    await Promise.resolve();
    await Promise.resolve();
    const call = appendMessage.mock.calls[0]?.[0] as { lid: string; cap: number };
    expect(call.lid).toBe(SYSTEM_JOB_LID);
    expect(call.cap).toBe(5000);
  });

  it('result / caution / problem / delivery は sys-messages へ', async () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    post.attach({ cid: 'c1', appendMessage });
    post.post({ kind: 'result', source: 'app', text: 'x' });
    await Promise.resolve();
    await Promise.resolve();
    const call = appendMessage.mock.calls[0]?.[0] as { lid: string };
    expect(call.lid).toBe(SYSTEM_MESSAGE_LID);
  });
});

describe('MessagePost ── 書けないときは控えへ積み、書けたら流す', () => {
  it('🔴 appendMessage が落ちたら、控えへ積む(捨てない)', async () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    const appendMessage = vi.fn().mockRejectedValue(new Error('壊れている'));
    post.attach({ cid: 'c1', appendMessage });
    post.post({ kind: 'result', source: 'app', text: 'x' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(spool.size()).toBe(1);
  });

  it('🔴 次に書けたときは、控えを先に流してから新しい分を書く(順序を守る)', async () => {
    const spool = new FakeSpool();
    await spool.push({ cid: 'c1', lid: SYSTEM_MESSAGE_LID, title: 'メッセージ', section: '## old\n古い節\n\n', cap: 500 });
    const post = new MessagePost(spool);
    const order: string[] = [];
    const appendMessage = vi.fn().mockImplementation(async (req: { section: string }) => {
      order.push(req.section);
    });
    post.attach({ cid: 'c1', appendMessage });
    // attach 自体が flush を起こすので、まず控えの 1 件が流れるのを待つ
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    post.post({ kind: 'result', source: 'app', text: '新しい件' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(spool.size()).toBe(0);
    expect(order[0]).toContain('古い節');
    expect(order.some((s) => s.includes('新しい件'))).toBe(true);
  });

  it('boot 前(attach されていない)に post しても、控えへ積んで捨てない', async () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    post.post({ kind: 'result', source: 'app', text: 'boot 前' });
    await Promise.resolve();
    await Promise.resolve();
    expect(spool.size()).toBe(1);
  });
});

describe('未読の数', () => {
  it('注意・問題だけ増える', () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    const seen: number[] = [];
    post.onUnreadChanged((n) => seen.push(n));
    post.attach({ cid: 'c1', appendMessage: vi.fn().mockResolvedValue(undefined) });
    post.post({ kind: 'result', source: 'app', text: 'x' });
    post.post({ kind: 'caution', source: 'app', text: 'y' });
    post.post({ kind: 'problem', source: 'app', text: 'z' });
    expect(seen).toEqual([1, 2]);
  });

  it('🔴 markRead で 0 に戻る', () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    const seen: number[] = [];
    post.onUnreadChanged((n) => seen.push(n));
    post.attach({ cid: 'c1', appendMessage: vi.fn().mockResolvedValue(undefined) });
    post.post({ kind: 'problem', source: 'app', text: 'z' });
    post.markRead();
    expect(seen).toEqual([1, 0]);
  });

  it('seedUnread で起動直後の未読を種にできる', () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    const seen: number[] = [];
    post.onUnreadChanged((n) => seen.push(n));
    post.seedUnread(3);
    expect(seen).toEqual([3]);
  });
});

/**
 * 🔴 **job だけ束ねる**(設計 doc §7、段②b)。
 *
 * ⚠ 守るのは:①50 件で自動的に 1 回書く ②50 件に満たなくても 5 秒で 1 回書く
 *   ③`flushJobBuffer()`(pagehide / visibilitychange:hidden の代わり)で残りを流す
 *   ④**job 以外は束ねない**(対照群 ── 即座に 1 回書く、既存の挙動のまま)。
 */
describe('MessagePost ── job だけ束ねる(段②b)', () => {
  it('🔴 50 件目で、1 回の appendMessage にまとめて書く', async () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    post.attach({ cid: 'c1', appendMessage });
    await Promise.resolve();
    for (let i = 0; i < 49; i++) post.post({ kind: 'job', source: 'compress', text: `${i}` });
    await Promise.resolve();
    await Promise.resolve();
    expect(appendMessage, '49 件目ではまだ書かない').not.toHaveBeenCalled();

    post.post({ kind: 'job', source: 'compress', text: '49' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(appendMessage, '50 件目で 1 回書く').toHaveBeenCalledTimes(1);
    const call = appendMessage.mock.calls[0]?.[0] as { section: string; lid: string };
    expect(call.lid).toBe(SYSTEM_JOB_LID);
    // 50 件ぶんの節が、1 回の appendMessage に連結されて渡っている
    expect(call.section.split('## ').length - 1, '節の数が 50 件でない').toBe(50);
  });

  it('🔴 50 件に満たなくても、5 秒経てば 1 回書く', async () => {
    vi.useFakeTimers();
    try {
      const spool = new FakeSpool();
      const post = new MessagePost(spool);
      const appendMessage = vi.fn().mockResolvedValue(undefined);
      post.attach({ cid: 'c1', appendMessage });
      await Promise.resolve();
      post.post({ kind: 'job', source: 'compress', text: '1 件' });
      expect(appendMessage, '5 秒経つ前に書いている').not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(appendMessage, '5 秒経っても書いていない').toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 flushJobBuffer() で、閉じる前の残りを流す(pagehide の代わり)', async () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    post.attach({ cid: 'c1', appendMessage });
    await Promise.resolve();
    post.post({ kind: 'job', source: 'compress', text: '1 件' });
    expect(appendMessage).not.toHaveBeenCalled();

    post.flushJobBuffer();
    await Promise.resolve();
    await Promise.resolve();
    expect(appendMessage).toHaveBeenCalledTimes(1);

    // ⚠ 空のまま呼んでも、空の appendMessage を打たない(対照群)
    post.flushJobBuffer();
    await Promise.resolve();
    expect(appendMessage, '溜まっていないのに書いた').toHaveBeenCalledTimes(1);
  });

  it('job 以外は束ねない(対照群 ── これまでどおり即座に 1 回書く)', async () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    post.attach({ cid: 'c1', appendMessage });
    post.post({ kind: 'result', source: 'app', text: 'x' });
    await Promise.resolve();
    await Promise.resolve();
    expect(appendMessage, '束ねずに済むはずの種類が、束ねられている').toHaveBeenCalledTimes(1);
  });
});
