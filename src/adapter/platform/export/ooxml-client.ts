/**
 * OOXML(`.docx` / `.pptx`)の組み立てを**ワーカーへ渡す口**(#187 段④・段⑤)。
 *
 * 遅延起動・ジョブのバッファ・アイドル kill は `WorkerLease` が持つ
 * (user 指示 2026-08-03 の 3 規律)。ここが足すのは**落とし所**だけである:
 *
 * 🔴 **ワーカーが無い環境では、同じ関数をその場で回す**(`file://` / 古い環境 /
 * node の unit)。⚠ 出口を 2 本作っているのではない ── 返る zip は
 * **同じ `assembleOoxml`** から出る(`markdown-client.ts` と同じ位置づけ:
 * 「ワーカーは速さの話であって、正しさの話ではない」)。
 */
import { WorkerLease } from '../worker-lease';
import { appJobMonitor } from '../job-monitor';
import { assembleOoxml, type OoxmlJob, type OoxmlJobResult } from './ooxml-assemble';

/** アイドルで畳むまで。⚠ 書き出しは連打されないので、短めでよい。 */
export const OOXML_WORKER_IDLE_MS = 15_000;

let lease: WorkerLease | null = null;
/** test / 計測が差し替える口(既定は本物のワーカー)。 */
let spawnOverride: (() => Worker) | null = null;

/** ⚠ 差し替えたら**前のワーカーは畳む**(2 本走らせない)。 */
export function setOoxmlWorkerSpawn(fn: (() => Worker) | null): void {
  lease?.dispose();
  lease = null;
  spawnOverride = fn;
}

/**
 * ⚠ **「Worker が在るか」を先に見ない。** 見ても下の `catch` と同じ所へ落ちるだけで、
 * **変異試験で殺せない行**になる(実際に生き延びた)── 起動に失敗したら
 * その場で組み直す、の 1 本にまとめる。
 */
function leaseOf(): WorkerLease {
  lease ??= new WorkerLease({
    name: 'ooxml',
    idleMs: OOXML_WORKER_IDLE_MS,
    monitor: appJobMonitor,
    spawn:
      spawnOverride ??
      (() => new Worker(new URL('./ooxml-worker.ts', import.meta.url), { type: 'module' })),
  });
  return lease;
}

/** ワーカーが生きているか(計測と test の観測点)。 */
export function ooxmlWorkerAlive(): boolean {
  return lease?.alive ?? false;
}

/**
 * 塊 → `.docx` / `.pptx` の Blob。
 * ⚠ **失敗したらその場で組み直す** ── ワーカーの事故で「押しても何も落ちてこない」
 * を作らない(ワーカーは速さの話である)。
 */
export async function buildOoxmlFile(req: OoxmlJob): Promise<OoxmlJobResult> {
  try {
    return await leaseOf().run<OoxmlJobResult>(req);
  } catch {
    // ⚠ ワーカーが使えない環境(`file://` / node の unit)も、事故った場合も
    //    **同じ所**へ落ちる ── 返る zip は同じ関数から出る
    return assembleOoxml(req);
  }
}
