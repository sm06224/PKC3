/** @vitest-environment happy-dom */
/**
 * 🔴 **色の見本を押して色を選び直す**(#1224 段②)── 押した後の動き。
 *
 * - 押すと選ぶ窓(`<input type="color">`)が開き、**`change` で 1 回だけ**書く(`input` のたびに書かない)。
 * - 6 桁小文字の見本だけが押せる(属性を書き換えられても、そうでなければ何も開かない)。
 * - 編集中は**開く前に**断る(書けない窓を出さない)。断り文は他の本文の書換と同じ 1 本。
 * - 押した所から「どのノートの行か」を引く(横に留めた別のノートの見本が、開いているノートに効かない)。
 *
 * ⚠ 見本が焼く属性は `tests/features/body-rewrite-color.test.ts`(描く側と書く側の一致)。
 *   ここは**実物の描画結果**を DOM に置いて押す ── 属性を手で組まない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindActions } from '@adapter/ui/actions/binder';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { initialState, type AppState } from '@adapter/state/app-state';
import { renderMarkdown } from '@features/markdown/markdown-render';

function setup(body: string, state: Partial<AppState> = {}) {
  document.body.textContent = '';
  const host = document.createElement('div');
  document.body.append(host);
  host.innerHTML = renderMarkdown(body, { colorSwatches: true });
  const dispatch = vi.fn();
  const st = { ...initialState, selectedLid: 'a', phase: 'ready', ...state } as AppState;
  bindActions(host, { dispatch, getState: () => st } as unknown as Dispatcher, {});
  const swatches = [...host.querySelectorAll<HTMLElement>('[data-pkc-color-swatch]')];
  const picker = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>('input[data-pkc-field="color-pick"]');
  return { host, dispatch, swatches, picker };
}

const fire = (el: Element, type: 'input' | 'change'): void => {
  el.dispatchEvent(new Event(type, { bubbles: true }));
};

beforeEach(() => {
  document.body.textContent = '';
});
afterEach(() => {
  document.body.textContent = '';
});

describe('押すと選ぶ窓が開く(#1224)', () => {
  it('🔴 6 桁小文字の見本は role=button で、押すと今の色を持った選ぶ窓が開く', () => {
    const { swatches, picker } = setup('`#3b82f6`\n');
    expect(swatches[0]!.getAttribute('role')).toBe('button');
    expect(picker(), '押す前から窓が在る').toBeNull();
    swatches[0]!.click();
    const p = picker();
    expect(p, '押しても選ぶ窓が開かない(dead click)').not.toBeNull();
    expect(p!.type).toBe('color');
    expect(p!.value).toBe('#3b82f6');
  });

  it('🔴 押せるのは 6 桁小文字だけ ── 3 桁・大文字・8 桁は role=button でなく、押しても何も開かない', () => {
    const { swatches, picker } = setup('`#fff` `#3B82F6` `#3b82f680`\n');
    expect(swatches).toHaveLength(3);
    for (const sw of swatches) {
      expect(sw.getAttribute('role'), '押せない綴りが button になっている').toBeNull();
      sw.click();
    }
    expect(picker(), '押せない綴りで窓が開いた').toBeNull();
  });

  it('🔴 属性を書き換えられて 6 桁小文字でなくなっても、窓を開かない', () => {
    const { swatches, picker, dispatch } = setup('`#3b82f6`\n');
    swatches[0]!.setAttribute('data-pkc-color-value', '#3B82F6');
    swatches[0]!.click();
    expect(picker()).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('🔴 見本はキーボードでも押せる(Enter)', () => {
    const { swatches, picker } = setup('`#3b82f6`\n');
    expect(swatches[0]!.getAttribute('tabindex'), '巡回に入っていない').toBe('0');
    swatches[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(picker(), 'Enter で窓が開かない').not.toBeNull();
  });
});

describe('`change` で 1 回だけ書く(#1224)', () => {
  it('🔴 色を動かす間(input)は何も書かず、change で 1 回だけ、押した見本の行・番号・色で撃つ', () => {
    // 同じ色が 1 行に 2 つ ── 2 つ目を押す
    const { swatches, picker, dispatch } = setup('# 見出し\n\n`#3b82f6` と `#3b82f6`\n');
    swatches[1]!.click();
    const p = picker()!;
    p.value = '#112233';
    fire(p, 'input');
    p.value = '#223344';
    fire(p, 'input');
    expect(dispatch, 'input のたびに書いている').not.toHaveBeenCalled();
    p.value = '#334455';
    fire(p, 'change');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_COLOR_CODE',
      lid: 'a',
      line: 2,
      nth: 1,
      from: '#3b82f6',
      to: '#334455',
    });
    expect(picker(), '使い終わった窓が残っている').toBeNull();
  });

  it('🔴 同じ色を選んだとき・窓を閉じただけのときは、何も書かない', () => {
    const { swatches, picker, dispatch } = setup('`#3b82f6`\n');
    swatches[0]!.click();
    const p = picker()!;
    fire(p, 'change'); // 値は元のまま
    expect(dispatch, '同じ色なのに書いた').not.toHaveBeenCalled();
    swatches[0]!.click();
    // 取り消し(change が来ない)── 何も撃たない。次に押すときは前の窓を外して作り直す
    expect(document.querySelectorAll('input[data-pkc-field="color-pick"]')).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('断り方(#1224)', () => {
  it('🔴 編集中のノート自身の見本は、窓を開く前に断る(他の書換と同じ断り文)', () => {
    const { swatches, picker, dispatch } = setup('`#3b82f6`\n', {
      phase: 'editing',
      openBody: { lid: 'a', body: 'x', baseline: 'x', persisted: 'x', diskAhead: false },
    } as Partial<AppState>);
    swatches[0]!.click();
    expect(picker(), '書けないのに窓が開いた').toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0]![0] as { type: string; error: string };
    expect(call.type).toBe('OP_FAILED');
    expect(call.error).toContain('編集を終了してから');
    expect(call.error).toContain('色を直してください');
  });

  it('🔴 横に留めた別のノートの見本は、開いているノートではなく、その見本のノートへ撃つ', () => {
    const { host, dispatch } = setup('`#3b82f6`\n');
    const wrap = document.createElement('div');
    wrap.setAttribute('data-pkc-split-lid', 'other');
    wrap.append(...host.childNodes);
    host.append(wrap);
    wrap.querySelector<HTMLElement>('[data-pkc-color-swatch]')!.click();
    const p = document.querySelector<HTMLInputElement>('input[data-pkc-field="color-pick"]')!;
    p.value = '#000001';
    fire(p, 'change');
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SET_COLOR_CODE', lid: 'other' }),
    );
  });
});
