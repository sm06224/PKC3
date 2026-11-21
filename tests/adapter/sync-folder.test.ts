/** @vitest-environment node */
/**
 * 🔴 **端末間の同期(#2000 段 3)── フォルダ同期(全データ)を、実物の worker 2 台とメモリのフォルダで通す**。
 *
 * 見るもの: 2 台が同じフォルダを指して収束する / 削除はゴミ箱へ / 競合は両方残す / 色ラベル・ピン留め・添付 /
 * 書き込み途中・壊れたファイルを取り込まない / 同じファイルを取り込み直さない・変わらなければ書き換えない /
 * handle の保存と許可の取り直し / 設定が切のときは何もしない / 選べないブラウザ。
 * 空振り防止: 「入れた物が別の端末の DB に出る」を中身で確かめ、対照(許可なし・設定切・読めないファイル)で何も起きないことも見る。
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SyncFolder, type SyncFolderDeps } from '../../src/adapter/ui/actions/sync-folder';
import { MemorySyncFolderStore } from '../../src/adapter/platform/sync-folder-store';
import { SYNC_FOLDER_ASSETS_DIR, SYNC_FOLDER_DIR, folderFileNameOf } from '../../src/features/sync/sync-folder';
import { MemDir, type MemClock } from '../helpers/mem-dir';
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

const sha256Of = (bytes: number[]): string => createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
const clock: MemClock = { t: 1_700_000_000_000 };
const tick = (ms = 10_000): void => void (clock.t += ms);

interface Side {
  d: SyncDevice;
  f: SyncFolder;
  store: MemorySyncFolderStore;
  say: string[];
  fail: string[];
  changes: number;
}
function side(d: SyncDevice, root: MemDir, over: Partial<SyncFolderDeps> = {}, store = new MemorySyncFolderStore()): Side {
  const s: Side = { d, f: null as unknown as SyncFolder, store, say: [], fail: [], changes: 0 };
  s.f = new SyncFolder({
    picker: async () => root,
    store,
    cid: d.cid,
    enabled: () => d.enabled,
    syncDeps: async () => d.deps(),
    ready: () => true,
    lock: null,
    say: (t) => void s.say.push(t),
    fail: (t) => void s.fail.push(t),
    onChange: () => void s.changes++,
    nowMs: () => clock.t,
    ...over,
  });
  return s;
}
/** 1 回同期(押した回)。時計を進めてから回す(書き込み直後のファイルは「途中」として飛ばすため)。 */
async function cycle(s: Side, manual = true): Promise<void> {
  tick();
  await s.f.syncNow(manual);
}
const metas = async (d: SyncDevice): Promise<Array<{ lid: string; title: string }>> =>
  (await d.request({ op: 'listEntryMetas', cid: d.cid })).map((m) => ({ lid: m.lid, title: m.title })).sort((a, b) => (a.lid < b.lid ? -1 : 1));
const bodyOf = async (d: SyncDevice, lid: string): Promise<string | null> => (await d.request({ op: 'getBodies', cid: d.cid, lids: [lid] }))[0]?.body ?? null;
const snap = (d: SyncDevice) => d.request({ op: 'syncSnapshot', cid: d.cid });
const syncDir = async (root: MemDir): Promise<MemDir> => (await root.getDirectoryHandle(SYNC_FOLDER_DIR)) as MemDir;

/** フォルダを選ぶ(時計を進めてから。先に書いた相手のファイルを「書き込み途中」と見ないため)。 */
async function pick(s: Side): Promise<void> {
  tick();
  await s.f.pick();
}

async function pair(): Promise<{ a: Side; b: Side; root: MemDir }> {
  const root = new MemDir('クラウド', clock);
  const a = side(await dev('A'), root);
  const b = side(await dev('B'), root);
  return { a, b, root };
}

