/** @vitest-environment happy-dom */
/**
 * 集計の面(#184)の end-to-end:
 * **実クリック**(面の切替ボタン / 束ね方の `<select>`)→ dispatcher → effect →
 * fake store → CenterRouter。「state mutation → consumer 観測点」まで通す。
 *
 * 🔴 PKC2 の同等の面は**空フォルダの smoke 1 本**しか無く、フィルタの test は
 * 0 件、group の test は `<select>` の value しか見ていなかった(実地調査
 * 2026-08-15)。ここは**行が在る状態**で、画面に出た数字と行まで見る。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { collectKeys, groupByKey } from '../../src/features/query/group-by';

function meta(lid: string, title: string, order: number): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
  };
}

const BODIES: Record<string, string> = {
  e1: '---\nauthor: 佐藤\ntags: [設計, 実装]\n---\n\n本文 1\n',
  e2: '---\nauthor: 佐藤\n---\n\n本文 2\n',
  e3: '---\nauthor: 田中\ntags: [設計]\n---\n\n本文 3\n',
  e4: '前置きの無い本文\n',
};
const METAS = [
  meta('e1', 'ノート 1', 1),
  meta('e2', 'ノート 2', 2),
  meta('e3', 'ノート 3', 3),
  meta('e4', 'ノート 4', 4),
];

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * ⚠ **fake store も本物の意味論を真似る**(stub が実装より賢いとバグが隠れる)。
 * 束ね方の規則は features の純関数**そのもの**を呼ぶ ── worker と同じ関数である。
 */
function setup(opts: { withQuery?: boolean } = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const center = new CenterRouter(regions.detail);
  d.onState((s) => center.render(s));
  bindActions(root, d);
  const store = { ...BODIES };
  const rows = () => METAS.map((m) => ({ lid: m.lid, head: store[m.lid] ?? '' }));
  const calls = { keys: 0, groups: [] as string[] };
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    persistEntry: async (e) => {
      store[e.lid] = e.body;
      return stubStamps();
    },
    ...(opts.withQuery === false
      ? {}
      : {
          queryKeys: async () => {
            calls.keys += 1;
            return collectKeys(rows());
          },
          queryGroupBy: async (key: string) => {
            calls.groups.push(key);
            return groupByKey(rows(), key);
          },
        }),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  return { root, d, q, qa, calls, store };
}

/** 面の切替ボタンを**実際に押す**(dispatch で近道しない)。 */
function openQuery(qa: (s: string) => HTMLElement[]): void {
  const btn = qa('[data-pkc-action="set-view"][data-pkc-view="query"]')[0];
  expect(btn, '集計の導線が画面に無い').toBeDefined();
  btn!.click();
}

