/**
 * 🔴 **索引の片づけを、書込が落ち着いたときに自動で 1 回打つ**(#999 段③。Gemini 裁定 A)。
 *
 * ## 何をするか
 *
 * 書込の通知(`noteWrite`)を数え、`planAutoOptimize`(`features/storage/auto-optimize.ts`)が
 * 「いま打ってよい」と言ったときだけ、storage worker の `optimizeIndexes` を 1 回打つ。
 * 打ったら処理の記録(メッセージの種類「処理」)へ **1 件**積む。
 *
 * ## 守っていること
 *
 * - 🔴 **判断は `planAutoOptimize` の 1 か所**。⚠ ここに日付の比較や回数の比較を書かない
 *   (CLAUDE.md §7)。ここは**時計・タブの見え方・lease・書込の回数を渡す**だけ。
 * - 🔴 **書込と並走させない**。`run`(= effect 層の書込の列に載せる口)の**中で**打つ ──
 *   しかも**列の中で判断をもう 1 度やる**(待っている間に書込が着地していたら、
 *   「落ち着いた」が崩れているので打たずに見直す)。⚠ worker 側も 1 本の同期 handler なので、
 *   別のタブの書込(follower 経由)とも交わらない。
 * - 🔴 **書込の lease を握るタブだけが打つ**。`noteWrite` は `StoreProxyHost.onMutation`
 *   (= holder だけが持つ。follower の書込も holder を通る)から呼ばれるので、構造としても
 *   holder にしか届かないが、判断(`holdsWriterLease`)でも見る(昇格・降格の途中を信じない)。
 * - 🔴 **隠れているタブでは打たない**。戻ってきたとき(`visibilitychange`)に見直す。
 * - 🔴 **失敗は 1 件だけ積む**。連続して失敗しても積まない(成功したら数え直す)。
 *   失敗した回も「前回」に数える ── 毎分やり直さない。
 * - 🔴 **自分の記録が自分を起こさない**。処理のメッセージの追記(`appendMessage`)は
 *   `MUTATING_OPS` に入っておらず、`optimizeIndexes` も入っていない ── 数えない。
 * - 🔴 **VACUUM はここに無い**(#1218)。
 */
import type { OptimizeIndexesResult } from './protocol';
import {
  OPTIMIZE_FAILED_TEXT,
  optimizeDoneText,
  planAutoOptimize,
  type AutoOptimizePlan,
} from '@features/storage/auto-optimize';

export interface AutoOptimizerDeps {
  /** 書込の lease を握っているか(`main.ts` の `writerHolder`)。 */
  holdsWriterLease(): boolean;
  /** 書込の列に載せて走らせる(`StoreEffects.run`)。 */
  run<T>(job: () => Promise<T>): Promise<T>;
  /** worker の `optimizeIndexes` を 1 回打つ。 */
  optimize(): Promise<OptimizeIndexesResult>;
  /** 処理の記録へ積む(`appMessagePost.post`)。 */
  post(input: { kind: 'job'; source: string; text: string }): void;
  /** いま(ms)。既定は `Date.now`。 */
  now?: () => number;
  /** タブが隠れているか。既定は `document.hidden`。 */
  hidden?: () => boolean;
  /** `ms` 後に `fn` を 1 回呼ぶ。戻り値は取り消す関数。既定は `setTimeout`。 */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** タブが見えるようになったとき `fn` を呼ぶ。戻り値は購読を解く関数。既定は `visibilitychange`。 */
  onVisible?: (fn: () => void) => () => void;
}

/** 処理の記録に書く出所(固定の機能名。user の入力は含めない)。 */
export const AUTO_OPTIMIZE_SOURCE = 'storage-optimize';

export class AutoOptimizer {
  private readonly now: () => number;
  private readonly hidden: () => boolean;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly onVisible: (fn: () => void) => () => void;

  private lastWriteAt: number | null = null;
  private lastOptimizeAt: number | null = null;
  private writesSince = 0;
  private running = false;
  private lastFailed = false;
  private disposed = false;
  private cancelTimer: (() => void) | null = null;
  private unwatchVisible: (() => void) | null = null;

