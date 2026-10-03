/**
 * 🔴 **複数の file を 1 つの DuckDB へ並べて、1 つの SQL で引く**(#918 段⑦)。
 *
 * ## ① user が何を求めていたのか
 *
 * 売上の csv と在庫の csv を **JOIN で突き合わせたい**(いまは 1 度に 1 件しか調べられず、
 * 2 つを並べるには「片方を表にして打ち直す」しか無い)。
 * 🟣 Gemini 裁定 2026-10-01(#918 の設問):足す口は **調べる相手の一覧の末尾**(= 新しい部品を
 * 作らない)/ 消える扱いは **確認を出さず、字で言う** / 名前は **2 件以上なら全部 file 名から**。
 *
 * ## ② 何を決めたか(この file は判断だけ ── 画面も器も呼ぶだけ)
 *
 * | 決めること | 決め方 |
 * |---|---|
 * | 表の名前 | **1 件**なら今までどおり(`csv` / `json` / `parquet`)。**2 件以上**は**全部**を file 名から(`tableNameFromFile`) |
 * | 上限 | **4 件**(sqlite 側の「見比べる」の上限と同じ根拠 ── 並べるほど常駐メモリが積み上がる) |
 * | 足せる相手 | **DuckDB で読める種類だけ**(`.csv` / `.tsv` / `.parquet` / `.json` 系 / `.sqlite`(#682 段④d))。`.xlsx` は読めない |
 * | `.sqlite` の表の名前 | 1 件だけなら**元の名前のまま**。2 件以上は **`ファイル名_表名`**(中に表が何枚在っても 1 枚ずつ。🟣 Gemini 裁定 2026-10-02) |
 * | 2 件以上のときの engine | **DuckDB 固定**(`sql-engine.ts`) |
 *
 * 🔑 **1 件のときを変えない理由**:今までの手本・案内・user が打ち慣れた `FROM csv` が、
 *   足さない人には 1 バイトも動かない(足した人にだけ名前が変わる)。
 * ⚠ **2 件以上で、1 件目の表の名前が変わる**(`csv` → `売上`)。これは裁定どおりで、
 *   足した瞬間に案内文が「いま調べているのは 売上 / 在庫 の 2 つの表です」と言い直す。
 *
 * 🔑 **表の名前の出どころは 1 か所**(`duckDbTableNamesOf`)── 器が実際に `CREATE TABLE` する名前
 * (`duckdb-runner.ts`)も、画面の案内・手本(`sql-tip.ts`)も同じ関数を呼ぶ。
 * ⚠ 2 か所で組むと「**画面に出ている名前で引けない**」が生まれる(`guestTableNameOf` と同じ作法)。
 */
import {
  duckDbReadableSourceOf,
  guestTableNameOf,
  type DuckDbReadableGuestSource,
} from './sql-guest-source';
import { tableNameFromFile, tableNameFromFileTable } from './sql-table-name';

/** 並べられる file の上限(最初の 1 件を含む)。 */
export const SQL_MAX_SOURCES = 4;

/** 足した相手(最初の 1 件は `sqlPage.guest` が持つので、ここに入るのは 2 件目以降)。 */
export interface SqlExtraSource {
  readonly lid: string;
  readonly name: string;
}

/**
 * 🔴 **画面だけが知っている「`.sqlite` の中の表」の仮の名前**(#682 段④d)。
 *
 * ⚠ `.sqlite` が何枚の表を持つかは**中身を読むまで分からない**。足した相手は選んだだけでは
 *   読まないので、案内文は「`売上_表の名前`」と**形**で言う(実際の名前は走らせた後の器が作る)。
 */
export const SQLITE_INNER_PLACEHOLDER = '表の名前';

/**
 * 🔴 **表の名前を決める**(順番は渡した順)。⚠ 1 つの相手が**何枚の表を作るか**は相手で違う
 * (`.sqlite` だけ、中の表の数)── だから「相手ごとの名前の組」を返す。
 *
 * - 1 件 → 今までどおり(`.csv` → `csv` / `.parquet` → `parquet`)。
 *   🔑 **`.sqlite` は中の表を元の名前のまま**(`SELECT * FROM 売上`)
 * - 2 件以上 → **全部**を file 名から(同名は `_2`)。🔑 **`.sqlite` は `ファイル名_表名`**
 *
 * @param innerOf i 番目の相手が `.sqlite` のとき、その中に在る表の名前(読んだ後でしか分からない)。
 *   ⚠ `.sqlite` 以外の相手のときは**呼ばれない**。
 */
