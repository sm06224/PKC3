/** @vitest-environment happy-dom */
/**
 * 「開く場所」の**保存と配線**(#826、2026-09-09)。
 *
 * ⚠ 着地前レビューが「**鎖がどこからも 1 度も実行されていない**」と指摘した所である
 * ── 直す前は、`localStorage` を直に書く test しか無く、
 * **`<select>` → binder → 実体 → 保存** の間は誰も通っていなかった
 * (= 設定を選んでも何も起きない変異が全部生き延びる)。
 *
 * 守るのは 4 つ(`prose-align.test.ts` と同じ形):
 * ① 壊れた保存値・保存できない環境でも**落ちない**(既定へ)
 * ② 設定画面の選択欄が**いまの値を映す**(組み立て直後と、組み済みの両方)
 * ③ 選択欄 → binder → 実体 の配線(無言の dead click を作らない)
 * ④ `main.ts` の配線(選んだら保存する)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  chooseOpenPlace,
  currentOpenPlace,
  OPEN_PLACE_KEY,
} from '../../src/adapter/ui/render/open-place';
import { OPEN_PLACES } from '../../src/features/open-place';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { initialState } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('保存', () => {
  it('保存が無ければ既定(別の窓)', () => {
    expect(currentOpenPlace()).toBe('window');
  });

  it('選んだら保存し、次から読める', () => {
    chooseOpenPlace('here');
    expect(localStorage.getItem(OPEN_PLACE_KEY)).toBe('here');
    expect(currentOpenPlace()).toBe('here');
  });

  it('⚠ 壊れた保存値は既定へ落ちる(起動不能にしない)', () => {
    localStorage.setItem(OPEN_PLACE_KEY, 'popup');
    expect(currentOpenPlace()).toBe('window');
  });

  it('⚠ 保存が読めない環境でも落ちない', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('私用モード');
    });
    expect(currentOpenPlace()).toBe('window');
  });

  it('⚠ 保存が書けない環境でも落ちない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('いっぱいです');
    });
    expect(() => chooseOpenPlace('here')).not.toThrow();
  });
});

describe('設定画面との配線(#826)', () => {
  it('🔴 選択欄が **いまの値を映す**(組み済みの器でも)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    chooseOpenPlace('here');
    const settings = new SettingsRenderer(root, new JobMonitor());
    settings.render(initialState);
    const select = (): HTMLSelectElement | null =>
      root.querySelector<HTMLSelectElement>('[data-pkc-field="open-place-select"]');
    expect(select(), '設定画面に開く場所の選択欄が無い').not.toBeNull();
    expect(select()!.value, '組み立て直後に古い値が出ている').toBe('here');
    // ② 器は 1 度しか組まない ── 2 回目の render でも映す
    chooseOpenPlace('window');
    settings.render(initialState);
    expect(select()!.value, '組み済みの器へ映していない(古い値が見える)').toBe('window');
    root.remove();
  });

  it('🔴 選べる値が表と 1 対 1(選べるのに効かない / 効くのに選べないを作らない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    new SettingsRenderer(root, new JobMonitor()).render(initialState);
    const opts = [
      ...root.querySelectorAll<HTMLOptionElement>('[data-pkc-field="open-place-select"] option'),
    ].map((o) => o.value);
    expect(opts).toEqual(OPEN_PLACES.map((p) => p.id));
    root.remove();
  });

  it('🔴 選択欄 → binder → 実体 が繋がっている(押して無言にならない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const setOpenPlace = vi.fn();
    const dispatcher = { getState: () => initialState, dispatch: () => {} };
    bindActions(root, dispatcher as never, { setOpenPlace });
    // 本物の設定画面を binder の配下に組む(合成しない)
    new SettingsRenderer(root, new JobMonitor()).render(initialState);
    const select = root.querySelector<HTMLSelectElement>('[data-pkc-field="open-place-select"]');
    expect(select, '設定画面に開く場所の選択欄が無い').not.toBeNull();
    select!.value = 'here';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(setOpenPlace).toHaveBeenCalledWith('here');
    root.remove();
  });
});

/**
 * 🔴 **`main.ts` は原文でしか pin できない**(CLAUDE.md「どの test からも実行され
 * ない file に判断を書かない」)。⚠ 弱い pin だと自覚して使う。
 */
describe('main.ts の配線(原文 pin)', () => {
  const MAIN = readFileSync('src/main.ts', 'utf8');

  it('選んだら保存する(綴りを検めてから)', () => {
    expect(MAIN).toContain('if (isOpenPlace(place)) chooseOpenPlace(place);');
  });

  it('⚠ 起動時には保存しない(theme の M-7 の再発を止める)', () => {
    expect(MAIN).not.toContain('chooseOpenPlace(currentOpenPlace())');
  });
});
