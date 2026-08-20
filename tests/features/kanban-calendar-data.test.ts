import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  clipTaskText,
  groupTasksByStatus,
  replaceTaskCards,
  taskCardKey,
  TASK_LIMITS,
  type TaskCard,
} from '../../src/features/kanban/kanban-data';
import {
  groupEntriesByDate,
  getMonthGrid,
  dateKey,
} from '../../src/features/calendar/calendar-data';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'todo',
    createdAt: null,
    updatedAt: null,
    entryOrder: 0,
    status: 'open',
    date: null,
    archived: false,
    bodyChars: null,
    ...over,
  };
}

/**
 * 🔴 **カンバンの単位はチェック項目**(#277 段②-b)。
 * ⚠ 2026-08-19 に主張を裏返した ── 以前は「`todo` アーキタイプのノート 1 件 =
 *   札 1 枚」で、`archetype !== 'todo'` を落とすことを pin していた。しかし
 *   **todo は封印中で作れない**ので、その規則では盤面に何も出せる人が居なかった。
 */
describe('kanban-data(札 = 本文のチェック項目)', () => {
  const card = (lid: string, line: number, done: boolean, text = 'x'): TaskCard => ({
    lid,
    line,
    text,
    done,
  });

  it('印の有無で列に振り分け、入力順を保つ', () => {
    const grouped = groupTasksByStatus([
      card('a', 0, false),
      card('a', 3, true),
      card('b', 1, false),
    ]);
    expect(grouped.open.map(taskCardKey)).toEqual(['a 0', 'b 1']);
    expect(grouped.done.map(taskCardKey)).toEqual(['a 3']);
  });

  /**
   * 🔴 **鍵は lid だけでは足りない** ── 1 つのノートに項目は何個でもある。
   * ⚠ lid で鍵を作ると、同じノートの 2 枚目以降が**同じ札として潰れる**。
   */
  it('🔴 札の鍵は lid と行番号の対', () => {
    expect(taskCardKey(card('a', 0, false))).not.toBe(taskCardKey(card('a', 1, false)));
    expect(taskCardKey(card('a', 0, false))).not.toBe(taskCardKey(card('b', 0, false)));
  });

  it('長い項目は丸めて、丸めたことが判る形にする', () => {
    const long = 'あ'.repeat(TASK_LIMITS.textChars + 10);
    const clipped = clipTaskText(long);
    expect(clipped.length, '上限を超えたまま出している').toBe(TASK_LIMITS.textChars + 1);
    expect(clipped.endsWith('…'), '丸めたことが判らない').toBe(true);
    // ⚠ 上限ちょうどは**丸めない**(境目で 1 字消える事故を止める)
    const exact = 'い'.repeat(TASK_LIMITS.textChars);
    expect(clipTaskText(exact)).toBe(exact);
  });

  describe('1 件のノートの札だけを差し替える(押した札を往復なしで動かす)', () => {
    const board: TaskCard[] = [
      card('a', 0, false, 'a0'),
      card('a', 2, false, 'a2'),
      card('b', 0, false, 'b0'),
    ];

    it('🔴 並びを保ったまま、その lid の区間だけ入れ替わる', () => {
      const next = replaceTaskCards(board, 'a', [
        { line: 0, text: 'a0', done: true },
        { line: 2, text: 'a2', done: false },
      ]);
      expect(next.map((c) => `${c.lid}${c.line}:${c.done ? 'x' : ' '}`)).toEqual([
        'a0:x',
        'a2: ',
        'b0: ',
      ]);
    });

    it('項目が減っても増えても、他のノートの札は動かない', () => {
      const fewer = replaceTaskCards(board, 'a', [{ line: 0, text: 'a0', done: false }]);
      expect(fewer.map(taskCardKey)).toEqual(['a 0', 'b 0']);
      const more = replaceTaskCards(board, 'a', [
        { line: 0, text: 'a0', done: false },
        { line: 1, text: 'new', done: false },
        { line: 2, text: 'a2', done: false },
      ]);
      expect(more.map(taskCardKey)).toEqual(['a 0', 'a 1', 'a 2', 'b 0']);
    });

    /**
     * ⚠ 盤面に居ないノートは**入れない**(どこへ入れるべきかは worker しか知らない)。
     * 🔑 そして**同じ配列を返す** ── 描画側の指紋を無駄に壊さない。
     */
    it('🔴 盤面に居ない lid は入れず、配列の同一性も保つ', () => {
      const same = replaceTaskCards(board, 'zzz', [{ line: 0, text: 'x', done: false }]);
      expect(same).toBe(board);
    });

    it('差し替えた札の字も丸める(生の本文をそのまま出さない)', () => {
      const long = 'う'.repeat(TASK_LIMITS.textChars + 5);
      const next = replaceTaskCards(board, 'b', [{ line: 0, text: long, done: false }]);
      expect(next[next.length - 1]?.text.endsWith('…')).toBe(true);
    });
  });
});

