import { describe, expect, it } from 'vitest';
import { sortTasksByStatus } from '../../src/features/markdown/task-sort';

describe('sortTasksByStatus #1108', () => {
  it('未完了項目と完了項目が混在するリストで、完了項目が末尾へ移動する', () => {
    const input = [
      '- [x] 完了タスク1',
      '- [ ] 未完了タスク1',
      '- [x] 完了タスク2',
      '- [ ] 未完了タスク2',
    ].join('\n');

    const expected = [
      '- [ ] 未完了タスク1',
      '- [ ] 未完了タスク2',
      '- [x] 完了タスク1',
      '- [x] 完了タスク2',
    ].join('\n');

    expect(sortTasksByStatus(input)).toBe(expected);
  });

  it('すでに完了項目が末尾に揃っている場合は元の文字列をそのまま返す（同一参照/値）', () => {
    const input = [
      '- [ ] 未完了タスク1',
      '- [ ] 未完了タスク2',
      '- [x] 完了タスク1',
      '- [x] 完了タスク2',
    ].join('\n');

    expect(sortTasksByStatus(input)).toBe(input);
  });

  it('すべて完了、またはすべて未完了の場合も元の文字列を返す', () => {
    const allDone = '- [x] 済1\n- [x] 済2';
    expect(sortTasksByStatus(allDone)).toBe(allDone);

    const allTodo = '- [ ] 未1\n- [ ] 未2';
    expect(sortTasksByStatus(allTodo)).toBe(allTodo);
  });

  it('タスク項目を持たない通常のリストは順序が変わらない', () => {
    const input = '- りんご\n- みかん\n- バナナ';
    expect(sortTasksByStatus(input)).toBe(input);
  });

  it('親タスクにインデントされた子行・説明テキストが親と一緒に移動する', () => {
    const input = [
      '- [x] 完了タスクA',
      '  完了したタスクのメモや詳細',
      '  複数行にわたる説明',
      '- [ ] 未完了タスクB',
      '  未完了タスクの詳細メモ',
    ].join('\n');

    const expected = [
      '- [ ] 未完了タスクB',
      '  未完了タスクの詳細メモ',
      '- [x] 完了タスクA',
      '  完了したタスクのメモや詳細',
      '  複数行にわたる説明',
    ].join('\n');

    expect(sortTasksByStatus(input)).toBe(expected);
  });

  it('親タスク配下の子タスクも未完了→完了の順に再帰的に整列される', () => {
    const input = [
      '- [ ] 親タスク1',
      '  - [x] 子タスク1-A',
      '  - [ ] 子タスク1-B',
      '- [x] 親タスク2',
      '  - [x] 子タスク2-A',
      '  - [ ] 子タスク2-B',
    ].join('\n');

    const expected = [
      '- [ ] 親タスク1',
      '  - [ ] 子タスク1-B',
      '  - [x] 子タスク1-A',
      '- [x] 親タスク2',
      '  - [ ] 子タスク2-B',
      '  - [x] 子タスク2-A',
    ].join('\n');

    expect(sortTasksByStatus(input)).toBe(expected);
  });

  it('空行で区切られた複数のリストブロックが独立して整列される', () => {
    const input = [
      '### 午前',
      '- [x] タスク1',
      '- [ ] タスク2',
      '',
      '### 午後',
      '- [x] タスク3',
      '- [ ] タスク4',
    ].join('\n');

    const expected = [
      '### 午前',
      '- [ ] タスク2',
      '- [x] タスク1',
      '',
      '### 午後',
      '- [ ] タスク4',
      '- [x] タスク3',
    ].join('\n');

    expect(sortTasksByStatus(input)).toBe(expected);
  });

  it('コードブロック（fence）内のテキストは 1 バイトも触らない', () => {
    const input = [
      '```markdown',
      '- [x] コードの中のタスク1',
      '- [ ] コードの中のタスク2',
      '```',
      '- [x] 本文のタスク1',
      '- [ ] 本文のタスク2',
    ].join('\n');

    const expected = [
      '```markdown',
      '- [x] コードの中のタスク1',
      '- [ ] コードの中のタスク2',
      '```',
      '- [ ] 本文のタスク2',
      '- [x] 本文のタスク1',
    ].join('\n');

    expect(sortTasksByStatus(input)).toBe(expected);
  });

  it('大文字 [X] と小文字 [x] の両方を完了とみなす', () => {
    const input = [
      '- [X] 大文字完了',
      '- [ ] 未完了',
      '- [x] 小文字完了',
    ].join('\n');

    const expected = [
      '- [ ] 未完了',
      '- [X] 大文字完了',
      '- [x] 小文字完了',
    ].join('\n');

    expect(sortTasksByStatus(input)).toBe(expected);
  });

  it('記号が * や + や番号付きリストでも対応する', () => {
    const input = [
      '* [x] 完了A',
      '* [ ] 未完了B',
      '+ [x] 完了C',
      '+ [ ] 未完了D',
    ].join('\n');

    const expected = [
      '* [ ] 未完了B',
      '+ [ ] 未完了D',
      '* [x] 完了A',
      '+ [x] 完了C',
    ].join('\n');

    expect(sortTasksByStatus(input)).toBe(expected);
  });

  it('タスクを持たない空文字列やテキストのみの場合はそのまま返す', () => {
    expect(sortTasksByStatus('')).toBe('');
    expect(sortTasksByStatus('通常の段落のみの本文')).toBe('通常の段落のみの本文');
  });
});
