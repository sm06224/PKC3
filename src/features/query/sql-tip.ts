/**
 * 🔴 **SQL の面の案内文と、薄字の手本**(#681 の着地前レビュー F2)。
 *
 * ## なぜ切り出したか
 *
 * ⚠ 直す前、案内文は**状態を 1 つも見ない静的な字**だった ── 取り込んだ
 * `.sqlite` を選んでも「調べられるのは entries(ノート)/ relations …」のままで、
 * 🔴 **書いてあるとおり打つと `no such table: entries` という英語が返る**。
 * そのうえ**その file に在る表の名前は画面のどこにも出ない**(state には届いて
 * いるのに、描画器は個数だけを使っていた)。
 *
 * 🔑 だから「いま調べている相手」を受け取って、**案内も手本もそちらへ揃える**。
 * ⚠ 判断をここへ置くのは、`sql.ts`(描画器)に字を書き散らさないためである(§7)。
 */

import type { SqlEngine } from './sql-engine';
import { guestTableNameOf, duckDbReadableSourceOf } from './sql-guest-source';
import { DUCKDB_TABLE_LIFETIME, DUCKDB_TABLE_RESET, DUCKDB_WRITE_FORMS } from './duckdb-write';
import { duckDbTableNamesOfNames, sqlMultiNote } from './sql-multi-source';
import { tableNameFromFileTable } from './sql-table-name';
import { quoteIdent } from './sqlite-ndjson';
import type { DuckDbCopyReport } from './duckdb-copy-report';
import { MAX_CELL_CHARS } from './sql-cell';

/**
 * 表が 1 枚も無い `.sqlite` を DuckDB で開いたときの手本(表の一覧)。
 * ⚠ `SHOW TABLES` ではない ── 字の門(`duckdb-guard.ts`)が先頭の語を `SELECT` / `WITH` / `FROM` …
 *   に絞っているので断られる(手本が打てないのは、いちばん悪い形の dead click)。
 */
export const DUCKDB_TABLE_LIST_SQL = 'SELECT table_name FROM information_schema.tables';

/** 名前を並べる上限。⚠ 表が何十個も在る DB で、案内文が画面を埋めない。 */
export const TIP_TABLES_MAX = 8;

/** いま調べている相手(`null` = この PKC のノート)。 */
export interface SqlTipTarget {
  readonly name: string;
  readonly tables: readonly string[];
}

/** ⚠ **実測したことだけ書く**(`sqlite-capabilities.test.ts` が pin している)。 */
/**
 * 🔴 **打ち方の約束**(#837 K1 で 2 行目へ分けた)。
 * ⚠ 直す前は「何が調べられるか」と同じ 1 段落に詰まっていて、**6 文が続けて**
 *   並んでいた ── 読み飛ばされる長さである。
 * ⚠ **実測したことだけ書く**(`sqlite-capabilities.test.ts` が pin している)。
 */
export const SQL_RULES =
  '読むだけで、書き換えはできません。' +
  '文字列は単引用符で囲みます(二重引用符は列の名前です)。' +
  'REGEXP は使えません(LIKE と GLOB は使えます)。' +
  '日本語入力のままでも打てます(ただし LIKE の ％ と ＿ は半角で打ってください)。';

/**
 * 🔴 **履歴の一覧に出す 1 行**(#918 段②a。user 裁定 2026-09-14)。
 *
 * ⚠ 打った字はそのままでは一覧に載らない ── **改行を含む**し、**いくらでも長い**。
 *   1 件で画面を埋めると「新しい順に並んでいる」という一覧の値打ちが消える。
 * 🔑 改行は `⏎` 1 文字へ畳み、続く空白も 1 つへ詰めてから、上限で切る
 *   (切ったことは `…` で言う ── 黙って切らない)。
 * ⚠ 空は返さない ── 空の押し所は「押せるのに何も起きない口」になる。
 */
export const SQL_MENU_LABEL_MAX = 48;

