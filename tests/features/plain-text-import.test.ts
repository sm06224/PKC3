import { describe, expect, it } from 'vitest';
import {
  isMarkdownFileName,
  isPlainTextFileName,
  readPlainMarkdown,
  titleFromFileName,
} from '../../src/features/import/plain-markdown';

describe('.txt の取り込み(依頼 171)', () => {
  it('拡張子 .txt(大文字小文字を問わない)だけを見分ける', () => {
    expect(isPlainTextFileName('a.txt')).toBe(true);
    expect(isPlainTextFileName('A.TXT')).toBe(true);
    expect(isPlainTextFileName('a.txt.zip')).toBe(false);
    expect(isPlainTextFileName('a.md')).toBe(false);
  });

  it('🔴 窓へ落としたときの振り分け(isMarkdownFileName)には入れない ── .txt の落としは添付のまま', () => {
    expect(isMarkdownFileName('a.txt')).toBe(false);
  });

  it('題名は拡張子を落とす。本文の見出しが無ければファイル名が題名になる', () => {
    expect(titleFromFileName('dir/メモ.txt')).toBe('メモ');
    expect(readPlainMarkdown('ただの字\n', 'メモ.txt').title).toBe('メモ');
  });
});
