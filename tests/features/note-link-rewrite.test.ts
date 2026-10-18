/** @vitest-environment node */
/**
 * Markdown でまとめて書き出すときの、ノート同士のリンクの書き換え(#1163 依頼 116-3 = A)と、
 * `:::if{format=…}` の値の読み方(依頼 282 = A)。
 *
 * 守る主張:
 * - 書き出すノートへのリンクは、そのファイル名(日本語・空白は %xx)を指す。章への飛び先は落ちる
 * - 書き出さないノートへのリンクは、リンクの字だけになる(コード・fence の中は触らない)
 * - 埋め込み `![](entry:…)` と、定義行・HTML は「字にしない」(数えて言うだけ)
 */
import { describe, expect, it } from 'vitest';
import { fileNameToLinkDest, rewriteNoteLinks } from '../../src/features/export/note-link-rewrite';
import { ifFormatList, ifFormatMatches, ifFormatOf } from '../../src/features/markdown/if-format';

const files: Record<string, string> = { a: 'ノート A.md', b: 'b.md' };
const fileOf = (lid: string): string | undefined => files[lid];

describe('rewriteNoteLinks', () => {
  it('🔴 書き出すノートへのリンクは、ファイル名を指す(空白・日本語は %xx、章への飛び先は落ちる)', () => {
    const r = rewriteNoteLinks('[A](entry:a) と [章](entry:b#h/見出し)', fileOf);
    expect(r.text).toBe(`[A](${encodeURI('ノート A.md')}) と [章](b.md)`);
    expect(r.text).toContain('%E3%83%8E');
    expect(r).toMatchObject({ toFile: 2, toText: 0, untouched: 0 });
  });

  it('🔴 括弧を含むファイル名でもリンクが閉じる', () => {
    expect(fileNameToLinkDest('a(1).md')).toBe('a%281%29.md');
  });

  it('🔴 書き出さないノートへのリンクは字だけ(対照: 書き出すノートは字にならない)', () => {
    const r = rewriteNoteLinks('見て [無いノート](entry:zzz) と [有る](entry:b) を', fileOf);
    expect(r.text).toBe('見て 無いノート と [有る](b.md) を');
    expect(r).toMatchObject({ toFile: 1, toText: 1 });
  });

  it('🔴 埋め込みは触らない(数える)/ コードと fence の中は触らない', () => {
    const src = ['![図](entry:a)', '`[x](entry:b)`', '```', '[y](entry:b)', '```', ''].join('\n');
    const r = rewriteNoteLinks(src, fileOf);
    expect(r.text).toBe(src);
    expect(r).toMatchObject({ toFile: 0, toText: 0, untouched: 1 });
  });

  it('🔴 参照形式の定義行・HTML の href は、書き出すノートなら宛先だけ差し替え、書き出さないノートは触らない', () => {
    const r = rewriteNoteLinks('[x][r]\n\n[r]: entry:b\n\n<a href="entry:a">A</a> <a href="entry:zzz">Z</a>', fileOf);
    expect(r.text).toContain('[r]: b.md');
    expect(r.text).toContain(`<a href="${encodeURI('ノート A.md')}">`);
    expect(r.text, '書き出さないノートの HTML は字にしない').toContain('<a href="entry:zzz">Z</a>');
    expect(r).toMatchObject({ toFile: 2, untouched: 1 });
  });

  it('対照: ノートへのリンクが無ければ 1 バイトも変えない', () => {
    const src = '[外](https://example.com) [添付](asset:ast-1)';
    expect(rewriteNoteLinks(src, fileOf)).toEqual({ text: src, toFile: 0, toText: 0, untouched: 0 });
  });
});

describe('ifFormat の読み方(依頼 282)', () => {
  it('値の取り出し: 引用符つきなら空白を入れてよい', () => {
    expect(ifFormatOf('format=docx,html')).toBe('docx,html');
    expect(ifFormatOf('format="docx, html"')).toBe('docx, html');
    expect(ifFormatOf('.hl')).toBeUndefined();
  });
  it('一覧: 小文字にして pdf は html に寄せる', () => {
    expect(ifFormatList('DOCX, PDF')).toEqual(['docx', 'html']);
    expect(ifFormatList(' , ')).toEqual([]);
  });
  it('🔴 当たり方: 書いていない / 空はいつも出る。書いたら一覧に当たったときだけ', () => {
    expect(ifFormatMatches(undefined, 'docx')).toBe(true);
    expect(ifFormatMatches('', 'docx')).toBe(true);
    expect(ifFormatMatches('pptx', 'docx')).toBe(false);
    expect(ifFormatMatches('docx,pptx', 'PPTX')).toBe(true);
    expect(ifFormatMatches('pdf', 'html')).toBe(true);
    expect(ifFormatMatches('pdf', 'docx')).toBe(false);
  });
});
