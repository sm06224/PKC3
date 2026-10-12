/**
 * 🔴 **予定の知らせの好み 2 つと、「前に開いていた時刻」**(#855 20-C)。
 *
 * - `pkc3.schedule-lead` … `.ics` に入れるアラームの時間(分。既定 15、`0` = なし)
 * - `pkc3.schedule-missed` … 次に開いたとき見逃した予定を知らせるか(既定 入)
 * - `pkc3.schedule-last-open` … 🔴 **コレクションごと・端末ごと**に「最後に開いていた時刻」
 *
 * ⚠ **ノートの本文にも container にも入れない**(`opened-log.ts` と同じ判断)── 入れると書き出しに同乗し、
 *   HTML を渡した相手に**こちらがいつ開いていたか**が見える。cid は端末ごとに採番される
 *   (`main.ts`)ので、別のコレクション・別の端末の時刻と混ざらない。
 * ⚠ 前の時刻は**ここでは進めない**(読む → 数える → 進める、の順は呼び側 `main.ts`)。
 */
import { normalizeLead, SCHEDULE_LEAD_DEFAULT } from '@features/schedule/schedule-notify';

const LEAD_KEY = 'pkc3.schedule-lead';
const MISSED_KEY = 'pkc3.schedule-missed';
const LAST_OPEN_KEY = 'pkc3.schedule-last-open';
/** 憶えるコレクションの数の上限(古い順に捨てる)。 */
const LAST_OPEN_MAX = 20;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function readStorage(): Store | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class ScheduleNotifyStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fbLead = SCHEDULE_LEAD_DEFAULT;
  private fbMissed = true;
  private fbOpen: Record<string, number> = {};

  constructor(private readonly storage: Store | null = readStorage()) {}

  /** `.ics` に入れるアラームの分。⚠ 読むたびに保存を見る(書き手が複数)。 */
  lead(): number {
    if (this.storage === null) return this.fbLead;
    try {
      const raw = this.storage.getItem(LEAD_KEY);
      return raw === null ? SCHEDULE_LEAD_DEFAULT : normalizeLead(Number(raw));
    } catch {
      return this.fbLead;
    }
  }

  setLead(minutes: number): void {
    const n = normalizeLead(minutes);
    this.fbLead = n;
    try {
      this.storage?.setItem(LEAD_KEY, String(n));
    } catch {
      /* この session では効いている(控えが持つ) */
    }
  }

  /** 見逃した予定を知らせるか。既定は入。 */
  missedOn(): boolean {
    if (this.storage === null) return this.fbMissed;
    try {
      const raw = this.storage.getItem(MISSED_KEY);
      return raw === null ? true : raw === '1';
    } catch {
      return this.fbMissed;
    }
  }

  setMissedOn(on: boolean): void {
    this.fbMissed = on;
    try {
      this.storage?.setItem(MISSED_KEY, on ? '1' : '0');
    } catch {
      /* 同上 */
    }
  }

  private readOpen(): Record<string, number> {
    if (this.storage === null) return this.fbOpen;
    try {
      const raw = this.storage.getItem(LAST_OPEN_KEY);
      if (raw === null) return {};
      const o: unknown = JSON.parse(raw);
      if (typeof o !== 'object' || o === null || Array.isArray(o)) return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      return out;
    } catch {
      return this.fbOpen;
    }
  }

  /** このコレクションを最後に開いていた時刻(epoch ms)。まだ無ければ `null`。 */
  lastOpen(cid: string): number | null {
    return this.readOpen()[cid] ?? null;
  }

  /** いま開いていることを憶える。⚠ 他のコレクションの時刻は残す。 */
  stampOpen(cid: string, at: number): void {
    const all = this.readOpen();
    // 入れ直して末尾 = 新しい。上限を超えたら先頭(古い)から捨てる
    delete all[cid];
    all[cid] = at;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - LAST_OPEN_MAX))) delete all[k];
    this.fbOpen = all;
    try {
      this.storage?.setItem(LAST_OPEN_KEY, JSON.stringify(all));
    } catch {
      /* 憶えられないだけ(次回は初回扱いで何も出ない) */
    }
  }
}

/** アプリ共有の 1 個。 */
export const appScheduleNotify = new ScheduleNotifyStore();
