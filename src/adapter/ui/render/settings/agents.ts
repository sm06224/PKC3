/**
 * 🔴 **ブラウザの AI に許した範囲の一覧**の節(#1407 段①)── 「許可」の h3 の中。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { AgentGrants } from '@adapter/platform/agent-grants';
import type { AgentTabStatus } from '@adapter/platform/agent-tab-status';
import { WEBMCP_TAB_STATUS_TEXT } from '@features/agent/webmcp-types';
import { AGENT_SCOPE_LABEL } from '@features/agent/agent-gate';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

/** 最後に使われた時刻を「2026-10-07 09:05」の形で出す(この端末の時刻)。 */
function formatAgentTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function createAgentsSection(grants: AgentGrants, tabStatus: AgentTabStatus): SettingsSection {
  let agentList: HTMLElement | null = null;
  let agentStatusLine: HTMLElement | null = null;

  return {
    id: 'agents',
    group: 'permissions',
    /**
     * 🔴 **ブラウザの AI に許した範囲の一覧**(#1407 段①)。
     *
     * ⚠ 「許可」の節に**同じ形の一覧として並べる**(新しい見出しを作らない ── 取り消す入口は
     *   1 つの節に揃える)。台帳は他の 2 つとは**別**なので、片方を取り消してももう片方は残る。
     * 🔑 ここが**取り消しの唯一の出口**である ── 「常に許す」は期限なしで憶えるので、
     *   出口が無いと二度と外せない。
     * ⚠ 見えるものを書く:許すと何が外へ出るか(読む側は本文)。
     */
    build(): HTMLElement {
      const wrap = document.createElement('section');
      wrap.setAttribute('data-pkc-region', 'settings-agents');
      const h = document.createElement('h4');
      h.textContent = 'ブラウザの AI に許したこと';
      const note = buildSettingsNote(
        'ノートを探す・読むを許すと、見つかったノートの本文が AI の提供元へ送られます。',
      );
      // 🔴 **このタブの状態を 1 行で言う**(使えない理由を user が探し回らない ── 同じ物が同じ場所に出る)
      agentStatusLine = document.createElement('p');
      agentStatusLine.setAttribute('data-pkc-field', 'agent-tab-status');
      agentList = document.createElement('ul');
      agentList.setAttribute('data-pkc-field', 'agent-list');
      wrap.append(h, note, agentStatusLine, agentList);
      return wrap;
    },
    /** ⚠ **毎回組み直す**(許可はこの画面の外 ── AI が呼んだときのダイアログ ── で増える)。 */
    sync(): void {
      const list = agentList;
      if (!list) return;
      if (agentStatusLine) {
        agentStatusLine.textContent = WEBMCP_TAB_STATUS_TEXT[tabStatus.get()];
      }
      const rows = grants.list();
      list.textContent = '';
      if (rows.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'まだ許したことはありません';
        list.append(li);
        return;
      }
      for (const row of rows) {
        const li = document.createElement('li');
        li.setAttribute('data-pkc-agent-scope', row.scope);
        const name = document.createElement('span');
        name.setAttribute('data-pkc-field', 'agent-scope-name');
        name.textContent = AGENT_SCOPE_LABEL[row.scope];
        const last = document.createElement('span');
        last.setAttribute('data-pkc-field', 'agent-last-used');
        last.textContent =
          row.last === null ? 'まだ使われていません' : `最後に使われた: ${formatAgentTime(row.last)}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-pkc-action', 'revoke-agent');
        btn.setAttribute('data-pkc-agent-scope', row.scope);
        btn.textContent = '許可を取り消す';
        li.append(name, last, btn);
        list.append(li);
      }
    },
  };
}
