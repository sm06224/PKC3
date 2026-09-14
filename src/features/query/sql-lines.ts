/**
 * 🔴 **打つ SQL を「行ごとの色付き HTML」に割る**(#918 段②c/②d)。
 *
 * ## なぜ行ごとに割るのか
 *
 * 画面は `<textarea>` の**後ろ**に色付きの層を敷き、字だけ透明にする形である
 * (器を替えると IME・取り消し・選択・スマホの鍵盤、そして段②a/②b が全部落ちる ──
 * CLAUDE.md §10「置き換えの作法」)。
 *
 * 🔑 **行番号を折り返しと揃える**には、層を**論理行 1 本 = 升 1 つ**の格子にするしかない
 * ── 折り返した行は升ごと伸びるので、番号は自然に先頭へ揃う。
 * ⚠ 番号を別の列に「行の高さぶんずつ」積む形にすると、**折り返した瞬間にずれる**。
 *
 * ## なぜ「1 行ずつ色を付ける」ではないのか
 *
 * 🔴 **`/* … *\/` と `'…'` は行をまたぐ。** 1 行ずつ `highlightCode` に渡すと、
 * 2 行目から色が消える(読み手には「途中で色が壊れた」に見える)。
 * 🔑 だから **全文を 1 度色付けしてから、開いている `<span>` を各行の端で閉じ直す**。
 *
 * ⚠ 相手の HTML は `code-highlight.ts` が作る**決まった形**だけである ──
 * `<span class="pkc-tok-…">` と、escape 済みの素の字。だから素朴な走査で足りる。
 */

import { highlightCode } from '@features/markdown/code-highlight';

/** 開いている `<span …>` の字面(閉じ直すのに使う)。 */
type OpenTag = string;

/**
 * 打った字を**論理行ごとの色付き HTML** に割る。
 *
 * @returns 行数ぶんの配列。⚠ **空の字でも 1 本返す**(升が 0 個だと層が畳まれる)。
 *   末尾が改行なら、最後に**空の行が 1 本**付く(`textarea` の見え方と同じ)。
 */
export function sqlLineHtml(text: string): string[] {
  const html = highlightCode(text, 'sql');
  const lines: string[] = [];
  const open: OpenTag[] = [];
  let cur = '';
  let i = 0;

  const closeAll = (): string => open.map(() => '</span>').join('');
  const openAll = (): string => open.join('');

  while (i < html.length) {
    if (html.startsWith('</span>', i)) {
      cur += '</span>';
      open.pop();
      i += '</span>'.length;
      continue;
    }
    if (html.startsWith('<span', i)) {
      const end = html.indexOf('>', i);
      // ⚠ 閉じが無い形は相手が作らないが、作られたら**残りを素の字として扱う**
      //   (例外を投げて面ごと落とすより、色が付かないほうが害が小さい)
      if (end < 0) {
        cur += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
      cur += tag;
      open.push(tag);
      i = end + 1;
      continue;
    }
    // ── 素の字の走り。次の `<` か改行まで一気に進む
    const nl = html.indexOf('\n', i);
    const lt = html.indexOf('<', i);
    if (nl >= 0 && (lt < 0 || nl < lt)) {
      cur += html.slice(i, nl);
      lines.push(cur + closeAll());
      cur = openAll();
      i = nl + 1;
      continue;
    }
    const stop = lt < 0 ? html.length : lt;
    cur += html.slice(i, stop);
    i = stop;
  }
  lines.push(cur + closeAll());
  return lines;
}
