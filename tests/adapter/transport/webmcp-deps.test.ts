/** @vitest-environment happy-dom */
/**
 * AI のツールが保存領域を読む配線(#1407)。`main.ts` から取り出した部分 ── `main.ts` は
 * どの test からも実行されないので、「どのノートを AI に見せるか」の判断はここで見る。
 *
 * 守る主張:
 * 1. 🔴 system 領域のノート(メッセージなど)は、`entryMetas`(本物の state の形)に載らないので
 *    検索に混ざっても返さず、ID を直に渡されても読ませない・本文も取りにいかない
 * 2. 呼ぶ op は既存の 3 つだけ(searchEntries / getBodies / queryScan)で、cid と上限を渡す
 * 3. `client` は呼ぶたびに引く(昇格で差し替わる)
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '@core/model/entry-meta';
import { Dispatcher } from '@adapter/state/dispatcher';
import { agentStoreDeps } from '@adapter/transport/webmcp-deps';
import { buildAgentTools } from '@adapter/transport/webmcp-tools';
import { TAGS_KEY } from '@features/query/group-by';

const meta = (lid: string, title: string): EntryMeta => ({
  lid,
  title,
  archetype: 'text',
  createdAt: null,
  updatedAt: '2026-10-07 09:00:00',
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: 0,
});

const SIGNAL = { signal: new AbortController().signal };

function setup() {
  // 本物の state: user 領域のノートだけが entryMetas に載る(system のメッセージは載らない ── §1.1)
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', '買い物'), meta('b', '会議')] as never,
    relations: [],
  });
  const requests: Array<Record<string, unknown>> = [];
  const bodiesInStore: Record<string, string> = {
    a: '牛乳を買う #家事',
    b: '議題は予算',
    'sys-message': 'メッセージの中身(これは AI に渡してはいけない)',
  };
  const client = {
    request: ((req: Record<string, unknown>) => {
      requests.push(req);
      switch (req.op) {
        case 'searchEntries':
          // 万一 system のノートが検索結果に混ざっても(防波堤)
          return Promise.resolve({ lids: ['sys-message', 'a'], truncated: false });
        case 'getBodies':
          return Promise.resolve(
            (req.lids as string[]).flatMap((lid) =>
              bodiesInStore[lid] === undefined ? [] : [{ lid, body: bodiesInStore[lid] }],
            ),
          );
        case 'queryScan':
          return Promise.resolve({
            keys: { keys: [], omittedKeys: 0, scanned: 0 },
            groups: { groups: [{ value: '家事', total: 2, lids: ['a'] }], omittedGroups: 3, scanned: 2 },
          });
        default:
          return Promise.reject(new Error(`想定外の op: ${String(req.op)}`));
      }
    }) as never,
  };
  const store = agentStoreDeps({
    entryMetas: () => d.getState().entryMetas,
    client: () => client,
    cid: 'c1',
  });
  const tools = buildAgentTools({
    ...store,
    createEntry: () => null,
    append: async () => ({ ok: true }),
    gate: async () => true,
  });
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  return { d, requests, tool, store };
}

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

describe('🔴 system 領域のノートは AI に渡らない(本物の state の形で)', () => {
  it('検索の結果に system の ID が混ざっても、返さない・本文も取りにいかない', async () => {
    const { tool, requests } = setup();
    const out = parse(await tool('pkc_search_notes').execute({ query: '買う' }, SIGNAL));
    expect(out.notes.map((n: { id: string }) => n.id)).toEqual(['a']);
    expect(JSON.stringify(out)).not.toContain('メッセージの中身');
    const bodiesReq = requests.find((r) => r.op === 'getBodies');
    expect(bodiesReq?.lids, 'system の ID の本文を取りにいった').toEqual(['a']);
  });

  it('ID を直に渡されても読ませない(getBody は領域を見ずに引けるので、見取りの有無が唯一の門)', async () => {
    const { tool, requests } = setup();
    const r = await tool('pkc_read_note').execute({ id: 'sys-message' }, SIGNAL);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toContain('メッセージの中身');
    expect(requests.filter((q) => q.op === 'getBodies')).toEqual([]);
    // 対照群: user 領域のノートは読める
    const ok = parse(await tool('pkc_read_note').execute({ id: 'b' }, SIGNAL));
    expect(ok).toMatchObject({ id: 'b', title: '会議', body: '議題は予算', updatedAt: '2026-10-07 09:00:00' });
  });

  it('見取りは state から呼ぶたびに引く(あとから増えたノートも見取りに載る)', () => {
    const { d, store } = setup();
    expect(store.meta('new')).toBeUndefined();
    d.dispatch({
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid: 'new',
      title: '新しい',
      body: 'x',
      edit: false,
      keepSelection: true,
    });
    expect(store.meta('new')).toMatchObject({ title: '新しい', archetype: 'text' });
    expect(store.meta('a')).toMatchObject({ title: '買い物', archetype: 'text' });
    expect(store.meta('sys-message')).toBeUndefined();
  });
});

describe('呼ぶ op と引数', () => {
  it('searchEntries に cid・query・limit、getBodies に cid・lids、queryScan に TAGS_KEY を渡す', async () => {
    const { store, requests } = setup();
    await store.search('買う', 7);
    await store.bodies(['a', 'b']);
    const tags = await store.tags();
    expect(requests).toEqual([
      { op: 'searchEntries', cid: 'c1', query: '買う', limit: 7 },
      { op: 'getBodies', cid: 'c1', lids: ['a', 'b'] },
      { op: 'queryScan', cid: 'c1', key: TAGS_KEY },
    ]);
    expect(tags).toEqual({ groups: [{ value: '家事', total: 2, lids: ['a'] }], omitted: 3 });
  });

  it('client は呼ぶたびに引く(メインのタブへ昇格して差し替わっても、新しい口を叩く)', async () => {
    const d = new Dispatcher();
    const used: string[] = [];
    let current = 'first';
    const mk = (name: string) => ({
      request: (() => {
        used.push(name);
        return Promise.resolve({ lids: [], truncated: false });
      }) as never,
    });
    const clients: Record<string, ReturnType<typeof mk>> = { first: mk('first'), second: mk('second') };
    const store = agentStoreDeps({
      entryMetas: () => d.getState().entryMetas,
      client: () => clients[current]!,
      cid: 'c',
    });
    await store.search('x', 1);
    current = 'second';
    await store.search('x', 1);
    expect(used).toEqual(['first', 'second']);
  });
});
