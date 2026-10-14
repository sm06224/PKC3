/** @vitest-environment happy-dom */
/**
 * 🔴 予定の知らせ(#855 20-C)の配線:好みの保存 / 「前に開いていた時刻」の持ち方 /
 * 次に開いたときの 1 行 / 書き出しがアラームを入れること。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { MISSED_SCAN_FAILED_TEXT, startMissedWatch } from '../../src/adapter/ui/actions/missed-schedule';
import { appScheduleNotify, ScheduleNotifyStore } from '../../src/adapter/ui/render/schedule-notify';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import type { EntryMeta } from '../../src/core/model/entry-meta';

/** 最小の Storage の代わり(読めない / 書けないを作れる)。 */
function fakeStorage(init: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('好みと「前に開いていた時刻」の置き場', () => {
  it('🔴 既定は 15 分前・見逃しの知らせは入', () => {
    const s = new ScheduleNotifyStore(fakeStorage());
    expect(s.lead()).toBe(15);
    expect(s.missedOn()).toBe(true);
  });

  it('選んだ値が保存され、選べない値は既定に丸める(なし = 0 は保てる)', () => {
    const st = fakeStorage();
    const s = new ScheduleNotifyStore(st);
    s.setLead(0);
    expect(new ScheduleNotifyStore(st).lead()).toBe(0);
    s.setLead(60);
    expect(new ScheduleNotifyStore(st).lead()).toBe(60);
    s.setLead(7);
    expect(s.lead()).toBe(15);
    st.data['pkc3.schedule-lead'] = 'abc';
    expect(s.lead()).toBe(15);
    s.setMissedOn(false);
    expect(new ScheduleNotifyStore(st).missedOn()).toBe(false);
    s.setMissedOn(true);
    expect(new ScheduleNotifyStore(st).missedOn()).toBe(true);
  });

  it('🔴 時刻はコレクションごと(別のコレクションの時刻に触らない)・本文の保存先ではなく端末の保存', () => {
    const st = fakeStorage();
    const s = new ScheduleNotifyStore(st);
    expect(s.lastOpen('c1')).toBeNull();
    s.stampOpen('c1', 1000);
    s.stampOpen('c2', 2000);
    s.stampOpen('c1', 3000);
    expect(s.lastOpen('c1')).toBe(3000);
    expect(s.lastOpen('c2')).toBe(2000);
    expect(Object.keys(st.data)).toEqual(['pkc3.schedule-last-open']);
  });

  it('🔑 開き直したコレクションは「新しい側」に回る(古い順の捨て方が、開いている物を落とさない)', () => {
    const s = new ScheduleNotifyStore(fakeStorage());
    for (let i = 0; i < 20; i += 1) s.stampOpen(`c${i}`, i + 1);
    s.stampOpen('c0', 100); // 一番古い物を開き直す
    s.stampOpen('c20', 101); // 21 個目 → 一番古い物(c1)が落ちる
    expect(s.lastOpen('c0')).toBe(100);
    expect(s.lastOpen('c1')).toBeNull();
  });

  it('壊れた保存値は「初めて」扱い(例外にしない)/ 保存が無い環境では控えが効く', () => {
    const bad = fakeStorage({ 'pkc3.schedule-last-open': '{oops' });
    expect(new ScheduleNotifyStore(bad).lastOpen('c1')).toBeNull();
    const none = new ScheduleNotifyStore(null);
    none.setLead(30);
    none.setMissedOn(false);
    none.stampOpen('c1', 5);
    expect(none.lead()).toBe(30);
    expect(none.missedOn()).toBe(false);
    expect(none.lastOpen('c1')).toBe(5);
  });

  it('憶えるコレクションは 20 まで(古い順に捨てる)', () => {
    const s = new ScheduleNotifyStore(fakeStorage());
    for (let i = 0; i < 25; i += 1) s.stampOpen(`c${i}`, i + 1);
    expect(s.lastOpen('c0')).toBeNull();
    expect(s.lastOpen('c4')).toBeNull();
    expect(s.lastOpen('c5')).toBe(6);
    expect(s.lastOpen('c24')).toBe(25);
  });
});

const meta = (): EntryMeta => ({
  lid: 'a', title: '週次メモ', archetype: 'text', createdAt: null, updatedAt: null,
  entryOrder: 1, status: null, date: null, archived: false, bodyChars: null,
});
const ms = (d: number, h: number, m = 0): number => new Date(2026, 9, d, h, m, 0, 0).getTime();

function rig(bodies: string): { d: Dispatcher; setScan: () => void } {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta()], relations: [] });
  return {
    d,
    setScan: () =>
      d.dispatch({
        type: 'SET_TASK_SCAN',
        scan: { cards: taskCardsOf('a', bodies), totalNotes: 1, scannedNotes: 1, truncated: false },
      }),
  };
}

