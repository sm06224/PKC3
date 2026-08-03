/** @vitest-environment happy-dom */
/**
 * P7 段⑤: 更新の案内の面と、押されたときの動き。
 *
 * 🔴 ここは **smoke から観測できない**。押すと再読込が走るので、「押したら案内が
 * 消える」は消えていなくても次のページには無い ── 変異試験で実際に生き残った。
 * `main.ts` に直書きせず取り出したのはそのため。
 */
import { describe, expect, it, vi } from 'vitest';
import { createUpdatePrompt, showUpdateCard, clearUpdateCard } from '../../src/adapter/ui/render/update-card';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';

function region(): HTMLElement {
  const el = document.createElement('section');
  el.hidden = true;
  return el;
}

describe('更新の案内 — 面', () => {
  it('既定では出ていない(shell が作った時点で hidden)', () => {
    const root = document.createElement('div');
    const regions = buildShell(root);
    expect(regions.update.hidden).toBe(true);
    expect(regions.update.textContent).toBe('');
  });

  it('出すと「再読込」と「あとで」の導線が付く', () => {
    const el = region();
    showUpdateCard(el);
    expect(el.hidden).toBe(false);
    expect(el.querySelector('[data-pkc-action="apply-update"]')).not.toBeNull();
    expect(el.querySelector('[data-pkc-action="dismiss-update"]')).not.toBeNull();
    expect(el.querySelector('[data-pkc-field="update-text"]')?.textContent).toContain(
      '新しい版',
    );
  });

  it('閉じると面ごと消える(空の枠を残さない)', () => {
    const el = region();
    showUpdateCard(el);
    clearUpdateCard(el);
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe('');
  });
});

describe('更新の案内 — 押されたときの動き', () => {
  it('見せて、押すと交代を頼み、案内は消える', () => {
    const el = region();
    const prompt = createUpdatePrompt(el);
    const apply = vi.fn();
    prompt.present(apply);
    expect(el.hidden).toBe(false);

    prompt.apply();
    expect(apply).toHaveBeenCalledTimes(1);
    // 🔴 押した後に案内が残っていると、押せる導線が生きたまま再読込を待つ
    expect(el.hidden).toBe(true);
  });

  it('🔴 連打しても交代は一度きり', () => {
    const el = region();
    const prompt = createUpdatePrompt(el);
    const apply = vi.fn();
    prompt.present(apply);
    prompt.apply();
    prompt.apply();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('押されていないのに交代を頼まない', () => {
    const el = region();
    const prompt = createUpdatePrompt(el);
    const apply = vi.fn();
    prompt.present(apply);
    prompt.dismiss();
    expect(apply).not.toHaveBeenCalled();
    expect(el.hidden).toBe(true);
  });

  it('見せる前に押されても落ちない', () => {
    const prompt = createUpdatePrompt(region());
    expect(() => prompt.apply()).not.toThrow();
  });
});

describe('🔴 配線 — click が services へ届く', () => {
  it('「再読込」/「あとで」が binder 経由で呼ばれる', () => {
    // ⚠ 面と services が**実際につながっているか**は、どちらの unit も見ていない
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const dispatcher = new Dispatcher();
    const applyUpdate = vi.fn();
    const dismissUpdate = vi.fn();
    bindActions(root, dispatcher, { applyUpdate, dismissUpdate });

    showUpdateCard(regions.update);
    regions.update
      .querySelector<HTMLElement>('[data-pkc-action="apply-update"]')!
      .click();
    expect(applyUpdate).toHaveBeenCalledTimes(1);

    regions.update
      .querySelector<HTMLElement>('[data-pkc-action="dismiss-update"]')!
      .click();
    expect(dismissUpdate).toHaveBeenCalledTimes(1);
    root.remove();
  });
});
