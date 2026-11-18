/**
 * 🔴 **本文に「既製の表」を置く ── ` ```embed `**(#1966 4-2。user 裁定 2026-11-17 = 案 A+B)。
 *
 * ````
 * ```embed open-tasks range=week
 * ```
 * ```embed recent days=7
 * ```
 * ```embed smart=週次レビュー
 * ```
 * ````
 *
 * と書くと、その場所に**開くたびに最新の表**が出る(ホームノートを作る動線 1 つ = 記法 1 つ)。
 *
 * | 表 | 何が出るか |
 * |---|---|
 * | `open-tasks` | 期日のある未完了のチェック項目(期日を過ぎた物を含む)。`range=today` / `week`(既定)/ `all`(日付なしも) |
 * | `recent` | 直近 N 日に更新したノート(`days=7` が既定。1〜365) |
 * | `smart` | スマートフォルダの中身(`smart=<題名>`。条件は本文に在るので、どの端末でも同じ答え) |
 *
 * ## 🔑 器と鮮度は ` ```sql embed ` と同じ 1 本
 *
 * 描く側(`markdown-render.ts`)は `sql embed` と**同じ器**(`sqlEmbedHostHtml`)に、この表の綴り
 * ({@link EMBED_VIEW_PREFIX} で始まる字)を入れて置く。引く口(`askSqlEmbed`)がその字を見分けて、
 * SQL ではなくこちらの表を作る ── 直列・見えたときだけ・「さらに N 行」・⧉・書き出しへの焼き込み
 * (`bakeSqlEmbeds`)は全部そのまま効く(仕組みを 2 つ持たない)。
 * ⚠ `@` で始まる字は SQL として通らない(字の門が断る)ので、`sql embed` の枠と取り違えない。
 *
 * ## ⚠ ここは features 層 ── 集めない
 *
 * 綴りの読み書き・期日の窓・表の組み立てだけ。走査(`taskScan` / `smartScan`)を呼ぶのは adapter
 * (`embed-view-runner.ts`)で、この module は時計も読まない(`today` / `nowMs` は呼び側が渡す)。
 */
import { buildAgenda, itemOfCard } from '../schedule/agenda';
import { weekOf } from '../schedule/day-layout';
import { materializedDates } from '../schedule/repeat';
import type { TaskCard } from '../schedule/task-cards';
import type { WeekStart } from '../schedule/week-start';
import { formatStoredMinute, storedInstant } from '../datetime/stored-date';
import {
  EMBED_VIEW_PREFIX,
  embedViewSource,
  isEmbedViewInfo,
  SQL_EMBED_FETCH_ROWS, type SqlEmbedAnswer, type SqlEmbedRowLink } from './sql-embed';

export { EMBED_VIEW_PREFIX, embedViewSource, isEmbedViewInfo };

/** 使える表の名前(画面の案内と検査が読む)。 */
export const EMBED_VIEW_NAMES = ['open-tasks', 'recent', 'smart'] as const;
export type EmbedViewName = (typeof EMBED_VIEW_NAMES)[number];

export type OpenTasksRange = 'today' | 'week' | 'all';
const RANGES: readonly OpenTasksRange[] = ['today', 'week', 'all'];

export const RECENT_DAYS_DEFAULT = 7;
export const RECENT_DAYS_MAX = 365;

export type EmbedViewSpec =
  | { readonly view: 'open-tasks'; readonly range: OpenTasksRange }
  | { readonly view: 'recent'; readonly days: number }
  | { readonly view: 'smart'; readonly name: string };

/** 読めなかったときの断り(画面の 1 行にそのまま出す)。 */
export type EmbedViewParse = { readonly ok: true; readonly spec: EmbedViewSpec } | { readonly ok: false; readonly why: string };

/**
 * 語に分ける。⚠ `smart="週次 レビュー"` のように、引用符の中の空白は語を切らない。
 */
function words(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/([^\s"=]+)(?:=(?:"([^"]*)"|(\S*)))?|"([^"]*)"/g)) {
    if (m[4] !== undefined) out.push(m[4]);
    else if (m[2] !== undefined || m[3] !== undefined) out.push(`${m[1]}=${m[2] ?? m[3] ?? ''}`);
    else out.push(m[1]!);
  }
  return out;
}

function keyValue(word: string): [string, string | null] {
  const i = word.indexOf('=');
  return i < 0 ? [word.toLowerCase(), null] : [word.slice(0, i).toLowerCase(), word.slice(i + 1)];
}

const NAMES_TEXT = EMBED_VIEW_NAMES.join(' / ');

/**
 * 見出しの `embed` の後ろ(`open-tasks range=week` / `smart=名前`)を読む。
 * ⚠ 名前の大小は問わない。知らない語は**断る**(黙って既定へ寄せると、打ち間違いに気づけない)。
 */
