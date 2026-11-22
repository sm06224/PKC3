/** @vitest-environment node */
/**
 * 🔴 **端末間の同期(#2000 段 2)── 差分ファイルの書き出し・取り込みを、実物の worker(2 台)で通す**。
 *
 * 見るのは経路ごとの結果(`decideMerge` の各判定が、実際に DB へ何を書くか)と、
 * 設定が切のときの断り・1 回の tx で失敗したら何も書かないこと・取り消し・端末 id の重複・ワークスペースの対応。
 * 空振り防止: 各 test は「入れた物が実際に別の端末の DB に出る」を数で確かめる(対照群として同じ操作をしない側も見る)。
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { exportSyncDiff, importSyncDiff } from '../../src/adapter/ui/actions/sync-diff';
import { writeDiffZip, type DiffNote } from '../../src/features/sync/diff-file';
import { entryFp } from '../../src/features/sync/sync-fp';
import { spawnDevice, type SyncDevice } from '../helpers/sync-device';

const sha256Of = (bytes: number[]): string => createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
const devices: SyncDevice[] = [];
async function dev(name: string, on = true, cid?: string): Promise<SyncDevice> {
  const d = await spawnDevice(name, cid);
  devices.push(d);
  await d.setEnabled(on);
  return d;
}
afterEach(async () => {
  for (const d of devices.splice(0)) await d.close().catch(() => undefined);
});

async function live(d: SyncDevice): Promise<Array<{ lid: string; title: string }>> {
  return (await d.request({ op: 'listEntryMetas', cid: d.cid })).map((m) => ({ lid: m.lid, title: m.title })).sort((a, b) => (a.lid < b.lid ? -1 : 1));
}
async function body(d: SyncDevice, lid: string): Promise<string | null> {
  return (await d.request({ op: 'getBodies', cid: d.cid, lids: [lid] }))[0]?.body ?? null;
}
async function snap(d: SyncDevice) {
  return d.request({ op: 'syncSnapshot', cid: d.cid });
}
/** from が書き出して to が取り込む。 */
async function send(from: SyncDevice, to: SyncDevice, opts: { all?: boolean } = {}): Promise<void> {
  from.lastDiff = null;
  await exportSyncDiff(from.deps(), opts);
  expect(from.failures, '書き出しが失敗した').toEqual([]);
  expect(from.lastDiff, '差分ファイルが出ていない').not.toBeNull();
  const r = await importSyncDiff(to.deps(), from.lastDiff!.blob, from.lastDiff!.name);
  expect(to.failures, '取り込みが失敗した').toEqual([]);
  expect(r.ok).toBe(true);
}
const lastReport = (d: SyncDevice): string => (d.reports[d.reports.length - 1] ?? []).join('\n');

