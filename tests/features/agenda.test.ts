import { describe, expect, it } from 'vitest';
import { buildAgenda } from '../../src/features/schedule/agenda';
import type { TaskCard } from '../../src/features/kanban/kanban-data';

const card = (
  lid: string,
  line: number,
  date: string | null,
  time: string | null = null,
  text = 'x',
): TaskCard => ({ lid, line, text, done: false, date, time });

const TODAY = '2026-08-23'; // 日曜

describe('予定を日ごとに束ねる(#292 段③)', () => {
  it('日付の昇順に束ねる ── 期限切れは自然に先頭へ来る', () => {
    const g = buildAgenda(
      [
        card('a', 0, '2026-08-25'),
        card('b', 0, '2026-08-20'), // 期限切れ
        card('c', 0, TODAY),
      ],
      TODAY,
    );
    expect(g.map((x) => x.date)).toEqual(['2026-08-20', '2026-08-23', '2026-08-25']);
    // 🔴 期限切れは**捨てない。印を付ける**
    expect(g.map((x) => x.overdue)).toEqual([true, false, false]);
  });

  /**
   * 🔴 **束は「日」。名前だけ人の言葉にする。**
   * ⚠ 「今週」で束ねると、掴んだ札を落としたときに**どの日か決まらない**
   *   ── 束ね方が操作を決めてしまう(双方向の面なので、束 = 落とし先である)。
   */
  it('🔴 名前は 今日 / 明日 / M/D(曜)', () => {
    const g = buildAgenda(
      [card('a', 0, TODAY), card('b', 0, '2026-08-24'), card('c', 0, '2026-08-27')],
      TODAY,
    );
    expect(g.map((x) => x.label)).toEqual(['今日', '明日', '8/27(木)']);
  });

  it('明日は月末・年末をまたぐ', () => {
    expect(buildAgenda([card('a', 0, '2026-09-01')], '2026-08-31')[0]?.label).toBe('明日');
    expect(buildAgenda([card('a', 0, '2027-01-01')], '2026-12-31')[0]?.label).toBe('明日');
  });

  /**
   * 🔴 **束の中は時刻の昇順、時刻なしは後ろ。**
   * ⚠ 「いつか今日やる」は「10:00 の予定」より後である。
   */
  it('🔴 束の中は時刻順(時刻なしは後ろ、同着は渡された順)', () => {
    const g = buildAgenda(
      [
        card('a', 0, TODAY, null, '時刻なし1'),
        card('b', 0, TODAY, '14:00', '午後'),
        card('c', 0, TODAY, '09:00', '朝'),
        card('d', 0, TODAY, null, '時刻なし2'),
        card('e', 0, TODAY, '09:00', '朝2'),
      ],
      TODAY,
    );
    expect(g[0]?.cards.map((c) => c.text)).toEqual([
      '朝',
      '朝2', // ⚠ 同着は渡された順(安定)
      '午後',
      '時刻なし1',
      '時刻なし2',
    ]);
  });

  /**
   * 🔴 **日付なしは既定で出さない**(user 指示 2026-08-23 の②)。
   * ⚠ 出すときは**いちばん最後**(予定ではないので、予定の間に挟まない)。
   */
  it('🔴 日付なしは既定で出さず、出すときは最後', () => {
    const cards = [card('a', 0, null, null, '体裁'), card('b', 0, TODAY, null, '予定')];
    expect(buildAgenda(cards, TODAY).map((x) => x.label)).toEqual(['今日']);
    expect(buildAgenda(cards, TODAY, true).map((x) => x.label)).toEqual(['今日', '日付なし']);
  });

  it('日付なしが 1 件も無ければ、出す設定でも束を作らない', () => {
    // ⚠ 空の束は「押しても何も無い見出し」になる
    expect(buildAgenda([card('a', 0, TODAY)], TODAY, true).map((x) => x.date)).toEqual([TODAY]);
  });

  it('札が 1 枚も無ければ束も 0', () => {
    expect(buildAgenda([], TODAY, true)).toEqual([]);
  });

  /**
   * 🔴 **実在しない日でも束は作る**(`schedule-date.ts` の判断と揃える)。
   * ⚠ `Date` に通して正規化すると、`2026-02-30` が **3/2 に化けて**
   *   user が書いた字と違う日に出る ── 打ち間違いに気づけなくなる。
   */
  it('🔴 実在しない日は、化けさせずにそのまま出す', () => {
    const g = buildAgenda([card('a', 0, '2026-02-30')], TODAY);
    expect(g[0]?.date).toBe('2026-02-30');
    // ⚠ 曜日は出せない(実在しないので)── 日付だけ出す
    expect(g[0]?.label).toBe('2/30');
    expect(g[0]?.overdue, '今日より前なので期限切れ').toBe(true);
  });

  /**
   * ⚠ **同じ日の札は 1 つの束にまとまる**(lid が違っても)。
   * 🔑 これが崩れると、同じ日が画面に 2 回出る。
   */
  it('別のノートの札でも、同じ日は 1 つの束', () => {
    const g = buildAgenda([card('a', 0, TODAY), card('b', 3, TODAY)], TODAY);
    expect(g).toHaveLength(1);
    expect(g[0]?.cards.map((c) => c.lid)).toEqual(['a', 'b']);
  });
});
