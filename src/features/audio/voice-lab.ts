/**
 * 🔴 **声の仕上げの計算**(#952 B1 ノイズ低減 / #674 話し声とそれ以外の分離 / B5 声の大きさをそろえる)── pure。
 *
 * 土台は RNNoise(Xiph。BSD-3-Clause。`@shiguredo/rnnoise-wasm` の wasm ビルド、版は `package.json`)。
 * 48kHz・mono・480 サンプル(10ms)の枠を 1 枚ずつ受け、**雑音を引いた枠**と**声らしさ(0〜1)**を返す小さな再帰型 NN で、
 * モデルは wasm の中に入っている(取りに行かない)。ここは枠の出し入れと、その上の計算だけを持つ。
 *
 * ## 🔑 RNNoise の癖(実測)
 * - 出力は入力より **960 サンプル(20ms)遅れる** ── 揃えないと「元 − 雑音を引いた物」が壊れる(`ENGINE_DELAY`)
 * - 入力は **16 ビット整数の尺度(±32768)** を期待する ── 浮動小数の尺度のまま渡すと、ほぼ無音と見なされる
 *
 * ⚠ **`features/` 層なので browser API を持たない**。エンジンは `FrameEngine` として注入する(unit は本物の wasm も偽物も通せる)。
 */

/** 声の仕上げの標本化率。⚠ RNNoise が 48kHz 固定。 */
export const VOICE_RATE = 48_000;
/** 1 枠(10ms)。 */
export const VOICE_FRAME = 480;
/** RNNoise の出力が入力より遅れる標本数(実測 960 = 20ms)。 */
export const ENGINE_DELAY = 960;
/**
 * 仕上げられる録音の上限(ミリ秒)。⚠ 復号した PCM を丸ごと持つので、メモリで決まる。
 * 48kHz mono の float は 30 分で約 330MB。**同時に持つのは 約 3 倍(約 1GB)**:
 *  - メイン側の復号:ブラウザが返す全チャンネル(ステレオなら 2 本)+ mono に混ぜた 1 本
 *  - ワーカー側:元の PCM + 雑音を引いた PCM(+「声以外」を作る回はもう 1 本)── 使い終わった PCM は先に手放す(`voice-run.ts`)
 */
export const VOICE_MAX_MS = 30 * 60_000;
/**
 * 長さが分からない音(`Duration` の無い webm・webm 以外)を、復号の前に断る大きさの目安(byte)。
 * 音の 30 分は、256kbps の圧縮でも約 57MB ── それを超えたら長すぎる見込みとして断る(ふつうの録音は 64kbps 前後で 15MB 程度)。
 */
export const VOICE_FALLBACK_BYTES = 64 * 1024 * 1024;

/** 1 枠を受けて、その場で書き換え、声らしさ(0〜1)を返す。⚠ 枠は ±32768 の尺度。 */
export interface FrameEngine {
  process(frame: Float32Array): number;
}

const INT16 = 32768;

export interface EngineRun {
  /** 雑音を引いた PCM(入力と同じ長さ・同じ時刻に揃えてある)。 */
  readonly clean: Float32Array;
  /** 10ms ごとの声らしさ。`vad[k]` は入力の `[k*480, (k+1)*480)` に当たる。 */
  readonly vad: Float32Array;
}

/**
 * PCM(48kHz mono, ±1)をエンジンに通す。出力の遅れ(`ENGINE_DELAY`)は後ろへ無音を足して取り除くので、
 * `clean[i]` は `pcm[i]` と同じ時刻である。
 */
export function runEngine(pcm: Float32Array, engine: FrameEngine): EngineRun {
  const n = pcm.length;
  const total = n + ENGINE_DELAY;
  const frames = Math.ceil(total / VOICE_FRAME);
  const clean = new Float32Array(n);
  const vad = new Float32Array(Math.ceil(n / VOICE_FRAME));
  const frame = new Float32Array(VOICE_FRAME);
  for (let k = 0; k < frames; k += 1) {
    const base = k * VOICE_FRAME;
    for (let i = 0; i < VOICE_FRAME; i += 1) {
      const at = base + i;
      frame[i] = at < n ? pcm[at]! * INT16 : 0; // 末尾は無音で埋める(遅れた出力を押し出す)
    }
    const v = engine.process(frame);
    if (k < vad.length) vad[k] = v;
    for (let i = 0; i < VOICE_FRAME; i += 1) {
      const at = base + i - ENGINE_DELAY; // 遅れを取り除く
      if (at >= 0 && at < n) clean[at] = frame[i]! / INT16;
    }
  }
  return { clean, vad };
}

/** 声があるとみなす声らしさ。 */
export const VOICE_VAD = 0.5;
/** 立ち上がりの数枠は声らしさが不安定(雑音だけでも一瞬高く出る。実測)── 数えない。 */
export const VAD_WARMUP_FRAMES = 10;
/** 声らしい枠がこれ以上(200ms)なければ「声が見つからない」。 */
export const VAD_MIN_FRAMES = 20;

