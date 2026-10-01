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
 * | 足せる相手 | **DuckDB で読める 3 種類だけ**(`.csv` / `.tsv` / `.parquet` / `.json` 系)。`.xlsx` / `.sqlite` は読めない |
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
import { tableNameFromFile } from './sql-table-name';

/** 並べられる file の上限(最初の 1 件を含む)。 */
export const SQL_MAX_SOURCES = 4;

/** 足した相手(最初の 1 件は `sqlPage.guest` が持つので、ここに入るのは 2 件目以降)。 */
export interface SqlExtraSource {
  readonly lid: string;
  readonly name: string;
}

/**
 * 🔴 **表の名前を決める**(順番は渡した順)。
 *
 * - 1 件 → `guestTableNameOf`(今までどおり)
 * - 2 件以上 → **全部**を file 名から(同名は `_2`)
 */
export function duckDbTableNamesOf(sources: readonly DuckDbReadableGuestSource[]): string[] {
  if (sources.length === 1 && sources[0] !== undefined) return [guestTableNameOf(sources[0])];
  const taken = new Set<string>();
  const out: string[] = [];
  for (const s of sources) {
    const t = tableNameFromFile(s.name, taken);
    taken.add(t);
    out.push(t);
  }
  return out;
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
export const DUCKDB_ADDABLE_EXTS = '.csv / .tsv / .parquet / .json';

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
export function sqlMultiNote(tables: readonly string[]): string {
  return `いま調べているのは ${tables.join(' / ')} の ${String(tables.length)} つの表です。`;
}
