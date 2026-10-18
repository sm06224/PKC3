/**
 * 全文検索の問い合わせを、SQL へ渡せる形へ組み立てる(#181 / 台帳 #180 A-1)。
 *
 * 🔑 **pure module**。ここに置くのは「どう引くか」の**規則だけ** ── SQL の実行は
 * worker の仕事。こうしないと、規則が worker の中に埋もれて誰も test できない
 * (CLAUDE.md §2「どの test からも実行されない file に判断を書かない」)。
 *
 * ## 3 文字で切れる根拠(2026-08-15 の実測)
 *
 * 同梱 sqlite の FTS5 は trigram tokenizer を持つが、**3 文字未満は当たらない**:
 * `全文検索` を入れて `全文`(2 字)で MATCH すると **0 件**、`本語の`(3 字)なら
 * HIT。⚠ 日本語は既定 / unicode61 では 1 語に潰れて**そもそも引けない**ので、
 * trigram 以外の選択肢が無い。
 * ⇒ **3 文字以上は FTS、2 文字以下は LIKE**(LIKE は対照群で 2 字も引けると確認済み)。
 */
import { FTS_MIN_CHARS } from '@adapter/platform/storage/schema';
import { foldWidth, splitWords } from './fold-text';

export type SearchPlan =
  | { kind: 'none' }
  | { kind: 'fts'; match: string }
  | { kind: 'like'; pattern: string };

/** 文字数は**コードポイントで数える**(絵文字や結合文字で切り方を誤らない)。 */
export function queryLength(query: string): number {
  return [...query.trim()].length;
}

/**
 * FTS5 の MATCH 式へ。⚠ **丸ごと 1 つの句として引用する** ── user の入力には
 * `AND` / `*` / `(` のような FTS の演算子が普通に混ざるので、そのまま渡すと
 * 構文エラーか、意図しない検索になる。引用符は 2 つ重ねて escape する。
 */
export function toFtsMatch(query: string): string {
  return `"${query.trim().replace(/"/g, '""')}"`;
}

/**
 * LIKE のパターンへ。⚠ `%` `_` は**ワイルドカード**なので escape する
 * (`\` を ESCAPE 節で宣言する前提)。⚠ `\` 自身も escape の対象。
 */
