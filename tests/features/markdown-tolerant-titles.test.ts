/** @vitest-environment happy-dom */
/**
 * 寛容に受け入れた書き方の hover(`title=`)は、英語の開発用語を含まず、
 * 「直すと確実に表示されます」の形で正しい書き方を言う(#1163 依頼 72-3)。
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '@features/markdown/markdown-render';

const FIX = '直すと確実に表示されます';
const JARGON = /parse|canonical|\bcap\b|capped|spec|hint|lead paragraph|attribution|spacing|寛容|正規化/i;

function titlesOf(src: string): string[] {
  const html = renderMarkdown(src, { silentHallucinationWarnings: true });
  return [...html.matchAll(/ title="([^"]*)"/g)].map((m) => m[1]!);
}

describe('寛容に受け入れた書き方の hover', () => {
  const cases: Array<[string, string, string]> = [
    ['lead', '本文 :lead:[導入] の続き\n', '強調した普通の段落'],
    ['spacing', '本文 :spacing:{size=3} の続き\n', '行頭の `_2`'],
    ['align', '本文 :align:{position=center} の続き\n', '`||`(中央寄せ)'],
    ['quote', '本文 :quote:{author="山田"} の続き\n', 'のブロック'],
  ];
  for (const [name, src, form] of cases) {
    it(`${name}: 直し先を日本語で言い、英語の開発用語を含まない`, () => {
      const titles = titlesOf(src);
      // 空振り防止 ── 寛容 parse の経路を通って title が出ていること
      expect(titles.length, `${name} の title が出ていない(台の空振り)`).toBeGreaterThanOrEqual(1);
      for (const t of titles) {
        expect(t).toContain(FIX);
        expect(t).toContain(form);
        expect(t, `英語の開発用語が残っている: ${t}`).not.toMatch(JARGON);
      }
    });
  }

  it('空ける行数の上限: 実際に表示した行数を平易に言う', () => {
    const titles = titlesOf('前\n\n_100\n\n後\n');
    expect(titles).toContain('空ける行は 50 行までです(_100 は 50 行として表示しています)');
    for (const t of titles) expect(t).not.toMatch(JARGON);
  });
});
