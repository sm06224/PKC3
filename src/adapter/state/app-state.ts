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
import { reduceBoot } from './slices/boot';
import { reduceQueryScan } from './slices/query-scan';
import { reduceSql } from './slices/sql';
import { reduceView } from './slices/view';
import { reduceLauncher } from './slices/launcher';
import { reduceEdit } from './slices/edit';
import { reduceAppend } from './slices/append';
import { reduceBodyEdit } from './slices/body-edit';
import { reducePlaces } from './slices/places';
import { reduceBlockOps } from './slices/block-ops';
import { reduceCalendar } from './slices/calendar';
import { reducePersisted } from './slices/persisted';
import { reduceSelection } from './slices/selection';
import { reduceEntries } from './slices/entries';
import { reduceHistory } from './slices/history';
import { reduceTrash } from './slices/trash';
import { reduceDual } from './slices/dual';
import { reduceSmart } from './slices/smart';
import { reduceSplit } from './slices/split';
import { reduceRestore } from './slices/restore';
import { reduceSearchJump } from './slices/search-jump';
import { reduceNotice } from './slices/notice';
import { DEFAULT_ENTRY_SORT, NATURAL_DESC, type EntrySort } from '@features/filter/entry-sort';
import { DEFAULT_SQL_ENGINE, type SqlEngine } from '@features/query/sql-engine';
import { type Grid, type SchemaLink, type SchemaModel } from '@features/query/schema-digest';
import { isSystemMessageLid } from '@features/message/message-log';
import { type ErAction } from '@features/query/er-sql';
import { isDuckDbOnlySource, sqlGuestSourceOf } from '@features/query/sql-guest-source';
import { type SqlExtraSource } from '@features/query/sql-multi-source';
import type { DuckDbCopyReport } from '@features/query/duckdb-copy-report';

/**
 * 🔴 **構造(つながり図・構造ノート)を、どこへ頼むか**(#682 段④c → #918 で「断る」から「頼み先を変える」へ)。
 *
 * ⚠ 構造を採る 3 本(`schema-digest.ts`)は**内蔵の sqlite へ**打つが、`.parquet` / `.json` は
 *   sqlite worker を 1 度も通らず(中身を読めない)、2 つ以上並べた器は **DuckDB の中にしか無い**。
 *   以前はここで「まだ出せません(DuckDB で引く相手です)」と**断っていた**(#918 の裁定 = A で、出す側へ)。
 * 🔑 頼み先は 3 通りで、**判定はここ 1 か所**(3 つの入口 ── 相手を選んだ / 図を開いた / 構造をノートへ ──
 *   が同じ答えを使う。§7):
 *   - 何も選んでいない(この PKC のノート)→ `{}`
 *   - 内蔵の sqlite が読める相手(`.sqlite` / `.csv` / `.tsv` / `.xlsx`)を 1 件 → `{ guest: true }`(今までどおり)
 *   - DuckDB でしか読めない相手(`.parquet` / `.json`)/ **2 件以上並べた** → `{ duck, duckExtra? }`
 *     (DuckDB の器の `duckdb_columns()` 等から採る。`duckdb-schema.ts`)
 */
export type SchemaRoute = {
  guest?: true;
  duck?: { lid: string; name: string };
  duckExtra?: readonly { lid: string; name: string }[];
};
export function schemaRouteOf(
  guest: { readonly lid: string; readonly name: string } | null,
  /** 🔴 足した相手(#918 段⑦)。1 件でも在れば DuckDB の器へ頼む。 */
  extras: readonly SqlExtraSource[] = [],
): SchemaRoute {
  if (guest === null) return {};
  if (extras.length > 0 || isDuckDbOnlySource(sqlGuestSourceOf(guest.lid, guest.name))) {
    return {
      duck: { lid: guest.lid, name: guest.name },
      ...(extras.length > 0
        ? { duckExtra: extras.map((e) => ({ lid: e.lid, name: e.name })) }
        : {}),
    };
  }
  return { guest: true };
}
/**
 * 🔴 **採ってある構造が「どの相手の組」の物か**を言う名札(`er.source`)。
 * ⚠ 1 件のときは今までどおり lid だけ。**足した相手も含める** ── 含めないと、足した / 外した直後に
 *   「前の組の図」を「いまの組の図」として使い回す(名札は同じ・中身は別の file の組)。
 */
export function erSourceKey(
  guest: { readonly lid: string } | null,
  extras: readonly SqlExtraSource[] = [],
): string {
  return guest === null ? '' : [guest.lid, ...extras.map((e) => e.lid)].join('|');
}
/** 構造ノートの題名・見出しに出す「どこの構造か」(2 件以上は ` + ` で並べる)。 */
export function schemaWhereOf(
  guest: { readonly name: string } | null,
  extras: readonly SqlExtraSource[] = [],
): string | null {
  return guest === null ? null : [guest.name, ...extras.map((e) => e.name)].join(' + ');
}
/**
 * 🔴 **足した相手の集合を差し替える**(足した / 外した の両方がここを通る。#918 段⑦)。
 *
 * ⚠ **答えを捨てる**(`SET_SQL_SOURCE` と同じ理由)── 相手の集合が変われば、
 *   出ている表は**別の file の組の話**である。残すと「新しい組を引いた答え」に見える。
 * ⚠ **走っている答えも無効にする**(札を進める)── 走っている最中に集合を変えられるので、
 *   遅れて届いた**前の組の答え**を受けると、名札は新しいのに中身は前の組になる。
 * 🔑 つながり図は**組が変わったら採り直す**(`erSourceKey` が足した相手も含む)── 開いていれば
 *   新しい組の構造を DuckDB の器から採る(1 件へ戻った回は 1 件のときの作りへ戻る)。
 */
export function withSqlSourceSet(
  state: AppState,
  extras: readonly SqlExtraSource[],
): { state: AppState; events: DomainEvent[] } {
  const p = state.sqlPage;
  const er = erForSource(p.er, erSourceKey(p.guest, extras), schemaRouteOf(p.guest, extras), p.guest !== null);
  return {
    state: {
      ...state,
      sqlPage: {
        ...p,
        extraGuests: extras,
        runToken: p.runToken + 1,
        running: false,
        ranSql: '',
        columns: [],
        rows: [],
        truncated: false,
        ms: 0,
        error: '',
        saved: '',
        // 🔴 組が変われば、写した報告も別の話になる(次に写すまで空)
        duckCopy: null,
        duckLoading: false,
        er: er.er,
      },
    },
    events: er.events,
  };
}
import { type ErPendingFrom } from '@features/query/er-connect';
import { filerRowOptions, } from './list-view-options';
import { getAncestorFolders, } from '@features/relation/tree';
import { extractMeta, } from '@features/flavor';
import { type BodyRewrite } from '@features/markdown/body-rewrite';
import type { TableFormat } from '@features/markdown/table-convert';
import {
  isLineOpen,
  isPlaceOpen,
  placeEntryLids,
} from '@features/markdown/place-notation';
import { type PlaceStyle } from '@features/markdown/place-color';
import { type PlaceShape } from '@features/markdown/place-shape';
import { type PlaceRectValue } from '@features/markdown/place-rect';
import { type PlaceTemplateId } from '@features/markdown/place-template';
import {
  type InsertAnchor,
  type MoveLines,
} from '@features/markdown/line-move';
import { replaceNoteTime, replaceTaskCards, type TaskScan } from '@features/schedule/task-cards';
import type { RepeatUnit } from '@features/schedule/repeat';
import type { ContactScan } from '@features/contact/contact-card';
import type { CaptureItem } from '@features/capture/capture-item';
import { GRAPH_DEFAULT_DEPTH } from '@features/relation/graph-view';
import { type WorkLogScan } from '@features/timer/work-log';
import type { SnippetScan } from '@features/snippet/snippet-table';
import type { SearchDetailRow } from '@features/filter/search-snippet';
import {
  pinSplitLid,
  STACK_MAX,
  unpinSplitLid,
} from '@features/split-frames';
import { stackLids } from '@features/flavor/stack-flavor';
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import type { PersistState } from '@adapter/platform/storage-persist';
import type { OpenExtension } from '@adapter/platform/extension-links';
import type { LauncherTile } from '@features/launcher/tiles';
import {
  APP_GROUP_ARCHETYPE,
  appGroupIconOf,
  appGroupName,
  type AppGroupIcons,
  type AppGroupOrders,
} from '@features/launcher/app-group-spec';
import {
  isMovableTile,
  type TileMoveTarget,
} from '@features/launcher/tile-order';
import type {
  GroupResult as QueryGroups,
  KeyResult as QueryKeys,
} from '@features/query/group-by';
import { NO_KINDS, entryFilterOf, normalizeQuery, visibleOrder } from '@features/filter/title-filter';
import { commandQueryOf } from '@features/palette/command-query';
import { foldCase, jumpTerms, normalizeFindQuery } from '@features/filter/search-hits';
import { DIRECTIONLESS_KINDS, STRUCTURAL, type RelationKind } from '@features/relation/kinds';
import {
  excerptOf,
  PLACE_BODY_CAP,
  sameExcerpt,
  type PlaceExcerpt,
} from '@features/markdown/place-embed';
import {
  parseSectionKey,
  sectionEmbedKeys,
  sectionExcerptOf,
} from '@features/markdown/section-embed';
import {
  EMPTY_HISTORY,
  canGoBack,
  canGoForward,
  current as historyCurrent,
  pruneHistory,
  pushSelection,
  type SelectionHistory,
} from '@features/nav/selection-history';
import { filerRows, lidShownInScope, } from '@features/relation/filer-list';
import {
  SMART_ARCHETYPE,
  needsRescan,
  matchesSmartTags,
  type SmartField,
  type SmartSpec,
} from '@features/smart/smart-spec';
import { collectEntryTags } from '@features/flavor/entry-tags';
import {
  initialDual,
  paneOf,
  paneScope,
  pruneDual,
  scopeFallbackNote,
  scopeFellBack,
  clipPreview,
  type DualSide,
  type DualState,
} from '@features/relation/dual-pane';

/**
 * 🔴 **スマートフォルダ 1 つぶんの当たり**(#421 段①)。
 * ⚠ `total` は**上限で切る前**の数 ── 黙って切ると user は「これで全部」と読む。
 * ⚠ `failed` は「この版では集められない」(旧い worker が残っている端末)。
 */
export interface SmartHitState {
  readonly lids: readonly string[];
  readonly total: number;
  readonly failed: boolean;
  /**
   * 🔑 **集めたときに効いていた条件**。⚠ 画面に「何で絞っているか」を出すために
   *   持つ ── 本文をもう一度読みに行かないで済む(reducer も描く側も本文を持たない)。
   * ⚠ **書き込みの判断には使わない**(本文を直に書き換えられると古くなる)──
   *   落としたときのタグは effect が**その場で本文から読む**。
   * ⚠ 段② から**条件ぜんぶ**を持つ(タグだけではない)── その場で落とせるかの
   *   判定(`needsRescan`)にも要る。
   */
  readonly spec: SmartSpec;
  /**
   * 🔴 **本文に書いてあるのに読めなかった条件の数**(依頼 85-9)。0 / 省略 = 全部読めた。
   * ⚠ 帯が「本文の条件のうち N 個が読めていません」と言うために持つ(黙って捨てない)。
   */
  readonly unreadable?: number;
}

export type AppPhase = 'initializing' | 'ready' | 'editing' | 'error';

/** 探す面の state(#680)。中身の意味は `AppState.searchPage` の注記。 */
export interface SearchPageState {
  readonly query: string;
  readonly rows: readonly SearchDetailRow[];
  readonly rowsQuery: string;
  readonly truncated: boolean;
  /**
   * 探せなかったか。⚠ 理由を 2 つに分ける(#1087)── `stale` = このタブが古く、探す口が無い
   *   (再読み込みで直る)/ `error` = 探している途中で失敗した(再読み込みで直るとは限らない)。
   */
  readonly failed: false | 'stale' | 'error';
}
/**
 * 🔴 **SQL を打つ面の state**(#681 段②)。
 *
 * ⚠ **打っている字と、走らせた字を分ける** ── 結果が「どの字のものか」を
 *   言えないと、打ち替えた後の表が**前の答えなのか今の答えなのか**分からない
 *   (`searchPage` の `query` / `rowsQuery` と同じ形)。
 */
export interface SqlPageState {
  /** 欄の中身(打っている字)。 */
  readonly sql: string;
  /** いま出ている表が、どの字の答えか(空 = まだ走らせていない)。 */
  readonly ranSql: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number | null)[])[];
  /** 上限で切ったか。⚠ 黙って切らない。 */
  readonly truncated: boolean;
  /** かかった時間(ms)。 */
  readonly ms: number;
  /** 走っている最中か(押した口を二重に叩かせない)。 */
  readonly running: boolean;
  /** 断りの字(空 = 無い)。⚠ **そのまま画面に出せる字**にする。 */
  readonly error: string;
  /**
   * 🔴 **書き出したノートの題名**(空 = まだ書き出していない。#681 段③ の 3 つ目)。
   *
   * ⚠ この面は**別の窓**で開くので、ノートを作っても**その窓には何も起きない**
   *   ── 何も言わないと、押した user には**押せなかった**ように見える
   *   (CLAUDE.md「押した後どうなるか」)。だから題名を控えて、表の上の行で言う。
   * ⚠ 走らせ直したら消す(古い知らせを次の答えの上に残さない)。
   */
  readonly saved: string;
  /**
   * 🔴 **何へ書き出したか**(#918 段④)。⚠ `saved` と**必ず一緒に**動かす ──
   *   別々に置くと、「ノートへ」の後に「ファイルへ」を押した回で**字だけ入れ替わる**。
   * 🔑 `SQL_SAVED` が両方を 1 度に書くので、2 か所へ散らない(§7)。
   */
  readonly savedKind: 'note' | 'file';
  /**
   * 🔴 **書き出した答えの中で、先頭 2000 字に切ってあった升の数**(#1087 の見直し)。⚠ `saved` と一緒に `SQL_SAVED` が書く。
   * 0 のときは何も言わない。
   */
  readonly savedCapped: number;
  /**
   * 🔴 **前に打った字**(#918 段②a。user 要望 2026-09-14「打つ所がお粗末」)。
   * ⚠ **新しいものが先頭**。⚠ **この窓の中だけ**(読み直したら消える)──
   *   打った SQL は user のデータではなく、その場の手なので憶えない。
   */
  readonly history: readonly string[];
  /**
   * 履歴のどこを見ているか。**`-1` = 打ちかけの字**(履歴に入っていない)。
   * ⚠ これが無いと **↓ で打ちかけの字へ戻れない**(前の字で潰してしまう)。
   */
  readonly historyAt: number;
  /** ⚠ 履歴を遡る前の**打ちかけの字**(↓ でここへ戻る)。 */
  readonly historyDraft: string;
  /**
   * 🔴 **履歴の中で手直しした字**(添字は `history` と同じ)。
   *
   * ⚠ これが無いと、**呼び戻した字を直してからもう一度 `↑` を押した人が、
   *   直した分を黙って失う**(2026-09-14 の動線レビューが実測で出した)──
   *   直した字はどこにも控えられず、`↓` で帰ってくるのは**直す前**の字だった。
   * 🔑 走らせたら捨てる(`RUN_SQL` で `[]` に戻す)── 走った字は `history` に
   *   積まれるので、手直しの控えを持ち越す理由が無い。
   */
  readonly historyEdits: readonly (string | undefined)[];
  /**
   * 🔴 **いま調べている相手**(#681 段③ の 2 つ目)。`null` = この PKC のノート。
   *
   * ⚠ **どちらを調べているかが画面から読めない**と、user は
   *   「ノートを数えたつもりで、よその DB を数えていた」を**気づけない**。
   *   だから面の上に必ず出す(CLAUDE.md §4)。
   */
  /**
   * 🔴 **どのエンジンで引くか**(#682 段②。user 裁定 2026-09-15 = §9 は A)。
   *
   * ⚠ ここに入るのは「**user が選んだ物**」であって、「いま実際に引く物」ではない。
   * 🔑 実際に引く物は **`sqlEngineOf(state.sqlPage)` が毎回決める**
   *   (`features/query/sql-engine.ts`)── 相手を選び直すと選べなくなることが
   *   あるので、**その場で落とす**。
   * ⚠ ここへ「落とした後の値」を書き戻さない ── 書き戻すと、csv → .sqlite → csv と
   *   選び直した人の**選択が黙って消える**(戻ってこない)。
   */
  readonly engine: SqlEngine;
  readonly guest: {
    /** 添付のノートの lid(選び直しの照合に使う)。 */
    readonly lid: string;
    /** file の名前(= 添付のノートの題名)。画面に出す字。 */
    readonly name: string;
    /** 中に在る表の名前(打つ前に何が在るか見せる)。 */
    readonly tables: readonly string[];
    /** 画像の大きさ(バイト)。⚠ 常駐メモリの目安。 */
    readonly bytes: number;
    /**
     * 🔴 **csv / tsv を上限で打ち切ったか**(#854 段①)。⚠ `.sqlite` は常に `false`
     *   (打ち切りうるのは csv / tsv だけ)。黙って切ると user は「これで全部」と読む。
     */
    readonly truncated: boolean;
    /** 🔴 **Shift_JIS と推測して読んだか**(csv / tsv のみ)。⚠ 推測なので、画面で一言添える。 */
    readonly sjis?: boolean;
  } | null;
  /**
   * 🔴 **足した相手**(2 件目以降。#918 段⑦。Gemini 裁定 2026-10-01)。
   *
   * 🔑 1 件目は `guest` が持つ ── **ここは「足した分」だけ**にして、1 件のときの
   *   これまでの作り(選び所 / 開く / 構造)を 1 バイトも変えない。
   * ⚠ **1 件でも在れば DuckDB 固定**(`sqlEngineOf`)。⚠ 1 件目を選び直したら**全部外れる**
   *   (`SET_SQL_SOURCE`)── 選び直しは「別の調べ物を始める」操作なので、足した相手は
   *   持ち越さない(持ち越すと、画面に出ていない相手を引くことになる)。
   * ⚠ 手持ちの file は控えが `sql-local-file.ts` に在る ── **外す / 選び直す / 足せなかった**の
   *   どれでも reducer が `REQUEST_SQL_EXTRA_RELEASE` で手放させる。
   */
  readonly extraGuests: readonly SqlExtraSource[];
  /** 開こうとして失敗した理由(空 = 無い)。⚠ 黙って何も起きない形を作らない。 */
  readonly guestError: string;
  /**
   * 🔴 **いま開こうとしている相手**(空 = 無い)。#681 段③ の 2 つ目。
   *
   * ⚠ **遅れて届いた答えを捨てるために在る** ── 選び直した直後は、前の相手の
   *   「開けました」が**後から**届きうる(読み込みは非同期である)。それを
   *   受けてしまうと、**選んでいない DB を「調べています」と出す**ことになり、
   *   打った SQL はそちらへ飛ぶ(いちばん気づけない外し方)。
   */
  readonly guestPending: string;
  /**
   * 🔴 **選び所に出す、いま選ばれている相手**(空 = この PKC。user 報告で判明:
   *   「プルダウンリストには出てくるのに、取り込み済みの csv が選択できない」)。
   *
   * ⚠ **`guest?.lid` だけでは足りない** ── 開いている最中(`guest` はまだ `null`)や、
   *   開けなかった回(`guest` は `null` のまま)にも、**選んだことは画面に出したい**。
   *   `guestPending` は「遅れて届いた答えを捨てる」ための札で、開けなかった回は
   *   その役目を終えて `''` へ戻る(2 つの target を持たせない)── だから
   *   「選ばれている物」はここへ**専用に**持つ。
   * 🔑 `SET_SQL_SOURCE` でしか書き換えない(async の答えでは触らない)ので、
   *   選び直した直後に前の相手の答えが遅れて届いても、ここは動かない。
   * ⚠ 失敗しても**戻さない**(user 裁定の推薦:「選んだまま + 断り文」)──
   *   戻すと、何を選んで断られたのかが画面から消える。
   */
  readonly guestChosen: string;
  /**
   * 🔴 **走らせた回の札**(#681 の着地前レビュー F3-A)。
   *
   * ⚠ 走っている最中に**調べる相手を変えられる**ので、前の相手の答えが
   *   後から届く ── 受けると、画面は**新しい名札のまま古い DB の中身**を出す。
   *   数字は本物なので、user には**間違いに気づく手がかりが 1 つも無い**。
   * 🔑 だから頼むときに札を付け、**札が変わっていたら答えを捨てる**
   *   (`guestPending` と同じ作法)。
   */
  readonly runToken: number;
  /**
   * 🔴 **DuckDB へ写したときの報告**(写せなかった表・ビュー / 全列を文字で写した表。#682 段④d の着地後レビュー D3 / D6)。
   *
   * ⚠ `null` = まだ写していない(または写す相手ではない)。**答え(`SET_SQL_RESULT`)か構造(`SQL_ER_LOADED`)が運んできた物**を
   *   そのまま控える ── 帯・つながり図がここから言う(字は `duckdb-copy-report.ts` 1 か所)。
   * ⚠ **相手の組が変わったら捨てる**(`SET_SQL_SOURCE` / `withSqlSourceSet`)── 残すと、新しい組の帯に前の file の
   *   「写せなかった表」が出る(名札は新しいのに中身は前の組 ── いちばん気づけない外し方)。
   */
  readonly duckCopy: DuckDbCopyReport | null;
  /**
   * 🔴 **いまの回が、DuckDB の器へ表を読み込んでいる最中か**(#682 の最後の 1 件)。
   * ⚠ 「走っている」(`running`)とは別 ── 器が起きていて読み込み済みなら、DuckDB の回でも**読み込まない**ので、
   *   「時間がかかります」を出すと**嘘**になる。`SQL_DUCK_LOADING`(器が読み込みを始めた合図)でだけ立つ。
   * ⚠ 回が始まる所(`RUN_SQL` / `SQL_SCHEMA_TO_NOTE`)と終わる所(`SET_SQL_RESULT` / `SQL_RUN_FAILED`)で必ず降ろす。
   */
  readonly duckLoading: boolean;
  /**
   * 🔴 **表のつながり図(ER)**(#918 段⑤。user 要望 2026-09-14「er でグラフィカルに
   * 取得する方法も欲しいな」/ 置き場の裁定 2026-09-15 = **この窓の中に畳める欄**)。
   *
   * ⚠ **`model` は「採った構造」そのもの**で、絵ではない ── 並べ方(`erLayout`)は
   *   描く側が組む。state に絵を持つと、窓の幅が変わるたびに state が動く。
   * ⚠ **相手を変えたら捨てる**(`guest` を切り替えた回に古い図を出さない)──
   *   出すと、名札は新しいのに**中身は前の DB**という、いちばん気づけない形になる。
   */
  readonly er: {
    /** 開いているか(閉じているときは 1px も場所を取らない)。 */
    readonly open: boolean;
    /** 採っている最中か。⚠ 開いた直後の無反応を作らない。 */
    readonly loading: boolean;
    /** 採れた構造(`null` = まだ採っていない)。 */
    readonly model: SchemaModel | null;
    /**
     * 🔴 **押したのに足せなかった理由**(空 = 無い)。
     * ⚠ **そのまま画面に出す字**である ── 黙って何もしないと無言の dead click になる。
     */
    readonly note: string;
    /** どの相手の構造か(`guest?.lid ?? ''`)。⚠ 変わったら `model` を捨てる印。 */
    readonly source: string;
    /**
     * 🔴 **採ってきた回の札**。⚠ 採っている間に相手を変えられるので、
     *   **札が違う答えは捨てる**(`runToken` と同じ作法。走らせる札とは別に持つ ──
     *   1 つにすると、走らせただけで図の取得が無効になる)。
     */
    readonly token: number;
    /**
     * 🔴 **「繋ぐ」モードが入か**(#918 段⑤d-1。user 報告 2026-09-16
     *   「er のキー同士の掛け合わせとかちゃんと描きたいのにできない」)。
     * ⚠ 入切そのものは `model` が変わっても持ち越してよい(user の好みなので)。
     */
    readonly connecting: boolean;
    /**
     * 🔴 **繋ぎ始めた列**(`null` = まだ押していない。#918 段⑤d-1)。
     * ⚠ **切にしたら必ず捨てる** ── 残すと、次に入れたときに
     *   前の相手が復活して見える(押していないのに「ここから」が付いている)。
     */
    readonly pendingFrom: ErPendingFrom | null;
    /**
     * 🔴 **自分で引いた線**(#918 段⑤d-1)。⚠ **この窓の中だけ**(読み直したら消える)
     *   ── user のデータではなく、その場で図を読むための手なので憶えない。
     * ⚠ **相手が変わったら `model` と一緒に必ず捨てる** ── 別の DB の繋がりを
     *   持ち越すと、名札は新しいのに中身は前の DB という形になる(§4 と同じ実害)。
     */
    readonly mine: readonly SchemaLink[];
  };
}

/**
 * 🔴 **調べる相手が変わった回に、つながり図をどう持ち替えるか**(#918 段⑤)。
 *
 * ⚠ **判定をここ 1 か所に置く**(CLAUDE.md §7)── 相手が変わる口は 3 つある
 *   (選び直す / 開けた / 開けなかった)ので、それぞれに書くと**片方だけ直す**形になる。
 * 🔴 いちばん危ないのは「**名札は新しいのに、図は前の DB**」である ── 数字も名前も
 *   本物なので、user には間違いの手がかりが 1 つも無い。だから**必ず捨てる**。
 *
 * @param route どこへ頼むか(`schemaRouteOf`)。⚠ event が運ぶ ── 頼む側で state を読み直すと、
 *   選び直した直後の 1 回が前の相手へ飛ぶ。
 * @param emit いま頼んでよい回か(⚠ 相手を**開き終えた**回だけ真 ── 開く前に頼むと
 *   前の相手へ飛ぶ)。偽なら「採っています」のまま待つ。
 */
export function erForSource(
  er: SqlPageState['er'],
  source: string,
  route: SchemaRoute,
  emit: boolean,
): { er: SqlPageState['er']; events: DomainEvent[] } {
  if (er.source === source && er.model !== null) return { er, events: [] };
  // ⚠ 閉じているなら捨てるだけ(開くときに採り直す)
  // 🔑 `mine` / `pendingFrom` も `model` と一緒に捨てる(#918 段⑤d-1)。
  //   ⚠ `connecting`(入切そのもの)は持ち越す ── user の好みであって、この DB の
  //   データではない。
  if (!er.open) {
    return {
      er: { ...er, loading: false, model: null, note: '', source: '', mine: [], pendingFrom: null },
      events: [],
    };
  }
  if (!emit) {
    return {
      er: { ...er, loading: true, model: null, note: '', source: '', mine: [], pendingFrom: null },
      events: [],
    };
  }
  const token = er.token + 1;
  return {
    er: {
      open: true,
      loading: true,
      model: null,
      note: '',
      source,
      token,
      connecting: er.connecting,
      pendingFrom: null,
      mine: [],
    },
    events: [{ type: 'REQUEST_SQL_ER', token, ...route }],
  };
}

/**
 * 🔴 **DuckDB で表を作った / 消した後の、つながり図の持ち替え**(#682 段④d の着地後レビュー R1)。
 *
 * - 閉じているなら**採った物を捨てるだけ**(開くとき採り直す ── `SQL_ER_TOGGLE` は `model` が無ければ頼む)
 * - 開いているなら**捨てて、いま頼む**(札を進める ── 飛んでいる前の答えは捨てられる)
 * ⚠ `erForSource` を使わない ── あちらは `mine` / `pendingFrom` も捨てる(**別の相手へ替わった**回の作法)。
 *   ここは**同じ相手のまま構造だけが変わった**ので、user が引いた線は残す。
 */
export function erAfterDuckWrite(
  er: SqlPageState['er'],
  source: string,
  route: SchemaRoute,
): { er: SqlPageState['er']; events: DomainEvent[] } {
  if (!er.open) {
    return { er: { ...er, loading: false, model: null, note: '', source: '', pendingFrom: null }, events: [] };
  }
  const token = er.token + 1;
  return {
    er: { ...er, loading: true, model: null, note: '', source, token, pendingFrom: null },
    events: [{ type: 'REQUEST_SQL_ER', token, ...route }],
  };
}

/**
 * 🔴 **AI の書き足しの印**(台帳 #1852 P1 / 依頼 362)。`APPEND_TO_ENTRY.batch` にこの値が入った追記は、
 * 自分の「追記を元に戻す」(`lastAppend`)を**上書きせず**、AI の分(`lastAgentAppend`)として別に持つ。
 * ⚠ 自分の追記と AI の追記が同じ 1 手に継がれない(`batch` が違う)── 別の手として戻せる。
 */
export const AGENT_APPEND_BATCH = 'agent-append';

/**
 * 🔴 **直前の追記を、次の追記でどう持ち替えるか**(#395 段① / #668 C)。
 *
 * - 純粋な挿入でなかった回は `null` ── 前の材料を**残したままにしない**
 *   (古い材料で消すと、別の所が消える)
 * - 🔴 **同じ回(`batch`)の続きなら、行を継ぎ足して 1 手にする**(#668 C)──
 *   3 枚まとめて落とした写真は「元に戻す」1 回で 3 行とも消える
 * - それ以外は差し替え(直前の 1 手だけ)
 *
 * ⚠ 継ぐのは**同じノート・同じ回**のときだけ。間に手で足した追記(印なし)が
 *   入れば、そこで切れる ── 回の途中で足した字まで巻き添えにしない。
 * ⚠ 継いだ行は本文の中で**連続している**(同じ回の追記は全部末尾へ足すので)──
 *   `removeInsertedLines` は連続した並びを探すので、1 手として消せる。
 */
export function nextLastAppend(
  prev: AppState['lastAppend'],
  next: { lid: string; inserted: readonly string[] | null; insertedAt?: number | null; batch?: string },
): AppState['lastAppend'] {
  if (next.inserted === null) return null;
  const joined =
    prev !== null && next.batch !== undefined && prev.batch === next.batch && prev.lid === next.lid;
  return {
    lid: next.lid,
    lines: joined ? [...prev.lines, ...next.inserted] : next.inserted,
    // 🔴 足した位置(#1087)。同じ回の続きは最初の位置を保つ(行は連続している前提)
    ...((joined ? prev.at : next.insertedAt) == null ? {} : { at: (joined ? prev.at : next.insertedAt)! }),
    ...(next.batch === undefined ? {} : { batch: next.batch }),
  };
}

/**
 * 🔴 **中央の面の全数**(#241 段⑥-b で 1 本に寄せた)。
 *
 * ⚠ 直す前は**同じ一覧が 2 か所**に在った ── 型の union(ここ)と、
 * `binder.ts` の `VIEW_MODES`(押されたボタンの値を検める集合)。面を足すたび
 * 両方に書く必要があり、片方を忘れると**押しても何も起きないボタン**か、
 * **型に無い値が state に入る**のどちらかになる(2 ペインを足したとき実際に
 * 両方へ書いた)。⚠ 値そのものは配列 1 本にして、型はそこから引く。
 *
 * 🔑 **`'filer'` / `'launcher'` は畳んだ**(#241 段⑥-b。設計 doc §6 裁定 6)──
 * P8 段⑤ で「探し方」を左の列(`browse.ts`)へ移して以降、この 2 値は
 * **どこからも開かれない**まま `toPane` が本文へ落としていた。
 * ⚠ 左の列のタブ(`BrowseMode`)と鍵の文脈(`KeyContext`)にも同じ綴りが在るが、
 * **あちらは生きている**(別の名前空間である)── 消すのは中央の面の値だけ。
 */
export const VIEW_MODES = [
  'detail',
  /**
   * 🔴 **カレンダー / やることの板は、ここから外した**(#292 段⑤、2026-08-23)。
   *
   * > user 指示:「**ユーザーはもう一つ PKC が開いて混乱すると思う /
   * > ちゃんとした導線に作り直しなさい**」
   *
   * ⚠ 中央の面である限り、開くと**本文が消える**(#300 で名指しされた実害)。
   *   別窓へ逃がしても「もう一つ PKC が開く」だけで、根は同じだった。
   * 🔑 引っ越し先は**左の列の「予定」タブ**(`browse.ts` の表:左 = ノート全体)。
   *   ⚠ **同じものが在る場所**なので、これは削除ではなく引っ越しである ──
   *   代わりに何ができるようになったかは `docs/development/schedule-redesign-2026-08.md` §5。
   * ⚠ 栞(`#pkc?view=calendar`)は `deep-link.ts` の `MOVED_VIEWS` が引っ越し先へ送る。
   */
  /**
   * 🔴 **集計**(#184)── frontmatter の 1 つの key で束ねて表にする面。
   * ⚠ **aside ではない**(ノートを映す面である)ので、押した行の選択は
   * この面に留まる。
   */
  'query',
  /**
   * 🔴 **予定表**(#673 段②。user 裁定 2026-09-04
   * 「**予定表も連絡先も別窓、アプリの基本は別窓**」)。
   *
   * ⚠ 上の #292 段⑤ を**覆すのではない** ── 左の列の「予定」タブは**そのまま残る**。
   *   ここに足すのは、同じ面を**組み込みアプリの別ウィンドウ**(`#pkc?view=schedule`)
   *   でも開けるようにするためである(2 ペインと同じ道 ── `view-window.ts`)。
   * ⚠ **aside ではない**(`ASIDE_PANES` に入れない)── 集計と同じく**ノートを映す面**
   *   なので、札を押した選択はこの面に留まる。
   * 🔑 描画器は左の列と**同じ `ScheduleRenderer`**(`center.ts`)── 面を 2 つ描いても
   *   規則は 1 本である。
   */
  'schedule',
  /**
   * 🔴 **連絡先**(#278 段③。user 裁定 2026-09-04「予定表も連絡先も別窓」)。
   * ⚠ 予定表と同じ形 ── 左の列の「連絡先」タブは残し、同じ `ContactsRenderer` を
   *   中央の器(別窓)にも描く。aside ではない(名前を押した選択はこの面に留まる)。
   */
  'contacts',
  /**
   * 🔴 **録ったもの**(#683 段①。user 要望 2026-09-03
   * 「時間を測る・画面録画・録音も…組み込みアプリにしたい」)。
   * ⚠ 連絡先と同じ形 ── 左の列の「録ったもの」タブは残し、同じ
   *   `CapturesRenderer` を中央の器(別窓)にも描く。
   */
  'captures',
  /**
   * 🔴 **関係グラフ**(#281 ①。user 指示 2026-08-19「…関連性グラフビューワ…は組み込みアプリでリリースしたい」)。
   * ⚠ 連絡先と同じ形 ── 左の列の「グラフ」タブは残し、同じ `GraphRenderer` を中央の器(別窓)にも描く。
   *   aside ではない(節点を押した選択はこの面に留まり、選んだノートから描き直す)。
   */
  'graph',
  /**
   * 🔴 **計った時間**(#683 ①。user 要望 2026-09-03「時間を測る・画面録画・録音も…組み込みアプリにしたい」)。
   * ⚠ 録ったものと同じ形 ── 左の列の「時間」タブは残し、同じ `TimersRenderer` を中央の器(別窓)にも描く。
   *   aside ではない(名前を押した選択はこの面に留まる)。
   */
  'timers',
  /**
   * 🔴 **探す面**(#680。user 要望「検索専用の組み込みアプリ」/ 裁定 2026-09-04
   * 「アプリの基本は別窓」)。
   *
   * 左の列の欄は**一覧を絞る**(並びは変えない・当たりは lid だけ)。この面は
   * **見つける**ためのもの ── 題名 + 本文の抜粋 + 関連度順で並べ、行を押すと
   * そのノートを**小窓**で開く(いま読んでいる本文は退かさない)。
   * ⚠ **左の欄と語を共有しない**(`searchPage.query` は `filterQuery` と別)──
   *   面で打った語で左の一覧が絞られると、別窓の面から本体の一覧が動いて驚く。
   * ⚠ **aside ではない**(`ASIDE_PANES` に入れない)── 左の一覧を押した選択は
   *   この面に留まる(集計と同じ)。⚠ 左の列に同じものは無い(`homeTabOf` は null)
   *   ── 塞がれたときの退避は**左の欄に焦点**(`open-view.ts`)。
   */
  'search',
  /**
   * 🔴 **2 ペインタブファイラ**(#241 段⑥。user 指示 2026-08-17
   * 「アプリに 2 ペインタブファイラを**組み込みで**提供すること」)。
   * ⚠ 裁定 6(`organize-pane-design-2026-08.md` §6)で**中央の面**と決まった
   * ── 幅は中央にしかない。左の列は「探し方」であって整理の作業台ではない。
   */
  'dual',
  /**
   * 🔴 **SQL を打つ面**(#681 段②。user 要望 2026-09-03「内蔵の sqlite を最大限
   * 活用したインスタントな csv や sqliteDB のクエリアプリ」/ 裁定 2026-09-04
   * 「アプリの基本は別窓」)。
   *
   * ⚠ **aside である**(`ASIDE_PANES`)── ノートを映す面ではなく**道具**なので、
   *   左の一覧を押したら中央はノートへ戻る(2 ペインと同じ扱い)。
   * ⚠ **読むだけ** ── 境は worker の `PRAGMA query_only` と進み具合の見張りで、
   *   打つ前の字の門(`sql-guard.ts`)は「断る理由を読める字で言う」ためのものである。
   */
  'sql',
  /**
   * 🔴 **テキスト整形**(#1233。user 指示 2026-10-26)。貼り付けた文章を整える道具 ──
   * 左の列に置き場は無い(タブを足すと既存のタブが「⋯」へ畳まれる)ので、別ウィンドウ + タイルだけ。
   * ⚠ aside である(`ASIDE_PANES`)── ノートを映す面ではなく**道具**。
   */
  'textlab',
  /**
   * 🔴 **計算スクラッチパッド**(#1230。user 指示 2026-10-26)。文章と式を混ぜて書くと右に結果が並ぶ道具 ──
   * 左の列に置き場は無い(タブを足すと既存のタブが「⋯」へ畳まれる)ので、別ウィンドウ + タイルだけ。
   * ⚠ aside である(`ASIDE_PANES`)── ノートを映す面ではなく**道具**。
   */
  'calc',
  /**
   * 🔴 **差分マージ**(#1231。user 指示 2026-10-26)。2 つのノート(や履歴の版・PC のファイル)を見比べ、
   * ちがいを 1 か所ずつどちらかへそろえる道具 ── 左の列に置き場は無い(タブを足すと既存のタブが「⋯」へ畳まれる)ので、
   * 別ウィンドウ + タイルだけ。⚠ aside である(`ASIDE_PANES`)── ノートを映す面ではなく**道具**。
   */
  'diff',
  /**
   * 🔴 **コマンドシェル**(#274。user 指示 2026-08-19「同じようにコマンドシェルも必要です」)。打つ欄 + 結果 + 履歴を持つ組み込みアプリ。
   * 別ウィンドウ + 左のペインのタブ(別ウィンドウが塞がれたときの退避先も左のタブ)。⚠ aside(ノートを映さない道具)。
   */
  'shell',
  /**
   * 🔴 **PC(パソコンのフォルダ)**(#300。user 指示 2026-10-26「全部やるのです」)。左の列のタブ「PC」(#215)と
   * 同じ中身を別ウィンドウでも開けるようにする面。⚠ aside(ノートを映さない道具)── 行を押すと取り込んで
   * そのノートを開くので、選んだ瞬間に本文へ退く(左のタブから開いたときと同じ見え方)。
   */
  'pc',
  'settings',
  'flags',
  'help',
] as const;

export type ViewMode = (typeof VIEW_MODES)[number];

/** 押されたボタンの値が、いま実在する面か。⚠ 判定はここ 1 か所。 */
export function isViewMode(value: string): value is ViewMode {
  return (VIEW_MODES as readonly string[]).includes(value);
}

/**
 * 🔴 **ノートを映していない中央の面**(P11)。一覧のノートを押したら中央を
 * ノートへ戻す ── その判定をここ 1 か所に置く。
 *
 * ⚠ 直す前は `viewMode === 'settings'` の**直書き**だった。面を足すたびに
 * 取りこぼすので(P8 段⑲ で直した「開かない理由が画面のどこにも無い」の再演)、
 * **集合にして 1 か所へ寄せた**(CLAUDE.md「判定を増やさない」)。
 */
const ASIDE_PANES: ReadonlySet<ViewMode> = new Set<ViewMode>([
  'settings',
  'flags',
  'help',
  /**
   * 🔴 **2 ペインタブファイラもここ**(#241 段⑥)。理由は 2 つとも aside と同じ:
   * ① この面は**開いているノートを映さない**ので、左の一覧でノートを押したのに
   *    中央が動かないと、**押しても何も起きない**(P8 段⑲ で直した当の症状)。
   * ② **編集中でも開ける** ── 場所を眺めるだけなら下書きに触らない。
   *    ⚠ 設計 doc §6 裁定 6 は「編集中に押したときの断り文を足す」と書いたが、
   *    **取り下げる**(2026-08-18)── 断るべきは「開く」ではなく「実際に動かす」で、
   *    そちらは `moveEntries` が既に声に出して断っている。開くほうを止めると、
   *    P11 で 1 個 → 3 個に増やしてしまった無言の dead click を作り直すことになる。
   */
  'dual',
  /**
   * 🔴 **SQL を打つ面もここ**(#681 段②)── 2 ペインと同じ理由:
   * ① **開いているノートを映さない**ので、左の一覧でノートを押したのに中央が
   *    動かないと、押しても何も起きない
   * ② **編集中でも開ける** ── 読むだけなので下書きに触らない
   */
  'sql',
  // 🔴 テキスト整形(#1233)も同じ ── 開いているノートを映さない道具。編集中でも開ける(読み込むだけで書かない)
  'textlab',
  // 🔴 計算スクラッチパッド(#1230)も同じ ── ノートを映さない道具。編集中でも開ける(ノートにするときだけ書く)
  'calc',
  // 🔴 差分マージ(#1231)も同じ ── ノートを映さない道具。編集中でも開ける(見比べるだけなら下書きに触れない。保存するときだけ書く)
  'diff',
  // 🔴 コマンドシェル(#274)も同じ ── ノートを映さない道具。編集中でも開ける(コマンドを実行するときだけ、各コマンドが編集中の断りを言う)
  'shell',
  // 🔴 PC(#300)も同じ ── ノートを映さない道具。行を押すと取り込んで開くので、ノートを選んだ瞬間に本文へ退く(`STAY_ON_SELECT` に入れない)
  'pc',
]);

export function isAsidePane(view: ViewMode): boolean {
  return ASIDE_PANES.has(view);
}

/**
 * 🔴 **ノートを選んだときに、中央を本文へ戻す面**(#906。user 裁定 2026-09-14)。
 *
 * ## なぜ `isAsidePane` と分けたか
 *
 * ⚠ `isAsidePane` は **3 つの別々の問い**に使われていた:
 *
 * | 読み手 | 問い |
 * |---|---|
 * | `SELECT_ENTRY`(下) | **ノートを選んだら本文へ退くか** |
 * | `main.ts` の `setBrowse` | 左のタブを押したら畳むか |
 * | `SET_VIEW_MODE` | 編集中でも開いてよいか |
 *
 * 🔴 user 裁定は**1 つ目だけ**を変えるものである ── 「**SQL で調べる を開いたまま
 *   添付を取り込んでも、SQL の面はそのまま**」。⚠ `ASIDE_PANES` から `sql` を
 *   丸ごと外すと**残り 2 つの意味も変わる**(タブで畳めなくなる / 編集中の扱いが変わる)。
 *
 * ## ⚠ 既定は「退く」側 ── 例外を名指しする
 *
 * 🔑 `ASIDE_PANES` から**引き算**で作る ── 面を足した人は自動で「退く」側に入るので、
 *   **書き忘れても安全な向き**へ倒れる(足し算で作ると、忘れた面だけ退かなくなる)。
 * ⚠ 例外はここに 1 つだけ書く。増やすときは**画面で何が起きるか**を添える。
 */
const STAY_ON_SELECT: ReadonlySet<ViewMode> = new Set<ViewMode>([
  /**
   * 🔴 **SQL で調べる**(#906)。⚠ この面は「本文を読む面」ではなく「**調べる面**」
   *   なので、ノートが選ばれても退く理由が無い。
   * 🔑 実害は「**調べながら足す**」で出ていた ── `.csv` を見ている最中に
   *   「もう 1 つ入れて見比べよう」と添付すると、`SELECT_ENTRY` が飛んで
   *   **選び所も打ちかけの SQL も画面から消えていた**。
   */
  'sql',
  /**
   * 🔴 **テキスト整形**(#1233)。⚠ 「開いているノートを読み込む」は**左の一覧でノートを選んでから**押す
   *   ので、選んだ瞬間に面が本文へ退くと、読み込む前に画面が消える(打ちかけの文章も見えなくなる)。
   */
  'textlab',
  /**
   * 🔴 **計算スクラッチパッド**(#1230)。⚠ 計算しながらノートを見比べる道具なので、左の一覧でノートを選んでも
   *   面が退くと、書きかけの式が見えなくなる(打ちかけは覚えているが、画面から消えるのは「押して消えた」に見える)。
   */
  'calc',
  /**
   * 🔴 **差分マージ**(#1231)。⚠ 左右の相手は「左の一覧でノートを選んでから『開いているノート』を押す」ことでも
   *   選ぶので、選んだ瞬間に面が退くと、取り込みの途中経過が画面から消える。
   */
  'diff',
  /**
   * 🔴 **コマンドシェル**(#274)。⚠ `.`(選んでいるノート)を相手にするコマンドがあるので、左の一覧でノートを選んでも
   *   面が退くと、打ちかけのコマンドと結果の表が画面から消える。
   */
  'shell',
]);

/** ノートを選んだら本文へ戻す面か。⚠ 判定はここ 1 か所(上の docstring)。 */
export function leavesOnSelect(view: ViewMode): boolean {
  return ASIDE_PANES.has(view) && !STAY_ON_SELECT.has(view);
}

/**
 * 🔴 **面の呼び名**(user 目線レビュー U-2 / U-7)。
 *
 * ⚠ **user が画面で見ている字と同じにする** ── 断り文に内部の名前(`kanban`)が
 *   出ると、user は**別のものを探す**(CLAUDE.md「文言は『押した場所』と対で pin する」)。
 * 🔑 呼び名はここ 1 か所。⚠ 面を足したら**ここも足す** ── 網羅は型が守る
 *   (`Record<ViewMode, string>` なので、足し忘れると tsc が落ちる)。
 */
const VIEW_LABELS: Record<ViewMode, string> = {
  detail: '本文',
  query: '集計',
  schedule: '予定表',
  contacts: '連絡先',
  captures: '音/動画',
  graph: '関係グラフ',
  timers: '計った時間',
  search: '探す',
  dual: '2 ペインで整理',
  sql: 'SQL で調べる',
  textlab: 'テキスト整形',
  calc: '計算スクラッチパッド',
  diff: '差分マージ',
  shell: 'コマンドシェル',
  pc: 'PC',
  settings: 'システム',
  flags: 'フラグ',
  help: 'ヘルプ',
};

export function viewModeLabel(view: ViewMode): string {
  return VIEW_LABELS[view];
}

/**
 * 🔴 **いま操作を受けられない理由**(#516)。`ready` なら `null`。
 *
 * ⚠ **`phase !== 'ready'` を「編集中」と読み替えない。** `phase` には
 *   `'error'`(保存に失敗したときの保護)も `'initializing'` も在るので、
 *   一律に「編集中は…」と出すと**嘘になる** ── user は編集していないのに
 *   「確定するか取り消してください」と言われ、**存在しない編集を探す**。
 * 🔑 断り文の出どころは**ここ 1 か所**にする(§7)── reducer と情報ペインで
 *   別々に組み立てると、片方だけ直したときに食い違う。
 */
export function phaseBlockReason(phase: AppPhase): string | null {
  if (phase === 'ready') return null;
  if (phase === 'editing') return '編集を保存するか、編集をやめてから';
  /*
   * 🔴 **保存に失敗して止まったときの出口は「再保存」1 つだけ**(C11 / #1045)。
   * ⚠ 直す前は「保存をやり直すか**取り消して**から」と言っていたが、この phase では
   *   取り消し(`CANCEL_EDIT`)は `phase !== 'editing'` で断られ、選択も動かない
   *   (`SELECT_ENTRY` の error 分岐)── **押せない出口を案内していた**。
   *   画面に在るのは本文の上の「再保存」ボタンだけである(`detail.ts` の `retry`)。
   */
  if (phase === 'error') return SAVE_FAILED_EXIT;
  return '読み込みが終わってから';
}

/**
 * 🔴 **ノートを開く(`SELECT_ENTRY`)を reducer が捨てる phase の断り文**(#1087)。
 *
 * ⚠ 捨てるのは `editing` と `error` の 2 つだけ(`slices/boot.ts` の `SELECT_ENTRY`)── 読み込み中(`initializing`)は捨てない。
 *   `phase !== 'ready'` で断ると、reducer が通す `initializing` まで断ってしまう(reducer と断りの条件がずれる)。
 * 🔑 ノートを開く口(一覧 / リンク / 添付のリンク / アドレス)は、断るかどうかをここ 1 本で決める
 *   (口ごとに `editing` だけを見ると、保存失敗中に原因違いの字が出る)。
 * @returns 開けるなら `null`
 */
export function selectBlockReason(phase: AppPhase): string | null {
  return phase === 'editing' || phase === 'error' ? phaseBlockReason(phase) : null;
}

/**
 * 🔴 **編集を終える操作(保存 / 取り消し)を捨てるときの断り文**(#723)。
 *
 * ## なぜ計器を置くのか
 *
 * cowork が **1 回だけ**「編集を終えられなくなった」を観測し、⚠ **再現しなかった**。
 * `COMMIT_EDIT` / `CANCEL_EDIT` は前提が崩れていると `events: []` で**黙って捨てて**
 * いたので、⚠ 起きた瞬間に user の画面には**何も出ない** ── 押しても 1 ドットも
 * 動かないので「アプリが固まった」としか読めず、こちらにも手掛かりが 1 つも残らない。
 *
 * 🔑 直すのは症状ではなく**見えなさ**である ── 原因が分かっていなくても、
 *   「何が崩れていたか」を画面に出せば、次の 1 回で報告が返ってくる。
 * ⚠ **黙っている物を無差別に喋らせない。** ここで喋るのは
 *   「**編集を終える 2 つの操作**」だけ ── どちらも user が明示的に押した操作なので、
 *   捨てたなら必ず理由が要る(`UPDATE_OPEN_BODY` のような**連打で飛んでくる**物は
 *   黙ったままでよい。喋らせると打鍵のたびに断り文が出る)。
 *
 * ## 分岐ごとに理由が違う
 *
 * | 崩れていたもの | user から見た状況 |
 * |---|---|
 * | `phase !== 'editing'` | もう編集は終わっている(保存済み / 二重に押した / 別のタブが先に終えた) |
 * | `openBody` が無い | 編集中なのに開いている本文が消えている(**あってはならない**) |
 *
 * ⚠ **鍵の綴りを書かない**(`F5` はスマホに無い / mac では `Command+R`)──
 *   起きることで書く(CLAUDE.md「お知らせに鍵の綴りを書かない」と同じ理由)。
 */
export function endEditRefusal(what: string, state: AppState): string {
  if (state.phase !== 'editing')
    return `${what}できませんでした: いま編集中ではありません(このタブは編集を終えています)`;
  return `${what}できませんでした: 開いている本文が見つかりません(読み込み直すと直ります)`;
}

/**
 * 🔴 **保存に失敗して止まったときの出口**(C11 / #1045)── 本文の上に出るボタンの字。
 * ⚠ ボタンの字(`detail.ts` の `retry.textContent`)と食い違うと、user は
 *   **無いボタンを探す**。一致は `tests/adapter/refusal-words.test.ts` が
 *   **描いた画面から字を引いて**見る(ここに手で書いた字どうしを比べない)。
 */
const SAVE_FAILED_EXIT = '「ノートを保存し直す」を押してから';

/**
 * 編集中に「押せない理由」として画面へ出す 1 行(#715)。
 * ⚠ 出口は**ボタンの字**(保存 / キャンセル)で言う ── 「確定 / 取り消し」は
 *   画面のどのボタンの字とも一致しない(C11 で最後の 1 系統を消した)。
 */
export const EDITING_NOTE = '編集中は使えません(「編集を保存する」か「編集をやめる」を押すと戻ります)';

/**
 * 🔴 **追記の書込が返る前に、もう 1 通押したときの断り文**(#1051)。
 * ⚠ 直す前は**黙って捨てて**いた(`APPEND_TO_ENTRY` の `writeLock` の門)。
 * 🔑 並べ替えの同じ場面(`MOVE_APP_TILE` の「いま保存しています。少し待ってから、
 *   もう一度動かしてください」)と言い方を揃える。
 */
/**
 * 🔴 **ノートの行がもう無いときの 1 文**(#1087)。⚠ 画面に出る字なので 1 か所に置く。
 * 直す前は `entry row missing` / `commit: unknown entry <lid>` のような英語と内部の id が
 * そのままステータスに出ていた。別のウィンドウで消えた、が現実に起きる原因。
 */
export const ENTRY_GONE_NOTE = 'このノートはもう見つかりません(別のウィンドウで消えた可能性があります)';

/**
 * 🔴 **題名の欄を空にして確定したときの知らせ**(#1087)。⚠ 画面に出る字なので 1 か所に置く。
 * 直す前は黙って元の題名に戻していた ── 保存した user には「空にしたのに戻った」だけが見える。
 */
export const EMPTY_TITLE_NOTE = '題名が空なので、元の題名のままにしました';

export const APPEND_BUSY_NOTE = 'いま保存しています。少し待ってから、もう一度押してください';

/**
 * 🔴 **グループの並べ替え・目印の変更を、いま断る理由**(無ければ `null`。#1087)。
 * ⚠ 直す前は 3 つの case が `phase` / `writeLock` で**理由なしに** return していた ── 編集中に「上へ」を押しても
 *   何も起きず、user には壊れて見える。断り文の出どころはここ 1 か所(reducer と binder の確認の前が同じ字を出す。§7)。
 * `doing` = 断り文の後半(「並べ替えられます」など。前置きは `phaseBlockReason`)。
 */
export function appGroupWriteRefusal(state: Pick<AppState, 'phase' | 'writeLock'>, doing: string): string | null {
  const blocked = phaseBlockReason(state.phase);
  if (blocked !== null) return `${blocked}${doing}`;
  if (state.writeLock) return APPEND_BUSY_NOTE;
  return null;
}

/**
 * 🔴 **アプリの設定(登録 / グループ / アイコン)を、いま書けない理由**(無ければ `null`)。
 * ⚠ `SET_APP_TILE` の門と、binder が「欄を元の値へ戻すか」を決める判定の**共通の 1 本**
 *   (別々に書くと、断ったのに欄だけ新しい値のまま残る)。
 * ⚠ `phase` を「編集中」と読み替えない(`phaseBlockReason` の戒め)。
 */
export function appTileRefusal(state: AppState, lid: string): string | null {
  const blocked = phaseBlockReason(state.phase);
  if (blocked !== null) return `${blocked}設定できます`;
  if (state.writeLock || (state.tileWrite && state.tileWrite.lid !== lid)) return APPEND_BUSY_NOTE;
  return null;
}

/**
 * 🔴 **「部分の下書き」の種類ごとの言葉**(#1044 段3)。
 *
 * ⚠ **章だけの下書き(#1044 段2)を、コード枠の下書きも持てるように一般化した** ──
 *   `state.sectionDraft`(field 名はそのまま。理由は {@link PartialDraft} の docstring)
 *   が持つ機構(門・断り文・保存の作法)は種類に依らず同じなので、**種類ごとに違うのは
 *   言葉だけ**にする。
 * 🔑 **種類ごとに字を分けるのは、この表 1 つだけ**(§9 の決定)── 同じ判定を
 *   2 か所に書かない(CLAUDE.md §7)。ここを直せば、以下の全部の断り文・知らせが
 *   一緒に動く。
 */
interface PartialDraftWords {
  readonly noun: string;
  readonly saveVerb: string;
  readonly cancelVerb: string;
  /** 開き直すときに押すボタンの字(章: 右クリックの項目 / コード: ✎ のボタン〔`markdown-render.ts` の title〕)。 */
  readonly openVerb: string;
  /** あいまい(2 個以上一致)の理由の書き出し。 */
  readonly ambiguousLead: string;
}

const PARTIAL_DRAFT_WORDS: Record<PartialDraftKind, PartialDraftWords> = {
  section: {
    noun: '章',
    saveVerb: '章を保存する',
    cancelVerb: '章の編集をやめる',
    openVerb: 'この章を編集する',
    ambiguousLead: 'この見出しの字が本文の中に複数あり',
  },
  code: {
    noun: 'コード',
    saveVerb: 'コードを保存する',
    cancelVerb: 'コードの編集をやめる',
    openVerb: 'このコードを編集する',
    ambiguousLead: '同じ内容のコードブロックが本文の中に複数あり',
  },
};

/**
 * 🔴 **その種類の下書きが開いている間、そのノートの他の書込を断る字**
 * (#1044 段2 / 段3)。⚠ 出口は**箱のボタンの字**で言う(`EDITING_NOTE` と同じ作法)。
 */
function partialDraftBlockedNote(kind: PartialDraftKind): string {
  const w = PARTIAL_DRAFT_WORDS[kind];
  return `${w.noun}を編集中は使えません(「${w.saveVerb}」か「${w.cancelVerb}」を押すと戻ります)`;
}
/** ⚠ 既存の名前・値のまま(段2 で出荷済み ── #1044 段3 で 1 バイトも変えない)。 */
export const SECTION_DRAFT_NOTE = partialDraftBlockedNote('section');
export const CODE_DRAFT_NOTE = partialDraftBlockedNote('code');
/**
 * 🔴 **書き出し・印刷の入口の門**(#1087)。通せるなら `null`、断るならその字。
 *
 * 🔑 書き出しは**保存済みの本文**を読むので、全文編集の下書きだけでなく、章・コードの欄に
 *   打ちかけた字も入らない(それでも「書き出しました」と出る)。{@link hasUnsavedTyping} を通し、
 *   欄が開いているときは**欄の断り文**(章 / コードで字が違う)を出す ── 他の取り込み口と同じ作法。
 * ⚠ 前置きは {@link phaseBlockReason} から。`verbPhrase` は「書き出してください」など。
 */
export function exportBlockedNote(state: AppState, verbPhrase: string): string | null {
  if (state.phase !== 'ready') return `${phaseBlockReason(state.phase)}${verbPhrase}`;
  // ここへ来るのは `ready` ── 残る打ちかけは章・コードの欄だけ(= {@link hasUnsavedTyping} の `sectionDraft` 側)。
  // ⚠ 真偽で見る: phase だけの簡易な state(旧 test の台)でも、欄の無い形として通す
  const draft = state.sectionDraft;
  if (draft) return isCodeDraft(draft) ? CODE_DRAFT_NOTE : SECTION_DRAFT_NOTE;
  return null;
}
/**
 * 🔴 **別のタブに編集を引き継がれたときの知らせ**(#1087 S3)。出口は**いま画面に在るボタンの字**で言う
 *   ── 全文編集中は「編集をやめる」、章・コードの欄だけが開いているときは「章の編集をやめる」など。
 */
export function editRevokedNote(state: AppState): string {
  const verb =
    state.phase === 'editing'
      ? '編集をやめる'
      : PARTIAL_DRAFT_WORDS[state.sectionDraft === null ? 'section' : partialDraftKind(state.sectionDraft)].cancelVerb;
  return (
    '別のタブまたはウィンドウがこのノートの編集を引き継ぎました。⚠ ' +
    `ここで保存するとそちらの編集を上書きします。必要な内容をコピーしてから「${verb}」を押してください`
  );
}
/** どちらの種類の下書きが原因の断り文か(`bodyWriteBlockResult` が控えるかどうかに使う)。 */
const PARTIAL_DRAFT_OWN_NOTES: ReadonlySet<string> = new Set([SECTION_DRAFT_NOTE, CODE_DRAFT_NOTE]);

/**
 * 🔴 **保存が断られた理由(見出し / 枠が消えた・書き換えられた)**
 * (#1044 段2 3巡目の修理、S1 / 段3)。
 *
 * ⚠ **effect が {@link replaceSectionByHeading} / {@link replaceCodeFenceContent} の
 *   結果からここへ振り分ける**(`store-effects.ts`)── 文言は user に見せる字なので
 *   **ここ 1 か所**に置き、効果層は import して使う(§7:文言を 2 か所に書かない)。
 * ⚠ `missing`(見出し / 枠が消えた)と `mismatch`(章:中身が違う)は**同じ字**にする ──
 *   どちらも「もう開いたときの前提が崩れている」で、user がすべきことは同じ
 *   (コピーして開き直す)。消えたときは開き直せないので、括弧で「ノートを編集する」へ逃がす(#1087)。
 */
function partialDraftMismatchNote(kind: PartialDraftKind): string {
  const w = PARTIAL_DRAFT_WORDS[kind];
  // 🔑 押す物を全部ボタンの字で言う(#1087)。書きかけは「やめる」で消えるので、コピーが先
  return `この${w.noun}は別の場所で書き換えられました。書きかけを選んでコピーしてから、「${w.cancelVerb}」を押し、もう一度「${w.openVerb}」で開いてください(${w.noun}が見つからないときは、「ノートを編集する」で開いて貼り付けてください)`;
}
function partialDraftAmbiguousNote(kind: PartialDraftKind): string {
  const w = PARTIAL_DRAFT_WORDS[kind];
  return `${w.ambiguousLead}、どの${w.noun}か決まりません(${w.noun}を編集し直してください)`;
}
export const SECTION_SAVE_MISMATCH_NOTE = partialDraftMismatchNote('section');
export const SECTION_SAVE_AMBIGUOUS_NOTE = partialDraftAmbiguousNote('section');
export const CODE_SAVE_MISMATCH_NOTE = partialDraftMismatchNote('code');
export const CODE_SAVE_AMBIGUOUS_NOTE = partialDraftAmbiguousNote('code');
/**
 * 🔴 **保存が断られた残り 2 つの理由**(#1044 段2 4巡目の修理、T2)。
 * ⚠ 直す前は `store-effects.ts` にリテラルで直書きしていた ── ここへ寄せたのは、
 *   `clearedSectionDraftAdvisory`(下)が**この字全部**を「下書き自身の断り文」
 *   として認識する必要があるため(§7:文言を 2 か所に書かない。手で書き直すと
 *   効果層(`store-effects.ts`)とここが食い違う日が来る)。
 * ⚠ **「別のウィンドウが…」は種類を名乗らない**(章 / コードのどちらでも同じ字)──
 *   種類の言葉を持たない字を、無理に words 表から組まない。
 */
function partialDraftNotFoundNote(kind: PartialDraftKind): string {
  return `${PARTIAL_DRAFT_WORDS[kind].noun}を保存できませんでした(ノートが見つかりません)`;
}
export const SECTION_SAVE_NOT_FOUND_NOTE = partialDraftNotFoundNote('section');
export const CODE_SAVE_NOT_FOUND_NOTE = partialDraftNotFoundNote('code');
export const SECTION_SAVE_ANOTHER_WINDOW_NOTE =
  '別のタブまたはウィンドウがこのノートを書き換えたため、保存できませんでした(もう一度押してください)';

/** {@link replaceSectionByHeading} の失敗理由 → user に見せる字。 */
export function sectionSaveFailureNote(reason: 'missing' | 'ambiguous' | 'mismatch'): string {
  return reason === 'ambiguous' ? SECTION_SAVE_AMBIGUOUS_NOTE : SECTION_SAVE_MISMATCH_NOTE;
}
/** {@link replaceCodeFenceContent} の失敗理由 → user に見せる字(#1044 段3)。 */
export function codeSaveFailureNote(reason: 'missing' | 'ambiguous'): string {
  return reason === 'ambiguous' ? CODE_SAVE_AMBIGUOUS_NOTE : CODE_SAVE_MISMATCH_NOTE;
}

/**
 * 🔴 **章の欄自身の断り文だけを消す**(#1044 段2 2巡目の修理、R5。5巡目の修理、U3で
 *   「字の集合」から「`state.sectionAdvisory` との等値」へ変えた)。
 *
 * ⚠ 直す前は `SECTION_DRAFT_ADVISORY_TEXTS`(固定の字の集合)との一致で判定していた。
 *   3巡目の修理(S1)で章の保存が effect 化され、保存を断られた理由
 *   (`SECTION_SAVE_FAILED.error`)が `state.error` に直に乗るようになったが、
 *   **`REQUEST_SECTION_SAVE` の catch-all**(「章を保存できませんでした: <e>」── 例外の
 *   `String(e)` を埋め込む**中身が動く字**)は固定の集合に入れられないので漏れ、
 *   保存が成功した後も画面には**古い catch-all の失敗の字が残った**。
 * 🔑 **消してよいのは、いま出ている error が「いま章の欄自身が置いた字」であるときだけ**。
 *   判定は字の中身ではなく「置いたのが章の欄自身か」(`sectionAdvisory` との等値)── これなら
 *   中身が動く字も等値で通る。他の失敗(disk 書込エラー・commit の不変量違反など無関係な知らせ)
 *   は握りつぶさない(main.ts の「OP_FAILED は SELECT_ENTRY が消す」と同じ寿命の考え方 ──
 *   消すのは「その断りを起こした状況が解けた」ときだけ)。
 * ⚠ **`SECTION_DRAFT_RELOADING_NOTE` は無くなった**(#1044 段2 3巡目の修理、S1)──
 *   保存は disk から読み直すので、`openBody` の読み直し中かどうかを断り文で
 *   分ける理由が無くなった(SAVE_SECTION_DRAFT の docstring 参照)。
 * ⚠ **`error` が別の字で上書きされていたら、控えは自動的に無効になる**(等値が
 *   成り立たないので消えない)── 明示的な無効化を書く必要は無い。
 * @returns `error` と `sectionAdvisory` を両方まとめて返す ── 呼び手は
 *   `...clearedSectionDraftAdvisory(state)` の形でスプレッドする(章の欄が閉じる /
 *   開き直る箇所では、控えも必ず `null` に戻す)。
 */
export function clearedSectionDraftAdvisory(state: {
  readonly error: string | null;
  readonly sectionAdvisory: string | null;
}): { error: string | null; sectionAdvisory: null } {
  const isOwn = state.sectionAdvisory !== null && state.error === state.sectionAdvisory;
  return { error: isOwn ? null : state.error, sectionAdvisory: null };
}

/**
 * 🔴 **章の欄が、system command(別タブの書込・入れ替え・再読込)で閉じたときの字**
 * (#1044 段2、`guardSectionDraftTransition` 参照)。
 * ⚠ 断り(user が押した操作を拒む)ではなく**知らせ** ── 書きかけは戻せないことを言う。
 *
 * 🔴 **「消えたか入れ替わった」と決めつけない**(#1044 段2 2巡目の修理、R2)。
 * ⚠ 直す前の字は「このノートが別の場所で消されたか入れ替わったため」だった ──
 *   ここへ来る回の多くは**このノートは消えても入れ替わってもいない**(別の場所の
 *   操作が `selectedLid` を動かしただけ)。事実と違う理由を言うと、user は
 *   起きていないことを気にする(このノートを探しに行く・壊れたと思う)。
 *   RESTORE_TRASH / RESTORE_REVISION は R2 で起点から断るようにしたので、
 *   ここへ来るのは**このタブの外**(別タブの container 切替・再読込)だけになった。
 */
function partialDraftClosedBySystemNotice(kind: PartialDraftKind): string {
  return `別の場所の操作でこのノートが切り替わったため、${PARTIAL_DRAFT_WORDS[kind].noun}の編集を終えました(書きかけは保存されていません)`;
}
/** ⚠ 既存の名前・値のまま(段2 で出荷済み)。 */
export const SECTION_DRAFT_CLOSED_BY_SYSTEM_NOTICE = partialDraftClosedBySystemNotice('section');
export const CODE_DRAFT_CLOSED_BY_SYSTEM_NOTICE = partialDraftClosedBySystemNotice('code');

/**
 * 🔴 **user に見せる「押せない理由」**(#516 / #715 / #761 / C11)。押せるなら `null`。
 *
 * 🔑 **押せないボタンに添える字は、ここ 1 か所**(CLAUDE.md §7)── 乗せたときの字
 *   (`title`)も、右の列の上の 1 行も、左の列の「+ ノート」も、同じ関数から採る。
 * ⚠ **C11(#1045、2026-09-25)で 1 本にした。** 直す前は隣に `phaseDisabledNote` が
 *   在り、編集中の字だけが「編集中は使えません ── **確定するか取り消して**ください」
 *   だった ── 右の列では、**乗せたときの字**(こちら)と**列の上の 1 行**
 *   ({@link EDITING_NOTE})が、同じ画面で別の出口を言っていた。
 * ⚠ `phase !== 'ready'` を「編集中」と読み替えない(#516)── 保存に失敗して
 *   止まったときは、出口が「再保存」1 つしか無い({@link phaseBlockReason} を見よ)。
 */
export function blockedActionNote(phase: AppPhase): string | null {
  if (phase === 'ready') return null;
  if (phase === 'editing') return EDITING_NOTE;
  if (phase === 'error') return `保存に失敗しているので使えません(${SAVE_FAILED_EXIT}使えます)`;
  return '読み込み中は使えません';
}

/**
 * 🔴 **画面のどこかに、まだ保存していない打ちかけがあるか**(#1044 段2、F-C)。
 *
 * 🔑 「書きかけを守る」ための判定(reload の確認 / 別タブへの通知 / 編集権を
 *   取られたことを言うかどうか、など)は**必ずここを通す** ── 個別に
 *   `phase === 'editing'` だけを見ると、章の欄(`sectionDraft`。`phase` は
 *   `ready` のまま保つ設計 ── 設計 doc §3)の打ちかけを見落とす。
 * ⚠ **`main.ts` の `location.reload()` 前の確認がまさにこの穴を踏んでいた**
 *   (`onContainerWiped` / 更新の案内の `isEditing`)── 章の欄に打っていても、
 *   聞かずに読み込み直していた。
 */
export function hasUnsavedTyping(state: AppState): boolean {
  return state.phase === 'editing' || state.sectionDraft !== null;
}

/**
 * 🔴 **打ちかけを持っているノートの lid**(#1044 段2、F-C)。無ければ `null`。
 *
 * ⚠ 全文編集と章の欄は**同時に開かない**(章の欄は `phase !== 'ready'` では開かない ──
 *   設計 doc §3 / `OPEN_SECTION_DRAFT` の phase 検査)ので、優先順位ではなく
 *   単純な二択でよい。⚠ **`edit-lock-release.ts` の `heldLidOf` と同じ式**
 *   ── そちらは 2 つ目の実装を作らず、ここを呼ぶ(§7)。
 */
export function unsavedTypingLidOf(state: AppState): string | null {
  if (state.phase === 'editing') return state.openBody?.lid ?? null;
  // 🔴 **保存に失敗して止まっている間も、未達の字がある限り握る**(#1087)。
  //   ここで錠を返すと別のタブが同じノートを取って保存でき、「再保存」(RETRY_PERSIST)が
  //   それを黙って上書きする。
  if (hasUnreachedCommit(state)) return state.openBody!.lid;
  return state.sectionDraft?.lid ?? null;
}

/**
 * 🔴 **保存に失敗して止まっていて、最後に commit した字(`baseline`)がまだ disk(`persisted`)に
 * 届いていないか**(#1087)。⚠ その字の唯一の写しがこのタブの `openBody` にある ──
 * `RETRY_PERSIST` の「未達の証拠」と同じ式。
 */
export function hasUnreachedCommit(state: AppState): boolean {
  const ob = state.openBody;
  return state.phase === 'error' && ob !== null && ob.baseline !== ob.persisted;
}

/**
 * 🔴 **本文を書き換える操作の門(lid で判定)**(C6 / #1043)。
 *
 * ⚠ `phaseBlockReason` は **phase だけ**を見るので、`editing` のときは
 *   **編集中のノートと無関係な他ノートの書込まで**止めていた ── 横に留めた枠
 *   (スタック / 2 ペイン)のチェック・表のセル・表の形・表の書式・繰り返し・
 *   Todo の状態が、編集中はどれも押しても効かなくなっていた(いちばん多い
 *   dead click)。⚠ 主のノート自身の本文は、編集欄が持つ下書きと disk が
 *   ずれる(下書きを保存すると押した変更が消える)ので、そこだけは今までどおり断る。
 *
 * 🔑 断るのは 4 つだけ:①`editing` で、かつ **`lid` が編集中のノートと同じ**
 *   とき ②`error`(保存に失敗して止まっている。出口は「再保存」1 つだけ)
 *   ③`initializing`(読み込みが終わっていない)④🔴 **章の欄が、その `lid` で
 *   開いているとき**(#1044 段2 ── 章の欄は `phase` を `ready` のまま保つので、
 *   ①〜③では捕まらない。同じ理由で**別の lid** なら通す)。
 *   **`editing` で別の lid** なら通す ── 編集中のノート自身がどれかは
 *   `openBody.lid`(#1049 の裁定で 1 本になった「編集の対象」)で見る。
 *
 * @returns 断るなら`{@link phaseBlockReason}` と同じ形の前置き。書いてよいなら `null`。
 */
export function bodyWriteBlockReason(state: AppState, lid: string): string | null {
  // ⚠ `?.`(`!== null` ではない)── 手組みの state fixture は `sectionDraft` を
  //   持たない(`undefined`)ことがある。`!== null` は `undefined` を素通しする
  //   (2026-09-26、全量 test の `detail.ts` と同じ罠)。
  if (state.sectionDraft?.lid === lid) return partialDraftBlockedNote(partialDraftKind(state.sectionDraft));
  if (state.phase === 'editing')
    return state.openBody?.lid === lid ? phaseBlockReason('editing') : null;
  return phaseBlockReason(state.phase);
}

/**
 * 🔴 **`bodyWriteBlockReason` の断りに、操作ごとの続き(「チェックしてください」等)を付ける**(#1087)。
 *
 * ⚠ 断りは 2 つの形がある ── phase 由来は**前置き**(「編集を保存するか、編集をやめてから」)、章 / コードの欄は
 *   **言い切りの文**(「章を編集中は使えません(…を押すと戻ります)」)。言い切りの後ろへ続きを
 *   繋ぐと「…戻ります)チェックしてください」と文が壊れる(直す前は 17 か所がこの形だった)。
 * 🔑 続きを付けるのは前置きのときだけ。呼び手は必ずここを通す(`${blocked}…` を手で組まない)。
 */
export function blockedWithSuffix(blocked: string, suffix: string): string {
  return PARTIAL_DRAFT_OWN_NOTES.has(blocked) ? blocked : `${blocked}${suffix}`;
}

/**
 * 🔴 **`bodyWriteBlockReason` が断ったときの `ReduceResult` そのものを組む**
 *   (#1044 段2 5巡目の修理、U3)。
 *
 * ⚠ この門を通す呼び手のうち、**章の欄の断り文をそのまま `error` へ置く回**
 *   (`APPEND_TO_ENTRY` / `UNDO_APPEND` / `UNDO_MOVE` / `ADOPT_EXTERNAL_IMAGES`)だけが
 *   対象 ── 続きを付ける回(`blockedWithSuffix(blocked, '表を打ってください')` 等)は
 *   `sectionAdvisory` を立てないので、字が同じでも「章の欄自身の断り文」としては扱われない
 *   (消えない/引き継がれない。直す前と同じ振る舞い。範囲を広げない)。
 * 🔴 **`suffix` は phase 由来の断りにだけ付ける**(#1051)。⚠ `bodyWriteBlockReason` は
 *   章の欄なら**言い切りの文**(「章を編集中は使えません(…)」)を、phase なら
 *   **前置き**(「編集を保存するか、編集をやめてから」)を返す ── 前置きだけを `error` に置くと
 *   「編集を保存するか、編集をやめてから」で文が切れる。直す前は呼び手の手前に `phase !== 'ready'` の
 *   **無言の門**が在ったので、ここへ来るのは言い切りの文だけだった。
 * 🔑 `blocked` が `SECTION_DRAFT_NOTE`(章の欄が原因)のときだけ `sectionAdvisory`
 *   も同時に控える ── phase 由来の断り(編集中 / 読み込み中)は章の欄と無関係なので
 *   `sectionAdvisory` に触らない。
 * @returns 断るなら `ReduceResult`。書いてよいなら `null`(呼び手はそのまま続ける)。
 */
export function bodyWriteBlockResult(state: AppState, lid: string, suffix: string): ReduceResult | null {
  const blocked = bodyWriteBlockReason(state, lid);
  if (blocked === null) return null;
  // ⚠ 章 / コードのどちらでも同じ扱い(#1044 段3) ── PARTIAL_DRAFT_OWN_NOTES 参照。
  const own = PARTIAL_DRAFT_OWN_NOTES.has(blocked);
  return {
    state: {
      ...state,
      error: blockedWithSuffix(blocked, suffix),
      ...(own ? { sectionAdvisory: blocked } : {}),
    },
    events: [],
  };
}

/**
 * 🔴 **「章の欄が開いている(のに別の操作を試みた)」を断る、その場の 1 手**
 *   (#1044 段2 5巡目の修理、U3)。
 *
 * ⚠ 直す前は `error: SECTION_DRAFT_NOTE` だけを置く同じ形が 5 か所(`START_EDIT` /
 *   `OPEN_SECTION_DRAFT` の二重に開く門 / `RESTORE_REVISION` / `RESTORE_TRASH` /
 *   `guardSectionDraftTransition` の user action 分岐)に**別々に**書かれており、
 *   `sectionAdvisory` を足すとなると 5 か所を揃えて直す必要があった(§7)。
 *   ここへ寄せて、5 か所とも呼ぶだけにする。
 *
 * 🔴 **#1044 段3 ── どちらの種類が開いているかで字を変える**。⚠ **いま開いている
 *   下書きの種類**(`state.sectionDraft`)で決める ── これから開こうとしている
 *   種類ではない(二重に開かない門は「先に居るほうを勝たせる」設計 ── §9)。
 */
export function sectionDraftBlockedResult(state: AppState): ReduceResult {
  const note =
    state.sectionDraft === null
      ? SECTION_DRAFT_NOTE
      : partialDraftBlockedNote(partialDraftKind(state.sectionDraft));
  return { state: { ...state, error: note, sectionAdvisory: note }, events: [] };
}

/**
 * 🔴 **もう一度押したら本文へ戻る**(P8 段⑲ の規約を 1 か所へ寄せた。#277 段②-b)。
 *
 * 直す前の 設定 は行きっぱなしで、閉じる導線がどこにも無かった ── user から見ると
 * 「画面から出られない」。⚠ その規約は `set-view`(上の帯)にだけ書いてあり、
 * **組み込みタイルから開く面**(2 ペイン #241 / カレンダー #276 / カンバン #277)は
 * 素通りしていた ── **開いたボタンをもう一度押しても閉じない**。
 *
 * ⚠ **この規則が唯一の帰り道になった**(2026-08-20 に訂正)。2026-08-19 の時点では
 *   「左の探し方のタブを押せば `setBrowse` が本文へ戻す」とここに書いてあり、それは
 *   当時は事実だった ── しかし**その一律の畳みこそが、カレンダーの閉ループの正体**
 *   だったので、`main.ts` の `setBrowse` は `isAsidePane` だけを畳む形へ直した。
 *   いま **カレンダー / カンバン / 集計** の帰り道は、この関数(タイルの再押下)と
 *   `Alt+1` の 2 本である。⚠ わきの面(設定 / フラグ / ヘルプ / 2 ペイン)は
 *   今までどおりタブでも畳む。
 *
 * 🔑 だから規則をここに 1 つ置き、**帯もタイルも同じ関数**を通す(CLAUDE.md §7)。
 */
export function nextViewMode(current: ViewMode, want: ViewMode): ViewMode {
  return current === want ? 'detail' : want;
}

/**
 * 🔴 **「押した側が元になる」は、場所が変わらなくても成り立つ**
 * (2026-08-19、リリース前監査で判明)。
 *
 * ⚠ 直す前は「pane が同じ object なら丸ごと捨てる」だったので、
 * **焦点の無い側の「いま開いているタブ」や「いま居る場所のパンくず」**を押しても
 * 枠も向きも動かなかった ── 他の押し方(行 / + / × / 別のタブ / 別の場所)は
 * 全部焦点を持っていくので、**この 2 つだけが例外**という気づけない形だった。
 * ⚠ マニュアルは「押したほうのペインに枠が付き」と言い切っており、
 * 同じ節で「押しても何も起きないボタンは置きません」とまで書いている。
 */
/**
 * 🔴 **下見に映すべきもの**(#273 残件)── 焦点のあるペインのカーソルの行。
 *
 * ⚠ **フォルダは映さない** ── フォルダに本文は無いので、読みに行っても空が返る
 *   (「読めなかった」と「空だった」が見分けられなくなる)。
 * 🔑 判定はここ 1 か所 ── 呼び手ごとに書くと、ある経路だけ古い行を映し続ける。
 */
export function dualPreviewTarget(state: AppState, dual: DualState): string | null {
  const lid = paneOf(dual, dual.focus).cursor;
  if (lid === null) return null;
  const meta = state.entryMetas.get(lid);
  if (meta === undefined || meta.archetype === 'folder') return null;
  return lid;
}

/**
 * 🔴 **2 ペインの state を差し替える唯一の出口**(#273 残件)。
 *
 * ⚠ 下見の読み直しを**ここ 1 か所**で決める ── `DUAL_SET_CURSOR` / `DUAL_SELECT` /
 *   `DUAL_FOCUS` / 場所の移動と、カーソルが動く経路は複数ある。呼び手ごとに
 *   「読み直すか」を書くと、**ある経路だけ前の行の本文を映し続ける**
 *   (CLAUDE.md §7「同じ判定が複数の場所にある」)。
 */
/**
 * 🔴 **その場所がスマートフォルダなら、集め直しを頼む**(#421 段①)。
 *
 * ⚠ 判定はここ 1 か所 ── 左の列も 2 ペインの左右も、場所が変わる経路は
 *   いくつもある。呼び手ごとに書くと**ある経路だけ集め直さない**
 *   (症状は「押したのに前の並びのまま」という、いちばん気づけない形)。
 */
export function smartScanFor(state: AppState, lid: string | null): DomainEvent[] {
  if (lid === null) return [];
  if (state.entryMetas.get(lid)?.archetype !== SMART_ARCHETYPE) return [];
  return [{ type: 'REQUEST_SMART_SCAN', lid }];
}

export function withDual(state: AppState, dual: DualState): ReduceResult {
  /**
   * ⚠ **何も変わらないなら state ごと同じものを返す** ── 新しい object を返すと、
   *   「押しても何も変わらない」場面で**面が毎回組み直る**(この面の門は
   *   `state.dual` の参照 1 本で変化を見ているので、参照が変われば必ず描き直す)。
   */
  /**
   * ⚠ **場所が変わった側だけ**集め直しを頼む(#421 段①)── 毎回頼むと、
   *   カーソルを 1 行送るたびに全件走査が走る。
   */
  const scans: DomainEvent[] = [];
  for (const side of ['left', 'right'] as const) {
    const to = paneScope(paneOf(dual, side));
    if (to !== paneScope(paneOf(state.dual, side))) scans.push(...smartScanFor(state, to));
  }
  const done = (next: DualState, events: DomainEvent[] = []): ReduceResult => ({
    state: next === state.dual ? state : { ...state, dual: next },
    events: [...scans, ...events],
  });
  const target = dualPreviewTarget(state, dual);
  if (!dual.previewOn || target === null)
    return done(dual.preview === null ? dual : { ...dual, preview: null });
  if (dual.preview?.lid === target) return done(dual);
  return done(dual.preview === null ? dual : { ...dual, preview: null }, [
    { type: 'REQUEST_DUAL_PREVIEW', lid: target },
  ]);
}

export function withDualFocus(state: AppState, side: DualSide): ReduceResult {
  if (state.dual.focus === side) return withDual(state, state.dual);
  return withDual(state, { ...state.dual, focus: side });
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

/**
 * 🔴 **章だけの下書き**(#1044 段2)。
 *
 * ⚠ **原文は見出し行を含む**(`章の範囲 = 見出し(#〜###) から 次の同格以上の
 *   見出しの手前まで`。`@features/markdown/append-target.ts` の `sectionRange`)。
 */
export interface SectionDraft {
  readonly lid: string;
  /** 見出しの字。保存のとき、これで章を**名前で**探し直す(行番号ではない)。 */
  readonly heading: string;
  /** 開いたときに控えた、この章の原文(見出し行を含む)。保存時の一致判定に使う。 */
  readonly original: string;
  /**
   * 🔴 **保存の要求を disk へ出してから、ack が返るまで**(#1044 段2 3巡目の修理、S1)。
   *
   * ⚠ **追記の `writeLock` と同じ理由で要る** ── 保存は disk から読み直して
   *   差し替えるので、ack が届くまで結果が分からない(全文編集の保存と違い、
   *   `state.openBody.body` を楽観的に進められない)。⚠ 二重押し・「やめる」・
   *   離れる操作は**この間だけ**箱の押せない見た目で塞ぐ(`binder.ts` / `detail.ts`)。
   */
  readonly saving: boolean;
}

/**
 * 🔴 **コード枠だけの下書き**(#1044 段3)。
 *
 * ⚠ **{@link SectionDraft} と「同じ器」を分け合う**(§9)── `openLine` を持つのが
 *   {@link CodeDraft}、`heading` を持つのが `SectionDraft` なので、`'heading' in draft`
 *   で見分けられる({@link isCodeDraft})。⚠ **判別用の `kind` field は増やさない** ──
 *   増やすと既存の(段2 で出荷済みの)fixture・test が `SectionDraft` を組む所すべてに
 *   `kind: 'section'` を書き足す破壊的変更になる(CLAUDE.md §9「置き換えの作法」と
 *   同じ向き ── 器を替えるなら、既存の読み手が困らない形を選ぶ)。
 */
export interface CodeDraft {
  readonly lid: string;
  /** 開いたときに控えた、この枠の中身(引用の前置きを剥がした後。開き・閉じの行は含まない)。 */
  readonly original: string;
  readonly saving: boolean;
  /** 開きの行(生の body の行番号)。行がずれていなければ、まずここで探す。 */
  readonly line: number;
  /** 開きの行の字(引用の前置きを剥がした後)。行がずれたときの身元の一部。 */
  readonly openLine: string;
  /** 引用の深さ(0 = 引用の外)。 */
  readonly quote: number;
}

/**
 * 🔴 **「部分の下書き」── 章の欄とコード枠の欄を、同じ 1 つの機構で持つ**
 * (#1044 段3、§9)。
 *
 * ⚠ **field 名は `sectionDraft` のまま**({@link AppState.sectionDraft})── 段2 が
 *   出荷した名前を変えると、値の形は変わっていないのに 9 test file(123 箇所)が
 *   触る field 名だけの理由で書き直しになる。**一般化するのは型(この union)だけ**
 *   にした(CLAUDE.md「field 名を変えるなら tsc に全数を追わせる」の逆 ──
 *   変えない選択をしたので、既存の `SectionDraft` を組む fixture は 1 行も直っていない)。
 */
export type PartialDraft = SectionDraft | CodeDraft;
export type PartialDraftKind = 'section' | 'code';

/** `draft` が {@link CodeDraft} か(= `SectionDraft` が必ず持つ `heading` を持たない)。 */
export function isCodeDraft(draft: PartialDraft): draft is CodeDraft {
  return !('heading' in draft);
}

function partialDraftKind(draft: PartialDraft): PartialDraftKind {
  return isCodeDraft(draft) ? 'code' : 'section';
}

/** 履歴一覧の 1 行(P5b)。boot では持たない ── SHOW_HISTORY の要求時に引く。 */
export interface RevisionItem {
  id: string;
  revOrder: number;
  createdAt: string | null;
  title: string | null;
  /**
   * 🔴 **この版と、1 つ新しい版の違い**(#398 段①)。
   *
   * > user の物語: 履歴に同じ題名が並び、**どれが目当ての版か押すまで分からない**。
   *
   * ⚠ 向きは **user が読む向き**(この版 → 1 つ新しい版)。裏返しは worker の中で
   *   済ませてある ── ここで数え直さない(§7)。
   * ⚠ `null` = **数えられない**(全文で持っている版)。0 と潰さない ──
   *   0 は「変わっていない」で意味が違う。
   */
  added: number | null;
  removed: number | null;
}

/**
 * 🔴 **「探す」から塗っている控え**(#1102 段①)── {@link AppState.searchJump}。
 */
export interface SearchJump {
  /** 塗っているノート。⚠ これと `selectedLid` が食い違ったら消える。 */
  readonly lid: string;
  /** 探した語(整え済み)。⚠ 当たりの数え方は `features/filter/search-hits.ts` の 1 本。 */
  readonly query: string;
  /** 送りを進めた回数(負もあり)。⚠ 位置は描く側が数で畳む。 */
  readonly step: number;
  /** START / 送りのたびに進む。 */
  readonly gen: number;
  /**
   * 🔴 **何から始めた塗りか**(#1102 段②)。`find` = 「探す」の行から / `filter` = 左の列の欄に語が
   *   入っている間に行を押して。⚠ 違いは**消え方だけ** ── `filter` は欄の語が空になったら一緒に消え、
   *   `find` は欄を触っても残る(欄は「探す」から来た塗りの持ち主ではない)。後から始めた側が勝つ
   *   (塗りは 1 つしか持たない)。
   */
  readonly origin: 'find' | 'filter';
}

/** ゴミ箱一覧の 1 行(= entries に居ない entry_lid の最新 revision)。 */
export interface TrashItem {
  revId: string;
  entryLid: string;
  createdAt: string | null;
  title: string | null;
  archetype: string | null;
}

/**
 * 🔴 **履歴の面で、見ている版をくらべる相手**(#1231 段①。🟣 Gemini 裁定 2026-10-02 Q2 = A + C)。
 * `current` = いまの本文(既定)/ `rev` = 履歴の別の版 / `file` = そのノートが結びついている PC のファイル。
 * ⚠ **見るだけ** ── どれを選んでも 1 バイトも書かない。
 */
export type RevisionCompare =
  | { kind: 'current' }
  | { kind: 'rev'; revId: string; load: RevisionCompareLoad }
  | { kind: 'file'; load: RevisionCompareLoad };

/** 相手の中身を読む進み具合。⚠ `failed` を `loaded` + 空の字と**潰さない**(読めなかったのに「同じ」と言わない)。 */
export type RevisionCompareLoad =
  | { state: 'loading' }
  /** `tooLarge` = PC のファイルが大きすぎて読まなかった(読めなかったのと字を分ける)。 */
  | { state: 'failed'; tooLarge?: true }
  | { state: 'loaded'; text: string };

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
   * 🔴 **「中まで全部出す」**(#813 段②。🟣 Gemini 裁定 2026-10-01 の C)。
   *
   * 入のとき、左の列の「フォルダ」の表は**いま居る場所の配下を階層をまたいで全部**
   * 平らに出す(ルートで入れれば全件、フォルダの中で入れればそのフォルダの配下だけ)。
   * 切 = 直下だけ(いままでどおり)。
   *
   * ⚠ **現在地とは別の値**である ── 入れたままフォルダへ降りると、その配下の全部が出る
   *   (現在地に追従)。パンくずで戻っても入り切りは保つ。
   * ⚠ **この端末に憶える**(`FilerFlattenStore`)── 起動で 1 度だけ写す(`main.ts`)。
   *   ノートのデータではなく、見え方である(container に入れない)。
   * ⚠ 2 ペインの面は持たない(`filerRows` へ `flatten: false` を渡す)。
   */
  filerFlatten: boolean;
  /**
   * 🔴 **左の列の行で、名前を打ち替えている lid**(#215)。`null` = 打ち替えていない。
   *
   * ⚠ **state 駆動**で入力欄を出す(2 ペインの `dual.renaming` と同じ作法)── DOM を
   *   直に差し替えると、別タブの保存が届いて面が組み直された瞬間に**打っている最中の
   *   入力が消える**。⚠ 確定は既存の `RENAME_ENTRY_TITLE` を撃つ(改名の規則を 2 つ作らない)。
   * ⚠ 消えた lid は指し続けない(`removeEntryFromState` が畳む ── 確定した瞬間に
   *   どこにも無い lid へ改名が飛ぶのを止める)。
   */
  renamingLid: string | null;
  /**
   * 🔴 **2 ペインタブファイラの持ち物**(#241 段⑥)。
   *
   * ⚠ 上の `scopeLid` / `selection` は**左の列(探し方)のもの**で、こちらは
   * **中央の 2 ペイン面のもの**である。同じ「どこを見ているか」でも、
   * **窓が違えば別の答えでよい** ── ファイラの窓を 2 枚開くのと同じ。
   * 🔑 規則(`filerRows`)は 1 本のまま ── 増えるのは *state* だけである。
   */
  dual: DualState;
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
  /**
   * 🔴 **横に並べて留めたノート**(#505 段②。user 指示 2026-08-28)。
   *
   * > 「ウルトラワイドモニター用に閲覧時にセンターペインを任意分割して、
   * > **複数ドキュメントを開いたり**…」
   *
   * ⚠ **主の枠は `selectedLid`** であって、ここには入らない ── 主は一覧を押すたびに
   * 変わり、こちらは **user が留める / 外すときだけ**変わる。混ぜると
   * 「押した瞬間に相手が消える」= 突き合わせが成立しない。
   * 🔑 並びは**留めた順**。上限と正規化は `features/split-frames.ts` が 1 か所で持つ。
   */
  splitLids: readonly string[];
  /**
   * 留めた枠に出す本文。⚠ **無い = まだ読めていない**(空文字ではない)。
   *
   * ⚠ `openBody` とは**別の入れ物**である ── あちらは「編集しうる 1 件」、
   * こちらは「**映すだけ**の N 件」。同じ口に混ぜると、留めた枠の本文が
   * 編集中の下書きを踏む(`REQUEST_DUAL_PREVIEW` を分けたのと同じ理由)。
   */
  splitBodies: ReadonlyMap<string, string>;
  /**
   * 🔴 **板に置いたノートの、板に出す分の本文**(#529 W3-①)。
   *
   * ⚠ `splitBodies` とは**別の入れ物**である ── あちらは全文(留めた枠は読むための本文そのもの)、
   *   こちらは **`PLACE_BODY_CLIP` 字までに切った抜粋**で、**書込の元にしてはならない**
   *   (切った本文から行番号を取って書き戻すと、残りが消える)。
   *   `screenBodyOf` が見ないのはこのためである。
   * 🔑 上限 `PLACE_BODY_CAP` 件(古い物から手放す)── 常駐が板の枚数に比例して伸びない。
   * ⚠ **無い = まだ読めていない**(空文字ではない)。
   * ⚠ 手組みの fixture には無いので、読むときは `placeBodiesOf` を通す。
   */
  placeBodies: ReadonlyMap<string, PlaceExcerpt>;
  /**
   * 🔴 **いま開いている拡張の窓**(#195 / C-5 段②-b)。
   *
   * ⚠ **なぜ state に載せるのか** ── 台帳の実体は
   * `adapter/platform/extension-links.ts`(常駐の singleton)に在り、
   * 「送る」だけならそこを直に読めば足りる。**しかしそれでは画面が変わらない。**
   * 🔴 2026-08-25(#393)に実際に踏んだ: 許可を憶えても、詳細の指紋は
   * **state しか見ていない**ので `render` が早期 return し、
   * user から見ると「押したのに何も起きない」になった。
   * 🔑 だから**窓が開いた / 閉じたことを state へ写す** ── 指紋が動けば、
   * 描き直しの仕掛けを別に足さなくてよい(`invalidate` の呼び忘れが起きない)。
   *
   * ⚠ ここに入るのは**名札だけ**(id / appId / 題名)である ── 窓そのものも港も
   * 入れない(state は素のデータに保つ)。実際に送るのは台帳の側。
   */
  openExtensions: readonly OpenExtension[];
  /** 直近 CREATE_ENTRY で作られ、まだ一度も commit / rename されていない lid。
   *  「未編集のまま cancel」で掃除する(PKC2 の空 entry 堆積の対策 ── P3-7a)。 */
  freshLid: string | null;
  viewMode: ViewMode;
  /** calendar の表示月(null = 今日の月を renderer 側で解決)。 */
  calendarMonth: { year: number; month: number } | null;
  /**
   * 予定の面の見せ方(#855 段 A-1)。`list` = 日ごとの一覧(既定)/ `day` = 1 日を時間の目盛りに並べる / `week` = 7 日を並べる(広い面だけ ── 左の列は別のウィンドウで開く。#855 段 A-2)/ `month` = 1 か月を大きな升目で見る(広い面だけ。#855)。
   * ⚠ 保存しない(開き直したら一覧に戻る)── 見え方の一時の選びであって、ノートの中身ではない。
   */
  scheduleMode: 'list' | 'day' | 'week' | 'month' | 'board';
  /**
   * 🔴 **左の列(狭い面)の予定の見せ方**(#855 段 A-2 の直し)。`list` / `day` だけ(既定は一覧。保存しない)。
   * ⚠ 狭い面だけがこれを読み、広い面(中央 / 別のウィンドウ)は `scheduleMode` だけを読む ──
   *   共有すると、週のために開いた窓の左の列で「日」「一覧」を押すと**中央の週が消える**。
   * ⚠ 見ている日(`scheduleDay`)は 2 つの面で**共有する**(小さな月の日を押すと両方が同じ日を見る)。
   */
  scheduleNarrowMode: 'list' | 'day';
  /** `day` で見ている日(`YYYY-MM-DD`)。`null` = 今日(日付が変わったら追従する)。 */
  scheduleDay: string | null;
  /** calendar で archived todo を見せるか(PKC2 の showArchived と同じ意味論)。 */
  showArchived: boolean;
  /**
   * 🔴 **板で「完了」を開いているか**(2026-08-20。設計 doc §4-4)。
   *
   * ⚠ **既定は閉じている** ── 直す前は完了した札が「完了」列に打ち消し線で
   *   **残り続けて**いた。市井の 6 実装を当たったが、**この形は 1 つも無かった**
   *   (どれも畳むか、別の場所へ落とす)。⚠ 畳んでも**件数は必ず見せる** ──
   *   黙って消すと「やったはずのものが無い」になる。
   * ⚠ `showArchived` とは別物である ── あちらは「片付けたノート」、
   *   こちらは「済んだ**行**」。同じ切替に相乗りさせない。
   * ⚠ 保存しない(その場の見え方)── `showArchived` と同じ扱い。
   */
  showDoneTasks: boolean;
  /**
   * 🔴 **日付のない項目も出すか**(user 指示 2026-08-23。既定 **false**)。
   *
   * > 「**そもそもすべての本文に存在するチェックリストが、なぜ看板として表示される
   * > のか意味がわからない。文章の体裁としてチェックリストを使いたい場面もある。
   * > それが全て看板に出てくる。これはただのノイズだよ**」
   *
   * 🔑 既定で出すのは **`@2026-08-25` を書いた行**だけ ── それが「予定」である。
   * ⚠ ただし**捨てない。畳む** ── 「体裁のつもり」と「日付を書き忘れたやること」は
   *   本文から見分けられないので、片方だけ選ぶと必ず取りこぼす。
   *   1 押しで**全部の一覧が戻る**形にして、既定だけノイズ 0 にする。
   * ⚠ `showDoneTasks` / `showArchived` と**別の旗**である ──
   *   あちらは「済んだ行」「片付けたノート」で、こちらは「日付の有無」。
   * ⚠ 保存しない(その場の見え方)。
   */
  showUndatedTasks: boolean;
  /**
   * 🔴 **予定の面で、予定を隠しているノート**(#855。Gemini 裁定 = #1163 の依頼 20-A「このカレンダーだけ」)。
   *
   * 「出すもの」のノートの一覧で外したノートの lid。空 = どのノートも隠していない(既定)。
   * ⚠ **ノートそのものは隠さない**(左の一覧にも検索にも出る)── 予定の面から**そのノートの予定を外す**だけ。
   * ⚠ 保存しない(その場の見え方)── `showDoneTasks` / `showUndatedTasks` と同じ扱い。
   */
  scheduleHiddenNotes: readonly string[];
  /**
   * 🔴 **予定の面を、担当で絞る**(#283)。`null` = 全員(既定)/ `''` = 担当なし / それ以外 = その名前。
   * ⚠ 保存しない(その場の見え方)── `showDoneTasks` / `scheduleHiddenNotes` と同じ扱い。
   * ⚠ 絞るだけ ── ノートも予定も消さない(外せば全部戻る)。
   */
  scheduleOwner: string | null;
  /** 選択 entry の履歴 panel(P5b)。開いた時点のスナップショット ── 選択遷移 /
   *  編集開始 / view 切替で畳む。boot で revisions に触れない原則の受け皿。 */
  revisionPanel: { lid: string; items: readonly RevisionItem[] } | null;
  /**
   * 🔴 **戻す前に中身を見る**(#398 段②)。`null` = 見ていない。
   *
   * ⚠ **読み取り専用**である ── 「見ている版を編集できる」を作ると、
   *   保存したのがどちらなのか user から見えなくなる。
   * ⚠ 本文を持つのは**開いている 1 件だけ** ── 一覧の全件を持つと、
   *   履歴を開くだけで本文が N 本 heap に載る(常駐ゼロの規律に反する)。
   */
  revisionPreview: {
    lid: string;
    revId: string;
    body: string;
    /**
     * 🔴 **くらべる相手**(#1231 段①)。⚠ **見ている版と一緒に持つ** ── 版を閉じる・別のノートを選ぶ・
     *   別の版を開くと `revisionPreview` ごと入れ替わるので、相手も**自然に `current` へ戻る**
     *   (別に持つと、閉じたのに相手だけ残る)。
     */
    compare: RevisionCompare;
  } | null;
  /**
   * 🔴 **一時の知らせ**(#402 ①)。`null` = 何も出していない。
   *
   * ⚠ **`error` と別に持つ** ── 一括タグの結果は「3 件は既に付いていました」の
   *   ように**成功の内訳**であって、赤い帯に出す物ではない
   *   (`main.ts` が「エラー > 一時の知らせ」の順で組んでいるのと同じ考え)。
   * ⚠ 出す寿命は**次の知らせまで** ── 消す口を別に作らない。
   */
  notice: string | null;
  /**
   * 🔴 **押したのに入らなかったタグ**(#640 案 A。user 裁定 2026-09-04)── 欄へ戻して出す字。
   *
   * ⚠ タグを打つ欄は**押した瞬間に字を消す**(次の 1 つを打てるように)が、断りは
   *   効果層から**後で**来る。`#請求 #未払 #今月` と打って 3 つ目だけ上限に当たった人は、
   *   欄が空で理由の帯に名前が 1 つ出るだけだった ── 直すには打ち直しである。
   * 🔑 だから入らなかった名前を**欄ごとに**持ち、描く側が欄へ戻す(`filer.ts`)。
   *   全部通れば空のまま(これまでどおり)。押すたびに `CLEAR_REFUSED_TAGS` で 1 回ぶんへ戻す。
   * ⚠ 欄の名前は `TAG_INPUT_FIELDS` ── binder の `TAG_INPUT_ADD`(#639)と同じ綴りである。
   */
  refusedTags: Readonly<Record<TagInputField, readonly string[]>>;
  /**
   * 🔴 **その知らせの隣に「開く」で出す物**(#668 A)。`null` = 押す口を出さない。
   *
   * 添付を作ったのに本文へ入れなかった回(開いているのがフォルダ等)は、
   * 読んでいた物を開いたまま「添付にしました」と言う ── そのとき**その添付へ行く
   * 道が 1 つも無かった**(一覧は絞りで隠れていることがある)。
   * ⚠ `notice` と**対で**書く(`OP_NOTICE` が両方を置く)── 次の知らせで消える。
   */
  noticeOpen: string | null;
  /**
   * 🔴 **その知らせの隣に「○○のノートを作る」で出す日付**(#1169)。`null` = 出さない。
   *
   * 本文の `@2026-10-15` を押したのに、その日のノートが無かったとき、知らせと対で書く
   * (`OP_NOTICE` が両方を置く)。⚠ 出し入れは `status-open.ts` が**字の一致**で決める ──
   * 別の知らせに上書きされたら、この値が残っていても出ない(`noticeOpen` と同じ作法)。
   */
  noticeCreate: string | null;
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
   * 🔴 **種類の絞り(#411)。空 = 絞らない。**
   *
   * ⚠ **`filterQuery` と別に持つ**(語に混ぜない)── 混ぜると「語を消したのに
   *   絞りが残る / 札を外したのに語が消える」という、どちらが効いているのか
   *   user に読めない画面になる。⚠ 空集合を「1 件も出さない」と読まないこと
   *   (規則は `matchesEntry` 1 か所に在る)。
   */
  kindFilter: ReadonlySet<string>;
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
   * 🔴 **並びの向き**(2026-08-19、2 ペインの列見出しを押せるようにした)。
   * ⚠ **`entrySort` に埋め込まない** ── 「更新は降順」のような決め打ちを
   *   `sortOrder` の中に置いていたので、user が反転できなかった。
   * 🔑 既定は並びごとの自然な向き(`NATURAL_DESC`)。
   */
  entrySortDesc: boolean;
  /**
   * 🔴 **最近開いたノート**(#215 残り①)── lid → 最後に開いた時刻(epoch ミリ秒)。
   *
   * ⚠ **ノートのデータではない**(端末ごとの記録)ので container には入れない ──
   *   入れると書き出しに同乗し、**渡した相手にこちらの読んだ順が並ぶ**
   *   (`adapter/platform/opened-store.ts` の冒頭)。
   * 🔑 **それでも state に載せる理由**:並べ替えが読む値なので、ここに無いと
   *   描画器が store を直に読むことになり、**記録が増えても再描画が起きない**
   *   (指紋に入らないため ── §7「同じ値が複数の場所にある」の入口)。
   */
  openedAt: ReadonlyMap<string, number>;
  /**
   * 🔴 **一覧が「最近開いた順」を並べるときに読む記録**(依頼 274 / 334。Gemini 裁定 = B)。
   *
   * ⚠ `openedAt` は**開いた瞬間に動く**。それをそのまま一覧の並びに使うと、
   *   ①画面の行は動かないのに(押した行が跳ぶのを防ぐため描き直さない)
   *   ②↑↓ と Shift+クリックだけが「開いた後の並び」で数える、という食い違いが出る。
   * 🔑 だから**並びの材料は 1 本に寄せる**:この写しを一覧の描画・範囲選択・↑↓ の
   *   全員が読み、写しを更新するのは「一覧の見え方が変わるとき」(絞り込み・種類の札・
   *   並び順・フォルダの移動・平らにする・本文の当たり)と、記録を消したとき・起動時だけ。
   *   ノートを開いただけでは更新しない(`reduce` の `settleOpenedOrder`)。
   */
  openedAtShown: ReadonlyMap<string, number>;
  /**
   * `searchHits` が**どの問い合わせの結果か**。⚠ これが無いと、遅れて返った
   * 古い結果を新しい問い合わせの答えとして表示してしまう(打鍵は結果より速い)。
   */
  searchHitsQuery: string;
  /**
   * 🔴 **本文の当たりを上限(200 件)で切ったか**(#680)。⚠ worker は最初から
   * 返していたが、配線(`store-port.ts`)が捨てていたので**左の列は一度も言えなかった**。
   * 🔑 数は持たない ── worker は「切った」の真偽しか返さない(数え直しの 2 回目の
   *   問い合わせをしない作法)。だから字も「200 件より多く」で止める。
   * ⚠ `SET_ENTRY_FILTER` で `false` へ戻す ── 語を変えたのに前の語の「ほかにも
   *   あります」が残ると、0 件の語で「ほかにもある」と読める。
   */
  searchHitsTruncated: boolean;
  /**
   * 🔴 **本文の検索が失敗したか**(#1087)。⚠ 失敗を「0 件」と同じに見せると、左の一覧は
   *   「一致するものがありません」と**言い切る**(本文に在る語を、無いと読ませる)。
   * ⚠ `SET_ENTRY_FILTER` で `false` へ戻す(語を打ち直すと、もう一度探す)。
   */
  searchHitsFailed: boolean;
  /**
   * 🔴 **探す面**(#680)。⚠ `filterQuery` と**別に持つ** ── 面の語で左の一覧を絞らない。
   *
   * - `query`: 欄に打った語(打鍵ごとに写す ── renderer は DOM から読まない)
   * - `rows` / `rowsQuery`: 届いている結果と、**それがどの語の答えか**。
   *   `rowsQuery !== query` = まだ返っていない(その間も前の行は消さない ──
   *   打つたびに一覧が消えるとちらつく)。⚠ `searchHitsQuery` と同じ理由
   * - `truncated`: 200 件で切ったか(`searchHitsTruncated` と同じ作法)
   * - `failed`: 探せなかった(古い worker で op が無い / DB のエラー)── 「まだ」と
   *   区別しないと「探しています…」で永久に止まる(連絡先の `contactScanFailed` と同じ)
   */
  searchPage: SearchPageState;
  /** SQL を打つ面(#681 段②)。 */
  sqlPage: SqlPageState;
  /**
   * 🔴 **集計の面**(#184)。⚠ どれも `null` = **まだ読んでいない**(0 件ではない)。
   *
   * ⚠ 中身は**束ねた結果だけ**で、本文は 1 バイトも入らない ── 束ねるのは worker で、
   * 主スレッドへ来るのは「値 → lid の並び」だけである(題名は `entryMetas` に在る)。
   * ⚠ 束ねる key(`queryKey`)は**端末の設定**として覚える(ペインの開閉と同じ流儀)──
   * container には書かない。「どの列で見ていたか」は文書の性質ではなく作業の都合である。
   */
  /**
   * 🔴 **スマートフォルダの当たり**(#421 段①)。lid → 集めた結果。
   *
   * ⚠ **表 1 つで左の列も 2 ペインも読む** ── 同じスマートフォルダを 3 か所で
   *   開きうるので、面ごとに持つと**同じ問いに答える口が 3 つ**になる(§7)。
   *   鍵をスマートフォルダの lid にしておけば、走査は 1 回で済む。
   * ⚠ **入っていない = まだ集めていない**(0 件ではない)── 画面は
   *   「集めています…」と出す。⚠ `failed` は「この版では集められない」。
   */
  smartHits: ReadonlyMap<string, SmartHitState>;
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
   * 🔴 **いま使われているタグの一覧**(#494 段②)。打つ欄の候補に出す。
   *
   * ⚠ `null` = **まだ集めていない**(0 件ではない)── 欄に焦点が当たったときに
   *   1 度だけ集める。⚠ **常に集めない** ── 全ノートの frontmatter を舐めるので、
   *   使わない人に毎回払わせない。
   * 🔑 集めるのは **集計(`queryScan`)と同じ口**(`key = 'tags'`)── タグを数える
   *   走査を 2 本作らない(§7)。⚠ ただし**state は別に持つ** ── 集計の面と
   *   共有すると、集計を別の key で開いた瞬間に候補が消える。
   * ⚠ **タグを書いたら捨てる**(次の焦点で集め直す)── 付けたばかりのタグが
   *   候補に出ないと、user は「効いていない」と読む。
   */
  tagSuggestions: readonly string[] | null;
  /**
   * 候補を集めたときの `entryMetas`(#1087 の見直し)。⚠ 本文に `#タグ` を書いて保存した・ノートを消した・
   * 取り込んだ・別の窓が書いた、では `BODY_REWRITTEN` が走らず候補が古いまま残っていた。
   * 🔑 それらは全部 `entryMetas` を新しい Map にするので、**参照が違えば集め直す**(経路を数えなくて済む)。
   */
  tagSuggestionsMetas: ReadonlyMap<string, EntryMeta> | null;
  /**
   * 🔴 **カンバンの札**(#277 段②-b)。⚠ `null` = **まだ集めていない**(0 件ではない)。
   *
   * ⚠ 中身は**項目だけ**で、本文は 1 バイトも入らない ── 舐めるのは worker で、
   * 主スレッドへ来るのは「どのノートの何行目が、何と書いてあって、済んでいるか」だけ。
   * 題名は `entryMetas` に在るので運ばない(同じ字が 2 か所に出ない)。
   */
  taskScan: TaskScan | null;
  /**
   * 🔴 **雛形の表**(#196 / B-2)。⚠ `null` = **まだ集めていない / 集められなかった**。
   *
   * ⚠ ここだけは**本文を持つ** ── `Tab` を押してから字が出るまでに往復を
   *   挟まないためである。運ぶのは **user が雛形として作った物だけ**で、
   *   `SNIPPET_LIMITS` の上限が付く(`features/snippet/snippet-table.ts`)。
   */
  snippetScan: SnippetScan | null;
  /**
   * 🔴 **集められなかった**(集計の `queryFailed` と同じ理由)。⚠ `taskScan === null`
   * は「まだ」であって「駄目だった」ではない ── 区別しないと、盤面が
   * 「集めています…」を出したまま**永久に止まって見える**。
   */
  taskScanFailed: boolean;
  /**
   * 🔴 **連絡先**(#278 段①)。⚠ `null` = **まだ集めていない**(0 件ではない)。
   *
   * ⚠ 中身は**連絡の手段だけ**で、本文は 1 バイトも入らない(舐めるのは worker)。
   * ⚠ **タブを開くまで集めない** ── 「`tel:` を持つ」は抽出列に無いので
   *   候補を絞れず、**全件の本文を読む**ことになる。予定と同じ規律で、
   *   使う人にだけ払わせる。
   */
  contactScan: ContactScan | null;
  /** 🔴 **集められなかった**(`taskScanFailed` と同じ理由 ── 「まだ」と区別する)。 */
  contactScanFailed: boolean;
  /**
   * 🔴 **録ったもの**(#683 段①)。⚠ `null` = **まだ集めていない**(0 件ではない)。
   *
   * ⚠ 中身は**目録だけ**で、bytes は 1 バイトも入らない(聞くときに借りる ──
   *   不可侵指示 2026-07-27「ゼロコピー・ライフサイクル終端での即破棄」)。
   * ⚠ **タブを開くまで集めない**(連絡先と同じ規律)── ただし母集団は
   *   `archetype='attachment'` で先に絞れるので、連絡先ほど高くはつかない。
   */
  captureItems: CaptureItem[] | null;
  /** 🔴 **集められなかった**(`contactScanFailed` と同じ理由 ── 「まだ」と区別する)。 */
  captureScanFailed: boolean;
  /**
   * 🔴 **いまその場で鳴らしている 1 件**(#683 段①)。`null` = 鳴らしていない。
   *
   * 🔑 **判定を state に置く理由**:この面の描画器は**同じ document に 2 つ生きうる**
   *   (左のタブと別窓)。描画器が自分で覚えると、片方で押した結果がもう片方に
   *   届かず、**2 本同時に鳴りうる**(§7:同じ問いに答える口を 2 つ作らない)。
   * ⚠ **同時に 1 件だけ** ── 録音 1 本で数百 MB になりうるので、
   *   複数を借りたままにしない(不可侵指示 2026-07-27)。
   */
  capturePlayingLid: string | null;
  /**
   * 🔴 **切り出す範囲の印**(#683 段②a。user 裁定 2026-09-14)。`null` = 印が無い。
   *
   * 🔑 **鳴らしている 1 件にだけ付く** ── `lid` を持たせて、別の行に古い印が
   *   見えないようにする(印は画面に**時刻の字**で出るので、行が違うと嘘になる)。
   * ⚠ `startMs` / `endMs` は**どちらか片方だけ**でも在りうる(順に押すので)。
   *   🔴 **逆転は残さない** ── 後から押したほうを採り、矛盾する側を `null` へ戻す
   *   (残すと「切り出す」が押せるのに中身が空になる = 無言の失敗)。
   */
  captureTrim: { readonly lid: string; readonly startMs: number | null; readonly endMs: number | null } | null;
  /**
   * 🔴 **いま切り出している最中か**(#683 段②a、着地前の動線レビュー 欠陥 3)。
   *
   * ⚠ **押した所に手がかりを出すため**に state へ置く ── 長い録音は数秒かかるので、
   *   ボタンが何も言わないと「効かなかった」と読まれて、もう一度押される。
   * 🔑 描画器に持たせない ── 同じ document に 2 つ生きうるので、片方の面だけ
   *   「切り出しています…」になる(§7)。
   */
  captureTrimBusy: boolean;
  /**
   * 🔴 **いま文字にしている録音の lid**(#772 段②)。`null` = 走っていない。
   *
   * ⚠ **押した行に手がかりを出すため**に state へ置く(`captureTrimBusy` と同じ理由 ──
   *   描画器は同じ document に 2 つ生きうる)。⚠ 真偽ではなく **lid** で持つ:
   *   どの行が走っているかで、その行だけ「文字にしています…」にし、ほかの行は押せなくする。
   */
  captureTranscribeLid: string | null;
  /**
   * 🔴 **関係グラフの見方**(#281 ①)。`all` = 全体 / 偽 = 選んだノートから `depth` 手先まで。
   * 🔑 state に置く理由:描画器は左のタブと別窓で 2 つ生きうる(`capturePlayingLid` と同じ)。
   */
  graphView: { readonly all: boolean; readonly depth: number };
  /**
   * 🔴 **計った時間**(#683 ①)。本文の「作業」の行を集めた一覧。`null` = **まだ集めていない**(0 件ではない)。
   * ⚠ 正本は本文(行を書き換えるのも本文)── ここは映した断面。**タブを開くまで集めない**(録ったものと同じ規律)。
   */
  workLogScan: WorkLogScan | null;
  /** 🔴 **集められなかった**(`contactScanFailed` と同じ理由 ── 「まだ」と区別する)。 */
  workLogScanFailed: boolean;
  /**
   * 🔴 **保存が「消えない扱い」か**(#347、user 裁定 2026-08-23)。
   *
   * ⚠ 出すのは**設定の面だけ**である ── 帯にもダイアログにもしない
   * (「気になるから**見るだけで**」)。操作の失敗ではないので、user の手を止めない。
   * ⚠ `unknown` は「断られた」ではなく「**まだ分かっていない**」── 混ぜると
   * 画面が嘘をつく(起動直後は必ずここを通る)。
   */
  persistState: PersistState;
  /**
   * 🔴 **このノートを参照しているノート**(#348、user 裁定 2026-08-23)。
   *
   * ⚠ `null` = **まだ引いていない**(「0 件」ではない)── 区別しないと、
   *   情報ペインが「無し」を出したまま、届いた結果に追いつかない。
   * ⚠ `lid` を一緒に持つ ── 選択を切り替えた直後に前のノートの結果が届いても、
   *   **別のノートの一覧を出さない**(遅れて届く答えは捨てる)。
   */
  backlinks: { lid: string; lids: string[]; truncated: boolean; failed?: true } | null;
  /**
   * ランチャーのタイル(P7b 段⑩)。⚠ `null` = **まだ読んでいない**。
   * 元データは attachment の frontmatter で**常駐していない**ので、
   * ランチャーを開いたときに要求して還流させる(履歴一覧と同じ流儀)。
   */
  launcherTiles: LauncherTile[] | null;
  /**
   * グループの見出しに出す目印(#857 段②)。名前 → 目印。
   * ⚠ **タイルとは別に読む**(`app-group-spec.ts` の火種)。
   * ⚠ 空の `{}` = 目印を持つグループが 1 つも無い(`null` を持たない ──
   *   「まだ読んでいない」と「1 つも無い」で見出しの出方は変わらないので、
   *   区別できる状態を作ると**使われない分岐**が増える)。
   */
  appGroupIcons: AppGroupIcons;
  /**
   * グループの並び順(#857 段③)。名前 → 番号。
   * ⚠ **番号を持たない群は入っていない**(「無い」と「0 番」を混ぜない)──
   *   並べる規則は `sortGroupNames` 1 本。
   */
  appGroupOrders: AppGroupOrders;
  /**
   * 🔴 **グループ用ノートの読み直しの世代**(#857 段③)。
   *
   * ⚠ 並べ替えや目印は**画面を先に動かしてから書く**ので、その間に
   *   **1 つ前の操作が積んだ読み直し**が戻ってくることがある ──
   *   それは**書き換える前の本文**を読んでいるので、当てると画面が巻き戻る。
   * 🔑 だから `APP_TILE_SAVED` と同じ作法を取る ──
   *   **世代が違う読み直しは画面に当てない**。
   * ⚠ **世代を進める側は、必ず自分で読み直しを 1 本積む**(積まないと、
   *   飛んでいる読み直しを捨てた分だけ disk の値が画面へ届かなくなる)──
   *   `tests/adapter/app-group-order.test.ts` が全数で見る。
   */
  appGroupGen: number;
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
   * 🔴 **直前の追記**(#395 段①。user 指示 2026-08-23「**片道の操作を作らない**」)。
   *
   * 追記は本文を開かずに足せるので、**外すのも本文を開かずにできる**必要がある。
   * ⚠ 持つのは**足した行そのもの**で、行番号ではない(取り消すまでに別の窓が
   *   上へ足していれば番号はずれる)。
   * ⚠ **1 手だけ**持つ ── 積むと「どれが消えるのか」が user から見えなくなる。
   * 🔴 **「1 手」は 1 回の取り込みである**(#668 C)── 写真を 3 枚まとめて落とすと
   *   追記は 3 本飛ぶが、user がやったことは 1 回である。だから同じ `batch` の
   *   追記は**足した行を継ぎ足して 1 手にする**(「元に戻す」で 3 行が一緒に消える)。
   *   ⚠ 直す前は最後の 1 枚しか戻らず、残り 2 枚は本文を開いて消すしかなかった。
   *   `batch` は取り込みの回の印(`APPEND_TO_ENTRY.batch`)。手で足した追記には無い。
   */
  lastAppend: { lid: string; lines: readonly string[]; at?: number; batch?: string } | null;
  /**
   * 🔴 **直前の AI の書き足し**(台帳 #1852 P1 / 依頼 362)。`lastAppend`(自分の追記)とは**別の 1 手**。
   * ⚠ AI が書き足しても自分の「追記を元に戻す」は消えない(こちらに入る)。`notice` = 「開く」と並べる知らせの字
   *   (`OP_NOTICE.agentUndo` が置く)── 別の知らせに上書きされたら「元に戻す」を出さない(`status-open.ts`)。
   */
  lastAgentAppend: { lid: string; lines: readonly string[]; at?: number; notice?: string } | null;
  /**
   * 🔴 **履歴から戻した直後の「元に戻す」の材料**(依頼 68-1)── 戻す前の本文の版 id。
   * ⚠ `lid` を持つ: 別のノートを選んだら出さない(他のノートの版を、いま開いているノートへ書かない)。
   * ⚠ 1 手だけ持つ。次の復元・ノートの切り替えで出番が無くなる(出し入れは `status-open.ts`)。
   */
  restoreUndo?: { lid: string; revId: string; notice: string; title?: string } | null;
  /**
   * 🔴 **まとめてタグを付けた直後の「元に戻す」の材料**(依頼 109 A)。今回付けたノートだけを組ごと(同じ顔ぶれのタグを 1 組)に持ち、
   * `notice` は出した知らせの字そのもの ── 画面の下に出ている字がこの知らせのときだけ「元に戻す」を出す。1 手だけ持つ。
   */
  tagUndo?: { groups: readonly TagUndoGroup[]; notice: string } | null;
  /**
   * 🔴 **直前の塊の移動を、逆向きに撃つ指示**(#684 段①)── 「元に戻す」の材料。
   *
   * ⚠ `lastAppend` と違って**位置**を持つ(行の並びは同じ字が何度も出るので、字だけでは
   *   戻す先が決まらない)。だから**行がずれうる事は全部ここを捨てる** ── 編集に入る
   *   (`START_EDIT`)/ 同じノートへの別の書換(`BODY_REWRITTEN`)。戻すときは
   *   `line-move.ts` が掴んだ行そのものと byte 一致を検めるので、ずれていれば断る。
   * ⚠ **1 手だけ**持つ(`lastAppend` と同じ)。
   */
  lastMove: ({ lid: string } & MoveLines) | null;
  /**
   * 🔴 **編集に入った瞬間に開く行**(#395 段③)。`null` = どこも開かない(既定)。
   *
   * > 読んでいる本文の「この行」を直したい ── 修飾キー + クリックで入る。
   *
   * ⚠ 座標は**frontmatter を外した側**(ライブエディタと読む面が同じ基準を使う)。
   * ⚠ `START_EDIT` のたびに**必ず入れ替わる** ── 残しておくと、次に普通に
   *   「編集」を押したときに**前に押した行が勝手に開く**。
   */
  editOpenAt: number | null;
  /**
   * 🔴 **章だけの下書き**(#1044 段2)。`null` = 開いていない。
   *
   * ⚠ **アプリ全体の編集中(`phase === 'editing'`)とは別物**である ── 章の欄が
   *   開いていても `phase` は `'ready'` のまま(一覧・右の列・他のノートは動く)。
   * ⚠ **打ちかけの字は持たない**(`cell-input.ts` と同じ規律)── 打っている字は
   *   `<textarea>` そのものに生きていて、state には**開いたときに控えた原文**しか
   *   無い。理由:打つたびに state を書き換えると、章 1 つの入力が state 全体の
   *   指紋を動かし、無関係な面まで描き直る。
   * ⚠ **`heading` は名前で持つ**(行番号ではない)── 保存のとき、別の窓の書込で
   *   行がずれていても**名前で章を探し直す**ため(設計 doc §3)。
   *
   * 🔴 **#1044 段3 でコード枠の下書きも同じ field で持つ**(型は
   *   {@link PartialDraft}。field 名は変えていない ── {@link PartialDraft} の
   *   docstring 参照)。
   */
  sectionDraft: PartialDraft | null;
  /**
   * 🔴 **いま `error` に置いている字が、章の欄自身の断り文なら、その字そのものを控える**
   *   (#1044 段2 5巡目の修理、U3)。`null` = 章の欄は何も置いていない。
   *
   * ⚠ 直す前は `SECTION_DRAFT_ADVISORY_TEXTS`(固定の字の集合)で「章の欄自身の
   *   断り文か」を判定していた ── **中身が動く字**(`REQUEST_SECTION_SAVE` の
   *   catch-all「章を保存できませんでした: <e>」)は集合に入れられないので漏れ、
   *   保存が成功した後も**古い失敗の字が残った**(`clearedSectionDraftAdvisory` が
   *   「知らない字」として素通しする)。
   * 🔑 判定は「字の中身」ではなく「**いま error に置いたのは章の欄自身か**」に変えた。
   *   章の欄が `error` を置くすべての所(このファイル内)で**同時に**この控えも書く。
   *   消す・引き継ぐ判定は `state.error === state.sectionAdvisory` の等値 1 つで済む
   *   (中身は問わない ── catch-all の動く文字列も、この等値なら通る)。
   * ⚠ **`error` が別の字で上書きされたら、この控えは自動的に無効になる**(比較が
   *   一致しなくなるだけ) ── 明示的に無効化する分岐を書く必要は無い。
   */
  sectionAdvisory: string | null;
  /**
   * 🔴 **「探す」から本文の当たった所へ送って塗っている間の控え**(#1102 段①)。`null` = 塗っていない。
   *
   * 🔑 持つのは**何で探したか(`query`)と、送りを進めた回数(`step`)だけ** ── 当たりの数も位置も
   *   **本文の DOM を数えないと分からず**、reducer は DOM を知らない。数えて「1/4 件」にするのは
   *   描く側(`detail.ts`)で、`step` を数で畳む(端で回る。`wrapHitIndex`)。
   * ⚠ `gen` は START / 送りのたびに進む ── 描く側が「送り先が変わったか」を見る物差し
   *   (同じ語でもう一度 START されたら、同じ位置へもう一度送る)。
   * ⚠ **`reduce()` の外側 1 か所で消す**(`dropStaleSearchJump`)── ノートが変わる / 編集に入る case を
   *   1 つずつ見張ると、次に足した case が必ず忘れる(章の欄の `guardSectionDraftTransition` と同じ作り)。
   * ⚠ 手組みの state fixture は持たない = `undefined`。読むのは **`?? null`**。
   */
  searchJump: SearchJump | null;
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
   * 🔴 **アプリの一覧で、いま印を付けたタイル**(#857 段①b。user 裁定 2026-09-13
   * 「開くのはダブルタップ」)。
   *
   * ⚠ **`selectedLid` では足りない** ── 組み込みのタイルは entry を持たないので、
   *   1 回押しても `selectedLid` は 1 ミリも動かない。印が出ないと、
   *   **1 回目の押しが無反応に見える**(この repo がいちばん嫌う形)。
   * 🔑 だから**タイルの印だけを持つ** ── 右の列に何を出すかは `selectedLid` のまま。
   */
  launcherPick: string | null;
  /**
   * 🔴 **アプリの一覧が「並べ替えモード」か**(#857 段①b-2。user 裁定 2026-09-13
   * 「長押しで並べ替えモード」)。
   *
   * ⚠ **指だけの端末には、並べ替えの入口が 1 つも無かった** ── 掴んで落とすのは
   *   HTML5 の drag、「上へ / 下へ」は右クリックで、どちらもマウスが要る
   *   (`long-press.ts` は `pointerType === 'mouse'` を**受けない**と決めており、
   *   裏を返せばマウス以外の入口が無いということである)。
   * 🔑 モードに入ると、タイルの右に**「上へ」「下へ」**が出て、**押しても開かない**
   *   ── 並べ替えている最中に別のウィンドウが開くのが、いちばん困る事故である。
   * ⚠ 絞り込みを打つと `SET_ENTRY_FILTER` が**落とす** ── 画面に出ているのは
   *   絞った後だが並び順の正本は全件なので、モードに居ても何もできない
   *   (`MOVE_APP_TILE` が理由つきで断る)。**できない物を出したままにしない**。
   */
  launcherReorder: boolean;
  /**
   * ロックの世代。**強制解放のたびに増える**(P8 段⑧)。
   * ⚠ これが無いと強制解放は**危険な操作になる** ── 解放したあとに古い書込の
   * ack が着いて、user が見ている本文を巻き戻す。世代の合わない ack は捨てる。
   */
  lockGen: number;
  error: string | null;
  /**
   * 🔴 **未読のメッセージ(注意 / 問題)の数**(設計 doc §7、段②a)。
   *
   * ⚠ **`entryMetas` から数え直さない** ── メッセージのノートは system 領域で
   *   `entryMetas` に入らない(§1.1)ので、別に持つしかない。
   * 🔑 起動直後は disk の本文から数え直した値を種にし(`main.ts` の boot)、
   *   以後は post のたびに増え、`MESSAGES_READ` で 0 へ戻る。
   */
  messagesUnread: number;
}

/** 誰が本文を握っているか。⚠ **lid つき**(別のノートは巻き添えにしない)。 */
export interface BodyLock {
  lid: string;
  /**
   * `editing` = 編集中の draft がある / `writing` = 追記の書込が飛んでいる /
   * 🔴 `section` = 章の欄の下書きがある(#1044 段2、F-C)。
   */
  holder: 'editing' | 'writing' | 'section';
}

/**
 * いま本文を握っているのは誰か(**導出** ── state に 2 つ目の真実を作らない)。
 * ⚠ 書込のほうを先に見る:書込中に編集へ入ることはできないので、両方立つことは
 * 無いが、順序を決めておかないと将来の変更で曖昧になる。
 */
/**
 * 🔴 **入らなかったタグを戻す欄**(#640)。⚠ 綴りは `data-pkc-field` そのもの ──
 *   描く側(`filer.ts`)がこの名前で `<input>` を引く。
 */
export const TAG_INPUT_FIELDS = ['smart-cond', 'bulk-tag'] as const;
export type TagInputField = (typeof TAG_INPUT_FIELDS)[number];

export function bodyLockOf(state: AppState): BodyLock | null {
  if (state.writeLock) return { lid: state.writeLock.lid, holder: 'writing' };
  // ⚠ タイル設定の書込中も**書込中**として見せる(編集に入れないので、
  //    理由が画面に出ないと「押しても何も起きない」になる)
  if (state.tileWrite) return { lid: state.tileWrite.lid, holder: 'writing' };
  if (state.phase === 'editing' && state.openBody)
    return { lid: state.openBody.lid, holder: 'editing' };
  /**
   * 🔴 **章の欄も握っている**(#1044 段2、F-C)。⚠ 直す前はここが `phase` だけを
   *   見ていたので、章の欄が開いている間 `appendModeOf` が `{kind:'ready'}` を
   *   返し続けていた(実測)── 追記欄が使えるように**見えていた**が、追記は
   *   同じノートへの書込なので設計 doc §3(章の欄が開いている間、同じノートへの
   *   他の書込は断る)に違反する形で許してしまっていた。
   */
  if (state.sectionDraft) return { lid: state.sectionDraft.lid, holder: 'section' };
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
  filerFlatten: false,
  renamingLid: null,
  dual: initialDual,
  selection: [],
  selectionAnchor: null,
  splitLids: [],
  splitBodies: new Map<string, string>(),
  placeBodies: new Map<string, PlaceExcerpt>(),
  openExtensions: [],
  freshLid: null,
  viewMode: 'detail',
  filterQuery: '',
  kindFilter: NO_KINDS,
  searchHits: null,
  selectionHistory: EMPTY_HISTORY,
  entrySort: DEFAULT_ENTRY_SORT,
  entrySortDesc: NATURAL_DESC[DEFAULT_ENTRY_SORT],
  // ⚠ 空の Map を**使い回さない**(凍らせていないので、誰かが書くと全部に効く)
  openedAt: new Map<string, number>(),
  openedAtShown: new Map<string, number>(),
  searchHitsQuery: '',
  searchHitsTruncated: false,
  searchHitsFailed: false,
  searchPage: { query: '', rows: [], rowsQuery: '', truncated: false, failed: false },
  sqlPage: {
    engine: DEFAULT_SQL_ENGINE,
    sql: '',
    ranSql: '',
    columns: [],
    rows: [],
    truncated: false,
    ms: 0,
    running: false,
    error: '',
    saved: '',
    savedKind: 'note',
    savedCapped: 0,
    history: [],
    historyAt: -1,
    historyDraft: '',
    historyEdits: [],
    guest: null,
    extraGuests: [],
    guestError: '',
    guestPending: '',
    guestChosen: '',
    runToken: 0,
    duckCopy: null,
    duckLoading: false,
    er: {
      open: false,
      loading: false,
      model: null,
      note: '',
      source: '',
      token: 0,
      connecting: false,
      pendingFrom: null,
      mine: [],
    },
  },
  queryKey: null,
  smartHits: new Map<string, SmartHitState>(),
  queryKeys: null,
  queryGroups: null,
  queryFailed: false,
  tagSuggestions: null,
  tagSuggestionsMetas: null,
  taskScan: null,
  taskScanFailed: false,
  contactScan: null,
  contactScanFailed: false,
  captureItems: null,
  captureScanFailed: false,
  capturePlayingLid: null,
  captureTrim: null,
  captureTrimBusy: false,
  captureTranscribeLid: null,
  graphView: { all: false, depth: GRAPH_DEFAULT_DEPTH },
  workLogScan: null,
  workLogScanFailed: false,
  snippetScan: null,
  persistState: 'unknown',
  backlinks: null,
  launcherTiles: null,
  appGroupIcons: {},
  appGroupOrders: {},
  appGroupGen: 0,
  calendarMonth: null,
  scheduleMode: 'list',
  scheduleNarrowMode: 'list',
  scheduleDay: null,
  showArchived: false,
  showDoneTasks: false,
  showUndatedTasks: false,
  scheduleHiddenNotes: [],
  scheduleOwner: null,
  revisionPanel: null,
  revisionPreview: null,
  notice: null,
  refusedTags: { 'smart-cond': [], 'bulk-tag': [] },
  noticeOpen: null,
  noticeCreate: null,
  trashPanel: null,
  linkedFiles: new Map(),
  writeLock: null,
  lastAppend: null,
  lastAgentAppend: null,
  lastMove: null,
  editOpenAt: null,
  sectionDraft: null,
  sectionAdvisory: null,
  searchJump: null,
  tileWrite: null,
  launcherPick: null,
  launcherReorder: false,
  lockGen: 0,
  error: null,
  messagesUnread: 0,
};

/**
 * 🔴 編集中のノートへ「探す」から送られたとき、画面下に出す 1 行(#1206 D9)。
 * ⚠ 2026-10-13 に字を直した(#1087 の見直し)── 直す前は「編集を終えると、当たった所に色が付きます」だったが、
 *   この枝は `searchJump` を残さずに返るので、編集を終えても**色は付かない**(後から塗り直す所も無い)。
 *   付けるには、編集を終えてからもう一度そのノートを選ぶ(`startSearchJumpFromField` が塗る)。
 */
export const SEARCH_JUMP_EDITING_NOTICE =
  '編集中は、当たった所に色を付けません。保存するか、やめてから、もう一度ノートを選んでください';

export type UserAction =
  /**
   * 🔴 **「探す」で当たった語で、いま開いているノートの本文を塗って送る**(#1102 段①)。
   *
   * ⚠ **選んでいるノートのときだけ**・**読む画面(`ready`)のときだけ** ── 編集中は塗らない。
   *   断るときは state を 1 ビットも動かさない(黙って何もしない。呼び側は探した語を運んだだけで、
   *   塗れない理由は画面に既に出ている)。
   *   ⚠ **ただし「そのノートを編集中」のときだけは、`notice` に 1 行置く**(#1206 D9。
   *   窓が前に出るのに何も起きないのを、壊れたと読ませない)。
   * ⚠ `origin`(#1102 段②)は**何から始めたか**。省くと `find`(「探す」の行)。`filter` は左の列の欄の
   *   語で塗るとき ── `SELECT_ENTRY` の後に reducer が自分で撃つので、呼び側は渡さない。
   */
  | { type: 'SEARCH_JUMP_START'; lid: string; query: string; origin?: 'find' | 'filter' }
  /** 🔴 **次 / 前の当たりへ送る**(#1102 段①)。⚠ 端で回る(数で畳むのは描く側)。 */
  | { type: 'SEARCH_JUMP_STEP'; by: 1 | -1 }
  /** 🔴 **塗りと送りの帯を消す**(#1102 段①。帯の × / `Esc`)。 */
  | { type: 'SEARCH_JUMP_END' }
  /**
   * 🔴 **このノートを横に並べる / 並べるのをやめる**(#505 段②)。
   *
   * ⚠ **対で置く**(user 指示 2026-08-23「なんで双方向にする発想がでねぇんだよ!」)
   * ── 置けるのに外せないと、間違えて留めた物を戻す道が無い。
   */
  | { type: 'PIN_SPLIT_ENTRY'; lid: string }
  /**
   * 🔴 **開くときに、いま中央に居るノートと入れ替える**(#809-4、2026-09-09。user 推薦 A)。
   *
   * ⚠ 直す前、知らせの隣の **開く** は素の `SELECT_ENTRY` だったので:
   *   ① それまで読んでいた本文が**中央から消える**(留めていないので、戻るには
   *      左の一覧で探し直し)② 留めた枠は外れないので、**同じノートが中央と
   *      枠の 2 か所に並ぶ**。
   * 🔑 だから**入れ替える** ── 行き先が中央へ、いま中央に居たものがその枠へ。
   *   左右が入れ替わるだけで、**どちらも画面に残る**。
   * ⚠ 行き先が枠に居ないとき(添付を作った回など)は、ただ開く ── 入れ替える相手が無い。
   */
  | { type: 'SWAP_OPEN_ENTRY'; lid: string }
  /**
   * `gone: true` = **ノートが消えていたので降ろす**(効果層の自己修復。#633 段①)。
   * ⚠ user が × を押したときは付けない ── 付けると「消えた」と嘘を言う。
   *   付いていれば reducer が 1 行知らせる(黙って降ろすと dead click に見える)。
   */
  | { type: 'UNPIN_SPLIT_ENTRY'; lid: string; gone?: true }
  /**
   * 🔴 **全部降ろす**(#633 段②)。⚠ 確認は要らない ── 降ろすだけでノートは消えない
   *   (入れ替えたい人は「全部降ろす → 載せる」の 2 手で作れる。設計 doc §2-8)。
   */
  | { type: 'CLEAR_SPLIT' }
  /**
   * 🔴 **保存したスタック(入れ物)を載せ直す**(#633 段③「このスタックを載せる」)。
   * 本文の並びを**上に積む**(全置換にしない ── 保存していない並びを黙って失う片道になる。
   * 設計 doc §2-8)。本文が画面に無ければ効果層が読む(`REQUEST_STACK_BODY`)。
   */
  | { type: 'LOAD_STACK'; lid: string }
  /**
   * 🔴 **保存したスタックの中の 1 行を上 / 下へ**(#633 段④)。`line` は**原文の行番号**。
   * 書換は `REQUEST_BODY_REWRITE`(`link-move`)の 1 本 ── 押した時点の行を添えて byte 一致で門をくぐる。
   */
  | { type: 'MOVE_STACK_LINK'; lid: string; line: number; dir: 'up' | 'down' }
  | { type: 'SELECT_ENTRY'; lid: string }
  /**
   * 🔴 **メッセージ(system 領域のノート)を開く**(設計 doc §7、段②a)。
   *
   * ⚠ **`SELECT_ENTRY` を使い回さない** ── あちらは `state.entryMetas.has(lid)`
   *   を通るが、メッセージのノートは system 領域なので `entryMetas` に入らない
   *   (§1.1)。判定を増やさず、system の 2 lid(`sys-messages` / `sys-jobs`)専用の
   *   別 action にする。
   * 🔑 **これが「知らせを消す」唯一の入口になる**(§7「既読」)── 開くと
   *   `error` を消し、未読を 0 にする。
   */
  | { type: 'MESSAGES_READ'; lid: string }
  | { type: 'SET_VIEW_MODE'; mode: ViewMode }
  /**
   * 🔴 **開いている拡張の窓が変わった**(#195 / C-5 段②-b)。
   * ⚠ 台帳(`extension-links.ts`)が正本で、これはその**写し**である ──
   *   ここで足し引きの計算をしない(2 か所で数えない、§7)。
   */
  | { type: 'SET_OPEN_EXTENSIONS'; open: readonly OpenExtension[] }
  | { type: 'SET_ENTRY_FILTER'; query: string }
  /** 探す面の欄に打った(#680)。⚠ 左の列の絞り込み(`SET_ENTRY_FILTER`)とは別の語。 */
  | { type: 'SET_SEARCH_PAGE_QUERY'; query: string }
  | { type: 'SET_SQL_TEXT'; sql: string }
  | { type: 'RUN_SQL' }
  /**
   * 🔴 **前に打った字を戻す / 進む**(#918 段②a)。
   * ⚠ **どこで押したかは呼び側が見る** ── 1 行目で ↑、最後の行で ↓ のときだけ来る
   *   (でないと、複数行の中を動けなくなる)。
   */
  | { type: 'SQL_HISTORY_STEP'; back: boolean }
  /**
   * 🔴 **一覧から選んで呼び戻す**(#918 段②a、user 裁定 2026-09-14「履歴ボタンを 1 つ足す」)。
   *
   * ⚠ 指で触る端末には `↑` `↓` が**無い** ── 鍵盤だけの近道にすると、
   *   スマホの user は前に打った SQL を**毎回打ち直す**ことになる
   *   (CLAUDE.md「マウスだけで完結し、キーボードは近道」)。
   * 🔑 `at` は `history` の添字(`0` = いちばん新しい)。範囲の外は黙って捨てる。
   */
  | { type: 'SQL_HISTORY_PICK'; at: number }
  /**
   * 🔴 **構造 1 枚をノートへ**(#918 段①。user 要望 2026-09-14「ai向けに構造吐き出したり」)。
   * ⚠ 中身は 1 文字も出さない ── 出すのは表・列・型・鍵・繋がり・行数だけである。
   */
  | { type: 'SQL_SCHEMA_TO_NOTE'; lid: string; relationId: string; parentLid?: string | null }
  /**
   * 🔴 **つながり図を開く / 閉じる**(#918 段⑤。裁定 2026-09-15 = この窓の中)。
   * ⚠ 開いたとき構造をまだ採っていなければ、採ってくるよう頼む。
   */
  | { type: 'SQL_ER_TOGGLE' }
  /**
   * 🔴 **図の中を押した**(#918 段⑤c)── 表 / 列 / 繋がり。
   * ⚠ **打っている字は捨てない** ── `erSql` が「足せるか」を決め、
   *   足せないときは**理由**を画面へ出す(黙って何もしない形を作らない)。
   */
  | { type: 'SQL_ER_PRESS'; press: ErAction }
  /** 構造が採れた(#918 段⑤)。⚠ 札が古ければ捨てる。 */
  | {
      type: 'SQL_ER_LOADED';
      token: number;
      columns: Grid;
      fks: Grid;
      counts: Grid | null;
      /**
       * 🔴 **DuckDB へ写した報告**(#682 段④d の着地後レビュー)。⚠ 必須の field(省ける形にすると、effect が書き忘れても
       *   tsc が黙る ── 書き忘れは「写せなかった表が出ない」側へ倒れる)。`null` = DuckDB の器ではない(内蔵の sqlite)。
       */
      copy: DuckDbCopyReport | null;
      /** 🔴 本文の名前つき csv の目録(#918 段⑤d-2)。⚠ 客の DB では `null`。 */
      csv: Grid | null;
    }
  /** 構造を採れなかった(#918 段⑤)。⚠ 黙って空の図を出さない。 */
  | { type: 'SQL_ER_FAILED'; token: number; error: string }
  /**
   * 🔴 **「繋ぐ」モードの入切**(#918 段⑤d-1)。
   * ⚠ 外部キーの宣言が 0 本の DB でも、自分でキーどうしを繋げるようにする。
   */
  | { type: 'SQL_ER_CONNECT_TOGGLE' }
  /**
   * 🔴 **繋ぐモード中に列を押した**(#918 段⑤d-1)。
   * ⚠ 1 列目なら「ここから」に、2 列目なら繋がりになる(`pickErConnection` が決める)。
   */
  | { type: 'SQL_ER_PICK'; table: string; column: string }
  /**
   * 🔴 **自分で引いた線を消す**(#918 段⑤d-1)。⚠ 宣言された外部キーはここへ来ない
   *   (描画側が `mine` の線にしか消す口を出さない ── 消せない物を消させない)。
   */
  | { type: 'SQL_ER_UNLINK'; link: SchemaLink }
  /**
   * 🔴 **答えをノートへ書き出した**(#681 段③ の 3 つ目)。
   * ⚠ ノートを作るのは `CREATE_ENTRY` の仕事 ── ここは**言うだけ**である
   *   (2 つの仕事を 1 つの action に持たせない)。
   */
  /**
   * 🔴 **書き出した**(#681 段③ / #918 段④)。
   * ⚠ `kind` は**必須**にしてある ── optional にすると、次に書き出す口を足した人が
   *   黙って落とし、**ノートを作っていないのに「ノートに書き出しました」と出る**。
   */
  | { type: 'SQL_SAVED'; title: string; kind: 'note' | 'file'; capped?: number }
  /**
   * 🔴 **書き出せなかった理由**(#681 の着地前レビュー F1)。
   * ⚠ 直す前は編集中に押すと**画面が 1 ドットも動かなかった** ── `CREATE_ENTRY` は
   *   `phase !== 'ready'` を**黙って捨てる**ので、押した人には
   *   「壊れている」と「押せていない」の区別が付かない。
   */
  | { type: 'SQL_SAVE_FAILED'; error: string }
  /**
   * 🔴 **いま出ている答えを Parquet の file にしてほしい**(#918 段⑥)。
   * ⚠ `fileName` は**押した側が作る**(`sqlExportFileName` ── 日付の時計を reducer に持たせない)。
   * 🔑 書くのは字ではなく**DuckDB の器**(打った SQL をもう一度走らせて `COPY` する ── 型を保つため)。
   *   終わりを言うのは `SQL_SAVED` / `SQL_SAVE_FAILED`(降ろし忘れると以後押せない ── 構造の書き出しと同じ)。
   */
  | { type: 'SQL_EXPORT_PARQUET'; fileName: string }
  /**
   * 🔴 **調べる相手を選ぶ**(#681 段③ の 2 つ目)。`lid` が空 = この PKC のノート。
   * ⚠ 選び直しは**前の相手を必ず手放す**(常駐メモリを返す)。
   */
  | { type: 'SET_SQL_SOURCE'; lid: string; name: string }
  /**
   * 🔴 **調べる相手を、もう 1 つ足す**(#918 段⑦。Gemini 裁定 2026-10-01 = 設問 1 は A)。
   * ⚠ 足せない相手(`.xlsx` / 上限 / 重複)は**断りの字**を返す(黙って何も起きない形を作らない)。
   *   🔴 `.sqlite` は足せる(#682 段④d)。
   * ⚠ **足したら答えを捨てる**(相手の集合が変わるので、出ている表は別の話になる)。
   */
  | { type: 'ADD_SQL_SOURCE'; lid: string; name: string }
  /** 🔴 足した相手を外す(#918 段⑦)。⚠ **片道にしない** ── 足せるなら外せる。 */
  | { type: 'REMOVE_SQL_SOURCE'; lid: string }
  /**
   * 🔴 **どのエンジンで引くかを選んだ**(#682 段②)。
   * ⚠ **走っている答えを捨てない** ── 相手は変わっていないので、いま出ている表は
   *   そのまま正しい(`SET_SQL_SOURCE` と違う所である)。
   */
  | { type: 'SET_SQL_ENGINE'; engine: SqlEngine }
  | {
      type: 'SQL_GUEST_OPENED';
      lid: string;
      name: string;
      tables: string[];
      bytes: number;
      /** 🔴 csv / tsv を上限で打ち切ったか(#854 段①)。`.sqlite` は常に `false`。 */
      truncated: boolean;
      /** 🔴 Shift_JIS と推測して読んだか(csv / tsv のみ。省略 = そうではない)。 */
      sjis?: boolean;
    }
  | { type: 'SQL_GUEST_FAILED'; lid: string; error: string }
  | {
      type: 'SET_SQL_RESULT';
      /** 走らせた回の札(#681 F3-A)。 */
      token: number;
      sql: string;
      columns: readonly string[];
      rows: readonly (readonly (string | number | null)[])[];
      truncated: boolean;
      ms: number;
      /**
       * 🔴 DuckDB の答えのときだけ付く、写した報告(#682 段④d の着地後レビュー)。⚠ 省略 = 内蔵の sqlite の答え
       *   (報告は動かさない)。
       */
      copy?: DuckDbCopyReport;
    }
  | { type: 'SQL_RUN_FAILED'; token: number; sql: string; error: string }
  /** 🔴 DuckDB の器が表の読み込みを始めた(#682)。⚠ `token` = どの回か(古い回の合図は捨てる)。 */
  | { type: 'SQL_DUCK_LOADING'; token: number }
  /** 本文の当たりが SQL から返った(#181)。⚠ `query` は**どの問い合わせの答えか**。 */
  | { type: 'SET_SEARCH_HITS'; query: string; lids: string[]; truncated: boolean; failed?: boolean }
  /**
   * 最近開いた記録が入れ替わった(#215 残り①)。
   * ⚠ **時刻は呼び側(effect)が読む** ── reducer は純粋なので `Date.now()` を持たない。
   */
  | {
      type: 'SET_OPENED_AT';
      openedAt: ReadonlyMap<string, number>;
      /**
       * 真 = 「ノートを開いたので足した」。一覧の並びは**動かさない**(依頼 274)。
       * 省略 = 起動時・記録を消したとき ── 一覧の並びにも反映する。
       */
      keepListOrder?: boolean;
    }
  /** 一覧の並び順を変える(#183)。⚠ 選択は消さない(絞り込みと同じ規約)。 */
  | {
      type: 'SET_ENTRY_SORT';
      sort: EntrySort;
      /** 省略 = その並びの自然な向き(`NATURAL_DESC`)。 */
      desc?: boolean;
    }
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
  /** カンバンの札が集まった(#277 段②-b)。 */
  | { type: 'SET_TASK_SCAN'; scan: TaskScan }
  | { type: 'SET_CONTACT_SCAN'; scan: ContactScan }
  | { type: 'CONTACT_SCAN_FAILED' }
  /** 🔴 録ったものが集まった(#683 段①)。 */
  | { type: 'SET_CAPTURE_ITEMS'; items: CaptureItem[] }
  | { type: 'CAPTURE_SCAN_FAILED' }
  /**
   * 🔴 **その場で鳴らす / やめる**(#683 段①)。`lid: null` = やめる。
   * ⚠ 借りるのは描画器(`captures.ts`)── ここは**どれを鳴らすか**だけを持つ。
   */
  | { type: 'SET_CAPTURE_PLAYING'; lid: string | null }
  /**
   * 🔴 **切り出す範囲の端を、いま鳴っている所で決める**(#683 段②a)。
   *
   * ⚠ `ms` は**その場の再生位置**(ミリ秒)── 画面の `<audio>` から binder が読む。
   * 🔑 **どの録音か**は渡さない ── 鳴っているのは**常に 1 件**(`capturePlayingLid`)
   *   なので、押した所からも採ると**同じ問いに答える口が 2 つ**になる(§7)。
   *   ⚠ そのうえ「食い違っていないか」の門は、**同じ値を渡すので永久に真**になり、
   *   空振りの門が 1 つ増えるだけである(§1)。
   */
  | { type: 'SET_CAPTURE_TRIM_MARK'; edge: 'start' | 'end'; ms: number }
  /** 切り出す範囲の印を消す(#683 段②a)。 */
  | { type: 'CLEAR_CAPTURE_TRIM' }
  /** 切り出しが走っているか(#683 段②a)。⚠ 押した所に「切り出しています…」を出すため。 */
  | { type: 'SET_CAPTURE_TRIM_BUSY'; busy: boolean }
  /** 文字にしている録音を知らせる(#772 段②)。`null` = 終わった。 */
  | { type: 'SET_CAPTURE_TRANSCRIBE'; lid: string | null }
  /** 🔴 計った時間が集まった / 集められなかった(#683 ①)。 */
  | { type: 'SET_WORK_LOG_SCAN'; scan: WorkLogScan }
  | { type: 'WORK_LOG_SCAN_FAILED' }
  /**
   * 🔴 **計った時間の名前を付け替える**(#683 ①)。`label` が空なら名前を外す。
   * ⚠ 書換は `REQUEST_BODY_REWRITE`(`work-log`)の 1 本 ── 押した時点の行(一覧が見ていた行)を添えて byte 一致で門をくぐる。
   */
  | { type: 'SET_WORK_LOG_LABEL'; lid: string; line: number; label: string }
  /** 🔴 計った時間の行を本文から消す(#683 ①)。書換は上と同じ 1 本。 */
  | { type: 'DELETE_WORK_LOG'; lid: string; line: number }
  /** 🔴 関係グラフの見方を変える(#281 ①)。渡した項目だけ変わる。`depth` は 1..6 に丸める。 */
  | { type: 'SET_GRAPH_VIEW'; all?: boolean; depth?: number }
  /** 🔴 雛形を集め終えた(#196 / B-2)。⚠ `null` は失敗 ── **帯は出さず静かに畳む**。 */
  | { type: 'SET_SNIPPET_SCAN'; scan: SnippetScan | null }
  /** 札が集められなかった(#277 段②-b)。⚠ 「まだ」と区別する ── 文言が違う。 */
  | { type: 'TASK_SCAN_FAILED' }
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
   * 🔴 **グループ用ノートから読んだもの**(#857 段②③)。
   * ⚠ 名前を `…_ICONS_LOADED` のままにしない ── **番号も運ぶ**ので、
   *   計器の名前が中身より狭くなる(CLAUDE.md「計器の名前を主張として読む」)。
   */
  | { type: 'APP_GROUP_NOTES_LOADED'; icons: AppGroupIcons; orders: AppGroupOrders; gen: number }
  /**
   * 🔴 **グループの目印を選んだ**(#857 段②)。
   * ⚠ **在るものを探して、無いときだけ作る** ── 同じ名前のノートを 2 つ作らない
   *   (CLAUDE.md「衝突は、検出するより起こらなくするほうが強い」)。
   * ⚠ `newLid` は呼び側が採る(reducer は純関数 ── 乱数を持たない)。
   */
  | { type: 'SET_APP_GROUP_ICON'; name: string; icon: string | null; newLid: string }
  /**
   * 🔴 **グループを 1 つ上へ / 下へ**(#857 段③)。
   * ⚠ `newLids` は**書く群の数だけ**呼び側が採る(reducer は乱数を持たない)──
   *   足りなければその群は書かない(黙って別の群の lid を使い回さない)。
   */
  | { type: 'MOVE_APP_GROUP'; name: string; by: -1 | 1; newLids: readonly string[] }
  | { type: 'RESET_APP_GROUP_ORDER' }
  /**
   * 🔴 **グループの名前を変える**(依頼 83-2。Gemini の回答「推薦どおり」= C)。
   * ⚠ そのグループに入っている**自分のアプリ全部**の `attachment.app_group` と、グループ用のノート(目印・並び順)の題名を
   *   一緒に書き換える ── タイルを 1 つずつ開いて打ち直すと、古い名前のグループのアイコンと並び順が取り残された。
   */
  | { type: 'RENAME_APP_GROUP'; from: string; to: string }
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
   * 🔴 **予定のタブを開いたときに集める**(#292 段③)。
   * ⚠ ランチャーと同じ流儀 ── 探し方(`browseMode`)は state に持たないので、
   *   「開いた」を知っているのは `main.ts` である。前の束は**消さない**
   *   (読み直しの間に空白を出さない)。
   */
  | { type: 'REFRESH_TASK_SCAN' }
  | { type: 'REFRESH_CONTACT_SCAN' }
  /** 🔴 計った時間を集め直す(#683 ①)。⚠ 前の一覧は消さない(録ったものと同じ)。 */
  | { type: 'REFRESH_WORK_LOG_SCAN' }
  /**
   * 🔴 **本文の検索を、いまの語で撃ち直す**(#1087)。⚠ 書込・取込・別タブの変更の後に出る
   * (`store-effects.ts` の `stamp`)。語が空なら何もしない。前の当たりは**消さない**(返るまで
   * 一覧がちらつかない)。
   */
  | { type: 'REFRESH_SEARCH' }
  | { type: 'REFRESH_CAPTURE_SCAN' }
  | { type: 'REFRESH_SNIPPET_SCAN' }
  /**
   * タイル設定を書き戻した ack(P8 段⑭)。⚠ **開いている body も差し替える**。
   * ⚠ `body === null` は失敗(書けなかった)── **ロックは必ず解く**。
   */
  | { type: 'APP_TILE_SAVED'; lid: string; gen: number; body: string | null }
  | {
      type: 'START_EDIT';
      /**
       * 🔴 **入った瞬間に開く行**(#395 段③)。省略 = どこも開かない(これまでどおり)。
       * ⚠ 座標は**frontmatter を外した側** ── 読む面の `data-pkc-source-line` と同じ基準。
       */
      atLine?: number;
      /**
       * 🔴 **保存していない編集を戻して入る**(#1376)。本文だけを差し替える ──
       * 基準(`baseline` / `persisted`)は disk のまま。⚠ 書かない(保存を押すまで disk は動かない)。
       */
      restoreBody?: string;
    }
  | { type: 'UPDATE_OPEN_BODY'; body: string }
  | { type: 'COMMIT_EDIT' }
  | { type: 'CANCEL_EDIT' }
  /**
   * 🔴 **章だけの下書きを開く**(#1044 段2)。
   * @param line 押した見出しの行(frontmatter を外した側。`bodySourceLineAt` と同じ基準)
   */
  | { type: 'OPEN_SECTION_DRAFT'; lid: string; line: number }
  /**
   * 🔴 **章の欄を保存する**(#1044 段2)。⚠ `text` は箱の**いまの字**
   *   (見出し行を含む)。断ったら `sectionDraft` は残る(箱は消えない)。
   */
  | { type: 'SAVE_SECTION_DRAFT'; text: string }
  /** 🔴 **章の欄を、書かずに閉じる**(#1044 段2)。 */
  | { type: 'CANCEL_SECTION_DRAFT' }
  /**
   * 🔴 **コード枠だけの下書きを開く**(#1044 段3)。
   * @param line 押した枠の開きの行(frontmatter を外した側。`OPEN_SECTION_DRAFT` と同じ基準)
   */
  | { type: 'OPEN_CODE_DRAFT'; lid: string; line: number }
  /**
   * 🔴 **コード枠の欄を保存する**(#1044 段3)。⚠ `text` は箱の**いまの字**
   *   (引用の前置き・開き・閉じの行は含まない)。断ったら `sectionDraft` は残る。
   */
  | { type: 'SAVE_CODE_DRAFT'; text: string }
  /** 🔴 **コード枠の欄を、書かずに閉じる**(#1044 段3)。 */
  | { type: 'CANCEL_CODE_DRAFT' }
  | { type: 'TOGGLE_TODO_STATUS'; lid: string }
  /**
   * 🔴 **カレンダーの日付を付け外しする**(#276)。`null` で外す。
   * ⚠ 書くのは frontmatter の 1 鍵だけ ── 本文は byte 無傷である
   *   (経路は `REQUEST_FRONTMATTER_SET` = todo のトグルと同じ 1 本)。
   */
  | {
      type: 'SET_ENTRY_DATE';
      lid: string;
      date: string | null;
      /**
       * 🔴 **前書きの `date:` に書く時刻**(台帳 #1852 / 依頼 192 / 284)。省略 = **書かれている時刻を残す**(日だけ動かす)。
       * `null` = 時刻を外す。`date` が `null`(日付を外す)ときは無視する(日付ごと消える)。
       */
      time?: string | null;
      /**
       * 🔴 **前書きの `date:` に書く生の値**(台帳 #344 の残り ── 期間・繰り返し・終日つきのノートを「元に戻す」)。
       * 渡すと**その字をそのまま**書く(組み直さない)。`date` は抽出列の日付との照合に使う。`date` が `null` のときは無視する。
       */
      raw?: string;
    }
  /**
   * 🔴 **板の塊を動かす**(#283 P4-b)── いま開いているノートの `line` 行目
   * (生の body の行番号 = 描画が焼いた `data-pkc-source-line` + frontmatter)の
   * `.pkc-place` 開き行の x= / y= を書き換える。掴んだ時点の開き行は reducer が
   * `openBody` から捕える(呼び側に本文を持たせない)。
   */
  | { type: 'MOVE_PLACE'; lid: string; line: number; x: number; y: number }
  /**
   * 🔴 **グループの全員を一度に動かす**(#530 段⑤b)── 1 回の書込。1 枚でも門が外れたら 1 枚も書かない。
   * 掴んだ時点の開き行は reducer が捕える(`MOVE_PLACE` と同じ)。
   */
  | { type: 'MOVE_PLACES'; lid: string; moves: ReadonlyArray<{ line: number; x: number; y: number }> }
  /** 🔴 付箋をグループにする(#530 段⑤b)── `lines` は付箋の開き行(生の body の行番号)。2 枚以上。同じ門。 */
  | { type: 'GROUP_PLACES'; lid: string; lines: readonly number[] }
  /** 🔴 グループを解く(#530 段⑤b)── 渡した付箋のグループの全員の `group=` を消す。同じ門。 */
  | { type: 'UNGROUP_PLACE'; lid: string; line: number }
  /**
   * 🔴 **板を画面から作る・大きさを変える・消す**(#676。user 裁定 2026-09-04)。
   * ⚠ 3 つとも `MOVE_PLACE` と**同じ門**(`bodyRewriteGate`)を通る ── phase / 画面に出ている
   *   本文 / 開き行の捕捉を、case ごとに書き直さない(§7)。
   * ⚠ `ADD_PLACE` だけ行番号を持たない(足す先は常に末尾)。
   */
  | { type: 'RESIZE_PLACE'; lid: string; line: number; w: number; h: number }
  /**
   * 🔴 **板を線で繋ぐ**(#530 段③d)── 掴んで引いて離した結果。
   * ⚠ 接続点の綴りは `null` でよい(自動)。読めない字は `place-notation.ts` が断る。
   */
  | {
      type: 'CONNECT_PLACE';
      lid: string;
      line: number;
      toLine: number;
      fromAnchor: string | null;
      toAnchor: string | null;
    }
  | { type: 'REMOVE_PLACE'; lid: string; line: number }
  /**
   * 🔴 **線を消す**(#530 段③d)── 掴んで引いた線を、本文を開かずに外す(片道にしない)。
   * ⚠ `REMOVE_PLACE` と**同じ門**。受ける開き行が**線**であることだけが違う
   *   (板の行を渡しても消えない)。
   */
  | { type: 'REMOVE_PLACE_LINE'; lid: string; line: number }
  /**
   * `template` = テンプレートから置く(#529 W4)/ `entry` = ほかのノートを置く(#1662 2。置くノートの lid)。
   * 渡すのはどちらか一方まで。
   */
  | { type: 'ADD_PLACE'; lid: string; x: number; y: number; template?: PlaceTemplateId; entry?: string }
  /**
   * 🔴 **位置と大きさを数で入れる**(#529 W2)── 開き行の x= y= w= h= のうち渡した札だけを一度に書く。
   * 同じ門。値は reducer でも検める(窓の検めと同じ規則 ── 型は境界で効かない)。
   */
  | { type: 'SET_PLACE_RECT'; lid: string; line: number; rect: PlaceRectValue }
  /** 板を前へ出す(#676 段②)── 他の板の z= の最大 + 1 を書く。同じ門。 */
  | { type: 'RAISE_PLACE'; lid: string; line: number }
  /** 板を後ろへ送る(依頼 118-1)── 他の板より後ろへ回す。同じ門。 */
  | { type: 'LOWER_PLACE'; lid: string; line: number }
  /**
   * 🔴 **ふつうの付箋の中の字を、その場で書く**(#1662 1)── 開き行と閉じの間だけを書く。同じ門。
   * `before` = 欄を開いた時点の中身(別の窓が先に直していれば書かない)。
   */
  | { type: 'SET_PLACE_TEXT'; lid: string; line: number; text: string }
  /**
   * 板の形を変える(#530 案 A。user 裁定 2026-09-14)── 開き行の `shape=` を書く。同じ門。
   * ⚠ 綴りは `PlaceShape` に閉じる ── 知らない字は reducer で断る(`slices/places.ts` の `SET_PLACE_SHAPE`)。
   */
  | { type: 'SET_PLACE_SHAPE'; lid: string; line: number; shape: PlaceShape }
  /**
   * 🔴 **付箋の色・線の色と太さを書く**(#530 段④。Gemini 裁定 A、2026-10-02)── 開き行の
   * `fill=` / `stroke=` / `width=` を書く(`null` の札は**消す**)。同じ門。
   * ⚠ 綴りは `PlaceStyle` に閉じる ── 読めない値・持てない札は reducer で断る(`slices/places.ts` の `SET_PLACE_STYLE`)。
   */
  | { type: 'SET_PLACE_STYLE'; lid: string; line: number; style: PlaceStyle }
  /**
   * 🔴 **本文の塊を、本文の中で掴んで並べ替える**(#684 段①。user 要望 2026-09-03)。
   * `start..end` の行(**生の body** の行番号 = 描画の刻印 + frontmatter)を `toBefore` の
   * 前へ動かす。掴んだ時点の行そのものは reducer が画面の本文から捕える(呼び側に
   * 本文を持たせない ── `MOVE_PLACE` の開き行と同じ作法)。門は板の 5 つと**同じ**
   * (`bodyRewriteGate`)。
   */
  | { type: 'MOVE_BLOCK'; lid: string; start: number; end: number; toBefore: number }
  /**
   * 🔴 **章を新しいノートに切り出したあと、元の本文の章をリンク 1 行にする**(#1439)。
   * 新しいノートは binder が先に `CREATE_ENTRY` で作ってある(入れてから切る ── 書けなかった回は
   * 二重になるだけで、章は消えない)。`start..end` は**生の body** の行(章の見出しの下)。
   * 掴んだ時点の行は reducer が画面の本文から捕える(`MOVE_BLOCK` と同じ)。
   */
  | { type: 'SPLIT_CHAPTER'; lid: string; start: number; end: number; link: string; childLid: string; childTitle: string }
  /**
   * 🔴 **切り出した章を元に戻す**(#1439。片道にしない)── リンクの 1 行を新しいノートの本文で置き換え、
   * 新しいノートを削除する(ゴミ箱から戻せる)。2 つのノートを触るので専用の event(`REQUEST_CHAPTER_RESTORE`)。
   */
  | { type: 'RESTORE_CHAPTER'; lid: string; childLid: string; line: number }
  /**
   * 🔴 **本文の塊を、別のノートへ持っていく**(#684 段③)。
   *
   * > user 要望 2026-09-03:「本文の行 / 塊を、別のノートへ」
   *
   * ⚠ `MOVE_BLOCK`(同じ本文の中)とは**別の action** ── 触る本文が 2 つになるので、
   *   門も、書く順番も、戻し方も違う(1 本に丸めると片方の規律がもう片方に漏れる)。
   * ⚠ `toBefore: null` = 行き先の**末尾**(一覧の行へ落とした回。落とした所が無い)。
   * 🔑 掴んだ時点の行そのものは reducer が**画面の本文から**捕える(`MOVE_BLOCK` と同じ)。
   */
  | {
      type: 'HANDOFF_BLOCK';
      fromLid: string;
      start: number;
      end: number;
      toLid: string;
      toBefore: number | null;
      anchor?: InsertAnchor;
    }
  /**
   * 🔴 **行の並びを本文へ差し込む**(#684 段②)── 一覧の行を本文へ落とすとリンクになる。
   * ⚠ 何を入れるか(リンクの字)は binder が組んで渡す(`formatEntryLink` 1 本)。
   */
  | {
      type: 'INSERT_LINES';
      lid: string;
      toBefore: number;
      lines: readonly string[];
      /**
       * 取り込みの回の印(#684 段④)。同じ印で入れた行は `lastAppend` で 1 手に継がれる。
       * ⚠ 省略 = 単独の 1 手(一覧の行を落とした 1 回は、それ自身で 1 手)。
       */
      batch?: string;
      /**
       * 編集中の断り文の**続き**(#684 段④。前置きは `bodyRewriteGate` が
       * `phaseBlockReason` から付ける ── C11b / #1045)。⚠ **押した場所と対で書く**
       * ── 既定は「、一覧の行を…」なので、file を落とす経路はそのままだと嘘を言う。
       */
      refusal?: string;
      /**
       * 🔴 **落とした時の目印**(#684 段④)── 書く直前に disk 側で突き合わせる。
       * ⚠ **必須**(#1087)── 段②(一覧の行)も、落としてから書くまでに別の窓が行を足せば、
       *   番号は別の所を指す。省ける形にすると、送り手が渡し忘れても tsc が黙る。
       */
      anchor: InsertAnchor;
    }
  /**
   * 🔴 **直前の塊の移動を元に戻す**(#684 段①。user 指示 2026-08-23「片道の操作を作らない」)。
   * ⚠ `UNDO_APPEND` と同じ形 ── 独自の書込経路を作らず `REQUEST_BODY_REWRITE` を通る。
   */
  | { type: 'UNDO_MOVE' }
  /**
   * 🔴 **本文の 1 行の日付**(双方向。user 指示 2026-08-23)。
   * ⚠ `SET_ENTRY_DATE`(ノート 1 件が丸ごと予定)とは**単位が違う**。
   * ⚠ `date: null` は予定から外す。
   */
  | {
      type: 'SET_TASK_DATE';
      lid: string;
      line: number;
      /**
       * 🔴 **押した / 掴んだ時点のその行の中身**(#1087)。⚠ 行番号だけだと、別の窓が上へ 1 行足したとき
       *   古い表示から押した操作が**別の項目**を書き換える。運ぶのは押した面(`shown-line.ts` の 3 つのうち、
       *   その面が見ている本文から引く)。書換は disk 側と byte 一致しなければ断る。
       */
      openLine: string;
      date: string | null;
      time?: string | null;
      /** 🔴 期間の終わり(#344 段①)。単日にするなら渡さないか `null`。 */
      until?: string | null;
      /**
       * 🔴 **時刻の終わり**(#855 段 B-1。時間の目盛りで札の下の縁を引く / 札を動かす)。
       * ⚠ 渡さなければ**書かれている終わりを保つ**(始まりが同じとき)── 渡して `null` なら終わりを外す。
       */
      timeEnd?: string | null;
      /**
       * 🔴 **刻みも書き直すとき**(#1087。繰り返しの「全部」で曜日の列を回す)。
       * ⚠ 渡さなければ元の刻みを保つ(日だけ動かして `毎週` が消えない)。
       */
      repeat?: RepeatUnit;
      /**
       * 🔴 **終日**(台帳 #344 の残り。`終日` の語を書き戻す ── 日付を外した予定を「元に戻す」)。
       * ⚠ 渡さなければ書かれている `終日` を保つ。渡すとそれに従う(時刻・期間が付くなら書かれない)。
       */
      allDay?: boolean;
    }
  /**
   * 🔴 **その行の繰り返しを付け替える**(#855 段 0 の 3 つ目。user 裁定 2026-09-13
   * 「札を右クリック →『繰り返す』」)。
   *
   * ⚠ **`SET_TASK_DATE` と分ける** ── あちらは `date` を**必ず**受け、
   *   `null` かどうかで「外す / 付ける」を言い分けている。日付を省ける形にすると
   *   その判定が濁るので、**刻みだけを言う action**を別に立てる。
   * ⚠ 書く先は**同じ 1 本**(`REQUEST_BODY_REWRITE` の `kind: 'line-date'`)──
   *   面が独自の書込経路を持たない(§7)。
   * ⚠ `repeat: null` は**繰り返しをやめる**(日付は残る)。
   */
  | { type: 'SET_TASK_REPEAT'; lid: string; line: number; openLine: string; repeat: RepeatUnit | null }
  /**
   * 🔴 **チェックの印を付け外しする**(#277)。`line` は**原文の行番号**。
   * ⚠ 索引(何番目のチェックか)ではなく**行**で指す ── 索引だと、数え方が
   *   描画側と原文側で 1 つでもずれた瞬間に**別の行を書き換える**。
   */
  | { type: 'TOGGLE_TASK'; lid: string; line: number; openLine: string }
  /**
   * 🔴 **チェックリストを丸ごと「完了」/「未完了」へそろえる**(#1173)。
   * ⚠ `TOGGLE_TASK` と**同じ形**:書換は 1 本(`REQUEST_BODY_REWRITE`)を通る。
   *   `lines` は面が運ぶ**原文の行番号**の並び(判断は `body-rewrite.ts` の `applyTaskRun`)。
   */
  | {
      type: 'SET_TASK_RUN';
      lid: string;
      lines: readonly number[];
      /** 🔴 押した時点の各行の中身(`lines` と同じ並び。#1087。`TOGGLE_TASK` の `openLine` と同じ理由)。 */
      openLines: readonly string[];
      to: 'done' | 'open';
    }
  /**
   * 🔴 **本文の色コードを 1 つ書き換える**(#1224)。⚠ `TOGGLE_TASK` と**同じ形**:書換は 1 本
   *   (`REQUEST_BODY_REWRITE` の `kind: 'color'`)を通り、面が独自の書込経路を持たない(§7)。
   * ⚠ `line` は**原文の行番号**、`nth` は**その行の何番目の色コードか**、`from` は**押した時点の字**
   *   (6 桁小文字)、`to` は選んだ色(6 桁小文字)。判断は `body-rewrite.ts` の `rewriteColor`。
   */
  | { type: 'SET_COLOR_CODE'; lid: string; line: number; nth: number; from: string; to: string }
  /**
   * 🔴 **添付のダウンロードのファイル名を書き換える**(#1220 穴②、裁定 A)。
   * ⚠ `TOGGLE_TASK` と**同じ形**:書換は 1 本(`REQUEST_BODY_REWRITE` の `kind: 'attachment-name'`)を通る。
   * ⚠ `name` は**打たれた字そのまま**(拡張子の足し方・使えない字の置き換えは、書く直前に
   *   disk の本文から決める ── `attachmentFileName`)。題名は `RENAME_ENTRY_TITLE` の別の 1 本。
   */
  | { type: 'SET_ATTACHMENT_NAME'; lid: string; name: string }
  /**
   * 🔴 **話者を直す**(#952 B6)。⚠ `SET_ATTACHMENT_NAME` と**同じ形**:書換は 1 本(`REQUEST_BODY_REWRITE` の `kind: 'speakers-fix'`)を通り、
   *   断りは lid で判定する。`renames` は `[いまの名前, 新しい名前]`、`at` は見出しの日時に使う時刻(epoch ms)。
   */
  | { type: 'FIX_SPEAKERS'; lid: string; renames: ReadonlyArray<readonly [string, string]>; at: number }
  /**
   * 🔴 **表のセルを 1 つ書き換える**(#418 段①)。
   * ⚠ `TOGGLE_TASK` と**同じ形**:書換は 1 本(`REQUEST_BODY_REWRITE`)を通り、
   *   面が独自の書込経路を持たない(§7)。何をするかの判断は `body-rewrite.ts`。
   * ⚠ `line` は**原文の行番号**、`col` はその行の何番目のセルか。
   *   区切り字は**渡さない** ── 囲みの見出しから決まる(呼び手に決めさせない)。
   */
  | { type: 'SET_CSV_CELL'; lid: string; line: number; openLine: string; col: number; value: string }
  /**
   * 🔴 **入力欄(` ```yaml form `)の値を、先頭の設定欄に書く**(#1456)。⚠ `SET_CSV_CELL` と同じ形:書換は 1 本
   *   (`REQUEST_BODY_REWRITE` の `frontmatter`)を通り、面が独自の書込経路を持たない(§7)。
   * ⚠ 鍵は `vars.<項目名>`(`{{vars.…}}` の差し込みが読む綴り)。値が `undefined` ならその行を消す(空の入力)。
   */
  | { type: 'SET_FORM_VALUES'; lid: string; values: Readonly<Record<string, string | number | boolean | undefined>> }
  /**
   * 🔴 **入力欄の値を表の行へ書く / 足す**(#1456)。⚠ `SET_CSV_CELL` と同じ形(断りも lid で判定)。
   */
  | {
      type: 'SET_FORM_ROW';
      lid: string;
      table: string;
      mode: 'add' | 'update';
      row?: number;
      /** 🔴 押した時点のその行の升(`SET_CSV_CELL` の `openLine` と同じ型)。更新のとき。 */
      openRow?: readonly string[];
      fields: ReadonlyArray<{ readonly name: string; readonly label: string }>;
      cells: Readonly<Record<string, string>>;
    }
  /**
   * 🔴 **表の行・列を足す / 消す**(#418 段①)。⚠ `SET_CSV_CELL` と同じ形。
   */
  | {
      type: 'SET_CSV_SHAPE';
      lid: string;
      line: number;
      /** 🔴 押した時点のその行の中身(#1087)。`SET_CSV_CELL` の `openLine` と同じ。 */
      openLine: string;
      col: number;
      what: 'row' | 'col';
      mode: 'add' | 'remove';
    }
  /**
   * 🔴 **表の形を変える**(#708 段②)。⚠ `SET_CSV_CELL` と同じ形。
   * ⚠ `line` は**原文の行番号**(押した表のどの行でもよい)── 書き換える範囲は
   *   `table-convert.ts` が原文から引く(呼び手に範囲を決めさせない)。
   */
  | { type: 'SET_TABLE_FORMAT'; lid: string; line: number; openLine: string; to: TableFormat; header?: boolean }
  /**
   * 🔴 **本文の画像の大きさ・寄せを書く**(#1640 ③)。`SET_TABLE_FORMAT` と同じ形 ── 書換は 1 本
   * (`REQUEST_BODY_REWRITE`)を通る。渡さなかった札は保つ、`null` は外す。
   */
  | {
      type: 'SET_IMAGE_ATTRS';
      lid: string;
      line: number;
      openLine: string;
      key: string;
      nth?: number;
      w?: number | null;
      align?: 'left' | 'center' | 'right' | null;
    }
  /**
   * 🔴 **繰り返しの「その回」を済ませる**(#344 段②)。
   * ⚠ `TOGGLE_TASK` と**単位が違う** ── 規則の行の印は動かさず、
   *   **その日ぶんの行を 1 本増やす**(理由は `body-rewrite.ts` の `repeat-done`)。
   * ⚠ `line` は**規則の行**、`date` は**押した回の日**である。
   */
  | { type: 'MATERIALIZE_REPEAT'; lid: string; line: number; openLine: string; date: string }
  /**
   * 🔴 **繰り返しの「その回だけ」を別の日へ動かす**(#855 決4。
   * user 裁定 2026-09-13「1 回か全部か選択する(Outlook 模倣で OK)」)。
   *
   * ⚠ すぐ上の `MATERIALIZE_REPEAT` と**兄弟**である ── 規則の行は触らず、
   *   その回ぶんの行を 1 本増やす。違うのは**書く日**と**振替が付くこと**、
   *   そして**印を押さないこと**(理由は `body-rewrite.ts` の `repeat-move`)。
   * ⚠ 「**全部ずらす**」はこの action ではない ── あちらは規則の行の日付を
   *   書き換えるだけなので `SET_TASK_DATE` で足りる(口を増やさない ── §7)。
   * ⚠ `line` は**規則の行**、`from` は**動かす回の日**、`to` は**落とした日**。
   */
  | {
      type: 'MOVE_REPEAT_OCCURRENCE';
      lid: string;
      line: number;
      /**
       * 🔴 **押した / 掴んだ時点のその行の中身**(#1087)。⚠ 行番号だけだと、別の窓が上へ 1 行足したとき
       *   古い表示から押した操作が**別の項目**を書き換える。運ぶのは押した面(`shown-line.ts` の 3 つのうち、
       *   その面が見ている本文から引く)。書換は disk 側と byte 一致しなければ断る。
       */
      openLine: string;
      from: string;
      to: string;
      /**
       * 🔴 **その回の時刻も変える**(#855 段 B-1。時間の目盛りで動かしたとき)。
       * ⚠ 渡さなければ規則の時刻を持ち越す。渡したとき `timeEnd` を省けば終わりは付かない。
       */
      time?: string;
      timeEnd?: string | null;
    }
  /**
   * 🔴 **外部の画像を手元へ取り込んだ結果を本文へ当てる**(#264 段①)。
   *
   * ⚠ **取りに行くのは binder(adapter)** ── ここに届くのは
   *   「読めたものの `url → asset:<key>`」だけである(reducer は fetch しない)。
   * ⚠ `TOGGLE_TASK` と**同じ形**:書換は 1 本(`REQUEST_BODY_REWRITE`)を通り、
   *   面が独自の書込経路を持たない(§7)。
   * ⚠ 空の対応では**撃たない**(binder 側で弾く)── 撃つと effect が
   *   「本文が変わっている」という**嘘の理由**を出す。
   */
  | { type: 'ADOPT_EXTERNAL_IMAGES'; lid: string; adopted: Readonly<Record<string, string>> }
  /**
   * 🔑 **追記**(P8 段⑧)。編集画面を開かずに末尾へ足す。
   * ⚠ `heading` は binder が作って渡す(reducer は純粋のまま ── `Date` を呼ばない)。
   * ノートは `null`(見出しを勝手に足さない)。
   */
  | {
      /**
       * 🔴 **直前の追記を取り消す**(#395 段①。user 指示 2026-08-23
       * 「**片道の操作を作らない**」)。
       * ⚠ 独自の書込経路を作らない ── `REQUEST_BODY_REWRITE` を通る(§7)。
       */
      type: 'UNDO_APPEND';
    }
  | {
      /**
       * 🔴 **直前の AI の書き足しを取り消す**(台帳 #1852 P1 / 依頼 362)。`UNDO_APPEND` と同じ形で、
       * 材料だけが別(`lastAgentAppend`)── 自分の追記の取り消しとは混ざらない。
       */
      type: 'UNDO_AGENT_APPEND';
    }
  | {
      type: 'APPEND_TO_ENTRY';
      lid: string;
      text: string;
      heading: string | null;
      /** 入り先の印(#395 段①)。`null` = 末尾。 */
      target: string | null;
      /**
       * 取り込みの回の印(#668 C)。同じ印の追記は `lastAppend` で 1 手に継がれる。
       * ⚠ 省略 = 単独の 1 手(手で足した追記)。
       */
      batch?: string;
    }
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
      /**
       * 🔴 **取り込んだ絵の鍵**(#856 段②)。`null` = 外す。
       * ⚠ 3 値にしないと「絵を外して字に戻す」が表せない。
       */
      iconAssetKey?: string | null;
    }
  /**
   * 🔴 **タイルを並べ替える**(#857 段①。user 指示 2026-09-12「並び替えしたい」/
   * 裁定 A「**またげる**」)。
   *
   * ⚠ `SET_APP_TILE` を N 回撃つ形にはしない ── あちらは
   * **別の lid の書込が飛んでいると無言で落とす**(すぐ下の門)ので、
   * 2 件目以降が**画面も出さずに消える**(user から見ると「並べ替えたのに戻る」)。
   * 🔑 計画は `planTileMove`(純関数)が立て、**1 つの event**で effect へ渡す。
   */
  | { type: 'MOVE_APP_TILE'; lid: string; target: TileMoveTarget }
  /**
   * 🔴 **タイルに印を付ける**(#857 段①b)── **1 回目の押し**が撃つ。
   * ⚠ 開くのは**2 回目**(`open-tile` の受け手が数える)── 掴もうとして
   *   少し動かして離しただけで窓が開き、中央の本文まで入れ替わるのを止める。
   */
  | { type: 'PICK_APP_TILE'; lid: string }
  /**
   * 🔴 **並べ替えモードの出入り**(#857 段①b-2)。
   * ⚠ 入口は 2 つ ── **長押し**(指・ペン)と**右クリックの「並べ替える」**(マウス)。
   *   出口も 2 つ ── 一覧の「並べ替えを終える」と、右クリックの同じ字。
   * ⚠ 絞り込みを打つと落ちる(`SET_ENTRY_FILTER`)。
   */
  | { type: 'SET_LAUNCHER_REORDER'; on: boolean }
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
      /**
       * 🔴 **差し替え後の綴りと中身の種類**(#214)。
       *
       * ⚠ 直す前はここに載っていなかったので、`.odt` を開いて `.docx` で
       * 上書き保存しても frontmatter は**古い綴りのまま**残り、
       * 「Office で開く」が **`報告.odt` という名前で docx を渡して**いた
       * (LO は拡張子で filter を選ぶ)。読み手は 5 面ある。
       */
      newName: string;
      newMime: string;
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
  /** 予定の面の「一覧 / 日」(#855 段 A-1)。 */
  | { type: 'SET_SCHEDULE_MODE'; mode: 'list' | 'day' | 'week' | 'month' | 'board' }
  | { type: 'SET_SCHEDULE_NARROW_MODE'; mode: 'list' | 'day' }
  /** 「日」で見る日。`null` = 今日に戻る。実在しない日は黙って捨てる(別の日へ寄せない)。 */
  | { type: 'SET_SCHEDULE_DAY'; date: string | null }
  | { type: 'TOGGLE_SHOW_ARCHIVED' }
  /** 板の「完了」を開く / 畳む(2026-08-20。設計 doc §4-4)。 */
  | { type: 'TOGGLE_SHOW_DONE_TASKS' }
  | { type: 'TOGGLE_SHOW_UNDATED_TASKS' }
  /** 🔴 予定の面を担当で絞る(#283)。`null` = 全員 / `''` = 担当なし / 名前。見え方だけ(走査は頼み直さない)。 */
  | { type: 'SET_SCHEDULE_OWNER'; owner: string | null }
  /** 🔴 ノート 1 件の担当を書く / 外す(#283。前書きの `owner:`)。`owner: null` = 外す(`date` と同じ双方向)。 */
  | { type: 'SET_ENTRY_OWNER'; lid: string; owner: string | null }
  /** 予定の面で、そのノートの予定を隠す / 出す(「出すもの」のノートの一覧)。 */
  | { type: 'TOGGLE_SCHEDULE_NOTE'; lid: string }
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
      /**
       * 🔴 **作っても中央の本文を退かさない**(#633 段③ ── 帯の「保存…」)。
       * ⚠ 既定の `CREATE_ENTRY` は選択を新しい物へ動かし、絞りも外す。スタックの保存は
       *   「読んでいる最中に、いまの並びを取っておく」操作なので、**さっきまで読んでいた本文が
       *   消える**のは #300 の型である(補助的な物が主の作業領域を奪う)。
       * 🔑 `true` なら選択・開いている本文・絞りを動かさず、編集にも入らない(`edit` より強い)。
       */
      keepSelection?: boolean;
    }
  | { type: 'DESELECT_ENTRY' }
  /**
   * 現在地を動かす(#240 段①)。`lid: null` = ルートへ。
   * ⚠ **選択は動かさない** ── 中央に開いているノートはそのまま(入っただけで
   * 本文が閉じると、フォルダを辿る間じゅう本文が消える)。
   */
  | { type: 'SET_SCOPE'; lid: string | null }
  /**
   * 「中まで全部出す」を入れる / 切る(#813 段②)。⚠ 憶える(端末)のは呼び手の仕事 ──
   * reducer は state だけを動かす(`DUAL_SET_PREVIEW` と同じ作り)。
   */
  | { type: 'SET_FILER_FLATTEN'; on: boolean }
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
   * ⚠ 「中まで全部出す」/ 語を打っている間は、階層をまたいだ**平らな並び**で採る
   *   (`filerRowOptions` が持つ ── 描く側と同じ 1 本)。
   *   「一覧」タブ専用だった `scope: 'list'` は #813 段③ で消えた。
   */
  | { type: 'SELECT_RANGE'; lid: string }
  /** 印を全部外す。 */
  | { type: 'CLEAR_SELECTION' }
  /** 印をその 1 件だけにし、起点もそこに立てる(#1087。`CLEAR_SELECTION` + `TOGGLE_SELECT` を 1 回の描き直しで)。 */
  | { type: 'SELECT_ONLY'; lid: string }
  /**
   * 🔴 **いま出ている行をぜんぶ選ぶ**(user 裁定 2026-08-18「OS のファイラに似せる」)。
   * ⚠ 「全部」は **`entryMetas` の全件ではなく、いま表に出ている行**である ──
   * 絞り込みや現在地で見えていないものを巻き込むと、まとめて削除が
   * **画面に無いものを消す**(#240 の着地前レビューで実際に踏んだ形)。
   */
  | { type: 'SELECT_ALL' }
  /**
   * 🔴 **まとめてゴミ箱へ**(#240 段③。user 指示 2026-08-17「まとめて消せない」)。
   * ⚠ **1 回の操作**として扱う ── `DELETE_ENTRY` を n 回撃つと、途中で断られたときに
   * 「半分だけ消えた」が作れる。⚠ 完全削除(`purge`)は一括で撃たせない。
   */
  | { type: 'DELETE_ENTRIES'; lids: readonly string[] }
  | { type: 'DELETE_ENTRY'; lid: string }
  | { type: 'RENAME_ENTRY_TITLE'; lid: string; title: string }
  /**
   * 🔴 **ノートの種類を変える**(台帳 #1852 I2 / 依頼 157。Gemini 回答 = 推薦 ②)。本文は変わらない。
   * ⚠ 変えられる組はノート ⇄ ログだけ(`kind-change.ts`)。編集中・取り込み中は変えない(理由を言う)。
   */
  | { type: 'SET_ENTRY_ARCHETYPE'; lid: string; archetype: string }
  /**
   * 🔴 **居場所を変える**(2026-08-05。フォルダ整理)。
   * `parentLid: null` = ルートへ出す。⚠ 「外す」と「入れる」を 2 つに割らない ──
   * 割ると途中で落ちたときに親無しが残る(PKC2 がその形だった)。
   */
  | {
      type: 'SET_ENTRY_PARENT';
      lid: string;
      parentLid: string | null;
      relationId: string;
      /**
       * 🔴 **2 本目以降の親**(台帳 #1852 G1 / 依頼 227 A)。2 つ以上のフォルダに入っていたノートを移したあとの「元に戻す」が、
       * 入っていたフォルダ全部へ戻すために使う。⚠ 1 本目と同じ検め(実在するフォルダ・輪にならない)を通った分だけ張る。
       */
      alsoIn?: readonly { parentLid: string; relationId: string }[];
    }
  /** 同じ親の下で隣と入れ替える(2026-08-06。user 報告 2-10)。 */
  | { type: 'MOVE_ENTRY_ORDER'; lid: string; direction: 'up' | 'down' }
  /**
   * 🔴 **並びの値を置く**(台帳 #1852 N1 / 依頼 154 ②。Gemini 回答 = 推薦どおり)。別のフォルダへ移したノートを、**移し先の末尾**に並べる。
   * `'end'` = 全体の末尾(新しく作ったノートと同じ ── 同じ親の下の末尾にもなる)/ 数 = その値へ戻す(「元に戻す」が移す前の位置へ戻す)。
   * ⚠ 値を戻すだけで、ほかのノートの値は動かさない(戻す値は移す前に読んだ物で、ほかのノートの値は変わっていない)。
   */
  | { type: 'SET_ENTRY_ORDER'; lid: string; entryOrder: number | 'end' }
  /**
   * 🔴 **選んだ全部にタグを付ける / 外す**(#402 ①)。
   * ⚠ 相手は**いま表に出ている印**だけ(`delete-selected` と同じ規則 ── 画面に
   *   無いものを触らない)。呼び側がその集合を渡す。
   */
  | {
      type: 'BULK_TAG';
      lids: readonly string[];
      tags: readonly string[];
      mode: 'add' | 'remove';
      /**
       * ⚠ **どの欄から来たか**(#640)── 入らなかった名前をその欄へ戻すため。
       *   欄を持たない呼び手(札を外す `untag-entry` 等)は渡さない = 戻す先が無い。
       */
      field?: TagInputField;
      /**
       * 🔴 **前の知らせに続けて言う**(#1087)── 名前の変更は「外す」「付ける」の 2 回で、
       *   2 回目の知らせが 1 回目を上書きしていた(外せなかった件数が消えていた)。
       */
      afterPrevious?: boolean;
      /**
       * 🔴 **名前の変更の 1 回目(外す)**(#1163 依頼 314。Gemini の裁定)。本文の行にしか書いていないノートは
       *   名前を変える相手から外す(2 回目の「付ける」にも入れない)── 本文は user が書いた文章で、
       *   機械が書き換えないため。外した件数は知らせで言う。
       */
      renameFirst?: boolean;
    }
  /**
   * 🔴 **タグの名前を変えたとき、スマートフォルダの条件の同じ名前も変える**(#1087)。
   * ⚠ 直す前は条件が旧い名前のまま残り、変えた後に集まるノートが変わった(旧い名前を持つノートが
   *   もう無いので、スマートフォルダが空になる)。相手は**スマートフォルダ全部**(いま画面に出ている物とは限らない)。
   */
  | {
      type: 'RENAME_SMART_TAG';
      from: string;
      /**
       * 🔴 `null` = **タグを全部外した**(#1163 依頼 321。Gemini の裁定 A)。条件は変えず、そのタグを条件にした
       *   スマートフォルダの件数を**知らせるだけ**にする(外したタグを後でまた付ける使い方があるため)。
       */
      to: string | null;
    }
  /**
   * 🔴 **一時の知らせ**(#402 ①)。⚠ `OP_FAILED` と混ぜない ── あちらは赤い帯で、
   *   こちらは成功の内訳である(「3 件は既に付いていました」を失敗にしない)。
   */
  | {
      type: 'OP_NOTICE';
      message: string;
      /** 隣に「開く」で出す物の lid(#668 A)。省略 = 押す口を出さない。 */
      open?: string;
      /**
       * 🔴 隣に「○○のノートを作る」で出す日付(#1169)。省略 = 押す口を出さない。
       * ⚠ 出す字は `dateNoteMissingNotice` と対(出し入れは `status-open.ts`)。
       */
      createDate?: string;
      /**
       * 🔴 **隣に「元に戻す」で出す、戻す先の版**(#1662 5)。表の行・列を消した直後に、消す前の本文の版へ戻す。
       * 押し先は履歴の「この版に戻す」と同じ `restore-revision`(`restoreUndo` を共有する)。省略 = 出さない。
       */
      restoreUndo?: { lid: string; revId: string };
      /**
       * 🔴 **まとめてタグを付けた直後の「元に戻す」の材料**(台帳 #1852 G1 / 依頼 109 A)。今回**付けた**ノートだけを組ごとに持つ
       * (もとから付いていたノートは含まない ── 戻すときに触らない)。押し先は `undo-bulk-tag`。省略 = 出さない。
       */
      tagUndo?: { groups: readonly TagUndoGroup[] };
      /**
       * 🔴 **AI の書き足しの知らせ**(台帳 #1852 P1 / 依頼 362)。`true` = 隣に「AI の書き足しを元に戻す」を出す
       * (`lastAgentAppend` が `open` のノートのときだけ。字は知らせと対で控える)。省略 = 出さない。
       */
      agentUndo?: true;
    }
  /**
   * 🔴 **画面下の知らせの時間が切れた**(#1017 C5 Q1)。⚠ `message` が**いま載っている知らせと同じとき
   *   だけ**降ろす(古い時計が、後から来た別の知らせを消さない)。
   * ⚠ 降ろさないと、同じ字の知らせ(「見つかりませんでした」を 2 回押す等)が
   *   `state.notice` と同じなので**2 回目が出ない**(`main.ts` は字の変化で出す)。
   */
  | { type: 'NOTICE_EXPIRED'; message: string }
  /**
   * 🔴 **押したのに入らなかったタグ**(#640 案 A)── 効果層が断った名前を欄へ戻すために撃つ。
   * ⚠ 足す(1 回の頼みの中で 1 つずつ届く ── スマートフォルダの条件は 1 タグ 1 往復)。
   */
  | { type: 'TAGS_REFUSED'; field: TagInputField; tags: readonly string[] }
  /** 押すたびに 1 回ぶんへ戻す(#640)── 前の回の名前を次の回の字に混ぜない。 */
  | { type: 'CLEAR_REFUSED_TAGS'; field: TagInputField }
  /**
   * 🔴 **タグの候補が要る**(#494 段②)。⚠ 欄に焦点が当たったときに撃つ ──
   * 既に持っていれば reducer が**何もしない**(押すたびに全走査しない)。
   */
  | { type: 'ASK_TAG_SUGGESTIONS' }
  /** 集まったタグ(#494 段②)。⚠ 空配列は「0 件だった」= 集め直さない。 */
  | { type: 'SET_TAG_SUGGESTIONS'; tags: readonly string[] }
  /**
   * 🔴 **どのノートの履歴かを、撃つ側が持つ**(#891)。
   *
   * ⚠ 直す前は `lid` が無く、reducer が `state.selectedLid` を直に読んでいた ──
   *   だから**行のメニューを開いたまま選択が動く**と(`Alt+←` はメニューの有無を
   *   見ない)、**A の履歴を見るはずが B の履歴が開いた**(#877 と同じ引き金)。
   * 🔑 **optional にしない** ── 省けると、口を後から足す人が渡し忘れても
   *   tsc が黙り、同じ穴が静かに戻る(CLAUDE.md §7)。
   */
  | { type: 'SHOW_HISTORY'; lid: string }
  /** 🔴 **その版の中身を見る**(#398 段②)。⚠ 復元ではない ── 1 バイトも書かない。 */
  | { type: 'PREVIEW_REVISION'; revId: string }
  | { type: 'HIDE_REVISION_PREVIEW' }
  | { type: 'REVISION_PREVIEW_LOADED'; lid: string; revId: string; body: string }
  /**
   * 🔴 **くらべる相手を選ぶ**(#1231 段①)。`value` = `current` / `rev:<版の id>` / `file`(`<select>` の値そのまま)。
   * ⚠ 読むだけ(1 バイトも書かない)。見ている版が無いときは何もしない。
   */
  | { type: 'SET_REVISION_COMPARE'; value: string }
  /**
   * 相手の中身が届いた。`against` = 何を読んだか(`rev:<id>` / `file`)、`text` = `null` なら読めなかった。
   * ⚠ **`lid` / `previewRevId` / `against` が今の選びと食い違うなら捨てる**(遅れて着いた分が
   *   別のノート・別の版・選び直した後の相手の画面を上書きしない)。
   */
  | {
      type: 'REVISION_COMPARE_LOADED';
      lid: string;
      previewRevId: string;
      against: string;
      text: string | null;
      /** PC のファイルが大きすぎて読まなかったとき(`text: null` と一緒に)。 */
      tooLarge?: true;
    }
  | { type: 'HIDE_HISTORY' }
  | {
      type: 'RESTORE_REVISION';
      revId: string;
      /** 🔴 画面の下の「元に戻す」から来た復元(#1087)。知らせの字を変え、さらに「元に戻す」を重ねて出さない。 */
      fromUndo?: true;
    }
  /**
   * 🔴 **パソコン側で変わったファイルの今の中身を、ノートの本文に取り込み直す**(台帳 #1852 N1 / 依頼 97-2 A)。
   * 今のノートの中身は履歴に 1 件積まれる(戻せる)。⚠ 本文だけを置き換える(題名・タグの列・つながりは触らない)。
   */
  | {
      type: 'REIMPORT_BODY';
      lid: string;
      body: string;
      /**
       * 🔴 **画面の下に出す知らせの字**(#1231 / #1233。差分マージ・テキスト整形の保存)。
       * ⚠ 省略すると「パソコン側のファイルの今の中身に取り込み直しました」と出る ── ファイル以外から来た置き換えが
       *   それを言うと嘘になるので、呼び側が自分の言葉で渡す。`{title}` は題名に置き換わる。
       */
      notice?: string;
    }
  | { type: 'SHOW_TRASH' }
  | { type: 'HIDE_TRASH' }
  | {
      type: 'RESTORE_TRASH';
      entryLid: string;
      revId: string;
      /** 🔴 移す前の並び(「元に戻す」だけが知っている。#1087)。無ければ末尾へ。 */
      entryOrder?: number;
    }
  /**
   * 🔴 **ゴミ箱へ移した直後の「元に戻す」**(#1087 流れ 29)。移した全部に `RESTORE_TRASH` を撃つ
   * (履歴の id は効果層がゴミ箱の一覧から引く)。⚠ ゴミ箱に居ない分は黙って落とす。
   */
  | { type: 'UNDO_TRASH'; lids: readonly string[]; orders?: Readonly<Record<string, number>> }
  /** 🔴 `lid` を渡すと、ゴミ箱のその 1 件だけを完全に消す(依頼 301 A)。省略 = ゴミ箱を空にする。 */
  | { type: 'PURGE_TRASH'; lid?: string }
  /**
   * 🔴 **2 ペインタブファイラの操作**(#241 段⑥。user 指示 2026-08-17)。
   *
   * ⚠ **既存の `SET_SCOPE` / `TOGGLE_SELECT` を借りない。** 借りると左の列と
   * 中央の 2 ペインが**同じ現在地を共有**し、左を動かすたびに 2 ペインの
   * 見ている場所が飛ぶ(2 ペインである意味が消える)。
   * 🔑 増えるのは *state* だけで、**並びの規則は `filerRows` 1 本のまま**である
   * (CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」── 口ではなく器が 2 つ)。
   */
  | { type: 'DUAL_FOCUS'; side: DualSide }
  | { type: 'DUAL_SET_SCOPE'; side: DualSide; lid: string | null }
  /**
   * 印の付け方。⚠ **左の列と同じ 3 種**にする(`set` = 1 件 / `toggle` = 足し外し /
   * `range` = 起点から表示順で)── 面ごとに違う規則を作らない。
   */
  | { type: 'DUAL_SELECT'; side: DualSide; lid: string; mode: 'set' | 'toggle' | 'range' }
  /**
   * 🔴 **カーソルだけを動かす**(2026-08-19 の作り直し)。⚠ 印には触らない ──
   * 触ると `↑↓` が「見て回る」と「選ぶ」を兼ねてしまい、分けた意味が消える。
   * ⚠ `lid` が実在しなければ**何もしない**(消えた行を指さない)。
   */
  /**
   * 🔴 **印をまとめて置く**(#1626。移した先で、動いてきた行を選んだままにする)。⚠ 1 件ずつ `DUAL_SELECT` を撃つと
   *   件数ぶん描き直しが走る ── 数百件を移すと画面が固まるので、**1 回で置く**。実在する lid だけを置き、焦点は動かさない。
   */
  | { type: 'DUAL_SELECT_MANY'; side: DualSide; lids: readonly string[] }
  | { type: 'DUAL_SET_CURSOR'; side: DualSide; lid: string }
  | { type: 'DUAL_TAB_ADD'; side: DualSide }
  | { type: 'DUAL_TAB_CLOSE'; side: DualSide; index: number }
  | { type: 'DUAL_TAB_ACTIVATE'; side: DualSide; index: number }
  /**
   * 片側の印を全部外す。⚠ **移した直後に要る** ── 移すと元のペインから行が
   * 消えるが、印は state に残るので、そのまま次の場所へ移ると
   * **画面に無いものをもう一度動かそうとする**(#240 の着地前レビュー 2 と同型)。
   */
  | { type: 'DUAL_CLEAR_SELECTION'; side: DualSide }
  /**
   * 🔴 **その行の名前を打ち替え始める / やめる**(#273 段④)。
   * ⚠ 確定は既存の `RENAME_ENTRY_TITLE` を撃つ ── 改名の規則を 2 つ作らない。
   */
  | { type: 'DUAL_RENAME_BEGIN'; side: DualSide; lid: string }
  | { type: 'DUAL_RENAME_END' }
  /**
   * 🔴 **左の列の行の名前を打ち替え始める / やめる**(#215)。2 ペインの `DUAL_RENAME_*` と
   *   対 ── 面が違うだけで、確定は同じ `RENAME_ENTRY_TITLE` である。
   */
  | { type: 'ROW_RENAME_BEGIN'; lid: string }
  | { type: 'ROW_RENAME_END' }
  /** 🔴 **このペインだけの絞り込み**(#273 残件)。 */
  | { type: 'TOGGLE_KIND_FILTER'; archetype: string }
  | { type: 'CLEAR_KIND_FILTER' }
  | { type: 'DUAL_SET_FILTER'; side: DualSide; filter: string }
  /** 🔴 **1 つ前 / 次の場所へ**(#273 残件。タブごとの履歴)。 */
  | { type: 'DUAL_BACK'; side: DualSide }
  | { type: 'DUAL_FORWARD'; side: DualSide }
  /** 🔴 **下見の出し入れ**(#273 残件)。 */
  | { type: 'DUAL_SET_PREVIEW'; on: boolean }
  /** 下見の本文が届いた。⚠ **lid つき**(追い越しを捨てるため)。 */
  | { type: 'DUAL_PREVIEW_LOADED'; lid: string; body: string }
  /** 🔴 **スマートフォルダの当たりが届いた**(#421 段①)。 */
  | {
      type: 'SMART_SCANNED';
      lid: string;
      lids: readonly string[];
      total: number;
      spec: SmartSpec;
      /** 本文に書いてあるのに読めなかった条件の数(依頼 85-9)。省略 = 0。 */
      unreadable?: number;
    }
  | { type: 'SMART_SCAN_FAILED'; lid: string }
  /**
   * 🔴 **スマートフォルダへ入れる / から外す**(#421 段①。user 裁定 2026-08-26)。
   * ⚠ **条件のタグを本文へ書く**のが実体である ── 入れ物に「入れた」のではなく、
   *   条件に合う形へ本文が変わるから、次に集めたときに当たる。
   */
  | { type: 'SMART_TAGS'; smartLid: string; lids: readonly string[]; mode: 'add' | 'remove' }
  /**
   * 🔴 **スマートフォルダの条件そのものを足す / 外す**(#421 段①)。
   * ⚠ 書くのは**その入れ物の本文の frontmatter**(`smart-tags:`)である。
   */
  | { type: 'SMART_COND'; lid: string; tag: string; mode: 'add' | 'remove' }
  /**
   * 🔴 **集め直す**(#421 段①)。⚠ 条件やタグを書き換えた**後**に撃つ ──
   * 書込と同じ列に並ぶので、古い本文で集めることはない。
   */
  /**
   * 🔴 **列で引く条件を決める / 外す**(#421 段②)。
   * ⚠ 口は**この 1 つ**(種類 / 更新 / 作成 / 日付でそれぞれ作らない ── §7)。
   */
  | { type: 'SMART_FIELD'; lid: string; field: SmartField; value: string }
  | { type: 'SMART_RESCAN'; lid: string };

export type SystemCommand =
  | { type: 'SYS_BOOTED'; cid: string; metas: EntryMeta[]; relations: Relation[] }
  /** 関係の保存に失敗したとき、画面を disk に合わせる(足した物を外す / 消した物を戻す) */
  | { type: 'ROLLBACK_RELATION'; change: 'added'; id: string }
  | { type: 'ROLLBACK_RELATION'; change: 'removed'; relation: Relation }
  /**
   * 🔴 **居場所の保存に失敗したとき、画面の移動を元に戻す**(台帳 #1852 N1 / 依頼 115-4 A。Gemini 回答 = 推薦どおり)。
   * ⚠ 直す前は保存の空きが足りないなどで書けないときも、画面は先に移ったまま赤い字だけが出て、開き直すと元の場所に戻っていた。
   * `previous` = 移す前のそのノートの居場所(構造のつながり)。いまの居場所を外して戻す。
   */
  | { type: 'ROLLBACK_ENTRY_PARENT'; lid: string; previous: readonly Relation[] }
  /**
   * 種類の保存に失敗したとき、画面の種類を元へ戻す(台帳 #1852 I2 / 依頼 157)。
   * ⚠ `to`(変える前)へ戻すのは、画面がまだ `from`(変えた後)のときだけ ── 間に別の変更が入っていたら触らない。
   */
  | { type: 'SET_ENTRY_ARCHETYPE_ROLLBACK'; lid: string; from: string; to: string }
  /**
   * 🔴 **未読のメッセージの数が変わった**(設計 doc §7、段②a)。
   *
   * ⚠ **`appMessagePost`(adapter 側)が唯一の発行元** ── post のたびに増え、
   *   起動直後は disk の本文から数え直した値で 1 度だけ上書きされる
   *   (`main.ts` の boot)。⚠ 判定を増やさない ── ここは値を写すだけで、
   *   「注意 / 問題だけ数える」規則は `countUnread`(features 層)の 1 か所に在る。
   */
  | { type: 'MESSAGES_UNREAD_SET'; count: number }
  /**
   * 🔴 **開いているメッセージのノートの本文を読み直す**(#1087)。⚠ `MESSAGES_READ` と違い**既読にしない**
   *   (未読の数も `error` も触らない)── 新しい知らせが書かれたのに、開いたままの本文が古いままだった。
   *   そのノートを開いていない / 編集中・error なら何もしない。発行元は `main.ts`(書き込みの合図を束ねて撃つ)。
   */
  | { type: 'MESSAGES_BODY_REFRESH'; lid: string }
  /**
   * 探す面の結果が返った(#680)。⚠ `query` は**どの語の答えか**(遅れて返った古い
   * 結果を捨てる ── 打鍵は結果より速い)。
   */
  | {
      type: 'SET_SEARCH_DETAIL';
      query: string;
      rows: readonly SearchDetailRow[];
      truncated: boolean;
    }
  /** 探せなかった(#680)。⚠ 「まだ」と区別する ── 区別しないと永久に「探しています…」。 */
  | { type: 'SEARCH_DETAIL_FAILED'; query: string; stale: boolean }
  /** 効果層が読んだ入れ物の本文(#633 段③)── `LOAD_STACK` の続き。 */
  | { type: 'STACK_BODY_LOADED'; lid: string; body: string }
  | { type: 'BODY_LOADED'; lid: string; body: string }
  /**
   * 留めた枠の本文が読めた(#505 段②)。⚠ `BODY_LOADED` と**別の口**である ──
   * あちらは `openBody` を作る(= 編集の下書きになる)。
   */
  | { type: 'SPLIT_BODY_LOADED'; lid: string; body: string }
  /**
   * 🔴 **板が、置いたノートの本文を欲しがっている**(#529 W3-①)。
   * ⚠ 描く側(renderer)は dispatch しない(層規約)ので、配線(`main.ts`)が撃つ。
   * 🔑 まだ持っていない物だけ `REQUEST_PLACE_BODY` になる(描き直すたびに読み直さない)。
   */
  | { type: 'PLACE_BODIES_WANTED'; lids: readonly string[] }
  /** 板のための本文が読めた(#529 W3-①)。⚠ **全文を受けて、ここで切る**(切る規則は 1 か所)。 */
  | { type: 'PLACE_BODY_LOADED'; lid: string; body: string | null }
  /** 前回の並びを憶えていたので戻す(#505 段②)。⚠ 起動時に 1 度だけ。 */
  | { type: 'SPLIT_RESTORED'; lids: readonly string[] }
  | { type: 'BODY_LOAD_FAILED'; lid: string; error: string }
  | { type: 'BODY_PERSISTED'; lid: string; body: string }
  /**
   * 🔴 **別のタブ / 窓がこのノートを書いた**(#178。2026-08-22、#300 段③ で別窓が
   * 既定になったので踏みやすくなった)。
   *
   * ⚠ `BODY_PERSISTED`(**自分**の書込の ack)とは**別の action にする** ──
   * 意味が違うからである(あちらは「自分が書いたものが disk に届いた」、
   * こちらは「**自分以外**が disk を進めた」)。同じ口に混ぜると、
   * `diskAhead`(= disk が正)の印が自分の ack でも立ってしまう。
   * 🔑 印さえ立てば、その先の規則は**既に在る**(`diskAhead` の意味論)。
   */
  | { type: 'REMOTE_BODY_CHANGED'; lid: string; body: string }
  /**
   * 🔑 **DB が刻んだ時刻が届いた**(P9 段①)。書込のたびに worker が返す。
   *
   * ⚠ 主スレッドで時刻を作らないための専用の入口 ── これが無いと
   * 作成・更新は**次の boot まで `null`** で、情報列が終日「—」になる(実際にそうだった)。
   * ⚠ 書込経路は 6 つある(commit / 追記 / トグル / 復元 / ゴミ箱戻し / タイル設定)。
   * 各経路の action へ相乗りさせず**1 つの action に寄せる** ── 相乗りだと
   * 経路を足した人が時刻を落とし、そこだけ「—」に戻る
   */
  | {
      type: 'ENTRY_STAMPED';
      lid: string;
      createdAt: string | null;
      updatedAt: string | null;
      /** 書いた本文の字数(本文を書かない口は付けない = meta を動かさない)。 */
      bodyChars?: number;
    }
  /**
   * 🔴 保存が「消えない扱い」かの ack(#347)。⚠ **`unknown` は届かない** ──
   * 分からないままのときは撃たない(state の初期値がそれである)。
   */
  | { type: 'PERSIST_STATE'; state: PersistState }
  /** 🔴 バックリンクが届いた(#348)。⚠ **どのノートの分か**を一緒に運ぶ。 */
  | {
      type: 'BACKLINKS_LOADED';
      lid: string;
      lids: string[];
      truncated: boolean;
      /** 🔴 調べられなかった(#1087)。⚠ 「0 件」と区別する ── 混ぜると「無し」と嘘をつく */
      failed?: true;
    }
  | {
      /**
       * 🔴 **本文の構造化書換の ack**(#276 / #277 で `TODO_TOGGLED` から改名)。
       * ⚠ 名前を変えたのは、**同じ経路をカレンダーの日付書換にも使う**からである
       * ── 別名で 2 本目を生やすと、書込の作法(直列 queue / 唯一の抽出経路)が
       * 2 つに割れる(CLAUDE.md §7)。
       */
      type: 'BODY_REWRITTEN';
      lid: string;
      body: string;
      /** 何をしたか。⚠ **やり直せる形**で持つ ── 未達 commit との合流に要る。 */
      rewrite: BodyRewrite;
      /**
       * 🔴 **足した行そのもの**(#684 段④、「元に戻す」の材料)。⚠ **書いた結果から**
       *   効果層が取り出す(`insertedLines`)── 前後に空行を補う作法をここで書き写すと
       *   規則が 2 か所になる(§7)。⚠ 画面の本文からは導けない:添付を取り込むと
       *   `openBody` が一度捨てられるので、reducer 側は `null` しか読めない。
       * ⚠ 差し込み(`insert-lines`)以外では**渡らない**(`undefined`)。
       */
      inserted?: readonly string[] | null;
      /** 足した位置(行、0 起点)。`inserted` と同じ口から出る(#1087)。 */
      insertedAt?: number | null;
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
  | {
      type: 'SYS_ERROR';
      error: string;
      /**
       * 🔴 **空き容量が足りずに本文の保存が断られたとき、編集の画面へ戻す**(台帳 #1852 束 S1、依頼 104-1 B)。
       * 直す前は「保存に失敗した」状態で止まり、空きを作る方法が無かった(保存し直しも断られる)。
       * 書きかけの字を編集の画面に残し、空きができたら「編集を保存する」を押し直せる。
       * ⚠ 戻せない場面(別のノートへ移った・別のタブの版が先に在る)は従来どおり `error` を使う。
       *   そのため戻した場合の字は別に持つ(`editingError`)── 戻していないのに「編集の画面に残してあります」と言わない。
       */
      keepEditing?: { editingError: string };
    }
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
      /**
       * 🔴 **履歴から戻す前の本文の版**(依頼 68-1)。復元は戻す前の本文を履歴に 1 件積むので、
       * その版を指す。あると、画面の下の知らせの隣に「元に戻す」が出る(押すと同じ `RESTORE_REVISION`)。
       */
      undoRevId?: string;
      /**
       * 🔴 **題名だけが変わった復元の「元に戻す」の行き先**(台帳 #1852 G1 / 依頼 229 B)。本文が同じで題名だけ違う版を戻すと、
       * 履歴に版が積まれず `undoRevId` が無い ── 戻す前の題名を持たせ、押すと題名だけを戻す(`restore-revision` の口が受ける)。
       */
      undoTitle?: string;
      /** 🔴 「元に戻す」から来た復元(#1087)。知らせを「戻す前の本文に戻しました」にし、「元に戻す」は重ねて出さない。 */
      fromUndo?: true;
      /**
       * 🔴 **知らせの字を決める**(台帳 #1852 N1 / 依頼 97-2 A)。履歴の復元の知らせ(「前の版に戻しました」)でなく、
       * パソコン側のファイルから取り込み直した回が自分の字を言うために使う。省略 = 従来の字。
       */
      notice?: string;
      /**
       * 🔴 **ゴミ箱から戻すと頼んだ時点の選択**(#1087)。着いたときの選択がこれと違えば、その間に別のノートを
       * 選び直している ── 選択を奪い返さない(`restoreStealsSelection`)。省略 = 判定しない(従来どおり戻したノートを選ぶ)。
       */
      selectedAtIssue?: string | null;
    }
  | { type: 'TRASH_PURGED'; purged: number; lid?: string }
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
      /**
       * 🔴 **足した行そのもの**(#395 段①、取り消しのため)。
       *
       * ⚠ **行番号ではない** ── 取り消すまでの間に別の窓が上へ足していれば
       *   番号はずれる。⚠ 純粋な挿入でなければ `null`(取り消しを出さない)。
       */
      inserted: readonly string[] | null;
      /** 足した位置(行、0 起点)。取り消しが先に見る所(#1087)。 */
      insertedAt?: number | null;
      /** 取り込みの回の印(#668 C)。`REQUEST_APPEND.batch` がそのまま返る。 */
      batch?: string;
    }
  | {
      /** 追記が失敗した。⚠ **ロックは必ず解く**(失敗で握ったままにしない)。 */
      type: 'APPEND_FAILED';
      lid: string;
      gen: number;
      error: string;
    }
  | {
      /**
       * 🔴 **章の保存が disk に着いた**(#1044 段2 3巡目の修理、S1)。⚠ **`gen` を
       *   必ず見る**(強制解放を挟んだあとの遅れた ack を採ると、user が見ている
       *   本文を巻き戻す ── `ENTRY_APPENDED` と同じ理由)。
       */
      type: 'SECTION_SAVED';
      lid: string;
      gen: number;
      /** 身元検査(`slices/edit.ts` の `SECTION_SAVED` 参照)。 */
      heading: string;
      /** 章を差し替えた**後**の全文。 */
      body: string;
      status: string | null;
      date: string | null;
      archived: boolean;
    }
  | {
      /** 章の保存が断られた。⚠ **ロックは必ず解く**(`saving: false`)。 */
      type: 'SECTION_SAVE_FAILED';
      lid: string;
      gen: number;
      heading: string;
      error: string;
    }
  | {
      /**
       * 🔴 **コード枠の保存が disk に着いた**(#1044 段3)。⚠ **`gen` を必ず見る**
       *   (`SECTION_SAVED` と同じ理由)。
       */
      type: 'CODE_SAVED';
      lid: string;
      gen: number;
      /** 身元検査(`slices/edit.ts` の `CODE_SAVED` 参照)。 */
      line: number;
      openLine: string;
      quote: number;
      /** 枠を差し替えた**後**の全文。 */
      body: string;
      status: string | null;
      date: string | null;
      archived: boolean;
    }
  | {
      /** コード枠の保存が断られた。⚠ **ロックは必ず解く**(`saving: false`)。 */
      type: 'CODE_SAVE_FAILED';
      lid: string;
      gen: number;
      line: number;
      openLine: string;
      quote: number;
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
   * 🔴 **メッセージ(system 領域のノート)の本文を読む**(設計 doc §7、段②a)。
   *
   * ⚠ `REQUEST_BODY` と分けてある理由 ── あちらは「行が無い」を**異常系**
   *   (`BODY_LOAD_FAILED`)として扱う。だが `sys-jobs`(処理の記録)は
   *   **段②b で初めて書かれる**ので、段②a の時点では 1 度も `postMessage`
   *   されていなければ行そのものが存在しない ── それは壊れではなく
   *   「まだ何も無い」なので、`null` を**空の本文として受理する**。
   */
  | { type: 'REQUEST_MESSAGES_BODY'; lid: string }
  /**
   * 🔴 **2 ペインの下見の本文を読む**(#273 残件)。
   *
   * ⚠ `REQUEST_BODY` と分けてある理由は「行き先が違う」からである ──
   *   あちらは**開いているノート**(`openBody`)を作る口で、こちらは
   *   **カーソルの行を映すだけ**の口である。同じ event に相乗りさせると、
   *   下見のために送った本文が**編集中の下書きを踏む**。
   * 🔑 ただし**読む口は 1 本**(`store.getBody`)で、**同じ直列の列**に並べる ──
   *   別経路で読むと、並んでいる書込を追い越す(2026-08-17 に踏んだ形)。
   */
  | { type: 'REQUEST_DUAL_PREVIEW'; lid: string }
  /** 入れ物の本文を読んで `STACK_BODY_LOADED` で返す(#633 段③)。読む口は同じ直列の列。 */
  | { type: 'REQUEST_STACK_BODY'; lid: string }
  /**
   * 🔴 **留めた枠の本文を読む**(#505 段②)。
   *
   * ⚠ `REQUEST_BODY` / `REQUEST_DUAL_PREVIEW` と**行き先が違う**ので分けてある
   * (`openBody` / 下見 / 留めた枠)。🔑 ただし**読む口は 1 本**
   * (`store.getBody`)で、**同じ直列の列**に並べる ── 別経路で読むと、
   * 並んでいる書込を追い越す(2026-08-17 に踏んだ形)。
   */
  | { type: 'REQUEST_SPLIT_BODY'; lid: string }
  /**
   * 🔴 **板に置いたノートの本文を読む**(#529 W3-①)。⚠ 読む口は同じ `store.getBody`、
   * **同じ直列の列**に並べる(書込を追い越さない)。
   */
  | { type: 'REQUEST_PLACE_BODY'; lid: string }
  /**
   * 🔴 **スマートフォルダの中身を集める**(#421 段①)。
   *
   * ⚠ **条件は載せない** ── reducer は**本文を持っていない**
   *   (`entryMetas` は「body の不在は意図的」と宣言している)。だから条件を
   *   読むのは effect 層である:`getBody` → `readSmartSpec` → `smartScan`。
   * 🔑 読む口は `readSmartSpec` **1 本**なので、§7 は破れない。
   * ⚠ **開くたびに頼む** ── 鮮度は「開いた時点」である。憶えて使い回すと、
   *   別の面でタグを付けた直後に**古い並び**が出る。
   */
  | { type: 'REQUEST_SMART_SCAN'; lid: string }
  /**
   * 🔴 **スマートフォルダの条件のタグを、選んだノートへ足す / 外す**(#421 段①)。
   * ⚠ 条件は effect が**その場で本文から読む** ── 憶えている値で書くと、
   *   本文を直に書き換えた直後に**違うタグ**を付ける。
   */
  /**
   * 🔴 **スマートフォルダの条件を本文へ書く**(#421 段①)。
   * ⚠ 行の材料(題名・種別・並び)を**ここで確定して運ぶ** ── effect が実行時に
   *   引き直すと、その間の改名を踏む(`PERSIST_ENTRY` と同じ規律)。
   */
  | {
      type: 'REQUEST_SMART_COND';
      target: { lid: string; title: string; archetype: string; entryOrder: number };
      tag: string;
      mode: 'add' | 'remove';
    }
  /** 🔴 **列で引く条件を本文へ書く**(#421 段②)。 */
  | {
      type: 'REQUEST_SMART_FIELD';
      target: { lid: string; title: string; archetype: string; entryOrder: number };
      field: SmartField;
      value: string;
    }
  | {
      type: 'REQUEST_SMART_TAGS';
      smartLid: string;
      lids: readonly string[];
      mode: 'add' | 'remove';
    }
  /** 🔴 このノートを参照しているノートを引く(#348)。 */
  | { type: 'REQUEST_BACKLINKS'; lid: string }
  /**
   * 本文の全文検索を頼む(#181)。⚠ 本文は常駐していないので **SQL 側の仕事**。
   * 空文字は「絞り込み無し」── 受け手は問い合わせずに黙って終える。
   * `again` は書込の後の撃ち直し(#1087)── 飛んでいる同じ語の問い合わせは書込の前の本文で走っているかもしれないので、
   * 同じ語でも送り直す(打ち直して同じ語へ戻した回は従来どおり送り直さない)。
   */
  | { type: 'REQUEST_SEARCH'; query: string; again?: true }
  /**
   * 探す面の検索を頼む(#680)。⚠ 受け手(effect)が **300ms 止まってから**叩く ──
   * 打鍵ごとに worker を叩かない。空文字は来ない(reducer が出さない)。
   */
  | { type: 'REQUEST_SEARCH_DETAIL'; query: string }
  /**
   * 🔴 **打った SQL を走らせてほしい**(#681 段②)。
   * ⚠ **`sql` は全角を直した後の字**(`checkReadOnlySql` が返した物)── 元の字を
   *   渡すと、日本語入力のまま書いた人だけ構文エラーになる。
   */
  | {
      type: 'REQUEST_SQL_RUN';
      sql: string;
      /** 🔴 走らせた回の札(#681 F3-A)── 答えと一緒に返してもらい、古い回は捨てる。 */
      token: number;
      /**
       * 🔴 **打つ先**(#681 段③ の 2 つ目)。真 = 取り込んだ `.sqlite`。
       * ⚠ **event が運ぶ** ── effect 側で state を読み直すと、選び直した直後の
       *   1 回が**前の相手へ飛ぶ**(読む時点が違う)。
       */
      guest?: boolean;
      /**
       * 🔴 **どのエンジンで引くか**(#682 段②)。⚠ **event が運ぶ** ── 上の `guest` と
       *   同じ理由で、effect 側が state を読み直すと 1 回ぶん食い違う。
       * ⚠ **省略しない**(optional にしない)── 省けるようにすると、書き忘れた口が
       *   黙って sqlite へ落ちる(選んだ物と違う所で引く、いちばん気づけない形)。
       */
      engine: SqlEngine;
      /**
       * DuckDB で引くときの相手(csv / tsv / parquet / json の 1 件。#682 段④c)。
       * ⚠ `engine === 'duckdb'` のときだけ在る ── DuckDB は**選んだ相手の bytes 1 つ**
       * しか受け取らない。
       */
      duck?: { lid: string; name: string };
      /**
       * 🔴 **足した相手**(#918 段⑦)。⚠ **1 件以上のときだけ在る**(1 件のときは今までどおり
       *   `duck` だけ)。`duck` が 1 件目で、ここが 2 件目以降(並べる順)。
       */
      duckExtra?: readonly { lid: string; name: string }[];
    }
  /**
   * 🔴 **調べている相手の構造を採ってきてほしい**(#918 段①)。
   * ⚠ **打つ字はこちらが持たない** ── 3 本の `select` を組むのは `schema-digest.ts` で、
   *   effect はそれを順に打って 1 枚にまとめる。
   * 🔑 **門にも worker にも 1 行も足していない**(ぜんぶ `select` で採れる)。
   */
  | {
      type: 'REQUEST_SQL_SCHEMA';
      where: string | null;
      guest?: boolean;
      /**
       * 🔴 **DuckDB の器から採る**(#918)。⚠ `.parquet` / `.json` を選んでいるとき、または
       *   **2 件以上並べている**ときだけ在る(そのとき `guest` は無い)。`duck` が 1 件目、
       *   `duckExtra` が 2 件目以降(`REQUEST_SQL_RUN` と同じ形)。
       */
      duck?: { lid: string; name: string };
      duckExtra?: readonly { lid: string; name: string }[];
      /** ⚠ **id は押した側が作る** ── 純粋な reducer も effect も乱数を持たない。 */
      lid: string;
      relationId: string;
      /** 🔴 書き出すノートの置き場(押した時に開いていたフォルダ。無ければ最上位。依頼 91-2)。 */
      parentLid?: string | null;
    }
  /**
   * 🔴 **つながり図のために構造を採ってきてほしい**(#918 段⑤)。
   * 🔑 打つ字は `REQUEST_SQL_SCHEMA` と**同じ 3 本**(`schema-digest.ts`)── effect が
   *   1 か所にまとめて持つので、採り方が 2 つに分かれない(CLAUDE.md §7)。
   * ⚠ **札を付ける** ── 採っている間に相手を変えられるので、古い答えは捨てる。
   */
  | {
      type: 'REQUEST_SQL_ER';
      token: number;
      guest?: boolean;
      /** 🔴 DuckDB の器から採る(#918)。⚠ `REQUEST_SQL_SCHEMA` と同じ意味・同じ形。 */
      duck?: { lid: string; name: string };
      duckExtra?: readonly { lid: string; name: string }[];
    }
  /**
   * 🔴 **答えを Parquet にして書き出してほしい**(#918 段⑥)。
   * ⚠ **打つ字は `sql`(= 走らせた字)**。相手は `REQUEST_SQL_RUN` と**同じ形**(`duck` が 1 件目 / `duckExtra` が 2 件目以降)。
   * ⚠ DuckDB の器でしか書けないので `engine` は持たない(出す側が DuckDB のときだけ出す)。
   */
  | {
      type: 'REQUEST_SQL_EXPORT_PARQUET';
      sql: string;
      fileName: string;
      duck: { lid: string; name: string };
      duckExtra?: readonly { lid: string; name: string }[];
    }
  /** 取り込んだ `.sqlite` を開く / 手放す(#681 段③ の 2 つ目)。 */
  | { type: 'REQUEST_SQL_GUEST_OPEN'; lid: string; name: string }
  | {
      type: 'REQUEST_SQL_GUEST_CLOSE';
      /**
       * 🔴 **いま手放す相手の lid**(#682 段④c)。
       *
       * ⚠ **「いま選んだ相手」ではなく「さっきまで選んでいた相手」**である。
       * 🔑 これが無いと、手持ちのファイルを選び直したときに
       *   **いま控えたばかりの file を手放してしまう** ── `SET_SQL_SOURCE` は
       *   `CLOSE` → `OPEN` の順に出すので、lid を見ない `release` は
       *   **開く前の控えを消す**(直す前に実際にそうなっていた)。
       */
      prev: string;
    }
  /**
   * 🔴 **足した相手の控えを手放す**(#918 段⑦)。
   * ⚠ `REQUEST_SQL_GUEST_CLOSE` とは別 ── あちらは sqlite 側の接続も閉じる。足した相手は
   *   sqlite へ開いていないので、**閉じる物が無い**(手持ちの file の控えを放すだけ)。
   * 🔑 出す所は 3 つ:外した / 足せなかった / 1 件目を選び直して全部外れた。
   */
  | { type: 'REQUEST_SQL_EXTRA_RELEASE'; lids: readonly string[] }
  /**
   * 集計を頼む(#184)。⚠ 検索と同じ理由で **SQL 側の仕事** ── 本文は常駐していない。
   * ⚠ **目録と表を 1 回の走査で頼む**(`key` が `null` なら目録だけ)── 別々に
   * 頼むと DB の全件走査が 2 回走る(レビュー B-3)。
   */
  | { type: 'REQUEST_QUERY_SCAN'; key: string | null }
  /**
   * 🔴 **タグの候補を集めてもらう**(#494 段②)。⚠ 実体は `queryScan('tags')` ──
   * effect が同じ口を呼ぶ(走査を 2 本作らない)。
   */
  | { type: 'REQUEST_TAG_SUGGESTIONS' }
  /**
   * カンバンの札を集める(#277 段②-b)。⚠ 集計と同じ理由で **worker の仕事** ──
   * 本文は常駐していないし、主スレッドへ運んでもいけない(不可侵指示 2026-07-27)。
   */
  | { type: 'REQUEST_TASK_SCAN' }
  | { type: 'REQUEST_CONTACT_SCAN' }
  /** 🔴 計った時間を集める(#683 ①)。 */
  | { type: 'REQUEST_WORK_LOG_SCAN' }
  /**
   * 🔴 **録ったものを集める**(#683 段①)。⚠ **どれを読むかを載せる**
   *   (`REQUEST_LAUNCHER_TILES` と同じ ── effect 層は実行時に state を見ない)。
   * ⚠ 載せるのは**添付だけ** ── 全 entry の本文を読むと、タブを開くたびに
   *   全文を舐めることになる(5,000 件持つ user には致命的)。
   */
  | { type: 'REQUEST_CAPTURE_ITEMS'; entries: Array<{ lid: string; title: string }> }
  | { type: 'REQUEST_SNIPPET_SCAN' }
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
   * 🔴 **並べ替えを disk へ書く**(#857 段①)── N 件を**1 つの仕事**として渡す。
   *
   * ⚠ `REQUEST_TILE_UPDATE` を N 個出す形にしない:あちらは 1 件ごとに
   *   **ack と読み直し**を撃つので、N 件ぶん一覧が作り直され、
   *   **掴んでいる手の下で器が入れ替わる**(`filer.ts` が実測で踏んだ罠 ──
   *   30 回中 2 回は `dragstart` しか出ず、3 回は狙いと違う行へ落ちた)。
   * 🔑 ここは**最後に 1 回だけ** ack と読み直しを撃つ。
   */
  | {
      type: 'REQUEST_TILE_ORDER';
      /** 動かしたタイル。⚠ ack の宛先(ロックを数える鍵)もこれ。 */
      lid: string;
      gen: number;
      /** ⚠ **書く順**に並んでいる(`planTileMove` が返した順)。 */
      rows: Array<{
        lid: string;
        updates: Record<string, string | number | undefined>;
        title: string;
        archetype: string;
        entryOrder: number;
      }>;
      /** 書き換えた後にタイルを読み直すための材料。 */
      entries: Array<{ lid: string; title: string }>;
    }
  /**
   * 🔴 **添付の実体を差し替える**(#205)。計画は `planSaveBack`(純関数)が立てる。
   *
   * 🔑 **運ぶのは「何に差し替えたか」だけ**(2026-08-25)── 参照(`asset:`)は
   * どのノートにも書けるので書き換え先は 1 件に閉じないが、**探すのも書くのも
   * worker が同じ tx の中でやる**ようになった(`op: 'replaceAssetRefs'`)。
   * ⚠ 直す前はここが全ノートの素性を運び、effect が `listBodies` で本文を読み、
   * 1 件ずつ `persistEntry` していた ── **読んでから書くまでの間に別のタブ /
   * 窓が書くと、それを消していた**(`checkpoint` を渡さないので履歴にも残らない。
   * #178 で改名 / 並べ替えを直したのとまったく同じ形)。
   * ⚠ **旧 key もここでは運ばない** ── 呼び側が読むと「読んだ時点の値」になり、
   * 隙間がまた開く(worker が tx の中で読む)。
   */
  | {
      type: 'REQUEST_ASSET_REPLACE';
      targetLid: string;
      newKey: string;
      newHash: string | null;
      newBytes: number;
      /** 差し替え後の綴りと中身の種類(#214)。⚠ frontmatter に書き戻す。 */
      newName: string;
      newMime: string;
      savedAt: string;
    }
  | {
      type: 'REQUEST_LAUNCHER_TILES';
      entries: Array<{ lid: string; title: string }>;
    }
  | {
      /**
       * 🔴 **グループの並び順を書く**(#857 段③)。
       * ⚠ **N 件を 1 つの仕事**として渡す(`REQUEST_TILE_ORDER` と同じ作法)──
       *   N 個の event に割ると、途中の失敗がどこまで効いたか読めなくなる。
       * 🔴 **ここに載るのは「既に在るノート」だけ**(2026-09-13)── まだ無い群は
       *   reducer が `CREATE_ENTRY` を通して作るので、番号は雛形に入って届く。
       *   ⚠ effect に行を作らせない ── 作った物が `entryMetas` に入らず、
       *   **サイドバーにも目録にも出ない**(刻みも `ENTRY_STAMPED` が捨てる)。
       */
      type: 'REQUEST_APP_GROUP_ORDER';
      rows: Array<{
        name: string;
        /** ⚠ `null` は**番号を外す**(名前順へ戻す)。 */
        order: number | null;
        lid: string;
        title: string;
        archetype: string;
        entryOrder: number;
      }>;
    }
  | {
      /**
       * 🔴 **グループ用ノートの目印を書く**(#857 段②)。
       * ⚠ `REQUEST_TILE_UPDATE` と**同じことをする別の口**に見えるが、あちらは
       *   書いたあとに**タイルを読み直す** ── こちらは**目印を読み直す**ので、
       *   同じ event に相乗りさせると「タイルを直したのに見出しが古い」が出る。
       */
      type: 'REQUEST_APP_GROUP_ICON_WRITE';
      lid: string;
      title: string;
      archetype: string;
      entryOrder: number;
      /** `null` = 外す(key ごと消える)。 */
      icon: string | null;
    }
  | {
      /**
       * 🔴 **グループ用ノートを読む**(#857 段②③ ── 目印と並び順)。
       * ⚠ `REQUEST_LAUNCHER_TILES` と**引き金は同じでも別の event** ── 混ぜると
       *   `tileFrom` が両方を同じ土俵で処理する(`app-group-spec.ts` の火種)。
       */
      type: 'REQUEST_APP_GROUP_NOTES';
      entries: Array<{ lid: string; title: string }>;
      /**
       * 🔴 **この読み直しを発行したときの世代**(`AppState.appGroupGen`)。
       * ⚠ 必須にしてある ── 読み直しを積む口を後から足す人が
       *   世代を書き忘れたら、tsc がその場で落とす。
       */
      gen: number;
    }
  | {
      /** 居場所の永続化。⚠ 判定(循環・folder か)は reduce で済んでいる。 */
      type: 'REQUEST_SET_PARENT';
      lid: string;
      parentLid: string | null;
      relationId: string;
      /** 🔴 2 本目以降の親(依頼 227 A)。reduce が輪・実在を検めて通った分だけ載せる。 */
      alsoIn?: readonly { parentLid: string; relationId: string }[];
      /**
       * 🔴 **移す前の居場所**(台帳 #1852 N1 / 依頼 115-4 A)。書けなかったとき、effect が画面を元に戻すために使う。
       * ⚠ 前に居場所が無かった(ルートに居た)ときは載せない = 戻すときは居場所を外すだけ。
       */
      previous?: readonly Relation[];
    }
  | {
      type: 'PERSIST_ENTRY';
      entry: EntryUpsert;
      /** true = 変更前の disk body を履歴に 1 件積む(P5c: 鎖の維持は worker)。 */
      checkpoint?: boolean;
      /**
       * 🔴 **本文だけを書く(題名・種類・並びは disk の値を保つ)**(#1087、複数タブの見直し)。
       * ⚠ 編集の保存は画面が持つ題名・並びで行を組むが、編集中の画面は一覧の読み直しを先送りする ──
       *   その間に別のタブで改名・並べ替えると、保存がそれを**黙って巻き戻していた**。
       */
      keepMeta?: boolean;
      /**
       * 🔴 **居場所も同じ tx で**(#258)。⚠ 作成を 2 手に割ると、行を書いた ack と
       * 辺の書込の間にタブを閉じたとき**親だけ飛ぶ**(ノートはルートに現れる)。
       */
      parent?: { parentLid: string | null; relationId: string };
    }
  | {
      /**
       * 🔴 **本文を構造化して書き換える要求**(#276 / #277 で
       * `REQUEST_TODO_TOGGLE` を一般化)。読む→原文 splice→書く を 1 op として直列 queue に載せる。
       * ⚠ meta snapshot は発火時(reduce)に捕獲(C-1 規律)。
       * ⚠ **本文は載せない** ── effect が disk から読み直す(画面の古い本文を
       *   基底にすると、別経路の書込を巻き戻す)。
       */
      type: 'REQUEST_BODY_REWRITE';
      lid: string;
      title: string;
      archetype: string;
      entryOrder: number;
      /** 何をするか。規則は `features/markdown/body-rewrite.ts` の 1 か所。 */
      rewrite: BodyRewrite;
    }
  | {
      /**
       * 🔴 **切り出した章を元に戻す要求**(#1439)── 元のノートのリンク 1 行を、切り出し先の本文で置き換える。
       * ⚠ どちらの本文も効果層が disk から読み直す(`REQUEST_BLOCK_HANDOFF` と同じ作法)。
       *   **先に元へ書き**、書けたら切り出し先を削除する ── 書けなかった回は何も消えない。
       */
      type: 'REQUEST_CHAPTER_RESTORE';
      into: { lid: string; title: string; archetype: string; entryOrder: number; line: number; openLine: string };
      child: { lid: string; title: string };
    }
  | {
      /**
       * 🔴 **本文の塊を、別のノートへ持っていく要求**(#684 段③)。
       *
       * ## なぜ 1 つの event なのか(2 本に割らない)
       *
       * ⚠ 書換は **2 つのノート**にまたがる ── 割って `REQUEST_BODY_REWRITE` を
       *   2 本撃つと、**片方だけ通った回**が普通に起きる(別の窓の書込・容量)。
       *   入れる側だけ落ちれば**本文が消えたまま**になり、どこからも戻せない。
       * 🔑 だから 1 op にして、**入れてから切る**(効果層が順番を守る)──
       *   入らなければ元は 1 バイトも触らない。切れなければ**二重になる**
       *   (見えるし、掴んで捨てられる ── 消えるより良い側)。
       * ⚠ **本文は載せない**(`REQUEST_BODY_REWRITE` と同じ)── どちらの本文も
       *   効果層が disk から読み直す。載せる価値が在るのは**掴んだ時点の行**
       *   (`lines`)だけで、これは byte 一致の錠として使う。
       */
      type: 'REQUEST_BLOCK_HANDOFF';
      /** 元のノート(切る側)。`start`〜`end` は**生の body** の行番号(両端含む)。 */
      from: {
        lid: string;
        title: string;
        archetype: string;
        entryOrder: number;
        start: number;
        end: number;
        /** 掴んだ時点の `start..end` の行そのもの ── disk 側と一致しなければ切らない。 */
        lines: readonly string[];
      };
      /** 行き先のノート(入れる側)。`toBefore: null` = **本文の末尾**(一覧の行へ落とした回)。 */
      to: {
        lid: string;
        title: string;
        archetype: string;
        entryOrder: number;
        toBefore: number | null;
        /** 落とした所の目印(`toBefore` が在るときだけ)。合わなければ入れない。 */
        anchor?: InsertAnchor;
      };
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
      /**
       * 🔴 **入り先の印**(#395 段①)。`null` = 末尾(これまでと同じ)。
       *
       * ⚠ **行番号ではなく印**である ── effect は disk から読み直すので、
       *   行番号を渡すと**別の窓の書込のあとで違う場所へ入る**。
       * ⚠ 解けなければ effect が**断る**(末尾へ落とさない)。
       */
      target: string | null;
      /** 取り込みの回の印(#668 C)。effect が `ENTRY_APPENDED` へそのまま返す。 */
      batch?: string;
    }
  | {
      /**
       * 🔴 **追記の結末**(#275 段① 着地後レビュー)。⚠ `REQUEST_APPEND` の**対**である。
       *
       * 追記は錠を掛けた時点では**まだ disk に着いていない**(結末は `ENTRY_APPENDED` /
       * `APPEND_FAILED` の ack)。⚠ 「書けた」と user に言いたい呼び側(PDF の窓の「ノートへ引く」)は、
       * 錠が掛かったことではなく**この結末**を見る。
       * ⚠ **世代(`gen`)の合わない ack からは出さない**(強制解放の後着 ── 画面を動かさない ack は
       *   結末としても数えない。呼び側の時間切れが受ける)。
       */
      type: 'APPEND_SETTLED';
      lid: string;
      gen: number;
      ok: boolean;
      /** 失敗の理由(`ok` のとき `null`)。 */
      error: string | null;
    }
  | {
      /**
       * 🔴 **章の欄の保存要求**(#1044 段2 3巡目の修理、S1)。⚠ **本文は載せない**
       *   ── effect が disk から読み直し、`heading` + `original` で章を探し直して
       *   `text` へ差し替える(`REQUEST_APPEND` と同じ「画面の古い本文を基底に
       *   しない」作法)。meta snapshot は発火時(reduce)に捕獲(C-1 規律)。
       */
      type: 'REQUEST_SECTION_SAVE';
      lid: string;
      gen: number;
      title: string;
      archetype: string;
      entryOrder: number;
      /** 章を名前で探し直す見出しの字。 */
      heading: string;
      /** 開いたときに控えた、この章の原文(一致判定に使う)。 */
      original: string;
      /** 箱に打たれていた新しい中身(見出し行を含む)。 */
      text: string;
    }
  | {
      /**
       * 🔴 **コード枠の欄の保存要求**(#1044 段3)。⚠ **本文は載せない** ──
       *   effect が disk から読み直し、身元({@link CodeFenceIdentity})で枠を
       *   探し直して `text` へ差し替える(`REQUEST_SECTION_SAVE` と同じ作法)。
       */
      type: 'REQUEST_CODE_SAVE';
      lid: string;
      gen: number;
      title: string;
      archetype: string;
      entryOrder: number;
      /** 枠を探し直す身元。 */
      line: number;
      openLine: string;
      original: string;
      quote: number;
      /** 箱に打たれていた新しい中身(引用の前置き・開き・閉じの行は含まない)。 */
      text: string;
    }
  | {
      type: 'REQUEST_DELETE';
      lid: string;
      /** 🔴 何も書かれていない作りたてのノートだけ立てる ── ゴミ箱を経由せず消す(#1087) */
      untouched?: boolean;
    }
  | {
      /**
       * 種類の書換の永続化要求(台帳 #1852 I2 / 依頼 157)。⚠ 本文は載せない ── effect が disk から読んで、
       * 抽出列(日付など)を新しい種類の規則で引き直して行を書く(`REQUEST_RENAME` と同じく画面の古い本文を基底にしない)。
       */
      type: 'REQUEST_SET_ARCHETYPE';
      lid: string;
      title: string;
      archetype: string;
      /** 戻すとき・失敗の知らせに使う、変える前の種類 */
      oldArchetype: string;
      entryOrder: number;
    }
  | {
      /** title 書換の永続化要求(body は effect が disk から読む)。snapshot は
       *  発火時捕獲(C-1 規律)。title は新値。 */
      type: 'REQUEST_RENAME';
      lid: string;
      title: string;
      /** 🔴 改名前の題名(ほかのノートのリンクの字が旧い題名と同じものを書き換えるため。#1163 依頼 177) */
      oldTitle: string;
      /** 🔴 発火時に編集中のノート(リンクの字を書き換えない。本文は draft が正) */
      skipLids: string[];
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
  | {
      /** 🔴 タグの名前の変更に、スマートフォルダの条件を合わせる(`RENAME_SMART_TAG`)。 */
      type: 'REQUEST_SMART_TAG_RENAME';
      from: string;
      /** `null` = 外しただけ(件数を知らせる。条件は書き換えない)。 */
      to: string | null;
      targets: readonly { lid: string; title: string; archetype: string; entryOrder: number }[];
    }
  | { type: 'REQUEST_RELATION_UPSERT'; id: string; fromLid: string; toLid: string; kind: string }
  | { type: 'REQUEST_RELATION_DELETE'; id: string; relation?: Relation }
  | {
      /**
       * 🔴 **選んだ全部にタグを 1 つ足す / 外す**(#402 ①)。
       *
       * ⚠ **meta は発火時に捕まえる**(C-1 規律)── 走っている間に一覧が
       *   変わっても、書く相手は押した時の 12 件のままである。
       * ⚠ 1 件ずつ `REQUEST_BODY_REWRITE` を撃たない ── 撃つと
       *   「既に付いている」件が**1 件ずつ失敗として出る**(12 件のうち 3 件が
       *   既に付いていただけで、赤い帯が 3 回出る)。ここは**まとめて 1 通**言う。
       */
      type: 'REQUEST_BULK_TAG';
      /** ⚠ **並び**(#637)── 1 回の頼みを 2 通の知らせに割らない。 */
      tags: readonly string[];
      mode: 'add' | 'remove';
      /** ⚠ 入らなかった名前を戻す欄(#640)。無ければ戻さない。 */
      field?: TagInputField;
      /** 🔴 前の知らせに続けて言う(`BULK_TAG.afterPrevious`)。 */
      afterPrevious?: boolean;
      /** 🔴 名前の変更の 1 回目(`BULK_TAG.renameFirst`)。 */
      renameFirst?: boolean;
      targets: readonly {
        lid: string;
        title: string;
        archetype: string;
        entryOrder: number;
      }[];
    }
  | { type: 'REQUEST_REVISION_LIST'; lid: string }
  /** その版の本文を読む(#398 段②)。⚠ **読むだけ**(書込は 1 バイトも無い)。 */
  | {
      type: 'REQUEST_REVISION_BODY';
      lid: string;
      revId: string;
      /** 🔴 くらべる相手として読む(#1231 段①)。値 = **見ている版の id**。省くと見る版そのものを読む。 */
      forCompareOf?: string;
    }
  | {
      /** 履歴からの復元(前進変異): effect が「現状を addRevision → revision
       *  内容で persist」の順に行う。meta snapshot は発火時捕獲。 */
      type: 'REQUEST_RESTORE';
      lid: string;
      revId: string;
      title: string;
      archetype: string;
      entryOrder: number;
      /** 「元に戻す」から来た復元(`RESTORE_REVISION.fromUndo`)。 */
      fromUndo?: true;
    }
  | {
      /**
       * パソコン側のファイルの今の中身で、本文を置き換える(前進変異 ── 現状を履歴へ積んでから書く)。
       * ⚠ 読んでから書くまでに別の窓が書いていたら、1 バイトも書かず断る(`expectHash`)。meta snapshot は発火時捕獲。
       */
      type: 'REQUEST_REIMPORT';
      lid: string;
      title: string;
      archetype: string;
      entryOrder: number;
      body: string;
      /** `REIMPORT_BODY.notice` をそのまま運ぶ(省略 = ファイルの取り込み直しの字)。 */
      notice?: string;
    }
  | { type: 'REQUEST_TRASH_LIST' }
  | { type: 'REQUEST_TRASH_UNDO'; lids: readonly string[]; orders?: Readonly<Record<string, number>> }
  | {
      /** ゴミ箱からの復元(entry 再作成)。entryOrder は reduce 時に採番。 */
      type: 'REQUEST_TRASH_RESTORE';
      entryLid: string;
      revId: string;
      entryOrder: number;
      /**
       * 🔴 `entryOrder` が呼び手の指定か(「元に戻す」が移す前の並びを運んだ)。偽 = 末尾の仮の値で、
       * 効果層はゴミ箱へ移す前に控えた並びがあればそれで戻す(台帳 #1852 G2 / 依頼 106 A)。
       */
      explicitOrder?: boolean;
      /** 頼んだ時点の `selectedLid`(#1087)。効果層が `ENTRY_RESTORED` へそのまま渡す。 */
      selectedAtIssue: string | null;
    }
  | { type: 'REQUEST_TRASH_PURGE'; lid?: string };

/** まとめてタグを付けた「元に戻す」の 1 組: この `lids` から、この `tags` を外す(付けた分だけ)。 */
export interface TagUndoGroup {
  readonly tags: readonly string[];
  readonly lids: readonly string[];
}

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
/**
 * 🔴 **履歴の上限**(#918 段②a)。⚠ 打つほど重くなる形にしない。
 * 🔑 20 は「1 回の作業で遡りたい範囲」── これを超えたら、ふつうは思い出せない。
 */
/** 選んだファイルを開いている最中に「実行」が押されたときの断り(#1087) */
export const SQL_GUEST_OPENING_TEXT = '選んだファイルをまだ開いています。開き終わってから実行してください';
/** 開けなかったファイルを選んだまま「実行」が押されたとき(断りは打ち直しで消えている回)の断り(#1087) */
export const SQL_GUEST_NOT_OPEN_TEXT = '選んだファイルが開けていません。選び直してから実行してください';
export const SQL_HISTORY_MAX = 20;

/**
 * 走った字を履歴へ積む。⚠ **同じ字を 2 つ並べない**(直前と同じなら積み直さない)。
 * 🔑 純粋な関数にしてあるので、reducer の中で `if` を増やさずに済む。
 */
export function historyPush(
  history: readonly string[],
  sql: string,
): { readonly history: readonly string[] } {
  if (sql === '' || history[0] === sql) return { history };
  return { history: [sql, ...history].slice(0, SQL_HISTORY_MAX) };
}

/**
 * 履歴の**いま見ている所**へ、手直しした字を控える。
 * ⚠ 呼ぶのは `historyAt >= 0` のときだけ(打ちかけの側は `sql` 自身が正本)。
 */
export function withHistoryEdit(p: SqlPageState, sql: string): readonly (string | undefined)[] {
  const edits = [...p.historyEdits];
  edits[p.historyAt] = sql;
  return edits;
}

/**
 * 履歴の `at` 番目(**`-1` = 打ちかけ**)を欄へ出す。
 *
 * ⚠ **遡り始める 1 回だけ**打ちかけの字を控える ── 2 回目に控えると、
 *   1 つ前の履歴で打ちかけが潰れる。
 * 🔑 `↑` `↓`(`SQL_HISTORY_STEP`)と一覧から選ぶ(`SQL_HISTORY_PICK`)が
 *   **同じ 1 か所**を通る ── 2 つ目の数え方を作らない(CLAUDE.md §7)。
 */
export function goHistory(p: SqlPageState, at: number, from: number): SqlPageState {
  const draft = from === -1 && at >= 0 ? p.sql : p.historyDraft;
  // 🔑 **手直しした字が在ればそちら**(無ければ走らせた字そのもの)
  const sql = at < 0 ? draft : (p.historyEdits[at] ?? p.history[at] ?? p.sql);
  return { ...p, sql, historyAt: at < 0 ? -1 : at, historyDraft: draft };
}

/**
 * 🔴 **下書き自身の action(#1044 段2 / 段3)**。⚠ この 6 つだけは
 * {@link guardSectionDraftTransition} を通さない ── 下書きを開く・保存する・
 * やめるのは、下書きそれ自身が `sectionDraft` を動かしてよい唯一の場所である。
 */
const PARTIAL_DRAFT_OWN_ACTIONS: ReadonlySet<Dispatchable['type']> = new Set([
  'OPEN_SECTION_DRAFT',
  'SAVE_SECTION_DRAFT',
  'CANCEL_SECTION_DRAFT',
  'OPEN_CODE_DRAFT',
  'SAVE_CODE_DRAFT',
  'CANCEL_CODE_DRAFT',
]);

/**
 * 🔴 **`SystemCommand` の全数**(#1044 段2)。⚠ user の action と system command の
 * 見分けを**ここ 1 か所**に置く ── `Record<SystemCommand['type'], true>` なので、
 * 新しい `SystemCommand` を足して載せ忘れると tsc が落ちる(CLAUDE.md §7 と同じ作法)。
 */
const SYSTEM_COMMAND_TYPES: Record<SystemCommand['type'], true> = {
  SYS_BOOTED: true,
  MESSAGES_UNREAD_SET: true,
  MESSAGES_BODY_REFRESH: true,
  SET_SEARCH_DETAIL: true,
  SEARCH_DETAIL_FAILED: true,
  STACK_BODY_LOADED: true,
  BODY_LOADED: true,
  SPLIT_BODY_LOADED: true,
  PLACE_BODIES_WANTED: true,
  PLACE_BODY_LOADED: true,
  SPLIT_RESTORED: true,
  BODY_LOAD_FAILED: true,
  BODY_PERSISTED: true,
  REMOTE_BODY_CHANGED: true,
  ENTRY_STAMPED: true,
  PERSIST_STATE: true,
  BACKLINKS_LOADED: true,
  BODY_REWRITTEN: true,
  OP_FAILED: true,
  SYS_ERROR: true,
  REVISION_LIST_LOADED: true,
  TRASH_LIST_LOADED: true,
  FILE_LINKED: true,
  ENTRY_RESTORED: true,
  TRASH_PURGED: true,
  ENTRY_APPENDED: true,
  APPEND_FAILED: true,
  SECTION_SAVED: true,
  SECTION_SAVE_FAILED: true,
  CODE_SAVED: true,
  CODE_SAVE_FAILED: true,
  ROLLBACK_RELATION: true,
  ROLLBACK_ENTRY_PARENT: true,
  SET_ENTRY_ARCHETYPE_ROLLBACK: true,
};

function isSystemCommand(action: Dispatchable): boolean {
  return Object.prototype.hasOwnProperty.call(SYSTEM_COMMAND_TYPES, action.type);
}

/**
 * 🔴 **章の欄が開いている間、そのノートから離れる遷移を reduce() の外側 1 か所で止める**
 * (#1044 段2。着地前レビューで確定した欠陥 D1/F3/F1/F2 ── `DELETE_ENTRY` /
 * `DELETE_ENTRIES` / `DESELECT_ENTRY` / `MESSAGES_READ` は `sectionDraft` を見ないので
 * どれでも下書きが孤児化し、以後「二重に開かない」門(`OPEN_SECTION_DRAFT` の
 * `if (state.sectionDraft != null) return`)が効いて**どのノートでも「この章を編集する」が
 * 無言で効かなくなる**)。
 *
 * 🔑 個別の action を 1 つずつ塞がない ── **判定は action の種類ではなく「結果の形」**
 *   (selectedLid が draft.lid から動いたか / entryMetas から draft.lid が消えたか)
 *   で見るので、次に選択を動かす case / entry を消す case を足した人が忘れられない
 *   (CLAUDE.md §7「次に選択を動かす case を足した人が忘れられない形」── 履歴・
 *   バックリンクを reduce() の外側 1 か所で守っているのと同じ作法)。
 *
 * - **user の action** → 丸ごと断る(下書きも、押す前の state も 1 バイトも動かさない)。
 * - **system command**(別タブの書込・再読込)→ 結果は受け入れる(system の結果を
 *   拒むと disk と画面がずれる)。sectionDraft だけ閉じ、画面の言葉で知らせる。
 *
 * ⚠ **test のため export する**(#1044 段2 2巡目の修理、R6)── `entryGone` 単独
 *   (`movedAway` が false のまま entry だけ消える)は、いまの reducer のどの
 *   組合せの action からも単独では起きない(entry を消す既存の case は
 *   `pruneHistory` 等で選択も一緒に動くのが普通)。「結果の形だけを見る」という
 *   この関数の主張そのものを守るには、**手で組んだ前後の state**を直に渡して
 *   `entryGone` だけが true の場面を作る必要がある(`reduce()` 経由では作れない)。
 */
export function guardSectionDraftTransition(
  state: AppState,
  action: Dispatchable,
  result: ReduceResult,
): ReduceResult {
  const draft = state.sectionDraft;
  if (draft === null) return result;
  if (PARTIAL_DRAFT_OWN_ACTIONS.has(action.type)) return result;
  const movedAway = state.selectedLid === draft.lid && result.state.selectedLid !== draft.lid;
  const entryGone = state.entryMetas.has(draft.lid) && !result.state.entryMetas.has(draft.lid);
  if (!movedAway && !entryGone) {
    /**
     * 🔴 **章の欄が開いたままなら、system command は自身の断り文を消さない**
     *   (#1044 段2 4巡目の修理、T2)。
     *
     * ⚠ 実害:`SECTION_SAVE_FAILED` が置いた断り文(例:「この章は別の場所で
     *   書き換えられました…」)は、まさにその断りの原因(別タブの書込)を見た
     *   `SYS_BOOTED` が**約 250ms 後**に `error: null` を無条件に置くので画面から
     *   消える(user 目線レビューの撮影で実測)。ここを通る system command は
     *   「章の欄を閉じない」側(`movedAway` も `entryGone` も false)なので、
     *   下の「閉じて知らせる」分岐(`clearedSectionDraftAdvisory` を通す)には
     *   一度も来ず、`result` がそのまま素通りしていた。
     * 🔑 **章の欄自身の断り文(`state.error === state.sectionAdvisory`)だけ引き継ぐ**
     *   (#1044 段2 5巡目の修理、U3で「固定の字の集合」から等値へ変えた)── 無関係な
     *   error(disk 書込エラー等)は、system command が消してよいなら今までどおり消える
     *   (ここで戻すのは「消える直前の値が章の欄自身が置いた字だった」ときだけ ──
     *   対照群は `tests/adapter/section-draft.test.ts` 参照)。
     */
    if (
      isSystemCommand(action) &&
      result.state.error === null &&
      result.state.sectionDraft !== null &&
      state.error !== null &&
      state.error === state.sectionAdvisory
    ) {
      return { ...result, state: { ...result.state, error: state.error } };
    }
    return result;
  }
  if (!isSystemCommand(action)) {
    // 🔴 user の action ── 丸ごと断る(下書きは残る。断り文は箱のボタン名で出口を言う)
    return sectionDraftBlockedResult(state);
  }
  /**
   * 🔴 system command ── 結果は受け入れ、下書きを閉じて知らせる。
   *
   * 🔑 **章の欄自身の断り文も消す**(#1044 段2 3巡目の修理、S4)。⚠ 直す前は
   *   `result.state.error` をそのまま持ち越していた ── 直前に user の action が
   *   ここで断られて `error: SECTION_DRAFT_NOTE` を置いていた回、system command
   *   が閉じても**その断り文が残ったまま**「別の場所の操作でこのノートが…」の
   *   `notice` と同時に出る(`notice` と `error` は別の面なので、どちらも画面に残る)。
   *   `OPEN_SECTION_DRAFT` / `SAVE_SECTION_DRAFT` 成功と同じ寿命の考え方(R5)を
   *   ここにも揃える。
   */
  return {
    state: {
      ...result.state,
      sectionDraft: null,
      notice: partialDraftClosedBySystemNotice(partialDraftKind(draft)),
      ...clearedSectionDraftAdvisory(result.state),
    },
    events: result.events,
  };
}

/**
 * 🔴 **塗っているノートから離れた / 編集に入った / 章の欄を開いたら、塗りを消す**(#1102 段①)。
 *
 * 🔑 個別の action を見張らない ── **判定は結果の形**(選んでいる lid / `phase` / 章の欄)。
 *   次に選択を動かす case を足した人が忘れられない(`guardSectionDraftTransition` と同じ理由)。
 * ⚠ **`ready` でないと塗らない**(編集中は本文が描かれていない / 編集を始めたら消す)。
 * ⚠ 消えた後に残る物は無い ── 塗りは DOM の側の物で、`null` を見た描く側が片付ける。
 */
export function dropStaleSearchJump(result: ReduceResult): ReduceResult {
  const j = result.state.searchJump ?? null;
  if (j === null) return result;
  const st = result.state;
  /**
   * 🔴 **欄の語で塗った塗りは、欄の語が空になったら消える**(#1102 段②)。⚠ 「探す」から来た塗り
   *   (`origin: 'find'`)は欄を触っても消えない。⚠ 見るのは**結果の形**(いまの `filterQuery`)── 欄を
   *   空にする case(語を消す / 絞りを解く)を 1 つずつ見張らない。
   */
  /**
   * 🔴 **欄の語を別の語へ打ち変えたときも消す**(#1102 段③。段②の「覆る条件」を実装)── 塗りが前の語の
   *   まま残ると、いま欄に出ている語と本文の塗りが食い違う。語が同じ(空白・大小の揺れだけ)なら残す。
   */
  const fieldNow = normalizeFindQuery(st.filterQuery);
  const orphanedByField =
    j.origin === 'filter' && (fieldNow === '' || !sameFilterTerms(fieldNow, j.query));
  if (
    !orphanedByField &&
    st.selectedLid === j.lid &&
    st.phase === 'ready' &&
    st.sectionDraft == null
  )
    return result;
  return { ...result, state: { ...st, searchJump: null } };
}

/**
 * 欄の語が「同じ語」か。🔑 塗る側(`jumpTerms(…, 'filter')`)と同じ切り方 ── 空白(全角も)で区切った語の集合を、
 * 大小を畳んで比べる(語の順・空白の数・大文字小文字の揺れでは塗りを消さない)。
 */
function sameFilterTerms(a: string, b: string): boolean {
  const key = (q: string): string =>
    jumpTerms(q, 'filter').map(foldCase).sort().join('\u0000');
  return key(a) === key(b);
}

/**
 * 🔴 **左の列の欄に語が入っている間にノートの行を押したら、その語で塗り始める**(#1102 段②。
 * Gemini 裁定 = A)。
 *
 * 🔑 起点を 1 つ増やすだけ ── 塗る / 送る / 帯 / 消える、は段①の `SEARCH_JUMP_START` がそのまま持つ
 *   (**新しい部品を作らない**)。ここは「行を押した」結果を見て、同じ action を欄の語で撃つだけで、
 *   判断を binder に散らさない(`reduce()` の外側 1 か所 ── 選ぶ経路が増えても忘れられない)。
 * 🔑 **断る条件を書き写さない**(二重帳簿にしない)── 欄が空 / 押した行が選ばれていない(編集中・章の欄の
 *   確認で戻された)/ 読む画面でない、は `SEARCH_JUMP_START` が断る。断られたら控えは**動かない**
 *   (「探す」から来た塗りにも触らない)。
 * ⚠ ここが持つのは START が知らない 2 つだけ:**`>` で始まる欄は操作を探している**(`commandQueryOf`)
 *   ので本文の語ではない / **本文が画面に出ているときだけ**。
 */
function startSearchJumpFromField(action: Dispatchable, result: ReduceResult): ReduceResult {
  if (action.type !== 'SELECT_ENTRY') return result;
  const st = result.state;
  if (commandQueryOf(st.filterQuery) !== null) return result;
  // ⚠ 探す面 / 集計 / SQL などの面は、行を押しても中央がその面に留まる(本文は畳まれている)。
  //   そこで塗ると、見えない本文へ送って、戻った所で位置がずれている
  if (st.viewMode !== 'detail') return result;
  const started = reduceCore(st, {
    type: 'SEARCH_JUMP_START',
    lid: action.lid,
    query: st.filterQuery,
    origin: 'filter',
  });
  // ⚠ 断られたら**参照ごと同じ**を返す(`error` phase の選択の断りは「完全 no-op」と pin されている)
  if (started.state.searchJump === st.searchJump) return result;
  return { ...result, state: { ...st, searchJump: started.state.searchJump } };
}

/** `reduce` の入れ子の深さ。⚠ 内側の `reduce`(グループ作成の中のノート作成など)と外側を見分けるための物。 */
let reduceDepth = 0;

/**
 * 🔴 **一覧の見え方が変わったときだけ、「最近開いた順」の材料を最新にする**(依頼 274 / 334)。
 *
 * ⚠ ノートを開くたびに写しを更新すると、押した行がその場で先頭へ跳ぶ(続けて隣を押そうと
 *   して押し間違える)。逆に写しを一度も更新しないと、並びが永久に古い。
 * 🔑 読み手(一覧の描画・範囲選択・↑↓)は全員 `openedAtShown` を読むので、更新の時機を
 *   ここ 1 か所に置けば、見えている並びと動く並びが食い違わない。
 */
function settleOpenedOrder(prev: AppState, result: ReduceResult): ReduceResult {
  const s = result.state;
  if (s.openedAtShown === s.openedAt) return result;
  const listChanged =
    s.scopeLid !== prev.scopeLid ||
    s.filterQuery !== prev.filterQuery ||
    s.kindFilter !== prev.kindFilter ||
    s.entrySort !== prev.entrySort ||
    s.entrySortDesc !== prev.entrySortDesc ||
    s.filerFlatten !== prev.filerFlatten ||
    s.searchHits !== prev.searchHits ||
    s.smartHits !== prev.smartHits;
  if (!listChanged) return result;
  return { ...result, state: { ...s, openedAtShown: s.openedAt } };
}

/**
 * 🔴 **開いているノートが、いま左の一覧に出ていない場所にあるなら、一覧もそのフォルダへ移る**(依頼 277。Gemini 回答 = A)。
 *
 * ⚠ リンクや「操作を探す」で別のフォルダのノートを開いても、左の一覧は前の場所のままで、
 *   開いているノートの行がどこにも見えなかった。
 * 🔑 動かすのは次の 3 つが揃うときだけ:
 *   ①開いているノートが変わった ②その場所(`scopeLid`)を、この操作が動かしていない
 *   (パンくず・「すべてのフォルダから探す」など、user が場所を決めた操作は尊重する)
 *   ③絞り込み(語・種類の札)が無く、いまの一覧にそのノートの行が無い
 *   (絞っているときは、場所を移しても行は出ない ── user の絞りを勝手に外さない)。
 * ⚠ 行き先は**そのノートの親のフォルダ**(無ければルート)。ノート自身がフォルダなら、その中へは入らず
 *   親の側に出す(開いたフォルダは、一覧の行として見える)。
 * ⚠ 場所を移すので前の場所の印(複数選択)は外す(`SET_SCOPE` と同じ理由)。開いたノート自身の印だけ残る。
 */
function followSelectionScope(prev: AppState, result: ReduceResult): ReduceResult {
  const st = result.state;
  if (st.selectedLid === null || st.selectedLid === prev.selectedLid) return result;
  if (st.scopeLid !== prev.scopeLid) return result;
  if (normalizeQuery(st.filterQuery) !== '' || st.kindFilter.size > 0) return result;
  const lid = st.selectedLid;
  if (!st.entryMetas.has(lid)) return result;
  // ⚠ いま居るフォルダ自身を選んだ(パンくずの最後の段を押した)ときは場所を動かさない(#1254 §1)
  if (lid === st.scopeLid) return result;
  // 🔑 並べ替えずに答える(選ぶたびに全件を並べ直さない)。スマートフォルダの中だけは当たりの集合で決まる
  const shown =
    lidShownInScope(lid, st.scopeLid, st.entryMetas, st.relations, st.filerFlatten) ??
    filerRows(st.scopeLid, st.entryMetas, st.relations, filerRowOptions(st)).some((m) => m.lid === lid);
  if (shown) return result;
  const to = getAncestorFolders(lid, st.entryMetas, st.relations)[0]?.lid ?? null;
  if (to === st.scopeLid) return result;
  return {
    ...result,
    // ⚠ 開いたノート自身の印(`SELECT_ENTRY` が付けた 1 件)だけは残す ── 移した先の一覧に出る行である
    state: { ...st, scopeLid: to, selection: [lid], selectionAnchor: lid },
    events: [...result.events, ...smartScanFor(st, to)],
  };
}

/**
 * 🔴 **履歴から戻したときの知らせの字**(台帳 #1852 G1 / 依頼 141・229 B)。戻すと本文と一緒に題名も当時の物に戻る ──
 * 題名が変わったときは、それを知らせに書く(書かないと、一覧の題名が黙って変わったように見える)。
 * ⚠ 字はここ 1 本 ── 知らせ本体と「元に戻す」の照合用の字(`restoreUndo.notice`)が食い違うと、「元に戻す」が出なくなる。
 */
export function revisionRestoredNotice(prevTitle: string, newTitle: string, fromUndo: boolean): string {
  const head = fromUndo ? `「${newTitle}」を、戻す前の本文に戻しました` : `「${prevTitle}」を前の版に戻しました`;
  return prevTitle === newTitle ? head : `${head}(題名も「${newTitle}」に戻しました)`;
}

export function reduce(state: AppState, action: Dispatchable): ReduceResult {
  reduceDepth++;
  try {
    const r = settleOpenedOrder(state, followSelectionScope(state, dropStaleSearchJump(
      startSearchJumpFromField(
        action,
        guardSectionDraftTransition(state, action, reduceWithHistory(state, action)),
      ),
    )));
    // 🔑 追随は**一番外側の 1 回だけ**(内側の `reduce` ごとに撃つと、同じ読みが何本も積まれる)
    return reduceDepth === 1 ? followLauncherTiles(state, r) : r;
  } finally {
    reduceDepth--;
  }
}

/**
 * 🔴 **アプリ一覧を開いたことがあるなら、ノートの増減・題名の変化でタイルも読み直す**(#1087)。
 *
 * ⚠ 改名・ごみ箱へ移す / 戻す の後に何も頼まないと、旧名や消した物のタイルが残って、押すと
 *   ごみ箱の物を開く。⚠ `SYS_BOOTED` は自分の枝で頼む(下の重ね止めで二重にならない)。
 *   保存のたびの打鍵では撃たない(`entryListChanged` が増減と題名だけ見る)。
 * ⚠ 同じ読みを既に積んでいる case(グループの作成・改名・並べ替えは自分で `readAppGroupNotes` を積む)
 *   とは**重ねない** ── 世代つきの読み直しを 2 本積むと、1 本目が古い世代として扱われうる。
 */
function followLauncherTiles(
  before: AppState,
  result: ReduceResult,
): ReduceResult {
  const after = result.state;
  if (
    after.launcherTiles === null ||
    after.entryMetas === before.entryMetas ||
    !entryListChanged(before.entryMetas, after.entryMetas)
  )
    return result;
  const have = new Set(result.events.map((e) => e.type));
  const add = launcherReloadEvents(after.order, after.entryMetas, after.appGroupGen).filter(
    (e) => !have.has(e.type),
  );
  return add.length === 0 ? result : { ...result, events: [...result.events, ...add] };
}

/** ノートの増減か、題名が変わったか(並び順・日付・保存の印だけの変化は含めない)。 */
export function entryListChanged(
  before: ReadonlyMap<string, EntryMeta>,
  after: ReadonlyMap<string, EntryMeta>,
): boolean {
  if (before.size !== after.size) return true;
  for (const [lid, m] of after) {
    const b = before.get(lid);
    if (b === undefined || b.title !== m.title) return true;
  }
  return false;
}

function reduceWithHistory(state: AppState, action: Dispatchable): ReduceResult {
  if (action.type === 'NAV_HISTORY') return navHistory(state, action.dir);
  const result = reduceCore(state, action);
  let history = result.state.selectionHistory;
  /**
   * 🔴 **消えた lid の掃除も、ここ 1 か所でやる**(#241 段⑥)。
   * ⚠ 2 ペインの印と現在地を case ごとに検めると、**次に entry を消す case を
   *   足した人が必ず忘れる**(履歴を 1 か所へ寄せたのと同じ理由)── 忘れると
   *   「N 件を移す」が居ないものを数え、消えたフォルダの中身として空の表が出る。
   * ⚠ 掃除は entryMetas が**変わった回だけ**(毎回やると 50 件の走査が無駄に回る)
   */
  let dual = result.state.dual;
  let fellBackNotice: string | null = null;
  if (result.state.entryMetas !== state.entryMetas) {
    const aliveNow = (lid: string): boolean => result.state.entryMetas.has(lid);
    history = pruneHistory(history, aliveNow);
    /**
     * 🔴 **見ていたフォルダが消えたら、まだ残っている親を見せて、そう言う**(台帳 #1852 G1 / 依頼 228)。
     * ⚠ 直す前は、2 ペインのもう片方が消えたフォルダの中を開いていると、黙っていちばん上の階層へ飛んでいた。
     *   親は**消える前の木**で辿る(消えた後の木にはもう居ない)。別のタブで消した回(`SYS_BOOTED`)も同じ口を通る。
     */
    const dualBefore = result.state.dual;
    dual = pruneDual(dual, aliveNow, (lid) => {
      for (const up of getAncestorFolders(lid, state.entryMetas, state.relations)) if (aliveNow(up.lid)) return up.lid;
      return null;
    });
    const fell = scopeFellBack(dualBefore, dual, aliveNow, (lid) => result.state.entryMetas.get(lid)?.title);
    if (fell !== undefined) fellBackNotice = scopeFallbackNote(fell.parentTitle);
  }
  // 🔴 システムのメッセージ / 処理の記録は履歴に積まない(戻る・進むは `SELECT_ENTRY` で選ぶが、
  //    この 2 件は `entryMetas` に居ないので断られ、押しても何も起きない dead click になっていた)
  if (
    result.state.selectedLid !== null &&
    result.state.selectedLid !== state.selectedLid &&
    !isSystemMessageLid(result.state.selectedLid)
  )
    history = pushSelection(history, result.state.selectedLid);
  /**
   * 🔴 **バックリンクも「選択が動いた結果」を 1 か所で見る**(#348、2026-08-23)。
   *
   * ⚠ `REQUEST_BODY` は case ごとに撃っているが、あれは**選択以外の理由でも要る**
   *   (復元・保存の後)。こちらは**選んだノートの周りを見せる**だけなので、
   *   選択が動いた 1 点で足りる ── 上の履歴と同じ理屈で、
   *   **次に選択を動かす case を足した人が忘れられない**形にする(§7)。
   * ⚠ 前の結果は**その場で捨てる**(`null` = まだ引いていない)── 残すと、
   *   新しいノートの下に**前のノートのバックリンク**が数百 ms 出る。
   */
  let backlinks = result.state.backlinks;
  let events = result.events;
  if (result.state.selectedLid !== state.selectedLid) {
    backlinks = null;
    if (result.state.selectedLid !== null)
      events = [...events, { type: 'REQUEST_BACKLINKS', lid: result.state.selectedLid }];
  }
  /**
   * 🔴 **選んだまま、ノートの増減・ゴミ箱・戻す・改名が起きたら、参照元を取り直す**(#1087)。
   *
   * ⚠ 直す前は選択が動いたときしか引かなかったので、参照元をゴミ箱へ移す / 戻す / 改名しても
   *   情報ペインの「参照元」が古いまま残った。⚠ 保存のたびに `entryMetas` は作り直される
   *   (`ENTRY_STAMPED`)── 打鍵ごとに引かないよう、**増減と題名が変わったときだけ**撃つ。
   * 🔑 新しい待ち口は作らない ── 撃った先は選択が動いたときと同じ `scanAfterWrites`(書込の後ろ)。
   *   前の答えは**残す**(消すと保存のたびに「調べています…」へ戻ってちらつく)。
   */
  if (
    result.state.selectedLid !== null &&
    result.state.selectedLid === state.selectedLid &&
    result.state.entryMetas !== state.entryMetas &&
    entryListChanged(state.entryMetas, result.state.entryMetas)
  )
    events = [...events, { type: 'REQUEST_BACKLINKS', lid: result.state.selectedLid }];
  if (
    history === result.state.selectionHistory &&
    dual === result.state.dual &&
    backlinks === result.state.backlinks &&
    fellBackNotice === null
  )
    return { state: result.state, events };
  return {
    state: {
      ...result.state,
      selectionHistory: history,
      dual,
      backlinks,
      // ⚠ 別の知らせがこの回に出ていたら上書きしない(ゴミ箱へ移した直後の知らせは、自分で同じ一文を載せる)
      ...(fellBackNotice !== null && result.state.notice === state.notice
        ? { notice: fellBackNotice, noticeOpen: null, noticeCreate: null }
        : {}),
    },
    events,
  };
}

/**
 * 戻る・進む。⚠ **行き先の採否は `SELECT_ENTRY` に決めさせる** ── 編集中は動かない /
 * 居ない lid は選ばない、という規則をここに書き写すと二重帳簿になる(§7)。
 * 🔑 だから「選択が実際に動いたか」を見て、動いたときだけ履歴を確定させる。
 */
function navHistory(state: AppState, dir: 'back' | 'forward'): ReduceResult {
  const h = state.selectionHistory;
  const sel = state.selectedLid;
  /**
   * 🔴 **履歴の末尾 =「いま」とは限らない**。掃除(`pruneHistory`)や別タブの削除(選択が null へ)、
   *   システムのメッセージ(履歴に積まない)を開いているときは、いまの選択と末尾がずれる。
   *   ずれているときの「戻る」は**末尾へ戻る**(さらに 1 つ飛ばすと、いたノートを跳び越す)。
   * 🔴 **行き先が選べなければ次の行き先へ**(選べない物を挟むと押しても何も起きない)。
   *   ただし編集中などで全部断られたら何も変えない。
   */
  const tail = historyCurrent(h);
  const stale = sel !== tail;
  if (dir === 'back') {
    const start = stale ? h.past.length - 1 : h.past.length - 2;
    // いまの選択が履歴の物なら「進む」で戻れるよう未来へ入れる(メッセージ類は入れない)
    const headFuture =
      stale
        ? sel !== null && !isSystemMessageLid(sel)
          ? [sel, ...h.future]
          : h.future
        : [tail as string, ...h.future];
    for (let i = start; i >= 0; i--) {
      const target = h.past[i] as string;
      if (target === sel) continue;
      const result = reduceCore(state, { type: 'SELECT_ENTRY', lid: target });
      if (result.state.selectedLid !== target) continue; // 断られた(編集中・居ない)
      return {
        state: { ...result.state, selectionHistory: { past: h.past.slice(0, i + 1), future: headFuture } },
        events: result.events,
      };
    }
    return { state, events: [] };
  }
  for (let j = 0; j < h.future.length; j++) {
    const target = h.future[j] as string;
    if (target === sel) continue;
    const result = reduceCore(state, { type: 'SELECT_ENTRY', lid: target });
    if (result.state.selectedLid !== target) continue;
    return {
      state: {
        ...result.state,
        selectionHistory: {
          past: tail === target ? h.past : [...h.past, target],
          future: h.future.slice(j + 1),
        },
      },
      events: result.events,
    };
  }
  return { state, events: [] };
}

/** 戻れるか(UI の活殺に使う)。⚠ 末尾といまの選択がずれているときは 1 件でも戻れる。 */
export function canNavBack(state: AppState): boolean {
  const h = state.selectionHistory;
  return canGoBack(h) || (h.past.length >= 1 && state.selectedLid !== historyCurrent(h));
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
    case 'SYS_BOOTED':
    case 'MESSAGES_UNREAD_SET':
    case 'MESSAGES_BODY_REFRESH':
    case 'SELECT_ENTRY':
    case 'MESSAGES_READ':
    case 'BODY_LOADED':
    case 'BODY_LOAD_FAILED':
      return reduceBoot(state, action);
    case 'SET_ENTRY_FILTER':
    case 'TOGGLE_KIND_FILTER':
    case 'CLEAR_KIND_FILTER':
    case 'SET_OPENED_AT':
    case 'SET_ENTRY_SORT':
    case 'SET_QUERY_KEY':
    case 'REFRESH_QUERY':
    case 'SET_QUERY_SCAN':
    case 'QUERY_FAILED':
    case 'SET_TASK_SCAN':
    case 'TASK_SCAN_FAILED':
    case 'SET_CONTACT_SCAN':
    case 'CONTACT_SCAN_FAILED':
    case 'SET_WORK_LOG_SCAN':
    case 'WORK_LOG_SCAN_FAILED':
    case 'SET_WORK_LOG_LABEL':
    case 'DELETE_WORK_LOG':
    case 'SET_CAPTURE_ITEMS':
    case 'CAPTURE_SCAN_FAILED':
    case 'SET_CAPTURE_PLAYING':
    case 'SET_CAPTURE_TRIM_MARK':
    case 'CLEAR_CAPTURE_TRIM':
    case 'SET_CAPTURE_TRIM_BUSY':
    case 'SET_CAPTURE_TRANSCRIBE':
    case 'SET_GRAPH_VIEW':
    case 'SET_SNIPPET_SCAN':
    case 'SET_SEARCH_HITS':
    case 'SET_SEARCH_PAGE_QUERY':
      return reduceQueryScan(state, action);
    case 'SET_SQL_TEXT':
    case 'RUN_SQL':
    case 'SQL_HISTORY_STEP':
    case 'SQL_HISTORY_PICK':
    case 'SQL_EXPORT_PARQUET':
    case 'SQL_SCHEMA_TO_NOTE':
    case 'SQL_ER_TOGGLE':
    case 'SQL_ER_CONNECT_TOGGLE':
    case 'SQL_ER_PICK':
    case 'SQL_ER_UNLINK':
    case 'SQL_ER_PRESS':
    case 'SQL_ER_LOADED':
    case 'SQL_ER_FAILED':
    case 'SET_SQL_RESULT':
    case 'SQL_SAVED':
    case 'SET_SQL_ENGINE':
    case 'SET_SQL_SOURCE':
    case 'ADD_SQL_SOURCE':
    case 'REMOVE_SQL_SOURCE':
    case 'SQL_GUEST_OPENED':
    case 'SQL_GUEST_FAILED':
    case 'SQL_SAVE_FAILED':
    case 'SQL_DUCK_LOADING':
    case 'SQL_RUN_FAILED':
      return reduceSql(state, action);
    case 'SET_SEARCH_DETAIL':
    case 'SEARCH_DETAIL_FAILED':
    case 'SET_OPEN_EXTENSIONS':
    case 'SET_VIEW_MODE':
    case 'REFRESH_TASK_SCAN':
    case 'REFRESH_CONTACT_SCAN':
    case 'REFRESH_WORK_LOG_SCAN':
    case 'REFRESH_SEARCH':
    case 'REFRESH_CAPTURE_SCAN':
    case 'REFRESH_SNIPPET_SCAN':
      return reduceView(state, action);
    case 'REFRESH_LAUNCHER_TILES':
    case 'PICK_APP_TILE':
    case 'SET_LAUNCHER_REORDER':
    case 'LAUNCHER_TILES_LOADED':
    case 'APP_GROUP_NOTES_LOADED':
    case 'MOVE_APP_GROUP':
    case 'RESET_APP_GROUP_ORDER':
    case 'RENAME_APP_GROUP':
    case 'SET_APP_GROUP_ICON':
    case 'APP_TILE_SAVED':
    case 'OFFICE_ASSET_SAVED':
    case 'ENTRY_BODY_REFRESHED':
    case 'SET_APP_TILE':
    case 'MOVE_APP_TILE':
      return reduceLauncher(state, action);
    case 'START_EDIT':
    case 'REPLACE_IN_BODY':
    case 'UPDATE_OPEN_BODY':
    case 'COMMIT_EDIT':
    case 'RETRY_PERSIST':
    case 'CANCEL_EDIT':
    case 'OPEN_SECTION_DRAFT':
    case 'SAVE_SECTION_DRAFT':
    case 'SECTION_SAVED':
    case 'SECTION_SAVE_FAILED':
    case 'CANCEL_SECTION_DRAFT':
    case 'OPEN_CODE_DRAFT':
    case 'SAVE_CODE_DRAFT':
    case 'CODE_SAVED':
    case 'CODE_SAVE_FAILED':
    case 'CANCEL_CODE_DRAFT':
      return reduceEdit(state, action);
    case 'APPEND_TO_ENTRY':
    case 'FORCE_RELEASE_LOCK':
    case 'ENTRY_APPENDED':
    case 'UNDO_APPEND':
    case 'UNDO_AGENT_APPEND':
    case 'APPEND_FAILED':
      return reduceAppend(state, action);
    case 'SET_TASK_DATE':
    case 'SET_TASK_REPEAT':
    case 'ADOPT_EXTERNAL_IMAGES':
    case 'SET_CSV_CELL':
    case 'SET_FORM_VALUES':
    case 'SET_FORM_ROW':
    case 'SET_CSV_SHAPE':
    case 'SET_TABLE_FORMAT':
    case 'SET_IMAGE_ATTRS':
    case 'TOGGLE_TASK':
    case 'SET_COLOR_CODE':
    case 'SET_ATTACHMENT_NAME':
    case 'FIX_SPEAKERS':
    case 'SET_TASK_RUN':
    case 'MATERIALIZE_REPEAT':
    case 'MOVE_REPEAT_OCCURRENCE':
      return reduceBodyEdit(state, action);
    case 'MOVE_PLACE':
    case 'MOVE_PLACES':
    case 'GROUP_PLACES':
    case 'UNGROUP_PLACE':
    case 'RESIZE_PLACE':
    case 'CONNECT_PLACE':
    case 'REMOVE_PLACE_LINE':
    case 'REMOVE_PLACE':
    case 'ADD_PLACE':
    case 'SET_PLACE_RECT':
    case 'SET_PLACE_TEXT':
    case 'RAISE_PLACE':
    case 'LOWER_PLACE':
    case 'SET_PLACE_SHAPE':
    case 'SET_PLACE_STYLE':
      return reducePlaces(state, action);
    case 'MOVE_BLOCK':
    case 'SPLIT_CHAPTER':
    case 'RESTORE_CHAPTER':
    case 'HANDOFF_BLOCK':
    case 'INSERT_LINES':
    case 'UNDO_MOVE':
    case 'SET_ENTRY_DATE':
    case 'TOGGLE_TODO_STATUS':
    case 'BODY_REWRITTEN':
      return reduceBlockOps(state, action);
    case 'SET_CALENDAR_MONTH':
    case 'SET_SCHEDULE_MODE':
    case 'SET_SCHEDULE_NARROW_MODE':
    case 'SET_SCHEDULE_DAY':
    case 'TOGGLE_SHOW_ARCHIVED':
    case 'TOGGLE_SHOW_DONE_TASKS':
    case 'SET_ENTRY_OWNER':
    case 'SET_SCHEDULE_OWNER':
    case 'TOGGLE_SHOW_UNDATED_TASKS':
    case 'TOGGLE_SCHEDULE_NOTE':
      return reduceCalendar(state, action);
    case 'BODY_PERSISTED':
    case 'REMOTE_BODY_CHANGED':
    case 'BACKLINKS_LOADED':
    case 'PERSIST_STATE':
    case 'ENTRY_STAMPED':
      return reducePersisted(state, action);
    case 'TOGGLE_SELECT':
    case 'SELECT_RANGE':
    case 'SELECT_ALL':
    case 'SELECT_ONLY':
    case 'CLEAR_SELECTION':
    case 'SET_SCOPE':
    case 'SET_FILER_FLATTEN':
    case 'DESELECT_ENTRY':
      return reduceSelection(state, action);
    case 'CREATE_ENTRY':
    case 'DELETE_ENTRY':
    case 'DELETE_ENTRIES':
    case 'RENAME_ENTRY_TITLE':
    case 'SET_ENTRY_ARCHETYPE':
    case 'SET_ENTRY_PARENT':
    case 'SET_ENTRY_ORDER':
    case 'MOVE_ENTRY_ORDER':
    case 'ADD_RELATION':
    case 'SET_ENTRY_ARCHETYPE_ROLLBACK':
    case 'ROLLBACK_ENTRY_PARENT':
    case 'ROLLBACK_RELATION':
    case 'REMOVE_RELATION':
    case 'BULK_TAG':
    case 'RENAME_SMART_TAG':
      return reduceEntries(state, action);
    case 'SHOW_HISTORY':
    case 'PREVIEW_REVISION':
    case 'HIDE_REVISION_PREVIEW':
    case 'REVISION_PREVIEW_LOADED':
    case 'SET_REVISION_COMPARE':
    case 'REVISION_COMPARE_LOADED':
    case 'HIDE_HISTORY':
    case 'REVISION_LIST_LOADED':
    case 'RESTORE_REVISION':
    case 'REIMPORT_BODY':
      return reduceHistory(state, action);
    case 'SHOW_TRASH':
    case 'FILE_LINKED':
    case 'HIDE_TRASH':
    case 'TRASH_LIST_LOADED':
    case 'RESTORE_TRASH':
    case 'UNDO_TRASH':
    case 'PURGE_TRASH':
      return reduceTrash(state, action);
    case 'DUAL_FOCUS':
    case 'DUAL_SET_SCOPE':
    case 'DUAL_SELECT':
    case 'DUAL_SELECT_MANY':
    case 'DUAL_SET_CURSOR':
    case 'DUAL_TAB_ADD':
    case 'DUAL_TAB_CLOSE':
    case 'DUAL_CLEAR_SELECTION':
    case 'DUAL_RENAME_BEGIN':
    case 'DUAL_RENAME_END':
    case 'ROW_RENAME_BEGIN':
    case 'ROW_RENAME_END':
    case 'DUAL_SET_FILTER':
    case 'DUAL_BACK':
    case 'DUAL_FORWARD':
    case 'DUAL_SET_PREVIEW':
      return reduceDual(state, action);
    case 'SMART_SCANNED':
    case 'SMART_SCAN_FAILED':
    case 'SMART_TAGS':
    case 'SMART_COND':
    case 'SMART_FIELD':
    case 'SMART_RESCAN':
      return reduceSmart(state, action);
    case 'SWAP_OPEN_ENTRY':
    case 'PIN_SPLIT_ENTRY':
    case 'UNPIN_SPLIT_ENTRY':
    case 'CLEAR_SPLIT':
    case 'LOAD_STACK':
    case 'STACK_BODY_LOADED':
    case 'MOVE_STACK_LINK':
    case 'SPLIT_BODY_LOADED':
    case 'PLACE_BODIES_WANTED':
    case 'PLACE_BODY_LOADED':
    case 'SPLIT_RESTORED':
    case 'DUAL_PREVIEW_LOADED':
    case 'DUAL_TAB_ACTIVATE':
      return reduceSplit(state, action);
    case 'ENTRY_RESTORED':
    case 'TRASH_PURGED':
      return reduceRestore(state, action);
    case 'SEARCH_JUMP_START':
    case 'SEARCH_JUMP_STEP':
    case 'SEARCH_JUMP_END':
      return reduceSearchJump(state, action);
    case 'NOTICE_EXPIRED':
    case 'OP_NOTICE':
    case 'ASK_TAG_SUGGESTIONS':
    case 'SET_TAG_SUGGESTIONS':
    case 'TAGS_REFUSED':
    case 'CLEAR_REFUSED_TAGS':
    case 'OP_FAILED':
    case 'SYS_ERROR':
      return reduceNotice(state, action);
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
export function attachmentEntries(state: AppState): Array<{ lid: string; title: string }> {
  return attachmentEntriesOf(state.order, state.entryMetas);
}

/**
 * 🔴 **並びと目録を直に受ける版**(#683 段①)。
 * ⚠ `SYS_BOOTED` の枝は**まだ state に入れていない** `order` / `metas` を持つので、
 *   `state` から採ると**いま取り込んだ添付が 1 件も載らない**。
 */
/**
 * 🔴 **グループ用のノートだけを引く**(#857 段②)。
 *
 * ⚠ **添付の読み筋に相乗りさせない** ── `tileFrom` は archetype を見ないので、
 *   同じ経路へ混ぜた瞬間に「グループを表すノート」と「そのグループに入っている
 *   タイル」が同じ土俵に乗る(`app-group-spec.ts` の火種)。
 * 🔑 `entryMetas` が `archetype` を**生の列**で持つので、走査だけで引ける
 *   (本文も SQL も要らない ── 本文は effect 層がこの一覧だけを読む)。
 */
/**
 * 🔴 **その名前のグループ用ノートを 1 件引く**(#857 段②)。
 * ⚠ **先勝ち**(同じ題名が 2 つあっても迷わない)── 題名に一意制約が無いので、
 *   手で同じ字にすれば 2 つ作れる。決め方を機械で読める形にしておく
 *   (`appGroupIconsOf` の畳み方と**同じ向き**)。
 */
export function findAppGroupLid(
  order: readonly string[],
  metas: ReadonlyMap<string, EntryMeta>,
  name: string,
): string | null {
  for (const lid of order) {
    const meta = metas.get(lid);
    if (meta?.archetype === APP_GROUP_ARCHETYPE && appGroupName(meta.title) === name) return lid;
  }
  return null;
}

/**
 * 🔴 **その群のノートが在るか**(#857 段③)。
 * 🔑 判定は `findAppGroupLid` 1 本を通す ── 呼び側(binder)が同じ走査を
 *   書き直すと、探し方が 2 つになる(§7)。
 */
export function hasAppGroupNote(state: AppState, name: string): boolean {
  return findAppGroupLid(state.order, state.entryMetas, appGroupName(name)) !== null;
}

/**
 * 🔴 **番号の付いた群が 1 つでも在るか**(#857 段③)。
 * ⚠ メニューに「名前順に戻す」を出すかの判定に使う ── 0 件のときに出すと、
 *   押しても何も起きない(無言の dead click)。
 */
export function hasAppGroupOrder(state: AppState): boolean {
  return Object.keys(state.appGroupOrders).length > 0;
}

/**
 * 🔴 **名前を変えられるグループか**(依頼 83-2)── 自分のアプリが 1 つでも入っているグループだけ。
 * ⚠ メニューに「名前を変える…」を出すかの判定に使う(組み込みだけのグループでは押しても何も変わらない)。
 */
export function appGroupRenamable(state: Pick<AppState, 'launcherTiles'>, name: string): boolean {
  const g = appGroupName(name);
  return g !== '' && (state.launcherTiles ?? []).some((t) => isMovableTile(t) && t.group === g);
}

/**
 * 🔴 **いま在るグループの名前**(依頼 83-2 B)── アプリの設定の「グループ」の欄の候補。
 * ⚠ 自分のアプリが入っているグループ + グループ用のノートの題名。組み込みのグループは入れない(書いても紛れ込むだけ)。
 */
export function knownAppGroupNames(
  state: Pick<AppState, 'launcherTiles' | 'entryMetas'>,
): readonly string[] {
  const names = new Set<string>();
  for (const t of state.launcherTiles ?? []) if (isMovableTile(t) && t.group !== '') names.add(t.group);
  // ⚠ 一覧がまだ無い状態(boot 前・部分の state)でも落とさない ── 候補が出ないだけにする
  for (const meta of (state.entryMetas as ReadonlyMap<string, EntryMeta> | undefined)?.values() ?? []) {
    if (meta.archetype === APP_GROUP_ARCHETYPE && appGroupName(meta.title) !== '')
      names.add(appGroupName(meta.title));
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 🔴 **いま番号の付いている群の数**(#857 段③)── 押す前に範囲を言うために要る。 */
export function appGroupOrderCount(state: AppState): number {
  return Object.keys(state.appGroupOrders).length;
}

/**
 * 🔴 **その群にいま付いている図案の名前**(#857 段②、2026-09-13)。
 * ⚠ 目印を選ぶ小窓が「**どれが選ばれているか**」を描くために要る。
 * ⚠ 絵文字を直に貼った群は図案ではないので **空文字**を返す
 *   ── 表の中に該当が無いので「なし」に枠が付く(嘘の枠を付けない)。
 */
export function appGroupIconName(state: AppState, name: string): string {
  const got = appGroupIconOf(state.appGroupIcons, appGroupName(name));
  /**
   * 🔴 **絵文字を握り潰さない**(2026-09-13、着地前の動線レビュー)。
   *
   * ⚠ 直す前は `?.symbol ?? ''` だった ── グループ用のノートは**普通のノート**なので、
   *   user は本文の `appgroup.icon:` へ 🧮 のような字を**直に書ける**(見出しにも出る)。
   * 🔴 ところが `symbol` しか見ないので、小窓へ渡る値が **空になる** ──
   *   空は「なし」の合図と**同じ字**なので、表は**「なし」に枠を付けて焦点まで合わせる**。
   *   user は「何も付いていない」と読んで **Enter を押し**、🧮 が**黙って消える**。
   * 🔑 生の字も返す ── 表の中に無ければ**どこにも枠が付かない**(それが正確な答え)。
   */
  return got?.symbol ?? got?.icon ?? '';
}

function appGroupEntriesOf(
  order: readonly string[],
  metas: ReadonlyMap<string, EntryMeta>,
): Array<{ lid: string; title: string }> {
  const out: Array<{ lid: string; title: string }> = [];
  for (const lid of order) {
    const meta = metas.get(lid);
    if (meta?.archetype === APP_GROUP_ARCHETYPE) out.push({ lid, title: meta.title });
  }
  return out;
}

/**
 * 🔴 **グループ用ノートの読み直しを 1 本積む**(#857 段③)。
 *
 * 🔑 **封筒を組む口はここ 1 つ**(CLAUDE.md §7)── 世代を書き忘れる場所を作らない。
 * ⚠ 渡すのは**変更を当てた後の state** である ── 並びも世代もそこから読む
 *   (当てる前の state を渡すと、作りたてのノートが入らない / 世代が 1 つ古くなる)。
 */
export function readAppGroupNotes(s: AppState): DomainEvent {
  return {
    type: 'REQUEST_APP_GROUP_NOTES',
    entries: appGroupEntriesOf(s.order, s.entryMetas),
    gen: s.appGroupGen,
  };
}

/**
 * 🔴 **アプリ一覧のタイルとグループの読み直し 2 本**(#1087)。封筒を組む口は `readAppGroupNotes` と
 * ここの 2 つに寄せる ── 並びと世代は**変更を当てた後**のものを渡す。
 */
export function launcherReloadEvents(
  order: readonly string[],
  metas: ReadonlyMap<string, EntryMeta>,
  gen: number,
): DomainEvent[] {
  return [
    { type: 'REQUEST_LAUNCHER_TILES', entries: attachmentEntriesOf(order, metas) },
    { type: 'REQUEST_APP_GROUP_NOTES', entries: appGroupEntriesOf(order, metas), gen },
  ];
}

export function attachmentEntriesOf(
  order: readonly string[],
  metas: ReadonlyMap<string, EntryMeta>,
): Array<{ lid: string; title: string }> {
  const out: Array<{ lid: string; title: string }> = [];
  for (const lid of order) {
    const meta = metas.get(lid);
    if (meta?.archetype === 'attachment') out.push({ lid, title: meta.title });
  }
  return out;
}

/**
 * `entryOrder` 昇順(同値は lid)の位置へ挿す ── **boot の並びと同じ規則**。
 * ⚠ 規則を 2 つ書かない(復元だけ並びが違う、を作らない)。
 */
export function insertByOrder(
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


/**
 * 🔴 **ゴミ箱から戻した着弾が、選び直した選択を奪い返すか**(#1087)── 履歴の復元の「別のノートを選んでいたら
 * 奪わない」(`selectedLid !== meta.lid`)と同じ問いに答える**唯一の口**。
 * ゴミ箱の復元はノートがまだ居ないので `selectedLid === meta.lid` では比べられない ── 頼んだ時点の選択
 * (`selectedAtIssue`)と、着いたいまの選択が違えば「その間に選び直した」。省略時は判定しない。
 */
export function restoreKeepsSelection(
  state: AppState,
  action: { selectedAtIssue?: string | null },
): boolean {
  return action.selectedAtIssue !== undefined && state.selectedLid !== action.selectedAtIssue;
}

/**
 * 🔴 **ゴミ箱から戻した知らせ**(#1087)。字の頭は、移した直後の「元に戻す」(binder の `undo-trash`)と同じ。
 * 戻った先のフォルダが今も在るときだけ、その題名を添える。
 */
export function trashRestoredNotice(
  lid: string,
  relations: readonly Relation[],
  metas: ReadonlyMap<string, EntryMeta>,
): string {
  const parent = relations.find((r) => r.kind === STRUCTURAL && r.toLid === lid);
  const title = parent === undefined ? undefined : metas.get(parent.fromLid)?.title;
  return title === undefined ? 'ゴミ箱から元に戻しました' : `ゴミ箱から元に戻しました(「${title}」の中)`;
}

/**
 * 🔴 **同じ相手・同じ種類のつながりが既に在るか**(#1087)。⚠ `ADD_RELATION` が黙って捨てる判定と、
 * binder が先回りして「既に同じつながりがあります」と言う判定は **この 1 本**(§7)── 2 本あると、
 * 片方だけ直って「言ったのに足された / 言わないのに捨てられた」になる。
 */
export function hasSameRelation(
  relations: readonly Relation[],
  fromLid: string,
  toLid: string,
  kind: string,
): boolean {
  // 🔴 向きに意味が無い種類(関連)は、逆向きも同じつながり(#1163 依頼 319)
  const flip = DIRECTIONLESS_KINDS.includes(kind);
  return relations.some(
    (r) =>
      r.kind === kind &&
      ((r.fromLid === fromLid && r.toLid === toLid) || (flip && r.fromLid === toLid && r.toLid === fromLid)),
  );
}

/** 向きだけが逆の同じ種類が在るか(向きに意味が無い種類で、断りの字を分けるのに使う。#1163 依頼 319)。 */
export function hasReverseOnlyRelation(
  relations: readonly Relation[],
  fromLid: string,
  toLid: string,
  kind: string,
): boolean {
  return (
    DIRECTIONLESS_KINDS.includes(kind) &&
    !relations.some((r) => r.kind === kind && r.fromLid === fromLid && r.toLid === toLid) &&
    relations.some((r) => r.kind === kind && r.fromLid === toLid && r.toLid === fromLid)
  );
}

/** 同じ id は後着で上書きして合流(二重復元で関係が 2 本にならない)。 */
export function mergeRelations(
  current: readonly Relation[],
  incoming: readonly Relation[],
): readonly Relation[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((r) => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()];
}

/**
 * 🔴 **消した後の後継を、左の列に「いま見えている行」から選ぶ**(#1087)。
 *
 * ⚠ 直す前は手で並べた順(`state.order`)の全体から選んでいたので、現在のフォルダや並び順(題名順など)と
 *   無関係なノートが中央に開いた。規則は描く側と同じ `filerRows` + `filerRowOptions` 1 本。
 * 🔑 消す位置の次の行(居なければ手前の最後)。消す物は `gone` で除く。
 * ⚠ 開いているノートが見えている行に居ない / 残りが 0 件のときは `undefined` ── 呼び側は従来の選び方へ倒す
 *   (見えている物が無くても、中央を空にしない)。reducer なので state だけから導く。
 */
export function successorInShownRows(
  state: AppState,
  selected: string,
  gone: ReadonlySet<string>,
): string | undefined {
  const rows = filerRows(state.scopeLid, state.entryMetas, state.relations, filerRowOptions(state)).map(
    (m) => m.lid,
  );
  const vIdx = rows.indexOf(selected);
  if (vIdx < 0) return undefined;
  const kept = rows.filter((l) => !gone.has(l));
  if (kept.length === 0) return undefined;
  const pos = rows.slice(0, vIdx).filter((l) => !gone.has(l)).length;
  return kept[Math.min(pos, kept.length - 1)];
}

export function removeEntryFromState(
  state: AppState,
  lid: string,
  extraEvents: DomainEvent[],
  // 🔴 `false` のとき後継を選ばない(選んでいた物なら `selectedLid` は null になる)── まとめて消す側が最後に 1 回選ぶ(#1087)
  opts: { pickSuccessor: boolean } = { pickSuccessor: true },
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
  if (state.selectedLid === lid && !opts.pickSuccessor) {
    selectedLid = null;
  } else if (state.selectedLid === lid) {
    // 🔴 後継は「**見えている中**」から選ぶ(review M-1)。初版は絞り込み前の
    // `state.order` から取っていたので、絞り込み中に削除を続けると
    // **一覧に出ていない entry** が次々に選ばれて消えていった(実証済み)。
    // ⚠ 規則は `visibleOrder` に 1 本化 ── 一覧と後継が別々の答えを出さない
    // ⚠ **本文の当たりも渡す**(2026-08-15)── 渡さないと、本文だけが当たっている
    //    ノートを消したとき `indexOf` が -1 になり、選択が黙って null へ飛ぶ
    // ⚠ **種類の絞りも渡す**(#411)── 渡さないと、添付だけを出しているときに
    //    ノートを消すと**画面に出ていないノート**が次に選ばれる(同じ事故の軸違い)
    // 🔴 まず左の列に出ている行から選ぶ(#1087)。居なければ従来どおり(下)
    const shown = successorInShownRows(state, lid, new Set([lid]));
    if (shown !== undefined) {
      selectedLid = shown;
    } else {
      const before = visibleOrder(
        state.order,
        (l) => state.entryMetas.get(l),
        entryFilterOf(state.filterQuery, state.searchHits, state.kindFilter),
      );
      const vIdx = before.indexOf(lid);
      const after = before.filter((l) => l !== lid);
      // ⚠ 絞り込みで残りが居なくなったら **null**(見えないものを選ばない)
      selectedLid = vIdx < 0 ? null : (after[Math.min(vIdx, after.length - 1)] ?? null);
    }
    if (selectedLid) events.push({ type: 'REQUEST_BODY', lid: selectedLid });
  }
  // ⚠ 変化が無ければ**元の参照**のまま(下の docstring)
  const taskCards = state.taskScan === null ? null : withoutLid(state.taskScan.cards, lid);
  const noteTimesLeft = state.taskScan?.noteTimes?.filter((n) => n.lid !== lid);
  const scanTask =
    state.taskScan === null ||
    (taskCards === state.taskScan.cards &&
      (noteTimesLeft === undefined || noteTimesLeft.length === (state.taskScan.noteTimes?.length ?? 0)))
      ? state.taskScan
      : { ...state.taskScan, cards: taskCards!, ...(noteTimesLeft === undefined ? {} : { noteTimes: noteTimesLeft }) };
  const contactCards = state.contactScan === null ? null : withoutLid(state.contactScan.cards, lid);
  const scanContact =
    state.contactScan === null || contactCards === state.contactScan.cards
      ? state.contactScan
      : { ...state.contactScan, cards: contactCards! };
  const workRuns = state.workLogScan === null ? null : withoutLid(state.workLogScan.runs, lid);
  const scanWorkLog =
    state.workLogScan === null || workRuns === state.workLogScan.runs
      ? state.workLogScan
      : { ...state.workLogScan, runs: workRuns! };
  const snippetItems = state.snippetScan === null ? null : withoutLid(state.snippetScan.items, lid);
  const scanSnippet =
    state.snippetScan === null || snippetItems === state.snippetScan.items
      ? state.snippetScan
      : { ...state.snippetScan, items: snippetItems! };
  // 🔴 探す面の行・左の列の本文の当たりからも落とす(消したノートが「探す」に残り、押すと無いノートの窓が開いた)。
  //    変化が無ければ元の参照のまま
  const pageRows = state.searchPage.rows.some((r) => r.lid === lid)
    ? state.searchPage.rows.filter((r) => r.lid !== lid)
    : state.searchPage.rows;
  const searchPage =
    pageRows === state.searchPage.rows ? state.searchPage : { ...state.searchPage, rows: pageRows };
  let searchHits = state.searchHits;
  if (searchHits !== null && searchHits.has(lid)) {
    const h = new Set(searchHits);
    h.delete(lid);
    searchHits = h;
  }
  const smart = withoutSmartHit(state.smartHits, lid);
  events.push(...smart.rescans.map((l): DomainEvent => ({ type: 'REQUEST_SMART_SCAN', lid: l })));

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
      // ⚠ 打ち替え中の相手が消えたら、打つのもやめる(#215 ── 2 ペインの `renaming` と同じ)
      renamingLid: state.renamingLid === lid ? null : state.renamingLid,
      // ⚠ 消えたものを印に残さない(#240 段②)── まとめて削除が**居ないもの**を数える
      selection: state.selection.includes(lid)
        ? state.selection.filter((l) => l !== lid)
        : state.selection,
      selectionAnchor: state.selectionAnchor === lid ? null : state.selectionAnchor,
      // 削除で履歴・ゴミ箱の断面は古くなる ── 畳んで開き直しに任せる(P5b)
      revisionPanel: null,
      // ⚠ 見ていた版も畳む(#398 段②)── 一覧が畳まれたら差分は孤児になる
      revisionPreview: null,
      trashPanel: null,
      // ⚠ 元ファイルの紐づけも外す ── 消したノートに「書き戻す」を出したままだと、
      //    戻せなくなった器を指す導線が残る(復元したら開き直しで紐づく)
      linkedFiles: dropLink(state.linkedFiles, lid),
      /**
       * 🔴 **集めた一覧からも落とす**(#535 ②。実ブラウザの smoke が捕まえた)。
       *
       * ⚠ 直す前は **消したノートが「予定 / 連絡先 / 雛形」に残り続けて**いた ──
       *   これらは worker が集めた断面で、`entryMetas` から作り直していないため。
       *   snapshot を読み直す経路(`keepContacts`)には落とす処理が在ったのに、
       *   **1 件消す経路には無かった** ── 片側だけ在る非対称だった。
       * 🔑 **3 つとも同じ形**である(`cards` / `cards` / `items` が `lid` を持つ)。
       *   ⚠ 1 つだけ直すと、次に触る人が残り 2 つで同じ症状を踏む。
       * ⚠ **頼み直さない** ── worker を叩くと「別タブが書くたびに一覧が空へ飛ぶ」
       *   (`REFRESH_CONTACT_SCAN` が明記している症状)。消えた分だけ落とす。
       */
      taskScan: scanTask,
      contactScan: scanContact,
      workLogScan: scanWorkLog,
      snippetScan: scanSnippet,
      // 🔴 開いているスマートフォルダの当たり・件数からも落とす(#1087。下の `withoutSmartHit`)
      smartHits: smart.hits,
      searchPage,
      searchHits,
      /**
       * 🔴 **録ったものの一覧からも落とす**(#1087 の見直し 2026-10-13)── 上の 3 つと同じ形の穴だった。
       *   「音/動画」タブを開いたまま録音のノートを消すと、行が残り、名前を押しても何も起きなかった。
       */
      captureItems:
        state.captureItems === null ? null : (withoutLid(state.captureItems, lid) as CaptureItem[]),
      /**
       * 🔴 **消したノートを留めたままにしない**(#505 段②)。
       * ⚠ 残すと、その枠は**開けない lid** を指したまま空で居座る。
       * 🔑 #535 ② で `taskScan` 系に同じ穴が在ったのと**同じ形**である ──
       *   「1 件消す経路」に落とす処理を書き忘れる、が この repo の癖である。
       */
      splitLids: unpinSplitLid(state.splitLids, lid),
      splitBodies: dropSplitBody(state.splitBodies, lid),
      // 🔑 載せていた物を消したなら、降ろしたことを言う(#633 段① ── 効果層の自己修復と同じ字)
      ...(state.splitLids.includes(lid)
        ? { notice: goneFromStackNotice(state.entryMetas.get(lid)?.title) }
        : {}),
    },
    events,
  };
}

/**
 * 🔴 **消したノートを、開いているスマートフォルダの当たりと件数から落とす**(#1087)。
 *
 * ⚠ 直す前は `taskScan` / `contactScan` だけ落として `smartHits` を落としていなかった ── 帯の件数
 *   (`hit.total`)が消した後も古いまま残り、開き直すまで 1 件多く見えた。
 * 🔑 当たりに居たら外して `total` を 1 減らす。⚠ **上限で切られている**(`total > lids.length`)入れ物は、
 *   手元の一覧が全部ではない ── 消したものが一覧に居ない回は当たりだったか分からず、居た回も
 *   外した穴を埋める行が手元に無い。だから**集め直しを頼む**(`rescans`)。上限で切れていなければ手で足りる。
 * ⚠ 変化が無ければ**元の参照**のまま返す(`refreshSmartHits` と同じ作法)。
 */
function withoutSmartHit(
  smartHits: ReadonlyMap<string, SmartHitState>,
  lid: string,
): { hits: ReadonlyMap<string, SmartHitState>; rescans: string[] } {
  let next: Map<string, SmartHitState> | null = null;
  const rescans: string[] = [];
  for (const [smartLid, hit] of smartHits) {
    if (hit.failed) continue;
    const at = hit.lids.indexOf(lid);
    const capped = hit.total > hit.lids.length;
    if (at >= 0) {
      const lids = [...hit.lids.slice(0, at), ...hit.lids.slice(at + 1)];
      next ??= new Map(smartHits);
      next.set(smartLid, { ...hit, lids, total: Math.max(0, hit.total - 1) });
    }
    if (capped) rescans.push(smartLid);
  }
  return { hits: next ?? smartHits, rescans };
}

/**
 * 再読込を跨いで残す紐づけ。別 container なら**全部捨てる**(lid の偶然衝突で
 * 他人のノートに「書き戻す」を出さない ── 選択の持ち越しと同じ判断)。
 */
export function keepLinks(
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

/**
 * 🔴 **書込・取込の後に撃ち直す検索**(#1087)。左の絞り込みの語(`filterQuery`)と、探す画面の語
 * (`searchPage.query`)の 2 つが在る。⚠ 判定はここ 1 か所(`SET_ENTRY_FILTER` と同じ条件:
 * 語が空 / `>` で始まる欄は撃たない)。前の当たりは消さない ── 返るまで一覧がちらつかない。
 */
export function searchRefreshEvents(
  state: AppState,
): Array<{ type: 'REQUEST_SEARCH'; query: string; again?: true } | { type: 'REQUEST_SEARCH_DETAIL'; query: string }> {
  const out: Array<{ type: 'REQUEST_SEARCH'; query: string; again?: true } | { type: 'REQUEST_SEARCH_DETAIL'; query: string }> = [];
  if (normalizeQuery(state.filterQuery) !== '' && commandQueryOf(state.filterQuery) === null)
    out.push({ type: 'REQUEST_SEARCH', query: state.filterQuery, again: true });
  if (state.searchPage.query.trim() !== '')
    out.push({ type: 'REQUEST_SEARCH_DETAIL', query: state.searchPage.query });
  return out;
}

/**
 * 🔴 **消えたノートの連絡先を落とす**(#278 段③ の動線レビュー 2026-08-28)。
 *
 * ⚠ **丸ごと `null` にしない** ── `SYS_BOOTED` は別タブが書くたびに飛ぶので、
 *   捨てると一覧が「集めています…」へ落ちて**行が飛ぶ**
 *   (`REFRESH_CONTACT_SCAN` が「消さない」と書いている理由と同じ)。
 * ⚠ 別 container(`cid` 違い)なら全部捨てる ── lid の偶然衝突を持ち越さない。
 * ⚠ 変化が無いなら**同じ参照**を返す(描画の指紋を無駄に壊さない ── `keepLinks` と同じ作法)。
 */
export function keepContacts(
  state: AppState,
  sameCid: boolean,
  metas: ReadonlyMap<string, EntryMeta>,
): ContactScan | null {
  const scan = state.contactScan;
  if (scan === null) return null;
  if (!sameCid) return null;
  const cards = scan.cards.filter((c) => metas.has(c.lid));
  return cards.length === scan.cards.length ? scan : { ...scan, cards };
}

/**
 * 🔴 **消えたノートの計った時間を落とす**(#683 ①。`keepContacts` と同じ作法)。
 * ⚠ 別 container なら全部捨てる / 変化が無いなら同じ参照を返す。
 */
export function keepWorkLog(
  state: AppState,
  sameCid: boolean,
  metas: ReadonlyMap<string, EntryMeta>,
): WorkLogScan | null {
  const scan = state.workLogScan;
  if (scan === null) return null;
  if (!sameCid) return null;
  const runs = scan.runs.filter((r) => metas.has(r.lid));
  return runs.length === scan.runs.length ? scan : { ...scan, runs };
}

/**
 * 🔴 **消えたノートの予定の札を落とす**(#1087。`keepContacts` と同じ作法)。
 * ⚠ 別 container なら全部捨てる ── lid の偶然衝突を持ち越さない。
 * ⚠ 変化が無いなら**同じ参照**を返す(描画の指紋を無駄に壊さない)。
 */
export function keepTasks(
  state: AppState,
  sameCid: boolean,
  metas: ReadonlyMap<string, EntryMeta>,
): TaskScan | null {
  const scan = state.taskScan;
  if (scan === null) return null;
  if (!sameCid) return null;
  const cards = scan.cards.filter((c) => metas.has(c.lid));
  const noteTimes = scan.noteTimes?.filter((n) => metas.has(n.lid));
  const sameTimes = noteTimes === undefined || noteTimes.length === (scan.noteTimes?.length ?? 0);
  return cards.length === scan.cards.length && sameTimes
    ? scan
    : { ...scan, cards, ...(noteTimes === undefined ? {} : { noteTimes }) };
}

/**
 * 🔴 **消えたノートの録ったものを落とす**(#683 段①。`keepContacts` と同じ作法)。
 * ⚠ 別 container なら全部捨てる ── lid の偶然衝突を持ち越さない。
 * ⚠ 変化が無いなら**同じ参照**を返す(描画の指紋を無駄に壊さない)。
 */
export function keepCaptures(
  state: AppState,
  sameCid: boolean,
  metas: ReadonlyMap<string, EntryMeta>,
): CaptureItem[] | null {
  const items = state.captureItems;
  if (items === null) return null;
  if (!sameCid) return null;
  const left = items.filter((i) => metas.has(i.lid));
  return left.length === items.length ? items : left;
}

/**
 * 🔴 **消えた lid を、集めた一覧から落とす**(#535 ②、2026-08-29)。
 *
 * ⚠ **変化が無ければ同じ配列を返す** ── 描画の指紋を無駄に壊さない
 * (`keepLinks` / `keepContacts` と同じ作法)。
 */
/**
 * 留めた枠の本文を 1 件落とす。⚠ **居なければ同じ Map を返す**(指紋を動かさない)。
 */
/**
 * 🔴 **その lid の本文が、いま画面のどこに出ているか**(#281 検算 2026-08-30)。
 *
 * 画面に本文が出る器は 2 つある ── **主の枠**(`openBody`。編集しうる 1 件)と
 * **横に留めた枠**(`splitBodies`。映すだけの N 件)。⚠ どちらか一方しか見ない
 * 判定を書くと、もう一方の枠の操作が**黙って別のノートへ落ちる**。
 *
 * @returns 出ていなければ `null`(呼び側は**書かずに返す** ── 画面に無い物の
 *   行番号を信じて書くと、当てずっぽうで別の所を消す)。
 */
export function screenBodyOf(state: AppState, lid: string): string | null {
  if (state.openBody && state.openBody.lid === lid) return state.openBody.body;
  return state.splitBodies.get(lid) ?? null;
}

/**
 * 🔴 閉じていない付箋・線は消せない ── 押した時点で言う断り(#1087)。
 * ⚠ 言わないと「本文が変わっているため反映できませんでした(開き直してください)」と出て、**開き直しても直らない**。
 */
export const PLACE_REMOVE_OPEN_REFUSAL =
  'この付箋のブロックが閉じていないため、消せません(ブロックを閉じてから消してください)';
export const PLACE_LINE_REMOVE_OPEN_REFUSAL =
  'この線のブロックが閉じていないため、消せません(ブロックを閉じてから消してください)';
/** 末尾が閉じていないブロックの中へは線を足せない ── 押した時点で言う断り(#1087。`ADD_PLACE` と同じ作法)。 */
export const PLACE_CONNECT_OPEN_REFUSAL =
  '本文の最後のブロックが閉じていないため、線でつなげません(ブロックを閉じてからつないでください)';

/**
 * 末尾が閉じていないコードブロック・囲いの中へは、ノートの末尾に足せない ── 押した時点で言う断り。
 * ⚠ 言わずに足すと、足した行がコードの字になって画面に出ない(「書きました」と言いながら見えない)。
 */
export const APPEND_OPEN_BLOCK_REFUSAL =
  'ノートの末尾が閉じていないコードブロックやブロック(:::)の中なので、末尾に足せませんでした。ブロックを閉じてから足してください';

/**
 * 足す文そのものが、閉じていないブロックで終わっている ── 足すと、以後このノートの末尾へ足せなくなる。
 * ⚠ 本文は閉じているのに、足した後で開いたままになる回の断り(上の `APPEND_OPEN_BLOCK_REFUSAL` は本文が先に開いている回)。
 */
export const APPEND_TEXT_OPEN_BLOCK_REFUSAL =
  '足す文の中に閉じていないコードブロックやブロック(:::)があります。閉じてから足してください';

/** 末尾が閉じていないブロックの中へは板を置けない ── 押した時点で言う断り(#529)。 */
export const PLACE_OPEN_BLOCK_REFUSAL =
  '本文の最後のブロックが閉じていないため、付箋を置けません(ブロックを閉じてから置いてください)';

/**
 * 🔴 **書換が通る見込みのときだけ、閉じていないブロックの理由を言う**(#1087。`ADD_PLACE` の門と同じ形)。
 *
 * ⚠ 書込側(`place-notation.ts`)も同じ条件で断るが、出る字は「本文が変わっているため…(開き直してください)」で、
 *   **開き直しても直らない**。だから押した時点で本当の理由を言う。判定は書込側と**同じ関数**を渡す(§7)。
 * ⚠ `gated.events` が空(編集中の断り・行が板でない)のときは**そちらの理由を残す**。
 */
export function openBlockRefused(
  state: AppState,
  lid: string,
  refusal: string,
  unclosed: (shown: string) => boolean,
  gated: ReduceResult,
): ReduceResult {
  if (gated.events.length === 0) return gated;
  const shown = screenBodyOf(state, lid);
  if (shown !== null && unclosed(shown)) return { state: { ...state, error: refusal }, events: [] };
  return gated;
}

/**
 * 🔴 **画面の本文から組む書換が共通で通る門**(#283 P4-b → #676 → #684)。
 *
 * 板の 5 つ(動かす / 大きさ / 消す / 置く / 前へ)と、本文の塊の並べ替え・差し込みが通る。
 * ⚠ #684 で `placeRewrite` から改名した ── 板向きの名前のまま本文の塊が通ると、
 *   次に読む人が「板の門」と読んで別の門を書き足す(§7)。
 * ⚠ 編集中は**声に出して断る** ── 判定はここ 1 か所(`SET_VIEW_MODE` と同じ作法。
 *   呼び側(掴む口・メニュー)に配ると、口を足すたびに取りこぼす ── #516 の向き)。
 * 🔴 **画面に出ている本文は 1 つではない**(#281 検算 2026-08-30)。
 * ⚠ 1 稿目は `openBody` だけを見ていたので、**横に留めた枠**の付箋は
 *   ①主の枠が板でなければ黙って no-op ②主の枠も板なら**別のノートの
 *   同じ行を書き換えうる**、の 2 つに落ちていた。
 * 🔑 `screenBodyOf` が「その lid が、いま画面のどこに出ているか」を 1 か所で答える。
 * 🔴 **前置きは `phaseBlockReason` の 1 か所から**(C11b / #1045)。⚠ 直す前は
 *   呼び側 9 か所が「編集を保存するか、編集をやめてから」を手で書いており、`error` の相
 *   (保存に失敗して止まった)でも同じ字を出していた ── 押せない出口を案内していた
 *   (C11 / #516 と同じ形)。この門が既に `phase !== 'ready'` を見ているので、
 *   前置きもここで付け、呼び側は「続き」だけを渡す。
 * 🔴 **前置きは lid でも判定する**(C6 / #1043)。⚠ 直す前は `phase` だけを見ており、
 *   **編集中は板も本文の塊も全ノートぶん止まって**いた ── 横に留めた枠の板を
 *   動かそうとしても、編集中のノートと無関係に断られていた。
 *   `bodyWriteBlockReason` が「編集中のノート自身か」まで見る。
 *
 * @param refusalSuffix 編集中の断り文の**続き**(前置きは `bodyWriteBlockReason` が付ける。
 *   押した場所と対で書く)
 * @param build 画面が見ている本文から書換を組む。組めなければ `null` = 黙って no-op
 *   (行が板でない / 値が壊れている ── どれも画面の操作からは起きない形)。
 *   🔴 **`shown` は `null` のことがある**(#684 段④、2026-09-08)── 画面に本文が
 *   出ていない、という意味である。⚠ **行番号を `shown` から採る書換は必ず断る**
 *   (画面に無い物の座標を信じて書くと、当てずっぽうで別の所を消す)。
 *   🔑 ただし**`shown` を 1 バイトも読まない書換**(座標も字も呼び側が持っている)は
 *   通してよい ── `insert-lines` は落とした所を**落とした時の本文**で決めており、
 *   そこで画面を要求すると経路が**一度も通らない**:添付は取り込むときに
 *   `CREATE_ENTRY` が選択を移し、`SELECT_ENTRY` で戻す時に旧 `openBody` が捨てられる。
 *   ⚠ ここを 1 か所に寄せず各 `build` に持たせるのは、**新しい case が黙って
 *   `null` を素通りしない**ようにするためである(既定で通すと取り違えが静かに出る)。
 */
export function bodyRewriteGate(
  state: AppState,
  lid: string,
  refusalSuffix: string,
  build: (shown: string | null) => BodyRewrite | null,
): ReduceResult {
  // ⚠ 断りは lid で判定する(C6 / #1043)── 編集中のノート自身のときだけ断る。
  //   別の lid(横に留めた枠の板・本文の塊)は editing 中でもここを通す。
  const blocked = bodyWriteBlockReason(state, lid);
  if (blocked !== null)
    return {
      state: { ...state, error: blockedWithSuffix(blocked, refusalSuffix) },
      events: [],
    };
  const meta = state.entryMetas.get(lid);
  if (!meta) return { state, events: [] };
  const rewrite = build(screenBodyOf(state, lid));
  if (rewrite === null) return { state, events: [] };
  return {
    state,
    events: [
      {
        type: 'REQUEST_BODY_REWRITE',
        lid: meta.lid,
        title: meta.title,
        archetype: meta.archetype,
        entryOrder: meta.entryOrder,
        rewrite,
      },
    ],
  };
}

/**
 * 🔑 開き行は**この場で**捕捉する(描画が焼いた行番号 → 画面が見ている本文の字)。
 * disk 側とずれていれば `place-notation.ts` が byte 一致で断る。板の開き行でなければ `null`。
 */
export function placeOpenLineOf(shown: string, line: number): string | null {
  if (!Number.isInteger(line) || line < 0) return null;
  const openLine = shown.split('\n')[line];
  return openLine !== undefined && isPlaceOpen(openLine) ? openLine : null;
}

/** `placeOpenLineOf` の線版 ── その行が線の開き行のときだけ、その字そのもの。 */
export function lineOpenLineOf(shown: string, line: number): string | null {
  if (!Number.isInteger(line) || line < 0) return null;
  const openLine = shown.split('\n')[line];
  return openLine !== undefined && isLineOpen(openLine) ? openLine : null;
}

/** 板の座標・大きさの値 ── 整数で 0 以上だけ(描画も負の値は捨てる)。 */
export function isPlaceCoord(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/**
 * 🔴 **保存したスタックの本文を、いまのスタックの上に積む**(#633 段③)。
 *
 * ⚠ **先頭が一番上**なので、本文を**下から順に** `pinSplitLid` する ── 上から積むと
 *   並びが裏返る(本文の 1 行目が一番下に来る)。
 * ⚠ 消えたノートの行は残っている(参照のみ)── 載せられない件数を**数えて言う**。
 *   上限(`STACK_MAX`)で入らなかった件数も別に言う(黙って落とさない)。
 * 🔑 載せた後の本文の読みは `REQUEST_SPLIT_BODY`(帯の札と同じ 1 本)── まだ持っていない物だけ。
 */
/** スタックに載せられるノートか ── フォルダは本文が無いので載せない。載せる口は全部この 1 本を通る。 */
export function canStack(meta: { readonly archetype: string }): boolean {
  return meta.archetype !== 'folder';
}

export function loadStackFromBody(state: AppState, body: string): ReduceResult {
  const wanted = stackLids(body);
  const exist = wanted.filter((l) => state.entryMetas.has(l));
  /**
   * 🔴 **フォルダは載せない**(#1087)── 本文が無く、載せると枠が永久に空になる。右クリックで 1 件載せる口
   *   (`PIN_SPLIT_ENTRY`)と**同じ門**(`canStack`)を通す。
   * ⚠ 載せられない件数は、消えた物(「見つかりません」)とは**別に数えて**言う。
   */
  const present = exist.filter((l) => canStack(state.entryMetas.get(l)!));
  const folders = exist.length - present.length;
  const missing = wanted.length - exist.length;
  let lids = state.splitLids;
  for (let i = present.length - 1; i >= 0; i -= 1) lids = pinSplitLid(lids, present[i]!);
  const added = lids.filter((l) => !state.splitLids.includes(l));
  const refused = present.filter((l) => !lids.includes(l)).length;
  const parts: string[] = [];
  if (present.length === 0) parts.push('載せられるノートがありません');
  else parts.push(`${String(present.length - refused)} 件を載せました`);
  if (missing > 0) parts.push(`${String(missing)} 件は見つかりません`);
  if (folders > 0) parts.push(`${String(folders)} 件はフォルダなので載せられません`);
  if (refused > 0) parts.push(`上限 ${String(STACK_MAX)} 件で ${String(refused)} 件は載せられませんでした`);
  const notice = parts.length === 1 ? parts[0]! : `${parts[0]!}(${parts.slice(1).join(' / ')})`;
  return {
    state: { ...state, splitLids: lids, notice },
    events: added
      .filter((l) => !state.splitBodies.has(l))
      .map((l) => ({ type: 'REQUEST_SPLIT_BODY', lid: l })),
  };
}

/**
 * 🔴 **消えたノートをスタックから降ろしたときの 1 行**(#633 段①)── 字はここ 1 か所。
 * ⚠ 呼び手は 2 つ(削除 / 効果層の本文 null)── 別々に書くと片方だけ直る(§7)。
 */
export function goneFromStackNotice(title: string | undefined): string {
  return `「${title ?? '消えたノート'}」は消えたのでスタックから降ろしました`;
}

export function dropSplitBody(
  bodies: ReadonlyMap<string, string>,
  lid: string,
): ReadonlyMap<string, string> {
  if (!bodies.has(lid)) return bodies;
  const next = new Map(bodies);
  next.delete(lid);
  return next;
}

/**
 * 🔴 **留めた枠の本文を、書込に追随させる**(#505 段②)。
 *
 * ⚠ これが無いと、**同じノートを主の枠で直しても留めた枠は古いまま**になる
 * (user から見れば「片方だけ直った」)。⚠ 留めていない lid では**何もしない** ──
 * 触っていない Map を作り直すと、面が毎回組み直る。
 */
function syncSplitBody(state: AppState, lid: string, body: string): ReadonlyMap<string, string> {
  if (!state.splitLids.includes(lid)) return state.splitBodies;
  if (state.splitBodies.get(lid) === body) return state.splitBodies;
  const next = new Map(state.splitBodies);
  next.set(lid, body);
  return next;
}

/** 手組みの fixture には `placeBodies` が無い ── 読む口は 1 本(`?? ` を散らさない)。 */
const NO_PLACE_BODIES: ReadonlyMap<string, PlaceExcerpt> = new Map<string, PlaceExcerpt>();
export function placeBodiesOf(state: AppState): ReadonlyMap<string, PlaceExcerpt> {
  return state.placeBodies ?? NO_PLACE_BODIES;
}

/**
 * 板のための本文を 1 件入れる。⚠ **入れ直した物を「いちばん新しい」へ**(Map は挿入順)し、
 * 上限(`PLACE_BODY_CAP`)を超えたら**いちばん古い物から**手放す。
 *
 * 🔴 **ただし、いま画面に出ている板が置いているノートの分は手放さない**(`onScreen`)。
 * ⚠ 手放す相手を「古い順」だけで決めると、板を 2 つ並べた(主の枠 + 横に留めた枠)とき、
 *   **片方の板の読み込みがもう片方の抜粋を手放し、手放された側が頼み直し、今度は相手が手放される**
 *   ── 静まらない(150 枠 + 150 枠で 30 周 = 3,300 件を読み続けた)。
 * 🔑 手放さないのは「いま要る物」だけなので、**上限は「要る物より多いときだけ」効く**
 *   (板を離れれば、その板の分は次の読み込みから古い順で手放せる)。
 *   ⚠ 1 つの板が頼める数は `PLACE_BODIES_WANTED` が `PLACE_BODY_CAP` で切る(上限を超える板は先頭から)。
 * ⚠ `onScreen` は**超えたときだけ**呼ぶ(板の本文を数える ── 毎回は数えない)。
 */
export function withPlaceBody(
  bodies: ReadonlyMap<string, PlaceExcerpt>,
  lid: string,
  excerpt: PlaceExcerpt,
  onScreen: () => ReadonlySet<string>,
): ReadonlyMap<string, PlaceExcerpt> {
  const next = new Map(bodies);
  next.delete(lid);
  next.set(lid, excerpt);
  if (next.size <= PLACE_BODY_CAP) return next;
  const keep = onScreen();
  for (const old of [...next.keys()]) {
    if (next.size <= PLACE_BODY_CAP) break;
    // ⚠ 入れたばかりの物は、画面に出ている板が置いていなくても残す(手放すのは古い物)
    if (old === lid || keep.has(old)) continue;
    next.delete(old);
  }
  return next;
}

/**
 * いま画面に出ている板(主の枠 / 横に留めた枠 ── `screenBodyOf` と同じ 2 つの入れ物)が置いている lid。
 * ⚠ 板の置き先は本文の `entry=` が正本 ── 板が描くときに頼む lid(`PlaceEmbeds`)と同じ読み方。
 */
export function placeLidsOnScreen(state: AppState): ReadonlySet<string> {
  const out = new Set<string>();
  if (state.openBody) for (const l of placeEntryLids(state.openBody.body)) out.add(l);
  for (const body of state.splitBodies.values()) for (const l of placeEntryLids(body)) out.add(l);
  // 🔴 見出しの節の埋め込み(#1459 ①)が要る抜粋も手放さない(鍵は `<lid>#h/<印>`)
  if (state.openBody) for (const k of sectionEmbedKeys(state.openBody.body)) out.add(k);
  for (const body of state.splitBodies.values()) for (const k of sectionEmbedKeys(body)) out.add(k);
  return out;
}

/**
 * 🔴 **画面に出ている本文を、書込に追随させる 2 つの入れ物**(#529 W3-①)。
 *
 * 横に留めた枠(`splitBodies`)と、板に置いたノートの抜粋(`placeBodies`)は、
 * **同じ書込の口**(`BODY_REWRITTEN` / `BODY_PERSISTED` / `REMOTE_BODY_CHANGED` / 追記 / 保存 …)
 * で追随させる ── 口を 2 本に分けると、片方だけ古いまま映す(#757 / #684 ㋑ で 2 度踏んだ形)。
 * ⚠ 持っていない lid では**何もしない**(触っていない Map を作り直すと、面が毎回組み直る)。
 * ⚠ 板のほうは**切った抜粋を入れ直す**(全文を持たない)。
 */
export function syncShownBodies(
  state: AppState,
  lid: string,
  body: string,
): {
  splitBodies: ReadonlyMap<string, string>;
  placeBodies: ReadonlyMap<string, PlaceExcerpt>;
  /** 🔴 2 ペインの下見(#1087)。⚠ **変わるときだけ**入れる ── 無いキーは spread で他の枝の `dual` を踏まない。 */
  dual?: DualState;
} {
  const splitBodies = syncSplitBody(state, lid, body);
  // 🔴 **2 ペインの下見も同じ書込で追随させる**(#1087)。⚠ 下見は読み込み時に切る(`clipPreview`)ので
  //    ここでも同じ切り方にする ── 長い本文を常駐させない。いま指している行のときだけ。
  const pv = state.dual.preview;
  const dualNext: DualState | undefined =
    state.dual.previewOn && pv !== null && pv.lid === lid && pv.body !== clipPreview(body)
      ? { ...state.dual, preview: { lid, body: clipPreview(body) } }
      : undefined;
  const have = placeBodiesOf(state);
  let bodies: Map<string, PlaceExcerpt> | null = null;
  const prev = have.get(lid);
  if (prev !== undefined) {
    const next = excerptOf(body, state.entryMetas.get(lid)?.archetype);
    if (!sameExcerpt(prev, next)) {
      bodies = new Map(have);
      bodies.set(lid, next); // ⚠ 並びは動かさない(書き込みは「最近読んだ」ではない)
    }
  }
  // 🔴 このノートの見出しの節(#1459 ①。鍵は `<lid>#h/<印>`)も**同じ書込で**追随させる ──
  //    別の口にすると、板だけ新しく節だけ古い、が起きる
  for (const [key, old] of have) {
    const sec = parseSectionKey(key);
    if (sec === null || sec.lid !== lid) continue;
    const next = sectionExcerptOf(body, sec.id);
    if (sameExcerpt(old, next)) continue;
    bodies ??= new Map(have);
    bodies.set(key, next);
  }
  return {
    splitBodies,
    placeBodies: bodies ?? state.placeBodies,
    ...(dualNext === undefined ? {} : { dual: dualNext }),
  };
}

/** `syncShownBodies` の答えが、いまの state と同じか(同じなら state を差し替えない)。 */
export function sameShownBodies(
  state: AppState,
  shown: ReturnType<typeof syncShownBodies>,
): boolean {
  return (
    shown.splitBodies === state.splitBodies &&
    shown.placeBodies === state.placeBodies &&
    shown.dual === undefined
  );
}

function withoutLid<T extends { readonly lid: string }>(
  items: readonly T[],
  lid: string,
): readonly T[] {
  return items.some((i) => i.lid === lid) ? items.filter((i) => i.lid !== lid) : items;
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
/**
 * 🔴 **板の札を、新しい本文から組み直す**(#277 段②-b。2026-08-19 のレビューで判明)。
 *
 * 札は**原文の行番号**を指すので、本文が変われば**指す先がずれる**。
 * ⚠ 直す前は書換の ack(`BODY_REWRITTEN`)でしか組み直しておらず、
 *   **普通の保存(`COMMIT_EDIT`)では古い行番号のまま**だった ── 板を開いて
 *   閉じ、本文の先頭に 1 行足して保存し、板へ戻ると、札は開き直しの走査が
 *   返るまで**古い行**を指したまま押せる。押すと**別の行が黙って完了になる**。
 * 🔑 だから「新しい本文が state に入る所」は**全部ここを通す**(§7)。
 * ⚠ **数え間違えた**(2026-08-20 に訂正)── ここには「`buildPersist` と
 *   `BODY_REWRITTEN` の **2 か所だけ**」と書いてあったが、実際は **6 か所**あった
 *   (`ENTRY_APPENDED` / `ENTRY_RESTORED` / `BODY_LOADED` /
 *   `ENTRY_BODY_REFRESHED` が漏れ、`UPDATE_OPEN_BODY` だけが除外に値した)。
 *   宣言が在るぶん次に読む人は疑わないので、数の誤りは
 *   「その経路は考えなくてよい」という誤った安心を配る。
 * 🔑 **手で数え直して見つけたのではない** ── 機械に全数走査させたら出てきた。
 *   「数えた数だけ通す」と書くなら、**数える所も機械にする**。
 * 🔑 いまは **`tests/repo-hygiene.test.ts` が reducer を全数走査して数える** ──
 *   `openBody` に新しい本文を入れる case を足した人は、通し忘れるとその場で落ちる。
 * ⚠ 板を一度も開いていなければ `null` のまま何もしない。
 */
/**
 * 🔴 **タグを付けたら、開いているスマートフォルダにその場で落ちる**
 * (user 要望 2026-08-26「文書側でタグつけしたら勝手にフォルダに落ちるもやってください」)。
 *
 * ⚠ 直す前は、集め直しが走るのは **①入れ物へ入ったとき ②落としたとき
 *   ③条件を変えたとき**の 3 つだけだった ── **情報ペインでタグを付けても、
 *   本文の frontmatter に `tags:` を書いて保存しても、開いている入れ物は
 *   古い並びのまま**である(user から見ると「付けたのに出てこない」)。
 *
 * 🔑 **worker に頼み直さない。** ここには**新しい本文**が在るので、
 *   「この 1 件が当たるか」は**その場で**決まる ── 板の札を組み直す
 *   `refreshTaskCards` と同じ形である。往復しないので**押した手応えが消えない**し、
 *   まとめて 100 件にタグを付けても全件走査は 1 度も走らない。
 * 🔑 当てる規則は `matchesSmart` **1 本**(§7)── worker と同じ関数を通る。
 *   ここに独自の判定を書くと、開いている間と開き直した後で並びが変わる。
 *
 * ⚠ **触らない場合が 3 つある**(どれも「手で継ぎ足すと嘘になる」形):
 *   ① **その入れ物自身**の本文が変わった(自分は集めない ── 条件のほうが
 *      変わったのなら `COMMIT_EDIT` が集め直しを頼む)
 *   ② **集められない版**(`failed`)── 触ると「集まったふり」になる
 *   ③ **上限で切れている**一覧(`total > lids.length`)── 1 件外しても
 *      **次の 1 件が分からない**ので、数と中身が食い違う。次に開くまで待つ
 *
 * ⚠ 並べる順は **worker と同じ**(`entry_order`、同値なら lid)── 揃えないと、
 *   付けた瞬間だけ末尾に出て、開き直すと別の場所へ跳ぶ。
 */
export function refreshSmartHits(
  smartHits: ReadonlyMap<string, SmartHitState>,
  lid: string,
  body: string,
  entryMetas: ReadonlyMap<string, EntryMeta>,
): ReadonlyMap<string, SmartHitState> {
  /**
   * ⚠ **「1 つも開いていないなら即返す」を書かない**(変異試験 T7 が教えた)──
   *   下の `next ?? smartHits` が**同じ参照を返す**ので、外しても結果は変わらない。
   *   同じ答えを出す口を 2 つ置くと、片方を壊しても鳴らなくなる(§7)。
   */
  /**
   * 🔴 **文書タグ + 本文中タグ**(#550 段②)。⚠ `readTags` を直に呼ぶと、
   *   worker の走査(`tagsForMatch`)と**規則が 2 つ**になる ── 保存直後だけ
   *   本文中タグが当たらず、集め直すと当たる、という一番気づけない食い違いになる。
   * 🔑 両方とも `foldTags` の上に建っており、`tests/features/entry-tags.test.ts` の
   *   parity test が「同じ答えを返すこと」を機械的に見ている。
   */
  const tags = collectEntryTags(body).all;
  const orderOf = (l: string): number =>
    entryMetas.get(l)?.entryOrder ?? Number.MAX_SAFE_INTEGER;
  let next: Map<string, SmartHitState> | null = null;
  for (const [smartLid, hit] of smartHits) {
    if (smartLid === lid) continue;
    if (hit.failed) continue;
    if (hit.total > hit.lids.length) continue;
    /**
     * 🔴 **その場で当て直せない条件を持つ入れ物は、手で継ぎ足さない**(#421 段②③)。
     * ⚠ 「更新が N 日以内」は**保存した瞬間に変わる**し、`archetype` /
     *   `created_at` / `date` も本文からは決まらない ── ここで当てると嘘になる。
     * ⚠ **語の条件も同じ**(段③)── 当てるのは FTS5 / LIKE = **SQL 1 か所**なので、
     *   ここで `body.includes(語)` と書くと帯の並びと探す欄の結果が食い違う(§7)。
     * 🔑 そちらは effect が worker へ**集め直しを頼む**(`smartRescanFor`)。
     */
    if (needsRescan(hit.spec)) continue;
    const at = hit.lids.indexOf(lid);
    const should = matchesSmartTags(hit.spec, tags);
    if (should === (at >= 0)) continue;
    let lids: string[];
    if (should) {
      const o = orderOf(lid);
      const i = hit.lids.findIndex((x) => {
        const xo = orderOf(x);
        return xo > o || (xo === o && x > lid);
      });
      lids = [...hit.lids];
      lids.splice(i < 0 ? lids.length : i, 0, lid);
    } else {
      lids = [...hit.lids.slice(0, at), ...hit.lids.slice(at + 1)];
    }
    next ??= new Map(smartHits);
    next.set(smartLid, { ...hit, lids, total: lids.length });
  }
  return next ?? smartHits;
}

export function refreshTaskCards(
  scan: TaskScan | null,
  lid: string,
  body: string,
): TaskScan | null {
  if (scan === null) return null;
  const cards = replaceTaskCards(scan.cards, lid, body);
  // 🔴 ノート 1 件の予定の時刻(前書きの `date: … 14:00`。依頼 192 / 284)も同じ口で引き直す
  const noteTimes = replaceNoteTime(scan.noteTimes, lid, body);
  return cards === scan.cards && noteTimes === scan.noteTimes ? scan : { ...scan, cards, ...(noteTimes === undefined ? {} : { noteTimes }) };
}

export function buildPersist(
  state: AppState,
  meta: EntryMeta,
  body: string,
): {
  entryMetas: ReadonlyMap<string, EntryMeta>;
  entry: EntryUpsert;
  /** ⚠ 板を開いていなければ `null`(呼び側はそのまま state へ入れてよい)。 */
  taskScan: TaskScan | null;
  /** ⚠ 入れ物を 1 つも開いていなければ、渡された map がそのまま返る。 */
  smartHits: ReadonlyMap<string, SmartHitState>;
} {
  const ext = extractMeta(meta.archetype, body);
  const changed =
    meta.status !== ext.status ||
    meta.date !== ext.date ||
    meta.archived !== ext.archived ||
    meta.bodyChars !== body.length;
  const entryMetas = changed
    ? new Map(state.entryMetas).set(meta.lid, { ...meta, ...ext, bodyChars: body.length })
    : state.entryMetas;
  return {
    entryMetas,
    // 🔑 本文が変われば札の行番号もずれる ── ここで組み直す(上の docstring)
    taskScan: refreshTaskCards(state.taskScan, meta.lid, body),
    /**
     * 🔑 **本文に `tags:` を書いて保存した回**も、開いている入れ物へ落とす
     *   (user 要望 2026-08-26)── 情報ペインから付けた回だけ直しても片手落ちである。
     */
    smartHits: refreshSmartHits(state.smartHits, meta.lid, body, entryMetas),
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