export function duckDbTableGroupsOf(
  sources: readonly DuckDbReadableGuestSource[],
  innerOf: (index: number) => readonly string[],
): string[][] {
  const only = sources.length === 1 ? sources[0] : undefined;
  if (only !== undefined) {
    return [only.kind === 'sqlite' ? [...innerOf(0)] : [guestTableNameOf(only)]];
  }
  const taken = new Set<string>();
  const out: string[][] = [];
  sources.forEach((s, i) => {
    const names: string[] = [];
    if (s.kind === 'sqlite') {
      for (const t of innerOf(i)) {
        const n = tableNameFromFileTable(s.name, t, taken);
        taken.add(n);
        names.push(n);
      }
    } else {
      const n = tableNameFromFile(s.name, taken);
      taken.add(n);
      names.push(n);
    }
    out.push(names);
  });
  return out;
}

/**
 * 画面用:相手 1 つにつき名前 1 つ(`.sqlite` は `ファイル名_表の名前` という**形**)。
 * 🔑 名前の決め方は `duckDbTableGroupsOf` と**同じ 1 本**(器が作る名前と同じ規則)。
 */
export function duckDbTableNamesOf(sources: readonly DuckDbReadableGuestSource[]): string[] {
  return duckDbTableGroupsOf(sources, () => [SQLITE_INNER_PLACEHOLDER]).flat();
}

/** 名前だけから表の名前を決める(画面用)。⚠ 読めない名前は飛ばす。 */
export function duckDbTableNamesOfNames(names: readonly string[]): string[] {
  const sources: DuckDbReadableGuestSource[] = [];
  for (const n of names) {
    const s = duckDbReadableSourceOf('', n);
    if (s !== null) sources.push(s);
  }
  return duckDbTableNamesOf(sources);
}

/** 足せるかどうかの答え。 */
export type AddSourceCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly why: string };

/** DuckDB で読める拡張子(断り文に並べる字)。 */
export const DUCKDB_ADDABLE_EXTS = '.csv / .tsv / .parquet / .json / .sqlite';

/**
 * 🔴 **この file を、もう 1 つ足せるか**。
 *
 * @param primary いま調べている 1 件目(`null` = まだ開いていない / この PKC のノート)。
 * @param extras 既に足してある相手。
 * @param cand 足そうとしている file。
 *
 * ⚠ **断る理由はそのまま画面に出す字**にする(押せるのに何も起きない口を作らない)。
 */
export function checkAddSource(
  primary: { readonly lid: string; readonly name: string } | null,
  extras: readonly SqlExtraSource[],
  cand: { readonly lid: string; readonly name: string },
): AddSourceCheck {
  if (primary === null || duckDbReadableSourceOf('', primary.name) === null) {
    return { ok: false, why: `もう 1 つ足せるのは、${DUCKDB_ADDABLE_EXTS} のどれかを調べているときです` };
  }
  if (duckDbReadableSourceOf('', cand.name) === null) {
    return {
      ok: false,
      why: `${cand.name} は DuckDB で読めないので足せません(足せるのは ${DUCKDB_ADDABLE_EXTS} です)`,
    };
  }
  if (primary.lid === cand.lid || extras.some((e) => e.lid === cand.lid)) {
    return { ok: false, why: `${cand.name} はもう並べてあります` };
  }
  if (1 + extras.length >= SQL_MAX_SOURCES) {
    return { ok: false, why: `並べられるのは ${String(SQL_MAX_SOURCES)} つまでです` };
  }
  return { ok: true };
}

/** 選び所で「足せない」相手に添える理由(薄い字)。 */
export const ADD_UNREADABLE_HINT = 'DuckDB では読めないので足せません';

/**
 * 🔴 **案内文の 1 文**(例:「いま調べているのは 売上 / 在庫 の 2 つの表です」)。
 * ⚠ 名前は**画面で打てる名前**(`duckDbTableNamesOf` と同じ出どころ)を並べる。
 */
export function sqlMultiNote(tables: readonly string[], sqliteNames: readonly string[] = []): string {
  /**
   * 🔴 **`.sqlite` を含むときは、表の数を言わない**(#682 段④d)── 中に何枚在るかは走らせるまで分からない。
   * ⚠ 「2 つの表です」と言うと、`売上.sqlite` が 3 枚の表を持っていても**数が合わない**。
   */
  if (sqliteNames.length > 0) {
    return (
      `いま調べているのは ${tables.join(' / ')} です。` +
      `${sqliteNames.join('、')} の表は、中に在る表ごとに「ファイル名_表の名前」の形で並びます。`
    );
  }
  return `いま調べているのは ${tables.join(' / ')} の ${String(tables.length)} つの表です。`;
}
