/** @vitest-environment happy-dom */
/**
 * 🔴 **コード・数式の中では貼付を変換しない**(#1087)。binder の配線を見る
 * (判定そのものは `tests/features/edit-assist-1087.test.ts`)。
 *
 * ⚠ 各項に**対照群**(外では変換される)を置く ── 置かないと、変換が元から起きない設定で緑になる。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function pasteEvent(data: Readonly<Record<string, string>>): Event {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: { items: [], getData: (type: string) => data[type] ?? '' },
  });
  return e;
}

function paste(value: string, caret: number, data: Record<string, string>, selEnd: number = caret) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.innerHTML =
    '<div data-pkc-region="detail"><textarea data-pkc-field="row-source"></textarea></div>';
  document.body.append(root);
  bindActions(root, new Dispatcher(), {});
  const ta = root.querySelector<HTMLTextAreaElement>('textarea')!;
  ta.value = value;
  ta.setSelectionRange(caret, selEnd);
  const e = pasteEvent(data);
  ta.dispatchEvent(e);
  return { e, ta };
}

const TSV = 'a\tb\nc\td';
const HTML = { 'text/html': '<b>x</b>', 'text/plain': 'x' };
const URL_ = { 'text/plain': 'https://example.com/' };

describe('コード・数式の中では貼付を変換しない(#1087)', () => {
  it('対照群: 普通の本文へ TSV を貼ると表の囲みになる', () => {
    const { e, ta } = paste('', 0, { 'text/plain': TSV });
    expect(e.defaultPrevented, '対照群が変換していない ── 以下は空振り').toBe(true);
    expect(ta.value).toContain('```tsv');
  });

  it('fence の中では TSV を囲みにしない(入れ子の fence を作らない)', () => {
    const v = '```\n';
    const { e, ta } = paste(v, v.length, { 'text/plain': TSV });
    expect(e.defaultPrevented).toBe(false);
    expect(ta.value).toBe(v);
  });

  it('対照群: 普通の本文へ HTML を貼ると markdown になる', () => {
    const { e, ta } = paste('', 0, HTML);
    expect(e.defaultPrevented).toBe(true);
    expect(ta.value).toContain('**x**');
  });

  it.each([
    ['fence', '```\n', 4],
    ['数式', '$$\n', 3],
    ['行内コード', 'a `', 3],
  ] as const)('%s の中では HTML を変換しない', (_n, v, caret) => {
    const { e } = paste(v, caret, HTML);
    expect(e.defaultPrevented).toBe(false);
  });

  it('対照群: 普通の本文で選んだ字へ URL を貼るとリンクになる', () => {
    const { e, ta } = paste('語', 0, URL_, 1);
    expect(e.defaultPrevented).toBe(true);
    expect(ta.value).toBe('[語](https://example.com/)');
  });

  it.each([
    ['fence', '```\n語\n```', 4, 5],
    ['行内コード', 'a `語`', 3, 4],
  ] as const)('%s の中で選んだ字へ URL を貼ってもリンクにしない', (_n, v, s, e2) => {
    const { e, ta } = paste(v, s, URL_, e2);
    expect(e.defaultPrevented).toBe(false);
    expect(ta.value).toBe(v);
  });
});
