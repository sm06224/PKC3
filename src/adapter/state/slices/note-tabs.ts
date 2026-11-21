/**
 * reducer の slice: ノートのタブ(#1982 段 5-2)。state と reducer の配線だけ ── 描画・キーは 5-3 / 5-4。
 *
 * 🔑 **整合は `syncNoteTabs` の 1 か所で取る**(`reduce` の外側。履歴・バックリンクと同じ作法)。
 *   `selectedLid` を動かす case は 6 つ以上あり(`SELECT_ENTRY` / `MESSAGES_READ` / `SYS_BOOTED` / `CREATE_ENTRY` /
 *   `ENTRY_RESTORED` / 削除の後継 / `NAV_HISTORY` …)、case ごとに書くと次に足した人が必ず忘れる。
 *   だから「動いた結果」を見る ── 新しい case は自動で乗る。
 * 🔑 タブの操作自身(`NOTE_TAB_*`)は `reduceCore` から来る。選択は**通常の選択**(`SELECT_ENTRY`)へ委ね、
 *   副作用(本文の読み出し・履歴・バックリンク)を二重に持たない。断られたら(編集中など)操作ごと何もしない。
 * ⚠ **保存しない**(裁定 4: 再読み込みで復元しない)。`AppState.noteTabs` / `tabSeq` / `notePins` はメモリだけ。
 * ⚠ システムのメッセージ(`entryMetas` に居ない)を開いている間はタブを動かさない
 *   (`noteTabs.active` はその前に開いていたノートのまま。メッセージ → 一覧の通常クリックは、そのタブの差し替えになる)。
 * ⚠ 削除で有効なタブが消えたら、**選択はタブの隣へ従う**(右隣、なければ左隣。`note-tabs.ts` の `neighbourOf`)。
 *   一覧の後継(消した行の次)ではない ── 後継を採るとタブの隣を差し替えて消してしまう。
 * ⚠ ゴミ箱から戻すと、戻したノートが選ばれる(既存の挙動)ので、選択に従ってタブも 1 枚できる。自動で開き直す仕組みは足さない。
 */

import { type AppState, type Dispatchable, type DomainEvent, type ReduceResult, reduceCore } from '../app-state';
import {
  type TabSet,
  activate,
  close,
  createTabSet,
  enforceLimit,
  markExternal,
  move,
  next,
  onDeleted,
  openNew,
  openReplace,
  prev,
  reopenLast,
} from '@features/nav/note-tabs';

export type NoteTabsAction = Extract<Dispatchable, { type: 'NOTE_TAB_OPEN' | 'NOTE_TAB_ACTIVATE' | 'NOTE_TAB_CLOSE' | 'NOTE_TAB_REOPEN' | 'NOTE_TAB_NEXT' | 'NOTE_TAB_PREV' | 'NOTE_TAB_MOVE' | 'NOTE_TAB_EXTERNAL' | 'SET_NOTE_PINS' }>;

/** 通常の reducer。循環 import を避けて引数で受ける。 */
export type RunAction = (state: AppState, action: Exclude<Dispatchable, { type: 'NAV_HISTORY' }>) => ReduceResult;

/** ピン留めが 1 つも無い状態(参照を共有する)。 */
export const NO_NOTE_PINS: ReadonlySet<string> = new Set<string>();

const noop = (state: AppState): ReduceResult => ({ state, events: [] });

/** 編集中のノート。編集中は選択が動かないので、編集中のノート = 開いているノート。 */
function editingLid(st: Pick<AppState, 'phase' | 'selectedLid'>): string | null {
  return st.phase === 'editing' ? st.selectedLid : null;
}

/**
 * タブを確定する。⚠ タブを足したあとは**必ず**上限を通す(溢れたら、ピン留め・編集中・有効なタブ以外の
 * いちばん古いものを閉じて「最近閉じたタブ」へ)。`tabSeq` も進める。
 */
function commitTabs(st: AppState, set: TabSet, seq: number): AppState {
  const editing = editingLid(st);
  const limited = enforceLimit(set, seq, {
    isPinned: (lid) => st.notePins.has(lid),
    isEditing: (lid) => lid === editing,
  });
  return { ...st, noteTabs: limited.set, tabSeq: seq };
}

/** 選択を `lid` にして(通常の選択に委ねる)から、タブを確定する。断られたら null。 */
function selectThenCommit(
  state: AppState,
  run: RunAction,
  lid: string,
  set: TabSet,
  seq: number,
): ReduceResult | null {
  let r: ReduceResult = noop(state);
  if (state.selectedLid !== lid) {
    r = run(state, { type: 'SELECT_ENTRY', lid });
    if (r.state.selectedLid !== lid) return null;
  }
  return { state: commitTabs(r.state, set, seq), events: r.events };
}

