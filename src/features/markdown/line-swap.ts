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
import type { TextSelection } from './text-ops';

/** 入れ替えの結果。⚠ `TextSelection`(新しい本文と選択)に、置き換える範囲を足したもの。 */
export interface SwapEdit extends TextSelection {
  /** 古い本文の中で置き換える範囲(`from` は行頭、`to` は行末)。 */
  readonly from: number;
  readonly to: number;
  /** その範囲へ入れる字(改行を含む)。 */
  readonly insert: string;
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
  const blockTo = nl === -1 ? text.length : nl;
  const block = text.slice(blockFrom, blockTo);

  if (dir === -1) {
    if (blockFrom === 0) return null;
    // blockFrom - 1 は直前の行の終わりの `\n`。その手前から行頭を探す
    const prevFrom = lineStart(text, blockFrom - 1);
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
  const nextTo = nn === -1 ? text.length : nn;
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
