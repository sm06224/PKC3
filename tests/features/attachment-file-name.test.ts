/**
 * 🔴 **添付の改名欄で打った字 → ダウンロードのファイル名**(#1220 穴②、裁定 A)。
 *
 * 規則は 1 本(`attachmentFileName`)。期待値は**手で書いた具体的な名前**で組む
 * (規則の式を test 側で書き直さない ── 同じ盲点を共有する)。
 */
import { describe, expect, it } from 'vitest';
import { attachmentFileName } from '../../src/features/flavor/attachment-flavor';

describe('拡張子の扱い(元の拡張子を偽らせない)', () => {
  it('拡張子を打たなければ、元の拡張子を付ける', () => {
    expect(attachmentFileName('請求書', 'scan.pdf')).toBe('請求書.pdf');
    expect(attachmentFileName('写真', 'IMG_0001.JPG')).toBe('写真.JPG');
  });

  it('元と同じ拡張子で終えていれば、そのまま(二重に付けない)', () => {
    expect(attachmentFileName('請求書.pdf', 'scan.pdf')).toBe('請求書.pdf');
    // 大文字小文字は区別しない ── 打った綴りを残す
    expect(attachmentFileName('請求書.PDF', 'scan.pdf')).toBe('請求書.PDF');
    expect(attachmentFileName('請求書.pdf', 'SCAN.PDF')).toBe('請求書.pdf');
  });

  it('🔴 別の拡張子で終えても変えない ── 元の拡張子を付け直す(中身は変わらない)', () => {
    expect(attachmentFileName('請求書.txt', 'scan.pdf')).toBe('請求書.txt.pdf');
    expect(attachmentFileName('a.pdf.exe', 'scan.pdf')).toBe('a.pdf.exe.pdf');
  });

  it('拡張子は最後の . から後ろだけ', () => {
    expect(attachmentFileName('バックアップ', 'data.tar.gz')).toBe('バックアップ.gz');
    expect(attachmentFileName('バックアップ.gz', 'data.tar.gz')).toBe('バックアップ.gz');
  });

  it('元が拡張子を持たない(README / 隠しファイル名 / 末尾が .)なら、打った字のまま', () => {
    expect(attachmentFileName('読んでね', 'README')).toBe('読んでね');
    expect(attachmentFileName('設定', '.gitignore')).toBe('設定');
    expect(attachmentFileName('メモ', 'memo.')).toBe('メモ');
    expect(attachmentFileName('メモ', '')).toBe('メモ');
  });

  it('空白を含む後ろ(`報告 v1.2 最終`)は拡張子ではない ── 足さない', () => {
    expect(attachmentFileName('新しい報告', '報告 v1.2 最終')).toBe('新しい報告');
  });

  it('拡張子だけを打ったときは、名前が無いので足す(`.pdf` → `.pdf.pdf`)', () => {
    expect(attachmentFileName('.pdf', 'scan.pdf')).toBe('.pdf.pdf');
  });
});

describe('使えない字は _ にする', () => {
  it('/ \\ : * ? " < > | を 1 字ずつ _ に置き換える', () => {
    expect(attachmentFileName('a/b\\c:d*e?f"g<h>i|j', 'x.pdf')).toBe('a_b_c_d_e_f_g_h_i_j.pdf');
  });

  it('制御文字(改行・タブ・DEL)も _ にする', () => {
    expect(attachmentFileName('a\tb\u007fc', 'x.pdf')).toBe('a_b_c.pdf');
    expect(attachmentFileName('a\u0001b', 'x.pdf')).toBe('a_b.pdf');
  });

  it('置き換えた後の字で拡張子を判定する(`a/b.pdf` は `a_b.pdf`。二重に付けない)', () => {
    expect(attachmentFileName('a/b.pdf', 'x.pdf')).toBe('a_b.pdf');
  });

  it('使える字は 1 字も変えない(日本語・空白・括弧・サロゲートペア)', () => {
    expect(attachmentFileName('請求書 (最終) 𠮷野家', 'x.pdf')).toBe('請求書 (最終) 𠮷野家.pdf');
  });
});

describe('空・前後の空白', () => {
  it('前後の空白は落とす', () => {
    expect(attachmentFileName('  請求書  ', 'x.pdf')).toBe('請求書.pdf');
  });

  it('何も残らなければ元の名前のまま(空のファイル名を作らない)', () => {
    expect(attachmentFileName('', 'scan.pdf')).toBe('scan.pdf');
    expect(attachmentFileName('   ', 'scan.pdf')).toBe('scan.pdf');
  });
});
