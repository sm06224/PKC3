/** @vitest-environment happy-dom */
/**
 * 🔴 **面の印(`data-pkc-detail-mode`)は、値が変わるときだけ書く**(#1467 段 3)。
 *
 * ⚠ 直す前は `renderView` に入るたびに同じ値を `setAttribute` していた。同じ値でも
 *   MutationObserver(`read-columns.ts` の `installColumnFit`)は鳴るので、state が動くたびに
 *   `fitColumnHeight` が描いた直後の DOM を採寸して強制レイアウトを払っていた
 *   (profile: 20,000 行の追記 1 回で 23 回・約 4 秒)。
 * 🔑 観測点は**本物の MutationObserver**(`attributeFilter` も `installColumnFit` と同じ)──
 *   `setAttribute` の呼び出し回数を数えると、別の書き方(`toggleAttribute` / `setAttributeNS`)で
 *   同じ害を出しても緑になる。
 * ⚠ 対照群: 面が切り替わる(読む → 編集)ときは、今までどおり 1 回鳴る。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function base(body: string): AppState {
  let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  return reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
}

beforeEach(() => {
  document.body.textContent = '';
});
afterEach(() => {
  document.body.textContent = '';
});

describe('detail: 面の印(data-pkc-detail-mode)は変わるときだけ書く(#1467 段 3)', () => {
  it('🔴 同じ面を描き直しても印の見張りは鳴らない ── 面が切り替わるときは 1 回鳴る', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const detail = new DetailRenderer(buildShell(root).detail);
    const s0 = base('一行目。\n\n二行目。\n');
    detail.render(s0);
    await settle();
    // 印が載る要素は `markOn ?? region` ── 骨組みの作りに依らず、印そのものから引く
    const pane = root.querySelector<HTMLElement>('[data-pkc-detail-mode]')!;
    expect(pane, '前提が崩れている(印を持つ要素が無い)').not.toBeNull();
    expect(pane.getAttribute('data-pkc-detail-mode'), '前提が崩れている(読む面の印が無い)').toBe('view');
    const records: string[] = [];
    const mo = new MutationObserver((ms) => {
      for (const m of ms) records.push(`${m.attributeName}=${pane.getAttribute(m.attributeName ?? '')}`);
    });
    mo.observe(pane, { attributes: true, attributeFilter: ['data-pkc-detail-mode'] });
    // 同じ面を 3 回描き直す(state が動くたびに renderView へ入る形)
    const s1 = reduce(s0, { type: 'BODY_LOADED', lid: 'a', body: '一行目。\n\n二行目。\n\n三行目。\n' }).state;
    detail.render(s1);
    await settle();
    detail.invalidate();
    detail.render(s1);
    await settle();
    detail.render(s1);
    await settle();
    expect(records, '同じ面の描き直しで印を書き直している(見張りが鳴って強制レイアウトを払う)').toEqual([]);
    // 対照群: 編集に入ると面が切り替わり、1 回だけ鳴る
    const s2 = reduce(s1, { type: 'START_EDIT' }).state;
    expect(s2.phase, '前提が崩れている(編集に入っていない)').toBe('editing');
    detail.render(s2);
    await settle();
    expect(records, '面が切り替わったのに見張りが鳴らない(段組みの印が外れなくなる)').toEqual([
      'data-pkc-detail-mode=editor',
    ]);
    mo.disconnect();
  });
});
