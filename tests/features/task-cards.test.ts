import { describe, expect, it } from 'vitest';
import {
  clipTaskText,
  replaceTaskCards,
  taskCardKey,
  TASK_LIMITS,
  type TaskCard,
  taskCardsOf,
} from '../../src/features/schedule/task-cards';
import { getMonthGrid, dateKey } from '../../src/features/schedule/month-grid';


/**
 * 🔴 **札の単位はチェック項目**(#277 段②-b)。
 * ⚠ 2026-08-19 に主張を裏返した ── 以前は「`todo` アーキタイプのノート 1 件 =
 *   札 1 枚」で、`archetype !== 'todo'` を落とすことを pin していた。しかし
 *   **todo は封印中で作れない**ので、その規則では盤面に何も出せる人が居なかった。
 * ⚠ **列への振り分け(`groupTasksByStatus` / `KANBAN_COLUMNS`)は #292 段⑤ で
 *   落とした** ── 面がカンバンから「予定」へ替わり、束ねる単位が
 *   「状態」から「日」になったので、呼んでいたのは**この test だけ**だった。
 */
describe('task-cards(札 = 本文のチェック項目)', () => {
  const card = (lid: string, line: number, done: boolean, text = 'x'): TaskCard => ({
    lid,
    line,
    text,
    done,
    date: null,
    time: null,
    until: null,
    repeat: null,
  });

  /**
   * 🔴 **鍵は lid だけでは足りない** ── 1 つのノートに項目は何個でもある。
   * ⚠ lid で鍵を作ると、同じノートの 2 枚目以降が**同じ札として潰れる**。
   */
  it('🔴 札の鍵は lid と行番号の対', () => {
    expect(taskCardKey(card('a', 0, false))).not.toBe(taskCardKey(card('a', 1, false)));
    expect(taskCardKey(card('a', 0, false))).not.toBe(taskCardKey(card('b', 0, false)));
  });

  it('長い項目は丸めて、丸めたことが判る形にする', () => {
    const long = 'あ'.repeat(TASK_LIMITS.textChars + 10);
    const clipped = clipTaskText(long);
    expect(clipped.length, '上限を超えたまま出している').toBe(TASK_LIMITS.textChars + 1);
    expect(clipped.endsWith('…'), '丸めたことが判らない').toBe(true);
    // ⚠ 上限ちょうどは**丸めない**(境目で 1 字消える事故を止める)
    const exact = 'い'.repeat(TASK_LIMITS.textChars);
    expect(clipTaskText(exact)).toBe(exact);
  });

  describe('1 件のノートの札だけを差し替える(押した札を往復なしで動かす)', () => {
    const board: TaskCard[] = [
      card('a', 0, false, 'a0'),
      card('a', 2, false, 'a2'),
      card('b', 0, false, 'b0'),
    ];
    /** ⚠ 空行を挟んで **0 行目と 2 行目**(`board` の行番号と揃える)。 */
    const bodyA = '- [ ] a0\n\n- [ ] a2\n';

    it('🔴 並びを保ったまま、その lid の区間だけ入れ替わる', () => {
      const next = replaceTaskCards(board, 'a', '- [x] a0\n\n- [ ] a2\n');
      expect(next.map((c) => `${c.lid}${c.line}:${c.done ? 'x' : ' '}`)).toEqual([
        'a0:x',
        'a2: ',
        'b0: ',
      ]);
    });

    it('項目が減っても増えても、他のノートの札は動かない', () => {
      const fewer = replaceTaskCards(board, 'a', '- [ ] a0\n');
      expect(fewer.map(taskCardKey)).toEqual(['a 0', 'b 0']);
      const more = replaceTaskCards(board, 'a', '- [ ] a0\n- [ ] new\n- [ ] a2\n');
      expect(more.map(taskCardKey)).toEqual(['a 0', 'a 1', 'a 2', 'b 0']);
    });

    /**
     * ⚠ 盤面に居ないノートは**入れない**(どこへ入れるべきかは worker しか知らない)。
     * 🔑 そして**同じ配列を返す** ── 描画側の指紋を無駄に壊さない。
     */
    it('🔴 盤面に居ない lid は入れず、配列の同一性も保つ', () => {
      expect(replaceTaskCards(board, 'zzz', '- [ ] x\n')).toBe(board);
    });

    /**
     * 🔑 中身が同じなら**同じ配列**(2026-08-20)── 押しただけで盤面の指紋が
     * 壊れると、そのノートの札が毎回描き直される。
     */
    it('🔴 中身が変わっていなければ同じ配列', () => {
      expect(replaceTaskCards(board, 'a', bodyA)).toBe(board);
    });

    it('差し替えた札の字も丸める(生の本文をそのまま出さない)', () => {
      const long = 'う'.repeat(TASK_LIMITS.textChars + 5);
      const next = replaceTaskCards(board, 'b', `- [ ] ${long}\n`);
      expect(next[next.length - 1]?.text.endsWith('…')).toBe(true);
    });

    /**
     * 🔴 **差し替えでも日付が付く**(2026-08-23)。
     * ⚠ これは「組み立てが 1 か所か」を見る検査である ── 直す前は
     *   `runTaskScan`(worker)と `replaceTaskCards`(reducer)が**別々に**
     *   札を組んでいた。片方にだけ日付を足すと、**面を開くと日付が出るのに、
     *   チェックを押した瞬間に消える**(しかも押したノートの札だけ)。
     */
    it('🔴 差し替えた札にも、行の日付が付く', () => {
      const next = replaceTaskCards(board, 'b', '- [ ] 見積を送る @2026-08-25 14:00\n');
      const last = next[next.length - 1]!;
      expect(last).toMatchObject({ date: '2026-08-25', time: '14:00' });
      // 🔑 記法は札の字から外れている(同じ日付が 1 枚の札に 2 回出ない)
      expect(last.text).toBe('見積を送る');
    });

    /**
     * ⚠ **日付だけを書き換えたときも「変わった」と読めること。**
     * 🔑 これが無いと、`sameCards` が日付を見ていないまま素通りし、
     *   **画面の日付が古いまま**残る(字は同じなので誰も気づけない)。
     */
    it('🔴 日付だけ変えても、据え置きにならない', () => {
      const first = replaceTaskCards(board, 'b', '- [ ] b0 @2026-08-25\n');
      const second = replaceTaskCards(first, 'b', '- [ ] b0 @2026-08-26\n');
      expect(second).not.toBe(first);
      expect(second[second.length - 1]?.date).toBe('2026-08-26');
    });
  });
});

