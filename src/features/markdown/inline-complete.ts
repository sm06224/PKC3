/**
 * 🔴 **打ちながら出る補完の一覧**(#1449 `/` 記法パレット / #1450 `@` ノートリンクと日付)── 純関数。
 *
 * ## 決めたこと(2026-10-26、user 指示「全部やる」)
 *
 * 以前は「補完の小窓は作らない」(`Ctrl+/` と `Ctrl+Shift+K` の案内で足りる)と決めていたが、
 * 理由に挙げられていた誤爆を**引き金の条件で潰して**入れる。帯のボタン・`Ctrl+/` ・`Ctrl+Shift+K` ・
 * `Ctrl+;` は**そのまま残す**(入口を増やすだけ。マウスだけで完結する道は変わらない)。
 *
 * - `/` … **行頭だけ**(`A/B` ・ 日付 ・ URL の途中では出ない)。一覧が 0 件になったら閉じる
 *   (`/usr/bin` を打つ人の邪魔をしない)。日本語入力オンの `／` と、`・`(`・` は箇条書きに普通に使うので
 *   **字が続いたときだけ**)も引き金にする。
 * - `(asset:` … 添付の参照(`![名前](asset:…)` / `[名前](asset:…)` / 裸の `(asset:`)を打ち始めたとき(#2001 段 4)。
 *   コードの中では出さない。表の行の中では出す(セルに添付を入れる)。
 * - `@` … **行頭か空白の直後だけ**。直後が数字(`@2026-…` の予定記法)・`[`(`@[card](…)`)のときは出さない。
 *
 * ⚠ **pure module**。DOM も state も知らない(候補の元は呼び手が渡す)。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import { entryPickRows, type EntryPickRow } from '@features/entry-ref/entry-pick';
import { foldText } from '@features/filter/fold-text';
import { DATE_SHORTCUTS, shortcutDate, type DateShortcut } from '@features/schedule/date-shortcuts';
import type { SnippetItem } from '@features/snippet/snippet-table';
import { snippetMenu, type SnippetChoice } from '@features/snippet/snippet-menu';
import { formatAssetRef, isImageAssetMime } from '@features/asset/asset-ref-format';
import { mimeLabel } from '@features/asset/mime-label';
import { humanBytes } from '@features/human-bytes';
import { lineStart } from './line-start';
import { FORMAT_OPS } from './text-ops';

export type CompleteKind = 'slash' | 'at' | 'asset';

export interface CompleteTrigger {
  readonly kind: CompleteKind;
  /** 引き金の字(`/` や `@`)の位置。置き換える範囲は `start`〜caret。 */
  readonly start: number;
  /** 引き金の字のあとに打った字(絞り込みの語)。 */
  readonly query: string;
}

/** 一覧に出す上限(多すぎると目で追えない。足りなければ打って絞る)。 */
export const COMPLETE_LIMIT = 8;

