/** @vitest-environment happy-dom */
/**
 * 画像を別の窓で見る(#192 / 台帳 #180 の D-2)。
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
import { openImageWindow } from '../../src/adapter/platform/image-window';

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

describe('画像の別窓', () => {
  it('🔴 開くと img が 1 枚入り、題名は文字として入る', async () => {
    const win = fakeWindow();
    const lent = { url: 'blob:x', dispose: vi.fn() };
    const h = await openImageWindow({
      lent,
      title: '<script>あぶない</script>.png',
      open: () => win,
      waitClose: () => new Promise(() => undefined), // 閉じない
    });
    expect(h).not.toBeNull();
    const img = win.document.querySelector<HTMLImageElement>('[data-pkc-field="image-window-image"]');
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
    await openImageWindow({
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
    const h = await openImageWindow({ lent, title: 'a.png', open: () => null });
    expect(h, '開けていないのに handle を返した').toBeNull();
    expect(lent.dispose, '開けなかったのに捨てていない').toHaveBeenCalledTimes(1);
  });

  it('待ちが失敗しても捨てる(例外で寿命が漏れない)', async () => {
    const win = fakeWindow();
    const lent = { url: 'blob:x', dispose: vi.fn() };
    await openImageWindow({
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
    await openImageWindow({
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
    const h = await openImageWindow({
      lent: { url: 'blob:x', dispose: vi.fn() },
      title: 'a.png',
      requestPip: () => Promise.reject(new Error('user gesture required')),
      open,
      waitClose: () => new Promise(() => undefined),
    });
    expect(h, 'PiP の失敗で開けなくなった').not.toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('close() で閉じられる(閉じれば寿命の終わりに乗る)', async () => {
    const win = fakeWindow();
    const h = await openImageWindow({
      lent: { url: 'blob:x', dispose: vi.fn() },
      title: 'a.png',
      open: () => win,
      waitClose: () => new Promise(() => undefined),
    });
    h!.close();
    expect(win.closed).toBe(true);
  });
});
