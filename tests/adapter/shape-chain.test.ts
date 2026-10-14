/** @vitest-environment happy-dom */
/**
 * 🔴 **列の ＋ を続けて押しても、2 度目が断られない**(#1087)。
 *
 * 列を足すとその行の字が変わる。書き戻しが画面に届く前にもう一度押すと、画面の行は書く前のままで、
 * `openLine` が disk と食い違って断られる ── 升の `Tab`(`cell-chain.test.ts`)と同じ形なので、同じ仕組み
 * (`noteShapeWrite`)に乗せた。観測点は binder が撃つ `SET_CSV_SHAPE` の `openLine`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { UserAction } from '../../src/adapter/state/app-state';
import { resetCellChains } from '../../src/adapter/state/shown-line';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const CSV = '```csv\na,b\nc,d\n```\n';
const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

let root: HTMLElement;
let sent: UserAction[];

beforeEach(() => {
  resetCellChains();
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  bindActions(root, d, { settle: () => Promise.resolve() });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: CSV });
  sent = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: UserAction) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
});
afterEach(() => {
  document.body.innerHTML = '';
});

function button(what: 'row' | 'col', mode: 'add' | 'remove', line = 1): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.setAttribute('data-pkc-action', 'shape-cell');
  btn.setAttribute('data-pkc-cell-line', String(line));
  btn.setAttribute('data-pkc-cell-col', '0');
  btn.setAttribute('data-pkc-cell-what', what);
  btn.setAttribute('data-pkc-cell-mode', mode);
  root.append(btn);
  return btn;
}

const shapes = (): Array<Extract<UserAction, { type: 'SET_CSV_SHAPE' }>> =>
  sent.filter((a): a is Extract<UserAction, { type: 'SET_CSV_SHAPE' }> => a.type === 'SET_CSV_SHAPE');

describe('binder ── 列の ＋ を続けて押す', () => {
  it('🔴 書き戻しが届く前の 2 度目は、1 度目の書換後の行を openLine にする(断られない)', () => {
    const btn = button('col', 'add');
    btn.click();
    btn.click(); // 画面の本文はまだ書く前のまま
    expect(shapes().map((a) => a.openLine)).toEqual(['a,b', 'a,,b']);
  });

  it('🔴 行を消す × の二度押しは、2 度目も「画面に見えている行」のまま運ぶ(続けて 2 行消す形にしない)', () => {
    const btn = button('row', 'remove');
    btn.click();
    btn.click();
    // 1 度目で行 1 が消えた disk では、行 1 は `c,d`。画面は書く前のまま `a,b` ── 運ぶのも `a,b` なので
    // 書換側(`openLine` の突き合わせ)が 2 度目を断る
    expect(shapes().map((a) => a.openLine)).toEqual(['a,b', 'a,b']);
  });
});
