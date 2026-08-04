/** @vitest-environment node */
/**
 * P8 段⑭: 取り込んだ HTML の**文字コード**。
 *
 * 🔴 起動経路は `blob.text()` を通っていたが、これは **UTF-8 固定 decode** で、
 * さらに外殻が `<meta charset="utf-8">` を宣言するので srcdoc 文書の encoding は
 * **外殻から継承**される ── アプリ自身の `<meta charset>` は 1 ミリも効かない。
 * 実測:
 * ```
 * <meta charset="shift_jis"> の Shift_JIS ファイル(本文「日本語」)
 *   直接開く: characterSet=Shift_JIS  codes=[26085,26412,35486]   ← 読める
 *   srcdoc  : characterSet=UTF-8      codes=[65533,65533,65533,…] ← 不可逆に化ける
 * ```
 * UTF-16 が通っていたのは `blob.text()` の **BOM 判別に救われた**だけである。
 */
import { describe, expect, it } from 'vitest';
import { decodeHtml, detectHtmlCharset } from '../../src/features/launcher/html-charset';

const bytes = (label: string, text: string): Uint8Array => {
  if (label === 'utf-8') return new TextEncoder().encode(text);
  // Shift_JIS / EUC-JP は Node に encoder が無いので、必要な文字だけ手で組む
  throw new Error('unsupported');
};

/** Shift_JIS の「日本語」(0x93FA 0x967B 0x8CEA)。 */
const SJIS_NIHONGO = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea];

describe('文字コードの判別', () => {
  it('BOM が最優先(中身より前に見る)', () => {
    expect(detectHtmlCharset(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c]))).toBe('utf-8');
    expect(detectHtmlCharset(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]))).toBe('utf-16le');
    expect(detectHtmlCharset(new Uint8Array([0xfe, 0xff, 0x00, 0x3c]))).toBe('utf-16be');
  });

  it('🔴 `<meta charset>` を読む(ここが読めないと日本語が化ける)', () => {
    const head = '<!doctype html><html><head><meta charset="shift_jis">';
    expect(detectHtmlCharset(bytes('utf-8', head))).toBe('shift_jis');
    expect(detectHtmlCharset(bytes('utf-8', "<meta charset='EUC-JP'>"))).toBe('euc-jp');
    expect(detectHtmlCharset(bytes('utf-8', '<meta charset=Shift_JIS>'))).toBe('shift_jis');
  });

  it('`http-equiv` の形も同じ規則で拾う(規則を 2 通り書かない)', () => {
    const h = '<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">';
    expect(detectHtmlCharset(bytes('utf-8', h))).toBe('shift_jis');
  });

  it('⚠ 知らないラベルは既定へ(TextDecoder が RangeError で起動ごと落ちる)', () => {
    expect(detectHtmlCharset(bytes('utf-8', '<meta charset="nonsense-9">'))).toBe('utf-8');
  });

  it('⚠ 先頭 1024 バイトまで(ブラウザと同じ範囲 ── 見つけ過ぎない)', () => {
    const pad = '<!-- ' + 'x'.repeat(1100) + ' -->';
    expect(detectHtmlCharset(bytes('utf-8', pad + '<meta charset="shift_jis">'))).toBe('utf-8');
    expect(detectHtmlCharset(bytes('utf-8', '<meta charset="shift_jis">' + pad))).toBe('shift_jis');
  });

  it('宣言が無ければ UTF-8', () => {
    expect(detectHtmlCharset(bytes('utf-8', '<!doctype html><p>あ</p>'))).toBe('utf-8');
  });
});

describe('decode', () => {
  it('🔴 Shift_JIS の本文が読める(UTF-8 固定 decode だと化ける)', () => {
    const src = new Uint8Array([
      ...bytes('utf-8', '<!doctype html><meta charset="shift_jis"><p>'),
      ...SJIS_NIHONGO,
      ...bytes('utf-8', '</p>'),
    ]);
    const out = decodeHtml(src);
    expect(out).toContain('日本語');
    // ⚠ 直す前の姿(UTF-8 固定)と**違う**ことを見る ── 同じなら直っていない
    expect(new TextDecoder('utf-8').decode(src)).not.toContain('日本語');
    expect(out).not.toContain('�');
  });

  it('UTF-8 はそのまま(既定の道を壊していない)', () => {
    expect(decodeHtml(bytes('utf-8', '<p>あ🍎</p>'))).toBe('<p>あ🍎</p>');
  });

  it('⚠ BOM は落とす(残ると doctype の判定が外れる)', () => {
    const src = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('utf-8', '<!doctype html>')]);
    expect(decodeHtml(src).startsWith('<!doctype html>')).toBe(true);
  });
});
