/**
 * 🔴 **音源分離モデルの重みを、公開の取得元から取る**(#674 / #949)。メインスレッド側。
 *
 * > 「重みの配布元にこの箱からつながらなかった」は、利用者の環境の理由にならない。利用者のブラウザが公開の配布元から取得する。
 *
 * - 取得元は `STEM_MODELS[].urls` を**順に**試す。**どこがなぜ駄目だったか**を 1 行ずつ集めて、全部駄目なら理由として返す
 *   (つながらない / HTTP の状態 / 途中で切れた / ONNX ではない / 小さすぎる)。黙って失敗しない。
 * - 🔴 流しながら `Blob` を継ぎ足す(`new Blob([前, 新しい塊])` は前を**参照**するだけ ── 66MB を heap に載せない)。
 *   結果の `Blob` はワーカーへ**参照で**渡り、使い終えたら参照が切れて捨てられる(取得物を端末に残さない)。
 * - ⚠ 取得物の置き場は作らない: ブラウザの HTTP キャッシュに任せる。自前で残すと「消す」口が要り、片道になる。
 * - 外へ出るのは**この取得 1 本だけ**(重みの GET)。録音の音は 1 バイトも送らない。
 */
import { sha256Hex } from '../storage/asset-key';
import { stemHost, type StemModel } from '@features/audio/stem-model';

export type StemFetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type StemFetchResult =
  | { readonly ok: true; readonly blob: Blob; readonly url: string }
  | { readonly ok: false; readonly why: string };

/** 継ぎ足しの粒(`asr-pack-acquire.ts` と同じ)。 */
const GLUE_BYTES = 8 * 1024 * 1024;
/** sha256 を照合するのは、固定した重みだけ(SubtleCrypto は流せず全体を heap へ読むため)。 */
const SHA_MAX_BYTES = 128 * 1024 * 1024;

/** ONNX(protobuf の `ModelProto`)は先頭が `ir_version` の tag(0x08)で始まる。HTML や JSON を ONNX と読まない。 */
export async function looksLikeOnnx(blob: Blob): Promise<boolean> {
  if (blob.size < 16) return false;
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return head[0] === 0x08;
}

class Aborted extends Error {}

async function fetchOne(
  url: string,
  fetchFn: StemFetchLike,
  signal: AbortSignal | undefined,
  onBytes: (got: number, total: number) => void,
): Promise<Blob | string> {
  const host = stemHost(url);
  let res: Response;
  try {
    res = await fetchFn(url, { signal });
  } catch {
    if (signal?.aborted) throw new Aborted();
    return `${host} につながりませんでした(ネットワークの断絶、またはブラウザが外への通信を許していません)`;
  }
  if (!res.ok) return `${host} が HTTP ${String(res.status)} を返しました(モデルが置かれていない可能性があります)`;
  const total = Number(res.headers.get('content-length') ?? '0') || 0;
  if (res.body === null) {
    const b = await res.blob();
    onBytes(b.size, b.size);
    return b;
  }
  const reader = res.body.getReader();
  let acc = new Blob([]);
  let pending: Uint8Array<ArrayBuffer>[] = [];
  let pendingBytes = 0;
  let got = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new Aborted();
      const { done, value } = await reader.read();
      if (done) break;
      pending.push(value as Uint8Array<ArrayBuffer>);
      pendingBytes += value.byteLength;
      got += value.byteLength;
      onBytes(got, total);
      if (pendingBytes >= GLUE_BYTES) {
        acc = new Blob([acc, ...pending]);
        pending = [];
        pendingBytes = 0;
      }
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    if (e instanceof Aborted || signal?.aborted) throw new Aborted();
    return `${host} からの取得が途中で止まりました(${String(got)} byte まで)`;
  }
  return pending.length > 0 ? new Blob([acc, ...pending]) : acc;
}

/**
 * モデルを取る。⚠ 投げない(中断だけは `{ ok: false, why: '取得をやめました' }`)。
 * @param onProgress 取れた byte と全体の byte(分からなければ 0)。
 */
export async function fetchStemModel(
  model: StemModel,
  fetchFn: StemFetchLike = (url, init) => fetch(url, init),
  opts: { signal?: AbortSignal; onProgress?: (got: number, total: number, host: string) => void } = {},
): Promise<StemFetchResult> {
  const reasons: string[] = [];
  for (const url of model.urls) {
    let got: Blob | string;
    try {
      got = await fetchOne(url, fetchFn, opts.signal, (g, t) => opts.onProgress?.(g, t, stemHost(url)));
    } catch (e) {
      if (e instanceof Aborted) return { ok: false, why: '取得をやめました' };
      throw e;
    }
    const host = stemHost(url);
    if (typeof got === 'string') {
      reasons.push(got);
      continue;
    }
    if (got.size < model.minBytes) {
      reasons.push(`${host} から取れた物が小さすぎます(${String(got.size)} byte。途中で切れたか、別の物です)`);
      continue;
    }
    if (!(await looksLikeOnnx(got))) {
      reasons.push(`${host} から取れた物はモデルの形式(ONNX)ではありません(エラーの画面かもしれません)`);
      continue;
    }
    if (model.sha256 !== null && got.size <= SHA_MAX_BYTES && (await sha256Hex(got)) !== model.sha256) {
      reasons.push(`${host} から取れた物の中身が、想定しているモデルと違います`);
      continue;
    }
    return { ok: true, blob: got, url };
  }
  return {
    ok: false,
    why: `${model.label}を分けるモデルを取得できませんでした。${reasons.join(' / ')}`,
  };
}
