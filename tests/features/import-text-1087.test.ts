/**
 * 🔴 **取り込む字の見直し**(#1087)── vCard の文字コード / 外から来た字の改行 / 文字コードの判定の申告 / 大きすぎる読み込み。
 *
 * 守る主張:
 * 1. QUOTED-PRINTABLE は `CHARSET=` の文字コードで読む(古い日本の携帯電話の vCard は Shift_JIS)
 * 2. 題名や 1 行の項目に入った改行は畳まれ、外の file の字で新しい記法の行を差し込めない(NOTE の本文は畳まない)
 * 3. 文字コードを見分けた結果(どれで読んだか)を返す。Shift_JIS は推測なので、呼ぶ側が言える
 * 4. 「大きすぎて読めない」例外だけを、平らな字にできる形で見分ける(他の `RangeError` は含めない)
 */
import { describe, expect, it } from 'vitest';
import { parseVcf, vcfNoteOf } from '../../src/features/contact/vcard';
import { readPlainMarkdown } from '../../src/features/import/plain-markdown';
import { decodeImportTextInfo, SJIS_GUESS_NOTE } from '../../src/features/import/text-decode';
import { foldBreaks, importTitleOf, IMPORT_TITLE_MAX } from '../../src/features/import/fold-breaks';
import { isTooLargeToRead } from '../../src/features/import/too-large';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NEL = String.fromCharCode(0x85);

describe('#1087 ── QUOTED-PRINTABLE の文字コード(CHARSET=)', () => {
  const vcf = (...lines: string[]): string => ['BEGIN:VCARD', 'VERSION:2.1', ...lines, 'END:VCARD'].join('\r\n');

  it('🔴 Shift_JIS の QP(古い日本の携帯電話の書き出し)を文字化けせずに読む', () => {
    // 「山田」の Shift_JIS = 8E 52 93 63
    const r = parseVcf(vcf('FN;CHARSET=SHIFT_JIS;ENCODING=QUOTED-PRINTABLE:=8E=52=93=63'));
    expect(r.cards[0]!.name).toBe('山田');
    expect(r.warnings, '正しく読めたのに注意が出た').toEqual([]);
  });

  it('対照群: CHARSET= が無い QP は UTF-8 のまま(Shift_JIS のバイト列は読めず、注意が出る)', () => {
    const sjis = parseVcf(vcf('FN;ENCODING=QUOTED-PRINTABLE:=8E=52=93=63'));
    expect(sjis.cards[0]!.name).toContain('�');
    expect(sjis.warnings.join('')).toContain('文字を正しく読み取れない');
    const utf8 = parseVcf(vcf('FN;ENCODING=QUOTED-PRINTABLE:=E5=B1=B1=E7=94=B0'));
    expect(utf8.cards[0]!.name).toBe('山田');
  });

  it('🔴 知らない文字コードの名前は UTF-8 のまま読み、読めなければ従来どおり注意を出す(例外で止まらない)', () => {
    const ok = parseVcf(vcf('FN;CHARSET=NO-SUCH-CODE;ENCODING=QUOTED-PRINTABLE:=E5=B1=B1=E7=94=B0'));
    expect(ok.cards[0]!.name).toBe('山田');
    expect(ok.warnings).toEqual([]);
    const bad = parseVcf(vcf('FN;CHARSET=NO-SUCH-CODE;ENCODING=QUOTED-PRINTABLE:=8E=52=93=63'));
    expect(bad.cards[0]!.name).toContain('�');
    expect(bad.warnings.join('')).toContain('文字を正しく読み取れない');
  });

  it('N と所属(ORG)と他の項目でも、同じ CHARSET= が効く', () => {
    const r = parseVcf(
      vcf(
        'N;CHARSET=SHIFT_JIS;ENCODING=QUOTED-PRINTABLE:=8E=52=93=63;=91=BE=98=59;;;',
        'ORG;CHARSET=SHIFT_JIS;ENCODING=QUOTED-PRINTABLE:=8E=52=93=63',
        'X-MEMO;CHARSET=SHIFT_JIS;ENCODING=QUOTED-PRINTABLE:=8E=52=93=63',
      ),
    );
    expect(r.cards[0]!.name).toBe('山田 太郎');
    expect(r.cards[0]!.orgParts).toEqual(['山田']);
    expect(r.cards[0]!.others).toEqual(['- X-MEMO: 山田']);
    expect(r.warnings).toEqual([]);
  });
});