export function sqlMenuLabel(sql: string): string {
  const one = sql.replace(/\s*\n\s*/g, ' ⏎ ').replace(/[ \t]+/g, ' ').trim();
  if (one === '') return '(空)';
  return one.length <= SQL_MENU_LABEL_MAX ? one : `${one.slice(0, SQL_MENU_LABEL_MAX)}…`;
}

/**
 * 🔴 **DuckDB で引くときに案内・手本へ並べる表の名前 = 写した表**(着地後レビュー ⚠2)。
 *
 * ⚠ 開いてある客(`target.tables`)は**内蔵の sqlite で引ける表**で、DuckDB へ写さなかった表
 *   (全文検索の仮想表・大きすぎる表。`copy.refused`)を含む ── そのまま並べると、**書いてあるとおり打つと
 *   DuckDB では `no such table`** になる(手本が 1 つ目の表なら、手本そのものが打てない)。
 *   写さなかった表は帯・つながり図の下・構造ノートが名前つきで言う。
 * ⚠ **まだ写していない回**(`copy === null`)は何を写さないかを知らない ── 開いてある客の表をそのまま返す。
 * 🔑 並べているとき(`multi`)の器での名前は `ファイル名_表名`(`duckdb-runner.ts` の `refused` と同じ規則)。
 */
export function copiedTableNames(
  target: SqlTipTarget,
  copy: DuckDbCopyReport | null,
  multi: boolean,
): string[] {
  if (copy === null) return [...target.tables];
  const refused = new Set(copy.refused.filter((r) => !r.view).map((r) => r.name));
  return target.tables.filter(
    (t) => !refused.has(multi ? tableNameFromFileTable(target.name, t, new Set()) : t),
  );
}

/** 表の名前を、上限まで並べる。 */
function tableList(tables: readonly string[]): string {
  if (tables.length === 0) return '(表が 1 つもありません)';
  const head = tables.slice(0, TIP_TABLES_MAX).join(', ');
  return tables.length > TIP_TABLES_MAX
    ? `${head} ほか ${String(tables.length - TIP_TABLES_MAX)} 個`
    : head;
}

/**
 * 🔴 **案内の 1 行目 ── 何が調べられるか**(#837 K1 で 2 行に割った)。
 * ⚠ 記号を書かない(`textContent` なので、書いた記号はそのまま画面に出る)。
 */