export function parseEmbedView(text: string): EmbedViewParse {
  const ws = words(text.trim());
  const head = ws[0];
  if (head === undefined) return { ok: false, why: `表の名前がありません。使えるのは ${NAMES_TEXT} です` };
  const [name, inline] = keyValue(head);
  const args = new Map<string, string>();
  for (const w of ws.slice(1)) {
    const [k, v] = keyValue(w);
    if (v === null) return { ok: false, why: `「${w}」は読めません(名前=値 の形で書きます)` };
    args.set(k, v);
  }
  const unknownArg = (allowed: readonly string[]): string | null => {
    for (const k of args.keys()) if (!allowed.includes(k)) return k;
    return null;
  };
  switch (name) {
    case 'open-tasks': {
      const bad = unknownArg(['range']);
      if (bad !== null) return { ok: false, why: `open-tasks に「${bad}」は使えません(使えるのは range)` };
      const r = (args.get('range') ?? 'week').toLowerCase();
      if (!(RANGES as readonly string[]).includes(r))
        return { ok: false, why: `range は today / week / all のどれかです(「${r}」は使えません)` };
      return { ok: true, spec: { view: 'open-tasks', range: r as OpenTasksRange } };
    }
    case 'recent': {
      const bad = unknownArg(['days']);
      if (bad !== null) return { ok: false, why: `recent に「${bad}」は使えません(使えるのは days)` };
      const raw = args.get('days');
      const days = raw === undefined ? RECENT_DAYS_DEFAULT : Number(raw);
      if (!Number.isInteger(days) || days < 1 || days > RECENT_DAYS_MAX)
        return { ok: false, why: `days は 1〜${String(RECENT_DAYS_MAX)} の整数です(「${raw ?? ''}」は使えません)` };
      return { ok: true, spec: { view: 'recent', days } };
    }
    case 'smart': {
      const bad = unknownArg(['name']);
      if (bad !== null) return { ok: false, why: `smart に「${bad}」は使えません(smart=<スマートフォルダの題名> と書きます)` };
      const target = (inline ?? args.get('name') ?? '').trim();
      if (target === '') return { ok: false, why: 'smart=<スマートフォルダの題名> と書きます' };
      return { ok: true, spec: { view: 'smart', name: target } };
    }
    default:
      return { ok: false, why: `「${name}」という表はありません。使えるのは ${NAMES_TEXT} です` };
  }
}

/** 器の字が既製の表か。そうなら見出しの後ろの字を返す(違えば `null`)。 */
export function embedViewTextOf(src: string): string | null {
  return src.startsWith(EMBED_VIEW_PREFIX) ? src.slice(EMBED_VIEW_PREFIX.length) : null;
}

/** 表の上に出す名前(画面と書き出しで同じ字)。 */
export function embedViewTitle(spec: EmbedViewSpec): string {
  switch (spec.view) {
    case 'open-tasks':
      return spec.range === 'today' ? '今日までの未完了' : spec.range === 'week' ? '今週までの未完了' : '未完了のチェック項目(すべて)';
    case 'recent':
      return `直近 ${String(spec.days)} 日に更新したノート`;
    case 'smart':
      return `スマートフォルダ「${spec.name}」`;
  }
}

/** ノートの題名(ゴミ箱・アーカイブ・system のノートは `null` = 表に出さない)。 */
export type TitleOf = (lid: string) => string | null;

function cap(rows: string[][], links: Array<readonly SqlEmbedRowLink[]>): { rows: string[][]; links: Array<readonly SqlEmbedRowLink[]>; truncated: boolean } {
  const truncated = rows.length > SQL_EMBED_FETCH_ROWS;
  return truncated
    ? { rows: rows.slice(0, SQL_EMBED_FETCH_ROWS), links: links.slice(0, SQL_EMBED_FETCH_ROWS), truncated }
    : { rows, links, truncated };
}

/**
 * 🔴 **押したときに塗る字**(着地前レビュー)── 項目の字(`text`)は日付を抜いて継いだ字・200 字で切った字・
 *   記法つきの字なので、**原文の行の部分ではない**ことがある(`- [ ] 会議 @2026-11-20 資料` → 「会議 資料」)。
 *   そのまま「探す」へ渡すと 0 件で、塗りも帯も出ない。
 * 🔑 字がそのまま原文の行に在ればそれを、無ければ**原文の行に在る、いちばん長い切れ端**を使う
 *   (空白・記法の字・切った印 `…` で切る)。⚠ 1 つも無ければ `undefined`(塗らずに開くだけ)。
 */
export function findTermOf(text: string, rawLine: string): string | undefined {
  const t = text.trim();
  // ⚠ 記法の字は塗る相手(描いた本文)に出ないので、記法を含む字はそのまま使わない
  const MARK = /[\s*_~`[\]()…]+/;
  if (t !== '' && !/[*_~`[\]()…]/.test(t) && rawLine.includes(t)) return t;
  let best = '';
  for (const piece of t.split(MARK)) if (piece.length > best.length && rawLine.includes(piece)) best = piece;
  return best === '' ? undefined : best;
}

