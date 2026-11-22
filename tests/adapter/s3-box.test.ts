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
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BoxConflictError, parseListObjects, S3Box, webSigCrypto } from '../../src/adapter/platform/s3-box';
import type { S3BoxConfig } from '../../src/adapter/platform/sync-keystore';

const CONFIG: S3BoxConfig = { kind: 's3', endpoint: 'https://s3.example.test', bucket: 'my notes', region: 'auto', prefix: 'pkc3/' };
const SECRET = { accessKeyId: 'AKIA-TEST-ID', secretAccessKey: 'TOP/SECRET+value' };

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  init: RequestInit;
}

/** RFC 3986 の非予約文字以外をエンコード(実装の uriEncode とは別に書く ── 期待値を実装と同じ盲点で作らない)。 */
const rfc3986 = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256hex = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/**
 * 🔴 **受け取った URL と見出しだけから SigV4 を検算する**(node:crypto の HMAC。実装の signV4 は呼ばない)。
 * 合わなければ本物の S3 と同じく 403 SignatureDoesNotMatch(本文にアクセスキー ID と署名の元の字を含む)を返す。
 */
function verifySignature(method: string, u: URL, headers: Record<string, string>): string | null {
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(headers['authorization'] ?? '');
  if (m === null) return 'Authorization の形が違う';
  const [, akid, day, region, signedList, sig] = m as unknown as [string, string, string, string, string, string];
  if (akid !== SECRET.accessKeyId) return 'アクセスキー ID が違う';
  const signedNames = signedList.split(';');
  if (!signedNames.includes('host') || !signedNames.includes('x-amz-date') || !signedNames.includes('x-amz-content-sha256')) return '署名する見出しが足りない';
  // パスは 1 度だけエンコードされていること(区切りごとに戻して付け直すと同じ字になる)
  const canonUri = u.pathname.split('/').map((seg) => rfc3986(decodeURIComponent(seg))).join('/');
  if (canonUri !== u.pathname) return 'パスのエンコードが RFC 3986 の 1 度きりでない';
  const canonQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonHeaders = signedNames.map((h) => `${h}:${(h === 'host' ? u.host : (headers[h] ?? '')).trim()}\n`).join('');
  const canonical = [method, canonUri, canonQuery, canonHeaders, signedList, headers['x-amz-content-sha256'] ?? ''].join('\n');
  const date = headers['x-amz-date'] ?? '';
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonical)].join('\n');
  let k: Buffer = createHmac('sha256', `AWS4${SECRET.secretAccessKey}`).update(day).digest();
  for (const part of [region, 's3', 'aws4_request']) k = createHmac('sha256', k).update(part).digest();
  return createHmac('sha256', k).update(toSign).digest('hex') === sig ? null : '署名が合わない';
}

