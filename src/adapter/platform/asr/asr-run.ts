/**
 * 🔴 **音声認識の「中身」**(#772 段②)── ワーカーの中で動く。
 *
 * 🔑 **ワーカーの配線とは別の file に置く**(`audio-codec.ts` と同じ作法)── 同じ file に置くと
 * import しただけで `self.onmessage` が付く。⚠ だから**ここは browser の worker でなくても
 * 動く形**にしてあり(部品の import と object URL は `deps` で渡す)、unit が走らせられる。
 *
 * ## 部品はどこから来るか(🔴 外へ出ない)
 *
 * 端末の IDB に入れてある Blob(`asr-pack-store.ts`)が、**構造化複製の参照**でここへ届く
 * (bytes は写されない)。ここがやることは 3 つ:
 *
 * 1. **実行の部品**(`runtime/transformers.mjs`)を **blob: の URL** にして `import()` する
 * 2. ORT の wasm の読み込み役と本体も **blob: の URL** にして、`wasmPaths` に **明示で渡す**
 *    ⚠ **渡さないと transformers は既定の CDN(`cdn.jsdelivr.net`)から取りに行く** ──
 *      PKC の「中身を端末の外へ出さない」と**正面から反する**。だから `wasmPaths` を
 *      渡す行が無い限り `import()` まで進まない(`ensureRuntime` の順番)。
 * 3. **モデルの file は `env.fetch` を差し替えて Blob から返す** ── 網へは 1 本も出さない
 *    (一致しない path は**素の fetch へ落とさず 404 を返す**。取りこぼしが「外へ取りに行く」に
 *    化けないように)。
 *
 * ## 🔴 使い捨てである
 *
 * 読み込んだ pipeline は同じ worker が生きている間だけ使い回す(続けて押したとき、
 * 2.7〜5 秒の読み込みをやり直さない)。**畳むのは `WorkerLease` のアイドル kill**であり、
 * ここは何も解放しない ── terminate が実測で 10 秒後に Pss を元へ戻す(段②-0)。
 * ⚠ blob URL もここでは revoke しない(2 つ目のモデルが同じ wasm をもう一度要るため)。
 *   worker が死ねば一緒に消える。
 */
import {
  ASR_RUNTIME_JS,
  ASR_RUNTIME_WASM,
  ASR_RUNTIME_WASM_LOADER,
} from '@features/asr/asr-parts';

/** `env.fetch` が受ける path の頭。⚠ 実在の URL にならない字にする(網へ出る道を作らない)。 */
export const ASR_FETCH_PREFIX = '/__pkc3-asr__/';
/** transformers へ渡す `localModelPath`(pack 内の `models/` に対応する)。 */
export const ASR_LOCAL_MODEL_PATH = `${ASR_FETCH_PREFIX}models/`;

/** 依頼。⚠ **Blob は参照で渡る**。pcm は **transfer**(ゼロコピー)。 */
export interface AsrJob {
  /** pack 内の相対 path → Blob。 */
  readonly files: ReadonlyArray<readonly [string, Blob]>;
  /** 例: `openai/whisper-base`。 */
  readonly modelId: string;
  /** whisper の言語名。`null` = 自動判定。 */
  readonly language: string | null;
  /** 16kHz mono の PCM(`-1..1`)。 */
  readonly pcm: Float32Array;
}

/** 認識結果の 1 区切り(#1232 段 a)。⚠ 時刻は**録音の頭からの ms**。 */
export interface AsrSegment {
  readonly startMs: number;
  /** ⚠ 最後の区切りは終わりが取れず `null` になりうる(whisper の仕様)。 */
  readonly endMs: number | null;
  readonly text: string;
}