describe('フォルダ同期(全データ): 2 台が収束する', () => {
  it('A が書いた物が B に出る(ノート・親フォルダ・色ラベル・ピン留め・つながり)/ 置き場は pkc3-sync/ の下で、端末 ID 名のファイル 1 つずつ', async () => {
    const { a, b, root } = await pair();
    await a.d.put('f1', 'フォルダ', '', { archetype: 'folder' });
    await a.d.put('n1', '日本語の題名', '本文 1', { parent: 'f1' });
    await a.d.put('n2', '二つ目', '本文 2');
    await a.d.request({ op: 'putNoteLabel', cid: a.d.cid, lid: 'n1', color: 4 });
    await a.d.request({ op: 'putNotePin', cid: a.d.cid, lid: 'n2', on: true });
    await pick(a);
    expect(a.fail).toEqual([]);
    const dirA = await syncDir(root);
    const idA = (await snap(a.d)).device!;
    expect([...dirA.files.keys()]).toEqual([folderFileNameOf(idA)]);

    await pick(b); // 初回の対応づけの確認は押した回で通る
    expect(b.fail).toEqual([]);
    expect(await metas(b.d)).toEqual([
      { lid: 'f1', title: 'フォルダ' },
      { lid: 'n1', title: '日本語の題名' },
      { lid: 'n2', title: '二つ目' },
    ]);
    expect(await bodyOf(b.d, 'n1')).toBe('本文 1');
    expect(await b.d.request({ op: 'listNoteLabels', cid: b.d.cid })).toEqual([{ lid: 'n1', color: 4 }]);
    expect(await b.d.request({ op: 'listNotePins', cid: b.d.cid })).toEqual(['n2']);
    // B も自分のファイルを置いた(端末ごとに 1 つ)
    expect(dirA.files.size).toBe(2);
  });

  it('何周か回して収束する: 編集・追加・色の変更が行き来し、最後は両方の DB が同じ(変わらない回はファイルを書き換えない)', async () => {
    const { a, b, root } = await pair();
    await a.d.put('n1', '一つ目', '初稿');
    await pick(a);
    await pick(b);
    // B が編集 + 新規 + 色
    await b.d.put('n1', '一つ目', '初稿\nB の追記');
    await b.d.put('n2', 'B のノート', 'B 本文');
    await b.d.request({ op: 'putNoteLabel', cid: b.d.cid, lid: 'n2', color: 6 });
    await cycle(b);
    await cycle(a);
    expect(await bodyOf(a.d, 'n1')).toBe('初稿\nB の追記');
    expect((await metas(a.d)).map((m) => m.lid)).toEqual(['n1', 'n2']);
    expect(await a.d.request({ op: 'listNoteLabels', cid: a.d.cid })).toEqual([{ lid: 'n2', color: 6 }]);
    // A が編集(別のノート)+ ピン留め
    await a.d.put('n3', 'A のノート', 'A 本文');
    await a.d.request({ op: 'putNotePin', cid: a.d.cid, lid: 'n3', on: true });
    await cycle(a);
    await cycle(b);
    expect((await metas(b.d)).map((m) => m.lid)).toEqual(['n1', 'n2', 'n3']);
    expect(await b.d.request({ op: 'listNotePins', cid: b.d.cid })).toEqual(['n3']);
    // 収束したあとの回は何も書かない・何も取り込まない
    const dirA = await syncDir(root);
    await cycle(a);
    await cycle(b);
    const before = new Map(root.writes);
    const reportsA = a.d.reports.length;
    const reportsB = b.d.reports.length;
    await cycle(a);
    await cycle(b);
    await cycle(a);
    expect(new Map(root.writes)).toEqual(before); // 書き換えなし(クラウドの無駄な同期を起こさない)
    expect(a.d.reports.length).toBe(reportsA); // 定期の回は結果の面を出さない
    expect(b.d.reports.length).toBe(reportsB);
    expect(dirA.files.size).toBe(2);
    expect(await metas(a.d)).toEqual(await metas(b.d));
    const ls = async (d: SyncDevice): Promise<string> => JSON.stringify([await d.request({ op: 'listNoteLabels', cid: d.cid }), await d.request({ op: 'listNotePins', cid: d.cid })]);
    expect(await ls(a.d)).toBe(await ls(b.d));
  });

  it('消した物は相手でゴミ箱へ(戻せる)・消した記録は繰り返し取り込んでも復活しない', async () => {
    const { a, b } = await pair();
    await a.d.put('n1', '残すノート', '残す');
    await a.d.put('n2', '消すノート', '消す');
    await pick(a);
    await pick(b);
    await a.d.del('n2');
    await cycle(a);
    await cycle(b);
    expect((await metas(b.d)).map((m) => m.lid)).toEqual(['n1']);
    const trash = await b.d.request({ op: 'listTrashHeads', cid: b.d.cid });
    expect(trash.map((t) => t.lid)).toContain('n2'); // ゴミ箱に居る(戻せる)
    await cycle(a);
    await cycle(b);
    await cycle(a);
    expect((await metas(a.d)).map((m) => m.lid)).toEqual(['n1']); // 復活していない
    expect((await metas(b.d)).map((m) => m.lid)).toEqual(['n1']);
  });

  it('両方で編集した物は競合: 両方残す(題名に「同期の競合」の別のノート)・両側で同じ数', async () => {
    const { a, b } = await pair();
    await a.d.put('n1', '共有ノート', '初稿');
    await pick(a);
    await pick(b);
    await a.d.put('n1', '共有ノート', 'A の版');
    await b.d.put('n1', '共有ノート', 'B の版');
    await cycle(a); // A のファイルを書く
    await cycle(b); // B: 競合 → こちらを残しコピーを足す
    const mb = await metas(b.d);
    expect(mb.filter((m) => m.title.includes('同期の競合'))).toHaveLength(1);
    expect(await bodyOf(b.d, 'n1')).toBe('B の版');
    const copy = mb.find((m) => m.title.includes('同期の競合'))!;
    expect(await bodyOf(b.d, copy.lid)).toBe('A の版');
    expect(b.d.conflictButtons).toBeGreaterThan(0); // 「競合のノートを一覧する」が出る
    await cycle(a);
    const ma = await metas(a.d);
    expect(ma.filter((m) => m.title.includes('同期の競合')).length).toBeGreaterThanOrEqual(1);
    // A も取り込む: 両方の端末が同じ n1 に収束し(競合を作った側の版)、もう一方の版は競合のノートとして両方に残る
    expect(await bodyOf(a.d, 'n1')).toBe(await bodyOf(b.d, 'n1'));
    // 往復を続けても競合のコピーは増えない(両側で同じ数のまま止まる)。どちらの版も両方の端末に残っている
    const count = async (d: SyncDevice): Promise<number> => (await metas(d)).length;
    const na = await count(a.d);
    for (let i = 0; i < 3; i++) {
      await cycle(b);
      await cycle(a);
    }
    expect(await count(a.d)).toBe(na);
    expect(await count(b.d)).toBe(na);
    for (const d of [a.d, b.d]) {
      const bodies = await Promise.all((await metas(d)).map((m) => bodyOf(d, m.lid)));
      expect(bodies).toContain('A の版');
      expect(bodies).toContain('B の版');
    }
  });

  it('添付の実体は assets/<key> に 1 度だけ置かれ、別の端末が引く(hash の合わない実体は置かない)', async () => {
    const { a, b, root } = await pair();
    a.d.blobs.set('ast-ok', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }));
    await a.d.request({ op: 'putAssetMeta', cid: a.d.cid, meta: { key: 'ast-ok', mime: 'image/png', size: 4, hash: sha256Of([1, 2, 3, 4]) } });
    await a.d.put('n1', '画像つき', '![絵](asset:ast-ok)');
    await pick(a);
    const assets = (await (await syncDir(root)).getDirectoryHandle(SYNC_FOLDER_ASSETS_DIR)) as MemDir;
    expect([...assets.files.keys()]).toEqual(['ast-ok']);
    const diffZipSize = [...(await syncDir(root)).files.values()][0]!.blob.size;
    expect(diffZipSize).toBeLessThan(4000); // 差分ファイルに実体を積まない(目録だけ)
    await pick(b);
    expect(b.d.blobs.get('ast-ok')?.size).toBe(4);
    // 偽の実体: 目録の hash と合わない → 置かない
    a.d.blobs.set('ast-bad', new Blob([new Uint8Array([9, 9, 9])], { type: 'image/png' }));
    await a.d.request({ op: 'putAssetMeta', cid: a.d.cid, meta: { key: 'ast-bad', mime: 'image/png', size: 3, hash: sha256Of([1, 2, 3]) } });
    await a.d.put('n2', '偽', '![絵](asset:ast-bad)');
    await cycle(a);
    await cycle(b);
    expect(b.d.blobs.has('ast-bad')).toBe(false);
    expect(await bodyOf(b.d, 'n2')).toBe('![絵](asset:ast-bad)'); // 参照は残る
  });
});

