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
/** タブごとの「最後に動いていた時刻」と「閉じた時刻」(台帳 #1852 / 依頼 75-1)。 */
const BEAT_KEY = 'pkc3.timer-beats';

/** 控えを持つ長さ(ms)。これより古い控えは、読むときに捨てる。 */
export const TIMER_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** 動いている印を書き直す間隔(ms)。⚠ 背面のタブは刻みが 1 分に 1 回まで間引かれるので、見捨てる側はこれより十分長く待つ。 */
export const TIMER_BEAT_MS = 10_000;
/** 印が止まって何分で「閉じられた」と読むか(ms)。閉じたと分かる印(`leave`)があれば、`TIMER_LEFT_GRACE_MS` で足りる。 */
export const TIMER_STALE_MS = 5 * 60 * 1000;
/** 閉じた印から、読み直し中ではないと読むまでの猶予(ms)。 */
export const TIMER_LEFT_GRACE_MS = 15_000;

/** 閉じられたタブが残した、計っている途中の記録。 */
export interface OrphanRuns {
  readonly tab: string;
  readonly runs: readonly TimerRun[];
  /** 最後に動いていた時刻(閉じたと分かる印があればその時刻)。止めたことにする時刻。 */
  readonly endedAtMs: number;
}

interface Beat {
  beat: number;
  left?: number;
}

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
  private memoryBeats: Record<string, Beat> = {};
  private lastBeatAt = 0;
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
    // 動いている印も一緒に書く(印が無い控えは、閉じられたのか分からないので誰も拾わない)
    if (runs.length > 0) this.beat(true);
    else this.dropBeat(id);
  }

  private readBeats(): Record<string, Beat> {
    if (this.local === null) return this.memoryBeats;
    try {
      const raw = this.local.getItem(BEAT_KEY);
      if (raw === null) return {};
      const v: unknown = JSON.parse(raw);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
      const out: Record<string, Beat> = {};
      for (const [tab, b] of Object.entries(v as Record<string, unknown>)) {
        const r = b as Record<string, unknown> | null;
        if (r === null || typeof r !== 'object' || typeof r.beat !== 'number' || !Number.isFinite(r.beat)) continue;
        out[tab] = typeof r.left === 'number' && Number.isFinite(r.left) ? { beat: r.beat, left: r.left } : { beat: r.beat };
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeBeats(b: Record<string, Beat>): void {
    this.memoryBeats = b;
    try {
      this.local?.setItem(BEAT_KEY, JSON.stringify(b));
    } catch {
      /* 書けない ── この session では効いている */
    }
  }

  private dropBeat(tab: string): void {
    const b = { ...this.readBeats() };
    if (!(tab in b)) return;
    delete b[tab];
    this.writeBeats(b);
  }

  /**
   * 🔴 **このタブがまだ動いている印**(依頼 75-1)。計っている間、刻みのたびに呼ぶ(`TIMER_BEAT_MS` 未満の間は書かない)。
   * ⚠ 印が止まって久しい(または閉じた印がある)他のタブの計測だけが、`orphans` で「閉じられた」と読まれる。
   */
  beat(force = false): void {
    const at = this.now();
    if (!force && at - this.lastBeatAt < TIMER_BEAT_MS) return;
    this.lastBeatAt = at;
    this.writeBeats({ ...this.readBeats(), [this.tabId()]: { beat: at } });
  }

  /** 🔴 **このタブを閉じる(または読み直す)印**。⚠ 読み直しなら、開き直した同じタブが `beat` で打ち消す。 */
  leave(): void {
    if (this.read().length === 0) return;
    const id = this.tabId();
    const b = this.readBeats();
    this.writeBeats({ ...b, [id]: { beat: b[id]?.beat ?? this.now(), left: this.now() } });
  }

  /**
   * 🔴 **閉じられたタブが残した、計っている途中の記録**(依頼 75-1。Gemini 回答 = 推薦 B)。
   * 閉じた印から `TIMER_LEFT_GRACE_MS` たった / 動いている印が `TIMER_STALE_MS` 止まっている他のタブの分。
   * ⚠ 印が無い控え(この機能より前の控え)と、いま動いている他のタブの分は返さない(二重に数えない)。
   */
  orphans(): OrphanRuns[] {
    const at = this.now();
    const beats = this.readBeats();
    const me = this.tabId();
    const out: OrphanRuns[] = [];
    for (const [tab, runs] of Object.entries(this.readAll())) {
      if (tab === me) continue;
      const b = beats[tab];
      if (b === undefined) continue;
      const left = b.left !== undefined && at - b.left >= TIMER_LEFT_GRACE_MS;
      const stale = at - b.beat >= TIMER_STALE_MS;
      if (!left && !stale) continue;
      out.push({ tab, runs, endedAtMs: left ? b.left! : b.beat });
    }
    return out;
  }

  /** 拾った(または捨てると決めた)他のタブの記録を消す。 */
  forget(tab: string): void {
    if (tab === this.tabId()) return;
    const all: Record<string, readonly TimerRun[]> = { ...this.readAll() };
    delete all[tab];
    this.memory = all;
    try {
      this.local?.setItem(KEY, JSON.stringify(all));
    } catch {
      /* 書けない ── この session では効いている */
    }
    this.dropBeat(tab);
  }
}

/** アプリ共有の 1 個。 */
export const appTimerRuns = new TimerRunStore();
