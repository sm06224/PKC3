// 見た目(P7b 段⑨)。⚠ **ここから import する**のが唯一の入り口 ── index.html に
// `<link>` を書くと Vite の hash 付き出力に乗らず、SW の precache 一覧からも外れる
import './styles/app.css';
import { APP_ID, APP_VERSION, BUILD_KIND } from '@runtime/release-meta';
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
import { installHtmlSandboxResizer } from '@features/markdown/html-sandbox';
import { AssetBlobStore } from '@adapter/platform/storage/asset-blob-store';
import { runExplicitPurge } from '@adapter/platform/storage/asset-gc';
import { buildShell } from '@adapter/ui/render/shell';
import { showNotices, clearNotices } from '@adapter/ui/render/notices';
import { createUpdatePrompt } from '@adapter/ui/render/update-card';
import { applyTheme, chooseTheme, initialTheme, isTheme } from '@adapter/ui/render/theme';
import { launchTile } from '@adapter/ui/launch-tile';
import { readAppStorage } from '@adapter/platform/app-storage';
import { waitForWindowClose } from '@adapter/platform/window-close';
import { copyPlainText } from '@adapter/platform/clipboard';
import { MarkdownClient } from '@adapter/platform/render/markdown-client';
import { AssetClient } from '@adapter/platform/asset/asset-client';
import { watchForUpdate, type UpdateContainer } from '@adapter/platform/sw/update-prompt';
import { reloadOnPrebootSwap, type PrebootTarget } from '@adapter/platform/sw/preboot-swap';
import { InspectorRenderer } from '@adapter/ui/render/inspector';
import { BrowseRouter, type BrowseMode } from '@adapter/ui/render/browse';
import { CenterRouter } from '@adapter/ui/render/center';
import { AppendBoxRenderer } from '@adapter/ui/render/append-box';
import { formatSize } from '@adapter/ui/render/detail';
import { bindActions, generateLid, type BinderServices } from '@adapter/ui/actions/binder';
import { armLaunchQueue, type LaunchTarget } from '@adapter/platform/launch-queue';
import { whenPhaseReady } from '@adapter/state/wait-for-ready';
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
  importLaunchFiles(files: File[]): Promise<void>;
  /**
   * 「新しい版があります」を見せる(P7 段⑤)。押されたら `apply` を呼ぶ。
   * ⚠ 交代を頼むだけ ── 再読込は交代が済んでから(`watchForUpdate` の側)。
   */
  presentUpdate(apply: () => void): void;
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

