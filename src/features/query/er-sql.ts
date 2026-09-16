/**
 * 🔴 **図で押した所から `SELECT` を組む**(#918 段⑤c)。**pure**。
 *
 * ## 🔑 いちばん大事な決めごと ── **打ちかけの字を捨てない**
 *
 * ⚠ 押すたびに欄を作り直すと、**手で直した字が消える**。だから
 *   **いま欄に在る字を読んで、足す**形にしてある。
 *
 * ## 🔴 ただし SQL を全部は解釈しない
 *
 * 全部解釈するのは parser を書くことである。ここが読むのは
 * **こちらが組んだ形**(`select … from … [join … on …] …`)だけで、
 * ⚠ **読めない字が来たら足さない ── そして理由を言う**。
 *   - 黙って書き換える = user の字を壊す
 *   - 黙って何もしない = 無言の dead click(この repo がいちばん嫌う形)
 *
 * 🔑 `where` 以降は**そのまま持ち越す**(触らない)── 絞り込みを書いた後で
 *   列を足せないと、動線が途中で切れる。
 */

import type { SchemaLink } from './schema-digest';

/** ⚠ 名前として裸で書くと別の意味になる語(抜粋)。ここに当たったら引用符で囲う。 */
const RESERVED = new Set([
  'add', 'all', 'alter', 'and', 'as', 'asc', 'between', 'by', 'case', 'cast', 'check',
  'collate', 'column', 'commit', 'create', 'cross', 'default', 'delete', 'desc', 'distinct',
  'drop', 'else', 'end', 'escape', 'except', 'exists', 'explain', 'filter', 'from', 'full',
  'group', 'having', 'if', 'in', 'index', 'inner', 'insert', 'intersect', 'into', 'is',
  'join', 'key', 'left', 'like', 'limit', 'natural', 'not', 'null', 'offset', 'on', 'or',
  'order', 'outer', 'pragma', 'primary', 'references', 'right', 'select', 'set', 'table',
  'then', 'to', 'union', 'unique', 'update', 'using', 'values', 'view', 'when', 'where',
  'window', 'with',
]);

/** そこから先は「絞り込み」── こちらは 1 バイトも触らない。 */
const TRAILERS = new Set([
  'where', 'group', 'order', 'limit', 'offset', 'having', 'window',
  'union', 'except', 'intersect',
]);

/** `join` の前に付きうる語。 */
const JOIN_PREFIX = new Set(['inner', 'left', 'right', 'full', 'outer', 'cross', 'natural']);

/**
 * 名前を SQL に書ける形にする。
 * ⚠ **日本語はそのまま裸で書ける**(sqlite は 0x80 以上の字を名前の字として扱う)──
 *   引用符で囲うと読みにくいだけなので囲わない。
 * ⚠ 予約語と、記号を含む名前だけ囲う(中の `"` は 2 つ重ねる)。
 */
