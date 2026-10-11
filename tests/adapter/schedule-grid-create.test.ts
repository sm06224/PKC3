/** @vitest-environment happy-dom */
/**
 * 🔴 **時間の目盛りの空いた所をドラッグして、予定を作る**(#855 段 B-2)。実体は
 * `src/adapter/ui/render/schedule-grid-create.ts`。計算そのものは `tests/features/day-layout.test.ts`。
 *
 * ## ここが見るもの / 見ないもの
 *
 * 🔴 **見る**: 繋がり ── ドラッグして名前を打って `Enter` を押した 1 手が、**今日のノートの本文の字**まで届くか。
 * ⚠ 観測点は本文にする(「欄が出た」で止めると、書かないのに緑になる)。
 *
 * ⚠ **見ない**: 実際の 1 時間の高さ・実ブラウザの焦点・指の長押し → `tests/smoke/schedule.smoke.spec.ts`。
 * ⚠ happy-dom は幅も高さも持たない ── 列の `getBoundingClientRect` を**24 時間 = 960px**(1 時間 40px)に差し替える。
 * ⚠ 「いま指の下に何が在るか」は列の要素へ直に撃つ(`schedule-grid-drag.test.ts` と同じ作法)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { UserAction } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { addScheduleItem, bindActions } from '../../src/adapter/ui/actions/binder';
import { installScheduleGridDrag } from '../../src/adapter/ui/render/schedule-grid-drag';
import { installScheduleGridCreate } from '../../src/adapter/ui/render/schedule-grid-create';
import { LONG_PRESS_MS } from '../../src/adapter/ui/actions/long-press';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { stubRevisionOps } from '../helpers/revision-stub';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import { todayNoteTitle } from '../../src/features/schedule/today-note';

const TODAY = new Date(2026, 7, 23); // 2026-08-23(日)
const HOUR = 40;
const LANE_H = HOUR * 24;
const minPx = (min: number): number => (min / 60) * HOUR;
const NOTE_TITLE = todayNoteTitle(new Date());

function meta(lid: string, title: string = NOTE_TITLE): EntryMeta {
  return {
    lid,
    title, // 🔑 既定は「今日のノート」(書き口が実際の今日で引く)
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
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LANE_SEL = '[data-pkc-field="schedule-day-lane"], [data-pkc-field="schedule-weekview-lane"]';
const BOX = '[data-pkc-field="schedule-create-box"]';
const INPUT = '[data-pkc-field="schedule-create-input"]';
const GHOST = '[data-pkc-field="schedule-drag-ghost"]';

function setup(body: string, mode: 'day' | 'week', title: string = NOTE_TITLE) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const store: Record<string, string> = { e1: body };
  const host = document.createElement('div');
  host.setAttribute('data-pkc-view-pane', 'schedule');
  regions.browseHost.append(host);
  const view = new ScheduleRenderer(host, () => TODAY);
  d.onState((s) => view.render(s));
  bindActions(root, d, {});
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      store[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1', title)], relations: [] });
  const scan = (b: string = body): void =>
    d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: { cards: taskCardsOf('e1', b), totalNotes: 1, scannedNotes: 1, truncated: false },
    });
  scan();
  const dispatched: UserAction[] = [];
  const orig = d.dispatch.bind(d);
  d.dispatch = (a: UserAction) => {
    dispatched.push(a);
    return orig(a);
  };
  const detachDrag = installScheduleGridDrag(root, d);
  const detachCreate = installScheduleGridCreate(root, d);
  (root.querySelector(`[data-pkc-action="schedule-mode"][data-pkc-mode="${mode}"]`) as HTMLElement).click();
  for (const lane of root.querySelectorAll<HTMLElement>(LANE_SEL)) {
    lane.getBoundingClientRect = () =>
      ({ top: 0, left: 0, bottom: LANE_H, right: 100, width: 100, height: LANE_H, x: 0, y: 0 }) as DOMRect;
  }
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  const laneSel = `[data-pkc-field="${mode === 'day' ? 'schedule-day-lane' : 'schedule-weekview-lane'}"]`;
  return {
    root,
    d,
    store,
    dispatched,
    qa,
    scan,
    lanes: () => qa(laneSel),
    laneCards: () => qa(`${laneSel} > [data-pkc-entry]`),
    input: () => root.querySelector<HTMLInputElement>(INPUT),
    detach: () => {
      detachDrag();
      detachCreate();
    },
  };
}

function pointer(el: Element, type: string, y: number, kind = 'mouse', pointerId = 1, x = 0): boolean {
  return el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: kind,
      button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      pointerId,
      clientX: x,
      clientY: y,
    }),
  );
}
/** 空いた所を `y0` から `y1` までドラッグして離す。 */
function dragEmpty(lane: HTMLElement, y0: number, y1: number): void {
  pointer(lane, 'pointerdown', y0);
  pointer(lane, 'pointermove', y1);
  pointer(lane, 'pointerup', y1);
}
function key(el: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}
const appends = (s: { dispatched: UserAction[] }): UserAction[] =>
  s.dispatched.filter((a) => a.type === 'APPEND_TO_ENTRY');

