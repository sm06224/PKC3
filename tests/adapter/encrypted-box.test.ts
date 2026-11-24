/** @vitest-environment node */
/**
 * 🔴 **暗号化の層(EncryptedBox)と暗号化キーの束(keyring.json)の置き方**(#2000 段 4b-A)。
 *
 * 見る物(作り物の S3 は署名を独立に検算し、If-Match / If-None-Match / 412 を本物と同じに返す):
 * - 差分ファイルは暗号化して置く(置いた物に平文が無い・Content-Type は不透明なバイト列)/ 読むと復号される / 平文を黙って書かない
 * - keyring.json の**初回作成は `If-None-Match: *`**、**包み直しは `If-Match: <ETag>`**、412 は**上書きせずに止まる**
 * - 同時に 2 台が作った → 先に在った方を採る(自分の鍵は捨てる)。フォルダ(条件付き書き込みが無い)は書いたあと読み直して keyId を照らす
 */
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EncryptedBox, KeyringConflictError } from '../../src/adapter/platform/encrypted-box';
import { S3Box, webSigCrypto } from '../../src/adapter/platform/s3-box';
import { folderBox, type RemoteBox } from '../../src/adapter/platform/sync-box';
import { normalizeS3Config } from '../../src/adapter/platform/sync-keystore';
import { E2EError, createKeyMaterial, openDataKey, rewrapKeyring, type E2ECrypto, type OpenedKey } from '../../src/features/sync/e2e-crypto';
import { KeyringFormatError, serializeKeyring } from '../../src/features/sync/keyring';
import { encFileName, folderFileName } from '../../src/features/sync/sync-folder';
import { fakeS3, type FakeS3 } from '../helpers/fake-s3';

const c: E2ECrypto = { subtle: webcrypto.subtle as SubtleCrypto, random: (n) => webcrypto.getRandomValues(new Uint8Array(n)) };
const SECRET = { accessKeyId: 'AKIA-CANARY-ID-77', secretAccessKey: 'canary/SECRET+key=Qz19' };
const CONFIG = normalizeS3Config({ endpoint: 'https://s3.example.test/', bucket: 'my notes', region: '', prefix: 'pkc3' });
const DEV = '0123456789abcdef';
const NOTE = '機密のノート本文 CANARY-NOTE-TEXT';

const s3box = (s3: FakeS3): S3Box => new S3Box({ config: CONFIG, secret: SECRET, crypto: webSigCrypto(), fetch: s3.fetch });
const KEYRING_KEY = 'pkc3/keyring.json';
const puts = (s3: FakeS3, key: string) => s3.seen.filter((r) => r.method === 'PUT' && decodeURIComponent(new URL(r.url).pathname).endsWith(`/${key}`));

