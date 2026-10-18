/** @vitest-environment happy-dom */
/**
 * 🔴 **複数件の操作は、件数にかかわらず state listener を定数回しか呼ばない**(`Dispatcher.batch`)。
 *
 * 経路ごとに「N 件で通知が N 回に戻らない」を pin する(batch を外す変異を、どの経路でも殺す)。
 * - `moveEntries` は `dual-pane-select.test.ts` の 300 件で見ている
 * - ここは dual-copy / undo-dual-move / 右クリックの印の戻し / `linkLaunchedFiles` /
 *   store-effects の ENTRY_BODY_REFRESHED ×2(改名のリンク更新・Office の書き戻し)/ ゴミ箱の「元に戻す」
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import type { AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { clearDualMoveOffer } from '../../src/adapter/ui/render/dual-move-undo';
import { linkLaunchedFiles, type LaunchedHandle } from '../../src/adapter/platform/launched-files';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

const N = 120;
/** 定数と見なす上限(batch が無いと N 以上になる)。 */
const CONST_MAX = 12;

function meta(lid: string, order: number, archetype = 'text', title = lid): EntryMeta {
  return {
    lid,
    title,
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
const notes = (n: number, from = 10): EntryMeta[] =>
  Array.from({ length: n }, (_, i) => meta(`m${String(i)}`, from + i));
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 通知のうち、`pick` の値が前回から変わった回数を数える(無関係な知らせを数えない)。 */
function countChanges<T>(d: Dispatcher, pick: (s: AppState) => T): { n: () => number } {
  let last = pick(d.getState());
  let n = 0;
  d.onState((s) => {
    const now = pick(s);
    if (now !== last) n += 1;
    last = now;
  });
  return { n: () => n };
}
/** 通知の総数。 */
function countAll(d: Dispatcher): { n: () => number } {
  let n = 0;
  d.onState(() => {
    n += 1;
  });
  return { n: () => n };
}

beforeEach(() => {
  document.body.textContent = '';
  clearDualMoveOffer();
});

function binderSetup(metas: EntryMeta[], relations: Relation[] = []) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.onState((s) => browse.render(s, 'filer'));
  bindActions(root, d, {
    readBodies: async (lids) => new Map(lids.map((l) => [l, '# 本文'])),
    showStatus: () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  const press = (action: string): void => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', action);
    root.append(b);
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    b.remove();
  };
  return { root, d, press, browse };
}

const FOLDER_METAS = (): EntryMeta[] => [meta('f1', 1, 'folder'), ...notes(N)];

describe('dual-copy: N 件のコピーでも state listener は定数回', () => {
  it('🔴 作成の通知が件数ぶん走らない(作られたことは確かめる)', async () => {
    const { d, press } = binderSetup(FOLDER_METAS());
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'm0', mode: 'set' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: `m${String(N - 1)}`, mode: 'range' });
    const before = d.getState().entryMetas.size;
    const c = countAll(d);
    press('dual-copy');
    await tick();
    await tick();
    expect(d.getState().entryMetas.size - before, '前提: コピーが N 件できていない').toBe(N);
    expect(c.n(), `通知が ${String(c.n())} 回(件数ぶん走っている)`).toBeLessThan(CONST_MAX);
  });
});

describe('undo-dual-move: N 件を戻しても state listener は定数回', () => {
  it('🔴 戻しの通知が件数ぶん走らない(戻ったことは確かめる)', () => {
    const { d, press } = binderSetup(FOLDER_METAS());
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'm0', mode: 'set' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: `m${String(N - 1)}`, mode: 'range' });
    press('dual-move');
    const parentsOf = (lid: string) =>
      d.getState().relations.filter((r) => r.toLid === lid && r.kind === 'structural').map((r) => r.fromLid);
    expect(parentsOf('m0'), '前提: 移せていない').toEqual(['f1']);
    const c = countAll(d);
    press('undo-dual-move');
    expect(parentsOf('m0'), '前提: 戻せていない').toEqual([]);
    expect(parentsOf(`m${String(N - 1)}`), '前提: 最後の 1 件が戻せていない').toEqual([]);
    expect(c.n(), `通知が ${String(c.n())} 回(件数ぶん走っている)`).toBeLessThan(CONST_MAX);
  });
});

describe('行の右クリック: 印を戻す TOGGLE_SELECT は定数回', () => {
  it('🔴 印が N 件あっても通知が件数ぶん走らない(印が復元されたことは確かめる)', () => {
    const { d, root } = binderSetup(notes(N));
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')?.click();
    for (let i = 0; i < N; i += 1) d.dispatch({ type: 'TOGGLE_SELECT', lid: `m${String(i)}` });
    expect(d.getState().selection.length, '前提: 印が付いていない').toBe(N);
    const row = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"] [data-pkc-entry="m0"]');
    expect(row, '前提: 台に行が無い').not.toBeNull();
    const c = countAll(d);
    row!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    expect(d.getState().selection.length, '前提: 右クリックの後も印が残っていない').toBe(N);
    expect(c.n(), `通知が ${String(c.n())} 回(件数ぶん走っている)`).toBeLessThan(CONST_MAX);
  });
});

