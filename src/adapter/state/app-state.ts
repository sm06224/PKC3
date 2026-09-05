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
import { DEFAULT_ENTRY_SORT, NATURAL_DESC, type EntrySort } from '@features/filter/entry-sort';
import { resolveCanonicalParents, reorderSibling } from '@features/relation/tree';
import { extractMeta, seedBodyFor } from '@features/flavor';
import { applyBodyRewrite, type BodyRewrite } from '@features/markdown/body-rewrite';
import { isPlaceOpen } from '@features/markdown/place-notation';
import { moveLinesWithInverse, type MoveLines } from '@features/markdown/line-move';
import { replaceTaskCards, type TaskScan } from '@features/schedule/task-cards';
import type { ContactScan } from '@features/contact/contact-card';
import type { SnippetScan } from '@features/snippet/snippet-table';
import type { SearchDetailRow } from '@features/filter/search-snippet';
import {
  normalizeSplitLids,
  pinSplitLid,
  STACK_MAX,
  unpinSplitLid,
} from '@features/split-frames';
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import type { PersistState } from '@adapter/platform/storage-persist';
import type { OpenExtension } from '@adapter/platform/extension-links';
import type { LauncherTile } from '@features/launcher/tiles';
import type {
  GroupResult as QueryGroups,
  KeyResult as QueryKeys,
} from '@features/query/group-by';
import { NO_KINDS, entryFilterOf, visibleOrder } from '@features/filter/title-filter';
import { toggleKind } from '@features/filter/kind-filter';
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
import { filerRows, rangeInRows, smartLidsOf } from '@features/relation/filer-list';
import {
  EMPTY_SMART,
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
  withPane,
  withScope as withPaneScope,
  withSelection as withPaneSelection,
  withCursor,
  withFilter as withPaneFilter,
  withBack as withPaneBack,
  withForward as withPaneForward,
  canGoBack as paneCanGoBack,
  canGoForward as paneCanGoForward,
  paneFilterOptions,
  isTabIndex,
  withTabActive,
  withTabAdded,
  withTabClosed,
  type DualPaneState,
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
}

export type AppPhase = 'initializing' | 'ready' | 'editing' | 'error';

/** 探す面の state(#680)。中身の意味は `AppState.searchPage` の注記。 */
export interface SearchPageState {
  readonly query: string;
  readonly rows: readonly SearchDetailRow[];
  readonly rowsQuery: string;
  readonly truncated: boolean;
  readonly failed: boolean;
}
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
function nextLastAppend(
  prev: AppState['lastAppend'],
  next: { lid: string; inserted: readonly string[] | null; batch?: string },
): AppState['lastAppend'] {
  if (next.inserted === null) return null;
  const joined =
    prev !== null && next.batch !== undefined && prev.batch === next.batch && prev.lid === next.lid;
  return {
    lid: next.lid,
    lines: joined ? [...prev.lines, ...next.inserted] : next.inserted,
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
]);

export function isAsidePane(view: ViewMode): boolean {
  return ASIDE_PANES.has(view);
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
  search: '探す',
  dual: '2 ペインで整理',
  settings: '設定',
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
  if (phase === 'editing') return '編集を終了してから';
  if (phase === 'error') return '保存をやり直すか取り消してから';
  return '読み込みが終わってから';
}

/**
 * 🔴 **押せないボタンの説明**(#516)。`ready` なら `null`。
 * ⚠ 上の `phaseBlockReason` と**問いが違う**(あちらは帯の断り文、こちらは
 *   ボタンに添える説明)。⚠ ただし**判定は同じ `phase`** なので、
 *   両方をここへ並べて置く ── 片方だけ phase を増やし忘れるのを防ぐ。
 */
