/** @vitest-environment happy-dom */
/**
 * 🔴 **予定を動かした直後の「元に戻す」**(#855。Gemini 裁定 = #1163 のコメント 6104130726 の 6)。
 *
 * 場所は画面の下の知らせの行(`status-undo` ── 動かさず・覆わず・一覧が長くてもいつも見える)。
 *
 * 守る主張:
 * 1. 札を日へドロップすると、**本文への書込が届いてから**知らせ「10/5(月) 14:00〜15:00 へ動かしました」が出て、
 *    隣に「元に戻す」が出る(書込が届く前 / 失敗したときは出さない)
 * 2. 🔴 **押すと、本文が動かす前の字へ戻る**(本物の道:
 *    `dropTaskCard` → reducer → 本文の書換 → 走査し直し → `undoScheduleMove` → 逆向きの書換)
 * 3. 動かした後に本文が変わっていたら戻さない。🔴 別の窓が行を差し込んで「N 行目が別の予定になり、たまたま
 *    同じ日・同じ時刻」でも戻さない(中身の指紋)
 * 4. 断られた回・日が変わらない回は出さない / 数秒で降ろす / **クリック**で降ろす(スクロールや動かした押し方では降ろさない)/ 1 手だけ
 *
 * ⚠ 時刻の目盛りで動かす道(`schedule-grid-drag.ts`)は `schedule-grid-drag.test.ts` と実ブラウザの smoke が見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import { MOVE_OFFER_MS } from '../../src/features/schedule/move-undo';
import { dropTaskCard } from '../../src/adapter/ui/render/schedule-drag';
import {
  MOVE_ACK_WAIT_MS,
  clearMoveOffer,
  currentMoveOffer,
  offerMoveUndo,
  scheduleUndoShown,
  undoScheduleMove,
} from '../../src/adapter/ui/render/schedule-undo';
import { paintStatusUndo } from '../../src/adapter/ui/render/status-open';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher as RealDispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, reduce, type AppState, type UserAction } from '../../src/adapter/state/app-state';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta = (over: Partial<EntryMeta> = {}): EntryMeta => ({
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
  ...over,
});

interface Rig {
  readonly root: HTMLElement;
  readonly dispatcher: Dispatcher;
  readonly state: () => AppState;
  readonly body: () => string;
  /** 反映された書換の数(逆向きの 1 手が本当に撃たれたかを数える)。 */
  readonly writes: () => number;
  /** 本文を直に書き換えて走査し直す(「動かした後に別の窓 / 自分が直した」を作る)。 */
  readonly edit: (next: string) => void;
  /** state を直に書き換える。 */
  readonly patch: (p: Partial<AppState>) => void;
  /** `defer: true` のとき、溜めた書換を届ける(書込の ack が遅れる場面)。 */
  readonly flush: () => void;
}

/**
 * 本物の reducer + 本文の書換 + 走査し直し。
 * `defer` なら書換は `flush()` まで届かない ── 効果層の ack が遅れる(または失敗する)場面を作れる。
 */
function rig(initialBody: string, entryDate: string | null = null, defer = false): Rig {
  let body = initialBody;
  let writes = 0;
  const queue: Array<() => void> = [];
  const listeners: Array<() => void> = [];
  const scan = (): AppState['taskScan'] => ({
    cards: taskCardsOf('a', body),
    totalNotes: 1,
    scannedNotes: 1,
    truncated: false,
  });
  let state: AppState = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta({ date: entryDate })],
    relations: [],
  }).state;
  state = { ...state, taskScan: scan() };
  const notify = (): void => {
    for (const l of [...listeners]) l();
  };
  const apply = (rewrite: Parameters<typeof applyBodyRewrite>[1]): void => {
    writes += 1;
    body = applyBodyRewrite(body, rewrite) ?? body;
    const date = /^date:\s*(\S+)/m.exec(body)?.[1] ?? null;
    state = {
      ...state,
      taskScan: scan(),
      entryMetas: new Map(state.entryMetas).set('a', { ...meta({ date }) }),
    };
  };
  const dispatcher = {
    getState: () => state,
    onState: (l: () => void) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    dispatch: (action: UserAction) => {
      const r = reduce(state, action);
      state = r.state;
      for (const ev of r.events) {
        if (ev.type !== 'REQUEST_BODY_REWRITE') continue;
        if (defer) queue.push(() => apply(ev.rewrite));
        else apply(ev.rewrite);
      }
      notify();
    },
  } as unknown as Dispatcher;
  const root = document.createElement('div');
  document.body.append(root);
  return {
    root,
    dispatcher,
    state: () => state,
    body: () => body,
    writes: () => writes,
    edit: (next) => {
      body = next;
      state = { ...state, taskScan: scan() };
      notify();
    },
    patch: (p) => {
      state = { ...state, ...p };
      notify();
    },
    flush: () => {
      for (const f of queue.splice(0)) f();
      notify();
    },
  };
}