const BODY = '- [ ] 会議 @2026-08-23 14:00..15:00\n';

afterEach(() => {
  vi.useRealTimers();
  resetAppDialogForTest();
  document.body.innerHTML = '';
});

describe('空いた所をドラッグすると、入力欄つきの枠が出る', () => {
  it('🔴 「日」: 10:00 から 11:30 までドラッグして離すと、枠に 10:00〜11:30 と入力欄が出て、焦点が入る', () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    const box = s.qa(BOX);
    expect(box, '枠が出ていない').toHaveLength(1);
    expect(box[0]!.textContent).toContain('10:00〜11:30');
    expect(s.input(), '入力欄が出ていない').not.toBeNull();
    expect(document.activeElement, '入力欄に焦点が入っていない').toBe(s.input());
    expect(s.qa(GHOST), '離したのに影が残っている').toHaveLength(0);
    s.detach();
  });

  it('動かしている間は点線の枠(影)が出て、字は 15 分刻み', () => {
    const s = setup(BODY, 'day');
    pointer(s.lanes()[0]!, 'pointerdown', minPx(600));
    pointer(s.lanes()[0]!, 'pointermove', minPx(600 + 83)); // 83 分 → 90 分
    const ghost = s.qa(GHOST);
    expect(ghost).toHaveLength(1);
    expect(ghost[0]!.textContent).toBe('10:00〜11:30');
    s.detach();
  });

  it('🔴 上へドラッグしても同じ枠(始まりと終わりを入れ替える)', () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(690), minPx(600));
    expect(s.qa(BOX)[0]!.textContent).toContain('10:00〜11:30');
    s.detach();
  });

  it('4px 未満の動きでは始まらない(ただの click)', () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, 400, 402);
    expect(s.qa(BOX)).toHaveLength(0);
    expect(s.qa(GHOST)).toHaveLength(0);
    s.detach();
  });

  it('🔴 札の上で始めたドラッグでは作らない(札を動かす掴みが受ける)', async () => {
    const s = setup(BODY, 'day');
    const card = s.laneCards()[0]!;
    pointer(card, 'pointerdown', minPx(14 * 60));
    pointer(s.lanes()[0]!, 'pointermove', minPx(14 * 60 + 120));
    pointer(s.lanes()[0]!, 'pointerup', minPx(14 * 60 + 120));
    await tick();
    expect(s.qa(BOX), '札の上で始めたのに枠が出た').toHaveLength(0);
    expect(appends(s), '札を動かしたのに予定が足された').toHaveLength(0);
    expect(s.store['e1'], '前提: 札を動かす掴みが働いた').toBe('- [ ] 会議 @2026-08-23 16:00..17:00\n');
    s.detach();
  });
});

