import { APP_ID, APP_VERSION, BUILD_KIND } from '@runtime/release-meta';
import { Dispatcher } from '@adapter/state/dispatcher';
import { connectStoreEffects } from '@adapter/state/store-effects';
import { StoreClient } from '@adapter/platform/storage/store-client';
import { createStorePort, metaFromRow } from '@adapter/platform/storage/store-port';
import { acquireWriterLease } from '@adapter/platform/storage/writer-lease';
import { buildShell } from '@adapter/ui/render/shell';
import { SidebarRenderer } from '@adapter/ui/render/sidebar';
import { DetailRenderer } from '@adapter/ui/render/detail';
import { bindActions } from '@adapter/ui/actions/binder';

const DB_NAME = 'pkc3';
const DEFAULT_CID = 'default';

export interface AppHandle {
  dispatcher: Dispatcher;
}

/** boot(設計メモ §1): lease → worker init → メタ一覧(body 非読込)→ SYS_BOOTED。 */
export async function startApp(root: HTMLElement): Promise<AppHandle> {
  const lease = acquireWriterLease();
  if (!(await lease.immediate)) {
    root.textContent = '別のタブで開いています。そのタブを閉じると、ここで続きが開きます…';
    await lease.whenHeld;
  }

  const client = new StoreClient();
  const init = await client.request({ op: 'init', dbName: DB_NAME });
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
  connectStoreEffects(
    dispatcher,
    createStorePort(client, DEFAULT_CID, (lid) =>
      dispatcher.getState().entryMetas.get(lid),
    ),
  );

  regions.status.textContent =
    `${APP_ID} v${APP_VERSION} (${BUILD_KIND}) — ${init.vfs}` +
    (init.fallbackReason ? ` ⚠ ${init.fallbackReason}` : '');

  dispatcher.dispatch({
    type: 'SYS_BOOTED',
    cid: DEFAULT_CID,
    metas,
    relations: [], // relations op の配線は P3-6(kanban/calendar)で
  });
  return { dispatcher };
}

function bootstrap(): void {
  const root = document.querySelector<HTMLElement>('[data-pkc-slot="root"]');
  if (!root) return;
  void startApp(root).then((app) => {
    if (import.meta.env.DEV) {
      // probe / 手元検証用の導線(DEV のみ)
      (window as unknown as Record<string, unknown>).__APP__ = app;
    }
  });

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    // SW 不成立(file:// の可搬 HTML 等)でもアプリは動く
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

bootstrap();
