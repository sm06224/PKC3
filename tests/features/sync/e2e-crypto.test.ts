/** @vitest-environment node */
/**
 * 🔴 **端末間の同期の暗号化(#2000 段 4b)── 形式・改ざん検出・PBKDF2・回復キー・keyring**(純粋な核を、node の WebCrypto で通す)。
 *
 * 守る主張:
 * 1. 往復(0 / 1 / ちょうど 1 MiB / 1 MiB + 1 / 3 MiB)で平文に戻る。暗号文に平文が出ない
 * 2. 🔴 改ざんは全部落ちる: 各塊の 1 バイト・塊の入れ替え・最後の塊の切り落とし・塊の継ぎ足し・ヘッダ(連番・端末・名前)の書き換え・別の keyId・別の鍵
 * 3. 最後の塊の印(AAD)が実際に効いている(印を外して作った物は落ちる)
 * 4. PBKDF2 は 600000 回(文字で固定)・それ未満の keyring は読まない
 * 5. 回復キーは大文字小文字・ハイフンを問わず読める。データ鍵は取り出せない
 */
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  E2E_CHUNK,
  E2EError,
  GCM_TAG_BYTES,
  createKeyMaterial,
  decryptDiff,
  derivePassphraseKek,
  encryptDiff,
  formatRecoveryKey,
  openDataKey,
  parseRecoveryKey,
  readEncHeader,
  rewrapKeyring,
  type E2ECrypto,
} from '../../../src/features/sync/e2e-crypto';
import { b64urlDecode, b64urlEncode } from '../../../src/features/sync/b64url';
import { KEYRING_NAME, KeyringFormatError, PBKDF2_ITERATIONS, parseKeyring, serializeKeyring } from '../../../src/features/sync/keyring';

const c: E2ECrypto = { subtle: webcrypto.subtle as SubtleCrypto, random: (n) => webcrypto.getRandomValues(new Uint8Array(n)) };
const DEV = '0123456789abcdef';
const NAME = `pkc3-${DEV}.pkc3-diff.zip.enc`;

async function dataKey(): Promise<CryptoKey> {
  return c.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function bytesOf(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) webcrypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}
const same = async (a: Blob, b: Uint8Array): Promise<boolean> => Buffer.from(await a.arrayBuffer()).equals(Buffer.from(b));
async function raw(b: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await b.arrayBuffer());
}
async function enc(plain: Uint8Array<ArrayBuffer>, key: CryptoKey, over: Partial<{ keyId: string; device: string; seq: number; name: string }> = {}): Promise<Blob> {
  return encryptDiff(c, new Blob([plain]), { dataKey: key, keyId: 'KID', device: DEV, seq: 5, name: NAME, ...over });
}
const dec = (b: Blob, key: CryptoKey, over: Partial<{ keyId: string; expectName: string; expectDevice: string }> = {}) =>
  decryptDiff(c, b, { dataKey: key, keyId: 'KID', expectName: NAME, expectDevice: DEV, ...over });
const rejects = async (p: Promise<unknown>, code?: string): Promise<void> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e, '落ちるはずの物が通った').toBeInstanceOf(E2EError);
  if (code !== undefined) expect((e as E2EError).code).toBe(code);
};

describe('往復', () => {
  for (const size of [0, 1, E2E_CHUNK, E2E_CHUNK + 1, 3 * E2E_CHUNK]) {
    it(`${String(size)} bytes ── 平文に戻る / 暗号文に平文が出ない / 大きさは平文 + 塊ごとのタグ + ヘッダ`, async () => {
      const key = await dataKey();
      const plain = bytesOf(size);
      const blob = await enc(plain, key);
      const { plain: back, header } = await dec(blob, key);
      expect(await same(back, plain)).toBe(true);
      expect(header).toMatchObject({ v: 1, keyId: 'KID', device: DEV, seq: 5, name: NAME, chunk: E2E_CHUNK, size });
      const chunks = Math.max(1, Math.ceil(size / E2E_CHUNK));
      const { prefix } = await readEncHeader(blob);
      expect(blob.size).toBe(prefix.length + size + GCM_TAG_BYTES * chunks);
      if (size >= 64) expect(Buffer.from(await blob.arrayBuffer()).includes(Buffer.from(plain.subarray(0, 64)))).toBe(false);
    });
  }

  it('同じ平文でも nonce が毎回違う(IV が重ならない)', async () => {
    const key = await dataKey();
    const p = bytesOf(100);
    const a = await readEncHeader(await enc(p, key));
    const b = await readEncHeader(await enc(p, key));
    expect(a.header.nonce).not.toBe(b.header.nonce);
  });
});

