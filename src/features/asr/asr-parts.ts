/**
 * 🔴 **音声認識(文字にする)の部品 ── 何を、どこから、どれだけ取るか**(#772 段②)。
 *
 * > 裁定 2026-10-01(#772 コメント 5941919096)= 実機の日本語測定を待たずに段②へ進む。
 * > 2 択の中身は**定数 1 か所**に置き、実機の結果で差し替えられる形にする。
 * > メモリの限られる端末には「この端末のメモリでは動かない見込み」を**押す前に**出す。
 *
 * ⚠ **ここが数字の正本である。** 画面の字・取り込みの検め・メモリの案内は全部ここから引く
 *   (2 択の中身を差し替える日に、直す場所が 1 か所で済むように ── §7)。
 * ⚠ **pure module**(browser API を触らない)。取りに行くのは `adapter/platform/asr/`。
 *
 * ## 数の出どころ(`docs/development/asr-measure-2026-10.md` の実測。2026-10-01)
 *
 * | | 重み(ONNX q8) | 1 分の音 | 推論中の常駐(プロセス木) |
 * |---|---|---|---|
 * | 軽い = base | **81,270,976 byte** | 24〜34 秒(約 25 秒) | **1.65GB** |
 * | 当たりやすい = small | **253,468,391 byte** | 60〜82 秒(約 60 秒) | **3.6GB** |
 *
 * ⚠ 秒は**混んだ 4 コアの箱**で測った向きと桁である。実機で変わる ──
 *   だから字は「約」と書く。⚠ **日本語の当たり具合はまだ測っていない**(その箱では測れない)。
 *   実機の結果が出たら、この表の 2 行を差し替える(仕組みは変わらない)。
 */
import { humanBytes } from '../human-bytes';

/** 2 択の id。⚠ 画面の字ではない(画面の字は `label`)。 */
export type AsrPartId = 'light' | 'accurate';

export interface AsrPart {
  readonly id: AsrPartId;
  /** 画面に出す名前。 */
  readonly label: string;
  /** transformers が引くモデルの名前(`env.localModelPath` の下の相対)。 */
  readonly modelId: string;
  /**
   * 重みの大きさ(byte)。⚠ 画面の字はここから作る(`humanBytes` を通す ── 大きさの綴りは 1 本 #454)。
   * 🔑 実測の byte 数そのもの(`asr-measure-2026-10.md` §2-1)。「81MB」と丸めて持たない。
   */
  readonly modelBytes: number;
  /** 1 分の音を字にする秒の目安。 */
  readonly secondsPerMinute: number;
  /**
   * この端末のメモリがこれ未満なら「動かない見込み」と出す(GB。`navigator.deviceMemory` の単位)。
   * 🔑 **根拠**:推論中の常駐の実測(1.65GB / 3.6GB)に、**ブラウザ本体と OS の分**として
   *   約 2 倍の余裕を見た(判断であって実測ではない)。`deviceMemory` は 8 で頭打ちなので
   *   small の 8 は「8GB 以上なら出さない」と同じ意味になる。
   *   ⚠ 出すだけで、ボタンは押せるまま(押して試すことは止めない)。
   */
  readonly needMemoryGb: number;
}

/** 2 択の中身。⚠ **ここだけを差し替える**(実機の日本語の結果を受けて)。 */
export const ASR_PARTS: readonly AsrPart[] = [
  {
    id: 'light',
    label: '軽い',
    modelId: 'openai/whisper-base',
    modelBytes: 81_270_976,
    secondsPerMinute: 25,
    needMemoryGb: 4,
  },
  {
    id: 'accurate',
    label: '当たりやすい',
    modelId: 'openai/whisper-small',
    modelBytes: 253_468_391,
    secondsPerMinute: 60,
    needMemoryGb: 8,
  },
] as const;

export function asrPartOf(id: string): AsrPart | undefined {
  return ASR_PARTS.find((p) => p.id === id);
}

/**
 * 🔴 **取り先**(同一オリジンの絶対 path)。
 *
 * ⚠ **別 origin は取れない**(GitHub の release 資産は CORS を返さない ── 2026-08-14 実測。
 *   `office-pack-acquire.ts`)。Office の一式と同じく、**配る側が同じ origin の
 *   `/asr-pack/` に置く**(別 repo の Pages)。置かれるまでは目録が 404 になり、
 *   画面は「まだ配っていません」と言う。
 * ⚠ `/office-pack/` と同じく**絶対 path**にする(`/PKC3/dev/` から開いても
 *   同じ場所を指す。相対にすると 1 段深い所を見て 404 になる ── 2026-08-11 に踏んだ形)。
 */
export const ASR_PACK_BASE = '/asr-pack/';

