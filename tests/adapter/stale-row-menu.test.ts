/** @vitest-environment happy-dom */
/**
 * 🔴 **行のメニューは、開いた瞬間の行に効く**(#877)。
 *
 * ## 何が起きていたか
 *
 * 行を右クリックすると `selectEntryOrExplain`(binder.ts)がその行を選び、
 * `phase: 'ready'` のままメニューが出る。⚠ メニューが出たまま `Alt+←`(戻る)を
 * 押すと ── この鍵は `contexts: ['global']`(`features/keymap.ts`)で、メニューが
 * 開いていることを見ない ── `navHistory` が `SELECT_ENTRY` を撃ち、`selectedLid`
 * が**別の行**へ動く。
 *
 * 行のメニューのボタンは**行の中に居ない**(器は `root` 直下に出る)ので、直す前の
 * 受け手(`delete-entry` など)は `target.closest('[data-pkc-entry]')` が必ず外れ、
 * **`selectedLid` を「押した行」として読んでいた** ── メニューを出した後に選択が
 * 動くと、押していないノートに効いてしまう(「A を削除」のつもりで B が消える)。
 *
 * 🔑 直しは「メニューを開いた瞬間の lid」を carry で運び、受け手はそれを
 * **selectedLid より先に**読む(`rowLidOrSelected`、binder.ts #877)。
 *
 * ⚠ 台は実物(shell + BrowseRouter + binder + effect 層)で組む ── 「メニューが
 *   運ぶ carry」と「binder が受ける」の合意は、片方の test には書けない(CLAUDE.md §7)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';
import { answerDialog } from './dialog-helper';

function meta(lid: string, order: number): EntryMeta {
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

const METAS = [meta('n1', 1), meta('n2', 2)];

const MENU = '[data-pkc-region="context-menu"]';

/** 右クリック event(happy-dom に `MouseEvent` の座標つき実体は在る)。 */
function rightClick(el: Element): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}

/** effect 層は非同期に disk へ書く ── 確認後に一呼吸置く。 */
async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
});

function setup() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  // ⚠ mode は常に 'list' で描く(タブは押さない ── 一覧だけで足りる主張)
  d.onState((s) => browse.render(s, 'list'));
  bindActions(root, d);
  const deleted: string[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    deleteEntry: async (lid) => {
      deleted.push(lid);
    },
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  const pane = root.querySelector<HTMLElement>('[data-pkc-region="entry-list"]');
  expect(pane, '前提が崩れている: 一覧の器が無い').not.toBeNull();
  const row = (lid: string): HTMLElement => {
    const el = pane!.querySelector<HTMLElement>(`[data-pkc-entry="${lid}"]`);
    expect(el, `前提が崩れている: 台に ${lid} の行が無い`).not.toBeNull();
    return el!;
  };
  const press = (action: string): void => {
    const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`);
    expect(b, `メニューに ${action} が無い`).not.toBeNull();
    b!.click();
  };
  return { root, d, row, press, deleted };
}

/** スマホ用「⋯」メニュー(`phone-menu`)の最小の台。 */
function setupPhone() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  buildShell(root);
  bindActions(root, d);
  const deleted: string[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    deleteEntry: async (lid) => {
      deleted.push(lid);
    },
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  const press = (action: string): void => {
    const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`);
    expect(b, `メニューに ${action} が無い`).not.toBeNull();
    b!.click();
  };
  return {
    d,
    deleted,
    press,
    openMenu: () => root.querySelector<HTMLElement>('[data-pkc-action="phone-menu"]')!.click(),
  };
}

/**
 * 🔴 **スマホの「⋯」メニューも同じ穴を持っていた**(#877)。
 *
 * ⚠ `phone-menu` は行の右クリックとは別の入口だが、出す項目は同じ
 *   `entryMenuActions()`(`ENTRY_MENU_ACTIONS`)── 開いた瞬間の `selectedLid` を
 *   `MENU_LID_ATTR` で運ぶところまでは直す前から在ったが(`phone-layout.test.ts`
 *   「押した物の身元をボタンへ写す」が pin 済み)、**受け手側**
 *   (`rowLidOrSelected`)がそれを読んでいなかったので carry は死んでいた。
 * 🔑 `rowLidOrSelected` を直した副産物として、ここも同じ形で直る
 *   ── その事実をここで確かめる。
 */
describe('スマホの「⋯」メニューも、開いた瞬間のノートに効く(#877)', () => {
  it('🔴 ⋯ を開いたまま選択が動いても、開いた時のノートが消える', async () => {
    const p = setupPhone();
    p.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    p.openMenu();
    // ⚠ `Alt+←` 相当 ── ⋯ を開いたまま選択が動く
    p.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    expect(p.d.getState().selectedLid, '前提が崩れている(選択が動いていない)').toBe('n2');
    p.press('delete-entry');
    await answerDialog('ok');
    await tick();
    expect(p.d.getState().entryMetas.has('n1'), '⋯ を開いた時のノート(n1)が残っている').toBe(false);
    expect(p.d.getState().entryMetas.has('n2'), '選択が動いた先(n2)まで消えた').toBe(true);
    expect(p.deleted).toEqual(['n1']);
  });
});

