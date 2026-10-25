/**
 * 🔴 **user が打つ `COPY (…) TO 'ファイル名'` を通し、書いたファイルをダウンロードにする**(#918)。
 *
 * > user の言葉(2026-09-14): 「copy to使えないし」
 *
 * ## なぜ「外へ書く危険」が無いのか(確かめたこと)
 *
 * DuckDB は **wasm の器の中**で動いており、`COPY … TO 'x'` が書く先は**器の中の仮想ファイル**(worker のメモリ)で、
 * この端末のファイルシステムでも、任意の path でもない。さらに器は外を塞いでおり(`duckdb-open.ts`)、
 * 書いてよい path を `allowed_paths` で**ここの固定の名前だけ**に絞ってある(`DUCKDB_EXPORT_FILES`)。
 *
 * ## 🔑 user の打った名前は「ダウンロードの名前」にしかならない
 *
 * 器の中へ書く名前は**形式ごとの固定の 1 つ**で、user の `TO '…'` の名前は**書き換えて**捨てる。
 * 打った名前が `../x` でも `/etc/x` でも `s3://…` でも器の中の path にはならない
 * (そもそもファイル名として不正なものは、ここで断る ── 場所を指定する書き方は「ダウンロード」と食い違うため)。
 *
 * ## 通す形(これだけ)
 *
 * - `COPY (問い合わせ) TO 'ファイル名.csv' [(オプション, …)]`
 * - `COPY 表の名前 TO 'ファイル名.csv' [(オプション, …)]`(`SELECT * FROM 表の名前` と同じ)
 * - 形式は **FORMAT の指定 → なければ拡張子**(`.csv` / `.tsv` / `.parquet` / `.json` / `.ndjson` / `.jsonl`)
 * - オプションは**許したものだけ**(`COPY_OPTIONS`)。`PARTITION_BY` / `FILE_SIZE_BYTES` のような**複数ファイルを作る**ものは断る
 * - `COPY … FROM`(取り込み)は断る(取り込みは画面の「ファイルを足す」)
 *
 * ⚠ 中の問い合わせは**読む文だけ**(`checkDuckDbSql`)── `COPY (DELETE …)` や `EXPLAIN` は断る。
 *
 * ## 層
 *
 * 純粋層(browser API なし)。判定は**ここ 1 か所**で、字の門(`duckdb-write.ts`)も走らせる側(`store-effects`)も
 * 書く側(`duckdb-runner.ts`)も同じ `userCopyOf` を呼ぶ(§7)。
 */
import { checkDuckDbSql, stripDuckDbNoise } from './duckdb-guard';

/** 書き出しの形式。 */
export type CopyFormat = 'csv' | 'parquet' | 'json';

/**
 * 🔴 **器の中へ書く名前は形式ごとに固定の 1 つ**(user に決めさせない)。
 * ⚠ 増やしたら `duckdb-export.ts` の `DUCKDB_ALLOW_EXPORT_SQL`(塞ぐ前に許す path)も追いつく(そこが一覧から組む)。
 */
export const DUCKDB_EXPORT_FILES: Readonly<Record<CopyFormat, string>> = {
  parquet: 'pkc-export.parquet',
  csv: 'pkc-export.csv',
  json: 'pkc-export.json',
};

const MIME: Readonly<Record<CopyFormat, string>> = {
  parquet: 'application/vnd.apache.parquet',
  csv: 'text/csv',
  json: 'application/json',
};

/** 末尾の `;` を 1 つだけ外す(注釈や文字列の中の `;` は塗り潰した字で見分ける)。 */
export function dropTrailingSemicolon(sql: string): string {
  const bare = stripDuckDbNoise(sql);
  const at = bare.lastIndexOf(';');
  if (at < 0 || bare.slice(at + 1).trim() !== '') return sql;
  return sql.slice(0, at) + ' ' + sql.slice(at + 1);
}

