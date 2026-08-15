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
 * 引き方を決める。⚠ **空は「絞り込み無し」**であって「0 件」ではない
 * (呼び側が全件を出す)。
 */
export function planSearch(query: string): SearchPlan {
  const trimmed = query.trim();
  if (trimmed === '') return { kind: 'none' };
  if (queryLength(trimmed) >= FTS_MIN_CHARS)
    return { kind: 'fts', match: toFtsMatch(trimmed) };
  return { kind: 'like', pattern: toLikePattern(trimmed) };
}
