/** @vitest-environment happy-dom */
/**
 * 🔴 **時刻の幅**(`@2026-08-25 14:00..15:00`)── #855 段 C′(設計 doc `schedule-direct-2026-09.md` §5)。
 *
 * 守る主張:
 * 1. 幅は「時刻が読めて・終わりも読めて・逆順でない」ときだけ読む。読めない形は
 *    **いまと同じ時刻 1 点**として読み、`..…` は札の字に残る(書いた字を黙って消さない)
 * 2. 日付の期間(`@a..b`)・時刻 1 点・刻み・振替・チェックの読みは**1 つも変わらない**
 *    (外の形 × 尻の総当たりで、取り違える形が出ないことを見る)
 * 3. 札の字は `14:00〜15:00`。掴んで別の日へ落としても・繰り返しを展開しても・回を済ませても
 *    **幅は 1 byte も変わらない**
 *
 * 🔑 決めた方針(下の表が test そのものである):
 *   - 逆順 / 片方だけ / 壊れた時刻 → 幅としては読まず、時刻 1 点(= いまと同じ)
 *   - 全角の数字・コロンは**受けない**(時刻 1 点も受けないので揃える)── 受けない字は札に残る
 *   - 区切りは日付の期間と同じ 3 綴り(`..` / `〜` / `～`)+ 時刻の直後の `-`(#855 Q2 = A)。書くのは `..` だけ
 */
import { describe, expect, it } from 'vitest';
import {
  formatLineDate,
  readLineDate,
  stripLineDate,
  insertionForLineDate,
} from '../../src/features/schedule/line-date';
import { formatTimeSpan, isScheduleTimeRange } from '../../src/features/schedule/schedule-date';
import { replaceTaskCards, taskCardsOf } from '../../src/features/schedule/task-cards';
import { buildAgenda, itemOfCard, type AgendaItem } from '../../src/features/schedule/agenda';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { patchTaskCard, createTaskCard } from '../../src/adapter/ui/render/task-card';
import { dropTaskCard } from '../../src/adapter/ui/render/schedule-drag';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { EntryMeta } from '../../src/core/model/entry-meta';

interface Outer {
  readonly name: string;
  /** `@` の後ろの字。 */
  readonly src: string;
  readonly date: string;
  readonly until: string | null;
  readonly time: string | null;
  readonly timeEnd: string | null;
  /** 記法が食べなかった字(尻の前に残る)。空でなければ、尻は付かない。 */
  readonly leftover: string;
  /** 尻のうち読めるもの。 */
  readonly tails: 'all' | 'repeat-only' | 'none';
}

