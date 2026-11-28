/**
 * 🔴 **ビューの SQL が、どの名前を引いているか**(#2115 PR-2)。
 *
 * ⚠ これは構文解析ではない(`sql-guard.ts` と同じ立場)。誤差の向きを決めておく:
 * - **依存(`deps`)は多めに拾ってよい** ── 余分に拾っても評価が 1 つ増えるだけ。少なく拾うと
 *   「そんな表は無い」になる(`csvTablesMentioned` と同じ向き)。だから「名前が語として出てくるか」で数える。
 * - **未解決(`missingRefs`)は少なめに言う** ── 間違って「無い」と言うと、動く SQL を止めてしまう。
 *   だから `FROM` / `JOIN` の直後に書かれた素直な名前だけを見る。
 *
 * ## 文字列と注釈の中の語は数えない
 *
 * `SELECT '売上' FROM 在庫` は `売上` を引いていない。注釈と文字列は `stripSqlNoise`(読み取り専用の門と
 * 同じ 1 本)で塗り潰してから数える。
 * ⚠ ただし `stripSqlNoise` は**識別子の引用**(`"売上"` / `` `売上` `` / `[売上]`)も塗り潰す ── 門としては
 *   正しい(中身を語として数えない)が、参照としては `FROM "売上"` を落としてしまう。
 *   🔑 だから**塗られた区間のうち、識別子の引用で始まる区間だけ中身を戻す**(引用の記号は空白にする)。
 *   どこが塗られたかは `stripSqlNoise` の結果そのものから読む。区間の閉じ方(`'` / `--` / `/*` / `"` / `` ` `` / `[`)
 *   は `stripSqlNoise` と同じ規則で、両者が食い違わないことは `tests/features/dataflow/sql-refs.test.ts` が
 *   突き合わせる(識別子の引用が無い SQL では 1 字も違わない)。
 *
 * ⚠ pure module。
 */
import { csvTablesMentioned } from '@features/query/csv-tables';
import { stripSqlNoise } from '@features/query/sql-guard';
import { foldName } from './names';

/** 識別子の引用の開き。⚠ `stripSqlNoise` が識別子として塗る 3 種。 */
const IDENT_OPEN: Readonly<Record<string, string>> = { '"': '"', '`': '`', '[': ']' };

/**
 * 🔴 **参照を数えるための字**(長さは保つ)。注釈と文字列は空白、識別子の引用は記号だけ空白にして中身を残す。
 *
 * 区間の境界は自前で数えない ── `stripSqlNoise` が塗った位置を左から読み、塗られた区間の先頭の字で
 * 種類を見分ける。⚠ 塗られた区間は隣り合うことがある(`'a'"b"`)ので、区間の中でも閉じの記号で区切る。
 */
export function sqlReferenceText(sql: string): string {
  const mask = stripSqlNoise(sql);
  const out = mask.split('');
  let i = 0;
  while (i < sql.length) {
    if (mask[i] === sql[i]) {
      i += 1;
      continue;
    }
    // 塗られた区間の始まり。先頭の字で種類を見る
    const c = sql[i] ?? '';
    const close = IDENT_OPEN[c];
    if (c === "'" || (c === '-' && sql[i + 1] === '-') || (c === '/' && sql[i + 1] === '*')) {
      // 文字列・注釈は塗ったまま。区間の終わりまで進む ── 終わりは「塗られていない字」か次の開き
      i = skipNoise(sql, i);
      continue;
    }
    if (close === undefined) {
      i += 1;
      continue;
    }
    const end = sql.indexOf(close, i + 1);
    const stop = end < 0 ? sql.length : end;
    for (let k = i + 1; k < stop; k += 1) out[k] = sql[k] ?? ' ';
    i = end < 0 ? sql.length : end + 1;
  }
  return out.join('');
}

/** 文字列 / 注釈 1 つぶん進む(`stripSqlNoise` と同じ閉じ方)。 */
function skipNoise(sql: string, i: number): number {
  const c = sql[i];
  if (c === '-') {
    const end = sql.indexOf('\n', i);
    return end < 0 ? sql.length : end;
  }
  if (c === '/') {
    const end = sql.indexOf('*/', i + 2);
    return end < 0 ? sql.length : end + 2;
  }
  const end = sql.indexOf("'", i + 1);
  return end < 0 ? sql.length : end + 1;
}

const WORD = '[\\p{L}\\p{N}_$]+';

/**
 * 🔑 **`WITH` で定めた名前**(CTE)。同じ名前のデータセットより CTE が勝つ(SQLite の解決順)ので、
 * その名前は依存にも未解決にも数えない。
 * ⚠ `WINDOW w AS (…)` の窓の名前は CTE ではない(直前の語が `WINDOW` / `,` で窓の並びにいる形は外す)。
 */
