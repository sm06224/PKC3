/**
 * 🔴 **「持ち歩ける 1 枚」が大きさで詰まったとき、行き止まりにしない**(#971 段④の残り)。
 *
 * ⚠ ここで守りたいのは 2 つで、**片方だけだと害になる**:
 * ① 詰まったときに、何が起きたかと**代わりに何を押せばよいか**を言う
 * ② 🔴 **それ以外の理由まで「大きすぎる」と言わない** ── 壊れているのに
 *    「大きすぎます」と出ると、user は**在りもしない原因**(整理して減らす)を追う。
 */
import { describe, expect, it } from 'vitest';
import {
  imageTooBigMessage,
  looksOutOfMemory,
} from '../../src/features/storage/image-export-limit';

describe('詰まったときの字(#971 段④)', () => {
  it('🔴 代わりの道を必ず書く(行き止まりにしない)', () => {
    const m = imageTooBigMessage(5_000_000_000);
    expect(m, '代わりの道が書いていない').toContain('.pkc3.zip');
    expect(m, '大きさで止まらないことを言っていない').toMatch(/大きさで止まりません/);
  });

  it('⚠ 測れた大きさは書く / 測れなければ 0 と嘘をつかない', () => {
    /**
     * ⚠ **`MB` である**(`GB` ではない)── `humanBytes` は MB で段が止まっている。
     * 🔴 4GB の DB は `4768.4 MB` と出るので**読みにくい**が、これは
     *   **見え方の変更**なので勝手に直さない(#978 で user へ出した)。
     * 🔑 ここでは「**測れた数が字に出ている**」ことだけを見る ── 単位を pin すると、
     *   段が増えた日にこの test が**製品の正しい変更を止める**。
     */
    expect(imageTooBigMessage(5_000_000_000), '測れた大きさを書いていない').toMatch(/4768\.4|4\.7/);
    // 🔑 測れなかったときに「0 B」と出ると、**いちばん危ない状態が軽く見える**
    for (const bad of [null, 0, -1, Number.NaN]) {
      expect(imageTooBigMessage(bad), `0 と書いた: ${String(bad)}`).not.toMatch(/0 B|0B/);
    }
  });

  it('⚠ 記法を書かない(素のテキストとして出る面がある)', () => {
    expect(imageTooBigMessage(null)).not.toMatch(/[*`_]|\[.*\]\(.*\)/);
  });
});

describe('確保の失敗かどうか(#971 段④)', () => {
  it('🔴 確保の失敗は拾う', () => {
    expect(looksOutOfMemory(new RangeError('Invalid typed array length'))).toBe(true);
    const wasm = new Error('allocation failed');
    wasm.name = 'WasmAllocError';
    expect(looksOutOfMemory(wasm), '名前で拾えていない').toBe(true);
    expect(looksOutOfMemory(new Error('Array buffer allocation failed'))).toBe(true);
    expect(looksOutOfMemory(new Error('out of memory'))).toBe(true);
  });

  /**
   * 🔴 **ここが本題** ── 誤検出のほうが害が大きい。
   * ⚠ 壊れているのに「大きすぎます」と出ると、user は**整理して減らそうとする**
   *   ── 壊れた DB へ書き込む向きなので、**壊れ方を広げる**。
   */
  it('🔴 別の理由まで「大きすぎる」と言わない(対照群)', () => {
    for (const other of [
      'database disk image is malformed',
      'no such table: entries',
      'sqlite が初期化されていません',
      'QuotaExceededError',
      'file is not a database',
    ]) {
      expect(looksOutOfMemory(new Error(other)), `誤って拾った: ${other}`).toBe(false);
    }
    expect(looksOutOfMemory(null), 'null を拾った').toBe(false);
    expect(looksOutOfMemory(undefined), 'undefined を拾った').toBe(false);
  });
});
