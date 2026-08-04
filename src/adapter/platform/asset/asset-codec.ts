/**
 * 添付の**展開とハッシュ**(P8 段⑮)。ワーカーの中でも外でも動く**素の関数**。
 *
 * > user 指示 2026-08-03(不可侵)「**基本的に重い処理はワーカーにしてください**」
 *
 * 🔴 直す前に測った(添付 20 件 × 200KB / 5.2MB の PKC2 書出しを取込):
 * ```
 * 取込の内訳            long task 917ms / TBT 867ms
 *   sniff        18ms
 *   file.text    27ms
 *   parse+JSON  123ms   ← DOMParser + JSON.parse(DOM が要るので動かせない)
 *   convert       6ms
 *   添付ループ    406ms   ← **ここが支配的**
 *   entries+履歴  56ms
 * ```
 * 単体で測った内訳は base64 4ms / gzip 展開 103ms / SHA-256 33ms / IDB 46ms。
 * ⚠ **当初の見立て(base64 が重い)は外れだった** ── `Uint8Array.fromBase64` が
 * 使えるので base64 は 4ms しか掛からない。効くのは**展開とハッシュ**である。
 *
 * 🔑 ここへ出せる理由: gzip 展開も SHA-256 も **DOM を 1 行も触らない**。
 * ⚠ IDB への書込は**メインに残す** ── 添付の置き場は adapter が持っており、
 * ワーカーに割ると所有者が 2 人になる(GC と lease の意味論が壊れる)。
 *
 * 🔴 **worker の配線と別 file にする**(test が出した欠陥)。同じ file に
 * `self.onmessage = …` を書くと、`processAsset` を import しただけで
 * **メインの `window.onmessage` を奪う** ── ページ宛の postMessage で
 * 添付処理が動き出す。純粋部はここ、配線は `asset-worker.ts`。
 */

/** これ以上はハッシュを取らない(`asset-key.ts` の閾値と同じ ── 意味も同じ)。 */
export const WORKER_HASH_MAX_BYTES = 64 * 1024 * 1024;

export interface AssetJob {
  /** 生バイト(gzip されているかは `gzipped` が言う)。**transfer で渡す**。 */
  bytes: ArrayBuffer;
  gzipped: boolean;
  /**
   * ハッシュを取る上限(既定 `WORKER_HASH_MAX_BYTES` = 64MB)。
   *
   * ⚠ **test の観測点として在る**(`ImportDeps.hashMaxBytes` と同じ理由)。
   * 64MB の fixture は test で作れないので、下げられないと**分岐ごと消しても
   * 誰も気づかない**(実際に変異が生存した)。
   */
  hashMaxBytes?: number;
}

export interface AssetResult {
  /** 展開後のバイト。**transfer で返す**。 */
  bytes: ArrayBuffer;
  /** SHA-256 の hex。閾値超は `null`(その 1 件は dedupe されない)。 */
  hash: string | null;
}

/**
 * view を **transfer できる ArrayBuffer** にする(P8 段⑮)。
 *
 * 🔴 **buffer 全体を渡してはいけない**。`Uint8Array` が部分参照(offset 付き /
 * 短い)だと、受け取った側は **ArrayBuffer 全体**を展開・ハッシュするので
 * **別物になる**。ぴったりのときだけそのまま渡し、そうでなければ切り出す。
 * ⚠ 規則をここ 1 か所に置く ── 呼び側に書くと、経路が増えたとき片方だけ直る。
 */
export function transferableBuffer(view: Uint8Array<ArrayBuffer>): ArrayBuffer {
  const exact = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength;
  return exact ? view.buffer : view.slice().buffer;
}

/**
 * 呼び側が使う口。**view を渡す** ── ArrayBuffer を組み立てさせない。
 *
 * 🔴 変異試験で「呼び側が `transferableBuffer` を通さず `raw.buffer` を渡す」が
 * **生き残った**(本番の view は今のところ全部ぴったりなので、smoke では
 * 区別がつかない)。test を足すのではなく、**規則を通らない道を無くす** ──
 * 引数を view にすれば、呼び側は間違えようがない。
 */
export function decodeAsset(
  view: Uint8Array<ArrayBuffer>,
  gzipped: boolean,
  hashMaxBytes?: number,
): Promise<AssetResult> {
  return processAsset({ bytes: transferableBuffer(view), gzipped, hashMaxBytes });
}

/** 実体(worker の受け口が使う形)。⚠ **worker の外からも呼べる**。 */
export async function processAsset(job: AssetJob): Promise<AssetResult> {
  const raw = job.gzipped
    ? await new Response(
        new Blob([job.bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
      ).arrayBuffer()
    : job.bytes;
  // ⚠ 閾値超はハッシュを取らない(全量を heap に載せない ── asset-key.ts と同じ判断)
  if (raw.byteLength > (job.hashMaxBytes ?? WORKER_HASH_MAX_BYTES))
    return { bytes: raw, hash: null };
  const digest = await crypto.subtle.digest('SHA-256', raw);
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { bytes: raw, hash };
}

