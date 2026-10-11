/**
 * 動画の切り出しワーカーの**配線だけ**(#683 段②b-1)。
 *
 * 🔴 **中身は `video-codec.ts`**(`audio-worker.ts` と同じ理由 ── 同居させると import しただけで
 * メインの `onmessage` を奪う)。
 *
 * ⚠ 返す `Blob` は**構造化複製で参照として渡る**(250MB を ArrayBuffer にして transfer しない)。
 * ⚠ 例外を握り潰さない ── 呼び側が「この 1 件だけ落ちた」と分かる形で返す。
 */
import { runVideoJob, type VideoJob } from './video-codec';

interface Incoming {
  id: number;
  payload: VideoJob;
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<Incoming>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (ev: MessageEvent<Incoming>): void => {
  const { id, payload } = ev.data;
  void runVideoJob(payload).then(
    (result) => {
      ctx.postMessage({ id, ok: true, result });
    },
    (e: unknown) => {
      ctx.postMessage({ id, ok: false, error: String(e) });
    },
  );
};
