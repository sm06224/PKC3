/**
 * 🔴 **行の複製・行の削除・見出しの段の巡回**(#2001 段 3、ギャップ #8 / #9 / #10)。
 *
 * ## user がやりたいこと
 * 本文の欄で、カーソルの行(複数行を選んでいれば**選んだ行の塊**)を、
 * ① 上 / 下へ**複製**する(`Alt+Shift+↑` / `Alt+Shift+↓`)② **削除**する(`Alt+Shift+K`)
 * ③ 見出しの段を**ひと押しずつ**変える(なし → # → ## → … → ######  → なし。操作を探すから)。
 *
 * ## 決めたこと
 * - 行は `\n` で割る(textarea の `value` は改行が `\n` に正規化されるので、CRLF は欄の中に現れない。
 *   万一 `\r` が行末に残っていても行の中身として一緒に複製・削除する)。
 * - 選択の終わりが**行頭**(下の行の頭まで選んだ)なら、その行は含めない(`line-swap.ts` / `indentLines` と同じ)。
 * - 複製は**複製した側へ選択が付いていく**(続けて押せる)。上への複製は元の位置(= 上の写し)に残る。
 * - 削除は選んだ行の塊と**その改行 1 つ**を消す。末尾の行を消したら直前の改行を消す(行が 1 つ減る)。
 *   caret は元の桁を保ち、そこに来た行の長さで切る(連続して消せる)。空の本文では `null`(何も起きない)。
 * - 見出しの段は、選んだ行の**最初の空でない行**の段から次を決め、空でない全行へそろえて当てる。
 *
 * 🔑 **pure module**。書き込みは呼び側が `insertText`(取り消しの履歴を切らない)で `from`〜`to` を `insert` へ置き換える。
 */
import { lineStart } from './line-start';
import type { SwapEdit } from './line-swap';
import type { TextSelection } from './text-ops';

/** 選択が触れている行の範囲(行頭〜行末)。下の行の頭で終わる選択はその行を含めない。 */
function lineSpan(text: string, start: number, end: number): [number, number] {
  const from = lineStart(text, start);
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nl = text.indexOf('\n', last);
  return [from, nl === -1 ? text.length : nl];
}

/**
 * 選んでいる行を、上(`dir` = -1)/ 下(`dir` = 1)へ複製する。
 * ⚠ 常に何か書く(`null` を返さない)。
 */
export function duplicateLines(sel: TextSelection, dir: 1 | -1): SwapEdit {
  const { text } = sel;
  const [from, to] = lineSpan(text, sel.start, sel.end);
  const block = text.slice(from, to);
  if (dir === 1) {
    const insert = `\n${block}`;
    const shift = block.length + 1;
    return {
      text: text.slice(0, to) + insert + text.slice(to),
      start: sel.start + shift,
      end: sel.end + shift,
      from: to,
      to,
      insert,
    };
  }
  const insert = `${block}\n`;
  return {
    text: text.slice(0, from) + insert + text.slice(from),
    start: sel.start,
    end: sel.end,
    from,
    to: from,
    insert,
  };
}

/**
 * 選んでいる行を削除する。
 * @returns 本文が空で消す行が無いなら `null`(⚠ 呼び側は何も書かない。キーは握ってよい)
 */
export function deleteLines(sel: TextSelection): SwapEdit | null {
  const { text } = sel;
  if (text === '') return null;
  const [lineFrom, lineTo] = lineSpan(text, sel.start, sel.end);
  let from = lineFrom;
  let to = lineTo;
  if (lineTo < text.length) to = lineTo + 1;
  else if (lineFrom > 0) from = lineFrom - 1;
  const next = text.slice(0, from) + text.slice(to);
  const col = sel.start - lineStart(text, sel.start);
  // 消したあとの caret: 元の桁のまま、その位置に来た行(末尾を消したなら新しい最後の行)の長さで切る
  const at = Math.min(from, next.length);
  const headOfNow = lineStart(next, at);
  const nl = next.indexOf('\n', headOfNow);
  const lineLen = (nl === -1 ? next.length : nl) - headOfNow;
  const caret = headOfNow + Math.min(col, lineLen);
  return { text: next, start: caret, end: caret, from, to, insert: '' };
}

/** 見出しの記号(`#` を 1〜6 個 + 空白 / 行末)。 */
const HEADING_LEAD = /^(#{1,6})(?:[ \t]+|$)/;
/** 見出しの段の上限(Markdown の見出しは 6 段まで)。 */
export const HEADING_MAX_LEVEL = 6;

/** 行の見出しの段(0 = 見出しでない)。 */
export function headingLevelOf(line: string): number {
  const m = HEADING_LEAD.exec(line);
  return m === null ? 0 : m[1]!.length;
}

/**
 * 見出しの段をひとつ進める(なし → 1 → … → 6 → なし)。
 * 段は**最初の空でない行**で決め、空でない全行へ同じ段を当てる(空行は触らない。選んだのが空行だけならその行へ)。
 */
export function cycleHeading(sel: TextSelection): SwapEdit {
  const { text } = sel;
  const [from, to] = lineSpan(text, sel.start, sel.end);
  const lines = text.slice(from, to).split('\n');
  const skipBlank = lines.some((l) => l.trim() !== '');
  const first = lines.find((l) => l.trim() !== '') ?? lines[0]!;
  const next = (headingLevelOf(first) + 1) % (HEADING_MAX_LEVEL + 1);
  const mark = next === 0 ? '' : `${'#'.repeat(next)} `;
  const parts: Array<{ oldFrom: number; oldLead: number; newFrom: number; newLead: number; oldLen: number }> = [];
  let oldOff = from;
  let newOff = from;
  const out = lines.map((l) => {
    if (skipBlank && l.trim() === '') {
      parts.push({ oldFrom: oldOff, oldLead: 0, newFrom: newOff, newLead: 0, oldLen: l.length });
      oldOff += l.length + 1;
      newOff += l.length + 1;
      return l;
    }
    const m = HEADING_LEAD.exec(l);
    const lead = m === null ? 0 : m[0].length;
    const body = l.slice(lead);
    const nl = mark + body;
    parts.push({ oldFrom: oldOff, oldLead: lead, newFrom: newOff, newLead: mark.length, oldLen: l.length });
    oldOff += l.length + 1;
    newOff += nl.length + 1;
    return nl;
  });
  const insert = out.join('\n');
  const map = (pos: number): number => {
    for (const p of parts) {
      if (pos >= p.oldFrom && pos <= p.oldFrom + p.oldLen) {
        return p.newFrom + p.newLead + Math.max(pos - p.oldFrom - p.oldLead, 0);
      }
    }
    return pos + (insert.length - (to - from));
  };
  return {
    text: text.slice(0, from) + insert + text.slice(to),
    start: map(sel.start),
    end: map(sel.end),
    from,
    to,
    insert,
  };
}
