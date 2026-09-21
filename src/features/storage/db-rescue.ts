/**
 * 🔴 **壊れた DB から「何が壊れているか」を読み、拾えるだけ拾う**(#971 段③)。
 *
 * ## なぜ「直す」ではなく「拾う」なのか ── 実測で決まった
 *
 * 2026-09-16 に、同梱の sqlite 3.53.0 へ**壊した DB を作って**当てた結果:
 *
 * | 壊れた所 | REINDEX | DROP+CREATE INDEX | VACUUM INTO |
 * |---|---|---|---|
 * | 本文の表 | 🔴 rc 11 | ── | 🔴 rc 11 |
 * | PK の自動索引 | 🔴 rc 11 | ── | 🔴 rc 11 |
 * | 名前つきの索引 2 種 | 🔴 rc 11 | 🔴 rc 11 | 🔴 rc 11 |
 *
 * 🔴 **12 回とも同じ rc 11** ── しかも**user がいま見ているのと同じ字**で落ちる。
 *   だから「索引を組み直す」口は**作らない**(押しても同じエラーを見せるだけである)。
 *
 * 🔑 **そのかわり読む側は強い** ── 索引だけ壊れているなら、中身は 1 行も失われない
 *   (4000 行入れて 4000 行読めた)。⚠ ただし**索引を使う形で引くと落ちる**ので、
 *   拾う側は必ず `NOT INDEXED` を付ける(実測: `WHERE cid=? AND from_lid=?` は
 *   rc 11 / 同じ条件 + `NOT INDEXED` は通る)。
 *
 * ⚠ **区切りを細かくしても回収量は増えない**(実測: 1000 / 100 / 10 / 1 行の
 *   4 通りで **135 行のまま**)── 届く範囲は壊れ方が決める。
 * 🔴 **そして大半の区画は、エラーではなく「空」で返る**(区切り 100 行で 38/40)──
 *   だから**「拾えた件数」を「全部」と読ませてはいけない**。件数と一緒に
 *   **拾えなかった区画の数**を必ず出す。
 */

/** `sqlite_schema` の 1 行(root page → その page が何の木か)。 */
/**
 * 🔴 **押させるボタンの字は、ここ 1 か所から引く**(#986 段③ / #1006)。
 * ⚠ 手で書くと、改名した日に**画面に無い字を探させる**(#996 と同じ型 ──
 *   実際にこの file が 2 日間そうなっていた)。
 */
import { BACKUP_LABEL, CONTAINER_REBUILD_LABEL } from './rescue-labels';

export interface SchemaRoot {
  readonly type: string;
  readonly name: string;
  readonly rootpage: number;
}

