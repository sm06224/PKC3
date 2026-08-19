/**
 * 🔴 **チェックの印を押せる形で出す**(#277。user 指示 2026-08-19
 * 「チェックリストを含む場合の自動生成で…復活させるのです」)。
 *
 * 守る主張:
 * 1. 🔴 **既定は押せない** ── 受け手の居ない面(書き出し / Viewer / 印刷)で
 *    押せると、本文が変わらないので「チェックしたのに消えた」になる
 * 2. 🔴 **行番号は原文のもの** ── 前処理で行がずれるので LineMap で逆引きする
 *    (ずれたまま焼くと**別の行を書き換える**)
 * 3. fence の中の `- [ ]` は拾わない(markdown としてチェック項目ではない)
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const lines = (html: string): string[] =>
  [...html.matchAll(/data-pkc-task-line="(\d+)"/g)].map((m) => m[1]!);

describe('チェックの印の出し方(#277)', () => {
  const DOC = '# 題\n\n- [ ] あ\n- [x] い\n';

  /**
   * 🔴 **既定は押せない形**(P8 段⑳ の判断は生きている)。
   * ⚠ ここが緩むと、書き出した HTML でチェックが付くのに**どこにも保存されない**。
   */
  it('🔴 既定は disabled のまま(受け手が居ない面で押せない)', () => {
    const html = renderMarkdown(DOC);
    expect(html, '既定で押せる形になっている').toContain('disabled');
    expect(html, '受け手の居ない面に押す口が出ている').not.toContain('data-pkc-action="toggle-task"');
    expect(lines(html), '受け手が居ないのに行番号を焼いている').toEqual([]);
  });

  it('🔴 頼んだときだけ押せる形になる', () => {
    const html = renderMarkdown(DOC, { interactiveTasks: true });
    expect(html, '頼んだのに押せないまま').toContain('data-pkc-action="toggle-task"');
    expect(html, '押せるのに disabled が残っている').not.toContain('disabled');
    expect(lines(html)).toEqual(['2', '3']);
  });

  /**
   * 🔴 **前処理で行がずれる**(CLAUDE.md「preprocessor の行挿入は LineMap で
   * 原文 index に逆引き」)。⚠ `:::` の囲いは空行を入れて正規化されるので、
   *   逆引きを外すと**下の行を書き換える**。
   */
  it('🔴 囲いの中でも、原文の行を指す(前処理のずれを逆引きする)', () => {
    const html = renderMarkdown(':::note\n- [ ] あ\n:::\n', { interactiveTasks: true });
    expect(lines(html), '前処理後の行番号がそのまま焼かれている').toEqual(['1']);
  });

  it('🔴 寄せ記号の下でも原文の行を指す', () => {
    const html = renderMarkdown('|> 右へ寄せた段落\n\n- [ ] あ\n', { interactiveTasks: true });
    expect(lines(html)).toEqual(['2']);
  });

  /** ⚠ fence の中はチェック項目ではない(markdown-it が list にしない)。 */
  it('fence の中の見かけ上のチェックは拾わない', () => {
    const html = renderMarkdown('```\n- [ ] にせもの\n```\n\n- [ ] ほんもの\n', {
      interactiveTasks: true,
    });
    expect(lines(html), 'コードの中まで押せるようにした').toEqual(['4']);
  });

  /** 番号つきリストでも押せる(記法を狭めない)。 */
  it('番号つきリストのチェックも押せる', () => {
    expect(lines(renderMarkdown('1. [ ] あ\n', { interactiveTasks: true }))).toEqual(['0']);
  });
});
