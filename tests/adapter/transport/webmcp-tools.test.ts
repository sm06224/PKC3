/**
 * ブラウザの AI(WebMCP)に渡す道具 5 本(#1407 段① / 段④)。
 *
 * 守る主張:
 * 1. 名前・注釈(読むだけ / 結果が残る)・入力の形
 * 2. 🔴 探す・読むは**本文を返す**(裁定「許可すれば渡す」)── 本文の行を消せば落ちる
 * 3. 🔴 許可が無ければ**何も読まず・何も作らず** `isError` で返す(例外は投げない)
 * 4. 🔴 作る道は `pkc.createEntry` と同じ検査(`parseCreateEntryParams`)・同じ `createEntry`
 * 5. system 領域の ID は読ませない(見取りに無い ID は「見つからない」)
 * 6. 入力が間違っていれば、許可を聞く前に断る
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_APPEND_FAILED_TEXT,
  AGENT_APPEND_TIMEOUT_TEXT,
  AGENT_CREATE_FAILED_TEXT,
  AGENT_ORIGIN_LABEL,
  AGENT_RATE_LIMIT_TEXT,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  buildAgentTools,
  type AgentToolDeps,
} from '@adapter/transport/webmcp-tools';
import { readFileSync } from 'node:fs';
import { FLAG_WEBMCP } from '@features/flags';
import { MAX_BODY, MAX_TITLE } from '@adapter/transport/create-entry-params';
import { MAX_PER_MINUTE } from '@adapter/transport/protocol';
import {
  AGENT_DENIED_TEXT,
  scopeOf,
  type AgentScope,
  type AgentTarget,
} from '@features/agent/agent-gate';
import type { ModelContextTool, ToolResult } from '@features/agent/webmcp-types';
import type { AppendOutcome } from '@adapter/state/append-settle';

const SIGNAL = { signal: new AbortController().signal };

interface Note {
  title: string;
  archetype: string;
  updatedAt: string | null;
  body: string;
}

const NOTES: Record<string, Note> = {
  a1: { title: '買い物', archetype: 'text', updatedAt: '2026-10-01 10:00:00', body: '牛乳を買う\n\n#家事 #買い物' },
  b2: { title: '会議メモ', archetype: 'text', updatedAt: null, body: '---\ntags: [仕事]\n---\n議題は予算' },
  // 書き足しの種類の門(#1407 段④)── 追記欄と同じく、ノートとログだけ
  log: { title: '作業ログ', archetype: 'textlog', updatedAt: null, body: '## 2026-10-01 10:00:00\n始めた' },
  att: { title: '見積.pdf', archetype: 'attachment', updatedAt: null, body: '説明' },
  dir: { title: '資料', archetype: 'folder', updatedAt: null, body: '' },
  todo: { title: '買う', archetype: 'todo', updatedAt: null, body: '' },
};

function setup(over: Partial<AgentToolDeps> = {}, allow: boolean | ((s: AgentScope) => boolean) = true) {
  const calls = {
    /** 聞かれた範囲(read / write)。 */
    gate: [] as AgentScope[],
    /** 聞かれた中身(何を)と、渡された signal。 */
    targets: [] as AgentTarget[],
    signals: [] as Array<AbortSignal | undefined>,
    search: [] as Array<[string, number]>,
    bodies: [] as string[][],
    tags: 0,
    create: [] as Array<[unknown, string, string]>,
    append: [] as Array<[string, string, string | null]>,
  };
  const deps: AgentToolDeps = {
    meta: (id) => {
      const n = NOTES[id];
      return n === undefined ? undefined : { title: n.title, archetype: n.archetype, updatedAt: n.updatedAt };
    },
    search: async (q, limit) => {
      calls.search.push([q, limit]);
      return { ids: ['a1', 'b2'], truncated: false };
    },
    bodies: async (ids) => {
      calls.bodies.push(ids);
      return new Map(ids.flatMap((id) => (NOTES[id] ? [[id, NOTES[id]!.body] as const] : [])));
    },
    tags: async () => {
      calls.tags++;
      return {
        groups: [
          { value: '家事', total: 3 },
          { value: '', total: 9 },
          { value: '仕事', total: 1 },
        ],
        omitted: 2,
      };
    },
    createEntry: (input, origin, via) => {
      calls.create.push([input, origin, via]);
      return 'lid-new' as string | null;
    },
    append: async (id, text, heading) => {
      calls.append.push([id, text, heading]);
      return { ok: true } as AppendOutcome;
    },
    gate: async (t, signal) => {
      calls.gate.push(scopeOf(t));
      calls.targets.push(t);
      calls.signals.push(signal);
      return typeof allow === 'function' ? allow(scopeOf(t)) : allow;
    },
    ...over,
  };
  const tools = buildAgentTools(deps);
  const tool = (name: string): ModelContextTool => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`道具が無い: ${name}`);
    return t;
  };
  return { calls, tools, tool };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: ToolResult): any => JSON.parse(r.content[0]!.text);