describe('フォルダ同期: 読めないファイル・途中のファイル・同じファイルの取り込み直し', () => {
  it('壊れた(途中までの)ファイルは取り込まず・何も書かず、次の回で完全なファイルになれば取り込む', async () => {
    const { a, b, root } = await pair();
    await a.d.put('n1', '一つ目', '本文');
    await pick(b); // B が先にフォルダを選んでおく(空)
    await pick(a);
    const dir = await syncDir(root);
    const idA = (await snap(a.d)).device!;
    const full = dir.files.get(folderFileNameOf(idA))!.blob;
    // A のファイルを途中まで(半分)にしたものを、B が見る
    dir.put(folderFileNameOf(idA), full.slice(0, Math.floor(full.size / 2)), clock.t - 60_000);
    await cycle(b);
    expect(await metas(b.d)).toEqual([]); // 何も入っていない
    expect(b.fail.join('\n')).toContain('読めませんでした');
    expect(b.fail.join('\n')).toContain(folderFileNameOf(idA));
    // 同じ壊れた状態で回しても、同じ知らせを繰り返さない(定期の回)
    const n = b.fail.length;
    await cycle(b, false);
    expect(b.fail.length).toBe(n);
    // 中身が揃う(アップロード完了)→ 取り込む
    dir.put(folderFileNameOf(idA), full, clock.t - 30_000);
    await cycle(b);
    expect((await metas(b.d)).map((m) => m.lid)).toEqual(['n1']);
  });

  it('壊れていて zip でないファイル・別の形式の zip・名前が違うファイルも、何も書かずに済ませる', async () => {
    const { a, b, root } = await pair();
    await a.d.put('n1', '一つ目', '本文');
    await pick(b); // B が先にフォルダを作る
    const dir = await syncDir(root);
    dir.put('0123456789abcdef.pkc3-diff.zip', new Blob(['zip ではない']), clock.t - 60_000);
    dir.put('クラウドの競合コピー (1).pkc3-diff.zip', new Blob(['x']), clock.t - 60_000); // 名前が対象外 = 読まない
    await cycle(b);
    expect(await metas(b.d)).toEqual([]);
    expect(b.fail.join('\n')).toContain('0123456789abcdef.pkc3-diff.zip');
    expect(b.fail.join('\n')).not.toContain('競合コピー');
    // 対照: 壊れたファイルがあっても、A のまともなファイルは取り込める
    await pick(a);
    await cycle(b);
    expect((await metas(b.d)).map((m) => m.lid)).toEqual(['n1']);
  });

  it('更新日時が直近のファイルは書き込み途中かもしれないので次の回へ(時計が進めば取り込む)', async () => {
    const { a, b, root } = await pair();
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    await b.f.pick(); // 時計を進めずに回る = A のファイルはまだ新しい
    expect(await metas(b.d)).toEqual([]);
    expect(b.say.join('\n')).toContain('書き込み途中のファイル 1 件');
    expect((await syncDir(root)).files.size).toBeGreaterThanOrEqual(1);
    await cycle(b);
    expect((await metas(b.d)).map((m) => m.lid)).toEqual(['n1']);
  });

  it('同じファイルを取り込み直さない: 連番の記録が進み、2 回目以降は結果の面も出ない', async () => {
    const { a, b } = await pair();
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    await pick(b);
    const idA = (await snap(a.d)).device!;
    const seq1 = (await snap(b.d)).peerSeqs[idA];
    expect(seq1).toBeGreaterThanOrEqual(1);
    const reports = b.d.reports.length;
    await cycle(b);
    await cycle(b, false);
    expect((await snap(b.d)).peerSeqs[idA]).toBe(seq1);
    expect(b.d.reports.length).toBe(reports);
    // A が変わると新しい連番のファイルが来る
    await a.d.put('n1', '一つ目', '本文 2');
    await cycle(a);
    await cycle(b);
    expect((await snap(b.d)).peerSeqs[idA]).toBeGreaterThan(seq1!);
    expect(await bodyOf(b.d, 'n1')).toBe('本文 2');
  });

  it('クラウドが更新日時だけ変えた(内容と連番は同じ)ファイルは、概要を見て取り込まない(syncApply が走らない)', async () => {
    const { a, b, root } = await pair();
    let applies = 0;
    const counted = side(b.d, root, {
      syncDeps: async () => ({
        ...b.d.deps(),
        request: ((req: { op: string }) => {
          if (req.op === 'syncApply') applies++;
          return b.d.request(req as never);
        }) as never,
      }),
    });
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    await pick(counted);
    expect(applies).toBe(1);
    const dir = await syncDir(root);
    const idA = (await snap(a.d)).device!;
    const name = folderFileNameOf(idA);
    const rec = dir.files.get(name)!;
    dir.put(name, rec.blob, clock.t - 5_000); // 同じ内容・新しい更新日時(アップロードし直された)
    await cycle(counted);
    expect(applies).toBe(1); // 連番が取り込み済みなので、もう一度反映しない
    expect(await metas(b.d)).toEqual([{ lid: 'n1', title: '一つ目' }]);
  });

  it('別のワークスペースの端末のファイルがあれば、この端末のファイルは上書きしない', async () => {
    const { a, root } = await pair();
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    const idA = (await snap(a.d)).device!;
    const before = (await syncDir(root)).files.get(folderFileNameOf(idA))!.blob;
    // A の別のワークスペースを同じフォルダへ選ぶ(同じ端末 ID のファイルが別の cid の物になる)
    await a.d.request({ op: 'openContainer', cid: 'c-other', title: '別のワークスペース' });
    const otherFail: string[] = [];
    // cid を取り違えた別の SyncFolder は、自分の cid の deps を使う(deps の cid だけ差し替える)
    const f2 = new SyncFolder({
      picker: async () => root,
      store: new MemorySyncFolderStore(),
      cid: 'c-other',
      enabled: () => true,
      syncDeps: async () => ({ ...a.d.deps(), cid: 'c-other', title: () => '別のワークスペース' }),
      ready: () => true,
      lock: null,
      say: () => undefined,
      fail: (t) => void otherFail.push(t),
      onChange: () => undefined,
      nowMs: () => clock.t,
    });
    tick();
    await f2.pick();
    expect(otherFail.join('\n')).toContain('別のワークスペース');
    expect((await syncDir(root)).files.get(folderFileNameOf(idA))!.blob).toBe(before); // 触っていない
  });
});

