/**
 * 🔴 **歌声と楽器を分ける「中身」**(#674 / #949)── ワーカーの中で動く。
 *
 * 🔑 **ワーカーの配線とは別の file に置く**(`voice-run.ts` と同じ作法 ── 同居させると import しただけで `self.onmessage` が付く)。
 * ⚠ ONNX Runtime(wasm)と opus の符号化器は `deps` で注入する ── unit が偽物(恒等のモデル)で通せる。
 *
 * ## 🔴 使い捨てである
 * - ORT は**最初の依頼で初めて読む**(動的 import ── 使わない人のワーカーには載らない)。
 * - 1 回の依頼ごとに `InferenceSession` を作り、**終わったらその場で `release()`**(重みを持ち越さない)。
 *   ワーカーそのものを畳むのは `WorkerLease` のアイドル kill(terminate で wasm のメモリごと消える)。
 * - 重みの `Blob` は参照で届く。`arrayBuffer()` に読んだ bytes は、セッションを作ったらすぐ手放す(wasm のヒープへ写されるため)。
 * - PCM は **transfer で受ける**(ゼロコピー)。使い終わった物から順に手放す。結果の bytes も transfer で返す。
 */
import {
  STEM_MAX_MS,
  STEM_RATE,
  separateStems,
  separationProblem,
  StemModelError,
  stereoRms,
  stemModelOf,
  stemTags,
  toEncoderPcm,
  type StemModel,
} from '@features/audio/stem-model';
import { buildIdentityOnnx } from '@features/audio/tiny-onnx';
import { encodeOpusWebm, nativeAudioApi, type AudioApi } from '../voice/audio-encode';

/** 依頼。⚠ `left` / `right` は**書き換えない約束ではない**(分けるうちに上書きして手放す)。 */
export interface StemJob {
  /** 重み(ONNX)。参照で届く。 */
  model: Blob;
  modelId: string;
  /** 44.1kHz の左右。⚠ transfer で受け、受けた瞬間に所有を取る。 */
  left: Float32Array;
  right: Float32Array;
  /** 進み具合を流す口(メインが受ける)。省略可。 */
  progress?: MessagePort;
}

export interface StemFile {
  /** 名前に入れる語(`歌声` / `楽器`)。 */
  readonly tag: string;
  readonly bytes: ArrayBuffer;
  readonly durationMs: number;
}

export type StemRefusal =
  | 'empty'
  | 'silent'
  | 'too-long'
  | 'unknown-model'
  | 'no-runtime'
  | 'bad-model'
  | 'infer-failed'
  | 'no-encoder'
  | 'encode-failed'
  /** 利用者が「やめる」を押した(失敗ではない)。 */
  | 'cancelled';

export type StemResult =
  | { readonly ok: true; readonly files: readonly StemFile[] }
  | { readonly ok: false; readonly reason: StemRefusal; readonly detail?: string };

/** ORT のうち、使う部分だけの形(偽物を差せる)。 */
export interface OrtTensorOut {
  readonly data: unknown;
  readonly dims: readonly number[];
}
export interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  /** 入力の形(新しい ORT が返す)。`shape` の要素は数か、可変なら文字列。 */
  readonly inputMetadata?: unknown;
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorOut>>;
  release(): Promise<void>;
}
export interface OrtLike {
  readonly InferenceSession: {
    create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSession>;
  };
  readonly Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => unknown;
}

/** 実行器の起動確認の結果。 */
export type StemProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: StemRefusal; readonly detail: string };

/** 起動確認の依頼(分離の依頼とは別の形)。 */
export interface StemProbeJob {
  readonly op: 'probe';
}

export interface StemDeps {
  /** ORT を読み込む(wasm 版)。読めなければ投げる。 */
  readonly loadOrt: () => Promise<OrtLike>;
  /** opus の符号化器。省略 = 本物。 */
  readonly audioApi?: AudioApi | null;
}

const EMPTY = new Float32Array(0);

/** ORT の起動そのものの失敗を示す文(重みの不良ではない)。 */
const RUNTIME_FAILURE = /no available backend|backend|WebAssembly|dynamically imported|Failed to fetch|wasm/i;

/**
 * 入力の形が `[*, 4, dimF, dimT]` か。問題があれば理由、無ければ `null`。
 * 🔴 **形が読めないときも問題として断る**(ORT 1.31 は `inputMetadata` を返す ── 読めない = 想定の ORT ではない。素通りさせない)。
 *   次元が可変(文字列・負の数)なら、その次元は通す。
 */
