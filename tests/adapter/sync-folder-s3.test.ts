/** @vitest-environment node */
/**
 * 🔴 **端末間の同期(#2000)段 4a-4 ── S3 互換の保管先を、実物の worker の端末 2 台と作り物の S3(署名を独立に検算する)で通す**。
 *
 * 見る物:
 * - 人がファイルを運ばずに届く(同期フォルダと同じ回が、保管先の口で回る)
 * - 🔴 同期の記録(IndexedDB の `pkc3-sync-folder`)には**種類だけ** ── 認証情報は鍵の保管(暗号化)にだけ在る
 * - 開き直したら、鍵の保管から開いて回り始める / 開けなければ理由を言う
 * - 接続の確認は保存しない / 接続できなければ何も保存しない / 失敗の字に秘密を混ぜない
 * - 🔴 412(書く間に別の端末が書いた)は上書きせずに止める
 * - 「接続を外す」で認証情報を消す(保管先のファイルは残す)/ フォルダへ切り替えると認証情報を消す(片道にしない)
 * - 📌 `file://` では選べない(「HTTPS で開いたときだけ使えます」)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { applySyncDiff, buildSyncDiff } from '../../src/adapter/ui/actions/sync-diff';
import { readDiffZip } from '../../src/features/sync/diff-file';
import {
  SyncFolder,
  SYNC_REMOTE_HTTPS_ONLY,
  SYNC_REMOTE_UNREADABLE_NOTE,
  type SyncFolderDirLike,
  type SyncFolderSaved,
  type SyncFolderStore,
  type SyncRemoteDeps,
  type SyncRemoteForm,
} from '../../src/adapter/platform/sync-folder';
import { remoteUnavailableReason } from '../../src/adapter/platform/sync-remote';
import { S3Box, webSigCrypto } from '../../src/adapter/platform/s3-box';
import { SyncKeystore, type KeystoreBackend } from '../../src/adapter/platform/sync-keystore';
import { folderFileName } from '../../src/features/sync/sync-folder';
import { fakeS3, type FakeS3 } from '../helpers/fake-s3';
import { spawnDevice, type SyncDevice } from '../helpers/sync-device';

const KEY_ID = 'AKIA-CANARY-ID-77';
const SECRET_KEY = 'canary/SECRET+key=Qz19';
const SECRET = { accessKeyId: KEY_ID, secretAccessKey: SECRET_KEY };
const FORM: SyncRemoteForm = { endpoint: 'https://s3.example.test/', bucket: ' my notes ', region: '', prefix: 'pkc3', accessKeyId: KEY_ID, secretAccessKey: SECRET_KEY };

class MemStore implements SyncFolderStore {
  map = new Map<string, SyncFolderSaved>();
  async load(cid: string) {
    return (this.map.get(cid) as SyncFolderSaved | undefined) ?? null;
  }
  async save(cid: string, v: SyncFolderSaved) {
    // ⚠ 写しを取る(呼び手の物を覚えない)── handle は structured clone の代わりにそのまま
    this.map.set(cid, { ...structuredClone({ ...v, handle: null }), handle: v.handle });
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

function memBackend(): KeystoreBackend {
  let key: CryptoKey | null = null;
  const boxes = new Map<string, unknown>();
  return {
    getKey: async () => key,
    putKey: async (k) => void (key = k),
    deleteKey: async () => void (key = null),
    getBox: async (cid) => (boxes.get(cid) as never) ?? null,
    putBox: async (cid, v) => void boxes.set(cid, structuredClone(v)),
    deleteBox: async (cid) => void boxes.delete(cid),
    countBoxes: async () => boxes.size,
  };
}

/** 端末ごとの保管先の口(鍵の保管は本物の SyncKeystore + メモリの置き場、保管先は本物の S3Box + 作り物の S3)。 */
function remoteDeps(s3: FakeS3, opts: { unavailable?: string | null; backend?: KeystoreBackend } = {}): SyncRemoteDeps & { ks: SyncKeystore } {
  const ks = new SyncKeystore(opts.backend ?? memBackend());
  return {
    ks,
    unavailable: () => opts.unavailable ?? null,
    open: (cid) => ks.open(cid),
    save: (cid, c, sec) => ks.save(cid, c, sec),
    remove: (cid) => ks.remove(cid),
    box: (config, secret) => new S3Box({ config, secret, crypto: webSigCrypto(), fetch: s3.fetch }),
  };
}

