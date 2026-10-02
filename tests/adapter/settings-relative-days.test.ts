/** @vitest-environment happy-dom */
/**
 * 🔴 **日付の右に「あとN日」を添える設定**(#1225)。
 *
 * ⚠ ここが守るのは「**設定に在って、映って、押せて、憶える**」の 4 つ ──
 * 添える字そのものは `tests/adapter/relative-days.test.ts`。
 * 🔴 **既定が入であること**をいちばん強く見る(`=== '1'` で読むと既定が切に化ける)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { RelativeDaysStore } from '@adapter/ui/render/relative-days';
import { DateLinksStore } from '@adapter/ui/render/date-links';
import { bindActions } from '@adapter/ui/actions/binder';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { initialState } from '@adapter/state/app-state';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function setup(stored?: string) {
  document.body.textContent = '';
  const host = document.createElement('div');
  document.body.append(host);
  const storage = fakeStorage();
  if (stored !== undefined) storage.map.set('pkc3.relative-days', stored);
  const store = new RelativeDaysStore(storage);
  /** ⚠ **末尾の位置引数**(`settings.ts` の constructor の戒め)。 */
  const r = new SettingsRenderer(
    host,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    store,
  );
  r.render(initialState);
  const box = host.querySelector<HTMLInputElement>('[data-pkc-field="relative-days"]');
  return { host, store, box, storage, r };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('設定画面に在る(#1225)', () => {
  it('🔴 checkbox が「編集」の節に在り、既定は入', () => {
    const { host, box } = setup();
    expect(box, '設定に口が無い').not.toBeNull();
    expect(box!.type).toBe('checkbox');
    expect(box!.getAttribute('data-pkc-action'), '押しても受け手に届かない').toBe(
      'set-relative-days',
    );
    expect(box!.checked, '既定が切になっている(`=== "1"` で読んだ形)').toBe(true);
    expect(
      host.querySelector('[data-pkc-region="settings-edit"] [data-pkc-field="relative-days"]'),
      '「編集」の節の外に置かれている',
    ).not.toBeNull();
  });

  it('🔴 憶えた値が映る(切にしたら、開き直しても切のまま)', () => {
    expect(setup('0').box!.checked, '切にしたのに入に見えている').toBe(false);
    expect(setup('1').box!.checked).toBe(true);
  });

  it('🔴 押すと受け手に届く(dead click ではない)', () => {
    const { host, box } = setup();
    const setRelativeDays = vi.fn();
    bindActions(host, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {
      setRelativeDays,
    });
    box!.click(); // 入 → 切
    expect(setRelativeDays, '押しても受け手が呼ばれない').toHaveBeenCalledWith(false);
    box!.click(); // 切 → 入(片道にしない)
    expect(setRelativeDays).toHaveBeenLastCalledWith(true);
  });

  /** 字は画面で起きることで書く。説明は hover に置く(visible の note は段落数を動かす)。 */
  it('🔴 何が起きるかを字で言っている', () => {
    const { box } = setup();
    const label = box!.closest('label')!;
    expect(label.textContent).toContain('今日からの日数');
    expect(label.title, '添える字の例を言っていない').toContain('あと3日');
    expect(label.title, '添えない形を言っていない').toContain('チェックを付けた項目');
  });
});

describe('憶え方(#1225)', () => {
  it('🔴 何も書いていない人は入(既定)', () => {
    expect(new RelativeDaysStore(fakeStorage()).enabled(), '既定が切になっている').toBe(true);
  });

  it('🔴 切にした値が保存に残り、入へ戻せる', () => {
    const { store, storage } = setup();
    store.setEnabled(false);
    expect(storage.map.get('pkc3.relative-days'), '保存に残っていない').toBe('0');
    expect(store.enabled()).toBe(false);
    store.setEnabled(true);
    expect(storage.map.get('pkc3.relative-days')).toBe('1');
    expect(store.enabled()).toBe(true);
  });

  it('⚠ 保存が例外を投げる環境でも、控えを読む(既定は入)', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const store = new RelativeDaysStore(broken);
    expect(store.enabled()).toBe(true);
    store.setEnabled(false);
    expect(store.enabled()).toBe(false);
  });
});

