/** @vitest-environment happy-dom */
/**
 * 🔴 **ノートのピン留め ── 左のペインの一覧の最上段に固定する専用エリア**(#1377)。
 *
 * 守る主張:
 * 1. **置けるなら外せる** ── 行の右クリックに「ピン留めする / ピン留めを外す」が対で出て、エリアの各行の「外す」でも外れる
 * 2. **エリアは一覧の外・上にあり、面や絞り込みに関わらず出る**
 * 3. 行を押すとそのノートが開く(一覧の行と同じ 1 本)
 * 4. 🔴 **「外す」はその行のピンを外す**(いま選んでいるノートではない)
 * 5. 🔴 **付け外しのたびに、消えたノートのピンを掃除する。満杯の判定は生きているピンだけで数える**
 * 6. 保存は器(storage)── 書き手へ「付ける / 外す + 掃除する lid」が**直列**に渡り、書けなかったら正本を読み直す
 * 7. 2 ペインの「ブックマーク」とは別物(口もメニューも保存も混ざらない)
 *
 * ⚠ 台は実物(shell + BrowseRouter + binder)── メニューが運ぶ lid と受け手と描画の合意はどれか 1 つの unit には書けない。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { appNotePins, NotePinStore } from '../../src/adapter/platform/note-pin-store';
import { appDualPrefs } from '../../src/adapter/ui/render/dual-prefs';
import {
  MAX_NOTE_PINS,
  legacyPinLids,
  legacyPinsWithout,
  livePinLids,
  normalizePinLids,
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/** 書き手の呼び出し記録。 */
let writes: Array<{ lid: string; on: boolean }> = [];

function rightClick(el: Element): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
  appNotePins.setAll([]);
  writes = [];
  appNotePins.attach(
    async (lid, on) => {
      writes.push({ lid, on });
    },
    () => {},
  );
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
  it('🔴 まだなら「ピン留めする」だけ、済みなら「外す」だけが出る(対)', () => {
    const t = setup();
    rightClick(t.listRow('n1'));
    expect(t.has('pin-note'), 'ピン留めする口が無い').toBe(true);
    expect(t.has('unpin-note'), '済みでないのに外す口が出ている').toBe(false);
    t.press('pin-note');
    expect(appNotePins.list()).toEqual(['n1']);
    rightClick(t.listRow('n1'));
    expect(t.has('unpin-note'), '済みなのに外す口が出ない').toBe(true);
    expect(t.has('pin-note'), '済みなのにまたピン留めする口が出ている').toBe(false);
    t.press('unpin-note');
    expect(appNotePins.list()).toEqual([]);
  });

  it('🔴 ブックマーク(2 ペイン)とは別物: ブックマークに入らず、左のペインの行にブックマークの口は出ない', () => {
    const t = setup();
    rightClick(t.listRow('n1'));
    t.press('pin-note');
    expect(appDualPrefs.getBookmarks(), 'ブックマークに混ざった').toEqual([]);
    rightClick(t.listRow('n2'));
    expect(t.has('bookmark-note-add'), '左のペインの行にブックマークの口が出た(帯が無い面)').toBe(false);
  });

  it('メニューを開いた行が相手(選んでいるノートではない)', () => {
    const t = setup();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    rightClick(t.listRow('n2'));
    t.press('pin-note');
    expect(appNotePins.list()).toEqual(['n2']);
  });
});