describe('入力欄の Enter / Esc / 空', () => {
  it('🔴 Enter で、今日のノートの末尾へ `- [ ] 名前 @日付 10:00..11:30` が書かれ、欄は消える', async () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = '打ち合わせ';
    key(s.input()!, 'Enter');
    await tick();
    expect(s.store['e1']).toBe(`${BODY}\n- [ ] 打ち合わせ @2026-08-23 10:00..11:30\n`);
    expect(s.qa(BOX), '書けたのに欄が残っている').toHaveLength(0);
    s.detach();
  });

  it('🔴 空のまま Enter は何も書かずに欄を消す', async () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = '   ';
    key(s.input()!, 'Enter');
    await tick();
    expect(appends(s), '空なのに書こうとした').toHaveLength(0);
    expect(s.store['e1']).toBe(BODY);
    expect(s.qa(BOX)).toHaveLength(0);
    expect(s.d.getState().error ?? '', '空の Enter で断りが出た(黙って畳む)').toBe('');
    s.detach();
  });

  it('🔴 Esc は字があっても何も書かずに欄を消す。開いているノートの選択までは外さない(伝えない)', async () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = '消える';
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    key(s.input()!, 'Escape');
    document.removeEventListener('keydown', seen);
    await tick();
    expect(s.qa(BOX)).toHaveLength(0);
    expect(appends(s)).toHaveLength(0);
    expect(seen, 'Esc が外へ伝わった(ノートの選択が外れる)').not.toHaveBeenCalled();
    s.detach();
  });

  /**
   * 🔴 **枠の右端の ×**(#855。Gemini 裁定 = #1163 のコメント 6104130726 の 9)。
   * マウスだけで「作るのをやめる」── 字を打っていても、書かずに畳む(Esc と同じ)。
   */
  const CANCEL = '[data-pkc-field="schedule-create-cancel"]';
  it('🔴 枠には × があり、押すと何も書かずに畳む(字を打っていても)', async () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    const x = s.qa(`${BOX} ${CANCEL}`);
    expect(x, '枠の中に × が無い').toHaveLength(1);
    expect(x[0]!.getAttribute('aria-label')).toBe('予定を作るのをやめる');
    s.input()!.value = '消える';
    await tick(); // 離した直後の click は飲まれる(ここで押すのは、その後の別の click)
    x[0]!.click();
    await tick();
    expect(s.qa(BOX), '× を押したのに枠が残っている').toHaveLength(0);
    expect(appends(s), '× で書いてしまった').toHaveLength(0);
    expect(s.store['e1']).toBe(BODY);
    s.detach();
  });

  it('🔴 × で捨てた枠は、日を替えて戻しても戻ってこない', async () => {
    const clickField = (s: ReturnType<typeof setup>, field: string): void =>
      (s.root.querySelector(`[data-pkc-field="${field}"]`) as HTMLElement).click();
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = '捨てる';
    await tick();
    clickField(s, 'schedule-day-next');
    clickField(s, 'schedule-day-prev'); // 預かりから戻った枠
    s.qa(CANCEL)[0]!.click();
    expect(s.qa(BOX)).toHaveLength(0);
    clickField(s, 'schedule-day-next');
    clickField(s, 'schedule-day-prev');
    expect(s.qa(BOX), '× で捨てたのに戻ってきた').toHaveLength(0);
    s.detach();
  });

  it('「週」の枠にも × がある / × の上を押しても新しい枠は始まらない', async () => {
    const s = setup(BODY, 'week');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    const x = s.qa(CANCEL)[0]!;
    expect(x, '「週」の枠に × が無い').toBeDefined();
    pointer(x, 'pointerdown', minPx(610));
    pointer(x, 'pointerup', minPx(610));
    expect(s.qa(BOX), '× を押し始めただけで枠が畳まれた / 増えた').toHaveLength(1);
    s.detach();
  });

  it('🔴 日本語入力の変換中の Enter は送らない(確定であって送信ではない)', async () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = 'かいぎ';
    key(s.input()!, 'Enter', { isComposing: true });
    key(s.input()!, 'Enter', { keyCode: 229 });
    await tick();
    expect(appends(s), '変換中の Enter で書いた').toHaveLength(0);
    expect(s.qa(BOX), '変換中の Enter で欄が消えた').toHaveLength(1);
    expect(s.input()!.value).toBe('かいぎ');
    // 対照群: 変換が終われば同じ欄から送れる
    key(s.input()!, 'Enter');
    await tick();
    expect(s.store['e1']).toContain('- [ ] かいぎ @2026-08-23 10:00..11:30');
    s.detach();
  });

  it('🔴 焦点が外れたとき: 空なら畳む / 字があれば残す(打った字を失わない)', () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = '途中';
    s.input()!.dispatchEvent(new FocusEvent('blur'));
    expect(s.qa(BOX), '字があるのに畳んだ').toHaveLength(1);
    expect(s.input()!.value).toBe('途中');
    s.input()!.value = '';
    s.input()!.dispatchEvent(new FocusEvent('blur'));
    expect(s.qa(BOX), '空なのに残った').toHaveLength(0);
    s.detach();
  });

  it('字を打ちかけの枠があるとき、空いた所を押しても失わない(焦点を欄へ戻す)', () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = '途中';
    pointer(s.lanes()[0]!, 'pointerdown', minPx(300));
    pointer(s.lanes()[0]!, 'pointermove', minPx(400));
    pointer(s.lanes()[0]!, 'pointerup', minPx(400));
    expect(s.qa(BOX)).toHaveLength(1);
    expect(s.input()!.value).toBe('途中');
    s.detach();
  });

  it('🔴 描き直しで入力欄も打った字も消えない(走査の更新が来ても同じ欄)', () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    const input = s.input()!;
    input.value = '打ちかけ';
    s.scan();
    s.scan('- [ ] 会議 @2026-08-23 14:00..15:00\n- [ ] 別 @2026-08-23 09:00\n');
    expect(s.input(), '描き直しで欄が作り直された').toBe(input);
    expect(s.input()!.isConnected).toBe(true);
    expect(s.input()!.value).toBe('打ちかけ');
    s.detach();
  });

  it('日を切り替えたら、前の日の枠は畳む(別の日の列に居座らない)', async () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    await tick(); // 離した直後の click を飲む窓が閉じるのを待つ
    const dateBefore = s.lanes()[0]!.closest('[data-pkc-drop-date]')?.getAttribute('data-pkc-drop-date');
    (s.root.querySelector('[data-pkc-field="schedule-day-next"]') as HTMLElement).click();
    const dateAfter = s.lanes()[0]!.closest('[data-pkc-drop-date]')?.getAttribute('data-pkc-drop-date');
    expect(dateAfter, '前提: 日が切り替わった').not.toBe(dateBefore);
    expect(s.qa(BOX)).toHaveLength(0);
    s.detach();
  });
});

