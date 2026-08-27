/** @vitest-environment happy-dom */
/**
 * 🔴 **アラートの段取り**(#280)。
 *
 * ## user の物語
 *
 * `- [ ] 打ち合わせ @2026-08-27 14:00` と書いてある → 14:00 になる →
 * **音が鳴って、画面の下に帯が出る** → 押すとそのノートが開く。
 *
 * ## この test が守る主張
 *
 * ① 🔴 **時間になったら鳴る**(音 1 回 + 帯)
 * ② 🔴 **起動した瞬間に、過ぎた予定が全部鳴らない** ── 夕方に開いたら
 *    朝の予定が 5 件鳴る、を作らない
 * ③ 🔴 **同じ回を 2 度鳴らさない**
 * ④ 🔴 **設定が切なら何もしない**(音も帯も出ない)
 * ⑤ 🔴 **3 件同時でも音は 1 回**(連打は知らせにならない)
 * ⑥ 🔴 **時計が戻っても壊れない**
 * ⑦ 🔴 **止めたら刻みを外す**(常駐を作らない)
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { TaskCard, TaskScan } from '../../src/features/schedule/task-cards';
import { createAlarmService } from '../../src/adapter/ui/actions/alarm';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

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

function bench(opts: { cards?: TaskCard[]; enabled?: boolean; scan?: boolean } = {}) {
  const d = new Dispatcher();
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
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  if (opts.scan !== false) {
    const scan: TaskScan = {
      cards: opts.cards ?? [card()],
      totalNotes: 1,
      scannedNotes: 1,
      truncated: false,
    };
    d.dispatch({ type: 'SET_TASK_SCAN', scan });
  }

  let nowMs = at(13, 0);
  let beats: Array<() => void> = [];
  let chimes = 0;
  const painted: number[] = [];
  let on = opts.enabled ?? true;

  const service = createAlarmService({
    dispatcher: d,
    onChange: (due) => painted.push(due.length),
    chime: {
      play: async () => {
        chimes += 1;
        return true;
      },
    },
    now: () => nowMs,
    tick: (fn) => {
      beats.push(fn);
      return () => {
        beats = beats.filter((b) => b !== fn);
      };
    },
    enabled: () => on,
  });

  return {
    d,
    service,
    painted,
    chimes: () => chimes,
    beats: () => beats.length,
    subs: () => subs,
    setEnabled: (v: boolean) => (on = v),
    advanceTo: (h: number, m: number) => (nowMs = at(h, m)),
    beat: () => beats.forEach((b) => b()),
  };
}

describe('アラート(#280)', () => {
  it('🔴 ① 時間になったら、音が鳴って帯に出る', () => {
    const b = bench();
    b.service.start();
    expect(b.service.ringing(), '始めた瞬間に鳴った').toHaveLength(0);
    b.advanceTo(14, 0);
    b.beat();
    expect(b.service.ringing(), '時間になったのに鳴らない').toHaveLength(1);
    expect(b.chimes(), '音が鳴っていない').toBe(1);
    expect(b.painted.at(-1), '帯を描き直していない').toBe(1);
  });

  it('🔴 ② 起動した時点で過ぎている予定は鳴らさない', () => {
    // ⚠ 夕方に開いたら朝の予定が全部鳴る、を作らない
    const b = bench();
    b.advanceTo(18, 0);
    b.service.start();
    expect(b.service.ringing(), '過ぎた予定が鳴った').toHaveLength(0);
    expect(b.chimes()).toBe(0);
  });

  it('🔴 ③ 同じ回を 2 度鳴らさない', () => {
    const b = bench();
    b.service.start();
    b.advanceTo(14, 0);
    b.beat();
    b.service.dismiss(b.service.ringing()[0]!.key);
    b.advanceTo(14, 5);
    b.beat();
    expect(b.service.ringing(), '片付けたものがまた鳴った').toHaveLength(0);
    expect(b.chimes(), '2 度鳴った').toBe(1);
  });

  it('🔴 ④ 設定が切なら、何も起きない', () => {
    const b = bench({ enabled: false });
    b.service.start();
    b.advanceTo(14, 0);
    b.beat();
    expect(b.service.ringing()).toHaveLength(0);
    expect(b.chimes()).toBe(0);
  });

  it('🔴 ④ 途中で入にしたら、そこから効く(読み込み直さなくてよい)', () => {
    const b = bench({ enabled: false });
    b.service.start();
    b.setEnabled(true);
    b.advanceTo(13, 30);
    b.beat(); // ⚠ 入にしてから最初の刻み ── ここで「どこから見るか」が決まる
    b.advanceTo(14, 0);
    b.beat();
    expect(b.service.ringing(), '入にしたのに鳴らない').toHaveLength(1);
  });

  it('🔴 ⑤ 同じ回に 3 件来ても、音は 1 回', () => {
    const b = bench({
      cards: [
        card({ line: 1, time: '14:00' }),
        card({ line: 2, time: '14:00' }),
        card({ line: 3, time: '14:00' }),
      ],
    });
    b.service.start();
    b.advanceTo(14, 0);
    b.beat();
    expect(b.service.ringing(), '3 件とも出ていない').toHaveLength(3);
    expect(b.chimes(), '件数ぶん鳴らしている').toBe(1);
  });

  it('🔴 ③ 時計が戻っても、同じ回は 2 度鳴らない', () => {
    /**
     * 🔴 **「もう鳴らした」を憶えている**ことを、ここだけが見ている
     *   (変異試験 A8 が SURVIVED で教えた)── 普段は区間の左端が前へ進むので
     *   2 度目が来ないが、**時計が戻ると同じ回が区間に入り直す**。
     */
    const b = bench();
    b.service.start();
    b.advanceTo(14, 0);
    b.beat();
    expect(b.chimes()).toBe(1);
    b.service.dismissAll();
    b.advanceTo(13, 0); // 時計が戻った
    b.beat();
    b.advanceTo(14, 30); // また 14:00 をまたぐ
    b.beat();
    expect(b.service.ringing(), '同じ回がまた鳴った').toHaveLength(0);
    expect(b.chimes(), '同じ回で 2 度鳴らした').toBe(1);
  });

  it('🔴 ⑥ 時計が戻っても壊れない(見た位置を寄せ直すだけ)', () => {
    const b = bench();
    b.service.start();
    b.advanceTo(12, 0); // 戻った
    b.beat();
    b.advanceTo(14, 0);
    b.beat();
    expect(b.service.ringing(), '戻った後に鳴らなくなった').toHaveLength(1);
  });

  it('⚠ 予定をまだ数えていなければ、何も起きない(「集めていない」は「無い」ではない)', () => {
    const b = bench({ scan: false });
    b.service.start();
    b.advanceTo(14, 0);
    b.beat();
    expect(b.service.ringing()).toHaveLength(0);
    expect(b.chimes()).toBe(0);
  });

  it('🔴 ⑦ 止めたら刻みを外す(常駐を作らない)', () => {
    const b = bench();
    expect(b.beats(), '始める前から刻んでいる').toBe(0);
    b.service.start();
    expect(b.beats(), '始めたのに刻んでいない').toBe(1);
    b.service.start();
    expect(b.beats(), '2 本張った').toBe(1);
    b.service.stop();
    expect(b.beats(), '止めたのに刻みが残っている').toBe(0);
  });

  it('⚠ 全部片付けられる(1 件ずつ押させない)', () => {
    const b = bench({ cards: [card({ line: 1 }), card({ line: 2 })] });
    b.service.start();
    b.advanceTo(14, 0);
    b.beat();
    expect(b.service.ringing()).toHaveLength(2);
    b.service.dismissAll();
    expect(b.service.ringing()).toHaveLength(0);
    expect(b.painted.at(-1), '畳んだのに帯を描き直していない').toBe(0);
  });
});
