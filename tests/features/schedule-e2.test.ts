/** @vitest-environment node */
/**
 * 台帳 #1852 束 E2(予定表の見え方と知らせ)の、DOM を使わない部分。
 *
 * 守る主張:
 * - 191: 週の始まり(日曜 / 月曜)で「週」「月」の並びが変わる。日付そのものは変わらない
 * - 190: 夜をまたぐ幅(`22:00..02:00`)は書ける。その日の目盛りは下端まで / 札の字は「翌」/ 動かすと終わりも動く
 * - 287: 右のペインの「N / M 完了」は、繰り返しの規則の行を数えない
 * - 286B: 「全部動かす」の確認に、以前に 1 回だけ動かした回の数を出す材料
 * - 76: メインの入れ替わりの 1 行は、別のウィンドウでは「ウィンドウ」と言う
 * - 100-2 / 100-3: 並べ替えたあとのカーソル / 打ち間違えた名前の知らせ
 * - 347: 帯をほかのウィンドウへ放送する(本体だけが片付けの正本)
 */
import { describe, expect, it } from 'vitest';
import { weekOf, pieceOf } from '../../src/features/schedule/day-layout';
import { getMonthGrid } from '../../src/features/schedule/month-grid';
import {
  columnOf,
  normalizeWeekStart,
  weekdayHeads,
  weekStartLabel,
} from '../../src/features/schedule/week-start';
import { ScheduleWeekStartStore } from '../../src/adapter/ui/render/schedule-week-start';
import { countDrawnTasks } from '../../src/features/markdown/task-drawn';
import { movedOccurrenceCount } from '../../src/features/schedule/repeat';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import { promotedLine } from '../../src/adapter/platform/view-window';
import { caretAfterReplace, sortTasksByStatus } from '../../src/features/markdown/task-sort';
import { explainCalcMiss, resolveInlineCalc } from '../../src/features/markdown/inline-calc';
import {
  ALARM_BAR_STATE,
  createAlarmBarSync,
} from '../../src/adapter/platform/alarm-bar-sync';
import type { AlarmDue } from '../../src/features/alarm/alarm-due';
import type { Broadcaster } from '../../src/adapter/platform/storage/store-proxy';

