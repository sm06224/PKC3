/** @vitest-environment happy-dom */
/**
 * 🔴 **追記欄以外の経路で足したときも、足した所へ送る**(#2018 2。user 裁定 2026-11-22「他の追記経路も挙動を揃える」)。
 * AI の書き足し(`lastAgentAppend`)・予定や付箋の追記(`lastAppend`)── 開いているノートへの追記なら、足した塊へ送る。
 * ⚠ 開いていないノートへの追記では動かさない(読んでいる所を奪わない)。
 * 🔑 happy-dom に `scrollIntoView` は無いので塊に stub を植えて「送った」を数える(`navigate-link.test.ts` と同じ作法)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { PAINTED_ATTR } from '../../src/adapter/ui/render/detail';
import { AGENT_APPEND_BATCH } from '../../src/adapter/state/app-state';
import { vi } from 'vitest';
import { stubRevisionOps } from '../helpers/revision-stub';

const DOC = [
  '## 2026-11-20 09:00:00',
  '',
  '朝の記録',
  '',
  '### 2026-11-20 09:30:00',
  '',
  '追いログ',
  '',
  '###### 2026-11-20 09:40:00',
  '',
  '一番深い',
  '',
  '## 2026-11-21 10:00:00',
  '',
  '次の日',
  '',
].join('\n');

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'textlog',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

function setup(body = DOC, body2 = 'べつのノート\n') {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const box = new AppendBoxRenderer(buildShell(root).append);
  d.onState((s) => box.render(s));
  // 本文の面(描けている印つき)── 塊は原文の行の刻印を持ち、送られたかを数える
  const detail = document.createElement('div');
  detail.setAttribute('data-pkc-region', 'detail');
  const bodyHost = document.createElement('div');
  bodyHost.setAttribute('data-pkc-field', 'detail-body');
  bodyHost.setAttribute(PAINTED_ATTR, 'n1');
  const blocks: HTMLElement[] = [];
  for (const [line, tag] of [[0, 'h2'], [2, 'p'], [12, 'h2'], [14, 'p']] as const) {
    const el = document.createElement(tag);
    el.setAttribute('data-pkc-source-line', String(line));
    el.scrollIntoView = vi.fn();
    bodyHost.append(el);
    blocks.push(el);
  }
  detail.append(bodyHost);
  root.append(detail);
  bindActions(root, d);
  const persisted: EntryUpsert[] = [];
  const disk: Record<string, string> = { n1: body, n2: body2 };
  const failures: string[] = [];
  d.onState((s) => {
    if (s.error !== null && !failures.includes(s.error)) failures.push(s.error);
  });
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      persisted.push(e);
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
  const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  return { root, d, persisted, disk, failures, q, blocks };
}

async function open(s: ReturnType<typeof setup>): Promise<void> {
  s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  await tick();
}





const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe('#2018 2 追記欄以外の追記でも、足した所へ送る', () => {
  it('🔴 AI の書き足し(開いているノートの末尾)── 最後の塊へ送る', async () => {
    const s = setup();
    await open(s);
    s.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'n1', text: 'AI の字', heading: null, target: null, batch: AGENT_APPEND_BATCH });
    await settle();
    expect(s.failures).toEqual([]);
    expect(s.d.getState().lastAgentAppend?.lid, '前提: AI の書き足しが着いていない').toBe('n1');
    expect(s.blocks.at(-1)!.scrollIntoView, '足した所へ送っていない').toHaveBeenCalled();
    expect(s.blocks[0]!.scrollIntoView, '別の塊へ送った').not.toHaveBeenCalled();
  });

  it('🔴 手の追記(追記欄を通らない経路 = 予定・付箋と同じ `lastAppend`)でも送る', async () => {
    const s = setup();
    await open(s);
    s.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'n1', text: '付箋の字', heading: null, target: null });
    await settle();
    expect(s.d.getState().lastAppend?.lid).toBe('n1');
    expect(s.blocks.at(-1)!.scrollIntoView).toHaveBeenCalled();
  });

  it('⚠ 対照群: 開いていないノートへの追記では動かさない', async () => {
    const s = setup();
    await open(s);
    s.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'n2', text: 'よそ', heading: null, target: null, batch: AGENT_APPEND_BATCH });
    await settle();
    expect(s.d.getState().lastAgentAppend?.lid, '前提: 書き足しが着いていない').toBe('n2');
    for (const b of s.blocks) expect(b.scrollIntoView).not.toHaveBeenCalled();
  });
});
