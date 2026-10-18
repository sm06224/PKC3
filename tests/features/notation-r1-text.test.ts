/** @vitest-environment happy-dom */
/**
 * 台帳 #1852 束 R1 ── 本文の書いた字を勝手に変えない(依頼 254)/ `\%%` は字のまま(依頼 256)。
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { stripDialect } from '../../src/features/markdown/strip-dialect';
import { replaceInlineComments, inlineCommentRanges } from '../../src/features/markdown/inline-comment';
import { bodyLinkTargets } from '../../src/features/entry-ref/body-links';

function textOf(md: string): string {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(md);
  return el.textContent ?? '';
}

describe('依頼 254: 記号への置き換えをやめる', () => {
  it.each(['(c)', '(r)', '(tm)', '--force', 'A--B', 'A---B', 'wait...', '+-5', 'ok!!!!'])(
    '%s は書いたとおりに出る',
    (typed) => {
      expect(textOf(`前 ${typed} 後`)).toContain(typed);
    },
  );

  it('箇条書きの (a) (b) (c) の 3 つ目も © にならない', () => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdown('- (a) 一\n- (b) 二\n- (c) 三');
    expect(el.textContent).toContain('(c) 三');
    expect(el.textContent).not.toContain('©');
  });

  it('対照群: 引用符の「“ ”」への置き換えは残る', () => {
    const t = textOf('He said "hi" and don\'t');
    expect(t).toContain('“hi”');
    expect(t).toContain('don’t');
  });
});

describe('依頼 256: `\\%%` は字のまま', () => {
  it('`\\%%` で字のまま出る(2 回書いても間が消えない)', () => {
    expect(textOf('100\\%% done and 50\\%% more')).toContain('100%% done and 50%% more');
  });

  it('対照群: 今までのメモ `%%…%%` は消える', () => {
    const t = textOf('前 %%メモ%% 後');
    expect(t).not.toContain('メモ');
    expect(t).toContain('前');
    expect(t).toContain('後');
  });

  it('1 つ目だけ逃がすと、字の `%%` の後ろからメモが始まる側には読まない', () => {
    // `\%%` は字、続く `x%%` は閉じの無い `%%` なのでメモにならない(字のまま)
    expect(textOf('a\\%%x%%b')).toContain('%%x');
  });

  it('`\\\\%%…%%`(逃がした `\\` の後ろ)はメモのまま', () => {
    const t = textOf('a\\\\%%消える%%b');
    expect(t).not.toContain('消える');
  });

  it('読み方は 1 本: 範囲・置き換え・書き出し(方言を落とす)・参照元の数え方が同じ', () => {
    // 先頭の `\%%` は字。残りの `%% b %%` が対になってメモ
    expect(inlineCommentRanges('a \\%%x%% b %%y%%')).toEqual([[6, 13]]);
    expect(replaceInlineComments('a \\%%x%% b %%y%%', () => '')).toBe('a \\%%xy%%');
    expect(inlineCommentRanges('\\%%x\\%%')).toEqual([]);
    expect(stripDialect('50\\%% と 60\\%%')).toContain('50\\%% と 60\\%%');
    expect(stripDialect('前 %%消える%% 後')).not.toContain('消える');
    // 参照元: 字として書いた `%%` の間に在る entry: は数える(メモではない)/ メモの中は数えない
    expect(bodyLinkTargets('\\%%[a](entry:n1)\\%%')).toContain('n1');
    expect(bodyLinkTargets('%%[a](entry:n2)%%')).not.toContain('n2');
  });
});

describe('依頼 94-3: 本文に出る寄せの目印は日本語', () => {
  it.each([
    ['end', '行末側'],
    ['start', '行頭側'],
    ['center', '中央'],
    ['justify', '両端揃え'],
    ['left', '左'],
    ['right', '右'],
  ])(':align:{position=%s} → (次の段落の寄せ: %s)', (pos, label) => {
    const html = renderMarkdown(`本文 :align:{position=${pos}} の続き\n`, { silentHallucinationWarnings: true });
    const el = document.createElement('div');
    el.innerHTML = html;
    const chip = el.querySelector('.pkc-align-hint')!;
    expect(chip.textContent).toBe(`(次の段落の寄せ: ${label})`);
    expect(chip.getAttribute('data-pkc-align-next')).toBe(pos);
    expect(el.textContent).not.toContain('[align:');
    // 説明はマウスを載せたときに今までどおり出る
    expect(chip.getAttribute('title')).toContain('次の段落の寄せ');
  });
});
