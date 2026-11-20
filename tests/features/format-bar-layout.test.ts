import { describe, expect, it } from 'vitest';
import {
  FORMAT_BAR_GROUPS,
  FORMAT_BAR_MORE_GROUPS,
  barItemId,
  formatOpsMissingFromLayout,
  moreBarItems,
  visibleBarItems,
} from '../../src/features/markdown/format-bar-layout';
import { BAR_FORMAT_OPS } from '../../src/features/markdown/text-ops';

/**
 * 🔴 書式の帯の並び(#1982 段 3)── 「直接出す」と「その他 ▾ へ入れる」の正本が 1 つの表であること。
 */
describe('書式の帯の並び(1 つの表)', () => {
  it('直接出すのは 4 つのグループ(見出し | 太字・斜体・コード・リンク | 箇条書き・番号・チェック・引用 | 表・ノートリンク・添付)', () => {
    expect(FORMAT_BAR_GROUPS.map((g) => g.map(barItemId))).toEqual([
      ['op:h1', 'op:h2', 'op:h3'],
      ['op:bold', 'op:italic', 'op:code', 'op:link'],
      ['op:ul', 'op:ol', 'op:task', 'op:quote'],
      ['op:table', 'action:insert-entry-link', 'action:insert-attachment'],
    ]);
  });

  it('「その他 ▾」の顔ぶれと並び(挿入 → 整える → 探す)', () => {
    expect(FORMAT_BAR_MORE_GROUPS.map((g) => [g.group, g.items.map(barItemId)])).toEqual([
      [
        'insert',
        [
          'action:insert-diagram',
          'op:codeblock',
          'op:math',
          'action:insert-callout',
          'action:insert-date',
          'action:insert-snippet',
          'action:insert-icon',
        ],
      ],
      ['tidy', ['action:renumber-lists', 'action:sort-tasks', 'action:calc-line']],
      ['find', ['action:find-in-note', 'action:toggle-replace']],
    ]);
  });

  it('どの項目も 1 回だけ ── 直接 / その他 のどちらかに居て、重ならず、落ちない', () => {
    const ids = [...visibleBarItems(), ...moreBarItems()].map(barItemId);
    expect(ids.length, '空振り(項目が少なすぎる)').toBeGreaterThan(20);
    expect(new Set(ids).size, '同じ項目が 2 回出ている').toBe(ids.length);
  });

  it('書式の表(BAR_FORMAT_OPS)の全 op が並びのどこかに居る(足した書式が帯から消えない)', () => {
    expect(formatOpsMissingFromLayout()).toEqual([]);
    // 対照群: 並びに無い op を作ったら検出できる(検査が空振りしていない)
    const placed = new Set(
      [...visibleBarItems(), ...moreBarItems()].flatMap((i) => ('op' in i ? [i.op] : [])),
    );
    expect(placed.size).toBe(BAR_FORMAT_OPS.length);
    expect(placed.has('highlight' as never), '帯に出さない op が並びに入っている').toBe(false);
  });
});
