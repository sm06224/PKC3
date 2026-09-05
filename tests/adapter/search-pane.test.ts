/** @vitest-environment happy-dom */
/**
 * 🔴 **探す面**(#680)── 打つ → 300ms 止まる → worker → 行 → 押すと小窓、を端から端まで。
 *
 * 守る主張:
 * 1. 中央の器(`view=search`)に、欄と結果の一覧が描かれる(本文の面は畳まれる)
 * 2. 欄に打つと **`searchPage.query` に写り、左の列の `filterQuery` は動かない**
 * 3. 🔴 **300ms 止まってから 1 回だけ** worker を叩く(打鍵ごとに叩かない)
 * 4. 行は題名 + 抜粋(当たった語は `<mark>`)。**HTML を注入しない**
 * 5. 行を押すと `openNoteWindow`(小窓)が**その lid で**呼ばれる
 * 6. 遅れて返った古い結果は捨てる / 空にしたら頼まない / 失敗は「まだ」と区別する
 * 7. 切ったことを言う
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import {
  connectStoreEffects,
  SEARCH_DETAIL_DEBOUNCE_MS,
} from '../../src/adapter/state/store-effects';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { SearchRenderer } from '../../src/adapter/ui/render/search';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { initialState, viewModeLabel, type AppState } from '../../src/adapter/state/app-state';
import { homeTabOf } from '../../src/adapter/ui/render/browse-mode';
import {
  SNIPPET_MARK_CLOSE,
  SNIPPET_MARK_OPEN,
  type SearchDetailRow,
} from '../../src/features/filter/search-snippet';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

const O = SNIPPET_MARK_OPEN;
const C = SNIPPET_MARK_CLOSE;

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

const row = (lid: string, title: string, snippet: string, rank = -1): SearchDetailRow => ({
  lid,
  title,
  snippet,
  rank,
});

/**
 * 面 + binder + effect を実物で繋ぐ。⚠ worker の口(`searchDetail`)だけ fake ──
 * 問い合わせに応じて返す(語を無視する stub だと「古い結果を捨てる」が見えない)。
 */
function setup(
  answer: (q: string) => { rows: SearchDetailRow[]; truncated: boolean } = () => ({
    rows: [],
    truncated: false,
  }),
  opts: { withDetail?: boolean } = {},
) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const center = new CenterRouter(root);
  d.onState((s) => center.render(s));
  const searchDetail = vi.fn(async (q: string) => answer(q));
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    ...(opts.withDetail === false ? {} : { searchDetail }),
  });
  const openNoteWindow = vi.fn<(lid: string) => void>();
  bindActions(root, d, { openNoteWindow });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '会議メモ')], relations: [] });
  d.dispatch({ type: 'SET_VIEW_MODE', mode: 'search' });
  const pane = root.querySelector<HTMLElement>('[data-pkc-view-pane="search"]')!;
  const input = pane.querySelector<HTMLInputElement>('[data-pkc-field="search-page-input"]')!;
  const type = (q: string): void => {
    input.value = q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const note = (): string => pane.querySelector('[data-pkc-field="search-page-note"]')?.textContent ?? '';
  const rows = (): HTMLElement[] => [...pane.querySelectorAll<HTMLElement>('[data-pkc-search-row]')];
  return { root, d, pane, input, type, note, rows, searchDetail, openNoteWindow };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** debounce を越えて、worker の答えが state に届くまで進める。 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SEARCH_DETAIL_DEBOUNCE_MS + 1);
}

