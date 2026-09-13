/** @vitest-environment happy-dom */
/**
 * 「アプリの開き方」の**保存と配線**(#884 段①、2026-09-13)。
 *
 * ⚠ 形は `open-place.test.ts` に揃えてある ── 同じ作りの設定が 2 つあるのに
 *   守り方が違うと、片方だけ穴が空く(CLAUDE.md §7)。
 *
 * 守るのは 4 つ:
 * ① 壊れた保存値・保存できない環境でも**落ちない**(既定へ)
 * ② 設定画面の選択欄が**いまの値を映す**(組み立て直後と、組み済みの両方)
 * ③ 選択欄 → binder → 実体 の配線(**無言の dead click** を作らない)
 * ④ `main.ts` の配線(選んだら保存する / 起動時には保存しない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  APP_OPEN_TARGET_KEY,
  chooseAppOpenTarget,
  currentAppOpenTarget,
} from '../../src/adapter/ui/render/app-open-target';
import { APP_OPEN_TARGETS } from '../../src/features/launcher/open-target';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { initialState } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const FIELD = '[data-pkc-field="app-open-target-select"]';

describe('保存(#884 段①)', () => {
  it('保存が無ければ既定(ブラウザのタブ)', () => {
    expect(currentAppOpenTarget()).toBe('tab');
  });

  it('選んだら保存し、次から読める', () => {
    chooseAppOpenTarget('window');
    expect(localStorage.getItem(APP_OPEN_TARGET_KEY)).toBe('window');
    expect(currentAppOpenTarget()).toBe('window');
  });

  it('⚠ 壊れた保存値は既定へ落ちる(起動不能にしない)', () => {
    localStorage.setItem(APP_OPEN_TARGET_KEY, 'popup');
    expect(currentAppOpenTarget()).toBe('tab');
  });

  it('⚠ 保存が読めない環境でも落ちない', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('私用モード');
    });
    expect(currentAppOpenTarget()).toBe('tab');
  });

  it('⚠ 保存が書けない環境でも落ちない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('いっぱいです');
    });
    expect(() => chooseAppOpenTarget('window')).not.toThrow();
  });
});

describe('設定画面との配線(#884 段①)', () => {
  it('🔴 選択欄が **いまの値を映す**(組み済みの器でも)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    chooseAppOpenTarget('window');
    const settings = new SettingsRenderer(root, new JobMonitor());
    settings.render(initialState);
    const select = (): HTMLSelectElement | null => root.querySelector<HTMLSelectElement>(FIELD);
    expect(select(), '設定画面にアプリの開き方の選択欄が無い').not.toBeNull();
    expect(select()!.value, '組み立て直後に古い値が出ている').toBe('window');
    // ② 器は 1 度しか組まない ── 2 回目の render でも映す
    chooseAppOpenTarget('tab');
    settings.render(initialState);
    expect(select()!.value, '組み済みの器へ映していない(古い値が見える)').toBe('tab');
    root.remove();
  });

  it('🔴 選べる値が表と 1 対 1(選べるのに効かない / 効くのに選べないを作らない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    new SettingsRenderer(root, new JobMonitor()).render(initialState);
    const opts = [...root.querySelectorAll<HTMLOptionElement>(`${FIELD} option`)].map(
      (o) => o.value,
    );
    expect(opts).toEqual(APP_OPEN_TARGETS.map((t) => t.id));
    root.remove();
  });

  it('🔴 選択欄 → binder → 実体 が繋がっている(押して無言にならない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const setAppOpenTarget = vi.fn();
    const dispatcher = { getState: () => initialState, dispatch: () => {} };
    bindActions(root, dispatcher as never, { setAppOpenTarget });
    // 本物の設定画面を binder の配下に組む(合成しない)
    new SettingsRenderer(root, new JobMonitor()).render(initialState);
    const select = root.querySelector<HTMLSelectElement>(FIELD);
    expect(select, '設定画面にアプリの開き方の選択欄が無い').not.toBeNull();
    select!.value = 'window';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(setAppOpenTarget).toHaveBeenCalledWith('window');
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
    expect(MAIN).toContain('if (isAppOpenTarget(target)) chooseAppOpenTarget(target);');
  });

  it('⚠ 起動時には保存しない(選んでいないのに固定しない)', () => {
    expect(MAIN).not.toContain('chooseAppOpenTarget(currentAppOpenTarget())');
  });

  it('🔴 起動の配線が 2 か所とも通っている(片方だけだと、その経路で設定が効かない)', () => {
    const hits = MAIN.split('openTarget: currentAppOpenTarget,').length - 1;
    expect(hits, 'タイルを起動する配線は 2 か所ある(#884 段①)').toBe(2);
  });
});
