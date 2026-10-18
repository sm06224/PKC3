/** @vitest-environment happy-dom */
/**
 * 🔴 **時間を計っている途中でリロードしたとき、続きから計れる**(台帳 #1852 束 O1 / 依頼 240。Gemini 回答 = 推薦どおり「要る」)。
 *
 * 直す前: 時間を計っている途中でタブを閉じたりリロードしたりすると、計っていた時間は消え、本文にも何も入らなかった。
 *
 * 守る主張:
 *  1. 始めた時刻を端末に控え、同じタブを開き直したら、始めた時刻から続けて計る(経過は今の時刻との差)
 *  2. 止めた / 捨てたら控えを消す(次に開き直したとき、止めた計測が復活しない)
 *  3. 続きを計るのは控えたタブだけ(別のタブを開いただけで同じ計測が 2 本走らない)
 *  4. ノートが消えていた・追記できない種類になっていたら、続けずに理由を言う(計った時間が黙って消えない)
 *  5. 控えが読めない・書けない端末では、これまでどおり動く(落ちない)
 *  6. 古すぎる控えは捨てる / 壊れた控えは空として読む
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { createTimerService } from '../../src/adapter/ui/actions/timer';
import { TIMER_KEEP_MS, TimerRunStore } from '../../src/adapter/ui/render/timer-resume';

function meta(lid: string, archetype: string, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const T0 = new Date(2026, 9, 18, 9, 0, 0).getTime();

/** 端末の保存(localStorage / sessionStorage の代わり)。 */
function box(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

/** 1 つのタブ(= 1 つの Dispatcher と 1 つの service)。保存は引数で共有する。 */
function tab(
  local: ReturnType<typeof box> | null,
  session: ReturnType<typeof box> | null,
  opts: { nowMs?: number; metas?: EntryMeta[] } = {},
) {
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: opts.metas ?? [meta('a', 'text', '資料'), meta('b', 'text', '別のノート')],
    relations: [],
  });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
  let nowMs = opts.nowMs ?? T0;
  const notices: Array<{ text: string; kind?: string }> = [];
  const store = new TimerRunStore(local, session, () => nowMs);
  const service = createTimerService({
    dispatcher: d,
    onChange: () => undefined,
    notify: (text, o) => void notices.push({ text, ...(o?.kind === undefined ? {} : { kind: o.kind }) }),
    now: () => nowMs,
    tick: () => () => undefined,
    store,
  });
  return { d, service, store, notices, advance: (ms: number) => (nowMs += ms) };
}

describe('1. 同じタブを開き直したら、始めた時刻から続けて計る', () => {
  it('🔴 始めた時刻・ノート・題名が控えられ、開き直した service が同じ計測を持つ', () => {
    const local = box();
    const session = box();
    const before = tab(local, session);
    before.service.start();
    expect(before.service.runs()).toEqual([{ lid: 'a', title: '資料', startedAtMs: T0 }]);

    // 15 分後にリロード(新しい Dispatcher と service。保存は同じ)
    const after = tab(local, session, { nowMs: T0 + 15 * 60_000 });
    expect(after.service.runs(), '開き直した直後は、まだ計っていない(続ける前)').toEqual([]);
    after.service.resume();
    expect(after.service.runs(), '続きを計っていない').toEqual([{ lid: 'a', title: '資料', startedAtMs: T0 }]);
    expect(after.notices.at(-1)!.text, '続けていることを言っていない').toBe('「資料」の計測を続けています(15:00 経過)');
  });

  it('🔴 続きを計ったあと止めると、始めた時刻から止めた時刻までが本文に入る(リロードで短くならない)', async () => {
    const local = box();
    const session = box();
    tab(local, session).service.start();
    const after = tab(local, session, { nowMs: T0 + 10 * 60_000 });
    const appended: string[] = [];
    after.d.onEvent((e) => {
      if (e.type === 'REQUEST_APPEND') {
        appended.push(e.text);
        const { lid, gen } = e;
        queueMicrotask(() =>
          after.d.dispatch({ type: 'ENTRY_APPENDED', lid, gen, body: '本文', status: null, date: null, archived: false, inserted: null }),
        );
      }
    });
    after.service.resume();
    after.advance(5 * 60_000);
    after.service.stop('a');
    await new Promise((r) => setTimeout(r, 0));
    expect(appended.join('\n')).toContain('09:00–09:15(15:00)');
  });
});

describe('2. 止めた / 捨てたら控えを消す', () => {
  it('🔴 止めた計測は、開き直しても復活しない', () => {
    const local = box();
    const session = box();
    const t = tab(local, session);
    t.service.start();
    t.service.stop('a');
    const after = tab(local, session, { nowMs: T0 + 60_000 });
    after.service.resume();
    expect(after.service.runs(), '止めた計測が復活した').toEqual([]);
  });

  it('🔴 捨てた計測も復活しない', () => {
    const local = box();
    const session = box();
    const t = tab(local, session);
    t.service.start();
    t.service.discard('a');
    const after = tab(local, session, { nowMs: T0 + 60_000 });
    after.service.resume();
    expect(after.service.runs()).toEqual([]);
  });
});

