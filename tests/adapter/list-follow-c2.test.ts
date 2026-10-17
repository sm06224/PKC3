/** @vitest-environment happy-dom */
/**
 * 左の一覧の追従・キー・フォルダの中で探す(台帳 #1852 の束 C2。依頼 277 / 336 / 115-3 / 337 / 82-1 / 82-2 / 87-1)。
 *
 * 🔴 守る主張:
 * 1. 一覧に行が無いノートを開くと、一覧もそのノートのフォルダへ移る。出ている行・絞り込み中・
 *    user が場所を決めた操作・いま居るフォルダ自身では動かさない(277)
 * 2. 開いたノートの行が画面の外にあるときだけ送る。一部でも見えていれば動かさない(277)
 * 3. 開いていたフォルダと種類の札を端末に憶え、起動で戻す。別のコレクションの記憶は読まない(277)
 * 4. フォルダの中で探しているときは、そう言い、「すべてのフォルダから探す」を出す(336 / 115-3)
 * 5. Home / End / PageUp / PageDown が選ぶ行を動かす(337)
 * 6. 選んでいる間のバーは貼り付く / 2 件以上選んでいる間は上下ボタンを出さない(82-1 / 82-2)
 * 7. 「探す」の行は、片付けたノートに「片付け済み」と添える(87-1)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { filerRowOptions } from '../../src/adapter/state/list-view-options';
import { filerRows, lidShownInScope } from '../../src/features/relation/filer-list';
import { revealDelta } from '../../src/adapter/ui/render/list-reveal';
import { ListPlaceStore } from '../../src/adapter/ui/render/list-place-memory';
import { connectListPlaceMemory } from '../../src/adapter/platform/list-place-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { OpenInEditStore } from '../../src/adapter/ui/render/open-in-edit';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { SearchRenderer } from '../../src/adapter/ui/render/search';

function mem(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

function meta(lid: string, order: number, title = 't-' + lid, archetype = 'text', over: Partial<EntryMeta> = {}): EntryMeta {
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
    ...over,
  };
}
const rel = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

/**
 * ルート: top(ノート) / work(フォルダ「仕事」)/ misc(フォルダ)
 * 仕事: deep(フォルダ) / w1 / w2   ── deep の中: d1
 * misc: m1
 */
const METAS = [
  meta('top', 1, '最上段'),
  meta('work', 2, '仕事', 'folder'),
  meta('misc', 3, 'そのほか', 'folder'),
  meta('deep', 1, '深い所', 'folder'),
  meta('w1', 2, 'りんごの話'),
  meta('w2', 3, '二つ目'),
  meta('d1', 1, '底のノート'),
  meta('m1', 1, 'みかんの話'),
];
const RELS = [
  rel('r1', 'work', 'deep'),
  rel('r2', 'work', 'w1'),
  rel('r3', 'work', 'w2'),
  rel('r4', 'deep', 'd1'),
  rel('r5', 'misc', 'm1'),
];

const booted = (cid = 'c1'): AppState =>
  reduce(initialState, { type: 'SYS_BOOTED', cid, metas: METAS, relations: RELS }).state;

