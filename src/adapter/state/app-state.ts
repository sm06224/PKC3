/**
 * リーン集約 AppState + pure reducer(P3 設計メモ §1)。
 *
 * - 常駐は meta / order / relations / UI state / openBody(選択中 1 件の body)のみ
 * - reducer は純粋。非同期(store I/O)は effect 層(store-effects.ts)が
 *   DomainEvent を購読して行い、SystemCommand で還流する
 * - PKC2 の規約を維持: SET_VIEW_MODE は selection を消さない /
 *   selectedLid が選択の単一情報源
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import { DEFAULT_ENTRY_SORT, type EntrySort } from '@features/filter/entry-sort';
import { resolveCanonicalParents, reorderSibling } from '@features/relation/tree';
import { extractMeta, seedBodyFor } from '@features/flavor';
import { withTodoStatus } from '@features/flavor/todo-flavor';
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import type { LauncherTile } from '@features/launcher/tiles';
import type {
  GroupResult as QueryGroups,
  KeyResult as QueryKeys,
} from '@features/query/group-by';
import { visibleOrder } from '@features/filter/title-filter';
import { STRUCTURAL, type RelationKind } from '@features/relation/kinds';
import { replaceAll } from '@features/markdown/body-replace';
import {
  EMPTY_HISTORY,
  canGoBack,
  canGoForward,
  current as historyCurrent,
  goBack,
  goForward,
  pruneHistory,
  pushSelection,
  type SelectionHistory,
} from '@features/nav/selection-history';
import { filerRows, rangeInRows } from '@features/relation/filer-list';

export type AppPhase = 'initializing' | 'ready' | 'editing' | 'error';
export type ViewMode =
  | 'detail'
  | 'calendar'
  | 'kanban'
  | 'filer'
  | 'launcher'
  /**
   * 🔴 **集計**(#184)── frontmatter の 1 つの key で束ねて表にする面。
   * ⚠ **aside ではない**(ノートを映す面である)ので、押した行の選択は
   * この面に留まる ── かんばん / カレンダーと同じ扱い。
   */
  | 'query'
  | 'settings'
  | 'flags'
  | 'help';

/**
 * 🔴 **ノートを映していない中央の面**(P11)。一覧のノートを押したら中央を
 * ノートへ戻す ── その判定をここ 1 か所に置く。
 *
 * ⚠ 直す前は `viewMode === 'settings'` の**直書き**だった。面を足すたびに
 * 取りこぼすので(P8 段⑲ で直した「開かない理由が画面のどこにも無い」の再演)、
 * **集合にして 1 か所へ寄せた**(CLAUDE.md「判定を増やさない」)。
 */
const ASIDE_PANES: ReadonlySet<ViewMode> = new Set<ViewMode>(['settings', 'flags', 'help']);

export function isAsidePane(view: ViewMode): boolean {
  return ASIDE_PANES.has(view);
}

/**
 * 選択中 entry の body 作業域。3 つの内容は意味が異なる(review E の解消形):
 * - body: 編集中の現在値
 * - baseline: **最後に commit した内容**。CANCEL_EDIT の復帰先であり、
 *   「変わっていないなら書かない」(#1024)の skip 基準(= 最後に enqueue した
 *   書込内容と常に一致するので、A→B→A の再 commit も正しく書かれる)
 * - persisted: **BODY_PERSISTED で確認された disk 上の内容**。enqueue と ack を
 *   混同しない ── persist 失敗時は baseline ≠ persisted が「disk に未達」の
 *   事実として残り、エラー復帰 / retry(将来)の判定に使える
 *
 * baseline ≠ persisted には向きの異なる 2 原因がある(文字列比較では区別不能):
 * (a) 自 commit の ack 待ち(persisted が遅れている)── baseline が正
 * (b) editor 外の書込(かんばんトグル等)が ack 済み(persisted が進んでいる)
 *     ── disk が正。こちらだけ diskAhead で印を付け、無変更 commit / cancel で
 *     disk を採用する(stale baseline の巻き戻し防止 ── P3-6a review #4)
 */
export interface OpenBody {
  lid: string;
  body: string;
  baseline: string;
  persisted: string;
  diskAhead: boolean;
}

/** 履歴一覧の 1 行(P5b)。boot では持たない ── SHOW_HISTORY の要求時に引く。 */
export interface RevisionItem {
  id: string;
  revOrder: number;
  createdAt: string | null;
  title: string | null;
}

/** ゴミ箱一覧の 1 行(= entries に居ない entry_lid の最新 revision)。 */
export interface TrashItem {
  revId: string;
  entryLid: string;
  createdAt: string | null;
  title: string | null;
  archetype: string | null;
}

export interface AppState {
  phase: AppPhase;
  cid: string | null;
  entryMetas: ReadonlyMap<string, EntryMeta>;
  order: readonly string[];
  relations: readonly Relation[];
  openBody: OpenBody | null;
  selectedLid: string | null;
  /**
   * 🔴 **いま「どのフォルダを見ているか」**(#240 段①。user 指示 2026-08-17
   * 「フォルダ表示メインにしてフォルダをダブルクリックで開くように変更」)。
   *
   * ⚠ 直す前、現在地は **`selectedLid` の純関数**だった(`resolveFilerScope`)──
   * つまり「選ぶ」と「入る」が同じ操作で、user 指示の**ダブルクリックで開く**は
   * この 2 つを分けろという指示にほかならない。
   * ⚠ そして**複数選択とも正面からぶつかる**(2 件選んだら現在地を 1 つに言えない)ので、
   * 選択を集合にする前に、現在地を**状態として**持つ必要がある。
   * ⚠ `null` = ルート。⚠ 消えた lid は指し続けない(`removeEntry` が畳む)。
   */
  scopeLid: string | null;
  /**
   * 🔴 **印を付けたもの**(#240 段②。user 指示 2026-08-17「複数選択・範囲選択」)。
   *
   * ⚠ `selectedLid`(= いま**開いている**ノート)とは**別の値**である ──
   * PKC2 は 2 つを union で 1 つに畳んでおり、user audit が「最悪の UX 事故」と
   * 記録している(呼び出し側ごとに `includeAnchor` を渡す二重規則になっていた)。
   * 🔑 まとめて消す・まとめて動かすが見るのは**こちらだけ**。1 クリックは両方を動かし、
   * `Ctrl` / `Shift` は**こちらだけ**動かす(中央は開き直さない)。
   * ⚠ 並びは**押した順**(範囲選択は表示順で足す)。
   */
  selection: readonly string[];
  /** 範囲選択(`Shift`)の起点。⚠ 押すたびに更新する ── 起点が古いと範囲が飛ぶ。 */
  selectionAnchor: string | null;
  /** 直近 CREATE_ENTRY で作られ、まだ一度も commit / rename されていない lid。
   *  「未編集のまま cancel」で掃除する(PKC2 の空 entry 堆積の対策 ── P3-7a)。 */
  freshLid: string | null;
  viewMode: ViewMode;
  /** calendar の表示月(null = 今日の月を renderer 側で解決)。 */
  calendarMonth: { year: number; month: number } | null;
  /** calendar で archived todo を見せるか(PKC2 の showArchived と同じ意味論)。 */
  showArchived: boolean;
  /** 選択 entry の履歴 panel(P5b)。開いた時点のスナップショット ── 選択遷移 /
   *  編集開始 / view 切替で畳む。boot で revisions に触れない原則の受け皿。 */
  revisionPanel: { lid: string; items: readonly RevisionItem[] } | null;
  /** ゴミ箱 panel(filer)。開いた時点のスナップショット + 明示更新。 */
  trashPanel: { items: readonly TrashItem[] } | null;
  /**
   * 🔴 **OS から開いた元ファイルとの紐づけ**(lid → ファイル名。2026-08-05、
   * user 報告「スポットの編集プレビュー導線も存在しない」)。
   *
   * ⚠ ここに置くのは**見せる材料(名前)だけ** ── `FileSystemFileHandle` 本体は
   * 不透明で比較も複製もできないので、純粋な reducer に入れない
   * (実体は `adapter/platform/launched-files.ts` が**このセッションだけ**持つ)。
   * ⚠ 読み直しで消える(handle が死ぬので、名前だけ残すと**嘘の導線**になる)。
   */
  linkedFiles: ReadonlyMap<string, string>;
  /**
   * 一覧の絞り込み(P7b 段⑨c、user 指示「導線を再考」)。
   * ⚠ **state に持つ**(renderer が DOM から読まない、という規約)── 入力欄の
   * 値を renderer が拾いに行くと、再描画のたびに「画面と state のどちらが正か」
   * が曖昧になる。
   */
  filterQuery: string;
  /**
   * 🔴 **本文が当たった lid**(#181 全文検索)。⚠ `null` = **まだ返っていない**
   * であって「0 件」ではない ── 打った直後は題名の結果だけが出て、SQL が返ると
   * **増える**(減る向きに倒すと、打鍵のたびに行が消えてちらつく)。
   * ⚠ 本文は常駐していないので、当たりは SQL 側からしか来ない。
   */
  searchHits: ReadonlySet<string> | null;
  /**
   * 🔴 **選択の履歴**(#190)。⚠ ブラウザの履歴は使わない ── PKC3 は単一ページで、
   * 戻るは**アプリ内の選択**の話である(URL を汚さない = 不可侵「クエリパラメータを
   * 抜け穴にしない」と同じ向き)。
   * ⚠ 積むのは `reduce` の**外側 1 か所**(下の `reduce`)── 選択を動かす case は
   * 6 つあり、case ごとに書くと必ず取りこぼす(§7「同じ判定が複数の場所にある」)。
   */
  selectionHistory: SelectionHistory;
  /**
   * 一覧の並び順(#183)。⚠ 既定は `manual` = **手で並べ替えた順**
   * (`entry_order`)── 手動の導線を置き換えない。
   */
  entrySort: EntrySort;
  /**
   * `searchHits` が**どの問い合わせの結果か**。⚠ これが無いと、遅れて返った
   * 古い結果を新しい問い合わせの答えとして表示してしまう(打鍵は結果より速い)。
   */
  searchHitsQuery: string;
  /**
   * 🔴 **集計の面**(#184)。⚠ どれも `null` = **まだ読んでいない**(0 件ではない)。
   *
   * ⚠ 中身は**束ねた結果だけ**で、本文は 1 バイトも入らない ── 束ねるのは worker で、
   * 主スレッドへ来るのは「値 → lid の並び」だけである(題名は `entryMetas` に在る)。
   * ⚠ 束ねる key(`queryKey`)は**端末の設定**として覚える(ペインの開閉と同じ流儀)──
   * container には書かない。「どの列で見ていたか」は文書の性質ではなく作業の都合である。
   */
  queryKey: string | null;
  queryKeys: QueryKeys | null;
  queryGroups: QueryGroups | null;
  /**
   * 🔴 **数えられなかった**(レビュー B-5)。⚠ `queryKeys === null` は「まだ」で
   * あって「駄目だった」ではない ── 区別しないと、面が「数えています…」を出したまま
   * **永久に止まって見える**(古い worker が残っている端末で実際に起きる)。
   */
  queryFailed: boolean;
  /**
   * ランチャーのタイル(P7b 段⑩)。⚠ `null` = **まだ読んでいない**。
   * 元データは attachment の frontmatter で**常駐していない**ので、
   * ランチャーを開いたときに要求して還流させる(履歴一覧と同じ流儀)。
   */
  launcherTiles: LauncherTile[] | null;
  /**
   * 🔴 **本文を書き換える経路のロック**(P8 段⑧。user 指示 2026-08-03
   * 「**編集競合は競合ロックと強制解放も念頭にしてください**」)。
   *
   * 追記は編集画面を通らず**直に disk へ書く**。だから編集の draft と 2 本の
   * 経路が同じ本文を握る ── ロックが無いと、こう消える:
   *
   * ```
   * 追記を押す → 書込が飛ぶ(まだ ack 前)→ すかさず「編集」を押す
   *   → editor は**古い body** を掴む → 追記が disk に着く
   *   → 保存 → 古い body が上書き → **追記が黙って消える**
   * ```
   *
   * ⚠ 窓は数十 ms しかないが、PKC2 はこの桁の窓で実際にデータを失っている。
   *
   * 🔑 **ここに持つのは「書込が飛んでいる」だけ**。「編集中」は `phase` が既に
   * 表しているので、**2 つ目の真実を作らない**(2 か所に持つと必ずずれる ──
   * `phase` を 'ready' へ戻す経路は 7 か所あり、その全部で外し忘れが起きうる)。
   * 両方をまとめて見たいときは `bodyLockOf(state)` を使う。
   */
  writeLock: { lid: string } | null;
  /**
   * タイル設定の書込が飛んでいる数(P8 段⑯)。
   *
   * 🔴 `writeLock` を借りると、**連続した設定変更が無言で落ちる**(登録 →
   * グループ → 目印 を続けて触ると 2 件目以降が拒否される ── smoke が実際に
   * 落ちた)。タイルの書込どうしは disk を読み直してから書き戻すので**互いに
   * 安全**で、危ないのは**編集との交錯**だけ ── だから数えるだけにして、
   * 止めるのは `START_EDIT` に限る。
   */
  tileWrite: { lid: string; n: number } | null;
  /**
   * ロックの世代。**強制解放のたびに増える**(P8 段⑧)。
   * ⚠ これが無いと強制解放は**危険な操作になる** ── 解放したあとに古い書込の
   * ack が着いて、user が見ている本文を巻き戻す。世代の合わない ack は捨てる。
   */
  lockGen: number;
  error: string | null;
}

