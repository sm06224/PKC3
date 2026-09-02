/** @vitest-environment happy-dom */
/**
 * 🔴 **タイマーの段取り**(#279)。
 *
 * ## user の物語
 *
 * 資料を書いている → 「計る」を押す → 30 分書く → 「止める」→
 * **そのノートの本文に作業時間の 1 行が入っている**。
 *
 * ## この test が守る主張
 *
 * ① 🔴 **止めると本文に入る**(計った時間が行き場を失わない)
 * ② 🔴 **始める前に断る** ── ノート未選択 / 追記できない種類 / 2 本目
 *    ⚠ 止めてから断ると、**計った時間の行き場が無い**
 * ③ 🔴 **止めた瞬間に時計が止まる** ── 書けるまで待つ実装だと、
 *    待っている間も経過が伸びて**記録が実際より長くなる**
 * ④ 🔴 **書けない回は預かって、編集を終えたら書く**(黙って捨てない)
 * ⑤ 🔴 **捨てたら本文に触らない**
 * ⑥ 🔴 **刻みは走っている間だけ張る**(0 本になったら外す ── 常駐を作らない)
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { createTimerService } from '../../src/adapter/ui/actions/timer';
import type { TimerRun } from '../../src/features/timer/timer-run';

function meta(lid: string, archetype: string, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const T0 = new Date(2026, 7, 27, 6, 40, 0).getTime();

function bench(opts: { archetype?: string; select?: boolean; keepLock?: boolean } = {}) {
  const d = new Dispatcher();
  /** ⚠ **見張りの本数を数える**(外し忘れは state からは見えない)。 */
  let subs = 0;
  const realOnState = d.onState.bind(d);
  (d as unknown as { onState: Dispatcher['onState'] }).onState = (l) => {
    subs += 1;
    const off = realOnState(l);
    return () => {
      subs -= 1;
      off();
    };
  };
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', opts.archetype ?? 'text', '資料'), meta('b', 'text', '別のノート')],
    relations: [],
  });
  if (opts.select !== false) {
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    /**
     * ⚠ **本文を読めたことにする** ── `START_EDIT` は `openBody` が現選択の
     *   本文を持っているときだけ効く。⚠ これを撃たないと編集に入れず、
     *   「編集中は預かる」の test が**一度も編集中を通らないまま緑になる**
     *   (CLAUDE.md §2「弱いのではなく走っていない」)。
     */
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
  }
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  /** ⚠ **書込が着いたことにする**(§3「stub は本物の意味論を真似る」)。 */
  d.onEvent((e) => {
    if (e.type !== 'REQUEST_APPEND' || opts.keepLock === true) return;
    const { lid, gen } = e;
    queueMicrotask(() =>
      d.dispatch({
        type: 'ENTRY_APPENDED',
        lid,
        gen,
        body: '本文',
        status: null,
        date: null,
        archived: false,
        inserted: null,
      }),
    );
  });

  const notices: string[] = [];
  const painted: TimerRun[][] = [];
  let beats: Array<() => void> = [];
  let nowMs = T0;

  const service = createTimerService({
    dispatcher: d,
    onChange: (runs) => painted.push([...runs]),
    notify: (t) => notices.push(t),
    now: () => nowMs,
    tick: (fn) => {
      beats.push(fn);
      return () => {
        beats = beats.filter((b) => b !== fn);
      };
    },
  });

  return {
    d,
    events,
    notices,
    painted,
    service,
    /** 時計を進める(実時間を待たない)。 */
    advance: (ms: number) => (nowMs += ms),
    /** 刻みを手で撃つ。 */
    beat: () => beats.forEach((b) => b()),
    beats: () => beats.length,
    subs: () => subs,
    errors: () => d.getState().error,
    appends: () => events.filter((e) => e.type === 'REQUEST_APPEND'),
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('タイマー(#279)', () => {
  it('🔴 ① 止めると、そのノートの本文に作業時間が入る', async () => {
    const b = bench();
    b.service.start();
    b.advance(23 * 60_000 + 11_000);
    b.service.stop('a');
    await settle();

    const [ap] = b.appends();
    expect(ap, '本文へ書いていない').toBeDefined();
    expect(ap && ap.type === 'REQUEST_APPEND' && ap.lid).toBe('a');
    expect(b.d.getState().entryMetas.get('a')?.title, '相手を取り違えている').toBe('資料');
    expect(b.notices.join('\n'), '何を書いたか言っていない').toContain(
      '作業 2026-08-27 06:40–07:03(23:11)',
    );
  });

  /**
   * 🔴 **「ノートを開いていない」の断りは `binder` へ移した**(user 裁定 2026-09-02
   * 「**4 つとも先に断る**」)── 添付 / 録音 / 画面録画 / 計測で断り方が食い違わない
   * よう、判定は `NOTE_TOOL_ACTIONS` の門 1 か所である
   * (文言の pin は `tests/adapter/note-tools-guard.test.ts`)。
   *
   * ⚠ ここで守るのは**残りの半分** ── 門を素通りしても
   *   **計り始めない**(時間の行き先が無いまま数え始めない)。
   */
  it('🔴 ② ノートが読めないときは計り始めない', () => {
    const b = bench({ select: false });
    b.service.start();
    expect(b.service.runs(), '計り始めてしまった').toHaveLength(0);
    expect(b.errors()).toContain('読めない');
  });

  it('🔴 ② 追記できない種類は、始める前に断る(止めてからでは遅い)', () => {
    const b = bench({ archetype: 'attachment' });
    b.service.start();
    expect(b.service.runs(), '計り始めてしまった').toHaveLength(0);
    expect(b.errors()).toContain('追記できない種類');
  });

  it('🔴 ② 同じノートの 2 本目は断る(二重に数えない)', () => {
    const b = bench();
    b.service.start();
    b.service.start();
    expect(b.service.runs(), '同じノートを 2 本計っている').toHaveLength(1);
    expect(b.errors()).toContain('もう計っています');
  });

  it('🔴 別のノートなら 2 本目を持てる(複数同時)', () => {
    const b = bench();
    b.service.start();
    b.d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    b.service.start();
    expect(b.service.runs().map((r) => r.lid)).toEqual(['a', 'b']);
  });

  it('🔴 ③ 止めた瞬間に時計が止まる(書けるまで待つ間に伸びない)', async () => {
    // ⚠ 編集中(= 本文を書けない)に止める。**預かっている間に時計が進む**
    const b = bench();
    b.service.start();
    b.advance(10 * 60_000);
    b.d.dispatch({ type: 'START_EDIT' });
    expect(b.d.getState().phase, '前提が崩れている ── 編集に入れていない').toBe('editing');
    b.service.stop('a');
    b.advance(60 * 60_000); // 預かっている間に 1 時間ぶん経つ
    b.d.dispatch({ type: 'CANCEL_EDIT' });
    await settle();

    const [ap] = b.appends();
    const text = ap && ap.type === 'REQUEST_APPEND' ? ap.text : '';
    expect(text, '預かっている間の時間まで数えている').toContain('(10:00)');
  });

  it('🔴 ④ 書けない回は預かって、編集を終えたら書く(黙って捨てない)', async () => {
    const b = bench();
    b.service.start();
    b.advance(60_000);
    b.d.dispatch({ type: 'START_EDIT' });
    expect(b.d.getState().phase, '前提が崩れている ── 編集に入れていない').toBe('editing');
    b.service.stop('a');
    await settle();
    expect(b.appends(), '編集中なのに書けている(reducer が捨てている)').toHaveLength(0);
    expect(b.notices.join('\n'), '預かったことを言っていない').toContain('預かりました');

    b.d.dispatch({ type: 'CANCEL_EDIT' });
    await settle();
    expect(b.appends(), '編集を終えても書かれていない').toHaveLength(1);
  });

  it('🔴 ⑤ 捨てたら本文に触らない', async () => {
    const b = bench();
    b.service.start();
    b.advance(60_000);
    b.service.discard('a');
    await settle();
    expect(b.appends(), '捨てたのに本文へ書いた').toHaveLength(0);
    expect(b.service.runs()).toHaveLength(0);
    expect(b.notices.join('\n')).toContain('捨てました');
  });

  it('🔴 ⑥ 刻みは走っている間だけ張る(0 本で外す)', () => {
    const b = bench();
    expect(b.beats(), '計っていないのに刻んでいる').toBe(0);
    b.service.start();
    expect(b.beats(), '計っているのに刻んでいない').toBe(1);
    b.d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    b.service.start();
    expect(b.beats(), '本数ぶん刻みを張っている').toBe(1);
    b.service.discard('a');
    expect(b.beats(), '1 本残っているのに外した').toBe(1);
    b.service.discard('b');
    expect(b.beats(), '0 本になったのに刻みが残っている').toBe(0);
  });

  it('🔴 刻むたびに帯が描き直される(経過が止まって見えない)', () => {
    const b = bench();
    b.service.start();
    const before = b.painted.length;
    b.advance(1000);
    b.beat();
    expect(b.painted.length, '刻んでも描き直していない').toBe(before + 1);
  });

  it('⚠ ノートが消えていたら、経過を字に出す(黙って失わせない)', async () => {
    const b = bench();
    b.service.start();
    b.advance(5 * 60_000);
    b.d.dispatch({ type: 'DELETE_ENTRY', lid: 'a' });
    b.service.stop('a');
    await settle();
    expect(b.appends(), '消えたノートへ書きに行った').toHaveLength(0);
    /**
     * ⚠ **どの門が鳴ったのかを文言で見分ける**(CLAUDE.md §1)── 経過の字
     *   (`(5:00)`)だけを見ると、**門を外しても**「書きました」の側の知らせに
     *   同じ字が入るので**生き延びる**(変異試験 T6 が SURVIVED で教えた)。
     */
    expect(b.notices.join('\n'), '見つからないことを言っていない').toContain(
      '見つからないので本文に入れていません',
    );
    expect(b.notices.join('\n'), '計った時間を字に出していない').toContain('(5:00)');
  });

  it('⚠ 走っていない相手を止めても何も起きない(二重に押しても増えない)', async () => {
    const b = bench();
    b.service.stop('a');
    b.service.discard('a');
    await settle();
    expect(b.appends()).toHaveLength(0);
    expect(b.notices, '走っていないのに何か言った').toEqual([]);
  });

  it('⚠ 預かりの見張りは、書き終えたら外す(常駐を作らない)', async () => {
    const b = bench();
    const base = b.subs();
    b.service.start();
    b.d.dispatch({ type: 'START_EDIT' });
    expect(b.d.getState().phase, '前提が崩れている ── 編集に入れていない').toBe('editing');
    b.service.stop('a');
    expect(b.subs(), '預かったのに見張っていない').toBe(base + 1);
    b.d.dispatch({ type: 'CANCEL_EDIT' });
    await settle();
    expect(b.subs(), '書き終えたのに見張りが残っている').toBe(base);
  });
});
