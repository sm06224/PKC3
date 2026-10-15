/**
 * 🔴 **postMessage の口**(設計 doc §7、段②a)。
 *
 * ⚠ 守るのは:①中身を漏らさない(括弧の中身を潰す・80字で切る)②書けなければ
 *   控えへ積む ③控えは書けるようになった時点で流し込む ④未読の増減。
 * ⚠ 守っていないもの:実 IndexedDB との結線(`IdbMessageSpool` は fake で置換 ──
 *   実 IDB の作法は `asset-blob-store.ts` と同じ形なので、そちらの実績に乗る)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessagePost,
  SPOOL_CAP,
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
  async count(): Promise<number> {
    return this.map.size;
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

  it('🔴 控えに 1 件ある間に post を 2 回重ねても、その 1 件は 1 回しか書かれない(流しは重ならない)', async () => {
    const spool = new FakeSpool();
    await spool.push({ cid: 'c1', lid: SYSTEM_MESSAGE_LID, title: 'メッセージ', section: '## old\n古い節\n\n', cap: 500 });
    const post = new MessagePost(spool);
    const written: string[] = [];
    const appendMessage = vi.fn().mockImplementation(async (req: { section: string }) => {
      // ⚠ 書き終わるまでに時間をかける ── 流しが重なれるなら、その間に別の流しが同じ控えを読む
      await Promise.resolve();
      await Promise.resolve();
      written.push(req.section);
    });
    // attach 自体が流しを 1 本起こす(まだ終わっていない)。そこへ 2 つの post が重なる
    post.attach({ cid: 'c1', appendMessage });
    post.post({ kind: 'result', source: 'app', text: '一つ目' });
    post.post({ kind: 'result', source: 'app', text: '二つ目' });
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    expect(written.filter((x) => x.includes('古い節')), '控えの 1 件が二重に書かれた').toHaveLength(1);
    // 対照:新しい 2 件は両方書かれる(流しを 1 本にして、post を落としていない)
    expect(written.filter((x) => x.includes('一つ目'))).toHaveLength(1);
    expect(written.filter((x) => x.includes('二つ目'))).toHaveLength(1);
    expect(spool.size()).toBe(0);
  });

  it('🔴 流しが終わったあとに控えへ積まれた分は、次の post でちゃんと流れる(「走っている」印が残りっぱなしにならない)', async () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    post.attach({ cid: 'c1', appendMessage }); // 空の控えを 1 度流して終わる
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await spool.push({ cid: 'c1', lid: SYSTEM_MESSAGE_LID, title: 'メッセージ', section: '## old\n後から控えた節\n\n', cap: 500 });
    post.post({ kind: 'result', source: 'app', text: '新しい件' });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    const sections = appendMessage.mock.calls.map((c) => (c[0] as { section: string }).section);
    expect(sections.some((x) => x.includes('後から控えた節')), '2 度目の流しが走っていない').toBe(true);
    expect(spool.size()).toBe(0);
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

/**
 * 🔴 **未読の種(起動直後の数え直し)が、読み込み中に積んだ注意を消さない**(#1087)。
 *
 * ⚠ 「disk」は appendMessage が節を足す配列で、読み出しはそれを連結して返す ── 本物の worker と同じく、
 *   **書き終わった分だけ**が読める。
 */
