import { indentedCodeRanges, scanLinks } from './link-scan';
import { frontmatterLineCount } from './frontmatter';
import { readMathAt } from './math-delims';

/**
 * 🔴 **`[[題名]]` / `[[題名|表示]]` の綴りと、「どれがリンクか」の判定 ── 描画と改名の正本**(#1174 段②)。
 *
 * ## なぜ 1 か所か
 * 描画(`markdown-render.ts` の inline 規則)と、改名で本文を書き換える側(`link-text-rename.ts`)が
 * **別々に `[[ ]]` を読む**と、「画面ではリンクでないのに書き換えられた」「リンクなのに追従しない」が静かに起きる。
 * だから ①綴り(`titleLinkAt`)②文書の中のどこがリンクか(`scanTitleLinks`)を、ここに 1 つだけ置く。
 *
 * ## 綴り
 * - 題名は 1〜200 字。`[` `]` `|` `\` と改行を含まない。表示も同じ(`\` を除くのは、表のセルの `\|` と
 *   エスケープの食い違いを作らないため ── 題名に `\` は使えない)。
 * - 題名が `ruby:` / `em:` で始まるものは別の記法(`[[ruby:…]]` / `[[em:…]]`)で、題名ではない。
 *
 * ## `scanTitleLinks` がリンクとして数えない所(描画がリンクにしない所)
 * コード(囲み・行内・字下げ)/ 数式(`$$` の塊・行内 `$…$`)/ リンクの字(`[…](…)` の中)/
 * エスケープされた `\[[…]]` / 表のセルをまたぐもの(`|` はセルの区切り)/ 先頭の frontmatter。
 * ⚠ これは描画の**部分集合**であることを守る(改名が書き換えるのは、画面がリンクにしているものだけ)。
 *   食い違いは `tests/features/title-link-parity.test.ts` が生成した文書で突き合わせる。
 */

const LINK_RE = /\[\[([^[\]\r\n|\\]{1,200}?)(?:\|([^[\]\r\n\\]{1,200}))?\]\]/y;

/** `[[ ]]` の題名として書けるか(`ruby:` / `em:` 始まりは別の記法なので書けない)。 */
export function isWritableLinkTitle(t: string): boolean {
  const s = t.trim();
  if (s === '' || s.length > 200) return false;
  if (/[[\]|\\\r\n]/.test(s)) return false;
  return !/^(?:ruby|em):/.test(s);
}

export interface TitleLinkMatch {
  /** 読み終えた位置(`]]` の次)。 */
  readonly end: number;
  /** 題名(前後の空白を除いた物)。 */
  readonly title: string;
  /** 見せる字(`|表示` があればそれ、無ければ題名)。 */
  readonly label: string;
  /** 題名そのものの始まり(`src` の添字。前の空白を除いた位置)。 */
  readonly titleFrom: number;
}

/** `pos` から `[[…]]` を 1 つ読む。読めなければ `null`。`posMax` を超えては読まない。 */
export function titleLinkAt(src: string, pos: number, posMax = src.length): TitleLinkMatch | null {
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return null;
  LINK_RE.lastIndex = pos;
  const m = LINK_RE.exec(src);
  if (m === null) return null;
  const end = pos + m[0].length;
  if (end > posMax) return null;
  const raw = m[1] ?? '';
  const title = raw.trim();
  if (!isWritableLinkTitle(title)) return null;
  const label = (m[2] ?? '').trim();
  return { end, title, label: label === '' ? title : label, titleFrom: pos + 2 + (raw.length - raw.trimStart().length) };
}

export interface TitleLinkSite {
  readonly start: number;
  readonly end: number;
  readonly title: string;
  readonly titleFrom: number;
}

/** 区間の集合(`[a, b)`)に添字が入るか。ranges は開始順。 */
function inside(ranges: ReadonlyArray<readonly [number, number]>, i: number): boolean {
  for (const [a, b] of ranges) {
    if (i < a) return false;
    if (i < b) return true;
  }
  return false;
}

/** 行頭が 4 桁以上の字下げか(タブは 4 桁)。 */
function deepIndent(line: string): boolean {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 4 - (n % 4);
    else break;
    if (n >= 4) return true;
  }
  return false;
}

