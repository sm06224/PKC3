/** @vitest-environment happy-dom */
/**
 * 🔴 **マニュアルの中を探す**(#636)。
 *
 * 守る主張:
 * 1. 節の割り出しが**フェンスの中の `#` を見出しにしない**
 * 2. 🔴 **源文の見出しの通し番号 = 描かれた見出しの番号**(飛び先の土台)
 * 3. 打った字が**節ごとに数えられる**
 */
import { describe, expect, it } from 'vitest';
import { MANUAL_TEXT } from '../../src/adapter/ui/render/help';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  findInManual,
  manualSections,
  MANUAL_FIND_MAX_SECTIONS,
} from '../../src/features/help/manual-find';

describe('節の割り出し', () => {
  it('見出しを源文の順に拾い、番号を振る', () => {
    const secs = manualSections('# あ\n本文\n## い\n### う\n');
    expect(secs.map((s) => [s.title, s.level, s.index])).toEqual([
      ['あ', 1, 0],
      ['い', 2, 1],
      ['う', 3, 2],
    ]);
  });

  /**
   * 🔴 **フェンスの中の `#` は見出しではない。**
   * ⚠ マニュアル自身がフェンスの中で `# 見出し` を例示しているので、
   *   ここを外すと**番号が全部ずれ、押した所と別の節へ飛ぶ**。
   */
  it('🔴 フェンスの中の `#` を見出しにしない', () => {
    const secs = manualSections('# あ\n```md\n# にせもの\n```\n## い\n');
    expect(secs.map((s) => s.title)).toEqual(['あ', 'い']);
  });

  it('⚠ 対照群: フェンスを閉じれば、その後の見出しは拾う', () => {
    expect(manualSections('```\n# 中\n```\n# 外\n').map((s) => s.title)).toEqual(['外']);
  });

  it('チルダのフェンスも同じ', () => {
    expect(manualSections('~~~\n# 中\n~~~\n# 外\n').map((s) => s.title)).toEqual(['外']);
  });
});

/**
 * 🔴 **飛び先の土台**(#636)── 源文の見出しの通し番号で、描かれた
 * `h1〜h6` の同じ番号を掴む。**この対応が崩れたら、押した所と別の節へ飛ぶ。**
 *
 * ⚠ `id` は使えない(h1〜h3 にしか焼かれず、同一 document の本文の面に当たる)ので、
 *   **番号が唯一の足場**である。だから実物のマニュアルで pin する。
 */
describe('🔴 源文の見出しの数 = 描かれた見出しの数(#636)', () => {
  it('実物のマニュアルで 1 対 1 になる', () => {
    const src = manualSections(MANUAL_TEXT);
    const doc = new DOMParser().parseFromString(
      `<div>${renderMarkdown(MANUAL_TEXT)}</div>`,
      'text/html',
    );
    const dom = doc.querySelectorAll('h1,h2,h3,h4,h5,h6');
    // ⚠ 空振り防止 ── そもそも見出しが在ること
    expect(src.length, 'マニュアルに見出しが無い(台の空振り)').toBeGreaterThan(50);
    expect(dom.length, '源文と描かれた見出しの数が違う ── 飛び先がずれる').toBe(src.length);
  });

  /**
   * ⚠ **数が合うだけでは足りない**(同じ数だけ取り違えても数は合う)──
   *   字が対応していることまで見る。
   */
  it('同じ番号の見出しは、同じ字を指している', () => {
    const src = manualSections(MANUAL_TEXT);
    const doc = new DOMParser().parseFromString(
      `<div>${renderMarkdown(MANUAL_TEXT)}</div>`,
      'text/html',
    );
    const dom = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const bare = (t: string): string => t.replace(/[*`_\s]/gu, '');
    const off = src.filter((s, i) => {
      const got = bare(dom[i]?.textContent ?? '');
      const want = bare(s.title);
      return !got.includes(want) && !want.includes(got);
    });
    expect(off.map((s) => s.title), '番号と字が食い違う見出しがある').toEqual([]);
  });
});

describe('打った字を探す', () => {
  const DOC = '# あ\nりんご\n## い\nりんご りんご\n## う\nみかん\n';

  it('節ごとに数える(源文の並び順)', () => {
    expect(findInManual(DOC, 'りんご').map((h) => [h.section.title, h.count])).toEqual([
      ['あ', 1],
      ['い', 2],
    ]);
  });

  it('🔴 見出しの字も数える(題名に当たったのに 0 件と出さない)', () => {
    expect(findInManual(DOC, 'う').map((h) => h.section.title)).toEqual(['う']);
  });

  it('大小は無視する', () => {
    expect(findInManual('# H\nCSV と csv\n', 'CSV')[0]?.count).toBe(2);
  });

  it('見出しの前に書いた字は「(先頭)」に入る(番号は持たない)', () => {
    const h = findInManual('まえがき\n# あ\n', 'まえがき')[0]!;
    expect(h.section.title).toBe('(先頭)');
    expect(h.section.index, '番号を持つと、存在しない見出しへ飛ぶ').toBe(-1);
  });

  it('空の字では何も返さない(押しても撃たない側へ倒す)', () => {
    expect(findInManual(DOC, '')).toEqual([]);
    expect(findInManual(DOC, '   ')).toEqual([]);
  });

  it('⚠ フェンスの中も数える(user はコードの例も探す)', () => {
    expect(findInManual('# あ\n```\nりんご\n```\n', 'りんご')[0]?.count).toBe(1);
  });

  it('実物のマニュアルで、よく探しそうな語が当たる', () => {
    for (const w of ['ルビ', '予定', '書き出し', 'タグ', 'mermaid']) {
      expect(findInManual(MANUAL_TEXT, w).length, `「${w}」が 1 節も当たらない`).toBeGreaterThan(0);
    }
  });

  it('上限は「切る側」ではなく呼び側が持つ(ここは全部返す)', () => {
    const all = findInManual(MANUAL_TEXT, 'の');
    expect(all.length, '上限で切っている(数え直せなくなる)').toBeGreaterThan(
      MANUAL_FIND_MAX_SECTIONS,
    );
  });
});
