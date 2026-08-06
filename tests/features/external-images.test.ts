/** @vitest-environment happy-dom */
/**
 * 外部の画像を読み込むかどうか(2026-08-06、user 裁定)。
 *
 * 🔑 この機構の要は「**規則が 1 つ**であること」── 本文の画像と ` ```html` の箱の
 * CSP が**同じ値**で動かないと、設定が嘘になる(片方だけ漏れる / 片方だけ出ない)。
 * だから最後に **parity test** を置く(CLAUDE.md「同じ判定が 2 か所に生えたら、
 * 規則を 1 つに寄せ、parity test を置く」)。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTERNAL_IMAGE_MODE,
  EXTERNAL_IMAGE_ATTR,
  EXTERNAL_IMAGE_MODES,
  HTML_SANDBOX_BLOCKED_MSG_TYPE,
  imgSrcDirective,
  isExternalImageMode,
  isExternalImageSrc,
} from '../../src/features/markdown/external-images';
import {
  buildHtmlSandboxIframe,
  installHtmlSandboxBlockedReporter,
} from '../../src/features/markdown/html-sandbox';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

/**
 * 箱の srcdoc の中の CSP を取り出す(属性は entity 化されている)。
 *
 * ⚠ **`content=` だけで拾ってはいけない**(この test を書いていて踏んだ)──
 * 手前に `<meta name="viewport" content="…">` が在るので、そちらが先に当たって
 * **常に viewport の値**が返り、`img-src` が見つからず空文字になる。
 * 空文字は「塞がっている」と見分けが付かないので、**取れなかったら落とす**。
 */
function cspOf(iframeHtml: string): string {
  const m = /Content-Security-Policy&quot; content=&quot;([\s\S]*?)&quot;&gt;/.exec(iframeHtml);
  const csp = m?.[1] ?? '';
  expect(csp, 'CSP を取り出せていない(この検査は何も見ていない)').toContain('default-src');
  return csp;
}

function imgSrcOf(iframeHtml: string): string {
  const m = /img-src ([^;]+);/.exec(cspOf(iframeHtml));
  expect(m, 'img-src が無い').not.toBeNull();
  return m![1]!;
}

describe('外か中かの判定(isExternalImageSrc)', () => {
  it('要求が飛ぶものは外', () => {
    for (const src of [
      'https://example.com/x.png',
      'http://example.com/x.png',
      '//example.com/x.png', // scheme 相対 ── 相対に見えて外へ飛ぶ
      'ftp://example.com/x.png',
      'HTTPS://example.com/x.png', // 大文字でも同じ
      'x-unknown://example.com/x.png', // 知らない scheme は外に倒す
    ])
      expect(isExternalImageSrc(src), src).toBe(true);
  });

  it('手元のもの・PKC 自身の scheme・相対は外ではない', () => {
    for (const src of [
      'data:image/png;base64,AAAA',
      'blob:abc',
      // 🔴 PKC 自身の scheme は要求を飛ばさない ── 外扱いにすると確認の帯が
      //    「外部の画像が 1 件」と嘘をつき、同意しても何も起きない(2026-08-06)
      'pkc://asset/x.png',
      'entry:abc',
      'asset:k1',
      '/local/x.png',
      './x.png',
      '../x.png',
      'x.png',
      '#anchor',
      '',
      '   ',
    ])
      expect(isExternalImageSrc(src), src).toBe(false);
  });
});

describe('設定の 3 択', () => {
  it('user 裁定どおりの並びと文言', () => {
    expect(EXTERNAL_IMAGE_MODES.map((m) => m.id)).toEqual(['always', 'ask', 'never']);
    expect(EXTERNAL_IMAGE_MODES.map((m) => m.label)).toEqual([
      '常にオン',
      '常に確認',
      '常にオフ',
    ]);
  });

  it('既定は「常に確認」── 漏れる側を既定にしない', () => {
    expect(DEFAULT_EXTERNAL_IMAGE_MODE).toBe('ask');
  });

  it('知らない値は受けない', () => {
    expect(isExternalImageMode('always')).toBe(true);
    expect(isExternalImageMode('auto')).toBe(false);
    expect(isExternalImageMode('')).toBe(false);
  });
});

describe('箱の CSP(imgSrcDirective)', () => {
  it('塞ぐ側に `self` を書かない ── 箱の origin は opaque で何にも一致しない', () => {
    expect(imgSrcDirective(false)).toBe('data: blob:');
    expect(imgSrcDirective(false)).not.toContain("'self'");
  });

  it('開ける側は任意の相手を許す', () => {
    expect(imgSrcDirective(true)).toBe('* data: blob:');
  });
});

