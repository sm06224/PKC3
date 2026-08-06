/**
 * 🔴 **塊を跨ぐ取り消し**(2026-08-05。ライブエディタ S8。設計 §9 論点 C)。
 *
 * ここで守るのは 4 つ。どれも「緑のまま壊れる」形が実在する:
 *
 * ① **戻した本文が元と 1 byte 一致する** ── 「だいたい戻った」は取り消しではない。
 *    とくに**末尾への書き足し**(置き換えた行が 0 件)は、素朴な実装だと
 *    空行が 1 本残る / 1 行余分に消える
 * ② 🔴 **本文が食い違ったら当てない** ── 外から差し替わった後に盲目的に当てると
 *    **無関係な行を潰す**。照合の材料(記録した行そのもの)を持っているので使う
 * ③ **やり直しの先は捨てる** ── 戻してから別の編集をしたら、古い「やり直し」は
 *    もう当たらない場所を指している
 * ④ **上限で古いものから落ちる** ── 常駐が編集回数で増えない(user 指示「効くのは定常」)
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_JOURNAL,
  JOURNAL_LIMIT,
  record,
  redo,
  spliceLines,
  stepFor,
  undo,
  type Journal,
} from '../../src/features/markdown/edit-journal';

const DOC = ['# 題', '', '最初の段落。', '', '次の段落。'].join('\n');

/** 確定 1 件(`RowSwap` → `detail.ts` と同じ順序で組む)。 */
function commit(
  text: string,
  j: Journal,
  start: number,
  endIncl: number,
  replacement: string,
): { text: string; journal: Journal } {
  return {
    journal: record(j, stepFor(text, start, endIncl, replacement)),
    text: spliceLines(text, start, endIncl, replacement),
  };
}

describe('spliceLines(継ぎ足しの規則は 1 か所)', () => {
  it('1 行を置き換える', () => {
    expect(spliceLines(DOC, 2, 2, '書き換えた。')).toBe(
      ['# 題', '', '書き換えた。', '', '次の段落。'].join('\n'),
    );
  });

  it('複数行を 1 行に畳む', () => {
    expect(spliceLines(DOC, 2, 4, 'ぜんぶ 1 行に')).toBe(['# 題', '', 'ぜんぶ 1 行に'].join('\n'));
  });

  it('1 行を複数行に広げる', () => {
    expect(spliceLines(DOC, 2, 2, 'あ\nい')).toBe(
      ['# 題', '', 'あ', 'い', '', '次の段落。'].join('\n'),
    );
  });

  it('🔑 空区間(start = 行数)は**末尾への挿入**になる(規則を分岐させない)', () => {
    const lines = DOC.split('\n');
    expect(spliceLines(DOC, lines.length, lines.length - 1, '足した。')).toBe(DOC + '\n足した。');
  });
});

