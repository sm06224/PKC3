/** @vitest-environment happy-dom */
/**
 * 🔴 別のタブ・窓が今日のノートを編集中なら、予定の面の「足す」も目盛りの作成も**断る**
 * (#529 W5-d の続き。Gemini 裁定 Q5 = A)。
 *
 * ## user の物語
 * 別のタブで今日のノートを編集している。このタブの予定の面で「足す」を押す(または目盛りをダブルクリックして
 * 名前を打つ)。⚠ 直す前は通り、編集中のタブの保存で**上書きされて**足した行は履歴にだけ残った。
 * いまは**断って理由を出し、「足す」では打った名前を欄に残す**。目盛りの仮の枠は畳む(書かない)。
 *
 * 観測点は**今日のノートの本文(store)**と画面の欄・枠。対照群(granted → 書く・錠を返す)を同じ場面に置く。
 */
import { readFileSync } from 'node:fs';
import { stubStamps } from '../helpers/store-stamps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { addScheduleItemChecked, bindActions } from '../../src/adapter/ui/actions/binder';
import { installScheduleGridCreate } from '../../src/adapter/ui/render/schedule-grid-create';
import type { EditLockPort } from '../../src/adapter/state/edited-elsewhere';
import { stubRevisionOps } from '../helpers/revision-stub';
import { todayNoteTitle } from '../../src/features/schedule/today-note';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';

const TODAY = new Date(2026, 7, 23);
const LANE_H = 960;
const NOTE_TITLE = todayNoteTitle(new Date());
const BODY = 'きょうのメモ\n';
const QUICK_TEXT = '[data-pkc-field="schedule-quick-text"]';
const QUICK_BTN = '[data-pkc-action="schedule-quick-add"]';
const BOX = '[data-pkc-field="schedule-create-box"]';
const INPUT = '[data-pkc-field="schedule-create-input"]';
const LANE = '[data-pkc-field="schedule-day-lane"]';

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
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => {
    resolve = r;
  });
  return { p, resolve };
}

function setup(port: EditLockPort, withNote = true) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const store: Record<string, string> = withNote ? { t1: BODY } : {};
  const host = document.createElement('div');
  host.setAttribute('data-pkc-view-pane', 'schedule');
  regions.browseHost.append(host);
  const view = new ScheduleRenderer(host, () => TODAY);
  d.onState((s) => view.render(s));
  bindActions(root, d, { ...port });
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      store[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: withNote ? [meta('t1', NOTE_TITLE)] : [meta('o1', 'べつ')],
    relations: [],
  });
  const detach = installScheduleGridCreate(root, d, port);
  (root.querySelector('[data-pkc-action="schedule-mode"][data-pkc-mode="day"]') as HTMLElement).click();
  for (const lane of root.querySelectorAll<HTMLElement>(LANE)) {
    lane.getBoundingClientRect = () =>
      ({ top: 0, left: 0, bottom: LANE_H, right: 100, width: 100, height: LANE_H, x: 0, y: 0 }) as DOMRect;
  }
  const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  return { root, d, store, q, detach };
}