/**
 * 🔴 **日付を押せる設定が切のとき、日数の欄に前提を添える**(#1254 §2 欠陥 7。Gemini 裁定 = A)。
 *
 * > user の物語:日数の checkbox が入と出ているのに、本文の日付に何も添わない。
 * >   原因は**すぐ上の「本文の日付」が切**(添え字は押せる日付にしか差さない)だが、
 * >   設定のどこにもそう書いていなかった。
 */
describe('日付を押せる設定が切のときの前提(#1254 §2 欠陥 7)', () => {
  const PREREQ = '[data-pkc-region="relative-days-prereq"]';

  function setupDates(dateLinksStored?: string) {
    document.body.textContent = '';
    const host = document.createElement('div');
    document.body.append(host);
    const storage = fakeStorage();
    if (dateLinksStored !== undefined) storage.map.set('pkc3.date-links', dateLinksStored);
    const args: unknown[] = new Array(13).fill(undefined);
    /** ⚠ 末尾の位置引数(`dateLinks` は host の次から 14 番目)。型は位置引数の列で見られないので手で緩める。 */
    const Ctor = SettingsRenderer as unknown as new (...a: unknown[]) => SettingsRenderer;
    const r = new Ctor(host, ...args, new DateLinksStore(storage));
    r.render(initialState);
    const rd = host.querySelector<HTMLInputElement>('[data-pkc-field="relative-days"]');
    const dl = host.querySelector<HTMLInputElement>('[data-pkc-field="date-links"]');
    return { host, r, rd, dl, prereq: (): HTMLElement | null => host.querySelector<HTMLElement>(PREREQ) };
  }

  it('🔴 切のときだけ、日数の欄の説明に「日付を押せるようにすると出ます」が在る(対照群: 入では無い)', () => {
    // ⚠ 空振り防止 ── 日数の欄そのものと、日付の欄が描かれている
    const off = setupDates('0');
    expect(off.rd, '日数の欄が描かれていない').not.toBeNull();
    expect(off.dl, '日付の欄が描かれていない').not.toBeNull();
    expect(off.dl!.checked, '前提が崩れている(切に読めていない)').toBe(false);
    expect(off.prereq(), '切なのに前提が添えられていない').not.toBeNull();
    expect(off.prereq()!.textContent).toContain('日付を押せるようにすると出ます');
    // 添える先は日数の欄(同じ dd の中)
    expect(off.rd!.closest('dd')!.contains(off.prereq()), '日数の欄の外に置かれている').toBe(true);

    const on = setupDates('1');
    expect(on.rd, '日数の欄が描かれていない').not.toBeNull();
    expect(on.dl!.checked, '前提が崩れている(入に読めていない)').toBe(true);
    expect(on.prereq(), '入なのに前提が添えられている').toBeNull();
    // ⚠ 何も書いていない人(既定)は入
    expect(setupDates().prereq(), '既定(入)で前提が出ている').toBeNull();
  });

  it('🔴 日付の checkbox を切り替えると、その場で出入りする(再び入にすると消える = 片道にしない)', () => {
    const t = setupDates('1');
    expect(t.prereq()).toBeNull();
    t.dl!.checked = false;
    t.dl!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(t.prereq(), '切にしても前提が出ない').not.toBeNull();
    // 2 回 change しても重ならない
    t.dl!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(t.host.querySelectorAll(PREREQ), '前提が重なって出ている').toHaveLength(1);
    t.dl!.checked = true;
    t.dl!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(t.prereq(), '入に戻しても前提が残っている').toBeNull();
  });

  it('⚠ 描き直し(state の更新)でも重ならない', () => {
    const t = setupDates('0');
    t.r.render(initialState);
    t.r.render(initialState);
    expect(t.host.querySelectorAll(PREREQ)).toHaveLength(1);
  });
});
