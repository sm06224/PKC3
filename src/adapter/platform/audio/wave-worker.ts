/**
 * 波形ワーカーの**配線だけ**(#1232)。🔴 中身は `wave-codec.ts`(`audio-worker.ts` と同じ理由)。
 * ⚠ 返す山の配列は **transfer**(ゼロコピー)。
 */
import { wavePeaks, type WaveJob } from './wave-codec';

interface Incoming {
  id: number;
  payload: WaveJob;
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<Incoming>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (ev: MessageEvent<Incoming>): void => {
  const { id, payload } = ev.data;
  try {
    const peaks = wavePeaks(payload);
    ctx.postMessage({ id, ok: true, result: peaks }, [peaks.buffer]);
  } catch (e) {
    ctx.postMessage({ id, ok: false, error: String(e) });
  }
};
