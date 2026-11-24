/**
 * 🔴 **同期の保管先の暗号化の層(`EncryptedBox`)**(#2000 段 4b-A)── `RemoteBox` を包み、差分ファイルを**書くときに暗号化**、
 * **読むときに復号**する。形式・AAD・鍵の扱いは `features/sync/e2e-crypto.ts`(純粋)、ここは保管先との読み書きだけ。
 *
 * ## 名前
 * - 暗号化したファイルは `pkc3-<端末>.pkc3-diff.zip.enc`(`encFileName`)。平文(`….pkc3-diff.zip`)とは名前で分ける。
 * - `list` / `remove` は包んだ保管先をそのまま通す(平文と暗号化の両方の名前が見える ── 見分けて扱うのは同期の回)。
 * - `read` は `.enc` の名前なら復号して**平文**を返す(平文の名前はそのまま通す = 移行の間、まだ暗号化していない相手も読める)。
 * - `write` は `.enc` の名前 + `meta`(端末 id・連番)が要る。⚠ 平文を黙って書かない。
 *
 * ## 暗号化キーの束(`keyring.json`)
 * - 置き場の差分ファイルと同じ階層。**作る**のは `If-None-Match: *`(S3)── 同時に 2 台が作っても、先に在った方を採る(`ensureKeyring`)。
 *   フォルダは条件付き書き込みが無いので、**書いたあと読み直して `keyId` を照らし**、違えば先に在った方を採用する(自分の作った鍵は捨てる)。
 * - **パスフレーズの変更(包み直し)**は `If-Match: <ETag>`(`rewrapKeyring`)。412 は**上書きせずに** `KeyringConflictError` で止める。
 * - ⚠ 秘密(パスフレーズ・回復キー・データ鍵の bytes)はここを通らない(keyring.json は包んだ形だけ)。
 */
import { E2EError, decryptDiff, encryptDiff, type E2ECrypto, type OpenedKey } from '@features/sync/e2e-crypto';
import { KEYRING_NAME, KeyringFormatError, parseKeyring, serializeKeyring, type Keyring } from '@features/sync/keyring';
import { deviceOfFileName, isEncFileName } from '@features/sync/sync-folder';
import { BoxConflictError } from './s3-box';
import type { BoxEntry, ReadMeta, RemoteBox, WriteMeta } from './sync-box';

/** 窓の `crypto`(`subtle` と乱数)。 */
export function webE2ECrypto(): E2ECrypto {
  return { subtle: globalThis.crypto.subtle, random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)) };
}

/** 暗号化キーの束を書き換えようとしたら、別の端末が先に変えていた(412)── 上書きしていない。読み直してからやり直す。 */
export class KeyringConflictError extends Error {
  constructor(message = '別の端末が先に暗号化キーの束を変更したため、上書きしませんでした(再読み込みしてからやり直してください)') {
    super(message);
    this.name = 'KeyringConflictError';
  }
}

export interface EncryptedBoxOptions {
  readonly inner: RemoteBox;
  readonly crypto: E2ECrypto;
  /** 開いた暗号化キー(無ければ `null` ── 差分の読み書きは `locked` で断る。暗号化キーの束の読み書きだけはできる)。 */
  readonly key: OpenedKey | null;
}

const MAX_KEYRING_BYTES = 4096;

export class EncryptedBox implements RemoteBox {
  readonly label: string;
  constructor(private readonly o: EncryptedBoxOptions) {
    this.label = o.inner.label;
  }

  list(accept: (name: string) => boolean): Promise<BoxEntry[]> {
    return this.o.inner.list(accept);
  }

  remove(name: string): Promise<void> {
    return this.o.inner.remove(name);
  }

  private needKey(): OpenedKey {
    if (this.o.key === null) throw new E2EError('locked', '暗号化キーがまだ開かれていません(パスフレーズを入力してください)');
    return this.o.key;
  }

  async readWithMeta(name: string): Promise<{ blob: Blob; meta: ReadMeta | null }> {
    const raw = await this.o.inner.read(name);
    if (!isEncFileName(name)) return { blob: raw, meta: null };
    const key = this.needKey();
    const { plain, header } = await decryptDiff(this.o.crypto, raw, {
      dataKey: key.dataKey,
      keyId: key.keyId,
      expectName: name,
      expectDevice: deviceOfFileName(name) as string,
    });
    return { blob: plain, meta: { device: header.device, seq: header.seq } };
  }

