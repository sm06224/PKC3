/**
 * 復元チェーンの **TS 参照実装**(= 現在の本番経路)の pin。
 *
 * review L5: これが無いと、本番経路の分岐(full 段の扱い)を守っているのが
 * 「従」であるはずの wasm parity test だけになる ── wasm を将来畳んだ瞬間に
 * 本番の網が消える。TS 側は TS 側で独立に固定する。
 */
import { describe, expect, it } from 'vitest';
import { diffLines } from '../../src/features/revision/line-patch';
import { restoreChain, type ChainStep } from '../../src/features/revision/restore-chain';

const back = (newer: string, older: string): ChainStep => ({
  kind: 'patch',
  ops: diffLines(newer, older).ops,
});

describe('restoreChain (TS 参照実装 = 本番経路)', () => {
  it('段が無ければ tip をそのまま返す', () => {
    expect(restoreChain('# いま\n', [])).toBe('# いま\n');
    expect(restoreChain('', [])).toBe('');
  });

  it('パッチ段を順に遡る(多世代・byte 一致)', () => {
    const gens = ['v0\n本文\n', 'v1\n本文\n', 'v2\n本文\n', 'v3\n本文\n'];
    const tip = gens[3]!;
    const steps: ChainStep[] = [
      back(gens[3]!, gens[2]!),
      back(gens[2]!, gens[1]!),
      back(gens[1]!, gens[0]!),
    ];
    expect(restoreChain(tip, steps.slice(0, 1))).toBe(gens[2]);
    expect(restoreChain(tip, steps.slice(0, 2))).toBe(gens[1]);
    expect(restoreChain(tip, steps)).toBe(gens[0]);
  });

  it('full 段は tip を無視して置き換える(削除 → 復元で生じる形)', () => {
    const tip = '# いま\n';
    const full = '# 全文で保存された版\n中身\n';
    // full 段の後ろにパッチが続く鎖 ── full の分岐が消えると必ず壊れる
    const steps: ChainStep[] = [
      back(tip, '# ひとつ前\n'),
      { kind: 'full', body: full },
      back(full, '# さらに前\n中身\n'),
    ];
    expect(restoreChain(tip, steps.slice(0, 2))).toBe(full);
    expect(restoreChain(tip, steps)).toBe('# さらに前\n中身\n');
  });

  it('CRLF / 末尾改行なし / 空 / 多バイトを byte 一致で戻す', () => {
    const cases: Array<[string, string]> = [
      ['a\r\nb\r\n', 'a\r\nB\r\n'],
      ['末尾改行なし', '末尾改行なし\n'],
      ['本文\n', ''],
      ['', '生えた\n'],
      ['🎌 絵文字\n日本語\n', '🎌 絵文字\n日本語かな\n'],
    ];
    for (const [newer, older] of cases) {
      expect(restoreChain(newer, [back(newer, older)])).toBe(older);
    }
  });

  it('壊れたパッチは throw(それらしい本文を作らない ── S3 規律)', () => {
    expect(() => restoreChain('a\n', [{ kind: 'patch', ops: [99] }])).toThrow(/overrun/);
    expect(() => restoreChain('a\nb\n', [{ kind: 'patch', ops: [1] }])).toThrow(
      /not fully consumed/,
    );
  });
});
