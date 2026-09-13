/** @vitest-environment happy-dom */
/**
 * 🔴 **グループの見出しを押すと畳める**(#857 段④)。
 *
 * ⚠ 意味論(何を畳めるか / 絞り込み中は無視する)は
 *   `tests/features/group-fold.test.ts`。**ここが見るのは繋がり**である ──
 *   押した見出しから、保存と画面まで本当に届くか。
 *
 * 🔴 守る主張:
 * 1. 見出しを押すと、その群のタイルが**画面から消える**(件数は見出しに出る)
 * 2. もう一度押すと戻る
 * 3. **名前の無い群には押し所を出さない**(畳んだら開く口が消えるため)
 * 4. 🔴 **絞り込みを打つと、畳んでいても出る**(打ったのに何も出ない、を作らない)
 * 5. 畳みは**端末ごと**の保存に書かれる(state には入っていない)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { GroupFoldStore } from '../../src/adapter/ui/render/group-fold';
import { withBuiltinTiles, type LauncherTile } from '../../src/features/launcher/tiles';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid,
    title: lid,
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/** 名前の無い群に 1 枚、「資料」に 2 枚 + 組み込み。 */
const TILES = (): LauncherTile[] =>
  withBuiltinTiles(
    [
      { lid: 'a1', title: '電卓', group: '', kind: 'url', url: 'https://a.test/', order: 0 },
      { lid: 'b1', title: '地図', group: '資料', kind: 'url', url: 'https://b.test/', order: 0 },
      { lid: 'b2', title: '辞書', group: '資料', kind: 'url', url: 'https://c.test/', order: 1 },
    ],
    { office: false },
  );

let root: HTMLElement;
let region: HTMLElement;
let d: Dispatcher;
let folds: GroupFoldStore;
let detach: () => void;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  region = document.createElement('div');
  root.append(region);
  folds = new GroupFoldStore(null);
  const r = new LauncherRenderer(region, folds);
  d = new Dispatcher();
  /**
   * 🔑 **配線は実物どうしで繋ぐ**(CLAUDE.md §7)── binder が撃つ service を
   *   `main.ts` と同じ形(保存へ書いて描き直す)でここに置く。
   */
  detach = bindActions(root, d, {
    toggleAppGroup: (g) => {
      folds.toggle(g);
      r.render(d.getState());
    },
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a1', 1), meta('b1', 2), meta('b2', 3)],
    relations: [],
  });
  d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: TILES() });
  d.onState(() => r.render(d.getState()));
  r.render(d.getState());
});

afterEach(() => detach());

const headBtn = (name: string): HTMLElement => {
  const el = region.querySelector<HTMLElement>(`[data-pkc-action="toggle-app-group"][data-pkc-group="${name}"]`);
  expect(el, `「${name}」の見出しに押し所が無い`).not.toBeNull();
  return el!;
};
const shown = (lid: string): boolean =>
  region.querySelector(`[data-pkc-tile="${lid}"]`) !== null;
const heads = (): string[] =>
  [...region.querySelectorAll('[data-pkc-field="launcher-group"]')].map((h) => h.textContent ?? '');

describe('グループを畳む(#857 段④)', () => {
  it('🔴 ① 見出しを押すと中のタイルが消え、件数が出る', () => {
    expect(shown('b1') && shown('b2'), '前提が崩れている').toBe(true);
    headBtn('資料').click();
    expect(shown('b1') || shown('b2'), '畳んだのにタイルが残っている').toBe(false);
    expect(heads(), '畳んだのに件数が出ていない').toContain('資料(2)');
    // ⚠ 他の群は巻き込まない(名前の無い群のタイルは出たまま)
    expect(shown('a1'), '関係ない群まで畳んだ').toBe(true);
  });

  it('🔴 ② もう一度押すと戻る', () => {
    headBtn('資料').click();
    headBtn('資料').click();
    expect(shown('b1') && shown('b2'), '開かない(片道の操作になっている)').toBe(true);
    expect(heads(), '開いたのに件数が残っている').toContain('資料');
  });

  it('🔴 ③ 名前の無い群には押し所を出さない(開く口が消えるため)', () => {
    expect(
      region.querySelector('[data-pkc-action="toggle-app-group"][data-pkc-group=""]'),
      '名前の無い群に畳む口を出した',
    ).toBeNull();
  });

  it('🔴 ④ 絞り込みを打つと、畳んでいても出る', () => {
    headBtn('資料').click();
    expect(shown('b1'), '前提が崩れている(畳めていない)').toBe(false);
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '地図' });
    expect(shown('b1'), '絞り込んだのに畳みが隠した(打ったのに何も出ない)').toBe(true);
    // ⚠ 対照群 ── 絞り込みを消したら、畳みは効いたまま(押した覚えが消えない)
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
    expect(shown('b1'), '絞り込みを消したら畳みまで解けた').toBe(false);
  });

  it('🔴 ⑤ 畳みは保存の側に在る(state は 1 バイトも動かない)', () => {
    /**
     * ⚠ **「state に `資料` の字が無い」では見られない** ── 群の名前は
     *   タイルのデータとして state に**正しく在る**(1 稿目はそこで外した)。
     * 🔑 見るのは「**畳んでも state が動かない**」ことである。
     */
    const before = JSON.stringify(d.getState());
    headBtn('資料').click();
    expect([...folds.get()], '保存に書かれていない').toEqual(['資料']);
    expect(
      JSON.stringify(d.getState()),
      '端末ごとの見え方が container の state に紛れ込んでいる',
    ).toBe(before);
  });

  it('⚠ 組み込みの群も畳める(名前を持つので)', () => {
    expect(shown('builtin:dual'), '前提が崩れている').toBe(true);
    headBtn('組み込みアプリ').click();
    expect(shown('builtin:dual'), '組み込みの群だけ畳めない').toBe(false);
  });
});
