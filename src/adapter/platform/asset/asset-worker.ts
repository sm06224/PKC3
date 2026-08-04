/**
 * 添付ワーカーの**配線だけ**(P8 段⑮)。
 *
 * 🔴 **中身は `asset-codec.ts`**。同じ file に置くと、`processAsset` を
 * import しただけで `self.onmessage` が付き、**メインの `window.onmessage` を
 * 奪う**(test が出した欠陥)。ここは worker としてしか読み込まれない。
 *
 * ⚠ 返すのは **transfer**(ゼロコピー ── 2026-07-27 の不可侵指示)。
 * ⚠ 例外を握り潰さない ── 1 件の添付が壊れていても取込は続けたいので、
 * 呼び側が「この 1 件だけ落ちた」と分かる形で返す。
 */
import { processAsset, hashAsset, isHashJob, type AssetJob, type AssetHashJob } from './asset-codec';

interface Incoming {
  id: number;
  payload: AssetJob | AssetHashJob;
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<Incoming>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (ev: MessageEvent<Incoming>): void => {
  const { id, payload } = ev.data;
  // 🔑 ハッシュだけの依頼は**返す bytes が無い**(P8 段㉓)── transfer もしない。
  //    Blob は参照で来ているので、materialize するのはこの中だけである
  if (isHashJob(payload)) {
    void hashAsset(payload).then(
      (result) => {
        ctx.postMessage({ id, ok: true, result });
      },
      (e: unknown) => {
        ctx.postMessage({ id, ok: false, error: String(e) });
      },
    );
    return;
  }
  void processAsset(payload).then(
    (result) => {
      ctx.postMessage({ id, ok: true, result }, [result.bytes]);
    },
    (e: unknown) => {
      ctx.postMessage({ id, ok: false, error: String(e) });
    },
  );
};
