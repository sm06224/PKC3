/**
 * reducer の slice: 保存の結果・別ウィンドウの変更・バックリンク(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reducePersisted` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  type ReduceResult,
  hasUnreachedCommit,
  sameShownBodies,
  syncShownBodies,
} from '../app-state';

export type PersistedAction = Extract<Dispatchable, { type: 'BODY_PERSISTED' | 'REMOTE_BODY_CHANGED' | 'BACKLINKS_LOADED' | 'PERSIST_STATE' | 'ENTRY_STAMPED' }>;

export function reducePersisted(state: AppState, action: PersistedAction): ReduceResult {
  switch (action.type) {
    case 'BODY_PERSISTED': {
      /**
       * 🔴 **留めた枠にも同じノートが出ていることがある**(#505 段②)。
       * ⚠ ここで追随させないと、主の枠で直しても**留めた枠だけ古いまま**になる。
       * ⚠ `openBody` の早期 return の**前**に置く ── 後ろに置くと、
       *   選択が移った後の ack で留めた枠が更新されない(片側だけ在る非対称)。
       */
      const persistedShown = syncShownBodies(state, action.lid, action.body);
      const base = sameShownBodies(state, persistedShown) ? state : { ...state, ...persistedShown };
      // ack された内容を disk 事実として記録(選択が移って openBody が破棄
      // 済みなら捨てる ── stale ack で別 entry の作業域を汚さない)
      if (!state.openBody || state.openBody.lid !== action.lid)
        return { state: base, events: [] };
      const ob = state.openBody;
      if (ob.persisted === action.body) return { state: base, events: [] };
      return {
        state: { ...base, openBody: { ...ob, persisted: action.body } },
        events: [],
      };
    }
    /**
     * 🔴 **別の窓が書いたことを、編集中のタブが知る**(#178)。
     *
     * ⚠ 直す前、他タブの `changed` は **`reloadSnapshot` を頼むだけ**で、
     *   編集中は**まるごと先送り**されていた(`main.ts`)── つまり編集中のタブは
     *   「自分が読んだ後に誰かが書いた」ことを**最後まで知らなかった**。
     * 🔑 ここでやるのは**印を立てることだけ**。下書きには 1 バイトも触らない
     *   (`ENTRY_RESTORED` / `BODY_REWRITTEN` の編集中分岐と同じ作法)。
     */
    case 'REMOTE_BODY_CHANGED': {
      // 🔴 留めた枠は**編集中かどうかに関わらず**追随させる(#505 段②)──
      //    別の窓が書いたものを、こちらの留めた枠が古いまま映し続けない
      const remoteShown = syncShownBodies(state, action.lid, action.body);
      const base = sameShownBodies(state, remoteShown) ? state : { ...state, ...remoteShown };
      // ⚠ 編集中だけ ── `ready` は `reloadSnapshot` が先送りなしで面倒を見る
      //   (両方で受けると、同じ問いに答える口が 2 つになる。CLAUDE.md §7)
      // 🔴 保存に失敗して止まっている間も受ける(#1087)── 未達の字(`baseline`)を持ったまま
      //   別のタブが書いたら、再保存がそれを黙って上書きする
      if (state.phase !== 'editing' && !hasUnreachedCommit(state)) return { state: base, events: [] };
      const ob = state.openBody;
      if (!ob || ob.lid !== action.lid) return { state: base, events: [] };
      // ⚠ 自分が書いた内容がそのまま返ってきた回は印を立てない(自分と衝突しない)
      if (ob.persisted === action.body) return { state: base, events: [] };
      return {
        state: { ...base, openBody: { ...ob, persisted: action.body, diskAhead: true } },
        events: [],
      };
    }
    /**
     * 🔴 保存が「消えない扱い」かの ack(#347)。
     * ⚠ **同じなら state を差し替えない** ── 差し替えると指紋が変わり、
     *   関係の無い面が組み直される(この repo が何度も踏んでいる形)。
     */
    /**
     * 🔴 バックリンクが届いた(#348)。
     * ⚠ **遅れて届いた別のノートの分は捨てる** ── 選択を切り替えた直後に
     *   前のノートの答えが着くと、**別のノートの一覧**がその場に出る。
     */
    case 'BACKLINKS_LOADED':
      return action.lid !== state.selectedLid
        ? { state, events: [] }
        : {
            state: {
              ...state,
              backlinks: {
                lid: action.lid,
                lids: action.lids,
                truncated: action.truncated,
                ...(action.failed ? { failed: true as const } : {}),
              },
            },
            events: [],
          };
    case 'PERSIST_STATE':
      return action.state === state.persistState
        ? { state, events: [] }
        : { state: { ...state, persistState: action.state }, events: [] };
    case 'ENTRY_STAMPED': {
      const meta = state.entryMetas.get(action.lid);
      // 消えた entry の ack は捨てる(削除と書込の競合)
      if (!meta) return { state, events: [] };
      const charsChanged = action.bodyChars !== undefined && meta.bodyChars !== action.bodyChars;
      if (
        meta.createdAt === action.createdAt &&
        meta.updatedAt === action.updatedAt &&
        !charsChanged
      )
        return { state, events: [] };
      const entryMetas = new Map(state.entryMetas);
      entryMetas.set(action.lid, {
        ...meta,
        // ⚠ 既にある createdAt を null で塗り潰さない(行が消えていた場合に null が来る)
        createdAt: action.createdAt ?? meta.createdAt,
        updatedAt: action.updatedAt ?? meta.updatedAt,
        // 🔴 刻みが同じでも字数が違えば追従する(#1087)。⚠ 名乗らない口では動かさない
        ...(action.bodyChars === undefined ? {} : { bodyChars: action.bodyChars }),
      });
      return { state: { ...state, entryMetas }, events: [] };
    }
  }
}
