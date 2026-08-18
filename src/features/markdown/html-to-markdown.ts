/**
 * 貼り付けた **HTML を PKC-Markdown へ戻す**(#251 の D。user 報告
 * 「AI チャットの回答をコピペすると書式付きでいい感じに貼付できない」の系譜)。
 *
 * 🔴 **PKC2 は 2 本立てだった**(`htmlPasteToMarkdown` = anchor だけ正規化 /
 * `htmlPasteToRichMarkdown` = AST 経由で構造ごと復元)。ここは **1 本**にする ──
 * 同じ問いに答える口が 2 つあると、片方だけ壊しても届かない
 * (CLAUDE.md §7。PKC2 では実際に「flag が OFF のとき構造が消える」形だった)。
 * ⚠ AST 経路(`parseHtmlToAst` → `renderAstToMarkdown`)は**持ってこない** ──
 * PKC3 に AST 層は無く、貼付のためだけに輸入するのは「流用 + 総合的見直し」の逆。
 *
 * ## 介入しない条件(`convertPastedHtml` が `null` を返す = 既定の貼付に委ねる)
 * - `text/html` が空 / 上限超過 / 解析できない
 * - **`text/plain` が既に markdown 原文らしい**(AI の「コピー」ボタンは原文を
 *   text/plain に、描画済み HTML を text/html に載せる ── 原文のほうが常に正確)
 * - 変換して**得るものが無い**(見出し・リスト・表・コード・リンク・画像・装飾が無い)
 * - 変換結果が空 / 平文と同じ
 *
 * ## 出す形は PKC3 の描画に合わせる(丸写しにしない)
 * - `<br>` は **改行 1 つ**(`markdown-it` を `breaks: true` で使っているので、
 *   単なる改行がそのまま `<br>` になる。2 スペースの行末は編集で消えるので使わない)
 * - チェックボックスの `<li>` は `- [x]` へ(PKC3 は GFM のタスクリストを描く)
 * - 表は GFM。⚠ 見出し行が無い表は**空の見出し行**を足す(先頭行を見出しに
 *   格上げすると**データが 1 行消える**)。`colspan` は表現できないので畳まない
 * - `data:` / `blob:` の画像は**そのまま出す** ── 資産へ逃がすのは呼び側
 *   (`features/asset/inline-url-adopt.ts`)の仕事で、ここは純関数のまま保つ
 */
import { escapeAssetLabel, escapeAssetTarget } from '../asset/asset-ref-format';

/** DOM の生成手段(worker / node には `DOMParser` が無いので注入可能にする)。 */
export type HtmlParse = (html: string) => Document;

/** これより大きい `text/html` は**解析しない**(貼付でメインスレッドを止めない)。 */
export const PASTE_HTML_MAX = 1024 * 1024;

/** クリップボードの 2 面。**両方**を見て介入するかを決める。 */
export interface PastedClipboard {
  readonly html: string;
  readonly plain: string;
}

/** 中身を読まない要素(操作子・スクリプト・図形は貼付の役に立たない)。 */
const SKIP = new Set([
  'script', 'style', 'noscript', 'head', 'meta', 'link', 'title', 'template',
  'svg', 'canvas', 'iframe', 'object', 'embed', 'video', 'audio',
  'button', 'select', 'textarea', 'option', 'form',
]);

/** 塊として扱う要素(これ以外は行内)。 */
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'dd', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'ul',
]);

/** 変換して得るものがある印(1 つでも在れば介入する)。 */
const WORTH =
  'h1, h2, h3, h4, h5, h6, ul, ol, pre, table, blockquote, hr, a[href], img, code, strong, b, em, i, del, s';

/** 塊 1 つ。`tight` = 直前の塊と**空行を空けずに**続ける(入れ子のリスト)。 */
interface Block {
  readonly text: string;
  readonly tight: boolean;
}

const tagOf = (el: Element): string => el.tagName.toLowerCase();

/**
 * 連続する空白を 1 個へ(HTML の折り返しは意味を持たない)。
 * ⚠ `\s` は **NBSP(`&nbsp;`)も含む** ── HTML から来る文字はこれが多い。
 *   生バイトで書かない(1 稿目で書いてしまい lint が止めた ── CLAUDE.md §9)。
 */
const collapse = (s: string): string => s.replace(/\s+/g, ' ');

/**
 * 平文を markdown の中へ置ける形にする。
 * ⚠ `_` は**語中では強調にならない**ので、語中は escape しない
 * (`snake_case` が `snake\_case` になると原文が読めなくなる)。
 */
