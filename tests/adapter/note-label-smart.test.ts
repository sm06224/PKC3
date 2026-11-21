/**
 * 🔴 色で絞るスマートフォルダの集め直し(#1982 レビュー)。実物の `NoteLabelStore` を通す(deps の替え玉だけにしない)。
 * 観測点: 取り込みの取り消しのあと、`smart-label: 緑` の当たりからそのノートが消える / 1 回の変化の連なりは集め直し 1 回 /
 * 色の無い条件は集め直さない / 取り込み後に付け直した色は取り消しで外れない。
 */
import { describe, expect, it } from 'vitest';
import { NoteLabelStore } from '../../src/adapter/platform/note-label-store';
import { importNoteLabelsInto } from '../../src/adapter/platform/note-label-import';
import { wireLabelSmartRescan } from '../../src/adapter/platform/note-label-smart';
import { labelsStillAdded } from '../../src/features/note-label';
import { EMPTY_SMART, readSmartSpec } from '../../src/features/smart/smart-spec';

const tick = () => new Promise((r) => setTimeout(r, 90));

/** 正本(worker の settings 表の替え)+ 実物の写し + 配線 + 走査の替え。 */
function world(initial: Array<[string, number]> = []) {
  const truth = new Map<string, number>(initial);
  const store = new NoteLabelStore();
  const reload = async (): Promise<void> => {
    store.setAll([...truth].map(([lid, color]) => ({ lid, color })));
  };
  store.attach(
    async (lid, color) => {
      if (color === null) truth.delete(lid);
      else truth.set(lid, color);
    },
    () => void reload(),
  );
  // スマートフォルダ 2 つ: 緑で絞る / 色の無い条件
  const hits = new Map<string, { lids: string[]; spec: typeof EMPTY_SMART }>([
    ['smart-green', { lids: [], spec: readSmartSpec('---\nsmart-label: 緑\n---\n') }],
    ['smart-tag', { lids: [], spec: { ...EMPTY_SMART, tags: ['x'] } }],
  ]);
  const rescans: string[] = [];
  wireLabelSmartRescan(
    store,
    () => hits,
    (a) => {
      rescans.push(a.lid);
      // 走査(worker の SQL)の替え: 正本の色で当てる
      const h = hits.get(a.lid)!;
      h.lids = [...truth].filter(([, c]) => c === h.spec.label).map(([l]) => l);
    },
  );
  return { truth, store, reload, hits, rescans };
}

describe('取り込みの取り消しと、色で絞るスマートフォルダ', () => {
  it('🔴 取り込みで付いた色は、取り消し(正本を書いて読み直す)のあと当たりから消える', async () => {
    const w = world([['keep', 5]]);
    await w.reload(); // 起動の読み込み
    await tick();
    w.rescans.length = 0;
    // 取り込み(main.ts の importNoteLabels と同じ並び: 書く → 読み直す)
    const r = await importNoteLabelsInto([{ lid: 'n1', color: 3 }, { lid: 'keep', color: 3 }], {
      listLids: async () => [...w.truth.keys()],
      put: async (l, c) => void w.truth.set(l, c),
      exists: () => true,
    });
    await w.reload();
    await tick();
    expect(w.hits.get('smart-green')!.lids, '取り込みで付いた色が集まっていない').toEqual(['n1']);
    expect(w.rescans.filter((l) => l === 'smart-green'), '集め直しが 1 回でない').toHaveLength(1);
    expect(w.rescans, '色の無い条件を走査した').not.toContain('smart-tag');
    // 取り消し(main.ts の removeNoteLabels と同じ並び)
    w.rescans.length = 0;
    for (const e of labelsStillAdded(r.addedEntries, w.truth)) w.truth.delete(e.lid);
    await w.reload();
    await tick();
    expect(w.hits.get('smart-green')!.lids, '取り消したのに当たりに残った').toEqual([]);
    expect(w.rescans.filter((l) => l === 'smart-green')).toHaveLength(1);
    expect(w.truth.get('keep'), '前から在った色を外した').toBe(5);
  });

  it('取り込み後に付け直した色は、取り消しで外れない', async () => {
    const w = world();
    const r = await importNoteLabelsInto([{ lid: 'n1', color: 3 }, { lid: 'n2', color: 3 }], {
      listLids: async () => [...w.truth.keys()],
      put: async (l, c) => void w.truth.set(l, c),
      exists: () => true,
    });
    w.truth.set('n2', 7); // user が付け直した
    w.truth.delete('n1'); // user が外した
    expect(labelsStillAdded(r.addedEntries, w.truth)).toEqual([]);
    expect(labelsStillAdded([{ lid: 'n2', color: 7 }], w.truth)).toEqual([{ lid: 'n2', color: 7 }]);
  });

  it('付け外しを続けて行っても、集め直しは 1 回にまとまる / 中身が変わらない読み直しでは走らない', async () => {
    const w = world();
    w.store.set('a', 3);
    w.store.set('b', 3);
    w.store.set('c', 3);
    await tick();
    expect(w.rescans.filter((l) => l === 'smart-green'), '書込ごとに走査した').toHaveLength(1);
    expect(w.hits.get('smart-green')!.lids.sort()).toEqual(['a', 'b', 'c']);
    w.rescans.length = 0;
    await w.reload(); // 中身は同じ
    await tick();
    expect(w.rescans).toEqual([]);
  });
});