describe('開いたノートの行が一覧に無いとき、一覧もそのフォルダへ移る(依頼 277)', () => {
  it('🔴 ルートの一覧で、深いフォルダのノートを開くと、そのフォルダへ移る', () => {
    const s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'd1' }).state;
    expect(s.scopeLid, '開いたノートのフォルダへ移っていない').toBe('deep');
    const lids = filerRows(s.scopeLid, s.entryMetas, s.relations, filerRowOptions(s)).map((m) => m.lid);
    expect(lids, '移った先の一覧に、開いたノートの行が無い').toContain('d1');
  });

  it('🔴 移るとき、印(複数選択)は外れる(画面に無い印を残さない)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'top' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'work' }).state;
    expect(s.selection.length, '前提:印が 2 件ある').toBe(2);
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'm1' }).state;
    expect(s.scopeLid).toBe('misc');
    expect(s.selection, '場所を移したのに前の場所の印が残っている(開いたノート自身の 1 件だけのはず)').toEqual(['m1']);
  });

  it('対照群:一覧に出ている行を選んでも、場所は動かない(フォルダの行を選んでも入らない)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'top' }).state;
    expect(s.scopeLid).toBeNull();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'work' }).state;
    expect(s.scopeLid, 'フォルダの行を選んだだけで入った').toBeNull();
  });

  it('対照群:いま居るフォルダ自身を選んでも、場所は動かない(パンくずの最後の段。#1254 §1)', () => {
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 'work' }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'work' }).state;
    expect(s.scopeLid).toBe('work');
  });

  it('対照群:user が場所を決めた操作(SET_SCOPE)は、開いているノートがあっても尊重される', () => {
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'm1' }).state; // → misc
    s = reduce(s, { type: 'SET_SCOPE', lid: 'work' }).state;
    expect(s.scopeLid, '場所を決めたのに開いているノートのフォルダへ引き戻された').toBe('work');
    expect(s.selectedLid).toBe('m1');
  });

  it('🔴 語で絞っているときは、場所を移さない(user の絞りを外さない・移しても行は出ない)', () => {
    let s = reduce(booted(), { type: 'SET_ENTRY_FILTER', query: 'みかん' }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'd1' }).state;
    expect(s.scopeLid).toBeNull();
    // 種類の札も同じ
    let k = reduce(booted(), { type: 'TOGGLE_KIND_FILTER', archetype: 'folder' }).state;
    k = reduce(k, { type: 'SELECT_ENTRY', lid: 'd1' }).state;
    expect(k.scopeLid, '種類の札を押している間に場所が動いた').toBeNull();
  });

  it('🔴 「中まで全部出す」の間は、配下のノートなら動かない(行が出ているので)/ 外のノートなら動く', () => {
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 'work' }).state;
    s = reduce(s, { type: 'SET_FILER_FLATTEN', on: true }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'd1' }).state; // 平らな「仕事」の配下に出ている
    expect(s.scopeLid, '平らな一覧に行が出ているのに場所が動いた').toBe('work');
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'm1' }).state; // 別の枝
    expect(s.scopeLid).toBe('misc');
  });

  it('🔴 ルートのノートを開くと、フォルダの中に居た一覧はルートへ戻る', () => {
    let s = reduce(booted(), { type: 'SET_SCOPE', lid: 'work' }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'top' }).state;
    expect(s.scopeLid).toBeNull();
  });
});

describe('lidShownInScope は filerRows と同じ答えを、並べ替えずに返す(§7 の突き合わせ)', () => {
  const lids = METAS.map((m) => m.lid);
  const scopes: Array<string | null> = [null, 'work', 'deep', 'misc'];
  for (const flatten of [false, true]) {
    it(`🔴 全 scope × 全 lid で一致する(flatten=${String(flatten)})`, () => {
      let checked = 0;
      for (const scope of scopes) {
        const s0 = reduce(booted(), { type: 'SET_SCOPE', lid: scope }).state;
        const s = flatten ? reduce(s0, { type: 'SET_FILER_FLATTEN', on: true }).state : s0;
        const shown = new Set(
          filerRows(s.scopeLid, s.entryMetas, s.relations, filerRowOptions(s)).map((m) => m.lid),
        );
        for (const lid of lids) {
          expect(
            lidShownInScope(lid, scope, s.entryMetas, s.relations, flatten),
            `scope=${String(scope)} lid=${lid} flatten=${String(flatten)}`,
          ).toBe(shown.has(lid));
          checked++;
        }
      }
      expect(checked, '前提:全数を当てている').toBe(scopes.length * lids.length);
    });
  }

  it('スマートフォルダの中は答えない(null ── 条件の当たりで決まる)', () => {
    const metas = [...METAS, meta('smart1', 9, '集まる', 'smart')];
    const s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: RELS }).state;
    expect(lidShownInScope('w1', 'smart1', s.entryMetas, s.relations, false)).toBeNull();
  });
});

