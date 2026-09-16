/**
 * 🔴 **空きが尽きる前に言う**(#971 段②)。
 *
 * ## ⚠ 直す前の正確な穴(2026-09-16 に測り直した)
 *
 * 🔴 **私は最初「`navigator.storage.estimate` を読む所が 0 件」と書いたが、誤りだった。**
 *   `main.ts` が読んで `storeAsset`(`attach.ts`)へ渡しており、**添付を置く直前に
 *   空きが足りなければ断る**門は既に在る(4 か所から通る)。
 *
 * 🔑 **本当に無かったのは 3 つ**である:
 *
 * | | 何が無かったか |
 * |---|---|
 * | ① | **早めの合図が無い** ── 在るのは「置く瞬間の拒否」だけで、**8 割まで来た**を誰も言わない |
 * | ② | **ノート本体(sqlite)は門の外** ── 断るのは添付(IDB)だけで、DB が育つのは素通り |
 * | ③ | 🔴 **ブラウザが言う数を、画面に 1 度も出していない** ── 「何が容量を使っているか」は**添付の合計だけ**を数え、しかも「ブラウザの数とは一致しない」と断ってある。つまり**本当の残りを知る道が無い** |
 *
 * ⚠ ②は**この file では直せない**(断る場所が別)。ここが引き受けるのは①と③で、
 *   **数を出して、早めに言う**ところまでである。
 *
 * ⚠ **pure module**。時計もブラウザも読まない ── 測った値を受け取って字にするだけ。
 */
import { humanBytes } from '../human-bytes';

/** ブラウザが言う使用量(どちらも欠けうる ── 欠けたら「分からない」と言う)。 */
export interface QuotaEstimate {
  readonly usage?: number;
  readonly quota?: number;
}

export type QuotaLevel = 'unknown' | 'ok' | 'warn' | 'alarm';

/**
 * 🔑 **2 段にする理由** ── 1 段だと「まだ平気」と「もう危ない」が同じ顔になる。
 * ⚠ 値は**控えめ**にしてある:添付 1 つで数百 MB 動くので、
 *   9 割で初めて言うのでは**言った時にはもう置けない**。
 */
export const QUOTA_WARN_RATIO = 0.8;
export const QUOTA_ALARM_RATIO = 0.92;

/**
 * どの段か。
 *
 * ⚠ **`quota` が 0 のときを `ok` にしない** ── 0 で割ると `Infinity` になり、
 *   **いちばん危ない環境が「余裕がある」と出る**(§1「無いときに何が返るか」)。
 */
export function quotaLevel(e: QuotaEstimate): QuotaLevel {
  const { usage, quota } = e;
  if (usage === undefined || quota === undefined || !Number.isFinite(usage) || !Number.isFinite(quota))
    return 'unknown';
  if (quota <= 0) return 'unknown';
  const r = usage / quota;
  if (r >= QUOTA_ALARM_RATIO) return 'alarm';
  if (r >= QUOTA_WARN_RATIO) return 'warn';
  return 'ok';
}

/**
 * 画面に出す 1 行。
 *
 * ⚠ **記法を書かない**(素のテキストとして出る面がある)。
 * 🔑 **数はいつも出す** ── 段が `ok` でも出す。出さないと user は
 *   「本当の残り」を知る道が無いままである(上の③)。
 * 🔑 **危ないときは次の一手を書く** ── 「残りわずかです」だけでは何もできない。
 */
export function quotaText(e: QuotaEstimate): string {
  const level = quotaLevel(e);
  if (level === 'unknown') {
    return 'この端末では、ブラウザが言う使用量を読めませんでした。';
  }
  const usage = e.usage as number;
  const quota = e.quota as number;
  const pct = Math.round((usage / quota) * 100);
  const head = `ブラウザが数えている使用量は ${humanBytes(usage)} / ${humanBytes(quota)}(${pct} パーセント)です。`;
  if (level === 'alarm') {
    return (
      `${head} 空きがほとんどありません。これ以上増えると保存に失敗して、` +
      '中身が壊れることがあります。使っていない添付を消すか、バックアップを取ってから減らしてください。'
    );
  }
  if (level === 'warn') {
    return `${head} 空きが少なくなってきました。重いノートから片づけておくと安全です。`;
  }
  return head;
}

/**
 * 🔴 **起動のときに黙って出す 1 行**(出さないなら空)。
 *
 * ⚠ **`ok` と `unknown` では黙る** ── 毎回の起動で何か言うと、
 *   本当に危ない日の 1 行が**同じ顔に埋もれる**。
 */
export function quotaBootNotice(e: QuotaEstimate): string {
  const level = quotaLevel(e);
  return level === 'alarm' || level === 'warn' ? quotaText(e) : '';
}
