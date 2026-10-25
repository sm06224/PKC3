/** @vitest-environment happy-dom */
/**
 * 🔴 **計った時間の面**(#683 ①。user 要望 2026-09-03「時間を測る…も…組み込みアプリにしたい」)。
 *
 * 見るのは user が見て押せるもの:
 * ①日ごとの束・時刻・名前・合計が出る ②「まだ」「駄目だった」「無い」「絞りで 0 件」を取り違えない
 * ③🔴 **消す・名前を直す・外す**は**保存された本文**の行を書き換える(観測点は本文。画面だけ動く緑を通さない)
 * ④消したら「元に戻す」が出る ⑤編集中は書かない ⑥中央の器(別窓)でも左のタブでも同じ ⑦退避先は左のタブ ⑧タイルがある
 */
import { stubStamps } from '../helpers/store-stamps';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { TimersRenderer } from '../../src/adapter/ui/render/timers';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { BROWSE_TABS } from '../../src/adapter/ui/render/browse';
import { BROWSE_MODES, browseScanOf, hasPaneHome, homeTabOf } from '../../src/adapter/ui/render/browse-mode';
import { BROWSE_ICONS } from '../../src/adapter/ui/render/icons';
import { withBuiltinTiles } from '../../src/features/launcher/tiles';
import { stubRevisionOps } from '../helpers/revision-stub';
import { workRunsOf, type WorkLogScan } from '../../src/features/timer/work-log';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { answerDialog, openDialog } from './dialog-helper';

const A = '- 作業 2026-08-27 06:40–07:03(23:11)';
const B = '- 作業 2026-08-28 09:00–09:30(30:00) 請求';
const BODY = `会議メモ\n${A}\n${B}\n終わり\n`;
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 0,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
    ...over,
  };
}

const scanOf = (bodies: Record<string, string>, truncated = false): WorkLogScan => ({
  runs: Object.entries(bodies).flatMap(([lid, b]) => workRunsOf(lid, b)),
  totalNotes: Object.keys(bodies).length,
  scannedNotes: Object.keys(bodies).length,
  truncated,
});

function paint(state: Partial<AppState>): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  new TimersRenderer(host).render({
    ...initialState,
    entryMetas: new Map([['e1', meta('e1')]]),
    ...state,
  } as AppState);
  return host;
}
const note = (h: HTMLElement): string => h.querySelector('[data-pkc-field="timers-note"]')?.textContent ?? '';
const rows = (h: HTMLElement): HTMLElement[] => [...h.querySelectorAll<HTMLElement>('[data-pkc-work-run]')];

function setup(bodies: Record<string, string>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const store: Record<string, string> = { ...bodies };
  const persisted: EntryUpsert[] = [];
  const host = document.createElement('div');
  host.setAttribute('data-pkc-browse-pane', 'timers');
  regions.browseHost.append(host);
  const view = new TimersRenderer(host);
  d.onState((s) => view.render(s));
  bindActions(root, d);
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      persisted.push(e);
      store[e.lid] = e.body;
      return stubStamps();
    },
    // 実 worker の代わり ── 本文から集める(書き換え後の集め直しが一覧に追いつくことも見る)
    workLogScan: async () => scanOf(store),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: Object.keys(bodies).map((l) => meta(l)), relations: [] });
  d.dispatch({ type: 'REFRESH_WORK_LOG_SCAN' });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { root, d, q, persisted, store, host };
}

afterEach(() => resetAppDialogForTest());

