/** @vitest-environment happy-dom */
/**
 * P8 段㉔: 🔴 **開いたアプリの blob を早く殺さない**。
 *
 * 🔴 直す前は `closed` の poll と**並べて** `pagehide` でも resolve していた。
 * `pagehide` は本当の unload だけでなく **bfcache へ入るときにも発火する**
 * (`persisted === true`)ので、PKC3 のタブで前のページへ戻る / 別サイトへ移る
 * だけで、**まだ開いているアプリタブの blob URL が revoke され**、そのタブを
 * 再読込すると `net::ERR_FILE_NOT_FOUND` で真っ白になる。
 * ⚠ 初版が「1 秒後に revoke」で必ず死んでいたのと**同じ症状が別の入口から
 * 戻っていた**。
 *
 * ⚠ しかも**買っているものが無い** ── 本当に document が捨てられるなら、
 * blob も interval もどのみち道連れになる。解いても解かなくても結果は同じで、
 * bfcache のときだけ害になる 1 行だった。
 *
 * 🔑 この file が在るのは「**測れるようにするため**」── `main.ts` の中に居た
 * ときは誰も test できず、変異試験でこの 1 行が生き残った。
 */
import { describe, expect, it, vi } from 'vitest';
import { waitForWindowClose } from '../../src/adapter/platform/window-close';

/** 手で進められる時計(実時間を待たない)。 */
function fakeClock() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (fn: () => void): unknown => {
      timers.set(next, fn);
      return next++;
    },
    clearTimer: (h: unknown): void => void timers.delete(h as number),
    tick: (): void => {
      for (const fn of [...timers.values()]) fn();
    },
    get live(): number {
      return timers.size;
    },
  };
}

describe('開いた window の寿命', () => {
  it('⚠ 閉じたら解ける(空振り防止 ── 常に解けない実装でも下は通る)', async () => {
    const clock = fakeClock();
    const win = { closed: false };
    let done = false;
    void waitForWindowClose(win, clock).then(() => (done = true));
    clock.tick();
    await Promise.resolve();
    expect(done, 'まだ開いているのに解けた').toBe(false);

    win.closed = true;
    clock.tick();
    await Promise.resolve();
    expect(done, '閉じても解けない').toBe(true);
    expect(clock.live, 'timer が残っている').toBe(0);
  });

  /**
   * 🔴 **本丸** ── `pagehide` では解けないこと。
   * ⚠ 観測点は「listener を張っていないか」ではなく「**撃っても解けないか**」
   *   (張り方を変えれば通る形にしない)。
   */
  it('🔴 `pagehide` が来ても解けない(bfcache で早殺ししない)', async () => {
    const clock = fakeClock();
    const win = { closed: false };
    let done = false;
    void waitForWindowClose(win, clock).then(() => (done = true));

    // bfcache へ入るときの形(persisted = true)と、素の pagehide の両方
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    await Promise.resolve();
    expect(done, 'pagehide で blob の寿命を切っている').toBe(false);

    // 戻ってきて、その後ちゃんと閉じれば解ける
    win.closed = true;
    clock.tick();
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('⚠ 既定でも `pagehide` を購読しない(時計を差さない経路も同じ)', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    void waitForWindowClose({ closed: true }, fakeClock());
    const events = spy.mock.calls.map((c) => c[0]);
    expect(events, 'pagehide を購読している').not.toContain('pagehide');
    spy.mockRestore();
  });
});
