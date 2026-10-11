/**
 * 🔴 **開いた窓で、予定の見せ方の合図(`sched=week&day=`)を当てる**(#855 段 A-2 の直し)。
 *
 * ⚠ `main.ts` はどの test からも実行されないので、判断(日が無ければ見せ方だけ / 日があれば見せ方 + 日)は
 *   ここに置いて test する(`tests/adapter/schedule-week.test.ts`)。main.ts は呼ぶだけ。
 * 🔑 触るのは広い面の見せ方(`scheduleMode`)と見ている日(`scheduleDay`)だけ ──
 *   左の列の見せ方(`scheduleNarrowMode`)は動かさない。
 */
import { weekOf } from '@features/schedule/day-layout';

export interface ScheduleDispatch {
  readonly dispatch: (
    action:
      | { type: 'SET_SCHEDULE_MODE'; mode: 'week' }
      | { type: 'SET_SCHEDULE_DAY'; date: string },
  ) => void;
}

export function applyScheduleDeepLink(
  target: ScheduleDispatch,
  mode: 'week',
  day: string | null,
): void {
  target.dispatch({ type: 'SET_SCHEDULE_MODE', mode });
  // 日が無い合図は「今日に追従する」まま(null を撃たない ── 見ている日を巻き戻さない)
  if (day !== null) target.dispatch({ type: 'SET_SCHEDULE_DAY', date: day });
}

/**
 * 🔴 **同じ週のウィンドウは 2 枚作らない ── 開いているなら前に出す**(#855。Gemini 裁定 = #1163 の
 * コメント 6104130726 の 3)。
 *
 * 左の列の「週」を 2 回押すと、同じ週のウィンドウが 2 枚になっていた。付箋(`note-window-registry.ts`)と
 * **同じ仕掛け**に乗せる ── 週のウィンドウは「いま自分はこの週を出している」を放送し、押した側は
 * 台帳を**同期に**読んで、居れば「前に出て」と頼み、居なければ開く(`window.open` は gesture の中でしか
 * 通らないので、ここで待たない)。
 *
 * ⚠ 台帳の鍵は**週の最初の日**(`week 2026-10-04`)── 日が違っても同じ週なら同じ窓。
 * ⚠ 「前に出る」は保証できない(`note-window-registry.ts` の注記 ── headless では測れない)ので、
 *   画面の字は「前に出しました」とは言わず「すでに別のウィンドウで開いています」までにする。
 * 🔑 判断はここ(test される)── `main.ts` は台帳と窓を渡して呼ぶだけ。
 */
export const SCHEDULE_REGISTRY_CHANNEL = 'pkc3-schedule-window';

/** 週の窓の台帳の鍵。⚠ 読めない日は `null`(台帳に載せない / 引かない)。 */
export function weekWindowKey(day: string | null, today: string): string | null {
  const first = weekOf(day ?? today)?.[0];
  return first === undefined ? null : `week ${first}`;
}

export const WEEK_WINDOW_ALREADY =
  'この週は、すでに別のウィンドウで開いています(見つからないときは、もう一度押すと新しく開きます)';

/**
 * 🔴 **開いている窓を探せないとき、もう一度押せば新しく開く**(#855 の動線レビュー)。
 * 「前に出る」は保証できない(最小化 / 別のモニタ)ので、**この秒数のうちの 2 度目の押下**は開く。
 */
export const WEEK_REPEAT_PRESS_MS = 10_000;

/**
 * 🔴 **この窓が「週」で出している週の鍵**(台帳へ名乗る値)。予定の窓で、広い面が「週」のときだけ名乗る。
 * ⚠ `main.ts` の `announceWeek` が呼ぶだけ ── 条件(窓の種類 / 見せ方)をここに置いて test する。
 */
export function weekAnnounceKey(
  heldView: string | null,
  scheduleMode: 'list' | 'day' | 'week',
  scheduleDay: string | null,
  today: string,
): string | null {
  if (heldView !== 'schedule' || scheduleMode !== 'week') return null;
  return weekWindowKey(scheduleDay, today);
}

export interface WeekWindowDeps {
  readonly key: string | null;
  readonly whereIs: (key: string) => 'self' | 'other' | null;
  readonly raise: (key: string) => void;
  readonly reserve: (key: string) => void;
  readonly release: (key: string) => void;
  /** 窓を開く(開けたら `'window'`、開けなければ `'pane'`)。⚠ 同期に呼ぶ。 */
  readonly open: () => Promise<unknown>;
  readonly notice: (message: string) => void;
  /** いまの時刻(ms)。⚠ test が動かせるように口にする。 */
  readonly now: () => number;
}

/** 鍵 → 「前に出て」と頼んだ時刻。⚠ この窓(押す側)の中の記憶。 */
const raisedAt = new Map<string, number>();
/** test が記憶を空にする口。 */
export function resetWeekRaiseMemory(): void {
  raisedAt.clear();
}

/** @returns `'raised'` = 開いている窓へ頼んだ(新しい窓は開かない) / `'opened'` = 窓を開いた。 */
export function openOrRaiseWeekWindow(deps: WeekWindowDeps): 'raised' | 'opened' {
  const key = deps.key;
  if (key !== null) {
    const where = deps.whereIs(key);
    if (where !== null) {
      // ⚠ 自分が出している週なら、前に出す相手が居ない(いま見ているのがそれ)
      if (where === 'other') {
        const at = raisedAt.get(key);
        const again = at !== undefined && deps.now() - at <= WEEK_REPEAT_PRESS_MS;
        if (!again) {
          raisedAt.set(key, deps.now());
          deps.raise(key);
          deps.notice(WEEK_WINDOW_ALREADY);
          return 'raised';
        }
        // 2 度目(探しても見つからなかった)── 新しく開く。記憶は捨てる(3 度目は、また最初から)
        raisedAt.delete(key);
      } else {
        deps.notice(WEEK_WINDOW_ALREADY);
        return 'raised';
      }
    }
    // 🔑 見込みを先に載せる ── 窓が名乗るのは boot の後なので、2 度押しの間は台帳が空
    deps.reserve(key);
  }
  void deps.open().then((where) => {
    if (where !== 'window' && key !== null) deps.release(key);
  });
  return 'opened';
}
