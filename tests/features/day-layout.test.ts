import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { itemOfCard, type AgendaItem } from '../../src/features/schedule/agenda';
import {
  DAY_MINUTES,
  createSlot,
  dayHeading,
  doubleClickSlot,
  deltaMinutes,
  formatMinutes,
  formatTimeRange,
  minutesFromOffset,
  moveSlot,
  resizeSlot,
  snapMinutes,
  initialScrollMinutes,
  minutesOf,
  pieceOf,
  placeColumns,
  MIN_SLOT_MINUTES,
  splitDay,
  type DayPiece,
} from '../../src/features/schedule/day-layout';

const item = (
  key: string,
  time: string | null,
  timeEnd: string | null = null,
  over: Partial<AgendaItem> = {},
): AgendaItem => ({
  ...itemOfCard({
    lid: 'e1',
    line: 0,
    text: key,
    done: false,
    date: '2026-08-23',
    time,
    timeEnd,
    until: null,
    repeat: null,
    substitutes: null,
  }),
  key,
  ...over,
});

const p = (key: string, a: string, b: string | null): DayPiece => pieceOf(key, a, b)!;

describe('時刻を分にする', () => {
  it('HH:MM を 0 時からの分にする', () => {
    expect(minutesOf('00:00')).toBe(0);
    expect(minutesOf('14:30')).toBe(14 * 60 + 30);
    expect(minutesOf('24:00')).toBe(DAY_MINUTES);
  });

  it('読めない字は null / 記法が通す 25:99 は目盛りの外へ出さない', () => {
    expect(minutesOf('9:00')).toBeNull();
    expect(minutesOf('abc')).toBeNull();
    expect(minutesOf('25:99')).toBe(DAY_MINUTES);
    expect(minutesOf('10:99')).toBe(10 * 60 + 59);
  });
});

describe('目盛りの上の幅(pieceOf)', () => {
  it('14:00..15:00 は 14:00 から 15:00', () => {
    expect(pieceOf('a', '14:00', '15:00')).toEqual({ key: 'a', startMin: 840, endMin: 900 });
  });

  it('幅のない時刻は 30 分', () => {
    expect(pieceOf('a', '14:00', null)).toEqual({ key: 'a', startMin: 840, endMin: 870 });
  });

  it('幅が 0 の記法(14:00..14:00)も 30 分 ── 消さない', () => {
    expect(pieceOf('a', '14:00', '14:00')).toEqual({ key: 'a', startMin: 840, endMin: 870 });
  });

  it('24:00 で切る(23:50 の 30 分は 24:00 まで / 終わりが 25:00 でも 24:00)', () => {
    expect(pieceOf('a', '23:50', null)!.endMin).toBe(DAY_MINUTES);
    expect(pieceOf('a', '23:00', '25:00')!.endMin).toBe(DAY_MINUTES);
  });

  it('始まりが 24:00 以降でも黙って消さず、最後の 30 分に寄せる', () => {
    expect(pieceOf('a', '24:00', null)).toEqual({
      key: 'a',
      startMin: DAY_MINUTES - 30,
      endMin: DAY_MINUTES,
    });
  });

  it('時刻なし・読めない時刻は null(終日)', () => {
    expect(pieceOf('a', null, null)).toBeNull();
    expect(pieceOf('a', 'xx', null)).toBeNull();
  });
});

describe('終日と目盛りを分ける(splitDay)', () => {
  it('時刻なし・期間・ノート 1 件の予定は終日 / 時刻ありは目盛り', () => {
    const timed = item('t', '14:00', '15:00');
    const noTime = item('n', null);
    const range = item('r', '10:00', null, { until: '2026-08-25' });
    const wholeNote = item('w', null, null, { line: null });
    const r = splitDay([timed, noTime, range, wholeNote]);
    expect(r.timed.map((x) => x.item.key)).toEqual(['t']);
    expect(r.allDay.map((x) => x.key)).toEqual(['n', 'r', 'w']);
  });
});

