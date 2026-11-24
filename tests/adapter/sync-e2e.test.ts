/** @vitest-environment node */
/**
 * 🔴 **端末間の同期の暗号化(#2000 段 4b-A)── 実物の worker の端末 2 台 + 作り物の S3 / フォルダで、同期の回に通す**。
 *
 * 見る物:
 * - S3 は既定で暗号化 ── 置き場に平文のファイルが無く、暗号文に本文が無い。相手には届く
 * - 暗号化キーが開かれていなければ、**平文で書かずに止まる**
 * - 途中の切り替え(平文 → 暗号化): 自分の平文を暗号化して書き直し、書けたら平文を消す / 平文の相手には「その端末でも暗号化をオンにしてください」/
 *   暗号化していない側には「この端末でも暗号化をオンにしてください」(読めない相手のファイルは取り込まない)
 * - 🔴 巻き戻し(古い暗号文の差し戻し)・同じ連番の差し替え・平文への格下げは取り込まない(メッセージで知らせる)
 * - 🔴 パスフレーズ・回復キー・データ鍵の bytes が、暗号文・keyring.json・設定ファイル・差分 zip・メッセージ・同期の記録・localStorage・console のどこにも出ない
 * - 同期フォルダでも同じ層(既定オフ・`setFolderEncrypt(true)` で切り替え)
 */
import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EncryptedBox } from '../../src/adapter/platform/encrypted-box';
import {
  SyncFolder,
  SYNC_E2E_LOCKED_NOTE,
  type SyncFolderDirLike,
  type SyncFolderSaved,
  type SyncFolderStore,
  type SyncRemoteDeps,
  type SyncRemoteForm,
} from '../../src/adapter/platform/sync-folder';
import { S3Box, webSigCrypto } from '../../src/adapter/platform/s3-box';
import { SyncKeystore } from '../../src/adapter/platform/sync-keystore';
import { applySyncDiff, buildSyncDiff } from '../../src/adapter/ui/actions/sync-diff';
import { readDiffZip } from '../../src/features/sync/diff-file';
import { createKeyMaterial, openDataKey, type E2ECrypto } from '../../src/features/sync/e2e-crypto';
import { serializeKeyring } from '../../src/features/sync/keyring';
import { buildSettingsFile } from '../../src/features/settings/settings-file';
import { encFileName, folderFileName } from '../../src/features/sync/sync-folder';
import { fakeS3, type FakeS3 } from '../helpers/fake-s3';
import { memKeystoreBackend } from '../helpers/mem-keystore-backend';
import { spawnDevice, type SyncDevice } from '../helpers/sync-device';

const KEY_ID = 'AKIA-CANARY-ID-77';
const SECRET_KEY = 'canary/SECRET+key=Qz19';
const SECRET = { accessKeyId: KEY_ID, secretAccessKey: SECRET_KEY };
const FORM: SyncRemoteForm = { endpoint: 'https://s3.example.test/', bucket: ' my notes ', region: '', prefix: 'pkc3', accessKeyId: KEY_ID, secretAccessKey: SECRET_KEY };
const PASS = 'パスフレーズ-CANARY-φ-7731';
const NOTE_TEXT = '機密の本文 NOTE-CANARY-4242';

/** 乱数の口(出した bytes を控える ── 生のデータ鍵・回復キーの bytes を「漏れ」の探索に使う)。 */
function spyCrypto(): { c: E2ECrypto; issued: Map<number, Uint8Array[]> } {
  const issued = new Map<number, Uint8Array[]>();
  return {
    issued,
    c: {
      subtle: webcrypto.subtle as SubtleCrypto,
      random: (n) => {
        const a = webcrypto.getRandomValues(new Uint8Array(n));
        issued.set(n, [...(issued.get(n) ?? []), new Uint8Array(a)]);
        return a;
      },
    },
  };
}

