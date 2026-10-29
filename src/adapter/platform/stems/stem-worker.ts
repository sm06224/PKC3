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
declare const __PKC_PORTABLE__: boolean | undefined;
import { StemRunner, type OrtLike, type StemJob, type StemProbeJob } from './stem-run';

interface Incoming {
  id: number;
  payload: StemJob | StemProbeJob;
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<Incoming>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

let loaded: Promise<OrtLike> | null = null;

const runner = new StemRunner({
  loadOrt: async (): Promise<OrtLike> => {
    /**
     * 🔴 1 枚にまとめた版では、この先(ORT 本体と wasm)を**丸ごと落とす**(ビルド時に枝ごと消える ── `build/portable.config.ts`)。
     * ⚠ 条件はこの場で直接書く(別 module の定数だと、枝の除去が効かず wasm の参照が残る)。
     */
    if (typeof __PKC_PORTABLE__ !== 'undefined' && __PKC_PORTABLE__) {
      throw new Error('1 枚にまとめた版では ONNX Runtime を同梱していません');
    }
    // ⚠ wasm / glue の置き場は PKC3 自身が配る hash 付きの asset(`?url`)。動的 import にして、上の枝と一緒に落とせるようにする
    const [{ default: ortWasmUrl }, { default: ortMjsUrl }] = await Promise.all([
      import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url'),
      import('onnxruntime-web/ort-wasm-simd-threaded.mjs?url'),
    ]);
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
  // 実行器の起動確認(モデルを取る前)── 分離の依頼とは別の形
  if ('op' in payload && payload.op === 'probe') {
    void runner.probe().then(
      (result) => ctx.postMessage({ id, ok: true, result }),
      (e: unknown) => ctx.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return;
  }
  void runner.run(payload as StemJob).then(
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
