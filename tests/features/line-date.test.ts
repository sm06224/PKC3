import { describe, expect, it } from 'vitest';
import {
  readLineDate,
  stripLineDate,
  formatLineDate,
} from '../../src/features/schedule/line-date';
import { readScheduleDate } from '../../src/features/schedule/schedule-keys';
import { isScheduleDate, isScheduleTime } from '../../src/features/schedule/schedule-date';

describe('行の日付(@2026-08-25)', () => {
  it('チェック項目の末尾に書いた日付を読む', () => {
    expect(readLineDate('見積を送る @2026-08-25')).toMatchObject({
      date: '2026-08-25',
      time: null,
    });
  });

  it('時刻も読む(空白区切り)', () => {
    expect(readLineDate('打ち合わせ @2026-08-25 14:00')).toMatchObject({
      date: '2026-08-25',
      time: '14:00',
    });
  });

  it('時刻の区切りは `T` でもよい', () => {
    expect(readLineDate('@2026-08-25T14:00')).toMatchObject({ date: '2026-08-25', time: '14:00' });
  });

  it('日付が無い行は null(= 体裁のチェックリストは予定にならない)', () => {
    // 🔴 user 指示 2026-08-23「文章の体裁としてチェックリストを使いたい場面もある」
    expect(readLineDate('あとで読む本を書き出す')).toBeNull();
  });

  /**
   * 🔴 **日本語の業務文を日付と読み違えない**(#292 の裁定文が名指しで挙げた 2 形)。
   * ⚠ ここが緩いと、単価や個数を書いた行が**全部予定として盤面に出る**。
   */
  it.each([
    ['単価', '牛乳 @1,500 で仕入れる'],
    ['個数', 'ねじ @3 本'],
    ['桁が足りない', '@2026-8-5 に送る'],
    ['月日が 1 桁', '@2026-8-05 に送る'],
    ['数字だけ', '@20260825 に送る'],
    ['区切りだけ', '@-- に送る'],
  ])('%s は日付ではない', (_name, line) => {
    expect(readLineDate(line)).toBeNull();
  });

  /**
   * 🔴 **貪欲に取るから弾ける。**「先頭 10 字が日付なら採用」と書くと、
   * user が書いた 1 つの語を**こちらが勝手に切って**読むことになる。
   */
  it('数字が続いていたら、その語ごと日付ではない', () => {
    expect(readLineDate('@2026-08-251')).toBeNull();
    expect(readLineDate('@2026-08-25-1')).toBeNull();
  });

  /**
   * 🔴 **既存記法との排他**(`features/link/card-presentation.ts:70` の `CARD_RE`)。
   * ⚠ これは**対照群**である ── これが落ちたら、`@` の読み分けが壊れて
   *   本文の札が予定として拾われている。
   */
  it('本文の札(@[card](…))は日付として拾わない', () => {
    expect(readLineDate('@[card](entry:abc123)')).toBeNull();
    expect(readLineDate('@[card:wide](entry:abc123)')).toBeNull();
  });

  it('時刻が読めなくても、日付は活かす', () => {
    // ⚠ `10:000円` は時刻ではないが、日付のほうは user がちゃんと書いている
    const found = readLineDate('見積 @2026-08-25 10:000円');
    expect(found).toMatchObject({ date: '2026-08-25', time: null });
    // 🔑 範囲は**日付までで終わる**(壊れた時刻を巻き込んで消さない)
    expect('見積 @2026-08-25 10:000円'.slice(found!.start, found!.end)).toBe('@2026-08-25');
  });

  it('1 桁の時刻は時刻ではない(本文の数字を拾わない)', () => {
    expect(readLineDate('@2026-08-25 3:00 の予算')).toMatchObject({ time: null });
  });

  /**
   * 🔴 **1 行に 2 つ書かれていたら、最初の 1 つだけ。**
   * ⚠ 2 つ返すと「その行の予定はいつか」に答えが 2 つでき、
   *   並べる側と画面に出す側が**それぞれ好きなほうを選ぶ**。
   */
  it('2 つ書かれていたら最初の 1 つ', () => {
    expect(readLineDate('@2026-08-25 に @2026-08-30 の資料')).toMatchObject({
      date: '2026-08-25',
    });
  });

  it('落ちた候補の後ろに本物が在れば、そちらを拾う', () => {
    // ⚠ 走査が最初の `@` で諦めていないこと(`@1,500` で止まらない)
    expect(readLineDate('@1,500 で仕入れる @2026-08-25')).toMatchObject({ date: '2026-08-25' });
  });

  /**
   * 🔴 **`@` の前に境目を求めない。**
   * ⚠ 日本語は語の切れ目に空白が無いので、境目を求めると
   *   **日本語で書いた人だけ書けない**記法になる。
   */
  it('日本語の直後に書いても読む(空白が要らない)', () => {
    expect(readLineDate('会議@2026-08-25')).toMatchObject({ date: '2026-08-25' });
  });
});

