/**
 * 🔴 **押したセルが入力欄になる**(#418 段①)── binder の側。
 *
 * ⚠ ここで見るのは「**押した所と起きることが一致するか**」である ──
 *   記法の側(何行目のセルか)は `tests/features/csv-cell.test.ts` が持つ。
 */
/** @vitest-environment happy-dom */
import { describe, expect, it, beforeEach } from 'vitest';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';

function fake(phase = 'ready') {
  const dispatched: Array<Record<string, unknown>> = [];
  return {
    dispatched,
    dispatcher: {
      getState: () => ({ phase, selectedLid: 'n1', openBody: null }),
      dispatch: (a: Record<string, unknown>) => dispatched.push(a),
    } as unknown as Dispatcher,
  };
}

/**
 * ⚠ **本物と同じ形にする**(2 稿目で直した)── 升には
 *   ①**描画済みの markdown**(`**太字**` は `<strong>`)②**行・列のボタン**が入る。
 *   1 稿目の fixture は「字だけの升」だったので、
 *   **`textContent` を原文として読む欠陥を 1 件も検出できなかった**
 *   (CLAUDE.md §2「fixture のゼロ件の次元は測っていない次元」)。
 */
function cellRoot(raw = 'あ', inner = 'あ'): { root: HTMLElement; cell: HTMLElement } {
  const root = document.createElement('div');
  root.innerHTML =
    '<table><tbody><tr>' +
    `<td data-pkc-action="edit-cell" data-pkc-cell-line="1" data-pkc-cell-col="0"` +
    ` data-pkc-cell-raw="${raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">` +
    `${inner}<button data-pkc-action="shape-cell" data-pkc-cell-line="1" data-pkc-cell-col="0"` +
    ' data-pkc-cell-what="row" data-pkc-cell-mode="add">＋</button></td>' +
    '<td data-pkc-action="edit-cell" data-pkc-cell-line="1" data-pkc-cell-col="1"' +
    ' data-pkc-cell-raw="い">い</td>' +
    '</tr></tbody></table>';
  document.body.appendChild(root);
  return { root, cell: root.querySelector('td')! };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('セルを押すと、そのセルだけが入力欄になる(#418 段①)', () => {
  const input = (cell: HTMLElement): HTMLInputElement | null =>
    cell.querySelector('[data-pkc-field="cell-input"]');

  it('🔴 押すと欄が出て、いまの字が入っている', () => {
    const { root, cell } = cellRoot();
    const { dispatcher } = fake();
    bindActions(root, dispatcher, {});
    cell.click();
    expect(input(cell), 'セルに欄が出ていない').not.toBeNull();
    expect(input(cell)!.value).toBe('あ');
  });

  it('🔴 周りのセルは表のまま(囲い丸ごとの欄を開かない)', () => {
    const { root, cell } = cellRoot();
    bindActions(root, fake().dispatcher, {});
    cell.click();
    const others = root.querySelectorAll('[data-pkc-field="cell-input"]');
    expect(others, '1 度に 2 つ以上の欄が出ている').toHaveLength(1);
    expect(root.querySelectorAll('td')[1]!.textContent).toBe('い');
  });

  it('🔴 Enter で確定すると、押した所の行と列で撃つ', () => {
    const { root, cell } = cellRoot();
    const { dispatcher, dispatched } = fake();
    bindActions(root, dispatcher, {});
    cell.click();
    input(cell)!.value = '品名';
    input(cell)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(dispatched).toEqual([
      { type: 'SET_CSV_CELL', lid: 'n1', line: 1, col: 0, value: '品名' },
    ]);
  });

  it('🔴 双方向 ── 字を消して確定すると、空で撃つ', () => {
    const { root, cell } = cellRoot();
    const { dispatcher, dispatched } = fake();
    bindActions(root, dispatcher, {});
    cell.click();
    input(cell)!.value = '';
    input(cell)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(dispatched).toEqual([{ type: 'SET_CSV_CELL', lid: 'n1', line: 1, col: 0, value: '' }]);
  });

  it('🔴 Escape は取り消し ── 撃たず、押す前の字に戻る', () => {
    const { root, cell } = cellRoot();
    const { dispatcher, dispatched } = fake();
    bindActions(root, dispatcher, {});
    cell.click();
    input(cell)!.value = 'まちがい';
    input(cell)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dispatched, '取り消したのに撃っている').toEqual([]);
    expect(cell.querySelector('button'), '戻したらボタンが消えた').not.toBeNull();
    expect(cell.textContent, '押す前の字に戻っていない').toContain('あ');
  });

  it('⚠ 変えずに閉じたら撃たない(更新日時だけ動かさない)', () => {
    const { root, cell } = cellRoot();
    const { dispatcher, dispatched } = fake();
    bindActions(root, dispatcher, {});
    cell.click();
    input(cell)!.dispatchEvent(new FocusEvent('blur'));
    expect(dispatched).toEqual([]);
  });

  it('🔴 Enter のあとの blur で二度撃たない', () => {
    const { root, cell } = cellRoot();
    const { dispatcher, dispatched } = fake();
    bindActions(root, dispatcher, {});
    cell.click();
    const el = input(cell)!;
    el.value = 'z';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur'));
    expect(dispatched).toHaveLength(1);
  });

  it('🔴 字を選んでいる最中は開かない(選んだ字を消さない)', () => {
    // ⚠ 押せるようにする前、升は**ただの字**だった ── ドラッグで選んでコピーできた。
    //    ドラッグの終わりにも click は飛ぶので、無条件に開くと選択がその瞬間に消える
    const { root, cell } = cellRoot();
    bindActions(root, fake().dispatcher, {});
    const range = document.createRange();
    range.selectNodeContents(cell);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(sel.isCollapsed, '前提: 選択が作れていない').toBe(false);
    cell.click();
    expect(input(cell), '選んでいる最中に欄が開いた(選択が消える)').toBeNull();
    // 🔑 対照群 ── 選択を解けば、これまでどおり開く
    sel.removeAllRanges();
    cell.click();
    expect(input(cell), '選択を解いても開かない').not.toBeNull();
  });

  it('🔴 編集中は断り、理由を出す(裏で本文を書き換えない)', () => {
    const { root, cell } = cellRoot();
    const { dispatcher, dispatched } = fake('editing');
    bindActions(root, dispatcher, {});
    cell.click();
    expect(input(cell), '編集中なのに欄が出た').toBeNull();
    expect(dispatched[0]).toMatchObject({ type: 'OP_FAILED' });
  });

  it('⚠ 2 度押しても欄を作り直さない(打ちかけの字を捨てない)', () => {
    const { root, cell } = cellRoot();
    bindActions(root, fake().dispatcher, {});
    cell.click();
    input(cell)!.value = '打ちかけ';
    cell.click();
    expect(input(cell)!.value, '打ちかけの字が消えた').toBe('打ちかけ');
  });
});

