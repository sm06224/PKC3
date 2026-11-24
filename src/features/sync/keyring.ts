/**
 * 🔴 **暗号化キーの束(`keyring.json`)の形(#2000 段 4b)**。純粋 ── 形の検査と組み立てだけ(暗号の操作は `e2e-crypto.ts`)。
 *
 * 置き場の差分ファイルと同じ階層に置く 1 ファイル。中身は**秘密を含まない**:
 *   - `keyId` … 暗号化キー(データ鍵)の識別子(乱数 16 bytes)。差分ファイルのヘッダの `keyId` と照らす
 *   - `kdf` … パスフレーズから包む鍵を作る方法(PBKDF2-HMAC-SHA256・回数・塩)。回数はここに書く ── 将来上げられる。読む側は書かれた回数を使う
 *   - `wrapped` … データ鍵を、パスフレーズ由来の鍵 / 回復キー由来の鍵で包んだ物(AES-GCM。IV と暗号文を base64url で連結。追加の認証データ = keyId)
 * ⚠ 厳密な検査: 知らない版・知らない欄・形の違う値は**全部断る**(曖昧に読んで別の鍵として扱わない)。
 */
import { b64urlDecode, b64urlEncode } from './b64url';

export const KEYRING_NAME = 'keyring.json';
export const KEYRING_VERSION = 1;
/**
 * 🔴 PBKDF2-HMAC-SHA256 の回数(user 裁定 2026-11-23 / OWASP Password Storage Cheat Sheet
 *   「PBKDF2-HMAC-SHA256: 600,000 iterations (recommended)」
 *   https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。
 * 読む側の**下限**でもある(これ未満の keyring は断る ── 弱い鍵に格下げされない)。
 */
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_MIN_ITERATIONS = 600_000;
/** 読む側の上限(悪意のある keyring で端末を固めない)。 */
export const PBKDF2_MAX_ITERATIONS = 50_000_000;
export const KEY_ID_BYTES = 16;
export const SALT_BYTES = 16;
/** 包んだデータ鍵 = IV(12) + 鍵(32) + タグ(16)。 */
export const WRAPPED_BYTES = 12 + 32 + 16;

export interface Keyring {
  readonly v: 1;
  readonly keyId: string;
  readonly kdf: { readonly name: 'PBKDF2'; readonly hash: 'SHA-256'; readonly iterations: number; readonly salt: string };
  readonly wrapped: { readonly passphrase: string; readonly recovery: string };
}

export class KeyringFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringFormatError';
  }
}

const bad = (why: string): never => {
  throw new KeyringFormatError(`暗号化キーの束(keyring.json)を読めません: ${why}`);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sameKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const have = Object.keys(o).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
};
const bytesOf = (v: unknown, n: number, what: string): void => {
  if (typeof v !== 'string') bad(`${what}が字ではありません`);
  const d = b64urlDecode(v as string);
  if (d === null || d.length !== n) bad(`${what}の形が違います`);
};

/** 形を検査して返す(通らなければ `KeyringFormatError`)。 */
export function validateKeyring(v: unknown): Keyring {
  if (!isRecord(v)) return bad('JSON の形が違います');
  if (v.v !== KEYRING_VERSION) return bad('知らない版です(この版の PKC3 では読めません)');
  if (!sameKeys(v, ['v', 'keyId', 'kdf', 'wrapped'])) return bad('知らない欄があるか、欄が足りません');
  bytesOf(v.keyId, KEY_ID_BYTES, 'keyId');
  const kdf = v.kdf;
  if (!isRecord(kdf) || !sameKeys(kdf, ['name', 'hash', 'iterations', 'salt'])) return bad('kdf の形が違います');
  if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') return bad('知らないキーの作り方です');
  const it = kdf.iterations;
  if (typeof it !== 'number' || !Number.isInteger(it)) return bad('回数が整数ではありません');
  if (it < PBKDF2_MIN_ITERATIONS) return bad(`PBKDF2 の回数が少なすぎます(${String(PBKDF2_MIN_ITERATIONS)} 回未満は読みません)`);
  if (it > PBKDF2_MAX_ITERATIONS) return bad('PBKDF2 の回数が多すぎます');
  bytesOf(kdf.salt, SALT_BYTES, '塩');
  const w = v.wrapped;
  if (!isRecord(w) || !sameKeys(w, ['passphrase', 'recovery'])) return bad('wrapped の形が違います');
  bytesOf(w.passphrase, WRAPPED_BYTES, '包んだ暗号化キー(パスフレーズ)');
  bytesOf(w.recovery, WRAPPED_BYTES, '包んだ暗号化キー(回復キー)');
  return {
    v: 1,
    keyId: v.keyId as string,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: it, salt: kdf.salt as string },
    wrapped: { passphrase: w.passphrase as string, recovery: w.recovery as string },
  };
}

/** 文字列から読む(JSON でなければ `KeyringFormatError`)。 */
export function parseKeyring(text: string): Keyring {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return bad('JSON ではありません');
  }
  return validateKeyring(v);
}

/** 書く字(欄の順を固定 ── 同じ中身は同じ字)。 */
export function serializeKeyring(k: Keyring): string {
  return JSON.stringify({ v: k.v, keyId: k.keyId, kdf: k.kdf, wrapped: k.wrapped });
}

/** 部品から組み立てる(検査を通してから返す)。 */
export function buildKeyring(p: { keyId: Uint8Array; iterations: number; salt: Uint8Array; wrappedPassphrase: string; wrappedRecovery: string }): Keyring {
  return validateKeyring({
    v: KEYRING_VERSION,
    keyId: b64urlEncode(p.keyId),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: p.iterations, salt: b64urlEncode(p.salt) },
    wrapped: { passphrase: p.wrappedPassphrase, recovery: p.wrappedRecovery },
  });
}
