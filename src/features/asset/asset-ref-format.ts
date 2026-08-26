/**
 * 添付を**本文へ書く形**の組み立て ── これ 1 つだけが正本。
 *
 * 🔴 生まれた理由(P8 段⑱ review H):「参照をコピー」が渡していたのは裸の
 * `asset:<key>` で、**貼っても何も出なかった**(markdown としては ただの文字列)。
 * マニュアルは「貼ってください」と書いていたので、**書ける形なのに書けない**
 * という状態だった。同じ判定は書出し(`export/pkc3-markdown-zip.ts`)にも在り、
 * 別々に書けば必ずずれる ── 規則は 1 本に寄せる(CLAUDE.md「判定を増やさない」)。
 *
 * ## 規則
 * - **画像なら `!` を付ける**(`![名前](宛先)`)。画像以外はリンク(= ダウンロード導線)
 * - ラベルは `[` `]` `\` を escape し、改行は 1 行に潰す(`]` 1 個でリンクが死ぬ)
 * - 宛先に空白 / 括弧 / `<` `>` が混じるなら `<…>` で囲む(裸だとリンクが切れる)
 */
import {
  escapeLinkLabel,
  escapeLinkTarget,
  formatMarkdownLink,
} from '../markdown/link-format';

/**
 * 🔑 **規則の実体は `features/markdown/link-format.ts` へ移した**(#427 段①)──
 *   添付固有ではないからである(`html-to-markdown.ts` が `<a>` / `<img>` の変換で
 *   そのまま使っていた)。⚠ ここは**旧名の再輸出だけ** ── 規則を 2 本にしない(§7)。
 */
export { escapeLinkLabel as escapeAssetLabel, escapeLinkTarget as escapeAssetTarget };

/** `mime` が画像か(`!` を付けるか)の判定。**この 1 本だけを使う**。 */
export function isImageAssetMime(mime: string | undefined | null): boolean {
  return (mime ?? '').startsWith('image/');
}

/**
 * 本文へそのまま貼れる 1 行を組み立てる。
 *
 * @param label 見出し文字列(既定はファイル名)。空なら宛先を使う
 * @param target リンク宛先(`asset:<key>` か、書出し後の相対パス)
 * @param image 画像として置くか(`isImageAssetMime` の結果を渡す)
 */
export function formatAssetRef(label: string, target: string, image: boolean): string {
  return formatMarkdownLink(label, target, image);
}
