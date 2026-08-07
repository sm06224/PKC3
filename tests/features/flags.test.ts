/** @vitest-environment happy-dom */
/**
 * 🔴 **フラグ機構**(P11。user 指示 2026-08-07)。
 *
 * > 「**設定はユーザーに開放されたもの、フラグは開発者とパワーユーザーに開放された
 * > もので予算は 15 個まで、それ以上は設定値で正式リリースさせる**」
 *
 * ## この test が守るもの
 *
 * `tests/flag-budget.test.ts` は「**予算と宣言の作法**」(15 個 / `foldWhen` 必須 /
 * 登記所の独占)を見張る。こちらは「**値がどう解けるか**」を見る ── 両方要る。
 *
 * ⚠ **登記所は module 全体で 1 つ**なので、test は**自分専用の名前**で宣言する
 * (`test.` 前置き)。`src` の宣言と混ざらないし、予算にも数えられない
 * (`flag-budget.test.ts:95` が読むのは `src` だけ)。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  defineFlag,
  findFlag,
  prunedForStorage,
  registeredFlags,
  resolveFlags,
} from '../../src/features/flags';
import { FlagStore, flagsFromUrl } from '../../src/adapter/platform/flag-store';

// ⚠ test 用の宣言(名前が衝突しないよう前置きを付ける)
const ON = defineFlag('test.defaultOn', {
  default: true,
  foldWhen: 'この test が消えるとき',
  summary: '既定 ON の見本',
});
const OFF = defineFlag('test.defaultOff', {
  default: false,
  foldWhen: 'この test が消えるとき',
  summary: '既定 OFF の見本',
});

describe('登記所(features/flags.ts)', () => {
  it('宣言したものが一覧に出る / 引ける', () => {
    const names = registeredFlags().map((f) => f.name);
    expect(names).toContain(ON.name);
    expect(names).toContain(OFF.name);
    expect(findFlag(OFF.name)?.default).toBe(false);
    expect(findFlag('存在しない')).toBeNull();
  });

  it('🔴 同じ名前を 2 度宣言したら、その場で落ちる', () => {
    // ⚠ 後勝ちで静かに上書きすると、どちらが効いているか誰にも分からなくなる
    expect(() =>
      defineFlag(ON.name, { default: false, foldWhen: 'x', summary: 'y' }),
    ).toThrow(/二重/);
  });

  it('🔴 すべての宣言が畳む条件(foldWhen)を持つ', () => {
    // ⚠ ここは「書けないものは flag にしない」の実体。空文字も許さない
    for (const f of registeredFlags()) {
      expect(f.foldWhen.length, `${f.name} に畳む条件が無い`).toBeGreaterThan(0);
    }
  });
});

describe('値の解決(URL > 保存 > 既定)', () => {
  it('何も無ければ既定', () => {
    const v = resolveFlags({});
    expect(v[ON.name]).toBe(true);
    expect(v[OFF.name]).toBe(false);
  });

  it('保存値が既定に勝つ', () => {
    const v = resolveFlags({ [ON.name]: false, [OFF.name]: true });
    expect(v[ON.name]).toBe(false);
    expect(v[OFF.name]).toBe(true);
  });

  /**
   * 🔴 **URL が保存値に勝つ。** ⚠ ここを逆にすると、**保存値が壊れた user が
   * 自分で素の状態へ戻せなくなる**(パワーユーザーの逃げ道が塞がる)。
   */
  it('🔴 URL が保存値に勝つ(壊れた保存から抜け出せる)', () => {
    const v = resolveFlags({ [ON.name]: false }, { [ON.name]: true });
    expect(v[ON.name]).toBe(true);
  });

  it('⚠ 知らない名前は解決結果に出ない(退役した flag の残骸を無視する)', () => {
    const v = resolveFlags({ 'test.退役済み': true });
    expect(Object.keys(v)).not.toContain('test.退役済み');
  });
});