export function toLikePattern(query: string): string {
  const escaped = query.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/**
 * 引き方を決める(左の列の欄)。⚠ **空は「絞り込み無し」**であって「0 件」ではない(呼び側が全件を出す)。
 *
 * 🔴 **空白(全角も)で区切った語は「全部を含む」**(台帳 #1852 の束 B2、依頼 194・260・115-1 ── 「探す」画面と同じ)。
 *   ただし `"…"` も `-語` も読まない(左の列の欄は打った字のまま。`-1` / `-メモ` を除外と読むと 0 件になる)。
 * 🔴 **字は揃えてから引く**(依頼 258・335・115-2 ── 全角と半角・半角カナ・濁点の持ち方。索引側も同じ揃え方)。
 * ⚠ 語が 1 つのときの返り値は従来のまま(`fts` / `like`)。2 語以上で 3 字未満が混じれば全語を LIKE で引く
 *   (`like-terms`。trigram は 2 字を当てられないので、FTS と混ぜない)。
 * ⚠ 口は下の `planSearch`(既定 `syntax: 'plain'` = この関数)── 呼び側の綴りは変えない。
 */
function planPlain(query: string): QuerySearchPlan {
  const words = splitWords(query);
  if (words.length === 0) return { kind: 'none' };
  if (words.length === 1) {
    const w = words[0]!;
    if (queryLength(w) >= FTS_MIN_CHARS) return { kind: 'fts', match: toFtsMatch(w) };
    return { kind: 'like', pattern: toLikePattern(w) };
  }
  if (words.every((w) => queryLength(w) >= FTS_MIN_CHARS))
    return { kind: 'fts', match: words.map(quoteFtsTerm).join(' AND ') };
  return { kind: 'like-terms', include: words, exclude: [] };
}

/**
 * 🔴 **探す面の書き方**(#680)── 空白で区切れば AND、`"…"` はフレーズ、`-語` は除外。
 * ⚠ **左の列の欄(`toFtsMatch`)には効かない** ── あちらは打った字を丸ごと 1 句として
 * 引く。一覧の意味論は外向きの変更なので、ここでは触らない(1 byte も変えない)。
 *
 * 🔑 **全項を引用する** ── user の字に混ざる `AND` / `*` / `(` / `:` を FTS5 の構文に
 *   届けない。構文として意味を持つのは、こちらが組む `AND` / `NOT` / `( )` だけ。
 * ⚠ 区切りは `\s`(全角空白 U+3000 を含む)── 日本語の入力は全角空白で区切られる。
 * ⚠ 閉じていない `"` は末尾までをフレーズと読む(打っている途中でも壊れない)。
 */
export interface SearchTerms {
  /** 当たるべき語(フレーズは空白込みの 1 項)。 */
  include: string[];
  /** 除く語(`-` 付き)。 */
  exclude: string[];
}

export function parseSearchTerms(query: string): SearchTerms {
  const include: string[] = [];
  const exclude: string[] = [];
  let buf = '';
  let neg = false;
  let quoted = false;
  let atStart = true;
  const flush = (): void => {
    if (buf !== '') (neg ? exclude : include).push(buf);
    buf = '';
    neg = false;
    atStart = true;
  };
  for (const ch of query) {
    if (ch === '"') {
      quoted = !quoted;
      atStart = false;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      flush();
      continue;
    }
    if (atStart && ch === '-') {
      neg = true;
      atStart = false;
      continue;
    }
    buf += ch;
    atStart = false;
  }
  flush();
  return { include, exclude };
}

/**
 * 引く側の語。⚠ 索引と同じ揃え方(`foldWidth`)を通す(台帳 #1852 の束 B2、依頼 258・335)。
 * `parseSearchTerms` は打った字のまま(画面に出す語・本文の塗りが読む)。
 */
export function foldedTerms(query: string): SearchTerms {
  const { include, exclude } = parseSearchTerms(query);
  return { include: include.map(foldWidth), exclude: exclude.map(foldWidth) };
}

/**
 * 引く側の語(揃えた後)。⚠ `planSearch` が決める引き方と**同じ語**を返す ── 索引が使えない間の全走査(LIKE)が、
 * 索引と同じ集合を返すため(`storage-worker.ts` の `searchPlanOf`)。
 */
export function plannedTerms(query: string, syntax: 'plain' | 'query'): SearchTerms {
  return syntax === 'plain' ? { include: splitWords(query), exclude: [] } : foldedTerms(query);
}

/** 1 項を FTS5 の句にする(引用符は 2 つ重ねて escape ── `toFtsMatch` と同じ規則)。 */
export function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * 探す面の問い合わせを FTS5 の MATCH 式へ。
 * - `a b` → `"a" AND "b"` / `"a b" -c` → `("a b") NOT "c"`
 * - 正の項が 0(`-c` だけ / 空)なら `null` ── 「全部から c を除く」は引かない
 *   (全件が返る形になり、user の意図と違う)。
 */
export function toFtsQuery(query: string): string | null {
  const { include, exclude } = foldedTerms(query);
  if (include.length === 0) return null;
  const positive = include.map(quoteFtsTerm).join(' AND ');
  if (exclude.length === 0) return positive;
  return `(${positive})${exclude.map((t) => ` NOT ${quoteFtsTerm(t)}`).join('')}`;
}

/**
 * 探す面の引き方。`SearchPlan` に**語の並び**(`like-terms`)が 1 つ増える ──
 * 3 字未満の項が 1 つでもあれば trigram では当たらない(除外側なら**黙って効かない**)ので、
 * 全項を LIKE で引く(呼び側が項ごとに LIKE を並べる)。⚠ 空・正の項が 0 は `none`。
 */
export type QuerySearchPlan =
  | SearchPlan
  | {
      kind: 'like-terms';
      include: string[];
      exclude: string[];
    };

/**
 * 引き方を決める。⚠ 既定(`plain`)は**左の列の欄**の規則そのまま(`planPlain`)──
 * 呼び側 2 か所(`searchEntries` / `listEntryMetas`)は綴りも型も変わらない。
 * `syntax: 'query'` は**探す面だけ**(`searchDetail`)。
 */
export function planSearch(query: string): QuerySearchPlan;
export function planSearch(query: string, opts: { syntax: 'plain' }): QuerySearchPlan;
export function planSearch(query: string, opts: { syntax: 'query' }): QuerySearchPlan;
export function planSearch(
  query: string,
  opts: { syntax: 'plain' | 'query' } = { syntax: 'plain' },
): QuerySearchPlan {
  if (opts.syntax === 'plain') return planPlain(query);
  const terms = foldedTerms(query);
  if (terms.include.length === 0) return { kind: 'none' };
  const all = [...terms.include, ...terms.exclude];
  if (all.every((t) => queryLength(t) >= FTS_MIN_CHARS)) {
    // ⚠ `toFtsQuery` は同じ `parseSearchTerms` を通るので、ここで null にはならない
    return { kind: 'fts', match: toFtsQuery(query) ?? '' };
  }
  return { kind: 'like-terms', include: terms.include, exclude: terms.exclude };
}

/**
 * 探す面の結果が**関連の高い順**に並ぶか(#1087)。
 *
 * 🔑 並びを決めるのは worker の `searchDetail` で、**引き方(`planSearch`)が `fts` のときだけ**
 * 関連度(bm25)で並べる。3 字未満の語が**除く語を含めて 1 つでも**混じれば全項を LIKE で引き、
 * 関連度を持たない(ノートの並び順)。⚠ 描画器の見出しは**この 1 本**から言う ──
 * 規則を描画器に書き写すと、worker の規則が変わったとき見出しが嘘になる。
 */
export function isRelevanceOrdered(query: string): boolean {
  return planSearch(query, { syntax: 'query' }).kind === 'fts';
}