describe('191: 週の始まり', () => {
  // 2026-10-17 は土曜
  it('日曜始まり(既定)── 週は日曜から土曜', () => {
    expect(weekOf('2026-10-17')).toEqual([
      '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17',
    ]);
    expect(weekOf('2026-10-17', 0)).toEqual(weekOf('2026-10-17'));
  });

  it('月曜始まり ── 週は月曜から日曜。土曜も日曜も、その週に入る', () => {
    expect(weekOf('2026-10-17', 1)![0]).toBe('2026-10-12');
    expect(weekOf('2026-10-17', 1)![6]).toBe('2026-10-18');
    // 日曜は前の週の最後(日曜始まりなら次の週の最初)
    expect(weekOf('2026-10-18', 1)![0]).toBe('2026-10-12');
    expect(weekOf('2026-10-18', 0)![0]).toBe('2026-10-18');
    // 月曜は月曜始まりなら週の最初
    expect(weekOf('2026-10-12', 1)![0]).toBe('2026-10-12');
  });

  it('実在しない日は、どちらでも null(別の週へ寄せない)', () => {
    expect(weekOf('2026-02-30', 1)).toBeNull();
  });

  it('見出し ── 月曜始まりは月から日。土日の印は並びの位置ではなく曜日で決まる', () => {
    expect(weekdayHeads(0).map((h) => h.label).join('')).toBe('日月火水木金土');
    expect(weekdayHeads(1).map((h) => h.label).join('')).toBe('月火水木金土日');
    expect(weekdayHeads(1).filter((h) => h.dow === 0 || h.dow === 6).map((h) => h.label)).toEqual(['土', '日']);
    expect(columnOf(0, 1)).toBe(6);
    expect(columnOf(1, 1)).toBe(0);
    expect(columnOf(0, 0)).toBe(0);
  });

  it('月の升目 ── 1 日の位置が変わる(2026 年 10 月 1 日は木曜)', () => {
    const sun = getMonthGrid(2026, 10, 0);
    const mon = getMonthGrid(2026, 10, 1);
    expect(sun[0]!.indexOf(1)).toBe(4);
    expect(mon[0]!.indexOf(1)).toBe(3);
    // 日付の総数は変わらない(31 日が 1 回ずつ)
    const flat = (g: (number | null)[][]): number[] => g.flat().filter((d): d is number => d !== null);
    expect(flat(sun)).toEqual(flat(mon));
    expect(flat(mon)).toHaveLength(31);
    // 日曜始まりが既定
    expect(getMonthGrid(2026, 10)).toEqual(sun);
    // 日曜が月の初日(2026 年 3 月 1 日)── 月曜始まりでは最後の列
    expect(getMonthGrid(2026, 3, 1)[0]!.indexOf(1)).toBe(6);
  });

  it('好みの読み書き ── 読めない値は日曜始まりへ倒す / 書き込みが失敗しても控えを返す', () => {
    expect(normalizeWeekStart('1')).toBe(1);
    expect(normalizeWeekStart(1)).toBe(1);
    for (const bad of ['0', '2', '', 'x', null, undefined, -1, '月曜']) expect(normalizeWeekStart(bad)).toBe(0);
    expect(weekStartLabel(0)).toBe('日曜始まり');
    expect(weekStartLabel(1)).toBe('月曜始まり');

    const data = new Map<string, string>();
    const store = new ScheduleWeekStartStore({
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
    });
    let told = 0;
    store.subscribe(() => (told += 1));
    expect(store.get()).toBe(0);
    store.set(1);
    expect(data.get('pkc3.schedule-week-start')).toBe('1');
    expect(store.get()).toBe(1);
    expect(told, '変えたことを描き手に知らせていない').toBe(1);
    data.set('pkc3.schedule-week-start', 'ゴミ');
    expect(store.get(), '読めない保存値は既定').toBe(0);

    const broken = new ScheduleWeekStartStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    });
    broken.set(1);
    expect(broken.get(), '保存できなかったのに、この session で効いていない').toBe(1);
    const none = new ScheduleWeekStartStore(null);
    none.set(1);
    expect(none.get()).toBe(1);
  });
});

describe('190: 夜をまたぐ幅は、その日の目盛りの下端まで', () => {
  it('22:00..02:00 は 22:00 から下端(24:00)まで。同じ日の幅と、終わりの無い予定は今までどおり', () => {
    expect(pieceOf('k', '22:00', '02:00')).toEqual({ key: 'k', startMin: 22 * 60, endMin: 24 * 60 });
    expect(pieceOf('k', '14:00', '15:00')).toEqual({ key: 'k', startMin: 14 * 60, endMin: 15 * 60 });
    expect(pieceOf('k', '14:00', null)).toEqual({ key: 'k', startMin: 14 * 60, endMin: 14 * 60 + 30 });
    // 幅 0 は夜をまたぐとは読まない(既定の長さ)
    expect(pieceOf('k', '14:00', '14:00')).toEqual({ key: 'k', startMin: 14 * 60, endMin: 14 * 60 + 30 });
  });
});

