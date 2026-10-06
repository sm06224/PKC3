/**
 * 音声認識の部品の**取得**(#772 段②)。
 *
 * 🔑 DuckDB(`duckdb-pack-acquire.ts`)・Office(`office-pack-acquire.ts`)と同じ形 ──
 * 同一オリジンの base から `pack.json`(目録)→ 実体を **1 つずつ** fetch する。
 * ⚠ ただし**重みが 81〜254MB** なので、DuckDB と違うところが 3 つある:
 *
 * 1. 🔴 **バイト単位の進み具合を出す** ── 157MB の 1 file が数十秒かかるので、file 単位だけ
 *    だと「止まって見える」。
 * 2. 🔴 **途中で止められる**(`AbortSignal`)── 止めたら**書き込みには 1 バイトも進まない**
 *    (保管は全部揃ってから。この層は IDB を触らない)。
 * 3. 🔴 **heap に載せない** ── `res.blob()` ではなく、**流しながら Blob を継ぎ足す**
 *    (`new Blob([前の Blob, 新しい塊])` は前の Blob を**参照**するだけ ── 数 MB 以上を
 *    heap に溜めない。不可侵指示 2026-07-27「ゼロコピー・速やかな破棄」と同じ向き)。
 *
 * ⚠ **検めるのは pure 層**(`@features/asr/asr-parts.ts`)── 目録の形・下限・path の安全は
 *   そこに 1 か所だけ在る。ここで同じ判定を書き直さない(§7)。
 * ⚠ **GitHub の release 資産は取れない**(CORS を返さない。2026-08-14 実測)。
 *   同一オリジンだけを断る門をここに置く。
 */
import {
  ASR_MANIFEST,
  asrAssetUrl,
  readAsrPack,
  type AsrPack,
  type AsrPackFile,
} from '@features/asr/asr-parts';

export class AsrPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsrPackError';
  }
}

/** 取り込みを途中で止めた(失敗ではない ── 呼び側は静かに畳む)。 */
export class AsrPackAborted extends Error {
  constructor() {
    super('取り込みをやめました');
    this.name = 'AsrPackAborted';
  }
}