/** 誰が本文を握っているか。⚠ **lid つき**(別のノートは巻き添えにしない)。 */
export interface BodyLock {
  lid: string;
  /** `editing` = 編集中の draft がある / `writing` = 追記の書込が飛んでいる。 */
  holder: 'editing' | 'writing';
}

/**
 * いま本文を握っているのは誰か(**導出** ── state に 2 つ目の真実を作らない)。
 * ⚠ 書込のほうを先に見る:書込中に編集へ入ることはできないので、両方立つことは
 * 無いが、順序を決めておかないと将来の変更で曖昧になる。
 */
export function bodyLockOf(state: AppState): BodyLock | null {
  if (state.writeLock) return { lid: state.writeLock.lid, holder: 'writing' };
  // ⚠ タイル設定の書込中も**書込中**として見せる(編集に入れないので、
  //    理由が画面に出ないと「押しても何も起きない」になる)
  if (state.tileWrite) return { lid: state.tileWrite.lid, holder: 'writing' };
  if (state.phase === 'editing' && state.openBody)
    return { lid: state.openBody.lid, holder: 'editing' };
  return null;
}

export const initialState: AppState = {
  phase: 'initializing',
  cid: null,
  entryMetas: new Map(),
  order: [],
  relations: [],
  openBody: null,
  selectedLid: null,
  scopeLid: null,
  selection: [],
  selectionAnchor: null,
  freshLid: null,
  viewMode: 'detail',
  filterQuery: '',
  searchHits: null,
  selectionHistory: EMPTY_HISTORY,
  entrySort: DEFAULT_ENTRY_SORT,
  searchHitsQuery: '',
  queryKey: null,
  queryKeys: null,
  queryGroups: null,
  queryFailed: false,
  launcherTiles: null,
  calendarMonth: null,
  showArchived: false,
  revisionPanel: null,
  trashPanel: null,
  linkedFiles: new Map(),
  writeLock: null,
  tileWrite: null,
  lockGen: 0,
  error: null,
};

export type UserAction =
  | { type: 'SELECT_ENTRY'; lid: string }
  | { type: 'SET_VIEW_MODE'; mode: ViewMode }
  | { type: 'SET_ENTRY_FILTER'; query: string }
  /** 本文の当たりが SQL から返った(#181)。⚠ `query` は**どの問い合わせの答えか**。 */
  | { type: 'SET_SEARCH_HITS'; query: string; lids: string[] }
  /** 一覧の並び順を変える(#183)。⚠ 選択は消さない(絞り込みと同じ規約)。 */
  | { type: 'SET_ENTRY_SORT'; sort: EntrySort }
  /**
   * 集計の束ね方を選ぶ(#184)。`null` = まだ選んでいない。
   * ⚠ 選び直しは**必ず問い合わせ直す** ── 前の key の表を残すと、
   * 見出しだけ変わって中身が古いままの表になる。
   */
  | { type: 'SET_QUERY_KEY'; key: string | null }
  /**
   * 集計が返った(#184)。目録と表が **1 回の走査**で同時に届く。
   * ⚠ `key` は**どの束ね方の答えか** ── 検索の `SET_SEARCH_HITS` と同じ理由
   * (遅れて返った古い結果を捨てる)。
   */
  | { type: 'SET_QUERY_SCAN'; key: string | null; keys: QueryKeys; groups: QueryGroups | null }
  /** 集計が引けなかった(#184)。⚠ 「まだ」と区別する ── 出す文言が違う。 */
  | { type: 'QUERY_FAILED' }
  /**
   * 数え直す(#184)。⚠ **`SET_VIEW_MODE` を借りない** ── 借りると
   * `revisionPanel` / `trashPanel` が畳まれ、**ゴミ箱を開いたまま数え直すと
   * 理由なく閉じる**(P8 段⑤ で「アプリ」タブが同じ形の事故を起こしている)。
   */
  | { type: 'REFRESH_QUERY' }
  /**
   * 選択の履歴を戻る・進む(#190)。⚠ **行き先は state が持つ** ── 呼び側が lid を
   * 決めると、履歴と選択が二重帳簿になる(§7)。
   */
  | { type: 'NAV_HISTORY'; dir: 'back' | 'forward' }
  /** 本文の置換(#191)。⚠ 素の文字列で当てる(正規表現にしない)。 */
  | { type: 'REPLACE_IN_BODY'; find: string; replace: string; caseSensitive?: boolean }
  /**
   * 🔴 **関係を作る**(#185)。⚠ **居場所(structural)はここから作らせない** ──
   * あちらはファイラの移動が作るので、作り方が 2 つになる(§7)。
   * ⚠ id は呼び側が採る(reducer は純関数 ── 乱数を持たない)。
   */
  | { type: 'ADD_RELATION'; id: string; fromLid: string; toLid: string; kind: RelationKind }
  /** 関係を消す(#185)。⚠ **id で消す**(同じ組が複数あっても迷わない)。 */
  | { type: 'REMOVE_RELATION'; id: string }
  | { type: 'LAUNCHER_TILES_LOADED'; tiles: LauncherTile[] }
  /**
   * アプリの一覧を読み直す(P8 段⑱)。
   *
   * 🔴 かつては「アプリ」タブで `SET_VIEW_MODE 'launcher'` を撃っていたが、
   * **中央の面を変える必要が無いのに view を借りていた**ので、タブを切り替えた
   * だけで**中央下の追記欄が消えて**いた(他の 2 タブでは残る)。
   * 探し方(左の列)と見る場所(中央)は別の軸である。
   */
  | { type: 'REFRESH_LAUNCHER_TILES' }
  /**
   * タイル設定を書き戻した ack(P8 段⑭)。⚠ **開いている body も差し替える**。
   * ⚠ `body === null` は失敗(書けなかった)── **ロックは必ず解く**。
   */
  | { type: 'APP_TILE_SAVED'; lid: string; gen: number; body: string | null }
  | { type: 'START_EDIT' }
  | { type: 'UPDATE_OPEN_BODY'; body: string }
  | { type: 'COMMIT_EDIT' }
  | { type: 'CANCEL_EDIT' }
  | { type: 'TOGGLE_TODO_STATUS'; lid: string }
  /**
   * 🔑 **追記**(P8 段⑧)。編集画面を開かずに末尾へ足す。
   * ⚠ `heading` は binder が作って渡す(reducer は純粋のまま ── `Date` を呼ばない)。
   * ノートは `null`(見出しを勝手に足さない)。
   */
  | { type: 'APPEND_TO_ENTRY'; lid: string; text: string; heading: string | null }
  /**
   * ランチャーのタイル設定(P8 段⑭)。
   *
   * 🔴 これは「新機能」ではなく**到達不能の解消**である ── タイルの元データは
   * 添付の frontmatter に在るのに、**PKC3 の中から書く手段が 1 つも無かった**
   * (PKC2 で登録したものを読むだけ)。PKC3 だけを使う user は、HTML を
   * 添付してもタイルにできない。
   *
   * ⚠ `undefined` = **触らない**、`null` = **消す**(frontmatter の行ごと)。
   * 3 値にしないと「グループを外す」が表せない。
   */
  | {
      type: 'SET_APP_TILE';
      lid: string;
      registered?: boolean;
      group?: string | null;
      icon?: string | null;
    }
  /**
   * 🔴 **ロックの強制解放**(user 指示 2026-08-03)。応答が返らない書込 /
   * 抱えたままの draft で**永久に追記できなくなる**のを防ぐ最後の出口。
   * ⚠ `discardDraft` = 編集中の draft も捨てる(編集が握っているときの解放)。
   */
  /**
   * 🔴 **Office の窓で上書き保存された**(#205)。添付の bytes は既に put 済みで、
   * ここから先は「ノートの frontmatter を差し替え、旧版を台帳へ積み、本文の
   * `asset:` 参照を書き換える」だけである(純関数 `planSaveBack` が計画を立てる)。
   *
   * ⚠ **`ready` でなければ何も起きない**(黙って捨てる)。呼び側は
   * `office-save-back.ts` で、**棚から消さずに後で撃ち直す** ── ここで捨てても
   * user の文書は失われない。⚠ この対で成り立っているので、片方だけ変えない。
   */
  | {
      type: 'OFFICE_ASSET_SAVED';
      lid: string;
      newKey: string;
      newHash: string | null;
      newBytes: number;
      /** ISO 8601。⚠ **呼び側が渡す**(reducer は時計を持たない)。 */
      savedAt: string;
    }
  /**
   * 開いている本文が **disk 側で差し替わった**(#205 の書き戻し)。
   * ⚠ `APP_TILE_SAVED` と同じ意味論だが、**あちらはタイルのロックを 1 つ減らす** ──
   * 流用すると計数が狂って「二度と設定を変えられない」になる(P8 段⑯ の H-1)。
   */
  | { type: 'ENTRY_BODY_REFRESHED'; lid: string; body: string }
  | { type: 'FORCE_RELEASE_LOCK'; discardDraft: boolean }
  | { type: 'SET_CALENDAR_MONTH'; year: number; month: number }
  | { type: 'TOGGLE_SHOW_ARCHIVED' }
  | { type: 'RETRY_PERSIST' }
  /** lid / title は binder が生成して渡す(reducer は純粋のまま ── Date を呼ばない)。
   *  body 省略時は flavor seed。edit:false は「作って選択するだけ」(添付取込等 ──
   *  editor に入らず freshLid も立てない)。 */
  | {
      type: 'CREATE_ENTRY';
      archetype: string;
      lid: string;
      title: string;
      body?: string;
      edit?: boolean;
      /** 入れ先の folder(2026-08-05)。省略 / null = ルート。
       *  ⚠ `relationId` も一緒に渡す ── 片方だけでは辺を作れない。 */
      parentLid?: string | null;
      relationId?: string;
    }
  | { type: 'DESELECT_ENTRY' }
  /**
   * 現在地を動かす(#240 段①)。`lid: null` = ルートへ。
   * ⚠ **選択は動かさない** ── 中央に開いているノートはそのまま(入っただけで
   * 本文が閉じると、フォルダを辿る間じゅう本文が消える)。
   */
  | { type: 'SET_SCOPE'; lid: string | null }
  /**
   * 印の付け外し(`Ctrl` / `Cmd` クリック。#240 段②)。
   * ⚠ **開いているノートは動かさない** ── 動かすと `Ctrl` クリックのたびに
   * 中央が開き直り、`REQUEST_BODY` が n 回飛ぶ。
   */
  | { type: 'TOGGLE_SELECT'; lid: string }
  /**
   * 起点から押した行までを**表示順で**印にする(`Shift` クリック。#240 段②)。
   * ⚠ 表示順は `filerRows` 1 か所が決める ── データの順で採ると、
   * 目で見た範囲と違うものが選ばれる。
   */
  | { type: 'SELECT_RANGE'; lid: string }
  /** 印を全部外す。 */
  | { type: 'CLEAR_SELECTION' }
  /**
   * 🔴 **まとめてゴミ箱へ**(#240 段③。user 指示 2026-08-17「まとめて消せない」)。
   * ⚠ **1 回の操作**として扱う ── `DELETE_ENTRY` を n 回撃つと、途中で断られたときに
   * 「半分だけ消えた」が作れる。⚠ 完全削除(`purge`)は一括で撃たせない。
   */
  | { type: 'DELETE_ENTRIES'; lids: readonly string[] }
  | { type: 'DELETE_ENTRY'; lid: string }
  | { type: 'RENAME_ENTRY_TITLE'; lid: string; title: string }
  /**
   * 🔴 **居場所を変える**(2026-08-05。フォルダ整理)。
   * `parentLid: null` = ルートへ出す。⚠ 「外す」と「入れる」を 2 つに割らない ──
   * 割ると途中で落ちたときに親無しが残る(PKC2 がその形だった)。
   */
  | { type: 'SET_ENTRY_PARENT'; lid: string; parentLid: string | null; relationId: string }
  /** 同じ親の下で隣と入れ替える(2026-08-06。user 報告 2-10)。 */
  | { type: 'MOVE_ENTRY_ORDER'; lid: string; direction: 'up' | 'down' }
  | { type: 'SHOW_HISTORY' }
  | { type: 'HIDE_HISTORY' }
  | { type: 'RESTORE_REVISION'; revId: string }
  | { type: 'SHOW_TRASH' }
  | { type: 'HIDE_TRASH' }
  | { type: 'RESTORE_TRASH'; entryLid: string; revId: string }
  | { type: 'PURGE_TRASH' };