export interface AsrJobResult {
  readonly text: string;
  /**
   * 時刻つきの区切り(#1232)。⚠ **無いことが在る**(区切りを返さない runtime / 全部空)──
   * 受ける側は `text` だけで動く(後ろ互換)。
   */
  readonly segments?: readonly AsrSegment[];
  /** 読み込み(部品の import + 重みの読み + session 生成)。⚠ 読み込み済みなら 0。 */
  readonly loadMs: number;
  readonly runMs: number;
}

type Pipe = ((pcm: Float32Array, opts: Record<string, unknown>) => Promise<unknown>) & {
  dispose?: () => Promise<void>;
};

interface RuntimeEnv {
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  localModelPath: string;
  useBrowserCache: boolean;
  useWasmCache: boolean;
  fetch: (input: unknown) => Promise<Response>;
  backends: { onnx: { wasm: { wasmPaths: unknown } } };
}

export interface RuntimeModule {
  readonly env: RuntimeEnv;
  pipeline(task: string, model: string, options: Record<string, unknown>): Promise<Pipe>;
}

export interface AsrRunnerDeps {
  /** 部品の ESM を読む(worker では `import(url)`。test が差し替える)。 */
  importModule(url: string): Promise<RuntimeModule>;
  createObjectURL(blob: Blob): string;
  now?(): number;
}

/** 推論の設定。⚠ 段②-0 で測った組み合わせ(wasm CPU / q8)から動かさない。 */
const PIPELINE_OPTIONS = { device: 'wasm', dtype: 'q8' } as const;
const RUN_OPTIONS = { chunk_length_s: 30, stride_length_s: 5, task: 'transcribe', return_timestamps: true } as const;

function textOf(out: unknown): string {
  if (Array.isArray(out)) return out.map((o) => textOf(o)).join(' ').trim();
  if (typeof out === 'object' && out !== null && typeof (out as { text?: unknown }).text === 'string') {
    return (out as { text: string }).text.trim();
  }
  return '';
}

/**
 * `chunks`(`timestamp` は**秒**)を区切り(ms)へ。空 / 空白だけの区切りは落とす。
 * ⚠ 形の合わない物は**黙って落とす**(取れなければ `text` だけで動く)。
 */
function segmentsOf(out: unknown): AsrSegment[] {
  if (Array.isArray(out)) return out.flatMap((o) => segmentsOf(o));
  if (typeof out !== 'object' || out === null) return [];
  const chunks = (out as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunks)) return [];
  const segs: AsrSegment[] = [];
  for (const c of chunks) {
    if (typeof c !== 'object' || c === null) continue;
    const { text, timestamp } = c as { text?: unknown; timestamp?: unknown };
    if (typeof text !== 'string' || text.trim() === '') continue;
    if (!Array.isArray(timestamp) || typeof timestamp[0] !== 'number' || !Number.isFinite(timestamp[0])) continue;
    const end = timestamp[1];
    segs.push({
      startMs: Math.round(timestamp[0] * 1000),
      endMs: typeof end === 'number' && Number.isFinite(end) ? Math.round(end * 1000) : null,
      text,
    });
  }
  return segs;
}

/**
 * 🔴 **種類を付け直す**(実ブラウザの smoke が拾った)。
 *
 * ⚠ ES module を `import()` する blob: の URL は、**種類が JavaScript の物でなければ読めない**
 *   (`Failed to fetch dynamically imported module`)。ところが端末の保管の Blob は、
 *   **取ってきたときの `Content-Type` をそのまま持つ** ── 配る側が `.mjs` を
 *   `application/octet-stream` で返したり、種類を付けなかったりすれば、**取り込みは成功するのに
 *   文字にする所で初めて落ちる**。配る側の設定に依らないよう、**ここで決める**。
 * 🔑 `new Blob([blob], { type })` は**中身を写さない**(参照を継ぐだけ ── ゼロコピー)。
 */
export function typed(blob: Blob, type: string): Blob {
  return new Blob([blob], { type });
}