/** 先頭の語(小文字)。⚠ 塗り潰した字から採る。 */
export function headWord(sql: string): string {
  return /^[a-z]+/iu.exec(stripDuckDbNoise(sql).trim().replace(/^[\s(]+/u, ''))?.[0]?.toLowerCase() ?? '';
}

/** 通した `COPY` を、器の中で打つ形に組み直した結果。 */
export type UserCopy =
  | {
      readonly ok: true;
      /** 器の中で打つ 1 文(書き先は固定の名前)。 */
      readonly statement: string;
      /** 器の中の file(`DUCKDB_EXPORT_FILES`)。 */
      readonly file: string;
      /** ダウンロードの名前(user が `TO` に書いた名前)。 */
      readonly fileName: string;
      readonly format: CopyFormat;
      readonly mime: string;
    }
  | { readonly ok: false; readonly why: string };

const FORM = "COPY (問い合わせ) TO 'ファイル名.csv'";
const EXT_LIST = '.csv / .tsv / .parquet / .json / .ndjson / .jsonl';

/** 許すオプション。`for` = その形式のときだけ。 */
type OptKind = 'bool' | 'str' | 'int' | 'word';
interface OptSpec {
  readonly name: string;
  readonly kind: OptKind;
  readonly for: readonly CopyFormat[];
  readonly words?: readonly string[];
}
const COPY_OPTIONS: Readonly<Record<string, OptSpec>> = {
  HEADER: { name: 'HEADER', kind: 'bool', for: ['csv'] },
  DELIMITER: { name: 'DELIMITER', kind: 'str', for: ['csv'] },
  DELIM: { name: 'DELIMITER', kind: 'str', for: ['csv'] },
  SEP: { name: 'DELIMITER', kind: 'str', for: ['csv'] },
  QUOTE: { name: 'QUOTE', kind: 'str', for: ['csv'] },
  ESCAPE: { name: 'ESCAPE', kind: 'str', for: ['csv'] },
  NULL: { name: 'NULLSTR', kind: 'str', for: ['csv'] },
  NULLSTR: { name: 'NULLSTR', kind: 'str', for: ['csv'] },
  DATEFORMAT: { name: 'DATEFORMAT', kind: 'str', for: ['csv', 'json'] },
  TIMESTAMPFORMAT: { name: 'TIMESTAMPFORMAT', kind: 'str', for: ['csv', 'json'] },
  COMPRESSION: {
    name: 'COMPRESSION',
    kind: 'word',
    for: ['parquet'],
    words: ['uncompressed', 'snappy', 'gzip', 'zstd'],
  },
  ROW_GROUP_SIZE: { name: 'ROW_GROUP_SIZE', kind: 'int', for: ['parquet'] },
  ARRAY: { name: 'ARRAY', kind: 'bool', for: ['json'] },
};
const OPTION_NAMES = 'FORMAT / HEADER / DELIMITER / QUOTE / ESCAPE / NULL / DATEFORMAT / TIMESTAMPFORMAT / COMPRESSION / ROW_GROUP_SIZE / ARRAY';

const refuse = (why: string): UserCopy => ({ ok: false, why });

/** `'…'`(中の `'` は `''`)を取り出す。形が違えば `null`。 */
function unquote(v: string): string | null {
  const m = /^'((?:[^']|'')*)'$/u.exec(v);
  return m === null ? null : (m[1] ?? '').replace(/''/g, "'");
}

/** 文字列の値に入れてよい字(制御文字は入れない)。 */
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u001f\u007f]/u;

