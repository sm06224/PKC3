/** @vitest-environment happy-dom */
/**
 * 🔴 **「作り直す・初期化する」の開閉の押し口は、開いたら「隠す」と言う**(#1087)。
 *
 * ⚠ 直す前は開いても「…を表示」のままで、押すと何が起きるかが字から読めなかった。
 * 守るもの:①実際に押して字が替わる(binder の受け手を通す)②もう一度押すと元に戻る
 * ③問題が見つかったとき開いた状態で出す口も同じ字になる(口は 2 か所 ── `binder.ts`)。
 * ⚠ 守っていないもの:「確認」の結果から開く経路そのものの実行(worker が要る ── smoke
 * `plan-apply.smoke.spec.ts` が実ブラウザで通す)。ここでは開く口(`setContainerRepairToggle`)を直に見る。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildSettingsCommands, setContainerRepairToggle } from '../../src/adapter/ui/render/commands';
import { buildShell } from '../../src/adapter/ui/render/shell';

const SHOW = '作り直す・初期化するボタンを表示';
const HIDE = '作り直す・初期化するボタンを隠す';

function setup(): { toggle: HTMLElement; box: HTMLElement } {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  buildShell(root);
  root.append(buildSettingsCommands());
  bindActions(root, new Dispatcher(), {});
  const toggle = root.querySelector<HTMLElement>('[data-pkc-action="toggle-container-repair"]')!;
  const box = root.querySelector<HTMLElement>('[data-pkc-field="container-repair-box"]')!;
  expect(toggle, '押し口が描かれていない(空振り)').not.toBeNull();
  expect(box, '箱が描かれていない(空振り)').not.toBeNull();
  return { toggle, box };
}

const labelOf = (toggle: HTMLElement): string =>
  toggle.querySelector('[data-pkc-field="label"]')?.textContent ?? '';

describe('作り直す・初期化するボタンの開閉の字(#1087)', () => {
  it('閉じているときは「表示」、押して開くと「隠す」、もう一度押すと「表示」に戻る', () => {
    const { toggle, box } = setup();
    expect(labelOf(toggle)).toBe(SHOW);
    expect(box.hidden).toBe(true);
    toggle.click();
    expect(box.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(labelOf(toggle)).toBe(HIDE);
    toggle.click();
    expect(box.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(labelOf(toggle)).toBe(SHOW);
  });

  it('開いた状態で出す口(問題が見つかったとき)も同じ字になる', () => {
    const { toggle } = setup();
    setContainerRepairToggle(toggle, true);
    expect(labelOf(toggle)).toBe(HIDE);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});
