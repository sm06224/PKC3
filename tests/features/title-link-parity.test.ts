/** @vitest-environment node */
/**
 * 🔴 **描画が `[[ ]]` をリンクにする文書だけを、改名が書き換える**(#1174 段②。⚠1)。
 *
 * 描画(`markdown-render.ts` の inline 規則)と改名(`link-text-rename.ts` → `title-link.ts` の `scanTitleLinks`)は
 * 別の道で `[[ ]]` を読む。食い違うと「画面ではリンクでないのに書き換えた」(本文を壊す)になる。
 * 生成した多数の文書で、**改名が書き換える数 ⊆ 描画がリンクにする数**を題名ごとに突き合わせる。
 * ⚠ 期待値は描画の出力(`data-pkc-title`)から取る ── 改名側の実装で期待値を作らない。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { renameTitleLinks } from '../../src/features/entry-ref/link-text-rename';
import { scanTitleLinks } from '../../src/features/markdown/title-link';

const F = '```';
const FRAGMENTS = [
  '[[A]]',
  '前 [[A]] 後',
  '`[[A]]`',
  '``a [[A]] b``',
  `${F}\n[[A]]\n${F}`,
  '~~~\n[[A]]\n~~~',
  '    [[A]]',
  '[リンク [[A]]](https://example.com/x)',
  '[[A]](https://example.com/x)',
  '\\[[A]]',
  '[[A\\|B]]',
  '| h1 | h2 |\n|---|---|\n| [[A]] | x |',
  '| h1 | h2 |\n|---|---|\n| [[A|B]] | x |',
  'h1 | h2\n--- | ---\n[[A]] | [[A|表示]]',
  '$[[A]]$',
  '$$\n[[A]]\n$$',
  '$$[[A]]$$',
  '**[[A]]**',
  '*[[A]]*',
  '~~[[A]]~~',
  '> [[A]]',
  '- [[A]] 項目',
  '1. 番号 [[A]]',
  '- [ ] [[A]] を済ませる',
  '# 見出し [[A]]',
  '[[ruby:x|y]]',
  '[[em:x]]',
  '[[ruby:A]]',
  '[[A|表示]]',
  '[[ A ]]',
  '[[A]][[A]]',
  '![[A]]',
  '<!-- [[A]] -->',
  'http://example.com/[[A]]',
  '[[A',
  '[[A]',
  '[[]]',
  '[[A\nB]]',
  '[[B]]',
  '[[A]] と [[B]] と `[[A]]`',
  '前後の $金額 [[A]] 100$ 字',
  '\\\\[[A]]',
];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 描画がリンクにした題名を、数えて返す。 */
function renderedTitles(doc: string): Map<string, number> {
  const html = renderMarkdown(doc, { titleLinks: true });
  const out = new Map<string, number>();
  for (const m of html.matchAll(/data-pkc-title="([^"]*)"/g)) out.set(m[1]!, (out.get(m[1]!) ?? 0) + 1);
  return out;
}

describe('🔴 改名が書き換える [[ ]] は、描画がリンクにしている物の部分集合(生成した文書)', () => {
  it('2000 文書で、題名ごとに 改名の数 <= 描画の数', () => {
    const r = rng(20261026);
    let docs = 0;
    let linked = 0;
    const mismatches: string[] = [];
    for (let n = 0; n < 2000; n++) {
      const parts: string[] = [];
      const len = 1 + Math.floor(r() * 5);
      for (let i = 0; i < len; i++) parts.push(FRAGMENTS[Math.floor(r() * FRAGMENTS.length)]!);
      const doc = parts.join(r() < 0.5 ? '\n' : '\n\n');
      const drawn = renderedTitles(doc);
      const scanned = new Map<string, number>();
      for (const s of scanTitleLinks(doc)) scanned.set(s.title, (scanned.get(s.title) ?? 0) + 1);
      docs += 1;
      for (const [t, c] of scanned) {
        linked += c;
        if (c > (drawn.get(t) ?? 0)) mismatches.push(`${JSON.stringify(doc)} → 改名 ${c} / 描画 ${drawn.get(t) ?? 0} (${t})`);
      }
    }
    expect(mismatches.slice(0, 5), '改名が描画より多く書き換える文書がある').toEqual([]);
    expect(docs).toBe(2000);
    expect(linked, '改名側が 1 つも拾っていない(空振り)').toBeGreaterThan(1000);
  });

  it('対照群: 描画がリンクにする素の [[A]] は、改名も必ず書き換える(取りこぼしの下限)', () => {
    for (const doc of ['[[A]]', '前 [[A]] 後', '**[[A]]**', '> [[A]]', '- [[A]] 項目', '# 見出し [[A]]', '| a | b |\n|---|---|\n| [[A]] | x |']) {
      expect(renderedTitles(doc).get('A'), `描画 ${doc}`).toBe(1);
      const r = renameTitleLinks(doc, 'A', 'Z');
      expect(r.count, `改名 ${doc}`).toBe(1);
      expect(r.body).toContain('[[Z]]');
    }
  });

  it('リンクでない所は書き換えない(コード・数式・リンクの字・エスケープ・セルをまたぐ物)', () => {
    for (const doc of [
      '`[[A]]`',
      `${F}\n[[A]]\n${F}`,
      '$[[A]]$',
      '[リンク [[A]]](https://example.com/x)',
      '\\[[A]]',
      '| h1 | h2 |\n|---|---|\n| [[A|B]] | x |',
      '[[ruby:A|b]]',
    ]) {
      expect(renderedTitles(doc).get('A') ?? 0, `描画 ${doc}`).toBe(0);
      expect(renameTitleLinks(doc, 'A', 'Z').count, `改名 ${doc}`).toBe(0);
    }
  });
});
