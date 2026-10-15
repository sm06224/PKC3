/** @vitest-environment node */
/**
 * 図キャッシュの IDB まわり(#1087)。
 *
 * - 接続が閉じられた / 他タブが版を上げたら、閉じた接続を memo し続けず次に開き直す
 * - 編集プレビュー(途中の原文)の絵は**最古扱い**で置き、他のノートの図より先に追い出される
 *
 * ⚠ node に `indexedDB` は無いので、`get` / `put` / `delete` / カーソルだけの最小の偽物で話す。
 *   実ブラウザでの IDB は `tests/smoke/mermaid.smoke.spec.ts` が見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

function makeFakeIdb() {
  const store = new Map<string, Row>();
  const dbs: FakeDb[] = [];
  let opens = 0;

  class FakeDb {
    onclose: (() => void) | null = null;
    onversionchange: (() => void) | null = null;
    closed = false;
    objectStoreNames = { contains: () => true };
    createObjectStore() {}
    close() {
      this.closed = true;
    }
    transaction() {
      if (this.closed) throw new Error('InvalidStateError: connection is closing');
      const ok = <T>(value: T) => {
        const req: { result: T; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
          result: value,
          onsuccess: null,
          onerror: null,
        };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      };
      const objectStore = () => ({
        get: (k: string) => ok(store.get(k)),
        put: (v: Row, k: string) => {
          store.set(k, v);
          return ok(k);
        },
        delete: (k: string) => {
          store.delete(k);
          return ok(undefined);
        },
        openCursor: () => {
          const entries = [...store.entries()];
          let i = 0;
          const req: { result: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
            result: null,
            onsuccess: null,
            onerror: null,
          };
          const step = () => {
            const e = entries[i];
            req.result = e ? { key: e[0], value: e[1], continue: () => { i += 1; queueMicrotask(step); } } : null;
            req.onsuccess?.();
          };
          queueMicrotask(step);
          return req;
        },
      });
      return { objectStore };
    }
  }

  const indexedDB = {
    open: () => {
      opens += 1;
      const db = new FakeDb();
      dbs.push(db);
      const req: { result: FakeDb; onsuccess: (() => void) | null; onerror: (() => void) | null; onupgradeneeded: (() => void) | null } = {
        result: db,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
  return { indexedDB, store, dbs, opens: () => opens };
}

const PNG = (n: number) => new Blob([new Uint8Array(n)], { type: 'image/png' });
const PALETTE = { bg: '#fff', alt: '#eee', fg: '#000', line: '#666', border: '#ccc', accent: '#080', dark: false };
const key = (source: string, extra: Record<string, unknown> = {}) => ({
  source,
  theme: 'light',
  palette: PALETTE,
  width: 640,
  dpr: 1,
  ...extra,
});

describe('図キャッシュ(IDB)', () => {
  let fake: ReturnType<typeof makeFakeIdb>;
  beforeEach(() => {
    vi.resetModules();
    fake = makeFakeIdb();
    vi.stubGlobal('indexedDB', fake.indexedDB);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('🔴 接続が閉じられたら(onclose)次の呼びで開き直す', async () => {
    const m = await import('../../src/adapter/ui/render/mermaid-raster');
    const produce = async () => ({ png: PNG(10), cssWidth: 100 });
    await m.renderCachedPng(key('a'), produce);
    expect(fake.opens()).toBe(1);
    fake.dbs[0]!.closed = true;
    fake.dbs[0]!.onclose?.();
    await m.renderCachedPng(key('b'), produce);
    expect(fake.opens(), '閉じた接続を使い回している').toBe(2);
    // 新しい接続へは実際に書けている(黙って無効のままではない)
    expect(fake.store.has(m.cacheKey(key('b')))).toBe(true);
  });

  it('🔴 他タブが版を上げたら(onversionchange)接続を閉じ、次の呼びで開き直す', async () => {
    const m = await import('../../src/adapter/ui/render/mermaid-raster');
    const produce = async () => ({ png: PNG(10), cssWidth: 100 });
    await m.renderCachedPng(key('a'), produce);
    fake.dbs[0]!.onversionchange?.();
    expect(fake.dbs[0]!.closed, '版変更の要求を握りつぶしている(他タブを待たせる)').toBe(true);
    await m.renderCachedPng(key('b'), produce);
    expect(fake.opens()).toBe(2);
    expect(fake.store.has(m.cacheKey(key('b')))).toBe(true);
  });

  it('🔴 途中の原文(volatile)の絵は最古扱いで置かれ、他のノートの図より先に追い出される', async () => {
    const m = await import('../../src/adapter/ui/render/mermaid-raster');
    const produce = async () => ({ png: PNG(100), cssWidth: 100 });
    await m.renderCachedPng(key('note-diagram'), produce);
    await m.renderCachedPng(key('typing-1', { volatile: true }), produce);
    await m.renderCachedPng(key('typing-12', { volatile: true }), produce);
    const live = fake.store.get(m.cacheKey(key('typing-12')))!;
    const real = fake.store.get(m.cacheKey(key('note-diagram')))!;
    expect(live.at).toBe(0);
    expect(real.at as number).toBeGreaterThan(0);
    // 上限を超えたら、途中の絵から落ちる(実図は残る)
    // 置いた直後に走る既定の追い出し(`void evictDiagramCache()`)が終わるのを待つ(同時走行は 0 を返す)
    await new Promise((r) => setTimeout(r, 20));
    expect(await m.evictDiagramCache(250)).toBeGreaterThan(0);
    expect(fake.store.has(m.cacheKey(key('note-diagram'))), '有用な図が先に落ちた').toBe(true);
    expect(fake.store.has(m.cacheKey(key('typing-1')))).toBe(false);
  });

  it('volatile でない通常の絵は今の時刻で置かれる(対照群)', async () => {
    const m = await import('../../src/adapter/ui/render/mermaid-raster');
    await m.renderCachedPng(key('x'), async () => ({ png: PNG(10), cssWidth: 1 }));
    expect((fake.store.get(m.cacheKey(key('x')))!.at as number)).toBeGreaterThan(1_000_000);
  });

  it('🔴 chart の焼きは engine(産出器)つきの鍵で貯まる', async () => {
    const m = await import('../../src/adapter/ui/render/mermaid-raster');
    const c = await import('../../src/adapter/ui/render/chart-raster');
    c.setChartWorkerSpawn(() => {
      class W {
        onmessage: ((ev: MessageEvent) => void) | null = null;
        postMessage(msg: { id: number }): void {
          queueMicrotask(() =>
            this.onmessage?.({
              data: { id: msg.id, ok: true, result: { png: new Uint8Array([1]).buffer, cssWidth: 10 } },
            } as MessageEvent),
          );
        }
        terminate(): void {}
      }
      return new W() as unknown as Worker;
    });
    const spec = { type: 'bar', labels: ['a'], datasets: [{ label: 'x', data: [1] }] } as never;
    const rest = { theme: 'light', palette: PALETTE, width: 640, dpr: 1 };
    await c.renderChartToPng('c', spec, rest);
    const stored = [...fake.store.keys()];
    expect(stored.length).toBe(1);
    expect(stored[0]).toBe(m.cacheKey({ ...key('c'), kind: 'chart', engine: c.CHART_ENGINE }));
    expect(stored[0]).toContain(c.CHART_ENGINE);
  });

  it('🔴 volatile の hit は最終使用時刻を新しくしない(対照群: 通常の hit は新しくする)', async () => {
    const m = await import('../../src/adapter/ui/render/mermaid-raster');
    const produce = async () => ({ png: PNG(10), cssWidth: 100 });
    for (const [source, volatile, expectTouched] of [
      ['v', true, false],
      ['n', false, true],
    ] as const) {
      await m.renderCachedPng(key(source), produce);
      const k = m.cacheKey(key(source));
      fake.store.set(k, { ...fake.store.get(k)!, at: 1 });
      await m.renderCachedPng(key(source, volatile ? { volatile: true } : {}), produce);
      await new Promise((r) => setTimeout(r, 10));
      expect((fake.store.get(k)!.at as number) > 1, source).toBe(expectTouched);
    }
  });
});
