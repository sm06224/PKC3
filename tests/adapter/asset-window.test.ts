/** @vitest-environment happy-dom */
/**
 * 添付を別の窓で見る(#192 で画像、2026-08-15 に PDF を追加)。
 *
 * 🔴 守る主張(ほとんどが**寿命**の話 ── 2026-07-27 の不可侵指示):
 * 1. 窓が閉じたら **ObjectURL を返す**(閉じたあとも blob が残らない)
 * 2. **窓が開けなかったら、その場で捨てる**(押した数だけ blob が積もらない)
 * 3. 待ちが失敗しても捨てる(例外で寿命が漏れない)
 * 4. Document PiP があればそちら、無ければ素の別窓(どちらでも寿命は同じ)
 * 5. PiP が失敗しても**落ちない**(素の別窓へ落ちる = 押して無反応にしない)
 * 6. 題名は**文字として**入れる(HTML を組み立てない)
 */
import { describe, expect, it, vi } from 'vitest';
import { openAssetWindow } from '../../src/adapter/platform/asset-window';

/** 別窓の代わり(happy-dom の document を 1 枚借りる)。 */
function fakeWindow() {
  const doc = document.implementation.createHTMLDocument('');
  const win = {
    closed: false,
    document: doc,
    close(): void {
      this.closed = true;
    },
  };
  return win as unknown as Window & { closed: boolean };
}