describe('seedUnreadFromDisk ── 数え直しの間に積んだ分を消さない(#1087)', () => {
  // ⚠ 既読の時刻は端末(localStorage)に残る ── 前の test の `markRead` が、次の test の「未読」を 0 にしない
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  function rig() {
    const disk: string[] = [];
    let release: (() => void) | null = null;
    const gate = { hold: false };
    const appendMessage = vi.fn().mockImplementation(async (req: { section: string }) => {
      if (gate.hold) await new Promise<void>((r) => (release = r));
      disk.push(req.section);
    });
    const post = new MessagePost(new FakeSpool());
    post.attach({ cid: 'c1', appendMessage });
    const seen: number[] = [];
    post.onUnreadChanged((n) => seen.push(n));
    return { disk, post, seen, gate, release: () => release?.() };
  }

  it('🔴 読み込みを頼んだ後に積んだ注意は、種で上書きされない', async () => {
    const { post, seen } = rig();
    let resolveBody: (b: string | null) => void = () => {};
    const seeding = post.seedUnreadFromDisk(() => new Promise((r) => (resolveBody = r)));
    await post.whenWritten();
    await Promise.resolve();
    post.post({ kind: 'caution', source: 'app', text: '読み込み中に来た' });
    resolveBody(''); // 種は 0 件(本文を読んだ時点では何も無かった)
    await seeding;
    expect(seen.at(-1), '積んだ注意が消えた').toBe(1);
  });

  it('🔴 頼む前に積んだが、まだ書き終わっていない分は、書き終わるのを待ってから読む(落とさない)', async () => {
    const { disk, post, seen, gate, release } = rig();
    gate.hold = true;
    post.post({ kind: 'caution', source: 'app', text: '書きかけ' });
    let readAt = -1;
    const seeding = post.seedUnreadFromDisk(async () => {
      readAt = disk.length;
      return disk.join('');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(readAt, '書き終わる前に読んだ').toBe(-1);
    gate.hold = false;
    release();
    await seeding;
    expect(readAt, '書き終わった後に読んでいない').toBe(1);
    // 本文に在る 1 件は種で数え、差分(頼んだ後に増えた分)は 0 ── 二重に数えない
    expect(seen.at(-1)).toBe(1);
  });

  it('🔴 数え直している間に既読にされたら、古い種は捨てる(既読を巻き戻さない)', async () => {
    const { post, seen } = rig();
    let resolveBody: (b: string | null) => void = () => {};
    const seeding = post.seedUnreadFromDisk(() => new Promise((r) => (resolveBody = r)));
    await post.whenWritten();
    await Promise.resolve();
    post.markRead();
    resolveBody('## 2999-01-01 00:00:00\n**注意** 古い\n\n'); // 種は 1 件と言うが、いまは既読
    await seeding;
    expect(seen.at(-1), '既読が種で巻き戻った').toBe(0);
  });

  it('seedUnread は、頼んだ時点の目盛りからの増分を足す', () => {
    const post = new MessagePost(new FakeSpool());
    post.attach({ cid: 'c1', appendMessage: vi.fn().mockResolvedValue(undefined) });
    post.post({ kind: 'problem', source: 'app', text: 'a' }); // 目盛り 1
    post.post({ kind: 'problem', source: 'app', text: 'b' }); // 目盛り 2
    const seen: number[] = [];
    post.onUnreadChanged((n) => seen.push(n));
    post.seedUnread(5, 1); // 1 の時点で頼んだ → その後に 1 件増えている
    expect(seen).toEqual([6]);
  });
});

describe('控え(spool)の上限と順番(#1087)', () => {
  it('🔴 上限を超えたら古い順に捨てる(新しい分は残る)', async () => {
    const spool = new FakeSpool();
    const post = new MessagePost(spool);
    post.attach({ cid: 'c1', appendMessage: vi.fn().mockRejectedValue(new Error('書けない')) });
    await post.whenWritten();
    const total = SPOOL_CAP + 5;
    for (let i = 0; i < total; i += 1) {
      post.post({ kind: 'result', source: 'app', text: `n${String(i).padStart(4, '0')}` });
      await post.whenWritten();
    }
    expect(spool.size(), '上限を超えて溜まった').toBe(SPOOL_CAP);
    const kept = (await spool.list()).map((x) => x.item.section);
    expect(kept.some((x) => x.includes('n0000')), '一番古い分が残った').toBe(false);
    expect(kept.some((x) => x.includes(`n${String(total - 1).padStart(4, '0')}`)), '一番新しい分が消えた').toBe(true);
  });

  it('🔴 控えが流し切れていない間は、新しい分も控えの後ろへ(先に書かない)', async () => {
    const spool = new FakeSpool();
    await spool.push({ cid: 'c1', lid: SYSTEM_MESSAGE_LID, title: 'メッセージ', section: '## old\n古い\n\n', cap: 500 });
    const post = new MessagePost(spool);
    const appendMessage = vi.fn().mockRejectedValue(new Error('まだ書けない'));
    post.attach({ cid: 'c1', appendMessage });
    await post.whenWritten();
    post.post({ kind: 'result', source: 'app', text: '新しい' });
    await post.whenWritten();
    const attempted = appendMessage.mock.calls.map((c) => (c[0] as { section: string }).section);
    expect(attempted.every((x) => x.includes('古い')), '控えより先に新しい分を書こうとした').toBe(true);
    const inSpool = (await spool.list()).map((x) => x.item.section);
    expect(inSpool).toHaveLength(2);
    expect(inSpool[0]).toContain('古い');
    expect(inSpool[1]).toContain('新しい');
  });

  it('控えが空なら、全件を読まない(post のたびに getAll しない)', async () => {
    const spool = new FakeSpool();
    const listSpy = vi.spyOn(spool, 'list');
    const post = new MessagePost(spool);
    post.attach({ cid: 'c1', appendMessage: vi.fn().mockResolvedValue(undefined) });
    for (let i = 0; i < 3; i += 1) {
      post.post({ kind: 'result', source: 'app', text: `x${i}` });
      await post.whenWritten();
    }
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe('別のタブと同時に控えを流さない(#1087)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 同じ名前のロックを 1 つずつ通す(本物の `navigator.locks` と同じ向き)。 */
  function stubLocks() {
    let tail: Promise<unknown> = Promise.resolve();
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => {
      const run = tail.then(cb);
      tail = run.catch(() => {});
      return run;
    });
    vi.stubGlobal('navigator', { locks: { request } });
    return request;
  }

  it('🔴 2 つのタブが同じ控えを同時に流しても、1 件は 1 回しか書かれない', async () => {
    const request = stubLocks();
    const spool = new FakeSpool(); // 2 つのタブが共有する IndexedDB の代わり
    await spool.push({ cid: 'c1', lid: SYSTEM_MESSAGE_LID, title: 'メッセージ', section: '## old\n古い\n\n', cap: 500 });
    const written: string[] = [];
    const append = async (req: { section: string }): Promise<void> => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve(); // 書いている最中に、もう 1 つのタブが読める隙
      written.push(req.section);
    };
    const a = new MessagePost(spool);
    const b = new MessagePost(spool);
    a.attach({ cid: 'c1', appendMessage: append });
    b.attach({ cid: 'c1', appendMessage: append });
    await Promise.all([a.whenWritten(), b.whenWritten()]);
    expect(request).toHaveBeenCalledWith('pkc3-message-spool', expect.any(Function));
    expect(written.filter((x) => x.includes('古い')), '控えの 1 件が二重に書かれた').toHaveLength(1);
    expect(spool.size()).toBe(0);
  });

  it('ロックが無い環境は、これまでどおり流れる', async () => {
    vi.stubGlobal('navigator', {});
    const spool = new FakeSpool();
    await spool.push({ cid: 'c1', lid: SYSTEM_MESSAGE_LID, title: 'メッセージ', section: '## old\n古い\n\n', cap: 500 });
    const append = vi.fn().mockResolvedValue(undefined);
    const post = new MessagePost(spool);
    post.attach({ cid: 'c1', appendMessage: append });
    await post.whenWritten();
    expect(append).toHaveBeenCalledTimes(1);
  });
});

describe('書き込みの合図(onWritten。開いているノートの読み直し用。#1087)', () => {
  it('書けたら lid つきで合図する。書けずに控えへ積んだ分では合図しない', async () => {
    const ok = new MessagePost(new FakeSpool());
    ok.attach({ cid: 'c1', appendMessage: vi.fn().mockResolvedValue(undefined) });
    const lids: string[] = [];
    ok.onWritten((lid) => lids.push(lid));
    ok.post({ kind: 'result', source: 'app', text: 'x' });
    await ok.whenWritten();
    expect(lids).toEqual([SYSTEM_MESSAGE_LID]);

    const ng = new MessagePost(new FakeSpool());
    ng.attach({ cid: 'c1', appendMessage: vi.fn().mockRejectedValue(new Error('x')) });
    const none: string[] = [];
    ng.onWritten((lid) => none.push(lid));
    ng.post({ kind: 'result', source: 'app', text: 'x' });
    await ng.whenWritten();
    expect(none, '書けていないのに合図した').toEqual([]);
  });
});
