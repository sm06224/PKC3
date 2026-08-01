/** @vitest-environment happy-dom */
/**
 * filer view(P3-7b)の end-to-end: binder(実クリック)→ CenterRouter →
 * breadcrumb / explorer table。read-only ビュー(relation 作成 UI なし)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, order: number, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
  };
}

const rel = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  document.body.textContent = '';
});

function setup(metas: EntryMeta[], relations: Relation[]) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const center = new CenterRouter(regions.detail);
  d.onState((s) => center.render(s));
  bindActions(root, d);
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    persistEntry: async () => {},
    deleteEntry: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  const pane = root.querySelector<HTMLElement>('[data-pkc-view-pane="filer"]')!;
  const q = <T extends HTMLElement>(sel: string) => pane.querySelector<T>(sel);
  const rows = () =>
    [...pane.querySelectorAll('tbody [data-pkc-entry]')].map((r) =>
      r.getAttribute('data-pkc-entry'),
    );
  return { root, d, pane, q, rows };
}

describe('filer view (P3-7b)', () => {
  const METAS = [
    meta('f1', 1, 'folder'),
    meta('b', 2),
    meta('f2', 3, 'folder'),
    meta('a', 4),
  ];
  // f1 ── { f2, a }、f2 ── { b }。root: f1 のみ(b は f2 配下)
  const RELS = [rel('r1', 'f1', 'f2'), rel('r2', 'f1', 'a'), rel('r3', 'f2', 'b')];

  it('root scope → folder click で潜り、breadcrumb で戻れる', async () => {
    const { root, d, q, rows } = setup(METAS, RELS);
    root.querySelector<HTMLElement>('[data-pkc-view="filer"]')!.click();
    expect(rows()).toEqual(['f1']); // root は親なしのみ

    q<HTMLElement>('tbody [data-pkc-entry="f1"]')!.click(); // folder 選択 = scope 移動
    await tick();
    expect(rows()).toEqual(['f2', 'a']); // entryOrder 順

    q<HTMLElement>('tbody [data-pkc-entry="f2"]')!.click();
    await tick();
    expect(rows()).toEqual(['b']);
    // breadcrumb: ルート / f1 / f2
    const crumb = q('[data-pkc-region="filer-breadcrumb"]')!;
    expect(crumb.textContent).toContain('t-f1');
    expect(crumb.textContent).toContain('t-f2');

    // breadcrumb の f1 で戻る
    crumb.querySelector<HTMLElement>('[data-pkc-entry="f1"]')!.click();
    await tick();
    expect(rows()).toEqual(['f2', 'a']);
    // ルートへ
    q<HTMLElement>('[data-pkc-action="filer-root"]')!.click();
    expect(rows()).toEqual(['f1']);
    expect(d.getState().selectedLid).toBeNull();
    expect(d.getState().openBody).toBeNull(); // 速やかな破棄(review #4 pin)
  });

  it('同一 scope 内の選択変更は属性 patch のみ(table を作り直さない ── review #2)', async () => {
    const { root, q, pane } = setup(METAS, RELS);
    root.querySelector<HTMLElement>('[data-pkc-view="filer"]')!.click();
    q<HTMLElement>('tbody [data-pkc-entry="f1"]')!.click(); // scope f1
    await tick();
    const rowA = q<HTMLElement>('tbody [data-pkc-entry="a"]')!;
    const table = pane.querySelector('[data-pkc-region="filer-table"]');
    rowA.click(); // 非 folder 選択 ── scope 不変
    await tick();
    expect(q('tbody [data-pkc-entry="a"]')).toBe(rowA); // 同一ノード
    expect(pane.querySelector('[data-pkc-region="filer-table"]')).toBe(table);
    expect(rowA.hasAttribute('data-pkc-selected')).toBe(true);
  });

  it('非 folder を選択すると最近傍祖先 folder の scope で選択印が付く', async () => {
    const { root, d, q, rows } = setup(METAS, RELS);
    root.querySelector<HTMLElement>('[data-pkc-view="filer"]')!.click();
    q<HTMLElement>('tbody [data-pkc-entry="f1"]')!.click();
    await tick();
    q<HTMLElement>('tbody [data-pkc-entry="a"]')!.click(); // 非 folder
    await tick();
    expect(rows()).toEqual(['f2', 'a']); // scope は f1 のまま
    expect(
      q('tbody [data-pkc-entry="a"]')?.hasAttribute('data-pkc-selected'),
    ).toBe(true);
    expect(d.getState().selectedLid).toBe('a');
  });

  it('relations の無い container では全 entry が root に平置き', () => {
    const { root, rows } = setup([meta('x', 2), meta('y', 1)], []);
    root.querySelector<HTMLElement>('[data-pkc-view="filer"]')!.click();
    expect(rows()).toEqual(['y', 'x']); // entryOrder 順
  });
});