/**
 * 🔴 **行・列の口も、押した所をそのまま渡す**(#418 段①)。
 */
describe('行・列の口を押す(#418 段①)', () => {
  function shapeRoot(): { root: HTMLElement; btn: HTMLElement } {
    const root = document.createElement('div');
    root.innerHTML =
      '<table><tbody><tr><td data-pkc-action="edit-cell" data-pkc-cell-line="1" data-pkc-cell-col="0">あ' +
      '<button data-pkc-action="shape-cell" data-pkc-cell-line="1" data-pkc-cell-col="0"' +
      ' data-pkc-cell-what="row" data-pkc-cell-mode="add">＋</button>' +
      '</td></tr></tbody></table>';
    document.body.appendChild(root);
    return { root, btn: root.querySelector('button')! };
  }

  it('🔴 押すと、押した所の行・列・向きで撃つ', () => {
    const { root, btn } = shapeRoot();
    const { dispatcher, dispatched } = fake();
    bindActions(root, dispatcher, {});
    btn.click();
    expect(dispatched).toEqual([
      { type: 'SET_CSV_SHAPE', lid: 'n1', line: 1, col: 0, what: 'row', mode: 'add' },
    ]);
  });

  it('🔴 押しても、そのセルの入力欄は開かない(1 押しで 1 つのこと)', () => {
    const { root, btn } = shapeRoot();
    const { dispatcher, dispatched } = fake();
    bindActions(root, dispatcher, {});
    btn.click();
    expect(
      root.querySelector('[data-pkc-field="cell-input"]'),
      'ボタンを押したのにセルが編集に入った',
    ).toBeNull();
    expect(dispatched).toHaveLength(1);
  });

  it('🔴 編集中は断り、理由を出す', () => {
    const { root, btn } = shapeRoot();
    const { dispatcher, dispatched } = fake('editing');
    bindActions(root, dispatcher, {});
    btn.click();
    expect(dispatched[0]).toMatchObject({ type: 'OP_FAILED' });
  });

  it('⚠ 向きが読めない印は撃たない(壊れた属性で当てずっぽうに書かない)', () => {
    const { root, btn } = shapeRoot();
    btn.setAttribute('data-pkc-cell-what', 'diagonal');
    const { dispatcher, dispatched } = fake();
    bindActions(root, dispatcher, {});
    btn.click();
    expect(dispatched).toEqual([]);
  });
});

