/**
 * ActionBinder(PKC2 規約の維持): root での event delegation。
 * data-pkc-action を読んで UserAction を dispatch するだけ ── DOM は描かない。
 * action テーブルは登録制(編集系はここ、markdown ブロック系は P3-5 後半)。
 *
 * editor の本文は input delegation で都度 UPDATE_OPEN_BODY に写す(state が常に
 * 現在値を持つ ── dirty 判定・将来の autosave の土台)。1 打鍵 = 1 reduce は
 * openBody の spread のみで、描画側は編集中ガードで DOM を触らない。
 * 実測(run-editor-probe、15k 件・実 UI 経路): 小 body で打鍵 p50 ≈0ms、
 * 200KB body でも dispatch 有無の差は run 間ノイズに埋もれる(textarea 自体の
 * DOM コストが支配的)。⚠ 200KB 級では value 読取が打鍵ごとに O(body) の
 * string を作る ── GC churn が数字に出たら debounce / collect-at-commit へ
 * 切り替える(その時に計測してから)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { deliveredEntryOf, type ExtDeliveredEntry } from '@features/extension/ext-delivery';
import { isLaunchableUrl } from '@features/launcher/tiles';
import { toggleHeadingFold } from '../render/heading-fold';
import { quoteOnEnter } from '@features/markdown/quote-assist';
import { renumberLists } from '@features/markdown/list-renumber';
import { stripDialect } from '@features/markdown/strip-dialect';
import { isViewMode, nextViewMode, type AppState, type ViewMode } from '@adapter/state/app-state';
import type { EntryMeta } from '@core/model/entry-meta';
import {
  filerRows,
  operationTargets,
  smartLidsOf,
  visibleSelection,
} from '@features/relation/filer-list';
import { archetypeLabel } from '@adapter/ui/render/sidebar';
import { SMART_FIELDS, type SmartField } from '@features/smart/smart-spec';
import {
  buildSettingsFile as buildSettingsFileData,
  canApplySettings,
  planSettingsImport,
  settingsChangeText,
  settingsFileName,
  settingsPlanNote,
} from '@features/settings/settings-file';
import { downloadBlob } from '@adapter/platform/download';
import { ARCHETYPE_ICONS, setIcon } from '@adapter/ui/render/icons';
import { insertText } from '@adapter/ui/render/row-swap';
import {
  entryPickNote,
  entryPickRows,
  entryPickTotal,
} from '@features/entry-ref/entry-pick';
import { formatEntryLink } from '@features/entry-ref/entry-ref-format';
import { insertionForLineDate } from '@features/schedule/line-date';
import { addDays, daysBetween } from '@features/datetime/date-math';
import {
  DATE_SHORTCUTS,
  isDateShortcut,
  shortcutDate,
} from '@features/schedule/date-shortcuts';
import { findTodayNote, todayNoteTitle } from '@features/schedule/today-note';
import { formatLineDate } from '@features/schedule/line-date';
import { isImageAssetMime } from '@features/asset/asset-ref-format';
import {
  adoptableUrls,
  externalImageUrls,
  rewriteAdopted,
} from '@features/asset/inline-url-adopt';
import {
  ADOPTED_IMAGE_PREFIX,
  PASTED_IMAGE_PREFIX,
  describeAdoptFailures,
  type AdoptOutcome,
} from './adopt-urls';
import { convertPastedHtml } from '@features/markdown/html-to-markdown';
import { convertPastedRtf } from '@features/markdown/rtf-to-markdown';
import {
  choosePaste,
  describePaste,
  DEFAULT_PASTE_SOURCE,
  type PasteSource,
} from '@features/markdown/paste-source';
import { convertPastedPermalink } from '@features/link/permalink';
import { resolveMime } from './attach';
import { applyFormat, type FormatOp } from '@features/markdown/text-ops';
import { insertSnippet, nextSnippetSlot } from '@features/snippet/snippet-expand';
import { abbrBeforeCaret } from '@features/snippet/snippet-table';
import { snippetMenu, snippetMenuNote } from '@features/snippet/snippet-menu';
import { appendHeadingFor, isAppendable } from '@features/flavor/append-spec';
import { normalizeTag } from '@features/flavor/tags';
import { isEntrySort, NATURAL_DESC } from '@features/filter/entry-sort';
import { isPaneId, PANES } from '@features/pane-visibility';
import { STRUCTURAL, isRelationKind } from '@features/relation/kinds';
import { canEnterScope, getAncestorFolders } from '@features/relation/tree';
import { planCopy } from '@features/relation/copy-plan';
import {
  otherSide,
  paneFilterOptions,
  paneOf,
  paneScope,
  type DualSide,
} from '@features/relation/dual-pane';
import { appPanes, applyPaneVisibility } from '@adapter/ui/render/pane-visibility';
import { appKeymap, type KeymapStore } from '@adapter/ui/render/keymap';
import { appOpenInEdit, OpenInEditStore } from '@adapter/ui/render/open-in-edit';
import { chordOf, findCommand, isMac, typesCharacter, KEY_COMMANDS } from '@features/keymap';
import { paletteRows } from '@features/palette/palette-rows';
import { structureText } from '@features/structure/structure-text';
import {
  profileLineText,
  profileLines,
  profileSummary,
  sharedNote,
  type StorageProfileResult,
} from '@features/storage/storage-profile';
import {
  canApplyPlan,
  parsePlan,
  planPreview,
  resolvePlanTarget,
} from '@features/structure/structure-plan';
import { appQueryKey } from '@adapter/ui/render/query-key-store';
import { openView } from '@adapter/ui/render/open-view';
import {
  CLOSE_VIEW_WINDOW_REFUSED,
  type CloseViewWindowResult,
} from '@adapter/platform/view-window';
import { parseLinkTarget } from '@features/entry-ref/link-target';
import { flashCopied, handleCopyMdBlock } from './copy-md-block';
import { finishCopy, selectedMarkdown } from './copy-source';
import { copyMarkdownAndHtml, copyPlainText } from '@adapter/platform/clipboard';
import { cleanForClipboard } from '@features/export/clipboard-html';
import {
  confirmInApp,
  pickDateInApp,
  pickCommandInApp,
  pickEntryInApp,
  pickSnippetInApp,
  isAppDialogOpen,
  type ConfirmOptions,
} from '@adapter/ui/render/app-dialog';

type ActionHandler = (
  dispatcher: Dispatcher,
  target: HTMLElement,
  services: BinderServices,
  /** 束ねた root。⚠ **押したボタンから辿れない**ときに使う ── 追記は
   *  START_EDIT で detail を描き直すので、target は既に外れている */
  root: HTMLElement,
) => void;


/** 既定 title の種別ラベル(連番は同 archetype の現在数 + 1)。 */

/** lid: epoch(base36)+ セッション内単調 counter(PKC2 と同系の形式)。 */
let lidCounter = 0;
export function generateLid(): string {
  lidCounter += 1;
  return `${Date.now().toString(36)}-${lidCounter.toString(36).padStart(4, '0')}`;
}

/**
 * 🔴 **いまフォルダ面に出ている行**(着地前レビュー 2)。
 * ⚠ 規則は `filerRows` **1 か所**を通す ── 描く側(`render/filer.ts`)・
 * 範囲選択(reducer)・ここが別々に並びを組むと、**目で見たものと動くものが
 * 食い違う**(CLAUDE.md §7)。
 */
const visibleFilerRows = (st: AppState): EntryMeta[] =>
  filerRows(st.scopeLid, st.entryMetas, st.relations, {
    smartLids: smartLidsOf(st.scopeLid, st.smartHits),
    filterQuery: st.filterQuery,
    searchHits: st.searchHits,
    sort: st.entrySort,
    sortDesc: st.entrySortDesc,
    kinds: st.kindFilter,
  });

/** その entry が**既にそこに居る**か(動かす必要が無い)。 */
const alreadyThere = (st: AppState, lid: string, parentLid: string | null): boolean => {
  const parents = st.relations.filter((r) => r.kind === STRUCTURAL && r.toLid === lid);
  return parentLid === null
    ? parents.length === 0
    : parents.length === 1 && parents[0]?.fromLid === parentLid;
};

/**
 * 🔴 **居場所を変える唯一の実体**(着地前レビュー 7)。帯の `<select>` と
 * D&D が**別々に**書いていたので、断り方と「付いていく」の規則が経路で違った ──
 * 帯は phase を見ずに撃って reducer が黙って捨て(無言の操作拒否)、拒否されても
 * `SET_SCOPE` だけは撃つので**動いていないのに画面だけ移動**した。
 *
 * ⚠ **既にそこに居る**ものは失敗に数えない(着地前レビュー 6)── ルート直下の
 * 物をルートへ落としたとき「フォルダは自分の中へは入れられません」と出ていた。
 * 理由の違う断りを出すと、user は**入れ子の話だと読んで別のものを探す**。
 */
/**
 * 押した物から**どちらのペインか**を辿る(#241 段⑥-a)。
 * ⚠ state の `focus` から推測しない ── 焦点の無いほうを押したときに
 *   **反対側が動く**(押した所と効く所が違う、いちばん気づけない形)。
 */
const dualSide = (target: HTMLElement): DualSide | null => {
  const raw = target.closest('[data-pkc-side]')?.getAttribute('data-pkc-side');
  return raw === 'left' || raw === 'right' ? raw : null;
};

/**
 * 🔴 **そのペインに出ている行 ── 引く口はここ 1 つ**(#273 残件)。
 *
 * ⚠ 直す前は**同じ式が 6 か所**に書き写されていた(写す / 移す / ゴミ箱 / 落とす /
 *   鍵の行送り / 描く側)。ペインごとの絞り込みを足したとき、**1 か所でも
 *   書き替え忘れると、そこだけ別の並びで数える** ── 症状は「目で見た範囲と
 *   選ばれる範囲が違う」という、いちばん気づけない形になる(CLAUDE.md §7)。
 * 🔑 絞り込みの規則そのものは `paneFilterOptions`(features 層)が持つ ──
 *   reducer も描く側も**同じ関数**を通る。
 */
const dualPaneRows = (st: AppState, side: DualSide): EntryMeta[] => {
  const pane = paneOf(st.dual, side);
  return filerRows(paneScope(pane), st.entryMetas, st.relations, {
    smartLids: smartLidsOf(paneScope(pane), st.smartHits),
    ...paneFilterOptions(pane, st.filterQuery, st.searchHits),
    sort: st.entrySort,
    sortDesc: st.entrySortDesc,
    kinds: st.kindFilter,
  });
};

/**
 * 🔴 **2 ペインの「作る」は 1 か所**(#273)── フォルダもノートも、
 * 違うのは**種類と名前だけ**である。
 *
 * ⚠ **編集に入らない**(`edit: false`)── 入ると中央が本文の面へ切り替わり、
 *   整理の途中で面から放り出される。作ったら**その場に出る**のが FD の作法である。
 * ⚠ 入れ先は**そのペインが開いている場所**(左の列の現在地ではない)── ここを
 *   `state.scopeLid` で書くと、**押したペインと違う場所に**できる。
 * ⚠ 押した所からペインを辿り、辿れないときだけ焦点に落ちる(鍵から呼ぶと的が無い)。
 */
const dualCreate = (
  dispatcher: Dispatcher,
  target: HTMLElement,
  archetype: 'folder' | 'text',
): void => {
  const side = dualSide(target) ?? dispatcher.getState().dual.focus;
  const st = dispatcher.getState();
  const what = archetype === 'folder' ? 'フォルダ' : 'ノート';
  if (st.phase !== 'ready') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `編集を終了してから${what}を作ってください` });
    return;
  }
  dispatcher.dispatch({
    type: 'CREATE_ENTRY',
    archetype,
    lid: generateLid(),
    title: `新しい${what}`,
    parentLid: paneScope(paneOf(st.dual, side)),
    relationId: generateLid(),
    edit: false,
  });
};

/** タブの添字。⚠ 数として読めないものは**捨てる**(0 に落とすと別のタブが閉じる)。 */
const dualTabIndex = (target: HTMLElement): number | null => {
  const raw = target.closest('[data-pkc-tab]')?.getAttribute('data-pkc-tab');
  // ⚠ **ここが唯一の関所ではない**(着地前レビュー M5)── 下流の `withTabClosed` /
  //    `withTabActive` にも `Number.isInteger` の門を置いてある。上流 1 行だけが
  //    守っている形にすると、その 1 行を消す変異が誰にも殺されない
  if (raw === null || raw === undefined || !/^\d+$/.test(raw)) return null;
  return Number(raw);
};

const moveEntries = (
  dispatcher: Dispatcher,
  lids: readonly string[],
  parentLid: string | null,
  report?: (text: string) => void,
): void => {
  if (lids.length === 0) return;
  if (dispatcher.getState().phase !== 'ready') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから動かしてください' });
    return;
  }
  let moved = 0;
  let same = 0;
  for (const lid of lids) {
    const st = dispatcher.getState();
    if (alreadyThere(st, lid, parentLid)) {
      same += 1;
      continue;
    }
    const before = st.relations;
    dispatcher.dispatch({ type: 'SET_ENTRY_PARENT', lid, parentLid, relationId: generateLid() });
    if (dispatcher.getState().relations !== before) moved += 1;
  }
  const refused = lids.length - moved - same;
  if (moved === 0 && same === 0) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: 'そこへは入れられません(フォルダは自分の中へは入れられません)',
    });
    return;
  }
  // ⚠ 一部だけ断られたときも**黙らない**(何件動いていないかを言う)
  if (refused > 0) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `${refused} 件は入れられませんでした(フォルダは自分の中へは入れられません)`,
    });
  }
  /**
   * 🔴 **画面は動かさない**(user 裁定 2026-08-18「**OS のファイラ動作に似せる方向で
   * 平仄も合わせて、日常の違和感が減る**」)。OS のファイラは、入れた先へ勝手に
   * 移動しない ── 入れたものが**いまの場所から消える**のが標準の見え方である。
   *
   * ⚠ ただし **PKC3 は行き先を名乗る** ── 「無言で終わらせない」を通してきたので、
   *   消えたのか入ったのかが分かる 1 行だけ残す(OS より一言多い)。
   * ⚠ 知らせは `OP_FAILED` に載せない(あれは**エラーの行**)── `showStatus` は
   *   `main.ts` の「一時の知らせ」へ出る。
   */
  const where =
    parentLid === null
      ? 'ルート'
      : (dispatcher.getState().entryMetas.get(parentLid)?.title ?? 'フォルダ');
  report?.(`${moved + same} 件を「${where}」へ入れました`);
};

/** UI サービス面(storage 依存の操作は main が実体を注入。test は fake)。 */
export interface BinderServices {
  attachFiles?(files: File[]): void;
  /**
   * 🔴 **スクショ(画像)の貼付**(#250。user 指示 2026-08-18
   * 「PKC3 でスクショ貼付の導線がない。PKC2 と同様以上に実装してください」)。
   *
   * 資産として置いて、**本文に差し込む参照(markdown)**を返す。
   * ⚠ **ノートは作らない** ── 編集中は `CREATE_ENTRY` が黙殺されるので、
   *   そこに乗せると bytes だけ残って参照が消える(`storeAsset` の注記)。
   * ⚠ 置けなかったものは**返さない**(呼び側が「落とした」と言えるように件数で分かる)。
   */
  pasteImages?(files: readonly File[]): Promise<readonly string[]>;
  /**
   * 🔴 **写す(コピー)のために本文をまとめて読む**(#273 段③)。
   * ⚠ **省略可** ── 無い環境(test の fake / 旧い配線)では「この版では写せません」と
   *   断るだけで、他は壊れない(落ち方は「機能が減る」側 ── `store-effects` と同じ規律)。
   * ⚠ 読めなかった lid は**返さない**(呼び側が件数で「落とした」と言える)。
   */
  readBodies?(lids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * 🔴 **飛んでいる書込が着くまで待つ**(#288)。
   *
   * ⚠ 書込は effect 層の chain に直列化されるが、**編集の開始はその外**に在る ──
   *   チェックの印を押した直後に「編集」へ入ると、入力欄には**押す前の本文**が出て、
   *   そこで 1 文字でも打つと可視内容の last-write-wins で**押した印が黙って戻る**。
   * 🔑 待つ口は既に在る(`connectStoreEffects().settled()` ── 書き出しが
   *   2026-08-17 に同じ穴で作ったもの)。**2 本目を作らない**。
   * ⚠ **省略可**(`undefined` / `null`)── 無い環境では今までどおり同期に始まる。
   */
  settle?(): Promise<void> | null;
  /**
   * 🔴 **開いている拡張へ実体を 1 件渡す**(#195 / C-5 段②-b)。
   *
   * ⚠ **省略可** ── 無い環境(test の fake / 旧い配線)では「この版では送れません」と
   *   断るだけで、他は壊れない(`readBodies` と同じ規律)。
   * @returns 渡せたか。⚠ `false` = その窓がもう無い / 港が繋がっていない
   */
  deliverToExtension?(linkId: string, entry: ExtDeliveredEntry): boolean;
  downloadAsset?(assetKey: string, name: string): void;
  /**
   * 🔴 **貼る用に画像を持ち歩ける形へ**(#193)。`blob:` → `data:` の対応を返す。
   * ⚠ **省略可** ── 無ければ画像は文字に置き換わる(壊れた画像を貼らせない)。
   */
  inlineImages?(urls: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * 🔴 **貼り付けた本文の `data:` / `blob:` を資産にする**(#251 の B + C)。
   * `url → asset:<key>` の対応を返す。⚠ **読めなかった url は入れない** ──
   * 呼び側が「元のまま残した」と件数で言えるようにする(黙って消さない)。
   * ⚠ **省略可** ── 無ければ本文はそのまま(貼付自体は成立する)。
   */
  /**
   * 🔴 **一時の知らせ**(「3 件を『はこ』へ入れました」)。⚠ エラー(`OP_FAILED`)とは
   * **別の行**である ── `main.ts` が優先順位(エラー > 知らせ > 常設)を持っているので、
   * 成功の一報を `OP_FAILED` に載せない(載せると赤い意味の欄に出る)。
   */
  showStatus?(text: string): void;
  /**
   * 🔴 **何が容量を食っているか**(#415)── worker に数えさせる。
   * ⚠ **数字だけ**返ってくる(本文も bytes も境界を越えない)。
   * ⚠ 無い配線では**押しても何も起きない**ので、器は「調べています…」で止めない。
   */
  storageProfile?(): Promise<StorageProfileResult>;
  /**
   * 🔴 **本文の画像を資産にする**(貼付 = #251 / 押して取り込む = #264 段①)。
   * ⚠ `namePrefix` は**名乗り** ── 置けなかったときの断り文に名前が出るので、
   *   どちらの操作で失敗したのかが読める形にする。
   * ⚠ 入らなかったものは**理由つき**で返る(#264 段②)── 文言に組むのは
   *   `describeAdoptFailures` の 1 本(呼び側で綴り直さない)。
   */
  adoptUrls?(urls: readonly string[], namePrefix: string): Promise<AdoptOutcome>;
  /**
   * 🔴 **添付を別の窓で見る**(#192 で画像、2026-08-15 に PDF を追加)。
   * ⚠ 実体は adapter/platform 側(ObjectURL の寿命が絡むので、binder は**呼ぶだけ**)。
   * ⚠ `mime` は**押した要素が運ぶ** ── 開く側で引き直さない。
   */
  viewAsset?(assetKey: string, name: string, mime: string): void;
  /** 未参照 asset の掃除(P4b)。確認・報告の UI も実体側の責務。 */
  purgeOrphanAssets?(): void;
  /** 注意の面を閉じる(P6c review H-2)。 */
  dismissNotices?(): void;
  /**
   * 🔴 **アプリの窓なら、`× 閉じる` で窓ごと閉じる**(#300 段③ の直し、2026-08-22)。
   *
   * ⚠ 実体は `platform/view-window.ts`(`window.close()` に触るので binder は
   *   **呼ぶだけ**)。⚠ 本体のタブでは配線されない ── `undefined` のときは
   *   今までどおり面を畳む。
   * @returns 閉じた / アプリの窓だが閉じられなかった / ふつうの窓
   */
  closeViewWindow?(): CloseViewWindowResult;
  /**
   * ランチャーのタイルを起動する(P7b 段⑩)。
   * ⚠ blob の貸し出し・`window.open` は実体側 ── binder は DOM を触らない。
   */
  openTile?(lid: string): void;
  /**
   * 🔴 **選んでいる添付を起動する**(P10、user 指示 2026-08-05
   * 「HTML アセットの詳細画面から起動できない」)。
   *
   * ⚠ タイル(`openTile`)とは**別**である ── あちらは「アプリとして登録」した
   * ものを lid で引くが、こちらは**登録の有無に依存しない**(開けることと
   * 一覧に並べることは別の話)。
   * ⚠ `sameOrigin` は詳細画面の別のボタンからのみ true になる。
   */
  launchAsset?(lid: string, opts: { sameOrigin?: boolean; extension?: boolean }): void;
  /**
   * 🔴 **添付を Office の別窓で開く**(#88 / O3-c。user 裁定 2026-08-10)。
   *
   * ⚠ `launchAsset` とは**別**である ── あちらは HTML アプリを囲いの中で走らせる。
   * こちらは LibreOffice wasm の窓に文書を流し込む。
   * ⚠ **同期で呼ぶ**(実体側が `window.open` を user gesture の中で撃つ)。
   * ⚠ 引数は押したボタンの属性から採る ── lid から本文を読み直す暇が無い。
   */
  openOffice?(target: { name: string; mime: string; assetKey: string; lid: string }): void;
  /**
   * 🔴 **Office 一式(約 77MB)を入れる / 消す**(#88 / O6-a。user 裁定 2026-08-10
   * 「実行したい人が手動で設定した際に追加ダウンロードと idb とか opfs に配備して」)。
   *
   * ⚠ **勝手に取りに行かない** ── 押した人にだけ取らせる。
   * ⚠ `installOfficePackFromFile` は**配布元に届かない環境の唯一の道**なので、
   *   保険ではなく一級の導線として扱う(user 裁定「ローカルとかを介して」)。
   */
  installOfficePack?(): void;
  installOfficePackFromFile?(file: File): void;
  removeOfficePack?(): void;
  /** 配色を切り替える(P7b 段⑨c)。⚠ user の好みで、flag でも container でもない。 */
  setTheme?(theme: string): void;
  /**
   * 外部の画像を読み込むかの設定(2026-08-06、user 裁定)。
   * ⚠ 「常にオン / 常に確認 / 常にオフ」の 3 択。⚠ flag ではない(正規設定)。
   */
  setExternalImages?(mode: string): void;
  /** 素のまま起動の許可を 1 件外す(#301)。⚠ 鍵は**中身のハッシュ**。 */
  revokeSameOrigin?(assetKey: string): void;
  /** 目次を見せる許可を取り消す(#195)。 */
  revokeExtension?(assetKey: string): void;
  /**
   * 紙面(2026-08-08、user 裁定「A4 と A3、フル HD と 4:3 の縦横」)。
   * ⚠ **flag ではない**(正規設定)── 散文の読み幅と、印刷の紙が決まる。
   */
  setPageFormat?(format: string): void;
  /**
   * 編集の仕方(#104 第 2 弾。user 裁定 2026-08-08)。
   * ⚠ **flag ではない**(正規設定)── 効くのは次に編集を開いたとき。
   */
  setEditorMode?(mode: string): void;
  /**
   * 添付の携帯参照(`pkc://<自分>/asset/<key>`)から**所有ノートへ飛ぶ**(#100 段②)。
   * ⚠ 見つからないときは黙らない(OP_FAILED で断る ── 無言の dead click を作らない)。
   */
  navigateAssetRef?(assetKey: string): void;
  /**
   * 編集権を取る(#177 多重タブ ── 同じノートの 2 枚目編集を止める)。
   * false = 別のタブが編集中。⚠ 判断(台帳)は storage proxy 側が持つ。
   * ⚠ 解放の正本は main.ts の phase 遷移 watcher ── ここの release は
   *   「取ったのに編集に入れなかった」ときの返却だけ。
   */
  acquireEditLock?(lid: string): Promise<'granted' | 'denied' | 'unreachable'>;
  releaseEditLock?(lid: string): void;
  /**
   * フラグの切替(P11。user 指示 2026-08-07)。
   * ⚠ **設定ではない** ── 開発者・パワーユーザー向けで、いつか畳まれる。
   */
  setFlag?(name: string, on: boolean): void;
  resetFlags?(): void;
  /**
   * いま開いているノートについて答えた(「常に確認」の帯の 2 つのボタン)。
   * ⚠ **ノート単位**で、覚えるのはタブを閉じるまで。⚠ 設定は変えない ──
   *   1 件の判断で全ノートの既定を動かさない。
   */
  answerExternalImages?(allow: boolean): void;
  /** 左の列の探し方(一覧 / フォルダ / アプリ)。⚠ 中央のビューとは別の軸(P8 段⑤)。 */
  setBrowse?(mode: string): void;
  /** 新しい版に交代する(P7 段⑤)。⚠ 交代を頼むだけ ── 再読込は交代後。 */
  applyUpdate?(): void;
  /**
   * 起動したときのお知らせ(P11 段⑤)。
   * ⚠ `dismiss` は**読んだことにする**(次から出ない)。`mute` は**今後出さない**
   *   ── 設定から戻せる(戻せない導線は作らない)。
   */
  dismissAnnounce?(): void;
  muteAnnounce?(): void;
  /**
   * お知らせを出すかの設定(P11 段⑤)。⚠ **flag ではない**(正規設定)──
   * 開放先は user で、畳む予定も無い。⚠ 帯の「今後は出さない」の**戻し道**である。
   */
  setNoticesEnabled?(on: boolean): void;
  /**
   * 「開く」で編集に入るか(user 裁定 2026-08-18)。⚠ **flag ではない**(正規設定)。
   * ⚠ 読む側は `services` ではなく `openInEdit` を引く(下の `bindActions` の引数)──
   *   ここは**書き手**だけ。
   */
  setOpenInEdit?(on: boolean): void;
  /** 更新の案内を見送る(次に開いたときに再び出る)。 */
  dismissUpdate?(): void;
  /** アーカイブ書出し(P6d)。 */
  exportArchive?(): void;
  /** 可搬 HTML の書出し(P6d 段③)。 */
  exportHtml?(): void;
  /** md ZIP の書出し(P6d 段④)。 */
  exportMarkdown?(): void;
  /**
   * 🔴 **可搬単一 HTML**(#400 段④)── アプリごと 1 枚に焼く。
   * ⚠ 「閲覧用 HTML」とは別物である(あちらは読むだけ、こちらは**続きが書ける**)。
   */
  exportPortable?(): void;
  /**
   * 🔴 **貼付でどの形を読むか**(user 指示 2026-08-25)── 設定の 4 択。
   * ⚠ 渡されなければ `auto`(いままでどおり)。
   */
  pasteSource?(): PasteSource;
  /**
   * 🔴 **何が届いてどれを使ったかを出すか**(flag `paste.inspect`)。
   * 🔑 設定(上)と**対**である ── これが見えるから、user はどれに切り替えれば
   *   よいか分かる。⚠ 渡されなければ出さない。
   */
  pasteInspect?(): boolean;
  /** 設定を変える(設定画面の選択)。⚠ 知らない値は呼び側が捨てる。 */
  setPasteSource?(id: string): void;
  /**
   * 🔴 **2 ペインの「留めた場所」を足す / 外す**(#273 残件)。
   * ⚠ **端末の保存**である(container に入れない)── だから state ではなく
   *   services を通す(`setFlag` / `setPasteSource` と同じ作法)。
   */
  toggleDualBookmark?(lid: string): void;
  /**
   * 🔴 **2 ペインの下見を憶える**(#273 残件)。
   * ⚠ **効かせるのは reducer**(`DUAL_SET_PREVIEW`)で、ここは**憶えるだけ**である
   *   ── 分けてあるのは、下見の要否を毎回の描画で読むと storage を叩くからである。
   */
  rememberDualPreview?(on: boolean): void;
  /** このノートを Word(.docx)で書き出す(#187 段①)。 */
  exportEntryDocx?(lid: string): void;
  /** このノートを PowerPoint(.pptx)で書き出す(#187 段⑤)。 */
  exportEntryPptx?(lid: string): void;
  /** 紙に出す(#187)── 中央の面に開いてからブラウザの印刷を呼ぶ。 */
  printNote?(lid: string): void;
  /** このノートだけをアーカイブとして書き出す(P6f)。 */
  exportEntry?(lid: string): void;
  /** 🔴 **このフォルダと配下**をアーカイブとして書き出す(#399 ①)。 */
  exportFolder?(lid: string): void;
  /**
   * 図 1 枚をベクタ(`.svg`)で書き出す(P8 段⑦)。
   * ⚠ 画面に置くのは PNG、書き出すのは SVG(user 指示 2026-08-03)。
   * @param index 同じ本文の中で**何枚目か**(0 始まり ── 名前は 1 始まりにする)
   */
  /** ⚠ **Promise を返す** ── 押した側が「終わった」を知らないと待ちを出せない。 */
  exportDiagram?(source: string, index: number): void | Promise<void>;
  /** 文字列をクリップボードへ(P8 段⑱)。⚠ 失敗も可視で終える。 */
  copyText?(text: string): void;
  /**
   * 添付 gate(書出し / 取込 / 整理)が実行中か。
   * ⚠ **破壊的操作を止めるために要る**(P6f review M-2)── 「書き出す」と「削除」を
   * 隣に並べた以上、走査中に消せてしまうと **user は書き出したつもりでファイルが
   * 1 個も落ちていない**状態になる。
   */
  busy?(): boolean;
  /**
   * 🔴 **開いた md を元ファイルへ書き戻す**(2026-08-05、user 報告
   * 「スポットの編集プレビュー導線も存在しない」)。
   * ⚠ 確認・許可・書込は実体側 ── binder は「押された」を伝えるだけ。
   */
  writeBackFile?(lid: string): void;
  /** PKC2 ファイルの取込(P6b)。判別・変換・書込は実体側の責務。 */
  /** 取込(PKC2 の書出し / 素の Markdown)。振り分けは import-file.ts が持つ。 */
  importFiles?(files: File[]): void;
}

function defaultTitle(dispatcher: Dispatcher, archetype: string): string {
  const label = archetypeLabel(archetype);
  let n = 0;
  for (const m of dispatcher.getState().entryMetas.values()) {
    if (m.archetype === archetype) n += 1;
  }
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${date} ${label} ${n + 1}`;
}

/**
 * cancel 経路: fresh entry(作成直後)で title だけ入力されていた場合は、
 * title を RENAME で保存してから cancel する ── 「title を打って Esc」で
 * entry ごと消えて入力が失われる非対称の解消(P3-7a review 中)。
 * 非 fresh の cancel は破棄の意味論どおり title input も捨てる。
 */
function cancelFromEditor(dispatcher: Dispatcher, root: HTMLElement): void {
  const s = dispatcher.getState();
  const lid = s.openBody?.lid;
  if (lid && s.freshLid === lid) {
    const input = editorTitle(root);
    const current = s.entryMetas.get(lid)?.title ?? '';
    if (input && input.value.trim() !== '' && input.value.trim() !== current) {
      // RENAME が fresh を解除する ── 直後の CANCEL は entry を残す
      dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title: input.value });
    }
  }
  dispatcher.dispatch({ type: 'CANCEL_EDIT' });
}

/**
 * いま画面に出ている題名欄。
 *
 * 🔴 **root から引く**(P8 段⑲。押したボタンから `closest` で辿らない)。
 * 直す前は `from.closest('[data-pkc-region="detail"]')` だったが、
 * 追記欄(`append` region)の **保存して解放 / 編集を破棄** は detail の
 * **兄弟**なので `closest` が null を返し、題名欄が 1 度も見つからなかった
 * ── その出口から保存すると**題名の変更が丸ごと捨てられて**いた。
 * 同じ「保存」なのに押す場所で結果が違う、という壊れ方である。
 * ⚠ 入口は 1 つに寄せる(`editorBody` と同じ引き方)。
 */
function editorTitle(root: HTMLElement): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(
    '[data-pkc-region="detail"] [data-pkc-field="editor-title"]',
  );
}

/** editor 表示中なら title input の現在値で RENAME を先行 dispatch する
 *  (楽観 meta 更新 → 直後の COMMIT_EDIT が新 title で行を組む。
 *  input が見つからなければ何もしない = 既存 title 維持 ── PKC2 の
 *  「title が消える」bug の防波堤と同じ向き)。 */
function renameFromEditorInput(dispatcher: Dispatcher, root: HTMLElement): void {
  const input = editorTitle(root);
  const lid = dispatcher.getState().openBody?.lid;
  if (input && lid)
    dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title: input.value });
}

/** いま画面に出ている編集欄(root にスコープする ── document 全域は他 root を拾う)。 */
function editorBody(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>(
    '[data-pkc-region="detail"] [data-pkc-field="editor-body"]',
  );
}

/**
 * 🔴 **書式の効く先**(2026-08-08)。2 列なら `editor-body`、live の 1 面なら
 * **活性の行の入力欄**(`row-source`)── 直す前は live 面で書式パネルと
 * Ctrl+B/I/K が `editor-body` を探して**無言 no-op** だった(押しても何も
 * 起きず、理由もどこにも出ない)。
 * ⚠ 2 つは同時には存在しない(live ↔ 2 列は排他。live の退避は `editor-body`)。
 * ⚠ `writeBack` の `value` 直代入は行の中の Ctrl+Z を捨てる ── 行は Escape で
 * 丸ごと戻せるので、2 列の editor と同じ理由で受け入れる。
 */
function formatTarget(root: HTMLElement): HTMLTextAreaElement | null {
  return (
    root.querySelector<HTMLTextAreaElement>(
      '[data-pkc-region="detail"] [data-pkc-field="row-source"]',
    ) ?? editorBody(root)
  );
}

/** 読む面の描画済み本文(コピーの書式付き / 選択範囲が読む)。 */
function viewBodyHost(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    '[data-pkc-region="detail"] [data-pkc-field="detail-body"]',
  );
}

/**
 * 書き換えた本文を編集欄へ戻す。
 *
 * 🔴 **`input` を自分で撃つ**。ここで state へ直に `UPDATE_OPEN_BODY` を送ると、
 * 経路が 2 本になる(binder の delegation と、この関数)── 片方を壊しても
 * もう片方に救われて test が緑のまま通るので、**入口は 1 つに寄せる**。
 * プレビューも textarea の `input` で駆動しているので、これ 1 発で state と
 * 画面の両方が追いつく。
 *
 * ⚠ `value` の直代入はブラウザの取り消し履歴(Ctrl+Z)を捨てる。書式パネルは
 * 「保存 / キャンセル」で丸ごと戻せるので、ここでは受け入れる ── 取り消しを
 * 残すには `execCommand('insertText')` が要るが、経路が 2 本になる。
 */
function writeBack(
  ta: HTMLTextAreaElement,
  next: { text: string; start: number; end: number },
  toBottom = false,
): void {
  ta.value = next.text;
  ta.setSelectionRange(next.start, next.end);
  ta.focus();
  // 追記はカーソルが末尾 ── 見えていないと「押しても何も起きない」に見える
  if (toBottom) ta.scrollTop = ta.scrollHeight;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * 🔴 **書出し / 取込の実行中は、本文を書き換えさせない**(P8 段㉑)。
 *
 * 直す前この判定は `delete-entry` **1 か所だけ**にあった。ところが書出しは
 * 本文を 4MB ずつページングし(`await` を跨ぐ)、そのあとで履歴の鎖を引く ──
 * バッチの隙間に保存が割り込むと、**同じノートの本文は旧版、鎖の頭は新 tip 基準**
 * という噛み合わないアーカイブができる。取り込み直すと検査が発火して
 * 「履歴が噛み合いません」だけが出て、そのノートの履歴が丸ごと落ちる
 * (title / status は検査が無いので**黙って**旧値が入る)。
 *
 * 「削除は止めるのに保存は止めない」= 同じ危険に対して入口ごとに答えが違う、
 * という状態だった。⚠ **規則は 1 本**にして、本文を書き換える入口すべてに掛ける。
 */
/**
 * 🔴 **2 ペインの鍵 → 押しボタンの口**(2026-08-19 の作り直し)。
 *
 * 🔑 **実体を 2 つ作らない** ── `F5` と「写す」のボタンは**同じ関数**を通す。
 *   分けると、断り方・確認の文言・「戻せます」の言い方が鍵とボタンで割れる
 *   (CLAUDE.md §7。左の列と 2 ペインで `deleteFrom` を 1 本にしたのと同じ理由)。
 * ⚠ 通すのは `run` ── 書出し中などの門(`refuseWhileBusy`)も一緒に通す。
 */
const DUAL_KEY_ACTION: Readonly<Record<string, string>> = {
  'dual-copy-to-other': 'dual-copy',
  'dual-move-to-other': 'dual-move',
  'dual-new-folder': 'dual-mkdir',
  'dual-new-note': 'dual-mknote',
  /**
   * 🔴 **鍵も押しボタンと同じ実体を通す**(#273 残件)── 断り方も憶え方も
   * 1 か所である。⚠ `nav-back` / `nav-forward` は**全域にも在る id** で、
   * この面に居るときだけ「このタブの 1 つ前」を意味する(`keymap.ts` の注記)。
   */
  'nav-back': 'dual-back',
  'nav-forward': 'dual-forward',
  'dual-preview': 'dual-preview-toggle',
};

/**
 * 🔴 **選んだ全部にタグを足す / 外す**(#402 ①)。
 * ⚠ 2 つのボタンで**同じ関数**を通す ── 片方だけ相手の集合の採り方が変わる、
 *   という形を作らない(§7)。
 */
function runBulkTag(
  dispatcher: Dispatcher,
  root: HTMLElement,
  mode: 'add' | 'remove',
): void {
  const field = root.querySelector<HTMLInputElement>('[data-pkc-field="bulk-tag"]');
  const tag = normalizeTag(field?.value ?? '');
  if (tag === '') {
    // ⚠ **無言で終わらせない**(帯は出ているのに何も起きない dead click になる)
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: '付け外しするタグを入力してください',
    });
    return;
  }
  const st = dispatcher.getState();
  // ⚠ 相手は**いま表に出ている印**だけ(`delete-selected` と同じ規則)
  const rows = new Set(visibleFilerRows(st).map((r) => r.lid));
  const lids = st.selection.filter((lid) => rows.has(lid));
  if (lids.length === 0) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: '選んでいるものがありません' });
    return;
  }
  dispatcher.dispatch({ type: 'BULK_TAG', lids, tag, mode });
  // 🔑 通したら欄を空にする(次の 1 つを打てる)── ⚠ 断ったときは残す
  if (field) field.value = '';
}

const BODY_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'start-edit',
  'commit-edit',
  'append-entry',
  // ⚠ 選んだ全部の本文を書く(#402 ①)── 取込・書出しの最中に走らせない
  'bulk-tag-add',
  'bulk-tag-remove',
  // 🔑 スマートフォルダの条件と出し入れも**本文を書く**(#421 段①)
  'smart-cond-add',
  'smart-cond-remove',
  'smart-field',
  'smart-evict',
  /**
   * 🔴 **整理案を当てる**(#429 段③)── 作る / 移す / 改名を**まとめて**撃つ。
   * ⚠ 取り込み・書き出しの最中に走らせない ── entry を総入れ替えしている裏で
   *   構成を動かすと、どちらが勝ったのか誰にも分からなくなる。
   */
  'apply-plan',
  // ⚠ 追記と**同じ経路**(`REQUEST_BODY_REWRITE`)を撃つので、同じ門をくぐらせる
  'undo-append',
  /**
   * 🔴 **外部の画像を取り込むのも本文を書く**(#264 段①)── 同じ
   *   `REQUEST_BODY_REWRITE` を撃つので、同じ門をくぐらせる。
   * ⚠ こちらは**押してから書くまでに通信を挟む** ── その間に取り込みが始まっても
   *   困らないよう、少なくとも**押す時点**では止める(検査は `tests/repo-hygiene.test.ts`)。
   */
  'adopt-external-images',
  'toggle-todo',
  /**
   * 🔴 **本文を書く点では `toggle-todo` と同じ**(2026-08-19 のレビュー W-4)。
   * ⚠ 直す前は 2 つとも抜けていた ── どちらも同じ `REQUEST_BODY_REWRITE` を撃つのに、
   *   取り込み・書き出しの最中(`phase` は `'ready'` のまま)に押せてしまい、
   *   entry を総入れ替えしている裏で保存が走った。
   * 🔑 抜けを機械で止める検査は `tests/repo-hygiene.test.ts`。
   */
  'toggle-task',
  /**
   * 🔴 **表のセルを打つのも本文を書く**(#418 段①)── `toggle-task` と同じ
   *   `REQUEST_BODY_REWRITE` を撃つので、同じ門をくぐらせる。
   * ⚠ 押した時点では欄を開くだけだが、**確定で書く** ── 門は入口に置く。
   */
  'edit-cell',
  // ⚠ 行・列の足し引きも同じ `REQUEST_BODY_REWRITE` を撃つ(#418 段①)
  'shape-cell',
  /**
   * 🔴 **今日のノートは「作る」ことがある**(#348、2026-08-23)。
   * ⚠ 既に在れば選ぶだけだが、**無ければ `CREATE_ENTRY` を撃つ** ──
   *   取り込みが entry を総入れ替えしている裏で作らせない。
   * 🔑 「選ぶだけの回もある」は門を外す理由にならない ── **撃ちうる**なら載せる
   *   (機械検査は `tests/repo-hygiene.test.ts`)。
   */
  'open-today',
  // ⚠ 今日のノートの本文を書く(#402 ②)── 取込・書出しの最中に走らせない
  'schedule-quick-add',
  /**
   * 🔴 **ノート 1 件の日付も disk への書込**(#292 段④)── frontmatter を書く。
   * ⚠ 取り込みが entry を総入れ替えしている裏で frontmatter を書かせない、が理由。
   *   機械検査は `tests/repo-hygiene.test.ts`。
   * ⚠ かつてここに `calendar-set-date` が並んでいたが、**#292 段⑤ で受け手ごと
   *   落とした** ── 中央のカレンダーが消えて、その属性を書き出す場所が 0 件に
   *   なったためである(下の「押した所と起きることを一致させる」は、いまは
   *   予定の面の掴んで落とす / この 2 つのボタンが担う)。
   */
  'set-entry-date',
  'clear-entry-date',
  'toggle-app-tile',
  /**
   * 🔴 **リンクを足すのも「作る」である**(#401 ①)。⚠ `create-entry` と同じ理由で
   *   載せる ── 取り込みが entry を総入れ替えしている裏で新しい行を挿させない。
   * 🔑 「押しうるか」ではなく「**撃ちうるか**」で判断する(`open-today` と同じ)。
   */
  'add-url-tile',
  /**
   * 🔴 **改名も disk への書込**(#401 ②)── 本文は書かないが、題名の行を書き戻す。
   * ⚠ `move-entry` を載せた理由(「本文は書かないが disk への書込」)と同じである。
   */
  'rename-attachment',
  /**
   * 🔴 **作るのも disk への書込である**(2026-08-19、機械検査が見つけた 4 件)。
   * ⚠ `move-entry` を入れた理由(「本文は書かないが disk への書込」)と同じなのに、
   *   **作る 3 つの口と、保存の再送**が漏れていた ── 取り込みが entry を
   *   総入れ替えしている裏で新しい行を挿すことになる。
   * ⚠ 断りは**可視**(帯に理由が出る)なので、無言の dead click は作らない。
   */
  'create-entry',
  'dual-mkdir',
  'dual-mknote',
  'dual-copy',
  'retry-persist',
  'delete-entry',
  'restore-revision',
  'restore-trash',
  'purge-trash',
  // ⚠ 本文は書かないが **disk への書込**である(取込は relations を総入れ替えする
  //    ので、走っている最中に居場所を変えると片方が消える)
  'move-entry',
  // ⚠ user の**ファイル**を上書きする ── 取込・書出しの最中に走らせない
  'write-back-file',
]);

/**
 * 🔴 **確認を出して、受けたときだけ続きを撃つ**(#299 段②。user 裁定 2026-08-21)。
 *
 * > 「**ブラウザの方のアラートはマウスの動線が多くてウザいから、自前の方が嬉しい**」
 *
 * ⚠ **同期の `boolean` を返す形は作れない** ── `window.confirm` を捨てた時点で、
 *   答えは**後から**来る。だから「開く → 答えが来たら続きを撃つ」に割る
 *   (`ACTIONS` の同期契約はそのまま保てる)。
 * ⚠ **`whenAbsent` はもう要らない** ── 「confirm が無い環境」という状態が
 *   無くなったからである(器はいつでも作れる)。⚠ その結果、**test も実機も
 *   同じように「押す」ことになる** ── それがこの差し替えの目的で、
 *   確認の枝がいままで**一度も実行されていなかった**のを終わらせる。
 */
/**
 * 🔴 **確認を待っている間に前提が崩れたら、理由を出して撃たない**(#308)。
 *
 * 自前の確認は**答えが後から返る**ので、「開いてから答えるまで」の窓が在る
 * (native の `window.confirm` はレンダラごと止めていたので、この窓は
 * **置き換えで新しく生まれた**)。直す前はその窓で前提が崩れても
 * **再確認せずに撃って**おり、reducer が `phase !== 'ready'` で黙って捨てるので
 * **「はい」と答えたのに 1 ドットも変わらず理由も出ない**。
 *
 * 🔑 `recheck` は **`onOk` より前**に置く ── 渡し忘れると `onOk`
 *   (`() => void`)がこの位置に来て**型が落ちる**。optional にすると
 *   「4 面のうち 1 面だけ無防備」が静かに起きる(#299 の `settled()` で踏んだ型)。
 *
 * @param recheck 崩れていたら**断りの文**を返す。崩れていなければ `null`。
 */
function confirmThen(
  root: HTMLElement,
  message: string,
  opts: ConfirmOptions,
  dispatcher: Dispatcher,
  recheck: () => string | null,
  onOk: () => void,
): void {
  void confirmInApp(root, message, opts).then((answer) => {
    if (answer !== 'ok') return;
    const why = recheck();
    if (why !== null) {
      // ⚠ **可視に断る**(無言の操作拒否を作らない)
      dispatcher.dispatch({ type: 'OP_FAILED', error: why });
      return;
    }
    onOk();
  });
}

/**
 * 4 面が共通で見る前提。⚠ **同じ問いに答える口を増やさない** ──
 * 「編集中か」の判定はここ 1 つで、断り文も押した場所と対で渡す。
 */
function notWhileEditing(dispatcher: Dispatcher, refusal: string): () => string | null {
  return () => (dispatcher.getState().phase === 'ready' ? null : refusal);
}

function refuseWhileBusy(
  action: string,
  dispatcher: Dispatcher,
  services: BinderServices,
): boolean {
  if (!BODY_WRITE_ACTIONS.has(action) || services.busy?.() !== true) return false;
  // ⚠ **可視に断る**(無言の操作拒否を作らない)
  dispatcher.dispatch({
    type: 'OP_FAILED',
    error: '書き出し / 取込が実行中です。完了してから操作してください',
  });
  return true;
}

/** 並べ替えの 2 つの向きで同じことをする(規則を 2 か所に書かない)。 */
function moveOrder(
  dispatcher: Dispatcher,
  target: HTMLElement,
  direction: 'up' | 'down',
): void {
  const lid = target.getAttribute('data-pkc-entry');
  if (!lid) return;
  dispatcher.dispatch({ type: 'MOVE_ENTRY_ORDER', lid, direction });
}

/**
 * 本文のリンク(`entry:` / `@card`)から別のノートを開く。
 *
 * 🔴 **規則は 1 本**(`link-target.ts`)。⚠ 断る 3 つはどれも**可視に**返す ──
 * `SELECT_ENTRY` は編集中 / error / 未知 lid で**黙って何もしない**ので、
 * 素直に撃つと「押しても無言」が残る(直そうとしている当のものになる)。
 */
function navigateToLink(dispatcher: Dispatcher, raw: string | null): void {
  const t = parseLinkTarget(raw ?? '');
  if (t.kind === 'invalid') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: 'リンクの書き方が読めません' });
    return;
  }
  if (t.foreign) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: 'このリンクは別の PKC のノートを指しています',
    });
    return;
  }
  if (!selectEntryOrExplain(dispatcher, t.lid, 'リンク先')) return;
}

/**
 * 🔴 **ノートを開く。開けないときは理由を出す**(2026-08-08)。
 *
 * ⚠ `SELECT_ENTRY` は reducer が **編集中 / error / 未知 lid で黙って捨てる**
 * (`app-state.ts`)。素直に撃つと**押しても無言**になる ── この repo が
 * 繰り返し踏んできた形である。
 *
 * 🔑 **規則を 1 か所に寄せる**(CLAUDE.md「同じ判定が 2 か所に生えたら…」)──
 * 本文のリンク(`navigate-*`)も一覧の行(`select-entry`)も、
 * 「ノートを開きたい」という同じ意図であり、断る条件も同じである。
 *
 * ⚠ **開けるようにはしない。** 面の切替(設定 / フラグ / ヘルプ)は面が常駐する
 * ので開けるようにしたが(user 裁定 2026-08-08)、**別のノートへ移るのは下書きを
 * 捨てることになる** ── ここは止めるのが正しく、無言なのが間違いだった。
 *
 * @param what 断り文に入れる呼び名(「リンク先」/「ノート」)
 * @returns 開いたら true
 */
function selectEntryOrExplain(dispatcher: Dispatcher, lid: string, what: string): boolean {
  const state = dispatcher.getState();
  if (state.phase === 'editing') {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `編集を終了してから${what}を開いてください`,
    });
    return false;
  }
  if (!state.entryMetas.has(lid)) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${what}のノートが見つかりません` });
    return false;
  }
  dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
  return true;
}

/**
 * 🔴 **まとめてゴミ箱へ、の実体は 1 本**(#273 段②)。
 *
 * ⚠ 左の列と 2 ペインで**別々に書かない** ── 断り方・確認・「戻せます」の言い方が
 * 経路で食い違うと、user は同じ操作なのに違う説明を受ける(CLAUDE.md §7)。
 * 🔑 **相手の集合は呼び側が渡す** ── 「いまどの面を見ているか」で推測すると、
 * 2 ペインを開いたまま左の列のボタンを押したときに**画面に無いものが消える**。
 *
 * @param cursor カーソルの行(`null` = その面はカーソルを持たない)。
 *   ⚠ **省略可にしない** ── 渡し忘れた経路だけ「印が無いと断られる」に戻り、
 *   同じ操作が面によって違う答えを返す(CLAUDE.md §7)。
 */
function deleteFrom(
  dispatcher: Dispatcher,
  services: BinderServices,
  root: HTMLElement,
  rows: readonly EntryMeta[],
  selection: readonly string[],
  cursor: string | null,
): void {

    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してから削除してください',
      });
      return;
    }
    if (refuseWhileBusy('delete-selected', dispatcher, services)) return;
    /**
     * 🔴 **見えている行に絞る**(着地前レビュー 2)。印は行が見えなくなっても
     * 残る(絞り込みで消えた / 別タブが消した)ので、素で消すと**画面に無いものが
     * ゴミ箱へ入る**。⚠ 帯に出す数(`filer.ts`)と**同じ規則**を通す ──
     * 食い違うと「2 件を削除しますか?」と聞いて 3 件消す形になる。
     */
    const lids = operationTargets(rows, selection, cursor);
    if (lids.length === 0) {
      /**
       * ⚠ **無言で終わらせない** ── 帯は出ているのに何も起きない dead click になる。
       * 🔴 **印が 0 件のときも黙らない**(2026-08-18 の着地前レビュー 2)。
       * `Delete` の鍵から来る筋では、`Enter` でフォルダへ入った直後が
       * まさにこれ(`SET_SCOPE` が印を外すので `selection` は空)── 焦点の枠は
       * 行に見えているので、user は「選べているのに Delete が効かない」と読む。
       * ⚠ OS のファイラも「選んでいなければ何もしない」が、PKC3 は
       *   **理由を出す**側に倒す(この面の他の断りと揃える)。
       */
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error:
          selection.length > 0
            ? '選んでいた行がいま画面にありません(絞り込みを消すか、選び直してください)'
            : '削除するものを選んでください(行を押すと選べます)',
      });
      return;
    }
    confirmThen(
      root,
      `選んでいる ${lids.length} 件を削除しますか?(ゴミ箱から戻せます)`,
      { okLabel: '削除', danger: true },
      dispatcher,
      /**
       * ⚠ 待っている間に **①編集が始まる ②対象が消える**(別タブ / 取込)。
       * 🔑 一部だけ消えたときは**数えて言う** ── 黙って残りを消さない
       *   (この file の「落としたものは数えて言う」に揃える)。
       */
      () => {
        const st = dispatcher.getState();
        if (st.phase !== 'ready') return '編集を終了してから削除してください';
        const alive = lids.filter((l) => st.entryMetas.has(l));
        if (alive.length === 0) return '選んでいたものは、もうありません';
        if (alive.length !== lids.length)
          return `${lids.length - alive.length} 件が既にありません。選び直してください`;
        return null;
      },
      () => dispatcher.dispatch({ type: 'DELETE_ENTRIES', lids }),
    );
}

