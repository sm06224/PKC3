/**
 * reducer の slice: 知らせ・タグ候補・失敗の受け(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceNotice` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import type { AppState, Dispatchable, ReduceResult } from '../app-state';

export type NoticeAction = Extract<Dispatchable, { type: 'NOTICE_EXPIRED' | 'OP_NOTICE' | 'ASK_TAG_SUGGESTIONS' | 'SET_TAG_SUGGESTIONS' | 'TAGS_REFUSED' | 'CLEAR_REFUSED_TAGS' | 'OP_FAILED' | 'SYS_ERROR' }>;

export function reduceNotice(state: AppState, action: NoticeAction): ReduceResult {
  switch (action.type) {
    case 'NOTICE_EXPIRED':
      if (state.notice !== action.message) return { state, events: [] };
      return {
        state: { ...state, notice: null, noticeOpen: null, noticeCreate: null },
        events: [],
      };
    case 'OP_NOTICE':
      // ⚠ **`error` を触らない** ── 知らせが出たからといって、出ているエラーを
      //    消してよい理由は無い(`main.ts` が別の行として組んでいる)
      // ⚠ 「開く」の身元は知らせと**対で**置く ── 添えない知らせが来たら消える
      return {
        state: {
          ...state,
          notice: action.message,
          noticeOpen: action.open ?? null,
          noticeCreate: action.createDate ?? null,
          ...(action.restoreUndo === undefined
            ? {}
            : { restoreUndo: { ...action.restoreUndo, notice: action.message } }),
          ...(action.tagUndo === undefined ? {} : { tagUndo: { ...action.tagUndo, notice: action.message } }),
          // 🔴 AI の書き足しの知らせ ── 戻す材料(`lastAgentAppend`)が同じノートのときだけ、字を対にして控える
          ...(action.agentUndo === true && state.lastAgentAppend !== null && state.lastAgentAppend.lid === action.open
            ? { lastAgentAppend: { ...state.lastAgentAppend, notice: action.message } }
            : {}),
        },
        events: [],
      };
    /**
     * 🔴 **タグの候補が要る**(#494 段②)。
     *
     * ⚠ **既に持っていれば何もしない** ── 焦点が当たるたびに全ノートの
     *   frontmatter を舐めると、打つ気になった瞬間に画面が重くなる。
       * 🔑 捨てるのは**タグを書いたとき**(`slices/block-ops.ts` の `BODY_REWRITTEN`)と、**集めた後にノートの一覧が
     *   変わったとき**(本文の `#タグ` を保存した・消した・取り込んだ ── `tagSuggestionsMetas`)。
     */
    case 'ASK_TAG_SUGGESTIONS': {
      if (state.phase !== 'ready') return { state, events: [] };
      // 🔑 集めた後にノートの一覧が変わっていたら集め直す(本文のタグ・消した・取り込んだ ── 上の注釈)
      if (state.tagSuggestions !== null && state.tagSuggestionsMetas === state.entryMetas)
        return { state, events: [] };
      return { state, events: [{ type: 'REQUEST_TAG_SUGGESTIONS' }] };
    }
    /**
     * ⚠ **空配列も答えである**(0 件だった)── `null` に戻さない。戻すと
     *   焦点が当たるたびに全走査が走る(#421 の `SMART_SCAN_FAILED` と同じ規律)。
     */
    case 'SET_TAG_SUGGESTIONS':
      return { state: { ...state, tagSuggestions: action.tags, tagSuggestionsMetas: state.entryMetas }, events: [] };
    /**
     * 🔴 **入らなかったタグを欄ごとに積む**(#640 案 A)。⚠ 同じ名前は 1 度だけ ──
     *   まとめて付ける経路は名前ごとに 1 回しか言わないが、二重に撃たれても欄に
     *   `#今月 #今月` と出ないように、ここで留める。並びは**届いた順**(= 打った順)。
     */
    case 'TAGS_REFUSED': {
      const had = state.refusedTags[action.field];
      const add = action.tags.filter((t) => !had.includes(t));
      if (add.length === 0) return { state, events: [] };
      return {
        state: { ...state, refusedTags: { ...state.refusedTags, [action.field]: [...had, ...add] } },
        events: [],
      };
    }
    case 'CLEAR_REFUSED_TAGS': {
      if (state.refusedTags[action.field].length === 0) return { state, events: [] };
      return {
        state: { ...state, refusedTags: { ...state.refusedTags, [action.field]: [] } },
        events: [],
      };
    }
    case 'OP_FAILED':
      // 非致命: 通知のみ。phase は動かさない(kanban 等の操作性を殺さない)
      return { state: { ...state, error: action.error }, events: [] };
    case 'SYS_ERROR': {
      // エラーは state 駆動(表示は state.error を読む)── event 通知は廃止。
      // - editing 中の着弾は editing 維持(draft 破壊防止 ── P3-6b review #3)
      // - error phase に落とすのは「守るべき未達 commit(baseline ≠ persisted)が
      //   ある」ときだけ ── error phase の意味は唯一の写しの保護であり、守る
      //   ものが無いのに落とすと無言ロックになる(P3-7a review 重大: 作成 →
      //   即 cancel × 初回 persist 失敗の合成で実証)。それ以外は通知のみ
      const protecting =
        state.openBody !== null &&
        state.openBody.baseline !== state.openBody.persisted &&
        !state.openBody.diskAhead;
      /**
       * 🔴 **空きが足りない断りは、編集の画面へ戻す**(依頼 104-1 B)。戻せるのは、保存した直後の画面が
       *   そのノートのままで(`ready`)、別のタブの版が先に在らないとき。書きかけの字(`baseline`)を
       *   編集の字に戻し、基準は disk(`persisted`)へ戻す ── 「編集を保存する」でもう一度同じ字が書かれる。
       */
      const ob = state.openBody;
      if (
        action.keepEditing !== undefined &&
        state.phase === 'ready' &&
        protecting &&
        ob !== null &&
        ob.lid === state.selectedLid
      ) {
        return {
          state: {
            ...state,
            phase: 'editing',
            error: action.keepEditing.editingError,
            openBody: { lid: ob.lid, body: ob.baseline, baseline: ob.persisted, persisted: ob.persisted, diskAhead: false },
            revisionPanel: null,
            revisionPreview: null,
            editOpenAt: null,
            lastMove: null,
          },
          events: [{ type: 'REQUEST_SNIPPET_SCAN' }],
        };
      }
      const phase =
        state.phase === 'editing' ? 'editing' : protecting ? 'error' : state.phase;
      return { state: { ...state, phase, error: action.error }, events: [] };
    }
  }
}