/**
 * ⚠ **束ね方はここに無い**(#292 段⑤、2026-08-23)。`groupEntriesByDate` は落とした
 * ── 予定の面は**行の予定とノートの予定の両方**を束ねるので、ノートだけを見る
 * 関数では答えが半分になる。いまの正本は `features/schedule/agenda.ts`
 * (`tests/features/agenda.test.ts` / `tests/adapter/schedule-view.test.ts`)。
 * 🔑 ここに残すのは**升目の形**だけ ── 小さな月(予定の面の左上)が使う。
 */
describe('calendar-data(小さな月の升目)', () => {
  it('月間グリッド: 2026-08 は土曜始まり 31 日', () => {
    const grid = getMonthGrid(2026, 8);
    expect(grid[0]).toEqual([null, null, null, null, null, null, 1]); // 8/1 = Sat
    const days = grid.flat().filter((d) => d !== null);
    expect(days.length).toBe(31);
    expect(days[30]).toBe(31);
    expect(dateKey(2026, 8, 3)).toBe('2026-08-03');
  });
});

/**
 * 🔴 **変わっていないなら、同じ配列を返す**(2026-08-20)。
 *
 * ⚠ 2026-08-20 に「新しい本文が state に入る所は**全部**札を組み直す」へ広げた結果、
 *   `BODY_LOADED`(= **ノートを押すたび**に飛ぶ)もここを通るようになった。
 *   値が同じでも新しい配列を返していると、**押すだけで盤面の指紋が壊れ**、
 *   そのノートの札が毎回描き直される。
 * 🔑 だから**値で**突き合わせる ── `next` は毎回作り直すので、参照比較では
 *   「変わっていない」を 1 度も検出できない。
 */
