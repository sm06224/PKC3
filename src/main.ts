// 見た目(P7b 段⑨)。⚠ **ここから import する**のが唯一の入り口 ── index.html に
// `<link>` を書くと Vite の hash 付き出力に乗らず、SW の precache 一覧からも外れる
import './styles/app.css';

import { Dispatcher } from '@adapter/state/dispatcher';
import { connectStoreEffects } from '@adapter/state/store-effects';
import { StoreClient } from '@adapter/platform/storage/store-client';
import {
  createStorePort,
  metaFromRow,
  relationFromRow,
  REVISION_KEEP_LATEST,
} from '@adapter/platform/storage/store-port';
import { acquireWriterLease } from '@adapter/platform/storage/writer-lease';
import type { InitResult } from '@adapter/platform/storage/protocol';
import {
  installHtmlSandboxBlockedReporter,
  installHtmlSandboxResizer,
} from '@features/markdown/html-sandbox';
import { AssetBlobStore } from '@adapter/platform/storage/asset-blob-store';
import { runExplicitPurge } from '@adapter/platform/storage/asset-gc';
import { buildShell } from '@adapter/ui/render/shell';
import { showNotices, clearNotices } from '@adapter/ui/render/notices';
import { createUpdatePrompt } from '@adapter/ui/render/update-card';
import { createAnnounce, announceServices } from '@adapter/ui/render/announce';
import { versionText } from '@adapter/ui/render/help';
import { appNoticeStore } from '@adapter/platform/notice-store';
import { NOTICES } from '@features/notice/notice-log';
import { applyTheme, chooseTheme, initialTheme, isTheme } from '@adapter/ui/render/theme';
import {
  applyPageFormat,
  choosePageFormat,
  currentPageFormat,
  initialPageFormat,
} from '@adapter/ui/render/page-format';
import { isPageFormat } from '@features/page-format';
import { appExternalImages } from '@adapter/ui/render/external-images';
import { launchTile } from '@adapter/ui/launch-tile';
import { appOfficePack } from '@adapter/ui/render/office-entry-view';
import { applyPackResult } from '@adapter/ui/render/office-pack-panel';
import { OfficeWindow } from '@adapter/platform/office/office-window';
import { createOfficeOpener } from '@adapter/platform/office/office-open';
import { watchOfficeHang } from '@adapter/platform/office/office-hang-watch';
import { OfficePackStore } from '@adapter/platform/office/office-pack-store';
import {
  OfficePackInstaller,
  type PackResult,
} from '@adapter/platform/office/office-pack-install';
import { readAppStorage } from '@adapter/platform/app-storage';
import { readAttachmentMeta } from '@features/flavor/attachment-flavor';
import { waitForWindowClose } from '@adapter/platform/window-close';
import { copyPlainText } from '@adapter/platform/clipboard';
import { MarkdownClient } from '@adapter/platform/render/markdown-client';
import { AssetClient } from '@adapter/platform/asset/asset-client';
import { watchForUpdate, type UpdateContainer } from '@adapter/platform/sw/update-prompt';
import { reloadOnPrebootSwap, type PrebootTarget } from '@adapter/platform/sw/preboot-swap';
import { applyIsolationReload } from '@adapter/platform/sw/coi-reload';
import { applyBootRecovery } from '@adapter/platform/sw/boot-recovery';
import { InspectorRenderer } from '@adapter/ui/render/inspector';
import { BrowseRouter, type BrowseMode } from '@adapter/ui/render/browse';
import { CenterRouter } from '@adapter/ui/render/center';
import { AppendBoxRenderer } from '@adapter/ui/render/append-box';
import { formatSize } from '@adapter/ui/render/detail';
import { bindActions, generateLid, type BinderServices } from '@adapter/ui/actions/binder';
import {
  armLaunchQueue,
  type LaunchTarget,
  type LaunchedItem,
} from '@adapter/platform/launch-queue';
import {
  LaunchedFiles,
  splitAlreadyOpen,
  writeBackFile,
  type LaunchedHandle,
} from '@adapter/platform/launched-files';
import { whenPhaseReady } from '@adapter/state/wait-for-ready';
import { reloadSnapshot } from '@adapter/state/reload-snapshot';
import { selectWhenPresent } from '@adapter/state/select-when-present';
import { attachFiles } from '@adapter/ui/actions/attach';
import { importFiles } from '@adapter/ui/actions/import-file';
import type { ImportDeps } from '@adapter/ui/actions/import-pkc2';
import {
  exportArchive,
  exportEntry,
  type ExportDeps,
  type ExportKind,
} from '@adapter/ui/actions/export-archive';
import { createAssetGate } from '@adapter/ui/actions/asset-gate';
import { generateAssetKey } from '@adapter/platform/storage/asset-key';
import { downloadBlob, downloadUrl } from '@adapter/platform/download';
import { diagramFileName } from '@features/export/file-name';
import { renderToSvg, readPalette } from '@adapter/ui/render/mermaid-raster';
import { askConfirm, SUPPRESSED_MESSAGE } from '@adapter/platform/ask-confirm';

const DB_NAME = 'pkc3';
const DEFAULT_CID = 'default';
/** container の題名(書出しのファイル名にも使う ── 1 箇所で決める)。 */
const CONTAINER_TITLE = 'PKC3';


export interface AppHandle {
  dispatcher: Dispatcher;
  storageVfs: InitResult['vfs'];
  /**
   * OS の `launchQueue` から来たファイルを取り込む(P7 段③)。
   * ⚠ **断らない**版 ── 詳細は実装のコメント
   */
  importLaunchFiles(items: LaunchedItem[]): Promise<void>;
  /**
   * 「新しい版があります」を見せる(P7 段⑤)。押されたら `apply` を呼ぶ。
   * ⚠ 交代を頼むだけ ── 再読込は交代が済んでから(`watchForUpdate` の側)。
   */
  presentUpdate(apply: () => void): void;
  /**
   * 起動したときのお知らせを見せる(P11 段⑤)。
   * ⚠ **boot が落ち着いてから**呼ぶ ── 何も映っていない画面に帯だけ立てない。
   * ⚠ 未読が 0 件・恒久オフなら**何も出さない**(判定は面の側)。
   */
  presentAnnounce(): void;
}

/**
 * 昇格 boot(lease 待ち → held)では、旧タブの SAH 解放が lock 解放より遅れて
 * memory fallback しうる(review B-2 ── 空 DB に見え、編集が reload で消える)。
 * fallback を受け入れず、新しい worker で短い backoff 再試行する
 * (install 失敗は worker 内で per-name cache されるため、worker ごと作り直す)。
 */
async function initStorage(promoted: boolean): Promise<{
  client: StoreClient;
  init: InitResult;
}> {
  let client = new StoreClient();
  let init = await client.request({ op: 'init', dbName: DB_NAME });
  if (promoted && init.vfs === 'memory') {
    for (const delayMs of [200, 500, 1000]) {
      client.terminate();
      await new Promise((r) => setTimeout(r, delayMs));
      client = new StoreClient();
      init = await client.request({ op: 'init', dbName: DB_NAME });
      if (init.vfs !== 'memory') break;
    }
    if (init.vfs === 'memory') {
      client.terminate();
      throw new Error(
        `ストレージを確保できませんでした(別タブが保持中の可能性): ${init.fallbackReason ?? 'unknown'}`,
      );
    }
  }
  return { client, init };
}

/**
 * 🔴 **boot が握った書込 lease**(2026-08-06。user 報告 2-14)。
 *
 * boot が失敗しても lease は握られたままだった(`release()` の呼び出しが
 * src に **0 件**)。そのタブを閉じるまで、**他のタブは
 * 「別のタブで開いています」から永久に進めない**(実測)。
 * ⚠ タブを閉じれば browser が返すので、漏れるのは**失敗したまま開き続ける**場合だけ
 * ── だがそれは「起動に失敗しました」の画面を見ている user そのものである。
 */