/** オプション列をカンマで割る(`'…'` の中のカンマでは割らない)。 */
function splitOptions(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of text) {
    if (ch === "'") inQuote = !inQuote;
    if (ch === ',' && !inQuote) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/** ダウンロードの名前として使えるか。 */
function badFileName(name: string): string | null {
  if (name === '') return 'ファイル名が空です';
  if (/[\\/]/u.test(name)) {
    return `ファイル名だけを書いてください(場所は指定できません。書いたファイルはダウンロードになります)`;
  }
  if (HAS_CONTROL.test(name) || /[:*?"<>|]/u.test(name)) return 'ファイル名に使えない字が入っています';
  if (name.startsWith('.') || name.endsWith('.') || name.endsWith(' ')) return 'このファイル名は使えません';
  if ([...name].length > 100) return 'ファイル名が長すぎます(100 字まで)';
  return null;
}

/**
 * 🔴 **打たれた字が `COPY` なら、通すか断るかを返す**。`COPY` でなければ `null`(呼び側は今までどおり読む / 書く門へ渡す)。
 */
export function userCopyOf(input: string): UserCopy | null {
  const bare0 = stripDuckDbNoise(input);
  if (!/^\s*copy\b/iu.test(bare0)) return null;

  // 末尾の `;` は許す。中に残れば 2 文目
  // ⚠ 前後の空白は**元の字**で数える(塗り潰した字は末尾の文字列が空白になる ── ファイル名が切れる)
  let lo = 0;
  while (lo < input.length && /\s/u.test(input[lo]!)) lo += 1;
  let hi = input.length - 1;
  while (hi > lo && /\s/u.test(input[hi]!)) hi -= 1;
  if (bare0[hi] === ';') {
    hi -= 1;
    while (hi > lo && /\s/u.test(input[hi]!)) hi -= 1;
  }
  const s = input.slice(lo, hi + 1);
  const b = bare0.slice(lo, hi + 1);
  if (b.includes(';')) return refuse('SQL は 1 文だけ打てます(; で区切った 2 文目は走らせません)');

  let i = 4; // `copy` の後ろ
  // ⚠ 空白は元の字で数える(塗り潰した字では引用符つきの表の名前が空白に見える)
  while (i < s.length && /\s/u.test(s[i]!)) i += 1;
  let query: string;
  let rest: number;
  if (s[i] === '(') {
    let depth = 0;
    let j = i;
    for (; j < b.length; j += 1) {
      if (b[j] === '(') depth += 1;
      else if (b[j] === ')' && (depth -= 1) === 0) break;
    }
    if (j >= b.length) return refuse(`括弧が閉じていません(${FORM} の形で打ちます)`);
    query = s.slice(i + 1, j);
    rest = j + 1;
  } else {
    const m = /^("(?:[^"]|"")+"|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/u.exec(s.slice(i));
    if (m === null) return refuse(`COPY は ${FORM} の形で打ちます`);
    query = `SELECT * FROM ${m[0]}`;
    rest = i + m[0].length;
  }
  const tail = s.slice(rest);
  if (/^\s*from\b/iu.test(tail)) {
    return refuse('COPY … FROM(取り込み)は打てません。ファイルを調べるときは画面の「ファイルを足す」から選びます');
  }
  const m = /^\s*to\s+('(?:[^']|'')*')\s*(?:\(([\s\S]*)\))?$/iu.exec(tail);
  if (m === null) return refuse(`COPY は ${FORM} の形で打ちます(書き先はクォートで囲んだファイル名です)`);
  const fileName = unquote(m[1]!) ?? '';
  const badName = badFileName(fileName);
  if (badName !== null) return refuse(badName);

  // 🔴 中の問い合わせは読む文だけ(`COPY (DELETE …)` も `EXPLAIN` も断る)
  const checked = checkDuckDbSql(query);
  if (!checked.ok) return refuse(checked.why);
  if (headWord(checked.sql) === 'explain') return refuse('EXPLAIN の答えは書き出せません');

  // ── オプション ──
  const given: Array<[string, string]> = [];
  let format: CopyFormat | null = null;
  for (const piece of splitOptions(m[2] ?? '')) {
    const om = /^([A-Za-z_]+)(?:\s*=\s*|\s+)?([\s\S]*)$/u.exec(piece);
    if (om === null) return refuse(`オプション「${piece}」を読めません`);
    const key = om[1]!.toUpperCase();
    const raw = (om[2] ?? '').trim();
    if (key === 'FORMAT') {
      const w = (unquote(raw) ?? raw).toLowerCase();
      if (w !== 'csv' && w !== 'parquet' && w !== 'json') {
        return refuse('FORMAT は CSV / PARQUET / JSON のどれかです');
      }
      format = w;
      continue;
    }
    if (COPY_OPTIONS[key] === undefined) {
      return refuse(`オプション ${key} は使えません(使えるのは ${OPTION_NAMES} です)`);
    }
    given.push([key, raw]);
  }
  const ext = /\.([^.]+)$/u.exec(fileName)?.[1]?.toLowerCase() ?? '';
  const fromExt: CopyFormat | null =
    ext === 'csv' || ext === 'tsv'
      ? 'csv'
      : ext === 'parquet'
        ? 'parquet'
        : ext === 'json' || ext === 'ndjson' || ext === 'jsonl'
          ? 'json'
          : null;
  const fmt = format ?? fromExt;
  if (fmt === null) {
    return refuse(`書き出す形式を決められません(拡張子は ${EXT_LIST} のどれか、または FORMAT を書きます)`);
  }

  const parts: string[] = [`FORMAT ${fmt.toUpperCase()}`];
  const seen = new Set<string>();
  for (const [key, raw] of given) {
    const spec = COPY_OPTIONS[key]!;
    if (!spec.for.includes(fmt)) {
      return refuse(`オプション ${key} は ${fmt.toUpperCase()} では使えません`);
    }
    if (seen.has(spec.name)) return refuse(`オプション ${spec.name} が重なっています`);
    seen.add(spec.name);
    if (spec.kind === 'bool') {
      const v = raw === '' ? 'true' : raw.toLowerCase();
      if (!['true', 'false', '1', '0'].includes(v)) return refuse(`${key} は true か false で書きます`);
      parts.push(`${spec.name} ${v === '1' ? 'true' : v === '0' ? 'false' : v}`);
    } else if (spec.kind === 'str') {
      const v = unquote(raw);
      if (v === null) return refuse(`${key} はクォートで囲んだ文字で書きます(例: ${key} ',')`);
      if (HAS_CONTROL.test(v) || [...v].length > 40) return refuse(`${key} の値が使えません`);
      parts.push(`${spec.name} '${v.replace(/'/g, "''")}'`);
    } else if (spec.kind === 'int') {
      if (!/^[1-9]\d{0,7}$/u.test(raw)) return refuse(`${key} は正の整数で書きます`);
      parts.push(`${spec.name} ${raw}`);
    } else {
      const v = (unquote(raw) ?? raw).toLowerCase();
      if (!(spec.words ?? []).includes(v)) return refuse(`${key} は ${(spec.words ?? []).join(' / ')} のどれかです`);
      parts.push(`${spec.name} ${v}`);
    }
  }
  if (fmt === 'csv') {
    // .tsv はタブ区切りが既定(DELIMITER を書いていれば、書いたほうを使う)
    if (ext === 'tsv' && !seen.has('DELIMITER')) parts.push("DELIMITER '\\t'");
    // 1 行目に列の名前(書き出しの既定。画面の「CSV」と同じ向き)
    if (!seen.has('HEADER')) parts.push('HEADER true');
  }

  const file = DUCKDB_EXPORT_FILES[fmt];
  return {
    ok: true,
    statement: `COPY (SELECT * FROM (${dropTrailingSemicolon(checked.sql)}\n)) TO '${file}' (${parts.join(', ')})`,
    file,
    fileName,
    format: fmt,
    mime: MIME[fmt],
  };
}
