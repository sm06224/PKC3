/**
 * 🔴 **外へ書き出す前の点検**(#1966 4-5。🟣 Gemini の裁定 = 案 ①)── 閲覧用 HTML・Markdown・Word・PowerPoint・PDF・
 *   メール下書き・PKC3 入り HTML で外へ渡す前に、次の 3 つを数える。**問題が見つかったときだけ**一覧と
 *   「このまま書き出す / やめる」を出す(何も無ければ今までどおり黙って書き出す)。
 *
 * | 種類 | 何を数えるか |
 * |---|---|
 * | 指定したタグ | 書き出すノートに、確かめるタグ(初期値 `private, 社外秘`)が付いている(文書タグ・本文のタグ) |
 * | リンク切れ | 本文のノートへのリンクのうち、ノートが見つからない(消した・ゴミ箱へ入れた)物 |
 * | 同梱されない添付 | 本文の添付へのリンク(画像でない物は運べない。Markdown 1 件のように画像も運ばない形では画像も) |
 *
 * ⚠ **在るノートへのリンクは数えない**(書き出しに入らなくても)── 普通のリンクを書いたノートを 1 件書き出すたびに
 *   確認が出ると、確認が意味を失う。「書き出した先では開けない」は書き出した後の知らせ(`note-link-notice.ts` /
 *   閲覧用 HTML の注意)が今までどおり言う。
 * 🔑 読み方は既存の正本を使う: タグ `collectEntryTags` / リンク `bodyLinkTargets` / 添付 `assetRefsOf`
 *   (コード・隠しメモの中の字は数えない)。
 * 🔑 pure module。本文の読み出しと確認の画面は adapter(`binder.ts`)が持つ。
 */
import { assetRefsOf } from '../asset/carry-assets';
import { bodyLinkTargets } from '../entry-ref/body-links';
import { collectEntryTags } from '../flavor/entry-tags';
import { normalizeTag, sameTag } from '../flavor/tags';

/** 確かめるタグの初期値(user 裁定 2026-11-16)。 */
export const EXPORT_WATCH_TAGS_DEFAULT: readonly string[] = ['private', '社外秘'];

/**
 * 欄に打った字から、確かめるタグを読む。⚠ 空の字は「確かめない」(初期値に戻さない ── 外したい人が外せる)。
 * 区切りは読点・カンマ・空白。重複は 1 つにする。
 */
export function parseWatchTags(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,、，\s]+/)) {
    const t = normalizeTag(part);
    if (t === '' || out.some((x) => sameTag(x, t))) continue;
    out.push(t);
  }
  return out;
}

/**
 * 保存の形(文字列の配列の JSON)か。⚠ 設定ファイルの取り込みと読み手が同じ判定を使う(読めない値を「入れます」と言わない)。
 */
export function isWatchTagsJson(raw: string): boolean {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === 'string');
  } catch {
    return false;
  }
}

/** 保存された値から、確かめるタグを読む。`null`(まだ決めていない)・読めない形は初期値。 */
export function readWatchTags(raw: string | null): string[] {
  if (raw === null || !isWatchTagsJson(raw)) return [...EXPORT_WATCH_TAGS_DEFAULT];
  return parseWatchTags((JSON.parse(raw) as string[]).join(','));
}

/** 書き出し先が画像を運ぶか(運ばない形 = Markdown 1 件・メール下書き)。 */
export type ExportCarry = 'images' | 'nothing';

export interface ExportCheckNote {
  readonly lid: string;
  readonly title: string;
  readonly body: string;
}

export interface ExportCheckInput {
  readonly notes: readonly ExportCheckNote[];
  /** ノートが(ゴミ箱の外に)在るか。 */
  readonly exists: (lid: string) => boolean;
  readonly watchTags: readonly string[];
  readonly carry: ExportCarry;
  /** いまの容れ物の id(`pkc://<cid>/entry/…` のリンクも数える)。 */
  readonly cid?: string | null;
}

