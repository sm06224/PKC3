/** @vitest-environment happy-dom */
/**
 * 🔴 **前の日の未完了を引き継ぐ**(#1966 4-4。user 裁定 2026-11-16「写して前の日から外す」)── 押し口と流れ。
 *
 * - 日付ノートの上の並びに「前の日の未完了を引き継ぐ」が出る(前の日付のノートが無ければ押せない)
 * - 押すと、開いている日付のノート(写す先)と、いちばん近い前の日付のノート(写す元)で引き継ぐ
 * - 終わったら 2 冊の本文を差し替え、件数を知らせる。0 件なら「ありません」と言う
 * - 編集中・日付でないノート・前の日が無いときは理由を言って止まる(「操作を探す」と同じ判定 1 本)
 */
import { describe, expect, it } from 'vitest';
import { STUB_STAMP, stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions, carryOverPlan, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';

function meta(lid: string, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}
const METAS = [meta('a', '2026-10-10'), meta('b', '2026-10-12'), meta('x', '買い物')];
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function stateOn(lid: string): AppState {
  let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid }).state;
  return reduce(s, { type: 'BODY_LOADED', lid, body: '本文' }).state;
}

describe('押し口', () => {
  it('🔴 日付ノートの上に出る。前の日付のノートが無い日は押せない', async () => {
    for (const [lid, disabled] of [
      ['b', false],
      ['a', true],
    ] as const) {
      const root = document.createElement('div');
      new DetailRenderer(buildShell(root).detail).render(stateOn(lid));
      await settle();
      const btn = root.querySelector<HTMLButtonElement>('[data-pkc-field="detail-day-nav"] [data-pkc-action="carry-over-tasks"]');
      expect(btn, '引き継ぐボタンが出ない').not.toBeNull();
      expect(btn!.textContent).toBe('前の日の未完了を引き継ぐ');
      expect(btn!.disabled, `${lid} の押せる / 押せない`).toBe(disabled);
    }
  });

  it('🔴 判定は 1 本(`carryOverPlan`): 写す先は開いている日付のノート、写す元はいちばん近い前の日', () => {
    expect(carryOverPlan(stateOn('b'))).toEqual({ lid: 'b', sourceLid: 'a' });
    expect(carryOverPlan(stateOn('a'))).toEqual({ why: 'これより前の日付のノートはありません' });
    expect(carryOverPlan(stateOn('x'))).toEqual({ why: '題名が日付(2026-10-15 の形)のノートを開いてから呼んでください' });
    const editing = reduce(stateOn('b'), { type: 'START_EDIT' }).state;
    expect(editing.phase).toBe('editing');
    expect('why' in carryOverPlan(editing) && carryOverPlan(editing)).toMatchObject({ why: expect.stringContaining('いまは引き継げません') });
  });
});