describe('#1087 ── 外から来た字の改行を、記法の行にしない(vCard)', () => {
  const vcf = (...lines: string[]): string => ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD'].join('\r\n');
  const INJECT = '値\\n:::format{x}\\n- 偽の行';

  it('🔴 写せない項目(others)の値に入った改行は、1 行に畳まれる', () => {
    const r = parseVcf(vcf('FN:山田', `X-MEMO:${INJECT}`, `URL:a${LS}b`));
    for (const line of r.cards[0]!.others) expect(/[\r\n]/.test(line) || line.includes(LS) || line.includes(PS), `改行が残った: ${line}`).toBe(false);
    const body = vcfNoteOf(r.cards[0]!).body.split('\n');
    expect(body, ':::format で始まる行ができた').not.toContainEqual(expect.stringMatching(/^\s*:::/));
    expect(body).toContain('- X-MEMO: 値 :::format{x} - 偽の行');
  });

  it('🔴 題名(FN / N)の改行は畳まれ、行区切り(U+2028)も同じ', () => {
    expect(parseVcf(vcf('FN:山田\\n:::format{x}')).cards[0]!.name).toBe('山田 :::format{x}');
    expect(parseVcf(vcf(`FN:山田${LS}太郎`)).cards[0]!.name).toBe('山田 太郎');
    expect(parseVcf(vcf('N:山田\\n田;太郎;;;')).cards[0]!.name).toBe('山田 田 太郎');
  });

  it('🔴 2 つ目の FN / ORG / BDAY(others へ回る分)も 1 行', () => {
    const r = parseVcf(vcf('FN:山田', 'FN:別\\n名', 'ORG:会社', 'ORG:別\\n社', 'BDAY:1990-01-02', 'BDAY:x\\ny'));
    expect(r.cards[0]!.others).toEqual(['- 別の名前: 別 名', '- 会社: 別 社', '- 誕生日: x y']);
  });

  it('🔴 題名は 200 字で切る(md の題名と同じ上限)', () => {
    const t = parseVcf(vcf(`FN:${'あ'.repeat(300)}`)).cards[0]!.name;
    expect(t).toHaveLength(IMPORT_TITLE_MAX);
    expect(t.endsWith('…')).toBe(true);
  });

  it('対照群: NOTE は本文の文章なので、改行を畳まない', () => {
    const r = parseVcf(vcf('FN:山田', 'NOTE:一行目\\n二行目'));
    expect(r.cards[0]!.notes).toEqual(['一行目\n二行目']);
  });
});

describe('#1087 ── 前書きの題名に入った改行(Markdown)', () => {
  it('🔴 `title: "a\\nb"` の改行は 1 行に畳まれる(題名が 2 行・記法の行にならない)', () => {
    const r = readPlainMarkdown('---\ntitle: "会議\\n:::format{x}"\n---\n本文\n', 'a.md');
    expect(r.title).toBe('会議 :::format{x}');
  });

  it('🔴 行区切り(U+2028)も畳む', () => {
    const r = readPlainMarkdown(`---\ntitle: "会議${LS}議事"\n---\n本文\n`, 'a.md');
    expect(r.title).toBe('会議 議事');
  });

  it('対照群: 本文は触らない(原文のまま)。題名の上限 200 字は今までどおり', () => {
    const r = readPlainMarkdown('---\ntitle: "t"\n---\n一行目\n\n二行目\n', 'a.md');
    expect(r.body).toContain('一行目\n\n二行目');
    const long = readPlainMarkdown(`---\ntitle: "${'あ'.repeat(300)}"\n---\n本文\n`, 'a.md');
    expect(long.title).toHaveLength(IMPORT_TITLE_MAX);
  });
});

