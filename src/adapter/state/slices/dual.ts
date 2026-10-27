/**
 * reducer の slice: 2 ペイン(ファイラー)の操作(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceDual` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import { type AppState, type Dispatchable, type ReduceResult, withDual, withDualFocus } from '../app-state';
import { dualListViewOptions } from '../list-view-options';
import {
  type DualPaneState,
  canGoBack as paneCanGoBack,
  canGoForward as paneCanGoForward,
  paneFilterOptions,
  paneOf,
  paneScope,
  withCursor,
  withPane,
  withBack as withPaneBack,
  withFilter as withPaneFilter,
  withForward as withPaneForward,
  withScope as withPaneScope,
  withSelection as withPaneSelection,
  withTabAdded,
  withTabClosed,
} from '@features/relation/dual-pane';
import { filerRows, rangeInRows, smartLidsOf } from '@features/relation/filer-list';

export type DualAction = Extract<Dispatchable, { type: 'DUAL_FOCUS' | 'DUAL_SET_SCOPE' | 'DUAL_SELECT' | 'DUAL_SELECT_MANY' | 'DUAL_SET_CURSOR' | 'DUAL_TAB_ADD' | 'DUAL_TAB_CLOSE' | 'DUAL_CLEAR_SELECTION' | 'DUAL_RENAME_BEGIN' | 'DUAL_RENAME_END' | 'ROW_RENAME_BEGIN' | 'ROW_RENAME_END' | 'DUAL_SET_FILTER' | 'DUAL_BACK' | 'DUAL_FORWARD' | 'DUAL_SET_PREVIEW' }>;

export function reduceDual(state: AppState, action: DualAction): ReduceResult {
  switch (action.type) {
    case 'DUAL_FOCUS':
      return withDualFocus(state, action.side);
    case 'DUAL_SET_SCOPE': {
      // ⚠ 実在しない lid へは入らない(消えたフォルダの中身として空の表を出さない)
      if (action.lid !== null && !state.entryMetas.has(action.lid))
        return { state, events: [] };
      const pane = withPaneScope(paneOf(state.dual, action.side), action.lid);
      if (pane === paneOf(state.dual, action.side)) return withDualFocus(state, action.side);
      // 🔑 場所を触った側へ焦点も移す(移す向きは「焦点のある側から」なので、
      //    触った側が元にならないと user の意図と逆へ流れる)
      return withDual(state, {
        ...withPane(state.dual, action.side, pane),
        focus: action.side,
      });
    }
    case 'DUAL_SELECT': {
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      const pane = paneOf(state.dual, action.side);
      /**
       * 🔑 **範囲は「表示している並び」で採る**(#240 段②と同じ規則・同じ関数)。
       * ⚠ ここで並びを組み直すと、目で見た範囲と選ばれる範囲が食い違う。
       */
      const rows = filerRows(paneScope(pane), state.entryMetas, state.relations, {
        smartLids: smartLidsOf(paneScope(pane), state.smartHits),
        // 🔑 **絞り込みの規則は 1 本**(`paneFilterOptions`)── 描く側と同じものを見る
        ...paneFilterOptions(pane, state.filterQuery, state.searchHits),
        ...dualListViewOptions(state),
        // ⚠ 2 ペインは「中まで全部出す」(左の列の入り切り)を**持たない**(#813 段②)
        flatten: false,
      });
      let next: DualPaneState;
      if (action.mode === 'range') {
        const range = rangeInRows(rows, pane.anchor, action.lid);
        if (range.length === 0) return { state, events: [] };
        // ⚠ 起点は動かさない(動かすと Shift を押すたびに範囲が縮む)
        // ⚠ カーソルは**押した行**へ(範囲の端であって、起点ではない)
        next = withPaneSelection(pane, range, pane.anchor, action.lid);
      } else if (action.mode === 'toggle') {
        const has = pane.selection.includes(action.lid);
        const sel = has
          ? pane.selection.filter((l) => l !== action.lid)
          : [...pane.selection, action.lid];
        // ⚠ 起点は**外したときも**更新する(次の Shift はここから伸ばす)
        next = withPaneSelection(pane, sel, action.lid, action.lid);
      } else {
        next = withPaneSelection(pane, [action.lid], action.lid, action.lid);
      }
      return withDual(state, {
        ...withPane(state.dual, action.side, next),
        focus: action.side,
      });
    }
    case 'DUAL_SELECT_MANY': {
      const lids = action.lids.filter((l) => state.entryMetas.has(l));
      if (lids.length === 0) return { state, events: [] };
      const last = lids[lids.length - 1]!;
      const pane = paneOf(state.dual, action.side);
      // ⚠ 焦点は動かさない(`DUAL_SELECT` は押した側を焦点にするが、これは操作の結果として置くだけ)
      return withDual(state, withPane(state.dual, action.side, withPaneSelection(pane, lids, last, last)));
    }
    case 'DUAL_SET_CURSOR': {
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      const pane = paneOf(state.dual, action.side);
      if (pane.cursor === action.lid && state.dual.focus === action.side)
        return withDual(state, state.dual);
      return withDual(state, {
        ...withPane(state.dual, action.side, withCursor(pane, action.lid)),
        // ⚠ 動かした側が「元」になる(押した側が焦点、と同じ規則)
        focus: action.side,
      });
    }
    case 'DUAL_TAB_ADD': {
      const pane = withTabAdded(paneOf(state.dual, action.side));
      if (pane === paneOf(state.dual, action.side)) return { state, events: [] };
      return withDual(state, {
        ...withPane(state.dual, action.side, pane),
        focus: action.side,
      });
    }
    case 'DUAL_TAB_CLOSE': {
      const pane = withTabClosed(paneOf(state.dual, action.side), action.index);
      if (pane === paneOf(state.dual, action.side)) return { state, events: [] };
      return withDual(state, {
        ...withPane(state.dual, action.side, pane),
        focus: action.side,
      });
    }
    case 'DUAL_CLEAR_SELECTION': {
      const pane = paneOf(state.dual, action.side);
      if (pane.selection.length === 0 && pane.anchor === null) return { state, events: [] };
      return withDual(
        state,
        /**
         * ⚠ **カーソルは残す**(2026-08-19)── ここは「移した直後に印を外す」
         *   ための入口なので、カーソルまで消すと**次の 1 打鍵が先頭へ飛ぶ**。
         */
        withPane(state.dual, action.side, withPaneSelection(pane, [], null, pane.cursor)),
      );
    }
    case 'DUAL_RENAME_BEGIN': {
      // ⚠ 実在しない行の名前は打てない(消えた行の入力欄を出さない)
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      // ⚠ 打ち始めた側へ焦点も移す(他の押し方と揃える)
      return {
        state: {
          ...state,
          dual: { ...state.dual, focus: action.side, renaming: { side: action.side, lid: action.lid } },
        },
        events: [],
      };
    }
    case 'DUAL_RENAME_END': {
      if (state.dual.renaming === null) return { state, events: [] };
      return { state: { ...state, dual: { ...state.dual, renaming: null } }, events: [] };
    }
    case 'ROW_RENAME_BEGIN': {
      // ⚠ 編集中は打たせない(`RENAME_ENTRY_TITLE` 自体は editing でも通るが、
      //    その入力欄は 2 ペインの編集画面の題名欄であって、左の列の行ではない)
      if (state.phase !== 'ready') return { state, events: [] };
      // ⚠ 実在しない行の名前は打てない(消えた行の入力欄を出さない)
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      if (state.renamingLid === action.lid) return { state, events: [] };
      return { state: { ...state, renamingLid: action.lid }, events: [] };
    }
    case 'ROW_RENAME_END': {
      if (state.renamingLid === null) return { state, events: [] };
      return { state: { ...state, renamingLid: null }, events: [] };
    }
    case 'DUAL_SET_FILTER': {
      const pane = withPaneFilter(paneOf(state.dual, action.side), action.filter);
      if (pane === paneOf(state.dual, action.side)) return { state, events: [] };
      // 🔑 打った側へ焦点も移す(他の押し方と揃える)
      return withDual(state, {
        ...withPane(state.dual, action.side, pane),
        focus: action.side,
      });
    }
    case 'DUAL_BACK':
    case 'DUAL_FORWARD': {
      const cur = paneOf(state.dual, action.side);
      /**
       * ⚠ **押せないときは何もしない**(焦点も動かさない)── 端で押したときに
       *   焦点だけ動くと、「戻ったのに場所が同じ」に見える。
       */
      const can = action.type === 'DUAL_BACK' ? paneCanGoBack(cur) : paneCanGoForward(cur);
      if (!can) return { state, events: [] };
      const pane = action.type === 'DUAL_BACK' ? withPaneBack(cur) : withPaneForward(cur);
      return withDual(state, {
        ...withPane(state.dual, action.side, pane),
        focus: action.side,
      });
    }
    case 'DUAL_SET_PREVIEW': {
      if (state.dual.previewOn === action.on) return { state, events: [] };
      /**
       * ⚠ **切ったら中身も捨てる** ── 残すと、次に点けた瞬間に
       *   **前に見ていた行の本文**が一瞬出る(いま指している行のものではない)。
       */
      return withDual(state, { ...state.dual, previewOn: action.on, preview: null });
    }
  }
}
