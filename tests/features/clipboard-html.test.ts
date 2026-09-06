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
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

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

  /**
   * 🔴 **押せる升を持つ表を、丸ごと消していた**(2026-09-05、#735 の実装中に実測)。
   *
   * ⚠ `data-pkc-action` は**押せる器だけに付いているのではない** ── csv の表は
   *   **升そのもの**(`td` / `th`)に `edit-cell` を付ける。要素ごと消していたので、
   *   実測で **升 4 個 → 0 個**、つまり「ノートを HTML でコピー」すると
   *   **升の無い表**が貼られていた(pasted 側でしか見えない = 誰も気づかない形)。
   * 🔑 台は**本物の描画**から作る(読む面と同じ `interactiveCells: true`)──
   *   手で組んだ表では、この主張を 1 度も検めていないことになる。
   */
  it('🔴 押せる升を持つ表でも、升の中身が残る(#735)', () => {
    const el = host(renderMarkdown('```csv\n名前,数\nあ,1\n```', { interactiveCells: true }));
    // 空振り防止 ── 升に押せる印が本当に付いている(付いていなければ何も守っていない)
    expect(
      el.querySelectorAll('[data-pkc-action="edit-cell"]').length,
      '升に押せる印が付いていない(台が古い)',
    ).toBeGreaterThan(0);
    const before = el.querySelectorAll('td,th').length;
    const r = cleanForClipboard(el);
    expect(el.querySelectorAll('td,th').length, `升が消えた(${before} → 0)`).toBe(before);
    expect(r.html, '升の字が消えた').toContain('名前');
    expect(r.html, '升の字が消えた').toContain('あ');
    // ⚠ 押す器(行・列を足す ⌗)は落ちている
    expect(r.html, '押せないボタンが貼られる').not.toContain('<button');
    // ⚠ 内部の印は残さない(④ が落とす)
    expect(r.html, '内部の印が貼られる').not.toContain('data-pkc-');
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

/**
 * 🔴 **数式は打った字に戻して貼る**(#707)。
 *
 * ⚠ KaTeX の出力は **MathML(CSS で隠す)と見た目の span** の 2 本立てで、
 *   貼り先はこちらの CSS を持たない ── 素通しすると
 *   **同じ式が 2 回、崩れて**貼られる。
 * ⚠ 既に在る「隠してあるものを落とす」では届かない ── KaTeX が隠すのは
 *   `.katex-mathml` の中で、`[hidden]` でも `COPY_JUNK_CLASSES` でもない。
 */
describe('数式(#707)', () => {
  const katexish =
    '<span class="pkc-math" data-pkc-math-src="E = mc^2" data-pkc-math-display="0"' +
    ' data-pkc-math-state="done"><span class="katex">' +
    '<span class="katex-mathml"><math><mi>E</mi></math></span>' +
    '<span class="katex-html"><span class="mord">E</span></span></span></span>';

  it('🔴 貼ると「$E = mc^2$」の 1 つになる(2 回貼られない)', () => {
    const el = host(`<p>式は ${katexish} です。</p>`);
    cleanForClipboard(el);
    const text = el.textContent ?? '';
    expect(text, '打った字に戻っていない').toContain('$E = mc^2$');
    expect(el.innerHTML, 'KaTeX の中身が残っている(2 回貼られる)').not.toContain('katex-mathml');
    expect(el.innerHTML, 'KaTeX の見た目の span が残っている').not.toContain('mord');
  });

  it('🔴 塊の数式は $$…$$ に戻る', () => {
    const el = host(
      '<div class="pkc-math pkc-math-display" data-pkc-math-src="x^2" ' +
        'data-pkc-math-display="1"><span class="katex"><span class="mord">x</span></span></div>',
    );
    cleanForClipboard(el);
    expect(el.textContent, '塊の区切りが戻っていない').toContain('$$x^2$$');
  });

  /** ⚠ 空振り防止 ── 台が 2 本立てを持っていること(無ければ上は何も見ていない)。 */
  it('⚠ 台が KaTeX の 2 本立てを持っている(前提)', () => {
    expect(katexish, '前提が崩れている: MathML が無い').toContain('katex-mathml');
    expect(katexish, '前提が崩れている: 見た目の span が無い').toContain('mord');
  });
});
