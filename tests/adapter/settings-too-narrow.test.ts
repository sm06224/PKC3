/** @vitest-environment happy-dom */
/**
 * 🔴 **狭い画面の断り書きの戻し道が、設定画面に在る**(#687 E-1、user 裁定 2026-09-04)。
 *
 * OK は端末に憶えるので(`too-narrow.ts`)、帯にしか導線が無いと一度押した user は
 * 二度と戻せない ── お知らせの「今後は出さない」と同じ形で、設定に戻し道を置く。
 *
 * ⚠ ここが守るのは「**設定に在って、映って、押せる**」の 3 つである ──
 * 憶える・出し入れそのものは `tests/adapter/too-narrow.test.ts`。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { TooNarrowOkStore } from '@adapter/ui/render/too-narrow';
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
  if (stored !== undefined) storage.map.set('pkc3.too-narrow-ok', stored);
  const store = new TooNarrowOkStore(storage);
  /**
   * ⚠ **末尾の位置引数**(`settings.ts` の constructor の戒め)── 途中へ入れると
   *   同じ型の別の store を静かに受け取る。
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
    store,
  );
  r.render(initialState);
  const box = host.querySelector<HTMLInputElement>('[data-pkc-field="too-narrow-enabled"]');
  return { host, store, box, storage, r };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('設定画面に在る', () => {
  it('🔴 checkbox が「表示」の節に在り、既定は入', () => {
    const { host, box } = setup();
    expect(box, '設定に戻し道が無い').not.toBeNull();
    expect(box!.type).toBe('checkbox');
    expect(box!.getAttribute('data-pkc-action'), '押しても受け手に届かない').toBe(
      'set-too-narrow-enabled',
    );
    // ⚠ お知らせの隣(同じ「表示」の節)── 別の節に置くと、戻し道を探す場所が増える
    expect(
      host.querySelector('[data-pkc-region="settings-user"] [data-pkc-field="too-narrow-enabled"]'),
      '「表示」の節に無い',
    ).not.toBeNull();
    expect(box!.checked, '既定が「出す」になっていない').toBe(true);
  });

  /**
   * 🔴 **帯の OK は、この画面を開かずに設定を切る** ── 映さないと
   *   次に設定を開いたとき「出す」のまま見える(CLAUDE.md §7「設定画面の値の同期」)。
   * ⚠ 器は 1 度しか組まないので、**組み済みの分岐**(2 度目の `render`)で見る。
   */
  it('🔴 帯で OK を押した後に開くと、切になって見える(組み済みでも映す)', () => {
    const { store, box, r } = setup();
    expect(box!.checked, '前提が崩れた(最初から切)').toBe(true);
    store.setEnabled(false); // = 帯の OK
    r.render(initialState); // 組み済みの分岐
    expect(box!.checked, 'OK で切れたのに、設定は「出す」のまま見える').toBe(false);
    store.setEnabled(true);
    r.render(initialState);
    expect(box!.checked, '戻したのに、設定は「切」のまま見える').toBe(true);
  });

  it('🔴 憶えた状態で開くと、最初から切で見える(起動をまたぐ)', () => {
    const { box } = setup('1');
    expect(box!.checked, '憶えているのに「出す」で見える').toBe(false);
  });
});

/**
 * 🔴 **押した値が受け手まで届く**(`announce.test.ts` の「受け手まで届く」と同じ型)。
 * ⚠ 反転して渡す変異をここで殺す ── checkbox の**押した後**の値を渡す。
 */
describe('押せる', () => {
  it('🔴 checkbox を押すと setTooNarrowEnabled に押した後の値が届く', () => {
    const { host, box } = setup();
    const calls: boolean[] = [];
    const stop = bindActions(host, {} as unknown as Dispatcher, {
      setTooNarrowEnabled: (on) => calls.push(on),
    });
    box!.checked = true;
    box!.click(); // click は checked を反転させる → false
    box!.click(); // → true
    expect(calls, '受け手が呼ばれていない / 値が反転している').toEqual([false, true]);
    stop();
  });
});
