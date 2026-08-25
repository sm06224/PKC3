/**
 * 🔴 **本文の構造化書換を 1 本にする**(#276 / #277)。
 *
 * ## なぜ 1 本にするか
 *
 * frontmatter の鍵を書く(カレンダーの日付 / todo の状態)のも、チェックの印を
 * 付け外しするのも、**「読む → 原文を splice → 書く」**という同じ手順である。
 * ⚠ 経路を分けると、直列 queue・唯一の抽出経路・未達 commit との合流という
 *   **書込の作法が 2 つに割れる**(CLAUDE.md §7)。実際 2026-08-19 の 1 日で
 *   同じ形の要求が 3 つ(状態 / 日付 / チェック)出た。
 *
 * 🔑 **pure module**。ここは「どう書き換えるか」だけを決め、いつ・誰が書くかは
 *   effect 層が持つ。⚠ 純関数なので unit で全部試せる。
 */
import { spliceFrontmatterKeys, type FrontmatterValue } from './frontmatter';
import { formatLineDate, insertionForLineDate, readLineDate } from '../schedule/line-date';
import { isScheduleDate } from '../schedule/schedule-date';
import type { RepeatUnit } from '../schedule/repeat';
import { removeInsertedLines } from './append-target';

/** 何をするか。⚠ **やり直せる形で持つ**(未達 commit との合流に要る)。 */
export type BodyRewrite =
  | {
      /**
       * 🔴 **追記を取り消す**(#395 段①。user 指示 2026-08-23
       * 「**片道の操作を作らない**」)。
       *
       * ⚠ **行番号を持たない** ── 追記のあとに別の窓が上へ足していれば番号はずれる。
       *   持つのは**足した行そのもの**で、それが在る所だけを消す
       *   (`removeInsertedLines`)。
       * ⚠ 見つからなければ `applyBodyRewrite` が `null` を返す = **断る**
       *   ── 「取り消したつもりで別の行が消えた」を作らない。
       */
      kind: 'undo-append';
      lines: readonly string[];
    }
  | {
      kind: 'frontmatter';
      /** ⚠ `undefined` はその鍵を**消す**(`spliceFrontmatterKeys` の作法)。 */
      keys: Record<string, FrontmatterValue | undefined>;
    }
  | {
      /** チェックの印を反転する。`line` は**原文の行番号**(0 始まり)。 */
      kind: 'task';
      line: number;
    }
  | {
      /**
       * 🔴 **その行の日付を書き換える**(user 指示 2026-08-23「**なんで双方向に
       * する発想がでねぇんだよ**」)。
       *
       * ⚠ 1 稿目の設計は「予定は本文に書く。**面はそれを映すだけ**」だったが、
       *   **面から書けなくする理由がどこにも無かった** ── しかも同じ面の
       *   **チェックの印は既に本文へ書いている**(`kind: 'task'`)。
       *   日付だけ読み取り専用にする理屈は無い。
       * 🔑 正本が本文であるとは「**面が別のデータを持たない**」ということであって、
       *   「面が書かない」ということではない。
       *
       * ⚠ `date: null` は**日付を外す**(「日付なし」へ落とす)。
       */
      kind: 'line-date';
      line: number;
      date: string | null;
      /** ⚠ `date` が `null` なら無視される。⚠ `until` が在るときも無視される(期間に時刻は無い)。 */
      time?: string | null;
      /**
       * 🔴 **期間の終わり**(#344 段①)。単日にするなら渡さないか `null`。
       * ⚠ `date` が `null`(= 日付を外す)なら無視される。
       */
      until?: string | null;
      /**
       * 🔴 **刻み**(#344 段②)。⚠ **渡さなければ元の刻みを保つ** ── 日付だけ
       *   動かしたつもりで `毎週` が黙って消えたら、それは user が頼んでいない変更である。
       *   はっきり `null` を渡したときだけ外す。
       */
      repeat?: RepeatUnit | null;
    }
  | {
      /**
       * 🔴 **繰り返しの「その回」を、本文の実体の行にする**(#344 段②)。
       *
       * ⚠ 規則の行(`- [ ] ゴミ出し @2026-08-31 毎週`)の印は**押さない** ──
       *   押すと「この繰り返しは終わり」の意味になり、**以後の回が全部消える**。
       * 🔑 代わりに**その日ぶんの行を 1 本増やす**(`- [x] ゴミ出し @2026-09-07`)。
       *   ⚠ こうすると例外日の記法が要らない ── 実体の行が在る日は、
       *   束ねる側が**その日を飛ばす**(`materializedDates`)。
       * ⚠ そして**外せる**:増えた行は普通のチェック項目なので、
       *   もう一度押せば印が外れる(片道の操作を作らない ── user 指示 2026-08-23)。
       */
      kind: 'repeat-done';
      line: number;
      /** どの回か(`YYYY-MM-DD`)。⚠ 規則の行の日付ではない。 */
      date: string;
    };

