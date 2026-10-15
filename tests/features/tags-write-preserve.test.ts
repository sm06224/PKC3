/** @vitest-environment node */
/**
 * 🔴 **タグの付け外しで、読めないタグを消さない / BOM つきの本文に 2 つ目の囲みを前置しない**(#1087)。
 *
 * `readTags` は長すぎる名前(`MAX_TAG_CHARS` 超)と上限(`MAX_TAGS`)を越えた分を読まない ── 読めないだけで本文には書いてある。
 * タグを 1 つ足す・外すときに `tags:` を読めた分だけで作り直すと、触っていない名前が黙って消えていた。
 */
import { describe, expect, it } from 'vitest';
import { applyTagsToBody, applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { MAX_TAG_CHARS, MAX_TAGS, readTags } from '../../src/features/flavor/tags';
import { parseFrontmatter, spliceFrontmatterKeys } from '../../src/features/markdown/frontmatter';

const LONG = 'あ'.repeat(MAX_TAG_CHARS + 1);
const rawTags = (body: string): unknown => parseFrontmatter(body).meta.tags;

describe('読めないタグを書き戻しで消さない', () => {
  it('🔴 長すぎる名前は、別のタグを外しても残る(元の位置のまま)', () => {
    const body = `---\ntags: ["${LONG}", a, b]\n---\n本文`;
    expect(readTags(body), '台の前提: 長い名前は読まれない').toEqual(['a', 'b']);
    const out = applyTagsToBody(body, ['a'], 'remove').body!;
    expect(rawTags(out)).toEqual([LONG, 'b']);
  });

  it('🔴 長すぎる名前があっても、足したタグは末尾に付く', () => {
    const body = `---\ntags: [a, "${LONG}"]\n---\n`;
    const out = applyTagsToBody(body, ['c'], 'add').body!;
    expect(rawTags(out)).toEqual(['a', LONG, 'c']);
  });

  it('🔴 読めた名前を全部外しても、長い名前だけは残る(鍵ごと消さない)', () => {
    const body = `---\ntags: ["${LONG}", a]\n---\n`;
    const out = applyTagsToBody(body, ['a'], 'remove').body!;
    expect(rawTags(out)).toEqual([LONG]);
  });

  it('🔴 上限(32)を越えた分も、別のタグを外したとき残る', () => {
    const names = Array.from({ length: MAX_TAGS + 3 }, (_, i) => `t${i}`);
    const body = `---\ntags: [${names.join(', ')}]\n---\n`;
    expect(readTags(body), '台の前提: 上限を越えた分は読まれない').toHaveLength(MAX_TAGS);
    const out = applyTagsToBody(body, ['t0'], 'remove').body!;
    expect(rawTags(out)).toEqual(names.slice(1));
  });

  it('文字列の形(カンマ区切り)でも長い名前を残す', () => {
    const body = `---\ntags: ${LONG}, a, b\n---\n`;
    const out = applyTagsToBody(body, ['b'], 'remove').body!;
    expect(rawTags(out)).toEqual([LONG, 'a']);
  });

  it('対照群: 長い名前が無いなら、読めた分だけで作る(空なら鍵ごと消す)', () => {
    const body = '---\ntags: [a]\n---\n本文';
    const out = applyTagsToBody(body, ['a'], 'remove').body!;
    expect(parseFrontmatter(out).meta.tags).toBeUndefined();
  });

  it('`applyBodyRewrite`(tag)も同じ道を通る', () => {
    const body = `---\ntags: ["${LONG}", a]\n---\n`;
    const out = applyBodyRewrite(body, { kind: 'tag', tags: ['a'], mode: 'remove' } as never)!;
    expect(rawTags(out)).toEqual([LONG]);
  });
});

describe('BOM つきの本文(#1087)', () => {
  const BOM = '\uFEFF';

  it('🔴 BOM の後ろの囲みを frontmatter として読む', () => {
    const body = `${BOM}---\ntags: [a]\n---\n本文`;
    expect(readTags(body)).toEqual(['a']);
  });

  it('🔴 タグを足しても 2 つ目の囲みを前置せず、BOM は先頭のまま', () => {
    const body = `${BOM}---\ntags: [a]\n---\n本文`;
    const out = applyTagsToBody(body, ['b'], 'add').body!;
    expect(out).toBe(`${BOM}---\ntags: [a, b]\n---\n本文`);
  });

  it('囲みの無い BOM つきの本文へ前置するときも、BOM は先頭のまま', () => {
    const out = spliceFrontmatterKeys(`${BOM}本文`, { tags: ['a'] });
    expect(out).toBe(`${BOM}---\ntags: [a]\n---\n本文`);
  });

  it('最後の鍵を外して囲みを畳んでも BOM は残る', () => {
    const out = applyTagsToBody(`${BOM}---\ntags: [a]\n---\n本文`, ['a'], 'remove').body!;
    expect(out).toBe(`${BOM}本文`);
  });
});
