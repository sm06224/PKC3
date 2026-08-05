/** @vitest-environment happy-dom */
/**
 * 🔴 **フォルダ整理**(2026-08-05、user 報告「フォルダ整理のための導線がない」)。
 *
 * 直す前は、フォルダは**作れるのに中身を入れる手段が無かった** ── UI どころか
 * action・reducer・effect のどこにも relation を編集する経路が存在せず、
 * フォルダは永久に空だった(取り込んだデータの階層を眺めるだけ)。
 *
 * ⚠ **全 test 緑のまま壊れていた**。既存の `filer-view.test.ts` は
 * 「与えた relations が正しく描かれるか」しか見ておらず、**relations を作る側**は
 * 誰も見ていなかった。ここでは「画面の操作 → state → 永続化要求」まで通す。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { getStructuralChildren, getRootEntries } from '../../src/features/relation/tree';

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
  };
}

const rel = (id: string, from: string, to: string, kind = 'structural'): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind,
  createdAt: null,
  updatedAt: null,
});

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ── reducer を素で回す(見たいのは state と events)
function run(
  state: AppState,
  actions: Parameters<typeof reduce>[1][],
): { state: AppState; events: Parameters<typeof reduce>[1][] extends never ? never : unknown[] } {
  let s = state;
  let events: unknown[] = [];
  for (const a of actions) {
    const r = reduce(s, a);
    s = r.state;
    events = r.events;
  }
  return { state: s, events };
}

const booted = (
  metas: EntryMeta[],
  relations: Relation[],
): Parameters<typeof reduce>[1] => ({
  type: 'SYS_BOOTED',
  cid: 'c1',
  metas,
  relations,
});

const READY = (metas: EntryMeta[], relations: Relation[]): AppState =>
  run(initialState, [booted(metas, relations)]).state;

describe('居場所を変える(reducer)', () => {
  const METAS = [meta('f1', 1, 'folder'), meta('f2', 2, 'folder'), meta('n1', 3)];

  it('🔴 フォルダへ入れる ── 一覧がその場で変わり、永続化を要求する', () => {
    const before = READY(METAS, []);
    expect(getRootEntries(before.entryMetas, before.relations).map((m) => m.lid)).toEqual([
      'f1',
      'f2',
      'n1',
    ]);
    const r = reduce(before, {
      type: 'SET_ENTRY_PARENT',
      lid: 'n1',
      parentLid: 'f1',
      relationId: 'rel-1',
    });
    // ① 画面(= state.relations の純関数)がその場で動く
    expect(
      getStructuralChildren('f1', r.state.entryMetas, r.state.relations).map((m) => m.lid),
    ).toEqual(['n1']);
    expect(getRootEntries(r.state.entryMetas, r.state.relations).map((m) => m.lid)).toEqual([
      'f1',
      'f2',
    ]);
    // ② disk へも要求が出る(楽観更新だけで終わらない)
    expect(r.events).toEqual([
      { type: 'REQUEST_SET_PARENT', lid: 'n1', parentLid: 'f1', relationId: 'rel-1' },
    ]);
  });

  it('🔴 別のフォルダへ移すと、前の辺は残らない(2 か所に見えない)', () => {
    const s0 = READY(METAS, [rel('r0', 'f1', 'n1')]);
    const r = reduce(s0, {
      type: 'SET_ENTRY_PARENT',
      lid: 'n1',
      parentLid: 'f2',
      relationId: 'rel-2',
    });
    expect(r.state.relations.filter((x) => x.toLid === 'n1')).toHaveLength(1);
    expect(getStructuralChildren('f1', r.state.entryMetas, r.state.relations)).toEqual([]);
    expect(
      getStructuralChildren('f2', r.state.entryMetas, r.state.relations).map((m) => m.lid),
    ).toEqual(['n1']);
  });

  it('ルートへ出す(parentLid = null)', () => {
    const s0 = READY(METAS, [rel('r0', 'f1', 'n1')]);
    const r = reduce(s0, {
      type: 'SET_ENTRY_PARENT',
      lid: 'n1',
      parentLid: null,
      relationId: 'rel-3',
    });
    expect(r.state.relations).toHaveLength(0);
    expect(r.events).toEqual([
      { type: 'REQUEST_SET_PARENT', lid: 'n1', parentLid: null, relationId: 'rel-3' },
    ]);
  });

  it('🔴 structural 以外の辺は巻き添えにしない(別の情報が黙って消える)', () => {
    const s0 = READY(METAS, [rel('r0', 'f1', 'n1'), rel('s0', 'f2', 'n1', 'semantic')]);
    const r = reduce(s0, {
      type: 'SET_ENTRY_PARENT',
      lid: 'n1',
      parentLid: null,
      relationId: 'rel-4',
    });
    expect(r.state.relations.map((x) => x.id)).toEqual(['s0']);
  });

  it('🔴 自分の子孫の中へは入れない(輪ができて枝ごと見えなくなる)', () => {
    const metas = [meta('a', 1, 'folder'), meta('b', 2, 'folder'), meta('c', 3, 'folder')];
    const s0 = READY(metas, [rel('r1', 'a', 'b'), rel('r2', 'b', 'c')]);
    // a を孫の c の下へ = 輪
    const r = reduce(s0, {
      type: 'SET_ENTRY_PARENT',
      lid: 'a',
      parentLid: 'c',
      relationId: 'x',
    });
    expect(r.state).toBe(s0);
    expect(r.events).toEqual([]);
  });

  it('自分自身 / folder でない先 / 居ない先は断る', () => {
    const s0 = READY(METAS, []);
    for (const parentLid of ['f1', 'n1', 'no-such']) {
      const r = reduce(s0, {
        type: 'SET_ENTRY_PARENT',
        lid: parentLid === 'f1' ? 'f1' : 'f2',
        parentLid,
        relationId: 'x',
      });
      expect(r.events).toEqual([]);
      expect(r.state).toBe(s0);
    }
  });

  it('同じ親へ落としても書かない(無駄な書込を出さない)', () => {
    const s0 = READY(METAS, [rel('r0', 'f1', 'n1')]);
    const r = reduce(s0, {
      type: 'SET_ENTRY_PARENT',
      lid: 'n1',
      parentLid: 'f1',
      relationId: 'rel-new',
    });
    // ⚠ 実装は「落として張る」ので id は変わる ── 変わらないのは**居場所**。
    //    それでも辺は 1 本のままで、f1 の子であり続ける
    expect(
      getStructuralChildren('f1', r.state.entryMetas, r.state.relations).map((m) => m.lid),
    ).toEqual(['n1']);
    expect(r.state.relations).toHaveLength(1);
  });

  it('ルートに居るものを更にルートへ出しても、何も起きない', () => {
    const s0 = READY(METAS, []);
    const r = reduce(s0, {
      type: 'SET_ENTRY_PARENT',
      lid: 'n1',
      parentLid: null,
      relationId: 'x',
    });
    expect(r.state).toBe(s0);
    expect(r.events).toEqual([]);
  });

  it('編集中は動かさない(ready 限定)', () => {
    const s0 = READY(METAS, []);
    const editing = { ...s0, phase: 'editing' as const };
    const r = reduce(editing, {
      type: 'SET_ENTRY_PARENT',
      lid: 'n1',
      parentLid: 'f1',
      relationId: 'x',
    });
    expect(r.events).toEqual([]);
  });
});

describe('いま見ているフォルダの中に作る(reducer)', () => {
  const METAS = [meta('f1', 1, 'folder'), meta('n0', 2)];

  it('🔴 親つき作成 ── 辺も張り、**entry を書いた後**に永続化を頼む', () => {
    const s0 = READY(METAS, []);
    const r = reduce(s0, {
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid: 'new1',
      title: '新しいノート',
      parentLid: 'f1',
      relationId: 'rel-c',
    });
    expect(
      getStructuralChildren('f1', r.state.entryMetas, r.state.relations).map((m) => m.lid),
    ).toEqual(['new1']);
    // ⚠ 順序が本題 ── 行が無いところへ辺を張ると FK / 掃除の前提が崩れる
    expect((r.events as Array<{ type: string }>).map((e) => e.type)).toEqual([
      'PERSIST_ENTRY',
      'REQUEST_SET_PARENT',
    ]);
    expect(r.events[1]).toEqual({
      type: 'REQUEST_SET_PARENT',
      lid: 'new1',
      parentLid: 'f1',
      relationId: 'rel-c',
    });
  });

  it('親を渡さなければ従来どおりルートに作る(辺は増えない)', () => {
    const s0 = READY(METAS, []);
    const r = reduce(s0, {
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid: 'new2',
      title: 'x',
    });
    expect(r.state.relations).toEqual([]);
    expect((r.events as Array<{ type: string }>).map((e) => e.type)).toEqual(['PERSIST_ENTRY']);
  });

  it('🔴 入れ先が folder でなければ、断らずにルートへ作る', () => {
    // ⚠ ここで作成ごと断ると、user には「押しても何も起きない」に見える
    const s0 = READY(METAS, []);
    const r = reduce(s0, {
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid: 'new3',
      title: 'x',
      parentLid: 'n0', // folder ではない
      relationId: 'rel-x',
    });
    expect(r.state.entryMetas.has('new3')).toBe(true);
    expect(r.state.relations).toEqual([]);
    expect((r.events as Array<{ type: string }>).map((e) => e.type)).toEqual(['PERSIST_ENTRY']);
  });
});

// ─────────────────────────────────────────────────────────────
// 画面(実クリック・実 change)
// ─────────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.textContent = '';
});

function setup(metas: EntryMeta[], relations: Relation[]) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  let mode: 'list' | 'filer' | 'launcher' = 'list';
  d.onState((s) => browse.render(s, mode));
  bindActions(root, d, {
    setBrowse: (m) => {
      mode = m as typeof mode;
      browse.render(d.getState(), mode);
    },
  });
  const parentCalls: Array<{ lid: string; parentLid: string | null; relationId: string }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async (lid, parentLid, relationId) => {
      parentCalls.push({ lid, parentLid, relationId });
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
  const q = <T extends HTMLElement>(sel: string) => pane.querySelector<T>(sel);
  const rows = () =>
    [...pane.querySelectorAll('tbody [data-pkc-entry]')].map((r) =>
      r.getAttribute('data-pkc-entry'),
    );
  const moveSelect = () => q<HTMLSelectElement>('[data-pkc-field="move-target"]');
  /** 実際の操作と同じ形で選ぶ(値を入れて change を出す ── binder の経路)。 */
  const moveTo = (value: string): void => {
    const sel = moveSelect()!;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return { root, d, pane, q, rows, moveSelect, moveTo, parentCalls };
}

