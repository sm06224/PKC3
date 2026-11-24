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
import { writeArchive } from '../../src/features/export/pkc3-archive';
import { readZipDirectory, readZipEntry } from '../../src/features/import/zip-reader';
import { readDiffZip } from '../../src/features/sync/diff-file';
import { createKeyMaterial, decryptDiff, derivePassphraseKek, formatRecoveryKey, openDataKey, type E2ECrypto } from '../../src/features/sync/e2e-crypto';
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

  it('🔴 暗号化の既定は S3 = オン / 口(deps.e2e)が無ければ従来どおり平文(段 4a の挙動のまま。段 4b-B で口を配線するとき、ここは「口が無ければ止まる(fail-closed)」に変わる)', async () => {
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
    // B(まだ平文)が、A の暗号化の前に平文で新しいメモを置く
    await B0.d.put('n4', 'B の平文の新しいメモ', 'b2');
    await B0.sf.syncNow(true);
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
    expect(await titles(A.d), '🔴 暗号化している間は、平文の相手の新しいファイルを取り込まない(前に取り込んだ物はそのまま)').toEqual(['A の新しいメモ', 'A の既存メモ', 'B の既存メモ'].sort());
    const guided = A.says.filter((t) => t.includes(guide)).length;
    await A.sf.syncNow(false);
    await A.sf.syncNow(false);
    expect(A.says.filter((t) => t.includes(guide)).length, '同じ版の平文には、案内を言い直さない').toBe(guided);
    expect(A.sf.view().message, '案内は画面の状態には出し続ける').toContain(guide);

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
    expect(await titles(A.d), 'B が暗号化したら、B の新しいメモも届く').toContain('B の平文の新しいメモ');
    expect(A.sf.view().message, '全員が暗号化したら案内は消える').toBeNull();
  });
});