interface Rig {
  d: SyncDevice;
  sf: SyncFolder;
  store: MemStore;
  remote: SyncRemoteDeps & { ks: SyncKeystore };
  says: string[];
  fails: string[];
}

const devices: SyncDevice[] = [];
afterEach(async () => {
  for (const d of devices.splice(0)) await d.close().catch(() => undefined);
});

function folderOf(sf: () => SyncFolder | null): SyncFolderDirLike {
  void sf;
  const files = new Map<string, Blob>();
  return {
    name: '手元のフォルダ',
    async *values() {
      for (const name of files.keys()) yield { kind: 'file', name };
    },
    async getFileHandle(name: string, o?: { create?: boolean }) {
      if (!files.has(name) && o?.create !== true) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
      return {
        kind: 'file' as const,
        name,
        getFile: async () => new File([files.get(name) ?? new Blob([])], name, { lastModified: 1 }),
        createWritable: async () => {
          const parts: Blob[] = [];
          return { write: async (b: Blob | string) => void parts.push(typeof b === 'string' ? new Blob([b]) : b), close: async () => void files.set(name, new Blob(parts)) };
        },
      };
    },
    getDirectoryHandle: async () => {
      throw new Error('使わない');
    },
    removeEntry: async (n: string) => void files.delete(n),
    queryPermission: async () => 'granted',
  } as unknown as SyncFolderDirLike;
}

