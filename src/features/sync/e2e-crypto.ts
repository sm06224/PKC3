/**
 * 🔴 **端末間の同期の暗号化(#2000 段 4b)── 差分ファイルの形式と、暗号化キーの扱い(純粋)**。
 *
 * ⚠ `SubtleCrypto` と乱数は**引数で受ける**(`E2ECrypto`)── この file はブラウザの口を直に呼ばない。
 *
 * ## 暗号化ファイルの形式(v1)
 * ```
 * [magic "PKC3E2E1" 8 bytes][header length u32 BE][header JSON utf-8]
 * [chunk 0 ciphertext+tag] … [chunk n-1 ciphertext+tag]
 * ```
 * - header = `{ v, keyId, device, seq, name, chunk, nonce, size }`(平文のまま置く。**ヘッダ全体(magic + 長さ + JSON の原文)を
 *   各塊の追加の認証データ(AAD)に入れる**ので、端末 id・連番・名前・暗号化キーの識別子の書き換えは復号で必ず落ちる)
 * - 平文を **1 MiB の塊**に分け、塊ごとに AES-256-GCM。塊 i の IV = nonce(8) ‖ u32 BE(i)(nonce はファイルごとの乱数)
 * - 塊 i の AAD = ヘッダの原文 ‖ u32 BE(i) ‖ u8(最後の塊なら 1)── 並べ替え・最後の塊の切り落とし・継ぎ足しを検出する
 * - 空の平文も塊を 1 個出す(最後の印を必ず持つ)
 * - メモリ: 1 塊ずつ `Blob.slice` で読む。出力は Blob の部品の並び(全体を 2 つ持たない)
 *
 * ## 暗号化キー(データ鍵)
 * - 乱数 256 bit の AES-GCM。**取り出せない(`extractable: false`)CryptoKey** として使う。生の bytes は作った/開いた直後の一瞬だけメモリにあり、
 *   包む(wrap)・取り込む(import)ためだけに使い、すぐ 0 で潰す。
 * - パスフレーズ(PBKDF2-HMAC-SHA256・600,000 回・塩 16 bytes)由来の鍵と、回復キー(乱数 160 bit・HKDF-SHA256)由来の鍵で、それぞれ包む。
 */
import { b64urlDecode, b64urlEncode } from './b64url';
import {
  KEY_ID_BYTES,
  PBKDF2_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  SALT_BYTES,
  WRAPPED_BYTES,
  buildKeyring,
  type Keyring,
} from './keyring';

/** 暗号の口(`subtle` と乱数)。 */
export interface E2ECrypto {
  readonly subtle: SubtleCrypto;
  random(n: number): Uint8Array<ArrayBuffer>;
}

export type E2EErrorCode =
  | 'format' // 形が違う・途中で切れている・継ぎ足されている
  | 'mismatch' // 名前・端末が期待と違う(差し替え・改名)
  | 'key-mismatch' // 別の暗号化キーで書かれた
  | 'auth' // 改ざん・壊れ・キーが違う(認証が通らない)
  | 'wrong-secret' // パスフレーズ / 回復キーが違う
  | 'bad-recovery' // 回復キーの字として読めない
  | 'weak-kdf' // PBKDF2 の回数が下限未満
  | 'locked' // 暗号化キーがまだ開かれていない
  | 'empty-passphrase';

/** 暗号化の失敗。⚠ 字にパスフレーズ・回復キー・鍵の bytes を混ぜない。 */
export class E2EError extends Error {
  constructor(
    readonly code: E2EErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'E2EError';
  }
}

export const E2E_MAGIC = 'PKC3E2E1';
export const E2E_CHUNK = 1_048_576;
export const GCM_TAG_BYTES = 16;
const MAX_HEADER_BYTES = 4096;
const UTF8 = new TextEncoder();
const UTF8_DEC = new TextDecoder('utf-8', { fatal: true });

export interface EncHeader {
  readonly v: 1;
  readonly keyId: string;
  readonly device: string;
  readonly seq: number;
  readonly name: string;
  readonly chunk: number;
  readonly nonce: string;
  readonly size: number;
}

const u32 = (n: number): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
};
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const chunkCount = (size: number): number => Math.max(1, Math.ceil(size / E2E_CHUNK));
const ivOf = (nonce: Uint8Array, i: number): Uint8Array<ArrayBuffer> => concat(nonce, u32(i));
const aadOf = (prefix: Uint8Array, i: number, last: boolean): Uint8Array<ArrayBuffer> => concat(prefix, u32(i), Uint8Array.of(last ? 1 : 0));

