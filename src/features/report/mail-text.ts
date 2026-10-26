/**
 * 🔴 **ノートの本文を、そのままメールに貼れる字にする**(#1459 段②「コピペしてすぐ送れるメール下書き」)。
 *
 * > user の物語:週報のノートに、各ノートの章を `![](entry:…#h/…)` で集め、入力欄に今週の数を入れた。
 * > これを**メールの本文に貼って送りたい** ── Markdown の記号(`##` `**` `|---|`)や、ノートの中でしか意味の無い
 * > リンク(`entry:…`)がそのまま混ざらない、読める字で。
 *
 * ## 作り
 *
 * 1. 章の参照を原文で展開する(`flattenSectionEmbeds`。画面で出ていた章が空にならない)── 呼び側
 * 2. `{{vars.x}}` を元のノートの設定欄の値で出す(`expandDefinedVars`)
 * 3. Markdown の記号を字に直す:見出し・箇条書き・チェック・表(csv / tsv / psv の囲みも)・リンク・画像・強調・
 *    `:::` の囲み・入力欄の定義(項目: 値 の行にする)
 *
 * ⚠ **推測で書き換えない**:読み方が分からない物(未知の囲み、表にできない行)は原文の字のまま残す
 *   (黙って落とさない)。⚠ pure。画面の描画器は使わない(HTML を字へ戻すより、原文から直接直す方が
 *   記号の意味を取り違えない)。
 */
import { bodyBelowFrontmatter, extractVars } from '../markdown/frontmatter';
import { expandDefinedVars } from '../markdown/var-expand';
import { fenceStep } from '../markdown/list-renumber';
import { DELIMITER, detectCsvLang, isHeaderDisabled, parseCsv } from '../markdown/csv-table';
import { isCheckedValue, isFormInfo, parseFormDef, FORM_EMPTY_TEXT } from '../markdown/form-def';

/** 全角・半角を考えた表示の幅(CJK は 2)。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

/** 表を字で揃える。⚠ 長い升は折り返さない(メールの幅は受け手が決める)。 */
export function gridToText(rows: readonly (readonly string[])[], headerRow = true): string[] {
  if (rows.length === 0) return [];
  const clean = rows.map((r) => r.map((c) => c.replace(/\s*\n\s*/gu, ' ').trim()));
  const cols = clean.reduce((m, r) => Math.max(m, r.length), 0);
  const widths = Array.from({ length: cols }, (_, i) => clean.reduce((m, r) => Math.max(m, displayWidth(r[i] ?? '')), 0));
  const line = (r: readonly string[]): string =>
    widths
      .map((w, i) => pad(r[i] ?? '', w))
      .join(' | ')
      .replace(/\s+$/u, '');
  const out = clean.map(line);
  if (headerRow && clean.length > 1) out.splice(1, 0, widths.map((w) => '-'.repeat(Math.max(1, w))).join('-+-'));
  return out;
}

/** 生の HTML として落とすタグ名(これ以外の `<…>` は字として残す ── `a<b and c>d` を壊さない)。 */
const KNOWN_TAGS =
  'a|abbr|b|big|blockquote|br|caption|center|cite|code|col|colgroup|dd|del|details|dfn|div|dl|dt|em|font|h[1-6]|hr|i|img|ins|kbd|label|li|mark|ol|p|pre|q|s|samp|small|span|strike|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|tr|tt|u|ul|var|video|audio|source|figure|figcaption|section|article|aside|header|footer|nav|iframe|svg|path';
// ⚠ 属性は `名前=値` の形だけ受ける(`a<b and c>d` の「b and c」を属性つきのタグと読まない)
const KNOWN_TAG_RE = new RegExp(
  `</?(?:${KNOWN_TAGS})(?:\\s+[\\w:-]+=(?:"[^"]*"|'[^']*'|[^\\s>"']+))*\\s*/?>`,
  'giu',
);

/**
 * インラインの記号を字に直す。
 *
 * 🔴 **インラインコードを先に退避する**(中の `**` や `[a](b)` を剥がさない)。⚠ 強調の記号は**中身の端が空白でないときだけ**
 *   外す(`2 * 3 * 4` や `a == b == c` の記号は演算子 ── 字のまま残す)。`__init__` のような識別子(単語だけの `__…__`)も残す。
 */
export function inlineToText(s: string): string {
  const keep: string[] = [];
  let t = s.replace(/(`+)([^`\n]+?)\1/gu, (_m, _q: string, code: string) => {
    keep.push(code);
    return `\uE000${String(keep.length - 1)}\uE001`;
  });
  // 画像 → [画像: alt]
  t = t.replace(/!\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_m, alt: string) =>
    alt.trim() === '' ? '[画像]' : `[画像: ${alt.trim()}]`,
  );
  // リンク
  t = t.replace(/\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_m, label: string, url: string) => {
    const l = label.replace(/\\(.)/gu, '$1').trim();
    if (/^(https?:|mailto:|tel:)/iu.test(url)) {
      const bare = url.replace(/^(mailto:|tel:)/iu, '');
      return l === '' || l === url || l === bare ? bare : `${l} (${bare})`;
    }
    if (url.startsWith('asset:')) return l === '' ? '[添付]' : `[添付: ${l}]`;
    return l; // entry: / pkc: / # などは、ノートの外では開けない ── 字だけ残す
  });
  // 強調など(対になっていて、中身の端が空白でないものだけ)
  t = t.replace(/\*\*(?=\S)([^*\n]*[^*\s])\*\*/gu, '$1');
  t = t.replace(/(^|[^\w])__(?=\S)([^_\n]*[^_\s])__(?![\w])/gu, (m, pre: string, inner: string) =>
    /^\w+$/u.test(inner) ? m : `${pre}${inner}`,
  );
  t = t.replace(/~~(?=\S)([^~\n]*[^~\s])~~/gu, '$1');
  t = t.replace(/==(?:\[[a-z]+\])?(?=\S)([^=\n]*[^=\s])==/gu, '$1');
  t = t.replace(/(^|[^*\w])\*(?=\S)([^*\n]*[^*\s])\*(?![*\w])/gu, '$1$2');
  // 生の HTML の印は、知っているタグ名だけ落とす
  t = t.replace(KNOWN_TAG_RE, '');
  return t.replace(/\uE000(\d+)\uE001/gu, (_m, i: string) => keep[Number(i)] ?? '');
}

