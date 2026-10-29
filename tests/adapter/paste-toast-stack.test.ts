/** @vitest-environment happy-dom */
/**
 * 🔴 貼付トースト(#1379)の置き場 ── **状態バーと同じ入れ物(`status-stack`)の中で、状態バーの真上**。
 * 浮かせて高さを当てる形だと、バーが 2 行に折り返す / 文字を大きくすると重なった。入れ物を基準に bottom: 100% で置けば重ならず、流れの外なので本文の領域も動かない(実測は paste-text の smoke)。
 * 観測点: ①トーストの親が grid の `status` の行を持つ入れ物 ②状態バーより前(真上) ③入れ物が shell の直下で、状態バーは入れ物の中
 * ④浮かせる規則(`position: fixed`)が CSS に残っていない。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildShell } from '../../src/adapter/ui/render/shell';

function pasteEvent(data: Record<string, string>): Event {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: { items: [], getData: (t: string) => data[t] ?? '' },
  });
  return e;
}

describe('貼付トーストの置き場(状態バーの真上に置く)', () => {
  it('🔴 トーストは status-stack の先頭 = 状態バーの真上に出て、状態バーも同じ入れ物の中にある', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const regions = buildShell(root);
    bindActions(root, new Dispatcher(), {});
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'row-source');
    regions.detail.append(ta);
    ta.dispatchEvent(pasteEvent({ 'text/html': '<h2>見出し</h2>', 'text/plain': '見出し' }));

    const toast = root.querySelector<HTMLElement>('[data-pkc-region="paste-toast"]');
    expect(toast, 'トーストが出ていない').not.toBeNull();
    const stack = root.querySelector<HTMLElement>('[data-pkc-region="status-stack"]')!;
    expect(stack, '入れ物が無い').not.toBeNull();
    expect(toast!.parentElement, 'トーストが入れ物の外にある').toBe(stack);
    expect(regions.status.parentElement, '状態バーが入れ物の中にない').toBe(stack);
    expect(toast!.nextElementSibling, 'トーストが状態バーの直前(真上)でない').toBe(regions.status);
    expect(stack.parentElement?.getAttribute('data-pkc-region'), '入れ物は shell の直下').toBe('shell');
  });

  it('CSS: 入れ物が grid の status の行を持ち基準になり、トーストは流れの外で真上に置く', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\[data-pkc-region='status-stack'\]\s*\{\s*grid-area:\s*status;/);
    const toast = css.match(/\[data-pkc-region='paste-toast'\]\s*\{[^}]*\}/)![0];
    expect(toast, '浮かせる規則が残っている').not.toMatch(/position:\s*fixed/);
    expect(toast, '入れ物の真上(bottom: 100%)に置いていない').toMatch(/position:\s*absolute/);
    expect(toast).toMatch(/inset-block-end:\s*100%/);
    const stack = css.match(/\[data-pkc-region='status-stack'\]\s*\{[^}]*\}/)![0];
    expect(stack, '入れ物が基準(relative)になっていない').toMatch(/position:\s*relative/);
  });
});
