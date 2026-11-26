/** @vitest-environment happy-dom */
/**
 * 🔴 ノート単位のページ設定を中央の本文の器へ当てる / 印刷レイアウト表示(v4.0 Phase 1 / PR-03)。
 *
 * 見るもの:
 * - 上書きは器にだけ当たり、`:root` を汚さない
 * - 指定の無いノート・ノートが出ていないときは器の上書きが確実に外れ、`@page` もアプリの紙面へ戻る
 * - 値が変わらないときは書かない(器の見張りを無駄に鳴らさない)
 * - 印刷レイアウト表示の入切・保存・紙の寸法の変数
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPrintLayout,
  choosePrintLayout,
  clearNoteLayout,
  initialPrintLayout,
  isPrintLayoutOn,
  NOTE_FONT_ATTR,
  PAPER_FALLBACK_ATTR,
  paintPrintLayoutButton,
  PRINT_LAYOUT_ATTR,
  PRINT_LAYOUT_STORAGE_KEY,
  refreshNoteLayout,
  resetNoteLayoutForTest,
  SHEET_COLS_ATTR,
  syncNoteLayout,
  togglePrintLayout,
  noteLayoutBodyOf,
} from '../../src/adapter/ui/render/note-layout';
import { applyPageFormat } from '../../src/adapter/ui/render/page-format';
import { applyReadColumns, effectiveReadColumnsFor, NOTE_COLUMNS_ATTR } from '../../src/adapter/ui/render/read-columns';
import { fontSpec } from '../../src/features/appearance-choice';
import type { AppState } from '../../src/adapter/state/app-state';

const LAYOUT_BODY = '---\npage_format: a4-landscape\npage_margin: wide\npage_font: mincho\n---\n本文';
const PLAIN_BODY = '指定の無いノート';

function paper(): string | null {
  return document.querySelector('style[data-pkc-field="page-paper"]')?.textContent ?? null;
}

let pane: HTMLElement;

beforeEach(() => {
  resetNoteLayoutForTest();
  localStorage.clear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  const root = document.documentElement;
  root.removeAttribute(PRINT_LAYOUT_ATTR);
  root.removeAttribute('style');
  applyPageFormat(root, 'a4-portrait');
  applyReadColumns(root, '1');
  const region = document.createElement('div');
  region.setAttribute('data-pkc-region', 'detail');
  pane = document.createElement('div');
  pane.setAttribute('data-pkc-view-pane', 'detail');
  region.append(pane);
  document.body.append(region);
});

afterEach(() => {
  resetNoteLayoutForTest();
});

describe('ノート単位のページ設定を器へ当てる', () => {
  it('🔴 用紙・字体は器にだけ当たり、:root を汚さない。@page はノートの用紙 + 余白', () => {
    const root = document.documentElement;
    const rootStyleBefore = root.getAttribute('style');
    syncNoteLayout(pane, LAYOUT_BODY);
    expect(pane.getAttribute('data-pkc-page-format')).toBe('a4-landscape');
    expect(pane.style.getPropertyValue('--read-w')).toBe('62rem');
    expect(pane.getAttribute(NOTE_FONT_ATTR)).toBe('mincho');
    expect(pane.style.getPropertyValue('--font')).toBe(fontSpec('mincho').ui);
    // :root は動かない
    expect(root.getAttribute('data-pkc-page-format')).toBe('a4-portrait');
    expect(root.getAttribute('style')).toBe(rootStyleBefore);
    expect(root.style.getPropertyValue('--font')).toBe('');
    expect(paper()).toBe('@page{size:A4 landscape;margin:30mm}');
  });

  it('🔴 指定の無いノートへ移ると上書きが外れ、@page はアプリの用紙(余白なし)へ戻る', () => {
    syncNoteLayout(pane, LAYOUT_BODY);
    syncNoteLayout(pane, PLAIN_BODY);
    expect(pane.hasAttribute('data-pkc-page-format')).toBe(false);
    expect(pane.hasAttribute(NOTE_FONT_ATTR)).toBe(false);
    expect(pane.style.getPropertyValue('--read-w')).toBe('');
    expect(pane.style.getPropertyValue('--font')).toBe('');
    expect(paper()).toBe('@page{size:A4 portrait}');
  });

  it('🔴 ノートが出ていない(null)ときも外れ、@page はアプリの用紙へ戻る。画面用の用紙なら @page ごと消える', () => {
    syncNoteLayout(pane, LAYOUT_BODY);
    applyPageFormat(document.documentElement, 'fullhd');
    syncNoteLayout(pane, null);
    expect(pane.hasAttribute('data-pkc-page-format')).toBe(false);
    expect(pane.hasAttribute(NOTE_FONT_ATTR)).toBe(false);
    expect(paper()).toBeNull();
  });

  it('🔴 指定の無いノートの器には何も書かない(原本不変)', () => {
    syncNoteLayout(pane, PLAIN_BODY);
    expect(pane.attributes.length).toBe(1); // data-pkc-view-pane だけ
    expect(pane.getAttribute('style')).toBeNull();
    expect(paper()).toBe('@page{size:A4 portrait}');
  });

  it('🔴 値が変わらないときは setAttribute / style を書かない', () => {
    syncNoteLayout(pane, LAYOUT_BODY);
    const mutations: MutationRecord[] = [];
    const mo = new MutationObserver((r) => mutations.push(...r));
    mo.observe(pane, { attributes: true });
    syncNoteLayout(pane, LAYOUT_BODY);
    syncNoteLayout(pane, `${LAYOUT_BODY}`); // 同じ字の別の文字列
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        mo.disconnect();
        expect(mutations).toEqual([]);
        resolve();
      }, 0);
    });
  });

  it('段組みの指定は器の印と --pkc-read-cols に入り、段数の判定はそれを先に見る', () => {
    const root = document.documentElement;
    syncNoteLayout(pane, '---\npage_columns: 3\n---\n本文');
    expect(pane.getAttribute(NOTE_COLUMNS_ATTR)).toBe('3');
    expect(pane.style.getPropertyValue('--pkc-read-cols')).toBe('3');
    expect(effectiveReadColumnsFor(pane, root)).toBe('3');
    syncNoteLayout(pane, PLAIN_BODY);
    expect(pane.hasAttribute(NOTE_COLUMNS_ATTR)).toBe(false);
    expect(effectiveReadColumnsFor(pane, root)).toBe('1');
  });

  it('器が作り直されたら、前の器の上書きを外す', () => {
    syncNoteLayout(pane, LAYOUT_BODY);
    const next = document.createElement('div');
    next.setAttribute('data-pkc-view-pane', 'detail');
    syncNoteLayout(next, PLAIN_BODY);
    expect(pane.hasAttribute('data-pkc-page-format')).toBe(false);
    expect(pane.getAttribute('style') ?? '').toBe('');
  });

  it('clearNoteLayout は全部外す', () => {
    applyPrintLayout(document.documentElement, true);
    syncNoteLayout(pane, '---\npage_format: 43\npage_columns: 2\npage_font: mono\n---\n');
    clearNoteLayout(pane);
    expect(pane.attributes.length).toBe(1);
    expect(pane.getAttribute('style') ?? '').toBe('');
  });
});

describe('印刷レイアウト表示', () => {
  it('🔴 既定は切。選ぶと <html> に印が付いて保存され、切に戻すと鍵ごと消える', () => {
    const root = document.documentElement;
    expect(initialPrintLayout()).toBe(false);
    expect(isPrintLayoutOn(root)).toBe(false);
    choosePrintLayout(root, true);
    expect(root.getAttribute(PRINT_LAYOUT_ATTR)).toBe('1');
    expect(localStorage.getItem(PRINT_LAYOUT_STORAGE_KEY)).toBe('1');
    expect(initialPrintLayout()).toBe(true);
    expect(togglePrintLayout(root)).toBe(false);
    expect(root.hasAttribute(PRINT_LAYOUT_ATTR)).toBe(false);
    expect(localStorage.getItem(PRINT_LAYOUT_STORAGE_KEY)).toBeNull();
  });

  it('🔴 入のとき紙の寸法の変数が器に当たる(ノートの用紙・余白から)。切で外れる', () => {
    const root = document.documentElement;
    syncNoteLayout(pane, LAYOUT_BODY);
    expect(pane.style.getPropertyValue('--pkc-paper-w')).toBe('');
    choosePrintLayout(root, true); // refreshNoteLayout で当て直る
    expect(pane.style.getPropertyValue('--pkc-paper-w')).toBe('297mm');
    expect(pane.style.getPropertyValue('--pkc-paper-h')).toBe('210mm');
    expect(pane.style.getPropertyValue('--pkc-paper-pad')).toBe('30mm');
    expect(pane.hasAttribute(PAPER_FALLBACK_ATTR)).toBe(false);
    choosePrintLayout(root, false);
    expect(pane.style.getPropertyValue('--pkc-paper-w')).toBe('');
    expect(pane.style.getPropertyValue('--pkc-paper-pad')).toBe('');
  });

  it('画面用の用紙は A4 縦を紙の基準にし、余白の指定が無ければ標準(20mm)', () => {
    applyPrintLayout(document.documentElement, true);
    applyPageFormat(document.documentElement, 'fullhd');
    syncNoteLayout(pane, PLAIN_BODY);
    expect(pane.style.getPropertyValue('--pkc-paper-w')).toBe('210mm');
    expect(pane.style.getPropertyValue('--pkc-paper-h')).toBe('297mm');
    expect(pane.style.getPropertyValue('--pkc-paper-pad')).toBe('20mm');
    expect(pane.hasAttribute(PAPER_FALLBACK_ATTR)).toBe(true);
  });

  it('段数が 2 以上のときだけ紙の中の段数が当たる(アプリの設定でもノートの指定でも)', () => {
    const root = document.documentElement;
    applyPrintLayout(root, true);
    syncNoteLayout(pane, PLAIN_BODY);
    expect(pane.hasAttribute(SHEET_COLS_ATTR)).toBe(false);
    applyReadColumns(root, '2');
    refreshNoteLayout();
    expect(pane.getAttribute(SHEET_COLS_ATTR)).toBe('2');
    expect(pane.style.getPropertyValue('--pkc-sheet-cols')).toBe('2');
    syncNoteLayout(pane, '---\npage_columns: 4\n---\n');
    expect(pane.getAttribute(SHEET_COLS_ATTR)).toBe('4');
  });

  it('切替ボタンの見た目(aria-pressed と字)は当てた側が揃える', () => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'toggle-print-layout');
    document.body.append(b);
    paintPrintLayoutButton(b, false);
    expect(b.getAttribute('aria-pressed')).toBe('false');
    expect(b.textContent).toBe('通常表示');
    applyPrintLayout(document.documentElement, true);
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(b.textContent).toBe('印刷レイアウト');
  });
});

describe('noteLayoutBodyOf', () => {
  const metas = new Map([
    ['n1', { lid: 'n1', archetype: 'text' }],
    ['f1', { lid: 'f1', archetype: 'folder' }],
  ]);
  const st = (selectedLid: string | null, open: { lid: string; body: string } | null): AppState =>
    ({ selectedLid, openBody: open, entryMetas: metas }) as unknown as AppState;
  it('選んでいるノートの本文が届いているときだけ返す。フォルダ・別のノートの本文は null', () => {
    expect(noteLayoutBodyOf(st('n1', { lid: 'n1', body: 'x' }))).toBe('x');
    expect(noteLayoutBodyOf(st('n1', { lid: 'n2', body: 'x' }))).toBeNull();
    expect(noteLayoutBodyOf(st('n1', null))).toBeNull();
    expect(noteLayoutBodyOf(st(null, null))).toBeNull();
    expect(noteLayoutBodyOf(st('f1', { lid: 'f1', body: '' }))).toBeNull();
  });
});