describe('道具の一覧', () => {
  it('5 本・名前は snake_case・注釈は「読むだけ」3 本 + 「結果が残る」2 本', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual([
      'pkc_search_notes',
      'pkc_read_note',
      'pkc_list_tags',
      'pkc_create_note',
      'pkc_append_note',
    ]);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)+$/);
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe('object');
    }
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(by.pkc_search_notes).toMatchObject({ readOnlyHint: true, untrustedContentHint: true });
    expect(by.pkc_read_note).toMatchObject({ readOnlyHint: true, untrustedContentHint: true });
    expect(by.pkc_list_tags).toMatchObject({ readOnlyHint: true });
    expect(by.pkc_create_note).toMatchObject({ consequentialHint: true });
    expect(by.pkc_create_note).not.toHaveProperty('readOnlyHint');
    expect(by.pkc_append_note).toMatchObject({ consequentialHint: true });
    expect(by.pkc_append_note).not.toHaveProperty('readOnlyHint');
  });

  it('必須の入力: search は query / read は id / create は body', () => {
    const { tool } = setup();
    expect(tool('pkc_search_notes').inputSchema.required).toEqual(['query']);
    expect(tool('pkc_read_note').inputSchema.required).toEqual(['id']);
    expect(tool('pkc_create_note').inputSchema.required).toEqual(['body']);
    expect(tool('pkc_append_note').inputSchema.required).toEqual(['id', 'text']);
  });
});

