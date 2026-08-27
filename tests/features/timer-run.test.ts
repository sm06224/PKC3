/**
 * 🔴 **タイマーが出す字**(#279)。
 *
 * ⚠ ここが見るのは **user が読む字**だけ ── 計るのは `timer.ts`(adapter)。
 * 🔑 純関数なので、「1 時間の計測」を**実時間 1 時間待たずに**確かめられる。
 */
import { describe, expect, it } from 'vitest';
import {
  timerBarLabel,
  timerEntryText,
  workLogLine,
  workLogText,
} from '../../src/features/timer/timer-run';

const RUN = { lid: 'a', title: '会議メモ', startedAtMs: 1_000_000 };

describe('帯の字(#279)', () => {
  it('🔴 相手の名前と経過が 1 行で読める', () => {
    expect(timerEntryText(RUN, 1_000_000 + 754_000)).toBe('会議メモ 12:34');
  });

  it('🔴 経過は「いま − 始めた時刻」で出す(刻みを数えない)', () => {
    // ⚠ **背面のタブでも狂わない**ための形(#279)── 間引かれても差分は正しい。
    //    刻みを数える実装なら、撃たれなかったぶんだけ短く出る
    expect(timerEntryText(RUN, 1_000_000 + 3_723_000)).toBe('会議メモ 1:02:03');
    expect(timerEntryText(RUN, 1_000_000), '始めた瞬間は 0:00').toBe('会議メモ 0:00');
  });

  it('⚠ 走っている本数を出す(1 本しか見えていないのか分かる)', () => {
    expect(timerBarLabel(1)).toBe('計っています');
    expect(timerBarLabel(3)).toBe('3 本 計っています');
  });
});

describe('本文へ入る 1 行(#279)', () => {
  const from = new Date(2026, 7, 27, 6, 40, 0);

  it('🔴 いつから・いつまで・どれだけ、が読める', () => {
    const to = new Date(2026, 7, 27, 7, 3, 11);
    expect(workLogText(from, to)).toBe('作業 2026-08-27 06:40–07:03(23:11)');
  });

  it('🔴 経過は帯と同じ綴り(丸めない)', () => {
    // ⚠ **「1 分未満」に潰さない** ── 作業時間は足し合わせる物なので、
    //    30 秒の計測が 2 本あっても合計が出せなくなる
    const to = new Date(2026, 7, 27, 6, 40, 30);
    expect(workLogText(from, to)).toContain('(0:30)');
  });

  it('🔴 日をまたいだら、終わりの側に日付が出る', () => {
    const to = new Date(2026, 7, 28, 1, 5, 0);
    // ⚠ 出さないと `23:40–01:05` になって、**翌日なのか前日なのか読めない**
    expect(workLogText(from, to)).toBe('作業 2026-08-27 06:40–2026-08-28 01:05(18:25:00)');
  });

  it('🔴 本文へ入るのは箇条書きの 1 行(字そのものは 1 本)', () => {
    const to = new Date(2026, 7, 27, 7, 3, 11);
    expect(workLogLine(from, to)).toBe(`- ${workLogText(from, to)}`);
  });
});