describe('取り消し / やり直し', () => {
  it('① 1 件戻すと元の本文に**1 byte 一致**で戻る', () => {
    const a = commit(DOC, EMPTY_JOURNAL, 2, 2, '書き換えた。');
    expect(a.text).not.toBe(DOC);
    const back = undo(a.journal, a.text);
    expect(back).not.toBeNull();
    expect(back!.text).toBe(DOC);
    // やり直すと戻る
    const fwd = redo(back!.journal, back!.text);
    expect(fwd!.text).toBe(a.text);
  });

  it('① 🔴 末尾への書き足しも 1 byte 一致で戻る(置き換えた行が 0 件の形)', () => {
    const lines = DOC.split('\n');
    const a = commit(DOC, EMPTY_JOURNAL, lines.length, lines.length - 1, '足した。');
    expect(a.text).toBe(DOC + '\n足した。');
    // 前提: この形は「置き換えた行が 0 件」= 素朴な実装が必ず外す次元
    expect(a.journal.past[0]!.removed).toEqual([]);
    expect(undo(a.journal, a.text)!.text).toBe(DOC);
  });

  it('① 行数が増える編集・減る編集の両方が戻る', () => {
    for (const [start, end, text] of [
      [2, 2, 'あ\nい\nう'],
      [2, 4, 'ひとつに'],
    ] as const) {
      const a = commit(DOC, EMPTY_JOURNAL, start, end, text);
      expect(a.text).not.toBe(DOC);
      expect(undo(a.journal, a.text)!.text, `${start}-${end} が戻らない`).toBe(DOC);
    }
  });

  it('① 複数件を順に戻せる(最後に確定したものから)', () => {
    let s = commit(DOC, EMPTY_JOURNAL, 2, 2, '1 回目。');
    s = commit(s.text, s.journal, 4, 4, '2 回目。');
    const b1 = undo(s.journal, s.text)!;
    expect(b1.text.split('\n')[4]).toBe('次の段落。');
    expect(b1.text.split('\n')[2]).toBe('1 回目。');
    const b2 = undo(b1.journal, b1.text)!;
    expect(b2.text).toBe(DOC);
    expect(undo(b2.journal, b2.text), '空の履歴から戻せてしまう').toBeNull();
  });

  it('② 🔴 本文が食い違ったら当てない(外から差し替わった後)', () => {
    const a = commit(DOC, EMPTY_JOURNAL, 2, 2, '書き換えた。');
    // 取り込み / 別タブの保存で本文が入れ替わった
    const outside = ['まったく別の本文', '', 'もう 1 行'].join('\n');
    expect(undo(a.journal, outside), '別の本文へ盲目的に当てた').toBeNull();
    // ⚠ 行数が足りている「当たりそうな」本文でも拒む(中身で照合している)
    const sameShape = ['# 題', '', 'ちがう行。', '', '次の段落。'].join('\n');
    expect(undo(a.journal, sameShape)).toBeNull();
  });

  it('② やり直しも同じく照合する', () => {
    const a = commit(DOC, EMPTY_JOURNAL, 2, 2, '書き換えた。');
    const back = undo(a.journal, a.text)!;
    const outside = ['ぜんぜん別', ''].join('\n');
    expect(redo(back.journal, outside)).toBeNull();
    // 正しい本文なら通る
    expect(redo(back.journal, back.text)!.text).toBe(a.text);
  });

  it('③ 戻してから別の編集をしたら、やり直しは消える', () => {
    const a = commit(DOC, EMPTY_JOURNAL, 2, 2, '書き換えた。');
    const back = undo(a.journal, a.text)!;
    expect(back.journal.future).toHaveLength(1);
    const other = commit(back.text, back.journal, 4, 4, '別の編集。');
    expect(other.journal.future, 'やり直しの先が残っている(歴史が分岐する)').toHaveLength(0);
    expect(redo(other.journal, other.text)).toBeNull();
  });

  it('④ 上限を超えたら古いものから落ちる(常駐が編集回数で増えない)', () => {
    let s = { text: DOC, journal: EMPTY_JOURNAL };
    for (let i = 0; i < 5; i += 1) s = commit(s.text, s.journal, 2, 2, `${i} 回目。`);
    const capped = record(s.journal, stepFor(s.text, 2, 2, 'x'), 3);
    expect(capped.past).toHaveLength(3);
    // 最新側が残る(古い方が落ちる)
    expect(capped.past[capped.past.length - 1]!.inserted).toEqual(['x']);
    expect(JOURNAL_LIMIT).toBeGreaterThan(0);
  });

  it('④ 既定の上限でも溢れる(上限が実際に効いている)', () => {
    let j = EMPTY_JOURNAL;
    for (let i = 0; i < JOURNAL_LIMIT + 10; i += 1) {
      j = record(j, { start: 0, removed: [], inserted: [String(i)] });
    }
    expect(j.past).toHaveLength(JOURNAL_LIMIT);
    expect(j.past[j.past.length - 1]!.inserted).toEqual([String(JOURNAL_LIMIT + 9)]);
  });
});
