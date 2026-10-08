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
 * 🔴 **「ほぼ無音」の足切り**(#1446 B)── これより小さい RMS(Float32、`-1..1`)の録音は、認識に渡さない。
 *
 * ⚠ 値の根拠(2026-10-08 の実測、`docs/development/asr-measure-2026-10.md` と #1446):
 *   whisper(base / q8)は**デジタル無音でも `you you you` を出す**(無音に字を出す既知の癖で、
 *   `repetition_penalty` / `no_repeat_ngram_size` では消えず、音声のほうを壊した)。
 *   一方、合成音声を縮めた物は RMS 1.6e-4(−76 dBFS)まで字になり、5.1e-5(−86 dBFS)で崩れた。
 *   🔑 **1e-4(−80 dBFS)は「音声を 1 件も切らない」側の値** ── 切れるのはデジタル無音とそれに近い物だけ。
 * ⚠ 雑音(−48 / −68 dBFS)は小さい声と同じ帯なので、RMS では切れない(切ると声も切る)。
 *   雑音の幻覚は別の手当てが要る(#1446)。
 * ⚠ 音声を含む長い録音は全体の RMS が大きいので、途中の無音はここでは見ない(その区間に幻覚は出なかった ── 1 例)。
 */
export const ASR_SILENCE_RMS = 1e-4;

/** PCM(Float32、`-1..1`)の RMS。空なら 0。 */
export function pcmRms(pcm: Float32Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}

/** ほぼ無音か(認識に渡しても字にできる音が無い)。⚠ 判定はここ 1 つ ── 呼び側で閾値を書かない。 */
export function isNearSilent(pcm: Float32Array): boolean {
  return pcmRms(pcm) < ASR_SILENCE_RMS;
}