describe('同期 OFF(既定)', () => {
  it('切のとき: 削除しても同期の行は 1 本も書かれない(端末 id も無い)', async () => {
    const a = await dev('A', false);
    await a.put('n1', '日本語の題名', '本文');
    await a.del('n1');
    // ⚠ 切の間は同期の op を worker が断る(防御の二重化)。読むために入にするが、入にするだけでは行は書かれない
    await expect(snap(a)).rejects.toThrow('オフ');
    await a.setEnabled(true);
    const s = await snap(a);
    expect(s.device).toBeNull();
    expect(s.tombstones).toEqual([]);
    expect(s.bases).toEqual({});
  });
  it('worker の門: 切のとき syncApply / syncCommitExport / syncSeed / syncMeasureNotes も断る(主スレッドの門が抜けても書かない)', async () => {
    const a = await dev('A', false);
    await expect(a.request({ op: 'syncCommitExport', cid: a.cid, digest: 'x' })).rejects.toThrow('オフ');
    await expect(a.request({ op: 'syncSeed', cid: a.cid, peer: '0123456789abcdef', baseline: {}, nowIso: '2026-11-21T00:00:00.000Z' })).rejects.toThrow('オフ');
    await expect(a.request({ op: 'syncMeasureNotes', notes: [] })).rejects.toThrow('オフ');
    await expect(
      a.request({ op: 'syncApply', cid: a.cid, input: { peer: '0123456789abcdef', peerCid: 'c', peerSeq: 1, upserts: [], trash: [], relationAdds: [], relationRemoves: [], baseline: {}, nowIso: '2026-11-21T00:00:00.000Z' } }),
    ).rejects.toThrow('オフ');
    await a.setEnabled(true);
    expect((await snap(a)).device).toBeNull(); // 断られた op は 1 行も書いていない
  });
  it('対照: 入のときは消すと削除の記録が残る', async () => {
    const a = await dev('A', true);
    await a.put('n1', '日本語の題名', '本文');
    await a.del('n1');
    const s = await snap(a);
    expect(s.tombstones.map((t) => t.key)).toEqual(['n1']);
  });
  it('取り込みは断り、設定の場所を言う(黙って無視しない)・何も書かない', async () => {
    const a = await dev('A', true);
    const b = await dev('B', false);
    await a.put('n1', '題名', '本文');
    await exportSyncDiff(a.deps());
    const r = await importSyncDiff(b.deps(), a.lastDiff!.blob, 'x.pkc3-diff.zip');
    expect(r.ok).toBe(false);
    expect(b.failures[0]).toContain('端末間の同期');
    expect(b.failures[0]).toContain('設定');
    expect((await live(b)).length).toBe(0);
    await b.setEnabled(true);
    expect((await snap(b)).device).toBeNull();
  });
});

describe('初回の同期 A → B(全件)', () => {
  it('ノート(日本語・フォルダ・つながり)が lid を保って入り、対応の確認は 1 回だけ・記録が書かれる', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('f1', '資料フォルダ', '', { archetype: 'folder' });
    await a.put('n1', '議事録 第 1 回', '本文あ', { parent: 'f1' });
    await a.put('n2', '企画メモ', '本文い');
    await a.request({ op: 'bulkUpsertRelations', cid: a.cid, relations: [{ id: 'r1', fromLid: 'n1', toLid: 'n2', kind: 'semantic' }] });
    await send(a, b);
    expect((await live(b)).map((x) => x.lid)).toEqual(['f1', 'n1', 'n2']);
    expect((await live(b)).find((x) => x.lid === 'n1')?.title).toBe('議事録 第 1 回');
    expect(await body(b, 'n1')).toBe('本文あ');
    const rels = await b.request({ op: 'listRelations', cid: b.cid });
    expect(rels.filter((r) => r.kind === 'semantic').map((r) => [r.from_lid, r.to_lid])).toEqual([['n1', 'n2']]);
    expect(rels.filter((r) => r.kind === 'structural').map((r) => [r.from_lid, r.to_lid])).toEqual([['f1', 'n1']]);
    expect(b.confirms.length).toBe(1);
    const sb = await snap(b);
    const peer = (await snap(a)).device!;
    expect(sb.pairs[peer]).toBe('c-A');
    expect(Object.keys(sb.bases[peer]!.baseline).sort()).toEqual(['f1', 'n1', 'n2', 'rel:n1|n2|semantic']);
    expect(lastReport(b)).toContain('新しく入ったノート: 3 件');
    // A は書き出しで連番が進んで端末 id がある。B の seq は A に追い付く
    expect((await snap(a)).seq).toBeGreaterThanOrEqual(1);
    expect(sb.seq).toBeGreaterThanOrEqual((await snap(a)).seq);
  });
  it('2 度目は確認しない(ワークスペースの対応が記録済み)・別のワークスペースの差分は断る', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '題名', '本文');
    await send(a, b);
    await a.put('n2', '二つ目', '本文2');
    await send(a, b);
    expect(b.confirms.length).toBe(1);
    expect((await live(b)).length).toBe(2);
    // 同じ端末 id のまま、別の cid の差分(同じ DB を別の cid で開いた想定)
    const a2 = await dev('A2');
    const idA = (await snap(a)).device!;
    a2.execSql("INSERT INTO settings(scope,k,v) VALUES ('__sync__','device',?) ON CONFLICT(scope,k) DO UPDATE SET v=excluded.v", [idA]);
    await a2.put('x1', '別', '別の本文');
    await exportSyncDiff(a2.deps());
    const r = await importSyncDiff(b.deps(), a2.lastDiff!.blob, 'y.pkc3-diff.zip');
    expect(r.ok).toBe(false);
    expect(b.failures.join('\n')).toContain('別のワークスペース');
    expect((await live(b)).map((x) => x.lid)).toEqual(['n1', 'n2']);
  });
});

