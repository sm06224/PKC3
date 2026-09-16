/**
 * 🔴 **DuckDB へ打つ字の門**(#682 段②)。
 *
 * ## ⚠ ここは**境ではない** ── 断る理由を**字で言う**ための門である
 *
 * `sql-guard.ts` の同じ注意書きがそのまま当てはまる。字で見分ける以上、
 * 知らない書き方が出れば漏れうる ── 漏れたときに「通っているのだから安全なはず」と
 * 読まれるのが、いちばん悪い形である。
 *
 * ## 🔑 DuckDB 側の「本当の境」は 3 つで、**どれもこの file の外に在る**
 *
 * 1. 🔴 **user のデータに手が届かない** ── DuckDB は**使い捨ての空の DB**で起き、
 *    渡すのは**選んだ相手の bytes 1 つだけ**。ノートの正本(sqlite)へは
 *    1 バイトも繋がっていない。⚠ つまり仮に `CREATE TABLE` が通っても、
 *    壊せるのは**畳めば消える入れ物**だけである
 * 2. 🔴 **拡張を勝手に取りに行かせない**(`autoinstall` / `autoload` を切る)──
 *    設計 doc §4 の柱(外へ出ない)の実体。実装は `duckdb-open.ts`
 * 3. **時間で畳む** ── 終わらない問い合わせは、ワーカーごと畳んで止める
 *    (`duckdb-lease.ts`)。⚠ sqlite と違い**中断の口が上流に無い**ので、
 *    畳むのが唯一の手である
 *
 * 🔑 だから字の門の役目は「**打った人に読める理由を返す**」ことに絞る ──
 *   `CREATE TABLE` を engine が受けてしまう以上、**字で断らないと
 *   「保存できたつもり」にさせる**(畳めば消えるのに)。
 *
 * ## ⚠ sqlite の門をそのまま使えない 3 つ
 *
 * | | DuckDB |
 * |---|---|
 * | 文字列 | `$$…$$` / `$tag$…$tag$`(**ドル引用符**)が在る ── 塗り潰さないと中身が語に数えられる |
 * | 先頭の語 | `FROM t SELECT x` / `PIVOT` / `DESCRIBE` / `SUMMARIZE` が**読むだけ**で書ける |
 * | 断る語 | 🔴 `INSTALL` / `LOAD`(拡張を外から取る)/ `SET`(上の門②を**打つ人が外せる**)/ `COPY`(file へ書く)/ `ATTACH` が要る |
 */
import { checkReadOnlySql, normalizeOutsideMask, stripSqlNoise, type SqlCheck } from './sql-guard';

/**
 * 🔴 **ドル引用符の中身を塗り潰す**(長さは保つ)。
 *
 * ⚠ `$$…$$` も `$tag$…$tag$` も、中に `'` や `--` を**そのまま**書けるので、
 *   先に潰さないと `stripSqlNoise` の引用符の数え方が丸ごと狂う。
 * ⚠ 閉じが見つからない(打ちかけ)ときは**末尾まで**塗る ── sqlite 側の
 *   引用符と同じ作法(開いたままの引用符は、そこから先を語に数えない)。
 */
export function stripDollarQuotes(sql: string): string {
  const out = sql.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  // ⚠ タグに使えるのは英数字と `_` だけ(空タグ = `$$` も認める)
  const open = /\$([A-Za-z0-9_]*)\$/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(sql)) !== null) {
    const tag = m[0];
    const start = m.index;
    const end = sql.indexOf(tag, start + tag.length);
    const stop = end < 0 ? sql.length : end + tag.length;
    blank(start, stop);
    open.lastIndex = stop;
  }
  return out.join('');
}

/** DuckDB の綴りで、注釈・文字列・識別子・ドル引用符を塗り潰す(長さは保つ)。 */
export function stripDuckDbNoise(sql: string): string {
  return stripSqlNoise(stripDollarQuotes(sql));
}

