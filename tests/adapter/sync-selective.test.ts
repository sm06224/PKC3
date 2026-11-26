/** @vitest-environment node */
/**
 * 🔴 **選択同期(#2066 段 5-A)── 実物の worker の端末 2 台で、選択同期の 5 つの約束を往復で確かめる**。
 *
 * 1. 送信の隔離: 選択の外のノート・つながり・色ラベル・ピン留め・添付・私的な削除の記録が差分 zip に 1 件も入らない
 * 2. 選択を外すのは削除ではない: 前回同期したノートを外して書き出しても削除の記録は 0 件・相手で消えない(本当に消した物だけが伝わる)
 * 3. 互換: 選択同期はバージョン 3、全部のときはバージョン 2(今までと同じ)
 * 4. 受け手の保護と往復: A(フォルダ P を選択)→ 空の B(選択同期)→ B で編集 → A へ戻る。B の私的なメモは漏れない
 * 5. 取り消しで、取り込みが足した直接指定(`sel:<lid>`)も戻る / 同期が切なら設定の op は断る
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildSyncDiff, importSyncDiff, selectiveClosureOf } from '../../src/adapter/ui/actions/sync-diff';
import { readDiffZip, type DiffFile } from '../../src/features/sync/diff-file';
import { readZipDirectory, readZipText, unwrapSingleTopDir } from '../../src/features/import/zip-reader';
import { spawnDevice, type SyncDevice } from '../helpers/sync-device';

const devices: SyncDevice[] = [];
afterEach(async () => {
  for (const d of devices.splice(0)) await d.close().catch(() => undefined);
});

async function dev(name: string): Promise<SyncDevice> {
  const d = await spawnDevice(name);
  devices.push(d);
  await d.setEnabled(true);
  return d;
}

const liveTitles = async (d: SyncDevice): Promise<string[]> => (await d.request({ op: 'listEntryMetas', cid: d.cid })).map((m) => m.title).sort();
const snap = (d: SyncDevice) => d.request({ op: 'syncSnapshot', cid: d.cid, ensureDevice: true });

/** 差分を書き出して(ダウンロード)、読んだ結果と生の manifest を返す。 */
async function exportDiff(d: SyncDevice, all = false): Promise<{ blob: Blob; file: DiffFile; raw: Record<string, unknown>; text: string }> {
  const out = await buildSyncDiff(d.deps(), { kind: 'download', all });
  if (out.skipped) throw new Error('skipped');
  const dir = unwrapSingleTopDir(await readZipDirectory(out.blob)).entries;
  const raw = JSON.parse(await readZipText(out.blob, dir.find((e) => e.name === 'manifest.json')!)) as Record<string, unknown>;
  const text = await readZipText(out.blob, dir.find((e) => e.name === 'container.json')!);
  return { blob: out.blob, file: await readDiffZip(out.blob), raw, text: text + dir.map((e) => e.name).join('\n') };
}

/** A: フォルダ P(p1・p2)を選択。私的なメモ x(色ラベル・ピン留め・p1 とのつながり・添付つき)と、消した私的なメモ gone。 */
async function seedA(): Promise<SyncDevice> {
  const A = await dev('A');
  await A.put('P', '共有フォルダ', '', { archetype: 'folder' });
  await A.put('p1', '共有メモ1', '本文1 ![図](asset:ast-shared)', { parent: 'P' });
  await A.put('p2', '共有メモ2', '本文2', { parent: 'P' });
  await A.put('x', '私的なメモ', '秘密 PRIVATE-CANARY-91 ![図](asset:ast-private)');
  await A.put('gone', '消した私的なメモ', 'GONE-CANARY-55');
  await A.del('gone');
  A.blobs.set('ast-shared', new Blob(['shared']));
  A.blobs.set('ast-private', new Blob(['PRIVATE-ASSET-CANARY']));
  await A.request({ op: 'putAssetMeta', cid: A.cid, meta: { key: 'ast-shared', mime: 'image/png', size: 6, hash: null } });
  await A.request({ op: 'putAssetMeta', cid: A.cid, meta: { key: 'ast-private', mime: 'image/png', size: 20, hash: null } });
  await A.request({ op: 'putNoteLabel', cid: A.cid, lid: 'x', color: 3 });
  await A.request({ op: 'putNotePin', cid: A.cid, lid: 'x', on: true });
  await A.request({ op: 'bulkUpsertRelations', cid: A.cid, relations: [{ id: 'r-px', fromLid: 'p1', toLid: 'x', kind: 'semantic' }] });
  await A.request({ op: 'syncSetSelectiveScope', cid: A.cid, mode: 'selective', related: 'off', add: ['P'] });
  return A;
}

