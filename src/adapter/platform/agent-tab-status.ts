/**
 * このタブで AI のツールが使えるか ── 設定の「ブラウザの AI に許したこと」が 1 行で言うための控え(#1407)。
 *
 * 書くのは起動の配線(`main.ts` が `createWebMcpRegistration` の状態をここへ渡す)、読むのは設定の画面だけ。
 * ⚠ 保存はしない(タブごとの事実で、端末の判断ではない)。
 */

import type { WebMcpTabStatus } from '@features/agent/webmcp-types';

export class AgentTabStatus {
  /** 起動の配線が知らせるまでは「フラグがオフ」(登録していないので、嘘ではない)。 */
  private value: WebMcpTabStatus = 'flag-off';

  get(): WebMcpTabStatus {
    return this.value;
  }

  set(next: WebMcpTabStatus): void {
    this.value = next;
  }
}

/** アプリ共有の 1 個。⚠ test は自分で `new AgentTabStatus()` を渡す。 */
export const appAgentTabStatus = new AgentTabStatus();
