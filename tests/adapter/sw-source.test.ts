/** @vitest-environment node */
/**
 * P7 段④: Service Worker の中身。
 *
 * 🔴 **生成した文字列を実際に評価して振る舞いを見る**。文字列一致で見ると
 * 「それらしい形」に救われる ── `'network-first'` という語がコメントに在るだけで
 * 通ってしまう。偽の worker global を作り、`install` / `activate` / `fetch` を
 * **実際に発火**させて、どの Response が返るかを assert する。
 */
import { describe, expect, it } from 'vitest';
import { CACHE_PREFIX, cacheNameFor, shouldPrecache, swSource } from '../../src/adapter/platform/sw/sw-source';

/**
 * 偽の Cache API。⚠ **本物の意味論を真似る**(CLAUDE.md)── とくに **Vary**。
 *
 * 🔴 ここを省くと、実ブラウザだけで壊れる形を作れない。実際に踏んだ:
 * precache は `addAll` で入るので request に `Origin` が無いが、実際の
 * module script は `crossorigin` 付きで `Origin` を送る ── 応答が
 * `Vary: Origin` を持つと(`vite preview` が実際に付ける)照合が外れ、
 * **オフラインで本体が読めない**。unit は全部緑のまま、実機だけ白紙になった。
 */
class FakeCache {
  /** key → { body, varyOrigin }(precache 由来は varyOrigin なし)。 */
  readonly store = new Map<string, { body: string; varyOrigin: string | null }>();
  addAll(urls: string[]): Promise<void> {
    for (const u of urls) {
      if (u.includes('missing')) return Promise.reject(new Error(`404: ${u}`));
      // addAll は Origin を送らない ── 応答は Vary: Origin つき(= 素の cache)
      this.store.set(u, { body: `cached:${u}`, varyOrigin: null });
    }
    return Promise.resolve();
  }
  put(req: { url: string; origin?: string }, res: unknown): Promise<void> {
    this.store.set(new URL(req.url).pathname.replace(/^\//, './'), {
      body: String(res),
      varyOrigin: req.origin ?? null,
    });
    return Promise.resolve();
  }
  lookup(
    req: { url: string; origin?: string } | string,
    opts?: { ignoreVary?: boolean },
  ): string | undefined {
    const key = typeof req === 'string' ? req : `.${new URL(req.url).pathname}`;
    const hit = this.store.get(key);
    if (!hit) return undefined;
    // Vary: Origin ── 保存時と要求時の Origin が違えば**当たらない**
    const reqOrigin = typeof req === 'string' ? null : (req.origin ?? null);
    if (!opts?.ignoreVary && hit.varyOrigin !== reqOrigin) return undefined;
    return hit.body;
  }
  match(
    req: { url: string; origin?: string } | string,
    opts?: { ignoreVary?: boolean },
  ): Promise<string | undefined> {
    return Promise.resolve(this.lookup(req, opts));
  }
}

interface Harness {
  caches: Map<string, FakeCache>;
  fire(type: 'install' | 'activate'): Promise<void>;
  /** fetch を発火し、SW が返した body(または `null` = 素通し)を返す。 */
  fetch(
    url: string,
    opts?: {
      mode?: string;
      method?: string;
      network?: 'ok' | 'fail' | 'error';
      /** ⚠ 実要求は Origin を送る。precache 側は送らない ── Vary の食い違い */
      origin?: string | undefined;
    },
  ): Promise<string | null>;
  claimed: () => boolean;
  skipped: () => boolean;
}

