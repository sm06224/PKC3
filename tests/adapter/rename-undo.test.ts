/** @vitest-environment happy-dom */
/**
 * 🔴 **題名を変えた直後に、画面の下へ「元に戻す」が出る**(Gemini 裁定 = #1163 の依頼 45 の 2、#1657)。
 *
 * 直す前は、題名をどこから変えても画面の下に何も出ず、変える前の題名は履歴にも残らなかった。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { renameEntryFromRow } from '../../src/adapter/ui/actions/attachment-rename';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { paintStatusUndo } from '../../src/adapter/ui/render/status-open';
import {
  clearRenameOffer,
  currentRenameOffer,
  RENAME_OFFER_MS,
} from '../../src/adapter/ui/render/rename-undo';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const META = (lid: string, title: string): EntryMeta => ({
  lid,
  title,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 0,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

let root: HTMLElement;
let stop: () => void;
let d: Dispatcher;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.textContent = '';
  root = document.createElement('div');
  document.body.append(root);
  d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c', metas: [META('a', '旧い題名'), META('b', '別')], relations: [] });
  stop = bindActions(root, d);
});
afterEach(() => {
  stop();
  clearRenameOffer();
  vi.useRealTimers();
});

const title = (lid: string): string | undefined => d.getState().entryMetas.get(lid)?.title;

function press(action: string): void {
  const b = document.createElement('button');
  b.setAttribute('data-pkc-action', action);
  root.append(b);
  b.click();
}

describe('題名を変えた直後の「元に戻す」', () => {
  it('🔴 変えると、知らせと戻す材料が出て、押すと変える前の題名へ戻る', () => {
    renameEntryFromRow(d, 'a', '新しい題名');
    expect(title('a'), '前提: 変わっていない').toBe('新しい題名');
    expect(d.getState().notice).toBe('題名を「旧い題名」から「新しい題名」に変えました');
    expect(currentRenameOffer()?.from, '戻す材料が出ていない').toBe('旧い題名');
    const btn = document.createElement('button');
    const shown = d.getState().notice ?? '';
    expect(paintStatusUndo(btn, d.getState(), shown), '押し口が出ない').toBe(true);
    expect(btn.getAttribute('data-pkc-action')).toBe('undo-rename');
    expect(btn.textContent).toBe('元に戻す');
    press('undo-rename');
    expect(title('a'), '戻っていない').toBe('旧い題名');
    expect(d.getState().notice).toBe('題名を「旧い題名」に戻しました');
    expect(currentRenameOffer(), '戻した後も材料が残っている').toBeNull();
  });

  it('対照群:同じ題名・空白だけの改名は知らせない(変わっていないので戻す物が無い)', () => {
    renameEntryFromRow(d, 'a', '旧い題名');
    renameEntryFromRow(d, 'a', '   ');
    expect(currentRenameOffer()).toBeNull();
    expect(title('a')).toBe('旧い題名');
  });

  it('別の知らせが上書きしたら押し口を畳む(別の知らせが戻ると読ませない)', () => {
    renameEntryFromRow(d, 'a', '新');
    const btn = document.createElement('button');
    expect(paintStatusUndo(btn, d.getState(), '別の知らせです')).toBe(false);
    expect(btn.hidden).toBe(true);
  });

  it('数秒経つと知らせごと降ろす', () => {
    renameEntryFromRow(d, 'a', '新');
    vi.advanceTimersByTime(RENAME_OFFER_MS + 10);
    expect(currentRenameOffer()).toBeNull();
    expect(d.getState().notice).not.toBe('題名を「旧い題名」から「新」に変えました');
  });

  it('🔴 変えた後にもう一度変えていたら、勝手に古い題名へ戻さず理由を言う', () => {
    renameEntryFromRow(d, 'a', '新');
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'a', title: 'さらに別の題名' });
    press('undo-rename');
    expect(title('a'), '後からの題名を踏んだ').toBe('さらに別の題名');
    expect(d.getState().notice).toContain('戻せるものがありません');
  });

  it('次に変えると戻せるのは直前の 1 回だけ', () => {
    renameEntryFromRow(d, 'a', '一回目');
    renameEntryFromRow(d, 'b', '二回目');
    expect(currentRenameOffer()?.lid).toBe('b');
    press('undo-rename');
    expect(title('b')).toBe('別');
    expect(title('a')).toBe('一回目');
  });
});
