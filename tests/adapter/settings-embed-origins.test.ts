/** @vitest-environment happy-dom */
/**
 * 「埋め込み先のページの AI を許すページ」の一覧と、その追加・外す(#1407)。
 *
 * 守る主張:
 * 1. 🔴 追加すると保存(`pkc3.embed-origins`)に origin で載り、一覧に出て、結果が 1 行出る。後ろの付いたアドレスは origin に落ちる
 * 2. 🔴 断る入力は保存を 1 バイトも変えず、理由の 1 行が出る。重複も同じ
 * 3. 🔴 「一覧から外す」で保存から消え、他の行は残る
 * 4. 🔴 **門が、画面から足した origin を受け、外した後は受けない**(`createAgentEmbed` の `allowed` が保存を読む)
 * 5. 🔴 外したときは登録・飛んでいる依頼を畳む通知が出る(`onChange` の `remove`)
 * 6. 「許可」の節の中に並ぶ(新しい h3 を作らない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { EmbedOriginsStore } from '@adapter/transport/embed-origins';
import { AgentOriginGrants } from '@adapter/platform/agent-origin-grants';
import { createAgentEmbed } from '@adapter/transport/agent-embed';
import { buildAgentTools } from '@adapter/transport/webmcp-tools';
import { RPC } from '@adapter/transport/protocol';
import { createEmbedOriginsSection } from '@adapter/ui/render/settings/embed-origins';
import { FLAG_EMBED } from '@features/flags';
import { initialState } from '@adapter/state/app-state';
import { wireEmbedOrigins } from '@adapter/transport/embed-origins-wiring';
import type { ModelContextTool } from '@features/agent/webmcp-types';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const KEY = 'pkc3.embed-origins';
/** `embedOrigins` より前の引数の数(region の後ろ ── 末尾に足す決まり)。 */
const BEFORE_EMBED_ORIGINS = 24;

function setup(store: EmbedOriginsStore) {
  const region = document.createElement('div');
  document.body.append(region);
  const Ctor = SettingsRenderer as unknown as new (...args: unknown[]) => SettingsRenderer;
  const renderer = new Ctor(
    region,
    ...Array.from({ length: BEFORE_EMBED_ORIGINS }, () => undefined),
    store,
  );
  renderer.render(initialState);
  return { region, renderer };
}

const q = <T extends HTMLElement>(region: HTMLElement, field: string): T =>
  region.querySelector<T>(`[data-pkc-field="${field}"]`)!;
const names = (region: HTMLElement): string[] =>
  [...region.querySelectorAll('[data-pkc-field="embed-origin-name"]')].map((e) => e.textContent ?? '');

function enter(region: HTMLElement, value: string): void {
  q<HTMLInputElement>(region, 'embed-origin-input').value = value;
  q<HTMLButtonElement>(region, 'embed-origin-add').click();
}

