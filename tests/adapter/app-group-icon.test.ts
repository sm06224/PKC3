/** @vitest-environment happy-dom */
/**
 * 🔴 **グループの見出しに目印を置く**(#857 段②)── 繋がりの側。
 *
 * ⚠ 意味論(読み方 / 書き戻し / 先勝ち)は `tests/features/app-group-spec.test.ts`。
 *   ここが見るのは「**選んだものが、どのノートに、どう届くか**」である。
 *
 * 🔴 守る主張:
 * 1. 目印を選ぶと**グループ用のノートが 1 枚できる**(user が先に作らなくてよい)
 * 2. 🔴 **在れば作らない**(同じ名前のノートを 2 枚にしない ── 起こらなくする側)
 * 3. ⚠ **「なし」で空のノートを生やさない**(頼んでいない物を片付けさせない)
 * 4. 🔴 見出しに目印が出て、**器の字は 1 バイトも変わらない**
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  appGroupIconName,
  initialState,
  reduce,
  type AppState,
} from '../../src/adapter/state/app-state';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { GroupFoldStore } from '../../src/adapter/ui/render/group-fold';
import { withBuiltinTiles, type LauncherTile } from '../../src/features/launcher/tiles';
import {
  APP_GROUP_ARCHETYPE,
  appGroupIconsOf,
  readAppGroupIcon,
} from '../../src/features/launcher/app-group-spec';

function meta(lid: string, title: string, archetype: string, order: number): EntryMeta {
  return {
    lid,
    title,
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

/** 添付 1 件だけの、動ける state。 */
function booted(extra: readonly EntryMeta[] = []): AppState {
  return reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a1', '地図', 'attachment', 1), ...extra],
    relations: [],
  }).state;
}

describe('目印を選ぶ(#857 段②)', () => {
  it('🔴 ① グループ用のノートが 1 枚できる(user が先に作らなくてよい)', () => {
    // ⚠ 「退かさない」を見るために、**退かされうる状態**を作っておく
    const before = reduce(reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a1' }).state, {
      type: 'SET_ENTRY_FILTER',
      query: '探しもの',
    }).state;
    const r = reduce(before, {
      type: 'SET_APP_GROUP_ICON',
      name: '資料',
      icon: 'calendar',
      newLid: 'g1',
    });
    const made = r.state.entryMetas.get('g1');
    expect(made, 'ノートができていない').toBeDefined();
    expect(made!.title, '題名が群の名前になっていない').toBe('資料');
    expect(made!.archetype, '種類が違う(一覧の絞り込みが効かなくなる)').toBe(APP_GROUP_ARCHETYPE);
    /**
     * 🔴 **見ていた物を退かさない。** ⚠ 既定の `CREATE_ENTRY` は「作って開く」なので、
     *   そのまま呼ぶと**右の面が作りたてのノートに変わり、絞り込みまで消える**
     *   (この test を書いていて見つけた ── `keepSelection` で塞いだ)。
     */
    expect(r.state.phase, '目印を選んだだけで編集に入った').toBe('ready');
    expect(r.state.selectedLid, '選んでいた物が退かされた').toBe(before.selectedLid);
    expect(r.state.filterQuery, '絞り込みの欄が消された').toBe('探しもの');
    // 🔑 作った**後の並び**で読み直す ── 作りたてが入っていないと目印が出ない
    const req = r.events.find((e) => e.type === 'REQUEST_APP_GROUP_NOTES');
    expect(req, '作った後に読み直していない').toBeDefined();
    expect(
      (req as { entries: { lid: string }[] }).entries.map((e) => e.lid),
      '作りたてのノートが読み直しに入っていない',
    ).toContain('g1');
  });

  it('🔴 ② 在れば作らない(同じ名前のノートを 2 枚にしない)', () => {
    const st = booted([meta('g0', '資料', APP_GROUP_ARCHETYPE, 2)]);
    const r = reduce(st, {
      type: 'SET_APP_GROUP_ICON',
      name: '資料',
      icon: 'calendar',
      newLid: 'g1',
    });
    expect(r.state.entryMetas.has('g1'), '在るのにもう 1 枚作った').toBe(false);
    const write = r.events.find((e) => e.type === 'REQUEST_APP_GROUP_ICON_WRITE');
    expect(write, '在るノートへ書いていない').toBeDefined();
    expect((write as { lid: string }).lid, '別のノートへ書こうとしている').toBe('g0');
  });

  it('⚠ ③ 「なし」を押しても、無いのに空のノートを作らない', () => {
    const r = reduce(booted(), {
      type: 'SET_APP_GROUP_ICON',
      name: '資料',
      icon: null,
      newLid: 'g1',
    });
    expect(r.state.entryMetas.has('g1'), '頼んでいないノートが生えた').toBe(false);
    expect(r.events, '書く物も無いのに何か撃った').toEqual([]);
  });

  it('⚠ ④ 在るときの「なし」は、外す書込になる(片道にしない)', () => {
    const st = booted([meta('g0', '資料', APP_GROUP_ARCHETYPE, 2)]);
    const r = reduce(st, { type: 'SET_APP_GROUP_ICON', name: '資料', icon: null, newLid: 'g1' });
    const write = r.events.find((e) => e.type === 'REQUEST_APP_GROUP_ICON_WRITE');
    expect((write as { icon: string | null }).icon, '外す指示になっていない').toBeNull();
  });

  it('⚠ ⑤ 名前の無い群には効かない(目印を置く見出しが無い)', () => {
    const r = reduce(booted(), { type: 'SET_APP_GROUP_ICON', name: '  ', icon: 'calendar', newLid: 'g1' });
    expect(r.state.entryMetas.has('g1')).toBe(false);
    expect(r.events).toEqual([]);
  });

  it('⚠ ⑥ 同じ名前が 2 枚あっても、書くのは先の 1 枚(迷わない)', () => {
    const st = booted([
      meta('g0', '資料', APP_GROUP_ARCHETYPE, 2),
      meta('g9', '資料', APP_GROUP_ARCHETYPE, 3),
    ]);
    const r = reduce(st, { type: 'SET_APP_GROUP_ICON', name: '資料', icon: 'calendar', newLid: 'gX' });
    const write = r.events.find((e) => e.type === 'REQUEST_APP_GROUP_ICON_WRITE');
    expect((write as { lid: string }).lid, '後の 1 枚に書いている').toBe('g0');
  });

  it('🔴 ⑦ 作った本文は、読み戻すと目印になっている(囲みを忘れていない)', () => {
    const r = reduce(booted(), {
      type: 'SET_APP_GROUP_ICON',
      name: '資料',
      icon: 'calendar',
      newLid: 'g1',
    });
    // ⚠ 本文は**保存の指示**(`PERSIST_ENTRY`)が運ぶ ── state の meta には本文が無い
    const saved = r.events.find((e) => e.type === 'PERSIST_ENTRY');
    const body = (saved as { entry?: { body?: string } } | undefined)?.entry?.body;
    expect(body, '保存の指示に本文が乗っていない').toBeTruthy();
    expect(
      readAppGroupIcon(body!),
      '作った本文から目印が読めない(囲みを書き忘れている)',
    ).toEqual({ symbol: 'calendar' });
  });
});

