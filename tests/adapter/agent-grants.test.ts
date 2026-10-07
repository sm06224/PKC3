/**
 * ブラウザの AI に許した範囲の台帳(#1407 段①)。
 *
 * 守る主張:
 * 1. 既定は許可なし / 憶えるのは「常に許す」だけ(touch だけでは一覧に出ない)
 * 2. 取り消せる(read を外しても write は残る)/ 取り消すと時刻も消える
 * 3. container には入れない(鍵は端末の localStorage の 1 本。他の許可の台帳とは別)
 * 4. 壊れた値・知らない範囲は読むときに捨てる
 * 5. 🔴 保存が使えない端末でも、この session の中では効く(控えを読む枝が生きている)
 */
import { describe, expect, it } from 'vitest';
import { AGENT_GRANTS_KEY, AgentGrants } from '@adapter/platform/agent-grants';
import { EXTENSION_GRANTS_KEY } from '@adapter/platform/extension-grants';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('AgentGrants', () => {
  it('既定は許可なし。touch(今回だけ)では一覧に出ない', () => {
    const g = new AgentGrants(fakeStorage());
    expect(g.isAlways('read')).toBe(false);
    expect(g.isAlways('write')).toBe(false);
    g.touch('read', 10);
    expect(g.isAlways('read')).toBe(false);
    expect(g.list()).toEqual([]);
  });

  it('常に許すを憶える ── 別の台帳(別のタブ)でも読める。最終の時刻も出る', () => {
    const store = fakeStorage();
    new AgentGrants(store).setAlways('read');
    new AgentGrants(store).touch('read', 1234);
    const other = new AgentGrants(store);
    expect(other.isAlways('read')).toBe(true);
    expect(other.isAlways('write')).toBe(false);
    expect(other.list()).toEqual([{ scope: 'read', last: 1234 }]);
  });

  it('許した直後はまだ呼ばれていない(last は null)', () => {
    const g = new AgentGrants(fakeStorage());
    g.setAlways('write');
    expect(g.list()).toEqual([{ scope: 'write', last: null }]);
  });

  it('🔴 取り消せる: read を外しても write は残り、外した範囲の時刻も消える', () => {
    const store = fakeStorage();
    const g = new AgentGrants(store);
    g.setAlways('read');
    g.setAlways('write');
    g.touch('read', 1);
    g.revoke('read');
    expect(g.isAlways('read')).toBe(false);
    expect(g.isAlways('write')).toBe(true);
    expect(g.list().map((r) => r.scope)).toEqual(['write']);
    g.revoke('write');
    // 空になったら鍵ごと消す
    expect(store.map.has(AGENT_GRANTS_KEY)).toBe(false);
    // 再び許すと、消した時刻は戻らない
    g.setAlways('read');
    expect(g.list()).toEqual([{ scope: 'read', last: null }]);
  });

  it('鍵は他の許可の台帳と別(混ぜると、片方を取り消した人の許可がもう片方まで消える)', () => {
    expect(AGENT_GRANTS_KEY).not.toBe(EXTENSION_GRANTS_KEY);
    const store = fakeStorage();
    new AgentGrants(store).setAlways('read');
    expect([...store.map.keys()]).toEqual([AGENT_GRANTS_KEY]);
  });

  it('壊れた値・知らない範囲・型違いは読むときに捨てる(許可なしへ倒れる)', () => {
    const store = fakeStorage();
    const g = new AgentGrants(store);
    for (const raw of ['{broken', '[]', '"read"', 'null', '{"read":{"always":"yes"}}']) {
      store.map.set(AGENT_GRANTS_KEY, raw);
      expect(g.isAlways('read'), raw).toBe(false);
    }
    store.map.set(AGENT_GRANTS_KEY, '{"admin":{"always":true},"read":{"always":true,"last":"x"}}');
    expect(g.list()).toEqual([{ scope: 'read', last: null }]);
    expect(g.isAlways('write')).toBe(false);
  });

  it('🔴 保存が使えない端末(null)でも、この session の中では効く', () => {
    const g = new AgentGrants(null);
    g.setAlways('read');
    g.touch('read', 7);
    expect(g.isAlways('read')).toBe(true);
    expect(g.list()).toEqual([{ scope: 'read', last: 7 }]);
    g.revoke('read');
    expect(g.isAlways('read')).toBe(false);
  });

  it('保存が読み書きで例外を投げても落ちない(控えへ倒れる)', () => {
    const boom = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const g = new AgentGrants(boom);
    g.setAlways('write');
    expect(g.isAlways('write')).toBe(true);
    g.revoke('write');
    expect(g.isAlways('write')).toBe(false);
  });
});
