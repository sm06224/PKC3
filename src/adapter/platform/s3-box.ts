/**
 * 🔴 **S3 互換の保管先**(#2000 段 4a-3。user 裁定 2026-11-22)── `RemoteBox` の S3 の実装(AWS S3 / Cloudflare R2 / MinIO など)。
 *
 * ## 作法
 * - **path-style**: `<endpoint>/<bucket>/<prefix><name>`(仮想ホスト形式を使わない ── R2・MinIO・自前のサーバで同じ形)
 * - 署名は `features/sync/sigv4.ts`(WebCrypto の HMAC-SHA256。公式のテスト値で検証済み)。本文の SHA-256 を
 *   `x-amz-content-sha256` に載せて署名する(`UNSIGNED-PAYLOAD` にしない)
 * - 版の印は **ETag**(一覧の `<ETag>` / PUT の応答の `ETag` 見出し)
 *
 * ## 🔴 条件付き書き込み(user の必須ガード)
 * - 前に自分が書いた版が在れば **`If-Match: <ETag>`**、無ければ **`If-None-Match: *`**(在れば書かない)で PUT する
 * - **`412 Precondition Failed` は上書きせずに止める**(`BoxConflictError`)── 誰かが同じ名前のファイルを書き換えた / 作った。
 *   読み直してやり直すのは回(`SyncFolder.round`)の次の回の仕事(ここは書かずに投げるだけ)
 *
 * ## 🔴 失敗の字に秘密を混ぜない
 * - 投げるエラーの字は「何をしたか + 状態コード + S3 のエラーの Code」だけ。URL のクエリ・`Authorization`・鍵の字は入れない
 * - `403` は `NotAllowedError`、`404`(バケットが無い)は `NotFoundError` の名前で投げる(回が「選び直し」と読む ── 段 3 と同じ読み方)
 * - fetch そのものが落ちた(CORS の設定が無い・繋がらない)ときは理由が JS から見えない ── 「CORS の設定を確かめてください」と言う
 */
import { EMPTY_SHA256, signV4, uriEncode, type SigCrypto } from '@features/sync/sigv4';
import type { S3BoxConfig, S3BoxSecret } from './sync-keystore';
import type { BoxEntry, RemoteBox } from './sync-box';

/** 条件付き書き込みで、相手が先に書き換えていた(412)。⚠ 書いていない。 */
export class BoxConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoxConflictError';
  }
}

export interface S3BoxDeps {
  readonly config: S3BoxConfig;
  readonly secret: S3BoxSecret;
  readonly crypto: SigCrypto;
  /** 既定は窓の `fetch`(test では作り物)。 */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
}

/** WebCrypto の `SigCrypto`(adapter が渡す)。 */
export function webSigCrypto(subtle: SubtleCrypto = globalThis.crypto.subtle): SigCrypto {
  const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return {
    sha256Hex: async (d) => hex(await subtle.digest('SHA-256', d as Uint8Array<ArrayBuffer>)),
    hmac: async (key, data) => {
      const k = await subtle.importKey('raw', key as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return new Uint8Array(await subtle.sign('HMAC', k, data as Uint8Array<ArrayBuffer>));
    },
  };
}

const xmlText = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m === null ? null : xmlText(m[1]!);
};

/** S3 の一覧(ListObjectsV2)の応答を読む(`Contents` ごと)。⚠ pure に近い ── 正規表現の小さな読み手(XML の全部は読まない)。 */
export function parseListObjects(xml: string): { items: { key: string; size: number; mtime: number; etag: string }[]; next: string | null } {
  const items: { key: string; size: number; mtime: number; etag: string }[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const c = m[1]!;
    const key = tag(c, 'Key');
    if (key === null) continue;
    const t = Date.parse(tag(c, 'LastModified') ?? '');
    items.push({ key, size: Number(tag(c, 'Size') ?? '0'), mtime: Number.isFinite(t) ? t : 0, etag: tag(c, 'ETag') ?? '' });
  }
  const truncated = tag(xml, 'IsTruncated') === 'true';
  return { items, next: truncated ? tag(xml, 'NextContinuationToken') : null };
}

export class S3Box implements RemoteBox {
  readonly label: string;
  private readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>;

  constructor(private readonly deps: S3BoxDeps) {
    this.label = deps.config.bucket;
    this.fetchFn = deps.fetch ?? ((u, i) => globalThis.fetch(u, i));
  }

  /** `/bucket/prefix+name`(エンコード前)。 */
  private path(name: string): string {
    return `/${this.deps.config.bucket}/${this.deps.config.prefix}${name}`;
  }