describe('pkc_search_notes', () => {
  it('🔴 見つかったノートを本文つきで返す(id / title / kind / updatedAt / tags / body)', async () => {
    const { tool, calls } = setup();
    const r = await tool('pkc_search_notes').execute({ query: '買う' }, SIGNAL);
    expect(r.isError).toBeUndefined();
    const out = json(r);
    expect(out.truncated).toBe(false);
    expect(out.notes).toHaveLength(2);
    expect(out.notes[0]).toEqual({
      id: 'a1',
      title: '買い物',
      kind: 'text',
      updatedAt: '2026-10-01 10:00:00',
      tags: ['家事', '買い物'],
      // ⚠ 本文を返す行を消す変異がここで落ちる
      body: '牛乳を買う\n\n#家事 #買い物',
    });
    expect(out.notes[1].body).toBe('---\ntags: [仕事]\n---\n議題は予算');
    expect(out.notes[1].tags).toEqual(['仕事']);
    // 許可は read の 1 回
    expect(calls.gate).toEqual(['read']);
  });

  it('件数: 既定 10 / 上限 50 / 下限 1 / 小数は切り捨て', async () => {
    const { tool, calls } = setup();
    const t = tool('pkc_search_notes');
    await t.execute({ query: 'x' }, SIGNAL);
    await t.execute({ query: 'x', limit: 500 }, SIGNAL);
    await t.execute({ query: 'x', limit: 0 }, SIGNAL);
    await t.execute({ query: 'x', limit: 7.9 }, SIGNAL);
    expect(calls.search.map((c) => c[1])).toEqual([SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, 1, 7]);
    expect(SEARCH_DEFAULT_LIMIT).toBe(10);
    expect(SEARCH_MAX_LIMIT).toBe(50);
  });

  it('切ったときは truncated: true で言う(黙って切らない)', async () => {
    const { tool } = setup({ search: async () => ({ ids: ['a1'], truncated: true }) });
    expect(json(await tool('pkc_search_notes').execute({ query: 'x' }, SIGNAL)).truncated).toBe(true);
  });

  it('🔴 見取りに無い ID(system 領域)が検索に混ざっても返さない・本文も取りにいかない', async () => {
    const { tool, calls } = setup({
      search: async () => ({ ids: ['sys-message', 'a1'], truncated: false }),
    });
    const out = json(await tool('pkc_search_notes').execute({ query: 'x' }, SIGNAL));
    expect(out.notes.map((n: { id: string }) => n.id)).toEqual(['a1']);
    expect(calls.bodies).toEqual([['a1']]);
  });

  it('本文が上限(MAX_BODY)を超えたら切って bodyTruncated で言う', async () => {
    const long = 'あ'.repeat(MAX_BODY + 5);
    const { tool } = setup({
      bodies: async (ids) => new Map(ids.map((id) => [id, long] as const)),
      search: async () => ({ ids: ['a1'], truncated: false }),
    });
    const n = json(await tool('pkc_search_notes').execute({ query: 'x' }, SIGNAL)).notes[0];
    expect(n.body).toHaveLength(MAX_BODY);
    expect(n.bodyTruncated).toBe(true);
    // 対照群: 切らなかったノートには印を付けない
    const { tool: t2 } = setup();
    expect(json(await t2('pkc_search_notes').execute({ query: 'x' }, SIGNAL)).notes[0]).not.toHaveProperty(
      'bodyTruncated',
    );
  });

  it('入力が間違っていれば、許可を聞く前に断る(query が空 / limit が数でない)', async () => {
    const { tool, calls } = setup();
    for (const input of [{}, { query: '' }, { query: '  ' }, { query: 3 }, { query: 'x', limit: 'many' }]) {
      const r = await tool('pkc_search_notes').execute(input, SIGNAL);
      expect(r.isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls.gate).toEqual([]);
    expect(calls.search).toEqual([]);
  });
});

describe('pkc_read_note', () => {
  it('🔴 ID で 1 件を本文つきで返す', async () => {
    const { tool, calls } = setup();
    const r = await tool('pkc_read_note').execute({ id: 'b2' }, SIGNAL);
    expect(json(r)).toEqual({
      id: 'b2',
      title: '会議メモ',
      kind: 'text',
      updatedAt: null,
      tags: ['仕事'],
      body: '---\ntags: [仕事]\n---\n議題は予算',
    });
    expect(calls.gate).toEqual(['read']);
  });

  it('🔴 見取りに無い ID(system 領域のノート・存在しない ID)は読ませない。本文も取りにいかない', async () => {
    const { tool, calls } = setup();
    const r = await tool('pkc_read_note').execute({ id: 'sys-message' }, SIGNAL);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('見つかりません');
    expect(calls.bodies).toEqual([]);
  });

  it('見取りは在るのに本文が無い(消えた直後)も「見つかりません」', async () => {
    const { tool } = setup({ bodies: async () => new Map() });
    const r = await tool('pkc_read_note').execute({ id: 'a1' }, SIGNAL);
    expect(r.isError).toBe(true);
  });

  it('id が空・文字列でないときは、許可を聞く前に断る', async () => {
    const { tool, calls } = setup();
    for (const input of [{}, { id: '' }, { id: 1 }]) {
      expect((await tool('pkc_read_note').execute(input, SIGNAL)).isError).toBe(true);
    }
    expect(calls.gate).toEqual([]);
  });
});

describe('pkc_list_tags', () => {
  it('タグと件数を返す。「タグが無いノート」の組(空の値)は含めない。省いた組の数も言う', async () => {
    const { tool, calls } = setup();
    const out = json(await tool('pkc_list_tags').execute({}, SIGNAL));
    expect(out).toEqual({
      tags: [
        { name: '家事', count: 3 },
        { name: '仕事', count: 1 },
      ],
      omitted: 2,
    });
    expect(calls.gate).toEqual(['read']);
  });
});

describe('pkc_create_note', () => {
  it('🔴 `pkc.createEntry` と同じ関数を通る(検査済みの入力・出どころ・via)', async () => {
    const { tool, calls } = setup();
    const r = await tool('pkc_create_note').execute({ title: '  AI のメモ\n', body: '本文です' }, SIGNAL);
    expect(r.isError).toBeUndefined();
    expect(json(r)).toEqual({ id: 'lid-new', title: 'AI のメモ' });
    expect(calls.create).toEqual([[{ title: 'AI のメモ', body: '本文です' }, AGENT_ORIGIN_LABEL, 'origin']]);
    expect(calls.gate).toEqual(['write']);
  });

  it('題名を省くと本文の最初の行から作る(C-4 と同じ)', async () => {
    const { tool, calls } = setup();
    await tool('pkc_create_note').execute({ body: '# 見出しの題名\n\n中身' }, SIGNAL);
    expect((calls.create[0]![0] as { title: string }).title).toBe('見出しの題名');
  });

  it('🔴 検査は C-4 と同じ上限: 本文が MAX_BODY 超 / 題名は MAX_TITLE で切る', async () => {
    const { tool, calls } = setup();
    const over = await tool('pkc_create_note').execute({ body: 'a'.repeat(MAX_BODY + 1) }, SIGNAL);
    expect(over.isError).toBe(true);
    expect(calls.create).toEqual([]);
    expect(calls.gate, '断る入力で許可を聞いてはいけない').toEqual([]);
    await tool('pkc_create_note').execute({ title: 't'.repeat(MAX_TITLE + 50), body: 'x' }, SIGNAL);
    expect((calls.create[0]![0] as { title: string }).title).toHaveLength(MAX_TITLE);
  });

  it('body が文字列でなければ断る(省略もだめ ── 空のノートを黙って作らない)', async () => {
    const { tool, calls } = setup();
    for (const input of [{}, { body: 1 }, { title: 'x' }]) {
      expect((await tool('pkc_create_note').execute(input, SIGNAL)).isError).toBe(true);
    }
    expect(calls.create).toEqual([]);
  });

  it('createEntry が非同期でも待って id を返す', async () => {
    const { tool } = setup({ createEntry: async () => 'lid-async' });
    expect(json(await tool('pkc_create_note').execute({ body: 'x' }, SIGNAL)).id).toBe('lid-async');
  });
});

describe('🔴 許可が無ければ、何も読まず・何も作らず isError で返す', () => {
  const INPUTS: Record<string, Record<string, unknown>> = {
    pkc_search_notes: { query: '買う' },
    pkc_read_note: { id: 'a1' },
    pkc_list_tags: {},
    pkc_create_note: { body: 'x' },
    pkc_append_note: { id: 'a1', text: '続き' },
  };

  it.each(Object.keys(INPUTS))('%s', async (name) => {
    const { tool, calls } = setup({}, false);
    const r = await tool(name).execute(INPUTS[name]!, SIGNAL);
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: AGENT_DENIED_TEXT }]);
    expect(calls.search).toEqual([]);
    expect(calls.bodies).toEqual([]);
    expect(calls.tags).toBe(0);
    expect(calls.create).toEqual([]);
    expect(calls.append).toEqual([]);
  });

  it('範囲: 読む 3 本は read、作るは write、書き足すは append で聞く(read だけ許しても書けない)', async () => {
    const { tool, calls } = setup({}, (s) => s === 'read');
    await tool('pkc_search_notes').execute({ query: 'x' }, SIGNAL);
    await tool('pkc_read_note').execute({ id: 'a1' }, SIGNAL);
    await tool('pkc_list_tags').execute({}, SIGNAL);
    const made = await tool('pkc_create_note').execute({ body: 'x' }, SIGNAL);
    const added = await tool('pkc_append_note').execute({ id: 'a1', text: 'x' }, SIGNAL);
    expect(calls.gate).toEqual(['read', 'read', 'read', 'write', 'append']);
    expect(made.isError).toBe(true);
    expect(added.isError).toBe(true);
    expect(calls.create).toEqual([]);
    expect(calls.append).toEqual([]);
  });
});

