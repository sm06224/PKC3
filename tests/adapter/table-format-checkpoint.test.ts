/** @vitest-environment happy-dom */
/**
 * 🔴 **表の形変えで情報が落ちる回だけ、前の版を履歴に積む**(#1087 の見直し 2026-10-14)。
 *
 * 直す前は `task-run` と `csv-shape` の remove だけが積み、桁揃えのある表を「CSV の表にする」と
 * 桁揃えが消えて版からも戻せなかった。落ちる条件は `tableFormatDropsInfo` の 1 本
 * (markdown → csv で桁揃えが在る / tsv・psv → markdown)。**両側**を見る
 * (落ちる形では積む / 落ちない形では積まない)。
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert, EntryStamps } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { tableFormatDropsInfo } from '../../src/features/markdown/table-convert';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const meta: EntryMeta = {
  lid: 'n1',
  title: 't',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
};

const ALIGNED = '| a | b |\n|---:|:---:|\n| 1 | 2 |\n';
const PLAIN = '| a | b |\n|---|---|\n| 1 | 2 |\n';
const TSV = '```tsv\na\tb\n1\t2\n```\n';
const CSV = '```csv\na,b\n1,2\n```\n';

async function run(
  body: string,
  to: 'markdown' | 'csv',
): Promise<{ checkpoint: boolean | undefined; disk: string; count: number }> {
  const d = new Dispatcher();
  let disk = body;
  const persisted: Array<{ checkpoint?: boolean }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => disk,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async (): Promise<EntryStamps> => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async (): Promise<EntryStamps> => stubStamps(),
    persistEntry: async (e: EntryUpsert, opts?: { checkpoint?: boolean }): Promise<EntryStamps> => {
      persisted.push({ checkpoint: opts?.checkpoint });
      disk = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'SET_TABLE_FORMAT', lid: 'n1', line: 0, to });
  await tick();
  return { checkpoint: persisted[0]?.checkpoint, disk, count: persisted.length };
}

describe('表の形変えの履歴(#1087)', () => {
  it('🔴 桁揃えのある表を CSV にする回は、前の版を積む', async () => {
    const r = await run(ALIGNED, 'csv');
    expect(r.count, '書込が届いていない(前提)').toBe(1);
    expect(r.disk, '形が変わっていない(前提)').toContain('```csv');
    expect(r.checkpoint, '桁揃えが消えるのに履歴に積んでいない').toBe(true);
  });

  it('🔴 tsv の囲みを Markdown にする回も積む(区切りの字が落ちる)', async () => {
    const r = await run(TSV, 'markdown');
    expect(r.disk, '形が変わっていない(前提)').toContain('| a | b |');
    expect(r.checkpoint).toBe(true);
  });

  it('桁揃えの無い表を CSV にする回は積まない(落ちる物が無い)', async () => {
    const r = await run(PLAIN, 'csv');
    expect(r.disk, '形が変わっていない(前提)').toContain('```csv');
    expect(r.checkpoint).not.toBe(true);
  });

  it('csv の囲みを Markdown にする回は積まない', async () => {
    const r = await run(CSV, 'markdown');
    expect(r.disk, '形が変わっていない(前提)').toContain('| a | b |');
    expect(r.checkpoint).not.toBe(true);
  });
});

describe('tableFormatDropsInfo(判定そのもの)', () => {
  it('桁揃えは : が 1 列でも在れば真、無ければ偽(引用の中も同じ)', () => {
    expect(tableFormatDropsInfo(ALIGNED, 0, 'csv')).toBe(true);
    expect(tableFormatDropsInfo('| a | b |\n|:--|---|\n| 1 | 2 |\n', 0, 'csv')).toBe(true);
    expect(tableFormatDropsInfo(PLAIN, 0, 'csv')).toBe(false);
    expect(tableFormatDropsInfo('> | a | b |\n> |---:|---|\n> | 1 | 2 |\n', 0, 'csv')).toBe(true);
  });
  it('psv も真 / csv は偽 / 表でない行は偽', () => {
    expect(tableFormatDropsInfo('```psv\na|b\n1|2\n```\n', 0, 'markdown')).toBe(true);
    expect(tableFormatDropsInfo(CSV, 0, 'markdown')).toBe(false);
    expect(tableFormatDropsInfo('ただの文\n', 0, 'csv')).toBe(false);
  });
});
