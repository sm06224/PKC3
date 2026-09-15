/**
 * 🔴 **どのエンジンで引くか**(#682 段②。user 裁定 2026-09-15 = §9 は A)。
 *
 * ## ① user が何を求めていたのか
 *
 * user 要望 2026-09-03(#682):DuckDB の良さを**利用者に分かち合いたい**。
 * 🔑 だから軸は「速いか」ではなく「**DuckDB の文法をその場で打てるか**」である
 * (設計 doc §3 ── ①が主で、②大きい集計と③parquet は従)。
 *
 * ## ② そのとき画面で何が起きていたか
 *
 * SQL の面には「**調べる相手**」しか無く、引くのは常に同梱の sqlite だった。
 * user 裁定 2026-09-15 は **A**(相手の隣に「どのエンジンで引くか」を 1 つ増やす。
 * 既定はいまの sqlite)。
 *
 * ## ③ だから何を決めたか ── **相手で絞る**
 *
 * 設計 doc §6「組み合わせの矛盾を作らない」の実体がここである。
 * ⚠ **成り立たない組み合わせを画面へ出さない** ── 押せるのに必ず断られる口は、
 *   無言の dead click に近い。
 *
 * | 相手 | 引けるエンジン | なぜ |
 * |---|---|---|
 * | この PKC のノート | sqlite だけ | 正本が sqlite の中に在る。DuckDB へ渡すには**写す**しかなく、写す量も時間も**まだ測っていない**(設計 doc §10) |
 * | 添付 / 手持ちの `.csv` `.tsv` | 🟢 **両方** | bytes は**どちらの道でも読む**ので、DuckDB へ渡すのに写しが 1 バイトも増えない |
 * | 添付の `.sqlite` | sqlite だけ | DuckDB から読むには `sqlite` 拡張が要り、拡張は**外の CDN**から来る(設計 doc §4 と正面から当たる) |
 * | 添付の `.xlsx` | sqlite だけ | 同上(`excel` 拡張) |
 *
 * ⚠ **設計 doc §7 の段① は「この PKC のノートを写したもの」と書いてある** ──
 *   ここはその字と違う。理由は上の表の 1 行目(写す量が未測)で、
 *   🔑 **csv なら写さずに済む**ので、先に通るほうから通した。
 *   これが分かったら覆る条件:**写す量と時間を測って、実用に足りると分かったとき**。
 */
import { sqlGuestSourceOf } from './sql-guest-source';

export type SqlEngine = 'sqlite' | 'duckdb';

/**
 * ⚠ **既定は sqlite**(裁定 A の字そのもの)── 選ばなければ、これまでどおり。
 */
export const DEFAULT_SQL_ENGINE: SqlEngine = 'sqlite';

/**
 * 画面に出す字。⚠ **内部の名前を出さない** ── user が見るのは「どれで引くか」であって、
 *   package の名前ではない。
 */
export const SQL_ENGINE_LABEL: Record<SqlEngine, string> = {
  sqlite: '内蔵の sqlite',
  duckdb: 'DuckDB(追加で読み込みます)',
};

/**
 * その相手で選べるエンジン。⚠ **必ず 1 つ以上返る**(空を返すと選び所が空になる)。
 *
 * @param name 相手の file 名(= 添付ノートの題名)。**`null` = この PKC のノート**。
 *
 * 🔑 拡張子の判定は `sqlGuestSourceOf` **1 か所**を通す(§7「同じ問いに答える口を
 *   2 つ作らない」)── ここで `.csv` を自前に書き直すと、#854 で 1 か所へ寄せた
 *   判定がまた 2 つに割れる。
 */
export function enginesForSource(name: string | null): readonly SqlEngine[] {
  if (name === null) return ['sqlite'];
  // ⚠ `lid` は判定に使われない(`sqlGuestSourceOf` は名前の拡張子だけを見る)
  const kind = sqlGuestSourceOf('', name)?.kind ?? null;
  return kind === 'csv' ? ['sqlite', 'duckdb'] : ['sqlite'];
}

/**
 * 🔴 **選ばれているエンジンを、いまの相手で成り立つ形へ落とす**。
 *
 * ⚠ 相手を選び直すと、さっきまで選べた DuckDB が**選べなくなる**ことがある ──
 *   そのとき `engine` を持ち越すと、**画面には出ていない値で引く**ことになる
 *   (画面と実体の食い違い。この repo がいちばん嫌う形)。
 * 🔑 **落とす先は必ず既定**(sqlite)── 一覧の先頭を採ると、一覧の並びを変えた日に
 *   落ち先が黙って変わる。
 */
export function resolveSqlEngine(want: SqlEngine, name: string | null): SqlEngine {
  return enginesForSource(name).includes(want) ? want : DEFAULT_SQL_ENGINE;
}

/**
 * 🔴 **いま実際に引くエンジン**(= 選んだ物を、いまの相手で成り立つ形へ落とした物)。
 *
 * 🔑 **落とすのはここ 1 か所** ── 描く側(選び所)と走らせる側(`RUN_SQL`)が
 *   別々に落とすと、**選び所には sqlite と出ているのに DuckDB で引く**(あるいは逆)が
 *   起きる(CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」)。
 * ⚠ 引数は `SqlPageState` の**形だけ**を受ける ── features 層は adapter を import しない。
 */
export function sqlEngineOf(page: {
  readonly engine: SqlEngine;
  readonly guest: { readonly name: string } | null;
}): SqlEngine {
  return resolveSqlEngine(page.engine, page.guest?.name ?? null);
}
