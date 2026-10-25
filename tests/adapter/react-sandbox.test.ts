/** @vitest-environment happy-dom */
/**
 * React(JSX)の囲み(#528 ②)。
 *
 * 守る主張:
 * 1. 本文では placeholder(ランタイムを焼かない)になり、`react` だけ(`jsx` は従来どおりコード)。-norender は原文だけ
 * 2. 箱は `sandbox="allow-scripts"` のみ・CSP は外へ出られない・**外部 CDN を参照しない**(ランタイムは inline)
 * 3. 箱は**見えたとき**に作り、ランタイムはその時に初めて読む / 器が外れれば箱も外す / dispose で全部外す
 * 4. 箱の台本が**実際に動く**(同梱の React + JSX 変換で、export default / App / 式だけ / import を描く。
 *    書き間違いは箱の中に理由が出る)── 箱の中の台本を本物のランタイムで動かして DOM で見る
 * 5. 箱の srcdoc に本文を入れても箱の構文が途切れない(`</script>` を含む本文)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RENDERABLE_FENCE_LANGS, parseRenderableFence, renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  REACT_FRAME_CSP,
  REACT_FRAME_HARNESS,
  reactFrameDoc,
  scriptLiteral,
} from '../../src/adapter/platform/render/react-frame-doc';
import { hydrateReact, setReactRuntimeLoader } from '../../src/adapter/ui/render/react-sandbox';
import { hydrateAllNow } from '../../src/adapter/ui/render/mermaid-hydrate';
import { hydrateFigures } from '../../src/adapter/ui/render/detail';

const JSX_SRC = 'export default function App(){ return <b className="p-2">hi</b>; }';

describe('本文での姿(features 層)', () => {
  it('🔴 react だけが描ける fence の一覧に居る。jsx は従来どおりふつうのコードブロック(既存の本文の見え方を変えない)', () => {
    expect(RENDERABLE_FENCE_LANGS.has('jsx')).toBe(false);
    expect(parseRenderableFence('jsx')).toBeNull();
    expect(parseRenderableFence('jsx-norender')).toBeNull();
    const code = renderMarkdown(`\`\`\`jsx\n${JSX_SRC}\n\`\`\`\n`);
    expect(code).not.toContain('pkc-react-placeholder');
    expect(code).toContain('language-jsx');
    for (const lang of ['react']) {
      expect(RENDERABLE_FENCE_LANGS.has(lang)).toBe(true);
      const html = renderMarkdown(`\`\`\`${lang}\n${JSX_SRC}\n\`\`\`\n`);
      expect(html, lang).toContain('pkc-react-placeholder');
      expect(html).toContain('data-pkc-react-src');
      expect(html).toContain('pkc-react-source');
      // ⚠ ランタイムも箱も本文へ焼かない(重い・塊の比較が重くなる)
      expect(html).not.toContain('<iframe');
      expect(html).not.toContain('srcdoc');
    }
  });

  it('既存の html の囲みとは衝突しない(html は今までどおり箱)', () => {
    expect(renderMarkdown('```html\n<p>x</p>\n```\n')).toContain('<iframe');
    expect(parseRenderableFence('html')?.lang).toBe('html');
    expect(parseRenderableFence('react-norender')?.mode).toBe('norender');
  });

  it('-norender は原文だけ(JSX として彩色する)', () => {
    const html = renderMarkdown(`\`\`\`react-norender\n${JSX_SRC}\n\`\`\`\n`);
    expect(html).not.toContain('pkc-react-placeholder');
    expect(html).toContain('language-jsx');
  });
});

describe('箱の中身(srcdoc)', () => {
  const doc = reactFrameDoc(JSX_SRC, '/*RUNTIME*/', '/*TAILWIND*/', 'pkc-react-t');

  it('🔴 CSP は外へ出られない・外部 CDN の参照が無い・ランタイムは inline', () => {
    expect(doc).toContain(`content="${REACT_FRAME_CSP}"`);
    expect(REACT_FRAME_CSP).toContain("default-src 'none'");
    expect(REACT_FRAME_CSP).toContain("connect-src 'none'");
    expect(REACT_FRAME_CSP).not.toMatch(/https?:|\*/);
    expect(doc, '外部 script を読んでいる').not.toMatch(/<script[^>]+src=/);
    expect(doc).not.toMatch(/https?:\/\//);
    expect(doc).toContain('/*RUNTIME*/');
    expect(doc).toContain('/*TAILWIND*/');
  });

  it('🔴 高さの申告と止めた要求の申告が入る(` ```html ` の箱と同じ口)', () => {
    expect(doc).toContain('pkc-html-render-resize');
    expect(doc).toContain('pkc-html-blocked-images');
    expect(doc).toContain('"pkc-react-t"');
  });

  it('🔴 本文に `</script>` や `<!--` や U+2028 を書いても箱の構文が途切れない', () => {
    const ls = String.fromCharCode(0x2028);
    const evil = `export default function App(){ return <p>{"</script><script>alert(1)</script><!--"}${ls}</p>; }`;
    const lit = scriptLiteral(evil);
    expect(lit).not.toContain('</script');
    expect(lit).not.toContain('<!--');
    expect(lit).not.toContain(ls);
    expect(JSON.parse(lit.replace(/\\u003c/g, '<'))).toBe(evil);
    const d = reactFrameDoc(evil, 'x', 'y', 'i');
    // script 要素は 3 つ(ランタイム / Tailwind / 台本)+ 申告 2 つ = 5 つだけ。本文が増やさない
    expect(d.match(/<script>/g)).toHaveLength(5);
  });

  it('ランタイムに `</script` が在っても字面のまま置かない', () => {
    const d = reactFrameDoc('x', 'a="</script>"', 'b', 'i');
    expect(d).toContain('a="<\\/script>"');
  });
});

