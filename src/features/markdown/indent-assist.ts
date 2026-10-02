/**
 * 🔴 **リストの字下げ / 字下げを戻す**(#1166、Gemini 提案 → 着陸案)。
 *
 * ## user がやりたいこと
 *
 * `- 牛乳` の行で **Tab** を押したら、項目が**ひとつ内側**に入ってほしい
 * (入れ子のリスト)。戻すときは **Shift + Tab**。複数行を選んでいれば**まとめて**。
 * ⚠ いまは行頭へ戻って空白を数えて打つしかない。
 *
 * ## ⚠ Tab を握るのは「効く場面」だけ ── 焦点の出口を塞がない
 *
 * textarea の `Tab` は既定で**焦点移動**である。常に握ると、鍵盤だけで使う人が
 * この欄から出られなくなる(`binder.ts` の `Tab` の注記と同じ戒め)。
 * 🔑 だから**この関数が `null` を返したら呼び側は何もしない**(= キーは既定のまま
 * 通り、焦点が出ていく ── それが意図した出口):
 *
 * | キー | 握る | 握らない(`null`) |
 * |---|---|---|
 * | **Tab** | caret の行が**リストの項目** / **複数行を選んでいる** | 普通の段落の 1 行 |
 * | **Shift + Tab** | 対象の行に**戻せる字下げ**がある | 字下げの無い行 |
 *
 * 🔑 明示の命令(`Ctrl + ]` / `Ctrl + [`)は `explicit` を立てて呼ぶ ──
 * 焦点の出口を奪う心配が無いので、**普通の 1 行にも**効く(2 つ分の空白)。
 *
 * ## 幅
 *
 * **リストの記号の幅**(記号 + 空白)── `- ` は 2、`1. ` は 3、`10. ` は 4。
 * ⚠ markdown-it は `1. a` の下の入れ子に**空白 3 つ**を要る(2 つでは入れ子にならない
 * ことを実測した)ので、`- ` の幅(2)を全部へ使い回さない。
 * リストでない行(複数行の選択に混じる地の文)は **2**。
 * 戻すときは `min(いまの字下げ, 幅)` だけ外す(中途半端な字下げからでも止まらない)。
 *
 * ## 決めたこと(迷いやすい所)
 *
 * - 複数行は**行ごと**に幅を決める。空行は触らない(行末の空白を作らない)。
 * - **`>` で始まる行は触らない**(字下げを `>` の前へ足すと引用が壊れる)。
 * - ⚠ **fence の中の行も、複数行の選択に入っていれば字下げする** ── コードも
 *   本文の字なので。(fence を飛ばすと、選んだ範囲が行ごとに食い違う。)
 * - 選択の終わりが**行頭**(下の行の頭まで選んだ)なら、その行は含めない。
 * - 選択は**同じ行の範囲**に保つ(字下げの分だけ動く)。
 *
 * 🔑 **pure module**。textarea も DOM も知らない ── 書き込みは呼び側が
 * `insertText`(取り消しの履歴を切らない)で `from`〜`to` を `insert` へ置き換える。
 */
import { lineStart } from './line-start';
import { LIST_LEAD, THEMATIC_BREAK } from './list-renumber';
import type { TextSelection } from './text-ops';

/** リストでない行へ足す / から外す幅。 */
export const PLAIN_INDENT = 2;

/** 字下げの結果。⚠ `TextSelection` の形(新しい本文と選択)に、置き換える範囲を足したもの。 */
export interface IndentEdit extends TextSelection {
  /** 古い本文の中で置き換える範囲(`from` は行頭、`to` は行末)。 */
  readonly from: number;
  readonly to: number;
  /** その範囲へ入れる字(複数行なら改行を含む)。 */
  readonly insert: string;
}

export interface IndentOptions {
  /** 明示の命令(`Ctrl + ]` / `Ctrl + [`)から呼ぶとき。普通の 1 行にも効く。 */
  readonly explicit?: boolean;
}

