/**
 * テンプレートの挿入まわりの不具合 6 件(T1〜T5・T7)の回帰。
 * ⚠ どれも「直す前の実装に戻すと落ちる」形で書く(戻して確認済み)。
 */
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { fillSnippetVars, insertSnippet } from '../../src/features/snippet/snippet-expand';
import { snippetItemOf } from '../../src/features/snippet/snippet-table';
import { snippetMenuNote } from '../../src/features/snippet/snippet-menu';
import { expandVarsInText } from '../../src/features/markdown/var-expand';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { endsInsideOpenBlock } from '../../src/features/markdown/place-notation';

const NOW = new Date(2026, 9, 17, 9, 5, 0);
const at = (text: string, i = text.length) => ({ text, start: i, end: i });

describe('T1 複数行のテンプレートは行の途中なら改行して挿す(一覧から選ぶ経路だけ)', () => {
  it('行の途中: 前に改行が入り、見出しが前の字に貼り付かない', () => {
    const r = insertSnippet(at('買い物リスト'), '## 議事録\n本文', NOW, { breakLines: true });
    expect(r.text).toBe('買い物リスト\n## 議事録\n本文');
    expect(r.start).toBe(r.text.length); // 挿した後ろ
  });
  it('行の途中: 後ろに字が続くなら後ろにも改行', () => {
    const r = insertSnippet(at('ab', 1), '| a | b |\n|---|---|', NOW, { breakLines: true });
    expect(r.text).toBe('a\n| a | b |\n|---|---|\nb');
  });
  it('選択(${宛名})の位置も改行の分だけずれる', () => {
    const r = insertSnippet(at('x'), '# ${題}\n本文', NOW, { breakLines: true });
    expect(r.text).toBe('x\n# ${題}\n本文');
    expect(r.text.slice(r.start, r.end)).toBe('${題}');
  });
  it('行頭・1 行だけのテンプレート・短縮語の経路(指定なし)は今までどおり', () => {
    expect(insertSnippet(at(''), '## a\nb', NOW, { breakLines: true }).text).toBe('## a\nb');
    expect(insertSnippet(at('x'), 'one', NOW, { breakLines: true }).text).toBe('xone');
    expect(insertSnippet(at('x'), 'one\n', NOW, { breakLines: true }).text).toBe('xone\n');
    expect(insertSnippet(at('abc'), '## a\nb', NOW).text).toBe('abc## a\nb');
  });
});

describe('T2 コードの中の印は最初の選択にしない', () => {
  it('囲みの中の ${HOME} より ${cursor} が勝つ', () => {
    const r = insertSnippet(at('abc'), '```sh\necho ${HOME}\n```\nメモ ${cursor}', NOW);
    expect(r.start).toBe(r.end);
    expect(r.text.slice(0, r.start).endsWith('メモ ')).toBe(true);
  });
  it('囲みの外の印は従来どおり選ぶ', () => {
    const r = insertSnippet(at(''), '```\n${HOME}\n```\n${宛名}', NOW);
    expect(r.text.slice(r.start, r.end)).toBe('${宛名}');
  });
});

describe('T3 数や真偽に見える短縮語は書いた字のまま読む', () => {
  const abbrOf = (v: string) => snippetItemOf('l', 't', `---\nabbr: ${v}\n---\n本文`);
  it.each([
    ['100', '100'],
    ['001', '001'],
    ['1.5', '1.5'],
    ['true', 'true'],
    ['null', 'null'],
    ['001 # 注', '001'],
  ])('%s', (v, want) => {
    expect(abbrOf(v)?.abbr).toBe(want);
    expect(abbrOf(v)?.abbrUnread).toBeUndefined();
  });
  it('# で始まる短縮語は空にして、読めなかった印を付ける(囲めば読める)', () => {
    expect(abbrOf('#memo')?.abbr).toBe('');
    expect(abbrOf('#memo')?.abbrUnread).toBe(true);
    expect(abbrOf('"#memo"')?.abbr).toBe('#memo');
    expect(snippetItemOf('l', 't', '---\nabbr:\n---\n本文')?.abbrUnread).toBeUndefined();
  });
  it('一覧の注記に件数が出る', () => {
    const scan = { items: [abbrOf('#m')!], total: 1, truncated: false, abbrUnread: 1 };
    expect(snippetMenuNote(scan)).toContain('短縮語を読めなかったテンプレートが 1 件');
    expect(snippetMenuNote({ ...scan, abbrUnread: undefined })).toBe('');
  });
});

describe('T4 {{vars.x}} の値が表の行を壊さない', () => {
  it('表の行では | を \\| に、改行を空白にする', () => {
    const out = expandVarsInText('| a | {{vars.x}} |', { x: 'p|q\nr' });
    expect(out).toBe('| a | p\\|q r |');
    const html = renderMarkdown('---\nvars:\n  x: "p|q"\n---\n| a | b |\n|---|---|\n| 1 | {{vars.x}} |\n');
    expect((html.match(/<td/g) ?? []).length).toBe(2);
    expect(html).toContain('p|q');
  });
  it('表でない行は値をそのまま入れる', () => {
    expect(expandVarsInText('x {{vars.x}}', { x: 'p|q' })).toBe('x p|q');
  });
});

describe('T5 字下げコード・数式・<pre> の中は値にしない', () => {
  it.each([
    ['字下げコード', '前\n\n    echo ${date}\n\n${date}'],
    ['数式', '$$\na = ${date}\n$$\n${date}'],
    ['pre', '<pre>\n${date}\n</pre>\n${date}'],
  ])('%s', (_n, body) => {
    const t = fillSnippetVars(body, NOW).text;
    expect(t.match(/\$\{date\}/g)?.length).toBe(1);
    expect(t.match(/2026-10-17/g)?.length).toBe(1);
  });
  it('普通の段落とリストの続きは値にする', () => {
    expect(fillSnippetVars('- a\n\n    ${date}', NOW).text).toBe('- a\n\n    2026-10-17');
    expect(fillSnippetVars('${date}', NOW).text).toBe('2026-10-17');
  });
});

describe('T7 閉じていない %%% の隠しメモの中へは足さない', () => {
  it('開いたまま → true / 閉じている → false', () => {
    expect(endsInsideOpenBlock('本文\n%%%\nメモ')).toBe(true);
    expect(endsInsideOpenBlock('本文\n%%%\nメモ\n%%%\n')).toBe(false);
    expect(endsInsideOpenBlock('%%%メモ')).toBe(true);
    expect(endsInsideOpenBlock('%%%メモ%%%')).toBe(false);
  });
  it('囲み(fence / :::)の判定は変わらない', () => {
    expect(endsInsideOpenBlock('```\nx')).toBe(true);
    expect(endsInsideOpenBlock(':::note\nx')).toBe(true);
    expect(endsInsideOpenBlock('```\nx\n```\n')).toBe(false);
    expect(endsInsideOpenBlock('平文')).toBe(false);
  });
});
