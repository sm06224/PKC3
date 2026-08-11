/**
 * 🔴 **cross-origin isolation のヘッダを、黙って外させない**(#88 O2 の前提)。
 *
 * Office(LibreOffice wasm)は `-pthread` = SharedArrayBuffer を要求し、
 * それには COOP/COEP が要る。⚠ `crossOriginIsolated` は**最上位文書の性質**なので
 * 「iframe だけ分離する」ことはできず、本体に付けるしかない。
 *
 * ⚠ そして **`require-corp` にしてはいけない** ── CORP を返さない外部画像が
 * 全部消え、「外部画像の同意」機能がそのまま死ぬ(2026-08-10 実測)。
 *
 * | COEP | 分離 | SharedArrayBuffer | 外部画像(CORP 無し) |
 * |---|---|---|---|
 * | (なし) | ✕ | ✕ | OK |
 * | require-corp | ✓ | ✓ | **BLOCKED** |
 * | credentialless | ✓ | ✓ | OK |
 *
 * ⚠ **dev と preview の両方**に要る。preview は smoke が使うので、片方だけだと
 * 「手元で通って CI で落ちる」型の食い違いを自分で作ることになる。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CONFIG = readFileSync('vite.config.ts', 'utf-8');

describe('cross-origin isolation のヘッダ', () => {
  it('COOP / COEP を dev と preview の両方へ配っている', () => {
    // ⚠ 「それらしい語が在る」ではなく **配り先が 2 つある**ことを見る
    expect(CONFIG, 'dev server に付いている').toMatch(/server:\s*\{\s*headers:\s*COI_HEADERS\s*\}/);
    expect(CONFIG, 'preview にも付いている').toMatch(/preview:\s*\{\s*headers:\s*COI_HEADERS\s*\}/);
  });

  it('🔴 COEP は credentialless(require-corp にすると外部画像が死ぬ)', () => {
    expect(CONFIG).toContain("'Cross-Origin-Opener-Policy': 'same-origin'");
    expect(CONFIG).toContain("'Cross-Origin-Embedder-Policy': 'credentialless'");
    // 実際に配る値として `require-corp` を使っていないこと。
    // ⚠ 説明の表には出てくるので、**コメント行を落としてから**見る
    const code = CONFIG.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code, 'require-corp を配っていない').not.toContain('require-corp');
  });
});
