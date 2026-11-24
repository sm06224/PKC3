/** @vitest-environment node */
/**
 * 🔴 **既知の答えのテスト(KAT)と、IV・AAD の独立な検算**(#2000 段 4b-A)。
 *
 * 往復だけのテストは、暗号化と復号が**同じ間違い**を持っていても通る。ここは次を**コードに置いた定数**で固定する:
 * - 一度だけ生成して貼ったリテラルの keyring / 暗号文を、パスフレーズでも回復キー(HKDF の info・塩)でも開ける
 * - keyring に書かれた回数(700000)で開く(定数 600000 を使う読み手は落ちる)
 * - 包みを別の keyId へ移したら開かない(包みの AAD = keyId)
 * - 塊 i の IV = nonce ‖ u32 BE(i)・AAD = ヘッダ原文 ‖ u32 BE(i) ‖ 最後の印 を、`subtle.decrypt` を直に呼んで手で組んで検算する
 */
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { b64urlDecode } from '../../../src/features/sync/b64url';
import { E2E_CHUNK, decryptDiff, encryptDiff, openDataKey, readEncHeader, rewrapKeyring, type E2ECrypto } from '../../../src/features/sync/e2e-crypto';
import { parseKeyring } from '../../../src/features/sync/keyring';

const c: E2ECrypto = { subtle: webcrypto.subtle as SubtleCrypto, random: (n) => webcrypto.getRandomValues(new Uint8Array(n)) };
const DEV = '0123456789abcdef';
const NAME = `pkc3-${DEV}.pkc3-diff.zip.enc`;

// ── 一度だけ生成して貼ったリテラル(作り直さない。形式を変えたら落ちる = 古い暗号文が読めなくなる合図)
const K1 = "{\"v\":1,\"keyId\":\"sZf3ia7AO22amCBKFEjiMw\",\"kdf\":{\"name\":\"PBKDF2\",\"hash\":\"SHA-256\",\"iterations\":600000,\"salt\":\"wVTNBhkbkAeXjnfSBCbwIg\"},\"wrapped\":{\"passphrase\":\"mHnw_gasz5FWHs2Z9C9WNZ3WtBjrNnlrtHGm0WKK3gOiZe1OFEI45AoEO8JqE2-d_49cdoYhP2-t83JF\",\"recovery\":\"to069VzL5TDiJNTK7PixRI2jMPVrx_ztQ7ci8qhDSaUyb4qTZiw1A9UbVVpYbOU3RjCf4FCrz3w9_5ot\"}}";
const REC1 = "ME77-VPKG-GQX7-CJRR-RBWC-FRM5-DEJB-9HYQ";
const PASS1 = 'kat-passphrase-ß-1';
const BLOB1 = "UEtDM0UyRTEAAACteyJ2IjoxLCJrZXlJZCI6InNaZjNpYTdBTzIyYW1DQktGRWppTXciLCJkZXZpY2UiOiIwMTIzNDU2Nzg5YWJjZGVmIiwic2VxIjozLCJuYW1lIjoicGtjMy0wMTIzNDU2Nzg5YWJjZGVmLnBrYzMtZGlmZi56aXAuZW5jIiwiY2h1bmsiOjEwNDg1NzYsIm5vbmNlIjoiZGZrdVBoaWJhQUEiLCJzaXplIjoyMn0I6kalW9xU9aTcD3qznj0aadH7uNmfnvA5MucNFsXgZYRX3AgtMQ==";
const K2 = "{\"v\":1,\"keyId\":\"WYAoKnp_WdUSo5Nqyj1MhA\",\"kdf\":{\"name\":\"PBKDF2\",\"hash\":\"SHA-256\",\"iterations\":700000,\"salt\":\"OqYjvfnYVliykCPFFtlaog\"},\"wrapped\":{\"passphrase\":\"kvYOeDPV3aB9In4jA6vvsUN1s56jWBtVSb3zQCLAXsO7yXR488urmXAPZaQGhhnqtELJ9i1UOpCcDzuN\",\"recovery\":\"9OqM4LSKwWxKL26JCQFN_Os90zqefMb1BHfMftFz3TrrRmr0IpAmSjJ5iHSL9lLsAbnqD1qpTKHs1fea\"}}"; // PBKDF2 700000 回
const REC2 = "DHND-KY6E-F02Y-NVAM-QDFF-Q88T-A1GR-C6Q2";
const PASS2 = 'kat-700k';
const BLOB2 = "UEtDM0UyRTEAAACteyJ2IjoxLCJrZXlJZCI6IldZQW9LbnBfV2RVU281TnF5ajFNaEEiLCJkZXZpY2UiOiIwMTIzNDU2Nzg5YWJjZGVmIiwic2VxIjoxLCJuYW1lIjoicGtjMy0wMTIzNDU2Nzg5YWJjZGVmLnBrYzMtZGlmZi56aXAuZW5jIiwiY2h1bmsiOjEwNDg1NzYsIm5vbmNlIjoiYnNnd09BTGx4NFEiLCJzaXplIjoxMn13dUkntk1NbehX0qlXfxlkXHW9zB0Z6Lq64sRp";

const blobOf = (b64: string): Blob => new Blob([Buffer.from(b64, 'base64')]);
const dopts = (keyId: string, key: CryptoKey) => ({ dataKey: key, keyId, expectName: NAME, expectDevice: DEV });

