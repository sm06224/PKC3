/** @vitest-environment node */
/**
 * 🔴 **S3 互換の保管先(S3Box)**(#2000 段 4a-3。user 裁定 2026-11-22)── 作り物の S3(メモリの中・ETag・条件付き書き込み)で見る。
 *
 * 守る主張(user の必須ガード):
 * 1. **path-style**(`<endpoint>/<bucket>/<prefix><name>`)で、パスは RFC 3986 で 1 度だけエンコード(`/` は残す)
 * 2. **`x-amz-content-sha256`** は本文の SHA-256、署名(`Authorization`)が付く
 * 3. **条件付き書き込み**: 前に書いた版が在れば `If-Match`、無ければ `If-None-Match: *`。**412 は上書きせずに止める**
 * 4. 一覧は置き場の直下・accept が通す名前だけ、続きのトークンで全ページ読む。版は ETag
 * 5. 失敗の字に秘密(シークレット・Authorization・クエリ)を混ぜない。403 → NotAllowedError、404 → NotFoundError
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BoxConflictError, parseListObjects, S3Box, webSigCrypto } from '../../src/adapter/platform/s3-box';
import type { S3BoxConfig } from '../../src/adapter/platform/sync-keystore';

const CONFIG: S3BoxConfig = { kind: 's3', endpoint: 'https://s3.example.test', bucket: 'my notes', region: 'auto', prefix: 'pkc3/' };
const SECRET = { accessKeyId: 'AKIA-TEST-ID', secretAccessKey: 'TOP/SECRET+value' };

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** メモリの S3(必要な所だけ)。 */
function fakeS3(opts: { pageSize?: number; exposeEtag?: boolean; deny?: boolean; failFetch?: boolean } = {}) {
  const objects = new Map<string, { body: Uint8Array; etag: string; mtime: string }>();
  const seen: Seen[] = [];
  let n = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (opts.failFetch === true) throw new TypeError('Failed to fetch');
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ method: init.method ?? 'GET', url, headers });
    if (opts.deny === true) return new Response('<Error><Code>AccessDenied</Code><Message>no</Message></Error>', { status: 403 });
    const u = new URL(url);
    const parts = u.pathname.split('/').slice(1).map(decodeURIComponent);
    const bucket = parts[0]!;
    const key = parts.slice(1).join('/');
    if (bucket !== 'my notes') return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 });
    const body = init.body instanceof Uint8Array ? init.body : new Uint8Array();
    if (init.method === 'PUT') {
      // 本文の SHA-256 と署名の見出しが合うこと(合わなければ S3 は断る)
      const sha = createHash('sha256').update(body).digest('hex');
      if (headers['x-amz-content-sha256'] !== sha) return new Response('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>', { status: 400 });
      const cur = objects.get(key);
      const im = headers['if-match'];
      const inm = headers['if-none-match'];
      if ((im !== undefined && cur?.etag !== im) || (inm === '*' && cur !== undefined)) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      const etag = `"e${String(++n)}"`;
      objects.set(key, { body, etag, mtime: `2026-11-22T00:00:${String(n).padStart(2, '0')}.000Z` });
      return new Response('', { status: 200, headers: opts.exposeEtag === false ? {} : { ETag: etag } });
    }
    if (init.method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (key === '') {
      const prefix = u.searchParams.get('prefix') ?? '';
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const size = opts.pageSize ?? 1000;
      const start = Number(u.searchParams.get('continuation-token') ?? '0');
      const page = all.slice(start, start + size);
      const more = start + size < all.length;
      const xml = `<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><LastModified>${objects.get(k)!.mtime}</LastModified><ETag>${objects.get(k)!.etag.replace(/"/g, '&quot;')}</ETag><Size>${String(objects.get(k)!.body.byteLength)}</Size></Contents>`).join('')}<IsTruncated>${String(more)}</IsTruncated>${more ? `<NextContinuationToken>${String(start + size)}</NextContinuationToken>` : ''}</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    const o = objects.get(key);
    return o === undefined ? new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }) : new Response(o.body as Uint8Array<ArrayBuffer>, { status: 200 });
  };
  return { fetch, objects, seen };
}

const box = (s: ReturnType<typeof fakeS3>, config: S3BoxConfig = CONFIG): S3Box =>
  new S3Box({ config, secret: SECRET, crypto: webSigCrypto(), fetch: s.fetch, now: () => new Date('2026-11-22T00:00:00Z') });