describe('保存する値の間引き', () => {
  /**
   * 🔴 **既定と同じものは書かない。**
   * ⚠ 書くと、あとで既定を変えたときに**古い user だけ取り残される**。
   */
  it('🔴 既定と同じ値は保存に残さない', () => {
    const pruned = prunedForStorage({ [ON.name]: true, [OFF.name]: false });
    expect(pruned[ON.name]).toBeUndefined();
    expect(pruned[OFF.name]).toBeUndefined();
  });

  it('既定と違う値だけ残る', () => {
    const pruned = prunedForStorage({ [ON.name]: false, [OFF.name]: true });
    expect(pruned[ON.name]).toBe(false);
    expect(pruned[OFF.name]).toBe(true);
  });
});

describe('URL の読み取り', () => {
  it('?pkc-flag=name で ON、:off で OFF、カンマで複数', () => {
    expect(flagsFromUrl('?pkc-flag=a')).toEqual({ a: true });
    expect(flagsFromUrl('?pkc-flag=a:off')).toEqual({ a: false });
    expect(flagsFromUrl('?pkc-flag=a,b:off')).toEqual({ a: true, b: false });
    expect(flagsFromUrl('?pkc-flag=a&pkc-flag=b')).toEqual({ a: true, b: true });
  });

  it('⚠ 空・壊れた URL でも落ちない', () => {
    expect(flagsFromUrl('')).toEqual({});
    expect(flagsFromUrl('?pkc-flag=')).toEqual({});
    expect(flagsFromUrl('?other=1')).toEqual({});
  });
});

describe('保存(FlagStore)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('切り替えると保存され、次に読むと効いている', () => {
    const a = new FlagStore('');
    expect(a.isOn(OFF.name)).toBe(false);
    a.set(OFF.name, true);
    expect(new FlagStore('').isOn(OFF.name)).toBe(true);
  });

  /**
   * 🔴 **既定へ戻したら、鍵ごと消える。**
   * ⚠ 空 object を残すと「触った跡」だけが残り、既定を変えたときに効かなくなる。
   */
  it('🔴 既定へ戻すと保存の鍵ごと消える', () => {
    const s = new FlagStore('');
    s.set(OFF.name, true);
    expect(localStorage.getItem('pkc3.flags')).not.toBeNull();
    s.set(OFF.name, false); // 既定に戻す
    expect(localStorage.getItem('pkc3.flags')).toBeNull();
  });

  it('reset ですべて既定へ戻る', () => {
    const s = new FlagStore('');
    s.set(OFF.name, true);
    s.set(ON.name, false);
    expect(s.changedCount()).toBe(2);
    s.reset();
    expect(s.changedCount()).toBe(0);
    expect(localStorage.getItem('pkc3.flags')).toBeNull();
  });

  /**
   * 🔴 **URL 由来は保存に混ぜない。**
   * ⚠ 混ぜると URL を外しても残り、「試したつもりが居座る」になる。
   */
  it('🔴 URL で有効化しても保存されない(外せば戻る)', () => {
    const withUrl = new FlagStore(`?pkc-flag=${OFF.name}`);
    expect(withUrl.isOn(OFF.name)).toBe(true);
    expect(localStorage.getItem('pkc3.flags'), 'URL 由来が保存されている').toBeNull();
    // URL を外した別の起動では既定に戻っている
    expect(new FlagStore('').isOn(OFF.name)).toBe(false);
  });

  it('⚠ URL で上書き中かどうかを見分けられる(画面が「一時的」と出すため)', () => {
    const s = new FlagStore(`?pkc-flag=${OFF.name}`);
    expect(s.isFromUrl(OFF.name)).toBe(true);
    expect(s.isFromUrl(ON.name)).toBe(false);
  });

  it('⚠ 保存が壊れていても既定に戻るだけ(落ちない)', () => {
    localStorage.setItem('pkc3.flags', '{壊れた');
    expect(new FlagStore('').isOn(ON.name)).toBe(true);
    localStorage.setItem('pkc3.flags', '[]');
    expect(new FlagStore('').isOn(ON.name)).toBe(true);
  });
});
