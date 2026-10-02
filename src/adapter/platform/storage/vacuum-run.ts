/**
 * 🔴 **保存領域を縮める 1 回を、押された順に走らせる**(#999。Gemini 裁定 A)。
 *
 * ## 何をするか
 *
 * - **測る**(`refresh`): `storageGauge` とブラウザの空きを読み、押す前に出す字と
 *   押せるかを組む(判断は `features/storage/vacuum.ts` の 1 か所。⚠ ここに数を書かない)。
 * - **縮める**(`run`): 押された時点で**もう 1 度測り直して**から、書込の列に載せて
 *   worker の `vacuum` を 1 回打つ。終わったら処理の記録(メッセージの種類「処理」)へ 1 件積む。
 *
 * ## 守っていること
 *
 * - 🔴 **自動では打たない**。`run` を呼ぶのは**押し口(`storage-vacuum`)だけ**である
 *   (自動の係 `AutoOptimizer` はこの file を import しない ── 原文 pin が見張る)。
 * - 🔴 **書込と並走させない**。`run`(= effect 層の書込の列に載せる口)の**中で**測り直して打つ ──
 *   押してから列に載るまでの間に書込が入って状況が変わっても、**打つ直前の値**で判断する。
 * - 🔴 **書込の lease を握るタブだけが打つ**。握っていないタブから打つと、中継の待ち時間
 *   (10 秒)を超えて「失敗」と出るのに、worker は最後まで縮め続ける(実測の所要は
 *   1 GiB で 13〜18 秒)。
 * - 🔴 **2 度押しは断る**(動いている間は押せない字にし、それでも来たら理由を言う)。
 * - 🔴 **失敗しても列を詰まらせない**。理由は字で言い換える(例外の字をそのまま出さない)。
 * - 🔴 **測れなかったときは押せない側へ倒す**(測れない = 何も言えない)。
 *   ⚠ 空きが**読めない端末**は押せる(`quotaRoom` が `null` ── 増やす書き込みの門と同じ向き)。
 */
import type { QuotaSample } from '@features/storage/write-quota';
import {
  VACUUM_SOURCE,
  vacuumBlock,
  vacuumDoneText,
  vacuumEstimateText,
  vacuumFailedText,
  type VacuumGauge,
} from '@features/storage/vacuum';
import type { VacuumResult } from './protocol';

export interface VacuumDeps {
  /** 書込の lease を握っているか(`main.ts` の `writerHolder`)。 */
  holdsWriterLease(): boolean;
  /** 書込の列に載せて走らせる(`StoreEffects.run`)。 */
  run<T>(job: () => Promise<T>): Promise<T>;
  /** worker の `storageGauge`(読むだけ)。 */
  gauge(): Promise<VacuumGauge>;
  /** ブラウザが言う使用量(読めない端末は `{}`)。 */
  quota(): Promise<QuotaSample>;
  /** worker の `vacuum` を 1 回打つ。 */
  vacuum(): Promise<VacuumResult>;
  /** 処理の記録へ積む(`appMessagePost.post`)。 */
  post(input: { kind: 'job'; source: string; text: string }): void;
  /** いま(ms)。既定は `Date.now`。 */
  now?: () => number;
}

/** 押す前に出す表示(画面はこれを映すだけ)。 */
export interface VacuumView {
  /** 押す前に出す字(見込み / 押せない理由 / 動作中の案内)。 */
  readonly text: string;
  /** 「縮める」を押せるか。 */
  readonly canRun: boolean;
  /** 縮めている最中か。 */
  readonly busy: boolean;
}

export type VacuumRunResult =
  | { kind: 'done'; text: string }
  | { kind: 'failed'; text: string }
  /** 打つ前に断った(空き不足 / 縮める分なし / 別のタブが担当 / 動作中 / 配線なし)。 */
  | { kind: 'refused'; text: string };

/** 測り直す最短の間隔(ms)。⚠ 設定を開いている間、状態が動くたびに測らない。 */
export const VACUUM_REFRESH_MIN_MS = 30_000;

const TEXT_UNATTACHED = 'この環境では縮められません';
const TEXT_MEASURING = '保存領域の大きさを調べています…';
const TEXT_UNMEASURED = '保存領域の大きさを測れませんでした';
const TEXT_RUNNING = '縮めています…(終わるまで保存できません。閉じずにお待ちください)';
const TEXT_NOT_WRITER =
  'このタブは保存を担当していないので縮められません(保存を担当しているタブで押してください)';

export class StorageVacuum {
  private deps: VacuumDeps | null = null;
  private gauge: VacuumGauge | null = null;
  private quota: QuotaSample = {};
  private measured = false;
  private measuring = false;
  private measuredAt: number | null = null;
  private running = false;
  private readonly listeners = new Set<() => void>();

