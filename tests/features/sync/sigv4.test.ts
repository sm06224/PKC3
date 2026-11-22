/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { canonicalRequest, EMPTY_SHA256, signV4, uriEncode, type SigCrypto } from '../../../src/features/sync/sigv4';

const webCrypto: SigCrypto = {
  sha256Hex: async (d) => Buffer.from(await crypto.subtle.digest('SHA-256', d as Uint8Array<ArrayBuffer>)).toString('hex'),
  hmac: async (key, data) => {
    const k = await crypto.subtle.importKey('raw', key as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as Uint8Array<ArrayBuffer>));
  },
};
const CRED = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const NOW = new Date('2013-05-24T00:00:00Z');
const sigOf = (h: Record<string, string>): string => /Signature=([0-9a-f]{64})/.exec(h.Authorization ?? '')?.[1] ?? '';

describe('AWS 公式のテスト値(S3 の署名 v4・本文を 1 塊で送る例)', () => {
  it('GET Object(Range つき)', async () => {
    const h = await signV4({ method: 'GET', path: '/test.txt', headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' }, payloadHash: EMPTY_SHA256 }, CRED, 'us-east-1', NOW, webCrypto);
    expect(sigOf(h)).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
  it('PUT Object(パスの $ をエンコード・x-amz-content-sha256 = 本文の SHA-256)', async () => {
    const body = new TextEncoder().encode('Welcome to Amazon S3.');
    const payload = await webCrypto.sha256Hex(body);
    expect(payload).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const h = await signV4({ method: 'PUT', path: '/test$file.text', headers: { host: 'examplebucket.s3.amazonaws.com', date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadHash: payload }, CRED, 'us-east-1', NOW, webCrypto);
    expect(sigOf(h)).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });
  it('GET Bucket Lifecycle(値の無いクエリ)', async () => {
    const h = await signV4({ method: 'GET', path: '/', query: { lifecycle: '' }, headers: { host: 'examplebucket.s3.amazonaws.com' }, payloadHash: EMPTY_SHA256 }, CRED, 'us-east-1', NOW, webCrypto);
    expect(sigOf(h)).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });
  it('Get Bucket(List Objects ── クエリの並べ替え)', async () => {
    const h = await signV4({ method: 'GET', path: '/', query: { prefix: 'J', 'max-keys': '2' }, headers: { host: 'examplebucket.s3.amazonaws.com' }, payloadHash: EMPTY_SHA256 }, CRED, 'us-east-1', NOW, webCrypto);
    expect(sigOf(h)).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});

describe('URI のエンコード(RFC 3986・S3 の作法)', () => {
  it('🔴 予約しない字はそのまま、それ以外は %XX(大文字)。パスの / は残す。二重にしない', () => {
    expect(uriEncode('/bucket/pkc3/a b+c~d.zip', true)).toBe('/bucket/pkc3/a%20b%2Bc~d.zip');
    expect(uriEncode('a/b', false)).toBe('a%2Fb');
    expect(uriEncode("!'()*", false)).toBe('%21%27%28%29%2A');
    expect(uriEncode('日本', true)).toBe('%E6%97%A5%E6%9C%AC');
    // 既に %XX の字は % ごとエンコード(1 度だけ ── 呼び手がエンコード前の字を渡す約束)
    expect(uriEncode('%20', true)).toBe('%2520');
  });
  it('正規のリクエストはパスを 1 度だけエンコードする(path-style のバケット名を含む)', () => {
    const { text } = canonicalRequest({ method: 'get', path: '/my bucket/pkc3/x.zip', headers: { Host: 'minio.local:9000' }, payloadHash: EMPTY_SHA256 });
    expect(text.split('\n').slice(0, 2)).toEqual(['GET', '/my%20bucket/pkc3/x.zip']);
    expect(text).toContain('host:minio.local:9000\n');
  });
});
