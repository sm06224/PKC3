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
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../helpers/code-only';
import {
  LEVEL_OUT,
  planStages,
  VOICE_BOOST,
  VoiceBoostRouter,
  webAudioHost,
  type BoostHost,
  type BoostNode,
} from '@adapter/platform/audio/voice-boost';
import { VoiceBoostStore } from '@adapter/ui/render/voice-boost';

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

describe('聞くときだけ音を整える(つなぎ替え)', () => {
  it('🔴 切のままなら、音の通り道に一切触らない', () => {
    const host = fakeHost();
    const r = new VoiceBoostRouter(() => host, () => false);
    r.watch(media());
    r.watch(media());
    expect(host.sources, '切なのに `source` を作った ── その要素は以後、鎖なしでは鳴らない').toHaveLength(0);
    expect(r.wiredCount()).toBe(0);
  });

  it('入なら鎖の入口へつなぎ、器を動かす', () => {
    const host = fakeHost();
    const r = new VoiceBoostRouter(() => host, () => true);
    r.watch(media());
    expect(host.sources).toHaveLength(1);
    expect(host.sources[0]!.to, '鎖の入口へ繋がっていない').toBe(host.head);
    expect(host.resumed, '止まったままの器へ繋いでいる').toBe(1);
  });

  it('🔴 切に戻したら、出口へつなぎ直す(外して終わりにしない = 無音にしない)', () => {
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

/**
 * 書き出した閲覧用 HTML は**整えない**(🟣 Gemini 裁定 2026-10-01、#772 設問 1 = A)。
 *
 * あちらは設定を持ち歩かないので、受け取った人には**元の音**で鳴る。上の全数走査は
 * `render/` だけを見るので、ここだけ別に pin する ── 散文で「対象外」と書いてあるだけでは、
 * 誰かが「配った HTML でも整えたい」と鎖を足した日に**裁定が黙って覆る**。
 * ⚠ 覆す条件: user か Gemini が「書き出した HTML でも整えてよい」と言ったとき(設問 1 の B)。
 */
describe('書き出した HTML は整えない(#772 設問 1 = A の pin)', () => {
  const file = join(process.cwd(), 'src/features/export/pkc3-html.ts');

  it('🔴 再生機は作る(空振り防止)が、整える鎖は 1 本も持たない', () => {
    const src = codeOnly(readFileSync(file, 'utf-8'));
    const players = (src.match(/\.controls=true/g) ?? []).length;
    expect(players, '書き出し HTML に再生機を作る所が無い(前処理が壊れている)').toBeGreaterThanOrEqual(2);
    expect(src.includes('appVoiceBoostRouter'), '書き出し HTML が整える鎖を持っている ── 裁定(設問 1 = A)と食い違う').toBe(false);
    expect(src.includes('voice-boost'), '書き出し HTML が voice-boost を import している').toBe(false);
  });
});

/**
 * 🔴 **3 つの切り替え**(#952 B2・B3)── 「音を聞きやすくする」「音量をそろえる」
 * 「頭の中で鳴る感じを和らげる」は独立で、どれか 1 つでも入っていれば鎖を通る。
 */
describe('3 つの切り替え(鎖の組み方)', () => {
  const m = (voice: boolean, level: boolean, crossfeed: boolean) => ({ voice, level, crossfeed });

  it('段の組み方:声は唸り+圧縮+増幅、音量は圧縮+増幅(2 重に掛けない)、左右は最後', () => {
    expect(planStages(m(false, false, false))).toEqual([]);
    expect(planStages(m(true, false, false))).toEqual(['highpass', 'compressor', 'makeup']);
    expect(planStages(m(false, true, false))).toEqual(['compressor', 'makeup']);
    expect(planStages(m(false, false, true))).toEqual(['crossfeed']);
    expect(planStages(m(true, true, true))).toEqual(['highpass', 'compressor', 'makeup', 'crossfeed']);
  });

  it('保存:3 つは別の鍵に書かれ、互いに動かさない', () => {
    const map = new Map<string, string>();
    const st = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    const s = new VoiceBoostStore(st);
    s.setLevelEnabled(true);
    expect([s.enabled(), s.levelEnabled(), s.crossfeedEnabled()]).toEqual([false, true, false]);
    s.setCrossfeedEnabled(true);
    expect(s.mode()).toEqual(m(false, true, true));
    expect(Object.fromEntries(map)).toEqual({ 'pkc3.voice-level': '1', 'pkc3.voice-crossfeed': '1' });
    // 往復:別の store が同じ保存を読んでも同じ
    expect(new VoiceBoostStore(st).mode()).toEqual(m(false, true, true));
  });

  it('🔴 「聞きやすくする」が切でも、他の 1 つが入っていれば再生機は鎖を通る(対照:全部切なら通らない)', () => {
    const host = fakeHost();
    const s = new VoiceBoostStore(null);
    const r = new VoiceBoostRouter(() => host, () => s.anyEnabled(), () => s.mode());
    r.watch(media());
    expect(host.sources).toHaveLength(0);
    s.setCrossfeedEnabled(true);
    r.refresh();
    expect(host.sources).toHaveLength(1);
    s.setCrossfeedEnabled(false);
    r.refresh();
    // 切に戻したら出口へ繋ぎ直す(無音にしない)
    expect(host.sources[0]!.to).toBe(host.destination);
  });

  it('切り替えが変わるたび、器へ「いまの組み方」が渡る', () => {
    const host = fakeHost();
    const seen: unknown[] = [];
    const configurable = Object.assign(host, { configure: (mode: unknown) => void seen.push(mode) });
    const s = new VoiceBoostStore(null);
    s.setLevelEnabled(true);
    const r = new VoiceBoostRouter(() => configurable, () => s.anyEnabled(), () => s.mode());
    r.watch(media());
    s.setCrossfeedEnabled(true);
    r.refresh();
    expect(seen.at(-1)).toEqual(m(false, true, true));
  });
});

describe('webAudioHost の鎖(WebAudio を偽物に差し替える)', () => {
  class N {
    static all: N[] = [];
    outs = new Set<N>();
    constructor(public kind: string) {
      N.all.push(this);
    }
    connect(to: N): N {
      this.outs.add(to);
      return to;
    }
    disconnect(): void {
      this.outs.clear();
    }
    type = '';
    frequency = { value: 0 };
    gain = { value: 0 };
    threshold = { value: 0 };
    knee = { value: 0 };
    ratio = { value: 0 };
    attack = { value: 0 };
    release = { value: 0 };
  }
  class Ctx {
    state = 'running';
    destination = new N('destination');
    createGain = () => new N('gain');
    createBiquadFilter = () => new N('biquad');
    createDynamicsCompressor = () => new N('compressor');
    createChannelSplitter = () => new N('splitter');
    createChannelMerger = () => new N('merger');
    createMediaElementSource = () => new N('source');
    resume = () => Promise.resolve();
  }
  const kinds = () => N.all.map((n) => n.kind);
  const reach = (from: N, seen = new Set<N>()): Set<N> => {
    for (const o of from.outs) {
      if (!seen.has(o)) {
        seen.add(o);
        reach(o, seen);
      }
    }
    return seen;
  };

  it('左右を混ぜる段は、入れたときだけ作られ、同じ組み方の再設定では作り直さない', () => {
    N.all = [];
    vi.stubGlobal('AudioContext', Ctx);
    try {
      const host = webAudioHost()!;
      const head = host.head as unknown as N;
      const dest = host.destination as unknown as N;
      expect(kinds()).not.toContain('splitter');
      host.configure!({ voice: true, level: false, crossfeed: true });
      expect(kinds()).toContain('splitter');
      expect(kinds()).toContain('merger');
      const n = N.all.length;
      host.configure!({ voice: true, level: false, crossfeed: true });
      expect(N.all.length, '同じ組み方で作り直している').toBe(n);
      // 出口まで届いている(無音にしない)
      expect(reach(head).has(dest)).toBe(true);
      // 左右を外す → 経路から splitter が消え、圧縮は残る
      host.configure!({ voice: true, level: false, crossfeed: false });
      const comps = [...reach(head)].map((x) => x.kind);
      expect(comps).not.toContain('splitter');
      expect(comps).toContain('compressor');
      expect(reach(head).has(dest)).toBe(true);
      // 全部切 → 入口が出口へ直結
      host.configure!({ voice: false, level: false, crossfeed: false });
      expect([...head.outs]).toEqual([dest]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('音量をそろえるを入れると、圧縮が強め(声だけのときと違う値)になる', () => {
    N.all = [];
    vi.stubGlobal('AudioContext', Ctx);
    try {
      const host = webAudioHost()!;
      const ratioOf = (): number => N.all.filter((n) => n.kind === 'compressor').at(-1)!.ratio.value;
      host.configure!({ voice: true, level: false, crossfeed: false });
      expect(ratioOf()).toBe(VOICE_BOOST.ratio);
      host.configure!({ voice: true, level: true, crossfeed: false });
      expect(ratioOf()).toBe(LEVEL_OUT.ratio);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
