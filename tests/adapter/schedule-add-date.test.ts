/** @vitest-environment happy-dom */
/**
 * 🔴 **予定表の「足す」は、読めない日付・二重の日付を黙って書かない**(#1087)。
 *
 * 直す前:
 * ① 日付の欄は年を 6 桁まで打てるので、打ち間違えると `@20261-03-05` を書き、
 *    読み手が日付と読まないので**足した予定がどこにも出ず、理由も出なかった**。
 * ② やることの字に `@2026-03-01` を打ち、欄で 3/05 を選ぶと両方を並べて書き、
 *    読み手は**字の日付**を採るので、3/05 の予定表には出なかった(「足しました」とは出る)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { addScheduleItem } from '../../src/adapter/ui/actions/binder';

function boot() {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  const appends = () => sent.filter((a) => a.type === 'APPEND_TO_ENTRY');
  return { d, appends };
}

describe('予定表の「足す」の日付(#1087)', () => {
  it('🔴 読めない日付(年が 5 桁)は書かず、理由を出す', () => {
    const h = boot();
    expect(addScheduleItem(h.d, { text: '見積', date: '20261-03-05' })).toBe(false);
    expect(h.appends(), '読めない日付を書いた').toEqual([]);
    expect(h.d.getState().error ?? '').toContain('読めません');
  });

  it('🔴 字にも日付があれば、どちらも書かずに理由を出す(黙って字の日付を採らない)', () => {
    const h = boot();
    expect(addScheduleItem(h.d, { text: '見積 @2026-03-01', date: '2026-03-05' })).toBe(false);
    expect(h.appends(), '日付を 2 つ並べて書いた').toEqual([]);
    expect(h.d.getState().error ?? '').toContain('どちらか一方');
  });

  it('対照群: 正しい日付だけなら書く / 欄が空なら字の日付のまま書く', () => {
    const ok = boot();
    // 頼んだ回は Promise(disk に着くまで待つ ── #1087)。断った回の同期 false と区別する
    expect(addScheduleItem(ok.d, { text: '見積', date: '2026-03-05' })).toBeInstanceOf(Promise);
    expect(ok.appends().map((a) => (a as { text: string }).text)).toEqual(['- [ ] 見積 @2026-03-05']);
    const inText = boot();
    expect(addScheduleItem(inText.d, { text: '見積 @2026-03-01', date: '' })).toBeInstanceOf(Promise);
    expect(inText.appends().map((a) => (a as { text: string }).text)).toEqual(['- [ ] 見積 @2026-03-01']);
  });
});