/** メモリの S3(必要な所だけ)。 */
function fakeS3(
  opts: {
    pageSize?: number;
    exposeEtag?: boolean;
    deny?: boolean;
    /** deny のときの Code の字(既定 AccessDenied)。 */
    denyCode?: string;
    failFetch?: boolean;
    /** 一覧の ETag の引用符を `&#34;` で出す(MinIO = Go の encoding/xml の出し方)。 */
    numericEntities?: boolean;
    /** 一覧で prefix を無視して全部返す(置き場の外の物を混ぜる)。 */
    ignorePrefix?: boolean;
    /** 条件付き PUT を 409 ConditionalRequestConflict で返す(同時の条件付き書き込み)。 */
    conflict409?: boolean;
    /** 続きがあるのにトークンを付けない(壊れた応答)。 */
    dropToken?: boolean;
    /** 続きのトークンの字(既定 = 素の数字)。 */
    tokenOf?: (start: number) => string;
  } = {},
) {
  const objects = new Map<string, { body: Uint8Array; etag: string; mtime: string }>();
  const seen: Seen[] = [];
  const tokens = new Map<string, number>();
  let n = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (opts.failFetch === true) throw new TypeError('Failed to fetch');
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ method: init.method ?? 'GET', url, headers, init });
    const u = new URL(url);
    const why = verifySignature(init.method ?? 'GET', u, headers);
    if (why !== null || opts.deny === true)
      // 本物の SignatureDoesNotMatch の本文はアクセスキー ID・署名の元の字・正規のリクエストを返す
      return new Response(
        `<Error><Code>${opts.deny === true ? (opts.denyCode ?? 'AccessDenied') : 'SignatureDoesNotMatch'}</Code><Message>${why ?? 'no'}</Message><AWSAccessKeyId>${SECRET.accessKeyId}</AWSAccessKeyId><StringToSign>AWS4-HMAC-SHA256 x</StringToSign><CanonicalRequest>GET /my%20notes x-amz-content-sha256</CanonicalRequest><SignatureProvided>${headers['authorization'] ?? ''}</SignatureProvided></Error>`,
        { status: 403 },
      );
    const parts = u.pathname.split('/').slice(1).map(decodeURIComponent);
    const bucket = parts[0]!;
    const key = parts.slice(1).join('/');
    if (bucket !== 'my notes') return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 });
    const body = init.body instanceof Uint8Array ? init.body : new Uint8Array();
    if (init.method === 'PUT') {
      // 本文の SHA-256 と署名の見出しが合うこと(合わなければ S3 は断る)
      const sha = sha256hex(body);
      if (headers['x-amz-content-sha256'] !== sha) return new Response('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>', { status: 400 });
      const cur = objects.get(key);
      const im = headers['if-match'];
      const inm = headers['if-none-match'];
      if (opts.conflict409 === true && (im !== undefined || inm !== undefined))
        return new Response('<Error><Code>ConditionalRequestConflict</Code></Error>', { status: 409 });
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
      const all = [...objects.keys()].filter((k) => opts.ignorePrefix === true || k.startsWith(prefix)).sort();
      const size = opts.pageSize ?? 1000;
      const tok = u.searchParams.get('continuation-token');
      const start = tok === null ? 0 : (tokens.get(tok) ?? -1);
      if (start < 0) return new Response('<Error><Code>InvalidArgument</Code></Error>', { status: 400 });
      const page = all.slice(start, start + size);
      const more = start + size < all.length;
      const nextTok = (opts.tokenOf ?? String)(start + size);
      tokens.set(nextTok, start + size);
      const quote = (t: string): string => t.replace(/"/g, opts.numericEntities === true ? '&#34;' : '&quot;');
      const esc = (t: string): string => (opts.numericEntities === true ? t.replace(/&/g, '&#38;') : t.replace(/&/g, '&amp;'));
      const xml = `<ListBucketResult>${page.map((k) => `<Contents><Key>${esc(k)}</Key><LastModified>${objects.get(k)!.mtime}</LastModified><ETag>${quote(objects.get(k)!.etag)}</ETag><Size>${String(objects.get(k)!.body.byteLength)}</Size></Contents>`).join('')}<IsTruncated>${String(more)}</IsTruncated>${more && opts.dropToken !== true ? `<NextContinuationToken>${esc(nextTok)}</NextContinuationToken>` : ''}</ListBucketResult>`;
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
    expect(put.headers['x-amz-content-sha256']).toBe(sha256hex('hello'));
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

  it('🔴 作り物の S3 は署名を自前で検算している(秘密を変えると 403 になる ── 検算が空振りしていない)', async () => {
    const s = fakeS3();
    const bad = new S3Box({ config: CONFIG, secret: { ...SECRET, secretAccessKey: 'wrong' }, crypto: webSigCrypto(), fetch: s.fetch, now: () => new Date('2026-11-22T00:00:00Z') });
    const err = await bad.list(() => true).then(() => new Error('通ってしまった'), (e: unknown) => e as Error);
    expect(err.name).toBe('NotAllowedError');
    expect(err.message).toContain('SignatureDoesNotMatch');
    // 🔴 本文の秘密(アクセスキー ID・署名の元の字・正規のリクエスト)を失敗の字に混ぜない
    for (const leak of [SECRET.accessKeyId, 'StringToSign', 'CanonicalRequest', 'AWS4-HMAC', 'x-amz', 'Signature=', 'SignatureProvided']) 
      expect(err.message, `失敗の字に ${leak} が入った`).not.toContain(leak);
  });

  it('応答の Code は英数字だけを出す(改行・空白・記号を落とす)', async () => {
    const err = await box(fakeS3({ deny: true, denyCode: 'Access Denied\n" secret=AKIA' })).list(() => true).then(() => new Error('通ってしまった'), (e: unknown) => e as Error);
    expect(err.message).toBe('一覧を読む: 保管先がエラーを返しました(403 AccessDeniedsecretAKIA)');
  });

  it('🔴 MinIO 形の一覧(ETag の引用符が &#34;)でも、書いた版と一覧の版が同じ字になる', async () => {
    const s = fakeS3({ numericEntities: true });
    const b = box(s);
    const after = await b.write('pkc3-a&b.pkc3-diff.zip', new Blob(['x']));
    const [listed] = await b.list(() => true);
    expect(listed).toMatchObject({ name: 'pkc3-a&b.pkc3-diff.zip', version: after.version });
    // 一覧の版で条件付き書き込みが通る(412 にならない)
    await b.write('pkc3-a&b.pkc3-diff.zip', new Blob(['y']), listed!);
  });

  it('🔴 409 ConditionalRequestConflict は 412 と同じく上書きせずに止める', async () => {
    const s = fakeS3({ conflict409: true });
    const err = await box(s).write('pkc3-me.pkc3-diff.zip', new Blob(['x']), null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoxConflictError);
    expect(s.objects.size).toBe(0);
  });

  it('続きのトークンに + / = が入っても、そのまま送り返す(署名も通る)', async () => {
    const s = fakeS3({ pageSize: 1, tokenOf: (i) => `ab+/c==${String(i)}` });
    const b = box(s);
    for (const id of ['a', 'b', 'c']) await b.write(`pkc3-${id}.pkc3-diff.zip`, new Blob([id]));
    expect((await b.list(() => true)).map((e) => e.name)).toEqual(['a', 'b', 'c'].map((id) => `pkc3-${id}.pkc3-diff.zip`));
  });

  it('🔴 続きがあると言うのにトークンが無い応答は、途中までを全部と読まずに失敗する', async () => {
    const s = fakeS3({ pageSize: 1, dropToken: true });
    const b = box(s);
    for (const id of ['a', 'b']) await b.write(`pkc3-${id}.pkc3-diff.zip`, new Blob([id]));
    await expect(b.list(() => true)).rejects.toThrow('続き');
  });

  it('🔴 一覧の応答に置き場の外の物が混ざっても拾わない / 問い合わせは置き場の直下(delimiter=/)', async () => {
    const s = fakeS3({ ignorePrefix: true });
    const b = box(s);
    await b.write('pkc3-aaaa.pkc3-diff.zip', new Blob(['x']));
    s.objects.set('other/pkc3-cccc.pkc3-diff.zip', { body: new Uint8Array([1]), etag: '"o"', mtime: '2026-11-22T00:00:00.000Z' });
    s.objects.set('pkc3/sub/pkc3-bbbb.pkc3-diff.zip', { body: new Uint8Array([1]), etag: '"z"', mtime: '2026-11-22T00:00:00.000Z' });
    expect((await b.list(() => true)).map((e) => e.name)).toEqual(['pkc3-aaaa.pkc3-diff.zip']);
    const q = new URL(s.seen.at(-1)!.url).searchParams;
    expect([q.get('list-type'), q.get('prefix'), q.get('delimiter')]).toEqual(['2', 'pkc3/', '/']);
  });

  it('🔴 fetch は cookie を送らず(credentials: omit)・CORS・キャッシュを使わない', async () => {
    const s = fakeS3();
    const b = box(s);
    await b.write('pkc3-me.pkc3-diff.zip', new Blob(['x']));
    await b.list(() => true);
    await b.read('pkc3-me.pkc3-diff.zip');
    await b.remove('pkc3-me.pkc3-diff.zip');
    expect(s.seen.map((x) => x.method)).toEqual(['PUT', 'GET', 'GET', 'DELETE']);
    for (const x of s.seen) expect([x.init.credentials, x.init.mode, x.init.cache]).toEqual(['omit', 'cors', 'no-store']);
  });
});

describe('parseListObjects', () => {
  it('XML の実体参照を戻し、続きのトークンを読む', () => {
    const r = parseListObjects('<ListBucketResult><Contents><Key>a&amp;b</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;x&quot;</ETag><Size>3</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken></ListBucketResult>');
    expect(r).toEqual({ items: [{ key: 'a&b', size: 3, mtime: Date.parse('2026-01-01T00:00:00.000Z'), etag: '"x"' }], next: 't1' });
  });

  it('🔴 数値の参照(&#34; / &#x22;)も戻す / &amp;quot; は " にしない', () => {
    const r = parseListObjects('<ListBucketResult><Contents><Key>a&amp;quot;b&#38;c</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&#34;x&#x22;</ETag><Size>3</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>');
    expect(r.items[0]).toMatchObject({ key: 'a&quot;b&c', etag: '"x"' });
    expect(r.next).toBeNull();
  });

  it('続きがあるのにトークンが無ければ投げる', () => {
    expect(() => parseListObjects('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>')).toThrow('続き');
  });
});
