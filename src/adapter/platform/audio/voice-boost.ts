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
  /**
   * 🔴 **鎖の中身を切り替えに合わせて組み直す**(#952 B2・B3)。⚠ 省略可 ── 持たない器は
   * 従来の 1 本(声を整える)のまま。⚠ `head` と出口は変えない(繋いだ要素は繋ぎ直さない)。
   */
  configure?(mode: BoostMode): void;
}

/** 🔴 3 つの切り替え(設定の同じ節。互いに独立)。どれか 1 つでも入っていれば鎖を通す。 */
export interface BoostMode {
  /** 「音を聞きやすくする」── 低い唸りを落とし、声を持ち上げる。 */
  readonly voice: boolean;
  /** 「音量をそろえる」(#952 B2)── 小さい声と大きい声の差を縮める。 */
  readonly level: boolean;
  /** 「頭の中で鳴る感じを和らげる」(#952 B3)── 左右を少し混ぜる。 */
  readonly crossfeed: boolean;
}

export const MODE_ANY = (m: BoostMode): boolean => m.voice || m.level || m.crossfeed;

/** 鎖の段の名前。⚠ 並びはここ 1 か所が決める(高域の唸り → 圧縮 → 増幅 → 左右)。 */
export type BoostStage = 'highpass' | 'compressor' | 'makeup' | 'crossfeed';

/**
 * 🔑 **どの段を通すか**(純粋な判定。test が直接当てる)。
 * 圧縮と増幅は「声を整える」と「音量をそろえる」が**共有**する ── 両方入れても 2 重には掛けない。
 */
