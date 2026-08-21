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
  it('見せて、押すと交代を頼む', () => {
    const el = region();
    const prompt = createUpdatePrompt(el);
    const apply = vi.fn();
    prompt.present(apply);
    expect(el.hidden).toBe(false);

    prompt.apply();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('🔴 押した後は**面を残したまま**押せる導線だけ外す', () => {
    // review H-2: 面ごと消すと、交代が成立しなかったときに
    // 「押したのに何も起きず、導線だけ無くなった」になる ── 実際にその形を踏んだ
    const el = region();
    const prompt = createUpdatePrompt(el);
    prompt.present(vi.fn());
    prompt.apply();
    expect(el.hidden).toBe(false); // 面は残る
    expect(el.querySelector('[data-pkc-action="apply-update"]')).toBeNull(); // 導線は無い
    expect(el.querySelector('[data-pkc-field="update-text"]')?.textContent).toContain(
      '切り替えています',
    );
  });

  it('🔴 次の版が来たら、押せる案内に戻る(更新不能に落ちない)', () => {
    const el = region();
    const prompt = createUpdatePrompt(el);
    prompt.present(vi.fn());
    prompt.apply();
    const next = vi.fn();
    prompt.present(next); // 新しい worker ぶんの案内
    expect(el.querySelector('[data-pkc-action="apply-update"]')).not.toBeNull();
    prompt.apply();
    expect(next).toHaveBeenCalledTimes(1);
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

describe('🔴 編集中の下書きを確認なしで捨てない(review M-2)', () => {
  // 再読込は open editor の本文を捨てる(本文は AppState にしか無く、
  // `beforeunload` も無い)。案内は editor の隣に出る常設面なので誤クリックが起きうる。
  // ⚠ `delete-entry` / `purge-trash` と同じ倒し方(confirm)に揃える
  const editing = (initial: boolean) => {
    const el = region();
    const apply = vi.fn();
    let answer = initial;
    const prompt = createUpdatePrompt(el, {
      isEditing: () => true,
      confirmDiscard: async () => answer,
    });
    prompt.present(apply);
    return { el, apply, prompt, answer: (v: boolean) => (answer = v) };
  };

  it('編集中に押されたら聞く。断られたら**何も変えない**', async () => {
    const { el, apply, prompt, answer } = editing(false);
    // ⚠ 確認は**後から**返る(#299 段③)── await しないと「押した瞬間」を見てしまう
    await prompt.apply();
    expect(apply).not.toHaveBeenCalled();
    // ⚠ 面も導線も残る ── 断ったのに導線が消えると押し直せない
    expect(el.hidden).toBe(false);
    expect(el.querySelector('[data-pkc-action="apply-update"]')).not.toBeNull();
    // 🔴 **同じ prompt を**押し直せる ── ここで新しい prompt を作って試すと、
    // 「断ったときに pending を捨てる」変異に**救われる**(実際に生き残った)
    answer(true);
    await prompt.apply();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('編集中でも承諾されたら進む', async () => {
    const { apply, prompt } = editing(true);
    await prompt.apply();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('編集していなければ聞かない(毎回聞くと邪魔になる)', () => {
    const el = region();
    const apply = vi.fn();
    const confirmDiscard = vi.fn(async () => true);
    const prompt = createUpdatePrompt(el, { isEditing: () => false, confirmDiscard });
    prompt.present(apply);
    prompt.apply();
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
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
