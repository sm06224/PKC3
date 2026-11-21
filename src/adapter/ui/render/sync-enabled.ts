/**
 * 🔴 **端末間の同期を使うか**(#2000 段 2。user 裁定 2026-11-21: **任意の設定・既定は切**)。
 *
 * - 切の間は、同期の行(端末 id・連番・削除の記録・同期の記録)を 1 本も書かず、同期の入口(「差分を書き出す」)も出さない
 *   (今までどおり完全にローカル)。取り込みは断り、設定の場所を言う。
 * - ⚠ **flag ではない**(正規設定。flags の 15 枠は使わない ── `tests/flag-budget.test.ts`)。
 * - ⚠ **端末ごとの設定**(`SKIPPED_KEYS`。設定ファイルでは移さない)。container にも入れない。
 * - 入 / 切を変えたら worker にも教える(`syncConfigure`。入のときだけ、ノートを消すと削除の記録を残す)。
 *   配線は `main.ts` の `setSyncEnabled`。
 */
import { SYNC_ENABLED_KEY } from '@features/sync/sync-setting';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class SyncEnabledStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback = false;

  /** 🔴 直近の書き込みが失敗したか(容量不足など)。真の間は読みも控えを返す。 */
  private saveFailed = false;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage()) {}

  /** ⚠ **読むたびに保存を見る**(書き手が複数のタブ・窓)。 */
  enabled(): boolean {
    // 🔴 **保存が無い環境では控えを読む**(`?.` は null で例外を出さず catch の控えに入らない)
    if (this.storage === null || this.saveFailed) return this.fallback;
    try {
      return this.storage.getItem(SYNC_ENABLED_KEY) === '1';
    } catch {
      return this.fallback;
    }
  }

  setEnabled(on: boolean): void {
    this.fallback = on;
    this.saveFailed = false;
    try {
      this.storage?.setItem(SYNC_ENABLED_KEY, on ? '1' : '0');
    } catch {
      // 🔴 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す(戻らない)
      this.saveFailed = true;
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appSyncEnabled = new SyncEnabledStore();
