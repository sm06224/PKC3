/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

function mark(src: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(src, { currentContainerId: 'c1' } as never);
  return el;
}

describe('==…== の中の先頭の [..] は、リンクなら色として読まない', () => {
  it('==[docs](entry:n1)== はハイライトの中のリンクになる(色にならない)', () => {
    const el = mark('==[docs](entry:n1)==');
    const m = el.querySelector('mark')!;
    expect(m).not.toBeNull();
    expect(m.getAttribute('style')).toBeNull();
    expect(m.textContent).toContain('docs');
    expect(m.textContent).not.toContain('entry:n1');
    expect(m.querySelector('a')).not.toBeNull();
  });
  it('==[Home](https://x.com)== も同じ', () => {
    const m = mark('==[Home](https://x.com)==').querySelector('mark')!;
    expect(m.getAttribute('style')).toBeNull();
    expect(m.querySelector('a')?.getAttribute('href')).toBe('https://x.com');
  });
  it('参照形 [a][r] と [a]: も色にしない', () => {
    expect(mark('==[a][r]==').querySelector('mark')!.getAttribute('style')).toBeNull();
    expect(mark('==[a]:b==').querySelector('mark')!.getAttribute('style')).toBeNull();
  });
  it('対照群: ==[red]text== は従来どおり色になる', () => {
    const m = mark('==[red]text==').querySelector('mark')!;
    expect(m.getAttribute('style')).toContain('background-color: red');
    expect(m.textContent).toBe('text');
  });
});
