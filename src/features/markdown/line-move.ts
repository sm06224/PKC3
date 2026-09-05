/**
 * 🔴 **本文の塊(行の並び)を、本文の中で動かす・差し込む**(#684 段① / 段②)。
 *
 * > user の物語(2026-09-03): 読んでいる本文の段落を掴んで、上の見出しの下へ持って
 * > いきたい。いまは編集に入って切り貼りするしか無い。
 *
 * ## 塊は「行の範囲 + 掴んだ時点の行そのもの」で指す
 *
 * 行番号は**描いた時**のものなので、書く直前に `start..end` の行が掴んだ時点の
 * `lines` と **byte 一致**することを検める。一致しなければ書かない
 * (`place-notation.ts` の `placeLinesAt` / `undo-append` と同じ作法 ── 別の窓の
 * 書込で行が動いた形で**別の塊を動かさない**)。
 *
 * ## 塊の単位は「範囲 + 隣の空行 1 本」
 *
 * 段落どうしは空行で区切って書くのが普通なので、範囲だけを切り出すと**元の所に
 * 空行が 2 本並び、入れた所は前後と詰まる**。🔑 消すときは後ろの空行を 1 本だけ
 * 一緒に消し(無ければ前の 1 本)、入れるときは前後が空行か端でなければ空行を補う
 * (`removePlace` の「隣の空行 1 本」の規則と同じ向き)。⚠ 2 本以上は触らない ──
 * 隣の段落の間隔まで詰めると、触っていない所が変わって見える。
 * ⚠ 描画の刻印(`data-pkc-source-end`)は箇条書きで**直後の空行まで**を含む
 *   (markdown-it の map)ので、範囲の末尾の空行は塊の一部と数えない。
 *
 * ## 取りやめは body をそのまま返す
 *
 * 落とし先が自分の中(`start..end+1`)なら**何もしない**。`null`(= 断る)ではなく
 * body をそのまま返す ── effect は「1 byte も変わらないなら書かず・言わない」ので、
 * 元の位置へ戻して離した取りやめの drop に「開き直してください」という嘘の赤帯が
 * 出ない(`movePlace` の契約)。
 *
 * ⚠ **pure module**。DOM も state も知らない。
 */
import { frontmatterLineCount } from './frontmatter';
import { containerAtLine, scanContainers, type ContainerSpan } from './source-blocks';

/** 塊を動かす指示。座標は**生の body**(frontmatter 込み)の 0 始まり・両端含む。 */
export interface MoveLines {
  readonly start: number;
  readonly end: number;
  /** この行の**前**へ入れる(`lines.length` で末尾)。座標は動かす**前**の本文。 */
  readonly toBefore: number;
  /** 掴んだ時点の `start..end` の行そのもの ── disk 側と一致しなければ書かない。 */
  readonly lines: readonly string[];
}

/**
 * `toBefore`(行の前へ入れる位置)が**入れてはいけない所**か。
 *
 * - frontmatter の中(`toBefore < fm`)
 * - fence(```)の中 ── コードの字になる
 * - `:::` の囲みの中 ── 別の塊の中身になる(描画の刻印からは決して出ない座標なので、
 *   ここへ来るのは**別の窓の書込で行がずれた**とき。当てずっぽうで入れない)
 *
 * ⚠ 囲みの**開き行の前**と**閉じ行の次**は外(入れてよい)。閉じていない囲いは末尾まで
 *   飲んでいるので、その開きより後ろは全部「中」である。
 * 🔑 dragover で印を出すか決める側と、書く直前の門が**同じ 1 本**を引く(§7)。
 */
export function insertionBlocked(body: string, toBefore: number): boolean {
  const fm = frontmatterLineCount(body);
  const lines = body.split('\n');
  if (!Number.isInteger(toBefore) || toBefore < fm || toBefore > lines.length) return true;
  return insideContainer(scanContainers(lines.slice(fm).join('\n')), toBefore - fm);
}

/** 挿入位置 `p`(frontmatter を剥いだ座標)が囲いの中か。 */
function insideContainer(spans: readonly ContainerSpan[], p: number): boolean {
  // 前の行(p-1)を含む囲いが在り、その囲いが p の所でまだ閉じていなければ「中」
  const before = containerAtLine(spans, p - 1);
  if (before === null) return false;
  return before.open || p <= before.end;
}

/**
 * 🔴 **行の並びを差し込む**(段②: 一覧の行を落とすとリンクになる)。
 *
 * @returns 入れられなければ `null`(断る)。`lines` が空でも `null`。
 */
