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
export function sqlTipText(target: SqlTipTarget | null, engine: SqlEngine = 'sqlite'): string {
  if (target === null) {
    return (
      '調べられるのは entries(ノート)/ relations(つながり)/ revisions(履歴)/ ' +
      'assets(添付)です。' +
      '本文の csv の囲みに名前を付けると(3 つの逆引用符のあとに csv name=売上)、' +
      'その名前で引けます。どんな名前が在るかは csv_tables で分かります' +
      '(使えない名前は、そこの why の列に理由が出ます)。' +
      /**
       * 🔴 **DuckDB が在ることを、ここで知らせる**(#682 段②)。
       * ⚠ 「どのエンジンで引くか」の選び所は、**選べるものが 2 つ以上あるときだけ出る**
       *   (`enginesForSource`)── つまり最初の画面には出ない。
       *   🔑 知らせないと、**在ることに気づけないまま**になる(user の動機は
       *   「DuckDB を分かち合いたい」なので、隠れているのはいちばん悪い)。
       */
      '取り込んだ .csv や .tsv を選ぶと、DuckDB でも引けます。'
    );
  }
  if (engine === 'duckdb') {
    /**
     * ⚠ **DuckDB は写した表 1 つしか持たない** ── 先に言わないと、
     *   打ってから英語で「そんな表は無い」と返る。
     */
    return (
      `いま調べているのは ${target.name} を DuckDB へ写した表 csv です。` +
      '列は _note と _lid のあとに、file の見出しがそのまま並びます。' +
      'この file を選んでいる間、この PKC のノートの表(entries など)は出てきません。'
    );
  }
  return (
    `いま調べているのは ${target.name} です。この file に在る表: ${tableList(target.tables)}。` +
    // 🔴 **この PKC の表が出てこないことを、先に言う**(打ってから英語で断られない)
    'この file を選んでいる間、この PKC のノートの表(entries など)は出てきません。'
  );
}

/**
 * 🔴 **打ち方の約束は engine ごとに違う**(#682 段②)。
 * ⚠ `SQL_RULES` は**同梱の sqlite を実測した字**なので、DuckDB にはそのまま当たらない
 *   (DuckDB には正規表現が在り、FROM 先行が書ける)── 出し分けないと**嘘になる**。
 */
export function sqlRulesText(engine: SqlEngine = 'sqlite'): string {
  if (engine !== 'duckdb') return SQL_RULES;
  return (
    '読むだけで、書き換えはできません。' +
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
export function sqlPlaceholder(target: SqlTipTarget | null, engine: SqlEngine = 'sqlite'): string {
  /**
   * 🔴 **DuckDB の手本は DuckDB の文法で出す**(#682 段②)。
   * ⚠ 相手に依らず表の名前は `csv` 固定(写した先の名前)── だから
   *   `target.tables`(sqlite が読んだ表)を使わない。
   */
  if (engine === 'duckdb') return 'FROM csv SELECT * LIMIT 20';
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
export function sqlExampleText(target: SqlTipTarget | null, engine: SqlEngine = 'sqlite'): string {
  return `例: ${sqlPlaceholder(target, engine)}`;
}