describe('箱を置く(hydrate)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        static all: Array<{ cb: (e: unknown[]) => void; els: Element[] }> = [];
        els: Element[] = [];
        constructor(readonly cb: (e: unknown[]) => void) {
          (this.constructor as unknown as { all: unknown[] }).all.push(this);
        }
        observe(el: Element): void {
          this.els.push(el);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });
  afterEach(() => {
    setReactRuntimeLoader(null);
    vi.unstubAllGlobals();
  });

  function host(src: string): HTMLElement {
    const h = document.createElement('div');
    h.className = 'pkc-react-placeholder';
    h.setAttribute('data-pkc-react-src', src);
    const pre = document.createElement('pre');
    pre.className = 'pkc-react-source';
    pre.textContent = src;
    h.append(pre);
    document.body.append(h);
    return h;
  }
  const IO = (): { all: Array<{ cb: (e: unknown[]) => void; els: Element[] }> } =>
    globalThis.IntersectionObserver as unknown as { all: Array<{ cb: (e: unknown[]) => void; els: Element[] }> };
  const see = (el: Element): void => {
    for (const io of IO().all) if (io.els.includes(el)) io.cb([{ isIntersecting: true, target: el }]);
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  it('🔴 見えたときに初めてランタイムを読み、箱を 1 つ置く(読む前は何もしない)', async () => {
    const loader = vi.fn(() => Promise.resolve({ runtime: 'R', tailwind: 'T' }));
    setReactRuntimeLoader(loader);
    IO().all.length = 0;
    const h = host(JSX_SRC);
    const scope = hydrateReact([h]);
    await settle();
    expect(loader, '見えていないのにランタイムを読んだ').not.toHaveBeenCalled();
    expect(h.querySelector('iframe')).toBeNull();
    see(h);
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);
    const f = h.querySelector('iframe')!;
    expect(f, '箱が置かれていない').not.toBeNull();
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('data-pkc-html-render-id')).toMatch(/^pkc-react-/);
    expect(f.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(f.srcdoc).toContain(REACT_FRAME_CSP);
    expect(h.getAttribute('data-pkc-react-state')).toBe('ready');
    // 同じ器を 2 度見ても箱は 1 つ
    see(h);
    await settle();
    expect(h.querySelectorAll('iframe')).toHaveLength(1);
    scope.dispose();
    expect(document.querySelector('iframe'), 'dispose で箱が残っている').toBeNull();
  });

  it('🔴 同じ原文を 2 つ書いても箱の id は別(高さの申告の宛先を取り違えない)/ 同じ入力なら id は同じ(作り直さない)', async () => {
    setReactRuntimeLoader(() => Promise.resolve({ runtime: 'R', tailwind: 'T' }));
    const ids = async (): Promise<string[]> => {
      document.body.innerHTML = '';
      IO().all.length = 0;
      const a = host(JSX_SRC);
      const b = host(JSX_SRC);
      const sc = hydrateReact([a, b]);
      see(a);
      see(b);
      await settle();
      const out = [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('data-pkc-html-render-id') ?? '');
      sc.dispose();
      return out;
    };
    const first = await ids();
    expect(first).toHaveLength(2);
    expect(first[0]).not.toBe(first[1]);
    expect(await ids(), '同じ入力で id が変わる').toEqual(first);
  });

  it('🔴 器が画面から外れたら prune で箱も外れ、数が減る', async () => {
    setReactRuntimeLoader(() => Promise.resolve({ runtime: 'R', tailwind: 'T' }));
    IO().all.length = 0;
    const a = host('export default function App(){return <i/>}');
    const b = host('export default function App(){return <u/>}');
    const scope = hydrateReact([a, b]);
    see(a);
    see(b);
    await settle();
    expect(scope.prune()).toBe(2);
    const f = a.querySelector('iframe')!;
    a.remove();
    expect(scope.prune()).toBe(1);
    expect(f.isConnected).toBe(false);
    scope.dispose();
  });

  it('🔴 ランタイムを読めなければ理由を器に残し、原文は消さない(次の機会にやり直せる)', async () => {
    let n = 0;
    setReactRuntimeLoader(() => (++n === 1 ? Promise.reject(new Error('chunk 404')) : Promise.resolve({ runtime: 'R', tailwind: 'T' })));
    IO().all.length = 0;
    const h = host(JSX_SRC);
    const scope = hydrateReact([h]);
    see(h);
    await settle();
    expect(h.getAttribute('data-pkc-react-state')).toBe('failed');
    expect(h.getAttribute('data-pkc-react-error') ?? '').toContain('React を描けません');
    expect(h.querySelector('.pkc-react-source'), '原文まで消した').not.toBeNull();
    expect(h.querySelector('iframe')).toBeNull();
    // 対照群: 読めれば置ける(失敗を覚えていない)
    await scope.flush!(document.body);
    expect(h.querySelector('iframe')).not.toBeNull();
    scope.dispose();
  });

  it('🔴 印刷: 画面の外(まだ見えていない)React の枠も、hydrateAllNow が箱にして待つ / dispose した塊は頼まない', async () => {
    setReactRuntimeLoader(() => Promise.resolve({ runtime: 'R', tailwind: 'T' }));
    IO().all.length = 0;
    const a = host('export default function App(){return <i/>}');
    const b = host('export default function App(){return <u/>}');
    const scope = hydrateReact([a, b]);
    await settle();
    // 台の前提:誰も「見えた」と言っていない = 箱は無い
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    const printing = hydrateAllNow(document.body);
    // 箱が load するまで待つ ── happy-dom は load を撃たないので、撃って進める
    await settle();
    for (const f of document.querySelectorAll('iframe')) f.dispatchEvent(new Event('load'));
    await printing;
    expect(document.querySelectorAll('iframe'), '画面の外の React が箱になっていない(印刷で描かれない)').toHaveLength(2);
    expect(a.getAttribute('data-pkc-react-state')).toBe('ready');
    // 畳んだ塊は名簿から外れる(外れないと、畳んだ塊の箱を印刷のたびに作り直す)
    scope.dispose();
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    const c = host('export default function App(){return <b/>}');
    await hydrateAllNow(document.body);
    expect(c.querySelector('iframe'), '畳んだ塊が名簿に残っている').toBeNull();
  });

  it('読む面と同じ束ね口(hydrateFigures)に入っている', async () => {
    setReactRuntimeLoader(() => Promise.resolve({ runtime: 'R', tailwind: 'T' }));
    IO().all.length = 0;
    const h = host(JSX_SRC);
    const scopes = hydrateFigures([h]);
    see(h);
    await settle();
    expect(h.querySelector('iframe'), 'hydrateFigures が React を拾わない').not.toBeNull();
    scopes.forEach((s) => s.dispose());
  });
});

