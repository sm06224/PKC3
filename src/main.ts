// 見た目(P7b 段⑨)。⚠ **ここから import する**のが唯一の入り口 ── index.html に
// `<link>` を書くと Vite の hash 付き出力に乗らず、SW の precache 一覧からも外れる
import './styles/app.css';

import { Dispatcher } from '@adapter/state/dispatcher';
import { loadSplitLids, saveSplitLids } from '@adapter/platform/split-store';
import { isAsidePane, viewModeLabel, type ViewMode } from '@adapter/state/app-state';
import { bindEditLockRelease } from '@adapter/state/edit-lock-release';
import { connectStoreEffects, type StoreEffects } from '@adapter/state/store-effects';
import { tileSelectsEntry } from '@features/launcher/tiles';
import { appEditorMode } from '@adapter/ui/render/editor-mode';
import { applyTextScale, chosenTextScale, initialTextScale } from '@adapter/ui/render/text-scale';
import { textScaleSpec } from '@features/text-scale';
import { applyColumnRule, initialColumnRule } from '@adapter/ui/render/column-rule';
import { applyTagBadge, initialTagBadge } from '@adapter/ui/render/tag-badge';
import {
  applyReadColumns,
  initialReadColumns,
  installColumnFit,
  installColumnWheel,
} from '@adapter/ui/render/read-columns';
import { setFoldNotify } from '@adapter/ui/render/fold-notify';
import { appTooNarrowOk, installTooNarrow } from '@adapter/ui/render/too-narrow';
import { paintStatusOpen, paintStatusUndo } from '@adapter/ui/render/status-open';
import { appOpenInEdit } from '@adapter/ui/render/open-in-edit';
import { appPanes, applyPaneVisibility } from '@adapter/ui/render/pane-visibility';
import { installAppendAutofold } from '@adapter/ui/render/append-autofold';
import { appPaneSizes, applyPaneSizes } from '@adapter/ui/render/pane-size';
import { installPaneResize } from '@adapter/ui/render/pane-resize';
import { installPlaceDrag } from '@adapter/ui/render/place-drag';
import { appKeymap } from '@adapter/ui/render/keymap';
import { wireShortcutHints } from '@adapter/ui/render/shortcut-hint';
import { startEmbedBridge } from '@adapter/transport/embed-bridge';
import { startCapture } from '@adapter/transport/capture-bridge';
import { EmbedOriginsStore } from '@adapter/transport/embed-origins';
import { appFlags } from '@adapter/platform/flag-store';
import {
  FLAG_CAPTURE,
  FLAG_EMBED,
  FLAG_OFFICE_INPUT_LOG,
  FLAG_PASTE_INSPECT,
} from '@features/flags';
import { appBrowseMode, isBrowseMode } from '@adapter/ui/render/browse-mode';
import { StoreClient } from '@adapter/platform/storage/store-client';
import { openAssetWindow } from '@adapter/platform/asset-window';
import { assetWindowKind } from '@features/asset/asset-preview-kind';
import {
  createStorePort,
  metaFromRow,
  relationFromRow,
  REVISION_KEEP_LATEST,
} from '@adapter/platform/storage/store-port';
import { acquireWriterLease } from '@adapter/platform/storage/writer-lease';
import { bundleChannelName, bundleLockName } from '@features/portable/bundle';
import { readBundle, resolvePortableStart, type PortableStart } from '@adapter/platform/portable-boot';
import { restoreEmbeddedAssets } from '@adapter/platform/portable-assets';
import { exportPortable } from '@adapter/ui/actions/export-portable';
import {
  connectPortablePersist,
  type PortablePersist,
} from '@adapter/platform/storage/portable-persist';
import { ProxyStoreClient, StoreProxyHost } from '@adapter/platform/storage/store-proxy';
import type { StoreClientLike, TabSync } from '@adapter/platform/storage/store-proxy';
import type { InitResult } from '@adapter/platform/storage/protocol';
import {
  installHtmlSandboxBlockedReporter,
  installHtmlSandboxResizer,
} from '@features/markdown/html-sandbox';
import { AssetBlobStore } from '@adapter/platform/storage/asset-blob-store';
import {
  purgeBlockReason,
  runExplicitPurge,
  strayBlobKeys,
} from '@adapter/platform/storage/asset-gc';
import {
  LEGACY_HOST_NOTICE,
  isUnknownOpError,
  resolveContainerCompat,
} from '@adapter/platform/storage/resolve-container-compat';
import { buildShell, paintAlarmBar, paintCaptureBar, paintTimerBar } from '@adapter/ui/render/shell';
import { appPhone } from '@adapter/ui/render/phone-layout';
import { showNotices, clearNotices } from '@adapter/ui/render/notices';
import { createImportUndo, importPanel } from '@adapter/ui/actions/import-undo';
import { createUpdatePrompt } from '@adapter/ui/render/update-card';
import { createAnnounce, announceServices } from '@adapter/ui/render/announce';
import { versionText, MANUAL_TEXT } from '@adapter/ui/render/help';
import { manualSections } from '@features/help/manual-find';
import { MANUAL_PAGE_FILE, manualBuildTag } from '@features/help/manual-page';
import {
  openManualWindow,
  MANUAL_WINDOW_TITLE,
  type ManualAppearance,
} from '@adapter/platform/manual-window';
import { portableManualPage } from '@adapter/platform/portable-manual';
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
import { appPasteSource } from '@adapter/ui/render/paste-source';
import { appDualPrefs } from '@adapter/ui/render/dual-prefs';
import { isPasteSource } from '@features/markdown/paste-source';
import { launchTile } from '@adapter/ui/launch-tile';
import { collectExistingLids } from '@features/import/existing-lids';
import { appOfficePack } from '@adapter/ui/render/office-entry-view';
import { applyPackResult } from '@adapter/ui/render/office-pack-panel';
import { LocalOfficeFiles } from '@adapter/platform/office/local-office-files';
import {
  cannotWriteBackNotice,
  isOfficeLaunchFile,
  localOpenNotice,
} from '@features/office/office-launch';
import { OfficeWindow } from '@adapter/platform/office/office-window';
import { createOfficeOpener } from '@adapter/platform/office/office-open';
import { watchOfficeHang } from '@adapter/platform/office/office-hang-watch';
import {
  checkPackUpdate,
  packUpdateNotice,
} from '@adapter/platform/office/office-pack-update';
import { OfficePackStore } from '@adapter/platform/office/office-pack-store';
import {
  OfficePackInstaller,
  type PackResult,
} from '@adapter/platform/office/office-pack-install';
import {
  announceOfficeProfileReset,
  resetOfficeProfile,
} from '@adapter/platform/office/office-profile';
import { readAppStorage } from '@adapter/platform/app-storage';
import { readAttachmentMeta } from '@features/flavor/attachment-flavor';
import { formatAssetRef } from '@features/asset/asset-ref-format';
import { pastedImageName } from '@features/asset/pasted-image-name';
import { adoptUrls, fetchImageBlob } from '@adapter/ui/actions/adopt-urls';
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
import {
  bindActions,
  generateLid,
  runGlobalCommand,
  type BinderServices,
} from '@adapter/ui/actions/binder';
import { createCaptureService } from '@adapter/ui/actions/capture';
import { createTimerService } from '@adapter/ui/actions/timer';
import { createAlarmService } from '@adapter/ui/actions/alarm';
import { createChime } from '@adapter/platform/chime';
import { appAlarmEnabled } from '@adapter/ui/render/alarm-enabled';
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
import type { ExtWriteOp } from '@features/extension/ext-write';
import { applyExtWriteOps } from '@adapter/state/ext-write-apply';
import { selectWhenPresent } from '@adapter/state/select-when-present';
import {
  attachFiles,
  storeAsset,
  attachOne,
  resolveMime,
  type AttachDeps,
} from '@adapter/ui/actions/attach';
import { assetKeyFromHash } from '@adapter/platform/storage/asset-key';
import { createOfficeSaveBack } from '@adapter/platform/office/office-save-back';
import { openStageDir } from '@adapter/platform/office/office-stage';
import { importFiles } from '@adapter/ui/actions/import-file';
import type { ImportDeps } from '@adapter/ui/actions/import-pkc2';
import {
  exportArchive,
  exportEntry,
  exportFolder,
  type ExportDeps,
  exportEntryDocx,
  exportEntryPptx,
  type ExportKind,
} from '@adapter/ui/actions/export-archive';
import { createAssetGate } from '@adapter/ui/actions/asset-gate';
import { generateAssetKey } from '@adapter/platform/storage/asset-key';
import { downloadBlob, downloadUrl } from '@adapter/platform/download';
import { diagramFileName } from '@features/export/file-name';
import { renderToSvg, readPalette, svgWithIntrinsicSize } from '@adapter/ui/render/mermaid-raster';
import { MERMAID_KIND } from '@adapter/ui/render/mermaid-hydrate';
import { CHART_KIND } from '@adapter/ui/render/chart-raster';
import { SameOriginGate } from '@adapter/platform/same-origin-grants';
import { appExtensionGrants } from '@adapter/platform/extension-grants';
import { appExtLinks } from '@adapter/platform/extension-links';
import { connectExtension } from '@adapter/platform/extension-host';
import {
  NOTE_OPEN_HERE_MESSAGE,
  announceOpenedWindow,
  connectViewDeepLink,
  currentBaseUrl,
  isPurposeWindow,
  noteOpenElsewhereMessage,
  noteOpenedByUs,
  windowDeepLinkTarget,
  windowTitleFor,
} from '@adapter/platform/deep-link';
import { openView, openViewHere } from '@adapter/ui/render/open-view';
import { noteRemoteChange } from '@adapter/state/remote-change';
import {
  NOTE_REGISTRY_CHANNEL,
  createNoteRegistry,
} from '@adapter/platform/note-window-registry';
import {
  closeViewWindow,
  openNoteWindowUrl,
  openViewInWindow,
  openViewWindowUrl,
  VIEW_WINDOW_OPENING,
  waitForViewWindow,
} from '@adapter/platform/view-window';
import {
  alertInApp,
  confirmInApp,
  type ConfirmOptions,
} from '@adapter/ui/render/app-dialog';
import { printNote } from '@adapter/platform/print-note';

const DB_NAME = 'pkc3';
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
  /**
   * 🔴 **状態の行を塗り直す**(#300 段④)。⚠ 配線が「アプリの窓か」の旗を
   * 倒した瞬間に効かせるために要る ── 旗だけ倒しても、次に何かが起きるまで
   * 古い帯が残る(離れた瞬間に「本体タブ経由です」が戻るべきである)。
   */
  repaintStatus(): void;
  /**
   * 🔴 **窓の題名を塗り直し、台帳へ名乗り直す**(#685 着地前レビュー ⚠3)。
   * ⚠ 状態の行とは**別に**要る ── 付箋の題名は**いま開いているノート**で決まるので、
   * 旗が倒れた瞬間だけでなく**ノートが変わった / 改名された**ときにも塗り直す。
   * ⚠ **名乗りも撃つ**(2026-09-04 に docstring を直した)── 題名だけの口だと
   * 読み違える。付箋の台帳(「2 枚目を作らない」)はこの名乗りで埋まる。
   */
  repaintWindowTitle(): void;
  /**
   * 🔴 **この窓を付箋として整える**(#690 ② A′ / I4、user 裁定 2026-09-04)。
   * ⚠ 呼ぶのは配線が「付箋の旗」を立てた瞬間だけ ── ①追記欄を必ず出し、以後この窓の
   *   畳みを端末の記録から切り離す(`PaneVisibilityStore.sessionOnly`)②本文が届いたら
   *   1 回だけ打つ欄へ焦点を入れる(`AppendBoxRenderer.focusInputOnceReady`)。
   * ⚠ 判断は 2 つとも向こうに在る ── この file はどの test からも実行されない(§2)。
   */
  enterNoteWindow(): void;
  /**
   * 🔴 **探し方(左の列のタブ)を切り替える**(#292 段⑤)。
   * ⚠ 引っ越したディープリンク(`view=calendar` / `view=kanban`)を
   *   「予定」タブへ送るために要る ── boot の外から呼ぶので handle に出す。
   */
  setBrowse(mode: BrowseMode): void;
}

/**
 * 昇格 boot(lease 待ち → held)では、旧タブの SAH 解放が lock 解放より遅れて
 * memory fallback しうる(review B-2 ── 空 DB に見え、編集が reload で消える)。
 * fallback を受け入れず、新しい worker で短い backoff 再試行する
 * (install 失敗は worker 内で per-name cache されるため、worker ごと作り直す)。
 */
async function initStorage(
  promoted: boolean,
  portable: PortableStart | null,
): Promise<{
  client: StoreClient;
  init: InitResult;
}> {
  /**
   * 🔴 **可搬単一 HTML は OPFS を試さない**(#400 段③)。
   *
   * `file://` では原理的に取れず(opaque origin)、`https://` に置いたときは
   * **その origin の本体の DB を開いてしまう** ── どちらでも試す理由が無い。
   * ⚠ そして `memory` は fallback ではなく**選んだ形**なので、以下の
   * 「memory なら失敗」の再試行にも入れてはならない(入れると必ず起動に失敗する)。
   */
  const req = portable
    ? ({
        op: 'init' as const,
        dbName: portable.dbName,
        memory: true,
        ...(portable.image ? { image: portable.image } : {}),
      })
    : ({ op: 'init' as const, dbName: DB_NAME });
  let client = new StoreClient();
  let init = await client.request(req);
  if (promoted && portable === null && init.vfs === 'memory') {
    for (const delayMs of [200, 500, 1000]) {
      client.terminate();
      await new Promise((r) => setTimeout(r, delayMs));
      client = new StoreClient();
      init = await client.request(req);
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

/**
 * 🔴 **この窓が「アプリの窓」である間だけ真になる**(#300 段③ の直し、2026-08-22)。
 *
 * ⚠ `connectViewDeepLink` は boot の**後**に配線されるが、`× 閉じる` の受け口は
 * boot の**中**で組む ── だから値を持つのは module 側で、配線が書き込む。
 * ⚠ **判断はここに書かない**(`closeViewWindow` が持つ)── この file は
 * どの test からも実行されない(CLAUDE.md §2)。
 */
let heldViewWindow: ViewMode | null = null;

/**
 * 🔴 **この窓が「付箋」である間だけ真になる**(#685 着地前レビュー 🔴1 / ⚠3、2026-09-04)。
 *
 * ⚠ `heldViewWindow` と**別の軸**である ── あちらは `view=` を指しているとき、
 *   こちらは**ノートを名指した断片**で開いた窓。判断は `deep-link.ts` の
 *   `onHoldEntry` が持つ(この file はどの test からも実行されない)。
 */
let heldNoteWindow = false;

/**
 * 🔴 **組み込みタイルは別窓で開く**(#300 段③、2026-08-22)。
 *
 * ⚠ ここは**配線だけ** ── 判断(窓が出たか)・文言・退避先は `view-window.ts` に在る。
 *   この file はどの test からも実行されないので、判断を置くと
 *   「全 test 緑のまま出荷される」形になる(CLAUDE.md §2)。
 * ⚠ `window.open` は **gesture の中**でしか通らない ── `openViewInWindow` は
 *   `await` より前に `open` を呼ぶ形にしてある。
 */
function openViewTile(
  dispatcher: Dispatcher,
  cid: string,
  /**
   * ⚠ **`dual` だけ**だった期間がある(#292 段⑤、2026-08-23)── カレンダーと
   *   やることの板は**左の列の「予定」タブ**へ引っ越したので。
   * 🔴 **#673 段②(user 裁定 2026-09-04「アプリの基本は別窓」)で予定表が加わった**
   *   ── 絞りは型で持たず、何が来るかは `tiles.ts` の組み込みタイルが決める
   *   (`launch-tile.ts` が `isViewMode(kind)` で渡す)。
   * 🔑 別窓の仕掛け(ディープリンク / 一回限りの合図 / `script-closable` の判定 /
   *   follower の帯)は**共通** ── Office と今後のアプリがそのまま使う土台である。
   */
  view: ViewMode,
  /**
   * 🔴 **左の列のタブを開く口**(#673 段②)── 予定表の退避先は中央の面ではなく
   *   **左の列の「予定」タブ**(本文を退かさない)。判定は `open-view.ts` の
   *   `openViewHere` → `browse-mode.ts` の `homeTabOf` に在り、ここは口を渡すだけ。
   */
  openBrowse: (mode: BrowseMode) => void,
  /**
   * 🔴 **左の列の欄へ焦点を入れる口**(#680)── 探す面の退避先。判定は `openViewHere`、
   *   実体は `binder.ts` の `focus-search`(畳んだ列を戻してから焦点を入れる)。
   */
  focusSearch: () => boolean,
): Promise<unknown> {
  return openViewInWindow(view, {
    // ⚠ `noopener` で開く ── 別プロセスになり、閉じれば常駐が還る(段③ の実測)。
    //    🔑 **口は `view-window.ts` の 1 つ**(着地前レビュー M2)── 手で書くと、
    //       片方から `noopener` が落ちた日に誰も鳴らない
    open: openViewWindowUrl,
    baseUrl: currentBaseUrl,
    // 🔴 **いま読んでいたノートを連れて行く**(段③ の直し)── 渡さないと、
    //    別窓のカレンダーは「ノートを選んでください」で立ち上がる
    selected: () => {
      const lid = dispatcher.getState().selectedLid;
      return lid === null ? null : { containerId: cid, lid };
    },
    newToken: makeViewWindowToken,
    waitForOpen: waitForViewWindow,
    /**
     * ⚠ 退避は `open-view.ts` を通す(開いた後の後始末を落とさない)。
     * 🔴 **`nextViewMode` を通さない**(着地前レビュー 1)── あれは
     *    「タイル再押下で閉じる」ための規則であって、退避は**開く**である。
     *    通すと、塞がれて無反応だからもう一度押した回に**開いた面を閉じる**。
     */
    // 🔴 **予定表は左の列の「予定」タブへ退避する**(#673 段②)── 中央に開くと
    //    本文が消える(#292 段⑤ の理由)。振り分けは `openViewHere` の 1 か所
    openInPane: (v) => openViewHere(dispatcher, v, openBrowse, focusSearch),
    fail: (error) => dispatcher.dispatch({ type: 'OP_FAILED', error }),
    // 🔴 押した瞬間に返事をする(#685 動線レビュー 欠陥 7)── 塞がれた回は
    //    2.5 秒まるごと無反応で、user は「効いていない」と読んでもう一度押す
    notify: (message) => dispatcher.dispatch({ type: 'OP_NOTICE', message }),
  });
}

/**
 * 🔴 **マニュアルを独立した窓で開く**(#645。user 要望 2026-08-31)。
 *
 * > 「**ヘルプの中からマニュアルをアプリとして出してください**」
 *
 * ⚠ **`openViewTile` を通さない** ── あちらは PKC をもう 1 枚読み込む
 *   (実測 +29.6MB / プロセス +1)。しかもその窓でもマニュアルは
 *   `max-height: 60vh` の箱のままで、**読みにくさが 1 ミリも変わらない**。
 * ⚠ ここも**配線だけ** ── 組み立てと文言は `manual-window.ts` /
 *   `features/help/manual-doc.ts` に在る(この file はどの test からも
 *   実行されない ── CLAUDE.md §2)。
 */
/**
 * いまアプリが出している見え方(配色 / 文字の大きさ / 地と字の色)。
 * ⚠ 配色と地の色は**設定の保存ではなく、画面に効いている値**を読む ── OS に従っている人の
 *   配色は保存されていない(`theme.ts` の M-7)ので、属性から取る。
 * 🔴 **文字の大きさだけは保存から読む**(2026-09-02 hotfix)── 画面に効いている値は
 *   選んでいなくても既定の 13px だが、焼いたマニュアルは**選んでいなければ触らない**
 *   (`manual-page.ts` の boot script は保存が無ければ CSS の既定のまま。I6 で揃えるまで
 *   それは 14px だった)。効いている値を渡すと、**何も変えずにもう一度押しただけで窓の字が
 *   14px → 13px に縮んだ**(着地前レビューが拾った)。boot と同じ門(`chosenTextScale`)で
 *   読めば、2 回目は 1px も動かない。
 */
function currentAppearance(): ManualAppearance {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const nonEmpty = (v: string): string | null => (v.trim() === '' ? null : v.trim());
  const chosen = chosenTextScale();
  return {
    theme: root.getAttribute('data-pkc-theme'),
    textSize: chosen === null ? null : textScaleSpec(chosen).size,
    bg: nonEmpty(computed.getPropertyValue('--bg')),
    fg: nonEmpty(computed.getPropertyValue('--fg')),
  };
}

/**
 * 🔴 持ち歩ける 1 枚に焼き込んだマニュアルの page(#648 段③)。⚠ document ごとに 1 つ ──
 *   `blob:` URL は窓 1 枚に 1 回(開いている間は同じ URL、閉じたら revoke して次は新しく作る
 *   ── `portable-manual.ts` の「寿命」)。
 *   素の PKC3(焼き込みが無い)では `url()` が `null` を返すだけで、経路は変わらない。
 */
const portableManual = portableManualPage(document);

function openManualTile(
  dispatcher: Dispatcher,
  markdown: { render(text: string, opts?: { currentContainerId?: string }): Promise<string> },
  /**
   * 一時の知らせ。⚠ **既に開いていた回に何か言う**ため ── `focus()` が窓を手前へ
   * 出せるかはブラウザ次第で、出せなかった回は「押しても何も起きない」に見える。
   */
  notify: (text: string) => void,
): Promise<unknown> {
  const appearance = currentAppearance();
  return openManualWindow({
    title: MANUAL_WINDOW_TITLE,
    version: versionText(),
    text: MANUAL_TEXT,
    sections: manualSections(MANUAL_TEXT),
    render: (text) => markdown.render(text),
    /**
     * 🔴 焼いた 1 枚(`manual.html`)は **build の生成物の隣**に在る(段②)。
     * ⚠ 持ち歩ける 1 枚(portable = この document 自身が bundle を抱えている)には
     *   隣に無い ── 1 枚の中に焼き込んだ同じ page を `blob:` URL で渡す(#648 段③)。
     *   焼き込みの無い旧い 1 枚では `null` → `about:blank` に組む経路へ落ちる。
     * ⚠ `document.baseURI` から引く ── Pages の `/` と `/dev/` の両方で同じビルドが
     *   動く(`base: './'`)ので、絶対 path を書かない。
     */
    pageUrl:
      readBundle(document) === null
        ? new URL(MANUAL_PAGE_FILE, document.baseURI).href
        : portableManual.url(appearance),
    // 🔑 焼いた page と同じ関数で同じ印を組む(`/dev/` でも原文が変われば入れ替わる)
    tag: manualBuildTag(versionText(), MANUAL_TEXT),
    appearance,
  }).then((win) => {
    // 🔴 **開けなかったら理由を出す**(押しても何も起きないボタンにしない)
    if (win === null) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: 'マニュアルのウィンドウを開けませんでした。ブラウザのポップアップの許可を出してください',
      });
      return win;
    }
    // 🔴 窓の寿命を見張る ── 閉じたら blob を返す(持ち歩ける 1 枚だけ。素の PKC3 では何もしない)
    portableManual.watch(win.window);
    // 🔑 **既に開いていた回も、押した手応えを返す**(前へ出せたか分からないので言う)
    if (win.reused)
      notify('マニュアルのウィンドウを前に出しました(見えないときは、ウィンドウを切り替えてください)');
    // 🔑 古い版の窓を入れ替えた回は、読んでいた所が先頭へ戻る ── 理由を言う(動線レビュー I3)
    else if (win.swapped)
      notify(
        // ⚠ **逃げ道の字も揃える**(#649 の着地後レビュー ②)── 前へ出せない環境が在るのは
        //    再利用の回と同じである。片方にだけ書いていると、出なかった回に user が探す所を失う
        'マニュアルが新しくなったので、ウィンドウを入れ替えました(先頭から出ます。見えないときは、ウィンドウを切り替えてください)',
      );
    return win;
  });
}

