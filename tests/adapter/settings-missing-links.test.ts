/** @vitest-environment happy-dom */
/**
 * 🔴 **無いノートへのリンクの点線を切る設定**(#1174 段①)。
 *
 * ⚠ 守るのは「設定に在って、映って、押せて、憶える」の 4 つ。`phone-links` と**既定が逆**
 *   (入)なので、いちばん強く見るのは**何も選んでいない人で入になっていること**
 *   と、**切が憶えられること**(`!== '0'` を `=== '1'` に書き間違えると、鍵の無い人が切になる)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { MissingLinksStore } from '@adapter/ui/render/missing-links';
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
  if (stored !== undefined) storage.map.set('pkc3.missing-links', stored);
  const store = new MissingLinksStore(storage);
  // ⚠ 末尾の位置引数(`settings.ts` の constructor の戒め)── `noticeList` の次の 14 番目
  const r = new SettingsRenderer(
    host,
    // ⚠ 2026-10-01: #1169(本文の日付)が 1 つ前に入ったので、飛ばす引数は 13 → 14
    ...(Array<undefined>(14).fill(undefined) as [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]),
    store,
  );
  r.render(initialState);
  const box = host.querySelector<HTMLInputElement>('[data-pkc-field="missing-links"]');
  return { host, store, box, storage, r };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('設定画面に在る(#1174 段①)', () => {
  it('🔴 checkbox が「編集」の節に在り、既定は入', () => {
    const { host, box } = setup();
    expect(box, '設定に欄が無い').not.toBeNull();
    expect(box!.type).toBe('checkbox');
    expect(box!.getAttribute('data-pkc-action'), '押しても受け手に届かない').toBe(
      'set-missing-links',
    );
    expect(box!.checked, '既定が切になっている(何も選んでいない人に点線が出ない)').toBe(true);
    expect(
      host.querySelector('[data-pkc-region="settings-edit"] [data-pkc-field="missing-links"]'),
      '「編集」の節の外に置かれている',
    ).not.toBeNull();
  });

  it('🔴 切が憶えられ、映る(開き直しても切のまま)── 対照群: 入', () => {
    expect(setup('0').box!.checked, '切が入に見えている').toBe(false);
    expect(setup('1').box!.checked).toBe(true);
  });

  it('🔴 押すと受け手に届く(dead click ではない)── 外したときも', () => {
    const { host, box } = setup();
    const setMissingLinks = vi.fn();
    bindActions(host, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {
      setMissingLinks,
    });
    box!.click(); // 入 → 切
    expect(setMissingLinks, '押しても受け手が呼ばれない').toHaveBeenCalledWith(false);
    box!.click();
    expect(setMissingLinks).toHaveBeenLastCalledWith(true);
  });
});

describe('MissingLinksStore', () => {
  it('🔴 鍵が無ければ入 / 書いた切は 0 で残る', () => {
    const storage = fakeStorage();
    const s = new MissingLinksStore(storage);
    expect(s.enabled()).toBe(true);
    s.setEnabled(false);
    expect(storage.map.get('pkc3.missing-links')).toBe('0');
    expect(new MissingLinksStore(storage).enabled()).toBe(false);
    s.setEnabled(true);
    expect(new MissingLinksStore(storage).enabled()).toBe(true);
  });

  it('保存が例外を投げる端末でも既定は入で、この session では書いた値が効く', () => {
    const boom = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
    };
    const s = new MissingLinksStore(boom);
    expect(s.enabled()).toBe(true);
    s.setEnabled(false);
    expect(s.enabled()).toBe(false);
  });
});