describe('選択同期の設定(worker)', () => {
  it('🔴 同期が切なら設定の op は断る / 既定と同じ値は行に残さない / 選択同期で関連をたどるときだけ本文の参照を抜き出す', async () => {
    const d = await spawnDevice('off');
    devices.push(d);
    await d.put('a', 'a', '[b へ](entry:b)');
    await d.put('b', 'b', 'b');
    await expect(d.request({ op: 'syncSetSelectiveScope', cid: d.cid, mode: 'selective' })).rejects.toThrow('端末間の同期がオフ');
    await d.setEnabled(true);
    let s = await snap(d);
    expect(s.selective).toEqual({ mode: 'all', related: '1hop', directLids: [] });
    expect(s.bodyRefs, '全部のノートの同期で本文の参照を抜き出した(手間が増える)').toEqual({});
    const set = await d.request({ op: 'syncSetSelectiveScope', cid: d.cid, mode: 'selective', add: ['b', 'a', 'sys-messages', ''] });
    expect(set).toEqual({ mode: 'selective', related: '1hop', directLids: ['a', 'b'] });
    s = await snap(d);
    expect(s.bodyRefs).toEqual({ a: ['b'] });
    await d.request({ op: 'syncSetSelectiveScope', cid: d.cid, related: 'off' });
    expect((await snap(d)).bodyRefs, "関連が 'off' なら抜き出さない").toEqual({});
    await expect(d.request({ op: 'syncSetSelectiveScope', cid: d.cid, related: 'wide' as never })).rejects.toThrow('値が正しくありません');
    // 既定に戻すと行が消える(既定の端末に行を残さない)── 戻した後の読みが既定になる
    await d.request({ op: 'syncSetSelectiveScope', cid: d.cid, mode: 'all', related: '1hop', remove: ['a', 'b'] });
    expect((await snap(d)).selective).toEqual({ mode: 'all', related: '1hop', directLids: [] });
  });
});

describe('🔴 不変条件 1・3: 送信の隔離とバージョン', () => {
  it('選択の外のノート・つながり・色ラベル・ピン留め・添付・私的な削除の記録が 1 件も入らない / バージョン 3', async () => {
    const A = await seedA();
    const { file, raw, text } = await exportDiff(A, true);
    expect(raw.version).toBe(3);
    expect(raw.scope).toBe('selective');
    expect(file.container.notes.map((n) => n.lid).sort()).toEqual(['P', 'p1', 'p2']);
    expect(file.container.fingerprints.map((f) => f.key).sort()).toEqual(['P', 'p1', 'p2']);
    expect(file.container.relations).toEqual([]);
    expect(file.container.labels).toEqual([]);
    expect(file.container.pins).toEqual([]);
    expect(file.container.tombstones).toEqual([]);
    expect(file.container.assets.map((a) => a.key)).toEqual(['ast-shared']);
    for (const leak of ['PRIVATE-CANARY-91', 'GONE-CANARY-55', 'ast-private', '私的なメモ', '"x"', 'gone']) expect(text.includes(leak), `漏れた: ${leak}`).toBe(false);
    // 対照(空振りでない): 全部に戻すと、同じ端末から全部が出る(バージョン 2)
    await A.request({ op: 'syncSetSelectiveScope', cid: A.cid, mode: 'all' });
    const ctl = await exportDiff(A, true);
    expect(ctl.raw.version).toBe(2);
    expect('scope' in ctl.raw).toBe(false);
    expect(ctl.text.includes('PRIVATE-CANARY-91')).toBe(true);
    expect(ctl.file.container.tombstones.map((t) => t.key)).toContain('gone');
    expect(ctl.file.container.pins).toEqual(['x']);
  });

  it('関連を 1 段にすると、つながった私的なメモも運ぶ(関連の設定が書き出しに効く)', async () => {
    const A = await seedA();
    await A.request({ op: 'syncSetSelectiveScope', cid: A.cid, related: '1hop' });
    const { file } = await exportDiff(A, true);
    expect(file.container.notes.map((n) => n.lid).sort()).toEqual(['P', 'p1', 'p2', 'x']);
    expect(file.container.relations).toEqual([{ from: 'p1', to: 'x', kind: 'semantic' }]);
    expect(file.container.pins).toEqual(['x']);
  });
});

