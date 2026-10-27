/**
 * reducer の slice: スマートフォルダ(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceSmart` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import { type AppState, type Dispatchable, type ReduceResult, smartScanFor } from '../app-state';
import { EMPTY_SMART, SMART_ARCHETYPE } from '@features/smart/smart-spec';

export type SmartAction = Extract<Dispatchable, { type: 'SMART_SCANNED' | 'SMART_SCAN_FAILED' | 'SMART_TAGS' | 'SMART_COND' | 'SMART_FIELD' | 'SMART_RESCAN' }>;

export function reduceSmart(state: AppState, action: SmartAction): ReduceResult {
  switch (action.type) {
    /**
     * 🔴 **スマートフォルダの当たりが届いた**(#421 段①)。
     * ⚠ **lid で入れ物を分ける** ── 同じ表に複数のスマートフォルダの結果が
     *   入る(左と右で別々のものを開ける)ので、上書きにすると片方が消える。
     */
    case 'SMART_SCANNED': {
      const next = new Map(state.smartHits);
      next.set(action.lid, {
        lids: [...action.lids],
        total: action.total,
        failed: false,
        spec: action.spec,
        ...(action.unreadable !== undefined && action.unreadable > 0 ? { unreadable: action.unreadable } : {}),
      });
      return { state: { ...state, smartHits: next }, events: [] };
    }
    /**
     * ⚠ **黙って空にしない** ── 「集められない」と「0 件」は別の話である
     *   (旧い worker が service worker のキャッシュに残っている端末で起きる)。
     */
    case 'SMART_SCAN_FAILED': {
      const next = new Map(state.smartHits);
      // ⚠ 条件は**そのまま残す**(集められなかっただけで、条件は在る)
      next.set(action.lid, {
        lids: [],
        total: 0,
        failed: true,
        spec: state.smartHits.get(action.lid)?.spec ?? EMPTY_SMART,
      });
      return { state: { ...state, smartHits: next }, events: [] };
    }
    /**
     * 🔴 **落としたら条件のタグが付く / 外すと外れる**(#421 段①)。
     *
     * ⚠ **条件はここで読めない**(reducer は本文を持たない)ので、読むのは effect。
     * 🔑 書くのは**既にある口**(`BULK_TAG` → `REQUEST_BULK_TAG`)── タグを本文へ
     *   書く規則を 2 つ作らない(§7)。
     */
    case 'SMART_TAGS': {
      if (state.phase !== 'ready') return { state, events: [] };
      const lids = action.lids.filter((lid) => state.entryMetas.has(lid));
      if (lids.length === 0) return { state, events: [] };
      if (!state.entryMetas.has(action.smartLid)) return { state, events: [] };
      return {
        state,
        events: [
          { type: 'REQUEST_SMART_TAGS', smartLid: action.smartLid, lids, mode: action.mode },
        ],
      };
    }
    /**
     * 🔴 **条件を書き換える**(#421 段①)。書き終えたら**集め直す** ── そこまでが
     * 1 つの操作である(条件だけ変わって並びが古いままだと、user は「効いていない」
     * と読む)。⚠ 集め直しは effect が書込の後に頼む(順番が要る)。
     */
    case 'SMART_COND': {
      if (state.phase !== 'ready') return { state, events: [] };
      if (action.tag.trim() === '') return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (meta === undefined || meta.archetype !== SMART_ARCHETYPE) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_SMART_COND',
            target: {
              lid: meta.lid,
              title: meta.title,
              archetype: meta.archetype,
              entryOrder: meta.entryOrder,
            },
            tag: action.tag,
            mode: action.mode,
          },
        ],
      };
    }
    case 'SMART_FIELD': {
      if (state.phase !== 'ready') return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (meta === undefined || meta.archetype !== SMART_ARCHETYPE) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_SMART_FIELD',
            target: {
              lid: meta.lid,
              title: meta.title,
              archetype: meta.archetype,
              entryOrder: meta.entryOrder,
            },
            field: action.field,
            value: action.value,
          },
        ],
      };
    }
    case 'SMART_RESCAN':
      return { state, events: smartScanFor(state, action.lid) };
  }
}
