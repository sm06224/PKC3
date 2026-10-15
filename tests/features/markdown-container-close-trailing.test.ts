/** @vitest-environment happy-dom */
/**
 * 囲み(`:::`)の閉じの**直後に、空行なしで本文が続く**形(#1087)。
 *
 * 壊れ方: 閉じの印だけの段落が次の行と同じ段落に合流し(`<p>印<br>後ろ</p>`)、
 * 囲みが閉じず、内部の印(`CLOSE`)が画面に出て、以降が全部囲みの中に入っていた。
 * 直し: 閉じの印の行の直後に空行を置く(`scanContainerDirective`)。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const KINDS: { name: string; open: string; close: string }[] = [
  { name: 'note', open: ':::note', close: '</section>' },
  { name: 'section{role=note}', open: ':::section{role=note}', close: '</section>' },
  { name: 'quote', open: ':::quote', close: '</blockquote>' },
  { name: 'details', open: ':::details', close: '</details>' },
  { name: 'format', open: ':::format{.a}', close: '</div>' },
  { name: 'red', open: ':::red', close: '</div>' },
];

/** 閉じタグの後ろ(= 囲みの外)。 */
function outside(html: string, closeTag: string): string {
  const i = html.lastIndexOf(closeTag);
  return i < 0 ? '' : html.slice(i + closeTag.length);
}

describe('囲みの閉じの直後に本文が続く', () => {
  for (const k of KINDS) {
    it(`${k.name}: 閉じて、後ろは囲みの外に出る`, () => {
      const html = renderMarkdown(`${k.open}\n中身\n:::\n後ろ\n`);
      expect(html).toContain(k.close);
      expect(html).not.toContain('CLOSE');
      expect(html).toContain('中身');
      expect(outside(html, k.close)).toContain('後ろ');
      expect(html.slice(0, html.lastIndexOf(k.close))).not.toContain('後ろ');
    });

    it(`${k.name}: 対照 ── 空行を挟んだ形と同じ出力`, () => {
      const tight = renderMarkdown(`${k.open}\n中身\n:::\n後ろ\n`);
      const loose = renderMarkdown(`${k.open}\n中身\n:::\n\n後ろ\n`);
      expect(tight).toBe(loose);
    });
  }

  it('入れ子: 外側の閉じの直後の本文も外に出る', () => {
    const html = renderMarkdown(':::quote\n:::note\n中\n:::\n:::\n後ろ\n');
    expect(html).not.toContain('CLOSE');
    expect(html.indexOf('</section>')).toBeGreaterThan(-1);
    expect(html.indexOf('</section>')).toBeLessThan(html.indexOf('</blockquote>'));
    expect(outside(html, '</blockquote>')).toContain('後ろ');
  });

  it('入れ子: 内側の閉じの直後の本文は外側の中に残る', () => {
    const html = renderMarkdown(':::quote\n:::note\n中\n:::\n内側の後\n:::\n外\n');
    expect(html).not.toContain('CLOSE');
    const inner = html.indexOf('内側の後');
    expect(inner).toBeGreaterThan(html.indexOf('</section>'));
    expect(inner).toBeLessThan(html.indexOf('</blockquote>'));
    expect(outside(html, '</blockquote>')).toContain('外');
  });

  it('行番号の逆引き: 閉じの後ろの行は原文の 4 行目(index 3)を指す', () => {
    const html = renderMarkdown(':::note\n中身\n:::\n後ろ\n', { sourceLineAnchors: true });
    const m = /<p[^>]*data-pkc-source-line="(\d+)"[^>]*>後ろ<\/p>/.exec(html);
    expect(m, html).not.toBeNull();
    expect(Number(m![1])).toBe(3);
  });
});
