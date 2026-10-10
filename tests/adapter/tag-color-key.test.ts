/**
 * @vitest-environment happy-dom
 *
 * 🔴 色を引く鍵(`data-pkc-tag-key`)(#1457 レビュー)。
 *
 * 守るもの:本文のバッジ・情報ペインのバッジが持つ鍵と、CSS の規則が当たる鍵が**同じ 1 か所**
 * (`tagColorKey`)から出ていること。CSS の `i` は ASCII だけの大小無視なので、全角 Ａ/ａ・Ä/ä の
 * 大小違いは鍵でないと当たらない。
 * 守っていないもの:実ブラウザでの計算後の色(smoke が ASCII のタグで見る)。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { setTagKey } from '../../src/adapter/ui/render/tag-color';
import { tagColorCss } from '../../src/features/tag-color';

describe('色を引く鍵', () => {
  it('🔴 規則が当たる鍵 = バッジの鍵(全角・Ä の大小違いも当たる。色の無いタグには当たらない)', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('#ÄRGER #Ａbc #plain\n');
    const side = document.createElement('button');
    side.setAttribute('data-pkc-field', 'inspector-body-tag-find');
    side.setAttribute('data-pkc-tag', 'ÄRGER');
    setTagKey(side, 'ÄRGER');
    host.append(side);
    document.body.append(host);
    // 色は小文字側の綴りで付けた
    const css = tagColorCss([
      { tag: 'ärger', color: '#ff0000' },
      { tag: 'ａBC', color: '#00ff00' },
    ]);
    const pick = (re: RegExp) => [...css.matchAll(re)].map((m) => m[0]);
    const bodySels = pick(/\.pkc-tag\[data-pkc-tag-key="[^"]*"\]/g);
    expect(bodySels).toHaveLength(2 * 3); // 規則 3 つ(下地 / hover / 枠だけ)× 2 タグ
    const hit = (selector: string) => host.querySelectorAll(selector).length;
    const aumlaut = bodySels.find((x) => x.includes('ä'))!;
    const fullwidth = bodySels.find((x) => x.includes('ａ'))!;
    expect(hit(aumlaut), 'Ä/ä の大小違いに本文のバッジが当たらない').toBe(1);
    expect(hit(fullwidth), '全角 Ａ/ａ の大小違いに当たらない').toBe(1);
    const insp = pick(/\[data-pkc-field="inspector-body-tag-find"\]\[data-pkc-tag-key="[^"]*"\]/g)[0]!;
    expect(hit(insp), '情報ペインのバッジに当たらない').toBe(1);
    // 色を付けていないタグ(plain)には、どの規則も当たらない
    expect(host.querySelector('.pkc-tag[data-pkc-tag="plain"]')?.getAttribute('data-pkc-tag-key')).toBe('plain');
    expect(css).not.toContain('data-pkc-tag-key="plain"');
  });
});
