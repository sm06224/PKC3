/** @vitest-environment happy-dom */
/**
 * 🔴 **2 ペインで行を右クリックしても、2 ペインを抜けない**(#1045 C9)。
 *
 * ## 何が起きていたか
 *
 * `onContextMenu`(binder.ts)の行の枝は `selectEntryOrExplain` → `SELECT_ENTRY`
 * を撃つ。`leavesOnSelect('dual')` は `true`(`ASIDE_PANES` に `dual` が在り、
 * `STAY_ON_SELECT` は `sql` だけ)なので、これを撃つと中央が本文の面へ切り替わる。
 * ⚠ **左クリックは 2 ペインに残る**(`dual-row` action → `DUAL_SELECT`)のに、
 * **右クリックだけ**画面ごと切り替わっていた ── 押した場所は同じなのに結果が違う。
 *
 * 🔑 直しは「押した行が 2 ペインの表(`dual-table`)の中か」で早期分岐し、
 * `SELECT_ENTRY` の代わりに**左クリックと同じ** `DUAL_SELECT` を撃つ。行のメニューは
 * `MENU_LID_ATTR` で押した行の lid を運ぶので(#877 と同じ規則)、選択
 * (`selectedLid`)を動かさなくても各項目は**押した行**に効く ── `st.selectedLid` /
 * `st.selection` に依存する 2 項目(`move-to-folder` / `copy-plain-markdown`)は
 * 押した物と効く先が食い違いうるので、この分岐のメニューからは外している。
 *
 * ⚠ 台は実物(shell + DualFilerRenderer + BrowseRouter + binder + effect 層)で
 *   組む ── 「メニューが運ぶ carry」と「binder が受ける」の合意は片方の test には
 *   書けない(CLAUDE.md §7)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { paneOf } from '../../src/features/relation/dual-pane';
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

/**
 * 2 ペインの台。⚠ 中央は `DualFilerRenderer`(`dual-filer.test.ts` の
 * 「2 ペインの配線(binder)」と同じ形)。左の列(`entry-list`)も同時に描く ──
 * 対照群(一覧タブの行を右クリック)を同じ台で取るため。
 */
