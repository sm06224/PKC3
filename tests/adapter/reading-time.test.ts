/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { paintReadingTime } from '../../src/adapter/ui/render/reading-time';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('🔴 読了目安時間・文字数バッジ (Issue #1137)', () => {
  describe('paintReadingTime ── DOM 反映処理', () => {
    it('body = null のときは非表示 (hidden = true)', () => {
      const el = document.createElement('div');
      paintReadingTime(el, null);
      expect(el.hidden).toBe(true);
      expect(el.textContent).toBe('');
    });

    it('200文字未満の短文では非表示 (hidden = true)', () => {
      const el = document.createElement('div');
      paintReadingTime(el, '短いメモです。');
      expect(el.hidden).toBe(true);
      expect(el.textContent).toBe('');
    });

    it('200文字以上の長文では表示され、読了時間と文字数が設定される', () => {
      const el = document.createElement('div');
      const longText = '日本語の長文ノートの本文です。'.repeat(20); // 300字
      paintReadingTime(el, longText);
      expect(el.hidden).toBe(false);
      expect(el.className).toBe('pkc-reading-time');
      expect(el.textContent).toContain('約 1 分');
      expect(el.textContent).toContain('300 文字');
    });
  });

  describe('DetailRenderer 連携', () => {
    it('長文ノート閲覧時に detail-reading-time 要素が表示される', async () => {
      const root = document.createElement('div');
      const regions = buildShell(root);
      const detail = new DetailRenderer(regions.detail);

      let s = reduce(initialState, {
        type: 'SYS_BOOTED',
        cid: 'c1',
        metas: [meta('long-note')],
        relations: [],
      }).state;
      s = reduce(s, { type: 'SELECT_ENTRY', lid: 'long-note' }).state;
      const longBody = '長文の解説ノートです。'.repeat(50); // 550文字 (11字 * 50)
      s = reduce(s, { type: 'BODY_LOADED', lid: 'long-note', body: longBody }).state;

      detail.render(s);
      await settle();

      const readingTimeEl = regions.detail.querySelector<HTMLElement>(
        '[data-pkc-field="detail-reading-time"]',
      );
      expect(readingTimeEl).not.toBeNull();
      expect(readingTimeEl?.hidden).toBe(false);
      expect(readingTimeEl?.textContent).toContain('約 1 分');
      expect(readingTimeEl?.textContent).toContain('550 文字');
    });

    it('短文ノートでは detail-reading-time 要素が非表示になる', async () => {
      const root = document.createElement('div');
      const regions = buildShell(root);
      const detail = new DetailRenderer(regions.detail);

      let s = reduce(initialState, {
        type: 'SYS_BOOTED',
        cid: 'c1',
        metas: [meta('short-note')],
        relations: [],
      }).state;
      s = reduce(s, { type: 'SELECT_ENTRY', lid: 'short-note' }).state;
      s = reduce(s, { type: 'BODY_LOADED', lid: 'short-note', body: '短いメモ。' }).state;

      detail.render(s);
      await settle();

      const readingTimeEl = regions.detail.querySelector<HTMLElement>(
        '[data-pkc-field="detail-reading-time"]',
      );
      expect(readingTimeEl).not.toBeNull();
      expect(readingTimeEl?.hidden).toBe(true);
    });
  });
});
