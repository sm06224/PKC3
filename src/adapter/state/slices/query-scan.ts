/**
 * reducer の slice: 一覧の絞り込み・並び・検索ページ・各種の走査結果(タスク / 連絡先 / 作業記録 / 取り込み / 図の見方 / スニペット)(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceQueryScan` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import { type AppState, type Dispatchable, type ReduceResult, bodyWriteBlockResult } from '../app-state';
import { NATURAL_DESC } from '@features/filter/entry-sort';
import { toggleKind } from '@features/filter/kind-filter';
import { NO_KINDS, normalizeQuery } from '@features/filter/title-filter';
import { commandQueryOf } from '@features/palette/command-query';
import { clampGraphDepth } from '@features/relation/graph-view';
import { relabelWorkLine } from '@features/timer/work-log';

export type QueryScanAction = Extract<Dispatchable, { type: 'SET_ENTRY_FILTER' | 'TOGGLE_KIND_FILTER' | 'CLEAR_KIND_FILTER' | 'SET_OPENED_AT' | 'SET_ENTRY_SORT' | 'SET_QUERY_KEY' | 'REFRESH_QUERY' | 'SET_QUERY_SCAN' | 'QUERY_FAILED' | 'SET_TASK_SCAN' | 'TASK_SCAN_FAILED' | 'SET_CONTACT_SCAN' | 'CONTACT_SCAN_FAILED' | 'SET_WORK_LOG_SCAN' | 'WORK_LOG_SCAN_FAILED' | 'SET_WORK_LOG_LABEL' | 'DELETE_WORK_LOG' | 'SET_CAPTURE_ITEMS' | 'CAPTURE_SCAN_FAILED' | 'SET_CAPTURE_PLAYING' | 'SET_CAPTURE_TRIM_MARK' | 'CLEAR_CAPTURE_TRIM' | 'SET_CAPTURE_TRIM_BUSY' | 'SET_CAPTURE_TRANSCRIBE' | 'SET_GRAPH_VIEW' | 'SET_SNIPPET_SCAN' | 'SET_SEARCH_HITS' | 'SET_SEARCH_PAGE_QUERY' }>;

export function reduceQueryScan(state: AppState, action: QueryScanAction): ReduceResult {
  switch (action.type) {
    case 'SET_ENTRY_FILTER':
      // ⚠ 選択は消さない(`SET_VIEW_MODE` と同じ規約)── 絞り込んで消えた行を
      // 選んでいても、解除すれば戻ってくる
      if (state.filterQuery === action.query) return { state, events: [] };
      /**
       * 🔴 **問い合わせが変わったら本文の当たりは捨てる**(#181)── 残すと
       * 「前の語で当たった行」が新しい絞り込みに混ざる。⚠ 捨てたうえで
       * `REQUEST_SEARCH` を出し、返ってきたら `SET_SEARCH_HITS` で増やす。
       */
      return {
        state: {
          ...state,
          filterQuery: action.query,
          searchHits: null,
          searchHitsQuery: '',
          // ⚠ 前の語の「ほかにもあります」を持ち越さない(#680)
          searchHitsTruncated: false,
          searchHitsFailed: false,
          /**
           * 🔴 **絞り込んだら並べ替えモードは落とす**(#857 段①b-2)。
           * ⚠ 出ているのは絞った後のタイルだが、並び順の正本は**全件**なので、
           *   そのまま「上へ」を押しても**画面が 1 ドットも動かない**
           *   (隠れた隣と入れ替わっただけ)。⚠ 判定を 2 か所に置かない ──
           *   ここで落とすので、描く側も押す側も `launcherReorder` 1 つを読む。
           */
          launcherReorder:
            normalizeQuery(action.query) === '' ? state.launcherReorder : false,
        },
        /**
         * 🔴 **`>` で始まる字は、本文を探さない**(#274 段①)── 操作の名前を探している
         *   のであって、`>` ごと SQL で全文検索しても当たりは 0 件で、worker を無駄に叩く。
         * ⚠ 語は `filterQuery` に**写す**(欄の字の正本は state)。一覧を操作に替えるのは
         *   描く側(`browse.ts`)で、ここは検索を撃たないことだけを決める。
         */
        events:
          commandQueryOf(action.query) !== null
            ? []
            : [{ type: 'REQUEST_SEARCH', query: action.query }],
      };
    /**
     * 🔴 **種類の札を押した / もう一度押した**(#411)。
     * ⚠ 選択は消さない(`SET_ENTRY_FILTER` と同じ規約)── 絞って消えた行を
     *   選んでいても、外せば戻ってくる。
     * ⚠ **本文の当たり(`searchHits`)は捨てない** ── 語は変わっていないので、
     *   捨てると当たりが返るまで**本文だけ当たっていた行が消える**(ちらつく)。
     */
    case 'TOGGLE_KIND_FILTER': {
      const kinds = toggleKind(state.kindFilter, action.archetype);
      return { state: { ...state, kindFilter: kinds }, events: [] };
    }
    case 'CLEAR_KIND_FILTER':
      if (state.kindFilter.size === 0) return { state, events: [] };
      return { state: { ...state, kindFilter: NO_KINDS }, events: [] };
    /**
     * 🔴 **最近開いた記録が入れ替わった**(#215 残り①)。
     * ⚠ **時刻はここで作らない**(reducer は純粋)── 呼び側(effect)が
     *   `Date.now()` を読んで、出来上がった表を渡す。
     * ⚠ 同じ中身なら**新しい参照を作らない** ── 指紋が毎回変わると、
     *   一覧が 1 文字も変わっていないのに描き直される。
     */
    case 'SET_OPENED_AT': {
      const now = state.openedAt;
      if (now.size === action.openedAt.size) {
        let same = true;
        for (const [lid, at] of action.openedAt) {
          if (now.get(lid) !== at) {
            same = false;
            break;
          }
        }
        if (same && (action.keepListOrder === true || state.openedAtShown === now))
          return { state, events: [] };
        if (same) return { state: { ...state, openedAtShown: now }, events: [] };
      }
      return {
        state: {
          ...state,
          openedAt: action.openedAt,
          // ⚠ 開いただけでは一覧の並びを動かさない(`openedAtShown` の注記)
          openedAtShown: action.keepListOrder === true ? state.openedAtShown : action.openedAt,
        },
        events: [],
      };
    }
    case 'SET_ENTRY_SORT': {
      // ⚠ 選択は消さない ── 並び替えただけで開いているノートが変わると驚く
      const desc = action.desc ?? NATURAL_DESC[action.sort];
      if (state.entrySort === action.sort && state.entrySortDesc === desc)
        return { state, events: [] };
      return { state: { ...state, entrySort: action.sort, entrySortDesc: desc }, events: [] };
    }
    case 'SET_QUERY_KEY': {
      if (state.queryKey === action.key) return { state, events: [] };
      /**
       * 🔴 **前の表を必ず捨てる**(#184)。⚠ 残すと「見出しだけ変わって中身が
       * 古いまま」の表になる ── 検索が `searchHits` を捨てるのと同じ理由。
       */
      const cleared = { ...state, queryKey: action.key, queryGroups: null, queryFailed: false };
      if (action.key === null) return { state: cleared, events: [] };
      return { state: cleared, events: [{ type: 'REQUEST_QUERY_SCAN', key: action.key }] };
    }
    case 'REFRESH_QUERY':
      // ⚠ 前の表は**消さない**(ランチャーと同じ ── 読み直しの間に空白を出さない)
      return {
        state: { ...state, queryFailed: false },
        events: [{ type: 'REQUEST_QUERY_SCAN', key: state.queryKey }],
      };
    case 'SET_QUERY_SCAN':
      // ⚠ **遅れて返った古い結果を捨てる**(検索と同じ ── 選び直しは結果より速い)
      if (action.key !== state.queryKey) return { state, events: [] };
      return {
        state: {
          ...state,
          queryKeys: action.keys,
          // ⚠ key が無い走査は表を持たない ── そのとき前の表を消さない
          queryGroups: action.groups ?? state.queryGroups,
          queryFailed: false,
        },
        events: [],
      };
    case 'QUERY_FAILED':
      return { state: { ...state, queryFailed: true }, events: [] };
    case 'SET_TASK_SCAN':
      return { state: { ...state, taskScan: action.scan, taskScanFailed: false }, events: [] };
    case 'TASK_SCAN_FAILED':
      return { state: { ...state, taskScanFailed: true }, events: [] };
    case 'SET_CONTACT_SCAN':
      return {
        state: { ...state, contactScan: action.scan, contactScanFailed: false },
        events: [],
      };
    case 'CONTACT_SCAN_FAILED':
      return { state: { ...state, contactScanFailed: true }, events: [] };
    case 'SET_WORK_LOG_SCAN':
      return { state: { ...state, workLogScan: action.scan, workLogScanFailed: false }, events: [] };
    case 'WORK_LOG_SCAN_FAILED':
      return { state: { ...state, workLogScanFailed: true }, events: [] };
    /**
     * 🔴 **計った時間の名前を付け替える / 行を消す**(#683 ①)。⚠ `TOGGLE_TASK` と**同じ形**:
     *   断りは lid で判定し、押した時点の行は**一覧が見ていた断面**(`workLogScan`)から引く
     *   (行番号だけだと、別の窓が上へ 1 行足したあと別の行を書き換える)。引けなければ撃たずに断る。
     */
    case 'SET_WORK_LOG_LABEL':
    case 'DELETE_WORK_LOG': {
      const del = action.type === 'DELETE_WORK_LOG';
      const blockedResult = bodyWriteBlockResult(
        state,
        action.lid,
        del ? '計った時間を消してください' : '名前を直してください',
      );
      if (blockedResult !== null) return blockedResult;
      const meta = state.entryMetas.get(action.lid);
      const run = state.workLogScan?.runs.find((r) => r.lid === action.lid && r.line === action.line);
      if (!meta || run === undefined) {
        return {
          state: { ...state, error: '計った時間が見つかりません(一覧が古くなっています。開き直すと集め直します)' },
          events: [{ type: 'REQUEST_WORK_LOG_SCAN' }],
        };
      }
      const next = del ? null : relabelWorkLine(run.rawLine, action.type === 'SET_WORK_LOG_LABEL' ? action.label : '');
      if (!del && next === null) return { state, events: [] };
      // 変わらない名前は書かない(同じ本文を書き直して更新日時だけ動かさない)
      if (next === run.rawLine) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'work-log', line: run.line, openLine: run.rawLine, next },
          },
        ],
      };
    }
    case 'SET_CAPTURE_ITEMS':
      return {
        state: { ...state, captureItems: action.items, captureScanFailed: false },
        events: [],
      };
    case 'CAPTURE_SCAN_FAILED':
      return { state: { ...state, captureScanFailed: true }, events: [] };
    case 'SET_CAPTURE_PLAYING':
      // ⚠ 同じ行をもう一度押したら**やめる**(押す口を 2 つ作らない)
      return {
        state: {
          ...state,
          capturePlayingLid: state.capturePlayingLid === action.lid ? null : action.lid,
          // 🔴 鳴らす物が変わったら印は消す ── 別の録音の時刻を残さない
          captureTrim: null,
        },
        events: [],
      };
    case 'SET_CAPTURE_TRIM_MARK': {
      // 🔴 **鳴っていなければ印は付かない** ── 時刻は「いま鳴っている所」の話なので、
      //   鳴っていなければ意味を持たない(押し所を出さないのは描画側の仕事)
      const lid = state.capturePlayingLid;
      if (lid === null) return { state, events: [] };
      const ms = Math.max(0, Math.round(action.ms));
      const prev = state.captureTrim?.lid === lid ? state.captureTrim : null;
      const startMs = action.edge === 'start' ? ms : prev?.startMs ?? null;
      const endMs = action.edge === 'end' ? ms : prev?.endMs ?? null;
      return {
        state: {
          ...state,
          captureTrim: {
            lid,
            // ⚠ **逆転を残さない** ── いま押していない側を落とす(次に押せば戻る)
            startMs: endMs !== null && startMs !== null && startMs >= endMs
              ? (action.edge === 'start' ? startMs : null)
              : startMs,
            endMs: endMs !== null && startMs !== null && startMs >= endMs
              ? (action.edge === 'end' ? endMs : null)
              : endMs,
          },
        },
        events: [],
      };
    }
    case 'CLEAR_CAPTURE_TRIM':
      return { state: { ...state, captureTrim: null }, events: [] };
    case 'SET_CAPTURE_TRIM_BUSY':
      return { state: { ...state, captureTrimBusy: action.busy }, events: [] };
    case 'SET_CAPTURE_TRANSCRIBE':
      return { state: { ...state, captureTranscribeLid: action.lid }, events: [] };
    case 'SET_GRAPH_VIEW': {
      const all = action.all ?? state.graphView.all;
      const depth = action.depth === undefined ? state.graphView.depth : clampGraphDepth(action.depth);
      if (all === state.graphView.all && depth === state.graphView.depth) return { state, events: [] };
      return { state: { ...state, graphView: { all, depth } }, events: [] };
    }
    /**
     * 🔴 **雛形は「集められなかった」を帯に出さない**(#196 / B-2)。
     *
     * ⚠ 予定(`taskScanFailed`)と作法が違うのはわざとである ── 予定は**面そのもの**
     *   なので「集めています…」で止まると壊れて見えるが、雛形は**入力の補助**なので、
     *   出せないときは**静かに畳む**のが正しい(打っている最中に帯が出るほうが邪魔)。
     * 🔑 だから失敗も `null` で表す ── `Tab` も `/` もただ何も出さず、
     *   **既定の `Tab`(焦点移動)は生きたまま**である。
     */
    case 'SET_SNIPPET_SCAN':
      return { state: { ...state, snippetScan: action.scan }, events: [] };
    case 'SET_SEARCH_HITS':
      // ⚠ **遅れて返った古い結果を捨てる**(打鍵は結果より速い)
      if (action.query !== state.filterQuery) return { state, events: [] };
      return {
        state: {
          ...state,
          searchHits: new Set(action.lids),
          searchHitsQuery: action.query,
          searchHitsTruncated: action.truncated,
          searchHitsFailed: action.failed === true,
        },
        events: [],
      };
    /**
     * 🔴 **探す面の欄に打った**(#680)。⚠ 左の一覧(`filterQuery`)には触らない。
     * ⚠ 前の行は**消さない**(`rowsQuery` が古いまま = まだ返っていない、と読める)──
     *   打つたびに一覧が空になるとちらつく。空にしたら結果も空にする(頼まない)。
     */
    case 'SET_SEARCH_PAGE_QUERY': {
      const page = state.searchPage;
      if (page.query === action.query) return { state, events: [] };
      if (action.query.trim() === '') {
        return {
          state: {
            ...state,
            searchPage: { query: action.query, rows: [], rowsQuery: action.query, truncated: false, failed: false },
          },
          events: [],
        };
      }
      return {
        state: { ...state, searchPage: { ...page, query: action.query, failed: false } },
        events: [{ type: 'REQUEST_SEARCH_DETAIL', query: action.query }],
      };
    }
  }
}
