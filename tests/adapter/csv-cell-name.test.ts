/** @vitest-environment happy-dom */
/**
 * 🔴 **升を打っている間だけ、その升の名前(`B2`)を小さく出す**(#1662 4。Gemini 裁定 = #1163 依頼 48 の 4 = A)。
 *
 * 直す前は、式を `=B2*C2` と書くのに、どの列が B でどの行が 2 かは数えるしか無かった。
 * ⚠ 面は本物の描画(`renderMarkdown`)から組む ── 行の番号を焼くのは描画の側なので、手で組んだ升では見えない。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { cellName } from '../../src/features/markdown/csv-formula';

const BODY = '```csv-render noheader\n品名,単価,数\nりんご,100,3\nみかん,80,5\n```\n';
const MD = '| 品名 | 単価 |\n|---|---|\n| りんご | 100 |\n';

function setup(body: string) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML = '<div data-pkc-region="detail"><div data-pkc-field="detail-body"></div></div>';
  document.body.append(root);
  const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
  host.innerHTML = renderMarkdown(body, { sourceLineAnchors: true, taskLineOffset: 0, interactiveCells: true } as never);
  const metas = new Map([
    [
      'n1',
      {
        lid: 'n1',
        title: 'n1',
        archetype: 'text',
        createdAt: null,
        updatedAt: null,
        entryOrder: 1,
        status: null,
        date: null,
        archived: false,
      },
    ],
  ]) as unknown as AppState['entryMetas'];
  const d = new Dispatcher({
    ...initialState,
    cid: 'c1',
    phase: 'ready',
    selectedLid: 'n1',
    entryMetas: metas,
    openBody: { lid: 'n1', body, baseline: body, persisted: body, diskAhead: false },
  });
  bindActions(root, d, {});
  return { host };
}

const nameOf = (host: HTMLElement): string | null =>
  host.querySelector('[data-pkc-field="cell-name"]')?.textContent ?? null;

describe('升の名前(#1662 4)', () => {
  it('🔴 csv の升を押して打っている間は、その升の名前(列の英字 + 行の番号)が出る', () => {
    const { host } = setup(BODY);
    const cells = [...host.querySelectorAll<HTMLElement>('td[data-pkc-action="edit-cell"]')];
    expect(cells.length, '前提が崩れている: 升が 9 つ描かれていない').toBe(9);
    // 2 行目(りんご,100,3)の 3 列目 = C2。⚠ 見出し無しの表では 1 行目が 1 行目
    cells[5]!.click();
    expect(nameOf(host)).toBe('C2');
    expect(host.querySelectorAll('[data-pkc-field="cell-name"]').length, '名前が 2 つ出た').toBe(1);
  });

  it('🔴 閉じたら消える(升の中身は元の字に戻り、名前の字が升の字に混ざらない)', () => {
    const { host } = setup(BODY);
    const cell = host.querySelectorAll<HTMLElement>('td[data-pkc-action="edit-cell"]')[4]!;
    const before = cell.textContent;
    cell.click();
    expect(nameOf(host)).toBe('B2');
    cell.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(nameOf(host), '閉じたのに名前が残っている').toBeNull();
    expect(cell.textContent).toBe(before);
  });

  it('⚠ markdown の表には出さない(式が無い)', () => {
    const { host } = setup(MD);
    const cell = host.querySelector<HTMLElement>('td[data-pkc-action="edit-cell"]');
    expect(cell, '前提が崩れている: markdown の升が押せる形で描かれていない').not.toBeNull();
    cell!.click();
    expect(host.querySelector('input'), '前提が崩れている: 欄が開いていない').not.toBeNull();
    expect(nameOf(host)).toBeNull();
  });

  it('名前の組み立ては式の読みの逆(26 列を越えても AA)', () => {
    expect(cellName(0, 0)).toBe('A1');
    expect(cellName(1, 25)).toBe('Z2');
    expect(cellName(0, 26)).toBe('AA1');
    expect(cellName(11, 701)).toBe('ZZ12');
    expect(cellName(0, 702)).toBe('AAA1');
  });
});
