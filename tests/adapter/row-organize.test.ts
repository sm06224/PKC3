/** @vitest-environment happy-dom */
/**
 * 🔴 **左の列の行から、整理ができる**(#215。user 裁定 2026-09-04「全部推薦で」)。
 *
 * ## 直す前に無かったもの
 *
 * フォルダの整理は**帯**(居場所の `<select>` / 上へ・下へ)と D&D に在ったが、
 * 行を右クリックしてもフォルダにできることは「フォルダを書き出す」の 1 件だけだった。
 * 改名は 2 ペインの `F2` にしか無く、**左の列には口が 1 つも無かった**。
 *
 * ## この test が守るもの
 *
 * 1. 行の右クリックに **名前を変える / 移す… / この中に新しいノートを作る** が出る
 *    (作るは**フォルダの行だけ**)
 * 2. 🔴 **名前を変える** ── 行の題名の所に入力欄が出る / `Enter` で確定して disk へ届く /
 *    `Esc` でやめる / 空白だけは変えない / 他所を押したら確定する / **一覧タブの行でも同じ**
 * 3. 🔴 **移す…** ── 印が複数あれば**印の全部**が動く(対照群:印の外の 1 件は 1 件だけ)/
 *    自分自身と子孫は候補に出ない
 * 4. 🔴 **この中に新しいノートを作る** ── 押した行のフォルダの子として生まれ、編集に入る
 *
 * ⚠ 台は実物(shell + BrowseRouter + binder + effect 層)で組む ── 「面が描く」と
 *   「binder が受ける」の**合意**は、片方の test には書けない(CLAUDE.md §7)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { stubRevisionOps } from '../helpers/revision-stub';
import { getStructuralChildren } from '../../src/features/relation/tree';

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

const rel = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const MENU = '[data-pkc-region="context-menu"]';
const RENAME = '[data-pkc-field="row-rename"]';

/** 右クリック event(happy-dom に `MouseEvent` の座標つき実体は在る)。 */
function rightClick(el: Element): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}

function key(el: Element, k: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
});

const METAS = [
  meta('f1', 1, 'folder'),
  meta('f2', 2, 'folder'),
  meta('n1', 3),
  meta('n2', 4),
  meta('n3', 5),
  meta('n4', 6),
];

