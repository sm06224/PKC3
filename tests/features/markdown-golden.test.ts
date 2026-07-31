import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  renderMarkdown,
  renderMarkdownInline,
  hasMarkdownSyntax,
} from '../../src/features/markdown/markdown-render';
import { parseFrontmatter, extractVars } from '../../src/features/markdown/frontmatter';

/**
 * PKC-Markdown 移植の parity pin(P3-3)。
 * golden は **PKC2 の renderMarkdown(markdown-it 14.3.0)から採取**した実出力
 * (manual ch12 全文 1,431 行 + fixture 3 種 + 方言の縁スニペット 20 種)。
 * 採取手順: scratchpad/harvest-goldens.ts を cwd=PKC2 で tsx 実行。
 * ⚠ markdown-it のバージョンを動かすと golden ごと再検証が必要(14.3.0 に固定中)。
 */
interface GoldenCase {
  name: string;
  input: string;
  options: {
    vars?: Record<string, string>;
    sourceLineAnchors?: boolean;
  };
  html: string;
  hasSyntax: boolean;
}

/**
 * render ごとに変わる設計の一意 ID(checkbox/label 対・sandbox iframe)だけを
 * 安定トークンへ正規化する。**それ以外は byte 一致を要求**。
 */
function normalizeUniqueIds(html: string): string {
  return html
    .replace(/pkc-rv-[a-z0-9]+/g, 'pkc-rv-X')
    .replace(/pkc-html-render-[a-z0-9]+/g, 'pkc-html-render-X');
}

const goldens = JSON.parse(
  readFileSync(
    join(__dirname, '../fixtures/markdown-goldens/goldens.json'),
    'utf8',
  ),
) as {
  cases: GoldenCase[];
  inlineGolden: { input: string; html: string };
};

beforeAll(() => {
  // 寛容 parse(PKC2005〜2011)の console 通知は仕様どおりの出力 ──
  // stderr 0 行規律のため test 中は黙らせる(挙動には影響しない)
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('PKC-Markdown golden parity vs PKC2 (25 cases)', () => {
  for (const c of goldens.cases) {
    it(`renders "${c.name}" byte-identically`, () => {
      const fm = parseFrontmatter(c.input);
      // 正準系列(PKC2 detail-presenter.ts:96 と同形): vars は raw 全文から抽出
      const vars = c.options.vars ?? extractVars(c.input);
      const html = renderMarkdown(fm.body, {
        vars,
        sourceLineAnchors: c.options.sourceLineAnchors,
      });
      expect(normalizeUniqueIds(html)).toBe(normalizeUniqueIds(c.html));
      expect(hasMarkdownSyntax(fm.body)).toBe(c.hasSyntax);
    });
  }

  it('renderMarkdownInline parity', () => {
    expect(renderMarkdownInline(goldens.inlineGolden.input)).toBe(
      goldens.inlineGolden.html,
    );
  });
});
