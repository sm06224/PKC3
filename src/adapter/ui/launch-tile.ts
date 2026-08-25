/**
 * ランチャーのタイルを**起動する**(P7b 段⑩ 修正)。
 *
 * 🔑 **main.ts から出した理由**: ここは変異試験で 2 件生き残った場所である ──
 * `noopener,noreferrer` を両方の `window.open` から外しても、`dispose` を
 * 丸ごと消しても、unit 1089 件 + smoke 24 件が全部 green だった。
 * どちらも **user への約束**(マニュアル §7-3「リンク元も、開いた元のページへの
 * 参照も渡していません」/ 不可侵指示「生成物のライフサイクル終端での即破棄」)
 * なので、**依存を注入して unit で直接見られる形**に出す。
 *
 * 起動は 2 種類ある:
 * - `kind: 'url'` … 外部サイト。**そのまま** `noopener,noreferrer` で開く
 * - `kind: 'app'` … 取り込んだ HTML。**添付そのものは開かない** ──
 *   隔離した外殻(`features/launcher/app-shell.ts`)に載せて開く
 */
import { buildLauncherAppShell, launcherAppBase } from '@features/launcher/app-shell';
import { decodeHtml } from '@features/launcher/html-charset';
import type { LauncherTile } from '@features/launcher/tiles';

/** 外部サイトを開くときの窓の指定。⚠ 文言そのものが user への約束である。 */
export const EXTERNAL_WINDOW_FEATURES = 'noopener,noreferrer';