const BODY = '- [ ] 朝会 @2026-10-12 09:00\n- [ ] 昼会 @2026-10-12 12:00\n- [x] 済み @2026-10-12 10:00\n- [ ] 終日 @2026-10-12\n';

function watch(opts: {
  store: ScheduleNotifyStore;
  now: number;
  setScanAfter?: boolean;
  body?: string;
  isRinger?: () => boolean;
}) {
  const r = rig(opts.body ?? BODY);
  const painted: number[] = [];
  const posted: string[] = [];
  const w = startMissedWatch({
    dispatcher: r.d,
    store: opts.store,
    cid: 'c1',
    now: () => opts.now,
    paint: (n) => painted.push(n),
    post: (t) => posted.push(t),
    tick: () => () => undefined,
    ...(opts.isRinger === undefined ? {} : { isRinger: opts.isRinger }),
  });
  return { ...r, painted, posted, w };
}

describe('次に開いたとき、見逃した予定を知らせる', () => {
  it('🔴 前に開いた後に始まった「時刻つき・未了」だけを数え、帯とメッセージの両方に 1 度ずつ言う', () => {
    const store = new ScheduleNotifyStore(fakeStorage());
    store.stampOpen('c1', ms(12, 8, 0));
    const t = watch({ store, now: ms(12, 13, 0) });
    t.setScan();
    // 朝会・昼会 = 2(済み・終日は数えない)
    expect(t.painted).toEqual([2]);
    expect(t.posted).toEqual(['見逃した予定が 2 件あります']);
    // 二度目の state 変化では言い直さない
    t.setScan();
    expect(t.painted).toEqual([2]);
  });

  it('🔴 時刻は走査より前に読んで、そのあと進める(進めた後に読むと常に 0 件)', () => {
    const st = fakeStorage();
    const store = new ScheduleNotifyStore(st);
    store.stampOpen('c1', ms(12, 8, 0));
    const t = watch({ store, now: ms(12, 13, 0) });
    expect(store.lastOpen('c1')).toBe(ms(12, 13, 0));
    t.setScan();
    expect(t.painted).toEqual([2]);
  });

  it('🔴 予定表を使ったことが無い端末は、何も出さず・時刻も書かず・走査も頼まない(予定を使わない人に全走査を負わせない)', () => {
    const store = new ScheduleNotifyStore(fakeStorage());
    const r = rig(BODY);
    const events: string[] = [];
    r.d.onEvent((e) => events.push(e.type));
    const painted: number[] = [];
    const posted: string[] = [];
    let beats = 0;
    startMissedWatch({
      dispatcher: r.d, store, cid: 'c1', now: () => ms(12, 13, 0),
      paint: (n) => painted.push(n), post: (t) => posted.push(t),
      tick: () => {
        beats += 1;
        return () => undefined;
      },
    });
    r.setScan();
    // 予定表と関係のない操作(イベントが出るもの)では、記録を始めない
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    r.d.dispatch({ type: 'SET_SCHEDULE_MODE', mode: 'day' });
    expect(painted).toEqual([]);
    expect(posted).toEqual([]);
    expect(events).not.toContain('REQUEST_TASK_SCAN');
    expect(store.lastOpen('c1')).toBeNull();
    expect(beats, '使っていないコレクションに刻みを張っている').toBe(0);
  });

  it('🔴 予定表を 1 度開く(走査が頼まれる)と記録が始まり、次の起動から普通に数える', () => {
    const st = fakeStorage();
    const store = new ScheduleNotifyStore(st);
    const r = rig(BODY);
    let beats = 0;
    let clock = ms(12, 8, 0);
    startMissedWatch({
      dispatcher: r.d, store, cid: 'c1', now: () => clock,
      paint: () => undefined, post: () => undefined,
      tick: () => {
        beats += 1;
        return () => undefined;
      },
    });
    expect(store.lastOpen('c1')).toBeNull();
    r.d.dispatch({ type: 'REFRESH_TASK_SCAN' }); // 予定表を開いたときに頼まれる走査
    expect(store.lastOpen('c1')).toBe(ms(12, 8, 0));
    expect(beats).toBe(1);
    r.d.dispatch({ type: 'REFRESH_TASK_SCAN' }); // 2 回目で刻みを二重に張らない
    expect(beats).toBe(1);
    // 次の起動(13:00)── 普通の動き
    clock = ms(12, 13, 0);
    const painted: number[] = [];
    const next = rig(BODY);
    startMissedWatch({
      dispatcher: next.d, store: new ScheduleNotifyStore(st), cid: 'c1', now: () => clock,
      paint: (n) => painted.push(n), post: () => undefined, tick: () => () => undefined,
    });
    next.setScan();
    expect(painted).toEqual([2]);
  });

  it('🔴 設定が切なら何も出さず、走査も頼まない(時刻は進める)', () => {
    const store = new ScheduleNotifyStore(fakeStorage());
    store.stampOpen('c1', ms(12, 8, 0));
    store.setMissedOn(false);
    const t = watch({ store, now: ms(12, 13, 0) });
    t.setScan();
    expect(t.painted).toEqual([]);
    expect(t.posted).toEqual([]);
    expect(store.lastOpen('c1')).toBe(ms(12, 13, 0));
  });

  it('🔴 別のコレクションの時刻では数えない(このコレクションの記録が無ければ初回扱い)', () => {
    const store = new ScheduleNotifyStore(fakeStorage());
    store.stampOpen('other', ms(12, 8, 0));
    const t = watch({ store, now: ms(12, 13, 0) });
    t.setScan();
    expect(t.painted).toEqual([]);
  });

  it('0 件なら何も出さない / 集められなかったときも黙って終える', () => {
    const store = new ScheduleNotifyStore(fakeStorage());
    store.stampOpen('c1', ms(12, 12, 30));
    const t = watch({ store, now: ms(12, 13, 0) });
    t.setScan();
    expect(t.painted).toEqual([]);
    const store2 = new ScheduleNotifyStore(fakeStorage());
    store2.stampOpen('c1', ms(12, 8, 0));
    const t2 = watch({ store: store2, now: ms(12, 13, 0) });
    t2.d.dispatch({ type: 'TASK_SCAN_FAILED' });
    expect(t2.painted).toEqual([]);
  });

  it('🔴 集められなかったときは、黙らず「数えられなかった」と 1 回言う(#1087)', () => {
    const store = new ScheduleNotifyStore(fakeStorage());
    store.stampOpen('c1', ms(12, 8, 0));
    const t = watch({ store, now: ms(12, 13, 0) });
    t.d.dispatch({ type: 'TASK_SCAN_FAILED' });
    t.d.dispatch({ type: 'TASK_SCAN_FAILED' });
    expect(t.posted, '失敗を言っていない / 言い直している').toEqual([MISSED_SCAN_FAILED_TEXT]);
  });

  it('🔴 同じコレクションを 2 つのタブで開いても、見逃した予定を言うのは本体のタブの 1 つだけ(#1087)', () => {
    const st = fakeStorage();
    const store = new ScheduleNotifyStore(st);
    store.stampOpen('c1', ms(12, 8, 0));
    // 本体でないタブが先に起動しても、前に開いていた時刻を消さない(本体が読む前に進めない)
    const follower = watch({ store, now: ms(12, 13, 0), isRinger: () => false });
    const holder = watch({ store, now: ms(12, 13, 0), isRinger: () => true });
    follower.setScan();
    holder.setScan();
    expect(follower.posted, '本体でないタブが言った').toEqual([]);
    expect(follower.painted).toEqual([]);
    expect(holder.posted, '本体のタブが言っていない').toEqual(['見逃した予定が 2 件あります']);
  });

  it('⚠ 本体でないタブも、刻みでは時刻を進める(本体が閉じたあとの起動で、開いていた間を見逃しに数えない)', () => {
    const store = new ScheduleNotifyStore(fakeStorage());
    store.stampOpen('c1', ms(12, 7, 0));
    let fire: () => void = () => undefined;
    let clock = ms(12, 8, 0);
    startMissedWatch({
      dispatcher: rig(BODY).d, store, cid: 'c1', now: () => clock, isRinger: () => false,
      paint: () => undefined, post: () => undefined,
      tick: (fn) => {
        fire = fn;
        return () => undefined;
      },
    });
    expect(store.lastOpen('c1'), '本体でないタブが起動時に時刻を書いた').toBe(ms(12, 7, 0));
    clock = ms(12, 9, 30);
    fire();
    expect(store.lastOpen('c1')).toBe(ms(12, 9, 30));
  });

  it('🔑 刻みで時刻を進める(開いている間の予定を、次の起動で見逃しに数えない)', () => {
    const store = new ScheduleNotifyStore(fakeStorage());
    store.stampOpen('c1', ms(12, 7, 0)); // 予定表を使ったことがあるコレクション
    let fire: () => void = () => undefined;
    let clock = ms(12, 8, 0);
    const r = rig(BODY);
    startMissedWatch({
      dispatcher: r.d, store, cid: 'c1', now: () => clock,
      paint: () => undefined, post: () => undefined,
      tick: (fn) => {
        fire = fn;
        return () => undefined;
      },
    });
    clock = ms(12, 9, 30);
    fire();
    expect(store.lastOpen('c1')).toBe(ms(12, 9, 30));
  });
});

