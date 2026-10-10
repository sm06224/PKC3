/** @vitest-environment happy-dom */
/**
 * 🔴 **別のノートの見出しの節を本文へ描く**(#1459 ①)── 規則(pure)の側。
 *
 * 守る主張: 節の範囲は追記・章だけ編集と**同じ**(見出し 〜 次の同じ深さか浅い見出しの手前)/ 見つからない
 * ときは黙って空にせず `missing` と言う / 長い節は板と同じ規則で切る / 本文が展開を求めている鍵を
 * fence の外から拾う / ふつうのリンク(`!` 無し)は展開を求めない。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { PLACE_BODY_CLIP } from '../../src/features/markdown/place-embed';
import {
  baseLidOfKey,
  parseSectionKey,
  sectionEmbedKeys,
  sectionExcerptOf,
  sectionKey,
} from '../../src/features/markdown/section-embed';

const NOTE = [
  '# Top',
  '前置き',
  '',
  '## Plan',
  '計画 1',
  '',
  '### Detail',
  '詳細(Plan の中身)',
  '',
  '## Todo',
  'やること',
  '',
  '# Next',
  '次',
].join('\n');

describe('節の切り出し(sectionExcerptOf)', () => {
  it('🔴 見出しから、次の「同じ深さか浅い」見出しの手前まで(深い見出しは節の中身)', () => {
    const r = sectionExcerptOf(NOTE, 'plan');
    expect(r.missing).toBeUndefined();
    expect(r.text).toBe(['## Plan', '計画 1', '', '### Detail', '詳細(Plan の中身)'].join('\n'));
    // 境界の向き:次の節(Todo)・親の続き(Next)は入らない
    expect(r.text).not.toContain('やること');
    expect(r.text).not.toContain('次');
  });

  it('最後の節は本文の終わりまで / 浅い見出しの節は深い見出しを跨ぐ', () => {
    expect(sectionExcerptOf(NOTE, 'next').text).toBe('# Next\n次');
    const top = sectionExcerptOf(NOTE, 'top').text;
    expect(top).toContain('やること');
    expect(top).not.toContain('# Next');
  });

  it('🔴 見出しが無ければ missing(黙って空にしない)', () => {
    expect(sectionExcerptOf(NOTE, 'ghost')).toEqual({ text: '', cut: false, missing: true });
    expect(sectionExcerptOf('', 'plan').missing).toBe(true);
  });

  it('同じ字の見出しは別の印(2 つ目は -1)── 指した方が出る', () => {
    const b = '## A\n一つ目\n## A\n二つ目';
    expect(sectionExcerptOf(b, 'a').text).toBe('## A\n一つ目');
    expect(sectionExcerptOf(b, 'a-1').text).toBe('## A\n二つ目');
  });

  it('frontmatter の中・fence の中の # は見出しではない', () => {
    const b = '---\ntitle: # x\n---\n## Real\n```\n## Fake\n```\n本文';
    expect(sectionExcerptOf(b, 'real').text).toContain('本文');
    expect(sectionExcerptOf(b, 'fake').missing).toBe(true);
  });

  it('長い節は板と同じ規則で切って cut を立てる', () => {
    const long = '## Big\n' + ('あ'.repeat(99) + '\n').repeat(60);
    const r = sectionExcerptOf(long, 'big');
    expect(r.cut).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(PLACE_BODY_CLIP);
    expect(sectionExcerptOf('## Small\nちいさい', 'small').cut).toBe(false);
  });
});

describe('鍵(sectionKey)', () => {
  it('往復する / 板の抜粋の鍵(ただの lid)は見出しの鍵ではない', () => {
    const k = sectionKey('n1', '買い出し');
    expect(k).toBe('n1#h/買い出し');
    expect(parseSectionKey(k)).toEqual({ lid: 'n1', id: '買い出し' });
    expect(baseLidOfKey(k)).toBe('n1');
    expect(parseSectionKey('n1')).toBeNull();
    expect(baseLidOfKey('n1')).toBe('n1');
    expect(parseSectionKey('n1#h/')).toBeNull();
  });
});

describe('本文が展開を求めている鍵(sectionEmbedKeys)', () => {
  it('🔴 画像形 `![…](entry:ノート#h/印)` だけを拾う(ふつうのリンクは展開を求めない)', () => {
    const body = [
      '![説明](entry:n1#h/plan)',
      '[リンク](entry:n2#h/plan)',
      '![](entry:n3)',
      '![x](entry:n4#day/2026-10-10)',
      '文中の ![a](entry:n5#h/todo) と ![b](entry:n6#h/%E8%A6%8B)',
    ].join('\n');
    expect(sectionEmbedKeys(body)).toEqual(['n1#h/plan', 'n5#h/todo', 'n6#h/見']);
  });

  it('fence の中は数えない', () => {
    expect(sectionEmbedKeys('```\n![a](entry:n1#h/plan)\n```\n![b](entry:n2#h/x)')).toEqual(['n2#h/x']);
  });
});

describe('描画器(markdown-render)── 本文のバイトと、ふつうのリンクは変わらない', () => {
  it('🔴 画像形は今までどおり器になり、参照が保たれる / リンクは器にならない', () => {
    const html = renderMarkdown('![説明](entry:n1#h/plan)\n\n[リンク](entry:n1#h/plan)');
    expect(html.match(/pkc-transclusion-placeholder/g)).toHaveLength(1);
    expect(html).toContain('data-pkc-embed-ref="entry:n1#h/plan"');
    expect(html).not.toContain('src="entry:');
    expect(html).toContain('data-pkc-action="navigate-entry-ref"');
  });
});

describe('行頭の # 以外で書いた見出し(setext / 引用・箇条書きの中)', () => {
  /**
   * 🔴 描画器が見出しとして刻む id と、節の範囲(`scanHeadings`)が**同じ見出しを数えているか**を実測する。
   * ⚠ 数えない見出しは「見出しが見つかりません」になる(黙って別の節を出すことは無いのが条件)。
   */
  const idsOf = (md: string): string[] => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(md);
    return [...host.querySelectorAll('h1,h2,h3')].map((h) => h.getAttribute('id') ?? '');
  };
  it('setext(下線)の見出しは節として引けない(見つかりませんになる)', () => {
    const md = 'Title\n=====\n本文\n\n## Real\n中身';
    const ids = idsOf(md);
    expect(ids).toContain('real');
    expect(sectionExcerptOf(md, 'real').text).toBe('## Real\n中身');
    const setext = ids.find((i) => i !== 'real')!;
    expect(sectionExcerptOf(md, setext).missing, 'setext が引けるようになった(マニュアルの注記を直す)').toBe(true);
  });
  it('引用・箇条書きの中の # は引けない / 別の節を取り違えない', () => {
    const md = '> ## Quoted\n> 引用\n\n- ## Listed\n\n## Real\n中身';
    for (const id of idsOf(md).filter((i) => i !== 'real')) {
      expect(sectionExcerptOf(md, id).missing).toBe(true);
    }
    expect(sectionExcerptOf(md, 'real').text).toBe('## Real\n中身');
  });
});
