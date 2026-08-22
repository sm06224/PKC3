/**
 * PKC2 の renderMarkdown から golden HTML(goldens.json)を採取するスクリプト。
 *
 * 実行手順(PKC2 リポジトリが /home/user/PKC2 に checkout 済みの開発環境でのみ):
 *   1. cd /home/user/PKC2 && npm ci   (PKC2 側の依存: markdown-it 14.3.0 が必要)
 *   2. cd /home/user/PKC2 && npx tsx /home/user/PKC3/tests/fixtures/markdown-goldens/harvest-from-pkc2.ts
 *      (cwd を PKC2 にするのは fixture の相対パスと tsconfig paths 解決のため)
 *   3. PKC3 で `npx vitest run tests/features/markdown-golden.test.ts` を再実行し一致を確認
 *
 * ⚠ このファイルは PKC3 の typecheck から除外している(tsconfig.json の exclude)──
 *   import 先が PKC2 リポジトリで、CI には存在しないため。読み取り専用の採取であり
 *   PKC2 側には一切書き込まない。
 * 🔴 **2026-08-22(#78)以降、両者の markdown-it は同じ版ではない** ──
 *   PKC2 は **14.3.0**(凍結、read-only)、PKC3 は **15.0.0**。
 *   ⚠ したがって**このスクリプトで採り直すと、上流が直したものが戻る**
 *   (`console.info` を `http://console.info` へ自動リンクする v14 の挙動など)。
 *   🔑 採り直すのは「PKC2 の本文をもう 1 件 golden に足す」ときだけにし、
 *   足した case が落ちたら **まず上流の版差**を疑う ── 差の全数は
 *   `tests/features/markdown-linkify.test.ts` に実測して pin してある。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  renderMarkdown,
  renderMarkdownInline,
  hasMarkdownSyntax,
} from '/home/user/PKC2/src/features/markdown/markdown-render';
import {
  parseFrontmatter,
  extractVars,
} from '/home/user/PKC2/src/features/markdown/frontmatter';

const OUT = '/home/user/PKC3/tests/fixtures/markdown-goldens';
mkdirSync(OUT, { recursive: true });

interface GoldenCase {
  name: string;
  input: string;
  options: { vars?: Record<string, string>; sourceLineAnchors?: boolean };
  html: string;
  hasSyntax: boolean;
}

function harvestDoc(name: string, path: string, anchors: boolean): GoldenCase {
  const raw = readFileSync(path, 'utf8');
  // 正準系列(PKC2 detail-presenter.ts:90-119 と同形):
  // frontmatter strip → vars は raw 全文から抽出 → render
  const fm = parseFrontmatter(raw);
  const vars = extractVars(raw);
  const options = { vars, sourceLineAnchors: anchors };
  const html = renderMarkdown(fm.body, options);
  return { name, input: raw, options, html, hasSyntax: hasMarkdownSyntax(fm.body) };
}

const cases: GoldenCase[] = [
  harvestDoc('full-pkc-fixture', 'tests/features/ast/fixtures/full-pkc-fixture.md', false),
  harvestDoc('full-pkc-fixture-anchors', 'tests/features/ast/fixtures/full-pkc-fixture.md', true),
  harvestDoc('reform-stress-sample', 'tests/features/ast/fixtures/reform-stress-sample.md', false),
  harvestDoc('simple-notation-sample', 'tests/features/ast/fixtures/simple-notation-sample.md', false),
  harvestDoc('manual-ch12', 'docs/manual/12_マークダウン拡張記法.md', false),
];

// 方言の縁を突く追加スニペット(移植調査の罠リスト由来)
const snippets: Array<[string, string]> = [
  ['asym-emphasis', '^^圏点^^ と *X** の非対称と **強調*\n'],
  ['escaped-vars', '\\{{vars.x}} はそのまま、{{vars.y}} は未定義警告\n'],
  ['nested-inline', '==[red]中に **強調** と `code`== と :strong:[太字]{.x}\n'],
  ['simple-inline-l6', ':重要:bold,red,bg-yellow,1.2em: と ||中央寄せ\n'],
  ['task-and-footnote', '- [ ] 未了\n- [x] 済み[^a]\n\n[^a]: 脚注本文\n'],
  ['csv-fence', '```csv-render\n列A,列B\n1,2\n```\n'],
  ['html-fence', '```html\n<b>sandbox</b>\n```\n'],
  ['mermaid-fence', '```mermaid\ngraph TD; A-->B;\n```\n'],
  ['break-and-blank', '前\n\n+++\n\n_3\n\n後\n'],
  ['section-callout', ':::note\n注意書き\n:::\n\n:::section{role=warning}\n警告\n:::\n'],
  ['figure-ref', ':::figure{#fig1}\n![alt](https://example.com/x.png)\n^^^キャプション\n:::\n\n本文 [@fig1] 参照\n'],
  ['quote-author', ':::quote{author=山田}\n引用文\n:::\n'],
  ['details-region', ':::details{summary=開く}\n中身\n:::\n'],
  ['ruby-em', '[[ruby:漢字|かんじ]] と [[em:強調点]]\n'],
  ['links-schemes', '[e](entry:abc) [p](pkc://x/y) [w](https://example.com) <br> 改行\n'],
  ['card-placeholder', '@[card](entry:abc123)\n'],
  ['align-indent', '||中央\n>|右\n__字下げ段落\n'],
  ['heading-slug', '# 見出し一\n## 見出し一\n### English Heading!\n'],
  ['tolerant-alias', ':lead: リード文です\n\n:::callout\n吸収される\n:::\n'],
  ['comments', '表 %%インラインコメント%% 示\n\n%%%\nブロックコメント\n%%%\n'],
];
for (const [name, input] of snippets) {
  cases.push({
    name: `snippet-${name}`,
    input,
    options: {},
    html: renderMarkdown(input, {}),
    hasSyntax: hasMarkdownSyntax(input),
  });
}

const inlineGolden = {
  name: 'inline-api',
  input: '==強調== と **bold** と [l](https://example.com)',
  html: renderMarkdownInline('==強調== と **bold** と [l](https://example.com)'),
};

writeFileSync(`${OUT}/goldens.json`, JSON.stringify({ cases, inlineGolden }, null, 1));
console.log(`harvested ${cases.length} cases → ${OUT}/goldens.json`);
console.log('total golden bytes:', JSON.stringify({ cases, inlineGolden }).length);