const D = '2026-08-25';
const U = '2026-08-27';
const o = (
  name: string,
  src: string,
  v: { until?: string | null; time?: string | null; timeEnd?: string | null; leftover?: string; tails?: Outer['tails'] },
): Outer => ({
  name,
  src,
  date: D,
  until: v.until ?? null,
  time: v.time ?? null,
  timeEnd: v.timeEnd ?? null,
  leftover: v.leftover ?? '',
  tails: v.tails ?? 'all',
});
const OUTERS: readonly Outer[] = [
  o('日付のみ', D, {}),
  o('日付の期間', `${D}..${U}`, { until: U, tails: 'repeat-only' }),
  o('日付の期間(〜)', `${D}〜${U}`, { until: U, tails: 'repeat-only' }),
  o('時刻 1 点', `${D} 14:00`, { time: '14:00' }),
  o('時刻 1 点(T)', `${D}T14:00`, { time: '14:00' }),
  o('幅', `${D} 14:00..15:00`, { time: '14:00', timeEnd: '15:00' }),
  o('幅(T)', `${D}T14:00..15:00`, { time: '14:00', timeEnd: '15:00' }),
  o('幅(〜)', `${D} 14:00〜15:00`, { time: '14:00', timeEnd: '15:00' }),
  o('幅(～)', `${D} 14:00～15:00`, { time: '14:00', timeEnd: '15:00' }),
  o('幅(同じ時刻)', `${D} 14:00..14:00`, { time: '14:00', timeEnd: '14:00' }),
  // 🔴 時刻の直後の `-` も幅(#855 Q2 = A)。日付の `-` とは位置が違うので紛れない
  o('幅(-)', `${D} 14:00-15:00`, { time: '14:00', timeEnd: '15:00' }),
  o('幅(T・-)', `${D}T14:00-15:00`, { time: '14:00', timeEnd: '15:00' }),
  o('幅(同じ時刻・-)', `${D} 14:00-14:00`, { time: '14:00', timeEnd: '14:00' }),
  // 🔴 期間に時刻は付けない ── 幅も付かない。後ろの字は食べずに残る(いまと同じ)
  o('日付の期間 + 幅', `${D}..${U} 14:00..15:00`, { until: U, leftover: ' 14:00..15:00', tails: 'none' }),
  // ⚠ 読めない幅 ── 時刻 1 点として読み、`..…` は残る
  o('逆順', `${D} 15:00..14:00`, { time: '15:00', leftover: '..14:00', tails: 'none' }),
  o('終わりが無い', `${D} 14:00..`, { time: '14:00', leftover: '..', tails: 'none' }),
  // ⚠ `-` の読めない形も同じ向き(1 点として読み、`-…` は札の字に残る)── `-15:00` だけは始まりが無い
  o('逆順(-)', `${D} 15:00-14:00`, { time: '15:00', leftover: '-14:00', tails: 'none' }),
  o('終わりが無い(-)', `${D} 14:00-`, { time: '14:00', leftover: '-', tails: 'none' }),
  o('始まりが無い(-)', `${D} -15:00`, { leftover: ' -15:00', tails: 'none' }),
  o('終わりが 1 桁(-)', `${D} 14:00-15`, { time: '14:00', leftover: '-15', tails: 'none' }),
  o('日付の期間 + 幅(-)', `${D}..${U} 14:00-15:00`, { until: U, leftover: ' 14:00-15:00', tails: 'none' }),
  o('終わりが 1 桁', `${D} 14:00..15`, { time: '14:00', leftover: '..15', tails: 'none' }),
  o('終わりの桁が多い', `${D} 14:00..15:000`, { time: '14:00', leftover: '..15:000', tails: 'none' }),
  o('点が 3 つ', `${D} 14:00...15:00`, { time: '14:00', leftover: '...15:00', tails: 'none' }),
  o('時刻の後ろに日付', `${D} 14:00..${U}`, { time: '14:00', leftover: `..${U}`, tails: 'none' }),
  // 🔴 打ち方の次元(日本語入力): 全角は**受けない**(時刻 1 点も受けない ── 揃える)
  o('全角の幅', `${D} １４：００..１５：００`, { leftover: ' １４：００..１５：００', tails: 'none' }),
  o('全角の終わり', `${D} 14:00..１５：００`, { time: '14:00', leftover: '..１５：００', tails: 'none' }),
  o('全角のコロン', `${D} 14：00..15：00`, { leftover: ' 14：00..15：00', tails: 'none' }),
  o('全角のピリオド', `${D} 14:00．．15:00`, { time: '14:00', leftover: '．．15:00', tails: 'none' }),
  o('壊れた始まり', `${D} 14:000..15:00`, { leftover: ' 14:000..15:00', tails: 'none' }),
];

const TAILS: readonly { name: string; src: string; kind: 'none' | 'repeat' | 'sub' | 'text' }[] = [
  { name: '尻なし', src: '', kind: 'none' },
  { name: '毎週', src: ' 毎週', kind: 'repeat' },
  { name: '毎週(詰め)', src: '毎週', kind: 'repeat' },
  { name: '振替', src: ' 振替2026-08-20', kind: 'sub' },
  { name: '末尾の字', src: ' の枠', kind: 'text' },
];

