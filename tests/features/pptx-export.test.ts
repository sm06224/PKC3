/**
 * 🔴 **PowerPoint(.pptx)へ書き出す**(#187 段①)。
 *
 * 設計は `docs/development/pptx-export-design-2026-08.md`。守る主張:
 *
 * 1. **切れ方は PKC2 と同じ** ── user が PKC2 で書いた資料が同じ切れ方で出る
 * 2. 🔴 **宣言されて・実在して・指されて**(docx の #232 と同じ型)──
 *    目録に載っている部品が実在し、rels の指し先も実在すること
 * 3. **黙って落とさない** ── 表・画像・写せなかったものは**本文に理由が出る**
 * 4. **PowerPoint に縮めさせる**(`<a:normAutofit/>`)── 切り捨てない
 */
import { describe, expect, it } from 'vitest';
import { buildPptx, splitIntoSlides, type ExportBlock, type ExportCell } from '@features/export/pptx';

const h = (level: 1 | 2 | 3 | 4 | 5 | 6, text: string): ExportBlock =>
  ({ kind: 'h', level, runs: [{ text }] });
const p = (text: string): ExportBlock => ({ kind: 'p', runs: [{ text }] });
const li = (text: string, depth = 0): ExportBlock =>
  ({ kind: 'li', ordered: false, depth, runs: [{ text }] });

/** 部品を名前で引く。 */
const partOf = (r: ReturnType<typeof buildPptx>, name: string): string => {
  const found = r.parts.find((x) => x.name === name);
  expect(found, `部品が無い: ${name}`).toBeTruthy();
  return found!.text;
};

describe('切れ方(PKC2 と同じ)', () => {
  it('🔴 H1 は扉 / H2 は副題 / H3 は本文 ── 表のとおりに切れる', () => {
    const slides = splitIntoSlides(
      [h(1, '第一章'), h(2, '副題'), p('本文'), h(3, '節'), p('つづき')],
      'ノート',
    );
    expect(slides.map((s) => [s.kind, s.title, s.subtitle ?? null])).toEqual([
      ['section', '第一章', '副題'],
      ['content', '節', null],
    ]);
    // ⚠ 扉に落ちた段落は扉の本文になる(捨てない)
    expect(slides[0]!.lines).toHaveLength(1);
    expect(slides[1]!.lines).toHaveLength(1);
  });

  it('🔴 扉に落ちた本文と箱が、生成物にも出る(下書きだけ見ない)', () => {
    /**
     * 🔴 **2026-08-24 に見つけた取りこぼし。**
     * 上の検査は「捨てない」と書きながら**下書き**(`slides[0].lines`)しか
     * 見ていなかった ── 描く側(`slideXml`)の扉の枝は題名と副題しか出しておらず、
     * `# 章` の直後に書いた本文・表・画像は**生成物から黙って消えていた**。
     * ⚠ 観測点が 1 段手前だと、こういう欠落は永久に見えない(CLAUDE.md §4)。
     */
    const r = buildPptx([
      h(1, '章'),
      p('扉の本文'),
      { kind: 'table', rows: [[{ runs: [{ text: 'セル' }] }]] },
      { kind: 'image', media: 'media/a.png', widthPx: 100, heightPx: 50, alt: '絵' },
    ], { title: 'T' });
    const slide = partOf(r, 'ppt/slides/slide1.xml');
    expect(slide, '扉の本文が消えている').toContain('<a:t>扉の本文</a:t>');
    expect(slide, '扉の表が消えている').toContain('<a:t>セル</a:t>');
    expect(slide, '扉の画像が消えている').toContain('<p:pic>');
    expect(r.counts.images, '扉の画像が数えられていない').toBe(1);
    // ⚠ id が重複すると PowerPoint が file ごと拒む(題名 2 / 副題は無い / 本文 4 / 箱 5,6)
    const ids = [...slide.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size, `id が重複している: ${ids.join(',')}`).toBe(ids.length);
  });

  it('🔴 扉に何も落ちていなければ、空の本文の箱を作らない(対照群)', () => {
    const r = buildPptx([h(1, '章'), h(2, '副題')], { title: 'T' });
    expect(partOf(r, 'ppt/slides/slide1.xml'), '空の本文の箱ができている')
      .not.toContain('name="本文"');
  });

  it('🔴 扉の副題は 1 つだけ ── 2 つ目の H2 は新しいスライドになる', () => {
    const slides = splitIntoSlides([h(1, '章'), h(2, '副題'), h(2, '二つ目')], 'ノート');
    expect(slides.map((s) => [s.kind, s.title])).toEqual([
      ['section', '章'],
      ['content', '二つ目'],
    ]);
  });

  it('🔴 扉が無いところの H2 は、本文スライドになる', () => {
    const slides = splitIntoSlides([h(2, 'いきなり H2')], 'ノート');
    expect(slides.map((s) => [s.kind, s.title])).toEqual([['content', 'いきなり H2']]);
  });

  it('🔴 `+++` も `---` も切る(PKC2 は page と rule の両方で切っている)', () => {
    for (const brk of [{ kind: 'pagebreak' } as ExportBlock, { kind: 'hr' } as ExportBlock]) {
      const slides = splitIntoSlides([p('前'), brk, p('後')], 'ノート');
      expect(slides).toHaveLength(2);
      // ⚠ 切った先は**題名が空**である(PKC2 と同じ)
      expect(slides[1]!.title).toBe('');
      expect(slides[1]!.lines).toHaveLength(1);
    }
  });

  it('🔴 見出しが 1 つも無いときは、ノートの題名で 1 枚だけ作る', () => {
    expect(splitIntoSlides([p('本文だけ')], 'ノートの題名').map((s) => s.title))
      .toEqual(['ノートの題名']);
    // ⚠ 空の本文でも 1 枚は作る(0 枚の pptx は開けない)
    expect(splitIntoSlides([], 'ノートの題名')).toHaveLength(1);
  });

  it('H4〜H6 は本文に落ちる(スライドを切らない)', () => {
    const slides = splitIntoSlides([h(3, '節'), h(4, '小見出し'), h(6, 'さらに小')], 'ノート');
    expect(slides).toHaveLength(1);
    expect(slides[0]!.lines).toHaveLength(2);
  });

  it('箇条書きの深さは上限で丸める(行ごと落とさない)', () => {
    const slides = splitIntoSlides([li('深い', 99)], 'ノート');
    expect(slides[0]!.lines[0]!.bullet).toBe(7);
  });
});

