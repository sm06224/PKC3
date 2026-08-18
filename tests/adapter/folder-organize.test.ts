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
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('🔴 親つき作成 ── 行と辺を **1 つの要求**で頼む(#258 のデータ欠損)', () => {
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
    /**
     * 🔴 **要求は 1 つ**(#258)。直す前は `PERSIST_ENTRY` の後ろに
     * `REQUEST_SET_PARENT` を並べる 2 手で、effect が 1 件ずつ worker へ流すので
     * **行を書いた ack と辺の書込の間**にタブを閉じると親だけ飛んだ
     * ── ノートは残るのにルート直下に現れる(実測。smoke が全量実行でだけ落ちた)。
     * ⚠ 「2 つの要求を 1 回の enqueue にまとめる」では直らない(`await` で窓が開く)。
     */
    expect((r.events as Array<{ type: string }>).map((e) => e.type)).toEqual(['PERSIST_ENTRY']);
    expect(
      (r.events[0] as { parent?: unknown }).parent,
      '居場所が同じ要求に乗っていない(2 手に割れている)',
    ).toEqual({ parentLid: 'f1', relationId: 'rel-c' });
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
    // ⚠ 親が無いときは **`parent` を載せない**(載せると「ルートへ出す」= 辺を消す指示になる)
    expect((r.events[0] as { parent?: unknown }).parent).toBeUndefined();
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
    // ⚠ 親が無いときは **`parent` を載せない**(載せると「ルートへ出す」= 辺を消す指示になる)
    expect((r.events[0] as { parent?: unknown }).parent).toBeUndefined();
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
  const persisted: Array<{ lid: string; entryOrder: number }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    persistEntry: async (e) => {
      persisted.push({ lid: e.lid, entryOrder: e.entryOrder });
      return stubStamps();
    },
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
  const nudge = (dir: 'up' | 'down') =>
    q<HTMLButtonElement>(`[data-pkc-action="move-order-${dir}"]`);
  /**
   * 🔴 **フォルダへ入るのは 2 クリック**(#240 段①。user 指示 2026-08-17)。
   * ⚠ 1 クリックは**選ぶだけ** ── 直す前は現在地が選択の純関数だったので
   * 1 クリックで入っていた(その形は複数選択と両立しない)。
   */
  const enter = (lid: string) => {
    const row = q<HTMLElement>(`tbody [data-pkc-entry="${lid}"]`)!;
    row.click();
    row.click(); // ⚠ 2 回目(#240 段①)
  };
  const toRoot = () => q<HTMLElement>('[data-pkc-region="filer-breadcrumb"] button')!.click();

  return {
    root,
    d,
    pane,
    q,
    rows,
    moveSelect,
    moveTo,
    parentCalls,
    persisted,
    nudge,
    enter,
    toRoot,
  };
}

describe('フォルダ整理の導線(画面)', () => {
  const METAS = [meta('f1', 1, 'folder'), meta('f2', 2, 'folder'), meta('n1', 3), meta('n2', 4)];

  it('🔴 選ぶ → 入れ先を選ぶ、で本当に入る(disk への要求まで届く)', async () => {
    const { q, rows, moveTo, parentCalls, toRoot } = setup(METAS, []);
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
    toRoot();
    await tick();
    expect(rows()).toEqual(['f1', 'f2', 'n2']);
  });

  it('🔴 ルートへ出せる(入れたら出せない、を作らない)', async () => {
    const { q, rows, moveTo, parentCalls, enter } = setup(METAS, [rel('r0', 'f1', 'n1')]);
    enter('f1'); // 2 クリックで入る(#240 段①)
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
    enter('f1'); // ⚠ 入るのは 2 クリック(#240 段①)
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
    const { q, moveSelect, enter } = setup(METAS, [rel('r0', 'f2', 'n1')]);
    enter('f2'); // ⚠ 入るのは 2 クリック(#240 段①)
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
    const { root, q, rows, d, enter } = setup(METAS, []);
    enter('f1'); // 2 クリックで入る(#240 段①)
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

/**
 * 🔴 **並べ替え**(2026-08-06。user 報告 2-10「並べ替えの手段が無い」)。
 *
 * 直す前は `entryOrder` が**作成順に固定**で、action にも UI にも動かす道が
 * 無かった(取り込んだ順のまま一生並ぶ)。
 *
 * ⚠ 観測点は「`entryOrder` が変わったか」ではなく **並びが入れ替わったか**
 * (`order` と一覧の行)。値だけ見ると、同値のときに何も起きていないのを
 * 「書き換えた」と読んでしまう。
 */
describe('並べ替え(reducer)', () => {
  const METAS = [meta('a', 1), meta('b', 2), meta('c', 3)];

  it('🔴 下へ ── 並びが入れ替わり、2 件ぶんの永続化を要求する', () => {
    const s0 = READY(METAS, []);
    expect(s0.order).toEqual(['a', 'b', 'c']);
    const r = reduce(s0, { type: 'MOVE_ENTRY_ORDER', lid: 'a', direction: 'down' });
    expect(r.state.order, '並びが動いていない').toEqual(['b', 'a', 'c']);
    expect(r.events).toEqual([
      {
        type: 'REQUEST_REORDER',
        entries: [
          { lid: 'a', title: 't-a', archetype: 'text', entryOrder: 2 },
          { lid: 'b', title: 't-b', archetype: 'text', entryOrder: 1 },
        ],
      },
    ]);
  });

  it('上へも同じ(向きだけ違う)', () => {
    const s0 = READY(METAS, []);
    const r = reduce(s0, { type: 'MOVE_ENTRY_ORDER', lid: 'c', direction: 'up' });
    expect(r.state.order).toEqual(['a', 'c', 'b']);
  });

  it('🔴 端では何も起きない(書込も出ない)', () => {
    const s0 = READY(METAS, []);
    for (const [lid, direction] of [
      ['a', 'up'],
      ['c', 'down'],
    ] as const) {
      const r = reduce(s0, { type: 'MOVE_ENTRY_ORDER', lid, direction });
      expect(r.state, `${lid} を ${direction} で動かしてしまった`).toBe(s0);
      expect(r.events).toEqual([]);
    }
  });

  /**
   * ⚠ **値を振り直さない**(交換する)。`entryOrder` は container 全体で 1 本の
   * 数直線なので、兄弟を 0..n-1 で振り直すと**別のフォルダの entry と噛み合う**。
   */
  it('🔴 別のフォルダの並びに触らない(値は交換するだけ)', () => {
    const metas = [
      meta('f1', 1, 'folder'),
      meta('x', 2),
      meta('y', 3),
      meta('f2', 4, 'folder'),
      meta('p', 5),
      meta('q', 6),
    ];
    const s0 = READY(metas, [
      rel('r1', 'f1', 'x'),
      rel('r2', 'f1', 'y'),
      rel('r3', 'f2', 'p'),
      rel('r4', 'f2', 'q'),
    ]);
    const r = reduce(s0, { type: 'MOVE_ENTRY_ORDER', lid: 'x', direction: 'down' });
    expect(
      getStructuralChildren('f1', r.state.entryMetas, r.state.relations).map((m) => m.lid),
    ).toEqual(['y', 'x']);
    // 別のフォルダ側は 1 件も動いていない(値も並びも)
    expect(
      getStructuralChildren('f2', r.state.entryMetas, r.state.relations).map((m) => m.lid),
    ).toEqual(['p', 'q']);
    for (const lid of ['f1', 'f2', 'p', 'q']) {
      expect(r.state.entryMetas.get(lid)!.entryOrder, `${lid} の値が動いた`).toBe(
        s0.entryMetas.get(lid)!.entryOrder,
      );
    }
  });

  it('🔴 隣は「同じ親の下の隣」(別のフォルダの entry を巻き込まない)', () => {
    // 値の上では f1 の子 x(2)の次は f2(3)だが、兄弟ではない
    const metas = [meta('f1', 1, 'folder'), meta('x', 2), meta('f2', 3, 'folder'), meta('y', 4)];
    const s0 = READY(metas, [rel('r1', 'f1', 'x'), rel('r2', 'f1', 'y')]);
    const r = reduce(s0, { type: 'MOVE_ENTRY_ORDER', lid: 'x', direction: 'down' });
    // x の隣は y(同じ f1 の子)── f2 は動かない
    expect(r.state.entryMetas.get('f2')!.entryOrder).toBe(3);
    expect(
      getStructuralChildren('f1', r.state.entryMetas, r.state.relations).map((m) => m.lid),
    ).toEqual(['y', 'x']);
  });

  /**
   * ⚠ **同値のとき**は交換しても何も起きない(並びは lid で決まっているから)。
   * 取り込んだデータでは実際に同値が起きる ── ここを落とすと
   * 「押しても動かない」黙りになる。
   */
  it('🔴 entryOrder が同値でも動く(交換では足りない場合)', () => {
    const s0 = READY([meta('a', 5), meta('b', 5)], []);
    expect(s0.order, '前提: 同値は lid 順').toEqual(['a', 'b']);
    const r = reduce(s0, { type: 'MOVE_ENTRY_ORDER', lid: 'b', direction: 'up' });
    expect(r.state.order, '同値だと押しても動かない').toEqual(['b', 'a']);
    expect(r.events).toEqual([
      {
        type: 'REQUEST_REORDER',
        entries: [{ lid: 'b', title: 't-b', archetype: 'text', entryOrder: 4 }],
      },
    ]);
  });

  it('編集中は動かさない(ready 限定)', () => {
    const s0 = READY(METAS, []);
    const r = reduce({ ...s0, phase: 'editing' as const }, {
      type: 'MOVE_ENTRY_ORDER',
      lid: 'a',
      direction: 'down',
    });
    expect(r.events).toEqual([]);
  });

  /**
   * 🔴 **並べ方の規則は 1 つ**(CLAUDE.md「同じ判定が 2 か所に生えたら parity test」)。
   *
   * 一覧は `state.order`(reducer が引く)、ファイラは `getRootEntries`(features)で
   * 描く ── 2 か所が別の規則で並べると、「隣」がどちらの画面を指すのか決まらない。
   * ⚠ 同値かつ **渡された順が lid 順と逆**でないと、この食い違いは現れない
   *   (安定ソートが渡された順を保つので、偶然一致してしまう)。
   */
  it('🔴 一覧の並びとファイラの並びが一致する(同値・逆順で渡しても)', () => {
    const s0 = READY([meta('b', 5), meta('a', 5)], []);
    expect(getRootEntries(s0.entryMetas, s0.relations).map((m) => m.lid)).toEqual(s0.order);
    expect(s0.order, '前提: 同値は lid 順に正規化される').toEqual(['a', 'b']);
  });
});

describe('並べ替えの導線(画面)', () => {
  const METAS = [meta('n1', 1), meta('n2', 2), meta('n3', 3)];

  it('🔴 押すと一覧の並びが変わり、disk へ 2 件書く', async () => {
    const { q, rows, nudge, persisted } = setup(METAS, []);
    q<HTMLElement>('tbody [data-pkc-entry="n1"]')!.click();
    await tick();
    nudge('down')!.click();
    await tick();
    expect(rows(), '画面の並びが変わっていない').toEqual(['n2', 'n1', 'n3']);
    // ⚠ **2 件**(交換なので片方だけ書くと disk の並びが壊れる)
    expect(persisted.filter((p) => p.lid === 'n1' || p.lid === 'n2')).toEqual([
      { lid: 'n1', entryOrder: 2 },
      { lid: 'n2', entryOrder: 1 },
    ]);
  });

  it('🔴 端では押せない(押して黙って断らない)', async () => {
    const { q, nudge } = setup(METAS, []);
    q<HTMLElement>('tbody [data-pkc-entry="n1"]')!.click();
    await tick();
    expect(nudge('up')!.disabled, '先頭なのに「上へ」が押せる').toBe(true);
    expect(nudge('down')!.disabled).toBe(false);
    q<HTMLElement>('tbody [data-pkc-entry="n3"]')!.click();
    await tick();
    expect(nudge('up')!.disabled).toBe(false);
    expect(nudge('down')!.disabled, '末尾なのに「下へ」が押せる').toBe(true);
  });

  it('🔴 選び直すと並べ替えも追従する(別のノートが動かない)', async () => {
    // ⚠ 同一 scope 内の選択変更は表を作り直さない速い経路 ── 帯の更新を
    //    忘れると、押したときに**前に選んでいたもの**が動く
    const { q, nudge, rows } = setup(METAS, []);
    q<HTMLElement>('tbody [data-pkc-entry="n1"]')!.click();
    await tick();
    q<HTMLElement>('tbody [data-pkc-entry="n3"]')!.click();
    await tick();
    expect(nudge('up')!.getAttribute('data-pkc-entry')).toBe('n3');
    nudge('up')!.click();
    await tick();
    expect(rows()).toEqual(['n1', 'n3', 'n2']);
  });

  it('フォルダの中でも並べ替えられる(root だけの機能にしない)', async () => {
    const metas = [meta('f1', 1, 'folder'), meta('x', 2), meta('y', 3)];
    const { q, rows, nudge, enter } = setup(metas, [rel('r1', 'f1', 'x'), rel('r2', 'f1', 'y')]);
    enter('f1'); // 2 クリックで入る(#240 段①)
    await tick();
    q<HTMLElement>('tbody [data-pkc-entry="x"]')!.click();
    await tick();
    nudge('down')!.click();
    await tick();
    expect(rows()).toEqual(['y', 'x']);
  });
});

/**
 * 🔴 **掴んで落とす(#240 段④)の unit**(着地前レビュー 8)。
 *
 * ⚠ 段④ には unit が 1 件も無く、smoke 1 本が「入る・出る」だけを見ていた ──
 * **印ごと運ぶ / 落とし先の印 / フォルダ以外に落とせない**は誰も守っていなかった。
 * ⚠ 「happy-dom に `DataTransfer` が無いから届かない」は誤り ── 実装が使うのは
 * `types` / `getData` / `setData` / `dropEffect` の 4 つだけなので、最小の stub で回せる。
 */
const PKC_DRAG = 'application/x-pkc-lids';

function dataTransfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    dropEffect: 'none',
    effectAllowed: 'none',
    get types(): string[] {
      return [...data.keys()];
    },
    getData: (t: string) => data.get(t) ?? '',
    setData: (t: string, v: string) => void data.set(t, v),
    files: { length: 0, item: () => null },
    items: [] as unknown[],
  };
}

function dragEvent(type: string, dt: ReturnType<typeof dataTransfer>): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: dt });
  return e;
}