/** 声が入っているか(立ち上がりを除いて、声らしい枠が `VAD_MIN_FRAMES` 以上)。 */
export function hasVoice(vad: Float32Array): boolean {
  let n = 0;
  for (let k = VAD_WARMUP_FRAMES; k < vad.length; k += 1) if (vad[k]! > VOICE_VAD) n += 1;
  return n >= VAD_MIN_FRAMES;
}

/** `pcm − clean`(声以外の部分)。⚠ 新しい配列を作る。 */
export function residualOf(pcm: Float32Array, clean: Float32Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < out.length; i += 1) out[i] = pcm[i]! - clean[i]!;
  return out;
}

/** 二乗平均平方根(区間 `[from, to)`)。 */
export function rmsOf(x: Float32Array, from = 0, to = x.length): number {
  if (to <= from) return 0;
  let s = 0;
  for (let i = from; i < to; i += 1) s += x[i]! * x[i]!;
  return Math.sqrt(s / (to - from));
}

/** 最大の絶対値。 */
export function peakOf(x: Float32Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i += 1) m = Math.max(m, Math.abs(x[i]!));
  return m;
}

/** 区間(標本)。 */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export const LEVEL_DEFAULTS = {
  /** そろえる先の声の大きさ(RMS。約 −23 dBFS)。 */
  targetRms: 0.07,
  /** 上げる倍率の上限(約 +20 dB)と下げる倍率の下限(約 −12 dB)。雑音の底を持ち上げすぎない。 */
  maxGain: 10,
  minGain: 0.25,
  /** 区間の境で倍率を滑らかにつなぐ長さ(ミリ秒)。 */
  rampMs: 80,
  /** 声の区間とみなさない小さすぎる区間(RMS がこれ未満なら倍率 1 のまま)。 */
  floorRms: 2e-4,
} as const;

export interface LevelOptions {
  readonly targetRms?: number;
  readonly maxGain?: number;
  readonly minGain?: number;
  readonly rampMs?: number;
  readonly floorRms?: number;
}

/** 頭打ちにする柔らかい上限(±1 を超えて割れない)。 */
export function softLimit(v: number): number {
  const a = Math.abs(v);
  if (a < 0.8) return v;
  return Math.sign(v) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
}

/**
 * 🔴 **声の区間ごとに大きさをそろえる**(B5「マイクから遠い人も近い人も分かるように」)。
 *
 * 各区間(話している塊)の RMS を目標へ寄せる倍率を求め、区間の外は**近い区間の倍率を保ち**、区間の境は
 * `rampMs` で滑らかにつなぐ(急な倍率の段差で「ぷつっ」と鳴らさない)。最後に柔らかい上限を通す。
 * 倍率は `[minGain, maxGain]` に収める ── 遠い人を持ち上げるときに雑音の底まで持ち上げすぎない。
 * ⚠ 入力は**雑音を引いたあと**の PCM を渡す(雑音ごと持ち上げない)。新しい配列を返す。
 */
export function levelSegments(
  pcm: Float32Array,
  spans: readonly Span[],
  rate: number,
  options: LevelOptions = {},
): Float32Array {
  const target = options.targetRms ?? LEVEL_DEFAULTS.targetRms;
  const maxGain = options.maxGain ?? LEVEL_DEFAULTS.maxGain;
  const minGain = options.minGain ?? LEVEL_DEFAULTS.minGain;
  const rampMs = options.rampMs ?? LEVEL_DEFAULTS.rampMs;
  const floorRms = options.floorRms ?? LEVEL_DEFAULTS.floorRms;
  const n = pcm.length;
  // 区間ごとの倍率
  const gains = spans.map((s) => {
    const r = rmsOf(pcm, Math.max(0, s.start), Math.min(n, s.end));
    if (r < floorRms) return 1;
    return Math.min(maxGain, Math.max(minGain, target / r));
  });
  // 標本ごとの倍率の目標(区間の中はその倍率、外は直前の区間の倍率を保つ。先頭の外は最初の区間の倍率)
  const curve = new Float32Array(n).fill(1);
  if (spans.length > 0) {
    let si = 0;
    let hold = gains[0]!;
    for (let i = 0; i < n; i += 1) {
      while (si < spans.length && i >= spans[si]!.end) {
        hold = gains[si]!;
        si += 1;
      }
      curve[i] = si < spans.length && i >= spans[si]!.start ? gains[si]! : hold;
    }
  }
  // 滑らかにつなぐ(移動平均 = 区間の境の段差をならす)
  const ramp = Math.max(1, Math.round(rampMs * rate * 1e-3));
  const smooth = boxSmooth(curve, ramp);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = softLimit(pcm[i]! * smooth[i]!);
  return out;
}

/** 窓 `w` の移動平均(端は縮めて平均する)。累積和なので O(n)。 */
export function boxSmooth(x: Float32Array, w: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (w <= 1) {
    out.set(x);
    return out;
  }
  const half = Math.floor(w / 2);
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) cum[i + 1] = cum[i]! + x[i]!;
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = (cum[b]! - cum[a]!) / (b - a);
  }
  return out;
}
