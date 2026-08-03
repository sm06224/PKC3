/**
 * P7 段④: Service Worker の**中身を作る**(設計 doc §2)。
 *
 * 🔑 **文字列を返す純関数**にしてある。SW は別の実行文脈(worker global)なので
 * アプリの module をそのまま import できない ── かといって手書きの `public/sw.js`
 * に precache 一覧を書くと**必ず腐る**(ハッシュ付きファイル名はビルドのたびに変わる)。
 * ここで生成し、`build/sw-plugin.ts` が `sw.js` として出力する。
 *
 * ⚠ **規則の写しを 2 つ持たない**。「どう振る舞うか」はこの 1 か所だけにあり、
 * test は生成した文字列を **実際に評価して**(偽の worker global の上で)確かめる
 * ── 文字列一致で見ると「それらしい形」に救われる(CLAUDE.md)。
 *
 * 🔴 **テンプレートの中でバッククォートと `${` を書かない**(実際に踏んだ)。
 * 生成ソースはこの file のテンプレートリテラルなので、コメントの中の 1 個の
 * バッククォートが**文字列を閉じてしまい**、config の読込ごと落ちる。
 * 生成ソース内の引用は素の `'` で書く。
 *
 * ## 戦略(設計 doc §2-2)
 * - **navigation は network-first** → 失敗したら cache。
 *   ⚠ cache-first にすると**新しい版が永久に届かない**(PWA の定番事故)
 * - **hash 付き生成物は cache-first**。名前が変われば別 URL なので陳腐化しない
 * - **cache 名に build id**。`activate` で**自分以外の PKC3 cache を消す**
 *   ⚠ 消さないと OPFS とは別にブラウザの cache が無限に積み上がる
 */

/** cache 名の前置き。⚠ これを手がかりに**古い cache を消す**ので変えない。 */
export const CACHE_PREFIX = 'pkc3-';

/** cache 名。build id ごとに別 cache になる。 */
export function cacheNameFor(buildId: string): string {
  return `${CACHE_PREFIX}${buildId}`;
}

/**
 * precache に載せるか。**配る物のうち map と実行に要らないものを外す**。
 * ⚠ `.map` は product には無いが、`/dev/` では 3.2MB ある ── 載せない。
 */
export function shouldPrecache(path: string): boolean {
  if (path.endsWith('.map')) return false;
  if (path === 'sw.js') return false; // SW 自身は SW が配らない
  return true;
}

/** hash 付きの生成物(名前が変われば別 URL)。cache-first にしてよい。 */
export const HASHED_ASSET = /-[A-Za-z0-9_-]{8}\.(?:js|mjs|cjs|wasm|css)$/;

export interface SwSourceInput {
  /** この build を識別する文字列(cache 名に入る)。 */
  buildId: string;
  /** precache する URL(SW からの相対)。 */
  precache: readonly string[];
}

/**
 * SW の中身を作る。
 *
 * ⚠ 返すのは**素の JS**(TS ではない)── そのまま `sw.js` として出荷される。
 */
export function swSource({ buildId, precache }: SwSourceInput): string {
  const list = JSON.stringify([...precache]);
  return `/* PKC3 service worker — build ${buildId}(自動生成。手で編集しない) */
const CACHE = ${JSON.stringify(cacheNameFor(buildId))};
const PRECACHE = ${list};
const HASHED = ${HASHED_ASSET.toString()};
/*
 * 🔴 ignoreVary が要る。precache は addAll で入れるので request に Origin が無いが、
 * 実際の module script は crossorigin 付きで Origin を送る ── 応答が Vary: Origin を
 * 持つと(vite preview が実際に付ける)照合が外れ、**オフラインで本体が読めない**。
 * 実測: 単体では全部緑なのに、実ブラウザのオフライン再読込だけが白紙になった。
 */
const MATCH = { ignoreVary: true };

self.addEventListener('install', (event) => {
  // ⚠ 1 件でも失敗したら install を失敗させる(半端な cache でオフラインに
  // 入ると「開くのに中身が無い」という、いちばん分からない壊れ方をする)
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE && k.startsWith(${JSON.stringify(CACHE_PREFIX)})).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部は素通し

  // 🔴 navigation は **network-first**。cache-first にすると新しい版が永久に届かない
  if (req.mode === 'navigate') {
    event.respondWith(
      // 注: fallback の URL は precache に入れた綴りと同じにする
      // ('index.html' と './index.html' は別 key になりうる)
      fetch(req).catch(() =>
        caches.match(req, MATCH).then((hit) => hit || caches.match('./index.html', MATCH)),
      ),
    );
    return;
  }

  // hash 付きは cache-first(名前が変われば別 URL なので陳腐化しない)
  if (HASHED.test(url.pathname)) {
    event.respondWith(caches.match(req, MATCH).then((hit) => hit || fetch(req)));
    return;
  }

  // それ以外(manifest / icon など)は network-first で cache に落とす
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, MATCH).then((hit) => hit || Promise.reject(new Error('offline')))),
  );
});
`;
}