describe('添付の別窓', () => {
  it('🔴 開くと img が 1 枚入り、題名は文字として入る', async () => {
    const win = fakeWindow();
    const lent = { url: 'blob:x', dispose: vi.fn() };
    const h = await openAssetWindow({
      kind: 'image',
      lent,
      title: '<script>あぶない</script>.png',
      open: () => win,
      waitClose: () => new Promise(() => undefined), // 閉じない
    });
    expect(h).not.toBeNull();
    const img = win.document.querySelector<HTMLImageElement>('[data-pkc-field="asset-window-image"]');
    expect(img, 'img が入っていない').not.toBeNull();
    expect(img!.src).toContain('blob:x');
    // ⚠ 題名は**文字**(HTML として解釈されていない)
    expect(win.document.querySelector('script'), '題名が HTML として入った').toBeNull();
    expect(win.document.title).toContain('あぶない');
    expect(lent.dispose, 'まだ開いているのに捨てた').not.toHaveBeenCalled();
  });

  it('🔴 窓が閉じたら ObjectURL を返す', async () => {
    const win = fakeWindow();
    const lent = { url: 'blob:x', dispose: vi.fn() };
    let closed: (() => void) | null = null;
    await openAssetWindow({
      kind: 'image',
      lent,
      title: 'a.png',
      open: () => win,
      waitClose: () => new Promise<void>((r) => (closed = r)),
    });
    expect(lent.dispose).not.toHaveBeenCalled();
    closed!();
    await Promise.resolve();
    await Promise.resolve();
    expect(lent.dispose, '閉じたのに revoke していない').toHaveBeenCalledTimes(1);
  });

  it('🔴 窓が開けなかったら、その場で捨てる(押した数だけ積もらない)', async () => {
    const lent = { url: 'blob:x', dispose: vi.fn() };
    const h = await openAssetWindow({ kind: 'image', lent, title: 'a.png', open: () => null });
    expect(h, '開けていないのに handle を返した').toBeNull();
    expect(lent.dispose, '開けなかったのに捨てていない').toHaveBeenCalledTimes(1);
  });

  it('待ちが失敗しても捨てる(例外で寿命が漏れない)', async () => {
    const win = fakeWindow();
    const lent = { url: 'blob:x', dispose: vi.fn() };
    await openAssetWindow({
      kind: 'image',
      lent,
      title: 'a.png',
      open: () => win,
      waitClose: () => Promise.reject(new Error('boom')),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(lent.dispose).toHaveBeenCalledTimes(1);
  });

  it('🔴 Document PiP があればそちらを使う', async () => {
    const win = fakeWindow();
    const pip = vi.fn(async () => win);
    const open = vi.fn(() => fakeWindow());
    await openAssetWindow({
      kind: 'image',
      lent: { url: 'blob:x', dispose: vi.fn() },
      title: 'a.png',
      requestPip: pip,
      open,
      waitClose: () => new Promise(() => undefined),
    });
    expect(pip, 'PiP を試していない').toHaveBeenCalledTimes(1);
    expect(open, 'PiP が使えたのに別窓も開いた').not.toHaveBeenCalled();
  });

  it('🔴 PiP が失敗しても落ちず、素の別窓へ落ちる', async () => {
    const win = fakeWindow();
    const open = vi.fn(() => win);
    const h = await openAssetWindow({
      kind: 'image',
      lent: { url: 'blob:x', dispose: vi.fn() },
      title: 'a.png',
      requestPip: () => Promise.reject(new Error('user gesture required')),
      open,
      waitClose: () => new Promise(() => undefined),
    });
    expect(h, 'PiP の失敗で開けなくなった').not.toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **PDF の別窓**(2026-08-15、user 報告「PDF ビューアが動作しない /
   * 窓内と別窓の両方を PKC2 を真似して実装してください」)。
   */
  it('🔴 PDF は object で入り、器いっぱいの規則が付く', async () => {
    const win = fakeWindow();
    const lent = { url: 'blob:pdf', dispose: vi.fn() };
    await openAssetWindow({
      kind: 'pdf',
      lent,
      title: '見積書.pdf',
      open: () => win,
      waitClose: () => new Promise(() => undefined),
    });
    const obj = win.document.querySelector<HTMLObjectElement>(
      '[data-pkc-field="asset-window-pdf"]',
    );
    expect(obj, 'object が入っていない').not.toBeNull();
    expect(obj!.type).toBe('application/pdf');
    expect(obj!.data).toContain('blob:pdf');
    expect(win.document.querySelector('img'), 'PDF なのに img を入れた').toBeNull();
    expect(win.document.title).toBe('見積書.pdf');
    /**
     * ⚠ **規則ごと切り出して見る**(2026-08-15、着地前レビューで指摘)。
     * 1 稿目は file 全体に `height:100%` が在るかを見ていたが、同じ style には
     * `html,body{…height:100%…}` が在るので、**object 側の宣言を消しても緑**だった
     * (CLAUDE.md §1「範囲が広すぎて別の規則に満たされる」の CSS 版)。
     */
    const css = win.document.querySelector('style')!.textContent ?? '';
    const rule = /object\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule, '前提: object の規則を切り出せていない').not.toBe('');
    expect(rule, 'object を器いっぱいにしていない').toContain('height:100%');
    expect(rule, 'object の幅が器いっぱいでない').toContain('width:100%');
    // 🔑 出せないブラウザへの断り文を**中に**置く(空白を残さない)
    expect(obj!.textContent, '出せないときの断りが無い').toContain('ダウンロード');
  });

  it('🔴 PDF は Document PiP を使わない(狭すぎて頁が読めない)', async () => {
    const win = fakeWindow();
    const pip = vi.fn(async () => fakeWindow());
    const open = vi.fn(() => win);
    await openAssetWindow({
      kind: 'pdf',
      lent: { url: 'blob:pdf', dispose: vi.fn() },
      title: 'a.pdf',
      requestPip: pip,
      open,
      waitClose: () => new Promise(() => undefined),
    });
    expect(pip, 'PDF で PiP を試した').not.toHaveBeenCalled();
    expect(open, '素の別窓を開いていない').toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **別タブではなく別窓で開く**(PKC2 の user 報告由来 hotfix を踏襲)。
   * ⚠ `'_blank'` だけだと多くのブラウザで**別タブ**になるので、`popup` と
   * 具体的な寸法を渡す。⚠ PDF は頁を読むので画像より大きく開く。
   */
  it('🔴 別窓の hint(popup + 寸法)を渡し、PDF は大きく開く', async () => {
    const calls: string[] = [];
    const open = vi.fn((_u: string, _t: string, f: string) => {
      calls.push(f);
      return fakeWindow();
    });
    for (const kind of ['image', 'pdf'] as const) {
      await openAssetWindow({
        kind,
        lent: { url: 'blob:x', dispose: vi.fn() },
        title: 'a',
        requestPip: () => Promise.reject(new Error('no pip')),
        open,
        waitClose: () => new Promise(() => undefined),
      });
    }
    expect(calls).toHaveLength(2);
    for (const f of calls) expect(f, 'popup の hint が無い(別タブになる)').toContain('popup');
    const px = (f: string, k: string): number => Number(new RegExp(`${k}=(\\d+)`).exec(f)![1]);
    expect(px(calls[1]!, 'width'), 'PDF が画像より大きく開いていない').toBeGreaterThan(
      px(calls[0]!, 'width'),
    );
    expect(px(calls[1]!, 'height')).toBeGreaterThan(px(calls[0]!, 'height'));
  });


  /**
   * 🔴 **組み立てで落ちても貸出を返す**(2026-08-15、着地前レビューで指摘)。
   * ⚠ 直す前は `fill()` が投げると `waitClose` の登録前に抜けるので、
   * **誰も revoke しないまま**窓だけ残った。
   */
  it('🔴 中身の組み立てが失敗しても ObjectURL を返す', async () => {
    const lent = { url: 'blob:x', dispose: vi.fn() };
    const broken = {
      closed: false,
      get document(): Document {
        throw new Error('document に触れない');
      },
      close: vi.fn(),
    } as unknown as Window;
    await expect(
      openAssetWindow({
        kind: 'pdf',
        lent,
        title: 'a.pdf',
        open: () => broken,
        waitClose: () => new Promise(() => undefined),
      }),
    ).rejects.toThrow();
    expect(lent.dispose, '組み立てで落ちたのに捨てていない').toHaveBeenCalledTimes(1);
  });

  it('close() で閉じられる(閉じれば寿命の終わりに乗る)', async () => {
    const win = fakeWindow();
    const h = await openAssetWindow({
      kind: 'image',
      lent: { url: 'blob:x', dispose: vi.fn() },
      title: 'a.png',
      open: () => win,
      waitClose: () => new Promise(() => undefined),
    });
    h!.close();
    expect(win.closed).toBe(true);
  });
});

/**
 * 🔴 **図を実寸で見る**(#527 案 A。user 指示 2026-08-28
 * 「**別ウィンドウで実寸で開いて拡大縮小できるようにしてほしい**」)。
 *
 * ⚠ **添付の見え方は 1 バイトも変えない**のが条件なので、
 *   既定(`fit` を渡さない)と `'natural'` を**対で**見る ── 片方だけ見ると
 *   「両方 natural になった」を見抜けない。
 */
describe('図の別窓(実寸 + 拡大縮小 ── #527 案 A)', () => {
  const open = async (fit?: 'contain' | 'natural') => {
    const win = fakeWindow();
    await openAssetWindow({
      kind: 'image',
      lent: { url: 'blob:d', dispose: vi.fn() },
      title: '図',
      ...(fit === undefined ? {} : { fit }),
      open: () => win,
      // ⚠ PiP を明示で無効にしない ── 実装が `fit` で外していることを見たい
      waitClose: () => new Promise(() => undefined),
    });
    return win;
  };

  it('🔴 既定は今までどおり「収めて見せる」(添付の見え方を変えない)', async () => {
    const css = (await open()).document.querySelector('style')?.textContent ?? '';
    expect(css, '既定なのに実寸になっている').toContain('object-fit:contain');
    expect(css, '既定なのに上限が外れている').toContain('max-width:100%');
  });

  it('🔴 実寸のときは上限を当てない(縮めない)', async () => {
    const css = (await open('natural')).document.querySelector('style')?.textContent ?? '';
    expect(css, '実寸のはずが収める指定が残っている').not.toContain('object-fit:contain');
    expect(css, '実寸のはずが上限で縮む').not.toContain('max-width:100%');
    /**
     * ⚠ **はみ出した分へ届くこと** ── 実寸は窓より大きいのが普通なので、
     *   送れないと「大きく見えるが端が見えない」になる
     *   (#527 / #523 で 2 度直した穴を、ここで作り直さない)。
     */
    expect(css, 'はみ出した所へ届く手段が無い').toContain('overflow:auto');
  });

  it('🔴 実寸のときだけ拡大縮小の帯が出る', async () => {
    const withFit = await open('natural');
    const bar = withFit.document.querySelector('[data-pkc-field="asset-window-zoom"]');
    expect(bar, '拡大縮小の帯が無い').not.toBeNull();
    /**
     * 🔴 **ボタンで完結する**(不可侵指示「マウスだけで完結し、キーボードは近道」)
     * ── `Ctrl+ホイール` だけにすると**キーボードが要る**ことになる。
     */
    const labels = [...bar!.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels, 'マウスだけで拡大縮小できない').toEqual(['−', '＋', '等倍']);
    // ⚠ 対照群 ── 既定では出ない(添付の窓に帯を増やさない)
    expect(
      (await open()).document.querySelector('[data-pkc-field="asset-window-zoom"]'),
      '添付の窓にも帯が出ている',
    ).toBeNull();
  });

  /**
   * 🔴 **押すと実際に倍率が動く**(帯が在るだけでは押せる証拠にならない)。
   * ⚠ happy-dom は画像を読まないので `naturalWidth` は 0 ── **手で入れる**。
   *   入れないと `apply()` が幅を書かず、**何を押しても 0 のまま**で
   *   「動かない」と「そもそも測れていない」が区別できない(空振り)。
   */
  it('🔴 ＋ と − で幅が動き、等倍で戻る', async () => {
    const win = await open('natural');
    const img = win.document.querySelector<HTMLImageElement>(
      '[data-pkc-field="asset-window-image"]',
    )!;
    Object.defineProperty(img, 'naturalWidth', { value: 400, configurable: true });
    img.dispatchEvent(new Event('load'));
    expect(img.style.width, '実寸が当たっていない(この検査は何も見ていない)').toBe('400px');

    const press = (label: string): void => {
      const b = [...win.document.querySelectorAll('button')].find((x) => x.textContent === label);
      b?.dispatchEvent(new Event('click'));
    };
    press('＋');
    expect(img.style.width, '＋ で大きくならない').toBe('500px');
    press('−');
    expect(img.style.width, '− で戻らない').toBe('400px');
    press('−');
    expect(img.style.width, '− で小さくならない').toBe('320px');
    press('等倍');
    expect(img.style.width, '等倍で実寸へ戻らない').toBe('400px');
  });

  /**
   * ⚠ **0 倍にできない** ── 消えたら戻す手段が無くなる(押し所ごと消える)。
   */
  it('⚠ 小さくし続けても消えない', async () => {
    const win = await open('natural');
    const img = win.document.querySelector<HTMLImageElement>(
      '[data-pkc-field="asset-window-image"]',
    )!;
    Object.defineProperty(img, 'naturalWidth', { value: 400, configurable: true });
    img.dispatchEvent(new Event('load'));
    const minus = [...win.document.querySelectorAll('button')].find((x) => x.textContent === '−')!;
    for (let i = 0; i < 40; i++) minus.dispatchEvent(new Event('click'));
    expect(Number.parseFloat(img.style.width), '小さくし続けたら消えた').toBeGreaterThan(0);
  });

  /**
   * 🔴 **実寸のときは Document PiP を使わない**(#527 案 A)。
   * ⚠ PiP の窓は小さく作られるので、「大きく見る」という目的そのものと逆になる
   *   ── PDF を PiP から外してあるのと同じ理由である。
   */
  it('🔴 実寸のときは PiP を使わない(小さい窓では目的と逆)', async () => {
    const pip = vi.fn(async () => fakeWindow());
    const plain = fakeWindow();
    await openAssetWindow({
      kind: 'image',
      lent: { url: 'blob:d', dispose: vi.fn() },
      title: '図',
      fit: 'natural',
      requestPip: pip,
      open: () => plain,
      waitClose: () => new Promise(() => undefined),
    });
    expect(pip, '実寸なのに PiP の小さい窓へ出した').not.toHaveBeenCalled();
    // ⚠ 対照群 ── 添付(既定)では今までどおり PiP を使う
    const pip2 = vi.fn(async () => fakeWindow());
    await openAssetWindow({
      kind: 'image',
      lent: { url: 'blob:a', dispose: vi.fn() },
      title: 'a.png',
      requestPip: pip2,
      open: () => fakeWindow(),
      waitClose: () => new Promise(() => undefined),
    });
    expect(pip2, '添付の窓が PiP を使わなくなった').toHaveBeenCalled();
  });
});
