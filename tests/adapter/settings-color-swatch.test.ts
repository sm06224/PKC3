/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の色コードの左に色の見本を出す設定**(#1224)。
 *
 * ⚠ ここが守るのは「**設定に在って、映って、押せて、憶える**」の 4 つ ──
 * 見本そのものは `tests/features/markdown-color-swatch.test.ts`。
 * 🔴 **既定が入であること**をいちばん強く見る(`=== '1'` で読むと既定が切に化ける)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { ColorSwatchStore } from '@adapter/ui/render/color-swatch';
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
  if (stored !== undefined) storage.map.set('pkc3.color-swatch', stored);
  const store = new ColorSwatchStore(storage);
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
    undefined,
    store,
  );
  r.render(initialState);
  const box = host.querySelector<HTMLInputElement>('[data-pkc-field="color-swatch"]');
  return { host, store, box, storage, r };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('設定画面に在る(#1224)', () => {
  it('🔴 checkbox が「編集」の節に在り、既定は入', () => {
    const { host, box } = setup();
    expect(box, '設定に口が無い').not.toBeNull();
    expect(box!.type).toBe('checkbox');
    expect(box!.getAttribute('data-pkc-action'), '押しても受け手に届かない').toBe(
      'set-color-swatch',
    );
    expect(box!.checked, '既定が切になっている(`=== "1"` で読んだ形)').toBe(true);
    expect(
      host.querySelector('[data-pkc-region="settings-edit"] [data-pkc-field="color-swatch"]'),
      '「編集」の節の外に置かれている',
    ).not.toBeNull();
  });

  it('🔴 憶えた値が映る(切にしたら、開き直しても切のまま)', () => {
    expect(setup('0').box!.checked, '切にしたのに入に見えている').toBe(false);
    expect(setup('1').box!.checked).toBe(true);
  });

  it('🔴 押すと受け手に届く(dead click ではない)', () => {
    const { host, box } = setup();
    const setColorSwatch = vi.fn();
    bindActions(host, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {
      setColorSwatch,
    });
    box!.click(); // 入 → 切
    expect(setColorSwatch, '押しても受け手が呼ばれない').toHaveBeenCalledWith(false);
    box!.click(); // 切 → 入(片道にしない)
    expect(setColorSwatch).toHaveBeenLastCalledWith(true);
  });

  /** 字は画面で起きることで書く。説明は hover に置く(visible の note は段落数を動かす)。 */
  it('🔴 何が起きるかを字で言っている', () => {
    const { box } = setup();
    const label = box!.closest('label')!;
    expect(label.textContent).toContain('色コード');
    expect(label.textContent).toContain('色の見本');
    expect(label.title, '出す形(囲んだ字だけ)を言っていない').toContain('バッククォート');
    expect(label.title, '出ない所を言っていない').toContain('書き出した HTML');
  });
});

describe('憶え方(#1224)', () => {
  it('🔴 何も書いていない人は入(既定)', () => {
    expect(new ColorSwatchStore(fakeStorage()).enabled(), '既定が切になっている').toBe(true);
  });

  it('🔴 切にした値が保存に残り、入へ戻せる', () => {
    const { store, storage } = setup();
    store.setEnabled(false);
    expect(storage.map.get('pkc3.color-swatch'), '保存に残っていない').toBe('0');
    expect(store.enabled()).toBe(false);
    store.setEnabled(true);
    expect(storage.map.get('pkc3.color-swatch')).toBe('1');
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
    const store = new ColorSwatchStore(broken);
    expect(store.enabled()).toBe(true);
    store.setEnabled(false);
    expect(store.enabled()).toBe(false);
  });
});
