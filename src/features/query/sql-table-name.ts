/**
 * 🔴 **file の名前から、SQL の表の名前を作る**(#918 段⑦の下地)。
 *
 * ## ① 何のための関数か
 *
 * 複数の file を 1 つの DuckDB の器へ並べて突き合わせる(段⑦の本体)とき、
 * file ごとに表を作る ── その**表の名前**を file の名前から決める(`sales_2026.csv` →
 * `sales_2026`)。user が打つ名前なので、**画面に出ている名前でそのまま引ける**ことが
 * 要る(案内文・手本・実際に作る表の名前が同じ 1 か所から出るのは、
 * `guestTableNameOf` と同じ作法である)。
 *
 * ⚠ **この段では呼び側を繋がない**(段⑦の本体は別 PR)。ここは純粋関数だけで、
 *   test が規則を pin する。
 *
 * ## ② 規則(上から順に当てる)
 *
 * | 規則 | 例 |
 * |---|---|
 * | 場所(`/` `\` より前)を落とす | `data/a.csv` → `a` |
 * | 最後の拡張子 1 つを落とす | `売上.2026.csv` → `売上_2026` |
 * | 全角の英数字・記号を半角へ直す(NFKC) | `ｓａｌｅｓ.csv` → `sales` |
 * | 文字・数字・`_` 以外は `_` へ(続く分は 1 つに畳み、両端は落とす) | `売上 (最終).csv` → `売上_最終` |
 * | 先頭が数字なら `_` を前置 | `2026.csv` → `_2026` |
 * | 予約語・`sqlite_` で始まる名前・この PKC の表の名前は `_` を後置 / 前置 | `select.csv` → `select_` |
 * | 取られていれば `_2` `_3` … | `a.csv` が 2 つ目なら `a_2` |
 *
 * 🔑 **全角を半角へ直す理由**:打った SQL は走らせる前に全角 → 半角へ直される
 *   (`sql-guard.ts` の `normalizeSqlInput`)ので、全角の名前の表は**どう打っても引けない**
 *   (`csv-tables.ts` の `validCsvTableName` が同じ理由で全角を受けない)。
 * 🔑 **日本語の文字は残す** ── 引用符なしで書ける(sqlite も DuckDB も 0x80 以上の字を
 *   名前の字として扱う)ので、`売上.csv` は `売上` のまま打てる。
 *
 * ⚠ **`taken` は書き換えない**(純粋関数)。使った名前を足すのは呼び側の仕事である。
 * ⚠ **大文字小文字は同じ名前として扱う**(DuckDB も sqlite も表の名前は大文字小文字を
 *   区別しない)── `Sales` が在れば `sales` は取られている。
 */
import { CSV_TABLE_RESERVED } from './csv-tables';

/** 表の名前の上限(字数)。⚠ 重複の接尾辞(`_12` など)を足しても超えない。 */
export const TABLE_NAME_MAX = 40;

/** 名前が作れなかった(拡張子しか無い等)ときの名前。 */
export const TABLE_NAME_FALLBACK = 'data';

/**
 * 🔴 **裸で書くと別の意味になる語**(DuckDB の予約語 + sqlite の予約語)。
 *
 * ⚠ **足りない側に倒れると**、`select.csv` から `select` という表が作られ、
 *   `SELECT * FROM select` が構文エラーになる(user には「表が引けない」としか見えない)。
 * 🔑 だから**両方の engine の語を合わせて**持つ(片方の engine でだけ通る名前は、
 *   engine を切り替えて比べたい user の動線を割る)。
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  // DuckDB(PostgreSQL 由来の予約語 + DuckDB が足した文頭の語)
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'both', 'case',
  'cast', 'check', 'collate', 'column', 'constraint', 'create', 'default', 'deferrable', 'desc',
  'describe', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign',
  'from', 'grant', 'group', 'having', 'in', 'initially', 'intersect', 'into', 'lambda',
  'lateral', 'leading', 'limit', 'not', 'null', 'offset', 'on', 'only', 'or', 'order', 'pivot',
  'pivot_longer', 'pivot_wider', 'placing', 'primary', 'qualify', 'references', 'returning',
  'select', 'show', 'some', 'summarize', 'symmetric', 'table', 'then', 'to', 'trailing', 'true',
  'try_cast', 'union', 'unique', 'unpivot', 'using', 'variadic', 'when', 'where', 'window', 'with',
  // sqlite(DuckDB に無い分だけ足せば足りるが、重なりを気にせず全部並べる ── 引きやすさを優先)
  'abort', 'action', 'add', 'after', 'alter', 'always', 'attach', 'autoincrement', 'before',
  'begin', 'between', 'by', 'cascade', 'commit', 'conflict', 'cross', 'current', 'database',
  'deferred', 'delete', 'detach', 'drop', 'each', 'escape', 'exclusive', 'exists', 'explain',
  'fail', 'filter', 'first', 'following', 'full', 'glob', 'if', 'ignore', 'immediate', 'index',
  'indexed', 'inner', 'insert', 'instead', 'is', 'isnull', 'join', 'key', 'last', 'left',
  'like', 'match', 'natural', 'no', 'notnull', 'nulls', 'of', 'outer', 'over', 'partition',
  'plan', 'pragma', 'preceding', 'query', 'raise', 'range', 'recursive', 'regexp', 'reindex',
  'release', 'rename', 'replace', 'restrict', 'right', 'rollback', 'row', 'rows', 'savepoint',
  'set', 'temp', 'temporary', 'ties', 'transaction', 'trigger', 'unbounded', 'update', 'vacuum',
  'values', 'view', 'virtual', 'without',
]);

/** 文字・数字・`_`(これ以外は表の名前に使わない)。 */
const KEEP = /[\p{L}\p{N}_]/u;

