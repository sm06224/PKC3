/** @vitest-environment happy-dom */
/**
 * 🔴 **書いている最中でも、一覧の行の右クリックから「別の窓で開く」だけは出す**
 *   (#690 ④ A′、user 裁定 2026-09-04「全部推薦で」)。
 *
 * ## 物語
 *
 * 本文を書いている途中で、一覧の別のノートを参照したくなる。直す前は編集中の行の
 * 右クリックが**必ず断られ**(「編集を保存するか、編集をやめてからノートを開いてください」)、
 * 右の情報のボタンも全部 `disabled` ── **下書きを閉じるか、諦めるか**しか無かった。
 * 付箋は中央を動かさずに脇へ出すので、下書きを壊す理由が 1 つも無い。
 *
 * ## 何を守るか
 *
 * - 編集中の行の右クリックで出るメニューは、いつもと同じ項目を並べ、**押せるのは `open-note-window` だけ**。
 *   他は灰色(`disabled`)で、説明に「編集を保存するか、編集をやめてから使えます」と出る(台帳 #1852 / 依頼 79-2 B)
 * - 押しても **`selectedLid` が動かない**(`SELECT_ENTRY` を撃たない)し、編集も続く
 * - 対照群 ── 編集中でなければ今までどおり全項目
 * - 居ない lid は理由を出して断る(無言の dead click を作らない)
 */
import { describe, expect, it } from 'vitest';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { phaseBlockReason } from '../../src/adapter/state/app-state';
import { MENU_HINT_FIELD } from '../../src/adapter/ui/render/context-menu';
import {
  ENTRY_ACTION_HINTS,
  ENTRY_ACTION_LABELS,
  editingRowMenuActions,
  entryMenuActions,
} from '../../src/features/entry-actions';

const MENU = '[data-pkc-region="context-menu"]';

function metasOf(lids: readonly string[]): ReadonlyMap<string, EntryMeta> {
  return new Map(
    lids.map((lid, i) => [
      lid,
      {
        lid,
        title: lid,
        archetype: 'text',
        createdAt: null,
        updatedAt: null,
        entryOrder: i + 1,
        status: null,
        date: null,
        archived: false,
        bodyChars: 0,
      } satisfies EntryMeta,
    ]),
  );
}

/**
 * ⚠ **state を直に組む** ── `START_EDIT` は `openBody` が要るので、reducer を通すより
 *   「書いている最中」を 1 行で作れる。確かめたいのはメニューの中身と副作用である。
 */
function editingState(): AppState {
  return {
    ...initialState,
    cid: 'c1',
    phase: 'editing',
    selectedLid: 'writing',
    entryMetas: metasOf(['writing', 'other']),
    openBody: { lid: 'writing', body: 'x', baseline: 'x', persisted: 'x', diskAhead: false },
  };
}

function setup(state: AppState) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML =
    '<div data-pkc-region="filer-table">' +
    '<li data-pkc-entry="writing">書いている行</li>' +
    '<li data-pkc-entry="other">別の行</li>' +
    '<li data-pkc-entry="ghost">居ない行</li>' +
    '</div>';
  document.body.append(root);
  const d = new Dispatcher(state);
  const opened: string[] = [];
  bindActions(root, d, { openNoteWindow: (lid) => void opened.push(lid) });
  const rightClick = (lid: string): MouseEvent => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    root.querySelector(`[data-pkc-entry="${lid}"]`)!.dispatchEvent(e);
    return e;
  };
  const actions = (): string[] =>
    [...(root.querySelector(MENU)?.querySelectorAll('button[data-pkc-action]') ?? [])].map(
      (b) => b.getAttribute('data-pkc-action')!,
    );
  /** 押せる項目だけ(灰色でない物)。 */
  const enabled = (): string[] =>
    [...(root.querySelector(MENU)?.querySelectorAll<HTMLButtonElement>('button[data-pkc-action]') ?? [])]
      .filter((b) => !b.disabled)
      .map((b) => b.getAttribute('data-pkc-action')!);
  return { root, d, opened, rightClick, actions, enabled, menu: () => root.querySelector(MENU) };
}

