/**
 * 🔴 **どの添付を「取り込んだ DB」として選べるか**(#681 段③ の 2 つ目)。
 *
 * ⚠ 判定は**拡張子だけ**である ── 中身で見分けるには全部読むしかなく、
 *   選ぶ前に何十 MB も heap へ載せることになる(不可侵指示 2026-07-27 の逆)。
 * 🔑 だから**広めに拾ってよい**:外したものは開いたときに断られる。
 */
import { describe, expect, it } from 'vitest';
import { looksLikeSqliteName, sqlSourcesOf } from '../../src/features/query/sqlite-attachment';

const att = (lid: string, title: string) => ({ lid, title, archetype: 'attachment' });

describe('それらしい名前か', () => {
  it('よくある拡張子を拾う(大文字でも)', () => {
    for (const n of ['a.sqlite', 'a.sqlite3', 'a.db', 'a.db3', 'A.SQLite', ' 売上.db ']) {
      expect(looksLikeSqliteName(n), `拾うべき名前: ${n}`).toBe(true);
    }
  });

  it('⚠ それ以外は拾わない(写真や文書まで並べない)', () => {
    for (const n of ['a.png', 'a.docx', 'sqlite', 'a.db.txt', '']) {
      expect(looksLikeSqliteName(n), `拾ってはいけない名前: ${n}`).toBe(false);
    }
  });
});

describe('選べる相手を拾う', () => {
  it('🔴 添付で、かつ それらしい名前のものだけ', () => {
    const got = sqlSourcesOf([
      att('a', '売上.sqlite'),
      att('b', 'ねこ.png'),
      // ⚠ **添付でないノート**は、題名が .sqlite でも並ばない(中身が bytes ではない)
      { lid: 'c', title: 'メモ.sqlite', archetype: 'text' },
    ]);
    expect(got).toEqual([{ lid: 'a', name: '売上.sqlite' }]);
  });

  it('⚠ 並びは題名順(入れ直すたびに場所が変わらない)', () => {
    const got = sqlSourcesOf([att('a', 'ん.db'), att('b', 'あ.db'), att('c', 'k.db')]);
    expect(got.map((s) => s.name)).toEqual(['k.db', 'あ.db', 'ん.db']);
  });

  it('⚠ 1 つも無ければ空(空振り防止 ── 常に何かを返す形にしない)', () => {
    expect(sqlSourcesOf([att('a', 'ねこ.png')])).toEqual([]);
  });
});
