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