const press = (r: Rig): ReturnType<typeof undoScheduleMove> => undoScheduleMove(r.state());
const drop = (r: Rig, line: string, from: string, to: string): void =>
  dropTaskCard(r.dispatcher, { lid: 'a', line, from, repeat: '' }, to, r.root);
/** 画面の下の知らせに出ているはずの字(`OP_NOTICE` が載せる)。 */
const noticeOf = (r: Rig): string | null => r.state().notice;

beforeEach(() => {
  vi.useFakeTimers();
  clearMoveOffer();
});
afterEach(() => {
  clearMoveOffer();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('動かした直後の知らせ(書込が届いてから出る)', () => {
  it('🔴 日へドロップして書込が届くと、知らせが出て「元に戻す」が出せる状態になる', () => {
    const r = rig('- [ ] 会議 @2026-08-25 14:00..15:00 の枠');
    drop(r, '0', '2026-08-25', '2026-08-27');
    expect(noticeOf(r)).toBe('8/27(木) 14:00〜15:00 へ動かしました');
    expect(scheduleUndoShown(noticeOf(r)!), '知らせが出たのに「元に戻す」を出せない').toBe(true);
  });

  it('🔴 書込が届く前は出さない / 届いたら出る(遅れた ack)', () => {
    const r = rig('- [ ] 会議 @2026-08-25 14:00', null, true);
    drop(r, '0', '2026-08-25', '2026-08-27');
    expect(noticeOf(r), '書込が届く前に「動かしました」を出した').toBeNull();
    expect(currentMoveOffer(), '待っている間は持っている').not.toBeNull();
    r.flush();
    expect(noticeOf(r)).toBe('8/27(木) 14:00 へ動かしました');
  });

  it('🔴 書込が失敗した(新しい失敗が出た)なら、「動かしました」を出さず、持っている物も捨てる', () => {
    const r = rig('- [ ] 会議 @2026-08-25 14:00', null, true);
    drop(r, '0', '2026-08-25', '2026-08-27');
    // 効果層が「本文が変わっているため反映できませんでした」と言う場面
    r.dispatcher.dispatch({ type: 'OP_FAILED', error: '本文が変わっているため反映できませんでした(開き直してください)' });
    r.flush(); // 後から書込が届いても(届かない設計だが)、もう出さない
    expect(noticeOf(r), '失敗したのに「動かしました」が出た').toBeNull();
    expect(currentMoveOffer()).toBeNull();
  });

  it('書込がいつまでも届かないなら、出さずに諦める(古い知らせを後から出さない)', () => {
    const r = rig('- [ ] 会議 @2026-08-25 14:00', null, true);
    drop(r, '0', '2026-08-25', '2026-08-27');
    vi.advanceTimersByTime(MOVE_ACK_WAIT_MS + 1);
    expect(currentMoveOffer()).toBeNull();
    r.flush();
    expect(noticeOf(r)).toBeNull();
  });

  it('🔴 書込が断られた回(読み込み中など)は、動いていないので出さない', () => {
    const r = rig('- [ ] 会議 @2026-08-25');
    r.patch({ phase: 'initializing' });
    drop(r, '0', '2026-08-25', '2026-08-27');
    expect(r.writes(), '前提: 断られて書かれていない').toBe(0);
    expect(noticeOf(r) ?? '', '断られたのに「動かしました」が出た').not.toContain('動かしました');
    expect(currentMoveOffer()).toBeNull();
  });

  it('日が変わらない落とし方は出さない', () => {
    const r = rig('- [ ] 会議 @2026-08-25');
    drop(r, '0', '2026-08-25', '2026-08-25');
    expect(currentMoveOffer()).toBeNull();
    expect(noticeOf(r)).toBeNull();
  });
});

describe('「元に戻す」を押す', () => {
  it('🔴 時刻・幅・尻つきの行が、動かす前の字へ戻る', () => {
    const original = '- [ ] 会議 @2026-08-25 14:00..15:00 の枠\n- [ ] 別の行 @2026-08-26';
    const r = rig(original);
    drop(r, '0', '2026-08-25', '2026-08-27');
    expect(r.body(), '前提: 落としたら日付が動いている').toBe(
      '- [ ] 会議 @2026-08-27 14:00..15:00 の枠\n- [ ] 別の行 @2026-08-26',
    );
    const undo = press(r);
    expect(undo !== null && 'action' in undo, '戻す 1 手が返っていない').toBe(true);
    r.dispatcher.dispatch((undo as { action: UserAction }).action);
    expect(r.body()).toBe(original);
    expect(noticeOf(r), '押した後も知らせが残っている').toBeNull();
    expect(currentMoveOffer()).toBeNull();
  });

  it.each([
    ['日付だけ', '- [ ] 見積を送る @2026-08-25'],
    ['時刻 1 点', '- [ ] 朝会 @2026-08-25 09:30'],
    ['期間(長さを保ってずらした分も戻る)', '- [ ] 出張 @2026-08-25..2026-08-28'],
    ['日付が行の途中にある(差し替えなので位置も変わらない)', '- [ ] 朝会 @2026-08-25 の議題'],
  ])('🔴 %s も、ドロップして戻すと元の字', (_name, original) => {
    const r = rig(original);
    drop(r, '0', '2026-08-25', '2026-08-27');
    expect(r.body(), '前提: 動いている').not.toBe(original);
    r.dispatcher.dispatch((press(r) as { action: UserAction }).action);
    expect(r.body()).toBe(original);
  });

  it('🔴 「日付なし」へ外した直後の「元に戻す」で、日付・時刻・幅が戻る', () => {
    const original = '- [ ] 朝会 @2026-08-25 09:30..10:00';
    const r = rig(original);
    drop(r, '0', '2026-08-25', '');
    expect(r.body(), '前提: 記法ごと外れている').toBe('- [ ] 朝会');
    expect(noticeOf(r)).toBe('予定から外しました');
    r.dispatcher.dispatch((press(r) as { action: UserAction }).action);
    expect(r.body()).toBe(original);
  });

  it('⚠ 限界を pin する: 行の途中に書いた日付を「日付なし」へ外して戻すと、日付は行の末尾に付く', () => {
    // 日付を外すときに位置の記憶は持たない(書き換えは「付ける」の規則 = 行末に足す)。日付・時刻は戻る
    const r = rig('- [ ] 朝会 @2026-08-25 の議題');
    drop(r, '0', '2026-08-25', '');
    expect(r.body()).toBe('- [ ] 朝会 の議題');
    r.dispatcher.dispatch((press(r) as { action: UserAction }).action);
    expect(r.body()).toBe('- [ ] 朝会 の議題 @2026-08-25');
  });

  it('🔴 ノート 1 件が丸ごと予定(frontmatter の date:)も戻る', () => {
    const original = '---\ndate: 2026-08-25\n---\n本文';
    const r = rig(original, '2026-08-25');
    drop(r, '', '2026-08-25', '2026-08-27');
    expect(r.body(), '前提: 動いている').toContain('date: 2026-08-27');
    expect(noticeOf(r)).toBe('8/27(木) へ動かしました');
    r.dispatcher.dispatch((press(r) as { action: UserAction }).action);
    expect(r.body()).toBe(original);
  });

  it('🔴 動かした後に同じ行の日付が直されていたら、戻さずに理由を言う', () => {
    const r = rig('- [ ] 会議 @2026-08-25 14:00');
    drop(r, '0', '2026-08-25', '2026-08-27');
    r.edit('- [ ] 会議 @2026-09-03 14:00');
    const writesBefore = r.writes();
    expect(press(r)).toEqual({ refusal: '動かした後に予定が変わったので、元に戻せませんでした' });
    expect(r.writes(), '戻さないはずが書き込んだ').toBe(writesBefore);
    expect(r.body()).toBe('- [ ] 会議 @2026-09-03 14:00');
  });

  it('🔴 別の窓が行を差し込み、N 行目が「同じ日・同じ時刻の別の予定」になっても戻さない(中身の指紋)', () => {
    const r = rig('- [ ] 会議 @2026-08-25 14:00');
    drop(r, '0', '2026-08-25', '2026-08-27');
    // 先頭に別の予定が差し込まれ、0 行目は「別件」(動かした後と同じ日・同じ時刻)になり、会議は 1 行目へずれた
    r.edit('- [ ] 別件 @2026-08-27 14:00\n- [ ] 会議 @2026-08-27 14:00');
    const writesBefore = r.writes();
    expect(press(r), '別の予定を書き換える手を返した').toEqual({
      refusal: '動かした後に予定が変わったので、元に戻せませんでした',
    });
    expect(r.writes()).toBe(writesBefore);
    expect(r.body()).toBe('- [ ] 別件 @2026-08-27 14:00\n- [ ] 会議 @2026-08-27 14:00');
  });

  it('対照群: 別の窓が末尾に行を足しただけなら(行番号が動かない)、戻せる', () => {
    const r = rig('- [ ] 会議 @2026-08-25 14:00');
    drop(r, '0', '2026-08-25', '2026-08-27');
    r.edit('- [ ] 会議 @2026-08-27 14:00\n- [ ] 追加 @2026-08-30');
    expect(press(r)).toHaveProperty('action');
  });

  it('書込と走査の間に押しても(走査はまだ動かす前の姿)戻す手は返る', () => {
    const r = rig('- [ ] 会議 @2026-08-25 14:00');
    drop(r, '0', '2026-08-25', '2026-08-27');
    r.edit('- [ ] 会議 @2026-08-25 14:00');
    expect(press(r)).toHaveProperty('action');
  });

  it('1 手だけ持つ: 次に動かすと置き換わり、戻すのは新しいほう。2 度押しても何も起きない', () => {
    const r = rig('- [ ] 一 @2026-08-25\n- [ ] 二 @2026-08-26');
    drop(r, '0', '2026-08-25', '2026-08-27');
    drop(r, '1', '2026-08-26', '2026-08-28');
    expect(noticeOf(r)).toBe('8/28(金) へ動かしました');
    r.dispatcher.dispatch((press(r) as { action: UserAction }).action);
    expect(r.body(), '新しい 1 手だけ戻る').toBe('- [ ] 一 @2026-08-27\n- [ ] 二 @2026-08-26');
    expect(press(r)).toBeNull();
  });
});

describe('降ろす条件', () => {
  it('数秒で知らせごと降ろす。⚠ 押す前には降ろさない', () => {
    const r = rig('- [ ] 会議 @2026-08-25');
    drop(r, '0', '2026-08-25', '2026-08-27');
    vi.advanceTimersByTime(MOVE_OFFER_MS - 1);
    expect(noticeOf(r), '時間が来る前に降りた').not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(noticeOf(r), '時間が来ても残っている').toBeNull();
    expect(currentMoveOffer()).toBeNull();
  });

  const down = (x: number, y: number): void => {
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
  };
  const click = (x: number, y: number, target: Element = document.body): void => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
  };

  it('🔴 どこかを(動かさず)クリックすると降ろす', () => {
    const r = rig('- [ ] 会議 @2026-08-25');
    drop(r, '0', '2026-08-25', '2026-08-27');
    vi.advanceTimersByTime(1); // 聞き始めるのは次の tick から
    down(10, 10);
    click(10, 10);
    expect(noticeOf(r)).toBeNull();
    expect(currentMoveOffer()).toBeNull();
  });

  it('🔴 スクロールでは降ろさない / 押した位置から大きく動かした押し方(つまみのドラッグ・なぞり)も降ろさない', () => {
    const r = rig('- [ ] 会議 @2026-08-25');
    drop(r, '0', '2026-08-25', '2026-08-27');
    vi.advanceTimersByTime(1);
    document.dispatchEvent(new Event('scroll'));
    document.body.dispatchEvent(new Event('wheel', { bubbles: true }));
    down(10, 10); // 押しただけ(つまみを掴んだ)では降ろさない ── 以前は pointerdown で降ろしていた
    expect(currentMoveOffer(), '押しただけで降りた').not.toBeNull();
    click(10, 200); // 大きく動かしてから離した
    expect(currentMoveOffer(), '大きく動かした押し方で降りた').not.toBeNull();
    expect(noticeOf(r)).not.toBeNull();
  });

  it('「元に戻す」自身のクリックでは、押す前に降ろさない', () => {
    const r = rig('- [ ] 会議 @2026-08-25');
    drop(r, '0', '2026-08-25', '2026-08-27');
    vi.advanceTimersByTime(1);
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'schedule-undo-move');
    document.body.append(btn);
    click(0, 0, btn);
    expect(currentMoveOffer()).not.toBeNull();
  });
});