export type SystemCommand =
  | { type: 'SYS_BOOTED'; cid: string; metas: EntryMeta[]; relations: Relation[] }
  | { type: 'BODY_LOADED'; lid: string; body: string }
  | { type: 'BODY_LOAD_FAILED'; lid: string; error: string }
  | { type: 'BODY_PERSISTED'; lid: string; body: string }
  /**
   * 🔑 **DB が刻んだ時刻が届いた**(P9 段①)。書込のたびに worker が返す。
   *
   * ⚠ 主スレッドで時刻を作らないための専用の入口 ── これが無いと
   * 作成・更新は**次の boot まで `null`** で、情報列が終日「—」になる(実際にそうだった)。
   * ⚠ 書込経路は 6 つある(commit / 追記 / トグル / 復元 / ゴミ箱戻し / タイル設定)。
   * 各経路の action へ相乗りさせず**1 つの action に寄せる** ── 相乗りだと
   * 経路を足した人が時刻を落とし、そこだけ「—」に戻る
   */
  | { type: 'ENTRY_STAMPED'; lid: string; createdAt: string | null; updatedAt: string | null }
  | {
      type: 'TODO_TOGGLED';
      lid: string;
      body: string;
      status: string | null;
      date: string | null;
      archived: boolean;
    }
  | {
      /** 非致命の op 失敗(toggle 等)。通知のみで phase は落とさない ──
       *  再操作が retry になる。fatal(SYS_ERROR)と混ぜない(P3-6b review #1)。 */
      type: 'OP_FAILED';
      error: string;
    }
  | { type: 'SYS_ERROR'; error: string }
  | { type: 'REVISION_LIST_LOADED'; lid: string; items: RevisionItem[] }
  | { type: 'TRASH_LIST_LOADED'; items: TrashItem[] }
  /**
   * 🔴 **OS から開いた md が entry になった**(2026-08-05)。handle 本体は
   * platform 側が持ち、ここへ来るのは**見せる名前**だけ。
   */
  | { type: 'FILE_LINKED'; lid: string; name: string }
  | {
      /** 復元完了(履歴 / ゴミ箱共通)。meta は effect が抽出済みの行から組む。
       *  mode は着弾時の整合判定に使う: revision = entry が居るのが前提(削除
       *  されていたら破棄)、trash = 居ないのが前提(二重復元の後着は破棄)。 */
      type: 'ENTRY_RESTORED';
      mode: 'revision' | 'trash';
      meta: EntryMeta;
      body: string;
      /**
       * 🔴 **その entry に触る関係**(2026-08-06。user 報告 2-9)。ゴミ箱からの復元で
       * **居場所(フォルダ)を戻す**のに要る ── `deleteEntry` は disk の relations を
       * 消さないが、常駐の `state.relations` からは落ちているので、
       * ここで戻さないと「戻したのにフォルダの外に出ている」になる。
       * ⚠ 履歴復元(`mode: 'revision'`)では entry が消えていないので不要(省略可)。
       */
      relations?: readonly Relation[];
    }
  | { type: 'TRASH_PURGED'; purged: number }
  | {
      /**
       * 追記が disk に着いた(P8 段⑧)。⚠ **`gen` を必ず見る** ── 強制解放を
       * 挟んだあとの遅れた ack を採ると、user が見ている本文を巻き戻す。
       */
      type: 'ENTRY_APPENDED';
      lid: string;
      gen: number;
      body: string;
      status: string | null;
      date: string | null;
      archived: boolean;
    }
  | {
      /** 追記が失敗した。⚠ **ロックは必ず解く**(失敗で握ったままにしない)。 */
      type: 'APPEND_FAILED';
      lid: string;
      gen: number;
      error: string;
    };

export type Dispatchable = UserAction | SystemCommand;

/**
 * effect 層が購読する副作用要求。entry の書込は PERSIST_ENTRY(= openBody 由来)だけ。
 * PERSIST_ENTRY は**行全体(抽出列込み)を reduce 時点で確定**して運ぶ ──
 * effect 層が実行時に getState() で meta を解決する時間差窓(review C-1)を
 * 構造的に無くし、抽出(FlavorSpec.extract)を唯一の経路にする(review K)。
 */
export type DomainEvent =
  | { type: 'REQUEST_BODY'; lid: string }
  /**
   * 本文の全文検索を頼む(#181)。⚠ 本文は常駐していないので **SQL 側の仕事**。
   * 空文字は「絞り込み無し」── 受け手は問い合わせずに黙って終える。
   */
  | { type: 'REQUEST_SEARCH'; query: string }
  /**
   * 集計を頼む(#184)。⚠ 検索と同じ理由で **SQL 側の仕事** ── 本文は常駐していない。
   * ⚠ **目録と表を 1 回の走査で頼む**(`key` が `null` なら目録だけ)── 別々に
   * 頼むと DB の全件走査が 2 回走る(レビュー B-3)。
   */
  | { type: 'REQUEST_QUERY_SCAN'; key: string | null }
  /** ⚠ **どれを読むかを載せる** ── effect 層は実行時に state を見ない(review L-6)。 */
  | {
      type: 'REQUEST_TILE_UPDATE';
      lid: string;
      /** ⚠ 強制解放をまたいだ ack を捨てるための世代(追記と同じ)。 */
      gen: number;
      updates: Record<string, string | boolean | undefined>;
      /** ⚠ 書き戻すのに要る素性。**effect 層は state を見ない**ので event が運ぶ。 */
      title: string;
      archetype: string;
      entryOrder: number;
      /** 書き換えた後にタイルを読み直すための材料(同上)。 */
      entries: Array<{ lid: string; title: string }>;
    }
  /**
   * 🔴 **添付の実体を差し替える**(#205)。計画は `planSaveBack`(純関数)が立てる。
   *
   * ⚠ **全ノートの素性を運ぶ。** 参照(`asset:`)は**どのノートにも書ける**ので、
   * 書き換え先は 1 件に閉じない ── そして effect 層は実行時に state を見ない
   * (この file 冒頭の宣言)ので、event が持って行くしかない。
   * ⚠ 本文は運ばない(常駐していない)── effect が `listBodies` で読む。
   */
  | {
      type: 'REQUEST_ASSET_REPLACE';
      targetLid: string;
      newKey: string;
      newHash: string | null;
      newBytes: number;
      savedAt: string;
      entries: Array<{ lid: string; title: string; archetype: string; entryOrder: number }>;
    }
  | {
      type: 'REQUEST_LAUNCHER_TILES';
      entries: Array<{ lid: string; title: string }>;
    }
  | {
      /** 居場所の永続化。⚠ 判定(循環・folder か)は reduce で済んでいる。 */
      type: 'REQUEST_SET_PARENT';
      lid: string;
      parentLid: string | null;
      relationId: string;
    }
  | {
      type: 'PERSIST_ENTRY';
      entry: EntryUpsert;
      /** true = 変更前の disk body を履歴に 1 件積む(P5c: 鎖の維持は worker)。 */
      checkpoint?: boolean;
    }
  | {
      /** かんばんトグル要求。meta snapshot は発火時(reduce)に捕獲(C-1 規律)。 */
      type: 'REQUEST_TODO_TOGGLE';
      lid: string;
      title: string;
      entryOrder: number;
      nextStatus: 'open' | 'done';
    }
  | {
      /**
       * 追記要求(P8 段⑧)。⚠ **本文は載せない** ── effect が disk から読み直して
       * その末尾に足す。載せると「画面が持っている古い本文」を基底にしてしまい、
       * 別経路の書込(toggle / 復元)を巻き戻す。meta snapshot は発火時捕獲(C-1)。
       */
      type: 'REQUEST_APPEND';
      lid: string;
      gen: number;
      title: string;
      archetype: string;
      entryOrder: number;
      heading: string | null;
      text: string;
    }
  | { type: 'REQUEST_DELETE'; lid: string }
  | {
      /** title 書換の永続化要求(body は effect が disk から読む)。snapshot は
       *  発火時捕獲(C-1 規律)。title は新値。 */
      type: 'REQUEST_RENAME';
      lid: string;
      title: string;
      archetype: string;
      entryOrder: number;
    }
  | {
      /**
       * 並べ替えの永続化(2026-08-06。user 報告 2-10)。⚠ **本文は載せない** ──
       * `REQUEST_RENAME` と同じで effect が disk から読み直す(画面の古い本文を
       * 基底にすると別経路の書込を巻き戻す)。動かすのは常に **2 件以下**。
       */
      type: 'REQUEST_REORDER';
      entries: Array<{ lid: string; title: string; archetype: string; entryOrder: number }>;
    }
  /** 関係の永続化(#185)。⚠ 1 件ずつ ── 作る操作も消す操作も 1 度に 1 つである。 */
  | { type: 'REQUEST_RELATION_UPSERT'; id: string; fromLid: string; toLid: string; kind: string }
  | { type: 'REQUEST_RELATION_DELETE'; id: string }
  | { type: 'REQUEST_REVISION_LIST'; lid: string }
  | {
      /** 履歴からの復元(前進変異): effect が「現状を addRevision → revision
       *  内容で persist」の順に行う。meta snapshot は発火時捕獲。 */
      type: 'REQUEST_RESTORE';
      lid: string;
      revId: string;
      title: string;
      archetype: string;
      entryOrder: number;
    }
  | { type: 'REQUEST_TRASH_LIST' }
  | {
      /** ゴミ箱からの復元(entry 再作成)。entryOrder は reduce 時に採番。 */
      type: 'REQUEST_TRASH_RESTORE';
      entryLid: string;
      revId: string;
      entryOrder: number;
    }
  | { type: 'REQUEST_TRASH_PURGE' };

export interface ReduceResult {
  state: AppState;
  events: DomainEvent[];
}

/**
 * 🔴 **選択の履歴は、reducer の外側 1 か所で積む**(#190)。
 *
 * 選択(`selectedLid`)を動かす case は 6 つある ── `SELECT_ENTRY` / `SYS_BOOTED` の
 * 引き継ぎ / `CREATE_ENTRY` / `ENTRY_RESTORED` / 削除の後継 / `DESELECT_ENTRY`。
 * case ごとに `pushSelection` を書くと、**次に選択を動かす case を足した人が必ず
 * 忘れる**(§7「同じ判定が複数の場所にある」の典型)。だから
 * **「動いた結果」を 1 か所で見る**形にした ── 新しい case は自動で乗る。
 *
 * ⚠ 戻る・進む自身は積まない(積むと戻れなくなる)。
 * ⚠ entry が消えた回は履歴も掃除する ── 残すと「戻る」が居ないノートへ飛ぶ。
 */
export function reduce(state: AppState, action: Dispatchable): ReduceResult {
  if (action.type === 'NAV_HISTORY') return navHistory(state, action.dir);
  const result = reduceCore(state, action);
  let history = result.state.selectionHistory;
  // ⚠ 掃除は entryMetas が**変わった回だけ**(毎回やると 50 件の走査が無駄に回る)
  if (result.state.entryMetas !== state.entryMetas)
    history = pruneHistory(history, (lid) => result.state.entryMetas.has(lid));
  if (result.state.selectedLid !== null && result.state.selectedLid !== state.selectedLid)
    history = pushSelection(history, result.state.selectedLid);
  return history === result.state.selectionHistory
    ? result
    : { state: { ...result.state, selectionHistory: history }, events: result.events };
}