describe('埋め込み先のページの AI を許すページ(#1407)', () => {
  let ls: ReturnType<typeof fakeStorage>;
  let store: EmbedOriginsStore;
  beforeEach(() => {
    document.body.innerHTML = '';
    ls = fakeStorage();
    store = new EmbedOriginsStore(ls as unknown as Storage);
  });

  it('0 件ならそう言う。節は「許可」の中で、h3 は増えない', () => {
    const { region } = setup(store);
    expect(q(region, 'embed-origin-list').textContent).toBe('まだ許したページはありません');
    const section = region.querySelector('[data-pkc-region="settings-permissions"]')!;
    expect(section.querySelector('[data-pkc-region="settings-embed-origins"]')).not.toBeNull();
    expect(section.querySelectorAll('h3')).toHaveLength(1);
  });

  it('🔴 追加: 保存に origin で載り、一覧に出て、結果が 1 行。入力欄は空に戻る', () => {
    const { region } = setup(store);
    enter(region, 'https://example.com/a/b');
    expect(JSON.parse(ls.map.get(KEY)!)).toEqual(['https://example.com']);
    expect(names(region)).toEqual(['https://example.com']);
    expect(q(region, 'embed-origin-result').textContent).toBe(
      'https://example.com として追加しました(アドレスの後ろは使いません)',
    );
    expect(q<HTMLInputElement>(region, 'embed-origin-input').value).toBe('');
  });

  it('Enter でも追加できる(IME の確定の Enter は追加しない)', () => {
    const { region } = setup(store);
    const input = q<HTMLInputElement>(region, 'embed-origin-input');
    input.value = 'https://a.test';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(store.list()).toEqual([]);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.list()).toEqual(['https://a.test']);
  });

  it.each([
    ['http://example.com', 'https:// で始まるアドレスだけ追加できます'],
    ['', 'アドレスを入れてください'],
    ['*', 'アドレスの形が正しくありません'],
    ['example.com', 'アドレスの形が正しくありません'],
  ])('🔴 断る %j: 保存は変わらず、理由が出る', (raw, reason) => {
    const { region } = setup(store);
    enter(region, 'https://keep.test');
    const before = ls.map.get(KEY);
    enter(region, raw);
    expect(ls.map.get(KEY)).toBe(before);
    expect(q(region, 'embed-origin-result').textContent).toContain(reason);
    expect(q(region, 'embed-origin-result').getAttribute('data-pkc-state')).toBe('error');
  });

  it('同じページをもう一度入れると、すでに入っていると言い、2 件にならない', () => {
    const { region } = setup(store);
    enter(region, 'https://a.test');
    enter(region, 'https://a.test/other');
    expect(q(region, 'embed-origin-result').textContent).toBe('https://a.test はすでに一覧に入っています');
    expect(store.list()).toEqual(['https://a.test']);
  });

  it('🔴 一覧から外す: 押した行だけが保存から消え、他は残る', () => {
    const { region } = setup(store);
    enter(region, 'https://a.test');
    enter(region, 'https://b.test');
    const rows = region.querySelectorAll<HTMLElement>('[data-pkc-embed-origin]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('button')!.textContent).toBe('一覧から外す');
    rows[0]!.querySelector('button')!.click();
    expect(store.list()).toEqual(['https://b.test']);
    expect(names(region)).toEqual(['https://b.test']);
    expect(q(region, 'embed-origin-result').textContent).toBe('https://a.test を一覧から外しました');
  });

  it('画面の外(開発者ツールなど)で書かれた物も、次の描画で並ぶ', () => {
    const { region, renderer } = setup(store);
    ls.map.set(KEY, JSON.stringify(['https://z.test']));
    renderer.render(initialState);
    expect(names(region)).toEqual(['https://z.test']);
  });

  it('origin は字として出る(HTML にならない)', () => {
    ls.map.set(KEY, JSON.stringify(['https://x.test/<img src=x onerror=1>']));
    const { region } = setup(store);
    expect(region.querySelector('[data-pkc-field="embed-origin-list"] img')).toBeNull();
  });
});