/** 進み具合(バイト)。`name` は取っている file。 */
export interface AsrProgress {
  (done: number, total: number, name: string): void;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/**
 * 🔴 **取得元が同一オリジンであることを、ここで断る**(`resolveDuckDbBase` と同じ門)。
 *
 * ⚠ 基点は `document.baseURI`(`location` の字を読むと
 *   `tests/features/flags.test.ts` の「クエリを読んでいないか」の全数検査に掛かる)。
 * 🔑 断り文は**なぜ駄目か**まで言う ── 別 origin は CORS で必ず失敗するので、
 *   「設定が違う」ではなく「その道は無い」と伝える。
 */
export function resolveAsrBase(base: string, baseURI: string = document.baseURI): string {
  const root = new URL(base, baseURI);
  if (root.origin !== new URL(baseURI).origin) {
    throw new AsrPackError(
      `取得元は同じ場所(origin)でなければなりません(指定: ${root.origin})。`
        + '別の場所は CORS で必ず失敗するので、その道はありません。',
    );
  }
  return root.href.endsWith('/') ? root.href : `${root.href}/`;
}

/** 目録を読む。⚠ 404 は「まだ配っていません」と言い分ける(取り直しでは直らない)。 */
export async function fetchAsrManifest(
  base: string,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<AsrPack> {
  const url = asrAssetUrl(resolveAsrBase(base), ASR_MANIFEST);
  let res: Response;
  try {
    res = await fetchFn(url, { signal });
  } catch {
    if (signal?.aborted) throw new AsrPackAborted();
    throw new AsrPackError(`取得元に届きません: ${url}`);
  }
  if (res.status === 404) {
    throw new AsrPackError('音声認識の一式を、このサイトの配布元がまだ配布していません。');
  }
  if (!res.ok) throw new AsrPackError(`取得元に一式がありません(HTTP ${res.status}): ${url}`);
  const parsed = readAsrPack(await res.text());
  if (!parsed.ok) throw new AsrPackError(parsed.why);
  return parsed.pack;
}

/** この大きさ以下の file は取った後に sha256 を照合する。⚠ 理由は `verifySha256` の docstring。 */
export const SHA_VERIFY_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 継ぎ足しの粒。⚠ これより小さい塊は溜めてから継ぐ ── 塊ごとに Blob を作ると遅く、
 * 溜めすぎると heap を食う。8MB なら 157MB の file でも heap に残るのは 8MB まで。
 */
const GLUE_BYTES = 8 * 1024 * 1024;

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 1 file を流しながら取る。
 * @param onBytes 取れたバイト数(その file の中)。
 */
async function fetchOne(
  url: string,
  file: AsrPackFile,
  fetchFn: FetchLike,
  signal: AbortSignal | undefined,
  onBytes: (n: number) => void,
): Promise<Blob> {
  let res: Response;
  try {
    res = await fetchFn(url, { signal });
  } catch {
    if (signal?.aborted) throw new AsrPackAborted();
    throw new AsrPackError(`取得元に届きません: ${url}`);
  }
  // ⚠ **沈黙を成功と読まない。** 404 の HTML を掴んで「入った」と言わない
  if (!res.ok) throw new AsrPackError(`取得できません: ${file.path}(HTTP ${res.status})`);

  let blob: Blob;
  const type = res.headers.get('content-type') ?? '';
  if (res.body === null) {
    // 流せない環境(ほぼ無い)── そのまま受ける。進みはこの file の終わりに出る
    blob = await res.blob();
    onBytes(blob.size);
  } else {
    const reader = res.body.getReader();
    let acc = new Blob([], { type });
    let pending: Uint8Array<ArrayBuffer>[] = [];
    let pendingBytes = 0;
    let got = 0;
    try {
      for (;;) {
        if (signal?.aborted) throw new AsrPackAborted();
        const { done, value } = await reader.read();
        if (done) break;
        pending.push(value as Uint8Array<ArrayBuffer>);
        pendingBytes += value.byteLength;
        got += value.byteLength;
        onBytes(got);
        if (pendingBytes >= GLUE_BYTES) {
          acc = new Blob([acc, ...pending], { type });
          pending = [];
          pendingBytes = 0;
        }
      }
    } catch (e) {
      // ⚠ 途中で落ちた・止めた ── 読みかけを手放す(貯めた Blob は参照が切れて捨てられる)
      await reader.cancel().catch(() => undefined);
      if (e instanceof AsrPackAborted || signal?.aborted) throw new AsrPackAborted();
      throw new AsrPackError(`取得が途中で止まりました: ${file.path}`);
    }
    blob = pending.length > 0 ? new Blob([acc, ...pending], { type }) : acc;
  }

  // 🔴 **取った実体の大きさが目録と食い違ったら断る**(途中切断・古いキャッシュの残骸を
  //   「取れた」と言わない)
  if (blob.size !== file.bytes) {
    throw new AsrPackError(
      `${file.path} の大きさが一式の内容一覧と違います(一式の内容一覧 ${file.bytes} byte / 実際 ${blob.size} byte。取得し直してください)`,
    );
  }
  /**
   * 🔴 **sha256 は小さい file だけ照合する**。⚠ SubtleCrypto は**流せない**ので、全体を
   * 1 度 heap へ読む ── 157MB の重みで照合すると、取り込みの最中に 157MB の山ができる
   * (heap に載せない、に反する)。大物は**大きさで見る**(途中切断・取り違えの桁は止まる)。
   * ⚠ だから「大物の中身の 1 バイトの化けは検出しない」。HTTPS の上で同一オリジンの
   * 配布元から取るので、その桁の事故は転送路では起きにくい(判断)。
   */
  if (blob.size <= SHA_VERIFY_MAX_BYTES) {
    const got = await sha256Hex(blob);
    if (got !== file.sha256) {
      throw new AsrPackError(`${file.path} の中身が一式の内容一覧と違います(取得し直してください)`);
    }
  }
  return blob;
}

/**
 * 目録が指す file を **1 つずつ**取る。
 *
 * ⚠ **1 file ごとに門を通す**(ここだけ素の `base` を使うと、門が片側にしか無くなる)。
 * ⚠ 失敗・中断のとき、**それまでに取った物は返さずに捨てる**(呼び側は何も受け取らない)。
 */
export async function fetchAsrFiles(
  base: string,
  files: readonly AsrPackFile[],
  fetchFn: FetchLike,
  opts: { signal?: AbortSignal; onProgress?: AsrProgress } = {},
): Promise<Map<string, Blob>> {
  const total = files.reduce((s, f) => s + f.bytes, 0);
  const out = new Map<string, Blob>();
  let doneBefore = 0;
  for (const file of files) {
    if (opts.signal?.aborted) throw new AsrPackAborted();
    const url = asrAssetUrl(resolveAsrBase(base), file.path);
    opts.onProgress?.(doneBefore, total, file.path);
    const blob = await fetchOne(url, file, fetchFn, opts.signal, (n) =>
      opts.onProgress?.(doneBefore + n, total, file.path),
    );
    doneBefore += file.bytes;
    out.set(file.path, blob);
  }
  opts.onProgress?.(total, total, '');
  return out;
}
