/** @vitest-environment happy-dom */
/**
 * 🔴 **予定表の「足す」は、追記できない種類のノートへは書かない**(#1087)。
 *
 * 直す前: 題名が今日の日付のノートが**フォルダ・添付・スタック・アプリ**だと、足した行をそこへ書いていた。
 * それらは本文を読まれない / 持たない種類なので、**足した予定がどこにも出ず、理由も出なかった**。
 * いまは追記できる種類(ノート・ログ)だけを「今日のノート」とみなし、無ければ新しいノートを作る
 * (今までの「今日のノートが無い」回と同じ)。
 *
 * 観測点: 撃った action(`CREATE_ENTRY` の有無 / `APPEND_TO_ENTRY` の行き先)。
 * 対照群: 追記できる種類(text / textlog)なら今までどおりそこへ足す。
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { addScheduleItem, addScheduleItemChecked } from '../../src/adapter/ui/actions/binder';
import { todayNoteTitle } from '../../src/features/schedule/today-note';

const TITLE = todayNoteTitle(new Date());

function boot(archetype: string) {
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      {
        lid: 'today',
        title: TITLE,
        archetype,
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      },
    ] as never,
    relations: [],
  });
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  const creates = () => sent.filter((a) => a.type === 'CREATE_ENTRY') as Extract<Dispatchable, { type: 'CREATE_ENTRY' }>[];
  const appends = () => sent.filter((a) => a.type === 'APPEND_TO_ENTRY') as Extract<Dispatchable, { type: 'APPEND_TO_ENTRY' }>[];
  return { d, creates, appends };
}

describe('予定を足す先の「今日のノート」(#1087)', () => {
  it.each(['folder', 'attachment', 'stack', 'app'])(
    '🔴 題名が今日の日付の %s には書かず、新しいノートを作ってそこへ足す',
    (archetype) => {
      const h = boot(archetype);
      void addScheduleItem(h.d, { text: '見積', date: '' });
      expect(h.creates(), '新しいノートを作っていない').toHaveLength(1);
      expect(h.creates()[0]).toMatchObject({ archetype: 'text', title: TITLE });
      expect(h.appends()).toHaveLength(1);
      expect(h.appends()[0]!.lid, '追記できない種類の「今日」へ書いた').not.toBe('today');
      expect(h.appends()[0]!.lid, '作ったノートへ書いていない').toBe(h.creates()[0]!.lid);
    },
  );

  it.each(['text', 'textlog'])('対照群: 題名が今日の日付の %s には今までどおり足し、作らない', (archetype) => {
    const h = boot(archetype);
    void addScheduleItem(h.d, { text: '見積', date: '' });
    expect(h.creates()).toHaveLength(0);
    expect(h.appends().map((a) => a.lid)).toEqual(['today']);
  });

  it('🔴 錠の確かめも同じ相手に対して行う ── 追記できない種類の「今日」の錠は取りに行かない', async () => {
    const acquire = vi.fn(async () => 'denied' as const);
    const h = boot('folder');
    const r = addScheduleItemChecked(h.d, { acquireEditLock: acquire, releaseEditLock: vi.fn() }, { text: '見積', date: '' });
    // 同期で撃つ(書く相手がまだ無い = 誰も編集できない)
    expect(r).toBeInstanceOf(Promise);
    expect(acquire, 'フォルダの錠を取りに行った(書かない相手を確かめた)').not.toHaveBeenCalledWith('today');
    expect(h.creates()).toHaveLength(1);
  });

  it('対照群: 追記できる種類の「今日」なら錠を確かめ、断られたら書かない', async () => {
    const acquire = vi.fn(async () => 'denied' as const);
    const h = boot('text');
    const r = await addScheduleItemChecked(h.d, { acquireEditLock: acquire, releaseEditLock: vi.fn() }, { text: '見積', date: '' });
    expect(acquire).toHaveBeenCalledWith('today');
    expect(r).toBe(false);
    expect(h.appends()).toHaveLength(0);
  });
});
