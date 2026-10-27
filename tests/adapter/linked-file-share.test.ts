/** @vitest-environment happy-dom */
/**
 * 🔴 **PC のファイルとのつながりを別のウィンドウへ渡す**(差分マージ・PC の別ウィンドウのレビュー ⚠4)。
 *
 * 守る主張:
 * 1. 頼むと、**同じコレクションを開いている他のウィンドウ**が持つつながりが着き、頼んだ窓の記憶に入る
 * 2. **自分の頼みに自分で答えない** / 別のコレクションを開いている窓には渡さない / 宛先の違う返事は拾わない
 * 3. 持っていなければ答えない(空の返事を投げない)
 * 4. 複製できないハンドルでも落ちない ── 頼む側は `false` を受け取り、画面が案内に倒れる
 * 5. `LaunchedFiles` が憶えているつながりを、ハンドルごと取り出せる(読まずに)
 */
import { describe, expect, it, vi } from 'vitest';
import { LinkedFileShare, type SharedLink } from '../../src/adapter/platform/linked-file-share';
import { LaunchedFiles, type LaunchedHandle } from '../../src/adapter/platform/launched-files';
import type { Broadcaster } from '../../src/adapter/platform/storage/store-proxy';

/** 同じ名前の放送を共有する偽の放送網(送った本人には返らない ── 本物の BroadcastChannel と同じ)。 */
class Hub {
  private readonly members = new Set<FakeChannel>();
  join(): FakeChannel {
    const c = new FakeChannel(this);
    this.members.add(c);
    return c;
  }
  leave(c: FakeChannel): void {
    this.members.delete(c);
  }
  send(from: FakeChannel, data: unknown): void {
    for (const m of this.members) {
      if (m === from) continue;
      // ⚠ 本物と同じく非同期に届ける
      queueMicrotask(() => m.onmessage?.({ data } as MessageEvent));
    }
  }
}
class FakeChannel implements Broadcaster {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(private readonly hub: Hub) {}
  postMessage(data: unknown): void {
    this.hub.send(this, data);
  }
  close(): void {
    this.hub.leave(this);
  }
}

const handle = (name: string): LaunchedHandle => ({ kind: 'file', getFile: async () => new File(['x'], name) });
const link = (lid: string, name: string): SharedLink => ({ lid, name, modifiedAt: 111, handle: handle(name) });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let ids = 0;
function window_(hub: Hub, cid: string | null, own: SharedLink[]) {
  const adopted: SharedLink[][] = [];
  const share = new LinkedFileShare({
    open: () => hub.join(),
    cid: () => cid,
    list: () => own,
    adopt: (items) => void adopted.push([...items]),
    newId: () => `w${ids++}`,
  });
  share.start();
  return { share, adopted };
}

