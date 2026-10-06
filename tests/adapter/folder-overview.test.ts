/** @vitest-environment happy-dom */
/**
 * 🔴 **フォルダを選ぶと、中央に「概要」が出る**(#1222。🟣 Gemini 裁定 2026-10-01 = A)。
 *
 * > user の物語:フォルダを 1 回押した。説明の下に「直下 ノート n 件 / フォルダ m 件」と
 * > 題名・更新日の一覧が出る。行を押すとそのノートが中央に開き、**左の列もそのフォルダの中へ移る**。
 *
 * ⚠ 守る主張:
 *  ① 説明(本文)は消えない・概要はその**下**・空のフォルダは概要だけ
 *  ② 行は左の列と**同じ並び**(`filerRows` 1 本から引く。並びを変えても割れない)
 *  ③ 行を押すと `select-entry` と同じに開き、**`SET_SCOPE` で左の列も動く**(開けなかったら動かさない)
 *  ④ 100 件で切れて「ほか n 件」を言う(件数の字は切れていても全体を数える)
 *  ⑤ 出さない場面:編集中 / スマートフォルダ / 他の種類 / 留めた枠
 *  ⑥ 中のノートを足した / 消した / 動かした / 更新日が変わったら**追従**する(古い一覧が残らない)
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { filerRowOptions } from '../../src/adapter/state/list-view-options';
import { filerRows } from '../../src/features/relation/filer-list';
import { FOLDER_OVERVIEW_LIMIT } from '../../src/features/relation/folder-overview';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { ENTRY_MENU_ACTIONS } from '../../src/features/entry-actions';

const meta = (
  lid: string,
  order: number,
  title = 't-' + lid,
  archetype = 'text',
  updatedAt: string | null = null,
): EntryMeta => ({
  lid,
  title,
  archetype,
  createdAt: null,
  updatedAt,
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

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * 木:  F(folder) ── { a: 'zz'(ノート), g: 'mm'(フォルダ) ── { gc: 孫 }, b: 'aa'(ノート) }
 *       x = どこにも入っていない
 * ⚠ 並び(題名順 / 手動順)で行の順が**変わる**ように、題名とデータ順をわざと逆にしてある。
 */
const METAS = [
  meta('F', 1, '資料', 'folder'),
  meta('a', 2, 'zz', 'text', '2026-03-04 00:00:00'),
  meta('g', 3, 'mm', 'folder'),
  meta('b', 4, 'aa'),
  meta('x', 5, 'ほか'),
  meta('gc', 6, '孫のノート'),
];
const RELS = [rel('r1', 'F', 'a'), rel('r2', 'F', 'g'), rel('r3', 'F', 'b'), rel('r4', 'g', 'gc')];

function booted(metas: EntryMeta[] = METAS, relations: Relation[] = RELS): AppState {
  return reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations }).state;
}
function opened(lid: string, body: string, s: AppState = booted()): AppState {
  let st = reduce(s, { type: 'SELECT_ENTRY', lid }).state;
  st = reduce(st, { type: 'BODY_LOADED', lid, body }).state;
  return st;
}

const overviewOf = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>('[data-pkc-region="folder-overview"]');
const rowLids = (root: HTMLElement): string[] =>
  Array.from(
    root.querySelectorAll<HTMLElement>(
      '[data-pkc-region="folder-overview"] [data-pkc-action="select-entry"]',
    ),
  ).map((b) => b.getAttribute('data-pkc-entry') ?? '');