describe('spy: 門を呼び忘れる配線を許さない', () => {
  it('gate は execute のたびに 1 回呼ばれる(キャッシュしない ── 「今回だけ」を 2 回目も聞くため)', async () => {
    const gate = vi.fn(async () => true);
    const { tool } = setup({ gate });
    await tool('pkc_list_tags').execute({}, SIGNAL);
    await tool('pkc_list_tags').execute({}, SIGNAL);
    expect(gate).toHaveBeenCalledTimes(2);
  });
});

describe('🔴 許可のダイアログに「何を」を渡す', () => {
  it('探す: 探す語 / 読む: 題名 / タグ: 何も / 作る: 検査後の題名(省いたときは本文の 1 行目)', async () => {
    const { tool, calls } = setup();
    await tool('pkc_search_notes').execute({ query: '  買い物  ' }, SIGNAL);
    await tool('pkc_read_note').execute({ id: 'b2' }, SIGNAL);
    await tool('pkc_list_tags').execute({}, SIGNAL);
    await tool('pkc_create_note').execute({ body: '# 見出しの題名\n\n中身' }, SIGNAL);
    expect(calls.targets).toEqual([
      { action: 'search', query: '買い物' },
      { action: 'read', title: '会議メモ' },
      { action: 'tags' },
      { action: 'create', title: '見出しの題名' },
    ]);
  });

  it('🔴 AI が取り消せるよう、execute の signal を門へ渡す', async () => {
    const { tool, calls } = setup();
    const ac = new AbortController();
    await tool('pkc_list_tags').execute({}, { signal: ac.signal });
    await tool('pkc_search_notes').execute({ query: 'x' }, { signal: ac.signal });
    expect(calls.signals).toEqual([ac.signal, ac.signal]);
  });

  it('見取りに無い ID を読もうとしたときは、題名が無いので許可も聞かない(読めないノートの題名を出さない)', async () => {
    const { tool, calls } = setup();
    const r = await tool('pkc_read_note').execute({ id: 'sys-message' }, SIGNAL);
    expect(r.isError).toBe(true);
    expect(calls.targets).toEqual([]);
  });
});

