/**
 * 🔴 **どの予定が「いま」来たか**(#280)。
 *
 * ⚠ ここが見るのは**採り方**だけ ── 鳴らすのは `alarm.ts`(adapter)。
 */
import { describe, expect, it } from 'vitest';
import {
  alarmAtMs,
  alarmBarLabel,
  alarmEntryText,
  alarmKey,
  dueAlarms,
} from '../../src/features/alarm/alarm-due';
import type { TaskCard } from '../../src/features/schedule/task-cards';

const card = (over: Partial<TaskCard> = {}): TaskCard =>
  ({
    lid: 'a',
    line: 3,
    text: '打ち合わせ',
    done: false,
    date: '2026-08-27',
    time: '14:00',
    until: null,
    repeat: null,
    ...over,
  }) as TaskCard;

const at = (h: number, m: number): number => new Date(2026, 7, 27, h, m, 0, 0).getTime();

describe('予定の時刻(#280)', () => {
  it('🔴 その端末の地方時で読む(UTC ではない)', () => {
    // ⚠ user が書いた `14:00` は**手元の 14 時**である
    expect(alarmAtMs('2026-08-27', '14:00')).toBe(at(14, 0));
  });

  it('🔴 形が違えば null(勝手に読み替えない)', () => {
    expect(alarmAtMs('2026-8-27', '14:00'), '桁の詰めが違う日付を通した').toBeNull();
    expect(alarmAtMs('2026-08-27', '9:00'), '桁の詰めが違う時刻を通した').toBeNull();
    expect(alarmAtMs('', '14:00')).toBeNull();
  });

  it('⚠ 実在しない日は通す(黙って消さない)', () => {
    // ⚠ `schedule-date.ts` の裁定と同じ向き ── 通せば画面に出て、user が直せる
    expect(alarmAtMs('2026-02-30', '09:00')).not.toBeNull();
  });
});

describe('区間で採る(#280)', () => {
  it('🔴 (前回, いま] に入ったものだけ返す', () => {
    const cards = [card()];
    expect(dueAlarms(cards, at(13, 59), at(14, 0)), '来たのに返さない').toHaveLength(1);
    expect(dueAlarms(cards, at(14, 0), at(14, 1)), '左端を 2 度目に返した').toHaveLength(0);
    expect(dueAlarms(cards, at(14, 1), at(14, 2)), '過ぎたものを返した').toHaveLength(0);
    expect(dueAlarms(cards, at(13, 0), at(13, 59)), 'まだ来ていない').toHaveLength(0);
  });

  it('🔴 間引かれて長く空いた回も取りこぼさない', () => {
    // ⚠ 背面のタブでは刻みが 1 分に 1 回まで間引かれる ── 「いまと同じ分か」で
    //    採る実装だと、**この回はまるごと鳴らない**
    expect(dueAlarms([card()], at(13, 0), at(15, 0))).toHaveLength(1);
  });

  it('🔴 済んだ項目では鳴らさない', () => {
    expect(dueAlarms([card({ done: true })], at(13, 59), at(14, 0))).toHaveLength(0);
  });

  it('🔴 時刻を書いていない予定では鳴らさない(その日であって、その時刻ではない)', () => {
    expect(dueAlarms([card({ time: null })], at(0, 0), at(23, 59))).toHaveLength(0);
    /**
     * ⚠ **空文字でも落ちること**を見る ── `time: null` だけだと、落としているのが
     *   **型を絞る行**なのか **形の判定(`alarmAtMs`)**なのかが区別できない
     *   (変異試験 A5 が教えた)。空文字は型としては通るので、
     *   ここを落とせるのは**形の判定だけ**である。
     */
    expect(dueAlarms([card({ time: '' })], at(0, 0), at(23, 59)), '形の判定が効いていない').toHaveLength(0);
  });

  it('⚠ 日付が読めない項目は落とす(落ちても本文はそのまま)', () => {
    expect(dueAlarms([card({ date: '2026-8-27' })], at(13, 59), at(14, 0))).toHaveLength(0);
  });

  it('🔴 同じ回に 2 件来たら、時刻の早い順', () => {
    const out = dueAlarms(
      [card({ line: 9, time: '14:30', text: '後' }), card({ line: 3, time: '14:00', text: '先' })],
      at(13, 0),
      at(15, 0),
    );
    expect(out.map((d) => d.text)).toEqual(['先', '後']);
  });

  it('🔴 鍵は日付と時刻まで含む(繰り返しは同じ行が何度も来る)', () => {
    const k1 = alarmKey({ lid: 'a', line: 3 }, '2026-08-27', '14:00');
    const k2 = alarmKey({ lid: 'a', line: 3 }, '2026-09-03', '14:00');
    expect(k1, '同じ行の別の日が同じ鍵になっている').not.toBe(k2);
  });
});

describe('帯の字(#280)', () => {
  it('🔴 時刻を先に出す(探すのは時刻である)', () => {
    expect(alarmEntryText({ key: 'k', lid: 'a', line: 3, text: '打ち合わせ', time: '14:00' })).toBe(
      '14:00 打ち合わせ',
    );
  });

  it('⚠ 件数を出す(1 件しか見えていないのか分かる)', () => {
    expect(alarmBarLabel(1)).toBe('時間になりました');
    expect(alarmBarLabel(2)).toBe('2 件 時間になりました');
  });
});