async function rig(name: string, s3: FakeS3, opts: { store?: MemStore; d?: SyncDevice; remote?: SyncRemoteDeps & { ks: SyncKeystore }; unavailable?: string | null } = {}): Promise<Rig> {
  const d = opts.d ?? (await spawnDevice(name));
  if (opts.d === undefined) {
    devices.push(d);
    await d.setEnabled(true);
  }
  const store = opts.store ?? new MemStore();
  const remote = opts.remote ?? remoteDeps(s3, { unavailable: opts.unavailable ?? null });
  const says: string[] = [];
  const fails: string[] = [];
  const sf = new SyncFolder({
    cid: () => d.cid,
    enabled: () => d.enabled,
    picker: async () => folderOf(() => null),
    remote,
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
  return { d, sf, store, remote, says, fails };
}

const titles = async (d: SyncDevice): Promise<string[]> => (await d.request({ op: 'listEntryMetas', cid: d.cid })).map((m) => m.title).sort();
const deviceId = async (d: SyncDevice): Promise<string> => (await d.request({ op: 'syncSnapshot', cid: d.cid, ensureDevice: true })).device as string;
const noSecret = (texts: readonly string[]): void => {
  for (const t of texts) for (const c of [KEY_ID, SECRET_KEY, 'CANARY', 'canary']) expect(t, `字に ${c} が入った`).not.toContain(c);
};

describe('S3 互換の保管先(段 4a-4)', () => {
  it('🔴 人がファイルを運ばずに届く / 同期の記録には種類だけ(認証情報は入らない)/ 接続先は揃えて保存', async () => {
    const s3 = fakeS3(SECRET);
    const A = await rig('A', s3);
    const B = await rig('B', s3);
    await A.d.put('n1', '日本語のメモ', '本文');
    expect(await A.sf.connectRemote(FORM)).toBe(true);
    expect(A.fails).toEqual([]);
    expect([...s3.objects.keys()], '揃えた置き場(pkc3/)の直下に A のファイル').toEqual([`pkc3/${folderFileName(await deviceId(A.d))}`]);
    expect(await titles(B.d), '対照群: B にはまだ無い').toEqual([]);
    expect(await B.sf.connectRemote(FORM)).toBe(true);
    expect(B.fails).toEqual([]);
    expect(await titles(B.d)).toEqual(['日本語のメモ']);
    // 無人の回でも届く
    await B.d.put('n2', 'B のメモ', 'b');
    await B.sf.syncNow(false);
    await A.sf.syncNow(false);
    expect(await titles(A.d)).toEqual(['B のメモ', '日本語のメモ']);
    // 🔴 同期の記録に認証情報が無い(種類だけ)
    const saved = A.store.map.get(A.d.cid)!;
    expect(saved.kind).toBe('s3');
    expect(saved.handle).toBeNull();
    noSecret([JSON.stringify(saved)]);
    expect(await A.remote.ks.config(A.d.cid)).toEqual({ kind: 's3', endpoint: 'https://s3.example.test', bucket: 'my notes', region: 'auto', prefix: 'pkc3/' });
    expect(A.sf.view()).toMatchObject({ kind: 's3', folderName: 'my notes/pkc3', phase: 'idle' });
    noSecret([...A.says, ...A.fails, ...B.says, ...B.fails, JSON.stringify(A.sf.view())]);
  });

  it('🔴 開き直したら鍵の保管から開いて回り始める / 開けなければ理由を言い、回らない', async () => {
    const s3 = fakeS3(SECRET);
    const A = await rig('A', s3);
    await A.d.put('n1', 'メモ', '本文');
    await A.sf.connectRemote(FORM);
    // 読む相手が居ないと書き直さない(段 3 のまま)── 相手を 1 台置く
    const B = await rig('B', s3);
    await B.sf.connectRemote(FORM);
    await A.sf.syncNow(true);
    const writes = s3.seen.filter((x) => x.method === 'PUT').length;
    await A.d.put('n1', 'メモ', '直した');
    // 開き直す(同じ記録・同じ鍵の保管)
    const A2 = await rig('A', s3, { d: A.d, store: A.store, remote: A.remote });
    await A2.sf.boot();
    await A2.sf.syncNow(true); // 起動の回(無人)の終わりを待つ
    expect(A2.sf.view()).toMatchObject({ kind: 's3', phase: 'idle' });
    expect(A2.fails).toEqual([]);
    expect(s3.seen.filter((x) => x.method === 'PUT').length, '開き直した後も書く').toBeGreaterThan(writes);
    // 鍵の保管が消えた(ブラウザがデータを消した)
    const A3 = await rig('A', s3, { d: A.d, store: A.store, remote: remoteDeps(s3) });
    await A3.sf.boot();
    expect(A3.sf.view()).toMatchObject({ kind: null, phase: 'none', message: SYNC_REMOTE_UNREADABLE_NOTE });
    expect(A3.fails).toEqual([SYNC_REMOTE_UNREADABLE_NOTE]);
  });

  it('🔴 接続の確認は保存しない / 認証情報が違えば何も保存せず、字に秘密を混ぜない', async () => {
    const s3 = fakeS3(SECRET);
    const A = await rig('A', s3);
    const ok = await A.sf.testRemote(FORM);
    expect(ok.ok).toBe(true);
    expect(await A.remote.ks.config(A.d.cid), '確認だけでは保存しない').toBeNull();
    expect(A.store.map.size).toBe(0);
    const wrong = { ...FORM, secretAccessKey: 'wrong/canary-secret' };
    const bad = await A.sf.testRemote(wrong);
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('SignatureDoesNotMatch');
    expect(await A.sf.connectRemote(wrong)).toBe(false);
    expect(await A.remote.ks.config(A.d.cid), '接続できなければ保存しない').toBeNull();
    expect(A.store.map.size).toBe(0);
    expect(A.sf.view().kind).toBeNull();
    expect(A.fails.at(-1)).toContain('何も保存していません');
    noSecret([...A.says, ...A.fails, bad.text, ok.text]);
    expect(A.fails.join('\n')).not.toContain('wrong/');
    // 欄が足りない
    expect((await A.sf.testRemote({ ...FORM, secretAccessKey: ' ' })).text).toContain('シークレットアクセスキー');
    expect((await A.sf.testRemote({ ...FORM, prefix: '/pkc3/' })).text).toContain('先頭に /');
  });

  it('🔴 書く間に別の端末が同じファイルを書いた(412)── 上書きせずに止まり、相手の中身が残る', async () => {
    let race = false;
    const s3 = fakeS3(SECRET, {
      beforePut: (key) => {
        if (!race) return;
        race = false;
        s3.objects.set(key, { body: new TextEncoder().encode('相手が書いた'), etag: '"other"', mtime: new Date().toISOString() });
      },
    });
    const A = await rig('A', s3);
    await A.d.put('n1', 'メモ', '本文');
    await A.sf.connectRemote(FORM);
    const B = await rig('B', s3);
    await B.sf.connectRemote(FORM); // 相手が居る = A は変わったら書く
    await A.sf.syncNow(false);
    await A.d.put('n1', 'メモ', '直した');
    race = true;
    await A.sf.syncNow(false);
    const key = `pkc3/${folderFileName(await deviceId(A.d))}`;
    expect(new TextDecoder().decode(s3.objects.get(key)!.body), '412 で上書きした').toBe('相手が書いた');
    expect(A.sf.view().phase).toBe('stopped');
    expect(A.sf.view().message).toContain('上書きしませんでした');
  });

  it('🔴 接続を外すと認証情報を消し、保管先のファイルは残す / フォルダへ切り替えても認証情報を消す', async () => {
    const s3 = fakeS3(SECRET);
    const A = await rig('A', s3);
    await A.d.put('n1', 'メモ', '本文');
    await A.sf.connectRemote(FORM);
    const files = s3.objects.size;
    await A.sf.stop();
    expect(await A.remote.ks.open(A.d.cid)).toBeNull();
    expect(A.store.map.size).toBe(0);
    expect(s3.objects.size, '保管先のファイルは消さない').toBe(files);
    expect(A.says.at(-1)).toContain('認証情報を消しました');
    expect(A.sf.view()).toMatchObject({ kind: null, phase: 'none' });
    // つなぎ直して、フォルダへ切り替える
    await A.sf.connectRemote(FORM);
    expect(await A.remote.ks.config(A.d.cid)).not.toBeNull();
    await A.sf.pick();
    expect(await A.remote.ks.open(A.d.cid), 'フォルダへ切り替えたら認証情報を消す').toBeNull();
    expect(A.sf.view()).toMatchObject({ kind: 'folder', folderName: '手元のフォルダ' });
    expect(A.store.map.get(A.d.cid)?.kind).toBeUndefined();
    // フォルダから保管先へ
    await A.sf.connectRemote(FORM);
    expect(A.sf.view().kind).toBe('s3');
    expect(A.says.some((t) => t.includes('同期フォルダをやめて'))).toBe(true);
  });

  it('📌 file:// では選べない(理由を言い、何も保存しない)/ 設定がオフなら接続しない', async () => {
    expect(remoteUnavailableReason({ protocol: 'file:' }, false)).toBe(SYNC_REMOTE_HTTPS_ONLY);
    expect(remoteUnavailableReason({ protocol: 'http:' }, false)).toBe(SYNC_REMOTE_HTTPS_ONLY);
    expect(remoteUnavailableReason({ protocol: 'https:' }, true)).toBeNull();
    expect(remoteUnavailableReason({ protocol: 'http:' }, true), '手元の localhost は安全な文脈').toBeNull();
    const s3 = fakeS3(SECRET);
    const A = await rig('A', s3, { unavailable: SYNC_REMOTE_HTTPS_ONLY });
    expect(A.sf.view().remoteUnavailable).toBe(SYNC_REMOTE_HTTPS_ONLY);
    expect(await A.sf.connectRemote(FORM)).toBe(false);
    expect(A.fails.at(-1)).toContain(SYNC_REMOTE_HTTPS_ONLY);
    expect(s3.seen.length, '通信しない').toBe(0);
    const B = await rig('B', s3);
    await B.d.setEnabled(false);
    expect(await B.sf.connectRemote(FORM)).toBe(false);
    expect(s3.seen.length, 'オフなら通信しない').toBe(0);
  });
});
