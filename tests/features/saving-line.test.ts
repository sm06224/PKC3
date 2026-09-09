/**
 * 🔴 **「保存中…」の出し入れ**(#828 ①)。
 *
 * ⚠ この test がいちばん見ているのは「**ふつうの保存では出ない**」ことである ──
 * 書込は打鍵の確定ごとに飛ぶので、素直に出すと**帯が点滅する**(雑音になる)。
 * 🔑 出るのは「読み直すと題名が戻る」ほど**実際に遅れている回**だけ。
 */
import { describe, expect, it } from 'vitest';
import { SAVING_DELAY_MS, SAVING_LINE, SavingIndicator } from '../../src/features/status/saving-line';

/** 手で進められる時計。⚠ 本物の `setTimeout` を使わない(待ちを test に持ち込まない)。 */
function fakeTimers() {
  let seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  return {
    now: () => now,
    pending: () => jobs.size,
    advance: (ms: number) => {
      now += ms;
      for (const [id, j] of [...jobs]) {
        if (j.at <= now) {
          jobs.delete(id);
          j.fn();
        }
      }
    },
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++seq;
        jobs.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (id: unknown) => void jobs.delete(id as number),
    },
  };
}

function setup() {
  const t = fakeTimers();
  let changes = 0;
  const ind = new SavingIndicator(() => (changes += 1), t.timers, SAVING_DELAY_MS);
  return { t, ind, changes: () => changes };
}

describe('「保存中…」の出し入れ(#828 ①)', () => {
  it('🔴 ふつうの保存(すぐ終わる)では、1 文字も出さない', () => {
    const { t, ind, changes } = setup();
    ind.setWriting(true);
    t.advance(50);
    ind.setWriting(false);
    t.advance(SAVING_DELAY_MS * 3);
    expect(ind.line(), '短い保存で帯が出た(打鍵のたびに点滅する)').toBe('');
    expect(changes(), '出ていないのに描き直しを頼んでいる').toBe(0);
    // ⚠ 予約を捨てていること(残ると、後から急に出る)
    expect(t.pending(), '予約が残っている').toBe(0);
  });

  it('🔴 遅れている回だけ出て、終わったら即座に消える', () => {
    const { t, ind, changes } = setup();
    ind.setWriting(true);
    t.advance(SAVING_DELAY_MS - 1);
    expect(ind.line(), '待ちより早く出た').toBe('');
    t.advance(1);
    expect(ind.line(), '遅れているのに出ていない').toBe(SAVING_LINE);
    expect(changes(), '出したのに描き直しを頼んでいない').toBe(1);

    ind.setWriting(false);
    // 🔴 **待たずに消す** ── 「消えたら書き終わり」がこの帯の約束である
    expect(ind.line(), '書き終わったのに残っている(約束が嘘になる)').toBe('');
    expect(changes()).toBe(2);
  });

  it('⚠ 書込が続いている間は、張り直さずに出したままにする', () => {
    const { t, ind, changes } = setup();
    ind.setWriting(true);
    t.advance(SAVING_DELAY_MS);
    expect(ind.line()).toBe(SAVING_LINE);
    // ⚠ 次の書込が始まっても、出ている帯は消さない(点滅させない)
    ind.setWriting(true);
    expect(ind.line(), '続けて書いている間に消えた(点滅する)').toBe(SAVING_LINE);
    expect(changes(), '出したままなのに描き直しを頼んだ').toBe(1);
    expect(t.pending(), '出しているのに予約まで張った').toBe(0);
  });

  it('🔴 出る前に終わって、また始まっても、予約は 1 本だけ', () => {
    const { t, ind } = setup();
    for (let i = 0; i < 5; i += 1) {
      ind.setWriting(true);
      t.advance(10);
      ind.setWriting(false);
    }
    expect(t.pending(), '予約が積み上がっている(止めても消えない帯が残る)').toBe(0);
    ind.setWriting(true);
    expect(t.pending(), '予約が 1 本ではない').toBe(1);
  });

  it('⚠ 字と待ちは 1 か所(綴りを 2 通り持たない)', () => {
    expect(SAVING_LINE, '何が起きているかを言っていない').toContain('保存');
    expect(SAVING_DELAY_MS, '待ちが 0 だと打鍵のたびに点滅する').toBeGreaterThan(100);
    expect(SAVING_DELAY_MS, '待ちが長すぎると、遅れている回でも出ない').toBeLessThan(1500);
  });
});