let bootLease: { release(): void } | null = null;

/** boot(設計メモ §1): lease → worker init → メタ一覧(body 非読込)→ SYS_BOOTED。 */
export async function startApp(root: HTMLElement): Promise<AppHandle> {
  const lease = acquireWriterLease();
  bootLease = lease;
  const promoted = !(await lease.immediate);
  if (promoted) {
    root.textContent = '別のタブで開いています。そのタブを閉じると、ここで続きが開きます…';
    await lease.whenHeld;
  }

  const { client, init } = await initStorage(promoted);
  await client.request({ op: 'openContainer', cid: DEFAULT_CID, title: CONTAINER_TITLE });
  // boot と再読込は**同じ経路**で state を作る(取込後に別の作り方をしない ──
  // 分岐が増えると「取込直後だけ壊れる」型の差分が入る)
  const loadSnapshot = async () => ({
    metas: (await client.request({ op: 'listEntryMetas', cid: DEFAULT_CID })).map(
      metaFromRow,
    ),
    relations: (await client.request({ op: 'listRelations', cid: DEFAULT_CID })).map(
      relationFromRow,
    ),
  });
  const { metas, relations } = await loadSnapshot();

  const dispatcher = new Dispatcher();
  /**
   * 🔴 **確認が出ていないことを黙らせない**(2026-08-06。user 報告 minor
   * 「確認ダイアログが抑止されるとボタンが恒久的に無反応」)。
   *
   * Chromium で user が「これ以上ダイアログを表示させない」を選ぶと、以後の
   * `confirm` は**何も出さずに即 false**。確認つきの操作は全部「取り消し」に
   * なるので、押しても 1 ドットも変わらないボタンになる(タブを閉じるまで戻らない)。
   * ⚠ 抑止は解除できない ── ここがするのは**理由を出す**ことだけ。
   * ⚠ 判定と文言は `platform/ask-confirm.ts` の 1 か所(規則を 2 つ書かない)。
   * @param whenAbsent confirm が**無い**環境での既定(呼び側の倒し方を持ち込む)
   */
  const ask = (message: string, whenAbsent: boolean): boolean => {
    const r = askConfirm(message, { whenAbsent });
    if (r.suppressed) dispatcher.dispatch({ type: 'OP_FAILED', error: SUPPRESSED_MESSAGE });
    return r.ok;
  };
  // 🎨 配色は**枠より先**に当てる ── 後だと一瞬だけ既定色で描かれて瞬く
  const bootTheme = initialTheme();
  applyTheme(document.documentElement, bootTheme);
  // 📄 紙面も**枠より先**(同じ理由 ── 後だと 42rem で 1 度組んでから広がる)。
  // ⚠ ここでは**保存しない**(`applyPageFormat` は当てるだけ)── 保存するのは
  //    user が選んだときだけ(`theme.ts` の M-7 と同じ)
  applyPageFormat(document.documentElement, initialPageFormat());
  const regions = buildShell(root);
  // ⚠ 配色の選択欄は**設定の画面**に在る(段⑨c で移した)。合わせるのは
  //    `SettingsRenderer.syncTheme()` の仕事 ── ここに 2 本目を置かない
  //    (P8 段㉕:帯を探す死んだ同期が残っており、常に空振りしていた)
  // 🔑 左の列は**探し方**で切り替わる(P8 段⑤)。中央は常に「開いているノート」
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  const inspector = new InspectorRenderer(regions.inspector);
  let browseMode: BrowseMode = 'list';
  // assets: bytes は IDB Blob(sqlite には meta のみ)。表示は lend/dispose 規律
  const blobs = new AssetBlobStore();
  /**
   * 🔴 **Office(LibreOffice wasm)の別窓**(#88 / O3-c)。
   *
   * ⚠ ここは**道具を渡すだけ** ── 「開けるか / 開けないならなぜか」の判断は
   * `office-open.ts` が持つ(`main.ts` は原文 pin の test しか無い面なので、
   * 判断を置くと全 tests 緑のまま取り違える ── CLAUDE.md 2026-08-08)。
   * ⚠ 窓も worker も**ここでは起きない**(`OfficeWindow` は放送の口を開くだけ)。
   */
  const officePack = new OfficePackStore();
  /**
   * 一式の設置・削除(#88 / O6-a)。⚠ **判断は実体が持つ** ── ここは
   * 進捗の行き先(画面の控え)を渡すだけ。
   */
  const officeInstaller = new OfficePackInstaller({
    store: officePack,
    onProgress: (text) => appOfficePack.setProgress(text),
  });
  // ⚠ 変数に出すのは **`watchOfficeHang` にも同じ 1 個を渡す**ため(#135)。
  //    2 個作っても放送は両方に届く(同名の別 instance には配られる)ので**動いてしまう** ──
  //    だから壊れ方は静かである:BroadcastChannel が 1 本余計に開きっぱなしになり、
  //    「窓が開いているか」の控えが 2 か所に分かれる。**同じ窓の状態は 1 か所で持つ**
  const officeWindow = new OfficeWindow();
  const officeOpener = createOfficeOpener({
    officeWindow,
    isPackInstalled: () => appOfficePack.isInstalled(),
    readAsset: async (assetKey) => {
      const blob = await blobs.get(DEFAULT_CID, assetKey);
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    },
  });
  /**
   * markdown を描く口。⚠ **アプリ全体で 1 個**(P8 段⑲)── 面や書出しが
   * それぞれ作ると worker lease がその数だけ立ち、常駐が増える。
   * ⚠ 作っただけでは worker は起きない(`WorkerLease` は遅延起動)。
   */
  const markdown = new MarkdownClient();
  const center = new CenterRouter(
    regions.detail,
    undefined,
    {
      lend: (key) => blobs.lendObjectUrl(DEFAULT_CID, key),
      getBlob: (key) => blobs.get(DEFAULT_CID, key),
    },
    markdown,
    /**
     * 🔴 **ライブエディタの本文書込**(2026-08-05。S5)。renderer は dispatch
     * しない(層規約)ので、`UPDATE_OPEN_BODY` はここで投げる。
     * ⚠ **同期で投げる**── 保存ボタンは textarea の blur(= 確定)より後に
     * 走るので、ここが同期なら state は既に新しい本文を持っている。
     */
    (body) => dispatcher.dispatch({ type: 'UPDATE_OPEN_BODY', body }),
  );
  // いま居る場所の印(変わったときだけ属性を触る)
  let markedView: string | null = null;
  const markView = (view: string) => {
    if (view === markedView) return;
    // ⚠ 設定ボタンは**左の列**へ移った(P10 で上の帯を撤去)── 探す先も変える
    for (const btn of regions.sidebar.querySelectorAll('[data-pkc-view]')) {
      if (btn.getAttribute('data-pkc-view') === view)
        btn.setAttribute('data-pkc-active', '');
      else btn.removeAttribute('data-pkc-active');
    }
    markedView = view;
  };
  markView('detail');
  // 探し方のタブ(左の列)。⚠ **中央のビューとは別の軸**なので印も別に持つ
  const markBrowse = (mode: BrowseMode) => {
    for (const btn of regions.sidebar.querySelectorAll('[data-pkc-browse]')) {
      if (btn.getAttribute('data-pkc-browse') === mode)
        btn.setAttribute('data-pkc-active', '');
      else btn.removeAttribute('data-pkc-active');
    }
  };
  markBrowse('list');
  // 🔑 追記欄は**本文とは別の器**(P8 段⑧)── 本文は追記のたびに書き換わって
  // 再描画されるので、同じ器に入れると打ちかけの文字も focus も消える
  const appendBox = new AppendBoxRenderer(regions.append);
  dispatcher.onState((state) => {
    browse.render(state, browseMode);
    center.render(state);
    appendBox.render(state);
    inspector.render(state);
    markView(state.viewMode);
  });
  // status: provenance + エラーの可視化(review B-1 ── 無言の操作拒否を作らない)
  // 🔑 常時見えるのは**版だけ**(P8)。`opfs-sahpool` のような開発者語は
  // 出さない ── 出すと user は「何かのエラーか」と読む。
  // ⚠ 捨てはしない ── 不具合報告のときに要るので `title`(ホバー)へ逃がす。
  // ⚠ ただし **fallback(意図しない保存先)は見せる** ── これは user が
  // 知るべき事実で、黙ると「編集が消える」の原因が見えなくなる
  /**
   * 🔴 **版を常設しない**(P10、user 指示「上下の帯は不要 / 大して働いていない」)。
   * 直す前は 99% の時間ここが「pkc3 v3.0.0」だった ── それが「働いていない」の中身。
   * 版は**ヘルプの画面**へ移した(P11。設定は「あなたが選ぶもの」の場所で、版は選べない)。
   * ⚠ ただし **fallback(意図しない保存先)は常に出す** ── これは user が知るべき
   * 事実で、黙ると「編集が消える」の原因が見えなくなる。
   *
   * 🔴 **版の組み立ては `versionText()` 1 本**(2026-08-08、レビュー指摘)。
   * ⚠ 直す前はここが 2 か所目の手組みで、`(dev)` と「(開発版)」の**2 系統の綴り**が
   *   同時に出ていた ── PKC2 が「版が 4 系統でバラバラ」になった芽そのもの。
   *   `docs-parity` が `src/adapter/ui/render/` を全数走査して 1 か所を pin する。
   */
  const statusBase = init.fallbackReason ? `⚠ ${init.fallbackReason}` : '';
  regions.status.title = `${versionText()} — ${init.vfs}`;
  // textContent の setter は同一文字列でも子ノードを全置換する ── 打鍵ごとの
  // state 変化で無駄な DOM 変異を起こさないよう、変わったときだけ書く
  let statusShown = statusBase;
  regions.status.textContent = statusBase;
  // 🔑 **空なら場所を取らない**(notices / update と同じ作法)
  regions.status.hidden = statusBase === '';
  /**
   * 🔴 **2 つの経路を分けて持つ**(P10)。以前は 1 つの `showStatus` を
   * 「状態(エラー)」と「一時の知らせ(コピーした・取り込んだ)」が**共有**して
   * いたので、**知らせの直後に無関係な状態変化が来ると黙って消えた**。
   *
   * P9 で書込ごとに時刻の ack(`ENTRY_STAMPED`)が飛ぶようになって顕在化した ──
   * コピーの知らせが ack で上書きされ、smoke が落ちた(実測)。
   * ⚠ 直し方は「順番を祈る」ではなく**優先順位を決める**こと:
   * **エラー > 一時の知らせ > 常設(保存先の警告)**。
   */
  let errorLine = '';
  let noticeLine = '';
  const paint = () => {
    const parts = [statusBase, noticeLine, errorLine].filter((t) => t !== '');
    const text = parts.join(' — ');
    if (text === statusShown) return;
    statusShown = text;
    regions.status.textContent = text;
    regions.status.hidden = text === '';
  };
  /** 一時の知らせ(コピーした / 取り込んだ)。⚠ 状態変化では消えない。 */
  const showStatus = (text: string) => {
    noticeLine = text;
    paint();
  };
  /**
   * Office の窓が固まったことに気づく(#135)。⚠ ここは**渡すだけ** ──
   * 物差しも文言も `office-hang-watch.ts` が持つ(`main.ts` は原文 pin の
   * test しか無い面なので、判断を置くと全 tests 緑のまま取り違える)。
   * ⚠ 常駐タイマーは立たない(`visibilitychange` の 1 点だけを見る)。
   */
  watchOfficeHang({
    onEvent: (fn) => officeWindow.onEvent(fn),
    doc: document,
    notify: showStatus,
  });
  /**
   * Office 一式の設置 / 削除の後始末(#88 / O6-a)。
   * ⚠ **判断は `applyPackResult` が持つ** ── ここは道具を渡すだけ。
   */
  const finishOfficePack = (result: PackResult): void =>
    applyPackResult(appOfficePack, result, {
      redrawDetail: () => {
        center.invalidateDetail();
        center.render(dispatcher.getState());
      },
      notify: showStatus,
    });
  // エラー表示は state 駆動のみ(P3-6b: BODY_LOAD_FAILED も state.error に
  // 統一 ── 表示寿命は「次の成功 / 選択まで」で、event の一瞬表示問題は消滅)
  dispatcher.onState((state) => {
    // ⚠ **エラーの行だけ**を触る ── 一時の知らせを巻き添えにしない
    errorLine = state.error ? `⚠ エラー: ${state.error}` : '';
    paint();
  });

  // 🔒 attach / import と purge の排他 gate(review F1)。実体と pin は asset-gate.ts
  const withAssetGate = createAssetGate(dispatcher);
  /**
   * 書出しの実行(P6d)。⚠ **asset gate の内側** ── 書出し中に添付が掃除されると
   * 「meta はあるが bytes が無い」を掴んで欠けた書出しができる。
   * 形式が増えても読み出し口は 1 つ(source)で共有する。
   */
  const runExport = (kind: ExportKind | { entryLid: string }): Promise<void> =>
    withAssetGate(async () => {
      const deps: ExportDeps = {
        source: {
          cid: DEFAULT_CID,
          // ⚠ `openContainer` で刻んだ題名と**同じ文字列**を使う(別定数だと
          // ファイル名と DB の題名が食い違う ── review L-2)
          title: CONTAINER_TITLE,
          listEntryMetas: () =>
            client.request({ op: 'listEntryMetas', cid: DEFAULT_CID }),
          // ⚠ 1 件だけの読み口(P6f)── 無いと 1 ノート書出しが全 body を舐める
          getBody: async (lid) =>
            (await client.request({ op: 'getBody', cid: DEFAULT_CID, lid })) ?? null,
          listBodies: (after, maxBytes) =>
            client.request({
              op: 'listBodies',
              cid: DEFAULT_CID,
              maxBytes,
              ...(after ? { after } : {}),
            }),
          listRelations: () => client.request({ op: 'listRelations', cid: DEFAULT_CID }),
          listAssetMetas: () => client.request({ op: 'listAssetMetas', cid: DEFAULT_CID }),
          getAssetBlob: (key) => blobs.get(DEFAULT_CID, key),
          listRevisionLids: () =>
            client.request({ op: 'listRevisionLids', cid: DEFAULT_CID }),
          // ⚠ 鎖は**保存形のまま**取る(P6e)── `getRevision` で版ごとに
          // 全文へ復元すると、アーカイブが N×M に膨らみ kind が中身と食い違う
          getRevisionChain: (entryLid) =>
            client.request({ op: 'exportRevisionChain', cid: DEFAULT_CID, entryLid }),
        },
        download: downloadBlob,
        notify: (message) => showStatus(message),
        // ⚠ **注意の中身**を出す導線(review M1 で一度落ちた)。無いと user が
        // 見るのは「⚠ 注意 1 件」だけで、**どの添付が欠けたか**が消える ──
        // バックアップで一番知りたい情報がそこにある
        report: (notes) => showNotices(regions.notices, '書出し時の注意', notes),
        // 🔑 閲覧用 HTML の本文描画は**ワーカーへ**(P8 段⑲)。渡さないと
        //    件数ぶんメインスレッドで描くことになる
        // ⚠ opts を素通しする(vars / 見出し番号 ── user 報告 2-7)
        renderBody: (text, opts) => markdown.render(text, opts),
        /**
         * 🔴 **書き出す HTML に外部画像を焼くのは「常にオン」のときだけ**
         * (2026-08-06、user 裁定)。⚠ ノートごとの同意(`allows(lid)`)は
         * **使わない** ── 書き出した HTML は**別の人が開く文書**であり、
         * 開いた人は追跡に同意していない。URL は属性に残るので情報は失われない。
         */
        allowExternalImages: appExternalImages.getMode() === 'always',
        /**
         * 📄 **書き出した瞬間の紙面を焼く**(2026-08-08、user 裁定)。
         * ⚠ いま**画面に当たっている**値を渡す(保存を読み直さない)── 保存が
         *   使えない環境では画面と保存が食い違い、配った HTML だけ別の幅になる。
         */
        pageFormat: currentPageFormat(document.documentElement),
      };
      // 1 ノートだけの書出しも**同じ実行部・同じ形式**を通る(P6f)──
      // 別経路にすると「1 件書出しだけ壊れている」が起きる
      if (typeof kind === 'object') await exportEntry(dispatcher, deps, kind.entryLid);
      else await exportArchive(dispatcher, deps, kind);
    });

  /**
   * 添付を展開するワーカーの口(P8 段⑮)。
   * ⚠ **1 つを使い回す** ── 取込のたびに作ると、アイドル kill の意味が消える。
   */
  const assets = new AssetClient();
  const importDeps: ImportDeps = {
      // ⚠ 生存 entry だけでは足りない ── ゴミ箱の lid(entries に居ないが
      // revisions を持つ)と衝突すると、その item がゴミ箱から消え、
      // 取り込んだ entry が他人の履歴を背負う(review H-1、実 sqlite で実証)
      existingLids: async () =>
        new Set([
          ...dispatcher.getState().entryMetas.keys(),
          ...(await client.request({ op: 'listRevisionLids', cid: DEFAULT_CID })),
        ]),
      existingRelationIds: () =>
        new Set(dispatcher.getState().relations.map((r) => r.id)),
      orderBase: () => {
        let max = 0;
        for (const m of dispatcher.getState().entryMetas.values()) {
          if (m.entryOrder > max) max = m.entryOrder;
        }
        return max;
      },
      genLid: generateLid,
      genAssetKey: generateAssetKey,
      /**
       * 🔑 添付の**展開とハッシュはワーカーへ**(P8 段⑮。不可侵指示
       * 「基本的に重い処理はワーカーにしてください」)。
       * ⚠ `WorkerLease` が遅延起動・バッファ・アイドル kill を持つので、
       * ここは口を渡すだけ ── 取込を一度もしない user にワーカーは作られない。
       */
      processAsset: (view, gzipped) => assets.process(view, gzipped),
      genRelationId: () => `rel-${crypto.randomUUID()}`,
      bulkUpsertEntries: async (entries) => {
        await client.request({ op: 'bulkUpsertEntries', cid: DEFAULT_CID, entries });
      },
      bulkUpsertRelations: async (relations) => {
        await client.request({
          op: 'bulkUpsertRelations',
          cid: DEFAULT_CID,
          relations,
        });
      },
      importRevisionChains: (chains) =>
        client.request({ op: 'importRevisionChains', cid: DEFAULT_CID, chains }),
      // ⚠ `keepLatest` を**明示で渡す**(review L-2)── 省くと worker の
      // 既定値が使われ、アプリ側の設定と偶然一致しているだけになる。
      // 片方を変えた瞬間に自分のバックアップが黙って削れる
      restoreRevisionChains: (chains) =>
        client.request({
          op: 'restoreRevisionChains',
          cid: DEFAULT_CID,
          chains,
          keepLatest: REVISION_KEEP_LATEST,
        }),
      // ⚠ **bytes 側の台帳を見る**(review H-1)── meta 行の有無で判定すると、
      // GC が deleteBlob → deleteMeta の途中で失敗した状態(設計上の想定内)で
      // put を省いてしまい、参照だけが書かれる
      listStoredBlobKeys: async () => new Set(await blobs.listKeys(DEFAULT_CID)),
      putBlob: (key, blob) => blobs.put(DEFAULT_CID, key, blob),
      putAssetMeta: async (m) => {
        await client.request({ op: 'putAssetMeta', cid: DEFAULT_CID, meta: m });
      },
      // 🔑 中身は `reload-snapshot.ts`(段㉕ で切り出し ── closure に居ると
      //    誰も test できず、「案内は出すが実行しない」嘘が残っていた)
      reload: () => reloadSnapshot(dispatcher, DEFAULT_CID, loadSnapshot),
      notify: (message) => showStatus(message),
      // 注意は**全件**を専用面へ(1 行の status では 1 件目しか届かない)
      report: (notes) => showNotices(regions.notices, '取込時の注意', notes),
      // 🔴 **取り込んだノートを開く**(2026-08-05、user 報告「開いたら何も起きずに終わる」)。
      //    ⚠ `reload()` が早く返る場合があるので、素朴な dispatch では
      //    reducer に弾かれて黙って終わる ── 「居たら選ぶ、まだなら待つ」は
      //    `select-when-present.ts` に閉じてある
      focus: (lid) => void selectWhenPresent(dispatcher, lid),
  };

  /**
   * 🔴 **OS から開いた md の元ファイル**(2026-08-05、user 報告
   * 「スポットの編集プレビュー導線も存在しない」)。⚠ **このセッションだけ**の記憶。
   * 実体と理由は `launched-files.ts`(state には名前だけ渡す)。
   */
  const launched = new LaunchedFiles();

  /**
   * 取込の本体。⚠ **gate の外**に置く ── 断る版(user のクリック)と
   * 待つ版(OS の launch。断ると選び直せない)の**両方**が同じ処理を呼ぶ。
   * 2 本に分けると片方だけ直す事故が必ず起きる(P7 段③ review H2)
   */
  const runImport = (
    files: File[],
    handles?: readonly LaunchedHandle[],
  ): Promise<void> =>
    importFiles(
      dispatcher,
      handles === undefined
        ? importDeps
        : {
            ...importDeps,
            // ⚠ **順番で結ぶ**(名前で結ばない)── 同名の別ファイルを同時に開くと
            //    名前では取り違える。`importMarkdownFiles` は files の順で lid を返す
            imported: (lids) => {
              lids.forEach((lid, i) => {
                const handle = handles[i];
                const file = files[i];
                if (!handle || !file) return;
                launched.remember(lid, handle, file.name);
                dispatcher.dispatch({ type: 'FILE_LINKED', lid, name: file.name });
              });
            },
          },
      files,
    ).then(() => {});

  /**
   * 📣 起動したときのお知らせ(P11 段⑤。user 指示 2026-08-07
   * 「PKC3 にも PKC2 のようにお知らせポップアップをつけてください」)。
   *
   * ⚠ **自分の行**に出す(`shell.ts` に理由)。⚠ 出すのは boot が落ち着いてから
   *   ── 起動直後に出すと、まだ何も映っていない画面に帯だけが立つ。
   */
  const announce = createAnnounce(regions.announce, appNoticeStore, NOTICES);

  /** 更新の案内(P7 段⑤)。面と「押されたら何をするか」は render 側が持つ。 */
  const updatePrompt = createUpdatePrompt(regions.update, {
    // ⚠ 再読込は open editor の下書きを捨てる(本文は AppState にしか無い)。
    // 破壊的操作は confirm を出す、というこのリポジトリの倒し方に揃える(review M-2)
    isEditing: () => dispatcher.getState().phase === 'editing',
    confirmDiscard: () => ask('編集中の内容は保存されません。新しい版に切り替えますか?', true),
  });

  /**
   * 🔴 **素のまま起動を許した添付**(P10)。**このセッションだけ**の記憶で、
   * どこにも保存しない ── 素のままのアプリは localStorage / IndexedDB / OPFS に
   * 手が届くので、**永続化した許可は自分で書ける**(前の設計 doc の指摘)。
   * ⚠ この変数への参照経路はアプリ側に無い(`opener` は切り、`parent` は外殻で止まる)。
   */
  const sameOriginAllowed = new Set<string>();

  const services: BinderServices = {
    attachFiles: (files) =>
      void withAssetGate(() =>
        attachFiles(
          dispatcher,
          {
            putBlob: (key, blob) => blobs.put(DEFAULT_CID, key, blob),
            putMeta: async (m) => {
              await client.request({
                op: 'putAssetMeta',
                cid: DEFAULT_CID,
                meta: { key: m.key, mime: m.mime, size: m.size, hash: m.hash },
              });
            },
            listMetas: () => client.request({ op: 'listAssetMetas', cid: DEFAULT_CID }),
            estimate: navigator.storage?.estimate
              ? () => navigator.storage.estimate()
              : undefined,
            // 🔴 ハッシュは**ワーカーで**取る(P8 段㉓)。渡さないと
            //    `blob.arrayBuffer()` が最大 64MB をメインの heap に載せる
            //    ── 実測 32MB でメインが 241ms 止まっていた
            hashBlob: async (blob) => (await assets.hash(blob)).hash,
          },
          files,
        ),
      ),
    downloadAsset: async (assetKey, name) => {
      try {
        const lent = await blobs.lendObjectUrl(DEFAULT_CID, assetKey);
        if (!lent) {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: `asset が見つかりません: ${name}`,
          });
          return;
        }
        downloadUrl(name, lent.url, lent.dispose);
      } catch (e) {
        // IDB 障害等を unhandled rejection にしない(可視で終える)
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: `ダウンロードに失敗しました(${name}): ${String(e)}`,
        });
      }
    },
    /**
     * 🔴 **元の md へ書き戻す**(2026-08-05、user 報告
     * 「マークダウンファイルに紐付けれるけど、取り込みもスポットの編集プレビュー導線も
     * 存在しない」)。開いた md を直して、**そのファイルへ返す**までが「その場編集」。
     *
     * ⚠ 書くのは **disk の本文**(draft ではない)── 編集中は断る。
     *   下書きを user のファイルへ流し込むと、確定していないものが外へ出る。
     * ⚠ 本文は取込時に**原文のまま**入っている(`import-markdown.ts` の規律)ので、
     *   frontmatter を含めて往復する。ここで組み立て直さない。
     * ⚠ 確認を出す ── **user のファイルを上書きする**(取り消せない)操作である。
     */
    writeBackFile: (lid) => {
      const state = dispatcher.getState();
      const fail = (error: string): void => dispatcher.dispatch({ type: 'OP_FAILED', error });
      if (state.phase !== 'ready') {
        fail('編集を終了してから書き戻してください');
        return;
      }
      const name = state.linkedFiles.get(lid);
      const handle = launched.handleOf(lid);
      if (name === undefined || handle === null) {
        // 読み直すと handle は死ぬ ── そのときは「もう一度開いてください」が正しい
        fail('元のファイルとの紐づけがありません(この md をもう一度開いてください)');
        return;
      }
      const ok = ask(
        `「${name}」を、いまのノートの内容で上書きします。\n\n` +
          'ファイルの元の内容は失われます(取り消せません)。よろしいですか?',
        false,
      );
      if (!ok) return;
      void (async () => {
        const body = (await client.request({ op: 'getBody', cid: DEFAULT_CID, lid })) ?? null;
        if (body === null) {
          fail('本文が見つかりません(整理された可能性)');
          return;
        }
        const result = await writeBackFile(handle, body);
        if (result.ok) showStatus(`書き戻しました: ${name}`);
        else fail(`${name}: ${result.reason}`);
      })();
    },
    // 📥 取込(P6b: PKC2 の書出し / P7 段②: 素の Markdown)。asset gate の内側 ──
    // 取込は putBlob → entry 書込の間に「bytes はあるが参照が無い」窓を持つので、
    // 整理との同時実行は attach と同じ危険。⚠ 振り分けは import-file.ts が持つ
    importFiles: (files) => void withAssetGate(() => runImport(files)),
    dismissNotices: () => clearNotices(regions.notices),
    /**
     * 添付の参照をコピーする(P8 段⑱)。
     * ⚠ **結果を出す** ── コピーは押しても画面が変わらない操作なので、
     *    黙って終わると成功したのか分からない
     */
    copyText: (text) => {
      void copyPlainText(text).then((ok) => {
        showStatus(ok ? '参照をコピーしました(本文に貼れます)' : 'コピーできませんでした');
      });
    },
    /**
     * 🚀 ランチャーのタイルを起動する(P7b 段⑩)。
     *
     * ⚠ **新しいタブで開く**。同じタブに載せると、開いた先から戻れない
     * (PKC3 は SPA なので履歴が噛み合わない)。
     * 中身の作法(隔離 / opener / 寿命)は `launch-tile.ts` が持つ ──
     * ここは**この環境の道具を渡すだけ**
     */
    // 🔴 **素のままの許可はここにだけ在る**(P10)。保存しない ── アプリは
    //    保存領域に手が届くので、永続化した許可は**自分で書ける**。
    //    ⚠ このタブを閉じれば消える。⚠ アプリからこの変数への参照経路は無い
    openTile: (lid) => {
      const tile = dispatcher.getState().launcherTiles?.find((t) => t.lid === lid);
      if (!tile) return;
      launchTile(tile, {
        readBlob: (assetKey) => blobs.get(DEFAULT_CID, assetKey),
        open: (url, features) => window.open(url, '_blank', features),
        createUrl: (blob) => URL.createObjectURL(blob),
        revokeUrl: (url) => URL.revokeObjectURL(url),
        whenClosed: waitForWindowClose,
        // 🔑 このアプリが前回保存した中身(P8 段⑭)。**PKC3 と外殻は同じ origin**
        //    なので、ここで読んだものがそのまま外殻の localStorage の中身になる
        readSeed: readAppStorage,
        baseUrl: document.baseURI,
        fail: (error) => dispatcher.dispatch({ type: 'OP_FAILED', error }),
      });
      // ⚠ 押した対象を**選択状態にもする**(P8 段⑭)── 起動しただけだと右の列が
      //    空文のままで、いま何を触ったのかが画面に残らない。「押す = 起動」の
      //    意味は変えず、選択は同時に立つ副作用として入れる
      dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
    },
    /**
     * 🔴 **詳細画面から添付を起動する**(P10、user 指示 2026-08-05)。
     *
     * ⚠ `openTile` と違って **登録の有無に依存しない** ── タイルの一覧を引かず、
     * その添付の frontmatter から起動に要るものだけ組む(開けることと
     * ランチャーに並べることは別の話)。
     * ⚠ 素のまま(同一オリジン)は**確認してから**開く。許可は**保存しない** ──
     * セッション中の記憶だけ持つ(素のままのアプリは localStorage /
     * IndexedDB / OPFS に手が届くので、**自分の許可記録を自分で書ける**)。
     * この記憶はこのクロージャの中にあり、アプリからの参照経路は無い
     * (`opener` は切り、`parent` は外殻で止まる)。
     * 設計: `docs/development/p10-launcher-same-origin-2026-08.md`
     */
    launchAsset: (lid, launchOpts) => {
      const meta = dispatcher.getState().entryMetas.get(lid);
      if (!meta) return;
      void (async () => {
        const body =
          (await client.request({ op: 'getBody', cid: DEFAULT_CID, lid })) ?? null;
        if (body === null) {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: '添付が見つかりません(整理された可能性)',
          });
          return;
        }
        const att = readAttachmentMeta(body);
        if (att.assetKey === null || att.assetKey === '') {
          dispatcher.dispatch({ type: 'OP_FAILED', error: 'この添付には実体がありません' });
          return;
        }
        launchTile(
          {
            lid,
            title: meta.title || att.name || '(無題)',
            kind: 'app',
            group: '',
            assetKey: att.assetKey,
            mime: att.mime,
          },
          {
            readBlob: (assetKey) => blobs.get(DEFAULT_CID, assetKey),
            open: (url, features) => window.open(url, '_blank', features),
            createUrl: (blob) => URL.createObjectURL(blob),
            revokeUrl: (url) => URL.revokeObjectURL(url),
            whenClosed: waitForWindowClose,
            readSeed: readAppStorage,
            baseUrl: document.baseURI,
            fail: (error) => dispatcher.dispatch({ type: 'OP_FAILED', error }),
            confirmSameOrigin: (title) => {
              if (sameOriginAllowed.has(lid)) return true;
              // ⚠ 何が起きるかを**具体**で書く(「安全でない」では判断できない)
              const ok = ask(
                `「${title}」を PKC3 と同じ場所で開きます。\n\n` +
                  'IndexedDB や cookie を使うアプリが動くようになりますが、' +
                  'このアプリは PKC3 の保存内容(ノート・添付・設定)にも手が届きます。\n' +
                  'このタブを閉じるまでは、もう一度は聞きません(次に開いたときは聞きます)。\n\n' +
                  '開きますか?',
                false,
              );
              if (ok) sameOriginAllowed.add(lid);
              return ok;
            },
          },
          { sameOrigin: launchOpts.sameOrigin },
        );
      })();
    },
    /**
     * 🔴 **添付を Office の別窓で開く**(#88 / O3-c)。
     *
     * ⚠ **同期で撃つ**(`await` を挟むと user gesture が切れてポップアップ遮断)。
     * ⚠ 開けなかったときは**必ず理由を出す** ── 押しても無言、を作らない。
     * ⚠ 使い回したときも黙らない ── 別窓が背面に居ると `focus()` が効かない
     *   ことがあり、「押したのに何も起きない」に見える(窓は既に開いている)。
     */
    openOffice: (target) => {
      const r = officeOpener.open(target);
      if (!r.ok) dispatcher.dispatch({ type: 'OP_FAILED', error: r.message });
      else if (r.reused) showStatus('開いている Office の窓に表示します');
    },
    /**
     * 🔴 **Office 一式の設置 / 削除**(#88 / O6-a)。⚠ ここは**渡すだけ** ──
     * 判断も文言も `OfficePackInstaller` が持つ(投げてこない)。
     * ⚠ 終わったら**両方の面を合わせる** ── 添付の入口(中央)と設定の面は
     *   別経路で描かれるので、片方だけ直すと古い値が残る。
     */
    installOfficePack: () => {
      void officeInstaller.installFromUrl().then(finishOfficePack);
    },
    installOfficePackFromFile: (file) => {
      void officeInstaller.installFromZip(file, file.name).then(finishOfficePack);
    },
    removeOfficePack: () => {
      void officeInstaller.remove().then(finishOfficePack);
    },
    // 🎨 配色(P7b 段⑨c、user 指示「最初はライトとダークのみに」)。
    // ⚠ 属性は **`<html>`** に付ける ── `:root` の変数を上書きするため
    // ⚠ **ここだけが保存する** ── 起動時の適用は保存しない(review M-7)
    // ⚠ **一覧は 1 か所**(`THEMES`)。ここに `light | dark` のような
    // 別の一覧を書くと、テーマを足しても**黙って効かない**(実際に踏んだ)
    setTheme: (theme) => {
      if (isTheme(theme)) chooseTheme(document.documentElement, theme);
    },
    /**
     * 📄 紙面(2026-08-08、user 裁定)。⚠ **一覧は 1 か所**(`PAGE_FORMATS`)。
     * 🔑 **描き直さない** ── 変わるのは `--read-w` の値だけで HTML は 1 文字も
     *   変わらないので、ブラウザが reflow する。描き直すと**図が焼き直される**
     *   (図のラスタは器の幅から決まり、その器は動いていない)。
     *   ⚠ ここは `setExternalImages` と**わざと違う** ── あちらは描いた HTML
     *   そのものが変わるので描き直しが要る。
     */
    setPageFormat: (format) => {
      if (isPageFormat(format)) choosePageFormat(document.documentElement, format);
    },
    /**
     * 🖼 外部の画像(2026-08-06、user 裁定「常にオン / 常に確認 / 常にオフ」)。
     * ⚠ 変えたら**いま開いているノートを描き直す** ── 描き直さないと、
     *   「常にオフ」にしても見ているノートの画像は出たままで、設定が嘘になる。
     * ⚠ state は動かないので dispatcher の通知は来ない ── ここで直接描く
     *   (`setBrowse` と同じ作法)。
     */
    setExternalImages: (mode) => {
      if (!appExternalImages.setMode(mode)) return;
      center.invalidateDetail();
      center.render(dispatcher.getState());
    },
    /**
     * 🚩 フラグ(P11。user 指示 2026-08-07)。⚠ **設定ではない** ──
     * 開発者・パワーユーザー向けで、`foldWhen` の条件が来たら畳まれる。
     * ⚠ 保存は localStorage(裁定 Q6)。state には持たせない。
     */
    setFlag: (name, on) => {
      center.setFlag(name, on);
    },
    resetFlags: () => {
      center.resetFlags();
    },
    /** 帯の「このノートで読み込む」「読み込まない」。⚠ 設定は変えない。 */
    answerExternalImages: (allow) => {
      const lid = dispatcher.getState().selectedLid;
      if (!lid) return;
      if (!appExternalImages.answer(lid, allow ? 'allow' : 'deny')) return;
      // ⚠ 箱の申告は数え直す(許可すれば止まらなくなる / 拒否なら帯は消える)
      appExternalImages.forgetBlockedBoxes(lid);
      center.invalidateDetail();
      center.render(dispatcher.getState());
    },
    // 🔑 探し方の切替(P8 段⑤)。⚠ **state には持たせない** ── これは
    // 「どう探すか」という画面側の都合で、container のデータではない
    setBrowse: (mode) => {
      if (mode !== 'list' && mode !== 'filer' && mode !== 'launcher') return;
      browseMode = mode;
      markBrowse(mode);
      browse.render(dispatcher.getState(), mode);
      // ⚠ アプリの一覧は開いたときに読む(常駐していない)。
      // 🔴 **view を借りない**(P8 段⑱)── 中央の面を変える必要が無いのに
      //    `SET_VIEW_MODE 'launcher'` を撃っていたので、タブを切り替えただけで
      //    中央下の追記欄が消えていた(他の 2 タブでは残る)
      if (mode === 'launcher') dispatcher.dispatch({ type: 'REFRESH_LAUNCHER_TILES' });
      if (dispatcher.getState().viewMode !== 'detail')
        dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    },
    /**
     * 📣 起動したときのお知らせ(P11 段⑤)。
     *
     * 🔴 **中身は `announce.ts` に取り出してある**(2026-08-08、変異試験の指摘)──
     * この file は**どの test からも実行されていない**ので、ここへ直書きすると
     * 「設定を切っただけの user を既読にする」型の取り違えが**全 test 緑のまま**
     * 出荷される(実際に変異で確かめた)。
     * ⚠ 映し直しだけは主語がここ(`center`)なので、注入して渡す。
     */
    ...announceServices(announce, appNoticeStore, () =>
      // ⚠ 器は 1 度しか組まないので、映さないと古い値が見える
      //    (CLAUDE.md「設定画面の値の同期」)
      center.render(dispatcher.getState()),
    ),
    // 🔄 新しい版へ交代する(P7 段⑤)。⚠ 頼むだけ ── 再読込は交代が済んでから
    applyUpdate: () => updatePrompt.apply(),
    // ⚠ 見送っても待機中の worker は残るので、次に開いたときに再び出る
    dismissUpdate: () => updatePrompt.dismiss(),
    // 📤 バックアップ書出し(P6d)。⚠ **asset gate の内側** ── 書出し中に添付が
    // 掃除されると「meta はあるが bytes が無い」を掴んで欠けたアーカイブができる
    exportArchive: () => void runExport('archive'),
    exportHtml: () => void runExport('html'),
    exportMarkdown: () => void runExport('markdown'),
    exportEntry: (lid) => void runExport({ entryLid: lid }),
    /**
     * 🔑 図 1 枚をベクタで書き出す(P8 段⑦)。
     * ⚠ **asset gate の外**でよい ── store も添付も触らず、原文から焼き直すだけ。
     * ⚠ 画面の PNG キャッシュは使わない(user 指示: 書き出しはベクタ)。
     */
    exportDiagram: (source, index) => {
      const lid = dispatcher.getState().selectedLid;
      const title = (lid ? dispatcher.getState().entryMetas.get(lid)?.title : '') || '図';
      // ⚠ **Promise を返す**(P8 段⑬ review M-3)── 押した側が待ちを出せるように。
      //    投げない(失敗は OP_FAILED で可視化する)ので、呼び側は finally だけでよい
      return (async () => {
        try {
          // ⚠ 画面と**同じ配色**で起こす(見えている図と落ちる物の色を違えない)
          const svg = await renderToSvg(source, readPalette());
          // ⚠ mermaid は `<?xml?>` を付けない ── 素の `<svg>` でも image/svg+xml で
          // ブラウザは開ける。ここで宣言を足すと二重宣言の壊れた形になりうる
          downloadBlob(
            diagramFileName(title, index),
            new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
          );
        } catch (e) {
          // 黙って何も起きないのが一番悪い ── 失敗も可視で終える
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: `図を書き出せませんでした: ${String(e).slice(0, 120)}`,
          });
        }
      })();
    },
    // 破壊的操作(削除)を止めるための観測点(P6f review M-2)
    busy: () => withAssetGate.busy,
    purgeOrphanAssets: () =>
      void withAssetGate(async () => {
        try {
          // editing 中は draft が disk と違う参照を持ちうる ── ready 限定で可視ブロック
          if (dispatcher.getState().phase !== 'ready') {
            dispatcher.dispatch({
              type: 'OP_FAILED',
              error: '編集を終了してから整理してください',
            });
            return;
          }
          await runExplicitPurge({
            ports: {
              listMetas: () =>
                client.request({ op: 'listAssetMetas', cid: DEFAULT_CID }),
              listBlobKeys: () => blobs.listKeys(DEFAULT_CID),
              scanReferenced: async (candidates: string[]) =>
                (
                  await client.request({
                    op: 'scanAssetRefs',
                    cid: DEFAULT_CID,
                    candidates,
                  })
                ).referenced,
              deleteBlob: (key: string) => blobs.delete(DEFAULT_CID, key),
              deleteMeta: async (key: string) => {
                await client.request({ op: 'deleteAssetMeta', cid: DEFAULT_CID, key });
              },
            },
            isReady: () => dispatcher.getState().phase === 'ready',
            // 一括削除なので fail closed(confirm が無い環境では実行しない ──
            // 単発の delete-entry が ?? true なのとは桁が違う)
            confirm: (msg) => ask(msg, false),
            alert: (msg) => window.alert?.(msg),
            formatSize,
          });
        } catch (e) {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: `添付の整理に失敗しました: ${String(e)}`,
          });
        }
      }),
  };
  bindActions(root, dispatcher, services);
  // html sandbox iframe の高さ追従。1 listener が message 内 id で iframe を
  // 特定するので boot で 1 回だけ張る(規約 ── 多重 install ガードは無い)。
  // ⚠ 別 document の surface(Viewer popup 等、P3-8)には効かない ── その
  // document ごとに再結線が要る(PKC2 で entry-window が高さ 0 のままだった教訓)
  installHtmlSandboxResizer();
  /**
   * 🔴 **箱が「外部画像を止めた」と言ってきたら帯を出す**(2026-08-06)。
   *
   * 箱の中身は script なので、外部画像を出すかは**描く前には判らない** ──
   * 実際に CSP が止めた瞬間だけが確かな材料である。これが無いと「常に確認」で
   * 箱の画像を**同意する手段が無い**(聞く材料が無いので帯が出ない)。
   * ⚠ どのノートの箱かは **いま選んでいるノート**で決める ── 箱は選択中の
   *   ノートの本文にしか居ない(別ノートの箱は DOM に無い)。
   */
  installHtmlSandboxBlockedReporter((_iframe, blocked) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid) center.noteBlockedBox(lid, blocked);
  });
  connectStoreEffects(dispatcher, createStorePort(client, DEFAULT_CID));
  /**
   * 🔴 **一式が入っているかを 1 度だけ読み、控えに写す**(#88 / O3-c)。
   *
   * 入口を描くのは click と同じ**同期**の世界だが、IDB は非同期でしか読めない ──
   * だから起動時に読んで `appOfficePack` に控える。
   * ⚠ **読めたら描き直す** ── boot 直後の 1 枚目は「まだ入っていない」で描かれて
   *   いるので、写しただけでは設置カードが残る(設定を変えたときと同じ作法)。
   * ⚠ 失敗しても黙って落とす ── Office を使わない user の起動を、ここで止めない。
   */
  void officeInstaller
    .readMeta()
    .then((meta) => {
      if (!appOfficePack.setMeta(meta)) return;
      center.invalidateDetail();
      center.render(dispatcher.getState());
    })
    .catch(() => {});

  dispatcher.dispatch({
    type: 'SYS_BOOTED',
    cid: DEFAULT_CID,
    metas,
    relations, // 常駐(§6: 肥大が数字で出たら SQL query 化へ移す)
  });
  return {
    dispatcher,
    storageVfs: init.vfs,
    /**
     * OS の `launchQueue` から来たファイルを取り込む(P7 段③)。
     *
     * 🔴 **断らない**。user のクリック起点の取込は「編集中です」「整理中です」で
     * 断ってよい(選び直せる)が、OS の launch は**一発限り**で picker が出ない
     * ── 断った時点でファイルは失われる(review H2 で実証)。
     * ready になるまで待ち、gate は順番待ちする版を使う。
     * ⚠ 取込の**本体は binder と同じ** `runImport`(2 経路にしない)
     */
    importLaunchFiles: async (items) => {
      await whenPhaseReady(dispatcher, () =>
        showStatus('編集を終えると、開いたファイルを取り込みます'),
      );
      // 🔴 **同じファイルを 2 回開いても増やさない**(2026-08-05)。
      //    判定の中身は `launched-files.ts`(ここに書くと test が写しを見るだけになる)
      const { fresh, reopened } = await splitAlreadyOpen(items, launched, (lid) =>
        dispatcher.getState().entryMetas.has(lid),
      );
      for (const lid of reopened) selectWhenPresent(dispatcher, lid);
      if (fresh.length === 0) {
        // ⚠ **黙って終えない** ── 「開いたのに何も起きない」に見える
        showStatus(
          reopened.length > 0
            ? 'すでに開いているノートを表示しました'
            : '開けるファイルがありませんでした',
        );
        return;
      }
      await withAssetGate.queued(() =>
        runImport(
          fresh.map((i) => i.file),
          fresh.map((i) => i.handle),
        ),
      );
    },
    presentUpdate: (apply) => updatePrompt.present(apply),
    presentAnnounce: () => announce.present(),
  };
}

