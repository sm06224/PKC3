/**
 * 🔴 **面を開く口は 1 つ**(#300 段②のレビュー)。
 *
 * ここで守るのは **「開けたかを正直に返す」** ことである(#300 段③ の直し、
 * 2026-08-22)。⚠ 別窓が塞がれたときの退避はこの返り値を読んで文言を分ける ──
 * 読まないと、**編集中でどこにも開かなかった回に「この画面で開きました」**と
 * 言うことになる(着地前レビュー 6)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { openView } from '../../src/adapter/ui/render/open-view';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string): EntryMeta {
  return {
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
  };
}

function booted(): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  return d;
}

describe('openView は「開けたか」を返す', () => {
  it('🔴 開けたら true', () => {
    const d = booted();
    expect(openView(d, 'calendar')).toBe(true);
    expect(d.getState().viewMode).toBe('calendar');
  });

  /**
   * 🔴 **編集中は断られる** ── `app-state.ts` が「編集中はカレンダーを開けません」
   * を立てて面は動かさない。⚠ ここで `true` を返すと、退避の文言が嘘になる。
   */
  it('🔴 編集中に断られたら false(面も動かない)', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提が崩れている(編集に入れていない)').toBe('editing');
    expect(openView(d, 'calendar'), '断られたのに「開いた」と返した').toBe(false);
    expect(d.getState().viewMode, '編集中なのに面が変わった').toBe('detail');
  });

  /** ⚠ 本文へ戻る道は編集中でも塞がない(2026-08-19)── そちらは true。 */
  it('⚠ 編集中でも本文へは戻れる', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    expect(openView(d, 'detail')).toBe(true);
  });
});
