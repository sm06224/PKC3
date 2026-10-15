/** @vitest-environment happy-dom */
/**
 * 日本語の隣の約物を含む強調(#1087)。
 *
 * 壊れ方: `彼は**「はい」**と答えた` / `日本語**（注）**です` / `*（注）*です` が、
 * `**` のまま画面に出ていた(CommonMark の強調の判定は、約物が区切りの内側にあり
 * 外側が文字だと閉じられない。日本語は語の間に空白を置かないので必ず当たる)。
 * 直し: `markdown-it-cjk-friendly`(日本語の字と隣り合うときだけ判定をゆるめる)。
 *
 * ⚠ ASCII だけの本文は、上流の判定のまま(対照群で pin する)。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

describe('日本語の隣の約物を含む強調', () => {
  it('彼は**「はい」**と答えた → strong になる', () => {
    const html = renderMarkdown('彼は**「はい」**と答えた');
    expect(html).toContain('<strong>「はい」</strong>');
    expect(html).not.toContain('**');
  });

  it('日本語**（注）**です → strong になる', () => {
    const html = renderMarkdown('日本語**（注）**です');
    expect(html).toContain('<strong>（注）</strong>');
    expect(html).not.toContain('**');
  });

  it('*（注）*です → em になる', () => {
    const html = renderMarkdown('*（注）*です');
    expect(html).toContain('<em>（注）</em>');
    expect(html).not.toContain('*');
  });

  it('対照: **強調**の は従来どおり strong', () => {
    expect(renderMarkdown('**強調**の')).toContain('<strong>強調</strong>の');
  });

  it('対照: 前後に空白のない日本語の語の中でも strong', () => {
    expect(renderMarkdown('これは**大事**です')).toContain('これは<strong>大事</strong>です');
  });

  it('対照(ASCII): a**b**c は strong(上流どおり)', () => {
    expect(renderMarkdown('a**b**c')).toContain('a<strong>b</strong>c');
  });

  it('対照(ASCII): a**"b"**c は上流どおり literal のまま(日本語が隣にないので緩めない)', () => {
    const html = renderMarkdown('a**"b"**c');
    expect(html).not.toContain('<strong>');
    expect(html).toContain('**');
  });

  it('対照(ASCII): foo*(x)*bar は上流どおり literal のまま', () => {
    const html = renderMarkdown('foo*(x)*bar');
    expect(html).not.toContain('<em>');
  });

  it('対照(ASCII): 空白で挟まれた ** は強調にならない', () => {
    const html = renderMarkdown('a ** b ** c');
    expect(html).not.toContain('<strong>');
  });
});