/**
 * 🔴 **DuckDB で断る語**。⚠ sqlite の一覧(`sql-guard.ts` の `WRITE_WORDS`)は
 *   **中で使われる**ので、ここには**DuckDB に固有の分だけ**を書く。
 *
 * | 語 | なぜ断るか |
 * |---|---|
 * | 🔴 `install` / `load` | **拡張を外の CDN から取りに行く** ── 設計 doc §4 の柱と正面から当たる |
 * | 🔴 `set` / `reset` | 上の「門②」(`autoload` を切ってある)を**打つ人が外せてしまう** |
 * | `copy` | `COPY … TO 'x.csv'` は file へ書く |
 * | `export` / `import` | DB 丸ごとの出し入れ |
 * | `call` | `CALL` で走る表関数には副作用を持つものが在る |
 * | `checkpoint` / `truncate` / `use` / `comment` | 書き込み・状態を変える |
 *
 * ⚠ **`attach` / `detach` / `pragma` などは書かない** ── sqlite の一覧に既に在り、
 *   そちらを通すので、2 か所に同じ語を置かない(§7)。
 */
const DUCKDB_WRITE_WORDS = [
  'install',
  'load',
  'set',
  'reset',
  'copy',
  'export',
  'import',
  'call',
  'checkpoint',
  'truncate',
  'use',
  'comment',
] as const;

/**
 * 🔴 **DuckDB でだけ読むだけと確信できる先頭の語**。
 *
 * ⚠ sqlite の白名簿(`select` / `with` / `values` / `explain`)に**足す**形である ──
 *   引けるものを減らすのは user の動線を減らすこと(不可侵指示 2026-08-07)。
 *
 * - `from` ── DuckDB の **FROM 先行**(`FROM t SELECT x`)。user の動機そのもの
 * - `pivot` / `unpivot` ── 文として書ける(`PIVOT t ON …`)
 * - `describe` / `summarize` ── 構造と要約を読むだけ
 * - `table` ── `TABLE t` は `SELECT * FROM t` の略記
 */
const DUCKDB_READ_HEADS = ['from', 'pivot', 'unpivot', 'describe', 'summarize', 'table'] as const;

/**
 * 断り文に並べる「始められる語」。
 * 🔑 **`DUCKDB_READ_HEADS` から組む** ── 語を足した日に、字が自動で追いつく
 *   (手で並べると、足した人が直し忘れて**嘘の案内**が残る)。
 * ⚠ 頭に付く 4 つは sqlite の白名簿(`sql-guard.ts` の `READ_HEADS`)と同じ物である。
 */
const DUCKDB_START_WORDS = ['SELECT', 'WITH', 'VALUES', 'EXPLAIN']
  .concat(DUCKDB_READ_HEADS.map((w) => w.toUpperCase()))
  .join(' / ');

/**
 * 打たれた字が DuckDB で「読むだけ」か。
 *
 * 🔑 **判定の本体は `checkReadOnlySql` を通す**(§7)── ①1 文だけ ②全角を直す
 *   ③`WITH … INSERT` を語で見つける、は sqlite と**まったく同じ規律**である。
 *   ⚠ ここで書き直すと、片方だけ直る食い違いが生まれる。
 *
 * ⚠ 通す順番に意味がある:
 * 1. **先に DuckDB 固有の語で断る**(`INSTALL` など)── 後にすると
 *    sqlite の門が「INSTALL では始められません」と、**外へ出る話に触れない字**を返す
 * 2. 次に sqlite の門へ渡す
 * 3. sqlite の門が**先頭の語だけ**を理由に断った回は、**DuckDB の白名簿で救い直す**
 *    ── `FROM t SELECT x` は sqlite では打てないが DuckDB では読むだけである
 */
