/** @vitest-environment happy-dom */
/**
 * P7b review M-1 / M-2 / M-3: 絞り込みが**全部の面に同じように効く**こと、
 * および絞り込み中の破壊操作・作成が「見えていないもの」に及ばないこと。
 *
 * 🔴 どれも実証された欠陥である ──
 * - M-1: 絞り込み中に削除すると、**一覧に出ていない entry** が次に選ばれ、
 *   もう一度押すとそれが消えた
 * - M-2: 絞り込み中に作った新規ノートは **一生一覧に出ない**(既定題名が
 *   絞り込み語に一致しないため)。Esc を押すと未編集 cancel の掃除で消える
 * - M-3: 「りんご」と書かれた欄の隣で、ファイラだけが全件を出していた
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, title: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 0,
    status: null,
    date: null,
    archived: false,
    ...over,
  };
}

async function tick(ms = 5): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function setup(metas: EntryMeta[]) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  const center = new CenterRouter(regions.detail, () => new Date(2026, 7, 15));
  let mode: 'list' | 'filer' | 'launcher' = 'list';
  const setBrowse = (m: typeof mode): void => {
    mode = m;
    browse.render(d.getState(), mode);
  };
  d.onState((s) => {
    browse.render(s, mode);
    center.render(s);
  });
  bindActions(root, d);
  const bodies: Record<string, string> = {};
  for (const m of metas) bodies[m.lid] = '本文 ' + m.lid;
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    persistEntry: async () => stubStamps(),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  const rows = (): string[] =>
    [...root.querySelectorAll('[data-pkc-region="entry-list"] [data-pkc-entry]')].map(
      (el) => el.getAttribute('data-pkc-entry') ?? '',
    );
  const filterInput = root.querySelector<HTMLInputElement>(
    '[data-pkc-field="entry-filter"]',
  )!;
  const type = (value: string): void => {
    filterInput.value = value;
    filterInput.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return { root, d, rows, type, filterInput, setBrowse };
}

const APPLES = [
  meta('e1', 'A-りんご'),
  meta('e2', 'B-ひみつ'),
  meta('e3', 'C-りんご'),
];

describe('絞り込み(P7b review M-1/M-2/M-3)', () => {
  it('打鍵で一覧が絞られ、消すと戻る', () => {
    const { rows, type } = setup(APPLES);
    expect(rows()).toEqual(['e1', 'e2', 'e3']);
    type('りんご');
    expect(rows()).toEqual(['e1', 'e3']);
    type('');
    expect(rows()).toEqual(['e1', 'e2', 'e3']);
  });

  it('🔴 削除の後継は **見えている中**から選ぶ', async () => {
    const { d, rows, type } = setup(APPLES);
    type('りんご');
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'e1' });
    await tick();
    // ⚠ 絞り込み前の並びだと **e2(B-ひみつ)**が選ばれる ── それが M-1 だった
    expect(d.getState().selectedLid).toBe('e3');
    expect(rows()).toEqual(['e3']);
  });

  it('🔴 見えているものが尽きたら選択は外れる(見えないものを選ばない)', async () => {
    const { d, type } = setup(APPLES);
    type('A-りんご');
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'e1' });
    await tick();
    expect(d.getState().selectedLid).toBeNull();
  });

  it('🔴 新規作成は絞り込みを解除する(作ったものが必ず見える)', () => {
    const { d, rows, type, filterInput } = setup(APPLES);
    type('りんご');
    expect(rows()).toEqual(['e1', 'e3']);
    d.dispatch({
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid: 'n9',
      title: '2026-08-03 ノート 2',
    });
    expect(d.getState().filterQuery).toBe('');
    expect(rows()).toContain('n9');
    // ⚠ **欄の文字も消える** ── state だけ消して欄に残ると「効かない絞り込み」に見える
    expect(filterInput.value).toBe('');
  });

  it('🔴 ファイラも同じ規則で絞られる(欄の隣で全件を出さない)', () => {
    const { root, type, setBrowse } = setup(APPLES);
    setBrowse('filer');
    const filerRows = (): number =>
      root.querySelectorAll('[data-pkc-region="filer-table"] tbody [data-pkc-entry]').length;
    expect(filerRows()).toBe(3);
    type('りんご');
    expect(filerRows()).toBe(2);
  });

  /**
   * 🔴 かんばんも同じ規則で絞られる。⚠ **札はノート単位で絞る**(#277 段②-b)──
   *   札の字ではなくノートの題名 / 本文の当たりで決める(判定は `matchesEntry` 1 か所)。
   */
  it('🔴 かんばんも同じ規則で絞られる', () => {
    const { d, root, type } = setup([meta('e1', 'A-りんご'), meta('e2', 'B-ひみつ')]);
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'kanban' });
    // ⚠ 札は worker が集めて state に載る ── ここでは届いた形を直接与える
    d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: {
        cards: [
          { lid: 'e1', line: 0, text: 'やること 1', done: false },
          { lid: 'e2', line: 0, text: 'やること 2', done: false },
        ],
        totalNotes: 2,
        scannedNotes: 2,
        truncated: false,
      },
    });
    const cards = (): number =>
      root.querySelectorAll('[data-pkc-region="kanban-cards"] [data-pkc-entry]').length;
    expect(cards()).toBe(2);
    type('りんご');
    expect(cards()).toBe(1);
  });

  it('🔴 カレンダーも同じ規則で絞られる', () => {
    const { d, root, type } = setup([
      meta('e1', 'A-りんご', { archetype: 'todo', status: 'open', date: '2026-08-10' }),
      meta('e2', 'B-ひみつ', { archetype: 'todo', status: 'open', date: '2026-08-11' }),
    ]);
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'calendar' });
    const items = (): number =>
      root.querySelectorAll('[data-pkc-region="detail"] [data-pkc-entry]').length;
    expect(items()).toBe(2);
    type('りんご');
    expect(items()).toBe(1);
  });
});
