/**
 * 🔴 **ノートを本文へ書く形**の組み立て ── これ 1 つだけが正本(#427 段①)。
 *
 * ## 生まれた理由
 *
 * マニュアルは `[題名](entry:<lid>)` と書いてリンクの張り方を案内しているのに、
 * 🔴 **`<lid>` を知る手段が画面に 1 つも無かった** ── 情報ペインは
 * 題名 / 種類 / 居場所 / 作成 / 更新 / 元ファイル の 6 行だけで id を出さず、
 * `copy-` の action 7 つのうち**ノート自身の参照を出すものが 1 つも無かった**。
 * ⚠ つまり **PKC3 の中で新しくリンクを張る道が無く**、本文に在る `entry:` は
 * ほぼ全部 PKC2 からの取り込みだった。
 *
 * ## 規則
 *
 * 🔑 **リンクの組み立ては `markdown/link-format.ts` 1 本**(添付と同じ)──
 *   別に書けば必ずずれる(`]` の escape を片方だけ忘れる、が実際に起きた形)。
 * ⚠ **題名は本文へ焼き込まれる** ── 後で改名しても本文の字は変わらない。
 *   これは記法どおりで正しいが、user から見ると「古い題名のまま残る」ので
 *   マニュアルに書いてある。
 *
 * ⚠ **pure module**。browser API を持たない。
 */
import { formatMarkdownLink } from '../markdown/link-format';
import { SCHEME } from './entry-ref';

/**
 * そのノートを指す、本文へそのまま貼れる 1 行。
 *
 * @param title ノートの題名。⚠ 空なら宛先(`entry:<lid>`)が見出しになる
 *   ── **空のラベルを作らない**(`[](entry:x)` は押す所が無い)
 */
export function formatEntryLink(title: string, lid: string): string {
  return formatMarkdownLink(title, `${SCHEME}${lid}`);
}
