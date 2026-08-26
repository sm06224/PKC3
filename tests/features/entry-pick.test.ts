/**
 * 🔴 **貼りたいノートを題名で選ぶ**(#427 段②)── 一覧の組み方。
 */
import { describe, it, expect } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  ENTRY_PICK_LIMIT,
  entryPickNote,
  entryPickRows,
  entryPickTotal,
} from '../../src/features/entry-ref/entry-pick';

const meta = (lid: string, title: string, archetype = 'text'): EntryMeta =>
  ({ lid, title, archetype, entryOrder: 0, archived: false }) as EntryMeta;

const world = (...rows: EntryMeta[]) => ({
  metas: new Map(rows.map((m) => [m.lid, m])),
  order: rows.map((m) => m.lid),
});

describe('候補', () => {
  const w = world(
    meta('a', '先週の議事録'),
    meta('b', '買い物'),
    meta('c', '議事録のひな形', 'snippet'),
    meta('d', '資料', 'folder'),
  );

  it('語が空なら、一覧の並びのまま全部出る', () => {
    expect(entryPickRows(w.metas, w.order, '', null).map((r) => r.lid)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('題名で絞る', () => {
    expect(entryPickRows(w.metas, w.order, '議事', null).map((r) => r.lid)).toEqual(['c', 'a']);
  });

  it('🔴 題名の**頭から一致**するものが先に出る(探している物は大抵それ)', () => {
    /**
     * ⚠ 一覧の並びでは `a`(先週の議事録)が先だが、`c`(議事録のひな形)は
     *   **頭から**当たっているので先に出る ── 並びの規則が効いていることを
     *   `order` と**逆向き**で見る(順序どおりなら偶然と区別がつかない)。
     */
    expect(entryPickRows(w.metas, w.order, '議事録', null)[0]?.lid).toBe('c');
  });

  it('🔴 **自分自身は出さない**(貼っても同じ所に戻るだけ)', () => {
    expect(entryPickRows(w.metas, w.order, '', 'b').map((r) => r.lid)).toEqual(['a', 'c', 'd']);
  });

  it('種類の名前も返す(同じ題名が並んだときの見分け)', () => {
    const rows = entryPickRows(w.metas, w.order, '', null);
    expect(rows.find((r) => r.lid === 'd')?.kind).toBe('フォルダ');
    expect(rows.find((r) => r.lid === 'c')?.kind).toBe('雛形');
  });

  it('⚠ `order` に無い lid は出さない(一覧に出ていない物を候補にしない)', () => {
    const metas = new Map(w.metas);
    metas.set('zz', meta('zz', '幽霊'));
    expect(entryPickRows(metas, w.order, '', null).map((r) => r.lid)).not.toContain('zz');
  });

  it('大小を無視して当たる', () => {
    const w2 = world(meta('a', 'README'));
    expect(entryPickRows(w2.metas, w2.order, 'readme', null)).toHaveLength(1);
  });

  it('題名が空のノートも出す(作ったのに選べない、にしない)', () => {
    const w2 = world(meta('a', ''));
    expect(entryPickRows(w2.metas, w2.order, '', null).map((r) => r.title)).toEqual(['']);
  });
});

describe('上限', () => {
  const many = world(...Array.from({ length: 120 }, (_, i) => meta(`l${i}`, `ノート${i}`)));

  it('既定の上限で切る', () => {
    expect(entryPickRows(many.metas, many.order, '', null)).toHaveLength(ENTRY_PICK_LIMIT);
  });

  it('🔴 **切ったことを字で言う**(黙って切ると「無い」と読まれ、もう一度作られる)', () => {
    const shown = entryPickRows(many.metas, many.order, '', null);
    const total = entryPickTotal(many.metas, many.order, '', null);
    expect(total).toBe(120);
    expect(entryPickNote(shown.length, total)).toContain('120');
    expect(entryPickNote(shown.length, total)).toContain('50');
  });

  it('切っていなければ何も言わない', () => {
    expect(entryPickNote(3, 3)).toBe('');
  });

  it('0 件は「無い」と言う(黙って空を出さない)', () => {
    expect(entryPickNote(0, 0)).not.toBe('');
  });

  /**
   * 🔴 **総数は候補と同じ条件で数える**(#411 の札で踏んだのと同じ型)。
   * ⚠ `order.length` で数えると、**自分自身を含めた数**になり
   *   「120 件のうち 50 件」と言いながら実は 119 件、という食い違いになる。
   */
  it('🔴 総数は「自分自身を除いた」数', () => {
    expect(entryPickTotal(many.metas, many.order, '', 'l0')).toBe(119);
  });

  it('総数は語でも絞られる', () => {
    expect(entryPickTotal(many.metas, many.order, 'ノート1', null)).toBe(
      // ノート1, ノート10..19, ノート100..119 = 1 + 10 + 20
      31,
    );
  });
});