describe('往復(2 台)', () => {
  it('相手が編集・削除・つながりを足す → こちらは取り込み・ゴミ箱へ移す・前の本文は履歴に残る', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '編集される', '初稿');
    await a.put('n2', '消される', '消える本文');
    await a.put('n3', '変えない', '同じ');
    await send(a, b);
    // B が編集・削除・つながり追加
    await b.put('n1', '編集される(改)', '二稿');
    await b.del('n2');
    await b.request({ op: 'bulkUpsertRelations', cid: b.cid, relations: [{ id: 'rb1', fromLid: 'n1', toLid: 'n3', kind: 'semantic' }] });
    await send(b, a);
    expect(await body(a, 'n1')).toBe('二稿');
    expect((await live(a)).find((x) => x.lid === 'n1')?.title).toBe('編集される(改)');
    expect((await live(a)).map((x) => x.lid)).toEqual(['n1', 'n3']);
    // 消えたノートはゴミ箱(戻せる)に在る
    const trash = await a.request({ op: 'listTrashHeads', cid: a.cid });
    expect(trash.map((t) => t.lid)).toEqual(['n2']);
    // 取り込みで消した物も削除の記録に残る(まだ同期していない第三の端末へ「消えた」と伝えられる)
    expect((await snap(a)).tombstones.map((t) => t.key)).toEqual(['n2']);
    // 前の本文が履歴に残る
    const metas = await a.request({ op: 'listRevisionMetas', cid: a.cid, entryLid: 'n1' });
    expect(metas.length).toBeGreaterThan(0);
    expect((await a.request({ op: 'listRelations', cid: a.cid })).some((r) => r.from_lid === 'n1' && r.to_lid === 'n3')).toBe(true);
    const rep = lastReport(a);
    expect(rep).toContain('相手の版に置き換えたノート: 1 件');
    expect(rep).toContain('ゴミ箱へ移したノート: 1 件');
    expect(rep).toContain('足したつながり: 1 本');
    // 取り込み直すと何も起きない(冪等)
    const before = JSON.stringify(await live(a));
    await importSyncDiff(a.deps(), b.lastDiff!.blob, 'again.pkc3-diff.zip');
    expect(JSON.stringify(await live(a))).toBe(before);
  });

  it('こちらだけの変更は何も書かない(次の書き出しで相手へ送る)', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '題名', '初稿');
    await send(a, b);
    await b.put('n1', '題名', 'B の編集');
    await a.put('n9', '新しいノート', 'A の新規');
    await send(a, b); // A が B へ(A は B の記録が無いので全件)
    expect(await body(b, 'n1')).toBe('B の編集'); // B は変えた側 → 残る
    expect((await live(b)).map((x) => x.lid)).toEqual(['n1', 'n9']);
    expect(lastReport(b)).toContain('こちらの版を残したノート: 1 件');
  });

  it('移動(A)と編集(B)は欄ごとに合わさる(競合にしない)', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('f1', 'フォルダ', '', { archetype: 'folder' });
    await a.put('n1', '題名', '初稿');
    await send(a, b);
    await send(b, a); // B の記録を A に持たせる(往復で記録を揃える)
    await a.request({ op: 'setEntryParent', cid: a.cid, lid: 'n1', parentLid: 'f1', relationId: 'mv1' });
    await b.put('n1', '題名', 'B の編集');
    await send(a, b);
    expect(await body(b, 'n1')).toBe('B の編集');
    const rel = (await b.request({ op: 'listRelations', cid: b.cid })).filter((r) => r.kind === 'structural');
    expect(rel.map((r) => [r.from_lid, r.to_lid])).toEqual([['f1', 'n1']]);
    expect(lastReport(b)).toContain('移動と編集を合わせたノート: 1 件');
    expect((await live(b)).length).toBe(2);
  });

  it('競合(両方が同じ欄を変えた): こちらを残し、相手の版を題名に印をつけた別ノートで足す・一覧とメッセージに出る・連鎖しない', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '共有ノート', '初稿');
    await send(a, b);
    await send(b, a);
    await a.put('n1', '共有ノート', 'A の版');
    await b.put('n1', '共有ノート', 'B の版');
    await send(a, b);
    const after = await live(b);
    expect(after.length).toBe(2);
    expect(await body(b, 'n1')).toBe('B の版');
    const copy = after.find((x) => x.lid !== 'n1')!;
    expect(copy.title).toBe('共有ノート(同期の競合 2026-11-21)');
    expect(await body(b, copy.lid)).toBe('A の版');
    expect(lastReport(b)).toContain('競合: 1 件');
    expect(lastReport(b)).toContain('「共有ノート」');
    expect(b.messages.length).toBe(1);
    expect(b.messages[0]!.text).toContain('同期の競合');
    // B → A: A は自分の版が B の見た版のままなので、B の版を採る(コピーが連鎖しない)。コピーは A にも届く
    await send(b, a);
    expect(await body(a, 'n1')).toBe('B の版');
    expect((await live(a)).length).toBe(2);
    expect(a.messages.length).toBe(0);
  });

  it('こちらで消し、相手が編集した: 相手の版でゴミ箱から戻す', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '復活する', '初稿');
    await a.put('n2', 'そのまま', '本文');
    await send(a, b);
    await send(b, a);
    await b.del('n1');
    await a.put('n1', '復活する', 'A の編集');
    await send(a, b);
    expect((await live(b)).map((x) => x.lid)).toEqual(['n1', 'n2']);
    expect(await body(b, 'n1')).toBe('A の編集');
    expect(lastReport(b)).toContain('ゴミ箱から戻したノート: 1 件');
    expect((await b.request({ op: 'listTrashHeads', cid: b.cid })).length).toBe(0);
  });

  it('こちらで編集し、相手が消した: こちらを残す(消さない)', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '残す', '初稿');
    await send(a, b);
    await send(b, a);
    await a.del('n1');
    await b.put('n1', '残す', 'B の編集');
    await send(a, b);
    expect((await live(b)).map((x) => x.lid)).toEqual(['n1']);
    expect(await body(b, 'n1')).toBe('B の編集');
    expect(lastReport(b)).toContain('相手で消したがこちらで編集');
  });

  it('初回の同期: 記録が無く両方にあって内容が違う → 競合として「初回の同期」と分けて出す', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '同じ lid', 'A の本文');
    await b.put('n1', '同じ lid', 'B の本文');
    await b.put('n2', '同じ内容', 'そろっている');
    await a.put('n2', '同じ内容', 'そろっている');
    await send(a, b);
    const titles = (await live(b)).map((x) => x.title).sort();
    expect(titles).toContain('同じ lid(初回の同期の競合 2026-11-21)');
    expect(await body(b, 'n1')).toBe('B の本文');
    expect(lastReport(b)).toContain('初回の同期で内容が違った物: 1 件');
    // 同じ内容(n2)は競合にしない
    expect((await live(b)).length).toBe(3);
  });

  it('親フォルダが相手の差分にも無い子は、いちばん上へ置く(消さない)', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('f1', '親', '', { archetype: 'folder' });
    await a.put('n1', '子', '本文', { parent: 'f1' });
    await send(a, b);
    await send(b, a);
    // B が親を消す → A へ。A の子はルートへ出る(子の親欄が空になる)が、消えない
    await b.del('f1');
    await send(b, a);
    expect((await live(a)).map((x) => x.lid)).toEqual(['n1']);
    expect((await a.request({ op: 'listTrashHeads', cid: a.cid })).map((t) => t.lid)).toEqual(['f1']);
  });
});

