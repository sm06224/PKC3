import { APP_ID, APP_VERSION, BUILD_KIND } from '@runtime/release-meta';
import { Dispatcher } from '@adapter/state/dispatcher';
import { connectStoreEffects } from '@adapter/state/store-effects';
import { StoreClient } from '@adapter/platform/storage/store-client';
import { createStorePort, metaFromRow } from '@adapter/platform/storage/store-port';
import { acquireWriterLease } from '@adapter/platform/storage/writer-lease';
import type { InitResult } from '@adapter/platform/storage/protocol';
import { installHtmlSandboxResizer } from '@features/markdown/html-sandbox';
import { buildShell } from '@adapter/ui/render/shell';
import { SidebarRenderer } from '@adapter/ui/render/sidebar';
import { DetailRenderer } from '@adapter/ui/render/detail';
import { bindActions } from '@adapter/ui/actions/binder';

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

  const dispatcher = new Dispatcher();
  const regions = buildShell(root);
  const sidebar = new SidebarRenderer(regions.sidebar);
  const detail = new DetailRenderer(regions.detail);
  dispatcher.onState((state) => {
    sidebar.render(state);
    detail.render(state);
  });
  bindActions(root, dispatcher);
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
  regions.status.textContent = statusBase;
  dispatcher.onState((state) => {
    regions.status.textContent = state.error
      ? `${statusBase} ⚠ エラー: ${state.error}`
      : statusBase;
  });
  dispatcher.onEvent((ev) => {
    if (ev.type === 'APP_ERROR')
      regions.status.textContent = `${statusBase} ⚠ ${ev.error}`;
  });

  dispatcher.dispatch({
    type: 'SYS_BOOTED',
    cid: DEFAULT_CID,
    metas,
    relations: [], // relations op の配線は P3-6(kanban/calendar)で
  });
  return { dispatcher, storageVfs: init.vfs };
}

function bootstrap(): void {
  const root = document.querySelector<HTMLElement>('[data-pkc-slot="root"]');
  if (!root) return;
  void startApp(root)
    .then((app) => {
      if (import.meta.env.DEV) {
        // probe / 手元検証用の導線(DEV のみ)
        (window as unknown as Record<string, unknown>).__APP__ = app;
      }
    })
    .catch((e: unknown) => {
      // boot 失敗を白画面にしない(review A-1)。とくに「未来ビルドの DB を
      // 明示 reject」(schema-migration-policy)はユーザーに見えなければ意味がない
      const message = e instanceof Error ? e.message : String(e);
      root.textContent = `起動に失敗しました: ${message}`;
    });

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    // SW 不成立(file:// の可搬 HTML 等)でもアプリは動く
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

bootstrap();
