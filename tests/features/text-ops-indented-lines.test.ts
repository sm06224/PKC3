/** @vitest-environment node */
/**
 * 書式バーの「チェック」「箇条書き」「番号」は、字下げした行や `- [X]` の行で記号を二重にしない。
 *
 * 直す前は、判定が行頭の記号だけを見ていたので、字下げした `  - [ ] 子` は「付いていない」と
 * 読まれ、押すと `- [ ]  - [ ] 子` のように二重になった。大文字の `[X]` も同じ(済みと読まれなかった)。
 * 読み方は `body-rewrite.ts` の `TASK_LINE`(字下げ可・`[ xX]`)に揃えてある。
 */
import { describe, expect, it } from 'vitest';
import { toggleLinePrefix, type LinePrefix } from '../../src/features/markdown/text-ops';

const run = (text: string, kind: LinePrefix) =>
  toggleLinePrefix({ text, start: 0, end: text.length }, kind).text;

describe('チェック', () => {
  // 字下げ {なし, 2 字, タブ} × 印 {[ ], [x], [X]}
  it.each(['', '  ', '\t'])('字下げ %j:付いている行は外れ、字下げは残る', (ind) => {
    for (const box of ['[ ]', '[x]', '[X]']) {
      expect(run(`${ind}- ${box} 子`, 'task'), `${JSON.stringify(ind)} ${box}`).toBe(`${ind}子`);
    }
  });

  it.each(['', '  ', '\t'])('字下げ %j:付いていない行には字下げの後ろに付く(二重にならない)', (ind) => {
    expect(run(`${ind}子`, 'task')).toBe(`${ind}- [ ] 子`);
    // 箇条書きの行からはチェックに替わる(記号は 1 つ)
    expect(run(`${ind}- 子`, 'task')).toBe(`${ind}- [ ] 子`);
    // 番号付きの行から
    expect(run(`${ind}3. 子`, 'task')).toBe(`${ind}- [ ] 子`);
  });

  it('大文字の [X] の行へ押しても、記号が二重にならず外れる', () => {
    expect(run('- [X] 済', 'task')).toBe('済');
  });
});

describe('箇条書き', () => {
  it.each(['', '  ', '\t'])('字下げ %j:付いている行は外れ、字下げは残る / 付ける', (ind) => {
    expect(run(`${ind}- 子`, 'ul')).toBe(`${ind}子`);
    expect(run(`${ind}子`, 'ul')).toBe(`${ind}- 子`);
  });

  it.each(['', '  ', '\t'])('字下げ %j:チェックの行は「付いている」とは読まず、チェックの記号を替える', (ind) => {
    for (const box of ['[ ]', '[x]', '[X]']) {
      // `[ ] 子` のように化けない
      expect(run(`${ind}- ${box} 子`, 'ul'), `${JSON.stringify(ind)} ${box}`).toBe(`${ind}- 子`);
    }
  });
});

describe('番号', () => {
  it.each(['', '  ', '\t'])('字下げ %j:付いている行は外れ、付けるときは字下げの後ろに数える', (ind) => {
    expect(run(`${ind}2. 子`, 'ol')).toBe(`${ind}子`);
    expect(run(`${ind}子`, 'ol')).toBe(`${ind}1. 子`);
    expect(run(`${ind}- [X] 子`, 'ol')).toBe(`${ind}1. 子`);
  });

  it('複数行は行ごとに数え、字下げはそれぞれ残る', () => {
    expect(run('あ\n  い\nう', 'ol')).toBe('1. あ\n  2. い\n3. う');
  });
});

describe('対照群:字下げ無しの従来の動き', () => {
  it('見出し・引用は従来どおり行頭だけで読む(字下げした `# ` は見出しではない)', () => {
    expect(run('# あ', 'h1')).toBe('あ');
    expect(run('  # あ', 'h1')).toBe('# ' + '  # あ');
    expect(run('> あ', 'quote')).toBe('あ');
  });
});
