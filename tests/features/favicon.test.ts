/** @vitest-environment happy-dom */
/**
 * 🔴 **リンク先の印を探す**(#856 段②)── 判断の側。
 *
 * 🔴 守る主張:
 * 1. 段 1(決まった場所)は**サイトの根**から引く(ページの path を捨てる)
 * 2. 段 2(ページを読む)は**サイトが自分で指している物**だけを拾う
 * 3. ⚠ **`<base href>` を見る**(見ないと相対の綴りが別の場所を指す)
 * 4. ⚠ 取りに行ってよい入れ物だけ(`javascript:` を拾わない)
 * 5. 🔴 **大きいほうを先に**(縮めるのは足す側でできるが、引き伸ばしは戻せない)
 */
import { describe, expect, it } from 'vitest';
import { iconPicksFromDocument, wellKnownIconUrl } from '../../src/features/launcher/favicon';

/**
 * 実物の `DOMParser` で組む(手で `Document` を作らない ── stub を本物より甘くしない)。
 *
 * ⚠ **`rel="stylesheet"` を fixture に書かない** ── happy-dom の `DOMParser` は
 *   それを**本当に取りに行く**(`ECONNREFUSED 127.0.0.1:3000` が stderr に出る)。
 *   ブラウザの `DOMParser` は inert なので取りに行かない ── **環境差である**。
 * 🔑 拾わない側の対照群は、取りに行かない `rel` で置く(`manifest` / `author`)。
 */
const docOf = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

describe('決まった場所(#856 段② の 1 段目)', () => {
  it('🔴 ページの path を捨てて、サイトの根から引く', () => {
    expect(wellKnownIconUrl('https://example.com/a/b?q=1#x')).toBe('https://example.com/favicon.ico');
  });

  it('⚠ ポートは残す(別のサイトになるため)', () => {
    expect(wellKnownIconUrl('http://example.com:8080/a')).toBe('http://example.com:8080/favicon.ico');
  });

  it('⚠ 根を持たない綴りには「段 1 は無い」と言う', () => {
    expect(wellKnownIconUrl('data:text/html,<p>x'), 'data: に根は無い').toBeNull();
    expect(wellKnownIconUrl('これは URL ではない'), '読めない綴り').toBeNull();
  });
});

