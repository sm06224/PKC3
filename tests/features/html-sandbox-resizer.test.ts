/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  installHtmlSandboxResizer,
  HTML_SANDBOX_RESIZE_MSG_TYPE,
  HTML_SANDBOX_MAX_HEIGHT,
  resolveSandboxSender,
  clampSandboxHeight,
} from '../../src/features/markdown/html-sandbox';

/**
 * 箱を 1 つ置く。
 * ⚠ **送り主(`contentWindow`)を持たせる** ── 高さの申告は「名乗った id」ではなく
 *   **実際の送り主**で宛先が決まる(2026-08-06。なりすまし対策)。
 *   happy-dom の iframe は `contentWindow` を差し替えられないので定義する。
 */
function iframeWithId(id: string): HTMLIFrameElement & { fakeWindow: object } {
  const iframe = document.createElement('iframe') as HTMLIFrameElement & { fakeWindow: object };
  iframe.setAttribute('data-pkc-html-render-id', id);
  const win = { boxId: id };
  Object.defineProperty(iframe, 'contentWindow', { value: win, configurable: true });
  iframe.fakeWindow = win;
  document.body.append(iframe);
  return iframe;
}

/**
 * 申告を届ける。⚠ **`source` を渡す**のがこの機構の本体である
 * (渡さない = 送り主不明 = 何も起きないのが正しい。下の test でそれも pin する)。
 */
function post(data: unknown, source?: object): void {
  const ev = new MessageEvent('message', { data });
  if (source !== undefined) {
    Object.defineProperty(ev, 'source', { value: source, configurable: true });
  }
  window.dispatchEvent(ev);
}

describe('installHtmlSandboxResizer (P3-5 結線)', () => {
  it('resize message で対応 iframe の高さが追従し、cap でクランプされる', () => {
    const off = installHtmlSandboxResizer();
    const iframe = iframeWithId('pkc-html-render-abc');
    const w = iframe.fakeWindow;
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'pkc-html-render-abc', height: 420 }, w);
    expect(iframe.style.height).toBe('420px');
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'pkc-html-render-abc', height: 999999 }, w);
    expect(iframe.style.height).toBe('5000px'); // HTML_SANDBOX_MAX_HEIGHT
    // ⚠ **送り主を伴わない申告は何も起こさない**(直す前はこれで通っていた)
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'pkc-html-render-abc', height: 77 });
    expect(iframe.style.height, '送り主不明の申告が通った').toBe('5000px');
    iframe.remove();
    off();
  });

  it('型不一致 / 未知 id / teardown 後は何もしない', () => {
    const off = installHtmlSandboxResizer();
    const iframe = iframeWithId('pkc-html-render-x');
    const w = iframe.fakeWindow;
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'pkc-html-render-x', height: 'tall' }, w);
    post({ type: 'other', id: 'pkc-html-render-x', height: 100 }, w);
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'unknown', height: 100 }, w);
    expect(iframe.style.height).toBe('');
    off();
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'pkc-html-render-x', height: 100 }, w);
    expect(iframe.style.height).toBe(''); // teardown 済み
    iframe.remove();
  });
});

/**
 * 🔴 **箱 A が箱 B の高さを 0px にできない**(2026-08-06。方向 doc §1 C1)。
 *
 * 直す前は届いた `data.id` で `querySelector` していた。ところが id は中身の
 * FNV-1a(`stableKey`)なので **文書側から計算できる** ── つまり同じ文書の中の
 * 箱 A が、箱 B の id を名乗って **B の高さを 0px にできた**(= B の中身を隠せた)。
 * 高さの cap(5000px)は「大きすぎ」だけを守っており、**なりすまし**は素通りだった。
 *
 * 🔑 観測点は **なりすましそのもの**(送り主 ≠ 名乗り)。「高さが cap 内か」のような
 * 下流の検査では素通りする ── 0px は cap 内である。
 */
