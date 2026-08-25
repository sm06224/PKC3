/**
 * 🔴 **雛形の表**(#196 / B-2)。
 *
 * ⚠ 見るのは 3 つ:① **frontmatter を本文へ挿さない** ② **語の途中では出さない**
 * ③ **長いほうを採る**(`ad` と `addr` が両方在るとき)。
 */
import { describe, expect, it } from 'vitest';
import {
  abbrBeforeCaret,
  filterSnippets,
  SNIPPET_ABBR_KEY,
  SNIPPET_ARCHETYPE,
  SNIPPET_LIMITS,
  snippetItemOf,
  type SnippetItem,
} from '../../src/features/snippet/snippet-table';
import { getFlavor, seedBodyFor } from '../../src/features/flavor';

const item = (abbr: string, title = 't', body = 'x'): SnippetItem => ({
  lid: `l-${abbr}`,
  title,
  abbr,
  body,
});

describe('雛形の 1 行を組む', () => {
  it('🔴 frontmatter は本文へ挿さない(abbr: の行が混ざらない)', () => {
    const s = snippetItemOf('l1', '住所', '---\nabbr: addr\n---\n〒100-0000\n');
    expect(s?.abbr).toBe('addr');
    expect(s?.body).toBe('〒100-0000\n');
  });

  it('短縮語が無くても表には載る(`/` からは呼べる)', () => {
    expect(snippetItemOf('l1', '挨拶', '拝啓')?.abbr).toBe('');
  });

  it('⚠ 本文が空なら載せない(挿しても何も起きない)', () => {
    expect(snippetItemOf('l1', '空', '---\nabbr: a\n---\n')).toBe(null);
    expect(snippetItemOf('l1', '空', '')).toBe(null);
  });

  it('⚠ 長すぎる本文は載せない(切って挿すと本文が壊れる)', () => {
    const long = 'あ'.repeat(SNIPPET_LIMITS.bodyChars + 1);
    expect(snippetItemOf('l1', '長い', long)).toBe(null);
  });

  it('⚠ 長すぎる短縮語は短縮語として使わない(本文は載る)', () => {
    const abbr = 'a'.repeat(SNIPPET_LIMITS.abbrChars + 1);
    const s = snippetItemOf('l1', 't', `---\n${SNIPPET_ABBR_KEY}: ${abbr}\n---\n本文\n`);
    expect(s?.abbr).toBe('');
    expect(s?.body).toBe('本文\n');
  });

  it('前後の空白は落とす(打ちやすさが命なので)', () => {
    expect(snippetItemOf('l1', 't', '---\nabbr: "  addr  "\n---\n本文')?.abbr).toBe('addr');
  });
});

describe('カーソルの手前の短縮語(Tab)', () => {
  const items = [item('ad'), item('addr'), item('住所')];

  it('当たれば、その行と始まりが返る', () => {
    // ⚠ 「見出し 」は 4 文字なので `addr` は 4..8(数え違いを test 側でやらないよう indexOf で採る)
    const text = '見出し addr';
    const r = abbrBeforeCaret(text, text.length, items);
    expect(r?.item.abbr).toBe('addr');
    expect(r?.start).toBe(text.indexOf('addr'));
  });

  /**
   * 🔴 **両方が同時に当たる場面**で見る(2026-08-25、変異試験 T5 が SURVIVED で教えた)。
   * ⚠ 1 稿目は `ad` と `addr` で見ていたが、`addr` の caret では `ad` は
   *   `dr` を見に行くので**当たらない** ── つまり「長いほうを採る」枝を
   *   **1 度も通っていなかった**(CLAUDE.md §2)。
   * 🔑 短いほうの直前が英数字でない形(日本語)にすると、両方が当たる。
   */
  it('🔴 長いほうを採る(両方が当たる場面で)', () => {
    const both = [item('住所'), item('の住所')];
    expect(abbrBeforeCaret('の住所', 3, both)?.item.abbr).toBe('の住所');
    // ⚠ 対照群 ── 短いほうしか当たらない場面では、短いほうが出る
    expect(abbrBeforeCaret('あ住所', 3, both)?.item.abbr).toBe('住所');
  });

  it('🔴 語の途中では出さない(myaddr の尻に当たらない)', () => {
    expect(abbrBeforeCaret('myaddr', 6, items)).toBe(null);
  });

  it('⚠ 日本語の手前では出る(直前が英数字でなければ語境界とみなす)', () => {
    expect(abbrBeforeCaret('あ住所', 3, items)?.item.abbr).toBe('住所');
  });

  it('区切りの後ろなら出る', () => {
    expect(abbrBeforeCaret('- addr', 6, items)?.item.abbr).toBe('addr');
    expect(abbrBeforeCaret('addr', 4, items)?.item.abbr).toBe('addr');
  });

  it('🔴 カーソルの手前で終わっていなければ出ない(途中では発火しない)', () => {
    expect(abbrBeforeCaret('addr の後ろ', 4 + 4, items)).toBe(null);
  });

  it('短縮語を持たない行は当たらない', () => {
    expect(abbrBeforeCaret('', 0, [item('')])).toBe(null);
  });
});

describe('`/` の絞り込み', () => {
  const items = [item('addr', '住所'), item('sig', '署名')];

  it('題名でも短縮語でも当たる(覚えているほうで探せる)', () => {
    expect(filterSnippets(items, '住').map((s) => s.abbr)).toEqual(['addr']);
    expect(filterSnippets(items, 'sig').map((s) => s.title)).toEqual(['署名']);
  });

  it('大文字小文字を無視する', () => {
    expect(filterSnippets(items, 'ADDR')).toHaveLength(1);
  });

  it('空なら全部(押した直後に何も出ない、を作らない)', () => {
    expect(filterSnippets(items, '  ')).toHaveLength(2);
  });
});

/**
 * 🔴 **アーキタイプが registry に届いている**(届かないと text へ落ちて、
 * 雛形として作っても普通のノートになる)。
 */
describe('雛形アーキタイプ', () => {
  it('registry が snippet を返す', () => {
    expect(getFlavor(SNIPPET_ARCHETYPE).archetype).toBe(SNIPPET_ARCHETYPE);
  });

  it('🔴 抽出列を 1 つも書かない(予定の面に湧かない)', () => {
    const got = getFlavor(SNIPPET_ARCHETYPE).extract('---\ndate: 2026-08-25\n---\n本文');
    expect(got).toEqual({ status: null, date: null, archived: false });
  });

  it('⚠ 対照群 ── 普通のノートは date を写す(上が「常に null」で通らないように)', () => {
    expect(getFlavor('text').extract('---\ndate: 2026-08-25\n---\n本文').date).toBe('2026-08-25');
  });

  it('seed は短縮語の欄が空で、記法の例が入っている', () => {
    const seed = seedBodyFor(SNIPPET_ARCHETYPE);
    expect(seed).toContain(`${SNIPPET_ABBR_KEY}: \n`);
    expect(seed).toContain('${date}');
    // 🔑 seed 自身が表として読める(短縮語が空なので、作った端から衝突しない)
    expect(snippetItemOf('l1', 't', seed)?.abbr).toBe('');
  });
});
