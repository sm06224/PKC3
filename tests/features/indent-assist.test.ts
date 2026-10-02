/**
 * 🔴 **字下げ / 字下げを戻す**(#1166)の規則。
 *
 * ⚠ 守るのは「握る場面」と「握らない場面」の**両側**である ── 握らない側(`null`)が
 * 崩れると、`Tab` が毎回奪われて**編集欄から出られなくなる**。
 */
import { describe, expect, it } from 'vitest';
import { indentLines, type IndentEdit } from '../../src/features/markdown/indent-assist';
import type { TextSelection } from '../../src/features/markdown/text-ops';

/** `|` で選択範囲を書く(1 つなら caret)。 */
function sel(marked: string): TextSelection {
  const start = marked.indexOf('|');
  const second = marked.indexOf('|', start + 1);
  const end = second === -1 ? start : second - 1;
  return { text: marked.replace(/\|/g, ''), start, end };
}
function show(s: TextSelection): string {
  if (s.start === s.end) return `${s.text.slice(0, s.start)}|${s.text.slice(s.start)}`;
  return `${s.text.slice(0, s.start)}|${s.text.slice(s.start, s.end)}|${s.text.slice(s.end)}`;
}
function ok(r: IndentEdit | null): IndentEdit {
  expect(r, '握るはずの場面で null(何も起きない)').not.toBeNull();
  return r!;
}

describe('Tab ── 握る場面', () => {
  it('箇条書きの行は 2 つ内側へ入る(caret は行の中身に付いていく)', () => {
    expect(show(ok(indentLines(sel('- あ|い'), 1)))).toBe('  - あ|い');
    expect(show(ok(indentLines(sel('* あ|い'), 1)))).toBe('  * あ|い');
    expect(show(ok(indentLines(sel('+ あ|い'), 1)))).toBe('  + あ|い');
  });

  /** 🔴 markdown-it は `1. a` の下の入れ子に空白 3 つを要る ── 2 つ固定だと入れ子にならない。 */
  it('🔴 番号付きは記号の幅(`1. ` = 3、`10. ` = 4)だけ入る', () => {
    expect(ok(indentLines(sel('1. あ|'), 1)).text).toBe('   1. あ');
    expect(ok(indentLines(sel('9) あ|'), 1)).text).toBe('   9) あ');
    expect(ok(indentLines(sel('10. あ|'), 1)).text).toBe('    10. あ');
  });

  it('チェックリストは `- ` の幅(2)', () => {
    expect(ok(indentLines(sel('- [ ] あ|'), 1)).text).toBe('  - [ ] あ');
  });

  it('入れ子の途中の行も、さらに 1 段入る', () => {
    expect(ok(indentLines(sel('- a\n  - b|'), 1)).text).toBe('- a\n    - b');
  });

  it('caret の行だけが動く(他の行は 1 字も変わらない)', () => {
    const r = ok(indentLines(sel('- a\n- b|\n- c'), 1));
    expect(r.text).toBe('- a\n  - b\n- c');
    expect([r.from, r.to, r.insert]).toEqual([4, 7, '  - b']);
  });

  it('複数行を選んでいれば、リストでない行にも 2 つ入る(選択は同じ行に残る)', () => {
    const r = ok(indentLines(sel('|あ\nい|\nう'), 1));
    expect(show(r)).toBe('|  あ\n  い|\nう');
  });

  it('複数行は行ごとに幅を決める(リスト 3 + 地の文 2)', () => {
    expect(ok(indentLines(sel('|1. a\n地の文|'), 1)).text).toBe('   1. a\n  地の文');
  });

  it('空行は触らない(行末の空白を作らない)', () => {
    expect(ok(indentLines(sel('|あ\n\nい|'), 1)).text).toBe('  あ\n\n  い');
  });

  it('下の行の頭まで選んでいても、その行は巻き込まない', () => {
    expect(ok(indentLines(sel('|あ\nい\n|う'), 1)).text).toBe('  あ\n  い\nう');
  });

  it('`>` で始まる行は触らない(字下げを `>` の前へ足すと引用が壊れる)', () => {
    expect(ok(indentLines(sel('|> あ\nい|'), 1)).text).toBe('> あ\n  い');
    expect(indentLines(sel('> - あ|'), 1)).toBeNull();
  });

  /** fence の行も本文の字なので、複数行の選択に入っていれば字下げする(仕様)。 */
  it('fence の行も、選択に入っていれば字下げする', () => {
    expect(ok(indentLines(sel('|```\nx\n```|'), 1)).text).toBe('  ```\n  x\n  ```');
  });
});

describe('Tab ── 握らない場面(焦点が出ていく。意図した出口)', () => {
  it('🔴 普通の段落の 1 行は握らない', () => {
    expect(indentLines(sel('ふつうの|文'), 1)).toBeNull();
    expect(indentLines(sel('|ふつうの文|'), 1)).toBeNull();
  });

  it('見出し・空行・水平線も握らない', () => {
    expect(indentLines(sel('# 見出し|'), 1)).toBeNull();
    expect(indentLines(sel('|'), 1)).toBeNull();
    expect(indentLines(sel('---|'), 1)).toBeNull();
    expect(indentLines(sel('* * *|'), 1)).toBeNull();
  });

  it('記号だけ(後ろに空白が無い)の行はリストではない', () => {
    expect(indentLines(sel('-|'), 1)).toBeNull();
    expect(indentLines(sel('1.|'), 1)).toBeNull();
  });
});

