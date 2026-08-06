/** @vitest-environment happy-dom */
/**
 * 🔴 **どこに居るかを情報ペインに出す**(2026-08-06。user 報告 minor
 * 「一覧タブから所属フォルダを知る手段が無い」)。
 *
 * 一覧は平置きなので、そのノートがどのフォルダに入っているかは**フォルダタブへ
 * 移らないと分からなかった**(移ると探し直しになる)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

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

const METAS = [
  meta('f1', 1, 'folder'),
  meta('f2', 2, 'folder'),
  meta('n1', 3),
  meta('n2', 4),
];

function ready(relations: Relation[]): AppState {
  return reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: METAS,
    relations,
  }).state;
}

beforeEach(() => {
  document.body.textContent = '';
});

function rig() {
  const root = document.createElement('div');
  document.body.append(root);
  const inspector = new InspectorRenderer(buildShell(root).inspector);
  const folder = (): string | null =>
    root.querySelector('[data-pkc-field="inspector-folder"]')?.textContent ?? null;
  return { root, inspector, folder };
}

describe('情報ペインの「居場所」', () => {
  it('🔴 フォルダの中のノートは、その名前が出る', () => {
    const r = rig();
    const s = ready([rel('r1', 'f1', 'n1')]);
    r.inspector.render(reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state);
    expect(r.folder(), '居場所が出ていない').toBe('t-f1');
  });

  it('🔴 入れ子は上から順に出る(どこの下か分かる)', () => {
    const r = rig();
    const s = ready([rel('r1', 'f1', 'f2'), rel('r2', 'f2', 'n1')]);
    r.inspector.render(reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state);
    expect(r.folder()).toBe('t-f1 / t-f2');
  });

  it('🔴 root 直下は「ルート」と書く(空欄は「不明」に見える)', () => {
    const r = rig();
    r.inspector.render(reduce(ready([]), { type: 'SELECT_ENTRY', lid: 'n1' }).state);
    expect(r.folder()).toBe('ルート');
  });

  /**
   * 🔴 **移したら追従する**。
   *
   * ⚠ ここが本題 ── 情報ペインは断面指紋(参照比較)で描き直しを省くので、
   * `relations` を指紋に入れ忘れると **meta が変わらない移動では前の居場所を
   * 出したまま**になる(押しても画面が 1 ドットも変わらない形)。
   */
  it('🔴 フォルダを移すとその場で変わる(前の居場所を出したままにしない)', () => {
    const r = rig();
    let s = reduce(ready([rel('r1', 'f1', 'n1')]), { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    r.inspector.render(s);
    expect(r.folder()).toBe('t-f1');
    s = reduce(s, {
      type: 'SET_ENTRY_PARENT',
      lid: 'n1',
      parentLid: 'f2',
      relationId: 'r2',
    }).state;
    r.inspector.render(s);
    expect(r.folder(), '移したのに前の居場所を出している').toBe('t-f2');
    // ルートへ出したときも同じ
    s = reduce(s, {
      type: 'SET_ENTRY_PARENT',
      lid: 'n1',
      parentLid: null,
      relationId: 'r3',
    }).state;
    r.inspector.render(s);
    expect(r.folder()).toBe('ルート');
  });

  it('何も選んでいなければ行そのものが無い(空の行を並べない)', () => {
    const r = rig();
    r.inspector.render(ready([]));
    expect(r.folder()).toBeNull();
  });
});
