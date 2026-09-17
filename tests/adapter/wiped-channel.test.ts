/**
 * 🔴 **「この入れ物は捨てた」を他のタブへ伝える路**(#986 段③)。
 *
 * ⚠ 守るのは 3 つ ── どれも**落ちても画面には何も出ない**種類の壊れ方である:
 * ① **相手に届く**(届かないと、古いタブが消したノートを書き戻す)
 * ② **自分の便りを自分で拾わない**(自分だけ無限に読み込み直す)
 * ③ **他人の便りを掴まない**(同じ路に別の物が流れても動かない)
 *
 * 🔑 **実物どうしを繋ぐ**(#195 の教訓)── 片側だけを手で組んだ test は、
 *   綴りが食い違っても**両側とも緑**で通る(受け側は黙って捨てるので
 *   1 バイトも届かない、が test からは見えない)。
 */
import { describe, expect, it } from 'vitest';
import {
  connectWipedChannel,
  readWiped,
  wipedMessage,
  type WipedChannelPort,
} from '../../src/adapter/platform/storage/wiped-channel';

/** 同じ名前の路に繋がった全員へ配る台(`BroadcastChannel` の最小の真似)。 */
function hub(): { port(): WipedChannelPort } {
  const ports: WipedChannelPort[] = [];
  return {
    port(): WipedChannelPort {
      const p: WipedChannelPort = {
        onmessage: null,
        postMessage(data: unknown) {
          // ⚠ **自分にも配る** ── 本物の `BroadcastChannel` は自分に配らないが、
          //    ここで配っておくと「自分の便りを自分で拾わない」門が本当に鳴る
          //    (甘い stub を作らない ── CLAUDE.md §3)
          for (const other of ports) other.onmessage?.({ data } as MessageEvent);
        },
      };
      ports.push(p);
      return p;
    },
  };
}

describe('捨てたことを伝える(#986 段③)', () => {
  it('🔴 実物どうしで届く', () => {
    const h = hub();
    const seen: string[] = [];
    const a = connectWipedChannel({ channel: h.port(), id: 'A', onWiped: (cid) => seen.push(cid) });
    connectWipedChannel({ channel: h.port(), id: 'B', onWiped: (cid) => seen.push(`B:${cid}`) });
    a.announce('c1');
    expect(seen, '相手に届いていない').toEqual(['B:c1']);
  });

  it('🔴 自分の便りは拾わない(自分だけ読み込み直し続ける、を作らない)', () => {
    const h = hub();
    const mine: string[] = [];
    const a = connectWipedChannel({ channel: h.port(), id: 'A', onWiped: (cid) => mine.push(cid) });
    a.announce('c1');
    expect(mine, '自分の便りを拾った').toEqual([]);
  });

  it('🔴 同じ路に流れた別の物は掴まない', () => {
    const h = hub();
    const seen: string[] = [];
    const p = h.port();
    connectWipedChannel({ channel: p, id: 'B', onWiped: (cid) => seen.push(cid) });
    for (const junk of [null, 'ping', { kind: 'changed', cid: 'c1' }, { tag: 'pkc3-wiped' }])
      p.onmessage?.({ data: junk } as MessageEvent);
    expect(seen, '関係ない便りで読み込み直した').toEqual([]);
  });

  it('⚠ 路が無い箱では、押しても落ちない(古いブラウザ / test)', () => {
    const a = connectWipedChannel({ channel: null, id: 'A', onWiped: () => undefined });
    expect(() => a.announce('c1')).not.toThrow();
  });

  /**
   * ⚠ **封筒を組む口は 1 つ**(#195)── 送る側と受ける側が別々に綴ると、
   *   食い違っても両側の test が緑で通る。
   */
  it('🔑 封筒は 1 か所で組む ── 組んだ物は、そのまま読める', () => {
    expect(readWiped(wipedMessage('A', 'c1'), 'B')).toBe('c1');
    expect(readWiped(wipedMessage('A', 'c1'), 'A'), '自分の分を読んだ').toBeNull();
  });
});