describe('ダブルクリック', () => {
  it('🔴 空いた所をダブルクリックすると、押した所(15 分刻み)から 30 分の枠と入力欄', () => {
    const s = setup(BODY, 'day');
    s.lanes()[0]!.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientY: minPx(14 * 60 + 10) }),
    );
    const box = s.qa(BOX);
    expect(box).toHaveLength(1);
    expect(box[0]!.textContent).toContain('14:15〜14:45');
    expect(document.activeElement).toBe(s.input());
    s.detach();
  });

  it('札の上のダブルクリックでは出ない', () => {
    const s = setup(BODY, 'day');
    s.laneCards()[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientY: 560 }));
    expect(s.qa(BOX)).toHaveLength(0);
    s.detach();
  });
});

describe('取り消し(書かずに畳む)', () => {
  it('🔴 ドラッグ中の Esc: 枠は出ず、Esc は外へ伝わらない(開いているノートを閉じない)', () => {
    const s = setup(BODY, 'day');
    pointer(s.lanes()[0]!, 'pointerdown', minPx(600));
    pointer(s.lanes()[0]!, 'pointermove', minPx(690));
    expect(s.qa(GHOST)).toHaveLength(1);
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    const e = key(s.lanes()[0]!, 'Escape');
    document.removeEventListener('keydown', seen);
    expect(e.defaultPrevented).toBe(true);
    expect(seen, 'Esc がノートの選択解除まで届いた').not.toHaveBeenCalled();
    expect(s.qa(GHOST), '影が残っている').toHaveLength(0);
    pointer(s.lanes()[0]!, 'pointerup', minPx(690));
    expect(s.qa(BOX), 'Esc の後に離したら枠が出た').toHaveLength(0);
    s.detach();
  });

  it('始める前の Esc は今までどおり通す', () => {
    const s = setup(BODY, 'day');
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    key(s.lanes()[0]!, 'Escape');
    document.removeEventListener('keydown', seen);
    expect(seen).toHaveBeenCalled();
    s.detach();
  });

  it('🔴 離した合図が届かない(ボタンは離れているのに move が来る)と、書かずに畳む', () => {
    const s = setup(BODY, 'day');
    pointer(s.lanes()[0]!, 'pointerdown', minPx(600));
    pointer(s.lanes()[0]!, 'pointermove', minPx(690));
    s.lanes()[0]!.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse',
        pointerId: 1,
        buttons: 0,
        clientY: minPx(700),
      }),
    );
    expect(s.qa(GHOST)).toHaveLength(0);
    pointer(s.lanes()[0]!, 'pointerup', minPx(700));
    expect(s.qa(BOX)).toHaveLength(0);
    s.detach();
  });

  it('窓の blur / pointercancel でも畳む', () => {
    const s = setup(BODY, 'day');
    pointer(s.lanes()[0]!, 'pointerdown', minPx(600));
    pointer(s.lanes()[0]!, 'pointermove', minPx(690));
    window.dispatchEvent(new Event('blur'));
    expect(s.qa(GHOST)).toHaveLength(0);
    pointer(s.lanes()[0]!, 'pointerdown', minPx(600));
    pointer(s.lanes()[0]!, 'pointermove', minPx(690));
    pointer(s.lanes()[0]!, 'pointercancel', minPx(690));
    expect(s.qa(GHOST)).toHaveLength(0);
    pointer(s.lanes()[0]!, 'pointerup', minPx(690));
    expect(s.qa(BOX)).toHaveLength(0);
    s.detach();
  });
});

