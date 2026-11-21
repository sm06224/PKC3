/** @vitest-environment node */
/**
 * 🔴 端末間の同期(#2000 段 2)── バックアップの種(同じバックアップから復元した 2 台。設計 doc §12.1 の約束 2)を、実物の worker で通す。
 * 純関数・ファイルの読み書きは `tests/features/sync/sync-seed.test.ts`。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { backupSyncSeed, exportSyncDiff, importSyncDiff, seedSyncFromBackup } from '../../src/adapter/ui/actions/sync-diff';
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
const live = async (d: SyncDevice) => (await d.request({ op: 'listEntryMetas', cid: d.cid })).map((m) => m.lid).sort();
const body = async (d: SyncDevice, lid: string) => (await d.request({ op: 'getBodies', cid: d.cid, lids: [lid] }))[0]?.body ?? null;
const snap = (d: SyncDevice) => d.request({ op: 'syncSnapshot', cid: d.cid });
async function send(from: SyncDevice, to: SyncDevice): Promise<string> {
  from.lastDiff = null;
  await exportSyncDiff(from.deps(), { all: true });
  expect(from.failures).toEqual([]);
  await importSyncDiff(to.deps(), from.lastDiff!.blob, from.lastDiff!.name);
  expect(to.failures).toEqual([]);
  return (to.reports[to.reports.length - 1] ?? []).join('\n');
}

/** A の持つノートを、B が「同じバックアップから復元した」姿にする(lid も内容も同じ)。 */
async function restoredTwins() {
  const a = await dev('A');
  const b = await dev('B');
  for (const [lid, title, text] of [['n1', '議事録', '初稿1'], ['n2', '企画', '初稿2']] as const) {
    await a.put(lid, title, text);
    await b.put(lid, title, text);
  }
  const seed = (await backupSyncSeed(a.deps()))!;
  return { a, b, seed };
}

describe('バックアップの種(同じバックアップから復元した 2 台)', () => {
  it('種があると、復元後に別々に編集しても競合にならず合わさる(種が無い端末では「初回の同期」になる ── 対照)', async () => {
    const { a, b, seed } = await restoredTwins();
    expect(seed.device).toBe((await snap(a)).device);
    await seedSyncFromBackup(b.deps(), seed, new Set(['n1', 'n2']));
    expect(Object.keys((await snap(b)).bases[seed.device]!.baseline).sort()).toEqual(['n1', 'n2']);
    await a.put('n1', '議事録', 'A の編集');
    await b.put('n2', '企画', 'B の編集');
    const report = await send(a, b);
    expect(await body(b, 'n1')).toBe('A の編集'); // 相手だけが変えた → 取り込む
    expect(await body(b, 'n2')).toBe('B の編集'); // こちらだけが変えた → 残す
    expect(await live(b)).toEqual(['n1', 'n2']); // 競合のコピーは 1 件も出ない
    expect(report).not.toContain('競合');
    expect(report).not.toContain('初回の同期');

    // 対照: 種を書かなかった端末では、同じ操作で編集した物が「初回の同期」になる
    const c = await dev('C');
    for (const [lid, title, text] of [['n1', '議事録', '初稿1'], ['n2', '企画', '初稿2']] as const) await c.put(lid, title, text);
    await c.put('n1', '議事録', 'C の編集');
    expect(await send(a, c)).toContain('初回の同期で内容が違った物: 1 件');
  });

  it('オフの端末は種を書かない・自分の id の種は捨てる・振り直した lid は種にしない・育った記録は巻き戻さない', async () => {
    const { b, seed } = await restoredTwins();
    const off = await dev('Off', false);
    await off.put('n1', '議事録', '初稿1');
    await seedSyncFromBackup(off.deps(), seed, new Set(['n1']));
    await off.setEnabled(true); // 切の間は worker が同期の op を断る。読むために入にする(入にするだけでは行は書かれない)
    expect((await snap(off)).device).toBeNull();
    expect((await snap(off)).bases).toEqual({});
    // 自分の id の種(自分が書き出したバックアップを自分へ戻した)は捨てる
    const self = (await backupSyncSeed(b.deps()))!.device;
    await seedSyncFromBackup(b.deps(), { ...seed, device: self }, new Set(['n1']));
    expect((await snap(b)).bases[self]).toBeUndefined();
    // 振り直して入った lid(`keptLids` に無い)は種にしない
    await seedSyncFromBackup(b.deps(), seed, new Set(['n1']));
    expect(Object.keys((await snap(b)).bases[seed.device]!.baseline)).toEqual(['n1']);
    // 既にその相手の記録が育っていれば、書き直さない
    await seedSyncFromBackup(b.deps(), seed, new Set(['n1', 'n2']));
    expect(Object.keys((await snap(b)).bases[seed.device]!.baseline)).toEqual(['n1']);
  });

  it('オフの端末のバックアップには種を添えない(行も作らない)', async () => {
    const off = await dev('Off', false);
    await off.put('n1', '題', '本文');
    expect(await backupSyncSeed(off.deps())).toBeNull();
    await off.setEnabled(true);
    expect((await snap(off)).device).toBeNull();
  });
});