const SLASH_RE = /^[ \t]*([/／・])([^\s]*)$/u;
/** フェンスの開き / 閉じの行(行頭の ``` か ~~~)。 */
const FENCE_LINE_RE = /^[ \t]*(?:```|~~~)/gm;
/** `(asset:` の直後(語は空白・括弧を含まない)。`![](asset:` `[名前](asset:` も、この `(` から始まる。 */
const ASSET_RE = /\(asset:([^\s()]*)$/u;
const AT_RE = /(^|[\s\u3000(（])@([^\s@[\]()（）]*)$/u;

/**
 * caret の直前までの字から、補完の引き金を探す。無ければ `null`。
 * ⚠ 範囲選択中は呼び手が弾く(ここは caret の位置だけを見る)。
 */
export function detectTrigger(value: string, caret: number): CompleteTrigger | null {
  const ls = lineStart(value, caret);
  const line = value.slice(ls, caret);
  /**
   * 🔴 **コードの中・表の行では出さない**(着地前レビュー)。
   * - フェンス(``` / ~~~)の中: caret より前の開きフェンスが奇数。コードの中の `/` や `@` は字そのもの。
   * - 行内コード: caret より前の ` が奇数(同じ行の中)。
   * - 表の行(`|` で始まる行)。
   */
  if ((value.slice(0, ls).match(FENCE_LINE_RE)?.length ?? 0) % 2 === 1) return null;
  if ((line.match(/`/g)?.length ?? 0) % 2 === 1) return null;
  // 添付の参照は表のセルの中でも打つ(`/` と `@` は表の行では出さない)
  const asset = ASSET_RE.exec(line);
  if (asset !== null) {
    const query = asset[1] ?? '';
    return { kind: 'asset', start: ls + line.length - query.length - 'asset:'.length - 1, query };
  }
  if (/^[ \t]*\|/.test(line)) return null;
  const s = SLASH_RE.exec(line);
  if (s !== null) {
    const mark = s[1] ?? '';
    const query = s[2] ?? '';
    // `・` は箇条書きの頭に普通に使う ── 字が続いたときだけ引き金にする
    if (mark === '・' && query === '') return null;
    // 水平線 `---` ・ コメント `//` ・ `/` の連続は引き金ではない
    if (/^[/／・]/u.test(query)) return null;
    return { kind: 'slash', start: ls + line.indexOf(mark), query };
  }
  const a = AT_RE.exec(line);
  if (a !== null) {
    const query = a[2] ?? '';
    // 予定記法 `@2026-10-26`・`@12:00` を打つ手を邪魔しない
    if (/^[0-9０-９]/u.test(query)) return null;
    return { kind: 'at', start: ls + line.length - query.length - 1, query };
  }
  return null;
}

const fold = (s: string): string => foldText(s.normalize('NFKC'));

/** `/` の候補。⚠ 並びは「自分のテンプレート → 書式 → 図」(帯と雛形の一覧と同じ表から引く)。 */
export function slashChoices(items: readonly SnippetItem[], query: string): SnippetChoice[] {
  const base = snippetMenu(items);
  const mine = base.filter((c) => c.kind === 'snippet');
  const diagrams = base.filter((c) => c.kind === 'diagram');
  // ⚠ 書式は表(`FORMAT_OPS`)が正本 ── 見出し ・ 太字なども含め全部並べる
  const formats: SnippetChoice[] = FORMAT_OPS.map((f) => ({ kind: 'format', op: f.op, title: f.label }));
  const q = fold(query);
  const all = [...mine, ...formats, ...diagrams];
  const hit = (c: SnippetChoice): boolean => {
    if (q === '') return true;
    const keys =
      c.kind === 'snippet'
        ? [c.title, c.abbr]
        : c.kind === 'format'
          ? [c.title, c.op]
          : [c.title, c.id];
    return keys.some((k) => fold(k).includes(q));
  };
  return all.filter(hit).slice(0, COMPLETE_LIMIT);
}

/**
 * 🔴 **`/` で呼べる「先に聞く」挿入の道具**(#1982 段 3)。帯の「その他 ▾」・直接出すボタンと**同じ action**(押すと既存の受け手が動く)。
 * ⚠ 字は帯のボタンの字と同じ(`tests/adapter/inline-complete.test.ts` が描いた帯と突き合わせる)。
 * ⚠ 語を打ったときだけ出す(空の `/` の一覧は今までの顔ぶれのまま ── 8 件の枠を道具が奪わない)。
 */
export interface SlashTool {
  readonly action: string;
  readonly label: string;
  /** 打ち分け用の短い綴り(小文字のローマ字・英語)。字でも絞れる。 */
  readonly keys: readonly string[];
}

export const SLASH_TOOLS: readonly SlashTool[] = [
  { action: 'insert-date', label: '日付を入れる', keys: ['date', 'today', 'hizuke'] },
  { action: 'insert-entry-link', label: 'ノートリンクを入れる', keys: ['notelink', 'link', 'wikilink'] },
  { action: 'insert-attachment', label: '添付を入れる', keys: ['attach', 'attachment', 'file', 'image', 'tenpu'] },
  { action: 'insert-icon', label: 'アイコンを入れる', keys: ['icon'] },
];

