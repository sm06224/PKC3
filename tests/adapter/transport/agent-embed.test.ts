/** @vitest-environment happy-dom */
/**
 * 組み込み先のページの AI に道具を渡す口(#1407 段⑥)。
 *
 * 守る主張(🔴 はどれも「外すと他人のページに本文が渡る」側):
 * 1. 🔴 `exposedTo` に載るのは**許可リスト ∩ 常に許す済み**の origin だけ(`*` / `null` / 形が違う物・flag オフは載らない)
 * 2. 🔴 許可を取り消す(`revoke`)と登録の signal が abort される ── 他の origin は残る
 * 3. 🔴 JSON-RPC `tools/list` / `tools/call` は許可リストの外・flag オフ・合図の相手を断る(fail-closed)
 * 4. 🔴 `tools/call` は WebMCP と**同じ道具の組**を通り、門へ `from`(origin)が載る
 * 5. 大きすぎる封筒・回数超過は、窓口(`message-bridge`)が先に断る
 */
import { describe, expect, it, vi } from 'vitest';
import { createAgentEmbed, type AgentEmbedDeps } from '@adapter/transport/agent-embed';
import { startEmbedBridge } from '@adapter/transport/embed-bridge';
import { buildAgentTools, type AgentToolDeps } from '@adapter/transport/webmcp-tools';
import { MAX_PER_MINUTE, MAX_ROUGH_SIZE, RPC } from '@adapter/transport/protocol';
import type { AgentTarget } from '@features/agent/agent-gate';
import type { ModelContextTool } from '@features/agent/webmcp-types';

const A = 'https://a.test';
const B = 'https://b.test';

interface Registered {
  name: string;
  exposedTo: string[] | undefined;
  signal: AbortSignal | undefined;
}

function setup(over: Partial<AgentEmbedDeps> = {}, mc: boolean = true) {
  const registered: Registered[] = [];
  const gateCalls: AgentTarget[] = [];
  const state = { enabled: true, allowed: [A, B] as string[], granted: [A] as string[] };
  const toolDeps: AgentToolDeps = {
    meta: (id) => (id === 'n1' ? { title: '買い物', archetype: 'text', updatedAt: null } : undefined),
    search: async () => ({ ids: ['n1'], truncated: false }),
    bodies: async () => new Map([['n1', '牛乳']]),
    tags: async () => ({ groups: [], omitted: 0 }),
    createEntry: () => 'new1',
    append: async () => ({ ok: true }),
    appendCheck: () => 'ok',
    notifyAppended: () => undefined,
    gate: async (t) => {
      gateCalls.push(t);
      return true;
    },
  };
  const modelContext = {
    registerTool: (tool: ModelContextTool, o?: { signal?: AbortSignal; exposedTo?: string[] }) => {
      registered.push({ name: tool.name, exposedTo: o?.exposedTo, signal: o?.signal });
      return Promise.resolve(undefined);
    },
  };
  const embed = createAgentEmbed({
    enabled: () => state.enabled,
    allowed: () => state.allowed,
    granted: () => state.granted,
    host: mc ? { document: { modelContext } } : {},
    buildTools: (from) => buildAgentTools({ ...toolDeps, from }),
    ...over,
  });
  return { embed, state, registered, gateCalls };
}

describe('exposedOrigins(WebMCP の exposedTo に載せる origin)', () => {
  it('🔴 許可リスト ∩ 常に許す済み だけ(許可リストにあるだけ / 許しただけ では載らない)', () => {
    const { embed, state } = setup();
    expect(embed.exposedOrigins()).toEqual([A]);
    state.granted = ['https://c.test']; // 許したが許可リストに無い
    expect(embed.exposedOrigins()).toEqual([]);
    state.granted = [];
    expect(embed.exposedOrigins()).toEqual([]);
  });

  it("🔴 `*` / `null` / origin でない物は、許可リストにあっても載せない", () => {
    const { embed, state } = setup();
    state.allowed = ['*', 'null', 'https://a.test/path', 'javascript:alert(1)', 'ftp://x.test', A, A];
    state.granted = state.allowed.slice();
    expect(embed.exposedOrigins()).toEqual([A]);
  });

  it('🔴 flag がオフなら空', () => {
    const { embed, state } = setup();
    state.enabled = false;
    expect(embed.exposedOrigins()).toEqual([]);
  });
});