/**
 * 🔴 **未完了のチェック項目**(`open-tasks`)。読み方は予定表と同じ(`buildAgenda` ── 期間・繰り返し・済んだ回の扱い)。
 *
 * - `today` … 期日が今日まで(過ぎた物を含む)
 * - `week` … 期日が今週の終わりまで(週の始まりは予定表の設定に従う。過ぎた物を含む)
 * - `all` … 期日のある物すべて + 日付なし(末尾)
 *
 * ⚠ 期間・繰り返しの項目は**最初に出る日の 1 行だけ**(同じ行を日ごとに並べない)。
 * ⚠ 期日を過ぎた行は期日の字に「(過ぎています)」を添える(色は使わない ── 書き出しでも読める)。
 */
export function openTasksAnswer(input: {
  readonly cards: readonly TaskCard[];
  readonly titleOf: TitleOf;
  readonly today: string;
  readonly weekStart: WeekStart;
  readonly range: OpenTasksRange;
}): SqlEmbedAnswer {
  const { cards, titleOf, today, range } = input;
  const open = cards.filter((c) => !c.done && titleOf(c.lid) !== null).map(itemOfCard);
  const groups = buildAgenda(open, today, range === 'all', { skip: materializedDates(cards) });
  const week = weekOf(today, input.weekStart);
  const end = range === 'today' ? today : range === 'week' ? (week?.[6] ?? today) : null;
  const raw = new Map(cards.map((c) => [`${c.lid} ${String(c.line)}`, c.rawLine]));
  const seen = new Set<string>();
  const rows: string[][] = [];
  const links: Array<readonly SqlEmbedRowLink[]> = [];
  for (const g of groups) {
    if (g.date !== null && end !== null && g.date > end) continue;
    for (const c of g.cards) {
      const id = `${c.lid} ${String(c.line)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const title = titleOf(c.lid) ?? '';
      let when = '日付なし';
      if (g.date !== null) {
        const day = c.until === null ? g.date : (c.date ?? g.date);
        when = c.time === null ? day : `${day} ${c.time}`;
        if ((c.until ?? c.date ?? g.date) < today) when += '(過ぎています)';
      }
      rows.push([when, c.text, title]);
      const find = findTermOf(c.text, raw.get(id) ?? '');
      links.push([find === undefined ? { col: 1, lid: c.lid } : { col: 1, lid: c.lid, find }, { col: 2, lid: c.lid }]);
    }
  }
  return { columns: ['期日', '項目', 'ノート'], ...cap(rows, links) };
}

/** 🔴 **直近 N 日に更新したノート**(`recent`)。新しい順。⚠ 境目は呼び側が渡す `nowMs`(時計を読まない)。 */
export function recentAnswer(input: {
  readonly notes: ReadonlyArray<{ readonly lid: string; readonly updatedAt: string | null }>;
  readonly titleOf: TitleOf;
  readonly nowMs: number;
  readonly days: number;
}): SqlEmbedAnswer {
  const from = input.nowMs - input.days * 86_400_000;
  const hits: Array<{ lid: string; at: number; stamp: string; title: string }> = [];
  for (const n of input.notes) {
    if (n.updatedAt === null) continue;
    const title = input.titleOf(n.lid);
    if (title === null) continue;
    const at = storedInstant(n.updatedAt)?.getTime();
    if (at === undefined || at < from) continue;
    hits.push({ lid: n.lid, at, stamp: n.updatedAt, title });
  }
  hits.sort((a, b) => b.at - a.at);
  return {
    columns: ['更新', 'ノート'],
    ...cap(
      hits.map((h) => [formatStoredMinute(h.stamp), h.title]),
      hits.map((h) => [{ col: 1, lid: h.lid }]),
    ),
  };
}

/** 🔴 **スマートフォルダの中身**(`smart`)。並びは走査が返した順。 */
export function smartAnswer(input: {
  readonly lids: readonly string[];
  readonly titleOf: TitleOf;
  readonly updatedOf: (lid: string) => string | null;
}): SqlEmbedAnswer {
  const rows: string[][] = [];
  const links: Array<readonly SqlEmbedRowLink[]> = [];
  for (const lid of input.lids) {
    const title = input.titleOf(lid);
    if (title === null) continue;
    rows.push([title, formatStoredMinute(input.updatedOf(lid), '')]);
    links.push([{ col: 0, lid }]);
  }
  return { columns: ['ノート', '更新'], ...cap(rows, links) };
}

/**
 * スマートフォルダを題名で探す。⚠ 前後の空白と大小は問わない。同じ題名が 2 つ以上あれば先頭(並び順)。
 * 見つからなければ `null`。
 */
export function findSmartFolder(
  notes: ReadonlyArray<{ readonly lid: string; readonly title: string; readonly archetype: string; readonly archived: boolean }>,
  name: string,
  smartArchetype: string,
): string | null {
  const want = name.trim().toLowerCase();
  for (const n of notes) {
    if (n.archetype !== smartArchetype || n.archived) continue;
    if (n.title.trim().toLowerCase() === want) return n.lid;
  }
  return null;
}
