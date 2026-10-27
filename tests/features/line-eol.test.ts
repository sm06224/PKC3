/** #1384: 改行コード判定を 1 か所へ集めた。各書き換え口が CRLF 本文で「足した行」を CRLF にする。 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectEol } from '../../src/features/markdown/line-eol';
import { detectEol as viaTextOps } from '../../src/features/markdown/text-ops';
import { renumberLists } from '../../src/features/markdown/list-renumber';

describe('detectEol', () => {
  it('CRLF が 1 つでも在れば CRLF、無ければ LF(空文字も LF)', () => {
    expect(detectEol('a\r\nb')).toBe('\r\n');
    expect(detectEol('a\nb\r\nc')).toBe('\r\n');
    expect(detectEol('a\nb')).toBe('\n');
    expect(detectEol('')).toBe('\n');
  });

  it('text-ops からも同じ関数が使える', () => {
    expect(viaTextOps).toBe(detectEol);
  });

  it('番号の振り直しは CRLF 本文の改行を保つ(経路が実際に判定を通る)', () => {
    const out = renumberLists('1. a\r\n1. b\r\n1. c', 'sequential');
    expect(out).toBe('1. a\r\n2. b\r\n3. c');
  });
});

describe('判定の重複が戻っていない', () => {
  const files = [
    'markdown/form-table.ts',
    'markdown/code-fence-edit.ts',
    'markdown/frontmatter.ts',
    'markdown/source-blocks.ts',
    'markdown/append-target.ts',
    'markdown/list-renumber.ts',
    'markdown/body-rewrite.ts',
    'export/section-flatten.ts',
  ];
  it.each(files)('%s は detectEol を使い、自前の判定を持たない', (f) => {
    const src = readFileSync(`src/features/${f}`, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).toContain('detectEol(');
    expect(src).not.toMatch(/includes\('\\r\\n'\)/);
  });
});
