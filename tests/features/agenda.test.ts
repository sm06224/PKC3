import { describe, expect, it } from 'vitest';
import {
  AGENDA_RANGE_MAX_DAYS,
  buildAgenda,
  itemOfCard,
  itemOfNote,
} from '../../src/features/schedule/agenda';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const card = (
  lid: string,
  line: number,
  date: string | null,
  time: string | null = null,
  text = 'x',
  until: string | null = null,
) => itemOfCard({ lid, line, text, done: false, date, time, until });

/** ノート 1 件が丸ごと予定(frontmatter の `date:`)。 */
const noteMeta = (lid: string, date: string | null, title = 'n-' + lid): EntryMeta => ({
  lid,
  title,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 0,
  status: null,
  date,
  archived: false,
  bodyChars: null,
});

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

/**
 * 🔴 **ノート 1 件が丸ごと予定**(段④。frontmatter の `date:`)。
 *
 * ⚠ これを受けないと、中央のカレンダー(段⑤ で落とす)が消えた瞬間に
 *   **`date:` を書いてもどこにも出ない** ── 動線が 1 つ消える。
 */
describe('ノート 1 件の予定も、同じ束に入る(段④)', () => {
  it('行の予定とノートの予定が、同じ日の束に並ぶ', () => {
    const g = buildAgenda(
      [card('a', 2, TODAY, null, '行の予定'), itemOfNote(noteMeta('b', TODAY, '会議のノート'))],
      TODAY,
    );
    expect(g).toHaveLength(1);
    expect(g[0]?.cards.map((c) => [c.text, c.line])).toEqual([
      ['行の予定', 2],
      // 🔑 `line === null` が「ノート 1 件が丸ごと」の印
      ['会議のノート', null],
    ]);
  });

  /**
   * 🔴 **鍵がぶつからない。**
   * ⚠ 同じ lid の行 0 とノートが同じ鍵になると、描画側が**1 枚しか置かない**
   *   (片方が黙って消える)。
   */
  it('🔴 同じノートの「行 0」と「丸ごと」で鍵がぶつからない', () => {
    const line0 = card('a', 0, TODAY);
    const whole = itemOfNote(noteMeta('a', TODAY));
    expect(line0.key).not.toBe(whole.key);
    expect(buildAgenda([line0, whole], TODAY)[0]?.cards).toHaveLength(2);
  });

  it('ノートの予定に印は無い(チェックする行が無い)', () => {
    expect(itemOfNote(noteMeta('a', TODAY)).done).toBe(false);
    expect(itemOfNote(noteMeta('a', TODAY)).time).toBeNull();
  });
});

/**
 * 🔴 **期間は「出る日」ぜんぶに置く**(#344 段①)。
 *
 * ⚠ 1 点として置くと、**途中の日に出ない** ── user は
 *   「8/26 の予定を見に来たのに、出張が載っていない」になる。
 */
