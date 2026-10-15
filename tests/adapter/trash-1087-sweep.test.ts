/** @vitest-environment happy-dom */
/**
 * #1087 ゴミ箱の見直し 3 件(history/trash の掃引)。
 *
 * 1. 別のタブ・窓が編集中のノートは、ゴミ箱へ移さない(移すと、その編集の保存で行が作り直されてゴミ箱から消える)
 * 2. ゴミ箱から戻す / 移した直後の「元に戻す」で、作成日を「いま」へ作り直さない
 * 3. 「新規 → 何も打たず Esc」の空のノートは、ゴミ箱を経由せずに消す(溜めない)
 *
 * 作成日の控えが worker で効くこと(列・SQL)は `storage-worker.test.ts` の同名の節が見る。
 * ここは主スレッド側(門・event・effect)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { reduce, type AppState } from '../../src/adapter/state/app-state';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, order = 1): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('1. 別のタブが編集中のノートは、ゴミ箱へ移さない', () => {
  function setup(acquireEditLock?: (lid: string) => Promise<'granted' | 'denied' | 'unreachable'>) {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    bindActions(root, d, acquireEditLock ? { acquireEditLock, releaseEditLock: () => {} } : {});
    const deleted: string[] = [];
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '# 本文',
      deleteEntry: async (lid: string) => {
        deleted.push(lid);
      },
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1), meta('b', 2)], relations: [] });
    const press = (action: string): void => {
      const btn = document.createElement('button');
      btn.setAttribute('data-pkc-action', action);
      root.append(btn);
      btn.click();
    };
    return { d, deleted, press };
  }

  it('🔴 delete-entry: 別のタブが編集中なら断って、何も消さない', async () => {
    const s = setup(async () => 'denied');
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    s.press('delete-entry');
    await tick();
    expect(s.d.getState().entryMetas.has('a'), 'ゴミ箱へ移してしまった').toBe(true);
    expect(s.deleted, 'disk へ消す要求が飛んだ').toEqual([]);
    expect(s.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
  });

  it('対照群: 編集されていないノートは従来どおりゴミ箱へ移る', async () => {
    const s = setup(async () => 'granted');
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    s.press('delete-entry');
    await tick();
    expect(s.d.getState().entryMetas.has('a')).toBe(false);
    expect(s.deleted).toEqual(['a']);
  });

  it('対照群: 問い合わせの口が無い環境は同期のまま移る', () => {
    const s = setup();
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    s.press('delete-entry');
    expect(s.d.getState().entryMetas.has('a')).toBe(false);
  });

  it('🔴 delete-selected: 印を付けた 1 件でも別のタブが編集中なら、全部を移さない', async () => {
    const s = setup(async (lid) => (lid === 'b' ? 'denied' : 'granted'));
    s.d.dispatch({ type: 'SELECT_ALL' });
    expect(s.d.getState().selection.length, '前提: 2 件選んでいる').toBe(2);
    s.press('delete-selected');
    await tick();
    expect([...s.d.getState().entryMetas.keys()].sort(), '一部だけ移した').toEqual(['a', 'b']);
    expect(s.deleted).toEqual([]);
    expect(s.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
  });

  it('対照群: delete-selected は編集されていなければ全部移る', async () => {
    const s = setup(async () => 'granted');
    s.d.dispatch({ type: 'SELECT_ALL' });
    s.press('delete-selected');
    await tick();
    expect(s.d.getState().entryMetas.size).toBe(0);
    expect(s.deleted.sort()).toEqual(['a', 'b']);
  });
});

describe('2. ゴミ箱から戻すとき、作成日を保つ', () => {
  function setup(entryCreatedAt: string | null | undefined) {
    const d = new Dispatcher();
    const persisted: Array<{ lid: string; createdAt?: string | null }> = [];
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getRevision: async () => ({
        body: '本文',
        title: 't',
        archetype: 'text',
        ...(entryCreatedAt !== undefined ? { entryCreatedAt } : {}),
      }),
      getBody: async () => null,
      getBodies: async () => [],
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async (e: { lid: string; createdAt?: string | null }) => {
        persisted.push({ lid: e.lid, createdAt: e.createdAt });
        return stubStamps();
      },
    } as never);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    return { d, persisted };
  }

  it('🔴 控えた作成日を persistEntry に渡す', async () => {
    const s = setup('2020-01-01 00:00:00');
    s.d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'x', revId: 'r1' } as never);
    await tick();
    expect(s.persisted).toEqual([{ lid: 'x', createdAt: '2020-01-01 00:00:00' }]);
  });

  it('対照群: 控えが無い版(旧ビルドが積んだ行)は作成日を渡さない(従来どおり「いま」)', async () => {
    for (const none of [null, undefined]) {
      const s = setup(none);
      s.d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'x', revId: 'r1' } as never);
      await tick();
      expect(s.persisted).toHaveLength(1);
      expect('createdAt' in s.persisted[0]! && s.persisted[0]!.createdAt !== undefined).toBe(false);
    }
  });

  it('🔴 移した直後の「元に戻す」も同じ経路で作成日を戻す', async () => {
    const d = new Dispatcher();
    const persisted: Array<{ lid: string; createdAt?: string | null }> = [];
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      listTrash: async () => [{ id: 'r9', entry_lid: 'a', created_at: null, title: 't', archetype: 'text' }],
      getRevision: async () => ({ body: '本文', title: 't', archetype: 'text', entryCreatedAt: '2019-05-05 05:05:05' }),
      getBody: async () => null,
      getBodies: async () => [],
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async (e: { lid: string; createdAt?: string | null }) => {
        persisted.push({ lid: e.lid, createdAt: e.createdAt });
        return stubStamps();
      },
    } as never);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'a' });
    d.dispatch({ type: 'UNDO_TRASH', lids: ['a'] } as never);
    await tick(50);
    expect(persisted).toEqual([{ lid: 'a', createdAt: '2019-05-05 05:05:05' }]);
  });
});

describe('3. 新規 → 何も打たず Esc の空のノートは、ゴミ箱へ溜めない', () => {
  const boot = (): AppState => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    return d.getState();
  };
  const create = (over: Record<string, unknown> = {}) =>
    reduce(boot(), {
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid: 'n1',
      title: '新しいノート',
      ...over,
    } as never);

  it('🔴 手付かず(種の本文のまま)の Esc は untouched で消す', () => {
    const made = create();
    expect(made.state.freshLid, '前提: 作りたての編集に入っている').toBe('n1');
    const r = reduce(made.state, { type: 'CANCEL_EDIT' });
    expect(r.state.entryMetas.has('n1')).toBe(false);
    expect(r.events.filter((e) => e.type === 'REQUEST_DELETE')).toEqual([{ type: 'REQUEST_DELETE', lid: 'n1', untouched: true }]);
  });

  it('🔴 中身を持って作った物(種と違う本文)は、Esc でもゴミ箱を通る', () => {
    const made = create({ body: '取り込んだ中身\n' });
    expect(made.state.freshLid).toBe('n1');
    const r = reduce(made.state, { type: 'CANCEL_EDIT' });
    expect(r.state.entryMetas.has('n1')).toBe(false);
    expect(r.events.filter((e) => e.type === 'REQUEST_DELETE')).toEqual([{ type: 'REQUEST_DELETE', lid: 'n1' }]);
  });

  it('対照群: 打った後の Esc はノートを残す(消さない)', () => {
    const made = create();
    const typed = reduce(made.state, { type: 'UPDATE_OPEN_BODY', body: '打った字' });
    const r = reduce(typed.state, { type: 'CANCEL_EDIT' });
    expect(r.state.entryMetas.has('n1')).toBe(true);
    expect(r.events).toEqual([]);
  });

  it('対照群: 通常のゴミ箱へ移す操作は untouched を付けない', () => {
    const r = reduce(boot(), { type: 'DELETE_ENTRY', lid: 'a' });
    expect(r.events).toEqual([{ type: 'REQUEST_DELETE', lid: 'a' }]);
  });

  it('🔴 effect は untouched を store へ運び、立てない削除には運ばない', async () => {
    const d = new Dispatcher();
    const calls: Array<{ lid: string; opts: unknown }> = [];
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '',
      deleteEntry: async (lid: string, opts?: unknown) => {
        calls.push({ lid, opts });
      },
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
    } as never);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'n1', title: '新しいノート' } as never);
    await tick();
    d.dispatch({ type: 'CANCEL_EDIT' });
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'a' });
    await tick();
    expect(calls).toEqual([
      { lid: 'n1', opts: { untouched: true } },
      { lid: 'a', opts: undefined },
    ]);
  });
});