describe('掴んで落とす(#240 段④)', () => {
  const METAS = [meta('f1', 1, 'folder'), meta('f2', 2, 'folder'), meta('n1', 3), meta('n2', 4)];

  beforeEach(() => {
    document.body.textContent = '';
  });

  it('🔴 落とし先はフォルダの行とパンくずだけ(ノートの行では受けない)', () => {
    const { q } = setup(METAS, []);
    expect(q('tbody [data-pkc-entry="f1"]')!.getAttribute('data-pkc-drop')).toBe('folder');
    expect(
      q('tbody [data-pkc-entry="n1"]')!.hasAttribute('data-pkc-drop'),
      'ノートの行にも落とせる印が付いている',
    ).toBe(false);
    expect(q('[data-pkc-region="filer-breadcrumb"] button')!.getAttribute('data-pkc-drop')).toBe(
      'crumb',
    );
  });

  it('🔴 掴んだ行に印が付いていれば**印ごと**運ぶ', () => {
    const { q, d } = setup(METAS, []);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'n2' });
    const dt = dataTransfer();
    q('tbody [data-pkc-entry="n1"]')!.dispatchEvent(dragEvent('dragstart', dt));
    expect(dt.getData(PKC_DRAG).split(' ').sort(), '印を付けた分が運ばれない').toEqual([
      'n1',
      'n2',
    ]);
  });

  it('印の付いていない行を掴んだら、その 1 件だけ運ぶ', () => {
    const { q, d } = setup(METAS, []);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    const dt = dataTransfer();
    q('tbody [data-pkc-entry="n2"]')!.dispatchEvent(dragEvent('dragstart', dt));
    expect(dt.getData(PKC_DRAG)).toBe('n2');
  });

  it('🔴 落とすとその中へ入り、永続化まで要求する', async () => {
    const { q, d, parentCalls } = setup(METAS, []);
    const dt = dataTransfer({ [PKC_DRAG]: 'n1 n2' });
    q('tbody [data-pkc-entry="f1"]')!.dispatchEvent(dragEvent('drop', dt));
    await tick();
    expect(
      getStructuralChildren('f1', d.getState().entryMetas, d.getState().relations).map(
        (m) => m.lid,
      ),
    ).toEqual(['n1', 'n2']);
    expect(parentCalls.map((c) => c.lid), 'disk への要求が出ていない').toEqual(['n1', 'n2']);
    // ⚠ 落とした先へ**付いていく**(設計 doc §6)
    expect(d.getState().scopeLid).toBe('f1');
  });

  it('🔴 落とせない場所へ移ったら、光っていた先の印を消す', () => {
    const { q } = setup(METAS, []);
    const folder = q<HTMLElement>('tbody [data-pkc-entry="f1"]')!;
    const note = q<HTMLElement>('tbody [data-pkc-entry="n1"]')!;
    folder.dispatchEvent(dragEvent('dragover', dataTransfer({ [PKC_DRAG]: 'n1' })));
    expect(folder.hasAttribute('data-pkc-dropping')).toBe(true);
    note.dispatchEvent(dragEvent('dragover', dataTransfer({ [PKC_DRAG]: 'n1' })));
    expect(
      folder.hasAttribute('data-pkc-dropping'),
      '落とせない所へ移ったのに、前の行が光ったまま',
    ).toBe(false);
  });

  it('🔴 既にそこに居るものを落としても、入れ子の断りを出さない', async () => {
    const { q, d } = setup(METAS, []);
    // ルート直下の n1 を、パンくずの「ルート」へ落とす
    q('[data-pkc-region="filer-breadcrumb"] button')!.dispatchEvent(
      dragEvent('drop', dataTransfer({ [PKC_DRAG]: 'n1' })),
    );
    await tick();
    expect(
      d.getState().error ?? '',
      '理由の違う断りが出た(user は入れ子の話だと読む)',
    ).not.toContain('自分の中');
  });

  it('🔴 輪になる落とし方は断る(黙って捨てない)', async () => {
    const { q, d } = setup(METAS, [rel('r1', 'f1', 'f2')]);
    // f1 を、自分の子孫である f2 の中へ
    // ⚠ **ここで行を押さない** ── 本文が返る(`BODY_LOADED`)と `error` が消えるので、
    //   断りの観測点が壊れる(1 稿目で実際に「無言で捨てている」と誤読した)
    const dt = dataTransfer({ [PKC_DRAG]: 'f1' });
    q<HTMLElement>('tbody [data-pkc-entry="f1"]')!.dispatchEvent(dragEvent('drop', dt));
    await tick();
    expect(d.getState().error ?? '', '無言で捨てている').toContain('自分の中');
  });
});