/**
 * 🔴 **升の字を読み取らない**(#418 段①の 2 稿目)。
 *
 * ⚠ 1 稿目は `target.textContent` を原文として読んでいた。実測すると:
 *   ① `**太字**` は `<strong>太字</strong>` に描かれるので **`**` が落ちる**
 *   ② 升には行・列のボタンが入るので **`＋` まで混ざる**
 *   どちらも「打ち直したら user の字が変わる」= 静かなデータ破壊である。
 */
describe('升の原文は、描いた側から受け取る(#418 段①)', () => {
  const input = (cell: HTMLElement): HTMLInputElement | null =>
    cell.querySelector('[data-pkc-field="cell-input"]');

  it('🔴 装飾のある升は、原文が欄に入る(描かれた字ではない)', () => {
    const { root, cell } = cellRoot('**太字**', '<strong>太字</strong>');
    bindActions(root, fake().dispatcher, {});
    cell.click();
    expect(input(cell)!.value, '描かれた字を原文として読んでいる').toBe('**太字**');
  });

  it('🔴 ボタンの字が原文に混ざらない', () => {
    const { root, cell } = cellRoot('あ', 'あ');
    // 前提 ── この升にはボタンが入っている(混ざりうる形である)
    expect(cell.textContent, '前提: ボタンが入っていない').toContain('＋');
    bindActions(root, fake().dispatcher, {});
    cell.click();
    expect(input(cell)!.value).toBe('あ');
  });

  it('🔴 装飾のある升を打ち直しても、他の字は巻き込まない', () => {
    const { root, cell } = cellRoot('**太字**', '<strong>太字</strong>');
    const { dispatcher, dispatched } = fake();
    bindActions(root, dispatcher, {});
    cell.click();
    input(cell)!.value = '**太字** と追記';
    input(cell)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(dispatched).toEqual([
      { type: 'SET_CSV_CELL', lid: 'n1', line: 1, col: 0, value: '**太字** と追記' },
    ]);
  });

  it('🔴 取り消すと、描かれていたものがそのまま戻る(装飾もボタンも)', () => {
    const { root, cell } = cellRoot('**太字**', '<strong>太字</strong>');
    bindActions(root, fake().dispatcher, {});
    cell.click();
    input(cell)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cell.querySelector('strong'), '装飾が消えた').not.toBeNull();
    expect(cell.querySelector('button'), 'ボタンが消えた').not.toBeNull();
  });

  it('⚠ 原文が無い升は押しても開かない(印を持たない升は触らない)', () => {
    const root = document.createElement('div');
    root.innerHTML = '<table><tbody><tr><td>ただの升</td></tr></tbody></table>';
    document.body.appendChild(root);
    const { dispatcher, dispatched } = fake();
    bindActions(root, dispatcher, {});
    root.querySelector('td')!.click();
    expect(root.querySelector('[data-pkc-field="cell-input"]')).toBeNull();
    expect(dispatched).toEqual([]);
  });
});