  async read(name: string): Promise<Blob> {
    return (await this.readWithMeta(name)).blob;
  }

  async write(name: string, blob: Blob, expect?: BoxEntry | null, meta?: WriteMeta): Promise<BoxEntry> {
    if (!isEncFileName(name)) throw new E2EError('format', '暗号化の層は .enc の名前にだけ書きます(平文を黙って書きません)');
    if (meta === undefined) throw new E2EError('format', '暗号化して書くには端末 ID と連番が要ります');
    if (deviceOfFileName(name) !== meta.device) throw new E2EError('mismatch', 'ファイル名の端末 ID と書く端末 ID が違います');
    const key = this.needKey();
    const enc = await encryptDiff(this.o.crypto, blob, { dataKey: key.dataKey, keyId: key.keyId, device: meta.device, seq: meta.seq, name });
    return this.o.inner.write(name, enc, expect);
  }

  // ───────────── 暗号化キーの束 ─────────────

  /** 置き場の暗号化キーの束と、その版(S3 の ETag)。無ければ `null`。形が壊れていれば `KeyringFormatError`。 */
  async loadKeyring(): Promise<{ keyring: Keyring; version?: string } | null> {
    const entries = await this.o.inner.list((n) => n === KEYRING_NAME);
    const e = entries.find((x) => x.name === KEYRING_NAME);
    if (e === undefined) return null;
    let blob: Blob;
    try {
      blob = await this.o.inner.read(KEYRING_NAME);
    } catch (err) {
      if (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'NotFoundError') return null; // 一覧のあとに消えた
      throw err;
    }
    if (blob.size > MAX_KEYRING_BYTES) throw new KeyringFormatError('暗号化キーの束(keyring.json)を読めません: 大きすぎます');
    return { keyring: parseKeyring(await blob.text()), ...(e.version === undefined ? {} : { version: e.version }) };
  }

  /**
   * 暗号化キーの束を**作る**(初回)。先に在れば作らず、在った方を返す。
   * @returns `created: true` = 自分の `candidate` が置き場に載った(自分の暗号化キーがそのまま使える)/
   *   `false` = 先に別の束が在った(**自分で作った暗号化キーは捨て**、返った束をパスフレーズで開く)
   */
  async ensureKeyring(candidate: Keyring): Promise<{ keyring: Keyring; created: boolean }> {
    const have = await this.loadKeyring();
    if (have !== null) return { keyring: have.keyring, created: false };
    try {
      // 🔑 S3 は `expect = null` → If-None-Match: *(在れば 412)。フォルダは条件が無いので、書いたあと読み直して照らす
      await this.o.inner.write(KEYRING_NAME, new Blob([serializeKeyring(candidate)], { type: 'application/json' }), null);
    } catch (e) {
      if (!(e instanceof BoxConflictError)) throw e;
      const now = await this.loadKeyring();
      if (now !== null) return { keyring: now.keyring, created: false };
      throw e;
    }
    const after = await this.loadKeyring();
    if (after === null) throw new Error('暗号化キーの束を書いた直後に読めませんでした(もう一度やり直してください)');
    return { keyring: after.keyring, created: after.keyring.keyId === candidate.keyId };
  }

  /**
   * パスフレーズの変更・付け直し = 包み直した束で**置き換える**(同じ `keyId` だけ)。S3 は `If-Match: <読んだときの ETag>`。
   * ⚠ 別の端末が先に変えていたら(412)**上書きせず** `KeyringConflictError`。別の `keyId` の束は置き換えない。
   */
  async rewrapKeyring(next: Keyring): Promise<{ keyring: Keyring; version?: string }> {
    const cur = await this.loadKeyring();
    if (cur === null) throw new E2EError('format', '置き場に暗号化キーの束がありません');
    if (cur.keyring.keyId !== next.keyId) throw new KeyringConflictError('置き場の暗号化キーの束は別の暗号化キーです(置き換えません)');
    const expect: BoxEntry | null = cur.version === undefined ? null : { name: KEYRING_NAME, size: 0, mtime: 0, version: cur.version };
    try {
      const after = await this.o.inner.write(KEYRING_NAME, new Blob([serializeKeyring(next)], { type: 'application/json' }), expect);
      return { keyring: next, ...(after.version === undefined ? {} : { version: after.version }) };
    } catch (e) {
      if (e instanceof BoxConflictError) throw new KeyringConflictError();
      throw e;
    }
  }
}
