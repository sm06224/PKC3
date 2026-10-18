/**
 * 🔴 **全文検索が見る字を決める、唯一の場所**(台帳 #1852 の束 B2、依頼 196・197・258・335・115-2)。
 *
 * 本文の検索は「書いた字そのもの」を引かない。次の 3 つを通した字を引く ──
 *
 * | 通すもの | 例 | 依頼 |
 * |---|---|---|
 * | 隠したメモ(`%%…%%` / `%%%` / `:::comment`)を除く | `%% 秘密のメモ %%` は「秘密」で当たらない | 196 |
 * | リンクの宛先の字(`entry:` / `asset:` / `pkc://`)を除き、表示される字だけ残す | `[議事録](entry:abc123)` は「議事録」だけ。「entry」では当たらない | 197 |
 * | 全角と半角・半角カナ・濁点の持ち方を揃える(`fold-text.ts` の 1 本) | 「ＰＫＣ」=「PKC」/「ﾊﾝｶｸ」=「ハンカク」 | 258・335・115-2 |
 *
 * ⚠ **書き込む側(索引の元の字)・引く側(問い合わせ)・抜粋を作る側が、どれもここを通る**(§7)。
 *   片方だけ揃えると「当たったのに抜粋が出ない」「抜粋に出るのに当たらない」が静かに起きる。
 * ⚠ **保存されているノートの字は 1 字も変えない** ── 返すのは検索用の字で、書き戻す口にはつながない。
 * 🔑 pure module。DOM も worker も知らない。
 */
import { withoutHidden } from '../entry-ref/body-links';
import { scanLinks } from '../markdown/link-scan';
import { foldText, foldWidth } from './fold-text';
import {
  SNIPPET_ELLIPSIS,
  SNIPPET_MARK_CLOSE,
  SNIPPET_MARK_OPEN,
  SNIPPET_TOKENS,
  neutralizeSnippetMarks,
} from './search-snippet';

/** 宛先が「ノート / 添付を指す ID」の形か(リンクの見出しの字ではなく、検索に当てたくない字)。 */
const ID_DEST = /^(?:entry:|asset:|pkc:\/\/)/i;
const ID_PROBE = /entry:|asset:|pkc:\/\//i;

/** `[見出し](entry:…)` → `見出し` / `![代替](asset:…)` → `代替` / 参照形式・HTML の宛先は字ごと消す。 */
function withoutLinkIds(text: string, depth = 0): string {
  if (depth > 4 || !ID_PROBE.test(text)) return text;
  const edits: Array<[number, number, string]> = [];
  let floor = 0;
  for (const site of scanLinks(text).sites) {
    if (!ID_DEST.test(site.dest.trim())) continue;
    if (site.kind === 'inline' && site.labelStart >= 0) {
      const from = site.image && text[site.labelStart - 1] === '!' ? site.labelStart - 1 : site.labelStart;
      if (from < floor) continue; // 入れ子の内側は外側の見出しの中で処理する
      // 見出しの中にも別のリンクが入りうる(`[![x](asset:a)](entry:b)`)── 中も同じ規則で
      edits.push([from, site.end, withoutLinkIds(text.slice(site.labelStart + 1, site.start), depth + 1)]);
      floor = site.end;
    } else {
      if (site.destStart < floor) continue;
      edits.push([site.destStart, site.destEnd, '']);
      floor = site.destEnd;
    }
  }
  if (edits.length === 0) return text;
  edits.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [s, e, r] of edits) {
    if (s < at) continue;
    out += text.slice(at, s) + r;
    at = e;
  }
  return out + text.slice(at);
}

/**
 * 🔴 **検索に当てる本文**(揃える前)。隠したメモを空白にし、リンクの宛先の字を除く。
 * ⚠ 隠した囲みの読み方は `body-links.ts` の `withoutHidden`(描画 / 参照元の数え方と同じ 1 本)。
 */
export function searchableBody(body: string): string {
  if (body === '') return body;
  let t = body;
  if (t.includes('%%') || t.includes(':::')) t = withoutHidden(t);
  return withoutLinkIds(t);
}

/** 索引の元の字(題名・本文)。⚠ `null` = 揃えても書いた字と同じ(列に重ねて持たない)。 */
export interface FoldedColumns {
  titleF: string | null;
  bodyF: string | null;
}

export function foldedColumns(title: string, body: string): FoldedColumns {
  const t = foldWidth(title);
  const b = foldWidth(searchableBody(body));
  return { titleF: t === title ? null : t, bodyF: b === body ? null : b };
}

// ── 揃えた字 ⇄ 書いた字の位置合わせ ──────────────────────────────────────────

