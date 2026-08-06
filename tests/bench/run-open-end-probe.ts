/**
 * 🔴 **開放終端(閉じ記号が無い状態)が今どう描かれるかを見る**
 * (2026-08-05。user 提案「開放終端を検知したら生のままにして行を色変え」の根拠。設計 §5.6 ③)。
 *
 * 実測で分かること ── **行内とブロックで壊れ方がまったく違う**:
 * - 行内(`**` / `` ` `` / `[` / `==`)は**原文どおりに見える**ので害は小さい。
 *   足りないのは「待っていることが見えない」こと(色を変える価値はここ)
 * - 🔴 ブロック(```` ``` ```` / `:::`)は **EOF で自分を閉じる**ので、開始記号を
 *   打った瞬間に**まだ書いていない下の文書が丸ごと巻き込まれる**。user 提案が
 *   決定的に効くのはここで、auto pair の最優先対象でもある
 *
 * 使い方: `npx vite-node tests/bench/run-open-end-probe.ts`
 */
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const CASES: readonly (readonly [string, string])[] = [
  ['行内: 太字を打ちかけ', 'これは**太字'],
  ['行内: コードを打ちかけ', 'これは`コード'],
  ['行内: リンクを打ちかけ', 'これは[リンク'],
  ['行内: リンクの url 途中', 'これは[リンク]('],
  ['行内: 強調印を打ちかけ', 'これは==印'],
  ['🔴 ブロック: fence を打ちかけ', '```js\nconst a = 1;'],
  ['🔴 ブロック: ディレクティブを打ちかけ', ':::note\n中身'],
  ['表: 区切り行がまだ無い', '| a | b |'],
];

const strip = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();

const cell = (t: string): string => t.replace(/\n/g, '⏎').replace(/\|/g, '\\|');

console.log('| 場面 | 打ちかけの原文 | 描画結果(タグを剥がした見え方) | 出る要素 |');
console.log('|---|---|---|---|');
for (const [name, src] of CASES) {
  const html = renderMarkdown(src, {});
  const tags = [...new Set([...html.matchAll(/<(\w+)/g)].map((m) => m[1]))].join(' ');
  console.log(`| ${name} | \`${cell(src)}\` | \`${cell(strip(html)).slice(0, 32)}\` | ${tags} |`);
}
