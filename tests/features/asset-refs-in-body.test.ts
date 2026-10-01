/**
 * #1170: 本文が使っている添付を、本文の順に数え上げる(`features/asset/asset-refs-in-body.ts`)。
 *
 * 🔴 ここが守るのは「**行を押したら、本文に実在する物へ飛ぶ**」── 描かれない `asset:`
 * (コードの囲み・インラインコードの中 / 散文)に行を作ると、押しても何も光らない。
 * 🔑 期待値は**本文の書き方**から手で組む(実装の読み手を写さない)。
 */
import { describe, it, expect } from 'vitest';
import { listAssetUses } from '@features/asset/asset-refs-in-body';

describe('listAssetUses', () => {
  it('画像: alt が表示名、行は 1 始まり', () => {
    const uses = listAssetUses('はじめに\n\n![図 1](asset:ast-a)\n');
    expect(uses).toEqual([{ key: 'ast-a', label: '図 1', line: 3, kind: 'image', count: 1 }]);
  });

  it('リンク: 字が表示名(ダウンロード導線)', () => {
    const uses = listAssetUses('資料は [仕様書.pdf](asset:ast-b) です');
    expect(uses).toEqual([
      { key: 'ast-b', label: '仕様書.pdf', line: 1, kind: 'link', count: 1 },
    ]);
  });

  it('囲み: 見出しの asset: が参照(残りの語が表示名)', () => {
    const uses = listAssetUses('前置き\n\n```csv asset:ast-c\n```\n');
    expect(uses).toEqual([{ key: 'ast-c', label: 'csv', line: 3, kind: 'fence', count: 1 }]);
  });

  it('本文に出る順に並ぶ(画像 → 囲み → リンク)', () => {
    const body = ['![a](asset:k1)', '', '```csv asset:k2', '```', '', '[b](asset:k3)'].join('\n');
    expect(listAssetUses(body).map((u) => [u.key, u.kind])).toEqual([
      ['k1', 'image'],
      ['k2', 'fence'],
      ['k3', 'link'],
    ]);
  });

  it('同じ key は 1 件にまとめ、最初の出現の行・形を残して回数を数える', () => {
    const body = '![first](asset:dup)\n\n本文\n\n[second](asset:dup)\n\n![third](asset:dup)';
    expect(listAssetUses(body)).toEqual([
      { key: 'dup', label: 'first', line: 1, kind: 'image', count: 3 },
    ]);
  });

  it('コードの囲み・インラインコードの中の asset: は参照ではない(行を作らない)', () => {
    const body = [
      '```md',
      '![x](asset:in-fence)',
      '```',
      '',
      '`![y](asset:in-inline)` と書くと出ます',
      '',
      '![ok](asset:real)',
    ].join('\n');
    expect(listAssetUses(body).map((u) => u.key)).toEqual(['real']);
  });

  it('散文に asset:key と書いただけでは参照ではない', () => {
    expect(listAssetUses('asset:just-prose は書き方の例です')).toEqual([]);
  });

  it('引用・リストの中でも拾う', () => {
    const body = '> ![q](asset:in-quote)\n\n- [l](asset:in-list)';
    expect(listAssetUses(body).map((u) => u.key)).toEqual(['in-quote', 'in-list']);
  });

  it('参照が無ければ空', () => {
    expect(listAssetUses('')).toEqual([]);
    expect(listAssetUses('ただの文章 ![外](https://example.com/a.png)')).toEqual([]);
  });
});