function mount() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  return { root, detail };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('フォルダの概要(#1222)', () => {
  it('🔴 空のフォルダは概要だけが出る(件数 0 の 1 行・一覧は無い)', async () => {
    const { root, detail } = mount();
    detail.render(opened('F', '', booted([meta('F', 1, '空', 'folder')], [])));
    await settle();
    const ov = overviewOf(root);
    expect(ov, '空のフォルダで概要の器が出ていない').not.toBeNull();
    expect(ov!.querySelector('[data-pkc-field="overview-summary"]')!.textContent).toBe(
      '直下 ノート 0 件 / フォルダ 0 件',
    );
    expect(ov!.querySelector('[data-pkc-field="overview-list"]')).toBeNull();
  });

  it('🔴 説明(本文)は消えず、概要はその下に出る。件数と行の中身が出る', async () => {
    const { root, detail } = mount();
    detail.render(opened('F', '資料の説明を書いた本文'));
    await settle();
    const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
    expect(host, '前提:本文の器が描けていない').not.toBeNull();
    expect(host.textContent, '書いた説明が消えた').toContain('資料の説明を書いた本文');
    const ov = overviewOf(root)!;
    expect(ov, '概要が出ていない').not.toBeNull();
    expect(
      host.compareDocumentPosition(ov) & Node.DOCUMENT_POSITION_FOLLOWING,
      '概要が説明の下に出ていない',
    ).toBeTruthy();
    expect(ov.contains(host), '概要が本文の器の中に入っている(本文の差分に消される)').toBe(false);
    // 直下 = ノート 2(a, b) / フォルダ 1(g)。⚠ 入れ子の孫・どこにも入っていない x は数えない
    expect(ov.querySelector('[data-pkc-field="overview-summary"]')!.textContent).toBe(
      '直下 ノート 2 件 / フォルダ 1 件',
    );
    const rowA = ov.querySelector<HTMLElement>('[data-pkc-entry="a"]')!;
    expect(rowA.textContent).toContain('zz');
    expect(
      rowA.querySelector('[data-pkc-field="when"]')!.textContent,
      '更新日が出ていない(`MM/DD` か `YYYY/MM/DD`)',
    ).toMatch(/03\/04$/);
    expect(ov.querySelector('[data-pkc-entry="x"]'), '直下でないノートが出ている').toBeNull();
    // ⚠ 入れ子の孫は出ない(常に直下だけ。件数にも入らない ── 上の 2 件 / 1 件)
    expect(ov.querySelector('[data-pkc-entry="gc"]'), '孫のノートが出ている(直下だけのはず)').toBeNull();
  });

  it('🔴 並びは左の列(`filerRows`)と同じ ── 並び順を変えても割れない', async () => {
    const { root, detail } = mount();
    let s = opened('F', '説明');
    detail.render(s);
    await settle();
    const expectOrder = (st: AppState): string[] =>
      filerRows('F', st.entryMetas, st.relations, filerRowOptions(st)).map((m) => m.lid);
    const manual = expectOrder(s);
    expect(rowLids(root)).toEqual(manual);

    s = reduce(s, { type: 'SET_ENTRY_SORT', sort: 'title' }).state;
    detail.render(s);
    const byTitle = expectOrder(s);
    expect(byTitle, '空振り(並びを変えても順が同じ)').not.toEqual(manual);
    expect(rowLids(root), '並びを変えたのに概要が追随しない(左の列と割れる)').toEqual(byTitle);

    // 向きも同じ(降順にすると逆の並びになり、左の列と一致する)
    s = reduce(s, { type: 'SET_ENTRY_SORT', sort: 'title', desc: !s.entrySortDesc }).state;
    detail.render(s);
    const flipped = expectOrder(s);
    expect(flipped, '空振り(向きを変えても順が同じ)').not.toEqual(byTitle);
    expect(rowLids(root), '並びの向きが左の列と割れる').toEqual(flipped);
  });

  it('🔴 100 件で切れ、「ほか n 件は左の列で」を言う(件数は全体を数える)', async () => {
    const kids = Array.from({ length: FOLDER_OVERVIEW_LIMIT + 7 }, (_, i) =>
      meta(`k${i}`, i + 2, `題${i}`),
    );
    const metas = [meta('F', 1, '大', 'folder'), ...kids];
    const rels = kids.map((k, i) => rel(`r${i}`, 'F', k.lid));
    const { root, detail } = mount();
    detail.render(opened('F', '', booted(metas, rels)));
    await settle();
    expect(rowLids(root)).toHaveLength(FOLDER_OVERVIEW_LIMIT);
    expect(overviewOf(root)!.querySelector('[data-pkc-field="overview-more"]')!.textContent).toBe(
      'ほか 7 件は左のペインで',
    );
    expect(overviewOf(root)!.querySelector('[data-pkc-field="overview-summary"]')!.textContent).toBe(
      `直下 ノート ${FOLDER_OVERVIEW_LIMIT + 7} 件 / フォルダ 0 件`,
    );
    // 対照群:ちょうど上限なら「ほか」は出ない
    const exact = kids.slice(0, FOLDER_OVERVIEW_LIMIT);
    const { root: r2, detail: d2 } = mount();
    d2.render(
      opened(
        'F',
        '',
        booted(
          [meta('F', 1, '大', 'folder'), ...exact],
          exact.map((k, i) => rel(`q${i}`, 'F', k.lid)),
        ),
      ),
    );
    await settle();
    expect(rowLids(r2)).toHaveLength(FOLDER_OVERVIEW_LIMIT);
    expect(r2.querySelector('[data-pkc-field="overview-more"]')).toBeNull();
  });

  it('🔴 出さない場面:他の種類 / スマートフォルダ / 編集中 / 留めた枠', async () => {
    // 他の種類(ノート)
    const a = mount();
    a.detail.render(opened('a', '本文'));
    await settle();
    expect(overviewOf(a.root), 'ノートに概要が出ている').toBeNull();

    // スマートフォルダ
    const b = mount();
    b.detail.render(
      opened('S', '', booted([meta('S', 1, '条件', 'smart'), meta('a', 2)], [rel('r', 'S', 'a')])),
    );
    await settle();
    expect(overviewOf(b.root), 'スマートフォルダに概要が出ている').toBeNull();

    // 編集中(対照群:同じ状態の編集前は出ている)
    const c = mount();
    const s = opened('F', '説明');
    c.detail.render(s);
    await settle();
    expect(overviewOf(c.root), '前提:編集前は出ている').not.toBeNull();
    const editing = reduce(s, { type: 'START_EDIT' }).state;
    expect(editing.phase, '前提:編集に入れていない').toBe('editing');
    c.detail.render(editing);
    expect(overviewOf(c.root), '編集中に概要が出ている').toBeNull();
    // 編集をやめたら戻る
    c.detail.render(reduce(editing, { type: 'CANCEL_EDIT' }).state);
    await settle();
    expect(overviewOf(c.root), '編集をやめても概要が戻らない').not.toBeNull();

    // 留めた枠(横に並べた枠)
    const host = document.createElement('div');
    document.body.append(host);
    const pinned = new DetailRenderer(
      host,
      null,
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      'F',
    );
    // ⚠ 主の枠も同じフォルダを選んでいる状態にする(選んでいないと、門を外しても出ず空振りになる)
    const ps = { ...opened('F', '主の説明'), splitBodies: new Map([['F', '留めた説明']]) } as AppState;
    pinned.render(ps);
    await settle();
    expect(host.textContent, '前提:留めた枠が描けていない').toContain('留めた説明');
    expect(overviewOf(host), '留めた枠に概要が出ている').toBeNull();
  });

  it('🔴 中のノートを足す / 動かす / 消す / 名前や更新日が変わる、に本文を描き直さず追従する', async () => {
    const { root, detail } = mount();
    const s0 = opened('F', '説明');
    detail.render(s0);
    await settle();
    const host = root.querySelector('[data-pkc-field="detail-body"]');
    expect(host, '前提:本文の器が描けていない(null 同士の一致で緑にならない)').not.toBeNull();
    expect(rowLids(root).sort()).toEqual(['a', 'b', 'g']);

    // 足した(entryMetas / relations の参照が変わるが、本文の指紋は同じ)
    const s1: AppState = {
      ...s0,
      entryMetas: new Map([...s0.entryMetas, ['n', meta('n', 9, '新しい')]]),
      relations: [...s0.relations, rel('r9', 'F', 'n')],
    };
    detail.render(s1);
    expect(rowLids(root).sort(), '足したのに一覧に出ない').toEqual(['a', 'b', 'g', 'n']);
    expect(overviewOf(root)!.querySelector('[data-pkc-field="overview-summary"]')!.textContent).toBe(
      '直下 ノート 3 件 / フォルダ 1 件',
    );
    expect(root.querySelector('[data-pkc-field="detail-body"]'), '概要のために本文が作り直された').toBe(host);

    // 動かした(a をフォルダの外へ)
    const s2: AppState = { ...s1, relations: s1.relations.filter((r) => r.toLid !== 'a') };
    detail.render(s2);
    expect(rowLids(root).sort(), '外へ動かしたのに残っている').toEqual(['b', 'g', 'n']);

    // 題名と更新日が変わった(関係は同じ)
    const s3: AppState = {
      ...s2,
      entryMetas: new Map(
        [...s2.entryMetas].map(([k, m]) =>
          k === 'b' ? [k, { ...m, title: '書き換えた題', updatedAt: '2025-12-31 00:00:00' }] : [k, m],
        ),
      ),
    };
    detail.render(s3);
    const rowB = overviewOf(root)!.querySelector('[data-pkc-entry="b"]')!;
    expect(rowB.textContent, '題名の変更に追従しない').toContain('書き換えた題');
    expect(rowB.querySelector('[data-pkc-field="when"]')!.textContent).toMatch(/2025\/12\/31$/);

    // 消した(ゴミ箱へ ── entryMetas から落ちる)
    const s4: AppState = {
      ...s3,
      entryMetas: new Map([...s3.entryMetas].filter(([k]) => k !== 'g')),
    };
    detail.render(s4);
    expect(rowLids(root).sort(), '消したのに残っている').toEqual(['b', 'n']);
  });

  it('🔴 別のフォルダへ移ると、そのフォルダの概要に変わる(前のが残らない)', async () => {
    const metas = [...METAS, meta('G', 6, '別', 'folder'), meta('c', 7, 'c-note')];
    const rels = [...RELS, rel('r8', 'G', 'c')];
    const { root, detail } = mount();
    const s = opened('F', '説明', booted(metas, rels));
    detail.render(s);
    await settle();
    expect(rowLids(root)).toContain('a');
    detail.render(opened('G', '別の説明', s));
    await settle();
    expect(rowLids(root)).toEqual(['c']);
    expect(root.querySelectorAll('[data-pkc-region="folder-overview"]'), '概要が 2 つ出ている').toHaveLength(1);
  });
});