describe('時刻の幅の読み ── 外の形 × 尻の総当たり(#855 段 C′)', () => {
  for (const out of OUTERS) {
    for (const t of TAILS) {
      it(`${out.name} × ${t.name}`, () => {
        const line = `x @${out.src}${t.src}`;
        const d = readLineDate(line);
        expect(d, line).not.toBeNull();
        // 外の形の 4 つの値は、尻に左右されない(取り違えない)
        expect(
          { date: d!.date, until: d!.until, time: d!.time, timeEnd: d!.timeEnd },
          line,
        ).toEqual({ date: out.date, until: out.until, time: out.time, timeEnd: out.timeEnd });
        // 尻:残りの字が在れば何も付かない / 無ければ種類ごとの規則
        const readable = out.leftover === '' ? out.tails : 'none';
        const repeat = t.kind === 'repeat' && readable !== 'none' ? 'week' : null;
        const sub =
          t.kind === 'sub' && readable === 'all' && out.until === null ? '2026-08-20' : null;
        expect(d!.repeat, line).toBe(repeat);
        expect(d!.substitutes, line).toBe(sub);
        // 記法の範囲 ── `@` から、食べた字の終わりまで(食べなかった字は含まない)
        const tailEaten = repeat !== null || sub !== null;
        const consumedSrc = out.src.slice(0, out.src.length - out.leftover.length);
        expect(line.slice(d!.start, d!.end), line).toBe(`@${consumedSrc}${tailEaten ? t.src : ''}`);
        // 札の字:食べなかった字は残り、食べた字は消える
        const rest = `${out.leftover}${tailEaten ? '' : t.src}`.replace(/^[ \t]+/, '');
        expect(stripLineDate(line), line).toBe(rest === '' ? 'x' : `x ${rest}`);
      });
    }
  }
});

describe('`-` は日付の網を広げない(#855 Q2 = A)', () => {
  it('🔴 日付どうしを `-` でつないだ形(`@a-b`)は、今までどおり日付として読まない', () => {
    // 日付の網は `-` を取りすぎる(`2026-08-25-2026-08-27` を 1 語にして落とす)── 区切りに足していない
    expect(readLineDate(`x @${D}-${U}`)).toBeNull();
    // 対照群: 時刻の直後の `-` は幅(同じ関数で読めている)
    expect(readLineDate(`x @${D} 14:00-15:00`)).toMatchObject({ time: '14:00', timeEnd: '15:00' });
  });

  it('🔴 書くのは `..` のまま(`-` で書かれた本文を読み、面から書き直すと `..` に揃う)', () => {
    const found = readLineDate(`x @${D} 14:00-15:00`)!;
    expect(formatLineDate(found.date, found.time, found.until, found.repeat, found.substitutes, found.timeEnd)).toBe(
      `@${D} 14:00..15:00`,
    );
  });
});

describe('書いて、読み返す(往復)', () => {
  it('🔴 書いた幅は、そのまま読み返せる(刻み・振替と一緒でも)', () => {
    const texts = [
      formatLineDate(D, '14:00', null, null, null, '15:00'),
      formatLineDate(D, '14:00', null, 'week', null, '15:00'),
      formatLineDate(D, '14:00', null, null, '2026-08-20', '15:00'),
    ];
    expect(texts).toEqual([
      `@${D} 14:00..15:00`,
      `@${D} 14:00..15:00 毎週`,
      `@${D} 14:00..15:00 振替2026-08-20`,
    ]);
    for (const text of texts) {
      expect(readLineDate(`x ${text}`), text).toMatchObject({ time: '14:00', timeEnd: '15:00' });
      expect(stripLineDate(`x ${text}`), text).toBe('x');
    }
  });

  /** ⚠ 往復しない字は出力しない(この file の作法) */
  it('読まれない形は書かない(逆順 / 始まりが無い / 期間)', () => {
    expect(formatLineDate(D, '15:00', null, null, null, '14:00')).toBe(`@${D} 15:00`);
    expect(formatLineDate(D, null, null, null, null, '15:00')).toBe(`@${D}`);
    expect(formatLineDate(D, '14:00', U, null, null, '15:00')).toBe(`@${D}..${U}`);
  });

  it('挿す形(道具から入れる)は、幅を渡さなければ 1 点のまま ── 既存の形は変わらない', () => {
    expect(insertionForLineDate('見積', D, '14:00')).toBe(` @${D} 14:00`);
  });

  it('時刻の幅の述語 ── 逆順は通さず、同じ時刻は通し、形だけを見る', () => {
    expect(isScheduleTimeRange('14:00', '15:00')).toBe(true);
    expect(isScheduleTimeRange('14:00', '14:00')).toBe(true);
    expect(isScheduleTimeRange('15:00', '14:00')).toBe(false);
    expect(isScheduleTimeRange('14:00', '15')).toBe(false);
    expect(isScheduleTimeRange('14:00', '')).toBe(false);
    expect(isScheduleTimeRange('14:00', '25:99')).toBe(true);
    expect(formatTimeSpan('14:00', '15:00')).toBe('14:00〜15:00');
    expect(formatTimeSpan('14:00', null)).toBe('14:00');
  });
});

