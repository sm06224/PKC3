/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { renderMarkdown, stripComments } from '../../src/features/markdown/markdown-render';
import { advanceFence } from '../../src/features/markdown/list-renumber';

/**
 * #1087 M9: 引用(`> ````)・リストの項目(`- ````)の中の fence も、最上位の fence と同じに
 * **1 バイトも触らない**。かつては最上位の fence しか見なかったので、中身の `%%…%%` `||` `__`
 * `_` `+++` が記法として食われた(`%%a%% b` → ` b`、`||x` の行が段落になって fence を壊す)。
 */
const TOKENS = ['%%a%% b', '||x', '|>x', '__x', '_', '+++', '%%%', ':::note', ':::', '{{vars.a}}', ':::comment', '==a=='];

const codeOf = (html: string): string => {
  const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
  return Array.from(doc.body.querySelectorAll('pre code')).map((c) => c.textContent ?? '').join('\n');
};

const WRAPS: Array<[string, (t: string) => string]> = [
  ['top', (t) => '```\n' + t + '\n```'],
  ['quote', (t) => '> ```\n> ' + t + '\n> ```'],
  ['quote2', (t) => '> > ```\n> > ' + t + '\n> > ```'],
  ['list', (t) => '- ```\n  ' + t + '\n  ```'],
  ['ordered', (t) => '1. ```\n   ' + t + '\n   ```'],
  ['quote+list', (t) => '> - ```\n>   ' + t + '\n>   ```'],
];

describe('入れ物の中の fence は素通し #1087 M9', () => {
  for (const [name, wrap] of WRAPS) {
    for (const t of TOKENS) {
      it(`${name}: ${JSON.stringify(t)} がコードのまま残る`, () => {
        const html = renderMarkdown(wrap(t));
        expect(codeOf(html)).toBe(t + '\n');
      });
    }
  }

  it('stripComments: 引用の fence の中の %% は 1 バイトも変わらない', () => {
    const s = '> ```\n> %%a%% b\n> ```';
    expect(stripComments(s).transformed).toBe(s);
  });

  it('対照: fence の外の引用の %%a%% は今までどおり消える', () => {
    expect(stripComments('> %%a%% b').transformed).toBe('>  b');
  });

  it('引用が終わったら fence も終わる(閉じ忘れが後ろを飲まない)', () => {
    const html = renderMarkdown('> ```\n> x\n\n%%a%% VISIBLE');
    expect(html).toContain('VISIBLE');
    expect(html).not.toContain('%%a%%');
  });

  it('fence の後ろの task は原文の行(index 3)を指したまま', () => {
    const html = renderMarkdown('> ```\n> ||x\n> ```\n- [ ] t', { interactiveTasks: true });
    expect([...html.matchAll(/data-pkc-task-line="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([3]);
  });

  it('字下げ(4 SP)のコード: 文書の頭 / 空行の後は素通し', () => {
    for (const t of ['__x', '%%a%% b', '||x', '+++', '_', '%%%']) {
      expect(codeOf(renderMarkdown('    ' + t)), 'head ' + t).toBe(t + '\n');
      expect(codeOf(renderMarkdown('para\n\n    ' + t)), 'after blank ' + t).toBe(t + '\n');
    }
    // 複数行(間の空行もコードの続き)
    expect(codeOf(renderMarkdown('    __a\n\n    %%b%% c'))).toBe('__a\n\n%%b%% c\n');
  });

  it('字下げのコードの後の task は原文の行を指したまま', () => {
    const html = renderMarkdown('para\n\n    %%%\n    x\n\n- [ ] t', { interactiveTasks: true });
    expect([...html.matchAll(/data-pkc-task-line="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([5]);
  });

  it('対照: 段落の続きの 4 SP・リストの項目の続きの 4 SP はコードではないので従来どおり', () => {
    // 空行なしの 4 SP は段落の続き(コードにならない)
    expect(stripComments('para\n    %%a%% b').transformed).toBe('para\n     b');
    // リストの項目の後の空行 + 4 SP は項目の中の段落(コードではない)
    expect(stripComments('- a\n\n    %%a%% b').transformed).toBe('- a\n\n     b');
    // 字下げのコードが終わったら通常に戻る
    expect(stripComments('    %%a%% b\n\n%%c%% d').transformed).toBe('    %%a%% b\n\n d');
  });

  it('advanceFence: 深さの違う行では閉じず、浅い行で畳む', () => {
    const open = advanceFence('', '> ```');
    expect(open).not.toBe('');
    expect(advanceFence(open, '> ```')).toBe('');
    expect(advanceFence(open, '> > ```')).toBe(open);
    expect(advanceFence(open, 'plain')).toBe('');
    // 最上位の fence の中の "> ```" は中身(閉じではない)
    expect(advanceFence('```', '> ```')).toBe('```');
  });
});