describe('つながりを他のウィンドウから受け取る', () => {
  it('🔴 頼むと、他のウィンドウのつながりがハンドルごと着く', async () => {
    const hub = new Hub();
    const main = window_(hub, 'c1', [link('n1', 'a.md'), link('n2', 'b.md')]);
    const popup = window_(hub, 'c1', []);
    expect(popup.share.request()).toBe(true);
    await flush();
    expect(popup.adopted).toHaveLength(1);
    expect(popup.adopted[0]!.map((i) => [i.lid, i.name, i.modifiedAt])).toEqual([
      ['n1', 'a.md', 111],
      ['n2', 'b.md', 111],
    ]);
    // 着いたハンドルは使える(読める)
    expect((await popup.adopted[0]![0]!.handle.getFile!()).name).toBe('a.md');
    // 答えた側は何も受け取らない
    expect(main.adopted).toHaveLength(0);
  });

  it('🔴 別のコレクションを開いている窓には渡さない・頼んだ窓も別のコレクションの返事は拾わない', async () => {
    const hub = new Hub();
    window_(hub, 'other', [link('n1', 'a.md')]);
    const popup = window_(hub, 'c1', []);
    popup.share.request();
    await flush();
    expect(popup.adopted, '別のコレクションのつながりを受け取った').toHaveLength(0);
  });

  it('持っていなければ答えない(空の返事を投げない)', async () => {
    const hub = new Hub();
    const quiet = window_(hub, 'c1', []);
    const popup = window_(hub, 'c1', []);
    popup.share.request();
    await flush();
    expect(popup.adopted).toHaveLength(0);
    expect(quiet.adopted).toHaveLength(0);
  });

  it('🔴 自分の頼みに自分では答えない(2 つの窓が互いの頼みに答え合っても、頼んだ側にだけ着く)', async () => {
    const hub = new Hub();
    const a = window_(hub, 'c1', [link('n1', 'a.md')]);
    const b = window_(hub, 'c1', [link('n2', 'b.md')]);
    a.share.request();
    await flush();
    expect(a.adopted.map((x) => x.map((i) => i.lid))).toEqual([['n2']]);
    expect(b.adopted, '頼んでいない窓に返事が着いた').toHaveLength(0);
  });

  it('宛先の違う返事は拾わない(3 つ目の窓が頼んだ返事を、2 つ目が受け取らない)', async () => {
    const hub = new Hub();
    window_(hub, 'c1', [link('n1', 'a.md')]);
    const second = window_(hub, 'c1', []);
    const third = window_(hub, 'c1', []);
    third.share.request();
    await flush();
    expect(third.adopted).toHaveLength(1);
    expect(second.adopted, '宛先の違う返事を拾った').toHaveLength(0);
  });

  it('🔴 複製できないハンドルでも落ちない: 答える側は黙って諦め、頼む側が複製できないときは false', async () => {
    const hub = new Hub();
    const holder = window_(hub, 'c1', [link('n1', 'a.md')]);
    const popup = window_(hub, 'c1', []);
    // 答える側の postMessage が複製に失敗する
    const ch = (holder.share as unknown as { ch: FakeChannel }).ch;
    const orig = ch.postMessage.bind(ch);
    ch.postMessage = (data: unknown): void => {
      if ((data as { kind?: string }).kind === 'linked-offer') throw new DOMException('cannot clone', 'DataCloneError');
      orig(data);
    };
    expect(() => popup.share.request()).not.toThrow();
    await flush();
    expect(popup.adopted, '複製できなかったのに着いた').toHaveLength(0);
    // 頼む側の postMessage が投げるとき
    const ch2 = (popup.share as unknown as { ch: FakeChannel }).ch;
    ch2.postMessage = (): void => {
      throw new DOMException('x', 'DataCloneError');
    };
    expect(popup.share.request()).toBe(false);
  });

  it('放送が無い環境・コレクションを開く前は、頼めず false(落ちない)', () => {
    const none = new LinkedFileShare({ open: () => null, cid: () => 'c1', list: () => [], adopt: vi.fn(), newId: () => 'x' });
    expect(none.request()).toBe(false);
    const hub = new Hub();
    const early = window_(hub, null, []);
    expect(early.share.request()).toBe(false);
  });

  it('dispose したら放送を閉じ、以後は何も受けない', async () => {
    const hub = new Hub();
    const main = window_(hub, 'c1', [link('n1', 'a.md')]);
    const popup = window_(hub, 'c1', []);
    main.share.dispose();
    popup.share.request();
    await flush();
    expect(popup.adopted).toHaveLength(0);
  });
});

describe('LaunchedFiles が憶えているつながりの取り出し', () => {
  it('🔴 lid・名前・取り込み時の更新時刻・ハンドルを返す(ファイルは読まない)', () => {
    const l = new LaunchedFiles();
    const h = handle('a.md');
    const getFile = vi.spyOn(h, 'getFile' as never);
    l.remember('n1', h, 'a.md', 42);
    l.remember('n2', handle('b.md'), 'b.md');
    expect(l.entries().map((e) => [e.lid, e.name, e.modifiedAt])).toEqual([
      ['n1', 'a.md', 42],
      ['n2', 'b.md', null],
    ]);
    expect(l.entries()[0]!.handle).toBe(h);
    expect(getFile, '取り出すだけで読んでいる').not.toHaveBeenCalled();
    // 空のときは空(0 件の次元)
    expect(new LaunchedFiles().entries()).toEqual([]);
  });
});