describe('stripLineDate ── 画面に出す字', () => {
  it.each([
    ['末尾', '見積を送る @2026-08-25', '見積を送る'],
    ['末尾 + 時刻', '打ち合わせ @2026-08-25 14:00', '打ち合わせ'],
    ['先頭', '@2026-08-25 に送る', 'に送る'],
    ['途中(空白を 1 つに畳む)', '見積 @2026-08-25 を送る', '見積 を送る'],
    ['日付が無ければそのまま', 'あとで読む', 'あとで読む'],
    ['壊れた時刻は残す', '見積 @2026-08-25 10:000円', '見積 10:000円'],
  ])('%s', (_name, line, want) => {
    expect(stripLineDate(line)).toBe(want);
  });
});

describe('formatLineDate ── 書きは 1 本だけ', () => {
  it('日付だけ / 日付と時刻', () => {
    expect(formatLineDate('2026-08-25')).toBe('@2026-08-25');
    expect(formatLineDate('2026-08-25', '14:00')).toBe('@2026-08-25 14:00');
  });

  it.each([[null], [undefined], ['']])('時刻が %s なら日付だけ', (time) => {
    expect(formatLineDate('2026-08-25', time)).toBe('@2026-08-25');
  });

  /**
   * 🔴 **書いたものは、必ず読める**(往復)。
   * ⚠ これは「同じ規則を 2 回書いた」検査ではない ── **書く側と読む側は
   *   別の実装**(組み立て / 走査)なので、片方だけ区切りを変えたら落ちる。
   */
  it.each([
    ['2026-08-25', null],
    ['2026-08-25', '14:00'],
    ['2026-01-01', '00:00'],
    ['2026-12-31', '23:59'],
  ])('組み立てた %s %s を読み戻せる', (date, time) => {
    const line = `やること ${formatLineDate(date, time)}`;
    expect(readLineDate(line)).toMatchObject({ date, time });
  });
});

/**
 * 🔴 **frontmatter の `date:` と、行の `@…` は同じ日付を受ける**
 * (CLAUDE.md §7「同じ判定が 2 か所にある」)。
 *
 * ⚠ 食い違うと、user から見て「**frontmatter では書けるのに行では書けない日付**」が
 *   でき、しかも**理由が画面のどこにも出ない**。
 *
 * 🔑 **corpus は生成する**(手で並べない)── 手で並べると、**自分が思いついた
 *   食い違いしか見つからない**。正しい形を 1 つ置いて、**桁を削る / 足す /
 *   区切りを動かす**を全数当てる。
 *
 * ⚠ 主張の範囲を狭めてある:比べるのは **`[0-9-]` だけでできた字**である。
 *   行の記法は**位置で区切られる**ので、`2026-08-25 extra` のような空白入りは
 *   frontmatter では 1 つの値、行では「日付 + 別の語」── **食い違って正しい**。
 */
describe('frontmatter と行で、同じ日付が通る', () => {
  const GOOD = '2026-08-25';

  /** 桁を削る / 足す / 区切りを動かす、を全数。 */
  function corpus(): string[] {
    const out = new Set<string>([GOOD, '', '-', '0000-00-00', '9999-99-99']);
    for (let i = 0; i < GOOD.length; i++) {
      out.add(GOOD.slice(0, i) + GOOD.slice(i + 1)); // 1 字削る
      out.add(GOOD.slice(0, i) + '7' + GOOD.slice(i)); // 数字を差し込む
      out.add(GOOD.slice(0, i) + '-' + GOOD.slice(i)); // 区切りを差し込む
      out.add(GOOD.slice(0, i) + (GOOD[i] === '-' ? '7' : '-') + GOOD.slice(i + 1)); // 1 字入れ替え
    }
    return [...out];
  }

  const forms = corpus();

  it('⚠ corpus が退化していないこと(通る形と落ちる形が両方在る)', () => {
    // 🔑 「ゼロ件の次元は測っていない次元」── どちらかが 0 件なら、下の全数検査は空振り
    const pass = forms.filter((f) => isScheduleDate(f));
    expect(pass).toContain(GOOD);
    // ⚠ **件数で pin しない**(`0000-00-00` / `9999-99-99` も**わざと通る**ので、
    //    等値で書くと「実在しない日を通す」判断を変えた瞬間に**無関係な検査が落ちる**)
    expect(forms.length - pass.length).toBeGreaterThan(20);
  });

  it.each(corpus().map((f) => [f]))('「%s」の扱いが 2 か所で一致する', (form) => {
    const inFrontmatter = readScheduleDate({ date: form }) !== null;
    // ⚠ 行のほうは**行に埋めて**当てる(記法として書いたときに何が起きるか)
    const inLine = readLineDate(`やること @${form}`) !== null;
    expect(inLine).toBe(inFrontmatter);
  });
});

describe('形の述語(schedule-date)', () => {
  it('実在しない日も形としては通る ── 並びに出して user に直させる', () => {
    // ⚠ 弾くと「書いたのに何も起きない」になる(打ち間違いに気づけない)
    expect(isScheduleDate('2026-02-30')).toBe(true);
    expect(isScheduleDate('2026-13-01')).toBe(true);
    expect(readLineDate('@2026-02-30')).toMatchObject({ date: '2026-02-30' });
  });

  it('時刻も同じ向き', () => {
    expect(isScheduleTime('25:99')).toBe(true);
    expect(isScheduleTime('3:00')).toBe(false);
    expect(isScheduleTime('14:00:00')).toBe(false); // ⚠ 秒は受けない(道具も書かない)
  });
});
