/**
 * 🔴 **テキスト整形の組み合わせ**(#1233)。純関数なので、期待値は**手で書いた固定の字**で守る
 * (実装と同じ関数で期待値を作らない)。
 */
import { describe, expect, it } from 'vitest';
import {
  badRegexFlags,
  joinParagraphLines,
  labNoteTitle,
  labSummary,
  LAB_OPS,
  LAB_REGEX_MAX_CHARS,
  markdownTablesToText,
  runTextLab,
  textToMarkdownTable,
  type LabRecipe,
} from '../../src/features/markdown/text-lab';

const none: LabRecipe = { ops: [], table: 'none', regex: null };

describe('段落ごとに改行を詰める', () => {
  it('空行は段落の境目として残り、段落の中だけ結ぶ(日本語は空白なし・英数字は半角空白)', () => {
    expect(joinParagraphLines('これは\n折り返した\n文です\n\nhello\nworld\n\n末尾')).toBe(
      'これは折り返した文です\n\nhello world\n\n末尾',
    );
  });
  it('対照: 段落が 2 つ残る(全体を 1 行にしない)', () => {
    expect(joinParagraphLines('あ\nい\n\nう\nえ').split('\n').length).toBe(3);
  });
});

describe('整えを重ねる', () => {
  it('何も選ばなければ入力のまま(CRLF は LF にそろう)', () => {
    expect(runTextLab('a\r\nb', none).text).toBe('a\nb');
  });
  it('改行詰め + 全角を半角 + 半角カナを全角 を一度に掛ける', () => {
    const out = runTextLab('ＡＢＣ\n１２３\n\nﾃｽﾄ\nﾒﾓ', {
      ops: ['join-lines', 'to-halfwidth', 'kana-to-fullwidth'],
      table: 'none',
      regex: null,
    });
    expect(out.text).toBe('ABC123\n\nテストメモ');
  });
  it('箇条書きの記号を外す・番号を振り直す・空行を減らす', () => {
    expect(runTextLab('- a\n- b', { ops: ['strip-bullets'], table: 'none', regex: null }).text).toBe('a\nb');
    expect(runTextLab('3. a\n7. b', { ops: ['renumber-lists'], table: 'none', regex: null }).text).toBe('1. a\n2. b');
    expect(runTextLab('a\n\n\n\nb', { ops: ['squeeze-blank-lines'], table: 'none', regex: null }).text).toBe('a\n\nb');
  });
  it('入力の文字列は書き換えない(副作用なし)・集合でも配列でも受ける', () => {
    const src = '- a';
    expect(runTextLab(src, { ops: new Set(['strip-bullets']), table: 'none', regex: null }).text).toBe('a');
    expect(src).toBe('- a');
  });
  it('画面に並ぶ整えの全数が、それぞれ結果に効く(押して何も起きない口を置かない)', () => {
    const sample = '- ３.　ﾃｽﾄ\n続き\n\n\n\n3. x\n7. y';
    expect(LAB_OPS.length).toBe(6);
    for (const op of LAB_OPS) {
      const out = runTextLab(sample, { ops: [op.id], table: 'none', regex: null });
      expect(out.text, op.id).not.toBe(sample);
    }
  });
});

describe('表の変換', () => {
  it('CSV / TSV の行を Markdown の表にする(1 行目が見出し・タブが多ければタブで割る)', () => {
    expect(textToMarkdownTable('名前,数\nりんご,3')).toBe('| 名前 | 数 |\n| --- | --- |\n| りんご | 3 |');
    expect(textToMarkdownTable('名前\t数\nりんご\t1,200')).toContain('| りんご | 1,200 |');
    expect(textToMarkdownTable('   ')).toBeNull();
  });
  it('Markdown の表を CSV / TSV にする。表の外の字は残り、表が無ければ null', () => {
    const md = '前置き\n\n| a | b |\n| --- | --- |\n| 1 | x,y |\n\n後書き';
    expect(markdownTablesToText(md, 'csv')).toBe('前置き\n\na,b\n1,"x,y"\n\n後書き');
    expect(markdownTablesToText(md, 'tsv')).toBe('前置き\n\na\tb\n1\tx,y\n\n後書き');
    expect(markdownTablesToText('ただの文', 'csv')).toBeNull();
  });
  it('往復: CSV → 表 → CSV で元に戻る', () => {
    const csv = 'a,b\n1,2';
    const md = runTextLab(csv, { ops: [], table: 'to-markdown', regex: null }).text;
    expect(runTextLab(md, { ops: [], table: 'to-csv', regex: null }).text).toBe(csv);
  });
  it('変換できる表が無ければ tableFound=false で、入力はそのまま', () => {
    const out = runTextLab('文だけ', { ops: [], table: 'to-csv', regex: null });
    expect(out.tableFound).toBe(false);
    expect(out.text).toBe('文だけ');
  });
});

