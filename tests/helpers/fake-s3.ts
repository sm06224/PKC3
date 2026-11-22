/**
 * 作り物の S3(メモリの中・ETag・条件付き書き込み・続きのトークン)。**受け取った URL と見出しだけから SigV4 を node:crypto で検算する**
 * (実装の `signV4` を呼ばない ── 期待値を実装と同じ盲点で作らない)。`tests/adapter/s3-box.test.ts` と同期の実行部の test が使う。
 * ⚠ バケット名は `my notes` 固定(空白のエンコードを常に通す)。
 */
import { createHash, createHmac } from 'node:crypto';

export interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  init: RequestInit;
}

/** RFC 3986 の非予約文字以外をエンコード(実装の uriEncode とは別に書く ── 期待値を実装と同じ盲点で作らない)。 */
const rfc3986 = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const sha256hex = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/**
 * 🔴 **受け取った URL と見出しだけから SigV4 を検算する**(node:crypto の HMAC。実装の signV4 は呼ばない)。
 * 合わなければ本物の S3 と同じく 403 SignatureDoesNotMatch(本文にアクセスキー ID と署名の元の字を含む)を返す。
 */
function verifySignature(secret: { accessKeyId: string; secretAccessKey: string }, method: string, u: URL, headers: Record<string, string>): string | null {
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(headers['authorization'] ?? '');
  if (m === null) return 'Authorization の形が違う';
  const [, akid, day, region, signedList, sig] = m as unknown as [string, string, string, string, string, string];
  if (akid !== secret.accessKeyId) return 'アクセスキー ID が違う';
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
  let k: Buffer = createHmac('sha256', `AWS4${secret.secretAccessKey}`).update(day).digest();
  for (const part of [region, 's3', 'aws4_request']) k = createHmac('sha256', k).update(part).digest();
  return createHmac('sha256', k).update(toSign).digest('hex') === sig ? null : '署名が合わない';
}

/** メモリの S3(必要な所だけ)。 */
export type FakeS3 = ReturnType<typeof fakeS3>;

export function fakeS3(
  secret: { accessKeyId: string; secretAccessKey: string },
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
    /** PUT の条件を見る直前に呼ぶ(別の端末がその間に書いた、を作る)。 */
    beforePut?: (key: string) => void;
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
    const why = verifySignature(secret, init.method ?? 'GET', u, headers);
    if (why !== null || opts.deny === true)
      // 本物の SignatureDoesNotMatch の本文はアクセスキー ID・署名の元の字・正規のリクエストを返す
      return new Response(
        `<Error><Code>${opts.deny === true ? (opts.denyCode ?? 'AccessDenied') : 'SignatureDoesNotMatch'}</Code><Message>${why ?? 'no'}</Message><AWSAccessKeyId>${secret.accessKeyId}</AWSAccessKeyId><StringToSign>AWS4-HMAC-SHA256 x</StringToSign><CanonicalRequest>GET /my%20notes x-amz-content-sha256</CanonicalRequest><SignatureProvided>${headers['authorization'] ?? ''}</SignatureProvided></Error>`,
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
      opts.beforePut?.(key);
      const cur = objects.get(key);
      const im = headers['if-match'];
      const inm = headers['if-none-match'];
      if (opts.conflict409 === true && (im !== undefined || inm !== undefined))
        return new Response('<Error><Code>ConditionalRequestConflict</Code></Error>', { status: 409 });
      if ((im !== undefined && cur?.etag !== im) || (inm === '*' && cur !== undefined)) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      const etag = `"e${String(++n)}"`;
      objects.set(key, { body, etag, mtime: new Date(Date.UTC(2026, 10, 22) + n * 1000).toISOString() });
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

