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
 * - 🔴 **navigation に COOP/COEP を被せる**(#111)。下記。
 *
 * ## 🔴 なぜ SW がヘッダを被せるのか(#111、2026-08-11)
 *
 * Office(LibreOffice wasm)は `-pthread` = SharedArrayBuffer を要求し、それには
 * `crossOriginIsolated` が要る。`crossOriginIsolated` は **COOP/COEP のレスポンス
 * ヘッダ**からしか生まれない ── ところが **GitHub Pages はヘッダを設定できない**。
 *
 * `vite.config.ts` は dev / preview にだけ同じヘッダを配っており、そこには
 * 「返せないホストでは service worker で被せる必要がある」と書いてあったが、
 * **その分を作らないまま Office を着地させた**。結果、手元(preview)では分離が
 * 成立して smoke も緑、**本番だけが構造的に動かない**状態になった。
 *
 * 🔑 だから navigation の応答をここで作り直してヘッダを足す。⚠ **綴りは
 * `coi-headers.ts` の 1 か所**から来る(dev / preview / 本番で食い違わせない)。
 *
 * ⚠ **navigation だけでよい。** `crossOriginIsolated` は最上位文書の性質であり、
 * 部分資源は COEP `credentialless` の下では素のまま通る(同一 origin は常に可、
 * 別 origin は資格情報を落として no-cors 取得)。全応答を包むと、何百件もの
 * 資源要求ごとに Response を作り直すことになる ── 効果ゼロの定常コストである。
 *
 * ⚠ **初回訪問はここに届かない。** SW がまだ制御していないので、その 1 回だけは
 * ヘッダが付かない = 分離しない。1 回だけ読み直す判断は `coi-reload.ts` に在る。
 */

// ⚠ 拡張子を書く ── この file は `vite.config.ts` から(sw-plugin 経由で)
//    読まれるので、native config loader が拡張子なしの import を警告する。
//    tsconfig は `allowImportingTsExtensions` 済み(`noEmit` のため)。
import { COI_HEADER_ENTRIES } from './coi-headers.ts';

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

/**
 * 「いまどの版が使われているか」の印(P7 段⑤ review H-1)。
 *
 * 🔴 段⑤ で `install` の `skipWaiting()` を外した結果、**user が押すまで
 * `activate` が走らない = 掃除も走らない**。main への push ごとに deploy されるので、
 * 「あとで」を押し続ける user は 1 デプロイごとに precache 1 本(実測 2.65MB)を
 * 溜め続ける ── 実測で 4 デプロイ後に 5 本 13.50MB、上限なし。
 * origin の quota は **OPFS(= SQLite 本体)と共用**なので、これは
 * **ノート本体の消失に接続する**(`navigator.storage.persist()` は未実装)。
 *
 * → `install` でも掃除する。ただし**使用中の cache を消してはいけない**ので、
 * 「どれが active か」を知る必要がある。installing の worker は active の
 * build id を知りようがないので、**activate した worker が自分で印を残す**。
 *
 * ⚠ 前置きは `pkc3-active:` ── `pkc3:` では**始まらない**ので、
 * `isStaleCache` / activate の掃除に巻き込まれない(欄で分ける規律は同じ)。
 * ⚠ 印が無い(この仕組みを持たない旧版が active)ときは**何も消さない**。
 */
export const ACTIVE_MARK_PREFIX = 'pkc3-active:';

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
/*
 * 'いま使われている版' の印(review H-1)。activate した worker が自分で置く。
 * installing の worker は active の build id を知りようがないので、これを見て
 * '消してはいけない cache' を判別する。前置きが違うので掃除には巻き込まれない。
 */
const ACTIVE_PREFIX = ${JSON.stringify(ACTIVE_MARK_PREFIX)};
const ACTIVE_MARK = ACTIVE_PREFIX + SCOPE + ':' + BUILD;
const PRECACHE = ${list};
const HASHED = ${HASHED_ASSET.toString()};
/*
 * 分離のヘッダ(#111)。GitHub Pages はヘッダを返せないので、本番の
 * crossOriginIsolated はここでしか作れない。綴りの正本は coi-headers.ts。
 */
const COI = ${JSON.stringify(COI_HEADER_ENTRIES)};

/*
 * 応答に分離のヘッダを被せて作り直す。
 * ⚠ navigation の出口は 4 つある(網 / cache / index への退避 / 503)。
 *   4 か所に書くと 1 つ足し忘れる形なので、respondWith の直前で 1 回だけ通す。
 */
function withCoi(res) {
  if (!res) return res;
  /*
   * opaque(no-cors)は status も headers も読めず、作り直すと本体ごと失う。
   * どのみちその応答では分離は成立しないので、触らずに返す。
   */
  if (res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const headers = new Headers(res.headers);
  for (let i = 0; i < COI.length; i += 1) headers.set(COI[i][0], COI[i][1]);
  /*
   * 本体は res.body をそのまま渡す。204 / 205 / 304 のような '本体を持てない
   * status' に本体を渡すと Response は投げるが、fetch が返す 204 の body は
   * 必ず null なのでここは通る。⚠ 空文字などに置き換えないこと ── 投げると
   * respondWith が reject し、user に見えるのは理由の無い白紙になる。
   */
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: headers,
  });
}
/*
 * 🔴 ignoreVary が要る。precache は addAll で入れるので request に Origin が無いが、
 * 実際の module script は crossorigin 付きで Origin を送る ── 応答が Vary: Origin を
 * 持つと(vite preview が実際に付ける)照合が外れ、**オフラインで本体が読めない**。
 * 実測: 単体では全部緑なのに、実ブラウザのオフライン再読込だけが白紙になった。
 */
