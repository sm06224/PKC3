/**
 * 🔴 **章を指す参照 `entry:<lid>#h/<見出しの id>`**(#579。user 裁定 2026-09-04)。
 *
 * ## 直す前
 *
 * `entry:` の見出しの形は textlog 前提(`#log/<id>/<slug>`、slug は ASCII だけ)で、
 * 本文の見出し(描画が刻む id は日本語を含む)を指す綴りが無かった。裸の `#token` は
 * legacy(ASCII のみ)。だから「この章へ飛ぶリンク」は**書けなかった**。
 *
 * ## 守る主張
 *
 * 1. 🔴 **往復する** ── `formatEntryRef` が書いた物を `parseEntryRef` が同じ id で読む(日本語も)
 * 2. 🔴 **URL の形(percent-encode)でも読める** ── markdown-it が href を正規化するので、
 *    本文に `#h/見出し` と書いても DOM には `#h/%E8%A6%8B…` が載る
 * 3. 🔴 **`#log/` と衝突しない / 旧い `#token` は legacy のまま**(取り込んだ本文を壊さない)
 * 4. 断る形(空 / `/` や空白を含む)は `invalid`
 */
import { describe, expect, it } from 'vitest';
import { formatEntryRef, parseEntryRef, parseSectionFragment } from '../../src/features/entry-ref/entry-ref';
import { formatSectionLink } from '../../src/features/entry-ref/entry-ref-format';
import { makeSlugCounter } from '../../src/features/markdown/markdown-toc';

describe('章を指す参照(#579)', () => {
  it('🔴 `entry:<lid>#h/<id>` を section として読む(日本語の id も)', () => {
    expect(parseEntryRef('entry:abc#h/見出し')).toEqual({ kind: 'section', lid: 'abc', id: '見出し' });
    expect(parseEntryRef('entry:abc#h/heading-1')).toEqual({ kind: 'section', lid: 'abc', id: 'heading-1' });
  });

  it('🔴 URL の形(percent-encode)でも同じ id に解ける', () => {
    expect(parseEntryRef('entry:abc#h/%E8%A6%8B%E5%87%BA%E3%81%97')).toEqual({
      kind: 'section',
      lid: 'abc',
      id: '見出し',
    });
  });

  it('🔴 往復する ── 書いた物を読むと同じ id(描画が刻む id の形で)', () => {
    const slug = makeSlugCounter();
    for (const text of ['第 1 章', '買い出し', 'Heading Two', '第 1 章']) {
      const id = slug(text);
      const written = formatEntryRef({ kind: 'section', lid: 'L-1', id });
      expect(parseEntryRef(written), `${text} → ${id} が往復しない`).toEqual({
        kind: 'section',
        lid: 'L-1',
        id,
      });
      // ⚠ URL に載った形(encode)からも同じ id へ戻る
      expect(parseEntryRef(`entry:L-1#h/${encodeURIComponent(id)}`)).toEqual({
        kind: 'section',
        lid: 'L-1',
        id,
      });
    }
    // 空振り防止 ── 同名 2 つ目は `-1` が付く(連番も往復の対象に入っている)
    expect(slug('第 1 章')).toBe('第-1-章-2');
  });

  it('🔑 書く形は生の id(本文で読める)── URL で化けるのは読む側が吸収する', () => {
    expect(formatEntryRef({ kind: 'section', lid: 'abc', id: '見出し' })).toBe('entry:abc#h/見出し');
  });

  /**
   * 🔴 **既に在る形を壊さない**(user 裁定 2026-08-07「記法を減らすことは動線を減らすこと」)。
   */
  it('🔴 `#log/` の形はこれまでどおり(衝突しない)', () => {
    expect(parseEntryRef('entry:abc#log/01H').kind).toBe('log');
    expect(parseEntryRef('entry:abc#log/01H/my-slug')).toEqual({
      kind: 'heading',
      lid: 'abc',
      logId: '01H',
      slug: 'my-slug',
    });
    expect(parseEntryRef('entry:abc#day/2026-08-08').kind).toBe('day');
  });

  it('🔴 裸の `#token` は legacy のまま(`h` 1 文字も legacy ── `h/` が付いて初めて section)', () => {
    expect(parseEntryRef('entry:c-log#2026-07-01-090000')).toEqual({
      kind: 'legacy',
      lid: 'c-log',
      logId: '2026-07-01-090000',
    });
    expect(parseEntryRef('entry:abc#h')).toEqual({ kind: 'legacy', lid: 'abc', logId: 'h' });
  });

  it('⚠ 断る形 ── 空 / `/` や空白を含む id', () => {
    for (const raw of ['entry:abc#h/', 'entry:abc#h/a/b', 'entry:abc#h/a b', 'entry:abc#h/%20']) {
      expect(parseEntryRef(raw).kind, `${raw} を受理した`).toBe('invalid');
    }
  });

  it('断片だけの形(`#h/…` + currentLid)も同じ 1 本で解ける', () => {
    expect(parseEntryRef('#h/見出し', { currentLid: 'abc' })).toEqual({
      kind: 'section',
      lid: 'abc',
      id: '見出し',
    });
  });

  it('parseSectionFragment は `#` 付きでも付かなくても同じ答え(link-target が使う形)', () => {
    expect(parseSectionFragment('#h/見出し')).toBe('見出し');
    expect(parseSectionFragment('h/見出し')).toBe('見出し');
    expect(parseSectionFragment('#log/01H')).toBeNull();
    expect(parseSectionFragment('')).toBeNull();
    // 読めない % の並びは、手で書いた字としてそのまま受ける(捨てない)
    expect(parseSectionFragment('#h/100%')).toBe('100%');
  });

  /**
   * 🔴 **本文へ貼れる 1 行**(`formatSectionLink`)── 読み手が同じ物を読み戻せる。
   */
  it('🔴 貼れる 1 行になり、読み手が lid と id をそのまま読める', () => {
    const line = formatSectionLink('議事録 / 決定事項', 'L-42', '決定事項');
    expect(line).toBe('[議事録 / 決定事項](entry:L-42#h/決定事項)');
    const target = /\(([^)]*)\)/.exec(line)?.[1] ?? '';
    expect(parseEntryRef(target)).toEqual({ kind: 'section', lid: 'L-42', id: '決定事項' });
    // ⚠ リンクを殺す字は escape される(`]` 1 個でリンクが死ぬ)
    expect(formatSectionLink('会議 [第 2 回]', 'x', 'a')).toBe('[会議 \\[第 2 回\\]](entry:x#h/a)');
  });
});