describe('札・束・描画', () => {
  it('🔴 行 → 札に幅が載り、字から記法ごと外れる(毎週と一緒でも)', () => {
    const [c] = taskCardsOf('a', '- [ ] 朝会 @2026-08-31 09:30..10:30 毎週');
    expect(c).toMatchObject({
      text: '朝会',
      date: '2026-08-31',
      time: '09:30',
      timeEnd: '10:30',
      repeat: 'week',
    });
  });

  it('⚠ 終わりだけ書き換えても「同じ札」と見なされない(画面の幅が古いまま残らない)', () => {
    const cards = taskCardsOf('a', '- [ ] 朝会 @2026-08-31 09:30..10:30');
    const next = replaceTaskCards(cards, 'a', '- [ ] 朝会 @2026-08-31 09:30..11:30');
    expect(next).not.toBe(cards);
    expect(next[0]!.timeEnd).toBe('11:30');
    // 対照群: 同じ本文なら据え置き
    expect(replaceTaskCards(cards, 'a', '- [ ] 朝会 @2026-08-31 09:30..10:30')).toBe(cards);
  });

  it('🔴 繰り返しの展開で、どの回の札も幅を持つ(落とさない)', () => {
    const rule = itemOfCard(taskCardsOf('a', '- [ ] 朝会 @2026-08-31 09:30..10:30 毎週')[0]!);
    const g = buildAgenda([rule], '2026-08-31', false, { horizonDays: 21 });
    const items = g.flatMap((x) => x.cards);
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const i of items) expect([i.time, i.timeEnd]).toEqual(['09:30', '10:30']);
  });

  const label = (it: AgendaItem, showDate: boolean): string => {
    const el = createTaskCard(it);
    patchTaskCard(el, it, 't', 2026, showDate);
    return el.querySelector('[data-pkc-field="when"]')!.textContent ?? '';
  };
  const item = (body: string): AgendaItem => itemOfCard(taskCardsOf('a', body)[0]!);

  it('🔴 札の字は `14:00〜15:00`(日付を出さない面 / 出す面の両方)', () => {
    const w = item('- [ ] 会議 @2026-08-25 14:00..15:00');
    expect(label(w, false)).toBe('14:00〜15:00');
    expect(label(w, true)).toMatch(/ 14:00〜15:00$/);
    // 対照群: 1 点は今までどおり
    expect(label(item('- [ ] 会議 @2026-08-25 14:00'), false)).toBe('14:00');
    // 読めない幅は 1 点の字(`..14:00` は題の字に残る)
    const bad = item('- [ ] 会議 @2026-08-25 15:00..14:00');
    expect(label(bad, false)).toBe('15:00');
    expect(bad.text).toBe('会議 ..14:00');
  });

  it('⚠ 繰り返しの回の札も `〜` で出る(刻みの語は後ろに付く)', () => {
    const w = item('- [ ] 朝会 @2026-08-31 09:30..10:30 毎週');
    expect(label(w, false)).toBe('09:30〜10:30 毎週');
  });
});

