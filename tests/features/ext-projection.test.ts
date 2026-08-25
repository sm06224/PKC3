/**
 * 🔴 **拡張へ渡す見取り図**(#195 / C-5 段①)。
 *
 * 🔑 守る主張は 3 つ:
 * 1. 🔴 **本文に繋がる列を渡さない** ── ここが封じ込めの本体である
 * 2. 🔴 **`EntryMeta` に列が増えても、黙って流れない**(写す列は名指し)
 * 3. 🔴 **切ったら言う**(黙って落とさない)
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  buildProjection,
  extEntryOf,
  EXT_OMITTED,
  EXT_PROJECTION_MAX,
} from '../../src/features/extension/ext-projection';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T01:00:00.000Z',
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 1234,
    ...over,
  };
}

describe('拡張へ渡す見取り図 (#195 / C-5 段①)', () => {
  /**
   * 🔴 **本文の長さすら渡さない**(段① の判断)。
   * ⚠ 「数だけなら安全」で足すのは簡単だが、**外すのはできない** ── 読む拡張が
   *   現れた瞬間に固定される。要ると分かった段で足す。
   */
  it('🔴 `bodyChars` が入っていない', () => {
    const row = extEntryOf(meta('a')) as unknown as Record<string, unknown>;
    expect(Object.keys(row), '本文の長さが漏れている').not.toContain('bodyChars');
    // ⚠ 空振り防止 ── 元の `EntryMeta` は持っている(落としたことに意味がある)
    expect(Object.keys(meta('a'))).toContain('bodyChars');
  });

  /**
   * 🔴 **写す列は名指しである**(`EntryMeta` を丸ごと渡さない)。
   * ⚠ この等値が無いと、`EntryMeta` に列を足した人が**拡張のことを考えずに**
   *   足した列を、隔離した相手へ黙って流すことになる。
   */
  it('🔴 渡す列が、名指しした 8 つだけ', () => {
    expect(Object.keys(extEntryOf(meta('a'))).sort()).toEqual(
      ['archetype', 'archived', 'createdAt', 'date', 'lid', 'status', 'title', 'updatedAt'],
    );
  });

  /** ⚠ 落とすと決めた列は**名前で残す**(次に読む人が「なぜ無いか」を辿れる)。 */
  it('⚠ 落とした列の名前が残っている', () => {
    expect(EXT_OMITTED).toContain('bodyChars');
    // 🔑 名前が実在の列を指していること(消えた列を戒めに残さない)
    for (const name of EXT_OMITTED) expect(Object.keys(meta('a'))).toContain(name);
  });

  it('値はそのまま写る(欠けている所は null のまま)', () => {
    const row = extEntryOf(meta('a', { status: 'done', date: '2026-08-26', createdAt: null }));
    expect(row).toEqual({
      lid: 'a',
      title: 't-a',
      archetype: 'text',
      createdAt: null,
      updatedAt: '2026-08-25T01:00:00.000Z',
      status: 'done',
      date: '2026-08-26',
      archived: false,
    });
  });

  it('並びは渡された順のまま(2 つ目の並べ方を作らない)', () => {
    const p = buildProjection([meta('c'), meta('a'), meta('b')]);
    expect(p.entries.map((e) => e.lid)).toEqual(['c', 'a', 'b']);
  });

  /**
   * ⚠ **上限を跨ぐ件数で試す**(CLAUDE.md §2)── 届かない量だけを見ていると、
   * `truncated` を常に `false` にする変異が生き延びる。
   */
  it('🔴 上限を超えたら、切ったと言う(黙って落とさない)', () => {
    const many = Array.from({ length: EXT_PROJECTION_MAX + 3 }, (_, i) => meta(`n${i}`));
    const p = buildProjection(many);
    expect(p.total, '前提が崩れている(上限を超えていない)').toBe(EXT_PROJECTION_MAX + 3);
    expect(p.truncated, '切ったのに黙っている').toBe(true);
    expect(p.entries.length, '切っても読んだ分は返る').toBe(EXT_PROJECTION_MAX);
  });

  it('上限以内なら切ったと言わない(対照群)', () => {
    const p = buildProjection([meta('a'), meta('b')]);
    expect(p.truncated).toBe(false);
    expect(p.total).toBe(2);
  });

  it('1 件も無くても形は返る(「読めない」と区別できる)', () => {
    expect(buildProjection([])).toEqual({ entries: [], total: 0, truncated: false });
  });
});
