/**
 * 🔴 **同期フォルダ(#2000 段 3)の画面の写しの受け口**。
 *
 * 同期フォルダの実体(`adapter/platform/sync-folder.ts` の `SyncFolder`)は `main.ts` が 1 つだけ作る。設定の画面はここから
 * いまの姿(`SyncFolderView`)を読む ── 設定の画面の側で実体を作らない(handle の持ち主を 1 つにする)。
 * まだ繋がっていない(起動の途中・test)ときは `null` を返し、画面は「選ぶ」だけを出す。
 */
import type { SyncFolderView } from '@adapter/platform/sync-folder';

export class SyncFolderViewSource {
  private read: (() => SyncFolderView) | null = null;

  attach(read: () => SyncFolderView): void {
    this.read = read;
  }

  view(): SyncFolderView | null {
    return this.read === null ? null : this.read();
  }
}

/** アプリ共有の 1 個。 */
export const appSyncFolderView = new SyncFolderViewSource();
