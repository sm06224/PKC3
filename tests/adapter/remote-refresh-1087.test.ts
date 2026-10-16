/**
 * 🔴 別タブの書込(`SYS_BOOTED`)で、画面に出ている「写し」を取り直す(#1087 の掃き出し)。
 *
 * 取り直さないと、別タブが保存しても: 参照元 / 履歴の面 / ごみ箱の面 / 横に留めた枠 /
 * 板の抜粋が**古いまま**残る。別の container へ切り替わったときは、面を保たず畳む。
 */
import { describe, expect, it } from 'vitest';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const META = (lid: string): EntryMeta => ({
  lid,
  title: `t-${lid}`,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 0,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const boot = (s: AppState, lids: string[], cid = 'c1') =>
  reduce(s, { type: 'SYS_BOOTED', cid, metas: lids.map(META), relations: [] });

const types = (events: readonly { type: string }[], t: string) =>
  events.filter((e) => e.type === t);

function ready(): AppState {
  let s = boot(initialState, ['a', 'b', 'c']).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  return s;
}

describe('別タブの書込で、出ている写しを取り直す', () => {
  it('🔴 参照元: 題名も件数も同じ再読込でも取り直し、前の答えは残す', () => {
    let s = ready();
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: ['b'], truncated: false }).state;
    const out = boot(s, ['a', 'b', 'c']);
    expect(out.events).toContainEqual({ type: 'REQUEST_BACKLINKS', lid: 'a' });
    expect(out.state.backlinks?.lids).toEqual(['b']);
  });

  it('対照群: 参照元を一度も引いていなければ撃たない / 選択が消えたら撃たない', () => {
    expect(types(boot(ready(), ['a', 'b', 'c']).events, 'REQUEST_BACKLINKS')).toHaveLength(0);
    let s = reduce(ready(), { type: 'BACKLINKS_LOADED', lid: 'a', lids: [], truncated: false }).state;
    s = boot(s, ['b', 'c']).state;
    expect(types(boot(s, ['b', 'c']).events, 'REQUEST_BACKLINKS')).toHaveLength(0);
  });

  it('🔴 履歴の面: 開いていれば取り直し、前の答えは残す。ノートが消えたら畳む', () => {
    const items = [{ id: 'r1' }] as never;
    const s = reduce(ready(), { type: 'REVISION_LIST_LOADED', lid: 'a', items }).state;
    expect(s.revisionPanel?.lid).toBe('a'); // 前提
    const out = boot(s, ['a', 'b']);
    expect(out.events).toContainEqual({ type: 'REQUEST_REVISION_LIST', lid: 'a' });
    expect(out.state.revisionPanel?.items).toBe(items);
    const gone = boot(s, ['b', 'c']);
    expect(gone.state.revisionPanel).toBeNull();
    expect(types(gone.events, 'REQUEST_REVISION_LIST')).toHaveLength(0);
  });

  it('🔴 ごみ箱の面: 開いていれば取り直し、前の答えは残す。閉じていれば撃たない', () => {
    const s = reduce(ready(), { type: 'TRASH_LIST_LOADED', items: [{ entryLid: 'z' }] as never }).state;
    expect(s.trashPanel).not.toBeNull(); // 前提
    const out = boot(s, ['a', 'b', 'c']);
    expect(types(out.events, 'REQUEST_TRASH_LIST')).toHaveLength(1);
    expect(out.state.trashPanel?.items).toHaveLength(1);
    expect(types(boot(ready(), ['a', 'b', 'c']).events, 'REQUEST_TRASH_LIST')).toHaveLength(0);
  });

  it('🔴 別の container へ切り替わったら、面は保たず・取り直しも撃たない', () => {
    let s = reduce(ready(), { type: 'REVISION_LIST_LOADED', lid: 'a', items: [] }).state;
    s = reduce(s, { type: 'TRASH_LIST_LOADED', items: [] }).state;
    s = reduce(s, { type: 'SPLIT_RESTORED', lids: ['b'] }).state;
    const out = boot(s, ['a', 'b', 'c'], 'c2');
    expect(out.state.revisionPanel).toBeNull();
    expect(out.state.trashPanel).toBeNull();
    expect(types(out.events, 'REQUEST_REVISION_LIST')).toHaveLength(0);
    expect(types(out.events, 'REQUEST_TRASH_LIST')).toHaveLength(0);
    expect(types(out.events, 'REQUEST_SPLIT_BODY')).toHaveLength(0);
  });
});

describe('別タブの書込で、留めた枠・板の抜粋を取り直す', () => {
  it('🔴 留めた枠: 居る lid だけ頼み、今の字は返事まで残す。消えた lid は頼まない', () => {
    let s = ready();
    s = reduce(s, { type: 'PIN_SPLIT_ENTRY', lid: 'b' }).state;
    s = reduce(s, { type: 'PIN_SPLIT_ENTRY', lid: 'c' }).state;
    s = reduce(s, { type: 'SPLIT_BODY_LOADED', lid: 'b', body: 'OLD' }).state;
    expect([...s.splitLids].sort()).toEqual(['b', 'c']); // 前提
    const out = boot(s, ['a', 'b']); // c は消えた
    expect(types(out.events, 'REQUEST_SPLIT_BODY')).toEqual([{ type: 'REQUEST_SPLIT_BODY', lid: 'b' }]);
    expect(out.state.splitBodies.get('b')).toBe('OLD');
    // 返事が届けば新しい字に変わる(取り直しが空振りでない)
    const after = reduce(out.state, { type: 'SPLIT_BODY_LOADED', lid: 'b', body: 'NEW' }).state;
    expect(after.splitBodies.get('b')).toBe('NEW');
  });

  it('🔴 板の抜粋: 持っている lid を頼み直し、今の抜粋は残す。消えた lid は頼まない', () => {
    let s = ready();
    s = reduce(s, { type: 'PLACE_BODY_LOADED', lid: 'b', body: 'OLD' }).state;
    s = reduce(s, { type: 'PLACE_BODY_LOADED', lid: 'c', body: 'OLD' }).state;
    expect(s.placeBodies.size).toBe(2); // 前提
    const out = boot(s, ['a', 'b']);
    expect(types(out.events, 'REQUEST_PLACE_BODY')).toEqual([{ type: 'REQUEST_PLACE_BODY', lid: 'b' }]);
    expect(out.state.placeBodies.get('b')?.text).toBe('OLD');
  });

  it('対照群: 何も留めていない / 板に何も無ければ撃たない', () => {
    const out = boot(ready(), ['a', 'b', 'c']);
    expect(types(out.events, 'REQUEST_SPLIT_BODY')).toHaveLength(0);
    expect(types(out.events, 'REQUEST_PLACE_BODY')).toHaveLength(0);
  });
});
