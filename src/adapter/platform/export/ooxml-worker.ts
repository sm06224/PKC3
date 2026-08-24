/// <reference lib="webworker" />
/**
 * OOXML(`.docx` / `.pptx`)の組み立てを回す**ワーカーの口**(#187 段④・段⑤)。
 *
 * 🔴 **この file は worker からしか読まれない。** 中身(`assembleOoxml`)は
 * `ooxml-assemble.ts` に在り、主スレッドの落とし所もそちらを直に呼ぶ ──
 * ここを主スレッドから import すると、`self.onmessage` を差した瞬間に
 * **window の message を横取りする**(実際に一度そう書いて test で捕まえた)。
 */
import { assembleOoxml, type OoxmlJob, type OoxmlJobResponse } from './ooxml-assemble';

/**
 * 🔴 **`WorkerLease` が包む形**(`{ id, payload }`)。
 * ⚠ ここを平らな `{ id, ...job }` と読み違えると、**ワーカーは毎回失敗して
 * 落とし所(その場で組む)に落ちる** ── しかも zip は正しく落ちてくるので、
 * 「動いているが 1 度もワーカーで組んでいない」に気づけない(実際に踏んだ)。
 */
interface Incoming {
  id: number;
  payload: OoxmlJob;
}

// ⚠ `self.onmessage` に**代入**する(`addEventListener` にしない)── この repo の
//   worker の test はこの形を前提に実物を dynamic import している。
const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<Incoming>) => void) | null;
  postMessage: (msg: OoxmlJobResponse) => void;
};

ctx.onmessage = (ev: MessageEvent<Incoming>): void => {
  const { id, payload } = ev.data;
  assembleOoxml(payload)
    .then((result) => {
      ctx.postMessage({ id, ok: true, result });
    })
    .catch((e: unknown) => {
      ctx.postMessage({ id, ok: false, error: String(e).slice(0, 200) });
    });
};