describe('calendar-data', () => {
  /**
   * 🔴 **`date` を持つ**ノートを日付ごとにまとめる(#276)。
   *
   * ⚠ 2026-08-19 に**主張を裏返した**。以前は「date を持つ **todo だけ**」で、
   *   `archetype: 'text'` の行が出ないことを pin していた ── しかし
   *   **todo は封印中**なので、その規則ではこの面に何も出せる人が居ない。
   */
  it('🔴 date を持つノートを日付ごとにまとめ、showArchived を尊重', () => {
    const metas = [
      meta('a', { date: '2026-08-01' }),
      meta('b', { date: '2026-08-01', archived: true }),
      meta('c'), // date なし
      meta('d', { date: '2026-08-02', archetype: 'text' }),
    ];
    expect(groupEntriesByDate(metas, false)['2026-08-01']?.map((m) => m.lid)).toEqual(['a']);
    expect(groupEntriesByDate(metas, true)['2026-08-01']?.map((m) => m.lid)).toEqual([
      'a',
      'b',
    ]);
    // 🔴 普通のノートも出る(ここが裏返った所)
    expect(
      groupEntriesByDate(metas, true)['2026-08-02']?.map((m) => m.lid),
      '普通のノートがカレンダーに出ない(todo だけの規則が残っている)',
    ).toEqual(['d']);
    // ⚠ date を書いていないものは、どちらでも出ない
    expect(Object.values(groupEntriesByDate(metas, true)).flat().map((m) => m.lid)).not.toContain(
      'c',
    );
  });

  it('月間グリッド: 2026-08 は土曜始まり 31 日', () => {
    const grid = getMonthGrid(2026, 8);
    expect(grid[0]).toEqual([null, null, null, null, null, null, 1]); // 8/1 = Sat
    const days = grid.flat().filter((d) => d !== null);
    expect(days.length).toBe(31);
    expect(days[30]).toBe(31);
    expect(dateKey(2026, 8, 3)).toBe('2026-08-03');
  });
});

/**
 * 🔴 **変わっていないなら、同じ配列を返す**(2026-08-20)。
 *
 * ⚠ 2026-08-20 に「新しい本文が state に入る所は**全部**札を組み直す」へ広げた結果、
 *   `BODY_LOADED`(= **ノートを押すたび**に飛ぶ)もここを通るようになった。
 *   値が同じでも新しい配列を返していると、**押すだけで盤面の指紋が壊れ**、
 *   そのノートの札が毎回描き直される。
 * 🔑 だから**値で**突き合わせる ── `next` は毎回作り直すので、参照比較では
 *   「変わっていない」を 1 度も検出できない。
 */
describe('replaceTaskCards は、変わっていないなら据え置く(2026-08-20)', () => {
  const card = (lid: string, line: number, text: string, done = false) => ({
    lid,
    line,
    text,
    done,
  });

  /**
   * ⚠ **同じ lid の札は連続させて置く** ── worker はノート順に返すので実際そうなる。
   *   飛び飛びの並びを渡すと、この関数は仕様どおり**まとめ直す**(D-3 の安全網)ので、
   *   「変わっていない」にはならない。1 稿目はそこを取り違えて落ちた。
   */
  it('🔴 同じ内容を渡したら、同じ配列オブジェクトが返る', () => {
    const cards = [card('a', 0, 'あ'), card('a', 5, 'う', true), card('b', 2, 'い')];
    const same = replaceTaskCards(cards, 'a', [
      { line: 0, text: 'あ', done: false },
      { line: 5, text: 'う', done: true },
    ]);
    expect(same, '中身が同じなのに新しい配列を返した(押すたび描き直しになる)').toBe(cards);
  });

  /**
   * ⚠ **飛び飛びの並びは「変わった」側**でよい ── まとめ直すのが正しい動きなので、
   *   据え置いてはいけない(据え置くと札が 1 枚黙って消える D-3 の穴に戻る)。
   */
  it('飛び飛びに並んでいたら、まとめ直して新しい配列を返す', () => {
    const cards = [card('a', 0, 'あ'), card('b', 2, 'い'), card('a', 5, 'う', true)];
    const next = replaceTaskCards(cards, 'a', [
      { line: 0, text: 'あ', done: false },
      { line: 5, text: 'う', done: true },
    ]);
    expect(next, 'まとめ直していない').not.toBe(cards);
    expect(next.map((c) => `${c.lid}${c.line}`)).toEqual(['a0', 'a5', 'b2']);
  });

  it('⚠ 空振り防止: 中身が変われば新しい配列になる', () => {
    const cards = [card('a', 0, 'あ'), card('b', 2, 'い')];
    expect(
      replaceTaskCards(cards, 'a', [{ line: 0, text: 'あ', done: true }]),
      '印が変わったのに据え置いた',
    ).not.toBe(cards);
    expect(
      replaceTaskCards(cards, 'a', [{ line: 1, text: 'あ', done: false }]),
      '行番号が変わったのに据え置いた',
    ).not.toBe(cards);
    expect(
      replaceTaskCards(cards, 'a', [{ line: 0, text: 'ちがう', done: false }]),
      '字が変わったのに据え置いた',
    ).not.toBe(cards);
    expect(replaceTaskCards(cards, 'a', []), '札が消えたのに据え置いた').not.toBe(cards);
  });

  /**
   * ⚠ **丸めた後で突き合わせる** ── 上限(200 字)を超える字は `clipTaskText` が
   *   切るので、切る前の字で比べると「変わっていない」を取り逃がす。
   */
  it('長い字は丸めた形で突き合わせる', () => {
    const long = 'あ'.repeat(300);
    const clipped = replaceTaskCards([card('a', 0, 'x')], 'a', [
      { line: 0, text: long, done: false },
    ]);
    const again = replaceTaskCards(clipped, 'a', [{ line: 0, text: long, done: false }]);
    expect(again, '丸めた後の字で比べていない').toBe(clipped);
  });
});
