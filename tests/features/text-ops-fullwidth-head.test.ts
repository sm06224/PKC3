/** @vitest-environment node */
/**
 * 🔴 全角の記号で始まる行に「箇条書き」「番号」「チェック」を押したとき、記号が重ならない(#1163 依頼 205。Gemini 回答は案どおり)。
 *
 * 日本語入力のまま打つと `・牛乳` / `－ a` / `＊ a` / `１. a` になる。描き手はこれを箇条書きと読まない(表示は変えない)ので、
 * 押す側が `- ・牛乳` のように重ねていた。押したときだけ、全角の記号を半角の印に置き換える。
 */
import { describe, expect, it } from 'vitest';
import { toggleLinePrefix, type LinePrefix } from '../../src/features/markdown/text-ops';

const run = (text: string, kind: LinePrefix) =>
  toggleLinePrefix({ text, start: 0, end: text.length }, kind).text;

describe('全角の記号で始まる行', () => {
  it.each([
    ['・牛乳', '- 牛乳'],
    ['・ 牛乳', '- 牛乳'],
    ['－ 牛乳', '- 牛乳'],
    ['＊ 牛乳', '- 牛乳'],
    ['＋　牛乳', '- 牛乳'],
    ['１. 牛乳', '- 牛乳'],
    ['１０．　牛乳', '- 牛乳'],
    ['２） 牛乳', '- 牛乳'],
    // 字下げは残る(全角の空白の字下げも)
    ['  ・牛乳', '  - 牛乳'],
    ['　・牛乳', '　- 牛乳'],
  ])('箇条書き: %j → %j', (before, after) => {
    expect(run(before, 'ul')).toBe(after);
  });

  it('番号・チェックでも同じ(記号が重ならない)', () => {
    expect(run('・牛乳', 'ol')).toBe('1. 牛乳');
    expect(run('・牛乳', 'task')).toBe('- [ ] 牛乳');
  });

  it('複数行を選んで押すと、全角の行も半角の行も揃う', () => {
    expect(run('・あ\n- い\n＊ う\nえ', 'ul')).toBe('- あ\n- い\n- う\n- え');
  });

  it('前のボタンで重なってしまった行(`- ・牛乳`)も 1 回で直る', () => {
    expect(run('- ・牛乳', 'ol')).toBe('1. 牛乳');
  });

  /** ⚠ 対照群 ── 記号ではない全角の字は落とさない(見出しの行や、強調の `＊…＊`)。 */
  it('記号の後ろに空白が無い `＊強調＊` / 全角の記号を含む普通の文は、字を落とさない', () => {
    expect(run('＊強調＊', 'ul')).toBe('- ＊強調＊');
    expect(run('１月の予定', 'ul')).toBe('- １月の予定');
    expect(run('牛乳・卵', 'ul')).toBe('- 牛乳・卵');
  });

  it('見出しの行へ押したときは、見出しの印だけを替える(全角の記号は触らない)', () => {
    expect(run('・見出し', 'h2')).toBe('## ・見出し');
  });

  it('もう一度押すと外れる(半角の印になった行は、これまでどおりの切り替え)', () => {
    const once = run('・牛乳', 'ul');
    expect(once).toBe('- 牛乳');
    expect(run(once, 'ul')).toBe('牛乳');
  });
});