export function insertLines(body: string, toBefore: number, lines: readonly string[]): string | null {
  if (lines.length === 0 || insertionBlocked(body, toBefore)) return null;
  const all = body.split('\n');
  return placeChunk(all, frontmatterLineCount(body), toBefore, lines).lines.join('\n');
}

/** 動かした結果と、それを**逆向きに撃つ**指示(「元に戻す」の材料)。 */
export interface MovedLines {
  readonly body: string;
  /** 取りやめ(1 byte も動かない)のときは `null`。 */
  readonly inverse: MoveLines | null;
}

/**
 * 🔴 **塊を動かす**(段①)。
 *
 * 門(どれか 1 つでも外れたら `null` = 断る):
 * - `start` / `end` / `toBefore` が整数で、`fm <= start <= end < 行数`、`fm <= toBefore <= 行数`
 * - `start..end` の行が `lines` と byte 一致(別の窓の書込で行がずれていない)
 * - `start` が囲いの中でない / `toBefore` が囲いの中でない(`insertionBlocked`)
 *
 * 🔑 `toBefore` が `start..end+1` の中なら**取りやめ** ── `body` をそのまま返す。
 */
export function moveLinesWithInverse(body: string, move: MoveLines): MovedLines | null {
  const { start, end, toBefore } = move;
  const fm = frontmatterLineCount(body);
  const all = body.split('\n');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < fm || end < start) return null;
  if (end >= all.length) return null;
  if (move.lines.length !== end - start + 1) return null;
  for (let i = 0; i < move.lines.length; i += 1) if (all[start + i] !== move.lines[i]) return null;
  const spans = scanContainers(all.slice(fm).join('\n'));
  // ⚠ 掴んだ塊そのものが囲いの中(= 別の窓の書込で囲いが上へ伸びた)なら当てずっぽうで動かさない
  if (insideContainer(spans, start - fm)) return null;
  // ⚠ 取りやめの判定は囲いの門より**前** ── 自分の中(自分が持つ fence の中も含む)へ落としても
  //    1 byte も変わらないので、「開き直してください」の赤帯を出す理由が無い
  if (toBefore >= start && toBefore <= end + 1) return { body, inverse: null };
  if (insertionBlocked(body, toBefore)) return null;

  // 塊の実体 ── 範囲の末尾の空行は数えない(箇条書きの刻印は直後の空行まで含む)
  let e = end;
  while (e > start && all[e] === '') e -= 1;
  const chunk = all.slice(start, e + 1);
  // 消す単位 ── 実体 + 隣の空行 1 本(後ろ優先。無ければ前 ── frontmatter は跨がない)
  // ⚠ 本文の終端の改行(最後の空要素)は「隣の空行」に数えない ── 消すと本文の末尾の
  //    改行が失われ、「元に戻す」で 1 byte 違う本文になる
  let from = start;
  let to = e;
  if (all[to + 1] === '' && to + 1 !== all.length - 1) to += 1;
  else if (from > fm && all[from - 1] === '') from -= 1;
  const removed = to - from + 1;
  const rest = [...all.slice(0, from), ...all.slice(to + 1)];
  // 入れる位置を、消した後の座標へ写す
  const p = toBefore > to ? toBefore - removed : toBefore;
  const placed = placeChunk(rest, fm, p, chunk);
  const next = placed.lines.join('\n');
  // 「元に戻す」── いま入った所を掴んで、元の後続行(消した単位の次)の前へ戻す
  const back = from >= p ? from + placed.added : from;
  return {
    body: next,
    inverse:
      next === body
        ? null
        : { start: placed.start, end: placed.start + chunk.length - 1, toBefore: back, lines: chunk },
  };
}

/** `moveLinesWithInverse` の本文だけ。 */
export function moveLines(body: string, move: MoveLines): string | null {
  return moveLinesWithInverse(body, move)?.body ?? null;
}

/**
 * `p` 番目の行の前へ塊を置く。前後が空行か端でなければ空行を 1 本補う。
 *
 * @returns 置いた後の行の並びと、塊の先頭の行番号、足した行数(塊 + 補った空行)
 */
function placeChunk(
  lines: readonly string[],
  fm: number,
  p: number,
  chunk: readonly string[],
): { lines: string[]; start: number; added: number } {
  const padBefore = p > fm && lines[p - 1] !== '';
  const padAfter = p < lines.length && lines[p] !== '';
  const insert = [...(padBefore ? [''] : []), ...chunk, ...(padAfter ? [''] : [])];
  return {
    lines: [...lines.slice(0, p), ...insert, ...lines.slice(p)],
    start: p + (padBefore ? 1 : 0),
    added: insert.length,
  };
}
