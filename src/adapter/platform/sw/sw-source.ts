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
 * 🔴 **生成ソースの中では、閉じ記号になる文字を書かない**(2 回踏んだ)。
 * ここはテンプレートリテラルで、中身は素の JS として評価される ──
 * - バッククォート / `${` … **テンプレートを閉じる**(config の読込ごと落ちた)
 * - ブロックコメントの閉じ記号(アスタリスク + スラッシュ)… **コメントを閉じる**。
 *   ⚠ 強調の二重アスタリスクの直後にスラッシュを書くとそれになる。実際
 *   `**` + `/dev/` と書いて以降が全部コードとして parse された。
 *   ⚠⚠ **この注意書き自体でもう一度踏んだ** ── 説明の中に閉じ記号を書いて、
 *   この file の TS コメントが閉じた。記号は言葉で書く
 * 生成ソース内の引用は素の `'`、強調は使わない。`tests/adapter/sw-source.test.ts`
 * が `new Function` で毎回 parse するので、踏めば必ず落ちる。
 *
 * ## 戦略(設計 doc §2-2)
 * - **navigation は network-first** → 失敗したら cache。
 *   ⚠ cache-first にすると**新しい版が永久に届かない**(PWA の定番事故)
 * - **hash 付き生成物は cache-first**。名前が変われば別 URL なので陳腐化しない
 * - **cache 名に build id**。`activate` で**自分以外の PKC3 cache を消す**
 *   ⚠ 消さないと OPFS とは別にブラウザの cache が無限に積み上がる
 */

/** cache 名の前置き。⚠ これを手がかりに**古い cache を消す**ので変えない。 */
export const CACHE_PREFIX = 'pkc3:';

/**
 * cache 名。**scope と build id の両方**で分ける。
 *
 * 🔴 CacheStorage は **origin 単位で、scope 単位ではない**(review H-1 で実証)。
 * Pages は同じ origin に `/`(product)と `/dev/` を置くので、前置きだけで
 * 「自分以外」を消すと **別スコープの precache まで消える** ──
 * `/` を 1 回開いただけで `/dev/` がオフラインで開かなくなった。
 * ⚠ `/` は `/dev/` の接頭辞なので `startsWith` では分けられない。**欄で比較する**。
 */
export function cacheNameFor(scope: string, buildId: string): string {
  return `${CACHE_PREFIX}${encodeURIComponent(scope)}:${buildId}`;
}

/** 掃除の対象か ── **同じ scope の、自分ではない** PKC3 cache だけ。 */
export function isStaleCache(name: string, scope: string, buildId: string): boolean {
  if (!name.startsWith(CACHE_PREFIX)) return false; // 他人の cache は触らない
  const parts = name.slice(CACHE_PREFIX.length).split(':');
  if (parts.length < 2) return false;
  return parts[0] === encodeURIComponent(scope) && parts.slice(1).join(':') !== buildId;
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
const BUILD = ${JSON.stringify(buildId)};
const PREFIX = ${JSON.stringify(CACHE_PREFIX)};
/*
 * CacheStorage は origin 単位で scope 単位ではない。Pages は同じ origin に
 * product と dev を置くので、scope を混ぜると片方を開いただけで
 * もう片方の precache が消える(review H-1 で実証)。
 * ルート scope は dev scope の接頭辞なので startsWith では分けられない。欄で比べる。
 */
const SCOPE = encodeURIComponent(new URL(self.registration.scope).pathname);
const CACHE = PREFIX + SCOPE + ':' + BUILD;
const PRECACHE = ${list};
const HASHED = ${HASHED_ASSET.toString()};
/*
 * 🔴 ignoreVary が要る。precache は addAll で入れるので request に Origin が無いが、
 * 実際の module script は crossorigin 付きで Origin を送る ── 応答が Vary: Origin を
 * 持つと(vite preview が実際に付ける)照合が外れ、**オフラインで本体が読めない**。
 * 実測: 単体では全部緑なのに、実ブラウザのオフライン再読込だけが白紙になった。
 */
const MATCH = { cacheName: CACHE, ignoreVary: true };

self.addEventListener('install', (event) => {
  // ⚠ 1 件でも失敗したら install を失敗させる(半端な cache でオフラインに
  // 入ると「開くのに中身が無い」という、いちばん分からない壊れ方をする)
  /*
   * 🔴 ここで skipWaiting を呼ばない(段⑤)。呼ぶと user が何もしていないのに
   * 交代が起き、activate が旧 build の cache を消す ── 開いている旧タブが
   * 後から旧 hash の chunk を取りに行く経路(boot 中の storage worker 作り直し)で
   * 取り零す。交代は user が押したときだけ(下の message)。
   */
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

/*
 * 交代の合図。⚠ アプリ側が待機中の worker を見つけて user に見せ、
 * 押されたときだけ送る(src/adapter/platform/sw/update-prompt.ts)。
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => {
              if (!k.startsWith(PREFIX)) return false; // 他人の cache は触らない
              const parts = k.slice(PREFIX.length).split(':');
              // 同じ scope の、自分ではないものだけ
              return parts.length >= 2 && parts[0] === SCOPE && parts.slice(1).join(':') !== BUILD;
            })
            .map((k) => caches.delete(k)),
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
      // 注: 相対 URL は **SW script の URL 基準**で解決される(/dev/ の SW なら
      // /dev/index.html)。precache に入れた綴りと揃えておく
      fetch(req).catch(() =>
        caches
          .match(req, MATCH)
          .then((hit) => hit || caches.match('./index.html', MATCH))
          // 注: ここで undefined を返すと respondWith が ERR_FAILED になり、
          // user には白紙しか出ない。理由を出す
          .then(
            (hit) =>
              hit ||
              new Response(
                '<!doctype html><meta charset="utf-8"><p>オフラインです。まだこの版を保存していないので、一度オンラインで開き直してください。</p>',
                { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
              ),
          ),
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
        // 注: 200 だけを入れる。206(Partial)は Cache.put が TypeError を投げ、
        // quota 超過も同じく reject する ── SW の unhandled rejection にしない
        if (res && res.status === 200) {
          const copy = res.clone();
          void caches
            .open(CACHE)
            .then((c) => c.put(req, copy))
            .catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, MATCH).then((hit) => hit || Promise.reject(new Error('offline')))),
  );
});
`;
}
