/**
 * 🔴 **この端末で WebGPU が使えるかを測る**(#1446 ②)。
 *
 * `navigator.gpu` が在ることと、実際にアダプタが取れることは別(在っても `requestAdapter()` が `null` を返す端末がある)。
 * だから**アダプタまで取って**初めて「使える」と言う。取れたアダプタは使わず、すぐ手放す(常駐させない)。
 * ⚠ 測れない(API が無い・例外)は `false`。⚠ 結果は 1 回だけ測って使い回す(端末は実行中に変わらない)。
 */
interface GpuLike {
  requestAdapter(): Promise<unknown | null>;
}

let cached: Promise<boolean> | null = null;

export function probeWebGpu(gpu: GpuLike | undefined = (globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu): Promise<boolean> {
  if (gpu === undefined) return Promise.resolve(false);
  return gpu.requestAdapter().then(
    (adapter) => adapter !== null,
    () => false,
  );
}

/** アプリ全体で 1 回だけ測る。 */
export function webGpuAvailable(): Promise<boolean> {
  cached ??= probeWebGpu();
  return cached;
}

/** test 用: 測り直せるよう控えを捨てる。 */
export function resetWebGpuProbe(): void {
  cached = null;
}
