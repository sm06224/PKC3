/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の `@日付` を押せる字にする設定**(#1169)。
 *
 * ⚠ ここが守るのは「**設定に在って、映って、押せて、憶える**」の 4 つ ──
 * 描画は `tests/features/markdown-date-link.test.ts`、読む面が旗を立てるかは
 * `tests/adapter/detail-date-links.test.ts`。
 *
 * 🔴 **既定が入であること**を、いちばん強く見る ── 電話番号(`phone-links`、既定は切)と
 * **逆**なので、同じ作りで書くと `=== '1'` で読んで**既定が切に化ける**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
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
  if (stored !== undefined) storage.map.set('pkc3.date-links', stored);
  const store = new DateLinksStore(storage);
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
    store,
  );
  r.render(initialState);
  const box = host.querySelector<HTMLInputElement>('[data-pkc-field="date-links"]');
  return { host, store, box, storage, r };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('設定画面に在る(#1169)', () => {
  it('🔴 checkbox が「編集」の節に在り、既定は入', () => {
    const { host, box } = setup();
    expect(box, '設定に口が無い').not.toBeNull();
    expect(box!.type).toBe('checkbox');
    expect(box!.getAttribute('data-pkc-action'), '押しても受け手に届かない').toBe(
      'set-date-links',
    );
    expect(box!.checked, '既定が切になっている(`=== "1"` で読んだ形)').toBe(true);
    expect(
      host.querySelector('[data-pkc-region="settings-edit"] [data-pkc-field="date-links"]'),
      '「編集」の節の外に置かれている',
    ).not.toBeNull();
  });

  it('🔴 憶えた値が映る(切にしたら、開き直しても切のまま)', () => {
    expect(setup('0').box!.checked, '切にしたのに入に見えている').toBe(false);
    // ⚠ 対照群 ── 入を憶えていれば入
    expect(setup('1').box!.checked).toBe(true);
  });

  it('🔴 押すと受け手に届く(dead click ではない)', () => {
    const { host, box } = setup();
    const setDateLinks = vi.fn();
    bindActions(host, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {
      setDateLinks,
    });
    // ⚠ `change` ではなく `click`(`settings-phone-links.test.ts` の注記と同じ)
    box!.click(); // 入 → 切
    expect(setDateLinks, '押しても受け手が呼ばれない').toHaveBeenCalledWith(false);
    box!.click(); // 切 → 入(片道にしない)
    expect(setDateLinks).toHaveBeenLastCalledWith(true);
  });

  /**
   * 字は画面で起きることで書く(「リンクにする」は内部の言葉)。
   * ⚠ 説明は 1 行(`settings-notes.test.ts` が 55 文字の上限で見る)── 詳しい動きは hover。
   */
  it('🔴 何が起きるかを字で言っている', () => {
    const { host, box } = setup();
    const label = box!.closest('label')!;
    expect(label.textContent).toContain('本文の @日付 を押すと、その日のノートを開く');
    expect(label.title, '無ければ作るかを聞くことを言っていない').toContain('作るかどうか');
    expect(label.title, '見た目の変化を言っていない').toContain('点線の下線');
    expect(host.textContent).toContain('押すと、題名がその日付のノートを開きます');
  });
});

describe('憶え方(#1169)', () => {
  it('🔴 何も書いていない人は入(既定)', () => {
    const store = new DateLinksStore(fakeStorage());
    expect(store.enabled(), '既定が切になっている').toBe(true);
  });

  it('🔴 切にした値が保存に残り、入へ戻せる', () => {
    const { store, storage } = setup();
    store.setEnabled(false);
    expect(storage.map.get('pkc3.date-links'), '保存に残っていない').toBe('0');
    expect(store.enabled()).toBe(false);
    store.setEnabled(true);
    expect(storage.map.get('pkc3.date-links')).toBe('1');
    expect(store.enabled()).toBe(true);
  });

  it('⚠ 保存が読めない環境でも、この session では効く(既定は入)', () => {
    const store = new DateLinksStore(null);
    expect(store.enabled(), '保存が無い環境で既定が切になっている').toBe(true);
    store.setEnabled(false);
    expect(store.enabled(), 'この session で効いていない').toBe(false);
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
    const store = new DateLinksStore(broken);
    expect(store.enabled()).toBe(true);
    store.setEnabled(false);
    expect(store.enabled()).toBe(false);
  });
});