/** 何もしない口。⚠ 打鍵ではないので「既定を止める」相手がいない。 */
/**
 * 🔴 **整理案の下見を描く**(#429 段③)。
 *
 * ⚠ **判定・文言は `structure-plan.ts`** ── ここは並べるだけ。
 * ⚠ 空の枠を出さない(誤りも下見も無いときは畳む)。
 */
function paintPlan(root: HTMLElement, dispatcher: Dispatcher, text: string): void {
  const errs = root.querySelector<HTMLElement>('[data-pkc-field="plan-errors"]');
  const prev = root.querySelector<HTMLElement>('[data-pkc-field="plan-preview"]');
  const apply = root.querySelector<HTMLButtonElement>('[data-pkc-field="plan-apply"]');
  if (errs === null || prev === null || apply === null) return;
  const plan = parsePlan(text, dispatcher.getState().entryMetas);
  errs.textContent = '';
  for (const e of plan.errors) {
    const li = document.createElement('li');
    // ⚠ 行番号を**必ず**出す ── 出さないと user はどこを直すのか分からない
    li.textContent = `${e.line} 行目: ${e.message}`;
    errs.append(li);
  }
  errs.hidden = plan.errors.length === 0;
  prev.textContent = '';
  for (const l of planPreview(plan.ops, dispatcher.getState().entryMetas)) {
    const li = document.createElement('li');
    li.setAttribute('data-pkc-plan-kind', l.kind);
    li.textContent = l.text;
    prev.append(li);
  }
  prev.hidden = plan.ops.length === 0;
  apply.disabled = !canApplyPlan(plan);
}

/**
 * 🔴 **読み込んだ設定の下見を描く**(#414)。
 *
 * ⚠ **当てない。見せるだけ** ── 当てるのは user が「当てる」を押してからである。
 * ⚠ **値そのものは出さない** ── 鍵の割当も紙面も JSON なので、出しても読めない。
 * 🔑 判定も文言も `features/settings/settings-file.ts` が持つ ── ここは描くだけ。
 */
let settingsPlanText: string | null = null;

function paintSettingsPlan(root: HTMLElement, text: string | null): void {
  settingsPlanText = text;
  const summary = root.querySelector<HTMLElement>('[data-pkc-field="settings-file-summary"]');
  const list = root.querySelector<HTMLElement>('[data-pkc-field="settings-file-changes"]');
  const apply = root.querySelector<HTMLButtonElement>('[data-pkc-field="settings-file-apply"]');
  if (summary === null || list === null || apply === null) return;
  if (text === null) {
    summary.hidden = true;
    list.hidden = true;
    list.textContent = '';
    apply.disabled = true;
    return;
  }
  const plan = planSettingsImport(text, readSetting);
  summary.textContent = settingsPlanNote(plan);
  summary.hidden = false;
  list.textContent = '';
  for (const c of plan.changes) {
    const li = document.createElement('li');
    li.textContent = settingsChangeText(c);
    list.append(li);
  }
  list.hidden = plan.changes.length === 0;
  apply.disabled = !canApplySettings(plan);
}

/**
 * 端末側の 1 件を読む。⚠ **読めない環境(プライベートモード等)でも落ちない**
 *   ── 「設定していない」に落ちる(このリポジトリの他の store と同じ作法)。
 */
function readSetting(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

const noop = (): void => {};

export function runGlobalCommand(
  cmd: string,
  root: HTMLElement,
  dispatcher: Dispatcher,
  keymap: KeymapStore,
  prevent: () => void,
  dry = false,
): boolean {
  if (cmd === 'view-detail') {
    // ⚠ 本文の面には押しボタンが無い(既定の面なので)── ここだけ dispatch する
    if (dispatcher.getState().viewMode === 'detail') return false;
    if (dry) return true;
    prevent();
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    return true;
  }
  if (cmd === 'toggle-focus-mode') {
    /**
     * 🔑 **両側を一度に畳む / 戻す**(PKC2 のフォーカスモード相当)。
     * ⚠ 押しボタン 2 つを続けて押す実装にしない ── 片方だけ畳まれている状態から
     *   押すと**入れ替わる**だけで、user が期待する「集中」にならない。
     */
    if (dry) return true;
    const next = appPanes.getHidden().length === PANES.length ? [] : [...PANES];
    prevent();
    applyPaneVisibility(root, appPanes.setHidden(next));
    return true;
  }
  if (cmd === 'focus-search') {
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]');
    if (!input) return false; // 欄が無い面では何も起きない(ブラウザの検索に譲る)
    if (dry) return true;
    prevent();
    input.focus();
    input.select();
    return true;
  }
  /**
   * 🔴 **押しボタンを持たない面は、ここで直に投げる**(2026-08-19 に実測で判明)。
   *
   * ⚠ 2 ペインは #241 の訂正で**上の帯から外して組み込みタイルへ移した**が、
   *   近道の側は「`set-view` のボタンを探して押す」ままだったので、
   *   **`Alt+6` は 1 度も効いていなかった**(押す先が無く、`preventDefault` すら
   *   しないので無反応)。⚠ しかもお知らせ・マニュアル・`shell.ts` のコメントは
   *   **3 つとも「効きます」と言っていた** ── 画面と doc が揃って嘘をついていた形。
   * 🔑 `view-detail` が既に同じ理由で直に投げている(本文の面にもボタンは無い)。
   *   規則は 1 つ:**ボタンが在るならボタンを押し、無い面は直に投げる**。
   */
  if (cmd === 'view-dual') {
    if (dry) return true;
    prevent();
    dispatcher.dispatch({
      type: 'SET_VIEW_MODE',
      mode: nextViewMode(dispatcher.getState().viewMode, 'dual'),
    });
    return true;
  }
  if (cmd === 'open-palette') {
    if (dry) return true;
    prevent();
    openPaletteFor(root, dispatcher, keymap);
    return true;
  }
  const sel = SHORTCUT_BUTTON[cmd];
  if (sel === undefined) return false;
  const btn = root.querySelector<HTMLElement>(sel);
  if (btn === null) return false;
  /**
   * 🔴 **「押せるか」は `disabled` まで見る**(#425 段①)。
   *
   * ⚠ 鍵の側は**器が在れば既定を止める** ── `nav-back` は履歴が無いと
   *   ボタンが `disabled` になるが、そこで `Alt+←` を素通しすると
   *   **ブラウザが前のページへ戻ってアプリから出てしまう**。
   * 🔑 一覧の側(`dry`)は逆で、**押しても何も起きないものを「押せる」と
   *   言ってはいけない** ── だからここだけ答えが分かれる(意図的である)。
   */
  if (dry) return !(btn instanceof HTMLButtonElement && btn.disabled);
  prevent();
  btn.click();
  return true;
}

/**
 * 🔴 **操作を名前で探す面を開く**(#425 段①)。
 *
 * ⚠ **一覧は開いた瞬間に固めない** ── `paletteRows` は打つたびに呼ばれ、
 *   「いま押せるか」もそのときの画面(`runGlobal(..., dry)`)で決まる。
 * ⚠ **自分自身は並べない** ── パレットからパレットを開く行に意味は無い。
 */
export function openPaletteFor(
  root: HTMLElement,
  dispatcher: Dispatcher,
  keymap: KeymapStore,
): void {
  /**
   * 🔴 **開いた瞬間の欄を控える**(#425 段②-b)。
   *
   * ⚠ **打つたびに走る `rows` の中で見てはいけない** ── そのときの焦点は
   *   **器の中の探す欄**なので、見ると**常に「押せません」**になる。
   * 🔑 器は閉じるときに**この欄へ焦点を返す**(`app-dialog` の後始末)。
   */
  const target = formatTargetOf(root.ownerDocument.activeElement);
  /**
   * 🔴 **選択範囲は「開いたとき」に控える**(2026-08-27、実ブラウザで実測)。
   *
   * ⚠ **ここには「選択範囲も残る(2026-08-26 に実測)」と書いてあったが、
   *   測った時機が違った** ── 落ち着いた後を測っていたので残って見えていた。
   * 🔴 実際の event の並びはこうである(`blur` / `focus` を控えて実測):
   *
   *   `blur 1,4` → **`focus 0,0`** → その後 `1,4` に戻る
   *
   *   つまり**焦点が返ってくる瞬間の選択は `0,0`** で、当てるのがその瞬間に
   *   間に合うかどうかで結果が分かれる ── 実測で **4 回中 1〜3 回**、
   *   `あ==いうえ==お` ではなく **`====あいうえお`**(先頭に入って本文がずれる)に
   *   なっていた。⚠ user が選んでいない所へ記法が入る = **本文が静かに壊れる**向き。
   * 🔑 だから**読む時機に依存しない形**にする ── 開いた時点の範囲を控え、
   *   `applyFormatTo` へ渡す。⚠ 開いている間この欄は焦点を持たないので、
   *   その間に範囲が動くことは無い。
   */
  const range =
    target === null ? null : { start: target.selectionStart, end: target.selectionEnd };
  const rows = (query: string) => {
    const ready = new Set<string>();
    for (const c of KEY_COMMANDS) {
      /**
       * ⚠ **この門は「いま」何も止めていない**(2026-08-26 の変異試験 M9 が
       *   SURVIVED で教えた)── 全域でない命令は `runGlobalCommand` の
       *   どの枝にも当たらず、どのみち `false` が返る。
       * 🔑 **不変条件のほうを pin してある**:`SHORTCUT_BUTTON` と特例に
       *   載るのは全域の命令だけ ── `tests/adapter/keymap-binding.test.ts` の
       *   「全域でない命令が受け手の表に在る」が見る(壊すと落ちるのを実測済み)。
       * ⚠ だからここを消す変異が生き延びても **test の穴ではない** ──
       *   残してあるのは、表に全域でない命令が紛れた日に
       *   **この面が「押せる」と嘘をつかない**ためである
       *   (CLAUDE.md「『これが無いと壊れる』とは書かない」)。
       */
      /**
       * 🔴 **記法は、開いたとき本文の欄に居たなら押せる**(#425 段②-b)。
       * ⚠ 全域の命令ではないので下の門を通らない ── ここで先に拾う。
       * 🔑 判定は `applyFormatTo` と**同じ表**(`FORMAT_OF`)を見る ──
       *   別の一覧を持つと「出るのに押せない」が静かに生まれる(§7)。
       */
      if (target !== null && FORMAT_OF[c.id] !== undefined) {
        ready.add(c.id);
        continue;
      }
      if (!c.contexts.includes('global')) continue;
      if (runGlobalCommand(c.id, root, dispatcher, keymap, noop, true)) ready.add(c.id);
    }
    /**
     * ⚠ **自分自身は並べない** ── パレットからパレットを開く行に意味は無い。
     * 🔑 外すのは**ここ 1 か所** ── `ready` の側でも外すと、片方を消しても
     *   もう片方が救うので、**どちらが効いているか分からなくなる**(§1)。
     */
    return paletteRows(query, keymap.getBindings(), ready, isMac()).filter(
      (r) => r.id !== 'open-palette',
    );
  };
  void pickCommandInApp(root, rows).then((picked) => {
    if (picked === null) return;
    // ⚠ 既定を止める口は要らない(打鍵ではないので) ── 実行だけする
    /**
     * ⚠ **この 2 行は「正しさ」を守っていない ── 意図を書くための門である**
     *   (2026-08-26、変異試験 P7 / P9 が SURVIVED で教えた)。
     *   ① 全域で当たった命令は `FORMAT_OF` に載っていないので、`return` を外しても
     *      下は素通りする ② 記法でない命令を下へ渡しても `applyFormatTo` が
     *      `false` を返して何もしない ── **どちらも答えは 1 バイトも変わらない**。
     * ⚠ そのうえ**押せない行は `disabled`**(`app-dialog`)なので、
     *   記法でない命令がここへ来ること自体が起きない。
     * 🔑 **だから変異試験では生き延びるのが正しい。** 残してあるのは
     *   「**全域が先、記法は後**」という順番を字面で見せるためである
     *   (CLAUDE.md「これが無いと壊れる、と書く前に外して壊れるのを見る」)。
     */
    if (runGlobalCommand(picked, root, dispatcher, keymap, noop)) return;
    if (FORMAT_OF[picked] === undefined) return;
    /**
     * 🔴 **記法を、開いたときの欄へ当てる**(#425 段②-b)。
     *
     * ⚠ **控えた欄が消えていたら、当てずに理由を出す** ── 待っている間に面ごと
     *   組み直されると別の要素になっており、そこへ当てると**選択範囲は先頭**なので
     *   **user が選んでいない所に記法が入る**(本文が静かに壊れる向き)。
     * 🔑 「無言で捨てない」と「間違った所へ書かない」は両立する ── 断り文を出す。
     */
    if (target === null) return;
    if (!target.isConnected) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '書き込む欄が変わったので入れませんでした(もう一度選んでから実行してください)',
      });
      return;
    }
    applyFormatTo(target, picked, range ?? undefined);
  });
}


