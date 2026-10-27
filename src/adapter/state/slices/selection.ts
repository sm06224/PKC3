/**
 * reducer の slice: ファイラーの複数選択と範囲(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceSelection` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import { type AppState, type Dispatchable, type ReduceResult, smartScanFor } from '../app-state';
import { filerRowOptions } from '../list-view-options';
import { filerRows, rangeInRows } from '@features/relation/filer-list';

export type SelectionAction = Extract<Dispatchable, { type: 'TOGGLE_SELECT' | 'SELECT_RANGE' | 'SELECT_ALL' | 'SELECT_ONLY' | 'CLEAR_SELECTION' | 'SET_SCOPE' | 'SET_FILER_FLATTEN' | 'DESELECT_ENTRY' }>;

export function reduceSelection(state: AppState, action: SelectionAction): ReduceResult {
  switch (action.type) {
    case 'TOGGLE_SELECT': {
      if (state.phase !== 'ready') return { state, events: [] };
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      const has = state.selection.includes(action.lid);
      const selection = has
        ? state.selection.filter((l) => l !== action.lid)
        : [...state.selection, action.lid];
      /**
       * ⚠ **開いているノートは動かさない**(#240 段②)── `Ctrl` クリックのたびに
       * 中央が開き直ると、`REQUEST_BODY` が n 回飛ぶうえ「印を付けただけ」で
       * 本文が入れ替わる。
       * ⚠ 起点は**外したときも**更新する(次の `Shift` はここから伸ばす)。
       */
      return {
        state: { ...state, selection, selectionAnchor: action.lid },
        events: [],
      };
    }
    case 'SELECT_RANGE': {
      if (state.phase !== 'ready') return { state, events: [] };
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      /**
       * 🔴 **表示順で採る**(#240 段②)。⚠ データの順(`order`)で採ると、
       * 並べ替えや絞り込みを掛けているとき**目で見た範囲と違うものが選ばれる**。
       * 規則は `filerRows` 1 か所(描く側と同じ関数)。
       */
      const rows = filerRows(state.scopeLid, state.entryMetas, state.relations, filerRowOptions(state));
      const range = rangeInRows(rows, state.selectionAnchor, action.lid);
      if (range.length === 0) return { state, events: [] };
      // ⚠ 起点は動かさない ── 動かすと `Shift` を押すたびに範囲が縮んでいく
      return { state: { ...state, selection: range }, events: [] };
    }
    case 'SELECT_ALL': {
      if (state.phase !== 'ready') return { state, events: [] };
      // ⚠ 規則は `filerRows` 1 か所(描く側・範囲選択と同じ答えになる)
      const rows = filerRows(
        state.scopeLid,
        state.entryMetas,
        state.relations,
        filerRowOptions(state),
      ).map((m) => m.lid);
      if (rows.length === 0) return { state, events: [] };
      return {
        state: { ...state, selection: rows, selectionAnchor: rows[rows.length - 1] ?? null },
        events: [],
      };
    }
    case 'SELECT_ONLY': {
      /**
       * 🔑 **一覧で ↑↓ を押したときの「印を空にしてから 1 件付ける」を 1 回で**(#1087)。
       * ⚠ 直す前は `CLEAR_SELECTION` と `TOGGLE_SELECT` の 2 回撃っていたので、1 キーで画面を
       *   2 回描き直し、そのたびにスクロール位置の書き込みが配置の計算を強いていた(実測)。
       * ⚠ 門は `TOGGLE_SELECT` と同じ(編集中・無いノートは何もしない)。
       */
      if (state.phase !== 'ready') return { state, events: [] };
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      if (state.selection.length === 1 && state.selection[0] === action.lid && state.selectionAnchor === action.lid)
        return { state, events: [] };
      return { state: { ...state, selection: [action.lid], selectionAnchor: action.lid }, events: [] };
    }
    case 'CLEAR_SELECTION': {
      if (state.selection.length === 0 && state.selectionAnchor === null)
        return { state, events: [] };
      return { state: { ...state, selection: [], selectionAnchor: null }, events: [] };
    }
    case 'SET_SCOPE': {
      if (state.phase !== 'ready') return { state, events: [] };
      if (state.scopeLid === action.lid) return { state, events: [] };
      /**
       * ⚠ **実在しない lid へは入らない**(消えたフォルダを指したまま「空です」と
       * 出るのを防ぐ)。⚠ ただし `null`(ルート)は常に受ける。
       */
      if (action.lid !== null && !state.entryMetas.has(action.lid))
        return { state, events: [] };
      /**
       * 🔴 **印は現在地のもの**(着地前レビュー 2)。場所を移ったら外す ──
       * 残すと「画面に印が 1 つも無いのに帯だけが N 件と言う」状態になり、
       * 押すと**画面に無いものがゴミ箱へ入る**。
       * ⚠ 起点(`selectionAnchor`)も一緒に外す ── 別の場所の行を起点に
       * `Shift` の範囲を採ると、見た範囲と違う集合が選ばれる。
       */
      return {
        state: { ...state, scopeLid: action.lid, selection: [], selectionAnchor: null },
        // 🔑 入った先がスマートフォルダなら集め直す(判定は `smartScanFor` 1 か所)
        events: smartScanFor(state, action.lid),
      };
    }
    case 'SET_FILER_FLATTEN': {
      if (state.filerFlatten === action.on) return { state, events: [] };
      /**
       * 🔴 **印は「いま出ている行」のもの**(`SET_SCOPE` と同じ理由)。出る行の集合が
       * 変わるので外す ── 残すと、画面に無い行の印を帯が数えて「画面に無いものが
       * ゴミ箱へ入る」。起点も一緒に外す(別の並びの行を起点に `Shift` で範囲を採らない)。
       * ⚠ **開いているノート(`selectedLid`)は動かさない** ── 見え方を変えただけで
       *   中央の本文が閉じない。
       */
      return {
        state: { ...state, filerFlatten: action.on, selection: [], selectionAnchor: null },
        events: [],
      };
    }
    case 'DESELECT_ENTRY': {
      // filer の「ルート」導線(scope は selection の純関数なので、root 表示 =
      // 選択解除)。openBody は速やかに破棄
      if (state.phase !== 'ready') return { state, events: [] };
      if (state.selectedLid === null) return { state, events: [] };
      // 🔴 **`error` はここで消さない**(設計 doc §7、段②a)。
      return {
        state: { ...state, selectedLid: null, openBody: null },
        events: [],
      };
    }
  }
}