describe('計った時間の面', () => {
  it('🔴 日ごとの束に、時刻・名前・合計が出る(新しい日が先)', () => {
    const h = paint({ workLogScan: scanOf({ e1: BODY }) });
    const heads = [...h.querySelectorAll('[data-pkc-field="timers-day-head"]')].map((e) => e.textContent);
    expect(heads).toEqual(['2026-08-28(1 件・合計 30:00)', '2026-08-27(1 件・合計 23:11)']);
    const r = rows(h);
    expect(r).toHaveLength(2);
    expect(r[0]!.querySelector('[data-pkc-field="timers-when"]')?.textContent).toBe('09:00–09:30(30:00)');
    expect(r[0]!.querySelector('[data-pkc-field="timers-name"]')?.textContent).toBe('請求');
    // 名前の無い行には名前の欄も「名前を外す」も出ない(対照)
    expect(r[1]!.querySelector('[data-pkc-field="timers-name"]')).toBeNull();
    expect(r[1]!.querySelector('[data-pkc-timer-clear]')).toBeNull();
    expect(r[0]!.querySelector('[data-pkc-timer-clear]'), '名前のある行に「名前を外す」が無い').not.toBeNull();
    expect(note(h)).toBe('2 件・合計 53:11');
    // ノートの名前は既存の select-entry でそのノートを開く
    const open = r[0]!.querySelector('[data-pkc-field="timers-note-open"]')!;
    expect(open.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(open.getAttribute('data-pkc-entry')).toBe('e1');
  });

  it('🔴 「まだ」と「駄目だった」と「無い」と「絞りで 0 件」を取り違えない', () => {
    expect(note(paint({ workLogScan: null }))).toContain('集めています');
    expect(note(paint({ workLogScan: null, workLogScanFailed: true }))).toContain('集められませんでした');
    expect(note(paint({ workLogScan: scanOf({}) }))).toContain('まだありません');
    const none = paint({ workLogScan: scanOf({ e1: BODY }), filterQuery: 'ない語' });
    expect(note(none)).toContain('絞り込みに一致する');
    expect(none.querySelector('[data-pkc-action="clear-entry-filter"]'), '絞りを外す道が無い').not.toBeNull();
    // 対照: 本当に 0 件のときは「絞りを外す」を出さない(押しても何も起きない口を置かない)
    expect(paint({ workLogScan: scanOf({}), filterQuery: 'x' }).querySelector('[data-pkc-action="clear-entry-filter"]')).toBeNull();
    // 切ったことを言う
    expect(note(paint({ workLogScan: scanOf({ e1: BODY }, true) }))).toContain('途中まで');
  });

  it('消えたノート・片付けたノートの行は出ない', () => {
    const scan = scanOf({ e1: BODY, e2: A, e3: A });
    const h = paint({
      workLogScan: scan,
      entryMetas: new Map([['e1', meta('e1')], ['e3', meta('e3', { archived: true })]]),
    });
    expect(rows(h).map((r) => r.getAttribute('data-pkc-work-run')?.split(':')[0])).toEqual(['e1', 'e1']);
  });

  it('🔴 中央の器(view=timers)でも同じ一覧が出る / 退避先は左のタブ / タブ・図案・タイルがある', () => {
    const host = document.createElement('div');
    document.body.append(host);
    new CenterRouter(host).render({
      ...initialState,
      entryMetas: new Map([['e1', meta('e1')]]),
      viewMode: 'timers',
      workLogScan: scanOf({ e1: BODY }),
    } as AppState);
    const pane = host.querySelector<HTMLElement>('[data-pkc-view-pane="timers"]');
    expect(pane?.hidden).toBe(false);
    expect(rows(pane!)).toHaveLength(2);
    expect(homeTabOf('timers')).toBe('timers');
    expect(hasPaneHome('timers')).toBe(true);
    expect(BROWSE_MODES).toContain('timers');
    expect(BROWSE_TABS.find((t) => t.mode === 'timers')?.label).toBe('時間');
    expect(BROWSE_ICONS.timers).toBe('timer');
    expect(browseScanOf('timers')).toBe('REFRESH_WORK_LOG_SCAN');
    expect(withBuiltinTiles([], { office: false }).find((t) => t.kind === 'timers')?.title).toBe('計った時間');
  });
});

describe('計った時間を直す・消す(本文が正本)', () => {
  const press = (root: HTMLElement, action: string, run: string, clear = false): HTMLElement => {
    const li = root.querySelector(`[data-pkc-work-run="${run}"]`);
    expect(li, `${run} の行が出ていない`).not.toBeNull();
    const sel = clear ? `[data-pkc-action="${action}"][data-pkc-timer-clear]` : `[data-pkc-action="${action}"]:not([data-pkc-timer-clear])`;
    const b = li!.querySelector<HTMLElement>(sel);
    expect(b, `${action} が無い`).not.toBeNull();
    return b!;
  };

  it('🔴 消す: 保存された本文からその行だけが無くなり、一覧も追いつき、「元に戻す」が出る', async () => {
    const { root, persisted, store, d } = setup({ e1: BODY });
    await tick();
    press(root, 'timer-run-delete', 'e1:1').click();
    await tick(40);
    expect(persisted, '本文が書かれていない').toHaveLength(1);
    expect(store['e1'], 'その行だけが消えていない').toBe(`会議メモ\n${B}\n終わり\n`);
    // 集め直しで一覧が追いつく(消した行が残らない)
    expect(root.querySelectorAll('[data-pkc-work-run]')).toHaveLength(1);
    expect(d.getState().notice ?? '').toContain('計った時間の行を消しました');
  });

  it('🔴 名前を外す: 行の終わりの名前だけが無くなる', async () => {
    const { root, store } = setup({ e1: BODY });
    await tick();
    press(root, 'timer-run-rename', 'e1:2', true).click();
    await tick(40);
    expect(store['e1']).toBe(`会議メモ\n${A}\n- 作業 2026-08-28 09:00–09:30(30:00)\n終わり\n`);
  });

  it('🔴 名前を直す: 小窓で打った名前が行の終わりに入る / 何も打たなければ書かない', async () => {
    const { root, store, persisted } = setup({ e1: BODY });
    await tick();
    press(root, 'timer-run-rename', 'e1:1').click();
    await tick();
    expect(openDialog(), '名前を聞く小窓が出ていない').not.toBeNull();
    const input = openDialog()!.querySelector<HTMLInputElement>('input[data-pkc-field="prompt-input"]')!;
    input.value = '見積の作成';
    await answerDialog('ok');
    await tick(40);
    expect(store['e1']).toBe(`会議メモ\n${A} 見積の作成\n${B}\n終わり\n`);
    // やめる: 何も書かない
    const before = persisted.length;
    press(root, 'timer-run-rename', 'e1:2').click();
    await tick();
    await answerDialog('cancel');
    await tick(40);
    expect(persisted.length, 'やめたのに書いた').toBe(before);
  });

  it('🔴 編集中は書かない(理由が出る)', async () => {
    const { root, d, persisted, store } = setup({ e1: BODY });
    await tick();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: BODY });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提: 編集中').toBe('editing');
    press(root, 'timer-run-delete', 'e1:1').click();
    await tick(40);
    expect(persisted, '編集中に本文を書いた').toHaveLength(0);
    expect(store['e1']).toBe(BODY);
    expect(d.getState().error ?? '', '断った理由が出ていない').not.toBe('');
  });

  it('🔴 一覧が古い(別の窓が行を足した)ときは、別の行を消さずに断って集め直す', async () => {
    const { root, d, store, persisted } = setup({ e1: BODY });
    await tick();
    // 一覧の断面はそのまま、本文だけが変わった(上に 1 行足された)
    store['e1'] = `足された行\n${BODY}`;
    press(root, 'timer-run-delete', 'e1:1').click();
    await tick(40);
    expect(persisted, '食い違っているのに書いた').toHaveLength(0);
    expect(store['e1']).toBe(`足された行\n${BODY}`);
    expect(d.getState().error ?? '', '断った理由が出ていない').not.toBe('');
  });
});