const MATCH = { cacheName: CACHE, ignoreVary: true };

/*
 * 前置きと scope が一致する cache 名から build 欄を取り出す(合わなければ null)。
 * 欄で比べるのは、ルート scope が dev scope の接頭辞で startsWith では分けられないため。
 */
function buildOf(prefix, key) {
  if (!key.startsWith(prefix)) return null; // 他人の cache は触らない
  const parts = key.slice(prefix.length).split(':');
  if (parts.length < 2) return null; // build 欄が無いものは判断できない
  if (parts[0] !== SCOPE) return null;
  return parts.slice(1).join(':');
}

self.addEventListener('install', (event) => {
  // ⚠ 1 件でも失敗したら install を失敗させる(半端な cache でオフラインに
  // 入ると「開くのに中身が無い」という、いちばん分からない壊れ方をする)
  /*
   * 🔴 ここで skipWaiting を呼ばない(段⑤)。呼ぶと user が何もしていないのに
   * 交代が起き、activate が旧 build の cache を消す ── 開いている旧タブが
   * 後から旧 hash の chunk を取りに行く経路(boot 中の storage worker 作り直し)で
   * 取り零す。交代は user が押したときだけ(下の message)。
   */
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      /*
       * 🔴 交代しない間に古い precache が積み上がるのを止める(review H-1)。
       * activate が走らないので掃除も走らず、deploy ごとに 1 本(実測 2.65MB)
       * 増え続けていた。quota は OPFS と共用なのでノート消失に接続する。
       * ⚠ 消してよいのは '自分でも active でもない' もの ── 見送られたまま
       * redundant になった版の残骸だけである。
       */
      .then(() => caches.keys())
      .then((keys) => {
        let activeBuild = null;
        for (const k of keys) {
          const b = buildOf(ACTIVE_PREFIX, k);
          if (b !== null) activeBuild = b;
        }
        // 印が無い = この仕組みを持たない版が active。どれが使用中か分からないので
        // 何も消さない(次に交代すれば activate が畳む)
        if (activeBuild === null) return undefined;
        return Promise.all(
          keys
            .filter((k) => {
              const b = buildOf(PREFIX, k);
              return b !== null && b !== BUILD && b !== activeBuild;
            })
            .map((k) => caches.delete(k)),
        );
      }),
  );
});

/*
 * 交代の合図。⚠ アプリ側が待機中の worker を見つけて user に見せ、
 * 押されたときだけ送る(src/adapter/platform/sw/update-prompt.ts)。
 * ⚠ waitUntil で囲う ── 囲わないと skipWaiting の完了前に SW が終了しうる。
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    if (event.waitUntil) event.waitUntil(self.skipWaiting());
    else void self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => {
              // 同じ scope の、自分ではない precache
              const b = buildOf(PREFIX, k);
              if (b !== null) return b !== BUILD;
              // 他の版が残した '使用中' の印も畳む(印は 1 scope 1 個)
              const a = buildOf(ACTIVE_PREFIX, k);
              return a !== null && a !== BUILD;
            })
            .map((k) => caches.delete(k)),
        ),
      )
      /*
       * 🔑 '自分が active' の印を置く。次に installing する worker がこれを見て、
       * 使用中の cache を消さずに残骸だけを掃除する(review H-1)。
       * ⚠ claim より前に置く ── 逆順だと 'claim 済みなのに印が無い' 窓ができる。
       */
      .then(() => caches.open(ACTIVE_MARK))
      /*
       * 🔴 自分の precache が欠けていたら**入れ直す**(round-2 review M-1)。
       * install と activate は互いを知らないので、deploy が交代と重なると
       * 掃除が進行中の install の cache を消す(逆向きもある)── 実証済みの
       * 結末は 'precache ゼロの build が active' で、オフラインが恒久的に死ぬ。
       * しかも無兆候で、install は二度と走らないので自己修復しない。
       * ⚠ ここで直せば、どちらの向きのレースも activate が畳む。
       * ⚠ 失敗しても activate は止めない(オフラインで交代した等)── 止めると
       * 'SW が activate できない' というもっと分からない壊れ方になる。
       */
      .then(() => caches.open(CACHE))
      .then((c) =>
        c
          .keys()
          .then((entries) => (entries.length === PRECACHE.length ? undefined : c.addAll(PRECACHE)))
          .catch(() => {}),
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
      fetch(req)
        .catch(() =>
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
        )
        /*
         * 🔴 分離のヘッダは**どの出口を通っても**要る(#111)。オフラインで
         * cache から出した文書だけ分離が外れると、Office は '入っているのに
         * 動かない' という、いちばん分からない壊れ方をする。
         */
        .then(withCoi),
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