describe('固定エリア', () => {
  it('🔴 畳んである → ピン留めすると最上段(一覧の上)に出る → 外すと畳む', () => {
    const t = setup();
    expect(t.area().hidden, '何もピン留めしていないのにエリアが出ている').toBe(true);
    rightClick(t.listRow('n2'));
    t.press('pin-note');
    expect(t.area().hidden).toBe(false);
    expect(t.titles()).toEqual(['t-n2']);
    const kids = [...t.regions.sidebar.children];
    expect(kids.indexOf(t.area()), 'エリアが一覧の上に無い').toBeLessThan(kids.indexOf(t.regions.browseHost));
    t.area().querySelector<HTMLElement>('[data-pkc-action="unpin-note"]')!.click();
    expect(t.area().hidden, '外したのにエリアが残る').toBe(true);
    expect(appNotePins.list()).toEqual([]);
  });

  it('🔴 ピン留めした順に並び、語で絞り込んでも消えない(一覧からは消える)', () => {
    const t = setup();
    appNotePins.setAll(['n3', 'n1']);
    t.d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'n2' });
    expect(t.titles(), 'ピン留めした順でない / 絞り込みで消えた').toEqual(['t-n3', 't-n1']);
    expect(t.regions.browseHost.querySelector('[data-pkc-entry="n1"]'), '前提: 絞り込みで一覧からは消えている').toBeNull();
  });

  it('🔴 行を押すとそのノートが開く / 開いている行は押された状態', () => {
    const t = setup();
    appNotePins.setAll(['n3']);
    const open = t.area().querySelector<HTMLElement>('[data-pkc-field="note-pin-open"]')!;
    expect(open.getAttribute('aria-pressed')).toBe('false');
    open.click();
    expect(t.d.getState().selectedLid).toBe('n3');
    expect(t.area().querySelector('[data-pkc-field="note-pin-open"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('🔴 「外す」は押した行のピンを外す(いま選んでいるノートのピンではない)', async () => {
    const t = setup();
    appNotePins.setAll(['n1', 'n2']);
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' }); // 選んでいるのは n2
    const rows = [...t.area().querySelectorAll<HTMLElement>('[data-pkc-field="note-pin-row"]')];
    expect(rows).toHaveLength(2);
    rows[0]!.querySelector<HTMLElement>('[data-pkc-action="unpin-note"]')!.click(); // n1 の「外す」
    expect(appNotePins.list(), '選んでいる n2 が外れた(押した行の n1 が残った)').toEqual(['n2']);
    await flush();
    expect(writes[writes.length - 1]).toMatchObject({ lid: 'n1', on: false });
  });

  it('🔴 消えたノートのピンは出ない', () => {
    const t = setup();
    appNotePins.setAll(['n1', 'gone']);
    expect(t.titles()).toEqual(['t-n1']);
  });
});