/**
 * 戻る・進む。⚠ **行き先の採否は `SELECT_ENTRY` に決めさせる** ── 編集中は動かない /
 * 居ない lid は選ばない、という規則をここに書き写すと二重帳簿になる(§7)。
 * 🔑 だから「選択が実際に動いたか」を見て、動いたときだけ履歴を確定させる。
 */
function navHistory(state: AppState, dir: 'back' | 'forward'): ReduceResult {
  const moved = dir === 'back' ? goBack(state.selectionHistory) : goForward(state.selectionHistory);
  if (moved === state.selectionHistory) return { state, events: [] };
  const target = historyCurrent(moved);
  if (target === null || target === state.selectedLid) return { state, events: [] };
  const result = reduceCore(state, { type: 'SELECT_ENTRY', lid: target });
  if (result.state.selectedLid !== target) return { state, events: [] }; // 断られた(編集中など)
  return { state: { ...result.state, selectionHistory: moved }, events: result.events };
}

/** 戻れるか(UI の活殺に使う)。 */
export function canNavBack(state: AppState): boolean {
  return canGoBack(state.selectionHistory);
}

/** 進めるか。 */
export function canNavForward(state: AppState): boolean {
  return canGoForward(state.selectionHistory);
}

/** ⚠ `NAV_HISTORY` は**型で除く** ── 上の wrapper が先に捌く。default 節を置いて
 * 逃がすと、新しい action を書き忘れても tsc が黙る。 */
