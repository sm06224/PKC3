/** @vitest-environment happy-dom */
/**
 * 組み込み先のページの AI に許した範囲(#1407 段⑥)。
 *
 * 守る主張:
 * 1. 🔴 台帳は origin ごと・このブラウザの AI の台帳とは別(片方の「常に許す」がもう片方へ効かない)
 * 2. 🔴 門(`createAgentGate`)は `from` で台帳を選ぶ ── 同じ範囲でも origin A の許可は B に効かない
 * 3. ダイアログの 1 行目が origin をそのまま名指しする(`from` が無ければ従来の字)
 * 4. 設定の一覧に origin つきの行が並び、取り消しは「範囲 + origin」を呼び側へ届ける
 * 5. 壊れた値・知らない範囲は読むときに捨てる / 保存が使えなくても session では効く
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_ORIGIN_GRANTS_KEY,
  AgentGrantsRouter,
  AgentOriginGrants,
} from '@adapter/platform/agent-origin-grants';
import { AgentGrants } from '@adapter/platform/agent-grants';
import { agentAskNote, createAgentGate } from '@features/agent/agent-gate';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { bindActions } from '@adapter/ui/actions/binder';
import { Dispatcher } from '@adapter/state/dispatcher';
import { initialState } from '@adapter/state/app-state';

const A = 'https://a.test';
const B = 'https://b.test';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('AgentOriginGrants', () => {
  it('既定は許可なし。touch(今回だけ)では origins() にも一覧にも出ない', () => {
    const g = new AgentOriginGrants(fakeStorage());
    g.touch(A, 'read', 10);
    expect(g.isAlways(A, 'read')).toBe(false);
    expect(g.origins()).toEqual([]);
    expect(g.list()).toEqual([]);
  });

  it('🔴 origin ごとに別 ── A の「探す・読む」は B にも、A の「作る」にも効かない', () => {
    const g = new AgentOriginGrants(fakeStorage());
    g.setAlways(A, 'read');
    expect(g.isAlways(A, 'read')).toBe(true);
    expect(g.isAlways(B, 'read')).toBe(false);
    expect(g.isAlways(A, 'write')).toBe(false);
    expect(g.origins()).toEqual([A]);
  });

  it('取り消すと範囲が消え、残りが 0 なら origin ごと消える(時刻も)', () => {
    const store = fakeStorage();
    const g = new AgentOriginGrants(store);
    g.setAlways(A, 'read');
    g.setAlways(A, 'append');
    g.touch(A, 'read', 99);
    g.revoke(A, 'read');
    expect(g.list()).toEqual([{ origin: A, scope: 'append', last: null }]);
    g.revoke(A, 'append');
    expect(g.origins()).toEqual([]);
    expect(store.map.has(AGENT_ORIGIN_GRANTS_KEY)).toBe(false);
  });

  it('🔴 鍵はこのブラウザの AI の台帳とは別(片方を取り消してももう片方は残る)', () => {
    const store = fakeStorage();
    const local = new AgentGrants(store);
    const g = new AgentOriginGrants(store);
    local.setAlways('read');
    g.setAlways(A, 'read');
    g.revoke(A, 'read');
    expect(local.isAlways('read')).toBe(true);
    expect(AGENT_ORIGIN_GRANTS_KEY).not.toBe('pkc3.agent-grants');
  });

  it('壊れた値・知らない範囲は捨てる', () => {
    for (const raw of ['{', '[]', '"x"', JSON.stringify({ [A]: 3, [B]: { nope: { always: true } } })]) {
      const store = fakeStorage();
      store.map.set(AGENT_ORIGIN_GRANTS_KEY, raw);
      expect(new AgentOriginGrants(store).origins()).toEqual([]);
    }
  });

  it('🔴 保存が使えない端末でも、この session では効く(控えを読む枝)', () => {
    const g = new AgentOriginGrants(null);
    g.setAlways(A, 'read');
    expect(g.isAlways(A, 'read')).toBe(true);
    g.revoke(A, 'read');
    expect(g.isAlways(A, 'read')).toBe(false);
  });

  it('変化を知らせる(設定の一覧と WebMCP の登録が自分から追う)', () => {
    const g = new AgentOriginGrants(fakeStorage());
    const fn = vi.fn();
    g.onChange(fn);
    g.setAlways(A, 'read');
    g.touch(A, 'read', 1);
    g.revoke(A, 'read');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('門が from で台帳を選ぶ', () => {
  function gateWith(answer: 'once' | 'always' | 'deny') {
    const local = new AgentGrants(fakeStorage());
    const byOrigin = new AgentOriginGrants(fakeStorage());
    const asked: unknown[] = [];
    const gate = createAgentGate({
      grants: new AgentGrantsRouter(local, byOrigin),
      ask: async (t) => {
        asked.push(t);
        return answer;
      },
      now: () => 5,
    });
    return { local, byOrigin, asked, gate };
  }

  it('🔴 A で「常に許す」→ A はもう聞かれず、B・このブラウザの AI はまた聞かれる', async () => {
    const { gate, asked, byOrigin, local } = gateWith('always');
    expect(await gate({ action: 'tags', from: A })).toBe(true);
    expect(asked).toHaveLength(1);
    expect(byOrigin.isAlways(A, 'read')).toBe(true);
    expect(local.isAlways('read')).toBe(false);
    expect(await gate({ action: 'tags', from: A })).toBe(true);
    expect(asked).toHaveLength(1); // A は聞かれない
    await gate({ action: 'tags', from: B });
    await gate({ action: 'tags' });
    expect(asked).toHaveLength(3);
    expect(byOrigin.list().find((r) => r.origin === A)?.last).toBe(5);
  });

  it('🔴 from の無い依頼の「常に許す」は、組み込み先の台帳に入らない', async () => {
    const { gate, byOrigin, local } = gateWith('always');
    await gate({ action: 'search', query: 'q' });
    expect(local.isAlways('read')).toBe(true);
    expect(byOrigin.origins()).toEqual([]);
  });

  it('🔴 このブラウザの AI に「常に許す」を選んでも、組み込み先のページの AI はまた聞かれる', async () => {
    const { gate, asked, local } = gateWith('once');
    local.setAlways('read');
    expect(await gate({ action: 'tags' })).toBe(true);
    expect(asked, '対照群: このブラウザの AI は聞かれない').toHaveLength(0);
    await gate({ action: 'tags', from: A });
    expect(asked, 'ブラウザの AI の許可が組み込み先へ漏れた').toHaveLength(1);
  });

  it('「許さない」は台帳を触らない', async () => {
    const { gate, byOrigin } = gateWith('deny');
    expect(await gate({ action: 'create', title: 't', from: A })).toBe(false);
    expect(byOrigin.list()).toEqual([]);
  });
});

describe('ダイアログの 1 行目が origin を名指しする', () => {
  it('from あり: origin がそのまま入る(切らない)/ なし: 従来の字', () => {
    expect(agentAskNote({ action: 'tags', from: A })).toContain(`${A} のページに組み込まれた AI が`);
    expect(agentAskNote({ action: 'append', title: 't', from: A })).toContain(`${A} のページに組み込まれた AI が、『t』の末尾`);
    expect(agentAskNote({ action: 'tags' })).toContain('ブラウザの AI が、タグの一覧を見ようとしています');
    const long = `https://${'x'.repeat(80)}.test`;
    expect(agentAskNote({ action: 'read', title: 't', from: long })).toContain(long);
  });
});

describe('設定の一覧と取り消し', () => {
  const BEFORE_AGENT_GRANTS = 21;
  function setup(byOrigin: AgentOriginGrants) {
    const root = document.createElement('div');
    document.body.append(root);
    const region = document.createElement('div');
    root.append(region);
    const Ctor = SettingsRenderer as unknown as new (...args: unknown[]) => SettingsRenderer;
    const renderer = new Ctor(
      region,
      ...Array.from({ length: BEFORE_AGENT_GRANTS }, () => undefined),
      new AgentGrants(fakeStorage()),
      undefined,
      byOrigin,
    );
    return { root, region, renderer };
  }

  it('origin つきの行が並び、origin は字として出る(HTML にならない)', () => {
    const g = new AgentOriginGrants(fakeStorage());
    g.setAlways(A, 'read');
    g.setAlways('https://<img src=x onerror=alert(1)>.test', 'write');
    const { region, renderer } = setup(g);
    renderer.render(initialState);
    const li = region.querySelectorAll<HTMLElement>('[data-pkc-field="agent-list"] li');
    expect(li).toHaveLength(2);
    expect(li[0]!.getAttribute('data-pkc-agent-origin')).toBe(A);
    expect(li[0]!.querySelector('[data-pkc-field="agent-origin"]')!.textContent).toBe(`${A} のページの AI`);
    expect(region.querySelector('[data-pkc-field="agent-list"] img')).toBeNull();
    expect(region.textContent).not.toContain('まだ許したことはありません');
  });

  it('🔴 取り消しは範囲と origin の両方が呼び側へ届く。ブラウザの AI の行は origin なし', () => {
    const g = new AgentOriginGrants(fakeStorage());
    g.setAlways(A, 'read');
    const { root, region, renderer } = setup(g);
    renderer.render(initialState);
    const revoke = vi.fn();
    bindActions(root, new Dispatcher(), { revokeAgent: revoke } as never);
    region.querySelector<HTMLElement>('[data-pkc-action="revoke-agent"]')!.click();
    expect(revoke).toHaveBeenCalledWith('read', A);
  });
});