export class AsrRunner {
  private readonly deps: AsrRunnerDeps;
  private readonly now: () => number;
  private runtime: RuntimeModule | null = null;
  private blobs = new Map<string, Blob>();
  private loaded: { modelId: string; pipe: Pipe } | null = null;

  constructor(deps: AsrRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** いま読み込んでいるモデル(test と計測の観測点)。 */
  get loadedModel(): string | null {
    return this.loaded?.modelId ?? null;
  }

  /**
   * 実行の部品を 1 度だけ読む。
   * ⚠ **`wasmPaths` を渡してから**でないと pipeline を作らない(上の docstring ── CDN に出ない)。
   */
  private async ensureRuntime(): Promise<RuntimeModule> {
    if (this.runtime !== null) return this.runtime;
    const js = this.blobs.get(ASR_RUNTIME_JS);
    const loader = this.blobs.get(ASR_RUNTIME_WASM_LOADER);
    const wasm = this.blobs.get(ASR_RUNTIME_WASM);
    if (js === undefined || loader === undefined || wasm === undefined) {
      throw new Error('音声認識の実行に必要なファイルが揃っていません(入れ直してください)');
    }
    const rt = await this.deps.importModule(this.deps.createObjectURL(typed(js, 'text/javascript')));
    const env = rt.env;
    // ⚠ 取りに行く先を**端末の中だけ**にする(どれか 1 つでも欠けると外へ出る)
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = ASR_LOCAL_MODEL_PATH;
    env.useBrowserCache = false;
    env.useWasmCache = false;
    env.backends.onnx.wasm.wasmPaths = {
      mjs: this.deps.createObjectURL(typed(loader, 'text/javascript')),
      wasm: this.deps.createObjectURL(typed(wasm, 'application/wasm')),
    };
    env.fetch = (input) => this.serve(input);
    this.runtime = rt;
    return rt;
  }

  /** `env.fetch` の中身。⚠ **網へは 1 本も出さない**(一致しなければ 404)。 */
  private async serve(input: unknown): Promise<Response> {
    let raw = '';
    if (typeof input === 'string') raw = input;
    else if (input instanceof URL) raw = input.pathname;
    else if (typeof input === 'object' && input !== null && 'url' in input) raw = String((input as { url: unknown }).url);
    if (raw.startsWith(ASR_FETCH_PREFIX)) {
      const blob = this.blobs.get(decodeURIComponent(raw.slice(ASR_FETCH_PREFIX.length)));
      if (blob !== undefined) {
        return new Response(blob, {
          status: 200,
          headers: { 'content-length': String(blob.size), 'content-type': blob.type || 'application/octet-stream' },
        });
      }
    }
    return new Response(null, { status: 404 });
  }

  async run(job: AsrJob): Promise<AsrJobResult> {
    const t0 = this.now();
    // 毎回、依頼が持つ Blob の参照へ差し替える(同じ worker で別の重みを頼まれても食い違わない)
    this.blobs = new Map(job.files);
    const rt = await this.ensureRuntime();
    if (this.loaded !== null && this.loaded.modelId !== job.modelId) {
      // 別の重みへ替わる ── 前のを先に手放す(2 つ分の常駐を重ねない)
      const old = this.loaded.pipe;
      this.loaded = null;
      await old.dispose?.().catch(() => undefined);
    }
    if (this.loaded === null) {
      const pipe = await rt.pipeline('automatic-speech-recognition', job.modelId, { ...PIPELINE_OPTIONS });
      this.loaded = { modelId: job.modelId, pipe };
    }
    const t1 = this.now();
    const out = await this.loaded.pipe(job.pcm, {
      ...RUN_OPTIONS,
      ...(job.language === null ? {} : { language: job.language }),
    });
    const t2 = this.now();
    const segments = segmentsOf(out);
    return {
      text: textOf(out),
      ...(segments.length > 0 ? { segments } : {}),
      loadMs: t1 - t0,
      runMs: t2 - t1,
    };
  }
}
