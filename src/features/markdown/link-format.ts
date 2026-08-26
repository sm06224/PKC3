/**
 * 🔴 **markdown のリンクを安全に組み立てる、唯一の規則**(#427 段①で 1 本に寄せた)。
 *
 * ## なぜここに在るか
 *
 * 元は `features/asset/asset-ref-format.ts` に **`escapeAssetLabel` /
 * `escapeAssetTarget`** という名前で在った。⚠ しかし規則は**添付固有ではない** ──
 * 実際 `html-to-markdown.ts` が `<a>` と `<img>` の変換で**そのまま使っていた**。
 *
 * 🔑 **計器の名前を、計器の見ている範囲に合わせる**(CLAUDE.md の反復する型)──
 *   `Asset` と付いていると、次にリンクを組み立てる人が
 *   「添付用だから自分は別に書こう」と読む。⚠ 別に書けば**必ずずれる**
 *   (`]` の escape を片方だけ忘れる、が実際に起きた形である)。
 *
 * ## 規則(移す前と 1 バイトも変えていない)
 *
 * - ラベルは `[` `]` `\` を escape し、改行は 1 行に潰す(`]` 1 個でリンクが死ぬ)
 * - 宛先に空白 / 括弧 / `<` `>` が混じるなら `<…>` で囲む(裸だとリンクが切れる)
 *
 * ⚠ **pure module**。browser API を持たない。
 */

/** markdown のリンクラベルに入れて安全な形にする。 */
export function escapeLinkLabel(s: string): string {
  // ⚠ 改行が入ると markdown-it が段落を割ってリンクが死ぬ ── 1 行に潰す
  return s.replace(/\s*\n\s*/g, ' ').replace(/[[\]\\]/g, '\\$&');
}

/**
 * リンク宛先として安全な形にする。裸で書けない字が混じるときだけ `<…>` で囲む。
 * ⚠ 宛先は**不透明な文字列**でありうる(`asset:` の key、PKC2 由来の `entry:` の id、
 *   外部の URL)ので、「うちのものなら安全」を前提にしない。
 */
export function escapeLinkTarget(target: string): string {
  if (/^[^\s()<>]+$/.test(target)) return target;
  return `<${target.replace(/[<>\\]/g, '\\$&').replace(/\s*\n\s*/g, ' ')}>`;
}

/**
 * 本文へそのまま貼れる 1 行を組み立てる。
 *
 * @param label 見出し文字列。空なら宛先を使う(**空のラベルを作らない** ──
 *   `[](x)` は画面に何も出ず、押す所が無いリンクになる)
 * @param target リンク宛先(`asset:<key>` / `entry:<lid>` / 相対パス / URL)
 * @param image 画像として置くか(`!` を付ける)
 */
export function formatMarkdownLink(label: string, target: string, image = false): string {
  const text = label.trim() === '' ? target : label;
  return `${image ? '!' : ''}[${escapeLinkLabel(text)}](${escapeLinkTarget(target)})`;
}
