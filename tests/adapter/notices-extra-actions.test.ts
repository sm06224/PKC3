/**
 * 🔴 取り込み結果の面(`showNotices`)に、取り消しのほかの操作(競合のノートを一覧する。#2000)を並べられる。
 */
import { describe, expect, it } from 'vitest';
import { showNotices } from '../../src/adapter/ui/render/notices';
import { SHOW_SYNC_CONFLICTS_ACTION } from '../../src/adapter/ui/actions/sync-diff';
import { createSyncEnabledSection } from '../../src/adapter/ui/render/settings/sync-enabled';
import { SyncEnabledStore } from '../../src/adapter/ui/render/sync-enabled';
import { SYNC_FORGET_LABEL } from '../../src/features/sync/sync-setting';

describe('結果の面の追加の操作', () => {
  it('追加の操作は data-pkc-action つきのボタンとして頭に並ぶ(取り消し・閉じるは残る)', () => {
    const region = document.createElement('div');
    showNotices(region, '取り込みました', ['a'], { label: '取り込みを取り消す', action: 'undo-import', title: 't' }, [SHOW_SYNC_CONFLICTS_ACTION]);
    const actions = [...region.querySelectorAll('button')].map((b) => b.getAttribute('data-pkc-action'));
    expect(actions).toEqual(['undo-import', 'show-sync-conflicts', 'dismiss-notices']);
    expect(region.querySelector('[data-pkc-action="show-sync-conflicts"]')?.textContent).toBe('競合のノートを一覧する');
  });
  it('対照: 追加の操作が無ければ出ない・操作だけで本文が空でも面は出る', () => {
    const region = document.createElement('div');
    showNotices(region, '取り込みました', ['a'], null, []);
    expect(region.querySelector('[data-pkc-action="show-sync-conflicts"]')).toBeNull();
    const only = document.createElement('div');
    showNotices(only, '取り込みました', [], null, [SHOW_SYNC_CONFLICTS_ACTION]);
    expect(only.hidden).toBe(false);
  });
});

describe('設定「端末間の同期」', () => {
  it('「同期の記録を消す」ボタンが在り(押し口は forget-sync-records)、説明が競合の直し方とオフの間の削除を言う', () => {
    const region = document.createElement('div');
    const sec = createSyncEnabledSection(region, new SyncEnabledStore(null));
    const built = sec.build();
    region.append(...(Array.isArray(built) ? built : [built]));
    const btn = region.querySelector<HTMLButtonElement>('[data-pkc-action="forget-sync-records"]');
    expect(btn?.textContent).toBe(SYNC_FORGET_LABEL);
    const text = region.textContent ?? '';
    expect(text).toContain('同期の競合');
    expect(text).toContain('ゴミ箱へ移し');
    expect(text).toContain('オフの間に消したノートは相手へ伝わらず');
    expect(text).not.toContain('競合の一覧に出します'); // 一覧は無い(事実と違う文言を残さない)
  });
});
