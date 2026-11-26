/**
 * 🔴 **ウィジェットの状態を、ノートの本文へ書き残す記法**(v4.0 Phase 2 / PR-08、ビジョン 5-B)。
 *
 * ## 記法(プレーンな Markdown が正本 ── 完全に持ち運べる)
 *
 * ```` ```json widget-state="<widgetId>" ```` の囲みに、`Record<string, string>` の JSON を書く。
 * ⚠ **ただの JSON のコードブロック**なので、古い PKC3・外部のエディタ・書き出した HTML でもそのまま読める。
 *
 * ## 何に使うか
 *
 * ウィジェットの保存は端末の `localStorage` にしか無い(PR-07)── 別の端末へ同期した直後・単体 HTML へ書き出した先では
 * 0 件から始まる。user が親の「ノートへ保存」を**明示的に押したとき**だけ、ここへ 1 回書き残す。
 * 起動時は「端末の保存が 0 件なら、本文のこのブロックを初期値にする」(`widget-bridge.ts` の `resolveWidgetSeed`)。
 *
 * ## 🔴 不変条件
 *
 * - 書くのは**親の UI の明示的な操作**(「ノートへ保存」「状態を初期化」)だけ。ウィジェット(箱)から書く口は無い。
 * - 読むのは**値が全部文字列の JSON オブジェクト**だけ ── 壊れた JSON・文字列以外の値は丸ごと無視(`null`)。
 * - 他のブロックの原文は 1 バイトも変えない(差し替えるのは対象の囲みの行だけ)。
 * - 大きさは {@link WIDGET_STATE_BLOCK_LIMIT} まで ── 超えるなら断って、本文を太らせない。
 * - 見るのは**最上位**(引用・リストの外)の囲みだけ。前書き(frontmatter)の中は見ない。
 */
import { allFences, fenceInfo, splitLines, type FenceSpan } from './source-blocks';
import { frontmatterLineCount } from './frontmatter';
import { WIDGET_ID_RE, parseWidgetId } from './widget-bridge';

/**
 * 囲みを前書きの下から数える(`table-convert.ts` の `fencesBelowFrontmatter` と同じ規則)。
 * ⚠ ここで `table-convert.ts` を import しない ── あちらは `markdown-render.ts` を読み、`markdown-render.ts` は
 *   書き出しの初期値のためにここを読む(循環させない)。
 */
function fencesBelowFm(body: string): readonly FenceSpan[] {
  const fm = frontmatterLineCount(body);
  if (fm === 0) return allFences(body);
  let offset = 0;
  for (let i = 0; i < fm; i++) {
    const next = body.indexOf('\n', offset);
    if (next === -1) return [];
    offset = next + 1;
  }
  return allFences(body.slice(offset)).map((f) => ({ ...f, start: f.start + fm, end: f.end + fm }));
}