describe('重なる予定を横に並べる(placeColumns)', () => {
  const byKey = (slots: ReturnType<typeof placeColumns>) =>
    Object.fromEntries(slots.map((s) => [s.key, [s.col, s.cols]]));

  it('重ならなければ全員が 1 列', () => {
    const r = placeColumns([p('a', '09:00', '10:00'), p('b', '11:00', '12:00')]);
    expect(byKey(r)).toEqual({ a: [0, 1], b: [0, 1] });
  });

  it('🔴 接しているだけ(14:00..15:00 と 15:00..16:00)は重なりではない ── 同じ列', () => {
    const r = placeColumns([p('a', '14:00', '15:00'), p('b', '15:00', '16:00')]);
    expect(byKey(r)).toEqual({ a: [0, 1], b: [0, 1] });
  });

  it('🔴 30 分未満の予定は、描く高さ(30 分)で重なりを判定する ── 15 分の 2 件が上下に覆い合わない', () => {
    const r = placeColumns([p('a', '14:00', '14:15'), p('b', '14:15', '14:30')]);
    expect(byKey(r), '15 分の 2 件が同じ列に入り、1 件目の札が 2 件目を覆う').toEqual({
      a: [0, 2],
      b: [1, 2],
    });
    // 返す長さは実際の分のまま(高さを決めるのは CSS の最低の高さ)
    expect(r.find((x) => x.key === 'a')!.endMin).toBe(14 * 60 + 15);
    expect(MIN_SLOT_MINUTES).toBe(30);
  });

  it('重なれば横に分け、幅は 1/列数', () => {
    const r = placeColumns([p('a', '14:00', '15:30'), p('b', '15:00', '16:00')]);
    expect(byKey(r)).toEqual({ a: [0, 2], b: [1, 2] });
  });

  it('連鎖して重なる塊は、全員が同じ列数を持つ(a-b, b-c は重なり a-c は離れている)', () => {
    const r = placeColumns([
      p('a', '09:00', '10:00'),
      p('b', '09:30', '11:00'),
      p('c', '10:00', '11:30'),
    ]);
    // c は a が終わった列(0)へ入る ── 塊の列は 2
    expect(byKey(r)).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2] });
  });

  it('塊が違えば列の数も違う(混んだ時間帯が、離れた予定を細くしない)', () => {
    const r = placeColumns([
      p('a', '09:00', '10:00'),
      p('b', '09:00', '10:00'),
      p('c', '09:00', '10:00'),
      p('d', '13:00', '14:00'),
    ]);
    expect(byKey(r)).toEqual({ a: [0, 3], b: [1, 3], c: [2, 3], d: [0, 1] });
  });

  it('始まりが同じなら長いほうを先に置く / 渡された順でも結果が変わらない', () => {
    const long = p('long', '09:00', '12:00');
    const short = p('short', '09:00', '10:00');
    expect(byKey(placeColumns([short, long]))).toEqual({ long: [0, 2], short: [1, 2] });
    expect(byKey(placeColumns([long, short]))).toEqual({ long: [0, 2], short: [1, 2] });
  });

  it('空は空', () => {
    expect(placeColumns([])).toEqual([]);
  });
});

describe('描く最低の長さと CSS の最低の高さが同じ値', () => {
  it('🔴 MIN_SLOT_MINUTES = 札の最低の高さ(1 時間の半分)── 片方だけ動くと、重なりの判定と見た目が食い違う', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8');
    const tokens = readFileSync('src/styles/tokens.css', 'utf-8');
    const rule = /\[data-pkc-field='schedule-day-lane'\] > \[data-pkc-entry\] \{([^}]*)\}/.exec(css);
    expect(rule, '目盛りの札の規則が見つからない').not.toBeNull();
    const h = /height:\s*max\(calc\(var\(--day-hour\) \/ (\d+)\)/.exec(rule![1]!);
    expect(h, '最低の高さが「1 時間の 1/N」の形でない').not.toBeNull();
    const hour = /--day-hour:\s*(\d+)px/.exec(tokens);
    expect(hour, '--day-hour が見つからない').not.toBeNull();
    expect(60 / Number(h![1])).toBe(MIN_SLOT_MINUTES);
  });
});

