/** @vitest-environment happy-dom */
/**
 * 編集中に刷っても、編集欄の中身を全部紙に出す(#1163 依頼 71-2)。
 *
 * 守る主張:
 * 1. 🔴 刷る直前に、欄の字をそのまま写した箱が欄の後ろに置かれる(字として ── HTML にならない)
 * 2. 🔴 刷り終えたら外れる(残さない)/ 編集していなければ何も置かない
 * 3. 🔴 紙では欄とプレビューを隠して写しを出し、画面では写しを出さない(`app.css`)
 * 4. 起動時に窓へ張られている(`main.ts`)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  clearPrintToc,
  preparePrintToc,
  PRINT_TOC_FIELD,
  clearEditorPrint,
  EDITOR_PRINT_FIELD,
  installEditorPrint,
  prepareEditorPrint,
} from '@adapter/ui/render/print-editing';

function editor(value: string): HTMLTextAreaElement {
  document.body.innerHTML = '';
  const split = document.createElement('div');
  split.setAttribute('data-pkc-region', 'editor-split');
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', 'editor-body');
  ta.value = value;
  const preview = document.createElement('div');
  preview.setAttribute('data-pkc-region', 'editor-preview');
  split.append(ta, preview);
  document.body.append(split);
  return ta;
}

const SEL = `[data-pkc-field="${EDITOR_PRINT_FIELD}"]`;

describe('編集中の印刷', () => {
  it('🔴 刷る直前に全文の写しを置き、刷り終えたら外す', () => {
    const long = Array.from({ length: 300 }, (_, i) => `行 ${i} <b>x</b>`).join('\n');
    const ta = editor(long);
    expect(prepareEditorPrint(document)).toBe(1);
    const copy = document.querySelector<HTMLElement>(SEL)!;
    expect(copy.previousElementSibling).toBe(ta);
    expect(copy.textContent).toBe(long);
    expect(copy.querySelector('b'), 'HTML として読まない').toBeNull();
    clearEditorPrint(document);
    expect(document.querySelector(SEL)).toBeNull();
  });

  it('🔴 窓の beforeprint / afterprint で置いて外す。2 度刷っても 1 つ', () => {
    editor('本文');
    const off = installEditorPrint(window);
    window.dispatchEvent(new Event('beforeprint'));
    window.dispatchEvent(new Event('beforeprint'));
    expect(document.querySelectorAll(SEL)).toHaveLength(1);
    window.dispatchEvent(new Event('afterprint'));
    expect(document.querySelector(SEL)).toBeNull();
    off();
    window.dispatchEvent(new Event('beforeprint'));
    expect(document.querySelector(SEL), '外したら張られていない').toBeNull();
  });

  it('編集していなければ何も置かない', () => {
    document.body.innerHTML = '<div class="pkc-md-rendered"><p>x</p></div>';
    expect(prepareEditorPrint(document)).toBe(0);
    expect(document.querySelector(SEL)).toBeNull();
  });

  it('🔴 紙では欄とプレビューを隠して写しを出す / 画面では写しを出さない', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    const firstMedia = css.indexOf('@media');
    const screen = css.slice(0, firstMedia);
    expect(screen).toMatch(/\n\[data-pkc-field='editor-print'\] \{\s*display: none;\s*\}/);
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toContain(
      "[data-pkc-region='editor-split']:has([data-pkc-field='editor-print']) [data-pkc-field='editor-body'],",
    );
    expect(print).toContain(
      "[data-pkc-region='editor-split']:has([data-pkc-field='editor-print']) [data-pkc-region='editor-preview'] {\n    display: none;",
    );
    expect(print).toMatch(/\[data-pkc-field='editor-print'\] \{\s*display: block;\s*white-space: pre-wrap;/);
  });

  it('起動時に窓へ張られている', () => {
    const main = readFileSync('src/main.ts', 'utf-8');
    expect(main).toContain('\n  installEditorPrint(window);\n');
  });
});

describe('紙の頭の目次(#1038 B1)', () => {
  const TOC = `[data-pkc-field="${PRINT_TOC_FIELD}"]`;
  function note(html: string): HTMLElement {
    document.body.innerHTML = `<div data-pkc-region="detail"><div data-pkc-field="detail-body" class="pkc-md-rendered">${html}</div></div>`;
    return document.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
  }

  it('🔴 見出しから目次を組み、本文の前に置く / 刷り終えたら外す(字だけ・編集ボタンは除く)', () => {
    const body = note('<h1>はじめに <button>✎</button></h1><p>x</p><h2>&lt;b&gt;背景</h2><h3>詳細</h3><h4>深い</h4>');
    expect(preparePrintToc(document)).toBe(3);
    const toc = document.querySelector<HTMLElement>(TOC)!;
    expect(toc.nextElementSibling).toBe(body);
    expect([...toc.querySelectorAll('li')].map((l) => [l.getAttribute('data-l'), l.textContent])).toEqual([
      ['1', 'はじめに'],
      ['2', '<b>背景'],
      ['3', '詳細'],
    ]);
    expect(toc.querySelector('b'), 'HTML として読まない').toBeNull();
    clearPrintToc(document);
    expect(document.querySelector(TOC)).toBeNull();
  });

  it('見出しが無ければ置かない / 本文が無ければ置かない / 2 度刷っても 1 つ', () => {
    note('<p>見出しなし</p>');
    expect(preparePrintToc(document)).toBe(0);
    expect(document.querySelector(TOC)).toBeNull();
    document.body.innerHTML = '';
    expect(preparePrintToc(document)).toBe(0);
    note('<h1>a</h1>');
    const off = installEditorPrint(window);
    window.dispatchEvent(new Event('beforeprint'));
    window.dispatchEvent(new Event('beforeprint'));
    expect(document.querySelectorAll(TOC)).toHaveLength(1);
    window.dispatchEvent(new Event('afterprint'));
    expect(document.querySelector(TOC), '刷り終えても残っている').toBeNull();
    off();
  });

  it('🔴 画面では出さず、紙(@media print)だけが出す / @media print は 1 つだけ', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    const screen = css.slice(0, css.indexOf('@media'));
    expect(screen).toMatch(/\n\[data-pkc-field='print-toc'\] \{\s*display: none;\s*\}/);
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toMatch(/\[data-pkc-field='print-toc'\] \{\s*display: block;/);
    expect(css.match(/@media print/g)).toHaveLength(1);
  });
});