function reduceCore(
  state: AppState,
  action: Exclude<Dispatchable, { type: 'NAV_HISTORY' }>,
): ReduceResult {
  switch (action.type) {
    case 'SYS_BOOTED': {
      const metas = new Map(action.metas.map((m) => [m.lid, m]));
      // entryOrder の tie は lid 辞書順で安定化(review P5b F3 ── trash 復元と
      // CREATE の並行採番は重複しうる。正準親の tie-break とも同じ規約)
      const order = [...action.metas]
        .sort((a, b) => a.entryOrder - b.entryOrder || a.lid.localeCompare(b.lid))
        .map((m) => m.lid);
      // 🔴 **同じ container への再読込なら選択を保つ**(2026-08-05、user 報告)。
      //
      // ここは元々「再 boot では旧選択・旧 openBody を持ち越さない」だった。
      // 意図は **container 切替**での lid 偶然衝突の防止(review F)で、それは正しい。
      // ただし取込は**同じ container の再読込**でもここを通る ── つまり
      // **md を 1 件開いただけで、いま読んでいたノートが画面から消えて**
      // 「左の一覧から選ぶと…」に戻っていた(実測)。
      //
      // ⚠ 保つ条件は 2 つとも要る:**cid が同じ**(別 container なら従来どおり捨てる)
      //    かつ **その lid が新しい一覧に在る**(消えたノートを選んだままにしない)。
      // ⚠ `openBody` は必ず捨てる ── 再読込で本文が変わっている可能性がある。
      //    代わりに `REQUEST_BODY` を出して**取り直す**(選択の意味論は SELECT_ENTRY と同じ)
      const keepLid =
        state.cid === action.cid && state.selectedLid !== null && metas.has(state.selectedLid)
          ? state.selectedLid
          : null;
      /**
       * 🔴 **現在地と印も同じ規則で検める**(#240 の着地前レビュー 1)。
       *
       * ⚠ `SYS_BOOTED` は**別タブが書くたび**に飛ぶ(`main.ts` の 300ms 束ね)。
       *    選択だけ検めて `scopeLid` を素通りさせると、**別タブがそのフォルダを
       *    消した瞬間**に「現在地は在るが実体は無い」状態になり、表は 0 行・
       *    パンくずはルートだけ ── **データが全部消えたように見える**。
       *    そこで「+ ノート」を押すと親が付かず、作ったものも画面に出ない。
       * ⚠ 印(`selection`)も同じ ── 消えた lid が残ると「N 件を選んでいます」の
       *    帯だけが出て、まとめて削除が**画面に無いものを消す**。
       * ⚠ 別 container(`cid` 違い)なら全部捨てる ── lid の偶然衝突を持ち越さない。
       */
      const sameCid = state.cid === action.cid;
      const keepScope =
        sameCid && state.scopeLid !== null && metas.has(state.scopeLid) ? state.scopeLid : null;
      const keepMarks = sameCid ? state.selection.filter((l) => metas.has(l)) : [];
      const keepAnchor =
        sameCid && state.selectionAnchor !== null && metas.has(state.selectionAnchor)
          ? state.selectionAnchor
          : null;
      return {
        state: {
          ...state,
          phase: 'ready',
          error: null,
          cid: action.cid,
          entryMetas: metas,
          order,
          relations: action.relations,
          selectedLid: keepLid,
          scopeLid: keepScope,
          selection: keepMarks,
          selectionAnchor: keepAnchor,
          openBody: null,
          freshLid: null,
          // ⚠ 元ファイルの紐づけは**このセッションの持ち物**なので、同じ container の
          //    再読込では保つ(取込のたびに消えると、開いた直後に書き戻せなくなる)。
          //    ⚠ ただし**消えた lid は落とす** ── 居ない entry を指す導線を残さない
          linkedFiles: keepLinks(state, action.cid, metas),
          /**
           * 🔴 **集計の数字は再読込で捨てる**(レビュー C-1)。⚠ 取込はここを通るので、
           * 残すと「N 件のノートを見ました」が**古い数**のまま出続ける。
           * ⚠ 捨てるだけでは「数えています…」で止まるので、**面を開いていれば
           * 数え直しも頼む**(捨てる側と頼む側は対で要る)。
           * ⚠ 束ね方(`queryKey`)は端末の設定なので**保つ**。
           */
          queryKeys: null,
          queryGroups: null,
          queryFailed: false,
        },
        events: [
          ...(keepLid === null
            ? []
            : [{ type: 'REQUEST_BODY' as const, lid: keepLid }]),
          ...(state.viewMode === 'query'
            ? [{ type: 'REQUEST_QUERY_SCAN' as const, key: state.queryKey }]
            : []),
        ],
      };
    }
    case 'SELECT_ENTRY': {
      if (state.phase === 'editing') return { state, events: [] }; // 編集中は選択遷移しない
      // error phase(= persist 失敗)でも遷移しない ── openBody の baseline が
      // 「disk 未達 commit の唯一の写し」であり、選択遷移は無警告破棄になる
      // (P3-6b review #2)。出口は 再保存(RETRY_PERSIST)
      if (state.phase === 'error') return { state, events: [] };
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      // 同一 lid でも openBody が確立していなければ再要求する
      // (読み失敗後の再クリックが自然な retry になる ── review C)
      // 🔴 **設定を開いたまま一覧を押したら、中央をノートへ戻す**(P8 段⑲)。
      //    直す前は右の情報ペインだけ切り替わり、中央は設定のまま・追記欄も
      //    消えたままで、ノートが開かない理由が画面のどこにも無かった
      //    (マニュアル「中央は常にいま開いているノート」の当の破れ)
      const leaveSettings = isAsidePane(state.viewMode);
      if (state.selectedLid === action.lid && state.openBody?.lid === action.lid) {
        /**
         * 🔴 **すでに開いている行を素で押したときも、印は 1 件へ戻す**(#240 段②)。
         *
         * ⚠ ここは「同じノートをもう一度押した」だけの早期 return だが、
         * **印(複数選択)はその外に在る** ── 直す前は 3 件に印を付けたあと、
         * そのうちの 1 件を素で押しても**印が 3 件のまま**だった(実ブラウザ smoke で
         * 判明。unit は「別の行を押す」筋しか通っていなかった)。
         * 🔑 修飾なしのクリックは「これだけを相手にする」の意味なので、
         *   どの行を押したかに関わらず印は 1 件になる。
         */
        const marks =
          state.selection.length === 1 && state.selection[0] === action.lid
            ? state
            : { ...state, selection: [action.lid], selectionAnchor: action.lid };
        return leaveSettings
          ? { state: { ...marks, viewMode: 'detail' as const }, events: [] }
          : { state: marks, events: [] };
      }
      // 選択が変わったら旧 openBody は破棄(速やかな破棄の原則)し、新 body を要求。
      // 通知エラー(読み失敗等)は新しい試行でクリア(エラーは state 駆動 ──
      // 表示寿命が「次の操作まで」で終わらない、P3-5 review #3 の解消)
      return {
        state: {
          ...state,
          ...(leaveSettings ? { viewMode: 'detail' as const } : {}),
          selectedLid: action.lid,
          /**
           * ⚠ **印は 1 件へ置き換える**(#240 段②)── 修飾なしのクリックは
           * 「これだけを相手にする」の意味。`Ctrl` / `Shift` は別の action で入る。
           */
          selection: [action.lid],
          selectionAnchor: action.lid,
          openBody: null,
          error: null,
          revisionPanel: null, // panel は選択に従属(P5b)
        },
        events: [{ type: 'REQUEST_BODY', lid: action.lid }],
      };
    }
    case 'BODY_LOADED': {
      // 編集中は受理しない ── 遅延到着の応答が入力中の body/baseline を
      // 巻き戻す事故の防止(review B)
      if (state.phase === 'editing') return { state, events: [] };
      // 応答が現選択と食い違う(遅延到着)なら捨てる ── stale 反映防止
      if (state.selectedLid !== action.lid) return { state, events: [] };
      return {
        state: {
          ...state,
          error: null, // 読めた = 直前の読み失敗通知は用済み
          openBody: {
            lid: action.lid,
            body: action.body,
            baseline: action.body,
            persisted: action.body,
            diskAhead: false,
          },
        },
        events: [],
      };
    }
    case 'BODY_LOAD_FAILED': {
      if (state.selectedLid !== action.lid) return { state, events: [] };
      // phase は落とさない(読み失敗はアプリ死ではない ── 再クリックが retry)。
      // エラーは state に持つ: 次の成功 / 選択までステータスに残る
      return {
        state: { ...state, error: `body load failed: ${action.error}` },
        events: [],
      };
    }
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
        state: { ...state, filterQuery: action.query, searchHits: null, searchHitsQuery: '' },
        events: [{ type: 'REQUEST_SEARCH', query: action.query }],
      };
    case 'SET_ENTRY_SORT':
      // ⚠ 選択は消さない ── 並び替えただけで開いているノートが変わると驚く
      if (state.entrySort === action.sort) return { state, events: [] };
      return { state: { ...state, entrySort: action.sort }, events: [] };
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
    case 'SET_SEARCH_HITS':
      // ⚠ **遅れて返った古い結果を捨てる**(打鍵は結果より速い)
      if (action.query !== state.filterQuery) return { state, events: [] };
      return {
        state: {
          ...state,
          searchHits: new Set(action.lids),
          searchHitsQuery: action.query,
        },
        events: [],
      };
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
      if (state.phase === 'editing' && !isAsidePane(action.mode)) return { state, events: [] };
      return {
        state: {
          ...state,
          viewMode: action.mode,
          revisionPanel: null,
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
        events:
          action.mode === 'launcher'
            ? [{ type: 'REQUEST_LAUNCHER_TILES', entries: attachmentEntries(state) }]
            : action.mode === 'query'
              ? [{ type: 'REQUEST_QUERY_SCAN', key: state.queryKey }]
              : [],
      };
    case 'REFRESH_LAUNCHER_TILES':
      // ⚠ **毎回要求する**。ただし前回のタイルは消さない(古い並びを出したまま
      //    読み直し、届いたら差し替える ── 「読み込んでいます…」を挟まない)
      return {
        state,
        events: [{ type: 'REQUEST_LAUNCHER_TILES', entries: attachmentEntries(state) }],
      };
    case 'LAUNCHER_TILES_LOADED':
      return { state: { ...state, launcherTiles: action.tiles }, events: [] };
    case 'APP_TILE_SAVED': {
      // 🔴 **世代が違う ack は本文に触らない**が、**ロックは必ず解く**
      //    (追記と同じ ── 握ったままにすると user は二度と設定を変えられない)
      const left = (state.tileWrite?.n ?? 1) - 1;
      const released: AppState = {
        ...state,
        tileWrite: left > 0 && state.tileWrite ? { ...state.tileWrite, n: left } : null,
      };
      // ⚠ 世代が違う ack は本文に触らないが、**数は必ず減らす**
      //    (減らさないと user は二度と設定を変えられず、しかも理由が分からない)
      if (action.gen !== state.lockGen) return { state: released, events: [] };
      // 失敗(書けなかった)── ロックだけ解いて本文は触らない
      if (action.body === null) return { state: released, events: [] };
      const ob = state.openBody;
      if (ob?.lid !== action.lid) return { state: released, events: [] };
      const body = action.body;
      if (state.phase === 'editing') {
        // 🔴 **draft は触らないが、disk が進んだ印は残す**(P8 段⑯。レビュー H-1)。
        //    かつては丸ごと捨てていたので、無変更 commit / cancel で**旧本文が
        //    disk を上書きし、書けたはずの設定が消えた**(実測で再現)。
        //    `TODO_TOGGLED` の editing 窓と同型に揃える ── 変更ありの commit は
        //    draft が勝ち(可視内容の last-write-wins)、無変更 commit / cancel は
        //    disk を採る
        return {
          state: { ...released, openBody: { ...ob, persisted: body, diskAhead: true } },
          events: [],
        };
      }
      return {
        state: {
          ...released,
          openBody: { lid: action.lid, body, baseline: body, persisted: body, diskAhead: false },
        },
        events: [],
      };
    }
    case 'OFFICE_ASSET_SAVED': {
      // 🔴 **`ready` でなければ何もしない。** ⚠ ただし**捨ててよいのは、呼び側が
      //    棚から消さずに撃ち直すから**である(`office-save-back.ts`)── その対を
      //    崩すと、編集中に届いた保存が消える
      if (state.phase !== 'ready') return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      // 消された / 添付でなくなったノートへは書かない(呼び側が新規作成へ倒す)
      if (!meta || meta.archetype !== 'attachment') return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_ASSET_REPLACE',
            targetLid: action.lid,
            newKey: action.newKey,
            newHash: action.newHash,
            newBytes: action.newBytes,
            savedAt: action.savedAt,
            // ⚠ **全ノート**を運ぶ ── 参照はどのノートにも書ける
            entries: state.order.flatMap((lid) => {
              const m = state.entryMetas.get(lid);
              return m
                ? [{ lid, title: m.title, archetype: m.archetype, entryOrder: m.entryOrder }]
                : [];
            }),
          },
        ],
      };
    }
    case 'ENTRY_BODY_REFRESHED': {
      const ob = state.openBody;
      if (ob?.lid !== action.lid) return { state, events: [] };
      // 🔴 **編集中の draft は触らない**(`APP_TILE_SAVED` と同じ ── 捨てると
      //    無変更 commit / cancel で旧本文が disk を上書きする)
      if (state.phase === 'editing') {
        return {
          state: { ...state, openBody: { ...ob, persisted: action.body, diskAhead: true } },
          events: [],
        };
      }
      return {
        state: {
          ...state,
          openBody: {
            lid: action.lid,
            body: action.body,
            baseline: action.body,
            persisted: action.body,
            diskAhead: false,
          },
        },
        events: [],
      };
    }
    case 'SET_APP_TILE': {
      // ⚠ 書込が飛んでいる間は触らせない(追記と同じ規律)── 読んで書き戻す
      //    操作なので、途中に別の書込が挟まると片方が消える
      // ⚠ 追記が飛んでいる間は触らない(あちらは本文を丸ごと書き戻す)
      if (state.phase !== 'ready' || state.writeLock) return { state, events: [] };
      // ⚠ **別のノートのタイル書込中も断る**(1 本しか数えていないので)
      if (state.tileWrite && state.tileWrite.lid !== action.lid) return { state, events: [] };
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      const updates: Record<string, string | boolean | undefined> = {};
      // ⚠ **false は書かない**(PKC2 と同じ)── 既定値を明示的に持つと、
      //    frontmatter が「登録していない」行で埋まる
      if (action.registered !== undefined)
        updates['attachment.registered_as_app'] = action.registered ? true : undefined;
      if (action.group !== undefined)
        updates['attachment.app_group'] =
          action.group === null || action.group === '' ? undefined : action.group;
      if (action.icon !== undefined)
        updates['attachment.app_icon'] =
          action.icon === null || action.icon === '' ? undefined : action.icon;
      if (Object.keys(updates).length === 0) return { state, events: [] };
      const meta = state.entryMetas.get(action.lid)!;
      return {
        // 🔴 **飛んでいる数を数える**(P8 段⑯。レビュー H-1/H-7)。これは
        //    **読んで書き戻す**操作なので、往復の窓に編集が割り込むと片方が消える。
        //    実測で再現: 登録にチェック → ack が返る前に編集して保存 → disk に
        //    着地した `registered_as_app: true` が旧本文の書き戻しで**黙って消えた**。
        //    ⚠ `writeLock` を借りると**連続した設定変更が無言で落ちる**(登録 →
        //    グループ → 目印 を続けて触ると 2 件目以降が拒否される。smoke が実際に
        //    落ちた)── タイルの書込どうしは disk を読み直すので互いに安全
        state: { ...state, tileWrite: { lid: action.lid, n: (state.tileWrite?.n ?? 0) + 1 } },
        events: [
          {
            type: 'REQUEST_TILE_UPDATE',
            lid: action.lid,
            gen: state.lockGen,
            updates,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            entries: attachmentEntries(state),
          },
        ],
      };
    }
    case 'START_EDIT': {
      // openBody が現選択の body を持っているときだけ編集に入れる
      // (= 未読 body の編集・保存が構造的に不可能)
      if (state.phase !== 'ready') return { state, events: [] };
      if (!state.openBody || state.openBody.lid !== state.selectedLid)
        return { state, events: [] };
      // 🔴 **追記の書込が飛んでいる間は編集に入れない**(P8 段⑧)。
      // 入れてしまうと editor が古い body を掴み、着弾した追記を保存で上書きする
      // ── これが「追記が黙って消える」の実体。
      // ⚠ ここは**backstop** ── 無言の拒否にならないよう、描画側は書込中
      // 「編集」を出さずにロックの帯(理由 + 強制解放)を出す(`detail.ts`)
      // ⚠ タイル設定の書込中も編集に入れない(交錯すると disk の設定が消える)
      if (state.tileWrite && state.tileWrite.lid === state.openBody.lid)
        return { state, events: [] };
      if (state.writeLock && state.writeLock.lid === state.openBody.lid)
        return { state, events: [] };
      // ⚠ 編集がロックを握ることは**書かない** ── `phase === 'editing'` が既に
      // それを表している(`bodyLockOf`)。ここで別の field に写すと 2 つ目の真実
      return { state: { ...state, phase: 'editing', revisionPanel: null }, events: [] };
    }
    /**
     * 🔴 **本文の置換**(#191)。⚠ 編集中だけ ── 読んでいるだけの面から本文を
     * 書き換えると、user が「編集していない」と思っている間に内容が変わる。
     * ⚠ **0 件のときも state を返す**(何も起きないのではなく「見つからなかった」と
     * 言う)── 押しても無反応な dead click を作らない。
     */
    case 'REPLACE_IN_BODY': {
      if (state.phase !== 'editing' || !state.openBody) return { state, events: [] };
      const { body, count } = replaceAll(state.openBody.body, action.find, action.replace, {
        caseSensitive: action.caseSensitive === true,
      });
      if (count === 0)
        return {
          state: { ...state, error: `「${action.find}」は本文に見つかりませんでした` },
          events: [],
        };
      return {
        state: { ...state, error: `${count} 件を置き換えました`, openBody: { ...state.openBody, body } },
        events: [],
      };
    }
    case 'UPDATE_OPEN_BODY': {
      if (state.phase !== 'editing' || !state.openBody) return { state, events: [] };
      return {
        state: { ...state, openBody: { ...state.openBody, body: action.body } },
        events: [],
      };
    }
    case 'COMMIT_EDIT': {
      if (state.phase !== 'editing' || !state.openBody) return { state, events: [] };
      const { lid, body, baseline, persisted } = state.openBody;
      // baseline := body(最終 commit 内容)。disk 確認は persisted が別に持つので
      // これは楽観確定ではない(review E は persisted の導入で解消)
      const { diskAhead } = state.openBody;
      const next: AppState = {
        ...state,
        phase: 'ready',
        freshLid: state.freshLid === lid ? null : state.freshLid,
        // 変更ありの commit は draft が正(可視内容の last-write-wins)── disk
        // 先行の印はここで畳む
        openBody: { lid, body, baseline: body, persisted, diskAhead: false },
      };
      // 変わっていないなら書かない(PKC2 #1024 の教訓を最初から)。
      // ローカル変更が無く disk が先行(編集中に toggle ack ── diskAhead)なら
      // **disk が勝つ** ── stale baseline を持ち越すと、後日の無関係な commit が
      // toggle を黙って巻き戻す(P3-6a review #4)
      if (body === baseline) {
        if (diskAhead) {
          return {
            state: {
              ...state,
              phase: 'ready',
              freshLid: state.freshLid === lid ? null : state.freshLid,
              openBody: {
                lid,
                body: persisted,
                baseline: persisted,
                persisted,
                diskAhead: false,
              },
            },
            events: [],
          };
        }
        return {
          state: { ...next, openBody: { ...next.openBody!, diskAhead: false } },
          events: [],
        };
      }
      const meta = state.entryMetas.get(lid);
      if (!meta) {
        // openBody は SELECT_ENTRY(存在検査済)経由でしか確立しない ── ここに
        // 来たら不変量違反。書かずに可視エラーで終える(黙って捨てない)
        return {
          state: { ...state, phase: 'ready', error: `commit: unknown entry ${lid}` },
          events: [],
        };
      }
      // 抽出はイベント発火時(= この reduce)に同期で行い、行全体を確定して運ぶ
      const { entryMetas, entry } = buildPersist(state, meta, body);
      // 変更前(baseline)を履歴に積むかどうか(P5c: 実際の記録は worker が
      // 同 tx で行う ── ここは「刻むか / 頭を張り替えるだけか」の意思決定)。
      // 新規作成の初回 commit は積まない ──「flavor seed へ戻す」だけの復元先は
      // ゴミ(PKC2 は無条件に積んで肥大した)。
      // ⚠ freshLid だけでは足りない(review P5b F4): rename が fresh を解除する
      // ため「作成 → title → 本文 → 保存」の普通の流れで seed revision が積まれる
      // ── baseline が flavor seed のままなら fresh 扱いで skip する
      const checkpoint =
        state.freshLid !== lid && baseline !== seedBodyFor(meta.archetype);
      return {
        state: { ...next, entryMetas },
        events: [{ type: 'PERSIST_ENTRY', entry, checkpoint }],
      };
    }
    case 'RETRY_PERSIST': {
      // persist 失敗(error phase)からの復帰: baseline(最後に commit した内容)が
      // disk(persisted)に未達なら、現 meta で行を組み直して再送する。
      // baseline ≠ persisted が「未達の証拠」── P3-5 で導入した分離の回収点
      if (state.phase !== 'error' || !state.openBody) return { state, events: [] };
      const { lid, baseline, persisted, diskAhead } = state.openBody;
      if (baseline === persisted || diskAhead) return { state, events: [] };
      const meta = state.entryMetas.get(lid);
      if (!meta) return { state, events: [] };
      const { entryMetas, entry } = buildPersist(state, meta, baseline);
      // 再送でも刻む意思は同じ(worker 側の hash skip が重複を防ぐので二重に
      // 積まれることはない ── 初回 persist が失敗していれば disk はまだ前の内容)
      const checkpoint =
        state.freshLid !== lid && persisted !== seedBodyFor(meta.archetype);
      return {
        state: {
          ...state,
          phase: 'ready',
          error: null,
          entryMetas,
          openBody: { lid, body: baseline, baseline, persisted, diskAhead: false },
        },
        events: [{ type: 'PERSIST_ENTRY', entry, checkpoint }],
      };
    }
    case 'CANCEL_EDIT': {
      if (state.phase !== 'editing' || !state.openBody) return { state, events: [] };
      const { lid, body, baseline, persisted, diskAhead } = state.openBody;
      // 新規作成直後の未編集 cancel は entry ごと掃除する ── PKC2 は掃除が無く
      // 「作成 → Esc」で既定 title の空 entry が堆積した(P3-7a)。draft を
      // 打ち込んでからの cancel は PKC2 同様 entry を残す(誤 Esc で消さない)
      if (state.freshLid === lid && body === baseline) {
        return removeEntryFromState(state, lid, [{ type: 'REQUEST_DELETE', lid }]);
      }
      // draft 破棄。disk 先行(diskAhead)なら disk を採用(review #4)。
      // 自 commit の ack 待ちで persisted が遅れているだけなら baseline が正。
      // fresh は非掃除分岐でも解除する ── draft を打った cancel は「残す意思」で
      // あり、後日の無変更 Esc が作業済み entry を消してはならない
      // (P3-7a review 中: toggle を跨いで freshLid が生き残る反例)
      const restored = diskAhead ? persisted : baseline;
      return {
        state: {
          ...state,
          phase: 'ready',
          freshLid: state.freshLid === lid ? null : state.freshLid,
          openBody: {
            lid,
            body: restored,
            baseline: restored,
            persisted,
            diskAhead: false,
          },
        },
        events: [],
      };
    }
    /**
     * 🔑 **追記**(P8 段⑧)。編集画面を開かず、末尾に足して**直に disk へ書く**。
     *
     * ⚠ **ready 限定 + ロック**。編集中(= draft がある)に裏で書くと、保存で
     * 上書きされて追記が消える。書込中の二重要求も断る(直列 queue には載るが、
     * 2 通目の基底が 1 通目の結果になるかは queue 実装に依存させない)。
     * ⚠ **本文を event に載せない** ── effect が disk から読み直す。画面が持つ
     * 本文を基底にすると、別経路(toggle / 復元)の書込を巻き戻す。
     */
    case 'APPEND_TO_ENTRY': {
      if (state.phase !== 'ready') return { state, events: [] };
      if (state.writeLock) return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      if (action.text.trim() === '') return { state, events: [] }; // 空の追記は作らない
      return {
        state: { ...state, writeLock: { lid: action.lid }, revisionPanel: null },
        events: [
          {
            type: 'REQUEST_APPEND',
            lid: meta.lid,
            gen: state.lockGen,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            heading: action.heading,
            text: action.text,
          },
        ],
      };
    }
    /**
     * 🔴 **強制解放**(user 指示 2026-08-03)。
     * ⚠ **世代を上げる**のが本体 ── 解放しただけだと、飛んでいる書込の ack が
     * 後から着いて user が見ている本文を巻き戻す。世代が変われば古い ack は捨てる。
     */
    case 'FORCE_RELEASE_LOCK': {
      const draft = action.discardDraft && state.phase === 'editing' && state.openBody;
      return {
        state: {
          ...state,
          writeLock: null,
          // ⚠ タイル設定の書込も一緒に畳む(片方だけ残ると編集に入れないままになる)
          tileWrite: null,
          lockGen: state.lockGen + 1,
          ...(draft
            ? {
                phase: 'ready' as const,
                // draft を捨てる = disk で確認できている内容へ戻す
                openBody: {
                  lid: state.openBody!.lid,
                  body: state.openBody!.persisted,
                  baseline: state.openBody!.persisted,
                  persisted: state.openBody!.persisted,
                  diskAhead: false,
                },
              }
            : {}),
        },
        events: [],
      };
    }
    /** 追記が disk に着いた。⚠ **世代の合わない ack は捨てる**(強制解放の後着)。 */
    case 'ENTRY_APPENDED': {
      if (action.gen !== state.lockGen) return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      // 再 boot 済み(entry が消えた)でも**ロックは必ず解く**
      if (!meta) return { state: { ...state, writeLock: null }, events: [] };
      const entryMetas = new Map(state.entryMetas).set(action.lid, {
        ...meta,
        status: action.status,
        date: action.date,
        archived: action.archived,
      });
      // ⚠ 追記は ready 限定なので、openBody は丸ごと差し替えて安全
      // (editing 中は APPEND_TO_ENTRY 自体が通らない)
      const openBody =
        state.openBody?.lid === action.lid
          ? {
              lid: action.lid,
              body: action.body,
              baseline: action.body,
              persisted: action.body,
              diskAhead: false,
            }
          : state.openBody;
      return {
        state: { ...state, entryMetas, openBody, writeLock: null },
        events: [],
      };
    }
    case 'APPEND_FAILED': {
      // ⚠ 世代が違っても**ロックは解く** ── 「古い ack だから無視」で握ったままに
      // すると、user は永久に追記できず、しかも理由が分からない。
      // 巻き戻しの危険があるのは**本文を採る**ときだけで、解放は常に安全
      if (action.gen !== state.lockGen) return { state, events: [] };
      // 失敗は非致命。理由は effect が OP_FAILED で別に出す(phase は落とさない)
      return { state: { ...state, writeLock: null, error: action.error }, events: [] };
    }
    case 'TOGGLE_TODO_STATUS': {
      // ready 限定(editing 中の裏書換を作らない)。todo 以外・未知 lid は no-op
      if (state.phase !== 'ready') return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta || meta.archetype !== 'todo') return { state, events: [] };
      const nextStatus = meta.status === 'done' ? 'open' : 'done';
      // state はまだ動かさない ── store への書込が確定した TODO_TOGGLED(ack)で
      // 列が動く(persisted 規律と同じ「enqueue と ack を混同しない」)。
      // ack 前の連打は stale meta 基準で同方向になる(往復しない)── 安全側の
      // debounce 的意味論として意図どおり(review #6)
      return {
        state,
        events: [
          {
            type: 'REQUEST_TODO_TOGGLE',
            lid: meta.lid,
            title: meta.title,
            entryOrder: meta.entryOrder,
            nextStatus,
          },
        ],
      };
    }
    case 'TODO_TOGGLED': {
      // TODO(P6/P7 コンテナ切替導入時): cid を event/ack に載せて跨ぎ ack を
      // 捨てる(lid 偶然衝突 ── review F と同型の穴。P3-6a review #7)
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] }; // 再 boot 済みなら捨てる
      const entryMetas = new Map(state.entryMetas).set(action.lid, {
        ...meta,
        status: action.status,
        date: action.date,
        archived: action.archived,
      });
      let openBody = state.openBody;
      if (openBody?.lid === action.lid) {
        if (state.phase === 'editing') {
          // toggle 直後に同じ entry の編集へ入った稀な窓: draft は触らず、
          // persisted の追従 + **diskAhead の印**だけ付ける。変更ありの commit は
          // draft が勝つ(可視内容の last-write-wins)が、無変更 commit / cancel は
          // disk を採用する(review #4 ── 窓の外へ帰結を生き残らせない)
          openBody = { ...openBody, persisted: action.body, diskAhead: true };
        } else if (
          state.phase === 'error' &&
          openBody.baseline !== openBody.persisted &&
          !openBody.diskAhead
        ) {
          // persist 失敗中(未達 commit あり)に後着 toggle が成功した窓:
          // 丸ごと差し替えると baseline===persisted になり「未達の証拠」ごと
          // 消える(review #4 ── v2 が回収不能)。baseline に status を合流させ、
          // 再保存が「未達のテキスト + 新しい status」の両方の意図を書く
          const merged = withTodoStatus(
            openBody.baseline,
            action.status === 'done' ? 'done' : 'open',
          );
          openBody = {
            lid: action.lid,
            body: openBody.body === openBody.baseline ? merged : openBody.body,
            baseline: merged,
            persisted: action.body,
            diskAhead: false,
          };
        } else {
          // ready では body===baseline 不変量が立つので丸ごと差し替えで安全
          openBody = {
            lid: action.lid,
            body: action.body,
            baseline: action.body,
            persisted: action.body,
            diskAhead: false,
          };
        }
      }
      return { state: { ...state, entryMetas, openBody }, events: [] };
    }
    case 'SET_CALENDAR_MONTH': {
      // 月送りの正規化(binder は 0 や 13 を送ってよい)
      let { year, month } = action;
      if (month < 1) {
        year -= 1;
        month = 12;
      } else if (month > 12) {
        year += 1;
        month = 1;
      }
      return { state: { ...state, calendarMonth: { year, month } }, events: [] };
    }
    case 'TOGGLE_SHOW_ARCHIVED':
      return { state: { ...state, showArchived: !state.showArchived }, events: [] };
    case 'BODY_PERSISTED': {
      // ack された内容を disk 事実として記録(選択が移って openBody が破棄
      // 済みなら捨てる ── stale ack で別 entry の作業域を汚さない)
      if (!state.openBody || state.openBody.lid !== action.lid)
        return { state, events: [] };
      const ob = state.openBody;
      if (ob.persisted === action.body) return { state, events: [] };
      return {
        state: { ...state, openBody: { ...ob, persisted: action.body } },
        events: [],
      };
    }
    case 'ENTRY_STAMPED': {
      const meta = state.entryMetas.get(action.lid);
      // 消えた entry の ack は捨てる(削除と書込の競合)
      if (!meta) return { state, events: [] };
      if (meta.createdAt === action.createdAt && meta.updatedAt === action.updatedAt)
        return { state, events: [] };
      const entryMetas = new Map(state.entryMetas);
      entryMetas.set(action.lid, {
        ...meta,
        // ⚠ 既にある createdAt を null で塗り潰さない(行が消えていた場合に null が来る)
        createdAt: action.createdAt ?? meta.createdAt,
        updatedAt: action.updatedAt ?? meta.updatedAt,
      });
      return { state: { ...state, entryMetas }, events: [] };
    }
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
      const rows = filerRows(state.scopeLid, state.entryMetas, state.relations, {
        filterQuery: state.filterQuery,
        searchHits: state.searchHits,
        sort: state.entrySort,
      });
      const range = rangeInRows(rows, state.selectionAnchor, action.lid);
      if (range.length === 0) return { state, events: [] };
      // ⚠ 起点は動かさない ── 動かすと `Shift` を押すたびに範囲が縮んでいく
      return { state: { ...state, selection: range }, events: [] };
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
        events: [],
      };
    }
    case 'DESELECT_ENTRY': {
      // filer の「ルート」導線(scope は selection の純関数なので、root 表示 =
      // 選択解除)。openBody は速やかに破棄
      if (state.phase !== 'ready') return { state, events: [] };
      if (state.selectedLid === null) return { state, events: [] };
      return {
        state: { ...state, selectedLid: null, openBody: null, error: null },
        events: [],
      };
    }
    case 'CREATE_ENTRY': {
      // ready 限定。lid 衝突は作らない(binder 生成の単調 lid が壊れた場合の防波堤)
      if (state.phase !== 'ready') return { state, events: [] };
      if (state.entryMetas.has(action.lid)) {
        return {
          state: { ...state, error: `create: lid collision (${action.lid})` },
          events: [],
        };
      }
      const body = action.body ?? seedBodyFor(action.archetype);
      const wantsEdit = action.edit !== false;
      const ext = extractMeta(action.archetype, body);
      const lastLid = state.order[state.order.length - 1];
      const entryOrder = lastLid
        ? (state.entryMetas.get(lastLid)?.entryOrder ?? 0) + 1
        : 1;
      const meta: EntryMeta = {
        lid: action.lid,
        title: action.title,
        archetype: action.archetype,
        createdAt: null, // worker が datetime('now') を刻む(次 boot で読み戻る)
        updatedAt: null,
        entryOrder,
        status: ext.status,
        date: ext.date,
        archived: ext.archived,
      };
      /**
       * 🔴 **いま見ているフォルダの中に作る**(2026-08-05)。
       * ⚠ 入れ先が folder でない / 実在しないなら**黙ってルートに作る** ──
       *    ここで作成ごと断ると、user は「押しても何も起きない」を見る
       *    (作れないより、意図と違う場所に見えているほうが直せる)。
       * ⚠ 自己辺は作らない(作った当人が入れ先になることはあり得ないが、
       *    lid 生成が壊れたときの防波堤)。
       */
      const parentMeta =
        action.parentLid != null && action.parentLid !== action.lid && action.relationId
          ? state.entryMetas.get(action.parentLid)
          : undefined;
      const parentLid =
        parentMeta && parentMeta.archetype === 'folder' ? (action.parentLid as string) : null;
      const relations =
        parentLid === null
          ? state.relations
          : [
              ...state.relations,
              {
                id: action.relationId as string,
                fromLid: parentLid,
                toLid: action.lid,
                kind: STRUCTURAL,
                // ⚠ 時刻は worker が刻む(SET_ENTRY_PARENT と同じ約束)
                createdAt: null,
                updatedAt: null,
              },
            ];
      // 作成 = 即永続(PKC2 と同じ)。この初回 PERSIST が失敗した場合、editing 中の
      // 無変更 commit は skip するが、行は upsert なので次の変更 commit が自己修復する
      // (二重故障窓のみ残る ── SYS_ERROR が可視。P3-7a 設計判断)
      return {
        state: {
          ...state,
          relations,
          phase: wantsEdit ? 'editing' : 'ready', // 既定は作成 → 即編集(PKC2 の遷移)
          entryMetas: new Map(state.entryMetas).set(action.lid, meta),
          order: [...state.order, action.lid],
          selectedLid: action.lid,
          // 🔴 **絞り込みを解除する**(review M-2)。既定題名は絞り込み語に一致
          // しないので、絞り込み中に作ると **一生一覧に出ない** entry ができていた
          // (実証: 保存しても出ず、「効かなかった」と思って Esc を押すと
          // 新規未編集 cancel の掃除で entry ごと消える)。
          // ⚠ 欄の文字も消える ── 書き戻しは sidebar が持つ
          filterQuery: '',
          freshLid: wantsEdit ? action.lid : null, // 非編集作成は fresh 掃除の対象外
          error: null,
          openBody: {
            lid: action.lid,
            body,
            baseline: body,
            persisted: body, // 楽観(ack 前)── 上記コメントの範囲で許容
            diskAhead: false,
          },
        },
        events: [
          {
            type: 'PERSIST_ENTRY',
            entry: {
              lid: action.lid,
              title: action.title,
              archetype: action.archetype,
              body,
              entryOrder,
              status: ext.status,
              date: ext.date,
              archived: ext.archived,
            },
          },
          // ⚠ **entry を書いた後**に辺を書く(行が無いところへ辺を張らない)。
          //    effect は events の順に直列化するので、この並びがそのまま順序になる
          ...(parentLid === null
            ? []
            : ([
                {
                  type: 'REQUEST_SET_PARENT',
                  lid: action.lid,
                  parentLid,
                  relationId: action.relationId as string,
                },
              ] as DomainEvent[])),
        ],
      };
    }
    case 'DELETE_ENTRY': {
      if (state.phase !== 'ready') return { state, events: [] };
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      // UI からは即時に消す(楽観)── worker 側 op は relations / revisions 込みの
      // 同 tx 掃除(P3-6b)。失敗は OP_FAILED 通知(reload で再出現 = 非破壊)
      return removeEntryFromState(state, action.lid, [
        { type: 'REQUEST_DELETE', lid: action.lid },
      ]);
    }
    case 'DELETE_ENTRIES': {
      if (state.phase !== 'ready') return { state, events: [] };
      // ⚠ 居ないものは黙って落とす(消えた行を選んだまま押しても事故にしない)
      const targets = action.lids.filter((lid) => state.entryMetas.has(lid));
      if (targets.length === 0) return { state, events: [] };
      /**
       * ⚠ **1 件ずつ `removeEntryFromState` を畳む**(規則を 2 つ書かない)。
       * 後継の選択・履歴の掃除・ゴミ箱の畳みは、そちらが 1 か所で持っている。
       * ⚠ 事象(`REQUEST_DELETE`)は**まとめて 1 回**の worker op にせず 1 件ずつ出す
       * ── 既存の効果の口をそのまま使い、片方だけ失敗しても残りが進む。
       */
      let next = state;
      const events: DomainEvent[] = [];
      for (const lid of targets) {
        const r = removeEntryFromState(next, lid, [{ type: 'REQUEST_DELETE', lid }]);
        next = r.state;
        events.push(...r.events);
      }
      // ⚠ 消したものが印に残らない(`removeEntryFromState` が 1 件ずつ外している)
      return { state: { ...next, selection: [], selectionAnchor: null }, events };
    }
    case 'RENAME_ENTRY_TITLE': {
      if (state.phase !== 'ready' && state.phase !== 'editing')
        return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      const title = action.title.trim();
      if (!meta || title === '' || title === meta.title) return { state, events: [] };
      // title はローカルが唯一の知識源なので楽観更新(sidebar が即応)。
      // 永続化は effect が disk body を読んで行全体を書く(REQUEST_RENAME)。
      // 直後に COMMIT_EDIT が続く場合も、更新済み meta から行を組むので title は保たれる
      return {
        state: {
          ...state,
          entryMetas: new Map(state.entryMetas).set(action.lid, { ...meta, title }),
          freshLid: state.freshLid === action.lid ? null : state.freshLid,
        },
        events: [
          {
            type: 'REQUEST_RENAME',
            lid: action.lid,
            title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
          },
        ],
      };
    }
    case 'SET_ENTRY_PARENT': {
      // 🔴 **フォルダ整理の唯一の入口**(2026-08-05、user 報告
      // 「フォルダ整理のための導線がない」)。直す前は UI どころか
      // action・reducer・effect のどこにも relation を編集する経路が無く、
      // フォルダは作れるのに**永久に空**だった。
      if (state.phase !== 'ready') return { state, events: [] };
      const child = state.entryMetas.get(action.lid);
      if (!child) return { state, events: [] };
      const parentLid = action.parentLid;
      if (parentLid !== null) {
        const parent = state.entryMetas.get(parentLid);
        // ⚠ 入れ先は**実在するフォルダ**でなければならない(木の規約 ──
        //    `resolveCanonicalParents` は非 folder 親の辺を無視するので、
        //    ここで通すと「移したのに動かない」黙りになる)
        if (!parent || parent.archetype !== 'folder') return { state, events: [] };
        if (parentLid === action.lid) return { state, events: [] }; // 自分の中へは入れない
        // 🔴 **自分の子孫の中へは入れない**(輪ができて木でなくなる)。
        //    ⚠ 判定はここでやる ── worker は metas を持たないので木を知らない
        const parentOf = resolveCanonicalParents(state.entryMetas, state.relations);
        for (let cur: string | undefined = parentLid; cur !== undefined; cur = parentOf.get(cur)) {
          if (cur === action.lid) return { state, events: [] };
        }
      }
      // 楽観更新 ── 画面(ファイラ)は state.relations から描くので、
      // ここで直さないと「押したのに動かない」に見える
      const kept = state.relations.filter(
        (r) => !(r.kind === STRUCTURAL && r.toLid === action.lid),
      );
      const relations =
        parentLid === null
          ? kept
          : [
              ...kept,
              {
                id: action.relationId,
                fromLid: parentLid,
                toLid: action.lid,
                kind: STRUCTURAL,
                // ⚠ 時刻は **worker が刻む**(`datetime('now')`)。ここは楽観表示の
                //    ための仮値で、次の再読込で本物に置き換わる
                createdAt: null,
                updatedAt: null,
              },
            ];
      // ⚠ 何も変わらないなら書かない(同じ親へ落としても永続化が走らない)
      if (
        relations.length === state.relations.length &&
        relations.every((r, i) => r === state.relations[i])
      ) {
        return { state, events: [] };
      }
      return {
        state: { ...state, relations },
        events: [
          {
            type: 'REQUEST_SET_PARENT',
            lid: action.lid,
            parentLid,
            relationId: action.relationId,
          },
        ],
      };
    }
    case 'MOVE_ENTRY_ORDER': {
      /**
       * 🔴 **並べ替え**(2026-08-06。user 報告 2-10「並べ替えの手段が無い」)。
       *
       * ⚠ 規則は `reorderSibling` が 1 本で持つ(features 層)── reducer に
       *   2 つ目の並べ方を書かない。ここがやるのは
       *   「metas の値を書き換えて、`order` を**同じ規則で**引き直す」だけ。
       */
      if (state.phase !== 'ready') return { state, events: [] };
      const moves = reorderSibling(
        action.lid,
        action.direction,
        state.entryMetas,
        state.relations,
      );
      if (moves.length === 0) return { state, events: [] }; // 端 ── 黙って何もしない
      const entryMetas = new Map(state.entryMetas);
      const rows: Array<{ lid: string; title: string; archetype: string; entryOrder: number }> = [];
      for (const mv of moves) {
        const m = entryMetas.get(mv.lid);
        if (!m) continue;
        entryMetas.set(mv.lid, { ...m, entryOrder: mv.entryOrder });
        rows.push({
          lid: mv.lid,
          title: m.title,
          archetype: m.archetype,
          entryOrder: mv.entryOrder,
        });
      }
      if (rows.length === 0) return { state, events: [] };
      // ⚠ 並びの規則は boot と同じ 1 本(entryOrder 昇順・同値は lid)
      const order = [...entryMetas.values()]
        .sort((a, b) => a.entryOrder - b.entryOrder || a.lid.localeCompare(b.lid))
        .map((m) => m.lid);
      return {
        state: { ...state, entryMetas, order },
        events: [{ type: 'REQUEST_REORDER', entries: rows }],
      };
    }
    /**
     * 🔴 **関係を作る**(#185)。
     * ⚠ 自分自身へは張らない / 同じ組・同じ種類は 2 本作らない(押すたびに増えない)。
     * ⚠ 居場所は弾く ── 型でも弾いているが、**実行時にも**弾く
     *   (dispatch は型を通らない経路からも来る)。
     */
    case 'ADD_RELATION': {
      if (state.phase !== 'ready') return { state, events: [] };
      if (action.kind === STRUCTURAL) return { state, events: [] };
      const { fromLid, toLid, kind } = action;
      if (fromLid === toLid) return { state, events: [] };
      if (!state.entryMetas.has(fromLid) || !state.entryMetas.has(toLid))
        return { state, events: [] };
      const dup = state.relations.some(
        (r) => r.fromLid === fromLid && r.toLid === toLid && r.kind === kind,
      );
      if (dup) return { state, events: [] };
      return {
        state: {
          ...state,
          /**
           * ⚠ 時刻は **null** で置く ── **disk が正**(worker が `datetime('now')` を
           * 入れる)。ここで `new Date()` を呼ぶと reducer が純関数でなくなり、
           * しかも**画面と disk で違う値**を持つことになる。
           */
          relations: [
            ...state.relations,
            { id: action.id, fromLid, toLid, kind, createdAt: null, updatedAt: null },
          ],
        },
        events: [{ type: 'REQUEST_RELATION_UPSERT', id: action.id, fromLid, toLid, kind }],
      };
    }
    /** 関係を消す。⚠ 居ない id でも**黙って成功**(冪等 ── 2 回押しても壊れない)。 */
    case 'REMOVE_RELATION': {
      if (state.phase !== 'ready') return { state, events: [] };
      const target = state.relations.find((r) => r.id === action.id);
      if (!target) return { state, events: [] };
      // ⚠ 居場所はここから消させない ── 消すとファイラの階層が壊れ、戻す導線が無い
      if (target.kind === STRUCTURAL) return { state, events: [] };
      return {
        state: { ...state, relations: state.relations.filter((r) => r.id !== action.id) },
        events: [{ type: 'REQUEST_RELATION_DELETE', id: action.id }],
      };
    }
    case 'SHOW_HISTORY': {
      // ready + 選択ありのみ。一覧は要求時に引く(boot で revisions に触れない)
      if (state.phase !== 'ready' || !state.selectedLid)
        return { state, events: [] };
      return {
        state,
        events: [{ type: 'REQUEST_REVISION_LIST', lid: state.selectedLid }],
      };
    }
    case 'HIDE_HISTORY':
      return { state: { ...state, revisionPanel: null }, events: [] };
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
      const meta = state.entryMetas.get(state.selectedLid);
      if (!meta) return { state, events: [] };
      // panel は畳む(復元で履歴が 1 件伸びるので開き直しが正)。meta snapshot は
      // 発火時捕獲(C-1 規律)
      return {
        state: { ...state, revisionPanel: null },
        events: [
          {
            type: 'REQUEST_RESTORE',
            lid: meta.lid,
            revId: action.revId,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
          },
        ],
      };
    }
    case 'SHOW_TRASH': {
      if (state.phase !== 'ready') return { state, events: [] };
      return { state, events: [{ type: 'REQUEST_TRASH_LIST' }] };
    }
    case 'FILE_LINKED': {
      // ⚠ **居ない entry には紐づけない**(取込が失敗した後に届いても導線を作らない)
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      if (state.linkedFiles.get(action.lid) === action.name) return { state, events: [] };
      const linkedFiles = new Map(state.linkedFiles);
      linkedFiles.set(action.lid, action.name);
      return { state: { ...state, linkedFiles }, events: [] };
    }
    case 'HIDE_TRASH':
      return { state: { ...state, trashPanel: null }, events: [] };
    case 'TRASH_LIST_LOADED':
      if (state.phase !== 'ready') return { state, events: [] };
      return {
        state: {
          ...state,
          // 🔴 **いま存在する entry は「ゴミ箱」ではない**(P8 段⑪ の hotfix)。
          // ゴミ箱の定義は「entry が居ない revision」なので、届いた一覧を
          // **その場の真実で濾す**。これが無いと、開いた直後に復元したとき
          // **先に飛んだ一覧要求の応答が後から着いて、復元したものを戻す**
          // ── 画面には「復元したのにゴミ箱に残っている」が出る(smoke が
          // 3 回に 2 回落ちる形で表面化していた)。
          // ⚠ 世代(token)ではなく**導出**で塞ぐ ── どの順で着いても正しい
          trashPanel: { items: action.items.filter((t) => !state.entryMetas.has(t.entryLid)) },
        },
        events: [],
      };
    case 'RESTORE_TRASH': {
      if (state.phase !== 'ready') return { state, events: [] };
      if (state.entryMetas.has(action.entryLid)) {
        // lid 衝突(同 lid が再作成済み)── 黙って上書きしない(可視で止める)
        return {
          state: {
            ...state,
            error: `復元できません: 同じ ID の entry が既に存在します (${action.entryLid})`,
          },
          events: [],
        };
      }
      const lastLid = state.order[state.order.length - 1];
      const entryOrder = lastLid
        ? (state.entryMetas.get(lastLid)?.entryOrder ?? 0) + 1
        : 1;
      return {
        state,
        events: [
          {
            type: 'REQUEST_TRASH_RESTORE',
            entryLid: action.entryLid,
            revId: action.revId,
            entryOrder,
          },
        ],
      };
    }
    case 'PURGE_TRASH': {
      if (state.phase !== 'ready') return { state, events: [] };
      return { state, events: [{ type: 'REQUEST_TRASH_PURGE' }] };
    }
    case 'ENTRY_RESTORED': {
      // 🔒 編集中の着弾(review P5b F1 ── 反例実験で draft 全損と editor
      // 乗っ取りを実証): 選択と editor は絶対に乗っ取らない。
      // - 同一 lid: disk 先行の印だけ付ける(TODO_TOGGLED の editing 分岐と同じ
      //   意味論 ── 変更あり commit は draft が勝ち、無変更 commit / cancel は
      //   disk = 復元内容が勝つ)
      // - 別 lid: 破棄(復元は disk 側で完了済み ── 前進変異なので再操作で回収可)
      if (state.phase === 'editing') {
        if (state.openBody?.lid === action.meta.lid) {
          return {
            state: {
              ...state,
              entryMetas: new Map(state.entryMetas).set(action.meta.lid, action.meta),
              openBody: { ...state.openBody, persisted: action.body, diskAhead: true },
            },
            events: [],
          };
        }
        return { state, events: [] };
      }
      if (state.phase !== 'ready') return { state, events: [] };
      // 整合判定(review P5b F2): 履歴復元は entry が居るのが前提 ── 発行後に
      // 削除されていたら破棄(disk も queue 直列で「復元 → 削除」の順に終わって
      // おり、捨てる = 整合)。trash 復元は居ないのが前提(二重復元の後着を破棄)
      const exists = state.entryMetas.has(action.meta.lid);
      if (action.mode === 'revision' ? !exists : exists)
        return { state, events: [] };
      // 履歴復元(既存 meta 置換)と trash 復元(再出現)の合流点。復元先を
      // 選択して結果を見せる。openBody は disk 確定値で確立(persisted = body)
      const entryMetas = new Map(state.entryMetas).set(action.meta.lid, action.meta);
      /**
       * 🔴 **元の位置へ戻す**(2026-08-06。user 報告 2-9)。
       *
       * 直す前は `[...state.order, lid]` = **末尾に飛んでいた**。並びの規則は
       * boot と同じ「`entryOrder` 昇順・同値は lid」なので、**その規則で挿す**
       * ── 別の規則を書かない(復元だけ並びが違う、を作らない)。
       */
      const order = state.order.includes(action.meta.lid)
        ? state.order
        : insertByOrder(state.order, action.meta.lid, entryMetas);
      /**
       * 🔴 **居場所を戻す**(同上)。disk の relations は消えていないので、
       * 効果層が読み直したものを常駐へ合流させる。
       * ⚠ **同じ id は上書き**(二重復元で関係が 2 本にならない)。
       */
      const relations = mergeRelations(state.relations, action.relations ?? []);
      const trashPanel = state.trashPanel
        ? {
            items: state.trashPanel.items.filter(
              (t) => t.entryLid !== action.meta.lid,
            ),
          }
        : null;
      return {
        state: {
          ...state,
          entryMetas,
          order,
          relations,
          trashPanel,
          revisionPanel: null,
          selectedLid: action.meta.lid,
          openBody: {
            lid: action.meta.lid,
            body: action.body,
            baseline: action.body,
            persisted: action.body,
            diskAhead: false,
          },
          error: null,
        },
        events: [],
      };
    }
    case 'TRASH_PURGED':
      return {
        state: {
          ...state,
          trashPanel: state.trashPanel ? { items: [] } : null,
        },
        events: [],
      };
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
      const phase =
        state.phase === 'editing' ? 'editing' : protecting ? 'error' : state.phase;
      return { state: { ...state, phase, error: action.error }, events: [] };
    }
  }
}

