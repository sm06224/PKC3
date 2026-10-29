/**
 * 歌声と楽器を分けるワーカーの**配線だけ**(#674 / #949)。
 *
 * 🔴 **中身は `stem-run.ts`**(`voice-worker.ts` と同じ理由 ── 同居させると import しただけでメインの `onmessage` を奪う)。
 * ⚠ **使い捨て**(CLAUDE.md「重い処理はワーカーへ。ワーカーは使い捨てにする」)── 遅延起動・バッファ・アイドル kill は
 *   `WorkerLease` が持つ。ONNX Runtime は最初の依頼で初めて読み込み(動的 import)、同じワーカーが生きている間だけ使い回す。
 *   セッションは依頼ごとに作って手放す(`stem-run.ts`)。畳むのは terminate(wasm のメモリごと消える)。
 * ⚠ 返す bytes は **transfer**(ゼロコピー)。例外を握り潰さない ── 呼び側が「この 1 件だけ落ちた」と分かる形で返す。
 *
 * 🔑 ORT の wasm は **PKC3 自身が配る**(`?url` で hash 付きの asset にする)。⚠ 渡さないと ORT は既定の CDN
 *   (`cdn.jsdelivr.net`)から取りに行く ── PKC の「勝手に外へ出ない」に反するので、`wasmPaths` は必ず明示する。
 *   外へ出るのは重みの取得(`stem-fetch.ts`)の 1 本だけである。
 */
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { StemRunner, type OrtLike, type StemJob } from './stem-run';

interface Incoming {
  id: number;
  payload: StemJob;
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<Incoming>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

let loaded: Promise<OrtLike> | null = null;

const runner = new StemRunner({
  loadOrt: async (): Promise<OrtLike> => {
    // ⚠ 読み込みは 1 度だけ(失敗したら次の依頼でやり直せるよう、失敗は覚えない)
    loaded ??= import('onnxruntime-web/wasm').then((m) => {
      const ort = m as unknown as OrtLike & {
        env: { wasm: { wasmPaths: unknown; proxy: boolean } };
      };
      ort.env.wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl };
      // すでにワーカーの中なので、ORT 自身の proxy worker は作らない
      ort.env.wasm.proxy = false;
      return ort;
    });
    try {
      return await loaded;
    } catch (e) {
      loaded = null;
      throw e;
    }
  },
});

ctx.onmessage = (ev: MessageEvent<Incoming>): void => {
  const { id, payload } = ev.data;
  void runner.run(payload).then(
    (result) => {
      const transfer: Transferable[] = [];
      if (result.ok) for (const f of result.files) transfer.push(f.bytes);
      ctx.postMessage({ id, ok: true, result }, transfer);
    },
    (e: unknown) => {
      ctx.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    },
  );
};