export interface LaunchDeps {
  /** 添付の実体を取る(無ければ `null`)。 */
  readBlob: (assetKey: string) => Promise<Blob | null>;
  /** `window.open` 相当。⚠ `noopener` を付けると**戻り値は必ず null**。 */
  open: (url: string, features: string) => Window | null;
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
  /** 開いた窓が閉じる(= 寿命の終端)まで待つ。 */
  whenClosed: (win: Window) => Promise<void>;
  /**
   * このアプリが前回保存した中身(P8 段⑭)。
   *
   * 🔑 **PKC3 と外殻は同じ origin** なので、ここで読んだものがそのまま外殻の
   * `localStorage` の中身である。⚠ 同期に読む ── `window.open` を
   * `await` の後ろに落とすと、Safari が transient activation を失って窓を開かない。
   */
  readSeed: (appId: string) => Readonly<Record<string, string>>;
  /**
   * **配信ディレクトリ**の URL(`document.baseURI`)。相対 URL の解決先を組む。
   * ⚠ `location.origin` ではない(2026-08-06。user 報告 minor)── Vite は
   * `base: './'` で相対配信なので、origin の根を仮定すると project Pages
   * (`/PKC3/`)で**配信の外**を指す。しかも `<user>.github.io` は他の project と
   * **共有する origin** なので「専用のパス」という前提が崩れる。
   */
  baseUrl: string;
  /** 失敗を user に見せる。⚠ 無言で終えない。 */
  fail: (message: string) => void;
  /**
   * 組み込み Office タイル(#148)── Office の窓(Start Center)を開く。
   * ⚠ **同期に呼べること**(click の gesture の中で `window.open` に到達する)。
   */
  openOffice: () => void;
  /**
   * 🔴 **組み込みアプリを別窓で開く**(#300 段③、2026-08-22。user 要望
   * 「組み込みのアプリに関しては全て別窓で作業したい Office みたいに!」)。
   *
   * ⚠ **これは中央の面の切替ではない。** 直す前は `ViewMode` を切り替えるだけで、
   * 開くと**本文が消えた** ── user は「アプリを見たかった」だけで
   * 「本文を閉じたかった」わけではない(user 指摘 2026-08-22
   * 「メインの PKC の機能を阻害する方向で PKC のセンターペインを占有するな」)。
   *
   * ⚠ **窓が塞がれたときは中央の面へ退避する**(段⑤)── その判断と文言は
   * `platform/view-window.ts` に在る。ここは**押されたことを渡すだけ**。
   * ⚠ 面ごとに口を作らない(`openDual` から一般化 ── CLAUDE.md §7)。
   * 🔑 **`window.open` は gesture の中で撃つ必要がある**ので、この口は
   * `await` より前に呼ぶ(下の実装がそうなっている)。
   */
  openView: (view: 'dual') => void;
  /**
   * 🔴 **素のまま(同一オリジン)で開く前の確認**(P10)。
   *
   * `false` を返したら**開かない**(fail closed)。呼び側がセッション中の
   * 記憶を持つ ── ⚠ **保存はしない**(素のままのアプリは localStorage /
   * IndexedDB / OPFS に手が届くので、**自分の許可記録を自分で書ける**)。
   * ⚠ 囲いの中で開くときは**呼ばれない**。
   */
  /** ⚠ **非同期**(#299 段③)── 確認はアプリ自身のダイアログになった。 */
  confirmSameOrigin?: (title: string) => Promise<boolean>;
  /**
   * 🔴 **拡張として口を開ける**(#195 / C-5 段①)。
   *
   * ⚠ **台帳をここへ import しない** ── この file は「開く手順」だけを持つ。
   *   許可の置き場・鍵の取り方は `extension-grants.ts` の仕事で、ここが知ると
   *   同じ判定が 2 か所になる(CLAUDE.md §7)。
   * ⚠ 渡さなければ**口は開かない**(拡張の機構ごと存在しない)。
   */
  ext?: {
    /** もう許してあるか。🔑 許してあれば**普通の起動でも口が開く**。 */
    granted: (assetKey: string | undefined) => boolean;
    /** 許可を憶える。⚠ 憶えられなければ `false`(呼び側が user に言える)。 */
    grant: (assetKey: string | undefined) => boolean;
    /** 開く前に聞く。⚠ `false` なら**開かない**(fail closed)。 */
    confirm: (title: string) => Promise<boolean>;
    /**
     * 港を渡して受け答えを始める。⚠ 窓が閉じたら `close()` する。
     *
     * 🔴 **合図は外殻に焼いたものと同じ値を渡す**(2026-08-25 に踏んだ)──
     *   外殻は合わない港を**黙って捨てる**ので、別々に作ると繋がらない。
     *   だから引数に取る(呼び側が 1 つの値を 2 か所へ配る形にする)。
     */
    connect: (
      win: Window,
      nonce: string,
      /**
       * 🔴 **どのアプリの窓か**(#195 / C-5 段②)。⚠ 台帳に載せるのに要る ──
       *   段② の「このアプリへ送る」は、**開いている窓を名前で選ぶ**ので、
       *   ここで名乗らないと一覧に出せない(`extension-links.ts`)。
       */
      app: { readonly appId: string; readonly title: string },
    ) => { close: () => void };
    /** 🔴 起動ごとの合図(偽の港を掴まないための鍵)。⚠ 使い回さない。 */
    nonce: () => string;
  };
}

/** 起動の仕方。既定は囲いの中。 */
export interface LaunchOptions {
  /** 🔴 素のまま(同一オリジン)= PKC3 の保存領域に届く。詳細画面の導線のみ。 */
  sameOrigin?: boolean;
  /**
   * 🔴 **目次を見せて起動**(#195 / C-5 段①)。詳細画面の導線のみ。
   * ⚠ **まだ許していないときに押される**ボタンなので、ここで聞いて憶える。
   *   既に許してあるなら普通の起動でも口が開くので、この旗は要らない。
   */
  extension?: boolean;
}

/**
 * 起動する。**囲いの中(既定)は同期で始まる** ── `window.open` は `await` より前に呼ぶ。
 *
 * ⚠ await をまたぐと user の操作(transient activation)が切れて、
 * Safari は `window.open` を通さない。Chromium は猶予に救われるが、
 * 「たまたま通っている」に頼らない。
 *
 * 🔴 **素のまま起動だけは `await` を 1 つ挟む**(#299 段③、2026-08-21)──
 *   確認を**開く前に**出すためである(「やめる」を押したのに空のタブが残る、を作らない)。
 * ⚠ その `await` は「OK を押した」という**新しい user の操作の直後**に解けるので、
 *   Chromium は通る(実測)。⚠ **Safari は未確認** ── 塞がれた場合は
 *   下の `deps.report` が理由を出すので、少なくとも無言にはならない。
 * ⚠ 器の側も、空いているときは**同期で**開く(`app-dialog.ts` の `enqueue`)──
 *   確認そのものが 1 マイクロタスク遅れると、この猶予がさらに細る。
 */