/** 空いた所のダブルクリックで枠を出し、名前を打って Enter を押す。 */
function createViaGrid(s: ReturnType<typeof setup>, name: string): void {
  const lane = s.root.querySelector<HTMLElement>(LANE)!;
  lane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientY: 400 }));
  const input = s.q<HTMLInputElement>(INPUT)!;
  input.value = name;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('① 予定の面の「足す」', () => {
  it('🔴 別のタブが握っていたら何も書かず、理由を出し、打った名前は欄に残る', async () => {
    const acquire = vi.fn(async () => 'denied' as const);
    const s = setup({ acquireEditLock: acquire, releaseEditLock: vi.fn() });
    await tick();
    s.q<HTMLInputElement>(QUICK_TEXT)!.value = '見積を出す';
    s.q(QUICK_BTN)!.click();
    await tick();
    expect(acquire).toHaveBeenCalledWith('t1');
    expect(s.store['t1'], '断られたのに書かれた').toBe(BODY);
    expect(s.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
    const f = s.q<HTMLInputElement>(QUICK_TEXT)!;
    expect(f.value, '打った名前が消えた').toBe('見積を出す');
    expect(f.readOnly, '読み取り専用のまま').toBe(false);
    expect(f.hasAttribute('data-pkc-busy'), '問い合わせの印が残った').toBe(false);
    s.detach();
  });

  it('対照群:取れたら書かれ、錠は握り続けずに返し、欄は空になる', async () => {
    const release = vi.fn();
    const s = setup({ acquireEditLock: async () => 'granted', releaseEditLock: release });
    await tick();
    s.q<HTMLInputElement>(QUICK_TEXT)!.value = '見積を出す';
    s.q(QUICK_BTN)!.click();
    await tick();
    expect(s.store['t1']).toContain('- [ ] 見積を出す');
    expect(release).toHaveBeenCalledWith('t1');
    expect(s.q<HTMLInputElement>(QUICK_TEXT)!.value).toBe('');
    s.detach();
  });

  it('🔴 問い合わせの間は欄が読み取り専用で、2 回押しても 1 回しか書かない', async () => {
    const g = deferred<'granted'>();
    const acquire = vi.fn(() => g.p);
    const s = setup({ acquireEditLock: acquire, releaseEditLock: vi.fn() });
    await tick();
    s.q<HTMLInputElement>(QUICK_TEXT)!.value = '一度だけ';
    s.q(QUICK_BTN)!.click();
    expect(s.q<HTMLInputElement>(QUICK_TEXT)!.readOnly, '問い合わせ中に打てる').toBe(true);
    s.q(QUICK_BTN)!.click();
    g.resolve('granted');
    await tick();
    expect(acquire, '二重に問い合わせた').toHaveBeenCalledTimes(1);
    expect(s.store['t1']!.match(/一度だけ/g)).toHaveLength(1);
    s.detach();
  });

  it('問い合わせが要らない回(今日のノートがまだ無い)は同期のまま作って書く', async () => {
    const acquire = vi.fn(async () => 'denied' as const);
    const s = setup({ acquireEditLock: acquire, releaseEditLock: vi.fn() }, false);
    await tick();
    s.q<HTMLInputElement>(QUICK_TEXT)!.value = '新しい日';
    s.q(QUICK_BTN)!.click();
    await tick();
    expect(acquire, '無いノートのことを問い合わせた').not.toHaveBeenCalled();
    const today = [...s.d.getState().entryMetas.values()].find((m) => m.title === NOTE_TITLE);
    expect(s.store[today!.lid]).toContain('- [ ] 新しい日');
    s.detach();
  });

  it('口が無い環境では別のタブへの問い合わせを挟まず、すぐ書込を頼む', () => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('t1', NOTE_TITLE)], relations: [] });
    const r = addScheduleItemChecked(d, {}, { text: 'x', date: '' });
    // 頼んだ回は結末(disk に着く)まで待つので Promise(#1087)。⚠ 別のタブへの問い合わせは挟まない
    expect(r).toBeInstanceOf(Promise);
  });
});

describe('② 目盛りの作成(ダブルクリック / ドラッグ)', () => {
  it('🔴 別のタブが握っていたら何も書かず、理由を出し、仮の枠を畳む', async () => {
    const acquire = vi.fn(async () => 'denied' as const);
    const s = setup({ acquireEditLock: acquire, releaseEditLock: vi.fn() });
    createViaGrid(s, '打ち合わせ');
    await tick();
    expect(acquire).toHaveBeenCalledWith('t1');
    expect(s.store['t1'], '断られたのに書かれた').toBe(BODY);
    expect(s.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
    expect(s.root.querySelectorAll(BOX), '仮の枠が残った').toHaveLength(0);
    s.detach();
  });

  it('対照群:取れたら書かれ、枠は畳まれ、錠は返す', async () => {
    const release = vi.fn();
    const s = setup({ acquireEditLock: async () => 'granted', releaseEditLock: release });
    createViaGrid(s, '打ち合わせ');
    await tick();
    expect(s.store['t1']).toContain('- [ ] 打ち合わせ @');
    expect(s.root.querySelectorAll(BOX)).toHaveLength(0);
    expect(release).toHaveBeenCalledWith('t1');
    s.detach();
  });

  it('🔴 問い合わせの間は欄が読み取り専用で、Enter を 2 回押しても 1 回しか書かない', async () => {
    const g = deferred<'granted'>();
    const acquire = vi.fn(() => g.p);
    const s = setup({ acquireEditLock: acquire, releaseEditLock: vi.fn() });
    createViaGrid(s, '一度だけ');
    const input = s.q<HTMLInputElement>(INPUT)!;
    expect(input.readOnly, '問い合わせ中に打てる').toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    g.resolve('granted');
    await tick();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(s.store['t1']!.match(/一度だけ/g)).toHaveLength(1);
    s.detach();
  });

  it('🔴 問い合わせの間に Esc で枠を畳んだら、取れても書かない', async () => {
    const g = deferred<'granted'>();
    const release = vi.fn();
    const s = setup({ acquireEditLock: () => g.p, releaseEditLock: release });
    createViaGrid(s, 'やめた');
    s.q<HTMLInputElement>(INPUT)!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    g.resolve('granted');
    await tick();
    expect(s.store['t1'], 'やめたのに書かれた').toBe(BODY);
    expect(release, '取った錠を返していない').toHaveBeenCalledWith('t1');
    s.detach();
  });

  it('問い合わせが要らない回(口が無い)は、問い合わせの待ちを挟まず書く', async () => {
    const s = setup({});
    createViaGrid(s, '同期');
    await tick();
    expect(s.root.querySelectorAll(BOX), '枠が畳まれていない').toHaveLength(0);
    s.detach();
  });
});

describe('③ 配線(main.ts は起動できないので字で pin)', () => {
  it('目盛りの作成へ、編集の錠の口(makeEditLockPort)を渡している', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toMatch(/installScheduleGridCreate\(root, dispatcher, makeEditLockPort\(\(\) => sync, cid\)\)/);
  });
});
