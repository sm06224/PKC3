/**
 * ノートのタブ（#1982 段 5-1）: 純粋ロジック。
 *
 * - 不変モデル。全操作は新しい `TabSet` を返す（変化がなければ同じ参照を返す）。
 * - DOM / browser API / 時計を読まない。時刻は呼び出し側が渡す単調な数 `seq` で受ける。
 * - ピン留め（#1377）は保存の正本が別にあるため、このモデルは持たない。
 *   並び（`orderTabs`）・上限の追い出し（`enforceLimit`）には引数で渡す。
 * - 設計・裁定: docs/development/note-tabs-design-2026-11.md §6.1
 */

export interface TabEntry {
  readonly lid: string;
  /** 最後に有効化された seq。追い出しの「いちばん古い」の基準。 */
  readonly activatedAt: number;
  /** 別ウィンドウで開いている（「別ウィンドウで開いています」を出す）。 */
  readonly external: boolean;
}

export interface ClosedTab {
  readonly lid: string;
  readonly closedAt: number;
}

export interface TabSet {
  readonly tabs: readonly TabEntry[];
  readonly active: string | null;
  /** 新しい順。同じ lid は 1 件だけ。 */
  readonly closed: readonly ClosedTab[];
}

export const MAX_TABS = 12;
export const MAX_CLOSED = 10;

const NO_LIDS: ReadonlySet<string> = new Set();

export function createTabSet(): TabSet {
  return { tabs: [], active: null, closed: [] };
}

/** タブ列を出すか。1 枚以下では出さない。 */
export function visible(set: TabSet): boolean {
  return set.tabs.length >= 2;
}

/** 表示順: ピン留めのノートを先頭へ。各グループ内は現在の並びのまま（安定）。 */
export function orderTabs(
  tabs: readonly TabEntry[],
  pinned: ReadonlySet<string> = NO_LIDS,
): readonly TabEntry[] {
  const head: TabEntry[] = [];
  const tail: TabEntry[] = [];
  for (const t of tabs) (pinned.has(t.lid) ? head : tail).push(t);
  return head.length === 0 ? tabs : [...head, ...tail];
}

function indexOf(set: TabSet, lid: string): number {
  return set.tabs.findIndex((t) => t.lid === lid);
}

function pushClosed(
  closed: readonly ClosedTab[],
  lids: readonly string[],
  closedAt: number,
): readonly ClosedTab[] {
  let next = closed;
  for (const lid of lids) {
    next = [{ lid, closedAt }, ...next.filter((c) => c.lid !== lid)];
  }
  return next.slice(0, MAX_CLOSED);
}

function dropClosed(closed: readonly ClosedTab[], lid: string): readonly ClosedTab[] {
  return closed.some((c) => c.lid === lid) ? closed.filter((c) => c.lid !== lid) : closed;
}

/** `lid` のタブの次の有効タブ（表示順で右隣、なければ左隣）。 */
function neighbourOf(
  tabs: readonly TabEntry[],
  lid: string,
  pinned: ReadonlySet<string>,
): string | null {
  const ordered = orderTabs(tabs, pinned);
  const i = ordered.findIndex((t) => t.lid === lid);
  if (i < 0) return null;
  return (ordered[i + 1] ?? ordered[i - 1])?.lid ?? null;
}

function withActivated(tabs: readonly TabEntry[], lid: string, seq: number): readonly TabEntry[] {
  return tabs.map((t) => (t.lid === lid ? { ...t, activatedAt: seq } : t));
}

/** 有効にする。開いていなければ何もしない。 */
export function activate(set: TabSet, lid: string, seq: number): TabSet {
  if (indexOf(set, lid) < 0) return set;
  return { ...set, tabs: withActivated(set.tabs, lid, seq), active: lid };
}

/**
 * 一覧の通常クリック: 有効なタブの中身を差し替える。
 * - 既に開いている lid なら、そのタブを有効にするだけ（重複させない）。
 * - タブが 1 つもなければ新しく作る。
 * - 差し替えで消える lid は「最近閉じたタブ」に入れない。
 */
export function openReplace(set: TabSet, lid: string, seq: number): TabSet {
  if (indexOf(set, lid) >= 0) return activate(set, lid, seq);
  const ai = set.active === null ? -1 : indexOf(set, set.active);
  if (ai < 0) return openNew(set, lid, seq, { activate: true });
  const tabs = set.tabs.map((t, i) =>
    i === ai ? { lid, activatedAt: seq, external: false } : t,
  );
  return { tabs, active: lid, closed: dropClosed(set.closed, lid) };
}

/** 新しいタブで開く。既に開いていれば（有効化指定のときだけ）有効にする。 */
export function openNew(
  set: TabSet,
  lid: string,
  seq: number,
  opts: { activate?: boolean } = {},
): TabSet {
  const doActivate = opts.activate ?? true;
  if (indexOf(set, lid) >= 0) return doActivate ? activate(set, lid, seq) : set;
  const entry: TabEntry = { lid, activatedAt: seq, external: false };
  return {
    tabs: [...set.tabs, entry],
    active: doActivate || set.active === null ? lid : set.active,
    closed: dropClosed(set.closed, lid),
  };
}

/** 閉じる。閉じたタブは「最近閉じたタブ」へ。有効なタブなら右隣（なければ左隣）が有効になる。 */
export function close(
  set: TabSet,
  lid: string,
  seq: number,
  pinned: ReadonlySet<string> = NO_LIDS,
): TabSet {
  if (indexOf(set, lid) < 0) return set;
  const active = set.active === lid ? neighbourOf(set.tabs, lid, pinned) : set.active;
  return {
    tabs: set.tabs.filter((t) => t.lid !== lid),
    active,
    closed: pushClosed(set.closed, [lid], seq),
  };
}