const HEADING_MARK = ['【', '■ ', '▼ ', '● ', '● ', '● '];

/** 表の行(`| a | b |`)か。 */
const PIPE_ROW = /^\s*\|.*\|\s*$/u;
const PIPE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/u;

function pipeCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * ノートの本文(frontmatter 込み)を、メールに貼れる字にする。
 * @param body 章の参照を展開した後の本文が望ましい(呼び側 = `flattenSectionEmbeds`)
 */
export function markdownToMailText(body: string): string {
  const vars = extractVars(body);
  const src = expandDefinedVars(bodyBelowFrontmatter(body), vars);
  const lines = src.split(/\r?\n/u);
  const out: string[] = [];
  let fence = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const st = fenceStep(fence, line);
    // ── 囲み(コード / csv / 入力欄 ...)
    if (fence === '' && st.inside) {
      const open = /^(\s*)(`{3,}|~{3,})(.*)$/u.exec(line);
      const info = (open?.[3] ?? '').trim();
      const marker = open?.[2] ?? '```';
      const content: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j += 1) {
        const l = lines[j]!;
        if (new RegExp(`^\\s*${marker[0]}{${String(marker.length)},}\\s*$`, 'u').test(l)) {
          closed = true;
          break;
        }
        content.push(l);
      }
      fence = '';
      const lang = detectCsvLang(info);
      if (lang !== null) {
        const grid = parseCsv(content.join('\n'), DELIMITER[lang]);
        if (grid !== null) out.push(...gridToText(grid, !isHeaderDisabled(info)));
      } else if (isFormInfo(info)) {
        const def = parseFormDef(content.join('\n'));
        if (def.title !== '') out.push(def.title);
        for (const f of def.fields) {
          const raw = vars[f.name];
          const v = f.type === 'checkbox' ? (isCheckedValue(raw) ? 'はい' : 'いいえ') : raw === undefined || raw === '' ? FORM_EMPTY_TEXT : raw;
          out.push(`${f.label}: ${v}`);
        }
      } else {
        // コード・図・その他の囲みは、中身の字をそのまま残す(記号の柵だけ落とす)
        out.push(...content);
      }
      i = closed ? j + 1 : j;
      continue;
    }
    fence = st.next;
    // ── コメント行・囲みの印
    if (/^\s*:::/u.test(line)) {
      const summary = /^\s*:::details\{[^}]*summary=([^}\s]+)[^}]*\}/u.exec(line);
      if (summary !== null) out.push(summary[1]!);
      i += 1;
      continue;
    }
    // ── markdown の表
    if (PIPE_ROW.test(line) && i + 1 < lines.length && PIPE_SEP.test(lines[i + 1]!)) {
      const rows: string[][] = [pipeCells(line)];
      let j = i + 2;
      while (j < lines.length && PIPE_ROW.test(lines[j]!)) {
        rows.push(pipeCells(lines[j]!));
        j += 1;
      }
      out.push(...gridToText(rows.map((r) => r.map(inlineToText)), true));
      i = j;
      continue;
    }
    // ── 見出し
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (h !== null) {
      const level = h[1]!.length;
      const text = inlineToText(h[2]!);
      out.push(level === 1 ? `【${text}】` : `${HEADING_MARK[level - 1]!}${text}`);
      i += 1;
      continue;
    }
    // ── 水平線
    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) {
      out.push('----------');
      i += 1;
      continue;
    }
    // ── 引用
    const q = /^(\s*(?:>\s?)+)(.*)$/u.exec(line);
    if (q !== null) {
      out.push(`${q[1]!.replace(/\s+/gu, '').replace(/>/gu, '> ')}${inlineToText(q[2]!)}`.replace(/\s+$/u, ''));
      i += 1;
      continue;
    }
    // ── 箇条書き / チェック / 番号
    const li = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/u.exec(line);
    if (li !== null) {
      const indent = li[1]!;
      const bullet = /^\d/u.test(li[2]!) ? li[2]! : li[3] === undefined ? '・' : li[3] === ' ' ? '☐' : '☑';
      out.push(`${indent}${bullet} ${inlineToText(li[4]!)}`);
      i += 1;
      continue;
    }
    out.push(inlineToText(line).replace(/\s+$/u, ''));
    i += 1;
  }
  // 空行は 2 つまで(囲みの印を落とした跡の空行が続かないように)
  return out.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/^\n+/u, '').replace(/\s+$/u, '') + '\n';
}

/** 件名つきの下書き。 */
export function mailDraftText(title: string, body: string): string {
  const subject = title.replace(/\s+/gu, ' ').trim();
  return `件名: ${subject}\n\n${markdownToMailText(body)}`;
}
