/** @vitest-environment node */
/**
 * 🔴 **端末間の同期(#2000)段 3 ── 同期フォルダ(全データ)を、実物の worker の端末 2〜3 台と、共有の「フォルダ」で通す**。
 *
 * フォルダは test 用の作り物(メモリ上)で、**全端末が同じ物を見る** = クラウドドライブが同期し終えた状態。
 * 見る物: 人がファイルを運ばずに、片方の変更(本文・色ラベル・削除)がもう片方へ届く / 初めての相手の確認は 1 度で済む /
 * 中身が同じ回は書き直さない / 許可が切れたら止まって言う / 設定がオフなら何も書かない / やめたら記録が消えてファイルは残る /
 * 同じ端末 id の別の端末が書いたら、書かずに止まる。
 * 空振り防止: 「届いた」は相手の DB(`listEntryMetas` / `getBodies` / `listNoteLabels`)で見る。対照群として、回す前に無いことも見る。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { applySyncDiff, buildSyncDiff, importSyncDiff } from '../../src/adapter/ui/actions/sync-diff';
import { readDiffZip } from '../../src/features/sync/diff-file';
import { SyncFolder, SYNC_FOLDER_LOADING_MARK, SYNC_FOLDER_NO_PERSIST_MARK, type SyncFolderDirLike, type SyncFolderSaved, type SyncFolderStore } from '../../src/adapter/platform/sync-folder';
import { folderFileName } from '../../src/features/sync/sync-folder';
import { spawnDevice, type SyncDevice } from '../helpers/sync-device';

/** 全端末が共有する作り物のフォルダ。 */
class FakeFolder implements SyncFolderDirLike {
  readonly name = 'クラウドの同期フォルダ';
  files = new Map<string, { blob: Blob; mtime: number }>();
  clock = 1000;
  permission: 'granted' | 'prompt' = 'granted';
  grantOnRequest = true;
  writes: string[] = [];
  async *values(): AsyncIterable<{ kind: string; name: string }> {
    for (const name of [...this.files.keys()]) yield { kind: 'file', name };
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name) && options?.create !== true) {
      const e = new Error('not found');
      e.name = 'NotFoundError';
      throw e;
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const folder = this;
    return {
      kind: 'file' as const,
      name,
      async getFile(): Promise<File> {
        const f = folder.files.get(name);
        return new File([f?.blob ?? new Blob([])], name, { lastModified: f?.mtime ?? 0 });
      },
      async createWritable() {
        const parts: Blob[] = [];
        return {
          write: async (d: Blob | string) => void parts.push(typeof d === 'string' ? new Blob([d]) : d),
          close: async () => {
            folder.files.set(name, { blob: new Blob(parts), mtime: ++folder.clock });
            folder.writes.push(name);
          },
        };
      },
    };
  }
  async getDirectoryHandle(): Promise<never> {
    throw new Error('使わない');
  }
  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
  }
  async queryPermission(): Promise<string> {
    return this.permission;
  }
  async requestPermission(): Promise<string> {
    if (this.grantOnRequest) this.permission = 'granted';
    return this.permission;
  }
}

class MemStore implements SyncFolderStore {
  map = new Map<string, SyncFolderSaved>();
  loads = 0;
  async load(cid: string) {
    this.loads++;
    return this.map.get(cid) ?? null;
  }
  async save(cid: string, v: SyncFolderSaved) {
    this.map.set(cid, structuredClone({ ...v, handle: null }) as unknown as SyncFolderSaved);
    (this.map.get(cid) as SyncFolderSaved).handle = v.handle;
  }
  async remove(cid: string) {
    this.map.delete(cid);
  }
  marks = new Map<string, string>();
  async getMark(k: string) {
    return this.marks.get(k) ?? null;
  }
  async setMark(k: string, v: string | null) {
    if (v === null) this.marks.delete(k);
    else this.marks.set(k, v);
  }
}

interface Rig {
  d: SyncDevice;
  sf: SyncFolder;
  store: MemStore;
  says: string[];
  fails: string[];
}

const devices: SyncDevice[] = [];
afterEach(async () => {
  for (const d of devices.splice(0)) await d.close().catch(() => undefined);
});