describe('正規表現の置換', () => {
  const re = (pattern: string, replacement: string, flags = 'g'): LabRecipe => ({
    ops: [],
    table: 'none',
    regex: { pattern, replacement, flags },
  });
  it('$1 が使え、当たった数を返す', () => {
    const out = runTextLab('a1 b22 c3', re('([a-z])(\\d+)', '$2$1'));
    expect(out.text).toBe('1a 22b 3c');
    expect(out.regexHits).toBe(3);
  });
  it('旗に g が無ければ最初の 1 つだけ', () => {
    const out = runTextLab('aaa', re('a', 'b', ''));
    expect(out.text).toBe('baa');
    expect(out.regexHits).toBe(1);
  });
  it('空の検索パターンは置換しない', () => {
    expect(runTextLab('abc', re('', 'x')).text).toBe('abc');
  });
  it('読めない正規表現は、入力をそのまま返して理由を言う(例外を投げない)', () => {
    const out = runTextLab('abc', re('(', 'x'));
    expect(out.text).toBe('abc');
    expect(out.regexNote).toContain('正規表現として読めません');
  });
  it('使えない旗・重複した旗は理由を言う', () => {
    expect(badRegexFlags('gi')).toBeNull();
    expect(badRegexFlags('gx')).toBe('x');
    expect(badRegexFlags('gg')).toBe('g');
    expect(runTextLab('a', re('a', 'b', 'y')).regexNote).toContain('旗「y」');
  });
  it('100 万字を超える入力には置換を掛けない', () => {
    const big = 'a'.repeat(LAB_REGEX_MAX_CHARS + 1);
    const out = runTextLab(big, re('a', 'b'));
    expect(out.text).toBe(big);
    expect(out.regexNote).toContain('長すぎる');
  });
  it('置換は他の整えが済んだ後に掛かる(全角を半角にした字に当たる)', () => {
    const out = runTextLab('ＡＢ', {
      ops: ['to-halfwidth'],
      table: 'none',
      regex: { pattern: 'AB', replacement: 'x', flags: 'g' },
    });
    expect(out.text).toBe('x');
  });
});

describe('一言と題名', () => {
  it('入力が空・変わらない・字数・置換の当たりの 4 通りを取り違えない', () => {
    expect(labSummary('', runTextLab('', none), none)).toContain('貼ると');
    expect(labSummary('a', runTextLab('a', none), none)).toBe('変わる所はありません');
    const r: LabRecipe = { ops: ['strip-bullets'], table: 'none', regex: null };
    expect(labSummary('- abc', runTextLab('- abc', r), r)).toBe('5 字 → 3 字');
    const rr: LabRecipe = { ops: [], table: 'none', regex: { pattern: 'zzz', replacement: '', flags: 'g' } };
    expect(labSummary('abc', runTextLab('abc', rr), rr)).toContain('一致はありません');
  });
  it('題名は最初の空でない行(記号を除く・40 字まで)。空なら日時入り', () => {
    expect(labNoteTitle('\n## 見出し\n本文', new Date(2026, 9, 26, 9, 5))).toBe('見出し');
    expect(labNoteTitle('x'.repeat(50), new Date())).toBe(`${'x'.repeat(40)}…`);
    expect(labNoteTitle('  \n ', new Date(2026, 9, 26, 9, 5))).toBe('整形したテキスト 2026-10-26 09:05');
  });
});