/**
 * 1 回限りの合図。⚠ `store-proxy.ts` の `makeTabId` と**同じ倒し方**
 * (`randomUUID` が無い箱でも通る)。
 * ⚠ `formatViewDeepLink` は `[A-Za-z0-9_-]+` しか通さないので、`.` を含めない。
 */
function makeViewWindowToken(): string {
  const c = globalThis.crypto;
  return c && 'randomUUID' in c ? c.randomUUID() : `w-${Math.random().toString(36).slice(2)}`;
}

/**
 * 🔴 **この窓は PKC 自身が開いたものか**(#685 着地前レビュー 🔴1)。
 * ⚠ 「断片がノートを名指す」だけでは足りない ── **user が写した URL** でも真になり、
 *   そのふつうのタブで「別の窓で開く」が二度と効かなくなる。判断は
 *   `deep-link.ts` の `noteOpenedByUs` に在る。
 */
let openedByUs = false;

/** boot(設計メモ §1): lease → worker init(または #177 の proxy 接続)→ メタ一覧 → SYS_BOOTED。 */
export async function startApp(root: HTMLElement): Promise<AppHandle> {
  /**
   * 🔴 **可搬単一 HTML かどうかを、いちばん先に決める**(#400 段③)。
   *
   * ⚠ 鍵の名前・放送路の名前・器の名前が**全部これで決まる**ので、lease を
   *   取る前でなければならない。⚠ `file://` では鍵も放送路も scheme 全体で
   *   1 個なので、名前を切らないと**別のバンドルのタブと繋がる**(実測)。
   * ⚠ 素の PKC3 では `null` ── 以下の既定値がそのまま効き、経路は変わらない。
   */
  const portable = await resolvePortableStart(document);
  const lease = acquireWriterLease(
    portable ? bundleLockName(portable.bundle.id) : undefined,
  );
  const proxyDeps = portable ? { channel: bundleChannelName(portable.bundle.id) } : {};

  /**
   * 🔴 **同じノートの付箋を 2 枚作らない台帳**(#685、user 裁定 2026-09-04)。
   *
   * ⚠ **`main.ts` は判断を持たない** ── 台帳の規則も便りの綴りも
   *   `note-window-registry.ts` に在る(この file はどの test からも実行されない)。
   * ⚠ 放送路が無い箱(古いブラウザ / test)では**常に空**になり、
   *   今までどおり 2 枚目が開く(壊れる方向へは倒れない)。
   * 🔴 **`portable` が解けた後で建てる**(着地前レビュー ⚠5)── 可搬単一 HTML は
   *   `file://` で開かれ **origin が全部 `file://` に潰れる**ので、放送路の名前を
   *   バンドルごとに切らないと、**別のバンドルの窓**が「すでに開いています」と
   *   断り、`raise` が**別の HTML の窓**を手前に出す(台帳の鍵は `lid` = 衝突する)。
   */
  const noteChannel = portable
    ? `${NOTE_REGISTRY_CHANNEL}:${portable.bundle.id}`
    : NOTE_REGISTRY_CHANNEL;
  const noteRegistry = createNoteRegistry({
    channel: typeof BroadcastChannel === 'function' ? new BroadcastChannel(noteChannel) : null,
    id: makeViewWindowToken(),
    // ⚠ 「前に出る」は実測できていない(headless では親子とも `hasFocus` が真)──
    //    例外を投げないことだけ確かめてある。だから**画面の字では約束しない**
    onRaise: () => window.focus(),
  });
  if (typeof window === 'object') {
    // ⚠ **閉じない。名乗りを 1 通出すだけ**(着地前レビュー ⚠2)── `pagehide` は
    //    bfcache へ入るときにも飛ぶので、ここで放送路を閉じると戻ってきた窓が壊れる
    window.addEventListener('pagehide', () => noteRegistry.leave());
  }
  bootLease = lease;

  /**
   * 🔴 **可搬単一 HTML の保存**(#400 段③)。
   *
   * 🔑 **holder になったタブだけが armed される** ── 実 worker を持っているのは
   * holder だけなので、器へ書けるのも holder だけである。follower の書込も
   * holder が実行するので、`onMutation` は 1 か所で足りる(CLAUDE.md §7)。
   * ⚠ **昇格した回も arm する** ── 忘れると、本体タブが閉じた後に続きを書いた
   *   ぶんが**丸ごと保存されない**(閉じるまで誰も気づけない)。
   */
  let persist: PortablePersist | null = null;
  let persistState = '';
  /** ⚠ `paint` はずっと後で組まれるので、繋がるまでは何もしない口にしておく。 */
  let repaintStatus: () => void = () => undefined;
  const armPersist = (real: StoreClient): void => {
    if (portable === null || persist !== null) return;
    persist = connectPortablePersist({
      exportImage: async () => (await real.request({ op: 'exportImage' })).image,
      write: ({ savedAt, image }) =>
        portable.store.write({ exportedAt: portable.bundle.exportedAt, savedAt, image }),
      onState: (st) => {
        persistState =
          st.kind === 'error'
            ? `⚠ この端末に保存できませんでした(${st.why})`
            : st.kind === 'pending'
              ? '⏳ 保存待ち'
              : '';
        repaintStatus();
      },
    });
    /**
     * 🔴 **閉じる前に流す。** ⚠ `beforeunload` だけに頼らない ── モバイルでは
     *   飛ばないことがある。`visibilitychange`(hidden)が唯一ほぼ確実な合図で、
     *   `pagehide` がその次点である。
     */
    const flush = (): void => void persist?.flush().catch(() => undefined);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
  };
  const persistHook = portable ? { onMutation: (): void => persist?.touch() } : {};
  const immediateHeld = await lease.immediate;

  /**
   * 🔴 多重タブ(#177)。lease を取れたタブ(本体)は実 worker + StoreProxyHost。
   * 取れないタブは ProxyStoreClient(本体タブ経由)で **同じアプリをそのまま開く**
   * ── PKC2 でできていた「複数タブで別々のノートを開く・編集する」を戻す。
   * 本体が旧ビルド(handshake 応答なし)のときだけ、従来の待機に落ちる。
   * `sync` は編集ロックと changed の口 ── 昇格で実体が host に替わるので let。
   */
  let client: StoreClientLike;
  let init: InitResult;
  let sync: TabSync;
  let followerConn: ProxyStoreClient | null = null;
  /**
   * 🔴 **このタブが writer リースの保持者か**(#205)。⚠ **昇格で真になる** ──
   * 「呼ぶたびに読む」だけでは足りず、**変わる値**を持たないと門が開かない。
   * ⚠ `followerConn` を流用しない(あれは接続の口であって、役ではない)。
   */
  let writerHolder = false;

  if (immediateHeld) {
    writerHolder = true;
    const real = await initStorage(false, portable);
    armPersist(real.client);
    const host = new StoreProxyHost({ client: real.client, init: real.init, ...proxyDeps, ...persistHook });
    client = host.localClient();
    init = real.init;
    sync = host;
  } else {
    followerConn = await ProxyStoreClient.connect({ ...proxyDeps });
    if (followerConn?.initResult) {
      client = followerConn;
      init = followerConn.initResult;
      sync = followerConn;
    } else {
      followerConn = null;
      /**
       * 従来の待機 ── ただし**待っている間も本体の名乗りを聞き直す**(レビュー M-5)。
       * 本体がまだ boot 中(worker init が handshake の 1.5 秒に間に合わない)なだけの
       * とき、一度の時間切れで旧式待機に永久落ちしていた。lease が来るか、本体と
       * handshake できるかの早い方で進む。⚠ lease を優先する ── handshake の相手が
       * 死んだ直後なら、こちらが本体になるのが正しい。
       */
      root.textContent = '別のタブかウィンドウで開いています。そちらを閉じると、ここで続きが開きます…';
      let held = false;
      const heldP = lease.whenHeld.then(() => {
        held = true;
      });
      while (!held) {
        await Promise.race([heldP, new Promise((r) => setTimeout(r, 2000))]);
        if (held) break;
        const again = await ProxyStoreClient.connect({ ...proxyDeps, handshakeTimeoutMs: 800 });
        if (held) {
          again?.terminate();
          break;
        }
        if (again) {
          followerConn = again;
          break;
        }
      }
      if (followerConn?.initResult) {
        client = followerConn;
        init = followerConn.initResult;
        sync = followerConn;
      } else {
        followerConn = null;
        await heldP;
        const real = await initStorage(true, portable);
        armPersist(real.client);
        const host = new StoreProxyHost({ client: real.client, init: real.init, ...proxyDeps, ...persistHook });
        client = host.localClient();
        init = real.init;
        sync = host;
      }
    }
  }
  /**
   * 🔴 **この端末のコンテナ id は、DB に聞いて決める**(#260)。
   *
   * 直す前はここに `'default'` という**全インストール共通の定数**が在った。
   * `pkc://<cid>/entry/<lid>` の「自分のコンテナか」は**文字列の等値**なので
   * (`features/link/permalink.ts`)、**他人の PKC3 が書いた参照**が
   * 「自分のもの」と判定され、押しても居ない lid を指すリンクになっていた。
   *
   * ⚠ **既存の DB は `'default'` のまま返る** ── cid は全テーブルの区画鍵
   *   (`WHERE cid = ?`)なので、採番し直すと既存データがまるごと見えなくなる。
   * ⚠ 「読んで、無ければ作る」を**ここで 2 回に分けない** ── 初回起動に
   *   タブが 2 枚在ると、別々の cid を挿して器が 2 つに割れる(worker 側の
   *   `resolveContainer` が 1 op で閉じている)。
   */
  const resolved = await resolveContainerCompat(
    {
      resolveContainer: (title) => client.request({ op: 'resolveContainer', title }),
      openLegacyContainer: async (legacyCid, title) => {
        await client.request({ op: 'openContainer', cid: legacyCid, title });
      },
    },
    CONTAINER_TITLE,
  );
  const cid = resolved.cid;
  /**
   * 🔴 **採番した id を器に出す**(#260)。user 向けの表示ではなく、
   * `data-pkc-boot="ready"` と同じ**検査のための契約**である。
   *
   * ⚠ 出さないと、実機で「boot の cid が描画まで届いているか」を確かめる術が
   *   無くなる ── cid が端末ごとに違う値になったので、smoke が自分で
   *   `pkc://<自分>/entry/<lid>` を組み立てられない(#100 段① の smoke は
   *   `'default'` が定数だったからこそ書けていた)。渡し忘れる変異は
   *   「全部よそ扱い」に落ちて**静かに通ってしまう**。
   */
  root.setAttribute('data-pkc-container', cid);
  // boot と再読込は**同じ経路**で state を作る(取込後に別の作り方をしない ──
  // 分岐が増えると「取込直後だけ壊れる」型の差分が入る)
  const loadSnapshot = async () => ({
    metas: (await client.request({ op: 'listEntryMetas', cid })).map(
      metaFromRow,
    ),
    relations: (await client.request({ op: 'listRelations', cid })).map(
      relationFromRow,
    ),
  });
  const { metas, relations } = await loadSnapshot();

  const dispatcher = new Dispatcher();
  /**
   * 🔴 **確認はアプリ自身のダイアログ**(#299 段③、2026-08-21。user 裁定
   *   「ブラウザの方のアラートはマウスの動線が多くてウザいから、自前の方が嬉しい」)。
   *
   * ⚠ ここに在った「抑止されたら理由を出す」緩和は**根ごと要らなくなった** ──
   *   Chromium の「このページにこれ以上ダイアログを表示させない」は
   *   native の `confirm` にしか効かないからである。
   * ⚠ **`whenAbsent` も消えた**:「confirm が無い環境」という状態が無くなった。
   */
  const ask = (message: string, opts: ConfirmOptions = {}): Promise<boolean> =>
    confirmInApp(root, message, opts).then((a) => a === 'ok');
  /**
   * 知らせるだけ(native の `alert` の置き換え)。
   * ⚠ **捨てない** ── 断りの理由はこれでしか届かないので、器は重なったら順番に出す。
   */
  const tell = (message: string): Promise<void> =>
    alertInApp(root, message).then(() => undefined);
  // 🎨 配色は**枠より先**に当てる ── 後だと一瞬だけ既定色で描かれて瞬く
  const bootTheme = initialTheme();
  applyTheme(document.documentElement, bootTheme);
  // 📄 紙面も**枠より先**(同じ理由 ── 後だと 42rem で 1 度組んでから広がる)。
  // ⚠ ここでは**保存しない**(`applyPageFormat` は当てるだけ)── 保存するのは
  //    user が選んだときだけ(`theme.ts` の M-7 と同じ)
  applyPageFormat(document.documentElement, initialPageFormat());
  /**
   * 🔤 **文字の大きさも枠より先**(#504。理由は配色・紙面と同じ ── 後だと
   *   一瞬だけ既定の大きさで組んでから跳ねる)。
   * ⚠ ここでは**保存しない**(`applyTextScale` は当てるだけ)── 保存するのは
   *   user が選んだときだけ。
   */
  applyTextScale(document.documentElement, initialTextScale());
  /**
   * 🔴 **段組みも枠より先**(#505 段①。理由は上と同じ)。
   * ⚠ **保存しない**(当てるだけ)── 保存は user が選んだときだけ。
   */
  applyReadColumns(document.documentElement, initialReadColumns());
  /**
   * 🔴 **段の境界線の濃さも枠より先**(#525。理由は上と同じ)。
   * ⚠ **保存しない**(当てるだけ)── 保存は user が選んだときだけ。
   */
  applyColumnRule(document.documentElement, initialColumnRule());
  /**
   * 🔴 **本文の中のタグの見せ方を戻す**(#550 段③)。⚠ 段の境界線と**同じ作法** ──
   *   印を 1 つ当てるだけで、描き直しは要らない(骨組みは markdown が常に出す)。
   */
  applyTagBadge(document.documentElement, initialTagBadge());
  const regions = buildShell(root);
  /**
   * 🔴 **版面が入れ替わったときに面を描き直す口**(#671)。⚠ `center` はずっと後で
   *   組まれるので、繋がるまでは何もしない口にしておく(`repaintStatus` と同じ形)。
   */
  let repaintOnLayout: () => void = () => undefined;
  /**
   * 🔴 **縦のホイールを横送りへ読み替える**(#505)。⚠ これが無いと段組みは
   *   マウスだけでは読めない(実測: 縦ホイールで 1px も動かない)。
   * 🔑 器ごとではなく **shell に 1 本**(本文の器は開くたびに作り直される)。
   */
  installColumnWheel(root);
  /**
   * 🔴 **段の高さを px で入れ、器の変化に追随させる**(#505)。
   * ⚠ **これが無いと本文が黙って消える** ── flex が決めた高さでは段が増えず、
   *   溢れた分を `overflow-y: hidden` が刈る(実測 87px 見えなくなった)。
   */
  installColumnFit(root);
  /**
   * 🔴 **畳んだペインを起動時に戻す**(#197)。⚠ これをやらないと「覚える」が
   * 成立せず、user 指示「同じものが常に同じ場所にある」に反する ── 畳んで閉じ、
   * 開き直すと全部戻っている、という画面になる。
   */
  /**
   * 🔴 **スマホ用画面の見張りを張る**(#632 段①)。
   *
   * ⚠ ここには「**畳んだペインの復元より前**に張らないと、起動の 1 回だけ
   *   畳まれた列がスマホでも復元される」と書いてあったが、**成り立っていなかった**
   *   (2026-09-02 の着地前レビュー)── `install` は `wasPhone` を `null` から始めるので
   *   **必ず 1 回 `onToggle` を撃つ**。つまり下の 1 行は入れ替えても消しても最終の DOM は
   *   同じで、順序は何も守っていなかった(CLAUDE.md §1 の no-op)。
   * 🔑 守っているのは `applyPaneVisibility` の中の `appPhone.isPhone()` **1 か所**である。
   *   下の呼びを残すのは、**boot の読み手に「畳みを復元している」を見せるため**であって、
   *   順序のためではない。
   * ⚠ 外さない(アプリと同寿命)── `applyPaneVisibility` と同じ。
   */
  /**
   * 🔴 **スマホ⇄パソコンを跨いだら、面も描き直す**(#671 の着地前レビュー G、
   *   2026-09-04 に実測)。
   *
   * ⚠ 直す前は `applyPaneVisibility` しか呼んでおらず、**面の描画は 1 度も
   *   走らなかった** ── 2 ペインの操作の字は「1 枚だけか」で変わるのに、
   *   窓の幅は `state` を 1 バイトも動かさないので `render` に届かない。
   *   実測(375 → 1440 に広げた直後):**2 枚とも出ているのに字は「F6右へ移す」**
   *   のまま(スマホ用の字が残る)。何か 1 つ触るまで直らなかった。
   * 🔑 口は `repaintStatus` と同じ形にする ── `center` はここより後で組まれるので、
   *   繋がるまでは何もしない口にしておく。
   */
  appPhone.install(root, undefined, () => {
    applyPaneVisibility(root, appPanes.getHidden());
    repaintOnLayout();
  });
  applyPaneVisibility(root, appPanes.getHidden());
  /**
   * 🔴 **低い窓では追記欄を最初から畳む**(#701)。⚠ 畳みの復元の**後**に張る ──
   *   こちらの畳みは記録の上に重ねるだけなので順序で壊れはしないが、読み手に
   *   「記録 → こちらの畳み」の順で見せる。⚠ 外さない(アプリと同寿命)。
   */
  installAppendAutofold(root);
  /**
   * 🔴 **決めた大きさも起動時に戻す**(#497)。⚠ 畳んだ状態と**対**である ──
   * 片方だけ戻すと「畳んだのは覚えているのに幅は既定」という半端な画面になる。
   */
  applyPaneSizes(root, appPaneSizes.get());
  /** 🔴 掴んで大きさを変える配線(#497)。⚠ 外さない(アプリと同寿命)。 */
  installPaneResize(root);
  /** 🔴 板の塊を掴んで動かす配線(#283 P4-b)。⚠ 外さない(アプリと同寿命)。 */
  installPlaceDrag(root, dispatcher);
  /**
   * 🔴 **別のタブで変えたキー割当を、このタブにも効かせる**(#256)。
   * ⚠ これが無いと「2 枚目のタブで割り当て直したのに、1 枚目は再読込まで古いまま」に
   * なる ── 割当は端末の手癖なので、タブごとに違うのは事故である。
   * ⚠ 外さない(アプリと同寿命)── 外す先が無いのは `applyPaneVisibility` と同じ。
   */
  appKeymap.watchOtherTabs(window);
  /**
   * 🔴 **説明のショートカットを、いまの割当で組み立て直す**(2026-08-19)。
   *
   * ⚠ 直す前はボタンの `title` に `(Ctrl+N)` を**直書き**していたので、
   * **mac では既定のままでも 6/6 が食い違い**、user が割り当てを変えると
   * 説明だけが古い綴りのまま残っていた。
   * ⚠ **boot で 1 回だけでは足りない** ── 割当が変わったら呼び直す
   * (別タブで変えたときも `watchOtherTabs` 経由でここへ来る)。
   */
  wireShortcutHints(root);

  // ⚠ 配色の選択欄は**設定の画面**に在る(段⑨c で移した)。合わせるのは
  //    `SettingsRenderer.syncTheme()` の仕事 ── ここに 2 本目を置かない
  //    (P8 段㉕:帯を探す死んだ同期が残っており、常に空振りしていた)
  // 🔑 左の列は**探し方**で切り替わる(P8 段⑤)。中央は常に「開いているノート」
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost, appBrowseMode.get());
  const inspector = new InspectorRenderer(regions.inspector);
  /**
   * 🔴 **既定はフォルダ、前回の選択を覚える**(#240 段⑤。user 指示 2026-08-17)。
   * ⚠ 既定は `browse-mode.ts` 1 か所が持つ ── ここに書くと、また 4 か所に散る。
   */
  let browseMode: BrowseMode = appBrowseMode.get();
  // assets: bytes は IDB Blob(sqlite には meta のみ)。表示は lend/dispose 規律
  const blobs = new AssetBlobStore();
  /**
   * 🔴 **可搬単一 HTML に焼かれた添付を器へ戻す**(#400 段④)。
   *
   * ⚠ DB 画像が持っているのは添付の**目録の行**だけである(bytes は IDB Blob)──
   *   戻さないと、配られた 1 枚は**画像が全部欠けた状態**で開く。
   * ⚠ 判断と 1 件ずつ流す規律は `portable-assets.ts` が持つ(この file は
   *   どの test からも実行されない ── CLAUDE.md §2)。
   * 🔑 2 回目の起動では器に在るので飛ばす(節点だけ外す)。
   */
  let portableAssetNote = '';
  if (portable !== null) {
    const r = await restoreEmbeddedAssets(document, cid, blobs);
    if (r.failed > 0)
      portableAssetNote = `⚠ 添付 ${r.failed} 件を読み込めませんでした(その分は画像が出ません)`;
  }
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
  /**
   * 🔴 **手元のファイルを Office で開く控え**(#432)。⚠ **session 限り** ──
   * 判断も寿命も `local-office-files.ts` が持つ(ここは配線だけ)。
   */
  const localOffice = new LocalOfficeFiles();
  const officeWindow = new OfficeWindow({
    // 🔴 #433 の計測(flag `office.inputLog`)── 窓を開くたびに読み直す
    //    (フラグ画面で切り替えたら、次に開く窓から効く)
    inputLog: () => appFlags.isOn(FLAG_OFFICE_INPUT_LOG.name),
  });
  const officeOpener = createOfficeOpener({
    officeWindow,
    isPackInstalled: () => appOfficePack.isInstalled(),
    readAsset: async (assetKey) => {
      const blob = await blobs.get(cid, assetKey);
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
      lend: (key) => blobs.lendObjectUrl(cid, key),
      getBlob: (key) => blobs.get(cid, key),
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
  markBrowse(browseMode);
  // 🔑 追記欄は**本文とは別の器**(P8 段⑧)── 本文は追記のたびに書き換わって
  // 再描画されるので、同じ器に入れると打ちかけの文字も focus も消える
  const appendBox = new AppendBoxRenderer(regions.append);
  /**
   * 🔴 **ここで初めて繋がる**(#671)── 窓の幅がスマホ⇄パソコンを跨いだときに
   *   呼ばれる。⚠ `state` は動いていないので、面の側が**幅を自分で読み直す**
   *   (`dual-filer.ts` の `paintSwitch` が `appPhone` に聞く)。
   */
  repaintOnLayout = () => center.render(dispatcher.getState());
  dispatcher.onState((state) => {
    browse.render(state, browseMode);
    center.render(state);
    appendBox.render(state);
    inspector.render(state);
    markView(state.viewMode);
    /**
     * 🔴 **スマホ用画面のページを決める**(#632 段①)。⚠ 描く順は**最後** ──
     *   面の中身が揃ってから `visibility` を切り替える(先に切り替えると、
     *   1 フレームだけ空の面が見える)。
     */
    appPhone.render({
      selectedLid: state.selectedLid,
      viewMode: state.viewMode,
      // 🔴 打っている物が見えない状態を作らない(`features/phone-layout.ts` の docstring)
      editing: state.phase === 'editing',
      title: state.selectedLid === null ? '' : (state.entryMetas.get(state.selectedLid)?.title ?? ''),
    });
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
  /**
   * #177: 本体タブ経由(follower)で開いているときの常設バッジ。fallback 警告と
   * 同型(「意図と違う接続形態は user が知るべき事実」)。昇格で空にする。
   *
   * 🔴 **アプリの窓では出さない**(#300 段④、2026-08-22。動線レビュー §10)。
   * ⚠ 理由は「情報を減らしたい」ではなく、**この帯の存在理由が成り立たない**こと:
   *   #177 が常設にしたのは「**意図と違う**接続形態は user が知るべき事実」だから
   *   だが、アプリの窓は **user が自分で開いた 2 枚目**である ── 意図どおりで、
   *   しかも user がそこで**できることは何も無い**。
   * ⚠ そして**実害がある** ── 状態の行は **1 行**なので、常設の帯が
   *   「別の窓の変更と重なりました…」(#178)のような**本当に読ませたい文**を
   *   横へ押し出す。⚠ ふつうの 2 枚目のタブでは今までどおり出す。
   * 🔑 判定は `heldViewWindow`(ディープリンクを握っている間だけ真)を読む ──
   *   新しい旗を作らない(CLAUDE.md §7)。
   */
  let syncLine = followerConn ? '複数タブ: このタブの保存は本体タブ経由です' : '';
  // textContent の setter は同一文字列でも子ノードを全置換する ── 打鍵ごとの
  // state 変化で無駄な DOM 変異を起こさないよう、変わったときだけ書く
  let statusShown = statusBase;
  regions.statusText.textContent = statusBase;
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
  /** ⚠ 同じ知らせで何度も塗り直さない(state は毎回流れてくる)。 */
  let noticeShown: string | null = null;
  const paint = () => {
    // ⚠ アプリの窓では常設バッジを畳む(上の理由)── `paint` は面が変わるたび
    //    走るので、`onHold` が旗を倒した次の描画から消える。
    // 🔴 **付箋の窓も同じ**(#685 着地前レビュー 🔴1)── 上の理由 3 つが
    //    そのまま当てはまる(user が自分で開いた 2 枚目 / できることは無い /
    //    状態の行 1 行を占めて「別の窓の変更と重なりました」を押し出す)
    const sync = heldViewWindow === null && !heldNoteWindow ? syncLine : '';
    /**
     * 🔴 **可搬単一 HTML の保存の状態**(#400 段③)。⚠ ふだんは空文字なので
     *   場所を取らない ── 出るのは「長く書けていない」か「書けなかった」ときだけ。
     */
    const parts = [statusBase, sync, portableAssetNote, persistState, noticeLine, errorLine]
      .filter((t) => t !== '');
    const text = parts.join(' — ');
    /**
     * 🔴 **断り書きが出ている間は、字が空でも器を畳まない**(#671 の裁定 3)。
     * ⚠ 畳むと **`OK` ごと画面から消える** ── 押す口が無いまま出しっぱなしに
     *   なるのと同じで、user は消し方を持たない。
     * 🔑 器を畳むかどうかを決めるのは**この 1 か所**である ──
     *   `too-narrow.ts` は自分の `hidden` だけ触り、ここへ知らせる(§7)。
     */
    const keep = !regions.tooNarrow.hidden;
    if (text === statusShown && regions.status.hidden === (text === '' && !keep)) return;
    statusShown = text;
    regions.statusText.textContent = text;
    regions.status.hidden = text === '' && !keep;
  };
  /** 🔑 ここで初めて `paint` に繋がる(それまでの `onState` は落としてよい)。 */
  repaintStatus = paint;

  /**
   * 🔴 **窓の題名を塗る**(#300 段③ / #685 着地前レビュー ⚠3)。
   *
   * ⚠ **タスクバーで見分けるため**に在る ── 付箋は「何枚でも開けます」が売りなので、
   *   この欠陥は**枚数に比例して効く**(3 枚並べると「PKC3」が 3 つ並ぶ)。
   * 🔑 **面と付箋を 1 つの口で塗る** ── 直す前は `onHold` の中で `document.title` を
   *   直に書いていたので、`onHold` を通らない付箋には**永久に届かなかった**。
   * ⚠ 付箋の題名は**旗ではなく、いま開いているノート**で決まる ── だから
   *   `onState` でも塗る(改名しても、別のノートへ移っても追う)。
   * ⚠ 形(`题名 — PKC3`)は `deep-link.ts` の `windowTitleFor` が正本である。
   */
  let titleShown = document.title;
  const paintTitle = (): void => {
    const st = dispatcher.getState();
    const label =
      heldViewWindow !== null
        ? viewModeLabel(heldViewWindow)
        : !heldNoteWindow || st.selectedLid === null
          ? null
          : (st.entryMetas.get(st.selectedLid)?.title ?? null);
    const next = windowTitleFor(CONTAINER_TITLE, label);
    // ⚠ 同じ字を書かない(`document.title` の代入はタスクバーを触る)
    if (next === titleShown) return;
    titleShown = next;
    document.title = next;
  };
  /**
   * 🔴 **この窓が出している付箋を、他の窓へ伝える**(#685、user 裁定 2026-09-04)。
   * ⚠ 押した瞬間に**同期で**答えられるように、台帳は先に配っておく ──
   *   押してから聞くと `window.open` が gesture の外へ落ちて遮断される。
   */
  const announceNote = (): void =>
    noteRegistry.announce(heldNoteWindow ? dispatcher.getState().selectedLid : null);
  dispatcher.onState(() => {
    paintTitle();
    announceNote();
  });
  /**
   * ⚠ 起動のときに添付が読めなかったことは、**黙らせない**(#400 段④)。
   * 🔑 保存の状態(`persistState`)とは**別の欄**にする ── 同じ変数に載せると、
   *   次の保存で「画像が出ない理由」が画面から消える。
   */
  if (syncLine !== '' || persistState !== '' || portableAssetNote !== '') paint();
  /**
   * 🔴 **知らせの隣の「開く」**(#668 A)── 判断は `status-open.ts`(test が届く所)。
   * ⚠ `showStatus` からも撃つ ── 字だけの知らせ(コピーした等)が上書きしたら、
   *   前の知らせに添えた「開く」は**その瞬間に**消えなければならない。
   */
  const paintOpen = (): void => {
    paintStatusOpen(regions.statusOpen, dispatcher.getState(), noticeLine);
    // 🔴 塊を動かした直後の「元に戻す」も同じ口で出し入れする(#684 段①)
    paintStatusUndo(regions.statusUndo, dispatcher.getState(), noticeLine);
  };
  /** 一時の知らせ(コピーした / 取り込んだ)。⚠ 状態変化では消えない。 */
  const showStatus = (text: string) => {
    noticeLine = text;
    paint();
    paintOpen();
  };
  /**
   * 🔴 **左の列の欄へ焦点を入れる**(#680)── 探す面の別窓が塞がれたときの退避先。
   * 🔑 `Ctrl+F` と**同じ 1 本**(`runGlobalCommand('focus-search')`)を通す ── 畳んだ列を
   *   戻してから焦点を入れる作法をここへ書き写さない(§7)。返り値は「入れられたか」。
   */
  const focusSearch = (): boolean =>
    runGlobalCommand('focus-search', root, dispatcher, appKeymap, () => {}, showStatus);

  /**
   * 🔴 **幅が足りなくて畳んだら、帯で言う**(#551 / #606)。⚠ 起動時ではなく**ここ**で
   *   配る ── `installColumnFit` を呼ぶ時点では `showStatus` がまだ無い。
   * 🔑 **口は 1 つだけ**(`fold-notify.ts`)── 段組みも**横に並べた枠**もここを通る。
   *   ⚠ #606 まで枠は**別の口**(`CenterRouter` の引数)を要求していて、ここが
   *   渡していなかったので**製品では 1 度も出ていなかった**。
   *   ⚠ この 1 行を落とすと**両方の帯が同時に消える**ので、
   *   `tests/smoke/read-columns.smoke.spec.ts` が鳴る(実測)。
   * ⚠ **別名を作らない**(2 巡目レビュー R-1)── `setColumnFoldNotify` という
   *   委譲用の名前を残したら、台がそこを迂回して**欠陥の再導入を素通り**させた。
   */
  setFoldNotify(showStatus);

  /**
   * 🔴 **狭すぎる端末への断り書き**(user 裁定 2026-09-04、#671 の裁定 2・3)。
   * ⚠ **`setFoldNotify` の後で配る** ── 器を畳むかどうかは `paint` が決めるので、
   *   `repaintStatus` が `paint` に繋がった後でなければ、出しても畳んだままになる。
   */
  installTooNarrow({
    band: regions.tooNarrow,
    text: regions.tooNarrowText,
    ok: regions.tooNarrowOk,
    onChange: () => repaintStatus(),
    // 🔴 小窓 / アプリの窓なら「ウィンドウを広げると直ります」(#690 ③)── 判断は
    //    `deep-link.ts` の `noteOpenedByUs`(`bootstrap` が `startApp` より先に決める)
    popup: () => openedByUs,
  });

  /**
   * 🔴 **外からの依頼を受ける口**(#189 / C-4 と #194 / C-3)。
   *
   * 門は 2 つあり、**開き方が違う**:
   *
   * | 門 | 誰から | いつ | 何ができるか |
   * |---|---|---|---|
   * | 許可リスト(C-4) | user が名指しで許した origin | flag `transport.embed` が立っている間ずっと | `hello` / `ping` / `createEntry` |
   * | 取り込みの合図(C-3) | **この窓を開いた相手** | `#pkc?capture=1` で開かれた**その起動の 60 秒**、**1 通だけ** | `createEntry` だけ |
   *
   * 🔑 判断は `startEmbedBridge()` / `startCapture()` に在る(ここは呼ぶだけ)──
   * この file は原文を読む test しか無いので、条件をここに書くと取り違えが緑のまま通る。
   */
  const capture = appFlags.isOn(FLAG_CAPTURE.name)
    ? startCapture({
        // 🔑 **アドレスを読むのは `deep-link.ts` だけ**(`tests/features/flags.test.ts` の
        //    全数検査 ── ここで `location.hash` を読むと「クエリの抜け穴」に数えられる)。
        hash: windowDeepLinkTarget().hash,
        opener: typeof window === 'object' ? window.opener : null,
      })
    : null;
  startEmbedBridge({
    // ⚠ **合図で来たときは flag に依らず張る** ── flag は「iframe の親から受けるか」
    //    の切替であって、user が自分でブックマークを押した動線とは別物である。
    enabled: appFlags.isOn(FLAG_EMBED.name) || capture !== null,
    origins: () =>
      // 🔑 **flag が下りていれば許可リストは空**(= 全部拒否)── 合図の門だけ開く
      appFlags.isOn(FLAG_EMBED.name) ? new EmbedOriginsStore().list() : [],
    ...(capture === null ? {} : { capture }),
    /**
     * 🔴 **外から増えたことを、黙って起こさない**(段②)。
     * ⚠ 一覧に 1 件増えるだけだと、user は「自分が作ったか」が分からない ──
     * どこから来たかまで帯に出す。
     */
    createEntry: (input, origin, via) => {
      const lid = generateLid();
      /**
       * 🔴 **見せ方を門で変える**(#194)。
       *
       * ⚠ 許可リストの相手(`'origin'`)は **user が作業している最中**に送ってくる ──
       * `edit: false` で、**いまの作業を退かさない**(#300 で user が叱った型)。
       * 🔑 合図の相手(`'capture'`)は違う ── その窓は**たったいま取り込みのために
       * 開かれた**ので、退かす作業が無い。しかも送り主の身元は確かめていないので、
       * **黙って積まずに目の前へ出す**(見て、要らなければ捨てられる)。
       */
      dispatcher.dispatch({
        type: 'CREATE_ENTRY',
        archetype: 'text',
        lid,
        title: input.title,
        body: input.body,
        edit: via === 'capture',
        parentLid: null,
        relationId: generateLid(),
      });
      showStatus(
        via === 'capture'
          ? `${origin} から取り込みました。保存すると残ります:${input.title}`
          : `${origin} から 1 件取り込みました:${input.title}`,
      );
      return lid;
    },
  });
  /**
   * 🔗 組み込みタイルから Office を開く(#148 / #174)。
   * ⚠ 既存窓への focus-request は user から**無反応に見える**(レポート #11 ──
   *   noopener の別窓は最前面に来たか分からない)。一言を出す。
   */
  const openOfficeTile = () => {
    /**
     * 🔴 **控えてある手元のファイルが在れば、それを開く**(#432)。
     *
     * ⚠ OS からの起動(`launchQueue`)は user の操作ではないので、そこから窓を
     *   開くと**ポップアップ遮断で消える**。⚠ 確認ダイアログを挟んでも駄目である
     *   (`<dialog>` の `close` は別の回で起きる)。
     * 🔑 **ここは user が押した中**なので遮断されない ── だから「受け取ったら
     *   控える / 押されたら渡す」の 2 段にしてある。
     * ⚠ **`take()` は 1 度きり** ── 2 度目に同じファイルが開かないようにする。
     */
    const staged = localOffice.take();
    if (staged !== null) {
      const r = officeWindow.open({ name: staged.name, expectDocument: true });
      officeWindow.provideDocument(staged.name, staged.bytes, staged.token);
      showStatus(
        r.kind === 'already-open'
          ? `${staged.name} を開いています(Office のタブをご覧ください)`
          : localOpenNotice(staged.name),
      );
      return;
    }
    const r = officeWindow.open({});
    if (r.kind === 'already-open')
      showStatus('Office は既に開いています(そのタブをご覧ください)');
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
    /**
     * 🔴 **state から来る一時の知らせ**(#402 ①)。
     * ⚠ effect の中(一括タグ)は `showStatus` を持たないので、state を通す ──
     *   ⚠ **`showStatus` と同じ行に載せる**(2 本目の行を作ると、優先順位の
     *   規則がここで割れる)。
     */
    if (state.notice !== null && state.notice !== noticeShown) {
      noticeShown = state.notice;
      showStatus(state.notice);
      return; // `showStatus` が `paint` を呼ぶ
    }
    paint();
    paintOpen(); // ⚠ 選択がその添付へ移ったら「開く」を畳む
  });

  /**
   * 🔴 多重タブの同期(#177)。
   * - 他タブの書込('changed')→ 一覧を取り直す。編集中は**黙って**先送り
   *   (deferNotice: null ── 実行は reload-snapshot が ready を待って持つ)。
   *   連打は 300ms で束ねる(snapshot は発火時に取り直すので取りこぼさない)
   * - 編集ロックの解放は **phase の遷移 1 か所**で束ねる ── editing を離れる経路は
   *   7 つある(app-state.ts の明記)ので、経路ごとに releaseEdit を書かない
   * - follower は lease が回ってきたら実 worker へ乗り換える(このタブが本体になる。
   *   reload しない ── 編集中の下書きをタブの中で生かしたまま)
   */
  let syncReloadQueued = false;
  const onRemoteChanged = (_cid: string, lids: string[] | null): void => {
    /**
     * 🔴 **編集中のタブにも、別の窓が書いたことを届ける**(#178、2026-08-22)。
     * ⚠ 一覧の取り直し(下)は編集中は先送りされるので、**これが無いと編集中の
     *   タブは最後まで気づかない**。判断は `remote-change.ts` に在る ──
     *   この file はどの test からも実行されない(CLAUDE.md §2)。
     */
    void noteRemoteChange(lids, {
      editingLid: () => {
        const st = dispatcher.getState();
        return st.phase === 'editing' ? (st.openBody?.lid ?? null) : null;
      },
      getBody: async (lid) => (await client.request({ op: 'getBody', cid, lid })) ?? null,
      apply: (lid, body) => dispatcher.dispatch({ type: 'REMOTE_BODY_CHANGED', lid, body }),
    });
    if (syncReloadQueued) return;
    syncReloadQueued = true;
    setTimeout(() => {
      syncReloadQueued = false;
      void reloadSnapshot(dispatcher, cid, loadSnapshot, { deferNotice: null });
    }, 300);
  };
  let unbindChanged = sync.onChanged(onRemoteChanged);
  // 解放は遷移 1 か所で束ねる(実体と test は edit-lock-release.ts)
  bindEditLockRelease(dispatcher, () => sync, cid);
  if (followerConn) {
    const conn = followerConn;
    conn.onEditRevoked((_cid, lid) => {
      // ⚠ いま編集している当のノートのときだけ言う(そうでない剥奪は user に関係ない)
      const st = dispatcher.getState();
      if (!(st.phase === 'editing' && st.openBody?.lid === lid)) return;
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error:
          '本体タブの交代で、このノートの編集権を別のタブかウィンドウに取られました。' +
          'ここで保存すると相手の編集を上書きします ── 内容を控えてから編集を取り消してください',
      });
    });
    let promotedHost: StoreProxyHost | null = null;
    void lease.whenHeld.then(async () => {
      try {
        await conn.promote(async () => {
          const r = await initStorage(true, portable);
          // ⚠ 昇格でも arm する(忘れると、続きを書いたぶんが丸ごと保存されない)
          armPersist(r.client);
          const host = new StoreProxyHost({
            client: r.client,
            init: r.init,
            heldLocks: conn.heldEditLocks(),
            ...proxyDeps,
            ...persistHook,
          });
          promotedHost = host;
          // 🔑 promote はここが返した client を**以後の全要求 + バッファ吐き出し**に
          //    使う ── localClient()(mutation を放送する包み)を返すことで、
          //    乗り換え直後の書込も残りの follower へ届く
          return { client: host.localClient(), init: r.init };
        });
        if (promotedHost) {
          unbindChanged();
          sync = promotedHost;
          unbindChanged = sync.onChanged(onRemoteChanged);
          // 🔴 **このタブが本体になったことを控える**(2026-08-16、着地前レビュー R1)。
          //    ⚠ ここを落とすと、Office の保存を引き取る門(`isHolder`)が
          //    **閉じたまま**になり、昇格したタブでは保存が棚に溜まり続けて
          //    **アプリを開き直すまで届かない**。
          //    ⚠ 「呼ぶたびに読む」だけでは足りない、が正体である ── 読む値の側が
          //    変わらなかった(`followerConn` は boot 以外で代入されない)。
          //    🔑 `lease.state()` を直に見ないのは、**lock が granted になる瞬間と
          //    店(store)が使えるようになる瞬間がずれる**からである(`promote` の
          //    中で新しい worker を建てている)── 早すぎると書きに行って失敗する
          writerHolder = true;
        }
        syncLine = '';
        showStatus('このタブが本体になりました');
        paint();
      } catch (e) {
        // 🔴 帯の常設も嘘のまま残さない(レビュー H-2)── 「本体経由」はもう成立していない
        syncLine = '⚠ 本体への切り替えに失敗しました(保存できません ── タブを読み直してください)';
        paint();
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: `本体への切り替えに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    });
  }

  // 🔒 attach / import と purge の排他 gate(review F1)。実体と pin は asset-gate.ts
  const withAssetGate = createAssetGate(dispatcher);
  /**
   * 🔴 **他のタブが編集中か**(#253)。整理(未参照 GC)の門で使う。
   * ⚠ 3 値をそのまま文言へ落とす ── `unknown` を「編集中」と言わない。
   */
  const editingElsewhere = async (): Promise<{ ok: boolean; reason: string }> => {
    // ⚠ 判定と文言は `purgeBlockReason` の 1 か所(ここは配線だけ)
    const reason = purgeBlockReason(await sync.anyEditing());
    return reason === null ? { ok: true, reason: '' } : { ok: false, reason };
  };
  /**
   * 🔴 **書き出しは、飛んでいる書込が着地してから読む**(2026-08-17 実測)。
   *
   * effect 層の配線はこの下(描画の配線の後)なので、**参照だけ先に置く** ──
   * 購読の順番は動かさない。⚠ `null` で居るのは boot が終わるまでの間だけで、
   * 書き出しの導線はその間まだ画面に無い。
   */
  let storeEffects: StoreEffects | null = null;
  /**
   * 書出しの実行(P6d)。⚠ **asset gate の内側** ── 書出し中に添付が掃除されると
   * 「meta はあるが bytes が無い」を掴んで欠けた書出しができる。
   * 形式が増えても読み出し口は 1 つ(source)で共有する。
   */
  /**
   * 🔴 **拡張からの書き戻しを当てる**(#195 / C-5 段③)。
   *
   * ⚠ **判断は `ext-write-apply.ts` に在る** ── `main.ts` は
   *   **どの test からも実行されない**(原文を読む test しか無い)ので、
   *   ここに判断を書くと「全 test 緑のまま取り違える」形になる
   *   (CLAUDE.md §2「取り出せば test できる」)。ここは**繋ぐだけ**。
   */
  const applyExtWrite = (
    ops: readonly ExtWriteOp[],
  ): Promise<{ ok: true; wrote: number } | { ok: false; why: string }> =>
    applyExtWriteOps(ops, {
      // 🔑 chain に載せる(2 本目の待ち口を作らない)
      run: (job) => (storeEffects ? storeEffects.run(job) : job()),
      phase: () => dispatcher.getState().phase,
      metaOf: (lid) => dispatcher.getState().entryMetas.get(lid) ?? null,
      getBody: async (lid) => (await client.request({ op: 'getBody', cid, lid })) ?? null,
      write: (entry, expectHash) =>
        client.request({
          op: 'upsertEntry',
          cid,
          entry,
          // 🔴 別のアプリが書いた本文 ── 戻せる形にする
          checkpoint: true,
          keepLatest: REVISION_KEEP_LATEST,
          expectHash,
        }),
      refresh: () => reloadSnapshot(dispatcher, cid, loadSnapshot, { deferNotice: null }),
    });

  const runExport = (
    kind: ExportKind | { entryLid: string; as?: 'archive' | 'html' | 'docx' | 'pptx' | 'folder' },
  ): Promise<void> =>
    withAssetGate(async () => {
      const deps: ExportDeps = {
        source: {
          cid,
          // ⚠ 器を作るとき(`resolveContainer`)に刻んだ題名と**同じ文字列**を
          // 使う(別定数だとファイル名と DB の題名が食い違う ── review L-2)。
          // ⚠ ただし `containers.title` を**読むコードは 1 行も無い**
          // (2026-08-19 に確認)── いま守れているのは「同じ定数を使う」まで
          // であって、食い違いを鳴らす計器は無い
          title: CONTAINER_TITLE,
          listEntryMetas: () =>
            client.request({ op: 'listEntryMetas', cid }),
          // ⚠ 1 件だけの読み口(P6f)── 無いと 1 ノート書出しが全 body を舐める
          getBody: async (lid) =>
            (await client.request({ op: 'getBody', cid, lid })) ?? null,
          listBodies: (after, maxBytes) =>
            client.request({
              op: 'listBodies',
              cid,
              maxBytes,
              ...(after ? { after } : {}),
            }),
          listRelations: () => client.request({ op: 'listRelations', cid }),
          listAssetMetas: () => client.request({ op: 'listAssetMetas', cid }),
          getAssetBlob: (key) => blobs.get(cid, key),
          listRevisionLids: () =>
            client.request({ op: 'listRevisionLids', cid }),
          // ⚠ 鎖は**保存形のまま**取る(P6e)── `getRevision` で版ごとに
          // 全文へ復元すると、アーカイブが N×M に膨らみ kind が中身と食い違う
          getRevisionChain: (entryLid) =>
            client.request({ op: 'exportRevisionChain', cid, entryLid }),
        },
        download: downloadBlob,
        notify: (message) => showStatus(message),
        // ⚠ **注意の中身**を出す導線(review M1 で一度落ちた)。無いと user が
        // 見るのは「⚠ 注意 1 件」だけで、**どの添付が欠けたか**が消える ──
        // バックアップで一番知りたい情報がそこにある
        report: (notes) => showNotices(regions.notices, '書出し時の注意', notes),
        /**
         * 🔴 **保存の直後に押されても、保存した本文を書き出す**(2026-08-17 実測)。
         * 書込は effect 層の chain に直列化されるが、**読みはその外**なので、
         * 待たないと `getBody` が並んでいる書込を追い越す(実測 11/12 で古い本文)。
         */
        settle: async () => {
          await storeEffects?.settled();
        },
        /**
         * 🔴 **図とグラフは画面と同じ産出器で焼く**(#187 段②)。
         * ⚠ ここで別に描くと「レンダラが 2 本」── この機能が PKC2 で失敗した根に戻る。
         * ⚠ 配色は**画面と同じ** ── 「図を保存」(上の `exportDiagram`)と揃える。
         *   見えている図と、書き出した文書の図の色を違えない。
         * ⚠ 幅は**固定**(紙の本文幅なりの 720 CSS px)── 画面の幅で焼くと、
         *   窓の大きさで文書の中の図の大きさが変わる。
         */
        /**
         * 🔴 **図はベクタ(SVG)で起こす**(#238、user 指示 2026-08-17)。
         * ⚠ 画面の PNG キャッシュは使わない ── 書き出しはベクタ
         *   (不可侵指示 2026-08-03「SVG は書き出しのときだけ」)。
         * ⚠ **グラフは `null`** ── chart.js は canvas に描くのでベクタ源が無い
         *   (`chart-raster.ts` が「chart.js はベクタを吐かない」と明記している)。
         */
        renderFigureVector: async (kind, source) =>
          kind === 'chart' ? null : renderToSvg(source, readPalette()),
        renderFigure: async (kind, source) => {
          const diagram = kind === 'chart' ? CHART_KIND : MERMAID_KIND;
          const raster = await diagram.render({
            source,
            kind,
            theme: document.documentElement.getAttribute('data-pkc-theme') ?? 'light',
            palette: readPalette(),
            width: 720,
            // ⚠ 紙に載るので **2 倍**で焼く(画面の dpr に合わせない ── 同じ文書が
            //    端末ごとに違う解像度になる)
            dpr: 2,
          });
          return { blob: raster.png, cssWidth: raster.cssWidth };
        },
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
      if (typeof kind === 'object') {
        // ⚠ 1 ノートの出口は 4 つ ── バックアップ(取り込み直せる)/ **閲覧用 HTML** /
        //    Word / PowerPoint(後ろの 3 つは片道)
        if (kind.as === 'docx') await exportEntryDocx(dispatcher, deps, kind.entryLid);
        else if (kind.as === 'pptx') await exportEntryPptx(dispatcher, deps, kind.entryLid);
        // 🔴 **フォルダごと**(#399 ①)── 同じ `deps`・同じ形式(.pkc3.zip)を通る。
        //    ⚠ 別経路にすると「フォルダ書出しだけ壊れている」が起きる(P6f と同じ理由)
        else if (kind.as === 'folder') await exportFolder(dispatcher, deps, kind.entryLid);
        // 🔴 **相手に渡せる 1 枚**(#491)── 同じ `deps`・同じ絞り込み・同じ実行部を通る
        else if (kind.as === 'html') await exportEntry(dispatcher, deps, kind.entryLid, 'html');
        else await exportEntry(dispatcher, deps, kind.entryLid, 'archive');
      }
      else await exportArchive(dispatcher, deps, kind);
    });

  /**
   * 添付を展開するワーカーの口(P8 段⑮)。
   * ⚠ **1 つを使い回す** ── 取込のたびに作ると、アイドル kill の意味が消える。
   */
  const assets = new AssetClient();

  /**
   * 添付を取り込む口(P4a)。⚠ **2 か所から使う** ── user の「添付」ボタンと、
   * 🔴 **Office の窓からの保存**(#205)。同じ口を通さないと、片方だけ
   * `hashBlob` を渡し忘れて**メインでハッシュが回る**(実測 500/726ms)。
   */
  const attachDeps: AttachDeps = {
    putBlob: (key, blob) => blobs.put(cid, key, blob),
    // 🔴 預かった取込は門の中で(#724 ⑤)。断らず待つ側 ── file は既に選ばれている
    gate: (run) => withAssetGate.queued(run),
    putMeta: async (m) => {
      await client.request({
        op: 'putAssetMeta',
        cid,
        meta: { key: m.key, mime: m.mime, size: m.size, hash: m.hash },
      });
    },
    listMetas: () => client.request({ op: 'listAssetMetas', cid }),
    estimate: navigator.storage?.estimate ? () => navigator.storage.estimate() : undefined,
    // 🔴 ハッシュは**ワーカーで**取る(P8 段㉓)。渡さないと
    //    `blob.arrayBuffer()` が最大 64MB をメインの heap に載せる
    //    ── 実測 32MB でメインが 241ms 止まっていた
    hashBlob: async (blob) => (await assets.hash(blob)).hash,
    /**
     * 🔴 **大きな画像を縮める口**(#412)。⚠ 復号と再符号化はハッシュより重い ──
     *   同じワーカー(アイドルで kill される)へ出す。
     */
    shrinkImage: (blob, mime) => assets.shrink(blob, mime),
    /**
     * 🔴 **聞く口**(#412)。⚠ 写真は user のもので、縮めるのは**不可逆**である ──
     *   だから**必ず聞く**。⚠ この口を渡さなければ縮まらない(黙って縮める道が無い)。
     */
    askShrink: async (question) =>
      (await confirmInApp(root, question, { okLabel: '縮める', cancelLabel: 'そのまま' })) === 'ok',
  };

  /**
   * 🔴 **Office の窓で保存されたものを引き取る**(#205)。⚠ ここは**道具を渡すだけ** ──
   * 判断(holder か / 編集中か / 新規か差し替えか)は `office-save-back.ts` が持つ。
   */
  const officeSaveBack = createOfficeSaveBack({
    stage: () => openStageDir(),
    // ⚠ **呼ぶたびに読む** ── 昇格でこのタブが本体になることがある(#177)
    isHolder: () => writerHolder,
    canWrite: () => dispatcher.getState().phase === 'ready',
    // 🔴 #432 段②: 手元のファイルから開いた回は、元のファイルへ戻す
    //    ⚠ 判断(合言葉が手元のものか / 書けたか)は `local-office-files.ts` が持つ
    writeLocal: (token, bytes) =>
      localOffice.nameOf(token) === null
        ? Promise.resolve(null)
        : localOffice.writeBack(token, bytes),
    readAttachment: async (lid) => {
      const meta = dispatcher.getState().entryMetas.get(lid);
      if (meta?.archetype !== 'attachment') return null;
      const body = (await client.request({ op: 'getBody', cid, lid })) ?? null;
      if (body === null) return null;
      const key = readAttachmentMeta(body).assetKey;
      return key === null ? null : { assetKey: key };
    },
    createNote: async (save, bytes) => {
      let lid: string | null = null;
      // ⚠ **断る側の gate を使わない**(`launchQueue` と同型 ── 選び直せない)
      await withAssetGate.queued(async () => {
        const attached = await attachOne(dispatcher, attachDeps, {
          name: save.name,
          // ⚠ 窓から戻る bytes に MIME は無い ── **名前の拡張子から引く**
          //    (`EXT_MIME` に Office 10 種を足したのはこのため)
          type: '',
          size: bytes.byteLength,
          // ⚠ **Blob へ写すのはここだけ。** OPFS の `File` をそのまま IDB へ入れると、
          //    棚を消した瞬間に中身が読めなくなる(実測 `ERR_SOURCE_DIED_IN_TRANSIT`)
          blob: new Blob([bytes]),
        });
        lid = attached?.lid ?? null;
      });
      return lid;
    },
    replaceAsset: async (lid, save, bytes) => {
      if (dispatcher.getState().phase !== 'ready') return false;
      let ok = false;
      await withAssetGate.queued(async () => {
        const mime = resolveMime(save.name, '');
        const blob = new Blob([bytes]);
        const { key, hash } = assetKeyFromHash((await assets.hash(blob)).hash);
        await blobs.put(cid, key, blob);
        await client.request({
          op: 'putAssetMeta',
          cid,
          meta: { key, mime, size: bytes.byteLength, hash },
        });
        dispatcher.dispatch({
          type: 'OFFICE_ASSET_SAVED',
          lid,
          newKey: key,
          newHash: hash,
          newBytes: bytes.byteLength,
          /**
           * 🔴 **綴りと中身の種類も運ぶ**(#214)。⚠ 直す前は `mime` を
           * 資産の meta(`putAssetMeta`)にだけ書いて、**frontmatter へは
           * 運んでいなかった** ── `.odt` を `.docx` で上書き保存すると
           * 「Office で開く」が古い綴りのまま LO へ渡していた。
           */
          newName: save.name,
          newMime: mime,
          savedAt: new Date().toISOString(),
        });
        // ⚠ reducer は**門を 2 つ**持っている(`ready` か / いまも添付か)── 撃てたかを
        //    ここで確かめる。確かめないと棚から消えて文書が失われる。
        //    ⚠ 2026-08-16 の着地前レビュー R6: `phase` だけ見ていたので、
        //    引き取りの途中でノートが消える / archetype が変わると、
        //    **何も書かずに「取り込みました」と言って棚を空にして**いた
        const after = dispatcher.getState();
        ok = after.phase === 'ready' && after.entryMetas.get(lid)?.archetype === 'attachment';
      });
      return ok;
    },
    // 🔴 **作ったノートを窓へ教える**(#217)── 教えないと 2 回目の保存で
    //    ノートが増える。判断は `office-save-back.ts`、ここは運ぶだけ
    adopt: (key, lid) => { officeWindow.adoptSave(key, lid); },
    notify: showStatus,
    fail: (error) => dispatcher.dispatch({ type: 'OP_FAILED', error }),
  });
  officeWindow.onEvent((ev) => {
    if (ev.type === 'saved') void officeSaveBack.receive(ev.key);
    else if (ev.type === 'save-failed') officeSaveBack.reportWindowFailure(ev.reason);
    else if (ev.type === 'closed') void officeSaveBack.drainAll();
    else if (ev.type === 'degraded') {
      // 🔴 **窓は生きて見えるが保存が効かない**(#117)。⚠ 2026-08-16 まで、この
      //    放送は受け側の `parseEvent` に case が無く**黙って捨てられていた**
      showStatus('Office が不安定になりました。保存が効きません ── ウィンドウを読み込み直してください');
    }
  });
  /**
   * 🔴 **編集が終わったら、保留していた保存を撃ち直す**(#205)。
   *
   * ⚠ `CREATE_ENTRY` も `OFFICE_ASSET_SAVED` も reducer が `phase !== 'ready'` を
   * **黙って捨てる** ── だから編集中に届いた保存は棚に残してある。ここで拾わないと
   * 次の起動まで出て来ない。⚠ `retryDeferred` は**保留が無ければ即戻る**ので、
   * 編集を終えるたびに棚を舐めることにはならない。
   */
  let wasReady = false;
  dispatcher.onState((state) => {
    const ready = state.phase === 'ready';
    if (ready && !wasReady) void officeSaveBack.retryDeferred().catch(() => 0);
    wasReady = ready;
  });

  /**
   * 🔴 **開いている拡張の窓を state へ写す**(#195 / C-5 段②-b)。
   *
   * ⚠ 台帳(`extension-links.ts`)が正本で、state はその**写し**である ──
   *   ここで足し引きを計算しない(2 か所で数えない、§7)。
   * 🔑 「いつ変わったか」は台帳が知らせる ── ここは**渡すだけ**にしてある
   *   (`main.ts` は原文 pin の test しか無い層なので、判断を置かない)。
   */
  appExtLinks.subscribe(() => {
    dispatcher.dispatch({ type: 'SET_OPEN_EXTENSIONS', open: appExtLinks.list() });
  });

  /**
   * 🔴 **取り込みの戻り道**(#535 ②)。⚠ 判断(何を憶え、何を出し、どう消すか)は
   *   `import-undo.ts` に在る ── この file はどの test からも実行されないので、
   *   ここに置くと取り違えが全 test 緑のまま通る(CLAUDE.md §2)。
   */
  const importUndo = createImportUndo({
    dispatch: (a) => dispatcher.dispatch(a),
    notify: (message) => showStatus(message),
    clear: () => clearNotices(regions.notices),
  });

  const importDeps: ImportDeps = {
      // ⚠ 生存 entry だけでは足りない ── ゴミ箱の lid(entries に居ないが
      // revisions を持つ)と衝突すると、その item がゴミ箱から消え、
      // 取り込んだ entry が他人の履歴を背負う(review H-1、実 sqlite で実証)
      /**
       * 🔴 **DB に問う。state は射影であって正本ではない**(#328、2026-08-22)。
       * 判定と理由は `features/import/existing-lids.ts` に在る ── ここは配線だけ。
       * ⚠ 直す前はこの場で `entryMetas` を読んでいたが、`main.ts` は**原文 pin の
       *   test しか無い層**なので、state が遅れたら上書きになる性質を誰も見て
       *   いなかった(CLAUDE.md「どの test からも実行されない file に判断を書かない」)。
       */
      existingLids: () =>
        collectExistingLids({
          fromState: () => dispatcher.getState().entryMetas.keys(),
          entryLids: async () =>
            (await client.request({ op: 'listEntryMetas', cid })).map((m) => m.lid),
          revisionLids: () => client.request({ op: 'listRevisionLids', cid }),
        }),
      /**
       * 🔴 **重なりを数えるための頭**(#399 ②)。⚠ 本文は入れない ──
       *   常駐の集約が既に持っている値なので**ただで使える**。
       */
      existingHeads: () =>
        [...dispatcher.getState().entryMetas.values()].map((m) => ({
          lid: m.lid,
          bodyChars: m.bodyChars,
        })),
      /** 🔴 絞った lid の本文だけ読む(#399 ②)。⚠ 全件は読まない。 */
      readBodies: async (lids) =>
        new Map(
          (await client.request({ op: 'getBodies', cid, lids: [...lids] })).map(
            (r) => [r.lid, r.body] as const,
          ),
        ),
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
        await client.request({ op: 'bulkUpsertEntries', cid, entries });
      },
      bulkUpsertRelations: async (relations) => {
        await client.request({
          op: 'bulkUpsertRelations',
          cid,
          relations,
        });
      },
      importRevisionChains: (chains) =>
        client.request({ op: 'importRevisionChains', cid, chains }),
      // ⚠ `keepLatest` を**明示で渡す**(review L-2)── 省くと worker の
      // 既定値が使われ、アプリ側の設定と偶然一致しているだけになる。
      // 片方を変えた瞬間に自分のバックアップが黙って削れる
      restoreRevisionChains: (chains) =>
        client.request({
          op: 'restoreRevisionChains',
          cid,
          chains,
          keepLatest: REVISION_KEEP_LATEST,
        }),
      // ⚠ **bytes 側の台帳を見る**(review H-1)── meta 行の有無で判定すると、
      // GC が deleteBlob → deleteMeta の途中で失敗した状態(設計上の想定内)で
      // put を省いてしまい、参照だけが書かれる
      listStoredBlobKeys: async () => new Set(await blobs.listKeys(cid)),
      putBlob: (key, blob) => blobs.put(cid, key, blob),
      putAssetMeta: async (m) => {
        await client.request({ op: 'putAssetMeta', cid, meta: m });
      },
      // 🔑 中身は `reload-snapshot.ts`(段㉕ で切り出し ── closure に居ると
      //    誰も test できず、「案内は出すが実行しない」嘘が残っていた)
      reload: () => reloadSnapshot(dispatcher, cid, loadSnapshot),
      notify: (message) => showStatus(message),
      // 注意は**全件**を専用面へ(1 行の status では 1 件目しか届かない)
      // 🔴 **戻り道も同じ面に出す**(#535 ②)── 題と操作を決めるのは `import-undo.ts`
      report: (notes) => {
        const panel = importPanel(notes, importUndo.pending());
        showNotices(regions.notices, panel.title, notes, panel.action);
      },
      // 🔴 **取り込んだ id を憶える**(#535 ②)── 戻せるのは直前の 1 回だけ
      imported: (lids) => importUndo.remember(lids),
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
              // ⚠ **上書きしているので、記憶も自分で呼ぶ**(#535 ②)──
              //    ここを忘れると「OS から開いた md だけ戻せない」が静かに残る
              importUndo.remember(lids);
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
    // 🔴 danger ── 下書きは AppState にしか無く beforeunload も無いので本当に戻せない。
    //    「戻しにくい操作は危険色」の規則(docs-parity の DANGER_SITES)に照らして
    //    付いていないほうが誤りだった(#312 の最初の仕事②)
    isEditing: () => dispatcher.getState().phase === 'editing',
    confirmDiscard: () =>
      ask('編集中の内容は保存されません。新しい版に切り替えますか?', {
        okLabel: '切り替える',
        danger: true,
      }),
  });

  /**
   * 🔴 **素のまま起動を許した添付**(P10 → #301 で永続化。user 裁定 2026-08-21)。
   *
   * > 「**同じハッシュのアプリ登録済みの URL もしくは HTML に関しては永続化
   * > (文字通りの永続化、期間とかない)**」
   *
   * 憶え方は **2 通り**あり、**アプリとして登録してあるかどうか**で分かれる:
   *
   * | | 憶える鍵 | どこに | いつまで |
   * |---|---|---|---|
   * | 登録済み | **中身のハッシュ**(`ast-<sha256>`) | localStorage | **ずっと**(中身が変わるまで) |
   * | 登録していない | lid | この closure | **この画面を開いている間だけ** |
   *
   * ⚠ **登録していない添付の記憶を lid のままにしてあるのは意図的**である ──
   *   closure は読み込み直せば消えるので、「lid を保ったまま中身が入れ替わる」
   *   (本文編集 / 履歴復元 / ゴミ箱復元)より寿命が短い。永続化する側は
   *   その保証が無いので、**鍵をハッシュにしないと成り立たない**(→ `same-origin-grants.ts`)。
   * ⚠ こちらの closure への参照経路はアプリ側に無い(`opener` は切り、`parent` は外殻で止まる)。
   *   一方 localStorage の側は**アプリが書き換えられる** ── その判断の根拠は
   *   `same-origin-grants.ts` の冒頭に書いてある。
   */
  const sameOriginGate = new SameOriginGate();

  /**
   * 🔴 **録音・画面収録**(#413)。段取りは `capture.ts` が持ち、ここは口を渡すだけ。
   *
   * ⚠ 取り込みは **`queued`**(断る側ではない)── 収録は**取り直せない**ので、
   *   整理(未参照 GC)と重なったら**待たせる**(Office の保存と同じ判断)。
   */
  const captureService = createCaptureService({
    dispatcher,
    attach: async (item) => {
      let out: Awaited<ReturnType<typeof attachOne>> = null;
      await withAssetGate.queued(async () => {
        out = await attachOne(dispatcher, attachDeps, item);
      });
      return out;
    },
    onChange: (line) => paintCaptureBar(root, line),
    notify: showStatus,
  });

  /**
   * 🔴 **タイマー**(#279)。段取りは `timer.ts` が持ち、ここは口を渡すだけ。
   * ⚠ 帯は**走っている間だけ**描き直される(`timer.ts` が刻みを張り外しする)──
   *   ここで `setInterval` を張らない(常駐を作らない ── 不可侵指示 2026-08-03)。
   */
  const timerService = createTimerService({
    dispatcher,
    onChange: (runs) => paintTimerBar(root, runs, Date.now()),
    notify: showStatus,
  });

  /**
   * 🔴 **アラート**(#280)。段取りは `alarm.ts` が持ち、ここは口を渡すだけ。
   *
   * ⚠ **設定が入のときだけ、起動時に予定を数える** ── 予定の札は
   *   「予定」の面を開いた user にしか集まらない(`app-state.ts` の方針)。
   *   その全走査を、知らせを使わない user に負わせない。
   * ⚠ 見張り自体は常に張る(刻みの中で設定を毎回引く)── 設定を入にした
   *   その場から効かせるため。数えるのは `REFRESH_TASK_SCAN` の側である。
   */
  const alarmChime = createChime();
  const alarmService = createAlarmService({
    dispatcher,
    onChange: (due) => paintAlarmBar(root, due),
    chime: alarmChime,
    enabled: () => appAlarmEnabled.enabled(),
  });
  alarmService.start();
  if (appAlarmEnabled.enabled()) dispatcher.dispatch({ type: 'REFRESH_TASK_SCAN' });

  const services: BinderServices = {
    attachFiles: (files, why) =>
      void withAssetGate(() => attachFiles(dispatcher, attachDeps, files, why)),
    // 🔴 録音・画面収録(#413)── 押す口は左の列の「添付」の隣に在る
    startCapture: (kind) => void captureService.start(kind),
    stopCapture: () => captureService.stop(),
    discardCapture: () => captureService.discard(),
    // 🔴 タイマー(#279)── 押す口は左の列の「画面」の隣に在る
    startTimer: () => timerService.start(),
    stopTimer: (lid) => timerService.stop(lid),
    discardTimer: (lid) => timerService.discard(lid),
    // 🔴 アラート(#280)── 鳴った知らせを片付ける
    dismissAlarm: (key) => alarmService.dismiss(key),
    /**
     * 🔴 **狭い画面の断り書きを出すか**(#687 E-1)── 帯の OK で切れた user の戻し道。
     * ⚠ 塗り直しは `installTooNarrow` が store を購読して受ける(ここで帯を触らない)。
     */
    setTooNarrowEnabled: (on) => appTooNarrowOk.setEnabled(on),
    /**
     * 🔴 **入にしたその場から効かせる**(#280)── 入にした user が
     *   「読み込み直すまで鳴らない」に気づく手段は無い。
     * ⚠ 切にしたら**鳴っている知らせも畳む** ── 切ったのに残っていると、
     *   「切れていない」と読まれる。
     */
    setAlarmEnabled: (on) => {
      appAlarmEnabled.setEnabled(on);
      if (!on) {
        alarmService.dismissAll();
        return;
      }
      dispatcher.dispatch({ type: 'REFRESH_TASK_SCAN' });
      /**
       * 🔴 **入にしたその場で 1 度鳴らす**(#280)。理由は 3 つとも user のためである:
       * ① **どんな音か分かる** ── 初めて鳴るのが本番だと、何の音か分からない
       * ② 🔴 **鳴らせるかがその場で分かる** ── ブラウザは「user が触っていない
       *    ページ」の音を止める。⚠ ここは**押した直後**なので必ず通り、
       *    以後の知らせも鳴るようになる(押さずに入れる道が無い形にしてある)
       * ③ **鳴らせなかったときに、そう言える**(下)
       */
      void alarmChime.play().then((rang) => {
        showStatus(
          rang
            ? '予定の時刻に、この音で知らせます(PKC を開いている間だけです)'
            : 'この端末では音を出せませんでした ── 時間になったら画面の下の帯でお知らせします',
        );
      });
    },
    // 🔑 一時の知らせ(「3 件を『はこ』へ入れました」)── **エラーの行とは別**
    showStatus,
    /**
     * 🔴 **何が容量を食っているか**(#415)── 数えるのは worker。
     * ⚠ 返るのは**数字だけ**(本文も bytes も境界を越えない)。
     * ⚠ 器が無い(cid が無い)ときは空を返す ── 押しても「調べています…」で止めない。
     */
    storageProfile: async () => {
      const cid = dispatcher.getState().cid;
      if (cid === null) return { rows: [], totalAssetBytes: 0, orphanBytes: 0 };
      return client.request({ op: 'storageProfile', cid });
    },
    /**
     * 🔴 **スクショの貼付**(#250。user 指示 2026-08-18
     * 「PKC3 でスクショ貼付の導線がない。PKC2 と同様以上に実装してください」)。
     *
     * ⚠ **base64 にしない。** PKC2 は貼付のたびに `fileToBase64` で文字列へ起こして
     * いたが、PKC3 の storage は **bytes を Blob のまま IDB へ置く**(不可侵指示
     * 2026-07-27「ゼロコピー」)── 起こすと heap に丸ごと載る。
     * ⚠ 名前は**貼った日時**から作る(クリップボードの画像に名前は無い)。
     * ⚠ 置けなかったものは**返さない** ── 呼び側で件数が合わなくなるので気づける。
     */
    pasteImages: async (files) => {
      const refs: string[] = [];
      // 🔴 **整理(未参照 GC)と排他にする。** ここは「bytes は在るが参照が無い」
      //   窓を**添付より長く**持つ(本文へ差すのは put のあと)── 窓の中で整理が
      //   走ると、貼ったばかりの bytes を未参照と判定して消す(`asset-gate.ts`)。
      // ⚠ 断る側の口を使う(待たせる `queued` は「選び直せない経路」用)──
      //   貼付はクリップボードが残っているので**もう一度貼れる**。
      await withAssetGate(async () => {
        const known = new Set((await attachDeps.listMetas().catch(() => [])).map((m) => m.key));
        for (const file of files) {
          const name = pastedImageName(file, new Date());
          try {
            const stored = await storeAsset(
              attachDeps,
              { name, type: file.type, size: file.size, blob: file },
              known,
            );
            refs.push(formatAssetRef(name, `asset:${stored.assetKey}`, true));
          } catch (e) {
            dispatcher.dispatch({ type: 'OP_FAILED', error: (e as Error).message });
          }
        }
      });
      return refs;
    },
    /**
     * 🔴 **本文の画像を資産にする**(#251 の B + C = 貼付の `data:` / `blob:` /
     * #264 段① = 押して取り込む外部の `https:`)。
     *
     * ⚠ **`blob:` は貼った瞬間しか読めない**(document を閉じれば死ぬ)ので、
     *   ここで bytes を握るのが唯一の機会である。⚠ `data:` は読めるが、本文に
     *   base64 を居座らせると編集・保存・描画のたびに丸ごと運ぶ(不可侵指示
     *   2026-08-03「効くのは定常」)。
     * ⚠ **画像だけ**受ける ── 読んでみるまで種類は分からないので、`fetch` の
     *   あとに判定する。⚠ 入らなかったものは**理由を添えて**返す(#264 段②)。
     * ⚠ 貼付と同じく**整理(未参照 GC)と排他**にする ── 本文へ差すのは put の
     *   あとなので、その窓で整理が走ると貼ったばかりの bytes を消される。
     * ⚠ 1 件ずつ順に処理して都度捨てる(並べると heap に載る)。
     */
    adoptUrls: (urls, namePrefix) =>
      adoptUrls(
        {
          gate: withAssetGate,
          attach: attachDeps,
          // ⚠ **`fetch` を直に渡さない**(#264 段②)── 404 は例外にならないので、
          //   そのままだと「画像ではありませんでした」に化けて**直しようが無くなる**
          fetchBlob: fetchImageBlob,
          now: () => new Date(),
        },
        urls,
        namePrefix,
      ),
    /**
     * 🔴 **添付を別の窓で見る**(#192 で画像、2026-08-15 に PDF)。⚠ 貸した ObjectURL は
     * `openAssetWindow` が**窓の生死に合わせて**捨てる(窓が開けなければ即捨てる)。
     */
    /**
     * 🔴 **貼る用に画像を持ち歩ける形へ**(#193)。`blob:` を読み直して `data:` にする。
     * ⚠ 同一 document の blob なので `fetch` で読める。⚠ 読めなかったものは
     *   **入れない**(呼び側が「落とした」と数えて user に言う)。
     * ⚠ 大きい画像を並べると heap に載るので、**1 枚ずつ順に**処理して都度捨てる。
     */
    inlineImages: async (urls) => {
      const out = new Map<string, string>();
      for (const url of urls) {
        try {
          const blob = await (await fetch(url)).blob();
          const data = await new Promise<string>((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result));
            fr.onerror = () => reject(fr.error ?? new Error('read failed'));
            fr.readAsDataURL(blob);
          });
          out.set(url, data);
        } catch {
          // 読めない 1 枚で全部を失わない ── その 1 枚だけ落ちる
        }
      }
      return out;
    },
    viewAsset: (assetKey, name, mime) => {
      void (async () => {
        try {
          // ⚠ 出せない種類は**借りる前に**断る(貸してから捨てる形にしない)
          const kind = assetWindowKind(mime);
          if (!kind) {
            dispatcher.dispatch({
              type: 'OP_FAILED',
              error: `この種類は別のウィンドウで開けません: ${name}`,
            });
            return;
          }
          const lent = await blobs.lendObjectUrl(cid, assetKey);
          if (!lent) {
            dispatcher.dispatch({ type: 'OP_FAILED', error: `添付が見つかりません: ${name}` });
            return;
          }
          const win = await openAssetWindow({
            lent,
            title: name,
            kind,
            // ⚠ 添付ごとに 1 枚(開き直しても窓が積み上がらない)
            windowName: `pkc3-asset-${assetKey}`,
          });
          if (!win) {
            // ⚠ popup を止められた ── **理由を言う**(押して無反応にしない)
            dispatcher.dispatch({
              type: 'OP_FAILED',
              error: '別のウィンドウを開けませんでした(ポップアップが止められています)',
            });
          }
        } catch (e) {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: `添付を開けませんでした(${name}): ${String(e)}`,
          });
        }
      })();
    },
    /**
     * 🔴 **画面に出ている絵を、別窓で実寸で見る**(#527。user 指示 2026-08-28
     * 「**別ウィンドウで実寸で開いて拡大縮小できるようにしてほしい**」)。
     * 図(mermaid)と**本文に貼った画像**の両方がここを通る。
     *
     * ⚠ **焼き直さない** ── 画面に出ている bytes をそのまま渡す
     *   (不可侵指示「SVG は書き出しのときだけ」)。
     * 🔴 **URL は貸し直す**(不可侵指示 2026-07-27「生成物は寿命終端で破棄」)──
     *   画面の `<img>` が握っている ObjectURL を**そのまま渡さない**。
     *   あちらは配色が変わった瞬間に revoke される(`mermaid-hydrate.ts`)ので、
     *   渡すと **別窓の絵が突然消える**。⚠ だから bytes を取り直して
     *   **別窓の寿命に紐づく URL** を作る(捨てるのは `openAssetWindow` が持つ)。
     * ⚠ `windowName` は**絵ごと**にしない ── 図に安定した id が無いので、
     *   1 枚に固定して**開き直しは同じ窓へ**出す(積み上がらない)。
     *   ⚠ 添付の窓(`viewAsset`)とは**別の名前**である ── 同じにすると、
     *   添付を見ながら図を開いたときに**添付の窓が図に置き換わる**。
     */
    viewBig: (src, title, diagram) => {
      void (async () => {
        try {
          /**
           * 🔴 **図は原文からベクタを起こす**(user 報告 2026-08-28
           * 「ラスタ化された方の画像が開くのは BAD / ぽしょぽしょの図になってしまった」)。
           *
           * ⚠ 画面の `<img>` は**本文の表示幅 × dpr** で焼いた PNG なので、
           *   拡大窓で開くと粗い ── とくに段に収めるため縮めた巨大な図ほど粗い。
           * 🔑 ベクタなら**どこまで拡大しても鮮明**で、焼き直しも要らない。
           * ⚠ **実寸を書き込んでから渡す**(`svgWithIntrinsicSize`)── mermaid の SVG は
           *   `<img>` が読む自然幅が 300px なので、そのままだと「実寸」が 300px になる。
           */
          /**
           * ⚠ **図と grafu で作り直し方が違う**(2026-08-29)。
           * 🔑 mermaid は SVG を吐くので**ベクタ**で開ける ── どこまで拡大しても鮮明。
           * 🔴 **chart.js はベクタを吐かない**(`chart-raster.ts` の `savable: false`)ので、
           *   ベクタにはできない ── 代わりに**大きく焼き直す**。画面の器の幅で焼いた
           *   PNG をそのまま拡大すると粗いが、実寸で焼き直せば拡大に耐える。
           */
          const bytes =
            diagram === undefined
              ? // ⚠ `blob:` の取り直しは同一 origin でしか通らない ── 通らなければ断る
                await (await fetch(src)).blob()
              : diagram.kind === 'mermaid'
                ? new Blob([svgWithIntrinsicSize(await renderToSvg(diagram.source, readPalette()))], {
                    type: 'image/svg+xml',
                  })
                : // 🔴 **grafu は大きく焼き直す** ── ベクタにできないので実寸で焼く。
                  //   ⚠ 既存の焼き経路(`CHART_KIND.render`)を使う ── ここで chart.js を
                  //   直に叩くと配色と鍵の作り方が 2 か所になる(CLAUDE.md §7)。
                  //   ⚠ dpr は 2 固定(紙の `renderFigure` と同じ理由 ── 端末ごとに
                  //   違う解像度の絵にしない)。
                  (
                    await CHART_KIND.render({
                      source: diagram.source,
                      kind: 'chart',
                      theme: document.documentElement.getAttribute('data-pkc-theme') ?? 'light',
                      palette: readPalette(),
                      width: 2048,
                      dpr: 2,
                    })
                  ).png;
          const url = URL.createObjectURL(bytes);
          const win = await openAssetWindow({
            lent: { url, dispose: () => URL.revokeObjectURL(url) },
            title,
            kind: 'image',
            // 🔴 実寸で出し、拡大縮小できるようにする(既定の `'contain'` は添付用)
            fit: 'natural',
            windowName: 'pkc3-view-big',
          });
          if (!win) {
            dispatcher.dispatch({
              type: 'OP_FAILED',
              error: '別のウィンドウを開けませんでした(ポップアップが止められています)',
            });
          }
        } catch (e) {
          dispatcher.dispatch({ type: 'OP_FAILED', error: `絵を開けませんでした: ${String(e)}` });
        }
      })();
    },
    /**
     * 🔴 **写す(コピー)のために本文をまとめて読む**(#273 段③)。
     * ⚠ **1 往復**で読む(`getBody` を N 回呼ぶと、フォルダを写すたびに N 往復になる)。
     * ⚠ 読めなかった lid は**入れない** ── 呼び側が件数で「落とした」と言える。
     */
    readBodies: async (lids: readonly string[]) =>
      new Map(
        (await client.request({ op: 'getBodies', cid, lids: [...lids] })).map(
          (r) => [r.lid, r.body] as const,
        ),
      ),
    /**
     * 🔴 **飛んでいる書込を待つ口**(#288)。書き出し(`settle`)と**同じ 1 本**を
     * 渡す ── 2 本目の待ち方を作らない(CLAUDE.md §7)。
     */
    settle: () => storeEffects?.settled() ?? null,
    /**
     * 🔴 **開いている拡張へ渡す**(#195 / C-5 段②-b)。⚠ ここは**渡すだけ** ──
     *   台帳も封筒も `extension-links.ts` / `ext-wire.ts` が持つ。
     */
    deliverToExtension: (linkId, entry) => appExtLinks.deliver(linkId, entry),
    downloadAsset: async (assetKey, name) => {
      try {
        const lent = await blobs.lendObjectUrl(cid, assetKey);
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
      void (async () => {
        const ok = await ask(
          `「${name}」を、いまのノートの内容で上書きします。\n\n` +
            'ファイルの元の内容は失われます(取り消せません)。よろしいですか?',
          { okLabel: '上書きする', danger: true },
        );
        if (!ok) return;
        const body = (await client.request({ op: 'getBody', cid, lid })) ?? null;
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
    // 🔴 直前の取込をごみ箱へ(#535 ②)── 記憶も件数も `import-undo.ts` が持つ
    undoImport: () => importUndo.undo(),
    /**
     * 🔴 **アプリの窓なら `× 閉じる` で窓ごと閉じる**(#300 段③ の直し)。
     * ⚠ 判断は `view-window.ts` ── ここは `window` を渡すだけである。
     */
    closeViewWindow: () =>
      closeViewWindow({
        holding: () => heldViewWindow !== null,
        close: () => window.close(),
        isClosed: () => window.closed,
      }),
    /**
     * 添付の参照をコピーする(P8 段⑱)。
     * ⚠ **結果を出す** ── コピーは押しても画面が変わらない操作なので、
     *    黙って終わると成功したのか分からない
     */
    copyText: (text, done) => {
      void copyPlainText(text).then((ok) => {
        /**
         * 🔴 **押した側から「何を写したか」を受け取る**(2026-08-29 の動線レビュー 欠陥 2)。
         * ⚠ 直す前は**どれを押しても**「参照をコピーしました」と出ていた ──
         *   本文を全部写す `copy-plain-markdown` でもそう出ており、**字が嘘**だった。
         * ⚠ 既定は**参照と言わない**汎用にする(渡し忘れても嘘にならない側へ倒す)。
         */
        showStatus(ok ? (done ?? 'コピーしました') : 'コピーできませんでした');
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
    /**
     * 🔴 **許可を外す出口**(#301)。⚠ 永続化そのものは user 裁定だが、
     *   「一度許したら二度と外せない」は裁定に含まれていない。
     * ⚠ **可視に知らせる**(無言の操作拒否・無言の成功を作らない)── 押した結果が
     *   見えないと、外れたのか押せていないのか区別が付かない。
     */
    revokeSameOrigin: (assetKey) => {
      sameOriginGate.revoke(assetKey);
      // ⚠ **自分で描き直す** ── 許可は state に持たない(この端末の判断であって
      //    ノートのデータではない)ので、`showStatus` の `paint()` では設定の面まで
      //    届かない。押しても一覧が消えず「効いていない」に見える(実際に踏んだ)。
      //    `setExternalImages` と同じ倒し方に揃える。
      center.render(dispatcher.getState());
      showStatus('素のまま起動の許可を取り消しました');
    },
    /**
     * 🔴 **目次を見せる許可を取り消す**(#195 / C-5 段①)。
     * ⚠ `revokeSameOrigin` と**同じ倒し方**にする ── 許可は state に持たないので、
     *   自分で描き直さないと一覧が消えず「効いていない」に見える。
     */
    revokeExtension: (assetKey) => {
      appExtensionGrants.revoke(assetKey);
      /**
       * 🔴 **詳細の指紋も崩す**(2026-08-25、許す側で踏んで、反対側も疑って直した)。
       * ⚠ 取り消しは設定の面から押すので、その場の描き直しは設定の一覧に効く ──
       *   ところが**詳細の面は `hidden` で常駐**しており、指紋(selectedLid /
       *   body / phase / revisionPanel)は取り消しで 1 つも動かない。
       *   だから戻ってきたとき「目次を見せて起動」が**出ないまま**になる
       *   (許可は外れているのに、押す口が消えている)。
       */
      center.invalidateDetail();
      center.render(dispatcher.getState());
      showStatus('目次を見せる許可を取り消しました');
    },
    /**
     * 🔴 **ヘルプの中の「マニュアルを別のウィンドウで開く」**(#645)。
     * ⚠ タイル(`builtin:manual`)と**同じ 1 本**へ落とす ── 2 通りに書くと、
     *   片方だけ直した日に「ヘルプからは開くがタイルからは開かない」になる(§7)。
     */
    openManualWindow: () => void openManualTile(dispatcher, markdown, showStatus),
    openTile: (lid) => {
      const tile = dispatcher.getState().launcherTiles?.find((t) => t.lid === lid);
      if (!tile) return;
      /**
       * 🔴 **タイルは許可を「使う」だけ。「与える」ことはしない**(#301。user 裁定 2026-08-21)。
       *
       * user 裁定は「アプリ登録済みのものは永続化(= 次から聞かれない)」であって、
       * 「タイルから許可を出せるようにする」ではない。⚠ **その差は大きい** ──
       * タイルは一覧から 1 クリックで押せる場所なので、ここを許可の入口にすると
       * 「押しただけで全ノートを渡すか聞かれる」形になる(`detail.ts` が
       * **対象の素性が見えている画面からだけ**入れる、と決めた理由)。
       * 🔑 だから: **与えるのは添付の画面で 1 回だけ。以後はタイルがそれを使う。**
       * ⚠ 許可が無ければ**今までどおり囲いの中**で開く(黙って素のままにはしない)。
       */
      const granted =
        tile.kind === 'app' &&
        sameOriginGate.allows({ lid, assetKey: tile.assetKey, registered: true });
      launchTile(tile, {
        readBlob: (assetKey) => blobs.get(cid, assetKey),
        open: (url, features) => window.open(url, '_blank', features),
        createUrl: (blob) => URL.createObjectURL(blob),
        revokeUrl: (url) => URL.revokeObjectURL(url),
        whenClosed: waitForWindowClose,
        // 🔑 このアプリが前回保存した中身(P8 段⑭)。**PKC3 と外殻は同じ origin**
        //    なので、ここで読んだものがそのまま外殻の localStorage の中身になる
        readSeed: readAppStorage,
        baseUrl: document.baseURI,
        fail: (error) => dispatcher.dispatch({ type: 'OP_FAILED', error }),
        // #148 組み込みタイル ── 文書なしで開く = Start Center(#174 の一言込み)
        openOffice: openOfficeTile,
        // 🔴 **組み込みタイルは別窓で開く**(#300 段③)。⚠ 判断と文言は
        //    `view-window.ts` に在る ── この file はどの test からも実行されない
        //    ので、配線だけ置く。⚠ 窓が塞がれたときの退避は `openInPane`(段⑤)。
        //    そちらは `open-view.ts` を通す(開いた後の後始末を落とさない)
        // ⚠ 2 ペインに**予定表が加わった**(#673 段②、user 裁定 2026-09-04)──
        //    何が来るかは `tiles.ts` の組み込みタイルが決める(`isViewMode(kind)`)。
        //    予定表の退避先は**左の列の「予定」タブ**(`openViewHere`)なので、
        //    タブを開く口(`services.setBrowse`)を渡す
        openView: (view) =>
          void openViewTile(dispatcher, cid, view, (m) => services.setBrowse?.(m), focusSearch),
        openManual: () => void openManualTile(dispatcher, markdown, showStatus),
        // ⚠ **聞かない。憶えているものを確かめるだけ**(上の granted と同じ判定を
        //    通す ── ここで別の式を書くと、片方だけ直した日に食い違う)
        confirmSameOrigin: async () => granted,
      }, { sameOrigin: granted });
      // ⚠ 押した対象を**選択状態にもする**(P8 段⑭)── 起動しただけだと右の列が
      //    空文のままで、いま何を触ったのかが画面に残らない。「押す = 起動」の
      //    意味は変えず、選択は同時に立つ副作用として入れる。
      // ⚠ 組み込みタイル(#148)は entry を持たないので立てない(tileSelectsEntry)
      if (tileSelectsEntry(tile)) dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
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
          (await client.request({ op: 'getBody', cid, lid })) ?? null;
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
            readBlob: (assetKey) => blobs.get(cid, assetKey),
            open: (url, features) => window.open(url, '_blank', features),
            createUrl: (blob) => URL.createObjectURL(blob),
            revokeUrl: (url) => URL.revokeObjectURL(url),
            whenClosed: waitForWindowClose,
            readSeed: readAppStorage,
            baseUrl: document.baseURI,
            fail: (error) => dispatcher.dispatch({ type: 'OP_FAILED', error }),
            // ⚠ 添付起動の経路に組み込みタイルは来ない(kind は 'app' 固定)が、
            //    依存の実体も 1 つに保つ(§7)
            openOffice: openOfficeTile,
            // 🔴 **別窓で開く**(#300 段③)。⚠ 判断と文言は `view-window.ts` に在る
            //    ── 上と同じ配線(§7:依存の実体を 1 つに保つ)
            openView: (view) =>
              void openViewTile(dispatcher, cid, view, (m) => services.setBrowse?.(m), focusSearch),
            // ⚠ 添付起動の経路に組み込みタイルは来ない(kind は 'app' 固定)── それでも
            //    渡すのは、型が**落とせない形**にしてあるからである(§配線を落とすと静かに死ぬ)
            openManual: () => void openManualTile(dispatcher, markdown, showStatus),
            confirmSameOrigin: async (title) => {
              /**
               * 🔴 **「アプリとして登録済みか」で憶え方が変わる**(#301。user 裁定 2026-08-21)。
               * ⚠ 登録の判定は**タイルの一覧**から引く ── frontmatter を自分で読み直すと、
               *   「登録済みとは何か」の規則が 2 か所に生える(`tiles.ts` が正本)。
               */
              const registered =
                dispatcher.getState().launcherTiles?.some((t) => t.lid === lid && t.kind === 'app') ===
                true;
              const seen = { lid, assetKey: att.assetKey, registered };
              if (sameOriginGate.allows(seen)) return true;
              // ⚠ 何が起きるかを**具体**で書く(「安全でない」では判断できない)
              // ⚠ 「同じ場所」と書くと**同じ窓**と読まれる(user 指摘 2026-08-21)──
              //    窓はどちらでも別窓で、変わるのは**データの入れ物**のほうである
              const ok = await ask(
                `「${title}」に、この PKC3 のノート・添付・設定を渡して開きます。\n\n` +
                  'このアプリは PKC3 と同じ保存領域で動くので、あなたのノートを' +
                  '全部読めますし、書き換えもできます。\n' +
                  (registered
                    ? 'アプリとして登録済みなので、この中身は次回から聞きません' +
                      '(中身が変わったらまた聞きます。設定でいつでも取り消せます)。\n'
                    : 'この画面を開いている間は、もう一度は聞きません' +
                      '(読み込み直すとまた聞きます)。\n') +
                  '\n開きますか?',
                { okLabel: 'ノートを渡して開く', danger: true },
              );
              if (!ok) return false;
              // 🔑 憶え先の判断は器の側(`SameOriginGate`)── ここに書くと
              //    どの test からも実行されない(CLAUDE.md §2)
              sameOriginGate.remember(seen);
              return true;
            },
            /**
             * 🔴 **拡張の口**(#195 / C-5 段①)。⚠ 台帳と港の機構は
             *   `extension-grants.ts` / `extension-host.ts` に在る ── ここは配線だけ。
             * ⚠ 見取り図は**呼ばれるたびに常駐の集約から読む**(写しを抱えない)。
             */
            ext: {
              granted: (assetKey) => appExtensionGrants.isGranted(assetKey ?? null),
              /**
               * 🔴 **憶えたら、その場で描き直す**(`revokeExtension` と同じ倒し方)。
               * ⚠ 許可は state に持たないので、描き直さないと
               *   **「目次を見せて起動」のボタンが残ったまま**になる ── user から見ると
               *   「押したのに何も変わらない / まだ許していないのか?」である
               *   (取り消し側では踏まずに、こちらだけ落としていた)。
               */
              grant: (assetKey) => {
                const ok = appExtensionGrants.grant(assetKey ?? null);
                // 🔴 **指紋を崩してから描く**(外部画像の同意と同じ倒し方)。
                //    ⚠ 詳細の指紋は state しか見ていないので、`render` を呼ぶだけでは
                //      **早期 return で何も起きない**(CLAUDE.md §2)。
                center.invalidateDetail();
                center.render(dispatcher.getState());
                return ok;
              },
              confirm: async (title) =>
                // ⚠ 何が見えるかを**具体**で書く(「連携します」では判断できない)
                ask(
                  `「${title}」に、ノートの**目次**を見せて開きます。\n\n` +
                    '見えるのは、ノートの題名・種類・日付・印の一覧だけです。\n' +
                    '本文と添付は渡りません。\n\n' +
                    'この中身は次回から聞きません(中身が変わったらまた聞きます。' +
                    '設定でいつでも取り消せます)。\n\n開きますか?',
                  { okLabel: '目次を見せて開く' },
                ),
              /**
               * 🔴 **繋いだら台帳に載せる**(#195 / C-5 段②)。⚠ 段① まで、港は
               *   `launchTile` のローカル変数で足りていた ── 段② は**外から**
               *   (情報ペインの「このアプリへ送る」)起こすので、
               *   「いまどの窓が開いているか」を引ける場所が要る。
               * 🔑 `track()` は**外すことまで込みの link** を返すので、
               *   `launchTile` は今までどおり `close()` を呼ぶだけでよい
               *   (外し忘れようがない = 幽霊が残らない)。
               */
              connect: (win, nonce, app) =>
                appExtLinks.track(
                  app,
                  connectExtension({
                    win,
                    // 🔴 外殻に焼いたものと**同じ合図**(別々に作ると外殻が港を捨てる)
                    nonce,
                    metas: () => dispatcher.getState().entryMetas.values(),
                    onWrite: (ops) => applyExtWrite(ops),
                  }),
                ),
              nonce: () => crypto.randomUUID(),
            },
          },
          { sameOrigin: launchOpts.sameOrigin, extension: launchOpts.extension },
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
      else if (r.reused) showStatus('開いている Office のウィンドウに表示します');
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
    /**
     * 🔴 **Office の設定を初期状態に戻す**(#634)。⚠ 判断は
     * `office-profile.ts` に在る(ここは渡して、言うだけ)── `main.ts` は
     * どの test からも実行されない(CLAUDE.md 2026-08-08)。
     * ⚠ **描き直さない** ── 消したことで設定の面の見た目は 1 つも変わらない
     *   (このボタンは一式の状態でも profile の有無でも押せる)。結果は
     *   `showStatus` の 1 行で言う ── 押して無反応にしないのはそちらである。
     */
    resetOfficeProfile: () => {
      // ⚠ マクロ(IndexedDB)も同じ口で消す(#431 ②)── 実体は `OfficePackStore.dropMacros`
      showStatus(resetOfficeProfile(localStorage, officePack, announceOfficeProfileReset).message);
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
     * ✏️ 編集の仕方(#104 第 2 弾)。⚠ **描き直さない** ── 編集の面は
     * 編集の入りでしか組まれず、開いている編集は壊さない(効くのは次から。
     * 設定の説明文がそう約束している)。判断(検証・保存)は store 側が持つ。
     */
    setEditorMode: (mode) => {
      appEditorMode.setMode(mode);
    },
    /**
     * ✏️ **開いたら編集に入るか**(user 裁定 2026-08-18)。⚠ **描き直さない** ──
     * 効くのは次に「開く」を押したときからで、いま開いている面は壊さない
     * (設定の説明文がそう約束している)。判断も保存も store 側が持つ。
     */
    setOpenInEdit: (on) => {
      appOpenInEdit.setEnabled(on);
    },
    /**
     * ✏️🔒 編集権(#177 多重タブ)。⚠ 判断(誰が握っているか)は sync の実体
     * (StoreProxyHost / ProxyStoreClient)が持つ ── ここは渡すだけ。
     * `sync` は昇格で実体が替わるので、**呼ぶたびに読む**(closure に固定しない)。
     */
    acquireEditLock: (lid) => sync.acquireEdit(cid, lid),
    releaseEditLock: (lid) => {
      sync.releaseEdit(cid, lid);
    },
    /**
     * 🔗 添付の携帯参照 → **所有ノートへ飛ぶ**(#100 段②)。
     * 逆引きは storage worker(狭い判定 ── attachment の asset_key 等値)。
     * ⚠ 見つからないときは**黙らない**(整理済み等 ── 断りを出す)。
     */
    navigateAssetRef: (assetKey) => {
      void (async () => {
        try {
          const r = (await client.request({
            op: 'findAssetOwner',
            cid,
            assetKey,
          })) as { lid: string | null };
          if (r.lid !== null) {
            dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: r.lid });
          } else {
            dispatcher.dispatch({
              type: 'OP_FAILED',
              error: 'この参照の添付が見つかりません(整理された可能性)',
            });
          }
        } catch (e) {
          dispatcher.dispatch({ type: 'OP_FAILED', error: `参照を解決できません: ${String(e)}` });
        }
      })();
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
     * 🔴 **貼付で読み取る形**(user 指示 2026-08-25)。
     * ⚠ 知らない値は**捨てる**(判定は `isPasteSource` の 1 か所)── 画面を
     *   描き直す必要は無い(次に貼るときから効く)が、**設定画面の値は映す**。
     */
    setPasteSource: (id) => {
      if (!isPasteSource(id)) return;
      if (!appPasteSource.set(id)) return;
      center.render(dispatcher.getState());
    },
    /**
     * 🔴 **2 ペインの「留めた場所」**(#273 残件)。⚠ **端末の保存**である ──
     *   だから state を動かさない。⚠ 保存だけでは画面が変わらない
     *   (帯は state ではなく保存を読む)ので、**描き直しまでが 1 組**である
     *   (CLAUDE.md §7「設定画面の値の同期」と同じ形)。
     */
    toggleDualBookmark: (lid) => {
      appDualPrefs.toggleBookmark(lid);
      center.render(dispatcher.getState());
    },
    /**
     * 🔴 **下見を憶える**(#273 残件)。⚠ 効かせるのは reducer(`DUAL_SET_PREVIEW`)
     *   で、ここは**憶えるだけ** ── 描き直しは state が動いた分で起きる。
     */
    rememberDualPreview: (on) => {
      appDualPrefs.setPreview(on);
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
      // ⚠ 妥当性の判定も **`browse-mode.ts` 1 か所**(着地前レビュー 記録)──
      //   ここに書き下すと、探し方を足したときに必ず取りこぼす
      if (!isBrowseMode(mode)) return;
      browseMode = mode;
      appBrowseMode.set(mode); // 次に開いたときも同じ探し方で出す(#240 段⑤)
      markBrowse(mode);
      browse.render(dispatcher.getState(), mode);
      // ⚠ アプリの一覧は開いたときに読む(常駐していない)。
      // 🔴 **view を借りない**(P8 段⑱)── 中央の面を変える必要が無いのに
      //    `SET_VIEW_MODE 'launcher'` を撃っていたので、タブを切り替えただけで
      //    中央下の追記欄が消えていた(他の 2 タブでは残る)
      if (mode === 'launcher') dispatcher.dispatch({ type: 'REFRESH_LAUNCHER_TILES' });
      // 🔑 予定も同じ流儀(#292 段③)── 開いたときに集める。⚠ 前の束は消さない
      if (mode === 'schedule') dispatcher.dispatch({ type: 'REFRESH_TASK_SCAN' });
      /**
       * 🔑 連絡先も同じ流儀(#278 段①)── **開いたときに集める**。
       * ⚠ boot では集めない ── 「`tel:` を持つ」は抽出列に無いので**全件の
       *   本文を読む**ことになり、連絡先を使わない user に負わせることになる。
       * ⚠ 前の一覧は消さない(読み直しの間に空白を出さない)。
       */
      if (mode === 'contacts') dispatcher.dispatch({ type: 'REFRESH_CONTACT_SCAN' });
      /**
       * 🔴 **面を畳むのは「わきの面」だけ**(2026-08-20。user 指示
       * 「カレンダーを利用するための導線が不足している」の調査で判明)。
       *
       * ⚠ 直す前は `viewMode !== 'detail'` で**一律に畳んで**いた。帰結は
       *   **閉ループ**である ── カレンダーは「ノートを先に選んでから日を押す」
       *   設計なのに、① 開く道はアプリタブのタイルだけ ② そこにノートの一覧は
       *   無い ③ 一覧へ行こうとタブを押すと**カレンダーごと閉じる**。
       *   つまり「カレンダーが開いていて、かつノート一覧が見えている」状態が
       *   **存在し得なかった** = 日付を付ける動線が実質塞がっていた。
       * 🔑 判定は既に在る(`isAsidePane`)── `SELECT_ENTRY` が
       *   「選んだら本文へ戻るか」を決めるのに**同じ関数**を使っている
       *   (`app-state.ts` の `leaveSettings`)。カレンダー / カンバン / 集計は
       *   「選択が面に留まる」側だと**既に決まっていた**のに、
       *   左のタブ経由だけがその意味論を破っていた(CLAUDE.md §7)。
       * ⚠ **帰り道は減る** ── これらの面では、タブを押しても本文へ戻らなくなる。
       *   残る帰り道は **`× 閉じる`** と `Alt+1`(⚠ #300 段③ で**タイルの
       *   再押下は帰り道ではなくなった** ── もう 1 枚窓が開く)。
       *   わきの面(設定 / フラグ / ヘルプ / 2 ペイン)は今までどおり畳む。
       */
      // 🔑 畳むときも `open-view.ts` を通す ── この file から `SET_VIEW_MODE` を
      //    直に撃たない、を**例外なし**の規則にしておく(例外を 1 つ許すと、
      //    次に足す人が「これも例外」と読む)
      if (isAsidePane(dispatcher.getState().viewMode)) openView(dispatcher, 'detail');
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
    /**
     * 🔴 **可搬単一 HTML**(#400 段④)。⚠ 「閲覧用 HTML」とは別の口である ──
     *   あちらは読むだけ、こちらは**アプリごと 1 枚**(続きが書ける)。
     */
    /**
     * 🔴 **貼付でどの形を読むか / 何が届いたかを出すか**(user 指示 2026-08-25)。
     * 🔑 **設定と flag は対**である ── 判定そのものは
     *   `features/markdown/paste-source.ts` の 1 か所に在り、ここは配線だけ。
     */
    pasteSource: () => appPasteSource.get(),
    pasteInspect: () => appFlags.isOn(FLAG_PASTE_INSPECT.name),
    exportPortable: () =>
      void withAssetGate(async () => {
        await exportPortable(dispatcher, {
          title: CONTAINER_TITLE,
          /**
           * ⚠ **雛形は同じ origin から取る** ── 押したときだけ取りに行く
           *   (SW の precache には載せない。載せると全 user が 6.5MB を先に落とす)。
           */
          fetchTemplate: async () => {
            const res = await fetch(new URL('portable-template.html', document.baseURI));
            if (!res.ok)
              throw new Error(
                `アプリの雛形を取れませんでした(HTTP ${res.status})── ` +
                  'この配り方には雛形が同梱されていない可能性があります',
              );
            return res.text();
          },
          exportImage: async () => (await client.request({ op: 'exportImage' })).image,
          listAssets: async () =>
            (await client.request({ op: 'listAssetMetas', cid })).map((m) => ({
              key: m.key,
              mime: m.mime ?? 'application/octet-stream',
            })),
          getAsset: (key) => blobs.get(cid, key),
          download: downloadBlob,
          notify: (message) => showStatus(message),
          report: (notes) => showNotices(regions.notices, '書出し時の注意', notes),
          settle: async () => {
            await storeEffects?.settled();
          },
          insideBundle: () => portable !== null,
        });
      }),
    exportEntry: (lid) => void runExport({ entryLid: lid }),
    // 🔴 **このノートを、相手が開けるだけの 1 枚にする**(#491)
    exportEntryHtml: (lid) => void runExport({ entryLid: lid, as: 'html' }),
    /**
     * 🔴 **このノートを別の窓で開く**(#685 段②、user 裁定 2026-09-04)。
     *
     * 🔑 **`openViewTile` と同じ仕掛けに乗せる**(合図 / 退避 / `noopener`)──
     *   2 か所に別々の「窓を開く作法」を作らない(CLAUDE.md §7)。違うのは
     *   ①`view` を渡さない(面ではなくノートを開く)②退避先が無い
     *   (そのノートは**もう画面に在る**ので、中央の面へ逃がす意味が無い)。
     * ⚠ **押した行のノート**を連れて行く(`selectedLid` ではない)── ⋯ は
     *   行から開くので、選ばれている物と違うことがある。
     */
    openNoteWindow: (lid) => {
      /**
       * 🔴 **同じノートの 2 枚目は作らない**(user 裁定 2026-09-04)。
       * ⚠ 判定は**同期**(台帳は放送で先に埋まっている)── ここで待つと
       *   `window.open` が gesture の外へ落ちる。
       * ⚠ 字で「前に出しました」とは**言わない** ── 前に出るかは実測できていない。
       */
      const where = noteRegistry.whereIs(lid);
      if (where !== null) {
        // ⚠ **この窓が出している**なら、前に出す相手が居ない(いま見ているのがそれ)
        if (where === 'other') noteRegistry.raise(lid);
        // 🔑 字は `deep-link.ts`(#690 I3 ── 別の窓なら**その窓の題名**を添える。
        //    形は `windowTitleFor` と同じなので、タスクバーの字でそのまま探せる)
        dispatcher.dispatch({
          type: 'OP_NOTICE',
          message:
            where === 'self'
              ? NOTE_OPEN_HERE_MESSAGE
              : noteOpenElsewhereMessage(
                  CONTAINER_TITLE,
                  dispatcher.getState().entryMetas.get(lid)?.title ?? null,
                ),
        });
        return;
      }
      // 🔴 **見込みを先に載せる**(着地前レビュー ⚠7)── 窓が名乗るのは boot の後なので、
      //    2 度押しの間は台帳が空である
      noteRegistry.reserve(lid);
      void openViewInWindow(null, {
        // ⚠ `noopener` で開く ── 別プロセスになり、閉じれば常駐が還る。
        //    🔴 **付箋は細い窓で出す**(user 裁定 2026-09-04)── 口は
        //       `view-window.ts` の 1 つで、寸法とずらす位置もそちらが持つ
        open: openNoteWindowUrl,
        baseUrl: currentBaseUrl,
        selected: () => ({ containerId: cid, lid }),
        newToken: makeViewWindowToken,
        waitForOpen: waitForViewWindow,
        // ⚠ 付箋に退避先は無い ── `view === null` のとき呼ばれない
        openInPane: () => false,
        fail: (error) => dispatcher.dispatch({ type: 'OP_FAILED', error }),
        // 🔴 押した瞬間に返事をする(#685 動線レビュー 欠陥 7)── 付箋には
        //    退避先が無いので、塞がれた回は**無反応 2.5 秒だけ**が残る
        /**
         * 🔴 **消すのは自分が出した字のときだけ**(2026-09-04、smoke が教えた)。
         * ⚠ 直す前は、1 枚目が開けた瞬間の `notify('')` が、
         *   **その間に 2 度押しで出た「すでに別のウィンドウで開いています」を消して**
         *   いた ── user は理由を読む前に字が消える。
         */
        notify: (message) => {
          if (message === '' && dispatcher.getState().notice !== VIEW_WINDOW_OPENING) return;
          dispatcher.dispatch({ type: 'OP_NOTICE', message });
        },
        // ⚠ 開けなかったら見込みを外す(次の 1 押しで開けるように)
      }).then((where) => {
        if (where !== 'window') noteRegistry.release(lid);
      });
    },
    /** 🔴 このフォルダと配下をまとめて書き出す(#399 ①)。 */
    exportFolder: (lid) => void runExport({ entryLid: lid, as: 'folder' }),
    /**
     * 🔴 このノートを Word で書き出す(#187 段①)。⚠ **asset gate の内側**で回す
     * ── 画像は段②で入るので、そのとき掃除と競らないように今から内側に置く。
     */
    exportEntryDocx: (lid) => void runExport({ entryLid: lid, as: 'docx' }),
    /**
     * 🔴 このノートを PowerPoint で書き出す(#187 段⑤)。⚠ Word と**同じ道**を通る
     * ── 本文の読み方も画像の入れ方も同じで、違うのは組み立て器だけである。
     */
    exportEntryPptx: (lid) => void runExport({ entryLid: lid, as: 'pptx' }),
    /**
     * 🔑 紙に出す(#187)。⚠ **ここは配線だけ** ── 待つ / 断る / 面を戻すの
     *   判断は `print-note.ts` に在る(`main.ts` は test から 1 度も実行されない)。
     */
    printNote: (lid) =>
      void printNote(
        {
          getState: () => dispatcher.getState(),
          dispatch: (a) => dispatcher.dispatch(a),
          onState: (cb) => dispatcher.onState(cb),
          print: () => window.print(),
        },
        lid,
      ),
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
          /**
           * 🔴 **他のタブの編集も見る**(#253)。自タブの `phase` は**自タブの
           * ことしか言わない** ── 別のタブが編集中に貼った画像は、bytes は在るのに
           * 参照が**未保存の欄の中**にしか無く、走査からは「使っていない」に見える。
           * ⚠ 本体タブと話せないときは `unknown` ── **断るが、文言を分ける**
           *   (「他のタブで編集中」と言うと、存在しないタブを探させる)。
           */
          const editingBefore = await editingElsewhere();
          if (!editingBefore.ok) {
            dispatcher.dispatch({ type: 'OP_FAILED', error: editingBefore.reason });
            return;
          }
          await runExplicitPurge({
            ports: {
              listMetas: () =>
                client.request({ op: 'listAssetMetas', cid }),
              listBlobKeys: () => blobs.listKeys(cid),
              /**
               * 🔴 **どの器にも属さない bytes を拾う**(#260)。
               *
               * key は `${cid}:${assetKey}` で、`listKeys` は自分の接頭辞しか
               * 見ない。cid が端末ごとの採番になったので、**もう存在しない器**の
               * bytes が誰の候補にも載らなくなった(OPFS を取れず `:memory:` に
               * 落ちた回の器は、次の起動には残らない)。
               *
               * ⚠ **生きている器は DB に聞く。`[cid]` で代用しない** ── 将来
               *   器が増えたとき、掃除が**他の器の bytes を消す**形になる。
               * 🔑 **1 件も返らなかったら何もしない** ── 器の一覧を取り
               *   損ねた回に「全部が残骸」と読むと、user の添付を全部消す。
               *   誤差はこの向きにだけ倒す(§7)。
               */
              listStrayBlobs: async () => {
                /**
                 * ⚠ **旧ビルドの本体はこの op を知らない**(#286)。
                 * 落ち方は「機能が減る」側へ ── 残骸を拾えないだけで、
                 * 整理そのものは今までどおり動かす。
                 */
                let cids: string[];
                try {
                  cids = (await client.request({ op: 'listContainerIds' })).containers.map(
                    (c) => c.cid,
                  );
                } catch (err) {
                  if (!isUnknownOpError(err)) throw err;
                  return [];
                }
                return strayBlobKeys(await blobs.listAll(), cids);
              },
              deleteStrayBlob: (storeKey: string) => blobs.deleteStoreKey(storeKey),
              scanReferenced: async (candidates: string[]) =>
                (
                  await client.request({
                    op: 'scanAssetRefs',
                    cid,
                    candidates,
                  })
                ).referenced,
              deleteBlob: (key: string) => blobs.delete(cid, key),
              deleteMeta: async (key: string) => {
                await client.request({ op: 'deleteAssetMeta', cid, key });
              },
            },
            // ⚠ confirm の**後**にもう一度見る(TOCTOU)── 自タブと他タブの両方
            isReady: async () => {
              if (dispatcher.getState().phase !== 'ready')
                return { ok: false, reason: '編集が始まったため中止しました' };
              return editingElsewhere();
            },
            // ⚠ **知らせるほうは捨てない** ── 走査は worker で数秒かかるので、
            //    その間に別の確認が開いていることがある(器が順番に出す)
            ask: (msg) => ask(msg, { okLabel: '整理する', danger: true }),
            tell,
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
   *
   * 🔴 **画像以外(`kinds`)もそのまま渡す**(#528 段③、2026-08-28)。
   *   ⚠ 外部の JavaScript / CSS / `fetch` は**同意で開けられない**ので帯には
   *     しないが、**止めたことは言う**(でないと CDN 前提の中身が真っ白になり、
   *     理由が画面のどこにも無い)。⚠ この中継が種別を落としても、
   *     受け側が optional なら tsc は黙る ── だから必須引数にしてある。
   */
  installHtmlSandboxBlockedReporter((_iframe, blocked, kinds) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid) center.noteBlockedBox(lid, blocked, kinds);
  });
  storeEffects = connectStoreEffects(dispatcher, createStorePort(client, cid), {
    // #148 組み込みタイル ── 一式が入っている端末にだけ Office のタイルを出す。
    // 控えは起動時と設置/削除の直後に setMeta で合っている(officeOpener と同じ値)
    officeInstalled: () => appOfficePack.isInstalled(),
  });
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
      if (appOfficePack.setMeta(meta)) {
        center.invalidateDetail();
        center.render(dispatcher.getState());
      }
      /**
       * 🔴 **配布元と版が違えば知らせる**(user 裁定 2026-08-13「通知のみで OK」)。
       * ⚠ ここは**渡すだけ** ── 取りに行くのは目録(数百バイト)だけで、
       *   一式(77MB)は押した人にしか取らせない。判定も文言も
       *   `office-pack-update.ts` が持つ(`main.ts` は原文 pin の test しか無い面)。
       */
      void checkPackUpdate({
        installedVersion: () => appOfficePack.getMeta()?.version ?? null,
        fetchAvailable: () => officeInstaller.readAvailableVersion(),
      }).then((diff) => {
        appOfficePack.setAvailableVersion(diff.kind === 'differs' ? diff.available : null);
        const notice = packUpdateNotice(diff);
        if (notice !== null) showStatus(notice);
      });
    })
    .catch(() => {});

  dispatcher.dispatch({
    type: 'SYS_BOOTED',
    cid,
    metas,
    relations, // 常駐(§6: 肥大が数字で出たら SQL query 化へ移す)
  });
  /**
   * ⚠ **旧ビルドの本体に合わせた回は、黙って劣化しない**(#286)。
   * user から見ると「別のタブを閉じるまで直らない」ので、直し方まで出す。
   * ⚠ `SYS_BOOTED` の**後**に出す ── 前に出すと boot が状態の行を組み直して消える。
   */
  if (resolved.legacy) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: LEGACY_HOST_NOTICE });
  }
  /**
   * 🔑 **前に点けた下見は、次に開いても点いている**(#273 残件)。
   *
   * ⚠ 憶えているのは端末側(`DualPrefsStore`)、効かせるのは state である ──
   *   起動で 1 度だけ写す。⚠ 写さないと「点けたのに次は消えている」になる。
   * ⚠ `SYS_BOOTED` の**後**に出す(前だと boot が state を組み直して消える)。
   */
  if (appDualPrefs.isPreviewOn()) {
    dispatcher.dispatch({ type: 'DUAL_SET_PREVIEW', on: true });
  }
  /**
   * 🔑 **前に横へ留めたノートは、次に開いても留まっている**(#505 段②)。
   *
   * ⚠ 憶えているのは端末側(`localStorage`)、効かせるのは state である ──
   *   `DUAL_SET_PREVIEW` と同じ作法で、起動で 1 度だけ写す。
   * ⚠ `SYS_BOOTED` の**後**に出す(前だと boot が state を組み直して消える)。
   * ⚠ 消えたノートの lid が混ざっていても構わない ── 本文が読めなかった分は
   *   effect が `UNPIN_SPLIT_ENTRY` で外す(自己修復)。
   */
  const restoredSplit = loadSplitLids();
  if (restoredSplit.length > 0) {
    dispatcher.dispatch({ type: 'SPLIT_RESTORED', lids: restoredSplit });
  }
  /**
   * 🔴 **憶えるのは、復元の後から**(2026-09-02 hotfix。#633 の調査で「一度も成立して
   *   いなかった」と判明 ── `tests/smoke/split-frames.smoke.spec.ts`「開き直しても
   *   留まったまま」が直す前の dist で赤)。
   * ⚠ 直す前は描画の購読(`browse.render` の隣)の中で書いていた。購読は復元より
   *   **前**に張られるので、boot の最初の state(まだ空)を「変わった」と読んで **'' を
   *   書き**、そのあと上の `loadSplitLids()` が空を読んでいた ── 「次に開いても同じ枠が
   *   出ます」と配っていたのに、開き直すと毎回外れていた。
   * 🔑 だから**復元した後の state を起点**にして張る。⚠ **変わったときだけ**書く ──
   *   毎 state で書くと、打鍵のたびに localStorage を叩く。空でも書く(「全部外した」を憶える)。
   */
  let lastSplit = dispatcher.getState().splitLids;
  dispatcher.onState((state) => {
    if (state.splitLids === lastSplit) return;
    lastSplit = state.splitLids;
    saveSplitLids(state.splitLids);
  });
  /**
   * 🔑 **覚えている探し方が「予定」なら、起動でそのまま集める**(#292 段⑤)。
   *
   * ⚠ 集めを頼むのは `setBrowse`(タブを押したとき)だけだったので、
   *   **前回「予定」で閉じた user は、起動直後に「集めています…」で止まる**
   *   ── 一度別のタブへ行って戻るまで動かない。
   * ⚠ 配線であって判定ではない ── 条件は `setBrowse` の 1 行と**同じ綴り**に
   *   しておく(片方だけ直すと、また片方が止まる)。
   */
  if (appBrowseMode.get() === 'schedule') {
    dispatcher.dispatch({ type: 'REFRESH_TASK_SCAN' });
  }
  /**
   * 🔴 **棚に残っている Office の保存を拾う**(#205、B5 の入口③「起動時」)。
   *
   * ⚠ **これが無いと取りこぼしが永久に残る** ── 窓が引き渡し途中で閉じた / 本体の
   * タブが編集中だった、のどちらでも棚に残るが、放送はもう来ない。
   * 🔑 だから**取りこぼしは遅延にしかならない**(#209 の B5)。⚠ 投げっぱなしにする
   * のは、これが boot を遅らせてよい仕事ではないからである。
   */
  void officeSaveBack.drainAll().catch(() => 0);
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
      /**
       * 🔴 **Office の文書は Office へ回す**(#432)。⚠ 回さないと、OS が
       *   PKC3 を起動するのに**誰も受け取らない** ── `import-file.ts` が
       *   markdown 以外を濾すので、user には「開けるファイルがありませんでした」
       *   としか出ない(関連付けを奪ったうえで何もしない、いちばん失礼な形)。
       * ⚠ 振り分けの規則は `office-launch.ts`(manifest と集合で突き合わせてある)。
       * ⚠ ここで窓は開かない ── OS からの起動は user の操作ではないので
       *   **ポップアップ遮断で消える**。控えて、押されたときに渡す。
       */
      const office = items.filter((i) => isOfficeLaunchFile(i.file.name));
      for (const i of office) {
        const buf = new Uint8Array(await i.file.arrayBuffer());
        localOffice.stage(i.handle, i.file.name, buf);
      }
      if (office.length > 0) {
        const last = office[office.length - 1]!;
        const writable = typeof last.handle.createWritable === 'function';
        await whenPhaseReady(dispatcher, () => {});
        showStatus(
          writable
            ? `${last.file.name} を開けます ── アプリの「Office」を押してください`
            : cannotWriteBackNotice(last.file.name),
        );
      }
      items = items.filter((i) => !isOfficeLaunchFile(i.file.name));
      if (items.length === 0) return;
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
    repaintStatus: () => paint(),
    repaintWindowTitle: () => {
      paintTitle();
      announceNote();
    },
    enterNoteWindow: () => {
      // ⚠ 追記欄を出してから焦点の約束をする ── 畳んだままの欄には焦点が乗らない
      applyPaneVisibility(root, appPanes.sessionOnly('append'));
      appendBox.focusInputOnceReady();
    },
    // 🔑 判断は `services.setBrowse` 1 か所 ── ここは呼ぶだけ
    //    ⚠ `BinderServices` では optional なので、無い配線では**何もしない**
    setBrowse: (mode) => services.setBrowse?.(mode),
  };
}

function bootstrap(): void {
  const root = document.querySelector<HTMLElement>('[data-pkc-slot="root"]');
  if (!root) return;

  /**
   * 🔴 **開いた側へ「出ましたよ」と返す**(#300 段③ の直し、2026-08-22)。
   *
   * ⚠ **いちばん最初に呼ぶ** ── storage の初期化を待ってから返すと、開けているのに
   *   開いた側が待ち時間を使い切って**中央の面へ退避する**(本文が消える =
   *   user の苦情そのものの再現)。⚠ 判断・放送・アドレスの後始末は
   *   `deep-link.ts` / `view-window.ts` に在る。
   */
  /**
   * 🔑 **返り値を捨てない**(着地前レビュー 🔴1)── 「この窓はこちらが開いたものか」は
   *   ここでしか分からない(`w=` は直後にアドレスから外れる)。判断と保存は
   *   `deep-link.ts` の `noteOpenedByUs` に在る。
   */
  openedByUs = noteOpenedByUs(
    announceOpenedWindow(),
    typeof sessionStorage === 'object' ? sessionStorage : null,
  );

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
      /**
       * 🔗 **ディープリンク(`#pkc?view=…`)を当てる**(#300 段②)。
       * ⚠ **boot 完了の刻印より前**に当てる ── 後に置くと、
       *   `data-pkc-boot="ready"` を見て進む smoke / probe が
       *   **本文の面を見てから面が入れ替わる**(競走になる)。
       * ⚠ 判断・文言・断片の消し方は全部 `deep-link.ts` に在る ── この file は
       *   どの test からも実行されないので、ここには**配線しか置かない**。
       */
      connectViewDeepLink({
        // ⚠ **`openView` を渡す**(`SET_VIEW_MODE` 直撃ではない)── 開いた後の
        //   後始末が抜けると、アドレスから開いた集計だけ表が出ない
        openView: (mode) => openView(app.dispatcher, mode),
        /**
         * 🔴 **引っ越した面(カレンダー / 板)は左の列のタブへ送る**(段⑤)。
         * ⚠ 栞にしていた人を「使えません」で突き放さない ── **同じものが在る
         *   場所を開く**のが引っ越しの作法である。
         */
        openBrowse: (mode) => app.setBrowse(mode),
        // 🔴 **連れてきたノートを選ぶ**(段③ の直し)。⚠ **container を検める**
        //    ── 別の container の lid を拾うと、偶然の一致で無関係なノートを選ぶ。
        //    ⚠ 居ない lid は `SELECT_ENTRY` 側が黙って捨てる(判定を写さない)
        selectEntry: (containerId, lid) => {
          if (app.dispatcher.getState().cid !== containerId) return;
          app.dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
        },
        /**
         * 🔴 **アプリの窓であることを、題名と `× 閉じる` に伝える**(段③ の直し)。
         * ⚠ 題名を変えるのは**タスクバーで見分けるため** ── 直す前は
         *   何枚開いても全部「PKC3」で、どれがどれか押すまで分からなかった。
         */
        onHold: (view) => {
          heldViewWindow = view;
          // ⚠ **その場で塗り直す** ── 旗を倒しただけでは、次に何かが起きるまで
          //    古い帯が残る(離れた瞬間に「本体タブ経由です」が戻るべきである)
          app.repaintStatus();
          // 🔑 題名の形は `paintTitle` 1 か所(直前は**ここに直書き**していたので、
          //    `onHold` を通らない付箋には永久に届かなかった ── 着地前レビュー ⚠3)
          app.repaintWindowTitle();
        },
        /**
         * 🔴 **付箋の窓であることを、題名と帯に伝える**(#685 着地前レビュー 🔴1 / ⚠3)。
         * ⚠ 判断(何をもって付箋か)は `deep-link.ts` に在る ── ここは旗を持つだけ。
         */
        onHoldEntry: (holding) => {
          // 🔴 **こちらが開いた窓のときだけ付箋とみなす**(着地前レビュー 🔴1)──
          //    user が写した URL で開いたふつうのタブを付箋扱いにしない
          heldNoteWindow = holding && openedByUs;
          app.repaintStatus();
          app.repaintWindowTitle();
          // 🔴 付箋なら追記欄を出し、本文が届いたら打つ欄へ焦点を入れる(#690 ② A′ / I4)
          if (heldNoteWindow) app.enterNoteWindow();
        },
        fail: (error) => app.dispatcher.dispatch({ type: 'OP_FAILED', error }),
        // ⚠ 面が変わったら断片を消す(見ている間だけ残す)
        onViewChange: (fn) => app.dispatcher.onState((s) => fn(s.viewMode)),
        /**
         * 🔴 **住所を、いま見ているノートへ追随させる**(#689 案 B)。
         * ⚠ 判断(名乗っている断片か / 履歴を積まないか)は `deep-link.ts` に在る
         *   ── この file はどの test からも実行されない(CLAUDE.md § 2)。
         */
        onSelectedEntry: (fn) => app.dispatcher.onState((s) => fn(s.cid, s.selectedLid)),
        // ⚠ 開いたままのタブでアドレスへ足したときも効かせる
        onHashChange: (fn) => {
          window.addEventListener('hashchange', fn);
          return () => window.removeEventListener('hashchange', fn);
        },
      });
      // boot 完了の正本契約(P3-8): smoke / probe は DOM 属性で待つ。
      // PKC2 の教訓 ── 「#root 存在待ち」は HTML load 段階で通過して flake 化する
      root.setAttribute('data-pkc-boot', 'ready');
      preboot?.booted(); // 以後は勝手に読み直さない(下書きを巻き込まない)
      /**
       * 📣 お知らせ(P11 段⑤)。⚠ **boot 完了の刻印より後**に出す ──
       * 先に出すと、まだ何も映っていない画面に帯だけが立つ。
       * ⚠ `watchForUpdate` より前でよい(別の行なので重ならない)。
       */
      /**
       * 🔴 **1 つの物のために開いた窓では出さない**(#685 動線レビュー 欠陥 1)。
       * ⚠ 判断は `deep-link.ts` の `isPurposeWindow` に在る ── この file は
       *   どの test からも実行されないので、条件をここへ書かない。
       */
      if (!isPurposeWindow({ view: heldViewWindow, note: heldNoteWindow })) {
        app.presentAnnounce();
      }
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
