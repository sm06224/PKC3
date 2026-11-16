/** @vitest-environment happy-dom */
/**
 * 🔴 **開いているノートをアプリで開く**(#1966 3-3。🟣 Gemini の裁定 = 案 B)。
 *
 * - 右の列の「アプリで開く ▾」と「操作を探す」から「差分マージで履歴と比べる」「SQL で開く」を呼べる
 * - 「SQL で開く」は表データの添付のときだけ出る(判定は SQL の選び所と同じ 1 本)
 * - 差分マージは、左に 1 つ前の版、右にいまのノートを入れて開く
 * - 🔴 取り込みの途中経過がある差分マージを、黙って置き換えない(user 指示 2026-11-16)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import {
  appOpenPlan,
  bindActions,
  DIFF_WITH_HISTORY_LABEL,
  OPEN_IN_SQL_LABEL,
  runGlobalCommand,
} from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { diffSession } from '../../src/adapter/ui/render/diffmerge';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { KEY_COMMANDS } from '../../src/features/keymap';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, title: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}
const METAS = [meta('n1', 'メモ'), meta('n2', '別のメモ'), meta('c1', '売上.csv', 'attachment')];
const NOW = '序\nいまの字\n末\n';
const OLD = '序\n前の字\n末\n';

function setup(opts: { confirm?: boolean; revs?: boolean } = {}) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const center = new CenterRouter(root);
  d.onState((s) => center.render(s));
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    getBody: async () => NOW,
  });
  const asked: number[] = [];
  const keymap = new KeymapStore();
  bindActions(
    root,
    d,
    {
      readBodies: async (lids: readonly string[]) =>
        new Map(lids.map((l) => [l, l === 'n2' ? 'まったく別\n' : NOW] as const)),
      diffListRevisions: async () =>
        opts.revs === false
          ? []
          : [
              { id: 'r-old', revOrder: 1, createdAt: null, title: null },
              { id: 'r-prev', revOrder: 2, createdAt: null, title: null },
            ],
      diffReadRevision: async (id: string) => (id === 'r-prev' ? OLD : 'もっと前\n'),
      ...(opts.confirm === undefined
        ? {}
        : {
            confirmDiscardMerge: async () => {
              asked.push(1);
              return opts.confirm!;
            },
          }),
    },
    keymap,
  );
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  const pane = root.querySelector<HTMLElement>('[data-pkc-view-pane="diff"]')!;
  const press = (action: string, lid: string): void => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', action);
    b.setAttribute('data-pkc-entry', lid);
    root.append(b);
    b.click();
  };
  return { root, d, pane, asked, press, keymap };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('判定(appOpenPlan ── 2 つの口の 1 本)', () => {
  const booted = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] }).state;
  it('🔴 差分マージはノートなら何でも / SQL は表データの添付だけ', () => {
    expect(appOpenPlan(booted, 'n1', 'diff')).toEqual({ lid: 'n1' });
    expect('why' in appOpenPlan(booted, 'n1', 'sql')).toBe(true);
    expect(appOpenPlan(booted, 'c1', 'sql')).toEqual({ lid: 'c1', source: { lid: 'c1', name: '売上.csv' } });
  });
  it('⚠ ノートを開いていない / 編集中は理由を言う', () => {
    expect(appOpenPlan(booted, null, 'diff')).toEqual({ why: 'ノートを開いてから呼んでください' });
    const editing = { ...booted, phase: 'editing' as const };
    expect((appOpenPlan(editing, 'n1', 'diff') as { why: string }).why).toContain('いまはアプリで開けません');
  });
  it('🔑 「操作を探す」の名前は、一覧の項目の字と同じ', () => {
    expect(KEY_COMMANDS.find((c) => c.id === 'diff-with-history')?.label).toBe(DIFF_WITH_HISTORY_LABEL);
    expect(KEY_COMMANDS.find((c) => c.id === 'open-in-sql')?.label).toBe(OPEN_IN_SQL_LABEL);
  });
});

describe('右の列の「アプリで開く ▾」', () => {
  it('🔴 ボタンが出て、押すと一覧が開く。SQL で開くは表データの添付のときだけ', () => {
    for (const [lid, sql] of [
      ['n1', false],
      ['c1', true],
    ] as const) {
      const { root, d } = setup();
      d.dispatch({ type: 'SELECT_ENTRY', lid });
      const region = document.createElement('div');
      root.append(region);
      new InspectorRenderer(region).render(d.getState());
      const btn = region.querySelector<HTMLButtonElement>('[data-pkc-action="open-app-menu"]')!;
      expect(btn, '「アプリで開く ▾」が無い').not.toBeNull();
      expect(btn.textContent).toContain('アプリで開く');
      expect(btn.getAttribute('data-pkc-entry')).toBe(lid);
      btn.click();
      const menu = root.querySelector('[data-pkc-region="context-menu"]')!;
      const acts = [...menu.querySelectorAll('[data-pkc-action]')].map((b) => b.getAttribute('data-pkc-action'));
      expect(acts).toContain('diff-with-history');
      expect(acts.includes('open-in-sql'), `${lid} の「SQL で開く」の出る / 出ない`).toBe(sql);
    }
  });

  it('⚠ 編集中は押せない', () => {
    let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'n1', body: NOW }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;
    const region = document.createElement('div');
    document.body.append(region);
    new InspectorRenderer(region).render(s);
    expect(region.querySelector<HTMLButtonElement>('[data-pkc-action="open-app-menu"]')!.disabled).toBe(true);
  });
});

describe('差分マージで履歴と比べる', () => {
  it('🔴 左に 1 つ前の版、右にいまのノートを入れて差分マージを開く', async () => {
    const { d, pane, press } = setup();
    press('diff-with-history', 'n1');
    await tick();
    expect(d.getState().viewMode).toBe('diff');
    const s = diffSession(pane);
    expect([s.left.kind, s.left.lid, s.left.revId], '左が 1 つ前の版でない').toEqual(['rev', 'n1', 'r-prev']);
    expect([s.right.kind, s.right.lid]).toEqual(['note', 'n1']);
    expect(s.left.text).toBe(OLD);
    expect(s.right.text).toBe(NOW);
  });

  it('⚠ 版がまだ無いノートは、左の一言でそう言う', async () => {
    const { pane, press } = setup({ revs: false });
    press('diff-with-history', 'n1');
    await tick();
    expect(diffSession(pane).left.note).toContain('比べる履歴の版がまだありません');
  });

  async function withTaken(confirm: boolean) {
    const t = setup({ confirm });
    t.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'diff' });
    const pick = (side: 'left' | 'right', value: string): void => {
      const el = t.pane.querySelector<HTMLSelectElement>(`[data-pkc-field="diff-side"][data-pkc-side="${side}"] [data-pkc-pick="note"]`)!;
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    pick('left', 'n1');
    pick('right', 'n2');
    await tick();
    t.pane.querySelector<HTMLElement>('[data-pkc-action="diff-take"][data-pkc-hunk="0"][data-pkc-from="b"]')!.click();
    expect(diffSession(t.pane).merge?.canUndo, '前提: 取り込みの途中経過が無い').toBe(true);
    return t;
  }

  it('🔴 取り込みの途中経過があれば聞く。「やめる」なら相手も取り込みもそのまま(黙って置き換えない)', async () => {
    const { pane, press, asked } = await withTaken(false);
    press('diff-with-history', 'n1');
    await tick();
    expect(asked, '取り込みの途中なのに聞かずに置き換えた').toHaveLength(1);
    const s = diffSession(pane);
    expect([s.left.kind, s.left.lid, s.right.lid], 'やめたのに相手が変わった').toEqual(['note', 'n1', 'n2']);
    expect(s.merge?.canUndo, 'やめたのに取り込みが消えた').toBe(true);
  });

  it('🔴 「置き換える」なら履歴と比べる形に変わる', async () => {
    const { pane, press, asked } = await withTaken(true);
    press('diff-with-history', 'n1');
    await tick();
    expect(asked).toHaveLength(1);
    expect(diffSession(pane).left.revId).toBe('r-prev');
  });
});

describe('SQL で開く / 操作を探す', () => {
  it('🔴 表データの添付を選んだ状態で SQL の画面を開く', () => {
    const { d, press } = setup();
    press('open-in-sql', 'c1');
    expect(d.getState().viewMode).toBe('sql');
    expect(d.getState().sqlPage.guestChosen, '表データの添付が選ばれていない').toBe('c1');
  });

  it('🔴 「操作を探す」からも同じ受け手で呼べる(押せない理由も同じ判定)', async () => {
    const { root, d, keymap } = setup();
    const noop = (): void => {};
    expect(runGlobalCommand('diff-with-history', root, d, keymap, noop, noop, true), 'ノートを開いていないのに押せる').toBe(false);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    expect(runGlobalCommand('diff-with-history', root, d, keymap, noop, noop, true)).toBe(true);
    expect(runGlobalCommand('open-in-sql', root, d, keymap, noop, noop, true), '表データでないのに SQL で開ける').toBe(false);
    runGlobalCommand('diff-with-history', root, d, keymap, noop, noop, false);
    await tick();
    expect(d.getState().viewMode).toBe('diff');
  });
});