export interface ReopenResult {
  readonly set: TabSet;
  readonly lid: string;
}

/**
 * 最後に閉じたタブを戻す（新しいタブとして有効にする）。
 * もう存在しないノート（`exists` が false）は読み飛ばして捨てる。戻せるものがなければ null。
 */
export function reopenLast(
  set: TabSet,
  seq: number,
  exists: (lid: string) => boolean,
): ReopenResult | null {
  const idx = set.closed.findIndex((c) => exists(c.lid));
  if (idx < 0) return null;
  const lid = set.closed[idx]!.lid;
  const rest = { ...set, closed: set.closed.slice(idx + 1) };
  return { set: openNew(rest, lid, seq, { activate: true }), lid };
}

function step(set: TabSet, seq: number, pinned: ReadonlySet<string>, dir: 1 | -1): TabSet {
  if (set.tabs.length < 2) return set;
  const ordered = orderTabs(set.tabs, pinned);
  const cur = ordered.findIndex((t) => t.lid === set.active);
  const n = ordered.length;
  const to = cur < 0 ? (dir === 1 ? 0 : n - 1) : (cur + dir + n) % n;
  return activate(set, ordered[to]!.lid, seq);
}

/** 次のタブ（表示順。末尾の次は先頭）。 */
export function next(set: TabSet, seq: number, pinned: ReadonlySet<string> = NO_LIDS): TabSet {
  return step(set, seq, pinned, 1);
}

/** 前のタブ（表示順。先頭の前は末尾）。 */
export function prev(set: TabSet, seq: number, pinned: ReadonlySet<string> = NO_LIDS): TabSet {
  return step(set, seq, pinned, -1);
}

/** 並べ替え（保持している並びの添字で指定）。範囲外・同位置は何もしない。 */
export function move(set: TabSet, from: number, to: number): TabSet {
  const n = set.tabs.length;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return set;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return set;
  const tabs = [...set.tabs];
  const t = tabs.splice(from, 1)[0];
  if (!t) return set;
  tabs.splice(to, 0, t);
  return { ...set, tabs };
}

export interface LimitOptions {
  readonly max?: number;
  readonly isPinned: (lid: string) => boolean;
  readonly isEditing: (lid: string) => boolean;
}

export interface LimitResult {
  readonly set: TabSet;
  /** 追い出した lid（古い順）。 */
  readonly evicted: readonly string[];
  /** 守るタブだけで上限を超えている（超えたまま許す）。 */
  readonly overflow: boolean;
}

/**
 * 上限（既定 12）を超えたら、ピン留め・編集中・有効なタブを除く最も古い（`activatedAt` 最小、
 * 同値は並びの前）タブを閉じて「最近閉じたタブ」へ入れる。守るものだけで超える場合は超過を許す。
 */
export function enforceLimit(set: TabSet, seq: number, opts: LimitOptions): LimitResult {
  const max = opts.max ?? MAX_TABS;
  let tabs = set.tabs;
  const evicted: string[] = [];
  while (tabs.length > max) {
    let victim: TabEntry | null = null;
    for (const t of tabs) {
      if (t.lid === set.active || opts.isPinned(t.lid) || opts.isEditing(t.lid)) continue;
      if (victim === null || t.activatedAt < victim.activatedAt) victim = t;
    }
    if (victim === null) break;
    const v = victim.lid;
    tabs = tabs.filter((t) => t.lid !== v);
    evicted.push(v);
  }
  const overflow = tabs.length > max;
  if (evicted.length === 0) return { set, evicted, overflow };
  return {
    set: { ...set, tabs, closed: pushClosed(set.closed, evicted, seq) },
    evicted,
    overflow,
  };
}

/** 削除・ゴミ箱へ移ったノートのタブを除く。「最近閉じたタブ」には入れず、既にある分も消す。 */
export function onDeleted(
  set: TabSet,
  lids: Iterable<string>,
  pinned: ReadonlySet<string> = NO_LIDS,
): TabSet {
  const gone = new Set(lids);
  if (gone.size === 0) return set;
  const closed = set.closed.filter((c) => !gone.has(c.lid));
  if (!set.tabs.some((t) => gone.has(t.lid))) {
    return closed.length === set.closed.length ? set : { ...set, closed };
  }
  let active = set.active;
  if (active !== null && gone.has(active)) {
    // 表示順で、削除されないタブのうち右隣、なければ左隣。
    const ordered = orderTabs(set.tabs, pinned);
    const i = ordered.findIndex((t) => t.lid === active);
    const right = ordered.slice(i + 1).find((t) => !gone.has(t.lid));
    const left = ordered
      .slice(0, i)
      .reverse()
      .find((t) => !gone.has(t.lid));
    active = (right ?? left)?.lid ?? null;
  }
  return { tabs: set.tabs.filter((t) => !gone.has(t.lid)), active, closed };
}

/** 別ウィンドウで開いている状態の印を付ける・外す。 */
export function markExternal(set: TabSet, lid: string, external: boolean): TabSet {
  const i = indexOf(set, lid);
  if (i < 0 || set.tabs[i]?.external === external) return set;
  return { ...set, tabs: set.tabs.map((t, j) => (j === i ? { ...t, external } : t)) };
}
