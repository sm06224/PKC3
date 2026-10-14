/** @vitest-environment happy-dom */
/**
 * 🔴 **繰り返しの回のチェックを、書込の返事の前に 2 度押しても、嘘の理由を出さない**(#1087 の見直し)。
 *
 * 直す前:2 度目は同じ回の行を作ろうとして `materializeRepeat` が `null` を返し、それを
 * 「本文が変わっているため反映できませんでした(開き直してください)」と言っていた。
 * 実際は 1 度目で済んでいる ── 開き直しても何も変わらない、嘘の赤帯だった。
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryStamps } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { applyBodyRewrite, isRepeatAlreadyDone } from '../../src/features/markdown/body-rewrite';

const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

const RULE = '- [ ] 掃除 @2026-09-25 毎週';
const LIES = '本文が変わっているため';

function boot(initial: string) {
  const d = new Dispatcher();
  const disk = { body: initial };
  let writes = 0;
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => disk.body,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async (): Promise<EntryStamps> => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async (): Promise<EntryStamps> => stubStamps(),
    persistEntry: async (e): Promise<EntryStamps> => {
      writes += 1;
      disk.body = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  return { d, disk, writes: () => writes };
}

describe('同じ回の完了を 2 度書く(#1087)', () => {
  it('🔴 2 度目は「本文が変わっている」と言わず、行も増やさない', async () => {
    const h = boot(`${RULE}\n`);
    const seen: string[] = [];
    h.d.onState((s) => {
      if (s.error !== null) seen.push(s.error);
    });
    // 書込の返事の前に 2 度(effect の直列 queue に 2 本載る)
    h.d.dispatch({ type: 'MATERIALIZE_REPEAT', lid: 'n1', line: 0, date: '2026-10-02' });
    h.d.dispatch({ type: 'MATERIALIZE_REPEAT', lid: 'n1', line: 0, date: '2026-10-02' });
    await tick();
    expect(h.writes(), '前提:1 度だけ書かれた').toBe(1);
    expect(h.disk.body.split('\n').filter((l) => l.includes('@2026-10-02')), '行が重複した').toHaveLength(1);
    expect(seen.join('\n'), '済んでいるのに嘘の理由を出した').not.toContain(LIES);
    expect(h.d.getState().notice, '済んでいる旨を言っていない').toContain('もう完了しています');
  });

  it('対照群:本当に本文が変わっていたら、今までどおり言う', async () => {
    // 行番号が指す先が繰り返しの行ではない(開いている間に本文が書き換わった)
    const h = boot('ただの文\n');
    h.d.dispatch({ type: 'MATERIALIZE_REPEAT', lid: 'n1', line: 0, date: '2026-10-02' });
    await tick();
    expect(h.writes()).toBe(0);
    expect(h.d.getState().error ?? '').toContain(LIES);
    expect(h.d.getState().notice ?? '').not.toContain('もう完了');
  });
});

describe('isRepeatAlreadyDone(判定を直に当てる)', () => {
  const rw = { kind: 'repeat-done' as const, line: 0, date: '2026-10-02' };
  it('書いた後の本文では true / 書く前・行違い・別の kind では false', () => {
    const before = `${RULE}\n`;
    const after = applyBodyRewrite(before, rw);
    expect(after, '前提:1 度目は書ける').not.toBeNull();
    expect(isRepeatAlreadyDone(after!, rw)).toBe(true);
    expect(isRepeatAlreadyDone(before, rw)).toBe(false);
    expect(isRepeatAlreadyDone('ただの文\n', rw)).toBe(false);
    expect(isRepeatAlreadyDone(after!, { ...rw, line: 5 })).toBe(false);
    expect(isRepeatAlreadyDone(after!, { kind: 'task', line: 0, checked: true } as never)).toBe(false);
  });
});
