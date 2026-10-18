/** @vitest-environment happy-dom */
/**
 * 🔴 **Ctrl+Shift+V で貼ったときは、何も直さず書式なしの字だけを入れる**(台帳 #1852 / 依頼 93-1。Gemini 回答 = 推薦 A)。
 * 各項に**対照群**(鍵を押さない貼付は直す)を置く。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { isPlainPasteChord, PLAIN_PASTE_WINDOW_MS } from '../../src/features/markdown/paste-source';

function pasteEvent(data: Readonly<Record<string, string>>): Event {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: { items: [], getData: (type: string) => data[type] ?? '' },
  });
  return e;
}

const HTML = { 'text/html': '<b>x</b>', 'text/plain': 'x' };

function setup(services: Parameters<typeof bindActions>[2] = {}): { root: HTMLElement; ta: HTMLTextAreaElement } {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.innerHTML = '<div data-pkc-region="detail"><textarea data-pkc-field="row-source"></textarea></div>';
  document.body.append(root);
  bindActions(root, new Dispatcher(), services);
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

describe('鍵の判定の広がり(非ラテン配列・Mac の Option 併用)', () => {
  const base = { key: 'V', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false };
  it('物理キー KeyV でも書式なし(key が v にならない配列)', () => {
    expect(isPlainPasteChord({ ...base, key: 'М', code: 'KeyV' })).toBe(true);
    expect(isPlainPasteChord({ ...base, key: 'М' }), '対照群: code が無ければ別のキー').toBe(false);
    expect(isPlainPasteChord({ ...base, key: 'М', code: 'KeyC' })).toBe(false);
  });
  it('Mac の ⌘+Option+Shift+V も書式なし。対照群: Ctrl+Alt+Shift+V(AltGr と区別できない)は違う', () => {
    expect(isPlainPasteChord({ key: '◊', code: 'KeyV', ctrlKey: false, metaKey: true, shiftKey: true, altKey: true })).toBe(true);
    expect(isPlainPasteChord({ ...base, altKey: true })).toBe(false);
    expect(isPlainPasteChord({ key: 'v', ctrlKey: false, metaKey: true, shiftKey: false, altKey: true })).toBe(false);
  });
  it('配線: ⌘+Option+Shift+V の直後の貼付は直さない', () => {
    const { ta } = setup();
    ta.dispatchEvent(key({ key: '◊', code: 'KeyV', metaKey: true, altKey: true, shiftKey: true }));
    const e = pasteEvent(HTML);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('鍵の印の寿命(貼付のたびに入口で消費)', () => {
  afterEach(() => vi.useRealTimers());

  it('窓の外(許容時間を過ぎた貼付)は書式なし扱いにしない', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 18, 9, 0, 0));
    const { ta } = setup();
    ta.dispatchEvent(key({ key: 'V', ctrlKey: true, shiftKey: true }));
    vi.setSystemTime(new Date(2026, 9, 18, 9, 0, 0).getTime() + PLAIN_PASTE_WINDOW_MS + 500);
    const e = pasteEvent(HTML);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '窓の外なのに書式なし扱いだった').toBe(true);
    expect(ta.value).toContain('**x**');
  });

  it('対照群: 窓の内(許容時間以内)は書式なし扱い', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 18, 9, 0, 0));
    const { ta } = setup();
    ta.dispatchEvent(key({ key: 'V', ctrlKey: true, shiftKey: true }));
    vi.setSystemTime(new Date(2026, 9, 18, 9, 0, 0).getTime() + 500);
    const e = pasteEvent(HTML);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('🔴 Ctrl+Shift+V で画像だけを貼った後の普通の Ctrl+V は、書式なし扱いにならない', () => {
    const pasted: (readonly File[])[] = [];
    const { ta } = setup({
      pasteImages: async (files) => {
        pasted.push(files);
        return files.map(() => '![ず](asset:k1)');
      },
    });
    ta.dispatchEvent(key({ key: 'V', ctrlKey: true, shiftKey: true }));
    // 画像だけ(字なし)── routeFiles が先に処理する回
    const img = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(img, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }) }],
        getData: () => '',
      },
    });
    ta.dispatchEvent(img);
    expect(pasted.length, '前提: 画像の貼付が処理された').toBe(1);
    // 続けて普通の貼付 ── 印が残っていれば書式なし扱いで直らない
    ta.dispatchEvent(key({ key: 'v', ctrlKey: true }));
    const e = pasteEvent(HTML);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '画像の貼付で消費されなかった印が残っている').toBe(true);
  });
});
