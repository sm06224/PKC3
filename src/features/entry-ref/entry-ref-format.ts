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
import { SCHEME, formatEntryRef } from './entry-ref';

/**
 * そのノートを指す、本文へそのまま貼れる 1 行。
 *
 * @param title ノートの題名。⚠ 空なら宛先(`entry:<lid>`)が見出しになる
 *   ── **空のラベルを作らない**(`[](entry:x)` は押す所が無い)
 */
export function formatEntryLink(title: string, lid: string): string {
  return formatMarkdownLink(title, `${SCHEME}${lid}`);
}

/**
 * 🔴 **その章を指す、本文へそのまま貼れる 1 行**(#579)── `[ラベル](entry:<lid>#h/<見出しの id>)`。
 *
 * ⚠ `id` は描画が刻んだ見出しの id(`h.id`)を**そのまま**受ける ── ここで slug を計算し直さない
 *   (同名見出しの連番 `-1` が食い違う)。綴りは `formatEntryRef` 1 本(読む側と同じ file)。
 * ⚠ 見出しの字を変えると id も変わるので、貼った先は**消える**(マニュアルに書いてある)。
 */
export function formatSectionLink(label: string, lid: string, id: string): string {
  return formatMarkdownLink(label, formatEntryRef({ kind: 'section', lid, id }));
}