describe('🔴 送り主の同一性(なりすましを通さない)', () => {
  /** 箱を 2 つ置く。`contentWindow` は差せないので、`iframe` を模した要素で代用する。 */
  function twoBoxes(): { a: HTMLElement; b: HTMLElement; winA: object; winB: object } {
    document.body.textContent = '';
    const mk = (id: string, win: object): HTMLElement => {
      const el = document.createElement('iframe');
      el.setAttribute('data-pkc-html-render-id', id);
      // ⚠ happy-dom の iframe は contentWindow を差し替えられないので定義する
      Object.defineProperty(el, 'contentWindow', { value: win, configurable: true });
      document.body.append(el);
      return el;
    };
    const winA = { name: 'A' };
    const winB = { name: 'B' };
    return { a: mk('pkc-html-render-aaa', winA), b: mk('pkc-html-render-bbb', winB), winA, winB };
  }

  it('🔴 A が B の id を名乗っても、B は解決されない', () => {
    const { winA } = twoBoxes();
    const hit = resolveSandboxSender(document, winA as unknown as MessageEventSource, 'pkc-html-render-bbb');
    expect(hit, 'なりすましが通った(箱 B の中身を隠せる)').toBeNull();
  });

  it('🔑 自分の id を名乗った箱は解決される(締めすぎていない)', () => {
    const { a, winA } = twoBoxes();
    const hit = resolveSandboxSender(document, winA as unknown as MessageEventSource, 'pkc-html-render-aaa');
    expect(hit, '正しい申告が通らない(高さが 0 のまま = 完全に不可視)').toBe(a);
  });

  it('⚠ 送り主が箱でない(親や拡張)なら何もしない', () => {
    twoBoxes();
    expect(resolveSandboxSender(document, {} as MessageEventSource, 'pkc-html-render-aaa')).toBeNull();
  });

  /**
   * 🔴 **まだ読み込まれていない箱に当ててはいけない**。
   *
   * PKC3 の箱は `loading="lazy"` が既定なので、**画面外の箱は `contentWindow` が
   * `null`** である。送り主が無い(`source === null`)申告を素通しすると、
   * その `null` が **未読込の箱の `contentWindow` と一致してしまう** ──
   * つまり「送り主のいない申告」が画面外の箱に当たる。
   * ⚠ 最初この test を書かず、`source === null` の門を消す変異が**生き延びた**
   *   (fixture に未読込の箱が 0 件 = 測っていない次元だった)。
   */
  it('🔴 送り主が無い申告は、未読込の箱(contentWindow が null)にも当たらない', () => {
    document.body.textContent = '';
    const lazy = document.createElement('iframe');
    lazy.setAttribute('data-pkc-html-render-id', 'pkc-html-render-lazy');
    lazy.setAttribute('loading', 'lazy');
    Object.defineProperty(lazy, 'contentWindow', { value: null, configurable: true });
    document.body.append(lazy);
    expect(
      resolveSandboxSender(document, null, 'pkc-html-render-lazy'),
      '送り主のいない申告が未読込の箱に当たった',
    ).toBeNull();
  });

  it('⚠ 高さの丸めは「大きすぎ」と「壊れた値」だけを守る', () => {
    expect(clampSandboxHeight(-5)).toBe(0);
    expect(clampSandboxHeight(120)).toBe(120);
    expect(clampSandboxHeight(99999)).toBe(HTML_SANDBOX_MAX_HEIGHT);
    // ⚠ NaN を通すと `style.height = "NaNpx"` になって高さが決まらない
    expect(clampSandboxHeight(Number.NaN)).toBe(0);
  });

  /**
   * 🔴 **書き出した HTML の閲覧側も同じ規則**(規則を 2 か所に書かない)。
   * ⚠ parity は**両向き**で見る ── 「A が受けるものは B も受ける」だけでは、
   *   「B のほうが緩い」現在の差異が通ってしまう。**A が拒むものを B も拒む**か。
   */
  it('🔴 閲覧側(書き出し HTML)も送り主で決めている', () => {
    const viewer = readFileSync('src/features/export/pkc3-html.ts', 'utf8');
    expect(viewer, '閲覧側が送り主を見ていない').toContain('contentWindow===ev.source');
    // 名乗りは照合にしか使わない(名乗りで引いていない)
    expect(viewer, '閲覧側が名乗った id で querySelector している').not.toContain(
      "'iframe[data-pkc-html-render-id=\"'+d.id",
    );
    // ⚠ origin を条件に足していない(sandbox の箱では "null" になり判定に使えない)
    expect(viewer, '閲覧側が origin を判定に使っている').not.toMatch(/ev\.origin\s*[!=]==/);
  });
});