/**
 * 🔴 **「履歴」も、開いた瞬間の行に効く**(#891)。
 *
 * ⚠ #877 を直した時点で、行のメニュー 16 件のうち**ここだけが残っていた** ──
 *   受け手が `target` を 1 つも受け取っておらず、reducer が `state.selectedLid` を
 *   直に読んでいたので、`binder.ts` の中だけでは閉じなかった。
 * 🔑 `SHOW_HISTORY` に `lid` を持たせ(**optional にしない** ── 省けると口を
 *   後から足す人が渡し忘れても tsc が黙る)、受け手は隣の 15 件と同じ
 *   `rowLidOrSelected` で解決する。
 */
describe('「履歴」も、開いた瞬間の行に効く(#891)', () => {
  it('🔴 メニューを開いたまま選択が動いても、開いた行の履歴を引く', async () => {
    const r = setup();
    const asked: string[] = [];
    r.d.onEvent((e) => {
      if (e.type === 'REQUEST_REVISION_LIST') asked.push(e.lid);
    });
    rightClick(r.row('n1'));
    // ⚠ `Alt+←`(戻る)相当 ── メニューが開いたまま選択が動く
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    expect(r.d.getState().selectedLid, '前提が崩れている(選択が動いていない)').toBe('n2');
    r.press('show-history');
    await tick();
    expect(asked, '開いた行(n1)ではなく、選択が動いた先の履歴を引いている').toEqual(['n1']);
  });

  /**
   * ⚠ **対照群** ── 選択を動かさなければ、これまでどおり開いた行の履歴を引く。
   * これが無いと、「何も引かなくなった」実装でも上の test だけでは分からない。
   */
  it('⚠ 対照群 ── 選択を動かさなければ、開いた行の履歴を引く', async () => {
    const r = setup();
    const asked: string[] = [];
    r.d.onEvent((e) => {
      if (e.type === 'REQUEST_REVISION_LIST') asked.push(e.lid);
    });
    rightClick(r.row('n1'));
    r.press('show-history');
    await tick();
    expect(asked, '選択を動かしていないのに引けていない').toEqual(['n1']);
  });
});

describe('行の右クリックメニューは、開いた瞬間の行に効く(#877)', () => {
  it('🔴 メニューを開いたまま選択が動いても、開いた行が消える(別の行を消さない)', async () => {
    const r = setup();
    rightClick(r.row('n1'));
    /**
     * ⚠ `Alt+←`(戻る)相当 ── `navHistory` はメニューの有無を見ずに
     *   `SELECT_ENTRY` を撃つ。ここでは直接 dispatch して同じ状況を作る
     *   (`selectedLid` が「メニューを開いた行」から動く、が本題)。
     */
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    expect(r.d.getState().selectedLid, '前提が崩れている(選択が動いていない)').toBe('n2');
    r.press('delete-entry');
    await answerDialog('ok');
    await tick();
    expect(r.d.getState().entryMetas.has('n1'), '開いた行(n1)が残っている').toBe(false);
    expect(
      r.d.getState().entryMetas.has('n2'),
      '選択が動いた先(n2)まで消えた ── 押していないノートが消えた',
    ).toBe(true);
    expect(r.deleted, 'disk への削除要求が n1 になっていない').toEqual(['n1']);
  });

  /**
   * ⚠ **対照群** ── 選択を動かさなければ、これまでどおり開いた行が消える。
   * これが無いと、「何も消せなくなった」実装でも上の test だけでは分からない。
   */
  /**
   * 🔴 **運ばれた身元が「空」のときは、無視して次の段へ落ちる**(#877 の着地前検算)。
   *
   * ⚠ 本文のメニューは `[MENU_LID_ATTR]: ob?.lid ?? ''` を運ぶので、
   *   **空文字が来る形が実在する**。⚠ ここを `??` で読むと `''` が lid として通り、
   *   受け手は `if (!lid) return;` で**黙って何もしない**(この repo がいちばん嫌う
   *   無言の dead click)か、`entryMetas.get('')` で undefined を掴む。
   * 🔑 だから `rowLidOrSelected` の①は **`||`** で読む ── 同じ読み方を
   *   `adopt-link-icon` が先にしている(binder.ts)。
   */
  it('🔴 運ばれた身元が空なら、無視して選んでいるノートへ落ちる(黙って何もしない、にしない)', async () => {
    const r = setup();
    rightClick(r.row('n1'));
    // ⚠ 本文のメニューが空を運ぶ形を、行のメニューの上で再現する
    for (const b of r.root.querySelectorAll(`${MENU} [data-pkc-action]`))
      b.setAttribute('data-pkc-menu-lid', '');
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    r.press('delete-entry');
    await answerDialog('ok');
    await tick();
    expect(
      r.deleted,
      '空の身元を lid として通した(または黙って何もしなかった)',
    ).toEqual(['n2']);
  });

  it('⚠ 対照群 ── 選択を動かさなければ、これまでどおり開いた行が消える', async () => {
    const r = setup();
    rightClick(r.row('n1'));
    r.press('delete-entry');
    await answerDialog('ok');
    await tick();
    expect(r.d.getState().entryMetas.has('n1'), '選択を動かしていないのに消えなかった').toBe(false);
    expect(r.deleted).toEqual(['n1']);
  });
});
