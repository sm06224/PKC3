/**
 * 🔴 **録音の途中にある長い無音を、認識に渡す前に切り落とす**(#1446 ①「無音区間の切り落とし」)。⚠ **pure**。
 *
 * whisper は無音・雑音に字を出す癖がある(`you you you` / 「ああああ」)。録音全体がほぼ無音なら
 * `isNearSilent`(`asr-pcm.ts`)が認識の前に断る。ここは**その手前の段**で、話し声の**あいだに挟まる長い無音**を
 * 認識に渡さない ── 渡さなければ、そこに幻覚は出ようがない(`no_speech_threshold` 相当を、生成の側ではなく**入力の側**で行う)。
 *
 * ## なぜ生成の側(`repetition_penalty` など)ではないか
 * 2026-10-08 の測定(#1446 コメント「段 3」。base / q8 / wasm / 合成音声 1 話者 / 走り 30 本)で、`repetition_penalty` 1.3 は
 * 音声の誤り率を 17.8% → 68.1% に悪化させ、`no_repeat_ngram_size` は何も変えなかった(無音の `you you you` はどちらでも消えない)。
 * 悪化させるのは、正しい語の繰り返し・時刻の記号まで罰するため。**入力から無音を除く**・**出力の暴走だけを後で除く**なら、
 * 生成の確率を触らないので誤り率は動かない。
 *
 * ## 無音の決め方
 * 20 ms の枠ごとの RMS を見て、**いちばん大きい枠の `ASR_CUT_RELATIVE` 倍**と `ASR_CUT_FLOOR` の大きいほうより小さい枠を無音とする
 * (小さく録れた録音で声まで無音と読まないため ── `silence-trim.ts` と同じ向き)。
 * **`ASR_CUT_MIN_MS` 以上続く無音だけ**を切り(語間・文間の間は切らない)、切った所の両側に `ASR_CUT_KEEP_MS` ずつ残す。
 * 切ったあとの時刻は `remapMs` で元の録音の時刻へ戻す(文字起こしの時刻・字幕は元の録音に合う)。
 */

/** 枠の長さ(ms)。 */
export const ASR_CUT_FRAME_MS = 20;
/** 無音の下限(RMS。Float32、`-1..1`)。これより小さい枠は、どんなに録音が小さくても無音(−60 dBFS)。 */
export const ASR_CUT_FLOOR = 1e-3;
/** 無音のしきい値の、いちばん大きい枠に対する割合(約 −26 dB)。 */
export const ASR_CUT_RELATIVE = 0.05;
/** これ以上続いた無音だけを切る(ms)。語間・文間の間(せいぜい 1〜2 秒)は切らない。 */
export const ASR_CUT_MIN_MS = 4000;
/** 切った所の両側に残す無音(ms)。語頭・語尾を削らず、「ここで途切れた」という間も残す。 */
export const ASR_CUT_KEEP_MS = 500;
/** 切れる合計がこれ未満なら、何もしない(切る手間と時刻の付け替えに見合わない)。 */
export const ASR_CUT_MIN_SAVED_MS = 2000;

/** 元の PCM のうち、残す範囲(標本数の半開区間)。 */
export interface KeptRange {
  readonly start: number;
  readonly end: number;
}

export interface SilenceCut {
  /** 残す範囲(昇順・重ならない)。 */
  readonly keep: readonly KeptRange[];
  /** 切り落とした合計の標本数。 */
  readonly cutSamples: number;
  /** 切った数(無音の塊の数)。 */
  readonly cuts: number;
}

/**
 * 切り落とす範囲を決める。**切る物が無ければ `null`**(呼び側は元の PCM をそのまま渡す)。
 * ⚠ 枠の RMS を全部持たず、2 回走査する(1 時間の録音で枠 18 万個の `Float32Array` を足さない)。
 */
export function planSilenceCut(pcm: Float32Array, rate: number): SilenceCut | null {
  const frame = Math.max(1, Math.round((rate * ASR_CUT_FRAME_MS) / 1000));
  const frames = Math.floor(pcm.length / frame);
  if (frames < 2) return null;
  const rmsAt = (k: number): number => {
    let s = 0;
    const base = k * frame;
    for (let i = 0; i < frame; i++) {
      const v = pcm[base + i]!;
      s += v * v;
    }
    return Math.sqrt(s / frame);
  };
  let loud = 0;
  for (let k = 0; k < frames; k++) {
    const r = rmsAt(k);
    if (r > loud) loud = r;
  }
  const threshold = Math.max(ASR_CUT_FLOOR, loud * ASR_CUT_RELATIVE);
  if (loud < ASR_CUT_FLOOR) return null; // 全体が無音 ── `isNearSilent` の仕事(ここでは切らない)
  const minFrames = Math.ceil(ASR_CUT_MIN_MS / ASR_CUT_FRAME_MS);
  const keepFrames = Math.round(ASR_CUT_KEEP_MS / ASR_CUT_FRAME_MS);

  const keep: KeptRange[] = [];
  let cursor = 0; // 次に残す範囲の始まり(標本)
  let cutSamples = 0;
  let cuts = 0;
  let runStart = -1;
  const closeRun = (endFrame: number): void => {
    if (runStart < 0) return;
    const start = runStart;
    const len = endFrame - start;
    runStart = -1;
    if (len < minFrames) return;
    // 無音の頭と尻を `keepFrames` ずつ残し、真ん中を切る
    const cutFrom = (start + keepFrames) * frame;
    const cutTo = (endFrame - keepFrames) * frame;
    if (cutTo <= cutFrom) return;
    keep.push({ start: cursor, end: cutFrom });
    cursor = cutTo;
    cutSamples += cutTo - cutFrom;
    cuts += 1;
  };
  for (let k = 0; k < frames; k++) {
    if (rmsAt(k) < threshold) {
      if (runStart < 0) runStart = k;
    } else {
      closeRun(k);
    }
  }
  closeRun(frames); // 末尾の無音(尾の端数の標本は残す側へ)
  if (cuts === 0 || (cutSamples * 1000) / rate < ASR_CUT_MIN_SAVED_MS) return null;
  keep.push({ start: cursor, end: pcm.length });
  return { keep, cutSamples, cuts };
}

/** 切った PCM を作る(新しい配列。⚠ 呼び側は元の PCM を手放す)。 */
export function applySilenceCut(pcm: Float32Array, cut: SilenceCut): Float32Array {
  const out = new Float32Array(pcm.length - cut.cutSamples);
  let at = 0;
  for (const r of cut.keep) {
    out.set(pcm.subarray(r.start, r.end), at);
    at += r.end - r.start;
  }
  return out;
}

/**
 * 切ったあとの録音の時刻(ms)を、元の録音の時刻へ戻す。
 * ⚠ 範囲の境目は「次の範囲の頭」に寄せる(切った所をまたいだ区間の終わりが、無音の中に落ちない)。
 */
export function remapMs(ms: number, cut: SilenceCut, rate: number): number {
  const target = (ms * rate) / 1000;
  let outAt = 0; // 切ったあとの PCM での、いまの範囲の始まり
  for (let i = 0; i < cut.keep.length; i++) {
    const r = cut.keep[i]!;
    const len = r.end - r.start;
    // 最後の範囲は、録音の終わりちょうど(`target === outAt + len`)も受ける
    if (target < outAt + len || i === cut.keep.length - 1) {
      return ((r.start + (target - outAt)) * 1000) / rate;
    }
    outAt += len;
  }
  return ms;
}
