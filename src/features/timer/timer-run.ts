/**
 * 🔴 **タイマー ── 走っている計測そのもの**(#279。user 指示 2026-08-19
 * 「…連絡先、**タイマー**、アラートは組み込みアプリでリリースしたい」)。
 *
 * ## 🔑 PKC に持つ理由は「ノートへ書き戻す」ことである
 *
 * ただの砂時計なら OS のもので足りる(#279 がそう書いている)。ここが持つのは
 * **どのノートを、いつからいつまで触っていたか**で、止めた瞬間にその 1 行が
 * **本文へ入る**(正本は本文 ── #292 の裁定)。
 *
 * ## ⚠ 背面のタブでも狂わない ── **刻みを数えない**
 *
 * ブラウザは背面のタブで `setInterval` を 1 分に 1 回まで間引く。だから
 * **経過は数えず、毎回 `いま − 始めた時刻` を引く**(#279 の ⚠)。
 * 🔑 この module が受け取るのは **`nowMs`(呼び側が読んだ時刻)**だけで、
 *   自分では時計を読まない ── そうしておくと「1 時間の計測」を**実時間 1 時間
 *   待たずに** test できる。
 *
 * ⚠ **pure module**。browser API を使わない。
 */
import { elapsedText } from '../elapsed-text';

export interface TimerRun {
  /**
   * 計っている相手のノート。⚠ **これが鍵である**(別に id を持たない)──
   *   同じノートを 2 本同時に計るのは**断る**ので、lid で一意に決まる。
   * 🔑 断る理由は「二重に数えない」ためである ── 2 本走っていると、
   *   止めた回数だけ本文に行が増えて、合計が実際の倍になる。
   */
  readonly lid: string;
  /**
   * 帯に出す名前。⚠ **始めた時の題名を持つ** ── 走っている間に改名されても
   *   帯の字が入れ替わらない(「さっきまで見ていたものが変わる」を作らない)。
   */
  readonly title: string;
  /** 始めた時刻(epoch ms)。⚠ 経過はここからの差分で出す。 */
  readonly startedAtMs: number;
}

/** 帯の 1 本ぶん(`会議メモ 12:34`)。 */
export function timerEntryText(run: TimerRun, nowMs: number): string {
  return `${run.title} ${elapsedText(nowMs - run.startedAtMs)}`;
}

/**
 * 帯の見出し。⚠ **本数を出す** ── 1 本しか出ていないのか、
 * 3 本走っていて 1 本ぶんしか見えていないのかが読めないと、消し忘れる。
 */
export function timerBarLabel(count: number): string {
  return count === 1 ? '計っています' : `${count} 本 計っています`;
}

/**
 * 🔴 **止めたときに本文へ入る 1 行**。
 *
 * `- 作業 2026-08-27 06:40–07:03(23:11)`
 *
 * ⚠ **経過は帯と同じ綴り**(`elapsedText`)── 帯で `23:11` と見ていたものが
 *   本文で `23 分` になると、user は同じ量だと思えない(#454 と同じ型)。
 * ⚠ **丸めない** ── 作業時間は足し合わせる物なので、`1 分未満` のような
 *   潰し方をすると 30 秒の計測が 2 本あっても合計が出せない。
 * ⚠ 日付は**始めた日**を書く(日をまたいだら終わりの側に日付を足す)。
 */
export function workLogText(from: Date, to: Date): string {
  const d = (x: Date): string =>
    `${x.getFullYear()}-${two(x.getMonth() + 1)}-${two(x.getDate())}`;
  const t = (x: Date): string => `${two(x.getHours())}:${two(x.getMinutes())}`;
  const sameDay = d(from) === d(to);
  const end = sameDay ? t(to) : `${d(to)} ${t(to)}`;
  return `作業 ${d(from)} ${t(from)}–${end}(${elapsedText(to.getTime() - from.getTime())})`;
}

/**
 * 本文へ入れる形(箇条書きの 1 行)。
 * 🔑 **字は `workLogText` の 1 本**(印を付けるだけ)── 知らせの行にも同じ字を
 *   出すので、2 通りに割れると「別の量を見ている」と読まれる。
 */
export function workLogLine(from: Date, to: Date): string {
  return `- ${workLogText(from, to)}`;
}

const two = (n: number): string => String(n).padStart(2, '0');
