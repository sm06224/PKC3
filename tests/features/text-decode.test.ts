/**
 * 🔴 **取り込む文字の file を、文字コードを見分けて読む**(#1087、取り込みの見直し)。
 * 直す前は UTF-8 固定で読み、Shift_JIS の .vcf や UTF-16 の file が `�` だらけのまま黙って取り込まれていた。
 */
import { describe, expect, it } from 'vitest';
import { decodeImportText } from '../../src/features/import/text-decode';

// 「山田 太郎」の Shift_JIS(ガラケーの vCard の書き出しの字)
const SJIS = new Uint8Array([0x8e, 0x52, 0x93, 0x63, 0x20, 0x91, 0xbe, 0x98, 0x59]);

describe('decodeImportText', () => {
  it('前提: この Shift_JIS は UTF-8 として読むと壊れる(対照群)', () => {
    expect(new TextDecoder('utf-8').decode(SJIS)).toContain('�');
  });

  it('🔴 Shift_JIS を読める', () => {
    expect(decodeImportText(SJIS)).toBe('山田 太郎');
  });

  it('🔴 UTF-16(LE / BE、BOM つき)を読める', () => {
    const le = new Uint8Array([0xff, 0xfe, 0x71, 0x5c, 0x30, 0x75]); // 山田
    const be = new Uint8Array([0xfe, 0xff, 0x5c, 0x71, 0x75, 0x30]);
    expect(decodeImportText(le)).toBe('山田');
    expect(decodeImportText(be)).toBe('山田');
  });

  it('UTF-8 はそのまま(BOM は落とす)', () => {
    const u = new TextEncoder().encode('山田 太郎\r\n');
    expect(decodeImportText(u)).toBe('山田 太郎\r\n');
    expect(decodeImportText(new Uint8Array([0xef, 0xbb, 0xbf, ...u]))).toBe('山田 太郎\r\n');
  });

  it('どちらでも読み切れなければ、直す前と同じ読み(読めない字は `�`)', () => {
    const broken = new Uint8Array([0x41, 0xff, 0xff, 0x42]);
    expect(decodeImportText(broken)).toBe(new TextDecoder('utf-8').decode(broken));
  });
});
