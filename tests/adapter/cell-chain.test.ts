/** @vitest-environment happy-dom */
/**
 * 🔴 **表の升を `Tab` / `Enter` で続けて打っても、確定が断られない**(#1087 / #750 I1)。
 *
 * 隣の欄は前の升の書き戻しを待たずに開くので、`openLine` に**書き戻し前の行**を掴む。
 * 自分が直前に書いた行を先へ進めて数える(`shownCellLine` / `noteCellWrite`)ことで断られなくなる。
 * ⚠ 別の窓が行を足した形(画面の本文が古いまま)は**断るまま**でなければならない ──
 *   その門は `body-rewrite-open-line.test.ts` が見る。ここは「自分の書換だけが数えられる」ことを見る。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState, type UserAction } from '../../src/adapter/state/app-state';
import {
  noteCellWrite,
  noteShapeWrite,
  resetCellChains,
  shownCellLine,
} from '../../src/adapter/state/shown-line';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const BODY = '# 在庫\n\n| 品名 | 数 |\n|---|---|\n| a | b |\n| c | d |\n';
const LINE = 4;
const L0 = '| a | b |';

const stateOf = (body: string, lid = 'e1'): AppState => ({
  ...initialState,
  openBody: { lid, body, baseline: body, persisted: body, diskAhead: false },
});

beforeEach(() => resetCellChains());

describe('shownCellLine / noteCellWrite ── 自分が書いた行を先へ進める', () => {
  it('🔴 書き戻しが届く前でも、隣の升は「自分が書いた後の行」を openLine にする', () => {
    const s = stateOf(BODY); // 画面は書く前のまま
    expect(shownCellLine(s, 'e1', LINE, 0), '対照群(何も書いていない)').toBe(L0);
    noteCellWrite(s, 'e1', { line: LINE, openLine: L0, col: 0, value: 'りんご' }, 0);
    expect(shownCellLine(s, 'e1', LINE, 10)).toBe('| りんご | b |');
  });

  it('🔴 予測は disk に実際に書かれる行と一致する(書換そのもので出している)', () => {
    const s = stateOf(BODY);
    const rw = { line: LINE, openLine: L0, col: 0, value: 'りんご' };
    noteCellWrite(s, 'e1', rw, 0);
    const disk = applyBodyRewrite(BODY, { kind: 'csv-cell', ...rw });
    expect(disk, '前提が崩れている(書換が断られた)').not.toBeNull();
    expect(shownCellLine(s, 'e1', LINE, 1)).toBe(disk!.split('\n')[LINE]);
  });

  it('🔴 続けて 2 つ書くと 2 つぶん進む / 書き戻しが 1 つ届いた後でも末尾を使う', () => {
    const s = stateOf(BODY);
    noteCellWrite(s, 'e1', { line: LINE, openLine: L0, col: 0, value: 'りんご' }, 0);
    const mid = shownCellLine(s, 'e1', LINE, 1)!;
    noteCellWrite(s, 'e1', { line: LINE, openLine: mid, col: 1, value: '3' }, 2);
    expect(shownCellLine(s, 'e1', LINE, 3)).toBe('| りんご | 3 |');
    // 1 つ目の書き戻しだけ届いた画面
    const half = stateOf(BODY.replace(L0, '| りんご | b |'));
    expect(shownCellLine(half, 'e1', LINE, 4)).toBe('| りんご | 3 |');
  });

  it('🔴 画面の行が、覚えている列のどれでもなければ、画面の行をそのまま使う(別の窓が行を足した形)', () => {
    const s = stateOf(BODY);
    noteCellWrite(s, 'e1', { line: LINE, openLine: L0, col: 0, value: 'りんご' }, 0);
    const other = stateOf(BODY.replace(L0, '| x | y |'));
    expect(shownCellLine(other, 'e1', LINE, 1)).toBe('| x | y |');
    // 列は捨てられている ── 画面が元の行に戻っても、もう進めない
    expect(shownCellLine(s, 'e1', LINE, 2)).toBe(L0);
  });

  it('🔴 古い予測は使い続けない(書き戻しが来なかった回)', () => {
    const s = stateOf(BODY);
    noteCellWrite(s, 'e1', { line: LINE, openLine: L0, col: 0, value: 'りんご' }, 0);
    expect(shownCellLine(s, 'e1', LINE, 60_000)).toBe(L0);
  });

  it('openLine が列の末尾でなければ覚えない / 別の行・別のノートへは効かない', () => {
    const s = stateOf(BODY);
    noteCellWrite(s, 'e1', { line: LINE, openLine: '| 別 | 物 |', col: 0, value: 'x' }, 0);
    expect(shownCellLine(s, 'e1', LINE, 1)).toBe(L0);
    noteCellWrite(s, 'e1', { line: LINE, openLine: L0, col: 0, value: 'りんご' }, 2);
    expect(shownCellLine(s, 'e1', LINE + 1, 3)).toBe('| c | d |');
    expect(shownCellLine(stateOf(BODY, 'e2'), 'e2', LINE, 3)).toBe(L0);
  });
});

/**
 * 🔴 **表の行・列の足し引きも、自分が直前に書いた行を数える**(#1087)。
 *
 * 列を足すとその行の字が変わる。書き戻しが画面に届く前に(ダブルクリックなど)もう一度押すと、
 * 画面の行は書く前のままで `openLine` が disk と食い違い、2 度目が断られる ── 升の `Tab` と同じ形。
 * ⚠ 行を**消す**回は覚えない:消した行の番号は次の行の字になるので、覚えると二度押しが**続けて 2 行消す**。
 */
