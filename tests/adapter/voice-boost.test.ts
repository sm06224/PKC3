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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../helpers/code-only';
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

  /**
   * ⚠ **この test で `wire` の `if (host === null) return;` は殺せない**
   *   (2026-09-14 の変異試験 M4 が SURVIVED で教えた)。
   * 🔑 守っているのは **`tsc`** である ── 外すと `'host' is possibly 'null'` が
   *   **4 件**出てコンパイルが通らない(実測)。⚠ `vitest` は型を見ないので、
   *   外した版でも走ってしまい、`null.source(el)` の `TypeError` が実装の
   *   `catch` に飲まれて**外から見た結果が同じ**になる。
   * ⚠ **だから、わざとらしい assert を足して殺しにいかない** ── 足しても
   *   守りは 1 ミリも増えず、「殺せた」という見かけだけが残る。
   */
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

/**
 * 🔴 **再生機を 1 枚足した人が、繋ぎ忘れても鳴らない**(#772 段① B。CLAUDE.md §7)。
 *
 * ⚠ この改修は**書いた当日に 1 か所落とした** ── 2026-09-08 に数えた「音の再生は
 *   4 か所」は**「音と動画」の面ができる前の数**で、いちばん聞く所が抜けていた。
 *   🔑 実害は「**設定を入れたのに、いちばん聞く所だけ整わない**」という、
 *   user からは**設定が壊れて見える**形である。
 *
 * 🔑 だから**手で並べた一覧ではなく、機械で数える** ── 再生機を作る file は
 *   `controls` を立てるので、**それを印にして全数走査**する。
 * ⚠ 書き出した HTML(`src/features/export/`)は**対象外** ── あちらは設定を
 *   持ち歩かない別の script なので、この走査の外に在る(面の説明もそう書いてある)。
 */
describe('再生機を作る面は、全部つなぎに通している(全数)', () => {
  const dir = join(process.cwd(), 'src/adapter/ui/render');
  const players = (): string[] => {
    const out: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      // ⚠ **注釈を落としてから見る**(CLAUDE.md §1 の 5 度目 ── 自分の解説に満たされる)
      const src = codeOnly(readFileSync(join(dir, f), 'utf-8'));
      if (/\.controls = true/.test(src)) out.push(f);
    }
    return out.sort();
  };

  it('🔴 `controls` を立てる file は、全部 `appVoiceBoostRouter.watch` を呼ぶ', () => {
    const found = players();
    // 空振り防止 ── 走査が壊れて 0 件になっていないこと
    expect(found.length, '再生機を作る file を 1 つも拾えていない(前処理が壊れている)').toBeGreaterThan(1);
    const missing = found.filter((f) => {
      const src = codeOnly(readFileSync(join(dir, f), 'utf-8'));
      return !src.includes('appVoiceBoostRouter.watch(');
    });
    expect(
      missing,
      '再生機を作っているのに、整える鎖へ通していない面が在る ── 設定を入れてもそこだけ整わない',
    ).toEqual([]);
  });

  it('⚠ いま在る面の名前を pin する(面が増えた日に、繋いだかを問う)', () => {
    expect(players()).toEqual(['captures.ts', 'detail.ts']);
  });
});