describe('フォルダ同期: handle の保存と許可', () => {
  it('選んだフォルダは保存され、開き直し(新しい SyncFolder)で許可が生きていれば、選び直さずに続く', async () => {
    const root = new MemDir('クラウド', clock);
    const a = side(await dev('A'), root);
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    expect((await a.store.get(a.d.cid))?.name).toBe('クラウド');
    expect((await a.store.get(a.d.cid))?.handle).toBe(root);
    // 開き直し: 別のインスタンス・同じ置き場
    const again = side(a.d, root, {}, a.store);
    expect(again.f.view().phase).toBe('off');
    tick();
    await again.f.init();
    expect(again.f.view().phase).toBe('idle');
    expect(again.f.view().folderName).toBe('クラウド');
    expect(again.fail).toEqual([]);
  });

  it('許可が切れていれば(prompt)同期せずに「許可する」を出し、押すと再許可を求めて再開する / 拒否なら止めて選び直しを案内する', async () => {
    const root = new MemDir('クラウド', clock);
    const a = side(await dev('A'), root);
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    const dir = await syncDir(root);
    dir.files.clear();
    root.perm = 'prompt';
    const again = side(a.d, root, {}, a.store);
    await again.f.init();
    expect(again.f.view().phase).toBe('needs-permission');
    expect(again.f.view().message).toContain('許可');
    await cycle(again); // 許可が無いので何も書かない
    expect(dir.files.size).toBe(0);
    expect(root.requested).toBe(0); // 勝手に求めない(押した操作の中でだけ求める)
    await again.f.grant();
    expect(root.requested).toBe(1);
    expect(again.f.view().phase).toBe('idle');
    expect(dir.files.size).toBe(1); // 再開して書いた
    // 拒否
    root.perm = 'prompt';
    root.grantResult = 'denied';
    const third = side(a.d, root, {}, a.store);
    await third.f.init();
    await third.f.grant();
    expect(third.f.view().phase).toBe('lost');
    expect(third.f.view().message).toContain('選び直');
  });

  it('許可が無い(denied)で起きたら lost。フォルダの設定を外すと保存も消え、もう一度選べる(片道にしない)', async () => {
    const root = new MemDir('クラウド', clock);
    const a = side(await dev('A'), root);
    await pick(a);
    root.perm = 'denied';
    const again = side(a.d, root, {}, a.store);
    await again.f.init();
    expect(again.f.view().phase).toBe('lost');
    await again.f.release();
    expect(await a.store.get(a.d.cid)).toBeNull();
    expect(again.f.view().phase).toBe('off');
    expect(again.f.view().folderName).toBeNull();
    root.perm = 'granted';
    await pick(again);
    expect(again.f.view().phase).toBe('idle');
  });

  it('保存の置き場が読めなくても落ちない(未設定として扱う)', async () => {
    const root = new MemDir('クラウド', clock);
    const bad = new MemorySyncFolderStore();
    bad.get = async () => {
      throw new Error('idb が壊れている');
    };
    const a = side(await dev('A'), root, {}, bad);
    await a.f.init();
    expect(a.f.view().phase).toBe('off');
    expect(a.fail).toEqual([]);
  });

  it('選べないブラウザ(picker なし)は理由を言って断り、差分ファイルの方法を案内する', async () => {
    const root = new MemDir('クラウド', clock);
    const a = side(await dev('A'), root, { picker: null });
    expect(a.f.view().phase).toBe('unsupported');
    expect(a.f.view().message).toContain('差分を書き出す');
    expect(a.f.view().message).toContain('Chrome');
    await pick(a);
    await a.f.syncNow(true);
    expect(root.dirs.size).toBe(0);
  });
});