/** 柵の長さ(中身の行頭の ` の並びより 1 本長く。最低 3)。 */
function fenceMarkerFor(content: string): string {
  let longest = 0;
  for (const l of splitLines(content)) {
    const m = /^\s*(`+)/.exec(l);
    if (m !== null) longest = Math.max(longest, m[1]!.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** 本文に書き残す状態の上限(JSON の字数。64 KB)。 */
export const WIDGET_STATE_BLOCK_LIMIT = 64 * 1024;

/** 囲みの見出しの印(` ```json widget-state="…" `)。 */
export const WIDGET_STATE_INFO_KEY = 'widget-state';

/** 囲みの見出しから、状態ブロックの widgetId を読む(状態ブロックでなければ `null`)。 */
export function widgetStateBlockId(info: string | null | undefined): string | null {
  if (!info) return null;
  const m = /^json\s+(?:[^\n]*\s)?widget-state\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/i.exec(info.trim());
  if (m === null) return null;
  const id = m[1] ?? m[2] ?? m[3] ?? '';
  return WIDGET_ID_RE.test(id) ? id : null;
}

/**
 * 囲みの見出しから、**ウィジェット本体**の id を読む(` ```html id="x" ` / ` ```react id="x" ` / ` ```jsx id="x" `)。
 * ⚠ 状態ブロック(` ```json widget-state= `)は本体ではない。
 */
export function widgetFenceId(info: string | null | undefined): string | null {
  if (!info) return null;
  const t = info.trim();
  const sp = t.search(/\s/);
  const head = (sp < 0 ? t : t.slice(0, sp)).toLowerCase().replace(/-(render|both)$/, '');
  if (head !== 'html' && head !== 'react' && head !== 'jsx') return null;
  return parseWidgetId(sp < 0 ? '' : t.slice(sp + 1));
}

interface StateFence {
  readonly span: FenceSpan;
  readonly id: string;
}

/** 最上位の、閉じている囲みだけ(引用の中・閉じていない囲みは触らない ── 下の本文を飲まない)。 */
function topFences(body: string, lines: readonly string[]): { span: FenceSpan; info: string }[] {
  const out: { span: FenceSpan; info: string }[] = [];
  for (const span of fencesBelowFm(body)) {
    if (span.quote !== 0 || span.open) continue;
    const open = lines[span.start] ?? '';
    // ⚠ 字下げした囲み(リストの中)も外す ── 書き戻しの字下げを持ち回らない
    if (/^\s/.test(open)) continue;
    const info = fenceInfo(open);
    if (info === null) continue;
    out.push({ span, info });
  }
  return out;
}

function stateFences(body: string, lines: readonly string[]): StateFence[] {
  const out: StateFence[] = [];
  for (const { span, info } of topFences(body, lines)) {
    const id = widgetStateBlockId(info);
    if (id !== null) out.push({ span, id });
  }
  return out;
}

/** JSON の字を、値が全部文字列のオブジェクトとして読む(読めなければ `null`)。 */
export function parseWidgetStateJson(text: string): Readonly<Record<string, string>> | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return null;
    out[k] = val;
  }
  return out;
}

/**
 * 🔴 **本文から、そのウィジェットの状態ブロックを読む**。無い・壊れている・値が文字列でない → `null`。
 * ⚠ 同じ id のブロックが 2 つ以上あれば**最初の 1 つ**(書く側も最初の 1 つを差し替える)。
 */
export function readWidgetStateBlock(body: string, widgetId: string): Readonly<Record<string, string>> | null {
  if (!body.includes(WIDGET_STATE_INFO_KEY)) return null;
  const lines = splitLines(body);
  const hit = stateFences(body, lines).find((f) => f.id === widgetId);
  if (hit === undefined) return null;
  return parseWidgetStateJson(lines.slice(hit.span.start + 1, hit.span.end).join('\n'));
}

/** 本文の中の状態ブロックを全部(id → 状態)。壊れたブロックは入れない。書き出し・プレビューの初期値に使う。 */
export function allWidgetStateBlocks(body: string): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const out = new Map<string, Readonly<Record<string, string>>>();
  if (!body.includes(WIDGET_STATE_INFO_KEY)) return out;
  const lines = splitLines(body);
  for (const f of stateFences(body, lines)) {
    if (out.has(f.id)) continue;
    const st = parseWidgetStateJson(lines.slice(f.span.start + 1, f.span.end).join('\n'));
    if (st !== null) out.set(f.id, st);
  }
  return out;
}

/** 本文に、そのウィジェットの状態ブロックが(読める・読めないを問わず)在るか。 */
export function hasWidgetStateBlock(body: string, widgetId: string): boolean {
  if (!body.includes(WIDGET_STATE_INFO_KEY)) return false;
  return stateFences(body, splitLines(body)).some((f) => f.id === widgetId);
}

/** 書く JSON(鍵を並べ替える ── 同じ状態は同じ字。差分が読める)。 */
export function widgetStateJson(state: Readonly<Record<string, string>>): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(state).sort()) sorted[k] = String(state[k]);
  return JSON.stringify(sorted, null, 2);
}

