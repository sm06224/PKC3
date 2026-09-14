/**
 * 🔴 **聞くときだけ音を整える**(#772 段① B。user 要望 2026-09-07「音声明瞭化」)。
 *
 * 押し所は設定の 1 つだけ:**入にすると、PKC の中で鳴らす音が聞きやすくなる。**
 * ⚠ **録った音そのものは 1 バイトも変わらない** ── 変えているのは**出口**だけなので、
 *   切れば元の聞こえ方へ戻るし、書き出した file も元のままである。
 *
 * ## 🔴 この形でいちばん危ないこと ── **無音にしてしまう**
 *
 * ⚠ ブラウザの決まりで、`createMediaElementSource` を **1 度でも呼んだ要素**は、
 *   以後**その音を自分では出さなくなる**(鎖の先へ繋がなければ**無音**になる)。
 *   しかも `<audio>` の見た目は**再生中のまま**なので、user からは
 *   「動いているのに聞こえない」という**いちばん気づけない壊れ方**になる。
 *
 * 🔑 だから守りを 3 つ置く:
 *
 * 1. **切のときは 1 度も呼ばない** ── 触らなければ素のまま鳴る(`watch` が何もしない)
 * 2. **切に戻したら、出口へ繋ぎ直す**(`bypass`)── 外して終わりにしない
 * 3. **鎖が作れなかった端末では、何もしない**(`WebAudio` を持たない / 作れない)──
 *    整わないだけで、**鳴らなくなるよりはるかに良い**
 *
 * ## ⚠ `AudioContext` は捨てない(ワーカーの規律の対象外)
 *
 * user 指示 2026-08-03「ワーカーはしばらく使われないならキルと解放」は**計算のワーカー**
 * の話である。⚠ ここは**音の通り道そのもの**なので、閉じると上の①の無音になる。
 * 🔑 代わりに「**入にした人の端末にしか作らない**」で常駐を抑える。
 */

/** ⚠ `AudioNode` をそのまま受けるための最小の形(test が偽物を渡せるように狭くする)。 */
export interface BoostNode {
  connect(to: BoostNode): unknown;
  disconnect(): unknown;
}

/** 音を整える鎖を 1 本持つ器。⚠ 鎖は**器に 1 本**(再生機ごとに作らない)。 */
export interface BoostHost {
  /** 素の出口(= 切に戻すときの繋ぎ先)。 */
  readonly destination: BoostNode;
  /** 整える鎖の入口。⚠ 出口までは器の側で繋いである。 */
  readonly head: BoostNode;
  /** ⚠ **1 つの要素につき 1 度しか作れない**(2 度目は例外になる)。 */
  source(el: HTMLMediaElement): BoostNode;
  /** 止まっていたら動かす(端末によっては user の操作の中でしか動かない)。 */
  resume(): void;
}

/**
 * 🔑 **どう整えるかは、ここ 1 か所だけが決める**(CLAUDE.md §7)。
 *
 * - `highpassHz` ── 机の振動・空調のような**低い唸り**を落とす(声はこの下にほぼ無い)
 * - 圧縮の 4 つ ── **小さい声を持ち上げ、大きい所を抑える**(録音の音量ムラを均す)
 * - `makeupGain` ── 圧縮で下がったぶんを戻す。⚠ **上げすぎると割れる**ので控えめにする
 */
export const VOICE_BOOST = {
  highpassHz: 85,
  thresholdDb: -34,
  kneeDb: 30,
  ratio: 6,
  attackSec: 0.003,
  releaseSec: 0.25,
  makeupGain: 1.7,
} as const;

/**
 * 再生機を憶えておいて、設定の入切に合わせて繋ぎ替える。
 *
 * ⚠ **憶えるだけでは繋がない** ── 切のときに `source` を作ってしまうと、
 *   その要素は以後**鎖を通らないと鳴らない**体になる(上の①)。
 */
export class VoiceBoostRouter {
  private host: BoostHost | null = null;
  /** ⚠ 1 度作れなかった器を、再生機ごとに作り直さない。 */
  private hostTried = false;
  /** 既に鎖へ繋いだ要素の入口。⚠ **2 度目の `source` を呼ばないための台帳**でもある。 */
  private readonly wired = new WeakMap<HTMLMediaElement, BoostNode>();
  /** 設定が変わったときに繋ぎ替える相手。⚠ **弱い参照**で持つ(器ごと道連れにしない)。 */
  private readonly seen: WeakRef<HTMLMediaElement>[] = [];