describe('画面:知らせの 1 行と、好みの 2 つ', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    appScheduleNotify.setLead(15);
    appScheduleNotify.setMissedOn(true);
  });

  it('🔴 帯に 1 行が出て、「閉じる」で畳める(鳴っている予定が無ければ帯ごと)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const { paintMissedLine } = await import('../../src/adapter/ui/render/shell');
    const bar = root.querySelector<HTMLElement>('[data-pkc-region="alarm-bar"]')!;
    expect(bar.hidden).toBe(true);
    paintMissedLine(root, 3);
    expect(bar.hidden).toBe(false);
    expect(root.querySelector('[data-pkc-field="missed-text"]')!.textContent).toBe('見逃した予定が 3 件あります');
    // 「予定表を開く」は左の列の予定のタブ(既存の set-browse の口)
    const open = root.querySelector<HTMLElement>('[data-pkc-field="missed-open"]')!;
    expect(open.getAttribute('data-pkc-action')).toBe('open-missed-schedule');
    const browsed: string[] = [];
    bindActions(root, new Dispatcher(), { setBrowse: (m) => browsed.push(m) });
    // 押すと左の予定のタブへ移り、1 行も片付く(開いたのに残ると「押しても消えない」)
    open.click();
    expect(browsed).toEqual(['schedule']);
    expect(bar.hidden).toBe(true);
    paintMissedLine(root, 3);
    root.querySelector<HTMLElement>('[data-pkc-action="dismiss-missed"]')!.click();
    expect(bar.hidden).toBe(true);
    expect((root.querySelector('[data-pkc-field="missed-line"]') as HTMLElement).hidden).toBe(true);
  });

  it('🔴 鳴っている予定の帯と同居する:片方を畳んでも、もう片方が出ている間は帯を畳まない', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    bindActions(root, new Dispatcher());
    const { paintMissedLine, paintAlarmBar } = await import('../../src/adapter/ui/render/shell');
    const bar = root.querySelector<HTMLElement>('[data-pkc-region="alarm-bar"]')!;
    const due = [{ key: 'k', lid: 'a', line: 1, text: '会議', time: '14:00' }];
    // 見逃しを閉じても、鳴っている予定が残っていれば帯は残る
    paintAlarmBar(root, due);
    paintMissedLine(root, 2);
    root.querySelector<HTMLElement>('[data-pkc-action="dismiss-missed"]')!.click();
    expect(bar.hidden).toBe(false);
    expect(root.querySelectorAll('[data-pkc-field="alarm-list"] li')).toHaveLength(1);
    // 鳴っている予定を片付けても、見逃しの 1 行が出ている間は帯は残る
    paintMissedLine(root, 2);
    paintAlarmBar(root, []);
    expect(bar.hidden).toBe(false);
    expect((root.querySelector('[data-pkc-field="missed-line"]') as HTMLElement).hidden).toBe(false);
  });

  it('🔴 予定表の「知らせ」で選んだ値が保存され、描き直しで映る', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const d = new Dispatcher();
    bindActions(document.body, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta()], relations: [] });
    const view = new ScheduleRenderer(region);
    view.render(d.getState());
    const sel = region.querySelector<HTMLSelectElement>('[data-pkc-field="schedule-lead"]')!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['なし', '5分前', '15分前', '30分前', '1時間前']);
    expect(sel.value).toBe('15');
    // 🔴 .ics にだけ効くことを字で言う(PKC3 の中で 15 分前に鳴ると読ませない ── #1087 の見直し 2026-10-13)
    expect(sel.closest('label')?.textContent ?? '').toContain('書き出す .ics の知らせる時間');
    sel.value = '30';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(appScheduleNotify.lead()).toBe(30);
    const box = region.querySelector<HTMLInputElement>('[data-pkc-field="schedule-missed"]')!;
    expect(box.checked).toBe(true);
    box.click(); // 実際の押し(checked が反転してから口が読む)
    expect(appScheduleNotify.missedOn()).toBe(false);
    // 別の経路で値が変わっても、次の描き直しで映る
    appScheduleNotify.setLead(5);
    appScheduleNotify.setMissedOn(true);
    d.dispatch({ type: 'SET_SCHEDULE_MODE', mode: 'day' });
    view.render(d.getState());
    expect(sel.value).toBe('5');
    expect(box.checked).toBe(true);
  });

  it('🔴 書き出しは選んだ時間のアラームを入れる(なし = 入れない)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'export-schedule-ics');
    root.append(btn);
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta()], relations: [] });
    d.dispatch({ type: 'REFRESH_TASK_SCAN' });
    d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: {
        cards: taskCardsOf('a', '- [ ] 会議 @2026-10-20 14:00\n- [ ] 終日 @2026-10-21\n'),
        totalNotes: 1, scannedNotes: 1, truncated: false,
      },
    });
    const blobs: Blob[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    URL.createObjectURL = ((b: Blob) => {
      blobs.push(b);
      return 'blob:x';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (): void => undefined;
    const press = async (): Promise<string> => {
      btn.click();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      return blobs[blobs.length - 1]!.text();
    };
    appScheduleNotify.setLead(30);
    const t30 = await press();
    expect(t30.match(/BEGIN:VALARM/g)).toHaveLength(1); // 終日には付かない
    expect(t30).toContain('TRIGGER:-PT30M');
    appScheduleNotify.setLead(0);
    expect(await press()).not.toContain('VALARM');
  });
});