describe('フォルダ同期: 設定「端末間の同期」', () => {
  it('切のときは、読まず・書かず・フォルダも作らない(押した回は設定の場所を言って断る)', async () => {
    const root = new MemDir('クラウド', clock);
    const a = side(await dev('A', false), root);
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    expect(root.dirs.size).toBe(0);
    expect(root.files.size).toBe(0);
    expect(a.fail.join('\n')).toContain('端末間の同期');
    expect((await a.store.get(a.d.cid))?.name).toBe('クラウド'); // 選びは覚えておく(入に戻せば再開できる)
  });

  it('入 → 切にすると同期が止まる(タイマーも外れる)。入に戻すと、保存したフォルダで再開する', async () => {
    const root = new MemDir('クラウド', clock);
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const a = side(await dev('A'), root, {
      setTimer: (fn, ms) => {
        const h = { fn, ms };
        timers.push(h);
        return h;
      },
      clearTimer: (h) => void cleared.push(h),
    });
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    expect(timers.length).toBeGreaterThan(0); // 定期の同期が張られている
    expect(timers[timers.length - 1]!.ms).toBe(60_000);
    a.d.enabled = false;
    await a.f.onSettingChanged();
    expect(cleared.length).toBeGreaterThan(0);
    expect(a.f.view().phase).toBe('disabled');
    const writes = new Map(root.writes);
    await a.d.put('n2', '二つ目', '切の間の編集');
    await cycle(a, false);
    expect(new Map(root.writes)).toEqual(writes); // 切の間は書かない
    a.d.enabled = true;
    await a.d.setEnabled(true);
    tick();
    await a.f.onSettingChanged();
    expect(a.f.view().phase).toBe('idle');
    expect([...(await syncDir(root)).files.values()][0]!.blob.size).toBeGreaterThan(0);
  });
});