/** 認識に使う言語(whisper の言語名)。⚠ `null` = 自動判定。実機の結果で変えうるので 1 か所。 */
export const ASR_LANGUAGE: string | null = 'japanese';

/** 推論の入力の標準(whisper は 16kHz / mono)。 */
export const ASR_SAMPLE_RATE = 16_000;

/**
 * 認識の部品が**使われなくなってから畳むまで**(ms)。
 * ⚠ 推論中の常駐は 1.65〜3.6GB ── 実測で、worker を止めれば 10 秒後に戻る。
 *   長く置くほど他の作業を圧迫する。⚠ 短すぎると、続けて押したとき
 *   読み込み(2.7〜5 秒)をやり直す。
 */
export const ASR_WORKER_IDLE_MS = 15_000;

/** 目録の名前。 */
export const ASR_MANIFEST = 'pack.json';

/**
 * 実行の部品(2 択に共通)。⚠ 配る側はこの名前で置く(目録が全部を列挙する)。
 *
 * | file | 中身 |
 * |---|---|
 * | `runtime/transformers.mjs` | transformers.js + onnxruntime-web を **1 枚の ESM に束ねた**もの(bare import を残さない) |
 * | `runtime/ort-wasm.mjs` | ORT の wasm の読み込み役(`ort-wasm-simd-threaded.mjs`) |
 * | `runtime/ort-wasm.wasm` | ORT の wasm 本体(`ort-wasm-simd-threaded.wasm`。14.3MB) |
 */
export const ASR_RUNTIME_JS = 'runtime/transformers.mjs';
export const ASR_RUNTIME_WASM_LOADER = 'runtime/ort-wasm.mjs';
export const ASR_RUNTIME_WASM = 'runtime/ort-wasm.wasm';
export const ASR_RUNTIME_FILES: readonly string[] = [
  ASR_RUNTIME_JS,
  ASR_RUNTIME_WASM_LOADER,
  ASR_RUNTIME_WASM,
];

/**
 * 実行の部品の大きさ(byte)。実測 = `transformers.mjs` 567,126 + `ort-wasm.mjs` 24,381 + `ort-wasm.wasm` 14,264,838。
 * ⚠ 画面の字にだけ使う(判定には使わない ── 目録の下限は `RUNTIME_FLOOR`)。
 */
export const ASR_RUNTIME_BYTES = 14_856_345;

/** 部品の中の model の置き場(pack 内の相対)。 */
export function asrModelDir(part: AsrPart): string {
  return `models/${part.modelId}/`;
}

/** 取るものの大きさの目安(byte)。⚠ 画面の字にだけ使う(判定には使わない)。 */
export function asrDownloadBytes(part: AsrPart): number {
  return part.modelBytes + ASR_RUNTIME_BYTES;
}

/**
 * ボタンの字(大きさと 1 行の説明つき)。
 * 例: `軽い(約 91.7 MB、1 分の音に約 25 秒)`。
 * ⚠ 数は**全部定数から出す** ── 手で書くと、実機の結果で差し替えた日に食い違う。
 * ⚠ 大きさは `humanBytes`(画面の大きさの綴りはあの 1 本 ── `tests/features/human-bytes.test.ts`)。
 */
export function asrPartLabel(part: AsrPart): string {
  return `${part.label}(約 ${humanBytes(asrDownloadBytes(part))}、1 分の音に約 ${part.secondsPerMinute} 秒)`;
}

/**
 * 🔴 **押す前に出す「動かない見込み」**。`deviceMemory` が読める端末だけ(読めなければ `null`)。
 *
 * ⚠ 読めない端末(Firefox / Safari)に何も出さないのは「大丈夫」ではなく
 *   「**言えない**」である ── だから別の字は出さない(嘘の安心も、根拠の無い脅しも作らない)。
 * ⚠ 事実を述べる(BANNED_TERMS の評価語・脅し語は使わない)。
 */
export function asrMemoryNote(part: AsrPart, deviceMemoryGb: number | undefined): string | null {
  if (typeof deviceMemoryGb !== 'number' || !Number.isFinite(deviceMemoryGb) || deviceMemoryGb <= 0) {
    return null;
  }
  if (deviceMemoryGb >= part.needMemoryGb) return null;
  // ⚠ 大きさの綴りは `humanBytes` の 1 本(`deviceMemory` は GiB 単位。0.25 なら「256.0 MB」と出る)
  return `この端末のメモリ(${humanBytes(deviceMemoryGb * 1024 ** 3)})では動かない見込みです`;
}

// ── 目録(`pack.json`)を読む ────────────────────────────────────────────

export interface AsrPackFile {
  /** pack 内の相対 path。 */
  readonly path: string;
  readonly bytes: number;
  /** 小文字 hex の SHA-256。 */
  readonly sha256: string;
}