describe('探す面(#680)', () => {
  it('🔴 中央の器に欄と案内が出て、本文の面は畳まれる', () => {
    const { root, pane, input, note } = setup();
    expect(pane.hidden, '探す面が隠れている').toBe(false);
    expect(input, '打つ欄が無い').not.toBeNull();
    expect(root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]')!.hidden).toBe(true);
    expect(note(), '語を打つ前の案内が無い').toContain('題名と本文');
    expect(viewModeLabel('search'), '面の呼び名').toBe('探す');
    // ⚠ 左の列に同じ面は無い ── 退避はタブではない(`open-view.test.ts` が焦点を見る)
    expect(homeTabOf('search')).toBeNull();
  });

  it('⚠ 開いた最初の 1 回だけ欄へ焦点が入る(結果が届いても奪い直さない)', async () => {
    const { input, type, d } = setup(() => ({ rows: [row('n1', '会議メモ', 'x')], truncated: false }));
    expect(document.activeElement, '開いたのに欄へ焦点が入っていない').toBe(input);
    input.blur();
    type('会議');
    await settle();
    expect(d.getState().searchPage.rows).toHaveLength(1);
    expect(document.activeElement, '結果が届いた瞬間に焦点を奪った').not.toBe(input);
  });

  it('🔴 欄に打つと面の語に写り、左の列の絞り込みは動かない', () => {
    const { d, type } = setup();
    type('会議');
    expect(d.getState().searchPage.query).toBe('会議');
    expect(d.getState().filterQuery, '面の語で左の一覧が絞られた').toBe('');
  });

  it('🔴 300ms 止まってから 1 回だけ worker を叩く(打鍵ごとに叩かない)', async () => {
    const { type, searchDetail } = setup();
    type('か');
    await vi.advanceTimersByTimeAsync(100);
    type('かい');
    await vi.advanceTimersByTimeAsync(100);
    type('かいぎ');
    await vi.advanceTimersByTimeAsync(SEARCH_DETAIL_DEBOUNCE_MS - 1);
    expect(searchDetail, '止まる前に叩いた').not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(searchDetail, '最後の語で 1 回だけ叩く').toHaveBeenCalledTimes(1);
    expect(searchDetail).toHaveBeenCalledWith('かいぎ');
  });

  it('🔴 行は題名と抜粋で、当たった語だけ <mark>、HTML は注入しない', async () => {
    const { type, rows, note } = setup(() => ({
      rows: [row('n1', '会議メモ', `来週の${O}会議${C}の <b>予定</b>`)],
      truncated: false,
    }));
    type('会議');
    await settle();
    expect(rows(), '行が出ない').toHaveLength(1);
    const r = rows()[0]!;
    expect(r.querySelector('[data-pkc-field="search-row-title"]')?.textContent).toBe('会議メモ');
    const snip = r.querySelector('[data-pkc-field="search-row-snippet"]')!;
    expect(snip.querySelector('mark')?.textContent, '当たった語に印が無い').toBe('会議');
    expect(snip.textContent, '印の字が画面に出ている').toBe('来週の会議の <b>予定</b>');
    expect(snip.querySelector('b'), 'worker から来た字を HTML として注入した').toBeNull();
    expect(note()).toBe('1 件(関連の高い順)');
  });

  it('🔴 行を押すと、その lid で小窓が開く(既存の open-note-window を通す)', async () => {
    const { type, rows, openNoteWindow, d } = setup(() => ({
      rows: [row('n1', '会議メモ', 'a'), row('n2', '買い物', 'b')],
      truncated: false,
    }));
    type('会議');
    await settle();
    const btn = rows()[1]!.querySelector<HTMLButtonElement>('[data-pkc-action="open-note-window"]')!;
    expect(btn.getAttribute('data-pkc-entry')).toBe('n2');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openNoteWindow, '小窓が開かない').toHaveBeenCalledWith('n2');
    expect(openNoteWindow).toHaveBeenCalledTimes(1);
    // ⚠ 中央の面は変わらない(本文へ落ちない ── 小窓で開いたので)
    expect(d.getState().viewMode).toBe('search');
  });

  it('🔴 遅れて返った古い結果は捨てる(打鍵は結果より速い)', async () => {
    const { d, type, rows } = setup();
    type('みかん');
    type('りんご');
    d.dispatch({
      type: 'SET_SEARCH_DETAIL',
      query: 'みかん',
      rows: [row('n9', '古い', 'x')],
      truncated: false,
    });
    expect(rows(), '別の語の当たりが混ざった').toHaveLength(0);
    expect(d.getState().searchPage.rowsQuery, '古い語の答えを受け取った').not.toBe('みかん');
  });

  it('🔴 まだ返っていない間は「探しています…」、前の行は消さない(ちらつかせない)', async () => {
    const { type, rows, note } = setup((q) => ({
      rows: q === 'か' ? [row('n1', '会議メモ', 'k')] : [],
      truncated: false,
    }));
    type('か');
    await settle();
    expect(rows()).toHaveLength(1);
    type('かい');
    expect(note(), '打った直後に「探しています…」が出ない').toContain('探しています');
    expect(rows(), '打った瞬間に前の行が消えた').toHaveLength(1);
    await settle();
    expect(rows()).toHaveLength(0);
    expect(note()).toContain('「かい」に当たるノートはありません');
  });

  it('⚠ 空にしたら頼まず、結果も空に戻る', async () => {
    const { type, rows, searchDetail, note } = setup(() => ({
      rows: [row('n1', '会議メモ', 'k')],
      truncated: false,
    }));
    type('会議');
    await settle();
    expect(rows()).toHaveLength(1);
    type('');
    await settle();
    expect(searchDetail).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(0);
    expect(note()).toContain('語を打つと');
  });

  it('🔴 200 件で切れたら、そう言う', async () => {
    const { type, note } = setup(() => ({
      rows: Array.from({ length: 3 }, (_, i) => row(`n${i}`, `t${i}`, 's')),
      truncated: true,
    }));
    type('会議');
    await settle();
    expect(note(), '切ったのに黙っている').toContain('200 件より多く');
  });

  it('🔴 worker が失敗したら「探せません」── 「探しています…」で止まらない', async () => {
    const { type, note, d } = setup(() => {
      throw new Error('db down');
    });
    type('会議');
    await settle();
    expect(note(), '失敗を「まだ」と取り違えた').toContain('探せません');
    expect(d.getState().error, '面の失敗で帯を出している').toBeNull();
  });

  it('🔴 op を持たない古い worker では、その場で「探せません」(永久に待たない)', async () => {
    const { type, note } = setup(undefined, { withDetail: false });
    type('会議');
    // ⚠ debounce を待たずに出る(op が無いことは同期に分かる)
    expect(note()).toContain('探せません');
  });
});

