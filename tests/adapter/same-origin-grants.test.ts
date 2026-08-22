/**
 * 🔴 **「素のまま起動」の許可を憶える**(#301。user 裁定 2026-08-21)。
 *
 * > 「**同じハッシュのアプリ登録済みの URL もしくは HTML に関しては永続化
 * > (文字通りの永続化、期間とかない)**」
 *
 * 守る主張は 4 つ:
 * 1. **登録済み + 中身のハッシュ**のときだけ、読み込み直しても憶えている
 * 2. **中身が 1 バイトでも変われば許可は当たらない**(鍵が内容ハッシュだから)
 * 3. 登録していないもの・採番 key は**永続化しない**(黙って憶えない)
 * 4. **取り消せる**(期限が無い以上、出口が無いと二度と外せない)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SameOriginGate,
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

/** 中身のハッシュの鍵(`asset-key.ts` の形)。⚠ 64 桁の 16 進。 */
const hashKey = (seed: string): string => `ast-${seed.repeat(64).slice(0, 64)}`;
const KEY_A = hashKey('a');
const KEY_B = hashKey('b');
/** 採番 key(64MB 超 / PKC2 由来)── 中身を指していない。 */
const NUMBERED = 'ast-n-000123';

describe('許可の台帳(SameOriginGrants)', () => {
  let st: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    st = fakeStorage();
  });

  it('🔴 憶えたら、別のインスタンス(= 読み込み直し)でも憶えている', () => {
    expect(new SameOriginGrants(st).grant(KEY_A)).toBe(true);
    // 🔑 **別のインスタンスで見る**のが肝 ── 同じインスタンスで見ると、
    //    メモリに持っているだけの実装でも通ってしまう(永続化の検査にならない)
    expect(new SameOriginGrants(st).isGranted(KEY_A), '読み込み直したら忘れている').toBe(true);
  });

  it('🔴 中身が変われば別の鍵になり、許可は当たらない', () => {
    new SameOriginGrants(st).grant(KEY_A);
    expect(new SameOriginGrants(st).isGranted(KEY_B), '別の中身に許可が当たった').toBe(false);
  });

  it('🔴 採番 key は憶えない(中身を指していないので「同じハッシュ」を名乗れない)', () => {
    const g = new SameOriginGrants(st);
    expect(g.grant(NUMBERED), '憶えたと言っている').toBe(false);
    expect(g.isGranted(NUMBERED)).toBe(false);
    expect(st.map.has(SAME_ORIGIN_GRANTS_KEY), '保存に書き込んでいる').toBe(false);
  });

  it('鍵が無ければ常に偽(また聞く)', () => {
    const g = new SameOriginGrants(st);
    expect(g.isGranted(undefined)).toBe(false);
    expect(g.isGranted(null)).toBe(false);
    expect(g.grant(null)).toBe(false);
  });

  it('🔴 取り消せる。空になったら鍵ごと消す(要らない行を残さない)', () => {
    const g = new SameOriginGrants(st);
    g.grant(KEY_A);
    g.grant(KEY_B);
    g.revoke(KEY_A);
    expect(g.list()).toEqual([KEY_B]);
    g.revoke(KEY_B);
    expect(st.map.has(SAME_ORIGIN_GRANTS_KEY), '空の行が残っている').toBe(false);
  });

  it('全部取り消せる', () => {
    const g = new SameOriginGrants(st);
    g.grant(KEY_A);
    g.grant(KEY_B);
    g.revokeAll();
    expect(g.list()).toEqual([]);
  });

  it('同じものを 2 度憶えても重複しない', () => {
    const g = new SameOriginGrants(st);
    g.grant(KEY_A);
    g.grant(KEY_A);
    expect(g.list()).toEqual([KEY_A]);
  });

  /**
   * 🔴 **この保存はアプリ自身が書き換えられる**(同じ origin で走るので)。
   * だから**読み側で必ず絞る** ── 壊れた値を信じると、許した覚えのない鍵が
   * 「許可済み」として通る。
   */
  it('🔴 壊れた値・配列でない値・採番 key は、読むときに捨てる', () => {
    const g = new SameOriginGrants(st);
    for (const bad of ['{', 'null', '"x"', '{"a":1}', '123']) {
      st.map.set(SAME_ORIGIN_GRANTS_KEY, bad);
      expect(g.list(), `壊れた値を読んでしまった: ${bad}`).toEqual([]);
    }
    // 🔑 **混ざっているとき**も肝 ── 良い鍵だけ残し、悪い鍵は落とす
    st.map.set(SAME_ORIGIN_GRANTS_KEY, JSON.stringify([KEY_A, NUMBERED, 42, null, KEY_B]));
    expect(g.list()).toEqual([KEY_A, KEY_B]);
    expect(g.isGranted(NUMBERED), '採番 key が通ってしまった').toBe(false);
  });

  it('保存が使えない環境でも落ちない(憶えられないだけ)', () => {
    const g = new SameOriginGrants(null);
    expect(g.grant(KEY_A)).toBe(false);
    expect(g.isGranted(KEY_A)).toBe(false);
    expect(g.list()).toEqual([]);
    expect(() => g.revoke(KEY_A)).not.toThrow();
  });
});

