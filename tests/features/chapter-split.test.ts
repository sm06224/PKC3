import { describe, expect, it } from 'vitest';
import {
  applyChapterRestore,
  applyChapterSplit,
  chapterLinkLine,
  chapterLinkUnder,
  isOwnChapterChild,
  planChapterCut,
} from '../../src/features/markdown/chapter-split';

const BODY = ['# 題', '', '前', '', '## 章 A', '', '本文 A', '', '- 箇条', '', '## 章 B', '', '本文 B', ''].join('\n');

describe('章の切り出し案 #1439', () => {
  it('見出しの下(次の同段の見出しの手前まで)が子の本文になり、末尾の空行は含めない', () => {
    const r = planChapterCut(BODY, 4, 9);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cut.start).toBe(5);
    expect(r.cut.end).toBe(8);
    expect(r.cut.childBody).toBe('本文 A\n\n- 箇条\n');
    expect(r.cut.lines).toEqual(['', '本文 A', '', '- 箇条']);
  });

  it('本文が無い章は断る / 下線形式の見出しは断る', () => {
    const empty = planChapterCut('## A\n\n## B\n', 0, 1);
    expect(empty.ok).toBe(false);
    const setext = planChapterCut('見出し\n=====\n\n本文\n', 0, 3);
    expect(setext.ok).toBe(false);
    if (!setext.ok) expect(setext.reason).toContain('下線');
  });

  it('閉じていないコードの囲みを含む章は断る', () => {
    const r = planChapterCut('## A\n\n```\ncode\n', 0, 3);
    expect(r.ok).toBe(false);
  });

  it('すでに切り出した章(印のあるリンク 1 行)は断る / 印の無いリンクは普通の章として切り出せる', () => {
    const done = planChapterCut(`## A\n\n${chapterLinkLine('A', 'x1')}\n`, 0, 2);
    expect(done.ok).toBe(false);
    const plain = planChapterCut('## A\n\n[B](entry:x1)\n', 0, 2);
    expect(plain.ok).toBe(true);
  });

  it('リンクの字の [ ] は外す / 空なら「章」', () => {
    expect(chapterLinkLine('a [b] c', 'k1')).toBe('[a b c](entry:k1 "切り出した章")');
    expect(chapterLinkLine('', 'k1')).toBe('[章](entry:k1 "切り出した章")');
  });
});

describe('章の切り出しと戻し(本文の書換) #1439', () => {
  it('切り出して戻すと 1 バイトも変わらない', () => {
    const r = planChapterCut(BODY, 4, 9);
    if (!r.ok) throw new Error('plan');
    const link = chapterLinkLine('章 A', 'k1');
    const split = applyChapterSplit(BODY, { ...r.cut, link });
    expect(split).toBe(['# 題', '', '前', '', '## 章 A', '', link, '', '## 章 B', '', '本文 B', ''].join('\n'));
    const found = chapterLinkUnder(split!, 4, 7);
    expect(found).toEqual({ line: 6, text: link, lid: 'k1' });
    const back = applyChapterRestore(split!, { line: found!.line, openLine: found!.text, text: r.cut.childBody });
    expect(back).toBe(BODY);
  });

  it('錠(掴んだ時点の行)と違えば断る', () => {
    const r = planChapterCut(BODY, 4, 9);
    if (!r.ok) throw new Error('plan');
    const changed = BODY.replace('本文 A', '書き替わった');
    expect(applyChapterSplit(changed, { ...r.cut, link: 'x' })).toBeNull();
    expect(applyChapterRestore(BODY, { line: 6, openLine: 'ちがう', text: 'x' })).toBeNull();
  });

  it('見出しの下に、印のあるリンク以外が混じれば「切り出した章」ではない', () => {
    const link = chapterLinkLine('A', 'k1');
    expect(chapterLinkUnder(`## A\n\n${link}\n\n文が増えた\n`, 0, 4)).toBeNull();
    expect(chapterLinkUnder(`## A\n\n${link}\n${link}\n`, 0, 3)).toBeNull();
    expect(chapterLinkUnder('## A\n\n[B](entry:k1)\n', 0, 2)).toBeNull();
    expect(chapterLinkUnder(`## A\n\n${link}\n`, 0, 2)?.lid).toBe('k1');
  });
});

describe('本当にここから出た子か(isOwnChapterChild) #1439', () => {
  const rel = [{ kind: 'provenance', fromLid: 'kid', toLid: 'p1' }];
  const body = `## A\n\n${chapterLinkLine('A', 'kid')}\n`;
  it('つながりが在り、リンクが 1 つなら true', () => {
    expect(isOwnChapterChild(rel, 'p1', 'kid', body)).toBe(true);
  });
  it('つながりが無ければ false(リンクの複製) / 向き・親・種類が違っても false', () => {
    expect(isOwnChapterChild([], 'p1', 'kid', body)).toBe(false);
    expect(isOwnChapterChild([{ kind: 'provenance', fromLid: 'p1', toLid: 'kid' }], 'p1', 'kid', body)).toBe(false);
    expect(isOwnChapterChild(rel, 'p2', 'kid', body)).toBe(false);
    expect(isOwnChapterChild([{ kind: 'semantic', fromLid: 'kid', toLid: 'p1' }], 'p1', 'kid', body)).toBe(false);
  });
  it('同じ親の中にリンクが 2 つ以上なら false / 別の lid の接頭辞では数えない', () => {
    expect(isOwnChapterChild(rel, 'p1', 'kid', `${body}\n${chapterLinkLine('B', 'kid')}\n`)).toBe(false);
    expect(isOwnChapterChild(rel, 'p1', 'kid', `## A\n\n${chapterLinkLine('A', 'kid')}\n\n[x](entry:kid2)\n`)).toBe(true);
  });
});
