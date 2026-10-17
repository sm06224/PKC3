/** @vitest-environment happy-dom */
/**
 * 見出しの `{{vars.x}}` と、画像形の埋め込みの綴り(#1087 N2 / N8 / N9 / N10 / N13)。
 *
 * 守る主張:
 * 1. 🔴 見出しの id は、描画・右の列の目次・章の追記先(埋め込み)で**同じ**になる
 *    (定義済み / 未定義 / `\{{vars.x}}` の escape / `{{ vars.x }}` の空白入り)
 * 2. 🔴 `\{{ vars.a }}`(空白入り)の escape も字のまま残る
 * 3. 🔴 `vars:` の中のコメント行で後ろの変数が消えない / 引用の値の後ろの ` # …` は値に入らない
 * 4. 🔴 `![x](Entry:n#h/見出し)` と `![x](pkc://<この入れ物>/entry/n#…)` は埋め込みの器になる
 *    (別の入れ物の `pkc://` は今までどおり埋め込みにしない)
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { extractVars, bodyBelowFrontmatter } from '../../src/features/markdown/frontmatter';
import { extractHeadingsFromMarkdown } from '../../src/features/markdown/markdown-toc';
import { listAppendTargets } from '../../src/features/markdown/append-target';

const FM = '---\nvars:\n  proj: ALPHA-7\n---\n';

function renderedIds(src: string): string[] {
  const html = renderMarkdown(bodyBelowFrontmatter(src), { vars: extractVars(src) });
  const d = document.createElement('div');
  d.innerHTML = html;
  return [...d.querySelectorAll('h1[id],h2[id],h3[id]')].map((e) => e.id);
}

const HEADINGS: [string, string][] = [
  ['定義済み', '## {{vars.proj}} 計画'],
  ['未定義', '## {{vars.nope}} x'],
  ['escape', '## \\{{vars.proj}} x'],
  ['空白入り', '## {{ vars.proj }} 計画'],
  ['空白入り escape', '## \\{{ vars.proj }} x'],
  ['定義済み 2 つ', '## {{vars.proj}} / {{vars.proj}}'],
];

describe('見出しの id は 3 つの読み手で一致する(N2 / N10)', () => {
  for (const [name, h] of HEADINGS) {
    it(`🔴 ${name}: 描画 = 追記先(埋め込み) = 目次`, () => {
      const src = `${FM}intro\n\n${h}\n\ntext\n\n${h}\n`;
      const render = renderedIds(src);
      expect(render).toHaveLength(2);
      expect(listAppendTargets(src).map((t) => t.slug)).toEqual(render);
      expect(extractHeadingsFromMarkdown(src).map((t) => t.slug)).toEqual(render);
    });
  }

  it('🔴 定義済みの変数は展開後の字で slug になる(生の `varsproj` ではない)', () => {
    const src = `${FM}## {{vars.proj}} 計画\n`;
    expect(listAppendTargets(src)[0]!.slug).toBe('alpha-7-計画');
  });

  it('目次の表示の字: 未定義は `{{vars.x}}` のまま、escape は字のまま(印の字を画面へ出さない)', () => {
    const src = `${FM}## {{vars.nope}} x\n\n## \\{{vars.proj}} y\n`;
    const texts = extractHeadingsFromMarkdown(src).map((t) => t.text);
    expect(texts).toEqual(['{{vars.nope}} x', '{{vars.proj}} y']);
    for (const t of texts) expect(t).not.toMatch(/[\u{E140}-\u{E143}]/u);
  });

  it('追記先の表示の字は原文のまま(slug だけが展開後)', () => {
    const src = `${FM}## {{vars.proj}} 計画\n`;
    expect(listAppendTargets(src)[0]!.text).toBe('{{vars.proj}} 計画');
  });

  it('setext の見出しも展開後の字で slug になる', () => {
    const src = `${FM}{{vars.proj}} 題\n=====\n`;
    expect(listAppendTargets(src).map((t) => t.slug)).toEqual(renderedIds(src));
    expect(listAppendTargets(src)[0]!.slug).toBe('alpha-7-題');
  });
});

describe('escape の空白(N8)', () => {
  it('🔴 `\\{{ vars.a }}` は空白ごと字のまま出る', () => {
    const src = '---\nvars:\n  a: X\n---\n\\{{ vars.a }} と \\{{vars.a}} と {{ vars.a }}\n';
    const html = renderMarkdown(bodyBelowFrontmatter(src), { vars: extractVars(src) });
    expect(html).toContain('{{ vars.a }} と {{vars.a}} と X');
  });
});

describe('vars: ブロックのコメント(N9)', () => {
  it('🔴 ブロック内のコメント行で後ろの変数が消えない', () => {
    const src = '---\nvars:\n  a: 1\n  # コメント\n  b: 2\n---\n';
    expect(extractVars(src)).toEqual({ a: '1', b: '2' });
  });

  it('🔴 引用の値の後ろの ` # …` は値に入らない(" も \' も)', () => {
    const src = '---\nvars:\n  a: "q" # c\n  b: \'r\' # c\n  c: "x # not comment"\n  d: plain # c\n---\n';
    expect(extractVars(src)).toEqual({ a: 'q', b: 'r', c: 'x # not comment', d: 'plain' });
  });

  it('従来の取り方は変わらない(中に引用符を含む値・エスケープ)', () => {
    const src = '---\nvars:\n  a: "a\\"b"\n  b: "a"b"\n---\n';
    expect(extractVars(src)).toEqual({ a: 'a"b', b: 'a"b' });
  });
});

describe('画像形の埋め込みの綴り(N13)', () => {
  const embed = (src: string, cid = 'c-mine'): string =>
    renderMarkdown(src, { currentContainerId: cid });
  const refOf = (html: string): string | null => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.querySelector('[data-pkc-embed-ref]')?.getAttribute('data-pkc-embed-ref') ?? null;
  };

  it('🔴 小文字の entry: は従来どおり', () => {
    expect(refOf(embed('![x](entry:src#h/plan)'))).toBe('entry:src#h/plan');
  });

  it('🔴 `Entry:` は大小を問わず埋め込みになり、器へは小文字の綴りで焼く', () => {
    const html = embed('![x](Entry:src#h/plan)');
    expect(refOf(html)).toBe('entry:src#h/plan');
    expect(html).not.toContain('<img');
  });

  it('🔴 この入れ物の pkc:// は entry: と同じ埋め込みになる', () => {
    const html = embed('![x](pkc://c-mine/entry/src#h/plan)');
    expect(refOf(html)).toBe('entry:src#h/plan');
    expect(html).not.toContain('<img');
  });

  it('別の入れ物の pkc:// / 入れ物の id が不明なときは埋め込みにしない', () => {
    expect(refOf(embed('![x](pkc://other/entry/src#h/plan)'))).toBeNull();
    expect(refOf(embed('![x](pkc://c-mine/entry/src#h/plan)', ''))).toBeNull();
    expect(refOf(embed('![x](pkc://c-mine/asset/key)'))).toBeNull();
  });
});