describe('期間(#344 段①)', () => {
  /** `2026-08-25` から 4 日ぶんの出張。⚠ 今日(8/23)より後なので期限切れではない。 */
  const trip = () => card('t', 0, '2026-08-25', null, '出張', '2026-08-28');

  it('開始から終わりまで、すべての日の束に出る', () => {
    const g = buildAgenda([trip()], TODAY);
    expect(g.map((x) => x.date)).toEqual([
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
    ]);
    for (const day of g) expect(day.cards).toHaveLength(1);
  });

  /**
   * 🔴 **対照群** ── 単日は 1 つの束にしか出ない。
   * ⚠ 無いと「何でも複数の束に出る」実装でも上が緑になる。
   */
  it('⚠ 対照群 ── 期間でない札は 1 つの束にしか出ない', () => {
    const g = buildAgenda([card('s', 0, '2026-08-25')], TODAY);
    expect(g).toHaveLength(1);
    expect(g[0]?.cards).toHaveLength(1);
  });

  /**
   * 🔴 **束をまたいで鍵が重ならない**(#344 段①)。
   *
   * ⚠ これが**この機能でいちばん壊れやすい所**である ── 描画側
   *   (`ui/render/schedule.ts`)は鍵 1 つにつき DOM を 1 個しか持たないので、
   *   鍵が同じだと **1 枚の札を日から日へ動かして、結局最後の日にしか出ない**。
   * ⚠ unit で「4 つの束に出た」だけを見ると**この壊れ方は見えない**(束の中身は
   *   正しいので)── だから鍵の一意性を**ここで**、DOM の枚数を
   *   `tests/adapter/schedule-view.test.ts` で見る。
   */
  it('🔴 束をまたいで札の鍵が一意である(同じ鍵だと DOM が 1 枚しか出ない)', () => {
    const g = buildAgenda([trip(), card('s', 0, '2026-08-26')], TODAY);
    const keys = g.flatMap((x) => x.cards.map((c) => c.key));
    expect(keys.length, '前提が崩れている ── 札が展開されていない').toBe(5);
    expect(new Set(keys).size, `鍵が重なっている: ${keys.join(' / ')}`).toBe(keys.length);
  });

  /**
   * 🔴 **上限で切る** ── 打ち間違い 1 つで束が数十万個できるのを止める。
   * ⚠ 切ったことは**札の側**に出る(期間の終わりを札が出す)。
   */
  it('🔴 長すぎる期間は上限で切る(面が固まらない)', () => {
    const g = buildAgenda([card('t', 0, '2026-08-25', null, '長すぎ', '2999-01-01')], TODAY);
    expect(g).toHaveLength(AGENDA_RANGE_MAX_DAYS);
    // ⚠ 空振り防止 ── 上限そのものが 1 や 0 に潰れていないこと
    expect(AGENDA_RANGE_MAX_DAYS).toBeGreaterThan(300);
  });

  /**
   * 🔴 **期間(終日)はその日の先頭**。
   * 「この日は出張中」は、その日の 10:00 の予定より**前提**である。
   */
  it('束の中では、期間 → 時刻あり → 時刻なし の順', () => {
    const g = buildAgenda(
      [
        card('c', 0, '2026-08-26', null, '時刻なし'),
        card('b', 0, '2026-08-26', '10:00', '10 時'),
        trip(),
      ],
      TODAY,
    );
    const day = g.find((x) => x.date === '2026-08-26');
    expect(day?.cards.map((c) => c.text)).toEqual(['出張', '10 時', '時刻なし']);
  });

  /**
   * ⚠ **対照群** ── 期間が 1 枚も無ければ、並びの規則は今までどおり
   *   「時刻の昇順、時刻なしは後ろ」。
   */
  it('⚠ 対照群 ── 期間が無いときの並びは変わらない', () => {
    const g = buildAgenda(
      [
        card('c', 0, '2026-08-26', null, '時刻なし'),
        card('b', 0, '2026-08-26', '10:00', '10 時'),
        card('a', 0, '2026-08-26', '09:00', '9 時'),
      ],
      TODAY,
    );
    expect(g[0]?.cards.map((c) => c.text)).toEqual(['9 時', '10 時', '時刻なし']);
  });

  /**
   * 🔴 **今日をまたぐ期間は、過ぎた日だけが「期限切れ」**。
   * ⚠ 期間ごと期限切れにすると、**まだ続いている出張が赤くなる**。
   */
  it('今日をまたぐ期間は、過ぎた日の束だけ期限切れになる', () => {
    const g = buildAgenda([card('t', 0, '2026-08-21', null, '出張', '2026-08-25')], TODAY);
    const flags = g.map((x) => [x.date, x.overdue]);
    expect(flags).toEqual([
      ['2026-08-21', true],
      ['2026-08-22', true],
      ['2026-08-23', false], // 今日
      ['2026-08-24', false],
      ['2026-08-25', false],
    ]);
  });
});
