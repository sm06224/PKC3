/** @vitest-environment happy-dom */
/**
 * 🔴 **聞くときだけ音を整える**(#772 段① B)。
 *
 * ## ⚠ ここで守っているのは「整うこと」ではなく「**無音にしないこと**」
 *
 * ブラウザの決まりで、`createMediaElementSource` を 1 度でも呼んだ要素は
 * **鎖の先へ繋がなければ音を出さない**。⚠ そして `<audio>` の見た目は
 * **再生中のまま**なので、user からは「動いているのに聞こえない」という
 * **いちばん気づけない壊れ方**になる ── だから 3 方向を全部見る:
 *
 * | | |
 * |---|---|
 * | 切のまま | **`source` を 1 度も呼ばない**(触らなければ素のまま鳴る) |
 * | 入にした | 鎖の入口へ繋ぐ |
 * | 🔴 **入 → 切に戻した** | **出口へ繋ぎ直す**(外して終わりにしない) |
 *
 * 🔑 **偽の器を渡して観測する** ── `WebAudio` は happy-dom に無いが、
 *   守りたいのは**繋ぎ替えの順番**であって音そのものではない。
 */
import { describe, expect, it } from 'vitest';
import { VoiceBoostRouter, type BoostHost, type BoostNode } from '@adapter/platform/audio/voice-boost';

/** 繋いだ相手を憶えるだけの節。⚠ `disconnect` で `to` を `null` に戻す。 */
class FakeNode implements BoostNode {
  to: BoostNode | null = null;
  connect(to: BoostNode): unknown {
    this.to = to;
    return to;
  }
  disconnect(): unknown {
    this.to = null;
    return undefined;
  }
}

function fakeHost(): BoostHost & { sources: FakeNode[]; resumed: number; head: FakeNode; destination: FakeNode } {
  const head = new FakeNode();
  const destination = new FakeNode();
  const sources: FakeNode[] = [];
  let resumed = 0;
  return {
    head,
    destination,
    sources,
    get resumed(): number {
      return resumed;
    },
    source(): BoostNode {
      const n = new FakeNode();
      sources.push(n);
      return n;
    },
    resume(): void {
      resumed += 1;
    },
  };
}

const media = (): HTMLMediaElement => document.createElement('audio');

describe('聞くときだけ音を整える(繋ぎ替え)', () => {
  it('🔴 切のままなら、音の通り道に一切触らない', () => {
    const host = fakeHost();
    const r = new VoiceBoostRouter(() => host, () => false);
    r.watch(media());
    r.watch(media());
    expect(host.sources, '切なのに `source` を作った ── その要素は以後、鎖なしでは鳴らない').toHaveLength(0);
    expect(r.wiredCount()).toBe(0);
  });

  it('入なら鎖の入口へ繋ぎ、器を動かす', () => {
    const host = fakeHost();
    const r = new VoiceBoostRouter(() => host, () => true);
    r.watch(media());
    expect(host.sources).toHaveLength(1);
    expect(host.sources[0]!.to, '鎖の入口へ繋がっていない').toBe(host.head);
    expect(host.resumed, '止まったままの器へ繋いでいる').toBe(1);
  });

  it('🔴 切に戻したら、出口へ繋ぎ直す(外して終わりにしない = 無音にしない)', () => {
    const host = fakeHost();
    let on = true;
    const r = new VoiceBoostRouter(() => host, () => on);
    r.watch(media());
    expect(host.sources[0]!.to).toBe(host.head);
    on = false;
    r.refresh();
    expect(
      host.sources[0]!.to,
      '切に戻したのに出口へ繋いでいない ── 再生機は動いて見えるのに音が出ない',
    ).toBe(host.destination);
    // ⚠ 対照群 ── もう一度入にしたら鎖へ戻る(片道の切り替えになっていない)
    on = true;
    r.refresh();
    expect(host.sources[0]!.to).toBe(host.head);
  });

  it('🔴 既に置いてある再生機も、その場で切り替わる(読み込み直しを求めない)', () => {
    const host = fakeHost();
    let on = false;
    const r = new VoiceBoostRouter(() => host, () => on);
    const a = media();
    const b = media();
    r.watch(a);
    r.watch(b);
    expect(host.sources).toHaveLength(0);
    on = true;
    r.refresh();
    expect(host.sources, '設定を入にしても、置いてある再生機が繋がらない').toHaveLength(2);
    expect(r.wiredCount()).toBe(2);
  });

  it('🔴 同じ要素に `source` を 2 度作らない(2 度目は例外になる決まり)', () => {
    const host = fakeHost();
    const r = new VoiceBoostRouter(() => host, () => true);
    const el = media();
    r.watch(el);
    r.watch(el);
    r.refresh();
    expect(host.sources, '同じ要素の `source` を作り直している').toHaveLength(1);
  });

  it('🔴 鳴らし始める瞬間にも器を起こす(止まった器では再生機が進まない)', () => {
    const host = fakeHost();
    const r = new VoiceBoostRouter(() => host, () => true);
    const el = media();
    r.watch(el);
    const before = host.resumed;
    el.dispatchEvent(new Event('play'));
    expect(host.resumed, '押して鳴らし始めても器を起こしていない').toBe(before + 1);
    // ⚠ **重ねない** ── 何度 `refresh` しても、聞き手は 1 枚だけ
    r.refresh();
    r.refresh();
    const mid = host.resumed;
    el.dispatchEvent(new Event('play'));
    expect(host.resumed, '同じ要素に聞き手が重なっている').toBe(mid + 1);
  });

  it('🔴 器が作れない端末では何もしない(整わないだけで、素のまま鳴る)', () => {
    const r = new VoiceBoostRouter(() => null, () => true);
    expect(() => r.watch(media())).not.toThrow();
    expect(r.wiredCount()).toBe(0);
  });

  it('⚠ 器の作成が投げても、再生機を置く側は落ちない', () => {
    let made = 0;
    const r = new VoiceBoostRouter(
      () => {
        made += 1;
        throw new Error('no audio');
      },
      () => true,
    );
    expect(() => r.watch(media())).not.toThrow();
    expect(() => r.watch(media())).not.toThrow();
    // ⚠ 1 度で諦める ── 再生機のたびに作り直さない
    expect(made, '作れなかった器を、再生機のたびに作り直している').toBe(1);
  });

  it('🔴 1 度も繋いでいない要素は、切のときに触らない', () => {
    const host = fakeHost();
    let on = false;
    const r = new VoiceBoostRouter(() => host, () => on);
    r.watch(media());
    // 入にしないまま切の `refresh` が来ても、`source` は生まれない
    r.refresh();
    expect(host.sources).toHaveLength(0);
    // ⚠ 対照群 ── 入にすれば繋がる(この test 自体が空振りでないこと)
    on = true;
    r.refresh();
    expect(host.sources).toHaveLength(1);
  });
});