describe('287: 「N / M 完了」は繰り返しの規則の行を数えない', () => {
  it('済ませた回が 3 行あっても、規則の行は数えない(3 / 3 完了)', () => {
    const body = [
      '- [ ] ゴミ出し @2026-10-05 毎週',
      '- [x] ゴミ出し @2026-10-05',
      '- [x] ゴミ出し @2026-10-12',
      '- [x] ゴミ出し @2026-10-19',
    ].join('\n');
    expect(countDrawnTasks(body)).toEqual({ total: 3, done: 3 });
  });

  it('対照群:規則でない予定の行・日付のない行は今までどおり数える / 規則だけなら 0 件', () => {
    expect(countDrawnTasks('- [ ] a @2026-10-05\n- [x] b\n- [ ] c')).toEqual({ total: 3, done: 1 });
    expect(countDrawnTasks('- [ ] 規則 @2026-10-05 毎週')).toEqual({ total: 0, done: 0 });
    // 曜日の列・時刻つきの規則も同じ
    expect(countDrawnTasks('- [ ] 会議 @2026-10-05 14:00 毎週月水\n- [ ] 別の行')).toEqual({ total: 1, done: 0 });
  });

  it('前書き(frontmatter)があっても、行の指し先がずれない', () => {
    const body = ['---', 'tags: x', '---', '- [ ] 規則 @2026-10-05 毎週', '- [x] 回 @2026-10-05'].join('\n');
    expect(countDrawnTasks(body)).toEqual({ total: 1, done: 1 });
  });
});

describe('286B: 以前に 1 回だけ動かした回の数', () => {
  it('同じノート・同じ字で、振替の印が付いた行だけを数える', () => {
    const body = [
      '- [ ] 会議 @2026-10-05 毎週',
      '- [ ] 会議 @2026-10-14 振替2026-10-12',
      '- [ ] 会議 @2026-10-21 振替2026-10-19',
      '- [ ] 別件 @2026-10-15 振替2026-10-13',
      '- [x] 会議 @2026-10-26',
    ].join('\n');
    const cards = taskCardsOf('n1', body);
    const rule = cards.find((c) => c.repeat !== null)!;
    expect(movedOccurrenceCount(cards, 'n1', rule.text)).toBe(2);
    // 対照群:別のノート・字が違う・何も動かしていない規則は 0
    expect(movedOccurrenceCount(cards, 'n2', rule.text)).toBe(0);
    expect(movedOccurrenceCount(cards, 'n1', '存在しない')).toBe(0);
    const none = taskCardsOf('n3', '- [ ] 会議 @2026-10-05 毎週');
    expect(movedOccurrenceCount(none, 'n3', none[0]!.text)).toBe(0);
  });
});

describe('76: メインの入れ替わりの 1 行', () => {
  it('別のウィンドウでは「ウィンドウ」と言い、ふつうのタブでは今までの字', () => {
    expect(promotedLine(true)).toBe('このウィンドウがメインになりました(保存はここから行います)');
    expect(promotedLine(false)).toBe('このタブがメインのタブになりました');
    expect(promotedLine(true)).not.toContain('タブ');
  });
});

describe('100-2: 並べ替えたあとのカーソルは、押す前にいた行へ', () => {
  const body = '- [x] 済み1\n- [ ] 未1\n- [ ] 未2\n- [x] 済み2\n- [ ] 未3\n';

  it('同じ行番号・同じ桁へ戻す(置き換えの終わりへ飛ばさない)', () => {
    const next = sortTasksByStatus(body);
    expect(next).not.toBe(body);
    // 3 行目(未2)の先頭から 4 字目にいた
    const pos = body.indexOf('未2') + 1;
    const back = caretAfterReplace(body, next, pos);
    const line = next.slice(0, back).split('\n').length - 1;
    expect(line, '行が変わった').toBe(2);
    expect(back - (next.lastIndexOf('\n', back - 1) + 1)).toBe(pos - (body.lastIndexOf('\n', pos - 1) + 1));
  });

  it('行が短くなっていたら行末 / 先頭・末尾・空の本文でも範囲を出ない', () => {
    expect(caretAfterReplace('abcdef\nxy', 'abc\nxy', 5)).toBe(3);
    expect(caretAfterReplace('abc\nxy', 'abc\nxy', 0)).toBe(0);
    expect(caretAfterReplace('\nabc', '\nabc', 0)).toBe(0);
    expect(caretAfterReplace('abc\n', 'abc\n', 4)).toBe(4);
    expect(caretAfterReplace('', '', 0)).toBe(0);
    expect(caretAfterReplace('a\nb', 'a\nb', 99)).toBe(3);
    expect(caretAfterReplace('a\nb', 'a\nb', -5)).toBe(0);
    // 行の数が変わった(想定外)ときは位置を収めるだけ
    expect(caretAfterReplace('a\nb\nc', 'a\nb', 4)).toBe(3);
  });
});