describe('差分ファイルの読み書き', () => {
  async function setup(): Promise<{ s3: FakeS3; box: EncryptedBox; key: OpenedKey; km: Awaited<ReturnType<typeof createKeyMaterial>> }> {
    const s3 = fakeS3(SECRET);
    const km = await createKeyMaterial(c, 'pass-1');
    const key: OpenedKey = { dataKey: km.dataKey, keyId: km.keyring.keyId };
    return { s3, box: new EncryptedBox({ inner: s3box(s3), crypto: c, key }), key, km };
  }

  it('🔴 暗号化して置く(置いた物に平文が無い)/ 読むと平文に戻り、認証済みの連番が付く', async () => {
    const { s3, box } = await setup();
    const name = encFileName(DEV);
    const w = await box.write(name, new Blob([NOTE]), null, { device: DEV, seq: 7 });
    expect(w.version, 'S3 の ETag が返る').toBeTruthy();
    const stored = s3.objects.get(`pkc3/${name}`)!.body;
    expect(Buffer.from(stored).toString('utf8')).not.toContain('CANARY-NOTE-TEXT');
    expect(Buffer.from(stored).includes(Buffer.from(NOTE))).toBe(false);
    expect(Buffer.from(stored).subarray(0, 8).toString()).toBe('PKC3E2E1');
    expect(puts(s3, `${'pkc3'}/${name}`)[0]!.headers['content-type']).toBe('application/octet-stream');
    const r = await box.readWithMeta(name);
    expect(await r.blob.text()).toBe(NOTE);
    expect(r.meta).toMatchObject({ device: DEV, seq: 7 });
    expect(r.meta?.contentId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await (await box.read(name)).text()).toBe(NOTE);
  });

  it('平文を黙って書かない(平文の名前・meta 無し・名前と端末の食い違い)/ 平文の名前の読みはそのまま通す', async () => {
    const { s3, box } = await setup();
    await expect(box.write(folderFileName(DEV), new Blob(['x']), null, { device: DEV, seq: 1 })).rejects.toBeInstanceOf(E2EError);
    await expect(box.write(encFileName(DEV), new Blob(['x']), null)).rejects.toBeInstanceOf(E2EError);
    await expect(box.write(encFileName(DEV), new Blob(['x']), null, { device: 'ffffffffffffffff', seq: 1 })).rejects.toBeInstanceOf(E2EError);
    expect([...s3.objects.keys()], '何も書かれていない').toEqual([]);
    await s3box(s3).write(folderFileName(DEV), new Blob(['plain-zip']), null);
    const r = await box.readWithMeta(folderFileName(DEV));
    expect(await r.blob.text()).toBe('plain-zip');
    expect(r.meta, '平文には認証済みの連番が無い').toBeNull();
  });

  it('暗号化キーが開かれていなければ locked で断る(束の読み書きだけはできる)', async () => {
    const { s3, key } = await setup();
    const locked = new EncryptedBox({ inner: s3box(s3), crypto: c, key: null });
    await expect(locked.write(encFileName(DEV), new Blob(['x']), null, { device: DEV, seq: 1 })).rejects.toMatchObject({ code: 'locked' });
    await new EncryptedBox({ inner: s3box(s3), crypto: c, key }).write(encFileName(DEV), new Blob(['x']), null, { device: DEV, seq: 1 });
    await expect(locked.read(encFileName(DEV))).rejects.toMatchObject({ code: 'locked' });
    expect(await locked.loadKeyring()).toBeNull();
  });

  it('別の名前へ差し替えられた暗号文は読まない', async () => {
    const { s3, box } = await setup();
    await box.write(encFileName(DEV), new Blob(['x']), null, { device: DEV, seq: 1 });
    const other = encFileName('ffffffffffffffff');
    s3.objects.set(`pkc3/${other}`, s3.objects.get(`pkc3/${encFileName(DEV)}`)!);
    await expect(box.read(other)).rejects.toMatchObject({ code: 'mismatch' });
  });
});

