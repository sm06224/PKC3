import { describe, expect, it } from 'vitest';
import { adoptableUrls } from '../../src/features/asset/inline-url-adopt';
import { assetRefsOf, carryAssets, hasAssetRefs } from '../../src/features/asset/carry-assets';

describe('添付ごと持っていく(#677 の残り)', () => {
  const text =
    '![a](asset:k1) と ![b](asset:k1) と ![c](asset:k2)\n[資料](asset:d1)\n`![x](asset:code)`\n![外](https://example.com/a.png)';

  it('画像の鍵は出てくる順・重複なし / 画像でない参照は件数 / コードの中は数えない', () => {
    expect(assetRefsOf(text)).toEqual({ images: ['k1', 'k2'], others: 1 });
  });

  it('参照が 0 件のときは 0(空振り防止)', () => {
    expect(assetRefsOf('ただの文')).toEqual({ images: [], others: 0 });
    expect(hasAssetRefs('ただの文')).toBe(false);
    expect(hasAssetRefs('[x](asset:a)')).toBe(true);
  });

  it('対応表にある画像だけ data: にする(PDF・読めなかった鍵・外部画像・コードの中は触らない)', () => {
    const out = carryAssets(text, new Map([['k1', 'data:image/png;base64,AAA']]));
    expect(out).toContain('![a](data:image/png;base64,AAA) と ![b](data:image/png;base64,AAA)');
    expect(out).toContain('![c](asset:k2)');
    expect(out).toContain('[資料](asset:d1)');
    expect(out).toContain('`![x](asset:code)`');
    expect(out).toContain('![外](https://example.com/a.png)');
  });

  it('対応表が空なら 1 バイトも変えない', () => {
    expect(carryAssets(text, new Map())).toBe(text);
  });

  /** 貼る側の既存の取り込み(`data:` を添付へ逃がす)が、運んだ字をそのまま拾えること(貼付の経路に新しい口を足さない前提)。 */
  it('🔴 運んだ字は、貼る側の取り込み(adoptableUrls)がそのまま拾える', () => {
    const out = carryAssets('![a](asset:k1)\n[資料](asset:d1)', new Map([['k1', 'data:image/png;base64,AAA']]));
    expect(adoptableUrls(out)).toEqual(['data:image/png;base64,AAA']);
  });
});
