/** @vitest-environment happy-dom */
/**
 * 🔴 **絞った一覧で、親フォルダとその中身を一緒に選んで「移す」と、中身は親に付いていく**(#1087)。
 *
 * 語や種類で絞る / 「中まで全部出す」と、一覧は階層をまたいで平らに並ぶので、親フォルダ F と
 * その中のノート D を両方選べる。直す前は 1 件ずつ `SET_ENTRY_PARENT` を撃っていたので、
 * D だけが行き先 T の直下へ出て、F は空になった。複製(`planCopy`)の「同じ組に祖先が居れば
 * 付いていく」と同じ向きにそろえる。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, order: number, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const rel = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});


async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const MENU = '[data-pkc-region="context-menu"]';
const RENAME = '[data-pkc-field="row-rename"]';

function rightClick(el: Element): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
});

function setup(metas: EntryMeta[] = METAS, relations: Relation[] = []) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  let cur: 'filer' | 'launcher' = 'filer';
  d.onState((s) => browse.render(s, cur));
  const status: string[] = [];
  const errors: string[] = [];
  d.onState((s) => {
    if (s.error !== null && errors.at(-1) !== s.error) errors.push(s.error);
  });
  bindActions(root, d, {
    setBrowse: (m) => {
      cur = m as typeof cur;
      browse.render(d.getState(), cur);
    },
    showStatus: (t) => void status.push(t),
  });
  const parentCalls: Array<{ lid: string; parentLid: string | null }> = [];
  const renamed: Array<{ lid: string; title: string }> = [];
  const created: Array<{ lid: string; parent?: unknown }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    renameEntry: async (lid, title) => {
      renamed.push({ lid, title });
      return stubStamps();
    },
    replaceAssetRefs: () => Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e, opts) => {
      created.push({ lid: e.lid, parent: opts?.parent });
      return { ...stubStamps(), ...(opts?.parent ? { parentWritten: true } : {}) };
    },
    deleteEntry: async () => {},
    setEntryParent: async (lid, parentLid) => {
      parentCalls.push({ lid, parentLid });
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  const row = (lid: string): HTMLElement => {
    const el = pane.querySelector<HTMLElement>(`[data-pkc-entry="${lid}"]`);
    expect(el, `前提が崩れている: 台に ${lid} の行が無い`).not.toBeNull();
    return el!;
  };
  const acts = (): string[] =>
    [...root.querySelectorAll(`${MENU} button[data-pkc-action]`)].map(
      (b) => b.getAttribute('data-pkc-action') ?? '',
    );
  const press = (action: string): void => {
    const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`);
    expect(b, `メニューに ${action} が無い`).not.toBeNull();
    b!.click();
  };
  const renameInput = (): HTMLInputElement | null => pane.querySelector<HTMLInputElement>(RENAME);
  return { root, d, pane, row, acts, press, renameInput, status, errors, parentCalls, renamed, created };
}


const METAS = [
  meta('f', 1, 'folder'),
  meta('t', 2, 'folder'),
  meta('d', 3),
  meta('s1', 4),
  meta('s2', 5),
];

const parentOf = (r: ReturnType<typeof setup>, lid: string): string[] =>
  r.d
    .getState()
    .relations.filter((x) => x.toLid === lid && x.kind === 'structural')
    .map((x) => x.fromLid);

/** 「中まで全部出す」(平らな一覧)で lids を選び、右クリック →「移す…」→ 行き先 to を選ぶ。 */
async function moveFlat(r: ReturnType<typeof setup>, lids: string[], to: string): Promise<void> {
  r.d.dispatch({ type: 'SET_FILER_FLATTEN', on: true });
  r.d.dispatch({ type: 'SELECT_ENTRY', lid: lids[0]! });
  for (const l of lids.slice(1)) r.d.dispatch({ type: 'TOGGLE_SELECT', lid: l });
  expect(r.d.getState().selection.length, '前提が崩れている(印の数)').toBe(lids.length);
  rightClick(r.row(lids[0]!));
  r.press('move-to-folder');
  await tick();
  const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog')].find((x) => x.open);
  expect(dialog, '入れ先を選ぶ画面が出ていない').toBeDefined();
  dialog!
    .querySelector<HTMLElement>(`[data-pkc-field="entry-pick-row"][data-pkc-lid="${to}"]`)!
    .click();
  await tick();
}

describe('選んだ物のうち、祖先も選ばれている物は動かさない', () => {
  it('🔴 親フォルダ F と中のノート D を選んで T へ移すと、D の親は F のまま、F の親は T', async () => {
    const r = setup(METAS, [rel('r1', 'f', 'd')]);
    await moveFlat(r, ['f', 'd'], 't');
    expect(parentOf(r, 'f'), 'F が T に入っていない').toEqual(['t']);
    expect(parentOf(r, 'd'), 'D が F から外れた(行き先の直下へ出た)').toEqual(['f']);
    expect(r.parentCalls.map((c) => c.lid), 'D に disk への要求が出ている').toEqual(['f']);
    // 依頼 85-8:フォルダを移したときは中の件数も言う(F の配下は D の 1 件)── 動かした件数は 1 件(F だけ)のまま
    expect(r.d.getState().notice, '知らせが実際に動かした件数ではない').toBe('「t-f」(中の 1 件ごと)を「t-t」へ入れました');
  });

  it('🔴 間に選ばれていない物が挟まっていても付いていく(F > M > D、F と D を選ぶ)', async () => {
    const r = setup(
      [...METAS, meta('m', 6, 'folder')],
      [rel('r1', 'f', 'm'), rel('r2', 'm', 'd')],
    );
    await moveFlat(r, ['f', 'd'], 't');
    expect(parentOf(r, 'f')).toEqual(['t']);
    expect(parentOf(r, 'd'), '孫が F から外れた').toEqual(['m']);
    expect(parentOf(r, 'm')).toEqual(['f']);
  });

  it('対照群:兄弟 2 件はどちらも T へ移る', async () => {
    const r = setup(METAS, []);
    await moveFlat(r, ['s1', 's2'], 't');
    expect(parentOf(r, 's1')).toEqual(['t']);
    expect(parentOf(r, 's2')).toEqual(['t']);
    expect(r.d.getState().notice).toBe('2 件を「t-t」へ入れました');
  });
});
