/** @vitest-environment node */
/**
 * 🔴 選択同期の画面の写しの材料(`syncSelectiveView`。#2066 段 5-B)── 実物の worker。
 *
 * 1. 同期が切: 断らずに既定を返し、DB に同期の行を 1 本も作らない
 * 2. ワークスペース全体: ノートを読まない(notes / relations / bodyRefs が空)
 * 3. 選択同期: メタ・親フォルダ・つながりを返す。本文の参照は関連をたどるときだけ
 * 4. 書き出しと同じ閉包になる(`syncSnapshot` から作った閉包と、写しから作った閉包が同じ)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnDevice, type SyncDevice } from '../helpers/sync-device';
import { selectiveClosureOf } from '../../src/adapter/ui/actions/sync-diff';
import { buildSyncScopeView } from '../../src/features/sync/selective-view';

const devices: SyncDevice[] = [];
afterEach(async () => {
  for (const d of devices.splice(0)) await d.close().catch(() => undefined);
});

async function seeded(on = true): Promise<SyncDevice> {
  const d = await spawnDevice('V');
  devices.push(d);
  await d.setEnabled(true);
  await d.put('F', 'フォルダ', '', { archetype: 'folder' });
  await d.put('n1', '中のメモ', `本文 [外へ](entry:x)`, { parent: 'F' });
  await d.put('x', '外のメモ', '外');
  await d.put('p', '私的なメモ', '秘密');
  await d.request({ op: 'bulkUpsertRelations', cid: d.cid, relations: [{ id: 'r1', fromLid: 'p', toLid: 'x', kind: 'semantic' }] });
  if (!on) await d.setEnabled(false);
  return d;
}

describe('syncSelectiveView(実物の worker)', () => {
  it('🔴 同期が切: 断らずに既定を返す(選択同期の設定が残っていても読まない)', async () => {
    const d = await seeded(true);
    await d.request({ op: 'syncSetSelectiveScope', cid: d.cid, mode: 'selective', add: ['F'] });
    await d.setEnabled(false);
    const r = await d.request({ op: 'syncSelectiveView', cid: d.cid });
    expect(r).toEqual({ selective: { mode: 'all', related: '1hop', directLids: [] }, notes: [], relations: [], bodyRefs: {} });
  }, 60_000);

  it('🔴 ワークスペース全体: ノートを 1 件も返さない(読まない)', async () => {
    const d = await seeded(true);
    const r = await d.request({ op: 'syncSelectiveView', cid: d.cid });
    expect(r.selective.mode).toBe('all');
    expect(r.notes).toEqual([]);
    expect(r.relations).toEqual([]);
    expect(r.bodyRefs).toEqual({});
  }, 60_000);

  it('選択同期: メタと親フォルダ・つながりを返し、本文の参照は関連をたどるときだけ(対照群: 含めない)', async () => {
    const d = await seeded(true);
    await d.request({ op: 'syncSetSelectiveScope', cid: d.cid, mode: 'selective', related: 'off', add: ['F'] });
    const off = await d.request({ op: 'syncSelectiveView', cid: d.cid });
    expect(off.notes.map((n) => n.lid).sort()).toEqual(['F', 'n1', 'p', 'x']);
    expect(off.notes.find((n) => n.lid === 'n1')?.parentLid).toBe('F');
    expect(off.relations).toEqual([{ from: 'p', to: 'x', kind: 'semantic' }]);
    expect(off.bodyRefs, '含めないのに本文を読んだ').toEqual({});
    await d.request({ op: 'syncSetSelectiveScope', cid: d.cid, related: '1hop' });
    const hop = await d.request({ op: 'syncSelectiveView', cid: d.cid });
    expect(hop.bodyRefs).toEqual({ n1: ['x'] });
    const v = buildSyncScopeView(hop);
    expect(Object.fromEntries(v.reasons)).toEqual({ F: 'direct', n1: 'descendant', x: 'related' });
  }, 60_000);

  it('🔴 書き出しと同じ閉包(syncSnapshot からの閉包と、写しの閉包が一致する)', async () => {
    const d = await seeded(true);
    await d.request({ op: 'syncSetSelectiveScope', cid: d.cid, mode: 'selective', related: 'recursive', add: ['F'] });
    const snap = await d.request({ op: 'syncSnapshot', cid: d.cid, ensureDevice: true });
    const closure = selectiveClosureOf(snap);
    const view = buildSyncScopeView(await d.request({ op: 'syncSelectiveView', cid: d.cid }));
    expect(closure).not.toBeNull();
    expect([...view.reasons].sort()).toEqual([...closure!.reasons].sort());
    // recursive なので p(x とつながる)も関連で入る
    expect(view.reasons.get('p')).toBe('related');
  }, 60_000);
});
