/**
 * reducer の slice: 検索ヒット間の移動(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceSearchJump` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  type ReduceResult,
  SEARCH_JUMP_EDITING_NOTICE,
} from '../app-state';
import { normalizeFindQuery } from '@features/filter/search-hits';

export type SearchJumpAction = Extract<Dispatchable, { type: 'SEARCH_JUMP_START' | 'SEARCH_JUMP_STEP' | 'SEARCH_JUMP_END' }>;

export function reduceSearchJump(state: AppState, action: SearchJumpAction): ReduceResult {
  switch (action.type) {
    case 'SEARCH_JUMP_START': {
      const query = normalizeFindQuery(action.query);
      // ⚠ 断るときは何も動かさない(`app-state.ts` の `UserAction` の注記)。`sectionDraft` は手組み fixture で
      //   `undefined` のことがあるので `!= null`
      /**
       * 🔴 **編集中に送られたときは、黙って捨てずに 1 行言う**(#1206 D9)。⚠ 直す前は窓が前に出る
       *   だけで**塗られもせず、理由も出なかった**(壊れたと読む)。⚠ 言うのは「そのノートを編集中」
       *   のときだけ ── 別のノートが選ばれている / 語が空 / 編集以外の phase は、塗れない理由が
       *   画面に既にあるか、言う意味が無いので今までどおり黙る(state は 1 ビットも動かさない)。
       */
      if (query !== '' && state.phase === 'editing' && state.selectedLid === action.lid)
        return {
          state: {
            ...state,
            notice: SEARCH_JUMP_EDITING_NOTICE,
            noticeOpen: null,
            noticeCreate: null,
          },
          events: [],
        };
      if (
        query === '' ||
        state.phase !== 'ready' ||
        state.selectedLid !== action.lid ||
        state.sectionDraft != null
      )
        return { state, events: [] };
      return {
        state: {
          ...state,
          searchJump: {
            lid: action.lid,
            query,
            step: 0,
            gen: (state.searchJump?.gen ?? 0) + 1,
            origin: action.origin ?? 'find',
          },
        },
        events: [],
      };
    }
    case 'SEARCH_JUMP_STEP': {
      const j = state.searchJump ?? null;
      if (j === null) return { state, events: [] };
      return {
        state: { ...state, searchJump: { ...j, step: j.step + action.by, gen: j.gen + 1 } },
        events: [],
      };
    }
    case 'SEARCH_JUMP_END':
      if ((state.searchJump ?? null) === null) return { state, events: [] };
      return { state: { ...state, searchJump: null }, events: [] };
  }
}