function runSw(source: string, seed?: (c: Map<string, FakeCache>) => void): Harness {
  const cacheMap = new Map<string, FakeCache>();
  seed?.(cacheMap);
  const listeners = new Map<string, (ev: unknown) => void>();
  let claimed = false;
  let skipped = false;
  let netMode: 'ok' | 'fail' | 'error' = 'ok';

  const caches = {
    open: (name: string) => {
      let c = cacheMap.get(name);
      if (!c) cacheMap.set(name, (c = new FakeCache()));
      return Promise.resolve(c);
    },
    keys: () => Promise.resolve([...cacheMap.keys()]),
    delete: (name: string) => Promise.resolve(cacheMap.delete(name)),
    match: (req: { url: string; origin?: string } | string, opts?: { ignoreVary?: boolean }) => {
      for (const c of cacheMap.values()) {
        const hit = c.lookup(req, opts);
        if (hit !== undefined) return Promise.resolve(hit);
      }
      return Promise.resolve(undefined);
    },
  };

  const self = {
    location: { origin: 'https://pkc3.example' },
    addEventListener: (type: string, fn: (ev: unknown) => void) => void listeners.set(type, fn),
    skipWaiting: () => {
      skipped = true;
      return Promise.resolve();
    },
    clients: {
      claim: () => {
        claimed = true;
        return Promise.resolve();
      },
    },
  };

  const fetchImpl = (req: { url: string }): Promise<unknown> => {
    if (netMode === 'fail') return Promise.reject(new Error('offline'));
    if (netMode === 'error') return Promise.resolve({ ok: false, clone: () => 'net-err' });
    return Promise.resolve({
      ok: true,
      clone: () => `net:${req.url}`,
      toString: () => `net:${req.url}`,
    });
  };

  // ⚠ `new Function` で**実物の文字列**を走らせる(写しを作らない)
  const run = new Function('self', 'caches', 'fetch', 'URL', source) as (
    s: unknown,
    c: unknown,
    f: unknown,
    u: unknown,
  ) => void;
  run(self, caches, fetchImpl, URL);

  const waits: Array<Promise<unknown>> = [];
  return {
    caches: cacheMap,
    claimed: () => claimed,
    skipped: () => skipped,
    async fire(type) {
      waits.length = 0;
      listeners.get(type)?.({ waitUntil: (p: Promise<unknown>) => void waits.push(p) });
      await Promise.all(waits);
    },
    async fetch(url, opts: {
      mode?: string;
      method?: string;
      network?: 'ok' | 'fail' | 'error';
      origin?: string | undefined;
    } = {}) {
      netMode = opts.network ?? 'ok';
      let responded: unknown = null;
      listeners.get('fetch')?.({
        request: {
          url,
          mode: opts.mode ?? 'no-cors',
          method: opts.method ?? 'GET',
          // ⚠ 実ブラウザの module script は `crossorigin` 付きで **Origin を送る**
          origin: opts.origin ?? 'https://pkc3.example',
        },
        respondWith: (p: unknown) => void (responded = p),
      });
      if (responded === null) return null; // 素通し(respondWith を呼んでいない)
      return String(await responded);
    },
  };
}

const SOURCE = swSource({
  buildId: 'b1',
  precache: ['./index.html', './manifest.webmanifest', './assets/index-AAAAAAAA.js'],
});

describe('規則(純関数)', () => {
  it('cache 名に build id が入る', () => {
    expect(cacheNameFor('b1')).toBe('pkc3-b1');
    expect(cacheNameFor('b1').startsWith(CACHE_PREFIX)).toBe(true);
  });

  it.each([
    ['index.html', true],
    ['assets/index-AAAAAAAA.js', true],
    ['assets/sqlite3-BBBBBBBB.wasm', true],
    ['assets/index-AAAAAAAA.js.map', false], // ⚠ dev では 3.2MB ある
    ['sw.js', false], // SW 自身は SW が配らない
  ])('precache 対象: %s → %s', (path, expected) => {
    expect(shouldPrecache(path)).toBe(expected);
  });
});

describe('install ── 一覧を丸ごと入れる', () => {
  it('precache 一覧が cache に入り、待たずに交代する', async () => {
    const h = runSw(SOURCE);
    await h.fire('install');
    expect([...h.caches.keys()]).toEqual(['pkc3-b1']);
    expect([...h.caches.get('pkc3-b1')!.store.keys()]).toEqual([
      './index.html',
      './manifest.webmanifest',
      './assets/index-AAAAAAAA.js',
    ]);
    expect(h.skipped()).toBe(true);
  });

  it('🔴 1 件でも入らなければ install ごと失敗する', async () => {
    // ⚠ 半端な cache でオフラインに入ると「開くのに中身が無い」という、
    // いちばん分からない壊れ方をする
    const h = runSw(swSource({ buildId: 'b1', precache: ['./ok.js', './missing.js'] }));
    await expect(h.fire('install')).rejects.toThrow('404');
    expect(h.skipped()).toBe(false);
  });
});

describe('activate ── 古い cache を消す', () => {
  it('🔴 自分以外の PKC3 cache を消す(消さないと無限に積み上がる)', async () => {
    const h = runSw(SOURCE, (c) => {
      c.set('pkc3-old1', new FakeCache());
      c.set('pkc3-old2', new FakeCache());
      c.set('pkc3-b1', new FakeCache());
    });
    await h.fire('activate');
    expect([...h.caches.keys()]).toEqual(['pkc3-b1']);
    expect(h.claimed()).toBe(true);
  });

  it('🔴 他人の cache は消さない(前置きで自分のものだけを選ぶ)', async () => {
    const h = runSw(SOURCE, (c) => {
      c.set('someone-else', new FakeCache());
      c.set('pkc3-old', new FakeCache());
    });
    await h.fire('activate');
    expect([...h.caches.keys()].sort()).toEqual(['someone-else']);
  });
});