/** 直前の字にくっついて 1 字を作る字(結合文字・濁点・半角の濁点・ハングルの母音と終声)。 */
const CONT = /^[\p{M}゙゚ﾞﾟᅠ-ᇿ]/u;

const isCont = (text: string, i: number): boolean => CONT.test(String.fromCodePoint(text.codePointAt(i)!));

/** `i` から始まる 1 まとまり(基底の字 + 続く結合文字)の終わり。 */
function clusterEnd(text: string, i: number): number {
  let j = i + (text.codePointAt(i)! > 0xffff ? 2 : 1);
  while (j < text.length && isCont(text, j)) j += text.codePointAt(j)! > 0xffff ? 2 : 1;
  return j;
}

/**
 * 揃えた字(`foldText`)と、その字ごとに「書いた字のどこから・どこまで」かを対にして返す。
 * 🔑 まとまり(基底 + 結合文字)ごとに揃えるので、「か」+「゛」→「が」のように長さが変わっても位置が追える。
 * ⚠ 長い文字列に使わない(添字の配列を持つ)── 画面の 1 つの text node のための道具。
 */
export interface FoldedMap {
  folded: string;
  /** `folded` の i 番目(UTF-16)に対応する、書いた字の始まり。 */
  from: number[];
  /** 同じく、書いた字の終わり(排他)。 */
  to: number[];
}

export function foldMapped(text: string): FoldedMap {
  let folded = '';
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < text.length; ) {
    const e = clusterEnd(text, i);
    const f = foldText(text.slice(i, e));
    for (let k = 0; k < f.length; k++) {
      from.push(i);
      to.push(e);
    }
    folded += f;
    i = e;
  }
  return { folded, from, to };
}

/** 位置合わせの塊(字数)。塊の端はまとまりの切れ目に寄せる。 */
const BLOCK = 512;

/**
 * 揃えた字の `[fStart, fEnd)` に当たる、書いた字の範囲。
 * 🔑 塊ごとに長さだけ数えて飛ばし、当たりのある塊だけ字ごとに歩く ── 添字の配列を作らない(長い本文でも軽い)。
 */
export function unfoldRange(text: string, fStart: number, fEnd: number): [number, number] {
  let o = 0;
  let f = 0;
  while (o < text.length) {
    let e = Math.min(o + BLOCK, text.length);
    while (e < text.length && isCont(text, e)) e++;
    const len = foldText(text.slice(o, e)).length;
    if (f + len > fStart) break;
    f += len;
    o = e;
  }
  let start = o;
  while (start < text.length) {
    const e = clusterEnd(text, start);
    const len = foldText(text.slice(start, e)).length;
    if (f + len > fStart) break;
    f += len;
    start = e;
  }
  let end = start;
  let g = f;
  while (end < text.length && g < fEnd) {
    const e = clusterEnd(text, end);
    g += foldText(text.slice(end, e)).length;
    end = e;
  }
  return [start, end];
}

/**
 * 🔴 **揃えて探し、書いた字で抜粋を作る**(`search-snippet.ts` の `excerptAround` の、揃える版)。
 * 抜粋に出る字は書いたまま(「ＰＫＣ」は「ＰＫＣ」のまま)── 当たりの位置だけを揃えた字で決める。
 * `terms` は先頭から順に、最初に見つかった語の所を窓にする(`excerptAround` と同じ約束)。
 * ⚠ 本文に無ければ(題名だけが当たった)先頭を切って返す。改行は空白へ潰す。
 */
export function excerptAroundFolded(text: string, terms: readonly string[], width = SNIPPET_TOKENS): string {
  const flat = neutralizeSnippetMarks(text).replace(/\s+/g, ' ');
  const hay = foldText(flat);
  let hit: [number, number] | null = null;
  for (const t of terms) {
    const n = foldText(t.trim());
    if (n === '') continue;
    const at = hay.indexOf(n);
    if (at < 0) continue;
    hit = unfoldRange(flat, at, at + n.length);
    break;
  }
  if (hit === null) {
    const head = [...flat].slice(0, width).join('');
    return head.length < flat.length ? head + SNIPPET_ELLIPSIS : head;
  }
  const [s, e] = hit;
  const before = [...flat.slice(0, s)];
  const after = [...flat.slice(e)];
  const side = Math.max(0, Math.floor((width - [...flat.slice(s, e)].length) / 2));
  return (
    (before.length > side ? SNIPPET_ELLIPSIS : '') +
    before.slice(Math.max(0, before.length - side)).join('') +
    SNIPPET_MARK_OPEN +
    flat.slice(s, e) +
    SNIPPET_MARK_CLOSE +
    after.slice(0, side).join('') +
    (after.length > side ? SNIPPET_ELLIPSIS : '')
  );
}
