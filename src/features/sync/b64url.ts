/**
 * base64url(パディングなし)。⚠ 暗号化の形式(`e2e-crypto.ts` / `keyring.ts`)が使う純粋な小物。
 * 読む側は**正規の字だけ**を受ける(字の種類・長さ・末尾の余りのビット)── 同じ bytes に別の字が対応して見張りをすり抜けない。
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const REVERSE: Record<string, number> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

export function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2]!;
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += ALPHABET[c & 63]!;
  }
  return out;
}

/** 読めなければ `null`(正規でない字・長さ・余りのビットが 0 でない)。 */
export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (typeof s !== 'string' || s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const ch of s) {
    const v = REVERSE[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) return null; // 余りのビットは 0(正規の符号化だけ)
  return out;
}