describe('本文を書き換えても、幅は 1 byte も変わらない', () => {
  const apply = (body: string, rewrite: Parameters<typeof applyBodyRewrite>[1]): string =>
    applyBodyRewrite(body, rewrite) ?? '(null)';

  it('🔴 日だけ動かす(時刻の始まりを渡し直す呼び方) ── 幅が残る', () => {
    expect(
      apply('- [ ] 会議 @2026-08-25 14:00..15:00 の枠', {
        kind: 'line-date',
        line: 0,
        date: '2026-08-27',
        time: '14:00',
        until: null,
      }),
    ).toBe('- [ ] 会議 @2026-08-27 14:00..15:00 の枠');
  });

  /**
   * ⚠ 新しい始まりを **古い終わりより前**(14:30 < 15:00)に置く ── 逆順になる 16:00 では
   *   書き出しの門(逆順は書かない)が救ってしまい、持ち越しの門を外しても緑になる
   *   (変異試験 M9 が SURVIVED で教えた)。
   */
  it('⚠ 始まりが変わる呼び方では、古い終わりを持ち越さない(別の幅になるため)', () => {
    expect(
      apply('- [ ] 会議 @2026-08-25 14:00..15:00', {
        kind: 'line-date',
        line: 0,
        date: '2026-08-25',
        time: '14:30',
        until: null,
      }),
    ).toBe('- [ ] 会議 @2026-08-25 14:30');
  });

  it('⚠ 時刻を渡さない呼び方(いまの 1 点と同じ扱い)では時刻ごと落ちる ── 幅だけが残ることはない', () => {
    expect(
      apply('- [ ] 会議 @2026-08-25 14:00..15:00', { kind: 'line-date', line: 0, date: '2026-08-27' }),
    ).toBe('- [ ] 会議 @2026-08-27');
  });

  it('🔴 刻みだけ付け替えても、幅は残る', () => {
    expect(
      apply('- [ ] 朝会 @2026-08-31 09:30..10:30', { kind: 'line-date', line: 0, repeat: 'week' }),
    ).toBe('- [ ] 朝会 @2026-08-31 09:30..10:30 毎週');
    expect(
      apply('- [ ] 朝会 @2026-08-31 09:30..10:30 毎週', {
        kind: 'line-date',
        line: 0,
        repeat: null,
      }),
    ).toBe('- [ ] 朝会 @2026-08-31 09:30..10:30');
  });

  it('🔴 日付を外すと記法ごと消える(幅の字だけ残らない)', () => {
    expect(
      apply('- [ ] 会議 @2026-08-25 14:00..15:00', { kind: 'line-date', line: 0, date: null }),
    ).toBe('- [ ] 会議');
  });

  it('🔴 繰り返しの回を済ませる / この回だけ動かす ── 実体の行も幅を持つ', () => {
    const rule = '- [ ] 朝会 @2026-08-31 09:30..10:30 毎週\n';
    const done = apply(rule, { kind: 'repeat-done', line: 0, date: '2026-09-07' });
    expect(done.split('\n')[1]).toBe('- [x] 朝会 @2026-09-07 09:30..10:30');
    const moved = apply(rule, {
      kind: 'repeat-move',
      line: 0,
      from: '2026-09-07',
      to: '2026-09-09',
    });
    expect(moved.split('\n')[1]).toBe('- [ ] 朝会 @2026-09-09 09:30..10:30 振替2026-09-07');
    expect(readLineDate(moved.split('\n')[1]!)).toMatchObject({
      timeEnd: '10:30',
      substitutes: '2026-09-07',
    });
  });

  /**
   * 🔴 **時間の目盛りで動かした / 縁を引いた**(#855 段 B-1)── `timeEnd` を渡すと、その幅が書かれる。
   * ⚠ 渡さない呼び方(日だけ動かす)の挙動は上の 2 つが守っている。
   */
  it('🔴 動かす: 始まりと終わりが一緒に動く(長さを保つ)', () => {
    expect(
      apply('- [ ] 会議 @2026-08-23 14:00..15:00', {
        kind: 'line-date',
        line: 0,
        date: '2026-08-23',
        time: '16:15',
        timeEnd: '17:15',
      }),
    ).toBe('- [ ] 会議 @2026-08-23 16:15..17:15');
  });

  it('🔴 縁を引く: 始まりはそのまま、終わりだけが変わる', () => {
    expect(
      apply('- [ ] 会議 @2026-08-23 14:00..15:00', {
        kind: 'line-date',
        line: 0,
        date: '2026-08-23',
        time: '14:00',
        timeEnd: '15:30',
      }),
    ).toBe('- [ ] 会議 @2026-08-23 14:00..15:30');
  });

  it('🔴 終わりの無い札(点の時刻)の縁を引くと、終わりが付く', () => {
    expect(
      apply('- [ ] 会議 @2026-08-23 14:00', {
        kind: 'line-date',
        line: 0,
        date: '2026-08-23',
        time: '14:00',
        timeEnd: '15:30',
      }),
    ).toBe('- [ ] 会議 @2026-08-23 14:00..15:30');
  });

  it('終わりの無い札を動かしたら、点のまま動く(`timeEnd: null`)', () => {
    expect(
      apply('- [ ] 会議 @2026-08-23 14:00', {
        kind: 'line-date',
        line: 0,
        date: '2026-08-24',
        time: '16:15',
        timeEnd: null,
      }),
    ).toBe('- [ ] 会議 @2026-08-24 16:15');
  });

  it('🔴 繰り返しの「この回だけ」に時刻を渡すと、その回の行が新しい時刻で増える(規則は触らない)', () => {
    const rule = '- [ ] 朝会 @2026-08-31 09:30..10:30 毎週\n';
    const moved = apply(rule, {
      kind: 'repeat-move',
      line: 0,
      from: '2026-09-07',
      to: '2026-09-07',
      time: '11:00',
      timeEnd: '12:00',
    });
    expect(moved.split('\n')[0], '規則の行が触られた').toBe('- [ ] 朝会 @2026-08-31 09:30..10:30 毎週');
    // 同じ日でも時刻が動けば行が増える(日が同じ + 時刻が同じなら増えない ── 下)
    expect(moved.split('\n')[1]).toBe('- [ ] 朝会 @2026-09-07 11:00..12:00 振替2026-09-07');
    expect(
      apply(rule, { kind: 'repeat-move', line: 0, from: '2026-09-07', to: '2026-09-07', time: '09:30', timeEnd: '10:30' }),
      '日も時刻も同じなのに書いた',
    ).toBe('(null)');
  });

  /**
   * 🔴 **本物の道を通す**: 札を掴んで別の日へ落とす(`dropTaskCard`)→ reducer が書換を組む →
   * 本文へ当てる。⚠ 途中の action を見るだけでは、幅が本文まで届くかは言えない。
   */
  it('🔴 掴んで別の日へ落とすと、日付だけ動き、幅は 1 byte も変わらない', () => {
    const body = '- [ ] 会議 @2026-08-25 14:00..15:00 の枠';
    const meta: EntryMeta = {
      lid: 'a',
      title: 't',
      archetype: 'text',
      createdAt: null,
      updatedAt: null,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      bodyChars: null,
    };
    let state: AppState = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta],
      relations: [],
    }).state;
    state = {
      ...state,
      taskScan: { cards: taskCardsOf('a', body), totalNotes: 1, scannedNotes: 1, truncated: false },
    };
    let written: string | null = null;
    const stub = {
      getState: () => state,
      dispatch: (action: Parameters<typeof reduce>[1]) => {
        const r = reduce(state, action);
        state = r.state;
        for (const ev of r.events) {
          if (ev.type === 'REQUEST_BODY_REWRITE') written = applyBodyRewrite(body, ev.rewrite);
        }
      },
    } as unknown as Dispatcher;
    dropTaskCard(
      stub,
      { lid: 'a', line: '0', from: '2026-08-25', repeat: '' },
      '2026-08-27',
      document.createElement('div'),
    );
    expect(written).toBe('- [ ] 会議 @2026-08-27 14:00..15:00 の枠');
  });
});