describe('開いたノートの行を見える所へ送る量(依頼 277)', () => {
  it('🔴 画面の外(下)にあれば真ん中へ、上にあっても真ん中へ', () => {
    // 表示 100〜500(中心 300)/ 行 900〜926(中心 913)→ +613
    expect(revealDelta(900, 926, 100, 500)).toBe(613);
    // 行 -300〜-274(中心 -287)→ -587
    expect(revealDelta(-300, -274, 100, 500)).toBe(-587);
  });
  it('🔴 一部でも見えていれば動かさない(押した行が跳ばない)', () => {
    expect(revealDelta(490, 516, 100, 500)).toBe(0);
    expect(revealDelta(80, 106, 100, 500)).toBe(0);
    expect(revealDelta(200, 226, 100, 500)).toBe(0);
  });
  it('🔴 画面か行が測れない(高さ 0)ときは動かさない', () => {
    expect(revealDelta(900, 926, 0, 0)).toBe(0);
    expect(revealDelta(900, 900, 100, 500)).toBe(0);
  });
  it('境界:行が画面の下端にちょうど接している(1px も見えない)ときは送る', () => {
    expect(revealDelta(500, 526, 100, 500)).not.toBe(0);
  });
});

describe('開いていたフォルダと種類の札を憶える(依頼 277)', () => {
  const setup = (store: ListPlaceStore, state = booted()) => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: state.cid ?? 'c1', metas: METAS, relations: RELS });
    return { d, off: () => connectListPlaceMemory(d, store) };
  };

  it('🔴 変えるたびに憶え、次の起動で戻す(フォルダも種類の札も)', () => {
    const store = new ListPlaceStore(mem());
    const a = setup(store);
    a.off();
    a.d.dispatch({ type: 'SET_SCOPE', lid: 'work' });
    a.d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'text' });
    expect(store.get()).toEqual({ cid: 'c1', scope: 'work', kinds: ['text'] });
    // 次の起動
    const b = setup(store);
    b.off();
    expect(b.d.getState().scopeLid, '開いていたフォルダに戻らない').toBe('work');
    expect([...b.d.getState().kindFilter], '種類の札が戻らない').toEqual(['text']);
  });

  it('🔴 別のコレクションの記憶は読まない(lid の偶然の一致を持ち越さない)', () => {
    const store = new ListPlaceStore(mem());
    store.set({ cid: 'OTHER', scope: 'work', kinds: ['text'] });
    const b = setup(store);
    b.off();
    expect(b.d.getState().scopeLid).toBeNull();
    expect(b.d.getState().kindFilter.size).toBe(0);
  });

  it('🔴 もう無いフォルダ・無い種類は戻さない(空の一覧で固まらない)', () => {
    const store = new ListPlaceStore(mem());
    store.set({ cid: 'c1', scope: 'gone', kinds: ['spreadsheet'] });
    const b = setup(store);
    b.off();
    expect(b.d.getState().scopeLid).toBeNull();
    expect(b.d.getState().kindFilter.size, '無い種類の札が立って、外せない空の一覧になった').toBe(0);
  });

  it('🔴 ノートを開いている起動(リンクで来た等)では、場所は動かさない', () => {
    const store = new ListPlaceStore(mem());
    store.set({ cid: 'c1', scope: 'misc', kinds: [] });
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'd1' }); // 一覧は deep へ移る
    connectListPlaceMemory(d, store);
    expect(d.getState().scopeLid, '開いているノートの行が見えない場所へ戻した').toBe('deep');
  });

  it('壊れた記憶は「憶えていない」(落ちない)', () => {
    const m = mem();
    m.setItem('pkc3.list-place', '{"c":1}');
    expect(new ListPlaceStore(m).get()).toBeNull();
    m.setItem('pkc3.list-place', 'not json');
    expect(new ListPlaceStore(m).get()).toBeNull();
    m.setItem('pkc3.list-place', JSON.stringify({ c: 'c1', s: 5, k: [] }));
    expect(new ListPlaceStore(m).get()).toBeNull();
    m.setItem('pkc3.list-place', JSON.stringify({ c: 'c1', s: null, k: [1] }));
    expect(new ListPlaceStore(m).get()).toBeNull();
  });
});