describe('🔴 改ざんは全部落ちる', () => {
  const SIZE = 2 * E2E_CHUNK + 100; // 3 塊(最後は短い)
  async function fixture(): Promise<{ key: CryptoKey; blob: Blob; bytes: Uint8Array<ArrayBuffer>; prefixLen: number }> {
    const key = await dataKey();
    const blob = await enc(bytesOf(SIZE), key);
    const { prefix } = await readEncHeader(blob);
    // 対照群: 手を入れなければ通る(空振り防止 ── 落ちる test が「いつも落ちる」で緑にならない)
    await dec(blob, key);
    return { key, blob, bytes: await raw(blob), prefixLen: prefix.length };
  }

  it('各塊の 1 バイトを書き換える(塊 0 / 1 / 2 それぞれ)', async () => {
    const { key, bytes, prefixLen } = await fixture();
    const starts = [0, 1, 2].map((i) => prefixLen + i * (E2E_CHUNK + GCM_TAG_BYTES));
    for (const at of starts) {
      for (const off of [0, 17]) {
        const t = new Uint8Array(bytes);
        t[at + off]! ^= 1;
        await rejects(dec(new Blob([t]), key), 'auth');
      }
    }
    // 末尾(最後の塊のタグ)
    const t = new Uint8Array(bytes);
    t[t.length - 1]! ^= 1;
    await rejects(dec(new Blob([t]), key), 'auth');
  });

  it('塊を入れ替える(0 と 1)', async () => {
    const { key, bytes, prefixLen } = await fixture();
    const sz = E2E_CHUNK + GCM_TAG_BYTES;
    const t = new Uint8Array(bytes);
    t.set(bytes.subarray(prefixLen + sz, prefixLen + 2 * sz), prefixLen);
    t.set(bytes.subarray(prefixLen, prefixLen + sz), prefixLen + sz);
    await rejects(dec(new Blob([t]), key), 'auth');
  });

  it('最後の塊を切り落とす / 余計な塊を継ぎ足す / 1 バイト足す・削る', async () => {
    const { key, bytes, prefixLen } = await fixture();
    const sz = E2E_CHUNK + GCM_TAG_BYTES;
    await rejects(dec(new Blob([bytes.subarray(0, prefixLen + 2 * sz)]), key), 'format'); // 最後の塊を落とす
    await rejects(dec(new Blob([bytes, bytes.subarray(prefixLen, prefixLen + sz)]), key), 'format'); // 塊を継ぎ足す
    await rejects(dec(new Blob([bytes, new Uint8Array(1)]), key), 'format');
    await rejects(dec(new Blob([bytes.subarray(0, bytes.length - 1)]), key), 'format');
    await rejects(dec(new Blob([bytes.subarray(0, 5)]), key), 'format');
    await rejects(dec(new Blob([]), key), 'format');
  });

  it('🔴 ヘッダの連番・端末・名前を書き換える(読み手の期待値を書き換え後に合わせても、AAD で落ちる)', async () => {
    const { key, bytes, blob } = await fixture();
    const text = Buffer.from(bytes).toString('latin1');
    const swap = (from: string, to: string): Blob => {
      expect(from.length).toBe(to.length);
      expect(text.split(from).length, `ヘッダに ${from} が 1 つ在る`).toBe(2);
      return new Blob([Buffer.from(text.replace(from, to), 'latin1')]);
    };
    const seq = swap('"seq":5', '"seq":6');
    await rejects(dec(seq, key), 'auth');
    const dev = swap(`"device":"${DEV}"`, `"device":"1123456789abcdef"`);
    await rejects(dec(dev, key, { expectDevice: '1123456789abcdef' }), 'auth');
    await rejects(dec(dev, key), 'mismatch');
    const nm = swap(`"name":"pkc3-${DEV}`, `"name":"pkc3-X${DEV.slice(1)}`);
    await rejects(dec(nm, key, { expectName: NAME.replace(DEV, `X${DEV.slice(1)}`) }), 'auth');
    await rejects(dec(nm, key), 'mismatch');
    const kid = swap('"keyId":"KID"', '"keyId":"KIX"');
    await rejects(dec(kid, key, { keyId: 'KIX' }), 'auth');
    void blob;
  });

  it('別のファイル名・別の端末で読もうとする(置き場での改名・差し替え)', async () => {
    const { key, blob } = await fixture();
    await rejects(dec(blob, key, { expectName: `pkc3-ffffffffffffffff.pkc3-diff.zip.enc` }), 'mismatch');
    await rejects(dec(blob, key, { expectDevice: 'ffffffffffffffff' }), 'mismatch');
  });

  it('別の keyId で書かれた物は「別の暗号化キー」として断る / 別の鍵では開かない', async () => {
    const { key, blob } = await fixture();
    await rejects(dec(blob, key, { keyId: 'OTHER' }), 'key-mismatch');
    await rejects(dec(blob, await dataKey()), 'auth');
  });

  it('🔴 最後の塊の印(AAD)が効く: 印を付けずに最後の塊を作った物は落ちる', async () => {
    const key = await dataKey();
    const blob = await enc(bytesOf(10), key);
    const { prefix, header } = await readEncHeader(blob);
    const nonce = b64urlDecode(header.nonce)!;
    const aad = (last: number): Uint8Array<ArrayBuffer> => {
      const a = new Uint8Array(prefix.length + 5);
      a.set(prefix);
      a[prefix.length + 4] = last;
      return a;
    };
    const iv = new Uint8Array(12);
    iv.set(nonce);
    const mk = async (last: number): Promise<Blob> =>
      new Blob([prefix, await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(last), tagLength: 128 }, key, bytesOf(10))]);
    await dec(await mk(1), key); // 対照群: 印ありは通る(この組み立てが形式どおり)
    await rejects(dec(await mk(0), key), 'auth');
  });

  it('壊れたヘッダ(magic・長さ・JSON・欄・版・塊の大きさ)', async () => {
    const key = await dataKey();
    const good = await raw(await enc(bytesOf(10), key));
    const text = Buffer.from(good).toString('latin1');
    const withText = (from: string, to: string): Blob => new Blob([Buffer.from(text.replace(from, to), 'latin1')]);
    await rejects(dec(withText('PKC3E2E1', 'PKC3E2E2'), key), 'format');
    await rejects(dec(withText('"v":1', '"v":2'), key), 'format');
    await rejects(dec(withText('"chunk":1048576', '"chunk":1048577'), key), 'format');
    await rejects(dec(withText('"size":10', '"size":-1'), key), 'format');
    await rejects(dec(withText('"v":1', '"x":1'), key), 'format');
    const hugeLen = new Uint8Array(good);
    new DataView(hugeLen.buffer).setUint32(8, 0xffffffff, false);
    await rejects(dec(new Blob([hugeLen]), key), 'format');
  });
});