/** boot(設計メモ §1): lease → worker init → メタ一覧(body 非読込)→ SYS_BOOTED。 */
export async function startApp(root: HTMLElement): Promise<AppHandle> {
  const lease = acquireWriterLease();
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
  // 🎨 配色は**枠より先**に当てる ── 後だと一瞬だけ既定色で描かれて瞬く
  const bootTheme = initialTheme();
  applyTheme(document.documentElement, bootTheme);
  const regions = buildShell(root);
  // ⚠ 帯の選択欄を**いまの配色に合わせる** ── 合わせないと、保存済みの配色で
  // 起動したのに欄は先頭(ライト)を指す = 画面が嘘をつく
  const themeSelect = regions.brand.querySelector<HTMLSelectElement>(
    '[data-pkc-field="theme-select"]',
  );
  if (themeSelect) themeSelect.value = bootTheme;
  // 🔑 左の列は**探し方**で切り替わる(P8 段⑤)。中央は常に「開いているノート」
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  const inspector = new InspectorRenderer(regions.inspector);
  let browseMode: BrowseMode = 'list';
  // assets: bytes は IDB Blob(sqlite には meta のみ)。表示は lend/dispose 規律
  const blobs = new AssetBlobStore();
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
  );
  // いま居る場所の印(変わったときだけ属性を触る)
  let markedView: string | null = null;
  const markView = (view: string) => {
    if (view === markedView) return;
    for (const btn of regions.brand.querySelectorAll('[data-pkc-view]')) {
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
  const statusBase =
    `${APP_ID} v${APP_VERSION}` + (init.fallbackReason ? ` ⚠ ${init.fallbackReason}` : '');
  regions.status.title = `${APP_ID} v${APP_VERSION} (${BUILD_KIND}) — ${init.vfs}`;
  // textContent の setter は同一文字列でも子ノードを全置換する ── 打鍵ごとの
  // state 変化で無駄な DOM 変異を起こさないよう、変わったときだけ書く
  let statusShown = statusBase;
  regions.status.textContent = statusBase;
  const showStatus = (text: string) => {
    if (text === statusShown) return;
    statusShown = text;
    regions.status.textContent = text;
  };
  // エラー表示は state 駆動のみ(P3-6b: BODY_LOAD_FAILED も state.error に
  // 統一 ── 表示寿命は「次の成功 / 選択まで」で、event の一瞬表示問題は消滅)
  dispatcher.onState((state) => {
    showStatus(state.error ? `${statusBase} ⚠ エラー: ${state.error}` : statusBase);
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
        notify: (message) => showStatus(`${statusBase} — ${message}`),
        // ⚠ **注意の中身**を出す導線(review M1 で一度落ちた)。無いと user が
        // 見るのは「⚠ 注意 1 件」だけで、**どの添付が欠けたか**が消える ──
        // バックアップで一番知りたい情報がそこにある
        report: (notes) => showNotices(regions.notices, '書出し時の注意', notes),
        // 🔑 閲覧用 HTML の本文描画は**ワーカーへ**(P8 段⑲)。渡さないと
        //    件数ぶんメインスレッドで描くことになる
        renderBody: (text) => markdown.render(text),
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
      reload: async () => {
        const snap = await loadSnapshot();
        // ⚠ 取込の門は開始時の 1 回だけ ── 長い await の間に user は編集を
        // 始められる。SYS_BOOTED は openBody / selectedLid をリセットするので、
        // そのまま流すと打ちかけの本文が無警告で消える(review H-4、実証済み)
        if (dispatcher.getState().phase !== 'ready') {
          dispatcher.dispatch({
      type: 'OP_FAILED',
      error: '取込は完了しました。編集を終了すると一覧に反映されます',
          });
          return;
        }
        dispatcher.dispatch({ type: 'SYS_BOOTED', cid: DEFAULT_CID, ...snap });
      },
      notify: (message) => showStatus(`${statusBase} — ${message}`),
      // 注意は**全件**を専用面へ(1 行の status では 1 件目しか届かない)
      report: (notes) => showNotices(regions.notices, '取込時の注意', notes),
  };

  /**
   * 取込の本体。⚠ **gate の外**に置く ── 断る版(user のクリック)と
   * 待つ版(OS の launch。断ると選び直せない)の**両方**が同じ処理を呼ぶ。
   * 2 本に分けると片方だけ直す事故が必ず起きる(P7 段③ review H2)
   */
  const runImport = (files: File[]): Promise<void> =>
    importFiles(dispatcher, importDeps, files).then(() => {});

  /** 更新の案内(P7 段⑤)。面と「押されたら何をするか」は render 側が持つ。 */
  const updatePrompt = createUpdatePrompt(regions.update, {
    // ⚠ 再読込は open editor の下書きを捨てる(本文は AppState にしか無い)。
    // 破壊的操作は confirm を出す、というこのリポジトリの倒し方に揃える(review M-2)
    isEditing: () => dispatcher.getState().phase === 'editing',
    confirmDiscard: () =>
      window.confirm?.('編集中の内容は保存されません。新しい版に切り替えますか?') ?? true,
  });

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
        showStatus(
          `${statusBase} — ${ok ? '参照をコピーしました(本文に貼れます)' : 'コピーできませんでした'}`,
        );
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
        origin: location.origin,
        fail: (error) => dispatcher.dispatch({ type: 'OP_FAILED', error }),
      });
      // ⚠ 押した対象を**選択状態にもする**(P8 段⑭)── 起動しただけだと右の列が
      //    空文のままで、いま何を触ったのかが画面に残らない。「押す = 起動」の
      //    意味は変えず、選択は同時に立つ副作用として入れる
      dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
    },
    // 🎨 配色(P7b 段⑨c、user 指示「最初はライトとダークのみに」)。
    // ⚠ 属性は **`<html>`** に付ける ── `:root` の変数を上書きするため
    // ⚠ **ここだけが保存する** ── 起動時の適用は保存しない(review M-7)
    // ⚠ **一覧は 1 か所**(`THEMES`)。ここに `light | dark` のような
    // 別の一覧を書くと、テーマを足しても**黙って効かない**(実際に踏んだ)
    setTheme: (theme) => {
      if (isTheme(theme)) chooseTheme(document.documentElement, theme);
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
            confirm: (msg) => window.confirm?.(msg) ?? false,
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
  connectStoreEffects(dispatcher, createStorePort(client, DEFAULT_CID));

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
    importLaunchFiles: async (files) => {
      await whenPhaseReady(dispatcher, () =>
        showStatus(`${statusBase} — 編集を終えると、開いたファイルを取り込みます`),
      );
      await withAssetGate.queued(() => runImport(files));
    },
    presentUpdate: (apply) => updatePrompt.present(apply),
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
      // 🔄 更新の案内(P7 段⑤)。⚠ 自動では交代させない ── 交代は旧 build の
      // cache を消すので、user が押したときだけ・押したタブだけを再読込する
      void watchForUpdate(
        navigator.serviceWorker as unknown as UpdateContainer,
        registerSw(),
        (apply) => app.presentUpdate(apply),
        () => location.reload(),
      );
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
      const message = e instanceof Error ? e.message : String(e);
      root.textContent = `起動に失敗しました: ${message}`;
      // ⚠ boot が失敗しても登録はする ── 次回この人がオフラインで開けるかは
      // 登録が済んでいるかで決まる(段⑤ の意図。競合を避けて失敗側にも置いた)
      void registerSw();
    });

}

bootstrap();
