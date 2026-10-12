/**
 * 🔴 **「SHA-256 → 小文字 hex」の実装は 1 つ**(#1087)。
 *
 * 以前は `asset-key` / `office-pack` / `asr-pack-acquire` / `duckdb-pack-store` に同じ式が
 * 4 つ在った。一式の壊れの検出材料(`sha256`)と添付の content key は**同じ答え**でなければ
 * ならない ── 片方だけ綴りが変わる(大文字・桁落ち)と、入れた一式が「壊れている」と読まれる。
 *
 * ## 守る主張
 * 1. 既知の値(空・"abc"・日本語)を返す ── 実装と同じ式で期待値を組まない(NIST の定数)
 * 2. Office 側の再 export は同じ関数(別実装に戻らない)
 * 3. 各一式の書込口は本物の SHA-256 を書く(`office-pack-store.test.ts` / `duckdb-pack-store.test.ts`)
 *    と取得口は照合する(`asr-pack-acquire.test.ts`)
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/adapter/platform/storage/asset-key';
import { sha256Hex as officeSha256Hex } from '../../src/adapter/platform/office/office-pack';

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
// "日本語" の UTF-8(9 バイト)── 実測は `printf 日本語 | sha256sum`
const NIHONGO = '77710aedc74ecfa33685e33a6c7df5cc83004da1bdcef7fb280f5c2b2e97e0a5';

describe('sha256Hex(#1087)', () => {
  it.each([
    ['空', new Blob([]), EMPTY],
    ['"abc"', new Blob(['abc']), ABC],
    ['日本語', new Blob(['日本語']), NIHONGO],
  ])('既知の値: %s', async (_name, blob, want) => {
    const got = await sha256Hex(blob);
    expect(got).toBe(want);
    expect(got, '小文字 hex の 64 字').toMatch(/^[0-9a-f]{64}$/);
  });

  it('⚠ 0 埋めを落とさない(先頭が 0 の byte を含む入力でも 64 字)', async () => {
    // 先頭 1 byte の digest が 0x0X になる入力を総当たりで 1 つ探す(桁落ちの変異を殺すため)
    let found: string | null = null;
    for (let i = 0; i < 2000 && found === null; i += 1) {
      const h = await sha256Hex(new Blob([String(i)]));
      if (h.startsWith('0')) found = h;
    }
    expect(found, '先頭が 0 の digest が見つからない(前提が崩れている)').not.toBeNull();
    expect(found).toHaveLength(64);
  });

  it('Office 側の `sha256Hex` は同じ関数(再 export。別実装に戻らない)', () => {
    expect(officeSha256Hex).toBe(sha256Hex);
  });
});