describe('指・ペンは長押しで始める', () => {
  it('🔴 長押しすると始まる / 長押しの前に動けばスクロールに譲る', () => {
    vi.useFakeTimers();
    const s = setup(BODY, 'day');
    const lane = s.lanes()[0]!;
    pointer(lane, 'pointerdown', minPx(600), 'touch');
    pointer(lane, 'pointermove', minPx(690), 'touch'); // 長押しの前に大きく動いた
    vi.advanceTimersByTime(LONG_PRESS_MS + 50);
    pointer(lane, 'pointermove', minPx(700), 'touch');
    pointer(lane, 'pointerup', minPx(700), 'touch');
    expect(s.qa(BOX), 'スクロールのつもりの動きで枠が出た').toHaveLength(0);

    pointer(lane, 'pointerdown', minPx(600), 'touch');
    vi.advanceTimersByTime(LONG_PRESS_MS + 50);
    pointer(lane, 'pointermove', minPx(690), 'touch');
    pointer(lane, 'pointerup', minPx(690), 'touch');
    expect(s.qa(BOX)).toHaveLength(1);
    expect(s.qa(BOX)[0]!.textContent).toContain('10:00〜11:30');
    s.detach();
  });
});

describe('「週」: 押した列の日に作る', () => {
  it('🔴 4 番目の列(2026-08-26)で作ると、その日の日付で書かれる', async () => {
    const s = setup(BODY, 'week');
    expect(s.lanes()).toHaveLength(7);
    dragEmpty(s.lanes()[3]!, minPx(540), minPx(600));
    expect(s.qa(BOX)).toHaveLength(1);
    expect(s.lanes()[3]!.contains(s.qa(BOX)[0]!), '押した列に枠が出ていない').toBe(true);
    s.input()!.value = '週の予定';
    key(s.input()!, 'Enter');
    await tick();
    expect(s.store['e1']).toBe(`${BODY}\n- [ ] 週の予定 @2026-08-26 09:00..10:00\n`);
    s.detach();
  });
});

