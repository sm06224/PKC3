/** @vitest-environment node */
/**
 * 🔴 **書き出すとき、別のノートの章の参照をその章の中身で置き換える**(#1459 段②)。
 *
 * 期待値は字面で書く。frontmatter を持つ相手のノートで、章の範囲(次の同格以上の見出しの手前まで)・
 * 深さ ≤ 1・自分自身・見つからない、を対にして見る。
 */
import { describe, expect, it } from 'vitest';
import { flattenSectionEmbeds } from '../../src/features/export/section-flatten';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const OTHER = [
  '---',
  'vars.担当: 佐藤',
  '---',
  '# 議事録',
  '',
  '## 決定事項',
  '',
  '- 予算は承認 ({{vars.担当}})',
  '',
  '![入れ子](entry:c3#h/補足)',
  '',
  '### 小さい見出し',
  '',
  '中身',
  '',
  '## 次の章',
  '',
  '別の話',
].join('\n');

const bodyOf = async (lid: string): Promise<string | null> => (lid === 'other' ? OTHER : null);

describe('章の参照を展開する', () => {
  it('🔴 行ぜんぶが参照の行を、その章の原文で置き換える(章の範囲・入れ子の見出しを含む / 次の章は含めない)', async () => {
    const body = '# 報告書\n\n![決定事項](entry:other#h/決定事項)\n\n以上\n';
    const r = await flattenSectionEmbeds(body, 'self', bodyOf);
    expect(r.expanded).toBe(1);
    expect(r.missing).toBe(0);
    expect(r.body).toBe(
      [
        '# 報告書',
        '',
        '',
        '## 決定事項',
        '',
        '- 予算は承認 (佐藤)', // 元のノートの前書きの値で出る
        '',
        '[入れ子](entry:c3#h/補足)', // 深さ ≤ 1: 章の中の参照は題名のリンクに降りる
        '',
        '### 小さい見出し',
        '',
        '中身',
        '',
        '',
        '以上',
        '',
      ].join('\n'),
    );
    expect(r.body).not.toContain('次の章');
  });

  it('🔴 見つからない章 / ノートは、黙って空にせず引用の 1 行を残す', async () => {
    const body = '![A](entry:other#h/ない)\n\n![B](entry:gone#h/x)\n';
    const r = await flattenSectionEmbeds(body, 'self', bodyOf);
    expect(r.expanded).toBe(0);
    expect(r.missing).toBe(2);
    expect(r.body).toContain('> 「A」: 見出しが見つかりません');
    expect(r.body).toContain('> 「B」: ノートが見つかりません');
  });

  it('自分自身を指す参照は題名のリンクにする(循環しない)', async () => {
    const r = await flattenSectionEmbeds('![自分](entry:self#h/章)\n', 'self', bodyOf);
    expect(r.body).toBe('[自分](entry:self#h/章)\n');
    expect(r.expanded).toBe(0);
  });

  it('🔴 コードの囲みの中・行の途中の参照・見出しを指さない参照には触れない(対照群)', async () => {
    const body = '```\n![x](entry:other#h/決定事項)\n```\n\n文の途中 ![y](entry:other#h/決定事項) です\n\n![z](entry:other)\n';
    const r = await flattenSectionEmbeds(body, 'self', bodyOf);
    expect(r.body).toBe(body);
    expect(r.expanded).toBe(0);
  });

  it('参照が 1 つも無い本文は 1 バイトも変えず、本文を引きにも行かない', async () => {
    let asked = 0;
    const r = await flattenSectionEmbeds('# 見出し\n\n本文\n', 'self', async () => {
      asked += 1;
      return null;
    });
    expect(r.body).toBe('# 見出し\n\n本文\n');
    expect(asked).toBe(0);
  });

  it('同じノートの章を 2 つ展開しても、本文は 1 回しか引かない', async () => {
    let asked = 0;
    const r = await flattenSectionEmbeds(
      '![a](entry:other#h/決定事項)\n![b](entry:other#h/次の章)\n',
      'self',
      async (lid) => {
        asked += 1;
        return bodyOf(lid);
      },
    );
    expect(r.expanded).toBe(2);
    expect(asked).toBe(1);
    expect(r.body).toContain('別の話');
  });

  it('🔴 system 領域のノート(本文は読めるが user 領域の一覧に居ない)の章は展開せず、引用の 1 行と結果の種類で返す', async () => {
    const r = await flattenSectionEmbeds('![秘](entry:other#h/決定事項)\n![ない](entry:none#h/x)\n', 'self', bodyOf, {
      userLids: new Set(['self']),
      titleOf: (l) => (l === 'other' ? '議事録' : undefined),
    });
    expect(r.body).toContain('> 「秘」: (システムのノートは書き出しに入れません)');
    expect(r.body).not.toContain('予算は承認');
    expect(r.blocked).toBe(1);
    // 対照: 本当に無いノートは「見つかりません」(system と取り違えない)
    expect(r.body).toContain('> 「ない」: ノートが見つかりません');
    expect(r.missing).toBe(1);
    // 対照: user 領域に居れば展開し、題名が結果に乗る
    const ok = await flattenSectionEmbeds('![決](entry:other#h/決定事項)\n', 'self', bodyOf, {
      userLids: new Set(['self', 'other']),
      titleOf: () => '議事録',
    });
    expect(ok.refs).toEqual([{ key: 'self\u0000other#決定事項', kind: 'expanded', title: '議事録' }]);
  });

  it('CRLF の本文は CRLF のまま返す', async () => {
    const r = await flattenSectionEmbeds('a\r\n![x](entry:other#h/次の章)\r\nb\r\n', 'self', bodyOf);
    expect(r.body.includes('\r\n')).toBe(true);
    expect(r.body.replace(/\r\n/gu, '')).not.toContain('\n');
  });

  it('展開した原文を描くと、画面と同じ描画器が章をそのまま描く(空の枠が残らない)', async () => {
    const r = await flattenSectionEmbeds('![決定事項](entry:other#h/決定事項)\n', 'self', bodyOf);
    const html = renderMarkdown(r.body);
    expect(html).toContain('予算は承認');
    expect(html).not.toContain('pkc-transclusion-placeholder');
  });
});