describe('replaceTaskCards は、変わっていないなら据え置く(2026-08-20)', () => {
  const card = (lid: string, line: number, text: string, done = false) => ({
    lid,
    line,
    text,
    done,
    date: null,
    time: null,
    until: null,
    repeat: null,
  });
  /** ⚠ 項目が **0 行目と 5 行目**に来る本文(下の `card(…, 0/5, …)` と揃える)。 */
  const body = (doneSecond: boolean, first = 'あ', second = 'う'): string =>
    `- [ ] ${first}\n\n\n\n\n- [${doneSecond ? 'x' : ' '}] ${second}\n`;

  /**
   * 🔴 **期間だけが変わった回も「変わった」と見る**(#344 段①)。
   *
   * ⚠ 直す前の `sameCards` は日付と時刻しか見ていなかった ── 期間を足したとき
   *   ここを直し忘れると、`..` の**終わりだけ**を書き換えた回が「同じ」と判定され、
   *   **画面の期間が古いまま**残る(日付・時刻でまったく同じ穴を踏んでいる)。
   * ⚠ 他の欄は 1 つも動かさない fixture にしてある ── 動かすと、
   *   この検査は**別の欄のおかげで**通ってしまう(救い手が変わっただけ)。
   */
  it('🔴 期間の終わりだけが変わっても、据え置かない', () => {
    const before = taskCardsOf('a', '- [ ] 出張 @2026-08-25..2026-08-28\n');
    expect(before[0], '前提が崩れている ── 期間が読めていない').toMatchObject({
      date: '2026-08-25',
      until: '2026-08-28',
    });
    const next = replaceTaskCards(before, 'a', '- [ ] 出張 @2026-08-25..2026-08-30\n');
    expect(next, '期間が変わったのに据え置いた(画面の期間が古いまま残る)').not.toBe(before);
    expect(next[0]).toMatchObject({ date: '2026-08-25', until: '2026-08-30' });
  });

  /**
   * 🔴 **刻みだけが変わっても据え置かない**(#344 段②)── 期間とまったく同じ穴。
   * ⚠ 見落とすと、`毎週` を `毎月` に直した(あるいは消した)瞬間に
   *   **札が古い刻みのまま**残る ── 字も日付も同じなので、誰も気づけない。
   */
  it('🔴 刻みだけが変わっても、据え置かない', () => {
    const before = taskCardsOf('a', '- [ ] ゴミ出し @2026-08-25 毎週\n');
    expect(before[0], '前提が崩れている ── 刻みが読めていない').toMatchObject({
      date: '2026-08-25',
      repeat: 'week',
    });
    const next = replaceTaskCards(before, 'a', '- [ ] ゴミ出し @2026-08-25 毎月\n');
    expect(next, '刻みが変わったのに据え置いた(古い刻みのまま残る)').not.toBe(before);
    expect(next[0]).toMatchObject({ date: '2026-08-25', repeat: 'month' });
  });

  /** ⚠ 対照群 ── 本当に同じなら据え置く(上が「常に作り直す」で通らないように)。 */
  it('⚠ 対照群 ── 期間が同じなら据え置く', () => {
    const before = taskCardsOf('a', '- [ ] 出張 @2026-08-25..2026-08-28\n');
    expect(replaceTaskCards(before, 'a', '- [ ] 出張 @2026-08-25..2026-08-28\n')).toBe(before);
  });

  /**
   * ⚠ **同じ lid の札は連続させて置く** ── worker はノート順に返すので実際そうなる。
   *   飛び飛びの並びを渡すと、この関数は仕様どおり**まとめ直す**(D-3 の安全網)ので、
   *   「変わっていない」にはならない。1 稿目はそこを取り違えて落ちた。
   */
  it('🔴 同じ内容を渡したら、同じ配列オブジェクトが返る', () => {
    const cards = [card('a', 0, 'あ'), card('a', 5, 'う', true), card('b', 2, 'い')];
    const same = replaceTaskCards(cards, 'a', body(true));
    expect(same, '中身が同じなのに新しい配列を返した(押すたび描き直しになる)').toBe(cards);
  });

  /**
   * ⚠ **飛び飛びの並びは「変わった」側**でよい ── まとめ直すのが正しい動きなので、
   *   据え置いてはいけない(据え置くと札が 1 枚黙って消える D-3 の穴に戻る)。
   */
  it('飛び飛びに並んでいたら、まとめ直して新しい配列を返す', () => {
    const cards = [card('a', 0, 'あ'), card('b', 2, 'い'), card('a', 5, 'う', true)];
    const next = replaceTaskCards(cards, 'a', body(true));
    expect(next, 'まとめ直していない').not.toBe(cards);
    expect(next.map((c) => `${c.lid}${c.line}`)).toEqual(['a0', 'a5', 'b2']);
  });

  it('⚠ 空振り防止: 中身が変われば新しい配列になる', () => {
    const cards = [card('a', 0, 'あ'), card('b', 2, 'い')];
    expect(
      replaceTaskCards(cards, 'a', '- [x] あ\n'),
      '印が変わったのに据え置いた',
    ).not.toBe(cards);
    expect(
      replaceTaskCards(cards, 'a', '\n- [ ] あ\n'),
      '行番号が変わったのに据え置いた',
    ).not.toBe(cards);
    expect(
      replaceTaskCards(cards, 'a', '- [ ] ちがう\n'),
      '字が変わったのに据え置いた',
    ).not.toBe(cards);
    expect(replaceTaskCards(cards, 'a', ''), '札が消えたのに据え置いた').not.toBe(cards);
    // 🔴 **日付だけ**変わった場合(2026-08-23)── 字も印も行番号も同じ
    const dated = replaceTaskCards(cards, 'a', '- [ ] あ @2026-08-25\n');
    expect(
      replaceTaskCards(dated, 'a', '- [ ] あ @2026-08-26\n'),
      '日付が変わったのに据え置いた',
    ).not.toBe(dated);
  });

  /**
   * ⚠ **丸めた後で突き合わせる** ── 上限(200 字)を超える字は `clipTaskText` が
   *   切るので、切る前の字で比べると「変わっていない」を取り逃がす。
   */
  it('長い字は丸めた形で突き合わせる', () => {
    const long = 'あ'.repeat(300);
    const clipped = replaceTaskCards([card('a', 0, 'x')], 'a', `- [ ] ${long}\n`);
    const again = replaceTaskCards(clipped, 'a', `- [ ] ${long}\n`);
    expect(again, '丸めた後の字で比べていない').toBe(clipped);
  });
});