export interface AsrPack {
  readonly version: string;
  readonly runtime: readonly AsrPackFile[];
  /** 配られている 2 択ぶんだけ入る(一方だけ配る日があってよい)。 */
  readonly models: Readonly<Partial<Record<AsrPartId, readonly AsrPackFile[]>>>;
}

export type AsrPackRead =
  | { readonly ok: true; readonly pack: AsrPack }
  | { readonly ok: false; readonly why: string };

/**
 * 下限 ── 空・途中で切れた物を「在る」と数えない(事故の桁だけを止める)。
 * ⚠ **上限は置かない**(配る量は判断理由にしない ── 不可侵指示 2026-08-03)。
 */
const RUNTIME_FLOOR: Readonly<Record<string, number>> = {
  [ASR_RUNTIME_JS]: 100_000,
  [ASR_RUNTIME_WASM_LOADER]: 5_000,
  [ASR_RUNTIME_WASM]: 5_000_000,
};

/** 重みの下限 = 定数の半分(別の model を取り違えた・途中で切れた、の桁を止める)。 */
export function asrModelFloorBytes(part: AsrPart): number {
  return Math.floor(part.modelBytes / 2);
}

/** pack 内の相対 path として安全か(`..` / 絶対 / backslash を断る)。 */
export function isSafePackPath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function readFiles(v: unknown, where: string): AsrPackFile[] | string {
  if (!Array.isArray(v)) return `${where} が配列ではありません`;
  const out: AsrPackFile[] = [];
  for (const f of v) {
    if (typeof f !== 'object' || f === null) return `${where} に読めない行があります`;
    const r = f as Record<string, unknown>;
    const path = r['path'];
    const bytes = r['bytes'];
    const sha = r['sha256'];
    if (typeof path !== 'string' || !isSafePackPath(path)) return `${where} に使えない名前があります`;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) {
      return `${where} の ${path} の大きさが読めません`;
    }
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) {
      return `${where} の ${path} の sha256 が読めません`;
    }
    out.push({ path, bytes, sha256: sha });
  }
  return out;
}

/**
 * 目録を**信じずに検める**。⚠ JSON として読めたことを「目録だった」と読まない
 * (404 の HTML を返す配り方もありうる ── 沈黙を成功と読まない)。
 */
export function readAsrPack(text: string): AsrPackRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, why: '目録(pack.json)として読めません' };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, why: '目録の形が違います' };
  const o = raw as Record<string, unknown>;
  const version = o['version'];
  if (typeof version !== 'string' || version === '') return { ok: false, why: '目録に版がありません' };

  const runtime = readFiles(o['runtime'], '実行の部品');
  if (typeof runtime === 'string') return { ok: false, why: runtime };
  for (const need of ASR_RUNTIME_FILES) {
    const f = runtime.find((r) => r.path === need);
    if (f === undefined) return { ok: false, why: `実行の部品に ${need} がありません` };
    if (f.bytes < (RUNTIME_FLOOR[need] ?? 1)) {
      return { ok: false, why: `${need} が小さすぎます(途中で切れた可能性があります)` };
    }
  }

  const modelsRaw = o['models'];
  if (typeof modelsRaw !== 'object' || modelsRaw === null) return { ok: false, why: '目録に models がありません' };
  const models: Partial<Record<AsrPartId, readonly AsrPackFile[]>> = {};
  for (const part of ASR_PARTS) {
    const mine = (modelsRaw as Record<string, unknown>)[part.id];
    if (mine === undefined) continue; // 配っていない 2 択は無くてよい
    const files = readFiles(mine, `${part.label}の部品`);
    if (typeof files === 'string') return { ok: false, why: files };
    const dir = asrModelDir(part);
    if (!files.every((f) => f.path.startsWith(dir))) {
      return { ok: false, why: `${part.label}の部品に ${dir} の外の名前があります` };
    }
    const onnx = files.filter((f) => f.path.endsWith('.onnx'));
    if (onnx.length === 0) return { ok: false, why: `${part.label}の部品に重み(.onnx)がありません` };
    const total = onnx.reduce((s, f) => s + f.bytes, 0);
    if (total < asrModelFloorBytes(part)) {
      return { ok: false, why: `${part.label}の重みが小さすぎます(別の物か、途中で切れた可能性があります)` };
    }
    models[part.id] = files;
  }
  return { ok: true, pack: { version, runtime, models } };
}

/** 取り先の file の URL(`base` は末尾が `/` の同一オリジンの絶対 URL)。 */
export function asrAssetUrl(base: string, path: string): string {
  return `${base}${path.split('/').map(encodeURIComponent).join('/')}`;
}
