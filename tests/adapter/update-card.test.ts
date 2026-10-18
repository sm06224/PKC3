/** @vitest-environment happy-dom */
/**
 * P7 段⑤: 更新の案内の面と、押されたときの動き。
 *
 * 🔴 ここは **smoke から観測できない**。押すと再読込が走るので、「押したら案内が
 * 消える」は消えていなくても次のページには無い ── 変異試験で実際に生き残った。
 * `main.ts` に直書きせず取り出したのはそのため。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UPDATE_ELSEWHERE_TEXT,
  UPDATE_HINT,
  UPDATE_STUCK_MS,
  UPDATE_STUCK_TEXT,
  UPDATE_TEXT,
  buildUpdateAvailableRow,
  clearUpdateCard,
  createUpdatePrompt,
  showUpdateCard,
  updatePending,
} from '../../src/adapter/ui/render/update-card';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { initialState } from '../../src/adapter/state/app-state';
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
      '新しいバージョン',
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

describe('🔴 切り替わらずに止まったとき、字を改めて読み込み直す道を出す(依頼 84-6 B)', () => {
  const text = (el: HTMLElement) => el.querySelector('[data-pkc-field="update-text"]')?.textContent;

  it('待ちが過ぎるまでは「切り替えています…」のまま、過ぎたら字が変わり読み込み直せる', () => {
    vi.useFakeTimers();
    try {
      const el = region();
      const reload = vi.fn();
      const prompt = createUpdatePrompt(el, { reload });
      prompt.present(vi.fn());
      prompt.apply();
      vi.advanceTimersByTime(UPDATE_STUCK_MS - 1);
      expect(text(el)).toContain('切り替えています');
      vi.advanceTimersByTime(1);
      expect(text(el)).toBe(UPDATE_STUCK_TEXT);
      const btn = el.querySelector('[data-pkc-action="apply-update"]');
      expect(btn?.textContent).toBe('読み込み直す');
      prompt.apply(); // ボタンの受け手は同じ `apply`
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('次の版が来た(present)後は、古い見張りが案内を上書きしない', () => {
    vi.useFakeTimers();
    try {
      const el = region();
      const prompt = createUpdatePrompt(el, { reload: vi.fn() });
      prompt.present(vi.fn());
      prompt.apply();
      prompt.present(vi.fn());
      vi.advanceTimersByTime(UPDATE_STUCK_MS * 2);
      expect(text(el)).toContain('新しいバージョン');
      expect(text(el)).not.toBe(UPDATE_STUCK_TEXT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('読み込み直しの手段が無ければ字だけ出す(ボタンは出さない)', () => {
    vi.useFakeTimers();
    try {
      const el = region();
      const prompt = createUpdatePrompt(el, { stuckMs: 50 });
      prompt.present(vi.fn());
      prompt.apply();
      vi.advanceTimersByTime(50);
      expect(text(el)).toBe(UPDATE_STUCK_TEXT);
      expect(el.querySelector('[data-pkc-action="apply-update"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

/**
 * 🔴 **台帳 #1852 束 L2(依頼 84-1 C / 84-2 B / 120-2 A / 131 A)**。
 *
 * - カードに「切り替えると、変更点がお知らせに出ます。」が付く(切り替える前の手がかり)
 * - 「あとで切り替える」を押した後も、システムの「お知らせ」とヘルプの版の行に切り替える場所が残る
 * - 別のタブが切り替えたときは、勝手に読み込み直さず、押されたときだけ読み込み直す
 */
