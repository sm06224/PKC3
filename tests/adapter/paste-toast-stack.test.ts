/** @vitest-environment happy-dom */
/**
 * 🔴 貼付トースト(#1379)の置き場 ── **知らせの浮き札と同じ入れ物(`status-stack`)の中で、浮き札の真上**。
 * 2026-11-23 に常設のステータスバー(grid の行)を廃止した ── 入れ物は grid の**左の一覧のマスの左下に重ねる**縦の flex(行を持たない)で、トーストはその子として浮き札の上に積む(高さを当て推量しない。本文の領域も動かない。実測は paste-text の smoke)。
 * 観測点: ①トーストの親が入れ物 ②浮き札より前(真上) ③入れ物が shell の直下で、浮き札は入れ物の中 ④入れ物が専用の grid の行を持たず(`status` の区画が無い)、一覧のマス(`sidebar`)に重ねる。トーストは流れの中(`absolute` でない)で、× を持つ。
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

describe('貼付トーストの置き場(浮き札の真上に置く)', () => {
  it('🔴 トーストは status-stack の先頭 = 浮き札の真上に出て、浮き札も同じ入れ物の中にある', () => {
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
    expect(regions.status.parentElement, '浮き札が入れ物の中にない').toBe(stack);
    expect(toast!.nextElementSibling, 'トーストが浮き札の直前(真上)でない').toBe(regions.status);
    expect(stack.parentElement?.getAttribute('data-pkc-region'), '入れ物は shell の直下').toBe('shell');
  });

  it('CSS: 入れ物は専用の行を持たず本文のマスの右下(追記欄の真上)に重なり、トーストは流れの中で浮き札の上に積まれる(重ならない)', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    const stack = css.match(/\[data-pkc-region='status-stack'\]\s*\{[^}]*\}/)![0];
    expect(stack, '入れ物がまだ grid の status の行を持っている').not.toMatch(/grid-area:\s*status/);
    expect(stack, '入れ物が本文のマスに重なっていない(一覧・縦のバーの上に置かない)').toMatch(/grid-area:\s*detail/);
    expect(stack, '追記欄の丈(--pkc-toast-lift)ぶん上げていない').toMatch(/--pkc-toast-lift/);
    expect(stack, '入れ物が右下に寄っていない').toMatch(/align-self:\s*end/);
    expect(stack).toMatch(/justify-self:\s*end/);
    // 🔴 札の字は押しが通る(下の操作を妨げない)。触れるのはボタンだけ
    expect(css).toMatch(/\[data-pkc-region='status-stack'\] > \* \{\s*pointer-events: none;/);
    expect(css).toMatch(/\[data-pkc-region='status-stack'\] button \{\s*pointer-events: auto;/);
    const toast = css.match(/\[data-pkc-region='paste-toast'\]\s*\{[^}]*\}/)![0];
    expect(toast, 'トーストが入れ物の外へ浮いている').not.toMatch(/position:\s*(?:fixed|absolute)/);
    // grid の版面に status の行は無い
    expect(css).not.toMatch(/'status status/);
  });

  it('🔴 トーストにも × があり、押すと閉じる(消せない知らせを作らない)', () => {
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
    const toast = root.querySelector<HTMLElement>('[data-pkc-region="paste-toast"]')!;
    expect(toast).not.toBeNull();
    toast.querySelector<HTMLElement>('[data-pkc-field="paste-toast-close"]')!.click();
    expect(root.querySelector('[data-pkc-region="paste-toast"]'), '× で閉じていない').toBeNull();
  });
});
