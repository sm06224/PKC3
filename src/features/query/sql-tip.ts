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
export function sqlTipText(target: SqlTipTarget | null): string {
  if (target === null) {
    return (
      '調べられるのは entries(ノート)/ relations(つながり)/ revisions(履歴)/ ' +
      'assets(添付)です。' +
      '本文の csv の囲みに名前を付けると(3 つの逆引用符のあとに csv name=売上)、' +
      'その名前で引けます。どんな名前が在るかは csv_tables で分かります' +
      '(使えない名前は、そこの why の列に理由が出ます)。'
    );
  }
  return (
    `いま調べているのは ${target.name} です。この file に在る表: ${tableList(target.tables)}。` +
    // 🔴 **この PKC の表が出てこないことを、先に言う**(打ってから英語で断られない)
    'この file を選んでいる間、この PKC のノートの表(entries など)は出てきません。'
  );
}

/**
 * 薄字の手本(`placeholder`)。
 * 🔑 **相手が変われば手本も変わる** ── 変えないと、打てない字が手本として出る。
 * ⚠ これは**打ち始めた瞬間に消える** ── 消えない側は `sqlExampleText`(#837 K1)。
 */
export function sqlPlaceholder(target: SqlTipTarget | null): string {
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
export function sqlExampleText(target: SqlTipTarget | null): string {
  return `例: ${sqlPlaceholder(target)}`;
}