describe('S3Box', () => {
  it('🔴 path-style・RFC 3986 で 1 度だけエンコード・署名と本文の SHA-256 が付く', async () => {
    const s = fakeS3();
    await box(s).write('pkc3-a b.pkc3-diff.zip', new Blob(['hello']));
    const put = s.seen[0]!;
    expect(put.url).toBe('https://s3.example.test/my%20notes/pkc3/pkc3-a%20b.pkc3-diff.zip');
    expect(put.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA-TEST-ID\/20261122\/auto\/s3\/aws4_request, SignedHeaders=[^,]*x-amz-content-sha256;x-amz-date[^,]*, Signature=[0-9a-f]{64}$/);
    expect(put.headers['x-amz-content-sha256']).toBe(createHash('sha256').update('hello').digest('hex'));
    expect(put.headers['host'], 'host はブラウザが付ける(送る見出しに入れない)').toBeUndefined();
  });

  it('🔴 書いた後の控えは版(ETag)/ 一覧は置き場の直下・accept が通す名前だけ・版つき', async () => {
    const s = fakeS3();
    const b = box(s);
    const after = await b.write('pkc3-aaaa.pkc3-diff.zip', new Blob(['x']));
    expect(after).toMatchObject({ name: 'pkc3-aaaa.pkc3-diff.zip', size: 1, version: '"e1"' });
    s.objects.set('pkc3/sub/pkc3-bbbb.pkc3-diff.zip', { body: new Uint8Array([1]), etag: '"z"', mtime: '2026-11-22T00:00:00.000Z' });
    s.objects.set('pkc3/memo.txt', { body: new Uint8Array([1]), etag: '"m"', mtime: '2026-11-22T00:00:00.000Z' });
    s.objects.set('other/pkc3-cccc.pkc3-diff.zip', { body: new Uint8Array([1]), etag: '"o"', mtime: '2026-11-22T00:00:00.000Z' });
    const list = await b.list((n) => n.endsWith('.pkc3-diff.zip'));
    expect(list).toEqual([{ name: 'pkc3-aaaa.pkc3-diff.zip', size: 1, mtime: Date.parse('2026-11-22T00:00:01.000Z'), version: '"e1"' }]);
    expect(await (await b.read('pkc3-aaaa.pkc3-diff.zip')).text()).toBe('x');
  });

  it('一覧は続きのトークンで全ページ読む', async () => {
    const s = fakeS3({ pageSize: 2 });
    const b = box(s);
    for (const id of ['a', 'b', 'c', 'd', 'e']) await b.write(`pkc3-${id}.pkc3-diff.zip`, new Blob([id]));
    expect((await b.list(() => true)).map((e) => e.name)).toEqual(['a', 'b', 'c', 'd', 'e'].map((id) => `pkc3-${id}.pkc3-diff.zip`));
  });

  it('🔴 条件付き書き込み: 版が在れば If-Match、無ければ If-None-Match: *', async () => {
    const s = fakeS3();
    const b = box(s);
    const first = await b.write('pkc3-me.pkc3-diff.zip', new Blob(['1']), null);
    expect(s.seen.at(-1)!.headers['if-none-match']).toBe('*');
    expect(s.seen.at(-1)!.headers['if-match']).toBeUndefined();
    await b.write('pkc3-me.pkc3-diff.zip', new Blob(['2']), first);
    expect(s.seen.at(-1)!.headers['if-match']).toBe(first.version);
  });

  it('🔴 412: 相手が先に書き換えていたら上書きせずに BoxConflictError で止める(版が古い / 無いつもりが在った)', async () => {
    const s = fakeS3();
    const b = box(s);
    const mine = await b.write('pkc3-me.pkc3-diff.zip', new Blob(['mine']));
    // 別の端末が同じ名前を書き換えた
    await b.write('pkc3-me.pkc3-diff.zip', new Blob(['theirs']), mine);
    const err = await b.write('pkc3-me.pkc3-diff.zip', new Blob(['late']), mine).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoxConflictError);
    expect(new TextDecoder().decode(s.objects.get('pkc3/pkc3-me.pkc3-diff.zip')!.body), '412 で上書きした').toBe('theirs');
    // 控えが無いつもりで書いたら、在った(その間に誰かが作った)
    const err2 = await b.write('pkc3-me.pkc3-diff.zip', new Blob(['new']), null).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(BoxConflictError);
    expect(new TextDecoder().decode(s.objects.get('pkc3/pkc3-me.pkc3-diff.zip')!.body)).toBe('theirs');
  });

  it('🔴 失敗の字に秘密を混ぜない / 403 は NotAllowedError・404(バケットが無い)は NotFoundError / 繋がらないときは CORS を言う', async () => {
    const denied = await box(fakeS3({ deny: true })).list(() => true).then(() => new Error('通ってしまった'), (e: unknown) => e as Error);
    expect(denied.name).toBe('NotAllowedError');
    const missing = await box(fakeS3(), { ...CONFIG, bucket: 'nope' }).read('x').then(() => new Error('通ってしまった'), (e: unknown) => e as Error);
    expect(missing.name).toBe('NotFoundError');
    const net = await box(fakeS3({ failFetch: true })).list(() => true).then(() => new Error('通ってしまった'), (e: unknown) => e as Error);
    expect(net.message).toContain('CORS');
    for (const e of [denied, missing, net]) {
      for (const secret of [SECRET.secretAccessKey, SECRET.accessKeyId, 'AWS4-HMAC', 'Signature=', 'x-amz'])
        expect(e.message, `失敗の字に ${secret} が入った`).not.toContain(secret);
    }
  });

  it('🔴 ETag が見えない(CORS の ExposeHeaders が無い)なら、書けたことにせず理由を言う', async () => {
    const err = await box(fakeS3({ exposeEtag: false })).write('pkc3-me.pkc3-diff.zip', new Blob(['x'])).then(() => new Error('通ってしまった'), (e: unknown) => e as Error);
    expect(err.message).toContain('ETag');
  });
});

describe('parseListObjects', () => {
  it('XML の実体参照を戻し、続きのトークンを読む', () => {
    const r = parseListObjects('<ListBucketResult><Contents><Key>a&amp;b</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;x&quot;</ETag><Size>3</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken></ListBucketResult>');
    expect(r).toEqual({ items: [{ key: 'a&b', size: 3, mtime: Date.parse('2026-01-01T00:00:00.000Z'), etag: '"x"' }], next: 't1' });
  });
});