describe('100-3: 上の行で決めた名前を打ち間違えたとき', () => {
  const at = (text: string): string | null => explainCalcMiss(text, text.length);

  it('🔴 名前を決めた行が上に在り、決めていない名前を使った式は、そう言う', () => {
    expect(at('基本単価 = 3200\n基本単価2*8=')).toBe('『基本単価2』は上の行で決めていません');
    expect(at('- 基本単価 = 3200\n- 基本単価2*8=')).toBe('『基本単価2』は上の行で決めていません');
    // 全角の等号・数字でも同じ
    expect(at('基本単価＝３２００\n基本単価２*８＝')).toBe('『基本単価2』は上の行で決めていません');
  });

  it('🔴 打ち間違えた名前の「後ろの数だけ」を計算して、気づけない数(16)を入れない', () => {
    const t = '基本単価 = 3200\n基本単価2*8=';
    expect(resolveInlineCalc(t, t.length), '2*8 だけを計算してしまう').toBeNull();
    // 対照群:名前を決めていなければ、今までどおり地の文 + 式(りんご300*2=)/ 決めた名前そのものは計算できる
    expect(resolveInlineCalc('りんご300*2=', 'りんご300*2='.length)?.value).toBe(600);
    const u = '基本単価 = 3200\nりんご2*3=';
    expect(resolveInlineCalc(u, u.length)?.value, '別の語の地の文 + 式まで止めた').toBe(6);
    const v = '基本単価 = 3200\n基本単価*8=';
    expect(resolveInlineCalc(v, v.length)?.value).toBe(25600);
  });

  it('⚠ 対照群:決めた名前なら言わない(計算できる)/ 普通の文・名前を決めていないノートには言わない', () => {
    expect(at('基本単価 = 3200\n基本単価*8=')).toBeNull();
    expect(at('基本単価 = 3200\n締切=')).toBeNull();
    expect(at('基本単価 = 3200\n結果は 基本単価2*8=')).toBeNull();
    expect(at('md5*8=')).toBeNull();
    expect(at('基本単価2*8=')).toBeNull();
    // セルの番地の形は名前の打ち間違いと読まない
    expect(at('基本単価 = 3200\nA1+B1=')).toBeNull();
    // 演算子が無い行
    expect(at('基本単価 = 3200\n基本単価2=')).toBeNull();
  });
});

