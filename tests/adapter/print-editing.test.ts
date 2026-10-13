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
