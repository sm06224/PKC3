/** @vitest-environment happy-dom */
/**
 * 🔴 **「中まで全部出す」の一言に、最近開いたノートへの近道を添える**(#1254 §3 改善 B。Gemini 裁定 = a)。
 *
 * > user の物語:一覧のタブが無くなった後、最近開いた順に全部を見るには フォルダ → ルート →
 * > 「中まで全部出す」→ 並び順 の 3 手かかる。近道の鍵(最近開いたノートへ移る)は
 * > マニュアルにしか書いていなかった。全部を平らに出している人の目の前で教える。
 *
 * ⚠ 守る主張:
 *  ① 入れている間の一言(「全部出しています(N 件)」)の隣に「最近開いたノートは <鍵>」が出る
 *  ② 鍵の綴りは**割当の表から引く**(期待値は `chordLabel(keymap の第 1 割当)` ── 手で書かない)
 *  ③ 割当を外した state では添えない(嘘の鍵を書かない)── 一言そのもの(件数)は残る
 *  ④ 割当を変えたら、**組み直しを待たずに**いま出ている字が書き変わる
 *  ⑤ 切のときは一言ごと出ない(既存の主張を壊していない)
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { chordLabel } from '../../src/features/keymap';

const meta = (lid: string, order: number, archetype = 'text'): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});
const rel = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

const METAS = [meta('f1', 1, 'folder'), meta('a', 2), meta('x', 3)];
const RELS = [rel('r1', 'f1', 'a')];

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function flatState(on: boolean): AppState {
  let st = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS }).state;
  if (on) st = reduce(st, { type: 'SET_FILER_FLATTEN', on: true }).state;
  return st;
}

function mount(keymap: KeymapStore) {
  document.body.textContent = '';
  const region = document.createElement('div');
  document.body.append(region);
  const filer = new FilerRenderer(region, keymap);
  const note = (): HTMLElement | null =>
    region.querySelector('[data-pkc-region="filer-breadcrumb"] [data-pkc-field="filer-flatten-note"]');
  const recent = (): HTMLElement | null =>
    region.querySelector('[data-pkc-region="filer-breadcrumb"] [data-pkc-field="filer-flatten-recent"]');
  return { region, filer, note, recent };
}

afterEach(() => {
  document.body.textContent = '';
});

describe('「全部出しています」に最近開いたノートの近道を添える(#1254 §3 改善 B)', () => {
  it('🔴 入れている間は、一言の隣に「最近開いたノートは <割当の第 1 鍵>」が出る', () => {
    const keymap = new KeymapStore(memoryStorage());
    const { filer, note, recent } = mount(keymap);
    filer.render(flatState(true));
    // ⚠ 空振り防止 ── 一言そのものと、割当の第 1 鍵が在る
    expect(note(), '前提:全部出しています の一言が出ていない').not.toBeNull();
    const first = keymap.getBindings()['open-recent']?.[0];
    expect(first, '前提:最近開いたノートへ移る に割当が無い').toBeDefined();
    expect(recent(), '近道が添えられていない').not.toBeNull();
    expect(recent()!.textContent).toBe(`最近開いたノートは ${chordLabel(first!)}`);
    // 件数の一言は壊していない(別の要素で添える)
    expect(note()!.textContent).toMatch(/^全部出しています\(\d+ 件\)$/);
    // 一言と同じ塊の中(列が狭いとき、押し口だけが離れて落ちない)
    expect(recent()!.closest('[data-pkc-field="filer-flatten-group"]')).toBe(
      note()!.closest('[data-pkc-field="filer-flatten-group"]'),
    );
  });

  it('🔴 割当を外した state では添えない ── 件数の一言は残る(対照群)', () => {
    const keymap = new KeymapStore(memoryStorage());
    for (const chord of [...(keymap.getBindings()['open-recent'] ?? [])]) {
      keymap.removeBinding('open-recent', chord);
    }
    expect(keymap.getBindings()['open-recent'] ?? [], '前提:割当が外れていない').toHaveLength(0);
    const { filer, note, recent } = mount(keymap);
    filer.render(flatState(true));
    expect(note(), '前提:一言が出ていない').not.toBeNull();
    expect(recent(), '割当が無いのに鍵を書いている').toBeNull();
  });

  it('🔴 ユーザーが鍵を変えたら、出ている字がその場で書き変わる(割当が無くなれば消え、戻せば出る)', () => {
    const keymap = new KeymapStore(memoryStorage());
    const { filer, recent } = mount(keymap);
    filer.render(flatState(true));
    const before = recent()!.textContent;
    keymap.addBinding('open-recent', 'Alt+Shift+J');
    // 第 1 割当は既定のまま(足しただけ)── 字は変わらない
    expect(recent()!.textContent).toBe(before);
    for (const c of [...(keymap.getBindings()['open-recent'] ?? [])]) {
      if (c !== 'Alt+Shift+J') keymap.removeBinding('open-recent', c);
    }
    // 第 1 割当が変わった ── 組み直し(render)を待たずに字が変わる
    expect(recent()!.textContent, '鍵を変えたのに古い綴りが残っている').toBe(
      `最近開いたノートは ${chordLabel('Alt+Shift+J')}`,
    );
    keymap.removeBinding('open-recent', 'Alt+Shift+J');
    expect(recent(), '割当が無くなったのに鍵が残っている').toBeNull();
    keymap.resetCommand('open-recent');
    expect(recent(), '既定へ戻したのに出ない').not.toBeNull();
    expect(recent()!.textContent).toBe(before);
  });

  it('⚠ 切のときは一言ごと出ない(対照群)', () => {
    const keymap = new KeymapStore(memoryStorage());
    const { filer, note, recent, region } = mount(keymap);
    filer.render(flatState(false));
    expect(region.querySelector('[data-pkc-field="filer-flatten"]'), '前提:押し口が無い').not.toBeNull();
    expect(note()).toBeNull();
    expect(recent(), '切なのに近道が出ている').toBeNull();
  });
});
