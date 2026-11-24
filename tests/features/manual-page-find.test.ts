/** @vitest-environment happy-dom */
/**
 * 🔴 **別ウィンドウのマニュアルの「マニュアルの中を探す」**(Stage 2 PR-3 の 8-2)。
 *
 * 焼いた page の `<body>` を happy-dom に差し込み、探す欄の script を**本物のまま**走らせて見る
 * (script の字面ではなく、打つ → 目次が絞られる / 一覧が出る / 押すと送って光らせる、の結果)。
 * ⚠ happy-dom は版面を持たない(`getBoundingClientRect` は 0)ので、**送る先の位置**は実ブラウザの
 *   `tests/smoke/manual-window.smoke.spec.ts` が測る。ここは「正しい節へ向かう」「0 件で黙らない」「絞り込み」を見る。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MANUAL_FIND_HTML, MANUAL_FIND_SCRIPT } from '../../src/features/help/manual-page-find';

const BODY = `
<details data-pkc-region="manual-window-toc" open>
  <summary>目次</summary>${MANUAL_FIND_HTML}
  <nav><a href="#a" data-pkc-level="1">はじめに</a><a href="#b" data-pkc-level="2">保存のしかた</a><a href="#c" data-pkc-level="2">ブラウザの AI との連携(WebMCP)</a></nav>
</details>
<div data-pkc-region="manual-window-main">
  <h1 id="a">はじめに</h1><p>最初の段落です。</p>
  <h2 id="b">保存のしかた</h2><p>保存は自動です。<strong>Web</strong>MCP のことはここには書きません。</p>
  <h2 id="c">ブラウザの AI との連携(WebMCP)</h2><p>WebMCP は、ブラウザの AI から操作する仕組みです。webmcp とも書きます。</p>
</div>`;

const $ = <T extends Element = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;
const type = async (v: string): Promise<void> => {
  const inp = $<HTMLInputElement>('[data-pkc-field="manual-window-find"]');
  inp.value = v;
  inp.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 120)); // 入力の間引き(60ms)を越える
};

function mount(): void {
  document.body.innerHTML = BODY;
  new Function(MANUAL_FIND_SCRIPT)();
}
afterEach(() => {
  document.body.innerHTML = '';
});

describe('別ウィンドウのマニュアルの検索', () => {
  it('🔴 打つと、目次が絞られ、本文の全文のヒット一覧が出る(節ごとの件数つき)', async () => {
    mount();
    expect([...document.querySelectorAll('nav a')].every((a) => !a.hasAttribute('hidden')), '前提: 初めは絞っていない').toBe(true);
    await type('WebMCP');
    const rows = [...document.querySelectorAll<HTMLElement>('nav a')];
    expect(rows.filter((a) => !a.hidden).map((a) => a.textContent), '目次が絞られていない').toEqual(['ブラウザの AI との連携(WebMCP)']);
    const hits = [...document.querySelectorAll<HTMLElement>('[data-pkc-region="manual-window-find-hits"] button')];
    // 全文: 「保存のしかた」の節(太字をまたぐ Web|MCP)と、連携の節(大文字小文字違いも)
    expect(hits.length, 'ヒット一覧が出ていない').toBe(2);
    expect(hits[0]!.textContent).toContain('保存のしかた(1)');
    expect(hits[1]!.textContent).toContain('ブラウザの AI との連携(WebMCP)(');
    expect(hits[1]!.textContent, '大文字小文字違いも数える(見出し 1 + 本文 2 = 3)').toContain('(3)');
    expect($('[data-pkc-field="manual-window-find-count"]').textContent).toContain('4 か所(2 節)');
  });

  it('🔴 0 件は黙らない・消すと全部戻る', async () => {
    mount();
    await type('存在しない語');
    expect($('[data-pkc-field="manual-window-find-count"]').textContent).toContain('見つかりませんでした');
    expect(document.querySelectorAll('[data-pkc-region="manual-window-find-hits"] button').length).toBe(0);
    await type('');
    expect([...document.querySelectorAll<HTMLElement>('nav a')].every((a) => !a.hidden), '空に戻したのに目次が絞られたまま').toBe(true);
  });

  it('🔴 ヒットを押すと、その節の見出しへ送って光らせる(別の節は光らない)', async () => {
    mount();
    await type('WebMCP');
    const calls: string[] = [];
    const main = $('[data-pkc-region="manual-window-main"]');
    // 版面が無いので、送りは scrollTop の書き込みで観測する(0 でない差を作るため見出しの rect を差す)
    for (const h of main.querySelectorAll<HTMLElement>('h1,h2')) {
      h.getBoundingClientRect = () => ({ top: h.id === 'c' ? 900 : 100 }) as DOMRect;
    }
    let top = 0;
    Object.defineProperty(main, 'scrollTop', { get: () => top, set: (v: number) => { top = v; calls.push(String(v)); }, configurable: true });
    const hits = [...document.querySelectorAll<HTMLElement>('[data-pkc-region="manual-window-find-hits"] button')];
    hits[1]!.click();
    expect(top, '連携の節へ送っていない(scrollTop が動かない)').toBeGreaterThan(0);
    expect($('#c').hasAttribute('data-pkc-jump-flash'), '着いた見出しを光らせていない').toBe(true);
    expect($('#b').hasAttribute('data-pkc-jump-flash'), '別の節を光らせた').toBe(false);
  });

  it('🔴 Esc で消える / 検索欄は目次の上(nav より前)に在る', async () => {
    mount();
    await type('保存');
    const inp = $<HTMLInputElement>('[data-pkc-field="manual-window-find"]');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(inp.value).toBe('');
    expect(
      inp.compareDocumentPosition($('nav')) & Node.DOCUMENT_POSITION_FOLLOWING,
      '検索欄が目次より後ろにある',
    ).toBeTruthy();
  });
});
