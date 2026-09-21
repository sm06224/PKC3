/** @vitest-environment happy-dom */
/**
 * 🔴 **右クリックのメニューに、塊が変わる所だけ見出しの行が出る**(#1029 段 C 門③)。
 *
 * ## なぜ要るか
 *
 * 段 C で右クリックの字を短くした(「参照をコピー」→「参照」等)── 短くできたのは、
 * **塊の見出しが動詞を引き受ける**という前提があるから(右の列は「間」で塊を示す)。
 * ⚠ 右クリックは縦 1 列のメニューで「間」だけでは塊の境目が読めないので、
 * **見出しの行そのもの**を挟む。ここが無いと、短くした字だけが並んで意味が読めなくなる
 * (`button-rhythm-design-2026-09.md` §4.0)。
 *
 * ⚠ **見出しは押せない**(押し所を増やさない)── `<button>` ではなく `<div>` で、
 * `data-pkc-action` を持たない。
 */
import { describe, expect, it } from 'vitest';
import {
  MENU_GROUP_FIELD,
  openContextMenu,
  type MenuItem,
} from '../../src/adapter/ui/render/context-menu';
import {
  ENTRY_ACTION_GROUP_LABELS,
  ENTRY_ACTION_WIDTH_ATTR,
  entryActionWidthTier,
  entryMenuActions,
} from '../../src/features/entry-actions';

function menuChildren(root: HTMLElement): Element[] {
  const el = root.querySelector('[data-pkc-region="context-menu"]');
  expect(el, 'メニューが開いていない(前提が崩れている)').not.toBeNull();
  return [...el!.children];
}

describe('右クリックの塊の見出し(#1029 段 C)', () => {
  it('🔴 見出しは押せない字である(button ではなく、data-pkc-action を持たない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const rows = entryMenuActions({ archetype: 'folder', linkedFile: 'memo.md' });
    // ⚠ 空振り防止 ── 塊を持つ行が無ければ、この検査は何も見ない
    expect(rows.some((r) => r.group !== undefined), '塊を持つ行が 0 件(空振り)').toBe(true);
    openContextMenu(root, { x: 0, y: 0 }, rows, null);
    const headings = menuChildren(root).filter(
      (c) => c.getAttribute('data-pkc-field') === MENU_GROUP_FIELD,
    );
    expect(headings.length, '見出しが 1 つも出ていない').toBeGreaterThan(0);
    for (const h of headings) {
      expect(h.tagName, '見出しがボタンになっている(押し所が増えた)').not.toBe('BUTTON');
      expect(h.hasAttribute('data-pkc-action'), '見出しが押せる操作の属性を持っている').toBe(
        false,
      );
    }
  });

  it('🔴 既存の項目の並びは 1 つも変わらない(見出しを挟んでも action の列は同じ)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const rows = entryMenuActions({ archetype: 'folder', linkedFile: 'memo.md' });
    openContextMenu(root, { x: 0, y: 0 }, rows, null);
    const actions = menuChildren(root)
      .filter((c): c is HTMLButtonElement => c instanceof HTMLButtonElement)
      .map((b) => b.getAttribute('data-pkc-action'));
    expect(actions, '見出しを挟んだら項目の並びが崩れた').toEqual(rows.map((r) => r.action));
  });

  it('🔴 見出しの字は塊の綴りと 1 対 1 で、実装の group から来る(取り違えを殺す)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const rows = entryMenuActions({ archetype: 'folder', linkedFile: 'memo.md' });
    // ⚠ 期待値は「塊が変わった回数」を rows 自身から数える(実装のループを真似ない ──
    //   同じ盲点を共有しないよう、ここは「隣同士を比べる」という別の観測にする)
    const wantHeadings: string[] = [];
    let lastGroup: string | undefined;
    for (const r of rows) {
      if (r.group !== undefined && r.group !== lastGroup) {
        wantHeadings.push(ENTRY_ACTION_GROUP_LABELS[r.group] ?? r.group);
      }
      lastGroup = r.group;
    }
    openContextMenu(root, { x: 0, y: 0 }, rows, null);
    const gotHeadings = menuChildren(root)
      .filter((c) => c.getAttribute('data-pkc-field') === MENU_GROUP_FIELD)
      .map((c) => c.textContent);
    expect(gotHeadings).toEqual(wantHeadings);
  });

  it('🔴 「バックアップ」が 2 つ並ぶ場面(フォルダ)で、見出しが区別を言う', () => {
    /**
     * ⚠ `export-entry` は `when` を持たないので、フォルダを選んでいても常に出る ──
     *   つまりフォルダでは `export-entry`(バックアップ)と `export-folder`(バックアップ)
     *   が**同じメニューに同時に**出る(実装を読んで確かめた。1 grep で反証できる主張)。
     * 🔑 名前が同じでも、直前の見出し(「書き出す」→「このフォルダ」)が変わるので
     *   どちらを押しているかが読める。
     */
    const root = document.createElement('div');
    document.body.append(root);
    const rows = entryMenuActions({ archetype: 'folder', linkedFile: null });
    // ⚠ 前提: 衝突が実際に起きている(起きていなければ、この検査は何も守らない)
    expect(
      rows.filter((r) => r.label === 'バックアップ').length,
      '前提が崩れている(バックアップの衝突が起きていない)',
    ).toBe(2);
    openContextMenu(root, { x: 0, y: 0 }, rows, null);
    const el = root.querySelector('[data-pkc-region="context-menu"]')!;
    const folderBtn = el.querySelector('[data-pkc-action="export-folder"]');
    expect(folderBtn, 'export-folder のボタンが無い').not.toBeNull();
    const prev = folderBtn!.previousElementSibling;
    expect(prev?.getAttribute('data-pkc-field'), 'export-folder の直前が見出しではない').toBe(
      MENU_GROUP_FIELD,
    );
    expect(prev?.textContent, '見出しの字が「このフォルダ」ではない').toBe('このフォルダ');
    // ⚠ 対照群 ── export-entry の見出しは「書き出す」で、export-folder とは違う字である
    const entryBtn = el.querySelector('[data-pkc-action="export-entry"]');
    const entryPrev = entryBtn?.previousElementSibling;
    expect(entryPrev?.textContent, 'export-entry の見出しが違う').toBe('書き出す');
  });

  it('🔴 幅の段の属性が、正本(entryActionWidthTier)と一致する', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const rows = entryMenuActions({ archetype: 'folder', linkedFile: 'memo.md' });
    openContextMenu(root, { x: 0, y: 0 }, rows, null);
    for (const r of rows) {
      const btn = root.querySelector(`[data-pkc-action="${r.action}"]`);
      expect(btn, `${r.action} のボタンが無い`).not.toBeNull();
      expect(
        btn!.getAttribute(ENTRY_ACTION_WIDTH_ATTR),
        `${r.action} の幅の段が正本と食い違っている`,
      ).toBe(entryActionWidthTier(r.label));
    }
  });

  it('⚠ 塊を持たない項目には見出しを挟まない(単発の項目を塊扱いしない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const items: MenuItem[] = [{ action: 'no-group-item', label: '単発' }];
    openContextMenu(root, { x: 0, y: 0 }, items, null);
    const headings = menuChildren(root).filter(
      (c) => c.getAttribute('data-pkc-field') === MENU_GROUP_FIELD,
    );
    expect(headings, '塊を持たない項目にまで見出しが出た').toEqual([]);
  });
});