function bootstrap(): void {
  const root = document.querySelector<HTMLElement>('[data-pkc-slot="root"]');
  if (!root) return;

  /**
   * SW の登録。⚠ **boot と競わせない**(P7 段⑤ round-2 review L-6)。
   *
   * 当初は boot の前に呼んでいたが、`register` は precache(実測 1.6MB)の
   * 取得を始めるので、**初回訪問では boot の wasm / worker chunk と帯域を奪い合う**。
   * 段⑤ の目的は「boot が失敗しても次回オフラインで開ける」だったので、
   * **成功側と失敗側の両方から呼ぶ**ことで、競合させずに同じ性質を保つ。
   */
  const registerSw = (): Promise<ServiceWorkerRegistration | null> =>
    import.meta.env.PROD && 'serviceWorker' in navigator
      ? navigator.serviceWorker.register('./sw.js').catch(() => null)
      : Promise.resolve(null);

  /**
   * 🔴 **boot が終わる前に別タブが交代させたら、このタブは黙って読み直す**
   * (P7 段⑧、段⑤ round-1 review M-4 で「塞いでいない」と記録した窓)。
   * lease 待ちのタブは storage worker をまだ作っておらず、そのまま進むと
   * **旧 build の hash 付き URL** を取りに行って 404 で起動不能になる。
   * ⚠ `startApp` より前に張る ── 待っている窓こそが対象である
   */
  const preboot =
    'serviceWorker' in navigator
      ? reloadOnPrebootSwap(navigator.serviceWorker as unknown as PrebootTarget, () =>
          location.reload(),
        )
      : null;

  void startApp(root)
    .then((app) => {
      // 🔴 受け口は**アプリが受け取れるようになってから**張る(P7 段③)。
      // 仕様上 LaunchParams は **consume されるまで無期限にバッファ**され、
      // `setConsumer` 前に溜まっていたぶんは登録直後に渡される ──
      // 早く張って自前バッファへ吸い出すと、**取りこぼしの責任がブラウザから
      // アプリへ移る**だけで、boot が失敗すればファイルは消える(再読込でも戻らない)。
      // ⚠ 当初これを逆に読んで「await より前に張らないと落ちる」と書いていた
      armLaunchQueue(window as unknown as LaunchTarget, app.importLaunchFiles, (message) =>
        app.dispatcher.dispatch({ type: 'OP_FAILED', error: message }),
      );
      // boot 完了の正本契約(P3-8): smoke / probe は DOM 属性で待つ。
      // PKC2 の教訓 ── 「#root 存在待ち」は HTML load 段階で通過して flake 化する
      root.setAttribute('data-pkc-boot', 'ready');
      preboot?.booted(); // 以後は勝手に読み直さない(下書きを巻き込まない)
      /**
       * 📣 お知らせ(P11 段⑤)。⚠ **boot 完了の刻印より後**に出す ──
       * 先に出すと、まだ何も映っていない画面に帯だけが立つ。
       * ⚠ `watchForUpdate` より前でよい(別の行なので重ならない)。
       */
      app.presentAnnounce();
      // 🔄 更新の案内(P7 段⑤)。⚠ 自動では交代させない ── 交代は旧 build の
      // cache を消すので、user が押したときだけ・押したタブだけを再読込する
      const registered = registerSw();
      void watchForUpdate(
        navigator.serviceWorker as unknown as UpdateContainer,
        registered,
        (apply) => app.presentUpdate(apply),
        () => location.reload(),
      );
      /**
       * 🔴 **初回訪問だけ 1 回読み直して分離を成立させる**(#111)。
       *
       * 本番(GitHub Pages)の COOP/COEP は SW が被せるが、**SW は自分を登録した
       * 文書を制御していない** ── その 1 回だけ分離しない。判断(いつ読み直すか /
       * どこで諦めるか)は `coi-reload.ts` に在る。ここは配線だけ。
       *
       * ⚠ **成功側にしか置かない。** boot が失敗した画面を読み直すと、user が
       * 読むべき理由が消える(失敗側は登録だけして終わる)。
       */
      void applyIsolationReload({
        registration: registered,
        ready:
          'serviceWorker' in navigator
            ? (navigator.serviceWorker.ready as unknown as Promise<{ active: unknown }>)
            : null,
        globals: globalThis,
        session: typeof sessionStorage === 'undefined' ? null : sessionStorage,
        reload: () => location.reload(),
      });
      if (import.meta.env.DEV) {
        // probe / 手元検証用の導線(DEV のみ)
        (window as unknown as Record<string, unknown>).__APP__ = app;
      }
    })
    .catch((e: unknown) => {
      // boot 失敗を白画面にしない(review A-1)。とくに「未来ビルドの DB を
      // 明示 reject」(schema-migration-policy)はユーザーに見えなければ意味がない
      root.setAttribute('data-pkc-boot', 'error');
      // ⚠ 失敗しても「boot は終わった」── 勝手な読み直しで理由が消えると、
      // user は何が起きたか分からないまま同じ画面を見続ける
      preboot?.booted();
      /**
       * 🔴 **握った書込 lease を返す**(user 報告 2-14)。返さないと、この失敗した
       * タブが開いている間ずっと**他のタブが待たされる**。
       */
      bootLease?.release();
      bootLease = null;
      const message = e instanceof Error ? e.message : String(e);
      /**
       * 🔴 **OS から渡されたファイルを黙って消さない**(同 2-14)。
       *
       * 受け口(`armLaunchQueue`)は成功側にしか張っていない ── これは**正しい**
       * (張ると LaunchParams が consume され、取りこぼしの責任が browser から
       * アプリへ移る。失敗側で consume したらファイルは本当に消える)。
       * ⚠ だから**消えていないことを伝える** ── 直して読み直せば渡ってくる。
       */
      const handoff =
        'launchQueue' in window
          ? '\n(ファイルから開いた場合、そのファイルはまだ渡されていません。原因を直して読み直すと開きます)'
          : '';
      root.textContent = `起動に失敗しました: ${message}${handoff}`;
      // ⚠ boot が失敗しても登録はする ── 次回この人がオフラインで開けるかは
      // 登録が済んでいるかで決まる(段⑤ の意図。競合を避けて失敗側にも置いた)
      /**
       * 🔴 **待機中の新しい版が在るなら、自分で乗り換える**(#115)。
       *
       * 起動を壊す SW が active になると、直した版を配っても **waiting のまま**で、
       * 交代を促す案内は**起動しないと出ない** ── 詰みになる(2026-08-11 に実際に
       * 作ってしまい、実測で再現した)。起動できていないタブには「開いたままの
       * 作業を巻き込まない」という自動交代を避ける理由が**当てはまらない**。
       *
       * ⚠ 段取り(`SKIP_WAITING` → `controllerchange` → 読み直し)は
       * `watchForUpdate` のものをそのまま使う ── 2 つ目を書かない。
       * ここは「案内を見せずに即押すか」を `applyBootRecovery` に決めさせるだけ。
       */
      void watchForUpdate(
        navigator.serviceWorker as unknown as UpdateContainer,
        registerSw(),
        (apply) =>
          void applyBootRecovery({
            bootFailed: true,
            session: typeof sessionStorage === 'undefined' ? null : sessionStorage,
            apply,
          }),
        () => location.reload(),
      );
    });

}

bootstrap();