export function inputShapeProblem(session: OrtSession, model: StemModel): string | null {
  const meta = session.inputMetadata;
  const first: unknown = Array.isArray(meta) ? meta[0] : undefined;
  const shape =
    typeof first === 'object' && first !== null ? (first as { shape?: unknown }).shape : undefined;
  if (!Array.isArray(shape) || shape.length !== 4) return 'モデルの入力の形を読み取れませんでした';
  const { dimF, dimT } = model.stft;
  const [, c, f, t] = shape as unknown[];
  const ok = (v: unknown, want: number): boolean => typeof v !== 'number' || v < 0 || v === want;
  if (ok(c, 4) && ok(f, dimF) && ok(t, dimT)) return null;
  return `モデルの入力の形が想定(4 × ${String(dimF)} × ${String(dimT)})と違います`;
}

/** メモリ不足を示す文(重みの不良でも ORT の起動の失敗でもない ── メモリの案内へ)。 */
const OUT_OF_MEMORY = /out of memory|\bOOM\b|allocation failed|Array buffer allocation|memory access out of bounds|Cannot enlarge memory/i;

/** ORT 自身が出す失敗を、画面の理由に分ける(メモリ不足 → 推論の失敗(メモリの案内)/ 起動の失敗 / 重みの不良)。 */
function classifyOrtError(detail: string): StemRefusal {
  if (OUT_OF_MEMORY.test(detail)) return 'infer-failed';
  return RUNTIME_FAILURE.test(detail) ? 'no-runtime' : 'bad-model';
}

/** 「やめる」の合図を区切りで見て抜けたこと。⚠ 失敗ではない(`reason: 'cancelled'` で返る)。 */
class StemCancelled extends Error {}

export class StemRunner {
  private readonly deps: StemDeps;

  constructor(deps: StemDeps) {
    this.deps = deps;
  }

  /**
   * 🔴 **実行器が起動できるかを、極小のモデルで確かめる**(モデルを取る前に呼ぶ)。
   * ORT の wasm が取れない・バックエンドが無い環境で、66MB を取ってから失敗しないため。⚠ セッションは作ってすぐ手放す。
   */
  async probe(): Promise<StemProbeResult> {
    let ort: OrtLike;
    try {
      ort = await this.deps.loadOrt();
    } catch (e) {
      return { ok: false, reason: 'no-runtime', detail: e instanceof Error ? e.message : String(e) };
    }
    try {
      const session = await ort.InferenceSession.create(buildIdentityOnnx([1]), {
        executionProviders: ['wasm'],
        logSeverityLevel: 3,
      });
      await session.release().catch(() => undefined);
      return { ok: true };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      // 極小のモデルが読めないのは、重みではなく実行器の側の問題
      const reason = classifyOrtError(detail);
      return { ok: false, reason: reason === 'bad-model' ? 'no-runtime' : reason, detail };
    }
  }

  async run(job: StemJob): Promise<StemResult> {
    // 🔴 所有を取る(依頼が PCM を持ち続けると、使い終わったあとも解放されない)
    const left = job.left;
    const right = job.right;
    job.left = EMPTY;
    job.right = EMPTY;
    const port = job.progress;
    const report = (text: string): void => port?.postMessage(text);
    // 🔴 「やめる」の合図は同じ口(MessagePort)の反対向きで届く。区切り(塊の合間)で見て、抜ける
    let cancelled = false;
    if (port !== undefined) {
      port.onmessage = (ev: MessageEvent<unknown>): void => {
        if (ev.data === 'cancel') cancelled = true;
      };
    }
    const checkpoint = async (): Promise<void> => {
      // 他の依頼・合図を受けられるよう、塊の合間に 1 度だけ手放す
      await new Promise<void>((r) => setTimeout(r, 0));
      if (cancelled) throw new StemCancelled();
    };
    try {
      return await this.runInner(job, left, right, report, checkpoint);
    } finally {
      port?.close();
    }
  }

