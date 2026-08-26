/**
 * 🔴 **構成をテキストで書き出す**(#429 段①)。
 *
 * ⚠ ここは**組み立ての規則**だけを見る。押した所から届くかは
 *   `tests/adapter/export-structure.test.ts`(2 つの検査で役割を分ける)。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import {
  STRUCTURE_HELP,
  STRUCTURE_LIMIT,
  structureLines,
  structureText,
} from '../../src/features/structure/structure-text';

function meta(lid: string, title: string, order: number, archetype = 'text'): EntryMeta {
  return {
    lid, title, archetype,
    createdAt: null, updatedAt: null, entryOrder: order,
    status: null, date: null, archived: false, bodyChars: null,
  };
}
const rel = (id: string, from: string, to: string): Relation => ({
  id, fromLid: from, toLid: to, kind: 'structural', createdAt: null, updatedAt: null,
});
const mapOf = (ms: EntryMeta[]) => new Map(ms.map((m) => [m.lid, m]));

describe('構成のテキスト(#429 段①)', () => {
  it('🔴 木の形が段の深さで出る(root → フォルダ → 中身)', () => {
    const ms = [meta('f1', '仕事', 1, 'folder'), meta('n1', '会議メモ', 2), meta('n2', '買い物', 3)];
    const lines = structureLines(mapOf(ms), [rel('r1', 'f1', 'n1')]);
    expect(lines.map((l) => [l.lid, l.depth])).toEqual([
      ['f1', 0],
      ['n1', 1],
      ['n2', 0],
    ]);
    expect(lines[0]!.isFolder, 'フォルダの印が付いていない').toBe(true);
    expect(lines[1]!.isFolder).toBe(false);
  });

  it('🔴 lid が本文に出る ── これが無いと mv が書けない', () => {
    const { text } = structureText(mapOf([meta('01ABC', 'めも', 1)]), []);
    expect(text, 'lid が出ていない').toContain('01ABC');
    expect(text, '題名が出ていない').toContain('めも');
  });

  it('🔴 コマンドの書き方が同じ紙に載っている(貼るだけで済む)', () => {
    const { text } = structureText(mapOf([meta('a', 'x', 1)]), []);
    // ⚠ 3 つとも要る ── 1 つでも欠けると、AI は残りを勝手に発明する
    for (const cmd of ['mv ', 'mkdir ', 'rename ']) {
      expect(text, `${cmd} の説明が無い`).toContain(cmd);
    }
    expect(text, '@名前 の説明が無い').toContain('as @名前');
    // 空振り防止 ── 説明の表そのものが空でないこと
    expect(STRUCTURE_HELP.length).toBeGreaterThan(5);
  });

  it('入れ子は上から順に並ぶ(どこの下か読める)', () => {
    const ms = [
      meta('f1', '外', 1, 'folder'),
      meta('f2', '中', 2, 'folder'),
      meta('n1', '葉', 3),
    ];
    const { text } = structureText(mapOf(ms), [rel('r1', 'f1', 'f2'), rel('r2', 'f2', 'n1')]);
    const body = text.split('\n').filter((l) => l.includes('  ') && !l.startsWith('#'));
    expect(body.findIndex((l) => l.includes('f1'))).toBeLessThan(
      body.findIndex((l) => l.includes('f2')),
    );
    expect(body.findIndex((l) => l.includes('f2'))).toBeLessThan(
      body.findIndex((l) => l.includes('n1')),
    );
  });

  /**
   * 🔴 **同じ lid が 2 度出ない** ── ⚠ これを守っているのは**この module ではなく
   *   `tree.ts` の正準親**である(2026-08-26 の変異試験 S3 が教えた:こちらの
   *   `seen` の門を外しても落ちない = 到達しない)。
   * 🔑 それでも pin する価値はある ── **`tree.ts` の不変量が崩れたら、
   *   ここが最初に鳴る**(貼った紙に同じノートが 2 度並ぶのは実害である)。
   */
  it('🔴 同じ lid を 2 度出さない(正準親の不変量に乗っている)', () => {
    const ms = [meta('f1', 'A', 1, 'folder'), meta('f2', 'B', 2, 'folder'), meta('n1', '子', 3)];
    // ⚠ 2 つの親から同じ子へ ── `tree.ts` は正準親 1 つに寄せるが、ここでも守る
    const lines = structureLines(mapOf(ms), [rel('r1', 'f1', 'n1'), rel('r2', 'f2', 'n1')]);
    const lids = lines.map((l) => l.lid);
    expect(new Set(lids).size, '同じ lid が 2 度出ている').toBe(lids.length);
  });

  it('ノートが 1 件も無ければ、本数は 0(呼び側が断れる)', () => {
    const out = structureText(new Map(), []);
    expect(out.total).toBe(0);
    expect(out.shown).toBe(0);
  });

  describe('上限', () => {
    /**
     * 🔴 **切ったことを本文に書く**。⚠ 黙って切ると、貼られた AI は
     *   「これで全部」と読んで、**出ていないノートを消す案**を返しうる。
     */
    it('🔴 上限を超えたら、切ったことが本文に出る', () => {
      const ms = Array.from({ length: STRUCTURE_LIMIT + 5 }, (_, i) =>
        meta(`l${i}`, `t${i}`, i + 1),
      );
      const out = structureText(mapOf(ms), []);
      expect(out.total).toBe(STRUCTURE_LIMIT + 5);
      expect(out.shown).toBe(STRUCTURE_LIMIT);
      expect(out.text, '切ったことが書いていない').toContain(`${out.total} 件のうち上から`);
    });

    it('🔑 対照群 ── 上限内なら断り書きは出ない', () => {
      const out = structureText(mapOf([meta('a', 'x', 1)]), []);
      expect(out.text, '切っていないのに断り書きが出ている').not.toContain('件のうち上から');
    });
  });
});
