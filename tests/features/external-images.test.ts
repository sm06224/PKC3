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
  SANDBOX_BLOCKED_LABELS,
  sandboxBlockedKind,
  sandboxBlockedNote,
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

  /**
   * 🔴 **画像 0 件の申告を捨てない**(#528 段③、2026-08-28 に踏んだ)。
   *
   * ⚠ 外部の script だけ止まった箱は `blocked: 0` で来る ── 直す前の受け口は
   *   `blocked > 0` を要求していたので、**その申告を丸ごと捨てて**いた。
   *   帯を組む側も、種別を畳む側も正しかったのに、**入口で消えていた**。
   * 🔑 対照群を同じ it に置く(「種別も画像も無ければ捨てる」)── 置かないと、
   *   「受けるようになった」のか「何でも受けるようになった」のか見分けられない。
   */
  it('画像 0 件でも、種別が在れば届く(無ければ捨てる)', () => {
    const seen: Array<[number, readonly string[]]> = [];
    const off = installHtmlSandboxBlockedReporter((_el, n, kinds) => seen.push([n, kinds]));
    const a = box('pkc-html-render-aaa');
    post(
      {
        type: HTML_SANDBOX_BLOCKED_MSG_TYPE,
        id: 'pkc-html-render-aaa',
        blocked: 0,
        kinds: ['script-src-elem'],
      },
      a.win,
    );
    // 対照群: 画像も種別も無い申告は、これまでどおり捨てる
    post(
      { type: HTML_SANDBOX_BLOCKED_MSG_TYPE, id: 'pkc-html-render-aaa', blocked: 0, kinds: [] },
      a.win,
    );
    expect(seen).toEqual([[0, ['script-src-elem']]]);
    off();
    document.body.textContent = '';
  });

  /**
   * ⚠ 箱の中は **user が書いた HTML** なので、申告の形は信用しない
   * (`postMessage` は箱の script からいくらでも撃てる)。
   */
  it('種別が文字列でなければ落とす', () => {
    const seen: Array<readonly string[]> = [];
    const off = installHtmlSandboxBlockedReporter((_el, _n, kinds) => seen.push(kinds));
    const a = box('pkc-html-render-aaa');
    post(
      {
        type: HTML_SANDBOX_BLOCKED_MSG_TYPE,
        id: 'pkc-html-render-aaa',
        blocked: 1,
        kinds: ['script-src', 42, null, { toString: () => 'style-src' }],
      },
      a.win,
    );
    post(
      {
        type: HTML_SANDBOX_BLOCKED_MSG_TYPE,
        id: 'pkc-html-render-aaa',
        blocked: 1,
        kinds: 'script-src',
      },
      a.win,
    );
    expect(seen).toEqual([['script-src'], []]);
    off();
    document.body.textContent = '';
  });

  /**
   * 🔴 **箱の中の見張りが、画像以外も拾っていること**(#528 段③)。
   * ⚠ 受け口だけ直しても、**送り手が数えていなければ 1 件も来ない** ──
   *   両端のどちらかしか見ない test は、この食い違いを原理的に見られない
   *   (CLAUDE.md §7「両端が相手を模した stub と話していると、綴りの食い違いが
   *   両方緑のまま通る」)。ここでは**実物の srcdoc の字**を読む。
   */
  it('箱の中の見張りは、画像とそれ以外を別々に数えて送る', () => {
    // ⚠ 戻り値は `<iframe …>` の**文字列**である(srcdoc は entity 化されて
    //   埋まっている)── 引用符だけが `&quot;` になり、script の中の `'` は素のまま
    const doc = buildHtmlSandboxIframe('<b>x</b>');
    // 画像は件数、それ以外は種別の集合(URL は運ばない)
    expect(doc).toContain("if(d.indexOf('img-src')===0)blocked++;else kinds[d]=1;");
    expect(doc).toContain('kinds:Object.keys(kinds)');
    // ⚠ 空振り防止 ── 見張りそのものが在ること
    expect(doc).toContain("document.addEventListener('securitypolicyviolation'");
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

/**
 * 🔴 **止めた画像の見張りは、user の中身より前に登録されていなければならない**
 * (2026-08-07。CI が 3 回に 1 回赤くなって判明)。
 *
 * かつて `securitypolicyviolation` の listener は resize script と一緒に
 * **body の末尾**、つまり user の中身の**後ろ**に置かれていた。
 * `<script>new Image().src='https://…'</script>` のように**解析中に**画像を
 * 要求する中身では、違反が listener の登録より**先**に起きうる ── 起きる順は
 * 実装依存なので、**同じ入力で出たり出なかったりする**
 * (`chromium_headless_shell` で 3 回に 1 回、帯が出なかった)。
 *
 * ⚠ **これは test の flake ではなく製品の穴**である。帯が出なければ、その箱の画像は
 *   「常に確認」の設定下で**二度と同意できない**。
 * ⚠ 順序は smoke でも見えるが、smoke は**確率的にしか**落ちない ── だから
 *   ここで**字面の順序**を直接 pin する(CLAUDE.md「壊れる当の振る舞いを直接見る」)。
 */
describe('箱の中の違反の見張り', () => {
  const srcdocOf = (content: string): string => {
    const host = document.createElement('div');
    host.innerHTML = buildHtmlSandboxIframe(content);
    return host.querySelector('iframe')!.getAttribute('srcdoc') ?? '';
  };

  it('🔴 見張りの登録が user の中身より前に在る', () => {
    const marker = '<em data-probe="1">中身</em>';
    const doc = srcdocOf(marker);
    const listener = doc.indexOf('securitypolicyviolation');
    // ⚠ `getAttribute('srcdoc')` は実体参照が解けた**素の HTML** を返す
    const content = doc.indexOf('<em data-probe="1">');
    expect(listener, '見張りが箱に入っていない(この検査は空振り)').toBeGreaterThan(0);
    expect(content, 'user の中身が箱に入っていない(この検査は空振り)').toBeGreaterThan(0);
    expect(listener, '見張りが user の中身より後ろに在る(解析中の違反を取り逃す)').toBeLessThan(
      content,
    );
  });

  /**
   * ⚠ **CSP の宣言より後**でなければならない ── 前に置くと、方針が効く前に
   * script が走る(その script 自身が `script-src` の対象になる)。
   */
  it('🔴 見張りは CSP の宣言より後ろに在る', () => {
    const doc = srcdocOf('<b>x</b>');
    expect(doc.indexOf('securitypolicyviolation')).toBeGreaterThan(
      doc.indexOf('Content-Security-Policy'),
    );
  });

  /**
   * 🔴 **位置ではなく「同期に登録されるか」を見る**(2026-08-07、レビュー 2 巡目)。
   *
   * 上の 2 本は字面の位置しか見ていないので、次の 1 行で**バグが完全に復活したまま
   * 緑**になる ── script は head の同じ位置に在り、`indexOf` も content より小さい:
   *
   * ```diff
   * -    "document.addEventListener('securitypolicyviolation',function(ev){" +
   * +    "window.addEventListener('DOMContentLoaded',function(){" +
   * +    "document.addEventListener('securitypolicyviolation',function(ev){" +
   * ```
   *
   * だから**実際に走らせて**、`document.addEventListener` が**その場で**
   * 呼ばれることを見る(`setTimeout(…,0)` で包む変異も同じく落ちる)。
   */
  it('🔴 見張りは同期に登録される(解析中の違反を取り逃さない)', () => {
    const doc = srcdocOf('<b>x</b>');
    // head の script = srcdoc の**最初の** script(resize は body 末尾)
    const script = /<script>([\s\S]*?)<\/script>/.exec(doc)?.[1];
    expect(script, 'head に script が無い(この検査は空振り)').toBeTruthy();
    expect(script, '違反の見張りではない script を掴んでいる').toContain(
      'securitypolicyviolation',
    );
    const registered: string[] = [];
    const fakeDoc = { addEventListener: (type: string) => registered.push(type) };
    const fakeWin = { addEventListener: (type: string) => registered.push(`window:${type}`) };
    new Function('document', 'window', 'setTimeout', script!)(fakeDoc, fakeWin, () => 0);
    expect(
      registered,
      '見張りが同期に登録されていない(DOMContentLoaded / setTimeout で遅らせている)',
    ).toEqual(['securitypolicyviolation']);
  });

  it('件数はまとめて 1 通だけ送る(100 枚の箱で 100 通飛ばさない)', () => {
    const doc = srcdocOf('<b>x</b>');
    // ⚠ 送信は 1 か所きり ── 増えたら「1 枚ごとに送る」へ戻っている
    expect(doc.split('pkc-html-blocked-images').length - 1).toBe(1);
    expect(doc, 'まとめる仕掛け(timer)が無い').toContain('timer=setTimeout');
    // ⚠ **早期 return が無いと 1 枚ごとに timer を張る** ── 上の 2 つだけでは
    //    `if(timer)return;` を消す変異が生き延びる(レビュー 2 巡目の指摘)
    expect(doc, 'まとめる早期 return が無い(1 枚ごとに送ってしまう)').toContain(
      'if(timer)return',
    );
  });
});

/**
 * 🔴 **画像以外が止まったことを言う**(#528 段③、2026-08-28)。
 *
 * ⚠ 直す前、箱の見張りは **`img-src` の違反だけ**を数えていた ── CDN から
 *   script / CSS を取る中身は**真っ白になり、理由が画面のどこにも無い**
 *   (user は「PKC が壊れた」と読む)。
 * 🔑 ここで作るのは**説明**であって、門ではない ── 種別が増えても
 *   読み込みは 1 つも通らない。
 */
describe('箱が止めた「画像以外」の種別(#528 段③)', () => {
  it('CSP の項目名を、user に見せる種別へ畳む', () => {
    // ⚠ 実ブラウザが載せてくるのは `script-src-elem` のような**細かい名前**である
    //   (`effectiveDirective`)。頭で見分ける ── 完全一致で書くと取りこぼす
    expect(sandboxBlockedKind('script-src-elem')).toBe('script');
    expect(sandboxBlockedKind('script-src-attr')).toBe('script');
    expect(sandboxBlockedKind('style-src-elem')).toBe('style');
    expect(sandboxBlockedKind('connect-src')).toBe('connect');
    expect(sandboxBlockedKind('frame-src')).toBe('frame');
    expect(sandboxBlockedKind('child-src')).toBe('frame');
    // 知らない項目も捨てない(「そのほか」で言う)── 黙るのがいちばん悪い
    expect(sandboxBlockedKind('font-src')).toBe('other');
    expect(sandboxBlockedKind('media-src')).toBe('other');
  });

  /**
   * 🔴 **`img-src` だけは別**(帯のほうが受け持つ)。
   * ⚠ ここが `null` を返さなくなると、**同意で開けられるはずの画像**に
   *   「開けられません」と書いた行が並ぶ ── user は同意する手を止める。
   */
  it('画像は種別に数えない(同意で開けられる別の話だから)', () => {
    expect(sandboxBlockedKind('img-src')).toBeNull();
    expect(sandboxBlockedKind('IMG-SRC')).toBeNull();
  });

  it('種別が 1 つも無ければ、行そのものを出さない', () => {
    expect(sandboxBlockedNote([])).toBe('');
  });

  /**
   * ⚠ **並びを固定する**(集合は順序を持たないので、書かないと出るたびに変わる)。
   * 🔑 同じ状態が違う字に見えると、user は「また別のことが起きた」と読む。
   */
  it('並びは、来た順ではなく決めた順で出る', () => {
    const a = sandboxBlockedNote(['connect', 'script']);
    const b = sandboxBlockedNote(['script', 'connect']);
    expect(a).toBe(b);
    expect(a.indexOf(SANDBOX_BLOCKED_LABELS.script)).toBeLessThan(
      a.indexOf(SANDBOX_BLOCKED_LABELS.connect),
    );
  });

  it('同じ種別を何度渡しても 1 回しか出ない', () => {
    const note = sandboxBlockedNote(['script', 'script', 'script']);
    expect(note.split(SANDBOX_BLOCKED_LABELS.script).length - 1).toBe(1);
  });

  /**
   * 🔑 **理由だけでなく、動かしたいときの道も書く**(CLAUDE.md「どこにあるかを書く
   * ── 探させない」)。⚠ 道が実在することは `tests/features/launcher-tiles.test.ts`
   * 側が持つ(`isAppMime` が `text/html` を受ける)。
   */
  it('止めた理由と、動かしたいときの道を書く', () => {
    const note = sandboxBlockedNote(['script']);
    expect(note).toContain(SANDBOX_BLOCKED_LABELS.script);
    expect(note).toContain('止めました');
    expect(note).toContain('アプリとして登録');
  });
});