  private async runInner(
    job: StemJob,
    left: Float32Array,
    right: Float32Array,
    report: (text: string) => void,
    checkpoint: () => Promise<void>,
  ): Promise<StemResult> {
    const model = stemModelOf(job.modelId);
    if (model === undefined) return { ok: false, reason: 'unknown-model' };
    const n = Math.min(left.length, right.length);
    if (n === 0) return { ok: false, reason: 'empty' };
    if ((n * 1000) / STEM_RATE > STEM_MAX_MS) return { ok: false, reason: 'too-long' };
    let peak = 0;
    for (let i = 0; i < n; i += 1) peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
    if (peak < 1e-4) return { ok: false, reason: 'silent' };

    report('モデルを読み込んでいます…');
    let ort: OrtLike;
    try {
      ort = await this.deps.loadOrt();
    } catch (e) {
      return { ok: false, reason: 'no-runtime', detail: e instanceof Error ? e.message : String(e) };
    }
    let session: OrtSession;
    try {
      let bytes: Uint8Array | null = new Uint8Array(await job.model.arrayBuffer());
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], logSeverityLevel: 3 });
      bytes = null; // wasm のヒープへ写された ── JS 側の写しはもう要らない
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      // 🔴 メモリ不足は、重みの不良でも ORT の起動の失敗でもない(メモリの案内を出す)。次に ORT 自身の起動の失敗(wasm が取れない・
      //   バックエンドが無い)と重みの不良を分ける(直し方が違う)
      return { ok: false, reason: classifyOrtError(detail), detail };
    }
    try {
      const problem = inputShapeProblem(session, model);
      if (problem !== null) return { ok: false, reason: 'bad-model', detail: problem };
      const { dimF, dimT } = model.stft;
      const inName = session.inputNames[0];
      const outName = session.outputNames[0];
      if (inName === undefined || outName === undefined) {
        return { ok: false, reason: 'bad-model', detail: 'モデルの入出力が読めません' };
      }
      const infer = async (input: Float32Array): Promise<Float32Array> => {
        const tensor = new ort.Tensor('float32', input, [1, 4, dimF, dimT]);
        const out = await session.run({ [inName]: tensor });
        const data = out[outName]?.data;
        if (!(data instanceof Float32Array)) throw new Error('モデルの出力が浮動小数の配列ではありません');
        return data;
      };
      let sep: Awaited<ReturnType<typeof separateStems>>;
      const inputRms = stereoRms(left.subarray(0, n), right.subarray(0, n));
      try {
        sep = await separateStems(left, right, {
          model,
          infer,
          onProgress: (d, t) => report(`歌声と楽器を分けています… ${String(d)} / ${String(t)}`),
          checkpoint,
        });
      } catch (e) {
        if (e instanceof StemCancelled) return { ok: false, reason: 'cancelled' };
        const detail = e instanceof Error ? e.message : String(e);
        // 出力の形・有限性の違反は重み・設定の不良(bad-model)。メモリ不足などの計算の失敗は infer-failed
        return { ok: false, reason: e instanceof StemModelError ? 'bad-model' : 'infer-failed', detail };
      }
      // 🔴 安全弁: 分けた結果が音として成り立っていること(設定違い・別のモデルを、聞かせる前に止める)
      const problem2 = separationProblem(inputRms, sep.primary, sep.rest, sep.consistency);
      if (problem2 !== null) return { ok: false, reason: 'bad-model', detail: problem2 };
      // ⚠ `rest` は `left` / `right` の中身(上書きして使い回している)── 3 組を同時に持たない
      return await this.encode(model, sep, report);
    } finally {
      // 🔴 セッションは依頼の終わりに必ず手放す(重みのメモリを持ち越さない)
      await session.release().catch(() => undefined);
    }
  }

  private async encode(
    model: StemModel,
    sep: Awaited<ReturnType<typeof separateStems>>,
    report: (text: string) => void,
  ): Promise<StemResult> {
    const api = this.deps.audioApi === undefined ? nativeAudioApi() : this.deps.audioApi;
    const tags = stemTags(model);
    const parts: Array<{ tag: string; pcm: [Float32Array, Float32Array] | null }> = [
      { tag: tags.primary, pcm: [sep.primary[0], sep.primary[1]] },
      { tag: tags.rest, pcm: [sep.rest[0], sep.rest[1]] },
    ];
    const files: StemFile[] = [];
    for (const p of parts) {
      report(`「${p.tag}」を書き出しています…`);
      const source = p.pcm;
      if (source === null) return { ok: false, reason: 'encode-failed' };
      const pcm = toEncoderPcm(source[0], source[1]); // 1 周ごとに手放される(次の周へ持ち越さない)
      p.pcm = null; // 再標本化した 1 本ができたので、44.1kHz の左右は手放す
      const enc = await encodeOpusWebm(pcm, api, 2);
      if (!enc.ok) return { ok: false, reason: enc.reason };
      files.push({ tag: p.tag, bytes: enc.bytes.buffer as ArrayBuffer, durationMs: enc.durationMs });
    }
    return { ok: true, files };
  }
}