function setup(metas: EntryMeta[] = METAS, relations: Relation[] = [], mode: 'list' | 'filer' = 'filer') {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  let cur: 'list' | 'filer' | 'launcher' = 'list';
  d.onState((s) => browse.render(s, cur));
  const status: string[] = [];
  const errors: string[] = [];
  d.onState((s) => {
    if (s.error !== null && errors.at(-1) !== s.error) errors.push(s.error);
  });
  bindActions(root, d, {
    setBrowse: (m) => {
      cur = m as typeof cur;
      browse.render(d.getState(), cur);
    },
    showStatus: (t) => void status.push(t),
  });
  const parentCalls: Array<{ lid: string; parentLid: string | null }> = [];
  const renamed: Array<{ lid: string; title: string }> = [];
  const created: Array<{ lid: string; parent?: unknown }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    renameEntry: async (lid, title) => {
      renamed.push({ lid, title });
      return stubStamps();
    },
    replaceAssetRefs: () => Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e, opts) => {
      created.push({ lid: e.lid, parent: opts?.parent });
      return { ...stubStamps(), ...(opts?.parent ? { parentWritten: true } : {}) };
    },
    deleteEntry: async () => {},
    setEntryParent: async (lid, parentLid) => {
      parentCalls.push({ lid, parentLid });
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  root.querySelector<HTMLElement>(`[data-pkc-browse="${mode}"]`)!.click();
  // ⚠ 一覧だけは既存の region(`entry-list`)を器にする(`browse.ts` の作り)
  const pane =
    mode === 'list'
      ? root.querySelector<HTMLElement>('[data-pkc-region="entry-list"]')!
      : root.querySelector<HTMLElement>(`[data-pkc-browse-pane="${mode}"]`)!;
  const row = (lid: string): HTMLElement => {
    const el = pane.querySelector<HTMLElement>(`[data-pkc-entry="${lid}"]`);
    expect(el, `前提が崩れている: 台に ${lid} の行が無い`).not.toBeNull();
    return el!;
  };
  const acts = (): string[] =>
    [...root.querySelectorAll(`${MENU} button[data-pkc-action]`)].map(
      (b) => b.getAttribute('data-pkc-action') ?? '',
    );
  const press = (action: string): void => {
    const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`);
    expect(b, `メニューに ${action} が無い`).not.toBeNull();
    b!.click();
  };
  const renameInput = (): HTMLInputElement | null => pane.querySelector<HTMLInputElement>(RENAME);
  return { root, d, pane, row, acts, press, renameInput, status, errors, parentCalls, renamed, created };
}

describe('行の右クリックに整理の 3 つが出る(#215)', () => {
  it('🔴 フォルダの行には 3 つとも出る', () => {
    const r = setup();
    rightClick(r.row('f1'));
    expect(r.acts()).toEqual(
      expect.arrayContaining(['rename-entry-begin', 'move-to-folder', 'create-in-folder']),
    );
  });

  it('⚠ ノートの行には「この中に作る」は出ない(押すと必ず断られる物を出さない)', () => {
    const r = setup();
    rightClick(r.row('n1'));
    const a = r.acts();
    expect(a, 'メニューが出ていない(台の空振り)').toContain('rename-entry-begin');
    expect(a).toContain('move-to-folder');
    expect(a).not.toContain('create-in-folder');
  });
});

describe('名前を変える ── 行の題名の所で打ち替える(#215)', () => {
  it('🔴 押すと入力欄が出て、Enter で名前が変わり disk へ届く', async () => {
    const r = setup();
    rightClick(r.row('n1'));
    r.press('rename-entry-begin');
    const input = r.renameInput();
    expect(input, '入力欄が出ていない').not.toBeNull();
    expect(input!.value, '元の名前が入っていない').toBe('t-n1');
    // 🔑 欄は**行の中**に在る(題名の所に出る、が主張)
    expect(input!.closest('[data-pkc-entry="n1"]'), '欄が行の外に出ている').not.toBeNull();
    expect(document.activeElement, '欄に焦点が無い(押した直後に打てない)').toBe(input);
    input!.value = 'あたらしい名前';
    key(input!, 'Enter');
    expect(r.d.getState().entryMetas.get('n1')?.title).toBe('あたらしい名前');
    await tick(); // effect 層は非同期に disk へ書く
    expect(r.renamed, '題名が disk へ届いていない').toEqual([{ lid: 'n1', title: 'あたらしい名前' }]);
    expect(r.renameInput(), '確定したのに入力欄が残っている').toBeNull();
    expect(r.d.getState().renamingLid).toBeNull();
    // ⚠ 行の字も新しい題名になっている(欄が消えて元の字が戻る形ではない)
    expect(r.row('n1').textContent).toContain('あたらしい名前');
  });

  it('🔴 Esc なら変えずに閉じる', () => {
    const r = setup();
    rightClick(r.row('n1'));
    r.press('rename-entry-begin');
    const input = r.renameInput()!;
    input.value = '打ちかけ';
    key(input, 'Escape');
    expect(r.d.getState().entryMetas.get('n1')?.title, 'Esc なのに変わった').toBe('t-n1');
    expect(r.renamed).toEqual([]);
    expect(r.renameInput()).toBeNull();
  });

  it('⚠ 空白だけの名前にはしない(変えずに閉じる)', () => {
    const r = setup();
    rightClick(r.row('n1'));
    r.press('rename-entry-begin');
    const input = r.renameInput()!;
    input.value = '   ';
    key(input, 'Enter');
    expect(r.d.getState().entryMetas.get('n1')?.title).toBe('t-n1');
    expect(r.renamed, '空白の名前が disk へ飛んだ').toEqual([]);
    expect(r.renameInput(), '閉じていない').toBeNull();
  });

  it('🔴 他所を押したら確定する(OS のファイラと同じ)', () => {
    const r = setup();
    rightClick(r.row('n2'));
    r.press('rename-entry-begin');
    const input = r.renameInput()!;
    input.value = 'ぼかし確定';
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(r.d.getState().entryMetas.get('n2')?.title).toBe('ぼかし確定');
  });

  /**
   * 🔴 **打っている最中の鍵は、面の鍵に化けない**。⚠ 欄はフォルダの表の中に在るので、
   *   `Backspace` が「親へ」に、`Enter` が「開く」に化けると名前が打てない
   *   (2 ペインで踏んだ形 ── 左の列でも同じ門が要る)。
   */
  it('🔴 打っている最中の Backspace は、親へ戻らない', () => {
    const r = setup(METAS, [rel('r1', 'f1', 'n1')]);
    r.d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    rightClick(r.row('n1'));
    r.press('rename-entry-begin');
    const input = r.renameInput()!;
    key(input, 'Backspace');
    expect(r.d.getState().scopeLid, '親へ戻ってしまった').toBe('f1');
    expect(r.renameInput(), '欄が消えた').not.toBeNull();
  });

  /**
   * 🔴 **欄の中のクリックを行の 2 回押しに数えない** ── 数えるとフォルダの行では
   *   打っている最中に**中へ入ってしまう**(面が変わって欄ごと消える)。
   */
  it('🔴 フォルダの行の欄を 2 回押しても、中へ入らない', () => {
    const r = setup();
    rightClick(r.row('f1'));
    r.press('rename-entry-begin');
    const input = r.renameInput()!;
    input.click();
    input.click();
    expect(r.d.getState().scopeLid, '打っている最中にフォルダへ入った').toBeNull();
    expect(r.renameInput(), '欄が消えた').not.toBeNull();
  });

  it('🔴 打ち替え中に相手が消えたら、入力欄も閉じる', () => {
    const r = setup();
    rightClick(r.row('n1'));
    r.press('rename-entry-begin');
    expect(r.d.getState().renamingLid, '前提が崩れている').toBe('n1');
    r.d.dispatch({ type: 'DELETE_ENTRIES', lids: ['n1'] });
    expect(r.d.getState().renamingLid, '消えた相手の打ち替えが残っている').toBeNull();
    expect(r.renameInput()).toBeNull();
  });

  /**
   * 🔴 **一覧タブの行でも同じ**(#215)── 面が違っても口は 1 つ(`row-rename`)。
   * ⚠ この面は行を**使い回す**ので、やめた後に題名の字へ戻ることも見る
   *   (戻さないと、次にその行を使ったとき欄が残る)。
   */
  it('🔴 一覧タブの行でも、その場で打ち替えられる(やめたら字に戻る)', () => {
    const r = setup(METAS, [], 'list');
    rightClick(r.row('n3'));
    r.press('rename-entry-begin');
    const input = r.renameInput();
    expect(input, '一覧タブの行に入力欄が出ていない').not.toBeNull();
    expect(input!.closest('[data-pkc-entry="n3"]')).not.toBeNull();
    key(input!, 'Escape');
    expect(r.renameInput()).toBeNull();
    expect(r.row('n3').textContent, 'やめた後に題名の字が戻っていない').toContain('t-n3');
    // 確定の側も通す
    rightClick(r.row('n3'));
    r.press('rename-entry-begin');
    const again = r.renameInput()!;
    again.value = '一覧から';
    key(again, 'Enter');
    expect(r.d.getState().entryMetas.get('n3')?.title).toBe('一覧から');
    expect(r.row('n3').textContent).toContain('一覧から');
  });

  it('🔴 編集中は断る(理由を出す)', async () => {
    const r = setup();
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick();
    r.d.dispatch({ type: 'START_EDIT' });
    expect(r.d.getState().phase, '前提が崩れている(編集に入っていない)').toBe('editing');
    // ⚠ 編集中は右クリックのメニューが行を選べないので、情報ペインの押し方(ボタン直)で見る
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'rename-entry-begin');
    r.root.append(b);
    b.click();
    expect(r.d.getState().renamingLid).toBeNull();
    expect(r.errors.at(-1) ?? '').toContain('編集を終了してから');
  });
});

describe('移す… ── 入れ先のフォルダを選ぶ(#215)', () => {
  it('🔴 印が 3 件あれば、その全部が選んだフォルダへ入る(disk への要求まで)', async () => {
    const r = setup();
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    r.d.dispatch({ type: 'TOGGLE_SELECT', lid: 'n2' });
    r.d.dispatch({ type: 'TOGGLE_SELECT', lid: 'n3' });
    expect(r.d.getState().selection.length, '前提が崩れている(印が 3 件ではない)').toBe(3);
    rightClick(r.row('n1'));
    // 🔴 印を付けた行を右クリックしても、印は 3 件のまま(消えると「1 件を移す」になる)
    expect(r.d.getState().selection.length, '右クリックで印が消えた').toBe(3);
    r.press('move-to-folder');
    await tick();
    const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog')].find((x) => x.open);
    expect(dialog, '入れ先を選ぶ画面が出ていない').toBeDefined();
    expect(dialog!.querySelector('[data-pkc-field="dialog-title"]')?.textContent).toBe('3 件を移す');
    const rows = [...dialog!.querySelectorAll<HTMLElement>('[data-pkc-field="entry-pick-row"]')];
    // 🔑 ルートが先頭、続いてフォルダ ── ノートは候補に出ない
    expect(rows.map((x) => x.getAttribute('data-pkc-lid'))).toEqual(['', 'f1', 'f2']);
    rows.find((x) => x.getAttribute('data-pkc-lid') === 'f1')!.click();
    await tick();
    expect(
      getStructuralChildren('f1', r.d.getState().entryMetas, r.d.getState().relations)
        .map((m) => m.lid)
        .sort(),
    ).toEqual(['n1', 'n2', 'n3']);
    expect(r.parentCalls.map((c) => c.lid).sort(), 'disk への要求が 3 件出ていない').toEqual([
      'n1',
      'n2',
      'n3',
    ]);
    expect(r.status.at(-1), '行き先を名乗っていない').toBe('3 件を「t-f1」へ入れました');
  });

  it('⚠ 対照群 ── 印の外の行を右クリックしたら、その 1 件だけ動く', async () => {
    const r = setup();
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    r.d.dispatch({ type: 'TOGGLE_SELECT', lid: 'n2' });
    rightClick(r.row('n4'));
    r.press('move-to-folder');
    await tick();
    const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog')].find((x) => x.open)!;
    expect(dialog.querySelector('[data-pkc-field="dialog-title"]')?.textContent).toBe('「t-n4」を移す');
    dialog.querySelector<HTMLElement>('[data-pkc-field="entry-pick-row"][data-pkc-lid="f2"]')!.click();
    await tick();
    expect(r.parentCalls.map((c) => c.lid), '印の中の物まで動いた').toEqual(['n4']);
  });

  it('🔴 自分自身と自分の子孫は候補に出ない(輪を作らせない)', async () => {
    const r = setup(METAS, [rel('r1', 'f1', 'f2')]);
    rightClick(r.row('f1'));
    r.press('move-to-folder');
    await tick();
    const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog')].find((x) => x.open)!;
    const lids = [...dialog.querySelectorAll('[data-pkc-field="entry-pick-row"]')].map((x) =>
      x.getAttribute('data-pkc-lid'),
    );
    expect(lids, '自分か子孫が候補に居る').toEqual(['']);
  });

  it('🔴 題名を打つと絞れて、ルートは先頭から外れる(Enter が打った名前の方へ効く)', async () => {
    const r = setup();
    rightClick(r.row('n1'));
    r.press('move-to-folder');
    await tick();
    const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog')].find((x) => x.open)!;
    const filter = dialog.querySelector<HTMLInputElement>('[data-pkc-field="entry-pick-filter"]')!;
    filter.value = 't-f2';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    const lids = [...dialog.querySelectorAll('[data-pkc-field="entry-pick-row"]')].map((x) =>
      x.getAttribute('data-pkc-lid'),
    );
    expect(lids).toEqual(['f2']);
    // やめたら何も動かない
    dialog.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]')!.click();
    await tick();
    expect(r.parentCalls).toEqual([]);
  });
});

/**
 * 🔴 **情報ペインの側も同じ門**(#215)── 「この中に新しいノートを作る」は
 *   フォルダのときだけ見える(`export-folder` と同じ作法)。⚠ 変異試験 M9 が
 *   SURVIVED で教えた ── `inspector-titles` の台はフォルダなので、畳む側の分岐を
 *   1 度も通っていなかった。
 */
describe('情報ペインの「この中に新しいノートを作る」(#215)', () => {
  it('🔴 ノートを選んでいるときは畳み、フォルダなら出す', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const inspector = new InspectorRenderer(buildShell(root).inspector);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    inspector.render(d.getState());
    const btn = (): HTMLButtonElement | null =>
      root.querySelector<HTMLButtonElement>(
        '[data-pkc-field="inspector-actions"] [data-pkc-action="create-in-folder"]',
      );
    expect(btn(), '前提が崩れている: ボタンが無い').not.toBeNull();
    expect(btn()!.hidden, 'ノートなのに「中に作る」が出ている(押すと必ず断られる)').toBe(true);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'f1' });
    inspector.render(d.getState());
    expect(btn()!.hidden, 'フォルダなのに畳まれている').toBe(false);
  });
});

describe('この中に新しいノートを作る(#215)', () => {
  it('🔴 押した行のフォルダの子として生まれ、そのまま編集に入る', async () => {
    const r = setup();
    rightClick(r.row('f2'));
    r.press('create-in-folder');
    await tick();
    const st = r.d.getState();
    expect(st.phase, '編集に入っていない').toBe('editing');
    const fresh = st.freshLid;
    expect(fresh, '新しいノートが生まれていない').not.toBeNull();
    expect(
      getStructuralChildren('f2', st.entryMetas, st.relations).map((m) => m.lid),
      '押したフォルダの中に入っていない',
    ).toEqual([fresh]);
    expect(st.entryMetas.get(fresh!)?.archetype).toBe('text');
    // 🔑 disk への要求は行と辺を 1 つで頼む(#258 の形)
    expect(r.created.find((c) => c.lid === fresh)?.parent, '親が disk へ届いていない').toBeTruthy();
  });

  it('⚠ ノートの行で押されたら断る(理由を出す)', () => {
    const r = setup();
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    // ⚠ メニューには出ないので、情報ペイン / 鍵と同じ「押した物に行が無い」形で撃つ
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'create-in-folder');
    r.root.append(b);
    b.click();
    expect(r.d.getState().phase).toBe('ready');
    expect(r.errors.at(-1) ?? '').toContain('フォルダの行で押してください');
  });
});