describe('sync(WebMCP への登録)', () => {
  it('🔴 載った origin にだけ、道具 5 本を exposedTo:[その origin] で登録する', () => {
    const { embed, registered } = setup();
    embed.sync();
    expect(registered).toHaveLength(5);
    for (const r of registered) {
      expect(r.exposedTo).toEqual([A]);
      expect(r.signal?.aborted).toBe(false);
    }
    expect(embed.registered()).toEqual([A]);
    // 二度呼んでも二重に登録しない
    embed.sync();
    expect(registered).toHaveLength(5);
  });

  it('🔴 flag オフ・入口が無いブラウザでは何も登録しない', () => {
    const off = setup();
    off.state.enabled = false;
    off.embed.sync();
    expect(off.registered).toHaveLength(0);
    const none = setup({}, false);
    none.embed.sync();
    expect(none.registered).toHaveLength(0);
  });

  it('🔴 revoke で登録の signal が abort される ── 他の origin の登録は残る', () => {
    const { embed, state, registered } = setup();
    state.granted = [A, B];
    embed.sync();
    expect(registered).toHaveLength(10);
    embed.revoke(A);
    const forA = registered.filter((r) => r.exposedTo?.[0] === A);
    const forB = registered.filter((r) => r.exposedTo?.[0] === B);
    expect(forA.every((r) => r.signal?.aborted === true)).toBe(true);
    expect(forB.every((r) => r.signal?.aborted === false)).toBe(true);
    expect(embed.registered()).toEqual([B]);
  });

  it('🔴 許可が外れた状態で sync すると畳む(取り消しが台帳経由で届く)', () => {
    const { embed, state, registered } = setup();
    embed.sync();
    state.granted = [];
    embed.sync();
    expect(registered.every((r) => r.signal?.aborted === true)).toBe(true);
    expect(embed.registered()).toEqual([]);
  });

  it('取り消した後に許し直すと、新しい登録ができる(古い signal は abort のまま)', () => {
    const { embed, state, registered } = setup();
    embed.sync();
    embed.revoke(A);
    embed.sync(); // まだ granted に A が居る → 再登録
    expect(registered).toHaveLength(10);
    expect(registered.slice(5).every((r) => r.signal?.aborted === false)).toBe(true);
    expect(state.granted).toEqual([A]);
  });
});

