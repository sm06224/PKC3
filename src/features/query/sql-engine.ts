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
 * | 🔴 添付 / 手持ちの `.parquet` `.json` `.ndjson` `.jsonl` | **DuckDB だけ** | 内蔵の sqlite は中身を解釈できない(#682 段④c) |
 * | 添付の `.sqlite` | sqlite だけ | DuckDB から読むには `sqlite_scanner` を**器の中で**当てる段がまだ無い(#682 の次の段) |
 * | 添付の `.xlsx` | sqlite だけ | DuckDB から読むには `excel` 拡張が要る(同梱していない ── `DUCKDB_EXTENSIONS`) |
 *
 * ⚠ **設計 doc §7 の段① は「この PKC のノートを写したもの」と書いてある** ──
 *   ここはその字と違う。理由は上の表の 1 行目(写す量が未測)で、
 *   🔑 **csv なら写さずに済む**ので、先に通るほうから通した。
 *   これが分かったら覆る条件:**写す量と時間を測って、実用に足りると分かったとき**。
 *
 * ## 🔴 **表は 2 方向に間違える**(#682 段④c で 1 つ増えた)
 *
 * ⚠ ここまで「選べない」は **DuckDB の側にしか無かった** ── `sqlite` は
 *   どの相手でも必ず `null`(選べる)を返していた。🔴 `.parquet` を受けた日に
 *   その非対称が崩れる:**sqlite の側にも「選べない相手」が生まれる**。
 * 🔑 だから `resolveSqlEngine` の落とし先も 3 段になっている(下の docstring)。
 */
import {
  isDuckDbOnlySource,
  isDuckDbReadableSource,
  sqlGuestSourceOf,
} from './sql-guest-source';

export type SqlEngine = 'sqlite' | 'duckdb';

/**
 * 🔴 **在るエンジンの全部**(#682 段③c)。
 *
 * ⚠ **`enginesForSource` はここから絞る** ── 一覧を 2 か所に持つと、
 *   足した日に片方だけ増えて「**画面には出るのに選べない**」が生まれる
 *   (CLAUDE.md §7)。
 */
export const SQL_ENGINES: readonly SqlEngine[] = ['sqlite', 'duckdb'];

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
  return SQL_ENGINES.filter((e) => sqlEngineHint(e, name) === null);
}

/**
 * 🔴 **選べないエンジンに添える「どうすれば使えるか」**(#682 段③c)。
 *
 * ## ① user が何を求めていたのか
 *
 * user 報告 2026-09-16:**DuckDB の導線が無い**。
 *
 * ## ② そのとき画面で何が起きていたか
 *
 * 選び所は `choices.length < 2` のときに**丸ごと消えて**いた ── つまり
 * **取り込んだ `.csv` を選んでいる間しか存在しない**。⚠ user から見ると
 * 「DuckDB を載せたと書いてあるのに、画面のどこにも無い」になる。
 * 🔑 **消す作りが、そのまま「無い」に見えていた**。
 *
 * ## ③ だから何を決めたか
 *
 * **選び所は常に出し、選べない側は薄い字にして、その隣に「どうすれば使えるか」を書く。**
 * ⚠ これは「押せるのに必ず断られる口」ではない ── `option` は `disabled` なので
 *   **選べない**うえ、**なぜ選べないか**がその場に書いてある。
 *
 * @returns `null` = **その相手で選べる**。文字列 = 選べない理由(画面に出す字)。
 */
export function sqlEngineHint(engine: SqlEngine, name: string | null): string | null {
  // ⚠ `lid` は判定に使われない(`sqlGuestSourceOf` は名前の拡張子だけを見る)
  const src = name === null ? null : sqlGuestSourceOf('', name);
  if (engine === 'sqlite') {
    /**
     * 🔴 **内蔵の sqlite が中身を読めない相手**(#682 段④c)。
     * ⚠ ここが `null` を返し続けると、**画面には「内蔵の sqlite」と出ているのに
     *   DuckDB で引く**(あるいはその逆)が起きる ── `resolveSqlEngine` は
     *   「選べる物」からしか選ばないので、嘘をつくのは**この関数の側**になる。
     */
    return isDuckDbOnlySource(src) ? 'この形式は DuckDB でだけ引けます' : null;
  }
  if (name === null) return '取り込んだ .csv / .parquet / .json などを選ぶと使えます';
  /**
   * 🔑 **読めるかどうかは `DUCKDB_READABLE_KINDS` 1 か所**(#682 段④c)──
   *   ここで種類を並べ直すと、走らせる側(`duckdb-runner.ts`)と食い違った日に
   *   「**選べるのに、押すと組み方が分からない**」が生まれる。
   */
  if (isDuckDbReadableSource(src)) return null;
  return '.csv / .tsv / .parquet / .json のときだけ使えます';
}

/**
 * 🔴 **選ばれているエンジンを、いまの相手で成り立つ形へ落とす**。
 *
 * ⚠ 相手を選び直すと、さっきまで選べた DuckDB が**選べなくなる**ことがある ──
 *   そのとき `engine` を持ち越すと、**画面には出ていない値で引く**ことになる
 *   (画面と実体の食い違い。この repo がいちばん嫌う形)。
 * 🔴 **落とし先も「その相手で選べる物」でなければならない**(#682 段④c。
 *   着手前の実地調査が見つけ、実装を読んで裏を取った)。
 *
 * ⚠ 直す前はここが **`DEFAULT_SQL_ENGINE` 固定**で、docstring には
 *   「落とす先は必ず既定(sqlite)── 一覧の先頭を採ると、一覧の並びを変えた日に
 *   落ち先が黙って変わる」と書いてあった。🔑 その理屈は正しいが、**片手落ち**である ──
 *   **既定そのものが選べない相手**が現れた瞬間、「選べないので落とす」が
 *   **選べない値へ落とす**になる。
 * 🔴 いままで踏まなかったのは、`sqlEngineHint` が `sqlite` で**必ず「選べる」を返して
 *   いた**からにすぎない ── ⚠ そして `tests/features/sql-engine.test.ts` が
 *   「**どの相手でも必ず選べる**」を**正しい仕様として pin していた**ので、
 *   この片手落ちは検算する足場ごと無かった。
 * ⚠ 踏んだときの症状は、この repo がいちばん嫌う形である:
 *   **選び所には DuckDB が出ている**(sqlite は薄い字で選べない)**のに、
 *   走らせるのは sqlite** ── 画面と実体の食い違いである。
 *
 * 🔑 だから **3 段**にする:①欲しい物が選べるならそれ ②既定が選べるなら既定
 *   ③どちらも駄目なら**選べる物の先頭**。⚠ ③で並びが効くのは
 *   **既定が選べないときだけ**なので、上の懸念(並びを変えた日に黙って変わる)は
 *   ①②で吸われる。
 * ⚠ `enginesForSource` は**必ず 1 つ以上返す**が、`?? DEFAULT_SQL_ENGINE` は
 *   **型のための受け**であって、通る道ではない(0 件になる形は
 *   `tests/features/sql-engine.test.ts` が全数で潰している)。
 */
export function resolveSqlEngine(want: SqlEngine, name: string | null): SqlEngine {
  const usable = enginesForSource(name);
  if (usable.includes(want)) return want;
  if (usable.includes(DEFAULT_SQL_ENGINE)) return DEFAULT_SQL_ENGINE;
  return usable[0] ?? DEFAULT_SQL_ENGINE;
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
