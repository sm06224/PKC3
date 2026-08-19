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
   * 🔴 **中央の面を持つ組み込み**(#241 の 2 ペイン / #276 のカレンダー)。
   * ⚠ Office と違って**窓は開かない** ── 中央の面へ切り替える
   * (裁定 6「幅は中央にしかない」)。だから gesture の制約も無い。
   * ⚠ 面ごとに口を作らない(`openDual` から一般化 ── CLAUDE.md §7)。
   */
  openView: (view: 'dual' | 'calendar' | 'kanban') => void;
  /**
   * 🔴 **素のまま(同一オリジン)で開く前の確認**(P10)。
   *
   * `false` を返したら**開かない**(fail closed)。呼び側がセッション中の
   * 記憶を持つ ── ⚠ **保存はしない**(素のままのアプリは localStorage /
   * IndexedDB / OPFS に手が届くので、**自分の許可記録を自分で書ける**)。
   * ⚠ 囲いの中で開くときは**呼ばれない**。
   */
  confirmSameOrigin?: (title: string) => boolean;
}

/** 起動の仕方。既定は囲いの中。 */
export interface LaunchOptions {
  /** 🔴 素のまま(同一オリジン)= PKC3 の保存領域に届く。詳細画面の導線のみ。 */
  sameOrigin?: boolean;
}

/**
 * 起動する。**同期で始まる** ── `window.open` は最初の `await` より前に呼ぶ。
 *
 * ⚠ await をまたぐと user の操作(transient activation)が切れて、
 * Safari は `window.open` を通さない。Chromium は猶予に救われるが、
 * 「たまたま通っている」に頼らない。
 */
export function launchTile(
  tile: LauncherTile,
  deps: LaunchDeps,
  opts: LaunchOptions = {},
): void {
  const raw = opts.sameOrigin === true;
  // 🔴 **開く前に聞く**(fail closed)。⚠ `window.open` より前に聞く ──
  //    後にすると、断ったのに空のタブが残る
  if (raw && deps.confirmSameOrigin !== undefined && !deps.confirmSameOrigin(tile.title)) return;
  if (tile.kind === 'dual' || tile.kind === 'calendar' || tile.kind === 'kanban') {
    // 🔑 組み込み(#241 / #276)── 中央の面を切り替える。窓は開かない
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
          }),
        ],
        { type: 'text/html' },
      );
      const url = deps.createUrl(shell);
      // 🔑 **作ったら必ず返す**(P8 段㉔)── `createUrl` の後に投げると、
      //    直す前は `revokeUrl` を通らずに漏れていた。`finally` へ寄せて
      //    「作る場所と返す場所」を 1 対にする(`download.ts` と同じ倒し方)
      try {
        win.location.replace(url);
        // 🔑 **寿命の終端で捨てる**(user 指示 2026-07-27)。初版は 1 秒後に
        // revoke していたので、開いたアプリを再読込すると必ず死んでいた
        // (実測: `net::ERR_FILE_NOT_FOUND`)。終端は「そのタブが閉じたとき」である
        await deps.whenClosed(win);
      } finally {
        deps.revokeUrl(url);
      }
    } catch (e) {
      win.close();
      deps.fail(`「${tile.title}」を開けませんでした: ${String(e)}`);
    }
  })();
}
