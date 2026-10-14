/**
 * 🔴 **書込の op が、他タブへの「変わった」の放送から漏れていない**(#1087、複数タブの見直し)。
 *
 * 直す前は Office の書き戻し(`replaceAssetRefs`)が `MUTATING_OPS` に無く、他タブの本文が古いまま残り、
 * そのタブで保存すると書き戻しを黙って巻き戻していた。⚠ 集合を手で並べる形は、足した人が並べ忘れると漏れる
 * ── だから `protocol.ts` の op を全数読み、**放送するか、放送しない理由が書いてあるか**のどちらかを求める。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MUTATING_OPS, NOT_BROADCAST } from '../../src/adapter/platform/storage/store-proxy';

function requestOps(): string[] {
  const src = readFileSync('src/adapter/platform/storage/protocol.ts', 'utf8');
  const start = src.indexOf('export type StorageRequest =');
  const end = src.indexOf('\n\n', src.indexOf("op: 'close'", start));
  const block = src.slice(start, end);
  return [...new Set([...block.matchAll(/op: '([A-Za-z]+)'/g)].map((m) => m[1]!))].sort();
}

describe('放送する op / しない op の全数', () => {
  it('前提: protocol の op を読めている(空振りしない)', () => {
    const ops = requestOps();
    expect(ops.length, 'op を 1 つも読めていない').toBeGreaterThan(40);
    expect(ops).toContain('upsertEntry');
    expect(ops).toContain('replaceAssetRefs');
  });

  it('🔴 どの op も「放送する」か「放送しない理由がある」のどちらか 1 つにだけ入る', () => {
    const missing: string[] = [];
    const both: string[] = [];
    for (const op of requestOps()) {
      const inMut = MUTATING_OPS.has(op as never);
      const inNot = NOT_BROADCAST.has(op as never);
      if (!inMut && !inNot) missing.push(op);
      if (inMut && inNot) both.push(op);
    }
    expect(missing, '放送するか、放送しない理由を NOT_BROADCAST に書く').toEqual([]);
    expect(both).toEqual([]);
  });

  it('🔴 Office の書き戻しは放送する(他タブの本文が古いまま残らない)', () => {
    expect(MUTATING_OPS.has('replaceAssetRefs')).toBe(true);
  });

  it('NOT_BROADCAST に、もう無い op の名前が残っていない', () => {
    const ops = new Set(requestOps());
    expect([...NOT_BROADCAST].filter((op) => !ops.has(op))).toEqual([]);
  });
});
