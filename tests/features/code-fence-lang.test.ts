import { describe, expect, it } from 'vitest';
import { closeCodeFence, codeFenceLang, setCodeFenceLang } from '../../src/features/markdown/code-fence-lang';

describe('code-fence-lang(コードブロックの言語・閉じ)', () => {
  it('開きの行の言語を読む(情報の最初の語。無ければ空。開きでなければ null)', () => {
    expect(codeFenceLang('```js\nx\n```')).toBe('js');
    expect(codeFenceLang('```\nx\n```')).toBe('');
    expect(codeFenceLang('~~~python title="a"\nx\n~~~')).toBe('python');
    expect(codeFenceLang('段落')).toBeNull();
    expect(codeFenceLang('```inline``` です')).toBeNull();
  });

  it('言語だけを差し替え、2 語目以降・柵の種類・本文は残す', () => {
    expect(setCodeFenceLang('```js\nx\n```', 'ts')).toBe('```ts\nx\n```');
    expect(setCodeFenceLang('```js a=1\nx\n```', 'ts')).toBe('```ts a=1\nx\n```');
    expect(setCodeFenceLang('~~~\nx\n~~~', 'sql')).toBe('~~~sql\nx\n~~~');
    expect(setCodeFenceLang('```js', '3d')).toBe('```3d');
    expect(setCodeFenceLang('```js\nx\n```', '')).toBe('```\nx\n```');
    expect(setCodeFenceLang('段落', 'ts')).toBeNull();
  });

  it('閉じていない囲みだけ閉じを足す', () => {
    expect(closeCodeFence('```js\nx')).toBe('```js\nx\n```');
    expect(closeCodeFence('```js\nx\n```')).toBe('```js\nx\n```');
    expect(closeCodeFence('~~~~\nx\n~~~')).toBe('~~~~\nx\n~~~\n~~~~');
    expect(closeCodeFence('段落')).toBe('段落');
  });
});
