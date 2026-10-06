/**
 * 🔴 **索引の片づけを、いつ自動で打つか**(#999 段③。Gemini 裁定 A、2026-10-01)。
 *
 * ## 裁定(user ではなく Gemini の裁定である ── #999 のコメントに在る)
 *
 * 自動で打つのは **索引の片づけ(FTS5 の `optimize`)だけ**。VACUUM(file を縮める)は
 * **自動では打たない** ── 途中でタブが殺されると DB が開けなくなる(#1218)。
 * 🔑 **#1218 の原因は塞いだ**(F1。`xCheckReservedLock` の差し替え ──
 * `adapter/platform/storage/reserved-lock.ts` / 実測は
 * `docs/development/storage-reserved-lock-2026-10.md`)。それでも**ここで VACUUM を
 * 打ち始めない** ── 打つかどうかは**別の裁定**(「200 MiB 以下なら VACUUM も」を
 * 改めて聞く)で、塞いだ事実はその材料であって許可ではない。
 *
 * ## ここで決めること(⚠ pure module ── 時計もブラウザも読まない)
 *
 * 判断は `planAutoOptimize` の **1 か所**。呼び側(`adapter/platform/storage/auto-optimize.ts`)は
 * 時計・タブの見え方・lease・書込の回数を**渡すだけ**にする(§7「同じ問いに答える口を
 * 2 つ作らない」)。
 *
 * ## 数の根拠
 *
 * 段①の実測(`docs/development/storage-gauge-2026-10.md`)── 索引の片づけは 0.4 秒で、
 * file は縮まず**空きに変わる**(34.4 MiB の file で 4.4 → 11.6 MiB)。1,500 ノートで
 * 300 操作する間に file は +2.3 MiB。⚠ **これは初期値**(2026-10-02)で、実使用の太り方を
 * 見て動かす ── 動かすときは数だけ直す(判断の形は動かさない)。
 */

/** 最後の書込からこれだけ黙っていたら「落ち着いた」(ms)。 */
export const AUTO_OPTIMIZE_QUIET_MS = 60_000;

/** 前回の片づけからこれだけ空ける(ms)。⚠ 失敗した回も「前回」に数える(毎分やり直さない)。 */
export const AUTO_OPTIMIZE_MIN_INTERVAL_MS = 10 * 60_000;

/**
 * 前回からの書込がこれだけ溜まるまで打たない。
 * 2026-10-02 の初期値。段①の実測: 300 操作で +2.3 MiB(索引の段は 8 → 17)。
 */
export const AUTO_OPTIMIZE_MIN_WRITES = 50;

export type AutoOptimizeVerdict =
  /** 打ってよい。 */
  | 'go'
  /** この PKC の書込 lease を握っていない(別のタブが握っている)── 握るタブだけが打つ。 */
  | 'not-writer'
  /** タブが隠れている ── 戻ってきてから。 */
  | 'hidden'
  /** 前回から書込が少ない ── 次の書込で数え直す。 */
  | 'few-writes'
  /** 前回から日が浅い ── `retryInMs` 後に見直す。 */
  | 'too-soon'
  /** 最後の書込から 60 秒経っていない ── `retryInMs` 後に見直す。 */
  | 'busy';

export interface AutoOptimizeInput {
  /** いま(ms)。 */
  now: number;
  /** 最後に書込が終わった時刻(ms)。1 度も無ければ `null`。 */
  lastWriteAt: number | null;
  /** 前回打った(失敗した回も含む)時刻(ms)。⚠ 1 度も打っていなければ `null` = 間隔は要らない。 */
  lastOptimizeAt: number | null;
  /** 前回打ってからの書込の回数。 */
  writesSince: number;
  /** タブが隠れているか(`document.hidden`)。 */
  hidden: boolean;
  /** 書込の lease を握っているか。 */
  holdsWriterLease: boolean;
}

export interface AutoOptimizePlan {
  verdict: AutoOptimizeVerdict;
  /** `busy` / `too-soon` のとき、見直すまでの待ち(ms)。それ以外は `null`。 */
  retryInMs: number | null;
}

/**
 * 🔴 **いま打ってよいか**。
 *
 * 見る順番は「そもそも打てる立場か → 見えているか → 溜まったか → 空いたか → 落ち着いたか」。
 * ⚠ **先に落ちた理由だけを返す** ── 呼び側が「何を待てばよいか」を 1 つで読めるように。
 * 🔑 3 つの境界は**以上**で読む(50 回ちょうど / 10 分ちょうど / 60 秒ちょうどは打つ)。
 */
export function planAutoOptimize(i: AutoOptimizeInput): AutoOptimizePlan {
  if (!i.holdsWriterLease) return { verdict: 'not-writer', retryInMs: null };
  if (i.hidden) return { verdict: 'hidden', retryInMs: null };
  if (i.writesSince < AUTO_OPTIMIZE_MIN_WRITES) return { verdict: 'few-writes', retryInMs: null };
  if (i.lastOptimizeAt !== null) {
    const sinceLast = i.now - i.lastOptimizeAt;
    if (sinceLast < AUTO_OPTIMIZE_MIN_INTERVAL_MS) {
      return { verdict: 'too-soon', retryInMs: AUTO_OPTIMIZE_MIN_INTERVAL_MS - sinceLast };
    }
  }
  if (i.lastWriteAt !== null) {
    const quiet = i.now - i.lastWriteAt;
    if (quiet < AUTO_OPTIMIZE_QUIET_MS) {
      return { verdict: 'busy', retryInMs: AUTO_OPTIMIZE_QUIET_MS - quiet };
    }
  }
  return { verdict: 'go', retryInMs: null };
}

/**
 * 🔴 **処理の所要の字**(「0.4 秒」)。⚠ 0.05 秒未満は「0.0 秒」と書かず「0.1 秒未満」と書く
 * (掛かっていないように読めるため)。
 * 🔑 索引の片づけ(ここ)と保存領域を縮める(`vacuum.ts`)が**同じ 1 本**を使う。
 */
export function secondsText(elapsedMs: number): string {
  return elapsedMs < 50 ? '0.1 秒未満' : `${(elapsedMs / 1000).toFixed(1)} 秒`;
}

/**
 * 🔴 **処理の記録に積む字**(1 回の片づけにつき 1 件)。
 *
 * ⚠ 数字しか入れない(本文・題名は 1 つも入らない ── メッセージは中身を漏らさない)。
 * ⚠ 0.05 秒未満は「0.0 秒」と書かず「0.1 秒未満」と書く(掛かっていないように読めるため)。
 * 🔑 空きは**片づけた後の値**(「片づけて何が空いたか」= file は縮まない代わりに増える側)。
 */
export function optimizeDoneText(elapsedMs: number, freeBytesAfter: number): string {
  const secs = secondsText(elapsedMs);
  const mib = (freeBytesAfter / (1024 * 1024)).toFixed(1);
  return `索引を整理しました(${secs}、空き ${mib} MiB)`;
}

/** 失敗の字。⚠ 例外の字は入れない(中身が混じりうる)。次の一手は無い(自動なので待つだけ)。 */
export const OPTIMIZE_FAILED_TEXT = '索引を整理できませんでした(次の機会にやり直します)';