describe('書き口は予定の面の「足す」と同じ 1 本', () => {
  it('🔴 「足す」ボタンも目盛りの作成も `addScheduleItem` を通る(同じ行の綴り・同じ追記の口)', async () => {
    const s = setup(BODY, 'day');
    (s.root.querySelector('[data-pkc-field="schedule-quick-text"]') as HTMLInputElement).value = '電話';
    (s.root.querySelector('[data-pkc-field="schedule-quick-date"]') as HTMLInputElement).value = '2026-08-24';
    (s.root.querySelector('[data-pkc-action="schedule-quick-add"]') as HTMLElement).click();
    await tick();
    expect(s.store['e1']).toBe(`${BODY}\n- [ ] 電話 @2026-08-24\n`);
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = '会食';
    key(s.input()!, 'Enter');
    await tick();
    expect(s.store['e1']).toBe(`${BODY}\n- [ ] 電話 @2026-08-24\n\n- [ ] 会食 @2026-08-23 10:00..11:30\n`);
    expect(appends(s)).toHaveLength(2);
    s.detach();
  });

  it('🔴 断られた回(読み込み中)は false を返し、理由を出し、書かない', () => {
    const d = new Dispatcher();
    expect(d.getState().phase).not.toBe('ready');
    const ok = addScheduleItem(d, { text: 'x', date: '2026-08-23', time: '10:00', timeEnd: '11:00' });
    expect(ok).toBe(false);
    expect(d.getState().error ?? '').toContain('足してください');
  });

  it('🔴 断られたとき(今日のノートが無いのに編集中)は打った字を残す', async () => {
    const s = setup(BODY, 'day', '別のノート');
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    s.d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: BODY });
    s.d.dispatch({ type: 'START_EDIT' });
    expect(s.d.getState().phase, '前提: 編集中').toBe('editing');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = '残る';
    key(s.input()!, 'Enter');
    await tick();
    expect(s.d.getState().error ?? '', '断った理由が出ていない').toContain('今日のノートがまだ無い');
    expect(s.input()?.value, '断られたのに打った字を捨てた').toBe('残る');
    s.detach();
  });
});