describe('黙って落とさない', () => {
  it('🔴 表と画像は「自分の箱」へ回る(本文の行に潰さない)', () => {
    // ⚠ 段③ で変わった ── それまでは素の行に潰していた(中身は捨てていない)
    const slides = splitIntoSlides([
      { kind: 'table', rows: [[{ runs: [{ text: 'A' }] }, { runs: [{ text: 'B' }] }]] },
      { kind: 'image', media: 'media/image1.png', widthPx: 10, heightPx: 10, alt: '図表' },
    ], 'ノート');
    expect(slides[0]!.boxes.map((b) => b.kind)).toEqual(['table', 'image']);
    expect(slides[0]!.lines, '箱に回したものが本文にも残っている').toHaveLength(0);
  });

  it('🔴 大きさの分からない画像は、潰さずに理由を出す', () => {
    // ⚠ **PKC2 は全画像を 480×360 に潰していた** ── 縦横比が計算できないものは
    //    箱にしない。⚠ ただし**黙って消さない**(理由を本文に出す)
    const slides = splitIntoSlides(
      [{ kind: 'image', media: 'media/x.png', widthPx: 0, heightPx: 0, alt: '寸法不明' }],
      'ノート',
    );
    expect(slides[0]!.boxes).toHaveLength(0);
    expect(slides[0]!.lines.map((l) => l.runs.map((r) => r.text).join('')).join(''))
      .toContain('寸法不明');
  });

  it('🔴 写せなかったものは、本文に理由が出る', () => {
    const slides = splitIntoSlides(
      [{ kind: 'skipped', what: '埋め込みの箱', why: 'PowerPoint では動きません' }],
      'ノート',
    );
    expect(slides[0]!.lines.map((l) => l.runs.map((r) => r.text).join('')).join(''))
      .toContain('埋め込みの箱');
  });

  it('コードは 1 行ずつ入る(改行が消えない)', () => {
    const slides = splitIntoSlides([{ kind: 'code', text: 'a\nb\nc' }], 'ノート');
    expect(slides[0]!.lines).toHaveLength(3);
    expect(slides[0]!.lines[1]!.mono).toBe(true);
  });

  it('写せなかった件数は注意として返る', () => {
    const r = buildPptx([{ kind: 'skipped', what: 'X', why: 'Y' }], { title: 'T' });
    expect(r.warnings).toHaveLength(1);
    expect(r.counts.skipped).toBe(1);
  });
});