describe('流れ', () => {
  function wire(result: { wrote: Array<{ lid: string; body: string }>; moved: number }) {
    const calls: Array<[string, string]> = [];
    const d = new Dispatcher();
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '',
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      carryOverTasks: async (lid: string, sourceLid: string) => {
        calls.push([lid, sourceLid]);
        // ⚠ 冊ごとに違う時刻を返す(どの冊にどの時刻を刻んだかを見分ける)
        return {
          wrote: result.wrote.map((w, i) => ({ ...w, stamps: { createdAt: STUB_STAMP, updatedAt: `2026-11-16 0${i}:00:00` } })),
          moved: result.moved,
        };
      },
    } as unknown as Parameters<typeof connectStoreEffects>[1]);
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'b', body: '本文' });
    const refreshed: Array<[string, string]> = [];
    const stamped: Array<[string, string | null]> = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = ((a: Parameters<typeof d.dispatch>[0]) => {
      if (a.type === 'ENTRY_BODY_REFRESHED') refreshed.push([a.lid, a.body]);
      if (a.type === 'ENTRY_STAMPED') stamped.push([a.lid, a.updatedAt]);
      return orig(a);
    }) as typeof d.dispatch;
    const press = (): void => {
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'carry-over-tasks');
      root.append(b);
      b.click();
    };
    return { d, calls, refreshed, stamped, press, root };
  }

  it('🔴 押すと 2 冊を引き継ぎ、それぞれの本文と時刻を差し替え、件数を知らせる', async () => {
    const FROM = '- ~~x~~ → [2026-10-12](entry:b)';
    const TO = '本文\n\n前の日から引き継ぎ: [2026-10-10](entry:a)\n- [ ] x';
    const { d, calls, refreshed, stamped, press } = wire({
      wrote: [
        { lid: 'a', body: FROM },
        { lid: 'b', body: TO },
      ],
      moved: 1,
    });
    press();
    await settle();
    expect(calls).toEqual([['b', 'a']]);
    // ⚠ 冊と本文の組を取り違えると、開いている今日のノートに前の日の本文が出る
    expect(refreshed).toEqual([
      ['a', FROM],
      ['b', TO],
    ]);
    expect(stamped).toEqual([
      ['a', '2026-11-16 00:00:00'],
      ['b', '2026-11-16 01:00:00'],
    ]);
    expect(d.getState().entryMetas.get('b')?.updatedAt).toBe('2026-11-16 01:00:00');
    expect(d.getState().notice ?? '').toContain('2026-10-10 の未完了 1 件を引き継ぎました');
  });

  it('⚠ 0 件なら黙らず「ありません」と言う(本文は差し替えない)', async () => {
    const { d, refreshed, press } = wire({ wrote: [], moved: 0 });
    press();
    await settle();
    expect(refreshed).toEqual([]);
    expect(d.getState().notice ?? '').toContain('2026-10-10 に引き継ぐ未完了はありません');
  });

  it('⚠ 編集中は理由を言って止まる', async () => {
    const { d, calls, press } = wire({ wrote: [], moved: 0 });
    d.dispatch({ type: 'START_EDIT' });
    press();
    await settle();
    expect(calls).toEqual([]);
    expect(d.getState().error ?? '').toContain('いまは引き継げません');
  });
});

describe('「操作を探す」からの入口', () => {
  it('🔴 ボタンと同じ判定 1 本: 押せない日は一覧で押せるふりをせず、押せる日は同じ受け手で引き継ぐ', () => {
    const noop = (): void => {};
    const keymap = new KeymapStore();
    const root = document.createElement('div');
    const at = (lid: string, editing = false): Dispatcher => {
      const d = new Dispatcher();
      d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
      d.dispatch({ type: 'SELECT_ENTRY', lid });
      d.dispatch({ type: 'BODY_LOADED', lid, body: '本文' });
      if (editing) d.dispatch({ type: 'START_EDIT' });
      return d;
    };
    expect(runGlobalCommand('carry-over-tasks', root, at('a'), keymap, noop, noop, true), '前の日が無いのに押せる').toBe(false);
    expect(runGlobalCommand('carry-over-tasks', root, at('x'), keymap, noop, noop, true), '日付でないのに押せる').toBe(false);
    expect(runGlobalCommand('carry-over-tasks', root, at('b', true), keymap, noop, noop, true), '編集中なのに押せる').toBe(false);
    const d = at('b');
    expect(runGlobalCommand('carry-over-tasks', root, d, keymap, noop, noop, true)).toBe(true);
    const sent: unknown[] = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = ((a: Parameters<typeof d.dispatch>[0]) => {
      if (a.type === 'CARRY_OVER_TASKS') sent.push(a);
      return orig(a);
    }) as typeof d.dispatch;
    expect(runGlobalCommand('carry-over-tasks', root, d, keymap, noop, noop, false)).toBe(true);
    expect(sent).toEqual([{ type: 'CARRY_OVER_TASKS', lid: 'b', sourceLid: 'a' }]);
  });
});
