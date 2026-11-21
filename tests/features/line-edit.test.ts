/**
 * 🔴 行の複製・削除・見出しの段の巡回・選択を囲む(#2001 段 3)の規則。
 * `|` で選択範囲を書く(1 つなら caret)。
 */
import { describe, expect, it } from 'vitest';
import { cycleHeading, deleteLines, duplicateLines, headingLevelOf } from '../../src/features/markdown/line-edit';
import { WRAP_PAIRS, wrapSelection } from '../../src/features/markdown/wrap-selection';
import { autoPairFor, type TextSelection } from '../../src/features/markdown/text-ops';

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
/** 呼び側が書く形(`from`〜`to` を `insert` へ)で作った本文が `text` と一致すること。 */
function check(b: TextSelection, r: { from: number; to: number; insert: string; text: string }): void {
  expect(b.text.slice(0, r.from) + r.insert + b.text.slice(r.to)).toBe(r.text);
}

describe('行の複製', () => {
  const dup = (m: string, d: 1 | -1) => {
    const b = sel(m);
    const r = duplicateLines(b, d);
    check(b, r);
    return show(r);
  };
  it('下へ: 中の行。選択は写しへ付いていく', () => {
    expect(dup('a\nb|c\nd', 1)).toBe('a\nbc\nb|c\nd');
  });
  it('上へ: 中の行。選択は元の位置のまま(= 上の写し)', () => {
    expect(dup('a\nb|c\nd', -1)).toBe('a\nb|c\nbc\nd');
  });
  it('末尾の行(末尾改行なし)', () => {
    expect(dup('a\nb|', 1)).toBe('a\nb\nb|');
    expect(dup('a\nb|', -1)).toBe('a\nb|\nb');
  });
  it('末尾改行あり: 空の最終行を複製する', () => {
    expect(dup('a\n|', 1)).toBe('a\n\n|');
  });
  it('複数行の選択: 塊ごと', () => {
    expect(dup('x\n|a\nb|\ny', 1)).toBe('x\na\nb\n|a\nb|\ny');
    expect(dup('x\n|a\nb|\ny', -1)).toBe('x\n|a\nb|\na\nb\ny');
  });
  it('下の行の頭まで選んだときは、その行を巻き込まない', () => {
    expect(duplicateLines(sel('x\n|a\n|b'), 1).text).toBe('x\na\na\nb');
  });
  it('空の本文', () => {
    expect(duplicateLines(sel('|'), 1).text).toBe('\n');
    expect(duplicateLines(sel('|'), -1).text).toBe('\n');
  });
  it('日本語・行末の \\r は中身として一緒に写る', () => {
    expect(duplicateLines(sel('あ|い\r\nう'), 1).text).toBe('あい\r\nあい\r\nう');
  });
});

describe('行の削除', () => {
  const del = (m: string) => {
    const b = sel(m);
    const r = deleteLines(b);
    if (r === null) return null;
    check(b, r);
    return show(r);
  };
  it('中の行を消す。caret は元の桁を保つ(下の行の長さで切る)', () => {
    expect(del('a\nbcd|\nxy\nz')).toBe('a\nxy|\nz');
    expect(del('a\nb|cd\nxyz\nz')).toBe('a\nx|yz\nz');
  });
  it('末尾の行(改行なし)を消すと直前の改行も消える', () => {
    expect(del('a\nb|')).toBe('a|');
  });
  it('先頭の行', () => {
    expect(del('|a\nb')).toBe('|b');
  });
  it('1 行だけの本文は空になる', () => {
    expect(del('a|')).toBe('|');
  });
  it('複数行の選択は塊ごと', () => {
    expect(del('a\n|b\nc|\nd')).toBe('a\n|d');
    expect(del('a\n|b\n|c')).toBe('a\n|c');
  });
  it('末尾が改行の本文: 空の最終行を消すと直前の改行が消える', () => {
    expect(del('a\n|')).toBe('|a');
  });
  it('空の本文は null(何も起きない)', () => {
    expect(deleteLines(sel('|'))).toBeNull();
  });
});

describe('見出しの段の巡回', () => {
  const cyc = (m: string) => {
    const b = sel(m);
    const r = cycleHeading(b);
    check(b, r);
    return show(r);
  };
  it('なし → # → ## → … → ###### → なし', () => {
    let t = 'あ|い';
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      t = cyc(t);
      seen.push(t);
    }
    expect(seen).toEqual(['# あ|い', '## あ|い', '### あ|い', '#### あ|い', '##### あ|い', '###### あ|い', 'あ|い']);
  });
  it('caret が記号の中なら本文の頭へ寄る', () => {
    expect(cyc('#| あ')).toBe('## |あ');
  });
  it('複数行: 最初の空でない行の段から決め、空でない全行へそろえる。空行は触らない', () => {
    expect(cyc('|# a\n\nb|')).toBe('## |a\n\n## b|');
    expect(cyc('|a\n## b|')).toBe('# |a\n# b|');
  });
  it('空行だけを選んでいればその行に付ける', () => {
    expect(cyc('|')).toBe('# |');
  });
  it('末尾の行・末尾改行なし', () => {
    expect(cyc('x\ny|')).toBe('x\n# y|');
  });
  it('`#` の後ろに空白が無い行(#tag)は見出しでない', () => {
    expect(headingLevelOf('#tag')).toBe(0);
    expect(headingLevelOf('## a')).toBe(2);
    expect(headingLevelOf('####### a')).toBe(0);
    expect(cyc('#t|ag')).toBe('# #t|ag');
  });
});

describe('選択を囲む', () => {
  it.each(Object.entries(WRAP_PAIRS))('%s で囲む。選択は中身に残る', (open, close) => {
    const r = wrapSelection(sel('a|bc|d'), open)!;
    expect(r.insert).toBe(`${open}bc${close}`);
    expect(r.start).toBe(1 + open.length);
    expect(r.end).toBe(1 + open.length + 2);
  });
  it('依頼の 10 字が対象に入っている', () => {
    for (const k of ['(', '[', '{', '"', "'", '「', '『', '`', '*', '_']) expect(WRAP_PAIRS[k], k).toBeDefined();
  });
  it('選択が無いとき・対象でない字は null', () => {
    expect(wrapSelection(sel('a|b'), '(')).toBeNull();
    expect(wrapSelection(sel('a|b|'), 'x')).toBeNull();
  });
  it('autoPairFor の選択ありの枝も同じ規則(`*` も。表の行・数式の中でも囲む)', () => {
    expect(autoPairFor(sel('|a|'), '*')!.insert).toBe('*a*');
    expect(autoPairFor({ text: '| x | a', start: 6, end: 7 }, '(')!.insert).toBe('(a)');
    expect(autoPairFor(sel('$$\n|a|\n$$'), '(')!.insert).toBe('(a)');
  });
  it('`*` を続けて 2 回で太字になる(選択が中身に残る)', () => {
    const one = wrapSelection(sel('|a|'), '*')!;
    const two = wrapSelection({ text: '*a*', start: one.start, end: one.end }, '*')!;
    expect('*a*'.slice(0, one.start) + two.insert + '*a*'.slice(one.end)).toBe('**a**');
  });
  it('選択なしの `*` `_` `\'` は今までどおり補わない', () => {
    for (const k of ['*', '_', "'"]) expect(autoPairFor(sel('a|'), k)).toBeNull();
  });
});