describe('🔴 不変条件 4: 往復(A → 空の B → B で編集 → A)', () => {
  it('B は選んだフォルダだけを受け取り、直接指定へ足す / B の編集は A へ戻る / B の私的なメモは A へ漏れない / A の私的なメモは触られない', async () => {
    const A = await seedA();
    const B = await dev('B');
    await B.put('bpriv', 'B の私的なメモ', 'B-PRIVATE-CANARY-77');
    await B.request({ op: 'syncSetSelectiveScope', cid: B.cid, mode: 'selective', related: 'off' });

    const a1 = await exportDiff(A, true);
    expect((await importSyncDiff(B.deps(), a1.blob, 'a1.pkc3-diff.zip')).ok).toBe(true);
    expect(B.failures).toEqual([]);
    expect(await liveTitles(B)).toEqual(['B の私的なメモ', '共有フォルダ', '共有メモ1', '共有メモ2']);
    expect((await snap(B)).selective.directLids, '新しく入ったフォルダを直接指定へ足していない(次の書き出しで返らない)').toEqual(['P']);
    expect(B.blobs.has('ast-shared')).toBe(true);
    expect(B.blobs.has('ast-private')).toBe(false);

    // B で編集して書き出す ── B の私的なメモは入らない
    await B.put('p1', '共有メモ1', 'B で直した本文', { parent: 'P' });
    const b1 = await exportDiff(B);
    expect(b1.raw.version).toBe(3);
    expect(b1.file.container.notes.map((n) => n.lid)).toEqual(['p1']);
    expect(b1.text.includes('B-PRIVATE-CANARY-77')).toBe(false);
    expect(b1.file.container.fingerprints.map((f) => f.key).sort()).toEqual(['P', 'p1', 'p2']);

    expect((await importSyncDiff(A.deps(), b1.blob, 'b1.pkc3-diff.zip')).ok).toBe(true);
    expect(A.failures).toEqual([]);
    const bodies = await A.request({ op: 'getBodies', cid: A.cid, lids: ['p1', 'x'] });
    expect(bodies.find((r) => r.lid === 'p1')?.body).toBe('B で直した本文');
    expect(bodies.find((r) => r.lid === 'x')?.body, 'A の私的なメモが書き換わった').toContain('PRIVATE-CANARY-91');
    expect(await liveTitles(A), 'A の私的なメモが B の部分の一覧で消された').toEqual(['共有フォルダ', '共有メモ1', '共有メモ2', '私的なメモ']);
    expect((await liveTitles(A)).includes('B の私的なメモ')).toBe(false);
  });

  it('🔴 受け手の保護: B が選択同期のとき、B の選択の外のノートへの A の変更は反映せず、結果の一覧で言う', async () => {
    const A = await dev('A');
    const B = await dev('B');
    await A.put('s', '共有', 's1');
    await A.put('o', '別のメモ', 'o1');
    // 初回は全部で同期(B は o も持っている)
    const first = await exportDiff(A, true);
    await importSyncDiff(B.deps(), first.blob, 'f.pkc3-diff.zip');
    expect(await liveTitles(B)).toEqual(['共有', '別のメモ']);
    // B は s だけを選ぶ。A は両方を直して(A は全部のまま)書き出す
    await B.request({ op: 'syncSetSelectiveScope', cid: B.cid, mode: 'selective', related: 'off', add: ['s'] });
    await A.put('s', '共有', 's2');
    await A.put('o', '別のメモ', 'o2');
    const second = await exportDiff(A);
    expect(second.raw.version).toBe(2);
    await importSyncDiff(B.deps(), second.blob, 's.pkc3-diff.zip');
    const bodies = await B.request({ op: 'getBodies', cid: B.cid, lids: ['s', 'o'] });
    expect(bodies.find((r) => r.lid === 's')?.body).toBe('s2');
    expect(bodies.find((r) => r.lid === 'o')?.body, '選択の外の原本が書き換わった').toBe('o1');
    expect(B.reports.at(-1)?.some((l) => l.includes('同期の対象に選んでいないため、相手からの変更を反映しなかった物: 1 件'))).toBe(true);
    // A が o を消しても、B の o はゴミ箱へ移らない
    await A.del('o');
    const third = await exportDiff(A);
    expect(third.file.container.tombstones.map((t) => t.key)).toEqual(['o']);
    await importSyncDiff(B.deps(), third.blob, 't.pkc3-diff.zip');
    expect(await liveTitles(B)).toEqual(['共有', '別のメモ']);
  });
});