describe('347: 知らせの帯をほかのウィンドウへ放送する', () => {
  /** 同じ放送路に繋がった 2 つの端(自分の放送は自分に届かない)。 */
  function hub(): { a: Broadcaster; b: Broadcaster } {
    const a: Broadcaster = { postMessage: (d) => b.onmessage?.({ data: d } as MessageEvent), close() {}, onmessage: null };
    const b: Broadcaster = { postMessage: (d) => a.onmessage?.({ data: d } as MessageEvent), close() {}, onmessage: null };
    return { a, b };
  }
  const due = (key: string): AlarmDue => ({ key, lid: 'n1', line: 1, text: '打ち合わせ', time: '14:00' });

  function pair(): {
    ringer: ReturnType<typeof createAlarmBarSync>;
    follower: ReturnType<typeof createAlarmBarSync>;
    ringing: Map<string, AlarmDue>;
    followerBar: AlarmDue[][];
  } {
    const { a, b } = hub();
    const ringing = new Map<string, AlarmDue>();
    const followerBar: AlarmDue[][] = [];
    const ringer: ReturnType<typeof createAlarmBarSync> = createAlarmBarSync({
      channel: a,
      id: 'main',
      isRinger: () => true,
      ringing: () => [...ringing.values()],
      dismiss: (k) => {
        ringing.delete(k);
        ringer.publish([...ringing.values()]);
      },
      dismissAll: () => {
        ringing.clear();
        ringer.publish([]);
      },
      paint: () => {},
    });
    const follower = createAlarmBarSync({
      channel: b,
      id: 'sub',
      isRinger: () => false,
      ringing: () => [],
      dismiss: () => {},
      dismissAll: () => {},
      paint: (d) => followerBar.push([...d]),
    });
    return { ringer, follower, ringing, followerBar };
  }

  it('🔴 本体が鳴らすと、ほかのウィンドウの帯にも同じ一覧が出る', () => {
    const { ringer, ringing, followerBar } = pair();
    ringing.set('k1', due('k1'));
    ringer.publish([...ringing.values()]);
    expect(followerBar.at(-1)?.map((d) => d.key)).toEqual(['k1']);
  });

  it('🔴 ほかのウィンドウで閉じると、本体が片付けて、全部で消える(どこかで閉じたら全部消える)', () => {
    const { ringer, follower, ringing, followerBar } = pair();
    ringing.set('k1', due('k1'));
    ringing.set('k2', due('k2'));
    ringer.publish([...ringing.values()]);
    follower.dismiss('k1');
    expect(ringing.has('k1'), '本体が片付けていない').toBe(false);
    expect(ringing.has('k2')).toBe(true);
    expect(followerBar.at(-1)?.map((d) => d.key)).toEqual(['k2']);
    follower.dismissAll();
    expect(ringing.size).toBe(0);
    expect(followerBar.at(-1)).toEqual([]);
  });

  it('本体で閉じたときも、ほかのウィンドウの帯が消える', () => {
    const { ringer, ringing, followerBar } = pair();
    ringing.set('k1', due('k1'));
    ringer.publish([...ringing.values()]);
    ringer.dismiss('k1');
    expect(followerBar.at(-1)).toEqual([]);
  });

  it('後から開いたウィンドウは、いま鳴っている一覧を頼んで受け取る', () => {
    const { a, b } = hub();
    const ringing = new Map<string, AlarmDue>([['k1', due('k1')]]);
    const paints: AlarmDue[][] = [];
    createAlarmBarSync({
      channel: a,
      id: 'main',
      isRinger: () => true,
      ringing: () => [...ringing.values()],
      dismiss: () => {},
      dismissAll: () => {},
      paint: () => {},
    });
    createAlarmBarSync({
      channel: b,
      id: 'late',
      isRinger: () => false,
      ringing: () => [],
      dismiss: () => {},
      dismissAll: () => {},
      paint: (d) => paints.push([...d]),
    });
    expect(paints.at(-1)?.map((d) => d.key), '後から開いた窓に帯が出ていない').toEqual(['k1']);
  });

  it('⚠ 本体は、ほかの窓の放送では帯を描き直さない / 放送路が無ければ何もしない(落ちない)', () => {
    const painted: number[] = [];
    const wire: Broadcaster = { postMessage() {}, close() {}, onmessage: null };
    createAlarmBarSync({
      channel: wire,
      id: 'main',
      isRinger: () => true,
      ringing: () => [],
      dismiss: () => {},
      dismissAll: () => {},
      paint: () => painted.push(1),
    });
    wire.onmessage?.({ data: { tag: ALARM_BAR_STATE, from: 'other', due: [due('x')] } } as MessageEvent);
    expect(painted).toEqual([]);
    const none = createAlarmBarSync({
      channel: null,
      id: 'solo',
      isRinger: () => false,
      ringing: () => [],
      dismiss: () => {},
      dismissAll: () => {},
      paint: () => painted.push(2),
    });
    none.publish([due('y')]);
    none.dismiss('y');
    expect(painted, '放送路が無い窓でも、自分の帯からは外れる').toEqual([2]);
  });
});