  private async send(
    what: string,
    method: string,
    path: string,
    opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: Uint8Array<ArrayBuffer> } = {},
  ): Promise<Response> {
    const url = new URL(this.deps.config.endpoint);
    const payloadHash = opts.body === undefined ? EMPTY_SHA256 : await this.deps.crypto.sha256Hex(opts.body);
    const headers: Record<string, string> = { host: url.host, ...(opts.headers ?? {}) };
    const signed = await signV4(
      { method, path, ...(opts.query === undefined ? {} : { query: opts.query }), headers, payloadHash },
      this.deps.secret,
      this.deps.config.region,
      this.deps.now?.() ?? new Date(),
      this.deps.crypto,
    );
    const { host: _host, ...sendHeaders } = { ...headers, ...signed };
    void _host; // `host` はブラウザが付ける(送る見出しに入れられない)── 署名にだけ入れる
    // 🔴 送る URL も署名と同じ 1 つのエンコード(`uriEncode`)で組む ── 2 つの作り方を持つと、署名した字と送った字が食い違う
    const q = Object.entries(opts.query ?? {})
      .map(([k, v]) => `${uriEncode(k, false)}=${uriEncode(v, false)}`)
      .join('&');
    const target = `${url.origin}${uriEncode(path, true)}${q === '' ? '' : `?${q}`}`;
    let res: Response;
    try {
      res = await this.fetchFn(target, { method, headers: sendHeaders, ...(opts.body === undefined ? {} : { body: opts.body }), mode: 'cors', credentials: 'omit', cache: 'no-store' });
    } catch {
      // ⚠ 理由は JS から見えない(CORS の拒否・繋がらない・名前が引けない)── URL も鍵も出さない
      throw Object.assign(new Error(`${what}: 保管先に接続できませんでした(保管先の CORS の設定と、エンドポイントを確かめてください)`), { name: 'NetworkError' });
    }
    return res;
  }

  /** 失敗の応答を、秘密を混ぜない字のエラーにする。 */
  private async fail(what: string, res: Response): Promise<never> {
    const code = tag(await res.text().catch(() => ''), 'Code');
    const msg = `${what}: 保管先がエラーを返しました(${String(res.status)}${code === null ? '' : ` ${code.replace(/[^A-Za-z0-9]/g, '')}`})`;
    if (res.status === 412) throw new BoxConflictError(`${msg}。別の端末が同じファイルを書き換えたので、上書きしませんでした`);
    const name = res.status === 403 || res.status === 401 ? 'NotAllowedError' : res.status === 404 ? 'NotFoundError' : 'Error';
    throw Object.assign(new Error(msg), { name });
  }

  async list(accept: (name: string) => boolean): Promise<BoxEntry[]> {
    const out: BoxEntry[] = [];
    const prefix = this.deps.config.prefix;
    let token: string | null = null;
    for (let page = 0; page < 1000; page += 1) {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token !== null) query['continuation-token'] = token;
      const res = await this.send('一覧を読む', 'GET', `/${this.deps.config.bucket}`, { query });
      if (!res.ok) await this.fail('一覧を読む', res);
      const { items, next } = parseListObjects(await res.text());
      for (const it of items) {
        if (!it.key.startsWith(prefix)) continue;
        const name = it.key.slice(prefix.length);
        // ⚠ 下の階層(`a/b`)は見ない(同期のファイルは置き場の直下だけ)
        if (name === '' || name.includes('/') || !accept(name)) continue;
        out.push({ name, size: it.size, mtime: it.mtime, version: it.etag });
      }
      if (next === null) return out;
      token = next;
    }
    throw new Error('一覧を読む: 保管先の一覧が多すぎます');
  }

  async read(name: string): Promise<Blob> {
    const res = await this.send('ファイルを読む', 'GET', this.path(name));
    if (!res.ok) await this.fail('ファイルを読む', res);
    return res.blob();
  }

  async write(name: string, blob: Blob, expect?: BoxEntry | null): Promise<BoxEntry> {
    const body = new Uint8Array(await blob.arrayBuffer());
    // 🔴 条件付き書き込み ── 前に書いた版が在ればその版のときだけ、無ければ無いときだけ書く(412 なら上書きしない)
    const cond: Record<string, string> =
      expect?.version !== undefined && expect.version !== '' ? { 'if-match': expect.version } : { 'if-none-match': '*' };
    const res = await this.send('自分のファイルを書く', 'PUT', this.path(name), {
      headers: { ...cond, 'content-type': 'application/zip' },
      body,
    });
    if (!res.ok) await this.fail('自分のファイルを書く', res);
    const etag = res.headers.get('etag');
    if (etag === null || etag === '') {
      // ⚠ ETag が見えない = CORS の `ExposeHeaders` に ETag が無い ── 版が分からないと次の回の条件付き書き込みができない
      throw new Error('自分のファイルを書く: 保管先が ETag を返しません(保管先の CORS の設定で ETag を見せるようにしてください)');
    }
    return { name, size: body.byteLength, mtime: 0, version: etag };
  }

  async remove(name: string): Promise<void> {
    const res = await this.send('古いファイルを消す', 'DELETE', this.path(name));
    if (!res.ok && res.status !== 404) await this.fail('古いファイルを消す', res);
  }
}