describe('🔴 作れなかったとき成功を返さない', () => {
  it('createEntry が null を返したら isError(AI が「作った」と言わない)', async () => {
    const { tool } = setup({ createEntry: () => null });
    const r = await tool('pkc_create_note').execute({ body: 'x' }, SIGNAL);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(AGENT_CREATE_FAILED_TEXT);
    expect(AGENT_CREATE_FAILED_TEXT).toBe('いま作れませんでした。PKC3 で編集中の可能性があります');
    // 非同期で null でも同じ
    const { tool: t2 } = setup({ createEntry: async () => null });
    expect((await t2('pkc_create_note').execute({ body: 'x' }, SIGNAL)).isError).toBe(true);
  });
});

describe('🔴 呼び出しの回数の上限(AI の道具は message-bridge を通らないので、ここで数える)', () => {
  it('1 分に MAX_PER_MINUTE 回まで。超えたら許可も聞かず断る。窓が明けたらまた通る', async () => {
    let t = 1_000_000;
    const { tool, calls } = setup({ now: () => t });
    expect(MAX_PER_MINUTE).toBe(120);
    for (let i = 0; i < MAX_PER_MINUTE; i += 1) {
      const r = await tool('pkc_list_tags').execute({}, SIGNAL);
      expect(r.isError, `${String(i + 1)} 回目で断られた`).toBeUndefined();
    }
    expect(calls.gate).toHaveLength(MAX_PER_MINUTE);
    const over = await tool('pkc_list_tags').execute({}, SIGNAL);
    expect(over.isError).toBe(true);
    expect(over.content[0]!.text).toBe(AGENT_RATE_LIMIT_TEXT);
    expect(AGENT_RATE_LIMIT_TEXT).toBe('呼び出しが多すぎます。1 分ほど待ってください');
    expect(calls.gate, '上限を超えた呼び出しで許可を聞いた').toHaveLength(MAX_PER_MINUTE);
    // 4 本で 1 つの窓を数える
    const other = await tool('pkc_search_notes').execute({ query: 'x' }, SIGNAL);
    expect(other.content[0]!.text).toBe(AGENT_RATE_LIMIT_TEXT);
    // 59 秒ではまだ、60 秒で明ける
    t += 59_000;
    expect((await tool('pkc_list_tags').execute({}, SIGNAL)).isError).toBe(true);
    t += 1_000;
    expect((await tool('pkc_list_tags').execute({}, SIGNAL)).isError).toBeUndefined();
  });

  it('入力が間違っている呼び出しも数える(暴走した AI が空の呼び出しで回数を逃れない)', async () => {
    const { tool } = setup({ now: () => 5 });
    for (let i = 0; i < MAX_PER_MINUTE; i += 1) await tool('pkc_search_notes').execute({}, SIGNAL);
    const r = await tool('pkc_list_tags').execute({}, SIGNAL);
    expect(r.content[0]!.text).toBe(AGENT_RATE_LIMIT_TEXT);
  });
});

