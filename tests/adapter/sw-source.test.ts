/** @vitest-environment node */
/**
 * P7 段④: Service Worker の中身。
 *
 * 🔴 **生成した文字列を実際に評価して振る舞いを見る**。文字列一致で見ると
 * 「それらしい形」に救われる ── `'network-first'` という語がコメントに在るだけで
 * 通ってしまう。偽の worker global を作り、`install` / `activate` / `fetch` を
 * **実際に発火**させて、どの Response が返るかを assert する。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CACHE_PREFIX,
  cacheNameFor,
  isStaleCache,
  shouldPrecache,
  swSource,
} from '../../src/adapter/platform/sw/sw-source';

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
  /**
   * ⚠ 本物の `addAll` は **all-or-nothing**(1 件でも落ちれば 1 件も入らない)。
   * ここを「落ちるまで入れる」と書くと、**半端な cache が残る**形を test で
   * 作れてしまい、実装の半端さを stub が肩代わりする。
   */
  addAll(urls: string[]): Promise<void> {
    const staged = new Map<string, { body: string; varyOrigin: string | null }>();
    for (const u of urls) {
      if (u.includes('missing')) return Promise.reject(new Error(`404: ${u}`));
      // addAll は Origin を送らない ── 応答は Vary: Origin つき(= 素の cache)
      staged.set(u, { body: `cached:${u}`, varyOrigin: null });
    }
    for (const [k, v] of staged) this.store.set(k, v);
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
  /** ⚠ 本物の `Cache.keys()`(件数を数える検査に要る)。 */
  keys(): Promise<string[]> {
    return Promise.resolve([...this.store.keys()]);
  }
}

interface Harness {
  caches: Map<string, FakeCache>;
  fire(type: 'install' | 'activate'): Promise<void>;
  /** アプリからの合図(P7 段⑤)。返るのは `waitUntil` に渡された promise の数。 */
  message(data: unknown): number;
  /** fetch を発火し、SW が返した body(または `null` = 素通し)を返す。 */
  fetch(
    url: string,
    opts?: {
      mode?: string;
      method?: string;
      network?: 'ok' | 'fail' | 'error' | 'partial';
      /** ⚠ 実要求は Origin を送る。precache 側は送らない ── Vary の食い違い */
      origin?: string | undefined;
    },
  ): Promise<string | null>;
  claimed: () => boolean;
  skipped: () => boolean;
}

