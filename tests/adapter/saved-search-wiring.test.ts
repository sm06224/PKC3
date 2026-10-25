/** @vitest-environment happy-dom */
/**
 * #1038 C1: **保存した検索が、押した所から state まで届くまで**。
 *
 * 見るのは:
 * ① 保存 → 帯に出る → いまの絞りと同じ行は押された状態 → 同じ絞りでは保存ボタンが消える
 * ② 再適用は語と札を**置き換える**(足さない)/ 探す面では語だけ置き換える
 * ③ 名前を直す(小窓)/ 削除(双方向)
 * ④ 🔴 端末ごと: container(書き出し)に混ざらず、設定ファイルの `SKIPPED_KEYS` に登録されている
 * ⑤ 描き手の姿: 何も保存していない & 保存できる絞りが無いときは畳む / 探す面は語の無い組を出さない
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { SavedSearchBar } from '../../src/adapter/ui/render/saved-searches';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { appSavedSearches } from '../../src/adapter/platform/saved-search-store';
import { SKIPPED_KEYS } from '../../src/features/settings/settings-file';

function meta(lid: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)),
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function wipe(): void {
  for (const s of [...appSavedSearches.list()]) appSavedSearches.remove(s.id);
}

beforeEach(() => {
  document.body.textContent = '';
  wipe();
});
afterEach(() => {
  wipe();
});

function rig() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const regions = buildShell(root);
  const listHost = regions.sidebar.querySelector<HTMLElement>('[data-pkc-region="saved-searches"]')!;
  const pageHost = document.createElement('div');
  pageHost.setAttribute('data-pkc-field', 'search-page-saved');
  root.append(pageHost);
  const d = new Dispatcher();
  const list = new SavedSearchBar(listHost, 'filter');
  const page = new SavedSearchBar(pageHost, 'page');
  d.onState((s) => {
    list.render(s);
    page.render(s);
  });
  bindActions(root, d, {});
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2', 'todo')], relations: [] });
  const q = <T extends HTMLElement = HTMLButtonElement>(host: HTMLElement, sel: string): T | null => host.querySelector<T>(sel);
  return { root, d, listHost, pageHost, q };
}

describe('保存した検索の配線(#1038 C1)', () => {
  it('① 器が畳んである / 絞りが無ければ保存ボタンは出ない', () => {
    const r = rig();
    expect(r.listHost.hidden).toBe(true);
    r.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '>操作' }); // 操作を探す字は保存できない
    expect(r.listHost.hidden).toBe(true);
  });

  it('① 保存 → 帯に出る(押された状態)→ 同じ絞りでは保存ボタンが消える → 外すと押されない', () => {
    const r = rig();
    r.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '請求書' });
    r.d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'text' });
    const save = r.q(r.listHost, '[data-pkc-action="save-search"]');
    expect(save?.textContent).toBe('この検索を保存');
    save!.click();
    expect(appSavedSearches.list()).toHaveLength(1);
    expect(appSavedSearches.list()[0]).toMatchObject({ query: '請求書', kinds: ['text'], name: '請求書(ノート)' });
    expect(r.d.getState().notice ?? '').toContain('検索を保存しました');
    expect(r.q(r.listHost, '[data-pkc-action="save-search"]'), '保存済みの絞りに保存ボタンが残っている').toBeNull();
    const apply = r.q(r.listHost, '[data-pkc-action="apply-saved-search"]')!;
    expect(apply.textContent).toBe('請求書(ノート)');
    expect(apply.getAttribute('aria-pressed')).toBe('true');
    r.d.dispatch({ type: 'CLEAR_KIND_FILTER' });
    expect(r.q(r.listHost, '[data-pkc-action="apply-saved-search"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('🔴 ② 再適用は語と札を置き換える(足さない)', () => {
    const r = rig();
    r.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '請求書' });
    r.d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'text' });
    r.q(r.listHost, '[data-pkc-action="save-search"]')!.click();
    // 別の絞りへ移る(語も札も違う)
    r.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '議事録' });
    r.d.dispatch({ type: 'CLEAR_KIND_FILTER' });
    r.d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'todo' });
    r.q(r.listHost, '[data-pkc-action="apply-saved-search"]')!.click();
    expect(r.d.getState().filterQuery).toBe('請求書');
    expect([...r.d.getState().kindFilter]).toEqual(['text']); // csv が残らない
  });

  it('② 探す面: 語だけ保存し、再適用で探す面の語を置き換える(左の欄には触れない)', () => {
    const r = rig();
    r.d.dispatch({ type: 'SET_SEARCH_PAGE_QUERY', query: '請求書' });
    r.q(r.pageHost, '[data-pkc-action="save-search"]')!.click();
    expect(appSavedSearches.list()[0]).toMatchObject({ query: '請求書', kinds: [] });
    r.d.dispatch({ type: 'SET_SEARCH_PAGE_QUERY', query: '別の語' });
    r.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '左の語' });
    r.q(r.pageHost, '[data-pkc-action="apply-saved-search"]')!.click();
    expect(r.d.getState().searchPage.query).toBe('請求書');
    expect(r.d.getState().filterQuery, '探す面の再適用が左の欄を動かした').toBe('左の語');
  });

  it('⑤ 探す面は語の無い組(札だけ)を出さない / 左の列は出す', () => {
    const r = rig();
    r.d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'todo' });
    r.q(r.listHost, '[data-pkc-action="save-search"]')!.click();
    expect(appSavedSearches.list()[0]).toMatchObject({ query: '', kinds: ['todo'], name: 'チェックリスト' });
    r.d.dispatch({ type: 'SET_SEARCH_PAGE_QUERY', query: '' }); // 探す面を描き直す
    expect(r.q(r.listHost, '[data-pkc-action="apply-saved-search"]')).not.toBeNull();
    expect(r.q(r.pageHost, '[data-pkc-action="apply-saved-search"]'), '再適用しても何も起きない行を出している').toBeNull();
    expect(r.pageHost.hidden).toBe(true);
  });

  it('③ 名前を直す(小窓)── 空のまま決めたら変えない', async () => {
    const r = rig();
    r.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '請求書' });
    r.q(r.listHost, '[data-pkc-action="save-search"]')!.click();
    const rename = r.q(r.listHost, '[data-pkc-action="rename-saved-search"]')!;
    rename.click();
    await tick();
    const input = document.querySelector<HTMLInputElement>('input[data-pkc-field="prompt-input"]');
    expect(input?.value, '初期値がいまの名前でない').toBe('請求書');
    input!.value = '毎週の請求';
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
    await tick();
    expect(appSavedSearches.list()[0]!.name).toBe('毎週の請求');
    expect(r.q(r.listHost, '[data-pkc-action="apply-saved-search"]')!.textContent, '帯の名前が古いまま').toBe('毎週の請求');
    // 空のまま決める
    r.q(r.listHost, '[data-pkc-action="rename-saved-search"]')!.click();
    await tick();
    document.querySelector<HTMLInputElement>('input[data-pkc-field="prompt-input"]')!.value = '';
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
    await tick();
    expect(appSavedSearches.list()[0]!.name).toBe('毎週の請求');
  });

  it('③ 削除(双方向)── 帯から行が消え、同じ絞りでは保存ボタンが戻る / 全部消すと畳む', () => {
    const r = rig();
    r.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '請求書' });
    r.q(r.listHost, '[data-pkc-action="save-search"]')!.click();
    r.q(r.listHost, '[data-pkc-action="delete-saved-search"]')!.click();
    expect(appSavedSearches.list()).toHaveLength(0);
    expect(r.q(r.listHost, '[data-pkc-action="apply-saved-search"]')).toBeNull();
    expect(r.q(r.listHost, '[data-pkc-action="save-search"]'), '削除したのに保存し直せない').not.toBeNull();
    r.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
    expect(r.listHost.hidden).toBe(true);
  });

  it('保存済みの検索を別のタブで消した後に押しても、落ちずに理由を言う', () => {
    const r = rig();
    r.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '請求書' });
    r.q(r.listHost, '[data-pkc-action="save-search"]')!.click();
    const apply = r.q(r.listHost, '[data-pkc-action="apply-saved-search"]')!;
    const id = appSavedSearches.list()[0]!.id;
    // 帯の描き直しを待たずに押される状況を作る(別のタブの削除 → 画面はまだ古い)
    const stale = apply.cloneNode(true) as HTMLElement;
    r.root.append(stale);
    appSavedSearches.remove(id);
    r.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
    stale.click();
    expect(r.d.getState().error ?? '').toContain('もう保存されていません');
  });

  it('同じ検索を 2 回保存しようとすると、2 つにならず知らせる', () => {
    const r = rig();
    r.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '請求書' });
    const save = r.q(r.listHost, '[data-pkc-action="save-search"]')!;
    const again = save.cloneNode(true) as HTMLElement;
    r.root.append(again);
    save.click();
    again.setAttribute('data-pkc-saved-scope', 'filter');
    again.click();
    expect(appSavedSearches.list()).toHaveLength(1);
    expect(r.d.getState().notice ?? '').toContain('もう保存されています');
  });

  it('🔴 ④ 端末ごと: 設定ファイルに運ばない物として理由つきで登録されている', () => {
    const hit = SKIPPED_KEYS.find((k) => k.key === 'pkc3.saved-searches');
    expect(hit, 'SKIPPED_KEYS に登録されていない').toBeDefined();
    expect(hit!.why.length).toBeGreaterThan(10);
  });
});
