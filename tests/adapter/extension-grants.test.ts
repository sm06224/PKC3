/**
 * 🔴 **拡張に見取り図を見せる許可**(#195 / C-5 段①)。
 *
 * 🔑 守る主張は 4 つ:
 * 1. 🔴 **素のまま起動の許可とは別の台帳**である(片方を取り消して両方閉じない)
 * 2. 🔴 **中身が 1 バイトでも変われば許可は当たらない**(鍵が内容ハッシュ)
 * 3. 採番 key は**永続化しない**(黙って憶えない)
 * 4. **取り消せる**(期限が無い以上、出口が無いと二度と外せない)
 *
 * ⚠ 機構そのもの(読みの検め・書きの絞り)は `asset-grants.ts` に在り、
 *   `tests/adapter/same-origin-grants.test.ts` が同じ台帳で見ている ──
 *   ここが見るのは「**別の台帳になっていること**」と、拡張側の入口である。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ExtensionGrants,
  EXTENSION_GRANTS_KEY,
} from '../../src/adapter/platform/extension-grants';
import {
  SameOriginGrants,
  SAME_ORIGIN_GRANTS_KEY,
} from '../../src/adapter/platform/same-origin-grants';

/** ⚠ `localStorage` そのものを差し替えない ── 実物を渡す口が在るので使う。 */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** 内容ハッシュの鍵(`asset-key.ts` の形)。 */
const HASH_A = `ast-${'a'.repeat(64)}`;
const HASH_B = `ast-${'b'.repeat(64)}`;

describe('拡張に見取り図を見せる許可 (#195 / C-5 段①)', () => {
  let store: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    store = fakeStorage();
  });

  it('許すと憶えていて、読み込み直しても残る', () => {
    expect(new ExtensionGrants(store).grant(HASH_A), '憶えられなかった').toBe(true);
    // ⚠ **別のインスタンス**で読む(保存を通ったことを見る ── 記憶で答えていない)
    expect(new ExtensionGrants(store).isGranted(HASH_A)).toBe(true);
  });

  /**
   * 🔴 **中身が変われば許可は当たらない** ── lid で憶えていたら、本文を編集した
   * だけで**許した覚えのない中身**が同じ口を持つ。
   */
  it('🔴 中身が違えば当たらない', () => {
    const g = new ExtensionGrants(store);
    g.grant(HASH_A);
    expect(g.isGranted(HASH_B), '別の中身に許可が当たっている').toBe(false);
  });

  /**
   * 🔴 **素のまま起動(#301)とは別の台帳**。
   * ⚠ 混ぜると、素のまま起動を取り消した人の拡張の口まで黙って閉じる(逆も同じ)。
   */
  it('🔴 素のまま起動の許可とは混ざらない', () => {
    new ExtensionGrants(store).grant(HASH_A);
    // 対照群 ── 同じ中身でも、あちらの台帳は空のまま
    expect(new SameOriginGrants(store).isGranted(HASH_A), '素のまま起動まで許している').toBe(
      false,
    );
    expect(EXTENSION_GRANTS_KEY, '置き場の鍵が同じ').not.toBe(SAME_ORIGIN_GRANTS_KEY);
    // ⚠ 空振り防止 ── 実際に別の鍵で書かれている
    expect([...store.map.keys()]).toEqual([EXTENSION_GRANTS_KEY]);
  });

  it('片方を取り消しても、もう片方は残る', () => {
    new ExtensionGrants(store).grant(HASH_A);
    new SameOriginGrants(store).grant(HASH_A);
    new SameOriginGrants(store).revokeAll();
    expect(new ExtensionGrants(store).isGranted(HASH_A), '拡張の許可まで消えた').toBe(true);
  });

  it('採番 key は憶えない(中身を指していないので「同じハッシュ」を名乗れない)', () => {
    const g = new ExtensionGrants(store);
    expect(g.grant('ast-0001')).toBe(false);
    expect(g.isGranted('ast-0001')).toBe(false);
    expect(store.map.size, '憶えないと言いながら書いている').toBe(0);
  });

  it('🔴 取り消せる(出口が無いと二度と外せない)', () => {
    const g = new ExtensionGrants(store);
    g.grant(HASH_A);
    g.grant(HASH_B);
    g.revoke(HASH_A);
    expect(g.list()).toEqual([HASH_B]);
    g.revokeAll();
    expect(g.list()).toEqual([]);
    // ⚠ 空になったら鍵ごと消す(要らない行を残さない)
    expect(store.map.has(EXTENSION_GRANTS_KEY)).toBe(false);
  });

  it('憶えられない環境でも落ちない(許可が付かないだけ)', () => {
    const g = new ExtensionGrants(null);
    expect(g.grant(HASH_A)).toBe(false);
    expect(g.isGranted(HASH_A)).toBe(false);
    expect(g.list()).toEqual([]);
  });
});
