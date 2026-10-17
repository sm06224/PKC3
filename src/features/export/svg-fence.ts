/**
 * 🔴 **本文の ` ```svg ` の囲みの中身を、Word・PowerPoint に絵として入れられる SVG の字にする**
 * (#1163 依頼 235。Gemini の裁定:`svg` の囲みは絵にして書き出す。`html` の囲みは今までどおり 1 行の案内)。
 *
 * > 画面の物語:本文に ` ```svg ` で描いた図を Word に書き出すと、図は丸ごと「埋め込み枠 / 書き出したファイルでは動きません」の
 * > 1 行になって消えていた。いまは図として入る。
 *
 * ## 入れてよい物・入れない物
 *
 * - **根が `<svg>` のものだけ**(前に `<?xml?>` や注釈が在ってよい)。` ```svg ` の囲みは HTML と同じ箱で描くので、
 *   `<svg>` のほかに文や `<script>` を書ける ── そういう物は絵にできないので、今までどおり案内の 1 行に残す
 *   (黙って一部だけ入れない)。
 * - 根に `xmlns` が無ければ足す。ブラウザの箱の中では要らないが、画像として読み込む(PNG にする)ときは要る。
 *
 * ⚠ ここでは**描かない・解釈しない**(字を整えるだけ)。EMF にする・PNG にするのは呼び側。pure。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 前置き(`<?xml … ?>` と注釈)を飛ばして、根の `<svg` が来るか。 */
const ROOT_SVG_RE = /^(?:\s*<\?xml[\s\S]*?\?>)?(?:\s*<!--[\s\S]*?-->)*\s*<svg(?=[\s>/])/i;

/**
 * 囲みの原文から、絵にできる SVG の字を取り出す。@returns 絵にできないなら `null`。
 */
export function svgFenceSource(text: string): string | null {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!ROOT_SVG_RE.test(t)) return null;
  const root = /<svg\b[^>]*>/i.exec(t);
  if (root === null) return null;
  // 根を閉じる `</svg>` が無い物は、途中で切れている ── 絵にしない
  if (!/<\/svg\s*>\s*$/i.test(t.trimEnd()) && !/\/>\s*$/.test(root[0] ?? '')) return null;
  if (/\sxmlns\s*=/.test(root[0])) return t.trim();
  const fixed = root[0].replace(/^<svg\b/i, `<svg xmlns="${SVG_NS}"`);
  return (t.slice(0, root.index) + fixed + t.slice(root.index + root[0].length)).trim();
}
