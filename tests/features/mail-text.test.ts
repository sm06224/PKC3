/** @vitest-environment node */
/**
 * 🔴 **ノートの本文を、メールに貼れる字にする**(#1459 段②)。
 *
 * 期待値は字面で書く(実装と同じ切り方で組むと同じ盲点を共有する)。frontmatter を持たせ、
 * 「記号が残らない」だけでなく「字は落ちない」(対照群)を見る。
 */
import { describe, expect, it } from 'vitest';
import { displayWidth, gridToText, inlineToText, mailDraftText, markdownToMailText } from '../../src/features/report/mail-text';

describe('インラインの記号', () => {
  it('強調・コード・マークは字だけ残す / 対になっていない記号は触らない', () => {
    expect(inlineToText('**太** と *斜* と ~~消~~ と ==印== と `code`')).toBe('太 と 斜 と 消 と 印 と code');
    expect(inlineToText('2 * 3 = 6 と a_b_c')).toBe('2 * 3 = 6 と a_b_c');
  });

  it('リンクは「字 (URL)」/ ノート内のリンクは字だけ / 添付は [添付: 名前] / 画像は [画像: alt]', () => {
    expect(inlineToText('[公式](https://example.com/a)')).toBe('公式 (https://example.com/a)');
    expect(inlineToText('[https://example.com](https://example.com)')).toBe('https://example.com');
    expect(inlineToText('[議事録](entry:abc#h/決定)')).toBe('議事録');
    expect(inlineToText('[仕様書.pdf](asset:k1)')).toBe('[添付: 仕様書.pdf]');
    expect(inlineToText('![構成図](asset:k2)')).toBe('[画像: 構成図]');
    expect(inlineToText('[連絡](mailto:a@example.com)')).toBe('連絡 (a@example.com)');
  });
});

describe('ブロックの記号', () => {
  const body = [
    '---',
    'vars.担当: 佐藤',
    'tags: [週報]',
    '---',
    '# 週報',
    '',
    '担当: {{vars.担当}}。**重要**です。',
    '',
    '## 数字',
    '',
    '| 項目 | 件数 |',
    '|---|---:|',
    '| りんご | 3 |',
    '| みかん | 12 |',
    '',
    '- やること',
    '  - [ ] 未',
    '  - [x] 済',
    '1. 手順',
    '',
    '> 引用です',
    '',
    '```csv',
    '品名,数',
    '桃,7',
    '```',
    '',
    ':::note',
    '囲みの中',
    ':::',
    '',
    '---',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
  ].join('\n');

  it('🔴 見出し・表・箇条書き・チェック・引用・囲み・csv・水平線・コードが読める字になる', () => {
    expect(markdownToMailText(body)).toBe(
      [
        '【週報】',
        '',
        '担当: 佐藤。重要です。',
        '',
        '■ 数字',
        '',
        '項目   | 件数',
        '-------+-----',
        'りんご | 3',
        'みかん | 12',
        '',
        '・ やること',
        '  ☐ 未',
        '  ☑ 済',
        '1. 手順',
        '',
        '> 引用です',
        '',
        '品名 | 数',
        '-----+---',
        '桃   | 7',
        '',
        '囲みの中',
        '',
        '----------',
        '',
        'const a = 1;',
        '',
      ].join('\n'),
    );
  });

  it('frontmatter は出さない(対照群: 本文の字は落ちない)', () => {
    const t = markdownToMailText(body);
    expect(t).not.toContain('tags');
    expect(t.split('\n')).not.toContain('---');
    expect(t).toContain('重要です');
  });

  it('入力欄の定義は「項目: 値」の行になる(未入力・チェックを含む)', () => {
    const b = '---\nvars.氏名: 山田\nvars.済: true\n---\n```yaml form\ntitle: 日報\nfields:\n  - name: 氏名\n    label: お名前\n  - name: 済\n    type: checkbox\n  - name: 備考\n```\n';
    expect(markdownToMailText(b)).toBe('日報\nお名前: 山田\n済: はい\n備考: (未入力)\n');
  });

  it('件名つき下書き', () => {
    expect(mailDraftText('  週報  2026-10-26 ', '本文\n')).toBe('件名: 週報 2026-10-26\n\n本文\n');
  });
});

describe('表の幅', () => {
  it('全角は 2 として揃える', () => {
    expect(displayWidth('りんご')).toBe(6);
    expect(displayWidth('abc')).toBe(3);
    expect(gridToText([['a', 'b'], ['りんご', '1']], true)).toEqual(['a      | b', '-------+--', 'りんご | 1']);
  });
});
