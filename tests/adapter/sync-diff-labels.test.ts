/** @vitest-environment node */
/**
 * 🔴 **端末間の同期(#2000 段 3)── 色ラベル・ピン留めを、実物の worker(2 台)で通す**。
 *
 * 見る物: 付ける・変える・外すが相手へ届く / 両方で違う色はこちらを残し、次の往復で収まる(競合が増え続けない)/
 * ノートがゴミ箱へ行くときは印を外さない / 印を運ばない古い差分ファイル(バージョン 1)ではこちらの印を外さない /
 * 取り消しは取り込み後に付け直した印を触らない。
 * 空振り防止: どの test も「片方に付けた印が、もう片方の DB(`listNoteLabels` / `listNotePins`)に出る / 出ない」を実物で見る。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { applySyncDiff, exportSyncDiff, importSyncDiff, UNDO_LIMIT_LINE } from '../../src/adapter/ui/actions/sync-diff';
import { readDiffZip, writeDiffZip, type DiffNote } from '../../src/features/sync/diff-file';
import { folderFileName } from '../../src/features/sync/sync-folder';
import { spawnDevice, type SyncDevice } from '../helpers/sync-device';

const devices: SyncDevice[] = [];
async function dev(name: string): Promise<SyncDevice> {
  const d = await spawnDevice(name);
  devices.push(d);
  await d.setEnabled(true);
  return d;
}
afterEach(async () => {
  for (const d of devices.splice(0)) await d.close().catch(() => undefined);
});

async function send(from: SyncDevice, to: SyncDevice, opts: { all?: boolean } = {}): Promise<void> {
  from.lastDiff = null;
  await exportSyncDiff(from.deps(), opts);
  expect(from.failures, '書き出しが失敗した').toEqual([]);
  const r = await importSyncDiff(to.deps(), from.lastDiff!.blob, from.lastDiff!.name);
  expect(to.failures, '取り込みが失敗した').toEqual([]);
  expect(r.ok).toBe(true);
}
const labels = async (d: SyncDevice): Promise<Record<string, number>> =>
  Object.fromEntries((await d.request({ op: 'listNoteLabels', cid: d.cid })).map((x) => [x.lid, x.color]));
const pins = async (d: SyncDevice): Promise<string[]> => [...(await d.request({ op: 'listNotePins', cid: d.cid }))].sort();
const setLabel = (d: SyncDevice, lid: string, color: number | null): Promise<unknown> => d.request({ op: 'putNoteLabel', cid: d.cid, lid, color });
const setPin = (d: SyncDevice, lid: string, on: boolean): Promise<unknown> => d.request({ op: 'putNotePin', cid: d.cid, lid, on });

/** A と B に同じ 2 件を持たせて 1 往復させる(以後は差分の往復)。 */
async function pair(): Promise<{ a: SyncDevice; b: SyncDevice }> {
  const a = await dev('A');
  const b = await dev('B');
  await a.put('n1', '日本語のメモ', '本文 1');
  await a.put('n2', '二つ目', '本文 2');
  await send(a, b, { all: true });
  await send(b, a);
  return { a, b };
}