/** `PRAGMA quick_check` を読んだ結果。 */
export interface IntegrityReport {
  /** 壊れが 1 つも見つからなかった。 */
  readonly ok: boolean;
  /** 壊れが見つかった**表**の名前(重複なし)。 */
  readonly brokenTables: readonly string[];
  /** 壊れが見つかった**索引**の名前(重複なし)。 */
  readonly brokenIndexes: readonly string[];
  /** ⚠ どの木か**言い当てられなかった**行(隠さずに残す)。 */
  readonly unresolved: readonly string[];
  /** 実際に返ってきた行(改行で割った後)。⚠ 上限で切ったら `truncated`。 */
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

/**
 * 🔑 **1 回に読む行数**。⚠ 細かくしても回収量は増えない(上の実測)ので、
 *   小さくする意味は**落ちた 1 区画で捨てる量を減らす**ことだけである。
 * ⚠ 大きすぎると 1 回の応答が重くなるので、本文を運ぶ側はこの値で刻む。
 */
export const RESCUE_CHUNK = 200;

/** `PRAGMA quick_check` に渡す上限(⚠ 無制限にすると数 GB で終わらない)。 */
export const QUICK_CHECK_MAX_ERRORS = 200;

/** 返す行の上限(⚠ 画面に出すので、出しすぎると読めない)。 */
export const QUICK_CHECK_MAX_LINES = 200;

/**
 * 🔴 `Tree <N> page …` の `N` は**その木の root page** である(実測で確認)。
 * ⚠ `Page <N>: never used` の `N` は root ではなく**ただの page 番号**なので、
 *   木の名前には使えない ── 混ぜると**無関係な表を「壊れている」と名指しする**。
 */
const TREE_RE = /\bTree (\d+) page\b/;

/** `wrong # of entries in index X` / `row N missing from index X` / `non-unique entry in index X`。 */
const INDEX_NAME_RE = /\bin index ([A-Za-z_][A-Za-z_0-9$]*)/;

/** ⚠ 壊れの報告ではない行(見出し・区切り)。名指しの材料に使わない。 */
const HEADER_RE = /^\*\*\* in database .* \*\*\*$/;

/**
 * `PRAGMA quick_check` の出力を読む。
 *
 * ⚠ **1 行 1 件ではない** ── 実測では、1 つのセルに改行で何十件も入って返る。
 *   だから**先に改行で割る**(割らないと、2 件目以降を 1 度も見ない)。
 */
export function parseQuickCheck(
  rows: readonly string[],
  schema: readonly SchemaRoot[],
): IntegrityReport {
  const all: string[] = [];
  for (const r of rows) for (const l of String(r).split('\n')) if (l.trim() !== '') all.push(l.trim());

  // ⚠ 健全なときは **`ok` の 1 行だけ**(実測)。`includes` にしない ──
  //    壊れの説明文に `ok` の字が混じったときに「無事」と読んでしまう。
  if (all.length === 1 && all[0] === 'ok') {
    return { ok: true, brokenTables: [], brokenIndexes: [], unresolved: [], lines: ['ok'], truncated: false };
  }

  const byRoot = new Map<number, SchemaRoot>();
  for (const s of schema) byRoot.set(s.rootpage, s);
  const byName = new Map<string, SchemaRoot>();
  for (const s of schema) byName.set(s.name, s);

  const tables = new Set<string>();
  const indexes = new Set<string>();
  const unresolved: string[] = [];

  for (const line of all) {
    if (HEADER_RE.test(line)) continue;
    const named = INDEX_NAME_RE.exec(line)?.[1];
    if (named !== undefined) {
      indexes.add(named);
      continue;
    }
    const tree = TREE_RE.exec(line)?.[1];
    if (tree !== undefined) {
      const hit = byRoot.get(Number(tree));
      if (hit === undefined) {
        // ⚠ 対応づかない = schema そのものが読めていない可能性 ── 隠さない
        unresolved.push(line);
      } else if (hit.type === 'index') {
        indexes.add(hit.name);
      } else {
        tables.add(hit.name);
      }
      continue;
    }
    unresolved.push(line);
  }

  /**
   * 🔑 **索引の名前から、その索引が載っている表を引く**のはしない ── 「どの表の
   *   索引か」は `sqlite_schema.tbl_name` に在るが、⚠ **壊れているのは索引であって
   *   表ではない**。表の名前に混ぜると「本文が壊れた」と誤って伝える。
   */
  for (const n of indexes) if (byName.get(n)?.type === 'table') { indexes.delete(n); tables.add(n); }

  const truncated = all.length > QUICK_CHECK_MAX_LINES;
  return {
    ok: false,
    brokenTables: [...tables].sort(),
    brokenIndexes: [...indexes].sort(),
    unresolved,
    lines: truncated ? all.slice(0, QUICK_CHECK_MAX_LINES) : all,
    truncated,
  };
}

/**
 * 画面に出す 1 行。
 *
 * ⚠ **記法を書かない**(素のテキストとして出る面がある)。
 * 🔑 **次の一手を必ず書く** ── 「壊れています」だけでは user は何もできない。
 *
 * ## 🔴 押させる字は、定数から引く(2026-09-18 に直した)
 *
 * ⚠ 直す前、ここは **3 か所とも「拾えるだけ取り出す」**と書いていた ──
 *   🔴 **その字は 2026-09-16(#986)に画面から消えている**(口が 2 つに割れて
 *   `拾って、戻せる形で書き出す` / `拾って、読める形で書き出す` になった)。
 * 🔴 つまり **DB が本当に壊れた人にだけ出る 1 行が、そのまま行き止まり**だった
 *   ── #996 で踏んだのと同じ型を、いちばん助けが要る場面でやっていた。
 * 🔑 だから**手で書かず `rescue-labels.ts` から引く**。改名した日に、ここも一緒に動く。
 * ⚠ 門は `tests/features/db-rescue.test.ts` ── **画面の一覧と突き合わせる**
 *   (期待値を手で書くと、両方そのままで緑になる)。
 *
 * 🔴 **2026-09-21(#1017 段④b)に、指し先を退役した専用ボタンから
 *   いつもの `BACKUP_LABEL` へ替えた**(その 2 つは無くなった ── 保存領域に
 *   問題があるときは、いつもの**バックアップ**が自動で読める分だけ集める)。
 *
 * ## ⚠ 先に案内するのは「作り直す」である(#1006)
 *
 * 🔑 壊れている人がいちばんやりたいのは**元に戻すこと**で、それは
 *   `中身を残して、作り直す` の 1 押しで通る。拾い出しは**その前の保険**として言う。
 */
export function integritySummary(r: IntegrityReport): string {
  if (r.ok) return '読めない所は見つかりませんでした。';
  const t = r.brokenTables.length;
  const i = r.brokenIndexes.length;
  if (t === 0 && i > 0) {
    return (
      `読めなかったのは目次だけです(${i} 件)。中身そのものは無事な可能性が高いので、` +
      `左下の「${BACKUP_LABEL}」で全部取り出せることがあります。` +
      `そのまま直すなら「${CONTAINER_REBUILD_LABEL}」を押してください。`
    );
  }
  if (t > 0) {
    return (
      `本文をしまっている所が読めません(${t} 件)。取り出せるのは一部だけになります ── ` +
      `左下の「${BACKUP_LABEL}」を押すと、読める分を集めて書き出します。` +
      `そのあと「${CONTAINER_REBUILD_LABEL}」で、読めた分だけで作り直せます。`
    );
  }
  return (
    '読めない所が見つかりましたが、どこかまでは分かりませんでした。' +
    `左下の「${BACKUP_LABEL}」で読める分を書き出してから、` +
    `「${CONTAINER_REBUILD_LABEL}」を押してください。`
  );
}

/** 拾い終わったときの言い方。⚠ **拾えなかった区画を必ず出す**(上の実測)。 */
export function rescueSummary(input: {
  readonly rows: number;
  readonly skipped: number;
  readonly empty: number;
}): string {
  const { rows, skipped } = input;
  if (rows === 0) {
    return '1 件も取り出せませんでした。読める所が無いので、この道では戻せません。';
  }
  if (skipped === 0) {
    return `${rows} 件を取り出しました。読み飛ばした所はありません。`;
  }
  return (
    `${rows} 件を取り出しました。⚠ 読めなかった所が ${skipped} か所あるので、` +
    'これで全部とは限りません。'
  );
}