describe('フォルダ整理の導線(画面)', () => {
  const METAS = [meta('f1', 1, 'folder'), meta('f2', 2, 'folder'), meta('n1', 3), meta('n2', 4)];

  it('🔴 選ぶ → 入れ先を選ぶ、で本当に入る(disk への要求まで届く)', async () => {
    const { q, rows, moveTo, parentCalls } = setup(METAS, []);
    expect(rows()).toEqual(['f1', 'f2', 'n1', 'n2']);

    q<HTMLElement>('tbody [data-pkc-entry="n1"]')!.click();
    await tick();
    moveTo('f1');
    await tick();

    // ① 🔑 **画面は動かしたものに付いていく**(scope は選択の純関数なので、
    //    n1 が f1 の中へ入った時点で「見ている場所」も f1 になる)── 入れた物が
    //    視界から消えないので、着いたことがその場で分かる
    expect(rows()).toEqual(['n1']);
    expect(q('[data-pkc-region="filer-breadcrumb"]')!.textContent).toContain('t-f1');
    // ② disk へ届く
    expect(parentCalls).toEqual([
      { lid: 'n1', parentLid: 'f1', relationId: expect.any(String) },
    ]);
    // ③ ルートからは消えている(2 か所に見えない)
    q<HTMLElement>('[data-pkc-action="filer-root"]')!.click();
    await tick();
    expect(rows()).toEqual(['f1', 'f2', 'n2']);
  });

  it('🔴 ルートへ出せる(入れたら出せない、を作らない)', async () => {
    const { q, rows, moveTo, parentCalls } = setup(METAS, [rel('r0', 'f1', 'n1')]);
    q<HTMLElement>('tbody [data-pkc-entry="f1"]')!.click(); // scope = f1
    await tick();
    q<HTMLElement>('tbody [data-pkc-entry="n1"]')!.click();
    await tick();
    moveTo('');
    await tick();
    expect(parentCalls).toEqual([
      { lid: 'n1', parentLid: null, relationId: expect.any(String) },
    ]);
    // 出した先(= ルート)に付いていく
    expect(rows()).toEqual(['f1', 'f2', 'n1', 'n2']);
    q<HTMLElement>('tbody [data-pkc-entry="f1"]')!.click();
    await tick();
    expect(rows()).toEqual([]); // f1 は空になった
  });

  it('🔴 選び直すと帯も追従する(別のノートが動かない)', async () => {
    // ⚠ 同一 scope 内の選択変更は**表を作り直さない**速い経路を通る。
    //    そこで帯を更新し忘れると、帯は前のノートを指したまま = 見えない取り違え
    const { q, moveSelect, moveTo, parentCalls } = setup(METAS, []);
    q<HTMLElement>('tbody [data-pkc-entry="n1"]')!.click();
    await tick();
    expect(moveSelect()!.getAttribute('data-pkc-entry')).toBe('n1');
    q<HTMLElement>('tbody [data-pkc-entry="n2"]')!.click();
    await tick();
    expect(moveSelect()!.getAttribute('data-pkc-entry')).toBe('n2');
    moveTo('f1');
    await tick();
    expect(parentCalls.map((c) => c.lid)).toEqual(['n2']);
  });

  it('いまの居場所が選ばれた状態で出る(どこに居るか読める)', async () => {
    const { q, moveSelect } = setup(METAS, [rel('r0', 'f2', 'n1')]);
    q<HTMLElement>('tbody [data-pkc-entry="f2"]')!.click();
    await tick();
    q<HTMLElement>('tbody [data-pkc-entry="n1"]')!.click();
    await tick();
    expect(moveSelect()!.value).toBe('f2');
  });

  it('🔴 入れられない先は一覧に出さない(押してから黙って断らない)', async () => {
    const metas = [meta('a', 1, 'folder'), meta('b', 2, 'folder')];
    const { q, moveSelect } = setup(metas, [rel('r1', 'a', 'b')]);
    q<HTMLElement>('tbody [data-pkc-entry="a"]')!.click(); // a を選ぶ(scope も a)
    await tick();
    const values = [...moveSelect()!.options].map((o) => o.value);
    expect(values).toEqual(['']); // ルートのみ ── 自分 a も 子 b も出ない
  });

  it('何も選んでいなければ、何をすれば出るかを書く', () => {
    const { q } = setup(METAS, []);
    expect(q('[data-pkc-field="move-target"]')).toBeNull();
    expect(q('[data-pkc-field="filer-move-empty"]')?.textContent).toContain('選ぶと');
  });

  it('🔴 いま見ているフォルダの中に作れる(押してからルートに落ちない)', async () => {
    const { root, q, rows, d } = setup(METAS, []);
    q<HTMLElement>('tbody [data-pkc-entry="f1"]')!.click(); // scope = f1
    await tick();
    // 作る先を**先に見せている**
    const where = q('[data-pkc-field="filer-create-target"]');
    expect(where, '作る先の案内が出ていない').not.toBeNull();
    expect(where!.textContent).toContain('t-f1');

    root.querySelector<HTMLElement>('[data-pkc-field="create-run"]')!.click();
    await tick();
    const created = d.getState().selectedLid!;
    expect(created).toBeTruthy();
    // 新しいノートは f1 の中に居る(scope は f1 のまま = 一覧に出る)
    expect(rows()).toContain(created);
    expect(
      getStructuralChildren('f1', d.getState().entryMetas, d.getState().relations).map(
        (m) => m.lid,
      ),
    ).toEqual([created]);
  });

  it('ルートに居るときの作成は、これまでどおりルートに作る', async () => {
    const { root, d } = setup(METAS, []);
    root.querySelector<HTMLElement>('[data-pkc-field="create-run"]')!.click();
    await tick();
    expect(d.getState().relations).toEqual([]);
  });
});