function escapeInline(s: string): string {
  return s
    .replace(/[\\`*[\]]/g, '\\$&')
    .replace(/(^|\s)_/g, '$1\\_')
    .replace(/_(?=\s|$)/g, '\\_');
}

/** 出せない宛先(貼った先で**押すと危ない**もの)。 */
function isSafeHref(href: string): boolean {
  const t = href.trim().toLowerCase();
  if (t === '') return false;
  return !(
    t.startsWith('javascript:') ||
    t.startsWith('vbscript:') ||
    t.startsWith('file:') ||
    t.startsWith('about:') ||
    // ⚠ `data:` は**画像だけ**通す(`data:text/html` は貼り先で開くと危ない)
    (t.startsWith('data:') && !t.startsWith('data:image/'))
  );
}

/** 強調の指定が「効いていない」印(Google ドキュメントは全体を `<b>` で包む)。 */
function neutralized(el: Element, prop: 'font-weight' | 'font-style'): boolean {
  const style = (el.getAttribute('style') ?? '').toLowerCase();
  if (style === '') return false;
  const m = new RegExp(`${prop}\\s*:\\s*([^;]+)`).exec(style);
  if (!m) return false;
  const v = m[1]!.trim();
  return prop === 'font-weight' ? v === 'normal' || v === '400' : v === 'normal';
}

/** 前後の空白を marks の**外**へ出して包む(`** 字 **` は強調にならない)。 */
function wrap(s: string, mark: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  if (!m || m[2] === '') return s;
  return `${m[1]!}${mark}${m[2]!}${mark}${m[3]!}`;
}

/** バッククォートを含む中身でも壊れない行内コード。 */
function codeSpan(el: Element): string {
  const raw = collapse(el.textContent ?? '');
  if (raw.trim() === '') return '';
  const runs = raw.match(/`+/g) ?? [];
  const ticks = '`'.repeat(Math.max(1, ...runs.map((r) => r.length + 1)));
  const pad = raw.startsWith('`') || raw.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${raw}${pad}${ticks}`;
}

function anchorOf(el: Element): string {
  const href = el.getAttribute('href') ?? '';
  const label = inlineChildren(el).trim();
  const bare = collapse(el.textContent ?? '').trim();
  // ⚠ 出せない宛先でも**文字は残す**(黙って消さない ── 何を貼ったか分からなくなる)
  if (!isSafeHref(href)) return label;
  const target = escapeAssetTarget(href.trim());
  if (label === '' || bare === href.trim()) return target;
  return `[${label}](${target})`;
}

function imageOf(el: Element): string {
  const src = el.getAttribute('src') ?? '';
  const alt = collapse(el.getAttribute('alt') ?? '').trim();
  // ⚠ 読めない画像は **alt を文字として**残す(空になるより手がかりが在るほうがよい)
  if (!isSafeHref(src)) return alt === '' ? '' : escapeInline(alt);
  return `![${escapeAssetLabel(alt)}](${escapeAssetTarget(src.trim())})`;
}

function inlineOf(node: Node): string {
  if (node.nodeType === 3) return escapeInline(collapse(node.textContent ?? ''));
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = tagOf(el);
  if (SKIP.has(tag)) return '';
  if (tag === 'br') return '\n';
  if (tag === 'img') return imageOf(el);
  // ⚠ チェックボックスは `<li>` 側で見る(ここで文字にすると二重に出る)
  if (tag === 'input') return '';
  if (tag === 'code' || tag === 'kbd' || tag === 'samp') return codeSpan(el);
  if (tag === 'a') return anchorOf(el);

  const inner = inlineChildren(el);
  if ((tag === 'strong' || tag === 'b') && !neutralized(el, 'font-weight')) return wrap(inner, '**');
  if ((tag === 'em' || tag === 'i') && !neutralized(el, 'font-style')) return wrap(inner, '*');
  if (tag === 'del' || tag === 's' || tag === 'strike') return wrap(inner, '~~');
  return inner;
}

function inlineChildren(el: Node): string {
  let out = '';
  for (const child of Array.from(el.childNodes)) out += inlineOf(child);
  return out;
}

/** 行内の掃除 ── 行末の空白を落とし、空行の連続を 1 つに畳む。 */
function tidy(s: string): string {
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 段落の行頭が**塊の記号に見える**なら escape する。
 * ⚠ これが無いと、平文で `- 見出し` と書いてあった行が**箇条書きに化ける**。
 */
const BLOCK_START = /^( {0,3})(#{1,6}(?= |$)|>|[-+*](?= )|\d{1,9}[.)](?= )|\||={2,} *$|-{3,} *$)/;

function guardBlockStart(line: string): string {
  const m = BLOCK_START.exec(line);
  if (!m) return line;
  const indent = m[1]!;
  return `${indent}\\${line.slice(indent.length)}`;
}

function paragraph(text: string): Block | null {
  const t = tidy(text);
  if (t === '') return null;
  return { text: t.split('\n').map(guardBlockStart).join('\n'), tight: false };
}

/** `language-ts` / `lang-ts` から言語名を採る(知らない形は空)。 */
function langOf(el: Element): string {
  const cls = el.getAttribute('class') ?? '';
  const m = /(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/.exec(cls);
  return m ? m[1]! : '';
}

function preBlock(el: Element): Block {
  const code = el.querySelector('code');
  const src = code ?? el;
  const lang = langOf(src) || langOf(el);
  // ⚠ **中身は畳まない**(コードは空白が意味を持つ)
  const body = (src.textContent ?? '').replace(/\n+$/, '');
  const runs = body.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return { text: `${fence}${lang}\n${body}\n${fence}`, tight: false };
}

/** `<li>` の先頭のチェックボックス(GFM のタスクリスト)。 */
function taskMark(li: Element): string {
  const box = li.querySelector('input[type="checkbox"]');
  if (!box) return '';
  return box.hasAttribute('checked') || (box as HTMLInputElement).checked === true
    ? '[x] '
    : '[ ] ';
}

function listBlock(el: Element, ordered: boolean): Block | null {
  const items = Array.from(el.children).filter((c) => tagOf(c) === 'li');
  if (items.length === 0) return null;
  const startAttr = Number.parseInt(el.getAttribute('start') ?? '', 10);
  let n = Number.isFinite(startAttr) && startAttr > 0 ? startAttr : 1;
  const lines: string[] = [];
  for (const li of items) {
    const marker = ordered ? `${n}.` : '-';
    n += 1;
    const body = joinBlocks(blocksOf(li));
    const text = `${taskMark(li)}${body}`.trim();
    const pad = ' '.repeat(marker.length + 1);
    const [head = '', ...rest] = text.split('\n');
    // ⚠ 2 行目以降は**記号の幅だけ**字下げする(しないと項目が切れる)
    lines.push([`${marker} ${head}`, ...rest.map((l) => (l === '' ? '' : pad + l))].join('\n'));
  }
  return { text: lines.join('\n'), tight: false };
}

/** 表のセル 1 つ ── `|` を逃がし、改行は空白へ(GFM の行は 1 行で閉じる)。 */
function cellText(el: Element): string {
  return tidy(inlineChildren(el)).replace(/\n+/g, ' ').replace(/\|/g, '\\|');
}

function tableBlocks(el: Element): Block[] {
  const rows: { cells: string[]; head: boolean }[] = [];
  for (const tr of Array.from(el.querySelectorAll('tr'))) {
    const cells = Array.from(tr.children).filter((c) => tagOf(c) === 'td' || tagOf(c) === 'th');
    if (cells.length === 0) continue;
    rows.push({ cells: cells.map(cellText), head: cells.every((c) => tagOf(c) === 'th') });
  }
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => r.cells.length));
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  // 🔴 **見出し行が無い表には空の見出しを足す** ── 先頭行を格上げすると 1 行消える
  const head = rows[0]!.head ? rows.shift()!.cells : Array.from({ length: width }, () => '');
  const out = [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`];
  for (const r of rows) out.push(line(r.cells));
  const caption = el.querySelector('caption');
  const blocks: Block[] = [];
  if (caption) {
    const c = paragraph(inlineChildren(caption));
    if (c) blocks.push(c);
  }
  blocks.push({ text: out.join('\n'), tight: false });
  return blocks;
}

