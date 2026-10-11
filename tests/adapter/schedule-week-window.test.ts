/** @vitest-environment happy-dom */
/**
 * 🔴 **同じ週のウィンドウは 2 枚作らない ── 開いているなら前に出す / 窓の中では左の「週」を隠す**
 * (#855。Gemini 裁定 = #1163 のコメント 6104130726 の 3・4)。
 *
 * 実体: `src/adapter/platform/schedule-deep-link.ts`(`openOrRaiseWeekWindow` / `weekWindowKey`)、
 * 台帳は付箋と同じ `note-window-registry.ts`、窓の印は `view-window.ts` の `markHeldView`。
 *
 * 🔑 台帳は**本物どうしを繋ぐ**(`note-window-registry.test.ts` と同じ作法 ── 片側だけの台で見ると
 *   綴りの食い違いが両方緑のまま通る)。間に立つ放送路は「そのまま流す通り道」。
 * ⚠ 「前に出る」が実機で手前に来るかは測れない(headless は `hasFocus` が真)── 見るのは
 *   **開いている窓へ「前に出て」が届くこと**と**新しい窓を開かないこと**まで。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WEEK_REPEAT_PRESS_MS,
  WEEK_WINDOW_ALREADY,
  openOrRaiseWeekWindow,
  resetWeekRaiseMemory,
  weekAnnounceKey,
  weekWindowKey,
} from '../../src/adapter/platform/schedule-deep-link';
import { createNoteRegistry } from '../../src/adapter/platform/note-window-registry';
import { HELD_VIEW_ATTR, markHeldView } from '../../src/adapter/platform/view-window';
import type { Broadcaster } from '../../src/adapter/platform/storage/store-proxy';

/** 自分には配らない放送路(本物の `BroadcastChannel` と同じ)。 */
function bus(): () => Broadcaster {
  const live: Broadcaster[] = [];
  return () => {
    const ch: Broadcaster = {
      onmessage: null,
      postMessage: (data) => {
        for (const other of [...live]) if (other !== ch) other.onmessage?.({ data } as MessageEvent);
      },
      close: () => {
        const i = live.indexOf(ch);
        if (i >= 0) live.splice(i, 1);
      },
    };
    live.push(ch);
    return ch;
  };
}

describe('weekWindowKey(台帳の鍵)', () => {
  it('同じ週なら、どの日でも同じ鍵(週の最初の日 = 日曜)', () => {
    expect(weekWindowKey('2026-10-07', '2026-10-01')).toBe('week 2026-10-04');
    expect(weekWindowKey('2026-10-04', '2026-10-01')).toBe('week 2026-10-04');
    expect(weekWindowKey('2026-10-10', '2026-10-01')).toBe('week 2026-10-04');
    expect(weekWindowKey('2026-10-11', '2026-10-01')).not.toBe('week 2026-10-04');
  });
  it('日が無い(今日に追従)なら今日の週 / 読めない日は null', () => {
    expect(weekWindowKey(null, '2026-10-01')).toBe('week 2026-09-27');
    expect(weekWindowKey('xxxx', '2026-10-01')).toBeNull();
  });
});

const clock = { t: 1_000 };
beforeEach(() => {
  clock.t = 1_000;
  resetWeekRaiseMemory();
});

describe('weekAnnounceKey(週の窓が名乗る条件)', () => {
  it('🔴 予定の窓で、広い面が「週」のときだけ名乗る', () => {
    expect(weekAnnounceKey('schedule', 'week', '2026-10-07', '2026-10-01')).toBe('week 2026-10-04');
    expect(weekAnnounceKey('schedule', 'day', '2026-10-07', '2026-10-01'), '日のときに週を名乗った').toBeNull();
    expect(weekAnnounceKey('schedule', 'list', null, '2026-10-01')).toBeNull();
    expect(weekAnnounceKey(null, 'week', '2026-10-07', '2026-10-01'), '予定の窓でないのに名乗った').toBeNull();
    expect(weekAnnounceKey('contacts', 'week', '2026-10-07', '2026-10-01')).toBeNull();
  });
});

