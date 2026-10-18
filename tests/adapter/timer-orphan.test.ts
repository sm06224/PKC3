/** @vitest-environment happy-dom */
/**
 * 🔴 **計っている途中で閉じられたタブの記録を、次に開いたとき拾うか聞く**(台帳 #1852 / 依頼 75-1。Gemini 回答 = 推薦 B)。
 *
 * 直す前: 時間を計っている途中でタブを閉じると、計った時間は黙って消えた(同じタブの読み直しだけ O1 で続けて計れる)。
 *
 * 守る主張:
 *  1. 閉じた印(pagehide)から猶予がたった他のタブの計測は、「止めたことにして本文に入れますか」と聞く。終わりは閉じた時刻
 *  2. 「入れる」→ 本文に 1 行入る / 「入れない」→ 入れず、そう言って、記録を消す(次の起動で繰り返さない)
 *  3. いま動いている他のタブ(動いている印が新しい)の計測は拾わない(二重に数えない)
 *  4. 閉じた印が無くても、動いている印が止まって久しければ拾う(終わりは最後に動いていた時刻)
 *  5. 同じタブの読み直し(閉じた印の後、すぐ開き直した)は拾わず、続けて計る。印は打ち消される
 *  6. 聞く口が無いときは何もせず、記録も消さない
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { createTimerService } from '../../src/adapter/ui/actions/timer';
import {
  TIMER_LEFT_GRACE_MS,
  TIMER_STALE_MS,
  TimerRunStore,
} from '../../src/adapter/ui/render/timer-resume';

const meta = (lid: string, title: string): EntryMeta => ({
  lid,
  title,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const T0 = new Date(2026, 9, 18, 9, 0, 0).getTime();

function box(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function tab(
  local: ReturnType<typeof box>,
  session: ReturnType<typeof box>,
  opts: { nowMs: number; answer?: boolean | null },
) {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', '資料'), meta('b', '別')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
  let nowMs = opts.nowMs;
  const asked: string[] = [];
  const notices: Array<{ text: string; kind?: string }> = [];
  const appended: string[] = [];
  d.onEvent((e) => {
    if (e.type === 'REQUEST_APPEND') {
      appended.push(e.text);
      const { lid, gen } = e;
      queueMicrotask(() =>
        d.dispatch({ type: 'ENTRY_APPENDED', lid, gen, body: '本文', status: null, date: null, archived: false, inserted: null }),
      );
    }
  });
  const store = new TimerRunStore(local, session, () => nowMs);
  const service = createTimerService({
    dispatcher: d,
    onChange: () => undefined,
    notify: (text, o) => void notices.push({ text, ...(o?.kind === undefined ? {} : { kind: o.kind }) }),
    now: () => nowMs,
    tick: () => () => undefined,
    store,
    ...(opts.answer === null
      ? {}
      : {
          askOrphan: async (m: string) => {
            asked.push(m);
            return opts.answer ?? true;
          },
        }),
  });
  return { service, store, asked, notices, appended, advance: (ms: number) => (nowMs += ms) };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('閉じられたタブの計測', () => {
  it('🔴 閉じた印から猶予がたつと聞き、入れると「始め〜閉じた時刻」の 1 行が本文に入る', async () => {
    const local = box();
    const first = tab(local, box(), { nowMs: T0 });
    first.service.start();
    first.advance(5 * 60_000);
    first.store.leave(); // pagehide
    const next = tab(local, box(), { nowMs: T0 + 5 * 60_000 + TIMER_LEFT_GRACE_MS + 1000 });
    await next.service.resumeOrphans();
    await settle();
    expect(next.asked).toHaveLength(1);
    expect(next.asked[0]).toContain('「資料」作業 2026-10-18 09:00–09:05(5:00)');
    expect(next.appended.join('\n'), '閉じた時刻までが入る').toContain('09:00–09:05(5:00)');
    // 拾ったら消える(次の起動で繰り返さない)
    const again = tab(local, box(), { nowMs: T0 + 3_600_000 });
    await again.service.resumeOrphans();
    expect(again.asked, '拾った記録をもう一度聞いた').toEqual([]);
  });

  it('🔴 「入れない」なら本文に入れず、字で言い、記録を消す', async () => {
    const local = box();
    const first = tab(local, box(), { nowMs: T0 });
    first.service.start();
    first.advance(60_000);
    first.store.leave();
    const next = tab(local, box(), { nowMs: T0 + 10 * 60_000, answer: false });
    await next.service.resumeOrphans();
    await settle();
    expect(next.appended).toEqual([]);
    expect(next.notices.at(-1)).toEqual({ text: '「資料」の計測(作業 2026-10-18 09:00–09:01(1:00))は、本文に入れていません', kind: 'caution' });
    const again = tab(local, box(), { nowMs: T0 + 3_600_000 });
    await again.service.resumeOrphans();
    expect(again.asked).toEqual([]);
  });

  it('🔴 いま動いている他のタブ(印が新しい・閉じた印なし)は拾わない', async () => {
    const local = box();
    const first = tab(local, box(), { nowMs: T0 });
    first.service.start();
    const next = tab(local, box(), { nowMs: T0 + TIMER_STALE_MS - 1000 });
    await next.service.resumeOrphans();
    expect(next.asked, '動いているタブの計測を拾った').toEqual([]);
  });

  it('動いている印が止まって久しければ、閉じた印が無くても拾う(終わりは最後に動いていた時刻)', async () => {
    const local = box();
    const first = tab(local, box(), { nowMs: T0 });
    first.service.start();
    first.advance(2 * 60_000);
    first.store.beat(true);
    const next = tab(local, box(), { nowMs: T0 + 2 * 60_000 + TIMER_STALE_MS + 1000 });
    await next.service.resumeOrphans();
    await settle();
    expect(next.asked[0]).toContain('09:00–09:02(2:00)');
    expect(next.appended.join('\n')).toContain('09:00–09:02(2:00)');
  });

  it('🔴 同じタブの読み直しは拾わず、続けて計る(閉じた印は打ち消される)', async () => {
    const local = box();
    const session = box();
    const first = tab(local, session, { nowMs: T0 });
    first.service.start();
    first.store.leave();
    const reopened = tab(local, session, { nowMs: T0 + 60_000 });
    reopened.service.resume();
    await reopened.service.resumeOrphans();
    expect(reopened.asked, '読み直しただけなのに聞いた').toEqual([]);
    expect(reopened.service.runs()).toHaveLength(1);
    // 別のタブから見ても、もう「閉じた」ではない
    const other = tab(local, box(), { nowMs: T0 + 60_000 + TIMER_LEFT_GRACE_MS + 1000 });
    await other.service.resumeOrphans();
    expect(other.asked, '続けて計っているタブの分を拾った').toEqual([]);
  });

  it('止めたタブの記録は、閉じても残らない(止めた分を後から聞かない)', async () => {
    const local = box();
    const first = tab(local, box(), { nowMs: T0 });
    first.service.start();
    first.service.stop('a');
    first.store.leave();
    const next = tab(local, box(), { nowMs: T0 + 3_600_000 });
    await next.service.resumeOrphans();
    expect(next.asked).toEqual([]);
  });

  it('聞く口が無いときは何もせず、記録を消さない', async () => {
    const local = box();
    const first = tab(local, box(), { nowMs: T0 });
    first.service.start();
    first.store.leave();
    const quiet = tab(local, box(), { nowMs: T0 + 3_600_000, answer: null });
    await quiet.service.resumeOrphans();
    const later = tab(local, box(), { nowMs: T0 + 3_700_000 });
    await later.service.resumeOrphans();
    expect(later.asked, '記録が消えていた').toHaveLength(1);
  });
});