export function sqlTipText(
  target: SqlTipTarget | null,
  engine: SqlEngine = 'sqlite',
  /** 🔴 足した相手の file 名(#918 段⑦)。1 件でも在れば**並べている**。 */
  more: readonly string[] = [],
  /**
   * 🔴 **いまの器へ写した報告**(#682 段④d の着地後レビュー D2)。⚠ `.sqlite` の案内に「BLOB の列は base64 の文字」と
   *   書くのは、**BLOB の列を持つ表を写した後だけ**(まだ写していない / 無いときに書くと、無い物の注意になる)。
   */
  copy: DuckDbCopyReport | null = null,
): string {
  if (target !== null && more.length > 0) return multiTipText([target.name, ...more], target.tables);
  if (target === null) {
    return (
      '調べられるのは entries(ノート)/ relations(つながり)/ revisions(履歴)/ ' +
      'assets(添付)です。' +
      '本文の csv の囲みに名前を付けると(3 つの逆引用符のあとに csv name=売上)、' +
      'その名前で実行できます。どんな名前があるかは csv_tables で分かります' +
      '(使えない名前は、そこの why の列に理由が出ます)。' +
      /**
       * 🔴 **DuckDB が在ることを、ここで知らせる**(#682 段②)。
       * ⚠ 「どのエンジンで引くか」の選び所は、**選べるものが 2 つ以上あるときだけ出る**
       *   (`enginesForSource`)── つまり最初の画面には出ない。
       *   🔑 知らせないと、**在ることに気づけないまま**になる(user の動機は
       *   「DuckDB を分かち合いたい」なので、隠れているのはいちばん悪い)。
       */
      '取り込んだ .csv や .tsv、.parquet や .json、.sqlite を選ぶと、DuckDB でも実行できます(DuckDB では表を作ることもできます)。'
    );
  }
  if (engine === 'duckdb') {
    /**
     * ⚠ **DuckDB は最初は写した表 1 つしか持たない**(自分で作れば増える ── #918 段⑧)── 先に言わないと、
     *   打ってから英語で「そんな表は無い」と返る。
     *
     * 🔴 **表の名前も、足す列も、相手ごとに違う**(#682 段④c)。
     * ⚠ 直す前のここは **`csv` と `_note` / `_lid` を直書き**していて、
     *   docstring にも「相手に依らず表の名前は `csv` 固定」と書いてあった ──
     *   段② の時点では本当だったが、`.parquet` を受けた日に**嘘になった**。
     *   🔴 そのとき画面は「表 csv です」と言い、手本も `FROM csv …` を出すので、
     *   **書いてあるとおり打つと英語で断られる**(いちばん悪い形の dead click)。
     * 🔑 だから名前は `guestTableNameOf` **1 か所**から採る ── 器が
     *   `CREATE TABLE` する名前と同じ物である(`duckdb-runner.ts` も同じ関数を呼ぶ)。
     */
    const src = duckDbReadableSourceOf('', target.name);
    /**
     * 🔴 **`.sqlite` は表が何枚も在り、名前は元のまま**(#682 段④d)。⚠ `guestTableNameOf` は
     *   「1 つの file = 1 つの表」の相手だけを受ける(型で外してある)── ここで分ける。
     *   🔑 並べる表の名前は**選んだ時点で開いてある客**(`target.tables`)から採る。
     */
    if (src?.kind === 'sqlite') {
      return (
        `いま調べているのは ${target.name} を DuckDB へコピーした表です。このファイルにある表: ${tableList(target.tables)}。` +
        '表の名前は元のままです。' +
        (copy?.blob === true
          ? `BLOB の列は base64 の文字として入ります(長い字は ${String(MAX_CELL_CHARS)} 字までで切って出します)。`
          : '') +
        'このファイルを選んでいる間、この PKC のノートの表(entries など)は出てきません。'
      );
    }
    const table = src === null ? (target.tables[0] ?? 'csv') : guestTableNameOf(src);
    return (
      `いま調べているのは ${target.name} を DuckDB へコピーした表 ${table} です。` +
      (src !== null && src.kind !== 'csv'
        ? // 🔑 `.parquet` / `.json` は**相手の列そのまま**(`_note` / `_lid` を足さない)
          '列は、そのファイルに書いてある列がそのまま並びます。'
        : '列は _note と _lid のあとに、ファイルの見出しがそのまま並びます。') +
      'このファイルを選んでいる間、この PKC のノートの表(entries など)は出てきません。'
    );
  }
  return (
    `いま調べているのは ${target.name} です。このファイルにある表: ${tableList(target.tables)}。` +
    // 🔴 **この PKC の表が出てこないことを、先に言う**(打ってから英語で断られない)
    'このファイルを選んでいる間、この PKC のノートの表(entries など)は出てきません。'
  );
}

/**
 * 🔴 **2 つ以上の file を並べているときの案内**(#918 段⑦。Gemini 裁定 2026-10-01 = 名前を並べて出す)。
 *
 * 1 文目は「いま調べているのは 売上 / 在庫 の 2 つの表です」(裁定の字)。
 * 🔑 **file 名 → 表の名前**の対応も添える(`2024-sales.csv` → `_2024_sales` は、
 *   file 名からは想像が付かない ── 引けない名前を打たせない)。
 */
