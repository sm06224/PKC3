/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の電話番号を押せる字にする設定**(#278 段②、user 裁定 2026-09-04 の推薦 C)。
 *
 * ⚠ ここが守るのは「**設定に在って、映って、押せて、憶える**」の 4 つである ──
 * 拾う判定は `tests/features/phone-link.test.ts`、描画は
 * `tests/features/markdown-phone.test.ts`。
 *
 * 🔴 **既定が切であること**を、いちばん強く見る ── ここが緩むと
 * **何も選んでいない全 user の本文の見え方が変わる**
 * (CLAUDE.md「見え方を変える判断は user のもの」)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { PhoneLinksStore } from '@adapter/ui/render/phone-links';
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
  if (stored !== undefined) storage.map.set('pkc3.phone-links', stored);
  const store = new PhoneLinksStore(storage);
  /**
   * ⚠ **末尾の位置引数**(`settings.ts` の constructor の戒め)── 1 稿目で
   *   `alarmEnabled` の直後へ入れ、位置引数で渡している別の test を落とした。
   */
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
    store,
  );
  r.render(initialState);
  const box = host.querySelector<HTMLInputElement>('[data-pkc-field="phone-links"]');
  return { host, store, box, storage, r };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('設定画面に在る(#278 段②)', () => {
  it('🔴 checkbox が「表示」の節に在り、既定は切', () => {
    const { host, box } = setup();
    expect(box, '設定に口が無い').not.toBeNull();
    expect(box!.type).toBe('checkbox');
    expect(box!.getAttribute('data-pkc-action'), '押しても受け手に届かない').toBe(
      'set-phone-links',
    );
    expect(box!.checked, '既定が入になっている(選んでいない人の本文が変わる)').toBe(false);
    // ⚠ ほかの設定と同じ節に置く ── 別の節にすると、探す場所が増える
    expect(
      host.querySelector('[data-pkc-region="settings-user"] [data-pkc-field="phone-links"]'),
      '「表示」の節の外に置かれている',
    ).not.toBeNull();
  });

  it('🔴 憶えた値が映る(開き直しても入のまま)', () => {
    const { box } = setup('1');
    expect(box!.checked, '憶えた値が映っていない').toBe(true);
    // ⚠ 対照群 ── 憶えていなければ切
    expect(setup('0').box!.checked, '切が入に見えている').toBe(false);
  });

  it('🔴 押すと受け手に届く(dead click ではない)', () => {
    const { host, box } = setup();
    const setPhoneLinks = vi.fn();
    bindActions(host, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {
      setPhoneLinks,
    });
    /**
     * ⚠ **`change` ではなく `click`** ── binder の `change` は**許可リスト**で、
     *   checkbox はそこに載っていない(載せると `input` のたびに撃つことになる)。
     * 🔴 1 稿目は `change` を撃って「受け手に届かない」と読み、**製品の不具合**だと
     *   思いかけた ── 実際は台の撃ち方が違った(CLAUDE.md §4「観測点の選び方」)。
     */
    box!.click(); // click は checked を反転させる → true
    expect(setPhoneLinks, '押しても受け手が呼ばれない').toHaveBeenCalledWith(true);
    // ⚠ 外したときも届く(片道にしない)
    box!.click(); // → false
    expect(setPhoneLinks).toHaveBeenLastCalledWith(false);
  });

  it('🔴 説明に「切のままなら変わらない」と書いてある', () => {
    const { host } = setup();
    const text = host.textContent ?? '';
    expect(text, '何が起きるかを書いていない').toContain('押すと電話をかけられる字');
    // 🔴 いちばん誤解されるのはここ ── 日付が変わらないことを先に言う
    expect(text, '日付が変わらないことを言っていない').toContain('2026-09-09');
    expect(text, '切のままなら変わらないことを言っていない').toContain('1 文字も変わりません');
  });
});

describe('憶え方(#278 段②)', () => {
  it('🔴 入れた値が保存に残る', () => {
    const { store, storage } = setup();
    store.setEnabled(true);
    expect(storage.map.get('pkc3.phone-links'), '保存に残っていない').toBe('1');
    expect(store.enabled()).toBe(true);
    store.setEnabled(false);
    expect(storage.map.get('pkc3.phone-links')).toBe('0');
    expect(store.enabled()).toBe(false);
  });

  it('⚠ 保存が読めない環境でも、この session では効く', () => {
    const store = new PhoneLinksStore(null);
    expect(store.enabled(), '保存が無いのに入になっている').toBe(false);
    store.setEnabled(true);
    expect(store.enabled(), 'この session で効いていない').toBe(true);
  });
});