describe('左の列の画面(フォルダの表)', () => {
  let root: HTMLElement;
  let d: Dispatcher;
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    d = new Dispatcher();
    const regions = buildShell(root);
    host = regions.browseHost;
    bindActions(root, d, {}, new KeymapStore(mem()), new OpenInEditStore(mem()));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    const filer = new FilerRenderer(host);
    d.onState((st) => filer.render(st));
    filer.render(d.getState());
  });

  const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);
  const row = (lid: string): HTMLElement => q(`[data-pkc-region="filer-table"] [data-pkc-entry="${lid}"]`)!;
  const press = (key: string, from: HTMLElement, over: Partial<KeyboardEventInit> = {}) => {
    from.focus();
    const ev = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...over });
    from.dispatchEvent(ev);
    return ev;
  };
  const shownLids = (): string[] =>
    [...host.querySelectorAll<HTMLElement>('[data-pkc-region="filer-table"] tbody [data-pkc-entry]')].map(
      (e) => e.getAttribute('data-pkc-entry')!,
    );

  describe('フォルダの中で探す(依頼 336 / 115-3)', () => {
    it('🔴 フォルダの中で語を打つと、絞りの行が「○○の中を探しています」と言い、「すべてのフォルダから探す」が出る', () => {
      d.dispatch({ type: 'SET_SCOPE', lid: 'work' });
      d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'りんご' });
      const line = q('[data-pkc-field="filer-filter-line"]');
      expect(line, '絞り込み中の行が出ていない(前提)').not.toBeNull();
      expect(line!.textContent).toContain('「仕事」の中を探しています');
      const all = line!.querySelector<HTMLElement>('[data-pkc-field="filer-search-all"]');
      expect(all, '「すべてのフォルダから探す」が出ていない').not.toBeNull();
      expect(all!.textContent).toBe('すべてのフォルダから探す');
    });

    it('🔴 ルートで打ったときは、フォルダの中とは言わない(範囲が狭くないのに「すべてのフォルダから探す」を出さない)', () => {
      d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'りんご' });
      const line = q('[data-pkc-field="filer-filter-line"]');
      expect(line, '前提:絞り込み中の行が出ている').not.toBeNull();
      expect(line!.textContent).not.toContain('の中を探しています');
      expect(q('[data-pkc-field="filer-search-all"]')).toBeNull();
    });

    it('🔴 そのフォルダに無い語は「このフォルダの中には見つかりません」+ ボタン。押すと語はそのままルートから探し直す', () => {
      d.dispatch({ type: 'SET_SCOPE', lid: 'work' });
      d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'みかん' }); // misc の m1 にしか無い
      d.dispatch({ type: 'SET_SEARCH_HITS', query: 'みかん', lids: [], truncated: false }); // 本文の結果が返った後
      expect(q('[data-pkc-field="filer-empty"]')?.textContent).toBe('このフォルダの中には見つかりません');
      const all = q('[data-pkc-field="filer-search-all"]');
      expect(all, '0 件のときに「すべてのフォルダから探す」が出ない').not.toBeNull();
      all!.click();
      const s = d.getState();
      expect(s.scopeLid, 'ルートへ戻っていない').toBeNull();
      expect(s.filterQuery, '語まで消えた').toBe('みかん');
      expect(shownLids(), 'ルートから探し直した結果に、ほかのフォルダの一致が出ない').toContain('m1');
    });

    it('対照群:ルートで 0 件のときは従来の言い方のまま(フォルダの中とは言わない)', () => {
      d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'zzzzzz' });
      d.dispatch({ type: 'SET_SEARCH_HITS', query: 'zzzzzz', lids: [], truncated: false });
      expect(q('[data-pkc-field="filer-empty"]')?.textContent).toBe('絞り込みに一致するものがありません');
      expect(q('[data-pkc-field="filer-search-all"]')).toBeNull();
    });
  });

  describe('Home / End / PageUp / PageDown(依頼 337)', () => {
    it('🔴 Home / End は先頭 / 末尾の行を選ぶ(印も動く・開いているノートは変わらない)', () => {
      d.dispatch({ type: 'SET_SCOPE', lid: 'work' }); // 並び: deep, w1, w2
      expect(shownLids(), '前提:3 行').toEqual(['deep', 'w1', 'w2']);
      press('End', row('w1'));
      expect(d.getState().selection).toEqual(['w2']);
      expect(document.activeElement, '末尾の行に焦点が移っていない').toBe(row('w2'));
      press('Home', row('w2'));
      expect(d.getState().selection).toEqual(['deep']);
      expect(d.getState().selectedLid, 'Home で中央のノートが開き直った').toBeNull();
    });

    it('🔴 PageDown / PageUp は行数ぶん動き、端で止まる(巻き戻らない)', () => {
      d.dispatch({ type: 'SET_SCOPE', lid: 'work' });
      press('PageDown', row('deep'));
      // happy-dom は高さを測れない → 10 行。3 行しか無いので末尾で止まる
      expect(d.getState().selection).toEqual(['w2']);
      press('PageDown', row('w2'));
      expect(d.getState().selection, '末尾でさらに送ったら巻き戻った').toEqual(['w2']);
      press('PageUp', row('w2'));
      expect(d.getState().selection).toEqual(['deep']);
    });

    it('🔴 編集中は理由を出して断る(無言にしない・既定も奪う)', () => {
      d.dispatch({ type: 'SET_SCOPE', lid: 'work' });
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'w1' });
      d.dispatch({ type: 'BODY_LOADED', lid: 'w1', body: '' });
      d.dispatch({ type: 'START_EDIT' });
      expect(d.getState().phase, '前提:編集中').toBe('editing');
      d.dispatch({ type: 'OP_FAILED', error: '' });
      const ev = press('End', q('[data-pkc-region="filer-table"]')!);
      expect(ev.defaultPrevented).toBe(true);
      expect(d.getState().error ?? '', 'End が無言で断られた').toContain('編集を保存するか');
    });
  });

  describe('選んでいる間のバー(依頼 82-1 / 82-2)', () => {
    it('🔴 印が付いている間だけ、バーは貼り付く印(data-pkc-bulk)を持つ', () => {
      d.dispatch({ type: 'SET_SCOPE', lid: 'work' });
      const bar = q('[data-pkc-region="filer-move"]')!;
      expect(bar.hasAttribute('data-pkc-bulk'), '何も選んでいないのに貼り付いている').toBe(false);
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'w1' });
      expect(q('[data-pkc-region="filer-move"]')!.hasAttribute('data-pkc-bulk'), '選んだのに貼り付かない').toBe(true);
      d.dispatch({ type: 'CLEAR_SELECTION' });
      expect(q('[data-pkc-region="filer-move"]')!.hasAttribute('data-pkc-bulk'), '外したのに貼り付いたまま').toBe(false);
    });

    it('🔴 貼り付く規則が CSS に在る(印だけで、見た目の受け皿が無いのを防ぐ)', () => {
      const css = readFileSync('src/styles/app.css', 'utf8');
      const m = /\[data-pkc-region='filer-move'\]\[data-pkc-bulk\]\s*\{([^}]*)\}/.exec(css);
      expect(m, '印に対する規則が無い').not.toBeNull();
      expect(m![1]).toMatch(/position:\s*sticky/);
      expect(m![1]).toMatch(/bottom:\s*0/);
      expect(m![1], '地が透けると字が読めない').toMatch(/background:\s*var\(--surface\)/);
    });

    it('🔴 2 件以上選んでいる間は上へ / 下へを出さない。1 件なら出る(対照群)', () => {
      d.dispatch({ type: 'SET_SCOPE', lid: 'work' });
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'w1' });
      expect(q('[data-pkc-field="order-nudge"]'), '前提:1 件なら出る').not.toBeNull();
      d.dispatch({ type: 'TOGGLE_SELECT', lid: 'w2' });
      expect(d.getState().selection.length, '前提:2 件選んでいる').toBe(2);
      expect(q('[data-pkc-field="order-nudge"]'), '2 件選んでいるのに上下ボタンが出ている').toBeNull();
      d.dispatch({ type: 'TOGGLE_SELECT', lid: 'w2' });
      expect(q('[data-pkc-field="order-nudge"]'), '1 件に戻したら出るはず').not.toBeNull();
    });
  });
});