/**
 * チェック項目の行かどうか。
 *
 * 🔑 **箇条書きの印 + `[ ]` / `[x]`** で見る(markdown-it の task 規則と同じ形)。
 * ⚠ 行番号は**描いた時の原文**のものなので、書き換わっていれば当たらない ──
 *   だから「当たらなかったら `null`」で返し、**当てずっぽうで別の行を書き換えない**。
 *
 * 🔴 **引用(`>`)の前置きも受ける**(2026-08-19 のレビューで判明した穴)。
 *
 * ⚠ 直す前は前置きを見ておらず、**`> - [ ] やること` は札に出るのに押しても
 *   書き換わらなかった** ── 数える側(`task-count.ts` の `QUOTE`)は引用を剥がして
 *   から判定するのに、書き換える側だけが剥がしていなかった(§7「同じ判定が 2 か所」)。
 * ⚠ 症状は**いちばん質が悪い形**だった:ブラウザが印を付ける → 本文は変わらない →
 *   帯に「本文が変わっているため反映できませんでした(開き直してください)」という
 *   **嘘の理由**が出る → 開き直しても永久に直らない。
 *   `markdown-render.ts` が明文で禁じている「押せるのに本文が変わらない」そのもの。
 * 🔑 前置きは `m[1]` にまとめて入るので、印の位置(`m[1].length + 1`)は自然に追従する。
 *   parity は `tests/features/task-count.test.ts`「札に出た行は必ず書き換えられる」が守る。
 */
const TASK_LINE = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](\s|$)/;

/**
 * 書き換える。⚠ **できなければ `null`**(呼び側が「何も起きなかった」を
 * user に言えるようにする ── 黙って別の行を書き換えない)。
 */
export function applyBodyRewrite(body: string, rewrite: BodyRewrite): string | null {
  if (rewrite.kind === 'frontmatter') {
    const next = spliceFrontmatterKeys(body, rewrite.keys);
    return next === body ? null : next;
  }
  if (rewrite.kind === 'line-date') return rewriteLineDate(body, rewrite);
  if (rewrite.kind === 'undo-append') return removeInsertedLines(body, rewrite.lines);
  if (rewrite.kind === 'repeat-done') return materializeRepeat(body, rewrite);
  const lines = body.split('\n');
  const line = lines[rewrite.line];
  if (line === undefined) return null;
  const m = TASK_LINE.exec(line);
  if (m === null) return null;
  const checked = m[2]!.toLowerCase() === 'x';
  /**
   * ⚠ **書き換えるのは印の 1 文字だけ** ── 行を組み直すと、
   *   `-   [ ]  やること` のような空白の入れ方が勝手に整形される
   *   (本文を byte 無傷で戻す規律)。
   */
  const at = m[1]!.length + 1; // `[` の次
  lines[rewrite.line] = line.slice(0, at) + (checked ? ' ' : 'x') + line.slice(at + 1);
  return lines.join('\n');
}

/**
 * 🔴 **1 行の日付を書き換える**(面から予定を動かす ── 双方向の実体)。
 *
 * ⚠ **チェック項目の行だけ**を書き換える。散文の行に日付を挿さない ──
 *   盤面に出ているのはチェック項目だけなので、それ以外の行を触る道が無い。
 *   ⚠ そして行番号は**描いた時**のものなので、ずれていたら `null` を返して
 *   **当てずっぽうで別の行を書き換えない**(`kind: 'task'` と同じ作法)。
 *
 * ⚠ **原文を splice する**(行を組み直さない)── 組み直すと
 *   `-   [ ]  やること` のような空白の入れ方が勝手に整形される。
 */
