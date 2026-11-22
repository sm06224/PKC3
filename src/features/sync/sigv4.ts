/**
 * 🔴 **AWS 署名 v4(SigV4)── S3 互換の保管先へのリクエストに付ける署名**(#2000 段 4a-3。user 裁定 2026-11-22:
 * 依存を入れず WebCrypto の HMAC-SHA256 で自前実装し、AWS の公式のテスト値で検証する)。
 *
 * ⚠ pure(暗号の計算は `SigCrypto` で受ける ── adapter が `crypto.subtle` を渡す。features は browser API を持たない)。
 *
 * ## 落とし穴(user 指摘)
 * - **URI のエンコード**は RFC 3986 の「予約しない字」(`A-Z a-z 0-9 - . _ ~`)以外を `%XX`(大文字)にする。
 *   S3 は**パスの `/` を残し、二重にエンコードしない**(他のサービスと違う ── `encodeURIComponent` は `!'()*` を残すので使わない)。
 * - **`x-amz-content-sha256`** は署名する本文の SHA-256(hex)。本文が無ければ空の SHA-256(`e3b0c442…`)。
 * - **path-style**(`https://<endpoint>/<bucket>/<key>`)── 呼び手(`S3Box`)がパスを組む。ここはパスを受けて署名するだけ。
 */

/** 署名に要る暗号の計算(adapter が WebCrypto で渡す)。 */
export interface SigCrypto {
  sha256Hex(data: Uint8Array): Promise<string>;
  hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
}

export interface SigV4Request {
  readonly method: string;
  /** エンコード前のパス(`/bucket/pkc3/a b.zip`)。 */
  readonly path: string;
  /** クエリ(エンコード前)。 */
  readonly query?: Readonly<Record<string, string>>;
  /** 署名する見出し(名前は大小どちらでも)。`host` は必須。`x-amz-date` / `x-amz-content-sha256` はここで足す。 */
  readonly headers: Readonly<Record<string, string>>;
  /** 本文の SHA-256(hex)。無ければ空の本文の値。 */
  readonly payloadHash: string;
}

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const enc = new TextEncoder();
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** RFC 3986 の予約しない字以外を `%XX`(大文字)。`keepSlash` ならパスの `/` を残す。⚠ 1 度だけ(二重にしない)。 */
export function uriEncode(s: string, keepSlash: boolean): string {
  let out = '';
  for (const byte of enc.encode(s)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** `YYYYMMDDTHHMMSSZ` と `YYYYMMDD`。 */
export function amzDates(now: Date): { amzDate: string; date: string } {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, date: iso.slice(0, 8) };
}

/** 正規のリクエスト(canonical request)と、署名した見出しの名前の並び。 */
export function canonicalRequest(req: SigV4Request & { readonly headers: Readonly<Record<string, string>> }): { text: string; signed: string } {
  const q = Object.entries(req.query ?? {})
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const hs = Object.entries(req.headers)
    .map(([k, v]) => [k.toLowerCase().trim(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signed = hs.map(([k]) => k).join(';');
  const text = [
    req.method.toUpperCase(),
    uriEncode(req.path, true),
    q,
    hs.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed,
    req.payloadHash,
  ].join('\n');
  return { text, signed };
}

/**
 * 署名して、付ける見出し(`Authorization` / `x-amz-date` / `x-amz-content-sha256`)を返す。
 * @param service 既定 `s3`
 */
export async function signV4(
  req: SigV4Request,
  cred: SigV4Credentials,
  region: string,
  now: Date,
  c: SigCrypto,
  service = 's3',
): Promise<Record<string, string>> {
  const { amzDate, date } = amzDates(now);
  const headers: Record<string, string> = { ...req.headers, 'x-amz-date': amzDate, 'x-amz-content-sha256': req.payloadHash };
  const { text, signed } = canonicalRequest({ ...req, headers });
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await c.sha256Hex(enc.encode(text))].join('\n');
  let k = await c.hmac(enc.encode(`AWS4${cred.secretAccessKey}`), enc.encode(date));
  k = await c.hmac(k, enc.encode(region));
  k = await c.hmac(k, enc.encode(service));
  k = await c.hmac(k, enc.encode('aws4_request'));
  const sig = hex(await c.hmac(k, enc.encode(toSign)));
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': req.payloadHash,
  };
}