describe('🔴 keyring.json(S3)', () => {
  it('初回の作成は If-None-Match: * / Content-Type は JSON / 置いた物に秘密が無い', async () => {
    const s3 = fakeS3(SECRET);
    const km = await createKeyMaterial(c, 'pass-1');
    const box = new EncryptedBox({ inner: s3box(s3), crypto: c, key: null });
    expect(await box.loadKeyring()).toBeNull();
    const r = await box.ensureKeyring(km.keyring);
    expect(r).toEqual({ keyring: km.keyring, created: true });
    const p = puts(s3, KEYRING_KEY);
    expect(p).toHaveLength(1);
    expect(p[0]!.headers['if-none-match']).toBe('*');
    expect(p[0]!.headers['if-match']).toBeUndefined();
    expect(p[0]!.headers['content-type']).toBe('application/json');
    const text = Buffer.from(s3.objects.get(KEYRING_KEY)!.body).toString('utf8');
    expect(text).toBe(serializeKeyring(km.keyring));
    expect(text).not.toContain('pass-1');
    expect(text).not.toContain(km.recoveryKey.replace(/-/g, ''));
  });

  it('先に在れば作らず在った方を返す(自分の鍵は捨てる ── 上書きしない)', async () => {
    const s3 = fakeS3(SECRET);
    const first = await createKeyMaterial(c, 'pass-A');
    const second = await createKeyMaterial(c, 'pass-B');
    await new EncryptedBox({ inner: s3box(s3), crypto: c, key: null }).ensureKeyring(first.keyring);
    const before = Buffer.from(s3.objects.get(KEYRING_KEY)!.body).toString('utf8');
    const r = await new EncryptedBox({ inner: s3box(s3), crypto: c, key: null }).ensureKeyring(second.keyring);
    expect(r.created).toBe(false);
    expect(r.keyring.keyId).toBe(first.keyring.keyId);
    expect(Buffer.from(s3.objects.get(KEYRING_KEY)!.body).toString('utf8')).toBe(before);
    expect(puts(s3, KEYRING_KEY), 'PUT は最初の 1 回だけ').toHaveLength(1);
  });

  it('🔴 同時に作った(一覧で見たときは無く、書く直前に別の端末が作った)→ 412 で止まり、在った方を採る', async () => {
    const other = await createKeyMaterial(c, 'pass-A');
    const mine = await createKeyMaterial(c, 'pass-B');
    let injected = false;
    const s3 = fakeS3(SECRET, {
      beforePut: (key) => {
        if (key !== KEYRING_KEY || injected) return;
        injected = true;
        s3.objects.set(KEYRING_KEY, { body: new TextEncoder().encode(serializeKeyring(other.keyring)), etag: '"other"', mtime: new Date(0).toISOString() });
      },
    });
    const r = await new EncryptedBox({ inner: s3box(s3), crypto: c, key: null }).ensureKeyring(mine.keyring);
    expect(injected, '空振り防止: 競合が実際に起きた').toBe(true);
    expect(r.created).toBe(false);
    expect(r.keyring.keyId).toBe(other.keyring.keyId);
    expect(Buffer.from(s3.objects.get(KEYRING_KEY)!.body).toString('utf8')).toBe(serializeKeyring(other.keyring));
  });

  it('🔴 包み直しは If-Match: <ETag> / 新しいパスフレーズで開く / 同じ ETag で 2 度目は 412 で止まり上書きしない', async () => {
    const s3 = fakeS3(SECRET);
    const km = await createKeyMaterial(c, 'old');
    const box = new EncryptedBox({ inner: s3box(s3), crypto: c, key: null });
    await box.ensureKeyring(km.keyring);
    const cur = (await box.loadKeyring())!;
    expect(cur.version).toBeTruthy();
    const next = await rewrapKeyring(c, cur.keyring, { passphrase: 'old' }, 'new');
    const r = await box.rewrapKeyring(next, cur.version);
    const put = puts(s3, KEYRING_KEY).at(-1)!;
    expect(put.headers['if-match']).toBe(cur.version);
    expect(put.headers['if-none-match']).toBeUndefined();
    expect(r.version).not.toBe(cur.version);
    const stored = (await box.loadKeyring())!.keyring;
    expect(stored).toEqual(next);
    await openDataKey(c, stored, { passphrase: 'new' });
    await expect(openDataKey(c, stored, { passphrase: 'old' })).rejects.toMatchObject({ code: 'wrong-secret' });
  });

  it('🔴 包み直す間に別の端末が変えた(412)→ KeyringConflictError・上書きしない', async () => {
    let inject: (() => void) | null = null;
    const s3 = fakeS3(SECRET, { beforePut: (key) => key === KEYRING_KEY && inject?.() });
    const km = await createKeyMaterial(c, 'old');
    const box = new EncryptedBox({ inner: s3box(s3), crypto: c, key: null });
    await box.ensureKeyring(km.keyring);
    const base = (await box.loadKeyring())!.version;
    const mine = await rewrapKeyring(c, km.keyring, { passphrase: 'old' }, 'mine');
    const theirs = await rewrapKeyring(c, km.keyring, { passphrase: 'old' }, 'theirs');
    let raced = false;
    // 読んだ(一覧で ETag を見た)あと、PUT が届く直前に別の端末が書いた
    inject = () => {
      raced = true;
      s3.objects.set(KEYRING_KEY, { body: new TextEncoder().encode(serializeKeyring(theirs)), etag: '"theirs"', mtime: new Date(1).toISOString() });
    };
    await expect(box.rewrapKeyring(mine, base)).rejects.toBeInstanceOf(KeyringConflictError);
    expect(raced, '空振り防止: 競合が実際に起きた').toBe(true);
    expect(Buffer.from(s3.objects.get(KEYRING_KEY)!.body).toString('utf8'), '相手の書いた物がそのまま').toBe(serializeKeyring(theirs));
  });

  it('🔴 もとにした束を読んだあと・包み直している間に別の端末が変えた → 呼んだ時点で版が違うので PUT もせず止まる(読み直した新しい版で書かない)', async () => {
    const s3 = fakeS3(SECRET);
    const km = await createKeyMaterial(c, 'old');
    const box = new EncryptedBox({ inner: s3box(s3), crypto: c, key: null });
    await box.ensureKeyring(km.keyring);
    const cur = (await box.loadKeyring())!;
    const mine = await rewrapKeyring(c, cur.keyring, { passphrase: 'old' }, 'mine'); // cur から導出
    const theirs = await rewrapKeyring(c, cur.keyring, { passphrase: 'old' }, 'theirs');
    s3.objects.set(KEYRING_KEY, { body: new TextEncoder().encode(serializeKeyring(theirs)), etag: '"theirs"', mtime: new Date(1).toISOString() }); // 導出のあと、書く前に変わった
    const n = puts(s3, KEYRING_KEY).length;
    await expect(box.rewrapKeyring(mine, cur.version)).rejects.toBeInstanceOf(KeyringConflictError);
    expect(puts(s3, KEYRING_KEY), 'PUT していない').toHaveLength(n);
    expect(Buffer.from(s3.objects.get(KEYRING_KEY)!.body).toString('utf8')).toBe(serializeKeyring(theirs));
  });

  it('別の keyId の束・無い束は置き換えない(PUT もしない)', async () => {
    const s3 = fakeS3(SECRET);
    const a = await createKeyMaterial(c, 'a');
    const b = await createKeyMaterial(c, 'b');
    const box = new EncryptedBox({ inner: s3box(s3), crypto: c, key: null });
    await expect(box.rewrapKeyring(a.keyring, undefined)).rejects.toBeInstanceOf(E2EError); // 無い
    await box.ensureKeyring(a.keyring);
    const n = puts(s3, KEYRING_KEY).length;
    await expect(box.rewrapKeyring(b.keyring, undefined)).rejects.toBeInstanceOf(KeyringConflictError);
    expect(puts(s3, KEYRING_KEY)).toHaveLength(n);
  });

  it('大きすぎる keyring.json は、読み込む前に(一覧の大きさで)断る', async () => {
    const s3 = fakeS3(SECRET);
    await s3box(s3).write('keyring.json', new Blob(['x'.repeat(5000)]), null);
    await expect(new EncryptedBox({ inner: s3box(s3), crypto: c, key: null }).loadKeyring()).rejects.toBeInstanceOf(KeyringFormatError);
    expect(s3.seen.filter((r) => r.method === 'GET' && decodeURIComponent(new URL(r.url).pathname).endsWith('/keyring.json')), '本体を GET していない').toEqual([]);
  });

  it('壊れた keyring.json は KeyringFormatError(曖昧に読まない)', async () => {
    const s3 = fakeS3(SECRET);
    await s3box(s3).write('keyring.json', new Blob(['{"v":1}']), null);
    await expect(new EncryptedBox({ inner: s3box(s3), crypto: c, key: null }).loadKeyring()).rejects.toBeInstanceOf(KeyringFormatError);
  });
});