describe('openOrRaiseWeekWindow(判断)', () => {
  const mk = (where: 'self' | 'other' | null) => {
    const calls: string[] = [];
    const deps = {
      key: 'week 2026-10-04' as string | null,
      whereIs: () => where,
      raise: (k: string) => calls.push(`raise ${k}`),
      reserve: (k: string) => calls.push(`reserve ${k}`),
      release: (k: string) => calls.push(`release ${k}`),
      open: vi.fn(() => Promise.resolve('window' as unknown)),
      notice: (m: string) => calls.push(`notice ${m}`),
      now: () => clock.t,
    };
    return { deps, calls };
  };

  it('🔴 別の窓が同じ週を出しているなら、開かずに「前に出て」と頼み、理由を言う', () => {
    const { deps, calls } = mk('other');
    expect(openOrRaiseWeekWindow(deps)).toBe('raised');
    expect(deps.open, '開いているのに 2 枚目を開いた').not.toHaveBeenCalled();
    expect(calls).toEqual(['raise week 2026-10-04', `notice ${WEEK_WINDOW_ALREADY}`]);
  });

  it('🔴 見つからないとき: 10 秒以内にもう一度押すと、新しく開く(行き止まりを作らない)', () => {
    const { deps, calls } = mk('other');
    expect(openOrRaiseWeekWindow(deps)).toBe('raised');
    clock.t += WEEK_REPEAT_PRESS_MS - 1;
    expect(openOrRaiseWeekWindow(deps)).toBe('opened');
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['raise week 2026-10-04', `notice ${WEEK_WINDOW_ALREADY}`, 'reserve week 2026-10-04']);
    // 3 度目はまた最初から(頼む)
    openOrRaiseWeekWindow(deps);
    expect(deps.open).toHaveBeenCalledTimes(1);
  });

  it('10 秒を過ぎた 2 度目は、また「前に出て」と頼む(間が空いたら別の押し方)', () => {
    const { deps } = mk('other');
    openOrRaiseWeekWindow(deps);
    clock.t += WEEK_REPEAT_PRESS_MS + 1;
    expect(openOrRaiseWeekWindow(deps)).toBe('raised');
    expect(deps.open).not.toHaveBeenCalled();
  });

  it('別の週の押下は、記憶を共有しない', () => {
    const a = mk('other');
    openOrRaiseWeekWindow(a.deps);
    const b = mk('other');
    expect(openOrRaiseWeekWindow({ ...b.deps, key: 'week 2026-10-11' })).toBe('raised');
  });

  it('字が次の一手を言う', () => {
    expect(WEEK_WINDOW_ALREADY).toBe(
      'この週は、すでに別のウィンドウで開いています(見つからないときは、もう一度押すと新しく開きます)',
    );
  });

  it('居なければ見込みを載せて開く(対照群)', () => {
    const { deps, calls } = mk(null);
    expect(openOrRaiseWeekWindow(deps)).toBe('opened');
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['reserve week 2026-10-04']);
  });

  it('開けなかったら見込みを外す(次の 1 押しで開けるように)', async () => {
    const { deps, calls } = mk(null);
    deps.open.mockReturnValue(Promise.resolve('pane'));
    openOrRaiseWeekWindow(deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['reserve week 2026-10-04', 'release week 2026-10-04']);
  });

  it('自分が出している週なら、前に出す相手が居ない(頼まず、開かず、理由だけ)', () => {
    const { deps, calls } = mk('self');
    expect(openOrRaiseWeekWindow(deps)).toBe('raised');
    expect(openOrRaiseWeekWindow(deps), '自分の週は何度押しても開かない').toBe('raised');
    expect(deps.open).not.toHaveBeenCalled();
    calls.splice(1);
    expect(calls).toEqual([`notice ${WEEK_WINDOW_ALREADY}`]);
  });

  it('鍵が読めない日でも窓は開く(台帳に載せずに)', () => {
    const { deps, calls } = mk(null);
    expect(openOrRaiseWeekWindow({ ...deps, key: null })).toBe('opened');
    expect(deps.open).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });
});

