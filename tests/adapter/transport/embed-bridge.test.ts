/** @vitest-environment happy-dom */
/**
 * 受け口を「張るかどうか」と、許す相手の一覧を検める(#189 / C-4 段①)。
 *
 * 🔴 **flag を無視して常に張る**型の取り違えを、ここで殺す ── `src/main.ts` に
 * 直書きすると原文 pin しか無く、この誤りが**全 test 緑のまま**通る。
 */
import { describe, expect, it } from 'vitest';
import { EmbedOriginsStore } from '../../../src/adapter/transport/embed-origins';
import { SERVED, servedAreKnown, startEmbedBridge } from '../../../src/adapter/transport/embed-bridge';
import { METHODS } from '../../../src/adapter/transport/protocol';

function fakeStorage(initial?: string): Storage {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set('pkc3.embed-origins', initial);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe('埋め込みの受け口を張るか', () => {
  it('🔴 flag が false なら張らない(listener を 1 つも足さない)', () => {
    let added = 0;
    const target = {
      addEventListener: () => (added += 1),
      removeEventListener: () => undefined,
    } as unknown as Window;
    expect(startEmbedBridge({ enabled: false, origins: () => ['*'], target })).toBeNull();
    expect(added, 'flag が false なのに張っている').toBe(0);
  });

  it('flag が true なら張り、返り値で外せる', () => {
    let added = 0;
    let removed = 0;
    const target = {
      addEventListener: () => (added += 1),
      removeEventListener: () => (removed += 1),
    } as unknown as Window;
    const detach = startEmbedBridge({ enabled: true, origins: () => [], target });
    expect(detach).not.toBeNull();
    expect(added).toBe(1);
    detach?.();
    expect(removed).toBe(1);
  });

  it('🔴 段① が申告するのは読み取りだけ(まだ無い書込を「あります」と言わない)', () => {
    expect(SERVED).toEqual(['pkc.hello', 'pkc.ping']);
    expect(SERVED, '段① で書込を申告している').not.toContain('pkc.createEntry');
    // ⚠ 申告が約束の外へはみ出していないこと(空振り防止に約束の側も数える)
    expect(METHODS.length).toBeGreaterThanOrEqual(SERVED.length);
    expect(servedAreKnown()).toBe(true);
  });
});

describe('許す origin の一覧', () => {
  it('🔴 既定は空 ── flag を立てただけでは誰も通らない', () => {
    expect(new EmbedOriginsStore(fakeStorage()).list()).toEqual([]);
  });

  it('🔴 壊れていたら空にする(読めないものを「全部許す」と読まない)', () => {
    expect(new EmbedOriginsStore(fakeStorage('{')).list()).toEqual([]);
    expect(new EmbedOriginsStore(fakeStorage('"https://a.test"')).list()).toEqual([]);
    expect(new EmbedOriginsStore(fakeStorage('[1,2,3]')).list()).toEqual([]);
  });

  it('🔴 path 付きで渡されても origin へ落とす(突合が永久に外れないように)', () => {
    const s = new EmbedOriginsStore(fakeStorage());
    s.set(['https://a.test/some/path?q=1', ' https://b.test ', 'これは URL ではない', '*', 'null']);
    expect(s.list()).toEqual(['https://a.test', 'https://b.test', '*', 'null']);
  });

  it('同じものは 1 つに畳む', () => {
    const s = new EmbedOriginsStore(fakeStorage());
    s.set(['https://a.test', 'https://a.test/x', 'https://a.test']);
    expect(s.list()).toEqual(['https://a.test']);
  });

  it('storage が無くても落ちない(読めば空)', () => {
    const s = new EmbedOriginsStore(null);
    s.set(['https://a.test']);
    expect(s.list()).toEqual([]);
  });
});
