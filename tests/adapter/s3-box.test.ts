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
import { describe, expect, it } from 'vitest';
import { fakeS3 as fakeS3With, sha256hex } from '../helpers/fake-s3';
import { S3_CORS_ALLOWED_HEADERS, S3_CORS_ALLOWED_METHODS, s3CorsTemplate } from '../../src/features/sync/s3-cors';
import { BoxConflictError, parseListObjects, S3Box, webSigCrypto } from '../../src/adapter/platform/s3-box';
import type { S3BoxConfig } from '../../src/adapter/platform/sync-keystore';

const CONFIG: S3BoxConfig = { kind: 's3', endpoint: 'https://s3.example.test', bucket: 'my notes', region: 'auto', prefix: 'pkc3/' };
const SECRET = { accessKeyId: 'AKIA-TEST-ID', secretAccessKey: 'TOP/SECRET+value' };
const fakeS3 = (opts: Parameters<typeof fakeS3With>[1] = {}): ReturnType<typeof fakeS3With> => fakeS3With(SECRET, opts);

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

  it('🔴 CORS の設定の例は、S3Box が実際に送る見出し・メソッドを全部許し、ETag を見せる', async () => {
    const s = fakeS3();
    const b = box(s);
    const first = await b.write('pkc3-me.pkc3-diff.zip', new Blob(['x']));
    await b.write('pkc3-me.pkc3-diff.zip', new Blob(['y']), first);
    await b.list(() => true);
    await b.read('pkc3-me.pkc3-diff.zip');
    await b.remove('pkc3-me.pkc3-diff.zip');
    const sent = new Set(s.seen.flatMap((x) => Object.keys(x.headers)));
    // 対照群: 条件付き書き込みの 2 つの見出しが実際に送られている(空振りでない)
    expect([...sent]).toEqual(expect.arrayContaining(['if-match', 'if-none-match', 'authorization', 'x-amz-date']));
    const tpl = JSON.parse(s3CorsTemplate('https://notes.example.org')) as { AllowedOrigins: string[]; AllowedHeaders: string[]; AllowedMethods: string[]; ExposeHeaders: string[] }[];
    expect(tpl[0]!.AllowedOrigins).toEqual(['https://notes.example.org']);
    for (const h of sent) expect(tpl[0]!.AllowedHeaders, `CORS の例に ${h} が無い`).toContain(h);
    for (const m of new Set(s.seen.map((x) => x.method))) expect(tpl[0]!.AllowedMethods, `CORS の例に ${m} が無い`).toContain(m);
    expect(tpl[0]!.ExposeHeaders).toContain('ETag');
    expect([...S3_CORS_ALLOWED_HEADERS].sort()).toEqual([...tpl[0]!.AllowedHeaders].sort());
    expect([...S3_CORS_ALLOWED_METHODS]).toEqual(tpl[0]!.AllowedMethods);
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
