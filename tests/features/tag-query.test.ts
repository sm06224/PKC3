/** @vitest-environment node */
/**
 * 依頼 317: タグの札を押したら、そのタグが付いたノートだけを並べる。
 * 🔴 題名に `mail` を含むだけのノートが「AI」の札で並ぶ、が元の不具合。
 */
import { describe, expect, it } from 'vitest';
import { tagQueryOf, tagQueryText } from '../../src/features/filter/tag-query';
import { entryFilterOf, matchesEntry, NO_KINDS } from '../../src/features/filter/title-filter';

describe('#タグ の問い合わせ', () => {
  it('名前を取り出す(前後の空白は落とす・全角の ＃ も読む)', () => {
    expect(tagQueryOf('#AI')).toBe('AI');
    expect(tagQueryOf('  #買い物 ')).toBe('買い物');
    expect(tagQueryOf('＃AI')).toBe('AI');
    expect(tagQueryOf('#"仕事 メモ"')).toBe('仕事 メモ');
  });
  it('番号・空・ふつうの語・長すぎる名前はタグの問い合わせにしない(今までどおりの字として探す)', () => {
    for (const q of ['#117', '#', '# AI', 'AI', 'a#AI', '#a b', '#""', '#' + 'あ'.repeat(41)])
      expect(tagQueryOf(q), q).toBeNull();
  });
  it('札を押して入れる字は、読み戻すと同じ名前になる(空白・数字だけの名前も)', () => {
    for (const t of ['AI', '買い物', '仕事 メモ', '2026']) expect(tagQueryOf(tagQueryText(t)), t).toBe(t);
    expect(tagQueryText('2026')).toBe('#"2026"');
  });
  it('🔴 一覧の絞りは、題名では当てず、タグ走査が返した lid だけを通す', () => {
    const f = (hits: ReadonlySet<string> | null) => entryFilterOf('#AI', hits, NO_KINDS);
    const mail = { lid: 'm', title: 'mail の下書き #AI', archetype: 'text' };
    const tagged = { lid: 't', title: '無関係な題名', archetype: 'text' };
    const hits = new Set(['t']);
    expect(matchesEntry(mail, f(hits)), '題名に AI を含むだけのノートは並ばない').toBe(false);
    expect(matchesEntry(tagged, f(hits))).toBe(true);
    expect(matchesEntry(tagged, f(null)), 'まだ返っていない間は何も並べない').toBe(false);
  });
});