/** 暗号化したファイルの大きさ(平文の大きさから)。 */
export const encryptedSize = (prefixLen: number, plainSize: number): number => prefixLen + plainSize + GCM_TAG_BYTES * chunkCount(plainSize);

export interface EncryptOptions {
  readonly dataKey: CryptoKey;
  readonly keyId: string;
  readonly device: string;
  readonly seq: number;
  /** 置き場のファイル名(`pkc3-<端末>.pkc3-diff.zip.enc`)。 */
  readonly name: string;
}

/** 差分ファイル(平文)を暗号化する。 */
export async function encryptDiff(c: E2ECrypto, plain: Blob, o: EncryptOptions): Promise<Blob> {
  if (!Number.isSafeInteger(o.seq) || o.seq < 0) throw new E2EError('format', '連番が正しくありません');
  const nonce = c.random(8);
  const header: EncHeader = { v: 1, keyId: o.keyId, device: o.device, seq: o.seq, name: o.name, chunk: E2E_CHUNK, nonce: b64urlEncode(nonce), size: plain.size };
  const json = UTF8.encode(JSON.stringify(header));
  const prefix = concat(UTF8.encode(E2E_MAGIC), u32(json.length), json);
  const n = chunkCount(plain.size);
  const parts: BlobPart[] = [prefix];
  for (let i = 0; i < n; i += 1) {
    const buf = await plain.slice(i * E2E_CHUNK, Math.min(plain.size, (i + 1) * E2E_CHUNK)).arrayBuffer();
    const ct = await c.subtle.encrypt({ name: 'AES-GCM', iv: ivOf(nonce, i), additionalData: aadOf(prefix, i, i === n - 1), tagLength: 128 }, o.dataKey, buf);
    parts.push(ct);
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** ヘッダを読む(鍵は要らない。⚠ 中身の認証は復号のときに塊ごとに通る ── ここは形だけ)。 */
export async function readEncHeader(blob: Blob): Promise<{ header: EncHeader; prefix: Uint8Array<ArrayBuffer> }> {
  const bad = (m: string): never => {
    throw new E2EError('format', `暗号化したファイルを読めません: ${m}`);
  };
  if (blob.size < 12) return bad('短すぎます');
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (UTF8_DEC.decode(head.subarray(0, 8)) !== E2E_MAGIC) return bad('暗号化したファイルではありません');
  const len = new DataView(head.buffer).getUint32(8, false);
  if (len < 2 || len > MAX_HEADER_BYTES || 12 + len > blob.size) return bad('ヘッダの長さが正しくありません');
  const prefix = new Uint8Array(await blob.slice(0, 12 + len).arrayBuffer());
  let o: unknown;
  try {
    o = JSON.parse(UTF8_DEC.decode(prefix.subarray(12)));
  } catch {
    return bad('ヘッダを読めません');
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return bad('ヘッダの形が違います');
  const h = o as Record<string, unknown>;
  const keys = Object.keys(h).sort().join(',');
  if (keys !== 'chunk,device,keyId,name,nonce,seq,size,v') return bad('ヘッダの欄が違います');
  if (h.v !== 1) return bad('知らない版です(この版の PKC3 では読めません)');
  if (h.chunk !== E2E_CHUNK) return bad('ブロックの大きさが違います');
  if (typeof h.keyId !== 'string' || typeof h.device !== 'string' || typeof h.name !== 'string' || typeof h.nonce !== 'string') return bad('ヘッダの値が違います');
  if (!isInt(h.seq) || !isInt(h.size)) return bad('ヘッダの数が違います');
  const nonce = b64urlDecode(h.nonce);
  if (nonce === null || nonce.length !== 8) return bad('nonce が正しくありません');
  return { header: { v: 1, keyId: h.keyId, device: h.device, seq: h.seq, name: h.name, chunk: E2E_CHUNK, nonce: h.nonce, size: h.size }, prefix };
}

export interface DecryptOptions {
  readonly dataKey: CryptoKey;
  readonly keyId: string;
  /** 置き場で読んだファイル名(ヘッダの `name` と同じはず ── 改名・差し替えの検出)。 */
  readonly expectName: string;
  readonly expectDevice: string;
}

/** 復号する。どこか 1 つでも合わなければ `E2EError`(部分的な平文は返さない)。 */
export async function decryptDiff(c: E2ECrypto, blob: Blob, o: DecryptOptions): Promise<{ plain: Blob; header: EncHeader }> {
  const { header, prefix } = await readEncHeader(blob);
  if (header.keyId !== o.keyId) throw new E2EError('key-mismatch', '別の暗号化キーで書かれたファイルです(この端末の暗号化キーでは開けません)');
  if (header.name !== o.expectName) throw new E2EError('mismatch', 'ファイル名がヘッダと違います(改名・差し替えの可能性があります)');
  if (header.device !== o.expectDevice) throw new E2EError('mismatch', '端末の ID がヘッダと違います(差し替えの可能性があります)');
  if (blob.size !== encryptedSize(prefix.length, header.size)) throw new E2EError('format', 'ファイルの大きさが合いません(途中で切れているか、継ぎ足されています)');
  const nonce = b64urlDecode(header.nonce) as Uint8Array<ArrayBuffer>;
  const n = chunkCount(header.size);
  const out: BlobPart[] = [];
  for (let i = 0; i < n; i += 1) {
    const last = i === n - 1;
    const start = prefix.length + i * (E2E_CHUNK + GCM_TAG_BYTES);
    const end = last ? blob.size : start + E2E_CHUNK + GCM_TAG_BYTES;
    const buf = await blob.slice(start, end).arrayBuffer();
    try {
      out.push(await c.subtle.decrypt({ name: 'AES-GCM', iv: ivOf(nonce, i), additionalData: aadOf(prefix, i, last), tagLength: 128 }, o.dataKey, buf));
    } catch {
      throw new E2EError('auth', '暗号化したファイルが改ざんされているか、読めない状態です(開けません)');
    }
  }
  return { plain: new Blob(out), header };
}

// ───────────── 回復キー ─────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 回復キーの乱数(160 bit)。 */
export const RECOVERY_BYTES = 20;

/** 20 bytes → `XXXX-XXXX-…`(32 字 = 8 組)。 */
export function formatRecoveryKey(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_BYTES) throw new E2EError('bad-recovery', '回復キーの長さが正しくありません');
  let acc = 0;
  let bits = 0;
  let s = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      s += CROCKFORD[(acc >> bits) & 31]!;
    }
    acc &= (1 << bits) - 1;
  }
  return s.replace(/(.{4})(?=.)/g, '$1-');
}

