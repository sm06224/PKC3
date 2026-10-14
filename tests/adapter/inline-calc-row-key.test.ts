/** @vitest-environment happy-dom */
/**
 * 🔴 **鍵(Alt+Shift+C)「この行を計算する」を、1 面のライブ編集の行でも効かせる**(#1087 K2)。
 *
 * 直す前は `row-source` の門が `align-table` / 整える 5 つ / 字下げ / 入れ替えだけを受け、
 * `inline-calc` は書式の表(`FORMAT_OF`)に無いので **黙って何も起きなかった**。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function setup() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const status: string[] = [];
  bindActions(root, d, { showStatus: (t) => void status.push(t) }, new KeymapStore(fakeStorage()));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { root, status };
}

function field(root: HTMLElement, name: string, text: string) {
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', name);
  ta.value = text;
  root.append(ta);
  ta.focus();
  ta.setSelectionRange(text.length, text.length);
  return ta;
}

const press = (target: HTMLElement): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', {
    key: 'C',
    code: 'KeyC',
    altKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
};

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('この行を計算する(Alt+Shift+C)── 1 面のライブ編集の行', () => {
  it('🔴 計算できる行は、行の終わりに答えが入る', () => {
    const { root } = setup();
    const row = field(root, 'row-source', '1200*1.1');
    const ev = press(row);
    expect(ev.defaultPrevented, '鍵が捨てられた').toBe(true);
    expect(row.value).toBe('1200*1.1=1320');
  });

  it('🔴 計算できない行は、黙らず理由を 1 行出す', () => {
    const { root, status } = setup();
    const row = field(root, 'row-source', '2^3');
    press(row);
    expect(row.value, '字は変えない').toBe('2^3');
    expect(status).toEqual(['計算できませんでした(^ は計算に使えません)']);
  });

  it('🔑 対照群: 2 列の欄(editor-body)でも同じ答えになる', () => {
    const { root } = setup();
    const ta = field(root, 'editor-body', '1200*1.1');
    press(ta);
    expect(ta.value).toBe('1200*1.1=1320');
  });
});