describe('色ラベル・ピン留め(段 3)', () => {
  it('付けた色とピンが相手へ届き、変えた色・外したピンも届く', async () => {
    const { a, b } = await pair();
    expect(await labels(b), '対照群: 付ける前は何も無い').toEqual({});
    await setLabel(a, 'n1', 3);
    await setPin(a, 'n2', true);
    await send(a, b);
    expect(await labels(b)).toEqual({ n1: 3 });
    expect(await pins(b)).toEqual(['n2']);
    expect(b.reports.at(-1)?.join('\n')).toContain('相手に合わせた色ラベル: 1 件');
    // 変える・外す
    await setLabel(a, 'n1', 5);
    await setPin(a, 'n2', false);
    await send(a, b);
    expect(await labels(b)).toEqual({ n1: 5 });
    expect(await pins(b)).toEqual([]);
  });

  it('外した色が相手で外れる(付ける側だけでなく外す側も届く ── 片道にしない)', async () => {
    const { a, b } = await pair();
    await setLabel(a, 'n1', 2);
    await send(a, b);
    await send(b, a);
    expect(await labels(b)).toEqual({ n1: 2 });
    await setLabel(b, 'n1', null);
    await send(b, a);
    expect(await labels(a)).toEqual({});
  });

  it('両方で違う色: こちらを残し、次の往復で片方の色に収まる(行ったり来たりしない)', async () => {
    const { a, b } = await pair();
    await setLabel(a, 'n1', 1);
    await setLabel(b, 'n1', 4);
    await send(a, b);
    expect(await labels(b), 'B はこちら(4)を残す').toEqual({ n1: 4 });
    expect(b.reports.at(-1)?.join('\n')).toContain('両方で違う色ラベル・ピン留めにしていた物: 1 件');
    await send(b, a);
    const settled = (await labels(a)).n1;
    await send(a, b);
    await send(b, a);
    expect((await labels(a)).n1, '収まった後は動かない').toBe(settled);
    expect((await labels(b)).n1, '両方が同じ色に収まる').toBe(settled);
  });

  it('相手でノートがゴミ箱へ行っても、こちらの印は外さない(戻したら印も戻る)', async () => {
    const { a, b } = await pair();
    await setPin(b, 'n1', true);
    await setLabel(b, 'n1', 6);
    await send(b, a);
    await send(a, b);
    await a.del('n1');
    await send(a, b);
    const metas = await b.request({ op: 'listEntryMetas', cid: b.cid });
    expect(metas.map((m) => m.lid), 'ノートはゴミ箱へ移った').not.toContain('n1');
    const raw = await b.request({ op: 'listNoteLabels', cid: b.cid });
    expect(raw.map((x) => x.lid), 'ゴミ箱のノートの色は残る').toContain('n1');
    expect(await b.request({ op: 'listNotePins', cid: b.cid }), 'ゴミ箱のノートのピンも残る').toContain('n1');
    expect(b.reports.at(-1)?.join('\n'), '外していない印を「合わせた」と数えない').not.toContain('相手に合わせた');
  });

  it('相手がゴミ箱へ入れ、こちらが編集して残したノート: こちらの色・ピンは外れない', async () => {
    const { a, b } = await pair();
    await setPin(b, 'n1', true);
    await setLabel(b, 'n1', 6);
    await send(b, a);
    await send(a, b);
    expect(await labels(a), '対照群: 印は両方に届いている').toEqual({ n1: 6 });
    await a.del('n1');
    await b.put('n1', '日本語のメモ', '本文 1 をこちらで直した');
    await send(a, b);
    const metas = await b.request({ op: 'listEntryMetas', cid: b.cid });
    expect(metas.map((m) => m.lid), 'こちらで直したノートは残る').toContain('n1');
    expect(await labels(b), 'こちらの色は残る').toEqual({ n1: 6 });
    expect(await pins(b), 'こちらのピンも残る').toEqual(['n1']);
    // 次の往復でも外れない(合意を消していない)
    await send(b, a);
    await send(a, b);
    expect(await labels(b)).toEqual({ n1: 6 });
    expect(await pins(b)).toEqual(['n1']);
    // 合意を持ち越しているので、その後に相手が変えた色は「相手の変更」として届く(合意が無いと「両方で違う色」になりこちらが残る)
    await setLabel(a, 'n1', 2);
    await send(a, b);
    expect(await labels(b), '相手が後から変えた色が届く').toEqual({ n1: 2 });
  });

  it('こちらがゴミ箱へ入れ、相手が編集して残したノート: 相手の色・ピンが残る(対称の反対側)', async () => {
    const { a, b } = await pair();
    await setPin(a, 'n1', true);
    await setLabel(a, 'n1', 4);
    await send(a, b);
    await send(b, a);
    expect(await labels(b), '対照群: 印は両方に届いている').toEqual({ n1: 4 });
    await b.del('n1');
    await a.put('n1', '日本語のメモ', '本文 1 を相手で直した');
    await send(a, b);
    const metas = await b.request({ op: 'listEntryMetas', cid: b.cid });
    expect(metas.map((m) => m.lid), '相手が直したノートはこちらでも生きている').toContain('n1');
    expect(await labels(b), '相手の色が残る').toEqual({ n1: 4 });
    expect(await pins(b), '相手のピンも残る').toEqual(['n1']);
    await send(b, a);
    expect(await labels(a), '相手(A)の色も外れない').toEqual({ n1: 4 });
    expect(await pins(a)).toEqual(['n1']);
  });

  it('取り消し: 取り込みで付けた印は外れ、取り込み後に付け直した印は触らない', async () => {
    const { a, b } = await pair();
    await setLabel(a, 'n1', 3);
    await setLabel(a, 'n2', 3);
    await send(a, b);
    expect(await labels(b)).toEqual({ n1: 3, n2: 3 });
    await setLabel(b, 'n2', 7); // 取り込み後に付け直した
    await b.undo!.run();
    expect(await labels(b)).toEqual({ n2: 7 });
  });

  it('印を運ばない古い差分ファイル(バージョン 1)では、こちらの印を外さない', async () => {
    const { a, b } = await pair();
    await setLabel(b, 'n1', 2);
    await setPin(b, 'n1', true);
    await send(b, a);
    await send(a, b);
    // A の差分ファイルを、バージョン 1 の形(印の欄なし)へ作り直す
    a.lastDiff = null;
    await exportSyncDiff(a.deps(), { all: true });
    const v2 = await readDiffZip(a.lastDiff!.blob);
    expect(v2.manifest.version).toBe(2);
    expect(v2.container.labels, '対照群: 新しい形は印を運ぶ').toEqual([{ lid: 'n1', color: 2 }]);
    async function* notes(): AsyncGenerator<DiffNote> {
      for (const n of v2.container.notes) yield n;
    }
    const out = await writeDiffZip({
      manifest: { ...v2.manifest, seq: v2.manifest.seq + 1 },
      notes: notes(),
      relations: v2.container.relations,
      tombstones: v2.container.tombstones,
      fingerprints: v2.container.fingerprints.filter((f) => !f.key.startsWith('lab:') && !f.key.startsWith('pin:')),
      peerBase: v2.container.peerBase.filter((f) => !f.key.startsWith('lab:') && !f.key.startsWith('pin:')),
      labels: [],
      pins: [],
      assets: () => [],
      getAssetBlob: async () => null,
    });
    // manifest の版を 1 にし、本体から印の欄を抜いた zip を作る(古いビルドが書いた形)
    const { ZipWriter } = await import('../../src/features/export/zip-writer');
    const { readZipDirectory, readZipText } = await import('../../src/features/import/zip-reader');
    const dir = await readZipDirectory(out.blob);
    const man = JSON.parse(await readZipText(out.blob, dir.find((e) => e.name === 'manifest.json')!)) as Record<string, unknown>;
    const body = JSON.parse(await readZipText(out.blob, dir.find((e) => e.name === 'container.json')!)) as Record<string, unknown>;
    delete body.labels;
    delete body.pins;
    const w = new ZipWriter();
    await w.add('manifest.json', [JSON.stringify({ ...man, version: 1 })]);
    await w.add('container.json', [JSON.stringify(body)]);
    const v1 = w.finish();
    const read = await readDiffZip(v1);
    expect(read.container.labels, 'バージョン 1 は印を運ばない(空の配列と区別する)').toBeUndefined();
    const r = await importSyncDiff(b.deps(), v1, 'old.pkc3-diff.zip');
    expect(b.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(await labels(b), 'こちらの色は残る').toEqual({ n1: 2 });
    expect(await pins(b), 'こちらのピンも残る').toEqual(['n1']);
  });

  it('system 領域のノートを指す印は読まない(門は読み手にある)', async () => {
    const { a } = await pair();
    a.lastDiff = null;
    await exportSyncDiff(a.deps(), { all: true });
    const v2 = await readDiffZip(a.lastDiff!.blob);
    async function* none(): AsyncGenerator<DiffNote> {}
    const out = await writeDiffZip({
      manifest: v2.manifest,
      notes: none(),
      relations: [],
      tombstones: [],
      fingerprints: [{ key: 'lab:sys-messages', c: 'x' }],
      peerBase: [],
      labels: [{ lid: 'sys-messages', color: 1 }],
      pins: ['sys-messages'],
      assets: () => [],
      getAssetBlob: async () => null,
    });
    const read = await readDiffZip(out.blob);
    expect(read.container.labels).toEqual([]);
    expect(read.container.pins).toEqual([]);
    expect(read.container.fingerprints).toEqual([]);
    expect(read.dropped.reserved).toBe(2);
  });
});

describe('無人の同期と「取り込みを取り消す」', () => {
  it('無人の回(auto)は、直前に手で取り込んだ回の取り消しを奪わない', async () => {
    const { a, b } = await pair();
    await a.put('n1', '日本語のメモ', '手で取り込む版');
    await send(a, b);
    const manual = b.undo;
    expect(manual, '対照群: 手の取り込みは取り消しを登録する').not.toBeNull();
    // 次の変更を、同期フォルダの無人の回として取り込む
    await a.put('n2', '二つ目', '無人で取り込む版');
    a.lastDiff = null;
    await exportSyncDiff(a.deps());
    const diff = await readDiffZip(a.lastDiff!.blob);
    const out = await applySyncDiff(b.deps(), diff, folderFileName(diff.manifest.device), { auto: true, folder: true });
    expect(out, `無人の回が失敗した: ${JSON.stringify(out)} / ${JSON.stringify(b.failures)}`).toMatchObject({ ok: true });
    expect(out.ok && out.changed, '無人の回で実際に書き込んだ(空振りでない)').toBeGreaterThan(0);
    expect(b.undo, '手の取り込みの取り消しが残る').toBe(manual);
    expect(b.reports.at(-1)?.join('\n'), '無人の回の結果に「取り消せる」の案内を出さない').not.toContain(UNDO_LIMIT_LINE);
    // 残った取り消しは手の回だけを戻す(無人の回の n2 は触らない)
    await manual!.run();
    const bodies = Object.fromEntries((await b.request({ op: 'listEntryMetas', cid: b.cid })).map((m) => [m.lid, m.title]));
    expect(Object.keys(bodies)).toEqual(expect.arrayContaining(['n1', 'n2']));
  });
});