describe('「あとで切り替える」の後の切り替える場所(依頼 84-1 / 120-2)', () => {
  // 「待っている版」の印は module 持ち ── 前の test の置き土産を消してから始める
  beforeEach(() => {
    const p = createUpdatePrompt(region());
    p.present(vi.fn());
    void p.apply();
  });

  it('🔴 カードの字に、切り替えた後に何が起きるかが書いてある(UPDATE_TEXT は変えない)', () => {
    const el = region();
    showUpdateCard(el);
    const t = el.querySelector('[data-pkc-field="update-text"]')?.textContent ?? '';
    expect(t.startsWith(UPDATE_TEXT), 'はじめに.txt が引く字を変えた').toBe(true);
    expect(t).toContain(UPDATE_HINT);
    expect(UPDATE_HINT).toContain('お知らせに出ます');
  });

  it('🔴 待っている版が無い間は隠れ、出した後は「あとで」を押しても残り、切り替えを頼んだら隠れる', () => {
    const row = buildUpdateAvailableRow();
    document.body.append(row);
    expect(row.hidden, '待っている版が無いのに出ている').toBe(true);
    expect(updatePending()).toBe(false);

    const el = region();
    const prompt = createUpdatePrompt(el);
    prompt.present(vi.fn());
    expect(updatePending()).toBe(true);
    expect(row.hidden, '新しい版が来たのに行が出ない').toBe(false);

    prompt.dismiss(); // 「あとで切り替える」
    expect(el.hidden, 'カードは消える').toBe(true);
    expect(row.hidden, '「あとで」を押したら切り替える場所が無くなった').toBe(false);
    expect(row.querySelector('[data-pkc-action="apply-update"]')?.textContent).toBe('新しいバージョンに切り替える');

    const run = vi.fn();
    prompt.present(run);
    prompt.apply(); // 行のボタンも同じ受け手(apply-update)で届く
    expect(run).toHaveBeenCalledTimes(1);
    expect(row.hidden, '切り替えを頼んだのに行が残る').toBe(true);
    row.remove();
  });

  it('🔴 システムの「お知らせ」の節に「新しいバージョン」の行が付き、待っている間だけ見える', () => {
    const host = document.createElement('div');
    new SettingsRenderer(host).render(initialState);
    document.body.append(host);
    const dt = [...host.querySelectorAll<HTMLElement>('dt')].find((d) => d.textContent === '新しいバージョン');
    expect(dt, '節に行が無い').toBeDefined();
    expect(dt!.hidden, '待っていないのに出ている').toBe(true);

    const prompt = createUpdatePrompt(region());
    prompt.present(vi.fn());
    expect(dt!.hidden, '待っているのに出ない').toBe(false);
    const dd = dt!.nextElementSibling as HTMLElement;
    expect(dd.hidden).toBe(false);
    expect(dd.querySelector('[data-pkc-action="apply-update"]'), '切り替えるボタンが無い').not.toBeNull();
    prompt.apply();
    expect(dt!.hidden).toBe(true);
    host.remove();
  });
});

describe('別のタブが切り替えたとき(依頼 131)', () => {
  it('🔴 案内の字と「読み込み直す」が出て、押すまで読み込み直さない', () => {
    const el = region();
    const prompt = createUpdatePrompt(el);
    const reload = vi.fn();
    prompt.elsewhere(reload);
    expect(el.hidden).toBe(false);
    expect(el.querySelector('[data-pkc-field="update-text"]')?.textContent).toBe(UPDATE_ELSEWHERE_TEXT);
    expect(el.querySelector('[data-pkc-action="apply-update"]')?.textContent).toBe('読み込み直す');
    expect(reload, '案内を出しただけで読み込み直した').not.toHaveBeenCalled();
    prompt.apply();
    expect(reload).toHaveBeenCalledTimes(1);
    // 押した後は「切り替えています」ではなく「読み込み直しています」
    expect(el.querySelector('[data-pkc-field="update-text"]')?.textContent).toBe('読み込み直しています…');
  });

  it('🔴 別のタブの切り替えでは「待っている版」の印を立てない(システムの行を出さない)', () => {
    const prompt = createUpdatePrompt(region());
    prompt.elsewhere(vi.fn());
    expect(updatePending()).toBe(false);
  });

  it('編集中なら、読み込み直す前に確かめる(断られたら読み込み直さない)', async () => {
    const el = region();
    const reload = vi.fn();
    const prompt = createUpdatePrompt(el, { isEditing: () => true, confirmDiscard: async () => false });
    prompt.elsewhere(reload);
    await prompt.apply();
    expect(reload).not.toHaveBeenCalled();
  });
});
