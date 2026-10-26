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
import { SHEET_MAX_LINES } from '../../src/features/calc/sheet';
import { CALC_SAVE_DELAY_MS, setCalcDraftStoreForTest } from '../../src/adapter/ui/render/calc';
import { CalcDraftStore, CALC_DRAFT_MAX_CHARS, CALC_DRAFT_STORAGE_KEY } from '../../src/adapter/ui/render/calc-draft-store';
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

  /**
   * 🔴 **窓を閉じる・隠れる直前に、待っている保存を済ませる**(レビュー ⚠7、テストの穴 D)。
   * ⚠ 打鍵の 400ms 後に書く作りなので、打った直後に閉じると最後の字が落ちていた。
   *   観測点は**保存先に入った字**(待たずに、イベントの直後に見る)。
   */
  it('🔴 pagehide で、待たずに今の字が保存される(打った直後に閉じても落ちない)', () => {
    const storage = memoryStorage();
    const s = setup(storage);
    s.type('最後に打った式 = 12 * 3');
    // 対照群: まだ書いていない(400ms の待ち中)
    expect(storage.data.has(CALC_DRAFT_STORAGE_KEY)).toBe(false);
    window.dispatchEvent(new Event('pagehide'));
    expect(storage.data.get(CALC_DRAFT_STORAGE_KEY), 'pagehide で保存されていない').toBe('最後に打った式 = 12 * 3');
  });

  it('🔴 visibilitychange(隠れた)でも保存される。見えている間の発火では保存しない', () => {
    const storage = memoryStorage();
    const s = setup(storage);
    s.type('隠れる前の式 = 5');
    const set = (v: string): void => {
      Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    };
    try {
      set('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(storage.data.has(CALC_DRAFT_STORAGE_KEY), '見えているのに保存した').toBe(false);
      set('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(storage.data.get(CALC_DRAFT_STORAGE_KEY)).toBe('隠れる前の式 = 5');
    } finally {
      set('visible');
    }
  });

  /**
   * 🔴 **保存できなかったことを黙らない**(テストの穴 C)。容量不足などで書けない端末でも、
   * 式は画面にあり続け、**書けなかったと言う**。書けるようになったら言い直す(知らせが残り続けない)。
   */
  it('🔴 保存先に書けなかったら「保存できませんでした」と言い、式は画面に残る。書けたら消える', async () => {
    const storage = memoryStorage();
    let broken = true;
    const flaky = {
      ...storage,
      setItem: (k: string, v: string): void => {
        if (broken) throw new Error('QuotaExceededError');
        storage.setItem(k, v);
      },
    };
    const s = setup(flaky);
    s.type('大事な式 = 99');
    await tick(CALC_SAVE_DELAY_MS + 80);
    expect(s.status()).toContain('保存できませんでした');
    expect(s.input.value, '書けなかったのに式が消えた').toBe('大事な式 = 99');
    expect(storage.data.has(CALC_DRAFT_STORAGE_KEY)).toBe(false);
    // 知らせは、次の打鍵でも消えない(保存できるまで残る)
    s.type('大事な式 = 99 + 1');
    expect(s.status()).toContain('保存できませんでした');
    broken = false;
    await tick(CALC_SAVE_DELAY_MS + 80);
    expect(storage.data.get(CALC_DRAFT_STORAGE_KEY)).toBe('大事な式 = 99 + 1');
    expect(s.status(), '書けるようになったのに知らせが残っている').toBe('');
  });

  it('🔴 10 万字ちょうどは保存され、1 字超えると「保存できません」と言い、前に覚えた内容のまま(テストの穴 E)', async () => {
    const storage = memoryStorage();
    const s = setup(storage);
    const edge = '1'.repeat(CALC_DRAFT_MAX_CHARS);
    s.type(edge);
    await tick(CALC_SAVE_DELAY_MS + 80);
    expect(storage.data.get(CALC_DRAFT_STORAGE_KEY)?.length, '上限ちょうどで保存していない').toBe(CALC_DRAFT_MAX_CHARS);
    expect(s.status()).toBe('');
    s.type(`${edge}1`);
    await tick(CALC_SAVE_DELAY_MS + 80);
    expect(s.status()).toContain('保存できません');
    expect(s.status()).toContain('100,000');
    expect(storage.data.get(CALC_DRAFT_STORAGE_KEY)?.length, '上限超えを保存した').toBe(CALC_DRAFT_MAX_CHARS);
  });

  it('🔴 2000 行までを計算し、2001 行目からは計算しないと言う(テストの穴 E)', () => {
    const s = setup();
    s.type(Array.from({ length: SHEET_MAX_LINES }, () => '1').join('\n'));
    expect(s.results()).toHaveLength(SHEET_MAX_LINES);
    expect(s.status(), '上限ちょうどで切っている').toBe('');
    s.type(Array.from({ length: SHEET_MAX_LINES + 1 }, () => '1').join('\n'));
    expect(s.results(), '2001 行目を計算している').toHaveLength(SHEET_MAX_LINES);
    expect(s.status()).toContain('2,000 行目までを計算しています');
  });
});
