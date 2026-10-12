/**
 * 🔴 **可搬単一 HTML の器の「判定」**(#400 段③)。
 *
 * ⚠ IndexedDB の配管そのものは happy-dom に無いので、ここでは見ない
 * (`file://` の smoke が実物で通す ── そちらが正しい層である)。
 * 🔑 ここが見るのは**判定**である ── 変異試験 M18 が SURVIVED で教えた:
 * 器の中に置いたままの門は、**どの unit からも走らなかった**。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertWritableImage,
  DbImageStore,
  decodeStoredImage,
  releaseImage,
} from '../../src/adapter/platform/storage/db-image-store';

const ok = {
  bundleId: 'pkcb-storetest0001',
  exportedAt: 10,
  savedAt: 20,
  image: new Uint8Array([1, 2, 3]),
};

describe('書く前に止める', () => {
  it('🔴 空の画像は器へ書かない(次の起動が「記録がある」と読んでしまう)', () => {
    expect(() => assertWritableImage(new Uint8Array(0))).toThrow(/空/);
  });

  it('⚠ 空振り防止 ── 中身があれば通る', () => {
    expect(() => assertWritableImage(new Uint8Array([1]))).not.toThrow();
  });
});

describe('読んだ記録を検める', () => {
  it('無い記録は null(それは「まだ書いていない」である)', () => {
    expect(decodeStoredImage(undefined)).toBeNull();
    expect(decodeStoredImage(null)).toBeNull();
  });

  it('正しい記録は、大きさを添えて返る', () => {
    expect(decodeStoredImage(ok)).toEqual({ ...ok, bytes: 3 });
  });

  it('🔴 壊れた記録は「無い」と読み替えず、投げる', () => {
    /**
     * ⚠ 「無い」に畳むと、呼び側は「器が空だから配られた画像を開く」へ進み、
     *   **user の編集を上書きする** ── だから黙って進ませてはいけない。
     */
    for (const [why, raw] of [
      ['画像が Uint8Array でない', { ...ok, image: 'これは文字列' }],
      ['画像が無い', { bundleId: ok.bundleId, exportedAt: 1, savedAt: 2 }],
      ['bundleId が無い', { ...ok, bundleId: undefined }],
      ['bundleId が空', { ...ok, bundleId: '' }],
      ['exportedAt が数でない', { ...ok, exportedAt: '10' }],
      ['savedAt が数でない', { ...ok, savedAt: null }],
      ['savedAt が NaN', { ...ok, savedAt: Number.NaN }],
    ] as const)
      expect(() => decodeStoredImage(raw), why).toThrow(/形が違います/);
  });

  it('⚠ どの欄が壊れているかを言う(「形が違います」だけにしない)', () => {
    expect(() => decodeStoredImage({ ...ok, savedAt: 'x' })).toThrow(/savedAt/);
    expect(() => decodeStoredImage({ ...ok, exportedAt: 'x' })).toThrow(/exportedAt/);
  });
});

describe('#1416 ── 書き終えた画像を手放す', () => {
  it('🔴 手放すと buffer が 0 バイトになる', () => {
    const p = new Uint8Array([1, 2, 3, 4]);
    releaseImage(p);
    expect(p.byteLength, '手放していない').toBe(0);
    expect(p.buffer.byteLength).toBe(0);
  });

  it('🔴 他と共有している buffer は手放さない(共有している側を壊さない)', () => {
    const whole = new Uint8Array([1, 2, 3, 4, 5, 6]);
    releaseImage(whole.subarray(2, 4));
    releaseImage(whole.subarray(0, 3)); // 先頭からでも全体でなければ手放さない
    expect(whole.byteLength, '共有 buffer を手放した').toBe(6);
    expect([...whole]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('#1416 ── write は従来の 1 件の記録で書き、書いた画像を手放す(偽の IndexedDB で通す)', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** `put` の引数と、そのとき画像がまだ生きていたかを控える最小の偽物。 */
  function fakeIdb() {
    const puts: Array<{ value: Record<string, unknown>; key: unknown; aliveAtPut: number }> = [];
    const store = {
      put(value: Record<string, unknown>, key: unknown) {
        // put は値をその場で複製する ── この時点で画像はまだ中身を持っていなければならない
        puts.push({ value, key, aliveAtPut: (value['image'] as Uint8Array).byteLength });
        return {} as IDBRequest;
      },
    };
    const db = {
      transaction() {
        const t: Record<string, unknown> = { objectStore: () => store };
        // 書いた後に commit が来る(oncomplete は呼び側が付けた後に呼ぶ)
        queueMicrotask(() => queueMicrotask(() => (t['oncomplete'] as () => void)()));
        return t;
      },
      close() {},
    };
    vi.stubGlobal('indexedDB', {
      open() {
        const req: Record<string, unknown> = { result: db };
        queueMicrotask(() => (req['onsuccess'] as () => void)());
        return req;
      },
    });
    return puts;
  }

  it('🔴 1 件の記録(旧い版の読み手が読める形)を key "db" へ書き、書いた画像は 0 バイトになる', async () => {
    const puts = fakeIdb();
    const image = new Uint8Array([1, 2, 3, 4, 5]);
    await new DbImageStore('pkcb-x').write({ exportedAt: 1, savedAt: 2, image });
    expect(puts, 'put が 1 回でない(割って書いている)').toHaveLength(1);
    expect(puts[0]!.key).toBe('db');
    expect(puts[0]!.aliveAtPut, 'put の時点で画像が空(複製の前に手放している)').toBe(5);
    // 旧い版の読み手 `decodeStoredImage` がそのまま読める
    expect(decodeStoredImage(puts[0]!.value)).toMatchObject({ bundleId: 'pkcb-x', exportedAt: 1, savedAt: 2 });
    expect(image.byteLength, '書いた後も画像を握っている').toBe(0);
  });
});
