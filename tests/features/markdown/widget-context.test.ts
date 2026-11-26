/**
 * ウィジェットが読める「同じノートのデータ」(v4.0 Phase 2 / PR-08)。
 *
 * 守る主張:
 * 1. Markdown 表 + csv / tsv / psv の囲みを文書順に、見出しと行に分けて返す
 * 2. 前書きの値(文字列・数・真偽・null・配列)だけを写す
 * 3. コードブロックの中の偽の表は読まない
 * 4. 行数・表の数の上限で切り詰め、`truncated` を付ける
 */
import { describe, expect, it } from 'vitest';
import {
  extractWidgetNoteContext,
  WIDGET_CONTEXT_MAX_ROWS,
  WIDGET_CONTEXT_MAX_TABLES,
} from '../../../src/features/markdown/widget-context';

describe('extractWidgetNoteContext', () => {
  it('🔴 前書き・Markdown 表・csv / tsv / psv を文書順に', () => {
    const body = [
      '---',
      'title: 家計',
      'budget: 5000',
      'tags: [a, b]',
      'done: true',
      '---',
      '# 見出し',
      '',
      '| 品目 | 金額 |',
      '|---|---:|',
      '| 米 | 2000 |',
      '| 卵 | 300 |',
      '',
      '```csv',
      'name,qty',
      'りんご,3',
      '"み,かん",5',
      '```',
      '',
      '```tsv',
      'a\tb',
      '1\t2',
      '```',
      '',
      '```psv noheader',
      'x|y',
      '```',
    ].join('\n');
    const ctx = extractWidgetNoteContext(body);
    expect(ctx.frontmatter).toEqual({ title: '家計', budget: 5000, tags: ['a', 'b'], done: true });
    expect(ctx.tables).toEqual([
      { index: 0, kind: 'markdown', headers: ['品目', '金額'], rows: [['米', '2000'], ['卵', '300']] },
      { index: 1, kind: 'csv', headers: ['name', 'qty'], rows: [['りんご', '3'], ['み,かん', '5']] },
      { index: 2, kind: 'tsv', headers: ['a', 'b'], rows: [['1', '2']] },
      { index: 3, kind: 'psv', headers: [], rows: [['x', 'y']] },
    ]);
    expect(ctx.truncated).toBeUndefined();
  });

  it('🔴 コードブロックの中の偽の表・前書きの中の表は読まない', () => {
    const body = '```md\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n\n~~~\na,b\n~~~\n';
    expect(extractWidgetNoteContext(body).tables).toEqual([]);
    const fm = '---\nx: "| a | b |"\n---\n本文\n';
    expect(extractWidgetNoteContext(fm).tables).toEqual([]);
  });

  it('表が無ければ空・前書きが無ければ空のオブジェクト', () => {
    expect(extractWidgetNoteContext('ただの段落\n')).toEqual({ frontmatter: {}, tables: [] });
    expect(extractWidgetNoteContext('')).toEqual({ frontmatter: {}, tables: [] });
  });

  it('🔴 行数の上限で切り詰めて truncated を付ける', () => {
    const rows = Array.from({ length: WIDGET_CONTEXT_MAX_ROWS + 5 }, (_, i) => `${String(i)},x`);
    const ctx = extractWidgetNoteContext(['```csv', 'n,v', ...rows, '```'].join('\n'));
    expect(ctx.tables[0]!.rows).toHaveLength(WIDGET_CONTEXT_MAX_ROWS);
    expect(ctx.tables[0]!.truncated).toBe(true);
    expect(ctx.tables[0]!.rows[0]).toEqual(['0', 'x']);
    // 上限ちょうどは切らない
    const exact = extractWidgetNoteContext(['```csv', 'n', ...rows.slice(0, WIDGET_CONTEXT_MAX_ROWS), '```'].join('\n'));
    expect(exact.tables[0]!.truncated).toBeUndefined();
  });

  it('🔴 表の数の上限で切り詰めて truncated を付ける', () => {
    const one = '| a |\n|---|\n| 1 |\n';
    const ctx = extractWidgetNoteContext(Array.from({ length: WIDGET_CONTEXT_MAX_TABLES + 3 }, () => one).join('\n'));
    expect(ctx.tables).toHaveLength(WIDGET_CONTEXT_MAX_TABLES);
    expect(ctx.truncated).toBe(true);
    expect(ctx.tables.map((t) => t.index)).toEqual(Array.from({ length: WIDGET_CONTEXT_MAX_TABLES }, (_, i) => i));
  });

  it('返す物は写し(呼ぶたびに別の物)', () => {
    const body = '| a |\n|---|\n| 1 |\n';
    const a = extractWidgetNoteContext(body);
    a.tables[0]!.rows[0]![0] = 'X';
    expect(extractWidgetNoteContext(body).tables[0]!.rows[0]![0]).toBe('1');
  });
});