export async function launchTile(
  tile: LauncherTile,
  deps: LaunchDeps,
  opts: LaunchOptions = {},
): Promise<void> {
  const raw = opts.sameOrigin === true;
  // 🔴 **開く前に聞く**(fail closed)。⚠ `window.open` より前に聞く ──
  //    後にすると、断ったのに空のタブが残る
  if (raw && deps.confirmSameOrigin !== undefined && !(await deps.confirmSameOrigin(tile.title)))
    return;
  /**
   * 🔴 **拡張の口**(#195 / C-5 段①)。
   *
   * 🔑 **既に許してあれば、普通の起動でも開く** ── そうしないと、憶えた許可が
   *   「特別なボタンを毎回探す」ことになり、憶えた意味が無くなる。
   * ⚠ 聞くのも `window.open` より前(素のままと同じ理由 ── 断ったのに
   *   空のタブが残る形を作らない)。
   */
  let extOn = deps.ext !== undefined && deps.ext.granted(tile.assetKey);
  if (opts.extension === true && deps.ext !== undefined && !extOn) {
    if (!(await deps.ext.confirm(tile.title))) return;
    // ⚠ 憶えられなくても**開く**(この起動の間は口が開く)── 次に開くときは
    //   また聞かれるだけで、user の操作が無かったことにはならない
    deps.ext.grant(tile.assetKey);
    extOn = true;
  }
  /**
   * 🔴 **合図は 1 回だけ作って、2 か所へ配る**(2026-08-25 に踏んだ)。
   *
   * ⚠ 初稿は外殻を組むときに `deps.ext.nonce()` を呼び、港を渡すときは
   *   **何も渡していなかった** ── 外殻は `m.nonce !== NONCE` で本物の港を
   *   黙って捨てるので、アプリには 1 バイトも届かない。⚠ それでも
   *   **両側の unit は緑**だった(互いに相手を模した stub と話していたので)。
   * 🔑 だから `null` = 口を開けない、文字列 = **その値を外殻にも港にも使う**、
   *   という 1 つの変数にする(2 つの `if` に分けない ── §7)。
   */
  const extNonce = extOn && deps.ext !== undefined ? deps.ext.nonce() : null;
  if (tile.kind === 'dual') {
    // 🔑 組み込み(#241 / #300 段③)── **別窓で開く**。
    //    ⚠ カレンダー / やることの板は #292 段⑤ でここから外れた
    //      (「アプリ」ではなく**ノートの見方**だったので、左の列のタブへ)。
    //    ⚠ `await` より前に呼ぶ ── `window.open` は gesture の中でしか通らない
    deps.openView(tile.kind);
    return;
  }
  if (tile.kind === 'office') {
    // 🔑 組み込み(#148)── Office の窓(Start Center)を開く。窓の生成・使い回し・
    //    寿命は OfficeWindow が持つので、ここは同期に依頼するだけ(gesture を切らない)
    deps.openOffice();
    return;
  }
  if (tile.kind === 'url') {
    /**
     * ⚠ 外部サイトには **opener も referrer も渡さない**(マニュアルの約束)。
     * この指定だと戻り値は常に null なので、**塞がれたかどうかは見分けられない**
     * ── ブラウザ側の遮断表示に委ねる。
     *
     * 🔴 **測ってから諦めている**(2026-08-06。user 報告 minor
     * 「ポップアップ遮断を検出できない設計」)。塞がれたことを見分けるには
     * 「空の窓を開いて戻り値を見る → 遷移させる」形が要るが、実測すると
     * **referrer が漏れる**(フル Chromium / 静的ページ 2 枚で計測):
     *
     * | 開き方 | `document.referrer` | `window.opener` | 塞がれたか分かるか |
     * |---|---|---|---|
     * | `noopener,noreferrer`(今の形) | **空** | null | ✗ |
     * | 空の窓 → opener 切断 → 遷移 | **漏れる** | null | ✓ |
     * | 同上 + `<meta name="referrer" content="no-referrer">` | **漏れる** | null | ✓ |
     *
     * meta を書いても効かない(遷移の referrer は開始側の方針で決まり、
     * `document.write` した空文書の meta は間に合わない)。**約束のほうが重い**ので
     * 検出は買わない ── アプリの起動側(下)は窓の handle が要るので検出できる、
     * という非対称はここに由来する。
     */
    if (tile.url !== undefined) deps.open(tile.url, EXTERNAL_WINDOW_FEATURES);
    return;
  }
  if (tile.assetKey === undefined) return;
  const assetKey = tile.assetKey;

  // 🔑 先に窓を開ける(gesture を切らさない・塞がれたら**その場で分かる**)。
  // ⚠ ここでは `noopener` を付けない ── 付けると戻り値が null になって
  // 「塞がれた」と区別できず、この後の遷移もできない。代わりに **opener を切る**
  const win = deps.open('', '');
  if (!win) {
    deps.fail(`「${tile.title}」を開けませんでした(ブラウザがポップアップを塞いでいます)`);
    return;
  }
  // 🔑 保存内容は**ここで**読む(同期・await より前)── 外殻に焼き込むので、
  // アプリの 1 行目から同期に読める必要がある
  const seed = deps.readSeed(tile.lid);
  // 開いた先から `window.opener` でこちらを触られないようにする。
  // ⚠ 外殻は自前の HTML なので同一 origin ── この代入は通る
  try {
    win.opener = null;
  } catch {
    // 触れない環境でも起動そのものは続ける
  }

  void (async () => {
    try {
      const blob = await deps.readBlob(assetKey);
      if (!blob) {
        win.close();
        deps.fail(`「${tile.title}」の中身が見つかりません(添付が整理された可能性)`);
        return;
      }
      // ⚠ ここで初めて bytes を文字列にする ── 隔離のために `srcdoc` へ入れる
      // 以上、実体化は避けられない。**外殻を組んだら文字列は手放す**
      // 🔴 `blob.text()` は使わない(P8 段⑭)── **UTF-8 固定 decode** なので、
      //    Shift_JIS で保存された HTML が不可逆に化ける(実測)。アプリ自身の
      //    `<meta charset>` に従って読む
      const html = decodeHtml(new Uint8Array(await blob.arrayBuffer()));
      const shell = new Blob(
        [
          buildLauncherAppShell(tile.title, html, {
            appId: tile.lid,
            seed,
            // ⚠ 階層 URL でないと `new URL(相対, base)` が落ちる(実測)
            base: launcherAppBase(deps.baseUrl),
            sameOrigin: raw,
            // 🔴 口を開けるときだけ中継を焼く(許していないアプリには入れない)
            ...(extNonce === null ? {} : { extension: { nonce: extNonce } }),
          }),
        ],
        { type: 'text/html' },
      );
      const url = deps.createUrl(shell);
      // 🔑 **作ったら必ず返す**(P8 段㉔)── `createUrl` の後に投げると、
      //    直す前は `revokeUrl` を通らずに漏れていた。`finally` へ寄せて
      //    「作る場所と返す場所」を 1 対にする(`download.ts` と同じ倒し方)
      // ⚠ 港を渡すのは**遷移の後**(外殻が印を立てるのを待つ形なので、順は問わないが
      //    「外殻を入れてから」のほうが読み手に自然である)
      const link =
        extNonce === null || deps.ext === undefined
          ? null
          : deps.ext.connect(win, extNonce, { appId: tile.lid, title: tile.title });
      try {
        win.location.replace(url);
        // 🔑 **寿命の終端で捨てる**(user 指示 2026-07-27)。初版は 1 秒後に
        // revoke していたので、開いたアプリを再読込すると必ず死んでいた
        // (実測: `net::ERR_FILE_NOT_FOUND`)。終端は「そのタブが閉じたとき」である
        await deps.whenClosed(win);
      } finally {
        deps.revokeUrl(url);
        // 🔴 **窓が閉じたら手を切る** ── 残すと、閉じた窓へ押し続ける
        //    (例外は握り潰されるので**黙って無駄が積もる**)
        link?.close();
      }
    } catch (e) {
      win.close();
      deps.fail(`「${tile.title}」を開けませんでした: ${String(e)}`);
    }
  })();
}