class MemStore implements SyncFolderStore {
  map = new Map<string, SyncFolderSaved>();
  async load(cid: string) {
    return (this.map.get(cid) as SyncFolderSaved | undefined) ?? null;
  }
  async save(cid: string, v: SyncFolderSaved) {
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

class FakeFolder implements SyncFolderDirLike {
  readonly name = 'クラウドの同期フォルダ';
  files = new Map<string, { blob: Blob; mtime: number }>();
  clock = 1000;
  async *values(): AsyncIterable<{ kind: string; name: string }> {
    for (const name of [...this.files.keys()]) yield { kind: 'file', name };
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name) && options?.create !== true) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const folder = this;
    return {
      kind: 'file' as const,
      name,
      getFile: async (): Promise<File> => new File([folder.files.get(name)?.blob ?? new Blob([])], name, { lastModified: folder.files.get(name)?.mtime ?? 0 }),
      createWritable: async () => {
        const parts: Blob[] = [];
        return {
          write: async (d: Blob | string) => void parts.push(typeof d === 'string' ? new Blob([d]) : d),
          close: async () => void folder.files.set(name, { blob: new Blob(parts), mtime: ++folder.clock }),
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
    return 'granted';
  }
}

interface Rig {
  d: SyncDevice;
  sf: SyncFolder;
  store: MemStore;
  ks: SyncKeystore;
  remote: SyncRemoteDeps;
  says: string[];
  fails: string[];
}

const devices: SyncDevice[] = [];
afterEach(async () => {
  for (const d of devices.splice(0)) await d.close().catch(() => undefined);
  vi.restoreAllMocks();
});

/** 端末 1 台。`e2e: false` = 暗号化の口を渡さない(旧い動き = 平文)。同じ端末(`d` / `ks` / `store`)で作り直せる(開き直し・切り替え)。 */
async function rig(
  name: string,
  s3: FakeS3,
  opts: { e2e?: E2ECrypto | false; d?: SyncDevice; ks?: SyncKeystore; store?: MemStore; folder?: FakeFolder } = {},
): Promise<Rig> {
  const d = opts.d ?? (await spawnDevice(name));
  if (opts.d === undefined) {
    devices.push(d);
    await d.setEnabled(true);
  }
  const ks = opts.ks ?? new SyncKeystore(memKeystoreBackend());
  const store = opts.store ?? new MemStore();
  const remote: SyncRemoteDeps = {
    unavailable: () => null,
    open: (cid) => ks.open(cid),
    save: (cid, c, sec) => ks.save(cid, c, sec),
    remove: (cid) => ks.remove(cid),
    box: (config, secret) => new S3Box({ config, secret, crypto: webSigCrypto(), fetch: s3.fetch }),
  };
  const says: string[] = [];
  const fails: string[] = [];
  const c = opts.e2e === false ? null : (opts.e2e ?? { subtle: webcrypto.subtle as SubtleCrypto, random: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)) });
  const sf = new SyncFolder({
    cid: () => d.cid,
    enabled: () => d.enabled,
    picker: async () => opts.folder ?? new FakeFolder(),
    remote,
    ...(c === null ? {} : { e2e: { crypto: c, key: (cid: string) => ks.openDataKey(cid).then((v) => (v === null ? null : { dataKey: v.key, keyId: v.keyId })) } }),
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
  return { d, sf, store, ks, remote, says, fails };
}

const titles = async (d: SyncDevice): Promise<string[]> => (await d.request({ op: 'listEntryMetas', cid: d.cid })).map((m) => m.title).sort();
const deviceId = async (d: SyncDevice): Promise<string> => (await d.request({ op: 'syncSnapshot', cid: d.cid, ensureDevice: true })).device as string;
const s3Config = (): Parameters<typeof S3Box.prototype.list>[0] extends never ? never : ConstructorParameters<typeof S3Box>[0]['config'] => ({
  kind: 's3',
  endpoint: 'https://s3.example.test',
  bucket: 'my notes',
  region: 'auto',
  prefix: 'pkc3/',
});
const rawBox = (s3: FakeS3): S3Box => new S3Box({ config: s3Config(), secret: SECRET, crypto: webSigCrypto(), fetch: s3.fetch });

/** 最初の端末が暗号化キーを作って束を置き、自分の端末に置く。 */
async function provisionFirst(r: Rig, s3: FakeS3, c: E2ECrypto = { subtle: webcrypto.subtle as SubtleCrypto, random: (n) => webcrypto.getRandomValues(new Uint8Array(n)) }) {
  const km = await createKeyMaterial(c, PASS);
  const got = await new EncryptedBox({ inner: rawBox(s3), crypto: c, key: null }).ensureKeyring(km.keyring);
  expect(got.created).toBe(true);
  await r.ks.saveDataKey(r.d.cid, { keyId: km.keyring.keyId, key: km.dataKey });
  return km;
}
/** 2 台目以降: 置き場の束を読み、パスフレーズで開いて自分の端末に置く。 */
async function provisionNext(r: Rig, s3: FakeS3): Promise<void> {
  const c: E2ECrypto = { subtle: webcrypto.subtle as SubtleCrypto, random: (n) => webcrypto.getRandomValues(new Uint8Array(n)) };
  const have = (await new EncryptedBox({ inner: rawBox(s3), crypto: c, key: null }).loadKeyring())!;
  const k = await openDataKey(c, have.keyring, { passphrase: PASS });
  await r.ks.saveDataKey(r.d.cid, { keyId: k.keyId, key: k.dataKey });
}

describe('S3 互換(既定で暗号化)', () => {
  it('🔴 置き場に平文のファイルが無い・暗号文に本文が無い / 相手には届く / 暗号化キーを開かないと平文で書かずに止まる', async () => {
    const s3 = fakeS3(SECRET);
    const A = await rig('A', s3);
    const B = await rig('B', s3);
    await A.d.put('n1', 'メモ', NOTE_TEXT);
    // 暗号化キーがまだ無い ── 平文で書かない
    expect(await A.sf.connectRemote(FORM)).toBe(true);
    expect(A.sf.view().phase).toBe('stopped');
    expect(A.fails).toContain(SYNC_E2E_LOCKED_NOTE);
    expect([...s3.objects.keys()], '何も置かれていない(平文も)').toEqual([]);

    await provisionFirst(A, s3);
    await provisionNext(B, s3);
    await A.sf.syncNow(true);
    expect(A.sf.view().phase).toBe('idle');
    const aDev = await deviceId(A.d);
    expect([...s3.objects.keys()].sort(), '暗号化したファイルと keyring.json だけ').toEqual([`pkc3/${encFileName(aDev)}`, 'pkc3/keyring.json'].sort());
    const stored = Buffer.from(s3.objects.get(`pkc3/${encFileName(aDev)}`)!.body);
    expect(stored.includes(Buffer.from(NOTE_TEXT))).toBe(false);
    expect(stored.subarray(0, 8).toString()).toBe('PKC3E2E1');

    expect(await titles(B.d), '対照群: B にはまだ無い').toEqual([]);
    expect(await B.sf.connectRemote(FORM)).toBe(true);
    expect(B.fails).toEqual([]);
    expect(await titles(B.d)).toEqual(['メモ']);
    // 無人の回でも双方向に届く
    await B.d.put('n2', 'B のメモ', 'b');
    await B.sf.syncNow(false);
    await A.sf.syncNow(false);
    expect(await titles(A.d)).toEqual(['B のメモ', 'メモ']);
    expect(A.fails.filter((f) => f !== SYNC_E2E_LOCKED_NOTE)).toEqual([]);
  });

  it('🔴 暗号化の既定は S3 = オン / 口(deps.e2e)が無ければ従来どおり平文(段 4a の挙動のまま)', async () => {
    const s3 = fakeS3(SECRET);
    const A = await rig('A', s3, { e2e: false });
    await A.d.put('n1', 'メモ', NOTE_TEXT);
    await A.sf.connectRemote(FORM);
    expect([...s3.objects.keys()]).toEqual([`pkc3/${folderFileName(await deviceId(A.d))}`]);
  });
});

describe('🔴 途中の切り替え(平文 → 暗号化)', () => {
  it('自分の平文を暗号化して書き直し、書けたら平文を消す / 平文の相手には案内を出し、そのファイルは読む / 暗号化していない側には案内を出し、読まない', async () => {
    const s3 = fakeS3(SECRET);
    const A0 = await rig('A', s3, { e2e: false });
    const B0 = await rig('B', s3, { e2e: false });
    await A0.d.put('n1', 'A の既存メモ', 'a');
    await B0.d.put('n2', 'B の既存メモ', 'b');
    await A0.sf.connectRemote(FORM);
    await B0.sf.connectRemote(FORM);
    await A0.sf.syncNow(true);
    const aDev = await deviceId(A0.d);
    const bDev = await deviceId(B0.d);
    expect([...s3.objects.keys()].sort(), '対照群: 最初は両方とも平文').toEqual([`pkc3/${folderFileName(aDev)}`, `pkc3/${folderFileName(bDev)}`].sort());

    // A だけ暗号化をオンにする(同じ端末・同じ記録で開き直す)
    const A = await rig('A', s3, { d: A0.d, ks: A0.ks, store: A0.store });
    await provisionFirst(A, s3);
    await A.d.put('n3', 'A の新しいメモ', 'a2');
    await A.sf.boot();
    await A.sf.syncNow(true);
    const keys = [...s3.objects.keys()].sort();
    expect(keys, 'A の平文は消え、暗号化したファイルに替わった(B の平文はそのまま)').toEqual(
      [`pkc3/${encFileName(aDev)}`, `pkc3/${folderFileName(bDev)}`, 'pkc3/keyring.json'].sort(),
    );
    expect(A.fails).toEqual([]);
    const guide = 'その端末でも暗号化をオンにしてください';
    expect(A.says.join('\n'), '平文の相手 B への案内').toContain(guide);
    expect(A.sf.view().message).toContain(guide);
    expect(await titles(A.d), '平文の相手のファイルも読んだ').toEqual(['A の新しいメモ', 'A の既存メモ', 'B の既存メモ'].sort());

    // B(まだ平文)── A の暗号化したファイルは読めない。案内を出し、取り込まない
    await B0.sf.syncNow(true);
    expect(B0.sf.view().message).toContain('この端末でも暗号化をオンにしてください');
    expect(B0.says.join('\n')).toContain('この端末でも暗号化をオンにしてください');
    expect(await titles(B0.d), 'A の新しいメモは届いていない(読めない)').not.toContain('A の新しいメモ');

    // B も暗号化をオンにする ── B の平文が消え、A の新しいメモが届く
    const B = await rig('B', s3, { d: B0.d, ks: B0.ks, store: B0.store });
    await provisionNext(B, s3);
    await B.sf.boot();
    await B.sf.syncNow(true);
    expect([...s3.objects.keys()].sort()).toEqual([`pkc3/${encFileName(aDev)}`, `pkc3/${encFileName(bDev)}`, 'pkc3/keyring.json'].sort());
    expect(await titles(B.d)).toContain('A の新しいメモ');
    await A.sf.syncNow(true);
    expect(A.sf.view().message, '全員が暗号化したら案内は消える').toBeNull();
  });
});

describe('🔴 巻き戻し・差し替え・格下げの拒否', () => {
  async function pair() {
    const s3 = fakeS3(SECRET);
    const A = await rig('A', s3);
    const B = await rig('B', s3);
    await provisionFirst(A, s3);
    await provisionNext(B, s3);
    await A.d.put('n1', 'v1 のメモ', 'v1');
    await A.sf.connectRemote(FORM);
    await B.sf.connectRemote(FORM);
    const aDev = await deviceId(A.d);
    return { s3, A, B, aDev, aKey: `pkc3/${encFileName(aDev)}` };
  }
  const rollbackWord = '取り込み済みのものより古い';

  it('古い暗号文の差し戻しは取り込まない(新しい物はそのまま・メッセージで知らせる)', async () => {
    const { s3, A, B, aKey } = await pair();
    await A.sf.syncNow(true);
    const old = new Uint8Array(s3.objects.get(aKey)!.body); // seq N
    await B.sf.syncNow(true);
    expect(await titles(B.d)).toEqual(['v1 のメモ']);
    await A.d.put('n1', 'v2 のメモ', 'v2');
    await A.d.put('n9', '追加', 'x');
    await A.sf.syncNow(true); // seq N+1 以上
    await B.sf.syncNow(true);
    expect(await titles(B.d), '対照群: 新しい物は取り込まれた').toEqual(['v2 のメモ', '追加']);
    const newer = new Uint8Array(s3.objects.get(aKey)!.body);
    expect(Buffer.from(old).equals(Buffer.from(newer)), '空振り防止: 古い暗号文と新しい暗号文は別物').toBe(false);

    // 古い暗号文を差し戻す(攻撃者が置き場へ書く)
    s3.objects.set(aKey, { body: old, etag: '"rolled-back"', mtime: new Date().toISOString() });
    B.fails.length = 0;
    await B.sf.syncNow(false);
    expect(B.fails.join('\n')).toContain(rollbackWord);
    expect(await titles(B.d), '古い内容(v1 だけ)に戻されていない').toEqual(['v2 のメモ', '追加']);
    // 手で同期して読み直しても同じ(拒否は永続した記録に基づく ── 開き直しても)
    const B2 = await rig('B', s3, { d: B.d, ks: B.ks, store: B.store });
    await B2.sf.boot();
    await B2.sf.syncNow(true);
    expect(B2.fails.join('\n')).toContain(rollbackWord);
    expect(await titles(B.d)).toEqual(['v2 のメモ', '追加']);
  });

  it('同じ連番で中身(版)が違う物は取り込まない / 同じ版なら読み直しても受ける', async () => {
    const { s3, A, B, aKey } = await pair();
    await A.sf.syncNow(true);
    await B.sf.syncNow(true);
    const body = s3.objects.get(aKey)!.body;
    // 同じ暗号文を別の版(ETag)で置き直す = 同じ連番・版だけ違う
    s3.objects.set(aKey, { body, etag: '"replaced"', mtime: new Date().toISOString() });
    B.fails.length = 0;
    await B.sf.syncNow(false);
    expect(B.fails.join('\n')).toContain('連番が同じで中身が違う');
    // 手で読み直しても、版が違うままなら拒否が続く / 版が元に戻れば(同じ連番・同じ版)受ける
    B.fails.length = 0;
    await B.sf.syncNow(true);
    expect(B.fails.join('\n')).toContain('連番が同じで中身が違う');
    const orig = B.store.map.get(B.d.cid)!.record.peerSeq[await deviceId(A.d)]!;
    s3.objects.set(aKey, { body, etag: orig.version!, mtime: new Date().toISOString() });
    B.fails.length = 0;
    await B.sf.syncNow(true);
    expect(B.fails, '同じ連番・同じ版は受ける').toEqual([]);
  });

  it('暗号化していた相手が平文のファイルに戻っていたら(格下げ)取り込まない', async () => {
    const { s3, A, B, aDev, aKey } = await pair();
    await A.sf.syncNow(true);
    await B.sf.syncNow(true);
    expect(await titles(B.d)).toEqual(['v1 のメモ']);
    // 攻撃者が A の暗号化したファイルを消し、平文のファイルを置く
    s3.objects.delete(aKey);
    await new S3Box({ config: s3Config(), secret: SECRET, crypto: webSigCrypto(), fetch: s3.fetch }).write(folderFileName(aDev), new Blob(['PK-fake-plain']), null);
    B.fails.length = 0;
    await B.sf.syncNow(true);
    expect(B.fails.join('\n')).toContain('以前は暗号化したファイルを置いていましたが');
    expect(await titles(B.d)).toEqual(['v1 のメモ']);
  });

  it('別の暗号化キーで書かれたファイル・改ざんされたファイルは取り込まず、字に秘密を混ぜない', async () => {
    const { s3, A, B, aKey } = await pair();
    await A.sf.syncNow(true);
    await B.sf.syncNow(true);
    expect(await titles(B.d), '対照群: 最初の物は取り込んだ').toEqual(['v1 のメモ']);
    await A.d.put('n5', '二つ目', 'x');
    await A.sf.syncNow(true);
    const good = new Uint8Array(s3.objects.get(aKey)!.body);
    const bad = new Uint8Array(good);
    bad[bad.length - 1]! ^= 1;
    s3.objects.set(aKey, { body: bad, etag: '"tampered"', mtime: new Date().toISOString() });
    await B.sf.syncNow(true);
    expect(B.fails.join('\n')).toContain('改ざん');
    expect(await titles(B.d), '改ざんされた物は取り込まない').toEqual(['v1 のメモ']);
    for (const f of B.fails) for (const s of [PASS, KEY_ID, SECRET_KEY]) expect(f).not.toContain(s);
  });
});

describe('同期フォルダ(既定オフ・同じ層)', () => {
  it('既定は平文 / setFolderEncrypt(true) で自分のファイルを暗号化して書き直し、平文を消す / 記録に残り開き直しても続く', async () => {
    const s3 = fakeS3(SECRET);
    const folder = new FakeFolder();
    const A = await rig('A', s3, { folder });
    const B = await rig('B', s3, { folder });
    await A.d.put('n1', 'フォルダのメモ', NOTE_TEXT);
    await A.sf.pick();
    await B.sf.pick();
    const aDev = await deviceId(A.d);
    await A.sf.syncNow(true);
    expect([...folder.files.keys()].sort(), '既定は平文').toEqual([folderFileName(aDev), folderFileName(await deviceId(B.d))].sort());

    // 暗号化キーを作って置き(フォルダには keyring.json)、A だけオンにする
    const c = { subtle: webcrypto.subtle as SubtleCrypto, random: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)) };
    const { folderBox } = await import('../../src/adapter/platform/sync-box');
    const km = await createKeyMaterial(c, PASS);
    const got = await new EncryptedBox({ inner: folderBox(folder), crypto: c, key: null }).ensureKeyring(km.keyring);
    expect(got.created).toBe(true);
    await A.ks.saveDataKey(A.d.cid, { keyId: km.keyring.keyId, key: km.dataKey });
    await A.sf.setFolderEncrypt(true);
    expect(A.store.map.get(A.d.cid)!.encrypt, '記録(IndexedDB)に残る').toBe(true);
    await A.d.put('n2', '二つ目', 'x');
    await A.sf.syncNow(true);
    expect(A.fails).toEqual([]);
    expect([...folder.files.keys()].sort()).toEqual([encFileName(aDev), folderFileName(await deviceId(B.d)), 'keyring.json'].sort());
    const stored = Buffer.from(await folder.files.get(encFileName(aDev))!.blob.arrayBuffer());
    expect(stored.includes(Buffer.from(NOTE_TEXT))).toBe(false);
    expect(A.says.join('\n')).toContain('その端末でも暗号化をオンにしてください');

    // 開き直しても暗号化のまま
    const A2 = await rig('A', s3, { d: A.d, ks: A.ks, store: A.store, folder });
    await A2.sf.boot();
    await A2.sf.syncNow(true);
    expect(A2.sf.view().phase).toBe('idle');
    expect([...folder.files.keys()]).toContain(encFileName(aDev));
    expect([...folder.files.keys()], '平文を書き戻していない').not.toContain(folderFileName(aDev));
  });
});

describe('🔴 秘密が 1 バイトも出ない(パスフレーズ・回復キー・データ鍵の bytes)', () => {
  /** 探す字(各種の符号化)。 */
  function needles(passphrase: string, recoveryKey: string, raws: Uint8Array[]): { label: string; bytes: Buffer }[] {
    const out: { label: string; bytes: Buffer }[] = [
      { label: 'パスフレーズ', bytes: Buffer.from(passphrase) },
      { label: '回復キー', bytes: Buffer.from(recoveryKey) },
      { label: '回復キー(ハイフン無し)', bytes: Buffer.from(recoveryKey.replace(/-/g, '')) },
      { label: '回復キー(小文字)', bytes: Buffer.from(recoveryKey.toLowerCase()) },
    ];
    for (const r of raws) {
      const b = Buffer.from(r);
      out.push({ label: '生のデータ鍵', bytes: b }, { label: '生のデータ鍵(hex)', bytes: Buffer.from(b.toString('hex')) }, { label: '生のデータ鍵(base64)', bytes: Buffer.from(b.toString('base64')) }, { label: '生のデータ鍵(base64url)', bytes: Buffer.from(b.toString('base64url')) });
    }
    return out;
  }
  const leaks = (hay: Uint8Array | string, ns: { label: string; bytes: Buffer }[]): string[] => {
    const h = typeof hay === 'string' ? Buffer.from(hay) : Buffer.from(hay);
    return ns.filter((n) => h.includes(n.bytes)).map((n) => n.label);
  };

  it('探索自体が効く(対照群): 秘密を含む物は必ず見つかる', () => {
    const ns = needles('PASSX', 'ABCD-EFGH', [new Uint8Array(32).fill(7)]);
    expect(leaks('xx PASSX yy', ns)).toEqual(['パスフレーズ']);
    expect(leaks('abcd-efgh', ns)).toEqual(['回復キー(小文字)']);
    expect(leaks(new Uint8Array(32).fill(7), ns)).toContain('生のデータ鍵');
    expect(leaks(Buffer.from(new Uint8Array(32).fill(7)).toString('base64url'), ns)).toContain('生のデータ鍵(base64url)');
    expect(leaks('何も無い', ns)).toEqual([]);
  });

  it('暗号文・keyring.json・設定ファイル・差分 zip・メッセージ・同期の記録・localStorage・console のどこにも出ない', async () => {
    // localStorage / sessionStorage / console の記録
    const stored: string[] = [];
    const fakeStorage = (): Storage => ({ setItem: (k: string, v: string) => void stored.push(`${k}=${v}`), getItem: () => null, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 }) as Storage;
    const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
    const before = { l: g.localStorage, s: g.sessionStorage };
    g.localStorage = fakeStorage();
    g.sessionStorage = fakeStorage();
    const logged: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' ')));
    try {
      const { c, issued } = spyCrypto();
      const s3 = fakeS3(SECRET);
      const A = await rig('A', s3, { e2e: c });
      const B = await rig('B', s3, { e2e: c });
      const km = await provisionFirst(A, s3, c);
      // 回復キーを使った開き方も通す(別の端末は回復キーで開く)
      const have = (await new EncryptedBox({ inner: rawBox(s3), crypto: c, key: null }).loadKeyring())!;
      const k = await openDataKey(c, have.keyring, { recoveryKey: km.recoveryKey });
      await B.ks.saveDataKey(B.d.cid, { keyId: k.keyId, key: k.dataKey });
      await A.d.put('n1', 'メモ', NOTE_TEXT);
      await A.sf.connectRemote(FORM);
      await B.sf.connectRemote(FORM);
      await B.d.put('n2', 'B', 'b');
      await B.sf.syncNow(true);
      await A.sf.syncNow(true);
      expect(await titles(A.d), '空振り防止: 暗号化の同期が実際に通った').toEqual(['B', 'メモ']);

      const raws = issued.get(32) ?? [];
      expect(raws.length, '空振り防止: 生のデータ鍵の bytes を控えている').toBe(1);
      expect(raws[0]!.some((x) => x !== 0)).toBe(true);
      const ns = needles(PASS, km.recoveryKey, raws);

      const hay: [string, Uint8Array | string][] = [];
      for (const [key, o] of s3.objects) hay.push([`置き場 ${key}`, o.body]);
      expect(s3.objects.has('pkc3/keyring.json')).toBe(true);
      hay.push(['keyring.json(組み立て)', serializeKeyring(km.keyring)]);
      hay.push(['メッセージ', [...A.says, ...A.fails, ...B.says, ...B.fails, ...A.d.failures, ...B.d.failures, ...A.d.messages.map((m) => m.text), JSON.stringify(A.sf.view()), JSON.stringify(B.sf.view())].join('\n')]);
      hay.push(['同期の記録', JSON.stringify([...A.store.map.entries(), ...B.store.map.entries()])]);
      hay.push(['localStorage / sessionStorage への書き込み', stored.join('\n')]);
      hay.push(['console', logged.join('\n')]);
      // 設定ファイル(書き出しを実際に走らせる。localStorage の中身が読める形で)
      hay.push(['設定ファイル', JSON.stringify(buildSettingsFile((key) => (g.localStorage as Storage).getItem(key)))]);
      // 差分 zip(読み戻した中身を字にして探す ── 圧縮の中は見えないので)
      const zip = await buildSyncDiff(A.d.deps(), { kind: 'download', all: true });
      if (zip.skipped) throw new Error('差分 zip が作られていない');
      hay.push(['差分 zip(生)', new Uint8Array(await zip.blob.arrayBuffer())]);
      hay.push(['差分 zip(読み戻し)', JSON.stringify(await readDiffZip(zip.blob))]);
      hay.push(['鍵の置き場の中身(接続情報・メッセージを除く dump)', JSON.stringify((await A.ks.config(A.d.cid)) ?? {})]);

      for (const [label, h] of hay) expect(leaks(h, ns), `${label} に秘密が出ている`).toEqual([]);
      expect(stored, 'localStorage / sessionStorage には 1 度も書いていない').toEqual([]);
      // 空振り防止: 見たものが空でない
      expect(hay.find(([l]) => l.startsWith('置き場'))![1].length).toBeGreaterThan(100);
      expect((hay.find(([l]) => l === 'メッセージ')![1] as string).length).toBeGreaterThan(0);
      // 空振り防止: 保管したデータ鍵は取り出せない
      const dk = await A.ks.openDataKey(A.d.cid);
      expect(dk!.key.extractable).toBe(false);
      await expect(A.ks.saveDataKey(A.d.cid, { keyId: 'x', key: (await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])) as CryptoKey })).rejects.toThrow('取り出せる');
    } finally {
      g.localStorage = before.l;
      g.sessionStorage = before.s;
    }
  });
});
