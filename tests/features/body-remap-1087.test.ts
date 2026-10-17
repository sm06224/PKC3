/**
 * 🔴 **取り込みの lid の付け替えは、読む側(`body-links.ts`)と同じ文法で当てる**(#1087 N14)。
 *
 * 直す前は `entry:` の小文字だけを左の境界なしで写した:`Entry:old1` と `pkc://<cid>/entry/old1` は
 * 旧 lid のまま残り(= 複製ではなく既存の原本を指す)、`myentry:old1` は `entry:` でもないのに書き換わった。
 * 期待値は `bodyLinkTargets`(読む側)から作る ── 実装と同じ綴りで組まない。
 */
import { describe, expect, it } from 'vitest';
import { remapImportedBody } from '../../src/features/import/body-remap';
import { bodyLinkTargets } from '../../src/features/entry-ref/body-links';

const remap = { assetKeys: [], lids: [['old1', 'new1']] as Array<readonly [string, string]>, cid: 'c1' };

describe('remapImportedBody の lid', () => {
  it.each([
    ['[x](entry:old1)'],
    ['![x](entry:old1#h/plan)'],
    ['[x](Entry:old1)'],
    ['[x](ENTRY:old1)'],
    ['[x](pkc://c1/entry/old1)'],
    ['[x](pkc://c1/entry/old1#h/a)'],
  ])('🔴 %s は新しい lid を指す(旧 lid は指さない)', (src) => {
    expect(bodyLinkTargets(src, 'c1'), '前提:元は旧 lid を指す').toContain('old1');
    const out = remapImportedBody(src, remap);
    const after = bodyLinkTargets(out, 'c1');
    expect(after).toContain('new1');
    expect(after).not.toContain('old1');
  });

  it('🔴 左が lid の文字なら `entry:` ではない(`myentry:old1` は触らない)', () => {
    expect(remapImportedBody('myentry:old1 / x_entry:old1', remap)).toBe('myentry:old1 / x_entry:old1');
  });

  it('🔴 右は最長一致(`entry:old10` は `old1` ではない)/ 写し先の無い lid はそのまま', () => {
    expect(remapImportedBody('entry:old10 entry:zzz', remap)).toBe('entry:old10 entry:zzz');
  });

  it('🔴 別の容れ物あて(`pkc://other/entry/old1`)と、cid を渡さない取り込みの pkc:// は触らない', () => {
    expect(remapImportedBody('pkc://other/entry/old1', remap)).toBe('pkc://other/entry/old1');
    const noCid = { assetKeys: [], lids: remap.lids };
    expect(remapImportedBody('pkc://c1/entry/old1', noCid)).toBe('pkc://c1/entry/old1');
  });

  it('1 パスで写す(旧 → 新が連鎖しても二重に写さない)/ 綴りの大小は残す', () => {
    const chain = { assetKeys: [], lids: [['a', 'b'], ['b', 'c']] as Array<readonly [string, string]> };
    expect(remapImportedBody('entry:a Entry:b', chain)).toBe('entry:b Entry:c');
  });
});
