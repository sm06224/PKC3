import { describe, expect, it } from 'vitest';
import { tableOnTab } from '../../src/features/markdown/table-assist';

describe('🔴 Markdown 表の編集アシスト (Tab / Shift+Tab) (#1093)', () => {
  it('表の外(通常の段落)では null を返す(通常動作を妨げない)', () => {
    const text = '通常の段落です\n次の行です';
    expect(tableOnTab(text, 3, false)).toBeNull();
    expect(tableOnTab(text, 3, true)).toBeNull();
  });

  it('表のセル内で Tab を押すと、次の列のセルへカーソルが移る', () => {
    const table = '| 名前 | 年齢 | 備考 |\n|---|---|---|\n| アリス | 20 | 学生 |';
    // '名前' の位置 (インデックス 3)
    const res = tableOnTab(table, 3, false);
    expect(res).not.toBeNull();
    expect(res?.kind).toBe('navigate');
    // 次のセル '年齢' のテキスト範囲
    if (res?.kind === 'navigate') {
      expect(table.slice(res.start, res.end)).toBe('年齢');
    }
  });

  it('表のセル内で Shift+Tab を押すと、前の列のセルへカーソルが移る', () => {
    const table = '| 名前 | 年齢 | 備考 |\n|---|---|---|\n| アリス | 20 | 学生 |';
    // '年齢' の位置 (インデックス 8)
    const res = tableOnTab(table, 8, true);
    expect(res).not.toBeNull();
    expect(res?.kind).toBe('navigate');
    if (res?.kind === 'navigate') {
      expect(table.slice(res.start, res.end)).toBe('名前');
    }
  });

  it('ヘッダー行の末尾セルで Tab を押すと、区切り行をスキップして第1データ行の第1セルへ移る', () => {
    const table = '| 名前 | 年齢 |\n|---|---|\n| アリス | 20 |';
    // ヘッダー '年齢' (インデックス 8)
    const res = tableOnTab(table, 8, false);
    expect(res).not.toBeNull();
    expect(res?.kind).toBe('navigate');
    if (res?.kind === 'navigate') {
      expect(table.slice(res.start, res.end)).toBe('アリス');
    }
  });

  it('第1データ行の第1セルで Shift+Tab を押すと、区切り行をスキップしてヘッダー行の末尾セルへ戻る', () => {
    const table = '| 名前 | 年齢 |\n|---|---|\n| アリス | 20 |';
    // 'アリス' (インデックス 25)
    const alicePos = table.indexOf('アリス');
    const res = tableOnTab(table, alicePos, true);
    expect(res).not.toBeNull();
    expect(res?.kind).toBe('navigate');
    if (res?.kind === 'navigate') {
      expect(table.slice(res.start, res.end)).toBe('年齢');
    }
  });

  it('表の最初のセルで Shift+Tab を押すと null を返す(表の外へ抜けられる)', () => {
    const table = '| 名前 | 年齢 |\n|---|---|\n| アリス | 20 |';
    const res = tableOnTab(table, 2, true);
    expect(res).toBeNull();
  });

  it('データ行の末尾セルで Tab を押したとき、次のデータ行があればその第1セルへ移る', () => {
    const table = '| 名前 | 年齢 |\n|---|---|\n| アリス | 20 |\n| ボブ | 25 |';
    const pos20 = table.indexOf('20');
    const res = tableOnTab(table, pos20, false);
    expect(res).not.toBeNull();
    expect(res?.kind).toBe('navigate');
    if (res?.kind === 'navigate') {
      expect(table.slice(res.start, res.end)).toBe('ボブ');
    }
  });

  it('表の最終行・最終セルで Tab を押すと、新しい空行が追加される', () => {
    const table = '| 名前 | 年齢 |\n|---|---|\n| アリス | 20 |';
    const pos20 = table.indexOf('20');
    const res = tableOnTab(table, pos20, false);
    expect(res).not.toBeNull();
    expect(res?.kind).toBe('insert-row');
    if (res?.kind === 'insert-row') {
      expect(res.insertPos).toBe(table.length);
      expect(res.text).toBe('\n|   |   |');
      const updated = table + res.text;
      // 新しい行の第1セルにキャレットが位置する
      expect(updated.slice(res.start - 1, res.start + 2)).toBe('   ');
    }
  });

  it('インデントされた表でも、インデントを維持して新行が追加される', () => {
    const table = '  | 項目 | 値 |\n  |---|---|\n  | A | 1 |';
    const pos1 = table.indexOf('1');
    const res = tableOnTab(table, pos1, false);
    expect(res).not.toBeNull();
    expect(res?.kind).toBe('insert-row');
    if (res?.kind === 'insert-row') {
      expect(res.text).toBe('\n  |   |   |');
    }
  });

  it('エスケープされたパイプ (\\|) をセル区切りと誤認しない', () => {
    const table = '| 条件 \\| 式 | 判定 |\n|---|---|\n| a \\| b | 真 |';
    const posCond = table.indexOf('条件');
    const res = tableOnTab(table, posCond, false);
    expect(res).not.toBeNull();
    expect(res?.kind).toBe('navigate');
    if (res?.kind === 'navigate') {
      expect(table.slice(res.start, res.end)).toBe('判定');
    }
  });
});