describe('開いたノートの行へ送る(BrowseRouter。依頼 277)', () => {
  /** happy-dom は配置を計算しないので、器と行の位置を差す。rAF は同期にして見る。 */
  function rig(rowRect: { top: number; bottom: number }) {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const router = new BrowseRouter(regions.sidebar, regions.browseHost);
    const host = regions.browseHost;
    Object.defineProperty(host, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 100, bottom: 500, height: 400, left: 0, right: 300, width: 300, x: 0, y: 100 }),
    });
    host.scrollTop = 0;
    const win = host.ownerDocument.defaultView!;
    const realRaf = win.requestAnimationFrame;
    let sent = 0;
    win.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      sent++;
      cb(0);
      return 0;
    }) as typeof win.requestAnimationFrame;
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    // 行の位置を差す(行は描くたびに作り直されうるので、prototype 経由で差す)
    const proto = HTMLElement.prototype;
    const realRect = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement) {
      if (this.getAttribute('data-pkc-entry') !== null && this.tagName === 'TR')
        return { ...rowRect, height: rowRect.bottom - rowRect.top, left: 0, right: 0, width: 0, x: 0, y: rowRect.top } as DOMRect;
      return realRect.call(this);
    };
    return {
      d,
      host,
      sent: () => sent,
      render: () => router.render(d.getState(), 'filer'),
      done: () => {
        proto.getBoundingClientRect = realRect;
        win.requestAnimationFrame = realRaf;
      },
    };
  }

  it('🔴 行が画面の外にあれば、開いたとき見える所まで送る', () => {
    const t = rig({ top: 900, bottom: 926 });
    try {
      t.render();
      t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'w1' });
      t.render();
      expect(t.host.scrollTop, '外にある行へ送っていない').toBe(613); // 行の中心 913 − 画面の中心 300
    } finally {
      t.done();
    }
  });

  it('🔴 行が見えているなら動かさない / 同じノートのまま描き直しても送り直さない', () => {
    const t = rig({ top: 200, bottom: 226 });
    try {
      t.render();
      t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'w1' });
      t.render();
      expect(t.host.scrollTop, '見えている行で動いた').toBe(0);
    } finally {
      t.done();
    }
    const u = rig({ top: 900, bottom: 926 });
    try {
      u.render();
      u.d.dispatch({ type: 'SELECT_ENTRY', lid: 'w1' });
      u.render();
      expect(u.sent(), '前提:開いたときに 1 回送っている').toBe(1);
      u.render();
      u.render();
      expect(u.sent(), '同じノートのまま描き直しただけで送り直した(user が送った位置を奪う)').toBe(1);
      u.d.dispatch({ type: 'SELECT_ENTRY', lid: 'w2' });
      u.render();
      expect(u.sent(), '別のノートを開いたのに送らない').toBe(2);
    } finally {
      u.done();
    }
  });
});

