/** @vitest-environment happy-dom */
/**
 * 🔴 補完の小窓の非同期の候補(#2001 段 4)── 応答が前後して返っても、古い応答は出ない(世代の 1 本の守り)。
 */
import { describe, expect, it } from 'vitest';
import { bindInlineComplete, type CompleteItem } from '../../src/adapter/ui/render/inline-complete';

const REGION = '[data-pkc-region="inline-complete"]';

function setup() {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.innerHTML = '<div data-pkc-region="detail"><textarea data-pkc-field="editor-body"></textarea></div>';
  document.body.append(root);
  const ta = root.querySelector('textarea')!;
  const pending = new Map<string, (v: readonly CompleteItem[]) => void>();
  const unbind = bindInlineComplete(root, {
    items: (trigger) =>
      new Promise<readonly CompleteItem[]>((r) => {
        pending.set(trigger.query, r);
      }),
  });
  const type = (v: string): void => {
    ta.focus();
    ta.value = v;
    ta.setSelectionRange(v.length, v.length);
    ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };
  const rows = (): string[] =>
    [...root.querySelectorAll(`${REGION} [data-pkc-field="inline-complete-item"]`)].map((r) => r.firstElementChild?.textContent ?? '');
  const item = (t: string): CompleteItem => ({ title: t, accept: () => undefined });
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return { ta, type, rows, pending, item, tick, unbind, menu: () => root.querySelector(REGION) };
}

describe('非同期の候補の応答が前後する', () => {
  it('古い問い合わせの応答が、新しい応答のあとに返っても捨てる(新しい一覧が残る)', async () => {
    const s = setup();
    s.type('(asset:a');
    s.type('(asset:ab');
    expect([...s.pending.keys()]).toEqual(['a', 'ab']);
    s.pending.get('ab')!([s.item('新')]);
    await s.tick();
    expect(s.rows()).toEqual(['新']);
    s.pending.get('a')!([s.item('古')]); // 遅れて返る
    await s.tick();
    expect(s.rows(), '古い応答が新しい一覧を上書きした').toEqual(['新']);
    s.unbind();
  });

  it('応答を待つ間に閉じた(Esc)/ 欄を離れたら、あとから返っても出ない', async () => {
    const s = setup();
    s.type('(asset:a');
    s.ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    s.pending.get('a')!([s.item('x')]);
    await s.tick();
    expect(s.menu(), '閉じたあとに出た').toBeNull();
    s.unbind();
  });
});