describe('明示の命令(Ctrl+] / Ctrl+[)', () => {
  it('普通の 1 行にも 2 つ入る(焦点の出口を奪わないので)', () => {
    expect(ok(indentLines(sel('ふつう|'), 1, { explicit: true })).text).toBe('  ふつう');
  });

  it('リストなら、Tab と同じ幅', () => {
    expect(ok(indentLines(sel('1. あ|'), 1, { explicit: true })).text).toBe('   1. あ');
  });
});

describe('Shift+Tab ── 戻す', () => {
  it('入っていた分だけ戻る', () => {
    expect(show(ok(indentLines(sel('  - あ|い'), -1)))).toBe('- あ|い');
    expect(ok(indentLines(sel('   1. あ|'), -1)).text).toBe('1. あ');
    expect(ok(indentLines(sel('    10. あ|'), -1)).text).toBe('10. あ');
  });

  it('🔴 戻せるのは記号の幅まで(深く入っていれば、1 段だけ戻る)', () => {
    expect(ok(indentLines(sel('    - あ|'), -1)).text).toBe('  - あ');
    expect(ok(indentLines(sel('      1. あ|'), -1)).text).toBe('   1. あ');
  });

  it('🔴 幅より少ない字下げからでも止まらない(あるだけ外す)', () => {
    expect(ok(indentLines(sel(' 1. あ|'), -1)).text).toBe('1. あ');
    expect(ok(indentLines(sel(' - あ|'), -1)).text).toBe('- あ');
  });

  it('caret が字下げの中に居たら行頭へ寄る(負の位置にならない)', () => {
    expect(show(ok(indentLines(sel(' | - あ'), -1)))).toBe('|- あ');
  });

  it('タブ 1 つは 1 段として外れる', () => {
    expect(ok(indentLines(sel('\t- あ|'), -1)).text).toBe('- あ');
  });

  it('複数行は行ごとに戻す(字下げの無い行は据え置き)', () => {
    expect(ok(indentLines(sel('|  - a\nb\n   1. c|'), -1)).text).toBe('- a\nb\n1. c');
  });

  it('地の文でも字下げがあれば戻る(2 つ)', () => {
    expect(ok(indentLines(sel('    あ|'), -1)).text).toBe('  あ');
  });

  it('🔴 戻せる字下げが無ければ握らない(焦点が前へ出る)', () => {
    expect(indentLines(sel('- あ|'), -1)).toBeNull();
    expect(indentLines(sel('ふつう|'), -1)).toBeNull();
    expect(indentLines(sel('|あ\nい|'), -1)).toBeNull();
    expect(indentLines(sel('|'), -1)).toBeNull();
  });
});

describe('往復と選択', () => {
  it('入れて戻すと元の本文(選択も同じ)', () => {
    for (const marked of ['- a|b', '1. a|', '10. |x', '|- a\n- b|', '|1. a\n地の文|']) {
      const start = sel(marked);
      const there = ok(indentLines(start, 1, { explicit: true }));
      const back = ok(indentLines(there, -1));
      expect(back.text, marked).toBe(start.text);
    }
  });

  it('選択の終わりは、最後の行の中身に付いていく', () => {
    expect(show(ok(indentLines(sel('|- a\n- b|c'), 1)))).toBe('|  - a\n  - b|c');
  });
});

/**
 * 🔴 **先頭が空行の本文で、行頭を取り違えない**(#1213 の調査で見つけた)。
 *
 * `text.lastIndexOf('\n', sel.start - 1)` は `sel.start === 0` で第 2 引数が -1 になり、
 * **JS は負の位置を 0 に丸めて 0 番目を見る** ── 本文が `\n` で始まると行頭が 1 と読まれ、
 * ⚠ 字は壊れないが、**選んだ範囲の頭が字下げの幅ぶん内側へずれた**
 * (`\nあ\nい` を頭から選んで Ctrl+] → 選択の頭が 0 でなく 2。続けて押すと 1 行目の空行が選びから外れる)。
 */
describe('先頭が空行の本文(行頭の取り違え)', () => {
  it('🔴 先頭の空行から選んで字下げすると、選びの頭は 0 のまま(1 行目の空行も選びに残る)', () => {
    const before = sel('|\nあ\nい|');
    const r = ok(indentLines(before, 1, { explicit: true }));
    expect(r.text).toBe('\n  あ\n  い');
    expect(r.start, '選びの頭が内側へずれた(先頭の空行が欄の外へ落ちた)').toBe(0);
    expect(r.from, '置き換える範囲が 1 行目の空行を飛ばしている').toBe(0);
    expect(r.insert).toBe('\n  あ\n  い');
    // 往復: 続けて戻しても本文・選びが同じ
    const back = ok(indentLines(r, -1));
    expect([back.text, back.start, back.end]).toEqual([before.text, 0, before.text.length]);
  });

  it('対照群: 先頭の行が空でなければ、同じ形で素直に動く', () => {
    const r = ok(indentLines(sel('|あ\nい|'), 1, { explicit: true }));
    expect([r.text, r.start, r.from]).toEqual(['  あ\n  い', 0, 0]);
  });

  it('先頭の空行に caret があるだけなら何も起きない(空行は触らない)', () => {
    expect(indentLines(sel('|\nあ'), 1, { explicit: true })).toBeNull();
  });
});