describe('フォルダの概要の行を押す(binder)', () => {
  function wired(state: AppState) {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const regions = buildShell(root);
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [...state.entryMetas.values()], relations: [...state.relations] });
    const detail = new DetailRenderer(regions.detail);
    d.onState((st) => detail.render(st));
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'F' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'F', body: '説明' });
    return { root, d };
  }
  const click = (root: HTMLElement, lid: string) =>
    root
      .querySelector<HTMLElement>(
        `[data-pkc-region="folder-overview"] [data-pkc-entry="${lid}"]`,
      )!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  it('🔴 ノートの行を押すと、そのノートが開き、左の列もそのフォルダの中へ移る', async () => {
    const { root, d } = wired(booted());
    await settle();
    // 前提:左の列はルートに居る(動いたことを見分けられる)
    expect(d.getState().scopeLid, '前提:現在地がルートでない').toBeNull();
    click(root, 'a');
    expect(d.getState().selectedLid, '押したノートが開かない').toBe('a');
    expect(d.getState().scopeLid, '左の列がそのフォルダの中へ移らない').toBe('F');
  });

  it('🔴 サブフォルダの行を押すと、そのフォルダを選ぶ(= そのフォルダの概要に変わる)', async () => {
    const { root, d } = wired(booted());
    await settle();
    click(root, 'g');
    expect(d.getState().selectedLid).toBe('g');
    expect(d.getState().scopeLid).toBe('F');
    d.dispatch({ type: 'BODY_LOADED', lid: 'g', body: '' });
    await settle();
    expect(rowLids(root), 'サブフォルダの概要に変わっていない').toEqual(['gc']);
  });

  it('🔴 開けなかったとき(編集中)は左の列を動かさない', async () => {
    const { root, d } = wired(booted());
    await settle();
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提:編集に入れていない').toBe('editing');
    // 編集中は概要が出ないので、行の押し口を自分で置く(受け手の門を直に見る)
    const box = document.createElement('section');
    box.setAttribute('data-pkc-overview-scope', 'F');
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'select-entry');
    btn.setAttribute('data-pkc-entry', 'a');
    box.append(btn);
    root.append(box);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(d.getState().selectedLid, '編集中に別のノートへ移った').toBe('F');
    expect(d.getState().scopeLid, '開けなかったのに左の列だけ動いた').toBeNull();
  });

  it('🔴 消えたノートの行を押しても(開けない)左の列は動かさない', async () => {
    const { root, d } = wired(booted());
    await settle();
    expect(d.getState().phase, '前提:編集中でない').toBe('ready');
    const box = document.createElement('section');
    box.setAttribute('data-pkc-overview-scope', 'F');
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'select-entry');
    btn.setAttribute('data-pkc-entry', 'gone');
    box.append(btn);
    root.append(box);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(d.getState().selectedLid, '消えたノートへ移った').toBe('F');
    expect(d.getState().scopeLid, '開けなかったのに左の列だけ動いた').toBeNull();
  });
});

