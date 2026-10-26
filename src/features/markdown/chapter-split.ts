/**
 * 🔴 **章を新しいノートに切り出す / 元に戻す**(#1439)。
 *
 * ## user がやりたいこと
 *
 * 長くなったノートの 1 つの章を、独立したノートに分けたい(分けても元のノートから辿れる)。
 * 🔑 **自動ではなく、user が章を選んで押す**(自動分割は、他のノートからの見出しリンクを壊し、
 * 戻す道が無い ── #1439 の着陸案 (b))。
 *
 * ## 何が起きるか(本文はこの 2 つだけが変わる)
 *
 * - **新しいノート**: 章の見出しの**下**(次の同段以上の見出しの手前まで)がそのまま本文になる。
 *   題名は見出しの字。見出しの段は変えない(戻したとき 1 字も違わない)。
 * - **元のノート**: 見出しは**残り**、その下は `[見出しの字](entry:<新しいノートの ID> "切り出した章")` の 1 行だけになる。
 *   見出しが残るので、他のノートからの `entry:<元>#h/<見出し>` は今までどおりその見出しへ飛ぶ
 *   (章の中の小見出しへの飛び先だけは新しいノートへ移る)。
 *
 * ## 🔴 片道にしない(元に戻す)
 *
 * 見出しの下が「切り出した章へのリンク 1 行」だけのとき、**切り出した章を元に戻す**が出る。
 * リンクの 1 行を新しいノートの本文で置き換え、新しいノートは削除する(ゴミ箱から戻せる)。
 *
 * 🔑 **pure module**(DOM も保存も知らない)。座標は**生の body の行番号**(frontmatter を含む。0 始まり)。
 */

/**
 * 切り出した章のリンクの印(リンクの title。ホバーにも出る)。
 * 🔴 **印のあるリンクだけを「切り出した章」と読む**: 見出しの下に普通のリンクが 1 行あるだけの章を、
 * 「元に戻す」で別のノートに置き換えて削除する事故を作らない。
 */
export const CHAPTER_LINK_MARK = '切り出した章';

/** 見出しの下が「切り出した章へのリンク」だけの行。`[字](entry:<ID> "切り出した章")` の 1 行。 */
const CHAPTER_LINK = new RegExp(
  `^\\[([^\\]\\n]*)\\]\\(entry:([A-Za-z0-9_-]+) "${CHAPTER_LINK_MARK}"\\)\\s*$`,
);

/** ATX 見出しの行(`## 字`)。setext(下線)形式は 2 行にまたがるので扱わない。 */
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+\S/;

/** 切り出し案。 */
export interface ChapterCut {
  /** 見出しの下の最初の行(生の body。空行を含む)。 */
  readonly start: number;
  /** 章の最後の空でない行(生の body)。 */
  readonly end: number;
  /** `start..end` の行そのもの ── 書くときに disk と byte 一致を確かめる錠。 */
  readonly lines: readonly string[];
  /** 新しいノートの本文(先頭の空行を落とし、終端は改行 1 つ)。 */
  readonly childBody: string;
}

export type ChapterCutResult =
  | { readonly ok: true; readonly cut: ChapterCut }
  | { readonly ok: false; readonly reason: string };

/**
 * 切り出す範囲を決める。
 *
 * @param body 生の body(frontmatter を含む)
 * @param headingLine 見出しの行(生の body。0 始まり)
 * @param spanEnd 章の最後の行(生の body。両端含む。`chapterSpan` の `end` + frontmatter の行数)
 */