describe('聞くか / 憶えるかの判断(SameOriginGate)', () => {
  let st: ReturnType<typeof fakeStorage>;
  const gate = () => new SameOriginGate(new SameOriginGrants(st));
  beforeEach(() => {
    st = fakeStorage();
  });

  it('🔴 登録済み + 中身のハッシュ → ずっと憶える(読み込み直しても聞かない)', () => {
    const seen = { lid: 'e1', assetKey: KEY_A, registered: true };
    expect(gate().allows(seen), '前提が崩れている(最初から許可済み)').toBe(false);
    expect(gate().remember(seen)).toBe('hash');
    // 🔑 **新しい gate で見る** = 読み込み直し(session の Set は空から始まる)
    expect(gate().allows(seen), '読み込み直したら忘れている').toBe(true);
  });

  it('🔴 登録していないものは永続化しない ── その画面を開いている間だけ', () => {
    const seen = { lid: 'e1', assetKey: KEY_A, registered: false };
    const g = gate();
    expect(g.remember(seen)).toBe('session');
    expect(g.allows(seen), '同じ画面の中で忘れている').toBe(true);
    // 🔑 読み込み直したら消える
    expect(gate().allows(seen), '登録していないのに永続化された').toBe(false);
    expect(st.map.has(SAME_ORIGIN_GRANTS_KEY), '保存に書き込んでいる').toBe(false);
  });

  it('🔴 登録済みでも採番 key なら永続化しない(黙って憶えない)', () => {
    const seen = { lid: 'e1', assetKey: NUMBERED, registered: true };
    expect(gate().remember(seen), '中身を指していない鍵を永続化した').toBe('session');
    expect(gate().allows(seen)).toBe(false);
  });

  it('🔴 中身が入れ替わったら、また聞く', () => {
    gate().remember({ lid: 'e1', assetKey: KEY_A, registered: true });
    // 同じノート(lid)のまま、中身だけ差し替わった状態
    expect(
      gate().allows({ lid: 'e1', assetKey: KEY_B, registered: true }),
      '中身が変わったのに許可が当たった(lid で憶えている)',
    ).toBe(false);
  });

  it('🔴 登録を外したら、憶えていても効かない', () => {
    gate().remember({ lid: 'e1', assetKey: KEY_A, registered: true });
    expect(
      gate().allows({ lid: 'e1', assetKey: KEY_A, registered: false }),
      '登録を外したのに素のまま開ける',
    ).toBe(false);
  });

  it('取り消したら、また聞く', () => {
    const seen = { lid: 'e1', assetKey: KEY_A, registered: true };
    gate().remember(seen);
    const g = gate();
    expect(g.list()).toEqual([KEY_A]);
    g.revoke(KEY_A);
    expect(gate().allows(seen), '取り消したのに許可が残っている').toBe(false);
  });

  /**
   * ⚠ **画面の記憶(lid)と、憶えた許可(ハッシュ)は別物**である。
   *   取り消しでこちらまで消すと、「いま開いているアプリが途中で締め出される」。
   */
  it('取り消しは、その画面の記憶には触らない', () => {
    const g = gate();
    g.remember({ lid: 'e1', assetKey: KEY_A, registered: false });
    g.revoke(KEY_A);
    expect(g.allows({ lid: 'e1', assetKey: KEY_A, registered: false })).toBe(true);
  });
});
