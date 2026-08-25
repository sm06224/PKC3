/** @vitest-environment happy-dom */
import { describe, it, expect } from 'vitest';
import { createExtLinkRegistry } from '../../src/adapter/platform/extension-links';
import type { ExtHostLink } from '../../src/adapter/platform/extension-host';
import type { ExtDeliveredEntry } from '../../src/features/extension/ext-delivery';

const entry = (lid: string): ExtDeliveredEntry => ({
  lid,
  title: lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  status: null,
  date: null,
  archived: false,
  body: 'b',
  assetRefsApprox: 0,
});

/** 港役。⚠ **本物より甘くしない** ── 閉じた後は本物と同じく `false` を返す(§3)。 */
function fakeLink(): ExtHostLink & { got: ExtDeliveredEntry[]; closed: boolean } {
  const got: ExtDeliveredEntry[] = [];
  const l = {
    got,
    closed: false,
    push: () => undefined,
    connected: () => !l.closed,
    deliver: (e: ExtDeliveredEntry) => {
      if (l.closed) return false;
      got.push(e);
      return true;
    },
    close: () => {
      l.closed = true;
    },
  };
  return l;
}

describe('開いている拡張の台帳(#195 / C-5 段②)', () => {
  it('載せた順に並ぶ', () => {
    const r = createExtLinkRegistry();
    r.track({ appId: 'x', title: '先' }, fakeLink());
    r.track({ appId: 'y', title: '後' }, fakeLink());
    expect(r.list().map((o) => o.title)).toEqual(['先', '後']);
  });

  /**
   * 🔴 **閉じたら台帳から消える** ── 残ると、user は**閉じた窓へ送れてしまい**、
   *   帯には「送れませんでした」だけが出る(なぜかは分からない)。
   * ⚠ 観測点は 2 つ:**一覧から消えたこと**と、**元の link が閉じられたこと**。
   *   前者だけ見ると、外しただけで閉じ忘れる実装が生き延びる。
   */
  it('🔴 閉じると一覧から消え、元の港も閉じる', () => {
    const r = createExtLinkRegistry();
    const raw = fakeLink();
    const tracked = r.track({ appId: 'x', title: 'アプリ' }, raw);
    expect(r.list()).toHaveLength(1);
    tracked.close();
    expect(r.list(), '幽霊が残っている').toHaveLength(0);
    expect(raw.closed, '一覧から外しただけで港を閉じていない').toBe(true);
  });

  /**
   * 🔴 **同じアプリを 2 枚開いても、両方へ送れる。**
   * ⚠ 鍵を `appId` にすると 2 枚目が 1 枚目を追い出し、**1 枚目へ二度と送れない**
   *   (窓は開いたままなのに)── しかもそれは「押せない」ではなく
   *   「**押しても違う窓に届く**」形で壊れる。
   */
  it('🔴 同じアプリの 2 枚目が 1 枚目を追い出さない', () => {
    const r = createExtLinkRegistry();
    const a = fakeLink();
    const b = fakeLink();
    r.track({ appId: 'same', title: 'アプリ' }, a);
    r.track({ appId: 'same', title: 'アプリ' }, b);
    const open = r.list();
    expect(open).toHaveLength(2);
    expect(r.deliver(open[0]!.id, entry('n1'))).toBe(true);
    expect(r.deliver(open[1]!.id, entry('n2'))).toBe(true);
    expect(a.got.map((e) => e.lid)).toEqual(['n1']);
    expect(b.got.map((e) => e.lid)).toEqual(['n2']);
  });

  it('知らない id へは送れない(false を返す ── 黙って捨てない)', () => {
    const r = createExtLinkRegistry();
    expect(r.deliver('ext-999', entry('n1'))).toBe(false);
  });

  /**
   * 🔴 **一覧が変わったら知らせる**(#195 / C-5 段②-b)。
   *
   * ⚠ 知らせが片方(開いたときだけ / 閉じたときだけ)しか出ないと、
   *   画面の一覧が**片道でしか直らない** ── だから**両方**を 1 つの it で見る。
   */
  it('🔴 開いたときも閉じたときも知らせる', () => {
    const r = createExtLinkRegistry();
    const beats: number[] = [];
    r.subscribe(() => beats.push(r.list().length));
    const t = r.track({ appId: 'x', title: 'ア' }, fakeLink());
    t.close();
    expect(beats, '開いた / 閉じたのどちらかで黙っている').toEqual([1, 0]);
  });

  /** ⚠ 2 回閉じても 2 回知らせない(描き直しを無駄に起こさない)。 */
  it('2 回閉じても知らせは 1 回', () => {
    const r = createExtLinkRegistry();
    const t = r.track({ appId: 'x', title: 'ア' }, fakeLink());
    let n = 0;
    r.subscribe(() => { n += 1; });
    t.close();
    t.close();
    expect(n).toBe(1);
  });

  /** ⚠ 購読を解いたら届かない(閉じた面へ描き続けない)。 */
  it('購読を解くと届かなくなる', () => {
    const r = createExtLinkRegistry();
    let n = 0;
    const off = r.subscribe(() => { n += 1; });
    r.track({ appId: 'x', title: 'ア' }, fakeLink());
    off();
    r.track({ appId: 'y', title: 'イ' }, fakeLink());
    expect(n).toBe(1);
  });

  /** ⚠ 1 人が投げても残りへ届く(購読者どうしを巻き添えにしない)。 */
  it('購読者の 1 人が投げても、残りへ届く', () => {
    const r = createExtLinkRegistry();
    let reached = 0;
    r.subscribe(() => { throw new Error('壊れた購読者'); });
    r.subscribe(() => { reached += 1; });
    expect(() => r.track({ appId: 'x', title: 'ア' }, fakeLink())).not.toThrow();
    expect(reached, '前の購読者の事故に巻き込まれている').toBe(1);
  });

  /** ⚠ 閉じた後に送ろうとしても落ちず、`false` が返る。 */
  it('閉じた後に送っても落ちず false', () => {
    const r = createExtLinkRegistry();
    const tracked = r.track({ appId: 'x', title: 'ア' }, fakeLink());
    const id = r.list()[0]!.id;
    tracked.close();
    expect(r.deliver(id, entry('n1'))).toBe(false);
  });
});