describe('fetch ── 経路ごとの戦略', () => {
  const seeded = async (): Promise<Harness> => {
    const h = runSw(SOURCE);
    await h.fire('install');
    return h;
  };

  it('🔴 navigation は network-first(新しい版が届く)', async () => {
    // ⚠ cache-first にすると**新しい版が永久に届かない**(PWA の定番事故)
    const h = await seeded();
    expect(await h.fetch('https://pkc3.example/index.html', { mode: 'navigate' })).toBe(
      'net:https://pkc3.example/index.html',
    );
  });

  it('🔴 オフラインの navigation は cache から返る(白紙にしない)', async () => {
    const h = await seeded();
    expect(
      await h.fetch('https://pkc3.example/index.html', { mode: 'navigate', network: 'fail' }),
    ).toBe('cached:./index.html');
  });

  it('オフラインで未知の URL へ navigate しても index.html を返す', async () => {
    const h = await seeded();
    expect(
      await h.fetch('https://pkc3.example/なにか', { mode: 'navigate', network: 'fail' }),
    ).toBe('cached:./index.html');
  });

  it('🔴 hash 付き生成物は cache-first(オフラインでも起動する)', async () => {
    const h = await seeded();
    expect(await h.fetch('https://pkc3.example/assets/index-AAAAAAAA.js')).toBe(
      'cached:./assets/index-AAAAAAAA.js',
    );
    // オフラインでも同じ
    expect(
      await h.fetch('https://pkc3.example/assets/index-AAAAAAAA.js', { network: 'fail' }),
    ).toBe('cached:./assets/index-AAAAAAAA.js');
  });

  it('hash 無しは network-first で cache に落ちる', async () => {
    const h = await seeded();
    // オンラインでは**新しい方**が返る(cache は更新される)
    expect(await h.fetch('https://pkc3.example/manifest.webmanifest')).toBe(
      'net:https://pkc3.example/manifest.webmanifest',
    );
    // 次はオフラインでも返せる ── ⚠ 中身は**さっき取れた新しい方**
    expect(
      await h.fetch('https://pkc3.example/manifest.webmanifest', { network: 'fail' }),
    ).toBe('net:https://pkc3.example/manifest.webmanifest');
  });

  it('🔴 network-first でも失敗応答は cache を汚さない', async () => {
    // ⚠ 404 / 503 を cache に入れると、オフラインでそれが返って
    // 「壊れているが動いているように見える」状態になる
    const h = await seeded();
    await h.fetch('https://pkc3.example/manifest.webmanifest', { network: 'error' });
    expect(
      await h.fetch('https://pkc3.example/manifest.webmanifest', { network: 'fail' }),
    ).toBe('cached:./manifest.webmanifest'); // precache のまま
  });

  it('cache にも無くオフラインなら**失敗する**(嘘の空応答を返さない)', async () => {
    const h = await seeded();
    await expect(
      h.fetch('https://pkc3.example/知らない.json', { network: 'fail' }),
    ).rejects.toThrow('offline');
  });

  it('🔴 Vary: Origin があっても cache が当たる(実機だけ白紙、を作らない)', async () => {
    // precache は Origin を送らずに入り、実際の module script は Origin を送る。
    // `ignoreVary` が無いと照合が外れ、**オフラインで本体が読めない**
    // ── unit が全部緑のまま実ブラウザだけ白紙になった、実際の形
    const h = await seeded();
    expect(
      await h.fetch('https://pkc3.example/assets/index-AAAAAAAA.js', {
        network: 'fail',
        origin: 'https://pkc3.example', // 要求側は Origin あり / cache 側は無し
      }),
    ).toBe('cached:./assets/index-AAAAAAAA.js');
  });

  it('🔴 GET 以外と外部 origin は**素通し**(respondWith を呼ばない)', async () => {
    // ⚠ 触ると POST が壊れ、外部 URL は CORS 事故になる
    const h = await seeded();
    expect(await h.fetch('https://pkc3.example/x', { method: 'POST' })).toBe(null);
    expect(await h.fetch('https://other.example/x.js')).toBe(null);
  });
});