const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** 1 行(または表の 1 セル)の中を、描画の inline と同じ順(左から)で読む。 */
function scanSegment(
  src: string,
  from: number,
  to: number,
  masked: ReadonlyArray<readonly [number, number]>,
  out: TitleLinkSite[],
): void {
  const memo = {};
  let i = from;
  while (i < to) {
    const ch = src.charCodeAt(i);
    if (ch === 0x5c /* \ */) {
      i += 2;
      continue;
    }
    if (ch === 0x24 /* $ */) {
      const span = readMathAt(src, i, to, memo);
      if (span !== null) {
        i = span.end;
        continue;
      }
    }
    // 裸の URL(`http://…`)は linkify が丸ごと 1 つのリンクにする ── 空白までは読まない
    if ((ch === 0x68 || ch === 0x66 || ch === 0x77) && /^(?:https?:\/\/|ftp:\/\/|www\.)/i.test(src.slice(i, i + 8)) && (i === from || !/[A-Za-z0-9]/.test(src[i - 1] ?? ' '))) {
      while (i < to && !/\s/.test(src[i]!)) i += 1;
      continue;
    }
    if (ch === 0x5b && !inside(masked, i)) {
      const m = titleLinkAt(src, i, to);
      // `[[A]](url)` / `[[A]][ref]` は通常のリンク(字が `[A]`)── 続きが `(` `[` の物は読まない
      if (m !== null && src[m.end] !== '(' && src[m.end] !== '[') {
        out.push({ start: i, end: m.end, title: m.title, titleFrom: m.titleFrom });
        i = m.end;
        continue;
      }
    }
    i += 1;
  }
}

/**
 * 本文の中の、画面でリンクになる `[[ ]]` を文書順に返す(改名が書き換える物)。
 * ⚠ 本文は原文(CRLF のまま)を渡す ── 添字は原文のもの。
 */
export function scanTitleLinks(body: string): TitleLinkSite[] {
  if (!body.includes('[[')) return [];
  const out: TitleLinkSite[] = [];
  const masked: Array<[number, number]> = [];
  const scan = scanLinks(body);
  for (const r of scan.code) masked.push([r[0], r[1]]);
  if (body.includes('    ') || body.includes('\t')) for (const r of indentedCodeRanges(body)) masked.push([r[0], r[1]]);
  // リンクの字(`[… [[a]] …](dest)`)── 描画は入れ子のリンクを作らない
  for (const s of scan.sites) if (s.kind === 'inline' && s.labelStart >= 0) masked.push([s.labelStart, s.end]);
  // 先頭の frontmatter は描かれない
  const fm = frontmatterLineCount(body);
  const lines: Array<{ from: number; to: number }> = [];
  for (let at = 0; at <= body.length; ) {
    const nl = body.indexOf('\n', at);
    const to = nl === -1 ? body.length : nl;
    lines.push({ from: at, to });
    if (nl === -1) break;
    at = nl + 1;
  }
  if (fm > 0) {
    const last = lines[Math.min(fm, lines.length) - 1];
    if (last !== undefined) masked.push([0, last.to + 1]);
  }
  masked.sort((a, b) => a[0] - b[0]);
  // 表の行(見出し行 + 区切り行 + 続く行)は `|` でセルに割って、セルごとに読む
  const tableRow = new Set<number>();
  for (let k = 0; k + 1 < lines.length; k++) {
    const a = lines[k]!;
    const b = lines[k + 1]!;
    const delim = body.slice(b.from, b.to).replace(/\r$/, '');
    if (!delim.includes('-') || !delim.includes('|') || !TABLE_DELIM.test(delim)) continue;
    if (!body.slice(a.from, a.to).includes('|')) continue;
    let j = k;
    while (j < lines.length && body.slice(lines[j]!.from, lines[j]!.to).trim() !== '' && !deepIndent(body.slice(lines[j]!.from, lines[j]!.to))) {
      tableRow.add(j);
      j += 1;
    }
    k = j;
  }
  let mathBlock = false;
  for (let k = 0; k < lines.length; k++) {
    const { from, to } = lines[k]!;
    const text = body.slice(from, to).replace(/\r$/, '');
    if (text.trim() === '$$' && !inside(masked, from)) {
      mathBlock = !mathBlock;
      continue;
    }
    if (mathBlock) continue;
    if (!text.includes('[[')) continue;
    // 4 桁以上の字下げの行は、字下げのコードかもしれない(段落の続きか表の後かは行だけでは決まらない)── 読まない
    if (deepIndent(text)) continue;
    if (tableRow.has(k)) {
      let cellFrom = from;
      for (let i = from; i <= to; i++) {
        if (i === to || (body.charCodeAt(i) === 0x7c && body.charCodeAt(i - 1) !== 0x5c)) {
          scanSegment(body, cellFrom, i, masked, out);
          cellFrom = i + 1;
        }
      }
      continue;
    }
    scanSegment(body, from, to, masked, out);
  }
  return out;
}
