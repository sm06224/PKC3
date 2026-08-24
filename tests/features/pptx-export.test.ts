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
import { buildPptx, splitIntoSlides, type ExportBlock } from '@features/export/pptx';

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
  it('🔴 表・画像・写せなかったものは、本文に理由が出る', () => {
    const blocks: ExportBlock[] = [
      { kind: 'table', rows: [[{ runs: [{ text: 'A' }] }, { runs: [{ text: 'B' }] }]] },
      { kind: 'image', media: 'media/image1.png', widthPx: 10, heightPx: 10, alt: '図表' },
      { kind: 'skipped', what: '埋め込みの箱', why: 'PowerPoint では動きません' },
    ];
    const slides = splitIntoSlides(blocks, 'ノート');
    const text = slides[0]!.lines.map((l) => l.runs.map((r) => r.text).join('')).join('\n');
    expect(text).toContain('A | B');
    expect(text).toContain('[画像: 図表]');
    expect(text).toContain('埋め込みの箱');
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
