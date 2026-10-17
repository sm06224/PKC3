/**
 * 🔴 PKC2 取り込みの lid の付け替えも、読む側(`body-links.ts`)と同じ文法で当てる(#1087 N14 の続き)。
 * 直す前は `entry:` の小文字だけを左の境界なしで写した:`Entry:old1` と PKC2 自身の
 * `pkc://<container_id>/entry/old1` は旧 lid のまま、`myentry:old1` は誤って書き換わった。
 * 期待値は `bodyLinkTargets`(読む側)から作る。
 */
import { describe, expect, it } from 'vitest';
import { bodyLinkTargets } from '../../src/features/entry-ref/body-links';
import { convertPkc2Container } from '../../src/features/import/pkc2-convert';

function run(body: string, withCid = true) {
  const out = convertPkc2Container(
    {
      meta: withCid ? { container_id: 'c1' } : {},
      entries: [
        { lid: 'old1', title: '対象', archetype: 'text', body: 'x' },
        { lid: 'ref', title: '参照', archetype: 'text', body },
      ],
    },
    { existingLids: new Set(['old1']), orderBase: 0, genLid: () => 'new1', genAssetKey: () => 'k' },
  );
  return out.entries.find((e) => e.title === '参照')!.body;
}

describe('convertPkc2Container の lid の付け替え', () => {
  it.each([
    ['[x](entry:old1)'],
    ['[x](Entry:old1)'],
    ['[x](ENTRY:old1#h/a)'],
    ['[x](pkc://c1/entry/old1)'],
    ['[x](pkc://c1/entry/old1#log/l1)'],
  ])('🔴 %s は新しい lid を指す', (src) => {
    expect(bodyLinkTargets(src, 'c1'), '前提:元は旧 lid を指す').toContain('old1');
    const after = bodyLinkTargets(run(src), 'c1');
    expect(after).toContain('new1');
    expect(after).not.toContain('old1');
  });

  it('🔴 `myentry:old1` は触らない / 別の容れ物あての pkc:// は触らない / container_id が無ければ pkc:// は触らない', () => {
    expect(run('myentry:old1 pkc://other/entry/old1')).toBe('myentry:old1 pkc://other/entry/old1');
    expect(run('pkc://c1/entry/old1', false)).toBe('pkc://c1/entry/old1');
  });
});