function quoteBlock(el: Element): Block | null {
  const inner = joinBlocks(blocksOf(el));
  if (inner.trim() === '') return null;
  return {
    text: inner
      .split('\n')
      .map((l) => (l === '' ? '>' : `> ${l}`))
      .join('\n'),
    tight: false,
  };
}

function blockOf(el: Element, tag: string): Block[] {
  if (tag === 'hr') return [{ text: '---', tight: false }];
  if (tag === 'pre') return [preBlock(el)];
  if (tag === 'table') return tableBlocks(el);
  if (tag === 'blockquote') {
    const q = quoteBlock(el);
    return q ? [q] : [];
  }
  if (tag === 'ul' || tag === 'ol') {
    const l = listBlock(el, tag === 'ol');
    // ⚠ 入れ子のリストは**空行を空けない**(空けると別のリストに割れる)
    return l ? [{ ...l, tight: true }] : [];
  }
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    const t = tidy(inlineChildren(el)).replace(/\n+/g, ' ');
    return t === '' ? [] : [{ text: `${'#'.repeat(Number(heading[1]))} ${t}`, tight: false }];
  }
  if (tag === 'p' || tag === 'dt' || tag === 'dd' || tag === 'summary' || tag === 'figcaption') {
    const p = paragraph(inlineChildren(el));
    return p ? [p] : [];
  }
  // 入れ物(`div` / `section` / `li` …)は中身をそのまま塊として拾う
  return blocksOf(el);
}