describe('添付・足りない物', () => {
  it('本文が参照する添付の実体は一緒に運ぶ(相手に無い物だけ)', async () => {
    const a = await dev('A');
    const b = await dev('B');
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    a.blobs.set('ast-aaa', blob);
    await a.request({ op: 'putAssetMeta', cid: a.cid, meta: { key: 'ast-aaa', mime: 'image/png', size: 4, hash: sha256Of([1, 2, 3, 4]) } });
    await a.put('n1', '画像つき', '![絵](asset:ast-aaa)');
    await send(a, b);
    expect(b.blobs.has('ast-aaa')).toBe(true);
    expect(b.blobs.get('ast-aaa')!.size).toBe(4);
    expect(lastReport(b)).not.toContain('足りない添付');
  });
  it('目録の hash と内容が合わない添付は置かず、一覧で言う(参照は残す)・反映より先に書かない', async () => {
    const a = await dev('A');
    const b = await dev('B');
    a.blobs.set('ast-bad', new Blob([new Uint8Array([9, 9, 9])], { type: 'image/png' }));
    await a.request({ op: 'putAssetMeta', cid: a.cid, meta: { key: 'ast-bad', mime: 'image/png', size: 3, hash: sha256Of([1, 2, 3]) } });
    await a.put('n1', '偽の添付', '![絵](asset:ast-bad)');
    await send(a, b);
    expect(b.blobs.has('ast-bad')).toBe(false);
    expect(await body(b, 'n1')).toBe('![絵](asset:ast-bad)');
    expect(lastReport(b)).toContain('取り込まなかった添付: 1 件');
    expect((await b.request({ op: 'listAssetMetas', cid: b.cid })).map((m) => m.key)).not.toContain('ast-bad');
  });
  /** 🔴 #2000 段 4a-1 のついで(user 指摘): hash を持たない大きな添付は、大きさだけでも合わせる(途中で切れた物を置かない)。 */
  it('hash の無い添付は、目録の大きさと合わなければ置かず一覧で言う / 合えば置く', async () => {
    const a = await dev('A');
    const b = await dev('B');
    a.blobs.set('ast-cut', new Blob([new Uint8Array([1, 2])], { type: 'video/mp4' }));
    await a.request({ op: 'putAssetMeta', cid: a.cid, meta: { key: 'ast-cut', mime: 'video/mp4', size: 5, hash: null } });
    a.blobs.set('ast-ok', new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }));
    await a.request({ op: 'putAssetMeta', cid: a.cid, meta: { key: 'ast-ok', mime: 'video/mp4', size: 3, hash: null } });
    await a.put('n1', '大きな添付', '![動画](asset:ast-cut)\n\n![動画](asset:ast-ok)');
    await send(a, b);
    expect(b.blobs.has('ast-cut'), '大きさの合わない添付を置いた').toBe(false);
    expect(b.blobs.has('ast-ok'), '対照群: 大きさの合う添付を置いていない').toBe(true);
    expect(lastReport(b)).toContain('取り込まなかった添付: 1 件');
  });
  it('実体が差分に無い添付は参照を残し、足りない添付として一覧で言う', async () => {
    const a = await dev('A');
    const b = await dev('B');
    // A は参照だけを持つ(meta 無し = 運べない)
    await a.put('n1', '壊れた参照', '![絵](asset:ast-zzz)');
    await send(a, b);
    expect(await body(b, 'n1')).toBe('![絵](asset:ast-zzz)');
    expect(lastReport(b)).toContain('足りない添付: 1 件');
    expect(lastReport(b)).toContain('「壊れた参照」の添付');
  });
});

