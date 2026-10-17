/**
 * 🔴 **予定表の週の始まり**(#1163 の依頼 191。Gemini の裁定:月曜始まりを選べる設定を足す)。
 *
 * - `pkc3.schedule-week-start` … `0` = 日曜始まり(既定)/ `1` = 月曜始まり
 *
 * ⚠ **ノートの本文にも container にも入れない**(`schedule-notify.ts` と同じ判断 ── この端末の見え方の好み)。
 * ⚠ 読むたびに保存を見る(予定表の窓は別のウィンドウで、書き手が複数)。
 * 🔑 描き手は変わったときの知らせを受ける(`subscribe`)── 好みを変えた直後に、いま出ている面を描き直すため。
 */
import {
  normalizeWeekStart,
  WEEK_START_DEFAULT,
  type WeekStart,
} from '@features/schedule/week-start';

export const WEEK_START_KEY = 'pkc3.schedule-week-start';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function readStorage(): Store | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class ScheduleWeekStartStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: WeekStart = WEEK_START_DEFAULT;
  /** 🔴 直近の書き込みが失敗したか(容量不足など)。真の間は読みも控え(書いた値)を返す。 */
  private failed = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: Store | null = readStorage()) {}

  get(): WeekStart {
    if (this.storage === null || this.failed) return this.fallback;
    try {
      return normalizeWeekStart(this.storage.getItem(WEEK_START_KEY));
    } catch {
      return this.fallback;
    }
  }

  set(ws: WeekStart): void {
    const v = normalizeWeekStart(ws);
    this.fallback = v;
    this.failed = false;
    try {
      this.storage?.setItem(WEEK_START_KEY, String(v));
    } catch {
      this.failed = true;
      /* この session では効いている(控えが持つ) */
    }
    for (const l of [...this.listeners]) l();
  }

  /** 変わったときに呼ぶ。返す関数で外す。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** アプリ共有の 1 個。 */
export const appScheduleWeekStart = new ScheduleWeekStartStore();