describe('🔴 PBKDF2 は 600000 回', () => {
  it('回数は文字で固定 / keyring に 600000 と書く', async () => {
    expect(PBKDF2_ITERATIONS).toBe(600000);
    const m = await createKeyMaterial(c, 'パスフレーズ-1');
    expect(m.keyring.kdf.iterations).toBe(600000);
    expect(serializeKeyring(m.keyring)).toContain('"iterations":600000');
  });

  it('下限未満の keyring は読まない / 下限未満の回数では鍵を作らない', async () => {
    const m = await createKeyMaterial(c, 'パスフレーズ-1');
    const doc = JSON.parse(serializeKeyring(m.keyring)) as { kdf: { iterations: number } };
    for (const n of [599999, 1, 0, -1, 600000.5]) {
      const bad = { ...doc, kdf: { ...doc.kdf, iterations: n } };
      expect(() => parseKeyring(JSON.stringify(bad)), String(n)).toThrow(KeyringFormatError);
    }
    expect(() => parseKeyring(JSON.stringify({ ...doc, kdf: { ...doc.kdf, iterations: 600001 } }))).not.toThrow();
    await rejects(derivePassphraseKek(c, 'x', c.random(16), 599999), 'weak-kdf');
    await rejects(derivePassphraseKek(c, '', c.random(16), 600000), 'empty-passphrase');
  });
});

describe('回復キー', () => {
  it('形式: 32 文字を 4 字ごとに - で区切る / 往復 / 大文字小文字・ハイフン・空白・O と 0・I と L と 1 の読み替えを許す', () => {
    const b = bytesOf(20);
    const k = formatRecoveryKey(b);
    expect(k).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    expect(Buffer.from(parseRecoveryKey(k)!).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(parseRecoveryKey(k.toLowerCase().replace(/-/g, ' '))!).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(parseRecoveryKey(k.replace(/-/g, ''))!).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(parseRecoveryKey(formatRecoveryKey(new Uint8Array(20)).replace(/0/g, 'o'))!).equals(Buffer.alloc(20))).toBe(true);
  });
  it('読めない物は null(長さ・字・余りのビット)', () => {
    const k = formatRecoveryKey(bytesOf(20));
    expect(parseRecoveryKey(k.slice(0, -1))).toBeNull();
    expect(parseRecoveryKey(`${k}A`)).toBeNull();
    expect(parseRecoveryKey(k.replace(/^./, 'U'))).toBeNull();
    expect(parseRecoveryKey('')).toBeNull();
  });
});