function blocksOf(parent: Node): Block[] {
  const out: Block[] = [];
  let buf = '';
  const flush = (): void => {
    const p = paragraph(buf);
    if (p) out.push(p);
    buf = '';
  };
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 1) {
      const el = child as Element;
      const tag = tagOf(el);
      if (SKIP.has(tag)) continue;
      if (BLOCK.has(tag)) {
        flush();
        out.push(...blockOf(el, tag));
        continue;
      }
    }
    buf += inlineOf(child);
  }
  flush();
  return out;
}

function joinBlocks(blocks: readonly Block[]): string {
  let out = '';
  blocks.forEach((b, i) => {
    if (i > 0) out += b.tight ? '\n' : '\n\n';
    out += b.text;
  });
  return out;
}

/**
 * `text/plain` が「既に markdown 原文」らしいか(保守的に見る)。
 * ⚠ 箇条書きの `- ` 単独は**平文でも頻出**するので根拠にしない ──
 * 根拠にすると、ただの箇条書きを貼っただけで HTML 側の構造を捨てることになる。
 */
export function plainLooksLikeMarkdown(plain: string): boolean {
  if (plain === '') return false;
  return (
    plain.includes('```') ||
    /^#{1,6} \S/m.test(plain) ||
    /^\|[^\n]+\|\s*$/m.test(plain) ||
    /\[[^\]\n]+\]\([^)\s]+\)/.test(plain) ||
    /\*\*[^*\n]+\*\*/.test(plain)
  );
}

/**
 * 解析済みの本体から markdown を組む(空なら `null`)。
 *
 * 🔴 **ここで全体を掃除しない**(2026-08-18 に自分で踏んだ)。初版は最後に
 * `tidy()` を通していたが、あれは**空白の連続を 1 個に畳む** ── コードフェンスの
 * **字下げが消えた**(`  const b = 2;` が左端へ寄る)。掃除は**塊を作るときに
 * 塊ごと**やる(段落は `paragraph`、コードは畳まない)のが正しい。
 * ⚠ 空行の連続を畳むのも同じ理由で全体には掛けられない ── コードの中の空行 3 連は
 * user が書いたものである。塊は `\n\n` か `\n` でしか繋がないので、そもそも増えない。
 */
export function markdownFromBody(body: Element | null): string | null {
  if (!body) return null;
  const text = joinBlocks(blocksOf(body)).trim();
  return text === '' ? null : text;
}

const defaultParse: HtmlParse = (html) => new DOMParser().parseFromString(html, 'text/html');

/**
 * 🔴 **貼付を変換するかどうかの唯一の判定**。`null` = 介入しない(既定の貼付)。
 * ⚠ 判定をここ 1 か所に閉じる ── 呼び側で条件を足すと、PKC2 と同じ
 * 「経路ごとに挙動が違う」形に戻る。
 */
export function convertPastedHtml(
  clip: PastedClipboard,
  parse: HtmlParse = defaultParse,
): string | null {
  const { html, plain } = clip;
  if (html === '' || html.length > PASTE_HTML_MAX) return null;
  if (plainLooksLikeMarkdown(plain)) return null;

  let doc: Document;
  try {
    doc = parse(html);
  } catch {
    return null;
  }
  const body: Element | null = doc.body;
  // 構造も装飾もリンクも無いなら、平文の貼付のほうが正確(escape も増えない)
  if (!body || !body.querySelector(WORTH)) return null;

  const md = markdownFromBody(body);
  if (md === null) return null;
  // ⚠ 平文と同じものを作っただけなら介入しない(undo の段数だけ増える)
  return md === plain.trim() ? null : md;
}