describe('日・週を切り替えても、打ちかけの字を静かに失わない', () => {
  const clickField = (s: ReturnType<typeof setup>, field: string): void =>
    (s.root.querySelector(`[data-pkc-field="${field}"]`) as HTMLElement).click();

  it('🔴 字を打ちかけて日を切り替えると預かり、その日がまた出たら字ごと戻って焦点が入る', async () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = '打ちかけ';
    await tick();
    clickField(s, 'schedule-day-next');
    expect(s.qa(BOX), '別の日の列に枠が居座っている').toHaveLength(0);
    clickField(s, 'schedule-day-prev');
    expect(s.qa(BOX), '日を戻したのに枠が戻らない').toHaveLength(1);
    expect(s.input()!.value, '打った字が戻っていない').toBe('打ちかけ');
    expect(s.qa(BOX)[0]!.textContent).toContain('10:00〜11:30');
    expect(document.activeElement).toBe(s.input());
    // 戻した枠から書ける
    key(s.input()!, 'Enter');
    await tick();
    expect(s.store['e1']).toBe(`${BODY}\n- [ ] 打ちかけ @2026-08-23 10:00..11:30\n`);
    s.detach();
  });

  it('🔴 空の枠は預からない(戻ってこない)', async () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    await tick();
    clickField(s, 'schedule-day-next');
    clickField(s, 'schedule-day-prev');
    expect(s.qa(BOX)).toHaveLength(0);
    s.detach();
  });

  it('🔴 「日」から「週」へ移っても字は消えない: 隠れた日の列ではなく、見えている週の同じ日の列に出る', async () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = '週へ持っていく';
    await tick();
    (s.root.querySelector('[data-pkc-action="schedule-mode"][data-pkc-mode="week"]') as HTMLElement).click();
    const boxes = s.qa(BOX);
    expect(boxes, '枠が 1 つだけ出ている').toHaveLength(1);
    expect(boxes[0]!.closest('[hidden]'), '隠れた列に枠が残っている').toBeNull();
    expect(boxes[0]!.parentElement!.getAttribute('data-pkc-field')).toBe('schedule-weekview-lane');
    expect(boxes[0]!.parentElement!.getAttribute('data-pkc-drop-date')).toBe('2026-08-23');
    expect(s.input()!.value).toBe('週へ持っていく');
    s.detach();
  });

  it('🔴 預かりがある間に別の日で作り始めると、理由を出して断る(預かりも新しい枠も増えない)', async () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = '預かり中';
    await tick();
    clickField(s, 'schedule-day-next');
    await tick();
    dragEmpty(s.lanes()[0]!, minPx(300), minPx(360));
    expect(s.qa(BOX), '預かりがあるのに新しい枠が出た(預かりを捨てる道になる)').toHaveLength(0);
    expect(s.d.getState().error ?? '', '断った理由が出ていない').toContain('2026-08-23');
    s.lanes()[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientY: 300 }));
    expect(s.qa(BOX), 'ダブルクリックで預かりを捨てる道ができた').toHaveLength(0);
    clickField(s, 'schedule-day-prev');
    expect(s.input()!.value, '預かった字が失われた').toBe('預かり中');
    s.detach();
  });

  it('🔴 Esc で捨てれば預かりも消え、日を戻しても出ない / また作れる', async () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.input()!.value = '捨てる';
    await tick();
    clickField(s, 'schedule-day-next');
    clickField(s, 'schedule-day-prev'); // 戻った枠
    key(s.input()!, 'Escape');
    expect(s.qa(BOX)).toHaveLength(0);
    clickField(s, 'schedule-day-next');
    clickField(s, 'schedule-day-prev');
    expect(s.qa(BOX), 'Esc で捨てたのに戻ってきた').toHaveLength(0);
    await tick();
    dragEmpty(s.lanes()[0]!, minPx(300), minPx(360));
    expect(s.qa(BOX), '預かりが無いのに作れない').toHaveLength(1);
    s.detach();
  });
});

describe('短い枠でも入力欄を隠さない', () => {
  it('🔴 1 時間に満たない枠は時刻の字を隠す印を持ち、時刻は title に残る / 1 時間以上は持たない', () => {
    const s = setup(BODY, 'day');
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(600) + 8); // 12 分 → 15 分の枠
    expect(s.qa(BOX)[0]!.hasAttribute('data-pkc-short')).toBe(true);
    expect(s.qa(BOX)[0]!.title).toBe('10:00〜10:15');
    key(s.input()!, 'Escape');
    s.lanes()[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientY: minPx(720) }));
    expect(s.qa(BOX)[0]!.hasAttribute('data-pkc-short'), '30 分の枠').toBe(true);
    key(s.input()!, 'Escape');
    dragEmpty(s.lanes()[0]!, minPx(300), minPx(360)); // 60 分
    expect(s.qa(BOX)[0]!.hasAttribute('data-pkc-short'), '1 時間の枠で時刻の字を隠した').toBe(false);
    s.detach();
  });
});