/** 写した回復キーを読む(大文字小文字・ハイフン・空白は問わない。Crockford の読み替え O→0 / I,L→1)。読めなければ `null`。 */
export function parseRecoveryKey(text: string): Uint8Array<ArrayBuffer> | null {
  const t = text.normalize('NFKC').toUpperCase().replace(/[\s\-‐-―ー]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (t.length !== 32) return null;
  const out = new Uint8Array(RECOVERY_BYTES);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const ch of t) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  return acc === 0 ? out : null;
}

// ───────────── 鍵の導出と包み ─────────────

/** パスフレーズ由来の鍵(包む用)。⚠ 回数が下限未満なら断る(弱い鍵に格下げさせない)。 */
export async function derivePassphraseKek(c: E2ECrypto, passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  if (!Number.isInteger(iterations) || iterations < PBKDF2_MIN_ITERATIONS) throw new E2EError('weak-kdf', `PBKDF2 の回数が少なすぎます(${String(PBKDF2_MIN_ITERATIONS)} 回未満は使いません)`);
  if (iterations > PBKDF2_MAX_ITERATIONS) throw new E2EError('weak-kdf', 'PBKDF2 の回数が多すぎます');
  if (passphrase === '') throw new E2EError('empty-passphrase', 'パスフレーズを入力してください');
  const base = await c.subtle.importKey('raw', UTF8.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return c.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** 回復キー由来の鍵(包む用)。乱数 160 bit なので PBKDF2 は要らない(HKDF-SHA256)。 */
export async function deriveRecoveryKek(c: E2ECrypto, recovery: Uint8Array<ArrayBuffer>, keyId: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await c.subtle.importKey('raw', recovery, 'HKDF', false, ['deriveKey']);
  return c.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: keyId, info: UTF8.encode('pkc3 e2e recovery kek v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function wrapRaw(c: E2ECrypto, kek: CryptoKey, raw: Uint8Array<ArrayBuffer>, keyId: string): Promise<string> {
  const iv = c.random(12);
  const ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: UTF8.encode(keyId), tagLength: 128 }, kek, raw));
  return b64urlEncode(concat(iv, ct));
}

