/**
 * 🔴 **同期(#2000)の指紋に使う SHA-256**(同期の読み書き)。
 *
 * 理由: ノートを消す経路(worker の `deleteEntry`)は同期のまま動くので、`crypto.subtle`(非同期)が使えない。
 * 指紋の衝突は「変えたのに変わっていない」= 取りこぼしに直結するため、FNV(`content-hash.ts` の 64bit)ではなく SHA-256 を使う。
 * ⚠ 文字列を UTF-8 に直してから回す(`TextEncoder`)。
 * ⚠ pure module。
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** バイト列の SHA-256(小文字 hex 64 字)。 */
export function sha256HexOfBytes(data: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = data.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const w = new Uint32Array(64);
  const block = new Uint8Array(64);
  for (let off = 0; off < total; off += 64) {
    // 最後の 1〜2 ブロックだけ詰め物を作る(それ以外は元のバイトをそのまま使う)
    if (off + 64 <= len) {
      block.set(data.subarray(off, off + 64));
    } else {
      block.fill(0);
      if (off < len) block.set(data.subarray(off, len));
      if (len >= off && len < off + 64) block[len - off] = 0x80;
      if (off + 64 === total) {
        const bits = len * 8;
        const hi = Math.floor(bits / 0x100000000);
        const lo = bits >>> 0;
        block[56] = (hi >>> 24) & 0xff;
        block[57] = (hi >>> 16) & 0xff;
        block[58] = (hi >>> 8) & 0xff;
        block[59] = hi & 0xff;
        block[60] = (lo >>> 24) & 0xff;
        block[61] = (lo >>> 16) & 0xff;
        block[62] = (lo >>> 8) & 0xff;
        block[63] = lo & 0xff;
      }
    }
    for (let i = 0; i < 16; i++) {
      w[i] = ((block[i * 4]! << 24) | (block[i * 4 + 1]! << 16) | (block[i * 4 + 2]! << 8) | block[i * 4 + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 8; i++) out += h[i]!.toString(16).padStart(8, '0');
  return out;
}

const enc = new TextEncoder();

/** 文字列(UTF-8)の SHA-256(小文字 hex 64 字)。 */
export function sha256Hex(text: string): string {
  return sha256HexOfBytes(enc.encode(text));
}
