/**
 * P7 段②: **素の `.md` を 1 件受け取って entry にする**(設計 doc §1)。
 *
 * 🔑 **md ZIP(段④ の書出し)の逆ではない**。あちらは「フォルダごと」、
 * これは「1 ファイル」── 混ぜると「どっちの経路で壊れたか」が分からなくなる
 * (裁定 §5-4)。フォルダ取込(`assets/` の解決込み)は別の段。
 *
 * ⚠ **本文は原文のまま**。frontmatter を parse し直して再構築しない ── P6d 段④ で
 * 踏んだ規律(`parseFrontmatter` + `serializeFrontmatter` の往復は入れ子 mapping /
 * block scalar / コメントを落とし、16KB 級の frontmatter では body を消し飛ばした)。
 * ここで parse するのは **題名と archetype を読むためだけ**で、書き戻さない。
 */
import { parseFrontmatter } from '@features/markdown/frontmatter';
import { getFlavor } from '@features/flavor';

/** `file_handlers` が宣言する拡張子。⚠ manifest と parity test で縛る。 */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'] as const;

/** 題名の上限。1 行に 100 万字の「題名」を作らせない(本文は原文のまま残る)。 */
const TITLE_MAX = 200;

export interface PlainMarkdownEntry {
  title: string;
  archetype: string;
  /** **原文のまま**(frontmatter を含む)。 */
  body: string;
  /** 解決しない相対パス参照(`![](images/a.png)` など)の重複除去済み一覧。 */
  unresolvedRefs: string[];
  /** 可視化する注意。空 = 何も言うことがない。 */
  warnings: string[];
}

/** 拡張子で md か判定する。⚠ 中身では判定しない ── **どんなテキストも md として妥当**。 */
export function isMarkdownFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** ファイル名 → 題名候補(ディレクトリと拡張子を落とす)。 */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const lower = base.toLowerCase();
  const ext = MARKDOWN_EXTENSIONS.find((e) => lower.endsWith(e));
  return (ext ? base.slice(0, -ext.length) : base).trim();
}

/**
 * 本文の先頭 ATX 見出し(`# 見出し`)を拾う。
 *
 * ⚠ **fence の中は見出しではない**。``` で囲まれた `# comment` を題名にすると、
 * shell script を貼った md が全部「# !/bin/bash」になる。
 * ⚠ setext(`題名\n===`)は拾わない ── 拾う判定を増やすほど「どれで決まったか」が
 * 説明できなくなる。宣言した規則(doc §1)は ATX だけである。
 */
export function firstHeading(body: string): string | null {
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMark) {
      const mark = fenceMark[1]!;
      if (fence === null) fence = mark[0]!;
      else if (mark[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const atx = /^ {0,3}#{1,6}(?:\s+(.*))?$/.exec(line);
    if (atx) {
      // 閉じ `#` を落とす(`# 題名 ###`)。`#` だけの行は題名なしとして次を見ない
      const text = (atx[1] ?? '').replace(/\s+#+\s*$/, '').trim();
      return text === '' ? null : text;
    }
  }
  return null;
}

/** 相対パス参照(解決しない)を数える。⚠ 数えるだけで、本文は書き換えない。 */
function scanUnresolvedRefs(text: string): string[] {
  const found = new Set<string>();
  // `](dest)` の dest だけを見る(狭く当てる)。`<...>` 形も受ける
  for (const m of text.matchAll(/\]\(\s*(?:<([^>]*)>|([^)\s]+))/g)) {
    const dest = (m[1] ?? m[2] ?? '').trim();
    if (dest === '') continue;
    // 外部 URL / 内部 anchor / 既に解決済みの添付参照は「未解決」ではない
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(dest) || dest.startsWith('#') || dest.startsWith('//')) {
      continue;
    }
    found.add(dest);
  }
  return [...found];
}

/**
 * 素の markdown 1 件を entry の材料にする。**純関数**(I/O も採番もしない)。
 *
 * @param text ファイルの中身(原文)
 * @param fileName 題名の最終候補。拡張子とディレクトリは落とす
 */
export function readPlainMarkdown(text: string, fileName: string): PlainMarkdownEntry {
  const warnings: string[] = [];
  const parsed = parseFrontmatter(text);
  // ⚠ cap 超過などで parse を諦めたときは `meta: {}` で返る ── **黙らせない**。
  // 題名や archetype が frontmatter にあるのに使われなかった、が静かに起きる
  for (const w of parsed.warnings) warnings.push(`frontmatter: ${w.detail}`);

  const metaTitle = parsed.meta['title'];
  const heading = firstHeading(parsed.body);
  const fromName = titleFromFileName(fileName);
  const rawTitle =
    (typeof metaTitle === 'string' && metaTitle.trim() !== '' ? metaTitle.trim() : null) ??
    heading ??
    (fromName !== '' ? fromName : null) ??
    '無題';
  const title =
    rawTitle.length > TITLE_MAX ? `${rawTitle.slice(0, TITLE_MAX - 1)}…` : rawTitle;

  // archetype は**登録済みのものだけ**受ける。未知の値をそのまま入れると
  // 「flavor が text fallback で動くのに、entry には嘘の archetype が残る」
  const metaArchetype = parsed.meta['archetype'];
  let archetype = 'text';
  if (typeof metaArchetype === 'string' && metaArchetype !== '') {
    if (getFlavor(metaArchetype).archetype === metaArchetype) archetype = metaArchetype;
    else warnings.push(`未知の archetype "${metaArchetype}" は text として取り込みました`);
  }

  const unresolvedRefs = scanUnresolvedRefs(text);
  if (unresolvedRefs.length > 0) {
    // 🔑 **件数で言う**(doc §1)。単一 md は添付を持ってこないので、参照は原文の
    // まま残る ── 黙って残すと「画像が出ない」だけが user に見える
    warnings.push(
      `画像・ファイルへの参照 ${unresolvedRefs.length} 件は解決していません(単一 md は添付を含みません): ${unresolvedRefs.slice(0, 5).join(', ')}${unresolvedRefs.length > 5 ? ' …' : ''}`,
    );
  }

  // ⚠ body は **text そのもの**。`parsed.body` ではない(あれは frontmatter を
  // 落としたうえ CRLF まで正規化されている ── 原文のままにならない)
  return { title, archetype, body: text, unresolvedRefs, warnings };
}
