/** @vitest-environment happy-dom */
/**
 * 🔴 **計算スクラッチパッドの面**(#1230。user 指示 2026-10-26「全部やるのです」)。
 *
 * 見るのは user が見て押せるもの:
 * ①書くと右に**同じ行数**の結果が並ぶ(行がずれない)②値を直すと下の結果も変わる ③エラーの行は理由が出る
 * ④🔴 打ちかけが覚えられ、開き直すと戻る ⑤🔴 ノートにすると**保存された本文**が表 / テキストになる ⑥タイルと面がある
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { isAsidePane, isViewMode, leavesOnSelect, viewModeLabel } from '../../src/adapter/state/app-state';
import { BUILTIN_KINDS, withBuiltinTiles } from '../../src/features/launcher/tiles';
import { hasPaneHome } from '../../src/adapter/ui/render/browse-mode';
import { CALC_SAVE_DELAY_MS, setCalcDraftStoreForTest } from '../../src/adapter/ui/render/calc';
import { CalcDraftStore, CALC_DRAFT_STORAGE_KEY } from '../../src/adapter/ui/render/calc-draft-store';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: `題名-${lid}`,
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

/** 覚えを test 専用の入れ物へ(localStorage を他の test と共有しない)。 */
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function setup(storage = memoryStorage()) {
  setCalcDraftStoreForTest(new CalcDraftStore(storage));
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const center = new CenterRouter(root);
  d.onState((s) => center.render(s));
  const persisted: Array<{ lid: string; title: string; body: string }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e: { lid: string; title: string; body: string }) => {
      persisted.push(e);
      return stubStamps();
    },
    getBody: async () => '',
  });
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
  d.dispatch({ type: 'SET_VIEW_MODE', mode: 'calc' });
  const pane = root.querySelector<HTMLElement>('[data-pkc-view-pane="calc"]')!;
  const input = pane.querySelector<HTMLTextAreaElement>('[data-pkc-field="calc-input"]')!;
  const type = (v: string): void => {
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const results = (): string[] =>
    [...pane.querySelectorAll('[data-pkc-field="calc-results"] > div')].map((e) => e.textContent ?? '');
  const press = (action: string): void => pane.querySelector<HTMLElement>(`[data-pkc-action="${action}"]`)!.click();
  const status = (): string => pane.querySelector('[data-pkc-field="calc-status"]')?.textContent ?? '';
  return { root, d, pane, input, type, results, press, status, persisted, storage };
}

beforeEach(() => {
  document.body.textContent = '';
});
afterEach(() => {
  document.body.textContent = '';
});

