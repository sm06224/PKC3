/**
 * 声の仕上げワーカーの**配線だけ**(#952 B1・#674・B4・B5)。
 *
 * 🔴 **中身は `voice-run.ts`**(`audio-worker.ts` と同じ理由 ── 同居させると import しただけでメインの `onmessage` を奪う)。
 * ⚠ **使い捨て**(CLAUDE.md「重い処理はワーカーへ。ワーカーは使い捨てにする」)── 遅延起動・バッファ・アイドル kill は
 *   `WorkerLease` が持つ。RNNoise の wasm は最初の依頼で初めて読み込み(動的 import)、同じワーカーが生きている間だけ使い回す。
 *   畳むのは terminate(wasm のメモリごと消える)。
 * ⚠ 返す bytes は **transfer**(ゼロコピー)。例外を握り潰さない ── 呼び側が「この 1 件だけ落ちた」と分かる形で返す。
 */
import { VoiceRunner, type EngineHandle, type VoiceJob } from './voice-run';

interface Incoming {
  id: number;
  payload: VoiceJob;
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<Incoming>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

type RnnoiseModule = typeof import('@shiguredo/rnnoise-wasm');
let loaded: Promise<Awaited<ReturnType<RnnoiseModule['Rnnoise']['load']>>> | null = null;

const runner = new VoiceRunner({
  createEngine: async (): Promise<EngineHandle> => {
    // ⚠ wasm の読み込みは 1 度だけ(失敗したら次の依頼でやり直せるよう、失敗は覚えない)
    loaded ??= import('@shiguredo/rnnoise-wasm').then((m) => m.Rnnoise.load());
    let rn: Awaited<ReturnType<RnnoiseModule['Rnnoise']['load']>>;
    try {
      rn = await loaded;
    } catch (e) {
      loaded = null;
      throw e;
    }
    const state = rn.createDenoiseState();
    return { process: (frame) => state.processFrame(frame), destroy: () => state.destroy() };
  },
});

ctx.onmessage = (ev: MessageEvent<Incoming>): void => {
  const { id, payload } = ev.data;
  void runner.run(payload).then(
    (result) => {
      const transfer: Transferable[] = [];
      if (result.ok && result.kind === 'audio') for (const f of result.files) transfer.push(f.bytes);
      ctx.postMessage({ id, ok: true, result }, transfer);
    },
    (e: unknown) => {
      ctx.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    },
  );
};