/**
 * 🔴 **空のフォルダに、作る入口が出る**(#1254 §3 改善 A。Gemini 裁定 = a)。
 *
 * > user の物語:空のフォルダを押した。件数が 0 と出るだけで、**何をすればよいか**が画面に無かった
 * > (作る入口は行の右クリックか Shift+F4 だけ)。
 *
 * ⚠ 押したときの動きは**行の右クリックの「この中に新しいノートを作る」と同じ 1 本**(新しい action を
 *   作らない)。期待値の綴りは**右クリックの表(`ENTRY_MENU_ACTIONS`)から引く**(手で書かない)。
 */
describe('空のフォルダの「この中に新しいノートを作る」(#1254 §3 改善 A)', () => {
  const CREATE = '[data-pkc-region="folder-overview"] [data-pkc-field="overview-create"]';
  const menuItem = ENTRY_MENU_ACTIONS.find((a) => a.action === 'create-in-folder')!;

  function wiredEmpty(metas: EntryMeta[], relations: Relation[]) {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const regions = buildShell(root);
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
    const detail = new DetailRenderer(regions.detail);
    d.onState((st) => detail.render(st));
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'F' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'F', body: '説明' });
    return { root, d };
  }

  it('🔴 0 件(ノートもフォルダも)のときだけ在る ── 字と action は右クリックの表から引いた物と同じ', async () => {
    const { root } = wiredEmpty([meta('F', 1, '空', 'folder')], []);
    await settle();
    // ⚠ 空振り防止 ── 概要の器そのものが描かれている
    expect(overviewOf(root), '前提:概要が出ていない').not.toBeNull();
    const btn = root.querySelector<HTMLElement>(CREATE);
    expect(btn, '空のフォルダに作る入口が出ていない').not.toBeNull();
    expect(btn!.textContent).toBe(menuItem.label);
    expect(btn!.textContent).toBe('この中に新しいノートを作る');
    expect(btn!.getAttribute('data-pkc-action'), '右クリックと別の action を撃っている').toBe(menuItem.action);
  });

  it('🔴 1 件でも在れば出さない(ノート 1 件 / フォルダ 1 件のどちらでも)', async () => {
    for (const child of [meta('c', 2, '子'), meta('g', 2, '孫', 'folder')]) {
      document.body.innerHTML = '';
      const { root } = wiredEmpty([meta('F', 1, '資料', 'folder'), child], [rel('r1', 'F', child.lid)]);
      await settle();
      expect(overviewOf(root), '前提:概要が出ていない').not.toBeNull();
      expect(root.querySelector(CREATE), `${child.archetype} が 1 件在るのに入口が出ている`).toBeNull();
    }
  });

  it('🔴 押すと、このフォルダの中にノートが 1 件でき、そのまま編集に入る(右クリックと同じ動き)', async () => {
    const { root, d } = wiredEmpty([meta('F', 1, '空', 'folder')], []);
    await settle();
    expect(d.getState().entryMetas.size, '前提:最初から子が居る').toBe(1);
    root.querySelector<HTMLElement>(CREATE)!.click();
    const st = d.getState();
    expect(st.entryMetas.size, '押してもノートが増えない(dead click)').toBe(2);
    const made = [...st.entryMetas.values()].find((m) => m.lid !== 'F')!;
    expect(made.archetype, '種類が text でない').toBe('text');
    expect(
      st.relations.some((r) => r.kind === 'structural' && r.fromLid === 'F' && r.toLid === made.lid),
      '作ったノートがこのフォルダの中に入っていない',
    ).toBe(true);
    expect(st.selectedLid).toBe(made.lid);
    expect(st.phase, '作ったのに編集に入らない').toBe('editing');
  });
});