/** `/` の語に当たる道具。⚠ 語が空なら 0 件(上の注記)。字は含む・綴りは前方一致。 */
export function slashToolChoices(query: string): SlashTool[] {
  const q = fold(query);
  if (q === '') return [];
  return SLASH_TOOLS.filter((t) => fold(t.label).includes(q) || t.keys.some((k) => k.startsWith(q)));
}

export type AtChoice =
  | { readonly kind: 'date'; readonly id: DateShortcut; readonly title: string; readonly date: string }
  | { readonly kind: 'note'; readonly lid: string; readonly title: string; readonly sub: string };

/** `@` の候補。日付(今日・明日…)が先、ノートが後。 */
export function atChoices(
  query: string,
  now: Date,
  entryMetas: ReadonlyMap<string, EntryMeta>,
  order: readonly string[],
  selfLid: string | null,
): AtChoice[] {
  const q = fold(query);
  const dates: AtChoice[] = [];
  for (const d of DATE_SHORTCUTS) {
    if (q !== '' && !fold(d.id).includes(q) && !fold(d.label).includes(q)) continue;
    dates.push({ kind: 'date', id: d.id, title: d.label, date: shortcutDate(d.id, now) });
  }
  const rest = Math.max(0, COMPLETE_LIMIT - dates.length);
  const notes: AtChoice[] = entryPickRows(entryMetas, order, query, selfLid, rest).map(
    (r: EntryPickRow) => ({ kind: 'note', lid: r.lid, title: r.title, sub: r.kind }),
  );
  return [...dates, ...notes];
}

/** 添付の候補 1 件の元(本文の frontmatter から読んだ名前・種類・大きさと、`asset:` の key)。 */
export interface AssetRow {
  readonly lid: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number | null;
  readonly key: string;
}

export interface AssetChoice {
  readonly row: AssetRow;
  /** 右に出す添え書き(種類 · 大きさ)。 */
  readonly sub: string;
}

/**
 * `(asset:` の候補。名前・種類の名前(`PDF` など)に語が含まれるものを、与えられた順のまま `COMPLETE_LIMIT` 件。
 * ⚠ 語が空なら先頭から。
 */
export function assetChoices(rows: readonly AssetRow[], query: string): AssetChoice[] {
  const q = fold(query);
  const out: AssetChoice[] = [];
  for (const row of rows) {
    if (q !== '' && !fold(row.name).includes(q) && !fold(mimeLabel(row.mime)).includes(q)) continue;
    out.push({ row, sub: row.size === null ? mimeLabel(row.mime) : `${mimeLabel(row.mime)} · ${humanBytes(row.size)}` });
    if (out.length >= COMPLETE_LIMIT) break;
  }
  return out;
}

export interface AssetEdit {
  /** 置き換える範囲(欄の位置)と、入れる字。 */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * 選んだ添付を、**参照として正しい 1 つの形**で入れる編集を作る(`formatAssetRef` が唯一の組み立て)。
 * - `![](asset:` `[名前](asset:` と打っていたら、その `[…]` ごと置き換える(ラベルを打っていればそのまま使い、空なら添付の名前)。
 *   画像かどうかは添付の種類で決まる(`[](asset:` と打っても画像なら `!` が付く)。
 * - 裸の `(asset:` は `(` から `![名前](asset:…)` / `[名前](asset:…)` に置き換える。
 * - caret の直後に自動補完の `)` が在れば、それも置き換える(`))` にしない)。
 * @param parenAt 引き金(`(`)の位置 / @param caret 欄の caret
 */
export function assetInsertEdit(value: string, parenAt: number, caret: number, row: AssetRow): AssetEdit {
  const ls = lineStart(value, parenAt);
  const before = value.slice(ls, parenAt);
  const m = /(!?)\[((?:[^\]\\]|\\.)*)\]$/u.exec(before);
  let start = parenAt;
  let label = row.name;
  if (m !== null) {
    start = ls + before.length - m[0].length;
    const typed = (m[2] ?? '').replace(/\\(.)/gu, '$1');
    if (typed.trim() !== '') label = typed;
  }
  const end = value[caret] === ')' ? caret + 1 : caret;
  return { start, end, text: formatAssetRef(label, `asset:${row.key}`, isImageAssetMime(row.mime)) };
}
