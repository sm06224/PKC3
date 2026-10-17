/**
 * 🔴 **書けずに控えへ回った節を、画面と書き出しが読む**(#1087 M1)/ **既読と同じ秒の注意を未読に数える**(M5)。
 *
 * ⚠ 守るのは:①本文の後ろへ控えの節が作られた順に付く(整形はそのまま)②本文が空 / 読めないなら控えだけを返す
 *   ③他の lid・他の入れ物の控えは混ぜない ④読み手 2 つ(画面の読み込み・書き出し)が `withSpool` を通る
 *   ⑤既読の直後に積んだ注意は数え直しても未読 / 既読の前に積んだ分は既読のまま。
 * ⚠ 守っていないもの:実 IndexedDB(fake の控え)/ 実ブラウザの画面(読み込みの結線は原文 pin)。
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessagePost,
  READ_AT_KEY,
  type MessageSpool,
  type SpoolItem,
} from '../../src/adapter/platform/message-post';
import {
  SYSTEM_JOB_LID,
  SYSTEM_MESSAGE_LID,
  countUnread,
  formatMessageSection,
} from '../../src/features/message/message-log';

class FakeSpool implements MessageSpool {
  private seq = 0;
  private map = new Map<number, SpoolItem>();
  async list(): Promise<ReadonlyArray<{ id: number; item: SpoolItem }>> {
    return [...this.map.entries()].map(([id, item]) => ({ id, item }));
  }
  async count(): Promise<number> {
    return this.map.size;
  }
  async push(item: SpoolItem): Promise<void> {
    this.map.set(++this.seq, item);
  }
  async remove(id: number): Promise<void> {
    this.map.delete(id);
  }
}

const sec = (at: string, text: string): string =>
  formatMessageSection({ at, kind: 'problem', source: 'app', text });

function item(over: Partial<SpoolItem>): SpoolItem {
  return { cid: 'c1', lid: SYSTEM_MESSAGE_LID, title: 'メッセージ', section: '', cap: 500, ...over };
}

describe('M1: 控えを読む(withSpool)', () => {
  it('🔴 本文の後ろへ、控えの節を作られた順にそのまま足す。他の lid / 他の入れ物の控えは混ぜない', async () => {
    const spool = new FakeSpool();
    const s1 = sec('2026-10-17T01:00:00.000Z', '一つ目');
    const s2 = sec('2026-10-17T01:00:05.000Z', '二つ目');
    await spool.push(item({ section: s1 }));
    await spool.push(item({ lid: SYSTEM_JOB_LID, section: sec('2026-10-17T01:00:01.000Z', '別のノート') }));
    await spool.push(item({ cid: 'other', section: sec('2026-10-17T01:00:02.000Z', '別の入れ物') }));
    await spool.push(item({ cid: '', section: s2 })); // boot 前に積んだ分(cid 未確定)
    const post = new MessagePost(spool);
    post.attach({ cid: 'c1', appendMessage: vi.fn().mockRejectedValue(new Error('refuse')) });
    const dbBody = sec('2026-10-17T00:00:00.000Z', '本文');
    const out = await post.withSpool(SYSTEM_MESSAGE_LID, async () => dbBody);
    expect(out).toBe(dbBody + s1 + s2);
  });

  it('🔴 本文が空でも、控えだけの画面が空白にならない', async () => {
    const spool = new FakeSpool();
    const s1 = sec('2026-10-17T01:00:00.000Z', '一つ目');
    await spool.push(item({ section: s1 }));
    const post = new MessagePost(spool);
    expect(await post.withSpool(SYSTEM_MESSAGE_LID, async () => null)).toBe(s1);
  });

  it('🔴 本文が読めないとき、控えがあれば控えを返す / 控えも無ければ元の例外を投げる', async () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    const boom = new Error('db unreadable');
    await expect(post.withSpool(SYSTEM_MESSAGE_LID, async () => Promise.reject(boom))).rejects.toBe(boom);
    const s1 = sec('2026-10-17T01:00:00.000Z', '一つ目');
    await spool.push(item({ section: s1 }));
    expect(await post.withSpool(SYSTEM_MESSAGE_LID, async () => Promise.reject(boom))).toBe(s1);
  });

  it('実際の経路: 書込が断られた post が控えに残り、withSpool で読める', async () => {
    const post = new MessagePost(new FakeSpool());
    post.attach({ cid: 'c1', appendMessage: vi.fn().mockRejectedValue(new Error('quota')) });
    post.post({ kind: 'problem', source: 'app', text: '書けない' });
    await post.whenWritten();
    const out = await post.withSpool(SYSTEM_MESSAGE_LID, async () => '');
    expect(out).toContain('**問題** 書けない');
  });

  it('読み手 2 つ(画面の読み込み・メッセージの書き出し)が withSpool を通っている', () => {
    const fx = readFileSync('src/adapter/state/store-effects.ts', 'utf-8');
    const at = fx.indexOf("case 'REQUEST_MESSAGES_BODY':");
    expect(at).toBeGreaterThan(0);
    expect(fx.slice(at, at + 900)).toContain('appMessagePost.withSpool(ev.lid');
    const bd = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
    const from = bd.indexOf("'export-messages': (dispatcher");
    expect(from).toBeGreaterThan(0);
    const exp = bd.slice(from, bd.indexOf("'set-paste-source'", from));
    expect(exp).toContain('appMessagePost');
    expect(exp).toContain('.withSpool(lid');
  });
});

describe('M5: 既読と同じ秒の注意', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  async function run(steps: (post: MessagePost) => void): Promise<string> {
    const bodies: string[] = [];
    const post = new MessagePost(new FakeSpool());
    post.attach({
      cid: 'c1',
      appendMessage: async (req) => {
        bodies.push(req.section);
      },
    });
    steps(post);
    await vi.advanceTimersByTimeAsync(0);
    await post.whenWritten();
    return bodies.join('');
  }

  it('🔴 既読にした直後(同じ秒)に来た注意は、数え直しても未読に残る', async () => {
    vi.setSystemTime(new Date('2026-10-17T03:00:00.200Z'));
    const body = await run((post) => {
      post.markRead();
      vi.setSystemTime(new Date('2026-10-17T03:00:00.800Z'));
      post.post({ kind: 'caution', source: 'app', text: '既読の直後' });
    });
    expect(countUnread(body, localStorage.getItem(READ_AT_KEY))).toBe(1);
  });

  it('対照群: 既読にする前に来た同じ秒の注意は、数え直しても既読のまま(未読に戻らない)', async () => {
    vi.setSystemTime(new Date('2026-10-17T03:00:00.200Z'));
    const body = await run((post) => {
      post.post({ kind: 'caution', source: 'app', text: '既読の前' });
      vi.setSystemTime(new Date('2026-10-17T03:00:00.800Z'));
      post.markRead();
    });
    expect(body).toContain('既読の前');
    expect(countUnread(body, localStorage.getItem(READ_AT_KEY))).toBe(0);
  });

  it('次の秒へ送った節の後に既読にしても、既読のまま(既読の時刻を送った節まで進める)', async () => {
    vi.setSystemTime(new Date('2026-10-17T03:00:00.200Z'));
    const body = await run((post) => {
      post.markRead();
      vi.setSystemTime(new Date('2026-10-17T03:00:00.800Z'));
      post.post({ kind: 'caution', source: 'app', text: '送られた節' });
      vi.setSystemTime(new Date('2026-10-17T03:00:00.900Z'));
      post.markRead();
    });
    expect(body).toContain('送られた節');
    expect(countUnread(body, localStorage.getItem(READ_AT_KEY))).toBe(0);
  });

  it('既読から十分あとの注意は時刻を動かさない', async () => {
    vi.setSystemTime(new Date('2026-10-17T03:00:00.200Z'));
    const body = await run((post) => {
      post.markRead();
      vi.setSystemTime(new Date('2026-10-17T03:00:05.100Z'));
      post.post({ kind: 'caution', source: 'app', text: '後' });
    });
    const secs = /## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:(\d{2})\n/.exec(body)?.[1];
    // 時刻は端末の時差に依らず、秒の部分だけ見る(05 秒 = 動かしていない / 01 秒 = 送っていた)
    expect(secs).toBe('05');
  });
});