describe('編集中の行の右クリック(#690 ④ A′)', () => {
  it('🔴 いつもと同じ項目が並び、押せるのは「別のウィンドウで開く」だけ ── 断り文は出ない', () => {
    const s = setup(editingState());
    const e = s.rightClick('other');
    expect(e.defaultPrevented, '既定を奪っていない(ブラウザのメニューが重なる)').toBe(true);
    expect(s.actions(), 'いつもと同じ項目・同じ順に並んでいない').toEqual(
      entryMenuActions({ archetype: 'text', linkedFile: null }).map((a) => a.action),
    );
    expect(s.actions().length, '前提が崩れた(項目が 1 つしか無い)').toBeGreaterThan(5);
    expect(s.enabled(), '押せる項目が「別のウィンドウで開く」だけではない').toEqual(['open-note-window']);
    expect(s.d.getState().error, '編集中の断り文が出ている').toBeNull();
    // 🔑 字も説明も正本(`entry-actions.ts`)から来ている
    const btn = s.menu()!.querySelector('button[data-pkc-action="open-note-window"]')!;
    expect(btn.textContent).toBe(ENTRY_ACTION_LABELS['open-note-window']);
    expect(btn.getAttribute('data-pkc-hint')).toBe(ENTRY_ACTION_HINTS['open-note-window']);
    expect(s.menu()!.querySelector(`[data-pkc-field="${MENU_HINT_FIELD}"]`), '説明欄が無い').not.toBeNull();
    // 🔴 灰色の項目は、理由を説明に持つ(消えた理由が画面のどこにも出ない、が元の不具合)
    const copy = s.menu()!.querySelector<HTMLButtonElement>('button[data-pkc-action="copy-entry-ref"]')!;
    expect(copy.disabled, '押せない項目が押せる').toBe(true);
    expect(copy.getAttribute('data-pkc-hint')).toBe('編集を保存するか、編集をやめてから使えます');
    // 前置きの出どころは phaseBlockReason 1 か所(手書きの複製を作らない)
    expect(`${phaseBlockReason('editing')}使えます`).toBe('編集を保存するか、編集をやめてから使えます');
  });

  it('🔴 灰色の項目を押しても何も撃たれず、メニューも断り文も出さない(押せない物は押せない)', () => {
    const s = setup(editingState());
    const fired: string[] = [];
    const orig = s.d.dispatch.bind(s.d);
    s.d.dispatch = (a) => {
      fired.push(a.type);
      return orig(a);
    };
    s.rightClick('other');
    s.menu()!.querySelector<HTMLButtonElement>('button[data-pkc-action="delete-entry"]')!.click();
    expect(fired, '灰色の「ゴミ箱へ移す」で何かが撃たれた').toEqual([]);
    expect(s.d.getState().entryMetas.has('other')).toBe(true);
  });

  it('🔴 押すと押した行の窓が出て、下書きも中央のノートも動かない', () => {
    const s = setup(editingState());
    /**
     * 🔴 **撃たれた action を数える**(変異試験 M4 が SURVIVED で教えた)。
     * ⚠ 編集中の `SELECT_ENTRY` は reducer が落とすので、`selectedLid` を見るだけでは
     *   「撃っていない」と「撃ったが落とされた」を区別できない ── 後者は reducer の門が
     *   緩んだ日に下書きを巻き込む形で戻る。
     */
    const fired: string[] = [];
    const orig = s.d.dispatch.bind(s.d);
    s.d.dispatch = (a) => {
      fired.push(a.type);
      return orig(a);
    };
    s.rightClick('other');
    const btn = s.menu()!.querySelector<HTMLButtonElement>('button[data-pkc-action="open-note-window"]')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(s.opened, '押した行のノートが別の窓へ渡っていない').toEqual(['other']);
    expect(fired, '編集中に行を選ぶ action が撃たれた').not.toContain('SELECT_ENTRY');
    const st = s.d.getState();
    expect(st.selectedLid, '行が選ばれて中央のノートが動いた').toBe('writing');
    expect(st.phase, '編集が終わった(下書きが巻き込まれた)').toBe('editing');
    expect(st.openBody?.lid).toBe('writing');
  });

  /** ⚠ **対照群** ── 編集中でなければ、今までどおり全項目が出る(行も選ばれる)。 */
  it('⚠ 編集中でなければ今までどおり全項目', () => {
    const s = setup({ ...editingState(), phase: 'ready' });
    s.rightClick('other');
    expect(s.actions()).toEqual(
      entryMenuActions({ archetype: 'text', linkedFile: null }).map((a) => a.action),
    );
    expect(s.actions().length, '前提が崩れた(全項目が 1 行しか無い)').toBeGreaterThan(1);
    expect(s.d.getState().selectedLid, '編集中でないのに行が選ばれない').toBe('other');
  });

  /** ⚠ 居ない lid は理由を出して断る(無言で終わらせない)。 */
  it('⚠ 居ないノートの行は、理由を出して断る', () => {
    const s = setup(editingState());
    s.rightClick('ghost');
    expect(s.menu(), '居ないノートにメニューが出た').toBeNull();
    expect(s.d.getState().error).toContain('ノートが見つかりません');
  });

  /** 🔑 表の側:1 行だけで、字と説明が正本と一致する。 */
  it('🔑 editingRowMenuActions は entryMenuActions と同じ並びで、open-note-window だけが押せる(説明つき)', () => {
    const ctx = { archetype: 'text', linkedFile: null } as const;
    const rows = editingRowMenuActions(phaseBlockReason('editing') ?? '', ctx);
    expect(rows.map((r) => r.action)).toEqual(entryMenuActions(ctx).map((a) => a.action));
    expect(rows.filter((r) => r.disabled !== true).map((r) => r.action)).toEqual(['open-note-window']);
    const open = rows.find((r) => r.action === 'open-note-window')!;
    expect(open.label).toBe(ENTRY_ACTION_LABELS['open-note-window']);
    expect(open.hint).toBe(ENTRY_ACTION_HINTS['open-note-window']);
    for (const r of rows.filter((x) => x.action !== 'open-note-window')) {
      expect(r.hint, r.action).toBe('編集を保存するか、編集をやめてから使えます');
    }
  });
});