describe('箱の台本を、本物のランタイムで動かす', () => {
  async function run(src: string): Promise<HTMLElement> {
    document.body.innerHTML = '<div id="root"></div>';
    delete (globalThis as { PkcReact?: unknown }).PkcReact;
    const runtime = (await import('virtual:pkc3-react-runtime')).default;
    (0, eval)(runtime);
    expect((globalThis as { PkcReact?: unknown }).PkcReact, 'ランタイムが入っていない').toBeDefined();
    // 台本をそのまま動かす(`__SOURCE__` に本文を入れる)
    (0, eval)(REACT_FRAME_HARNESS.replace('__SOURCE__', () => scriptLiteral(src)));
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5));
    return document.getElementById('root')!;
  }
  afterEach(() => {
    delete (globalThis as { PkcReact?: unknown }).PkcReact;
  });

  it('🔴 export default のコンポーネント(hooks を import して使う)が描ける', async () => {
    const root = await run(`import { useState } from 'react';
export default function Box(){ const [n]=useState(3); return <p className="p-4">count {n}</p>; }`);
    expect(root.querySelector('p')?.textContent).toBe('count 3');
    expect(root.querySelector('p')?.className).toBe('p-4');
  });

  it('🔴 App という名前のコンポーネントでも、JSX の式 1 つだけでも描ける', async () => {
    expect((await run('function App(){ return <em>名前</em>; }')).querySelector('em')?.textContent).toBe('名前');
    expect((await run('<h1>式だけ</h1>')).querySelector('h1')?.textContent).toBe('式だけ');
  });

  it('🔴 書き間違い・描画中の例外・react 以外の import は、箱の中に理由が出る(空にしない)', async () => {
    expect((await run('export default function App(){ return <div>; }')).textContent).toContain('Unterminated JSX');
    expect((await run('export default function App(){ throw new Error("boom"); }')).textContent).toContain('boom');
    expect((await run(`import x from 'lodash';\nexport default function App(){ return <i/>; }`)).textContent).toContain('react');
    expect((await run('const x = 1;')).textContent).toContain('export default');
  });
});
