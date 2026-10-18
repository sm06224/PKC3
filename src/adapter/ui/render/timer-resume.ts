/**
 * 🔴 **計っている途中の時刻を、この端末に控える**(台帳 #1852 O1 / 依頼 240。Gemini 回答 = 推薦どおり「要る」)。
 *
 * ## 何が起きていたか
 *
 * 時間を計っている途中でタブを閉じたりリロードしたりすると、計っていた時間は消え、本文にも何も入らなかった(閉じる前の確認は出る)。
 * 🔑 始めた時刻を端末に控えておき、**同じタブ**を開き直したとき、計っていた途中から続けて計れるようにする。
 *
 * ## ⚠ 決めごと
 *
 * - **控えるのは「どのタブが」「どのノートを」「いつから」** ── 経過は持たない(経過は今の時刻との差で出る)。
 * - 🔴 **続きを計るのは、控えたタブだけ**(`tabId`)。⚠ タブの見分けは `sessionStorage`(リロードでは残り、別のタブには引き継がれない)。
 *   端末全体で 1 つの控えにすると、別のタブを開いただけで同じ計測が 2 本走り、止めたときに本文へ行が 2 つ入る。
 * - ⚠ 控えが読めない・書けない端末(私用ウィンドウなど)では、これまでどおり控えなしで動く(落ちない)。
 * - ⚠ 古い控えは捨てる(`TIMER_KEEP_MS`)── 閉じたタブの分が溜まり続けない。
 * - container には入れない(ノートのデータではなく、この端末の一時の事実)。
 */
import type { TimerRun } from '@features/timer/timer-run';

const KEY = 'pkc3.timer-runs';
const TAB_KEY = 'pkc3.tab-id';

/** 控えを持つ長さ(ms)。これより古い控えは、読むときに捨てる。 */
export const TIMER_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

type Box = Pick<Storage, 'getItem' | 'setItem'>;

function readLocal(): Box | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readSession(): Box | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** タブごとの控え(`{ タブの番号: 計っている本 }`)。 */
type Saved = Record<string, readonly TimerRun[]>;

function isRun(v: unknown): v is TimerRun {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.lid === 'string' &&
    r.lid !== '' &&
    typeof r.title === 'string' &&
    typeof r.startedAtMs === 'number' &&
    Number.isFinite(r.startedAtMs)
  );
}

export class TimerRunStore {
  /** 控えが読めない端末の、この session の中の控え。 */
  private memory: Saved = {};
  private tab: string | null = null;

  constructor(
    private readonly local: Box | null = readLocal(),
    private readonly session: Box | null = readSession(),
    private readonly now: () => number = Date.now,
  ) {}

  /** このタブの番号。⚠ `sessionStorage` が使えないときは、この session だけの番号(リロードでは続きを計れない)。 */
  tabId(): string {
    if (this.tab !== null) return this.tab;
    let id: string | null = null;
    try {
      if (this.session !== null) id = this.session.getItem(TAB_KEY);
    } catch {
      /* 読めない ── 新しく作る */
    }
    if (id === null || id === '') {
      id = `t${this.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      try {
        this.session?.setItem(TAB_KEY, id);
      } catch {
        /* 書けない ── この session だけの番号 */
      }
    }
    this.tab = id;
    return id;
  }

  private readAll(): Saved {
    // 🔴 `null` は例外にならない(`?.` で読むと控えへ入らない)── 先に分ける
    if (this.local === null) return this.memory;
    let raw: string | null;
    try {
      raw = this.local.getItem(KEY);
    } catch {
      return this.memory;
    }
    if (raw === null) return {};
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
      const out: Record<string, readonly TimerRun[]> = {};
      const cutoff = this.now() - TIMER_KEEP_MS;
      for (const [tab, list] of Object.entries(v as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        const runs = list.filter(isRun).filter((r) => r.startedAtMs >= cutoff);
        if (runs.length > 0) out[tab] = runs;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** このタブの控え。 */
  read(): readonly TimerRun[] {
    return this.readAll()[this.tabId()] ?? [];
  }

  /** このタブの控えを、いまの計測で置き換える(空なら、このタブの分を消す)。 */
  write(runs: readonly TimerRun[]): void {
    const all: Record<string, readonly TimerRun[]> = { ...this.readAll() };
    const id = this.tabId();
    if (runs.length === 0) delete all[id];
    else all[id] = runs.map((r) => ({ lid: r.lid, title: r.title, startedAtMs: r.startedAtMs }));
    this.memory = all;
    try {
      this.local?.setItem(KEY, JSON.stringify(all));
    } catch {
      /* 書けない ── この session では効いている */
    }
  }
}

/** アプリ共有の 1 個。 */
export const appTimerRuns = new TimerRunStore();
