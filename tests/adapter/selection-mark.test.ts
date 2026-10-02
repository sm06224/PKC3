/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { paintRowMark } from '../../src/adapter/ui/render/selection-mark';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string, order: number, title = 't-' + lid, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

function bootedState(metas: EntryMeta[]): AppState {
  return reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas,
    relations: [],
  }).state;
}

describe('🔴 複数選択の読み上げ対応 (Issue #1064)', () => {
  describe('paintRowMark ── data-pkc-marked と aria-selected の同期', () => {
    it('isMarked = true のとき data-pkc-marked と aria-selected="true" を付与する', () => {
      const el = document.createElement('tr');
      paintRowMark(el, true);
      expect(el.hasAttribute('data-pkc-marked')).toBe(true);
      expect(el.getAttribute('aria-selected')).toBe('true');
    });

    it('isMarked = false のとき data-pkc-marked と aria-selected を両方除去する', () => {
      const el = document.createElement('tr');
      el.setAttribute('data-pkc-marked', '');
      el.setAttribute('aria-selected', 'true');

      paintRowMark(el, false);
      expect(el.hasAttribute('data-pkc-marked')).toBe(false);
      expect(el.hasAttribute('aria-selected')).toBe(false);
    });
  });

  describe('フォルダの表 (FilerRenderer) の aria-multiselectable と aria-selected', () => {
    it('フォルダの表の器(filer-table)に aria-multiselectable="true" が付き、選択行に aria-selected="true" が付く', () => {
      document.body.textContent = '';
      const region = document.createElement('div');
      document.body.append(region);
      const filer = new FilerRenderer(region);
      const metas = [meta('f1', 1, 'folder1', 'folder'), meta('n1', 2, 'note1', 'text')];
      let st = bootedState(metas);
      st = { ...st, selection: ['n1'] };
      filer.render(st);

      const table = region.querySelector('[data-pkc-region="filer-table"]');
      expect(table).not.toBeNull();
      expect(table?.getAttribute('aria-multiselectable')).toBe('true');

      const trN1 = region.querySelector('tr[data-pkc-entry="n1"]');
      const trF1 = region.querySelector('tr[data-pkc-entry="f1"]');
      expect(trN1?.getAttribute('data-pkc-marked')).toBe('');
      expect(trN1?.getAttribute('aria-selected')).toBe('true');
      expect(trF1?.hasAttribute('data-pkc-marked')).toBe(false);
      expect(trF1?.hasAttribute('aria-selected')).toBe(false);
    });

    // 🔴 かつて一覧タブ(#813 段③ で外した)が持っていた「印が移ると外れる」もここで守る
    it('印が別の行へ移ると、前の行の data-pkc-marked と aria-selected が消える', () => {
      document.body.textContent = '';
      const region = document.createElement('div');
      document.body.append(region);
      const filer = new FilerRenderer(region);
      let st = bootedState([meta('a1', 1), meta('a2', 2)]);
      st = { ...st, selection: ['a1'] };
      filer.render(st);
      const rowA1 = region.querySelector('tr[data-pkc-entry="a1"]');
      const rowA2 = region.querySelector('tr[data-pkc-entry="a2"]');
      expect(rowA1?.getAttribute('data-pkc-marked')).toBe('');
      expect(rowA1?.getAttribute('aria-selected')).toBe('true');
      expect(rowA2?.hasAttribute('data-pkc-marked')).toBe(false);

      st = { ...st, selection: ['a2'] };
      filer.render(st);
      // ⚠ 行が作り直されても見られるよう、引き直して見る
      const nowA1 = region.querySelector('tr[data-pkc-entry="a1"]');
      const nowA2 = region.querySelector('tr[data-pkc-entry="a2"]');
      expect(nowA1?.hasAttribute('data-pkc-marked')).toBe(false);
      expect(nowA1?.hasAttribute('aria-selected')).toBe(false);
      expect(nowA2?.getAttribute('data-pkc-marked')).toBe('');
      expect(nowA2?.getAttribute('aria-selected')).toBe('true');
    });
  });

  describe('2ペインの表 (DualFilerRenderer) の aria-multiselectable と aria-selected', () => {
    it('2ペインの表の器に aria-multiselectable="true" が付き、選択行に aria-selected="true" が付く', () => {
      document.body.textContent = '';
      const region = document.createElement('div');
      document.body.append(region);
      const dual = new DualFilerRenderer(region);
      const metas = [meta('d1', 1), meta('d2', 2)];
      let st = bootedState(metas);
      st = {
        ...st,
        dual: {
          ...st.dual,
          left: { ...st.dual.left, selection: ['d1'] },
        },
      };
      dual.render(st);

      const table = region.querySelector('[data-pkc-region="dual-table"] table');
      expect(table).not.toBeNull();
      expect(table?.getAttribute('aria-multiselectable')).toBe('true');

      const trD1 = region.querySelector('tr[data-pkc-entry="d1"]');
      const trD2 = region.querySelector('tr[data-pkc-entry="d2"]');
      expect(trD1?.getAttribute('data-pkc-marked')).toBe('');
      expect(trD1?.getAttribute('aria-selected')).toBe('true');
      expect(trD2?.hasAttribute('data-pkc-marked')).toBe(false);
      expect(trD2?.hasAttribute('aria-selected')).toBe(false);
    });
  });
});
