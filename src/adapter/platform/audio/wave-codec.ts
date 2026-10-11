/**
 * 🔴 **波形の山を畳む本体**(#1232)。ワーカーの外からも呼べる形で置く
 * (`audio-codec.ts` と同じ理由 ── ワーカーの配線と同居させると import しただけで `onmessage` を奪う)。
 *
 * ⚠ 受け取った PCM は**畳んだら捨てる**(返すのは山の配列だけ)。
 */
import { computePeaks } from '@features/audio/waveform';

export interface WaveJob {
  /** 各チャンネルの PCM。⚠ 呼び側は**転送で渡す**(渡した後は触らない)。 */
  readonly channels: Float32Array[];
  readonly points: number;
}

export function wavePeaks(job: WaveJob): Float32Array {
  return computePeaks(job.channels, job.points);
}