describe('掃除と満杯の数え方', () => {
  it('🔴 付け外しは 1 件だけを書き手へ渡し、写しの他の lid(ゴミ箱のノートのピン)を動かさない', async () => {
    const t = setup();
    appNotePins.setAll(['trashed', 'n1']);
    rightClick(t.listRow('n2'));
    t.press('pin-note');
    expect(appNotePins.list(), 'ゴミ箱のノートのピンを写しから落とした').toEqual(['trashed', 'n1', 'n2']);
    await flush();
    expect(writes).toEqual([{ lid: 'n2', on: true }]);
    writes = [];
    t.area().querySelector<HTMLElement>('[data-pkc-action="unpin-note"]')!.click();
    await flush();
    expect(writes).toHaveLength(1);
    expect(appNotePins.list()).toEqual(['trashed', 'n2']);
  });

  it('🔴 満杯の判定は生きているピンだけで数える(消えたピンが枠を食わない)', () => {
    const many = Array.from({ length: MAX_NOTE_PINS + 1 }, (_, i) => meta(`m${i}`, i + 1));
    const t = setup(many);
    // 生きている 19 件 + 消えた 5 件(数に入れれば満杯)
    appNotePins.setAll([...Array.from({ length: MAX_NOTE_PINS - 1 }, (_, i) => `m${i}`), 'x1', 'x2', 'x3', 'x4', 'x5']);
    rightClick(t.listRow(`m${MAX_NOTE_PINS - 1}`));
    t.press('pin-note');
    expect(t.d.getState().error ?? '', '消えたピンを数えて断った').toBe('');
    expect(appNotePins.list().filter((l) => l.startsWith('m')), '押したのに留まっていない').toHaveLength(MAX_NOTE_PINS);
    // 本当に生きているのが満杯のときは理由を言って断る
    rightClick(t.listRow(`m${MAX_NOTE_PINS}`));
    t.press('pin-note');
    expect(appNotePins.list().filter((l) => l.startsWith('m'))).toHaveLength(MAX_NOTE_PINS);
    expect(t.d.getState().error ?? '').toContain(`${MAX_NOTE_PINS} 件まで`);
  });

  it('純関数: togglePin / pinRefusal / 掃除の境目', () => {
    const exists = (l: string): boolean => l.startsWith('n');
    expect(livePinLids(['n1', 'x', 'n2'], exists)).toEqual(['n1', 'n2']);
    expect(togglePin(['n1'], 'n1', exists)).toEqual({ list: [], refused: false });
    expect(togglePin(['n1', 'x'], 'n2', exists)).toEqual({ list: ['n1', 'x', 'n2'], refused: false });
    const full = Array.from({ length: MAX_NOTE_PINS }, (_, i) => `n${i}`);
    expect(togglePin(full, 'n99', exists).refused, '生きている満杯は断る').toBe(true);
    expect(togglePin(full, 'n0', exists).refused, '外すのは満杯でも通る').toBe(false);
    expect(pinRefusal(full, 'n99', exists)).toContain('件まで');
    expect(pinRefusal(full, 'n0', exists), '済みは断らない').toBeNull();
    expect(pinRefusal([...full.slice(1), 'dead'], 'n99', exists), '消えた分は数えない').toBeNull();
    expect(normalizePinLids(['a', 'a', '', 3, 'b'])).toEqual(['a', 'b']);
    expect(normalizePinLids({})).toEqual([]);
  });
});

describe('書き手と正本', () => {
  it('🔴 書込は直列(速く 2 回押しても追い越さない)/ 失敗したら正本を読み直す口を呼ぶ', async () => {
    const order: string[] = [];
    let failed = 0;
    const store = new NotePinStore();
    store.attach(
      async (lid, on) => {
        order.push(`start ${lid} ${on}`);
        await new Promise((r) => setTimeout(r, lid === 'a' ? 20 : 0));
        if (lid === 'bad') throw new Error('x');
        order.push(`end ${lid}`);
      },
      () => void (failed += 1),
    );
    const ok = (): boolean => true;
    store.toggle('a', ok);
    store.toggle('b', ok);
    store.toggle('bad', ok);
    await new Promise((r) => setTimeout(r, 80));
    expect(order, '前の書込が終わる前に次が始まった').toEqual([
      'start a true',
      'end a',
      'start b true',
      'end b',
      'start bad true',
    ]);
    expect(failed, '書けなかったのに読み直しを頼まない').toBe(1);
  });

  it('setAll は変わったときだけ知らせる / onChange は外せる', () => {
    const s = new NotePinStore();
    let n = 0;
    const off = s.onChange(() => (n += 1));
    s.setAll(['a']);
    s.setAll(['a']);
    expect(n).toBe(1);
    off();
    s.setAll(['b']);
    expect(n).toBe(1);
  });

  it('🔴 他タブの書込を拾う配線が main.ts に在る(読み直しの束ねの中)', () => {
    const main = readFileSync('src/main.ts', 'utf-8');
    const at = main.indexOf('const queueSnapshotReload');
    expect(at).toBeGreaterThan(0);
    const body = main.slice(at, main.indexOf('};', at));
    expect(body, '他タブのピン留めを読み直していない').toContain('reloadNotePins()');
    const proxy = readFileSync('src/adapter/platform/storage/store-proxy.ts', 'utf-8');
    expect(proxy, 'putNotePin が放送の対象に入っていない').toMatch(/MUTATING_OPS[\s\S]*'putNotePin'/);
  });
});

