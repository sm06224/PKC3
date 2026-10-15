/**
 * 本文(author)が書いた属性・class から、app の機能 selector を作らせない(#1087)。
 * binder は `closest('[data-pkc-action]')` で押しを拾うので、本文から `data-pkc-action` を
 * 焼けると、ノートの字を押しただけで app の操作が走る。
 */
/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

function dom(md: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(md);
  return el;
}

/** 本文が書いた物から出ては困る `data-pkc-*`(app の機能 selector になる物)。 */
const RESERVED = ['action', 'region', 'field', 'lid', 'entry', 'entry-ref', 'asset-key', 'mode'];

describe('本文由来の予約属性', () => {
  it('🔴 `:::format{action=… lid=…}` は data-pkc-action / data-pkc-lid を作らない', () => {
    const el = dom(':::format{action=delete-entry lid=x region=sidebar field=title mode=edit}\n本文\n:::\n');
    expect(el.querySelector('.pkc-format-block'), '前提:format の箱が描かれていない').not.toBeNull();
    for (const k of ['action', 'lid', 'region', 'field', 'mode']) {
      expect(el.querySelector(`[data-pkc-${k}]`), `data-pkc-${k} が焼かれた`).toBeNull();
    }
  });

  it('🔴 `:span:[x]{data-pkc-action=… data-pkc-lid=…}` は予約属性を通さない', () => {
    const el = dom(':span:[x]{data-pkc-action=delete-entry data-pkc-lid=a data-pkc-region=r data-foo=ok}\n');
    const span = el.querySelector('span[data-foo]');
    expect(span, '前提:span が描かれていない(対照の data-foo)').not.toBeNull();
    expect(span!.getAttribute('data-foo')).toBe('ok');
    for (const k of RESERVED) expect(el.querySelector(`[data-pkc-${k}]`), `data-pkc-${k}`).toBeNull();
    expect([...span!.attributes].filter((a) => /^data-pkc-/i.test(a.name))).toEqual([]);
  });

  it('マニュアルが教える :::format の key は data-pkc-<key> として残る(板・線)', () => {
    const el = dom(
      ':::format{#a .pkc-place x=40 y=50 w=200 h=120 z=2 shape=diamond fill=#ffe08a stroke=#b45309 width=3 size=large rotate=15 group=g1}\nあ\n:::\n',
    );
    const b = el.querySelector('.pkc-format-block')!;
    expect(b.classList.contains('pkc-place')).toBe(true);
    const want: Record<string, string> = {
      x: '40', y: '50', w: '200', h: '120', z: '2', shape: 'diamond', fill: '#ffe08a',
      stroke: '#b45309', width: '3', size: 'large', rotate: '15', group: 'g1',
    };
    for (const [k, v] of Object.entries(want)) expect(b.getAttribute(`data-pkc-${k}`), k).toBe(v);
    const line = dom(':::format{.pkc-line from=a:right to=b:left arrow=end route=elbow bend=v:320}\n:::\n')
      .querySelector('.pkc-format-block')!;
    expect(line.classList.contains('pkc-line')).toBe(true);
    for (const [k, v] of Object.entries({ from: 'a:right', to: 'b:left', arrow: 'end', route: 'elbow', bend: 'v:320' })) {
      expect(line.getAttribute(`data-pkc-${k}`), k).toBe(v);
    }
    const ent = dom(':::format{.pkc-place entry=ノートのID x=1 y=2}\n:::\n').querySelector('.pkc-format-block')!;
    expect(ent.getAttribute('data-pkc-entry')).toBe('ノートのID');
  });

  it('indent / align は従来どおり効く', () => {
    const b = dom(':::format{indent=2 align=center}\nあ\n:::\n').querySelector('.pkc-format-block')!;
    expect(b.getAttribute('data-pkc-indent')).toBe('2');
    expect(b.getAttribute('data-pkc-align')).toBe('center');
  });
});

describe('本文由来の予約 class(pkc- 接頭辞)', () => {
  it('🔴 `:::format{.pkc-lightbox-overlay}` は app の class を付けない(.pkc-place / .pkc-line は残す)', () => {
    const el = dom(':::format{.pkc-lightbox-overlay .mine .pkc-place}\nあ\n:::\n');
    const b = el.querySelector('.pkc-format-block')!;
    expect(b.classList.contains('pkc-lightbox-overlay')).toBe(false);
    expect(b.classList.contains('mine')).toBe(true);
    expect(b.classList.contains('pkc-place'), '対照:許可した class は残る').toBe(true);
    const l = dom(':::format{.pkc-line}\n:::\n').querySelector('.pkc-format-block')!;
    expect(l.classList.contains('pkc-line')).toBe(true);
  });

  it('🔴 span / 他の囲みの class でも pkc- は落ちる', () => {
    const s = dom(':span:[x]{.pkc-lightbox-overlay .ok}\n').querySelector('span.ok')!;
    expect(s.className).toBe('ok');
    const kv = dom(':span:[x]{class="pkc-lightbox-overlay keep"}\n').querySelector('span.keep')!;
    expect(kv.className).toBe('keep');
    const q = dom(':::quote{author=A .pkc-lightbox-overlay .qq}\nあ\n:::\n');
    expect(q.querySelector('.qq'), '前提:quote が描かれていない').not.toBeNull();
    expect(q.querySelector('.pkc-lightbox-overlay')).toBeNull();
    const sec = dom(':::section{.pkc-lightbox-overlay .ss}\nあ\n:::\n');
    expect(sec.querySelector('.ss'), '前提:section が描かれていない').not.toBeNull();
    expect(sec.querySelector('.pkc-lightbox-overlay')).toBeNull();
  });
});

describe('data: リンク', () => {
  it('🔴 [a](data:image/…) は押しても何も起きない <a> を作らない(字だけ残る)/ 画像の src は通る', () => {
    const el = dom('[ラベル](data:image/png;base64,AAAA) と ![alt](data:image/png;base64,AAAA)\n');
    expect(el.querySelector('a[href^="data:"]')).toBeNull();
    expect(el.textContent).toContain('ラベル');
    const img = el.querySelector('img');
    expect(img, '対照:画像の data: は通る').not.toBeNull();
    expect(img!.getAttribute('src')).toMatch(/^data:image\/png/);
  });

  it('普通のリンクは残る / 画像を包む data: リンクでも画像は残る', () => {
    const el = dom('[外](https://example.com/) [![i](data:image/png;base64,AAAA)](data:image/png;base64,BBBB)\n');
    expect(el.querySelector('a[href="https://example.com/"]')).not.toBeNull();
    expect(el.querySelector('a[href^="data:"]')).toBeNull();
    expect(el.querySelector('img')).not.toBeNull();
  });
});
