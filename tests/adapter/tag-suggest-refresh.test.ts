/** @vitest-environment node */
/**
 * タグの候補を、ノートの一覧が変わったら集め直す(#1087 の利用者目線の見直し)。
 * ⚠ 直す前は、情報ペイン / まとめ操作でタグを付け外ししたときしか捨てず、本文に `#タグ` を書いて保存した・
 *   ノートを消した・取り込んだ、では最初に集めた古い一覧が残っていた(打ち間違いのタグが増える)。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';

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

const booted = (): AppState =>
  reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a'), meta('b')], relations: [] }).state;

const asks = (s: AppState): boolean =>
  reduce(s, { type: 'ASK_TAG_SUGGESTIONS' }).events.some((e) => e.type === 'REQUEST_TAG_SUGGESTIONS');

describe('タグの候補の集め直し', () => {
  it('🔑 一覧が同じなら集め直さない(焦点のたびに全ノートを走査しない)', () => {
    let s = booted();
    expect(asks(s), '前提: 最初は集めに行く').toBe(true);
    s = reduce(s, { type: 'SET_TAG_SUGGESTIONS', tags: ['買い物'] }).state;
    expect(asks(s), '一覧が同じなのに集め直した').toBe(false);
  });

  it('🔴 保存の刻み(本文の #タグ)・消した、で一覧が変わったら集め直す', () => {
    let s = booted();
    s = reduce(s, { type: 'SET_TAG_SUGGESTIONS', tags: ['買い物'] }).state;
    const saved = reduce(s, { type: 'ENTRY_STAMPED', lid: 'a', createdAt: '2026-10-13 01:00:00', updatedAt: '2026-10-13 01:00:00' }).state;
    expect(saved.entryMetas, '前提: 保存の刻みで一覧が新しくなっていない').not.toBe(s.entryMetas);
    expect(asks(saved), '本文を保存した後も古い候補のまま').toBe(true);
    const deleted = reduce(s, { type: 'DELETE_ENTRIES', lids: ['b'] }).state;
    expect(deleted.entryMetas, '前提: 消して一覧が新しくなっていない').not.toBe(s.entryMetas);
    expect(asks(deleted), 'ノートを消した後も古い候補のまま').toBe(true);
  });
});
