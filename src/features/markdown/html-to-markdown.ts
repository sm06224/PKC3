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

/**
 * ⚠ **上限は撤廃した**(#492。user 指示 2026-08-27
 * 「**貼付やコードブロックフェンスでアセット埋め込みする際の上限バイトは不要。
 * 現実問題、画像埋め込みのHTMLとか増えてるし、できないのは困る**」)。
 *
 * かつて `PASTE_HTML_MAX = 1MB` を置き、超えた貼付は**1 バイトも読まずに**
 * 平文へ落としていた。⚠ 画像を inline で持つ今どきの Web ページは 1MB を
 * 軽く超えるので、**user は「読めませんでした」しか見られなかった**。
 *
 * 🔑 置いてあった理由は「貼付でメインスレッドを止めない」だが、それは
 *   **こちら側の都合**であって、貼れない理由にはならない ── 重い解析は
 *   ワーカーへ逃がすのが筋である(不可侵指示 2026-08-03。#492 段②)。
 */

/** クリップボードの 2 面。**両方**を見て介入するかを決める。 */
export interface PastedClipboard {
  readonly html: string;
  readonly plain: string;
}

/** 中身を読まない要素(操作子・スクリプト・図形は貼付の役に立たない)。 */
const SKIP = new Set([
  'script', 'style', 'noscript', 'head', 'meta', 'link', 'title', 'template',
  'canvas', 'iframe', 'object', 'embed', 'video', 'audio',
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
  'h1, h2, h3, h4, h5, h6, ul, ol, pre, table, blockquote, hr, a[href], img, svg, code, strong, b, em, i, del, s';

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
export function escapeInline(s: string): string {
  return s
    .replace(/[\\`*[\]]/g, '\\$&')
    .replace(/(^|\s)_/g, '$1\\_')
    .replace(/_(?=\s|$)/g, '\\_');
}

/** 出せない宛先(貼った先で**押すと危ない**もの)。 */
export function isSafeHref(href: string): boolean {
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
  /**
   * 🔴 **裸で出してよいのは、本文の描画が拾い直せる形だけ**(#78、2026-08-22)。
   *
   * ⚠ ここは「見える字と行き先が同じなら `[…](…)` を書かずに URL をそのまま置く」
   * という省略で、**描画側の linkify が拾い直すこと**を前提にしていた。
   * その前提は markdown-it 15 で崩れた ── `fuzzyLink` が既定 off になり、
   * `www.example.com` のような**スキームの無い宛先は自動リンクされない**。
   * 🔑 崩れると症状は「**貼ったリンクが地の文になって消える**」で、
   * 警告も出ない(`markdown-render.ts` の linkify の絞り込みと対の判定である ──
   * CLAUDE.md §7「同じ判定が複数の場所にある」)。
   *
   * 🔑 だから条件を**拾える形に狭める**。拾えないものは `[label](target)` を
   * 書いて残す ── 壊れる向きが「余計な記法が残る」側になり、**宛先は消えない**。
   */
  const linkifyWillCatch = /^https?:\/\//i.test(target);
  if (label === '' || (bare === href.trim() && linkifyWillCatch)) return target;
  return `[${label}](${target})`;
}

function imageOf(el: Element): string {
  const src = el.getAttribute('src') ?? '';
  const alt = collapse(el.getAttribute('alt') ?? '').trim();
  // ⚠ 読めない画像は **alt を文字として**残す(空になるより手がかりが在るほうがよい)
  if (!isSafeHref(src)) return alt === '' ? '' : escapeInline(alt);
  return `![${escapeAssetLabel(alt)}](${escapeAssetTarget(src.trim())})`;
}

/**
 * 🔴 **ページ中の `<svg>` を捨てない**(user 裁定 2026-08-18 の②「OS/容れ物の芯」)。
 *
 * 直す前は `SKIP` に入れて**痕跡なく消して**いた ── 図は知識の一部で、消えたことに
 * 気づけないのがいちばん悪い。⚠ markdown に戻せる形が無いので、**画像として持つ**。
 *
 * 🔑 出すのは `data:image/svg+xml` ── そこから先は #251 で入れた
 * 「埋め込み画像 → 資産」がそのまま拾う(**経路を増やさない**)。
 * ⚠ ベクタのまま持てるので、拡大しても粗くならず書き出しにも乗る
 * (不可侵指示 2026-08-03「SVG は書き出しのときだけ」は**画面に SVG を置かない**話であり、
 *  保存形の話ではない ── 画面に出るのは `<img>` である)。
 *
 * ## 安全
 * ⚠ **`<script>` と `on*` 属性を落とす。** 画面では `<img>` で描くのでスクリプトは
 * 動かないが、**書き出した `.svg` を直接ブラウザで開く**経路が残る ── 容れ物は
 * 持ち出される前提なので、持ち出した先で動く物を入れない。
 * ⚠ 外部を参照する `href` / `xlink:href`(`http`)も落とす ── 開いた先で通信させない。
 */
export function svgImage(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const bad of Array.from(copy.querySelectorAll('script, foreignObject, image'))) {
    bad.remove();
  }
  const strip = (node: Element): void => {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const isRemoteRef =
        (name === 'href' || name.endsWith(':href')) && /^\s*(?:https?:|\/\/)/i.test(attr.value);
      if (name.startsWith('on') || isRemoteRef) node.removeAttribute(attr.name);
    }
    for (const child of Array.from(node.children)) strip(child);
  };
  strip(copy);
  /**
   * ⚠ **名前空間は `XMLSerializer` が自分で付ける**(要素が SVG の名前空間に属するため。
   * 実測で確かめた ── 付け足す 1 行は **no-op** だったので置かない)。
   * ⚠ `outerHTML` への退避経路も持たない ── ここへ来るのは `DOMParser` で解析できた
   * ときだけで、その環境に `XMLSerializer` は必ず在る。**通らない枝を守るふりをしない**。
   */
  const markup = new XMLSerializer().serializeToString(copy);
  if (markup === '') return '';
  // 説明は図の `<title>`(無ければ既定)── 空の alt にしない
  const label = collapse(el.querySelector('title')?.textContent ?? '').trim();
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  return `![${escapeAssetLabel(label === '' ? '図' : label)}](${escapeAssetTarget(url)})`;
}

function inlineOf(node: Node): string {
  if (node.nodeType === 3) return escapeInline(collapse(node.textContent ?? ''));
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = tagOf(el);
  if (SKIP.has(tag)) return '';
  if (tag === 'br') return '\n';
  if (tag === 'img') return imageOf(el);
  // 🔴 図は捨てず、画像として持つ(下の `svgImage` の注記)
  if (tag === 'svg') return svgImage(el);
  // ⚠ チェックボックスは `<li>` 側で見る(ここで文字にすると二重に出る)
  if (tag === 'input') return '';
  if (tag === 'code' || tag === 'kbd' || tag === 'samp') return codeSpan(el);
  if (tag === 'a') return anchorOf(el);

  const inner = inlineChildren(el);
  // ⚠ **行内として読まれた塊**(`<a>` が見出しと段落を抱えるカード等)── 前後に
  //   空白を入れないと `[題名説明](url)` のように**語が繋がる**(実測)
  if (BLOCK.has(tag)) return ` ${inner} `;
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

/**
 * その `<li>` **自身の**チェックボックス(GFM のタスクリスト)。
 *
 * ⚠ **子孫をそのまま見ない**(着地前レビュー E)── 見ると、`- 親` の下に
 * `- [x] 子` がぶら下がる混在リストで**親まで `[x]`** になる(実測で
 * `<li>親<ul><li><input checked>子` が `- [x] 親` になった ── 親はタスクですらない)。
 * ⚠ **直下(`:scope >`)にも縮めない**(検算で判明)── loose な GFM リストは
 * `<li><p><input>…` なので、縮めると**印を丸ごと落とす**。⚠ 主張の向きを変えたら、
 * 反対側で何が壊れるかを必ず見る(CLAUDE.md §1)。
 */
function taskMark(li: Element): string {
  // ⚠ **直下だけでは足りない**(検算で判明)── loose な GFM リストは
  //   `<li><p><input>…` の形なので、直下に絞ると**印を丸ごと落とす**。
  // 🔑 正しい規則は「**その `li` 自身に属する**最初の箱」= いちばん近い `li` が自分。
  const box = Array.from(li.querySelectorAll('input[type="checkbox"]')).find(
    (b) => b.closest('li') === li,
  );
  if (!box) return '';
  return box.hasAttribute('checked') || (box as HTMLInputElement).checked === true
    ? '[x] '
    : '[ ] ';
}

function listBlock(el: Element, ordered: boolean): Block | null {
  const kids = Array.from(el.children).filter((c) => !SKIP.has(tagOf(c)));
  /**
   * ⚠ **`li` が 1 つも無いことがある**(着地前レビュー C)── `<ul><div><li>…` のように
   * 包まれている形。ここで諦めると**リストが丸ごと消える**ので、器として降りる。
   */
  if (!kids.some((c) => tagOf(c) === 'li')) {
    const inner = blocksOf(el);
    return inner.length === 0 ? null : { text: joinBlocks(inner), tight: false };
  }
  const startAttr = Number.parseInt(el.getAttribute('start') ?? '', 10);
  let n = Number.isFinite(startAttr) && startAttr > 0 ? startAttr : 1;
  const lines: string[] = [];
  let pad = '  ';
  for (const kid of kids) {
    const tag = tagOf(kid);
    if (tag === 'ul' || tag === 'ol') {
      /**
       * 🔴 **リストの直下に在る入れ子**(古い HTML / 一部 CMS が出す形)。
       * ⚠ 直す前は `li` しか見ていなかったので、実測で
       * `<ol><li>一</li><ol><li>二</li></ol></ol>` が **`1. 一`** になり
       * **「二」が黙って消えていた**(消える向きの誤差は作らない)。
       * 🔑 直前の項目の**続き**として字下げして足す(見た目は入れ子と同じ)。
       */
      const sub = listBlock(kid, tag === 'ol');
      if (!sub) continue;
      const shifted = sub.text
        .split('\n')
        .map((l) => (l === '' ? '' : pad + l))
        .join('\n');
      if (lines.length === 0) lines.push(shifted);
      else lines[lines.length - 1] += `\n${shifted}`;
      continue;
    }
    if (tag !== 'li') continue;
    const marker = ordered ? `${n}.` : '-';
    n += 1;
    const body = joinBlocks(blocksOf(kid));
    const text = `${taskMark(kid)}${body}`.trim();
    pad = ' '.repeat(marker.length + 1);
    const [head = '', ...rest] = text.split('\n');
    // ⚠ 2 行目以降は**記号の幅だけ**字下げする(しないと項目が切れる)
    lines.push([`${marker} ${head}`, ...rest.map((l) => (l === '' ? '' : pad + l))].join('\n'));
  }
  return lines.length === 0 ? null : { text: lines.join('\n'), tight: false };
}

/**
 * 升 1 つを GFM の表に置ける字にする ── `|` を逃がし、改行は空白へ
 * (GFM の行は 1 行で閉じる)。
 *
 * 🔑 **DOM を取らない形で切り出してある**(#708 段①)── 表のコピー
 * (`table-copy.ts`)は**既に字になった升**を渡してくるので、要素から読む
 * `cellText` とは入口が違う。⚠ 逃げの規則そのものを 2 か所に書くと、
 * 片方だけ `|` を逃がさないまま残る(貼った先で列がずれる = 静かに壊れる向き)。
 */
export function gfmCellText(text: string): string {
  return text.replace(/\n+/g, ' ').replace(/\|/g, '\\|');
}

/** 表のセル 1 つ ── `|` を逃がし、改行は空白へ(GFM の行は 1 行で閉じる)。 */
function cellText(el: Element): string {
  return gfmCellText(tidy(inlineChildren(el)));
}

/**
 * 行の集合を GFM の表にする(空なら `null`)。
 *
 * 🔑 **HTML 貼付と RTF 貼付が同じ規則を使う**ためにここに在る(CLAUDE.md §7)──
 * 別々に書くと、片方だけ「見出しが無い表で 1 行消える」形に戻る。
 * 🔴 **見出し行が無い表には空の見出しを足す** ── 先頭行を格上げすると**データが
 * 1 行消える**。⚠ 幅はいちばん広い行に合わせる(足りない分は空セル)。
 */
export function gfmTable(rows: { cells: string[]; head: boolean }[]): string | null {
  if (rows.length === 0) return null;
  const width = Math.max(...rows.map((r) => r.cells.length));
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const body = [...rows];
  const head = body[0]!.head ? body.shift()!.cells : Array.from({ length: width }, () => '');
  const out = [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`];
  for (const r of body) out.push(line(r.cells));
  return out.join('\n');
}

function tableBlocks(el: Element): Block[] {
  const rows: { cells: string[]; head: boolean }[] = [];
  // ⚠ **自分の行だけ**を拾う(着地前レビュー D)── `querySelectorAll` は子孫すべてを
  //    拾うので、入れ子の表(HTML メール / 表レイアウト)では内側の行が**外側の行と
  //    しても**出て、同じ中身が 2 回入る(実測で `| 外内 |` の下に `| 内 |` が出た)
  for (const tr of Array.from(el.querySelectorAll('tr')).filter(
    (tr) => tr.closest('table') === el,
  )) {
    const cells = Array.from(tr.children).filter((c) => tagOf(c) === 'td' || tagOf(c) === 'th');
    if (cells.length === 0) continue;
    rows.push({ cells: cells.map(cellText), head: cells.every((c) => tagOf(c) === 'th') });
  }
  const table = gfmTable(rows);
  if (table === null) return [];
  const caption = el.querySelector('caption');
  const blocks: Block[] = [];
  if (caption) {
    const c = paragraph(inlineChildren(caption));
    if (c) blocks.push(c);
  }
  blocks.push({ text: table, tight: false });
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

/** `BLOCK` を選択子にしたもの(行内の器が塊を抱えていないか見るため)。 */
const BLOCK_SELECTOR = [...BLOCK].join(',');

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
      /**
       * 🔴 **行内の器が塊を抱えていることがある**(着地前レビュー A)。
       * Google ドキュメントは本文全体を `<b style="font-weight:normal">` で包むので、
       * ここで降りないと `inlineOf` が**区切り無しで連結**する ── 実測で
       * `<b><h1>題</h1><p>あ</p><ul><li>い</li></ul></b>` が **`題あい`** になった
       * (見出しも箇条書きも消え、**語まで繋がる**)。
       * ⚠ `a` は**降りない** ── 降りるとリンクの宛先を失う(記法 1 つ = 動線 1 つ)。
       *   代わりに行内側で空白を入れて、語が繋がるのだけを止める。
       */
      if (tag !== 'a' && el.querySelector(BLOCK_SELECTOR) !== null) {
        flush();
        out.push(...blocksOf(el));
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

/**
 * 🔴 **クリップボードの `text/html` を、そのまま ` ```html ` の囲みにする**
 * (user 要望 2026-08-27)。
 *
 * > 「コピーしたクリップボードを解析すると **utf-8 の html の格納と文字列としての
 * > 格納の 2 種類**がありました / **html のフェンスとしてそれを貼付できれば良い**
 * > のだと思います」
 *
 * ## なぜ「変換」と別の口なのか
 *
 * `convertPastedHtml` は HTML を **PKC-Markdown へ戻す** ── 実測では
 * コードフェンス・入れ子リスト・表・太字とも正しく戻る。⚠ しかし戻せるのは
 * **markdown に在る形だけ**で、色・段組・SVG・凝ったレイアウトは**落ちる**。
 * 🔑 ` ```html ` の囲みは**まさにそれを受けるために在る面**である
 * (`html-sandbox.ts` の冒頭:「AI が吐く複雑 layout / SVG / interactive widget を
 * 受けるための面」)── sandbox iframe + CSP で隔離して描かれる。
 *
 * ⚠ **既定にはしない。** 囲みにすると、あとで直すのが「HTML を編集する」ことになる
 * (誤字 1 つでもタグの中を触る)。設定で選んだときだけ通る。
 *
 * ## ⚠ 囲みの長さは中身で決める
 *
 * HTML の中に ``` が入っていることがある(AI の返答が markdown の説明を
 * 含む場合など)── 3 本で囲むと**そこで囲みが終わる**。中身の最長連を数えて、
 * それより 1 本長い囲みを使う。
 *
 * ## ⚠ 先頭の `<meta charset>` は落とす
 *
 * Chromium はクリップボードの HTML に `<meta charset='utf-8'>` を**必ず前置する**。
 * 箱は `srcdoc` で描くので**この 1 行は効かない**うえ、本文に残ると読みにくい。
 * 🔑 落とすのは**先頭の 1 つだけ**(本文の途中に在るものは user の中身である)。
 */
export function pastedHtmlFence(html: string): string | null {
  if (html === '') return null;
  const body = html.replace(/^\s*<meta[^>]*charset[^>]*>\s*/i, '').trim();
  if (body === '') return null;
  /** 中身の ``` の最長連(0 なら 3 本でよい)。 */
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}html\n${body}\n${fence}`;
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
  if (html === '') return null;
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