describe('旧い版の端末の記憶からの移行', () => {
  it('🔴 この器の分だけ取り出し、取り出した分を除いた残りを返す(他の器の分は残す・空なら鍵ごと消す)', () => {
    const raw = JSON.stringify(['c1/a', 'c2/b', 'c1/c', 'ゴミ', 3]);
    expect(legacyPinLids(raw, 'c1')).toEqual(['a', 'c']);
    expect(legacyPinLids(raw, 'c2')).toEqual(['b']);
    expect(legacyPinLids(raw, 'c9')).toEqual([]);
    expect(legacyPinLids('{', 'c1')).toEqual([]);
    expect(legacyPinLids(null, 'c1')).toEqual([]);
    expect(JSON.parse(legacyPinsWithout(raw, 'c1')!)).toEqual(['c2/b', 'ゴミ']);
    expect(legacyPinsWithout(JSON.stringify(['c1/a']), 'c1'), '空になったら鍵ごと消す').toBeNull();
    // 同じ器でも "c10" を "c1" と取り違えない
    expect(legacyPinLids(JSON.stringify(['c10/a']), 'c1')).toEqual([]);
    expect(legacyPinsWithout(JSON.stringify(['c10/a']), 'c1')).toBe(JSON.stringify(['c10/a']));
  });

  it('🔴 設定ファイルに運ばない物として理由つきで登録されている(移行用の鍵)', () => {
    const hit = SKIPPED_KEYS.find((k) => k.key === 'pkc3.note-pins');
    expect(hit, 'SKIPPED_KEYS に登録されていない').toBeDefined();
    expect(hit!.why.length).toBeGreaterThan(10);
  });

  it('main.ts が移行を配線している(取り込んだら端末の記憶から消す)', () => {
    const main = readFileSync('src/main.ts', 'utf-8');
    expect(main).toContain('legacyPinLids(raw, cid)');
    expect(main).toContain('legacyPinsWithout(raw, cid)');
  });
});

describe('操作を探すから(開いているノート)', () => {
  const run = (t: ReturnType<typeof setup>, cmd: string, dry = false): { ran: boolean; said: string[] } => {
    const said: string[] = [];
    const ran = runGlobalCommand(cmd, t.root, t.d, new KeymapStore(), () => {}, (x) => void said.push(x), dry);
    return { ran, said };
  };

  it('🔴 まだなら「ピン留めする」だけ、済みなら「外す」だけが押せる(行の右クリックと同じ対)', async () => {
    const t = setup();
    expect(run(t, 'pin-note', true).ran, 'ノートを開いていないのに押せる').toBe(false);
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    expect(run(t, 'pin-note', true).ran).toBe(true);
    expect(run(t, 'unpin-note', true).ran, '済みでないのに外せる').toBe(false);
    expect(run(t, 'pin-note').ran).toBe(true);
    expect(appNotePins.list()).toEqual(['n2']);
    await flush();
    expect(writes).toEqual([{ lid: 'n2', on: true }]);
    expect(run(t, 'pin-note', true).ran, '済みなのに「する」が押せる').toBe(false);
    expect(run(t, 'unpin-note').ran).toBe(true);
    expect(appNotePins.list()).toEqual([]);
  });

  it('満杯(生きているピン)なら理由を言って断る', () => {
    const many = Array.from({ length: MAX_NOTE_PINS + 1 }, (_, i) => meta(`m${i}`, i + 1));
    const t = setup(many);
    appNotePins.setAll(Array.from({ length: MAX_NOTE_PINS }, (_, i) => `m${i}`));
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: `m${MAX_NOTE_PINS}` });
    const r = run(t, 'pin-note');
    expect(r.said.join('')).toContain(`${MAX_NOTE_PINS} 件まで`);
    expect(appNotePins.list()).toHaveLength(MAX_NOTE_PINS);
  });
});
