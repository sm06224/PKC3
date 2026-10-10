import { describe, expect, it } from 'vitest';
import { caretInTableRow, tableOnTab } from '../../src/features/markdown/table-assist';

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

describe('🔴 升の区切りは画面の読み手と同じ規則(#1426)', () => {
  it('`\\` を k 本続けた直後の `|` ── k の偶奇によらず、画面と同じ列で Tab が移る', async () => {
    const MarkdownIt = (await import('markdown-it')).default;
    const md = new MarkdownIt();
    for (let k = 1; k <= 5; k += 1) {
      const header = `| a${'\\'.repeat(k)}|b | c |`;
      const table = `${header}\n|---|---|\n| x | y |`;
      // 前提: 画面の読み手は 2 列の表として描く(3 列なら区切り行と合わず表にならない)
      const th = (md.render(table).match(/<th>/gu) ?? []).length;
      expect(th, `k=${k}: 読み手が 2 列と読んでいない(前提が崩れている)`).toBe(2);
      const res = tableOnTab(table, 2, false);
      expect(res?.kind, `k=${k}`).toBe('navigate');
      if (res?.kind === 'navigate') {
        expect(table.slice(res.start, res.end), `k=${k}: 2 つ目の升へ移っていない`).toBe('c');
      }
    }
  });
});

describe('🔴 caret が表の行に在るか(#1451。帯の「Tab で次のセル」の判定)', () => {
  it('表の行 / 区切り行 / 行頭の空白つきは true、本文・空行・全角｜・片側だけの | は false', () => {
    const v = '段落\n| a | b |\n|---|---|\n  | 1 | 2 |\n\n｜ x ｜\n| 開いたまま';
    const at = (needle: string): number => v.indexOf(needle) + 1;
    expect(caretInTableRow(v, at('| a'))).toBe(true);
    expect(caretInTableRow(v, at('|---'))).toBe(true);
    expect(caretInTableRow(v, at('| 1'))).toBe(true);
    expect(caretInTableRow(v, 1), '段落').toBe(false);
    expect(caretInTableRow(v, v.indexOf('\n\n') + 1), '空行').toBe(false);
    expect(caretInTableRow(v, at('｜ x')), '全角').toBe(false);
    expect(caretInTableRow(v, at('| 開')), '末尾の | が無い').toBe(false);
  });

  it('🔑 Tab が実際に何かする行(tableOnTab が null でない)と全位置で一致する', () => {
    const v = '段落\n| a | b |\n|---|---|\n  | 1 | 2 |\n\n```\n| in | fence |\n```\n| a\\|b | c |';
    let tableHits = 0;
    for (let i = 0; i <= v.length; i += 1) {
      const real = tableOnTab(v, i, false) !== null;
      if (real) tableHits += 1;
      expect(caretInTableRow(v, i), `caret ${i}`).toBe(real);
    }
    expect(tableHits, '表の行が 1 つも通っていない').toBeGreaterThan(20);
  });
});