describe('SearchRenderer 単体', () => {
  const paint = (page: AppState['searchPage'], r?: SearchRenderer): { host: HTMLElement; r: SearchRenderer } => {
    const host = document.createElement('div');
    document.body.append(host);
    const renderer = r ?? new SearchRenderer(host);
    renderer.render({ ...initialState, searchPage: page } as AppState);
    return { host, r: renderer };
  };

  it('題名が空の行は「(題名なし)」と出す(押せる場所を空にしない)', () => {
    const { host } = paint({ query: 'x', rowsQuery: 'x', truncated: false, failed: false, rows: [row('a', '', 's')] });
    expect(host.querySelector('[data-pkc-field="search-row-title"]')?.textContent).toBe('(題名なし)');
  });

  it('⚠ 欄の字は state が正 ── 別の所から語が変わったら欄も追随する', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const r = new SearchRenderer(host);
    r.render({ ...initialState, searchPage: { ...initialState.searchPage, query: 'abc' } } as AppState);
    expect(host.querySelector<HTMLInputElement>('[data-pkc-field="search-page-input"]')!.value).toBe('abc');
  });

  it('⚠ 同じ state を 2 度描いても DOM を作り直さない(押す寸前の行を捨てない)', () => {
    const page = { query: 'x', rowsQuery: 'x', truncated: false, failed: false, rows: [row('a', 't', 's')] };
    const { host, r } = paint(page);
    const before = host.querySelector('[data-pkc-search-row]');
    r.render({ ...initialState, searchPage: page } as AppState);
    expect(host.querySelector('[data-pkc-search-row]')).toBe(before);
  });
});
