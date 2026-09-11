/**
 * 🔴 **最近開いた記録の置き場**(#215 残り①)。
 *
 * ⚠ 規則は `tests/features/opened-log.test.ts` が見る ── ここは
 *   「**保存が使えない端末でも効くか**」と「**無駄に書かないか**」だけを見る。
 */
import { describe, expect, it } from 'vitest';
import { OpenedStore, type OpenedStorage } from '../../src/adapter/platform/opened-store';

/** 偽の保存 ── 書込の**回数と中身**まで観測する。 */
function fake(initial: string | null = null): OpenedStorage & { writes: string[]; removed: number } {
  let value = initial;
  const writes: string[] = [];
  return {
    writes,
    removed: 0,
    get: () => value,
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

describe('最近開いた記録の置き場(#215 残り①)', () => {
  it('積むと保存へ書き、読み直すと同じ物が返る', () => {
    const s = fake();
    const store = new OpenedStore(s);
    store.push('n1', 100);
    expect(s.writes, '保存へ書いていない').toHaveLength(1);
    expect(store.map().get('n1')).toBe(100);
  });

  /**
   * 🔴 **保存が使えない端末でも、その session の中では効く**(#278 段②の教訓)。
   * ⚠ `?.` で書くと `null` は例外を投げないので、控えが**死んだ枝**になる ──
   *   その形だと、ここが落ちる。
   */
  it('🔴 保存が無い端末でも、積んだ物をその場で読み直せる', () => {
    const store = new OpenedStore(null);
    store.push('n1', 100);
    store.push('n2', 200);
    expect([...store.map().keys()], '控えが読まれていない(無言の dead click)').toEqual([
      'n2',
      'n1',
    ]);
  });

  /**
   * ⚠ **減らないなら書かない** ── 起動のたびに書くと、何も変わっていない日でも
   *   localStorage を触ることになる。
   */
  it('🔴 掃除は、落ちる行が在るときだけ書く', () => {
    const s = fake(JSON.stringify([{ lid: 'alive', at: 2 }]));
    const store = new OpenedStore(s);
    store.prune(() => true);
    expect(s.writes, '落ちる行が無いのに書いた').toHaveLength(0);
    store.prune((lid) => lid !== 'alive');
    expect(s.writes, '落ちる行が在るのに書いていない').toHaveLength(1);
  });

  it('消すと、保存からも控えからも消える', () => {
    const s = fake();
    const store = new OpenedStore(s);
    store.push('n1', 1);
    store.clear();
    expect(store.map().size, '消したのに残っている').toBe(0);
  });

  /** ⚠ 壊れた JSON で画面ごと落とさない(空として読む)。 */
  it('壊れた保存は空として読む', () => {
    expect(new OpenedStore(fake('{{{')).map().size).toBe(0);
    expect(new OpenedStore(fake('"not an array"')).map().size).toBe(0);
  });

  /** ⚠ 形の違う行は落とす(lid が無い / 空)。 */
  it('形の違う行は落とす', () => {
    const s = fake(JSON.stringify([{ at: 1 }, { lid: '', at: 2 }, { lid: 'ok', at: 3 }]));
    expect([...new OpenedStore(s).map().keys()]).toEqual(['ok']);
  });
});