describe('骨格(zip に並べる部品)', () => {
  const r = buildPptx([h(1, '章'), h(2, '副題'), h(3, '節'), p('本文')], { title: 'ノート' });

  it('スライドは 2 枚できている(空振り防止)', () => {
    expect(r.counts.slides).toBe(2);
    expect(r.counts.sectionSlides).toBe(1);
  });

  it('🔴 目録に載っている部品が、すべて実在する', () => {
    const names = new Set(r.parts.map((x) => x.name));
    const ct = partOf(r, '[Content_Types].xml');
    const overrides = [...ct.matchAll(/PartName="\/([^"]+)"/g)].map((m) => m[1]!);
    // 空振り防止 ── 1 件も拾えていない形で「全部在る」と言わない
    expect(overrides.length).toBeGreaterThan(5);
    for (const o of overrides) {
      expect(names.has(o), `目録に在るのに部品が無い: ${o}`).toBe(true);
    }
  });

  it('🔴 rels の指し先が、すべて実在する', () => {
    const names = new Set(r.parts.map((x) => x.name));
    let checked = 0;
    for (const part of r.parts) {
      if (!part.name.endsWith('.rels')) continue;
      // `a/_rels/b.xml.rels` の基準は `a/`
      const base = part.name.replace(/_rels\/[^/]+$/, '');
      for (const m of part.text.matchAll(/Target="([^"]+)"/g)) {
        const target = m[1]!;
        if (/^https?:/.test(target)) continue;
        const joined = (base + target).split('/').reduce<string[]>((acc, seg) => {
          if (seg === '..') acc.pop();
          else if (seg !== '' && seg !== '.') acc.push(seg);
          return acc;
        }, []).join('/');
        checked += 1;
        expect(names.has(joined), `rels が指す先が無い: ${joined}(${part.name})`).toBe(true);
      }
    }
    // 空振り防止 ── rels を 1 件も見ていない形で「全部通った」と言わない
    expect(checked).toBeGreaterThan(5);
  });

  it('🔴 スライドの id と rels の id が、枚数ぶん噛み合っている', () => {
    const pres = partOf(r, 'ppt/presentation.xml');
    const ids = [...pres.matchAll(/<p:sldId id="\d+" r:id="(rId\d+)"\/>/g)].map((m) => m[1]!);
    expect(ids).toHaveLength(r.counts.slides);
    const rels = partOf(r, 'ppt/_rels/presentation.xml.rels');
    /**
     * 🔴 **「在る」だけでは足りない ── その rId が「スライド」を指していること。**
     *
     * ⚠ 変異試験 P7(`rId${i + 3}` → `rId${i + 2}`)が**生き延びた**。ずらすと
     * 1 枚目が `rId2` = **テーマ**を指すが、`Id="rId2"` は実在するので
     * 「在るか」だけの検査は通ってしまう ── 別の関係に満たされていた
     * (CLAUDE.md §1「救い手が変わっただけ」)。
     * 🔑 **種別と指し先の番号**まで見る。
     */
    ids.forEach((id, i) => {
      const m = new RegExp(`<Relationship Id="${id}" Type="([^"]+)" Target="([^"]+)"/>`).exec(rels);
      expect(m, `presentation.xml.rels に ${id} が無い`).not.toBeNull();
      expect(m![1], `${id} がスライドを指していない`).toMatch(/\/slide$/);
      expect(m![2], `${id} が ${i + 1} 枚目を指していない`).toBe(`slides/slide${i + 1}.xml`);
    });
    // ⚠ 重複した rId を作っていないこと(片方が黙って上書きされる)
    const allIds = [...rels.matchAll(/Id="(rId\d+)"/g)].map((m) => m[1]!);
    expect(new Set(allIds).size, 'rId が重複している').toBe(allIds.length);
  });

  it('🔴 本文の箱は PowerPoint に縮めさせる(切り捨てない)', () => {
    expect(partOf(r, 'ppt/slides/slide2.xml'), 'normAutofit が無い ── はみ出した本文が切れる')
      .toContain('<a:normAutofit/>');
  });

  it('版面は 16:9 である', () => {
    expect(partOf(r, 'ppt/presentation.xml')).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
  });

  it('本文の字が実際に入っている(空の箱を作っていない)', () => {
    expect(partOf(r, 'ppt/slides/slide1.xml')).toContain('<a:t>章</a:t>');
    expect(partOf(r, 'ppt/slides/slide1.xml')).toContain('<a:t>副題</a:t>');
    expect(partOf(r, 'ppt/slides/slide2.xml')).toContain('<a:t>本文</a:t>');
  });

  it('XML を壊す文字は escape される', () => {
    const x = buildPptx([p('a<b & c>')], { title: 'T' });
    const slide = x.parts.find((q) => q.name === 'ppt/slides/slide1.xml')!.text;
    expect(slide).toContain('a&lt;b &amp; c&gt;');
    expect(slide).not.toContain('a<b & c>');
  });
});

