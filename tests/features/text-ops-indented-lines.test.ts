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

  it.each(['', '  ', '\t'])('字下げ %j:未完了のチェックの行は「付いている」とは読まず、チェックの記号を替える', (ind) => {
    // `[ ] 子` のように化けない
    expect(run(`${ind}- [ ] 子`, 'ul'), JSON.stringify(ind)).toBe(`${ind}- 子`);
  });

  /**
   * 🔴 事実が動いた(台帳 #1852 I2 / 依頼 114-3。Gemini 回答 = 推薦 A):完了(`[x]` / `[X]`)の行に箇条書きを押すと、
   * 以前は `- 子` になって完了の記録が消えていた。いまは**その行を変えない**(チェック付きの箇条書きはもう箇条書き)。
   */
  it.each(['', '  ', '\t'])('🔴 字下げ %j:完了のチェックの行は、完了の印ごとそのまま', (ind) => {
    for (const box of ['[x]', '[X]']) {
      expect(run(`${ind}- ${box} 子`, 'ul'), `${JSON.stringify(ind)} ${box}`).toBe(`${ind}- ${box} 子`);
    }
    // 対照群:同じ範囲の、チェックでない行にはこれまでどおり付く
    expect(run(`${ind}- ${'[x]'} 子\n${ind}丑`, 'ul')).toBe(`${ind}- [x] 子\n${ind}- 丑`);
  });
});

describe('番号', () => {
  it.each(['', '  ', '\t'])('字下げ %j:付いている行は外れ、付けるときは字下げの後ろに数える', (ind) => {
    expect(run(`${ind}2. 子`, 'ol')).toBe(`${ind}子`);
    expect(run(`${ind}子`, 'ol')).toBe(`${ind}1. 子`);
    // 🔴 事実が動いた(依頼 114-3 の残り):完了の行は印ごと番号になる(下の describe に詳しく)
    expect(run(`${ind}- [X] 子`, 'ol')).toBe(`${ind}1. [X] 子`);
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

describe('完了の印を残す(台帳 #1852 I2 / 依頼 114-3)', () => {
  it('🔴 引用:完了の行は `> - [x] 済み`(印が残る)。未完了は従来どおり印を外して引用にする', () => {
    expect(run('- [x] 済み', 'quote')).toBe('> - [x] 済み');
    expect(run('- [X] 済み', 'quote')).toBe('> - [X] 済み');
    expect(run('1. [x] 済み', 'quote')).toBe('> 1. [x] 済み');
    expect(run('- [ ] 未', 'quote')).toBe('> 未');
    // 引用を押し直すと元に戻る
    expect(run('> - [x] 済み', 'quote')).toBe('- [x] 済み');
  });
  it('🔴 見出し:完了の行は `# - [x] 済み`(字として残り、もう一度押すと元のチェック項目に戻る)', () => {
    for (const [kind, mark] of [['h1', '# '], ['h2', '## '], ['h3', '### ']] as const) {
      expect(run('- [x] 済み', kind)).toBe(`${mark}- [x] 済み`);
      expect(run(`${mark}- [x] 済み`, kind)).toBe('- [x] 済み');
    }
    // 未完了は従来どおり
    expect(run('- [ ] 未', 'h1')).toBe('# 未');
    // 字下げした完了の行は、字下げを落として見出しにする(従来の見出しと同じ)
    expect(run('  - [x] 済み', 'h2')).toBe('## - [x] 済み');
  });
  it('複数行の混在:完了の行だけ印が残り、ほかの行は従来どおり', () => {
    expect(run('- [x] 済み\n普通の行', 'quote')).toBe('> - [x] 済み\n> 普通の行');
    expect(run('- [x] 済み\n- [ ] 未', 'h1')).toBe('# - [x] 済み\n# 未');
  });
  it('🔴 番号も完了の印を残す(依頼 114-3 の残り):`- [X] 子` → `1. [X] 子`。もう一度押すとチェック付きの箇条書きに戻る', () => {
    expect(run('- [X] 子', 'ol')).toBe('1. [X] 子');
    expect(run('- [x] 子', 'ol')).toBe('1. [x] 子');
    expect(run('1. [x] 子', 'ol')).toBe('- [x] 子');
    // 字下げ・引用の中でも、印が残る
    expect(run('  - [x] 子', 'ol')).toBe('  1. [x] 子');
    expect(run('> - [x] 子', 'ol')).toBe('> 1. [x] 子');
    // 複数行:行ごとに数え、完了の行だけ印が残る
    expect(run('- [x] あ\nい\n- [ ] う', 'ol')).toBe('1. [x] あ\n2. い\n3. う');
  });
  it('対照群:未完了のチェックに番号を押すと、従来どおりチェックの記号が替わる', () => {
    expect(run('- [ ] 子', 'ol')).toBe('1. 子');
  });
});