  /** 配線を渡す(`main.ts` が boot で 1 度)。⚠ 可搬の単一 HTML では渡さない。 */
  attach(deps: VacuumDeps): void {
    this.deps = deps;
    this.gauge = null;
    this.measured = false;
    this.measuredAt = null;
    this.notify();
  }

  /** 画面が映す表示を返す。 */
  view(): VacuumView {
    const d = this.deps;
    if (d === null) return { text: TEXT_UNATTACHED, canRun: false, busy: false };
    if (this.running) return { text: TEXT_RUNNING, canRun: false, busy: true };
    // 🔑 まだ 1 度も測り終えていない間は「調べています」(測れなかったとは言わない)
    if (!this.measured) return { text: TEXT_MEASURING, canRun: false, busy: false };
    if (this.gauge === null) return { text: TEXT_UNMEASURED, canRun: false, busy: false };
    const text = vacuumEstimateText(this.gauge, this.quota);
    if (vacuumBlock(this.gauge, this.quota) !== null) return { text, canRun: false, busy: false };
    // 🔑 押せる大きさでも、担当でないタブには押させない(理由を言う)
    if (!d.holdsWriterLease()) return { text: TEXT_NOT_WRITER, canRun: false, busy: false };
    return { text, canRun: true, busy: false };
  }

  /** 表示が変わったら呼ぶ(戻り値は購読を解く関数)。 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * 測り直す。⚠ 動いている間と、前回から `VACUUM_REFRESH_MIN_MS` 以内は何もしない
   * (`force` で間隔だけ無視できる ── 縮めた直後の読み直し)。
   */
  refresh(force = false): void {
    const d = this.deps;
    if (d === null || this.running || this.measuring) return;
    const now = (d.now ?? ((): number => Date.now()))();
    if (!force && this.measuredAt !== null && now - this.measuredAt < VACUUM_REFRESH_MIN_MS) return;
    this.measuring = true;
    this.notify();
    void this.measure(d).then(
      (m) => {
        this.measuring = false;
        this.measuredAt = now;
        this.measured = true;
        this.gauge = m.gauge;
        this.quota = m.quota;
        this.notify();
      },
      () => {
        // ⚠ 測れなかった = 押せない側(古い値を残さない)。間隔を置いてやり直す
        this.measuring = false;
        this.measured = true;
        this.gauge = null;
        this.measuredAt = now;
        this.notify();
      },
    );
  }

  /**
   * 縮める。⚠ 呼ぶのは**押し口だけ**(自動では打たない)。
   * 返す字は呼び側が画面の知らせへ出す(処理の記録への積みはここで済ませる)。
   */
  async run(): Promise<VacuumRunResult> {
    const d = this.deps;
    if (d === null) return { kind: 'refused', text: TEXT_UNATTACHED };
    if (this.running) {
      return { kind: 'refused', text: 'いま縮めています(終わるまでお待ちください)' };
    }
    if (!d.holdsWriterLease()) return { kind: 'refused', text: TEXT_NOT_WRITER };
    this.running = true;
    this.notify();
    try {
      const outcome = await d.run(async (): Promise<VacuumRunResult | VacuumResult> => {
        // 🔴 列の中で**もう 1 度測る** ── 押してから列に載るまでの間に書込が入って、
        //    大きさも空きも変わっていることがある(打つ直前の値で判断する)
        const [gauge, quota] = await Promise.all([d.gauge(), d.quota().catch((): QuotaSample => ({}))]);
        if (vacuumBlock(gauge, quota) !== null) {
          return { kind: 'refused', text: vacuumEstimateText(gauge, quota) };
        }
        return d.vacuum();
      });
      if ('kind' in outcome) return outcome;
      const text = vacuumDoneText(outcome.before.fileBytes, outcome.after.fileBytes, outcome.elapsedMs);
      d.post({ kind: 'job', source: VACUUM_SOURCE, text });
      return { kind: 'done', text };
    } catch (e) {
      const text = vacuumFailedText(String(e));
      d.post({ kind: 'job', source: VACUUM_SOURCE, text });
      return { kind: 'failed', text };
    } finally {
      this.running = false;
      this.notify();
      // 🔑 縮めた直後の姿を映す(縮んだ後は「縮める分がありません」になる)
      this.refresh(true);
    }
  }

  private async measure(d: VacuumDeps): Promise<{ gauge: VacuumGauge; quota: QuotaSample }> {
    const [gauge, quota] = await Promise.all([d.gauge(), d.quota().catch((): QuotaSample => ({}))]);
    return { gauge, quota };
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

/** アプリで 1 つ。⚠ test は自分で `new` して渡す。 */
export const appStorageVacuum = new StorageVacuum();