function setupDual(services: Parameters<typeof bindActions>[2] = {}) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const dual = new DualFilerRenderer(regions.center);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.onState((s) => {
    dual.render(s);
    browse.render(s, 'list');
  });
  bindActions(root, d, services);
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
  d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
  const dualRow = (side: 'left' | 'right', lid: string): HTMLElement => {
    const el = regions.center.querySelector<HTMLElement>(
      `[data-pkc-region="dual-pane"][data-pkc-side="${side}"] [data-pkc-region="dual-table"] [data-pkc-entry="${lid}"]`,
    );
    expect(el, `前提が崩れている: 2 ペインに ${lid} の行が無い`).not.toBeNull();
    return el!;
  };
  const listRow = (lid: string): HTMLElement => {
    const el = regions.browseHost.querySelector<HTMLElement>(
      `[data-pkc-region="entry-list"] [data-pkc-entry="${lid}"]`,
    );
    expect(el, `前提が崩れている: 一覧に ${lid} の行が無い`).not.toBeNull();
    return el!;
  };
  const press = (action: string): void => {
    const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`);
    expect(b, `メニューに ${action} が無い`).not.toBeNull();
    b!.click();
  };
  const hasItem = (action: string): boolean =>
    root.querySelector(`${MENU} [data-pkc-action="${action}"]`) !== null;
  return { root, d, regions, dualRow, listRow, press, hasItem, deleted };
}

describe('2 ペインの表の行を右クリックしても、2 ペインを抜けない(#1045 C9)', () => {
  it('🔴 中央は dual のまま(本文の面に切り替わらない)', () => {
    const t = setupDual();
    expect(t.d.getState().viewMode, '前提が崩れている').toBe('dual');
    rightClick(t.dualRow('left', 'n1'));
    expect(t.d.getState().viewMode, '本文の面へ切り替わった(2 ペインを抜けた)').toBe('dual');
    expect(t.root.querySelector(MENU), 'メニューが出ていない').not.toBeNull();
  });

  it('🔴 selectedLid は動かない ── 左クリックと同じ DUAL_SELECT だけが、その面の印を動かす', () => {
    const t = setupDual();
    // ⚠ n2 を選んだ「後」で 2 ペインへ入る ── selectedLid が押した行(n1)と
    //   違うことを前提にできる(食い違いが起きたら n2 側に効くはず)
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    t.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    expect(t.d.getState().selectedLid, '前提が崩れている').toBe('n2');
    rightClick(t.dualRow('left', 'n1'));
    expect(t.d.getState().selectedLid, 'selectedLid が押した行へ動いた').toBe('n2');
    expect(paneOf(t.d.getState().dual, 'left').selection, '押した行の印(その面)が動いていない').toEqual([
      'n1',
    ]);
  });

  /**
   * 🔴 **`move-to-folder` / `copy-plain-markdown` はこの分岐からは出さない**
   * (#1045 C9。`binder.ts` の docstring と同じ理由)。
   * ⚠ 空振り防止 ── メニューそのものは出ている(他の項目は在る)ことも確かめる。
   */
  it('🔴 選択が押した行に揃わない 2 項目は、この分岐のメニューに出ない', () => {
    const t = setupDual();
    rightClick(t.dualRow('left', 'n1'));
    expect(t.hasItem('move-to-folder'), '選択と食い違う項目が出ている').toBe(false);
    expect(t.hasItem('copy-plain-markdown'), '選択と食い違う項目が出ている').toBe(false);
    expect(t.hasItem('delete-entry'), '空振り防止(メニューごと出ていない)').toBe(true);
    expect(t.hasItem('copy-entry-ref'), '空振り防止(メニューごと出ていない)').toBe(true);
  });

  it('🔴 「削除」は選んでいるノートではなく、押した行に効く', async () => {
    const t = setupDual();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    t.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    rightClick(t.dualRow('left', 'n1'));
    t.press('delete-entry');
    await answerDialog('ok');
    await tick();
    expect(t.d.getState().entryMetas.has('n1'), '押した行(n1)が残っている').toBe(false);
    expect(
      t.d.getState().entryMetas.has('n2'),
      '選んでいたノート(n2、押していない)まで消えた',
    ).toBe(true);
    expect(t.deleted, 'disk への削除要求が押した行になっていない').toEqual(['n1']);
  });

  it('🔴 「参照をコピー」は、選んでいるノートではなく押した行の題名を写す', () => {
    const copied: string[] = [];
    const t = setupDual({ copyText: (text) => copied.push(text) });
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    t.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    rightClick(t.dualRow('left', 'n1'));
    t.press('copy-entry-ref');
    expect(copied, '押した行の参照が写っていない').toHaveLength(1);
    expect(copied[0], '選んでいるノート(n2)の題名を写した').toContain('t-n1');
    expect(copied[0], '押していないノート(n2)の題名まで写った').not.toContain('t-n2');
  });

  it('🔴 「Word」は、選んでいるノートではなく押した行を書き出す', () => {
    const exported: string[] = [];
    const t = setupDual({ exportEntryDocx: (lid) => exported.push(lid) });
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    t.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    rightClick(t.dualRow('left', 'n1'));
    t.press('export-entry-docx');
    expect(exported, '書き出しが押した行になっていない').toEqual(['n1']);
  });

  it('🔴 「名前を変える」も、選んでいるノートではなく押した行を対象にする', () => {
    const t = setupDual();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    t.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    rightClick(t.dualRow('left', 'n1'));
    /**
     * ⚠ 2 ペインの表は `[data-pkc-field="row-rename"]` を描かない(独自の
     *   `dual-rename-begin` を持つ)ので、`rename-entry-begin` は
     *   フォールバックの末に諦めて `renamingLid` を `null` へ戻す。⚠ それでも
     *   **一瞬 `n1` を経由すること**(押した行が対象になっていたこと)は見える ──
     *   `onState` は state が変わった回だけ呼ばれるので、これで十分言える。
     */
    const seen: string[] = [];
    const unsub = t.d.onState((s) => {
      if (s.renamingLid !== null) seen.push(s.renamingLid);
    });
    t.press('rename-entry-begin');
    unsub();
    expect(seen, '名前を変える先が押した行になっていない').toEqual(['n1']);
  });

  describe('編集中でも、同じ扱いになる(#690 ④ A′ の枝と揃える)', () => {
    function editingSetup(services: Parameters<typeof bindActions>[2] = {}) {
      const t = setupDual(services);
      // ⚠ n2 を開いて編集に入る ── 押す行(n1)とは別のノートであること
      t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
      t.d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '' });
      t.d.dispatch({ type: 'START_EDIT' });
      expect(t.d.getState().phase, '前提が崩れている(編集に入っていない)').toBe('editing');
      t.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
      expect(t.d.getState().viewMode, '前提が崩れている(dual を開けていない)').toBe('dual');
      return t;
    }

    it('🔴 中央は dual のまま、出るのは「別のウィンドウで開く」だけ', () => {
      const t = editingSetup();
      rightClick(t.dualRow('left', 'n1'));
      expect(t.d.getState().viewMode, '本文の面へ切り替わった').toBe('dual');
      expect(t.d.getState().phase, '下書きが壊れた').toBe('editing');
      expect(t.hasItem('open-note-window'), '「別のウィンドウで開く」が出ていない').toBe(true);
      expect(t.hasItem('delete-entry'), '編集中の枝より広い項目が出た').toBe(false);
      // ⚠ 左クリックと同じ 1 本は編集中でも動く(DUAL_SELECT は phase を見ない)
      expect(paneOf(t.d.getState().dual, 'left').selection, '編集中は印が動いていない').toEqual([
        'n1',
      ]);
    });

    it('🔴 「別のウィンドウで開く」は、書いているノートではなく押した行を開く', () => {
      const opened: string[] = [];
      const t = editingSetup({ openNoteWindow: (lid) => opened.push(lid) });
      rightClick(t.dualRow('left', 'n1'));
      t.press('open-note-window');
      expect(opened, '書いているノート(n2)を開いてしまった').toEqual(['n1']);
    });
  });

  /**
   * ⚠ **対照群** ── 一覧タブ(`entry-list`、2 ペインの表ではない)の行を右クリックすれば、
   *   これまでどおり選ばれて中央が本文の面へ切り替わる。これが無いと、
   *   「何も切り替わらなくなった」実装でも上の test だけでは分からない。
   */
  it('⚠ 対照群 ── 一覧タブの行は、今までどおり選ばれて本文の面が出る', () => {
    const t = setupDual();
    expect(t.d.getState().viewMode, '前提が崩れている').toBe('dual');
    rightClick(t.listRow('n2'));
    expect(t.d.getState().viewMode, '一覧タブの行が 2 ペインの扱いになった').toBe('detail');
    expect(t.d.getState().selectedLid, '一覧タブの行が選ばれていない').toBe('n2');
  });
});
