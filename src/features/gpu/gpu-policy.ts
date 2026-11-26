/**
 * 🔴 **使い捨て GPU 基盤の判断だけ**(v4.0 Phase 3 / PR-11、ビジョン 1-A)。
 *
 * 実物(canvas・Three.js・WebGPU / WebGL2 のコンテキスト)は `src/adapter/platform/render/gpu-lease.ts` が持つ。
 * ここは「どの描き方を選ぶか」「何倍の解像度で描くか」「今コマを描いてよいか」「上限を超えたらどれを畳むか」を
 * **純関数**で答えるだけ ── browser API に触れないので、全組合せを単体で確かめられる。
 *
 * 🔑 `worker-lease.ts` と対をなす規律: **使わない間は 0**(読み込み 0 / コンテキスト 0 / コマの予約 0)。
 */

/** 描き方。`'2d'` は GPU を使わない退避(画面を壊さない最後の段)。 */
export type GpuBackend = 'webgpu' | 'webgl2' | '2d';

/** 最後の `invalidate()` からこれだけ何も無ければ、GPU のコンテキストを畳む(ms)。 */
export const GPU_IDLE_MS = 30_000;

/**
 * 高 DPR の端末で描く解像度の上限。
 * ⚠ DPR 3 の端末でそのまま描くと、画素数は 2 倍の 2.25 倍(VRAM も同じ比で増える)。見た目の差は小さいので 2 で止める。
 */
export const GPU_MAX_PIXEL_RATIO = 2;

/**
 * 同時に持つ GPU コンテキストの上限。
 * ⚠ ブラウザは WebGL のコンテキストを 1 ページあたり十数個で打ち切り、**最古を黙って失わせる**(画面が真っ黒になる)。
 *   ブラウザに勝手に選ばせず、こちらで最古を先に畳む(ポスターに焼いてから)。
 */
export const GPU_MAX_ACTIVE_CONTEXTS = 4;

export interface GpuCapabilities {
  /** 1 枚にまとめた版か(Three.js を同梱しない)。 */
  readonly portable: boolean;
  /** WebGPU のアダプタが取れたか。 */
  readonly webgpu: boolean;
  /** WebGL2 のコンテキストが取れたか。 */
  readonly webgl2: boolean;
}

/** 使える物のうち、いちばん上の段を選ぶ。1 枚にまとめた版は常に `'2d'`。 */
export function selectGpuBackend(caps: GpuCapabilities): GpuBackend {
  if (caps.portable) return '2d';
  if (caps.webgpu) return 'webgpu';
  if (caps.webgl2) return 'webgl2';
  return '2d';
}

/**
 * 段を 1 つ下げる(初期化に失敗したとき)。`'2d'` の下は無い(`null`)。
 * 🔑 WebGPU → WebGL2 → 2D の順は 1 か所だけで決める。
 */
export function nextFallbackBackend(backend: GpuBackend, caps: GpuCapabilities): GpuBackend | null {
  if (backend === 'webgpu') return caps.webgl2 && !caps.portable ? 'webgl2' : '2d';
  if (backend === 'webgl2') return '2d';
  return null;
}

/**
 * 実際に描く倍率。`[1, max]` に収める。
 * ⚠ 0・負・NaN・Infinity(壊れた環境・test の空の window)は 1 として扱う ── 0 で描くと canvas が 0×0 になり、
 *   Infinity だと確保に失敗する。
 */
export function effectivePixelRatio(dpr: number, max: number = GPU_MAX_PIXEL_RATIO): number {
  const cap = Number.isFinite(max) && max >= 1 ? max : 1;
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(Math.max(dpr, 1), cap);
}

/** このコマを描いてよいか(画面内・タブが見えている・まだ畳まれていない)。 */
export function shouldRunGpuFrame(state: {
  readonly visible: boolean;
  readonly pageVisible: boolean;
  readonly disposed: boolean;
}): boolean {
  return state.visible && state.pageVisible && !state.disposed;
}

/**
 * 上限を超えた分だけ、最後に使ったのが古い順に畳む対象を返す。
 * 🔴 `pinned` は畳まない(いま操作中の物など)。ピン留めだけで上限を超えているときは、超えた分を畳み切れなくても
 *   ピン留めには触れない(返す件数が足りないことがある)。
 * ⚠ 同じ時刻のときは並びの先にある物から(安定)。入力の配列は変えない。
 */
export function pickLruEviction<T extends { readonly id: string; readonly lastUsedAt: number; readonly pinned?: boolean }>(
  active: readonly T[],
  maxContexts: number,
): T[] {
  const limit = Number.isFinite(maxContexts) ? Math.max(0, Math.floor(maxContexts)) : active.length;
  const over = active.length - limit;
  if (over <= 0) return [];
  const candidates = active
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.pinned !== true)
    .sort((a, b) => a.item.lastUsedAt - b.item.lastUsedAt || a.index - b.index);
  return candidates.slice(0, over).map(({ item }) => item);
}
