/**
 * 🔴 **計った時間の一覧 ── 本文に入った「作業」の行を読む・直す**(#683 ①。user 要望 2026-09-03
 * 「時間を測る・画面録画・録音も…組み込みアプリにしたい」)。
 *
 * ## 計った時間の正本は本文である
 *
 * タイマーを止めると、計っていたノートの本文へ 1 行入る(`timer-run.ts` の `workLogLine`):
 *
 * `- 作業 2026-08-27 06:40–07:03(23:11)`
 *
 * ⚠ **別に保存先を作らない**(`pkc3.timer-runs` は「計っている途中」の控えで、止めたら消える)。
 *   一覧は**本文の行を集めて映す**だけで、直す・消すも**本文の行を書き換える**(#292 の裁定:正本は本文)。
 *
 * ## 名前
 *
 * 行の終わりに名前を付けられる: `- 作業 2026-08-27 06:40–07:03(23:11) 見積の作成`。
 * ⚠ 名前が無い行(タイマーが入れたまま)も同じ行として読む ── 名前は付けても付けなくてもよい。
 *
 * ⚠ **pure module**(DOM も時計も持たない)。
 */
import { elapsedText } from '../elapsed-text';
import { splitLines } from '../markdown/source-blocks';
import { hiddenTaskMask } from '../markdown/task-hidden';

export interface WorkRun {
  readonly lid: string;
  /** 原文の行番号(0 始まり)。 */
  readonly line: number;
  /** 始めた日時 `YYYY-MM-DD HH:MM`。 */
  readonly from: string;
  /** 終わった日時 `YYYY-MM-DD HH:MM`(日をまたがなければ始めた日)。 */
  readonly to: string;
  /** 本文に書いてある経過(`23:11`)。⚠ 画面にはこの字をそのまま出す(帯と同じ綴り)。 */
  readonly span: string;
  /** 名前。無ければ空文字。 */
  readonly label: string;
  /** 行そのもの(書き換えるとき「押した時点の行」として添える)。 */
  readonly rawLine: string;
}

export interface WorkLogScan {
  readonly runs: readonly WorkRun[];
  /** 数えたノートの数(system 領域を除く)と、読んだノートの数。 */
  readonly totalNotes: number;
  readonly scannedNotes: number;
  /** 上限で切ったか。⚠ 切ったら面が必ず言う。 */
  readonly truncated: boolean;
}

/** 走査の上限。⚠ 超えたら `truncated`(黙って切らない)。 */
export const WORK_LOG_LIMITS = { notes: 5000, runs: 2000 } as const;

/** 名前の長さの上限(1 行に収める)。 */
export const WORK_LABEL_MAX = 80;

const LINE =
  /^(\s*[-*+]\s+)作業 (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})–(?:(\d{4}-\d{2}-\d{2}) )?(\d{2}:\d{2})\((\d+:\d{2}(?::\d{2})?)\)(?: (.*))?$/;

/** 本文の中の作業の行を全部読む。⚠ 隠しメモ・コード・数式の中の行は読まない(`hiddenTaskMask` は予定と共通)。 */
export function workRunsOf(lid: string, body: string): WorkRun[] {
  if (!body.includes('作業 ')) return [];
  const lines = splitLines(body);
  const hidden = hiddenTaskMask(lines);
  const out: WorkRun[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (hidden[i] === true) continue;
    const m = LINE.exec(raw);
    if (m === null) continue;
    out.push({
      lid,
      line: i,
      from: `${m[2]} ${m[3]}`,
      to: `${m[4] ?? m[2]} ${m[5]}`,
      span: m[6]!,
      label: (m[7] ?? '').trim(),
      rawLine: raw,
    });
  }
  return out;
}

/** 経過(`23:11` / `1:02:03`)を ms にする。読めなければ 0。 */
export function spanMs(span: string): number {
  const p = span.split(':').map(Number);
  if (p.some((n) => !Number.isFinite(n))) return 0;
  const [a = 0, b = 0, c] = p;
  return (c === undefined ? a * 60 + b : a * 3600 + b * 60 + c) * 1000;
}

/** 名前を付け替えた行。`label` が空なら名前を外す。⚠ 行頭の箇条書きの記号・字下げは保つ。 */
export function relabelWorkLine(rawLine: string, label: string): string | null {
  const m = LINE.exec(rawLine);
  if (m === null) return null;
  const name = label.replace(/\s+/g, ' ').trim().slice(0, WORK_LABEL_MAX);
  const head = rawLine.slice(0, rawLine.length - (m[7] === undefined ? 0 : m[7].length + 1));
  return name === '' ? head : `${head} ${name}`;
}

/** 日ごとに束ねる(新しい日が先、日の中は終わりの新しい順)と、その日の合計。 */
export interface WorkDay {
  readonly day: string;
  readonly runs: readonly WorkRun[];
  readonly totalMs: number;
}

export function groupWorkRuns(runs: readonly WorkRun[]): WorkDay[] {
  const days = new Map<string, WorkRun[]>();
  for (const r of runs) {
    const day = r.from.slice(0, 10);
    const list = days.get(day);
    if (list) list.push(r);
    else days.set(day, [r]);
  }
  return [...days]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([day, list]) => {
      const sorted = [...list].sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
      return { day, runs: sorted, totalMs: sorted.reduce((s, r) => s + spanMs(r.span), 0) };
    });
}

/** 合計の見せ方(帯・本文と同じ `elapsedText`)。 */
export function totalText(ms: number): string {
  return elapsedText(ms);
}

/** 探す欄の語で絞る(題名・名前・日付)。語は空白区切りで全部含む。 */
export function visibleWorkRuns(
  runs: readonly WorkRun[],
  query: string,
  titleOf: (lid: string) => string,
): WorkRun[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [...runs];
  return runs.filter((r) => {
    const hay = `${titleOf(r.lid)} ${r.label} ${r.from} ${r.to}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
