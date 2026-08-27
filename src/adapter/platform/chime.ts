/**
 * 🔴 **短い知らせ音**(#280。タイマー #279 とアラートで**共有する 1 本**)。
 *
 * ## なぜ音の file を持たないか
 *
 * 🔑 **その場で作る**(`OscillatorNode`)── 配る物が増えず、
 *   復号も取得も待たない。⚠ user 指示 2026-08-03「配布サイズは気にしないで欲しい」
 *   の逆を狙っているのではなく、**待ち時間が 0 になる**のが理由である
 *   (鳴るべき瞬間に鳴らないと、知らせとして役に立たない)。
 *
 * ## ⚠ 器は毎回作って、毎回閉じる
 *
 * `AudioContext` は端末ごとに**同時に持てる数に上限**がある(6 個前後)。
 * 抱えたままにすると、別の面が音を出せなくなる。⚠ 鳴らし終わったら `close()`
 * ── 不可侵指示 2026-08-03「使われないなら kill と解放」と同じ向きである。
 *
 * ## ⚠ 鳴らない端末がある(そして、それでよい)
 *
 * ブラウザは「user が 1 度も触っていないページ」の音を止める。
 * 🔑 だから **音は添え物**にして、知らせの本体は**画面の帯**にしてある ──
 *   音が出なかったことを毎回言うと、それ自体が邪魔になる(帯は必ず出る)。
 * ⚠ 返り値で「鳴ったか」は返す ── 呼び側が**1 度だけ**言いたくなったときのため。
 */

/** 鳴らす口。⚠ test はここを差し替える(本物の `AudioContext` を作らせない)。 */
export interface Chime {
  /** 鳴らす。返り値 = **実際に鳴らせたか**(止められた端末では `false`)。 */
  play(): Promise<boolean>;
}

type Ctor = new () => AudioContext;

function audioCtor(): Ctor | null {
  const w = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * 2 つの短い音(`ピ・ポ`)。
 * ⚠ **1 つにしない** ── 単発の音は端末の通知音と紛れる。2 つ続けば
 *   「アプリが鳴らした」と分かる。
 * ⚠ **長くしない**(合計 0.3 秒)── 知らせであって、鳴り続ける物ではない。
 */
const NOTES: readonly { hz: number; at: number; len: number }[] = [
  { hz: 880, at: 0, len: 0.12 },
  { hz: 1320, at: 0.16, len: 0.14 },
];

export function createChime(ctor: Ctor | null = audioCtor()): Chime {
  return {
    async play(): Promise<boolean> {
      if (ctor === null) return false;
      let ctx: AudioContext | null = null;
      try {
        ctx = new ctor();
        // ⚠ **止められていたら起こす** ── user が触った後なら通る
        if (ctx.state === 'suspended') await ctx.resume();
        if (ctx.state !== 'running') {
          await ctx.close();
          return false;
        }
        const t0 = ctx.currentTime;
        for (const n of NOTES) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = n.hz;
          /**
           * ⚠ **山なりに絞る** ── 角を立てると「プツッ」と鳴る(クリックノイズ)。
           *   耳障りな知らせは、user が音そのものを切る理由になる。
           */
          gain.gain.setValueAtTime(0.0001, t0 + n.at);
          gain.gain.exponentialRampToValueAtTime(0.2, t0 + n.at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t0 + n.at);
          osc.stop(t0 + n.at + n.len);
        }
        const last = NOTES[NOTES.length - 1]!;
        const doneIn = (last.at + last.len + 0.05) * 1000;
        // ⚠ **鳴り終わってから閉じる**(先に閉じると音が切れる)
        const ctxToClose = ctx;
        setTimeout(() => void ctxToClose.close().catch(() => undefined), doneIn);
        return true;
      } catch {
        // ⚠ 音は添え物 ── 出せなくても知らせ(帯)は出る
        try {
          await ctx?.close();
        } catch {
          // 閉じられないだけ
        }
        return false;
      }
    },
  };
}