describe('最初に見せる位置', () => {
  it('予定が無ければ 8:00 / あれば最初の予定の 1 時間前', () => {
    expect(initialScrollMinutes([])).toBe(480);
    expect(initialScrollMinutes([p('a', '14:00', '15:00'), p('b', '10:30', null)])).toBe(570);
  });

  it('朝の予定は 0 より上へ行かない', () => {
    expect(initialScrollMinutes([p('a', '00:30', '01:00')])).toBe(0);
  });
});

describe('見出しの字', () => {
  it('10月10日(土) / 今日と明日は添える', () => {
    expect(dayHeading('2026-10-10', '2026-10-10', '2026-10-11')).toBe('10月10日(土) 今日');
    expect(dayHeading('2026-10-11', '2026-10-10', '2026-10-11')).toBe('10月11日(日) 明日');
    expect(dayHeading('2026-10-12', '2026-10-10', '2026-10-11')).toBe('10月12日(月)');
  });

  it('今年でなければ年も出す / 実在しない日は寄せずそのまま', () => {
    expect(dayHeading('2027-01-05', '2026-10-10', '2026-10-11')).toBe('2027年1月5日(火)');
    expect(dayHeading('2026-02-30', '2026-10-10', '2026-10-11')).toBe('2026-02-30');
  });
});

/**
 * 🔴 **目盛りの上で札を動かす計算**(#855 段 B-1)。pure なので、ここで端を総当たりする
 * (画面での掴み方は `tests/adapter/schedule-grid-drag.test.ts`)。
 */
describe('目盛りの上で札を動かす計算(#855 段 B-1)', () => {
  it('🔴 15 分刻みに丸める(近いほう)', () => {
    expect(snapMinutes(0)).toBe(0);
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(8)).toBe(15);
    expect(snapMinutes(14 * 60 + 22)).toBe(14 * 60 + 15);
    expect(snapMinutes(14 * 60 + 23)).toBe(14 * 60 + 30);
  });

  it('距離(px)を分にする ── 1 時間 40px なら 20px は 30 分 / 器の高さが無ければ 0', () => {
    expect(minutesFromOffset(560, 960)).toBe(14 * 60);
    expect(minutesFromOffset(-5, 960)).toBe(0);
    expect(minutesFromOffset(5000, 960)).toBe(DAY_MINUTES);
    expect(minutesFromOffset(10, 0)).toBe(0);
    expect(deltaMinutes(20, 960)).toBe(30);
    expect(deltaMinutes(-80, 960)).toBe(-120);
    expect(deltaMinutes(20, 0)).toBe(0);
  });

  it('時刻の字(24:00 は 24:00)', () => {
    expect(formatMinutes(0)).toBe('00:00');
    expect(formatMinutes(14 * 60 + 5)).toBe('14:05');
    expect(formatMinutes(DAY_MINUTES)).toBe('24:00');
    expect(formatMinutes(DAY_MINUTES + 30)).toBe('24:00');
    expect(formatMinutes(-5)).toBe('00:00');
  });

  it('🔴 動かすと始まりが 15 分刻みになり、長さは保たれる', () => {
    // 14:00..15:00 を 2 時間 7 分下へ → 16:07 ではなく 16:00(近い刻み)
    expect(moveSlot(14 * 60, 15 * 60, 127)).toEqual({ startMin: 16 * 60, endMin: 17 * 60 });
    // 14:00..15:00 を 1 時間 23 分下へ → 15:23 → 15:30
    expect(moveSlot(14 * 60, 15 * 60, 83)).toEqual({ startMin: 15 * 60 + 30, endMin: 16 * 60 + 30 });
    // 90 分の札は 90 分のまま
    const m = moveSlot(9 * 60, 10 * 60 + 30, 61);
    expect(m.endMin - m.startMin).toBe(90);
    expect(m).toEqual({ startMin: 10 * 60, endMin: 11 * 60 + 30 });
  });

  it('🔴 日の内側に収める ── 上は 0:00 / 下は終わりが 24:00 になるところまで(長さを保つ)', () => {
    expect(moveSlot(1 * 60, 2 * 60, -600)).toEqual({ startMin: 0, endMin: 60 });
    expect(moveSlot(22 * 60, 23 * 60, 600)).toEqual({ startMin: 23 * 60, endMin: 24 * 60 });
    const long = moveSlot(10 * 60, 13 * 60, 900);
    expect(long).toEqual({ startMin: 21 * 60, endMin: 24 * 60 });
  });

  it('🔴 縁を引くと終わりだけが 15 分刻みで動く / 最低 15 分 / 24:00 まで', () => {
    expect(resizeSlot(14 * 60, 15 * 60 + 40)).toBe(15 * 60 + 45);
    // 始まりより手前・同じ位置まで引いても 15 分は残る
    expect(resizeSlot(14 * 60, 13 * 60)).toBe(14 * 60 + 15);
    expect(resizeSlot(14 * 60, 14 * 60)).toBe(14 * 60 + 15);
    expect(resizeSlot(14 * 60, 14 * 60 + 5)).toBe(14 * 60 + 15);
    // 24:00 を越えない
    expect(resizeSlot(23 * 60, 5000)).toBe(DAY_MINUTES);
    // 終わりの無い札(目盛りには 30 分で描く)でも、始まりを基準に伸ばせる
    const p = pieceOf('k', '14:00', null)!;
    expect(resizeSlot(p.startMin, 15 * 60 + 30)).toBe(15 * 60 + 30);
  });

  it('動かしている間の字は札と同じ 〜 区切り', () => {
    expect(formatTimeRange(14 * 60 + 15, 15 * 60 + 15)).toBe('14:15〜15:15');
    expect(formatTimeRange(23 * 60, DAY_MINUTES)).toBe('23:00〜24:00');
  });
});

