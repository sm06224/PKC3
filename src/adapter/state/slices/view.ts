/**
 * reducer の slice: 検索の詳細・表示モードの切替・各表示の読み直し(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceView` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  type ReduceResult,
  attachmentEntries,
  isAsidePane,
  searchRefreshEvents,
  viewModeLabel,
} from '../app-state';

export type ViewAction = Extract<Dispatchable, { type: 'SET_SEARCH_DETAIL' | 'SEARCH_DETAIL_FAILED' | 'SET_OPEN_EXTENSIONS' | 'SET_VIEW_MODE' | 'REFRESH_TASK_SCAN' | 'REFRESH_CONTACT_SCAN' | 'REFRESH_WORK_LOG_SCAN' | 'REFRESH_SEARCH' | 'REFRESH_CAPTURE_SCAN' | 'REFRESH_SNIPPET_SCAN' }>;

export function reduceView(state: AppState, action: ViewAction): ReduceResult {
  switch (action.type) {
    case 'SET_SEARCH_DETAIL':
      // ⚠ **遅れて返った古い結果を捨てる**(`SET_SEARCH_HITS` と同じ)
      if (action.query !== state.searchPage.query) return { state, events: [] };
      return {
        state: {
          ...state,
          searchPage: {
            query: action.query,
            rows: action.rows,
            rowsQuery: action.query,
            truncated: action.truncated,
            failed: false,
          },
        },
        events: [],
      };
    case 'SEARCH_DETAIL_FAILED':
      if (action.query !== state.searchPage.query) return { state, events: [] };
      // ⚠ 前の行は残す(消すと「失敗して空になった」に見える)── 印だけ立てる
      return {
        state: { ...state, searchPage: { ...state.searchPage, rowsQuery: action.query, failed: action.stale ? 'stale' : 'error' } },
        events: [],
      };
    case 'SET_OPEN_EXTENSIONS':
      /**
       * ⚠ **写すだけ**(選択も面も動かさない)── 窓が開いた / 閉じたことは
       *   user が「いま何を見ているか」を変える出来事ではない。
       */
      return { state: { ...state, openExtensions: action.open }, events: [] };
    case 'SET_VIEW_MODE':
      // selection は消さない(PKC2 規約)。panel は view に従属するので畳む
      /**
       * 🔴 **編集中でも「ノートを映さない面」は開ける**(user 裁定 2026-08-08。
       * P11 の Q5「開けないまま」を**覆した**)。
       *
       * 覆した理由は意見ではなく、**調べたら止めている理由が無かった**から:
       *  ① 面は `hidden` の付け外しで**生きたまま常駐**する(`center.ts` の `pane()`
       *     は 1 度だけ作り、`render` は非 active な面を描かない)
       *  ② 戻ったとき本文の面は**組み直されない**(`detail.ts` の `render` が
       *     「編集中かつ同じ lid」で早期 return する)
       *  → **textarea も native の取り消し履歴も壊れない**。
       *
       * 🔑 一方で止めるコストは実在した ── **「書きながらマニュアルを読む」は
       * ヘルプの主目的**であり、P11 で無言の dead click が 1 個 → 3 個に増えていた。
       *
       * ⚠ **一覧のノートを押す(`SELECT_ENTRY`)は開けない**。あちらは「下書きを
       *   守る」理由が実在する ── ただし無言で断らないのが正しい(別主題)。
       */
      /**
       * 🔴 **本文へ戻る道は塞がない**(2026-08-19、リリース前監査で判明)。
       *
       * ⚠ 直す前は `!isAsidePane(action.mode)` だけを見ていたので、
       * **`'detail'` への切替も編集中は捨てられていた** ── つまり編集中に
       * ヘルプ・設定・フラグ・2 ペインを開くと、**同じボタンをもう一度押しても
       * 本文へ戻れない**(`set-view` のトグルは `'detail'` を撃つ)。
       * ⚠ マニュアルは「**寄り道して戻っても**、打ちかけの本文も取り消しも
       * そのまま残ります」と約束しており、**その約束が守られていなかった**。
       * 🔑 止める理由も無い ── 編集の面は `detail` **そのもの**なので、
       * 戻るのは「編集へ帰る」であって「編集から離れる」ではない。
       * ⚠ かんばん / カレンダー / 集計は引き続き断る(あちらはノートを並べる面で、
       * 開くと編集していたものが画面から消える)。
       */
      /**
       * 🔴 **断るなら、声に出して断る**(user 目線レビュー U-2)。
       *
       * ⚠ 直す前は `events: []` で**黙って捨てて**いた ── 押しても画面が 1 ドットも
       *   動かず、帯にも何も出ない。user から見ると**タイルが壊れている**か、
       *   押せていないのかも分からない(CLAUDE.md が繰り返し戒めている
       *   「無言の dead click」そのもの)。
       * ⚠ このリポジトリは**同じ場面で既に声を出している** ── `binder.ts` の
       *   ごみ箱の復元は「編集を保存するか、編集をやめてから戻してください」と言う(#319)。
       *   ここだけ黙っていた。
       * 🔑 **判定はここ 1 か所のまま**にする(CLAUDE.md §7)── 呼び側
       *   (`set-view` / タイル / 鍵)に `phase !== 'ready'` を配ると、
       *   足すたびに取りこぼす。`error` を載せて返せば、出口は既存の 1 本で足りる。
       */
      if (state.phase === 'editing' && !isAsidePane(action.mode) && action.mode !== 'detail')
        return {
          state: {
            ...state,
            error: `編集中は${viewModeLabel(action.mode)}を開けません(「編集を保存する」か「編集をやめる」を押すと開けます)`,
          },
          events: [],
        };
      return {
        state: {
          ...state,
          viewMode: action.mode,
          revisionPanel: null,
          // ⚠ 見ていた版も畳む(#398 段②)── 一覧が畳まれたら差分は孤児になる
          revisionPreview: null,
          trashPanel: null,
        },
        // 🔑 ランチャーを開いたら**そのとき**タイルを要求する(P7b 段⑩)。
        // ⚠ 元データ(`registered_as_app` 等)は attachment の frontmatter で
        // **常駐していない** ── boot で全部読むと、ランチャーを一度も開かない
        // user にも全添付の body 読込を負わせることになる。
        // ⚠ **毎回要求する**。ただし前回のタイルは**消さない** ── 2 回目以降は
        // 前回の並びを出したまま読み直し、届いたら差し替える(review L-5 で
        // 「古い一覧を見せない」と書いてあったのは嘘だったので、実装ではなく
        // 記述を直した ── ランチャーを開くたびに「読み込んでいます…」を
        // 挟むほうが体感として悪い。読み直しは store 1 往復で終わる)
        // 🔑 **集計も同じ流儀**(#184)── 開いたときに問い合わせる。
        // ⚠ 元データ(frontmatter)は常駐していないので、boot で読むと
        // 集計を一度も開かない user にも全本文の走査を負わせることになる。
        // ⚠ 前の表は**消さない**(ランチャーと同じ ── 読み直しの間に空白を出さない)。
        // ⚠ ランチャーの枝は #241 段⑥-b で畳んだ ── アプリの一覧は**左の列の
        //    タブ**が持つ面になったので、読み直しは `REFRESH_LAUNCHER_TILES`
        //    (`main.ts` が探し方の切替で撃つ)1 本である
        // ⚠ **予定は中央の面ではない**(#292 段⑤)── 左の列のタブなので、
        //    集め直しは `main.ts` が `REFRESH_TASK_SCAN` で頼む。
        events:
          action.mode === 'query'
            ? [{ type: 'REQUEST_QUERY_SCAN', key: state.queryKey }]
            : [],
      };
    case 'REFRESH_TASK_SCAN':
      return { state, events: [{ type: 'REQUEST_TASK_SCAN' }] };
    /**
     * 🔴 **連絡先を集め直す**(#278 段①)。⚠ **毎回要求する**が、前の一覧は
     *   消さない ── 消すと、集め直すたびに一覧が空になって**行が飛ぶ**。
     */
    case 'REFRESH_CONTACT_SCAN':
      return { state, events: [{ type: 'REQUEST_CONTACT_SCAN' }] };
    // 🔴 計った時間(#683 ①)── 前の一覧は消さない(行が飛ばない)
    case 'REFRESH_WORK_LOG_SCAN':
      return { state, events: [{ type: 'REQUEST_WORK_LOG_SCAN' }] };
    case 'REFRESH_SEARCH':
      return { state, events: searchRefreshEvents(state) };
    /**
     * 🔴 **録ったものを集め直す**(#683 段①)。⚠ **毎回要求する**が、前の一覧は
     *   消さない(連絡先・アプリと同じ ── 集め直すたびに空白を出さない)。
     */
    case 'REFRESH_CAPTURE_SCAN':
      return {
        state,
        events: [{ type: 'REQUEST_CAPTURE_ITEMS', entries: attachmentEntries(state) }],
      };
    case 'REFRESH_SNIPPET_SCAN':
      return { state, events: [{ type: 'REQUEST_SNIPPET_SCAN' }] };
  }
}