describe('「探す」の行(依頼 87-1)', () => {
  const page = (lids: string[]) => ({
    query: 'x',
    rowsQuery: 'x',
    truncated: false,
    failed: false as const,
    rows: lids.map((lid) => ({ lid, title: 't-' + lid, snippet: '', rank: 0 })),
  });
  it('🔴 片付けたノートの行には「片付け済み」と添え、ふつうのノートには添えない', () => {
    const metas = [meta('a1', 1, 'a', 'todo', { archived: true }), meta('b1', 2, 'b')];
    const base = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;
    const host = document.createElement('div');
    document.body.append(host);
    new SearchRenderer(host).render({ ...base, searchPage: page(['a1', 'b1']) });
    const badge = (lid: string) =>
      host.querySelector(`[data-pkc-search-row="${lid}"] [data-pkc-field="search-row-archived"]`);
    expect(badge('a1')?.textContent, '片付けたノートに印が無い').toBe('片付け済み');
    expect(badge('b1'), 'ふつうのノートに印が付いた').toBeNull();
    // 行そのものは外されていない(探して見つからないのがいちばん困る)
    expect(host.querySelectorAll('[data-pkc-search-row]').length).toBe(2);
  });

  it('🔴 片付けた直後に、同じ行の印が古いままにならない(指紋に入っている)', () => {
    const live = [meta('a1', 1, 'a', 'todo'), meta('b1', 2, 'b')];
    const s0 = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: live, relations: [] }).state;
    const host = document.createElement('div');
    document.body.append(host);
    const r = new SearchRenderer(host);
    r.render({ ...s0, searchPage: page(['a1']) });
    expect(host.querySelector('[data-pkc-field="search-row-archived"]')).toBeNull();
    const archivedMetas = new Map(s0.entryMetas);
    archivedMetas.set('a1', { ...archivedMetas.get('a1')!, archived: true });
    r.render({ ...s0, entryMetas: archivedMetas, searchPage: page(['a1']) });
    expect(host.querySelector('[data-pkc-field="search-row-archived"]')?.textContent).toBe('片付け済み');
  });
});
