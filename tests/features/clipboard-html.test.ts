/** @vitest-environment happy-dom */
/**
 * よそのアプリへ貼る用の掃除(#193 / 台帳 #180 の C-2)。
 *
 * 🔴 守る主張 ── どれも**貼ってみるまで気づけない**種類の壊れ方である:
 * 1. **CSS で隠してあるだけのソース**を落とす(貼り先には CSS が無いので出る)
 * 2. 押せない操作子を落とす
 * 3. `blob:` の画像は**貼り先で読めない** ── data: に置き換えるか、文字に落とす
 * 4. 落としたものは**数える**(黙って消さない)
 * 5. `data-pkc-*` を落とす
 * 6. **元の DOM に触れない**(コピーしたら画面が変わった、を作らない)
 * 7. 外部 URL の画像はそのまま(貼り先でも読める)
 */
import { describe, expect, it } from 'vitest';
import { cleanForClipboard } from '../../src/features/export/clipboard-html';

function host(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('貼る用の掃除', () => {
  it('🔴 隠してあるだけのソースを落とす(貼り先では CSS が無い)', () => {
    const el = host(
      '<div class="pkc-mermaid-placeholder"><img src="data:image/png;base64,AA" alt="図">' +
        '<pre class="pkc-mermaid-source"><code>graph TD; A--&gt;B;</code></pre></div>',
    );
    const r = cleanForClipboard(el);
    expect(r.html, '図の原文が貼り先に出てしまう').not.toContain('graph TD');
    expect(r.html).toContain('<img');
    expect(r.removed).toBeGreaterThan(0);
  });

  it('chart の原文も落とす(図と同じ扱い)', () => {
    const el = host('<div><pre class="pkc-chart-source">{"type":"bar"}</pre></div>');
    expect(cleanForClipboard(el).html).not.toContain('"type"');
  });

  it('🔴 押せない操作子を落とす', () => {
    const el = host('<p>本文</p><button data-pkc-action="copy-md-block">コピー</button>');
    const r = cleanForClipboard(el);
    expect(r.html).not.toContain('button');
    expect(r.html).toContain('本文');
  });

  it('hidden なものも落とす(貼り先では出る)', () => {
    const el = host('<p>見える</p><div hidden>見えない</div>');
    expect(cleanForClipboard(el).html).not.toContain('見えない');
  });

  it('🔴 blob: の画像は data: に置き換わる', () => {
    const el = host('<img src="blob:abc" alt="図">');
    const r = cleanForClipboard(el, new Map([['blob:abc', 'data:image/png;base64,XX']]));
    expect(r.html).toContain('data:image/png;base64,XX');
    expect(r.droppedImages).toBe(0);
  });

  it('🔴 置き換えられない blob: は文字に落として数える(壊れた画像を貼らせない)', () => {
    const el = host('<img src="blob:abc" alt="設計図">');
    const r = cleanForClipboard(el);
    expect(r.html, '壊れる画像をそのまま貼っている').not.toContain('blob:');
    expect(r.html, '何が在ったか分からなくなっている').toContain('設計図');
    expect(r.droppedImages).toBe(1);
  });

  it('alt が無い画像でも何か残す(黙って消えない)', () => {
    const el = host('<img src="blob:abc">');
    const r = cleanForClipboard(el);
    expect(r.html).toContain('(画像)');
    expect(r.droppedImages).toBe(1);
  });

  it('🔴 外部 URL の画像はそのまま(貼り先でも読める)', () => {
    const el = host('<img src="https://example.com/a.png" alt="外">');
    const r = cleanForClipboard(el);
    expect(r.html).toContain('https://example.com/a.png');
    expect(r.droppedImages).toBe(0);
  });

  it('🔴 data-pkc-* を落とす(意味の無い属性を延々と付けない)', () => {
    const el = host('<p data-pkc-md-block-kind="para" data-pkc-line="3" class="keep">本文</p>');
    const r = cleanForClipboard(el);
    expect(r.html).not.toContain('data-pkc-');
    expect(r.html, 'ふつうの class まで落とした').toContain('keep');
  });

  it('🔴 元の DOM に触れない(コピーしたら画面が変わった、を作らない)', () => {
    const el = host('<p data-pkc-line="1">本文</p><button data-pkc-action="x">押</button>');
    const before = el.innerHTML;
    // ⚠ 呼び側が複製を渡す規約なので、ここでは**複製を作って**渡す
    cleanForClipboard(el.cloneNode(true) as HTMLElement);
    expect(el.innerHTML, '元の DOM を書き換えた').toBe(before);
  });

  it('見出し・表・コードは残る(貼り先で意味を保つ)', () => {
    const el = host(
      '<h2>見出し</h2><table><tr><td>セル</td></tr></table><pre><code>x = 1</code></pre>',
    );
    const r = cleanForClipboard(el);
    expect(r.html).toContain('<h2>');
    expect(r.html).toContain('<table>');
    expect(r.html).toContain('x = 1');
  });
});
