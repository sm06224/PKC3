/**
 * 🔴 **「最近使った操作」の規則**(#274。🟣 Gemini 裁定 A)。**pure** な部分だけ。
 *
 * ⚠ 画面に出るか / 実行で憶えるかの繋がりは `tests/adapter/command-list.test.ts`、
 *   置き場(保存が使えない端末)は `tests/adapter/recent-commands-store.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import {
  RECENT_COMMANDS_MAX,
  pushRecentCommand,
  splitRecentRows,
} from '../../src/features/palette/recent-commands';

const row = (id: string) => ({ id, label: `名前-${id}` });
const ROWS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(row);

describe('pushRecentCommand', () => {
  it('新しい物が先頭に来る', () => {
    expect(pushRecentCommand(['a'], 'b')).toEqual(['b', 'a']);
  });

  it('🔴 同じ操作は 1 行 ── 既にあれば先頭へ動く(2 行にならない)', () => {
    expect(pushRecentCommand(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(pushRecentCommand(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });

  it('🔴 上限は 5(6 件目で最古が落ちる)', () => {
    expect(RECENT_COMMANDS_MAX, '上限が 5 でなくなった(画面の約束が変わる)').toBe(5);
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].reduce<string[]>((l, id) => pushRecentCommand(l, id), []);
    expect(six).toEqual(['f', 'e', 'd', 'c', 'b']);
  });

  it('空の id は積まない・元の配列を壊さない', () => {
    const src = ['a'];
    expect(pushRecentCommand(src, '')).toEqual(['a']);
    pushRecentCommand(src, 'b');
    expect(src).toEqual(['a']);
  });
});

describe('splitRecentRows', () => {
  it('🔴 名前がまだ無い(空 / 空白だけ)ときだけ節が出る・1 字でも打てば出ない', () => {
    expect(splitRecentRows('', ROWS, ['c']).recent.map((r) => r.id)).toEqual(['c']);
    expect(splitRecentRows('  ', ROWS, ['c']).recent.map((r) => r.id), '空白だけは名前ではない').toEqual(
      ['c'],
    );
    const typed = splitRecentRows('a', ROWS, ['c']);
    expect(typed.recent, '打ち始めたのに節が出る').toEqual([]);
    expect(typed.rest, '絞り込みの結果をそのまま返す').toBe(ROWS);
  });

  it('🔴 新しい順・5 件まで・残りは元の並びのまま(節の行は残りから外れる)', () => {
    const ids = ['g', 'f', 'e', 'd', 'c', 'b', 'a']; // 7 件憶えている
    const { recent, rest } = splitRecentRows('', ROWS, ids);
    expect(recent.map((r) => r.id)).toEqual(['g', 'f', 'e', 'd', 'c']);
    expect(rest.map((r) => r.id), '節に出さなかった b, a は普通の一覧に残る').toEqual([
      'a',
      'b',
      'h',
    ]);
  });

  it('🔴 いまの一覧に無い id(消えた操作)は落とす', () => {
    const { recent, rest } = splitRecentRows('', ROWS, ['gone', 'b', 'gone2', 'a']);
    expect(recent.map((r) => r.id)).toEqual(['b', 'a']);
    expect(rest.length).toBe(ROWS.length - 2);
    // 消えた id が先頭の 5 枠を食わない(7 件中 2 件が消えていても 5 件出る)
    const many = ['x1', 'x2', 'a', 'b', 'c', 'd', 'e'];
    expect(splitRecentRows('', ROWS, many).recent.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('🔴 0 件ならそのまま(節は空・一覧は触らない)', () => {
    const none = splitRecentRows('', ROWS, ['gone']);
    expect(none.recent).toEqual([]);
    expect(none.rest).toBe(ROWS);
    expect(splitRecentRows('', ROWS, []).recent).toEqual([]);
  });

  it('同じ id が重ねて入っていても 1 行', () => {
    expect(splitRecentRows('', ROWS, ['a', 'a', 'b']).recent.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
