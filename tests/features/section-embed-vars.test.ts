/** @vitest-environment happy-dom */
/**
 * 台帳 #1852 束 R1: 変数の値の改行(依頼 269)/ 章の埋め込みの中の変数は元のノートの値で出る(依頼 268)。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { expandDefinedVars, expandVarsInText } from '../../src/features/markdown/var-expand';
import { sectionExcerptOf } from '../../src/features/markdown/section-embed';

function taskLines(html: string): number[] {
  const el = document.createElement('div');
  el.innerHTML = html;
  return [...el.querySelectorAll('[data-pkc-task-line]')].map((c) => Number(c.getAttribute('data-pkc-task-line')));
}

describe('依頼 269: 変数の値の改行は空白 1 つ', () => {
  it('expandVarsInText: 改行入りの値は 1 行で出る(行数が変わらない)', () => {
    const out = expandVarsInText('値: {{vars.x}}\n- [ ] a', { x: '1 行目\n2 行目' });
    expect(out).toBe('値: 1 行目 2 行目\n- [ ] a');
    expect(expandVarsInText('{{vars.x}}', { x: 'a\r\nb\rc' })).toBe('a b c');
  });

  it('その下のチェックの行番号がずれない(押した項目に印が付く)', () => {
    const src = '{{vars.x}}\n\n- [ ] a\n- [ ] b';
    const html = renderMarkdown(src, { vars: { x: '1 行目\n2 行目' }, interactiveTasks: true } as never);
    // 原文の 2 行目(0 起点)と 3 行目 ── 値が 2 行に増えていれば 3 と 4 になる
    expect(taskLines(html)).toEqual([2, 3]);
  });

  it('対照群: 改行の無い値でも同じ行番号', () => {
    const html = renderMarkdown('{{vars.x}}\n\n- [ ] a\n- [ ] b', { vars: { x: '1 行' }, interactiveTasks: true } as never);
    expect(taskLines(html)).toEqual([2, 3]);
  });

  it('表の中でも改行は空白、`|` は逃がす(今までどおり)', () => {
    expect(expandVarsInText('| {{vars.x}} |', { x: 'a|b\nc' })).toBe('| a\\|b c |');
  });
});

describe('依頼 268: 章の中の変数は元のノートの前書きの値で出す', () => {
  const SRC = ['---', 'vars:', '  案件: ALPHA-7', '---', '# 第一章', '案件は {{vars.案件}}、未定義は {{vars.nope}}、字のまま \\{{vars.案件}}', '', '# 第二章', '別'].join('\n');

  it('expandDefinedVars: 定義の在る名前だけ展開し、未定義と逃がしは 1 字も変えない', () => {
    const out = expandDefinedVars('{{vars.a}} {{vars.b}} \\{{vars.a}}', { a: 'A' });
    expect(out).toBe('A {{vars.b}} \\{{vars.a}}');
  });

  it('expandDefinedVars: コードの囲みの中は触らない', () => {
    expect(expandDefinedVars('```\n{{vars.a}}\n```\n{{vars.a}}', { a: 'A' })).toBe('```\n{{vars.a}}\n```\nA');
  });

  it('章の切り出し: 元のノートの値で出る / 未定義と逃がしはそのまま', () => {
    const r = sectionExcerptOf(SRC, '第一章');
    expect(r.missing).toBeUndefined();
    expect(r.text).toBe('# 第一章\n案件は ALPHA-7、未定義は {{vars.nope}}、字のまま \\{{vars.案件}}');
  });

  it('埋め込んだ側に前書きが無くても、章の字は「名前が無い変数」にならない(定義の在る名前)', () => {
    const r = sectionExcerptOf(SRC, '第一章');
    // 埋め込み先の描画は変数を渡さない
    const html = renderMarkdown(r.text);
    expect(html).toContain('案件は ALPHA-7');
    // 未定義の名前だけが、点線の「名前が無い変数」として出る
    expect(html.match(/pkc-variable-undefined/g)).toHaveLength(1);
    expect(html).toContain('{{vars.案件}}');
  });

  it('対照群: 前書きに変数の無いノートの章は今までどおり', () => {
    const r = sectionExcerptOf('# A\n{{vars.x}}', 'a');
    expect(r.text).toBe('# A\n{{vars.x}}');
  });
});
