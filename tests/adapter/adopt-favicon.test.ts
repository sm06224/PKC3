/** @vitest-environment happy-dom */
/**
 * 🔴 **リンク先の印を取りに行く**(#856 段②、2 段構え)。
 *
 * 🔴 守る主張:
 * 1. 🔴 **決まった場所で済んだら、ページは読まない**(= 通信 1 回)
 * 2. そこに無ければページを読み、サイトが指している印から取る
 * 3. ⚠ **絵でなければ受けない**(404 のページを「印」にしない)
 * 4. ⚠ **叩く回数に上限**(押した 1 回が何往復にもならない)
 * 5. 🔴 **取れなかった理由を、user の言葉で返す**(黙って終わらない)
 */
import { describe, expect, it, vi } from 'vitest';
import { fetchFavicon, type FaviconDeps } from '../../src/adapter/ui/actions/adopt-favicon';
import { HttpStatusError } from '../../src/adapter/ui/actions/adopt-urls';

const png = (n = 3): Blob => new Blob([new Uint8Array(n)], { type: 'image/png' });
const html = (s: string): Blob => new Blob([s], { type: 'text/html' });

/** ⚠ `fetchText` が**呼ばれたかどうか**が、この file のいちばんの観測点である。 */
function deps(over: Partial<FaviconDeps> & { pages?: Record<string, Blob | Error> } = {}) {
  const pages = over.pages ?? {};
  const fetchBlob = vi.fn(async (url: string) => {
    const got = pages[url];
    if (got === undefined) throw new HttpStatusError(404);
    if (got instanceof Error) throw got;
    return got;
  });
  const fetchText = vi.fn((): Promise<string> => Promise.resolve(''));
  const parse = vi.fn((s: string) => new DOMParser().parseFromString(s, 'text/html'));
  return { fetchBlob, fetchText, parse, ...over } as FaviconDeps & {
    fetchBlob: typeof fetchBlob;
    fetchText: typeof fetchText;
  };
}

describe('決まった場所で済む形(#856 段②)', () => {
  it('🔴 決まった場所に在れば、ページは読まない(通信は 1 回)', async () => {
    const d = deps({ pages: { 'https://e.test/favicon.ico': png() } });
    const got = await fetchFavicon('https://e.test/deep/page', d);
    expect(got.ok, '取れていない').toBe(true);
    expect(got.ok && got.step, '段が違う').toBe(1);
    expect(got.ok && got.from).toBe('https://e.test/favicon.ico');
    // 🔴 ここが主張 ── 2 段目へ落ちていない
    expect(d.fetchText, '決まった場所で取れたのにページまで読んだ').not.toHaveBeenCalled();
    expect(d.fetchBlob, '通信が 1 回で済んでいない').toHaveBeenCalledTimes(1);
  });

  it('⚠ 0 バイトは受けない(黙って何も出ない印を置かない)', async () => {
    const d = deps({
      pages: { 'https://e.test/favicon.ico': new Blob([], { type: 'image/png' }) },
    });
    const got = await fetchFavicon('https://e.test/', d);
    // ⚠ 段 2 へ落ちる ── そこにも無いので取れない
    expect(got.ok).toBe(false);
    expect(d.fetchText, '空を受けて段 2 へ行っていない').toHaveBeenCalled();
  });

  it('⚠ 絵でなければ受けない(404 のページを印にしない)', async () => {
    const d = deps({ pages: { 'https://e.test/favicon.ico': html('<h1>Not Found</h1>') } });
    const got = await fetchFavicon('https://e.test/', d);
    expect(got.ok).toBe(false);
    expect(d.fetchText, 'HTML を印として受けてしまった').toHaveBeenCalled();
  });
});