export function reduceNoteTabs(state: AppState, action: NoteTabsAction): ReduceResult {
  const run: RunAction = reduceCore;
  const seq = state.tabSeq + 1;
  const tabs = state.noteTabs;
  const exists = (lid: string): boolean => state.entryMetas.has(lid);
  switch (action.type) {
    case 'SET_NOTE_PINS': {
      const a = state.notePins;
      if (a.size === action.lids.length && action.lids.every((l) => a.has(l))) return noop(state);
      return { state: { ...state, notePins: new Set(action.lids) }, events: [] };
    }
    case 'NOTE_TAB_OPEN': {
      if (!exists(action.lid)) return noop(state);
      const doActivate = action.activate ?? true;
      const set = openNew(tabs, action.lid, seq, { activate: doActivate });
      if (!doActivate) return set === tabs ? noop(state) : { state: commitTabs(state, set, seq), events: [] };
      return selectThenCommit(state, run, action.lid, set, seq) ?? noop(state);
    }
    case 'NOTE_TAB_ACTIVATE': {
      if (!tabs.tabs.some((t) => t.lid === action.lid)) return noop(state);
      if (tabs.active === action.lid && state.selectedLid === action.lid) return noop(state);
      return selectThenCommit(state, run, action.lid, activate(tabs, action.lid, seq), seq) ?? noop(state);
    }
    case 'NOTE_TAB_CLOSE': {
      if (!tabs.tabs.some((t) => t.lid === action.lid)) return noop(state);
      const set = close(tabs, action.lid, seq, state.notePins);
      if (tabs.active !== action.lid) return { state: commitTabs(state, set, seq), events: [] };
      // 有効なタブを閉じた ── 選択も隣へ。最後の 1 枚なら選択を外す(タブ 0 枚 = active null と揃える)
      if (set.active !== null) return selectThenCommit(state, run, set.active, set, seq) ?? noop(state);
      if (state.selectedLid === null) return { state: commitTabs(state, set, seq), events: [] };
      const r = run(state, { type: 'DESELECT_ENTRY' });
      if (r.state.selectedLid !== null) return noop(state);
      return { state: commitTabs(r.state, set, seq), events: r.events };
    }
    case 'NOTE_TAB_REOPEN': {
      const re = reopenLast(tabs, seq, exists);
      if (re === null) return noop(state);
      return selectThenCommit(state, run, re.lid, re.set, seq) ?? noop(state);
    }
    case 'NOTE_TAB_NEXT':
    case 'NOTE_TAB_PREV': {
      const set = (action.type === 'NOTE_TAB_NEXT' ? next : prev)(tabs, seq, state.notePins);
      if (set === tabs || set.active === null) return noop(state);
      return selectThenCommit(state, run, set.active, set, seq) ?? noop(state);
    }
    case 'NOTE_TAB_MOVE': {
      const set = move(tabs, action.lid, action.before);
      return set === tabs ? noop(state) : { state: { ...state, noteTabs: set }, events: [] };
    }
    case 'NOTE_TAB_EXTERNAL': {
      const set = markExternal(tabs, action.lid, action.external);
      return set === tabs ? noop(state) : { state: { ...state, noteTabs: set }, events: [] };
    }
  }
}

/**
 * 🔴 **`selectedLid` / `entryMetas` を動かした結果を見て、タブを揃える**(`reduce` の外側 1 か所)。
 *
 * 1. 別のコレクションに替わった(`cid` が変わった)→ 作り直し(新しい選択があればそれ 1 枚)。
 * 2. 消えたノートのタブを `onDeleted`(削除・ゴミ箱・消去・他のタブでの削除・取込。復元は何もしない)。
 *    開いていたタブが消えて隣が有効になったら、選択も隣へ従う。
 * 3. 選択が動いた(通常クリック・リンク・検索・戻る・作成・復元)→ `openReplace`
 *    (有効なタブが**ピン留め**か**編集中**なら差し替えず新しいタブ)。選択解除(null)ではタブを動かさない。
 * 4. タブを動かしたら必ず `enforceLimit` を通す(`commitTabs`)。
 */
export function syncNoteTabs(prevState: AppState, result: ReduceResult, select: RunAction): ReduceResult {
  if (result.state === prevState) return result;
  let st = result.state;
  const orig = st.noteTabs;
  let events: DomainEvent[] = result.events;
  const seq = st.tabSeq + 1;
  const selectable = (l: string | null): l is string => l !== null && st.entryMetas.has(l);

  if (st.cid !== prevState.cid) {
    const fresh = selectable(st.selectedLid) ? openNew(createTabSet(), st.selectedLid, seq) : createTabSet();
    return { state: commitTabs(st, fresh, seq), events };
  }

  let set = orig;
  if (st.entryMetas !== prevState.entryMetas && set.tabs.length > 0) {
    const gone = set.tabs.filter((t) => !st.entryMetas.has(t.lid)).map((t) => t.lid);
    set = onDeleted(set, gone, st.notePins);
  }
  // 開いていたタブが消えて隣が有効になった
  const activeMoved = set !== orig && set.active !== orig.active && set.active !== null;
  let followed = false;
  if (activeMoved && prevState.selectedLid === orig.active && st.selectedLid !== set.active) {
    const r = select({ ...st, noteTabs: set }, { type: 'SELECT_ENTRY', lid: set.active! });
    if (r.state.selectedLid === set.active) {
      // 一覧の後継の本文・参照元の読み出しは捨てる(隣の分が積まれている)
      const dropped = st.selectedLid;
      events = [
        ...result.events.filter(
          (e) => !((e.type === 'REQUEST_BODY' || e.type === 'REQUEST_BACKLINKS') && e.lid === dropped),
        ),
        ...r.events,
      ];
      st = r.state;
      followed = true;
    }
  }
  const sel = st.selectedLid;
  if (!followed && selectable(sel) && sel !== prevState.selectedLid) {
    set = activeMoved
      ? // 隣へ従えなかった(断られた)回は、隣のタブを潰さず新しいタブで開く
        openNew(set, sel, seq, { activate: true })
      : openReplace(set, sel, seq, (l) => st.notePins.has(l) || l === editingLid(prevState));
  }
  if (set === orig && st === result.state) return result;
  return { state: commitTabs(st, set, seq), events };
}