/**
 * entry を常駐 state から外し、選択を隣へ移す(DELETE_ENTRY / fresh-cancel 共用)。
 * 選択遷移は PKC2 nextSelectedAfterRemove と同じ「同 index → 末尾 fallback → null」。
 * 新しい選択には REQUEST_BODY を発行する(openBody は破棄済みのため)。
 */
/**
 * ランチャーが読むべき entry(= 添付だけ)を **並び順で** 取る。
 *
 * ⚠ **添付だけ**。全 entry の body を読むと、ランチャーを開くたびに全文を
 * 舐めることになる(5,000 件のノートを持つ user には致命的)。
 * ⚠ 選ぶのは reducer 側 ── effect 層は実行時に state を見ない(review L-6)。
 */
function attachmentEntries(state: AppState): Array<{ lid: string; title: string }> {
  const out: Array<{ lid: string; title: string }> = [];
  for (const lid of state.order) {
    const meta = state.entryMetas.get(lid);
    if (meta?.archetype === 'attachment') out.push({ lid, title: meta.title });
  }
  return out;
}

/**
 * `entryOrder` 昇順(同値は lid)の位置へ挿す ── **boot の並びと同じ規則**。
 * ⚠ 規則を 2 つ書かない(復元だけ並びが違う、を作らない)。
 */
