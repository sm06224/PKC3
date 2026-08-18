/** @vitest-environment node */
/**
 * 🔴 **小さな CSS カスケード**(#238)。mermaid は色を `<style>` の**子孫セレクタ**で
 * 与えるので、ここが解けないと図が黒くなる(LibreOffice の SVG 取り込みが実際にそうだった)。
 */
import { describe, expect, it } from 'vitest';
import { parseXml } from '../../src/features/export/xml-lite';
import { computeStyle, parseCss, parseColor, parseLength } from '../../src/features/export/svg-style';

/** 鎖(根 → 目的の要素)を作る小道具。 */
function chainOf(xml: string, path: number[]): ReturnType<typeof parseXml>[] {
  const root = parseXml(xml);
  const chain = [root];
  let node = root;
  for (const i of path) {
    node = node.children.filter((c) => c.tag !== '#text')[i]!;
    chain.push(node);
  }
  return chain;
}

describe('parseCss', () => {
  it('🔴 at 規則(`@keyframes`)は中身ごと飛ばす ── 中の `from{…}` を規則と読まない', () => {
    const rules = parseCss('@keyframes dash{from{stroke-dashoffset:0;}to{x:1;}} .a{fill:#111;}');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.decls['fill']).toBe('#111');
  });

  it('選択子リストは 1 本ずつ規則になる', () => {
    expect(parseCss('.a rect, .b circle{fill:#222;}')).toHaveLength(2);
  });

  it('`!important` を覚える', () => {
    const [r] = parseCss('.a{fill:#333 !important;}');
    expect(r!.important.has('fill')).toBe(true);
    expect(r!.decls['fill']).toBe('#333');
  });
});

describe('computeStyle', () => {
  const XML = `<svg id="d"><style>
    #d .node rect{fill:#f00;}
    #d rect{fill:#0f0;}
    .node > rect{stroke:#00f;}
    #d .node text{fill:#123456;}
  </style><g class="node"><rect/><text/></g></svg>`;

  it('🔴 子孫セレクタが当たる(ここが要)', () => {
    expect(computeStyle(chainOf(XML, [1, 0]), parseCss(XML.split('<style>')[1]!.split('</style>')[0]!))['fill']).toBe(
      '#f00',
    );
  });

  it('🔴 詳細度で勝つ(`#d .node rect` > `#d rect`)', () => {
    const rules = parseCss(XML.split('<style>')[1]!.split('</style>')[0]!);
    expect(computeStyle(chainOf(XML, [1, 0]), rules)['fill']).toBe('#f00');
  });

  it('子結合子(`>`)も解ける', () => {
    const rules = parseCss(XML.split('<style>')[1]!.split('</style>')[0]!);
    expect(computeStyle(chainOf(XML, [1, 0]), rules)['stroke']).toBe('#00f');
  });

  it('🔴 表現属性は CSS 規則より**弱い**(SVG の規則)', () => {
    const xml = `<svg id="d"><style>#d rect{fill:#0f0;}</style><rect fill="#f00"/></svg>`;
    const rules = parseCss('#d rect{fill:#0f0;}');
    expect(computeStyle(chainOf(xml, [1]), rules)['fill']).toBe('#0f0');
  });

  it('🔴 `style=` は CSS 規則より**強い**', () => {
    const xml = `<svg id="d"><rect style="fill:#abc"/></svg>`;
    expect(computeStyle(chainOf(xml, [0]), parseCss('#d rect{fill:#0f0;}'))['fill']).toBe('#abc');
  });

  it('🔴 継承する(親の `fill` が子の text に届く)', () => {
    const xml = `<svg id="d"><g fill="#654321"><text/></g></svg>`;
    expect(computeStyle(chainOf(xml, [0, 0]), [])['fill']).toBe('#654321');
  });
});

describe('parseColor', () => {
  it('16 進(3 桁 / 6 桁)と rgb() を読む', () => {
    expect(parseColor('#abc')).toBe(0xaabbcc);
    expect(parseColor('#123456')).toBe(0x123456);
    expect(parseColor('rgb(255, 0, 128)')).toBe(0xff0080);
  });

  it('🔴 読めない指定は `null`(= 指定なし)── ここで 0 を返すと**黒く塗る**', () => {
    // mermaid の neo テーマは `stroke:url(#…-gradient)` を使う
    expect(parseColor('url(#g)')).toBeNull();
    expect(parseColor('currentColor')).toBeNull();
    expect(parseColor('revert')).toBeNull();
    expect(parseColor('none')).toBeNull();
    expect(parseColor(undefined)).toBeNull();
    // ⚠ **知らない綴りも `null`** ── ここが最後の門で、0 を返すと**黒く塗る**
    expect(parseColor('rebeccapurple')).toBeNull();
    expect(parseColor('color-mix(in srgb, red, blue)')).toBeNull();
  });
});

describe('parseLength', () => {
  it('px / em / pt / % を px にする', () => {
    expect(parseLength('12px', 16)).toBe(12);
    expect(parseLength('1.1em', 10)).toBeCloseTo(11);
    expect(parseLength('12pt', 16)).toBeCloseTo(16);
    expect(parseLength('50%', 20)).toBe(10);
  });
  it('読めない値は既定へ', () => {
    expect(parseLength('auto', 16, 7)).toBe(7);
    expect(parseLength(undefined, 16, 3)).toBe(3);
  });
});