function runSw(
  source: string,
  seed?: (c: Map<string, FakeCache>) => void,
  scope = 'https://pkc3.example/',
): Harness {
  const cacheMap = new Map<string, FakeCache>();
  seed?.(cacheMap);
  const listeners = new Map<string, (ev: unknown) => void>();
  let claimed = false;
  let skipped = false;
  let netMode: 'ok' | 'fail' | 'error' | 'partial' = 'ok';

  const caches = {
    open: (name: string) => {
      let c = cacheMap.get(name);
      if (!c) cacheMap.set(name, (c = new FakeCache()));
      return Promise.resolve(c);
    },
    keys: () => Promise.resolve([...cacheMap.keys()]),
    delete: (name: string) => Promise.resolve(cacheMap.delete(name)),
    /**
     * 🔴 **本物の意味論を真似る**(CLAUDE.md)── `cacheName` を渡したら
     * **その cache だけ**を見て、無ければ `undefined`(他所は舐めない)。
     *
     * ⚠ ここを「常に全部の cache を舐める」と書いていたせいで、
     * 「自分の cache 以外は覗かない」test が **`cacheName` の有無を見分けられず**
     * 空振りしていた ── stub が実装より緩いと、その分だけ test が何も守らない。
     */
    match: (
      req: { url: string; origin?: string } | string,
      opts?: { ignoreVary?: boolean; cacheName?: string },
    ) => {
      if (opts?.cacheName !== undefined) {
        const named = cacheMap.get(opts.cacheName);
        return Promise.resolve(named ? named.lookup(req, opts) : undefined);
      }
      for (const c of cacheMap.values()) {
        const hit = c.lookup(req, opts);
        if (hit !== undefined) return Promise.resolve(hit);
      }
      return Promise.resolve(undefined);
    },
  };

  const self = {
    location: { origin: 'https://pkc3.example' },
    // ⚠ SW は scope を知っている ── cache 名を scope で分けるのに使う
    registration: { scope: scope },
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
    // ⚠ **status を持たせる**。`ok` だけだと 206(Partial)を素通しする実装でも
    // 通ってしまう ── `Cache.put` は 206 で TypeError を投げる(review L-4)
    if (netMode === 'error') {
      return Promise.resolve({ ok: false, status: 503, clone: () => 'net-err' });
    }
    if (netMode === 'partial') {
      return Promise.resolve({ ok: true, status: 206, clone: () => `net:${req.url}` });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
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
    message(data) {
      // ⚠ 本物の ExtendableMessageEvent は `waitUntil` を持つ ── 渡さないと
      // 「waitUntil で囲っているか」を見分けられない(stub が緩いと test が空振り)
      const held: Array<Promise<unknown>> = [];
      listeners.get('message')?.({ data, waitUntil: (p: Promise<unknown>) => void held.push(p) });
      return held.length;
    },
    async fetch(url, opts: {
      mode?: string;
      method?: string;
      network?: 'ok' | 'fail' | 'error' | 'partial';
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
  it('cache 名に scope と build id が入る', () => {
    expect(cacheNameFor('/', 'b1')).toBe('pkc3:%2F:b1');
    expect(cacheNameFor('/dev/', 'b1')).toBe('pkc3:%2Fdev%2F:b1');
    expect(cacheNameFor('/', 'b1').startsWith(CACHE_PREFIX)).toBe(true);
  });

  // 🔴 CacheStorage は **origin 単位で scope 単位ではない**。Pages は同じ origin に
  // `/` と `/dev/` を置くので、ここを間違えると **`/` を開いただけで `/dev/` の
  // precache が消える**(review H-1 で実証)。⚠ `/` は `/dev/` の接頭辞なので
  // `startsWith` では分けられない
  it.each([
    ['同じ scope の古い版', 'pkc3:%2F:old', '/', 'b1', true],
    ['同じ scope の自分', 'pkc3:%2F:b1', '/', 'b1', false],
    ['🔴 別 scope の古い版', 'pkc3:%2Fdev%2F:old', '/', 'b1', false],
    ['🔴 別 scope の自分と同じ build', 'pkc3:%2Fdev%2F:b1', '/', 'b1', false],
    ['/dev/ から見た / の cache', 'pkc3:%2F:old', '/dev/', 'b1', false],
    ['他人の cache', 'someone-else', '/', 'b1', false],
    // ⚠ **欄の形をしていても**前置きが違えば触らない(他アプリの cache)
    ['他人の cache(欄の形は同じ)', 'other:%2F:old', '/', 'b1', false],
    // 🔴 **前置きだけが違い、後ろは完全に自分と同じ形**。同 origin の兄弟アプリ
    // (Pages は 1 origin に複数の product を置ける)がこの形の cache 名を使うと、
    // 前置きを見ない実装は **他アプリの precache を消す**。
    // ⚠ 上の 2 件はこれを守っていなかった ── `someone-else` は欄が足りず、
    // `other:%2F:old` は scope 欄がずれて、**別の検査に救われて**いた
    // (変異試験で前置き検査を外しても両方 pass した)。前置きは 5 文字なので、
    // **同じ長さの別前置き + 自分と同形の後ろ**でしか撃ち抜けない
    ['🔴 前置きだけ違う同形の名前', 'pkc2:%2F:old', '/', 'b1', false],
    ['前置きだけ合う別物', 'pkc3:こわれ', '/', 'b1', false],
    // ⚠ build 欄が無いものは**判断できない** ── 触らない
    ['build 欄が無い', 'pkc3:%2F', '/', 'b1', false],
  ])('掃除対象か: %s → %s', (_label, name, scope, build, expected) => {
    expect(isStaleCache(name, scope, build)).toBe(expected);
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

describe('🔴 build id は**配る物から**決まる', () => {
  // ⚠ `buildIdFor` は vite.config.ts にある(config を import すると happy-dom の
  // URL 差し替えで落ちるので、**同じ規則**をここで走らせて性質を pin する)
  const buildIdFor = (precache: readonly string[]): string =>
    createHash('sha256').update(JSON.stringify([...precache].sort())).digest('hex').slice(0, 12);

  it('一覧が同じなら id も同じ(中身が変わっていないのに再 precache させない)', () => {
    // review M-1: `GITHUB_SHA` を使うと product のバイト列が同じでも main push の
    // たびに `sw.js` が変わり、**全 user が 1.6MB を再取得**していた
    expect(buildIdFor(['./a-AAAAAAAA.js', './b.html'])).toBe(
      buildIdFor(['./b.html', './a-AAAAAAAA.js']), // 順序にも依らない
    );
  });

  it('🔴 一覧が変われば id も変わる(固定だと新しい版が古い cache を使い続ける)', () => {
    expect(buildIdFor(['./a-AAAAAAAA.js'])).not.toBe(buildIdFor(['./a-BBBBBBBB.js']));
    expect(buildIdFor(['./a-AAAAAAAA.js'])).not.toBe(
      buildIdFor(['./a-AAAAAAAA.js', './b.html']),
    );
  });

  it('id が変われば cache 名も変わる(= 旧 cache が掃除対象になる)', () => {
    const older = buildIdFor(['./a-AAAAAAAA.js']);
    const newer = buildIdFor(['./a-BBBBBBBB.js']);
    expect(cacheNameFor('/', older)).not.toBe(cacheNameFor('/', newer));
    expect(isStaleCache(cacheNameFor('/', older), '/', newer)).toBe(true);
  });
});

describe('install ── 一覧を丸ごと入れる', () => {
  it('precache 一覧が cache に入り、待たずに交代する', async () => {
    const h = runSw(SOURCE);
    await h.fire('install');
    expect([...h.caches.keys()]).toEqual(['pkc3:%2F:b1']);
    expect([...h.caches.get('pkc3:%2F:b1')!.store.keys()]).toEqual([
      './index.html',
      './manifest.webmanifest',
      './assets/index-AAAAAAAA.js',
    ]);
  });

  /**
   * 🔴 段⑤ で `install` の `skipWaiting()` を外した結果、**user が押すまで
   * `activate` が走らない = 掃除も走らない**。main への push ごとに deploy
   * されるので、「あとで」を押し続ける user は 1 デプロイごとに precache 1 本
   * (実測 2.65MB)を溜め続けていた ── 4 デプロイ後に 5 本 13.50MB、上限なし
   * (review H-1、実 Chromium で計測)。quota は OPFS と共用なので
   * **ノート本体の消失に接続する**。
   */
  describe('🔴 交代しない間も積み上げない(review H-1)', () => {
    /** active の印を置いた状態(= その版が使われている)。 */
    const seedActive = (build: string) => (c: Map<string, FakeCache>) => {
      c.set(`pkc3:%2F:${build}`, new FakeCache());
      c.set(`pkc3-active:%2F:${build}`, new FakeCache());
    };

    it('見送られて redundant になった版の残骸を install で畳む', async () => {
      const h = runSw(SOURCE, (c) => {
        seedActive('active0')(c);
        c.set('pkc3:%2F:skipped1', new FakeCache()); // 見送られた版
        c.set('pkc3:%2F:skipped2', new FakeCache()); // その次に見送られた版
      });
      await h.fire('install');
      expect([...h.caches.keys()].sort()).toEqual([
        'pkc3-active:%2F:active0',
        'pkc3:%2F:active0', // ⚠ 使用中 ── 消してはいけない
        'pkc3:%2F:b1', // 自分
      ]);
    });

    it('🔴 使用中(active)の cache は消さない ── 消すと開いている旧タブが壊れる', async () => {
      const h = runSw(SOURCE, seedActive('active0'));
      await h.fire('install');
      expect(h.caches.has('pkc3:%2F:active0')).toBe(true);
    });

    it('🔴 印が無ければ何も消さない(どれが使用中か分からない)', async () => {
      // ⚠ この仕組みを持たない旧版が active のとき。**推測で消さない**
      const h = runSw(SOURCE, (c) => {
        c.set('pkc3:%2F:old1', new FakeCache());
        c.set('pkc3:%2F:old2', new FakeCache());
      });
      await h.fire('install');
      expect([...h.caches.keys()].sort()).toEqual([
        'pkc3:%2F:b1',
        'pkc3:%2F:old1',
        'pkc3:%2F:old2',
      ]);
    });

    it('🔴 別 scope の残骸は触らない(/ の install が /dev/ を壊さない)', async () => {
      const h = runSw(SOURCE, (c) => {
        seedActive('active0')(c);
        c.set('pkc3:%2Fdev%2F:skipped', new FakeCache());
        c.set('pkc3-active:%2Fdev%2F:devactive', new FakeCache());
      });
      await h.fire('install');
      expect(h.caches.has('pkc3:%2Fdev%2F:skipped')).toBe(true);
      expect(h.caches.has('pkc3-active:%2Fdev%2F:devactive')).toBe(true);
    });

    it('他人の cache は触らない', async () => {
      const h = runSw(SOURCE, (c) => {
        seedActive('active0')(c);
        c.set('pkc2:%2F:old', new FakeCache());
        c.set('someone-else', new FakeCache());
      });
      await h.fire('install');
      expect(h.caches.has('pkc2:%2F:old')).toBe(true);
      expect(h.caches.has('someone-else')).toBe(true);
    });

    it('🔴 何度 deploy されても 2 本を超えない(上限があることを直接見る)', async () => {
      // ⚠ 「1 回消えた」ではなく **上限に収束する**ことを見る ── 積み上がりは
      // 「1 回ぶんは消えるが 2 回目から溜まる」形でも起きる
      const map = new Map<string, FakeCache>();
      seedActive('active0')(map);
      const sameScopePrecaches = () =>
        [...map.keys()].filter((k) => k.startsWith('pkc3:%2F:')).length;
      for (const build of ['d1', 'd2', 'd3', 'd4', 'd5']) {
        const h = runSw(swSource({ buildId: build, precache: ['./index.html'] }), (c) => {
          for (const [k, v] of map) c.set(k, v);
        });
        await h.fire('install');
        map.clear();
        for (const [k, v] of h.caches) map.set(k, v);
        // active(使用中)+ 自分 = 2 本
        expect(sameScopePrecaches(), `deploy ${build} で溜まった`).toBe(2);
      }
    });
  });

  it('🔴 install では交代しない(P7 段⑤ ── 勝手に旧 cache を消さない)', async () => {
    // ⚠ ここで `skipWaiting()` を呼ぶと、user が何もしていないのに `activate` が
    // 走り、**旧 build の cache を消す**。開いたままの旧タブが後から旧 hash の
    // chunk を取りに行く経路(boot 中の storage worker 作り直し)で取り零す
    const h = runSw(SOURCE);
    await h.fire('install');
    expect(h.skipped()).toBe(false);
  });

  it('🔴 アプリが頼んだときだけ交代する', async () => {
    const h = runSw(SOURCE);
    await h.fire('install');
    // ⚠ `waitUntil` で囲う ── 囲わないと skipWaiting の完了前に SW が終了しうる
    expect(h.message({ type: 'SKIP_WAITING' })).toBe(1);
    expect(h.skipped()).toBe(true);
  });

  it('知らない合図では交代しない(他所からの postMessage で剥がされない)', async () => {
    // ⚠ SW の message は**同 origin の誰でも**送れる。型を見ずに交代すると、
    // 埋め込んだ iframe や別アプリの postMessage で更新が発火する
    const h = runSw(SOURCE);
    await h.fire('install');
    h.message({ type: 'なにか' });
    h.message('SKIP_WAITING'); // 文字列(data.type が無い)
    h.message(null);
    expect(h.skipped()).toBe(false);
  });

  it('🔴 1 件でも入らなければ install ごと失敗する', async () => {
    // ⚠ 半端な cache でオフラインに入ると「開くのに中身が無い」という、
    // いちばん分からない壊れ方をする
    const h = runSw(swSource({ buildId: 'b1', precache: ['./ok.js', './missing.js'] }));
    await expect(h.fire('install')).rejects.toThrow('404');
    // ⚠ 落ちた側だけでなく**取れていた側も残っていない**(addAll は all-or-nothing)。
    // ここを見ないと「1 件目は入った半端な cache」を許す実装でも通る
    expect([...(h.caches.get('pkc3:%2F:b1')?.store.keys() ?? [])]).toEqual([]);
  });
});

describe('activate ── 古い cache を消す', () => {
  it('🔴 自分以外の PKC3 cache を消す(消さないと無限に積み上がる)', async () => {
    const h = runSw(SOURCE, (c) => {
      c.set('pkc3:%2F:old1', new FakeCache());
      c.set('pkc3:%2F:old2', new FakeCache());
      c.set('pkc3:%2F:b1', new FakeCache());
    });
    await h.fire('activate');
    expect([...h.caches.keys()].sort()).toEqual(['pkc3-active:%2F:b1', 'pkc3:%2F:b1']);
    expect(h.claimed()).toBe(true);
  });

  /**
   * 🔴 install と activate は互いを知らない ── deploy が交代と重なると、
   * 掃除が**進行中の install の cache を消す**(逆向きもある)。実証された
   * 結末は「**precache ゼロの build が active**」で、オフラインが恒久的に死ぬ。
   * 無兆候で、install は二度と走らないので自己修復もしない(round-2 review M-1)。
   */
  describe('🔴 自分の precache が欠けていたら入れ直す(round-2 review M-1)', () => {
    it('cache ごと消えていても、activate で揃う', async () => {
      // レースの結末: 自分の cache が存在しないまま activate する
      const h = runSw(SOURCE);
      await h.fire('activate');
      expect([...(h.caches.get('pkc3:%2F:b1')?.store.keys() ?? [])]).toEqual([
        './index.html',
        './manifest.webmanifest',
        './assets/index-AAAAAAAA.js',
      ]);
    });

    it('半端に消えていても揃う(件数で見る)', async () => {
      const partial = new FakeCache();
      partial.store.set('./index.html', { body: 'cached:./index.html', varyOrigin: null });
      const h = runSw(SOURCE, (c) => c.set('pkc3:%2F:b1', partial));
      await h.fire('activate');
      expect((await h.caches.get('pkc3:%2F:b1')!.keys()).length).toBe(3);
    });

    it('揃っていれば取り直さない(毎回 1.6MB を再取得しない)', async () => {
      const h = runSw(SOURCE);
      await h.fire('install');
      const before = h.caches.get('pkc3:%2F:b1')!;
      before.store.set('./index.html', { body: 'MARK', varyOrigin: null });
      await h.fire('activate');
      // ⚠ 中身が上書きされていない = addAll を呼び直していない
      expect(before.store.get('./index.html')?.body).toBe('MARK');
    });

    it('🔴 取り直しに失敗しても activate は止めない(オフラインで交代した等)', async () => {
      // ⚠ ここで reject すると **SW が activate できない**という、もっと分からない
      // 壊れ方になる(白紙にも 503 にもならず、旧版のまま何も起きない)
      const h = runSw(swSource({ buildId: 'b1', precache: ['./missing.js'] }));
      await expect(h.fire('activate')).resolves.toBeUndefined();
      expect(h.claimed()).toBe(true);
    });
  });

  it('🔴 activate で「自分が使用中」の印を置く(次の install が見る)', async () => {
    // ⚠ これが無いと installing 側は「どれが使用中か」を知りようがなく、
    // **積み上がりを止められない**(review H-1)
    const h = runSw(SOURCE);
    await h.fire('activate');
    expect(h.caches.has('pkc3-active:%2F:b1')).toBe(true);
  });

  it('🔴 古い版が残した印は畳む(印は 1 scope 1 個)', async () => {
    const h = runSw(SOURCE, (c) => {
      c.set('pkc3-active:%2F:old', new FakeCache());
      c.set('pkc3-active:%2Fdev%2F:devactive', new FakeCache()); // 別 scope は残す
    });
    await h.fire('activate');
    expect([...h.caches.keys()].sort()).toEqual([
      'pkc3-active:%2F:b1',
      'pkc3-active:%2Fdev%2F:devactive',
      'pkc3:%2F:b1', // ⚠ 欠けていれば activate が入れ直す(round-2 review M-1)
    ]);
  });

  it('🔴 別 scope の cache は消さない(/ を開いて /dev/ を壊さない)', async () => {
    // review H-1: CacheStorage は origin 単位で scope 単位ではない。
    // Pages は同じ origin に / と /dev/ を置くので、ここを間違えると
    // **/ を 1 回開いただけで /dev/ がオフラインで開かなくなる**(実ブラウザで実証)
    const h = runSw(SOURCE, (c) => {
      c.set('pkc3:%2Fdev%2F:old', new FakeCache()); // 別 scope の**古い版**も残す
      c.set('pkc3:%2Fdev%2F:b1', new FakeCache()); // 別 scope の同 build も残す
      c.set('pkc3:%2F:old', new FakeCache()); // 同 scope の古い版 ── これだけ消える
      c.set('pkc3:%2F:b1', new FakeCache()); // 自分 ── 残る
    });
    await h.fire('activate');
    expect([...h.caches.keys()].sort()).toEqual([
      'pkc3-active:%2F:b1', // 自分が使用中である印(review H-1)
      'pkc3:%2F:b1', // ⚠ 欠けていれば activate が入れ直す(round-2 review M-1)
      'pkc3:%2Fdev%2F:b1',
      'pkc3:%2Fdev%2F:old',
    ]);
  });

  it('🔴 自分の cache 以外は覗かない(古い版の中身を返さない)', async () => {
    // `caches.match` に `cacheName` を渡さないと CacheStorage 全体を舐める ──
    // 別ビルドの cache に残った古い本文がオフラインで返りうる
    const stale = new FakeCache();
    stale.store.set('./assets/index-AAAAAAAA.js', { body: 'OLD', varyOrigin: null });
    const h = runSw(SOURCE, (c) => c.set('pkc3:%2F:old', stale));
    await h.fire('install');
    expect(
      await h.fetch('https://pkc3.example/assets/index-AAAAAAAA.js', { network: 'fail' }),
    ).toBe('cached:./assets/index-AAAAAAAA.js');
  });

  it('🔴 他人の cache は消さない(前置きで自分のものだけを選ぶ)', async () => {
    const h = runSw(SOURCE, (c) => {
      c.set('someone-else', new FakeCache());
      // 🔴 **前置きだけが違い、後ろは自分と同形**。これが本番の危険な形 ──
      // 同 origin の兄弟アプリ(Pages は 1 origin に複数 product を置ける)。
      // ⚠ `someone-else` だけでは撃ち抜けない(欄が足りず別の検査に救われる)
      c.set('pkc2:%2F:old', new FakeCache());
      c.set('pkc3:%2F:old', new FakeCache());
    });
    await h.fire('activate');
    expect([...h.caches.keys()].sort()).toEqual([
      'pkc2:%2F:old',
      'pkc3-active:%2F:b1', // 自分が使用中である印(review H-1)
      'pkc3:%2F:b1', // ⚠ 欠けていれば activate が入れ直す(round-2 review M-1)
      'someone-else',
    ]);
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

  it('🔴 206(Partial)は cache に入れない(Cache.put が投げる)', async () => {
    // ⚠ `res.ok` は 206 でも true ── `status === 200` で絞らないと
    // `TypeError: Partial response is unsupported` が SW の unhandled rejection になる
    const h = await seeded();
    await h.fetch('https://pkc3.example/manifest.webmanifest', { network: 'partial' });
    expect(
      await h.fetch('https://pkc3.example/manifest.webmanifest', { network: 'fail' }),
    ).toBe('cached:./manifest.webmanifest'); // precache のまま
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