describe('🔴 門は画面から足した origin を受け、外した後は受けない', () => {
  function gate(store: EmbedOriginsStore) {
    const registered: { exposedTo: string[] | undefined; signal: AbortSignal | undefined }[] = [];
    const mc = {
      registerTool: (_t: ModelContextTool, o?: { signal?: AbortSignal; exposedTo?: string[] }) => {
        registered.push({ exposedTo: o?.exposedTo, signal: o?.signal });
        return Promise.resolve(undefined);
      },
    };
    const embed = createAgentEmbed({
      enabled: () => true,
      allowed: () => store.list(),
      granted: () => ['https://a.test'],
      host: { document: { modelContext: mc } },
      buildTools: (from) =>
        buildAgentTools({
          meta: () => undefined,
          search: async () => ({ ids: [], truncated: false }),
          bodies: async () => new Map(),
          tags: async () => ({ groups: [], omitted: 0 }),
          createEntry: () => 'x',
          append: async () => ({ ok: true }),
          appendCheck: () => 'ok',
          notifyAppended: () => undefined,
          gate: async () => true,
          from,
        }),
    });
    return { embed, registered };
  }

  it('追加前は断る → 画面から追加すると通る → 外すと断る', () => {
    document.body.innerHTML = '';
    const ls = fakeStorage();
    const store = new EmbedOriginsStore(ls as unknown as Storage);
    const { embed } = gate(store);
    const code = (): unknown => {
      try {
        embed.list('https://a.test');
        return 'ok';
      } catch (e) {
        return (e as { rpcCode?: number }).rpcCode;
      }
    };
    expect(code()).toBe(RPC.FORBIDDEN_ORIGIN);
    const { region } = setup(store);
    enter(region, 'https://a.test/path');
    expect(code()).toBe('ok');
    region.querySelector<HTMLButtonElement>('[data-pkc-field="embed-origin-remove"]')!.click();
    expect(code()).toBe(RPC.FORBIDDEN_ORIGIN);
  });

  it('🔴 配線(wireEmbedOrigins): 外すと登録の signal が畳まれ registered() が空になる。足すと登録される', () => {
    const store = new EmbedOriginsStore(fakeStorage() as unknown as Storage);
    const { embed, registered } = gate(store);
    wireEmbedOrigins(store, embed, new AgentOriginGrants(fakeStorage()), window);
    store.add('https://a.test');
    expect(registered.length).toBeGreaterThan(0);
    expect(registered[0]!.exposedTo).toEqual(['https://a.test']);
    expect(embed.registered()).toEqual(['https://a.test']);
    const signal = registered[0]!.signal!;
    expect(signal.aborted).toBe(false);
    store.remove('https://a.test');
    expect(signal.aborted).toBe(true);
    expect(embed.registered()).toEqual([]);
  });

  it('🔴 A3: 一覧から外すと「常に許す」も台帳から消える(入れ直しても聞き直す)。別の origin の許可は残る', () => {
    const store = new EmbedOriginsStore(fakeStorage() as unknown as Storage);
    const grants = new AgentOriginGrants(fakeStorage());
    const { embed } = gate(store);
    wireEmbedOrigins(store, embed, grants, window);
    store.add('https://a.test');
    store.add('https://b.test');
    grants.setAlways('https://a.test', 'read');
    grants.setAlways('https://a.test', 'write');
    grants.setAlways('https://b.test', 'read');
    store.remove('https://a.test');
    expect(grants.list().filter((r) => r.origin === 'https://a.test'), '外した origin の許可が残っている').toEqual([]);
    expect(grants.isAlways('https://b.test', 'read'), '外していない origin の許可まで消えた').toBe(true);
    store.add('https://a.test');
    expect(grants.isAlways('https://a.test', 'read'), '入れ直したら許可が復活した').toBe(false);
  });

  it('🔴 別のタブで外された(storage event。画面の onChange は鳴らない)ときも畳む。無関係な key では動かない', () => {
    const ls = fakeStorage();
    const store = new EmbedOriginsStore(ls as unknown as Storage);
    const { embed, registered } = gate(store);
    wireEmbedOrigins(store, embed, new AgentOriginGrants(fakeStorage()), window);
    store.add('https://a.test');
    expect(embed.registered()).toEqual(['https://a.test']);
    const signal = registered[0]!.signal!;
    ls.map.set('pkc3.embed-origins', '[]'); // 別のタブの書込(このタブの onChange は鳴らない)
    window.dispatchEvent(new StorageEvent('storage', { key: 'other.key' }));
    expect(signal.aborted, '無関係な key で畳んだ').toBe(false);
    window.dispatchEvent(new StorageEvent('storage', { key: 'pkc3.embed-origins' }));
    expect(signal.aborted).toBe(true);
    expect(embed.registered()).toEqual([]);
  });

  it('🔴 登録済みの道具は、一覧から外れた後は(sync を待たず)実行を断る ── 門(gate)に届かない', async () => {
    const store = new EmbedOriginsStore(fakeStorage() as unknown as Storage);
    const registeredTools: ModelContextTool[] = [];
    const gateCalls: unknown[] = [];
    const embed = createAgentEmbed({
      enabled: () => true,
      allowed: () => store.list(),
      granted: () => ['https://a.test'],
      host: {
        document: {
          modelContext: {
            registerTool: (t: ModelContextTool) => {
              registeredTools.push(t);
              return Promise.resolve(undefined);
            },
          },
        },
      },
      buildTools: (from) =>
        buildAgentTools({
          meta: () => undefined,
          search: async () => ({ ids: [], truncated: false }),
          bodies: async () => new Map(),
          tags: async () => ({ groups: [], omitted: 0 }),
          createEntry: () => 'x',
          append: async () => ({ ok: true }),
          appendCheck: () => 'ok',
          notifyAppended: () => undefined,
          gate: async (t) => {
            gateCalls.push(t);
            return true;
          },
          from,
        }),
    });
    store.add('https://a.test');
    embed.sync();
    const tool = registeredTools.find((t) => t.name === 'pkc_list_tags')!;
    const ac = new AbortController();
    const okRes = await tool.execute({}, { signal: ac.signal });
    expect(okRes.isError, '許可リストの中なのに断った(対照群)').toBeFalsy();
    expect(gateCalls.length).toBeGreaterThan(0);
    gateCalls.length = 0;
    store.remove('https://a.test'); // wire していない = sync も revoke も走らない
    const res = await tool.execute({}, { signal: ac.signal });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('一覧から外れています');
    expect(gateCalls, '外れた後に門へ届いた').toEqual([]);
  });

  it('onChange は add / remove で 1 回ずつ、重複や無い物の外しでは鳴らない', () => {
    const store = new EmbedOriginsStore(fakeStorage() as unknown as Storage);
    const fn = vi.fn();
    store.onChange(fn);
    store.add('https://a.test');
    store.add('https://a.test');
    store.remove('https://nope.test');
    store.remove('https://a.test');
    expect(fn.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'add', origin: 'https://a.test' },
      { kind: 'remove', origin: 'https://a.test' },
    ]);
  });
});

