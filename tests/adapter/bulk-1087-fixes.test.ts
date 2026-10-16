/** @vitest-environment happy-dom */
/**
 * #1087 まとめての操作の直し 4 件。
 *
 * B1. 編集中に帯の「タグを付ける / 外す」を押すと、打った字だけ消えて何も起きなかった
 * B3. まとめてゴミ箱へ移すと、消す途中の後継ごとに本文を読んでいた(3000 件で 2999 回)
 * B4. 「元に戻す」の途中で編集に入ると、戻したノートが一覧に出なかった
 * B5. ゴミ箱へ移せなかったとき、理由(`disk I/O error`)だけが出ていた
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { reduce, type AppState } from '../../src/adapter/state/app-state';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, order = Number(lid.slice(1))): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

beforeEach(() => {
  document.body.textContent = '';
});

function booted(n: number): Dispatcher {
  const d = new Dispatcher();
  const metas = Array.from({ length: n }, (_, i) => meta('e' + (i + 1)));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  return d;
}

describe('B1. 編集中の「タグを付ける / 外す」', () => {
  function setup() {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    const host = document.createElement('div');
    root.append(host);
    const filer = new FilerRenderer(host);
    d.onState((s) => filer.render(s));
    bindActions(root, d);
    const disk: Record<string, string> = { e1: 'あ\n', e2: 'い\n' };
    let writes = 0;
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async (lid) => disk[lid] ?? null,
      getBodies: async (lids) => lids.filter((l) => disk[l] !== undefined).map((l) => ({ lid: l, body: disk[l]! })),
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('x')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async (e) => {
        writes++;
        disk[e.lid] = e.body;
        return stubStamps();
      },
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1'), meta('e2')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'e2' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: 'あ\n' });
    d.dispatch({ type: 'START_EDIT', lid: 'e1' } as never);
    return { root, d, writes: () => writes };
  }

  for (const [action, verb] of [
    ['bulk-tag-add', '付けて'],
    ['bulk-tag-remove', '外して'],
  ] as const) {
    it(`🔴 ${action}: 理由を言い、打った字は残す`, async () => {
      const s = setup();
      await tick();
      expect(s.d.getState().phase, '台の前提: 編集に入っていない').toBe('editing');
      const input = s.root.querySelector<HTMLInputElement>('[data-pkc-field="bulk-tag"]');
      expect(input, '台の前提: 帯のタグ欄が無い').not.toBeNull();
      input!.value = '請求済';
      s.root.querySelector<HTMLElement>(`[data-pkc-action="${action}"]`)!.click();
      await tick();
      expect(input!.value, '打った字が消えた').toBe('請求済');
      expect(s.d.getState().error).toBe(`編集を保存するか、編集をやめてからタグを${verb}ください`);
      expect(s.writes()).toBe(0);
    });
  }
});

describe('B3. まとめてゴミ箱へ ── 後継は 1 回だけ選ぶ', () => {
  it('🔴 200 件を消す(開いている物を含む)と、本文の読み出しは 1 回だけ', () => {
    const d = booted(200);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    const all = Array.from({ length: 199 }, (_, i) => 'e' + (i + 1)); // e200 だけ残す
    const events: string[] = [];
    d.onEvent((e) => events.push(e.type + ':' + ('lid' in e ? e.lid : '')));
    d.dispatch({ type: 'DELETE_ENTRIES', lids: all });
    expect(events.filter((e) => e.startsWith('REQUEST_BODY')), 'REQUEST_BODY の数').toEqual(['REQUEST_BODY:e200']);
    expect(events.filter((e) => e.startsWith('REQUEST_DELETE')).length).toBe(199);
    expect(d.getState().selectedLid).toBe('e200');
    expect(d.getState().entryMetas.size).toBe(1);
  });

  it('1 件ずつ消したときと同じ後継になる(位置を変えて総当たり)', () => {
    // 10 件のうち、消す物の組を変える。開いているのは e5(中ほど)・e1(先頭)・e10(末尾)
    const sets: string[][] = [
      ['e5'],
      ['e5', 'e6'],
      ['e5', 'e6', 'e7', 'e8', 'e9', 'e10'],
      ['e1', 'e2', 'e5'],
      ['e10'],
      ['e9', 'e10'],
      ['e1'],
      ['e1', 'e2', 'e3'],
      ['e3', 'e5', 'e7'],
      ['e4', 'e5', 'e6'],
    ];
    for (const open of ['e1', 'e5', 'e10']) {
      for (const gone of sets) {
        if (!gone.includes(open)) continue;
        // 旧: 1 件ずつ(削除の順は選んだ順)
        const one = booted(10);
        one.dispatch({ type: 'SELECT_ENTRY', lid: open });
        for (const l of gone) one.dispatch({ type: 'DELETE_ENTRY', lid: l });
        const many = booted(10);
        many.dispatch({ type: 'SELECT_ENTRY', lid: open });
        many.dispatch({ type: 'DELETE_ENTRIES', lids: gone });
        expect(many.getState().selectedLid, `open=${open} gone=${gone.join(',')}`).toBe(one.getState().selectedLid);
      }
    }
  });

  it('全部消すと選択は null で、読み出しは出ない', () => {
    const d = booted(3);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e2' });
    const events: string[] = [];
    d.onEvent((e) => events.push(e.type));
    d.dispatch({ type: 'DELETE_ENTRIES', lids: ['e1', 'e2', 'e3'] });
    expect(d.getState().selectedLid).toBeNull();
    expect(events).not.toContain('REQUEST_BODY');
  });

  it('開いていない物だけを消したら、選択も読み出しも動かない', () => {
    const d = booted(5);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    const events: string[] = [];
    d.onEvent((e) => events.push(e.type));
    d.dispatch({ type: 'DELETE_ENTRIES', lids: ['e3', 'e4'] });
    expect(d.getState().selectedLid).toBe('e1');
    expect(events).not.toContain('REQUEST_BODY');
  });
});

describe('B4. 編集中に着いた、ゴミ箱からの復元', () => {
  function editingOther(): AppState {
    const d = booted(5);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e4' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'e4', body: '本文\n' });
    d.dispatch({ type: 'DELETE_ENTRIES', lids: ['e1', 'e2'] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e4' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'e4', body: '本文\n' });
    d.dispatch({ type: 'START_EDIT', lid: 'e4' } as never);
    return d.getState();
  }

  it('🔴 別のノートの復元は一覧に足す(選択と開いている本文は動かさない)', () => {
    const st = editingOther();
    expect(st.phase, '台の前提: 編集に入っていない').toBe('editing');
    expect(st.entryMetas.has('e1'), '台の前提: e1 が残っている').toBe(false);
    const r = reduce(st, { type: 'ENTRY_RESTORED', mode: 'trash', meta: meta('e1'), body: '戻した\n' });
    expect(r.state.entryMetas.has('e1'), '一覧に出ない').toBe(true);
    expect(r.state.order[0], '元の位置(先頭)').toBe('e1');
    expect(r.state.selectedLid).toBe('e4');
    expect(r.state.openBody?.lid).toBe('e4');
    expect(r.state.phase).toBe('editing');
  });

  it('履歴の復元は従来どおり捨てる / 居るノートの二重復元も捨てる', () => {
    const st = editingOther();
    const rev = reduce(st, { type: 'ENTRY_RESTORED', mode: 'revision', meta: meta('e1'), body: 'x' });
    expect(rev.state.entryMetas.has('e1')).toBe(false);
    const dup = reduce(st, { type: 'ENTRY_RESTORED', mode: 'trash', meta: { ...meta('e3'), title: '別' }, body: 'x' });
    expect(dup.state.entryMetas.get('e3')?.title).toBe('t-e3');
  });
});

describe('B5. ゴミ箱へ移せなかったとき', () => {
  it('🔴 何が起きたかを前置きする', async () => {
    const d = new Dispatcher();
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '本文\n',
      deleteEntry: async () => {
        throw new Error('disk I/O error');
      },
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('x')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1'), meta('e2')], relations: [] });
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'e2' });
    await tick(40);
    expect(d.getState().error).toBe('ゴミ箱へ移せませんでした(再読み込みすると元に戻ります): disk I/O error');
  });
});
