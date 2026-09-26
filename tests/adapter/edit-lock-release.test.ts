/** @vitest-environment happy-dom */
/**
 * #177: 編集ロックの解放は phase の遷移 1 か所で束ねる。
 * editing を離れる経路(保存 / 取消 / …)ごとに releaseEdit を書かない ──
 * 漏れた経路だけ「別タブから永久に編集できないノート」を作るため。
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindEditLockRelease } from '../../src/adapter/state/edit-lock-release';

/**
 * ⚠ 実配線と同じく **bind が先、編集開始が後**(main.ts は boot で bind する)。
 * 逆順だと watcher は editing の state を一度も見ず、解放が空になる。
 */
function bootedEditing(sync: () => { releaseEdit: (cid: string, lid: string) => void }): {
  d: Dispatcher;
  lid: string;
} {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  bindEditLockRelease(d, sync, 'c1');
  const lid = 'n1';
  d.dispatch({
    type: 'CREATE_ENTRY',
    archetype: 'text',
    lid,
    title: 'note',
    parentLid: null,
    relationId: 'r1',
  });
  expect(d.getState().phase).toBe('editing');
  return { d, lid };
}

describe('bindEditLockRelease', () => {
  it('保存(COMMIT_EDIT)で編集していた lid が返る。編集中は返らない', () => {
    const releaseEdit = vi.fn();
    const { d, lid } = bootedEditing(() => ({ releaseEdit }));
    // 編集中の state 変化(本文更新)では返らない
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# x' });
    expect(releaseEdit).not.toHaveBeenCalled();
    d.dispatch({ type: 'COMMIT_EDIT' });
    expect(releaseEdit).toHaveBeenCalledWith('c1', lid);
  });

  it('取消(CANCEL_EDIT)でも返る ── 経路の対称(§7)', () => {
    const releaseEdit = vi.fn();
    const { d, lid } = bootedEditing(() => ({ releaseEdit }));
    d.dispatch({ type: 'CANCEL_EDIT' });
    expect(releaseEdit).toHaveBeenCalledWith('c1', lid);
  });

  it('sync は呼ぶたびに読む ── 昇格で実体が替わっても新しい方へ返す', () => {
    const before = { releaseEdit: vi.fn() };
    const after = { releaseEdit: vi.fn() };
    let current = before;
    const { d } = bootedEditing(() => current);
    current = after; // 昇格(follower → host)
    d.dispatch({ type: 'COMMIT_EDIT' });
    expect(before.releaseEdit).not.toHaveBeenCalled();
    expect(after.releaseEdit).toHaveBeenCalledTimes(1);
  });

  it('編集していないタブでは何も返さない(空振りでない解放を作らない)', () => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const releaseEdit = vi.fn();
    bindEditLockRelease(d, () => ({ releaseEdit }), 'c1');
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'query' });
    expect(releaseEdit).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 **章の欄も同じ 1 か所で守る**(#1044 段2、F-B)。
 *
 * ⚠ 章の欄は `phase` を `ready` のまま保つ(#1044 段2 設計)ので、直す前は
 *   `bindEditLockRelease` が `phase === 'editing'` だけを見ていて、章の欄の
 *   ロックが**永久に返らなかった**。
 */
describe('bindEditLockRelease(章の欄、#1044 段2 F-B)', () => {
  const HEAD_BODY = ['## 章', '', '中身', ''].join('\n');

  /** ⚠ bind が先、章の欄を開くのが後(実配線と同じ順序)。 */
  function bootedSection(sync: () => { releaseEdit: (cid: string, lid: string) => void }): {
    d: Dispatcher;
    lid: string;
  } {
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'n1',
          title: 't',
          archetype: 'text',
          createdAt: null,
          updatedAt: null,
          entryOrder: 1,
          status: null,
          date: null,
          archived: false,
          bodyChars: null,
        },
      ],
      relations: [],
    });
    bindEditLockRelease(d, sync, 'c1');
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: HEAD_BODY });
    d.dispatch({ type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 0 });
    expect(d.getState().sectionDraft, '章の欄が開いていない(前提が崩れている)').not.toBeNull();
    expect(d.getState().phase, 'アプリ全体が編集中になった').toBe('ready');
    return { d, lid: 'n1' };
  }

  /**
   * ⚠ **保存は effect 化された**(#1044 段2 3巡目の修理、S1)── `SAVE_SECTION_DRAFT`
   *   はもう同期に下書きを閉じない(`saving: true` を立てて要求を出すだけ)。
   *   ロックが返るのは、disk から読み直した effect の ack(`SECTION_SAVED`)が
   *   届いて下書きが本当に閉じたときである。
   */
  it('章を保存すると、握っていた lid が 1 回だけ返る', () => {
    const releaseEdit = vi.fn();
    const { d, lid } = bootedSection(() => ({ releaseEdit }));
    // 無関係な state 変化(章の欄とは関係ない)では返らない
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'x' });
    expect(releaseEdit).not.toHaveBeenCalled();
    d.dispatch({ type: 'SAVE_SECTION_DRAFT', text: '## 章\n\n書いた' });
    // 🔑 要求を出した時点では、まだ下書きも残り、ロックも返らない(ack 待ち)
    expect(d.getState().sectionDraft, '保存要求の時点で下書きが消えた').not.toBeNull();
    expect(d.getState().sectionDraft!.saving, '保存中の印が立っていない').toBe(true);
    expect(releaseEdit, '保存要求の時点でロックを返した(気が早い)').not.toHaveBeenCalled();
    d.dispatch({
      type: 'SECTION_SAVED',
      lid,
      gen: d.getState().lockGen,
      heading: '章',
      body: '## 章\n\n書いた\n',
      status: null,
      date: null,
      archived: false,
    });
    expect(d.getState().sectionDraft, '保存後も下書きが残っている').toBeNull();
    expect(releaseEdit).toHaveBeenCalledTimes(1);
    expect(releaseEdit).toHaveBeenCalledWith('c1', lid);
  });

  it('章の編集をやめると、握っていた lid が 1 回だけ返る', () => {
    const releaseEdit = vi.fn();
    const { d, lid } = bootedSection(() => ({ releaseEdit }));
    d.dispatch({ type: 'CANCEL_SECTION_DRAFT' });
    expect(releaseEdit).toHaveBeenCalledTimes(1);
    expect(releaseEdit).toHaveBeenCalledWith('c1', lid);
  });

  it('system command(別タブの書込)で章の欄が閉じても、握っていた lid が 1 回だけ返る', () => {
    const releaseEdit = vi.fn();
    const { d, lid } = bootedSection(() => ({ releaseEdit }));
    // 別タブがそのノートを消した体(同じ cid、metas から n1 が落ちる ── F-A の
    // guardSectionDraftTransition が system command として下書きを閉じる)
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    expect(d.getState().sectionDraft, '下書きが閉じていない').toBeNull();
    expect(releaseEdit).toHaveBeenCalledTimes(1);
    expect(releaseEdit).toHaveBeenCalledWith('c1', lid);
  });
});
