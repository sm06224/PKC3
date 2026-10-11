/** @vitest-environment happy-dom */
/**
 * `attachOne` の置き場と画面を動かさないこと(`place`)── 編集した PDF の新しい添付が使う口(#275 段②-1b)。
 *
 * 🔴 守るもの(本物の Dispatcher と reducer を通す):
 * 1. **指したフォルダの中に置く**(構造のつながりが 1 本、フォルダ → 新しい添付)── ⚠ 他のつながりは張らない
 * 2. **いま読んでいるノートも選択も動かさない**(`keepSelection`)── #683 の「切り出したら読んでいたノートが消えた」
 * 3. 省略したときは今までどおり(ルートに置き、新しいノートを選ぶ)── 対照群
 * 4. 指した所がフォルダでない / 実在しないなら、黙ってルートに作る(作ること自体は断らない)
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { attachOne, type AttachDeps } from '../../src/adapter/ui/actions/attach';

const meta = (lid: string, archetype: string): EntryMeta => ({
  lid,
  title: lid,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

function rig(): { dispatcher: Dispatcher; deps: AttachDeps } {
  const dispatcher = new Dispatcher({
    ...initialState,
    phase: 'ready',
    entryMetas: new Map([
      ['F1', meta('F1', 'folder')],
      ['N1', meta('N1', 'text')],
      ['A1', meta('A1', 'attachment')],
    ]),
    order: ['F1', 'N1', 'A1'],
    selectedLid: 'A1',
  } as AppState);
  const deps: AttachDeps = {
    putBlob: async () => undefined,
    gate: async (run) => run(),
    putMeta: async () => undefined,
    listMetas: async () => [],
    hashBlob: async () => 'a'.repeat(64),
  };
  return { dispatcher, deps };
}

const item = (): Parameters<typeof attachOne>[2] => ({
  name: 'x (編集).pdf',
  type: 'application/pdf',
  size: 4,
  blob: new Blob([new Uint8Array(4)], { type: 'application/pdf' }),
});

describe('attachOne の place', () => {
  it('指したフォルダの中に置き、読んでいるノートと選択を動かさない', async () => {
    const { dispatcher, deps } = rig();
    const r = await attachOne(dispatcher, deps, item(), undefined, { parentLid: 'F1', keepSelection: true });
    expect(r).not.toBeNull();
    const st = dispatcher.getState();
    expect(st.selectedLid, '作ったら選択が新しい添付へ動いた').toBe('A1');
    expect(st.entryMetas.get((r as { lid: string }).lid)?.archetype).toBe('attachment');
    const rels = st.relations.filter((x) => x.toLid === (r as { lid: string }).lid);
    expect(rels, 'フォルダの中に置いたつながりが 1 本でない').toHaveLength(1);
    expect(rels[0]?.fromLid).toBe('F1');
    expect(st.relations.filter((x) => x.fromLid === 'A1' || x.toLid === 'A1'), '元の添付につながりを張った').toEqual([]);
  });

  it('対照群: place を省くと、ルートに作って新しい添付を選ぶ(今までどおり)', async () => {
    const { dispatcher, deps } = rig();
    const r = await attachOne(dispatcher, deps, item());
    const st = dispatcher.getState();
    expect(st.selectedLid).toBe((r as { lid: string }).lid);
    expect(st.relations).toEqual([]);
  });

  it('parentLid が null ならルート / フォルダでない・実在しない lid でも、作ることは断らずルートに置く', async () => {
    for (const parentLid of [null, 'N1', 'GONE']) {
      const { dispatcher, deps } = rig();
      const r = await attachOne(dispatcher, deps, item(), undefined, { parentLid, keepSelection: true });
      expect(r, String(parentLid)).not.toBeNull();
      expect(dispatcher.getState().relations, String(parentLid)).toEqual([]);
      expect(dispatcher.getState().selectedLid).toBe('A1');
    }
  });
});