describe('フォルダ同期: 編集中・確認が要る回', () => {
  it('編集中(ready でない)の回は始めず、短い間隔でやり直す', async () => {
    const root = new MemDir('クラウド', clock);
    let ready = false;
    const timers: number[] = [];
    const a = side(await dev('A'), root, { ready: () => ready, setTimer: (_fn, ms) => void timers.push(ms) });
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    expect(root.dirs.size).toBe(0);
    expect(timers).toContain(5_000);
    ready = true;
    await cycle(a);
    expect(root.dirs.size).toBe(1);
  });

  it('定期の回は確認を出さない: 初めての相手は「確認が要る」と状態に出し、押した回で聞く', async () => {
    const { a, b } = await pair();
    await a.d.put('n1', '一つ目', '本文');
    await pick(a);
    tick();
    const asked = b.d.confirms.length;
    await pick(b); // 押した回 → 聞く(初回の対応づけ)
    expect(b.d.confirms.length).toBe(asked + 1);
    expect((await metas(b.d)).length).toBe(1);
    // 新しい端末 C(初めての相手)のファイルが来る → 定期の回は聞かずに止まる
    const c = side(await dev('C'), (await b.store.get(b.d.cid))!.handle as MemDir);
    await c.d.put('n9', 'C のノート', '本文');
    tick();
    await pick(c); // C は押した回で A・B と対応づけながら取り込む
    tick();
    const confirmsBefore = a.d.confirms.length;
    await cycle(a, false);
    expect(a.f.view().pendingPeers.length).toBeGreaterThan(0);
    expect((await metas(a.d)).map((m) => m.lid)).not.toContain('n9');
    expect(a.d.confirms.length).toBe(confirmsBefore); // 聞いていない(定期の回)
    await cycle(a, true);
    expect((await metas(a.d)).map((m) => m.lid)).toContain('n9');
    expect(a.f.view().pendingPeers).toEqual([]);
  });
});