describe('既知の答え', () => {
  it('🔴 リテラルの keyring をパスフレーズで開き、リテラルの暗号文が読める', async () => {
    const ring = parseKeyring(K1);
    const k = await openDataKey(c, ring, { passphrase: PASS1 });
    const r = await decryptDiff(c, blobOf(BLOB1), dopts(ring.keyId, k.dataKey));
    expect(await r.plain.text()).toBe('known-answer plaintext');
    expect(r.header).toMatchObject({ seq: 3, device: DEV, name: NAME, size: 22 });
  });

  it('🔴 回復キーでも同じ暗号文が読める(HKDF の info・塩・包みの AAD が固定されている)', async () => {
    const ring = parseKeyring(K1);
    const k = await openDataKey(c, ring, { recoveryKey: REC1.toLowerCase().replace(/-/g, '') });
    expect(await (await decryptDiff(c, blobOf(BLOB1), dopts(ring.keyId, k.dataKey))).plain.text()).toBe('known-answer plaintext');
  });

  it('🔴 keyring に書かれた回数(700000)で開く / 回復キーも通る', async () => {
    const ring = parseKeyring(K2);
    expect(ring.kdf.iterations).toBe(700000);
    for (const via of [{ passphrase: PASS2 }, { recoveryKey: REC2 }]) {
      const k = await openDataKey(c, ring, via);
      expect(await (await decryptDiff(c, blobOf(BLOB2), dopts(ring.keyId, k.dataKey))).plain.text()).toBe('k2 plaintext');
    }
    await expect(openDataKey(c, ring, { passphrase: PASS1 })).rejects.toMatchObject({ code: 'wrong-secret' });
  });

  it('🔴 包みを別の keyId へ移すと開かない(パスフレーズ側も回復キー側も)', async () => {
    const a = parseKeyring(K1);
    const other = parseKeyring(K2).keyId;
    const moved = { ...a, keyId: other };
    await expect(openDataKey(c, moved, { passphrase: PASS1 })).rejects.toMatchObject({ code: 'wrong-secret' });
    await expect(openDataKey(c, moved, { recoveryKey: REC1 })).rejects.toMatchObject({ code: 'wrong-secret' });
  });
});

describe('回数', () => {
  it('包み直しは回数を下げない(700000 のものは 700000 のまま)/ 上限(10,000,000)を超える keyring は読まない', async () => {
    const ring = parseKeyring(K2);
    const next = await rewrapKeyring(c, ring, { passphrase: PASS2 }, 'new-pass-x');
    expect(next.kdf.iterations).toBe(700000);
    await openDataKey(c, next, { passphrase: 'new-pass-x' });
    const doc = JSON.parse(K2) as { kdf: { iterations: number } };
    doc.kdf.iterations = 10_000_001;
    expect(() => parseKeyring(JSON.stringify(doc))).toThrow();
    doc.kdf.iterations = 10_000_000;
    expect(() => parseKeyring(JSON.stringify(doc))).not.toThrow();
  });
});

describe('🔴 IV と AAD を手で組んで検算する', () => {
  const u32 = (n: number): Uint8Array => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    return b;
  };
  const cat = (...p: Uint8Array[]): Uint8Array<ArrayBuffer> => {
    const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0));
    let at = 0;
    for (const x of p) {
      o.set(x, at);
      at += x.length;
    }
    return o;
  };

  it('塊 0 / 1 を、IV = nonce ‖ u32 BE(i)・AAD = ヘッダ原文 ‖ u32 BE(i) ‖ 最後の印 で復号できる / IV の連番を 0 に固定すると塊 1 は開かない', async () => {
    const key = await c.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const plain = new Uint8Array(E2E_CHUNK + 5);
    for (let i = 0; i < plain.length; i += 65536) webcrypto.getRandomValues(plain.subarray(i, Math.min(plain.length, i + 65536)));
    const blob = await encryptDiff(c, new Blob([plain]), { dataKey: key, keyId: 'KID', device: DEV, seq: 9, name: NAME });
    const { header, prefix } = await readEncHeader(blob);
    const nonce = b64urlDecode(header.nonce)!;
    expect(nonce).toHaveLength(8);
    const all = new Uint8Array(await blob.arrayBuffer());
    const c0 = all.subarray(prefix.length, prefix.length + E2E_CHUNK + 16);
    const c1 = all.subarray(prefix.length + E2E_CHUNK + 16);
    const dec = (ct: Uint8Array, iv: Uint8Array, aad: Uint8Array) =>
      c.subtle.decrypt({ name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, additionalData: aad as Uint8Array<ArrayBuffer>, tagLength: 128 }, key, ct as Uint8Array<ArrayBuffer>);
    const p0 = new Uint8Array(await dec(c0, cat(nonce, u32(0)), cat(prefix, u32(0), Uint8Array.of(0))));
    const p1 = new Uint8Array(await dec(c1, cat(nonce, u32(1)), cat(prefix, u32(1), Uint8Array.of(1))));
    expect(Buffer.from(cat(p0, p1)).equals(Buffer.from(plain))).toBe(true);
    // 対照群: IV の連番を 0 に固定した読み手(塊 1 を iv 連番 0 で開く)は落ちる
    await expect(dec(c1, cat(nonce, u32(0)), cat(prefix, u32(1), Uint8Array.of(1)))).rejects.toThrow();
    // AAD の最後の印・塊番号・ヘッダを欠いても落ちる
    await expect(dec(c1, cat(nonce, u32(1)), cat(prefix, u32(1), Uint8Array.of(0)))).rejects.toThrow();
    await expect(dec(c1, cat(nonce, u32(1)), cat(prefix, u32(0), Uint8Array.of(1)))).rejects.toThrow();
    await expect(dec(c1, cat(nonce, u32(1)), cat(u32(1), Uint8Array.of(1)))).rejects.toThrow();
    // 実装の復号も同じ答え
    expect(Buffer.from(await (await decryptDiff(c, blob, { dataKey: key, keyId: 'KID', expectName: NAME, expectDevice: DEV })).plain.arrayBuffer()).equals(Buffer.from(plain))).toBe(true);
  });
});
