/**
 * 🔴 **テキスト整形の正規表現の置換を、ワーカーで時間を切って回す口**(#1233 のレビュー ⚠1)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください / ワーカーはしばらく
 * > つかわれないなら、キルと解放し…」
 *
 * ⚠ 正規表現は user が書く。`(a+)+$` のような入れ子の繰り返しは、27 字の入力でも何十秒も終わらず、
 *   メインスレッドで回すと画面ごと固まる(打つたびに回るので、止められない)。
 * 🔑 だから①ワーカーで回し ②`LAB_REGEX_TIMEOUT_MS` で切り、③切ったら `terminate()` して「重すぎるので止めました」と言う。
 *   遅延起動・アイドル kill・terminate 時の reject は `WorkerLease`(`runWithin` が時間切れを持つ)。
 * ⚠ ワーカーの無い環境(test など)では、同じ関数をその場で回す ── そこでは時間を切れない
 *   (画面の実機は必ずワーカーを使う)。
 */
import { WorkerLease, WorkerTimeoutError } from '../worker-lease';
import { appJobMonitor, type JobMonitor } from '../job-monitor';
import { applyLabRegex, type LabRegex, type LabRegexResult } from '@features/markdown/lab-regex';

/** 置換 1 回に許す時間(ms)。これを超えたら止める。 */
export const LAB_REGEX_TIMEOUT_MS = 1_500;

/** アイドルで畳むまで。⚠ 打鍵のたびに作り直さない程度。 */
export const LAB_WORKER_IDLE_MS = 10_000;

/** 時間切れのときの結果の一言。⚠ 画面の字はここ 1 か所。 */
export const LAB_REGEX_TIMEOUT_NOTE =
  'この置換は重すぎるので止めました(1.5 秒かけても終わりません)。パターンを簡単にするか、文章を短くしてください';

export interface LabClientOptions {
  /** `null` = ワーカーを使わずその場で回す。省略 = 既定の作り方。 */
  spawn?: (() => Worker) | null;
  idleMs?: number;
  timeoutMs?: number;
  monitor?: JobMonitor;
}

export class LabRegexClient {
  private readonly lease: WorkerLease | null;
  private readonly timeoutMs: number;

  constructor(options: LabClientOptions = {}) {
    const spawn = options.spawn === undefined ? defaultSpawn() : options.spawn;
    this.timeoutMs = options.timeoutMs ?? LAB_REGEX_TIMEOUT_MS;
    this.lease = spawn
      ? new WorkerLease({
          spawn,
          idleMs: options.idleMs ?? LAB_WORKER_IDLE_MS,
          name: 'textlab',
          monitor: options.monitor ?? appJobMonitor,
        })
      : null;
  }

  get offloaded(): boolean {
    return this.lease !== null;
  }

  get alive(): boolean {
    return this.lease?.alive ?? false;
  }

  /** 置換を回す。⚠ 時間切れは例外にせず、`LAB_REGEX_TIMEOUT_NOTE` つきの結果で返す(入力はそのまま)。 */
  async apply(text: string, regex: LabRegex): Promise<LabRegexResult> {
    if (!this.lease) return applyLabRegex(text, regex);
    try {
      return await this.lease.runWithin<LabRegexResult>({ text, regex }, this.timeoutMs);
    } catch (e) {
      if (e instanceof WorkerTimeoutError) return { text, note: LAB_REGEX_TIMEOUT_NOTE, hits: 0 };
      throw e;
    }
  }

  dispose(): void {
    this.lease?.dispose();
  }
}

function defaultSpawn(): (() => Worker) | null {
  if (typeof Worker !== 'function') return null;
  return () => new Worker(new URL('./lab-worker.ts', import.meta.url), { type: 'module' });
}

/** 画面が共有する 1 本。⚠ 作っただけではワーカーは起きない(遅延起動)。 */
export const appLabRegex = new LabRegexClient();