/**
 * リストの記号の幅(記号 + 空白)。リストの項目でなければ `null`。
 * ⚠ 記号の後ろの空白が 5 つ以上ならコードブロック扱いなので、幅は 1 つ分で数える。
 */
function markerWidth(line: string): number | null {
  if (THEMATIC_BREAK.test(line)) return null;
  const m = LIST_LEAD.exec(line);
  if (m === null) return null;
  const gap = m[3]!.length <= 4 ? m[3]!.length : 1;
  return m[2]!.length + gap;
}

/** 行頭の字下げを幅 `width` までだけ外す。⚠ タブ 1 つは 1 段(幅いっぱい)として外す。 */
function stripIndent(line: string, width: number): string {
  let i = 0;
  let n = 0;
  while (i < line.length && n < width) {
    const c = line[i];
    if (c === '\t') {
      i += 1;
      n = width;
    } else if (c === ' ') {
      i += 1;
      n += 1;
    } else break;
  }
  return line.slice(i);
}

/**
 * 選択している行を字下げする(`dir` = 1)/ 戻す(`dir` = -1)。
 *
 * @returns 何も変わらないなら `null`(⚠ 呼び側は**キーを握らない**)
 */
export function indentLines(
  sel: TextSelection,
  dir: 1 | -1,
  opts: IndentOptions = {},
): IndentEdit | null {
  const { text } = sel;
  // ⚠ `lastIndexOf('\n', -1)` は 0 番目を見る ── 先頭が空行の本文で行頭を取り違えるので共有の口を通す
  const from = lineStart(text, sel.start);
  const collapsed = sel.start === sel.end;
  // ⚠ 下の行の頭まで選んでいるときは、その行を巻き込まない
  const lastPos = !collapsed && text[sel.end - 1] === '\n' ? sel.end - 1 : sel.end;
  const nl = text.indexOf('\n', lastPos);
  const to = nl === -1 ? text.length : nl;
  const lines = text.slice(from, to).split('\n');
  const multi = lines.length > 1;

  const next: string[] = [];
  let changed = false;
  for (const line of lines) {
    let out = line;
    if (line.trim() !== '' && !/^\s*>/.test(line)) {
      const w = markerWidth(line);
      if (dir === 1) {
        // ⚠ ここが Tab の「効く場面」の門 ── 普通の 1 行は握らない(焦点を出す)
        if (w === null && !multi && opts.explicit !== true) return null;
        out = ' '.repeat(w ?? PLAIN_INDENT) + line;
      } else {
        out = stripIndent(line, w ?? PLAIN_INDENT);
      }
    }
    if (out !== line) changed = true;
    next.push(out);
  }
  if (!changed) return null;

  // 古い位置 → 新しい位置(行ごとの増減で写す)
  const oldStarts: number[] = [];
  const newStarts: number[] = [];
  let o = from;
  let n = from;
  for (let i = 0; i < lines.length; i += 1) {
    oldStarts.push(o);
    newStarts.push(n);
    o += lines[i]!.length + 1;
    n += next[i]!.length + 1;
  }
  const insert = next.join('\n');
  const total = insert.length - (to - from);
  const map = (pos: number): number => {
    if (pos > to) return pos + total;
    let i = oldStarts.length - 1;
    while (i > 0 && oldStarts[i]! > pos) i -= 1;
    const col = pos - oldStarts[i]!;
    const d = next[i]!.length - lines[i]!.length;
    return newStarts[i]! + Math.min(next[i]!.length, Math.max(0, col + d));
  };
  let start = map(sel.start);
  // ⚠ 選んだ範囲の頭が行頭なら、足した字下げも**選択に含める**(選び直さずに続けて押せる)
  if (!collapsed && sel.start === from) start = from;
  const end = collapsed ? start : Math.max(start, map(sel.end));
  return {
    text: text.slice(0, from) + insert + text.slice(to),
    start,
    end,
    from,
    to,
    insert,
  };
}