describe('list / call(JSON-RPC の道)', () => {
  it('許可リストの origin には道具の定義を返す(execute は渡さない)', () => {
    const { embed } = setup();
    const tools = embed.list(A);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'pkc_append_note',
      'pkc_create_note',
      'pkc_list_tags',
      'pkc_read_note',
      'pkc_search_notes',
    ]);
    expect(tools.every((t) => !('execute' in t))).toBe(true);
  });

  it('🔴 許可リストに無い origin・`*` だけの許可リスト・flag オフは例外(FORBIDDEN_ORIGIN)', async () => {
    const { embed, state } = setup();
    expect(() => embed.list('https://evil.test')).toThrow('許可されていない');
    await expect(embed.call('https://evil.test', 'pkc_list_tags', {})).rejects.toMatchObject({
      rpcCode: RPC.FORBIDDEN_ORIGIN,
    });
    state.allowed = ['*'];
    expect(() => embed.list('https://evil.test')).toThrow();
    // 🔴 許可リストに `*` / `null` の字そのものが入っていても、その字を名乗る相手には開かない(`nameable` の門)
    state.allowed = ['*', 'null', A];
    expect(() => embed.list('*'), '`*` を名乗る相手に道具を見せた').toThrow();
    expect(() => embed.list('null'), '`null`(file: や sandbox の iframe)に道具を見せた').toThrow();
    expect(embed.list(A).length, '対照群: 名指しの origin には見せる').toBe(5);
    state.allowed = [A];
    state.enabled = false;
    expect(() => embed.list(A)).toThrow();
    await expect(embed.call(A, 'pkc_list_tags', {})).rejects.toMatchObject({ rpcCode: RPC.FORBIDDEN_ORIGIN });
  });

  it('🔴 call は門を通り、依頼に from(origin)が載る ── 本文は門を通ってから', async () => {
    const { embed, gateCalls } = setup();
    const r = await embed.call(A, 'pkc_search_notes', { query: '牛乳' });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ notes: [{ title: '買い物', body: '牛乳' }] });
    expect(gateCalls).toEqual([{ action: 'search', query: '牛乳', from: A }]);
  });

  it('🔴 門が断れば本文は返らない(isError)', async () => {
    const { embed } = setup();
    const tools = embed.list(A);
    expect(tools.length).toBe(5);
    const deny = setup();
    // gate を断る側へ差し替えた組み
    const denied = createAgentEmbed({
      enabled: () => true,
      allowed: () => [A],
      granted: () => [A],
      host: {},
      buildTools: (from) =>
        buildAgentTools({
          meta: () => ({ title: 't', archetype: 'text', updatedAt: null }),
          search: async () => ({ ids: ['x'], truncated: false }),
          bodies: async () => new Map([['x', '秘密']]),
          tags: async () => ({ groups: [], omitted: 0 }),
          createEntry: () => 'id',
          append: async () => ({ ok: true }),
          appendCheck: () => 'ok',
          notifyAppended: () => undefined,
          gate: async () => false,
          from,
        }),
    });
    const r = await denied.call(A, 'pkc_search_notes', { query: 'q' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain('秘密');
    expect(deny.gateCalls).toEqual([]);
  });

  it('不正な name / arguments は INVALID_PARAMS', async () => {
    const { embed } = setup();
    await expect(embed.call(A, 5, {})).rejects.toMatchObject({ rpcCode: RPC.INVALID_PARAMS });
    await expect(embed.call(A, 'nope', {})).rejects.toMatchObject({ rpcCode: RPC.INVALID_PARAMS });
    await expect(embed.call(A, 'pkc_list_tags', [1])).rejects.toMatchObject({ rpcCode: RPC.INVALID_PARAMS });
  });

  it('🔴 取り消し(revoke)で、待っていた依頼の signal が abort される', async () => {
    let seen: AbortSignal | undefined;
    const { embed } = setup({
      buildTools: (from) =>
        buildAgentTools({
          meta: () => undefined,
          search: async () => ({ ids: [], truncated: false }),
          bodies: async () => new Map(),
          tags: async () => ({ groups: [], omitted: 0 }),
          createEntry: () => null,
          append: async () => ({ ok: true }),
          appendCheck: () => 'ok',
          notifyAppended: () => undefined,
          gate: (_t, signal) => {
            seen = signal;
            return new Promise<boolean>(() => undefined);
          },
          from,
        }),
    });
    void embed.call(A, 'pkc_list_tags', {});
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen!.aborted).toBe(false);
    embed.revoke(A);
    expect(seen!.aborted).toBe(true);
  });

  it('origin ごとに回数を数える(A が使い切っても B は使える)', async () => {
    const { embed, state } = setup();
    state.allowed = [A, B];
    for (let i = 0; i < MAX_PER_MINUTE; i += 1) await embed.call(A, 'pkc_list_tags', {});
    const over = await embed.call(A, 'pkc_list_tags', {});
    expect(over.isError).toBe(true);
    expect(over.content[0]!.text).toContain('呼び出しが多すぎます');
    const other = await embed.call(B, 'pkc_list_tags', {});
    expect(other.isError).toBeFalsy();
  });
});

