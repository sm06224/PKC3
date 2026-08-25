/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import {
  duplicateNote,
  findDuplicates,
  narrowByLength,
} from '../../src/features/import/duplicate-scan';

const inc = (lid: string, title: string, body: string) => ({ lid, title, body });

describe('同じものを 2 回取り込んだと気づく(絞り) #399', () => {
  it('文字数が一致する既存だけ読む', () => {
    const incoming = [inc('a', 'あ', '12345')];
    const existing = [
      { lid: 'x', bodyChars: 5 },
      { lid: 'y', bodyChars: 9 },
    ];
    expect(narrowByLength(incoming, existing)).toEqual(['x']);
  });

  /**
   * 🔴 **文字数が分かっていないものは外さない。**
   * ⚠ 外すと「重なっているのに数えられなかった」が黙って起きる ──
   *   **数が過少になる向き**の誤りで、user は気づけない。
   */
  it('🔴 文字数が分からない既存は必ず読む', () => {
    expect(
      narrowByLength([inc('a', 'あ', '12345')], [{ lid: 'z', bodyChars: null }]),
    ).toEqual(['z']);
  });

  it('一致が無ければ 1 件も読まない(高い読みを避ける)', () => {
    expect(narrowByLength([inc('a', 'あ', '12345')], [{ lid: 'x', bodyChars: 9 }])).toEqual([]);
  });

  it('取り込む側が空なら読まない', () => {
    expect(narrowByLength([], [{ lid: 'x', bodyChars: 5 }])).toEqual([]);
  });
});

describe('同じものを 2 回取り込んだと気づく(照合) #399', () => {
  /** ⚠ **1 バイトも違わない**ものだけ数える(似ているは数えない)。 */
  it('🔴 中身が完全に同じものだけ数える', () => {
    const hits = findDuplicates(
      [inc('a', '買い物', '牛乳\n卵'), inc('b', '別物', '牛乳\n卵\nパン')],
      new Map([['x', '牛乳\n卵']]),
    );
    expect(hits).toEqual([{ title: '買い物', existingLid: 'x' }]);
  });

  /** ⚠ 題名が同じでも中身が違えば数えない(数字を信じられなくしない)。 */
  it('題名が同じでも中身が違えば数えない', () => {
    expect(
      findDuplicates([inc('a', '買い物', '牛乳')], new Map([['x', 'たまご']])),
    ).toEqual([]);
  });

  /** ⚠ 既存が複数当たっても **1 件**(user が知りたいのは「いくつ増えたか」)。 */
  it('既存が複数当たっても 1 件と数える', () => {
    expect(
      findDuplicates([inc('a', '買い物', '牛乳')], new Map([['x', '牛乳'], ['y', '牛乳']])),
    ).toHaveLength(1);
  });
});

describe('重なりの知らせ方 #399', () => {
  it('重なりが無ければ黙る', () => {
    expect(duplicateNote([])).toBeNull();
  });

  /** ⚠ **件数だけで終わらせない** ── 何が重なったか分からないと目で確かめる羽目になる。 */
  it('🔴 件数と、何が重なったかを言う', () => {
    const note = duplicateNote([
      { title: '買い物', existingLid: 'x' },
      { title: 'メモ', existingLid: 'y' },
    ]);
    expect(note).toContain('2 件');
    expect(note).toContain('「買い物」');
    expect(note).toContain('「メモ」');
  });

  /** ⚠ **切ったことを言う**(黙って切ると「これで全部」と読まれる)。 */
  it('🔴 多いときは切るが、切ったと言う', () => {
    const hits = ['あ', 'い', 'う', 'え', 'お'].map((t) => ({ title: t, existingLid: 'x' }));
    const note = duplicateNote(hits, 2)!;
    expect(note).toContain('5 件');
    expect(note, '切ったことを言っていない').toContain('ほか 3 件');
  });

  /** 🔑 **取込は止めていない**ことを言う(user が次に何をすればよいか分かる)。 */
  it('取込を止めていないことと、次にどうするかを言う', () => {
    const note = duplicateNote([{ title: 'あ', existingLid: 'x' }])!;
    expect(note).toContain('止めていない');
    expect(note).toContain('消してください');
  });
});
