/**
 * 音声認識ワーカーの**配線だけ**(#772 段②)。
 *
 * 🔴 **中身は `asr-run.ts`**(`audio-worker.ts` と同じ理由 ── 同居させると import しただけで
 * メインの `onmessage` を奪う)。
 *
 * ⚠ **使い捨て**(CLAUDE.md「重い処理はワーカーへ。ワーカーは使い捨てにする」)── 遅延起動・
 *   バッファ・アイドル kill は `WorkerLease` が持つ。ここは何も解放しない(terminate が畳む)。
 * ⚠ 例外を握り潰さない ── 呼び側が「この 1 件だけ落ちた」と分かる形で返す。
 */
import { AsrRunner, type AsrJob } from './asr-run';

interface Incoming {
  id: number;
  payload: AsrJob;
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<Incoming>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

const runner = new AsrRunner({
  // ⚠ 部品の URL は blob: ── bundler に解かせない(`@vite-ignore`)
  importModule: (url) => import(/* @vite-ignore */ url) as Promise<never>,
  createObjectURL: (blob) => URL.createObjectURL(blob),
});

ctx.onmessage = (ev: MessageEvent<Incoming>): void => {
  const { id, payload } = ev.data;
  void runner.run(payload).then(
    (result) => ctx.postMessage({ id, ok: true, result }),
    (e: unknown) => ctx.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
};