  constructor(private readonly deps: AutoOptimizerDeps) {
    this.now = deps.now ?? ((): number => Date.now());
    this.hidden = deps.hidden ?? ((): boolean => document.hidden);
    this.schedule =
      deps.schedule ??
      ((fn, ms): (() => void) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
    this.onVisible =
      deps.onVisible ??
      ((fn): (() => void) => {
        document.addEventListener('visibilitychange', fn);
        return () => document.removeEventListener('visibilitychange', fn);
      });
  }

  /**
   * 書込が 1 件終わった。⚠ 数えるのは**ノートの内容を書く op**(`StoreProxyHost` の
   * `MUTATING_OPS`)だけ ── 呼ぶのはその 1 か所である。
   */
  noteWrite(): void {
    if (this.disposed) return;
    this.lastWriteAt = this.now();
    this.writesSince += 1;
    if (this.running) return;
    // ⚠ 溜まりきるまでは見直さない(書込のたびに時計を張り替えない)
    const plan = this.plan();
    if (plan.verdict === 'few-writes') return;
    this.arm(plan);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.unwatchVisible?.();
    this.unwatchVisible = null;
  }

  private plan(): AutoOptimizePlan {
    return planAutoOptimize({
      now: this.now(),
      lastWriteAt: this.lastWriteAt,
      lastOptimizeAt: this.lastOptimizeAt,
      writesSince: this.writesSince,
      hidden: this.hidden(),
      holdsWriterLease: this.deps.holdsWriterLease(),
    });
  }

  /**
   * 判断(`plan`)に従って、次に何を待つかを決める。
   * ⚠ `go` なら**列に載せて打つ**。待つ理由が時間なら時計を張り、隠れているなら戻りを待つ。
   */
  private arm(plan: AutoOptimizePlan): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    switch (plan.verdict) {
      case 'go':
      case 'busy':
      case 'too-soon': {
        // `go` でも**「落ち着いてから」**を満たした時点の判断なので、すぐ列に載せる
        // (`busy` / `too-soon` は残りの時間が過ぎてから見直す)
        const ms = plan.verdict === 'go' ? 0 : Math.max(0, plan.retryInMs ?? 0);
        this.cancelTimer = this.schedule(() => {
          this.cancelTimer = null;
          this.attempt();
        }, ms);
        return;
      }
      case 'hidden': {
        if (this.unwatchVisible !== null) return;
        this.unwatchVisible = this.onVisible(() => {
          if (this.hidden()) return;
          this.unwatchVisible?.();
          this.unwatchVisible = null;
          this.attempt();
        });
        return;
      }
      case 'few-writes':
      case 'not-writer':
        // 次の書込(または昇格後の書込)で数え直す
        return;
    }
  }

  /** 見直す。`go` なら列に載せ、そうでなければ次を待つ。 */
  private attempt(): void {
    if (this.disposed || this.running) return;
    const plan = this.plan();
    if (plan.verdict !== 'go') {
      this.arm(plan);
      return;
    }
    this.running = true;
    void this.deps
      .run(async () => {
        // 🔴 列の中で**もう 1 度**見る ── 待っている間に着地した書込があれば「落ち着いた」は崩れている
        const inside = this.plan();
        if (inside.verdict !== 'go') return inside;
        this.lastOptimizeAt = this.now();
        this.writesSince = 0;
        try {
          const r = await this.deps.optimize();
          this.lastFailed = false;
          this.deps.post({
            kind: 'job',
            source: AUTO_OPTIMIZE_SOURCE,
            text: optimizeDoneText(r.elapsedMs, r.after.freeBytes),
          });
        } catch {
          // 🔴 同じ失敗は連続で積まない(成功したら数え直す)
          if (!this.lastFailed) {
            this.deps.post({ kind: 'job', source: AUTO_OPTIMIZE_SOURCE, text: OPTIMIZE_FAILED_TEXT });
          }
          this.lastFailed = true;
        }
        return null;
      })
      .then(
        (skipped) => {
          this.running = false;
          if (skipped !== null) this.arm(skipped);
        },
        () => {
          // 列そのものが落ちた(通常は起きない)── 止まらず、次の書込で数え直す
          this.running = false;
        },
      );
  }
}