export function erQuote(name: string): string {
  const bare = /^[A-Za-z_-￿][A-Za-z0-9_-￿]*$/.test(name);
  if (bare && !RESERVED.has(name.toLowerCase())) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

/** 引用符を外した「中身」。 */
function unquote(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  return raw;
}

interface Tok {
  readonly kind: 'word' | 'ident' | 'str' | 'punct';
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

/** ⚠ 引用符の中の空白で切らない ── `"my table"` は 1 つの名前である。 */
function lex(s: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i += 1;
      for (;;) {
        const j = s.indexOf(c, i);
        // ⚠ 閉じていない = 打ちかけ。読めないので足さない(後で理由を言う)
        if (j < 0) return null;
        if (s[j + 1] === c) {
          i = j + 2;
          continue;
        }
        i = j + 1;
        break;
      }
      out.push({ kind: c === '"' ? 'ident' : 'str', raw: s.slice(start, i), start, end: i });
      continue;
    }
    if (c === '(' || c === ')' || c === ',' || c === '=') {
      out.push({ kind: 'punct', raw: c, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    const start = i;
    while (i < s.length && !/[\s"'(),=]/.test(s[i]!)) i += 1;
    out.push({ kind: 'word', raw: s.slice(start, i), start, end: i });
  }
  return out;
}

/** こちらが組んだ形を読み取った結果。⚠ 原文の綴りを**そのまま**持つ(組み直しで崩さない)。 */
export interface ErShape {
  /** `select` の原文(大文字で打っていたら大文字のまま返す)。 */
  readonly selectRaw: string;
  /** 選んでいる列の原文(`*` か `金額, 客id`)。 */
  readonly columnsRaw: string;
  /** `from` の原文。 */
  readonly fromRaw: string;
  /** 取り出し元の表の原文(引用符つきかもしれない)。 */
  readonly tableRaw: string;
  /** `join … on …` の原文(1 本 1 要素)。 */
  readonly joinsRaw: readonly string[];
  /** `from` と `join` で出てくる表の名前(引用符を外した物)。 */
  readonly tables: readonly string[];
  /** `where` 以降の原文(無ければ空)。 */
  readonly trailerRaw: string;
}

/**
 * 🔑 **こちらが組んだ形かどうか**を見る。違えば `null`(= 足さない)。
 * ⚠ ここで受けるのは `select … from 表 [join 表 on …]* [where 以降]` だけである。
 */
export function parseErSql(text: string): ErShape | null {
  const s = text.replace(/;\s*$/, '').trimEnd();
  const toks = lex(s);
  if (toks === null || toks.length === 0) return null;
  const first = toks[0]!;
  if (first.kind !== 'word' || first.raw.toLowerCase() !== 'select') return null;

  // ── `from` を括弧の外で探す(副問い合わせの中の from に当たらないように)
  let depth = 0;
  let fromIdx = -1;
  for (let i = 1; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.kind === 'punct' && t.raw === '(') depth += 1;
    else if (t.kind === 'punct' && t.raw === ')') depth -= 1;
    else if (depth === 0 && t.kind === 'word' && t.raw.toLowerCase() === 'from') {
      fromIdx = i;
      break;
    }
  }
  if (fromIdx < 0) return null;
  const columnsRaw = s.slice(toks[1]!.start, toks[fromIdx]!.start).trim();
  if (columnsRaw === '') return null;

  const nameTok = toks[fromIdx + 1];
  if (nameTok === undefined || (nameTok.kind !== 'word' && nameTok.kind !== 'ident')) return null;
  const tables = [unquote(nameTok.raw)];
  const joinsRaw: string[] = [];
  let trailerRaw = '';

  let i = fromIdx + 2;
  while (i < toks.length) {
    const t = toks[i]!;
    if (t.kind !== 'word') return null;
    const w = t.raw.toLowerCase();
    if (TRAILERS.has(w)) {
      trailerRaw = s.slice(t.start).trim();
      break;
    }
    if (!JOIN_PREFIX.has(w) && w !== 'join') return null;
    const clauseStart = t.start;
    while (
      i < toks.length &&
      toks[i]!.kind === 'word' &&
      JOIN_PREFIX.has(toks[i]!.raw.toLowerCase())
    ) {
      i += 1;
    }
    if (i >= toks.length || toks[i]!.kind !== 'word' || toks[i]!.raw.toLowerCase() !== 'join') {
      return null;
    }
    i += 1;
    const jt = toks[i];
    if (jt === undefined || (jt.kind !== 'word' && jt.kind !== 'ident')) return null;
    tables.push(unquote(jt.raw));
    i += 1;
    const on = toks[i];
    if (on === undefined || on.kind !== 'word' || on.raw.toLowerCase() !== 'on') return null;
    i += 1;
    // ── `on` の中身は、次の join / 絞り込み / 終わりまで
    const condStart = i;
    while (i < toks.length) {
      const u = toks[i]!;
      if (u.kind === 'word') {
        const uw = u.raw.toLowerCase();
        if (uw === 'join' || JOIN_PREFIX.has(uw) || TRAILERS.has(uw)) break;
      }
      i += 1;
    }
    if (i === condStart) return null;
    joinsRaw.push(s.slice(clauseStart, toks[i - 1]!.end).trim());
  }
  return {
    selectRaw: first.raw,
    columnsRaw,
    fromRaw: s.slice(toks[fromIdx]!.start, toks[fromIdx]!.end),
    tableRaw: s.slice(nameTok.start, nameTok.end),
    joinsRaw,
    tables,
    trailerRaw,
  };
}

/** 図のどこを押したか。 */
export type ErAction =
  | { readonly kind: 'table'; readonly table: string }
  | { readonly kind: 'column'; readonly table: string; readonly column: string }
  | { readonly kind: 'link'; readonly link: SchemaLink };

export type ErSqlResult =
  | { readonly ok: true; readonly sql: string }
  /** ⚠ 足さなかった理由。**画面にそのまま出す字**なので、user の言葉で書く。 */
  | { readonly ok: false; readonly why: string };

/** 同じ名前か(sqlite の名前は大小を区別しない)。 */
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** 選んでいる列を `,` で割る(括弧の中の `,` では割らない)。 */
function splitColumns(raw: string): string[] {
  const toks = lex(raw);
  if (toks === null) return [raw];
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (const t of toks) {
    if (t.kind === 'punct' && t.raw === '(') depth += 1;
    else if (t.kind === 'punct' && t.raw === ')') depth -= 1;
    else if (t.kind === 'punct' && t.raw === ',' && depth === 0) {
      out.push(raw.slice(start, t.start).trim());
      start = t.end;
    }
  }
  out.push(raw.slice(start).trim());
  return out.filter((x) => x !== '');
}

/** 大文字で打っている人には大文字で返す(綴りを勝手に変えない)。 */
const kw = (shape: ErShape, word: string): string =>
  shape.selectRaw === shape.selectRaw.toUpperCase() ? word.toUpperCase() : word;

/** 読み取った形を字へ戻す。⚠ 原文の綴りをそのまま使う。 */
function build(shape: ErShape, columnsRaw: string, joinsRaw: readonly string[]): string {
  const head = `${shape.selectRaw} ${columnsRaw} ${shape.fromRaw} ${shape.tableRaw}`;
  const joins = joinsRaw.map((j) => `\n  ${j}`).join('');
  const tail = shape.trailerRaw === '' ? '' : `\n${shape.trailerRaw}`;
  return head + joins + tail;
}

/**
 * 🔴 **押した所から、いまの字へ足す。**
 *
 * ⚠ 足せないときは `ok: false` と**理由**を返す ── 呼び側はそれを画面に出す。
 */
export function erSql(current: string, action: ErAction): ErSqlResult {
  if (current.trim() === '') {
    if (action.kind === 'table') return { ok: true, sql: `select * from ${erQuote(action.table)}` };
    /**
     * 🔴 **空の欄で繋いだら、両方の表から組む**(#918 段⑤d-1。2026-09-16 に足した)。
     *
     * ⚠ 直す前はここも「先に表の名前を押してください」と断っていた ── ところが
     *   **自分でキーを繋ぐ**(段⑤d-1)が入った後は、user は
     *   **「繋ぎたい 2 つの列」を既に押している**。そこで断るのは、
     *   **持っている情報で組めるのに、もう 1 手を要求している**ことになる。
     * 🔑 user の求めは「**掛け合わせを描きたい**」なので、押した 2 つから
     *   `select * from A join B on …` まで組む(👉 実ブラウザの smoke が
     *   「線は引けたのに欄が空のまま」で落ちて分かった)。
     * ⚠ 綴りは小文字 ── 空の欄には**合わせる相手の綴りが無い**ので、
     *   すぐ上の `table` の分岐と同じ形にする(`kw()` は shape が要る)。
     */
    if (action.kind === 'link') {
      const { from, fromColumn, to, toColumn } = action.link;
      if (fromColumn === '' || toColumn === '') {
        return { ok: false, why: `「${from}」と「${to}」を、どの列で繋ぐかが分かりません` };
      }
      const cond = `${erQuote(to)}.${erQuote(toColumn)} = ${erQuote(from)}.${erQuote(fromColumn)}`;
      return {
        ok: true,
        sql: `select * from ${erQuote(from)}\n  join ${erQuote(to)} on ${cond}`,
      };
    }
    return { ok: false, why: `先に表の名前(「${action.table}」など)を押してください` };
  }

  const shape = parseErSql(current);
  if (shape === null) {
    return {
      ok: false,
      why: 'いま打っている字は、この図からは足せません(欄を空にしてから押すと組み直せます)',
    };
  }
  const has = (name: string): boolean => shape.tables.some((t) => same(t, name));

  if (action.kind === 'table') {
    if (has(action.table)) return { ok: false, why: `「${action.table}」はもう入っています` };
    return {
      ok: false,
      why: `「${action.table}」を足すには、図の線(繋がり)を押してください ── どの列で繋ぐかが要ります`,
    };
  }

  if (action.kind === 'column') {
    if (!has(action.table)) {
      return {
        ok: false,
        why: `「${action.table}」はまだ取り出し元に入っていません ── 表の名前か、繋がりの線を先に押してください`,
      };
    }
    // ⚠ 表が 2 つ以上あるときだけ `表.列` にする(1 つなら余計な字を足さない)
    const name =
      shape.tables.length > 1
        ? `${erQuote(action.table)}.${erQuote(action.column)}`
        : erQuote(action.column);
    const cols = splitColumns(shape.columnsRaw);
    if (cols.some((c) => same(c, name) || same(c, action.column))) {
      return { ok: false, why: `「${action.column}」はもう選んでいます` };
    }
    // 🔑 `*` は退く(「全部」と「この列」を同時に選ぶ意味が無い)
    const next = cols.length === 1 && cols[0] === '*' ? name : `${shape.columnsRaw}, ${name}`;
    return { ok: true, sql: build(shape, next, shape.joinsRaw) };
  }

  const { from, fromColumn, to, toColumn } = action.link;
  if (toColumn === '' || fromColumn === '') {
    return { ok: false, why: `「${from}」と「${to}」を、どの列で繋ぐかが分かりません` };
  }
  if (has(from) && has(to)) return { ok: false, why: `「${from}」と「${to}」はもう繋がっています` };
  if (!has(from) && !has(to)) {
    return { ok: false, why: `先に「${from}」か「${to}」の表の名前を押してください` };
  }
  const add = has(from) ? to : from;
  const cond = `${erQuote(to)}.${erQuote(toColumn)} = ${erQuote(from)}.${erQuote(fromColumn)}`;
  const clause = `${kw(shape, 'join')} ${erQuote(add)} ${kw(shape, 'on')} ${cond}`;
  return { ok: true, sql: build(shape, shape.columnsRaw, [...shape.joinsRaw, clause]) };
}
