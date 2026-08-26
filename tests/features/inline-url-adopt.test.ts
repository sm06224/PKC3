/**
 * 貼り付けた本文の `data:` / `blob:` を資産へ逃がす(#251 の B + C)の**純粋部分**。
 *
 * 🔴 守る主張:
 * 1. **拾い漏らさない**(画像・リンク・HTML の `src`・参照定義の 4 形)
 * 2. **拾いすぎない**(コードフェンスの中は本文ではなく**書いてある字**)
 * 3. 読めなかったものは**元のまま残る**(黙って消さない)
 * 4. 同じ URL は 1 回しか読まない
 */
import { describe, expect, it } from 'vitest';
import {
  acceptsExternalImage,
  adoptableUrls,
  externalImageUrls,
  isAdoptableUrl,
  isExternalImageUrl,
  rewriteAdopted,
} from '../../src/features/asset/inline-url-adopt';

const DATA = 'data:image/png;base64,AAAA';

describe('逃がす宛先を拾う', () => {
  it('画像・リンク・HTML の src を拾う', () => {
    const text = `![ず](${DATA})\n[落](blob:https://e.com/1)\n<img src="blob:https://e.com/2">`;
    expect(adoptableUrls(text)).toEqual([DATA, 'blob:https://e.com/1', 'blob:https://e.com/2']);
  });

  it('参照形式の定義行も拾う(ここを落とすと画像が黙って壊れる)', () => {
    expect(adoptableUrls(`[a]: ${DATA}\n\n![ず][a]`)).toEqual([DATA]);
  });

  it('`<…>` で囲った宛先も拾う', () => {
    expect(adoptableUrls(`![ず](<${DATA}>)`)).toEqual([DATA]);
  });

  it('🔴 コードフェンスの中は拾わない(あれは**書いてある字**である)', () => {
    expect(adoptableUrls('```\n![ず](blob:https://e.com/1)\n```')).toEqual([]);
  });

  it('普通の URL と `asset:` は拾わない', () => {
    expect(adoptableUrls('![ず](https://e.com/a.png)\n![や](asset:k1)')).toEqual([]);
  });

  it('同じ URL は 1 回だけ(同じ bytes を 2 度読まない)', () => {
    expect(adoptableUrls(`![あ](${DATA})\n![い](${DATA})`)).toEqual([DATA]);
  });

  it('判定は scheme だけを見る', () => {
    expect(isAdoptableUrl('DATA:image/png;base64,A')).toBe(true);
    expect(isAdoptableUrl(' blob:x ')).toBe(true);
    expect(isAdoptableUrl('https://e.com/blob:x')).toBe(false);
  });
});

describe('宛先を差し替える', () => {
  it('対応が在るものだけ差し替える', () => {
    const text = `![ず](${DATA})\n![や](blob:https://e.com/1)`;
    const r = rewriteAdopted(text, new Map([[DATA, 'asset:k1']]));
    expect(r.text).toBe('![ず](asset:k1)\n![や](blob:https://e.com/1)');
    expect(r.adopted).toBe(1);
    // 🔴 読めなかった 1 件は**元のまま**(消さない)── 件数で呼び側が言える
    expect(r.failed).toBe(1);
  });

  it('同じ URL が 2 回出ても**両方**書き換わる(数は 1)', () => {
    const r = rewriteAdopted(`![あ](${DATA})\n![い](${DATA})`, new Map([[DATA, 'asset:k1']]));
    expect(r.text).toBe('![あ](asset:k1)\n![い](asset:k1)');
    expect(r.adopted).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('逃がすものが無ければ 1 バイトも変えない', () => {
    const text = '# 題\n\n![ず](https://e.com/a.png)\n\n```\n![x](blob:1)\n```';
    const r = rewriteAdopted(text, new Map());
    expect(r.text).toBe(text);
    expect(r.adopted).toBe(0);
    expect(r.failed).toBe(0);
  });

  it('`<…>` の中身だけを差し替える(囲いは残す)', () => {
    const r = rewriteAdopted(`![ず](<${DATA}>)`, new Map([[DATA, 'asset:k1']]));
    expect(r.text).toBe('![ず](<asset:k1>)');
  });

  it('HTML の src も差し替える', () => {
    const r = rewriteAdopted('<img src="blob:1">', new Map([['blob:1', 'asset:k9']]));
    expect(r.text).toBe('<img src="asset:k9">');
  });
});

describe('外部の画像を拾う(#264 段①)', () => {
  it('🔴 画像だけ拾う ── リンクは拾わない(押した瞬間に外へ飛ぶ数が変わる)', () => {
    const text = '![ず](https://e.com/a.png)\n[記事](https://e.com/b.html)';
    expect(externalImageUrls(text)).toEqual(['https://e.com/a.png']);
  });

  it('🔴 同じ URL の画像とリンクが並んでも、拾うのは 1 回・**書き換わるのは画像だけ**', () => {
    const url = 'https://e.com/same.png';
    const text = `![ず](${url})\n[記事](${url})`;
    expect(externalImageUrls(text)).toEqual([url]);
    const r = rewriteAdopted(text, new Map([[url, 'asset:k1']]), acceptsExternalImage);
    // ⚠ リンクのほうまで書き換わると、押していないのに**添付のダウンロード導線に化ける**
    expect(r.text).toBe(`![ず](asset:k1)\n[記事](${url})`);
    expect(r.adopted).toBe(1);
  });

  it('HTML の `<img src>` も画像として拾う', () => {
    expect(externalImageUrls('<img src="https://e.com/a.png">')).toEqual([
      'https://e.com/a.png',
    ]);
  });

  it('🔴 参照形式の**定義行**は拾わない(`!` は使う側に付く ── 段⓪ の注記)', () => {
    // ⚠ 定義を「画像だ」と決めると、同じ定義をリンクとしても使うノートで外へ飛ぶ
    expect(externalImageUrls('[a]: https://e.com/a.png\n\n![ず][a]')).toEqual([]);
  });

  it('`data:` / `blob:` / `asset:` は外へ取りに行かない', () => {
    const text = `![あ](${DATA})\n![い](blob:https://e.com/1)\n![う](asset:k1)`;
    expect(externalImageUrls(text)).toEqual([]);
  });

  it('コードフェンスの中は拾わない', () => {
    expect(externalImageUrls('```\n![ず](https://e.com/a.png)\n```')).toEqual([]);
  });

  it('同じ URL は 1 回だけ・出てくる順', () => {
    const text = '![あ](https://e.com/b.png)\n![い](https://e.com/a.png)\n![う](https://e.com/b.png)';
    expect(externalImageUrls(text)).toEqual(['https://e.com/b.png', 'https://e.com/a.png']);
  });

  it('判定は scheme だけを見る', () => {
    expect(isExternalImageUrl('HTTPS://e.com/a.png')).toBe(true);
    expect(isExternalImageUrl(' http://e.com/a.png ')).toBe(true);
    expect(isExternalImageUrl('//e.com/a.png')).toBe(false);
    expect(isExternalImageUrl('asset:k1')).toBe(false);
  });

  it('🔴 既定の述語は貼付のまま ── 外部画像を巻き込まない', () => {
    const text = `![あ](${DATA})\n![い](https://e.com/a.png)`;
    const r = rewriteAdopted(
      text,
      new Map([
        [DATA, 'asset:k1'],
        ['https://e.com/a.png', 'asset:k2'],
      ]),
    );
    // 対応表に在っても、既定は `data:` / `blob:` しか触らない
    expect(r.text).toBe('![あ](asset:k1)\n![い](https://e.com/a.png)');
    expect(r.adopted).toBe(1);
  });
});
