/**
 * 🔴 選択同期(#2066 段 5-B)の画面の写し ── `buildSyncScopeView` / `selectiveActive` / `selectiveMenuCtx` / 件数の要約。
 * 空振り防止: 「ワークスペース全体」と「選択同期」を同じ材料で組み、閉包が後者でだけ出ることを見る。
 */
import { describe, expect, it } from 'vitest';
import {
  buildSyncScopeView,
  selectiveActive,
  selectiveMenuCtx,
  selectiveSummaryText,
  SELECTIVE_EMPTY_TEXT,
  type SelectiveViewInput,
} from '../../../src/features/sync/selective-view';

const notes = [
  { lid: 'F', archetype: 'folder', parentLid: null },
  { lid: 'G', archetype: 'folder', parentLid: 'F' },
  { lid: 'a', archetype: 'text', parentLid: 'F' },
  { lid: 'g1', archetype: 'text', parentLid: 'G' },
  { lid: 'x', archetype: 'text', parentLid: null },
  { lid: 'y', archetype: 'text', parentLid: null },
  { lid: 'R', archetype: 'folder', parentLid: null },
  { lid: 'r1', archetype: 'text', parentLid: 'R' },
  { lid: 'r2', archetype: 'text', parentLid: 'R' },
];

const input = (over: Partial<SelectiveViewInput['selective']> = {}): SelectiveViewInput => ({
  selective: { mode: 'selective', related: '1hop', directLids: ['F'], ...over },
  notes,
  relations: [{ from: 'a', to: 'x', kind: 'semantic' }],
  bodyRefs: { g1: ['r1'] },
});

describe('buildSyncScopeView', () => {
  it('選択同期: 直接指定 / 配下 / 関連 / 親フォルダの階層のみ を出し分け、件数を数える', () => {
    const v = buildSyncScopeView(input());
    expect(Object.fromEntries(v.reasons)).toEqual({
      F: 'direct',
      G: 'descendant',
      a: 'descendant',
      g1: 'descendant',
      x: 'related',
      r1: 'related',
      R: 'ancestor',
    });
    expect(v.counts).toEqual({ total: 7, direct: 1, descendant: 3, related: 2, ancestor: 1 });
    // 🔴 親フォルダの階層のみ(R)からは、中のほかのエントリ(r2)を連れてこない
    expect(v.reasons.has('r2')).toBe(false);
    expect(v.reasons.has('y')).toBe(false);
    // 配下は、どの直接指定のフォルダから来たか
    expect(v.via.get('g1')).toBe('F');
    expect(v.via.get('a')).toBe('F');
    expect(selectiveActive(v)).toBe(true);
  });

  it('関連を「含めない」にすると関連と、関連が連れてきた親フォルダが消える(対照群: 1 段階)', () => {
    const v = buildSyncScopeView(input({ related: 'off' }));
    expect(v.counts).toEqual({ total: 4, direct: 1, descendant: 3, related: 0, ancestor: 0 });
  });

  it('ワークスペース全体: 閉包を計算しない(理由の表は空・件数 0)・選択同期の画面は出さない', () => {
    const v = buildSyncScopeView(input({ mode: 'all' }));
    expect(v.reasons.size).toBe(0);
    expect(v.counts.total).toBe(0);
    expect(selectiveActive(v)).toBe(false);
    expect(selectiveActive(null)).toBe(false);
  });

  it('指紋: 同じ材料なら同じ / 直接指定が変われば変わる', () => {
    expect(buildSyncScopeView(input()).key).toBe(buildSyncScopeView(input()).key);
    expect(buildSyncScopeView(input({ directLids: ['F', 'y'] })).key).not.toBe(buildSyncScopeView(input()).key);
    expect(buildSyncScopeView(input({ mode: 'all' })).key).not.toBe(buildSyncScopeView(input()).key);
  });
});

describe('selectiveMenuCtx(右クリックの材料)', () => {
  it('選択同期のとき user 領域だけ syncDirect を渡す / 効いていなければ渡さない', () => {
    const v = buildSyncScopeView(input());
    expect(selectiveMenuCtx(v, 'F')).toEqual({ syncDirect: true });
    expect(selectiveMenuCtx(v, 'a')).toEqual({ syncDirect: false });
    expect(selectiveMenuCtx(v, 'sys-messages')).toEqual({});
    expect(selectiveMenuCtx(buildSyncScopeView(input({ mode: 'all' })), 'F')).toEqual({});
    expect(selectiveMenuCtx(null, 'F')).toEqual({});
  });
});

describe('selectiveSummaryText', () => {
  it('件数の要約 / 0 件なら案内', () => {
    expect(selectiveSummaryText(buildSyncScopeView(input()).counts)).toBe('同期対象: 合計 7 件(直接指定 1 / フォルダ配下 3 / 関連 2 / 親フォルダ 1)');
    expect(selectiveSummaryText(buildSyncScopeView(input({ directLids: [] })).counts)).toBe(SELECTIVE_EMPTY_TEXT);
  });
});
