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
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { TaskCard, TaskScan } from '../../src/features/schedule/task-cards';
import {
  ALARM_MAX_GAP_MS,
  ALARM_SCAN_FAILED_TEXT,
  ALARM_SCAN_TRUNCATED_TEXT,
  createAlarmService,
} from '../../src/adapter/ui/actions/alarm';
import { missedLabel } from '../../src/features/schedule/schedule-notify';

function meta(lid: string, archived = false): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived,
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

function bench(
  opts: {
    cards?: TaskCard[];
    enabled?: boolean;
    scan?: boolean;
    ringer?: () => boolean;
    archived?: boolean;
  } = {},
) {
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
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', opts.archived ?? false)], relations: [] });
  if (opts.scan !== false) {
    const scan: TaskScan = {
      cards: opts.cards ?? [card()],
      totalNotes: 1,
      scannedNotes: 1,
      truncated: false,
    };
    d.dispatch({ type: 'SET_TASK_SCAN', scan });
  }

  /** 目標の時刻(`advanceTo`)と、サービスが読む時計。`beat()` は時計を目標まで 1 分ずつ歩かせる。 */
  let nowMs = at(13, 0);
  let clock = nowMs;
  let beats: Array<() => void> = [];
  let chimes = 0;
  const painted: number[] = [];
  let on = opts.enabled ?? true;
  const posts: string[] = [];

  const service = createAlarmService({
    dispatcher: d,
    onChange: (due) => painted.push(due.length),
    chime: {
      play: async () => {
        chimes += 1;
        return true;
      },
    },
    now: () => clock,
    tick: (fn) => {
      beats.push(fn);
      return () => {
        beats = beats.filter((b) => b !== fn);
      };
    },
    enabled: () => on,
    ...(opts.ringer === undefined ? {} : { isRinger: opts.ringer }),
    post: (t) => posts.push(t),
  });

  return {
    d,
    service,
    painted,
    posts,
    chimes: () => chimes,
    beats: () => beats.length,
    subs: () => subs,
    setEnabled: (v: boolean) => (on = v),
    advanceTo: (h: number, m: number) => (nowMs = at(h, m)),
    advanceMs: (ms: number) => (nowMs += ms),
    /**
     * 時計を目標まで **1 分ずつ**歩かせて刻む(ふつうの間引きの空きに収める ── 一度に何時間も飛ぶと
     * 「眠っていた」扱いで鳴らさなくなったので、ふつうの経過はこちらで表す)。戻る方向は 1 回で寄せる。
     */
    beat: () => {
      if (nowMs <= clock) {
        clock = nowMs;
        beats.forEach((b) => b());
        return;
      }
      while (clock < nowMs) {
        clock = Math.min(clock + 60_000, nowMs);
        beats.forEach((b) => b());
      }
    },
    /** 時計を目標へ **一度に**飛ばして 1 回だけ刻む(眠っていた端末の復帰)。 */
    jump: () => {
      clock = nowMs;
      beats.forEach((b) => b());
    },
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

  it('🔴 片付けたノートの予定は鳴らない(#1087)。対照群: 同じ予定でも片付けていなければ鳴る', () => {
    const arch = bench({ archived: true });
    arch.service.start();
    arch.advanceTo(14, 0);
    arch.beat();
    expect(arch.service.ringing(), '片付けたノートの予定が鳴った').toHaveLength(0);
    expect(arch.chimes()).toBe(0);
    const live = bench();
    live.service.start();
    live.advanceTo(14, 0);
    live.beat();
    expect(live.service.ringing(), '対照群が鳴っていない').toHaveLength(1);
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

  it('🔴 ④ 切っていた間に過ぎた予定は、入れ直してもまとめて鳴らない(2026-10-13)', () => {
    // ⚠ 直す前は、切る前に見た時刻を覚えたままだったので、入れ直した最初の確認で
    //   (切る前の時刻, いま] を見て、切っていた間の 14:00 が鳴った
    const b = bench();
    b.service.start();
    b.advanceTo(13, 30);
    b.beat();
    b.setEnabled(false);
    b.advanceTo(15, 0);
    b.beat();
    b.setEnabled(true);
    b.advanceTo(15, 1);
    b.beat();
    expect(b.service.ringing(), '切っていた間に過ぎた予定が鳴った').toHaveLength(0);
    expect(b.chimes()).toBe(0);
  });

  it('対照群:入れ直した後に来た時刻は鳴る', () => {
    const b = bench({ cards: [card({ time: '16:00' })] });
    b.service.start();
    b.setEnabled(false);
    b.advanceTo(15, 0);
    b.beat();
    b.setEnabled(true);
    b.beat();
    b.advanceTo(16, 0);
    b.beat();
    expect(b.service.ringing()).toHaveLength(1);
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

  /**
   * 🔴 ⑧ 開いているタブの数だけ同じ予定が鳴らない(#1087)。
   *   2 つのサービス(= 2 つのタブ)を同じ時刻で回し、鳴らす役を持つ側だけが鳴らす。
   */
  it('🔴 ⑧ 2 つのタブで同じ時刻を回しても、鳴らすのは本体のタブの 1 つだけ', () => {
    const tabA = bench({ ringer: () => true });
    const tabB = bench({ ringer: () => false });
    for (const t of [tabA, tabB]) t.service.start();
    for (const t of [tabA, tabB]) {
      t.advanceTo(14, 0);
      t.beat();
    }
    expect(tabA.chimes() + tabB.chimes(), '同じ予定が 2 つのタブで鳴った').toBe(1);
    expect(tabA.service.ringing(), '本体のタブが鳴らしていない(誰も鳴らさない窓)').toHaveLength(1);
    expect(tabB.service.ringing(), '本体でないタブにも帯が出ている').toHaveLength(0);
  });

  it('🔴 ⑧ 本体が移ったら、新しい本体が引き継いで鳴らす(誰も鳴らさない窓を作らない)', () => {
    let holder = false;
    const b = bench({ ringer: () => holder });
    b.service.start();
    b.advanceTo(13, 59);
    b.beat(); // 本体でない間(1 時間)も、見た位置は進む
    holder = true; // 本体が閉じて、このタブが引き継いだ
    b.advanceTo(14, 0);
    b.jump(); // 引き継いだ直後の刻み(空きは 2 分以内)
    expect(b.service.ringing(), '引き継いだのに鳴らない').toHaveLength(1);
    expect(b.chimes()).toBe(1);
    expect(b.posts, '引き継いだだけで見逃し扱いにした').toEqual([]);
  });

  it('🔴 ⑧ 本体でない間は、時間が来ても鳴らさない', () => {
    const b = bench({ ringer: () => false });
    b.service.start();
    b.advanceTo(14, 0);
    b.beat();
    b.advanceMs(30_000);
    b.beat();
    expect(b.chimes()).toBe(0);
    expect(b.service.ringing()).toHaveLength(0);
  });

  /**
   * 🔴 ⑨ 眠っていた間の予定は、復帰した瞬間にまとめて鳴らさない(#1087)。
   *   代わりに「見逃した予定」として 1 件、次に開いたときの知らせと同じ字で積む。
   */
  it('🔴 ⑨ 長い空き(眠っていた端末の復帰)では鳴らさず、見逃した予定として集積地に 1 件積む', () => {
    const b = bench({ cards: [card({ line: 1, time: '14:00' }), card({ line: 2, time: '15:00' })] });
    b.service.start();
    b.advanceTo(16, 0); // 3 時間眠っていた
    b.jump();
    expect(b.chimes(), '復帰した瞬間に鳴った').toBe(0);
    expect(b.service.ringing(), '復帰した瞬間に帯が出た').toHaveLength(0);
    expect(b.posts, '見逃した予定が 1 件積まれていない').toEqual([missedLabel(2)]);
    // 見た位置は寄せてある ── 次の刻みで同じ区間を数え直さない
    b.advanceMs(30_000);
    b.beat();
    expect(b.posts, '同じ区間をもう一度積んだ').toHaveLength(1);
  });

  it('🔴 長い空きの「見逃した予定」にも、片付けたノートの予定は数えない(#1087)', () => {
    const b = bench({ archived: true });
    b.service.start();
    b.advanceTo(16, 0);
    b.jump();
    expect(b.posts, '片付けたノートの予定を見逃しに積んだ').toEqual([]);
  });

  it('対照群:ふつうの間引き(1 分強の空き)なら、遅れても鳴る', () => {
    const b = bench();
    b.service.start();
    b.advanceTo(13, 59);
    b.beat();
    b.advanceMs(ALARM_MAX_GAP_MS); // 空きがちょうど上限 ── 超えていない
    b.jump();
    expect(b.service.ringing(), '間引かれただけの回が鳴らない').toHaveLength(1);
    expect(b.posts).toEqual([]);
  });

  it('境目:上限を 1ms でも超えたら鳴らさない', () => {
    const b = bench();
    b.service.start();
    b.advanceTo(13, 59);
    b.beat();
    b.advanceMs(ALARM_MAX_GAP_MS + 1);
    b.jump();
    expect(b.service.ringing(), '上限を超えたのに鳴った').toHaveLength(0);
    expect(b.posts).toEqual([missedLabel(1)]);
  });

  it('⚠ 長い空きでも、見逃しが 0 件なら何も積まない', () => {
    const b = bench({ cards: [card({ time: '09:00' })] });
    b.service.start();
    b.advanceTo(16, 0);
    b.jump();
    expect(b.posts).toEqual([]);
  });

  /** 🔴 ⑩ 数えられていないことを黙らない(#1087)。 */
  it('🔴 ⑩ 予定の集計に失敗している間は、1 回だけ「お知らせできません」と積む', () => {
    const b = bench();
    b.service.start();
    b.d.dispatch({ type: 'TASK_SCAN_FAILED' });
    expect(b.d.getState().taskScanFailed, '前提が崩れている ── 失敗が立っていない').toBe(true);
    b.advanceMs(30_000);
    b.beat();
    b.advanceMs(30_000);
    b.beat();
    expect(b.posts, '失敗を 1 回だけ言う').toEqual([ALARM_SCAN_FAILED_TEXT]);
    // 直ったら、また失敗したときに言い直す
    b.d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: { cards: [], totalNotes: 0, scannedNotes: 0, truncated: false },
    });
    b.advanceMs(30_000);
    b.beat();
    b.d.dispatch({ type: 'TASK_SCAN_FAILED' });
    b.advanceMs(30_000);
    b.beat();
    expect(b.posts, '直った後の失敗を言っていない').toEqual([ALARM_SCAN_FAILED_TEXT, ALARM_SCAN_FAILED_TEXT]);
  });

  it('🔴 上限で切れている間は 1 回だけ「鳴らないことがあります」と積み、直ってまた切れたら言い直す', () => {
    const b = bench();
    const scanOf = (truncated: boolean) => ({
      type: 'SET_TASK_SCAN' as const,
      scan: { cards: [], totalNotes: 600, scannedNotes: 500, truncated },
    });
    b.service.start();
    b.d.dispatch(scanOf(true));
    b.advanceMs(30_000);
    b.beat();
    b.advanceMs(30_000);
    b.beat();
    expect(b.posts, '切れていることを 1 回だけ言う').toEqual([ALARM_SCAN_TRUNCATED_TEXT]);
    b.d.dispatch(scanOf(false));
    b.advanceMs(30_000);
    b.beat();
    expect(b.posts, '直ったのに言い足した').toEqual([ALARM_SCAN_TRUNCATED_TEXT]);
    b.d.dispatch(scanOf(true));
    b.advanceMs(30_000);
    b.beat();
    expect(b.posts, '直った後にまた切れたのを言っていない').toEqual([ALARM_SCAN_TRUNCATED_TEXT, ALARM_SCAN_TRUNCATED_TEXT]);
  });

  it('対照群:集計できているなら、失敗の知らせは積まない', () => {
    const b = bench();
    b.service.start();
    b.advanceMs(30_000);
    b.beat();
    expect(b.posts).toEqual([]);
  });

  /** 🔴 ⑪ 入にした直後の最大 30 秒を見る(#1087)。 */
  it('🔴 ⑪ 入にした直後に来た予定を、次の刻みを待たずに取りこぼさない', () => {
    const b = bench({ enabled: false });
    b.service.start(); // 切のまま刻みは張ってある
    b.advanceTo(13, 59);
    b.jump(); // 切の間の刻み(見た位置は持たない)
    b.setEnabled(true);
    b.service.check(); // 入にした直後(main.ts の setAlarmEnabled が呼ぶ)── 13:59 から見る
    b.advanceTo(14, 0);
    b.jump(); // 入にしてから最初の刻み ── 区間は (13:59, 14:00]
    expect(b.service.ringing(), '入にした直後の予定を取りこぼした').toHaveLength(1);
  });

  it('🔴 数え直しの最中(taskScan が null)に刻みが来ても、その間の予定を取りこぼさない', () => {
    const b = bench();
    b.service.start(); // 13:00
    b.advanceTo(13, 59);
    b.beat();
    // 別の container を読み込んだ → 札が null に戻る窓で、14:00 をまたぐ刻みが来る
    // ⚠ 同じ container の読み直し(別のタブの保存)では札を残す(#1087)── null の窓は container が変わったときだけ
    b.d.dispatch({ type: 'SYS_BOOTED', cid: 'c-other', metas: [meta('a')], relations: [] });
    expect(b.d.getState().taskScan, '前提: 札が null になっていない').toBeNull();
    b.advanceTo(14, 0);
    b.beat();
    expect(b.service.ringing(), '数え直し中は鳴らさない').toHaveLength(0);
    // 札が戻った次の刻み ── 見た位置を進めていなければ、ここで 14:00 を拾う
    b.d.dispatch({ type: 'SET_TASK_SCAN', scan: { cards: [card()], totalNotes: 1, scannedNotes: 1, truncated: false } });
    b.advanceTo(14, 1);
    b.beat();
    expect(b.service.ringing(), '数え直し中の刻みで見た位置を進めて、予定が消えた').toHaveLength(1);
    expect(b.chimes()).toBe(1);
  });

  it('🔴 同じ container の読み直し(別のタブの保存)では札が残り、その間の予定も鳴る(#1087)', () => {
    const b = bench();
    b.service.start(); // 13:00
    b.advanceTo(13, 59);
    b.beat();
    b.d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    expect(b.d.getState().taskScan, '同じ container なのに札が消えた').not.toBeNull();
    b.advanceTo(14, 0);
    b.beat();
    expect(b.service.ringing(), '読み直しの間に予定を取りこぼした').toHaveLength(1);
  });

  /** ⚠ main.ts はどの test からも走らない ── 配線は原文で pin する(弱いと自覚して使う)。 */
  it('🔴 ⑧ main.ts は、予定の知らせと見逃しの知らせの両方に「本体のタブだけ」を渡し、入にした直後に見る', () => {
    const main = readFileSync('src/main.ts', 'utf-8');
    expect(main.split('isRinger: () => writerHolder,').length - 1, '渡す先が 2 つ(鳴らす / 見逃し)').toBe(2);
    const at = main.indexOf('setAlarmEnabled: (on) => {');
    expect(at, '前提が崩れている ── setAlarmEnabled が無い').toBeGreaterThan(0);
    expect(main.slice(at, at + 400), '入にした直後に見ていない').toContain('alarmService.check();');
  });
});
