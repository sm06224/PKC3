/** @vitest-environment happy-dom */
/**
 * 🔴 **Ctrl+Shift+V で貼ったときは、何も直さず書式なしの字だけを入れる**(台帳 #1852 / 依頼 93-1。Gemini 回答 = 推薦 A)。
 * 各項に**対照群**(鍵を押さない貼付は直す)を置く。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { isPlainPasteChord } from '../../src/features/markdown/paste-source';

function pasteEvent(data: Readonly<Record<string, string>>): Event {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: { items: [], getData: (type: string) => data[type] ?? '' },
  });
  return e;
}

const HTML = { 'text/html': '<b>x</b>', 'text/plain': 'x' };

function setup(): { root: HTMLElement; ta: HTMLTextAreaElement } {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.innerHTML = '<div data-pkc-region="detail"><textarea data-pkc-field="row-source"></textarea></div>';
  document.body.append(root);
  bindActions(root, new Dispatcher(), {});
  const ta = root.querySelector<HTMLTextAreaElement>('textarea')!;
  return { root, ta };
}

const key = (init: KeyboardEventInit): KeyboardEvent =>
  new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

describe('書式なしで貼る鍵(依頼 93-1)', () => {
  it('判定: Ctrl/⌘ + Shift + V だけ。Shift なし・Alt つきは違う', () => {
    const base = { key: 'V', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false };
    expect(isPlainPasteChord(base)).toBe(true);
    expect(isPlainPasteChord({ ...base, key: 'v', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isPlainPasteChord({ ...base, shiftKey: false })).toBe(false);
    expect(isPlainPasteChord({ ...base, altKey: true })).toBe(false);
    expect(isPlainPasteChord({ ...base, key: 'c' })).toBe(false);
  });

  it('対照群: 鍵を押さずに HTML を貼ると Markdown に直す', () => {
    const { ta } = setup();
    const e = pasteEvent(HTML);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '対照群が直していない ── 以下は空振り').toBe(true);
    expect(ta.value).toContain('**x**');
  });

  it('Ctrl+Shift+V の直後の貼付は直さない(ブラウザの書式なしの貼付に任せる)', () => {
    const { ta } = setup();
    ta.dispatchEvent(key({ key: 'V', ctrlKey: true, shiftKey: true }));
    const e = pasteEvent(HTML);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(ta.value).toBe('');
  });

  it('⌘+Shift+V(Mac)も同じ', () => {
    const { ta } = setup();
    ta.dispatchEvent(key({ key: 'v', metaKey: true, shiftKey: true }));
    const e = pasteEvent(HTML);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('印は 1 回の貼付で使い切る(次の普通の貼付は直す)', () => {
    const { ta } = setup();
    ta.dispatchEvent(key({ key: 'V', ctrlKey: true, shiftKey: true }));
    ta.dispatchEvent(pasteEvent(HTML));
    const e2 = pasteEvent(HTML);
    ta.dispatchEvent(e2);
    expect(e2.defaultPrevented).toBe(true);
    expect(ta.value).toContain('**x**');
  });

  it('Ctrl+V(Shift なし)は直す', () => {
    const { ta } = setup();
    ta.dispatchEvent(key({ key: 'v', ctrlKey: true }));
    const e = pasteEvent(HTML);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
