/**
 * 音の切り出しワーカーの**配線だけ**(#683 段②a)。
 *
 * 🔴 **中身は `audio-codec.ts`**(`asset-worker.ts` と同じ理由 ── 同居させると
 * import しただけでメインの `onmessage` を奪う)。
 *
 * ⚠ 返すのは **transfer**(ゼロコピー ── 2026-07-27 の不可侵指示)。
 * ⚠ 例外を握り潰さない ── 呼び側が「この 1 件だけ落ちた」と分かる形で返す。
 */
import { trimAudio, type AudioTrimJob } from './audio-codec';

interface Incoming {
  id: number;
  payload: AudioTrimJob;
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<Incoming>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (ev: MessageEvent<Incoming>): void => {
  const { id, payload } = ev.data;
  void trimAudio(payload).then(
    (result) => {
      // ⚠ 断ったときは返す bytes が無い ── transfer の一覧を空にする
      ctx.postMessage({ id, ok: true, result }, result.ok ? [result.bytes] : []);
    },
    (e: unknown) => {
      ctx.postMessage({ id, ok: false, error: String(e) });
    },
  );
};
