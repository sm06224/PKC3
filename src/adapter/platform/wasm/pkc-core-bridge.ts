/**
 * Rust core(wasm)との境界(R1。rust-wasm-strategy §6)。
 *
 * 約束:
 * - **wasm-bindgen を使わない**。glue 無し・imports 0 件。境界の確保と解放を
 *   ここが全部握る(生成物のライフサイクル終端での即破棄 ── user 指示 2026-07-27)
 * - **失敗しても機能を止めない**。trap(panic / OOM)を捕まえたら instance を
 *   **毒**として捨て、以後は TS 実装へ恒久フォールバックする。可視化は caller の責務
 * - **wasm が正ではない。TS が正で、wasm は従**(§7.1)── 出力が食い違ったら
 *   TS を信じる。両者の等価性は parity test が恒久的に守る
 */

/** 復元チェーンの 1 段(新しい側から古い側へ向かう順に並べる)。 */
export type ChainStep =
  | { kind: 'full'; body: string }
  | { kind: 'patch'; ops: Array<number | string[]> };

interface CoreExports {
  memory: WebAssembly.Memory;
  pkc_alloc(len: number): number;
  pkc_free(ptr: number, len: number): void;
  pkc_free_result(ptr: number): void;
  pkc_abi_version(): number;
  pkc_restore_chain(ptr: number, len: number): number;
}

const ABI_VERSION = 1;
const FRAME_VERSION = 1;
const KIND_FULL = 0;
const KIND_PATCH = 1;
const OP_COPY = 0;
const OP_DELETE = 1;
const OP_INSERT = 2;

/** Rust 側 status code → TS 実装と**同じ文言**の Error(挙動を一致させる)。 */
const STATUS_MESSAGE: Record<number, string> = {
  1: 'patch: malformed',
  2: 'patch: copy overruns source',
  3: 'patch: delete overruns source',
  4: 'patch: source not fully consumed',
  5: 'unsupported patch version',
};

let core: CoreExports | null = null;
let poisoned = false;
let poisonReason: string | null = null;

/** 毒 = trap を一度でも起こした instance。以後 wasm は使わない。 */
function poison(reason: string): void {
  poisoned = true;
  poisonReason = reason;
  core = null; // 参照を落として linear memory ごと回収させる(高水位を残さない)
}

export function wasmStatus(): { ready: boolean; poisoned: boolean; reason: string | null } {
  return { ready: core !== null, poisoned, reason: poisonReason };
}

/**
 * 起動時に 1 回だけ呼ぶ(worker の init 経路)。**失敗しても throw しない** ──
 * wasm が無い環境でもアプリは TS 実装で完全に動く。
 */
export async function initPkcCore(bytes: BufferSource): Promise<boolean> {
  if (poisoned) return false;
  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports as unknown as CoreExports;
    if (typeof ex.pkc_abi_version !== 'function' || ex.pkc_abi_version() !== ABI_VERSION) {
      poison(`abi mismatch (expected ${ABI_VERSION})`);
      return false;
    }
    core = ex;
    return true;
  } catch (e) {
    poison(`instantiate failed: ${String(e)}`);
    return false;
  }
}