describe('画面・マニュアルの字が実装と食い違わない', () => {
  const manual = readFileSync('docs/manual.md', 'utf8');
  it('マニュアルの回数の上限は MAX_PER_MINUTE と同じ数', () => {
    expect(manual).toContain(`1 分に ${String(MAX_PER_MINUTE)} 回まで`);
  });
  it('フラグの説明は、探す・読むを許すと本文が AI の提供元へ送られると先に言う', () => {
    expect(FLAG_WEBMCP.summary).toContain('探す・読むを許すと、当たったノートの本文が AI の提供元へ送られます');
    expect(FLAG_WEBMCP.summary).toContain('ブラウザに付いている AI がページの機能を呼ぶための仕様');
    expect(FLAG_WEBMCP.summary).not.toContain('道具');
  });
  it('マニュアルはメインのタブだけで使えること・前面にしておくことを 1 行ずつ言う', () => {
    expect(manual).toContain('使えるのはメインのタブだけ');
    expect(manual).toContain('PKC3 のタブを手前に出しておいてください');
    expect(manual).toContain('最初にフォーカスが当たっているのもこのボタンです');
  });
});

describe('pkc_append_note(#1407 段④)', () => {
  it('🔴 見取りの在る ID へ、渡された字をそのまま書き足し、id と題名を返す', async () => {
    const { tool, calls } = setup();
    const r = await tool('pkc_append_note').execute({ id: 'b2', text: '## 追加\n\n決まったこと' }, SIGNAL);
    expect(r.isError).toBeUndefined();
    expect(json(r)).toEqual({ id: 'b2', title: '会議メモ' });
    expect(calls.append).toEqual([['b2', '## 追加\n\n決まったこと', null]]);
    expect(calls.targets).toEqual([{ action: 'append', title: '会議メモ' }]);
  });

  it('🔴 見取りに無い ID(system 領域・存在しない)へは書かせない。許可も聞かない', async () => {
    const { tool, calls } = setup();
    const r = await tool('pkc_append_note').execute({ id: 'sys-message', text: 'x' }, SIGNAL);
    expect(r.isError).toBe(true);
    expect(calls.targets).toEqual([]);
    expect(calls.append).toEqual([]);
  });

  it('入力が間違っていれば、許可を聞く前に断る(id 空 / text 空・空白だけ・文字列でない / 上限超え)', async () => {
    const { tool, calls } = setup();
    for (const input of [
      { id: '', text: 'x' },
      { id: 'a1' },
      { id: 'a1', text: '   \n ' },
      { id: 'a1', text: 3 },
      { id: 'a1', text: 'a'.repeat(MAX_BODY + 1) },
    ]) {
      expect((await tool('pkc_append_note').execute(input, SIGNAL)).isError, JSON.stringify(input).slice(0, 40)).toBe(true);
    }
    expect(calls.targets).toEqual([]);
    expect(calls.append).toEqual([]);
    // 上限ちょうどは通る
    expect((await tool('pkc_append_note').execute({ id: 'a1', text: 'a'.repeat(MAX_BODY) }, SIGNAL)).isError).toBeUndefined();
  });

  it('🔴 書けなかったときに成功を返さない ── 断られた理由 / 保存の失敗 / 着いたか分からない', async () => {
    const refused = setup({ append: async () => ({ ok: false, reason: 'refused', error: '編集中のノートには追記できません' }) });
    const r1 = await refused.tool('pkc_append_note').execute({ id: 'a1', text: 'x' }, SIGNAL);
    expect(r1.isError).toBe(true);
    expect(r1.content[0]!.text).toBe('編集中のノートには追記できません');

    const silent = setup({ append: async () => ({ ok: false, reason: 'failed', error: null }) });
    const r2 = await silent.tool('pkc_append_note').execute({ id: 'a1', text: 'x' }, SIGNAL);
    expect(r2.isError).toBe(true);
    expect(r2.content[0]!.text).toBe(AGENT_APPEND_FAILED_TEXT);

    const lost = setup({ append: async () => ({ ok: false, reason: 'timeout', error: null }) });
    const r3 = await lost.tool('pkc_append_note').execute({ id: 'a1', text: 'x' }, SIGNAL);
    expect(r3.isError).toBe(true);
    // ⚠ 「書けなかった」とは言い切らず、もう一度送らせない(二重に足さない)
    expect(r3.content[0]!.text).toBe(AGENT_APPEND_TIMEOUT_TEXT);
    expect(AGENT_APPEND_TIMEOUT_TEXT).toContain('もう一度送らず');
  });
});