describe('集計の面(#184)', () => {
  beforeEach(() => {
    document.body.textContent = '';
    try {
      localStorage.clear();
    } catch {
      /* 保存が無い環境でも動く */
    }
  });

  it('🔴 導線を押すと面が出て、束ねられる項目の目録が届く', async () => {
    const { q, qa, calls } = setup();
    openQuery(qa);
    await tick();
    const pane = q('[data-pkc-view-pane="query"]');
    expect(pane, '集計の器が無い').not.toBeNull();
    expect(pane!.hidden, '集計を押したのに面が出ていない').toBe(false);
    expect(calls.keys, '目録を 1 度も問い合わせていない').toBe(1);
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    // ⚠ 目録は**実際に書かれている項目**だけ(件数つき)
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'author', 'tags']);
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      '(選んでください)',
      'author(3 件)',
      'tags(2 件)',
    ]);
    expect(picker.disabled).toBe(false);
    expect(q('[data-pkc-field="query-note"]')!.textContent).toContain('4 件のノートを見ました');
  });

  it('🔴 項目を選ぶと、値ごとに束ねた表が出る(件数と行まで)', async () => {
    const { q, qa, calls } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(calls.groups).toEqual(['author']);
    const groups = qa('[data-pkc-region="query-group"]');
    expect(groups.map((g) => g.getAttribute('data-pkc-group'))).toEqual(['佐藤', '田中', '']);
    expect(
      groups.map((g) => g.querySelector('[data-pkc-field="query-group-count"]')?.textContent),
    ).toEqual(['2 件', '1 件', '1 件']);
    // 未設定は**いちばん下**で、表示名は「(未設定)」
    expect(
      groups[2]!.querySelector('[data-pkc-field="query-group-name"]')!.textContent,
    ).toBe('(未設定)');
    // 組の中の行は**題名**(本文は 1 バイトも主スレッドへ来ていない)
    expect(
      [...groups[0]!.querySelectorAll('[data-pkc-entry]')].map((e) => e.textContent),
    ).toEqual(['ノート 1', 'ノート 2']);
  });

  it('🔑 並べて書いた値は、どちらの組にも入る(タグで束ねる)', async () => {
    const { q, qa } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'tags';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    const groups = qa('[data-pkc-region="query-group"]');
    const byName = new Map(
      groups.map((g) => [
        g.getAttribute('data-pkc-group'),
        [...g.querySelectorAll('[data-pkc-entry]')].map((e) => e.getAttribute('data-pkc-entry')),
      ]),
    );
    expect(byName.get('設計')).toEqual(['e1', 'e3']);
    expect(byName.get('実装')).toEqual(['e1']);
  });

  it('🔴 行を押すと選択が動き、面はここに留まる(かんばんと同じ規約)', async () => {
    const { d, q, qa } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    const row = qa('[data-pkc-region="query-rows"] [data-pkc-entry="e3"]')[0]!;
    row.click();
    await tick();
    expect(d.getState().selectedLid).toBe('e3');
    expect(d.getState().viewMode, '押したら面から出てしまった').toBe('query');
    // 観測点は**画面**(state だけ見て「効いた」と言わない)
    expect(
      qa('[data-pkc-region="query-rows"] [data-pkc-selected]').map((e) =>
        e.getAttribute('data-pkc-entry'),
      ),
    ).toEqual(['e3']);
    expect(q('[data-pkc-view-pane="query"]')!.hidden).toBe(false);
  });

  it('🔑 選択が動いただけなら、表は作り直されない(押した行が消えない)', async () => {
    const { q, qa } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    const before = qa('[data-pkc-region="query-rows"] [data-pkc-entry="e1"]')[0]!;
    qa('[data-pkc-region="query-rows"] [data-pkc-entry="e2"]')[0]!.click();
    await tick();
    const after = qa('[data-pkc-region="query-rows"] [data-pkc-entry="e1"]')[0]!;
    expect(after, '行のノードが作り直されている').toBe(before);
  });

  it('🔴 選び直すと前の表を捨てて、必ず問い合わせ直す', async () => {
    const { d, q, qa, calls } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    picker.value = 'tags';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    expect(d.getState().queryGroups, '選び直した瞬間に古い表が残っている').toBeNull();
    await tick();
    expect(calls.groups).toEqual(['author', 'tags']);
  });

  it('🔴 遅れて返った古い結果は捨てる(選び直しは結果より速い)', async () => {
    const { d } = setup();
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'query' });
    d.dispatch({ type: 'SET_QUERY_KEY', key: 'tags' });
    // author の答えが**後から**届く場面を作る
    d.dispatch({
      type: 'SET_QUERY_GROUPS',
      key: 'author',
      groups: { groups: [{ value: '佐藤', total: 2, lids: ['e1', 'e2'] }], omittedGroups: 0, scanned: 4 },
    });
    expect(d.getState().queryGroups, '別の束ね方の答えを受け入れてしまった').toBeNull();
  });

  it('🔑 集計を持たない store でも壊れない(面は断りを出す)', async () => {
    const { q, qa } = setup({ withQuery: false });
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    expect(picker.disabled).toBe(true);
    expect(picker.options[0]!.textContent).toBe('(束ねられる項目がありません)');
    expect(q('[data-pkc-field="query-empty"]')!.textContent).toContain('---');
  });

  it('🔴 束ね方は覚えていて、次に開いたときに戻る(端末側に覚える)', async () => {
    const first = setup();
    openQuery(first.qa);
    await tick();
    const picker = first.q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(localStorage.getItem('pkc3.query-key')).toBe('author');

    // 別の起動(器ごと作り直す)
    document.body.textContent = '';
    const second = setup();
    openQuery(second.qa);
    await tick();
    expect(second.d.getState().queryKey, '覚えた束ね方が戻っていない').toBe('author');
    // ⚠ **同じ走査を 2 回頼まない**(目録 1 回 + 表 1 回)
    expect(second.calls.keys).toBe(1);
    expect(second.calls.groups).toEqual(['author']);
    expect(
      second.qa('[data-pkc-region="query-group"]').map((g) => g.getAttribute('data-pkc-group')),
    ).toEqual(['佐藤', '田中', '']);
  });

  /**
   * 🔴 **切ったことを画面に出す**(変異試験 M12 / M13 で判明した穴)。
   * ⚠ features 側で `omittedGroups` を数えていても、**画面に出さなければ user には
   * 「無い」と読める** ── PKC2 の Inventory はまさにそれで黙って切っていた。
   * ここは state を作って**描画の観測点**を見る(数えた値ではなく、出た文字)。
   */
  it('🔴 組を切ったら「あと N 組」と画面に出す', async () => {
    // ⚠ 集計を持たない store にする ── 持たせると**本物の答えが後から届いて**
    //    こちらが作った「切れた表」を上書きする(1 稿目はそれで落ちた)
    const { d, q, qa } = setup({ withQuery: false });
    openQuery(qa);
    await tick();
    d.dispatch({ type: 'SET_QUERY_KEY', key: 'author' });
    d.dispatch({
      type: 'SET_QUERY_GROUPS',
      key: 'author',
      groups: {
        groups: [{ value: '佐藤', total: 2, lids: ['e1', 'e2'] }],
        omittedGroups: 7,
        scanned: 4,
      },
    });
    await tick();
    expect(q('[data-pkc-field="query-note"]')!.textContent).toContain('あと 7 組');
  });

  it('🔴 1 組の中を切ったら「N 件(先頭 M 件)」と出す', async () => {
    const { d, q, qa } = setup({ withQuery: false });
    openQuery(qa);
    await tick();
    d.dispatch({ type: 'SET_QUERY_KEY', key: 'author' });
    d.dispatch({
      type: 'SET_QUERY_GROUPS',
      key: 'author',
      groups: {
        // ⚠ 抱えている lid(2 件)より total(9 件)が多い = 切った状態
        groups: [{ value: '佐藤', total: 9, lids: ['e1', 'e2'] }],
        omittedGroups: 0,
        scanned: 4,
      },
    });
    await tick();
    expect(q('[data-pkc-field="query-group-count"]')!.textContent).toBe('9 件(先頭 2 件)');
  });

  it('🔴 編集中は開けない(ノートを並べる面なので aside ではない)', async () => {
    const { d, q, qa } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'START_EDIT' });
    await tick();
    expect(d.getState().phase).toBe('editing');
    openQuery(qa);
    await tick();
    expect(d.getState().viewMode, '編集中なのに面が変わった').not.toBe('query');
    expect(q('[data-pkc-view-pane="query"]')!.hidden).toBe(true);
  });

  it('🔑 「数え直す」は同じ経路で数え直す(保存のたびに自動では走らせない)', async () => {
    const { q, qa, calls, store } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    // 本文を書き換えても、押すまでは数え直さない
    store.e4 = '---\nauthor: 鈴木\n---\n\n書き足した\n';
    await tick();
    expect(
      qa('[data-pkc-region="query-group"]').map((g) => g.getAttribute('data-pkc-group')),
    ).toEqual(['佐藤', '田中', '']);
    q<HTMLElement>('[data-pkc-action="refresh-query"]')!.click();
    await tick();
    expect(calls.keys).toBe(2);
    expect(calls.groups).toEqual(['author', 'author']);
    expect(
      qa('[data-pkc-region="query-group"]').map((g) => g.getAttribute('data-pkc-group')),
    ).toEqual(['佐藤', '田中', '鈴木']);
  });
});
