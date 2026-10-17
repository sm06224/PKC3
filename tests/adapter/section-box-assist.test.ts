/** @vitest-environment happy-dom */
/**
 * 🔴 章だけを編集する欄にも、普通の編集欄と同じ入力の助けを効かせる(#1163 依頼 150。Gemini 回答は案どおり)。
 *
 * 直す前は、箇条書きの章を直していて Enter を押しても `- ` が続かず、行末の `=` の計算も、Tab の字下げも効かなかった
 * (太字などのショートカットキーと保存だけ効いていた)。ここが守るのは**配線**(規則そのものは `tests/features/*`)。
 * ⚠ 対照群 ── 助けが当たらない場面の Tab は素通し(欄から焦点が出ていける)/ 普通の文の Enter は改行のまま。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { SECTION_BOX_INPUT_FIELD, SECTION_BOX_REGION } from '../../src/adapter/ui/render/section-box';

beforeEach(() => {
  document.body.textContent = '';
});

function setup(): { root: HTMLElement } {
  const root = document.createElement('div');
  document.body.append(root);
  bindActions(root, new Dispatcher(), {});
  return { root };
}

/** 章の欄を 1 つ置く(`section-box.ts` の器と同じ印: 欄の名前 + 箱の region)。 */
function sectionInput(root: HTMLElement, value: string, caret: number = value.length): HTMLTextAreaElement {
  const box = document.createElement('div');
  box.setAttribute('data-pkc-region', SECTION_BOX_REGION);
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', SECTION_BOX_INPUT_FIELD);
  ta.value = value;
  box.append(ta);
  root.append(box);
  ta.setSelectionRange(caret, caret);
  return ta;
}

function key(ta: HTMLTextAreaElement, k: string, over: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...over });
  ta.dispatchEvent(ev);
  return ev;
}

describe('章の欄の Enter', () => {
  it('🔴 箇条書きの行で Enter → `- ` が続く / 空の `- ` で Enter → 抜けて空行が入る', () => {
    const { root } = setup();
    const ta = sectionInput(root, '- 牛乳');
    key(ta, 'Enter');
    expect(ta.value, '箇条書きが続いていない(章の欄に繋がっていない)').toBe('- 牛乳\n- ');
    key(ta, 'Enter');
    expect(ta.value).toBe('- 牛乳\n\n');
  });

  it('🔴 引用・番号付き・全角の字の項目でも同じ', () => {
    const { root } = setup();
    const q = sectionInput(root, '> 引用です。');
    key(q, 'Enter');
    expect(q.value).toBe('> 引用です。\n> ');
    const n = sectionInput(root, '1. 買い物（週末）');
    key(n, 'Enter');
    expect(n.value).toBe('1. 買い物（週末）\n2. ');
  });

  it('🔴 行末の `=` + Enter → 計算する(全角で打っていても半角へ直る)', () => {
    const { root } = setup();
    const a = sectionInput(root, '2+3=');
    key(a, 'Enter');
    expect(a.value).toBe('2+3=5');
    const b = sectionInput(root, '１２＋３＝');
    key(b, 'Enter');
    expect(b.value).toBe('12+3=15');
  });

  it('⚠ 対照群 ── 普通の文の Enter は触らない(ブラウザの改行に任せる)/ Shift+Enter は握らない', () => {
    const { root } = setup();
    const ta = sectionInput(root, 'ただの文');
    expect(key(ta, 'Enter').defaultPrevented).toBe(false);
    const li = sectionInput(root, '- 牛乳');
    expect(key(li, 'Enter', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(li.value).toBe('- 牛乳');
  });
});

describe('章の欄の Tab', () => {
  it('🔴 リストの行の Tab → 字下げ(入れ子)/ Shift+Tab → 戻す', () => {
    const { root } = setup();
    const ta = sectionInput(root, '- 牛乳');
    const ev = key(ta, 'Tab');
    expect(ev.defaultPrevented, '焦点が出ていった').toBe(true);
    expect(ta.value).toBe('  - 牛乳');
    key(ta, 'Tab', { shiftKey: true });
    expect(ta.value).toBe('- 牛乳');
  });

  it('🔴 表のセルの Tab → 次のセルへ移る', () => {
    const { root } = setup();
    const text = '| a | b |\n|---|---|\n| 1 | 2 |';
    const ta = sectionInput(root, text, text.indexOf('a'));
    const ev = key(ta, 'Tab');
    expect(ev.defaultPrevented).toBe(true);
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('b');
  });

  it('⚠ 対照群 ── 助けが当たらない行の Tab は握らない(焦点が欄から出ていける)', () => {
    const { root } = setup();
    const ta = sectionInput(root, 'ただの文');
    expect(key(ta, 'Tab').defaultPrevented, '欄から Tab で出られなくなった').toBe(false);
    expect(key(ta, 'Tab', { shiftKey: true }).defaultPrevented).toBe(false);
  });

  it('⚠ 太字などのショートカットキーと保存は、今までどおり効く', () => {
    const { root } = setup();
    const ta = sectionInput(root, 'あ');
    ta.setSelectionRange(0, 1);
    const ev = key(ta, 'b', { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(ta.value).toBe('**あ**');
  });
});