/**
 * 🔴 **段②:番号付きの箇条書きと、リンク**。
 *
 * ⚠ どちらも「落ちても file は開ける」ので、**test が無いと静かに消える**種類である
 * (PKC2 の画像がまさにそれだった)。
 */
describe('段②:箇条書きの種類とリンク', () => {
  it('🔴 番号付きは番号として出る(点に化けない)', () => {
    const r = buildPptx([
      { kind: 'li', ordered: true, depth: 0, runs: [{ text: '一つ目' }] },
      { kind: 'li', ordered: false, depth: 0, runs: [{ text: '点' }] },
    ], { title: 'T' });
    const slide = partOf(r, 'ppt/slides/slide1.xml');
    expect(slide, '番号付きが番号になっていない').toContain('<a:buAutoNum type="arabicPeriod"/>');
    expect(slide, '点の指定が無い').toContain('<a:buChar');
  });

  it('🔴 箇条書きでない行には点を付けない', () => {
    const r = buildPptx([p('ただの段落')], { title: 'T' });
    expect(partOf(r, 'ppt/slides/slide1.xml')).toContain('<a:buNone/>');
  });

  it('🔴 リンクは、その slide の rels に実体を持つ', () => {
    const r = buildPptx(
      [{ kind: 'p', runs: [{ text: '参照', href: 'https://example.com/a' }] }],
      { title: 'T' },
    );
    const slide = partOf(r, 'ppt/slides/slide1.xml');
    const m = /<a:hlinkClick r:id="(rId\d+)"\/>/.exec(slide);
    expect(m, 'リンクが書かれていない').not.toBeNull();
    const rels = partOf(r, 'ppt/slides/_rels/slide1.xml.rels');
    // ⚠ **id が在るだけでは足りない** ── 型紙(rId1)に当たっていないこと(段① の P7 と同じ罠)
    const rel = new RegExp(`<Relationship Id="${m![1]}" Type="([^"]+)" Target="([^"]+)"([^/]*)/>`).exec(rels);
    expect(rel, `rels に ${m![1]} が無い`).not.toBeNull();
    expect(rel![1], 'リンクを指していない').toMatch(/\/hyperlink$/);
    expect(rel![2]).toBe('https://example.com/a');
    // 🔴 外部リンクは External でないと PowerPoint が file ごと拒む
    expect(rel![3], 'TargetMode="External" が無い').toContain('TargetMode="External"');
    expect(r.counts.links).toBe(1);
  });

  it('同じ URL は 1 つに畳む(rels を無駄に増やさない)', () => {
    const r = buildPptx([
      { kind: 'p', runs: [{ text: 'A', href: 'https://e.example/x' }] },
      { kind: 'p', runs: [{ text: 'B', href: 'https://e.example/x' }] },
    ], { title: 'T' });
    expect(r.counts.links).toBe(1);
  });

  it('🔴 リンクの URL も escape される(rels を壊さない)', () => {
    const r = buildPptx(
      [{ kind: 'p', runs: [{ text: 'X', href: 'https://e.example/?a=1&b="2"' }] }],
      { title: 'T' },
    );
    const rels = partOf(r, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toContain('a=1&amp;b=&quot;2&quot;');
    expect(rels).not.toContain('b="2"');
  });

  it('🔴 走りの装飾が属性として出る(太字 / 傾き / 取消)', () => {
    const r = buildPptx([{
      kind: 'p',
      runs: [{ text: 'B', bold: true }, { text: 'I', italic: true }, { text: 'S', strike: true }],
    }], { title: 'T' });
    const slide = partOf(r, 'ppt/slides/slide1.xml');
    expect(slide).toContain('b="1"');
    expect(slide).toContain('i="1"');
    // ⚠ **取消だけは属性でしか確かめていない** ── LibreOffice の PNG 書き出しでは
    //    線が出なかった(実測 2026-08-24)。DrawingML の綴りは `sngStrike` で正しく、
    //    PowerPoint 実機での見え方は実機の検証に回す
    expect(slide, '取消の綴りが違う').toContain('strike="sngStrike"');
  });

  it('等幅(コード)は書体が指定される', () => {
    const r = buildPptx([{ kind: 'code', text: 'x' }], { title: 'T' });
    expect(partOf(r, 'ppt/slides/slide1.xml')).toContain('<a:latin typeface="Consolas"/>');
  });

  it('URL の無いリンクは素の文字として出る(消さない)', () => {
    const r = buildPptx([{ kind: 'p', runs: [{ text: '素', href: '' }] }], { title: 'T' });
    expect(partOf(r, 'ppt/slides/slide1.xml')).toContain('<a:t>素</a:t>');
    expect(r.counts.links).toBe(0);
  });
});

/**
 * 🔴 **段③:表と画像は「自分の箱」で置く**。
 *
 * docx との一番大きな違いがここである ── docx は本文の流れに置けばよいが、
 * スライドは**位置と大きさ**が要る(設計 doc §5)。
 *
 * ⚠ **PKC2 はここで 2 つ落としていた**:
 * ① 画像を全部 **480×360 px に潰していた**(縦横比を無視)
 * ② 表を**素の文字**に潰していた(格子が消える)
 */
describe('段③:表と画像は「自分の箱」で置く', () => {
  const cell = (t: string, header = false): ExportCell => ({ runs: [{ text: t }], header });
  const img = (media: string, w: number, h: number): ExportBlock =>
    ({ kind: 'image', media, widthPx: w, heightPx: h, alt: '図' });

  /**
   * スライドに置かれた箱の矩形(EMU)。
   * ⚠ **文字箱・表・画像で同じ綴り**を使っているので、1 本の正規表現で全部拾える。
   */
  const rectsOf = (xml: string): { x: number; y: number; w: number; h: number }[] =>
    [...xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)]
      .map((m) => ({ x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]! }));

  it('🔴 表は格子として出る(素の文字に潰さない)', () => {
    const r = buildPptx([{
      kind: 'table',
      rows: [[cell('見出し', true), cell('B')], [cell('1'), cell('2')]],
    }], { title: 'T' });
    const slide = partOf(r, 'ppt/slides/slide1.xml');
    expect(slide, '表が graphicFrame になっていない').toContain('<p:graphicFrame>');
    expect(slide).toContain('<a:tbl>');
    expect([...slide.matchAll(/<a:gridCol /g)], '列が 2 本になっていない').toHaveLength(2);
    expect([...slide.matchAll(/<a:tr /g)], '行が 2 本になっていない').toHaveLength(2);
    expect([...slide.matchAll(/<a:tc>/g)], 'セルが 4 つになっていない').toHaveLength(4);
    /**
     * ⚠ 見出しのセルは太字(`firstRow` だけでは型紙依存になる)。
     * 🔴 **セルの中だけを見る** ── 1 稿目は `/b="1"[^]*<a:t>見出し/` と書いたが、
     * **題名の箱の太字**に満たされて変異試験 M7 が生き延びた(CLAUDE.md §1
     * 「救い手が変わっただけ」)。面(セル)へスコープしないと、別の場所の字で満たされる。
     */
    const tcOf = (t: string): string => {
      const found = [...slide.matchAll(/<a:tc>([^]*?)<\/a:tc>/g)]
        .map((m) => m[1]!).find((x) => x.includes(`<a:t>${t}</a:t>`));
      expect(found, `セルが無い: ${t}`).toBeTruthy();
      return found!;
    };
    expect(tcOf('見出し'), '見出しのセルが太字になっていない').toContain('b="1"');
    // ⚠ 対照群 ── 見出しでないセルは太字にしない(全部太字にする実装と区別する)
    expect(tcOf('1'), '見出しでないセルまで太字になっている').not.toContain('b="1"');
    expect(r.counts.tables).toBe(1);
  });

  it('🔴 行ごとに列数が違っても、全行が同じセル数になる', () => {
    // ⚠ 揃っていないと PowerPoint は **file ごと拒む**(表が消えるのではなく開けない)
    const r = buildPptx([{
      kind: 'table',
      rows: [[cell('A'), cell('B'), cell('C')], [cell('1')]],
    }], { title: 'T' });
    const slide = partOf(r, 'ppt/slides/slide1.xml');
    const rows = [...slide.matchAll(/<a:tr [^>]*>([^]*?)<\/a:tr>/g)].map((m) => m[1]!);
    expect(rows, '行が 2 本取れていない').toHaveLength(2);
    for (const row of rows) {
      expect([...row.matchAll(/<a:tc>/g)], '行の列数が揃っていない').toHaveLength(3);
    }
  });

  it('🔴 指す先が無い書式 id を書かない(`tableStyles.xml` を出していない)', () => {
    // ⚠ 「宣言されて・実在して・指されて」の 3 点確認(docx #232 と同じ型)。
    //    書式 id を書くなら `tableStyles.xml` を出す必要がある ── 出していないので書かない
    const r = buildPptx([{ kind: 'table', rows: [[cell('A')]] }], { title: 'T' });
    expect(partOf(r, 'ppt/slides/slide1.xml')).not.toContain('tableStyleId');
  });

  it('🔴 画像は縦横比を保つ(PKC2 は全部 480×360 に潰していた)', () => {
    // 横長 / 縦長の 2 形 ── 片方だけだと「たまたま合っている」を見抜けない
    for (const [w, h] of [[1600, 400], [400, 1600]] as const) {
      const r = buildPptx([img('media/a.png', w, h)], { title: 'T' });
      const slide = partOf(r, 'ppt/slides/slide1.xml');
      const m = /<p:pic>[^]*?<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(slide);
      expect(m, '画像が置かれていない').not.toBeNull();
      const got = +m![1]! / +m![2]!;
      // ⚠ 丸めのぶんだけ許す(1% 未満)── 「だいたい」ではなく**比が保たれている**
      expect(Math.abs(got - w / h) / (w / h), `縦横比が崩れている(${w}×${h})`).toBeLessThan(0.01);
    }
  });

  it('🔴 枠より小さい画像は引き伸ばさない(粗くしない)', () => {
    const r = buildPptx([img('media/small.png', 100, 50)], { title: 'T' });
    const m = /<p:pic>[^]*?<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(partOf(r, 'ppt/slides/slide1.xml'));
    // 100px × 9525 = 952500 EMU のまま(枠いっぱいに広げない)
    expect([+m![1]!, +m![2]!]).toEqual([952500, 476250]);
  });

  it('🔴 画像の `r:embed` は、そのスライドの rels の image を指す', () => {
    const r = buildPptx([img('media/image1.png', 100, 100)], { title: 'T' });
    const slide = partOf(r, 'ppt/slides/slide1.xml');
    const m = /<a:blip r:embed="(rId\d+)"\/>/.exec(slide);
    expect(m, '画像が embed されていない').not.toBeNull();
    const rels = partOf(r, 'ppt/slides/_rels/slide1.xml.rels');
    const rel = new RegExp(`<Relationship Id="${m![1]}" Type="([^"]+)" Target="([^"]+)"([^/]*)/>`).exec(rels);
    expect(rel, `rels に ${m![1]} が無い`).not.toBeNull();
    // ⚠ **型紙(rId1)やリンクに当たっていないこと** ── 種別まで見る(段① の P7 と同じ罠)
    expect(rel![1], '画像を指していない').toMatch(/\/image$/);
    // 🔴 **package の中**を指す ── 外部リンク扱いにすると bytes を読まない
    expect(rel![3], '画像に TargetMode が付いている').not.toContain('TargetMode');
    /**
     * 🔴 **呼び側との契約**:`media` は形式の根からの相対名(`media/…`)で、
     * bytes は `ppt/media/…` へ入る(段⑤ の仕事)。
     * ⚠ ここがずれると「rels は在るのに絵が出ない」= **静かに壊れる**側なので、
     * 解決後の名前を**そのまま pin する**。
     */
    const base = 'ppt/slides/';
    const joined = (base + rel![2]!).split('/').reduce<string[]>((acc, seg) => {
      if (seg === '..') acc.pop();
      else if (seg !== '' && seg !== '.') acc.push(seg);
      return acc;
    }, []).join('/');
    expect(joined, 'bytes を置く場所と食い違っている').toBe('ppt/media/image1.png');
    expect(r.counts.images).toBe(1);
  });

  it('🔴 使った拡張子だけを目録に宣言する', () => {
    const r = buildPptx([img('media/a.png', 10, 10), img('media/b.png', 10, 10)], { title: 'T' });
    const ct = partOf(r, '[Content_Types].xml');
    // ⚠ 宣言が無いと PowerPoint は種類を決められず **file ごと拒む**
    expect(ct, 'png の宣言が無い').toContain('<Default Extension="png" ContentType="image/png"/>');
    // ⚠ 使っていない種類は宣言しない(docx は全部並べているが、あれは固定の目録)
    expect(ct, '使っていない jpeg を宣言している').not.toContain('Extension="jpeg"');
  });

  it('知らない拡張子でも宣言する(黙って落とさない)', () => {
    const r = buildPptx([img('media/x.bmp', 10, 10)], { title: 'T' });
    expect(partOf(r, '[Content_Types].xml'))
      .toContain('<Default Extension="bmp" ContentType="application/octet-stream"/>');
  });

  it('🔴 本文と箱は重ならない(下の物が読めなくなる = user から見ると「消えた」)', () => {
    const r = buildPptx([
      h(3, '節'), p('本文'),
      { kind: 'table', rows: [[cell('A')]] },
      img('media/a.png', 1000, 1000),
    ], { title: 'T' });
    const rects = rectsOf(partOf(r, 'ppt/slides/slide1.xml'));
    // 空振り防止 ── 題名 / 本文 / 表 / 画像 の 4 つが在ること
    expect(rects, '箱が 4 つ置かれていない').toHaveLength(4);
    const sorted = [...rects].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      expect(sorted[i]!.y, `${i} 番目が ${i - 1} 番目に重なっている`)
        .toBeGreaterThanOrEqual(prev.y + prev.h);
    }
    // ⚠ 版面(6858000 EMU)からはみ出していないこと
    const last = sorted[sorted.length - 1]!;
    expect(last.y + last.h, '版面からはみ出している').toBeLessThanOrEqual(6858000);
  });

  it('🔴 1 枚の中で図形の id が重複しない(重複した id は PowerPoint が拒む)', () => {
    const r = buildPptx([
      h(3, '節'), p('本文'),
      { kind: 'table', rows: [[cell('A')]] },
      img('media/a.png', 100, 100),
    ], { title: 'T' });
    const ids = [...partOf(r, 'ppt/slides/slide1.xml').matchAll(/<p:cNvPr id="(\d+)"/g)]
      .map((m) => m[1]!);
    // 空振り防止 ── 群 1 + 題名 + 本文 + 表 + 画像 = 5
    expect(ids, '図形が 5 つ置かれていない').toHaveLength(5);
    expect(new Set(ids).size, `id が重複している: ${ids.join(',')}`).toBe(ids.length);
  });

  it('本文が無く箱だけのときは、空の文字箱を作らない', () => {
    const r = buildPptx([{ kind: 'table', rows: [[cell('A')]] }], { title: 'T' });
    const slide = partOf(r, 'ppt/slides/slide1.xml');
    // 題名の箱 1 つ + 表 1 つ = 2(本文の箱は作らない)
    expect(rectsOf(slide)).toHaveLength(2);
    expect(slide, '本文の箱が作られている').not.toContain('name="本文"');
  });

  /**
   * 🔴 **取り分は「中身の量」で配る**(段④)。
   * ⚠ 段③ は等分だったので、**1 行しか本文が無くても枠の 1/3 を取っていた**
   *   (焼いて目で見て分かった)。ここはその規則を**置き換えた**ところである。
   */
  const tableHOf = (r: ReturnType<typeof buildPptx>): number => {
    const m = /<p:graphicFrame>[^]*?<a:ext cx="\d+" cy="(\d+)"\/>/.exec(partOf(r, 'ppt/slides/slide1.xml'));
    expect(m, '表が置かれていない').not.toBeNull();
    return +m![1]!;
  };
  const tableOf = (n: number): ExportBlock =>
    ({ kind: 'table', rows: Array.from({ length: n }, (_, i) => [cell(`r${i}`)]) });

  it('🔴 表の高さは行数で決まる(等分ではない)', () => {
    const one = tableHOf(buildPptx([tableOf(1)], { title: 'T' }));
    const three = tableHOf(buildPptx([tableOf(3)], { title: 'T' }));
    // ⚠ 3 行はほぼ 3 倍(縮めが効く前 = 枠に余裕がある形で見る)
    expect(three / one, '行数で高さが変わっていない').toBeGreaterThan(2.5);
  });

  it('🔴 本文が 1 行なら、本文は枠の 1/3 も取らない', () => {
    const r = buildPptx([h(3, '節'), p('1 行'), tableOf(1)], { title: 'T' });
    const slide = partOf(r, 'ppt/slides/slide1.xml');
    const m = /name="本文"[^]*?<a:ext cx="\d+" cy="(\d+)"\/>/.exec(slide);
    expect(m, '本文の箱が無い').not.toBeNull();
    // 本文の枠は 5.1 インチ = 4663440 EMU。その 1/3 は 1554480
    expect(+m![1]!, '本文が中身の量に対して大きすぎる').toBeLessThan(1554480);
  });

  it('🔴 収まらないときは全部を同じ率で縮め、枠からはみ出さない', () => {
    // 30 行の表を 3 つ ── 素のままでは枠(5.1 インチ)にまるで入らない
    const r = buildPptx([tableOf(30), tableOf(30), tableOf(30)], { title: 'T' });
    const rects = rectsOf(partOf(r, 'ppt/slides/slide1.xml'));
    // 題名 + 表 3 つ
    expect(rects, '箱が 4 つ置かれていない').toHaveLength(4);
    const boxes = rects.filter((x) => x.y >= 1371600); // 本文の枠(1.5 インチ)から下
    expect(boxes, '表が 3 つ取れていない').toHaveLength(3);
    // ⚠ 比は変えない ── 同じ行数なので高さも揃う
    expect(new Set(boxes.map((b) => b.h)).size, '同じ形の表で高さが違う').toBe(1);
    const last = boxes[boxes.length - 1]!;
    expect(last.y + last.h, '本文の枠からはみ出している').toBeLessThanOrEqual(1371600 + 4663440);
    expect(r.counts.tables).toBe(3);
  });

  it('🔴 列の幅は中身の量で配り、合計は表の幅ちょうどになる', () => {
    const r = buildPptx([{
      kind: 'table',
      rows: [[cell('あ'), cell('とても長い説明がここに入る列である')]],
    }], { title: 'T' });
    const slide = partOf(r, 'ppt/slides/slide1.xml');
    const cols = [...slide.matchAll(/<a:gridCol w="(\d+)"\/>/g)].map((m) => +m[1]!);
    expect(cols, '列が 2 本取れていない').toHaveLength(2);
    expect(cols[1], '長い列が広くなっていない').toBeGreaterThan(cols[0]!);
    // 🔴 端数が余ると右端が揃わない ── 合計は表の幅ちょうど
    const w = +(/<p:graphicFrame>[^]*?<a:ext cx="(\d+)"/.exec(slide)![1]!);
    expect(cols[0]! + cols[1]!, '列の合計が表の幅と違う').toBe(w);
  });

  it('🔴 全角は 2 文字ぶんの幅として数える', () => {
    /**
     * ⚠ 変異試験 N12(全部 1 と数える)が**生き延びた** ── 1 稿目の fixture は
     * 「短い日本語 vs 長い日本語」だったので、**字数でも同じ順**になっていた。
     * 🔑 **順が入れ替わる形**で見る:全角 8 字(見た目 16)vs 半角 12 字(見た目 12)。
     */
    const r = buildPptx([{
      kind: 'table',
      rows: [[cell('あいうえおかきく'), cell('abcdefghijkl')]],
    }], { title: 'T' });
    const cols = [...partOf(r, 'ppt/slides/slide1.xml').matchAll(/<a:gridCol w="(\d+)"\/>/g)]
      .map((m) => +m[1]!);
    expect(cols, '列が 2 本取れていない').toHaveLength(2);
    expect(cols[0]!, '全角の列が半角の列より狭い(字数で数えている)')
      .toBeGreaterThan(cols[1]!);
  });

  it('🔴 とても長い列が、他の列を飢えさせない(上限がある)', () => {
    const r = buildPptx([{
      kind: 'table',
      rows: [[cell('印'), cell('x'.repeat(300))]],
    }], { title: 'T' });
    const slide = partOf(r, 'ppt/slides/slide1.xml');
    const cols = [...slide.matchAll(/<a:gridCol w="(\d+)"\/>/g)].map((m) => +m[1]!);
    const total = cols.reduce((a, b) => a + b, 0);
    // ⚠ 上限が無いと 300:4 になり、細い列は字が 1 つも入らない幅になる
    expect(cols[0]! / total, '細い列が潰れている').toBeGreaterThan(0.1);
  });

  it('空の列も潰れない(下限がある)', () => {
    const r = buildPptx([{
      kind: 'table',
      rows: [[cell(''), cell('あいうえおかきくけこさしすせそ')]],
    }], { title: 'T' });
    const cols = [...partOf(r, 'ppt/slides/slide1.xml').matchAll(/<a:gridCol w="(\d+)"\/>/g)]
      .map((m) => +m[1]!);
    expect(cols[0]!, '空の列が潰れている').toBeGreaterThan(0);
  });
});

