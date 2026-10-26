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
import { lineStart } from './line-start';
import { FORMAT_OPS } from './text-ops';

export type CompleteKind = 'slash' | 'at';

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
