/** @vitest-environment node */
/**
 * 🔴 **端末間の同期(#2000 段 3)── 色ラベル・ピン留めを、差分ファイルで 2 台の実物の worker の間で運ぶ**。
 * 空振り防止: 各 test は「入れた印が別の端末の DB に実際に出る」を数と中身で確かめ、対照(運ばない・古いファイル)も見る。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { exportSyncDiff, importSyncDiff } from '../../src/adapter/ui/actions/sync-diff';
import { spawnDevice, type SyncDevice } from '../helpers/sync-device';

const devices: SyncDevice[] = [];
async function dev(name: string, on = true): Promise<SyncDevice> {
  const d = await spawnDevice(name);
  devices.push(d);
  await d.setEnabled(on);
  return d;
}
afterEach(async () => {
  for (const d of devices.splice(0)) await d.close().catch(() => undefined);
});

const labels = async (d: SyncDevice): Promise<Record<string, number>> =>
  Object.fromEntries((await d.request({ op: 'listNoteLabels', cid: d.cid })).map((l) => [l.lid, l.color]));
const pins = (d: SyncDevice): Promise<string[]> => d.request({ op: 'listNotePins', cid: d.cid });
const setLabel = (d: SyncDevice, lid: string, color: number | null): Promise<null> => d.request({ op: 'putNoteLabel', cid: d.cid, lid, color });
const setPin = (d: SyncDevice, lid: string, on: boolean): Promise<null> => d.request({ op: 'putNotePin', cid: d.cid, lid, on });
async function send(from: SyncDevice, to: SyncDevice): Promise<string> {
  from.lastDiff = null;
  await exportSyncDiff(from.deps(), { all: true });
  expect(from.failures).toEqual([]);
  const r = await importSyncDiff(to.deps(), from.lastDiff!.blob, from.lastDiff!.name);
  expect(to.failures).toEqual([]);
  expect(r.ok).toBe(true);
  return (to.reports[to.reports.length - 1] ?? []).join('\n');
}

describe('色ラベル・ピン留めを運ぶ(段 3)', () => {
  it('付けた色とピン留めが、別の端末に出る(留めていない・色の無いノートには出ない = 対照)', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '一つ目', '本文1');
    await a.put('n2', '二つ目', '本文2');
    await a.put('n3', '三つ目', '本文3');
    await setLabel(a, 'n1', 2);
    await setLabel(a, 'n3', 6);
    await setPin(a, 'n2', true);
    const report = await send(a, b);
    expect(await labels(b)).toEqual({ n1: 2, n3: 6 });
    expect(await pins(b)).toEqual(['n2']);
    expect(report).toContain('色ラベルを付けた(変えた)ノート: 2 件');
    expect(report).toContain('ピン留めしたノート: 1 件');
  });

  it('色を変える・外す・ピンを外すが往復で伝わる(同期の記録が前回の状態)', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '一つ目', '本文1');
    await a.put('n2', '二つ目', '本文2');
    await setLabel(a, 'n1', 1);
    await setLabel(a, 'n2', 3);
    await setPin(a, 'n1', true);
    await send(a, b);
    await send(b, a); // 記録を作る(2 回目以降は変わった物だけ)
    // A で変える
    await setLabel(a, 'n1', 4);
    await setLabel(a, 'n2', null);
    await setPin(a, 'n1', false);
    const report = await send(a, b);
    expect(await labels(b)).toEqual({ n1: 4 });
    expect(await pins(b)).toEqual([]);
    expect(report).toContain('色ラベルを外したノート: 1 件');
    expect(report).toContain('ピン留めを外したノート: 1 件');
  });

  it('両方で違う色にした: どちらの端末でも色の番号が大きい方に収まる(往復で食い違いが残らない)', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '一つ目', '本文');
    await setLabel(a, 'n1', 2);
    await send(a, b);
    await send(b, a);
    await setLabel(a, 'n1', 3);
    await setLabel(b, 'n1', 6);
    const rep1 = await send(a, b); // B: 6 を残す(6 > 3)
    expect(await labels(b)).toEqual({ n1: 6 });
    expect(rep1).toContain('両方で違う色だった');
    await send(b, a);
    expect(await labels(a)).toEqual({ n1: 6 });
    // 往復を続けても動かない
    await send(a, b);
    await send(b, a);
    expect(await labels(a)).toEqual({ n1: 6 });
    expect(await labels(b)).toEqual({ n1: 6 });
  });

  it('ゴミ箱へ移したノートの印は運ばない・戻すと印も戻る(印の行は残す)', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '一つ目', '本文');
    await setLabel(a, 'n1', 2);
    await send(a, b);
    await send(b, a);
    await a.del('n1');
    await send(a, b);
    // B ではノートがゴミ箱へ(印の行は残る = 戻したら色も戻る)
    expect((await b.request({ op: 'listEntryMetas', cid: b.cid })).map((m) => m.lid)).toEqual([]);
    expect(await labels(b)).toEqual({ n1: 2 });
  });

  it('取り込みの取り消しで、印も元に戻る', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '一つ目', '本文');
    await setLabel(a, 'n1', 2);
    await setPin(a, 'n1', true);
    await send(a, b);
    expect(await labels(b)).toEqual({ n1: 2 });
    expect(b.undo).not.toBeNull();
    await b.undo!.run();
    expect(await labels(b)).toEqual({});
    expect(await pins(b)).toEqual([]);
  });

  it('設定が切の端末は印を書かない(取り込みを断る)', async () => {
    const a = await dev('A');
    const b = await dev('B', false);
    await a.put('n1', '一つ目', '本文');
    await setLabel(a, 'n1', 2);
    a.lastDiff = null;
    await exportSyncDiff(a.deps(), { all: true });
    const r = await importSyncDiff(b.deps(), a.lastDiff!.blob, a.lastDiff!.name);
    expect(r.ok).toBe(false);
    expect(await labels(b)).toEqual({});
  });
});