describe('🔴 keyring.json(同期フォルダ: 条件付き書き込みが無い)', () => {
  /** 共有のメモリのフォルダ。`afterWrite` は書き終えた直後に呼ぶ(= 書いた後に別の端末が上書きした、を作る)。 */
  function dirOf(files: Map<string, Blob>, afterWrite?: (name: string) => void) {
    return {
      name: 'folder',
      async *values() {
        for (const name of [...files.keys()]) yield { kind: 'file', name };
      },
      async getFileHandle(name: string, o?: { create?: boolean }) {
        if (!files.has(name) && o?.create !== true) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
        return {
          kind: 'file' as const,
          name,
          getFile: async () => new File([files.get(name) ?? new Blob([])], name, { lastModified: 1 }),
          createWritable: async () => {
            const parts: Blob[] = [];
            return {
              write: async (b: Blob | string) => void parts.push(typeof b === 'string' ? new Blob([b]) : b),
              close: async () => {
                files.set(name, new Blob(parts));
                afterWrite?.(name);
              },
            };
          },
        };
      },
      removeEntry: async (n: string) => void files.delete(n),
    } as never;
  }

  it('書いたあと読み直して keyId を照らす ── 違えば先に在った方を採る(created: false)', async () => {
    const files = new Map<string, Blob>();
    const other = await createKeyMaterial(c, 'A');
    const mine = await createKeyMaterial(c, 'B');
    let raced = false;
    const box = new EncryptedBox({
      inner: folderBox(
        dirOf(files, (n) => {
          if (n !== 'keyring.json' || raced) return;
          raced = true;
          files.set('keyring.json', new Blob([serializeKeyring(other.keyring)])); // 同時に別の端末が書いた(後勝ち)
        }),
      ),
      crypto: c,
      key: null,
    });
    const r = await box.ensureKeyring(mine.keyring);
    expect(raced).toBe(true);
    expect(r.created).toBe(false);
    expect(r.keyring.keyId).toBe(other.keyring.keyId);
  });

  it('競合が無ければ created: true / 先に在れば書かない', async () => {
    const files = new Map<string, Blob>();
    const a = await createKeyMaterial(c, 'A');
    const b = await createKeyMaterial(c, 'B');
    const box = new EncryptedBox({ inner: folderBox(dirOf(files)), crypto: c, key: null });
    expect((await box.ensureKeyring(a.keyring)).created).toBe(true);
    const r = await box.ensureKeyring(b.keyring);
    expect(r).toEqual({ keyring: a.keyring, created: false });
    // 包み直し(フォルダは条件が無いので、読み直した束と同じ keyId のときだけ書く)
    const next = await rewrapKeyring(c, a.keyring, { passphrase: 'A' }, 'A2');
    await box.rewrapKeyring(next, undefined);
    expect((await box.loadKeyring())!.keyring).toEqual(next);
  });

  it('差分ファイルの暗号化の往復(フォルダ)', async () => {
    const files = new Map<string, Blob>();
    const km = await createKeyMaterial(c, 'A');
    const box: RemoteBox = new EncryptedBox({ inner: folderBox(dirOf(files)), crypto: c, key: { dataKey: km.dataKey, keyId: km.keyring.keyId } });
    await box.write(encFileName(DEV), new Blob([NOTE]), null, { device: DEV, seq: 2 });
    expect(Buffer.from(await files.get(encFileName(DEV))!.arrayBuffer()).includes(Buffer.from(NOTE))).toBe(false);
    expect(await (await box.read(encFileName(DEV))).text()).toBe(NOTE);
  });
});
