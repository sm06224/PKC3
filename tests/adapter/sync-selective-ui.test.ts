/** @vitest-environment happy-dom */
/**
 * 🔴 **選択同期の画面(#2066 段 5-B)── 設定・情報ペイン・右クリック・一覧の印**。
 *
 * 守る主張:
 * 1. 同期が切・「コレクション全体」の間は、選択同期の画面を何も出さない(属性・印・欄・メニュー項目・設定の詳細)
 * 2. 「選んだエントリだけ同期」のとき、`direct / descendant / related / ancestor / 対象外` を出し分ける
 * 3. 🔴 **置けるなら外せる**: フォルダを右クリックで同期対象にすると、配下が即時に `descendant`、外すと即時に戻る
 * 4. 設定: 範囲の切替・関連の範囲の切替・件数の要約・一括解除(直接指定が 0 件なら押せない)・同期が切なら見出しごと隠す
 *
 * ⚠ 台は実物(shell + BrowseRouter + 情報ペイン + binder + 係 `SyncScopeKeeper`)。worker だけ偽物(設定を持ち、材料を返す)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { SyncScopeKeeper, type SyncScopeDeps } from '../../src/adapter/ui/actions/sync-scope';
import { createSyncSelectiveSection, SYNC_SELECTIVE_NOTE } from '../../src/adapter/ui/render/settings/sync-selective';
import { SyncEnabledStore } from '../../src/adapter/ui/render/sync-enabled';
import { buildSyncScopeView, SELECTIVE_EMPTY_TEXT } from '../../src/features/sync/selective-view';

function meta(lid: string, order: number, archetype = 'text'): EntryMeta {
  return { lid, title: 't-' + lid, archetype, createdAt: null, updatedAt: null, entryOrder: order, status: null, date: null, archived: false, bodyChars: null };
}
const rel = (id: string, fromLid: string, toLid: string, kind = 'structural'): Relation => ({ id, fromLid, toLid, kind, createdAt: null, updatedAt: null });

const METAS = [meta('F', 1, 'folder'), meta('n1', 2), meta('p', 3), meta('q', 4)];
const RELS = [rel('s1', 'F', 'n1')];
const RAW_NOTES = [
  { lid: 'F', archetype: 'folder', parentLid: null },
  { lid: 'n1', archetype: 'text', parentLid: 'F' },
  { lid: 'p', archetype: 'text', parentLid: null },
  { lid: 'q', archetype: 'text', parentLid: null },
];
const MENU = '[data-pkc-region="context-menu"]';
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
});

function setup(opts: { on: boolean; mode: 'all' | 'selective'; direct?: string[] }) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  const inspector = new InspectorRenderer(regions.inspector);
  d.onState((s) => {
    browse.render(s, 'filer');
    inspector.render(s);
  });
  let on = opts.on;
  let setting = { mode: opts.mode as 'all' | 'selective', related: '1hop' as 'off' | '1hop' | 'recursive', directLids: [...(opts.direct ?? [])] };
  const ops: string[] = [];
  const deps: SyncScopeDeps = {
    cid: 'c1',
    enabled: () => on,
    request: (async (req: Record<string, unknown>) => {
      ops.push(String(req.op));
      if (req.op === 'syncSetSelectiveScope') {
        const set = new Set(setting.directLids);
        for (const l of (req.add as string[] | undefined) ?? []) set.add(l);
        for (const l of (req.remove as string[] | undefined) ?? []) set.delete(l);
        setting = { mode: (req.mode as 'all') ?? setting.mode, related: (req.related as '1hop') ?? setting.related, directLids: [...set].sort() };
        return setting;
      }
      const sel = setting.mode === 'selective';
      return {
        selective: { ...setting, directLids: [...setting.directLids] },
        notes: sel ? RAW_NOTES : [],
        relations: sel ? [{ from: 'n1', to: 'q', kind: 'semantic' }] : [],
        bodyRefs: {},
      };
    }) as SyncScopeDeps['request'],
    publish: (v) => d.dispatch({ type: 'SET_SYNC_SCOPE', scope: v }),
    current: () => d.getState().syncScope,
  };
  const keeper = new SyncScopeKeeper(deps);
  bindActions(root, d, {
    syncScope: {
      setMode: (m) => keeper.setMode(m),
      setRelated: (r) => keeper.setRelated(r),
      setDirect: (lid, v) => keeper.setDirect(lid, v),
      clearAll: () => keeper.clearAll(),
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [...METAS], relations: [...RELS] });
  // フォルダの中の行も同じ一覧に出す(「中まで全部出す」)
  d.dispatch({ type: 'SET_FILER_FLATTEN', on: true });
  const row = (lid: string): HTMLElement => {
    const el = regions.browseHost.querySelector<HTMLElement>(`tbody tr[data-pkc-entry="${lid}"]`);
    expect(el, `前提: 一覧に ${lid} の行が無い`).not.toBeNull();
    return el!;
  };
  const scopeOf = (lid: string): string | null => row(lid).getAttribute('data-pkc-sync-scope');
  const markOf = (lid: string): HTMLElement | null => row(lid).querySelector('[data-pkc-field="sync-scope-mark"]');
  const rightClick = (lid: string): void => {
    root.querySelector(MENU)?.remove();
    row(lid).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  };
  const menuHas = (a: string): boolean => root.querySelector(`${MENU} [data-pkc-action="${a}"]`) !== null;
  const press = (a: string): void => {
    const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${a}"]`);
    expect(b, `メニューに ${a} が無い`).not.toBeNull();
    b!.click();
  };
  const insp = (): HTMLElement => regions.inspector.querySelector<HTMLElement>('[data-pkc-field="inspector-sync-scope"]')!;
  const inspStatus = (): string => insp().querySelector('[data-pkc-field="inspector-sync-scope-status"]')?.textContent ?? '';
  const inspBtn = (a: string): HTMLButtonElement => insp().querySelector<HTMLButtonElement>(`[data-pkc-action="${a}"]`)!;
  return {
    root,
    d,
    keeper,
    ops,
    scopeOf,
    markOf,
    rightClick,
    menuHas,
    press,
    insp,
    inspStatus,
    inspBtn,
    setOn: (v: boolean) => void (on = v),
    select: (lid: string) => d.dispatch({ type: 'SELECT_ENTRY', lid }),
  };
}

function expectNothingShown(s: ReturnType<typeof setup>): void {
  for (const lid of ['F', 'n1', 'p', 'q']) {
    expect(s.scopeOf(lid), `${lid} に属性が付いた`).toBeNull();
    expect(s.markOf(lid), `${lid} に印が付いた`).toBeNull();
  }
  s.select('n1');
  expect(s.insp().hidden, '情報ペインの「同期対象」が出た').toBe(true);
  s.rightClick('F');
  expect(s.menuHas('sync-select-entry')).toBe(false);
  expect(s.menuHas('sync-unselect-entry')).toBe(false);
}

describe('選択同期の画面 ── 出さないとき', () => {
  it('🔴 同期が切: worker に聞かず、何も出さない(直接指定が残っていても)', async () => {
    const s = setup({ on: false, mode: 'selective', direct: ['F'] });
    await s.keeper.refresh();
    await flush();
    expect(s.ops).toEqual([]);
    expectNothingShown(s);
  });

  it('🔴 コレクション全体: 何も出さない', async () => {
    const s = setup({ on: true, mode: 'all', direct: ['F'] });
    await s.keeper.refresh();
    await flush();
    expect(s.d.getState().syncScope?.mode).toBe('all');
    expectNothingShown(s);
  });
});

describe('選択同期の画面 ── 選んだエントリだけ同期', () => {
  it('🔴 フォルダを右クリックで同期対象にすると配下が即時 descendant、外すと即時に戻る(双方向)', async () => {
    const s = setup({ on: true, mode: 'selective' });
    await s.keeper.refresh();
    await flush();
    // 0 件: 印は無い。メニューは「する」だけ
    expect(s.scopeOf('F')).toBeNull();
    s.rightClick('F');
    expect(s.menuHas('sync-select-entry')).toBe(true);
    expect(s.menuHas('sync-unselect-entry')).toBe(false);
    s.press('sync-select-entry');
    await flush();
    expect(s.scopeOf('F')).toBe('direct');
    expect(s.scopeOf('n1')).toBe('descendant');
    expect(s.scopeOf('q'), 'n1 とつながる q は関連').toBe('related');
    expect(s.scopeOf('p'), 'フォルダの外の私的なメモに印が付いた').toBeNull();
    expect(s.markOf('p')).toBeNull();
    expect(s.markOf('F')?.getAttribute('data-pkc-sync-scope')).toBe('direct');
    expect(s.markOf('n1')?.title).toContain('同期対象(親フォルダ配下)');
    // メニューは「外す」だけに替わる
    s.rightClick('F');
    expect(s.menuHas('sync-select-entry')).toBe(false);
    expect(s.menuHas('sync-unselect-entry')).toBe(true);
    s.press('sync-unselect-entry');
    await flush();
    for (const lid of ['F', 'n1', 'q', 'p']) expect(s.scopeOf(lid), `${lid} が戻らない`).toBeNull();
  });

  it('情報ペイン: 理由を言葉で出し、配下ならどのフォルダからかを添える。ボタンは対で替わる', async () => {
    const s = setup({ on: true, mode: 'selective', direct: ['F'] });
    await s.keeper.refresh();
    await flush();
    s.select('n1');
    expect(s.insp().hidden).toBe(false);
    expect(s.inspStatus()).toBe('同期対象(親フォルダ配下)');
    expect(s.insp().querySelector('[data-pkc-field="inspector-sync-scope-via"]')?.textContent).toBe('親フォルダ「t-F」が同期対象のため含まれます');
    expect(s.inspBtn('sync-select-entry').hidden).toBe(false);
    expect(s.inspBtn('sync-unselect-entry').hidden).toBe(true);
    s.select('q');
    expect(s.inspStatus()).toBe('同期対象(関連により自動追加)');
    s.select('p');
    expect(s.inspStatus()).toBe('同期対象外(この端末のみ)');
    // 情報ペインから付ける → 直接指定になり「外す」に替わる
    s.inspBtn('sync-select-entry').click();
    await flush();
    expect(s.inspStatus()).toBe('同期対象(直接指定)');
    expect(s.inspBtn('sync-select-entry').hidden).toBe(true);
    expect(s.inspBtn('sync-unselect-entry').hidden).toBe(false);
    s.inspBtn('sync-unselect-entry').click();
    await flush();
    expect(s.inspStatus()).toBe('同期対象外(この端末のみ)');
    // フォルダは「配下を」と説明する
    s.select('F');
    expect(s.inspStatus()).toBe('同期対象(直接指定)');
    s.select('n1');
  });

  it('関連エントリの親フォルダは「親フォルダの階層のみ」', async () => {
    const s = setup({ on: true, mode: 'selective', direct: ['n1'] });
    await s.keeper.refresh();
    await flush();
    expect(s.scopeOf('n1')).toBe('direct');
    expect(s.scopeOf('F')).toBe('ancestor');
    s.select('F');
    expect(s.inspStatus()).toBe('同期対象(親フォルダの階層のみ)');
    expect(s.inspBtn('sync-select-entry').title).toContain('このフォルダ配下');
  });

  it('🔴 コレクション全体へ戻すと、印・欄・メニューがすべて消える', async () => {
    const s = setup({ on: true, mode: 'selective', direct: ['F'] });
    await s.keeper.refresh();
    await flush();
    expect(s.scopeOf('n1')).toBe('descendant');
    await s.keeper.setMode('all');
    await flush();
    expectNothingShown(s);
  });

  it('🔴 同期を切にすると(係が null を入れると)すべて消える', async () => {
    const s = setup({ on: true, mode: 'selective', direct: ['F'] });
    await s.keeper.refresh();
    await flush();
    s.setOn(false);
    await s.keeper.refresh();
    await flush();
    expect(s.d.getState().syncScope).toBeNull();
    expectNothingShown(s);
  });
});

describe('設定の「同期の範囲」', () => {
  function section(on: boolean, state: AppState) {
    const region = document.createElement('div');
    document.body.replaceChildren(region);
    const store = new SyncEnabledStore(null);
    store.setEnabled(on);
    const sec = createSyncSelectiveSection(region, store);
    const dl = document.createElement('dl');
    dl.append(...(sec.build() as Node[]));
    region.append(dl);
    sec.sync(state);
    const q = <T extends HTMLElement>(sel: string): T => region.querySelector<T>(sel)!;
    const pressed = (field: string): string[] =>
      [...region.querySelectorAll<HTMLElement>(`[data-pkc-field="${field}"] button[aria-pressed="true"]`)].map((b) => b.textContent ?? '');
    return { region, store, sec, q, pressed };
  }
  const withScope = (mode: 'all' | 'selective', related: 'off' | '1hop' | 'recursive', direct: string[]): AppState => ({
    ...initialState,
    syncScope: buildSyncScopeView({ selective: { mode, related, directLids: direct }, notes: RAW_NOTES, relations: [], bodyRefs: {} }),
  });

  it('🔴 同期が切なら見出しごと隠す(対照群: 入なら出る)', () => {
    const off = section(false, withScope('selective', '1hop', ['F']));
    expect(off.q('[data-pkc-region="settings-sync-selective"]').hidden).toBe(true);
    expect(off.q('[data-pkc-field="sync-selective-term"]').hidden).toBe(true);
    const on = section(true, withScope('all', '1hop', []));
    expect(on.q('[data-pkc-region="settings-sync-selective"]').hidden).toBe(false);
    expect(on.q('[data-pkc-field="sync-selective-term"]').textContent).toBe('同期の範囲');
  });

  it('コレクション全体: 範囲だけを出し、詳細(関連・件数・一括解除)は畳む', () => {
    const s = section(true, withScope('all', '1hop', []));
    expect(s.pressed('sync-scope-mode')).toEqual(['コレクション全体(既定)']);
    expect(s.q('[data-pkc-field="sync-selective-detail"]').hidden).toBe(true);
  });

  it('選択同期: 関連の範囲・件数の要約・一括解除・注記を出す。直接指定 0 件なら一括解除を押せず案内を出す', () => {
    const s = section(true, withScope('selective', 'off', ['F']));
    expect(s.pressed('sync-scope-mode')).toEqual(['選んだエントリだけ同期(選択同期)']);
    expect(s.q('[data-pkc-field="sync-selective-detail"]').hidden).toBe(false);
    expect(s.pressed('sync-scope-related')).toEqual(['含めない']);
    expect(s.q('[data-pkc-field="sync-selective-summary"]').textContent).toBe('同期対象: 合計 2 件(直接指定 1 / フォルダ配下 1 / 関連 0 / 親フォルダ 0)');
    expect(s.q<HTMLButtonElement>('[data-pkc-action="clear-sync-selection"]').disabled).toBe(false);
    expect(s.region.textContent).toContain(SYNC_SELECTIVE_NOTE);
    // 切替が映る(対照群: 前の状態)
    s.sec.sync(withScope('selective', 'recursive', []));
    expect(s.pressed('sync-scope-related')).toEqual(['関連先を再帰的に含める']);
    expect(s.q('[data-pkc-field="sync-selective-summary"]').textContent).toBe(SELECTIVE_EMPTY_TEXT);
    expect(s.q<HTMLButtonElement>('[data-pkc-action="clear-sync-selection"]').disabled).toBe(true);
  });

  it('押し所が係へ届く(範囲・関連・一括解除)', async () => {
    const calls: string[] = [];
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const d = new Dispatcher();
    bindActions(root, d, {
      syncScope: {
        setMode: (m) => void calls.push(`mode:${m}`),
        setRelated: (r) => void calls.push(`related:${r}`),
        setDirect: () => undefined,
        clearAll: () => void calls.push('clear'),
      },
    });
    const store = new SyncEnabledStore(null);
    store.setEnabled(true);
    const sec = createSyncSelectiveSection(root, store);
    const dl = document.createElement('dl');
    dl.append(...(sec.build() as Node[]));
    root.append(dl);
    sec.sync(withScope('selective', '1hop', ['F']));
    root.querySelector<HTMLElement>('[data-pkc-sync-scope-mode="selective"]')!.click();
    root.querySelector<HTMLElement>('[data-pkc-sync-scope-related="recursive"]')!.click();
    root.querySelector<HTMLElement>('[data-pkc-action="clear-sync-selection"]')!.click();
    await flush();
    expect(calls).toEqual(['mode:selective', 'related:recursive', 'clear']);
  });
});

describe('2 ペインの行(#2066 段 5-B レビュー)', () => {
  it('🔴 選択同期のときだけ、左の一覧と同じ属性と印を付け、付け外しで描き直る / 全体・切では付けない', () => {
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const dual = new DualFilerRenderer(regions.center);
    d.onState((s) => dual.render(s));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [...METAS], relations: [...RELS] });
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    const tr = (lid: string): HTMLElement | null =>
      regions.center.querySelector<HTMLElement>(`[data-pkc-region="dual-pane"][data-pkc-side="left"] tr[data-pkc-entry="${lid}"]`);
    expect(tr('F'), '前提: 2 ペインに F の行が無い').not.toBeNull();
    const view = (mode: 'all' | 'selective', direct: string[]) =>
      buildSyncScopeView({ selective: { mode, related: 'off', directLids: direct }, notes: RAW_NOTES, relations: [], bodyRefs: {} });
    d.dispatch({ type: 'SET_SYNC_SCOPE', scope: view('selective', ['F']) });
    expect(tr('F')!.getAttribute('data-pkc-sync-scope')).toBe('direct');
    expect(tr('F')!.querySelector('[data-pkc-field="sync-scope-mark"]')?.getAttribute('data-pkc-sync-scope')).toBe('direct');
    expect(tr('p')!.hasAttribute('data-pkc-sync-scope')).toBe(false);
    expect(tr('p')!.querySelector('[data-pkc-field="sync-scope-mark"]')).toBeNull();
    d.dispatch({ type: 'SET_SYNC_SCOPE', scope: view('all', ['F']) });
    expect(tr('F')!.hasAttribute('data-pkc-sync-scope'), '全体へ戻しても属性が残った').toBe(false);
    expect(regions.center.querySelectorAll('[data-pkc-field="sync-scope-mark"]').length).toBe(0);
    d.dispatch({ type: 'SET_SYNC_SCOPE', scope: view('selective', ['p']) });
    expect(tr('p')!.getAttribute('data-pkc-sync-scope')).toBe('direct');
    d.dispatch({ type: 'SET_SYNC_SCOPE', scope: null });
    expect(regions.center.querySelectorAll('[data-pkc-sync-scope]').length).toBe(0);
  });
});