const ACTIONS: Record<string, ActionHandler> = {
  /**
   * 🔴 **本文のリンクで別のノートへ飛ぶ**(2026-08-08。user 裁定「任せます」)。
   *
   * markdown は `[題名](entry:<lid>)` と `@[card](entry:<lid>)` に
   * `data-pkc-action` を焼いていたのに、**受け手が 1 つも無かった** ──
   * 記法だけ移植して置き忘れた形で、押しても無言で何も起きなかった。
   *
   * ⚠ **無言で断らない**(`delete-entry` と同じ倒し方)。断る先は 3 つ:
   *  ① 編集中(下書きを守る。⚠ 面の切替とは別 ── あちらは開けるようにした)
   *  ② 解けないリンク(壊れた綴り)③ このアプリに無い / 別コンテナのノート
   * ⚠ **fragment は見ない** ── 飛び先の要素を出す実装が `src` に無い 4 形が
   *   あるので、いまは lid まで開く(`link-target.ts` に理由)。
   */
  'navigate-entry-ref': (dispatcher, target) => {
    navigateToLink(dispatcher, target.getAttribute('data-pkc-entry-ref'));
  },
  /**
   * `@[card](…)` の placeholder。⚠ **解決器は `entry:` と同じ 1 本**
   * (target は `entry:` か `pkc://<cid>/entry/<lid>` のどちらか)。
   */
  'navigate-card-ref': (dispatcher, target) => {
    navigateToLink(dispatcher, target.getAttribute('data-pkc-card-target'));
  },
  /**
   * `pkc://<自分>/asset/<key>` ── 添付の**所有ノートへ飛ぶ**(#100 段②)。
   * ⚠ key → lid の逆引きは storage worker(`findAssetOwner`)なので非同期 ──
   *   判断は services 側(main.ts が worker へ問い、見つかれば SELECT_ENTRY)。
   */
  'navigate-asset-ref': (_dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-ref');
    if (key) services.navigateAssetRef?.(key);
  },
  /**
   * 一覧 / フォルダ / かんばん / カレンダーの行。
   *
   * 🔴 **編集中は無言で捨てられていた**(2026-08-08 に直した)。reducer が
   * `phase === 'editing'` で何もせず返すので、**押しても 1 ドットも動かず、
   * 理由もどこにも出ない** ── user から見ると「クリックが効かない」。
   * ⚠ 行は 4 つの面が出しているので、**受け手 1 か所で直すと 4 面とも直る**。
   */
  'select-entry': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (lid) selectEntryOrExplain(dispatcher, lid, 'ノート');
  },
  /**
   * ✏️ 編集に入る。#177: 多重タブでは**先に編集権を取ってから**入る。
   * ⚠ reducer のガード(ready / openBody 一致 / writeLock)は**ここに写さない**
   *   ── 取ってから dispatch し、入れなかったら返す(判定は reducer 1 か所)。
   */
  /**
   * 🔴 **タグで探す**(#182)。⚠ 押した札の語を**絞り込み欄へ入れる** ── 別建ての
   * タグ絞り込み機構を作らない(#181 の全文検索が frontmatter ごと引く)。
   * ⚠ 欄の値も state 経由で同期される(renderer が書き戻す)。
   */
  'filter-by-tag': (dispatcher, target) => {
    const tag = target.getAttribute('data-pkc-tag');
    if (tag) dispatcher.dispatch({ type: 'SET_ENTRY_FILTER', query: tag });
  },
  /**
   * 🔴 **選択の戻る・進む**(#190)。⚠ **行き先をここで決めない** ── 履歴は state が
   * 持ち、`NAV_HISTORY` が行き先も採否も決める(binder が lid を選ぶと二重帳簿になる)。
   */
  /**
   * 🔴 **ペインを畳む・戻す**(#197)。⚠ **state に持たせない** ── これはこの端末の
   * 見え方であって、ノートのデータでも container の状態でもない(`editor-mode` と
   * 同じ扱い)。畳んだ状態は保存され、次に開いたときも同じ配置になる。
   */
  'toggle-pane': (_dispatcher, target) => {
    const id = target.getAttribute('data-pkc-pane');
    if (id === null || !isPaneId(id)) return;
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    applyPaneVisibility(root, appPanes.toggle(id));
  },
  /**
   * 🔴 **置換の帯を開く・閉じる**(#191)。⚠ 開いたら**探す欄へ focus** ──
   * 開いただけで打てないと、user は 2 手目を探すことになる。
   */
  'toggle-replace': (_dispatcher, target) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const bar = root.querySelector<HTMLElement>('[data-pkc-region="replace-bar"]');
    if (!bar) return;
    bar.hidden = !bar.hidden;
    target.setAttribute('aria-expanded', bar.hidden ? 'false' : 'true');
    if (!bar.hidden)
      root.querySelector<HTMLInputElement>('[data-pkc-field="replace-find"]')?.focus();
  },
  /**
   * 🔴 **全部置換**(#191)。⚠ 判定(編集中か / 何件当たるか)は**reducer 1 か所**。
   * ここでは欄の値を渡すだけ ── binder が「0 件なら押さない」等を持つと二重帳簿になる。
   */
  'replace-all': (dispatcher, target) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const find = root.querySelector<HTMLInputElement>('[data-pkc-field="replace-find"]')?.value ?? '';
    const replace =
      root.querySelector<HTMLInputElement>('[data-pkc-field="replace-with"]')?.value ?? '';
    /**
     * 🔴 **大小の区別を渡す**(#397 ①)。⚠ 直す前はここが無く、
     *   純関数も reducer も対応しているのに**画面からは常に「区別しない」**だった。
     */
    const caseSensitive =
      root.querySelector<HTMLInputElement>('[data-pkc-field="replace-case"]')?.checked === true;
    dispatcher.dispatch({ type: 'REPLACE_IN_BODY', find, replace, caseSensitive });
  },
  /**
   * 🔴 **関係を足す**(#185)。⚠ 相手は**題名で指す**(lid は user に見えない)。
   * ⚠ 見つからない / 曖昧なときは**理由を言う** ── 押して無反応にしない。
   * ⚠ 判定(自分自身・重複・居場所)は **reducer 1 か所**。ここは解決だけ。
   */
  'add-relation': (dispatcher, target) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const nameEl = root.querySelector<HTMLInputElement>('[data-pkc-field="relation-target"]');
    const kindEl = root.querySelector<HTMLSelectElement>('[data-pkc-field="relation-kind"]');
    const name = (nameEl?.value ?? '').trim();
    const state = dispatcher.getState();
    const fromLid = state.selectedLid;
    if (fromLid === null) return;
    if (name === '') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '相手の題名を入れてください' });
      return;
    }
    const hits = [...state.entryMetas.values()].filter(
      (m) => m.title === name && m.lid !== fromLid,
    );
    if (hits.length === 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `「${name}」というノートが見つかりません`,
      });
      return;
    }
    if (hits.length > 1) {
      // ⚠ 同じ題名が複数 ── **どれかを勝手に選ばない**(user の意図が決まらない)
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `「${name}」が ${hits.length} 件あります。題名を分けてから足してください`,
      });
      return;
    }
    const kind = kindEl?.value ?? '';
    if (!isRelationKind(kind) || kind === STRUCTURAL) return;
    dispatcher.dispatch({
      type: 'ADD_RELATION',
      id: generateLid(),
      fromLid,
      toLid: hits[0]!.lid,
      kind,
    });
    if (nameEl) nameEl.value = '';
  },
  /** 関係を消す(#185)。⚠ **id で消す**(押した札が持っている)。 */
  'remove-relation': (dispatcher, target) => {
    const id = target.getAttribute('data-pkc-relation');
    if (id) dispatcher.dispatch({ type: 'REMOVE_RELATION', id });
  },
  /**
   * 🔴 **操作を名前で探す**(#425 段①)。
   *
   * ⚠ 鍵(`Ctrl+Shift+P`)と**同じ 1 本**を通す ── 別に書くと、
   *   「ボタンからは効くが鍵からは効かない」が静かに生まれる(CLAUDE.md §7)。
   * ⚠ ここは**共有の割当**(`appKeymap`)を読む。test が差した割当は鍵の側にだけ
   *   効くが、割当は**鍵の字を出すためだけ**に使うので**動きは変わらない**。
   */
  'open-palette': (dispatcher, _target, _services, root) =>
    openPaletteFor(root, dispatcher, appKeymap),
  'nav-back': (dispatcher) => dispatcher.dispatch({ type: 'NAV_HISTORY', dir: 'back' }),
  'nav-forward': (dispatcher) => dispatcher.dispatch({ type: 'NAV_HISTORY', dir: 'forward' }),
  /** 一覧の並び順(#183)。⚠ 妥当性の判定は `isEntrySort` 1 か所。 */
  /**
   * 🔴 **種類で絞る札**(#411)。もう一度押すと外れる。
   * ⚠ 綴りは**札が持っている**(`data-pkc-kind`)── ここで推測しない。
   *   無い場合は**何もしない**(未知の押下で絞りを壊さない)。
   */
  'toggle-kind-filter': (dispatcher, target) => {
    const kind = target.closest('[data-pkc-kind]')?.getAttribute('data-pkc-kind');
    if (kind === null || kind === undefined || kind === '') return;
    dispatcher.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: kind });
  },
  'clear-kind-filter': (dispatcher) => {
    dispatcher.dispatch({ type: 'CLEAR_KIND_FILTER' });
  },
  'set-entry-sort': (dispatcher, target) => {
    const v = (target as HTMLSelectElement).value;
    if (isEntrySort(v)) dispatcher.dispatch({ type: 'SET_ENTRY_SORT', sort: v });
  },
  /**
   * 集計の束ね方(#184)。⚠ 空文字は「選んでいない」── `null` へ落とす
   * (空文字の key で問い合わせると、全件が「未設定」の 1 組になる)。
   */
  'set-query-key': (dispatcher, target) => {
    const v = (target as HTMLSelectElement).value;
    const key = v === '' ? null : v;
    // ⚠ 覚えるのは**端末側**(container に書かない ── 作業の都合であってデータではない)
    appQueryKey.set(key);
    dispatcher.dispatch({ type: 'SET_QUERY_KEY', key });
  },
  /**
   * 数え直す(#184)。集計は保存のたびに自動では走らない(全本文の先頭を舐めるので、
   * 打つたびには回さない)。
   * 🔴 ⚠ **`SET_VIEW_MODE` を借りない**(レビュー B-2)── 借りると
   * `revisionPanel` / `trashPanel` が畳まれ、**ゴミ箱を開いたまま数え直すと
   * 理由なく閉じる**。P8 段⑤ で「アプリ」タブが同じ形の事故を起こしている。
   */
  'refresh-query': (dispatcher) => {
    dispatcher.dispatch({ type: 'REFRESH_QUERY' });
  },
  'start-edit': (dispatcher, _target, services) => {
    const lock = services.acquireEditLock;
    const lid = dispatcher.getState().openBody?.lid ?? null;
    /**
     * 🔴 **飛んでいる書込を待ってから始める**(#288)。⚠ 待たないと、
     * チェックの印を押した直後の編集で**押す前の本文**が入力欄に出て、
     * 打った時点で印が黙って戻る(2026-08-19 に smoke が実際に踏んだ)。
     * ⚠ 待つのは chain が空になるまで ── 何も飛んでいなければその場で返る。
     */
    /**
     * ⚠ **渡されていない環境では今までどおり同期に始まる**(`null`)── test の
     *   fake や旧い配線を非同期に変えない(乗せ換えたとき unit が 40 件落ちた)。
     */
    const ready = services.settle?.() ?? null;
    if (!lock || lid === null) {
      if (ready === null) dispatcher.dispatch({ type: 'START_EDIT' });
      else void ready.then(() => dispatcher.dispatch({ type: 'START_EDIT' }));
      return;
    }
    void (ready === null ? lock(lid) : ready.then(() => lock(lid))).then((grant) => {
      if (grant !== 'granted') {
        // ⚠ 文言は理由と対(§1 / レビュー M-7)── holder 不在を「別のタブで編集中」と
        //    言うと、user は存在しない編集タブを探す
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error:
            grant === 'denied'
              ? 'このノートは別のタブで編集中です(そちらを閉じるか保存してください)'
              : '本体タブと通信できません(少し待ってもう一度お試しください)',
        });
        return;
      }
      // 🔴 dispatch の**前**に自分の lid か確かめる(レビュー M-3)── acquire を待つ間に
      //    user が別のノートを選んでいると、reducer は**そのノート**の編集を受理する
      //    = ロック無しの編集が成立してしまう。dispatch は同期なのでここの検査に窓は無い
      if (dispatcher.getState().openBody?.lid !== lid) {
        services.releaseEditLock?.(lid);
        return;
      }
      dispatcher.dispatch({ type: 'START_EDIT' });
      // ⚠ 「editing に居るか」では足りない ── reducer が断る理由は選択以外にもある
      //    (writeLock / tileWrite 中)。**自分の lid が入ったか**で見る
      const st = dispatcher.getState();
      if (!(st.phase === 'editing' && st.openBody?.lid === lid))
        services.releaseEditLock?.(lid);
    });
  },
  // ⚠ 第 4 引数の **root** を使う(target ではない)── 追記欄の出口は detail の
  //    兄弟なので、押したボタンから題名欄へは辿れない(P8 段⑲)
  'commit-edit': (dispatcher, _target, _services, root) => {
    renameFromEditorInput(dispatcher, root);
    dispatcher.dispatch({ type: 'COMMIT_EDIT' });
  },
  'cancel-edit': (dispatcher, _target, _services, root) => cancelFromEditor(dispatcher, root),
  /**
   * 🔴 **今日のノートを開く**(#348、user 裁定 2026-08-23)。
   *
   * ⚠ **`create-entry` と同じ順序**にする ── 面を detail へ戻してから作る
   *   (非 detail で作ると editor が出ない、という PKC2 由来の罠)。
   * 🔑 **既に在れば作らない** ── 押すたびに増えると、その日の入れ物が
   *   1 つに決まらず、「どっちが本物か」を user が追う羽目になる。
   * ⚠ **入れ先(フォルダ)は見ない** ── その日の入れ物は 1 つなので、
   *   いま開いているフォルダによって別の物ができると読みが壊れる。
   */
  /**
   * 🔴 **その日の束から足す**(#402 ②)。⚠ **書かない** ── 上の 1 つの欄に
   *   日付を入れて焦点を移すだけである(打ちかけを束ごと失わないため)。
   */
  'schedule-quick-here': (_dispatcher, target, _services, root) => {
    const date = target.getAttribute('data-pkc-quick-date') ?? '';
    const dateEl = root.querySelector<HTMLInputElement>('[data-pkc-field="schedule-quick-date"]');
    const textEl = root.querySelector<HTMLInputElement>('[data-pkc-field="schedule-quick-text"]');
    if (dateEl) dateEl.value = date;
    textEl?.focus();
  },
  /**
   * 🔴 **予定の面から、その場でやることを足す**(#402 ②)。
   *
   * > user の物語: 予定タブで今週を眺めている。「木曜に見積を出す」を足したい。
   *
   * 🔑 **新しい入れ物を作らない** ── 行き先は「**今日のノート**」で、
   *   その決め方は `open-today` と**同じ 1 本**(`todayNoteTitle` / `findTodayNote`)。
   * 🔑 **書込も新しい経路を作らない** ── 既存の追記(`APPEND_TO_ENTRY`)を通る。
   *   ⚠ ノートがまだ無ければ**先に作る** ── 作成の書込と追記の読みは
   *   effect の**同じ 1 本の chain** に載るので、順序は保たれる。
   * ⚠ 面は切り替えない ── user は予定を眺めたまま足したいのであって、
   *   本文へ飛ばされたいわけではない(#300「補助が主の作業領域を奪わない」)。
   */
  'schedule-quick-add': (dispatcher, _target, services, root) => {
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから足してください' });
      return;
    }
    const textEl = root.querySelector<HTMLInputElement>('[data-pkc-field="schedule-quick-text"]');
    const text = (textEl?.value ?? '').trim();
    if (text === '') {
      // ⚠ **無言で終わらせない**(欄は出ているのに何も起きない dead click になる)
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'やることを入力してください' });
      return;
    }
    const date =
      root.querySelector<HTMLInputElement>('[data-pkc-field="schedule-quick-date"]')?.value ?? '';
    // 🔑 日付の書き方は `line-date.ts` の 1 本(`@2026-08-28`)── ここで綴らない
    const line = `- [ ] ${text}${date === '' ? '' : ` ${formatLineDate(date)}`}`;
    const title = todayNoteTitle(new Date());
    let lid = findTodayNote(st.entryMetas.values(), title)?.lid ?? null;
    if (lid === null) {
      lid = generateLid();
      dispatcher.dispatch({
        type: 'CREATE_ENTRY',
        archetype: 'text',
        lid,
        title,
        parentLid: null,
        relationId: generateLid(),
        // ⚠ **編集に入らない**(予定を眺めたまま足したいので、面を奪わない)
        edit: false,
      });
    }
    dispatcher.dispatch({
      type: 'APPEND_TO_ENTRY',
      lid,
      text: line,
      heading: null,
      // ⚠ 末尾へ足す(入り先の選択は本文の面の話 ── ここでは選ばせない)
      target: null,
    });
    if (textEl) textEl.value = '';
    void services;
  },
  'open-today': (dispatcher, _target, services) => {
    const st = dispatcher.getState();
    if (st.phase !== 'ready') return;
    if (st.viewMode !== 'detail') dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    const title = todayNoteTitle(new Date());
    const found = findTodayNote(st.entryMetas.values(), title);
    if (found) {
      dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: found.lid });
      return;
    }
    const lid = generateLid();
    dispatcher.dispatch({
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid,
      title,
      parentLid: null,
      relationId: generateLid(),
    });
    // ⚠ `create-entry` と同じ ── 作成 → 即編集の編集権を取る
    if (dispatcher.getState().phase === 'editing') void services.acquireEditLock?.(lid);
  },
  'create-entry': (dispatcher, target, services) => {
    // 🔑 種類は**隣の `<select>`**から取る(P8 ── ボタンを種類ぶん並べない)。
    // ⚠ 旧来どおりボタン自身が `data-pkc-archetype` を持つ形も受ける
    // (かんばん等の面から直接作る導線が将来生えても壊れない)
    const archetype =
      target.getAttribute('data-pkc-archetype') ??
      target
        .closest('[data-pkc-region="create-bar"]')
        ?.querySelector<HTMLSelectElement>('[data-pkc-field="create-kind"]')?.value ??
      null;
    if (!archetype) return;
    /**
     * 🔴 **いま見ているフォルダの中に作る**(2026-08-05、user 報告
     * 「フォルダ整理のための導線がない」の片翼)。直す前は、フォルダを開いて
     * 「+ ノート」を押しても**ルートに落ちて**いた ── フォルダの中身は
     * 「作ってから入れ直す」以外に増やしようが無かった。
     *
     * ⚠ 入れ先は**いま見ているフォルダ**(#240 段① で `scopeLid` へ移した)。
     * それより前は**選択の純関数**(`resolveFilerScope`)だったので、一覧で別の
     * ノートを選ぶだけで**作る先が変わって**いた ── いまは画面に出ているパンくずと
     * 作る先が必ず一致する。「どの探し方を開いているか」では変えない、は不変。
     * ⚠ `SET_VIEW_MODE` より**前**に読む(切替は選択を動かさないが、
     * 読む順を先に固定しておく)。
     */
    const st = dispatcher.getState();
    const parent = st.scopeLid === null ? null : (st.entryMetas.get(st.scopeLid) ?? null);
    // 非 detail view で作ると editor が出ない(PKC2 PR-Δ19 の罠)── 先に切替
    if (st.viewMode !== 'detail') dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    const lid = generateLid();
    dispatcher.dispatch({
      type: 'CREATE_ENTRY',
      archetype,
      lid,
      title: defaultTitle(dispatcher, archetype),
      parentLid: parent?.lid ?? null,
      relationId: generateLid(),
    });
    // #177: 作成 → 即編集の編集権。lid は今生まれたばかりなので必ず取れる ──
    // 「取れてから入る」順に直すと user gesture の同期性を失うだけで守るものが無い。
    // 別タブは 'changed' でこの lid を知るため、登録が先に着けばよい
    if (dispatcher.getState().phase === 'editing') void services.acquireEditLock?.(lid);
  },
  /**
   * 🔴 **まとめてゴミ箱へ**(#240 段③。user 指示 2026-08-17「まとめて消せない」)。
   *
   * ⚠ 断り方・確認・戻せることの言い方は `delete-entry` と**同じ規則**にする
   * (押した場所が違っても、同じ理由なら同じ言い方 ── CLAUDE.md「文言は押した
   * 場所と対で pin する」)。⚠ 完全削除は一括で撃たせない(戻せない操作は 1 件ずつ)。
   */
  /**
   * 🔴 **まとめてタグを付ける / 外す**(#402 ①)。
   *
   * ⚠ **相手は `delete-selected` と同じ規則**(いま表に出ている印だけ)──
   *   揃えないと「3 件を選んでいます」と出して 5 件に書く形になる。
   * ⚠ 空のタグでは撃たない ── 押しても何も起きない代わりに**理由を出す**。
   */
  /**
   * 🔴 **スマートフォルダの条件を足す / 外す**(#421 段①)。
   *
   * ⚠ 書くのは**その入れ物の本文の frontmatter** ── 条件は本文が正本である
   *   (端末の保存に置くと、書き出しにも別の端末にも乗らない)。
   * 🔑 書き換えは `REQUEST_SMART_COND` 1 本 ── 足すも外すも同じ口を通る(§7)。
   */
  'smart-cond-add': (dispatcher, _target, _services, root) => {
    const st = dispatcher.getState();
    const lid = st.scopeLid;
    if (lid === null) return;
    const field = root.querySelector<HTMLInputElement>('[data-pkc-field="smart-cond"]');
    const tag = normalizeTag(field?.value ?? '');
    if (tag === '') {
      // ⚠ **無言で終わらせない**(帯は出ているのに何も起きない dead click になる)
      dispatcher.dispatch({ type: 'OP_FAILED', error: '集める条件にするタグを入力してください' });
      return;
    }
    dispatcher.dispatch({ type: 'SMART_COND', lid, tag, mode: 'add' });
    // 🔑 通したら欄を空にする(次の 1 つを打てる)── ⚠ 断ったときは残す
    if (field) field.value = '';
  },
  /**
   * 🔴 **列で引く条件を選ぶ**(#421 段②)。⚠ `<select>` なので **change** で来る
   *   ── binder の `onChange` が `data-pkc-action` を見て呼ぶ。
   * ⚠ **どの条件か**は要素が持つ(`data-pkc-smart-field`)── action を
   *   4 つに割ると、足すたびに 4 か所へ書くことになる(§7)。
   */
  'smart-field': (dispatcher, target) => {
    const lid = dispatcher.getState().scopeLid;
    if (lid === null) return;
    const field = target.getAttribute('data-pkc-smart-field') ?? '';
    if (!(SMART_FIELDS as readonly string[]).includes(field)) return;
    /**
     * ⚠ **打つ欄(語 ── 段③)も同じ口を通る**ので、`<input>` も受ける。
     * 🔑 `''` は「指定しない」= 条件を外す、という意味である(`withSmartField`)。
     */
    const value =
      target instanceof HTMLSelectElement || target instanceof HTMLInputElement
        ? target.value
        : '';
    dispatcher.dispatch({ type: 'SMART_FIELD', lid, field: field as SmartField, value });
  },
  'smart-cond-remove': (dispatcher, target) => {
    const lid = dispatcher.getState().scopeLid;
    const tag = target.getAttribute('data-pkc-tag') ?? '';
    if (lid === null || tag === '') return;
    dispatcher.dispatch({ type: 'SMART_COND', lid, tag, mode: 'remove' });
  },
  /**
   * 🔴 **選んだものを、このスマートフォルダから外す**(user 指示 2026-08-23)。
   * ⚠ 実体は「条件のタグを本文から消す」── 入れ物から出すのではない。
   */
  'smart-evict': (dispatcher, _target, _services, root) => {
    const st = dispatcher.getState();
    const smartLid = st.scopeLid;
    if (smartLid === null) return;
    // ⚠ 相手は**いま表に出ている印**だけ(`delete-selected` / `bulk-tag` と同じ規則)
    const rows = new Set(visibleFilerRows(st).map((r) => r.lid));
    const lids = st.selection.filter((lid) => rows.has(lid));
    if (lids.length === 0) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '外すものを選んでください' });
      return;
    }
    void root;
    dispatcher.dispatch({ type: 'SMART_TAGS', smartLid, lids, mode: 'remove' });
  },
  'bulk-tag-add': (dispatcher, _target, _services, root) =>
    runBulkTag(dispatcher, root, 'add'),
  'bulk-tag-remove': (dispatcher, _target, _services, root) =>
    runBulkTag(dispatcher, root, 'remove'),
  'delete-selected': (dispatcher, _target, services, root) => {
    const st = dispatcher.getState();
    // ⚠ 押した場所は**左の列**なので、相手も左の列の集合(2 ペインの印を巻き込まない)
    // ⚠ 左の列は**カーソルを持たない**(印だけの面)── だから `null`
    deleteFrom(dispatcher, services, root, visibleFilerRows(st), st.selection, null);
  },
  /** 印を全部外す(#240 段②)。 */
  'clear-selection': (dispatcher) => dispatcher.dispatch({ type: 'CLEAR_SELECTION' }),
  // ── 2 ペインタブファイラ(#241 段⑥-a)──────────────────────────
  // ⚠ 側は**押した物から辿る**(`data-pkc-side`)── 面の側を state から
  //    推測すると、焦点の無いほうを押したときに反対側が動く
  'dual-focus': (dispatcher, target) => {
    const side = dualSide(target);
    if (side) dispatcher.dispatch({ type: 'DUAL_FOCUS', side });
  },
  'dual-row': (dispatcher, target) => {
    const side = dualSide(target);
    const lid = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry');
    // ⚠ 修飾なしのクリックは「これだけを相手にする」── 印は 1 件になる
    if (side && lid) dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid, mode: 'set' });
  },
  'dual-crumb': (dispatcher, target) => {
    const side = dualSide(target);
    if (!side) return;
    // ⚠ `data-pkc-entry` を持たないパンくず = ルート(`null`)
    const lid = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
    dispatcher.dispatch({ type: 'DUAL_SET_SCOPE', side, lid });
  },
  'dual-tab-add': (dispatcher, target) => {
    const side = dualSide(target);
    if (side) dispatcher.dispatch({ type: 'DUAL_TAB_ADD', side });
  },
  'dual-tab-close': (dispatcher, target) => {
    const side = dualSide(target);
    const index = dualTabIndex(target);
    if (side && index !== null) dispatcher.dispatch({ type: 'DUAL_TAB_CLOSE', side, index });
  },
  'dual-tab-activate': (dispatcher, target) => {
    const side = dualSide(target);
    const index = dualTabIndex(target);
    if (side && index !== null) dispatcher.dispatch({ type: 'DUAL_TAB_ACTIVATE', side, index });
  },
  /**
   * 🔴 **いま開いている場所にフォルダを作る**(#273 段②)。
   *
   * ⚠ **編集に入らない**(`edit: false`)── 入ると中央が本文の面へ切り替わり、
   *   整理の途中で面から放り出される。作ったら**その場に出る**のが FD の作法である。
   * ⚠ 入れ先は**そのペインが開いている場所**(左の列の現在地ではない)。
   */
  /** 🔴 押しボタンからも名前を打ち替えられる(鍵は F2 ── 実体は同じ action)。 */
  'dual-rename-begin': (dispatcher, target) => {
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから名前を変えてください' });
      return;
    }
    const marked = paneOf(st.dual, side).selection;
    // ⚠ **1 件のときだけ** ── まとめて改名は「同じ名前が並ぶ」だけで意味が無い
    if (marked.length !== 1) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error:
          marked.length === 0
            ? '名前を変えるものを選んでください(行を押すと選べます)'
            : '名前を変えられるのは 1 件だけです',
      });
      return;
    }
    dispatcher.dispatch({ type: 'DUAL_RENAME_BEGIN', side, lid: marked[0]! });
  },
  /**
   * 🔴 **列見出しを押すと並べ替える**(2026-08-19 の作り直し)。
   *
   * ⚠ 並びは**左の列と同じ 1 本**(`state.entrySort`)── 面ごとに別の並びを
   *   持たせない(§7)。だから左の探す帯の `<select>` と必ず一致する。
   * 🔑 **同じ列をもう一度押したら向きが反転する**(古典 4 実装が一致)。
   *   ⚠ 「もう一度で手動の順へ戻す」にしない ── そちらは**上の帯・タイルの規則**で、
   *   一覧の見出しでは「反転」が世界共通である(手動の順へは左の `<select>` で戻る)。
   * 🔑 **別の列に移ったときは、その列の自然な向き**(`NATURAL_DESC`)── 更新と
   *   大きさは降順から、名前は昇順から見たい。向きを持ち越すと、名前を押した瞬間に
   *   「ん」から並ぶ。
   */
  'dual-sort': (dispatcher, target) => {
    const want = target.closest('[data-pkc-sort]')?.getAttribute('data-pkc-sort');
    if (want === null || want === undefined || !isEntrySort(want)) return;
    const st = dispatcher.getState();
    dispatcher.dispatch({
      type: 'SET_ENTRY_SORT',
      sort: want,
      desc: st.entrySort === want ? !st.entrySortDesc : NATURAL_DESC[want],
    });
  },
  /**
   * 🔴 **1 つ前 / 次の場所へ**(#273 残件)。
   * ⚠ 押せないときは reducer が何もしない ── ボタン側も `disabled` にしてある
   *   ので、ここは**素直に投げるだけ**でよい(判定を 2 か所に書かない)。
   */
  'dual-back': (dispatcher, target) => {
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    dispatcher.dispatch({ type: 'DUAL_BACK', side });
  },
  'dual-forward': (dispatcher, target) => {
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    dispatcher.dispatch({ type: 'DUAL_FORWARD', side });
  },
  /**
   * 🔴 **いまの場所を留める / 外す**(#273 残件)。⚠ **同じ口が二役** ──
   *   留める口と外す口を分けると、押し間違いで**同じ場所が 2 度並ぶ**。
   */
  'dual-bookmark': (dispatcher, target, services) => {
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    const scope = paneScope(paneOf(dispatcher.getState().dual, side));
    // ⚠ ルートは留めない(パンくずの左端から 1 押しで行ける)
    if (scope === null) return;
    services.toggleDualBookmark?.(scope);
  },
  /** 留めた場所へ移る。⚠ **消えた場所は reducer が弾く**(空の表を出さない)。 */
  'dual-bookmark-open': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (lid === null || lid === '') return;
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    dispatcher.dispatch({ type: 'DUAL_SET_SCOPE', side, lid });
  },
  /**
   * 🔴 **留めを外す**(user 指示 2026-08-23「なんで双方向にする発想がでねぇんだよ!」)
   * ── 置けるなら外せる。⚠ **消えた場所からも外せる**(そうしないと永久に残る)。
   */
  'dual-bookmark-remove': (_dispatcher, target, services) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (lid === null || lid === '') return;
    services.toggleDualBookmark?.(lid);
  },
  /**
   * 🔴 **下見を出す / しまう**(#273 残件)。
   * ⚠ **効かせる(state)と憶える(端末)を両方やる** ── 片方だけだと
   *   「点けたのに次に開くと消えている」か「点いたままなのに何も出ない」になる。
   */
  'dual-preview-toggle': (dispatcher, _target, services) => {
    const on = !dispatcher.getState().dual.previewOn;
    dispatcher.dispatch({ type: 'DUAL_SET_PREVIEW', on });
    services.rememberDualPreview?.(on);
  },
  'dual-mkdir': (dispatcher, target) => dualCreate(dispatcher, target, 'folder'),
  /**
   * 🔴 **いま開いている場所にノートを作る**(#273)。
   *
   * ⚠ 直す前は**フォルダしか作れなかった** ── 整理の面で
   *   「入れ物は作れるが中身は作れない」という非対称で、1 枚メモを置くのに
   *   左の列へ戻る → 作る → 開き直す → 移す、の 4 手が要った。
   * 🔑 **フォルダと同じ口**(`dualCreate`)を通す ── 種類が違うだけで、
   *   入れ先の決め方も編集へ移らない作法も**同じ規則である**(§7)。
   */
  'dual-mknote': (dispatcher, target) => dualCreate(dispatcher, target, 'text'),
  /**
   * 🔴 **反対側の場所へ写す**(#273 段③。FD の C 相当)。
   *
   * ⚠ **フォルダを写したら中身も行く** ── 段取りは純関数 `planCopy` が決める
   *   (親子の組み直しを adapter に書くと、どの test からも実行されずに壊れる)。
   * ⚠ 本文が読めなかったぶんは**件数で言う** ── 黙って空のノートを作らない。
   */
  'dual-copy': (dispatcher, target, services) => {
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから写してください' });
      return;
    }
    const rows = dualPaneRows(st, side);
    // ⚠ 相手は**いま表に出ている印**、無ければ**カーソルの行**(移す・消すと同じ規則)
    const lids = operationTargets(
      rows,
      paneOf(st.dual, side).selection,
      paneOf(st.dual, side).cursor,
    );
    if (lids.length === 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '写すものを選んでください(行を押すと選べます)',
      });
      return;
    }
    const read = services.readBodies;
    if (!read) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'この版では写せません' });
      return;
    }
    const to = otherSide(side);
    const steps = planCopy(
      lids,
      paneScope(paneOf(st.dual, to)),
      st.entryMetas,
      st.relations,
      generateLid,
    );
    void read(steps.map((s) => s.sourceLid)).then(
      (bodies) => {
        let missing = 0;
        for (const step of steps) {
          const body = bodies.get(step.sourceLid);
          if (body === undefined) missing += 1;
          dispatcher.dispatch({
            type: 'CREATE_ENTRY',
            archetype: step.archetype,
            lid: step.lid,
            title: step.title,
            parentLid: step.parentLid,
            relationId: generateLid(),
            edit: false,
            ...(body === undefined ? {} : { body }),
          });
        }
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error:
            missing > 0
              ? `${steps.length} 件を写しました(うち ${missing} 件は本文を読めず、空で作りました)`
              : `${steps.length} 件を写しました`,
        });
      },
      () => dispatcher.dispatch({ type: 'OP_FAILED', error: '写せませんでした(本文を読めません)' }),
    );
  },
  /** ⚠ 鍵(`Delete`)と**同じ実体**を押しボタンからも呼ぶ(規則を 2 つ作らない)。 */
  'dual-delete': (dispatcher, target, services, root) => {
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    const st = dispatcher.getState();
    deleteFrom(
      dispatcher,
      services,
      root,
      dualPaneRows(st, side),
      paneOf(st.dual, side).selection,
      paneOf(st.dual, side).cursor,
    );
  },
  /**
   * 🔴 **反対側の場所へ移す**(この面の主目的)。
   *
   * ⚠ **実体は `moveEntries` 1 本**(帯の `<select>` / D&D と同じ)── 断り方も
   *   「付いていく」の規則も経路で変えない(§7「判定を増やさない」)。
   * ⚠ 数える対象は**いま表に出ている印**だけ ── 素で数えると、画面に無いものが
   *   動く(#240 の着地前レビュー 2)。
   * ⚠ **黙って断らない** ── 何も選んでいないときは、その理由を出す。
   */
  'dual-move': (dispatcher, _target, services) => {
    const st = dispatcher.getState();
    const from = st.dual.focus;
    const pane = paneOf(st.dual, from);
    const rows = dualPaneRows(st, from);
    const lids = operationTargets(rows, pane.selection, pane.cursor);
    if (lids.length === 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '移すものを選んでください(行を押すと選べます)',
      });
      return;
    }
    const to = paneScope(paneOf(st.dual, otherSide(from)));
    const before = st.relations;
    moveEntries(dispatcher, lids, to, services.showStatus);
    /**
     * 🔴 **動いた回だけ印を外す**(着地前レビュー R1)。
     * ⚠ `moveEntries` は編集中・全件拒否で**何もせず返る**ので、無条件に外すと
     *   **1 件も動いていないのに 30 件の印が消える** ── user は断りを読んで
     *   保存してから戻り、**選び直し**になる(この面は編集中でも開ける設計なので
     *   必ず踏む筋である)。
     * 🔑 印は「移した結果」に付いていく物であって、**押した事実**に付く物ではない。
     */
    if (dispatcher.getState().relations !== before)
      dispatcher.dispatch({ type: 'DUAL_CLEAR_SELECTION', side: from });
  },
  'delete-entry': (dispatcher, target, _services, root) => {
    // ⚠ 実行中(書出し / 取込)のガードは `refuseWhileBusy` が 1 本で持つ
    // 🔴 **無言で断らない**(P8 段⑲)。`DELETE_ENTRY` は `phase !== 'ready'` で
    //    何も返さないので、直す前は**確認ダイアログまで出してから黙って捨てて**いた
    //    ── user は消したつもりで画面を離れる。detail.ts が確立した
    //    「無言の操作拒否を作らない」に揃える。⚠ confirm より**前**に断る
    if (dispatcher.getState().phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してから削除してください',
      });
      return;
    }
    // 属性はボタン自身ではなく「entry を表す要素」(行 / カード)から closest で
    // 引く ── ボタン直付けだと selectedLid fallback が別 entry を消す罠になる
    const lid =
      target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ??
      dispatcher.getState().selectedLid;
    if (!lid) return;
    const title = dispatcher.getState().entryMetas.get(lid)?.title ?? lid;
    /**
     * 🔴 **確認はアプリ自身のダイアログ**(#299 段②、2026-08-21)── ここに
     *   在った「P3-7a は native confirm(inline dialog は UI 磨きの回で)」は
     *   **その予告が実行された**ので消した。
     * 🔴 文言が**嘘になっていた**(P7 段⑥ round-2 review M-8)。P3-7a の時点では
     *   hard delete だったので「元に戻せません」と書いたが、P5b でゴミ箱と復元が
     *   着地している ── **必要以上に怖がらせる側の嘘**を出荷していた。
     * ⚠ 「戻せる」ことは `docs/manual.md` §6 にも書いてある(そちらが正しかった)。
     */
    confirmThen(
      root,
      `「${title}」を削除しますか?(ゴミ箱から戻せます)`,
      { okLabel: '削除', danger: true },
      dispatcher,
      () => {
        const st = dispatcher.getState();
        if (st.phase !== 'ready') return '編集を終了してから削除してください';
        if (!st.entryMetas.has(lid)) return `「${title}」は、もうありません`;
        return null;
      },
      () => dispatcher.dispatch({ type: 'DELETE_ENTRY', lid }),
    );
  },
  'copy-md-block': (_dispatcher, target) => handleCopyMdBlock(target),
  /**
   * 🔴 **読む面のコピー**(2026-08-08。user 裁定「markdown のテキストとしての
   * コピーと HTML 書式ありのコピーの両方」)。押しても画面が変わらない操作なので、
   * 渡ったらボタンが光り(`copy-md-block` と同じ合図)、渡らなければ理由が出る。
   * ⚠ 本文待ちの間は renderer 側が disabled にしている ── ここの早期 return は
   * その裏書き(押せない物は押せない)であって、無言の断りの口ではない。
   */
  'copy-note-md': (dispatcher, target) => {
    const body = dispatcher.getState().openBody?.body;
    if (body === undefined) return;
    finishCopy(dispatcher, target, copyPlainText(body));
  },
  /**
   * 🔴 **よそのアプリへ貼る用に掃除してから渡す**(#193)。
   *
   * ⚠ 直す前は `host.innerHTML` を**そのまま**渡していた ── 画面の DOM には
   * 「CSS で隠してあるだけのソース」「押せない操作子」「この document でしか
   * 有効でない `blob:` 画像」が入っており、Word / Notion に貼ると**全部出る**
   * (図の下に生の原文、壊れた画像、押せないボタン)。
   * ⚠ 掃除は**複製に対して**行う ── 画面には触れない。
   * ⚠ 落としたものは**数えて言う**(黙って消さない)。
   */
  'copy-note-rich': (dispatcher, target, services, root) => {
    const body = dispatcher.getState().openBody?.body;
    const host = viewBodyHost(root);
    if (body === undefined || host === null) return;
    const clone = host.cloneNode(true) as HTMLElement;
    const inline = services.inlineImages;
    const run = (urls: ReadonlyMap<string, string>): void => {
      const { html, droppedImages } = cleanForClipboard(clone, urls);
      // plain 側は原文(markdown)── 貼り付け先が editor なら原文、rich なら描画
      finishCopy(dispatcher, target, copyMarkdownAndHtml(body, html));
      if (droppedImages > 0)
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: `画像 ${droppedImages} 件は貼り先で読めないため文字に置き換えました`,
        });
    };
    if (!inline) {
      run(new Map());
      return;
    }
    const blobs = [...clone.querySelectorAll('img')]
      .map((i) => i.getAttribute('src') ?? '')
      .filter((u) => u.startsWith('blob:'));
    if (blobs.length === 0) {
      run(new Map());
      return;
    }
    void inline(blobs).then(run, () => run(new Map()));
  },
  /**
   * 選択範囲を Markdown の原文でコピーする。逆引きの規則は `copy-source.ts` の
   * 1 本(活性の判定と同じ端点の規則)。
   * ⚠ 解決できない選択は**理由を出す**(活性が selectionchange と競り合って
   * 押せてしまう瞬間があるので、ここでも無言にしない)。
   */
  'copy-selection-md': (dispatcher, target, _services, root) => {
    const body = dispatcher.getState().openBody?.body;
    const host = viewBodyHost(root);
    const text = body !== undefined && host !== null ? selectedMarkdown(host, body) : null;
    if (text === null) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '本文の中を選択してからコピーしてください',
      });
      return;
    }
    finishCopy(dispatcher, target, copyPlainText(text));
  },
  /**
   * 書式パネル(P8 段⑥)。⚠ **規則は `applyFormat` が持つ** ── ここは
   * 「選択を読む → 渡す → 書き戻す」だけ。op ごとの知識をここに漏らさない。
   */
  /**
   * 🔴 **日付を入れる道具**(user 指示 2026-08-23)。
   *
   * > 「**日付の記法としては入力がめんどくさいから、日付と時刻を簡単に入力できるし、
   * > ついてくるツールとか用意されてもいいかも**」
   *
   * ⚠ **`@` を打ったら出る形は採らない** ── PKC3 に補完の機構が 1 つも無いうえ、
   *   `@[card](…)` と 1 打鍵目で衝突し、何より不可侵指示
   *   「**マウスだけで完結し、キーボードは近道**」に当たる(打鍵でしか出ない道具は、
   *   マウスの人には存在しないのと同じ)。だから**書式の帯のボタン**にする。
   * ⚠ 挿す字は `insertionForLineDate` が作る ── ここで組み立てない(§7)。
   * ⚠ 挿すのは `insertText` ── **`Ctrl+Z` で戻せる**形にする。
   */
  'insert-date': (_dispatcher, _target, _services, root) => {
    const opened = formatTarget(root);
    if (opened === null) return;
    /**
     * 🔴 **caret を先に控える**(2026-08-23、実ブラウザの smoke が見つけた)。
     *
     * ⚠ 直す前は挿す直前に `ta.selectionStart` を読んでいた ── **実機では 0 に
     *   戻っていた**ので、日付が**本文の先頭**に入った
     *   (`@2026-08-24 14:00- [ ] 見積を送る`)。
     * ⚠ **unit では出ない** ── happy-dom は `showModal()` で焦点を動かしても
     *   選択を保つので、緑のまま出荷される形だった(CLAUDE.md §5「環境差」)。
     * 🔑 `<dialog>` は焦点を借りて返すが、**選択位置までは返さない** ──
     *   置き換えの作法 §10 ③「後始末をしていたか」を、借りる側が自分でやる。
     */
    const at = { start: opened.selectionStart, end: opened.selectionEnd };
    void pickDateInApp(root, new Date(), DATE_SHORTCUTS, (id, now) =>
      isDateShortcut(id) ? shortcutDate(id, now) : '',
    ).then((picked) => {
      if (picked === null) return;
      /**
       * ⚠ **欄は引き直す** ── ダイアログを開いている間に面が組み直されると、
       *   最初に掴んだ節点は `isConnected === false` になり、挿しても画面に出ない。
       */
      const ta = formatTarget(root);
      if (ta === null) return;
      // ⚠ `execCommand('insertText')` は**焦点が要る**(器が焦点を返した後でも念のため)
      ta.focus();
      // ⚠ 範囲外は `setSelectionRange` が丸める(組み直しで短くなっていても落ちない)
      ta.setSelectionRange(at.start, at.end);
      insertText(ta, insertionForLineDate(ta.value.slice(0, at.start), picked.date, picked.time));
    });
  },
  /**
   * 🔴 **ノートへのリンクを入れる**(#427 段②)。
   *
   * ## なぜ帯のボタンなのか(起票の「`[[` で小窓」を採らなかった)
   *
   * ⚠ この repo は**同じ判断を 2 度している** ── `insert-date` が `@` を、
   *   `insert-snippet` が `/` を、どちらも「打鍵に追随する浮き物」として退けた。
   *   芯の理由は不可侵指示「**マウスだけで完結し、キーボードは近道**」である。
   * ⚠ そのうえ `[[` は PKC3 では**空いていない**(`[[ruby:…]]` / `[[em:…]]`)──
   *   採ると**ルビを打つたびに小窓が出る**。
   * 🔑 失う動線は無い:帯のボタンでも「書きながら選ぶ」は成立する
   *   (caret はそのままで、選んだ物がその場に入る)。
   *
   * ⚠ **caret を先に控える**(`insert-date` が 2026-08-23 に実機で踏んだ罠)。
   *   🔑 ⚠ **この器では等価だった**(2026-08-26 実測)── Chromium は閉じるときに
   *     textarea の選択位置を戻すので、外しても同じ所に入る(変異は SURVIVED)。
   *     ⚠ **観測点が死んでいるのではない**(`setSelectionRange(0, 0)` は KILLED)。
   *     `insert-date` は器も焦点の経路も違うところで実際に踏んでいるので、
   *     **安い保険として残す** ── 「効いている」とは書かない。
   * ⚠ 組み立ては `formatEntryLink` 1 本(§7 ── 段① の「参照をコピー」と同じ字)。
   * ⚠ 挿すのは `insertText` ── **`Ctrl+Z` で戻せる**形にする。
   */
  'insert-entry-link': (dispatcher, _target, _services, root) => {
    const opened = formatTarget(root);
    if (opened === null) return;
    const at = { start: opened.selectionStart, end: opened.selectionEnd };
    /**
     * ⚠ **開いた時点の state を握らない** ── 打つたびに引き直す
     *   (選んでいる間に別のタブがノートを増やしても、そのまま出る)。
     * 🔑 自分自身を外すのは `entryPickRows` の仕事(判定を 2 か所に置かない)。
     */
    void pickEntryInApp(root, (query) => {
      const st = dispatcher.getState();
      const self = st.selectedLid;
      const items = entryPickRows(st.entryMetas, st.order, query, self);
      return { items, note: entryPickNote(items.length, entryPickTotal(st.entryMetas, st.order, query, self)) };
    }).then((lid) => {
      if (lid === null) return;
      // ⚠ 欄は引き直す(開いている間に面が組み直されると、最初の節点は繋がっていない)
      const ta = formatTarget(root);
      if (ta === null) return;
      const title = dispatcher.getState().entryMetas.get(lid)?.title ?? '';
      ta.focus();
      // ⚠ 範囲外は `setSelectionRange` が丸める(短くなっていても落ちない)
      ta.setSelectionRange(at.start, at.end);
      insertText(ta, formatEntryLink(title, lid));
    });
  },
  /**
   * 🔴 **雛形を一覧から入れる**(#196 / B-2 段②-b)。
   *
   * ⚠ 短縮語 + `Tab`(上の `keydown`)は**覚えている人の近道**であって入口ではない。
   *   覚えていない人にはここが唯一の道なので、**一覧は必ず 1 行以上出す**
   *   ── 組み込みの雛形を混ぜてあるのはそのためである(`snippet-menu.ts`)。
   * ⚠ **caret を先に控える**(`insert-date` が 2026-08-23 に実機で踏んだ罠)──
   *   `<dialog>` は焦点を借りて返すが、**選択位置までは返さない**。
   * ⚠ 挿す仕事は**既にある 1 本ずつ**へ渡す(`applyFormat` / `insertSnippet`)──
   *   ここで組み立てると、帯のボタンと一覧で結果が食い違う(CLAUDE.md §7)。
   */
  'insert-snippet': (dispatcher, _target, _services, root) => {
    const opened = formatTarget(root);
    if (opened === null) return;
    const at = { start: opened.selectionStart, end: opened.selectionEnd };
    const scan = dispatcher.getState().snippetScan;
    // ⚠ **開いた時点の一覧**を握る ── 選んでいる間に集め直されても、
    //   user が見て押した物をそのまま入れる
    const items = scan?.items ?? [];
    void pickSnippetInApp(root, snippetMenu(items), snippetMenuNote(scan)).then((picked) => {
      if (picked === null) return;
      // ⚠ 欄は引き直す(開いている間に面が組み直されると、最初の節点は繋がっていない)
      const ta = formatTarget(root);
      if (ta === null) return;
      ta.focus();
      // ⚠ 範囲外は `setSelectionRange` が丸める(短くなっていても落ちない)
      ta.setSelectionRange(at.start, at.end);
      const sel = { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
      if (picked.kind === 'format') {
        writeBack(ta, applyFormat(sel, picked.op));
        return;
      }
      const item = items.find((s) => s.lid === picked.lid);
      if (item === undefined) return;
      writeBack(ta, insertSnippet(sel, item.body, new Date()));
    });
  },
  'format-text': (_dispatcher, target, _services, root) => {
    const op = target.getAttribute('data-pkc-format') as FormatOp | null;
    // ⚠ live の 1 面では活性の行(`row-source`)に効く(`formatTarget` の注記)
    const ta = formatTarget(root);
    if (!op || !ta) return;
    writeBack(ta, applyFormat({ text: ta.value, start: ta.selectionStart, end: ta.selectionEnd }, op));
  },
  /**
   * 🔑 **追記**(P8 段⑧)。編集画面を開かず、打った内容をそのまま末尾へ足す。
   *
   * 🔴 段⑥ の「編集に入って末尾へ飛ぶ」は**作り直した**(user 指示 2026-08-03
   * 「追記型は今すぐ実装して、今のままだと、なんの意味もない」)── 5000 行の
   * ログでも毎回全文を textarea に載せる形は、追記型の意味を成していなかった。
   *
   * ⚠ 日時見出しは**ここで作る**(reducer は純粋のまま ── `Date` を呼ばない)。
   * ⚠ 欄は**空にしない** ── 通ったときだけ描画側が空にする(失敗で打鍵が消えない)。
   */
  /**
   * 🔴 **直前の追記を外す**(#395 段①)。
   * ⚠ 独自の書込経路を持たない ── reducer が `REQUEST_BODY_REWRITE` を出す(§7)。
   */
  'undo-append': (dispatcher) => {
    dispatcher.dispatch({ type: 'UNDO_APPEND' });
  },
  'append-entry': (dispatcher, _target, _services, root) => {
    const s = dispatcher.getState();
    const lid = s.selectedLid;
    const archetype = lid ? s.entryMetas.get(lid)?.archetype : undefined;
    if (!lid || !isAppendable(archetype)) return;
    const input = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]');
    const text = input?.value ?? '';
    // ⚠ **空判定をここに持たない**(P8 段⑧ の変異試験で判明)── reducer が
    // 同じ判定を持っており、3 か所(binder / reducer / `appendBlock`)が互いに
    // 救い合って**どれ 1 つ消しても test が緑**だった。判定は下 2 つに寄せる:
    // reducer =「ロックも取らずに断る」、`appendBlock` =「本文を変えない」
    /**
     * 🔴 **入り先**(#395 段①)。空 = 末尾(これまでと同じ)。
     * ⚠ ここでは**印をそのまま渡す** ── 行番号に直さない。effect は disk から
     *   読み直すので、行番号は読み直した先で別の場所を指す。
     */
    const target =
      root.querySelector<HTMLSelectElement>('[data-pkc-field="append-target"]')?.value ?? '';
    dispatcher.dispatch({
      type: 'APPEND_TO_ENTRY',
      lid,
      text,
      heading: appendHeadingFor(archetype!, new Date()),
      target: target === '' ? null : target,
    });
  },
  /**
   * 🔴 **強制解放**(user 指示 2026-08-03「競合ロックと強制解放も念頭に」)。
   * 返ってこない書込で**永久に追記できなくなる**のを防ぐ最後の出口。
   * ⚠ 押した人が結果を分かっていること ── 確認を出す(確認の無い環境は通す)。
   */
  'force-release': (dispatcher, _target, _services, root) => {
    confirmThen(
      root,
      '追記の書き込みを強制的に打ち切ります。書き込みが実際には進んでいた場合、' +
        'この画面の表示が実際の中身より古くなることがあります(開き直すと直ります)。よろしいですか?',
      { okLabel: '打ち切る', danger: true },
      dispatcher,
      /**
       * 🔴 **ここだけは門を足さない**(#308)。返ってこない書込で**永久に
       * 追記できなくなる**のを防ぐ最後の脱出口なので、前提で塞ぐと逃げ道が消える。
       * ⚠ 「念のため」で `phase` を見ないこと ── 実害の実測が無いまま塞がない。
       */
      () => null,
      () => dispatcher.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false }),
    );
  },
  /** 左の列の**探し方**を切り替える(P8 段⑤)。⚠ 中央のビューとは別の軸。 */
  'set-browse': (_dispatcher, target, services) => {
    const mode = target.closest('[data-pkc-browse]')?.getAttribute('data-pkc-browse');
    if (mode) services.setBrowse?.(mode);
  },
  'set-view': (dispatcher, target) => {
    const view = target.getAttribute('data-pkc-view') ?? '';
    if (!isViewMode(view)) return;
    // 🔴 **もう一度押したら戻る**(P8 段⑲)。直す前の 設定 は行きっぱなしで、
    //    閉じる導線がどこにも無かった ── 抜けられるのは左のタブを押すか
    //    新規作成だけで、user から見ると「画面から出られない」
    const cur = dispatcher.getState().viewMode;
    // ⚠ cast を置かない ── `isViewMode` が絞ってあるので、表と食い違えば型が落ちる
    // 🔑 規則は 1 か所(`nextViewMode`)── タイルから開く面も同じ関数を通る
    const next: ViewMode = nextViewMode(cur, view);
    // 🔑 **開く手続きは 1 か所**(`open-view.ts`)── アドレスから開く経路
    //    (`deep-link.ts`)も同じ関数を通る。ここにべた書きすると、
    //    集計の束ね方が**タブから開いたときだけ**思い出される形になる(§7)
    openView(dispatcher, next);
  },
  'toggle-todo': (dispatcher, target) => {
    // data-pkc-entry は「entry を表す要素」専用 ── ボタンからは closest で引く
    const lid = target
      .closest('[data-pkc-entry]')
      ?.getAttribute('data-pkc-entry');
    if (lid) dispatcher.dispatch({ type: 'TOGGLE_TODO_STATUS', lid });
  },
  /**
   * 🔴 **カレンダーに書ける導線**(#276 の 4。「読むだけにしない」)。
   *
   * 選んでいるノートの frontmatter に `date` を入れる。⚠ 同じ日をもう一度押すと
   * **外す**(付けた本人が外せない導線を作らない)。
   * ⚠ **黙って断らない** ── 何も選んでいない / 編集中は、理由を出す。
   */
  /**
   * 🔴 **チェックの印を押せるようにする**(#277。user 指示 2026-08-19
   * 「チェックリストを含む場合の自動生成で…復活させるのです」)。
   *
   * ⚠ 押せるのは**読む面**だけ(描画側が `interactiveTasks` を渡した所)。
   * ⚠ 指すのは**原文の行番号** ── 索引だと数え方のずれで別の行を書き換える。
   */
  /**
   * 🔴 **表のセルを押したら、そのセルが入力欄になる**(#418 段①)。
   *
   * > user の物語: 「表」を作って A1 に「品名」と打ちたい。押すと**表が消えて
   * > CSV の原文**が出て、どのカンマが A1 かを目で数えることになっていた。
   *
   * ⚠ 開くのは**そのセルだけ** ── 周りは表のまま(囲い丸ごとの欄を開かない)。
   * 🔑 確定は `SET_CSV_CELL` → `REQUEST_BODY_REWRITE` の 1 本(§7)。
   * 🔴 **双方向**(user 指示 2026-08-23)── 字を消して確定すれば**セルが空になる**。
   * ⚠ `Escape` は**取り消し**(押す前の字に戻す)── 片道にしない。
   */
  'edit-cell': (dispatcher, target) => {
    const line = Number(target.getAttribute('data-pkc-cell-line'));
    const col = Number(target.getAttribute('data-pkc-cell-col'));
    if (!Number.isInteger(line) || line < 0 || !Number.isInteger(col) || col < 0) return;
    const st = dispatcher.getState();
    /**
     * ⚠ **どのノートのセルかは、押した所から引く**(`toggle-task` と同じ理由)──
     *   本文の面は `data-pkc-entry` を持たないので、そのときだけ
     *   「いま開いているノート」へ落ちる。
     */
    const fromDom = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
    const lid = fromDom ?? st.openBody?.lid ?? st.selectedLid;
    if (lid === null || lid === undefined) return;
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから表を打ってください' });
      return;
    }
    // ⚠ 2 度押しで欄を作り直さない(打ちかけの字を捨てない)
    if (target.querySelector('[data-pkc-field="cell-input"]') !== null) return;
    /**
     * 🔴 **字を選んでいる最中は開かない**(CLAUDE.md §10)。
     *
     * ⚠ 押せるようにする前、升は**ただの字**だった ── ドラッグで選んで
     *   コピーできた。⚠ ドラッグの終わりにも `click` は飛ぶので、無条件に開くと
     *   **選んだ字がその瞬間に消える**(`row-swap.ts` が同じ罠を踏んでいる)。
     * 🔑 だから**選択が潰れている(= ただ押した)ときだけ**開く。
     *   ⚠ 1 つの升の中を選んでコピーする道は残る ── 開いた欄は
     *   `select()` 済みなので、押す → コピー → `Escape` でも取れる。
     */
    const sel = target.ownerDocument.getSelection();
    if (sel !== null && !sel.isCollapsed && sel.toString() !== '') return;
    /**
     * 🔴 **原文は描いた側から受け取る**(升の字を読み取らない)。
     *
     * ⚠ 升の中身は **inline の markdown として描かれる**(`**太字**` →
     *   `<strong>太字</strong>`)うえ、**行・列のボタンも入っている** ──
     *   `textContent` を原文として読むと `**` が落ち、`＋×` が混ざる
     *   (2 稿目で実測して直した。1 稿目は本当にそうなっていた)。
     */
    const before = target.getAttribute('data-pkc-cell-raw') ?? '';
    const input = target.ownerDocument.createElement('input');
    input.type = 'text';
    input.value = before;
    input.setAttribute('data-pkc-field', 'cell-input');
    /**
     * ⚠ **見た目は class で当てる** ── `data-pkc-field` は**動作の鍵**であって、
     *   書き出す本文 CSS には 1 件も混ぜない(`tests/build/body-css.test.ts` が
     *   器の規則の混入を止めている ── 実際にここで落ちて教わった)。
     */
    input.className = 'pkc-csv-cell-input';
    input.setAttribute('aria-label', '表のセル');
    /**
     * ⚠ **確定は 1 回だけ**(`Enter` のあとに `blur` も来る)── 二重に撃つと、
     *   2 回目は「同じ字」で `null` になって黙って落ちるだけだが、
     *   **撃った回数だけ本文を読み直す**ので無駄が積む。
     */
    let settled = false;
    /**
     * ⚠ **描いてあったものをそのまま戻す** ── 升には描画済みの markdown と
     *   行・列のボタンが入っている。字だけ書き戻すと**ボタンが消える**。
     */
    const savedHtml = target.innerHTML;
    const restore = (): void => {
      input.remove();
      target.innerHTML = savedHtml;
    };
    const commit = (): void => {
      if (settled) return;
      settled = true;
      const value = input.value;
      restore();
      if (value === before) return; // 変わっていなければ撃たない
      dispatcher.dispatch({ type: 'SET_CSV_CELL', lid, line, col, value });
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        settled = true;
        restore();
      }
    });
    input.addEventListener('blur', commit);
    target.replaceChildren(input);
    input.focus();
    input.select();
  },
  /**
   * 🔴 **表の行・列を足す / 消す**(#418 段①)。
   *
   * 🔑 打てるだけでは動線が元に戻る ── 5 列で足りなくなった瞬間に
   *   CSV の原文へ帰ることになる。⚠ 足せるなら**消せる**
   *   (user 指示 2026-08-23「片道の操作を作らない」)。
   * ⚠ 何をするかの判断は `body-rewrite.ts`(最後の 1 行 / 1 列は消さない、等)──
   *   ここは**押した所を渡すだけ**である。
   */
  'shape-cell': (dispatcher, target) => {
    const line = Number(target.getAttribute('data-pkc-cell-line'));
    const col = Number(target.getAttribute('data-pkc-cell-col'));
    const what = target.getAttribute('data-pkc-cell-what');
    const mode = target.getAttribute('data-pkc-cell-mode');
    if (!Number.isInteger(line) || line < 0 || !Number.isInteger(col) || col < 0) return;
    if ((what !== 'row' && what !== 'col') || (mode !== 'add' && mode !== 'remove')) return;
    const st = dispatcher.getState();
    const fromDom = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
    const lid = fromDom ?? st.openBody?.lid ?? st.selectedLid;
    if (lid === null || lid === undefined) return;
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから表を触ってください' });
      return;
    }
    dispatcher.dispatch({ type: 'SET_CSV_SHAPE', lid, line, col, what, mode });
  },
  'toggle-task': (dispatcher, target) => {
    const raw = target.getAttribute('data-pkc-task-line');
    const line = Number(raw);
    if (raw === null || !Number.isInteger(line) || line < 0) return;
    const st = dispatcher.getState();
    /**
     * 🔴 **どのノートの行かは、押した所から引く**(#277 段②-b で直した)。
     *
     * ⚠ 直す前は `openBody?.lid ?? selectedLid` だけを見ていた ── 本文の面では
     *   合っているが、**カンバンの札は別のノートの行**なので、押すと
     *   **開いているノートの同じ行番号**を書き換える(いちばん静かなデータ破壊)。
     * 🔑 札には `data-pkc-entry` が焼いてあるので、そこから引く。
     * ⚠ 本文の面は `data-pkc-entry` を持たない(器はノートを表す要素ではない)
     *   ので、そのときだけ「いま開いているノート」へ落ちる。
     */
    const fromDom = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
    const lid = fromDom ?? st.openBody?.lid ?? st.selectedLid;
    if (lid === null || lid === undefined) return;
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してからチェックしてください' });
      return;
    }
    /**
     * 🔴 **繰り返しの回は、規則の行の印を押さない**(#344 段②)。
     *
     * ⚠ 押すと「この繰り返しは終わり」の意味になり、**以後の回が全部消える** ──
     *   user は「今日のぶんが済んだ」と言いたかっただけである。
     * 🔑 その日ぶんの行を本文に増やす(`MATERIALIZE_REPEAT`)。
     * ⚠ どの回かは**札に焼いた日**から引く ── 行番号は 1 本しか無いので、
     *   それだけでは「どの日を押したか」が決まらない。
     */
    const rep = target.closest<HTMLElement>('[data-pkc-task-repeat]');
    const on = rep?.getAttribute('data-pkc-task-date') ?? '';
    if (rep !== null && on !== '') {
      dispatcher.dispatch({ type: 'MATERIALIZE_REPEAT', lid, line, date: on });
      return;
    }
    dispatcher.dispatch({ type: 'TOGGLE_TASK', lid, line });
  },
  'calendar-nav': (dispatcher, target) => {
    // 遷移先は renderer が描画時に焼き込む(binder は「今の月」を推定しない)
    const year = Number(target.getAttribute('data-pkc-nav-year'));
    const month = Number(target.getAttribute('data-pkc-nav-month'));
    if (!Number.isInteger(year) || !Number.isInteger(month)) return;
    dispatcher.dispatch({ type: 'SET_CALENDAR_MONTH', year, month });
  },
  'calendar-today': (dispatcher) => {
    const now = new Date();
    dispatcher.dispatch({
      type: 'SET_CALENDAR_MONTH',
      year: now.getFullYear(),
      month: now.getMonth() + 1,
    });
  },
  'toggle-show-archived': (dispatcher) =>
    dispatcher.dispatch({ type: 'TOGGLE_SHOW_ARCHIVED' }),
  /**
   * 板の「完了」を開く / 畳む(2026-08-20。設計 doc §4-4)。
   * ⚠ `toggle-show-archived`(片付けた**ノート**)とは別物 ── 相乗りさせない。
   */
  'toggle-show-done': (dispatcher) =>
    dispatcher.dispatch({ type: 'TOGGLE_SHOW_DONE_TASKS' }),
  /**
   * 🔴 **日付のない項目も出す / 出さない**(user 指示 2026-08-23)。
   * ⚠ `toggle-show-done`(済んだ**行**)/ `toggle-show-archived`(片付けた**ノート**)
   *   とは別物 ── 3 つとも相乗りさせない(見ている次元が違う)。
   */
  'toggle-show-undated': (dispatcher) =>
    dispatcher.dispatch({ type: 'TOGGLE_SHOW_UNDATED_TASKS' }),
  /**
   * 予定の面の月送り。⚠ **遷移先は描画時に焼いてある**(`data-pkc-nav-*`)──
   * binder に「いま表示している月」の別ソース(実時刻)を持たせない。
   */
  'schedule-nav': (dispatcher, target) => {
    const year = Number(target.getAttribute('data-pkc-nav-year'));
    const month = Number(target.getAttribute('data-pkc-nav-month'));
    if (!Number.isFinite(year) || !Number.isFinite(month)) return;
    dispatcher.dispatch({ type: 'SET_CALENDAR_MONTH', year, month });
  },
  /**
   * 🔴 **ノート 1 件に日付を付ける / 選び直す**(#292 段④)。
   * ⚠ 掴む札がまだ無いとき(日付を 1 度も付けていないノート)のための口である ──
   *   主の道は予定の面で掴んで落とすこと。
   */
  'set-entry-date': (dispatcher, _target, _services, root) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid === null) return;
    void pickDateInApp(root, new Date(), DATE_SHORTCUTS, (id, now) =>
      isDateShortcut(id) ? shortcutDate(id, now) : '',
    ).then((picked) => {
      if (picked === null) return;
      // ⚠ ノートの日付に時刻は無い(抽出列が `YYYY-MM-DD` だけを受ける)
      dispatcher.dispatch({ type: 'SET_ENTRY_DATE', lid, date: picked.date });
    });
  },
  /** 🔴 **置けるなら外せる**(片道を作らない)。 */
  'clear-entry-date': (dispatcher) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid === null) return;
    dispatcher.dispatch({ type: 'SET_ENTRY_DATE', lid, date: null });
  },
  'schedule-today': (dispatcher) => {
    const now = new Date();
    dispatcher.dispatch({
      type: 'SET_CALENDAR_MONTH',
      year: now.getFullYear(),
      month: now.getMonth() + 1,
    });
  },
  /**
   * 🔴 **升目を押したら、その日の束へ送る**(掴まずに使う道)。
   * ⚠ 束が無い日(予定 0 件)は**何も起きない** ── 空の束を作ると、
   *   押しても何も無い見出しが増える。
   */
  'schedule-pick-day': (_dispatcher, target, _services, root) => {
    const date = target.getAttribute('data-pkc-drop-date');
    if (date === null) return;
    root
      .querySelector(`[data-pkc-region="schedule-group"][data-pkc-drop-date="${date}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  },
  'retry-persist': (dispatcher) => dispatcher.dispatch({ type: 'RETRY_PERSIST' }),
  /**
   * 🔴 **フォルダへ入る / ルートへ戻る**(#240 段①)。
   *
   * ⚠ 直す前、パンくずのルートは `DESELECT_ENTRY` を撃っており、**現在地を戻すと
   * 中央のノートまで閉じて**いた(現在地が `selectedLid` の純関数だったため、
   * ルート表示 = 選択解除しか書きようが無かった)。現在地を state に持った今は、
   * **選択に触らずに現在地だけ**動かす。
   * ⚠ 押した要素が `data-pkc-entry` を持たなければ**ルート**(パンくずの先頭)。
   */
  'enter-folder': (dispatcher, target) => {
    const lid = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
    dispatcher.dispatch({ type: 'SET_SCOPE', lid });
  },
  /**
   * 🔴 **居場所を変える**(2026-08-05、user 報告「フォルダ整理のための導線がない」)。
   * 空値 = ルートへ出す。⚠ 動かす当人は**帯自身**が持っている
   * (`selectedLid` を読み直すと、選び直した直後に別のものを動かす)。
   */
  'move-entry': (dispatcher, target, services) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (!lid) return;
    const value = target instanceof HTMLSelectElement ? target.value : '';
    // 🔴 実体は `moveEntries` 1 本(D&D と同じ ── 断り方も知らせ方も揃う)
    moveEntries(dispatcher, [lid], value === '' ? null : value, services.showStatus);
  },
  /**
   * 🔴 **並べ替え**(2026-08-06。user 報告 2-10)。⚠ 動かす当人は帯が持つ
   * (`move-entry` と同じ理由 ── 押した瞬間に選択が変わっていても取り違えない)。
   */
  'move-order-up': (dispatcher, target) => moveOrder(dispatcher, target, 'up'),
  'move-order-down': (dispatcher, target) => moveOrder(dispatcher, target, 'down'),
  'attach-file': (_dispatcher, target) => {
    // 常設の hidden input を開く(動的生成にしない ── smoke の setInputFiles と
    // ブラウザの user-gesture 要件の両方に効く)
    target
      .closest('[data-pkc-region="shell"]')
      ?.querySelector<HTMLInputElement>('[data-pkc-field="attach-input"]')
      ?.click();
  },
  /**
   * 図を保存する(P8 段⑦)。⚠ 画面は PNG だが、**書き出すのはベクタ**
   * (user 指示 2026-08-03「SVG は書き出しのときだけ」)。
   * ⚠ 「何枚目か」は**描いた側の並び**から数える ── 器に番号を焼き込むと、
   * 図を 1 個消したときに番号が飛ぶ
   */
  'export-diagram': (_dispatcher, target, services, root) => {
    const host = target.closest<HTMLElement>('[data-pkc-mermaid-src]');
    const source = host?.getAttribute('data-pkc-mermaid-src');
    if (!host || !source) return;
    const all = [...root.querySelectorAll('[data-pkc-mermaid-src]')];
    const done = services.exportDiagram?.(source, Math.max(0, all.indexOf(host)));
    // 🔴 **無言で待たせない**(P8 段⑬ review M-3)。ベクタは原文から焼き直すので、
    //    mermaid 本体の読み込みを含めて秒が掛かる。何も起きないように見えると
    //    user は連打する ── 押せなくして、そのボタン自身に状態を出す
    const btn = target.closest<HTMLButtonElement>('[data-pkc-action="export-diagram"]');
    if (!btn || !(done instanceof Promise)) return;
    const label = btn.querySelector<HTMLElement>('[data-pkc-field="label"]');
    const was = label?.textContent ?? '';
    btn.disabled = true;
    btn.setAttribute('data-pkc-busy', '');
    if (label) label.textContent = '書き出し中…';
    const reset = (): void => {
      btn.disabled = false;
      btn.removeAttribute('data-pkc-busy');
      if (label) label.textContent = was;
    };
    // ⚠ **`finally` ではなく `then(reset, reset)`** ── `finally` は元の失敗を
    //    そのまま流すので、service が reject すると**未処理の rejection**になる
    //    (実際に test の stderr で出た。この repo は stderr 0 行を保つ規律)。
    //    失敗の**報告**は service 側が持つ ── ここは見た目を戻すだけ
    void done.then(reset, reset);
  },
  /**
   * 🔴 **番号付きリストの番号を振り直す**(#396)。
   *
   * ⚠ **押したときだけ**かける ── PKC2 は frontmatter で常時かけていたが、
   *   PKC3 のライブエディタは行ごとに欄を出すので、常時かけると
   *   **触っていない行が勝手に変わる**。
   * ⚠ 効く先は書式パネルと同じ 1 か所(`formatTarget`)── 2 列でも live でも動く。
   * ⚠ **`value` 直代入をしない** ── Ctrl+Z の履歴を捨てるので `setRangeText`。
   */
  'renumber-lists': (dispatcher, target, services) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const ta = formatTarget(root);
    if (ta === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集中に押してください' });
      return;
    }
    const next = renumberLists(ta.value);
    // ⚠ **変わらなかったことを言う** ── 押して無反応にしない
    if (next === ta.value) {
      services.showStatus?.('番号はもう揃っています');
      return;
    }
    ta.setRangeText(next, 0, ta.value.length, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    services.showStatus?.('番号を振り直しました');
  },
  /**
   * 🔴 **素の Markdown で写す**(#396)。
   *
   * > user 明示要望(PKC2 に記録):「方言記法されたエントリから
   * > ベーシックなマークダウンだけを取り出す機能」
   *
   * ⚠ PKC2 は**押せる口を持っていなかった**(拡張の RPC の option だけ)。
   * ⚠ file は落ちない(clipboard へ写す)── 他のツールへ貼るための物である。
   * 🔑 落とし方は `features/markdown/strip-dialect.ts` の 1 か所。
   */
  'copy-plain-markdown': (dispatcher, target, services) => {
    const st = dispatcher.getState();
    const lid = st.selectedLid;
    // ⚠ 本文は**開いているノートの物**でなければならない(別のノートを写さない)
    const body = st.openBody?.lid === lid ? st.openBody.body : null;
    if (lid === null || body === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '本文を開いてから押してください' });
      return;
    }
    const plain = stripDialect(body);
    if (services.copyText === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'この版では写せません' });
      return;
    }
    services.copyText(plain);
    services.showStatus?.('素の Markdown として写しました');
    void target;
  },
  /**
   * 🔴 **見出しで畳む**(#396)。⚠ 規則も器への当て方も
   *   `render/heading-fold.ts` に在る ── ここは**渡すだけ**。
   * ⚠ 本文の中身は 1 バイトも変わらない(見え方だけ)ので、
   *   `BODY_WRITE_ACTIONS` には**載せない**(取り込み中でも畳んでよい)。
   */
  'toggle-heading-fold': (_dispatcher, target) => {
    const heading = target.closest('h1,h2,h3,h4,h5,h6');
    if (heading !== null) toggleHeadingFold(heading);
  },
  /**
   * 🔴 **よく開くサイトをアプリ一覧に足す**(#401 ①)。
   *
   * ⚠ PKC3 は URL タイルを**表示も起動もできた**のに(`tiles.ts` が
   *   `attachment.launcher_url` を読む)、**作る口が 1 つも無かった** ──
   *   PKC2 では flag 既定 ON で全 user に届いていた導線である。
   *
   * 🔑 **1 回の `CREATE_ENTRY` で作る** ── 作ってから設定を書く 2 段にすると、
   *   間に別の書込が挟まったときに片方だけ残る(`SET_APP_TILE` が
   *   「読んで書き戻す」操作なのと同じ理由)。`body` に frontmatter を
   *   最初から入れておけば、その窓が無い。
   * ⚠ archetype は **`attachment`** でなければならない ── 一覧の材料を集める
   *   `attachmentEntries` がその型で絞っている(別の型で作ると**永久に出ない**)。
   * ⚠ **`edit: false`** ── 足した直後に本文の編集へ落ちると、user は
   *   「リンクを足したのに知らない画面が出た」になる。
   */
  'add-url-tile': (dispatcher, target, services) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const nameEl = root.querySelector<HTMLInputElement>('[data-pkc-field="launcher-add-name"]');
    const urlEl = root.querySelector<HTMLInputElement>('[data-pkc-field="launcher-add-url"]');
    const url = (urlEl?.value ?? '').trim();
    const name = (nameEl?.value ?? '').trim();
    // ⚠ **押して無反応にしない** ── 断るときは必ず理由を言う
    if (url === '') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'アドレスを入れてください' });
      return;
    }
    /**
     * 🔴 **開ける形だけ受ける**(`http` / `https`)。
     * ⚠ 判定は `tiles.ts` の 1 つを使う ── ここに 2 つ目の規則を書くと、
     *   片方だけ直る形になる(§7)。`javascript:` 等はあちらが弾く。
     */
    if (!isLaunchableUrl(url)) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: 'http:// か https:// で始まるアドレスを入れてください',
      });
      return;
    }
    // ⚠ 名前を省いたらアドレスをそのまま名前にする(無題のタイルを作らない)
    const title = name === '' ? url : name;
    dispatcher.dispatch({
      type: 'CREATE_ENTRY',
      lid: generateLid(),
      title,
      archetype: 'attachment',
      body: `---\nattachment.launcher_url: ${url}\n---\n`,
      edit: false,
    });
    // 🔑 **足したものがその場で出る** ── 読み直さないと、user は「押しても
    //    何も起きない」と読む(次に開いたときに出ても遅い)
    dispatcher.dispatch({ type: 'REFRESH_LAUNCHER_TILES' });
    if (nameEl) nameEl.value = '';
    if (urlEl) urlEl.value = '';
    services.showStatus?.(`「${title}」を足しました`);
  },
  /**
   * 🔴 **添付の名前を、その添付の画面から変える**(#401 ②)。
   *
   * ⚠ 改名の機構は在ったのに(`RENAME_ENTRY_TITLE`)、**添付の詳細面に口が
   *   無かった** ── 一覧へ戻って `F2` を押すか、編集画面を開くしかなかった。
   *   情報ペインの原則「**操作は対象の隣**」と自己矛盾していた。
   * ⚠ **新しい改名の規則を作らない** ── 既存の 1 つを撃つだけ
   *   (`binder.ts` の別の 2 か所と同じ action)。
   */
  'rename-attachment': (dispatcher, target) => {
    const lid = dispatcher.getState().selectedLid;
    if (!lid || !(target instanceof HTMLInputElement)) return;
    const title = target.value.trim();
    // ⚠ 空にはしない(無題の添付を作らない)── 元の字へ戻す
    if (title === '') {
      target.value = dispatcher.getState().entryMetas.get(lid)?.title ?? '';
      return;
    }
    dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title });
  },
  /**
   * ランチャーのタイル設定(P8 段⑭)。
   * ⚠ 対象は**いま選んでいるノート** ── この 3 つは添付の画面にしか出ない
   */
  'toggle-app-tile': (dispatcher, target) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid && target instanceof HTMLInputElement)
      dispatcher.dispatch({ type: 'SET_APP_TILE', lid, registered: target.checked });
  },
  'set-app-group': (dispatcher, target) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid && target instanceof HTMLInputElement)
      dispatcher.dispatch({ type: 'SET_APP_TILE', lid, group: target.value.trim() });
  },
  'set-app-icon': (dispatcher, target) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid && target instanceof HTMLInputElement)
      dispatcher.dispatch({ type: 'SET_APP_TILE', lid, icon: target.value.trim() });
  },
  /**
   * 添付の参照(`asset:<key>`)をコピーする(P8 段⑱)。
   * ⚠ 本文に貼れる形そのものを渡す ── key だけ渡すと user が書式を覚える必要がある
   */
  /**
   * 🔴 **このノートの参照をコピー**(#427 段①)。⚠ 添付(`copy-asset-ref`)と
   *   **同じ作法** ── 貼れる 1 行は押した要素が持っている(`data-pkc-entry-ref`)。
   *   ここで組み立て直すと、規則が 2 か所になる(§7)。
   */
  /**
   * 🔴 **構成をテキストでコピー**(#429 段①)。
   *
   * ⚠ 組み立ては**純関数**(`structureText`)── ここでは字を組まない。
   * 🔑 **何件出したかを知らせる** ── 黙ってコピーすると、user は
   *   「押せたのか / 空だったのか」を見分けられない(コピーの合図と同じ理由)。
   * ⚠ **ノートが 1 件も無いときは断る** ── 説明だけの紙を渡しても使えない。
   */
  'export-structure': (dispatcher, target, services) => {
    const st = dispatcher.getState();
    // ⚠ `entryMetas` は既に lid → meta の Map ── 組み直さない
    const out = structureText(st.entryMetas, st.relations);
    if (out.total === 0) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'ノートがまだありません' });
      return;
    }
    services.copyText?.(out.text);
    flashCopied(target);
    services.showStatus?.(
      out.shown === out.total
        ? `構成 ${out.total} 件をコピーしました`
        : `構成 ${out.total} 件のうち ${out.shown} 件をコピーしました`,
    );
  },
  /**
   * 🔴 **整理案を当てる**(#429 段③)。
   *
   * ⚠ **押せるのは誤りが 0 行のときだけ**(器の `disabled`)だが、ここでも
   *   もう一度検める ── 鍵やパレットから撃たれる道が将来できたときに、
   *   **門が器の側にしか無い**状態にしない。
   * ⚠ `@名前` → lid の解決は `resolvePlanTarget` **1 か所**を通す(下見と同じ答え)。
   */
  /**
   * 🔴 **設定だけを書き出す**(#414)。
   * ⚠ **ノートは入らない** ── バックアップ(`.pkc3.zip`)とは別物である。
   * 🔑 何を入れるかは `buildSettingsFile` が持つ ── ここは落とすだけ。
   */
  'export-settings': (dispatcher, _target, _services, root) => {
    void root;
    const file = buildSettingsFileData(readSetting);
    if (file.entries.length === 0) {
      // ⚠ **無言で空の file を落とさない** ── 押した user は「入った」と読む
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '持ち出せる設定がまだありません(見た目や鍵の割当を変えると入ります)',
      });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    downloadBlob(
      settingsFileName(today),
      new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
    );
  },
  /**
   * 🔴 **当てる**(#414)── ⚠ **下見に出したのと同じ物**を当てる。
   * 🔑 だから `settingsPlanText` を読み直して組み直す ── 別に憶えた配列を当てると、
   *   「見た通りに動かない」が静かに生まれる(§7)。
   */
  'apply-settings': (dispatcher, _target, _services, root) => {
    if (settingsPlanText === null) return;
    const plan = planSettingsImport(settingsPlanText, readSetting);
    /**
     * ⚠ **この行は「正しさ」を守っていない ── 二重の門である**(2026-08-26、
     *   変異試験 S9 が SURVIVED で教えた)。当てられないときボタンは
     *   **`disabled`**(`paintSettingsPlan`)なので、そもそもここへ来ない。
     * 🔑 残してあるのは、押し口が増えた日(近道・パレット)に
     *   **この口が単独で正しくある**ためで、守っている test は無い
     *   (CLAUDE.md「これが無いと壊れる、と書く前に外して壊れるのを見る」)。
     */
    if (!canApplySettings(plan)) return;
    let wrote = 0;
    for (const c of plan.changes) {
      try {
        localStorage.setItem(c.key, c.to);
        wrote += 1;
      } catch {
        // ⚠ 1 件書けなくても残りは当てる(全部捨てるほうが害が大きい)
      }
    }
    paintSettingsPlan(root, null);
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="settings-file-input"]');
    if (input !== null) input.value = '';
    /**
     * 🔴 **読み直しが要ることを言う** ── 鍵の割当も紙面も**起動時に読む**ので、
     *   当てただけでは画面が変わらない。⚠ 言わないと「効かなかった」と読まれる。
     */
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `設定を ${String(wrote)} 件入れました(画面に出るのは読み直してからです)`,
    });
  },
  'apply-plan': (dispatcher, _target, services, root) => {
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="plan-input"]');
    if (ta === null) return;
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから当ててください' });
      return;
    }
    const plan = parsePlan(ta.value, st.entryMetas);
    if (!canApplyPlan(plan)) return;
    /** この案で作ったフォルダ(`@名前` → いま作った lid)。 */
    const made = new Map<string, string>();
    for (const op of plan.ops) {
      if (op.kind === 'rename') {
        dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: op.lid, title: op.title });
        continue;
      }
      const parentLid = resolvePlanTarget(op.parent, made);
      if (op.kind === 'mkdir') {
        const lid = generateLid();
        dispatcher.dispatch({
          type: 'CREATE_ENTRY',
          archetype: 'folder',
          lid,
          title: op.title,
          parentLid,
          relationId: generateLid(),
          // ⚠ **編集に入らない** ── 入ると 2 件目以降が撃てなくなる
          edit: false,
        });
        if (op.alias !== null) made.set(op.alias, lid);
        continue;
      }
      dispatcher.dispatch({
        type: 'SET_ENTRY_PARENT',
        lid: op.lid,
        parentLid,
        relationId: generateLid(),
      });
    }
    // 🔑 当てたら欄を空にする ── 残すと「もう一度押せる」ように見える(二重適用)
    ta.value = '';
    paintPlan(root, dispatcher, '');
    services.showStatus?.(`整理案を当てました(${plan.ops.length} 件)`);
  },
  /**
   * 🔴 **何が容量を食っているか**(#415)。
   *
   * ⚠ 数えるのは worker ── ここは**受け取って並べるだけ**である
   *   (並べ方も文言も `features/storage/storage-profile.ts` が持つ)。
   * ⚠ **押せない配線では断る** ── 「調べています…」のまま止めない。
   */
  'storage-profile': (dispatcher, _target, services, root) => {
    const list = root.querySelector<HTMLElement>('[data-pkc-field="storage-profile-list"]');
    const sum = root.querySelector<HTMLElement>('[data-pkc-field="storage-profile-summary"]');
    const shared = root.querySelector<HTMLElement>('[data-pkc-field="storage-profile-shared"]');
    if (list === null || sum === null || shared === null) return;
    if (services.storageProfile === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'この環境では容量を数えられません' });
      return;
    }
    sum.textContent = '調べています…';
    sum.hidden = false;
    void services.storageProfile().then(
      (result) => {
        const lines = profileLines(result, dispatcher.getState().entryMetas);
        sum.textContent = profileSummary(result);
        list.textContent = '';
        for (const l of lines) {
          const li = document.createElement('li');
          const b = document.createElement('button');
          b.type = 'button';
          // 🔑 押すとそのノートへ飛ぶ ── 見えても辿り着けないと 1 件ずつ探すことになる
          b.setAttribute('data-pkc-action', 'select-entry');
          b.setAttribute('data-pkc-entry', l.lid);
          b.textContent = profileLineText(l);
          li.append(b);
          list.append(li);
        }
        list.hidden = lines.length === 0;
        const note = sharedNote(lines);
        shared.textContent = note;
        shared.hidden = note === '';
        if (lines.length === 0) sum.textContent = `${profileSummary(result)} 重いノートはありません。`;
      },
      () => {
        // ⚠ 黙って止めない ── 「調べています…」のまま残すのがいちばん困る
        sum.textContent = '';
        sum.hidden = true;
        dispatcher.dispatch({ type: 'OP_FAILED', error: '容量を数えられませんでした' });
      },
    );
  },
  'copy-entry-ref': (_dispatcher, target, services) => {
    const ref = target
      .closest<HTMLElement>('[data-pkc-entry-ref]')
      ?.getAttribute('data-pkc-entry-ref');
    if (ref === null || ref === undefined) return;
    services.copyText?.(ref);
    flashCopied(target);
  },
  /**
   * 🔴 **本文の外部画像を、押して手元へ取り込む**(#264 段①+②)。
   *
   * > #264 の判断(2026-08-18):PKC は**ポータブルナレッジコンテナ**なので、
   * > 持ち出したら中身が消えるのは芯に反する ── だから取り込みたい。
   * > ただし**貼付のたびに自動で**はやらない(①相手が CORS を許していなければ
   * > 読めないので「取り込みました」が嘘になる ②貼った瞬間に第三者へ通信する)。
   *
   * ⚠ **押すことが同意である。** だから確認の窓は重ねない ── 代わりに
   *   **押す前に**枚数と「外へ通信する」ことをボタンの文言と説明に書いてある
   *   (`inspector.ts` の `paintAdoptImages`)。
   * 🔴 **本文は載せない** ── 対応(`url → asset:`)だけを reducer へ渡し、
   *   effect が **disk から読み直して**当てる(`REQUEST_BODY_REWRITE` の作法)。
   *   画面の本文を基底にすると、取りに行っている間の別窓の書込を巻き戻す。
   * ⚠ **入らなかったものは理由を言う**(段②)── 黙って元のままにしない。
   */
  'adopt-external-images': (dispatcher, target, services) => {
    const lid = target.getAttribute('data-pkc-entry');
    const adopt = services.adoptUrls;
    if (lid === null || adopt === undefined) return;
    const st = dispatcher.getState();
    const ob = st.openBody;
    /**
     * ⚠ **本文が手元に無いときは断る** ── ここで worker へ読みに行くと、
     *   「押した瞬間に読み込みが走る」経路がもう 1 本増える(§7)。
     *   ボタンは本文が読めているときしか出ないので、通常は起きない。
     */
    if (!ob || ob.lid !== lid) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '本文が読めていないため取り込めません(ノートを開き直してください)',
      });
      return;
    }
    const urls = externalImageUrls(ob.body);
    if (urls.length === 0) return;
    /**
     * 🔴 **押した合図を先に出す**(通信は数秒かかる)。
     * ⚠ これは `adoptUrls` が **`queued`(断らずに待つ)**を使うための条件でもある ──
     *   `asset-gate.ts` は「user のクリック起点の操作は**断る**側が正しい
     *   (待たされるより『いま整理中です』と言われた方が分かる)」と書いているが、
     *   その禁止の目的は**説明の無い待ち**を作らないことである。ここは
     *   この一報が出ているので待たされる理由が画面に在り、しかも待てば成功する
     *   (断ると user はもう一度押し直すことになる)。
     */
    services.showStatus?.(`外部の画像 ${urls.length} 枚を取りに行っています…`);
    void adopt(urls, ADOPTED_IMAGE_PREFIX).then(({ adopted, failures }) => {
      if (adopted.size > 0) {
        dispatcher.dispatch({
          type: 'ADOPT_EXTERNAL_IMAGES',
          lid,
          adopted: Object.fromEntries(adopted),
        });
        services.showStatus?.(`外部の画像 ${adopted.size} 枚を手元に取り込みました`);
      }
      /**
       * 🔴 **理由は必ず出す**(段②)。⚠ `state.error` は **1 枠**なので、
       *   成功の一報は `showStatus`(別の行)へ出し、こちらと**取り合わない**。
       */
      if (failures.length > 0) {
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: `外部の画像 ${describeAdoptFailures(failures)}(元の URL のまま残しています)`,
        });
      }
    });
  },
  'copy-asset-ref': (_dispatcher, target, services) => {
    // ⚠ 渡すのは**貼れる 1 行**(`![名前](asset:key)`)── 裸の `asset:key` を
    //    渡していた頃は、貼っても markdown としてはただの文字列だった(段⑱)。
    //    組み立ては描画側(`asset-ref-format.ts` 経由)。ここでは組み立て直さない
    const ref = target
      .closest<HTMLElement>('[data-pkc-asset-ref]')
      ?.getAttribute('data-pkc-asset-ref');
    if (!ref) return;
    services.copyText?.(ref);
    /**
     * 🔴 **押した手応えを出す**(#427 段①で気づいた ── 対称の反対側)。
     * ⚠ 直す前は**この 2 つだけ合図が無かった** ── 本文のコピー
     * (`copy-md-block` / `copy-source`)は光るのに、参照のコピーは**無音**で、
     * user から見て押せたのか分からない。⚠ 合図の形を 2 つ作らないために
     * `flashCopied` は共用してある(その docstring がそう書いている)のに、
     * **呼び忘れ**でここだけ外れていた。
     */
    flashCopied(target);
  },
  'download-asset': (dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-key');
    const name = target.getAttribute('data-pkc-asset-name') ?? 'download';
    if (key) services.downloadAsset?.(key, name);
  },
  /**
   * 🔴 **画像を別窓で見る**(#192)。⚠ 開けなかったとき(popup 阻止)の後始末は
   *   呼ばれる側が持つ ── ここで持つと、経路が増えたときに片方だけ古くなる。
   */
  'view-asset': (_dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-key');
    const name = target.getAttribute('data-pkc-asset-name') ?? '添付';
    // ⚠ MIME を**押した要素から**運ぶ ── 開く側で引き直すと、開くまでに
    //    選択が移った場合に**別の添付の種類**で開いてしまう
    const mime = target.getAttribute('data-pkc-asset-mime') ?? '';
    if (key) services.viewAsset?.(key, name, mime);
  },
  'dismiss-notices': (_dispatcher, _target, services) => {
    services.dismissNotices?.();
  },
  'open-tile': (_dispatcher, target, services) => {
    const lid = target.closest('[data-pkc-tile]')?.getAttribute('data-pkc-tile');
    if (lid) services.openTile?.(lid);
  },
  /**
   * 🔑 **作る種類の一覧を開く / 閉じる**(P10 の分割ボタン)。
   * ⚠ `<details>` を使わない ── この repo は「主要な導線を畳まない」を規律に持ち、
   *   shell に `<details>` が 0 件であることを test で pin している。
   */
  'toggle-create-menu': (_dispatcher, target, _services, root) => {
    const menu = root.querySelector<HTMLElement>('[data-pkc-region="create-menu"]');
    if (!menu) return;
    const open = menu.hidden;
    menu.hidden = !open;
    target.setAttribute('aria-expanded', open ? 'true' : 'false');
  },
  /**
   * 🔑 **作る種類を選ぶ**(P10)。押した種類を「いま作るもの」にして、
   * **本体のボタンの文言・図案**と **`Ctrl+N` の対象**を同時に切り替える。
   * ⚠ 保持場所は `<select>` 1 か所 ── ボタンの属性と select が食い違うと、
   *   押した種類と出来るものが別になる(いちばん困る形)。
   */
  'pick-create-kind': (_dispatcher, target, _services, root) => {
    const archetype = target.getAttribute('data-pkc-archetype');
    if (!archetype) return;
    const select = root.querySelector<HTMLSelectElement>('[data-pkc-field="create-kind"]');
    if (select) select.value = archetype;
    const run = root.querySelector<HTMLElement>('[data-pkc-field="create-run"]');
    if (run) {
      run.setAttribute('data-pkc-archetype', archetype);
      const label = run.querySelector('[data-pkc-field="label"]');
      // ⚠ 文言は**選んだ項目の文言**をそのまま使う(表を 2 つ持たない)
      const picked = target.querySelector('[data-pkc-field="label"]')?.textContent ?? archetype;
      if (label) label.textContent = `+ ${picked}`;
      const icon = run.querySelector('[data-pkc-icon]');
      // ⚠ `textContent` で書かない(図案は要素)── `setIcon` で入れ替える
      if (icon) setIcon(icon, ARCHETYPE_ICONS[archetype] ?? 'dot');
    }
    const menu = root.querySelector<HTMLElement>('[data-pkc-region="create-menu"]');
    if (menu) menu.hidden = true;
    root
      .querySelector('[data-pkc-field="create-pick"]')
      ?.setAttribute('aria-expanded', 'false');
  },
  // ⚠ 対象は**いま選んでいる添付** ── 詳細画面のボタンなので lid は state が持つ
  'launch-asset': (dispatcher, _target, services) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid) services.launchAsset?.(lid, { sameOrigin: false });
  },
  'launch-asset-raw': (dispatcher, _target, services) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid) services.launchAsset?.(lid, { sameOrigin: true });
  },
  /**
   * 🔴 **目次を見せて起動**(#195 / C-5 段①)。⚠ ボタンは**まだ許していないとき
   * だけ**出る(許してあれば普通の「起動」で口が開く ── `detail.ts`)。
   */
  'launch-asset-extension': (dispatcher, _target, services) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid) services.launchAsset?.(lid, { extension: true });
  },
  /**
   * 🔴 **Office の別窓で開く**(#88 / O3-c)。
   *
   * ⚠ **同期のうちに渡しきる。** 窓は user gesture の中でしか開けないので、
   * ここで lid から本文を読み直す(= `await`)ことはできない ── 開くのに要る
   * 4 つは**押したボタンの属性**に載っている(`office-entry-view.ts` が載せる)。
   */
  'open-office': (_dispatcher, target, services) => {
    const assetKey = target.getAttribute('data-pkc-asset-key');
    if (!assetKey) return;
    services.openOffice?.({
      assetKey,
      name: target.getAttribute('data-pkc-asset-name') ?? '',
      mime: target.getAttribute('data-pkc-asset-mime') ?? '',
      // 🔴 **保存の戻り先**(#205)。⚠ 読み落とすと、Office での上書き保存が
      //    このノートを更新せず、新しい添付ノートを増やす
      lid: target.getAttribute('data-pkc-office-lid') ?? '',
    });
  },
  /**
   * Office 一式(#88 / O6-a)。⚠ どれも**実体が判断を持つ** ── ここは渡すだけ。
   * ⚠ `choose-office-pack` は picker を開くだけ(`attach-file` と同じ作法で、
   *   input は常設 hidden。動的生成にすると user gesture の要件を外す)。
   */
  'install-office-pack': (_dispatcher, _target, services) => {
    services.installOfficePack?.();
  },
  'choose-office-pack': (_dispatcher, target) => {
    target
      .closest('[data-pkc-region="settings-office"]')
      ?.querySelector<HTMLInputElement>('[data-pkc-field="office-pack-input"]')
      ?.click();
  },
  'remove-office-pack': (_dispatcher, _target, services) => {
    services.removeOfficePack?.();
  },
  'set-theme': (_dispatcher, target, services) => {
    // `<select>` なら選ばれた値、ボタンなら属性(どちらの形でも受ける)
    const theme =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-theme-value');
    if (theme) services.setTheme?.(theme);
  },
  /**
   * 🔴 **素のまま起動の許可を取り消す**(#301。user 裁定 2026-08-21)。
   * ⚠ 許可は**期限なし**で憶えるので、外す出口がここに無いと二度と外せない。
   */
  'revoke-same-origin': (_dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-key');
    if (key !== null && key !== '') services.revokeSameOrigin?.(key);
  },
  /**
   * 🔴 **目次を見せる許可を取り消す**(#195 / C-5 段①)。
   * ⚠ 許可は**期限なし**で憶えるので、外す出口がここに無いと二度と外せない。
   */
  'revoke-extension': (_dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-key');
    if (key !== null && key !== '') services.revokeExtension?.(key);
  },
  'set-paste-source': (_dispatcher, target, services) => {
    // ⚠ `set-external-images` と同じ受け方(`<select>` でもボタンでも通す)
    const id =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-paste-source-value');
    if (id) services.setPasteSource?.(id);
  },
  'set-external-images': (_dispatcher, target, services) => {
    // ⚠ `set-theme` と同じ受け方(`<select>` でもボタンでも通す)
    const mode =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-external-images-value');
    if (mode) services.setExternalImages?.(mode);
  },
  'set-page-format': (_dispatcher, target, services) => {
    // ⚠ `set-theme` と同じ受け方(`<select>` でもボタンでも通す)
    const format =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-page-format-value');
    if (format) services.setPageFormat?.(format);
  },
  'set-editor-mode': (_dispatcher, target, services) => {
    // ⚠ `set-theme` と同じ受け方(`<select>` でもボタンでも通す)
    const mode =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-editor-mode-value');
    if (mode) services.setEditorMode?.(mode);
  },
  'set-flag': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    const name = target.getAttribute('data-pkc-flag');
    if (name && target instanceof HTMLInputElement) services.setFlag?.(name, target.checked);
  },
  'reset-flags': (_dispatcher, _target, services) => {
    services.resetFlags?.();
  },
  'allow-external-images': (_dispatcher, _target, services) => {
    services.answerExternalImages?.(true);
  },
  'deny-external-images': (_dispatcher, _target, services) => {
    services.answerExternalImages?.(false);
  },
  'apply-update': (_dispatcher, _target, services) => {
    services.applyUpdate?.();
  },
  'dismiss-update': (_dispatcher, _target, services) => {
    services.dismissUpdate?.();
  },
  /**
   * 「開く」で編集に入るかの設定(user 裁定 2026-08-18)。
   * ⚠ `set-notices-enabled` と同じ作法 ── checkbox の `checked` をそのまま渡す。
   */
  'set-open-in-edit': (_dispatcher, target, services) => {
    if (target instanceof HTMLInputElement) services.setOpenInEdit?.(target.checked);
  },
  'set-notices-enabled': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setNoticesEnabled?.(target.checked);
  },
  'dismiss-announce': (_dispatcher, _target, services) => {
    services.dismissAnnounce?.();
  },
  'mute-announce': (_dispatcher, _target, services) => {
    services.muteAnnounce?.();
  },
  'export-archive': (_dispatcher, _target, services) => {
    services.exportArchive?.();
  },
  'export-html': (_dispatcher, _target, services) => {
    services.exportHtml?.();
  },
  'export-markdown': (_dispatcher, _target, services) => {
    services.exportMarkdown?.();
  },
  'export-portable': (_dispatcher, _target, services) => {
    services.exportPortable?.();
  },
  'export-entry-pdf': (dispatcher, target, services) => {
    // ⚠ 解決規則は隣の 2 つと**同じ**にする(片方だけ `selectedLid` 固定だと
    //    「A を刷って B を消す」が成立する)
    const lid = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry')
      ?? dispatcher.getState().selectedLid;
    if (lid) services.printNote?.(lid);
  },
  'export-entry-docx': (dispatcher, target, services) => {
    // ⚠ 解決規則は `export-entry` と**同じ**にする(隣に並ぶボタンなので、
    //    片方だけ `selectedLid` 固定だと「A を Word にして B を消す」が成立する)
    const lid = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry')
      ?? dispatcher.getState().selectedLid;
    if (lid) services.exportEntryDocx?.(lid);
  },
  'export-entry-pptx': (dispatcher, target, services) => {
    // ⚠ 解決規則は隣の 3 つ(`export-entry` / `-docx` / `-pdf`)と**同じ**にする
    const lid = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry')
      ?? dispatcher.getState().selectedLid;
    if (lid) services.exportEntryPptx?.(lid);
  },
  'export-entry': (dispatcher, target, services) => {
    // ⚠ 解決規則は `delete-entry` と**同じ**にする(review M-3)── 隣に並べる
    // ボタンなので、片方だけ `selectedLid` 固定だと filer / sidebar の行に
    // 並べた瞬間に「A を書き出して B を削除する」が成立する
    const lid =
      target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ??
      dispatcher.getState().selectedLid;
    if (lid) services.exportEntry?.(lid);
  },
  'export-folder': (dispatcher, target, services) => {
    // ⚠ 解決規則は隣の `export-entry` / `delete-entry` と**同じ**にする ── 揃えないと
    //    「A を書き出して B を削除する」が成立する(review M-3 と同じ形)
    const lid =
      target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ??
      dispatcher.getState().selectedLid;
    if (lid) services.exportFolder?.(lid);
  },
  'purge-orphan-assets': (_dispatcher, _target, services) => {
    services.purgeOrphanAssets?.();
  },
  'import-file': (_dispatcher, target) => {
    target
      .closest('[data-pkc-region="shell"]')
      ?.querySelector<HTMLInputElement>('[data-pkc-field="import-input"]')
      ?.click();
  },
  // ── P5b: 履歴 / ゴミ箱 ──
  'show-history': (dispatcher) => {
    // 🔴 **無言で断らない**(P8 段⑲)── `SHOW_HISTORY` は `phase !== 'ready'` で
    //    何も返さず、押しても panel も理由も出なかった
    if (dispatcher.getState().phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してから履歴を開いてください',
      });
      return;
    }
    dispatcher.dispatch({ type: 'SHOW_HISTORY' });
  },
  'hide-history': (dispatcher) => dispatcher.dispatch({ type: 'HIDE_HISTORY' }),
  /**
   * 🔴 **いま見ているノートを、開いている拡張へ 1 件渡す**(#195 / C-5 段②-b)。
   *
   * ⚠ **user のジェスチャでしか流れない** ── 拡張から取りに行く口は作っていない
   *   (`ext-wire.ts` の `parseExtRequest` は `hello` しか受けない)。
   *
   * 🔴 **本文は「飛んでいる書込が着いてから」読む**(CLAUDE.md §7、2026-08-17 の実測)。
   * ⚠ 書込は effect 層の chain に直列化されるが、**読みはその外**に在る ──
   *   待たずに読むと、保存した直後に押したとき**保存前の本文**が渡る
   *   (書き出しが同じ穴で 11/12 を踏んだ)。🔑 待つ口は既に 1 本ある(`settle`)。
   *
   * ⚠ **押しても無言、を作らない** ── 渡せなかったこと(窓が閉じた / まだ繋がって
   *   いない)は `false` で返るので、必ず声に出す。
   */
  'deliver-to-extension': (dispatcher, target, services) => {
    const linkId = target.getAttribute('data-pkc-ext-link');
    if (!linkId) return;
    const send = services.deliverToExtension;
    const read = services.readBodies;
    if (!send || !read) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'この版では送れません' });
      return;
    }
    const st = dispatcher.getState();
    const lid = st.selectedLid;
    const meta = lid === null ? undefined : st.entryMetas.get(lid);
    if (lid === null || meta === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '送るノートを選んでください' });
      return;
    }
    const app = st.openExtensions.find((o) => o.id === linkId);
    void Promise.resolve(services.settle?.() ?? null)
      .then(() => read([lid]))
      .then((bodies) => {
        const body = bodies.get(lid);
        if (body === undefined) {
          dispatcher.dispatch({ type: 'OP_FAILED', error: '本文を読めませんでした' });
          return;
        }
        const ok = send(linkId, deliveredEntryOf(meta, body));
        const where = app?.title ?? 'アプリ';
        if (ok) services.showStatus?.(`「${meta.title}」を「${where}」へ送りました`);
        else
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: `「${where}」へ送れませんでした(窓が閉じているかもしれません)`,
          });
      })
      .catch(() => {
        dispatcher.dispatch({ type: 'OP_FAILED', error: '送れませんでした' });
      });
  },
  /**
   * 🔴 **戻す前に中身を見る**(#398 段②)。⚠ **1 バイトも書かない** ──
   *   だから `BODY_WRITE_ACTIONS` にも確認にも載せない(読むだけの操作である)。
   * ⚠ もう一度押すと畳む(reducer が持つ ── ここに 2 つ目の判定を置かない)。
   */
  'preview-revision': (dispatcher, target) => {
    const revId = target
      .closest('[data-pkc-rev-id]')
      ?.getAttribute('data-pkc-rev-id');
    if (revId) dispatcher.dispatch({ type: 'PREVIEW_REVISION', revId });
  },
  'hide-revision-preview': (dispatcher) => {
    dispatcher.dispatch({ type: 'HIDE_REVISION_PREVIEW' });
  },
  'restore-revision': (dispatcher, target) => {
    // 前進変異(復元前に現状が履歴に積まれる)なので confirm は要らない ──
    // 「復元の取り消し」も履歴から戻れる
    const revId = target.getAttribute('data-pkc-rev-id');
    if (!revId) return;
    /**
     * 🔴 **編集中は声に出して断る**(#319)。⚠ 直す前は reducer の
     * `phase !== 'ready'` が**黙って捨てて**いたので、押しても 1 ドットも
     * 変わらず理由も出なかった ── P8 段⑲ で潰した「無言の操作拒否」。
     * 🔑 断り文は**この file の既存 8 か所と同じ型**へ流し込む
     *   (「文言は押した場所と対で pin する」── 面ごとに書き分けない)。
     */
    if (dispatcher.getState().phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから復元してください' });
      return;
    }
    dispatcher.dispatch({ type: 'RESTORE_REVISION', revId });
  },
  'write-back-file': (dispatcher, target, services) => {
    const lid =
      target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ??
      dispatcher.getState().selectedLid;
    if (lid) services.writeBackFile?.(lid);
  },
  'show-trash': (dispatcher) => dispatcher.dispatch({ type: 'SHOW_TRASH' }),
  'hide-trash': (dispatcher) => dispatcher.dispatch({ type: 'HIDE_TRASH' }),
  /**
   * 🔴 **開いている面を閉じて本文へ戻る**(user 目線レビュー U-3)。
   *
   * ⚠ 直す前、閉じる押しボタンは**どの面にも 1 つも無かった** ── 効くのは
   *   「アプリタブへ戻って同じタイルをもう一度押す」か `Alt+1` だけで、
   *   前者は左の列が別の一覧に変わっていると**その押す物が見えていない**、
   *   後者は**画面のどこにも出ていない**。
   * 🔑 `SET_VIEW_MODE 'detail'` は**編集中でも通る**(2026-08-19 の「本文へ
   *   戻る道は塞がない」)ので、編集中に開いたわきの面もこの × で閉じられる。
   */
  /**
   * 🔴 **アプリの窓では、窓ごと閉じる**(#300 段③ の直し)。
   * ⚠ 閉じられなかったときは**黙らない** ── 押したのに窓が残るので、
   *   理由を出してから本文へ畳む(無言の dead click を作らない)。
   */
  'close-pane': (dispatcher, _target, services) => {
    const closed = services.closeViewWindow?.() ?? 'not-a-window';
    if (closed === 'closed') return; // もう画面が無い
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    if (closed === 'refused')
      dispatcher.dispatch({ type: 'OP_FAILED', error: CLOSE_VIEW_WINDOW_REFUSED });
  },
  'restore-trash': (dispatcher, target) => {
    const revId = target.getAttribute('data-pkc-rev-id');
    const entryLid = target.getAttribute('data-pkc-trash-lid');
    if (!revId || !entryLid) return;
    // 🔴 **編集中は声に出して断る**(#319。理由は `restore-revision` と同じ)
    if (dispatcher.getState().phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから戻してください' });
      return;
    }
    dispatcher.dispatch({ type: 'RESTORE_TRASH', entryLid, revId });
  },
  'purge-trash': (dispatcher, _target, _services, root) => {
    /**
     * ⚠ **一括・不可逆**(revision の物理削除)── 受けボタンの字も**何が起きるか**に
     *   する。⚠ 直す前は `whenAbsent: false` で「確認が無い環境では通さない」と
     *   倒していたが、**その状態そのものが無くなった**(器はいつでも作れる)。
     */
    confirmThen(
      root,
      'ゴミ箱を空にします(削除済み entry の履歴も消え、元に戻せません)。よろしいですか?',
      { okLabel: '空にする', danger: true },
      dispatcher,
      notWhileEditing(dispatcher, '編集を終了してから空にしてください'),
      () => dispatcher.dispatch({ type: 'PURGE_TRASH' }),
    );
  },
};

/**
 * 近道のキー。⚠ **書式パネルに在る操作だけ**を割り当てる ── ここにしか無い
 * 操作を作ると「キーを知っている人にしかできないこと」が生まれる。
 */
/**
 * 🔴 **コマンド id → 書式**(#256)。直す前はここが `{b,i,k}` = **キーの綴り**だったので、
 * 割当を変えると書式が引けなくなった ── **割当は `features/keymap.ts` の表が正本**で、
 * ここが持つのは「そのコマンドが何をするか」だけである。
 */
/**
 * 🔴 **近道は「ボタンをそのまま押す」**(#197 で確立した作法の一般化)。
 * ⚠ 同じ操作が 2 通りの経路を持たない ── 押しボタン側の断り(編集中は無効 等)や
 * 「もう一度押したら戻る」が、鍵からも**同じように**効く。
 * ⚠ ボタンが無い面では**何も起きない**(`preventDefault` もしない = ブラウザに譲る)。
 */
/**
 * PKC の中の D&D で運ぶ型(#240 段④)。⚠ **OS からの file 受けと見分ける**ための
 * 独自 mime ── `Files` を見る既存の経路(添付 / 本文への貼付)に一切触らせない。
 */
const PKC_DRAG = 'application/x-pkc-lids';
/**
 * 🔴 **予定の札を運ぶ**(双方向。user 指示 2026-08-23)。
 *
 * ⚠ **`PKC_DRAG` とは別の型**にする ── あちらは「ノートをフォルダへ移す」で、
 *   こちらは「**本文の 1 行の日付を変える**」。混ぜると、フォルダの行へ札を
 *   落としたときに**ノートを移そうとする**(見当違いの操作が黙って走る)。
 * ⚠ 荷物は `lid` と**原文の行番号**だけ ── 時刻は state から引く
 *   (画面に出ている物と同じ出どころにする。§7)。
 */
const PKC_TASK_DRAG = 'application/x-pkc-task';

const SHORTCUT_BUTTON: Readonly<Record<string, string>> = {
  /**
   * 🔴 **戻る / 進むは、押しボタンを通す**(2026-08-26 に特例からここへ移した)。
   *
   * ⚠ 直す前は `cmd === 'nav-back'` の特例で `NAV_HISTORY` を直に投げていたが、
   *   ボタンの受け手(`ACTIONS['nav-back']`)が**同じ action を投げている**ので、
   *   同じ問いに答える口が 2 つ在った(CLAUDE.md §7)。
   * 🔑 寄せると**「いま押せるか」が正しく出る**ようになる ── 履歴が無い間
   *   ボタンは `disabled` なので、操作を名前で探す面(#425 段①)が
   *   「いまは押せません」と言える。特例のままだと**常に押せる**と嘘をつく。
   * ⚠ **鍵の側の振る舞いは 1 ドットも変わらない** ── 器は在る(`disabled` でも)
   *   ので既定は止まり、`click()` は無反応。履歴が無いときに `Alt+←` で
   *   **ブラウザが前のページへ戻る**、という事故は起きないままである。
   */
  'nav-back': '[data-pkc-action="nav-back"]',
  'nav-forward': '[data-pkc-action="nav-forward"]',
  'create-entry': '[data-pkc-field="create-run"]',
  'edit-entry': '[data-pkc-action="start-edit"]',
  'toggle-replace': '[data-pkc-action="toggle-replace"]',
  // ⚠ 近道は**ボタンをそのまま押す** ── 帯が無い(閲覧中の)面では何も起きない
  'insert-date': '[data-pkc-action="insert-date"]',
  'insert-entry-link': '[data-pkc-action="insert-entry-link"]',
  'insert-snippet': '[data-pkc-action="insert-snippet"]',
  'toggle-sidebar': '[data-pkc-action="toggle-pane"][data-pkc-pane="sidebar"]',
  'toggle-inspector': '[data-pkc-action="toggle-pane"][data-pkc-pane="inspector"]',
  'view-query': '[data-pkc-action="set-view"][data-pkc-view="query"]',
  'open-settings': '[data-pkc-action="set-view"][data-pkc-view="settings"]',
  'open-flags': '[data-pkc-action="set-view"][data-pkc-view="flags"]',
  'open-help': '[data-pkc-action="set-view"][data-pkc-view="help"]',
};

const FORMAT_OF: Readonly<Record<string, FormatOp>> = {
  'format-bold': 'bold',
  'format-italic': 'italic',
  'format-link': 'link',
  // 🔴 帯に出していない 4 つ(#425 段②-a)── 鍵だけが入口である
  'format-highlight': 'highlight',
  'format-ruby': 'ruby',
  'format-emdot': 'emdot',
  'format-strike': 'strike',
};

/**
 * 🔴 **記法を欄へ当てる、唯一の口**(#425 段②-b。CLAUDE.md §7)。
 *
 * ⚠ 直す前は**同じ 3 行が 2 か所に写して**あった(2 列の `editor-body` と
 *   1 面の `row-source`)── そこへパレットからの経路を足すと **3 か所**になる。
 *   片方だけ直すと「鍵で入る形」と「パレットで入る形」が静かに食い違う。
 *
 * @returns その命令が記法でなければ `false`(呼び側は既定を止めない)
 */
export function applyFormatTo(
  ta: HTMLTextAreaElement,
  cmd: string,
  /**
   * 🔴 **当てる範囲を外から渡す**(2026-08-27、実測で判明した競合の直し)。
   *
   * ⚠ 渡さなければ**いまの選択**を読む(鍵で入れる経路はこちら ── 焦点は
   *   ずっとこの欄に在るので、読む時機の問題が無い)。
   * ⚠ **焦点が返ってくる経路(パレット)は必ず渡す** ── 理由は
   *   `openCommandPalette` の註記(焦点が返る瞬間の選択は `0,0` である)。
   */
  range?: { readonly start: number; readonly end: number },
): boolean {
  const op = FORMAT_OF[cmd];
  /**
   * ⚠ **ここへ記法でない命令は来ない**(呼び側 3 つとも先に `FORMAT_OF` を見る)──
   *   2026-08-26 の変異試験 P8 が SURVIVED で教えた。⚠ 返り値を `true` に変えても
   *   落ちる test は無い。🔑 残してあるのは**この関数の約束**(記法でなければ
   *   何もせず false)を字面で示すためで、守っている test は無い。
   */
  if (op === undefined) return false;
  writeBack(
    ta,
    applyFormat(
      {
        text: ta.value,
        start: range?.start ?? ta.selectionStart,
        end: range?.end ?? ta.selectionEnd,
      },
      op,
    ),
  );
  return true;
}

/**
 * 🔴 **記法を当てられる欄か**(#425 段②-b)。
 * ⚠ **欄の名前で見る**(面ではなく)── 2 列の本文と 1 面の行は別の面に在るが、
 *   どちらも記法を受ける。⚠ 題名は受けない(題名に太字を入れても意味が無い)。
 */
export function formatTargetOf(el: unknown): HTMLTextAreaElement | null {
  if (!(el instanceof HTMLTextAreaElement)) return null;
  const f = el.getAttribute('data-pkc-field');
  return f === 'editor-body' || f === 'row-source' ? el : null;
}

function isEditorBody(el: EventTarget | null): el is HTMLTextAreaElement {
  return (
    el instanceof HTMLTextAreaElement &&
    el.getAttribute('data-pkc-field') === 'editor-body'
  );
}

export function bindActions(
  root: HTMLElement,
  dispatcher: Dispatcher,
  services: BinderServices = {},
  /**
   * 🔴 **キーの割当**(#256)。既定はアプリ共有の 1 個。
   * ⚠ **test は自分で `new KeymapStore(...)` して渡す**(`appEditorMode` と同じ作法)──
   *   共有の 1 個を書き換えると、別の test に割当が漏れる。
   */
  keymap: KeymapStore = appKeymap,
  /**
   * 🔴 **「開く」で編集に入るか**(user 裁定 2026-08-18)。既定はアプリ共有の 1 個。
   * ⚠ **test は自分で `new OpenInEditStore(...)` して渡す**(`keymap` と同じ作法)──
   *   共有の 1 個を書き換えると、別の test に設定が漏れる。
   */
  openInEdit: OpenInEditStore = appOpenInEdit,
): () => void {
  /**
   * action を 1 本の口から回す。⚠ **ここを通さない呼び方をしない** ──
   * 実行中(書出し / 取込)のガードはここに 1 回だけ置く(P8 段㉑)。
   * 入口ごとに書くと、必ずどれかが素通しになる(実際そうだった)。
   */
  /**
   * 🔴 **押した部品が「押した結果」消える 2 ペインの操作**(#273、2026-08-24 に実測)。
   *
   * ⚠ `dual-filer.ts` は、指紋が変われば帯も表も **`textContent = ''` で丸ごと
   *   組み直す**。だから押したボタンごと無くなり、`document.activeElement` が
   *   **`body` へ落ちる** ── そこから先は keydown の的がペインの外になるので、
   *   `dual` 文脈の鍵が **1 つも当たらない**(`Backspace` で戻ることすらできない)。
   * ⚠ **キーボードで動かした回は効いていた** ── `filer-open` などが既に
   *   `carryDualFocus` を呼んでいるからで、**マウスの経路にだけ穴が空いていた**
   *   (CLAUDE.md「片側を直したら、対称の反対側を必ず疑う」)。
   * 🔑 **立て直しは 1 か所**(ここ)── handler ごとに書くと、次に足す操作で
   *   また忘れる。⚠ 左の列(`filer.ts`)は**描画側**が同じことをしている
   *   (`focusedBefore` → 組み直しの後に戻す)ので、ここでは触らない。
   */
  const DUAL_REBUILDS_CLICKED: ReadonlySet<string> = new Set([
    'dual-crumb',
    'dual-tab-activate',
    'dual-tab-add',
    'dual-tab-close',
  ]);
  const run = (action: string | null, el: HTMLElement): void => {
    if (!action) return;
    const handler = ACTIONS[action];
    if (!handler) return;
    if (refuseWhileBusy(action, dispatcher, services)) return;
    handler(dispatcher, el, services, root);
    if (DUAL_REBUILDS_CLICKED.has(action)) {
      const side = dualSide(el);
      if (side !== null) carryDualFocus(side);
    }
  };
  const onClick = (ev: Event) => {
    /**
     * 🔴 **読んでいる本文の「この行」から編集に入る**(#395 段③。PKC2 の
     * `action-binder.ts:1329-1412` に在った動線 ── 2026-07-03 の user request)。
     *
     * > user の物語: 長い議事録を読んでいて、この 1 行だけ直したい。
     * > いまは「編集」を押してから、もう一度その行を探して押す(2 手)。
     *
     * 🔴 **早期 return より前に置く**(2 稿目。test が拾った)── 下の 1 行は
     *   `[data-pkc-action]` の中でなければ降りるが、**本文の段落は action を
     *   持たない**。後ろに置くと、この動線は**1 度も走らない**。
     * ⚠ **素のクリックの意味は変えない** ── PKC3 は browse-first(「開く = 閲覧」は
     *   2026-08-18 の裁定)。修飾キーを押しているときだけである。
     * ⚠ **`Alt` だけ**(`Ctrl` / `Meta` / `Shift` が一緒なら降りる)── `Ctrl+Alt` は
     *   **AltGr** であり、その組で奪うと**記号が打てない配列の人**のクリックを壊す
     *   (binder の他の 2 か所と同じ理由)。`Ctrl` / `Meta` 単独はリンクの
     *   「新しいタブで開く」を奪う。
     * ⚠ **押せる物の上では降りる** ── リンク・ボタン・チェックの印は、その場に
     *   自分の意味を持っている(奪うと、その動線が 1 つ死ぬ)。
     * 🔑 行は読む面の刻印(`data-pkc-source-line`)から引く ── **新しい逆引きを
     *   作らない**(`copy-source.ts` と同じ印を読む。§7)。
     * ⚠ 刻印が引けなければ**何もしない** ── 当てずっぽうで編集に入らない。
     */
    const alt = ev as MouseEvent;
    if (alt.altKey && !alt.ctrlKey && !alt.metaKey && !alt.shiftKey) {
      const hit = ev.target as HTMLElement | null;
      const bodyHost = hit?.closest('[data-pkc-field="detail-body"]') ?? null;
      const mark = hit?.closest('[data-pkc-source-line]') ?? null;
      const own = hit?.closest('a[href], button, [data-pkc-action]') ?? null;
      if (
        bodyHost !== null &&
        mark !== null &&
        root.contains(bodyHost) &&
        bodyHost.contains(mark) &&
        (own === null || !bodyHost.contains(own)) &&
        dispatcher.getState().phase === 'ready'
      ) {
        const line = Number(mark.getAttribute('data-pkc-source-line'));
        if (Number.isInteger(line) && line >= 0) {
          ev.preventDefault();
          dispatcher.dispatch({ type: 'START_EDIT', atLine: line });
          return;
        }
      }
    }
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-pkc-action]',
    );
    if (!el || !root.contains(el)) return;
    /**
     * 🔴 **アプリ内リンクは、ブラウザに遷移させない**(2026-08-08)。
     *
     * 本文の `[題名](entry:<lid>)` は `<a href="entry:…">` として出る
     * (`markdown-render.ts`)。ここは `preventDefault` を呼んでいなかったので、
     * ⚠ **押すとブラウザが未知スキームへの遷移を試みる**。`asset:` の枝だけは
     * 焼く側で href を剥がして避けていた ── **対称の反対側が放置されていた**。
     *
     * 🔑 **href を剥がす側では直さない**。剥がすと `<a>` が**フォーカスできなく
     * なり**、キーボードの動線が落ちる(= 記法を減らすのと同じ向き)。
     * ⚠ **`<a href>` に限る** ── checkbox(`set-flag` / `set-notices-enabled`)で
     *   呼ぶと**チェック状態が巻き戻る**。`data-pkc-action` を持つ `<a href>` は
     *   アプリ内リンクしか無い(`download-asset` は href を剥がしてある /
     *   目次・脚注は action を持たない)。
     */
    if (el instanceof HTMLAnchorElement && el.hasAttribute('href')) ev.preventDefault();
    /**
     * 🔴 **チェックの印は、DOM に先に付けさせない**(2026-08-19 のレビューで判明)。
     *
     * ⚠ 直す前は既定動作でブラウザが `checked` を反転していたので、
     *   **書き込みが断られても印だけ付いたまま残った** ── 断り経路は 3 つある
     *   (編集中 / 書換が当たらない / 保存の失敗)が、どれも `taskScan` も
     *   `entryMetas` も動かさないので**描画器は早期 return** し、
     *   **印を戻す者が居ない**。user から見ると「チェックしたのに保存されない」で、
     *   `markdown-render.ts` が明文で禁じている当の挙動である。
     * 🔑 **状態が DOM を決める**の原則へ寄せる ── 押した瞬間は何も変えず、
     *   本文の書換が届いた時にだけ印が動く(本文の面も板も同じ経路)。
     * ⚠ 他の checkbox(`set-flag` 等)には掛けない ── あちらは state を持たず
     *   DOM 自身が値なので、止めると**巻き戻って見える**。
     */
    if (el.getAttribute('data-pkc-action') === 'toggle-task') ev.preventDefault();
    /**
     * 🔴 **修飾つきのクリックは「印を付ける」**(#240 段②。user 指示 2026-08-17
     * 「複数選択・範囲選択」)。
     *
     * ⚠ 行を選ぶ操作(`select-entry`)にだけ効かせる ── ボタンやリンクで
     * `Ctrl` クリックを奪うと、ブラウザの「新しいタブで開く」を壊す。
     * ⚠ **中央は開き直さない**(印を付けただけで本文が入れ替わらない)。
     * ⚠ `Shift` は**表示順**で範囲を採る(規則は reducer の `filerRows` 1 か所)。
     */
    const me = ev as MouseEvent;
    /**
     * 🔴 **フォルダ面の中だけ**(着地前レビュー 4)。`select-entry` は 6 か所に在る
     * (sidebar / filer / kanban / calendar / query / inspector)ので、面で切らないと:
     * - 一覧タブの `Ctrl` クリックが**画面に出ない印**を増やす(帯だけが数える)
     * - `Shift` の範囲は `filerRows` の並びで採るので、**目で見た並びと違う集合**になる
     *   (フォルダの中の行なら `[]` になり、`preventDefault` 済みなので**選択すら起きない**)
     * - inspector の「関連へ飛ぶ」ボタンで `Ctrl` クリックが奪われる
     * 段②③④は**フォルダ面の機能**である(設計 doc §3)。
     */
    const inFiler = el.closest('[data-pkc-region="filer-table"]') !== null;
    /**
     * 🔴 **2 ペインの行も同じ作法**(#241 段⑥-a)── `Ctrl` / `Cmd` で足し外し、
     * `Shift` で表示順の範囲。⚠ 面ごとに違う選び方を作らない(user は 1 つの
     * ファイラだと思って触る)。
     * ⚠ 側は**押した行**から辿る(`dualSide`)── state の焦点から推測しない。
     */
    if (
      el.getAttribute('data-pkc-action') === 'dual-row' &&
      (me.ctrlKey || me.metaKey || me.shiftKey)
    ) {
      const side = dualSide(el);
      const lid = el.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
      if (side !== null && lid !== null) {
        ev.preventDefault();
        dispatcher.dispatch({
          type: 'DUAL_SELECT',
          side,
          lid,
          mode: me.shiftKey ? 'range' : 'toggle',
        });
        return;
      }
    }
    if (
      inFiler &&
      el.getAttribute('data-pkc-action') === 'select-entry' &&
      (me.ctrlKey || me.metaKey || me.shiftKey)
    ) {
      const lid = el.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
      if (lid !== null) {
        ev.preventDefault();
        dispatcher.dispatch(
          me.shiftKey ? { type: 'SELECT_RANGE', lid } : { type: 'TOGGLE_SELECT', lid },
        );
        return;
      }
    }
    const action = el.getAttribute('data-pkc-action');
    // ⚠ 行を素で押したときだけ「もう一度押した」を数える(修飾つきは印の話)
    // ⚠ **フォルダ面の中だけ**(上と同じ理由 ── 一覧タブで 2 回押すと、
    //    見えていない現在地が動いて「+ ノート」の作り先だけが変わる)
    if (inFiler && action === 'select-entry') {
      const lid = el.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
      if (lid !== null) maybeEnterFolder(lid);
    }
    // ⚠ 2 ペインも**同じ 2 クリック**でフォルダへ入る(規則は 1 本 ── ただし
    //    入る先はそのペインなので、撃つ action だけが違う)
    if (action === 'dual-row') {
      const side = dualSide(el);
      const lid = el.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
      if (side !== null && lid !== null) maybeEnterFolder(lid, side);
    }
    run(action, el);
  };
  /**
   * ⚠ 書式パネルのボタンは **focus を奪わない**。奪うと押すたびに編集欄が
   * focus を失って画面がちらつく(選択位置自体は残るので壊れはしない)。
   */
  const onMousedown = (ev: Event) => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-action]');
    /**
     * ⚠ **日付の道具も同じ**(2026-08-23)── 押した瞬間に焦点が飛ぶと、
     *   ダイアログを閉じたときに戻る先が**編集欄ではなくボタン**になり、
     *   挿す場所(caret)が分からなくなる。
     */
    const act = el?.getAttribute('data-pkc-action');
    if (act === 'format-text' || act === 'insert-date') ev.preventDefault();
  };
  const onInput = (ev: Event) => {
    if (isEditorBody(ev.target)) {
      dispatcher.dispatch({ type: 'UPDATE_OPEN_BODY', body: ev.target.value });
      return;
    }
    const el = ev.target;
    /**
     * 🔴 **整理案は、貼るたびに下見を描き直す**(#429 段③)。
     *
     * ⚠ **state に写さない** ── 案は「まだ当てていない下書き」であって、
     *   アプリの状態ではない(写すと、面を切り替えただけで別のタブへ飛ぶ)。
     * ⚠ 判定も文言も `structure-plan.ts` が持つ ── ここは描き直しを頼むだけ。
     */
    if (
      el instanceof HTMLTextAreaElement &&
      el.getAttribute('data-pkc-field') === 'plan-input'
    ) {
      paintPlan(root, dispatcher, el.value);
      return;
    }
    // 🔑 一覧の絞り込み(P7b 段⑨c)。⚠ **state に写す** ── renderer は
    // DOM から値を読まない、というこのリポジトリの規約
    if (
      el instanceof HTMLInputElement &&
      el.getAttribute('data-pkc-field') === 'entry-filter'
    ) {
      dispatcher.dispatch({ type: 'SET_ENTRY_FILTER', query: el.value });
      return;
    }
    /**
     * 🔴 **そのペインだけの絞り込み**(#273 残件)。
     * ⚠ **打つそばから効かせる**(`change` を待たない)── 器の絞り込みと
     *   同じ手触りにする。⚠ 器のほうと**別の口**なのは、絞る相手が違うからである。
     */
    if (
      el instanceof HTMLInputElement &&
      el.getAttribute('data-pkc-field') === 'dual-filter'
    ) {
      const side = dualSide(el);
      if (side !== null) dispatcher.dispatch({ type: 'DUAL_SET_FILTER', side, filter: el.value });
    }
  };
  const onChange = (ev: Event) => {
    const el = ev.target;
    // 🔑 `<select>` は click ではなく change で決まる ── 配色のように
    // 「選んだ瞬間に効く」ものはここで拾う(P8)
    if (el instanceof HTMLSelectElement) {
      const action = el.getAttribute('data-pkc-action');
      run(action, el);
      return;
    }
    if (!(el instanceof HTMLInputElement)) return;
    // 🔑 チェックボックス / テキスト欄も **change で確定**する(P8 段⑭)。
    //    ⚠ `input` ごとに撃たない ── グループ名を 1 文字打つたびに disk へ
    //    書き戻すことになる(欄を離れた時・Enter を押した時が確定)
    const changeAction = el.getAttribute('data-pkc-action');
    if (changeAction !== null && changeAction.startsWith('set-app-')) {
      run(changeAction, el);
      return;
    }
    /**
     * ⚠ **ここは許可リストである。**`data-pkc-action` を付けただけでは
     *   change では呼ばれない ── 登録し忘れると、**在るのに誰も呼ばない**
     *   無言の dead click になる(#401 ② を書いていて実際に踏んだ)。
     * 🔑 `repo-hygiene` の「受け手のいない action が無い」は**逆向き**しか見ない
     *   (handler が在るので緑になる)── だから足すときは必ずここも見る。
     */
    /**
     * ⚠ **`smart-field` を足したのは、まさにこの罠を踏んだから**(#421 段③)。
     *   語の条件を `<input>` にしたところ、`<select>` の 4 つと**同じ action**を
     *   付けたのに **change では 1 度も呼ばれなかった** ── 打っても
     *   「条件を選んでください」のまま(無言の dead click)。
     * 🔑 上の注記どおり **unit も `repo-hygiene` も鳴らない** ── 拾ったのは
     *   実ブラウザの smoke だけである(`smart-folder.smoke.spec.ts` の段③)。
     */
    if (
      changeAction === 'toggle-app-tile' ||
      changeAction === 'rename-attachment' ||
      changeAction === 'smart-field'
    ) {
      run(changeAction, el);
      return;
    }
    const field = el.getAttribute('data-pkc-field');
    /**
     * 🔴 **設定ファイルを選んだら、下見を出す**(#414)── ⚠ **当てない**。
     * ⚠ 読み込みは非同期なので、`change` の中で待つ(押し口は別に在る)。
     */
    if (field === 'settings-file-input') {
      const f = el.files?.[0] ?? null;
      if (f === null) {
        paintSettingsPlan(root, null);
        return;
      }
      void f.text().then(
        (text) => {
          paintSettingsPlan(root, text);
        },
        () => {
          dispatcher.dispatch({ type: 'OP_FAILED', error: '設定ファイルを読めませんでした' });
        },
      );
      return;
    }
    if (field === 'attach-input') {
      const files = el.files ? [...el.files] : [];
      el.value = ''; // 同じファイルの再選択でも change が発火するように
      if (files.length > 0) services.attachFiles?.(files);
    } else if (field === 'import-input') {
      // ⚠ 添付と同じく**全件**渡す ── md は複数選択できる(1 件ずつ entry に
      // なる)。PKC2 の書出しが複数来たときに断るのは import-file.ts の仕事で、
      // ここで 1 件目だけ拾って黙って落とさない
      const files = el.files ? [...el.files] : [];
      el.value = ''; // 同じファイルの再選択でも change が発火するように
      if (files.length > 0) services.importFiles?.(files);
    } else if (field === 'office-pack-input') {
      // ⚠ **1 件だけ**(一式は zip 1 本)。複数選ばれても先頭で決める ──
      //    2 本目を黙って捨てるのではなく、そもそも 1 本しか意味を持たない
      const file = el.files?.[0] ?? null;
      el.value = ''; // 同じファイルの再選択でも change が発火するように
      if (file) services.installOfficePackFromFile?.(file);
    }
  };
  const onKeydown = (ev: Event) => {
    const ke = ev as KeyboardEvent;
    // editor の 2 field(本文 textarea / title input)でのみ有効
    const field =
      ke.target instanceof HTMLElement
        ? ke.target.getAttribute('data-pkc-field')
        : null;
    // 🔴 IME ガード(PKC2 repo 慣行)── 変換中の Esc は「変換の取り消し」で
    // あって編集キャンセルではない。ガードが無いと draft 丸ごと破棄になる。
    // ⚠ **追記欄より先に置く** ── 変換確定の Enter で送ってしまうと、
    // 日本語で書く人は「打ち終わる前に飛ぶ」を毎回踏む
    if (ke.isComposing) return;
    /**
     * 🔴 **引用(`>`)を書き続けられるようにする**(#396)。
     *
     * ⚠ **IME ガードの直後**に置く ── 変換確定の Enter で引用を継ぎ足したら、
     *   日本語で書く人は毎回踏む。
     * ⚠ 修飾キーが付いた Enter は**別の意味**(確定 / 送信)なので触らない。
     * 🔑 規則は `features/markdown/quote-assist.ts` の 1 か所 ── ここは当てるだけ。
     * 🔑 **2 列の全文欄でも、ライブの行の欄でも効く**(どちらも Enter は
     *   その欄の中で改行する)。
     */
    if (
      ke.key === 'Enter' &&
      !ke.shiftKey &&
      !ke.ctrlKey &&
      !ke.altKey &&
      !ke.metaKey &&
      (field === 'editor-body' || field === 'row-source') &&
      ke.target instanceof HTMLTextAreaElement
    ) {
      const ta = ke.target;
      const r = quoteOnEnter(ta.value, ta.selectionStart);
      if (r.kind === 'continue') {
        ev.preventDefault();
        // ⚠ `setRangeText` を使う ── `value` 直代入は Ctrl+Z の履歴を捨てる
        ta.setRangeText(r.insert, ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if (r.kind === 'exit') {
        ev.preventDefault();
        ta.setRangeText(r.text, r.from, r.to, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    }
    /**
     * 🔴 **`role="link"` のものは Enter / Space で押せる**(2026-08-08)。
     *
     * `@card` の placeholder は `<span role="link" tabindex="0">` で出る
     * (`markdown-render.ts`)── ⚠ 直す前はこの下の `data-pkc-field` の門で
     * **必ず抜けていた**ので、**フォーカスできるのに Enter が効かない**要素が
     * 存在していた(user 指示「マウスだけで完結し、キーボードは近道」の破れ)。
     *
     * ⚠ **`data-pkc-field` の門より前**に置く(placeholder は field を持たない)。
     * ⚠ `<button>` / `<a>` はブラウザ既定で Enter → click に乗るので**対象外**。
     *
     * 🔴 **拾うのは `tabindex="0"`(巡回に入るもの)だけ**(2026-08-18 の着地前
     * レビュー 3)。`hasAttribute('tabindex')` で書いていたので、フォルダの行に
     * `tabindex="-1"` を足した瞬間に**行がこの経路へ入った** ── `-1` は
     * 「焦点を**置ける**」であって「**押せる**」ではないのに、`Space` が
     * `select-entry` を撃つ**登録も設定も説明も無い鍵**になっていた
     * (Ctrl クリックで 5 行に印 → 送ろうと Space → 印が 1 件に潰れる)。
     * ⚠ 行を相手にするのは `filer` 文脈の鍵のほう(下の `runFilerKey`)。
     */
    if (ke.key === 'Enter' || ke.key === ' ') {
      const el = ke.target instanceof HTMLElement ? ke.target : null;
      if (el?.getAttribute('tabindex') === '0' && el.hasAttribute('data-pkc-action')) {
        // ⚠ Space は既定でページを送る ── 押した先が動くほうが正しい
        ke.preventDefault();
        run(el.getAttribute('data-pkc-action'), el);
        return;
      }
    }
    // 追記欄: 既定は Ctrl/Cmd+Enter(欄の中だけ ── 画面全体の近道にしない)
    if (field === 'append-input') {
      if (keymap.match(ke, 'append') === 'append-send') {
        ke.preventDefault();
        run('append-entry', ke.target as HTMLElement);
      }
      return;
    }
    /**
     * 🔴 **live 面の行の入力欄にも書式の近道(Ctrl+B/I/K)を効かせる**(2026-08-08)。
     * 直す前は下の門(editor-body / editor-title)で弾かれて**無言 no-op** だった。
     * ⚠ ここで受けるのは FORMAT_KEYS **だけ** ── Ctrl+S / Esc は行の側
     * (`row-swap.ts`)が「行の確定 / 行の取り消し」として持つ。ここで
     * `COMMIT_EDIT` / `CANCEL_EDIT` を撃つと**編集の面ごと閉じてしまう**(別の操作)。
     */
    if (field === 'row-source') {
      const rowCmd = keymap.match(ke, 'row');
      if (rowCmd === null || FORMAT_OF[rowCmd] === undefined) return;
      ke.preventDefault();
      // 🔑 当て方は `applyFormatTo` 1 か所(§7 ── パレットも同じ口を通る)
      applyFormatTo(ke.target as HTMLTextAreaElement, rowCmd);
      return;
    }
    /**
     * 🔴 **雛形を `Tab` で挿す / 次の印へ移る**(#196 / B-2 段②)。
     *
     * ⚠ **短縮語が先、印が後**である ── 短縮語は**カーソルのすぐ手前**(user が
     *   いま打った字)だが、印は本文のどこか先に在る。逆にすると、後ろに `${…}` が
     *   残っているノートで短縮語を打った瞬間、**展開されずに遠くへ飛ぶ**。
     * ⚠ **どちらも当たらなければ `preventDefault()` しない** ── textarea の `Tab` は
     *   既定で焦点移動なので、常に握ると**編集欄から `Tab` で出られなくなる**
     *   (キーボードだけで使う人の動線を 1 つ殺す)。
     * ⚠ `isComposing` は上で弾き済み ── 変換中の `Tab` は確定に使われる。
     */
    if (field === 'editor-body' && ke.key === 'Tab' && !ke.shiftKey) {
      const ta = ke.target as HTMLTextAreaElement;
      const items = dispatcher.getState().snippetScan?.items ?? [];
      const collapsed = ta.selectionStart === ta.selectionEnd;
      const hit = collapsed ? abbrBeforeCaret(ta.value, ta.selectionStart, items) : null;
      if (hit !== null) {
        ke.preventDefault();
        writeBack(
          ta,
          insertSnippet(
            { text: ta.value, start: hit.start, end: ta.selectionEnd },
            hit.item.body,
            new Date(),
          ),
        );
        return;
      }
      // ⚠ 次の印は**選択の終わりから**探す(いま選んでいる印をもう一度選ばない)
      const slot = nextSnippetSlot(ta.value, ta.selectionEnd);
      if (slot !== null) {
        ke.preventDefault();
        ta.setSelectionRange(slot.start, slot.end);
        return;
      }
    }
    if (field !== 'editor-body' && field !== 'editor-title') return;
    // PKC2 慣例: Ctrl/Cmd+S = 保存(ブラウザの保存ダイアログも抑止)、
    // Esc = キャンセル。Ctrl/Cmd+Enter も保存の別名として受ける
    // (PKC2 の章フォーカス編集が両対応だった)。altKey は除外(AltGr = Ctrl+Alt 誤発火)
    // ⚠ 追記(P8 段⑥)は**編集欄そのものを書き換える**ので、PKC2 のように
    // 「追記専用の textarea + Ctrl+Enter で確定」を別に持たない ── 別経路にすると
    // 編集中の draft と競合し、追記した節が保存で黙って消える(PKC2 の実測)
    const cmd = keymap.match(ke, 'editor');
    const op = cmd === null ? undefined : FORMAT_OF[cmd];
    if (cmd === 'commit-edit') {
      ke.preventDefault();
      // ⚠ 近道キーも同じ規則に乗せる(ボタンだけ止めても意味が無い)
      if (refuseWhileBusy('commit-edit', dispatcher, services)) return;
      renameFromEditorInput(dispatcher, root);
      dispatcher.dispatch({ type: 'COMMIT_EDIT' });
    } else if (field === 'editor-body' && op !== undefined && cmd !== null) {
      // 🔑 **キーボードは近道**(業務画面の作法 ── user 指示 2026-08-03)。
      // 本文だけ。題名に太字を入れても意味が無い。⚠ `isComposing` は上で弾き済み
      ke.preventDefault();
      // 🔑 当て方は `applyFormatTo` 1 か所(§7 ── パレットも同じ口を通る)
      applyFormatTo(ke.target as HTMLTextAreaElement, cmd);
    } else if (cmd === 'cancel-edit') {
      ke.preventDefault();
      cancelFromEditor(dispatcher, root);
    }
  };
  /**
   * 🔴 **本文を書く欄**(#250)── 貼った画像を**差し込んでよい**相手。
   *
   * 面ではなく**欄の名前**で見る:`row-source`(1 面)/ `editor-body`(2 列)/
   * `append-input`(継ぎ足し)の 3 つ。⚠ 継ぎ足しの欄は `detail` 面の**外**に在る
   * (`shell.ts` で兄弟)ので、面で見ると**そこだけ落ちる** ── PKC2 は
   * `isMarkdownTextarea` で欄を見ており、継ぎ足しにも貼れていた。
   */
  /**
   * 🔴 **画像かどうかの判定は 1 本**(2026-08-18、着地前レビュー)。
   *
   * ⚠ `f.type` を直に見ると、**MIME を付けない環境**から `.png` を落としたとき
   * 画像に見えない ── 拡張子から引く `resolveMime` を通す(添付の入口と同じ規則)。
   * ⚠ `!` を付けるかの判定は `asset-ref-format.ts` が正本(「この 1 本だけを使う」)。
   */
  const isImageFile = (f: File): boolean => isImageAssetMime(resolveMime(f.name, f.type));

  const BODY_FIELDS = new Set(['row-source', 'editor-body', 'append-input']);
  const isBodyInput = (t: EventTarget | null): t is HTMLTextAreaElement =>
    t instanceof HTMLTextAreaElement && BODY_FIELDS.has(t.getAttribute('data-pkc-field') ?? '');

  /**
   * 待っている間に作り直された欄を引き直す。
   * ⚠ **同じ種類の欄へ**戻す(継ぎ足しに貼ったものが本文へ入ると事故)。
   */
  const reResolveInput = (from: HTMLTextAreaElement): HTMLTextAreaElement | null => {
    if (from.isConnected) return from;
    const field = from.getAttribute('data-pkc-field') ?? '';
    if (field === 'append-input')
      return root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]');
    return formatTarget(root);
  };

  /** ⚠ `DataTransfer` から **File だけ**を拾う(`files` が空なら `items` から)。 */
  const filesOf = (dt: DataTransfer | null | undefined): File[] => {
    const out: File[] = [];
    const list = dt?.files;
    if (list && list.length > 0) {
      for (let i = 0; i < list.length; i += 1) {
        const f = list.item(i);
        if (f) out.push(f);
      }
      return out;
    }
    const items = dt?.items;
    if (!items) return out;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]!;
      if (it.kind !== 'file') continue;
      const f = it.getAsFile();
      if (f) out.push(f);
    }
    return out;
  };

  /**
   * 🔴 **待ったあとの差し先**(#250 / #251 で共用)。⚠ 待っている間に
   * ① 編集欄が作り直される(live の面は行を組み直す)② 取り消して別のノートを
   * 開き直す ── のどちらも起きるので、**掴んだままの textarea へ差さない**。
   * ⚠ 別のノートを開いていたら `null`(取り消した貼付が別のノートに現れない)。
   */
  const insertTargetAfterAwait = (
    from: HTMLTextAreaElement,
    openedLid: string | null,
  ): HTMLTextAreaElement | null => {
    const sameEdit = (dispatcher.getState().openBody?.lid ?? null) === openedLid;
    return sameEdit ? reResolveInput(from) : null;
  };

  /**
   * 🔴 **画像を本文へ差し込む**(⚠ 待つので、差す先は**あとで引き直す**)。
   */
  const insertPasted = (files: readonly File[], from: HTMLTextAreaElement): void => {
    // ⚠ **どのノートの編集に貼ったか**を控える(2026-08-18、着地前レビュー)──
    //   待っている間に取り消して別のノートを開き直すと、`formatTarget` は
    //   **新しい編集欄**を返す = 取り消したはずの貼付が別のノートに現れる。
    const openedLid = dispatcher.getState().openBody?.lid ?? null;
    void services.pasteImages!(files).then((refs) => {
      // 🔴 **待っている間に編集欄が作り直されることがある**(live の面は行を組み直す)。
      //   掴んだままの textarea へ差すと、**画面に出ていない所へ字を書く** ──
      //   貼付が黙って消えるので、差す直前に**いま在る編集欄**へ引き直す。
      const into = insertTargetAfterAwait(from, openedLid);
      if (!into) {
        // 🔴 **差し先が消えた。**(1 面の編集は、別の欄を触った瞬間に行を確定して
        //   閉じる ── 実ブラウザで実際にそうなる)
        // 🔑 **編集を抜けているなら捨てない** ── 同じ file を添付へ回す。
        //   content addressing なので bytes は二重にならない(鍵が同じ)。
        // ⚠ **まだ編集中なら添付にはできない**(`CREATE_ENTRY` が黙殺される)──
        //   そのときは「もう一度」と言う。クリップボードは残っているので、
        //   これは実際にやり直せる指示である。
        // ⚠ どちらも黙って終わらない ──「貼ったのに出ない」を作らない。
        const ready = dispatcher.getState().phase === 'ready';
        if (ready && services.attachFiles) {
          services.attachFiles([...files]);
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: '編集欄が閉じたため、貼り付けた画像は添付にしました',
          });
        } else {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: '編集欄が閉じたため貼り付けられませんでした。もう一度貼ってください',
          });
        }
        return;
      }
      // ⚠ `execCommand` は**焦点のある要素**に効く ── 待っている間に焦点が
      //   移ることがあるので、差す前に戻す(戻さないと別の所へ入る)。
      into.focus();
      // ⚠ 差し込みは `execCommand('insertText')` ── **undo に載る**
      for (const ref of refs) insertText(into, `${ref}\n`);
    });
  };

  /**
   * 🔴 **貼付 / 落とした file の行き先を決める**(#250)。
   *
   * 行き先は**そこが編集中の本文か**で決まる:
   * - **編集中の本文(textarea)** … 画像は資産にして**その場に参照を差し込む**
   *   (⚠ ノートは作らない ── 編集中は `CREATE_ENTRY` が黙殺される)
   * - **それ以外** … 添付として取り込む(添付ボタンと同じ道)
   *
   * ⚠ **受け手がいなければ `false` を返す**(呼び側は既定を止めない)──
   * 止めると文字の貼付まで死ぬ。
   */
  const routeFiles = (files: readonly File[], target: EventTarget | null): boolean => {
    if (files.length === 0) return false;
    const inBody = isBodyInput(target);
    const images = inBody ? files.filter(isImageFile) : [];
    const rest = files.filter((f) => !images.includes(f));
    let handled = false;
    if (images.length > 0 && services.pasteImages) {
      insertPasted(images, target as HTMLTextAreaElement);
      handled = true;
    }
    // ⚠ 画像**以外**(と、差し込む口が無い環境)は添付へ倒す ── 無反応にしない
    const leftover = images.length > 0 && services.pasteImages ? rest : files;
    if (leftover.length > 0 && services.attachFiles) {
      services.attachFiles([...leftover]);
      handled = true;
    }
    return handled;
  };

  /**
   * 🔴 **文字の貼付**(#251)。2 つのことをする ──
   * ① `text/html` を PKC-Markdown へ戻す ② `data:` / `blob:` を資産へ逃がす。
   *
   * ⚠ **どちらも要らないなら `false`** ── 既定の貼付(text/plain)に委ねる。
   *   止めてしまうと、変換の要らない普通の貼付まで**こちらの都合で書き換わる**。
   * ⚠ 入る先は**本文の欄だけ**(題名や検索欄に markdown を組み立てない)。
   * ⚠ 資産化は待つので、差し先は `insertTargetAfterAwait` で引き直す(#250 と同じ)。
   *
   * @returns 既定の貼付を止めたら `true`
   */
  const pasteText = (ce: ClipboardEvent): boolean => {
    const target = ce.target;
    if (!isBodyInput(target)) return false;
    const html = ce.clipboardData?.getData('text/html') ?? '';
    const plain = ce.clipboardData?.getData('text/plain') ?? '';
    /**
     * 🔴 **リッチテキスト(RTF)**(user 指示 2026-08-25「HTML貼付のほか、
     * 最近はリッチタイプテキストも増えてる」)。
     *
     * ⚠ **HTML の代わりではない。** Word / Excel / Google ドキュメントは
     *   `text/html` と `text/rtf` の**両方**を載せるので、そこは HTML のほうが
     *   必ず忠実である ── だから RTF は**下の三項でいちばん後ろ**に置く。
     * 🔑 RTF しか載らない出し手(WordPad / TextEdit のリッチテキスト書類 /
     *   一部のネイティブ製アプリ)から貼ったとき、**いままで平文に潰れていた**
     *   のを拾うためのものである。
     */
    const rtf = ce.clipboardData?.getData('text/rtf') ?? '';
    /**
     * 🔴 **素で貼ったパーマリンクを内部リンクにする**(#251)。
     *
     * ⚠ **HTML の変換より先に見る** ── パーマリンクをコピーすると
     *   `text/html` に `<a href="pkc://…">` が入ることがあり、そちらが先に
     *   当たると**外部リンクの形**(`[…](pkc://…)`)で差さってしまう。
     * 🔑 判定そのものは `features/link/permalink.ts` の 1 本(ここは配線だけ)。
     */
    const st = dispatcher.getState();
    const permalink = convertPastedPermalink(plain, {
      containerId: st.cid,
      titleOf: (lid) => st.entryMetas.get(lid)?.title ?? null,
    });
    /**
     * 🔴 **どれを読むかは設定が決める**(user 指示 2026-08-25)。
     * ⚠ **順番をここに書かない** ── 判定は `choosePaste` の 1 か所である
     *   (呼び側で条件を足すと「経路ごとに挙動が違う」形になる。CLAUDE.md §7)。
     * 🔑 変換の口は**遅延**で渡す ── 設定が「変換しない」のとき 1MB の HTML を
     *   解析しない(押した瞬間に止まらないための作法)。
     */
    const chosen = choosePaste({
      source: services.pasteSource?.() ?? DEFAULT_PASTE_SOURCE,
      sizes: { html: html.length, rtf: rtf.length, plain: plain.length },
      convert: {
        permalink: () => permalink,
        html: () => convertPastedHtml({ html, plain }),
        rtf: () => convertPastedRtf({ rtf, plain }),
      },
    });
    /**
     * ⚠ **止めたときも出す** ── 「何も起きなかった」ときこそ理由が要る
     *   (それがこの flag の存在理由である)。
     */
    if (services.pasteInspect?.() === true)
      dispatcher.dispatch({ type: 'OP_NOTICE', message: describePaste(chosen.attempt) });
    const converted = chosen.text;
    const text = converted ?? plain;
    if (text === '') return false;

    const adopt = services.adoptUrls;
    const urls = adopt ? adoptableUrls(text) : [];
    // 変換もせず、逃がすものも無い ── **何も足せない**ので既定に任せる
    if (converted === null && urls.length === 0) return false;
    // ⚠ 逃がすものが無い(= 資産にする口が無い環境も含む)ときは、その場で差す
    if (urls.length === 0) {
      insertText(target, text);
      return true;
    }

    const from = target;
    const openedLid = dispatcher.getState().openBody?.lid ?? null;
    // ⚠ `urls` は `adopt` が在るときしか埋まらない(上の三項)── `pasteImages!` と同じ形
    void adopt!(urls, PASTED_IMAGE_PREFIX).then(({ adopted, failures }) => {
      const r = rewriteAdopted(text, adopted);
      const into = insertTargetAfterAwait(from, openedLid);
      if (!into) {
        // ⚠ 黙って終わらない ──「貼ったのに出ない」を作らない。
        //   クリップボードは残っているので、これは実際にやり直せる指示である
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: '編集欄が閉じたため貼り付けられませんでした。もう一度貼ってください',
        });
        return;
      }
      into.focus();
      insertText(into, r.text);
      /**
       * 🔴 **断りは 1 本にまとめる**(検算で判明)。`state.error` は **1 枠**なので、
       * 理由(空き容量)を先に出しても、件数の総括で**上書きされて消える**。
       *
       * ⚠ **理由は入らなかった側が持っている**(#264 段②)── 直す前はここで
       *   `r.failed` を数えて「**読み込めませんでした**」と綴っていたが、
       *   **読めていたのに画像でなかった**ものまで同じ字になっていた
       *   (user は「読めない」と言われて再読込を試み、永久に直らない)。
       * ⚠ 元の参照は**消していない** ── そこまで言う。
       */
      if (failures.length > 0) {
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: `貼り付けた画像 ${describeAdoptFailures(failures)}(元の参照のまま残しています)`,
        });
      }
    });
    return true;
  };

  /**
   * 🔴 **スクショの貼付**(#250。user 指示 2026-08-18「PKC3 でスクショ貼付の導線が
   * ない。PKC2 と同様以上に実装してください」)。
   *
   * ⚠ **画像が無ければ何もしない**(`preventDefault` しない)── 文字の貼付を殺さない。
   * 🔑 PKC2 は**最初の 1 枚**だけ拾っていたが、ここは**クリップボードの画像を全部**拾う。
   */
  const onPaste = (e: Event): void => {
    const ce = e as ClipboardEvent;
    const files = filesOf(ce.clipboardData).filter(isImageFile);
    if (routeFiles(files, ce.target)) {
      ce.preventDefault();
      return;
    }
    if (pasteText(ce)) ce.preventDefault();
  };

  /**
   * 🔴 **OS から落とした file**(#250)。貼付と**同じ行き先**へ流す。
   *
   * ⚠ `dragover` を止めないと `drop` は**来ない**(既定は「受け取らない」)。
   * ⚠ そして止めないと、ブラウザが**その file へ画面ごと遷移する** ──
   *   編集中の本文が消えるので、受け取れなくても**止めるほうが安全**である。
   */
  /**
   * 🔴 **掴んだまま、別の面へ持っていく**(#402 ③)。
   *
   * > user の物語: フォルダタブで行を掴んだ。予定タブの日付へ落としたい。
   * > いまは**タブを押すのに一度手を離すしかない** ── 離すと掴んだ状態が消える。
   *
   * PKC2 は `handleViewSwitchDragEnter`(`action-binder.ts:7788-7830`)で
   * **600ms 止めたら面を変える**を持っていた。⚠ ただし PKC2 は面ごと差し替える
   * 作りで、PKC3 の左の列は**同じホストの中で `hidden` を入れ替える排他 pane**
   * である ── つまり切り替えた瞬間、**掴んでいた元の要素が `hidden` になる**。
   *
   * 🔑 **だから先に測った**(2026-08-25、実 Chromium):
   * 掴んだ最中に元の面を `hidden` にしても、**行き先の `dragover` も `drop` も
   * 生きていた**(`hidden` が本当に当たっていることも同じ回で確かめた ──
   * 当たっていなければ「面を変えた」を 1 度も試していないことになる)。
   * ⚠ この実測が無ければ「持ち物を state に載せる」別機構が要るところだった。
   */
  let hoverTab: { mode: string; timer: ReturnType<typeof setTimeout> } | null = null;
  const cancelTabHover = (): void => {
    if (hoverTab === null) return;
    clearTimeout(hoverTab.timer);
    hoverTab = null;
  };
  /** ⚠ **止めた時間**で決める(通り過ぎただけで面が変わると、落とす先を見失う)。 */
  const TAB_HOVER_MS = 600;
  const onDragOver = (e: Event): void => {
    const de = e as DragEvent;
    /**
     * 🔴 **タブの上で止まったら面を変える**(#402 ③)。
     * ⚠ **落とし先にはしない**(`preventDefault` を呼ばない)── タブへ落とすと
     *   「タブに入れた」に見えるが、そんな入れ物は無い。ここは**通り道**である。
     * ⚠ PKC の荷物のときだけ ── OS からの file を運んでいるときに面が変わると、
     *   落とすつもりだった所が消える。
     */
    const tab = (de.target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-browse]');
    const carrying =
      de.dataTransfer?.types?.includes(PKC_DRAG) === true ||
      de.dataTransfer?.types?.includes(PKC_TASK_DRAG) === true;
    if (tab !== null && tab !== undefined && root.contains(tab) && carrying) {
      const mode = tab.getAttribute('data-pkc-browse') ?? '';
      if (hoverTab?.mode !== mode) {
        cancelTabHover();
        hoverTab = {
          mode,
          timer: setTimeout(() => {
            hoverTab = null;
            services.setBrowse?.(mode);
          }, TAB_HOVER_MS),
        };
      }
      // ⚠ 光っている落とし先は消す(タブの上に居る間は「そこへ入る」ではない)
      clearDropTarget();
      return;
    }
    cancelTabHover();
    // 🔴 **予定の札**(双方向)── 落とし先は日の升目 / 束の見出し
    if (de.dataTransfer?.types?.includes(PKC_TASK_DRAG) === true) {
      const drop = dateTargetOf(de.target);
      if (drop === null) {
        // ⚠ **光ったままにしない** ── 通ってから別の場所で離すと「そこへ入った」と読む
        clearDropTarget();
        return;
      }
      e.preventDefault();
      de.dataTransfer.dropEffect = 'move';
      markDropTarget(drop.el);
      return;
    }
    // 🔴 **PKC の中の移動**(#240 段④)── OS からの file 受けとは**別の型**で見分ける
    if (de.dataTransfer?.types?.includes(PKC_DRAG) === true) {
      const drop = dropTargetOf(de.target);
      if (drop === undefined) {
        // ⚠ **光ったままにしない**(着地前レビュー 5)── フォルダの上を通ってから
        //    別の行で離すと、user は「そこへ入った」と読む(実際は何も動かない)
        clearDropTarget();
        return; // 落とせない場所 ── 既定(受け取らない)のまま
      }
      e.preventDefault();
      de.dataTransfer.dropEffect = 'move';
      markDropTarget(drop.el);
      return;
    }
    if (de.dataTransfer?.types?.includes('Files') !== true) return;
    e.preventDefault();
    if (de.dataTransfer) de.dataTransfer.dropEffect = 'copy';
  };
  /**
   * 掴んだのがどちらのペインか(2026-08-21)。⚠ **落とした後に印を外す先**であって、
   * 行き先ではない ── 左から右へ落としたら、印を外すのは**左**である。
   * ⚠ `null` = 2 ペイン以外から掴んだ(左の列など)= 何もしない。
   */
  let dragFromSide: DualSide | null = null;
  const onDrop = (e: Event): void => {
    const de = e as DragEvent;
    /**
     * 🔴 **落としたら、その行の日付が変わる**(双方向の出口)。
     * ⚠ 空文字の落とし先は「日付なし」= **外す**(消すのではない)。
     * ⚠ 時刻は**持ち越す** ── 日を動かしただけで 14:00 が消えたら、
     *   user は「勝手に消された」と読む。
     */
    if (de.dataTransfer?.types?.includes(PKC_TASK_DRAG) === true) {
      const drop = dateTargetOf(de.target);
      clearDropTarget();
      if (drop === null) return;
      e.preventDefault();
      const [lid, rawLine, grabbedOn, every] = (
        de.dataTransfer.getData(PKC_TASK_DRAG) || ''
      ).split(' ');
      if (lid === undefined || lid === '') return;
      /**
       * 🔴 **繰り返しの回は日を動かせない ── 黙って何もしないのではなく、断る**
       *   (#344 段②)。
       *
       * ⚠ 動かす意味が **2 通り**ある(「規則ごとずらす」/「この回だけずらす」)ので、
       *   どちらかを勝手に選ぶと**もう片方を頼んだ user のデータが壊れる**。
       * ⚠ 「この回だけ」は**例外日の記法**が要る ── 記法を増やさずに済ませたのが
       *   この設計の要なので(`repeat.ts` の頭)、そこは開けない。
       * 🔑 だから**どこを直せばよいかまで言う**(本文の `@… 毎週` を直す)。
       */
      if (every !== undefined && every !== '') {
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: '繰り返しの予定は掴んで動かせません。本文の「@日付 毎週」を書き直してください',
        });
        return;
      }
      const date = drop.date === '' ? null : drop.date;
      /**
       * 🔴 **単位が 2 つある**(段④)── 行番号が空なら
       *   **ノート 1 件が丸ごと予定**で、書き換えるのは frontmatter の `date:` である。
       * ⚠ 同じ落とし先に、書き換える場所が違う 2 種類が落ちてくる ── だから
       *   ここで分ける(面ごとに 2 つの落とし先を作らない)。
       */
      if (rawLine === undefined || rawLine === '') {
        dispatcher.dispatch({ type: 'SET_ENTRY_DATE', lid, date });
        return;
      }
      const line = Number(rawLine);
      if (!Number.isInteger(line)) return;
      const card = dispatcher
        .getState()
        .taskScan?.cards.find((c) => c.lid === lid && c.line === line);
      /**
       * 🔴 **期間は「長さを保ったまま」ずらす**(#344 段①)。
       *
       * ⚠ 掴んだ日(`grabbedOn`)と落とした日の差だけ、開始と終わりを**両方**動かす。
       *   開始だけ動かすと、user は「1 日ずらした」つもりなのに**期間が伸び縮みする**。
       * ⚠ 日付を**外す**とき(`date === null`)は期間ごと剥がす ── 記法まるごと消えるので
       *   `until` も `null` を渡す(渡さないと「頼んでいない指示」になる、下の reducer)。
       * ⚠ 差が読めなかった回は**ずらさない**(`until` を据え置く)── 当てずっぽうで
       *   user の期間を書き換えない。
       */
      /**
       * ⚠ 掴んだ日が取れなかった回(荷物が古い / 板から掴んだ)は、**開始を基準にする** ──
       *   1 稿目は `null` にして「開始だけ落とした日へ」動かしていたが、それだと
       *   **期間の長さが変わる**(頼んでいないのに出張が伸び縮みする)。
       * ⚠ 差が計算できなければ **0**(= 何も動かさない)── 当てずっぽうで期間を書き換えない。
       *   書き換えが 0 なら `rewriteLineDate` が `null` を返すので、保存も走らない。
       */
      const from = grabbedOn !== undefined && grabbedOn !== '' ? grabbedOn : (card?.date ?? null);
      const shift =
        card?.until != null && date !== null && from !== null
          ? (daysBetween(from, date) ?? 0)
          : null;
      const until =
        date === null
          ? null
          : card?.until == null
            ? null
            : shift === null
              ? card.until
              : (addDays(card.until, shift) ?? card.until);
      /**
       * ⚠ 開始も同じ差で動かす ── 落とした日は「**掴んだ札**が来る日」であって、
       *   期間の開始ではない(掴んだのが 3 日目なら、開始は落とした日の 2 日前になる)。
       */
      const start =
        shift === null || card?.date == null ? date : (addDays(card.date, shift) ?? date);
      dispatcher.dispatch({
        type: 'SET_TASK_DATE',
        lid,
        line,
        date: start,
        // ⚠ 外すときは時刻も一緒に落ちる(記法ごと剥がすため)
        time: card?.time ?? null,
        until,
      });
      return;
    }
    if (de.dataTransfer?.types?.includes(PKC_DRAG) === true) {
      const drop = dropTargetOf(de.target);
      clearDropTarget();
      if (drop === undefined) return;
      e.preventDefault();
      const lids = (de.dataTransfer.getData(PKC_DRAG) || '').split(' ').filter((x) => x !== '');
      /**
       * 🔴 **落とした後を F6 と同じ形に揃える**(2026-08-21、cowork #15)。
       *
       * ⚠ 直す前、drop の経路だけ **2 つとも抜けていた**:
       *   ① `dual-move`(F6)が持つ「**動いた回だけ印を外す**」
       *      ── 外さないと、次にゴミ箱を押したとき
       *      「選んでいた行がいま画面にありません」という**的外れな断り**が出る
       *      (印が消えた行を指したままなので。実測で再現した)
       *   ② `filer-parent` / `filer-open` が持つ **焦点の引き継ぎ**
       *      ── 立て直さないと、落とした直後の `↑` `↓` が**無言で死ぬ**
       * 🔑 どちらも**既に在る関数を呼ぶだけ**。新しい規則を作らない。
       */
      /**
       * 🔴 **スマートフォルダへ落としたら、移すのではなく「条件のタグが付く」**
       *   (#421 段①。user 裁定 2026-08-26「落とすとタグが付く。出すと外れる」)。
       *
       * ⚠ 印を `folder` と分けてあるのは**落ちた結果が違う**からである ──
       *   ここで見分けないと、条件で集まる入れ物へ**構造の親子**を作ってしまう
       *   (中身が 2 種類になり、「消したのに残る」が起きる)。
       * ⚠ 条件は effect が本文から読む ── 憶えている値では書かない。
       */
      if (drop.el.getAttribute('data-pkc-drop') === 'smart' && drop.lid !== null) {
        if (lids.length > 0)
          dispatcher.dispatch({ type: 'SMART_TAGS', smartLid: drop.lid, lids, mode: 'add' });
        return;
      }
      const before = dispatcher.getState().relations;
      const from = dragFromSide;
      moveDropped(lids, drop.lid);
      if (from !== null && dispatcher.getState().relations !== before) {
        dispatcher.dispatch({ type: 'DUAL_CLEAR_SELECTION', side: from });
        carryDualFocus(from);
      }
      return;
    }
    const files = filesOf(de.dataTransfer);
    if (files.length === 0) return;
    // ⚠ 受け手がいなくても止める(上の理由 ── 遷移で編集が飛ぶ)
    e.preventDefault();
    routeFiles(files, de.target);
  };
  /**
   * 🔴 **掴んだものを運ぶ**(#240 段④)。
   * ⚠ 掴んだ行に**印が付いていれば印ごと**運ぶ(付いていなければその 1 件だけ)──
   *   「選んだつもりの物と動く物が違う」を作らない。
   */
  const onDragStart = (e: Event): void => {
    const de = e as DragEvent;
    /**
     * 🔴 **予定の札は別の荷物で運ぶ**(双方向)。
     * ⚠ 行番号は**中の印から引く** ── 札にも同じ属性を置くと、
     *   `[data-pkc-task-line=…]` を押す既存の経路が**札のほうに当たる**
     *   (2026-08-23 に実際に踏んだ)。
     */
    const taskCard = (de.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-pkc-region="schedule-cards"] > [data-pkc-entry], [data-pkc-region="kanban-cards"] > [data-pkc-entry]',
    );
    if (taskCard !== null && taskCard !== undefined && de.dataTransfer) {
      const lid = taskCard.getAttribute('data-pkc-entry');
      /**
       * ⚠ **ノート 1 件が丸ごと予定**のときは行番号が無い(段④)── 荷物の
       *   行番号を**空**にして、落とす側が `SET_ENTRY_DATE`(frontmatter)へ回す。
       * 🔑 印が在るかどうかで見分けない ── **札自身の印**(`data-pkc-whole-note`)
       *   で見る(印の有無は見た目の都合であって、単位の宣言ではない)。
       */
      const whole = taskCard.hasAttribute('data-pkc-whole-note');
      const line = whole
        ? ''
        : taskCard.querySelector('[data-pkc-task-line]')?.getAttribute('data-pkc-task-line');
      /**
       * 🔴 **掴んだのが「どの日の札か」も載せる**(#344 段①)。
       *
       * ⚠ 期間の札は**複数の日に出る**ので、`lid` と行番号だけでは
       *   「どこを掴んだか」が決まらない。🔑 直接操作として素直なのは
       *   **掴んだ日が落とした日に来る**ことなので、その差ぶん期間ごとずらす
       *   ── 期間の**長さが変わらない**(開始だけ動かすと、user が
       *   頼んでいないのに出張が延びたり縮んだりする)。
       * ⚠ 単日の札では使わない(落とした日がそのまま新しい日である)。
       */
      // 🔑 読み口は `dateTargetOf` 1 つ(落とす側と同じ) ── 属性名を 2 か所に書かない
      const from = dateTargetOf(taskCard)?.date ?? '';
      /**
       * 🔴 **繰り返しの回かどうかも載せる**(#344 段②)── 落とす側が**断る**ために要る。
       * ⚠ ここで掴ませない(`return` する)と、下の**ノートを移す**経路へ落ちて
       *   **予定の札を掴んだのにノートが動く**。掴ませたうえで、落としたときに
       *   理由を出すほうが動線として正しい(「押せるのに何も起きない」を作らない)。
       */
      const every = taskCard.getAttribute('data-pkc-task-repeat') ?? '';
      if (lid !== null && line !== null && line !== undefined) {
        dragFromSide = null;
        de.dataTransfer.setData(PKC_TASK_DRAG, `${lid} ${line} ${from} ${every}`);
        de.dataTransfer.effectAllowed = 'move';
        return;
      }
    }
    const row = (de.target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-entry]');
    const lid = row?.getAttribute('data-pkc-entry') ?? null;
    /**
     * ⚠ **掴んだ側は毎回の `dragstart` で決め直す** ── 早期 return する回でも
     *   **古い側を残さない**。残すと、次に別の所から掴んだときに
     *   **前の側の印を外す**(2026-08-21 の変異試験で気づいた)。
     * 🔑 だから `dragend` での後始末は要らない ── 決めるのは 1 か所でよい。
     */
    dragFromSide = row ? dualSide(row) : null;
    if (lid === null || !de.dataTransfer) return;
    const st = dispatcher.getState();
    /**
     * 🔴 **掴んだ面の印を運ぶ**(#273 段⑤)。⚠ 2 ペインから掴んだのに**左の列**の
     * 印を運ぶと、**画面に出ていないものが動く**(移す・写す・消すと同じ罠)。
     */
    const side = dragFromSide;
    const marked =
      side === null
        ? visibleSelection(visibleFilerRows(st), st.selection)
        : visibleSelection(
            dualPaneRows(st, side),
            paneOf(st.dual, side).selection,
          );
    const lids = marked.includes(lid) ? marked : [lid];
    de.dataTransfer.setData(PKC_DRAG, lids.join(' '));
    de.dataTransfer.effectAllowed = 'move';
  };
  const onDragEnd = (): void => {
    // ⚠ **待っている面の切替も畳む**(#402 ③)── 離した後に面が変わると、
    //    user から見て「勝手に画面が動いた」になる
    cancelTabHover();
    clearDropTarget();
  };
  /**
   * 予定の落とし先(日の升目 / 束の見出し)。`null` = 落とせない場所。
   * ⚠ **空文字は「日付なし」**(属性が無いのとは別物)── だから `null` で表す。
   */
  const dateTargetOf = (target: EventTarget | null): { el: HTMLElement; date: string } | null => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-drop-date]');
    if (!el || !root.contains(el)) return null;
    return { el, date: el.getAttribute('data-pkc-drop-date') ?? '' };
  };
  /** 落とし先(フォルダの行 / パンくずの段)。`undefined` = 落とせない場所。 */
  const dropTargetOf = (target: EventTarget | null): { el: HTMLElement; lid: string | null } | undefined => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-drop]');
    if (!el || !root.contains(el)) return undefined;
    /**
     * ⚠ **ペインの地は「そのペインが開いている場所」へ落ちる**(#273 段⑤)。
     * `data-pkc-entry` を持たせると**ペイン自身が entry** に見えるので、
     * 行き先は別の属性で渡す。⚠ 空文字はルート(属性が**無い**のとは別物)。
     */
    const scope = el.getAttribute('data-pkc-drop-scope');
    if (scope !== null) return { el, lid: scope === '' ? null : scope };
    // ⚠ パンくずのルートは `data-pkc-entry` を持たない = 出す先(ルート)
    return { el, lid: el.getAttribute('data-pkc-entry') };
  };
  let dropMark: HTMLElement | null = null;
  const markDropTarget = (el: HTMLElement): void => {
    if (dropMark === el) return;
    clearDropTarget();
    dropMark = el;
    el.setAttribute('data-pkc-dropping', '');
  };
  const clearDropTarget = (): void => {
    dropMark?.removeAttribute('data-pkc-dropping');
    dropMark = null;
  };
  /**
   * 落としたものを動かす。⚠ **断る理由を出す**(無言の操作拒否を作らない)──
   * フォルダを自分の子孫へ落とす等、reducer が黙って捨てる形が在る。
   */
  const moveDropped = (lids: readonly string[], parentLid: string | null): void =>
    moveEntries(dispatcher, lids, parentLid, services.showStatus);
  /**
   * 🔴 **フォルダは 2 クリックで開く**(#240 段①。user 指示 2026-08-17
   * 「フォルダをダブルクリックで開くように変更」)。
   *
   * ⚠ **ネイティブの `dblclick` に頼らない。** ブラウザは「同じ node を 2 回」
   * 押したときにしか `dblclick` を出さないので、**2 回のクリックの間に行が
   * 作り直されると出ない** ── この面は保存の ack や別タブの更新で表を組み直すので、
   * 実 user も「開かない」を踏む(実ブラウザ smoke で実際に落ちた)。
   * 🔑 だから**同じ lid への連続押し**で見る ── node が入れ替わっても lid は同じ。
   * ⚠ 1 クリック目(= 選ぶ)は `onClick` が撃っている。ここは**現在地だけ**動かす。
   * ⚠ フォルダ以外では何もしない(ノートを 2 回押しても入る先が無い)。
   */
  const DOUBLE_MS = 500;
  /**
   * 🔴 **鍵に「どの面で押したか」を入れる**(着地前レビュー R3)。
   * ⚠ 呼び手は 1 つ(左の列)から **3 つ**(左の列 / 2 ペインの左 / 右)に増えた。
   *   `lid` だけを鍵にすると、**別々の面での 1 回ずつ**が「もう一度押した」に化ける
   *   ── 起動時は左右ともルートなので**同じフォルダが両方の表に出ており**、
   *   左で選んで右で選ぶと、印を付けたかっただけの右が中へ入る。
   */
  let lastRowClick: { key: string; at: number } = { key: '', at: 0 };
  const maybeEnterFolder = (lid: string, dual: DualSide | null = null): void => {
    const key = `${dual ?? 'filer'}:${lid}`;
    const now = Date.now();
    const again = lastRowClick.key === key && now - lastRowClick.at <= DOUBLE_MS;
    lastRowClick = { key, at: now };
    if (!again) return;
    // 🔑 「中へ入れるか」の判定は `canEnterScope` 1 か所(スマートフォルダも入れる)
    if (!canEnterScope(dispatcher.getState().entryMetas.get(lid)?.archetype)) return;
    lastRowClick = { key: '', at: 0 }; // 3 回目を「もう一度」と数えない
    // ⚠ **入る先はその面の現在地** ── 2 ペインで `SET_SCOPE` を撃つと、
    //    押していない左の列が動いて、押した側は 1 ミリも動かない
    dispatcher.dispatch(
      dual === null
        ? { type: 'SET_SCOPE', lid }
        : { type: 'DUAL_SET_SCOPE', side: dual, lid },
    );
    /**
     * 🔴 **入った先で焦点を立て直す**(#273、2026-08-24 に実ブラウザで実測)。
     *
     * ⚠ 直す前は**マウスで入った瞬間に鍵が 1 つも効かなくなった** ── 入ると
     *   表の行が丸ごと作り直されるので、押していた行が消えて
     *   `document.activeElement` が **`body`** に落ちる。すると keydown の的が
     *   ペインの外になり、`dual` 文脈の一致そのものが起きない
     *   (`Backspace` で戻ることすらできず、もう一度マウスで押すしかない)。
     * ⚠ **キーボードで入った回は効いていた** ── `filer-open` が既に
     *   `carryDualFocus` を呼んでいるからで、**マウスの経路にだけ穴が空いていた**
     *   (CLAUDE.md「片側を直したら、対称の反対側を必ず疑う」)。
     * 🔑 立て直しは `carryDualFocus` 1 本 ── 「どの行へ当てるか」の規則を
     *   2 か所に持たない(見えている行だけを相手にする不変条件つき)。
     * ⚠ 左の列(`dual === null`)はここでは触らない ── **測っていないから**である
     *   (同じ穴が在るかは別に確かめる)。
     */
    if (dual !== null) carryDualFocus(dual);
  };
  root.addEventListener('click', onClick);
  root.addEventListener('paste', onPaste);
  /**
   * 🔴 **`dragenter` でも受理を宣言する**(2026-08-21、cowork #15)。
   *
   * ⚠ 直す前は `dragover` / `drop` / `dragstart` / `dragend` の **4 本だけ**で、
   *   `dragenter` を 1 度も受けていなかった。HTML 仕様では「**新しい要素へ入った
   *   瞬間の受理**」は `dragenter` の cancel で決まる ── Chromium は entering 時に
   *   必ず `dragover` を続けて撃つので**現状は通る**(手元の実ブラウザ 16 試行は
   *   16 回とも成功した)が、⚠ **ペインの地は移動の途中から `dragover` を浴びる
   *   のに対し、行は最後の一瞬にしか入らない** ── cowork が報告した
   *   「地は 5/5・行は 0/5」という**落とし先で割れる**非対称を説明できる、
   *   コード上で名指しできる唯一の穴がここだった。
   * 🔑 同じ handler を足すだけ(副作用ゼロの保険)。
   */
  root.addEventListener('dragenter', onDragOver);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('drop', onDrop);
  root.addEventListener('dragstart', onDragStart);
  root.addEventListener('dragend', onDragEnd);
  root.addEventListener('mousedown', onMousedown);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  /**
   * 🔴 **全域のコマンドを実行する ── または「いま実行できるか」だけ答える**(#425 段①)。
   *
   * ## 🔑 なぜ 1 つの関数なのか(CLAUDE.md §7)
   *
   * 鍵の側(`onShortcut`)と、操作を名前で探す面(パレット)は
   * **同じことを聞いている** ── 「この命令は、いま、何かするのか」。
   * ⚠ 判定を 2 か所に書くと「**押せると出ているのに押しても何も起きない**」が
   *   静かに生まれる(パレットの一覧は正しく、実行だけが落ちる形)。
   * 🔑 だから**門は 1 組**にして、`dry` で「撃つか / 答えるだけか」を切り替える。
   *   ⚠ 変異でどれか 1 つの門を壊すと、**鍵と一覧の両方**が同時に狂う = 気づける。
   *
   * @param prevent ブラウザの既定を止める口。⚠ **撃つ直前に呼ぶ**(順番を保つ ──
   *   後にすると、続きが例外を投げたときだけ既定が止まらない形になる)
   * @param dry `true` なら**何もせず**「できるか」だけ返す
   * @returns 何かした(または `dry` で「できる」)なら `true`
   */
  /**
   * 🔑 **画面全体の近道**(P10)。いまは `Ctrl/Cmd+N` = いま選んでいる種類で作る
   * (user 指示「追加ボタンと ctrl+n の対象を更新」)。
   *
   * 🔴 **document で受ける** ── `root` に付けると、focus が root の外(`body` 等)に
   * あるときに届かない。編集をやめた直後は focus が消えた要素から body へ落ちるので、
   * **そこで効かない近道**になっていた(実測で落ちた)。
   * ⚠ `root` が外れていたら何もしない ── test が root を作り直しても、
   * 古い binder の handler が生き残って二重に作らないため。
   * ⚠ 編集中の欄では受けない(打っている途中に別のノートへ飛ぶのは事故)。
   * ⚠ `altKey` を除く(AltGr = Ctrl+Alt の誤発火)。
   * ⚠ ブラウザの「新しいウィンドウ」を止める(`preventDefault`)。
   */
  const onShortcut = (ev: Event) => {
    const ke = ev as KeyboardEvent;
    if (ke.isComposing || !root.isConnected) return;
    /**
     * 🔴 **確認が開いている間は近道を通さない**(#299 段⑤。着地前レビュー R6)。
     *
     * ⚠ native の `confirm` は**レンダラごと止めていた**ので、そもそも鍵が動かなかった。
     *   `<dialog>` は背景を不活性にするだけなので、**document の keydown は生き続ける**。
     * ⚠ 実害があるのは、押しボタンを経由せず**直接 dispatch する**近道である ──
     *   `Alt+1`(本文へ)/ `Alt+6`(2 ペイン)/ `Alt+←→`(選択を戻る・進む)は
     *   不活性に関係なく必ず走る。削除の確認を読んでいる最中に**背後で面が変わり**、
     *   「はい」と答えた先が別の文脈になる。
     * 🔑 判定は器の側の 1 つ(`isAppDialogOpen`)を読む ── 門をここに書き写すと、
     *   器の作りを変えた日にここだけ古くなる(CLAUDE.md §7)。
     */
    if (isAppDialogOpen()) return;
    const el = ke.target instanceof HTMLElement ? ke.target : null;
    /**
     * 🔴 **打っている欄は「名前」ではなく「構造」で見る**(着地前レビュー 4)。
     *
     * ⚠ 直す前は `data-pkc-field` の名指し 4 つ + `contenteditable` だった ──
     * **実在する入力欄を 6 つ数え落として**いた(絞り込み `entry-filter` /
     * 置換の 2 欄 / 関係の相手 / アプリの分類・図案)。絞り込みに語を打っている
     * 最中の `Ctrl+E` で**編集に入って面が変わる**、`Alt+2` で集計へ飛ぶ、が起きる。
     * ⚠ 名指しの表は「欄が増えるたびに直す」形で、**増やした人は気づけない**。
     * 🔑 `<textarea>` / 文字を打つ `<input>` / `contenteditable` を構造で拾う。
     * ⚠ `button` / `checkbox` / `radio` / `file` / `submit` は**打つ欄ではない**
     *   (押しボタンに焦点があるときまで近道を止めると、キーボードだけの動線が死ぬ)。
     */
    const typing =
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement &&
        !/^(button|checkbox|radio|file|submit|reset|image)$/.test(el.type)) ||
      el?.isContentEditable === true;
    /**
     * 🔴 **フォルダの表の中は、別の文脈**(user 裁定 2026-08-18「OS のファイラ動作に
     * 似せる方向で平仄も合わせて」)。⚠ **行に焦点があるときだけ**効かせる ──
     * 面をまたいで効かせると、#240 の着地前レビューで踏んだ
     * 「見えない所で印が増える / 現在地が動く」を繰り返す。
     */
    /**
     * ⚠ **打っている最中は、面の文脈キーを走らせない**。
     * ⚠ いまの面には入力欄が 1 つ(名前の打ち替え)しか無く、**それは下の枝が先に
     *   受ける**ので、この門は**変異試験で観測できない**(外しても test は全部通る)。
     *   将来この面に入力欄が増えたときのための備えとして置いている ── 「これが
     *   無いと壊れる」とは書かない(CLAUDE.md「外して壊れることを 1 度は見る」)。
     */
    if (!typing && el?.closest('[data-pkc-region="filer-table"]')) {
      const fcmd = keymap.match(ke, 'filer');
      if (fcmd !== null && runFilerKey(fcmd)) {
        ke.preventDefault();
        return;
      }
    }
    /**
     * 🔴 **2 ペインの中も、同じ鍵が効く**(#273)。⚠ 行き先だけが違う ──
     * `state.scopeLid` ではなく `state.dual` の、**焦点のあるペイン**に効く。
     */
    const dualHost = el?.closest<HTMLElement>('[data-pkc-region="dual-pane"]');
    /**
     * 🔴 **名前を打ち替えている欄の鍵は、ここで完結させる**(#273 段④)。
     * `Enter` で確定、`Esc` でやめる。⚠ それ以外の鍵は**入力へ通す**(打てなくなる)。
     */
    if (dualHost && el instanceof HTMLInputElement && el.matches('[data-pkc-field="dual-rename"]')) {
      const lid = el.getAttribute('data-pkc-entry');
      if (ke.key === 'Enter' && lid !== null) {
        ke.preventDefault();
        commitDualRename(lid, el.value);
        return;
      }
      if (ke.key === 'Escape') {
        ke.preventDefault();
        dispatcher.dispatch({ type: 'DUAL_RENAME_END' });
        return;
      }
      return;
    }
    /**
     * 🔴 **絞り込みの欄から、そのまま行へ降りられる**(#273 残件)。
     *
     * ⚠ これが無いと「打って絞る → マウスで行を押す」になり、**キーボードだけで
     *   完結しない**(不可侵指示「マウスだけで完結し、キーボードは近道」の裏側 ──
     *   近道が途中で切れている)。
     * ⚠ それ以外の鍵は**入力へ通す**(打てなくなる)。
     */
    if (dualHost && el instanceof HTMLInputElement && el.matches('[data-pkc-field="dual-filter"]')) {
      const fside = dualHost.getAttribute('data-pkc-side');
      if (fside !== 'left' && fside !== 'right') return;
      if (ke.key === 'Escape') {
        ke.preventDefault();
        // 🔑 **欄も空にする**(state だけ空にすると、打った字が残って見える)
        el.value = '';
        dispatcher.dispatch({ type: 'DUAL_SET_FILTER', side: fside, filter: '' });
        return;
      }
      if (ke.key === 'ArrowDown' || ke.key === 'Enter') {
        const first = dualRows(dispatcher.getState(), fside)[0]?.lid ?? null;
        if (first === null) return;
        ke.preventDefault();
        moveDualCursor(fside, first);
        return;
      }
      return;
    }
    if (!typing && dualHost) {
      const dside = dualHost.getAttribute('data-pkc-side');
      /**
       * 🔴 **鍵はぜんぶコマンド表から引く**(2026-08-19 の作り直し)。
       *
       * ⚠ 直す前は `F2` と `Tab` が**この場に直書き**されていた ── 操作行は
       *   「F2 名前」と書いてあるのに、user が設定画面で割当を変えても
       *   **F2 のまま効き、画面の字だけが変わる**(表示と実装が割れる)。
       * 🔑 いまは `dual` 文脈のコマンド(`dual-rename` / `dual-other-pane` /
       *   `dual-mark` / `F5` / `F6` / `F7`)として表に在り、
       *   操作行のラベルも**同じ表**から作られる(Krusader 方式)。
       * ⚠ **`dual` を先に見て、次に `filer`** ── 順を逆にすると `dual` 専用の鍵が
       *   `filer` の一致に食われうる。
       *
       * 🔴 **`?? keymap.match(ke, 'filer')` は、いまは 1 度も使われない**
       *   (2026-08-21 に実測して判明 ── それまでここには「両方に在る鍵は
       *   `filer` 側の 1 つだけなので取り合いにならない」と**事実と逆のこと**が
       *   書いてあった)。`filer` を名乗るコマンド **8 個は全部 `dual` も名乗って
       *   いる**(`filer-open` / `filer-parent` / `filer-trash` / `filer-select-all` /
       *   `filer-row-down` / `filer-row-up` / `filer-extend-down` / `filer-extend-up`)
       *   ので、`Delete` も `Enter` も**左辺で当たる**。
       *   ⚠ 実測の取り方:この行を `keymap.match(ke, 'dual')` だけに変えて build し、
       *   経路に印を撃つと `dual-branch → runDualKey:filer-trash → deleteFrom` と
       *   出た(= 右辺を通っていない)。
       * 🔑 **残してあるのは、`filer` だけを名乗るコマンドが将来増えたときのため**。
       *   ⚠ だからここを壊す変異は**等価変異**であり、生き延びても test の穴ではない
       *   (CLAUDE.md §3「差が user に見えないなら冗長なコード」の、残すと決めた側)。
       */
      if (dside === 'left' || dside === 'right') {
        const dcmd = keymap.match(ke, 'dual') ?? keymap.match(ke, 'filer');
        if (dcmd !== null && runDualKey(dcmd, dside)) {
          ke.preventDefault();
          return;
        }
      }
    }
    const cmd = keymap.match(ke, 'global');
    if (cmd === null) return;
    /**
     * 打鍵中に効かせてよいか。**コマンドが名乗る** + **その和音が文字を打たない**の
     * 両方が要る(着地前レビュー 2)── `open-help` は `F1` のために名乗っているが、
     * 別名の `Alt+5` は mac で `∞` を打つ鍵である。名乗りだけを見ると、
     * **本文に記号が入らずヘルプが開く**。
     */
    const chord = chordOf(ke);
    if (typing && !(findCommand(cmd)?.whileTyping === true && chord !== null && !typesCharacter(chord)))
      return;
    if (runGlobalCommand(cmd, root, dispatcher, keymap, () => ke.preventDefault())) return;
  };
  /**
   * 🔴 **整理の面の鍵**(user 裁定 2026-08-18)。⚠ **既にある動線を呼ぶだけ**にする ──
   * ここで別の実装を書くと、押しボタンと鍵で結果が違う形になる(CLAUDE.md §7)。
   * @returns 効いたら true(呼び側が既定を止める)
   */
  /**
   * 🔴 **焦点の面倒は「描く側」が 1 か所で見る**(2026-08-18。実ブラウザで実測)。
   *
   * ⚠ ここに「dispatch のあとに 1 行目へ置き直す」を書いていたが**足りなかった**
   * ── 表を丸ごと組み直すのは renderer なので、**そのあとに来る別の再描画**
   * (本文の読み込み完了など)で焦点がまた `body` へ落ちる。中身のあるフォルダへ
   * 入る smoke が、まさにそれで落ちた(焦点は `body` に在った)。
   * 🔑 **壊す側が直す** ── `filer.ts` が組み直しの前後で焦点を持ち越す。
   *   binder は「どこへ移るか」だけを決め、焦点には触らない
   *   (CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」)。
   */

  /**
   * 🔴 **いま焦点の枠が乗っている行**(2026-08-18 の着地前レビュー 2)。
   *
   * ⚠ `selectedLid`(= 中央に開いているノート)と**別物**である。フォルダへ
   * 入ると `SET_SCOPE` が印を外し、`filer.ts` が 1 行目へ**焦点だけ**
   * 持ち越す ── このとき `selectedLid` は**入る前に押した行のまま**なので、
   * 直す前は「もう一度 Enter」が**同じフォルダを開き直そうとして無言で終わって**
   * いた(reducer が `scopeLid === action.lid` を弾く)。⚠ user から見ると
   * 「枠は次の行に見えているのに Enter が効かない」。
   * 🔑 **進む操作は焦点に従い、壊す操作は印を要る**(誤差の向きを決める)──
   *   `filer-trash` はここを使わない(焦点は自動で乗るので、押していない行が
   *   ゴミ箱へ入る道を作らない)。
   */
  const focusedRowLid = (): string | null => {
    const el = root.ownerDocument.activeElement;
    if (!(el instanceof HTMLElement)) return null;
    const tr = el.closest('[data-pkc-region="filer-table"] [data-pkc-entry]');
    return tr?.getAttribute('data-pkc-entry') ?? null;
  };

  /** 表の中のその行(`data-pkc-entry` は user 由来ではないが、選択子に埋めない)。 */
  const rowEl = (lid: string): HTMLElement | null =>
    Array.from(
      root.querySelectorAll<HTMLElement>('[data-pkc-region="filer-table"] [data-pkc-entry]'),
    ).find((el) => el.getAttribute('data-pkc-entry') === lid) ?? null;

  const focusRow = (lid: string): void => rowEl(lid)?.focus();

  /**
   * 🔴 **行送りの行き先**(user 裁定 2026-08-18「行送りに上下キーを使う」)。
   *
   * ⚠ 並びは **`filerRows` 1 か所**から採る(描く側・範囲選択と同じ答え)──
   * DOM の並びを読むと、絞り込みや並べ替えのときに**目で見た順と食い違う**。
   * ⚠ 焦点がまだ無いときは、下向きなら先頭・上向きなら末尾から入る(OS と同じ)。
   * ⚠ 端では**止まる**(巻き戻さない)── 一覧の端で押し続けると反対側へ飛ぶのは
   *   OS のファイラの挙動ではない。
   */
  const rowAt = (st: AppState, delta: number): string | null => {
    const rows = visibleFilerRows(st);
    if (rows.length === 0) return null;
    const cur = focusedRowLid();
    const i = cur === null ? -1 : rows.findIndex((m) => m.lid === cur);
    if (i === -1) return (delta > 0 ? rows[0] : rows[rows.length - 1])?.lid ?? null;
    return rows[Math.min(rows.length - 1, Math.max(0, i + delta))]?.lid ?? null;
  };

  /**
   * 🔴 **ノートを「開く」**(user 裁定 2026-08-18)。
   *
   * > 「**Enter は閲覧を開始、インライン編集で常に開くは設定でトグル可能にすること**」
   *
   * 既定は**閲覧**: 中央にそのノートを開き、本文の面へ焦点を移す(読み進めと
   * スクロールがそのままキーボードで続く)。設定が ON のときだけ、**本文が届いてから**
   * 編集に入る。⚠ `START_EDIT` は `openBody` が揃っていないと**黙って何もしない**
   * ので、その場で撃つと「設定を入れたのに編集にならない」になる。
   */
  const openNote = (lid: string): boolean => {
    if (!selectEntryOrExplain(dispatcher, lid, 'ノート')) return false;
    root.querySelector<HTMLElement>('[data-pkc-region="detail"]')?.focus();
    if (openInEdit.enabled()) startEditWhenReady(lid);
    return true;
  };

  /**
   * 本文が届いたら 1 回だけ編集に入る。
   * ⚠ **あきらめる条件を必ず持つ**(CLAUDE.md「短命購読は teardown で必ず外す」)──
   * 別のノートへ移ったとき / `ready` を離れたときは購読を外す。持たないと、
   * user が自分で編集して確定した瞬間に**もう一度勝手に編集へ入る**。
   */
  const startEditWhenReady = (lid: string): void => {
    const arrived = (s: AppState): boolean => s.openBody?.lid === lid;
    if (arrived(dispatcher.getState())) {
      dispatcher.dispatch({ type: 'START_EDIT' });
      return;
    }
    const off = dispatcher.onState((s) => {
      if (s.selectedLid !== lid || s.phase !== 'ready') {
        off();
        return;
      }
      if (!arrived(s)) return;
      off();
      dispatcher.dispatch({ type: 'START_EDIT' });
    });
  };

  /**
   * 🔴 **2 ペインをキーボードで動かす**(#273。user 指摘 2026-08-19
   * 「OS のファイラと同じことができないといけません / 往年の FD などを見習って」)。
   *
   * ⚠ 直す前、2 ペインは**キーボードで 1 ミリも動かなかった** ── `filer-*` の 8 命令は
   *   `runFilerKey` が `state.scopeLid` / `state.selection` を見るので**左の列にだけ**
   *   効き、`state.dual` には 1 つも届いていなかった(開く `view-dual` だけが割当)。
   * 🔑 **命令を増やさない**(`dual-*` を別に作らない)── 増やすと user は同じ操作を
   *   2 回割り当て直すことになる。**同じ鍵が、焦点のある面に効く**形にする。
   * 🔑 並びは `filerRows` **1 か所**から採る ── 描く側(`dual-filer.ts`)・
   *   範囲選択(reducer)と同じ答えでないと、目で見た順と食い違う。
   */
  const dualRows = (st: AppState, side: DualSide): EntryMeta[] => dualPaneRows(st, side);

  const dualRowEl = (side: DualSide, lid: string): HTMLElement | null =>
    Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-pkc-region="dual-pane"] [data-pkc-action="dual-row"]',
      ),
    ).find(
      (el) => el.getAttribute('data-pkc-side') === side && el.getAttribute('data-pkc-entry') === lid,
    ) ?? null;

  /**
   * 🔴 **カーソルの正本は state**(2026-08-19 の作り直し)。
   *
   * ⚠ 直す前は `document.activeElement` を読んでいた ── つまり**カーソルが
   *   DOM の焦点そのもの**で、印と切り離せなかった(`↑↓` は印ごと動かすしかない)。
   * ⚠ しかも焦点は**表を組み直すたびに消える**ので、別タブの保存が届いただけで
   *   「いまどの行に居るか」が失われていた。
   * 🔑 いまは state が持ち、**DOM の焦点はそれに追従するだけ**にする。
   */
  const dualCursor = (st: AppState, side: DualSide): string | null =>
    paneOf(st.dual, side).cursor;

  /** ⚠ 端では**止まる**(巻き戻さない ── 左の列と同じ規則)。 */
  const dualRowAt = (st: AppState, side: DualSide, delta: number): string | null => {
    const rows = dualRows(st, side);
    if (rows.length === 0) return null;
    const cur = dualCursor(st, side);
    const i = cur === null ? -1 : rows.findIndex((m) => m.lid === cur);
    if (i === -1) return (delta > 0 ? rows[0] : rows[rows.length - 1])?.lid ?? null;
    return rows[Math.min(rows.length - 1, Math.max(0, i + delta))]?.lid ?? null;
  };

  /**
   * 🔴 **カーソルを送る**(印には触らない)。DOM の焦点は**後から追従**させる。
   * ⚠ `dispatch` は同期に描画まで走るので、この順でないと**古い行に focus** する。
   */
  const moveDualCursor = (side: DualSide, lid: string): void => {
    dispatcher.dispatch({ type: 'DUAL_SET_CURSOR', side, lid });
    dualRowEl(side, lid)?.focus();
  };

  /**
   * 🔴 **場所を移ったら、焦点を連れて行く**(#273。実ブラウザ smoke で判明)。
   *
   * ⚠ これが無いと **Enter で中へ入った次の 1 打鍵が死ぬ** ── 表は組み直され、
   *   焦点が乗っていた行は**その場で消える**ので、次の keydown の的は `body` になる。
   *   そこには `data-pkc-region="dual-pane"` の親が無いので、**この面の鍵は
   *   1 つも当たらなくなる**(user から見ると「入ったら急にキーが効かない」)。
   * ⚠ 左の列は同じ問題を `filer.ts` の側で解いている ── あちらは面が 1 つなので
   *   描画側で持てるが、こちらは**どちらのペインへ戻すか**が要るのでここで持つ。
   * 🔑 dispatch は同期に描画まで走るので、**この時点で新しい行が居る**。
   */
  const carryDualFocus = (side: DualSide): void => {
    const st = dispatcher.getState();
    /**
     * 🔴 **カーソルは「画面に出ている行」でなければ使わない**(2026-08-21、cowork #15)。
     *
     * ⚠ 直す前は `dualCursor(st, side)` を無条件に第 1 候補にしていた。場所を移る
     *   経路(`filer-parent` / `filer-open`)では `withScope` がカーソルを外すので
     *   問題にならなかったが、**D&D で行が別のフォルダへ出て行った**ときは
     *   カーソルが**生きている lid のまま画面から消える** ── そのまま焦点を
     *   当てようとして**どこにも当たらず**、次の `↑` `↓` が死ぬ。
     * 🔑 「見えている行だけを相手にする」は `operationTargets` が既に持っている
     *   不変条件である ── **同じ問いに 2 つの答えを作らない**(CLAUDE.md §7)。
     */
    const rows = dualRows(st, side);
    const cur = dualCursor(st, side);
    const visibleCur = cur !== null && rows.some((m) => m.lid === cur) ? cur : null;
    const lid = visibleCur ?? paneOf(st.dual, side).selection[0] ?? rows[0]?.lid ?? null;
    const row = lid === null ? null : dualRowEl(side, lid);
    // ⚠ **カーソルを立て直す**(場所を移ると `withScope` が外すので、
    //   立てないと次の `↑` が末尾へ飛ぶ)
    if (lid !== null && dualCursor(dispatcher.getState(), side) !== lid)
      dispatcher.dispatch({ type: 'DUAL_SET_CURSOR', side, lid });
    if (row !== null) {
      row.focus();
      return;
    }
    /**
     * ⚠ **行が 1 つも無いときは器へ逃がす**(空のフォルダ)── ここを落とすと
     * 「入ったら鍵が全部死ぬ」に戻る。器は `tabIndex = -1` を持っている。
     */
    root
      .querySelector<HTMLElement>(`[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`)
      ?.focus();
  };

  /**
   * 🔴 **名前の打ち替えを確定する**(#273 段④)。
   *
   * ⚠ 改名の規則は既存の `RENAME_ENTRY_TITLE` **1 つ**(左の列・編集画面と同じ)。
   * 🔑 **空白だけ / 変わっていない、の判定はここに書かない** ── reducer が既に
   *   持っている(`title === '' || title === meta.title` で捨てる)。ここにも書くと
   *   **同じ問いに答える口が 2 つ**になり、片方だけ直したときに食い違う(CLAUDE.md §7)。
   */
  const commitDualRename = (lid: string, value: string): void => {
    dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title: value });
    dispatcher.dispatch({ type: 'DUAL_RENAME_END' });
  };

  const runDualKey = (cmd: string, side: DualSide): boolean => {
    const st = dispatcher.getState();
    /**
     * ⚠ **無言で断らない**(左の列と同じ作法)── `preventDefault` は走るので、
     * 黙ると「押したのに何も起きず、ブラウザの既定まで消えた」になる。
     */
    if (st.phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してからフォルダの操作をしてください',
      });
      return true;
    }
    /**
     * 🔴 **行送りは「カーソルだけ」**(2026-08-19 の作り直し。設計 doc §3 行 H)。
     *
     * ⚠ 直す前は印ごと動かしていたので、**見て回ることが選ぶことだった** ──
     *   3 件目まで下りると 1・2 件目の印が消えるので、飛び飛びに選べない。
     * 🔑 印が 1 つも無ければ `F5/F6/F8` は**カーソルの行**を相手にする
     *   (`operationTargets`)ので、「下りて F6」の動線は今までどおり通る。
     */
    if (cmd === 'filer-row-down' || cmd === 'filer-row-up') {
      const lid = dualRowAt(st, side, cmd === 'filer-row-down' ? 1 : -1);
      if (lid === null) return false;
      moveDualCursor(side, lid);
      return true;
    }
    if (cmd === 'filer-extend-down' || cmd === 'filer-extend-up') {
      const from = dualCursor(st, side);
      const lid = dualRowAt(st, side, cmd === 'filer-extend-down' ? 1 : -1);
      if (lid === null) return false;
      // ⚠ 起点が無いときは、いまの行を起点に立ててから伸ばす
      //    (`rangeInRows` は起点 null を「行き先 1 件」と解くので、積み上がらない)
      if (paneOf(st.dual, side).anchor === null && from !== null)
        dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid: from, mode: 'set' });
      dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid, mode: 'range' });
      dualRowEl(side, lid)?.focus();
      return true;
    }
    /**
     * 🔴 **印を付ける / 外して 1 行下へ**(FAR / Directory Opus と同型)。
     * ⚠ **下りるところまでが 1 つの操作** ── 下りないと、同じ行に印を
     *   付けたり外したりし続けることになる(連続して選べない)。
     */
    if (cmd === 'dual-mark') {
      const lid = dualCursor(st, side);
      if (lid === null) return false;
      dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid, mode: 'toggle' });
      const next = dualRowAt(dispatcher.getState(), side, 1);
      if (next !== null) moveDualCursor(side, next);
      return true;
    }
    /**
     * 🔴 **F キーは押しボタンと同じ実体を呼ぶ**(規則を 2 つ作らない)。
     * ⚠ `ACTIONS` を通すことで、断り方・確認・「戻せます」の言い方が
     *   鍵とボタンで**必ず一致**する(CLAUDE.md §7)。
     */
    const viaButton = DUAL_KEY_ACTION[cmd];
    if (viaButton !== undefined) {
      const host = root.querySelector<HTMLElement>(
        `[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`,
      );
      if (host === null) return false;
      run(viaButton, host);
      return true;
    }
    if (cmd === 'dual-rename') {
      const lid = dualCursor(st, side) ?? paneOf(st.dual, side).selection[0] ?? null;
      if (lid === null) return false;
      dispatcher.dispatch({ type: 'DUAL_RENAME_BEGIN', side, lid });
      return true;
    }
    if (cmd === 'dual-other-pane') {
      const to = otherSide(side);
      dispatcher.dispatch({ type: 'DUAL_FOCUS', side: to });
      carryDualFocus(to);
      return true;
    }
    if (cmd === 'filer-select-all') {
      const rows = dualRows(st, side);
      const first = rows[0]?.lid;
      const last = rows[rows.length - 1]?.lid;
      if (first === undefined || last === undefined) return false;
      dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid: first, mode: 'set' });
      if (last !== first)
        dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid: last, mode: 'range' });
      return true;
    }
    if (cmd === 'filer-parent') {
      const scope = paneScope(paneOf(st.dual, side));
      if (scope === null) return false; // ルートで押しても何も起きない
      const up = getAncestorFolders(scope, st.entryMetas, st.relations)[0] ?? null;
      dispatcher.dispatch({ type: 'DUAL_SET_SCOPE', side, lid: up?.lid ?? null });
      carryDualFocus(side);
      return true;
    }
    if (cmd === 'filer-open') {
      const lid = dualCursor(st, side) ?? paneOf(st.dual, side).selection[0] ?? null;
      if (lid === null) return false;
      // 入れ物なら中へ(2 クリックと同じ ── 規則は `DUAL_SET_SCOPE` 1 か所)
      if (canEnterScope(st.entryMetas.get(lid)?.archetype)) {
        dispatcher.dispatch({ type: 'DUAL_SET_SCOPE', side, lid });
        carryDualFocus(side);
        return true;
      }
      return openNote(lid);
    }
    /**
     * 🔴 **消すのは、このペインの印だけ**(#273 段②)。
     *
     * ⚠ `false` を返して global の `delete-selected` に落とすと、**左の列の印**を消す ──
     * user は 2 ペインを見ているのに、**画面に出ていないものが消える**。
     * 🔑 実体は `deleteFrom` **1 本**(左の列と同じ確認・同じ断り方)── 相手の集合だけを
     *   このペインのものにして渡す。
     */
    if (cmd === 'filer-trash') {
      deleteFrom(
        dispatcher,
        services,
        root,
        dualRows(st, side),
        paneOf(st.dual, side).selection,
        paneOf(st.dual, side).cursor,
      );
      return true;
    }
    return false;
  };

  const runFilerKey = (cmd: string): boolean => {
    const st = dispatcher.getState();
    /**
     * 🔴 **無言で断らない**(2026-08-18 の着地前レビュー 7)。
     *
     * `SET_SCOPE` も `SELECT_ALL` も reducer が `phase !== 'ready'` で**黙って
     * state を返す**ので、直す前は編集中に `Backspace` / `Ctrl+A` を押すと
     * **1 ドットも動かず理由も出なかった**(しかも `preventDefault` は走るので
     * ブラウザの既定 = 「前のページへ戻る」まで消えていた)。同じ面の
     * `Delete` は `delete-selected` が理由を出すので、**4 つの鍵で断り方が
     * 揃っていなかった**。⚠ 判定は**ここ 1 か所**(4 か所に散らさない)。
     */
    if (st.phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '編集を終了してからフォルダの操作をしてください',
      });
      return true;
    }
    if (cmd === 'filer-select-all') {
      dispatcher.dispatch({ type: 'SELECT_ALL' });
      return true;
    }
    if (cmd === 'filer-trash') {
      // ⚠ 実体は「まとめてゴミ箱へ」と同じ(確認・見えている印への絞り込み込み)
      run('delete-selected', root);
      /**
       * 🔴 **消したあとも焦点を連れて行く**(着地前レビュー 4)。表は
       * `entryMetas` が変わると `filer.ts` が丸ごと組み直すので、押した行と
       * 一緒に**焦点が body へ落ちる** ── 直す前は 1 回消したらそこで
       * `Backspace` も `Delete` も `Ctrl+A` も死んでいた(門に当たらなくなる)。
       * ⚠ 移動の 2 つ(`filer-parent` / `filer-open`)にだけ入れて、ここに
       *   入れていなかった ── CLAUDE.md「片側を直したら反対側を必ず疑う」。
       */
      return true;
    }
    if (cmd === 'filer-parent') {
      if (st.scopeLid === null) return false; // ルートで押しても何も起きない
      const up = getAncestorFolders(st.scopeLid, st.entryMetas, st.relations)[0] ?? null;
      dispatcher.dispatch({ type: 'SET_SCOPE', lid: up?.lid ?? null });
      return true;
    }
    if (cmd === 'filer-row-down' || cmd === 'filer-row-up') {
      const lid = rowAt(st, cmd === 'filer-row-down' ? 1 : -1);
      if (lid === null) return false;
      /**
       * 🔴 **送ると印も動く**(OS のファイラ = 焦点と選択が一致する)。
       * ⚠ **中央のノートは開き直さない** ── 開くのは `Enter` の仕事である
       *   (user 裁定 2026-08-18「Enter は閲覧を開始」)。`SELECT_ENTRY` を撃つと
       *   1 行送るたびに本文の読み直し(worker 往復)が起きる。
       * 🔑 既存の 2 つで足りる ── 印を空にしてから 1 件付ける(規則を増やさない)。
       *   これで起点(`selectionAnchor`)もその行に立つので、続く `Shift` が効く。
       */
      dispatcher.dispatch({ type: 'CLEAR_SELECTION' });
      dispatcher.dispatch({ type: 'TOGGLE_SELECT', lid });
      focusRow(lid);
      return true;
    }
    if (cmd === 'filer-extend-down' || cmd === 'filer-extend-up') {
      const from = focusedRowLid();
      const lid = rowAt(st, cmd === 'filer-extend-down' ? 1 : -1);
      if (lid === null) return false;
      /**
       * ⚠ **起点が無いときは、いまの行を起点に立ててから伸ばす**。
       * `rangeInRows` は起点 `null` を「行き先 1 件」と解くので、そのまま撃つと
       * **押すたびに 1 件へ潰れて**積み上がらない(OS は現在行から伸びる)。
       */
      if (st.selectionAnchor === null && from !== null) {
        dispatcher.dispatch({ type: 'CLEAR_SELECTION' });
        dispatcher.dispatch({ type: 'TOGGLE_SELECT', lid: from });
      }
      dispatcher.dispatch({ type: 'SELECT_RANGE', lid });
      focusRow(lid);
      return true;
    }
    if (cmd === 'filer-open') {
      // ⚠ 焦点が先、印は次 ── 理由は `focusedRowLid` の注記
      const lid = focusedRowLid() ?? st.selectedLid;
      if (lid === null) return false;
      // 入れ物なら中へ(2 クリックと同じ)。⚠ 規則は 1 か所 ── `SET_SCOPE` を撃つ
      if (canEnterScope(st.entryMetas.get(lid)?.archetype)) {
        dispatcher.dispatch({ type: 'SET_SCOPE', lid });
        return true;
      }
      return openNote(lid);
    }
    return false;
  };
  const doc = root.ownerDocument;
  /**
   * 🔴 **他所を押したら確定する**(#273 段④。OS のファイラと同じ)。
   *
   * ⚠ `renaming` の門は**変異試験で観測できない**(外しても test は全部通る)。
   *   `Esc` でやめた回は `DUAL_RENAME_END` が同期に走って入力欄が DOM から外れ、
   *   **外れた節点の focusout は root まで上がらない**ので、この handler に届かない
   *   ── だから Chromium では門が要らない。⚠ ただし「要素を外したときに focusout を
   *   出すか」は**エンジンで違う**ので、届いた回に打った値が蘇らないよう残している。
   *   「これが無いと壊れる」とは書かない(CLAUDE.md「外して壊れることを 1 度は見る」)。
   */
  const onRenameBlur = (ev: Event): void => {
    const el = ev.target;
    if (!(el instanceof HTMLInputElement) || !el.matches('[data-pkc-field="dual-rename"]')) return;
    if (dispatcher.getState().dual.renaming === null) return;
    const lid = el.getAttribute('data-pkc-entry');
    if (lid !== null) commitDualRename(lid, el.value);
  };
  /**
   * 🔴 **DOM の焦点が行に入ったら、カーソルもそこへ**(2026-08-19 の作り直し)。
   *
   * ⚠ カーソルの正本は state だが、**焦点は state を通らずに動くことがある** ──
   *   `Tab` で表へ入る / `click` の既定 / `carryDualFocus` の立て直し。
   *   橋を架けないと「枠は左の行に見えているのに、`↓` は先頭から始まる」になる。
   * ⚠ 逆向き(state → 焦点)は `moveDualCursor` が持つ。**2 本の橋で 1 つの値**を
   *   同期させる形なので、どちらも**同じ値なら何もしない**(reducer が畳む)。
   */
  const onDualFocusIn = (ev: Event): void => {
    const tr = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-pkc-action="dual-row"]',
    );
    if (tr === null || tr === undefined) return;
    const side = tr.getAttribute('data-pkc-side');
    const lid = tr.getAttribute('data-pkc-entry');
    if ((side !== 'left' && side !== 'right') || lid === null) return;
    dispatcher.dispatch({ type: 'DUAL_SET_CURSOR', side, lid });
  };
  root.addEventListener('focusin', onDualFocusIn);
  root.addEventListener('focusout', onRenameBlur);
  doc.addEventListener('keydown', onShortcut);
  root.addEventListener('keydown', onKeydown);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('mousedown', onMousedown);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.removeEventListener('focusin', onDualFocusIn);
    root.removeEventListener('focusout', onRenameBlur);
    doc.removeEventListener('keydown', onShortcut);
    root.removeEventListener('keydown', onKeydown);
  };
}