/**
 * 🔴 **選んだ直後に開き直しても、選んだ絵に枠が付く**(#1076)。
 *
 * ⚠ 直す前は `appGroupIcons` が変わるのが**読み直しの ack が返ってから**だった ──
 *   実ブラウザ smoke(`launcher.smoke.spec.ts` の「枠が付いているのが、さっき選んだ絵ではない」)が
 *   間欠で赤になり、main でも 3 回に 1 回出ていた。
 * 🔑 ここでは ack を**わざと返さない**(返さない間に表を開き直した user と同じ状態)。
 */
describe('🔴 選んだ直後の表と見出しが、選んだ絵になっている(#1076)', () => {
  /** 目印 `terminal` が既に付いている群「資料」を持つ state(ack まで済ませる)。 */
  function withTerminal(): AppState {
    const st = booted([meta('g0', '資料', APP_GROUP_ARCHETYPE, 2)]);
    const loaded = reduce(st, {
      type: 'APP_GROUP_NOTES_LOADED',
      icons: { 資料: { symbol: 'terminal' } } as AppState['appGroupIcons'],
      orders: {},
      gen: st.appGroupGen,
    }).state;
    // ⚠ 空振り防止 ── 「選ぶ前の絵」が在ることを先に見る(0 件の次元を作らない)
    expect(appGroupIconName(loaded, '資料'), '前提が崩れている(選ぶ前の絵が無い)').toBe('terminal');
    return loaded;
  }

  it('🔴 在るノートへ書くとき、ack を待たずに選んだ絵になる', () => {
    const r = reduce(withTerminal(), {
      type: 'SET_APP_GROUP_ICON',
      name: '資料',
      icon: 'calendar',
      newLid: 'gX',
    });
    expect(appGroupIconName(r.state, '資料'), '読み直しが返るまで、選ぶ前の絵のまま').toBe('calendar');
  });

  it('🔴 作るとき(ノートが無いとき)も、ack を待たずに選んだ絵になる', () => {
    const r = reduce(booted(), {
      type: 'SET_APP_GROUP_ICON',
      name: '資料',
      icon: 'calendar',
      newLid: 'g1',
    });
    expect(r.state.entryMetas.has('g1'), '前提が崩れている(作る経路を通っていない)').toBe(true);
    expect(appGroupIconName(r.state, '資料'), '作ったのに、読み直しが返るまで絵が無い').toBe('calendar');
  });

  it('⚠ 「なし」を選ぶと、ack を待たずに外れる(片道にしない)', () => {
    const r = reduce(withTerminal(), {
      type: 'SET_APP_GROUP_ICON',
      name: '資料',
      icon: null,
      newLid: 'gX',
    });
    expect(appGroupIconName(r.state, '資料'), '「なし」を選んだのに、外れるのが読み直しの後').toBe('');
  });

  it('🔴 先に飛んでいた読み直し(選ぶ前の本文)が返っても、選んだ絵は巻き戻らない', () => {
    const before = withTerminal();
    // ⚠ 選ぶ**前**に積まれて、まだ返っていない読み直しの世代
    const flying = before.appGroupGen;
    const picked = reduce(before, {
      type: 'SET_APP_GROUP_ICON',
      name: '資料',
      icon: 'calendar',
      newLid: 'gX',
    }).state;
    expect(picked.appGroupGen, '前提が崩れている(世代が進んでいない)').not.toBe(flying);
    const late = reduce(picked, {
      type: 'APP_GROUP_NOTES_LOADED',
      icons: before.appGroupIcons,
      orders: {},
      gen: flying,
    }).state;
    expect(appGroupIconName(late, '資料'), '古い読み直しに、選ぶ前の絵へ巻き戻された').toBe('calendar');
  });

  /**
   * ⚠ **対照群** ── 先に当てた絵が disk より強くなってはいけない。
   * 🔑 書けなかったとき(別の窓が書き替えた等)は、後ろから来る読み直しが disk の値を持って来るので、
   *   **それが効いて**選ぶ前の絵へ戻る(画面が disk と食い違ったまま残らない)。
   */
  it('⚠ 選んだ後に積んだ読み直しは効く(書けなかったら disk の絵に戻る)', () => {
    const before = withTerminal();
    const r = reduce(before, {
      type: 'SET_APP_GROUP_ICON',
      name: '資料',
      icon: 'calendar',
      newLid: 'gX',
    });
    const read = r.events.find((e) => e.type === 'REQUEST_APP_GROUP_NOTES') as
      | { gen: number }
      | undefined;
    expect(read, '前提が崩れている(読み直しを積んでいない)').toBeDefined();
    const back = reduce(r.state, {
      type: 'APP_GROUP_NOTES_LOADED',
      icons: before.appGroupIcons,
      orders: {},
      gen: read!.gen,
    }).state;
    expect(appGroupIconName(back, '資料'), 'disk の答えが画面に効いていない').toBe('terminal');
  });
});