describe('空いた所をドラッグして作る計算(#855 段 B-2)', () => {
  const H = 960; // 1 時間 40px
  const px = (min: number): number => (min / 60) * 40;

  it('🔴 両端を 15 分刻みに丸める(近いほう)── 丸めないと 10:07〜11:23 になる', () => {
    expect(createSlot(px(607), px(683), H)).toEqual({ startMin: 600, endMin: 690 });
  });

  it('🔴 上へドラッグしたら始まりと終わりを入れ替える', () => {
    expect(createSlot(px(690), px(600), H)).toEqual({ startMin: 600, endMin: 690 });
  });

  it('🔴 最低 15 分 ── 動かさなくても、少し動かしても、15 分の枠になる', () => {
    expect(createSlot(px(600), px(600), H)).toEqual({ startMin: 600, endMin: 615 });
    expect(createSlot(px(600), px(604), H)).toEqual({ startMin: 600, endMin: 615 });
    expect(createSlot(px(604), px(600), H)).toEqual({ startMin: 600, endMin: 615 });
  });

  it('🔴 0:00〜24:00 の内側に収める(上にも下にもはみ出さない)', () => {
    expect(createSlot(px(60), -500, H)).toEqual({ startMin: 0, endMin: 60 });
    expect(createSlot(px(1380), 5000, H)).toEqual({ startMin: 1380, endMin: DAY_MINUTES });
    // 最後の 15 分でも 15 分の枠が残る(終わりが 24:00 を越えない)
    expect(createSlot(px(1435), px(1440), H)).toEqual({ startMin: 1425, endMin: DAY_MINUTES });
    expect(createSlot(5000, 5000, H)).toEqual({ startMin: 1425, endMin: DAY_MINUTES });
  });

  it('器の高さが無ければ落ちない(0:00〜0:15)', () => {
    expect(createSlot(10, 50, 0)).toEqual({ startMin: 0, endMin: 15 });
  });

  it('🔴 ダブルクリックは 30 分 ── 押した所を 15 分刻みに丸めた始まり / 夜遅くは始まりを寄せる', () => {
    expect(doubleClickSlot(px(14 * 60 + 10), H)).toEqual({ startMin: 14 * 60 + 15, endMin: 14 * 60 + 45 });
    expect(doubleClickSlot(px(14 * 60 + 5), H)).toEqual({ startMin: 14 * 60, endMin: 14 * 60 + 30 });
    expect(doubleClickSlot(px(1439), H)).toEqual({ startMin: 1410, endMin: DAY_MINUTES });
    expect(doubleClickSlot(-10, H)).toEqual({ startMin: 0, endMin: 30 });
  });
});
