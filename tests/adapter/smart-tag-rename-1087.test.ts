/** @vitest-environment happy-dom */
/**
 * #1087: **タグの名前を変えたら、スマートフォルダの条件の同じ名前も変わる**。
 * また、**前書きが読めないスマートフォルダの条件は書かない**。
 *
 * 観測点は disk に着いた本文と、画面に出た知らせ。
 * ⚠ 台の `persistEntry` は `expectHash` を渡された本文と disk の本文が食い違えば conflict を返す
 *   (本物の worker と同じ意味論 ── 門を外すと「別の窓を踏む」が緑のままにならないように)。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';
import { readSmartSpec } from '../../src/features/smart/smart-spec';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';

const meta = (lid: string, order: number, archetype: string): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
  bodyChars: 10,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function rig(bodies: Record<string, string>, archetypes: Record<string, string>) {
  const disk = { ...bodies };
  const d = new Dispatcher();
  let writes = 0;
  const hashes: (string | null)[] = [];
  const conflictOn = new Set<string>();
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? null,
    getBodies: async (lids) =>
      lids.filter((l) => disk[l] !== undefined).map((l) => ({ lid: l, body: disk[l]! })),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e, opts) => {
      writes++;
      hashes.push(opts?.expectHash ?? null);
      if (conflictOn.has(e.lid)) return { ...stubStamps(), conflict: true };
      if (opts?.expectHash !== undefined && opts.expectHash !== contentHash64Hex(disk[e.lid] ?? ''))
        return { ...stubStamps(), conflict: true };
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: Object.keys(bodies).map((lid, i) => meta(lid, i + 1, archetypes[lid] ?? 'text')),
    relations: [],
  });
  return { d, disk, conflictOn, writes: (): number => writes, hashes };
}

const smart = (tags: string, extra = ''): string => `---\nsmart-tags: [${tags}]\n${extra}---\n説明\n`;

describe('タグの名前の変更 → スマートフォルダの条件', () => {
  it('🔴 条件の旧い名前が新しい名前に変わり、知らせに件数が出る。条件に無いスマートフォルダ・ふつうのノートは触らない', async () => {
    const s = rig(
      {
        s1: smart('旧, 別'),
        s2: smart('別'),
        n1: '---\ntags: [旧]\n---\n本文\n',
      },
      { s1: 'smart', s2: 'smart' },
    );
    s.d.dispatch({ type: 'RENAME_SMART_TAG', from: '旧', to: '新' });
    await flush();
    expect(readSmartSpec(s.disk['s1']!).tags).toEqual(['新', '別']);
    expect(s.disk['s2'], '条件に無いスマートフォルダを書いた').toBe(smart('別'));
    expect(s.disk['n1'], 'ふつうのノートを書いた').toBe('---\ntags: [旧]\n---\n本文\n');
    expect(s.writes(), '書いたのは条件に当たった 1 件だけ').toBe(1);
    expect(s.d.getState().notice ?? '').toBe('スマートフォルダ 1 件の条件も変えました');
  });

  it('🔴 外す・付けるの知らせに続けて言う(上書きしない)', async () => {
    const s = rig({ s1: smart('旧') }, { s1: 'smart' });
    s.d.dispatch({ type: 'OP_NOTICE', message: '3 件から外しました' });
    s.d.dispatch({ type: 'RENAME_SMART_TAG', from: '旧', to: '新' });
    await flush();
    expect(s.d.getState().notice ?? '').toBe('3 件から外しました / スマートフォルダ 1 件の条件も変えました');
  });

  it('🔴 読んだ本文の指紋を添えて書く。先を越されたら書かず、書けなかったと言う', async () => {
    const s = rig({ s1: smart('旧') }, { s1: 'smart' });
    s.conflictOn.add('s1');
    s.d.dispatch({ type: 'RENAME_SMART_TAG', from: '旧', to: '新' });
    await flush();
    expect(s.hashes).toEqual([contentHash64Hex(smart('旧'))]);
    expect(s.disk['s1']).toBe(smart('旧'));
    expect(s.d.getState().notice ?? '').toBe('スマートフォルダ 1 件の条件は書き換えられませんでした');
  });

  it('🔴 前書きが読めないスマートフォルダは書かない', async () => {
    const broken = '---\nsmart-tags: [旧]\n説明です\n';
    const s = rig({ s1: broken, s2: smart('旧') }, { s1: 'smart', s2: 'smart' });
    s.d.dispatch({ type: 'RENAME_SMART_TAG', from: '旧', to: '新' });
    await flush();
    expect(s.disk['s1'], '読めない前書きに書いた').toBe(broken);
    expect(readSmartSpec(s.disk['s2']!).tags).toEqual(['新']);
    expect(s.d.getState().notice ?? '').toBe('スマートフォルダ 1 件の条件も変えました');
  });

  it('対照群: 条件に当たるスマートフォルダが 0 件なら、何も言わない・何も書かない', async () => {
    const s = rig({ s1: smart('別') }, { s1: 'smart' });
    s.d.dispatch({ type: 'RENAME_SMART_TAG', from: '旧', to: '新' });
    await flush();
    expect(s.writes()).toBe(0);
    expect(s.d.getState().notice ?? '').toBe('');
  });

  it('reducer: スマートフォルダが 1 つも無ければ頼みを撃たない / 編集中は撃たない', () => {
    const none = reduce(
      reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 1, 'text')], relations: [] }).state,
      { type: 'RENAME_SMART_TAG', from: '旧', to: '新' },
    );
    expect(none.events).toEqual([]);
    const booted = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('s1', 1, 'smart'), meta('n1', 2, 'text')],
      relations: [],
    }).state;
    const out = reduce(booted, { type: 'RENAME_SMART_TAG', from: '旧', to: '新' });
    expect(out.events).toEqual([
      {
        type: 'REQUEST_SMART_TAG_RENAME',
        from: '旧',
        to: '新',
        targets: [{ lid: 's1', title: 't-s1', archetype: 'smart', entryOrder: 1 }],
      },
    ]);
    const editing = reduce({ ...booted, phase: 'editing' }, { type: 'RENAME_SMART_TAG', from: '旧', to: '新' });
    expect(editing.events).toEqual([]);
  });
});

describe('条件の書き換え(足す / 外す)も、読めない前書きには書かない', () => {
  it('🔴 `smart-tags` を持つのに前書きが閉じていないスマートフォルダへ足しても、条件の行を差し替えない', async () => {
    const broken = '---\nsmart-tags: [旧, 別]\n説明です\n';
    const s = rig({ s1: broken }, { s1: 'smart' });
    s.d.dispatch({ type: 'SMART_COND', lid: 's1', tag: '新', mode: 'add' });
    await flush();
    expect(s.disk['s1'], '読めない前書きの条件の行を差し替えた').toBe(broken);
    expect(s.writes()).toBe(0);
    expect(s.d.getState().error ?? '').toContain('前書きが読めない');
  });

  it('対照群: 読める前書きには足せる(門が全部を止めていない)', async () => {
    const s = rig({ s1: smart('旧') }, { s1: 'smart' });
    s.d.dispatch({ type: 'SMART_COND', lid: 's1', tag: '新', mode: 'add' });
    await flush();
    expect(readSmartSpec(s.disk['s1']!).tags).toEqual(['旧', '新']);
  });
});