function multiTipText(names: readonly string[], firstTables: readonly string[]): string {
  const tables = duckDbTableNamesOfNames(names);
  const isSqlite = (n: string): boolean => duckDbReadableSourceOf('', n)?.kind === 'sqlite';
  /**
   * 🔴 **`.sqlite` は、実名が分かる物だけ実名で言う**(#682 段④d の着地後レビュー D4)。
   * ⚠ 直す前は 2 つ目以降も `在庫_表の名前` と書き、**実際にそういう名前の表が在るように読めた**
   *   (表の名前は、中に在る表の名前で決まる ── 走らせるまで分からない)。
   * 🔑 1 つ目は**もう開いてある**(`firstTables` = 中の表の実名)ので、`ファイル名_表名` の実名を並べる。
   *   2 つ目以降は読んでいないので、**形**だけを言う。
   */
  const real = (n: string, i: number): string[] =>
    i === 0 && isSqlite(n) ? firstTables.map((t) => tableNameFromFileTable(n, t, new Set())) : [];
  const pairs = names
    .map((n, i) => {
      if (!isSqlite(n)) return `${n} → ${tables[i] ?? ''}`;
      const r = real(n, i);
      return r.length > 0 ? `${n} → ${r.join(' / ')}` : `${n} → ファイル名_表名 の形`;
    })
    .join('、');
  const anyCsv = names.some((n) => duckDbReadableSourceOf('', n)?.kind === 'csv');
  // 🔴 `.sqlite` を含むときは表の数を言わない(中に何枚在るかは走らせるまで分からない)
  const sqliteNames = names.filter(isSqlite);
  // 🔑 1 文目に並べる名前も同じ規則(実名が分かる物は実名 / 分からない `.sqlite` は「の中の表」)
  const shownTables = names.flatMap((n, i) => {
    if (!isSqlite(n)) return [tables[i] ?? ''];
    const r = real(n, i);
    return r.length > 0 ? r : [`${n} の中の表`];
  });
  return (
    sqlMultiNote(shownTables, sqliteNames) +
    `表の名前はファイルの名前から付けています(${pairs})。` +
    // 🔑 名前の引き方(D4)── 実名が分からなくても、一覧は DuckDB に聞ける
    (sqliteNames.length > 0 ? `表の名前の一覧は ${DUCKDB_TABLE_LIST_SQL} で実行できます。` : '') +
    'JOIN で突き合わせられます。' +
    (anyCsv ? '.csv / .tsv の表には、先頭に _note と _lid の列が付きます。' : '') +
    'これらのファイルを調べている間、この PKC のノートの表(entries など)は出てきません。'
  );
}

/**
 * 🔴 **打ち方の約束は engine ごとに違う**(#682 段②)。
 * ⚠ `SQL_RULES` は**同梱の sqlite を実測した字**なので、DuckDB にはそのまま当たらない
 *   (DuckDB には正規表現が在り、FROM 先行が書ける)── 出し分けないと**嘘になる**。
 */
export function sqlRulesText(engine: SqlEngine = 'sqlite'): string {
  if (engine !== 'duckdb') return SQL_RULES;
  /**
   * 🔴 **DuckDB では書ける**(#918 段⑧)。⚠ 直す前の「読むだけで、書き換えはできません」は
   *   **この engine では嘘になる**ので外した(sqlite の約束 `SQL_RULES` は変えない)。
   * 🔴 **寿命を先に言う** ── 作った表は**ウィンドウを閉じると消える**(別の file を選び直した
   *   ときも器を作り直すので消える)。黙って消えると、user は保存されたと読む。
   * 🔑 字は `duckdb-write.ts` の 2 つの定数から組む(知らせの字と食い違わない)。
   */
  return (
    `表も作れます(${DUCKDB_WRITE_FORMS})。` +
    `${DUCKDB_TABLE_LIFETIME}(別のファイルを選び直したときも消えます)。${DUCKDB_TABLE_RESET}。元のファイルは書き換わりません。` +
    'FROM から書き始められます。PIVOT や QUALIFY も打てます。' +
    '外から追加の部品を取ってくる書き方(INSTALL / LOAD)と、設定を変える SET は打てません。' +
    '日本語入力のままでも打てます。'
  );
}

/**
 * 薄字の手本(`placeholder`)。
 * 🔑 **相手が変われば手本も変わる** ── 変えないと、打てない字が手本として出る。
 * ⚠ これは**打ち始めた瞬間に消える** ── 消えない側は `sqlExampleText`(#837 K1)。
 */