/** 開けなければ `wrong-secret`。⚠ 返す bytes は呼び手が使い終わったら `fill(0)` する。 */
async function unwrapRaw(c: E2ECrypto, kek: CryptoKey, wrapped: string, keyId: string): Promise<Uint8Array<ArrayBuffer>> {
  const b = b64urlDecode(wrapped);
  if (b === null || b.length !== WRAPPED_BYTES) throw new E2EError('format', '包んだ暗号化キーの形が違います');
  try {
    return new Uint8Array(await c.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: UTF8.encode(keyId), tagLength: 128 }, kek, b.subarray(12)));
  } catch {
    throw new E2EError('wrong-secret', 'パスフレーズまたは回復キーが違います');
  }
}

/** 生の bytes から、取り出せない暗号化キーを作る(bytes はここで潰す)。 */
async function importDataKey(c: E2ECrypto, raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  try {
    return await c.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

export interface OpenedKey {
  readonly dataKey: CryptoKey;
  readonly keyId: string;
}

/**
 * 🔴 **暗号化キーを新しく作る**(パスフレーズ + 回復キー)。
 * @returns keyring(置き場へ書く物)・回復キー(画面に 1 度だけ出す物。⚠ どこにも保存しない)・取り出せない暗号化キー
 */
export async function createKeyMaterial(c: E2ECrypto, passphrase: string): Promise<{ keyring: Keyring; recoveryKey: string; dataKey: CryptoKey }> {
  const keyIdBytes = c.random(KEY_ID_BYTES);
  const keyId = b64urlEncode(keyIdBytes);
  const salt = c.random(SALT_BYTES);
  const recovery = c.random(RECOVERY_BYTES);
  const raw = c.random(32);
  const wrappedPassphrase = await wrapRaw(c, await derivePassphraseKek(c, passphrase, salt, PBKDF2_ITERATIONS), raw, keyId);
  const wrappedRecovery = await wrapRaw(c, await deriveRecoveryKek(c, recovery, keyIdBytes), raw, keyId);
  const dataKey = await importDataKey(c, raw);
  const recoveryKey = formatRecoveryKey(recovery);
  recovery.fill(0);
  return { keyring: buildKeyring({ keyId: keyIdBytes, iterations: PBKDF2_ITERATIONS, salt, wrappedPassphrase, wrappedRecovery }), recoveryKey, dataKey };
}

async function unwrapWith(c: E2ECrypto, k: Keyring, via: { passphrase: string } | { recoveryKey: string }): Promise<Uint8Array<ArrayBuffer>> {
  if ('passphrase' in via) {
    const kek = await derivePassphraseKek(c, via.passphrase, b64urlDecode(k.kdf.salt) as Uint8Array<ArrayBuffer>, k.kdf.iterations);
    return unwrapRaw(c, kek, k.wrapped.passphrase, k.keyId);
  }
  const r = parseRecoveryKey(via.recoveryKey);
  if (r === null) throw new E2EError('bad-recovery', '回復キーの字を読めません(32 文字・英数字。ハイフンは入れても省いても構いません)');
  const kek = await deriveRecoveryKek(c, r, b64urlDecode(k.keyId) as Uint8Array<ArrayBuffer>);
  r.fill(0);
  return unwrapRaw(c, kek, k.wrapped.recovery, k.keyId);
}

/** パスフレーズまたは回復キーで暗号化キーを開く(違えば `wrong-secret`)。 */
export async function openDataKey(c: E2ECrypto, k: Keyring, via: { passphrase: string } | { recoveryKey: string }): Promise<OpenedKey> {
  return { dataKey: await importDataKey(c, await unwrapWith(c, k, via)), keyId: k.keyId };
}

/**
 * パスフレーズの変更 / 忘れたときの付け直し = データ鍵を**新しいパスフレーズで包み直す**だけ(差分ファイルは書き直さない)。
 * 古い方(パスフレーズか回復キー)で開いてから、新しい塩で包む。回復キー側の包みは変えない。
 */
export async function rewrapKeyring(c: E2ECrypto, k: Keyring, via: { passphrase: string } | { recoveryKey: string }, newPassphrase: string): Promise<Keyring> {
  const raw = await unwrapWith(c, k, via);
  try {
    const salt = c.random(SALT_BYTES);
    const wrappedPassphrase = await wrapRaw(c, await derivePassphraseKek(c, newPassphrase, salt, PBKDF2_ITERATIONS), raw, k.keyId);
    return buildKeyring({ keyId: b64urlDecode(k.keyId) as Uint8Array, iterations: PBKDF2_ITERATIONS, salt, wrappedPassphrase, wrappedRecovery: k.wrapped.recovery });
  } finally {
    raw.fill(0);
  }
}