describe('linkLaunchedFiles(main.ts の OS から開いた md の紐づけ)', () => {
  it('🔴 FILE_LINKED の通知が件数ぶん走らない(紐づいたことと remember を確かめる)', () => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: notes(N), relations: [] });
    const lids = Array.from({ length: N }, (_, i) => `m${String(i)}`);
    const handles = lids.map(() => ({}) as LaunchedHandle);
    const files = lids.map((l) => new File(['x'], `${l}.md`));
    const remembered: string[] = [];
    const c = countAll(d);
    linkLaunchedFiles(d, { remember: (lid) => void remembered.push(lid) }, lids, handles, files);
    expect(remembered.length, '前提: remember が件数ぶん呼ばれていない').toBe(N);
    expect(d.getState().linkedFiles.size, '前提: 紐づいていない').toBe(N);
    expect(c.n(), `通知が ${String(c.n())} 回`).toBeLessThan(CONST_MAX);
  });
});

describe('store-effects: 複数件の書き戻しでも state listener は定数回', () => {
  const portOf = (over: Partial<StorePort>): StorePort =>
    ({
      ...stubRevisionOps(),
      getBody: async () => '',
      renameEntry: async () => stubStamps(),
      ...over,
    }) as unknown as StorePort;
  const others = (): Array<{ lid: string; body: string; stamps: ReturnType<typeof stubStamps> }> =>
    Array.from({ length: N }, (_, i) => ({ lid: `m${String(i)}`, body: `改 ${String(i)}`, stamps: stubStamps() }));

  it('🔴 改名のリンク更新(ENTRY_BODY_REFRESHED + ENTRY_STAMPED)', async () => {
    const d = new Dispatcher();
    connectStoreEffects(
      d,
      portOf({
        renameLinkTexts: async () => ({ wrote: others(), links: N }),
      }),
    );
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('t', 1, 'text', '旧'), ...notes(N)], relations: [] });
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 't', title: '新' });
    const c = countChanges(d, (s) => s.entryMetas);
    await tick();
    await tick();
    expect(d.getState().notice ?? '', '前提: リンク更新の経路を通っていない').toContain(`${String(N)} 件のノートのリンクの字も更新しました`);
    expect(c.n(), `entryMetas の通知が ${String(c.n())} 回`).toBeLessThan(CONST_MAX);
  });

  it('🔴 Office の書き戻し(ENTRY_BODY_REFRESHED + ENTRY_STAMPED)', async () => {
    const d = new Dispatcher();
    connectStoreEffects(
      d,
      portOf({
        replaceAssetRefs: async () => ({ problem: null, unchanged: false, wrote: others(), stale: [], overBudget: false }),
      }),
    );
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('att', 1, 'attachment'), ...notes(N)], relations: [] });
    const c = countChanges(d, (s) => s.entryMetas);
    d.dispatch({
      type: 'OFFICE_ASSET_SAVED',
      lid: 'att',
      newKey: 'k',
      newHash: null,
      newBytes: 1,
      newName: 'a.docx',
      newMime: 'application/octet-stream',
      savedAt: '2026-01-01T00:00:00Z',
    });
    await tick();
    await tick();
    expect(c.n(), '前提: stamp が 1 回も通っていない(経路を通っていない)').toBeGreaterThan(0);
    expect(c.n(), `entryMetas の通知が ${String(c.n())} 回`).toBeLessThan(CONST_MAX);
  });

  it('🔴 同じ ID のノートが既にあるものは、1 回の OP_FAILED にまとめて言う(最後の 1 件に潰さない)', async () => {
    const d = new Dispatcher();
    const lids = ['a', 'b', 'c'];
    connectStoreEffects(
      d,
      portOf({
        listTrash: async () =>
          lids.map((l, i) => ({ id: `rev${String(i)}`, entry_lid: l, created_at: null, title: l, archetype: 'text' })),
      }),
    );
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a', 1, 'text', 'あ'), meta('b', 2, 'text', 'い'), meta('c', 3, 'text', 'う')],
      relations: [],
    });
    const errors: string[] = [];
    d.onState((s) => {
      if (s.error !== null && errors.at(-1) !== s.error) errors.push(s.error);
    });
    d.dispatch({ type: 'UNDO_TRASH', lids });
    await tick();
    await tick();
    expect(errors.length, '集積地に届く error は 1 件').toBe(1);
    expect(errors[0]).toBe('3 件は同じ ID のノートがあるため戻せませんでした:あ / い / う');
  });
});
