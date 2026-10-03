/**
 * 🔴 **最近使った操作の置き場**(#274)。
 *
 * ⚠ 規則は `tests/features/recent-commands.test.ts` が見る ── ここは
 *   「**保存が使えない端末でも落ちず効くか**」「**壊れた保存で落ちないか**」
 *   「**無駄に書かないか**」「**container / 設定の持ち出しに混ざらないか**」だけ。
 */
import { describe, expect, it } from 'vitest';
import {
  RecentCommandsStore,
  type RecentCommandsStorage,
} from '../../src/adapter/platform/recent-commands-store';
import { PORTABLE_KEYS, SKIPPED_KEYS } from '../../src/features/settings/settings-file';

const KEY = 'pkc3.recent-commands';

/** 偽の保存 ── 書込の**回数と中身**・読んだ鍵まで観測する。 */
function fake(
  initial: string | null = null,
): RecentCommandsStorage & { writes: string[]; keys: string[]; removed: number } {
  let value = initial;
  const writes: string[] = [];
  const keys: string[] = [];
  return {
    writes,
    keys,
    removed: 0,
    get: (k) => {
      keys.push(k);
      return value;
    },
    set(_k, v) {
      value = v;
      writes.push(v);
    },
    remove(this: { removed: number }) {
      value = null;
      this.removed += 1;
    },
  };
}

describe('最近使った操作の置き場(#274)', () => {
  it('積むと保存へ書き、再起動(別の store)でも同じ物が新しい順で読める', () => {
    const s = fake();
    const store = new RecentCommandsStore(s);
    store.push('a');
    store.push('b');
    expect(s.writes).toHaveLength(2);
    expect(JSON.parse(s.writes[1]!)).toEqual(['b', 'a']);
    expect(new RecentCommandsStore(s).list()).toEqual(['b', 'a']);
  });

  /**
   * 🔴 **保存が使えない端末(private window 等)でも、落ちない。その session の中では効く**。
   * ⚠ `?.` で書くと `null` は例外を投げないので、控えが**死んだ枝**になる ── その形だと落ちる。
   */
  it('🔴 保存が無い端末でも、積んでも落ちず、その場で読み直せる', () => {
    const store = new RecentCommandsStore(null);
    expect(() => store.push('a')).not.toThrow();
    store.push('b');
    expect(store.list(), '控えが読まれていない').toEqual(['b', 'a']);
    store.clear();
    expect(store.list(), '消したのに控えが残っている').toEqual([]);
  });

  /**
   * 🔴 **保存は在るが、書込だけ失敗する端末**(容量いっぱい / 私用ウィンドウ)。
   * ⚠ 上の `null` の test は**この枝を通らない**(`storage === null` で先に返る)── 実際の口
   *   (`browserStorage.set`)は投げずに**黙って捨てる**ので、保存は空のまま・控えだけが積まれる。
   *   直す前は `list()` が保存の空を返し、**積んだ操作が 1 度も出なかった**。
   * 🔑 偽の保存は書込を**捨てる**(実物と同じ意味論。投げる偽物だと push ごと落ちて別の主張になる)。
   */
  it('🔴 書込だけ失敗する保存でも、積んだ操作がその session の中で読める', () => {
    const dropped: RecentCommandsStorage = { get: () => null, set: () => {}, remove: () => {} };
    const store = new RecentCommandsStore(dropped);
    store.push('a');
    store.push('b');
    expect(store.list(), '書込が失敗した回の控えが読まれていない').toEqual(['b', 'a']);
    store.clear();
    expect(store.list(), '消したのに控えが残っている').toEqual([]);
  });

  it('🔴 保存に 1 件でも在れば保存が正(別のタブの書込が控えに負けない。対照群)', () => {
    const s = fake();
    const store = new RecentCommandsStore(s);
    store.push('mine');
    s.set(KEY, JSON.stringify(['other']));
    expect(store.list()).toEqual(['other']);
  });

  it('🔴 上限 5 ・同じ操作は 1 つ', () => {
    const s = fake();
    const store = new RecentCommandsStore(s);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'c']) store.push(id);
    expect(store.list()).toEqual(['c', 'f', 'e', 'd', 'b']);
  });

  it('🔴 先頭と同じなら書かない(毎回の書込を作らない)', () => {
    const s = fake();
    const store = new RecentCommandsStore(s);
    store.push('a');
    store.push('a');
    store.push('');
    expect(s.writes).toHaveLength(1);
  });

  it('読むたびに保存を引く(別のタブの書込が見える)', () => {
    const s = fake();
    const store = new RecentCommandsStore(s);
    s.set(KEY, JSON.stringify(['other']));
    expect(store.list()).toEqual(['other']);
  });

  it('壊れた保存は空として読む・形の違う行 / 重複 / 上限超えは落とす', () => {
    expect(new RecentCommandsStore(fake('{{{')).list()).toEqual([]);
    expect(new RecentCommandsStore(fake('"x"')).list()).toEqual([]);
    const list = new RecentCommandsStore(
      fake(JSON.stringify([1, null, '', 'ok', 'ok', 'b', 'c', 'd', 'e', 'f', 'g'])),
    ).list();
    expect(list).toEqual(['ok', 'b', 'c', 'd', 'e']);
  });

  it('消すと、保存からも控えからも消える', () => {
    const s = fake();
    const store = new RecentCommandsStore(s);
    store.push('a');
    store.clear();
    expect(s.removed).toBe(1);
    expect(store.list()).toEqual([]);
  });

  /**
   * 🔴 **この端末だけ。書き出し / バックアップ / 設定の持ち出しに載せない**。
   * ⚠ 鍵は 1 つだけを触る。⚠ 運ぶ側の一覧に居ない・運ばない側に理由つきで居る。
   *   (container には書かない ── この store は container を import すらしない。
   *   原文は `recent-commands-store.ts` の import 行で見える)
   */
  it('🔴 鍵は `pkc3.recent-commands` 1 つだけで、設定の持ち出しには乗らない', () => {
    const s = fake();
    const store = new RecentCommandsStore(s);
    store.push('a');
    store.list();
    expect(new Set(s.keys)).toEqual(new Set([KEY]));
    expect(PORTABLE_KEYS.some((p) => p.key === KEY), '運ぶ側に居る').toBe(false);
    const skipped = SKIPPED_KEYS.find((k) => k.key === KEY);
    expect(skipped, '運ばない側に理由つきで載っていない').toBeDefined();
    expect(skipped!.why.length).toBeGreaterThan(10);
  });
});