describe('pkc_append_note ── 追記欄と同じ門(#1407 段④ レビュー)', () => {
  it('🔴 添付・フォルダ・todo には書き足さない(許可も聞かない)。断り文はどれなら書けるかを言う', async () => {
    for (const id of ['att', 'dir', 'todo']) {
      const { tool, calls } = setup();
      const r = await tool('pkc_append_note').execute({ id, text: 'x' }, SIGNAL);
      expect(r.isError, id).toBe(true);
      expect(r.content[0]!.text, id).toContain('ノートとログ');
      expect(calls.targets, `${id}: 書けないのに許可を聞いた`).toEqual([]);
      expect(calls.append, `${id}: 書けない種類へ書き足した`).toEqual([]);
    }
  });

  it('🔴 ログには日時の節の見出しを付けて足す(付けないと前の節に溶け込む)。ノートには付けない', async () => {
    const t = Date.UTC(2026, 9, 10, 3, 4, 5);
    const { tool, calls } = setup({ now: () => t });
    await tool('pkc_append_note').execute({ id: 'log', text: '終えた' }, SIGNAL);
    await tool('pkc_append_note').execute({ id: 'a1', text: '続き' }, SIGNAL);
    expect(calls.append[0]![0]).toBe('log');
    expect(calls.append[0]![2], 'ログに見出しが付いていない').toMatch(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
    expect(calls.append[1]![2], 'ノートに見出しを勝手に足した').toBeNull();
  });

  it('改行は LF にそろえ、NUL は落とす(追記欄の入力欄がしていることを AI の字にも)', async () => {
    const { tool, calls } = setup();
    await tool('pkc_append_note').execute({ id: 'a1', text: '一\r\n二\r三\u0000四' }, SIGNAL);
    expect(calls.append[0]![1]).toBe('一\n二\n三四');
  });

  it.each(['pkc_search_notes', 'pkc_read_note', 'pkc_list_tags', 'pkc_create_note', 'pkc_append_note'])(
    '%s も 1 分の回数の上限で断る(書く道具も逃れない)',
    async (name) => {
      const { tool, calls } = setup({ now: () => 7 });
      for (let i = 0; i < MAX_PER_MINUTE; i += 1) await tool('pkc_list_tags').execute({}, SIGNAL);
      const before = calls.targets.length;
      const input: Record<string, unknown> = {
        pkc_search_notes: { query: 'x' },
        pkc_read_note: { id: 'a1' },
        pkc_list_tags: {},
        pkc_create_note: { body: 'x' },
        pkc_append_note: { id: 'a1', text: 'x' },
      }[name]!;
      const r = await tool(name).execute(input, SIGNAL);
      expect(r.content[0]!.text).toBe(AGENT_RATE_LIMIT_TEXT);
      expect(calls.targets.length, '上限を超えたのに許可を聞いた').toBe(before);
      expect(calls.append).toEqual([]);
      expect(calls.create).toEqual([]);
    },
  );
});