export function checkDuckDbSql(input: string): SqlCheck {
  const sql = normalizeOutsideMask(input, stripDuckDbNoise(input));
  const bare = stripDuckDbNoise(sql);
  const body = bare.trim().replace(/;$/, '');

  /**
   * ⚠ **語の切り方は sqlite 側と同じ**(数字と `$` も語の一部 / 直後が `(` なら
   *   関数呼び出しとみなす)── 揃えないと、同じ字が engine によって別の扱いになる。
   */
  const hit = [...body.toLowerCase().matchAll(/([a-z0-9_$]+)(\s*\()?/g)].find(
    (m) => m[2] === undefined && DUCKDB_WRITE_WORDS.includes(m[1] as (typeof DUCKDB_WRITE_WORDS)[number]),
  )?.[1];
  if (hit !== undefined) {
    const why =
      hit === 'install' || hit === 'load'
        ? `${hit.toUpperCase()} は打てません(拡張を外から取りに行く書き方なので、この面では使えません)`
        : hit === 'set' || hit === 'reset'
          ? `${hit.toUpperCase()} は打てません(外へ出ない設定を掛けてあるので、打ち直せません)`
          : `読み取り専用です ── ${hit.toUpperCase()} は打てません(この面は読むだけです)`;
    return { ok: false, why, sql };
  }

  /**
   * ⚠ **返す `sql` は必ずこちらで直した字にする**(`base.sql` を返さない)──
   *   `checkReadOnlySql` は中でもう一度**sqlite の綴りで**塗り潰して全角を直すので、
   *   `$$…$$` の中の全角が**書き換わる**(user が探したい字そのものが変わる)。
   * ⚠ **既知の過剰な断り**:`$$` の中に `DROP` などの語を書くと、内側の判定が
   *   sqlite の綴りで読むので断られる。🔑 安全側であり、断り文は読める ──
   *   直すなら「塗り潰した字を渡せる口」を `sql-guard.ts` に足す(いまは要らない)。
   */
  const base = checkReadOnlySql(sql);
  if (base.ok) return { ok: true, why: '', sql };

  /**
   * 🔴 **DuckDB でだけ読める先頭の語を救い直す**。
   * ⚠ 救うのは**先頭の語が理由で断られた回だけ** ── 2 文打った / 中に `INSERT` が
   *   混じっている、は DuckDB でも同じく断る(`bare` を見て確かめる)。
   */
  const openless = body.replace(/^[\s(]+/, '');
  const head = /^[a-z]+/i.exec(openless)?.[0]?.toLowerCase() ?? '';
  if (!DUCKDB_READ_HEADS.includes(head as (typeof DUCKDB_READ_HEADS)[number])) {
    /**
     * 🔴 **断り文まで sqlite の物を返さない**(#682 段④c。動線レビューが出した)。
     *
     * ⚠ sqlite の門は「SELECT / WITH / VALUES / EXPLAIN のどれかで始めます」と返す ──
     *   ところが **同じ画面の手本は `FROM … SELECT …` で始まっている**。
     *   🔴 user から見ると「FROM で始めてよいのか、駄目なのか」が読めない
     *   (画面の中で辻褄が合わない ── この repo がいちばん嫌う形)。
     * 🔑 だから **DuckDB で始められる語を並べ直す** ── 一覧は
     *   `DUCKDB_READ_HEADS` から組むので、語を足した日に**この字も自動で追いつく**。
     * ⚠ 断るのは sqlite 側と**同じ場面だけ**(先頭の語が理由のとき)── 書き込みの語や
     *   `PRAGMA` の断りは、そのまま sqlite 側の字を通す(理由が違う)。
     */
    return /では始められません/u.test(base.why)
      ? { ...base, why: `${base.why.split('(')[0] ?? ''}(DuckDB では ${DUCKDB_START_WORDS} のどれかで始めます)`, sql }
      : { ...base, sql };
  }
  /**
   * ⚠ **先頭を救うだけでは足りない** ── `FROM t INSERT …` のような形を通さないよう、
   *   sqlite 側と同じ「書き込みの語が混じっていないか」を**もう一度**当てる。
   * 🔑 当てるのは `checkReadOnlySql` の中身ではなく、**同じ字を `SELECT` で包んで
   *   もう一度通す**形にした ── 判定を写さずに済む(§7)。
   */
  const probe = checkReadOnlySql(`SELECT * FROM (${body})`);
  return probe.ok ? { ok: true, why: '', sql } : { ...probe, sql };
}
