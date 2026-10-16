/**
 * 🔴 **書きの順番**(#1087 M9)── 1 件目が一時的に書けなくても、2 件目が先に disk へ入らない。
 * 守るもの:失敗した分は新しい分より先に書き直される(一件目 → 二件目 → 三件目)。
 * 守っていないもの:別のタブとの順番(控えのロックは既存の別の仕組み)。
 */
import { describe, expect, it, vi } from 'vitest';
import { MessagePost, type MessageSpool, type SpoolItem } from '../../src/adapter/platform/message-post';

class FakeSpool implements MessageSpool {
  private seq = 0;
  private map = new Map<number, SpoolItem>();
  async list() {
    return [...this.map.entries()].map(([id, item]) => ({ id, item }));
  }
  async count() {
    return this.map.size;
  }
  async push(item: SpoolItem) {
    this.map.set(++this.seq, item);
  }
  async remove(id: number) {
    this.map.delete(id);
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 1));
};
const textOf = (section: string): string => section.split('\n')[1] ?? '';

describe('MessagePost の書きの順番', () => {
  it('🔴 1 件目が一度だけ失敗しても、書かれる順は 一件目 → 二件目 → 三件目', async () => {
    const post = new MessagePost(new FakeSpool());
    const written: string[] = [];
    let n = 0;
    const appendMessage = vi.fn().mockImplementation(async (req: { section: string }) => {
      n += 1;
      // 1 件目の失敗を遅らせる(2 件目が追い越せる隙を作る)
      if (n === 1) {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('transient');
      }
      written.push(req.section);
    });
    post.attach({ cid: 'c1', appendMessage });
    await settle();
    post.post({ kind: 'result', source: 'app', text: '一件目' });
    post.post({ kind: 'result', source: 'app', text: '二件目' });
    post.post({ kind: 'result', source: 'app', text: '三件目' });
    await settle();
    const joined = written.join('');
    // 空振り防止:失敗が本当に 1 回起きた(3 件 + 失敗 1 回 = 4 回呼ばれた)
    expect(appendMessage).toHaveBeenCalledTimes(4);
    const order = ['一件目', '二件目', '三件目'].map((t) => joined.indexOf(t));
    expect(order.every((i) => i >= 0), '3 件とも書かれていない').toBe(true);
    expect(order[0]!, '一件目が二件目より後').toBeLessThan(order[1]!);
    expect(order[1]!, '二件目が三件目より後').toBeLessThan(order[2]!);
    expect(written.map(textOf).length).toBe(3);
  });

  it('対照群:失敗が無ければ投げた順のまま', async () => {
    const post = new MessagePost(new FakeSpool());
    const written: string[] = [];
    post.attach({
      cid: 'c1',
      appendMessage: async (req: { section: string }) => {
        written.push(req.section);
      },
    });
    await settle();
    for (const t of ['一', '二', '三']) post.post({ kind: 'result', source: 'app', text: t });
    await settle();
    expect(written.map((sec) => ['一', '二', '三'].find((t) => sec.includes(t)))).toEqual(['一', '二', '三']);
  });
});