/** 端末 id・cid・連番を指定した差分ファイル(中身は指定のノートだけ)。 */
async function forgeSame(device: string, cid: string, seq: number, notes: Array<{ lid: string; title: string; body: string }>): Promise<Blob> {
  const fps = notes.map((n) => {
    const f = entryFp({ title: n.title, archetype: 'text', parentLid: null, body: n.body });
    return { key: n.lid, c: f.content, p: f.place as string };
  });
  async function* gen(): AsyncGenerator<DiffNote> {
    for (const n of notes) yield { lid: n.lid, title: n.title, archetype: 'text', parentLid: null, body: n.body };
  }
  const out = await writeDiffZip({
    manifest: { exported_at: '2026-11-21T09:30:00.000Z', device, seq, cid, title: '細工', complete: true },
    notes: gen(),
    relations: [],
    tombstones: [],
    fingerprints: fps,
    peerBase: [],
    labels: [],
    pins: [],
    assets: () => [],
    getAssetBlob: async () => null,
  });
  return out.blob;
}

describe('端末 id の重複・自分の差分', () => {
  it('自分が書き出した差分ファイルを取り込んでも何も起きない(重複と見なさない)', async () => {
    const a = await dev('A');
    await a.put('n1', '題名', '本文');
    await exportSyncDiff(a.deps());
    const idBefore = (await snap(a)).device;
    const r = await importSyncDiff(a.deps(), a.lastDiff!.blob, 'self.pkc3-diff.zip');
    expect(r.ok).toBe(true);
    expect((await snap(a)).device).toBe(idBefore);
    expect(a.reports.length).toBe(0);
  });
  /** A の端末 id を持つ複製(同じ cid の別の DB)を作る。 */
  async function cloneOf(a: SyncDevice): Promise<SyncDevice> {
    const clone = await dev('A2', true, a.cid);
    const idA = (await snap(a)).device!;
    clone.execSql("INSERT INTO settings(scope,k,v) VALUES ('__sync__','device',?) ON CONFLICT(scope,k) DO UPDATE SET v=excluded.v", [idA]);
    return clone;
  }
  it('DB の複製で端末 id が重なったら(同じ cid・記録に無い連番)専用の確認を取り、承知したら自分の id を作り直し・同期の記録を捨て・取り込みは続ける', async () => {
    const a = await dev('A');
    await a.put('n1', '題名', '本文');
    await exportSyncDiff(a.deps());
    const idA = (await snap(a)).device!;
    const clone = await cloneOf(a);
    await clone.put('x1', 'クローン側のノート', 'クローンの本文');
    await clone.put('n1', '題名', '本文');
    await importSyncDiff(clone.deps({ randomBytes: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }), a.lastDiff!.blob, 'a.pkc3-diff.zip');
    expect(clone.failures).toEqual([]);
    // 専用の確認: この端末の物に見えること・ID を作り直すこと・記録が最初からになることを言う
    expect(clone.confirms.length).toBeGreaterThanOrEqual(1);
    expect(clone.confirms[0]).toContain('この端末が書き出した物に見えます');
    expect(clone.confirms[0]).toContain('作り直し');
    const s = await snap(clone);
    expect(s.device).toBe('0102030405060708');
    expect(s.device).not.toBe(idA);
    expect(Object.keys(s.bases)).toEqual([idA]); // 作り直した後は、相手 A の記録だけから始まる
    expect(lastReport(clone)).toContain('端末の ID を作り直しました');
  });
  it('確認で「やめる」を選ぶと、端末 id も同期の記録も 1 つも変わらない', async () => {
    const a = await dev('A');
    const peer = await dev('P');
    await peer.put('p1', '相手のノート', '相手の本文');
    await send(peer, a); // A は相手 P の記録を持つ
    await a.put('n1', '題名', '本文');
    await exportSyncDiff(a.deps());
    const clone = await cloneOf(a);
    await send(peer, clone);
    const before = await snap(clone);
    expect(Object.keys(before.bases).length).toBeGreaterThan(0);
    const diff = a.lastDiff!.blob;
    // ⚠ 対応の確認(別の確認)には「はい」と答え、ID の作り直しの確認にだけ「やめる」と答える(片方に救われて空振りしない)
    const r = await importSyncDiff(clone.deps({ confirmAction: async (m) => !m.includes('作り直し') }), diff, 'a.pkc3-diff.zip');
    expect(r.ok).toBe(true);
    const after = await snap(clone);
    expect(after.device).toBe(before.device);
    expect(after.bases).toEqual(before.bases);
    expect(after.pairs).toEqual(before.pairs);
  });
  it('連番は記録にあっても内容(指紋の要約)が違えば自分の差分とは見なさない(複製の確認を取る)', async () => {
    const a = await dev('A');
    await a.put('n1', '題名', '本文');
    await exportSyncDiff(a.deps());
    const s0 = await snap(a);
    const seq = Object.keys(s0.outs).map(Number)[0]!;
    // 同じ端末 id・同じ cid・同じ連番だが、中身(指紋)が違う差分
    const blob = await forgeSame(s0.device!, a.cid, seq, [{ lid: 'zz', title: '別の中身', body: '別' }]);
    const asked: string[] = [];
    const r = await importSyncDiff(a.deps({ confirmAction: async (m) => (asked.push(m), false) }), blob, 'x.pkc3-diff.zip');
    expect(r.ok).toBe(true);
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain('この端末が書き出した物に見えます');
    expect((await snap(a)).device).toBe(s0.device); // やめたので変わらない
    // 対照: 本当に自分の差分(指紋が一致)なら確認も出ない
    const asked2: string[] = [];
    await importSyncDiff(a.deps({ confirmAction: async (m) => (asked2.push(m), false) }), a.lastDiff!.blob, 'mine.pkc3-diff.zip');
    expect(asked2).toEqual([]);
  });
  it('自分の差分を、別のワークスペースへ取り込もうとしたら断る(記録を一切変えない・同期の記録を消すボタンを名指しする)', async () => {
    const a = await dev('A');
    const peer = await dev('P');
    await peer.put('p1', '相手のノート', '相手の本文');
    await send(peer, a);
    await a.put('n1', '題名', '本文');
    await exportSyncDiff(a.deps());
    const idA = (await snap(a)).device!;
    // 同じ端末の別のワークスペース(cid が違う)
    const other = await dev('A3', true, 'c-other');
    other.execSql("INSERT INTO settings(scope,k,v) VALUES ('__sync__','device',?) ON CONFLICT(scope,k) DO UPDATE SET v=excluded.v", [idA]);
    await send(peer, other);
    const before = await snap(other);
    const r = await importSyncDiff(other.deps({ confirmAction: async () => true }), a.lastDiff!.blob, 'a.pkc3-diff.zip');
    expect(r.ok).toBe(false);
    expect(other.failures.join('\n')).toContain('別のワークスペース');
    expect(other.failures.join('\n')).toContain('同期の記録を消す');
    const after = await snap(other);
    expect(after.device).toBe(idA);
    expect(after.bases).toEqual(before.bases);
    expect(after.pairs).toEqual(before.pairs);
    expect((await live(other)).map((x) => x.lid)).toEqual(['p1']);
  });
});

