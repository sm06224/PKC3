/** @vitest-environment happy-dom */
/**
 * React の囲み(#528 ②)をコピーするとき、動く枠(iframe。srcdoc にランタイムが丸ごと入る)を貼らない。
 */
import { describe, expect, it } from 'vitest';
import { cleanForClipboard } from '../../src/features/export/clipboard-html';

function host(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('React の囲みのコピー', () => {
  const SRC = 'export default function App(){ return <b className="p-2">hi</b>; }';
  /** 描いた後の姿:器の中に動く枠と、隠してある原文。 */
  const rendered = (): HTMLElement =>
    host(
      `<div class="pkc-react-placeholder" data-pkc-react-src="${SRC.replace(/"/g, '&quot;')}" data-pkc-react-state="ready">` +
        '<pre class="pkc-react-source"><code>x</code></pre>' +
        `<iframe class="pkc-html-render pkc-react-frame" sandbox="allow-scripts" srcdoc="${'A'.repeat(1000)}"></iframe></div>`,
    );

  it('🔴 動く枠(約 700KB の srcdoc)を貼らず、原文のコードにする', () => {
    const r = cleanForClipboard(rendered());
    expect(r.html, '枠が混入している').not.toContain('<iframe');
    expect(r.html).not.toContain('srcdoc');
    expect(r.html).not.toContain('AAAA');
    // 原文が読める(黙って消さない)
    expect(r.html).toContain('<pre><code>');
    expect(r.html).toContain('export default function App()');
    expect(r.html).toContain('&lt;b className=');
    // 画面の都合の属性・器の class は残らない
    expect(r.html).not.toContain('data-pkc-react');
    expect(r.html).not.toContain('pkc-react-source');
  });

  it('対照群: React を含まない本文は 1 バイトも変わらない', () => {
    const r = cleanForClipboard(host('<p>ふつうの文</p>'));
    expect(r.html).toBe('<p>ふつうの文</p>');
  });
});