describe('画面の下の「元に戻す」(status-undo)', () => {
  it('🔴 出ているのがこの 1 手の知らせのときだけ出て、押し先と字が「予定の元に戻す」に替わる', () => {
    const r = rig('- [ ] 会議 @2026-08-25 14:00');
    drop(r, '0', '2026-08-25', '2026-08-27');
    const btn = document.createElement('button');
    btn.hidden = true;
    const st = { lastMove: null, lastAppend: null, noticeOpen: null, notice: noticeOf(r) };
    expect(paintStatusUndo(btn, st, noticeOf(r)!)).toBe(true);
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toBe('元に戻す');
    expect(btn.getAttribute('data-pkc-action')).toBe('schedule-undo-move');
    // 別の知らせが上書きしたら畳む(「コピーしました」の隣に残さない)
    expect(paintStatusUndo(btn, { ...st, notice: 'コピーしました' }, 'コピーしました')).toBe(false);
    expect(btn.hidden).toBe(true);
  });
});

describe('押し口(binder の `schedule-undo-move`)', () => {
  /** 本物の dispatcher + 本物の binder。持っている物は `offerMoveUndo` で置く(書込が届いた状態)。 */
  function wired(busy: boolean) {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new RealDispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta()], relations: [] });
    const body = '- [ ] x @2026-08-27';
    d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: { cards: taskCardsOf('a', body), totalNotes: 1, scannedNotes: 1, truncated: false },
    });
    bindActions(root, d, { busy: () => busy });
    const events: string[] = [];
    d.onEvent((e) => events.push(e.type));
    const now = taskCardsOf('a', body)[0]!;
    const after = { date: now.date, time: now.time, timeEnd: now.timeEnd, until: now.until, text: 'x' };
    offerMoveUndo(root, d, {
      target: { kind: 'task', lid: 'a', line: 0 },
      before: { ...after, date: '2026-08-25' },
      after,
      verb: 'moved',
    });
    // 画面の下のボタン(`shell.ts` の `status-undo`)と同じ押し口
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'schedule-undo-move');
    root.append(btn);
    return { d, btn, events };
  }

  it('🔴 押すと逆向きの書換が 1 手撃たれ、知らせが降りる', () => {
    const w = wired(false);
    expect(w.d.getState().notice).toContain('動かしました');
    w.btn.click();
    expect(w.events, '押したのに書換が撃たれていない').toContain('REQUEST_BODY_REWRITE');
    expect(currentMoveOffer()).toBeNull();
  });

  it('🔴 取り込み・書き出しの最中は断る(本文を書く口と同じ門)── 持っている物は消さず、理由を言う', () => {
    const w = wired(true);
    w.btn.click();
    expect(w.events, '忙しい間に書いた').not.toContain('REQUEST_BODY_REWRITE');
    expect(w.d.getState().error ?? '').toContain('実行中');
    expect(currentMoveOffer(), '断ったのに持っている物が消えた').not.toBeNull();
  });
});