describe('端の自動スクロール / 取り消しの残りの道 / 離した直後の click', () => {
  /** 端の自動スクロールを試すための入れ物(列は動いたぶんだけ上へずれる)。 */
  function scrollable(s: ReturnType<typeof setup>): HTMLElement {
    const scroller = s.root.querySelector<HTMLElement>('[data-pkc-field="schedule-day-scroll"]')!;
    scroller.getBoundingClientRect = () =>
      ({ top: 0, left: 0, bottom: 300, right: 100, width: 100, height: 300, x: 0, y: 0 }) as DOMRect;
    scroller.scrollTop = 0;
    const lane = s.lanes()[0]!;
    lane.getBoundingClientRect = () =>
      ({
        top: -scroller.scrollTop,
        left: 0,
        bottom: LANE_H - scroller.scrollTop,
        right: 100,
        width: 100,
        height: LANE_H,
        x: 0,
        y: 0,
      }) as DOMRect;
    return scroller;
  }

  it('🔴 下の縁でドラッグを続けると、目盛りが下へ送られ、枠の終わりも延びる', async () => {
    const s = setup(BODY, 'day');
    const scroller = scrollable(s);
    const lane = s.lanes()[0]!;
    pointer(lane, 'pointerdown', 100);
    pointer(lane, 'pointermove', 290); // 下の縁(残り 10px < 32px)
    const first = s.qa(GHOST)[0]!.textContent!;
    await tick(120);
    expect(scroller.scrollTop, '下の縁なのに送られていない / 逆へ送られた').toBeGreaterThan(0);
    expect(s.qa(GHOST)[0]!.textContent, '送ったのに枠の終わりが延びていない').not.toBe(first);
    pointer(lane, 'pointerup', 290);
    s.detach();
  });

  it('🔴 ページが隠れたら、書かずに畳む', () => {
    const s = setup(BODY, 'day');
    pointer(s.lanes()[0]!, 'pointerdown', minPx(600));
    pointer(s.lanes()[0]!, 'pointermove', minPx(690));
    expect(s.qa(GHOST)).toHaveLength(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      delete (document as unknown as Record<string, unknown>)['visibilityState'];
    }
    expect(s.qa(GHOST), '隠れたのに影が残っている').toHaveLength(0);
    pointer(s.lanes()[0]!, 'pointerup', minPx(690));
    expect(s.qa(BOX)).toHaveLength(0);
    s.detach();
  });

  it('🔴 動かした後にポインタを失ったら(lostpointercapture)、影が消えて枠は出ない', () => {
    const s = setup(BODY, 'day');
    pointer(s.lanes()[0]!, 'pointerdown', minPx(600));
    pointer(s.lanes()[0]!, 'pointermove', minPx(690));
    expect(s.qa(GHOST)).toHaveLength(1);
    s.lanes()[0]!.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 }));
    expect(s.qa(GHOST), 'ポインタを失ったのに影が残っている').toHaveLength(0);
    pointer(s.lanes()[0]!, 'pointerup', minPx(690));
    expect(s.qa(BOX)).toHaveLength(0);
    s.detach();
  });

  it('🔴 離した直後の click は飲む(列の click に届かない)/ 次の周では通る', async () => {
    const s = setup(BODY, 'day');
    const seen = vi.fn();
    s.lanes()[0]!.addEventListener('click', seen);
    dragEmpty(s.lanes()[0]!, minPx(600), minPx(690));
    s.lanes()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(seen, '離した直後の click が列に届いた').not.toHaveBeenCalled();
    await tick();
    s.lanes()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(seen, '対照群: 次の周の click まで飲んだ').toHaveBeenCalledTimes(1);
    s.detach();
  });
});