function insertByOrder(
  order: readonly string[],
  lid: string,
  metas: ReadonlyMap<string, EntryMeta>,
): string[] {
  const key = (l: string): [number, string] => [metas.get(l)?.entryOrder ?? 0, l];
  const [ko, kl] = key(lid);
  const out = [...order];
  const at = out.findIndex((l) => {
    const [o, x] = key(l);
    return o > ko || (o === ko && x > kl);
  });
  out.splice(at < 0 ? out.length : at, 0, lid);
  return out;
}

/** 同じ id は後着で上書きして合流(二重復元で関係が 2 本にならない)。 */
function mergeRelations(
  current: readonly Relation[],
  incoming: readonly Relation[],
): readonly Relation[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((r) => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()];
}

function removeEntryFromState(
  state: AppState,
  lid: string,
  extraEvents: DomainEvent[],
): ReduceResult {
  const entryMetas = new Map(state.entryMetas);
  entryMetas.delete(lid);
  const order = state.order.filter((l) => l !== lid);
  /**
   * 常駐 relations も追従(メモリだけ残すと、relations を描く view が
   * 「削除したのにリンクが残る」になる)。
   * ⚠ **disk からは消していない**(2026-08-05 に `deleteEntry` から外した ──
   * 消すとゴミ箱から戻しても居場所が戻らない)。本当の処分は `purgeTrash`。
   * だから復元では `ENTRY_RESTORED` が disk から読み直して合流させる。
   */
  const touches = state.relations.some((r) => r.fromLid === lid || r.toLid === lid);
  const relations = touches
    ? state.relations.filter((r) => r.fromLid !== lid && r.toLid !== lid)
    : state.relations;
  let selectedLid = state.selectedLid;
  const events = [...extraEvents];
  if (state.selectedLid === lid) {
    // 🔴 後継は「**見えている中**」から選ぶ(review M-1)。初版は絞り込み前の
    // `state.order` から取っていたので、絞り込み中に削除を続けると
    // **一覧に出ていない entry** が次々に選ばれて消えていった(実証済み)。
    // ⚠ 規則は `visibleOrder` に 1 本化 ── 一覧と後継が別々の答えを出さない
    // ⚠ **本文の当たりも渡す**(2026-08-15)── 渡さないと、本文だけが当たっている
    //    ノートを消したとき `indexOf` が -1 になり、選択が黙って null へ飛ぶ
    const before = visibleOrder(
      state.order,
      (l) => state.entryMetas.get(l)?.title,
      state.filterQuery,
      state.searchHits,
    );
    const vIdx = before.indexOf(lid);
    const after = before.filter((l) => l !== lid);
    // ⚠ 絞り込みで残りが居なくなったら **null**(見えないものを選ばない)
    selectedLid = vIdx < 0 ? null : (after[Math.min(vIdx, after.length - 1)] ?? null);
    if (selectedLid) events.push({ type: 'REQUEST_BODY', lid: selectedLid });
  }
  return {
    state: {
      ...state,
      phase: 'ready',
      entryMetas,
      order,
      relations,
      selectedLid,
      openBody: state.openBody?.lid === lid ? null : state.openBody,
      freshLid: state.freshLid === lid ? null : state.freshLid,
      /**
       * 🔴 **見ていたフォルダを消したらルートへ戻す**(#240 段①)。
       * ⚠ 指したままだと、消えたフォルダの中身として**空の面**が出続ける
       * (しかもそこで「作る」と、消えた親の子として生まれる)。
       */
      scopeLid: state.scopeLid === lid ? null : state.scopeLid,
      // ⚠ 消えたものを印に残さない(#240 段②)── まとめて削除が**居ないもの**を数える
      selection: state.selection.includes(lid)
        ? state.selection.filter((l) => l !== lid)
        : state.selection,
      selectionAnchor: state.selectionAnchor === lid ? null : state.selectionAnchor,
      // 削除で履歴・ゴミ箱の断面は古くなる ── 畳んで開き直しに任せる(P5b)
      revisionPanel: null,
      trashPanel: null,
      // ⚠ 元ファイルの紐づけも外す ── 消したノートに「書き戻す」を出したままだと、
      //    戻せなくなった器を指す導線が残る(復元したら開き直しで紐づく)
      linkedFiles: dropLink(state.linkedFiles, lid),
    },
    events,
  };
}