describe('3. 続きを計るのは、控えたタブだけ', () => {
  it('🔴 別のタブ(別の sessionStorage)を開いても、同じ計測は走らない', () => {
    const local = box();
    const first = tab(local, box());
    first.service.start();
    const other = tab(local, box(), { nowMs: T0 + 60_000 });
    other.service.resume();
    expect(other.service.runs(), '別のタブで同じ計測が 2 本走る(止めると行が 2 つ入る)').toEqual([]);
    // 控えたタブがリロードすれば続けられる(別のタブの存在に邪魔されない)
  });
});

describe('4. 続けられない控えは、理由を言う', () => {
  it('🔴 ノートが消えていたら、続けずに「見つからない」と経過を言う(注意)', () => {
    const local = box();
    const session = box();
    tab(local, session).service.start();
    const after = tab(local, session, { nowMs: T0 + 30 * 60_000, metas: [meta('b', 'text', '別のノート')] });
    after.service.resume();
    expect(after.service.runs()).toEqual([]);
    const said = after.notices.at(-1)!;
    expect(said.text).toBe('「資料」が見つからないので、控えてあった計測は続けていません(30:00 経過していました)');
    expect(said.kind, '失われる時間なので注意として残す').toBe('caution');
  });

  it('追記できない種類(フォルダ)になっていても、続けず理由を言う', () => {
    const local = box();
    const session = box();
    tab(local, session).service.start();
    const after = tab(local, session, { nowMs: T0 + 60_000, metas: [meta('a', 'folder', '資料')] });
    after.service.resume();
    expect(after.service.runs()).toEqual([]);
    expect(after.notices.at(-1)!.text).toContain('続けていません');
  });

  it('続けられなかった控えは捨てる(次に開き直したとき、同じ知らせを繰り返さない)', () => {
    const local = box();
    const session = box();
    tab(local, session).service.start();
    tab(local, session, { nowMs: T0 + 60_000, metas: [meta('b', 'text', 'x')] }).service.resume();
    const again = tab(local, session, { nowMs: T0 + 120_000 });
    again.service.resume();
    expect(again.service.runs()).toEqual([]);
    expect(again.notices, '同じ知らせが繰り返された').toEqual([]);
  });
});

describe('5〜6. 控えの壊れ方', () => {
  it('🔴 保存が使えない端末(null)でも、始める・止めるは落ちず、この session では動く', () => {
    const t = tab(null, null);
    expect(() => t.service.start()).not.toThrow();
    expect(t.service.runs()).toHaveLength(1);
    expect(() => t.service.resume()).not.toThrow();
    expect(() => t.service.stop('a')).not.toThrow();
  });

  it('🔴 書くと落ちる保存でも、始められる(書けないだけ)', () => {
    const local = { getItem: () => null, setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); } };
    const t = tab(local as never, box());
    expect(() => t.service.start()).not.toThrow();
    expect(t.service.runs()).toHaveLength(1);
  });

  it('壊れた控え(JSON でない・配列・形が違う)は空として読む', () => {
    for (const raw of ['{', '[]', '"x"', '{"t":[{"lid":1}]}', '{"t":"x"}']) {
      const local = box();
      local.data.set('pkc3.timer-runs', raw);
      const t = tab(local, box());
      t.service.resume();
      expect(t.service.runs(), raw).toEqual([]);
    }
  });

  it(`🔴 ${String(TIMER_KEEP_MS / 86_400_000)} 日より古い控えは読まない(閉じたタブの分が溜まらない)`, () => {
    const local = box();
    const session = box();
    const first = tab(local, session, { nowMs: T0 });
    first.service.start();
    const stale = new TimerRunStore(local, session, () => T0 + TIMER_KEEP_MS + 1);
    expect(stale.read(), '古い控えを読んだ').toEqual([]);
    const fresh = new TimerRunStore(local, session, () => T0 + TIMER_KEEP_MS - 1);
    expect(fresh.read(), '期限内の控えが読めない').toHaveLength(1);
  });

  it('別のタブの控えは、自分が書いても消さない', () => {
    const local = box();
    const a = new TimerRunStore(local, box(), () => T0);
    const b = new TimerRunStore(local, box(), () => T0);
    a.write([{ lid: 'a', title: '資料', startedAtMs: T0 }]);
    b.write([{ lid: 'b', title: '別', startedAtMs: T0 }]);
    expect(a.read().map((r) => r.lid)).toEqual(['a']);
    expect(b.read().map((r) => r.lid)).toEqual(['b']);
    b.write([]);
    expect(a.read().map((r) => r.lid), '別のタブが空にしたとき、こちらの控えまで消えた').toEqual(['a']);
  });
});