describe('見出しに目印を出す(#857 段②)', () => {
  let region: HTMLElement;
  let st: AppState;

  beforeEach(() => {
    document.body.innerHTML = '';
    region = document.createElement('div');
    document.body.append(region);
    const tiles: LauncherTile[] = withBuiltinTiles(
      [{ lid: 'b1', title: '地図', group: '資料', kind: 'url', url: 'https://b.test/', order: 0 }],
      { office: false },
    );
    st = {
      ...booted(),
      launcherTiles: tiles,
      appGroupIcons: appGroupIconsOf([
        { title: '資料', body: `---\nappgroup.icon: calendar\n---\n` },
      ]),
    };
  });

  it('🔴 目印が出て、器の字は 1 バイトも変わらない', () => {
    new LauncherRenderer(region, new GroupFoldStore(null)).render(st);
    const head = [...region.querySelectorAll<HTMLElement>('[data-pkc-field="launcher-group"]')].find(
      (h) => h.textContent === '資料',
    );
    /**
     * 🔴 **これがこの test の本体。** 絵を器の字に混ぜると `textContent` が
     * `🧮資料` に化け、字を読む側(test / 読み上げ / 写し)が静かに外れる
     * (#770 段① で smoke 5 本が落ちた型)。⚠ `toBe` で見る(`toContain` では
     * 混ざっても通ってしまう)。
     */
    expect(head, '見出しの字が変わっている(目印が字に混ざった)').toBeDefined();
    const mark = head!.querySelector('[data-pkc-field="group-icon"]');
    expect(mark, '目印が出ていない').not.toBeNull();
    expect(mark!.getAttribute('data-pkc-symbol'), '図案が指定されていない').not.toBeNull();
    expect(mark!.textContent, '目印が字を持っている(器の字が変わる)').toBe('');
  });

  it('⚠ 目印を持たない群には、印を出さない', () => {
    const head = ((): HTMLElement | undefined => {
      new LauncherRenderer(region, new GroupFoldStore(null)).render({ ...st, appGroupIcons: {} });
      return [...region.querySelectorAll<HTMLElement>('[data-pkc-field="launcher-group"]')].find(
        (h) => h.textContent === '資料',
      );
    })();
    expect(head?.querySelector('[data-pkc-field="group-icon"]'), '無いのに印が出た').toBeNull();
  });
});