describe('🔴 暗号化をオフに戻したら、取り込まなかった平文を読む', () => {
  it('暗号化オン → 平文の相手を取り込まない → オフに戻す → 次の無人の回で取り込む(案内の記録が控えを塞がない)', async () => {
    const s3 = fakeS3(SECRET);
    const A0 = await rig('A', s3, { e2e: false });
    const B0 = await rig('B', s3, { e2e: false });
    await A0.d.put('n1', 'A のメモ', 'a');
    await A0.sf.connectRemote(FORM);
    await B0.sf.connectRemote(FORM);
    await B0.d.put('n2', 'B の新しいメモ', 'b');
    await B0.sf.syncNow(true); // B の平文に新しいメモが載る
    const A = await rig('A', s3, { d: A0.d, ks: A0.ks, store: A0.store });
    await provisionFirst(A, s3);
    await A.sf.boot();
    await A.sf.syncNow(true);
    expect(await titles(A.d), '暗号化している間は取り込まない').not.toContain('B の新しいメモ');
    const saved = A.store.map.get(A.d.cid)!.record;
    expect(Object.keys(saved.seen).filter((n) => !n.endsWith('.enc')), '平文は控え(seen)に入っていない').toEqual([]);
    expect(Object.keys(saved.guided ?? {}), '案内した記録は別に在る').toHaveLength(1);
    // 暗号化をオフに戻す(口を渡さない = 平文)── 無人の回で読む
    const A2 = await rig('A', s3, { e2e: false, d: A.d, ks: A.ks, store: A.store });
    await A2.sf.boot(); // 起動の回(無人 = 手で押していない)
    for (let i = 0; i < 200 && A2.sf.view().lastAt === null; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(A2.sf.view().lastAt, '空振り防止: 起動の無人の回が実際に終わった').not.toBeNull();
    expect(await titles(A2.d), '次の無人の回で取り込まれた').toContain('B の新しいメモ');
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

  it('🔴 同じ連番で中身が違う物は取り込まない / 中身が同じで ETag だけ変わった物は受ける', async () => {
    const { s3, A, B, aKey } = await pair();
    await A.sf.syncNow(true);
    await B.sf.syncNow(true);
    const body = s3.objects.get(aKey)!.body;
    // 同じ暗号文を別の版(ETag)で置き直す = クラウドの再書き込み。中身は同じなので受ける
    s3.objects.set(aKey, { body, etag: '"touched"', mtime: new Date().toISOString() });
    B.fails.length = 0;
    await B.sf.syncNow(true);
    expect(B.fails, '中身が同じなら、版だけ違っても断らない').toEqual([]);
    // 同じ連番で、別の暗号文(別の nonce・別の中身)を置く = 差し替え
    const { readEncHeader, encryptDiff } = await import('../../src/features/sync/e2e-crypto');
    const seq = (await readEncHeader(new Blob([body as Uint8Array<ArrayBuffer>]))).header.seq;
    const dk = (await A.ks.openDataKey(A.d.cid))!;
    const forged = await encryptDiff(
      { subtle: webcrypto.subtle as SubtleCrypto, random: (n) => webcrypto.getRandomValues(new Uint8Array(n)) },
      new Blob(['PK-different']),
      { dataKey: dk.key, keyId: dk.keyId, device: await deviceId(A.d), seq, name: encFileName(await deviceId(A.d)) },
    );
    s3.objects.set(aKey, { body: new Uint8Array(await forged.arrayBuffer()), etag: '"forged"', mtime: new Date().toISOString() });
    B.fails.length = 0;
    await B.sf.syncNow(true);
    expect(B.fails.join('\n')).toContain('連番が同じで中身が違う');
    expect(B.fails.join('\n'), '拒否の文言に救済の道が書いてある').toContain('受け入れ直してください');
  });

  it('🔴 受け入れ直す(acceptPeerAgain): 相手が古いバックアップから戻した → 拒否 → 受け入れ直すと取り込める', async () => {
    const { s3, A, B, aKey, aDev } = await pair();
    await A.sf.syncNow(true);
    const old = new Uint8Array(s3.objects.get(aKey)!.body);
    await A.d.put('n7', '新しい', 'x');
    await A.sf.syncNow(true);
    await B.sf.syncNow(true);
    expect(await titles(B.d)).toContain('新しい');
    s3.objects.set(aKey, { body: old, etag: '"restored"', mtime: new Date().toISOString() });
    B.fails.length = 0;
    await B.sf.syncNow(true);
    expect(B.fails.join('\n')).toContain('古い');
    expect(await B.sf.acceptPeerAgain('ffffffffffffffff'), '知らない相手は何も変えない').toBe(false);
    expect(await B.sf.acceptPeerAgain(aDev)).toBe(true);
    expect(B.store.map.get(B.d.cid)!.record.peerSeq[aDev], '読み直して、受け入れた連番に更新された').toBeDefined();
    expect(B.sf.view().phase).toBe('idle');
    expect(B.says.join('\n')).toContain('受け入れ直します');
  });

  it('🔴 暗号化していた相手が平文のファイルだけになっていても(格下げ)平文は取り込まない', async () => {
    const { s3, A, B, aDev, aKey } = await pair();
    await A.sf.syncNow(true);
    await B.sf.syncNow(true);
    expect(await titles(B.d)).toEqual(['v1 のメモ']);
    // 攻撃者が A の暗号化したファイルを消し、本物の平文の差分(本文入り)を置く
    s3.objects.delete(aKey);
    const P = await rig('P', fakeS3(SECRET), { e2e: false });
    await P.d.put('evil', '平文で差し込まれたメモ', 'evil');
    const plainBox = rawBox(s3);
    const built = await buildSyncDiff(P.d.deps(), { kind: 'download', all: true });
    if (built.skipped) throw new Error('作れていない');
    await plainBox.write(folderFileName(aDev), built.blob, null);
    B.fails.length = 0;
    B.says.length = 0;
    await B.sf.syncNow(true);
    expect(await titles(B.d), '平文は取り込まれない').toEqual(['v1 のメモ']);
    expect(B.says.join('\n')).toContain('その端末でも暗号化をオンにしてください');
  });

  it('🔴 置き場の keyring.json の keyId が、この端末で開いているキーと違えば、何も書かずに止まる', async () => {
    const { s3, A, B } = await pair();
    await A.sf.syncNow(true);
    const other = await createKeyMaterial({ subtle: webcrypto.subtle as SubtleCrypto, random: (n) => webcrypto.getRandomValues(new Uint8Array(n)) }, 'other-pass');
    s3.objects.set('pkc3/keyring.json', { body: new TextEncoder().encode(serializeKeyring(other.keyring)), etag: '"swapped"', mtime: new Date().toISOString() });
    await A.d.put('n8', '止まる前に書いた物', 'x');
    const puts = s3.seen.filter((r) => r.method === 'PUT').length;
    A.fails.length = 0;
    await A.sf.syncNow(true);
    await B.sf.syncNow(true);
    expect(s3.seen.filter((r) => r.method === 'PUT').length, '書いていない').toBe(puts);
    expect(A.sf.view().phase).toBe('stopped');
    expect(A.sf.view().message).toContain('keyring.json');
    expect(await titles(B.d)).not.toContain('止まる前に書いた物');
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

describe('🔴 切り替えの片付け(平文を消すのは、暗号化したファイルを書けた後だけ)', () => {
  /** A が平文で同期済み(B が居るので書く)→ A が暗号化をオンにして開き直す所まで。 */
  async function ready(over: Parameters<typeof fakeS3>[1] = {}, pre: (s3: FakeS3) => void = () => undefined) {
    const s3 = fakeS3(SECRET, over);
    const A0 = await rig('A', s3, { e2e: false });
    const B0 = await rig('B', s3, { e2e: false });
    await A0.d.put('n1', 'メモ', NOTE_TEXT);
    await A0.sf.connectRemote(FORM);
    await B0.sf.connectRemote(FORM);
    await A0.sf.syncNow(true);
    const aDev = await deviceId(A0.d);
    const A = await rig('A', s3, { d: A0.d, ks: A0.ks, store: A0.store });
    await provisionFirst(A, s3);
    pre(s3); // 開き直す(= 暗号化への切り替えの最初の回が走る)前に、失敗の仕掛けを入れる
    await A.sf.boot();
    await A.sf.syncNow(true); // 起動の回の終わりを待ち、もう 1 回(手で)回す
    return { s3, A, aDev, plainKey: `pkc3/${folderFileName(aDev)}`, encKey: `pkc3/${encFileName(aDev)}` };
  }

  const ctl = { mode: 'off' as 'off' | '412' | 'network' };
  const hook = (s3: () => FakeS3) => (key: string): void => {
    if (!key.endsWith('.enc')) return;
    if (ctl.mode === '412') s3().objects.set(key, { body: new TextEncoder().encode('相手が書いた'), etag: '"other"', mtime: new Date().toISOString() });
    if (ctl.mode === 'network') throw new TypeError('Failed to fetch');
  };
  const make = async (mode: 'off' | '412' | 'network', pre?: (s3: FakeS3) => void) => {
    ctl.mode = mode;
    let ref: FakeS3 | null = null;
    const r = await ready({ beforePut: hook(() => ref!) }, (s3) => {
      ref = s3;
      pre?.(s3);
    });
    return r;
  };

  it('🔴 暗号化したファイルの書き込みが 412 で止まった → 自分の平文は残る', async () => {
    const r = await make('412');
    expect(r.s3.objects.has(r.plainKey), '平文は残っている').toBe(true);
    expect(new TextDecoder().decode(r.s3.objects.get(r.encKey)!.body), '相手の物をそのまま').toBe('相手が書いた');
  });

  it('🔴 書き込みが通信エラーで失敗した → 自分の平文は残る / 直ったら暗号化して書き、平文を消す', async () => {
    const r = await make('network');
    expect(r.A.fails.length, '空振り防止: 失敗を言った').toBeGreaterThan(0);
    expect(r.s3.objects.has(r.plainKey)).toBe(true);
    expect(r.s3.objects.has(r.encKey)).toBe(false);
    ctl.mode = 'off';
    await r.A.sf.syncNow(true);
    expect(r.s3.objects.has(r.encKey)).toBe(true);
    expect(r.s3.objects.has(r.plainKey)).toBe(false);
  });

  it('🔴 平文を消せなくても同期は続く / 次の回でもう一度消す', async () => {
    let denyDelete = true;
    let deletes = 0;
    const r = await make('off', (s3) => {
      const real = s3.fetch;
      (s3 as { fetch: typeof real }).fetch = async (url, init) => {
        if (init.method === 'DELETE' && denyDelete) {
          deletes += 1;
          throw new TypeError('Failed to fetch');
        }
        return real(url, init);
      };
    });
    expect(deletes, '空振り防止: 消す操作が実際に失敗した').toBeGreaterThan(0);
    expect(r.s3.objects.has(r.encKey), '暗号化したファイルは書けている').toBe(true);
    expect(r.s3.objects.has(r.plainKey), '消せなかった平文が残っている').toBe(true);
    expect(r.A.sf.view().phase, '同期は止まらない').toBe('idle');
    expect(r.A.fails.filter((f) => f.includes('古いファイルを消す')), '消せなかったことで同期を失敗にしない').toEqual([]);
    denyDelete = false;
    await r.A.sf.syncNow(false);
    expect(r.s3.objects.has(r.plainKey), '次の回で消えた').toBe(false);
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

/** console の引数を字にする。⚠ Error は JSON.stringify だと `{}` になる ── String・message・stack を全部出す。 */
function showArg(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x instanceof Error) return [String(x), x.message, x.stack ?? ''].join('\n');
  try {
    return `${JSON.stringify(x) ?? ''} ${String(x)}`;
  } catch {
    return String(x);
  }
}

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
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(showArg).join(' ')));
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

      // 失敗の道(パスフレーズ違い・回復キーの字の誤り・弱い KDF・改ざん)のエラー文にも出ない
      const errs: string[] = [];
      const grab = async (p: Promise<unknown>): Promise<void> => {
        try {
          await p;
          errs.push('(通ってしまった)');
        } catch (e) {
          errs.push(showArg(e));
          console.error(e); // 呼び手が console へ出す場合も見る
        }
      };
      await grab(openDataKey(c, have.keyring, { passphrase: `${PASS}-wrong` }));
      await grab(openDataKey(c, have.keyring, { recoveryKey: `${km.recoveryKey}ZZZ` }));
      await grab(openDataKey(c, have.keyring, { recoveryKey: formatRecoveryKey(new Uint8Array(20)) }));
      await grab(derivePassphraseKek(c, PASS, new Uint8Array(16), 599999));
      await grab(derivePassphraseKek(c, '', new Uint8Array(16), 600000));
      const stored1 = [...s3.objects.entries()].find(([key]) => key.endsWith('.enc'))!;
      const tampered = new Uint8Array(stored1[1].body);
      tampered[tampered.length - 1]! ^= 1;
      const dkErr = (await A.ks.openDataKey(A.d.cid))!;
      await grab(decryptDiff(c, new Blob([tampered]), { dataKey: dkErr.key, keyId: dkErr.keyId, expectName: stored1[0].slice('pkc3/'.length), expectDevice: await deviceId(A.d) }));
      expect(errs.filter((e) => e === '(通ってしまった)'), '空振り防止: どの失敗の道も実際に失敗した').toEqual([]);
      expect(errs.join('\n')).toContain('パスフレーズまたは回復キーが違います');

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
      hay.push(['失敗の道のエラー文(String・message・stack)', errs.join('\n')]);
      // バックアップ(*.pkc3-full.zip の書き出しを実際に走らせる。圧縮の中は見えないので、読み戻した中身と生の bytes の両方)
      const backup = await writeArchive(
        {
          cid: A.d.cid,
          title: 'バックアップ',
          listEntryMetas: async () => (await A.d.request({ op: 'listEntryMetas', cid: A.d.cid })).map((m) => ({ lid: m.lid, title: m.title, archetype: m.archetype, created_at: null, updated_at: null, entry_order: 1, status: null, date: null, archived: 0 })),
          listBodies: async () => ({ rows: (await A.d.request({ op: 'getBodies', cid: A.d.cid, lids: ['n1'] })).map((r) => ({ lid: r.lid, body: r.body })), done: true }),
          listRelations: async () => [],
          listAssetMetas: async () => [],
          getAssetBlob: async () => null,
          listRevisionLids: async () => [],
          getRevisionChain: async () => [],
        },
        '2026-11-24T00:00:00.000Z',
      );
      expect(backup.counts.entries, '空振り防止: バックアップに実際にノートが入った').toBeGreaterThan(0);
      const dir = await readZipDirectory(backup.blob);
      const inside: string[] = [];
      for (const ent of dir) inside.push(await (await readZipEntry(backup.blob, ent)).text());
      expect(inside.join('\n'), '空振り防止: 読み戻した中身にノートの本文が見える').toContain(NOTE_TEXT);
      hay.push(['バックアップ(読み戻し)', inside.join('\n')], ['バックアップ(生)', new Uint8Array(await backup.blob.arrayBuffer())]);
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
