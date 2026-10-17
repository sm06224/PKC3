/**
 * 🔴 **行を前後の行と入れ替える**(#1213、`Alt+↑` / `Alt+↓`)。
 *
 * ## user がやりたいこと
 *
 * 本文を編集しているとき、カーソルの行を**ひとつ上 / ひとつ下**へ動かしたい
 * (箇条書きの順を直す・手順の入れ替え)。複数行を選んでいれば**選んだ行の塊ごと**。
 * カーソルも行と一緒に動く(続けて押せる)。
 *
 * ## 決めたこと(Gemini 裁定 2026-10-01)
 *
 * - **欄の中の行だけを動かす** ── 塊をまたがない。1 面(ライブ)の行の欄は**1 つの塊の原文だけ**
 *   が入っているので、1 行だけの塊(見出し / 1 つの段落 / 表の 1 行)では動かす相手が無く、
 *   **何も起きない**(隣の塊とは入れ替えない)。この関数は欄の文字列しか知らないので、
 *   その規則は「欄の端では `null`」から**自然に出る**(別の判定を持たない)。
 * - **欄の端では何も起きない**(先頭の行で ↑ / 末尾の行で ↓)。折り返しはしない。
 * - 純粋な**字の入れ替え**。表の `|---|` の行をまたいでも止めない(Ctrl+Z で戻る)。
 * - 行は `\n` で割る(textarea の行)。末尾が `\n` の本文は、その後ろの**空の行**も 1 行として
 *   数える(欄に見えている行と同じ)── `a\nb\n` の `b` を下へ動かすと `a\n\nb`。
 * - 選択の終わりが**行頭**(下の行の頭まで選んだ)なら、その行は含めない(`indentLines` と同じ)。
 *
 * 🔑 **pure module**。textarea も DOM も知らない ── 書き込みは呼び側が
 * `insertText`(取り消しの履歴を切らない)で `from`〜`to` を `insert` へ置き換える。
 * ⚠ `line-move.ts` の `moveLines` は**読む面のブロック移動**で別物(名前を分けてある)。
 */
import { lineStart } from './line-start';
import { LIST_LEAD, THEMATIC_BREAK } from './list-renumber';
import type { TextSelection } from './text-ops';

/** 入れ替えの結果。⚠ `TextSelection`(新しい本文と選択)に、置き換える範囲を足したもの。 */
export interface SwapEdit extends TextSelection {
  /** 古い本文の中で置き換える範囲(`from` は行頭、`to` は行末)。 */
  readonly from: number;
  readonly to: number;
  /** その範囲へ入れる字(改行を含む)。 */
  readonly insert: string;
}

/** 字下げの幅(`list-renumber.ts` の `indentOf` と同じ数え方)。 */
function indentLen(line: string): number {
  return /^\s*/.exec(line)![0].length;
}

/** 箇条書き・番号付きの項目の行か(水平線 `---` は除く。読み方は Enter・字下げと同じ `LIST_LEAD`)。 */
function isItemLine(line: string): boolean {
  return LIST_LEAD.test(line) && !THEMATIC_BREAK.test(line);
}

/**
 * 🔴 **項目の子(より深く字下げした続きの行)の終わりまで広げる**(#1163 依頼 204)。
 * `lineFrom`〜`lineTo` は項目の行。子が無い・項目でないなら `lineTo` のまま。
 * ⚠ 空行で切る(空行の先は別の塊)。
 */
function withChildren(text: string, lineFrom: number, lineTo: number): number {
  const head = text.slice(lineFrom, lineTo);
  if (!isItemLine(head)) return lineTo;
  const depth = indentLen(head);
  let end = lineTo;
  while (end < text.length) {
    const from = end + 1;
    const nl = text.indexOf('\n', from);
    const to = nl === -1 ? text.length : nl;
    const l = text.slice(from, to);
    if (l.trim() === '' || indentLen(l) <= depth) break;
    end = to;
  }
  return end;
}

/**
 * 選んでいる行(の塊)を、前の行(`dir` = -1)/ 次の行(`dir` = 1)と入れ替える。
 *
 * @returns 欄の端で動かせないなら `null`(⚠ 呼び側は何も書かない。キーは握ってよい)
 */
export function swapLines(sel: TextSelection, dir: 1 | -1): SwapEdit | null {
  const { text } = sel;
  const blockFrom = lineStart(text, sel.start);
  const collapsed = sel.start === sel.end;
  // ⚠ 下の行の頭まで選んでいるときは、その行を巻き込まない
  const lastPos = !collapsed && text[sel.end - 1] === '\n' ? sel.end - 1 : sel.end;
  const nl = text.indexOf('\n', lastPos);
  // 🔴 動かす側の最後の行が子を持つ項目なら、子も一緒に動かす(入れ子が崩れない)
  const lastLineFrom = lineStart(text, nl === -1 ? text.length : nl);
  const blockTo = withChildren(text, lastLineFrom, nl === -1 ? text.length : nl);
  const block = text.slice(blockFrom, blockTo);

  if (dir === -1) {
    if (blockFrom === 0) return null;
    // blockFrom - 1 は直前の行の終わりの `\n`。その手前から行頭を探す
    let prevFrom = lineStart(text, blockFrom - 1);
    /**
     * 🔴 動かすのが項目なら、上の兄弟の項目は**子ごと**で 1 つの塊である。
     *   直前の行が深い子なら、字下げが同じ兄弟の頭まで上がる。⚠ 上がった先が兄弟でない
     *   (親・空行・先頭)ときは、これまでどおり直前の 1 行と入れ替える(親を飛び越えない)。
     */
    const firstNl = text.indexOf('\n', blockFrom);
    const firstLine = text.slice(blockFrom, firstNl === -1 ? text.length : firstNl);
    if (isItemLine(firstLine)) {
      const depth = indentLen(firstLine);
      let climb = prevFrom;
      while (climb > 0) {
        const l = text.slice(climb, text.indexOf('\n', climb));
        if (l.trim() === '' || indentLen(l) <= depth) break;
        climb = lineStart(text, climb - 1);
      }
      const head = text.slice(climb, text.indexOf('\n', climb));
      if (climb !== prevFrom && isItemLine(head) && indentLen(head) === depth) prevFrom = climb;
    }
    const prev = text.slice(prevFrom, blockFrom - 1);
    const shift = prev.length + 1;
    const insert = `${block}\n${prev}`;
    return {
      text: text.slice(0, prevFrom) + insert + text.slice(blockTo),
      start: sel.start - shift,
      end: sel.end - shift,
      from: prevFrom,
      to: blockTo,
      insert,
    };
  }
  if (blockTo === text.length) return null;
  const nextFrom = blockTo + 1;
  const nn = text.indexOf('\n', nextFrom);
  // 🔴 下の行が子を持つ項目なら、その子ごと 1 つの塊として入れ替える
  const nextTo = withChildren(text, nextFrom, nn === -1 ? text.length : nn);
  const next = text.slice(nextFrom, nextTo);
  const shift = next.length + 1;
  const insert = `${next}\n${block}`;
  return {
    text: text.slice(0, blockFrom) + insert + text.slice(nextTo),
    start: sel.start + shift,
    end: sel.end + shift,
    from: blockFrom,
    to: nextTo,
    insert,
  };
}
