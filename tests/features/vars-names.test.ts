/** @vitest-environment happy-dom */
/**
 * 差し込み `{{vars.名前}}` の名前の字(R2)。
 *
 * 守る主張:
 * 1. 🔴 日本語の名前で書いた `vars:` が、`{{vars.名前}}` で展開される(何も起きない、を無くす)
 * 2. 🔴 定義(`vars:` の子 / `vars.名前:`)・本文の展開・目次の展開が**同じ名前の規則 1 本**を使う
 *    (どれかが ASCII のままだと、日本語の名前は定義できるのに展開されない / 逆になる)
 * 3. 既存の書き方(ASCII / バッククォートの中も展開 / ``` の中は展開しない / `\{{…}}` で字のまま /
 *    未定義の印)は変わらない
 * 4. 数字で始まる名前の行で `vars:` の読みが黙って止まらない
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  VAR_NAME_SOURCE,
  extractVars,
} from '../../src/features/markdown/frontmatter';
import { extractHeadingsFromMarkdown } from '../../src/features/markdown/markdown-toc';

const render = (src: string): string => renderMarkdown(src, { vars: extractVars(src) } as never);
const nested = (name: string, value: string): string => `---\nvars:\n  ${name}: ${value}\n---\n`;

describe('差し込みの名前(日本語を含む)', () => {
  it('🔴 日本語の名前: 入れ子でも 1 行(vars.名前:)でも、本文で値に置き換わる', () => {
    const a = `${nested('名前', '山田')}担当は{{vars.名前}}です`;
    expect(extractVars(a)).toEqual({ 名前: '山田' });
    expect(render(a)).toContain('担当は山田です');
    const b = '---\nvars.案件: ALPHA-7\n---\n{{vars.案件}}';
    expect(extractVars(b)).toEqual({ 案件: 'ALPHA-7' });
    expect(render(b)).toContain('<p>ALPHA-7</p>');
    // 前後の空白は入れてよい
    expect(render(`${nested('名前', '山田')}{{ vars.名前 }}`)).toContain('<p>山田</p>');
  });

  it('🔴 定義の字と展開の字が食い違わない(同じ名前を全部通す / 通さない名前は両方で通さない)', () => {
    const accepted = ['名前', '案件_1', 'ABC-d', '_x', 'カタカナー', '1番', 'ｆｕｌｌ'];
    for (const n of accepted) {
      const src = `${nested(n, 'V')}[{{vars.${n}}}]`;
      expect(extractVars(src), `定義できない: ${n}`).toEqual({ [n]: 'V' });
      expect(render(src), `展開されない: ${n}`).toContain('<p>[V]</p>');
    }
    // 名前にならない字(空白・点・括弧)。定義に拾われず、展開もされない
    for (const n of ['a b', 'a.b', 'a(b)']) {
      expect(new RegExp(`^${VAR_NAME_SOURCE}$`, 'u').test(n), `名前として通った: ${n}`).toBe(false);
    }
    expect(render(`${nested('a', 'V')}{{vars.a.b}}`)).not.toContain('<p>V');
  });

  it('🔴 数字で始まる名前の行で、下の名前の読みが止まらない', () => {
    const src = '---\nvars:\n  1番: 太郎\n  次: 花子\n---\n{{vars.次}}';
    expect(extractVars(src)).toEqual({ '1番': '太郎', 次: '花子' });
    expect(render(src)).toContain('<p>花子</p>');
  });

  it('既存の書き方は変わらない: バッククォートの中は置き換わる / ``` の中は置き換わらない / \\{{…}} は字のまま', () => {
    const head = nested('名前', '山田');
    expect(render(`${head}\`{{vars.名前}}\``)).toContain('<code>山田</code>');
    expect(render(`${head}\`\`\`\n{{vars.名前}}\n\`\`\``)).toContain('{{vars.名前}}');
    expect(render(`${head}\`\`\`\n{{vars.名前}}\n\`\`\``)).not.toContain('山田</code>');
    const esc = render(`${head}\\{{vars.名前}} と {{vars.名前}}`);
    expect(esc).toContain('{{vars.名前}} と 山田');
  });

  it('未定義の名前は印で出る(名前つき。日本語でも)', () => {
    const html = render(`${nested('名前', '山田')}{{vars.無い}}`);
    expect(html).toContain('class="pkc-variable-undefined"');
    expect(html).toContain('title="未定義変数: vars.無い"');
    expect(html).toContain('>{{vars.無い}}<');
  });

  it('🔴 目次の見出しも同じ規則で展開する(日本語の名前)', () => {
    const src = `${nested('題', '総括')}# {{vars.題}}の話\n\n本文`;
    const heads = extractHeadingsFromMarkdown(src);
    expect(heads.map((h) => h.text)).toEqual(['総括の話']);
  });
});