export function cteNames(refText: string): string[] {
  if (!/\bwith\b/i.test(refText)) return [];
  const out: string[] = [];
  const re = new RegExp(
    `(${WORD})\\s*(?:\\([^()]*\\))?\\s+as\\s+(?:not\\s+)?(?:materialized\\s+)?\\(`,
    'giu',
  );
  for (const m of refText.matchAll(re)) {
    const name = m[1] ?? '';
    const before = refText.slice(0, m.index).replace(/\s+$/u, '');
    if (/\bwindow$/i.test(before)) continue;
    // `WINDOW a AS (…), b AS (…)` の 2 つ目以降:直近の `WINDOW` が直近の `WITH` より後なら窓の並び
    const lastWindow = before.toLowerCase().lastIndexOf('window');
    const lastWith = before.toLowerCase().lastIndexOf('with');
    if (lastWindow > lastWith && before.endsWith(',')) continue;
    if (/^(as|select|from|where|on|and|or|not)$/i.test(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * 🔴 **SQL が語として触れている名前**(`candidates` のうち)。
 * 判定は `csvTablesMentioned`(既存の 1 本)── 名前の前後が字・数字なら別の語。ASCII の大小は畳む。
 * ⚠ CTE で定めた名前は外す(CTE が隠すので、その名前のデータセットは引かれない)。
 * @returns 触れている名前(`candidates` の綴りのまま・`candidates` の順)
 */
export function sqlMentions(sql: string, candidates: readonly string[]): string[] {
  const ref = sqlReferenceText(sql);
  const ctes = new Set(cteNames(ref).map(foldName));
  const folded = foldName(ref);
  const hits = new Set(csvTablesMentioned(folded, candidates.map(foldName)));
  return candidates.filter((c) => hits.has(foldName(c)) && !ctes.has(foldName(c)));
}

/** `FROM` / `JOIN` の直後の名前 1 つ(識別子の引用は中身が字として戻っている)。 */
const TABLE_AFTER = new RegExp(`\\b(?:from|join)\\s+(${WORD}(?:\\s*\\.\\s*${WORD})?)(\\s*\\()?`, 'giu');
/** `FROM a x, b y` の 2 つ目以降(`,` の後ろの名前)。 */
const COMMA_TABLE = new RegExp(`^\\s*(?:(?:as\\s+)?${WORD}\\s*)?,\\s*(${WORD}(?:\\s*\\.\\s*${WORD})?)(\\s*\\()?`, 'iu');
/** 表の名前ではない語(`FROM (SELECT …)` の後の語などを拾わないため)。 */
const NOT_TABLE = new Set(['select', 'values', 'lateral', 'where', 'group', 'order', 'limit', 'on', 'using']);

/**
 * 🔑 **`FROM` / `JOIN` に書かれた表の名前**(書かれたままの字・出現順・重複なし)。
 * ⚠ 関数の形(`pragma_table_info(…)` / `json_each(…)`)と、`main.x` のような所属つきの名前は外す
 *   (このノートの名前ではない)。`FROM a, b` の 2 つ目以降も拾う。
 */
export function sqlFromTables(sql: string): string[] {
  const ref = sqlReferenceText(sql);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string, call: string | undefined): void => {
    if (call !== undefined || raw.includes('.')) return;
    if (NOT_TABLE.has(foldName(raw))) return;
    const k = foldName(raw);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(raw);
  };
  for (const m of ref.matchAll(TABLE_AFTER)) {
    add(m[1] ?? '', m[2]);
    let rest = ref.slice((m.index ?? 0) + m[0].length);
    for (;;) {
      const c = COMMA_TABLE.exec(rest);
      if (c === null) break;
      add(c[1] ?? '', c[2]);
      rest = rest.slice(c[0].length);
    }
  }
  return out;
}

/**
 * 🔴 **このノートに無い名前**(未解決の参照)。`known`(データセット・ビュー)にも、その SQL の CTE にも無い
 * `FROM` / `JOIN` の名前を返す。
 * @param ignore 未解決と言わない名前(PKC の内部の表 `entries` など ── 呼び手が決める)
 */
export function findMissingRefs(
  sql: string,
  known: Iterable<string>,
  ignore: Iterable<string> = [],
): string[] {
  const ok = new Set<string>();
  for (const k of known) ok.add(foldName(k));
  for (const k of ignore) ok.add(foldName(k));
  for (const c of cteNames(sqlReferenceText(sql))) ok.add(foldName(c));
  return sqlFromTables(sql).filter((t) => !ok.has(foldName(t)));
}
