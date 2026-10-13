/** @vitest-environment happy-dom */
/**
 * #1087 アプリの一覧(ランチャー)の案内と、設定の断り方。
 *
 * ⚠ 「アプリがありません」の案内は、組み込みのタイルが必ず入るため一度も出なかった。
 *   観測点は**組み込みが入った実際の一覧**(`withBuiltinTiles`)で見る。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initialState, reduce, APPEND_BUSY_NOTE, phaseBlockReason } from '../../src/adapter/state/app-state';
import type { AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { withBuiltinTiles } from '../../src/features/launcher/tiles';
import { APP_GROUP_REORDER_OK_LABEL, ENTRY_ACTION_LABELS } from '../../src/features/entry-actions';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { TARGET_LID_ATTR } from '../../src/adapter/ui/render/target-lid';

beforeEach(() => {
  document.body.textContent = '';
});

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: lid,
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

function launcher(user: boolean) {
  const region = document.createElement('div');
  document.body.append(region);
  const r = new LauncherRenderer(region);
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  d.dispatch({
    type: 'LAUNCHER_TILES_LOADED',
    tiles: withBuiltinTiles(
      user ? [{ lid: 'u1', title: 'u', group: '', kind: 'url', url: 'https://a.test/' }] : [],
      { office: false },
    ),
  });
  r.render(d.getState());
  const q = (f: string): HTMLElement | null => region.querySelector(`[data-pkc-field="${f}"]`);
  return { d, r, q };
}

describe('A1 自分のアプリが無いときの案内', () => {
  it('組み込みだけの実際の一覧で、案内が出る(以前は一度も出なかった)', () => {
    const { q } = launcher(false);
    expect(q('launcher-no-own'), '案内が出ていない').not.toBeNull();
    const text = q('launcher-no-own')!.textContent!;
    // 案内が指すボタンの字は、画面にある字から引く
    expect(text).toContain(`「${q('launcher-add-go')!.textContent}」`);
    expect(text).toContain('「アプリとして登録」');
    expect(q('launcher-empty'), '「絞り込み」の文が出ている').toBeNull();
  });
  it('自分のタイルが 1 つ在れば出ない / 絞り込み中も出ない', () => {
    expect(launcher(true).q('launcher-no-own')).toBeNull();
    const h = launcher(false);
    h.d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'zzzz' });
    h.r.render(h.d.getState());
    expect(h.q('launcher-no-own')).toBeNull();
    expect(h.q('launcher-empty')!.textContent).toBe('絞り込みに一致するものがありません');
  });
  it('名前欄の案内に、省くとアドレスが名前になることが書いてある', () => {
    expect((launcher(false).q('launcher-add-name') as HTMLInputElement).placeholder).toContain(
      'アドレスが名前',
    );
  });
});

describe('A2 アプリの設定を断るとき、理由を言い、欄を戻す', () => {
  const booted = (): AppState =>
    reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a1'), meta('b1')],
      relations: [],
    }).state;

  it('編集中 / 保存中は理由が出る', () => {
    const editing = { ...booted(), phase: 'editing' as const };
    const e = reduce(editing, { type: 'SET_APP_TILE', lid: 'a1', registered: true }).state;
    expect(e.error).toBe(`${phaseBlockReason('editing')}設定できます`);
    const locked = { ...booted(), writeLock: { lid: 'b1' } } as unknown as AppState;
    expect(reduce(locked, { type: 'SET_APP_TILE', lid: 'a1', registered: true }).state.error).toBe(
      APPEND_BUSY_NOTE,
    );
  });

  it('断られたチェックは保存してある値へ戻る', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '---\nattachment.name: a.html\n---\n説明\n',
      getBodies: async () => [],
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('unused')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
      deleteEntry: async () => {},
      setEntryParent: async () => {},
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a1')], relations: [] });
    bindActions(root, d);
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.setAttribute('data-pkc-action', 'toggle-app-tile');
    check.setAttribute(TARGET_LID_ATTR, 'a1');
    check.defaultChecked = false;
    root.append(check);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await new Promise((r) => setTimeout(r, 20));
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提: 編集中').toBe('editing');
    check.checked = true;
    check.dispatchEvent(new Event('change', { bubbles: true }));
    expect(d.getState().error, '理由が出ていない').toContain('設定できます');
    expect(check.checked, '欄が新しい値のまま').toBe(false);
  });
});

describe('A4 グループ並べ替えの確認の字', () => {
  it('右クリックのメニューの「タイルを並べ替える」と同じ字にしない', () => {
    expect(APP_GROUP_REORDER_OK_LABEL).toBe('グループを並べ替える');
    expect(Object.values(ENTRY_ACTION_LABELS)).not.toContain(APP_GROUP_REORDER_OK_LABEL);
  });
});
