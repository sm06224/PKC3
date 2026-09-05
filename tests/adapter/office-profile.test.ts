/**
 * 🔴 **Office 側の設定を初期状態に戻す口**(#634)。
 *
 * ⚠ ここが守るのは 2 つで、どちらも「静かに壊れる」側の形である:
 *  ① **綴りが 1 つ**であること ── `host.html` の鍵と違うと、消したのに戻ってくる
 *  ② **押して無反応を作らない** ── 元から空でも必ず何か言う
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OFFICE_PROFILE_KEY,
  officeProfileBytes,
  resetOfficeProfile,
  type MacroStore,
} from '@adapter/platform/office/office-profile';

function fakeStore(initial: Record<string, string>): {
  store: { getItem(k: string): string | null; removeItem(k: string): void };
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    store: {
      getItem: (k) => data[k] ?? null,
      removeItem: (k) => {
        delete data[k];
      },
    },
  };
}

/** 窓が IndexedDB へ退避したマクロを消す口(#431 ②)の偽物 ── 呼ばれた回数を数える。 */
function fakeMacros(outcome: 'ok' | 'fail' = 'ok'): { store: MacroStore; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    store: {
      dropMacros: () => {
        n += 1;
        return outcome === 'ok' ? Promise.resolve() : Promise.reject(new Error('idb closed'));
      },
    },
  };
}

describe('Office の設定を初期化する(#634)', () => {
  it('退避が在れば消し、消したことを言う', () => {
    const { store, data } = fakeStore({ [OFFICE_PROFILE_KEY]: '<oor:items/>', other: 'keep' });
    const r = resetOfficeProfile(store, fakeMacros().store);
    expect(r.removed).toBe(true);
    expect(r.message).toContain('初期状態に戻しました');
    expect(OFFICE_PROFILE_KEY in data).toBe(false);
    // ⚠ 巻き添えを出さない ── 消すのはこの 1 鍵だけ
    expect(data['other']).toBe('keep');
  });

  it('元から空でも「すでに初期状態です」と答える(無反応にしない)', () => {
    const { store } = fakeStore({});
    const r = resetOfficeProfile(store, fakeMacros().store);
    expect(r.removed).toBe(false);
    expect(r.message).toContain('すでに初期状態');
  });

  it('🔴 開いている窓へ伝える ── 伝えないと閉じるときに書き戻る', () => {
    const { store } = fakeStore({ [OFFICE_PROFILE_KEY]: 'x' });
    let told = 0;
    resetOfficeProfile(store, fakeMacros().store, () => {
      told += 1;
    });
    expect(told, '合図を送っていない(消したそばから復活する)').toBe(1);
  });

  it('⚠ 合図が失敗しても、消したことは言う', () => {
    const { store, data } = fakeStore({ [OFFICE_PROFILE_KEY]: 'x' });
    const r = resetOfficeProfile(store, fakeMacros().store, () => {
      throw new Error('閉じた窓');
    });
    expect(r.removed).toBe(true);
    expect(OFFICE_PROFILE_KEY in data).toBe(false);
  });

  it('読めない端末では 0 バイト扱いにする(起動を落とさない)', () => {
    const store = {
      getItem: (): string | null => {
        throw new Error('private mode');
      },
      removeItem: (): void => {},
    };
    expect(officeProfileBytes(store)).toBe(0);
  });

  /**
   * 🔴 **マクロも同じ出口で捨てる**(#431 ②)。⚠ 窓が閉じているときは本体しか
   * 消せない ── ここで呼ばないと、「初期化しました」と言いながらマクロだけ残る。
   */
  it('🔴 設定と一緒に、退避したマクロ(IndexedDB)も消す', () => {
    const { store } = fakeStore({ [OFFICE_PROFILE_KEY]: 'x' });
    const macros = fakeMacros();
    const r = resetOfficeProfile(store, macros.store);
    expect(macros.calls(), 'マクロを消していない(設定だけ消して残している)').toBe(1);
    expect(r.message, '捨てたものを言っていない').toContain('マクロ');
  });

  it('元から設定が無くても、マクロは消す(片方だけ残さない)', () => {
    const { store } = fakeStore({});
    const macros = fakeMacros();
    resetOfficeProfile(store, macros.store);
    expect(macros.calls()).toBe(1);
  });

  it('⚠ マクロが消せなくても、設定を消したことは言う(unhandled rejection にしない)', async () => {
    const { store, data } = fakeStore({ [OFFICE_PROFILE_KEY]: 'x' });
    const r = resetOfficeProfile(store, fakeMacros('fail').store);
    expect(r.removed).toBe(true);
    expect(OFFICE_PROFILE_KEY in data).toBe(false);
    // reject が漏れていれば vitest が unhandled rejection で落とす ── 1 tick 待つ
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  /**
   * 🔴 **綴りは 1 つ**(CLAUDE.md §7「同じ値が複数の場所にある」)。
   * ⚠ `host.html` は bundle されないので import で共有できない ── だから
   *   **原文を読んで等値で pin する**。片方だけ変えると、消す口は「消しました」と
   *   言うのに次の起動で戻ってくる(user からは何も直っていない)。
   */
  it('🔴 host.html の鍵と同じ綴りである', () => {
    const src = readFileSync(resolve('public/office/host.html'), 'utf-8');
    const m = /var PROFILE_KEY = '([^']+)'/.exec(src);
    expect(m, 'host.html に PROFILE_KEY が見当たらない(綴りを追えていない)').not.toBeNull();
    expect(m?.[1]).toBe(OFFICE_PROFILE_KEY);
  });

  /**
   * 🔴 **消した後に書き戻さない門**(#634)。
   * ⚠ `saveProfile` は `pagehide` でも走るので、門が無いと**開き直す途中で復活する**。
   * ⚠ 実挙動は smoke(`office-host.smoke.spec.ts`)が見る ── ここは
   *   「門そのものが在る」ことだけを見る**弱い pin** である(そう自覚して置く)。
   */
  it('🔴 host.html は、捨てると決めた後の退避を止めている', () => {
    const src = readFileSync(resolve('public/office/host.html'), 'utf-8');
    expect(src).toContain('if (profileReset) return;');
    expect(src, '本体からの合図を受ける口が無い').toContain("d.pkc3Office === 'reset-profile'");
  });
});