describe('#1087 ── 畳む口(pptx の取り込みと同じ 1 本)', () => {
  it('改行の類を全部、空白 1 つにする', () => {
    expect(foldBreaks(`a\r\nb\nc\rd${NEL}e${LS}f${PS}g\vh\fi`)).toBe('a b c d e f g h i');
    expect(importTitleOf('  a\nb  ')).toBe('a b');
  });

  it('🔴 長い題名は code point で切る(絵文字の対を半分で切らない)', () => {
    const raw = `${'a'.repeat(198)}${'😀'.repeat(5)}`;
    const t = importTitleOf(raw);
    expect(t).toBe(`${'a'.repeat(198)}😀…`);
    expect(Array.from(t)).toHaveLength(IMPORT_TITLE_MAX);
    // 対を失った半端な字(lone surrogate)が無い
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t)).toBe(false);
    // 対照群: 200 code point ちょうど(UTF-16 では 200 を超える)は切らない
    const exact = `${'a'.repeat(100)}${'😀'.repeat(100)}`;
    expect(importTitleOf(exact)).toBe(exact);
  });
});

describe('#1087 ── 文字コードの判定の申告', () => {
  const SJIS = new Uint8Array([0x8e, 0x52, 0x93, 0x63]); // 山田
  // Windows-1252 の "école" ── 0xE9 は Shift_JIS では 2 バイト文字の先頭になり、エラー無く別の漢字に化ける
  const CP1252 = new Uint8Array([0xe9, 0x63, 0x6f, 0x6c, 0x65]);

  it('どの文字コードで読んだかを返す', () => {
    expect(decodeImportTextInfo(new TextEncoder().encode('山田')).used).toBe('utf8');
    expect(decodeImportTextInfo(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])).used).toBe('utf8');
    expect(decodeImportTextInfo(new Uint8Array([0xff, 0xfe, 0x71, 0x5c])).used).toBe('utf16');
    expect(decodeImportTextInfo(SJIS)).toEqual({ text: '山田', used: 'sjis' });
  });

  it('🔴 Windows-1252 の école は、Shift_JIS と判断して読んだと申告される(黙って化けない)', () => {
    const r = decodeImportTextInfo(CP1252);
    expect(r.text, '前提: 化けた字になる').not.toContain('école');
    expect(r.used).toBe('sjis');
  });

  it('どちらでも読めない並びは UTF-8 の読み(Shift_JIS と申告しない)', () => {
    expect(decodeImportTextInfo(new Uint8Array([0x41, 0xff, 0xff, 0x42])).used).toBe('utf8');
  });

  it('申告の字', () => {
    expect(SJIS_GUESS_NOTE).toBe(
      '文字コードを Shift_JIS と判断して読みました(文字が崩れて見えるときは、UTF-8 で保存し直して取り込んでください)',
    );
  });
});

describe('#1087 ── 大きすぎて読めない例外', () => {
  it('文字列・配列を作れない RangeError だけを拾う', () => {
    expect(isTooLargeToRead(new RangeError('Invalid string length'))).toBe(true);
    expect(isTooLargeToRead(new RangeError('Invalid array length'))).toBe(true);
    expect(isTooLargeToRead(new RangeError('Array buffer allocation failed'))).toBe(true);
  });

  it('対照群: 別の RangeError・別の例外・例外でない値は拾わない', () => {
    expect(isTooLargeToRead(new RangeError('Maximum call stack size exceeded'))).toBe(false);
    expect(isTooLargeToRead(new Error('Invalid string length'))).toBe(false);
    expect(isTooLargeToRead('Invalid string length')).toBe(false);
  });

  it('実物: ブラウザ(V8)が実際に投げる例外を拾える', () => {
    let caught: unknown = null;
    try {
      'a'.repeat(2 ** 30 + 1).repeat(4);
    } catch (e) {
      caught = e;
    }
    expect(isTooLargeToRead(caught), String(caught)).toBe(true);
  });
});