/** test / probe が明示的に落とすための口(毒状態も解除する)。 */
export function resetPkcCore(): void {
  core = null;
  poisoned = false;
  poisonReason = null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** フレームの必要バイト数を先に数える(1 回の確保で書き切るため)。 */
function frameSize(tip: Uint8Array, steps: readonly EncodedStep[]): number {
  let n = 4 + 4 + 4 + tip.length;
  for (const s of steps) {
    n += 4; // kind
    if (s.kind === KIND_FULL) {
      n += 4 + s.body!.length;
    } else {
      n += 4; // n_ops
      for (const op of s.ops!) {
        n += 4; // tag
        if (typeof op === 'number') n += 4;
        else {
          n += 4;
          for (const line of op) n += 4 + line.length;
        }
      }
    }
  }
  return n;
}

interface EncodedStep {
  kind: number;
  body?: Uint8Array;
  ops?: Array<number | Uint8Array[]>;
}

/**
 * JSON の解釈は **JS 側に残す**(§4.2)。unicode 正しさの実績がある JSON.parse を
 * 使い、wasm へ渡すのは既に解いた ops のバイト列だけにする ── Rust に JSON
 * パーサを書かない(そこは byte 一致を壊す事故の温床になる)。
 */
function encodeSteps(steps: readonly ChainStep[]): EncodedStep[] {
  return steps.map((s) =>
    s.kind === 'full'
      ? { kind: KIND_FULL, body: encoder.encode(s.body) }
      : {
          kind: KIND_PATCH,
          ops: s.ops.map((op) =>
            typeof op === 'number' ? op : op.map((line) => encoder.encode(line)),
          ),
        },
  );
}

/**
 * 復元チェーンを wasm で 1 往復で回す。
 * @returns 復元本文 / wasm が使えないときは null(caller が TS へフォールバック)
 * @throws 復元不能(status != 0)── TS 実装と同じ文言の Error
 */
export function restoreChainWasm(tipBody: string, steps: readonly ChainStep[]): string | null {
  const ex = core;
  if (!ex) return null;

  const tip = encoder.encode(tipBody);
  const enc = encodeSteps(steps);
  const size = frameSize(tip, enc);

  let inPtr = 0;
  let outPtr = 0;
  try {
    inPtr = ex.pkc_alloc(size);
    if (inPtr === 0) return null;
    // ⚠ memory.buffer は grow で detach されうるので、alloc の**後**に view を取る
    const view = new DataView(ex.memory.buffer);
    const heap = new Uint8Array(ex.memory.buffer);
    let o = inPtr;
    const putU32 = (v: number): void => {
      view.setUint32(o, v, true);
      o += 4;
    };
    const putBytes = (b: Uint8Array): void => {
      heap.set(b, o);
      o += b.length;
    };
    putU32(FRAME_VERSION);
    putU32(enc.length);
    putU32(tip.length);
    putBytes(tip);
    for (const s of enc) {
      putU32(s.kind);
      if (s.kind === KIND_FULL) {
        putU32(s.body!.length);
        putBytes(s.body!);
      } else {
        putU32(s.ops!.length);
        for (const op of s.ops!) {
          if (typeof op === 'number') {
            putU32(op >= 0 ? OP_COPY : OP_DELETE);
            putU32(Math.abs(op));
          } else {
            putU32(OP_INSERT);
            putU32(op.length);
            for (const line of op) {
              putU32(line.length);
              putBytes(line);
            }
          }
        }
      }
    }

    outPtr = ex.pkc_restore_chain(inPtr, size);
    if (outPtr === 0) return null;
    const out = new DataView(ex.memory.buffer);
    const status = out.getUint32(outPtr, true);
    const len = out.getUint32(outPtr + 4, true);
    if (status !== 0) {
      throw new Error(STATUS_MESSAGE[status] ?? `wasm restore failed (status ${status})`);
    }
    // 出力は 1 回だけ decode する(B2 ── 中間状態を JS 文字列にしない)
    return decoder.decode(new Uint8Array(ex.memory.buffer, outPtr + 8, len));
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError || e instanceof RangeError) {
      // trap / メモリ確保失敗 ── instance が毒された可能性があるので捨てる
      poison(String(e));
      return null;
    }
    throw e; // status 由来の Error は caller へ(TS と同じ失敗として扱う)
  } finally {
    // 借りたメモリは**必ず**返す(成功・失敗・throw のいずれでも)
    const live = core;
    if (live) {
      if (inPtr !== 0) live.pkc_free(inPtr, size);
      if (outPtr !== 0) live.pkc_free_result(outPtr);
    }
  }
}
