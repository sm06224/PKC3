import { APP_ID, APP_VERSION, BUILD_KIND } from '@runtime/release-meta';
import { Dispatcher } from '@adapter/state/dispatcher';
import { connectStoreEffects } from '@adapter/state/store-effects';
import { StoreClient } from '@adapter/platform/storage/store-client';
import {
  createStorePort,
  metaFromRow,
  relationFromRow,
} from '@adapter/platform/storage/store-port';
import { acquireWriterLease } from '@adapter/platform/storage/writer-lease';
import type { InitResult } from '@adapter/platform/storage/protocol';
import { installHtmlSandboxResizer } from '@features/markdown/html-sandbox';
import { AssetBlobStore } from '@adapter/platform/storage/asset-blob-store';
import { findOrphanAssets, purgeAssets } from '@adapter/platform/storage/asset-gc';
import { buildShell } from '@adapter/ui/render/shell';
import { SidebarRenderer } from '@adapter/ui/render/sidebar';
import { CenterRouter } from '@adapter/ui/render/center';
import { formatSize } from '@adapter/ui/render/detail';
import { bindActions, type BinderServices } from '@adapter/ui/actions/binder';
import { attachFiles } from '@adapter/ui/actions/attach';

const DB_NAME = 'pkc3';
const DEFAULT_CID = 'default';

export interface AppHandle {
  dispatcher: Dispatcher;
  storageVfs: InitResult['vfs'];
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
  await client.request({ op: 'openContainer', cid: DEFAULT_CID, title: 'PKC3' });
  const rows = await client.request({ op: 'listEntryMetas', cid: DEFAULT_CID });
  const metas = rows.map(metaFromRow);
  const relRows = await client.request({ op: 'listRelations', cid: DEFAULT_CID });
  const relations = relRows.map(relationFromRow);

  const dispatcher = new Dispatcher();
  const regions = buildShell(root);
  const sidebar = new SidebarRenderer(regions.sidebar);
  // assets: bytes は IDB Blob(sqlite には meta のみ)。表示は lend/dispose 規律
  const blobs = new AssetBlobStore();
  const center = new CenterRouter(regions.detail, undefined, {
    lend: (key) => blobs.lendObjectUrl(DEFAULT_CID, key),
    getBlob: (key) => blobs.get(DEFAULT_CID, key),
  });
  // topbar の active 印(変わったときだけ属性を触る)
  let markedView: string | null = null;
  const markView = (view: string) => {
    if (view === markedView) return;
    for (const btn of regions.topbar.querySelectorAll('[data-pkc-view]')) {
      if (btn.getAttribute('data-pkc-view') === view)
        btn.setAttribute('data-pkc-active', '');
      else btn.removeAttribute('data-pkc-active');
    }
    markedView = view;
  };
  markView('detail');
  dispatcher.onState((state) => {
    sidebar.render(state);
    center.render(state);
    markView(state.viewMode);
  });
  const services: BinderServices = {
    attachFiles: (files) =>
      void attachFiles(
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
        },
        files,
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
        const a = document.createElement('a');
        a.href = lent.url;
        a.download = name;
        document.body.append(a);
        a.click();
        a.remove();
        // click 直後の revoke は DL を中断しうる ── 1 秒で寿命終端
        setTimeout(lent.dispose, 1000);
      } catch (e) {
        // IDB 障害等を unhandled rejection にしない(可視で終える)
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: `ダウンロードに失敗しました(${name}): ${String(e)}`,
        });
      }
    },
    purgeOrphanAssets: () =>
      void (async () => {
        try {
          // editing 中は draft が disk と違う参照を持ちうる ── ready 限定で可視ブロック
          if (dispatcher.getState().phase !== 'ready') {
            dispatcher.dispatch({
              type: 'OP_FAILED',
              error: '編集を終了してから整理してください',
            });
            return;
          }
          const gcPorts = {
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
          };
          const found = await findOrphanAssets(gcPorts);
          if (found.keys.length === 0) {
            window.alert?.('未参照の添付データはありません');
            return;
          }
          // 一括削除なので fail closed(confirm が無い環境では実行しない ──
          // 単発の delete-entry が ?? true なのとは桁が違う)
          const ok =
            window.confirm?.(
              `どの entry からも参照されていない添付データ ${found.keys.length} 件` +
                `(${formatSize(found.knownBytes)})を削除します。よろしいですか?`,
            ) ?? false;
          if (!ok) return;
          const r = await purgeAssets(gcPorts, found.keys);
          window.alert?.(
            `${r.deleted} 件を削除しました` +
              (r.failed > 0 ? `(${r.failed} 件は失敗 ── 再実行で回収されます)` : ''),
          );
        } catch (e) {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: `添付の整理に失敗しました: ${String(e)}`,
          });
        }
      })(),
  };
  bindActions(root, dispatcher, services);
  // html sandbox iframe の高さ追従。1 listener が message 内 id で iframe を
  // 特定するので boot で 1 回だけ張る(規約 ── 多重 install ガードは無い)。
  // ⚠ 別 document の surface(Viewer popup 等、P3-8)には効かない ── その
  // document ごとに再結線が要る(PKC2 で entry-window が高さ 0 のままだった教訓)
  installHtmlSandboxResizer();
  connectStoreEffects(dispatcher, createStorePort(client, DEFAULT_CID));

  // status: provenance + エラーの可視化(review B-1 ── 無言の操作拒否を作らない)
  const statusBase =
    `${APP_ID} v${APP_VERSION} (${BUILD_KIND}) — ${init.vfs}` +
    (init.fallbackReason ? ` ⚠ ${init.fallbackReason}` : '');
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

  dispatcher.dispatch({
    type: 'SYS_BOOTED',
    cid: DEFAULT_CID,
    metas,
    relations, // 常駐(§6: 肥大が数字で出たら SQL query 化へ移す)
  });
  return { dispatcher, storageVfs: init.vfs };
}

function bootstrap(): void {
  const root = document.querySelector<HTMLElement>('[data-pkc-slot="root"]');
  if (!root) return;
  void startApp(root)
    .then((app) => {
      // boot 完了の正本契約(P3-8): smoke / probe は DOM 属性で待つ。
      // PKC2 の教訓 ── 「#root 存在待ち」は HTML load 段階で通過して flake 化する
      root.setAttribute('data-pkc-boot', 'ready');
      if (import.meta.env.DEV) {
        // probe / 手元検証用の導線(DEV のみ)
        (window as unknown as Record<string, unknown>).__APP__ = app;
      }
    })
    .catch((e: unknown) => {
      // boot 失敗を白画面にしない(review A-1)。とくに「未来ビルドの DB を
      // 明示 reject」(schema-migration-policy)はユーザーに見えなければ意味がない
      root.setAttribute('data-pkc-boot', 'error');
      const message = e instanceof Error ? e.message : String(e);
      root.textContent = `起動に失敗しました: ${message}`;
    });

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    // SW 不成立(file:// の可搬 HTML 等)でもアプリは動く
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

bootstrap();