export function planStages(mode: BoostMode): BoostStage[] {
  const out: BoostStage[] = [];
  if (mode.voice) out.push('highpass');
  if (mode.voice || mode.level) out.push('compressor', 'makeup');
  if (mode.crossfeed) out.push('crossfeed');
  return out;
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
 * 🔑 「音量をそろえる」の圧縮(#952 B2)── 声の整え方より**強め**にかけて、
 * 小さい声と大きい声の差を縮める。両方入っているときは、こちらを使う。
 * ⚠ `makeupGain` を上げすぎると割れるので、圧縮で下がる分を戻す程度にする。
 */
export const LEVEL_OUT = {
  thresholdDb: -42,
  kneeDb: 30,
  ratio: 10,
  attackSec: 0.003,
  releaseSec: 0.3,
  makeupGain: 2.2,
} as const;

/**
 * 🔑 「頭の中で鳴る感じを和らげる」(#952 B3)── 反対側の耳へ、低い所だけ少し回す。
 * `direct` は自分の側、`cross` は反対側から回す量、`lowpassHz` はそこで通す上限。
 */
export const CROSSFEED = {
  direct: 0.8,
  cross: 0.3,
  lowpassHz: 700,
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
    /** 🔴 どの段を通すか(#952)。省略時は従来どおり「声を整える」だけ。 */
    private readonly mode: () => BoostMode = () => ({ voice: true, level: false, crossfeed: false }),
  ) {}

  /** 再生機を 1 枚置いたら呼ぶ。⚠ **切のときは何もしない**(素の再生のまま)。 */
  watch(el: HTMLMediaElement): void {
    this.remember(el);
    if (this.on()) this.wire(el);
  }

  /** 設定が変わったら呼ぶ。⚠ **既に置いてある再生機も**その場で切り替わる。 */
  refresh(): void {
    const on = this.on();
    // 🔴 入のままでも**中身の切り替え**が変わりうる ── 鎖を組み直す(繋いだ要素はそのまま)
    if (on) this.ensureHost()?.configure?.(this.mode());
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
    /**
     * ⚠ 器が無い端末は**触らない** ── 整わないだけで、素のまま鳴る。
     * 🔑 **この 1 行の門は `tsc` が持っている** ── 外すと
     *   `'host' is possibly 'null'` が **4 件**出てコンパイルが通らない(2026-09-14 実測)。
     * ⚠ **変異試験で殺せないのは、この理由である** ── `vitest` は型を見ないので
     *   外した版でも走ってしまい、`host.source(el)` の `TypeError` が
     *   下の `catch` に飲まれて**外から見た結果が同じ**になる。
     *   🔑 だから**わざとらしい assert を足して殺しにいかない**
     *   (守っているのは型検査であって、この test ではない)。
     */
    if (host === null) return;
    host.configure?.(this.mode());
    let src = this.wired.get(el);
    if (src === undefined) {
      try {
        src = host.source(el);
      } catch {
        // ⚠ 作れなかった(既に誰かが作った等)── 素のまま鳴らせる状態を壊さない
        return;
      }
      this.wired.set(el, src);
      /**
       * 🔴 **鳴らし始める瞬間にも器を起こす**(#772 段① B)。
       *
       * ⚠ ブラウザは「user が触っていないページ」の音の器を**止めたまま**にする。
       *   🔴 そして**鎖を通している要素は、器が止まっていると進まない** ──
       *   押したのに再生機が動かない、という形で出る。
       * 🔑 `play` は**押した流れの中**なので、ここで起こせば必ず通る
       *   (`local-office-files.ts` の「許可は user の操作の中で」と同じ考え方)。
       * ⚠ 付けるのは**作った 1 度だけ**(`wired` に入る前)── `refresh` のたびに
       *   足すと、同じ要素に何枚も重なる。
       */
      el.addEventListener('play', () => host.resume());
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
  /** 入口。⚠ 固定 ── 繋ぎ替えのたびに要素を繋ぎ直さないで済むように、中身だけを組み替える。 */
  const head = ctx.createGain();
  let built: string | null = null;
  let nodes: AudioNode[] = [];

  const configure = (mode: BoostMode): void => {
    const stages = planStages(mode);
    // 🔑 同じ組み立てなら何もしない(再生中の音を途切れさせない)
    const key = `${stages.join(',')}|${mode.level ? 'L' : 'V'}`;
    if (key === built) return;
    built = key;
    head.disconnect();
    for (const n of nodes) n.disconnect();
    nodes = [];
    let tail: AudioNode = head;
    const add = (input: AudioNode, output: AudioNode = input): void => {
      tail.connect(input);
      tail = output;
      nodes.push(input, output);
    };
    const p = mode.level ? LEVEL_OUT : VOICE_BOOST;
    for (const st of stages) {
      if (st === 'highpass') {
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = VOICE_BOOST.highpassHz;
        add(hp);
      } else if (st === 'compressor') {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = p.thresholdDb;
        comp.knee.value = p.kneeDb;
        comp.ratio.value = p.ratio;
        comp.attack.value = p.attackSec;
        comp.release.value = p.releaseSec;
        add(comp);
      } else if (st === 'makeup') {
        const gain = ctx.createGain();
        gain.gain.value = p.makeupGain;
        add(gain);
      } else {
        // 左右を分け、自分の側(direct)+ 反対側から低い所だけ(cross)を混ぜて、また 2 本に戻す
        const split = ctx.createChannelSplitter(2);
        const merge = ctx.createChannelMerger(2);
        const sides: [number, number][] = [
          [0, 1],
          [1, 0],
        ];
        for (const [from, to] of sides) {
          const direct = ctx.createGain();
          direct.gain.value = CROSSFEED.direct;
          split.connect(direct, from);
          direct.connect(merge, 0, from);
          const low = ctx.createBiquadFilter();
          low.type = 'lowpass';
          low.frequency.value = CROSSFEED.lowpassHz;
          const cross = ctx.createGain();
          cross.gain.value = CROSSFEED.cross;
          split.connect(low, from);
          low.connect(cross);
          cross.connect(merge, 0, to);
          nodes.push(direct, low, cross);
        }
        add(split, merge);
      }
    }
    tail.connect(ctx.destination);
  };
  configure({ voice: true, level: false, crossfeed: false });
  return {
    destination: ctx.destination,
    head,
    source: (el) => ctx.createMediaElementSource(el),
    resume: () => {
      if (ctx.state === 'suspended') void ctx.resume();
    },
    configure,
  };
}
