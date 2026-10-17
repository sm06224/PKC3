/**
 * 🔴 引用符つきの値の中の `fill=` / `stroke=` は札ではない(`setPlaceStyle` の走査。`setToken` と同じ読み方)。
 *
 * user の物語: 付箋の note に `q x=5 fill=red` と書いてある付箋の色を変えると、直す前は note の中の
 * `fill=red` まで書き換わって引用符が壊れ、開き行が読めなくなった。
 */
import { describe, expect, it } from 'vitest';
import { placeStyleAt, setPlaceStyle } from '../../src/features/markdown/place-notation';

const OPEN = ':::format{.pkc-place x=10 y=20 note="q x=5 fill=red" fill=#112233}';
const body = (open: string): string => `前\n\n${open}\n中身\n:::\n`;
const lineOf = (out: string | null): string => (out ?? '').split('\n')[2] ?? '';

describe('引用の中の fill= を札と読まない', () => {
  it('色を変えても note の中身はそのまま、札だけが差し替わる', () => {
    const out = setPlaceStyle(body(OPEN), { line: 2, openLine: OPEN }, { fill: '#445566' });
    expect(lineOf(out)).toBe(':::format{.pkc-place x=10 y=20 note="q x=5 fill=red" fill=#445566}');
    expect(placeStyleAt(lineOf(out))?.fill).toBe('#445566');
  });

  it('色を外しても note の中身は消えず、行が壊れない', () => {
    const out = setPlaceStyle(body(OPEN), { line: 2, openLine: OPEN }, { fill: null });
    expect(lineOf(out)).toBe(':::format{.pkc-place x=10 y=20 note="q x=5 fill=red"}');
  });

  it('札が無いときは足し、引用の中の fill= を既にある札と数えない', () => {
    const open = ':::format{.pkc-place x=1 y=2 note="a fill=red"}';
    const out = setPlaceStyle(body(open), { line: 2, openLine: open }, { fill: '#010203' });
    expect(lineOf(out)).toBe(':::format{.pkc-place x=1 y=2 note="a fill=red" fill=#010203}');
  });

  it('対照群:引用の無い行では、これまでどおり差し替わる・外れる・重なりは 1 つにまとまる', () => {
    const plain = ':::format{.pkc-place x=1 y=2 fill=#111111}';
    expect(lineOf(setPlaceStyle(body(plain), { line: 2, openLine: plain }, { fill: '#222222' }))).toBe(
      ':::format{.pkc-place x=1 y=2 fill=#222222}',
    );
    expect(lineOf(setPlaceStyle(body(plain), { line: 2, openLine: plain }, { fill: null }))).toBe(
      ':::format{.pkc-place x=1 y=2}',
    );
    const dup = ':::format{.pkc-place fill=#111111 x=1 fill=#333333}';
    expect(lineOf(setPlaceStyle(body(dup), { line: 2, openLine: dup }, { fill: '#222222' }))).toBe(
      ':::format{.pkc-place x=1 fill=#222222}',
    );
  });
});
