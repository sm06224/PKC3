/**
 * 🔴 **フォルダ同期(全データ。#2000 段 3)の「いまの状態」を設定画面へ渡す口**。
 * 状態の持ち主は `actions/sync-folder.ts` の `SyncFolder`(1 つ)。設定画面(`settings/sync-enabled.ts`)は読むだけ
 * (`appSyncEnabled` と同じ、アプリ共有の 1 個)。⚠ 配線(`main.ts`)が `attach` するまでは「使えない」と映す。
 */
import type { SyncFolderView } from '../actions/sync-folder';

export class SyncFolderViewHolder {
  private source: (() => SyncFolderView) | null = null;

  attach(source: () => SyncFolderView): void {
    this.source = source;
  }

  view(): SyncFolderView | null {
    return this.source === null ? null : this.source();
  }
}

export const appSyncFolderView = new SyncFolderViewHolder();
