/**
 * ランチャーのタイルを**起動する**(P7b 段⑩ 修正)。
 *
 * 🔑 **main.ts から出した理由**: ここは変異試験で 2 件生き残った場所である ──
 * `noopener,noreferrer` を両方の `window.open` から外しても、`dispose` を
 * 丸ごと消しても、unit 1089 件 + smoke 24 件が全部 green だった。
 * どちらも **user への約束**(マニュアル §7-2「リンク元も、開いた元のページへの
 * 参照も渡していません」/ 不可侵指示「生成物のライフサイクル終端での即破棄」)
 * なので、**依存を注入して unit で直接見られる形**に出す。
 *
 * 起動は 2 種類ある:
 * - `kind: 'url'` … 外部サイト。**そのまま** `noopener,noreferrer` で開く
 * - `kind: 'app'` … 取り込んだ HTML。**添付そのものは開かない** ──
 *   隔離した外殻(`features/launcher/app-shell.ts`)に載せて開く
 */
import { buildLauncherAppShell } from '@features/launcher/app-shell';
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
  /** 失敗を user に見せる。⚠ 無言で終えない。 */
  fail: (message: string) => void;
}

/**
 * 起動する。**同期で始まる** ── `window.open` は最初の `await` より前に呼ぶ。
 *
 * ⚠ await をまたぐと user の操作(transient activation)が切れて、
 * Safari は `window.open` を通さない。Chromium は猶予に救われるが、
 * 「たまたま通っている」に頼らない。
 */
export function launchTile(tile: LauncherTile, deps: LaunchDeps): void {
  if (tile.kind === 'url') {
    // ⚠ 外部サイトには **opener も referrer も渡さない**(マニュアルの約束)。
    // この指定だと戻り値は常に null なので、塞がれたかどうかは見分けられない
    // ── ブラウザ側の遮断表示に委ねる
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
      const shell = new Blob([buildLauncherAppShell(tile.title, await blob.text())], {
        type: 'text/html',
      });
      const url = deps.createUrl(shell);
      win.location.replace(url);
      // 🔑 **寿命の終端で捨てる**(user 指示 2026-07-27)。初版は 1 秒後に
      // revoke していたので、開いたアプリを再読込すると必ず死んでいた
      // (実測: `net::ERR_FILE_NOT_FOUND`)。終端は「そのタブが閉じたとき」である
      await deps.whenClosed(win);
      deps.revokeUrl(url);
    } catch (e) {
      win.close();
      deps.fail(`「${tile.title}」を開けませんでした: ${String(e)}`);
    }
  })();
}