describe('ページが指している印(#856 段② の 2 段目)', () => {
  it('🔴 `icon` / `shortcut icon` / `apple-touch-icon` を拾い、ほかは拾わない', () => {
    const picks = iconPicksFromDocument(
      docOf(`
        <link rel="manifest" href="/m.json">
        <link rel="icon" href="/i.png">
        <link rel="shortcut icon" href="/s.ico">
        <link rel="apple-touch-icon" href="/t.png">
        <link rel="author" href="/who.html">
      `),
      'https://example.com/page',
    );
    // 空振り防止 ── 3 件そろって初めて「ほかは拾わない」が意味を持つ
    expect(picks.map((p) => p.url), '拾う物と拾わない物の切れ目が違う').toEqual([
      'https://example.com/i.png',
      'https://example.com/s.ico',
      'https://example.com/t.png',
    ]);
  });

  it('⚠ 大文字で書いてあっても拾う', () => {
    const picks = iconPicksFromDocument(docOf('<link REL="ICON" href="/i.png">'), 'https://e.test/');
    expect(picks.map((p) => p.url)).toEqual(['https://e.test/i.png']);
  });

  it('🔴 相対の綴りは、そのページを基点に解く', () => {
    const picks = iconPicksFromDocument(
      docOf('<link rel="icon" href="i.png">'),
      'https://example.com/deep/page.html',
    );
    expect(picks[0]?.url, 'ページの居場所を基点にしていない').toBe('https://example.com/deep/i.png');
  });

  it('🔴 `<base href>` が在れば、そちらを基点にする', () => {
    const picks = iconPicksFromDocument(
      docOf('<base href="https://cdn.test/assets/"><link rel="icon" href="i.png">'),
      'https://example.com/deep/page.html',
    );
    expect(picks[0]?.url, 'ページが宣言した基点を無視している').toBe('https://cdn.test/assets/i.png');
  });

  it('⚠ 読めない `<base>` は無かったことにする(全部落とさない)', () => {
    const picks = iconPicksFromDocument(
      docOf('<base href=":::"><link rel="icon" href="/i.png">'),
      'https://example.com/deep/page.html',
    );
    expect(picks[0]?.url).toBe('https://example.com/i.png');
  });

  it('🔴 取りに行ってよい入れ物だけ ── `javascript:` は拾わない', () => {
    const picks = iconPicksFromDocument(
      docOf(`
        <link rel="icon" href="javascript:alert(1)">
        <link rel="icon" href="data:image/png;base64,AA">
      `),
      'https://example.com/',
    );
    // ⚠ `data:` は**通信が 1 度も起きない**ので受ける(対照群を兼ねる)
    expect(picks.map((p) => p.url), '危ない綴りを拾った / data: を落とした').toEqual([
      'data:image/png;base64,AA',
    ]);
  });

  it('⚠ href が空のものは数えない', () => {
    expect(iconPicksFromDocument(docOf('<link rel="icon" href="  ">'), 'https://e.test/')).toEqual([]);
  });

  it('🔴 大きいほうが先(縮めるのは足す側でできるが、引き伸ばしは戻せない)', () => {
    const picks = iconPicksFromDocument(
      docOf(`
        <link rel="icon" sizes="16x16" href="/a.png">
        <link rel="icon" sizes="180x180" href="/b.png">
        <link rel="icon" sizes="32x32" href="/c.png">
      `),
      'https://e.test/',
    );
    expect(picks.map((p) => p.size), '前提が崩れている(大きさを読めていない)').toEqual([180, 32, 16]);
    expect(picks.map((p) => p.url)).toEqual(['https://e.test/b.png', 'https://e.test/c.png', 'https://e.test/a.png']);
  });

  it('🔴 `sizes="any"`(ベクタ)は、どの数よりも先', () => {
    const picks = iconPicksFromDocument(
      docOf(`
        <link rel="icon" sizes="512x512" href="/big.png">
        <link rel="icon" sizes="any" href="/v.svg">
      `),
      'https://e.test/',
    );
    expect(picks[0]?.url, 'ベクタを数の後ろへ回した').toBe('https://e.test/v.svg');
    expect(picks[0]?.size).toBe(Infinity);
  });

  it('⚠ 大きさを書いていない物は末尾へ回す(書いてある物のほうが意図が読める)', () => {
    const picks = iconPicksFromDocument(
      docOf(`
        <link rel="icon" href="/none.png">
        <link rel="icon" sizes="16x16" href="/small.png">
      `),
      'https://e.test/',
    );
    // ⚠ 「null を 0 として混ぜる」実装だと、16px より **先**に来てしまう
    expect(picks.map((p) => p.url), '書いていない物を先に出した').toEqual([
      'https://e.test/small.png',
      'https://e.test/none.png',
    ]);
    expect(picks[1]?.size, '書いていないのに数が付いた').toBeNull();
  });

  it('⚠ 同じ大きさなら、文書に書いてある順', () => {
    const picks = iconPicksFromDocument(
      docOf(`
        <link rel="icon" sizes="32x32" href="/1.png">
        <link rel="icon" sizes="32x32" href="/2.png">
      `),
      'https://e.test/',
    );
    expect(picks.map((p) => p.url)).toEqual(['https://e.test/1.png', 'https://e.test/2.png']);
  });

  it('⚠ 読めないページ URL では 1 件も返さない', () => {
    expect(iconPicksFromDocument(docOf('<link rel="icon" href="/i.png">'), 'ぐちゃぐちゃ')).toEqual([]);
  });
});
