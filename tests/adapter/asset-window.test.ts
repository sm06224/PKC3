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

  /**
   * 🔴 **開いた直後の大きさ**(#527)。
   *
   * ⚠ **CSS の字面で見ない**(2026-08-28 に書き直した)── 収めると実寸は
   *   **同じ 1 枚の CSS** を共有するようになったので、`object-fit:contain` が
   *   在るかどうかは**どちらでも真**である(= 空振り、CLAUDE.md §1)。
   *   見るのは**器に印が付いているか**(`body[data-pkc-fit]`)── これが
   *   実際に規則を効かせている当のものである。
   */
  it('🔴 既定は今までどおり「収めて見せる」(添付の見え方を変えない)', async () => {
    const doc = (await open()).document;
    expect(doc.body.getAttribute('data-pkc-fit'), '既定なのに収める印が無い').toBe('contain');
    const css = doc.querySelector('style')?.textContent ?? '';
    expect(css, '収める規則そのものが無い').toContain(
      'body[data-pkc-fit="contain"] img{max-width:100%;max-height:100%;object-fit:contain}',
    );
  });

  it('🔴 実寸のときは収める印を付けない(縮めない)', async () => {
    const doc = (await open('natural')).document;
    expect(doc.body.hasAttribute('data-pkc-fit'), '実寸のはずが収める印が付いている').toBe(false);
    /**
     * ⚠ **はみ出した分へ届くこと** ── 実寸は窓より大きいのが普通なので、
     *   送れないと「大きく見えるが端が見えない」になる
     *   (#527 / #523 で 2 度直した穴を、ここで作り直さない)。
     */
    expect(
      doc.querySelector('style')?.textContent ?? '',
      'はみ出した所へ届く手段が無い',
    ).toContain('overflow:auto');
  });

  /**
   * 🔴 **拡大縮小はどちらの窓にも出る**(#527 の残り、2026-08-28)。
   * ⚠ 1 稿目は実寸(図)のときだけ出していたので、**添付の写真を大きくする道が
   *   無かった** ── user の頼みは「対象は画像だけでなくレンダリング結果全部」。
   */
  it('🔴 拡大縮小の帯は、収める窓にも実寸の窓にも出る', async () => {
    for (const fit of [undefined, 'natural' as const]) {
      const bar = (await open(fit)).document.querySelector('[data-pkc-field="asset-window-zoom"]');
      expect(bar, `拡大縮小の帯が無い(fit=${String(fit)})`).not.toBeNull();
      /**
       * 🔴 **ボタンで完結する**(不可侵指示「マウスだけで完結し、キーボードは近道」)
       * ── `Ctrl+ホイール` だけにすると**キーボードが要る**ことになる。
       * 🔴 **帰り道がある**(不可侵指示 2026-08-23「片道の操作を作らない」)──
       *   「収める」が無いと、実寸にしたあと**開き直すしか戻る道が無い**。
       */
      const labels = [...bar!.querySelectorAll('button')].map((b) => b.textContent);
      expect(labels, `マウスだけで拡大縮小・往復できない(fit=${String(fit)})`).toEqual([
        '−',
        '＋',
        '実寸',
        '収める',
      ]);
    }
  });

  /**
   * 🔴 **読み込みを待たずに、収める形で出す**(#527 の残り、2026-08-28)。
   *
   * ⚠ `load` を待って当てると、読み込みの間だけ**収める指定が無い状態**で描かれる
   *   ── 大きな添付が一瞬**実寸で出てから縮む**(画面が跳ねる)。
   * 🔴 **happy-dom では既定で殺せない**(実測)── あちらは `img.complete` が
   *   **常に true** なので、「読み込み済みなら当てる」だけの実装でも通ってしまう
   *   (変異試験 M9 が SURVIVED で教えた)。だから**実ブラウザと同じ意味論**
   *   ── まだ読めていない絵は `complete === false` ── を器に持たせて測る
   *   (CLAUDE.md §3「stub は本物の意味論を真似る」)。
   */
  it('🔴 まだ読めていない絵でも、開いた瞬間から収まっている', async () => {
    const win = fakeWindow();
    const doc = win.document;
    const make = doc.createElement.bind(doc);
    // ⚠ **本物に寄せる** ── 実ブラウザは `src` を差した直後 `complete === false`
    doc.createElement = ((tag: string) => {
      const el = make(tag);
      if (tag === 'img') Object.defineProperty(el, 'complete', { value: false });
      return el;
    }) as typeof doc.createElement;
    await openAssetWindow({
      kind: 'image',
      lent: { url: 'blob:z', dispose: vi.fn() },
      title: 'おおきな写真.png',
      open: () => win,
      waitClose: () => new Promise(() => undefined),
    });
    const img = doc.querySelector<HTMLImageElement>('[data-pkc-field="asset-window-image"]')!;
    expect(img.complete, '前提: まだ読めていない絵になっていない').toBe(false);
    expect(
      doc.body.getAttribute('data-pkc-fit'),
      '読み込みを待っている間だけ実寸で出る(画面が跳ねる)',
    ).toBe('contain');
  });

  /**
   * 🔴 **収める ⇄ 実寸を往復できる**(#527 の残り)。
   * ⚠ ここが**この節の主張**である ── 帯が在ることではなく、
   *   **押した結果、器の印と幅の両方が入れ替わる**ことを見る。
   */
  it('🔴 収めて開いた窓を実寸にでき、収めるへ戻せる', async () => {
    const win = await open();
    const doc = win.document;
    const img = doc.querySelector<HTMLImageElement>('[data-pkc-field="asset-window-image"]')!;
    Object.defineProperty(img, 'naturalWidth', { value: 400, configurable: true });
    img.dispatchEvent(new Event('load'));
    // 開いた直後 ── 収めている(幅は CSS に任せる)
    expect(doc.body.getAttribute('data-pkc-fit'), '開いた直後に収めていない').toBe('contain');
    expect(img.style.width, '収めているのに幅を書いている').toBe('');

    const press = (label: string): void => {
      [...doc.querySelectorAll('button')]
        .find((x) => x.textContent === label)
        ?.dispatchEvent(new Event('click'));
    };
    press('実寸');
    expect(doc.body.hasAttribute('data-pkc-fit'), '実寸にしたのに収める印が残っている').toBe(false);
    expect(img.style.width, '実寸で原寸にならない').toBe('400px');
    press('収める');
    expect(doc.body.getAttribute('data-pkc-fit'), '収めるへ戻れない(片道の操作)').toBe('contain');
    expect(img.style.width, '収めるへ戻したのに幅が残っている').toBe('');
  });

  /**
   * 🔴 **収めている絵を ＋ で押すと、見えている大きさから 1 段動く**(#527 の残り)。
   * ⚠ ここを `1 * 1.25` にすると、収まっていた大きな写真が押した瞬間に
   *   **実寸より大きく跳ねる**(見ていた場所を見失う)。
   */
  it('🔴 収めているときの ＋ は「見えている大きさ」から動く', async () => {
    const win = await open();
    const img = win.document.querySelector<HTMLImageElement>(
      '[data-pkc-field="asset-window-image"]',
    )!;
    Object.defineProperty(img, 'naturalWidth', { value: 400, configurable: true });
    // ⚠ 実物では CSS が縮めた結果。happy-dom は組版しないので**手で入れる**
    //   ── 入れないと見かけの倍率が 1 に落ち、この検査は何も見ていない
    Object.defineProperty(img, 'clientWidth', { value: 200, configurable: true });
    img.dispatchEvent(new Event('load'));
    [...win.document.querySelectorAll('button')]
      .find((x) => x.textContent === '＋')!
      .dispatchEvent(new Event('click'));
    expect(img.style.width, '見えている大きさから動いていない').toBe('250px');
  });

  /**
   * 🔴 **掴んで送れる**(#527「位置の掴み送り」)。
   * ⚠ 拡大した絵は窓に収まらないので、**見たい所へ寄せる**のが主な操作である
   *   ── 端の細い棒だけに頼らせない。
   */
  it('🔴 絵を掴んで動かすと送れ、放すと止まる', async () => {
    const win = await open('natural');
    const doc = win.document;
    const img = doc.querySelector<HTMLImageElement>('[data-pkc-field="asset-window-image"]')!;
    // ⚠ 送り手は **`body`**(CSS が `html` を `hidden` にしている)── 2026-08-28 に
    //   `scrollingElement` を動かして**実ブラウザで 1px も動かなかった**
    const box = doc.body;
    box.scrollLeft = 100;
    box.scrollTop = 50;
    const mouse = (type: string, x: number, y: number): void => {
      const ev = new Event(type, { bubbles: true }) as Event & {
        clientX: number;
        clientY: number;
        button: number;
      };
      Object.assign(ev, { clientX: x, clientY: y, button: 0 });
      (type === 'mousedown' ? img : doc).dispatchEvent(ev);
    };
    mouse('mousedown', 300, 200);
    mouse('mousemove', 280, 190);
    // ⚠ **向きは「掴んだ物が指について来る」** ── 左へ 20 動かしたら、
    //   見えている窓は右へ 20 送られる(絵が左へ動いて見える)
    expect(box.scrollLeft, '掴んで動かしても送れない').toBe(120);
    expect(box.scrollTop, '縦に送れない').toBe(60);
    mouse('mouseup', 280, 190);
    mouse('mousemove', 180, 90);
    expect(box.scrollLeft, '放したのに送りが続いている').toBe(120);
    expect(box.scrollTop, '放したのに縦の送りが続いている').toBe(60);
  });

  /**
   * 🔴 **押すと実際に倍率が動く**(帯が在るだけでは押せる証拠にならない)。
   * ⚠ happy-dom は画像を読まないので `naturalWidth` は 0 ── **手で入れる**。
   *   入れないと `apply()` が幅を書かず、**何を押しても 0 のまま**で
   *   「動かない」と「そもそも測れていない」が区別できない(空振り)。
   */
  it('🔴 ＋ と − で幅が動き、実寸で戻る', async () => {
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
    press('実寸');
    expect(img.style.width, '実寸で原寸へ戻らない').toBe('400px');
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