describe('箱(buildHtmlSandboxIframe)', () => {
  it('既定は塞ぐ ── 引数を渡し忘れても漏れない', () => {
    expect(imgSrcOf(buildHtmlSandboxIframe('<b>x</b>'))).toBe('data: blob:');
  });

  it('許可すると img-src が開く。ほかの directive は動かない', () => {
    const blocked = cspOf(buildHtmlSandboxIframe('<b>x</b>', '', 0, false));
    const allowed = cspOf(buildHtmlSandboxIframe('<b>x</b>', '', 0, true));
    expect(imgSrcOf(buildHtmlSandboxIframe('<b>x</b>', '', 0, true))).toBe('* data: blob:');
    // ⚠ **1 か所しか変わらない**ことを見る(ほかを緩めていない)
    expect(blocked.replace('img-src data: blob:', 'X')).toBe(
      allowed.replace('img-src * data: blob:', 'X'),
    );
    for (const d of ["connect-src 'none'", "frame-src 'none'", "script-src 'unsafe-inline'"])
      expect(allowed).toContain(d);
  });

  it('止めた件数を親へ申告する script が入っている', () => {
    const html = buildHtmlSandboxIframe('<b>x</b>');
    expect(html).toContain('securitypolicyviolation');
    expect(html).toContain(HTML_SANDBOX_BLOCKED_MSG_TYPE);
  });

  /**
   * 🔴 message type の名前が箱の id の形と**衝突しない**こと(2026-08-06 に踏んだ)。
   * 箱の id は `pkc-html-render-<hash>` で、goldens の正規化などが
   * `pkc-html-render-…` を拾って書き換える ── message type が同じ前置きだと
   * **一緒に書き換えられて別物になる**。
   */
  it('申告の名前は箱の id の前置きで始まらない', () => {
    expect(HTML_SANDBOX_BLOCKED_MSG_TYPE.startsWith('pkc-html-render-')).toBe(false);
  });
});

describe('申告の受け口(installHtmlSandboxBlockedReporter)', () => {
  function box(id: string): { iframe: HTMLIFrameElement; win: object } {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('data-pkc-html-render-id', id);
    const win = { boxId: id };
    Object.defineProperty(iframe, 'contentWindow', { value: win, configurable: true });
    document.body.append(iframe);
    return { iframe, win };
  }

  function post(data: unknown, source?: object): void {
    const ev = new MessageEvent('message', { data });
    if (source !== undefined)
      Object.defineProperty(ev, 'source', { value: source, configurable: true });
    window.dispatchEvent(ev);
  }

  it('自分の箱の申告は届く', () => {
    const seen: Array<[string | null, number]> = [];
    const off = installHtmlSandboxBlockedReporter((el, n) =>
      seen.push([el.getAttribute('data-pkc-html-render-id'), n]),
    );
    const a = box('pkc-html-render-aaa');
    post({ type: HTML_SANDBOX_BLOCKED_MSG_TYPE, id: 'pkc-html-render-aaa', blocked: 3 }, a.win);
    expect(seen).toEqual([['pkc-html-render-aaa', 3]]);
    off();
    document.body.textContent = '';
  });

  /**
   * 🔴 **なりすましを通さない**。id は中身の hash なので**文書側から計算できる** ──
   * 箱 A が箱 B の名を騙れると、user は**在りもしない画像**の同意を求められ、
   * 同意すると A の画像が読める。判定は `resize` と同じ「実際の送り主」1 つ。
   */
  it('他の箱の名を騙った申告は捨てる', () => {
    const seen: number[] = [];
    const off = installHtmlSandboxBlockedReporter((_el, n) => seen.push(n));
    const a = box('pkc-html-render-aaa');
    box('pkc-html-render-bbb');
    post({ type: HTML_SANDBOX_BLOCKED_MSG_TYPE, id: 'pkc-html-render-bbb', blocked: 9 }, a.win);
    expect(seen).toEqual([]);
    off();
    document.body.textContent = '';
  });

  it('送り主不明・0 件・形が違うものは捨てる', () => {
    const seen: number[] = [];
    const off = installHtmlSandboxBlockedReporter((_el, n) => seen.push(n));
    const a = box('pkc-html-render-aaa');
    post({ type: HTML_SANDBOX_BLOCKED_MSG_TYPE, id: 'pkc-html-render-aaa', blocked: 1 }); // source 無し
    post({ type: HTML_SANDBOX_BLOCKED_MSG_TYPE, id: 'pkc-html-render-aaa', blocked: 0 }, a.win);
    post({ type: 'pkc-html-render-resize', id: 'pkc-html-render-aaa', height: 10 }, a.win);
    post({ type: HTML_SANDBOX_BLOCKED_MSG_TYPE, id: 'pkc-html-render-aaa' }, a.win);
    expect(seen).toEqual([]);
    off();
    document.body.textContent = '';
  });

  it('teardown で聴かなくなる', () => {
    const seen: number[] = [];
    const off = installHtmlSandboxBlockedReporter((_el, n) => seen.push(n));
    const a = box('pkc-html-render-aaa');
    off();
    post({ type: HTML_SANDBOX_BLOCKED_MSG_TYPE, id: 'pkc-html-render-aaa', blocked: 2 }, a.win);
    expect(seen).toEqual([]);
    document.body.textContent = '';
  });
});