describe('暗号化キーの作成・開く・包み直し', () => {
  it('🔴 作ったキーは取り出せない / パスフレーズでも回復キーでも同じキーが開く', async () => {
    const m = await createKeyMaterial(c, 'correct horse');
    expect(m.dataKey.extractable).toBe(false);
    await expect(c.subtle.exportKey('raw', m.dataKey)).rejects.toThrow();
    const blob = await enc(bytesOf(1000), m.dataKey, { keyId: m.keyring.keyId });
    const viaPass = await openDataKey(c, m.keyring, { passphrase: 'correct horse' });
    const viaRec = await openDataKey(c, m.keyring, { recoveryKey: m.recoveryKey.toLowerCase() });
    for (const o of [viaPass, viaRec]) {
      expect(o.dataKey.extractable).toBe(false);
      expect(o.keyId).toBe(m.keyring.keyId);
      await dec(blob, o.dataKey, { keyId: m.keyring.keyId });
    }
  });

  it('違うパスフレーズ・違う回復キー・読めない回復キーは断る', async () => {
    const m = await createKeyMaterial(c, 'correct horse');
    await rejects(openDataKey(c, m.keyring, { passphrase: 'wrong' }), 'wrong-secret');
    await rejects(openDataKey(c, m.keyring, { recoveryKey: formatRecoveryKey(bytesOf(20)) }), 'wrong-secret');
    await rejects(openDataKey(c, m.keyring, { recoveryKey: 'abc' }), 'bad-recovery');
  });

  it('🔴 包み直し: 新しいパスフレーズで開く・古いのは開かない・keyId と回復側の包みは同じ・既存の暗号文はそのまま読める', async () => {
    const m = await createKeyMaterial(c, 'old-pass');
    const blob = await enc(bytesOf(500), m.dataKey, { keyId: m.keyring.keyId });
    const next = await rewrapKeyring(c, m.keyring, { passphrase: 'old-pass' }, 'new-pass');
    expect(next.keyId).toBe(m.keyring.keyId);
    expect(next.wrapped.recovery).toBe(m.keyring.wrapped.recovery);
    expect(next.wrapped.passphrase).not.toBe(m.keyring.wrapped.passphrase);
    expect(next.kdf.salt).not.toBe(m.keyring.kdf.salt);
    await rejects(openDataKey(c, next, { passphrase: 'old-pass' }), 'wrong-secret');
    const o = await openDataKey(c, next, { passphrase: 'new-pass' });
    await dec(blob, o.dataKey, { keyId: m.keyring.keyId });
    // パスフレーズを忘れたら回復キーで開いて付け直す
    const viaRec = await rewrapKeyring(c, next, { recoveryKey: m.recoveryKey }, 'third');
    await dec(blob, (await openDataKey(c, viaRec, { passphrase: 'third' })).dataKey, { keyId: m.keyring.keyId });
    await rejects(rewrapKeyring(c, next, { passphrase: 'nope' }, 'x'), 'wrong-secret');
  });

  it('keyring.json は厳密に読む(知らない版・知らない欄・欠け・形の違う値・JSON でない)', async () => {
    const m = await createKeyMaterial(c, 'p');
    const doc = JSON.parse(serializeKeyring(m.keyring)) as Record<string, unknown>;
    expect(parseKeyring(serializeKeyring(m.keyring))).toEqual(m.keyring);
    const bads: unknown[] = [
      { ...doc, v: 2 },
      { ...doc, extra: 1 },
      { ...doc, keyId: 'short' },
      { ...doc, kdf: { ...(doc.kdf as object), name: 'scrypt' } },
      { ...doc, kdf: { ...(doc.kdf as object), salt: 'AA' } },
      { ...doc, wrapped: { passphrase: 'AAAA', recovery: 'AAAA' } },
      { ...doc, wrapped: { passphrase: (doc.wrapped as { passphrase: string }).passphrase } },
      [],
      null,
    ];
    for (const b of bads) expect(() => parseKeyring(JSON.stringify(b))).toThrow(KeyringFormatError);
    expect(() => parseKeyring('not json')).toThrow(KeyringFormatError);
    expect(KEYRING_NAME).toBe('keyring.json');
  });

  it('b64url は正規の字だけ読む', () => {
    const b = bytesOf(33);
    expect(Buffer.from(b64urlDecode(b64urlEncode(b))!).equals(Buffer.from(b))).toBe(true);
    expect(b64urlDecode('AA=')).toBeNull();
    expect(b64urlDecode('A')).toBeNull();
    expect(b64urlDecode('AB')).toBeNull(); // 余りのビットが 0 でない
    expect(b64urlDecode('A+/A')).toBeNull();
  });
});
