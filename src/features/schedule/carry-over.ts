/**
 * 🔴 **前の日の未完了を引き継ぐ**(#1966 4-4。user 裁定 2026-11-16「写して前の日から外す」)。
 *
 * 日付が題名のノート(`2026-11-16`)を開いているとき、いちばん近い前の日付のノートの**未完了のチェック項目**を
 * 今日のノートの末尾へ写し、前の日のノートの側は**引き継いだ印**に変える(同じ未完了が 2 日に残らない)。
 *
 * ## 前の日の行をどう変えるか
 * `- [ ] 見積を送る @2026-11-15` → `- ~~見積を送る @2026-11-15~~ → [2026-11-16](entry:<今日の lid>)`
 * - チェック項目ではなくなる(未完了の数・予定表の札から外れる ── 札はチェック項目の行からだけ作る)
 * - 取り消し線で「済ませたのではなく、送った」と読め、行き先へのリンクで辿れる(片道にしない)
 * - ⚠ 字(日付 `@…` を含む)は 1 字も消さない。消すのではなく包む
 *
 * ## 今日のノートへ足す形
 * 末尾に空行を挟んで `前の日から引き継ぎ: [2026-11-15](entry:<前の日の lid>)` の 1 行と、
 * `- [ ] <中身>` の行を並べる。⚠ 前置き(引用 `>`・字下げ・番号)は落として素のチェック項目にする
 * (前の日の入れ子の深さを今日へ持ち込むと、今日の本文の構造の中で意味が変わる)。
 *
 * ## 拾う行
 * 読み方は `listTaskItems`(チェック項目の正本 1 本 ── 隠しメモ・コード・数式の中は読まない)。中身が空の行は送らない。
 *
 * 🔑 pure module。書込は worker の `carryOverTasks`(2 冊の書換を 1 tx に閉じ込める)が持つ。
 */
import { formatMarkdownLink } from '../markdown/link-format';
import { TASK_LINE } from '../markdown/task-line';
import { listTaskItems } from '../markdown/task-count';

/** 今日のノートへ足す見出しの行の頭(画面の字)。 */
export const CARRY_OVER_LEAD = '前の日から引き継ぎ: ';

export interface CarryOverInput {
  /** 前の日のノート。 */
  readonly from: { readonly lid: string; readonly title: string; readonly body: string };
  /** 今日(開いている日付)のノート。 */
  readonly to: { readonly lid: string; readonly title: string; readonly body: string };
}

export interface CarryOverResult {
  readonly fromBody: string;
  readonly toBody: string;
  /** 写した項目の数(0 なら 2 冊とも入力のまま)。 */
  readonly count: number;
}

export function carryOverTasks(input: CarryOverInput): CarryOverResult {
  const { from, to } = input;
  const open = listTaskItems(from.body).filter((t) => !t.done);
  if (open.length === 0) return { fromBody: from.body, toBody: to.body, count: 0 };
  const lines = from.body.split('\n');
  const moved: string[] = [];
  const toLink = formatMarkdownLink(to.title, `entry:${to.lid}`);
  for (const t of open) {
    const raw = lines[t.line];
    if (raw === undefined) continue;
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr === '' ? raw : raw.slice(0, -1);
    const m = TASK_LINE.exec(line);
    if (m === null) continue;
    const rest = line.slice(m[0].length).trim();
    // 中身が空のチェック(`- [ ]` だけ)は送らない
    if (rest === '') continue;
    lines[t.line] = `${m[1]}~~${rest}~~ → ${toLink}${cr}`;
    moved.push(`- [ ] ${rest}`);
  }
  if (moved.length === 0) return { fromBody: from.body, toBody: to.body, count: 0 };
  const eol = to.body.includes('\r\n') ? '\r\n' : '\n';
  const head = `${CARRY_OVER_LEAD}${formatMarkdownLink(from.title, `entry:${from.lid}`)}`;
  const base = to.body.replace(/(?:\r?\n)+$/, '');
  const block = [head, ...moved].join(eol);
  const toBody = base === '' ? `${block}${eol}` : `${base}${eol}${eol}${block}${eol}`;
  return { fromBody: lines.join('\n'), toBody, count: moved.length };
}