describe('本文の画像', () => {
  function img(md: string, allow?: boolean): HTMLImageElement {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(md, { allowExternalImages: allow });
    return host.querySelector('img')!;
  }

  it('既定は src を持たず、URL は属性に残る', () => {
    const el = img('![a](https://example.com/x.png)');
    expect(el.hasAttribute('src')).toBe(false);
    expect(el.getAttribute(EXTERNAL_IMAGE_ATTR)).toBe('https://example.com/x.png');
  });

  it('許可すると src が載り、退避の属性は消える', () => {
    const el = img('![a](https://example.com/x.png)', true);
    expect(el.getAttribute('src')).toBe('https://example.com/x.png');
    expect(el.hasAttribute(EXTERNAL_IMAGE_ATTR)).toBe(false);
  });

  it('表のセルの中の画像も同じ扱い(セルだけ設定を無視しない)', () => {
    const md = '| a |\n|---|\n| ![x](https://example.com/y.png) |\n';
    expect(img(md).hasAttribute('src')).toBe(false);
    expect(img(md, true).getAttribute('src')).toBe('https://example.com/y.png');
  });

  /**
   * 🔴 **csv の表のセルは別の口を通る**(2026-08-06、変異試験 M12 が生き延びて判明)。
   *
   * markdown の表は文書の `env` をそのまま使うが、csv fence のセルは
   * **使い捨ての env**(`cellEnv`)で描かれる ── 脚注が漏れる事故を防ぐために
   * 文書の env を渡さない作りにしてあるので、**写し忘れると設定が届かない**。
   * 上の markdown 表の test はこの経路を 1 度も通っていなかった。
   */
  it('csv fence のセルの中の画像も同じ扱い(使い捨て env に写している)', () => {
    const md = '```csv-render\n列A\n![x](https://example.com/c.png)\n```\n';
    expect(img(md).hasAttribute('src')).toBe(false);
    expect(img(md).getAttribute(EXTERNAL_IMAGE_ATTR)).toBe('https://example.com/c.png');
    expect(img(md, true).getAttribute('src')).toBe('https://example.com/c.png');
  });

  it('手元の画像は素通り(退避しない)', () => {
    const el = img('![a](data:image/png;base64,AAAA)');
    expect(el.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(el.hasAttribute(EXTERNAL_IMAGE_ATTR)).toBe(false);
  });
});

/**
 * 🔴 **本文の画像と箱の CSP は必ず同じ向きに動く**(2026-08-06)。
 *
 * これが崩れると設定が嘘になる ── 「常にオフ」でも箱の画像が出る、あるいは
 * 「常にオン」でも本文の画像が出ない。⚠ **同じ 1 回の描画**で両方を見るのが要点
 * (別々に呼んで別々に assert すると、値を取り違えても両方緑になりうる)。
 */
describe('parity: 本文の画像と箱の CSP', () => {
  const body = '![a](https://example.com/x.png)\n\n```html\n<b>x</b>\n```\n';
  for (const allow of [false, true]) {
    it(`allowExternalImages=${allow} で 2 つの面が揃う`, () => {
      const host = document.createElement('div');
      host.innerHTML = renderMarkdown(body, { allowExternalImages: allow });
      const el = host.querySelector('img')!;
      const srcdoc = host.querySelector('iframe')!.getAttribute('srcdoc') ?? '';
      // ⚠ fixture のゼロ件の次元は測っていない次元 ── 両方が実在することを確かめる
      expect(el).not.toBeNull();
      expect(srcdoc).not.toBe('');
      const bodyLoads = el.hasAttribute('src');
      const boxLoads = /img-src \* data: blob:/.test(srcdoc);
      expect(bodyLoads).toBe(allow);
      expect(boxLoads).toBe(allow);
      expect(bodyLoads).toBe(boxLoads);
    });
  }
});