describe('窓口(embed-bridge)経由の tools/list・tools/call', () => {
  interface Sent {
    payload: Record<string, unknown>;
    targetOrigin: string;
  }
  function bridge(opts: { enabled?: boolean; allowed?: string[]; now?: () => number } = {}) {
    const { embed, state, gateCalls } = setup();
    if (opts.allowed) state.allowed = opts.allowed;
    const flag = { on: opts.enabled ?? true };
    state.enabled = flag.on;
    const sent: Sent[] = [];
    const source = {
      postMessage: (payload: Record<string, unknown>, targetOrigin: string) => void sent.push({ payload, targetOrigin }),
    } as unknown as Window;
    const detach = startEmbedBridge({
      enabled: true,
      origins: () => state.allowed,
      gate: async () => true,
      agent: { ...embed, enabled: () => flag.on },
      target: window,
    });
    const post = (data: unknown, origin = A): void => {
      const ev = new MessageEvent('message', { data, origin });
      Object.defineProperty(ev, 'source', { value: source, configurable: true });
      window.dispatchEvent(ev);
    };
    return { sent, post, flag, state, gateCalls, detach: () => detach?.() };
  }
  const rpc = (id: number, method: string, params?: unknown) => ({
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });

  it('tools/list は許可リストの origin に定義を返す。pkc.hello が申告する', async () => {
    const h = bridge();
    h.post(rpc(1, 'pkc.hello'));
    h.post(rpc(2, 'tools/list'));
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    const hello = h.sent.find((s) => s.payload.id === 1)!.payload.result as { methods: string[] };
    expect(hello.methods).toContain('tools/list');
    expect(hello.methods).toContain('tools/call');
    const list = h.sent.find((s) => s.payload.id === 2)!.payload.result as { tools: { name: string }[] };
    expect(list.tools).toHaveLength(5);
    h.detach();
  });

  it('🔴 tools/call は同じ門を通り、結果は MCP の形で返る', async () => {
    const h = bridge();
    h.post(rpc(3, 'tools/call', { name: 'pkc_search_notes', arguments: { query: '牛乳' } }));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const result = h.sent[0]!.payload.result as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ notes: [{ title: '買い物' }] });
    expect(h.gateCalls[0]).toMatchObject({ action: 'search', from: A });
    expect(h.sent[0]!.targetOrigin).toBe(A);
    h.detach();
  });

  it('🔴 許可リストに無い origin は、道具に触れる前に FORBIDDEN_ORIGIN', async () => {
    const h = bridge();
    h.post(rpc(4, 'tools/list'), 'https://evil.test');
    h.post(rpc(5, 'tools/call', { name: 'pkc_search_notes', arguments: { query: 'x' } }), 'https://evil.test');
    expect(h.sent).toHaveLength(2);
    for (const s of h.sent) expect(s.payload.error).toMatchObject({ code: RPC.FORBIDDEN_ORIGIN });
    expect(h.gateCalls).toEqual([]);
    h.detach();
  });

  it('🔴 `*` だけを許した窓口でも、AI の道具は使えない(名指しの origin だけ)', async () => {
    const h = bridge({ allowed: ['*'] });
    h.post(rpc(6, 'tools/list'), 'https://any.test');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.payload.error).toMatchObject({ code: RPC.FORBIDDEN_ORIGIN });
    h.detach();
  });

  it('🔴 flag オフなら申告せず、呼ばれても METHOD_NOT_FOUND', async () => {
    const h = bridge({ enabled: false });
    h.post(rpc(7, 'pkc.hello'));
    h.post(rpc(8, 'tools/call', { name: 'pkc_list_tags' }));
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    const hello = h.sent.find((s) => s.payload.id === 7)!.payload.result as { methods: string[] };
    expect(hello.methods).not.toContain('tools/list');
    expect(h.sent.find((s) => s.payload.id === 8)!.payload.error).toMatchObject({ code: RPC.METHOD_NOT_FOUND });
    expect(h.gateCalls).toEqual([]);
    h.detach();
  });

  it('🔴 大きすぎる封筒は TOO_BIG(道具を呼ばない)', () => {
    const h = bridge();
    h.post(rpc(9, 'tools/call', { name: 'pkc_create_note', arguments: { body: 'x'.repeat(MAX_ROUGH_SIZE + 1) } }));
    expect(h.sent[0]!.payload.error).toMatchObject({ code: RPC.TOO_BIG });
    expect(h.gateCalls).toEqual([]);
    h.detach();
  });

  it('🔴 1 分の上限を超えたら TOO_MANY(同じ窓口の上限が tools/* にも効く)', async () => {
    const h = bridge();
    for (let i = 0; i < MAX_PER_MINUTE + 1; i += 1) h.post(rpc(100 + i, 'tools/list'));
    await vi.waitFor(() => expect(h.sent.length).toBe(MAX_PER_MINUTE + 1));
    const last = h.sent.find((s) => (s.payload.error as { code?: number } | undefined)?.code === RPC.TOO_MANY);
    expect(last).toBeDefined();
    h.detach();
  });
});