export function planChapterCut(body: string, headingLine: number, spanEnd: number): ChapterCutResult {
  const rows = body.split('\n');
  const head = rows[headingLine];
  if (head === undefined || !ATX_HEADING.test(head)) {
    return {
      ok: false,
      reason: 'この見出しは下線の書き方(=== や ---)なので、切り出せません(# で書き直すと切り出せます)',
    };
  }
  let end = Math.min(spanEnd, rows.length - 1);
  while (end > headingLine && rows[end]!.trim() === '') end -= 1;
  if (end <= headingLine) return { ok: false, reason: 'この章には本文が無いので、切り出せません' };
  const start = headingLine + 1;
  const lines = rows.slice(start, end + 1);
  const content = lines.filter((l) => l.trim() !== '');
  if (content.length === 1 && CHAPTER_LINK.test(content[0]!.trim())) {
    return { ok: false, reason: 'この章はすでに切り出してあります(「切り出した章を元に戻す」で戻せます)' };
  }
  // コードブロック(``` / ~~~)が閉じていない切り出しは、新しいノートの本文を壊す
  let fence: string | null = null;
  for (const l of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (m === null) continue;
    const mark = m[1]![0]!;
    if (fence === null) fence = mark;
    else if (fence === mark) fence = null;
  }
  if (fence !== null) {
    return { ok: false, reason: 'この章の中に閉じていないコードブロックがあるので、切り出せません' };
  }
  const trimmed = lines.slice(lines.findIndex((l) => l.trim() !== ''));
  return { ok: true, cut: { start, end, lines, childBody: `${trimmed.join('\n')}\n` } };
}

/** 元に残すリンクの 1 行。字の中の `[` `]` は外す(リンクが壊れる)。 */
export function chapterLinkLine(title: string, lid: string): string {
  const text = title.replace(/[[\]\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return `[${text === '' ? '章' : text}](entry:${lid} "${CHAPTER_LINK_MARK}")`;
}

/**
 * 元の本文へ当てる。`start..end` が錠(`lines`)と一致しなければ `null`(断る ── 別の窓が書き換えた形)。
 * 先頭の空行(見出しとの間)は残し、その下を 1 行のリンクに置き換える。
 */
export function applyChapterSplit(
  body: string,
  rw: { readonly start: number; readonly end: number; readonly lines: readonly string[]; readonly link: string },
): string | null {
  const rows = body.split('\n');
  if (rw.start < 0 || rw.end < rw.start || rw.end >= rows.length) return null;
  const now = rows.slice(rw.start, rw.end + 1);
  if (now.length !== rw.lines.length || now.some((l, i) => l !== rw.lines[i])) return null;
  const lead = now.findIndex((l) => l.trim() !== '');
  const kept = rows.slice(rw.start, rw.start + Math.max(0, lead));
  rows.splice(rw.start, rw.end - rw.start + 1, ...kept, rw.link);
  return rows.join('\n');
}

/** 切り出した章へのリンク。 */
export interface ChapterLink {
  /** リンクの行(生の body。0 始まり)。 */
  readonly line: number;
  /** 行そのもの(錠)。 */
  readonly text: string;
  /** 切り出した先のノートの ID。 */
  readonly lid: string;
}

/**
 * 見出しの下が「切り出した章へのリンク 1 行」だけなら、その行を返す。そうでなければ `null`。
 *
 * @param headingLine 見出しの行(生の body)
 * @param spanEnd 章の最後の行(生の body。両端含む)
 */
export function chapterLinkUnder(body: string, headingLine: number, spanEnd: number): ChapterLink | null {
  const rows = body.split('\n');
  const end = Math.min(spanEnd, rows.length - 1);
  let found: ChapterLink | null = null;
  for (let i = headingLine + 1; i <= end; i += 1) {
    const row = rows[i]!;
    if (row.trim() === '') continue;
    const m = CHAPTER_LINK.exec(row.trim());
    if (m === null || found !== null) return null;
    found = { line: i, text: row, lid: m[2]! };
  }
  return found;
}

/**
 * リンクの 1 行を、切り出した章の本文で置き換える(元に戻す)。
 * `line` が `openLine` と一致しなければ `null`(断る)。
 */
export function applyChapterRestore(
  body: string,
  rw: { readonly line: number; readonly openLine: string; readonly text: string },
): string | null {
  const rows = body.split('\n');
  if (rows[rw.line] !== rw.openLine) return null;
  const text = rw.text.replace(/\n+$/, '');
  rows.splice(rw.line, 1, ...text.split('\n'));
  return rows.join('\n');
}