describe('🔴 本物の台帳どうし(週の窓と、押す側の窓)', () => {
  it('週の窓が名乗ると、別の窓の「週」は新しい窓を開かず、週の窓へ「前に出て」が届く', () => {
    const make = bus();
    let raised = 0;
    const weekWin = createNoteRegistry({ channel: make(), id: 'w', onRaise: () => (raised += 1) });
    const main = createNoteRegistry({ channel: make(), id: 'm', onRaise: () => undefined });
    const key = weekWindowKey('2026-10-07', '2026-10-01')!;
    weekWin.announce(key);
    const open = vi.fn(() => Promise.resolve('window' as unknown));
    const notices: string[] = [];
    // 同じ週の別の日で押しても同じ窓
    const out = openOrRaiseWeekWindow({
      key: weekWindowKey('2026-10-09', '2026-10-01'),
      whereIs: (k) => main.whereIs(k),
      raise: (k) => main.raise(k),
      reserve: (k) => main.reserve(k),
      release: (k) => main.release(k),
      open,
      notice: (m) => notices.push(m),
      now: () => clock.t,
    });
    expect(out).toBe('raised');
    expect(open).not.toHaveBeenCalled();
    expect(raised, '週の窓に「前に出て」が届いていない').toBe(1);
    expect(notices).toEqual([WEEK_WINDOW_ALREADY]);
  });

  it('対照群: 別の週なら窓が開く / 付箋の台帳(別の放送路)とは混ざらない', () => {
    const make = bus();
    const weekWin = createNoteRegistry({ channel: make(), id: 'w', onRaise: () => undefined });
    const main = createNoteRegistry({ channel: make(), id: 'm', onRaise: () => undefined });
    weekWin.announce(weekWindowKey('2026-10-07', '2026-10-01'));
    const open = vi.fn(() => Promise.resolve('window' as unknown));
    const out = openOrRaiseWeekWindow({
      key: weekWindowKey('2026-10-14', '2026-10-01'),
      whereIs: (k) => main.whereIs(k),
      raise: (k) => main.raise(k),
      reserve: (k) => main.reserve(k),
      release: (k) => main.release(k),
      open,
      notice: () => undefined,
      now: () => clock.t,
    });
    expect(out).toBe('opened');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('週の窓が閉じたら(便りが出る)また開ける', () => {
    const make = bus();
    const weekWin = createNoteRegistry({ channel: make(), id: 'w', onRaise: () => undefined });
    const main = createNoteRegistry({ channel: make(), id: 'm', onRaise: () => undefined });
    const key = weekWindowKey('2026-10-07', '2026-10-01')!;
    weekWin.announce(key);
    expect(main.whereIs(key)).toBe('other');
    weekWin.leave();
    expect(main.whereIs(key)).toBeNull();
  });
});

describe('markHeldView(窓の印 ── 窓の中で左の「週」を隠す CSS が読む)', () => {
  it('面を握っている窓には印が付き、離れたら外れる', () => {
    const el = document.createElement('html');
    markHeldView(el, 'schedule');
    expect(el.getAttribute(HELD_VIEW_ATTR)).toBe('schedule');
    markHeldView(el, null);
    expect(el.hasAttribute(HELD_VIEW_ATTR)).toBe(false);
  });
  it('印の綴りは CSS(app.css)が読む綴りと同じ', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/app.css', 'utf8');
    expect(css).toContain(`[${HELD_VIEW_ATTR}='schedule'] [data-pkc-browse-pane] [data-pkc-field='schedule-modes'] [data-pkc-mode='week']`);
  });
});

describe('main.ts の配線(どの unit からも実行されない ── 原文を pin する。弱いと自覚して使う)', () => {
  it('🔴 窓の印と週の名乗りの配線が在る(印を付け忘れる / 名乗りを外すと、窓の中の「週」が隠れず 2 枚目も止まらない)', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync('src/main.ts', 'utf8');
    const hold = main.indexOf('onHold: (view) => {');
    expect(hold, 'onHold が見つからない').toBeGreaterThan(-1);
    expect(main.slice(hold, hold + 400), 'onHold で窓の印を付けていない').toContain(
      'markHeldView(document.documentElement, view)',
    );
    const announce = main.indexOf('const announceWeek = (): void => {');
    expect(announce, 'announceWeek が見つからない').toBeGreaterThan(-1);
    expect(main.slice(announce, announce + 400)).toContain('weekAnnounceKey(heldViewWindow, st.scheduleMode');
    expect(main, '状態が動くたびに名乗っていない').toContain('announceWeek();');
  });
});
