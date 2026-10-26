import { describe, expect, it } from 'vitest';
import { caretBlockAt } from '../../src/features/markdown/caret-hint';

describe('caretBlockAt(#1451)', () => {
  const doc = '---\na: 1\n---\n本文\n```js\ncode\n```\n$$\nx\n$$\n| a | b |\n';
  const kind = (s: string, d = 0): string | null => caretBlockAt(doc, doc.indexOf(s) + d).block;
  it('各記法を引き分ける', () => {
    expect(kind('a: 1')).toBe('frontmatter');
    expect(kind('本文')).toBeNull();
    expect(kind('code')).toBe('code');
    expect(kind('x\n$$')).toBe('math');
    expect(kind('| a')).toBe('table');
  });
  it('開きの柵の行は範囲が 1 点(控えを使い回させない)', () => {
    const at = doc.indexOf('```js');
    const r = caretBlockAt(doc, at + 5);
    expect(r.block).toBe('code');
    expect(r.from).toBe(r.to);
  });
  it('印が無い本文は null', () => {
    expect(caretBlockAt('普通の文', 2).block).toBeNull();
  });
});
