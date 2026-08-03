/**
 * P7 段⑤: **更新の届き方を user に見せる**(設計 doc §2-3)。
 *
 * 🔴 なぜ自動で交代させないか。`install` で `skipWaiting()` を呼ぶと、user が
 * 何もしていないのに新 SW が `activate` し、**旧 build の cache を消す**。
 * 開いたままの旧タブが後から旧 hash の chunk を取りに行く経路
 * (boot 中の storage worker 作り直し ── `main.ts` の `initStorage` は
 * memory fallback を受け入れず worker ごと作り直す)で取り零す。
 * Pages は deploy でツリーごと差し替わるので、消えた cache の先に**実体も無い**。
 *
 * → 交代は **user が押したときだけ**。押した**そのタブだけ**を再読込する。
 *
 * ⚠ **残る露出**(review M-4 で比較対象の誤りを指摘されて書き直した)。
 * 比べるべきは「SW が無い素の静的 deploy」ではなく「**押す前の状態**」である ──
 * 押す前は旧 cache が旧タブを守っており、押すとその保護が `clients.claim()` と
 * cache 削除で**全タブぶん**消える。具体的には:
 *
 * - タブ B が lease 待ち(「別のタブで開いています…」)で止まっている
 *   ── **storage worker はまだ作っていない**
 * - タブ A が「再読込」 → 新 SW が activate → 旧 build の cache 削除 + claim
 * - タブ B は `requested === false` なので設計どおり再読込しない。さらに
 *   この見張りは `startApp` の解決後にしか張られないので**案内も出ない**
 * - タブ A が閉じてタブ B が lease を取る → hash 付き URL で storage worker を
 *   作る → 新 cache に無い → network → Pages はツリーごと差し替わっていて 404
 *
 * この窓は**まだ塞いでいない**。塞ぐなら「lease 待ちのタブにも案内を出す」か
 * 「worker の URL を hash 無しにする」だが、どちらも段⑤ の範囲を越える。
 * ここに書いてあるのは「**自動交代よりは明確に良いが、無害ではない**」という事実である。
 *
 * 🔑 **登録と見張りを分ける**。登録はアプリの boot を待たずに走らせ(boot が
 * 失敗しても次回オフラインで開ける)、見張りは shell ができてから attach する
 * ── その間に `updatefound` が済んでいても、attach 時に `waiting` / `installing`
 * を**その場で見る**ので取り零さない。
 *
 * 🔑 **注入で受ける**。`navigator.serviceWorker` をそのまま触ると node の unit で
 * 触れないし、stub を置いても**本物より緩く**なりがち ── 形を本物に合わせた
 * 最小の interface だけを要求する。
 */

/** 待機中の worker(押されたら合図を送る先)。 */
export interface UpdateWorker {
  postMessage(message: { type: 'SKIP_WAITING' }): void;
}

/** インストール中の worker(`installed` まで見届ける)。 */
export interface InstallingWorker extends UpdateWorker {
  readonly state: string;
  addEventListener(type: 'statechange', listener: () => void): void;
}

/** `navigator.serviceWorker.register()` の結果。 */
export interface UpdateRegistration {
  readonly waiting: UpdateWorker | null;
  readonly installing: InstallingWorker | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
}

/** `navigator.serviceWorker`。 */
export interface UpdateContainer {
  readonly controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

/**
 * 新しい版に気づいたら `present` を呼ぶ。user が押したら交代を頼み、
 * 交代できた時点で `reload` する。
 *
 * @param registered 登録の結果(不成立なら `null`。呼ぶ側で `catch` 済み)
 * @param present 「新しい版があります」を見せる。押されたら渡された関数を呼ぶ
 * @param reload  再読込(交代が済んでから 1 回だけ呼ばれる)
 */
export async function watchForUpdate(
  container: UpdateContainer,
  registered: Promise<UpdateRegistration | null>,
  present: (apply: () => void) => void,
  reload: () => void,
): Promise<void> {
  const registration = await registered;
  if (!registration) return; // SW が成立しない環境(file:// の可搬 HTML など)

  // ⚠ 押したのが**このタブ**のときだけ再読込する。`clients.claim()` は
  // 全タブに `controllerchange` を投げるので、無条件に再読込すると
  // **別タブで編集中の下書きを巻き込んで消す**
  let requested = false;
  let reloaded = false;
  container.addEventListener('controllerchange', () => {
    if (!requested || reloaded) return;
    reloaded = true;
    reload();
  });

  /**
   * ⚠ **同じ worker を二度は見せない**。`updatefound` は再検査のたびに来る。
   *
   * 🔴 ただし「一度見せたら終わり」にしてはいけない(review H-2 で実証)。
   * 次の deploy が来ると、掴んでいた worker は **`redundant` になり**、
   * `registration.waiting` は別 object に差し替わる ── 真偽値のラッチだと
   * 新しい版を提示できず、押しても `redundant` な worker へ送るだけになる。
   * ⚠ Chromium は redundant への `postMessage` を**黙って捨てる**(例外も出ない)
   * ので、**そのセッションでは二度と更新できない**まま何の兆候も出ない。
   * → **worker の同一性**で見張り、別の worker が来たら出し直す。
   */
  let offeredWorker: UpdateWorker | null = null;
  const offer = (worker: UpdateWorker): void => {
    if (offeredWorker === worker) return;
    offeredWorker = worker;
    present(() => {
      requested = true;
      // 🔴 **押された時点の `waiting` を読み直す**。掴んだ worker は
      // その後 redundant になっているかもしれない(上記)
      const target = registration.waiting;
      if (!target) {
        /*
         * 🔴 `waiting` が null になる理由は「まだ来ていない」だけではない ──
         * 「**もう交代が終わった**」でもなる(round-2 review M-2)。
         * 別タブが先に押すと `clients.claim()` でこのタブも新 SW に取られ、
         * それでも `requested === false` なので再読込しない(設計どおり)。
         * その後**このタブの user が出たままの案内を押す**と、頼む相手が居ない。
         * ⚠ そこで postMessage だけして待つと `controllerchange` はもう来ず、
         * 「切り替えています…」のまま**固まって押し直す導線も無い**。
         * 頼む相手が居ない = すでに新しい版が active なので、素直に読み直す。
         */
        if (!reloaded) {
          reloaded = true;
          reload();
        }
        return;
      }
      target.postMessage({ type: 'SKIP_WAITING' });
    });
  };

  const watchInstalling = (worker: InstallingWorker): void => {
    // 🔴 `controller` を見るのが肝。**初回インストール**でも `installed` は
    // 通るので、これが無いと「初めて開いた人」に更新の案内が出る
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && container.controller) offer(worker);
    });
    // ⚠ ここで即 `check()` は**しない**。`installed` に達した worker は
    // `registration.installing` から外れて `waiting` に入るので(実ブラウザで計測)、
    // 「attach 時に既に installed だった installing worker」は存在しない ──
    // その窓は下の `waiting` を見る行が拾う
  };

  // 既に待機している(前回見送った / 別タブが取ってきた / attach 前に済んだ)
  if (registration.waiting && container.controller) offer(registration.waiting);
  if (registration.installing) watchInstalling(registration.installing);

  registration.addEventListener('updatefound', () => {
    if (registration.installing) watchInstalling(registration.installing);
  });
}