describe('noteShapeWrite ── 行・列の足し引きを続けて押す', () => {
  const CSV = '```csv\na,b\nc,d\n```\n';
  const shape = (over: Partial<{ line: number; openLine: string; col: number; what: 'row' | 'col'; mode: 'add' | 'remove' }>) => ({
    line: 1,
    openLine: 'a,b',
    col: 0,
    what: 'col' as const,
    mode: 'add' as const,
    ...over,
  });

  it('🔴 列を足した直後(書き戻し前)の二度押しは、足した後の行を openLine にする', () => {
    const s = stateOf(CSV);
    expect(shownCellLine(s, 'e1', 1, 0), '対照群(何も書いていない)').toBe('a,b');
    noteShapeWrite(s, 'e1', shape({}), 0);
    // 予測は disk に実際に書かれる行と一致する(書換そのもので出している)
    const disk = applyBodyRewrite(CSV, { kind: 'csv-shape', ...shape({}) })!;
    expect(shownCellLine(s, 'e1', 1, 1)).toBe(disk.split('\n')[1]);
    expect(shownCellLine(s, 'e1', 1, 1)).toBe('a,,b');
  });

  it('🔴 列の足し引きは他の行も変える ── 表の全行の予測を覚える', () => {
    const s = stateOf(CSV);
    noteShapeWrite(s, 'e1', shape({}), 0);
    expect(shownCellLine(s, 'e1', 2, 1), '押していない行の予測が無い').toBe('c,,d');
    // 対照群:行を足す回は他の行の番号がずれるので、他の行は覚えない
    resetCellChains();
    noteShapeWrite(s, 'e1', shape({ what: 'row' }), 0);
    expect(shownCellLine(s, 'e1', 2, 1)).toBe('c,d');
  });

  it('🔴 行を消す回は覚えない(二度押しが続けて 2 行消さない)', () => {
    const s = stateOf(CSV);
    noteShapeWrite(s, 'e1', shape({ what: 'row', mode: 'remove' }), 0);
    expect(shownCellLine(s, 'e1', 1, 1), '消した行の番号に、次の行の予測を載せた').toBe('a,b');
    // 対照群:行を足す回は押した行の字が変わらないので、そのまま
    noteShapeWrite(s, 'e1', shape({ what: 'row', mode: 'add' }), 2);
    expect(shownCellLine(s, 'e1', 1, 3)).toBe('a,b');
  });

  it('断られる書換(最後の列を消す)や、openLine が列の末尾でない回は覚えない', () => {
    const one = stateOf('```csv\na\nb\n```\n');
    noteShapeWrite(one, 'e1', shape({ openLine: 'a', mode: 'remove' }), 0);
    expect(shownCellLine(one, 'e1', 1, 1)).toBe('a');
    const s = stateOf(CSV);
    noteShapeWrite(s, 'e1', shape({ openLine: '別の字' }), 0);
    expect(shownCellLine(s, 'e1', 1, 1)).toBe('a,b');
  });
});

describe('binder ── Tab で隣の升へ移って続けて打つ', () => {
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
  let d: Dispatcher;
  let sent: UserAction[];

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.append(root);
    d = new Dispatcher();
    bindActions(root, d, { settle: () => Promise.resolve() });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: BODY });
    sent = [];
    const raw = d.dispatch.bind(d);
    d.dispatch = ((a: UserAction) => {
      sent.push(a);
      return raw(a);
    }) as typeof d.dispatch;
    const block = document.createElement('div');
    block.className = 'pkc-md-block';
    for (const [col, text] of [
      [0, 'a'],
      [1, 'b'],
    ] as const) {
      const td = document.createElement('td');
      td.setAttribute('data-pkc-action', 'edit-cell');
      td.setAttribute('data-pkc-cell-line', String(LINE));
      td.setAttribute('data-pkc-cell-col', String(col));
      td.setAttribute('data-pkc-cell-raw', text);
      td.textContent = text;
      block.append(td);
    }
    root.append(block);
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('🔴 a を確定して Tab → 書き戻しが届く前に b を確定しても、b の openLine は a の書換後の行', () => {
    const cells = root.querySelectorAll<HTMLElement>('td');
    cells[0]!.click();
    const first = cells[0]!.querySelector<HTMLInputElement>('input')!;
    first.value = 'りんご';
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const second = cells[1]!.querySelector<HTMLInputElement>('input');
    expect(second, '前提が崩れている(Tab で隣の欄が開いていない)').not.toBeNull();
    second!.value = '3';
    second!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const w = sent.filter(
      (a): a is Extract<UserAction, { type: 'SET_CSV_CELL' }> => a.type === 'SET_CSV_CELL',
    );
    expect(w.map((a) => [a.col, a.openLine])).toEqual([
      [0, L0],
      [1, '| りんご | b |'],
    ]);
  });
});
