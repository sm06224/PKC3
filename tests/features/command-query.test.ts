/**
 * 🔴 **探す欄の `>` の判定**(#274 段①。姿 = D)。
 *
 * 読み口は `commandQueryOf` 1 つ ── 描く側(`browse.ts`)・本文検索を撃つか(`reduce`)・
 * 検索語の記録(`search-log`)の 3 か所が同じ答えを得る。ここでは**判定そのもの**と、
 * 3 か所のうち純粋な 2 つ(`reduce` / `search-log`)が**その判定に従う**ことを見る。
 */
import { describe, expect, it } from 'vitest';
import { COMMAND_PREFIXES, commandQueryOf } from '../../src/features/palette/command-query';
import { pushSearchTerm } from '../../src/features/history/search-log';
import { initialState, reduce } from '../../src/adapter/state/app-state';

describe('commandQueryOf', () => {
  it('🔴 先頭が `>` なら、印を除いた探し語を返す', () => {
    expect(commandQueryOf('>')).toBe('');
    expect(commandQueryOf('>ノート')).toBe('ノート');
    // ⚠ 空白は削らない(`paletteRows` が自分で削る ── 判定を 2 つにしない)
    expect(commandQueryOf('> ノート')).toBe(' ノート');
  });

  it('🔴 日本語入力のまま打った全角の `＞` も同じに扱う(#764 の「打ち方の次元」)', () => {
    expect(commandQueryOf('＞ノート')).toBe('ノート');
    expect(COMMAND_PREFIXES).toContain('＞');
  });

  it('🔴 先頭でなければ検索語である(`a > b` を探す人が居る)', () => {
    expect(commandQueryOf('a > b')).toBeNull();
    expect(commandQueryOf(' >x')).toBeNull();
    expect(commandQueryOf('')).toBeNull();
    expect(commandQueryOf('ノート')).toBeNull();
  });
});

describe('`>` で始まる字は、本文を探さず・検索語として憶えない', () => {
  it('🔴 `>` を打っても REQUEST_SEARCH は出ない(対照群: 普通の語は出る)', () => {
    const ev = (q: string) => reduce(initialState, { type: 'SET_ENTRY_FILTER', query: q }).events;
    expect(ev('会議'), '対照群が崩れている(普通の語で検索が出ない)').toEqual([
      { type: 'REQUEST_SEARCH', query: '会議' },
    ]);
    expect(ev('>会議'), '操作を探しているのに本文を引こうとしている').toEqual([]);
    expect(ev('＞会議'), '全角の `＞` で本文を引こうとしている').toEqual([]);
    // 🔑 欄の字は state に写る(描く側が読む正本)
    expect(
      reduce(initialState, { type: 'SET_ENTRY_FILTER', query: '>会議' }).state.filterQuery,
    ).toBe('>会議');
  });

  it('🔴 `>` で始まる字は検索語の記録に積まない(対照群: 普通の語は積む)', () => {
    expect(pushSearchTerm([], '会議メモ'), '対照群が崩れている').toEqual(['会議メモ']);
    expect(pushSearchTerm(['keep'], '>ノートを作る')).toEqual(['keep']);
    expect(pushSearchTerm(['keep'], '＞ノートを作る')).toEqual(['keep']);
    // ⚠ 途中の `>` は検索語 ── 積む
    expect(pushSearchTerm([], 'a > b')).toEqual(['a > b']);
  });
});