function rewriteLineDate(
  body: string,
  rewrite: {
    line: number;
    date: string | null;
    time?: string | null;
    until?: string | null;
    repeat?: RepeatUnit | null;
  },
): string | null {
  const lines = body.split('\n');
  const line = lines[rewrite.line];
  if (line === undefined) return null;
  if (!TASK_LINE.test(line)) return null;
  const found = readLineDate(line);
  let next: string;
  if (rewrite.date === null) {
    // 日付を外す。⚠ 元から無ければ**何も起きていない**
    if (found === null) return null;
    const before = line.slice(0, found.start);
    const after = line.slice(found.end);
    /**
     * ⚠ **区切りに置いた空白 1 つだけを戻す。**
     * 🔑 両側が空白のときだけ 1 つ落とす ── 落とさないと空白が 2 つ空き、
     *   落としすぎると `- [ ]` の印と中身がくっつく(**行の意味が変わる**)。
     */
    next =
      /[ \t]$/.test(before) && (after === '' || /^[ \t]/.test(after))
        ? before.slice(0, -1) + after
        : before + after;
  } else if (found === null) {
    // 日付を付ける。⚠ 区切りの空白は `insertionForLineDate` 1 か所が決める(§7)
    next =
      line +
      insertionForLineDate(line, rewrite.date, rewrite.time, rewrite.until, rewrite.repeat);
  } else {
    // 日付を差し替える。⚠ **記法の範囲だけ**を入れ替える(前後の字は 1 バイトも動かさない)
    next =
      line.slice(0, found.start) +
      formatLineDate(
        rewrite.date,
        rewrite.time,
        rewrite.until,
        // 🔴 **渡されていなければ元の刻みを保つ**(#344 段②)── 日を動かしただけで
        //    `毎週` が消えたら、user は「勝手に消された」と読む(時刻と同じ向き)
        rewrite.repeat === undefined ? found.repeat : rewrite.repeat,
      ) +
      line.slice(found.end);
  }
  if (next === line) return null;
  lines[rewrite.line] = next;
  return lines.join('\n');
}

/**
 * 🔴 **繰り返しの「その回」を実体の行にする**(#344 段②)。
 *
 * ⚠ 増やした行は**規則の行のすぐ下**に入れる ── 2 つの理由がある:
 *   ① 規則と記録が並ぶので、本文だけ読んでも意味が取れる
 *   ② 🔑 **規則の行の行番号が動かない** ── 動くと、画面に出ている他の札の
 *     行番号がずれ、次に押した 1 手が**別の行を書き換える**(いちばん静かな破壊)。
 * ⚠ だから並びは**新しい回が上**になる。時系列は日付の字で読める。
 */
function materializeRepeat(
  body: string,
  rewrite: { line: number; date: string },
): string | null {
  const lines = body.split('\n');
  const line = lines[rewrite.line];
  if (line === undefined) return null;
  const m = TASK_LINE.exec(line);
  if (m === null) return null;
  const found = readLineDate(line);
  // ⚠ 繰り返しの行でなければ**何もしない** ── 普通の項目は `kind: 'task'` の仕事
  if (found === null || found.repeat === null) return null;
  // ⚠ 読めない日は書かない(当てずっぽうの日付を本文へ残さない)
  if (!isScheduleDate(rewrite.date)) return null;
  /**
   * ⚠ 記法だけ**その日の単日**へ差し替える(刻みは落とす ── 実体の行が
   *   また繰り返したら、回が無限に増える)。⚠ 時刻は**持ち越す**
   *   (`14:00 毎週` の回は 14:00 の予定である)。
   */
  const swapped =
    line.slice(0, found.start) +
    formatLineDate(rewrite.date, found.time, null, null) +
    line.slice(found.end);
  /**
   * ⚠ 印の位置は**元の行**で数えてよい ── 記法は必ず `[ ]` より後ろに在るので、
   *   差し替えても前置きの長さは 1 バイトも動かない。
   */
  const at = m[1]!.length + 1; // `[` の次
  const done = swapped.slice(0, at) + 'x' + swapped.slice(at + 1);
  /**
   * 🔴 **同じ行が既に在るなら増やさない**(押しっぱなし / 二度押しの相打ち)。
   * ⚠ 判定は**作った字そのもの**で見る ── 二度押しは同じ規則の行から
   *   同じ日を作るので、生まれる字は 1 バイトまで同じである(だから当たる)。
   */
  if (lines.includes(done)) return null;
  lines.splice(rewrite.line + 1, 0, done);
  return lines.join('\n');
}

/** その行がチェック項目か(呼び側の事前判定用)。 */
export function isTaskLine(body: string, line: number): boolean {
  return TASK_LINE.test(body.split('\n')[line] ?? '');
}
