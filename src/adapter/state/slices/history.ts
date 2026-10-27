/**
 * reducer の slice: 履歴パネルと版の復元(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceHistory` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  type DomainEvent,
  type ReduceResult,
  type RevisionCompare,
  type RevisionCompareLoad,
  phaseBlockReason,
  sectionDraftBlockedResult,
} from '../app-state';

export type HistoryAction = Extract<Dispatchable, { type: 'SHOW_HISTORY' | 'PREVIEW_REVISION' | 'HIDE_REVISION_PREVIEW' | 'REVISION_PREVIEW_LOADED' | 'SET_REVISION_COMPARE' | 'REVISION_COMPARE_LOADED' | 'HIDE_HISTORY' | 'REVISION_LIST_LOADED' | 'RESTORE_REVISION' | 'REIMPORT_BODY' }>;

export function reduceHistory(state: AppState, action: HistoryAction): ReduceResult {
  switch (action.type) {
    case 'SHOW_HISTORY': {
      /**
       * ready のみ。一覧は要求時に引く(boot で revisions に触れない)。
       * 🔴 **引く相手は `action.lid`**(#891)── ⚠ ここで `state.selectedLid` を
       *   読み直すと、**押した物と効く先が食い違う**(メニューが開いている間に
       *   選択が動くと、別のノートの履歴が開く)。撃つ側が既に解決している。
       */
      if (state.phase !== 'ready' || !action.lid) return { state, events: [] };
      return {
        state,
        events: [{ type: 'REQUEST_REVISION_LIST', lid: action.lid }],
      };
    }
    /**
     * 🔴 **戻す前に中身を見る**(#398 段②)。
     * ⚠ **押した版が既に開いていたら畳む**(同じ物をもう一度押したら閉じる)──
     *   開きっぱなしにすると、閉じる道が「別の版を押す」しか無くなる
     *   (user 指示 2026-08-23「置けるなら外せる」の面版)。
     */
    case 'PREVIEW_REVISION': {
      if (state.phase !== 'ready' || !state.selectedLid) return { state, events: [] };
      if (state.revisionPreview?.revId === action.revId)
        return { state: { ...state, revisionPreview: null }, events: [] };
      return {
        state,
        events: [
          { type: 'REQUEST_REVISION_BODY', lid: state.selectedLid, revId: action.revId },
        ],
      };
    }
    case 'HIDE_REVISION_PREVIEW':
      return { state: { ...state, revisionPreview: null }, events: [] };
    case 'REVISION_PREVIEW_LOADED': {
      // ⚠ 遅れて着いた分が別のノートのものなら捨てる(`BODY_LOADED` と同型)
      if (state.selectedLid !== action.lid) return { state, events: [] };
      // 🔴 履歴を閉じた後・別の版を待っている間に着いた分は捨てる(次に開いたとき、押していない版が選ばれて見える)
      if (state.revisionPanel === null || state.revisionPanel.lid !== action.lid) return { state, events: [] };
      if (!state.revisionPanel.items.some((it) => it.id === action.revId)) return { state, events: [] };
      return {
        state: {
          ...state,
          // ⚠ 相手は**必ず `current` から**(版を開き直したら、前の相手を持ち越さない)
          revisionPreview: {
            lid: action.lid,
            revId: action.revId,
            body: action.body,
            compare: { kind: 'current' },
          },
        },
        events: [],
      };
    }
    case 'SET_REVISION_COMPARE': {
      const pv = state.revisionPreview;
      if (state.phase !== 'ready' || pv === null || state.selectedLid !== pv.lid)
        return { state, events: [] };
      const set = (compare: RevisionCompare, events: DomainEvent[] = []) => ({
        state: { ...state, revisionPreview: { ...pv, compare } },
        events,
      });
      if (action.value === 'current') return set({ kind: 'current' });
      // ⚠ PC のファイルは**結びついているノートだけ**(選択肢を出していない相手を、値の直撃で選ばせない)
      if (action.value === 'file') {
        if (!state.linkedFiles.has(pv.lid)) return { state, events: [] };
        return set({ kind: 'file', load: { state: 'loading' } });
      }
      if (action.value.startsWith('rev:')) {
        const revId = action.value.slice('rev:'.length);
        // ⚠ 見ている版そのものとの比較は意味が無い(選択肢にも出さない)/ 履歴に並んでいない版は読まない
        const items = state.revisionPanel?.lid === pv.lid ? state.revisionPanel.items : [];
        if (revId === pv.revId || !items.some((it) => it.id === revId)) return { state, events: [] };
        return set({ kind: 'rev', revId, load: { state: 'loading' } }, [
          { type: 'REQUEST_REVISION_BODY', lid: pv.lid, revId, forCompareOf: pv.revId },
        ]);
      }
      return { state, events: [] };
    }
    case 'REVISION_COMPARE_LOADED': {
      const pv = state.revisionPreview;
      if (pv === null || pv.lid !== action.lid || pv.revId !== action.previewRevId)
        return { state, events: [] };
      const c = pv.compare;
      if (c.kind === 'current') return { state, events: [] };
      const now = c.kind === 'rev' ? `rev:${c.revId}` : 'file';
      if (now !== action.against || c.load.state !== 'loading') return { state, events: [] };
      const load: RevisionCompareLoad =
        action.text === null
          ? action.tooLarge === true
            ? { state: 'failed', tooLarge: true }
            : { state: 'failed' }
          : { state: 'loaded', text: action.text };
      return {
        state: { ...state, revisionPreview: { ...pv, compare: { ...c, load } } },
        events: [],
      };
    }
    case 'HIDE_HISTORY':
      // ⚠ **見ていた版も一緒に畳む** ── 一覧を閉じたのに差分だけ残ると、
      //    どの版の物か分からない孤児になる
      return { state: { ...state, revisionPanel: null, revisionPreview: null }, events: [] };
    case 'REVISION_LIST_LOADED': {
      // 遅延到着が現選択と食い違うなら捨てる(stale 反映防止 ── BODY_LOADED と同型)
      if (state.selectedLid !== action.lid) return { state, events: [] };
      if (state.phase !== 'ready') return { state, events: [] };
      return {
        state: { ...state, revisionPanel: { lid: action.lid, items: action.items } },
        events: [],
      };
    }
    case 'RESTORE_REVISION': {
      if (state.phase !== 'ready' || !state.selectedLid)
        return { state, events: [] };
      /**
       * 🔴 **章の欄が開いている間は断る**(#1044 段2 2巡目の修理、R2)。
       *
       * ⚠ 直す前はここを素通りしていた ── `RESTORE_REVISION` 自身は
       *   `selectedLid` を動かさないので、外側の門(`guardSectionDraftTransition`)
       *   はこの時点では何も気づかない。効果層が古い版を disk へ書き終えた**後**
       *   `ENTRY_RESTORED` が届き、`phase !== 'editing'`(章の欄は `phase` を
       *   `ready` のまま保つ)の枝が `openBody` を丸ごと復元前の版へ差し替える ──
       *   これは**同じノートの中で** `openBody.lid` が動かないので、外側の門の
       *   `movedAway` 判定にも `entryGone` 判定にも引っかからない
       *   (§1「強制する規則は、強制しなければ false になる場面で見ないと空振りする」
       *   と同じ形 ── selectedLid が動かない経路は素通りする)。放っておくと
       *   章の下書きは古い `original` を握ったまま、本文だけ復元前の版に変わる。
       * 🔑 だからここで **断る**(`SAVE_SECTION_DRAFT` / `OPEN_SECTION_DRAFT` と
       *   同じ字)── system command 側の「知らせて閉じる」は使わない。これは
       *   user 自身の操作(履歴の戻し)であり、断って選び直させれば済む。
       */
      if (state.sectionDraft !== null) {
        return sectionDraftBlockedResult(state);
      }
      const meta = state.entryMetas.get(state.selectedLid);
      if (!meta) return { state, events: [] };
      // panel は畳む(復元で履歴が 1 件伸びるので開き直しが正)。meta snapshot は
      // 発火時捕獲(C-1 規律)
      return {
        state: { ...state, revisionPanel: null, revisionPreview: null, restoreUndo: null },
        events: [
          {
            type: 'REQUEST_RESTORE',
            lid: meta.lid,
            revId: action.revId,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            ...(action.fromUndo === true ? { fromUndo: true as const } : {}),
          },
        ],
      };
    }
    case 'REIMPORT_BODY': {
      // 🔴 編集中・保存に失敗して止まっている間は、声に出して断る(無言の操作拒否を作らない)
      if (state.phase !== 'ready') {
        return {
          state: { ...state, error: `${phaseBlockReason(state.phase) ?? ''}取り込み直してください` },
          events: [],
        };
      }
      // 🔴 章の欄が開いている間は断る(`RESTORE_REVISION` と同じ門 ── 復元は本文を丸ごと差し替える)
      if (state.sectionDraft !== null) return sectionDraftBlockedResult(state);
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_REIMPORT',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            body: action.body,
            ...(action.notice === undefined ? {} : { notice: action.notice }),
          },
        ],
      };
    }
  }
}
