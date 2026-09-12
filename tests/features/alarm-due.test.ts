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

describe('🔴 繰り返しの回が鳴る(2026-09-12 に直した)', () => {
  /**
   * 🔴 直す前は **開始日にしか鳴らなかった** ── 見張りが読むのは「規則の行」
   *   そのもので、回を展開していたのは**描画の 1 か所だけ**だった。
   * ⚠ しかも押して増えた実体の行は `- [x]` なので `done` で落ちる ──
   *   つまり **2 回目以降は 1 度も鳴らない**。
   */
  const weekly = card({ date: '2026-08-31', time: '14:00', repeat: 'week', text: '定例' });
  /** 2026-09-07(月)の 14:00 をまたぐ窓。⚠ 左は開区間なので 1 分前から。 */
  const win = (d: number, h: number, m: number): number =>
    new Date(2026, 8, d, h, m, 0, 0).getTime();

  it('🔴 2 回目(1 週間後)に鳴る', () => {
    const due = dueAlarms([weekly], win(7, 13, 59), win(7, 14, 0));
    expect(due).toHaveLength(1);
    // 🔑 鍵は**その回の日付**を含む(同じ行が何度も来るため)
    expect(due[0]!.key).toBe(alarmKey(weekly, '2026-09-07', '14:00'));
  });

  it('🔑 開始日そのものも、これまでどおり鳴る(対照群)', () => {
    const due = dueAlarms(
      [weekly],
      new Date(2026, 7, 31, 13, 59, 0, 0).getTime(),
      new Date(2026, 7, 31, 14, 0, 0, 0).getTime(),
    );
    expect(due).toHaveLength(1);
    expect(due[0]!.key).toBe(alarmKey(weekly, '2026-08-31', '14:00'));
  });

  it('⚠ 規則が出さない日には鳴らない(対照群 ── 毎日にしていない)', () => {
    // 2026-09-08 は火曜 ── 毎週(月)の回ではない
    expect(dueAlarms([weekly], win(8, 13, 59), win(8, 14, 0))).toEqual([]);
  });

  it('🔴 押して済ませた回は鳴らない(実体の行が在る日)', () => {
    // ⚠ 済んだ回は**同じノートの、同じ字の、繰り返しでない行**として本文に増える
    const mate = card({ date: '2026-09-07', time: '14:00', repeat: null, text: '定例', done: true });
    const due = dueAlarms([weekly, mate], win(7, 13, 59), win(7, 14, 0));
    expect(due).toEqual([]);
  });

  it('⚠ 繰り返しの終わりを過ぎたら鳴らない', () => {
    const ended = card({
      date: '2026-08-31',
      time: '14:00',
      repeat: 'week',
      until: '2026-09-01',
      text: '定例',
    });
    expect(dueAlarms([ended], win(7, 13, 59), win(7, 14, 0))).toEqual([]);
  });

  it('🔑 `毎日` の古い開始でも鳴る(展開の空回りを直した件と対)', () => {
    const old = card({ date: '2020-01-06', time: '09:00', repeat: 'day', text: '体操' });
    const due = dueAlarms([old], win(7, 8, 59), win(7, 9, 0));
    expect(due).toHaveLength(1);
    expect(due[0]!.key).toBe(alarmKey(old, '2026-09-07', '09:00'));
  });
});