export function sqlPlaceholder(
  target: SqlTipTarget | null,
  engine: SqlEngine = 'sqlite',
  more: readonly string[] = [],
): string {
  /**
   * 🔴 **並べているときの手本は、1 つ目の表を引く形**(#918 段⑦)。⚠ 表の名前は
   *   `duckDbTableNamesOfNames` 1 か所 ── 器が作る名前と同じ物を出す(`csv` 固定ではない)。
   * ⚠ 全部を `,` で並べる形にしない ── 突き合わせる列の無い**総当たり**(行数の掛け算)を手本にしてしまう。
   */
  if (target !== null && more.length > 0) {
    /**
     * 🔴 **1 つ目が `.sqlite` のときは、開いてある客の実際の表で手本を作る**(#682 段④d)。
     * ⚠ `duckDbTableNamesOfNames` は `.sqlite` を「`売上_表の名前`」という**形**でしか言えない ──
     *   そのまま手本にすると**打っても引けない**。1 つ目は取り置きの名前が空なので、
     *   `ファイル名_最初の表` がそのまま器の名前になる(`duckDbTableGroupsOf` と同じ規則)。
     */
    if (duckDbReadableSourceOf('', target.name)?.kind === 'sqlite') {
      const t = target.tables[0];
      return t === undefined
        ? DUCKDB_TABLE_LIST_SQL
        : `FROM ${tableNameFromFileTable(target.name, t, new Set())} SELECT * LIMIT 20`;
    }
    const first = duckDbTableNamesOfNames([target.name, ...more])[0];
    return `FROM ${first ?? 'csv'} SELECT * LIMIT 20`;
  }
  /**
   * 🔴 **DuckDB の手本は DuckDB の文法で、いまの相手の表の名前で出す**(#682 段④c)。
   * ⚠ 直す前はここが **`FROM csv …` 固定**だった ── `.parquet` を選ぶと
   *   **手本をそのまま打って英語で断られる**(`sqlTipText` と同じ根)。
   */
  if (engine === 'duckdb') {
    const src = target === null ? null : duckDbReadableSourceOf('', target.name);
    // 🔴 `.sqlite` は元の名前のまま ── 1 つ目の表を引く(表が無い DB は表の一覧)
    if (src?.kind === 'sqlite') {
      const t = target?.tables[0];
      return t === undefined ? DUCKDB_TABLE_LIST_SQL : `FROM ${quoteIdent(t)} SELECT * LIMIT 20`;
    }
    return `FROM ${src === null ? 'csv' : guestTableNameOf(src)} SELECT * LIMIT 20`;
  }
  if (target === null) {
    return 'SELECT title, updated_at FROM entries ORDER BY updated_at DESC LIMIT 20';
  }
  const first = target.tables[0];
  return first === undefined
    ? 'SELECT name FROM sqlite_schema'
    : `SELECT * FROM "${first}" LIMIT 20`;
}

/**
 * 🔴 **打ち始めても消えない手本**(#837 K1、2026-09-09)。
 *
 * ## 直す前、画面で何が起きていたか
 *
 * SQL を知らない人が開くと、欄には薄字で手本が出ている。「これを走らせれば
 * いいのか」と **走らせる** を押すと、⚠ 薄字は値ではないので「SQL が空です」と
 * 断られる。そして**欄を 1 文字触れば薄字は消え、手本は画面から永久に消える**。
 *
 * ⚠ 残るのは案内文だけで、そこに**例文は 1 つも無かった** ── この面は
 * 「打つために開く」面なのに、**打つ物の見本が画面から消える**作りだった。
 * ⚠ マニュアルには例が 5 つ載っているが、この面は**別の窓**なので辿れない。
 *
 * 🔑 だから**字として置く**(薄字ではない)── 消えないので、見ながら写せる。
 * ⚠ 中身は `sqlPlaceholder` と**同じ 1 本**から採る(手本を 2 通り持たない)。
 */
export function sqlExampleText(
  target: SqlTipTarget | null,
  engine: SqlEngine = 'sqlite',
  more: readonly string[] = [],
): string {
  return `例: ${sqlPlaceholder(target, engine, more)}`;
}
