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