describe('1 回の tx・取り消し', () => {
  it('反映の途中で落ちたら、ノートも同期の記録も 1 件も書かれない', async () => {
    const a = await dev('A');
    await a.put('n1', '既にある', '元の本文');
    const before = await snap(a);
    await expect(
      a.request({
        op: 'syncApply',
        cid: a.cid,
        input: {
          peer: '0123456789abcdef',
          peerCid: 'c-X',
          peerSeq: 3,
          upserts: [
            { lid: 'n1', content: { title: '書き換え', archetype: 'text', body: '壊れる前の本文' } },
            { lid: 'n2', content: { title: '新規', archetype: 'text', body: '新規本文' } },
          ],
          trash: [],
          relationAdds: [{ from: 'n1', to: 'n2', kind: 'semantic' }],
          relationRemoves: [],
          // 同期の記録を書く段(すべてのノートを書いた後)で落ちる ── それまでの書き込みが残らないことを見る
          baseline: { n1: null as unknown as { content: string } },
          nowIso: '2026-11-21T00:00:00.000Z',
        },
      }),
    ).rejects.toBeTruthy();
    expect(await body(a, 'n1')).toBe('元の本文');
    expect((await live(a)).map((x) => x.lid)).toEqual(['n1']);
    const after = await snap(a);
    expect(after.bases).toEqual({});
    expect(after.pairs).toEqual({});
    expect(after.seq).toBe(before.seq);
  });

  it('取り消し: 新しく入った物はゴミ箱へ・置き換えた物は前の姿へ・記録も元へ。取り込み後に編集した物は触らない', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '置き換わる', '初稿');
    await a.put('n2', '後で編集する', '初稿2');
    await send(a, b);
    await send(b, a);
    await b.put('n1', '置き換わる', 'B の二稿');
    await b.put('n2', '後で編集する', 'B の二稿2');
    await b.put('n3', '新しく入る', '新規');
    await send(b, a);
    expect(await body(a, 'n1')).toBe('B の二稿');
    expect((await live(a)).map((x) => x.lid)).toEqual(['n1', 'n2', 'n3']);
    const baseBefore = (await snap(a)).bases;
    expect(a.undo).not.toBeNull();
    // 取り込みの後に n2 を A で編集する(取り消しで触らない)
    await a.put('n2', '後で編集する', 'A のあとの編集');
    // 取り込みで新しく入った n3 も、取り込みのあとに編集したら取り消しで触らない(ゴミ箱へ移さない)
    await a.put('n3', '新しく入る', 'A が育てた本文');
    const r = await a.undo!.run();
    expect(r.skipped).toBe(2);
    expect(await body(a, 'n3')).toBe('A が育てた本文');
    expect(await body(a, 'n1')).toBe('初稿');
    expect(await body(a, 'n2')).toBe('A のあとの編集');
    expect((await live(a)).map((x) => x.lid)).toEqual(['n1', 'n2', 'n3']);
    expect((await a.request({ op: 'listTrashHeads', cid: a.cid })).length).toBe(0);
    // 記録は取り込み前(B からの 2 度目の取り込みの前 = 最初の往復後)の姿へ
    const baseAfter = (await snap(a)).bases;
    expect(JSON.stringify(baseAfter)).not.toBe(JSON.stringify(baseBefore));
    // 取り消しで入れたゴミ箱への移動は、相手へ「消した」と伝わらない(削除の記録を残さない)
    expect((await snap(a)).tombstones.map((t) => t.key)).not.toContain('n3');
  });

  it('取り消し(新しく入った物を、編集されていなければゴミ箱へ): 削除の記録は残らない', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await b.put('n3', '新しく入る', '新規');
    await send(b, a);
    expect((await live(a)).map((x) => x.lid)).toEqual(['n3']);
    const r = await a.undo!.run();
    expect(r).toEqual({ restored: 1, skipped: 0 });
    expect((await live(a)).length).toBe(0);
    expect((await a.request({ op: 'listTrashHeads', cid: a.cid })).map((t) => t.lid)).toEqual(['n3']);
    expect((await snap(a)).tombstones).toEqual([]);
    expect((await snap(a)).bases).toEqual({});
    expect((await snap(a)).pairs).toEqual({});
  });
});
