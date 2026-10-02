import { describe, expect, it } from 'vitest';
import { sniffText, sniffedPreview } from '../../src/features/asset/sniff-text';

const enc = new TextEncoder();
const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n);
/** 先頭に印を置いて、あとは字を続ける(本物の file も「印 + 中身」の形)。 */
const withHead = (head: number[], tail = 'rest of file 1234567890'): Uint8Array =>
  Uint8Array.from([...head, ...enc.encode(tail)]);

describe('sniffText ── 字として出す前に中身を見る(#1220)', () => {
  describe('字でないもの', () => {
    it('PDF(報告の字面そのもの)は binary / pdf', () => {
      const pdf = enc.encode('%PDF-1.7\n%äüöß\n2 0 obj\n<</Length 3 0 R>>');
      expect(sniffText(pdf, false)).toEqual({ kind: 'binary', guess: 'pdf' });
    });

    it.each([
      ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'png'],
      ['JPEG', [0xff, 0xd8, 0xff, 0xe0], 'jpeg'],
      ['GIF', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'gif'],
      ['ZIP / docx', [0x50, 0x4b, 0x03, 0x04], 'zip'],
    ] as const)('%s は印で言い当てる', (_name, head, guess) => {
      expect(sniffText(withHead([...head]), false)).toEqual({ kind: 'binary', guess });
    });

    it('NUL を含めば(印が無くても)binary / 当て先なし', () => {
      const r = sniffText(withHead([0x61, 0x62, 0x00, 0x63]), false);
      expect(r).toEqual({ kind: 'binary', guess: null });
    });

    it('UTF-8 として読めない割合が高ければ binary(Shift_JIS の日本語)', () => {
      // 「日本語のテキスト」の Shift_JIS(UTF-8 としては大半が不正)
      const sjis = bytes(
        0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x82, 0xcc, 0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67,
      );
      expect(sniffText(sjis, false)).toEqual({ kind: 'binary', guess: null });
    });

    it('先頭が印に当たらなくても、中身が圧縮物のように読めなければ binary', () => {
      const noise = Uint8Array.from({ length: 4096 }, (_, i) => 0x80 + ((i * 7) % 0x40));
      expect(sniffText(noise, false).kind).toBe('binary');
    });
  });

  describe('字として出してよいもの(誤爆しない)', () => {
    const cases: [string, Uint8Array, string][] = [
      ['ASCII', enc.encode('hello\nworld\n'), 'hello\nworld\n'],
      ['日本語', enc.encode('こんにちは、世界\n二行目'), 'こんにちは、世界\n二行目'],
      ['CRLF', enc.encode('a\r\nb\r\n'), 'a\r\nb\r\n'],
      ['空', new Uint8Array(0), ''],
      ['タブ・改頁を含む', enc.encode('a\tb\fc'), 'a\tb\fc'],
      [
        'UTF-8 の BOM つき(BOM は字に出さない)',
        Uint8Array.from([0xef, 0xbb, 0xbf, ...enc.encode('BOM付き')]),
        'BOM付き',
      ],
      [
        '字が `PK` や `GIF` で始まるだけの普通の文書(印の続きが字でなければ当たらない)',
        enc.encode('PKC3 notes'),
        'PKC3 notes',
      ],
      ['絵文字(4 byte)', enc.encode('🙂 ok'), '🙂 ok'],
    ];
    it.each(cases)('%s', (_name, input, text) => {
      expect(sniffText(input, false)).toEqual({ kind: 'text', text });
    });

    it('壊れた字が数個だけ紛れた長い文書は字のまま(割合で見る)', () => {
      const body = enc.encode('あいうえお'.repeat(200));
      const hurt = Uint8Array.from([...body, 0xff, 0xfe, ...enc.encode(' tail')]);
      const r = sniffText(hurt, false);
      expect(r.kind).toBe('text');
    });

    it('先頭だけ読んだ塊の末尾で多 byte の字が途切れていても、字のまま(切っただけ)', () => {
      const full = enc.encode('あ'.repeat(10));
      // 「あ」は 3 byte ── 途中で切る
      const cut = full.slice(0, 29);
      const truncated = sniffText(cut, true);
      expect(truncated.kind).toBe('text');
      if (truncated.kind === 'text') {
        expect(truncated.text).toBe('あ'.repeat(9)); // 途切れた分は出さない(壊れ字にしない)
        expect(truncated.text).not.toContain('�');
      }
    });
  });

  it('全体が入っているのに末尾が途切れていれば、壊れとして数える(truncated の旗が効く)', () => {
    // 3 byte の字の 2 byte 目までで終わる短い入力 = 全体がこれ ── 壊れた字
    const input = Uint8Array.from([0xe3, 0x81]);
    expect(sniffText(input, false)).toEqual({ kind: 'binary', guess: null });
    // 同じ bytes でも「先頭だけ」なら、続きがあるので壊れではない
    expect(sniffText(input, true)).toEqual({ kind: 'text', text: '' });
  });

  it('印の判定は NUL / 割合の判定より先(PNG の先頭は NUL を待たずに言い当てる)', () => {
    expect(sniffText(bytes(0x89, 0x50, 0x4e, 0x47), false)).toEqual({
      kind: 'binary',
      guess: 'png',
    });
  });

  it('印の長さに満たない入力は印に当たらない(例外にしない)', () => {
    expect(sniffText(bytes(0x25), false)).toEqual({ kind: 'text', text: '%' });
    expect(sniffText(bytes(0x25, 0x50, 0x44, 0x46), false)).toEqual({
      kind: 'text',
      text: '%PDF',
    });
  });
});

describe('sniffedPreview ── 言い当てた種類を本来の見せ方へ回す', () => {
  it('pdf は <object> の枝へ、画像は <img> の枝へ(付け替える mime つき)', () => {
    expect(sniffedPreview('pdf')).toEqual({ kind: 'pdf', mime: 'application/pdf' });
    expect(sniffedPreview('png')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(sniffedPreview('jpeg')).toEqual({ kind: 'image', mime: 'image/jpeg' });
    expect(sniffedPreview('gif')).toEqual({ kind: 'image', mime: 'image/gif' });
  });

  it('zip と印なしは回せない(断りへ落とす)', () => {
    expect(sniffedPreview('zip')).toBeNull();
    expect(sniffedPreview(null)).toBeNull();
  });
});