/**
 * 🔴 **段④:中身が 1 つも無いスライドは畳む**。
 *
 * ⚠ 設計 doc §3「切れ方は PKC2 と同じ」から**わざと外した 1 点**である ──
 * PKC2 も畳んでいないが、markdown では `---` を見出しの前に置くのがごく普通なので、
 * user の手元では**書くたびに白い紙が挟まる**。
 */
describe('段④:空のスライドを畳む', () => {
  it('🔴 `---` の直後に見出しを書いても、白いスライドができない', () => {
    const slides = splitIntoSlides([p('前'), { kind: 'hr' }, h(3, '節'), p('後')], 'ノート');
    expect(slides.map((s) => s.title), '空のスライドが残っている').toEqual(['ノート', '節']);
  });

  it('🔴 文書の末尾の `---` も、白いスライドを残さない', () => {
    const slides = splitIntoSlides([p('本文'), { kind: 'hr' }], 'ノート');
    expect(slides).toHaveLength(1);
  });

  it('中身のある切れ目は畳まない(対照群)', () => {
    // ⚠ これが無いと「全部畳む」実装と区別できない
    const slides = splitIntoSlides([p('前'), { kind: 'hr' }, p('後')], 'ノート');
    expect(slides).toHaveLength(2);
    expect(slides[1]!.title).toBe('');
  });

  it('全部が空でも 1 枚は残す(0 枚の pptx は開けない)', () => {
    expect(splitIntoSlides([{ kind: 'hr' }, { kind: 'hr' }], '')).toHaveLength(1);
  });
});