export interface ExportFindings {
  /** タグごとに、付いているノートの題名。 */
  readonly tagged: ReadonlyArray<{ readonly tag: string; readonly titles: readonly string[] }>;
  /** 見つからないノートへのリンクの数と、それを持つノートの題名。 */
  readonly missingLinks: { readonly count: number; readonly titles: readonly string[] };
  /** 書き出した先では開けない添付へのリンク。 */
  readonly assets: { readonly count: number; readonly titles: readonly string[] };
}

export function hasExportFindings(f: ExportFindings): boolean {
  return f.tagged.length > 0 || f.missingLinks.count > 0 || f.assets.count > 0;
}

export function exportFindings(input: ExportCheckInput): ExportFindings {
  const tagged = new Map<string, string[]>();
  const missing = { count: 0, titles: [] as string[] };
  const assets = { count: 0, titles: [] as string[] };
  const title = (n: ExportCheckNote): string => (n.title.trim() === '' ? '(無題)' : n.title);
  for (const n of input.notes) {
    if (input.watchTags.length > 0) {
      const all = collectEntryTags(n.body).all;
      for (const w of input.watchTags) {
        if (!all.some((t) => sameTag(t, w))) continue;
        const list = tagged.get(w) ?? [];
        list.push(title(n));
        tagged.set(w, list);
      }
    }
    let m = 0;
    for (const lid of bodyLinkTargets(n.body, input.cid ?? null)) if (!input.exists(lid)) m += 1;
    if (m > 0) {
      missing.count += m;
      missing.titles.push(title(n));
    }
    const refs = assetRefsOf(n.body);
    const a = refs.others + (input.carry === 'nothing' ? refs.images.length : 0);
    if (a > 0) {
      assets.count += a;
      assets.titles.push(title(n));
    }
  }
  return {
    tagged: input.watchTags.filter((w) => tagged.has(w)).map((w) => ({ tag: w, titles: tagged.get(w)! })),
    missingLinks: missing,
    assets,
  };
}

/**
 * 塊ごとに数えた結果を足し合わせる(全件の書き出しは 200 件ずつ読む)。`a` が `null` なら `b`。
 * ⚠ 同じタグが前後の塊の両方に在れば、題名をつなぐ(後ろの塊の題名を落とさない)。タグの順は先に見つかった順。
 */
export function mergeExportFindings(a: ExportFindings | null, b: ExportFindings): ExportFindings {
  if (a === null) return b;
  const tagged = a.tagged.map((t) => ({
    tag: t.tag,
    titles: [...t.titles, ...(b.tagged.find((x) => sameTag(x.tag, t.tag))?.titles ?? [])],
  }));
  for (const t of b.tagged) if (!a.tagged.some((x) => sameTag(x.tag, t.tag))) tagged.push({ tag: t.tag, titles: [...t.titles] });
  return {
    tagged,
    missingLinks: {
      count: a.missingLinks.count + b.missingLinks.count,
      titles: [...a.missingLinks.titles, ...b.missingLinks.titles],
    },
    assets: { count: a.assets.count + b.assets.count, titles: [...a.assets.titles, ...b.assets.titles] },
  };
}

/** 題名を並べる(多いときは先頭だけ + 件数)。 */
function namesOf(titles: readonly string[], max = 3): string {
  const head = titles.slice(0, max).map((t) => `「${t}」`).join('・');
  return titles.length > max ? `${head} ほか ${titles.length - max} 件` : head;
}

/** 確認の画面に並べる行(問題が無ければ空)。 */
export function exportFindingLines(f: ExportFindings): string[] {
  const lines: string[] = [];
  for (const t of f.tagged) lines.push(`タグ「${t.tag}」が付いたノート: ${namesOf(t.titles)}`);
  if (f.missingLinks.count > 0)
    lines.push(`見つからないノートへのリンク ${f.missingLinks.count} か所: ${namesOf(f.missingLinks.titles)}`);
  if (f.assets.count > 0)
    lines.push(`書き出した先では開けない添付へのリンク ${f.assets.count} か所: ${namesOf(f.assets.titles)}`);
  return lines;
}

/** 確認の画面の頭の 1 文。 */
export const EXPORT_CHECK_LEAD = '書き出す前に、次の点を確かめてください。';