describe('🔴 保存できないとき・フラグがオフのとき・store の門(#1407 レビュー)', () => {
  const failing = (ls: ReturnType<typeof fakeStorage>): Storage =>
    ({
      ...ls,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    }) as unknown as Storage;

  it('書けなければ add は false・通知なし・一覧は空のまま', () => {
    const store = new EmbedOriginsStore(failing(fakeStorage()));
    const fn = vi.fn();
    store.onChange(fn);
    expect(store.add('https://a.test')).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it('書けなければ remove は false・通知なし(許したまま)', () => {
    const ls = fakeStorage();
    ls.map.set('pkc3.embed-origins', JSON.stringify(['https://a.test']));
    const store = new EmbedOriginsStore(failing(ls));
    const fn = vi.fn();
    store.onChange(fn);
    expect(store.remove('https://a.test')).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(store.list()).toEqual(['https://a.test']);
  });

  it('set 自身が書けたかを返す(成功 true / 例外 false / 保存領域なし false)', () => {
    expect(new EmbedOriginsStore(fakeStorage() as unknown as Storage).set(['https://a.test'])).toBe(true);
    expect(new EmbedOriginsStore(failing(fakeStorage())).set(['https://a.test'])).toBe(false);
    expect(new EmbedOriginsStore(null).set(['https://a.test'])).toBe(false);
  });

  it('🔴 外すと、WebMCP に登録していない(JSON-RPC だけの)相手の飛んでいる依頼も畳む(wiring の revoke)', async () => {
    const store = new EmbedOriginsStore(fakeStorage() as unknown as Storage);
    let sig: AbortSignal | undefined;
    const embed = createAgentEmbed({
      enabled: () => true,
      allowed: () => store.list(),
      granted: () => [], // 何も「常に許す」していない = WebMCP には登録されない
      host: {},
      buildTools: () => [
        {
          name: 't',
          description: 'd',
          inputSchema: { type: 'object' },
          execute: (_a, o) => {
            sig = o.signal;
            return Promise.resolve({ content: [] });
          },
        },
      ],
    });
    wireEmbedOrigins(store, embed, new AgentOriginGrants(fakeStorage()), window);
    store.add('https://a.test');
    await embed.call('https://a.test', 't', {});
    expect(sig?.aborted).toBe(false);
    expect(embed.registered()).toEqual([]);
    store.remove('https://a.test');
    expect(sig?.aborted, '外したのに飛んでいる依頼の signal が畳まれていない').toBe(true);
  });

  it('保存領域が無い(null)でも add は false', () => {
    expect(new EmbedOriginsStore(null).add('https://a.test')).toBe(false);
  });

  it('画面: 書けないとき追加も外すも「保存できませんでした」を出し、「追加しました」「外しました」とは言わない', () => {
    document.body.innerHTML = '';
    const ls = fakeStorage();
    ls.map.set('pkc3.embed-origins', JSON.stringify(['https://keep.test']));
    const store = new EmbedOriginsStore(failing(ls));
    const { region } = setup(store);
    enter(region, 'https://new.test');
    const text = (): string => q(region, 'embed-origin-result').textContent ?? '';
    expect(text()).toContain('保存できませんでした');
    expect(text()).not.toContain('追加しました');
    expect(names(region)).toEqual(['https://keep.test']);
    q<HTMLButtonElement>(region, 'embed-origin-remove').click();
    expect(text()).toContain('保存できませんでした');
    expect(text()).not.toContain('外しました');
    expect(names(region)).toEqual(['https://keep.test']);
  });

  it('store.add 自身が https / 手元の http 以外を断る(画面を通らなくても)', () => {
    const store = new EmbedOriginsStore(fakeStorage() as unknown as Storage);
    for (const bad of ['http://example.com', '*', 'null', 'ftp://a.test', 'https://u:p@a.test']) {
      expect(store.add(bad), bad).toBe(false);
    }
    expect(store.list()).toEqual([]);
    expect(store.add('http://localhost:5173/x')).toBe(true);
    expect(store.list()).toEqual(['http://localhost:5173']);
  });

  it('userinfo 付きは理由つきで断り、保存しない', () => {
    document.body.innerHTML = '';
    const store = new EmbedOriginsStore(fakeStorage() as unknown as Storage);
    const { region } = setup(store);
    enter(region, 'https://user:pw@example.com');
    expect(q(region, 'embed-origin-result').textContent).toContain('ユーザー名やパスワード');
    expect(store.list()).toEqual([]);
  });

  it('入れた字と違う origin で保存したときは「として」で言う(末尾の / だけでも)', () => {
    document.body.innerHTML = '';
    const store = new EmbedOriginsStore(fakeStorage() as unknown as Storage);
    const { region } = setup(store);
    enter(region, 'https://a.test/');
    expect(q(region, 'embed-origin-result').textContent).toBe('https://a.test として追加しました');
    enter(region, 'https://b.test');
    expect(q(region, 'embed-origin-result').textContent).toBe('https://b.test を追加しました');
  });

  it('フラグがオフなら使われない旨を出し、オンなら出さない(フラグ画面の字を引く)', () => {
    document.body.innerHTML = '';
    const store = new EmbedOriginsStore(fakeStorage() as unknown as Storage);
    let on = false;
    const sec = createEmbedOriginsSection(store, () => on);
    const el = sec.build() as HTMLElement;
    document.body.append(el);
    sec.sync(initialState);
    const line = el.querySelector<HTMLElement>('[data-pkc-field="embed-origin-flag-off"]')!;
    expect(line.hidden).toBe(false);
    expect(line.textContent).toContain(FLAG_EMBED.summary);
    expect(line.textContent).toContain('使われません');
    on = true;
    sec.sync(initialState);
    expect(line.hidden).toBe(true);
    expect(line.textContent).toBe('');
  });

  it('別のタブの書込(notifyExternal)で、開いている一覧が追いつく', () => {
    document.body.innerHTML = '';
    const ls = fakeStorage();
    const store = new EmbedOriginsStore(ls as unknown as Storage);
    const { region } = setup(store);
    ls.map.set('pkc3.embed-origins', JSON.stringify(['https://z.test']));
    store.notifyExternal();
    expect(names(region)).toEqual(['https://z.test']);
  });
});
