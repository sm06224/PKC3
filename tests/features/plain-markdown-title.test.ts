/** @vitest-environment node */
/**
 * 台帳 #1852 束 R1(依頼 262): md を取り込むとき、見出しから付く題名は記号を外した見える字にする(本文は変えない)。
 */
import { describe, expect, it } from 'vitest';
import { headingToTitle, readPlainMarkdown } from '../../src/features/import/plain-markdown';

describe('headingToTitle', () => {
  it.each([
    ['**太字** と [リンク](http://x)', '太字 と リンク'],
    ['Title {#custom-id}', 'Title'],
    ['Title {.cls #id}', 'Title'],
    ['[[Wiki Link]]', 'Wiki Link'],
    ['[[先|見える字]]', '見える字'],
    ['`code` と __強調__ と *斜体* と _下線_', 'code と 強調 と 斜体 と 下線'],
    ['~~消す~~ と ==光らす==', '消す と 光らす'],
    ['![図の説明](a.png) まとめ', '図の説明 まとめ'],
    ['[ref link][r1] です', 'ref link です'],
    ['\\*エスケープ\\* と 5\\_3', '*エスケープ* と 5_3'],
    ['[[ruby:漢字|かんじ]]の話', '漢字の話'],
  ])('%s → %s', (raw, want) => {
    expect(headingToTitle(raw)).toBe(want);
  });

  it('対照群: 記号を含まない題名・字の中の記号はそのまま', () => {
    expect(headingToTitle('普通の題名')).toBe('普通の題名');
    expect(headingToTitle('snake_case と 2*3*4')).toBe('snake_case と 2*3*4');
    expect(headingToTitle('`a_b*c`')).toBe('a_b*c');
    expect(headingToTitle('C# の話')).toBe('C# の話');
  });

  it('全部外れて空になるときは null', () => {
    expect(headingToTitle('![](a.png)')).toBeNull();
  });
});

describe('readPlainMarkdown: 見出しから付く題名', () => {
  it('記号は題名から外れ、本文は 1 字も変わらない', () => {
    const text = '# **太字** と [リンク](http://x)\n\n本文 **そのまま**\n';
    const r = readPlainMarkdown(text, 'note.md');
    expect(r.title).toBe('太字 と リンク');
    expect(r.body).toBe(text);
  });

  it('前書きに題名があればそちらが先(対照群)', () => {
    const r = readPlainMarkdown('---\ntitle: 前書きの題\n---\n# **見出し**\n', 'note.md');
    expect(r.title).toBe('前書きの題');
  });

  it('見出しが記号だけで空になるときは、ファイル名が題名', () => {
    expect(readPlainMarkdown('# ![](a.png)\n本文', 'メモ.md').title).toBe('メモ');
  });
});