/** 断りの字(書く前に先に言う ── 押した後に黙って何も起きない形を作らない)。 */
export function widgetStateTooLargeNote(size: number): string {
  return `ウィジェットの状態が大きすぎるため、ノートに保存できません(${String(Math.ceil(size / 1024))} KB。上限は ${String(WIDGET_STATE_BLOCK_LIMIT / 1024)} KB です)`;
}

export type UpsertWidgetStateResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 🔴 **状態ブロックを書く**。在れば中身を差し替え、無ければ**そのウィジェット本体の囲みの直後**
 * (見つからなければ末尾)に空行を整えて入れる。
 * ⚠ 上限を超える状態は断る(`ok: false`)── 本文は 1 バイトも変えない。
 */
export function upsertWidgetStateBlock(
  body: string,
  widgetId: string,
  state: Readonly<Record<string, string>>,
): UpsertWidgetStateResult {
  if (!WIDGET_ID_RE.test(widgetId)) return { ok: false, reason: 'ウィジェットの id が読めません' };
  const json = widgetStateJson(state);
  if (json.length > WIDGET_STATE_BLOCK_LIMIT) return { ok: false, reason: widgetStateTooLargeNote(json.length) };
  const fence = fenceMarkerFor(json);
  const block = [`${fence}json ${WIDGET_STATE_INFO_KEY}="${widgetId}"`, ...json.split('\n'), fence];
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(body);

  const hit = stateFences(body, lines).find((f) => f.id === widgetId);
  if (hit !== undefined) {
    const next = [...lines.slice(0, hit.span.start), ...block, ...lines.slice(hit.span.end + 1)];
    return { ok: true, body: next.join(eol) };
  }

  const host = topFences(body, lines).find((f) => widgetFenceId(f.info) === widgetId);
  if (host !== undefined) {
    const at = host.span.end + 1;
    const after = lines.slice(at);
    // 🔑 前に空行 1 つ、後ろも次の行が空でなければ空行 1 つ(Markdown の段落に貼り付かない)
    const tail = after.length > 0 && (after[0] ?? '').trim() !== '' ? [''] : [];
    const next = [...lines.slice(0, at), '', ...block, ...tail, ...after];
    return { ok: true, body: next.join(eol) };
  }

  // 末尾へ ── 末尾の空行を整えて(空行 1 つ空けて置き、最後は改行で終える)
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end -= 1;
  const head = lines.slice(0, end);
  const next = head.length === 0 ? [...block, ''] : [...head, '', ...block, ''];
  return { ok: true, body: next.join(eol) };
}

/**
 * 🔴 **状態ブロックを消す**(同じ id のものは全部)。前後に余った空行は 1 つに詰める。無ければ本文をそのまま返す。
 */
export function removeWidgetStateBlock(body: string, widgetId: string): string {
  if (!body.includes(WIDGET_STATE_INFO_KEY)) return body;
  const lines = splitLines(body);
  const hits = stateFences(body, lines).filter((f) => f.id === widgetId);
  if (hits.length === 0) return body;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  let next = [...lines];
  // ⚠ 後ろから消す(前の範囲の行番号を動かさない)
  for (const h of [...hits].reverse()) {
    let s = h.span.start;
    let e = h.span.end;
    // 🔑 前後が両方空行なら、片方(後ろ)を一緒に消す ── 空行が 2 つ並ばない
    const before = s > 0 ? next[s - 1] : undefined;
    const after = next[e + 1];
    const blank = (l: string | undefined): boolean => l !== undefined && l.trim() === '';
    if (blank(before) && (after === undefined || blank(after))) {
      if (after !== undefined) e += 1;
      else s -= 1;
    } else if (before === undefined && blank(after)) {
      // 本文の先頭のブロック ── 後ろの空行も一緒に(先頭に空行を残さない)
      e += 1;
    }
    next = [...next.slice(0, s), ...next.slice(e + 1)];
  }
  // 末尾にぶら下がる空行は、元の本文の末尾の形(改行で終わるか)に揃える
  if (body.endsWith('\n')) {
    while (next.length > 1 && (next[next.length - 1] ?? '') === '' && (next[next.length - 2] ?? '').trim() === '') next.pop();
  }
  return next.join(eol);
}