describe('ページが指している印から取る(#856 段②)', () => {
  const page = '<link rel="icon" sizes="180x180" href="/big.png">';

  it('🔴 決まった場所に無ければ、ページを読んで取る', async () => {
    const d = deps({
      pages: { 'https://e.test/big.png': png() },
      fetchText: vi.fn(async () => page),
    });
    const got = await fetchFavicon('https://e.test/', d);
    expect(got.ok && got.step, '段 2 で取れていない').toBe(2);
    expect(got.ok && got.from).toBe('https://e.test/big.png');
  });

  it('🔴 叩く回数に上限がある(押した 1 回が何往復にもならない)', async () => {
    const three = `
      <link rel="icon" sizes="180x180" href="/a.png">
      <link rel="icon" sizes="64x64" href="/b.png">
      <link rel="icon" sizes="32x32" href="/c.png">
    `;
    const d = deps({ pages: {}, fetchText: vi.fn(async () => three) });
    const got = await fetchFavicon('https://e.test/', d);
    expect(got.ok).toBe(false);
    /**
     * ⚠ 内訳:決まった場所 1 + 候補 2 = **3**。
     * 🔑 候補が 3 つ在っても 2 つまでしか叩かない、が主張である
     *   (上限を外すと 4 になる ── 変異試験で見る)。
     */
    expect(d.fetchBlob, '上限が効いていない(押した 1 回が何往復にもなる)').toHaveBeenCalledTimes(3);
  });

  /**
   * 🔴 **大きいほうを先に叩く**(変異試験 M6 が SURVIVED で教えた、2026-09-13)。
   *
   * ⚠ 並べ方そのものは `tests/features/favicon.test.ts` が見ているが、
   *   **それを使う側が順番を守っているか**は誰も見ていなかった ──
   *   逆から叩いても全部緑だった(user には **16px のぼやけた絵**が届く)。
   * 🔑 **両方とも取れる**形にするのが要である ── 片方しか取れないと、
   *   「並びを守った」のか「取れたほうを拾った」のか**区別が付かない**。
   */
  it('🔴 どちらも取れるとき、大きいほうを使う', async () => {
    const two = `
      <link rel="icon" sizes="16x16" href="/small.png">
      <link rel="icon" sizes="180x180" href="/big.png">
    `;
    const d = deps({
      pages: { 'https://e.test/small.png': png(), 'https://e.test/big.png': png() },
      fetchText: vi.fn(async () => two),
    });
    const got = await fetchFavicon('https://e.test/', d);
    expect(got.ok && got.from, '小さいほうを拾った').toBe('https://e.test/big.png');
    // ⚠ 空振り防止 ── 小さいほうは**叩いてすらいない**(1 つ目で決まっている)
    expect(d.fetchBlob, '要らない通信をしている').not.toHaveBeenCalledWith('https://e.test/small.png');
  });

  it('🔴 印を 1 つも置いていないページは、そう言う', async () => {
    const d = deps({ pages: {}, fetchText: vi.fn(async () => '<p>なにもない</p>') });
    const got = await fetchFavicon('https://e.test/', d);
    expect(got.ok).toBe(false);
    expect(!got.ok && got.why, '理由が user の言葉になっていない').toContain('アイコンを置いていません');
  });

  it('🔴 ページが読めなければ、状態番号を落とさずに言う', async () => {
    const d = deps({
      pages: {},
      fetchText: vi.fn(() => Promise.reject(new HttpStatusError(403))),
    });
    const got = await fetchFavicon('https://e.test/', d);
    expect(!got.ok && got.why, '番号が消えている(user が直しようが無い)').toContain('403');
  });

  it('⚠ 読めないアドレスでは、1 度も通信しない', async () => {
    const d = deps({ pages: {} });
    const got = await fetchFavicon('ぐちゃぐちゃ', d);
    expect(got.ok).toBe(false);
    expect(d.fetchBlob, '読めないのに取りに行った').not.toHaveBeenCalled();
    expect(d.fetchText, '読めないのにページを読んだ').not.toHaveBeenCalled();
  });
});
