/**
 * HTML ツールのテンプレート(v4.0 Phase 2 / PR-08)。
 *
 * 守る主張:
 * 1. 4 種が並び、どれも `id=` 付きの ```html の囲みとして入る(本文に入れると保存つきのウィジェットとして描かれる)
 * 2. 外部 CDN ゼロ(外へ取りに行く記述が無い)・テーマの変数(`--pkc-*`)で書く
 * 3. 台本が構文として読める
 * 4. `nextWidgetId` は同じノートで使われていない id を採る
 */
import { describe, expect, it } from 'vitest';
import { nextWidgetId, usedWidgetIds, widgetTemplateBlock, WIDGET_TEMPLATES } from '../../../src/features/markdown/widget-templates';
import { renderMarkdown } from '../../../src/features/markdown/markdown-render';
import { allFences } from '../../../src/features/markdown/source-blocks';

describe('WIDGET_TEMPLATES', () => {
  it('4 種(並び順も正本どおり)', () => {
    expect(WIDGET_TEMPLATES.map((t) => t.baseId)).toEqual(['tracker', 'checklist', 'calculator', 'table-summary']);
    expect(WIDGET_TEMPLATES.map((t) => t.label)).toEqual([
      'カウンター・進捗トラッカー',
      'チェック集計リスト',
      '簡易計算・試算ツール',
      'ノート内テーブル集計',
    ]);
  });

  for (const t of WIDGET_TEMPLATES) {
    describe(t.baseId, () => {
      const block = widgetTemplateBlock(t, t.baseId);
      it('🔴 1 つの閉じた ```html id= の囲みになり、保存つきの器で描かれる', () => {
        const fences = allFences(block);
        expect(fences).toHaveLength(1);
        expect(fences[0]!.open).toBe(false);
        expect(block.startsWith(`\`\`\`html id="${t.baseId}"\n`)).toBe(true);
        const html = renderMarkdown(block, { liveWidgets: true });
        expect(html).toContain(`data-pkc-widget-id="${t.baseId}"`);
        expect(html).toContain('data-pkc-widget-live="1"');
      });
      it('🔴 外部 CDN ゼロ・テーマの変数で書く', () => {
        expect(t.html).not.toMatch(/<script[^>]*\bsrc=/i);
        expect(t.html).not.toMatch(/<link\b/i);
        expect(t.html).not.toMatch(/https?:\/\//i);
        expect(t.html).not.toMatch(/\bfetch\(|XMLHttpRequest|import\(/);
        expect(t.html).toContain('var(--pkc-accent');
        expect(t.html).toContain('var(--pkc-fg');
        // ⚠ 箱は allow-forms を持たない ── <form> の送信に頼らない
        expect(t.html).not.toMatch(/<form\b/i);
      });
      it('台本が構文として読める', () => {
        const scripts = [...t.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
        expect(scripts.length).toBeGreaterThan(0);
        for (const src of scripts) expect(() => new Function(src)).not.toThrow();
      });
    });
  }

  it('ノート内テーブル集計は readTables で同じノートの表を読む', () => {
    const t = WIDGET_TEMPLATES.find((x) => x.baseId === 'table-summary')!;
    expect(t.html).toContain('window.pkcWidget.readTables()');
  });
});

describe('nextWidgetId', () => {
  it('🔴 使われていなければ baseId のまま', () => {
    expect(nextWidgetId('', 'tracker')).toBe('tracker');
    expect(nextWidgetId('```html id="checklist"\n```\n', 'tracker')).toBe('tracker');
  });
  it('🔴 使われていれば -2, -3 … と採る(本体と状態ブロックの両方を見る)', () => {
    const one = '```html id="tracker"\nx\n```\n';
    expect(nextWidgetId(one, 'tracker')).toBe('tracker-2');
    const two = `${one}\n\`\`\`html id="tracker-2"\nx\n\`\`\`\n`;
    expect(nextWidgetId(two, 'tracker')).toBe('tracker-3');
    // 本体を消しても状態ブロックが残っていれば、その id は避ける
    expect(nextWidgetId('```json widget-state="tracker"\n{}\n```\n', 'tracker')).toBe('tracker-2');
    // react / jsx の id も数える
    expect(nextWidgetId('```react id="tracker"\nx\n```\n', 'tracker')).toBe('tracker-2');
  });
  it('2 つ続けて入れても id が衝突しない', () => {
    const t = WIDGET_TEMPLATES[0]!;
    let body = '';
    for (let i = 0; i < 3; i++) body += widgetTemplateBlock(t, nextWidgetId(body, t.baseId)) + '\n';
    expect([...usedWidgetIds(body)].sort()).toEqual(['tracker', 'tracker-2', 'tracker-3']);
  });
});