describe('🔴 不変条件 2: 選択を外すのは削除ではない', () => {
  it('前回同期したフォルダを外して書き出しても削除の記録は 0 件・相手で消えない / 本当に消したノートだけが伝わる', async () => {
    const A = await seedA();
    const B = await dev('B');
    await importSyncDiff(B.deps(), (await exportDiff(A, true)).blob, 'a.pkc3-diff.zip');
    expect(await liveTitles(B)).toEqual(['共有フォルダ', '共有メモ1', '共有メモ2']);
    // 本当に消した p2 は伝わる
    await A.del('p2');
    const d1 = await exportDiff(A);
    expect(d1.file.container.tombstones.map((t) => t.key)).toEqual(['p2']);
    await importSyncDiff(B.deps(), d1.blob, 'd1.pkc3-diff.zip');
    expect(await liveTitles(B)).toEqual(['共有フォルダ', '共有メモ1']);
    // フォルダを選択から外す ── 削除の記録は 0 件、B では消えない
    await A.request({ op: 'syncSetSelectiveScope', cid: A.cid, remove: ['P'] });
    const d2 = await exportDiff(A);
    expect(d2.file.container.tombstones, '選択を外しただけで削除の記録が出た').toEqual([]);
    expect(d2.file.container.notes).toEqual([]);
    await importSyncDiff(B.deps(), d2.blob, 'd2.pkc3-diff.zip');
    expect(await liveTitles(B), '選択を外しただけで相手のノートが消えた').toEqual(['共有フォルダ', '共有メモ1']);
    // 対照: 全部のとき(バージョン 2)に同じことをすると……外す概念が無いので、A のノートが残る限り B も残る。
    // ここでは「選択同期の部分の一覧を全件と取り違えると消える」を、B 側を全部の扱いで読ませて確かめる
    const asAll = { ...d2.file, manifest: { ...d2.file.manifest, scope: 'all' as const } };
    const { planSyncImport } = await import('../../src/features/sync/sync-plan');
    const bs = await snap(B);
    const wouldTrash = planSyncImport({
      remote: asAll,
      remoteNoteFps: new Map(),
      localStates: bs.states,
      localRelations: bs.relations,
      localTitles: new Map(),
      localTombstones: [],
      baseline: bs.bases[(await snap(A)).device as string]!.baseline,
      date: '2026-11-26',
      genLid: () => 'z',
    }).trash.sort();
    expect(wouldTrash, '対照: 部分の一覧を全件として読むと消える(この差が守っている物)').toEqual(['P', 'p1']);
  });
});

describe('🔴 取り消しで、取り込みが足した直接指定も戻る', () => {
  it('syncUndo の後、B の直接指定は取り込み前(空)に戻り、入ったノートはゴミ箱へ', async () => {
    const A = await seedA();
    const B = await dev('B');
    await B.request({ op: 'syncSetSelectiveScope', cid: B.cid, mode: 'selective' });
    await importSyncDiff(B.deps(), (await exportDiff(A, true)).blob, 'a.pkc3-diff.zip');
    expect((await snap(B)).selective.directLids).toEqual(['P']);
    const r = await B.undo!.run();
    expect(r.restored).toBe(3);
    expect((await snap(B)).selective.directLids, '取り消しで直接指定が戻らなかった').toEqual([]);
    expect((await snap(B)).selective.mode, '取り消しで範囲の設定まで変わった').toBe('selective');
    expect(await liveTitles(B)).toEqual([]);
  });
});

describe('同期フォルダの書き直しの要約', () => {
  it('🔴 選択を変えたら、指紋が同じでも書き直す(同じなら書かない)', async () => {
    const A = await seedA();
    const target = (lastKey: string | null) => ({ kind: 'folder' as const, others: ['fedcba9876543210'], wantedBy: [], want: [], ownFilePresent: true, lastKey });
    const first = await buildSyncDiff(A.deps(), target(null));
    expect(first.skipped).toBe(false);
    const again = await buildSyncDiff(A.deps(), target(first.key));
    expect(again.skipped, '同じ中身なのに書き直した').toBe(true);
    // 生きていない lid を足す = 閉包は同じ・指定の行だけ変わる ── 閉包の要約が同じなら書き直さない(対照)
    await A.request({ op: 'syncSetSelectiveScope', cid: A.cid, add: ['ghost'] });
    expect((await buildSyncDiff(A.deps(), target(first.key))).skipped).toBe(true);
    // 対象を足す(x)── 書き直す
    await A.request({ op: 'syncSetSelectiveScope', cid: A.cid, add: ['x'] });
    const changed = await buildSyncDiff(A.deps(), target(first.key));
    expect(changed.skipped).toBe(false);
  });

  it('閉包の決め(selectiveClosureOf)は全部のときは null(今までと同じ動き)', async () => {
    const A = await dev('A');
    expect(selectiveClosureOf(await snap(A))).toBeNull();
  });
});
