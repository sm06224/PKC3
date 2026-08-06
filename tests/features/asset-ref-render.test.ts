/** @vitest-environment happy-dom */
/**
 * 本文 markdown の `asset:` 参照(P4b)の render 規則 pin。
 *
 * 契約: features 層は key を data 属性で運ぶだけ ── 生きた
 * `<a href="asset:…">` / `<img src="asset:…">` を DOM に出さない
 * (bytes は adapter の hydrator が lend/dispose で差す)。
 */
import { describe, expect, it } from 'vitest';
import {
  renderMarkdown,
  type RenderMarkdownOptions,
} from '../../src/features/markdown/markdown-render';

function renderToDom(md: string, opts?: RenderMarkdownOptions): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(md, opts);
  return host;
}

describe('asset: refs in markdown (P4b)', () => {
  it('![alt](asset:key) → src 無し placeholder img(key は data 属性)', () => {
    const host = renderToDom('前文 ![全体フロー](asset:ast-abc123) 後文');
    const img = host.querySelector('img.pkc-asset-ref')!;
    expect(img).not.toBeNull();
    expect(img.getAttribute('data-pkc-asset-key')).toBe('ast-abc123');
    expect(img.getAttribute('alt')).toBe('全体フロー');
    expect(img.hasAttribute('src')).toBe(false); // asset: を src に漏らさない
    // 前後のテキストは通常どおり流れる
    expect(host.textContent).toContain('前文');
    expect(host.textContent).toContain('後文');
  });

  it('[label](asset:key) → href 無し・download-asset action の <a>', () => {
    const host = renderToDom('[レポート.pdf](asset:ast-r1)');
    const a = host.querySelector('a.pkc-asset-link')!;
    expect(a).not.toBeNull();
    expect(a.hasAttribute('href')).toBe(false); // ブラウザにナビゲートさせない
    expect(a.getAttribute('data-pkc-action')).toBe('download-asset');
    expect(a.getAttribute('data-pkc-asset-key')).toBe('ast-r1');
    expect(a.getAttribute('data-pkc-asset-name')).toBe('レポート.pdf'); // DL 名 = ラベル
    expect(a.hasAttribute('target')).toBe(false); // 外部リンク扱いにしない
    expect(a.textContent).toBe('レポート.pdf');
  });

  it('ラベル空の asset link は key を DL 名 fallback にする', () => {
    const host = renderToDom('[](asset:ast-noname)');
    const a = host.querySelector('a.pkc-asset-link')!;
    expect(a.getAttribute('data-pkc-asset-name')).toBe('ast-noname');
  });

  it('code span / fence 内の asset: は literal のまま(rule 不適用)', () => {
    const host = renderToDom('`![x](asset:k1)`\n\n```\n[y](asset:k2)\n```');
    expect(host.querySelector('img.pkc-asset-ref')).toBeNull();
    expect(host.querySelector('a.pkc-asset-link')).toBeNull();
    expect(host.textContent).toContain('![x](asset:k1)');
    expect(host.textContent).toContain('[y](asset:k2)');
  });

  it('alt / title の " は escape され、live な on* 属性が実体化しない', () => {
    // image rule は手書き HTML 文字列 ── escapeHtmlAttr が落ちても型も lint も
    // 気付かないため、ここで pin する(review mutation D: escape 除去の素通し対策)。
    // key 側は markdown-it の normalizeLink が " を %22 化する二重防御だが、
    // alt / title は URL 正規化を**通らない**ので escape が唯一の防壁
    const host = renderToDom(`![a"onerror="x](asset:k1 't"onmouseover="y')`);
    const img = host.querySelector('img.pkc-asset-ref')!;
    expect(img.getAttribute('alt')).toBe('a"onerror="x'); // 文字列として保持
    expect(img.getAttribute('title')).toBe('t"onmouseover="y');
    for (const el of host.querySelectorAll('*'))
      for (const n of el.getAttributeNames()) expect(n.startsWith('on')).toBe(false);
  });

  it('通常の外部 link は従来どおり(退行なし)', () => {
    const host = renderToDom('[e](https://example.com)');
    const a = host.querySelector('a:not(.pkc-asset-link)')!;
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  /**
   * 🔴 **外部の画像は既定で読み込まない**(2026-08-06、user 裁定)。
   *
   * ⚠ かつてここは「`src` がそのまま載る」を「退行なし」として pin していた ──
   * つまり**漏れることを test が守っていた**。裁定でその向きが変わったので、
   * 両側(既定 = 塞ぐ / 許可 = 載る)を pin し直す。
   */
  it('外部の画像は既定で src を持たない(URL は属性に退避する)', () => {
    const host = renderToDom('![i](https://example.com/i.png)');
    const img = host.querySelector('img:not(.pkc-asset-ref)')!;
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.getAttribute('data-pkc-external-src')).toBe('https://example.com/i.png');
    expect(img.classList.contains('pkc-external-img')).toBe(true);
    // ⚠ 器は残る(消すと「書いたのに何も無い」になる)
    expect(img.getAttribute('alt')).toBe('i');
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('許可すると src が載る(同じ入力で向きだけ変わる)', () => {
    const host = renderToDom('![i](https://example.com/i.png)', { allowExternalImages: true });
    const img = host.querySelector('img:not(.pkc-asset-ref)')!;
    expect(img.getAttribute('src')).toBe('https://example.com/i.png');
    expect(img.hasAttribute('data-pkc-external-src')).toBe(false);
  });
});