/** 場所と最後の拡張子を落とした「名前の本体」。 */
function stemOf(fileName: string): string {
  const base = fileName.split(/[\\/]/u).pop() ?? '';
  // ⚠ 拡張子と見なすのは「英数字 1〜10 字」だけ ── `v1.2 の話` のような名前の途中の `.` を割らない
  const dot = base.lastIndexOf('.');
  // ⚠ `dot >= 0`:先頭の `.` だけの名前(`.csv`)は本体が空になり、既定の名前へ落ちる
  if (dot >= 0 && /^[A-Za-z0-9]{1,10}$/u.test(base.slice(dot + 1))) return base.slice(0, dot);
  return base;
}

/** 使えない字を `_` にした本体(続く分は 1 つ・両端は落とす)。 */
function cleanStem(stem: string): string {
  let out = '';
  let pending = false;
  for (const ch of stem.normalize('NFKC')) {
    if (KEEP.test(ch)) {
      if (pending && out !== '') out += '_';
      pending = false;
      out += ch;
    } else {
      pending = true;
    }
  }
  return out;
}

/** 字数を数える単位は符号点(絵文字や稀な漢字を途中で割らない)。 */
function clip(s: string, max: number): string {
  const cps = [...s];
  return cps.length <= max ? s : cps.slice(0, max).join('');
}

/** その名前は、裸で書くと別の意味になるか(予約語 / `sqlite_` / この PKC の表)。 */
function isReserved(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_WORDS.has(lower) || lower.startsWith('sqlite_') || CSV_TABLE_RESERVED.includes(lower);
}

/**
 * 本体の名前から、実際の表の名前を決める(長さ・先頭の数字・予約語・取られている名前の逃がし)。
 * ⚠ `tableNameFromFile` と `tableNameFromFileTable` が**同じ逃がし方**を使う(2 か所に書かない)。
 */
function settle(body: string, taken: ReadonlySet<string>): string {
  let base = body;
  if (base === '') base = TABLE_NAME_FALLBACK;
  // 先頭が数字なら `_` を前置(数字で始まる名前は裸で書けない)
  if (/^\p{N}/u.test(base)) base = `_${base}`;
  base = clip(base, TABLE_NAME_MAX);
  // 予約語は `_` を後置、`sqlite_` で始まる名前と PKC の表の名前は取れないので前置で逃がす
  if (isReserved(base)) {
    base = base.toLowerCase().startsWith('sqlite_') ? `_${base}` : `${base}_`;
    base = clip(base, TABLE_NAME_MAX);
  }

  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  if (!used.has(base.toLowerCase())) return base;
  // 取られている ── `_2` `_3` … ⚠ 接尾辞を足しても上限を超えないよう、本体のほうを切る
  for (let n = 2; ; n += 1) {
    const suffix = `_${String(n)}`;
    const candidate = clip(base, TABLE_NAME_MAX - suffix.length) + suffix;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * file の名前から、表の名前を作る。
 *
 * @param name 添付や手持ちの file の名前(`sales_2026.csv`)。
 * @param taken 既に使っている表の名前。⚠ **書き換えない**。大文字小文字は区別しない。
 */
export function tableNameFromFile(name: string, taken: ReadonlySet<string>): string {
  return settle(cleanStem(stemOf(name)), taken);
}

/**
 * 🔴 **`.sqlite` の中の表の名前を、2 つ以上の file を並べるときの名前にする**(#682 段④d)。
 * 形は **`ファイル名_表名`**(🟣 Gemini 裁定 2026-10-02)── `売上.sqlite` の `注文` → `売上_注文`。
 *
 * 🔑 規則は `tableNameFromFile` と**同じ**(全角→半角 / 使えない字は `_` / 予約語 / 取られていれば `_2`)。
 *   file 名と表名のどちらかが空になる(拡張子しか無い / 記号だけ)ときは、残った側だけを使う。
 * ⚠ **1 つの file だけを引くときは使わない** ── その場合は**元の名前のまま**引ける
 *   (`SELECT * FROM 売上`)。使うのは「名前を file 名から付け直す」2 件以上のときだけ。
 */
export function tableNameFromFileTable(
  fileName: string,
  tableName: string,
  taken: ReadonlySet<string>,
): string {
  const f = cleanStem(stemOf(fileName));
  const t = cleanStem(tableName);
  const body = f !== '' && t !== '' ? `${f}_${t}` : f !== '' ? f : t;
  return settle(body, taken);
}
