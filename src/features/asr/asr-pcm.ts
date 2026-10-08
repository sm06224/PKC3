/**
 * 音を認識へ渡す形に直す(#772 段②)。⚠ **pure**(browser API を触らない)。
 *
 * whisper が受けるのは **16kHz / mono の Float32(`-1..1`)**。デコードと再標本化は
 * ブラウザが持つ(`AudioContext` ── `asr-decode.ts`)ので、ここは**チャンネルを 1 本にする**
 * ところだけを持つ。
 */

/**
 * 複数チャンネルを平均して 1 本にする。
 *
 * - 1 本なら**写して返す**(呼び側は transfer で渡す ── `AudioBuffer` の持ち物を譲らせない)。
 * - ⚠ 長さの違うチャンネルは**短いほうに合わせる**(読み出しの範囲外で `NaN` を作らない)。
 * - 0 本は空を返す(音が無い)。
 */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!.slice();
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  const k = channels.length;
  for (const c of channels) {
    for (let i = 0; i < n; i++) out[i]! += c[i]! / k;
  }
  return out;
}

/**
 * 🔴 **「ほぼ無音」の足切り**(#1446 B)── RMS(Float32、`-1..1`)が `ASR_SILENCE_RMS` 未満で、**かつ**
 *   ピークが `ASR_SILENCE_PEAK` 未満の録音は、認識に渡さない。
 *
 * ⚠ 値の根拠(2026-10-08 の実測。#1446 のコメント「段 3」に表):
 *   whisper(base / q8)は**デジタル無音でも `you you you` を出す**(無音に字を出す既知の癖で、
 *   `repetition_penalty` / `no_repeat_ngram_size` では消えず、音声のほうを壊した)。
 *   合成音声を縮めた物は RMS 1.6e-4(−76 dBFS、ピーク 7.3e-4)まで字になり、5.1e-5(−86 dBFS、ピーク 2.4e-4)で崩れた。
 *   🔑 **RMS 1e-4(−80 dBFS)は「音声を 1 件も切らない」側の値** ── 切れるのはデジタル無音とそれに近い物だけ。
 * ⚠ **ピークの門が要る理由**(着地前レビュー 2026-10-08 #6):RMS は全体の平均なので、長いデジタル無音の中に
 *   短い小さい発話が 1 つだけ在る録音(例: 1 時間の中の 2 秒、振幅 0.003)は全体 RMS が 7e-5 と閾値を割る。
 *   ピーク 5e-4(崩れた側 2.4e-4 と字になった側 7.3e-4 の間)を併せて見れば、**長さに依らず**発話が在れば渡す。
 *   実マイクにはノイズフロア(−60 dBFS 前後)が在るので普通は起きないが、ノイズゲートで隙間が厳密に 0 になる経路では起きうる。
 * ⚠ 雑音(−48 / −68 dBFS)は小さい声と同じ帯なので、RMS では切れない(切ると声も切る)。
 *   雑音の幻覚は別の手当てが要る(#1446)。
 */
export const ASR_SILENCE_RMS = 1e-4;
export const ASR_SILENCE_PEAK = 5e-4;

/** PCM(Float32、`-1..1`)の RMS とピーク(絶対値の最大)。空なら両方 0。⚠ 1 回の走査で両方を出す(1 時間の録音で約 100 ms)。 */
export function pcmStats(pcm: Float32Array): { readonly rms: number; readonly peak: number } {
  if (pcm.length === 0) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]!;
    sum += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sum / pcm.length), peak };
}

/** PCM の RMS(`pcmStats` の片方。test と呼び側の読みやすさのため)。 */
export function pcmRms(pcm: Float32Array): number {
  return pcmStats(pcm).rms;
}

/** ほぼ無音か(認識に渡しても字にできる音が無い)。⚠ 判定はここ 1 つ ── 呼び側で閾値を書かない。 */
export function isNearSilent(pcm: Float32Array): boolean {
  const { rms, peak } = pcmStats(pcm);
  return rms < ASR_SILENCE_RMS && peak < ASR_SILENCE_PEAK;
}
