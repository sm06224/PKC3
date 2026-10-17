/** @vitest-environment node */
/**
 * 🔴 **添付の改名欄で打った字 → ダウンロードのファイル名**(#1220 穴②、裁定 A)。
 *
 * 規則は 1 本(`attachmentFileName`)。期待値は**手で書いた具体的な名前**で組む
 * (規則の式を test 側で書き直さない ── 同じ盲点を共有する)。
 */
import { describe, expect, it } from 'vitest';
import { attachmentFileName, downloadFileName } from '../../src/features/flavor/attachment-flavor';

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
    expect(attachmentFileName('報告', 'a.v2.pdf')).toBe('報告.pdf');
  });

  it('🔴 .tar.gz / .tar.bz2 / .tar.xz / .tar.zst はひとまとまりの拡張子(改名で .tar が落ちない)', () => {
    expect(attachmentFileName('月次', 'backup.tar.gz')).toBe('月次.tar.gz');
    expect(attachmentFileName('月次', 'backup.tar.bz2')).toBe('月次.tar.bz2');
    expect(attachmentFileName('月次', 'backup.tar.xz')).toBe('月次.tar.xz');
    expect(attachmentFileName('月次', 'backup.tar.zst')).toBe('月次.tar.zst');
    // 大文字小文字は区別しない / 打った字が同じ拡張子で終えていれば二重に付けない
    expect(attachmentFileName('月次', 'BACKUP.TAR.GZ')).toBe('月次.TAR.GZ');
    expect(attachmentFileName('月次.tar.gz', 'backup.tar.gz')).toBe('月次.tar.gz');
    // 対照群: .tar だけ・.gz だけは、これまでどおり最後の拡張子
    expect(attachmentFileName('月次', 'backup.tar')).toBe('月次.tar');
    expect(attachmentFileName('月次', 'backup.gz')).toBe('月次.gz');
    // 名前が無い(先頭が .tar.gz だけ)は拡張子と見なさない
    expect(attachmentFileName('月次', '.tar.gz')).toBe('月次.gz');
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

/**
 * 🔴 **とても長い名前の添付を保存するとき**(#1163 依頼 214。Gemini の裁定:拡張子を残して 200 文字程度で切る)。
 * 期待値は手で書いた具体的な字数・名前で組む(規則の式を test 側で書き直さない)。
 */
describe('保存する名前の長さ(downloadFileName)', () => {
  it('短い名前はそのまま(日本語も全角も)', () => {
    expect(downloadFileName('請求書.pdf')).toBe('請求書.pdf');
    expect(downloadFileName('ＡＢＣ　報告書.pdf')).toBe('ＡＢＣ　報告書.pdf');
    expect(downloadFileName('あ'.repeat(200))).toBe('あ'.repeat(200));
  });

  it('🔴 400 字の名前は、拡張子を残して全体 200 字に切る', () => {
    const out = downloadFileName(`${'長'.repeat(400)}.pdf`);
    expect([...out]).toHaveLength(200);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(out).toBe(`${'長'.repeat(196)}.pdf`);
  });

  it('二重拡張子(.tar.gz)はひとまとまりで残す', () => {
    const out = downloadFileName(`${'a'.repeat(300)}.tar.gz`);
    expect(out).toBe(`${'a'.repeat(193)}.tar.gz`);
    expect(out).toHaveLength(200);
  });

  it('🔴 サロゲートペア(𠮷・絵文字)を割らない', () => {
    // 𠮷 は 1 字だが UTF-16 では 2 つ分。`slice` で切ると半分で割れる
    const out = downloadFileName(`${'𠮷'.repeat(250)}.txt`);
    expect([...out]).toHaveLength(200);
    expect(out).toBe(`${'𠮷'.repeat(196)}.txt`);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('拡張子の無い長い名前は、名前だけを切る', () => {
    expect(downloadFileName('x'.repeat(500))).toBe('x'.repeat(200));
  });

  it('空白を含む後ろは拡張子と見なさない(名前の一部として切る)', () => {
    const name = `${'a'.repeat(250)}.v1 最終`;
    const out = downloadFileName(name);
    expect([...out]).toHaveLength(200);
    expect(out.endsWith('最終')).toBe(false);
  });

  it('拡張子そのものが長すぎるときは、拡張子を残さず全体を切る(出力が上限を超えない)', () => {
    const out = downloadFileName(`a.${'e'.repeat(300)}`);
    expect([...out]).toHaveLength(200);
  });
});
