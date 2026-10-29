/** @vitest-environment happy-dom */
/**
 * 🔴 **ノートのピン留め ── 左の列の一覧の最上段に固定する専用エリア**(#1377)。
 *
 * 守る主張:
 * 1. **置けるなら外せる** ── 行の右クリックに「ピン留めする / ピン留めを外す」が対で出て、エリアの各行の「外す」でも外れる
 * 2. **エリアは一覧の外・上にあり、面や絞り込みに関わらず出る**(更新順・フォルダの移動・語の絞り込みに動かされない)
 * 3. 行を押すとそのノートが開く(一覧の行と同じ 1 本)
 * 4. **消えたノート・別のコレクションの分はエリアに出ず、保存には残る**(ゴミ箱から戻せば復活)
 * 5. **満杯なら理由を声に出して断る**(生きている分だけで数える)
 * 6. 2 ペインの「ブックマーク」とは別物(口もメニューも保存も混ざらない)
 *
 * ⚠ 台は実物(shell + BrowseRouter + binder)── メニューが運ぶ lid と受け手と描画の合意はどれか 1 つの unit には書けない。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { appNotePins, NotePinStore } from '../../src/adapter/platform/note-pin-store';
import { appDualPrefs } from '../../src/adapter/ui/render/dual-prefs';
import {
  MAX_NOTE_PINS,
  MAX_NOTE_PINS_STORED,
  decodeNotePins,
  livePinLids,
  notePinKey,
  notePinRefOf,
  pinRefusal,
  togglePin,
} from '../../src/features/relation/note-pins';
import { SKIPPED_KEYS } from '../../src/features/settings/settings-file';

function meta(lid: string, order: number, archetype = 'text'): EntryMeta {
  return {
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
  };
}

const METAS = [meta('n1', 1), meta('n2', 2), meta('n3', 3)];
const MENU = '[data-pkc-region="context-menu"]';
const AREA = '[data-pkc-region="note-pins"]';

function rightClick(el: Element): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}

function wipe(): void {
  for (const k of [...appNotePins.list()]) appNotePins.toggle(k, 0);
}

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
  wipe();
  appDualPrefs.setBookmarks([]);
});

function setup(metas: readonly EntryMeta[] = METAS) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.onState((s) => browse.render(s, 'filer'));
  bindActions(root, d, {});
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [...metas], relations: [] });
  const area = (): HTMLElement => regions.sidebar.querySelector<HTMLElement>(AREA)!;
  const listRow = (lid: string): HTMLElement => {
    const el = regions.browseHost.querySelector<HTMLElement>(`[data-pkc-entry="${lid}"]`);
    expect(el, `前提が崩れている: 一覧に ${lid} の行が無い`).not.toBeNull();
    return el!;
  };
  const has = (action: string): boolean => root.querySelector(`${MENU} [data-pkc-action="${action}"]`) !== null;
  const press = (action: string): void => {
    const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`);
    expect(b, `メニューに ${action} が無い`).not.toBeNull();
    b!.click();
  };
  const titles = (): string[] =>
    [...area().querySelectorAll('[data-pkc-field="note-pin-open"]')].map((e) => e.textContent ?? '');
  return { root, d, regions, area, listRow, has, press, titles };
}

describe('ピン留めの口(右クリック)', () => {
  it('🔴 留めていなければ「ピン留めする」だけ、留めていれば「外す」だけが出る(対)', () => {
    const t = setup();
    rightClick(t.listRow('n1'));
    expect(t.has('pin-note'), '留める口が無い').toBe(true);
    expect(t.has('unpin-note'), '留めていないのに外す口が出ている').toBe(false);
    t.press('pin-note');
    expect(appNotePins.list()).toEqual([notePinKey('c1', 'n1')]);
    rightClick(t.listRow('n1'));
    expect(t.has('unpin-note'), '留めたのに外す口が出ない').toBe(true);
    expect(t.has('pin-note'), '留めたのにまた留める口が出ている').toBe(false);
    t.press('unpin-note');
    expect(appNotePins.list(), '外しても保存に残る').toEqual([]);
  });

  it('🔴 ブックマーク(2 ペイン)とは別物: ピン留めは dual-prefs のブックマークに入らない', () => {
    const t = setup();
    rightClick(t.listRow('n1'));
    t.press('pin-note');
    expect(appDualPrefs.getBookmarks(), 'ブックマークに混ざった').toEqual([]);
    rightClick(t.listRow('n2'));
    expect(t.has('bookmark-note-add'), '左の列の行にブックマークの口が出た(帯が無い面)').toBe(false);
  });

  it('編集中の行・押した行がメニューを開いた時点の物(選択ではない)', () => {
    const t = setup();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    rightClick(t.listRow('n2'));
    t.press('pin-note');
    expect(appNotePins.list(), '選んでいる n1 ではなく押した n2 のはず').toEqual([notePinKey('c1', 'n2')]);
  });
});

describe('固定エリア', () => {
  it('🔴 畳んである → 留めると最上段(一覧の上)に出る → 外すと畳む', () => {
    const t = setup();
    expect(t.area().hidden, '何も留めていないのにエリアが出ている').toBe(true);
    rightClick(t.listRow('n2'));
    t.press('pin-note');
    expect(t.area().hidden).toBe(false);
    expect(t.titles()).toEqual(['t-n2']);
    // 位置: 一覧(browse-host)より前にある
    const kids = [...t.regions.sidebar.children];
    expect(kids.indexOf(t.area()), 'エリアが一覧の上に無い').toBeLessThan(kids.indexOf(t.regions.browseHost));
    t.area().querySelector<HTMLElement>('[data-pkc-action="unpin-note"]')!.click();
    expect(t.area().hidden, '外したのにエリアが残る').toBe(true);
    expect(appNotePins.list()).toEqual([]);
  });

  it('🔴 留めた順に並び、語で絞り込んでも消えない(一覧からは消える)', () => {
    const t = setup();
    appNotePins.toggle(notePinKey('c1', 'n3'), 0);
    appNotePins.toggle(notePinKey('c1', 'n1'), 1);
    t.d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'n2' });
    expect(t.titles(), '留めた順でない / 絞り込みで消えた').toEqual(['t-n3', 't-n1']);
    expect(
      t.regions.browseHost.querySelector('[data-pkc-entry="n1"]'),
      '前提: 絞り込みで一覧からは消えている(対照群)',
    ).toBeNull();
  });

  it('🔴 行を押すとそのノートが開く / 開いている行は押された状態', () => {
    const t = setup();
    appNotePins.toggle(notePinKey('c1', 'n3'), 0);
    const open = t.area().querySelector<HTMLElement>('[data-pkc-field="note-pin-open"]')!;
    expect(open.getAttribute('aria-pressed')).toBe('false');
    open.click();
    expect(t.d.getState().selectedLid).toBe('n3');
    expect(
      t.area().querySelector('[data-pkc-field="note-pin-open"]')!.getAttribute('aria-pressed'),
      '開いているのに押された状態でない',
    ).toBe('true');
  });

  it('🔴 消えたノートは出ない / 別のコレクションの分は出ない / どちらも保存には残る', () => {
    const t = setup();
    appNotePins.toggle(notePinKey('c1', 'n1'), 0);
    appNotePins.toggle(notePinKey('c2', 'n2'), 1);
    appNotePins.toggle(notePinKey('c1', 'gone'), 2);
    expect(t.titles()).toEqual(['t-n1']);
    expect(appNotePins.list()).toHaveLength(3);
  });

  it('🔴 満杯なら理由を言って断る(増えない)', () => {
    const many = Array.from({ length: MAX_NOTE_PINS + 1 }, (_, i) => meta(`m${i}`, i + 1));
    const t = setup(many);
    for (let i = 0; i < MAX_NOTE_PINS; i += 1) appNotePins.toggle(notePinKey('c1', `m${i}`), i);
    rightClick(t.listRow(`m${MAX_NOTE_PINS}`));
    t.press('pin-note');
    expect(appNotePins.list()).toHaveLength(MAX_NOTE_PINS);
    expect(t.d.getState().error ?? '').toContain(`${MAX_NOTE_PINS} 件まで`);
  });
});

describe('ピン留めの規則(純関数)と保存', () => {
  it('綴り・読み込み: 壊れた保存は空へ落ちる / 重複と読めない綴りは捨てる', () => {
    expect(decodeNotePins(null)).toEqual([]);
    expect(decodeNotePins('{')).toEqual([]);
    expect(decodeNotePins('{"a":1}')).toEqual([]);
    expect(decodeNotePins('["c1/a","c1/a","x","/y","c1/",3]')).toEqual(['c1/a']);
    expect(notePinRefOf('c1/a/b')).toEqual({ cid: 'c1', lid: 'a/b' });
  });

  it('livePinLids は他のコレクション・消えたノートを落とす(保存は触らない)', () => {
    const list = ['c1/a', 'c2/b', 'c1/gone', 'c1/c'];
    expect(livePinLids(list, 'c1', (l) => l !== 'gone')).toEqual(['a', 'c']);
    expect(livePinLids(list, null, () => true)).toEqual([]);
  });

  it('togglePin / pinRefusal: 外すのは満杯でも通る・留めるのは満杯で断る', () => {
    expect(togglePin(['c1/a'], 'c1/a', MAX_NOTE_PINS)).toEqual([]);
    expect(togglePin(['c1/a'], 'c1/b', MAX_NOTE_PINS)).toEqual(['c1/a']);
    expect(pinRefusal(['c1/a'], MAX_NOTE_PINS, 'c1/b')).toContain('件まで');
    expect(pinRefusal([], 0, 'c1/b')).toBeNull();
    const stored = Array.from({ length: MAX_NOTE_PINS_STORED }, (_, i) => `c9/${i}`);
    expect(pinRefusal(stored, 0, 'c1/b')).toContain('いっぱい');
  });

  it('🔴 保存できない端末でも、その session の中では効く / 保存の中身は JSON の配列', () => {
    const mem = new Map<string, string>();
    const store = new NotePinStore({ get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) });
    store.toggle('c1/a', 0);
    expect(JSON.parse(mem.get('pkc3.note-pins') ?? 'null')).toEqual(['c1/a']);
    const none = new NotePinStore(null);
    none.toggle('c1/a', 0);
    expect(none.list()).toEqual(['c1/a']);
    // 別のタブが書いた分を読み直す
    mem.set('pkc3.note-pins', '["c1/z"]');
    let fired = 0;
    store.onChange(() => (fired += 1));
    store.refresh();
    expect(store.list()).toEqual(['c1/z']);
    expect(fired).toBe(1);
  });

  it('🔴 端末ごと: 設定ファイルに運ばない物として理由つきで登録されている', () => {
    const hit = SKIPPED_KEYS.find((k) => k.key === 'pkc3.note-pins');
    expect(hit, 'SKIPPED_KEYS に登録されていない').toBeDefined();
    expect(hit!.why.length).toBeGreaterThan(10);
  });
});
