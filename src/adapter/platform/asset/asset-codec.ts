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

/**
 * これ以上はハッシュを取らない。
 * 🔴 **`asset-key.ts` の値をそのまま使う**(P8 段㉓)── かつては同じ数字を
 * ここに別途書いており、「同じ ── 意味も同じ」とコメントで言うだけで、
 * 両者を結ぶものが何も無かった。片方を動かせば黙って乖離する。
 */
export { HASH_MAX_BYTES as WORKER_HASH_MAX_BYTES } from '@adapter/platform/storage/asset-key';
import { HASH_MAX_BYTES } from '@adapter/platform/storage/asset-key';
import { shrinkPlan, worthShrinking } from '@features/asset/image-shrink';

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
  if (raw.byteLength > (job.hashMaxBytes ?? HASH_MAX_BYTES))
    return { bytes: raw, hash: null };
  const digest = await crypto.subtle.digest('SHA-256', raw);
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { bytes: raw, hash };
}


/**
 * **Blob をそのまま渡してハッシュだけ取る**依頼(P8 段㉓)。
 *
 * 🔴 これが無かったので、添付を貼る経路は `identifyAsset` を**メインで**呼んでいた。
 * 🔴 **実測**(心拍 4ms の最大欠測。同じビルドで `?pkc-asset-inline` の有無だけを
 * 変えた A/B を交互に 2 ペア。32MB の添付 1 件):
 * ```
 *   ワーカー   最大欠測 10 / 14 ms
 *   メイン     最大欠測 500 / 726 ms   ← 明確に体感できる固まり
 * ```
 * user から実機で「添付とかでメインスレッドブロックするのは気になるね」と報告があった。
 *
 * ⚠ **どの呼び出しが止めているかは主張しない**。遊んでいるページで
 * `blob.arrayBuffer()` と `crypto.subtle.digest` を単体で測ると**どちらも
 * 最大欠測 0〜8ms** で、止まらない ── 止まるのは**添付の実経路**(同じ 32MB を
 * IDB へ書く処理と重なる状況)だけである。分かっているのは
 * 「**この一式をワーカーへ出すとメインが止まらなくなる**」という向きだけ。
 *
 * 🔑 **Blob は構造化複製で参照として渡る** ── postMessage に載せても bytes は
 * コピーされない。materialize するのは**ワーカーの中**で、しかもワーカーは
 * アイドルで kill されるので**常駐が返る**(user 指示 2026-08-03 の 3 規律)。
 * ⚠ だから transfer は要らない(というより Blob は transferable ではない)。
 */
export interface AssetHashJob {
  blob: Blob;
  /** ⚠ test の観測点(64MB の fixture は作れない ── `AssetJob` と同じ理由)。 */
  hashMaxBytes?: number;
}

export interface HashResult {
  /** SHA-256 の hex。閾値超は `null`(その 1 件は dedupe されない)。 */
  hash: string | null;
}

/** ハッシュだけ取る(worker の受け口が使う形)。⚠ **worker の外からも呼べる**。 */
export async function hashAsset(job: AssetHashJob): Promise<HashResult> {
  if (job.blob.size > (job.hashMaxBytes ?? HASH_MAX_BYTES)) return { hash: null };
  const digest = await crypto.subtle.digest('SHA-256', await job.blob.arrayBuffer());
  return {
    hash: Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
  };
}

/**
 * 🔴 **画像を縮める依頼**(#412)。
 *
 * ⚠ **重い処理はワーカーへ**(user 指示 2026-08-03)── 復号と再符号化は
 *   メインで回すと目に見えて固まる(ハッシュを出したときと同じ理由)。
 * 🔑 **Blob は構造化複製で参照として渡る**ので transfer は要らない ──
 *   materialize するのはワーカーの中だけである。
 */
export interface AssetShrinkJob {
  blob: Blob;
  mime: string;
  /** ⚠ **判別子**。`AssetHashJob` も `blob` を持つので、これで見分ける。 */
  shrink: true;
}

export interface ShrinkResult {
  /** 元の画素数。⚠ **読めなかったら 0**(呼び側は縮めない)。 */
  readonly width: number;
  readonly height: number;
  /** 縮めた結果。⚠ **縮めなかった / 採らなかったときは `null`**。 */
  readonly shrunk: { blob: Blob; width: number; height: number } | null;
  /** 縮めなかった理由(診断用。⚠ user には出さない)。 */
  readonly why: 'ok' | 'no-plan' | 'no-api' | 'not-worth' | 'failed';
}

/**
 * 画像を縮める(worker の受け口が使う形)。⚠ **worker の外からも呼べる**。
 *
 * 🔴 **判断は純関数(`shrinkPlan`)に任せる** ── ここは画素を触るだけ。
 * ⚠ `createImageBitmap` / `OffscreenCanvas` が無い環境(unit の happy-dom)では
 *   **`no-api` で素通りする** ── 縮めないので、元のまま取り込まれる(安全側)。
 */
export async function shrinkImage(job: AssetShrinkJob): Promise<ShrinkResult> {
  const g = globalThis as unknown as {
    createImageBitmap?: (b: Blob) => Promise<ImageBitmap>;
    OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas;
  };
  if (!g.createImageBitmap || !g.OffscreenCanvas)
    return { width: 0, height: 0, shrunk: null, why: 'no-api' };
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await g.createImageBitmap(job.blob);
    const { width, height } = bmp;
    const plan = shrinkPlan(job.mime, job.blob.size, width, height);
    if (plan === null) return { width, height, shrunk: null, why: 'no-plan' };
    const canvas = new g.OffscreenCanvas(plan.width, plan.height);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return { width, height, shrunk: null, why: 'failed' };
    (ctx as OffscreenCanvasRenderingContext2D).drawImage(bmp, 0, 0, plan.width, plan.height);
    const out = await canvas.convertToBlob({ type: plan.mime, quality: plan.quality });
    // 🔴 **十分小さくなっていなければ捨てる**(増えることがある)
    if (!worthShrinking(job.blob.size, out.size))
      return { width, height, shrunk: null, why: 'not-worth' };
    return {
      width,
      height,
      shrunk: { blob: out, width: plan.width, height: plan.height },
      why: 'ok',
    };
  } catch {
    // ⚠ 壊れた画像で落ちても、取込は続ける(元のまま入る)
    return { width: 0, height: 0, shrunk: null, why: 'failed' };
  } finally {
    // 🔑 **画素は寿命の終端で捨てる**(2026-07-27 の不可侵指示)
    bmp?.close();
  }
}

/**
 * 依頼の見分け。⚠ 判定は**ここ 1 か所**(worker と client の 2 か所に書かない)。
 *
 * 🔴 **順番に依存させない**(2026-08-26)── `AssetShrinkJob` も `blob` を持つので、
 *   `isHashJob` を先に評価すると**縮める依頼がハッシュへ落ちる**。
 *   判別子(`shrink`)で明示的に分ける。
 */
export function isShrinkJob(
  job: AssetJob | AssetHashJob | AssetShrinkJob,
): job is AssetShrinkJob {
  return 'shrink' in job;
}

export function isHashJob(job: AssetJob | AssetHashJob | AssetShrinkJob): job is AssetHashJob {
  return 'blob' in job && !isShrinkJob(job);
}