  constructor(
    private readonly makeHost: () => BoostHost | null,
    private readonly on: () => boolean,
  ) {}

  /** 再生機を 1 枚置いたら呼ぶ。⚠ **切のときは何もしない**(素の再生のまま)。 */
  watch(el: HTMLMediaElement): void {
    this.remember(el);
    if (this.on()) this.wire(el);
  }

  /** 設定が変わったら呼ぶ。⚠ **既に置いてある再生機も**その場で切り替わる。 */
  refresh(): void {
    const on = this.on();
    for (const el of this.living()) {
      if (on) this.wire(el);
      else this.bypass(el);
    }
  }

  /** 🔑 test のための観測点 ── いま鎖を通している要素の数。 */
  wiredCount(): number {
    let n = 0;
    for (const el of this.living()) if (this.wired.has(el)) n += 1;
    return n;
  }

  private remember(el: HTMLMediaElement): void {
    for (const ref of this.seen) if (ref.deref() === el) return;
    // ⚠ 死んだ参照はここで掃く(器が増え続けないように)
    if (this.seen.length > 32) {
      const alive = this.seen.filter((r) => r.deref() !== undefined);
      this.seen.length = 0;
      this.seen.push(...alive);
    }
    this.seen.push(new WeakRef(el));
  }

  private living(): HTMLMediaElement[] {
    const out: HTMLMediaElement[] = [];
    for (const ref of this.seen) {
      const el = ref.deref();
      if (el !== undefined) out.push(el);
    }
    return out;
  }

  private ensureHost(): BoostHost | null {
    if (this.host !== null || this.hostTried) return this.host;
    this.hostTried = true;
    try {
      this.host = this.makeHost();
    } catch {
      this.host = null;
    }
    return this.host;
  }

  private wire(el: HTMLMediaElement): void {
    const host = this.ensureHost();
    // ⚠ 器が無い端末は**触らない** ── 整わないだけで、素のまま鳴る
    if (host === null) return;
    let src = this.wired.get(el);
    if (src === undefined) {
      try {
        src = host.source(el);
      } catch {
        // ⚠ 作れなかった(既に誰かが作った等)── 素のまま鳴らせる状態を壊さない
        return;
      }
      this.wired.set(el, src);
    }
    src.disconnect();
    src.connect(host.head);
    host.resume();
  }

  /**
   * 🔴 **外して終わりにしない** ── 1 度鎖へ入れた要素は、
   *   出口へ繋ぎ直さないと**無音**になる。
   */
  private bypass(el: HTMLMediaElement): void {
    const src = this.wired.get(el);
    const host = this.host;
    // ⚠ 1 度も繋いでいない要素は**素のまま** ── ここで触ると、むしろ壊す
    if (src === undefined || host === null) return;
    src.disconnect();
    src.connect(host.destination);
  }
}

/** ブラウザの `WebAudio` で鎖を 1 本組む。⚠ 持っていない端末では `null`。 */
export function webAudioHost(): BoostHost | null {
  const Ctor: typeof AudioContext | undefined =
    typeof AudioContext !== 'undefined' ? AudioContext : undefined;
  if (Ctor === undefined) return null;
  const ctx = new Ctor();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = VOICE_BOOST.highpassHz;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = VOICE_BOOST.thresholdDb;
  comp.knee.value = VOICE_BOOST.kneeDb;
  comp.ratio.value = VOICE_BOOST.ratio;
  comp.attack.value = VOICE_BOOST.attackSec;
  comp.release.value = VOICE_BOOST.releaseSec;
  const gain = ctx.createGain();
  gain.gain.value = VOICE_BOOST.makeupGain;
  hp.connect(comp);
  comp.connect(gain);
  gain.connect(ctx.destination);
  return {
    destination: ctx.destination,
    head: hp,
    source: (el) => ctx.createMediaElementSource(el),
    resume: () => {
      if (ctx.state === 'suspended') void ctx.resume();
    },
  };
}