describe('計算スクラッチパッドの面', () => {
  it('🔴 面として実在し、道具(aside)で、左に置き場が無く、組み込みタイルが 1 枚ある', () => {
    expect(isViewMode('calc')).toBe(true);
    expect(viewModeLabel('calc')).toBe('計算スクラッチパッド');
    expect(isAsidePane('calc')).toBe(true);
    // 計算しながらノートを選んでも、書きかけの式が画面から退かない
    expect(leavesOnSelect('calc')).toBe(false);
    expect(hasPaneHome('calc')).toBe(false);
    const tile = withBuiltinTiles([], { office: false }).filter((t) => t.kind === 'calc');
    expect(tile).toHaveLength(1);
    expect(tile[0]!.symbol).toBe('calculator');
    expect(BUILTIN_KINDS.has('calc')).toBe(true);
  });

  it('🔴 書くと右に結果が出る。結果の行数は左の行数と同じ(行がずれない)', () => {
    const s = setup();
    s.type('単価 = 3200 円\n数量 = 40\n\n小計 = 単価 * 数量\n合計');
    expect(s.results()).toEqual(['3,200', '40', '', '128,000', '128,000']);
    expect(s.results()).toHaveLength(5);
    // 行を減らすと、余った結果の行も消える
    s.type('単価 = 100');
    expect(s.results()).toEqual(['100']);
  });

  it('🔴 値を直すと、下の結果も変わる(追従型)', () => {
    const s = setup();
    s.type('a = 10\nb = a * 2');
    expect(s.results()).toEqual(['10', '20']);
    s.type('a = 15\nb = a * 2');
    expect(s.results()).toEqual(['15', '30']);
  });

  it('エラーの行は種別の印と理由が出る。合計の行にも印が付く', () => {
    const s = setup();
    s.type('1 / 0\n5\n合計');
    const rows = [...s.pane.querySelectorAll('[data-pkc-field="calc-results"] > div')];
    expect(rows.map((r) => r.getAttribute('data-pkc-calc-row'))).toEqual(['error', 'value', 'sum']);
    expect(rows[0]!.textContent).toBe('0 では割れません');
  });

  it('🔴 打ちかけは覚えられ、開き直すと戻る(打つ前の対照: 何も覚えていない)', async () => {
    const storage = memoryStorage();
    const s1 = setup(storage);
    expect(storage.data.has(CALC_DRAFT_STORAGE_KEY)).toBe(false);
    s1.type('x = 7\ny = x + 1');
    // 打鍵ごとには書かない(まとめて書く)
    expect(storage.data.has(CALC_DRAFT_STORAGE_KEY)).toBe(false);
    await tick(CALC_SAVE_DELAY_MS + 80);
    expect(storage.data.get(CALC_DRAFT_STORAGE_KEY)).toBe('x = 7\ny = x + 1');
    // 新しい窓(同じ保存)
    document.body.textContent = '';
    const s2 = setup(storage);
    expect(s2.input.value).toBe('x = 7\ny = x + 1');
    expect(s2.results()).toEqual(['7', '8']);
  });

  it('消すと式も覚えも空になる(空は「消す」で書く)', async () => {
    const storage = memoryStorage();
    const s = setup(storage);
    s.type('1 + 1');
    await tick(CALC_SAVE_DELAY_MS + 80);
    expect(storage.data.has(CALC_DRAFT_STORAGE_KEY)).toBe(true);
    s.press('calc-clear');
    expect(s.input.value).toBe('');
    // 空の欄にも 1 行ある(左の欄の行数と同じ)
    expect(s.results()).toEqual(['']);
    expect(storage.data.has(CALC_DRAFT_STORAGE_KEY)).toBe(false);
    // 空のときは「ノートにする」「コピー」を押せない
    expect(s.pane.querySelector<HTMLButtonElement>('[data-pkc-field="calc-to-table"]')!.disabled).toBe(true);
  });

  it('🔴 ノートにする(表)と、保存された本文が Markdown の表になる', async () => {
    const s = setup();
    s.type('単価 = 100\n数量 = 3\n小計 = 単価 * 数量');
    s.press('calc-to-table');
    await tick();
    const made = s.persisted.find((p) => p.lid !== 'e1');
    expect(made?.body).toBe(
      '| 式 | 結果 |\n| --- | --- |\n| 単価 = 100 | 100 |\n| 数量 = 3 | 3 |\n| 小計 = 単価 * 数量 | 300 |',
    );
    expect(made?.title).toMatch(/^計算メモ \d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(s.status()).toContain('新しいノート');
    // ノートにしても式は残る(続きを書ける)
    expect(s.input.value).toContain('小計 = 単価 * 数量');
  });

  it('🔴 ノートにする(テキスト)は「→ 結果」付きの文章になる', async () => {
    const s = setup();
    s.type('電車 1200円\nバス 300円\n合計');
    s.press('calc-to-text');
    await tick();
    const made = s.persisted.find((p) => p.lid !== 'e1');
    expect(made?.body).toBe('電車 1200円  → 1,200\nバス 300円  → 300\n合計  → 1,500');
  });

  it('編集中はノートにできず、理由が面に出る(保存は起きない)', async () => {
    const s = setup();
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    s.d.dispatch({ type: 'START_EDIT' });
    s.type('1 + 1');
    s.press('calc-to-table');
    await tick();
    expect(s.persisted).toHaveLength(0);
    expect(s.status()).not.toBe('');
  });
});