/**
 * 再読込を跨いで残す紐づけ。別 container なら**全部捨てる**(lid の偶然衝突で
 * 他人のノートに「書き戻す」を出さない ── 選択の持ち越しと同じ判断)。
 */
function keepLinks(
  state: AppState,
  cid: string,
  metas: ReadonlyMap<string, EntryMeta>,
): ReadonlyMap<string, string> {
  if (state.cid !== cid) return state.linkedFiles.size === 0 ? state.linkedFiles : new Map();
  let dropped = false;
  const next = new Map<string, string>();
  for (const [lid, name] of state.linkedFiles) {
    if (metas.has(lid)) next.set(lid, name);
    else dropped = true;
  }
  return dropped ? next : state.linkedFiles; // 変化が無いなら参照を保つ
}

/** 紐づけを 1 件外す(⚠ 持っていないなら**同じ参照**を返す ── 断面指紋を壊さない)。 */
function dropLink(
  links: ReadonlyMap<string, string>,
  lid: string,
): ReadonlyMap<string, string> {
  if (!links.has(lid)) return links;
  const next = new Map(links);
  next.delete(lid);
  return next;
}

/**
 * meta + body から行全体を確定し、常駐 metas を追従させる(COMMIT_EDIT /
 * RETRY_PERSIST 共用)。抽出は唯一経路 extractMeta。抽出値が変わらないときは
 * entryMetas の参照を維持する(sidebar / kanban の断面指紋を無駄に壊さない)。
 */
function buildPersist(
  state: AppState,
  meta: EntryMeta,
  body: string,
): { entryMetas: ReadonlyMap<string, EntryMeta>; entry: EntryUpsert } {
  const ext = extractMeta(meta.archetype, body);
  const changed =
    meta.status !== ext.status ||
    meta.date !== ext.date ||
    meta.archived !== ext.archived;
  const entryMetas = changed
    ? new Map(state.entryMetas).set(meta.lid, { ...meta, ...ext })
    : state.entryMetas;
  return {
    entryMetas,
    entry: {
      lid: meta.lid,
      title: meta.title,
      archetype: meta.archetype,
      body,
      entryOrder: meta.entryOrder,
      status: ext.status,
      date: ext.date,
      archived: ext.archived,
    },
  };
}