export function phaseDisabledNote(phase: AppPhase): string | null {
  if (phase === 'ready') return null;
  if (phase === 'editing') return '編集中は使えません ── 確定するか取り消してください';
  if (phase === 'error') return '保存に失敗しているので使えません ── やり直すか取り消してください';
  return '読み込み中は使えません';
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
function dualPreviewTarget(state: AppState, dual: DualState): string | null {
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
function smartScanFor(state: AppState, lid: string | null): DomainEvent[] {
  if (lid === null) return [];
  if (state.entryMetas.get(lid)?.archetype !== SMART_ARCHETYPE) return [];
  return [{ type: 'REQUEST_SMART_SCAN', lid }];
}

function withDual(state: AppState, dual: DualState): ReduceResult {
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

function withDualFocus(state: AppState, side: DualSide): ReduceResult {
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
  revisionPreview: { lid: string; revId: string; body: string } | null;
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
  backlinks: { lid: string; lids: string[]; truncated: boolean } | null;
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
  lastAppend: { lid: string; lines: readonly string[]; batch?: string } | null;
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
  dual: initialDual,
  selection: [],
  selectionAnchor: null,
  splitLids: [],
  splitBodies: new Map<string, string>(),
  openExtensions: [],
  freshLid: null,
  viewMode: 'detail',
  filterQuery: '',
  kindFilter: NO_KINDS,
  searchHits: null,
  selectionHistory: EMPTY_HISTORY,
  entrySort: DEFAULT_ENTRY_SORT,
  entrySortDesc: NATURAL_DESC[DEFAULT_ENTRY_SORT],
  searchHitsQuery: '',
  searchHitsTruncated: false,
  searchPage: { query: '', rows: [], rowsQuery: '', truncated: false, failed: false },
  queryKey: null,
  smartHits: new Map<string, SmartHitState>(),
  queryKeys: null,
  queryGroups: null,
  queryFailed: false,
  tagSuggestions: null,
  taskScan: null,
  taskScanFailed: false,
  contactScan: null,
  contactScanFailed: false,
  snippetScan: null,
  persistState: 'unknown',
  backlinks: null,
  launcherTiles: null,
  calendarMonth: null,
  showArchived: false,
  showDoneTasks: false,
  showUndatedTasks: false,
  revisionPanel: null,
  revisionPreview: null,
  notice: null,
  refusedTags: { 'smart-cond': [], 'bulk-tag': [] },
  noticeOpen: null,
  trashPanel: null,
  linkedFiles: new Map(),
  writeLock: null,
  lastAppend: null,
  lastMove: null,
  editOpenAt: null,
  tileWrite: null,
  lockGen: 0,
  error: null,
};

export type UserAction =
  /**
   * 🔴 **このノートを横に並べる / 並べるのをやめる**(#505 段②)。
   *
   * ⚠ **対で置く**(user 指示 2026-08-23「なんで双方向にする発想がでねぇんだよ!」)
   * ── 置けるのに外せないと、間違えて留めた物を戻す道が無い。
   */
  | { type: 'PIN_SPLIT_ENTRY'; lid: string }
  | { type: 'UNPIN_SPLIT_ENTRY'; lid: string }
  | { type: 'SELECT_ENTRY'; lid: string }
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
  /** 本文の当たりが SQL から返った(#181)。⚠ `query` は**どの問い合わせの答えか**。 */
  | { type: 'SET_SEARCH_HITS'; query: string; lids: string[]; truncated: boolean }
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
    }
  | { type: 'UPDATE_OPEN_BODY'; body: string }
  | { type: 'COMMIT_EDIT' }
  | { type: 'CANCEL_EDIT' }
  | { type: 'TOGGLE_TODO_STATUS'; lid: string }
  /**
   * 🔴 **カレンダーの日付を付け外しする**(#276)。`null` で外す。
   * ⚠ 書くのは frontmatter の 1 鍵だけ ── 本文は byte 無傷である
   *   (経路は `REQUEST_FRONTMATTER_SET` = todo のトグルと同じ 1 本)。
   */
  | { type: 'SET_ENTRY_DATE'; lid: string; date: string | null }
  /**
   * 🔴 **板の塊を動かす**(#283 P4-b)── いま開いているノートの `line` 行目
   * (生の body の行番号 = 描画が焼いた `data-pkc-source-line` + frontmatter)の
   * `.pkc-place` 開き行の x= / y= を書き換える。掴んだ時点の開き行は reducer が
   * `openBody` から捕える(呼び側に本文を持たせない)。
   */
  | { type: 'MOVE_PLACE'; lid: string; line: number; x: number; y: number }
  /**
   * 🔴 **板を画面から作る・大きさを変える・消す**(#676。user 裁定 2026-09-04)。
   * ⚠ 3 つとも `MOVE_PLACE` と**同じ門**(`bodyRewriteGate`)を通る ── phase / 画面に出ている
   *   本文 / 開き行の捕捉を、case ごとに書き直さない(§7)。
   * ⚠ `ADD_PLACE` だけ行番号を持たない(足す先は常に末尾)。
   */
  | { type: 'RESIZE_PLACE'; lid: string; line: number; w: number; h: number }
  | { type: 'REMOVE_PLACE'; lid: string; line: number }
  | { type: 'ADD_PLACE'; lid: string; x: number; y: number }
  /** 板を前へ出す(#676 段②)── 他の板の z= の最大 + 1 を書く。同じ門。 */
  | { type: 'RAISE_PLACE'; lid: string; line: number }
  /**
   * 🔴 **本文の塊を、本文の中で掴んで並べ替える**(#684 段①。user 要望 2026-09-03)。
   * `start..end` の行(**生の body** の行番号 = 描画の刻印 + frontmatter)を `toBefore` の
   * 前へ動かす。掴んだ時点の行そのものは reducer が画面の本文から捕える(呼び側に
   * 本文を持たせない ── `MOVE_PLACE` の開き行と同じ作法)。門は板の 5 つと**同じ**
   * (`bodyRewriteGate`)。
   */
  | { type: 'MOVE_BLOCK'; lid: string; start: number; end: number; toBefore: number }
  /**
   * 🔴 **行の並びを本文へ差し込む**(#684 段②)── 一覧の行を本文へ落とすとリンクになる。
   * ⚠ 何を入れるか(リンクの字)は binder が組んで渡す(`formatEntryLink` 1 本)。
   */
  | { type: 'INSERT_LINES'; lid: string; toBefore: number; lines: readonly string[] }
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
      date: string | null;
      time?: string | null;
      /** 🔴 期間の終わり(#344 段①)。単日にするなら渡さないか `null`。 */
      until?: string | null;
    }
  /**
   * 🔴 **チェックの印を付け外しする**(#277)。`line` は**原文の行番号**。
   * ⚠ 索引(何番目のチェックか)ではなく**行**で指す ── 索引だと、数え方が
   *   描画側と原文側で 1 つでもずれた瞬間に**別の行を書き換える**。
   */
  | { type: 'TOGGLE_TASK'; lid: string; line: number }
  /**
   * 🔴 **表のセルを 1 つ書き換える**(#418 段①)。
   * ⚠ `TOGGLE_TASK` と**同じ形**:書換は 1 本(`REQUEST_BODY_REWRITE`)を通り、
   *   面が独自の書込経路を持たない(§7)。何をするかの判断は `body-rewrite.ts`。
   * ⚠ `line` は**原文の行番号**、`col` はその行の何番目のセルか。
   *   区切り字は**渡さない** ── 囲みの見出しから決まる(呼び手に決めさせない)。
   */
  | { type: 'SET_CSV_CELL'; lid: string; line: number; col: number; value: string }
  /**
   * 🔴 **表の行・列を足す / 消す**(#418 段①)。⚠ `SET_CSV_CELL` と同じ形。
   */
  | {
      type: 'SET_CSV_SHAPE';
      lid: string;
      line: number;
      col: number;
      what: 'row' | 'col';
      mode: 'add' | 'remove';
    }
  /**
   * 🔴 **繰り返しの「その回」を済ませる**(#344 段②)。
   * ⚠ `TOGGLE_TASK` と**単位が違う** ── 規則の行の印は動かさず、
   *   **その日ぶんの行を 1 本増やす**(理由は `body-rewrite.ts` の `repeat-done`)。
   * ⚠ `line` は**規則の行**、`date` は**押した回の日**である。
   */
  | { type: 'MATERIALIZE_REPEAT'; lid: string; line: number; date: string }
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
  | { type: 'TOGGLE_SHOW_ARCHIVED' }
  /** 板の「完了」を開く / 畳む(2026-08-20。設計 doc §4-4)。 */
  | { type: 'TOGGLE_SHOW_DONE_TASKS' }
  | { type: 'TOGGLE_SHOW_UNDATED_TASKS' }
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
   * 🔴 **居場所を変える**(2026-08-05。フォルダ整理)。
   * `parentLid: null` = ルートへ出す。⚠ 「外す」と「入れる」を 2 つに割らない ──
   * 割ると途中で落ちたときに親無しが残る(PKC2 がその形だった)。
   */
  | { type: 'SET_ENTRY_PARENT'; lid: string; parentLid: string | null; relationId: string }
  /** 同じ親の下で隣と入れ替える(2026-08-06。user 報告 2-10)。 */
  | { type: 'MOVE_ENTRY_ORDER'; lid: string; direction: 'up' | 'down' }
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
    }
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
  | { type: 'SHOW_HISTORY' }
  /** 🔴 **その版の中身を見る**(#398 段②)。⚠ 復元ではない ── 1 バイトも書かない。 */
  | { type: 'PREVIEW_REVISION'; revId: string }
  | { type: 'HIDE_REVISION_PREVIEW' }
  | { type: 'REVISION_PREVIEW_LOADED'; lid: string; revId: string; body: string }
  | { type: 'HIDE_HISTORY' }
  | { type: 'RESTORE_REVISION'; revId: string }
  | { type: 'SHOW_TRASH' }
  | { type: 'HIDE_TRASH' }
  | { type: 'RESTORE_TRASH'; entryLid: string; revId: string }
  | { type: 'PURGE_TRASH' }
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
  | { type: 'SEARCH_DETAIL_FAILED'; query: string }
  | { type: 'BODY_LOADED'; lid: string; body: string }
  /**
   * 留めた枠の本文が読めた(#505 段②)。⚠ `BODY_LOADED` と**別の口**である ──
   * あちらは `openBody` を作る(= 編集の下書きになる)。
   */
  | { type: 'SPLIT_BODY_LOADED'; lid: string; body: string }
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
  | { type: 'ENTRY_STAMPED'; lid: string; createdAt: string | null; updatedAt: string | null }
  /**
   * 🔴 保存が「消えない扱い」かの ack(#347)。⚠ **`unknown` は届かない** ──
   * 分からないままのときは撃たない(state の初期値がそれである)。
   */
  | { type: 'PERSIST_STATE'; state: PersistState }
  /** 🔴 バックリンクが届いた(#348)。⚠ **どのノートの分か**を一緒に運ぶ。 */
  | { type: 'BACKLINKS_LOADED'; lid: string; lids: string[]; truncated: boolean }
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
      /**
       * 🔴 **足した行そのもの**(#395 段①、取り消しのため)。
       *
       * ⚠ **行番号ではない** ── 取り消すまでの間に別の窓が上へ足していれば
       *   番号はずれる。⚠ 純粋な挿入でなければ `null`(取り消しを出さない)。
       */
      inserted: readonly string[] | null;
      /** 取り込みの回の印(#668 C)。`REQUEST_APPEND.batch` がそのまま返る。 */
      batch?: string;
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
   */
  | { type: 'REQUEST_SEARCH'; query: string }
  /**
   * 探す面の検索を頼む(#680)。⚠ 受け手(effect)が **300ms 止まってから**叩く ──
   * 打鍵ごとに worker を叩かない。空文字は来ない(reducer が出さない)。
   */
  | { type: 'REQUEST_SEARCH_DETAIL'; query: string }
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
      targets: readonly {
        lid: string;
        title: string;
        archetype: string;
        entryOrder: number;
      }[];
    }
  | { type: 'REQUEST_REVISION_LIST'; lid: string }
  /** その版の本文を読む(#398 段②)。⚠ **読むだけ**(書込は 1 バイトも無い)。 */
  | { type: 'REQUEST_REVISION_BODY'; lid: string; revId: string }
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
  /**
   * 🔴 **消えた lid の掃除も、ここ 1 か所でやる**(#241 段⑥)。
   * ⚠ 2 ペインの印と現在地を case ごとに検めると、**次に entry を消す case を
   *   足した人が必ず忘れる**(履歴を 1 か所へ寄せたのと同じ理由)── 忘れると
   *   「N 件を移す」が居ないものを数え、消えたフォルダの中身として空の表が出る。
   * ⚠ 掃除は entryMetas が**変わった回だけ**(毎回やると 50 件の走査が無駄に回る)
   */
  let dual = result.state.dual;
  if (result.state.entryMetas !== state.entryMetas) {
    history = pruneHistory(history, (lid) => result.state.entryMetas.has(lid));
    dual = pruneDual(dual, (lid) => result.state.entryMetas.has(lid));
  }
  if (result.state.selectedLid !== null && result.state.selectedLid !== state.selectedLid)
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
  if (
    history === result.state.selectionHistory &&
    dual === result.state.dual &&
    backlinks === result.state.backlinks
  )
    return { state: result.state, events };
  return {
    state: { ...result.state, selectionHistory: history, dual, backlinks },
    events,
  };
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
      /**
       * ⚠ **別 container なら 2 ペインも畳む**(印の持ち越しと同じ判断)──
       * lid の偶然衝突で「他人のフォルダを開いた 2 枚のタブ」を残さない。
       * 🔑 同じ container のときの掃除は `reduce` の 1 か所がやる(上の注記)。
       */
      const keepDual = sameCid ? state.dual : initialDual;
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
          dual: keepDual,
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
          /**
           * 🔴 **予定の札も再読込で捨てる**(集計と同じ理由 ── #277 段②-b)。
           * ⚠ 取込はここを通るので、残すと**消えたノートの札**が盤面に残り、
           *   押すと「見つからない」になる。⚠ 捨てるだけでは「集めています…」で
           *   止まるので、**一度でも集めていれば集め直しも頼む**(対で要る)。
           */
          taskScan: null,
          taskScanFailed: false,
          // 🔴 **雛形も捨てる**(同じ理由)── 残すと**消えたノートの雛形**が
          //    `/` に並び、押すと本文が入らない(押しても何も起きない導線)
          snippetScan: null,
          /**
           * 🔴 **連絡先も再読込で検め直す**(#278 段③ の動線レビュー 2026-08-28)。
           *
           * ⚠ ここは **`contactScan` だけが漏れていた** ── 集計・予定・雛形は
           *   捨てて頼み直すのに、連絡先は表にも events にも居なかった。
           *   帰結は 2 つで、どちらも user のデータに触る:
           *   ① **取込はここを通る**ので、`.vcf` を 200 枚入れても一覧は
           *      「連絡先はまだありません」のまま ── user は「入らなかった」と読み、
           *      **同じ file をもう一度取り込んで 400 件になる**
           *      (`reload-snapshot.ts` が「二重取込が実データとして残る」と書いている形)
           *   ② ノートを消しても行が残り、押しても**何も起きない**
           *      (`SELECT_ENTRY` は居ない lid を黙って捨てる)
           * 🔑 直し方は**予定と同じにしない** ── あちらは丸ごと `null` にするが、
           *   連絡先で同じことをすると**別タブが書くたびに一覧が空へ飛ぶ**
           *   (`SYS_BOOTED` は 300ms 束ねで頻繁に飛ぶ。`REFRESH_CONTACT_SCAN` が
           *   「消すと行が飛ぶ」とわざわざ書いているのはそのため)。
           * 🔑 だから**消えた lid だけ落として頼み直す** ── この reducer が
           *   `selection` に対して既にやっている形と同じである(`keepMarks`)。
           */
          contactScan: keepContacts(state, sameCid, metas),
        },
        events: [
          ...(keepLid === null
            ? []
            : [{ type: 'REQUEST_BODY' as const, lid: keepLid }]),
          ...(state.viewMode === 'query'
            ? [{ type: 'REQUEST_QUERY_SCAN' as const, key: state.queryKey }]
            : []),
          /**
           * 🔴 **予定は「開いているか」ではなく「一度でも集めたか」で頼み直す**
           * (#292 段⑤、2026-08-23)。
           *
           * ⚠ 中央の面だった頃は `state.viewMode === 'kanban'` で足りたが、
           *   予定は**左の列のタブ**になったので、reducer からは開いているか
           *   どうかが見えない(`BrowseMode` は state に持たせていない ──
           *   「どう探すか」は画面側の都合で container のデータではない)。
           * 🔑 だから**直前に札を持っていたか**で決める ── 持っていたなら
           *   その user は予定を開いており、いま `null` に落としたので
           *   頼み直さないと**「集めています…」で止まったまま**になる。
           * ⚠ 一度も開いていない user には撃たない(全ノートの走査を、
           *   予定を使わない user に負わせない ── 集計と同じ流儀)。
           * ⚠ **判定を `main.ts` へ出さない** ── あちらはどの test からも
           *   実行されない(CLAUDE.md §2)。
           */
          ...(state.taskScan === null ? [] : [{ type: 'REQUEST_TASK_SCAN' as const }]),
          /**
           * 🔴 **連絡先も頼み直す**(上の `contactScan` と対)。
           * ⚠ 落とすだけでは、**取り込んだ 200 件が 1 件も現れない** ──
           *   集め直しの合図は「左のタブを連絡先へ切り替えたとき」1 か所しか
           *   無いので、タブを開いたままの user には永久に届かない。
           * ⚠ 一度も開いていない user には撃たない(全ノートの走査を、
           *   連絡先を使わない user に負わせない ── 予定・集計と同じ流儀)。
           */
          ...(state.contactScan === null ? [] : [{ type: 'REQUEST_CONTACT_SCAN' as const }]),
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
          // ⚠ 見ていた版も畳む(#398 段②)── 一覧が畳まれたら差分は孤児になる
          revisionPreview: null,
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
          /**
           * ⚠ **disk の本文は、板の走査より新しいことがある**(別タブが書いた等)。
           *   組み直さないと、その 1 件だけ古い行番号を指したまま押せる。
           * 🔑 板を開いていなければ即 `null` で返るので、実費はほぼ無い。
           */
          taskScan: refreshTaskCards(state.taskScan, action.lid, action.body),
          // 🔑 タグが変われば、開いている入れ物の中身も変わる(#421 / user 要望 2026-08-26)
          smartHits: refreshSmartHits(
            state.smartHits,
            action.lid,
            action.body,
            state.entryMetas,
          ),
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
        state: {
          ...state,
          filterQuery: action.query,
          searchHits: null,
          searchHitsQuery: '',
          // ⚠ 前の語の「ほかにもあります」を持ち越さない(#680)
          searchHitsTruncated: false,
        },
        events: [{ type: 'REQUEST_SEARCH', query: action.query }],
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
        state: { ...state, searchPage: { ...state.searchPage, rowsQuery: action.query, failed: true } },
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
       *   ごみ箱の復元は「編集を終了してから戻してください」と言う(#319)。
       *   ここだけ黙っていた。
       * 🔑 **判定はここ 1 か所のまま**にする(CLAUDE.md §7)── 呼び側
       *   (`set-view` / タイル / 鍵)に `phase !== 'ready'` を配ると、
       *   足すたびに取りこぼす。`error` を載せて返せば、出口は既存の 1 本で足りる。
       */
      if (state.phase === 'editing' && !isAsidePane(action.mode) && action.mode !== 'detail')
        return {
          state: {
            ...state,
            error: `編集中は${viewModeLabel(action.mode)}を開けません(保存するか、取り消してください)`,
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
    case 'REFRESH_SNIPPET_SCAN':
      return { state, events: [{ type: 'REQUEST_SNIPPET_SCAN' }] };
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
            newName: action.newName,
            newMime: action.newMime,
            savedAt: action.savedAt,
            // 🔑 **ノートの一覧はもう運ばない**(2026-08-25)── 走査ごと
            //    worker の 1 tx へ移したので、題名も並びも **worker が自分で読む**。
            //    ⚠ 運び続けると「受け手のいない payload」になる(5,000 件の meta を
            //    毎回作って捨てることになるうえ、次に読む人が「効く」と思う)。
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
          // ⚠ 名前のとおり**本文が入れ替わる**所 ── 札も組み直す(上と同じ理由)
          taskScan: refreshTaskCards(state.taskScan, action.lid, action.body),
          // 🔑 タグが変われば、開いている入れ物の中身も変わる(#421 / user 要望 2026-08-26)
          smartHits: refreshSmartHits(
            state.smartHits,
            action.lid,
            action.body,
            state.entryMetas,
          ),
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
      return {
        state: {
          ...state,
          phase: 'editing',
          revisionPanel: null,
          // ⚠ 見ていた版も畳む(#398 段②)── 一覧が畳まれたら差分は孤児になる
          revisionPreview: null,
          /**
           * 🔴 **押した行を持って編集へ入る**(#395 段③)。
           * ⚠ **毎回入れ替える**(`?? null`)── 前回の値を残すと、普通に
           *   「編集」を押しただけで**前に押した行が開く**。
           */
          editOpenAt: action.atLine ?? null,
          // ⚠ 編集は行をずらすので「元に戻す」の材料は捨てる(#684 段①。`lastMove` の注記)
          lastMove: null,
        },
        /**
         * 🔴 **編集に入るたびに雛形を集め直す**(#196 / B-2)。
         *
         * ⚠ 「一度集めたら使い回す」にしない ── **さっき直した雛形が次の編集で
         *   古いまま**になる(自分で作った物が効かないのは、いちばん困る形)。
         * 🔑 実費は「archetype で絞った ≤200 行を worker で読む」1 往復で、
         *   しかも**押した瞬間ではなく編集を開いた瞬間**に走るので、`Tab` の
         *   反応には乗らない。
         * ⚠ 頼むのは配線ではなくここ ── `main.ts` に書くと、どの test からも
         *   実行されない場所に判断が沈む(CLAUDE.md §2)。
         */
        events: [{ type: 'REQUEST_SNIPPET_SCAN' }],
      };
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
      const { entryMetas, entry, taskScan, smartHits } = buildPersist(state, meta, body);
      // 変更前(baseline)を履歴に積むかどうか(P5c: 実際の記録は worker が
      // 同 tx で行う ── ここは「刻むか / 頭を張り替えるだけか」の意思決定)。
      // 新規作成の初回 commit は積まない ──「flavor seed へ戻す」だけの復元先は
      // ゴミ(PKC2 は無条件に積んで肥大した)。
      // ⚠ freshLid だけでは足りない(review P5b F4): rename が fresh を解除する
      // ため「作成 → title → 本文 → 保存」の普通の流れで seed revision が積まれる
      // ── baseline が flavor seed のままなら fresh 扱いで skip する
      /**
       * 🔴 **別の窓の版を上書きするなら、必ず履歴へ積む**(#178、2026-08-22)。
       *
       * ⚠ ここは **last-write-wins のまま**である(「変更ありの commit は draft が
       *   正」── P3-6a review #4 の判断は覆さない)。user が打った字を、
       *   別の窓の都合で**捨てさせない**ためである。
       * 🔑 変えるのは**残るかどうか**と**黙るかどうか**の 2 つだけ:
       *   ① `checkpoint` を強制する(下の断り文「履歴に残しました」を**本当にする**)
       *   ② 画面に出す ── 直す前は**完全に無言**で、user は「カレンダーで付けた
       *      日付が消えた」としか見えなかった(戻せることを知る道が無い)。
       * ⚠ ①は「たぶん積まれる」では足りない ── 新規作成の初回 commit は
       *   `checkpoint` が false なので、そこだけ本当に消える。
       */
      const checkpoint =
        diskAhead || (state.freshLid !== lid && baseline !== seedBodyFor(meta.archetype));
      return {
        state: {
          ...next,
          entryMetas,
          taskScan,
          smartHits,
          ...(diskAhead
            ? {
                error:
                  '別のウィンドウの変更と重なりました。こちらの内容で保存し、' +
                  '別のウィンドウの版は履歴に残してあります(履歴から戻せます)',
              }
            : {}),
        },
        /**
         * 🔑 **保存したのが入れ物自身なら、条件が変わったかもしれない**
         *   (本文の `smart-tags:` は手で書ける ── マニュアルにもそう書いてある)。
         * ⚠ 上の `refreshSmartHits` は**自分自身を触らない**(自分は集めないので
         *   正しい)ので、条件の変更はここでしか拾えない。
         * ⚠ 入れ物でなければ `smartScanFor` が空を返す ── 普通の保存で走査は走らない。
         */
        events: [
          { type: 'PERSIST_ENTRY', entry, checkpoint },
          ...smartScanFor(state, lid),
        ],
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
      const { entryMetas, entry, taskScan, smartHits } = buildPersist(state, meta, baseline);
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
          taskScan,
          smartHits,
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
        state: { ...state, writeLock: { lid: action.lid }, revisionPanel: null, revisionPreview: null },
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
            target: action.target,
            ...(action.batch === undefined ? {} : { batch: action.batch }),
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
        state: {
          ...state,
          entryMetas,
          openBody,
          writeLock: null,
          /**
           * 🔴 **ここも「新しい本文が state に入る所」である**(2026-08-20 に判明)。
           *
           * ⚠ `refreshTaskCards` の docstring は「2 か所**だけ**を通す」と宣言して
           *   いたが、**この 3 か所目が漏れていた** ── §7 の「数えた数だけ通す」で
           *   数を間違えた形である(宣言が在るぶん、次に読む人は疑わない)。
           * ⚠ いまの追記は**末尾に足す**ので既存の札の行番号はずれない。実害は
           *   「**足したチェック項目が板に出ない**」(開き直すまで)。⚠ ただし
           *   板から「やること」を足す口を作ると、これが正面の欠陥になる。
           */
          taskScan: refreshTaskCards(state.taskScan, action.lid, action.body),
          // 🔑 タグが変われば、開いている入れ物の中身も変わる(#421 / user 要望 2026-08-26)
          smartHits: refreshSmartHits(
            state.smartHits,
            action.lid,
            action.body,
            state.entryMetas,
          ),
          /**
           * 🔴 **直前の 1 手だけ覚える**(#395 段①)── 「元に戻す」の材料。
           * ⚠ 純粋な挿入でなかった回は `null` に落とす ── 前の追記の材料を
           *   **残したままにしない**(古い材料で消すと、別の所が消える)。
           */
          lastAppend: nextLastAppend(state.lastAppend, action),
        },
        events: [],
      };
    }
    /**
     * 🔴 **直前の追記を取り消す**(#395 段①)。
     *
     * ⚠ **消すのは「足した行そのもの」**で、行番号ではない ── 取り消すまでの間に
     *   別の窓が上へ足していれば番号はずれる。見つからなければ
     *   `applyBodyRewrite` が `null` を返して effect が断る(黙って別の所を消さない)。
     * ⚠ **1 手で使い切る**(`lastAppend` を落とす)── 2 度押しで、同じ字の
     *   別の行まで消えるのを止める。
     */
    case 'UNDO_APPEND': {
      if (state.phase !== 'ready') return { state, events: [] };
      const last = state.lastAppend;
      if (!last) return { state, events: [] };
      const meta = state.entryMetas.get(last.lid);
      if (!meta) return { state: { ...state, lastAppend: null }, events: [] };
      return {
        state: { ...state, lastAppend: null },
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'undo-append', lines: last.lines },
          },
        ],
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
    /**
     * 🔴 **面から予定を動かす**(user 指示 2026-08-23「なんで双方向にする発想が
     * でねぇんだよ」)。⚠ `TOGGLE_TASK` と**同じ形** ── 書換は 1 本
     * (`REQUEST_BODY_REWRITE`)を通り、面が独自の書込経路を持たない(§7)。
     * ⚠ `date: null` は**外す**(予定から落とす。消すのではない)。
     */
    case 'SET_TASK_DATE': {
      /**
       * 🔴 **断るなら、声に出して断る**(#516)。
       *
       * ⚠ 直す前は `events: []` で**黙って捨てて**いた ── 予定の面で札を掴んで
       *   日に落とすと、**札が黙って元に戻る**(成功でも失敗でもない見た目)。
       *   ⚠ 皮肉なことに `set-entry-date` の docstring 自身が
       *   「**主の道は予定の面で掴んで落とすこと**」と書いており、
       *   #513 / #515 で塞いだのは**主の道ではない 2 つ**だった。
       * 🔑 **判定はここ 1 か所**にする(§7 ── `SET_VIEW_MODE` と同じ形)。
       *   撃つ口は `SET_ENTRY_DATE` が 4 か所・`SET_TASK_DATE` が 2 か所あり、
       *   呼び側に配ると**足すたびに取りこぼす**。
       * 🔑 動詞は **`action.date` から導ける**(null = 外す)ので、1 か所でも
       *   「外す / 付ける」を言い分けられる ── 呼び側ごとに文言を配らなくてよい。
       * ⚠ **呼び名は分ける**(行の予定 / ノートの日付)── 一括りにすると
       *   user は別のものを探す(#515 のレビューの指摘と同じ)。
       */
      const blocked = phaseBlockReason(state.phase);
      if (blocked !== null)
        return {
          state: {
            ...state,
            error: `${blocked}${action.date === null ? '行の予定を外してください' : '行に予定を付けてください'}`,
          },
          events: [],
        };
      // 未知 lid は no-op(押した物が消えている ── 言うことが無い)
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'line-date',
              line: action.line,
              date: action.date,
              ...(action.time === undefined ? {} : { time: action.time }),
              // ⚠ **渡されたときだけ**載せる(渡していないのに `null` を載せると、
              //    「期間を外す」という**頼んでいない指示**になる)
              ...(action.until === undefined ? {} : { until: action.until }),
            },
          },
        ],
      };
    }
    /**
     * 🔴 **取り込んだ外部画像を本文へ当てる**(#264 段①)。⚠ `TOGGLE_TASK` と
     *   **同じ形** ── 書換は 1 本(`REQUEST_BODY_REWRITE`)を通る(§7)。
     * ⚠ **対応が空なら撃たない** ── 1 枚も読めなかったとき、effect の
     *   「本文が変わっているため反映できませんでした(開き直してください)」が出て、
     *   **原因と無関係な直し方**を user に指示することになる(理由は binder が言う)。
     */
    case 'ADOPT_EXTERNAL_IMAGES': {
      if (state.phase !== 'ready') return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      if (Object.keys(action.adopted).length === 0) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'adopt-images', adopted: action.adopted },
          },
        ],
      };
    }
    /**
     * 🔴 **表のセルを書き換える**(#418 段①)。⚠ `TOGGLE_TASK` と**同じ形**。
     */
    case 'SET_CSV_CELL': {
      // ready 限定(編集中の裏書換を作らない)。未知 lid は no-op
      if (state.phase !== 'ready') return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'csv-cell',
              line: action.line,
              col: action.col,
              value: action.value,
            },
          },
        ],
      };
    }
    /**
     * 🔴 **表の行・列を足す / 消す**(#418 段①)。⚠ `SET_CSV_CELL` と同じ形。
     */
    case 'SET_CSV_SHAPE': {
      // ready 限定(編集中の裏書換を作らない)。未知 lid は no-op
      if (state.phase !== 'ready') return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'csv-shape',
              line: action.line,
              col: action.col,
              what: action.what,
              mode: action.mode,
            },
          },
        ],
      };
    }
    case 'TOGGLE_TASK': {
      // ready 限定(編集中の裏書換を作らない)。未知 lid は no-op
      if (state.phase !== 'ready') return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'task', line: action.line },
          },
        ],
      };
    }
    /**
     * 🔴 **繰り返しの回を済ませる**(#344 段②)。⚠ `TOGGLE_TASK` と**同じ形** ──
     *   書換は 1 本(`REQUEST_BODY_REWRITE`)を通る(§7)。何をするかの判断は
     *   `body-rewrite.ts` が持ち、ここは**単位を選ぶだけ**である。
     */
    case 'MATERIALIZE_REPEAT': {
      // ready 限定(編集中の裏書換を作らない)。未知 lid は no-op
      if (state.phase !== 'ready') return { state, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'repeat-done', line: action.line, date: action.date },
          },
        ],
      };
    }
    /**
     * 🔴 **板の塊を動かす**(#283 P4-b)。門(phase / 画面に出ている本文 / 開き行の捕捉)は
     * `bodyRewriteGate` 1 か所 ── 下の 3 つ(#676)と共有する。
     */
    case 'MOVE_PLACE':
      return bodyRewriteGate(state, action.lid, '編集を終了してから、板の付箋を動かしてください', (shown) => {
        if (!isPlaceCoord(action.x) || !isPlaceCoord(action.y)) return null;
        const openLine = placeOpenLineOf(shown, action.line);
        if (openLine === null) return null;
        return { kind: 'place-move', line: action.line, openLine, x: action.x, y: action.y };
      });
    /**
     * 🔴 **板を画面から作る・大きさを変える・消す**(#676)── 3 つとも `MOVE_PLACE` と
     * 同じ門(`bodyRewriteGate`)を通る。断り文だけが**押した場所と対**で違う
     * (CLAUDE.md「文言は押した場所と対で pin する」)。
     */
    case 'RESIZE_PLACE':
      return bodyRewriteGate(state, action.lid, '編集を終了してから、板の大きさを変えてください', (shown) => {
        if (!isPlaceCoord(action.w) || !isPlaceCoord(action.h)) return null;
        const openLine = placeOpenLineOf(shown, action.line);
        if (openLine === null) return null;
        return { kind: 'place-size', line: action.line, openLine, w: action.w, h: action.h };
      });
    case 'REMOVE_PLACE':
      return bodyRewriteGate(state, action.lid, '編集を終了してから、板を消してください', (shown) => {
        const openLine = placeOpenLineOf(shown, action.line);
        if (openLine === null) return null;
        return { kind: 'place-remove', line: action.line, openLine };
      });
    case 'ADD_PLACE':
      return bodyRewriteGate(state, action.lid, '編集を終了してから、板を置いてください', () =>
        isPlaceCoord(action.x) && isPlaceCoord(action.y)
          ? { kind: 'place-add', x: action.x, y: action.y }
          : null,
      );
    case 'RAISE_PLACE':
      return bodyRewriteGate(state, action.lid, '編集を終了してから、板を前へ出してください', (shown) => {
        const openLine = placeOpenLineOf(shown, action.line);
        if (openLine === null) return null;
        return { kind: 'place-raise', line: action.line, openLine };
      });
    /**
     * 🔴 **本文の塊を掴んで並べ替える**(#684 段①)── 板と**同じ門**。
     * 🔑 掴んだ時点の行そのものは**ここで**画面の本文から捕える(`placeOpenLineOf` と同じ
     *   向き)── disk 側とずれていれば `line-move.ts` が byte 一致で断る。
     * ⚠ `dragstart` では phase を見ない(掴むのは自由)── 落としたときにここで断る。
     */
    case 'MOVE_BLOCK':
      return bodyRewriteGate(state, action.lid, '編集を終了してから、本文の塊を動かしてください', (shown) => {
        const { start, end, toBefore } = action;
        if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(toBefore)) return null;
        const lines = shown.split('\n');
        if (start < 0 || end < start || end >= lines.length) return null;
        return { kind: 'move-lines', start, end, toBefore, lines: lines.slice(start, end + 1) };
      });
    /** 🔴 **一覧の行を本文へ落とすとリンクになる**(#684 段②)── 同じ門。空の並びは撃たない。 */
    case 'INSERT_LINES':
      return bodyRewriteGate(state, action.lid, '編集を終了してから、一覧の行を本文へ落としてください', () =>
        Number.isInteger(action.toBefore) && action.lines.length > 0
          ? { kind: 'insert-lines', toBefore: action.toBefore, lines: action.lines }
          : null,
      );
    /**
     * 🔴 **直前の塊の移動を元に戻す**(#684 段①)── `UNDO_APPEND` と同じ形。
     * ⚠ **1 手で使い切る**(`lastMove` を落とす)。戻した結果も `BODY_REWRITTEN` が
     *   `move-lines` として届くので、そこでまた「戻す」の材料が入る(= 押し直せる)。
     */
    case 'UNDO_MOVE': {
      if (state.phase !== 'ready') return { state, events: [] };
      const last = state.lastMove;
      if (!last) return { state, events: [] };
      const meta = state.entryMetas.get(last.lid);
      if (!meta) return { state: { ...state, lastMove: null }, events: [] };
      return {
        state: { ...state, lastMove: null },
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'move-lines',
              start: last.start,
              end: last.end,
              toBefore: last.toBefore,
              lines: last.lines,
            },
          },
        ],
      };
    }
    case 'SET_ENTRY_DATE': {
      // 🔴 **黙って捨てない**(#516)── 理由は上の `SET_TASK_DATE` に書いた
      const blocked = phaseBlockReason(state.phase);
      if (blocked !== null)
        return {
          state: {
            ...state,
            error: `${blocked}${action.date === null ? 'ノートの日付を外してください' : 'ノートに日付を付けてください'}`,
          },
          events: [],
        };
      // 未知 lid は no-op
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      // ⚠ 同じ値なら何もしない(空の書込を投げない)
      if ((meta.date ?? null) === action.date) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            // ⚠ `undefined` = その鍵を消す(`spliceFrontmatterKeys` の作法)
            rewrite: { kind: 'frontmatter', keys: { date: action.date ?? undefined } },
          },
        ],
      };
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
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: 'todo',
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'frontmatter', keys: { status: nextStatus } },
          },
        ],
      };
    }
    case 'BODY_REWRITTEN': {
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
          // ⚠ 合流も**やった書換そのもの**で当て直す(#276 / #277)── todo の
          //   status に固定していると、日付やチェックを書いた回で**それが落ちる**
          const merged = applyBodyRewrite(openBody.baseline, action.rewrite) ?? openBody.baseline;
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
      /**
       * 🔴 **押した札をその場で動かす**(#277 段②-b)。ack は**新しい本文**を
       * 持っているので、そのノートの札はここで組み直せる ── 集め直しを頼むと
       * 往復のぶん札が固まったままになり、押した手応えが消える。
       * ⚠ 触るのは**そのノートの札だけ**(他のノートを並び直さない)。
       * ⚠ 盤面を一度も開いていなければ `null` のまま(何もしない)。
       */
      const taskScan = refreshTaskCards(state.taskScan, action.lid, action.body);
      /**
       * 🔴 **塊を動かした回は「元に戻す」の材料を入れ、知らせを出す**(#684 段①)。
       *
       * 逆向きの指示は、動かす**前**の本文(この ack が届く前に画面が持っていた本文)から
       * 計算する。⚠ その本文から同じ結果(`action.body`)が出ないとき(= 画面が古かった)は
       * 材料を入れない ── 当てずっぽうの位置へ戻さない(`undo-append` の「見つからなければ
       * 断る」と同じ向き)。
       * ⚠ 同じノートへの**別の**書換は、行がずれうるので材料を捨てる(`lastMove` は位置を持つ)。
       * 🔑 知らせは `OP_NOTICE` と同じ 2 つ(`notice` / `noticeOpen`)を書く ── 「開く」の
       *   身元は添えないので `null`(次の知らせで消える作法のまま)。
       */
      let lastMove = state.lastMove;
      let notice = state.notice;
      let noticeOpen = state.noticeOpen;
      if (action.rewrite.kind === 'move-lines') {
        const before = screenBodyOf(state, action.lid);
        const moved = before === null ? null : moveLinesWithInverse(before, action.rewrite);
        lastMove =
          moved !== null && moved.body === action.body && moved.inverse !== null
            ? { lid: action.lid, ...moved.inverse }
            : null;
        if (lastMove !== null) {
          notice = '本文の塊を動かしました';
          noticeOpen = null;
        }
      } else if (lastMove !== null && lastMove.lid === action.lid) {
        lastMove = null;
      }
      /**
       * 🔑 **タグを付けたら、開いている入れ物にその場で落ちる**(user 要望 2026-08-26)。
       * ⚠ ここは**まとめてタグを付ける**経路でもある(`REQUEST_BULK_TAG` が 1 件ずつ
       *   ack を撃つ)── worker に頼み直す形だと 100 件で 100 回の全件走査になる。
       */
      const smartHits = refreshSmartHits(state.smartHits, action.lid, action.body, entryMetas);
      /**
       * 🔴 **タグを書いたら候補を捨てる**(#494 段②)── 次に欄へ焦点が当たったら
       * 集め直す。⚠ 捨てないと、**付けたばかりのタグが候補に出ない** ── user は
       * 「効いていない」と読む(押した手応えが消える型)。
       * ⚠ **その場で足すのではなく捨てる** ── 足すだけだと「外した最後の 1 件」が
       *   候補に残り続ける(片側だけ追随する形。§7)。
       */
      const tagSuggestions =
        action.rewrite.kind === 'tag' ? null : state.tagSuggestions;
      return {
        state: {
          ...state,
          entryMetas,
          openBody,
          taskScan,
          smartHits,
          tagSuggestions,
          lastMove,
          notice,
          noticeOpen,
        },
        events: [],
      };
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
    case 'TOGGLE_SHOW_DONE_TASKS':
      // ⚠ 選択も走査も動かさない ── 見え方だけを変える
      return { state: { ...state, showDoneTasks: !state.showDoneTasks }, events: [] };
    case 'TOGGLE_SHOW_UNDATED_TASKS':
      /**
       * ⚠ **走査を頼み直さない**(2026-08-23)── 日付の無い札も `taskScan` に
       *   載っているので、切替は**描画側の絞り**だけで済む。
       * 🔑 頼み直す形にすると、押すたびに worker を叩き、しかも
       *   **戻ってくるまで盤面が空になる**(押した手応えが消える)。
       */
      return { state: { ...state, showUndatedTasks: !state.showUndatedTasks }, events: [] };
    case 'BODY_PERSISTED': {
      /**
       * 🔴 **留めた枠にも同じノートが出ていることがある**(#505 段②)。
       * ⚠ ここで追随させないと、主の枠で直しても**留めた枠だけ古いまま**になる。
       * ⚠ `openBody` の早期 return の**前**に置く ── 後ろに置くと、
       *   選択が移った後の ack で留めた枠が更新されない(片側だけ在る非対称)。
       */
      const persistedSplit = syncSplitBody(state, action.lid, action.body);
      const base =
        persistedSplit === state.splitBodies ? state : { ...state, splitBodies: persistedSplit };
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
      const remoteSplit = syncSplitBody(state, action.lid, action.body);
      const base =
        remoteSplit === state.splitBodies ? state : { ...state, splitBodies: remoteSplit };
      // ⚠ 編集中だけ ── `ready` は `reloadSnapshot` が先送りなしで面倒を見る
      //   (両方で受けると、同じ問いに答える口が 2 つになる。CLAUDE.md §7)
      if (state.phase !== 'editing') return { state: base, events: [] };
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
              backlinks: { lid: action.lid, lids: action.lids, truncated: action.truncated },
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
        smartLids: smartLidsOf(state.scopeLid, state.smartHits),
        filterQuery: state.filterQuery,
        searchHits: state.searchHits,
        sort: state.entrySort,
        sortDesc: state.entrySortDesc,
        kinds: state.kindFilter,
      });
      const range = rangeInRows(rows, state.selectionAnchor, action.lid);
      if (range.length === 0) return { state, events: [] };
      // ⚠ 起点は動かさない ── 動かすと `Shift` を押すたびに範囲が縮んでいく
      return { state: { ...state, selection: range }, events: [] };
    }
    case 'SELECT_ALL': {
      if (state.phase !== 'ready') return { state, events: [] };
      // ⚠ 規則は `filerRows` 1 か所(描く側・範囲選択と同じ答えになる)
      const rows = filerRows(state.scopeLid, state.entryMetas, state.relations, {
        smartLids: smartLidsOf(state.scopeLid, state.smartHits),
        filterQuery: state.filterQuery,
        searchHits: state.searchHits,
        sort: state.entrySort,
        sortDesc: state.entrySortDesc,
        kinds: state.kindFilter,
      }).map((m) => m.lid);
      if (rows.length === 0) return { state, events: [] };
      return {
        state: { ...state, selection: rows, selectionAnchor: rows[rows.length - 1] ?? null },
        events: [],
      };
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
        // ⚠ worker が同じ本文から数え直す値と**同じ式**で置く(§7)
        bodyChars: body.length,
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
      /**
       * 🔴 **添付の作成は絞りを外さない**(#668 D)。
       *
       * 下の「絞り込みを解除する」の理由(review M-2 / #411)は「**作った物が絞りに
       * 弾かれて一生一覧に出ない** → user が Esc で消してしまう」である ── ⚠ 添付には
       * 当たらない。添付は**開いていたノートの本文に入る**(#666)ので一覧で見せる
       * 必要が無く、編集に入らないので Esc の掃除も無い。
       * ⚠ むしろ外すと害が出る:「探す」に打っていた字と種類の札が、写真を 1 枚
       *   足しただけで**黙って消える**(user は絞りを打ち直す)。
       * 🔑 判定は archetype 1 つ ── 添付を作る経路(取込 / 録音 / 画面録画 /
       *   ランチャーのタイル)は全部ここを通る。
       */
      const keepFilter = action.archetype === 'attachment';
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
          filterQuery: keepFilter ? state.filterQuery : '',
          /**
           * 🔴 **種類の絞りも外す**(#411)── **同じ事故が軸を変えて戻ってくる**。
           * 「添付だけ」を出しているときに「ノート」を作ると、作った物は
           * 札に弾かれて**一生一覧に出ない**。user は「効かなかった」と思って
           * Esc を押し、新規未編集 cancel の掃除で **entry ごと消える**
           * (review M-2 で `filterQuery` について実証済みの経路そのもの)。
           */
          kindFilter: keepFilter ? state.kindFilter : NO_KINDS,
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
            /**
             * 🔴 **居場所は同じ tx で書く**(#258)。直す前は `REQUEST_SET_PARENT` を
             * 後ろに並べる **2 手**で、effect が 1 件ずつ worker へ流すので
             * 「行を書く → ack → 辺を書く」の隙にタブを閉じると**親だけ飛んだ**
             * (フォルダの中に作ったのにルートに現れる)。⚠ 並びを入れ替えても直らない
             * (行の無いところへ辺を張ることになる)── **1 tx にする**のが答え。
             */
            ...(parentLid === null
              ? {}
              : { parent: { parentLid, relationId: action.relationId as string } }),
          },
          /**
           * 🔴 **作って即編集の経路でも雛形を集める**(#196 / B-2)。
           *
           * ⚠ 2026-08-25 に**実ブラウザの smoke が拾った** ── `START_EDIT` にだけ
           *   置いていたので、**作成から入った編集では短縮語が 1 つも当たらなかった**。
           *   unit は「編集」を押す経路しか通しておらず、**この経路は 1 度も
           *   走っていなかった**(CLAUDE.md §2)。
           * 🔑 「編集に入る」は 2 経路ある ── 片方だけに置くと、もう片方が黙って死ぬ。
           */
          ...(wantsEdit ? [{ type: 'REQUEST_SNIPPET_SCAN' as const }] : []),
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
    /**
     * 🔴 **選んだ全部にタグを付ける / 外す**(#402 ①)。
     *
     * > user の物語: フォルダで 12 件選んだ。全部に `#請求済` を付けたい。
     * > いま一括でできるのは「ゴミ箱へ」だけで、**12 回開いて 12 回書く**。
     *
     * ⚠ ready 限定(編集中の裏書換を作らない ── `TOGGLE_TASK` と同じ)。
     * ⚠ **居ない lid は落とす**(消えたノートへ書きに行かない)。
     * ⚠ 空の相手・空のタグでは**何も撃たない**(押して無反応にならないよう、
     *   帯の側がそもそも押せない形にしてある)。
     */
    case 'BULK_TAG': {
      if (state.phase !== 'ready') return { state, events: [] };
      // ⚠ 空の名前は落とす(打った字の割り方は `splitTags` が持つ ── ここは受けるだけ)
      const tags = action.tags.map((t) => t.trim()).filter((t) => t !== '');
      if (tags.length === 0) return { state, events: [] };
      const targets = action.lids
        .map((lid) => state.entryMetas.get(lid))
        .filter((m): m is EntryMeta => m !== undefined)
        .map((m) => ({
          lid: m.lid,
          title: m.title,
          archetype: m.archetype,
          entryOrder: m.entryOrder,
        }));
      if (targets.length === 0) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BULK_TAG',
            tags,
            mode: action.mode,
            targets,
            ...(action.field === undefined ? {} : { field: action.field }),
          },
        ],
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
      return {
        state: {
          ...state,
          revisionPreview: { lid: action.lid, revId: action.revId, body: action.body },
        },
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
      const meta = state.entryMetas.get(state.selectedLid);
      if (!meta) return { state, events: [] };
      // panel は畳む(復元で履歴が 1 件伸びるので開き直しが正)。meta snapshot は
      // 発火時捕獲(C-1 規律)
      return {
        state: { ...state, revisionPanel: null, revisionPreview: null },
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
      /**
       * 🔴 **門を持たない**(#319)。⚠ 直す前は `phase !== 'ready'` で**黙って捨てて**
       * いたので、編集中に「ゴミ箱」を押すと**1 ドットも変わらず理由も出なかった**
       * ── P8 段⑲ で潰した「無言の操作拒否」そのものである。
       * 🔑 **開くのは読むだけ**で、下書きに 1 バイトも触らない ── この file の
       *   2 ペインの節が既に同じ判断を書いている(「断りが要るのは**実際に動かす
       *   操作**だけ」)。動かす側(復元・空にする)はそちらで断る。
       * ⚠ 外すなら `TRASH_LIST_LOADED` も同時に ── 片方だけだと
       *   「押せるのに一覧が来ない」という**別の無言**を作る。
       */
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
      // 🔴 **開く側と対で門を外す**(#319)── 片方だけ残すと
      //    「押せるのに一覧が来ない」という別の無言になる
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
            error: `復元できません: 同じ ID のノートが既にあります(${action.entryLid})`,
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
    /* ── 2 ペインタブファイラ(#241 段⑥)───────────────────────────
     * 🔴 **どれも `phase` を見ない**(= 編集中でも通る)。
     * ⚠ 直前の稿は `phase !== 'ready'` で黙って捨てていたが、それは #240 と P11 で
     *   2 度踏んだ**無言の操作拒否**そのものである ── 場所を移る・印を付けるは
     *   下書きに 1 バイトも触らないので、止める理由が無い(`SET_VIEW_MODE` が
     *   ヘルプ・設定を編集中に通すのと同じ判断:「書きながら置き場を眺める」)。
     * 🔑 **断りが要るのは「実際に動かす操作」だけ** ── そちらは `moveEntries` /
     *   `DELETE_ENTRIES` が既に**声に出して**断っている(判定を増やさない)。
     */
    case 'DUAL_FOCUS':
      return withDualFocus(state, action.side);
    case 'DUAL_SET_SCOPE': {
      // ⚠ 実在しない lid へは入らない(消えたフォルダの中身として空の表を出さない)
      if (action.lid !== null && !state.entryMetas.has(action.lid))
        return { state, events: [] };
      const pane = withPaneScope(paneOf(state.dual, action.side), action.lid);
      if (pane === paneOf(state.dual, action.side)) return withDualFocus(state, action.side);
      // 🔑 場所を触った側へ焦点も移す(移す向きは「焦点のある側から」なので、
      //    触った側が元にならないと user の意図と逆へ流れる)
      return withDual(state, {
        ...withPane(state.dual, action.side, pane),
        focus: action.side,
      });
    }
    case 'DUAL_SELECT': {
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      const pane = paneOf(state.dual, action.side);
      /**
       * 🔑 **範囲は「表示している並び」で採る**(#240 段②と同じ規則・同じ関数)。
       * ⚠ ここで並びを組み直すと、目で見た範囲と選ばれる範囲が食い違う。
       */
      const rows = filerRows(paneScope(pane), state.entryMetas, state.relations, {
        smartLids: smartLidsOf(paneScope(pane), state.smartHits),
        // 🔑 **絞り込みの規則は 1 本**(`paneFilterOptions`)── 描く側と同じものを見る
        ...paneFilterOptions(pane, state.filterQuery, state.searchHits),
        sort: state.entrySort,
        sortDesc: state.entrySortDesc,
        kinds: state.kindFilter,
      });
      let next: DualPaneState;
      if (action.mode === 'range') {
        const range = rangeInRows(rows, pane.anchor, action.lid);
        if (range.length === 0) return { state, events: [] };
        // ⚠ 起点は動かさない(動かすと Shift を押すたびに範囲が縮む)
        // ⚠ カーソルは**押した行**へ(範囲の端であって、起点ではない)
        next = withPaneSelection(pane, range, pane.anchor, action.lid);
      } else if (action.mode === 'toggle') {
        const has = pane.selection.includes(action.lid);
        const sel = has
          ? pane.selection.filter((l) => l !== action.lid)
          : [...pane.selection, action.lid];
        // ⚠ 起点は**外したときも**更新する(次の Shift はここから伸ばす)
        next = withPaneSelection(pane, sel, action.lid, action.lid);
      } else {
        next = withPaneSelection(pane, [action.lid], action.lid, action.lid);
      }
      return withDual(state, {
        ...withPane(state.dual, action.side, next),
        focus: action.side,
      });
    }
    case 'DUAL_SET_CURSOR': {
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      const pane = paneOf(state.dual, action.side);
      if (pane.cursor === action.lid && state.dual.focus === action.side)
        return withDual(state, state.dual);
      return withDual(state, {
        ...withPane(state.dual, action.side, withCursor(pane, action.lid)),
        // ⚠ 動かした側が「元」になる(押した側が焦点、と同じ規則)
        focus: action.side,
      });
    }
    case 'DUAL_TAB_ADD': {
      const pane = withTabAdded(paneOf(state.dual, action.side));
      if (pane === paneOf(state.dual, action.side)) return { state, events: [] };
      return withDual(state, {
        ...withPane(state.dual, action.side, pane),
        focus: action.side,
      });
    }
    case 'DUAL_TAB_CLOSE': {
      const pane = withTabClosed(paneOf(state.dual, action.side), action.index);
      if (pane === paneOf(state.dual, action.side)) return { state, events: [] };
      return withDual(state, {
        ...withPane(state.dual, action.side, pane),
        focus: action.side,
      });
    }
    case 'DUAL_CLEAR_SELECTION': {
      const pane = paneOf(state.dual, action.side);
      if (pane.selection.length === 0 && pane.anchor === null) return { state, events: [] };
      return withDual(
        state,
        /**
         * ⚠ **カーソルは残す**(2026-08-19)── ここは「移した直後に印を外す」
         *   ための入口なので、カーソルまで消すと**次の 1 打鍵が先頭へ飛ぶ**。
         */
        withPane(state.dual, action.side, withPaneSelection(pane, [], null, pane.cursor)),
      );
    }
    case 'DUAL_RENAME_BEGIN': {
      // ⚠ 実在しない行の名前は打てない(消えた行の入力欄を出さない)
      if (!state.entryMetas.has(action.lid)) return { state, events: [] };
      // ⚠ 打ち始めた側へ焦点も移す(他の押し方と揃える)
      return {
        state: {
          ...state,
          dual: { ...state.dual, focus: action.side, renaming: { side: action.side, lid: action.lid } },
        },
        events: [],
      };
    }
    case 'DUAL_RENAME_END': {
      if (state.dual.renaming === null) return { state, events: [] };
      return { state: { ...state, dual: { ...state.dual, renaming: null } }, events: [] };
    }
    case 'DUAL_SET_FILTER': {
      const pane = withPaneFilter(paneOf(state.dual, action.side), action.filter);
      if (pane === paneOf(state.dual, action.side)) return { state, events: [] };
      // 🔑 打った側へ焦点も移す(他の押し方と揃える)
      return withDual(state, {
        ...withPane(state.dual, action.side, pane),
        focus: action.side,
      });
    }
    case 'DUAL_BACK':
    case 'DUAL_FORWARD': {
      const cur = paneOf(state.dual, action.side);
      /**
       * ⚠ **押せないときは何もしない**(焦点も動かさない)── 端で押したときに
       *   焦点だけ動くと、「戻ったのに場所が同じ」に見える。
       */
      const can = action.type === 'DUAL_BACK' ? paneCanGoBack(cur) : paneCanGoForward(cur);
      if (!can) return { state, events: [] };
      const pane = action.type === 'DUAL_BACK' ? withPaneBack(cur) : withPaneForward(cur);
      return withDual(state, {
        ...withPane(state.dual, action.side, pane),
        focus: action.side,
      });
    }
    case 'DUAL_SET_PREVIEW': {
      if (state.dual.previewOn === action.on) return { state, events: [] };
      /**
       * ⚠ **切ったら中身も捨てる** ── 残すと、次に点けた瞬間に
       *   **前に見ていた行の本文**が一瞬出る(いま指している行のものではない)。
       */
      return withDual(state, { ...state.dual, previewOn: action.on, preview: null });
    }
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
    case 'PIN_SPLIT_ENTRY': {
      const meta = state.entryMetas.get(action.lid);
      // ⚠ 居ないものは留めない(消えた lid を指す枠を作らない)
      if (meta === undefined) return { state, events: [] };
      /**
       * ⚠ **フォルダは本文を持たない** ── 留めると枠が永久に空になる。
       * 🔑 断るときは**理由を言う**(黙って何も起きないのが dead click である)。
       */
      if (meta.archetype === 'folder')
        return {
          state: { ...state, notice: 'フォルダは横に並べられません(本文がありません)' },
          events: [],
        };
      const pinned = pinSplitLid(state.splitLids, action.lid);
      if (pinned === state.splitLids) {
        /**
         * ⚠ 「**もう一番上に在る**」と「**満杯**」を分ける ── 前者は黙ってよいが、後者は言う。
         * 🔑 直す前は「既に在る」を黙っていたが、いまは**載せ直すと先頭へ上がる**ので、
         *   黙るのは**もう先頭に在るとき**だけである(#633 段①)。
         */
        if (state.splitLids[0] === action.lid) return { state, events: [] };
        return {
          state: {
            ...state,
            notice: `スタックに載せられるのは ${String(STACK_MAX)} 件までです(1 つ降ろしてから載せてください)`,
          },
          events: [],
        };
      }
      return {
        state: { ...state, splitLids: pinned },
        // ⚠ 既に読めているなら読み直さない(留め直すたびに全文を往復させない)
        events: state.splitBodies.has(action.lid)
          ? []
          : [{ type: 'REQUEST_SPLIT_BODY', lid: action.lid }],
      };
    }
    case 'UNPIN_SPLIT_ENTRY': {
      const rest = unpinSplitLid(state.splitLids, action.lid);
      if (rest === state.splitLids) return { state, events: [] };
      return {
        state: { ...state, splitLids: rest, splitBodies: dropSplitBody(state.splitBodies, action.lid) },
        events: [],
      };
    }
    case 'SPLIT_BODY_LOADED': {
      /**
       * ⚠ **追い越しを捨てる**(`DUAL_PREVIEW_LOADED` と同じ)── 読みは非同期なので、
       * 外した後に届くことが普通に起きる。留めていないものは黙って捨てる。
       */
      if (!state.splitLids.includes(action.lid)) return { state, events: [] };
      if (state.splitBodies.get(action.lid) === action.body) return { state, events: [] };
      const bodies = new Map(state.splitBodies);
      bodies.set(action.lid, action.body);
      return { state: { ...state, splitBodies: bodies }, events: [] };
    }
    case 'SPLIT_RESTORED': {
      const restored = normalizeSplitLids(action.lids);
      if (restored.length === 0) return { state, events: [] };
      /**
       * ⚠ ここでは**知らない lid を落とさない** ── 起動の順で `entryMetas` が
       * まだ空のことがあり、落とすと**憶えた並びが黙って消える**。
       * 🔑 消えたノートは effect が本文 `null` を受けて外す(自己修復)。
       */
      return {
        state: { ...state, splitLids: restored },
        events: restored.map((lid) => ({ type: 'REQUEST_SPLIT_BODY', lid })),
      };
    }
    case 'DUAL_PREVIEW_LOADED': {
      /**
       * ⚠ **追い越しを捨てる**(#273 残件)── 読みは非同期なので、送った先の行を
       *   通り過ぎた後で届くことが普通に起きる。いま指している行のものでなければ
       *   **黙って捨てる**(古い本文を映すほうがずっと悪い)。
       */
      if (!state.dual.previewOn) return { state, events: [] };
      if (dualPreviewTarget(state, state.dual) !== action.lid) return { state, events: [] };
      if (state.dual.preview?.lid === action.lid && state.dual.preview.body === action.body)
        return { state, events: [] };
      return {
        state: {
          ...state,
          dual: { ...state.dual, preview: { lid: action.lid, body: action.body } },
        },
        events: [],
      };
    }
    case 'DUAL_TAB_ACTIVATE': {
      const cur = paneOf(state.dual, action.side);
      // ⚠ **実在するタブを押したときだけ**焦点を移す ── 存在しない添字で
      //    焦点が動くと、「押したものが在る」という嘘の合図になる
      if (!isTabIndex(cur, action.index)) return { state, events: [] };
      const pane = withTabActive(cur, action.index);
      if (pane === cur) return withDualFocus(state, action.side);
      return withDual(state, {
        ...withPane(state.dual, action.side, pane),
        focus: action.side,
      });
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
          // ⚠ 見ていた版も畳む(#398 段②)── 一覧が畳まれたら差分は孤児になる
          revisionPreview: null,
          selectedLid: action.meta.lid,
          openBody: {
            lid: action.meta.lid,
            body: action.body,
            baseline: action.body,
            persisted: action.body,
            diskAhead: false,
          },
          /**
           * 🔴 **復元も「新しい本文が state に入る所」である**(2026-08-20 に判明)。
           *
           * ⚠ 履歴の復元も ゴミ箱からの復元も、本文を**丸ごと**入れ替える ──
           *   板を開いたまま古い版へ戻すと、札は**入れ替わる前の行番号**を指したまま
           *   押せる。押すと**別の行が黙って完了になる**(#277 段②-b と同じ形)。
           * 🔑 この漏れは、手で数え直したのではなく **`tests/repo-hygiene.test.ts` が
           *   reducer を全数走査して見つけた** ── 宣言(「2 か所だけ」)を信じて
           *   いた間は、2 つとも見えていなかった。
           * ⚠ 上の editing 分岐は `persisted` の印だけを付ける(本文を差し替えない)
           *   ので、こちらは通さない ── そもそも編集中に板は開けない。
           */
          taskScan: refreshTaskCards(state.taskScan, action.meta.lid, action.body),
          // 🔑 タグが変われば、開いている入れ物の中身も変わる(#421 / user 要望 2026-08-26)
          smartHits: refreshSmartHits(
            state.smartHits,
            action.meta.lid,
            action.body,
            state.entryMetas,
          ),
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
    case 'OP_NOTICE':
      // ⚠ **`error` を触らない** ── 知らせが出たからといって、出ているエラーを
      //    消してよい理由は無い(`main.ts` が別の行として組んでいる)
      // ⚠ 「開く」の身元は知らせと**対で**置く ── 添えない知らせが来たら消える
      return {
        state: { ...state, notice: action.message, noticeOpen: action.open ?? null },
        events: [],
      };
    /**
     * 🔴 **タグの候補が要る**(#494 段②)。
     *
     * ⚠ **既に持っていれば何もしない** ── 焦点が当たるたびに全ノートの
     *   frontmatter を舐めると、打つ気になった瞬間に画面が重くなる。
     * 🔑 捨てるのは**タグを書いたとき**だけ(下の `BODY_REWRITTEN`)── だから
     *   「付けたばかりのタグが候補に出ない」は起きない。
     */
    case 'ASK_TAG_SUGGESTIONS': {
      if (state.phase !== 'ready') return { state, events: [] };
      if (state.tagSuggestions !== null) return { state, events: [] };
      return { state, events: [{ type: 'REQUEST_TAG_SUGGESTIONS' }] };
    }
    /**
     * ⚠ **空配列も答えである**(0 件だった)── `null` に戻さない。戻すと
     *   焦点が当たるたびに全走査が走る(#421 の `SMART_SCAN_FAILED` と同じ規律)。
     */
    case 'SET_TAG_SUGGESTIONS':
      return { state: { ...state, tagSuggestions: action.tags }, events: [] };
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
    // ⚠ **種類の絞りも渡す**(#411)── 渡さないと、添付だけを出しているときに
    //    ノートを消すと**画面に出ていないノート**が次に選ばれる(同じ事故の軸違い)
    const before = visibleOrder(
      state.order,
      (l) => state.entryMetas.get(l),
      entryFilterOf(state.filterQuery, state.searchHits, state.kindFilter),
    );
    const vIdx = before.indexOf(lid);
    const after = before.filter((l) => l !== lid);
    // ⚠ 絞り込みで残りが居なくなったら **null**(見えないものを選ばない)
    selectedLid = vIdx < 0 ? null : (after[Math.min(vIdx, after.length - 1)] ?? null);
    if (selectedLid) events.push({ type: 'REQUEST_BODY', lid: selectedLid });
  }
  // ⚠ 変化が無ければ**元の参照**のまま(下の docstring)
  const taskCards = state.taskScan === null ? null : withoutLid(state.taskScan.cards, lid);
  const scanTask =
    state.taskScan === null || taskCards === state.taskScan.cards
      ? state.taskScan
      : { ...state.taskScan, cards: taskCards! };
  const contactCards = state.contactScan === null ? null : withoutLid(state.contactScan.cards, lid);
  const scanContact =
    state.contactScan === null || contactCards === state.contactScan.cards
      ? state.contactScan
      : { ...state.contactScan, cards: contactCards! };
  const snippetItems = state.snippetScan === null ? null : withoutLid(state.snippetScan.items, lid);
  const scanSnippet =
    state.snippetScan === null || snippetItems === state.snippetScan.items
      ? state.snippetScan
      : { ...state.snippetScan, items: snippetItems! };

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
      snippetScan: scanSnippet,
      /**
       * 🔴 **消したノートを留めたままにしない**(#505 段②)。
       * ⚠ 残すと、その枠は**開けない lid** を指したまま空で居座る。
       * 🔑 #535 ② で `taskScan` 系に同じ穴が在ったのと**同じ形**である ──
       *   「1 件消す経路」に落とす処理を書き忘れる、が この repo の癖である。
       */
      splitLids: unpinSplitLid(state.splitLids, lid),
      splitBodies: dropSplitBody(state.splitBodies, lid),
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

/**
 * 🔴 **消えたノートの連絡先を落とす**(#278 段③ の動線レビュー 2026-08-28)。
 *
 * ⚠ **丸ごと `null` にしない** ── `SYS_BOOTED` は別タブが書くたびに飛ぶので、
 *   捨てると一覧が「集めています…」へ落ちて**行が飛ぶ**
 *   (`REFRESH_CONTACT_SCAN` が「消さない」と書いている理由と同じ)。
 * ⚠ 別 container(`cid` 違い)なら全部捨てる ── lid の偶然衝突を持ち越さない。
 * ⚠ 変化が無いなら**同じ参照**を返す(描画の指紋を無駄に壊さない ── `keepLinks` と同じ作法)。
 */
function keepContacts(
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
 *
 * @param refusal 編集中の断り文(押した場所と対で書く)
 * @param build 画面が見ている本文から書換を組む。組めなければ `null` = 黙って no-op
 *   (行が板でない / 値が壊れている ── どれも画面の操作からは起きない形)
 */
function bodyRewriteGate(
  state: AppState,
  lid: string,
  refusal: string,
  build: (shown: string) => BodyRewrite | null,
): ReduceResult {
  if (state.phase !== 'ready') return { state: { ...state, error: refusal }, events: [] };
  const meta = state.entryMetas.get(lid);
  if (!meta) return { state, events: [] };
  const shown = screenBodyOf(state, lid);
  if (shown === null) return { state, events: [] };
  const rewrite = build(shown);
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
function placeOpenLineOf(shown: string, line: number): string | null {
  if (!Number.isInteger(line) || line < 0) return null;
  const openLine = shown.split('\n')[line];
  return openLine !== undefined && isPlaceOpen(openLine) ? openLine : null;
}

/** 板の座標・大きさの値 ── 整数で 0 以上だけ(描画も負の値は捨てる)。 */
function isPlaceCoord(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

function dropSplitBody(
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
function refreshSmartHits(
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

function refreshTaskCards(
  scan: TaskScan | null,
  lid: string,
  body: string,
): TaskScan | null {
  if (scan === null) return null;
  const cards = replaceTaskCards(scan.cards, lid, body);
  return cards === scan.cards ? scan : { ...scan, cards };
}

function buildPersist(
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
    meta.archived !== ext.archived;
  const entryMetas = changed
    ? new Map(state.entryMetas).set(meta.lid, { ...meta, ...ext })
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