describe('居場所を変える口は 1 本(着地前レビュー 7)', () => {
  const METAS = [meta('f1', 1, 'folder'), meta('n1', 2)];

  beforeEach(() => {
    document.body.textContent = '';
  });

  it('🔴 編集中は帯の選択でも断る(無言で捨てない)', async () => {
    const { moveTo, d, q } = setup(METAS, []);
    q<HTMLElement>('tbody [data-pkc-entry="n1"]')!.click();
    await tick();
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '' });
    d.dispatch({ type: 'START_EDIT' });
    moveTo('f1');
    await tick();
    expect(d.getState().error ?? '', '編集中に黙って捨てた').toContain('編集を終了');
    // 🔴 **動いていないのに画面だけ移動する**を作らない
    expect(d.getState().scopeLid, '動いていないのに現在地だけ動いた').toBeNull();
    expect(
      getStructuralChildren('f1', d.getState().entryMetas, d.getState().relations),
    ).toHaveLength(0);
  });
});

describe('「もう一度押す」の窓(#240 段①)', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('🔴 間が空いたら「2 回押した」と数えない(席を立って戻ったら入る、を作らない)', () => {
    // ⚠ 観測点は `Date.now` ── unit の 2 回のクリックは**同一ミリ秒**で走るので、
    //   差し替えないと 500ms の窓を 1 度も通らない(通らない経路は守れない)
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    const { q, d } = setup([meta('f1', 1, 'folder'), meta('n1', 2)], []);
    const row = () => q<HTMLElement>('tbody [data-pkc-entry="f1"]')!;
    row().click();
    now.mockReturnValue(6_000); // 5 秒後
    row().click();
    expect(d.getState().scopeLid, '5 秒空いたのに「続けて押した」と数えた').toBeNull();
    now.mockReturnValue(6_200); // 続けて押した
    row().click();
    expect(d.getState().scopeLid, '続けて押しても入らない').toBe('f1');
    now.mockRestore();
  });
});