async function rig(name: string, folder: FakeFolder, opts: { enabled?: boolean; store?: MemStore; cid?: string } = {}): Promise<Rig> {
  const d = await spawnDevice(name, opts.cid);
  devices.push(d);
  await d.setEnabled(opts.enabled ?? true);
  const store = opts.store ?? new MemStore();
  const says: string[] = [];
  const fails: string[] = [];
  const sf = new SyncFolder({
    cid: () => d.cid,
    enabled: () => d.enabled,
    picker: async () => folder,
    store,
    lock: null,
    device: async () => (await d.request({ op: 'syncSnapshot', cid: d.cid, ensureDevice: true })).device as string,
    build: (t) => buildSyncDiff(d.deps(), t),
    apply: async (file, nm, auto) => {
      const diff = await readDiffZip(file);
      return { outcome: await applySyncDiff(d.deps(), diff, nm, { auto, folder: true }), manifest: diff.manifest };
    },
    say: (t) => void says.push(t),
    fail: (t) => void fails.push(t),
    onChange: () => undefined,
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  return { d, sf, store, says, fails };
}

/**
 * A の端末のデータを複製した別の端末が書いたファイルを作る: A 自身の書き出し(A の id・A の中身)で、A の控え(`out:<連番>`、8 件まで)から
 * 押し出された古い物 = A から見て「自分の id なのに自分の記録に無い」ファイル。
 */
async function cloneBlobOf(d: SyncDevice): Promise<Blob> {
  const first = await buildSyncDiff(d.deps(), { kind: 'download', all: true });
  if (first.skipped) throw new Error('書けていない');
  for (let i = 0; i < 9; i++) await buildSyncDiff(d.deps(), { kind: 'download', all: true });
  return first.blob;
}

const titles = async (d: SyncDevice): Promise<string[]> => (await d.request({ op: 'listEntryMetas', cid: d.cid })).map((m) => m.title).sort();
const bodyOf = async (d: SyncDevice, lid: string): Promise<string | null> => (await d.request({ op: 'getBodies', cid: d.cid, lids: [lid] }))[0]?.body ?? null;
const deviceId = async (d: SyncDevice): Promise<string> => (await d.request({ op: 'syncSnapshot', cid: d.cid, ensureDevice: true })).device as string;

describe('同期フォルダ(段 3)', () => {
  it('人がファイルを運ばずに、本文・色ラベル・削除が届く。初めての相手の確認は片方で 1 度だけ', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    const B = await rig('B', folder);
    await A.d.put('n1', '日本語のメモ', '最初の本文');
    await A.sf.pick();
    expect(A.fails).toEqual([]);
    expect([...folder.files.keys()], 'A のファイルだけが置かれる').toEqual([folderFileName(await deviceId(A.d))]);
    expect(await titles(B.d), '対照群: B にはまだ無い').toEqual([]);

    await B.sf.pick(); // 手で選んだ回 = 初めての相手を確認する
    expect(B.fails).toEqual([]);
    expect(B.d.confirms.length, 'B の側で 1 度だけ確認する').toBe(1);
    expect(await titles(B.d)).toEqual(['日本語のメモ']);
    expect(folder.files.size, '端末ごとに 1 つ').toBe(2);

    // A の定期の回(無人)── B の側で確認済みなので、A では聞かずに取り込む
    await B.d.put('n2', 'B で書いた', 'B の本文');
    await B.sf.syncNow(false);
    await A.sf.syncNow(false);
    expect(A.fails).toEqual([]);
    expect(A.d.confirms, 'A では確認を出さない').toEqual([]);
    expect(await titles(A.d)).toEqual(['B で書いた', '日本語のメモ']);

    // 編集・色・削除が無人の回で届く
    await A.d.put('n1', '日本語のメモ', '直した本文');
    await A.d.request({ op: 'putNoteLabel', cid: A.d.cid, lid: 'n1', color: 4 });
    await A.d.del('n2');
    await A.sf.syncNow(false);
    await B.sf.syncNow(false);
    expect(B.fails).toEqual([]);
    expect(await bodyOf(B.d, 'n1')).toBe('直した本文');
    expect((await B.d.request({ op: 'listNoteLabels', cid: B.d.cid })).map((x) => [x.lid, x.color])).toEqual([['n1', 4]]);
    expect(await titles(B.d), '相手で消したノートはゴミ箱へ').toEqual(['日本語のメモ']);
  });

  it('中身が同じ回は書き直さない(定期の回で同じファイルを書き続けない)。自分しか居ない間も書き直さない', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    const B = await rig('B', folder);
    await A.d.put('n1', 'メモ', '本文');
    await A.sf.pick();
    expect(folder.writes.length, '対照群: 最初は書く').toBe(1);
    await A.d.put('n1', 'メモ', '一人で直した');
    await A.sf.syncNow(false);
    expect(folder.writes.length, '読む相手が居ない間は書き直さない').toBe(1);
    await B.sf.pick();
    expect(await bodyOf(B.d, 'n1'), '古いファイルでもまず取り込める').toBe('本文');
    await A.sf.syncNow(false); // B が加わった ── 全件を書き直す
    await B.sf.syncNow(false);
    expect(await bodyOf(B.d, 'n1'), '次の回で新しい本文が届く').toBe('一人で直した');
    const n = folder.writes.length;
    await A.sf.syncNow(false);
    await A.sf.syncNow(false);
    await B.sf.syncNow(false);
    await A.sf.syncNow(false);
    const steady = folder.writes.length;
    await A.sf.syncNow(false);
    await B.sf.syncNow(false);
    expect(folder.writes.length, '落ち着いた後は、変わっていないので書かない').toBe(steady);
    expect(steady - n, '落ち着くまでの書き直しは少ない').toBeLessThanOrEqual(4);
    await A.d.put('n1', 'メモ', '本文を直した');
    await A.sf.syncNow(false);
    expect(folder.writes.length, '変わったら書く').toBe(steady + 1);
    await B.sf.syncNow(false);
    expect(await bodyOf(B.d, 'n1')).toBe('本文を直した');
  });

  it('3 台目が加わっても、全員に届く(端末ごとのファイルを全員が読む)', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    const B = await rig('B', folder);
    await A.d.put('n1', 'A のメモ', 'a');
    await A.sf.pick();
    await B.sf.pick();
    await A.sf.syncNow(false);
    const C = await rig('C', folder);
    await C.d.put('c1', 'C のメモ', 'c');
    await C.sf.pick();
    expect(C.fails).toEqual([]);
    expect(await titles(C.d)).toEqual(['A のメモ', 'C のメモ']);
    for (let i = 0; i < 2; i++) for (const r of [A, B, C]) await r.sf.syncNow(false);
    for (const r of [A, B, C]) {
      expect(r.fails, r.d.name).toEqual([]);
      expect(await titles(r.d), r.d.name).toEqual(['A のメモ', 'C のメモ']);
    }
  });

  /**
   * 🔴 **保管先の口(RemoteBox)を通しても、エラーの名前が回まで届く**(#2000 段 4a-1 着地前レビュー ⚠3)── 一覧で
   *   `NotAllowedError` / `NotFoundError` が出たら「許可が切れた / フォルダが消えた」として選び直しを頼む(握り潰して
   *   ふつうの失敗にすると、許可の出し直しの案内が出なくなる)。
   */
  it.each(['NotAllowedError', 'NotFoundError'])('🔴 一覧で %s が出たら、許可・選び直しの状態になる', async (name) => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    await A.sf.pick();
    // 次の回の一覧で投げる
    folder.values = (): AsyncIterable<{ kind: string; name: string }> => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(Object.assign(new Error('x'), { name })) }),
    });
    await A.sf.syncNow(false);
    expect(A.sf.view().phase, `${name} が許可・選び直しにならない`).toBe('permission');
    expect(A.fails.at(-1) ?? '').toContain('選び直してください');
  });

  it('許可が切れていたら止まって言い、「許可を出し直す」で戻る(handle は憶えている)', async () => {
    const folder = new FakeFolder();
    const store = new MemStore();
    const A = await rig('A', folder, { store });
    await A.d.put('n1', 'メモ', '本文');
    await A.sf.pick();
    expect(store.map.has(A.d.cid), 'フォルダを憶えた').toBe(true);
    // 開き直した(新しい SyncFolder)── 許可は「聞き直し」の状態
    folder.permission = 'prompt';
    const writes = folder.writes.length;
    const A2 = new SyncFolder({
      cid: () => A.d.cid,
      enabled: () => true,
      picker: async () => folder,
      store,
      device: async () => deviceId(A.d),
      build: (t) => buildSyncDiff(A.d.deps(), t),
      apply: async (file, nm, auto) => {
        const diff = await readDiffZip(file);
        return { outcome: await applySyncDiff(A.d.deps(), diff, nm, { auto, folder: true }), manifest: diff.manifest };
      },
      say: () => undefined,
      fail: () => undefined,
      onChange: () => undefined,
      setTimer: () => 0,
    });
    await A2.boot();
    expect(A2.view().phase).toBe('permission');
    expect(A2.view().folderName).toBe('クラウドの同期フォルダ');
    // 相手(B)のファイルを置く ── 許可が戻れば取り込む物がある
    const B = await rig('B', new FakeFolder());
    await B.d.put('b1', 'B のメモ', 'b');
    const built = await buildSyncDiff(B.d.deps(), { kind: 'folder', others: [], wantedBy: [], want: [], ownFilePresent: false, lastKey: null });
    if (built.skipped) throw new Error('書けていない');
    folder.files.set(folderFileName(await deviceId(B.d)), { blob: built.blob, mtime: ++folder.clock });
    await A2.syncNow(false);
    expect(A2.view().lastAt, '許可が無い間は回らない').toBeNull();
    expect(folder.writes.length, '許可が無い間は書かない').toBe(writes);
    expect(await titles(A.d), '許可が無い間は取り込まない').toEqual(['メモ']);
    await A2.reconnect();
    expect(A2.view().phase).toBe('idle');
    expect(await titles(A.d), '許可が戻ったら取り込む(手で = 初めての相手を確認する)').toEqual(['B のメモ', 'メモ']);
    expect(folder.writes.length, '相手が居るので全件を書き直す').toBe(writes + 1);
  });

  it('設定「端末間の同期」がオフなら、選べず・何も書かない', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder, { enabled: false });
    await A.sf.boot();
    expect(A.sf.view().phase).toBe('off');
    await A.sf.pick();
    expect(A.fails.join('\n')).toContain('端末間の同期');
    expect(folder.files.size).toBe(0);
    expect(A.store.map.size).toBe(0);
  });

  it('やめると handle と記録が消え、フォルダのファイルは残る(片道にしない)', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    await A.d.put('n1', 'メモ', '本文');
    await A.sf.pick();
    expect(A.store.map.size).toBe(1);
    await A.sf.stop();
    expect(A.store.map.size).toBe(0);
    expect(folder.files.size, 'ファイルは消さない').toBe(1);
    expect(A.sf.view().phase).toBe('none');
    await A.sf.syncNow(true);
    expect(folder.writes.length, 'やめた後は書かない').toBe(1);
  });

  it('同じ端末 id の別の端末が同じ名前で書いたら、無人の回では書かずに止まって言う', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    const B = await rig('B', folder);
    await A.d.put('n1', 'メモ', '本文');
    await B.d.put('b1', 'B のメモ', 'b');
    await A.sf.pick();
    // A の DB を複製した別の端末が、A の名前で書いた
    const aName = folderFileName(await deviceId(A.d));
    folder.files.set(aName, { blob: await cloneBlobOf(A.d), mtime: ++folder.clock });
    const writes = folder.writes.length;
    await A.sf.syncNow(false);
    expect(A.sf.view().phase).toBe('stopped');
    expect(A.fails.join('\n')).toContain('同じ ID');
    expect(folder.writes.length, '書き合わない').toBe(writes);
    expect(A.d.confirms, '無人の回では確認を出さない').toEqual([]);
  });

  it('🔴 読み込みの見張り: 前に handle を読む途中で落ちていたら、読まずに捨て、以後この端末では handle を憶えない', async () => {
    const folder = new FakeFolder();
    const store = new MemStore();
    const marks = store.marks;
    const fails: string[] = [];
    const d = await spawnDevice('A');
    devices.push(d);
    await d.setEnabled(true);
    const make = () =>
      new SyncFolder({
        cid: () => d.cid,
        enabled: () => true,
        picker: async () => folder,
        store,
        device: async () => deviceId(d),
        build: (t) => buildSyncDiff(d.deps(), t),
        apply: async (file, nm, auto) => {
          const diff = await readDiffZip(file);
          return { outcome: await applySyncDiff(d.deps(), diff, nm, { auto, folder: true }), manifest: diff.manifest };
        },
        say: () => undefined,
        fail: (t) => void fails.push(t),
        onChange: () => undefined,
        setTimer: () => 0,
      });
    const first = make();
    await first.pick();
    expect(store.map.get(d.cid)?.handle, '対照群: ふだんは handle を憶える').toBe(folder);
    // 前の起動が handle を読む途中で落ちた(印が残っている)
    marks.set(SYNC_FOLDER_LOADING_MARK, '1');
    const loadsBefore = store.loads;
    const second = make();
    await second.boot();
    expect(store.loads, '落ちた handle を読み直さない(読むとまた落ちる)').toBe(loadsBefore);
    expect(store.map.has(d.cid), '憶えていた handle を捨てる').toBe(false);
    expect(marks.get(SYNC_FOLDER_NO_PERSIST_MARK)).toBe('1');
    expect(marks.has(SYNC_FOLDER_LOADING_MARK), '印は片付ける').toBe(false);
    expect(fails.join('\n')).toContain('保存しないようにしました');
    expect(second.view().phase).toBe('none');
    // 選び直すと同期はできるが、handle は憶えない
    await second.pick();
    expect(second.view().phase).toBe('idle');
    expect(store.map.get(d.cid)?.handle, 'この端末では handle を書かない').toBeNull();
    const third = make();
    await third.boot();
    expect(third.view().phase, '開き直すと選び直す').toBe('none');
    expect(marks.has(SYNC_FOLDER_LOADING_MARK), 'ふつうに読めた回は印を残さない').toBe(false);
    // 戻す道(片道にしない)── 選び直して「保存するように戻す」と、次に開いたときもそのフォルダを使う
    await third.pick();
    expect(third.view().persist).toBe(false);
    await third.allowPersist();
    expect(third.view().persist).toBe(true);
    expect(store.map.get(d.cid)?.handle, '戻したら handle を保存する').toBe(folder);
    expect(marks.has(SYNC_FOLDER_NO_PERSIST_MARK)).toBe(false);
    const fourth = make();
    await fourth.boot();
    expect(['idle', 'running'], '保存した handle で回り始める').toContain(fourth.view().phase);
    // 別のタブがいま読んでいる途中の印(ついさっきの時刻)は、落ちた跡とみなさない
    marks.set(SYNC_FOLDER_LOADING_MARK, String(Date.now()));
    const fifth = make();
    await fifth.boot();
    expect(['idle', 'running'], '別のタブの読み込み中の印で、保存した handle を捨てない').toContain(fifth.view().phase);
    expect(marks.has(SYNC_FOLDER_NO_PERSIST_MARK)).toBe(false);
  });

  it('「相手の側で確認済み」で確認を省くのは同期フォルダの中だけ(同じファイルを手で選んで取り込むときは聞く)', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    const B = await rig('B', folder);
    await A.d.put('n1', 'メモ', '本文');
    await A.sf.pick();
    await B.sf.pick(); // B の側で A との対応を確認した
    const bName = folderFileName(await deviceId(B.d));
    const bFile = await (await folder.getFileHandle(bName)).getFile();
    expect((await readDiffZip(bFile)).manifest.pairs?.[await deviceId(A.d)], 'B のファイルは A との対応を言う').toBe(A.d.cid);
    // 手で運んだファイルとして取り込む ── 確認を出す
    const r = await importSyncDiff(A.d.deps(), bFile, bName);
    expect(r.ok).toBe(true);
    expect(A.d.confirms.length, '手で選んだファイルは、中身が何と言っても確認する').toBe(1);
  });

  it('両方で同じノートを直しても、競合のコピーは 1 つで止まる(回を重ねても増えない)', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    const B = await rig('B', folder);
    await A.d.put('n1', 'メモ', '本文');
    await A.sf.pick();
    await B.sf.pick();
    await A.sf.syncNow(false);
    await B.sf.syncNow(false);
    await A.d.put('n1', 'メモ', 'A で直した');
    await B.d.put('n1', 'メモ', 'B で直した');
    const copies = async (d: SyncDevice): Promise<number> => (await titles(d)).filter((t) => t.includes('同期の競合')).length;
    for (let i = 0; i < 3; i++) {
      await A.sf.syncNow(false);
      await B.sf.syncNow(false);
    }
    const a1 = await copies(A.d);
    const b1 = await copies(B.d);
    expect(a1 + b1, '競合は残す(消さない)').toBeGreaterThan(0);
    expect(a1, 'A の競合のコピーは 1 つまで').toBeLessThanOrEqual(1);
    expect(b1, 'B の競合のコピーは 1 つまで').toBeLessThanOrEqual(1);
    for (let i = 0; i < 4; i++) {
      await A.sf.syncNow(false);
      await B.sf.syncNow(false);
    }
    expect(await copies(A.d), '回を重ねても増えない').toBe(a1);
    expect(await copies(B.d), '回を重ねても増えない').toBe(b1);
  });

  /** 同じ端末(同じ worker)の別のワークスペースに、同期フォルダの係をもう 1 つ付ける。 */
  async function secondWorkspace(base: Rig, folder: FakeFolder, cid: string): Promise<Rig> {
    await base.d.request({ op: 'openContainer', cid, title: '二つ目のワークスペース' });
    const store = new MemStore();
    const says: string[] = [];
    const fails: string[] = [];
    const deps = () => base.d.deps({ cid, title: () => '二つ目のワークスペース' });
    const sf = new SyncFolder({
      cid: () => cid,
      enabled: () => base.d.enabled,
      picker: async () => folder,
      store,
      device: async () => deviceId(base.d),
      build: (t) => buildSyncDiff(deps(), t),
      apply: async (file, nm, auto) => {
        const diff = await readDiffZip(file);
        return { outcome: await applySyncDiff(deps(), diff, nm, { auto, folder: true }), manifest: diff.manifest };
      },
      say: (t) => void says.push(t),
      fail: (t) => void fails.push(t),
      onChange: () => undefined,
      setTimer: () => 0,
    });
    return { d: base.d, sf, store, says, fails };
  }

  it('同じブラウザの別のワークスペースが同じフォルダを選んだら、書き合わずに止まって言う(言うのは 1 度)', async () => {
    const folder = new FakeFolder();
    const W1 = await rig('A', folder);
    await W1.d.put('n1', 'メモ', '本文');
    await W1.sf.pick();
    const writes = folder.writes.length;
    const W2 = await secondWorkspace(W1, folder, 'c-A-2');
    await W2.sf.pick();
    expect(W2.sf.view().phase).toBe('stopped');
    expect(W2.sf.view().message ?? '').toContain('別の同期フォルダ');
    expect(folder.writes.length, 'W1 のファイルを上書きしない').toBe(writes);
    const before = W1.d.failures.length + W2.fails.length;
    await W2.sf.syncNow(false);
    await W2.sf.syncNow(false);
    expect(W1.d.failures.length + W2.fails.length, '無人の回で同じ問題を積み続けない').toBe(before);
    expect(folder.writes.length).toBe(writes);
    await W1.sf.syncNow(false);
    expect(W1.fails, 'W1 はそのまま回る').toEqual([]);
  });

  it('確認に「やめる」と答えたら取り込んだことにしない(無人の回も確認待ちのまま。次に手で答えれば取り込む)', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    const B = await rig('B', folder);
    await A.d.put('n1', 'A のメモ', 'a');
    await A.sf.pick();
    let answer = false;
    const Bno = new SyncFolder({
      cid: () => B.d.cid,
      enabled: () => true,
      picker: async () => folder,
      store: B.store,
      device: async () => deviceId(B.d),
      build: (t) => buildSyncDiff(B.d.deps(), t),
      apply: async (file, nm, auto) => {
        const diff = await readDiffZip(file);
        return { outcome: await applySyncDiff(B.d.deps({ confirmAction: async () => answer }), diff, nm, { auto, folder: true }), manifest: diff.manifest };
      },
      say: () => undefined,
      fail: () => undefined,
      onChange: () => undefined,
      setTimer: () => 0,
    });
    await Bno.pick();
    expect(await titles(B.d), 'やめたので入らない').toEqual([]);
    expect(Bno.view().pending, '確認待ちとして数える').toBe(1);
    await Bno.syncNow(false);
    expect(Bno.view().pending, '無人の回も確認待ちのまま(読んだことにしていない)').toBe(1);
    answer = true;
    await Bno.syncNow(true);
    expect(await titles(B.d)).toEqual(['A のメモ']);
    expect(Bno.view().pending).toBe(0);
  });

  it('同じ id の複製を手で確認すると、端末 id を作り直して新しい名前で書き、複製元のファイルは消さない', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    const B = await rig('B', folder);
    await A.d.put('n1', 'メモ', '本文');
    await B.d.put('b1', 'B のメモ', 'b');
    await A.sf.pick();
    const oldId = await deviceId(A.d);
    folder.files.set(folderFileName(oldId), { blob: await cloneBlobOf(A.d), mtime: ++folder.clock });
    await A.sf.syncNow(true); // 手で = 作り直しの確認(test の確認は「はい」)
    const newId = await deviceId(A.d);
    expect(newId, '端末 id を作り直した').not.toBe(oldId);
    expect(folder.files.has(folderFileName(newId)), '新しい名前で書く').toBe(true);
    expect(folder.files.has(folderFileName(oldId)), '複製元のファイルは消さない').toBe(true);
    expect(A.sf.view().phase).toBe('idle');
    // 次の回でも消さない(前の名前は複製元の物 ── 片付けの対象にしない)
    await A.sf.syncNow(false);
    expect(folder.files.has(folderFileName(oldId)), '次の回で複製元のファイルを消した').toBe(true);
  });

  it('同期の記録を消したら、前の id で置いた自分のファイルを片付けて、新しい id で書く(別の係の回でも片付く)', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    const B = await rig('B', folder);
    await A.d.put('n1', 'メモ', '本文');
    await A.sf.pick();
    await B.sf.pick();
    const oldId = await deviceId(A.d);
    await A.d.request({ op: 'syncForget' });
    await A.sf.forgetRecords();
    const newId = await deviceId(A.d);
    expect(newId).not.toBe(oldId);
    expect(folder.files.has(folderFileName(oldId)), '前の id のファイルを片付ける').toBe(false);
    expect(folder.files.has(folderFileName(newId)), '新しい id で書く').toBe(true);
    // 記録を消したときに係が回っていなかった(オフ・別のワークスペース)── 次の回の最初に片付く
    const id2 = await deviceId(A.d);
    await A.d.request({ op: 'syncForget' });
    await A.sf.syncNow(false);
    const id3 = await deviceId(A.d);
    expect(id3).not.toBe(id2);
    expect(folder.files.has(folderFileName(id2)), '次の回で前の id のファイルを片付ける').toBe(false);
    expect(folder.files.has(folderFileName(id3))).toBe(true);
  });

  it('設定がオフなら「同期の記録を消す」でもフォルダに触らない', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    await A.d.put('n1', 'メモ', '本文');
    await A.sf.pick();
    const files = [...folder.files.keys()];
    A.d.enabled = false;
    await A.sf.forgetRecords();
    expect([...folder.files.keys()]).toEqual(files);
  });

  it('ファイル名と中身の端末が違うファイルは取り込まない(名前で誰のファイルかを決めているため)', async () => {
    const folder = new FakeFolder();
    const A = await rig('A', folder);
    const B = await rig('B', folder);
    await A.d.put('n1', 'メモ', '本文');
    await B.d.put('b1', 'B のメモ', 'b');
    await A.sf.pick();
    const built = await buildSyncDiff(B.d.deps(), { kind: 'folder', others: [], wantedBy: [], want: [], ownFilePresent: false, lastKey: null });
    if (built.skipped) throw new Error('書けていない');
    folder.files.set(folderFileName('aaaaaaaaaaaaaaaa'), { blob: built.blob, mtime: ++folder.clock });
    await A.sf.syncNow(true);
    expect(await titles(A.d), '入れない').toEqual(['メモ']);
    expect(A.d.failures.join('\n') + A.fails.join('\n')).toContain('ファイル名と中身の端末が違う');
  });
});
