/**
 * 🔴 **スタックのフレーバー**(#633 段③)── 本文 = `- [題名](entry:<lid>)` の箇条書き。
 *
 * ⚠ 期待値を「実装と同じ文法の別の綴り」で組まない(CLAUDE.md 2026-08-22)── ここで見るのは
 *   **往復**(組んだ物を読み戻すと同じ並びが返る)と、**読み手が既存の 1 本**であること
 *   (`bodyLinkTargets` が拾わない綴りは、このフレーバーも拾わない)。
 */
import { describe, expect, it } from 'vitest';
import { STACK_ARCHETYPE, stackBody, stackFlavor, stackLids } from '../../src/features/flavor/stack-flavor';
import { extractMeta, getFlavor, registeredArchetypes, seedBodyFor } from '../../src/features/flavor';
import { archetypeLabel, isKnownArchetype } from '../../src/features/flavor/archetype-label';
import { bodyLinkTargets } from '../../src/features/entry-ref/body-links';

describe('登録(#633 段③)', () => {
  it('🔴 registry に居て、text fallback へ落ちない', () => {
    expect(registeredArchetypes()).toContain(STACK_ARCHETYPE);
    expect(getFlavor(STACK_ARCHETYPE)).toBe(stackFlavor);
    // 名前を持つ(一覧のチップ・情報ペインの種類・スマートフォルダの条件に出る)
    expect(isKnownArchetype(STACK_ARCHETYPE)).toBe(true);
    expect(archetypeLabel(STACK_ARCHETYPE)).toBe('スタック');
  });

  it('seed は何をする入れ物かの 1 行(作る道は帯の「保存…」だけ)', () => {
    expect(seedBodyFor(STACK_ARCHETYPE)).toContain('保存');
    // ⚠ 空の seed は「壊れている」と読まれる / リンクを含めない(存在しない lid を指させない)
    expect(bodyLinkTargets(seedBodyFor(STACK_ARCHETYPE))).toEqual([]);
  });

  it('期日と状態は他のフレーバーと同じく列へ写す(スマートフォルダの 2026-08-27 と同じ理由)', () => {
    const body = '---\ndate: 2026-09-05\nstatus: open\n---\n- [A](entry:a)\n';
    expect(extractMeta(STACK_ARCHETYPE, body)).toEqual({ status: 'open', date: '2026-09-05', archived: false });
  });
});

describe('本文の組み立てと読み戻し', () => {
  it('🔴 往復で並びが保たれる(上から順 = 出現順)', () => {
    const items = [
      { title: '議事録', lid: 'a1' },
      { title: '資料 B', lid: 'b2' },
      { title: '去年の稟議', lid: 'c3' },
    ];
    const body = stackBody(items);
    expect(stackLids(body)).toEqual(['a1', 'b2', 'c3']);
    // 逆順で組めば逆順で返る(並びが本文に載っていることの対照群)
    expect(stackLids(stackBody([...items].reverse()))).toEqual(['c3', 'b2', 'a1']);
  });

  it('🔴 1 行 1 リンクの箇条書きで、題名の `]` は壊れない', () => {
    const body = stackBody([{ title: '第 [1] 回', lid: 'x' }]);
    const lines = body.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith('- [')).toBe(true);
    expect(lines[0]).toContain('(entry:x)');
    expect(stackLids(body)).toEqual(['x']);
  });

  it('空なら空の本文(存在しない行を作らない)', () => {
    expect(stackBody([])).toBe('');
    expect(stackLids('')).toEqual([]);
  });

  it('🔑 読み手は `bodyLinkTargets` そのもの(2 本目の規則を持たない)', () => {
    const body = '- [A](entry:a)\n- [A again](entry:a)\n手で書いた entry:zz も拾う\n';
    expect(stackLids(body)).toEqual(bodyLinkTargets(body));
    // 重複は畳まれ、出てきた順
    expect(stackLids(body)).toEqual(['a', 'zz']);
  });
});
