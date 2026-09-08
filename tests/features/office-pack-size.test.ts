/**
 * 🔴 **一式の大きさの数と字がずれない**(#702、2026-09-08)。
 *
 * ⚠ 字のほうは**書き置き**(`'約 93MB'`)である ── 数から組み立てると
 *   `human-bytes.test.ts` の「実行時の値に単位を付けるのは 1 本だけ」に当たるため。
 * 🔑 組み立てない代わりに、**2 つが同じ数を指していること**をここで見る。
 */
import { describe, expect, it } from 'vitest';
import {
  OFFICE_PACK_APPROX,
  OFFICE_PACK_APPROX_MB,
} from '../../src/features/office/office-pack-size';

describe('Office 一式の大きさ(#702)', () => {
  it('🔴 画面に出す字と、数が同じものを指している', () => {
    expect(OFFICE_PACK_APPROX).toContain(String(OFFICE_PACK_APPROX_MB));
    // ⚠ 空振り防止 ── 字が「約 … MB」の形であること(数だけ合っていても意味がない)
    expect(OFFICE_PACK_APPROX).toMatch(/^約 \d+MB$/u);
  });

  it('🔴 圧縮した本体 2 本だけの量(77MB)ではない', () => {
    /*
     * ⚠ ここが #702 の実害そのものである ── 画面は「約 77MB」と言い、
     *   実際に取りに行くのは目録が指すもの全部(実測 97,305,931 バイト ≒ 92.8MB)だった。
     *   空きが 80MB の人は、その字を信じて押して失敗していた。
     */
    expect(OFFICE_PACK_APPROX_MB, '2 本だけの合計に戻っている').not.toBe(77);
    expect(OFFICE_PACK_APPROX_MB, '実測(約 92.8MB)から離れすぎ').toBeGreaterThanOrEqual(90);
    expect(OFFICE_PACK_APPROX_MB, '多めに言うのは可だが、離れすぎない').toBeLessThanOrEqual(100);
  });
});
