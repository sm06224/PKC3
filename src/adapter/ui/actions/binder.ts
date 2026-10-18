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
import { errorText } from '@features/error-text';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { bindWaveDrag } from './wave-drag';
import { renameAttachmentAndFile, renameEntryFromRow, restoreRenamedTitle } from './attachment-rename';
import { lidOfNode } from './lid-of-node';
import { cellName } from '@features/markdown/csv-formula';
import { isEditableColor } from '@features/markdown/color-code';
import type { DroppedAt } from './asset-into-note';
import { deliveredEntryOf, type ExtDeliveredEntry } from '@features/extension/ext-delivery';
import { BUILTIN_KINDS, isLaunchableUrl, tileSelectsEntry } from '@features/launcher/tiles';
import {
  chapterSpanOf,
  headingAtSourceLine,
  headingLevel,
  isHeadingFolded,
  revealBlock,
  toggleHeadingFold,
  toggleLogDay,
} from '../render/heading-fold';
import { ADAPTER_SETTING_VALIDATORS } from '../render/settings-validators';
import { toggleCodeCollapse } from '../render/code-collapse';
import { SEARCH_FIND_ATTR } from '../render/search';
import { settleJump } from '../render/long-note';
import { insideCodeOrMath } from '@features/markdown/code-context';
import { lineStart } from '@features/markdown/line-start';
import { blockSpanAt, sliceLines } from '@features/markdown/source-blocks';
import {
  tableAt,
  tableConvertRefusal,
  tsvFenceFromPlain,
  type TableFormat,
} from '@features/markdown/table-convert';
import {
  isPlaceOpen,
  placeBlockUnclosed,
  placeGroupAt,
  placeGroupItems,
  placeRectOf,
  placeShapeAt,
  placeIsFrontmost,
  placeStyleAt,
  placeTextOf,
  setPlaceText,
} from '@features/markdown/place-notation';
import { parsePlaceRotate } from '@features/markdown/place-rotate';
import {
  parsePlaceColor,
  parseArrowSpell,
  parseSizeSpell,
  parsePlaceWidth,
  type PlaceSize,
  type PlaceStyle,
} from '@features/markdown/place-color';
import type { PlaceShape } from '@features/markdown/place-shape';
import { insertionBlocked } from '@features/markdown/line-move';
import {
  BLOCK_END_ATTR,
  BLOCK_GRIP_FIELD,
  BLOCK_LID_ATTR,
  BLOCK_START_ATTR,
  blockStepsAt,
  grippedBlock,
} from '../render/block-grip';
import {
  CALC_TOO_MANY_DIGITS,
  calcLineAction,
  explainCalcMiss,
  formatCalcResult,
  resolveInlineCalc,
} from '@features/markdown/inline-calc';
import { alignMdTable } from '@features/markdown/table-align';
import { quoteOnEnter } from '@features/markdown/quote-assist';
import { indentLines } from '@features/markdown/indent-assist';
import { swapLines } from '@features/markdown/line-swap';
import { TIDY_NOTES, tidySelection, type TidyOp } from '@features/markdown/text-tidy';
import { tableOnTab } from '@features/markdown/table-assist';
import { hasNumberedItems, renumberLists } from '@features/markdown/list-renumber';
import { caretAfterReplace, caretLineOf, hasTaskItems, sortTasksAtCaret } from '@features/markdown/task-sort';
import { stripDialect } from '@features/markdown/strip-dialect';
import {
  blockedActionNote,
  bodyWriteBlockReason,
  blockedWithSuffix,
  hasAppGroupNote,
  hasUnsavedTyping,
  hasReverseOnlyRelation,
  hasSameRelation,
  appGroupIconName,
  appGroupOrderCount,
  hasAppGroupOrder,
  isCodeDraft,
  appTileRefusal,
  isViewMode,
  nextViewMode,
  PLACE_LINE_REMOVE_OPEN_REFUSAL,
  PLACE_REMOVE_OPEN_REFUSAL,
  phaseBlockReason,
  appGroupWriteRefusal,
  selectBlockReason,
  screenBodyOf,
  SECTION_DRAFT_NOTE,
  type AppState,
  type PartialDraft,
  type ViewMode,
} from '@adapter/state/app-state';
import {
  SHOWN_LINE_LOST,
  shownBodyLine,
  shownCardLine,
  shownCellLine,
  shownPlacedLine,
  noteCellWrite,
  noteShapeWrite,
} from '@adapter/state/shown-line';
import { groupsNeedingNote, planGroupMove } from '@features/launcher/group-order';
import { isMovableTile } from '@features/launcher/tile-order';
import { filerFlattenNow, filerRowOptions, dualListViewOptions } from '@adapter/state/list-view-options';
import { appOpenedStore } from '@adapter/platform/opened-store';
import type { LocalFolder } from '@adapter/platform/local-folder';
import type { LinkedFileTooLarge } from '@adapter/platform/launched-files';
import { appSearchHistory } from '@adapter/platform/search-history-store';
import { createHintOf, dismissMissedLine, paintSearchHistory } from '@adapter/ui/render/shell';
import type { EntryMeta } from '@core/model/entry-meta';
import {
  filerRows,
  operationTargets,
  smartLidsOf,
  visibleSelection,
} from '@features/relation/filer-list';
import { archetypeLabel } from '@features/flavor/archetype-label';
import { kindChangeQuestion, kindChangeTarget } from '@features/flavor/kind-change';
import { HIDDEN_HEAD_ATTR, foldAttachmentHead, joinHiddenHead } from '@features/flavor/attachment-edit-fold';
import { countMatches } from '@features/markdown/body-replace';
import { SMART_ARCHETYPE, SMART_FIELDS, needsRescan, type SmartField } from '@features/smart/smart-spec';
import {
  buildSettingsFile as buildSettingsFileData,
  settingsAppliedNote,
  settingsTooLongToExport,
  canApplySettings,
  planSettingsImport,
  settingsChangeText,
  settingsFileName,
  settingsPlanNote,
} from '@features/settings/settings-file';
import { downloadBlob } from '@adapter/platform/download';
import {
  CHAPTER_DIAGRAM_INDEX_ATTR,
  CHAPTER_WINDOW_ACTIONS,
} from '@adapter/platform/chapter-window';
import { matchContact, visibleContacts, type ContactCard } from '@features/contact/contact-card';
import { buildVcf, countUnwritableBirthdays, isVcfFileName, vcfNoteOf } from '@features/contact/vcard';
import { isIcsFileName } from '@features/schedule/ics-import';
import { isMarkdownFileName } from '@features/import/plain-markdown';
import { ARCHETYPE_ICONS, BAR_TILE_ATTR, setActionIcon } from '@adapter/ui/render/icons';
import { OVERFLOW_ATTR } from '@adapter/ui/render/bar-overflow';
import { setContainerRepairToggle } from '@adapter/ui/render/commands';
import { isIconName } from '@features/icon/symbols';
import {
  insertBlockText,
  insertText,
  replaceChanged,
  rowTextAbove,
  OWN_MEANING,
  ROW_REOPEN_EVENT,
  type RowReopenDetail,
} from '@adapter/ui/render/row-swap';
import { INLINE_CODE_COPY_FAILED_EVENT } from '@adapter/ui/render/inline-code-copy';
import { HEADING_ANCHOR_COPY_FAILED_EVENT } from '@adapter/ui/render/heading-anchor';
import { iconShortcodeFor } from '@features/icon/icon-shortcode';
import {
  HOLD_ATTR,
  neighborCell,
  openCellAt,
  opensOnSinglePress,
} from '@adapter/ui/render/cell-input';
import { resetTableSort } from '@adapter/ui/render/table-sort';
import type { StatusOptions } from '@adapter/ui/render/status-notice';
import {
  resolveAppendAt,
  sectionAt,
  headingRefAt,
  resolveHeadingRef,
  headingLine,
} from '@features/markdown/append-target';
import { waitSectionSaveSettled } from '@adapter/state/section-save-wait';
import { typedCellNote } from '@adapter/state/store-effects';
import { openCodeFenceAt, locateCodeFence } from '@features/markdown/code-fence-edit';
import { isTextScale } from '@features/text-scale';
import { chooseTextScale } from '@adapter/ui/render/text-scale';
import { isReadColumns, readColumnsSpec } from '@features/read-columns';
import { isPageFormat, pageFormatSpec } from '@features/page-format';
import { isProseAlign, proseAlignSpec } from '@features/prose-align';
import { plainChoiceLabel } from '../render/settings/default-mark';
import { isColumnRule } from '@features/column-rule';
import { isTagBadge } from '@features/tag-badge';
import { chooseColumnRule } from '@adapter/ui/render/column-rule';
import { chooseTagBadge } from '@adapter/ui/render/tag-badge';
import { currentTagColor } from '@adapter/ui/render/tag-color';
import { chooseReadColumns, cycleReadColumns } from '@adapter/ui/render/read-columns';
import { appendModeOf } from '@adapter/ui/render/append-box';
import { bodyBelowFrontmatter, frontmatterLineCount } from '@features/markdown/frontmatter';
import {
  ENTRY_PICK_LIMIT,
  type EntryPickRow,
  entryPickNote,
  entryPickRows,
  entryPickTotal,
} from '@features/entry-ref/entry-pick';
import { recentNavLids } from '@features/history/opened-log';
import { formatListDate } from '@features/datetime/stored-date';
import { formatEntryLink, formatSectionLink } from '@features/entry-ref/entry-ref-format';
import { knownSplitLids } from '@features/split-frames';
import { STACK_ARCHETYPE, stackBody } from '@features/flavor/stack-flavor';
import { insertionForLineDate } from '@features/schedule/line-date';
import { dayStamp } from '@features/datetime/date-math';
import { safeName } from '@features/export/file-name';
import { hasTranscriptCues, srtFromTranscript, transcriptCues } from '@features/asr/srt';
import { decodeTaskDrag, dropTaskCard, encodeTaskDrag } from '@adapter/ui/render/schedule-drag';
import { setScheduleWriteGate } from '@adapter/ui/render/schedule-write-gate';
import { offerDoneUndo, offerMoveUndo, undoScheduleMove } from '@adapter/ui/render/schedule-undo';
import { slotOfCard } from '@features/schedule/move-undo';
import { plainTaskTitle } from '@features/schedule/task-title';
import {
  DATE_SHORTCUTS,
  isDateShortcut,
  shortcutDate,
} from '@features/schedule/date-shortcuts';
import { isRealCalendarDate } from '@features/schedule/schedule-date';
import {
  adjacentDateNote,
  dateNoteMissingNotice,
  findTodayNote,
  isDateTitle,
  todayNoteTitle,
} from '@features/schedule/today-note';
import { formatLineDate, readLineDate } from '@features/schedule/line-date';
import { formatAssetRef, isImageAssetMime } from '@features/asset/asset-ref-format';
import { findImageRefs, type ImageAlign, type ImageAttrs } from '@features/markdown/image-attrs';
import { isBackupFileName } from '@features/export/archive-kind';
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
import { convertPastedHtml, pastedHtmlFence } from '@features/markdown/html-to-markdown';
import { convertPastedRtf } from '@features/markdown/rtf-to-markdown';
import {
  choosePaste,
  describePaste,
  DEFAULT_PASTE_SOURCE,
  pasteConvertedMessage,
  PASTE_MESSAGE_COALESCE_MS,
  type PasteSource,
} from '@features/markdown/paste-source';
import { convertPastedPermalink } from '@features/link/permalink';
import { resolveMime } from './attach';
import {
  applyFormat,
  DIAGRAM_CHOICES,
  DIAGRAM_TEMPLATES,
  insertBlock,
  linkifyPastedUrl,
  SINGLE_COLUMN_TABLE_NOTE,
  tableOpMadeSingleColumn,
  type FormatOp,
  type TextSelection,
} from '@features/markdown/text-ops';
import { insertSnippet, nextSnippetSlot } from '@features/snippet/snippet-expand';
import { abbrBeforeCaret, type SnippetItem } from '@features/snippet/snippet-table';
import { snippetMenu, snippetMenuNote } from '@features/snippet/snippet-menu';
import { appendHeadingFor, isAppendable } from '@features/flavor/append-spec';
import { appendAndSettle } from '@adapter/state/append-settle';
// 🔑 別のタブが編集中かの問い合わせは 1 本(#529 W5-d ── 板の付箋・本文の下の追記欄・PDF・AI が同じ口を通る)
import {
  editedElsewhereReason,
  elsewhereCheckNotNeeded,
  type EditLockPort,
} from '@adapter/state/edited-elsewhere';
import {
  closePlaceInline,
  openPlaceInline,
  placeInlineOf,
  placeInlineText,
  showPlaceInlineNote,
} from '../render/place-inline';
import { MAX_TAG_CHARS, overlongTagNames, splitTags } from '@features/flavor/tags';
import { TAGS_KEY } from '@features/query/group-by';
import { isEntrySort, NATURAL_DESC } from '@features/filter/entry-sort';
import { COLUMN_PANES, isPaneId, type PaneId } from '@features/pane-visibility';
import { STRUCTURAL, isRelationKind, relationLabel } from '@features/relation/kinds';
import {
  canEnterScope,
  collectSubtreeLids,
  getAncestorFolders,
  getRootEntries,
  getStructuralChildren,
  listMoveTargets,
  listSiblings,
  resolveCanonicalParents,
} from '@features/relation/tree';
import {
  bookmarkRefusal,
  liveBookmarks,
  noteBookmarkKey,
  placeBookmarkIn,
  placeBookmarkKey,
} from '@features/relation/dual-bookmarks';
import { appDualPrefs } from '@adapter/ui/render/dual-prefs';
import { matchesTitle, normalizeQuery } from '@features/filter/title-filter';
import { planCopy } from '@features/relation/copy-plan';
import {
  otherSide,
  paneFilterOptions,
  paneOf,
  paneScope,
  scopeFallbackNote,
  scopeFellBack,
  type DualSide,
} from '@features/relation/dual-pane';
import { appPanes, applyPaneVisibility, refoldPeeked } from '@adapter/ui/render/pane-visibility';
import { requestAppendFocus, requestBodyFocus, takeAppendFocus } from '@adapter/ui/render/focus-request';
import { isTouchOnly } from '@adapter/ui/render/touch-device';
import { currentTrashOffer, LINKED_FROM_MAYBE, LINKED_FROM_SOME, offerTrashUndo, takeTrashUndo } from '@adapter/ui/render/trash-undo';
import { remapEntryLids } from '@features/import/body-remap';
import {
  currentDualMoveOffer,
  offerDualCopyUndo,
  offerDualMoveUndo,
  takeDualUndo,
} from '@adapter/ui/render/dual-move-undo';
import { resolveRelationTarget } from '@features/relation/target-label';
import { renameOfferingUndo, takeRenameUndo } from '@adapter/ui/render/rename-undo';
import { appPhone } from '@adapter/ui/render/phone-layout';
import { appKeymap, type KeymapStore } from '@adapter/ui/render/keymap';
import { appOpenInEdit, OpenInEditStore } from '@adapter/ui/render/open-in-edit';
import { appPopupHint, isExternalNewTabLink, POPUP_HINT_TEXT, PopupHintStore } from '@adapter/ui/render/popup-hint';
import {
  chordOf,
  findCommand,
  isMac,
  typesCharacter,
  KEY_COMMANDS,
  type KeyCommand,
} from '@features/keymap';
import { paletteRows, type PaletteRow } from '@features/palette/palette-rows';
import { commandQueryOf } from '@features/palette/command-query';
import { normalizeFindQuery } from '@features/filter/search-hits';
import { splitRecentRows } from '@features/palette/recent-commands';
import { appRecentCommands } from '@adapter/platform/recent-commands-store';
import { paintCommandList } from '@adapter/ui/render/command-list';
import {
  blockMenuActions,
  ADD_PLACE_ACTION,
  PLACE_RENAME_ACTION,
  ADD_PLACE_NOTE_ACTION,
  ADD_PLACE_TEMPLATE_ACTION,
  placeLineMenuActions,
  PLACE_STYLE_KEYS_ATTR,
  PLACE_STYLE_ARROW_ATTR,
  PLACE_STYLE_SIZE_ATTR,
  PLACE_STYLE_ROTATE_ATTR,
  PLACE_STYLE_WIDTH_ATTR,
  bodyMenuActions,
  editingRowMenuActions,
  entryMenuActions,
  headingMenuActions,
  menuShortcutFor,
  NOTE_TOOL_ACTIONS,
  noteToolActions,
  tableMenuActions,
  imageMenuActions,
  IMAGE_ALIGN_ATTR,
  IMAGE_WIDTH_ATTR,
  taskRunMenuActions,
  blockStepMenuActions,
  BLOCK_STEP_DIR_ATTR,
  tableConvertPickLabel,
  tableHeaderPickLabel,
  appGroupMenuActions,
  tileMenuActions,
  tileOpenTargetMenuActions,
  TILE_OPEN_TARGET_ATTR,
  TASK_REPEAT_MENU_ACTION,
  repeatMenuActions,
  REPEAT_ATTR,
  withTrailingLast,
  withEditReady,
} from '@features/entry-actions';
import { currentAppOpenTarget } from '@adapter/ui/render/app-open-target';
import {
  type MenuItem,
  closeContextMenu,
  scrollInsideMenu,
  scrollUnchangedSinceOpen,
  contextMenuOpen,
  openContextMenu,
} from '../render/context-menu';
import { setupLinkPreview, closeLinkPreview } from '../render/link-preview';
import { setupLightbox, openLightbox, closeLightbox, lightboxOpen } from '../render/lightbox';
import { chordHint, HINT_BASE, HINT_BLOCKED, setBlocked } from '../render/shortcut-hint';
import { TARGET_LID_ATTR } from '../render/target-lid';
import { sectionBoxText, SECTION_BOX_INPUT_FIELD, SECTION_BOX_REGION } from '../render/section-box';
import { codeBoxText, CODE_BOX_INPUT_FIELD, CODE_BOX_REGION } from '../render/code-box';
import { structureText } from '@features/structure/structure-text';
import {
  profileLineText,
  profileLines,
  profileSummary,
  sharedNote,
  trashNote,
  type StorageProfileResult,
} from '@features/storage/storage-profile';
import {
  integritySummary,
  parseQuickCheck,
} from '@features/storage/db-rescue';
import { elapsedText, msToSeconds } from '@features/elapsed-text';
import { quotaText } from '@features/storage/quota-watch';
import { EDIT_ELSEWHERE_ERROR } from '@features/message/caution-events';
import type {
  IntegrityCheckResult,
  RescuePage,
} from '@adapter/platform/storage/protocol';
import {
  canApplyPlan,
  parsePlan,
  planPreview,
  resolvePlanTarget,
} from '@features/structure/structure-plan';
import { appQueryKey } from '@adapter/ui/render/query-key-store';
// 🔴 ▼ で選んだ「作る種類」を端末側に覚える(#1045)
import { appCreateKind } from '@adapter/ui/render/create-kind';
import { BODY_HOST_SELECTOR, PAINTED_ATTR } from '@adapter/ui/render/detail';
import { openView } from '@adapter/ui/render/open-view';
import {
  CLOSE_NOTE_WINDOW_REFUSED,
  CLOSE_VIEW_WINDOW_REFUSED,
  type CloseViewWindowResult,
} from '@adapter/platform/view-window';
import { parseLinkTarget } from '@features/entry-ref/link-target';
import { flashCopied, handleCopyMdBlock } from './copy-md-block';
import { finishCopy, selectedMarkdown } from './copy-source';
import { formatTarget } from './format-target';
import { installLongPress, LONG_PRESS_TARGET, LONG_PRESS_TARGETS } from './long-press';
import { isRepeatUnit, materializedDates } from '@features/schedule/repeat';
import { buildIcs, resolveIcsZone } from '@features/schedule/ics';
import { scheduleItemsOf } from '@adapter/ui/render/schedule-items';
import { appScheduleNotify } from '@adapter/ui/render/schedule-notify';
import { appScheduleWeekStart } from '@adapter/ui/render/schedule-week-start';
import { normalizeWeekStart } from '@features/schedule/week-start';
import { copyMarkdownAndHtml, copyPlainText } from '@adapter/platform/clipboard';
import { appCopyHistory } from '@adapter/platform/copy-history-store';
// 🔑 メッセージの口・字は 1 か所から引く(設計 doc §7、段②a。CLAUDE.md §7)
import { appMessagePost, setMessageCap } from '@adapter/platform/message-post';
import { setMessageKindFilter } from '@adapter/platform/message-filter';
import { messageFilterOfAttr } from '@adapter/ui/render/message-bar';
import { appStorageVacuum } from '@adapter/platform/storage/vacuum-run';
import {
  isSystemMessageLid,
  MESSAGE_CAP_OPTIONS,
  SYSTEM_MESSAGE_LID,
  titleForMessageLid,
} from '@features/message/message-log';
import {
  COPY_HISTORY_EMPTY,
  copyHistoryMenu,
} from '@adapter/ui/actions/copy-history-menu';
import { copyLabel } from '@features/clipboard/history';

/**
 * 🔴 **「コピーした物」を出す口は 1 つ**(#678)。鍵(`Mod+Shift+V` / パレット)と
 * スマホの `⋯` の**両方から呼ぶ** ── 2 か所に書くと、片方だけ直した日に
 * 「鍵では出るのに ⋯ では出ない」形になる(CLAUDE.md §7)。
 *
 * ⚠ 0 件のときは**メニューを出さずに帯で言う** ── 「まだ何もコピーしていません」を
 *   項目にすると、押しても何も起きない行になる。
 */
function openCopyHistory(root: HTMLElement, notify: (text: string) => void): void {
  const items = copyHistoryMenu(appCopyHistory.items());
  if (items.length === 0) {
    notify(COPY_HISTORY_EMPTY);
    return;
  }
  // ⚠ 出す場所は ⋯ の下(在れば)── 鍵から来たときは画面の左上へ寄せる
  const anchor = root.querySelector<HTMLElement>('[data-pkc-field="phone-menu"]');
  const rect = anchor?.getBoundingClientRect();
  openContextMenu(
    root,
    rect ? { x: rect.left, y: rect.bottom } : { x: 8, y: 8 },
    items,
    root.ownerDocument.activeElement,
  );
}

/**
 * 🔴 最近開いたノートの履歴一覧(#1107)。
 * 直近に閲覧・編集したノートを新しい順に一覧し、選んでジャンプする。
 */
function openRecentEntries(
  root: HTMLElement,
  dispatcher: Dispatcher,
  notify: (text: string, opts?: StatusOptions) => void,
  services: BinderServices,
): void {
  const st = dispatcher.getState();
  const initialLids = recentNavLids(
    st.openedAt,
    st.selectionHistory.past,
    st.selectionHistory.future,
    st.selectedLid,
    (lid) => st.entryMetas.has(lid),
  );
  if (initialLids.length === 0) {
    notify('最近開いた他のノートがありません', CAUTION);
    return;
  }
  void pickEntryInApp(
    root,
    (query) => {
      const now = dispatcher.getState();
      const lids = recentNavLids(
        now.openedAt,
        now.selectionHistory.past,
        now.selectionHistory.future,
        now.selectedLid,
        (lid) => now.entryMetas.has(lid),
      );
      const q = normalizeQuery(query);
      const matched = lids.filter((lid) => {
        const meta = now.entryMetas.get(lid);
        return meta !== undefined && matchesTitle(meta.title, q);
      });
      const year = new Date().getFullYear();
      const items: EntryPickRow[] = matched.slice(0, ENTRY_PICK_LIMIT).map((lid) => {
        const meta = now.entryMetas.get(lid)!;
        const openedMs = now.openedAt.get(lid);
        const timeStr = openedMs
          ? formatListDate(new Date(openedMs).toISOString(), year)
          : meta.updatedAt
            ? formatListDate(meta.updatedAt, year)
            : '';
        const ancestors = getAncestorFolders(lid, now.entryMetas, now.relations);
        const folderPath =
          ancestors.length > 0 ? ancestors.map((a) => a.title).reverse().join('/') : '';
        const kind =
          [folderPath, timeStr].filter(Boolean).join(' · ') || archetypeLabel(meta.archetype);
        return {
          lid,
          title: meta.title === '' ? '(題名なし)' : meta.title,
          kind,
        };
      });
      const note = entryPickNote(items.length, matched.length);
      return { items, note };
    },
    { title: '最近開いたノートへ移る' },
  ).then((lid) => {
    if (lid === null) return;
    // 🔴 編集中に押しても無言で何も起きなかった ── 他のノートを開く道と同じく理由を出す
    selectEntryOrExplain(dispatcher, lid, 'ノート', root, services);
  });
}

/**
 * 🔴 **書庫の中を見て、選んだ物だけ取り出す**(#818 段②)。
 *
 * > user の言葉 2026-09-09:「**アーカイブ形式ファイルを右クリックでファイル
 * > エクスプローラ開始して、階層の異なる複数のファイルを指定して展開できるように
 * > したい / 最低限 zip 対応したい**」
 *
 * 🔑 **取り出した物は、いまの添付と同じ道へ渡す**(`attachFiles`)── 新しい
 *   保存経路を作らない。重複の畳み・縮め・保存は、そちらが既に持っている。
 * 🔴 **無言で失敗しない** ── `zip-reader` は断る理由を日本語で持っている
 *   (暗号化 / 分割書庫 / CRC 不一致)ので、**その字をそのまま出す**。
 * ⚠ **1 件落ちても残りは入れる** ── 壊れた 1 件で全部を捨てると、
 *   user は「何も取り出せない書庫」としか分からない。落ちた物は名前で言う。
 */
async function browseArchive(
  root: HTMLElement,
  services: BinderServices,
  assetKey: string,
  name: string,
  /**
   * 🔴 **入れ先のノート**(#826 の着地前レビュー)。⚠ **押した瞬間に控える** ──
   *   別の窓で選んでいる間、user は主の窓で**別のノートへ移れる**ので、
   *   取り出すときに読み直すと**押したときと違うノートへ入る**。
   * ⚠ modal はこれを「周りを止める」ことで**ついでに**守っていた(CLAUDE.md §10)──
   *   止めないと決めた以上、**身元は自分で持つ**。
   */
  intoLid: string | null,
): Promise<void> {
  const say = (text: string): void => services.showStatus?.(text);
  const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  if (services.readAssetBlob === undefined) {
    say('このタブの PKC3 が古いままのため、zip ファイルの中を見られません。再読み込みしてください');
    return;
  }
  /**
   * 🔴 **窓は「押した瞬間」に掴む**(#826)── `await` の後に `window.open` を呼ぶと、
   *   user の操作から離れて**ポップアップ阻止に掛かる**(`manual-window.ts` と同じ作法)。
   * 🔑 どちらで開くかは **user の設定**(既定は別の窓)。⚠ 「この画面」を選んでいる人には
   *   窓を掴もうとしない ── 掴めなかったのか、選んだ結果なのかを混ぜない。
   */
  // ⚠ 電話の画面では、選ばれていても「この画面」── 画面が 1 枚なら並べられない
  const wantWindow = effectiveOpenPlace(currentOpenPlace(), appPhone.isPhone()) === 'window';
  const win = wantWindow ? (services.grabArchiveWindow?.(name, assetKey) ?? null) : null;
  /**
   * 🔴 **既に同じ書庫を映している窓は、前へ出すだけ**(#826 の着地前レビュー)。
   * ⚠ 読み直して組み直すと、user が付けた印が全部消える ── 押した動機は
   *   「窓が見つからない」なので、**選び直しにさせない**。
   */
  if (win !== null && win.reused) {
    say(`「${name}」の一覧は別のウィンドウに出ています`);
    return;
  }
  const blob = await services.readAssetBlob(assetKey).catch(() => null);
  if (blob === null) {
    // ⚠ 理由は**窓の中にも出す** ── user は開いた窓を見ている(黙って閉じない)
    const why0 = `「${name}」の中身が見つかりません(添付が消えている可能性があります)`;
    win?.fail(why0);
    say(why0);
    return;
  }
  let entries: ZipEntry[];
  try {
    entries = await readZipDirectory(blob);
  } catch (e) {
    const why1 = `「${name}」の中を開けません: ${why(e)}`;
    win?.fail(why1);
    say(why1);
    return;
  }
  const rows = archiveRows(entries);
  if (rows.length === 0) {
    const why2 = `「${name}」の中に取り出せる物がありません`;
    win?.fail(why2);
    say(why2);
    return;
  }
  const pickRows = rows.map((r) => ({ ...r, size: r.isDirectory ? '' : humanBytes(r.size) }));
  // 🔑 何件入るかの判定は **1 本**(`markedFiles`)── 器の中で数え直さない
  const countFiles = (m: readonly string[]): number => markedFiles(entries, m).length;
  /**
   * ⚠ **黙ってその場の器へ落ちない** ── 「別の窓で開く」と設定した人には理由が要る。
   * ⚠ **言うのは器を出す直前**(着地前レビュー 💭J)── 読む前に言うと、添付が消えて
   *   いる回に「この画面で開きます」→「中身が見つかりません」と、開くと言った物が
   *   開かない 2 連になる。
   * 🔑 **戻し方まで書く**(良 5)── わざと止めている人は、これを押すたび読むことになる。
   */
  if (wantWindow && win === null) {
    say(
      '別のウィンドウが開けなかったので、この画面で開きます' +
        '(いつもこの画面でよければ、システムの「zip ファイルを開く場所」で選べます)',
    );
  }
  const marks =
    win !== null
      ? await win.pick({ rows: pickRows, countFiles, toggle: toggleArchiveMark })
      : await pickArchiveInApp(root, pickRows, countFiles);
  if (marks === null) return;
  const files = markedFiles(entries, marks);
  const names = extractNames(files.map((e) => e.name));
  const out: File[] = [];
  const bad: string[] = [];
  for (const [i, e] of files.entries()) {
    const outName = names[i] ?? baseName(e.name);
    try {
      out.push(new File([await readZipEntry(blob, e)], outName));
    } catch (err) {
      bad.push(`「${outName}」(${why(err)})`);
    }
  }
  if (out.length > 0) services.attachFiles?.(out, `「${name}」から取り出しました`, undefined, intoLid);
  const tail = bad.length === 0 ? '' : ` ${bad.length} 件は取り出せません: ${bad.join(' / ')}`;
  say(out.length === 0 ? `取り出せませんでした: ${bad.join(' / ')}` : `${out.length} 件を添付にしました${tail}`);
}
import { cleanForClipboard } from '@features/export/clipboard-html';
import {
  lastRescueWritten,
  type RescueAssets,
} from '@features/storage/rescue-archive';
import {
  RESET_PASSPHRASE,
  resetDoneMessage,
  resetExplainMessage,
  resetPassphraseLabel,
  resetPassphraseOk,
  type ContainerResetReport,
} from '@features/storage/container-reset';
import {
  rebuildDoneMessage,
  rebuildExplainMessage,
  type RebuildProgress,
  type RebuildReport,
} from '@features/storage/container-rebuild';
import { OFFICE_PACK_APPROX } from '@features/office/office-pack-size';
import { readZipDirectory, readZipEntry, type ZipEntry } from '@features/import/zip-reader';
import { humanBytes } from '@features/human-bytes';
import {
  archiveRows,
  baseName,
  extractNames,
  markedFiles,
  toggleArchiveMark,
} from '@features/archive/zip-browse';
import { currentOpenPlace } from '@adapter/ui/render/open-place';
import { appExternalImages } from '@adapter/ui/render/external-images';
import { parseFrontmatter } from '@features/markdown/frontmatter';
import { externalImageBlockReason } from './adopt-favicon';

/**
 * 🔴 **いま印を取りに行っているノート**(#856 段②)。
 *
 * ⚠ 連打を `disabled` で止めると**焦点が外れる**(下の受け手の注記)。
 * 🔑 器を触らずに 2 度目を落とすための帳簿である。⚠ `finally` で必ず消す
 *   ── 消し忘れると、その lid は**二度と取り込めなくなる**。
 */
const adoptingLinkIcons = new Set<string>();

/**
 * 🔴 **建て直しが走っている間は、2 度目を受けない**(#1006 の動線レビューが出した)。
 *
 * ⚠ 走り出すと**押せる物が 1 つも無い**ので、user は固まったと思って**もう一度押す** ──
 *   ところが窓は毎回出るので、**捨てる → 開き直す が 2 本同時に走りうる**。
 * ⚠ `disabled` で止めない ── **焦点が外れる**(すぐ上の受け手の注記と同じ理由)。
 *   🔑 器を触らずに 2 度目を落とすための帳簿である。⚠ `finally` で必ず戻す。
 */
let rebuildingContainer = false;
import { effectiveOpenPlace } from '@features/open-place';
import { joinCopied, pickMarked } from '@features/clipboard/scrap';
import { countCappedCells } from '@features/query/sql-cell';
import { sqlAnswerTsv, sqlEmbedFence, sqlNoteBody, sqlNoteTitle } from '@features/query/sql-to-note';
// 🔴 手持ちのファイルを開く選び所の印(#854 段②)
import {
  addSourceLidOf,
  SQL_ADD_LOCAL_FILE_VALUE,
  SQL_PICK_LOCAL_FILE_VALUE,
} from '@features/query/sql-local-file';
import { duckDbNetworkNoteOf } from '@features/query/sql-guest-source';
import { sqlMenuLabel } from '@features/query/sql-tip';
import { ATTACHMENT_NAME_ATTR, attachmentFileName, readAttachmentMeta } from '@features/flavor/attachment-flavor';
import { assetPermalink, entryPermalink, sectionPermalink } from '@adapter/platform/deep-link';
import { isLogRowHeading } from '@features/flavor/textlog-flavor';
import { PC_DIRECTORY_NOTE } from '@features/local-folder/folder-entries';
import {
  asSqlExportChoice,
  sqlExportChoices,
  sqlExportFileName,
  sqlExportFileText,
  sqlExportLabel,
  sqlExportMime,
} from '@features/query/sql-export';
import {
  canPersistSettings,
  defaultSettingsStorage,
  SETTINGS_NOT_PERSISTED_TEXT,
} from '../render/settings-persist-probe';
import { HELP_MANUAL_DRAWN_EVENT } from '../render/help';
import { sqlEngineOf } from '@features/query/sql-engine';
import {
  alertInApp,
  confirmInApp,
  pickDateInApp,
  pickCommandInApp,
  pickEntryInApp,
  pickSnippetInApp,
  pickTemplateNoteInApp,
  pickDiagramInApp,
  pickBodyIconInApp,
  pickArchiveInApp,
  pickCopyFormatInApp,
  pickPlaceGroupInApp,
  pickPlaceRectInApp,
  pickPlaceTemplateInApp,
  pickScrapInApp,
  pickSectionLeaveInApp,
  promptInApp,
  isAppDialogOpen,
  whenAppDialogClosed,
  type ArchivePickRow,
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

/**
 * 🔴 **押されたボタンが載っている予定の面**(#673 段②)。
 *
 * ⚠ 予定の面は**同じ document に 2 つ在りうる** ── 左の列の「予定」タブと、
 *   中央の面(別窓が塞がれた退避 / `#pkc?view=schedule`)。`root.querySelector` で
 *   document 全体から欄を引くと、**左の列に描かれている空の欄**を先に拾い、中央で
 *   打った字は読まれない(「やることを入力してください」と断られる)。
 * 🔑 だから**押した所から `closest` で上がる**。印は `ScheduleRenderer.ensureFrame`
 *   が器に焼く(`data-pkc-region="schedule"`)。
 */
function scheduleFaceOf(target: HTMLElement): HTMLElement | null {
  return target.closest<HTMLElement>('[data-pkc-region="schedule"]');
}


/** 既定 title の種別ラベル(連番は同 archetype の現在数 + 1)。 */

/**
 * 🔴 **id は、窓をまたいでもぶつからない形にする**(#973)。
 *
 * ## 何が起きていたか
 *
 * 直す前は `<epoch36>-<counter36 4 桁>` だけだった。⚠ `lidCounter` は
 * **module の変数**なので、**タブ / 別窓ごとに別の 0 から始まる** ── つまり
 * 入っているのは「時刻(ミリ秒)」と「**その窓の中の**通し番号」しかない。
 * 🔴 2 つの窓が同じミリ秒で同じ通し番号を引くと、**文字列が 1 バイト違わず同じ**になる。
 *
 * ⚠ ぶつかる幅は「同じミリ秒」だが、`moveEntries` も整理案の適用も
 *   **for ループの中で連続して呼ぶ**ので、1 回の操作で同じミリ秒に何本も採番される。
 *
 * ## 🔑 検出ではなく、ぶつかりようが無くする
 *
 * CLAUDE.md §7「衝突は、検出するより『起こらなくする』ほうが強い」── **32 bit の
 * 乱数**を足す。⚠ **既にある id は 1 つも変わらない**(足すのは新しく採番する分だけ)。
 *
 * ## ⚠ 綴りの制約は 2 つあり、どちらも別の file が持っている
 *
 * ① `pkc://<cid>/entry/<lid>` の token 規則 `[A-Za-z0-9_-]+`
 *    (`features/link/permalink.ts` の `TOKEN_RE`)
 * ② `':'` を含めない(`asset-blob-store.ts` の `assertCid` ── key 空間が混ざる)
 *
 * 🔑 base36 と `-` だけなので、両方に収まる(同じ file の `mintContainerId` と同じ考え方)。
 * ⚠ **前置の衝突**(`entry:n1` が `entry:n12` に当たる)を見る所は別に在り
 *   (`features/entry-ref/body-links.ts`)、そこは**次の 1 文字が lid の文字でないこと**で
 *   留めているので、段が 1 つ増えても効き方は変わらない。
 *
 * ⚠ `crypto` が無い箱では `Math.random` へ落ちる ── **落ちても字の形は同じ**
 *   (`store-proxy.ts` / `asset-key.ts` と同じ作法)。
 */
let lidCounter = 0;
function randomSuffix(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (c !== undefined && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(4);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}
/**
 * 🔴 **別のタブ・窓が編集中のノートへは、消す書換を撃たない**(#1087。追記と同じ門 = `editedElsewhereReason`)。
 *
 * ⚠ 通すと、編集中のタブの保存で上書きされ、消した結果は履歴にだけ残る(持ち出しなら、元からは既に切ってある)。
 *   **断って理由を出す**。問い合わせが落ちたときも黙らない(押しても何も起きないボタンにしない)。
 * 🔑 **問い合わせが要らない回は同期のまま撃つ**(口の無い環境・このタブが自分で編集中の回)。
 *   ⚠ 撃つ側は {@link act}。押した瞬間の値は呼び手が先に捕える(待っている間に画面が替わっても、押した物を撃つ)。
 * @param lids 確かめるノート(持ち出しは元と先の 2 つ)。⚠ 全部が通ったときだけ撃つ
 * @param failed 問い合わせが落ちた回の字(次にすることを言う)
 * @param lostNote 断った回の字に添える一言(打った升の字を知らせに残す `typedCellNote` など)。既定は空
 */
function actUnlessEditedElsewhere(
  dispatcher: Dispatcher,
  port: EditLockPort,
  lids: readonly string[],
  failed: string,
  act: () => void,
  lostNote: string = '',
): void {
  if (lids.every((l) => elsewhereCheckNotNeeded(dispatcher, port, l))) {
    act();
    return;
  }
  void (async () => {
    for (const l of lids) {
      const why = await editedElsewhereReason(dispatcher, port, l);
      if (why !== null) {
        dispatcher.dispatch({ type: 'OP_FAILED', error: why + lostNote });
        return;
      }
    }
    act();
  })().catch(() => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: failed + lostNote });
  });
}

/** スマートフォルダの条件を書き換える 3 つの口(足す / 選ぶ / 外す)が、別タブの確認に失敗したときの字(#1087)。 */
const SMART_COND_ELSEWHERE_FAILED =
  '条件を書き換えられませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください';

/**
 * 🔴 **予定を足す先の「今日のノート」は、追記できる種類だけ**(#1087)。
 * ⚠ 直す前は `findTodayNote` の答えをそのまま使っていた ── 題名が今日の日付のフォルダ・添付・スタック・アプリがあると、
 *   足した行がそこへ書かれ、**本文を持たない / 読まれない種類なので予定がどこにも出なかった**。
 * 🔑 追記できない種類は「無い」ものとして飛ばし、新しいテキストのノートを作る(`isAppendable` ── 追記欄と同じ 1 本)。
 *   ⚠ 予定の足し先だけの規則 ── 「今日」を開く側(`open-today`)は種類を問わない(`findTodayNote` の注記のとおり)。
 */
function findScheduleTargetNote(st: AppState, title: string): EntryMeta | null {
  return findTodayNote(
    [...st.entryMetas.values()].filter((m) => isAppendable(m.archetype)),
    title,
  );
}

/**
 * 🔴 **別のタブ・窓が今日のノートを編集中なら、予定を足さない**(#529 W5-d の続き。Gemini 裁定 Q5 = A)。
 * 予定の面の「足す」と目盛りの作成(`schedule-grid-create`)の**共通の入口**。
 *
 * ⚠ 通すと編集中のタブの保存で上書きされ、足した行は履歴にだけ残る。**断って理由を出し、`false` を返す**
 *   (呼び側は欄の字を残す)。問い合わせは追記の口と**同じ 1 本**(`editedElsewhereReason`)。
 * 🔑 **問い合わせが要る回だけ非同期**(今日のノートが既に在る・口が有る・このタブが自分で編集中でない)。
 *   それ以外(ノートがまだ無い = 誰も編集できない / 口の無い環境 / 字が空 / 読み込み中)は
 *   **従来どおり同期で {@link addScheduleItem} を呼ぶ**。
 * @param stillWanted 問い合わせの間に呼び側が「もう要らない」になったか(枠が畳まれた等)。要らなければ書かない。
 */
export function addScheduleItemChecked(
  dispatcher: Dispatcher,
  port: EditLockPort,
  item: Parameters<typeof addScheduleItem>[1],
  stillWanted: () => boolean = () => true,
): boolean | Promise<boolean> {
  const st = dispatcher.getState();
  const noteLid =
    (st.phase === 'ready' || st.phase === 'editing') && item.text.trim() !== ''
      ? (findScheduleTargetNote(st, todayNoteTitle(new Date()))?.lid ?? null)
      : null;
  if (noteLid === null || elsewhereCheckNotNeeded(dispatcher, port, noteLid)) {
    return addScheduleItem(dispatcher, item);
  }
  return editedElsewhereReason(dispatcher, port, noteLid).then(
    (why) => {
      if (!stillWanted()) return false;
      if (why !== null) {
        dispatcher.dispatch({ type: 'OP_FAILED', error: why });
        return false;
      }
      return addScheduleItem(dispatcher, item);
    },
    // 🔴 問い合わせが落ちても黙って捨てない(字は欄に残る)
    () => {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        // ⚠ 例外の英語を画面に出さない / 次にすることを言う(#1087)
        error: `予定を足せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください`,
      });
      return false;
    },
  );
}
/**
 * 🔴 **予定を 1 行、今日のノートの末尾へ足す**(#402 ② の「予定の面から足す」/ #855 段 B-2 の
 * 「目盛りをドラッグして足す」の**共通の書き口**)。
 *
 * 🔑 **新しい入れ物を作らない** ── 行き先は「**今日のノート**」で、その決め方は `open-today` と
 *   **同じ 1 本**(`todayNoteTitle` / `findTodayNote`)。書込も既存の追記(`APPEND_TO_ENTRY`)を通る。
 *   ⚠ ノートがまだ無ければ**先に作る** ── 作成の書込と追記の読みは effect の**同じ 1 本の chain** に
 *   載るので、順序は保たれる。
 * ⚠ 面は切り替えない・編集にも入らない(眺めたまま足したい ── #300「補助が主の作業領域を奪わない」)。
 *
 * @returns 同期の `false` = 書込を頼む前に断った(理由は `OP_FAILED` で出ている)。
 *   `Promise` = 頼んだ。**disk に着いたら `true`、着かなかった / 着いたか分からないなら `false`**(理由は出ている)。
 *   ⚠ 呼び側は **`true` のときだけ欄を空にする**(#1051 / #1087。打った字を黙って捨てない)。
 */
export function addScheduleItem(
  dispatcher: Dispatcher,
  item: {
    readonly text: string;
    /** `YYYY-MM-DD`。空 = 日付なし。 */
    readonly date: string;
    readonly time?: string | null;
    readonly timeEnd?: string | null;
  },
): boolean | Promise<boolean> {
  const st = dispatcher.getState();
  /**
   * 🔴 **編集中でも、今日のノートが別のノートなら足せる**(#1081。user 裁定 2026-09-27「推奨で」)。
   * ⚠ 直す前は `phase !== 'ready'` で**丸ごと**断っていた ── 行き先(今日のノート)は
   *   編集中のノートと別のことが多いのに、C6 / #1043 の「編集中でも別のノートは止めない」から
   *   外れていた。
   * 🔑 断るのは 3 つ:①読み込み中・保存に失敗して止まっている(ここ)②今日のノートが
   *   **まだ無い**のに編集中(作る `CREATE_ENTRY` は編集中に通らない ── 下)③今日のノートが
   *   **編集中のノート自身** / 章の欄が開いている / 書込中(reducer の `APPEND_TO_ENTRY` が
   *   同じ門 `bodyWriteBlockReason` で理由を出して断る)。
   */
  if (st.phase !== 'ready' && st.phase !== 'editing') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}足してください` });
    return false;
  }
  const text = item.text.trim();
  if (text === '') {
    // ⚠ **無言で終わらせない**(欄は出ているのに何も起きない dead click になる)
    dispatcher.dispatch({ type: 'OP_FAILED', error: '予定を入力してください' });
    return false;
  }
  /**
   * 🔴 **読めない日付は書かない**(#1087)── 日付の欄は年を 6 桁まで打てるので、打ち間違えると
   *   `@20261-03-05` を書いていた。読み手はそれを日付と読まないので、**足した予定がどこにも出ず、理由も出ない**。
   */
  if (item.date !== '' && !isRealCalendarDate(item.date)) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `日付「${item.date}」を読めません。日付を選び直してください` });
    return false;
  }
  /**
   * 🔴 **本文にも日付を書いていたら、黙ってどちらかを捨てない**(#1087)── 直す前は両方を並べて書き、
   *   読み手は**本文の日付**を採るので、欄で選んだ日の予定表には出なかった(「足しました」とは出る)。
   */
  if (item.date !== '' && readLineDate(text) !== null) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: '予定の字に日付(@…)が入っています。日付は欄か字のどちらか一方にしてください',
    });
    return false;
  }
  // 🔑 日付の書き方は `line-date.ts` の 1 本(`@2026-08-28 14:00..15:30`)── ここで綴らない
  const line = `- [ ] ${text}${
    item.date === ''
      ? ''
      : ` ${formatLineDate(item.date, item.time ?? null, null, null, null, item.timeEnd ?? null)}`
  }`;
  const title = todayNoteTitle(new Date());
  let lid = findScheduleTargetNote(st, title)?.lid ?? null;
  if (lid === null) {
    /**
     * ⚠ **作るのは読む画面のときだけ** ── `CREATE_ENTRY` は編集中に通らない(通すと編集の
     *   状態を置き換える)。理由も「今日のノートがまだ無いから」と言う ── 同じ「足す」が
     *   今日のノートの有無で通ったり断られたりするので、違いが読めるようにする。
     * ⚠ 断った回は欄を空にしない(呼び側は `false` で分かる)。
     */
    if (st.phase === 'editing') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `今日のノートがまだ無いので、${phaseBlockReason('editing')}足してください`,
      });
      return false;
    }
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
  /**
   * 🔴 **欄を空にしてよいのは、disk に着いたと分かったときだけ**(#1051 → #1087)。
   * ⚠ 直す前は「reducer が錠を掛けた(= 頼めた)」で `true` を返していた ── 書込が**後で**失敗する回
   *   (`APPEND_FAILED`: 空き不足・別のタブとの衝突・保存の失敗)も `true` で、欄が空になり、
   *   **赤い字だけが出て打った字は戻らなかった**。
   * 🔑 待ち方は新しく作らない ── PDF の引用・ブラウザの AI の書き足しと**同じ 1 本**(`appendAndSettle`)。
   *   錠が動いたかの判定も、結末が来ない回の時間切れも、あちらが持つ(ここで数え直さない。§7)。
   * ⚠ **時間切れ(着いたかもしれない)でも欄は残す**。理由は損の大きさ:字を残して重複して足されても
   *   行を消せば済むが、空にしてしまうと**書けていなかった回に打った字を失う**(打ち直しになる)。
   *   だから「分からない」は残す側へ倒し、理由を出す。
   */
  const r = appendAndSettle(dispatcher, lid, line, null, SCHEDULE_ADD_SETTLE_MS);
  const target = lid;
  return r.then((o) => {
    if (o.ok) {
      /**
       * 🔴 **足したことを言い、「元に戻す」を出す**(#1163 の依頼 57-5 / 100-4。Gemini の裁定:推薦どおり)。
       * ⚠ 直す前は足した直後に何も出ず、どのノートに入ったかも分からず、間違えて足すとノートを開いて行を消すしかなかった
       *   (カードの × は日付を外すだけで、行は残る)。
       * 🔑 戻す口は本文への追記と同じ 1 本(`open` を添えた知らせの隣の「元に戻す」= `UNDO_APPEND`)。新しい書込経路を作らない。
       * ⚠ 日付なしで足した回は、見えない理由も同じ 1 行で言う(別の知らせで上書きすると「元に戻す」が消える)。
       */
      const undated = item.date === '';
      const hidden = undated && !dispatcher.getState().showUndatedTasks;
      dispatcher.dispatch({
        type: 'OP_NOTICE',
        message: scheduleAddedNotice(text, title, undated, hidden),
        open: target,
      });
      return true;
    }
    if (o.reason === 'timeout') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '書けたかどうか確かめられませんでした(今日のノートを開いて確かめてください。字は欄に残してあります)',
      });
    } else if (o.error === null) {
      // 理由を立てずに断られた回(ノートが消えていた)── 黙って「足しました」にも「何も起きない」にもしない
      dispatcher.dispatch({ type: 'OP_FAILED', error: '今日のノートが見つかりません。もう一度押してください' });
    }
    return false;
  });
}
/**
 * 予定を足した直後の 1 行(#1163 の依頼 57-5 / 100-4)。どの字を、どのノートへ足したかを言う。
 * @param undated 日付なしで足した
 * @param hidden 日付なしで足し、かつ「日付のないもの」を出していない(= 足した予定が予定表に見えない)
 */
export function scheduleAddedNotice(text: string, noteTitle: string, undated: boolean, hidden: boolean): string {
  const shown = text.length > 24 ? `${text.slice(0, 23)}…` : text;
  return (
    `『${shown}』を今日のノート(${noteTitle})に${undated ? '日付なしで' : ''}足しました` +
    (hidden ? '(「出すもの」で「日付のないもの」を選ぶと見られます)' : '')
  );
}

/** 予定を足した書込の結末を待つ上限。他の呼び手(引用・AI の書き足し・章の欄)と同じ 10 秒。 */
const SCHEDULE_ADD_SETTLE_MS = 10000;

export function generateLid(): string {
  lidCounter += 1;
  return `${Date.now().toString(36)}-${lidCounter.toString(36).padStart(4, '0')}-${randomSuffix()}`;
}

/**
 * 🔴 **いまフォルダ面に出ている行**(着地前レビュー 2)。
 * ⚠ 規則は `filerRows` **1 か所**を通す ── 描く側(`render/filer.ts`)・
 * 範囲選択(reducer)・ここが別々に並びを組むと、**目で見たものと動くものが
 * 食い違う**(CLAUDE.md §7)。
 */
/**
 * 🔴 **付箋の窓を Escape で閉じてはいけない打ちかけが、画面に在るか**(#1087)。
 * 追記欄に打った字(どの欄でも。焦点が外れていても)か、章・コード枠の欄(`sectionDraft`)。
 * ⚠ 追記欄の字は欄そのものにしか無い(state に写らない)ので欄から読む。
 * 🔑 **窓を閉じる 2 つの口(追記欄の中の Escape / 欄の外の Escape)が同じ答えを引く** ── 片方にだけ
 *   門が在ると、焦点の置き場所で打ちかけが消える。
 */
export function noteWindowHasTyping(root: ParentNode, st: AppState): boolean {
  if (st.sectionDraft != null) return true;
  for (const el of root.querySelectorAll<HTMLTextAreaElement>('[data-pkc-field="append-input"]'))
    if (el.value !== '') return true;
  return false;
}

const visibleFilerRows = (st: AppState): EntryMeta[] =>
  filerRows(st.scopeLid, st.entryMetas, st.relations, filerRowOptions(st));

/**
 * 🔴 **左の列で消した直後の「消した位置」**(#1087)。表は消した後に焦点を表そのものへ置く(押していない行に枠を出さない)
 * ので、行送り(`rowAt`)は焦点の行から数えられない。root ごとに 1 件だけ覚え、次の行送りで使い切る。
 */
const deletedGap = new WeakMap<HTMLElement, { scope: string | null; count: number; index: number }>();

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
/** 長押しを受ける行(#687 D-1)。⚠ `long-press.ts` の `LONG_PRESS_TARGET` と同じ綴り。 */
const LONG_PRESS_ROW = LONG_PRESS_TARGET;
const dualSide = (target: HTMLElement): DualSide | null => {
  const raw = target.closest('[data-pkc-side]')?.getAttribute('data-pkc-side');
  return raw === 'left' || raw === 'right' ? raw : null;
};

/**
 * 🔴 **そのペインに出ている行 ── 引く口はここ 1 つ**(#273 残件)。
 *
 * ⚠ 直す前は**同じ式が 6 か所**に書き写されていた(写す / 移す / ゴミ箱 / 落とす /
 *   鍵の行送り / 描く側)。ペインごとの絞り込みを足したとき、**1 か所でも
 *   書き換え忘れると、そこだけ別の並びで数える** ── 症状は「目で見た範囲と
 *   選ばれる範囲が違う」という、いちばん気づけない形になる(CLAUDE.md §7)。
 * 🔑 絞り込みの規則そのものは `paneFilterOptions`(features 層)が持つ ──
 *   reducer も描く側も**同じ関数**を通る。
 */
const dualPaneRows = (st: AppState, side: DualSide): EntryMeta[] => {
  const pane = paneOf(st.dual, side);
  return filerRows(paneScope(pane), st.entryMetas, st.relations, {
    smartLids: smartLidsOf(paneScope(pane), st.smartHits),
    ...paneFilterOptions(pane, st.filterQuery, st.searchHits),
    ...dualListViewOptions(st),
    // ⚠ 2 ペインは「中まで全部出す」(左の列の入り切り)を**持たない**(#813 段②)
    flatten: false,
  });
};

/**
 * 🔴 **消した / 移した後も、カーソルを「その場所に来た行」に残す**(#1087。実ブラウザ smoke で判明)。
 *
 * ⚠ 直す前は `pruneDual` がカーソルを `null` に落とすだけで、消した直後は印が画面に 1 つも無く、
 *   最初の ↓ が先頭付近に現れていた(続けて消す・続けて下りる動線が途切れる)。
 * 🔑 規則は左の列と**同じ**: 消えた行が居た位置(同じ番号。末尾なら新しい末尾)の行を選ぶ
 *   (`removeEntryFromState` の後継選び = `after[min(vIdx, after.length - 1)]`)。
 * ⚠ カーソルの行が**まだ見えているなら何もしない**(印の行だけを消した場合)/ 行が 0 件なら立てる先が無い。
 * 呼び側は操作の**前**の行とカーソルを渡す。立てた lid を返す(焦点を連れて行く呼び側用)。
 */
const keepDualCursorAfter = (
  dispatcher: Dispatcher,
  side: DualSide,
  rowsBefore: readonly EntryMeta[],
  cursorBefore: string | null,
): string | null => {
  if (cursorBefore === null) return null;
  const i = rowsBefore.findIndex((m) => m.lid === cursorBefore);
  if (i < 0) return null;
  const rows = dualPaneRows(dispatcher.getState(), side);
  if (rows.length === 0 || rows.some((m) => m.lid === cursorBefore)) return null;
  const lid = rows[Math.min(i, rows.length - 1)]?.lid ?? null;
  if (lid === null) return null;
  dispatcher.dispatch({ type: 'DUAL_SET_CURSOR', side, lid });
  return lid;
};

/**
 * 🔴 **消した後の「カーソルを立てる」を、操作を押した後に動いた分を踏まない形にする**(#1087 D10)。
 *
 * ⚠ ゴミ箱へ移すのは**非同期になりうる**(別のタブの編集を確かめる間)。押した時点のカーソルを
 *   そのまま基準にすると、待っている間に user が `↑↓` で動かした先を**上書き**する。
 * 🔑 いまのカーソルが押した時点と違い、かつ**まだ画面に居る行**なら、user が動かした先なので触らない。
 *   戻り値は `keepDualCursorAfter` と同じ(立てた lid / 立てなかったら `null`)。
 */
const keepDualCursorUnlessMoved = (
  dispatcher: Dispatcher,
  side: DualSide,
  rowsBefore: readonly EntryMeta[],
  cursorBefore: string | null,
): string | null => {
  const now = paneOf(dispatcher.getState().dual, side).cursor;
  if (
    now !== null &&
    now !== cursorBefore &&
    dualPaneRows(dispatcher.getState(), side).some((m) => m.lid === now)
  )
    return null;
  return keepDualCursorAfter(dispatcher, side, rowsBefore, cursorBefore);
};

/**
 * 🔴 **名前を打ち替える相手 ── 鍵(`F2`)と「名前」ボタンで決め方を分けない**(#1087 D7)。
 *
 * ⚠ 直す前は `F2` がカーソルの行を、ボタンが印を先に見ていた。印を 3 件付けてカーソルが印の外に
 *   ある状態で `F2` を押すと、**印の無い行**の名前が打てた(ボタンは「1 件だけ」と断る)。
 * 🔑 印が優先(印があればカーソルは見ない)。印が無ければカーソルの行。1 件に決まらなければ理由を返す。
 */
const dualRenameTarget = (
  st: AppState,
  side: DualSide,
): { lid: string } | { error: string } => {
  const pane = paneOf(st.dual, side);
  const marked = pane.selection.length > 0 ? pane.selection : pane.cursor !== null ? [pane.cursor] : [];
  // ⚠ **1 件のときだけ** ── まとめて改名は「同じ名前が並ぶ」だけで意味が無い
  if (marked.length === 0) return { error: '名前を変えるものを選んでください(行を押すと選べます)' };
  if (marked.length > 1) return { error: '名前を変えられるのは 1 件だけです' };
  return { lid: marked[0]! };
};

/**
 * 🔴 **そのペインに出ている行を全部選ぶ ── Ctrl+A と列見出しのチェックの実体は 1 本**(Gemini 裁定 = #1163 への依頼 62)。
 * ⚠ 範囲は「見えている並び」の先頭から末尾(絞り込みで消えた行は入らない)。行が 0 件なら何も起きないので `false`。
 */
const dualSelectAll = (dispatcher: Dispatcher, side: DualSide): boolean => {
  const rows = dualPaneRows(dispatcher.getState(), side);
  const first = rows[0]?.lid;
  const last = rows[rows.length - 1]?.lid;
  if (first === undefined || last === undefined) return false;
  dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid: first, mode: 'set' });
  if (last !== first) dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid: last, mode: 'range' });
  return true;
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
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}${what}を作ってください` });
    return;
  }
  // 🔴 スマートフォルダの中には作れない(reducer は黙ってルートに作る ── 押したペインと違う所に出る)
  const refusedPlace = notPlaceable(
    st,
    paneScope(paneOf(st.dual, side)),
    'フォルダかルートを開いてから押してください',
  );
  if (refusedPlace !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: refusedPlace });
    return;
  }
  /**
   * 🔴 **そのペインの名前の絞りを先に解く**(#1087)。`CREATE_ENTRY` が解くのは左の列の絞りだけで、
   *   ペイン自身の「名前で絞る」に語が入っていると、作った物は既定の題名が語に当たらず**そのペインに出ない**
   *   (何も言われない)。解くのは `dual-bookmark-open` と同じ 1 本(`DUAL_SET_FILTER ''`)。
   */
  dispatcher.dispatch({ type: 'DUAL_SET_FILTER', side, filter: '' });
  const lid = generateLid();
  dispatcher.dispatch({
    type: 'CREATE_ENTRY',
    archetype,
    lid,
    title: `新しい${what}`,
    parentLid: paneScope(paneOf(st.dual, side)),
    relationId: generateLid(),
    edit: false,
  });
  /**
   * 🔴 **作った行にカーソルと印を付ける**(台帳 #1852 N1 / 依頼 326 A。Gemini 回答 = 推薦どおり)。
   * ⚠ 直す前は作った物が一覧に出るだけで、印もカーソルも付かず、すぐ名前を変えたり移したりするには探して押し直す必要があった。
   * ⚠ 名前の打ち替えまでは入らない(続けて何件も作るときに邪魔になる)。作れなかった回(編集中など)は選ばない。
   */
  if (dispatcher.getState().entryMetas.has(lid))
    dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid, mode: 'set' });
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

/**
 * ゴミ箱へ移したフォルダの中に居て、**親を失ってルートに出た**ノートの数(#1087 の見直し 2026-10-13)。
 * ⚠ 別のフォルダにも入っていたノートはそちらに残るので数えない(「ルートに出た」だけを言う)。
 */
const leftAtRoot = (before: AppState, after: AppState): number => {
  const was = resolveCanonicalParents(before.entryMetas, before.relations);
  const now = resolveCanonicalParents(after.entryMetas, after.relations);
  let n = 0;
  for (const [child, parent] of was) {
    if (after.entryMetas.has(parent) || !after.entryMetas.has(child)) continue;
    if (!now.has(child)) n += 1;
  }
  return n;
};

/**
 * 🔴 **スマートフォルダへ落としてタグを付けたあと、集まらなかったノートがあれば言う**(台帳 #1852 N1 / 依頼 325 A。Gemini 回答 = 推薦どおり)。
 *
 * ⚠ 直す前は、条件が「タグ」だけでなく「種類」「語」「日付」「チェック項目」も持つスマートフォルダへ落とすと、タグは付くのに
 *   ほかの条件を満たさなければ集まらず、知らせは「付けました」だけだった。タグを付けることには意味があるので断らず、出ない理由だけを伝える。
 * 🔑 集め直しの結果(`SMART_SCANNED`)が届いてから数える ── 条件がタグだけなら必ず集まるので何も言わない(`needsRescan` が偽)。
 *   前に集めた結果が無い(一度も開いていない)ときは条件が分からないので言わない。上限で切れた一覧は「無い」と言い切れないので言わない。
 * ⚠ 結果が届かないときは何も言わず、購読を捨てる(`SMART_DROP_WATCH_MS`)。
 */
const SMART_DROP_WATCH_MS = 15_000;
export const watchSmartDrop = (dispatcher: Dispatcher, smartLid: string, lids: readonly string[]): void => {
  const prev = dispatcher.getState().smartHits.get(smartLid);
  if (prev === undefined || prev.failed || !needsRescan(prev.spec)) return;
  let off: (() => void) | null = null;
  const timer = setTimeout(() => off?.(), SMART_DROP_WATCH_MS);
  off = dispatcher.onState((st) => {
    const hit = st.smartHits.get(smartLid);
    if (hit === undefined || hit === prev) return;
    off?.();
    clearTimeout(timer);
    if (hit.failed || hit.total > hit.lids.length) return;
    const inside = new Set(hit.lids);
    const out = lids.filter((l) => st.entryMetas.has(l) && !inside.has(l)).length;
    if (out > 0)
      dispatcher.dispatch({
        type: 'OP_NOTICE',
        message: `${String(out)} 件はほかの条件に合わないので、ここには出ません(タグは付けました)`,
      });
  });
};

/**
 * 🔴 **移したフォルダを 2 ペインのどちらかが見ていたとき、その行き先を言う字**(台帳 #1852 G1 / 依頼 228)。見ていなければ空。
 * ⚠ 行き先は reducer が決めて既に載せている(`pruneDual`)── ここは**同じ一文**を、ゴミ箱の知らせへ載せ直すだけ。
 */
const dualFellBackText = (before: AppState, after: AppState): string => {
  const fell = scopeFellBack(before.dual, after.dual, (l) => after.entryMetas.has(l), (l) => after.entryMetas.get(l)?.title);
  return fell === undefined ? '' : scopeFallbackNote(fell.parentTitle);
};

/**
 * ゴミ箱へ移したノートへリンクを張っていた、ほかのノートの数(字)。⚠ 参照元は選んでいるノートの分しか引いていない
 * (`state.backlinks`)── 引けていなければ空(言わない)。打ち切られていたら「N 件以上」。
 */
const linkedFromText = (before: AppState, after: AppState, lid: string): string => {
  const back = before.backlinks;
  // 🔴 まだ調べ終えていない(選んだ直後)なら、待たせずに「かもしれません」と言う(台帳 #1852 G1 / 依頼 231 A)
  if (!back || back.lid !== lid) return LINKED_FROM_MAYBE;
  const n = back.lids.filter((l) => l !== lid && after.entryMetas.has(l)).length;
  if (n === 0) return '';
  return back.truncated ? `${String(n)} 件以上` : `${String(n)} 件`;
};

/**
 * 反対側が開いている場所に、物を入れられないときの理由(入れられるなら `null`)。
 * 🔴 **スマートフォルダの中には入れられない**(#1087 の見直し 2026-10-13)── reducer は親がフォルダでないと黙ってルートへ落とすので、
 *   コピーはルートに入るのに「「スマートフォルダ名」へコピーしました」と言い、移すは「フォルダは自分の中へは入れられません」という
 *   違う理由で断っていた。押す前に、本当の理由で断る。
 */
const notPlaceable = (
  st: AppState,
  scope: string | null,
  hint = '反対側でフォルダかルートを開いてから押してください',
): string | null => {
  if (scope === null) return null;
  const meta = st.entryMetas.get(scope);
  if (meta?.archetype !== SMART_ARCHETYPE) return null;
  return `スマートフォルダの中には入れられません。${hint}`;
};

/**
 * 🔴 **選んだ物のうち、祖先も選ばれている物は動かさない**(#1087)── 祖先と一緒に付いていく。
 * ⚠ 語や種類で絞ると一覧は階層をまたいで平らに並ぶので、親フォルダ F とその中の D を両方選べる。
 *   1 件ずつ移すと D だけが行き先の直下へ出て、F は空になる(複製の `planCopy` が既に持つ
 *   「同じ組に祖先が居れば付いていく」と同じ向き)。祖先は親を辿って**どこまででも**見る
 *   (間に選ばれていない物が挟まっていても付いていく)。
 */
const withoutSelectedDescendants = (st: AppState, lids: readonly string[]): string[] => {
  const parentOf = resolveCanonicalParents(st.entryMetas, st.relations);
  const picked = new Set(lids);
  return lids.filter((lid) => {
    const seen = new Set<string>([lid]);
    let up = parentOf.get(lid);
    while (up !== undefined && !seen.has(up)) {
      if (picked.has(up)) return false;
      seen.add(up);
      up = parentOf.get(up);
    }
    return true;
  });
};

const moveEntries = (
  dispatcher: Dispatcher,
  allLids: readonly string[],
  parentLid: string | null,
  report?: (text: string) => void,
): void => {
  if (allLids.length === 0) return;
  // ⚠ 数えるのは**実際に動かす物**だけ(付いていく物は数えない ── 知らせの件数と画面が合う)
  const lids = withoutSelectedDescendants(dispatcher.getState(), allLids);
  const phase = dispatcher.getState().phase;
  if (phase !== 'ready') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(phase)}動かしてください` });
    return;
  }
  // 🔴 入れられない行き先かの判定は `notPlaceable` 1 本 ── 入口(2 ペインの背景・パンくず・移す・
  //   メニュー)のどこから来ても、ここで同じ理由で断る(下の「自分の中へは入れられません」と取り違えない)
  const refusedPlace = notPlaceable(dispatcher.getState(), parentLid);
  if (refusedPlace !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: refusedPlace });
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
    if (dispatcher.getState().relations !== before) {
      moved += 1;
      /**
       * 🔴 **移したノートは、移し先の末尾に並べる**(台帳 #1852 N1 / 依頼 154 ②。Gemini 回答 = 推薦どおり)。
       * ⚠ 直す前は移したノートが、作った順番に応じた**途中の位置**に入り、たくさんのノートに紛れてどこに入ったか分からないことがあった。
       *   パソコンのファイル画面で移したときと同じ感覚にする。移し先の末尾 = 全体の末尾(並びの値は全体で 1 本)。
       */
      dispatcher.dispatch({ type: 'SET_ENTRY_ORDER', lid, entryOrder: 'end' });
    }
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
  /**
   * 🔴 **1 件も動いていないなら「入れました」と言わない**(#1087 の見直し 2026-10-13)── 同じフォルダへ
   *   落とし直しても「1 件を入れました」と出て、何も動いていないのに動いたと言っていた。
   * ⚠ 1 件でも動いた回は、既に居た分も数える(押した数と合わせる ── 下の件数の決まりはそのまま)。
   */
  if (moved === 0) {
    report?.(`すでに「${where}」に入っています`);
    return;
  }
  /**
   * 🔴 **フォルダを移したときは、中の件数も言う**(依頼 85-8。Gemini 裁定 = 推薦 C)。
   * ⚠ 直す前は、中に 40 件あるフォルダでも「1 件を『○○』へ入れました」だった(コピーは「中身を含め N 件」と言っている)。
   * 🔑 数えるのは**動かした物自身の配下**(移しても配下の数は変わらない ── 行き先の中身は足さない)。
   * 🔴 押したボタンの言葉(「移す」)で結果を返す(台帳 #1852 N1 / 依頼 51-4 A。直す前は「入れました」)。
   */
  const st0 = dispatcher.getState();
  const parentsNow = resolveCanonicalParents(st0.entryMetas, st0.relations);
  let inside = 0;
  for (const lid of lids) {
    // ⚠ 数えるのは**行き先に入った物**だけ(断られた物の中身まで足すと、知らせと断りが食い違う)
    if ((parentsNow.get(lid) ?? null) !== parentLid) continue;
    inside += Math.max(0, collectSubtreeLids(lid, st0.entryMetas, st0.relations).size - 1);
  }
  const total = moved + same;
  if (inside > 0 && lids.length === 1) {
    const only = st0.entryMetas.get(lids[0]!)?.title ?? 'フォルダ';
    report?.(`「${only}」(中の ${inside} 件ごと)を「${where}」へ移しました`);
    return;
  }
  report?.(
    inside > 0
      ? `${total} 件(中身を含め ${total + inside} 件)を「${where}」へ移しました`
      : `${total} 件を「${where}」へ移しました`,
  );
};

/**
 * 🔴 **移して、動いた物があれば「元に戻す」を出す ── 移す口 4 つ(F6 / ドラッグ / 「移す…」の選択窓 / 帯)の実体は 1 本**(#1087)。
 *
 * ⚠ 直す前は F6(`dual-move`)だけが「元に戻す」を出し、ドラッグで落としても「移す…」で選んでも出なかった ──
 *   同じ「移す」なのに戻せる口が口によって違った(§7「片側にだけ作法が在る」)。
 * 🔑 新しい仕組みは作らない: 動く前の親を控え、動いた物だけ `offerDualMoveUndo` に渡す。戻す条件
 *   (いまの親が移した先の物だけ戻す)は `undo-dual-move` がそのまま持つ。
 * 動いた回だけ `true` を返す(呼び側が「動いた回だけ印を外す」に使う)。
 */
const moveEntriesOfferingUndo = (
  dispatcher: Dispatcher,
  lids: readonly string[],
  parentLid: string | null,
  report?: (text: string) => void,
): boolean => {
  const st = dispatcher.getState();
  const before = st.relations;
  const parentsBefore = resolveCanonicalParents(st.entryMetas, st.relations);
  // 🔴 移す前の並びの値(依頼 154 ②)── 「元に戻す」が移す前の位置へ戻す(移したノートは移し先の末尾へ行くので)
  const orderBefore = new Map<string, number>();
  for (const lid of lids) {
    const o = st.entryMetas.get(lid)?.entryOrder;
    if (o !== undefined) orderBefore.set(lid, o);
  }
  // 🔴 入っていたフォルダ全部(依頼 227 A)── 正準親 1 つだけを控えると、戻したとき片方のフォルダにしか戻らない
  const allBefore = new Map<string, string[]>();
  for (const r of st.relations) {
    if (r.kind !== STRUCTURAL || r.fromLid === r.toLid) continue;
    if (st.entryMetas.get(r.fromLid)?.archetype !== 'folder') continue;
    const l = allBefore.get(r.toLid);
    if (l) l.push(r.fromLid);
    else allBefore.set(r.toLid, [r.fromLid]);
  }
  let said = '';
  moveEntries(dispatcher, lids, parentLid, (text) => {
    said = text;
  });
  if (dispatcher.getState().relations === before) {
    if (said !== '') report?.(said);
    return false;
  }
  const parentsAfter = resolveCanonicalParents(
    dispatcher.getState().entryMetas,
    dispatcher.getState().relations,
  );
  const moves = lids
    .filter((lid) => (parentsBefore.get(lid) ?? null) !== (parentsAfter.get(lid) ?? null))
    .map((lid) => ({
      lid,
      from: parentsBefore.get(lid) ?? null,
      to: parentsAfter.get(lid) ?? null,
      ...(orderBefore.has(lid) ? { entryOrder: orderBefore.get(lid)! } : {}),
      ...((allBefore.get(lid)?.length ?? 0) > 1 ? { fromAll: allBefore.get(lid)! } : {}),
    }));
  if (moves.length > 0 && said !== '') offerDualMoveUndo(dispatcher, moves, said);
  else if (said !== '') report?.(said);
  return true;
};

/**
 * 🔴 **作って、そのまま編集に入る ── 実体は 1 本**(#215)。
 *
 * ⚠ `create-entry`(左の列の「+ ノート」)と `create-in-folder`(行の右クリック)が
 *   **同じ経路**を通る ── 別々に書くと、面の切替・編集権の取り方が片方だけ古くなる(§7)。
 * ⚠ 非 detail view で作ると editor が出ない(PKC2 PR-Δ19 の罠)── 先に切替。
 * ⚠ #177: 作成 → 即編集の編集権。lid は今生まれたばかりなので必ず取れる ──
 *   「取れてから入る」順に直すと user gesture の同期性を失うだけで守るものが無い。
 *   別タブは 'changed' でこの lid を知るため、登録が先に着けばよい。
 */
/**
 * 🔴 **作った直後に「そのまま打てる」種類は、編集の面へ落とさない**(#753、2026-09-08)。
 *
 * ⚠ 表は `CREATE_ENTRY` の既定どおり**編集の面**(ライブエディタ)で開いていた ──
 *   ところが**升を押せる印を焼いているのは読む面だけ**(`detail.ts` の
 *   `interactiveCells: true` はそこにしか渡っていない)なので、
 *   **升を押すと原文の欄に化けた**。
 * 🔴 つまり #418 が無くそうとした「**カンマを目で数える画面**」が、
 *   表を作った直後だけ戻ってきていた。⚠ しかもマニュアルは
 *   「**そのままセルから打てます**」と書いていたので、**約束のほうが嘘**だった。
 *
 * 🔑 直しは「読む面で開く」1 つ ── 保存を 1 回はさむ必要が消える。
 * ⚠ **ほかの種類は変えない**(ノート / ログ / 雛形 / Todo は、作ったら本文を
 *   打つのが仕事なので編集の面が正しい)── 表だけが「**器が先にできていて、
 *   中を埋める**」形である。
 * ⚠ 名前を直したいときは、これまでどおり「編集」か題名の欄から入れる。
 */
const OPENS_READABLE: readonly string[] = ['spreadsheet'];

/**
 * 🔴 **いま居るフォルダの名前を変えるとき、打ち終わったら元のフォルダの中へ戻る**(依頼 85-5。Gemini 裁定 = 推薦 C)。
 *
 * > 画面の物語:F2・右クリック・右のペインのどれで名前を変えても、左の一覧が 1 つ上の階層へ移り(名前の欄は親の中の行にしか出ない)、
 * > 打ち終わっても上の階層にいたままだった。戻る手間が増えていた。
 *
 * ⚠ 覚えるのは**「名前を変えたフォルダ」と「押す前にいた階層」だけ**(欄を出すために上へ移した回だけ)。
 *   戻すのは、いまの階層が**移した先のまま**のときだけ ── 打っている間に user が別の所へ入っていたら動かさない。
 */
let rowRenameReturn: { readonly lid: string; readonly parent: string | null } | null = null;

/** 左の列の行の名前の打ち替えを終える。⚠ 確定・やめる・他所を押した、の 3 つが全部ここを通る(戻る道を 1 本にする)。 */
const endRowRename = (dispatcher: Dispatcher): void => {
  dispatcher.dispatch({ type: 'ROW_RENAME_END' });
  const back = rowRenameReturn;
  rowRenameReturn = null;
  if (back === null) return;
  const st = dispatcher.getState();
  if (st.scopeLid === back.parent && st.entryMetas.has(back.lid))
    dispatcher.dispatch({ type: 'SET_SCOPE', lid: back.lid });
};

const createAndEdit = (
  dispatcher: Dispatcher,
  services: BinderServices,
  archetype: string,
  parentLid: string | null,
  /** 🔴 テンプレートから作るときの本文(#1645)。省略 = 種類の既定の本文。 */
  body?: string,
): void => {
  /**
   * 🔴 **スマートフォルダの中には作れない ── 作る前に断る**(依頼 338。Gemini 回答 = A)。
   * ⚠ 直す前は reducer が黙ってルートに作り、中央は編集に入るのに、左の一覧には出なかった
   *   (画面の下に「ルートに作りました」と出るだけ)。2 ペインは作る前に断っていた(`dualCreate`)── 同じ操作に
   *   2 つの場所で違う答えを返さない。
   */
  if (
    parentLid !== null &&
    dispatcher.getState().entryMetas.get(parentLid)?.archetype === SMART_ARCHETYPE
  ) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: 'スマートフォルダの中には作れません。ルートか、ふつうのフォルダを開いてください',
    });
    return;
  }
  if (dispatcher.getState().viewMode !== 'detail')
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
  const lid = generateLid();
  dispatcher.dispatch({
    type: 'CREATE_ENTRY',
    archetype,
    lid,
    title: defaultTitle(dispatcher, archetype),
    parentLid,
    relationId: generateLid(),
    ...(body !== undefined ? { body } : {}),
    ...(OPENS_READABLE.includes(archetype) || archetype === SMART_ARCHETYPE ? { edit: false } : {}),
  });
  /**
   * 🔴 **スマートフォルダを作ったら、そのまま中に入る**(依頼 85-4。Gemini 裁定 = 推薦 C)。
   *
   * > 画面の物語:作るといきなり編集画面になり条件の行が見えるが、**条件を入れるバーは保存してから中に入らないと出なかった**。
   * > 作った人がしたいのは条件を入れることで、バーは中にしか無い。
   *
   * ⚠ 編集には入らない(読む画面で開く ── 表と同じ)。入れたのは**作れたときだけ**(断られたのに場所だけ変わらない)。
   */
  if (archetype === SMART_ARCHETYPE && dispatcher.getState().entryMetas.has(lid))
    dispatcher.dispatch({ type: 'SET_SCOPE', lid });
  if (dispatcher.getState().phase === 'editing') void services.acquireEditLock?.(lid);
};

/**
 * 🔴 **その帯の「押せる全操作」を、画面から拾って一覧にする**(#1054 段②)。
 *
 * ⚠ **表を 2 つ持たない**(§7) ── 名前(`[data-pkc-field='label' / 'cmd-label']`)
 *   と図案(`data-pkc-symbol`)は、いま画面に出ている物をそのまま読む。
 *   3 つの帯(作る / ノート全体 / 2 ペインの操作)を 1 つの関数で受けられるのは
 *   このためである(帯ごとに書き分けない)。
 * ⚠ **押せない物は載せない**(`disabled`)── 長押しメニューに dead click を増やさない。
 * 🔑 `data-pkc-view` / `data-pkc-archetype` のような**受け手が読み直す値**は
 *   `attrs` へそのまま写す(`data-pkc-action` / `data-pkc-bar-tile` / `data-pkc-field`
 *   の 3 つは除く ── 前者 2 つは別の場所で読み、`data-pkc-field` は写すと
 *   「その面に 1 つだけ」を前提にした `querySelector` が長押しメニュー側を拾いうる)。
 */
function barTileMenuItems(bar: Element, selector = `[${BAR_TILE_ATTR}]`): MenuItem[] {
  const items: MenuItem[] = [];
  for (const tile of bar.querySelectorAll<HTMLButtonElement>(selector)) {
    if (tile.disabled) continue;
    const action = tile.getAttribute('data-pkc-action');
    if (action === null || action === '') continue;
    const label = (
      tile.querySelector('[data-pkc-field="label"], [data-pkc-field="cmd-label"]')?.textContent ??
      ''
    ).trim();
    if (label === '') continue;
    const iconAttr = tile.querySelector('[data-pkc-icon]')?.getAttribute('data-pkc-symbol') ?? null;
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(tile.attributes)) {
      if (!attr.name.startsWith('data-pkc-')) continue;
      if (attr.name === 'data-pkc-action' || attr.name === BAR_TILE_ATTR || attr.name === 'data-pkc-field')
        continue;
      // 🔴 畳みの印(#1621)を写すと、メニューの項目まで `display: none` になる
      if (attr.name === OVERFLOW_ATTR) continue;
      attrs[attr.name] = attr.value;
    }
    items.push({
      action,
      label,
      ...(iconAttr !== null && isIconName(iconAttr) ? { icon: iconAttr } : {}),
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    });
  }
  return items;
}

/**
 * 押した物の行の lid。
 *
 * 🔴 **優先順位は 3 段**(#877)。
 *   ① **メニューを開いた瞬間の lid**(`MENU_LID_ATTR` の carry)
 *   ② 押した物が行の中に居れば、その行の lid(情報ペインのボタン等)
 *   ③ 無ければ**いま選んでいるノート**
 *
 * ⚠ ②だけでは足りない ── 行のメニューのボタンは**行の中に居ない**(器は root
 *   直下)。だから直す前は③(`selectedLid` が押した行だと仮定)に頼っていたが、
 *   メニューが開いたまま `Alt+←`(`contexts: ['global']` ── メニューの有無を
 *   見ない)を押すと `selectedLid` が**別のノートへ動く**。行のメニューは
 *   `openContextMenu` の carry へ①を焼くことで、この動きに引きずられなくなる
 *   (`open-note-window` の `MENU_PREV_LID_ATTR` と同じ「開いた瞬間を運ぶ」作法)。
 * ⚠ ①を持たない呼び手(情報ペインのボタン・鍵)は②③のまま ── `runFilerKey` は
 *   焦点の行を target として渡すので②で取れる。
 */
const rowLidOrSelected = (st: AppState, target: HTMLElement): string | null =>
  // ⚠ ①は `??` ではなく **`||`** ── 本文のメニューは `[MENU_LID_ATTR]: ob?.lid ?? ''`
  //   を運ぶので、**空文字**が来ることがある(`??` だとそれを lid として通してしまう
  //   ── `''` を受けた先は「無言で何もしない」か、`entryMetas.get('')` で undefined に
  //   なる。どちらも §「無言の dead click」)。同じ理由で `adopt-link-icon`(下の方)も
  //   既に `||` で読んでいる ── **読み方をそちらへ揃える**。
  target.getAttribute(MENU_LID_ATTR) ||
  target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ||
  st.selectedLid;

/** UI サービス面(storage 依存の操作は main が実体を注入。test は fake)。 */
/**
 * 🔴 **別の窓で開いた書庫の一覧**(#826)。
 * ⚠ **掴んだ直後の窓**であって、まだ中身は入っていない ── `pick` で組む。
 */
export interface ArchiveWindowHandle {
  /**
   * 🔴 **もう同じ書庫の一覧が組んである**(#826 の着地前レビュー)。
   * ⚠ そのときは**組み直さない** ── user が 2 回目を押す動機は「窓が後ろに隠れて
   *   見つからない」であって、選び直したいわけではない(印が消えると選び直しになる)。
   */
  readonly reused: boolean;
  /** 一覧を組んで、選ばれるまで待つ。⚠ 「やめる」/ 窓を閉じた / 0 件なら `null`。 */
  pick(deps: {
    readonly rows: readonly ArchivePickRow[];
    readonly countFiles: (marks: readonly string[]) => number;
    readonly toggle: (marks: readonly string[], path: string) => string[];
  }): Promise<string[] | null>;
  /**
   * 🔴 **読めなかった理由を窓の中に出す**(閉じない)。⚠ user は**開いた窓を見ている**
   *   ので、黙って閉じると「窓が壊れた」と読む。閉じるのは user に任せる。
   */
  fail(text: string): void;
}

export interface BinderServices {
  /**
   * ⚠ `why` は**文頭に付ける事情** ── 取込の知らせと**同じ 1 行**に載る。
   * 🔴 呼び側が別の `OP_FAILED` で言うと **`CREATE_ENTRY` が `error: null` を書いて
   *   消す**(#666 の着地前レビュー 1)。
   */
  /**
   * @param at 🔴 **落とした所**(#684 段④)── 読む面の本文へ落とした回だけ渡す。
   *   省略 = これまでどおり本文のいちばん下。
   */
  attachFiles?(files: File[], why?: string, at?: DroppedAt, intoLid?: string | null): void;
  /**
   * 🔴 添付のファイルを、選んだファイルの中身に差し替える(#1163 依頼 212)。同じファイルを指す添付がほかにあれば、
   * 差し替える前に確かめる(依頼 211・293)。⚠ 判断は `main.ts` の 1 本の道(Office の保存と同じ)。
   */
  replaceAttachmentFile?(lid: string, file: File): void;
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
   * ⚠ **省略可** ── 無い環境(test の fake / 旧い配線)では「この版ではコピーできません」と
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
   * 🔴 **本文に入れた添付のリンクを押したとき**(#1163 依頼 55 の 1・2。Gemini の裁定 = 推薦どおり)。
   *
   * ⚠ PDF なら、保存せずに**別のウィンドウで開く**(保存は開いたウィンドウか添付のノートの画面から)。それ以外は今までどおり保存。
   *   保存するときの名前は**リンクの字ではなく、添付のいまの名前**(名前を変えても本文のリンクの字は変えない)。
   * ⚠ **省略可** ── 無い配線では、今までどおり `downloadAsset` へ落ちる。
   * @param label リンクの字(添付のいまの名前が引けなかったときの代わり)
   */
  openAssetLink?(assetKey: string, label: string, lid?: string): void;
  /**
   * 🔴 **添付の実体を 1 件読む**(#818)。⚠ **省略可** ── 無い配線では
   *   「この版では中を見られません」と断るだけで、他は壊れない
   *   (`downloadAsset` と同じ規律)。
   * @returns 実体。⚠ 無ければ `null`(消えた添付を掴んだまま進まない)
   */
  readAssetBlob?(assetKey: string): Promise<Blob | null>;
  /**
   * 🔴 **録音・画面収録**(#413。user 要望 2026-07-16「録音と画面収録を…
   * これで、会議メモをうまく残せるはず」)。
   *
   * ⚠ **省略可** ── 無い配線では「この版では収録できません」と断るだけで、
   *   他は壊れない(`readBodies` と同じ規律)。
   * ⚠ 断る / 知らせるのは**受け側の仕事**(ここは撃つだけ)── binder は
   *   `data-pkc-action` を UserAction に変えるだけで、段取りは持たない。
   */
  startCapture?(kind: 'audio' | 'screen'): void;
  stopCapture?(): void;
  discardCapture?(): void;
  /**
   * 🔴 **録った音の前後を削る**(#683 段②a。user 裁定 2026-09-14)。
   *
   * ⚠ **省略可** ── 無い配線では「この版では切り出せません」と断るだけで、
   *   他は壊れない(収録と同じ規律)。
   * ⚠ 元は**上書きしない** ── 新しい添付が 1 件増える(裁定)。
   */
  trimCapture?(lid: string, startMs: number, endMs: number): void;
  /**
   * 🔴 **録った音を文字にする**(#772 段②。裁定 2026-10-01 = 端末の中だけ / 「音/動画」の行に 1 つ /
   * そのノートの本文の末尾に追記)。⚠ **省略可**(無い配線では「この版では文字にできません」と断る)。
   * ⚠ 段取りは `capture-transcribe.ts` が持つ ── binder は押した行の lid を渡すだけ。
   */
  transcribeCapture?(lid: string): void;
  /**
   * 🔴 **動画から音だけ / 絵だけを取り出す**(#952 A1。裁定済み = 元の添付は残す)。
   * ⚠ **省略可**(無い配線では「このタブの PKC3 が古いままのため…」と断る)。段取りは `capture-extract.ts` が持つ。
   */
  extractCapture?(lid: string, part: 'audio' | 'picture'): void;
  /**
   * 🔴 **音声認識の部品を入れる / 途中でやめる / 消す**(#772 段②)。
   * ⚠ **勝手に取りに行かない** ── 押した人にだけ取らせる(Office 一式と同じ作法)。
   * ⚠ 判断も文言も `AsrPackInstaller` が持つ(投げてこない)。
   */
  installAsrPart?(id: string): void;
  cancelAsrInstall?(): void;
  removeAsrPart?(id: string): void;
  /**
   * 🔴 **タイマー**(#279。user 指示 2026-08-19「…タイマー…は組み込みアプリで
   * リリースしたい」)。⚠ **省略可**(収録と同じ規律)。
   * ⚠ 止める / 捨てるは**どの計測か**を渡す ── 複数同時に走るので、
   *   「いま走っているもの」では決まらない。
   */
  startTimer?(): void;
  stopTimer?(lid: string): void;
  discardTimer?(lid: string): void;
  /**
   * 🔴 **アラート**(#280)。⚠ **省略可**(収録・タイマーと同じ規律)。
   * ⚠ 片付けるのは**どの知らせか**を渡す(複数同時に鳴りうる)。
   */
  dismissAlarm?(key: string): void;
  /** 🔴 予定の知らせを入 / 切にする(#280)。⚠ 入にした瞬間に予定を数え直す。 */
  setAlarmEnabled?(on: boolean): void;
  /**
   * 🔴 **聞くときだけ音を整えるか**(#772 段① B)。⚠ **省略可**。
   * ⚠ 切り替えたら**いま画面に在る再生機も**その場で繋ぎ替える ──
   *   保存しただけでは、開いているノートの音は変わらない(設定が嘘になる)。
   */
  setVoiceBoost?(on: boolean): void;
  /** 🔴 「音量をそろえる」(#952 B2)。⚠ 切り替えたら、いまの再生機もその場で繋ぎ替える。 */
  setVoiceLevel?(on: boolean): void;
  /** 🔴 「頭の中で鳴る感じを和らげる」(#952 B3)。⚠ 同じく、その場で繋ぎ替える。 */
  setVoiceCrossfeed?(on: boolean): void;
  /**
   * 🔴 **本文の素の電話番号を押せる字にするか**(#278 段②)。⚠ **省略可**。
   * ⚠ 切り替えたら**その場で本文を描き直す** ── 保存しただけでは、
   *   いま読んでいるノートは変わらない(設定が嘘になる)。
   */
  setPhoneLinks?(on: boolean): void;
  /**
   * 🔴 **本文の `@日付` を押せる字にするか**(#1169)。⚠ **省略可**。
   * ⚠ 切り替えたら**その場で本文を描き直す**(`setPhoneLinks` と同じ理由)。
   */
  setDateLinks?(on: boolean): void;
  /**
   * 🔴 **日付の右に「あとN日」を添えるか**(#1225)。⚠ **省略可**。
   * ⚠ 切り替えたら**その場で本文の添え字を付け直す / 外す**(保存だけでは、
   *   いま読んでいる本文が変わらない)。
   */
  setRelativeDays?(on: boolean): void;
  /**
   * 🔴 **本文の色コードの左に色の見本を出すか**(#1224)。⚠ **省略可**。
   * ⚠ 切り替えたら**その場で本文を描き直す**(見本は描くときに焼くので、保存だけでは
   *   いま読んでいるノートが変わらない)。
   */
  setColorSwatch?(on: boolean): void;
  /**
   * 🔴 **リンク先のノートが無いリンクを点線で見せるか**(#1174 段①)。⚠ **省略可**。
   * ⚠ 切り替えたら**その場で本文の印を付け直す / 外す**(保存しただけでは、
   *   いま読んでいるノートは変わらない = 設定が嘘になる)。
   */
  setMissingLinks?(on: boolean): void;
  /**
   * 🔴 **長いコード枠を最初から畳むか**(#1087)。⚠ **省略可**。
   * ⚠ 切り替えたら**その場で本文を描き直す**(`setMissingLinks` と同じ理由)。
   */
  setCodeCollapse?(on: boolean): void;
  /**
   * 🔴 **文中の短いコードを押すとコピーするか**(#1087)。⚠ **省略可**。
   * ⚠ 切り替えたら**その場で本文を描き直す**(同上)。
   */
  setInlineCodeCopy?(on: boolean): void;
  /**
   * 🔴 **PDF を PKC の画面で開くか**(#275 段①)。⚠ **省略可**。
   * ⚠ 切り替えても本文は描き直さない ── 効くのは**次に「別のウィンドウで見る」を押したとき**だけ。
   */
  setPdfReader?(on: boolean): void;
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
   * 🔴 **一時の知らせ**(「3 件を『はこ』へ移しました」)。⚠ エラー(`OP_FAILED`)とは
   * **別の行**である ── `main.ts` が優先順位(エラー > 知らせ > 常設)を持っているので、
   * 成功の一報を `OP_FAILED` に載せない(載せると赤い意味の欄に出る)。
   */
  /**
   * ⚠ 第 2 引数は**メッセージへ積むときの扱い**(#1017 C5 段 b1、`status-notice.ts`)── 既定は
   *   「結果」で積む。**既に積んだ字**は `{ post: false }`(二重にしない)。
   */
  showStatus?(text: string, opts?: StatusOptions): void;
  /**
   * 🔴 **何が容量を食っているか**(#415)── worker に数えさせる。
   * ⚠ **数字だけ**返ってくる(本文も bytes も境界を越えない)。
   * ⚠ 無い配線では**押しても何も起きない**ので、器は「調べています…」で止めない。
   */
  storageProfile?(): Promise<StorageProfileResult>;
  /**
   * 🔴 **ブラウザが言う使用量**(#971 段②)── 空きが尽きる前に言うための材料。
   * ⚠ 読めない端末が在るので optional(読めなければ「読めなかった」と出す)。
   */
  quotaEstimate?(): Promise<{ usage?: number; quota?: number }>;
  /**
   * 🔴 **中身が壊れていないかを調べる**(#971 段③)。
   * ⚠ 数 GB では**分の単位**で返らない ── 押した側は待っている字を出し続ける。
   */
  checkIntegrity?(): Promise<IntegrityCheckResult>;
  /**
   * 🔴 **壊れていても読める分だけノートを拾う**(#971 段③)。
   * ⚠ 1 回では終わらない ── `done` になるまで呼び側が繰り返す。
   */
  rescueEntries?(afterRowid: number, chunks: number): Promise<RescuePage>;
  /**
   * 🔴 **添付の実体を読む口**（#1005。user 指摘 2026-09-17）。
   *
   * ⚠ 上の `rescueEntries` は **sqlite を読む**ので、壊れ方によっては拾えない。
   * 🔑 添付の bytes は **IndexedDB**（`pkc3-assets`）に在り、
   *   **sqlite を 1 度も通らない** ── だから壊れた DB でも確実に読める。
   * 🔴 直す前はこの口が無く、拾い出しが添付を 1 バイトも出さないまま
   *   「中身を捨てる」がその bytes を消していた（= 案内どおりに進むと失う）。
   */
  rescueAssets?: RescueAssets;
  /**
   * 🔴 **入れ物ごと捨てて、まっさらにする**(#986 段③)。
   *
   * ⚠ **判断はここへ渡さない** ── 何をどの順で消すかは
   *   `features/storage/container-reset.ts` が 1 か所で持つ。
   * ⚠ 返るのは**消せなかった数まで含む報告**である(「全部消えた」と読ませない)。
   */
  resetContainer?(cid: string): Promise<ContainerResetReport>;
  /**
   * 🔴 **拾った中身で、その場に建て直す**（#1006。user 裁定 2026-09-18）。
   *
   * ⚠ **順番と門はここへ渡さない** ── `features/storage/container-rebuild.ts` が 1 か所で持つ。
   * ⚠ 返るのは**結末を 3 値で持つ報告**である（真偽ではない）──
   *   「作り直せたがメモリ上だった」は成功でも失敗でもなく、
   *   **user が次にやることが違う**。
   */
  rebuildContainer?(cid: string, onProgress?: RebuildProgress): Promise<RebuildReport>;
  /**
   * 🔴 **読み込み直す**(#986 段③)。⚠ 捨てた後の画面は**もう無い物を映している**。
   * ⚠ optional なのは test のためだけ ── 実機では必ず渡す
   *   (渡し忘れると「消しました」の後、画面が古いまま残る)。
   */
  reloadApp?(): void;
  /**
   * 🔴 **本文の画像を資産にする**(貼付 = #251 / 押して取り込む = #264 段①)。
   * ⚠ `namePrefix` は**名乗り** ── 置けなかったときの断り文に名前が出るので、
   *   どちらの操作で失敗したのかが読める形にする。
   * ⚠ 入らなかったものは**理由つき**で返る(#264 段②)── 文言に組むのは
   *   `describeAdoptFailures` の 1 本(呼び側で綴り直さない)。
   */
  adoptUrls?(urls: readonly string[], namePrefix: string): Promise<AdoptOutcome>;
  /**
   * 🔴 **リンク先の印を取りに行って、置くところまで**(#856 段②)。
   *
   * ⚠ **判断はここへ渡さない** ── 取れた / 取れなかったを返すだけで、
   *   何を dispatch するかは binder が決める(`main.ts` に判断を置かない ── §2)。
   * ⚠ 呼ぶのは**設定の門を通した後**である(押していないのに通信しない)。
   */
  adoptLinkIcon?(url: string): Promise<{ ok: true; assetKey: string } | { ok: false; why: string }>;
  /**
   * 🔴 **添付を別の窓で見る**(#192 で画像、2026-08-15 に PDF を追加)。
   * ⚠ 実体は adapter/platform 側(ObjectURL の寿命が絡むので、binder は**呼ぶだけ**)。
   * ⚠ `mime` は**押した要素が運ぶ** ── 開く側で引き直さない。
   * 🔴 `lid` は**押した添付のノート**(#275 段①)── PDF を PKC の画面で読む窓が「ノートへ引く」の
   *   起点にする。⚠ 押した瞬間の選択を読まない(留めた枠では選択と食い違う。`targetLid` と同じ理由)。
   */
  viewAsset?(assetKey: string, name: string, mime: string, lid?: string): void;
  /**
   * 🔴 **画像に描き込む**(#683 段③)。別ウィンドウで描き、新しい画像として保存する。
   * ⚠ 実体は main.ts(窓と添付の取り込み口を持つ)── binder は**呼ぶだけ**。
   * ⚠ `mime` は**押した要素が運ぶ**(`viewAsset` と同じ理由)。
   */
  drawOnImage?(assetKey: string, name: string, mime: string, lid?: string): void;
  /**
   * 🔴 **画面に出ている絵を、別窓で大きく見る**(#527。user 指示 2026-08-28
   * 「**別ウィンドウで実寸で開いて拡大縮小できるようにしてほしい**」)。
   *
   * ⚠ `viewAsset` とは**別**である ── あちらは添付を**鍵で引く**(添付の一覧から
   *   押す道)。こちらは**もう画面に出ている絵**を渡す(図 / 本文に貼った画像)。
   * ⚠ **焼き直さない**(不可侵指示「SVG は書き出しのときだけ」)── 渡すのは
   *   既に画面に在る bytes である。
   * ⚠ 実体は adapter/platform 側(ObjectURL の寿命が絡むので binder は**呼ぶだけ**)。
   * ⚠ 名前を `viewDiagram` から変えた(2026-08-28)── 本文に貼った**写真**にも
   *   同じ道を使うので、「図」と呼ぶと**次に読む人が図だけだと思う**。
   */
  /**
   * 絵を別の窓で大きく見せる。
   * @param diagramSource 図なら**その原文**。⚠ 渡ったときは `src`(焼いた PNG)を
   *   使わず、**原文からベクタを起こして**開く(user 報告 2026-08-28)。
   */
  /**
   * @param from 押した窓(⚠ 章の別ウィンドウで押したときは**その窓**から開く ── 押した操作の
   *   続きは押した窓にしか付かないので、本体から開くとポップアップ阻止に掛かる)
   */
  /**
   * @returns 窓を開けたかを後で言う(`true` = 開けた)。⚠ 返さない実装は「開けたか分からない」と読む
   *   (拡大の画面は閉じない ── 台帳 #1852 束 T1、依頼 99-2 C)。
   */
  viewBig?(
    src: string,
    title: string,
    diagram?: { kind: 'mermaid' | 'chart'; source: string },
    from?: Window,
  ): void | Promise<boolean>;
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
   * 🔴 **付箋(ノートだけの別ウィンドウ)なら、Escape で窓ごと閉じる**
   * (#1042 followup / 段④。裁定:`docs/development/touch-and-unity-design-2026-09.md`
   * §5 Q3「付箋のウィンドウも Escape で閉じます」)。
   *
   * ⚠ `closeViewWindow` とは**別の軸**である ── あちらは `view=`(予定表・連絡先など)
   *   を指している窓、こちらは**ノートを名指した断片**で開いた窓
   *   (`main.ts` の `heldNoteWindow`。判断はそちらに在る、binder は呼ぶだけ)。
   * ⚠ **省略可** ── 本体のタブでは配線されない(`undefined` のときは今までどおり
   *   `deselect-entry` がそのまま効く)。
   * 🔴 **戻り値は `closeViewWindow` と同じ三値**(#1042 段④)。⚠ 直す前は
   *   `boolean`(`=== 'closed'` へ潰した値)だったので、**`'refused'` と
   *   `'not-a-window'` が呼び側から見分けられなかった** ── ブラウザが
   *   `close()` を拒んだ(`'refused'`)ノートの付箋を Escape で押すと、
   *   窓は開いたままなのに `deselect-entry` へ**黙って**進み、
   *   `selectedLid` が空になって「開いています」の放送(`heldNoteWindow` は
   *   立ったまま)と画面が食い違っていた。
   * @returns `'closed'` = 窓ごと閉じた(呼び側は `deselect-entry` を撃たない)。
   *   `'refused'` = 付箋だがブラウザが閉じなかった(理由を出し、`deselect-entry`
   *   は撃たない ── ノートは開いたままにする)。`'not-a-window'` = 付箋でない
   *   (今までどおり `deselect-entry` へ進む)
   */
  closeNoteWindow?(): CloseViewWindowResult;
  /**
   * 🔴 **この窓は、自分で開いた付箋か**(#1087)。⚠ `closeNoteWindow` は呼ぶと**閉じてしまう**ので、
   * 「閉じずに付箋かだけ知りたい」場面(打ちかけがあって閉じないとき、本体の `deselect-entry` へ
   * 流してはいけない)にはこちらを使う。省略 = 付箋ではない。
   */
  isNoteWindow?(): boolean;
  /**
   * ランチャーのタイルを起動する(P7b 段⑩)。
   * ⚠ blob の貸し出し・`window.open` は実体側 ── binder は DOM を触らない。
   */
  openTile?(lid: string): void;
  /**
   * 🔴 **その 1 回だけ、選んだ開き方で開く**(#884 段②)。
   *
   * ⚠ **`openTile` とは別の口にする** ── あちらは**設定どおり**に開くが、
   *   こちらは**設定を書き換えずに**その場だけ違う開き方で開く。「いまの
   *   出し先は何か」の判定は 1 か所(`launch-tile.ts` の
   *   `opts.openTarget ?? deps.openTarget()`)に寄せ、ここは値を運ぶだけ(§7)。
   * ⚠ 綴りの検めは実体側(`isAppOpenTarget`)── `setAppOpenTarget` と同じ作法。
   */
  openTileAs?(lid: string, target: string): void;
  /**
   * 🔴 **マニュアルを独立した窓で開く**(#645。user 要望 2026-08-31
   * 「**ヘルプの中からマニュアルをアプリとして出してください**」)。
   *
   * ⚠ **`openTile` とは別の口にする** ── あちらは lid でタイルを引くが、
   *   ヘルプの中のボタンにはタイルが無い。同じ物を 2 通りで引かせない(§7)。
   * ⚠ **同期で呼ぶ**(実体側が `window.open` を user gesture の中で撃つ)。
   * ⚠ 省略可 ── 渡らない環境では、そもそもボタンを出さない
   *   (`HelpRenderer` が `openManual` を持たなければ組まない)。
   */
  openManualWindow?(): void;
  /**
   * 🔴 **書庫(zip)の中を別の窓で見る**(#826。user 指摘 2026-09-09
   * 「**別窓にはできないの？**」)。
   *
   * ⚠ **同期で呼ぶ**(実体側が `window.open` を user gesture の中で撃つ)──
   *   だから「掴む」と「中身を組む」を割ってある:ここは**掴むだけ**で、
   *   目録を読み終えてから `pick` を呼ぶ。
   * ⚠ **`null` = 掴めなかった**(ポップアップ阻止)── 呼び側がその場の器へ落ちる。
   * ⚠ 省略可 ── 渡らない版では今までどおりその場の器で開く。
   */
  grabArchiveWindow?(title: string, assetKey: string): ArchiveWindowHandle | null;
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
  /** 取り込み中の「取り込みをやめる」(台帳 #1852 束 T1、依頼 156 ②)。 */
  cancelOfficeInstall?(): void;
  installOfficePackFromFile?(file: File): void;
  removeOfficePack?(): void;
  /**
   * 🔴 **SQL の面で、手持ちのファイルを選んだ**(#854 段②)。
   * ⚠ **憶えない**(user 裁定 2026-09-12)── 呼ぶたびに新しく選ばせる。
   *   実体(合成 lid を発行して `SET_SQL_SOURCE` を投げる)は `main.ts` が持つ ──
   *   この file はどの test からも実行されない(CLAUDE.md §2)。
   * 🔴 `add` が真なら**置き換えではなく足す**(`ADD_SQL_SOURCE`。#918 段⑦)。
   */
  pickSqlLocalFile?(file: File, add?: boolean): void;
  /**
   * 🔴 **Office 側の設定を初期状態に戻す**(#634)。
   * ⚠ `removeOfficePack` では戻らない ── あれは一式(IndexedDB)だけを消し、
   *   LO の設定(localStorage)は残る。落ちる設定を保存した user の**唯一の出口**。
   */
  resetOfficeProfile?(): void;
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
   * ブラウザの AI に許した範囲を取り消す(#1407)。`origin` = 組み込み先のページの AI の行(段⑥)。
   * 無い = このブラウザの AI。
   */
  revokeAgent?(scope: string, origin?: string): void;
  /**
   * 紙面(2026-08-08、user 裁定「A4 と A3、フル HD と 4:3 の縦横」)。
   * ⚠ **flag ではない**(正規設定)── 散文の読み幅と、印刷の紙が決まる。
   */
  setPageFormat?(format: string): void;
  /**
   * 🔴 **本文の置き場所**(#722、2026-09-08)。⚠ **flag ではない**(正規設定)──
   *   読み幅より窓が広いとき、本文を列の中央に置くか左端に置くかが決まる。
   */
  setProseAlign?(align: string): void;
  /**
   * 🔴 **開く場所**(#826)。⚠ 綴りの検めは実体側(`isOpenPlace`)── binder は
   *   `<select>` の値をそのまま渡す(`setProseAlign` と同じ作法)。
   */
  setOpenPlace?(place: string): void;
  /**
   * 🔴 **アプリの開き方**(#884 段①)。⚠ 綴りの検めは実体側(`isAppOpenTarget`)──
   *   binder は `<select>` の値をそのまま渡す(`setOpenPlace` と同じ作法)。
   */
  setAppOpenTarget?(target: string): void;
  /**
   * 編集の仕方(#104 第 2 弾。user 裁定 2026-08-08)。
   * ⚠ **flag ではない**(正規設定)── 効くのは次に編集を開いたとき。
   */
  setEditorMode?(mode: string): void;
  /**
   * 🔴 **アプリの一覧でグループを畳む / 開く**(#857 段④)。
   * ⚠ 畳みは**端末ごと**(`localStorage`)なので state に入れない ──
   *   `setEditorMode` と同じく、保存へ書いて描き直すのは `main.ts` である。
   */
  toggleAppGroup?(group: string): void;
  /**
   * 🔴 **画面に出ているグループを、全部畳む / 全部開く**(#857 段④)。
   * ⚠ 名前は**画面から採る**(呼び側が数え直さない)── 「すべて」の意味は
   *   「いま一覧に出ている群」であって、保存に残っている名前ではない
   *   (別の端末から運んだ畳みを、こちらの画面の操作で消さない)。
   */
  toggleAllAppGroups?(groups: readonly string[]): void;
  /**
   * 🔴 **グループ用のノートが増えることを、押す前に聞く**(#857 段③)。
   *
   * ⚠ **枚数だけでなく、どの群かを渡す**(2026-09-13、動線レビュー D1)──
   *   直す前は「ノートが 4 枚できます」とだけ出ており、**押した群以外まで
   *   巻き込まれる理由が 1 語も書いていなかった** ── user からは
   *   「1 つ動かしただけなのに、なぜか複数のノートが増える」としか見えない。
   * @param names ノートができる群の名前(押した群とは限らない)
   * @returns 進めてよければ `true`
   */
  confirmAppGroupNotes?(names: readonly string[]): Promise<boolean>;
  /**
   * 🔴 **すべての群の並び順をやめてよいか聞く**(2026-09-13、着地前の動線レビュー)。
   * ⚠ 押した見出し**以外**にも効くので、押す前に範囲を言う ── 戻すには
   *   「上へ / 下へ」を押し直すしかなく、**何回押したかは user も憶えていない**。
   * @param count いま番号の付いている群の数
   */
  confirmResetAppGroupOrder?(count: number): Promise<boolean>;
  /**
   * 🔴 **グループの目印を選ぶ小窓を出す**(#857 段②)。
   * @returns 図案の名前。**空文字 = なし(外す)**。やめたら `null`
   */
  /**
   * 🔴 **グループの目印を選ぶ小窓を出す**(#857 段②)。
   * ⚠ **いま付いている絵**も渡す(2026-09-13、裁定「絵を並べた表にする」)──
   *   渡さないと、表は出せても**どれが選ばれているか**を描けない。
   * @returns 図案の名前。**空文字 = なし(外す)**。やめたら `null`
   */
  pickAppGroupIcon?(groupName: string, current: string): Promise<string | null>;
  /**
   * 添付の携帯参照(`pkc://<自分>/asset/<key>`)から**所有ノートへ飛ぶ**(#100 段②)。
   * ⚠ 見つからないときは黙らない(OP_FAILED で断る ── 無言の dead click を作らない)。
   */
  navigateAssetRef?(assetKey: string, what?: '参照' | 'リンク', ownerLid?: string | null): void;
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
   * タグの色を付ける / 外す(#1457。`color: null` = 外す)。保存は器(コレクション)に書く。
   * ⚠ 色の綴りの検めは受け手(`putTagColor`)が持つ ── ここは渡すだけ。
   */
  setTagColor?(tag: string, color: string | null): void;
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
  /** 帯をしまうだけ(読んだことにしない)。カードの「お知らせの一覧を開く」を押したとき(台帳 #1852 束 L2、依頼 80-2)。 */
  hideAnnounce?(): void;
  nextAnnounce?(): void;
  muteAnnounce?(): void;
  /**
   * お知らせを出すかの設定(P11 段⑤)。⚠ **flag ではない**(正規設定)──
   * 開放先は user で、畳む予定も無い。⚠ 帯の「今後は出さない」の**戻し道**である。
   */
  setNoticesEnabled?(on: boolean): void;
  /**
   * 狭い画面の断り書きを出すか(#687 E-1)。⚠ **flag ではない**(正規設定)──
   * 帯の「OK」で切れた user が戻せる**唯一の道**である(お知らせと同じ形)。
   */
  setTooNarrowEnabled?(on: boolean): void;
  /**
   * 「開く」で編集に入るか(user 裁定 2026-08-18)。⚠ **flag ではない**(正規設定)。
   * ⚠ 読む側は `services` ではなく `openInEdit` を引く(下の `bindActions` の引数)──
   *   ここは**書き手**だけ。
   */
  setOpenInEdit?(on: boolean): void;
  /** 更新の案内を見送る(次に開いたときに再び出る)。 */
  dismissUpdate?(): void;
  /**
   * 🔴 **保存していない編集を戻す / 消す**(#1376)。起動したときの 1 行の 2 つのボタン。
   * ⚠ 判断(編集中なら断る・開いて編集に入る)は `draft-offer.ts` ── binder は頼むだけ。
   */
  restoreDraft?(): void;
  discardDraft?(): void;
  /** アーカイブ書出し(P6d)。 */
  exportArchive?(): void;
  /** 可搬 HTML の書出し(P6d 段③)。 */
  exportHtml?(): void;
  /** md ZIP の書出し(P6d 段④)。 */
  exportMarkdown?(): void;
  /** md を PC のフォルダへ 1 度だけ書き出す(#1455 (b))。 */
  exportMarkdownFolder?(): void;
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
  /**
   * 🔴 **メッセージへ 1 件残す**(#1379)── 貼ったウェブの字を Markdown に直したときに使う。
   * ⚠ 画面下の 1 行には出さない(貼るたびに割り込まない)。**本文の字は渡さない**
   *   (固定の文だけ ── メッセージは中身を漏らさない)。渡されなければ残さない。
   */
  leaveMessage?(input: { kind: 'result'; source: string; text: string }): void;
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
  /**
   * 🔴 **フォルダの面の「中まで全部出す」を憶える**(#813 段②)。
   * ⚠ **効かせるのは reducer**(`SET_FILER_FLATTEN`)で、ここは**憶えるだけ**
   *   (`rememberDualPreview` と同じ作り)。
   */
  rememberFilerFlatten?(on: boolean): void;
  /** このノートを Word(.docx)で書き出す(#187 段①)。 */
  exportEntryDocx?(lid: string): void;
  /** このノートを PowerPoint(.pptx)で書き出す(#187 段⑤)。 */
  exportEntryPptx?(lid: string): void;
  /** 紙に出す(#187)── 中央の面に開いてからブラウザの印刷を呼ぶ。 */
  printNote?(lid: string): void;
  /** このノートだけをアーカイブとして書き出す(P6f)。 */
  exportEntry?(lid: string): void;
  /**
   * 🔴 **このノートを閲覧用 HTML(1 枚)で書き出す**(#491)。
   * ⚠ 上の `exportEntry` と**別の物** ── あちらは取り込み直せる `.pkc3.zip`、
   *   こちらは相手がブラウザで開くだけで読める片道の HTML である。
   */
  exportEntryHtml?(lid: string): void;
  /**
   * 🔴 **このノートの本文を、そのまま 1 つの .md で書き出す**(#1440)。
   * ⚠ 入口は右クリックと「操作を探す」だけ(右の列には置かない ── `menuOnly`)。
   */
  exportEntryMarkdown?(lid: string): void;
  /**
   * 🔴 **このノートを別の窓で開く**(#685 段②、user 裁定 2026-09-04)。
   *
   * > 「**マルチで付箋開けるといいかもね**」(利用者の感想 2026-09-04)
   *
   * ⚠ **同期に呼べること** ── `window.open` は click の gesture の中でしか通らない。
   * 🔑 何枚でも開ける(窓を使い回さない)── 付箋である。
   * 🔴 **`find` は「探す」で当たった語**(#1102 段①)── 開いた窓が、本文の当たった所へ送って塗る。
   *   ⚠ 省略 = これまでどおり(語を運ばない)。
   */
  openNoteWindow?(lid: string, find?: string): void;
  /**
   * 🔴 **予定を「週」で、別のウィンドウに開く**(#855 段 A-2)。左の列の「週」ボタンが呼ぶ。
   * ⚠ **同期に呼べること**(`window.open` は click の gesture の中でしか通らない)。
   * @param day いま見ている日(`null` = 今日)── 開いた窓が同じ週を見せる
   */
  openScheduleWindow?(mode: 'week' | 'month', day: string | null): void;
  /**
   * 🔴 **その見出しの章を、読むだけの別のウィンドウで開く**(#1044 段4)。
   * ⚠ **同期で**窓を掴むこと(user の操作の続きでしか開けない)。
   * @param line 押した見出しの行(frontmatter を剥がした側 ── 右クリックが運ぶ値)
   */
  openChapterWindow?(lid: string, line: number): void;
  /** 🔴 **このフォルダと配下**をアーカイブとして書き出す(#399 ①)。 */
  exportFolder?(lid: string): void;
  /**
   * 図 1 枚をベクタ(`.svg`)で書き出す(P8 段⑦)。
   * ⚠ 画面に置くのは PNG、書き出すのは SVG(user 指示 2026-08-03)。
   * @param index 同じ本文の中で**何枚目か**(0 始まり ── 名前は 1 始まりにする)
   */
  /** ⚠ **Promise を返す** ── 押した側が「終わった」を知らないと待ちを出せない。 */
  /**
   * @param lid 図の載っているノート(⚠ 省略すると本体で選んでいるノート ── 章の別ウィンドウや
   *   留めた枠の図は、押した所から引いた lid を渡す)
   */
  exportDiagram?(source: string, index: number, lid?: string): void | Promise<void>;
  /** 文字列をクリップボードへ(P8 段⑱)。⚠ 失敗も可視で終える。 */
  /**
   * clipboard へ写す。
   *
   * 🔴 **`done` に「何を写したか」を渡す**(2026-08-29 の動線レビュー 欠陥 2)。
   * ⚠ 渡さないと `main.ts` の既定文(「参照をコピーしました」)が出る ── それは
   *   **参照以外を写したときに嘘になる**(実際 `copy-plain-markdown` は本文を全部
   *   写しているのに「参照をコピーしました(本文に貼れます)」と出ていた)。
   * ⚠ **押した側で `showStatus` を撃っても勝てない** ── clipboard の書込は非同期で、
   *   その `.then` が**後から必ず上書きする**(実測 12ms で入れ替わっていた)。
   *   🔑 だから字は**この口から渡す**。2 か所で撃たない。
   */
  copyText?(text: string, done?: string): void;
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
  /**
   * 🔴 **つながっている PC のファイルの、いまの中身を読む**(#1231 段①。履歴の面の「くらべる相手」)。
   * `null` = 読めなかった / `{ tooLarge: true }` = 大きすぎて読まなかった(どちらも**「同じ」と言わない**。言う字は分ける)。
   * ⚠ 読むだけ ── 書かない。
   * ⚠ 呼んでよいのは**相手に選んだ瞬間**だけ(一覧では呼ばない = #1271)。
   */
  readLinkedFile?(lid: string): Promise<string | LinkedFileTooLarge | null>;
  /**
   * 🔴 **パソコンのフォルダ**(#215 段①②。🟣 Gemini 裁定 2026-10-01)。
   * ⚠ handle は `LocalFolder` が持つ ── binder は「押された」を伝えるだけで、
   *   選ぶ・列挙・許可の確かめ・取り込みの振り分けは全部実体側。
   *   ⚠ **消す・改名・移動の口は持たない**(パソコンのファイルは取り消せない)。
   */
  localFolder?: Pick<LocalFolder, 'pick' | 'cut' | 'more' | 'open' | 'refresh'>;
  /** PKC2 ファイルの取込(P6b)。判別・変換・書込は実体側の責務。 */
  /** 取込(PKC2 の書出し / 素の Markdown)。振り分けは import-file.ts が持つ。 */
  importFiles?(files: File[]): void;
  /**
   * 🔴 **直前の取込をごみ箱へ戻す**(#535 ②)。
   * ⚠ 「どれを取り込んだか」の記憶は `import-undo.ts` が持つ ── binder は
   *   「押された」を伝えるだけ(件数も生死もここで数えない)。
   */
  undoImport?(): void;
}

function defaultTitle(dispatcher: Dispatcher, archetype: string): string {
  const label = archetypeLabel(archetype);
  const titles = new Set<string>();
  for (const m of dispatcher.getState().entryMetas.values()) titles.add(m.title);
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  /**
   * 🔴 **番号は「その日の通し番号」**(Gemini 裁定 = #1163 への依頼 45 の 4、#1657。推薦 A)。
   *   直す前は「同じ種類のノートの件数 + 1」で、今日 1 件目でも「2026-10-13 ノート 347」のように大きな数が付いた
   *   (何の番号か読めない)。いまは 1 から数え、**今日その種類で既に使われている番号は飛ばす**
   *   (#1087 の「既に在る題名を作らない」── 古いノートを消したあとも、今日の既存の題名と重ならない)。
   */
  let k = 1;
  while (titles.has(`${date} ${label} ${k}`)) k += 1;
  return `${date} ${label} ${k}`;
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
  /**
   * 🔴 **打った内容があるときは、捨てる前に聞く**(依頼 71-1)。変えていなければ聞かずにやめる。
   * 「変えた」= 本文が編集を始めたときの内容と違う(`openBody.body !== baseline`)、または
   * 既存ノートの題名欄が元の題名と違う。⚠ 作りたてのノート(`freshLid`)の題名は、やめても残す規則
   * (下)なので数えない。窓が開いている間の Esc は窓が受けるので、二重に出ない(`cancelAsking` でも畳む)。
   */
  if (s.phase === 'editing' && lid && s.openBody !== null && !cancelAsking) {
    const input = editorTitle(root);
    const titleChanged =
      s.freshLid !== lid &&
      input !== null &&
      // ⚠ 比べる先は「編集を始めたときの題名」── 他のタブが改名した後の題名(entryMetas)と比べると、触っていないのに「変えた」になる(保存の側と同じ)
      input.value !== (input.getAttribute('data-pkc-title-base') ?? input.value);
    if (s.openBody.body !== s.openBody.baseline || titleChanged) {
      cancelAsking = true;
      void confirmInApp(root, '打った内容を捨てますか', { okLabel: '編集をやめる', cancelLabel: '編集を続ける' }).then(
        (answer) => {
          cancelAsking = false;
          if (answer !== 'ok') return;
          // 待つ間に編集が終わっていたら(別の窓の操作など)何もしない
          if (dispatcher.getState().phase !== 'editing') return;
          cancelNow(dispatcher, root);
        },
      );
      return;
    }
  }
  cancelNow(dispatcher, root);
}

/** 聞いている間の二重起動を防ぐ(Esc の連打)。 */
let cancelAsking = false;

function cancelNow(dispatcher: Dispatcher, root: HTMLElement): void {
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
 * 追記欄(`append` region)の **保存 / キャンセル**(#716 まで「保存して解放 /
 * 編集を破棄」)は detail の
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

/**
 * 🔴 **開いている行の欄の打ちかけを、保存の前に state へ届ける**(#1219)。
 *
 * 実マウスは `mousedown` で焦点が動いて行の欄が `blur` し、行の確定が先に走る。
 * ところが `mousedown` の無い押し方(`el.click()` / 支援技術の押下)は焦点が動かないので、
 * 打ちかけが state に無いまま `COMMIT_EDIT` が走り、**保存に入らない**
 * (保存後の描き直しが欄の `blur` で確定しても、もう編集は終わっている)。
 * 🔑 `blur()` を呼ぶだけ ── 確定の規則は `RowSwap.commitActive` の 1 か所のまま
 *   (ここに 2 本目の確定を書かない)。題名欄を読む `renameFromEditorInput` と同じ向きの手当て。
 * ⚠ 行の欄に焦点が無ければ何もしない(2 列の全文欄は `input` で state に届いている)。
 */
function settleRowEditor(root: HTMLElement): void {
  const el = document.activeElement;
  if (
    el instanceof HTMLTextAreaElement &&
    el.getAttribute('data-pkc-field') === 'row-source' &&
    root.contains(el)
  ) {
    el.blur();
  }
}

/** editor 表示中なら title input の現在値で RENAME を先行 dispatch する
 *  (楽観 meta 更新 → 直後の COMMIT_EDIT が新 title で行を組む。
 *  input が見つからなければ何もしない = 既存 title 維持 ── PKC2 の
 *  「title が消える」bug の防波堤と同じ向き)。 */
/**
 * 編集の題名欄の字で改名する。
 * 🔴 **欄の字を変えていなければ改名しない**(#1087)── 編集中に 2 ペインや別のタブで同じノートの名前を変えると、
 *   欄には始めたときの古い名前が残っているので、保存のたびに古い名前へ戻していた。
 */
function renameFromEditorInput(dispatcher: Dispatcher, root: HTMLElement): void {
  const input = editorTitle(root);
  const lid = dispatcher.getState().openBody?.lid;
  if (!input || !lid) return;
  if (input.value === input.getAttribute('data-pkc-title-base')) return;
  dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title: input.value });
}

/** 読む面の描画済み本文(コピーの書式付き / 選択範囲が読む)。 */
function viewBodyHost(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-pkc-region="detail"] ${BODY_HOST_SELECTOR}`);
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
 * 🔴 **書くのは `insertText`(= `execCommand`)で、変わった範囲だけ** ── `ta.value =` や
 * `setRangeText` はブラウザの取り消し履歴(Ctrl+Z)を捨てる(#765)。書式バーのボタンも
 * Ctrl+B などのショートカットキーも、ここを通るので、押した分だけ Ctrl+Z で戻せる。
 * 字下げ(`runIndent`)・計算と同じ作法。
 */
function writeBack(
  ta: HTMLTextAreaElement,
  next: { text: string; start: number; end: number },
  toBottom = false,
): void {
  ta.focus();
  replaceChanged(ta, next.text);
  ta.setSelectionRange(next.start, next.end);
  // 追記はカーソルが末尾 ── 見えていないと「押しても何も起きない」に見える
  if (toBottom) ta.scrollTop = ta.scrollHeight;
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
/**
 * 🔴 **左の列(フォルダの表)の鍵 → 押しボタンの口**(#215)。
 *
 * 🔑 2 ペインの `DUAL_KEY_ACTION` と同じ作法 ── `F2` と右クリックの「名前を変える」は
 *   **同じ受け手**を通す(断り方・欄の出し方が鍵とメニューで割れない)。
 * ⚠ 鍵は 2 ペインの同じ操作と揃えてある(`F2` 改名 / `F6` 移す / `Shift+F4` 作る)──
 *   同じ操作は同じ鍵(`keymap.ts` の注記)。
 */
const FILER_KEY_ACTION: Readonly<Record<string, string>> = {
  'filer-rename': 'rename-entry-begin',
  'filer-move': 'move-to-folder',
  'filer-new-in-folder': 'create-in-folder',
};

/**
 * 🔴 **押しっぱなし(キーリピート)で撃たない鍵**(#1087)。作る・写す・移す・消す・名前を変える。
 * ⚠ 直す前は F5 を押し続けると、リピートのたびに同じ行が何件もコピーされた(F7 は空のフォルダが並び、F8 は次々消える)。
 * ⚠ 矢印などの**移動の鍵は入れない**(押しっぱなしで下り続けられるのが作法)。
 * 🔑 判定は鍵のコマンド id で 1 本 ── `onShortcut` の 2 か所(左の列 / 2 ペイン)が同じ表を引く。
 */
const REPEAT_IGNORED_KEYS: ReadonlySet<string> = new Set([
  'filer-rename',
  'filer-move',
  'filer-new-in-folder',
  'filer-trash',
  'dual-rename',
  'dual-copy-to-other',
  'dual-move-to-other',
  'dual-new-folder',
  'dual-new-note',
]);

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
/**
 * 🔴 **集計(タグ)の組を、全ノートで付け替える / 外す**(Gemini 裁定、#1163 の依頼 65-1)。
 *
 * 書く口は増やさない ── `BULK_TAG`(まとめてタグを付ける / 外す。`add-tag` / `untag-entry` と同じ)へ
 * 組の lid 全部を流す。付け替えは「外す → 付ける」の 2 通で、`enqueue` が順に走らせる。
 *
 * ⚠ **外してから付ける**(逆にしない)── 付けてから外すと、タグが上限に達しているノートは
 *   付かないのに外れて、**タグが消える**。外してから付ければ、付かなかった分も古い名前のまま残らず
 *   上限の問題も起きない。新しい名前が既にあるノートは「既に付いていました」で重ならない(統合)。
 * ⚠ 組が抱える lid は上限(`QUERY_LIMITS.lidsPerGroup`)で切れていることがある ── 切れているときは
 *   **一部だけ変えて「全部変えた」と読ませない**ために断る。
 * ⚠ 本文の行に `#タグ` と書いてある分は、外す口が frontmatter だけを触るので残る
 *   (外す側の知らせが「まだそのタグが付いています」と言う)。
 */
/**
 * 🔴 **長すぎて付けられないタグの名前を言う**(#1087)。⚠ `splitTags` は `MAX_TAG_CHARS` 超を黙って捨てるので、
 * 直す前は「足すタグを入力してください」と出たり、長いほうだけが消えたりしていた。
 * 長い名前は頭の 10 字だけにして「…」で切る。断るのは打った字ぜんぶ(欄は残す)── 一部だけ付けて知らせを塗り潰さない。
 */
function overlongTagMessage(raw: string): string | null {
  const names = overlongTagNames(raw);
  if (names.length === 0) return null;
  const head = (n: string): string => ([...n].length > 10 ? `${[...n].slice(0, 10).join('')}…` : n);
  const more = names.length > 1 ? `(ほか ${names.length - 1} 件)` : '';
  return `「${head(names[0]!)}」は ${MAX_TAG_CHARS} 字を超えるので付けられません${more}`;
}

async function queryTagBulk(
  dispatcher: Dispatcher,
  services: BinderServices,
  root: HTMLElement,
  tag: string,
  mode: 'rename' | 'remove',
): Promise<void> {
  const st = dispatcher.getState();
  const verbWord = mode === 'rename' ? '付け替えて' : '外して';
  if (st.phase !== 'ready') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}タグを${verbWord}ください` });
    return;
  }
  const group = st.queryGroups?.groups.find((g) => g.value === tag);
  if (tag === '' || group === undefined || st.queryKey !== TAGS_KEY) return;
  const lids = group.lids.filter((lid) => st.entryMetas.has(lid));
  /**
   * 🔴 **切れた組は断る**(上限 500 件)。⚠ 長いタグ名は一覧の側で 80 字に丸めて「…」が付く ──
   *   丸めた名前では本当のタグを指せないので、同じく断る。
   */
  if (group.lids.length < group.total || tag.endsWith('…')) {
    // 🔴 事実だけを言う(#1087)。⚠ 直す前は「ノートを絞ってから」と書いてあったが、集計の画面に絞る口は無い
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error:
        group.lids.length < group.total
          ? `タグ「${tag}」は ${group.total} 件のノートに付いていますが、一度に ${group.lids.length} 件までしか${mode === 'rename' ? '変えられ' : '外せ'}ません`
          : `タグ「${tag}」は名前が長いので、ここからは${mode === 'rename' ? '変えられ' : '外せ'}ません`,
    });
    return;
  }
  if (lids.length === 0) return;
  let next = '';
  if (mode === 'rename') {
    const typed = await promptInApp(root, {
      title: 'タグの名前を変える',
      label: `タグ「${tag}」(${lids.length} 件)の新しい名前`,
      initial: tag,
      okLabel: '次へ',
    });
    if (typed === null) return;
    const longMsg = overlongTagMessage(typed);
    if (longMsg !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: longMsg });
      return;
    }
    const names = splitTags(typed);
    if (names.length !== 1) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '新しいタグの名前は 1 つだけ入力してください' });
      return;
    }
    next = names[0]!;
    // 同じ名前なら何も変わらない(押した手応えは言う)。
    // ⚠ 大小だけの違いは「変える」である(外す → 付けるで綴りが変わる。#1087)
    if (next === tag) {
      dispatcher.dispatch({ type: 'OP_NOTICE', message: `タグ「${tag}」の名前は変わりませんでした` });
      return;
    }
  }
  const message =
    mode === 'rename'
      ? `タグ「${tag}」を ${lids.length} 件のノートで「${next}」に変えます`
      : `タグ「${tag}」を ${lids.length} 件のノートから全部外します`;
  const answer = await confirmInApp(root, message, {
    okLabel: mode === 'rename' ? '変える' : '外す',
    cancelLabel: 'やめる',
    danger: mode === 'remove',
  });
  if (answer !== 'ok') return;
  // 待っている間に状態が変わったときは、もう一度見る(編集に入ったなら断る)
  const now = dispatcher.getState();
  if (now.phase !== 'ready') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(now.phase)}タグを${verbWord}ください` });
    return;
  }
  /**
   * 🔴 **別のタブ・窓が編集中のノートが 1 つでもあれば、付け替えない**(#1087。追記と同じ門)。
   * ⚠ 一部だけ書くと「全部変えた」と読めてしまうので、全部が通ったときだけ撃つ。
   */
  actUnlessEditedElsewhere(
    dispatcher,
    services,
    lids,
    mode === 'rename'
      ? 'タグを付け替えられませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください'
      : 'タグを外せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
    () => {
      dispatcher.dispatch({
        type: 'BULK_TAG',
        lids,
        tags: [tag],
        mode: 'remove',
        ...(mode === 'rename' ? { renameFirst: true } : {}),
      });
      if (mode === 'rename') {
        dispatcher.dispatch({ type: 'BULK_TAG', lids, tags: [next], mode: 'add', afterPrevious: true });
        // 🔴 スマートフォルダの条件の同じ名前も変える(#1087)── 変えないと、旧い名前の条件は何も集めなくなる
        dispatcher.dispatch({ type: 'RENAME_SMART_TAG', from: tag, to: next });
        /**
         * 🔴 **名前を変えたら、色も付いてくる**(#1087)。⚠ 直す前は新しい名前が灰色になり、
         *   古い色は**どのノートにも付かないまま残った**(外す口は「そのタグが付いたノート」にしか無く、
         *   `MAX_TAG_COLORS` の枠だけ食う)。新しい名前に色が既に在るなら、そちらを尊重して動かさない。
         * ⚠ 外す側(`remove`)の色は触らない ── 本文の行に `#タグ` と書いたノートが残りうるので、
         *   「どのノートにも無い」と安く言い切れない(色は残る。ノートに付いていれば右のペインから外せる)。
         */
        const oldColor = currentTagColor(tag);
        if (oldColor !== null && currentTagColor(next) === null) {
          // 古い色を先に外す ── 付けてから外すと、枠が上限のとき付けられない
          services.setTagColor?.(tag, null);
          services.setTagColor?.(next, oldColor);
        }
      }
      // 🔴 全部外したときは、そのタグを条件にしたスマートフォルダの件数を知らせる(#1163 依頼 321)── 条件は変えない
      if (mode === 'remove') dispatcher.dispatch({ type: 'RENAME_SMART_TAG', from: tag, to: null });
      // 🔑 集計は書いた結果を映す ── 書込が着いてから数え直す
      void Promise.resolve(services.settle?.() ?? null).then(() => {
        dispatcher.dispatch({ type: 'REFRESH_QUERY' });
      });
    },
  );
}

function runBulkTag(
  dispatcher: Dispatcher,
  services: BinderServices,
  root: HTMLElement,
  mode: 'add' | 'remove',
): void {
  const field = root.querySelector<HTMLInputElement>('[data-pkc-field="bulk-tag"]');
  // 🔴 編集中などは reducer(BULK_TAG)が黙って捨てるので、ここで断る(#1087)。
  //   ⚠ 欄は触らない ── 打った字を残す(断っておいて消すと打ち直しになる)
  const phaseNow = dispatcher.getState().phase;
  const blockedBy = phaseBlockReason(phaseNow);
  if (blockedBy !== null) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `${blockedBy}タグを${mode === 'add' ? '付けて' : '外して'}ください`,
    });
    return;
  }
  // 🔑 **打った字を何個と読むかは `splitTags` 1 か所**(#637)──
  //   `#請求 #未払` と打てば 2 つ付く(本文のタグの行と同じ字である)
  const longMsg = overlongTagMessage(field?.value ?? '');
  if (longMsg !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: longMsg });
    return;
  }
  const tags = splitTags(field?.value ?? '');
  if (tags.length === 0) {
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
  // 🔑 **1 回の頼みは 1 回で撃つ**(#637 の着地前レビュー)── 1 つずつ撃つと、
  //   知らせが 1 通ずつ出て**後の 1 通が前を塗り潰す**(12 件に「請求」が付いたのに
  //   「0 件に付けました」と出る)。並びのまま渡せば、答えも 1 通で全部を語れる。
  // 🔑 前の回に入らなかった名前は、この回の字に混ぜない(#640 案 A)
  // 🔴 別のタブ・窓が編集中のノートが 1 つでもあれば撃たない(#1087)。⚠ 断ったときは欄も残る(下の fire の中で空にする)
  actUnlessEditedElsewhere(
    dispatcher,
    services,
    lids,
    mode === 'add'
      ? 'タグを付けられませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください'
      : 'タグを外せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
    () => {
      dispatcher.dispatch({ type: 'CLEAR_REFUSED_TAGS', field: 'bulk-tag' });
      dispatcher.dispatch({ type: 'BULK_TAG', lids, tags, mode, field: 'bulk-tag' });
      // 🔑 通したら欄を空にする(次の 1 つを打てる)── ⚠ 断ったときは残す
      if (field) field.value = '';
    },
  );
}

/**
 * 🔴 **タグを打つ欄は 3 つ。作法を 1 つにする**(#639)。
 *
 * ⚠ 直す前は**欄ごとに作法が違っていた**:
 *
 * | 欄 | Enter | 候補 |
 * |---|---|---|
 * | 情報ペインの **タグ** | 🟢 効く | 🟢 出る |
 * | フォルダの **タグを付ける** の帯 | 🔴 **無反応** | 🟢 出る |
 * | スマートフォルダの **条件** | 🔴 **無反応** | 🔴 **出ない** |
 *
 * ⚠ 打ち終えて Enter を押す人がいちばん多く、押しても**何も起きず理由も出ない**
 *   (無音の dead key)。⚠ 条件の欄は 1 文字違うと **0 件のスマートフォルダ**が
 *   静かに残る場所なので、候補が出ないのがいちばん効く。
 *
 * 🔑 **欄 → その欄の「足す」操作**の表を 1 つ持ち、**Enter の受け口と候補の口が
 *   同じ表から引く**(§7)── 直す前は `binder.ts` の 2 か所に**別々の条件**が
 *   書いてあり、片方だけ欄を足すと静かに食い違った(実際そうなっていた)。
 */
/** その場で足す欄 → Enter で撃つ操作(ボタンと同じ action)。 */
const QUICK_ADD_ENTER: ReadonlyMap<string, string> = new Map([
  ['schedule-quick-text', 'schedule-quick-add'],
  ['contacts-quick-name', 'contacts-quick-add'],
  ['contacts-quick-tel', 'contacts-quick-add'],
  ['contacts-quick-email', 'contacts-quick-add'],
  ['contacts-quick-org', 'contacts-quick-add'],
]);

const TAG_INPUT_ADD: ReadonlyMap<string, string> = new Map([
  ['tag-add-input', 'add-tag'],
  ['bulk-tag', 'bulk-tag-add'],
  ['smart-cond', 'smart-cond-add'],
]);

/**
 * **その口が効く先の lid**。**押した要素の属性**を先に見る(2026-09-12 / 2026-09-13)。
 *
 * ⚠ 属性が無いときだけ `selectedLid` に落とす ── 古い DOM でも壊さないため。
 * 🔴 **留めた枠(横に並べた枠)は選択と関係なく「その 1 件」を出す面**なので、
 *   そこに在る口が `selectedLid` へ撃つと**押していないノートが書き換わる**。
 *   だから起動だけでなく**設定の口も**ここを通す(#848)。
 * 🔑 綴りは `render/target-lid.ts` の 1 か所(§7)。
 */
function targetLid(dispatcher: Dispatcher, target: HTMLElement): string | null {
  return target.getAttribute(TARGET_LID_ATTR) ?? dispatcher.getState().selectedLid;
}

const BODY_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'start-edit',
  // 🔑 **行の右クリックからフォルダの中に作る**(#215)── `create-entry` と同じ
  //    `CREATE_ENTRY` を撃つので、同じ門をくぐらせる
  'create-in-folder',
  // 🔑 **右クリックから入る編集も同じ門**(#426 段②。着地前レビュー 🔴1)──
  //    載せ忘れると「取り込み中は帯からは断られ、メニューからは通る」になる
  'edit-from-heading',
  // 🔑 **章だけ編集も同じ理由**(#1044 段2)── `edit-from-heading` と同じく、
  //    取込・書出しの最中に書込を始める入口を作らない
  'edit-section',
  'save-section-draft',
  // 🔑 **コード枠だけ編集も同じ理由**(#1044 段3)
  'edit-code-block',
  'save-code-draft',
  'commit-edit',
  'append-entry',
  // 🔑 板の付箋の上の追記 / 題名(#529 W5)── `append-entry` と同じ書込なので同じ門
  'place-inline-commit',
  // ⚠ 選んだ全部の本文を書く(#402 ①)── 取込・書出しの最中に走らせない
  'bulk-tag-add',
  'bulk-tag-remove',
  // 🔑 いま開いている 1 件へのタグの付け外しも**本文を書く**(#494)──
  //    実体は `BULK_TAG` なので、上の 2 つと同じ門をくぐらせる
  'add-tag',
  'untag-entry',
  // 🔑 集計(タグ)の組から、そのタグを全ノートで付け替える / 外す(依頼 65-1)── 実体は `BULK_TAG`
  'query-tag-rename',
  'query-tag-remove',
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
  // ⚠ 塊の移動の「元に戻す」も同じ経路(#684 段①)
  'undo-move',
  // 🔴 ブロックを 1 つ上下へ動かす(台帳 #1852 束 S1、依頼 238)── 実体は `MOVE_BLOCK`(本文を書く)なので同じ門
  'move-block-step',
  // 🔴 予定を動かした直後の「元に戻す」(#855)── 日付を書き戻す 1 手なので同じ門をくぐらせる
  'schedule-undo-move',
  // 🔑 スタックの保存はノートを 1 件**作る**(`CREATE_ENTRY`。#633 段③)── 取込・書出しの
  //    最中に entry を足すと、総入れ替えの裏で 1 件増える形になるので同じ門をくぐらせる
  'stack-save',
  // 🔑 入れ物の中の並べ替えは本文を書く(`REQUEST_BODY_REWRITE`。#633 段④)
  'stack-link-up',
  'stack-link-down',
  /**
   * 🔴 **外部の画像を取り込むのも本文を書く**(#264 段①)── 同じ
   *   `REQUEST_BODY_REWRITE` を撃つので、同じ門をくぐらせる。
   * ⚠ こちらは**押してから書くまでに通信を挟む** ── その間に取り込みが始まっても
   *   困らないよう、少なくとも**押す時点**では止める(検査は `tests/repo-hygiene.test.ts`)。
   */
  'adopt-external-images',
  /**
   * 🔴 **リンク先の印を取り込むのも、ノートを書く**(#856 段②)──
   *   `SET_APP_TILE` を撃つので同じ門をくぐらせる。
   * ⚠ `adopt-external-images` と同じく**押してから書くまでに通信を挟む**ので、
   *   少なくとも**押す時点**では止める。
   */
  'adopt-link-icon',
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
   * 🔴 **色の見本を押して色を直すのも本文を書く**(#1224)── `toggle-task` と同じ
   *   `REQUEST_BODY_REWRITE` を撃つので、同じ門をくぐらせる。
   * ⚠ 押した時点では選ぶ窓を開くだけだが、**選び終えて書く** ── 門は入口に置く。
   */
  'pick-color',
  /**
   * 🔴 **リストを丸ごとそろえるのも本文を書く**(#1173)── `toggle-task` と同じ
   *   `REQUEST_BODY_REWRITE` を撃つので、同じ門をくぐらせる(印の数だけ書く点も同じ)。
   */
  'task-run-open',
  'task-run-done',
  /**
   * 🔴 **画像の大きさ・寄せも本文を書く**(#1640 ③)── 画像の直後の `{w=50% align=center}` を書き換える
   *   (`SET_IMAGE_ATTRS` → `REQUEST_BODY_REWRITE`)。`toggle-task` と同じ門をくぐらせる。
   */
  'image-width',
  'image-align',
  /**
   * 🔴 **表のセルを打つのも本文を書く**(#418 段①)── `toggle-task` と同じ
   *   `REQUEST_BODY_REWRITE` を撃つので、同じ門をくぐらせる。
   * ⚠ 押した時点では欄を開くだけだが、**確定で書く** ── 門は入口に置く。
   */
  'edit-cell',
  // 🔴 見出しの ✎ も `edit-cell` へ渡すだけ(#1240)── 欄を開いて確定で書くのは同じ
  'edit-header-cell',
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
  /**
   * 🔴 **テンプレートから作るのも、ノートを 1 件作る**(#1645)── `open-today` と同じ理由で載せる。
   */
  'create-from-template',
  /**
   * 🔴 **画面の下の「○○のノートを作る」は、ノートを 1 件作る**(#1169)── `CREATE_ENTRY` は
   *   即永続なので、取り込みが entry を総入れ替えしている裏で足させない
   *   (`contacts-quick-add` と同じ)。⚠ 日付を押すほう(`open-date-note`)は**作らない**
   *   (開くか、作るかを聞くだけ)ので載せない。機械検査は `tests/repo-hygiene.test.ts`。
   */
  'create-date-note',
  // ⚠ 今日のノートの本文を書く(#402 ②)── 取込・書出しの最中に走らせない
  'schedule-quick-add',
  // 🔴 連絡先を 1 件作る(#278 段③)── `CREATE_ENTRY` は即永続なので同じ門(機械検査は repo-hygiene)
  'contacts-quick-add',
  /**
   * 🔴 **SQL の答えをノートへ書き出す**(#681 段③ の 3 つ目)── `CREATE_ENTRY` を撃つ。
   * ⚠ 取り込みが entry を総入れ替えしている裏で 1 件足させない、が理由
   *   (`contacts-quick-add` と同じ)。機械検査は `tests/repo-hygiene.test.ts`。
   */
  'sql-to-note',
  /**
   * 🔴 **予定から外すのも本文を書く**(#498)── 行の `@…` を剥がす
   *   (`SET_TASK_DATE`)か、frontmatter の `date:` を消す(`SET_ENTRY_DATE`)。
   * 🔑 掴んで「日付なし」へ落とす経路と**同じ書込**なので、同じ門をくぐらせる。
   */
  'unschedule-task',
  /**
   * 🔴 **繰り返しを付け替えるのも本文を書く**(#855 段 0 の 3 つ目)── 行の
   *   `@2026-08-31 毎週` の尻を書き換える(`SET_TASK_REPEAT`)。
   * 🔑 外す口(`unschedule-task`)と**同じ門**をくぐらせる ── 片方だけ通ると、
   *   取り込みの最中に「やめる」は断られて「毎週にする」は通る、という
   *   説明のつかない差が生まれる(§7)。
   * ⚠ 1 段目の `open-repeat-menu` は**載せない** ── 開くだけで本文を書かない
   *   (`copy-md-block` と同じ判断:書かない口を名前で断ると、忙しい間は
   *   「何ができるか見る」ことまで止まる)。
   */
  'set-task-repeat',
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
  // 🔴 添付のファイルの差し替えは disk への書込(#1163 依頼 212)── 取込・整理が走っている最中は断る
  'replace-attachment-file',
  /**
   * 🔴 **作るのも disk への書込である**(2026-08-19、機械検査が見つけた 4 件)。
   * ⚠ `move-entry` を入れた理由(「本文は書かないが disk への書込」)と同じなのに、
   *   **作る 3 つの口と、保存の再送**が漏れていた ── 取り込みが entry を
   *   総入れ替えしている裏で新しい行を挿すことになる。
   * ⚠ 断りは**可視**(帯に理由が出る)なので、無言の dead click は作らない。
   */
  'create-entry',
  /**
   * 🔴 **▼ で種類を選ぶのも、いまは `create-entry` と同じ**(#1054 段②)──
   *   選んだ時点でその場で作るので、`create-entry` を載せた理由がそのまま当たる。
   */
  'pick-create-kind',
  'dual-mkdir',
  'dual-mknote',
  'dual-copy',
  'retry-persist',
  'delete-entry',
  'restore-revision',
  'restore-trash',
  // 🔴 ゴミ箱へ移した直後の「元に戻す」(#1087 流れ 29)── `restore-trash` と同じ復元なので同じ門
  'undo-trash',
  // 🔴 2 ペインで移した直後の「元に戻す」── 居場所を書き戻すので `move-to-folder` と同じ門
  'undo-dual-move',
  // 🔴 まとめてタグを付けた直後の「元に戻す」(台帳 #1852 G1 / 依頼 109 A)── タグを書き戻すので同じ門
  'undo-bulk-tag',
  // 🔴 題名を変えた直後の「元に戻す」(#1657)── 題名を書き戻すので `rename-attachment` と同じ門
  'undo-rename',
  // 🔴 種類を変える(台帳 #1852 I2 / 依頼 157)── 種類を disk へ書くので、同じ門
  'change-entry-kind',
  // 🔴 取り込みの「取り消す」── ゴミ箱へ入れる `delete-entry` と同じ書込なので同じ門(#1087)
  'undo-import',
  'purge-trash',
  /**
   * ⚠ 本文は書かないが **disk への書込**である(取込は relations を総入れ替えする
   *   ので、走っている最中に居場所を変えると片方が消える)。
   * 🔴 **`move-entry` から `move-to-folder` へ移した**(#813、2026-09-09)──
   *   プルダウンを外して受け手ごと消えたので、**残った口をここへ載せ直す**。
   * ⚠ 載せ直さないと、**門だけが静かに消える**(受け手を消したときに
   *   いちばん起きやすい形。CLAUDE.md「片側を直したら対称の反対側を疑う」)。
   */
  'move-to-folder',
  // ⚠ user の**ファイル**を上書きする ── 取込・書出しの最中に走らせない
  'write-back-file',
  // 🔴 パソコンのフォルダの行を押すと取り込む(`CREATE_ENTRY` / 取込)── 取込・書出しの最中は断る(#215 段②)
  'pc-open-file',
]);

/**
 * 🔴 **押した時点では書くか決まらない導線は、門を「書く瞬間」へ遅らせる**
 * (着地前レビュー・動線 D3、2026-09-06)。
 *
 * ⚠ 上の `BODY_WRITE_ACTIONS` は **action の名前**で断るので、
 *   **1 つの名前が複数の物を受けている**ときに巻き添えが出る ──
 *   `copy-md-block` は表だけでなく**コードの囲み・mermaid / chart / html / svg**の
 *   ⧉ も受けるので、名前で断ると**コピーが 1 つ残らず止まる**。
 *   ⚠ しかも `busy` は**添付の取り込み**でも真になるので、写真を 1 枚入れた直後に
 *   コードをコピーしようとして「書き出し / 取込が実行中です」と出る。
 * 🔑 だから**この一覧に載せた action は、名前では断らない** ── 代わりに
 *   本文を書く関数(`applyTableFormat`)が `services.busy` を検める。
 * ⚠ **外すだけでは tripwire を 1 つ撤廃したのと同じ**なので、
 *   `tests/repo-hygiene.test.ts` が「**この一覧の action から辿れる所で
 *   `busy` を検めていること**」を機械で確かめる(名前の門と同じ強さを保つ)。
 * ⚠ 右クリックの 2 つも同じ関数を通る ── 入口で書き分けると**片方だけ字が違う**
 *   ことになるので、こちらへ寄せて**断り文も 1 つ**にする(§7)。
 */
/** 履歴の版を戻す確認の間に、別のノートを選んだとき(#1087)。 */
export const RESTORE_TARGET_MOVED_TEXT = '別のノートを選んだので、前の版には戻していません。戻すノートを選び直して、もう一度押してください';

const BODY_WRITE_DEFERRED: ReadonlySet<string> = new Set([
  'copy-md-block',
  'table-to-markdown',
  'table-to-csv',
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
 * 「編集中か」の判定はここ 1 つで、断り文の**続き**も押した場所と対で渡す。
 * ⚠ 前置きは `phaseBlockReason` から(C11b / #1045)── 手で書いた「編集を終了
 *   してから」は `error` の相(保存に失敗して止まった)でも同じ字を出していた。
 */
function notWhileEditing(dispatcher: Dispatcher, refusalSuffix: string): () => string | null {
  return () => {
    const phase = dispatcher.getState().phase;
    return phase === 'ready' ? null : `${phaseBlockReason(phase)}${refusalSuffix}`;
  };
}

/**
 * 🔴 **開いているノートが要る道具は、押す前に断る**(user 裁定 2026-09-02
 * 「**4 つとも先に断る**」── PC も同じ)。
 *
 * ⚠ 直す前は 4 つがばらばらだった:計測だけが `timer.ts` の中で断り、
 *   **録音 / 画面録画は録り終わってから**「ノートを開いていないので本文には
 *   入れていません」と言い(= **録ってから知らされる**)、**添付は黙って
 *   file を選ばせて**いた。
 *   ⚠ どれも「押した時点では止めてくれない」ので、user は**やり直しになる**。
 * 🔑 **4 つとも「開いているノートに入れる道具」である**(user 裁定 2026-09-02、#666
 *   ── 添付だけ本文に入らず画面ごと持っていく形だったのを、録音と同じに揃えた)。
 *   だから断る理由は 4 つに共通して真である。
 * 🔑 判定は `NOTE_TOOL_ACTIONS` **1 か所**から引くので、5 つ目の道具を足した日に
 *   ここへ書き足す必要は無い。
 * ⚠ 貼り付け / 差し込みの経路(`services.attachFiles` を直に呼ぶ 2 か所)は
 *   **通さない** ── あちらは「この file をここへ置く」という指し示しつきの操作で、
 *   断ると**いま在る動線を 1 つ失う**(user 裁定 2026-08-07)。
 */
const NOTE_SCOPED_ACTIONS: ReadonlyMap<string, string> = new Map(
  NOTE_TOOL_ACTIONS.map((a) => [a.action, a.label]),
);

function refuseWithoutNote(action: string, dispatcher: Dispatcher): boolean {
  const label = NOTE_SCOPED_ACTIONS.get(action);
  if (label === undefined || dispatcher.getState().selectedLid !== null) return false;
  // ⚠ **押した物の名前を入れる**(CLAUDE.md「文言は押した場所と対で pin する」)──
  //   4 つが同じ字だと、user は自分がどれを押して断られたのか分からない
  dispatcher.dispatch({
    type: 'OP_FAILED',
    error: `「${label}」はノートを開いてから押してください(追記先のノートが決まりません)`,
  });
  return true;
}

function refuseWhileBusy(
  action: string,
  dispatcher: Dispatcher,
  services: BinderServices,
): boolean {
  /**
   * ⚠ **遅らせる門の action は、名前では断らない**(上の `BODY_WRITE_DEFERRED`)──
   *   1 つの名前が複数の物を受けているので、ここで断ると**書かない操作まで巻き添え**に
   *   なる。断るのは下流の書く関数(`applyTableFormat`)である。
   */
  if (BODY_WRITE_DEFERRED.has(action)) return false;
  if (!BODY_WRITE_ACTIONS.has(action) || services.busy?.() !== true) return false;
  // ⚠ **可視に断る**(無言の操作拒否を作らない)
  dispatcher.dispatch({
    type: 'OP_FAILED',
    error: '書き出し / 取り込みが実行中です。完了してから操作してください',
  });
  return true;
}

/**
 * 🔴 **配線が無い版でも黙らない**(#413)。⚠ ボタンは画面に在るので、
 * 押して何も起きないと「壊れている」と読まれる。
 */
function refuseNoCapture(dispatcher: Dispatcher): void {
  dispatcher.dispatch({
    type: 'OP_FAILED',
    error: 'このタブの PKC3 が古いままのため、録音・画面録画ができません。再読み込みしてください',
  });
}

/** 🔴 同じ理由でタイマーも断る(#279)── 押して無音にしない。 */
function refuseNoTimer(dispatcher: Dispatcher): void {
  dispatcher.dispatch({
    type: 'OP_FAILED',
    error: 'このタブの PKC3 が古いままのため、作業時間を計れません。再読み込みしてください',
  });
}

const ORDER_ONLY_MANUAL = '並び順が「自分で並べた順」のときだけ動かせます';

/** 並べ替えの 2 つの向きで同じことをする(規則を 2 か所に書かない)。 */
function moveOrder(
  dispatcher: Dispatcher,
  target: HTMLElement,
  direction: 'up' | 'down',
): void {
  const lid = target.getAttribute('data-pkc-entry');
  if (!lid) return;
  // 🔴 編集中などは reducer が黙って捨てる ── 押して無音にしない(`reorderDropped` と同じ前置き)
  const st = dispatcher.getState();
  if (st.phase !== 'ready') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}並べ替えてください` });
    return;
  }
  // 🔴 手動の順でないときは、見えない並びを黙って動かさない(押せない理由と同じ字を出す)
  if (dispatcher.getState().entrySort !== 'manual') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: ORDER_ONLY_MANUAL });
    return;
  }
  dispatcher.dispatch({ type: 'MOVE_ENTRY_ORDER', lid, direction });
}

/**
 * 🔴 **同じタイルを続けて押したか**(#857 段①b)。
 *
 * ⚠ `maybeDoubleOpen` と**同じ作法**(`dblclick` に頼らず、同じ lid への連続押しで
 *   見る)。⚠ **3 回目を「もう一度」と数えない** ── 数えると、素早く 3 回押したときに
 *   窓が 2 枚開く。
 *
 * 🔴 **数は器(root)ごとに持つ**(2026-09-13、test が教えた)。
 * ⚠ 1 稿目は module の中に 1 つだけ置いていたので、**別の器の押しと混ざった** ──
 *   test では前の it が残した「1 回目」を次の it が「2 回目」と読み、
 *   **1 回押しただけで窓が開いた**(しかも通る it と落ちる it が混在して、
 *   原因が 2 つに見えた)。
 * 🔑 `maybeDoubleOpen` が**閉包の中**に数を持っているのと同じ形へ寄せる ──
 *   あちらは `bindActions` の中の `let`、こちらは `ACTIONS` が module に在るので
 *   **器を鍵にした `WeakMap`** にする(器が消えれば数も消える)。
 */
const TILE_DOUBLE_MS = 500;
const lastTilePress = new WeakMap<Element, { lid: string; at: number }>();
function pressedTileAgain(root: Element, lid: string): boolean {
  const now = Date.now();
  const last = lastTilePress.get(root) ?? { lid: '', at: 0 };
  const again = last.lid === lid && now - last.at <= TILE_DOUBLE_MS;
  lastTilePress.set(root, again ? { lid: '', at: 0 } : { lid, at: now });
  return again;
}

/**
 * 🔴 **アプリのタイルを 1 つ上 / 下へ**(#857 段①)。
 * ⚠ 端では reducer が**何もしない**(輪にしない ── 一番上で「上へ」を押して
 *   末尾へ飛ぶと驚く)。
 */
/**
 * 🔴 **アプリのタブを離れたら、並べ替えモードは終える**(#857 段①b-2。
 * 着地前の動線レビュー 欠陥 1、2026-09-13)。
 *
 * ⚠ 直す前:並べ替えモードのまま「一覧」へ行き、しばらくして「アプリ」へ戻ると
 *   **タイルを 2 回押しても開かない**。頼んでいないのにモードが続いており、
 *   しかも user は自分が何をしたのか憶えていない ── 「壊れている」に見える。
 * ⚠ **入るときは何もしない** ── 戻ってきた瞬間に勝手に入らない。
 *
 * ## 🔴 呼ぶのは `main.ts` の `setBrowse` **1 か所**である(2026-09-13 に訂正)
 *
 * ⚠ 1 稿目はここ(`binder.ts`)の **3 か所**で呼んでいた ── 着地前レビューが
 *   **4 本目の口**を見つけた:`deep-link.ts` の「引っ越した面」
 *   (`#pkc?view=calendar` → 予定)は `main.ts` の `openBrowse` を通るので、
 *   **アドレスが変わっただけで左のタブが動き、モードだけ残る**。
 * 🔑 探し方(`browseMode`)は state に持たないので reducer からは見えない ──
 *   だから**タブを実際に切り替える唯一の実装**(`main.ts` の `setBrowse`)へ寄せる。
 *   ⚠ 呼び側ごとに対で書かせる形は、**足した人が書き忘れた日に静かに破れる**。
 * ⚠ 門が掛かっていることは `tests/adapter/tile-reorder-mode.test.ts` が
 *   **`main.ts` の原文**で pin する(この関数自体の test と対で読む)。
 */
export function leaveLauncherIf(dispatcher: Dispatcher, mode: string): void {
  if (mode !== 'launcher') dispatcher.dispatch({ type: 'SET_LAUNCHER_REORDER', on: false });
}

function moveTile(dispatcher: Dispatcher, target: HTMLElement, by: -1 | 1): void {
  const lid = target.getAttribute('data-pkc-tile');
  if (lid === null || lid === '') return;
  dispatcher.dispatch({ type: 'MOVE_APP_TILE', lid, target: { kind: 'step', by } });
}

/**
 * 🔴 **右クリックが運んだ行の見出しを引く**(#1559 で `copy-section-ref` から取り出した)。
 *   直下の見出しを先に、外れたら刻印で深く探す(引用や `:::` の中にも id は刻まれる)。
 *   ⚠ 「参照」と「リンク」が**同じ見出しを指す**ための 1 本 ── 引き方を 2 つに分けない(§7)。
 */
function carriedHeading(host: HTMLElement | null, line: number): Element | null {
  if (host === null) return null;
  return (
    headingAtSourceLine(host, line) ??
    [...host.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(
      (h) => h.getAttribute('data-pkc-source-line') === String(line),
    ) ??
    null
  );
}

/** 見出しの字。⚠ 畳みのボタンを除いて読む(`textContent` は `<button>` を含む)。 */
function headingPlainText(heading: Element): string {
  return [...heading.childNodes]
    .filter((n) => !(n instanceof Element && n.matches('button')))
    .map((n) => n.textContent ?? '')
    .join('')
    .trim();
}

/**
 * 本文のリンク(`entry:` / `@card`)から別のノートを開く。
 *
 * 🔴 **規則は 1 本**(`link-target.ts`)。⚠ 断る 3 つはどれも**可視に**返す ──
 * `SELECT_ENTRY` は編集中 / error / 未知 lid で**黙って何もしない**ので、
 * 素直に撃つと「押しても無言」が残る(直そうとしている当のものになる)。
 */
function navigateToLink(
  dispatcher: Dispatcher,
  target: HTMLElement,
  raw: string | null,
  root: HTMLElement,
  services: BinderServices,
): void {
  /**
   * 🔴 **自分の PKC の id を渡す**(#1187)── 渡さないと `foreign` が立たず、別の PKC を指す
   *   リンクが「見つかりません」になる(偶然同じ lid が在れば**別のノートが開く**)。
   *   `cid` が無い(`null`)間は空文字 = 従来どおり外と見なさない(`link-target.ts` の既定)。
   */
  const t = parseLinkTarget(raw ?? '', dispatcher.getState().cid ?? '');
  if (t.kind === 'invalid') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: 'リンクの書き方が読めません' });
    return;
  }
  if (t.foreign) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: 'このリンクは別の PKC3 のノートを指しています',
    });
    return;
  }
  if (!selectEntryOrExplain(dispatcher, t.lid, 'リンク先のノート', root, services)) return;
  /**
   * 🔴 **`#h/<見出しの id>` が付いていれば、開いた後にその見出しへ飛ぶ**(#579)。
   *
   * 🔑 飛ぶ機構は目次と**同じ 1 本**(`tocJump`)── 描き直しを待って id で探し、畳んで
   *   いれば開いてから送る。判定を 2 か所に生やさない(§7)。
   * ⚠ 見出しが無ければ理由を出す(見出しの字を変えると id も変わる ── ノートは開けている
   *   ので、user は本文の中で探し直せる)。
   */
  if (t.section !== null) {
    /**
     * ⚠ **押した要素ではなく `root` を渡す**(#1044 段4)── `tocJump` は渡された要素から
     *   本体の根を辿って本文の面を探す。章の別ウィンドウで押したリンクは**別の document**
     *   に居るので、押した要素から辿ると本体の面に届かない。押した要素が本体の中に居る
     *   ときは、辿った先が同じ `root` なので結果は変わらない。
     */
    void tocJump(
      dispatcher,
      root,
      t.section,
      '見出しが見つかりません(見出しの字が変わったのかもしれません)',
    );
  } else if (/^#[^/#]+$/.test(t.fragment)) {
    /**
     * 🔑 **古い取り込みが残した `entry:X#<見出しの id>`(`h/` なし)**は、節リンクではないが
     *   その id の見出しが在れば飛ぶ。無ければ**何も出さない**(ノートは開けている。
     *   節リンクではない綴りの断り文は、user に別の物を探させる)。
     */
    void tocJump(dispatcher, root, decodeURIComponentSafe(t.fragment.slice(1)), undefined, false, true);
  }
  void target;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
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
/**
 * 🔴 **畳みを管理している器を引く**(#598)。
 *
 * ⚠ **同じ器が 2 つの名前を持つ** ── 骨組みは `…-body-host` を付けるが、
 * markdown を描いた瞬間に**同じ節点の名前が `…-body` へ上書きされる**
 * (`detail.ts` の `renderMarkdownBody`)。だから本文の面で `…-body-host` だけを
 * 探すと**必ず外す**。
 * ⚠ 横に留めた枠は綴りが `split-` になる(押した物と効く先を食い違わせないための仕掛け)。
 * 🔑 4 つとも受ける口を**ここ 1 か所**に置く ── 呼び側に綴りを写さない(§7)。
 */
const FOLD_HOST_SELECTOR = [
  '[data-pkc-field="detail-body"]',
  '[data-pkc-field="detail-body-host"]',
  '[data-pkc-field="split-body"]',
  '[data-pkc-field="split-body-host"]',
].join(',');

function foldHostOf(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>(FOLD_HOST_SELECTOR);
}

/**
 * 🔴 **読む面で押した所の原文の行**(#395 段③ / #495 が共有する 1 か所)。
 *
 * 🔑 行は読む面の刻印(`data-pkc-source-line`)から引く ── **新しい逆引きを
 *   作らない**(`copy-source.ts` と同じ印を読む。§7)。
 * ⚠ **押せる物の上では降りる** ── リンク・ボタン・チェックの印は、その場に
 *   自分の意味を持っている(奪うと、その動線が 1 つ死ぬ)。とくに `Ctrl` / `⌘` は
 *   リンクの「新しいタブで開く」なので、ここを緩めると既定を丸ごと奪う。
 * ⚠ **`ready` のときだけ** ── `START_EDIT` も追記欄も `ready` 以外では動かない
 *   (`appendModeOf` の門と同じ)。ここで揃えておけば、呼び側は 2 本目の門を持たない。
 * ⚠ 刻印が引けなければ `null` ── **当てずっぽうで別の行を扱わない**。
 *
 * @returns frontmatter を**剥がした側**の行番号(`RowSwap` / `editOpenAt` と同じ基準)
 */
function bodySourceLineAt(
  dispatcher: Dispatcher,
  target: EventTarget | null,
): number | null {
  const hit = target instanceof Element ? target : null;
  /**
   * 🔴 **刻印から読む面を引く**(2026-08-28。変異試験 M7 が SURVIVED で教えた)。
   *
   * ⚠ 直す前は `bodyHost` も `mark` も**押した所から別々に** `closest` していて、
   *   そのうえで「読む面が刻印を含むか」を検めていた ── どちらも押した所の
   *   祖先なので**近いほうが必ず遠いほうの子孫**であり、その検査が偽になるのは
   *   「刻印が読む面を包んでいる」ときだけ = **実在しない形**だった
   *   (だから外しても test が 1 つも落ちない)。
   * 🔑 **検出するより、起こらなくする**(CLAUDE.md §7)── 刻印を先に引いて、
   *   そこから読む面へ登れば、包含は**組み立てから成り立つ**ので検査が要らない。
   */
  const mark = hit?.closest('[data-pkc-source-line]') ?? null;
  const bodyHost = mark?.closest('[data-pkc-field="detail-body"]') ?? null;
  // 🔑 一覧は `row-swap.ts` の `OWN_MEANING` **1 本**(2 か所に別の綴りを生やさない)
  const own = hit?.closest(OWN_MEANING) ?? null;
  /**
   * ⚠ **`root.contains(bodyHost)` は置かない**(2026-08-28。着地前レビュー H)。
   *   この handler は `root` に張ってあるので、`root` の外の click はそもそも
   *   届かない ── 外しても test が 1 本も落ちない**死んだ門**だった。
   *   🔑 検出するより起こらなくする(上の `mark` → `bodyHost` と同じ向き)。
   */
  if (
    bodyHost === null ||
    mark === null ||
    (own !== null && bodyHost.contains(own)) ||
    dispatcher.getState().phase !== 'ready'
  ) {
    return null;
  }
  const line = Number(mark.getAttribute('data-pkc-source-line'));
  return Number.isInteger(line) && line >= 0 ? line : null;
}

/**
 * 🔴 **追記した字が、畳んだ章の中に隠れないようにする**(#596 B)。
 *
 * ⚠ 見出しを畳んで目次のように読むのは**畳みのいちばん自然な使い方**だが、その状態で
 * 追記すると、入った塊は描き直しのたびに `applyHeadingFold` が `hidden` にする ──
 * user から見ると**書いたものが消える**(しかも「元に戻す」は追記欄の横にしか出ない)。
 * 🔑 #514 が目次から飛ぶ前にやっていること(覆っている畳みを開く)の**追記版**である。
 *
 * ## 🔴 印(slug)では引かない ── **綴りが一致しない**
 *
 * ⚠ 1 稿目は「追記先の印は、描画側の見出しの `id` と同じ綴り」と思って突き合わせていた。
 * **偽である**(着地前レビュー 🔴1。実測で確かめた)── 2 つは `makeSlugCounter` を
 * 共有しているだけで、**読む文字列が違う**:
 * 追記先の一覧は**原文の行**を正規表現で読み、描画側は**前処理を通った token** を読む。
 * ⚠ 実測:`決定事項`(setext の h1)の下に `## 決定事項` が在る本文で、
 * 追記先の印は `決定事項` なのに描画側の `id` は `決定事項-1` ── **別の章が開く**。
 *
 * 🔑 だから**行で引く**。`resolveAppendAt` が「入る行」を返すので、
 * その**手前で終わっている塊**を器の直下から探し、それを覆う畳みを開く。
 * ⚠ 塊は `data-pkc-source-end`(無ければ `-line`)で範囲を持っている。
 *
 * ## ⚠ 入れ子の畳みは「外側」ではなく**内側**が効く
 *
 * ⚠ 1 稿目のコメントは「自分の畳みと外側の畳みの両方」と書いていたが、実際に隠すのは
 * **内側**である ── `## A / a / ### A-1 / b` に「A」を選んで追記すると、入る所は
 * **`### A-1` の span の中**なので、A を開いても隠れたままになる。
 * 🔑 `revealBlock` は**その塊を覆う畳みを全部**開く(内も外も)ので、
 * 塊さえ正しく引ければ 1 本で解ける。
 */
/**
 * 🔴 **追記先の直前で終わっている塊を引く**(#395 段① / #782 B)。
 *
 * 🔑 **同じ引き方を 2 つの用途が借りる**(CLAUDE.md §7)──
 *   ① 押す**前**:そこを覆う畳みを開いておく(`revealAppendTarget`)
 *   ② 着いた**後**:**足した字がその塊である**ので、そこへ送る(`jumpToAppended`)。
 *   ⚠ ②が成り立つのは、着いた後に引き直すと**追記先が足した字の後ろへ動く**から
 *   ── その手前で終わっている塊が、いま足したものである。
 *
 * @returns 器と塊。⚠ 引けなければ `null`(呼び手は**何もしない** ── 当てずっぽうで
 *   別の所へ送らない)
 */
function appendTargetBlock(
  dispatcher: Dispatcher,
  root: HTMLElement,
  slug: string,
): { host: HTMLElement; block: Element } | null {
  const body = dispatcher.getState().openBody?.body ?? null;
  const host = root.querySelector<HTMLElement>(BODY_HOST_SELECTOR);
  if (body === null || host === null) return null;
  // ⚠ 「末尾」は文書のいちばん後ろ ── 行数を渡せば、どの塊よりも後ろになる
  const at = slug === '' ? body.split('\n').length : resolveAppendAt(body, slug);
  if (at === null) return null;
  /**
   * ⚠ **原文の行 → 描く面の行** ── 描く面は frontmatter を剥がした側を見ている。
   * ずらす値は `frontmatterLineCount` 1 つ(`pickAppendTarget` と同じ規律)。
   */
  const line = at - frontmatterLineCount(body);
  let block: Element | null = null;
  for (const el of host.children) {
    const raw = el.getAttribute('data-pkc-source-end') ?? el.getAttribute('data-pkc-source-line');
    const end = Number(raw);
    if (!Number.isInteger(end) || end >= line) continue;
    block = el;
  }
  return block === null ? null : { host, block };
}

function revealAppendTarget(dispatcher: Dispatcher, root: HTMLElement, slug: string): void {
  const hit = appendTargetBlock(dispatcher, root, slug);
  if (hit === null) return;
  const { host, block } = hit;
  /**
   * 🔑 **`revealBlock` 1 本で足りる**(変異 Q2 / Q4 が生き延びて確かめた)。
   *
   * ⚠ 1 稿目は「塊が畳んだ見出しそのものなら、自分の畳みは `revealBlock` が
   * 開かない(span の外)」として 1 行足していたが、**外して壊れる形が作れなかった**:
   * 入る所の直前の塊が見出しになるのは**その章に中身が 1 つも無いとき**だけで、
   * ⚠ 中身の無い章は `foldSpans` が span を作らない = **そもそも畳めない**。
   * 🔑 だから消した(CLAUDE.md「これが無いと壊れる、と書く前に外して壊れるのを見る」)。
   */
  revealBlock(host, block);
}

/**
 * 🔴 **追記が着いたら、足した所へ送る**(#782 B。user 裁定 2026-09-07)。
 *
 * > 「**追記した見出しや末尾にジャンプ ただし、別窓で開いている場合の
 * > 再レンダリングは固定**」
 * > (⚠ 原文の全角の空白 1 つだけ半角にした ── 語は 1 つも変えていない)
 *
 * ## ⚠ 別窓が動かないのは「実装の副作用」ではなく、この置き場そのものである
 *
 * 🔑 **押した窓でしか走らない** ── ここは押し所の処理なので、別の窓には
 *   1 行も届かない。別窓の側は #782 A(`detail.ts`)が「器を空にしない」形で
 *   固定してあり、**2 つは別の機構**である(片方を直しても片方は動かない)。
 *   検査も別:`tests/smoke/append-scroll.smoke.spec.ts` が両方を見る。
 *
 * ## 待ち方
 *
 * ⚠ **撃った直後には送れない** ── 本文の描き直しは worker 越しなので、
 *   その瞬間の DOM にはまだ足した字が無い。
 * 🔑 順番はこうなっている:①`ENTRY_APPENDED` で state が動く ②**描画器が先に**
 *   `render()` され、印(`PAINTED_ATTR`)を**外す** ③ここの購読が呼ばれる
 *   ④`waitPainted` が印の付け直しを待つ。
 *   ⚠ ②→③の順は購読の登録順で決まる(描画器は boot 時、ここは押した時)。
 * ⚠ **期限を置く** ── 追記が断られた回(空のまま押した / 錠が取れない)は
 *   `lastAppend` が動かないので、置きっぱなしの購読を残さない。
 *
 * ## 送り方
 *
 * ⚠ `block: 'nearest'` にする ── **見えているなら動かさない**。
 *   足した字が画面に入っているのに画面が跳ねると、user 裁定の
 *   「読むのを邪魔しない」と食い違う。
 */
function jumpWhenAppended(
  dispatcher: Dispatcher,
  root: HTMLElement,
  lid: string,
  slug: string,
): void {
  const before = dispatcher.getState().lastAppend;
  let off: () => void = () => {};
  const stop = (): void => {
    off();
  };
  const timer = setTimeout(stop, 8000);
  off = dispatcher.onState((s) => {
    /**
     * ⚠ 別のノートへ移ったら降りる ── **後始末のためだけ**である
     *   (送らない判定は下の「送る直前にもう一度見る」が持つ)。
     * ⚠ ここを外す変異は**等価**で、期限(8 秒)まで購読が残るだけになる ──
     *   test で殺せないことを承知で残している。
     */
    if (s.selectedLid !== lid) {
      clearTimeout(timer);
      stop();
      return;
    }
    const now = s.lastAppend;
    /**
     * 🔴 **`lastAppend` が「動いた」回だけ送る**(#782 B)。
     *
     * ⚠ 参照の比較(`now === before`)を外すと、**着く前に別の理由で state が
     *   動いた瞬間**に発火する ── `APPEND_TO_ENTRY` 自身が `writeLock` を立てるので、
     *   撃った直後に必ず 1 回来る。そこで送ると**前に足した所**(古い DOM)へ行き、
     *   購読はもう降りているので**今回足した字には二度と行かない**。
     * ⚠ 空のまま押した回は state が 1 バイトも動かない(reducer が同じ参照を返す)ので、
     *   **ここは呼ばれない** ── だから「空押し」ではこの門を検められない。
     *   🔑 割れるのは**長い追記を 2 回目に足す**形である(検査はそちら)。
     */
    if (now === before || now === null || now.lid !== lid) return;
    clearTimeout(timer);
    stop();
    void (async (): Promise<void> => {
      const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]');
      if (detail === null) return;
      await waitPainted(detail, lid);
      /**
       * 🔴 **送る直前にもう一度見る** ── 待っている間に別のノートへ移っていたら、
       *   引く本文も器も**そのノートのもの**になる。⚠ 追記先が「末尾」だと
       *   `appendTargetBlock` は必ず塊を引き当てるので、**開いたばかりのノートを
       *   いきなり一番下へ送る**(いちばん気づけない形)。
       */
      if (dispatcher.getState().selectedLid !== lid) return;
      const hit = appendTargetBlock(dispatcher, root, slug);
      if (hit === null) return;
      revealBlock(hit.host, hit.block);
      const goBlock = (): void => hit.block.scrollIntoView({ block: 'nearest' });
      goBlock();
      // 🔴 長大なノートは、飛び先の周りが描かれて実寸になった後に 1 度だけ合わせ直す(#1467)
      settleJump(hit.block, goBlock);
    })();
  });
}

/**
 * 🔴 **ロックを取ってから、続きを呼ぶ**(#426 段②の門 + #1044 段2)。
 *
 * ⚠ **断り文はここ 1 か所**(`startEditAt` / `startSectionEditAt` の共通の門)──
 *   2 か所に書くと片方だけ古くなる(CLAUDE.md §7)。`startEditAt` から抜いただけで
 *   分岐の順番・待つ物は 1 バイトも変えていない。
 *
 * @param onGranted ロックが要らない / 取れたときに呼ぶ。呼ぶ**直前**に
 *   `openBody.lid === lid` を確かめてある(呼び手は再確認しなくてよい)。
 */
function acquireEditLockOrExplain(
  dispatcher: Dispatcher,
  services: BinderServices,
  lid: string,
  onGranted: () => void,
): void {
  const lock = services.acquireEditLock;
  /**
   * 🔴 **飛んでいる書込を待ってから始める**(#288)。⚠ 待たないと、
   * チェックの印を押した直後の編集で**押す前の本文**が入力欄に出て、
   * 打った時点で印が黙って戻る(2026-08-19 に smoke が実際に踏んだ)。
   * ⚠ 待つのは chain が空になるまで ── 何も飛んでいなければその場で返る。
   * ⚠ **渡されていない環境では今までどおり同期に始まる**(`null`)── test の
   *   fake や旧い配線を非同期に変えない(乗せ換えたとき unit が 40 件落ちた)。
   */
  const ready = services.settle?.() ?? null;
  if (!lock) {
    if (ready === null) onGranted();
    else void ready.then(onGranted);
    return;
  }
  void (ready === null ? lock(lid) : ready.then(() => lock(lid))).then((grant) => {
    if (grant !== 'granted') {
      // ⚠ 文言は理由と対(§1 / レビュー M-7)── holder 不在を「別のタブで編集中」と
      //    言うと、user は存在しない編集タブを探す。
      // 🔴 **「タブ」だけと言わない**(#685 動線レビュー 欠陥 5、2026-09-04)── 付箋を
      //    開いた人のブラウザには**タブが 1 枚しか無い**ことがあるので、「別のタブで
      //    編集中」と言うと**存在しないタブを探しに行く**(上と同じ形の誤り)。
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error:
          grant === 'denied'
            ? EDIT_ELSEWHERE_ERROR
            : 'メインのタブと通信できません(少し待ってもう一度お試しください)',
      });
      return;
    }
    // 🔴 呼ぶ**前**に自分の lid か確かめる(レビュー M-3)── acquire を待つ間に
    //    user が別のノートを選んでいると、**そのノート**の編集を受理してしまう
    //    = ロック無しの編集が成立してしまう。dispatch は同期なのでここの検査に窓は無い
    if (dispatcher.getState().openBody?.lid !== lid) {
      services.releaseEditLock?.(lid);
      return;
    }
    onGranted();
  });
}

/**
 * 🔴 **編集に入る口は 1 本**(#426 段②。着地前レビュー 🔴1)。
 *
 * ⚠ 直す前は `START_EDIT` を撃つ所が **3 か所**あり、門(飛んでいる書込を待つ /
 * 別タブとの編集ロック / 入れたか確かめて返す)を持っていたのは**帯の「編集」だけ**
 * だった ── `Ctrl`(`⌘`)+クリックと、右クリックの「ここから編集する」は
 * **ロックを取らずに編集へ入って**いた(= 同じノートを 2 枚が持ち、後に保存したほうが勝つ)。
 * 🔑 §7 の作法どおり**判定を 1 か所へ寄せる** ── 呼び手は「どの行から開くか」だけ渡す。
 *
 * @param atLine 押した行(`null` = 帯の「編集」= 先頭から)
 */
function startEditAt(
  dispatcher: Dispatcher,
  services: BinderServices,
  atLine: number | null,
  restoreBody?: string,
): void {
  const lid = dispatcher.getState().openBody?.lid ?? null;
  const dispatchStart = (): void =>
    // ⚠ 1 行に保つ ── `edit-lock-gate.test.ts` が `dispatch({ type: 'START_EDIT'` の字面で入り口の数を数える
    dispatcher.dispatch({ type: 'START_EDIT', ...(atLine === null ? {} : { atLine }), ...(restoreBody === undefined ? {} : { restoreBody }) });
  if (!services.acquireEditLock || lid === null) {
    const ready = services.settle?.() ?? null;
    if (ready === null) dispatchStart();
    else void ready.then(dispatchStart);
    return;
  }
  acquireEditLockOrExplain(dispatcher, services, lid, () => {
    dispatchStart();
    // ⚠ 「editing に居るか」では足りない ── reducer が断る理由は選択以外にもある
    //    (writeLock / tileWrite 中)。**自分の lid が入ったか**で見る
    const st = dispatcher.getState();
    if (!(st.phase === 'editing' && st.openBody?.lid === lid))
      services.releaseEditLock?.(lid);
  });
}

/**
 * 🔴 **保存していない編集を戻して、編集に入る**(#1376)。入り口は `startEditAt` の 1 本のまま ──
 * ロック・飛んでいる書込の待ち・入れたかの確認は帯の「編集」と同じ道を通る。
 * ⚠ 本文は差し替えるだけで、書かない(保存を押すまで disk は動かない)。
 */
export function startEditRestoring(
  dispatcher: Dispatcher,
  services: BinderServices,
  restoreBody: string,
): void {
  startEditAt(dispatcher, services, null, restoreBody);
}

/**
 * 🔴 **保存していない章 / コード枠の編集を戻して、その欄を開く**(#1728)。開く口は
 * `OPEN_SECTION_DRAFT` / `OPEN_CODE_DRAFT` の 1 本のまま ── ロック・飛んでいる書込の待ち・開けたかの確認は
 * 「この章を編集する」と同じ道を通る(`startSectionEditAt` と同じ形)。
 * ⚠ 欄は開くだけで、書かない(保存を押すまで disk は動かない)。字を入れるのは呼び手(欄が描かれた後)。
 *
 * @param line 本文の行(frontmatter を剥がした側。`locateDraftPart` が返す物)
 */
export function startPartialRestoring(
  dispatcher: Dispatcher,
  services: BinderServices,
  kind: 'section' | 'code',
  line: number,
): void {
  const lid = dispatcher.getState().openBody?.lid ?? null;
  if (lid === null) return;
  const open = (): void => {
    dispatcher.dispatch(
      kind === 'code' ? { type: 'OPEN_CODE_DRAFT', lid, line } : { type: 'OPEN_SECTION_DRAFT', lid, line },
    );
  };
  if (!services.acquireEditLock) {
    const ready = services.settle?.() ?? null;
    if (ready === null) open();
    else void ready.then(open);
    return;
  }
  acquireEditLockOrExplain(dispatcher, services, lid, () => {
    open();
    if (dispatcher.getState().sectionDraft?.lid !== lid) services.releaseEditLock?.(lid);
  });
}

/**
 * 🔴 **「章の下書きを抱えたまま次へ進みたい」を受ける 1 本の関数**
 *   (#1044 段2 5巡目の修理、U1)。
 *
 * ⚠ 直す前は `leaveSectionDraftOrAsk`(別のノートへ移る)と `startSectionEditAt`
 *   (同じノートの別の見出しを開く)が、**同じ手順**(dirty 判定 → 3 択 → 保存 →
 *   ack 待ち → 待つ間に system 側で閉じられていないか → 断られたら進まない)を
 *   別々に書いていた(CLAUDE.md §7「同じ判定を複数の場所に書かない」)。4 巡目の
 *   T7(待つ間に system 側で閉じていたら保存を試みない)は `leaveSectionDraftOrAsk`
 *   にだけ入り、`startSectionEditAt` の `choice === 'save'` には無かった ── 待つ間に
 *   閉じられると、外れた古い箱の字(`host` が外れた node)で SAVE を撃ち
 *   (reducer は no-op)、`waitSectionSaveSettled` が `sectionDraft === null` を見て
 *   即 `'saved'` を返し、固定済みの lid に OPEN を撃って無言で終わっていた。
 *
 * @param draft 3 択に入る**前**に呼び手が読んだ `sectionDraft`(ここで読み直さない)。
 *   「待つ間に system 側で閉じられたか」は、この控えとの身元一致(`lid` + `heading`)で見る。
 * @param opts.captureBeforeSave `SAVE_SECTION_DRAFT` を撃つ**直前**
 *   (`stillOpen` を確かめた後)に呼ぶ ── 保存前の state から必要な物(見出しの ref 等)を
 *   控えておくためのフック。使わない呼び手は渡さなくてよい。
 * @param opts.proceed **非同期に決まった回にだけ**呼ぶ(消して進む / 保存できた /
 *   待つ間に system 側で既に閉じていた ── どれも「移る・開き直す」自体は構わない、
 *   保存を試みたかどうかが違うだけ)。呼ばないのは「移らない」を選んだ / 保存が
 *   断られた、の 2 つだけ(断り文は `state.error` に出ている)。
 *   `saved` が `false` の回は「保存はしていない」── 呼び手は元の行 / 元の対象で
 *   進んでよい(既に閉じていた回も含め、system 側の結果は受け入れる)。
 * @returns `'sync'` なら**変更が無かった**(聞かずに閉じた)── `proceed` は
 *   **呼んでいない**。呼び手は自分の「進む」処理をその場で(同期に)続けてよい。
 *   ⚠ ここで `proceed` を呼ばないのは、`leaveSectionDraftOrAsk` の 5 か所の呼び手が
 *   「`true` が返ったら自分の続きの処理をそのまま続ける」という**同期の契約**を
 *   持っているため(§10「置き換える前に、置き換えられる側が“ついでに”提供していた
 *   性質を数え上げる」と同じ向き ── ここでは「同期で返る」という性質)。
 *   `'async'` なら 3 択(または保存の ack)を待っている ── 呼び手はここで
 *   return する(進んだかどうかは、後から `proceed` が呼ばれるかどうかで分かる)。
 */
/**
 * 🔴 **どの種類の下書きでも、打ちかけの字は同じ 1 か所の綴りから読む**
 * (#1044 段3、§9「段2 の仕組みを共有する」)。
 */
function partialDraftBoxText(host: HTMLElement, draft: PartialDraft): string | null {
  return isCodeDraft(draft) ? codeBoxText(host) : sectionBoxText(host);
}

/**
 * 🔴 **`stillOpen` が、待つ前と同じ下書きか**(#1044 段3)。
 * ⚠ 章は名前(`heading`)、コード枠は身元(`line` + `openLine` + `quote`)で見る ──
 *   どちらも `withPartialDraftLeave` の T7 の判定(§9)。
 */
function sameDraftIdentity(a: PartialDraft, b: PartialDraft): boolean {
  if (a.lid !== b.lid || isCodeDraft(a) !== isCodeDraft(b)) return false;
  if (isCodeDraft(a) && isCodeDraft(b)) {
    return a.line === b.line && a.openLine === b.openLine && a.quote === b.quote;
  }
  return !isCodeDraft(a) && !isCodeDraft(b) && a.heading === b.heading;
}

/**
 * 🔴 **章の下書きを抱えたまま次へ進みたい」を受ける 1 本の関数**
 *   (#1044 段2 5巡目の修理、U1。段3 で**種類に依らず**使えるよう一般化 ──
 *   §9「段2 の仕組みを共有する。2 つ目を作らない」)。
 *
 * ⚠ 直す前は `leaveSectionDraftOrAsk`(別のノートへ移る)と `startSectionEditAt`
 *   (同じノートの別の見出しを開く)が、**同じ手順**(dirty 判定 → 3 択 → 保存 →
 *   ack 待ち → 待つ間に system 側で閉じていないか → 断られたら進まない)を
 *   別々に書いていた(CLAUDE.md §7「同じ判定を複数の場所に書かない」)。4 巡目の
 *   T7(待つ間に system 側で閉じていたら保存を試みない)は `leaveSectionDraftOrAsk`
 *   にだけ入り、`startSectionEditAt` の `choice === 'save'` には無かった ── 待つ間に
 *   閉じられると、外れた古い箱の字(`host` が外れた node)で SAVE を撃ち
 *   (reducer は no-op)、`waitSectionSaveSettled` が `sectionDraft === null` を見て
 *   即 `'saved'` を返し、固定済みの lid に OPEN を撃って無言で終わっていた。
 *
 * @param draft 3 択に入る**前**に呼び手が読んだ `sectionDraft`(ここで読み直さない)。
 *   「待つ間に system 側で閉じられたか」は、この控えとの身元一致({@link sameDraftIdentity})
 *   で見る。
 * @param opts.captureBeforeSave `SAVE_SECTION_DRAFT` / `SAVE_CODE_DRAFT` を撃つ**直前**
 *   (`stillOpen` を確かめた後)に呼ぶ ── 保存前の state から必要な物(見出しの ref 等)を
 *   控えておくためのフック。使わない呼び手は渡さなくてよい。
 * @param opts.proceed **非同期に決まった回にだけ**呼ぶ(消して進む / 保存できた /
 *   待つ間に system 側で既に閉じていた ── どれも「移る・開き直す」自体は構わない、
 *   保存を試みたかどうかが違うだけ)。呼ばないのは「移らない」を選んだ / 保存が
 *   断られた、の 2 つだけ(断り文は `state.error` に出ている)。
 *   `saved` が `false` の回は「保存はしていない」── 呼び手は元の行 / 元の対象で
 *   進んでよい(既に閉じていた回も含め、system 側の結果は受け入れる)。
 * @returns `'sync'` なら**変更が無かった**(聞かずに閉じた)── `proceed` は
 *   **呼んでいない**。呼び手は自分の「進む」処理をその場で(同期に)続けてよい。
 *   `'async'` なら 3 択(または保存の ack)を待っている ── 呼び手はここで
 *   return する(進んだかどうかは、後から `proceed` が呼ばれるかどうかで分かる)。
 */
function withSectionDraftLeave<T = void>(
  dispatcher: Dispatcher,
  root: HTMLElement,
  draft: PartialDraft,
  opts: {
    captureBeforeSave?: () => T;
    proceed: (saved: boolean, captured: T | undefined) => void;
  },
): 'sync' | 'async' {
  const code = isCodeDraft(draft);
  const host = root.querySelector<HTMLElement>(BODY_HOST_SELECTOR);
  const current = host === null ? null : partialDraftBoxText(host, draft);
  const dirty = current !== null && current !== draft.original;
  const cancel = (): void => {
    dispatcher.dispatch(code ? { type: 'CANCEL_CODE_DRAFT' } : { type: 'CANCEL_SECTION_DRAFT' });
  };
  if (!dirty) {
    // ⚠ 変更が無ければ**聞かずに進む**(design「箱を閉じるだけ」)
    cancel();
    return 'sync';
  }
  void (async (): Promise<void> => {
    const choice = await pickSectionLeaveInApp(root, code ? 'code' : 'section');
    if (choice === 'stay') return;
    if (choice === 'discard') {
      cancel();
      opts.proceed(false, undefined);
      return;
    }
    // choice === 'save' ── 「保存して進む」は保存が成功したときだけ「保存できた」扱い
    /**
     * 🔴 **待つ間に system 側で下書きが閉じていたら、保存したと数えない**
     *   (#1044 段2 4巡目の修理、T7。5巡目の修理、U1でこの関数へ寄せ、両呼び手の
     *   共通の門にした)。
     *
     * ⚠ 直す前(`leaveSectionDraftOrAsk` 側)はここを見ずに `sectionBoxText(host ??
     *   root)` を読んでいた ── `host` はダイアログを開く**前**に掴んだ参照なので、
     *   待っている間に system 側(`guardSectionDraftTransition`)が下書きを閉じて
     *   `detail.ts` が骨組みを作り直すと、`host` は**外れた古い node**になる
     *   (CLAUDE.md §9「編集の作法」と同じ罠)。外れていても子は残るので
     *   `partialDraftBoxText` は**古い打ちかけの字**を拾ってしまい、そのまま
     *   SAVE を撃つと下書きが無いので無言の no-op、続く `waitSectionSaveSettled` は
     *   `sectionDraft === null` を見て**即 `'saved'`** を返す ── 何も書いていないのに
     *   「保存できた」扱いで進んでしまう(データは system が既に受け入れた結果に
     *   守られているので消えないが、成功の報告は嘘になる)。
     * 🔑 直しは**待つ前に閉じていたかを見る**:いま開いている下書きが
     *   まだ同じもの({@link sameDraftIdentity})かを確かめ、違えば(system が既に
     *   処理した)保存を試みずに進むだけにする。
     */
    const stillOpen = dispatcher.getState().sectionDraft;
    if (stillOpen === null || !sameDraftIdentity(stillOpen, draft)) {
      opts.proceed(false, undefined);
      return;
    }
    const text = partialDraftBoxText(host ?? root, draft);
    if (text === null) return;
    const captured = opts.captureBeforeSave?.();
    dispatcher.dispatch(code ? { type: 'SAVE_CODE_DRAFT', text } : { type: 'SAVE_SECTION_DRAFT', text });
    const outcome = await waitSectionSaveSettled(dispatcher);
    if (outcome === 'saved') {
      opts.proceed(true, captured);
    }
    // ⚠ 断られたら(sectionDraft が残る)進まない。断り文は state.error に出ている
  })();
  return 'async';
}

/**
 * 🔴 **その章だけを、その場の入力欄にする口**(#1044 段2 F-E)。
 *
 * ⚠ ロックは `startEditAt` と**同じノート単位**(`acquireEditLockOrExplain` を共有)──
 *   同じノートを別のタブで全文編集中なら、章の欄も開かない(設計 doc §3)。
 * ⚠ **reducer が拒否したら(章が引けない等)ロックを返す** ── 開けなかったのに
 *   ロックだけ握ったままにすると、以後そのノートが誰からも編集できなくなる。
 * 🔴 **同じノートに既に章の下書きが在るときは、`leaveSectionDraftOrAsk` と同じ
 *   3 択を通す**(#1044 段2、F-E)。⚠ 直す前は `OPEN_SECTION_DRAFT` の
 *   「二重に開かない」門(reducer)が無言に捨てていた ── 同じノートの
 *   **別の見出し**で「この章を編集する」を押しても、何も起きなかった。
 *   ⚠ このノートのロックは既に握ったまま(新たに取り直さない ── 同じ lid)。
 *
 * @param root 章の箱 / 3 択の pane を出す先(`leaveSectionDraftOrAsk` と同じ)
 * @param line 押した見出しの行(剥がした本文の行番号。`bodySourceLineAt` と同じ基準)
 */
function startSectionEditAt(
  dispatcher: Dispatcher,
  services: BinderServices,
  root: HTMLElement,
  line: number,
): void {
  const st0 = dispatcher.getState();
  const lid = st0.openBody?.lid ?? null;
  if (lid === null) return; // 開いている本文が無い(押せないはずの防波堤)
  const open = (openLine: number): void => {
    dispatcher.dispatch({ type: 'OPEN_SECTION_DRAFT', lid, line: openLine });
  };
  /**
   * 🔴 **開くのは、必ずこの口を通す**(#1044 段2 2巡目の修理、R1)。
   *
   * ⚠ 直す前は「同じノートの別の見出しへ切り替える」ときだけ、ここを通さずに
   *   `open()` を直に撃っていた ── `CANCEL_SECTION_DRAFT` / `SAVE_SECTION_DRAFT`
   *   は一瞬 `sectionDraft` を `null` にする(閉じてから開く、の間)。その一瞬を
   *   `bindEditLockRelease`(`unsavedTypingLidOf` 経由)が「もう書きかけが無い」
   *   と読み、握っていた編集ロックを**本当に手放す**(follower タブでは
   *   holder へ `edit-release` を送る)。そこで取り直さずに次の見出しを開くと、
   *   その隙に**別タブが同じノートを編集できてしまう**(#177 と同じ事故)。
   * 🔑 「閉じずに差し替える」専用の action は作らない ── **開く口は 1 本**
   *   (`acquireEditLockOrExplain` を通る経路。この関数がもともと持っていた
   *   「まだ章の下書きが無いとき」の経路と同じ)を、切り替えのときも必ず通す。
   */
  const openWithLock = (openLine: number): void => {
    if (!services.acquireEditLock) {
      const ready = services.settle?.() ?? null;
      if (ready === null) open(openLine);
      else void ready.then(() => open(openLine));
      return;
    }
    acquireEditLockOrExplain(dispatcher, services, lid, () => {
      open(openLine);
      if (dispatcher.getState().sectionDraft?.lid !== lid) services.releaseEditLock?.(lid);
    });
  };
  const draft = st0.sectionDraft;
  if (draft !== null && draft.lid === lid) {
    const body = st0.openBody!.body;
    const pressed = sectionAt(body, line + frontmatterLineCount(body));
    // ⚠ **コード枠の欄が開いているときは「同じ見出し」に当たらない**(#1044 段3)──
    //   `isCodeDraft` を先に見ないと `draft.heading` が narrow できない(tsc が守る)。
    if (!isCodeDraft(draft) && pressed !== null && pressed.text === draft.heading) {
      // ① 同じ見出し ── 開き直さず、箱にフォーカスを戻すだけ
      root.querySelector<HTMLTextAreaElement>(`[data-pkc-field="${SECTION_BOX_INPUT_FIELD}"]`)?.focus();
      return;
    }
    // ② 別の見出し(またはコード枠の欄が開いている)── withSectionDraftLeave の
    //    共通 3 択(#1044 段2 5巡目の修理、U1 / 段3 §9)
    const leave2 = withSectionDraftLeave(dispatcher, root, draft, {
      /**
       * 🔴 **保存を撃つ直前の本文で、押した見出しを名前で覚える**
       *   (#1044 段2 3巡目の修理、S1)。
       *
       * ⚠ 直す前は「行のずらし算」(`shiftLineAfterSectionSave`)だった ──
       *   保存後の本文は**effect が disk から読み直した**ものなので、
       *   「保存する前の本文 + 増減した行数」という前提が崩れている(別の窓が
       *   保存の合間に上の方へ書いていれば、増減はこちらの章の分だけでは済まない)。
       * 🔑 だから**行を計算しない**。押した見出しを「字 + 同じ字の中で何番目か」
       *   (`headingRefAt`)で覚え、保存が終わった**後**の本文からもう一度
       *   引き直す(`resolveHeadingRef`)── 追記先と同じ「そのつど本文から
       *   解く」作法(#395 段①)。⚠ `withSectionDraftLeave` は「保存を撃つ直前」
       *   (system 側で閉じられていないかを確かめた**後**)にこれを呼ぶ ── だから
       *   `dispatcher.getState().openBody?.body` は「これから撃つ保存の土台」と一致する。
       */
      captureBeforeSave: () => headingRefAt(dispatcher.getState().openBody?.body ?? body, line),
      /**
       * @param saved `false` なら「保存はしていない」(変更なし / 消して進む /
       *   待つ間に system 側で既に閉じていた ── T7 の対、U1)。どの回も**押した
       *   行のまま**開き直す(保存していないので、行のずれを気にする必要が無い)。
       */
      proceed: (saved, ref) => {
        if (!saved) {
          openWithLock(line);
          return;
        }
        const savedBody = dispatcher.getState().openBody?.body ?? null;
        const target =
          ref == null || savedBody === null ? null : resolveHeadingRef(savedBody, ref);
        const resolvedLine = target === null ? null : headingLine(savedBody!, target.slug);
        openWithLock(resolvedLine ?? line);
      },
    });
    // 🔑 `'sync'`(変更なし ── 聞かずに閉じた)は `proceed` が呼ばれていないので、
    //   ここで自分の続きを呼ぶ(`proceed(false, …)` と同じ「押した行のまま開く」)。
    if (leave2 === 'sync') openWithLock(line);
    return;
  }
  openWithLock(line);
}

/**
 * 🔴 **その枠だけを、その場の入力欄にする口**(#1044 段3)。⚠ **`startSectionEditAt`
 *   と同じ形**(ロック / 二重に開かない門 / 3 択)── 章の見出しの名前の代わりに、
 *   枠の身元({@link CodeFenceIdentity})で「同じ枠か」「別のどの枠へ開き直すか」を見る。
 *
 * @param line 押した枠の開きの行(**剥がした本文**の行番号。`bodySourceLineAt` /
 *   `OPEN_SECTION_DRAFT` と同じ基準)。⚠ `tableLineAt` は frontmatter 込みの行を
 *   返すので**基準が違う**(#1044 段3 2巡目の修理、V1)── 呼び手が引いてから渡す。
 */
function startCodeEditAt(
  dispatcher: Dispatcher,
  services: BinderServices,
  root: HTMLElement,
  line: number,
): void {
  const st0 = dispatcher.getState();
  const lid = st0.openBody?.lid ?? null;
  if (lid === null) return;
  const open = (openLine: number): void => {
    dispatcher.dispatch({ type: 'OPEN_CODE_DRAFT', lid, line: openLine });
  };
  const openWithLock = (openLine: number): void => {
    if (!services.acquireEditLock) {
      const ready = services.settle?.() ?? null;
      if (ready === null) open(openLine);
      else void ready.then(() => open(openLine));
      return;
    }
    acquireEditLockOrExplain(dispatcher, services, lid, () => {
      open(openLine);
      if (dispatcher.getState().sectionDraft?.lid !== lid) services.releaseEditLock?.(lid);
    });
  };
  const draft = st0.sectionDraft;
  if (draft !== null && draft.lid === lid) {
    /**
     * ⚠ **基準を揃えてから比べる**(#1044 段3、着地前レビュー 2 巡目の 🔴)──
     *   `draft.line` は**生の body** の行(`CodeDraft.line`)、`line` は**剥がした**行。
     *   そのまま比べると、frontmatter の行数と 2 つの枠の間隔が一致するノートでだけ
     *   別の枠を「同じ枠」と取り違え、押しても何も起きない。
     */
    if (isCodeDraft(draft) && draft.line === line + frontmatterLineCount(st0.openBody!.body)) {
      // ① 同じ枠 ── 開き直さず、箱にフォーカスを戻すだけ
      root.querySelector<HTMLTextAreaElement>(`[data-pkc-field="${CODE_BOX_INPUT_FIELD}"]`)?.focus();
      return;
    }
    // ② 別の枠(または章の欄が開いている)── withSectionDraftLeave の共通 3 択
    const body0 = st0.openBody!.body;
    /**
     * 🔴 **押した枠の身元を、保存を撃つ前に控える**(`startSectionEditAt` の
     *   `headingRefAt` と同じ理由)── 別の枠の保存で行がずれても、身元
     *   (開きの行の字 + 中身 + 引用の深さ)で開き直す枠を引き直せる。
     */
    const identityBefore = openCodeFenceAt(body0, line + frontmatterLineCount(body0));
    const leave2 = withSectionDraftLeave(dispatcher, root, draft, {
      captureBeforeSave: () => identityBefore,
      proceed: (saved, identity) => {
        if (!saved || identity == null) {
          openWithLock(line);
          return;
        }
        const savedBody = dispatcher.getState().openBody?.body ?? null;
        const located = savedBody === null ? null : locateCodeFence(savedBody, identity);
        /**
         * 🔴 **`located.fence.start` も frontmatter 込みの行**(`locateCodeFence` /
         *   `allFences` は `openCodeFenceAt` と同じ生の body の座標系 ── V1 と
         *   同じ形の三つ目の二重加算(#1044 段3 2巡目の修理)。⚠ `openWithLock` /
         *   `OPEN_CODE_DRAFT` は**剥がした本文の行**を受けるので、ここで 1 度だけ
         *   引く。引かずに渡すと frontmatter を持つノートで B を探し直した瞬間、
         *   もう一度足された行には枠が無く「このコード枠を編集できませんでした」
         *   に落ちる(V4 の frontmatter つき test が実地で捕まえた)。
         */
        openWithLock(
          located !== null && located.ok
            ? located.fence.start - frontmatterLineCount(savedBody ?? body0)
            : line,
        );
      },
    });
    if (leave2 === 'sync') openWithLock(line);
    return;
  }
  openWithLock(line);
}

/**
 * 🔴 **右クリックのメニューが運んできた「押した見出しの行」**(#426 段②)。
 *
 * ⚠ メニューの器は **root の直下**に出るので、押したボタンは押した物の中に居ない
 * ── だから受け手は `closest` では**必ず外す**。🔑 開くときにボタンへ写した
 * 行番号(`openContextMenu` の `carry`)を、ここで 1 か所だけ読む。
 * ⚠ 綴りをあちこちに写さない(§7)── この関数と `onContextMenu` の 2 か所だけが知る。
 */
const MENU_LINE_ATTR = 'data-pkc-menu-line';
/**
 * 🔴 **どのノートの行かも一緒に運ぶ**(#596 D)。
 *
 * ⚠ メニューが閉じるのは **押した / スクロールした / `Escape`** の 3 つだけなので、
 *   出したまま本文が別のノートへ替わりうる(開いた直後は焦点がメニューの先頭ボタンに
 *   移るので、鍵で移れる経路が 1 つでもあれば到達する)。
 * ⚠ そのとき運んだ行は**別のノートに効く** ── 畳む / 編集に入る / 追記先、
 *   どれも「押した物と効く先が食い違う」いちばん静かな形になる。
 * 🔑 **到達できるかを数え上げるより、行と一緒に身元を運ぶ** ── 受け手は
 *   自分の身元を確かめてから動く(状態の購読を増やさないので、束ねる側の台も壊さない)。
 */
/**
 * 🔴 **スマホで「一覧を見せてから効かせる」**(#632 段①、設計 doc §2-15)。
 *
 * ⚠ スマホでは一覧と本文が**同時に出ない**ので、#583 で直した
 *   「畳んでいたら戻してから効かせる」が**そのままでは効かない** ──
 *   隠れた欄に焦点を入れて無反応、という当の症状が戻る。
 * 🔑 判定は `appPhone.reveal` **1 か所**(呼び元 3 つで数え方を変えない)。
 * ⚠ 編集中は**理由を出して断る** ── 黙って何も起きないのが直したい当のことなので、
 *   ここで無言に戻してはいけない。
 *
 * @returns `false` = 断った(呼び側はそこで止める)。
 */
function phoneShowList(dispatcher: Dispatcher): boolean {
  /**
   * ⚠ **PC は 1 バイトも触らない**(一覧は最初から出ている)。
   * 🔑 この 1 行が守るのは **PC で編集中にタグ札を押したとき** ── 外すと下の
   *   `phase !== 'ready'` に落ちて、列が両方見えているのに
   *   「一覧で探してください」というスマホ用の字が出る(着地前レビュー 3)。
   */
  if (!appPhone.isPhone()) return true;
  const blocked = phaseBlockReason(dispatcher.getState().phase);
  if (blocked !== null) {
    // ⚠ 字は 1 か所から(C11 / #1045)── 直す前は「保存するか**取り消して**から」
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${blocked}、一覧で探してください` });
    return false;
  }
  if (appPhone.reveal('list') === 'needs-detail') {
    /**
     * 🔴 **面(設定・ヘルプ・2 ペイン・集計)を開いている間も、一覧まで出す**
     *   (着地前レビュー 3)。⚠ 面が開いたままだと `phonePageOf` は `pane` を
     *   返し続けるので、**一覧は画面に出ない** ── 結果は「焦点も入らない」=
     *   #583 で直した無言の dead key がそのまま戻る形だった。
     */
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
  }
  return true;
}

/** スマホで「別のウィンドウで開く」を押したときの 1 行(#1659 ②)。 */
export const PHONE_NOTE_WINDOW_NOTICE = 'この端末では、新しいタブで PKC3 がもう 1 つ開きます';

const MENU_LID_ATTR = 'data-pkc-menu-lid';
/**
 * 🔴 **右クリックした `:::` の塊の開き行**(#677)。`MENU_LINE_ATTR` とは**別の名前**で運ぶ
 * ── 見出しが `:::` の中に居るときは**見出しの行と塊の開き行が両方要る**ので、
 * 1 つの属性に載せると片方が消える。座標は同じ(frontmatter を剥いだ本文の行番号)。
 */
const MENU_BLOCK_ATTR = 'data-pkc-menu-block';
/**
 * 🔴 **右クリックした所の、本文の器の中での座標**(#676「ここに付箋を置く」)。
 * 器(`detail-body`)の左上からの px ── 板の `x=` / `y=` と同じ座標系(絶対配置の基準は
 * 器の padding box なので、`getBoundingClientRect` の左上から**枠線ぶん**(`clientLeft`)を
 * 引き、器がスクロールしていればその分を足す)。
 */
const MENU_X_ATTR = 'data-pkc-menu-x';
const MENU_Y_ATTR = 'data-pkc-menu-y';
/**
 * 🔴 **右クリックした表の、原文の行番号**(#708 段②)。⚠ `MENU_LINE_ATTR`(見出し)/
 * `MENU_BLOCK_ATTR`(`:::` の塊)とは**別の名前**で運ぶ ── 表が `:::` の中に在れば
 * 3 つとも同時に要る(1 つの属性へ載せると、載せた順で片方が消える)。
 * ⚠ 座標系は**生の body**(frontmatter 込み)── `csv-cell` / `task` と同じ。
 */
const MENU_TABLE_ATTR = 'data-pkc-menu-table';

/**
 * 🔴 **右クリックした画像の行と鍵**(#1640 ③)── メニューが運ぶ。行は生の body の行番号(frontmatter を足した座標)。
 * ⚠ 押した瞬間にしか読めない(メニューの器は root の直下で、画像の中に居ない ── `context-menu.ts` の戒め)。
 */
const MENU_IMAGE_LINE_ATTR = 'data-pkc-menu-image-line';
const MENU_IMAGE_KEY_ATTR = 'data-pkc-menu-image-key';
const MENU_IMAGE_NTH_ATTR = 'data-pkc-menu-image-nth';

/**
 * 🔴 **右クリックした本文の画像を、原文の行と突き合わせる**(#1640 ③)。
 *
 * 🔑 画像は段落の中に居るので、行は**囲む塊の範囲**(`data-pkc-source-line` 〜 `-end`)の中から、
 *   鍵が合う画像を持つ**最初の行**を探す(一致する書き方の判定は `findImageRef` 1 本 ── 書く側と共用)。
 * ⚠ 見つからなければ `null` = メニューを奪わない(ブラウザ既定の「画像を保存」を残す)。
 */
function imageAt(
  img: Element,
  body: string | null,
): { key: string; line: number; nth: number; attrs: ImageAttrs } | null {
  if (body === null) return null;
  const key = img.getAttribute('data-pkc-asset-key');
  if (key === null || key === '') return null;
  // ⚠ 段落・箇条書きの項目は `.pkc-md-block` ではない ── 刻印(`data-pkc-source-line`)を持ついちばん近い祖先を取る
  const block = img.closest<HTMLElement>('[data-pkc-source-line]');
  if (block === null) return null;
  const start = Number(block.getAttribute('data-pkc-source-line'));
  if (!Number.isInteger(start) || start < 0) return null;
  const endRaw = Number(block.getAttribute('data-pkc-source-end'));
  // ⚠ `data-pkc-source-end` は**最後の行を含む**(1 行の段落は line と同じ値)
  const end = Number.isInteger(endRaw) && endRaw >= start ? endRaw : start;
  const offset = frontmatterLineCount(body);
  const lines = body.split(/\r?\n/);
  // 🔴 同じ画像が何度も出るとき、押した 1 つを選ぶ: 塊の中の同じ鍵の画像を描画順に数えた番号を、行ごとの出現に割り当てる
  const same = [...block.querySelectorAll('img.pkc-asset-ref')].filter(
    (el) => el.getAttribute('data-pkc-asset-key') === key,
  );
  let rest = same.indexOf(img);
  if (rest < 0) return null;
  for (let n = start + offset; n <= Math.min(end + offset, lines.length - 1); n++) {
    const hits = findImageRefs(lines[n] ?? '', key);
    if (rest < hits.length) return { key, line: n, nth: rest, attrs: hits[rest]!.attrs };
    rest -= hits.length;
  }
  return null;
}

/**
 * 🔴 **画像の大きさ・寄せを書く受け手の実体**(#1640 ③)── 向きだけが違う 2 つを 1 本にする。
 * ⚠ 何を書くかの判断は `body-rewrite.ts`(`image-attrs`)── ここは**運ばれた行・鍵・値を渡し、断る理由を画面に出す**だけ。
 * 🔴 断りは黙らない:①メニューを出した後にノートが替わった ②忙しい(取り込み・書き出し) ③押した行が変わった。
 */
function setImageAttr(
  dispatcher: Dispatcher,
  target: HTMLElement,
  services: BinderServices,
  which: 'w' | 'align',
): void {
  const line = menuCarriedAt(target, MENU_IMAGE_LINE_ATTR);
  const key = target.getAttribute(MENU_IMAGE_KEY_ATTR);
  const nth = menuCarriedAt(target, MENU_IMAGE_NTH_ATTR);
  const raw = target.getAttribute(which === 'w' ? IMAGE_WIDTH_ATTR : IMAGE_ALIGN_ATTR);
  if (nth === null || line === null || key === null || key === '' || raw === null || refuseStaleMenu(dispatcher, target)) return;
  // ⚠ 読めない値は書かない(属性を書き換えられた形)。空は「もとに戻す」
  let patch: { w: number | null } | { align: ImageAlign | null };
  if (which === 'w') {
    const n = raw === '' ? null : Number(raw);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 100)) return;
    patch = { w: n };
  } else {
    if (raw !== '' && raw !== 'left' && raw !== 'center' && raw !== 'right') return;
    patch = { align: raw === '' ? null : raw };
  }
  const st = dispatcher.getState();
  const ob = st.openBody;
  if (ob === null) return;
  const lid = ob.lid;
  const blocked = bodyWriteBlockReason(st, lid);
  if (blocked !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: blockedWithSuffix(blocked, '画像の大きさを変えてください') });
    return;
  }
  if (services.busy?.() === true) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: '取り込みが終わってから、画像の大きさを変えてください' });
    return;
  }
  // 🔴 押した時点のその行の中身(#1087)── 別の窓が上へ行を足しても、別の画像を変えない
  const openLine = shownBodyLine(st, lid, line);
  if (openLine === null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: SHOWN_LINE_LOST });
    return;
  }
  actUnlessEditedElsewhere(
    dispatcher,
    services,
    [lid],
    '画像の大きさを変えられませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
    () => dispatcher.dispatch({ type: 'SET_IMAGE_ATTRS', lid, line, openLine, key, nth, ...patch }),
  );
}
/**
 * 🔴 **右クリックしたチェックリストの、項目の行番号**(#1173)。`,` で区切った**原文の行番号**
 * (`data-pkc-task-line` と同じ座標系)。⚠ 押した瞬間の DOM から数える ── メニューの器は
 * 本文の外に出るので、受け手の時点では読めない。
 */
const MENU_TASK_LINES_ATTR = 'data-pkc-menu-task-lines';
/**
 * 🔴 **右クリック(長押し)したブロックを動かすときの座標**(台帳 #1852 束 S1、依頼 238 の案 B)。
 * 動かす範囲(`start..end`)と入れる位置(`before`)は**生の body の行番号**(`MOVE_BLOCK` がそのまま読む)。
 * ⚠ 項目ごとに焼く(向きで入れる位置が違う)。メニューの器は本文の外に出るので、押した瞬間の DOM から数える。
 */
const MENU_BLOCK_START_ATTR = 'data-pkc-menu-block-start';
const MENU_BLOCK_END_ATTR = 'data-pkc-menu-block-end';
const MENU_BLOCK_BEFORE_ATTR = 'data-pkc-menu-block-before';

/**
 * 🔴 **右クリックした項目が属するリストの、チェック項目の行番号**(#1173)。無ければ `null`。
 *
 * ⚠ **字の上だけ**(`<input>` の上は呼び側が既定のメニューを残す)。引くのは
 *   `li.pkc-task-item` の**親のリスト**で、数えるのは**その中の全部の箱**(入れ子の子リストも含む)。
 * ⚠ 行番号は箱が焼いた `data-pkc-task-line` から読む(読む面だけが焼く ── 書き出し・印刷の
 *   `disabled` の箱には無いので、そこでは出ない)。
 */
function taskRunLinesAt(target: Element, host: HTMLElement | null): number[] | null {
  // 🔴 付箋の中(#529 W5-c)── 行番号は置いたノートの行で、メニューが運ぶ lid は板のもの。
  //    出すと板のノートの別の行を書き換える。付箋の中には一括の項目を出さない
  if (target.closest('[data-pkc-field="place-body"]') !== null) return null;
  const li = target.closest('li.pkc-task-item');
  if (li === null || host === null || !host.contains(li)) return null;
  const list = li.closest('ul, ol');
  if (list === null) return null;
  const lines: number[] = [];
  for (const box of list.querySelectorAll('input.pkc-task-checkbox[data-pkc-task-line]')) {
    const n = Number(box.getAttribute('data-pkc-task-line'));
    if (Number.isInteger(n) && n >= 0) lines.push(n);
  }
  return lines.length === 0 ? null : lines;
}

/**
 * 🔴 **押した所の表が、原文の何行目から始まるか**(#708 段②)。表でなければ `null`。
 *
 * 🔑 引くのは**塊(`.pkc-md-block`)に焼かれた行**である ── 表の升から
 *   `closest('[data-pkc-source-line]')` すると `<tr>` に当たり、**行ごとに違う番号**が
 *   返る(csv の囲みは `<tr>` に焼いていないので、そちらだけ塊に当たる = 非対称)。
 *   塊から引けば markdown の表も csv の囲みも**同じ 1 つの引き方**で済む(§7)。
 * ⚠ 描画の行番号は **frontmatter を剥いだ本文**のものなので、その行数を足して
 *   生の body の座標へ写す(`place-board.ts` の `lineOffset` と同じ規律)。
 */
function tableLineAt(target: Element, body: string | null): number | null {
  if (body === null) return null;
  const block = target.closest<HTMLElement>('.pkc-md-block[data-pkc-source-line]');
  if (block === null) return null;
  const at = Number(block.getAttribute('data-pkc-source-line'));
  if (!Number.isInteger(at) || at < 0) return null;
  return at + frontmatterLineCount(body);
}

/**
 * 🔴 **メニューを出す前に開いていたノート**(#685 動線レビュー 欠陥 2、2026-09-04)。
 *
 * ⚠ 行を右クリックすると `selectEntryOrExplain` が**その行を選ぶ**ので、中央の本文は
 *   その時点で入れ替わる。ふつうの操作(消す / 書き出す)はそれで正しいが、
 *   **付箋だけは正しくない** ── 付箋の売りは「本文を退かさない」で、
 *   お知らせにも「開いても、いま読んでいる画面はそのままです」と書いた。
 *   ⚠ いまの形だと、一覧の行から開いた回だけ**その文が嘘になる**
 *   (読んでいた A が消え、同じ B が 2 枚並ぶ)。
 * 🔑 だから**出す前の lid を持たせておき、付箋を開いたら戻す**。
 * ⚠ 持たせるのは行のメニューだけ ── 本文のメニューと情報ペインのボタンは
 *   **もともと開いているノート**を指すので、戻す相手が無い(属性も付かない)。
 */
const MENU_PREV_LID_ATTR = 'data-pkc-menu-prev-lid';

/**
 * 🔴 **「探す」の行が持つ、探した語**(#1102 段①)。⚠ 綴りは `render/search.ts` が焼く物と
 * **同じ字**(`SEARCH_FIND_ATTR`)── 2 か所に書かない(§7)。
 */
const FIND_ATTR = SEARCH_FIND_ATTR;
/**
 * 🔴 **押したときだけ、その行を選んでから効かせる**(#1045 C9、着地前レビューで直した)。
 *
 * ⚠ 2 ペインの右クリックは**選択を動かさずに**行のメニューを出す(開いただけで
 *   中央が切り替わらないため)。ところが中身を**中央の本文の画面に出す**項目
 *   (「履歴」「このスタックを載せる」)は、2 ペインのままだと状態だけ書き換わって
 *   **画面に何も出ない**(無言の dead click)。「この中に新しいノートを作る」は
 *   押した瞬間に自分で本文の画面へ移る。
 * 🔑 だから**押したときに**その行を選ぶ(= C9 の前と同じ動き)── メニューを開いた
 *   だけでは移らない。受け手は `run` の 1 か所で、属性を持つ項目にだけ効く。
 */
const MENU_SELECT_FIRST_ATTR = 'data-pkc-menu-select-first';
/**
 * 2 ペインの右クリックで「押したらその行を選ぶ」項目 ── **中身を中央の本文の画面に出す**物だけ。
 * ⚠ 足すときは「2 ペインのまま押して、画面に何か出るか」を 1 度見る(出ないなら足す)。
 */
const DUAL_MENU_SELECT_FIRST: ReadonlySet<string> = new Set([
  'show-history',
  'stack-load',
  'create-in-folder',
]);

/**
 * 🔴 **クリックでメニューを開く受け手**(#632 段①)。⚠ ここに載せ忘れると、
 * その受け手は**押しても無反応**になる(同じクリックで片づけ役が閉じる)。
 * ⚠ 右クリック(`contextmenu`)で開く経路はここに載らない ── あちらは別の event。
 */
/**
 * 🔴 **押すとメニューが開くボタン**の一覧。
 *
 * ⚠ 載せないと、**同じ 1 回のクリック**でここが開き `onCloseMenu` が閉じるので、
 *   **押しても何も出ない**(`phone-menu` が踏んだ罠)。
 * ⚠ 逆に、**押すと畳む**だけの物(見出しの頭)は載せない ── 載せると
 *   「メニューが出ている間に見出しを押しても閉じない」という別の穴になる。
 */
const MENU_OPENERS: ReadonlySet<string> = new Set([
  'phone-menu',
  // 🔑 #1621 ── 左の列の帯に入りきらない操作の一覧(「⋯」)
  'open-bar-more',
  'open-repeat-menu',
  // 🔑 台帳 #1852 束 S1(依頼 128-2)── 予定の札の「⋯」(右クリックのメニューと同じ物を開く)
  'open-task-menu',
  // 🔑 #918 段②a ── 前に打った SQL の一覧(指で触る端末の唯一の入口)
  'sql-history-menu',
  // 🔑 #918 段④ ── 答えを file へ出す形(csv / tsv / json)の一覧
  'sql-export-menu',
]);

/**
 * 🔴 **予定の札の「⋯」が、合成した `contextmenu` を送っている最中**(台帳 #1852 束 S1、依頼 128-2 A)。
 * 指で長押しした札のメニューは出さない(長押しはドラッグだけ)が、「⋯」を押して開くメニューは出す ──
 * 受け手が両者を見分けるための印。⚠ 同期の 1 回の送りの中だけ立つ(`finally` で必ず降ろす)。
 */
let taskMenuFromButton = false;

/**
 * 🔴 **指の長押しで来た `contextmenu` が、ドラッグだけにしたい予定の札の上か**(台帳 #1852 束 S1、依頼 128-2 A)。
 * Android のブラウザは約 0.5 秒の長押しで `contextmenu` を撃つ。予定の札は同じ 0.5 秒でドラッグも始まる(`schedule-drag.ts`)ので、
 * 両方起きて「メニューが開いて一覧が押せないまま、ドラッグした予定をどこへも置けない」になっていた。
 * ⚠ 「⋯」の無い面(週・月の升)は従来どおり(メニューへ入る道がそこには他に無い)。
 * ⚠ マウスの右クリックは止めない(`isTouchClick` が偽)。
 */
function suppressTouchTaskMenu(ev: MouseEvent, target: Element): boolean {
  if (taskMenuFromButton || !isTouchClick(ev)) return false;
  const card = target.closest('article[data-pkc-entry]');
  if (card === null || card.querySelector('[data-pkc-field="task-menu"]') === null) return false;
  return card.closest('[data-pkc-region="schedule-cards"], [data-pkc-field="schedule-day-lane"]') !== null;
}

/**
 * メニューが出た時のノートと、いま開いているノートが同じか。
 * ⚠ 印を持たない押し(見出しの頭のボタン等)は**素通し** ── そちらは押した物の
 *   中に居るので、そもそも取り違えようがない。
 */
function menuStillFits(dispatcher: Dispatcher, target: Element): boolean {
  const was = target.getAttribute(MENU_LID_ATTR);
  return was === null || was === (dispatcher.getState().openBody?.lid ?? '');
}

/**
 * 🔴 **ふつうの付箋の字を直す欄を開く**(#1662 1)。相手は押した付箋(開き行の行番号は描画が焼いた
 * `data-pkc-place-line`)で、どの枠の板かは `lidOfNode` の 1 本で引く(横に留めた枠の付箋でも別のノートを書かない)。
 * ⚠ 編集中などで書けないときは、欄を開く前に理由を言う(開いても書けない欄を出さない)。
 */
function openPlaceTextEditor(dispatcher: Dispatcher, sticky: HTMLElement): void {
  const host = sticky.closest<HTMLElement>('[data-pkc-field="detail-body"]');
  const lineRaw = sticky.getAttribute('data-pkc-place-line');
  const st = dispatcher.getState();
  const lid = lidOfNode(sticky, st.openBody?.lid ?? null);
  if (host === null || lineRaw === null || lid === null) return;
  const line = Number(lineRaw);
  const blocked = bodyWriteBlockReason(st, lid);
  if (blocked !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: blockedWithSuffix(blocked, `付箋の字を直してください`) });
    return;
  }
  const shown = screenBodyOf(st, lid);
  const text = shown === null || !Number.isInteger(line) ? null : placeTextOf(shown, line);
  if (text === null) return; // 付箋の字を持たない塊(閉じていない / 板でない)── 押しても何も起きない口を出さない
  openPlaceInline(host, sticky, 'text', lid, text.replace(/^\n+/, '').replace(/\s+$/, ''), String(line));
}

/** 付箋の上の欄を確定する(追記 / 題名 / 付箋の字)。⚠ 断られたら**欄を閉じず、字を残して理由を言う**。 */
async function commitPlaceInline(
  dispatcher: Dispatcher,
  services: BinderServices,
  from: Element,
): Promise<void> {
  const el = from.closest<HTMLElement>('[data-pkc-field="place-inline"]');
  if (el === null || el.hasAttribute('data-pkc-busy')) return;
  const host = el.parentElement;
  const lid = el.getAttribute('data-pkc-entry') ?? '';
  const mode = el.getAttribute('data-pkc-mode');
  if (host === null || lid === '') return;
  const text = placeInlineText(el);
  const title = text.replace(/\s+/g, ' ').trim();
  const meta = dispatcher.getState().entryMetas.get(lid);
  if (meta === undefined) {
    showPlaceInlineNote(el, 'ノートが見つかりません(消されたかもしれません)');
    return;
  }
  const refuse = (why: string): void => {
    // 理由は画面の下の知らせにも出す(欄が見えない位置でも気づける)。字は欄に残す
    dispatcher.dispatch({ type: 'OP_FAILED', error: why });
    if (el.isConnected) showPlaceInlineNote(el, why);
  };
  if (mode === 'text') {
    /**
     * 🔴 **ふつうの付箋の字を書く**(#1662 1)。⚠ 書き先は板のノート(`lid`)の本文で、置いたノートは無い。
     * 欄を開いた後に本文が動いていたら、押した付箋を見失う ── 理由を言って字は欄に残す。
     * 🔑 **構造を壊す字は、頼む前に断る**(行頭の `:::` や ``` は付箋の枠を閉じる / 伸ばす)── 書込側でも同じ関数で断るが、
     *   そちらの断りは「本文が変わっているため」としか言えない。
     */
    const line = Number(el.getAttribute('data-pkc-place-line'));
    const st = dispatcher.getState();
    const shown = screenBodyOf(st, lid);
    const before = shown === null ? null : placeTextOf(shown, line);
    if (shown === null || before === null) {
      refuse('この付箋が見つかりません(本文が変わったかもしれません。付箋をもう一度ダブルクリックしてください)');
      return;
    }
    const norm = (t: string): string => t.replace(/^\n+/, '').replace(/\s+$/, '');
    if (norm(text) === norm(before)) {
      closePlaceInline(host);
      return;
    }
    const openLine = shown.split('\n')[line] ?? '';
    if (setPlaceText(shown, { line, openLine }, before, text) === null) {
      refuse('この字は付箋に入れられません(行の先頭に ::: や ``` を書くと、付箋の枠が途中で閉じてしまいます)');
      return;
    }
    el.setAttribute('data-pkc-busy', '');
    try {
      const elsewhere = await editedElsewhereReason(dispatcher, services, lid);
      if (elsewhere !== null) {
        refuse(elsewhere);
        return;
      }
      dispatcher.dispatch({ type: 'SET_PLACE_TEXT', lid, line, text });
      // 断りは reducer が理由つきで出す(編集中など)── 出ていなければ閉じる
      if (dispatcher.getState().error !== null && dispatcher.getState().error !== st.error) {
        if (el.isConnected) showPlaceInlineNote(el, dispatcher.getState().error ?? '');
        return;
      }
      if (el.isConnected) closePlaceInline(host);
    } finally {
      el.removeAttribute('data-pkc-busy');
    }
    return;
  }
  if (mode === 'rename') {
    if (title === '') {
      showPlaceInlineNote(el, '題名を入れてください');
      return;
    }
    if (title === meta.title) {
      closePlaceInline(host);
      return;
    }
  } else {
    if (text.trim() === '') {
      showPlaceInlineNote(el, '足す字を入れてください');
      return;
    }
    if (!isAppendable(meta.archetype)) {
      refuse('このノートには追記できません(追記できるのはノートとログです)');
      return;
    }
  }
  el.setAttribute('data-pkc-busy', '');
  try {
    const elsewhere = await editedElsewhereReason(dispatcher, services, lid);
    if (elsewhere !== null) {
      refuse(elsewhere);
      return;
    }
    if (mode === 'rename') {
      renameOfferingUndo(dispatcher, lid, () => {
        dispatcher.dispatch({ type: 'RENAME_ENTRY_TITLE', lid, title });
      });
      if (dispatcher.getState().entryMetas.get(lid)?.title !== title) {
        refuse('いまは題名を直せません(取り込み中などです。終わってからもう一度お試しください)');
        return;
      }
      if (el.isConnected) closePlaceInline(host);
      return;
    }
    // 🔑 書くのは**本文の下の追記欄と同じ 1 本**(`APPEND_TO_ENTRY`)── 結末(書けた / 断られた)まで待つ
    const r = await appendAndSettle(
      dispatcher,
      lid,
      text,
      appendHeadingFor(meta.archetype, new Date()),
      10000,
    );
    if (r.ok) {
      if (el.isConnected) closePlaceInline(host);
      // 🔴 足したことを言い、「元に戻す」を出す(片道にしない)── 状態の行の「元に戻す」は
      //   `noticeOpen` が `lastAppend.lid` と一致する知らせの隣に出る(`status-open.ts`)。
      //   板の付箋は開いていないノートへ足すので、これが唯一の戻し方である。
      dispatcher.dispatch({ type: 'OP_NOTICE', message: `『${meta.title}』の末尾に追記しました`, open: lid });
      return;
    }
    refuse(
      r.reason === 'timeout'
        ? '書けたかどうか確かめられませんでした(ノートを開いて確かめてください。字は欄に残してあります)'
        : (r.error ?? '追記できませんでした(いま保存中か、編集中です。少し待ってもう一度お試しください)'),
    );
  } finally {
    el.removeAttribute('data-pkc-busy');
  }
}

/**
 * 🔴 **付箋の中身(`place-body`)の中のチェックなら、置いたノートの lid**(#529 W5-c)。それ以外は `null`。
 * ⚠ 引くのは付箋の枠の `data-pkc-place-entry` ── 板のノートの lid でも `selectedLid` でもない。
 */
function placedTaskLidOf(from: Element): string | null {
  const slot = from.closest('[data-pkc-field="place-body"]');
  if (slot === null) return null;
  const lid = slot.closest('.pkc-place[data-pkc-place-entry]')?.getAttribute('data-pkc-place-entry') ?? '';
  return lid === '' ? null : lid;
}

/** 押した付箋(`.pkc-place[data-pkc-place-entry]`)と、それを含む本文の器。 */
function placeBlockOf(from: Element): { block: HTMLElement; host: HTMLElement; lid: string } | null {
  const block = from.closest<HTMLElement>('.pkc-place[data-pkc-place-entry]');
  const host = from.closest<HTMLElement>('[data-pkc-field="detail-body"]');
  const lid = block?.getAttribute('data-pkc-place-entry') ?? '';
  if (block === null || host === null || lid === '') return null;
  return { block, host, lid };
}

/**
 * 付箋の右クリックの「題名を直す」(#529 W5-b)。出せる付箋でなければ空。
 * 受け手が読む値(`data-pkc-place-lid` / `-line`)は**この項目だけ**に載せる(`attrs`)。
 */
function placeRenameItem(dispatcher: Dispatcher, target: Element): MenuItem[] {
  const hit = placeBlockOf(target);
  if (hit === null) return [];
  const st = dispatcher.getState();
  if (st.entryMetas.get(hit.lid) === undefined || hit.lid === st.openBody?.lid) return [];
  return [
    {
      ...PLACE_RENAME_ACTION,
      attrs: {
        'data-pkc-place-lid': hit.lid,
        'data-pkc-place-line': hit.block.getAttribute('data-pkc-place-line') ?? '',
      },
    },
  ];
}

/**
 * 身元が合わなければ**理由を出して**断る。
 *
 * ⚠ 押した瞬間にメニューは畳まれる(`onCloseMenu`)ので、黙って `return` すると
 * user から見て「**メニューが消えて何も起きない**」= dead click になる
 * (着地前レビュー ⚠6)。同じ file の `pickAppendTarget` / `startEditAt` は
 * 断るときに理由を出している ── ここだけ無言にしない。
 *
 * @returns 断ったか(`true` なら呼び手は何もしない)
 */
function refuseStaleMenu(dispatcher: Dispatcher, target: Element): boolean {
  if (menuStillFits(dispatcher, target)) return false;
  dispatcher.dispatch({
    type: 'OP_NOTICE',
    message: '別のノートに切り替わったので、出ていたメニューは効きません',
  });
  return true;
}

/** 「上へ / 下へ」の受け手の実体(向きだけが違う 2 つを 1 本にする ── §7)。 */
function moveStackLink(
  dispatcher: Dispatcher,
  target: HTMLElement,
  dir: 'up' | 'down',
  services: BinderServices,
): void {
  const raw = target.getAttribute('data-pkc-line');
  const line = Number(raw);
  if (raw === null || !Number.isInteger(line) || line < 0) return;
  const st = dispatcher.getState();
  const lid = lidOfNode(target, st.openBody?.lid ?? st.selectedLid);
  if (lid === null || lid === undefined) return;
  // 🔴 別のタブ・窓が編集中のノートへは撃たない(#1087。`toggle-task` と同じ門。押した瞬間の lid / 行を撃つ)
  actUnlessEditedElsewhere(
    dispatcher,
    services,
    [lid],
    '並べ替えられませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
    () => dispatcher.dispatch({ type: 'MOVE_STACK_LINK', lid, line, dir }),
  );
}

/**
 * 🔴 **表の形を変える受け手の実体**(#708 段②)── 向きだけが違う 2 つを 1 本にする。
 *
 * ⚠ **黙って断らない**(user 裁定 2026-09-04)。断る形は 3 つあり、**理由を書き分ける**:
 *   ①メニューを出した後にノートが替わった(`refuseStaleMenu` が言う)
 *   ②押した所に表が無くなった(別の窓が本文を動かした)
 *   ③**式 / 升の中の改行**が在って markdown にできない(`tableConvertRefusal`)。
 * 🔑 ③の判定は `table-convert.ts` の 1 か所 ── 書く側(`body-rewrite.ts`)も
 *   **同じ関数**で断るので、画面に出した理由と実際の振る舞いがずれない(§7)。
 * ⚠ ただし**ここで通しても、書く側でもう一度検める** ── 読んでから書くまでの間に
 *   別の窓が式を書いていれば、判定できるのはあちらだけである。
 */
function setTableFormat(
  dispatcher: Dispatcher,
  target: HTMLElement,
  to: TableFormat,
  services: BinderServices,
): void {
  const line = menuCarriedAt(target, MENU_TABLE_ATTR);
  if (line === null || refuseStaleMenu(dispatcher, target)) return;
  applyTableFormat(dispatcher, services, line, to);
}

/**
 * 🔴 **表の形を変える判定と実行**(#708 段② / 裁定②)。
 *
 * ⚠ **入口は 2 つ、判定は 1 つ**(§7)── 右クリックのメニュー(`setTableFormat`)と、
 *   表の右上の「▾」の小窓(`copy-md-block`)。⚠ 指で触る端末には右クリックが無いので、
 *   後者が**唯一の入口**である(user 裁定 2026-09-06)。
 * 🔑 断る理由も**ここ 1 か所**で言う ── 入口ごとに書くと、片方だけ黙る。
 */
function applyTableFormat(
  dispatcher: Dispatcher,
  services: BinderServices,
  line: number,
  to: TableFormat,
  header?: boolean,
): void {
  const st = dispatcher.getState();
  /**
   * 🔴 **断りは lid で判定する**(C6 / #1043)。⚠ この操作は主の枠(`openBody`)の
   *   表にしか効かない(右クリックの表メニューは `detail-body` だけに出る)ので、
   *   編集中は実質いつも同じ lid になる ── それでも判定は他の 6 case と同じ
   *   `bodyWriteBlockReason` に揃える(§7「同じ判定を複数の場所に書かない」)。
   */
  const blocked = bodyWriteBlockReason(st, st.openBody?.lid ?? '');
  if (blocked !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: blockedWithSuffix(blocked, `表の形を変えてください`) });
    return;
  }
  /**
   * 🔴 **忙しい間の門は、action の名前ではなく「書く瞬間」に置く**
   * (着地前レビュー・動線 D3、2026-09-06)。
   *
   * ⚠ 1 稿目は `copy-md-block` を `BODY_WRITE_ACTIONS` に載せた ── ところが
   *   その action は表だけの受け手ではなく、**本文中のすべての ⧉**
   *   (コードの囲み・mermaid / chart / html / svg・表)が同じ名前で受ける
   *   (`markdown-render.ts` の 4 か所)。つまり**コピーが 1 つ残らず止まる**。
   * ⚠ しかも `services.busy` は書き出し / 取込だけでなく
   *   **添付の取り込みと整理**でも真になる(`main.ts` の `withAssetGate`)ので、
   *   写真を 1 枚入れた直後にコードをコピーすると
   *   「書き出し / 取込が実行中です」と出る ── **押した所と理由が食い違う**。
   * 🔑 コピーは**読むだけ**なので止める理由が無い。止めるのは本文を書く
   *   この 1 か所だけにし、字もその操作の言葉にする。
   * ⚠ 名前の門から外したぶん、`tests/repo-hygiene.test.ts` は
   *   **この関数が `busy` を検めていること**を機械で確かめる
   *   (外すだけだと tripwire を 1 つ撤廃したのと同じになる)。
   */
  if (services.busy?.() === true) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: '取り込みが終わってから、表の形を変えてください',
    });
    return;
  }
  const ob = st.openBody;
  const at = ob === null ? null : tableAt(ob.body, line);
  if (ob === null || at === null) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: '表の範囲を読めませんでした(本文を開き直してください)',
    });
    return;
  }
  // ⚠ 見出しの切り替え(#1662 3)は形を変えない ── 式や改行で断る理由は無い
  const why = header === undefined ? tableConvertRefusal(at, to) : null;
  if (why !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: why });
    return;
  }
  /**
   * 🔴 **押した時点のその行の中身**(#1087)。⚠ 行番号だけだと、別の窓が上へ行を足したあと、
   *   同じノートの**別の表**(2 つ目の表を押したのに 1 つ目)が変わる。画面の本文から引き、引けなければ断る。
   */
  const openLine = shownBodyLine(st, ob.lid, line);
  if (openLine === null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: SHOWN_LINE_LOST });
    return;
  }
  /**
   * 🔴 **別のタブ・窓が編集中のノートの表は、形を変えない**(#1087。行・列を消す回と同じ門)。
   * ⚠ 通すと編集中のタブの保存で上書きされ、変えた結果は履歴にだけ残る。押した瞬間の値は上で捕えてある。
   */
  const lid = ob.lid;
  actUnlessEditedElsewhere(
    dispatcher,
    services,
    [lid],
    '表の形を変えられませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
    () =>
      dispatcher.dispatch({
        type: 'SET_TABLE_FORMAT',
        lid,
        line,
        openLine,
        to,
        ...(header === undefined ? {} : { header }),
      }),
  );
}

/**
 * 🔴 **リストを丸ごとそろえる受け手の実体**(#1173)── 向きだけが違う 2 つを 1 本にする。
 * ⚠ 何をするかの判断は `body-rewrite.ts`(`applyTaskRun`)── ここは**運ばれた行を渡す**だけ。
 *   断りは reducer(`SET_TASK_RUN`)が lid で言う(`toggle-task` と同じ)。
 */
function setTaskRun(
  dispatcher: Dispatcher,
  target: HTMLElement,
  to: 'done' | 'open',
  services: BinderServices,
): void {
  if (refuseStaleMenu(dispatcher, target)) return;
  const raw = target.getAttribute(MENU_TASK_LINES_ATTR) ?? '';
  const lines = raw
    .split(',')
    .filter((x) => x !== '')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
  const lid = target.getAttribute(MENU_LID_ATTR) ?? '';
  if (lines.length === 0 || lid === '') return;
  /**
   * 🔴 **押した時点の各行の中身を添える**(#1087)。⚠ 運ばれた行番号は右クリックで開いた時点の本文のもの ──
   *   別の窓が上へ足していれば、番号は別の項目を指す。画面が見ている本文(リストは本文の面にしか出ない)から引く。
   *   1 行でも引けなければ撃たずに断る(一部だけ空で運ぶと、その行が黙って飛ばされる)。
   */
  const st = dispatcher.getState();
  const openLines: string[] = [];
  for (const n of lines) {
    const text = shownBodyLine(st, lid, n);
    if (text === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: SHOWN_LINE_LOST });
      return;
    }
    openLines.push(text);
  }
  // 🔴 別のタブ・窓が編集中のノートへは撃たない(#1087。`toggle-task` と同じ門)
  actUnlessEditedElsewhere(
    dispatcher,
    services,
    [lid],
    'チェックできませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
    () => dispatcher.dispatch({ type: 'SET_TASK_RUN', lid, lines, openLines, to }),
  );
}

function menuCarriedLine(target: Element): number | null {
  return menuCarriedAt(target, MENU_LINE_ATTR);
}

/** 右クリックのメニューが運んできた `:::` の塊の開き行(#677)。無ければ `null`。 */
function menuCarriedBlock(target: Element): number | null {
  return menuCarriedAt(target, MENU_BLOCK_ATTR);
}

/** 運ばれた行番号を 1 つ読む(読み方は 2 つの属性で同じ)。 */
function menuCarriedAt(target: Element, attr: string): number | null {
  const raw = target.getAttribute(attr);
  if (raw === null) return null;
  const line = Number(raw);
  return Number.isInteger(line) && line >= 0 ? line : null;
}

/**
 * 🔴 **右クリックした所を包む `:::` の塊**(#677)。
 *
 * 押した所から刻印(`data-pkc-source-line`)を持つ祖先を**内側から外側へ**辿り、
 * その刻印の行が `:::` の開きである**最初の物**を返す ── 入れ子なら内側が当たる。
 * 段落・見出し・fence の刻印は素通りする(`blockSpanAt` が `null` を返す)。
 *
 * 🔑 塊かどうかは**原文**で決める(`blockSpanAt`)── DOM の class 名
 *   (section / format / details / quote …)を並べると、描画が 1 つ増えた日に静かに漏れる。
 * 🔑 板かどうかも原文で決める(`isPlaceOpen` = 描画が板と読む当の判定)。
 *
 * @param fmBody frontmatter を剥いだ本文(刻印と同じ座標系)
 */
function directiveBlockAt(
  host: HTMLElement,
  target: Element,
  fmBody: string,
): {
  line: number;
  board: boolean;
  shape: PlaceShape | null;
  styled: boolean;
  size: PlaceSize;
  group: string | null;
  groupable: boolean;
  rotate: number;
  rotated: boolean;
  front: boolean;
} | null {
  let el: Element | null = target.closest('[data-pkc-source-line]');
  while (el !== null && el !== host && host.contains(el)) {
    const line = Number(el.getAttribute('data-pkc-source-line'));
    if (Number.isInteger(line) && line >= 0 && blockSpanAt(fmBody, line) !== null) {
      const open = fmBody.split('\n')[line] ?? '';
      // 🔑 形も**原文**から読む(#530)── 板かどうかと同じ 1 本(`place-notation.ts`)
      return {
        line,
        board: isPlaceOpen(open),
        shape: placeShapeAt(open),
        // 🔑 色の札も**原文**から読む(#530 段④)── 描画・書き出しと同じ 1 本(`placeStyleAt`)
        styled: placeStyleAt(open)?.any === true,
        size: placeStyleAt(open)?.size ?? 'standard',
        // 🔴 回転(#530 段⑤d)── これも原文から読む(描画・書き出しと同じ 1 本)
        rotate: placeStyleAt(open)?.rotate ?? 0,
        rotated: placeStyleAt(open)?.written.rotate === true,
        // 🔴 既にいちばん前なら「前へ出す」を出さない(#1087)── `raisePlace` と同じ 1 本
        front: placeIsFrontmost(fmBody, line),
        // 🔑 グループも**原文**から読む(#530 段⑤b)── 入っているか / まとめる相手が居るか(1 本: `placeGroupAt` / `placeGroupItems`)
        group: placeGroupAt(open),
        groupable:
          placeGroupAt(open) === null &&
          isPlaceOpen(open) &&
          placeGroupItems(fmBody).filter((it) => it.group === null).length >= 2,
      };
    }
    el = el.parentElement?.closest('[data-pkc-source-line]') ?? null;
  }
  return null;
}

/**
 * 原文の行範囲をクリップボードへ写す(章 / 塊のコピー共通。#677)。
 * ⚠ 結果の字は `copyText` に渡す(押しても画面が変わらない操作なので、黙って終えない)。
 */
function copySourceLines(
  dispatcher: Dispatcher,
  services: BinderServices,
  fmBody: string,
  span: { readonly start: number; readonly end: number },
  done: string,
): void {
  if (services.copyText === undefined) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: 'このタブの PKC3 が古いままのため、コピーできません。再読み込みしてください' });
    return;
  }
  services.copyText(sliceLines(fmBody, span), done);
}

/**
 * メニューから押されたときの「その見出し」。
 *
 * 🔑 **押した所から辿れるならそちらが正しい**(見出しの頭の小さなボタン)。
 * 辿れないときだけ、運んできた行から引き直す。
 *
 * ⚠ **2 本は排他である**(着地前レビュー ⚠6 で言い直した)── 運ぶ印を持つのは
 * `openContextMenu` が**器の直下**に組むボタンだけで、見出しの中には決して居ない。
 * だから順番を入れ替えても挙動は 1 つも変わらない ── 1 稿目は「この向きでなければ
 * ならない」と書いていたが、**外して壊れることを 1 度も見ていなかった**
 * (CLAUDE.md「これが無いと壊れる、と書く前に外して壊れるのを見る」)。
 */
function headingForAction(root: HTMLElement, target: Element): Element | null {
  const direct = target.closest('h1,h2,h3,h4,h5,h6');
  if (direct !== null) return direct;
  const line = menuCarriedLine(target);
  if (line === null) return null;
  const host = root.querySelector<HTMLElement>(BODY_HOST_SELECTOR);
  return host === null ? null : headingAtSourceLine(host, line);
}

/**
 * 🔴 **押した所の節を、追記先にする**(#495。user 裁定 2026-08-27)。
 *
 * > 「センターペインの**追記位置指定は Alt+クリック**にしましょう」
 *
 * 🔑 **追記先の正本は `<select>` そのもの**(`append-entry` がここから読む)──
 *   state に 2 本目の持ち場を作らない(§7)。押した結果は**その `<select>` が
 *   変わって見える**ことで user に届く。
 * ⚠ **黙って何も起きないを作らない** ── 選べないときは理由を出す。
 * ⚠ **上に見出しが無いときは追記先を変えない** ── 「末尾」へ落とすと、
 *   文書の上のほうを押したのに**いちばん下へ入る**(いちばん静かな取り違え)。
 */
function pickAppendTarget(dispatcher: Dispatcher, root: HTMLElement, line: number): void {
  const st = dispatcher.getState();
  /**
   * 🔴 **追記欄が画面に出ている面でだけ受ける**(2 稿目。user 目線レビュー F)。
   *
   * ⚠ `<select>` は `AppendBoxRenderer` が**器を 1 度だけ組む**ので、追記できない
   *   ノート(添付・フォルダ)でも `querySelector` は**畳まれた物を掴む** ──
   *   しかも中身は**さっきまで見ていた別のノートの見出し**のままなので、
   *   1 稿目は「『はじめに』は追記先に選べません」という
   *   **追記欄が 1 つも見えていない画面で、追記についての断り文**を出していた。
   * 🔑 判定は `appendModeOf` **1 か所**を引く(2 本目の規則を書かない。§7)。
   * ⚠ 追記欄そのものが無い面(`hidden`)は**黙って降りてよい** ── 読むだけの面なので、
   *   押した人は「追記先を選んだ」つもりが無い。
   * 🔴 **書込中は黙らない**(#655 ②)── 追記欄は出ている(理由と出口の帯)のに
   *   押しても何も起きないのは dead click である。理由を 1 行出す。
   * ⚠ **編集中の枝は、いまの 2 つの入口からは届かない**(実装を読んで確かめた):
   *   `Alt`+クリックは `bodySourceLineAt` が `phase !== 'ready'` で降りる(既定を
   *   奪わないため ── `mod-click-edit.test.ts`「ready でない間は、既定を奪わない」)し、
   *   右クリックの「ここに追記する」は `appendable` が `ready` のときしか並べない。
   *   編集中の理由は追記欄の帯(「編集中」。C4 / #1038 段 D で 1 語になった)が既に出している。
   *   ここに字を置くのは、**3 つ目の入口が生えた日に黙らないため**であって、
   *   いま user に見えている欠陥を直したのではない(#655 ② の前提の訂正)。
   */
  const mode = appendModeOf(st);
  if (mode.kind === 'hidden') return;
  if (mode.kind !== 'ready') {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error:
        mode.kind === 'editing'
          ? '編集中は追記欄を使えません(「編集を保存する」か「編集をやめる」を押すと追記先を選べます)'
          : '追記を書き込んでいる間は、追記先を変えられません',
    });
    return;
  }
  const lid = st.selectedLid;
  const sel = root.querySelector<HTMLSelectElement>('[data-pkc-field="append-target"]');
  /**
   * ⚠ **この `lid` 一致は門ではない**(2026-08-28。着地前レビュー M7 を検算して判明)。
   *   上の `appendModeOf` が既に `openBody?.lid === lid` を要求しているので、
   *   ここが偽になる形は作れない ── **型を絞るための書き方**として残している。
   *   🔑 だから「これが無いと別のノートの本文で節を引く」とは**書かない**
   *   (CLAUDE.md「これが無いと壊れる、と書く前に外して壊れるのを見る」)。
   */
  const body = lid !== null && st.openBody?.lid === lid ? st.openBody.body : null;
  if (sel === null || body === null) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: 'このノートには追記の欄が無いので、追記先は選べません',
    });
    return;
  }
  /**
   * ⚠ **原文の行へ戻す** ── 描く面は frontmatter を剥がした側を見ているが、
   *   見出しを数える側(`sectionAt`)は原文で数える。ずらす値は
   *   `frontmatterLineCount` 1 つ(`detail.ts` の `fmLines` と同じ規律)。
   */
  const sec = sectionAt(body, line + frontmatterLineCount(body));
  /**
   * 🔴 **畳んだ追記欄は開き、打つ欄にカーソルを入れる**(#596 A / 設問③ C。
   *   user 裁定 2026-08-30「**推奨通り、畳んでいれば開き、打つ欄にカーソルが入る。
   *   Alt+クリックも同じ**」)。
   *
   * ⚠ 直す前:畳むのは CSS だけ(`[data-pkc-hidden-panes~='append']`)で `<select>` は
   *   DOM に残るので、ここは**畳まれた `<select>` を掴んで値を入れ**、「〜にしました」と
   *   言って終わっていた ── user から見れば**打つ所が画面のどこにも無い**。
   * 🔑 右クリック(`append-at-heading`)と `Alt`+クリックは**この 1 本**を通るので、
   *   ここに置けば 2 経路が同時に揃う(片方だけ直る日を作らない ── CLAUDE.md §7)。
   * ⚠ 開くのは**追記欄だけ**(左右の列には触らない)── 頼まれたのは「追記する場所」であって
   *   版面の組み直しではない。
   * ⚠ focus は**開いた後**に当てる ── 畳んだままの `display: none` には focus が乗らない。
   *
   * 🔴 **断るときも、打つ所までは出す**(#655 ②。user 裁定 2026-09-04)。
   * ⚠ 直す前は下の 2 つの断り(上に見出しが無い / 一覧に無い見出し)が**開く前に
   *   返っていた**ので、マニュアルの「畳んでいても開いて、打つ欄にカーソルが入ります」が
   *   その場面で嘘になっていた ── 見出しが 1 つも無いノートでは**必ず**この形になる。
   * 🔑 押した人が欲しいのは「打つ所」である。追記先を変えられなくても、欄を開いて
   *   カーソルを入れ、**いまの追記先がどこか**を添える(「末尾です」と言い切らない ──
   *   直前に別の節を選んでいれば、そのままである)。
   */
  const opened = revealAppendPane(root);
  root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]')?.focus();
  if (sec === null) {
    dispatcher.dispatch({
      type: 'OP_NOTICE',
      message: `ここより上に見出しが無いので、追記先は変えていません(いまの追記先は${targetNow(sel)}です)${openedNote(opened)}`,
    });
    return;
  }
  // ⚠ 一覧に無い印は選べない(見出しが 1 つも無いノートでは `<select>` は畳んである)
  if (!Array.from(sel.options).some((o) => o.value === sec.slug)) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `「${sec.text}」は追記先に選べません(いまの追記先は${targetNow(sel)}です)${openedNote(opened)}`,
    });
    return;
  }
  sel.value = sec.slug;
  dispatcher.dispatch({
    type: 'OP_NOTICE',
    message: `追記先を「${sec.text}」にしました${openedNote(opened)}`,
  });
}

/**
 * いま選ばれている追記先を、断り文に添える字で(#655 ②)。
 * ⚠ 選択肢の字は深さを**字下げ**(全角空白)で見せている(`append-box.ts`)── 剥いで出す。
 */
function targetNow(sel: HTMLSelectElement): string {
  if (sel.value === '') return '末尾';
  const picked = Array.from(sel.options).find((o) => o.value === sel.value);
  const text = picked?.textContent?.trim() ?? '';
  return `「${text === '' ? sel.value : text}」`;
}

/** 追記欄をこちらが開いた回に添える一言(#655 ①)── 畳み直すことまで言う。 */
function openedNote(opened: boolean): string {
  return opened ? '(追記欄を開きました、送ると元どおり折りたたみます)' : '';
}

/**
 * 追記欄を畳んでいたら**一時的に**見せる。見せたら `true`(呼び側が一言添える)。
 *
 * 🔴 **user の畳みの記録(`pkc3.panes`)には 1 byte も書かない**(#655 ①。
 *   user 裁定 2026-09-04 案 B)。⚠ 直す前は `setHidden` で開いていたので、
 *   「閲覧メインだから畳む」と決めた設定を**こちらが黙って上書きして永続**していた
 *   ── 1 行足したいだけの人が、次に開いたときも追記欄を見ることになる。
 * 🔑 元どおり畳むのは 2 つの契機:追記が**通った**(`append-box.ts`)/ 欄の外で
 *   **1 操作した**(`run` の後ろ)。続けてもう 1 行足したい人は、もう一度開く(裁定 B)。
 * ⚠ **判定と適用は `pane-visibility` の 1 組**(`appPanes` / `applyPaneVisibility`)──
 *   `toggle-pane` と同じ口を使い、畳み状態の 2 本目の台帳を作らない。
 */
function revealAppendPane(root: HTMLElement): boolean {
  if (!appPanes.peek('append')) return false;
  applyPaneVisibility(root, appPanes.getHidden());
  return true;
}

/**
 * 🔴 **欄の外で 1 操作したら、こちらが開いた追記欄を畳み直す**(#655 ①)。
 *
 * ⚠ **打ちかけが在る間は畳まない** ── 「ここに追記する」で開いた欄に字を打ってから
 *   別の所を押した人の字を、畳んで見えなくしない(この機構で一番やってはいけない
 *   負け方は「押したら消えた」である。`append-box.ts` の規律と同じ向き)。
 * ⚠ 欄の**中**の操作(送る / 元に戻す)は数えない ── 送るは通った時点で
 *   `append-box.ts` が畳み、断られた回(空のまま押した等)は欄を出したままにする。
 */
function refoldAppendAfterAction(root: HTMLElement, pressed: Element): void {
  if (pressed.closest('[data-pkc-region="append"]') !== null) return;
  const input = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]');
  if (input !== null && input.value !== '') return;
  refoldPeeked(root);
}

/**
 * 🔴 **指で触る端末では、チェックリストの行の字を押しても印が変わる**(#706 ①)。
 *
 * ## 物語
 *
 * スマホで買い物リストを開き、「牛乳」の行を押す。⚠ 直す前は**印の箱(13×13)を
 * 正確に押さないと何も起きなかった** ── 字を押しても印は変わらず、箱は指より小さい。
 * 🔑 だから**行の字も押し所にする**(箱そのものは CSS が 20px にする)。
 *
 * ⚠ **指の端末だけ**である ── マウスでは字を選ぶ(ドラッグ)の終わりに `click` が来るので、
 *   行のどこを押しても印が動く形にすると**字が選べなくなる**。判定は `pointerType`
 *   (Chromium の `click` は `PointerEvent`)、持たないブラウザでは `(pointer: coarse)`。
 * ⚠ **自分で受ける物には触らない** ── リンク・ボタン・欄・印そのもの・`data-pkc-action` を
 *   持つ物(かんばんの札など)は、押した先が自分で決める。ここで奪うと「リンクを押したのに
 *   印が動いた」になる。
 * ⚠ 印を返すのは**その行の直下の箱**だけ ── 入れ子の子リストの字を押しても親の印は動かさない
 *   (`closest('li')` が子の `li` を返すので、それが task の行でなければ何もしない)。
 *
 * @returns 押すべき印(`toggle-task` を受ける `<input>`)。当たらなければ `null`
 */
function touchTaskBoxAt(ev: Event, root: HTMLElement): HTMLInputElement | null {
  const t = ev.target;
  if (!(t instanceof Element)) return null;
  if (t.closest('a, button, input, select, textarea, label, summary, [data-pkc-action]') !== null)
    return null;
  const li = t.closest('li');
  if (li === null || !li.classList.contains('pkc-task-item') || !root.contains(li)) return null;
  const box = li.querySelector<HTMLInputElement>(
    '.pkc-task-checkbox[data-pkc-action="toggle-task"]',
  );
  if (box === null) return null;
  // ⚠ 直下(`li > input` か `li > p:first-child > input`)だけ ── 子リストの印を親の行で押さない
  const parent = box.parentElement;
  const direct =
    parent === li || (parent !== null && parent.tagName === 'P' && parent === li.firstElementChild);
  if (!direct) return null;
  if (!isTouchClick(ev)) return null;
  // ⚠ 字を選んでいる最中は数えない(選び終えた瞬間の `click` で印が動くと、選び直せない)
  const sel = li.ownerDocument.getSelection?.();
  if (sel !== null && sel !== undefined && !sel.isCollapsed) return null;
  return box;
}

/**
 * この `click` は指(かペン)か。⚠ `pointerType` を持たない実装(古い WebKit)では
 * `(pointer: coarse)` に落とす ── 判定を 2 つ持つのは、片方しか無い端末が在るから
 * (`long-press.ts` が「`pointerType` が空なら指として扱う」としているのと同じ向き)。
 */
function isTouchClick(ev: Event): boolean {
  const pt = (ev as { pointerType?: string }).pointerType;
  if (pt !== undefined && pt !== '') return pt !== 'mouse';
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  return typeof mm === 'function' && mm('(pointer: coarse)').matches;
}

/**
 * 🔴 **章の下書きを持ったまま移ろうとしたら、先に聞く**(#1044 段2、裁定 Q2 = A)。
 *
 * ⚠ **`selectEntryOrExplain` の唯一の入口をここに寄せる**(設計 doc「一覧 / リンク等、
 *   `SELECT_ENTRY` を撃つ経路はすべてここを通る」)── 別の場所に同じ判定を書かない。
 * @returns `true` なら**そのまま移ってよい**(下書きが無い / 同じノートを選んだ /
 *   変更が無いので聞かずに閉じた)。`false` なら**呼び手はここで return する**
 *   (聞いている最中、または断られた ── 移った先は後で非同期に決まる)。
 */
function leaveSectionDraftOrAsk(
  dispatcher: Dispatcher,
  root: HTMLElement,
  services: BinderServices,
  toLid: string,
  what: string,
): boolean {
  const draft = dispatcher.getState().sectionDraft ?? null;
  if (draft === null || draft.lid === toLid) return true;
  /**
   * ⚠ **ロックはここで返さない**(#1044 段2、F-B)── `bindEditLockRelease` が
   *   `sectionDraft` を state から直に見て返す。ここで書くのは
   *   「離れる経路ごとに releaseEdit を書く」を増やす側であり、CLAUDE.md §7 の
   *   逆(2 か所に同じ判定を書くと片方だけ古くなる)を踏む。
   * ⚠ **共通の門は `withSectionDraftLeave`**(#1044 段2 5巡目の修理、U1)──
   *   dirty 判定・3 択・保存・ack 待ち・T7(待つ間に system 側で閉じられたか)は
   *   `startSectionEditAt` と共有する。ここは「進んでよいときに何をするか」
   *   (`selectEntryOrExplain` を呼ぶ)だけを持つ ── `saved` の真偽は問わない
   *   (保存できた・変更なし・消して進む・既に system 側で閉じていた、どの回も
   *   「移る」自体は構わない)。
   * ⚠ **`'sync'`(変更なし)の回は `proceed` を呼ばずに `true` を返す** ──
   *   ここの 5 か所の呼び手(`selectEntryOrExplain` 自身を含む)は「`true` が
   *   返ったら自分の続きをそのまま同期に続ける」契約を持つ(§10「置き換える前に
   *   “ついでに”提供していた性質を数え上げる」── ここでは「同期で返る」という性質)。
   *   `proceed` を同期の枝でも呼ぶと、この関数の呼び手(`selectEntryOrExplain`)を
   *   **再入で 2 回呼ぶ**ことになり、呼び手の続き(例:リンクの見出しジャンプ)が
   *   1 回目の呼び出しでは飛ばされてしまう。
   */
  return withSectionDraftLeave(dispatcher, root, draft, {
    proceed: () => {
      selectEntryOrExplain(dispatcher, toLid, what, root, services);
    },
  }) === 'sync';
}

/**
 * 本文の日付(`@2026-10-15`)が指すノートを探して、**あれば開く**(#1169)。
 *
 * 🔴 **規則は 1 本** ── あるなら `navigateToLink` と**同じ道**(`selectEntryOrExplain`)で開く。
 *   ⚠ 編集中の断り文は「リンク先」ではなく**日付で名指しする**(`2026-10-15 のノート`)──
 *   user が押したのは日付なので、「リンク先」と言われても何のことか分からない。
 * ⚠ **`phase !== 'ready'` で黙って返さない**(`open-today` の形をそのまま写さない)──
 *   押したのに何も起きない dead click になる。断る 2 つ(編集中 / 保存に失敗して止まっている)は
 *   `phaseBlockReason` の 1 本で理由を言う。
 *
 * @returns 続きが要るとき(開いておらず、断ってもいない)だけ日付。それ以外は `null`
 */
function resolveDateNote(
  dispatcher: Dispatcher,
  rawDate: string | null,
  root: HTMLElement,
  services: BinderServices,
): string | null {
  const date = rawDate ?? '';
  // ⚠ 属性は書き換えられうる ── 実在する日でなければ、ノートを作らない
  if (!isRealCalendarDate(date)) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: '日付の書き方が読めません' });
    return null;
  }
  const what = `${date} のノート`;
  const st = dispatcher.getState();
  const found = findTodayNote(st.entryMetas.values(), date);
  if (found !== null) {
    selectEntryOrExplain(dispatcher, found.lid, what, root, services);
    return null;
  }
  const block = phaseBlockReason(st.phase);
  if (block !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${block}${what}を開いてください` });
    return null;
  }
  return date;
}

/**
 * 日付を押した。ノートがあれば開き、**無ければ作るかどうかを聞く**(作らない)。
 * ⚠ 作らないのは、打ち間違いの日付でノートが増えないようにするため ──
 *   書く物が無いので `BODY_WRITE_ACTIONS` には載せない(`createDateNote` が書く側)。
 */
function openDateNote(
  dispatcher: Dispatcher,
  rawDate: string | null,
  root: HTMLElement,
  services: BinderServices,
): void {
  const date = resolveDateNote(dispatcher, rawDate, root, services);
  if (date === null) return;
  const message = dateNoteMissingNotice(date);
  dispatcher.dispatch({ type: 'OP_NOTICE', message, createDate: date });
  /**
   * ⚠ **状態の行へも直に書く** ── 同じ知らせが続けて来ても、行が別の字に上書きされた後なら
   *   state の `notice` は動かず再掲されない(`main.ts` の `noticeShown`)。押したのに
   *   「作る」が出ない dead click になるので、字は `showStatus` でも必ず出す。
   */
  // ⚠ 積むのは上の `OP_NOTICE`(`main.ts` が結果として積む)── こちらは積まない(1 件にする)
  services.showStatus?.(message, { post: false });
}

/**
 * 画面の下の「○○のノートを作る」を押した。**作って、開く**(編集には入らない)。
 * ⚠ 編集に入らない ── 読んでいた本文から日付を押しただけで、書く気になったとは限らない
 *   (予定の面から足すときと同じ作り)。
 * ⚠ 押す前に誰かが作っていたら、作らずにそれを開く(`resolveDateNote` が先に探す)。
 */
function createDateNote(
  dispatcher: Dispatcher,
  rawDate: string | null,
  root: HTMLElement,
  services: BinderServices,
): void {
  const date = resolveDateNote(dispatcher, rawDate, root, services);
  if (date === null) return;
  const lid = generateLid();
  dispatcher.dispatch({
    type: 'CREATE_ENTRY',
    archetype: 'text',
    lid,
    title: date,
    parentLid: null,
    relationId: generateLid(),
    edit: false,
  });
  // ⚠ 作れなかった回(lid 衝突 ── reducer が理由を立てる)は、知らせで上書きしない
  if (!dispatcher.getState().entryMetas.has(lid)) return;
  // 🔑 「作る」の口を畳む(知らせの字が変わると、`paintStatusCreate` が畳む)
  dispatcher.dispatch({ type: 'OP_NOTICE', message: `${date} のノートを作りました` });
  appPhone.showNote();
}

/**
 * 🔴 **左の列の欄に語が入っているとき、別のウィンドウへ運ぶ語**(依頼 70-C2)。
 *
 * ⚠ 同じウィンドウで行を押した回は `startSearchJumpFromField` が塗る(#1102 段②)。ここは
 *   **別のウィンドウで開く口**(行の 2 回押し / 「別のウィンドウで開く」)の分 ── 運ぶ語が無いと、
 *   欄で探して開いたのに開いた先は塗られず、先頭から読み直すことになる。
 * ⚠ `>` で始まる欄は操作を探している(本文の語ではない)── 運ばない。空の欄も運ばない(`undefined`)。
 * ⚠ 整えるのは受け側と同じ `normalizeFindQuery`(判定を 2 か所に置かない)。
 */
export function leftFilterFind(filterQuery: string): string | undefined {
  if (commandQueryOf(filterQuery) !== null) return undefined;
  const q = normalizeFindQuery(filterQuery);
  return q === '' ? undefined : q;
}

export function selectEntryOrExplain(
  dispatcher: Dispatcher,
  lid: string,
  what: string,
  root: HTMLElement,
  services: BinderServices,
): boolean {
  if (!leaveSectionDraftOrAsk(dispatcher, root, services, lid, what)) return false;
  const state = dispatcher.getState();
  // 🔴 編集中だけでなく保存失敗中(`error`)も reducer が捨てる ── 判定は `selectBlockReason` の 1 本
  //    (直す前は `editing` だけを断り、保存失敗中は続きの処理が原因違いの字を出していた)
  const blocked = selectBlockReason(state.phase);
  if (blocked !== null) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `${blocked}${what}を開いてください`,
    });
    return false;
  }
  if (!state.entryMetas.has(lid)) {
    // ⚠ `${what}のノート` と書かない ── what='ノート' の呼び手で
    //   「ノートのノートが見つかりません」になる(UX レビュー 2026-08-28)
    // 🔴 押す前の吹き出し(`MISSING_LINK_TITLE`)と同じ手掛かりを添える(#1087 の見直し 2026-10-13)──
    //    押した後の字から「ゴミ箱にあれば戻せます」が消えると、どこを探せばよいかが分からない
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${what}が見つかりません(ゴミ箱にあれば戻せます。ゴミ箱は左のペインの「フォルダ」の中です)` });
    return false;
  }
  dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
  /**
   * 🔴 **開いたら本文ページへ出る**(user 裁定 2026-09-02)。
   *
   * ⚠ **`dispatcher` に任せられない。** 一覧に**いま開いているノートの行**が
   *   並んでいるので、user がその行をもう一度押すことがある ── そのとき
   *   `SELECT_ENTRY` は同じ state を返し、`dispatcher` は `changed` の
   *   ときだけ listener を呼ぶので `render` が走らない = **一覧に留まる
   *   dead tap** になる(設計 doc §2-6 が「一覧を出したまま選択を保つ bit」を
   *   一度棄却した、まさにその理由である)。
   * 🔑 **押された側で直に畳む**と、選び直しでも別のノートでも同じ 1 行で済む。
   */
  appPhone.showNote();
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
 * @param afterMoved 🔴 **ゴミ箱へ移し終えた直後**に撃つ後始末(2 ペインのカーソルを隣の行へ立てる等)。
 *   ⚠ 別のタブの編集を確かめる間は移すのが**非同期**になる(#1766)── 呼び側が `deleteFrom` の直後に
 *   同期で後始末すると、行がまだ居て空振りする。**必ずこの口で渡す**(省略可にしない)。
 */
function deleteFrom(
  dispatcher: Dispatcher,
  services: BinderServices,
  root: HTMLElement,
  rows: readonly EntryMeta[],
  selection: readonly string[],
  cursor: string | null,
  afterMoved: () => void,
): void {

    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `${phaseBlockReason(st.phase)}ゴミ箱へ移してください`,
      });
      return;
    }
    if (refuseWhileBusy('delete-selected', dispatcher, services)) return;
    /**
     * 🔴 **見えている行に絞る**(着地前レビュー 2)。印は行が見えなくなっても
     * 残る(絞り込みで消えた / 別タブが消した)ので、素で消すと**画面に無いものが
     * ゴミ箱へ入る**。⚠ 帯に出す数(`filer.ts`)と**同じ規則**を通す ──
     * 食い違うと「2 件をゴミ箱へ移しました」と言って 3 件動かす形になる。
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
            : 'ゴミ箱へ移すものを選んでください(行を押すと選べます)',
      });
      return;
    }
    /**
     * 🔴 **確認は出さない。移したあとに「元に戻す」を出す**(#1087 流れ 29。1 件の `delete-entry` と同じ)。
     * ⚠ 居ない分は `DELETE_ENTRIES` が黙って落とす ── 知らせの件数・戻す対象は**実際に消えた分**で数える。
     */
    const titleOf = new Map(lids.map((l) => [l, st.entryMetas.get(l)?.title ?? l]));
    /**
     * 🔴 **別のタブ・窓が編集中のノートが 1 件でも混じっていれば、全体を移さない**(#1087。`delete-entry` と同じ門)。
     * ⚠ 一部だけ移すと「何が移って何が残ったか」を user が読み解くことになる ── 断って選び直してもらう。
     */
    refuseTrashEditedElsewhere(dispatcher, services, lids, () => {
      const st = dispatcher.getState();
      dispatcher.dispatch({ type: 'DELETE_ENTRIES', lids });
      const after = dispatcher.getState();
      const moved = lids
        .filter((l) => st.entryMetas.has(l) && !after.entryMetas.has(l))
        .map((l) => ({ lid: l, title: titleOf.get(l) ?? l, order: st.entryMetas.get(l)?.entryOrder }));
      offerTrashUndo(
        dispatcher,
        moved,
        leftAtRoot(st, after),
        // 🔴 2 件以上のときは一般形を言う(参照元は選んでいる 1 件の分しか引けていないので、件数では言えない。#1087)
        // 🔴 1 件のときは `delete-entry` と同じ字(引けていれば件数)── 直す前は 1 件だと何も言わなかった(#1087)
        moved.length > 1 ? LINKED_FROM_SOME : moved.length === 1 ? linkedFromText(st, after, moved[0]!.lid) : '',
        dualFellBackText(st, after),
      );
      afterMoved();
    });
}

/**
 * 🔴 **ゴミ箱へ移す口の共通の門**(#1087)── 別のタブ・窓が編集中のノートが混じるなら断って `go` を撃たない。
 * ⚠ 問い合わせが要らない回(口が無い環境 / このタブが自分で編集中)は**同期のまま** `go` を撃つ
 *   (追記と同じ作法 ── 口の無い環境の操作を 1 手遅らせない)。
 * 🔑 問い合わせは追記の口と**同じ 1 本**(`editedElsewhereReason`)。口を足すときは必ずここを通す。
 */
function refuseTrashEditedElsewhere(
  dispatcher: Dispatcher,
  services: BinderServices,
  lids: readonly string[],
  go: () => void,
): void {
  const ask = lids.filter((l) => !elsewhereCheckNotNeeded(dispatcher, services, l));
  if (ask.length === 0) {
    go();
    return;
  }
  void Promise.all(ask.map((l) => editedElsewhereReason(dispatcher, services, l)))
    .then((whys) => {
      const why = whys.find((w) => w !== null) ?? null;
      if (why !== null) {
        dispatcher.dispatch({ type: 'OP_FAILED', error: why });
        return;
      }
      go();
    })
    // 🔴 問い合わせが落ちても黙って捨てない(何も移していない)
    .catch((e: unknown) => {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `ゴミ箱へ移せませんでした(別のタブの編集を確かめられませんでした: ${errorText(e)})。もう一度押してください`,
      });
    });
}

/** 何もしない口。⚠ 打鍵ではないので「既定を止める」相手がいない。 */
/**
 * 🔴 **置換の帯に、当たる件数を出す**(#1646 の 2。Gemini 裁定 = #1163 の依頼 40 の推薦どおり A)。
 *
 * ⚠ 数えるのは「すべて置換」と**同じ本文・同じ規則**(`countMatches` ── 置換と同じ `findHits` を通る。添付ノートは
 *   畳んだ設定の行を外した見える本文だけ)。食い違うと「3 件」と出て 2 件しか置き換わらない嘘になる。
 * ⚠ 出さない場面は空にする ── 編集中でない / 探す語が空(「0 件」ではなく、まだ何も探していない)。
 */
function paintReplaceCount(root: HTMLElement, dispatcher: Dispatcher): void {
  const out = root.querySelector<HTMLElement>('[data-pkc-field="replace-count"]');
  if (out === null) return;
  const st = dispatcher.getState();
  const find = root.querySelector<HTMLInputElement>('[data-pkc-field="replace-find"]')?.value ?? '';
  let text = '';
  if (st.phase === 'editing' && st.openBody !== null && find !== '') {
    // ⚠ 切り方は reducer の `REPLACE_IN_BODY` と同じ(畳めない本文は全部)
    const fold =
      st.entryMetas.get(st.openBody.lid)?.archetype === 'attachment' ? foldAttachmentHead(st.openBody.body) : null;
    const body = fold === null ? st.openBody.body : fold.rest;
    const caseSensitive =
      root.querySelector<HTMLInputElement>('[data-pkc-field="replace-case"]')?.checked === true;
    text = `${String(countMatches(body, find, { caseSensitive }))} 件`;
  }
  if (out.textContent !== text) out.textContent = text;
}

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
  const plan = planSettingsImport(text, readSetting, ADAPTER_SETTING_VALIDATORS);
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
/**
 * 🔴 **断り・失敗の知らせに付ける種類**(#1305 の着地後レビュー)。
 * ⚠ 種類を付けずに `showStatus` へ渡すと「結果」として **6 秒で消え、未読にもならない** ──
 *   「ブラウザが断った」「いまは実行できない」を読む前に消える。判定は**出す側で宣言する**
 *   (sink が字の末尾から推定すると、字が変わった日に黙って外れる)。
 */
const CAUTION: StatusOptions = { kind: 'caution' };

/**
 * 戻る・進む。⚠ 編集中などで選択が動かなかったときは、黙らずに理由を言う
 * (reducer の `navHistory` は断ったとき何も返さない ── 規則は `SELECT_ENTRY` が持つので
 * ここでは**動いたかどうかだけ**を見る)。前置きは他の断りと同じ `phaseBlockReason`。
 */
function navigateHistory(dispatcher: Dispatcher, dir: 'back' | 'forward'): void {
  const before = dispatcher.getState();
  dispatcher.dispatch({ type: 'NAV_HISTORY', dir });
  const after = dispatcher.getState();
  if (after.phase === 'ready' || after.selectedLid !== before.selectedLid) return;
  dispatcher.dispatch({
    type: 'OP_FAILED',
    error: `${phaseBlockReason(after.phase)}${dir === 'back' ? '戻ってください' : '進んでください'}`,
  });
}

/**
 * 書式の帯・caret の道具が、書き込む先の欄(`formatTarget`)を見つけられなかったときの知らせ。
 * ⚠ 1 画面の編集で本文の行がどれも開いていないと、欄が無く、押しても何も起きなかった。
 *   全部の道具がここを通る(字を 1 か所に置く)。
 */
export const NO_FORMAT_TARGET_TEXT = '先に本文の行を押して、書く行を開いてください';
function sayNoFormatTarget(services: { showStatus?(text: string, opts?: StatusOptions): void }): void {
  services.showStatus?.(NO_FORMAT_TARGET_TEXT, CAUTION);
}

/**
 * 🔴 **行を持つ 2 つの器**(#1032 で 1 か所へ寄せた。「一覧」の器は #813 段③ で外した)。
 *
 * ⚠ 左の列の行は「フォルダ」(`filer-table`)/ 2 ペイン(`dual-table`)の**2 つ**が持つ。
 * 🔴 **1 つ落とすと「その面の user だけ効かない」**という、いちばん外しやすい形になる
 *   (2026-09-09 の UX レビューが、3 つのうち 2 つを落とした 1 稿目で実際に踏んだ)。
 * 🔑 だから**字を 1 か所に置く** ── 行を掴む判定(`blockRowTarget`)と、
 *   「何も無い所を押したら閉じる」(`onClick`)が**同じ表**を読む(§7)。
 */
export const ROW_HOST_REGIONS: readonly string[] = ['filer-table', 'dual-table'];

/** 上の 2 つを選択子にしたもの。 */
export const ROW_HOST_SELECTOR = ROW_HOST_REGIONS.map((r) => `[data-pkc-region="${r}"]`).join(', ');

/**
 * 🔴 **root に結んだ services**(#1452 案 1)── `runGlobalCommand` は services を受け取らない
 *   (鍵 / パレット / 左の `>` の一覧の 3 つの入口が同じ口を呼ぶ)ので、押しボタンを持たず
 *   services が要る命令(マニュアルの別ウィンドウ)は、`bindActions` が結んだ物をここから引く。
 * ⚠ `WeakMap` ── root が消えれば一緒に消える(test が root を何百も作っても溜まらない)。
 *   `bindActions` の後始末でも外す。
 */
const ROOT_SERVICES = new WeakMap<HTMLElement, BinderServices>();

/** 「選択範囲をコピー」を、控えた選択が無いまま呼んだときの理由。 */
const SELECTION_FIRST = '本文の中を選択してから呼んでください';

/** 配線が落ちた版で「マニュアルを別のウィンドウで開く」を押したときの字(押しボタンと特例で同じ 1 つ)。 */
const MANUAL_WINDOW_STALE = 'このタブの PKC3 が古いままのため、マニュアルのウィンドウを開けません。再読み込みしてください';

/**
 * 🔴 **「操作を探す」を開いた瞬間の、読む面の選択**(Markdown の原文)。#582 段③ の「選択範囲をコピー」が読む。
 *
 * ⚠ 一覧を開くと読む面の選択は消える(実ブラウザで測った)ので、開く前に**字として**控える。
 *   ⚠ Range は持たない ── 描き直しで節点が消えても、控えた字は変わらない。
 * ⚠ 閉じたら必ず捨てる(`openPaletteFor` の `finally`)── 古い選択で次の呼び出しがコピーしない。
 * ⚠ `root` を添える ── 別の root(test が何百も作る)の控えを拾わない。
 */
interface PaletteSelection {
  readonly root: HTMLElement;
  readonly text: string;
}
let paletteSelection: PaletteSelection | null = null;

export function runGlobalCommand(
  cmd: string,
  root: HTMLElement,
  dispatcher: Dispatcher,
  keymap: KeymapStore,
  prevent: () => void,
  /**
   * 🔴 **画面へ 1 行出す口**(#522)。⚠ **optional にしない** ── 渡し忘れても
   * tsc が黙る形にすると、戻ってくる症状は「**押しても何も言わない**」という、
   * まさにこの変更が直そうとしているもの(CLAUDE.md「待ちの口は optional にしない」)。
   * 🔑 断りは `CAUTION` を渡す(結果のまま渡すと 6 秒で消えて未読にもならない)。
   */
  notify: (text: string, opts?: StatusOptions) => void,
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
  if (cmd === 'deselect-entry') {
    /**
     * 🔴 **開いているノートを閉じて、コレクションへ戻る**(#1032)。
     *
     * ⚠ **開いていなければ効かない**(`false` を返す)── パレットはこの答えを読んで
     *   行を `disabled` にするので、**押せるのに何も起きない**にならない。
     * 🔴 **右クリックのメニューが出ている間は譲る** ── `Escape` は
     *   「メニューを閉じる」にも使う(`onMenuKey`)。ここで先に閉じると、
     *   **取り消したつもりの user が、読んでいたノートまで失う**
     *   (判定は `contextMenuOpen` 1 か所から引く ── 2 つ目の数え方を作らない。§7)。
     * ⚠ 編集中・行の名前を打っている間は、**ここへ来る前に**それぞれの
     *   `Escape` が握って return する(`onKeydown` の上のほう)。
     */
    const st = dispatcher.getState();
    if (st.phase !== 'ready' || st.selectedLid === null) return false;
    if (contextMenuOpen(root)) return false;
    if (dry) return true;
    prevent();
    dispatcher.dispatch({ type: 'DESELECT_ENTRY' });
    return true;
  }
  if (cmd === 'cycle-read-columns') {
    if (dry) return true;
    prevent();
    cycleReadColumns(root, notify);
    return true;
  }
  if (cmd === 'toggle-focus-mode') {
    /**
     * 🔑 **両側を一度に畳む / 戻す**(PKC2 のフォーカスモード相当)。
     * ⚠ 押しボタン 2 つを続けて押す実装にしない ── 片方だけ畳まれている状態から
     *   押すと**入れ替わる**だけで、user が期待する「集中」にならない。
     * 🔴 **数えるのは列だけ**(#497 で追記欄も畳めるようになった)── `PANES` で
     *   数えると、この鍵が**追記欄まで一緒に消す**ようになる(頼まれていない)。
     */
    if (dry) return true;
    /**
     * 🔴 **スマホ用画面では断る**(#632 段④。実測で見つけた)。
     *
     * ⚠ 段① は `toggle-pane`(`Alt+[` / `Alt+]`)にだけ門を置き、**対称の反対側**で
     *   ある**この鍵を取りこぼしていた** ── CLAUDE.md「片側を直したら、対称の
     *   反対側を必ず疑う」。
     * 🔴 実測(375×667、`Ctrl+Alt+\`):`pkc3.panes` が `null` →
     *   **`'sidebar inspector'`** に変わるのに、画面は 1px も動かず状態の行も**空のまま**。
     *   ⚠ **見えない状態変化が保存される**ので、PC の幅へ戻したときに
     *   **身に覚えのない畳み**が残る(`toggle-pane` の門のコメントが、
     *   まさにこの害を名指しで戒めている)。
     * 🔑 断り文は `toggle-pane` と**同じ字**にする ── 同じことを断るのに
     *   2 通りの言い方をしない。
     */
    if (appPhone.isPhone()) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: 'スマホの画面では一覧・本文・情報を 1 枚ずつ出しているので、ペインは折りたためません',
      });
      prevent();
      return true;
    }
    const hidden = appPanes.getHidden();
    const columnsHidden = COLUMN_PANES.filter((p) => hidden.includes(p));
    const next =
      columnsHidden.length === COLUMN_PANES.length
        ? hidden.filter((p) => !(COLUMN_PANES as readonly string[]).includes(p))
        : [...hidden, ...COLUMN_PANES];
    prevent();
    applyPaneVisibility(root, appPanes.setHidden(next));
    return true;
  }
  if (cmd === 'focus-search') {
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]');
    if (!input) return false; // 欄が無い面では何も起きない(ブラウザの検索に譲る)
    if (dry) return true;
    prevent();
    /**
     * 🔴 **畳んでいるなら、先に戻してから焦点を入れる**(#583)。
     *
     * ⚠ 直す前は `focus()` を撃つだけだった ── **畳んだペインは DOM から消えず、
     *   CSS で列が落ちるだけ**なので `querySelector` は**見つけてしまい**、
     *   見えない要素に焦点を入れて**何も起きなかった**(実測: 焦点は `BODY` のまま)。
     *   🔴 しかも `prevent()` が先なので、**鍵を食ったうえで無反応**である。
     * 🔴 そして `dry` は `true` を返し続けるので、**パレットは「押せる」と嘘をついていた**
     *   (畳む前も後も `disabled=false`)。
     *
     * 🔑 **戻してから入れる**を選んだ理由:user が押したのは「**探したい**」であって
     *   「畳んだままにしたい」ではない。⚠ 「押せません」と断るのは**次善** ──
     *   断ると user は自分でペインを戻す手を探すことになり、**手数が増えるだけ**である。
     * 🔑 これで `dry` の `true` が**嘘でなくなる** ── どの状態でも実際に効く。
     */
    /**
     * 🔴 **スマホでは列の保存値を触らない**(着地前レビュー 6)。
     * ⚠ スマホに列は無いので**戻す理由が無い**のに、直す前は `pkc3.panes` から
     *   `sidebar` を消していた ── PC で一覧を畳んでいる user がスマホで 1 回
     *   「探す」を押すと、**PC へ戻ったとき一覧が勝手に開いている**。
     */
    if (!appPhone.isPhone()) {
      const hidden = appPanes.getHidden();
      if (hidden.includes('sidebar')) {
        applyPaneVisibility(
          root,
          appPanes.setHidden(hidden.filter((x) => x !== 'sidebar')),
        );
      }
    } else if (!phoneShowList(dispatcher)) return true;
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
  /**
   * 🔴 **SQL の面も押しボタンを持たない**(#681 段②)── `view-dual` と同じく直に投げる。
   * ⚠ この 1 行が、左の一覧を押して中央が本文へ戻った後の**唯一の戻り道**である
   *   (左にタブが無い面なので)。
   */
  if (cmd === 'view-sql') {
    if (dry) return true;
    prevent();
    dispatcher.dispatch({
      type: 'SET_VIEW_MODE',
      mode: nextViewMode(dispatcher.getState().viewMode, 'sql'),
    });
    return true;
  }
  if (cmd === 'open-palette') {
    if (dry) return true;
    prevent();
    openPaletteFor(root, dispatcher, keymap, notify);
    return true;
  }
  /**
   * 🔴 **コピーした物**(#678)。⚠ **中央の面を奪わない** ── その場に出して、
   *   選んだら消える(user 指示 2026-08-22「補助的な物が、主の作業領域を奪ってはいけない」)。
   * ⚠ 0 件のときは**メニューを出さずに帯で言う** ── 「まだ何もコピーしていません」を
   *   項目にすると、押しても何も起きない行になる。
   */
  if (cmd === 'open-copy-history') {
    if (dry) return true;
    prevent();
    openCopyHistory(root, notify);
    return true;
  }
  /**
   * 🔴 **お知らせを開く**(#582 段③ 第 2 群)── 押しボタンはヘルプの面の中にしか無く、面は開くまで組まれない
   *   (`open-manual-window` と同じ事情)。実体は `open-system-notices` の受け手と同じ `openSystemNotices` 1 本。
   * ⚠ 「システム」を開けるかは**画面の「設定」ボタンが出ているか**で決める(`open-settings` と同じ受け手。編集中も開ける ──
   *   `settings` は `ASIDE_PANES` に居るので、実ブラウザでも編集中に開いた)。押せない理由を持つ `disabled` の状態は無い。
   */
  if (cmd === 'open-system-notices') {
    const gate = root.querySelector<HTMLElement>(SHORTCUT_BUTTON['open-settings']!);
    if (gate === null) return false;
    if (dry) return true;
    prevent();
    openSystemNotices(dispatcher, root);
    return true;
  }
  /**
   * 🔴 **メッセージを開く**(#1017 C5)── 押しボタンを持たない(状態の行の押し口は未読のときだけ
   *   出る)ので、特例で直に開く。⚠ **編集中 / 失敗の画面では開かない**(reducer が断る遷移 ──
   *   `MESSAGES_READ`)。押せるふりをして黙って何も起きない行にしない:`dry` では偽(= 一覧は
   *   「いまは押せません ── <理由>」と言う)、実行では理由を出す。理由は `blockedActionNote` の 1 か所。
   */
  /**
   * 🔴 **メッセージを書き出す**(台帳 #1852 束 L1、依頼 92-1)── 押しボタンはシステムの画面の中にしか無く、面は開くまで
   *   組まれない。直す前は「システムの画面で『メッセージ』を開いているときだけ」押せたので、未読から開いたメッセージの
   *   ノートを読んでいる最中は、バグ報告に出す手が無かった。実体は押しボタンと同じ `exportMessagesNote` 1 本。
   * ⚠ 読み出す口が無い版(古いタブ)は押せない(`dry` では偽 = 一覧が理由を言う)。phase では断らない ── 読むだけで本文に触れない。
   */
  if (cmd === 'export-messages') {
    const svc = ROOT_SERVICES.get(root);
    if (svc?.readBodies === undefined) {
      if (dry) return false;
      prevent();
      notify('このタブの PKC3 が古いままのため、書き出せません。再読み込みしてください', CAUTION);
      return true;
    }
    if (dry) return true;
    prevent();
    exportMessagesNote(dispatcher, SYSTEM_MESSAGE_LID, svc);
    return true;
  }
  if (cmd === 'open-messages') {
    // 🔴 押せない理由も判定も `blockedActionNote` の 1 か所から(#791 ④ / #516 ── 保存に失敗している
    //   保護中に「編集中」と言わない)。⚠ ここで phase を読み替えて字を直書きしない(§7)
    const why = blockedActionNote(dispatcher.getState().phase);
    if (why !== null) {
      if (dry) return false;
      prevent();
      notify(`いまはメッセージを開けません: ${why}`, CAUTION);
      return true;
    }
    if (dry) return true;
    prevent();
    openMessagesNote(dispatcher, SYSTEM_MESSAGE_LID);
    return true;
  }
  /**
   * 🔴 **字幕ファイル(.srt)で書き出す**(#1447)── 押しボタンを持たないので特例で直に落とす。
   *
   * 🔑 読むのは**画面に出ている本文**(`openBody`。disk と同じ ── 編集中は `blockedActionNote` が断る)
   *   なので、読み直しも `services` も要らない。組むのは `srtFromTranscript` 1 本(pure)。
   * ⚠ 断りは 3 段で、どれも `dry` では偽(= 一覧は「いまは押せません ── <理由>」で**押せるふりをしない**):
   *   ①編集中 / 保護中(理由は `blockedActionNote` の 1 か所)②ノートを開いていない
   *   ③時刻つきの行が無い。⚠ ②③の字は `note`(`keymap.ts`)が一覧で出すので、ここは実行の断りだけ。
   * ⚠ 終了時刻は**推定**(次の行の開始 / 最後は `LAST_CUE_MS`)── 知らせでそう言う(黙って作らない)。
   */
  if (cmd === 'export-transcript-srt') {
    const st = dispatcher.getState();
    const why = blockedActionNote(st.phase);
    if (why !== null) {
      if (dry) return false;
      prevent();
      notify(`いまは字幕ファイルを書き出せません: ${why}`, CAUTION);
      return true;
    }
    const lid = st.selectedLid;
    const open = st.openBody;
    if (lid === null || open === null || open.lid !== lid) {
      if (dry) return false;
      prevent();
      notify('字幕にするノートがありません(先にノートを開いてください)', CAUTION);
      return true;
    }
    // ⚠ `dry` は一覧が 1 打鍵ごとに呼ぶ ── 全文を組まず「1 行でも在るか」だけ見る(`hasTranscriptCues`)
    if (!hasTranscriptCues(open.body)) {
      if (dry) return false;
      prevent();
      notify('行頭に時刻のある行(文字起こし)が無いので、字幕ファイルにできません', CAUTION);
      return true;
    }
    if (dry) return true;
    prevent();
    const srt = srtFromTranscript(open.body);
    if (srt === null) return false; // ⚠ `hasTranscriptCues` が真なら来ない(同じ読み)── tsc のための null 除け
    const title = st.entryMetas.get(lid)?.title ?? lid;
    downloadBlob(`${safeName(title)}-${dayStamp(new Date())}.srt`, new Blob([srt], { type: 'application/x-subrip' }));
    const n = transcriptCues(open.body).length;
    notify(`字幕ファイルを保存しました(${String(n)} 件。終わりの時刻は次の行の始まりです。次の行が無い・時刻が進んでいない行は 5 秒後と見なしています)`);
    return true;
  }
  /**
   * 🔴 **選択範囲をコピー**(#582 段③。🟣 Gemini の回答 = #1163 の依頼 22 の Q3 = A)── 「操作を探す」を開いた瞬間に控えた
   *   読む面の選択(Markdown の原文)をコピーする。押しボタン(`copy-selection-md`)は選択が消えると押せなくなるので、
   *   一覧からは `SHORTCUT_BUTTON` ではなく控え(`paletteSelection`)を読む特例にする。
   * ⚠ **控えが無ければ押せない**(`dry` では偽 = 一覧が「本文の中を選択してから呼んでください」と灰色で言う)。
   *   鍵・左の `>` の一覧には控えが無いので、いつも押せない側になる(選択が消えた後に呼べる顔をしない)。
   * ⚠ 控えているのは**字**であって Range ではない ── 描き直しで節点が消えても、開いたときの選択をそのままコピーできる。
   */
  if (cmd === 'copy-selection-md') {
    const memo = paletteSelection;
    if (memo === null || memo.root !== root) return false;
    if (dry) return true;
    prevent();
    const btn = root.querySelector<HTMLElement>('[data-pkc-action="copy-selection-md"]');
    void copyPlainText(memo.text).then((ok) => {
      if (!ok) dispatcher.dispatch({ type: 'OP_FAILED', error: 'コピーできませんでした' });
      else if (btn !== null) flashCopied(btn);
      else notify('選択範囲をコピーしました');
    });
    return true;
  }
  /**
   * 🔴 **前の日・次の日のノートを開く**(#1640 ②。依頼 58 = C)── 押しボタンを持たないので特例で直に呼ぶ。
   * 🔑 行き先は `adjacentDateNote`(題名が日付のノートのうち、ノートがある日だけ飛ぶ)。作らない。
   * ⚠ 断りは `dry` では偽(= 一覧は理由を言って押せるふりをしない):①編集中 / 保護中 ②開いているノートの題名が日付でない
   *   ③その向きに日付のノートが無い。
   */
  if (cmd === 'open-prev-day-note' || cmd === 'open-next-day-note') {
    const st = dispatcher.getState();
    const why = blockedActionNote(st.phase);
    if (why !== null) {
      if (dry) return false;
      prevent();
      notify(`いまは移れません: ${why}`, CAUTION);
      return true;
    }
    const cur = st.selectedLid === null ? undefined : st.entryMetas.get(st.selectedLid);
    if (cur === undefined || !isDateTitle(cur.title)) {
      if (dry) return false;
      prevent();
      notify('題名が日付(2026-10-15 の形)のノートを開いてから呼んでください', CAUTION);
      return true;
    }
    const dir = cmd === 'open-prev-day-note' ? 'prev' : 'next';
    const to = adjacentDateNote(st.entryMetas.values(), cur.title, dir);
    if (to === null) {
      if (dry) return false;
      prevent();
      notify(dir === 'prev' ? 'これより前の日付のノートはありません' : 'これより後の日付のノートはありません', CAUTION);
      return true;
    }
    if (dry) return true;
    prevent();
    if (st.viewMode !== 'detail') dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: to.lid });
    return true;
  }
  /**
   * 🔴 **このノートを Markdown で書き出す**(#1440)── 押しボタンを持たないので特例で直に呼ぶ。
   * 実体は右クリックの `export-entry-markdown` と同じ `services.exportEntryMarkdown`(`ROOT_SERVICES` から引く)。
   * ⚠ 断りは 3 段で、どれも `dry` では偽(= 一覧は「いまは押せません ── <理由>」で押せるふりをしない):
   *   ①編集中 / 保護中(理由は `blockedActionNote` の 1 か所)②ノートを開いていない ③配線が無い版。
   */
  if (cmd === 'export-note-markdown' || cmd === 'export-note-pdf') {
    const st = dispatcher.getState();
    const why = blockedActionNote(st.phase);
    if (why !== null) {
      if (dry) return false;
      prevent();
      notify(`いまは書き出せません: ${why}`, CAUTION);
      return true;
    }
    const lid = st.selectedLid;
    if (lid === null) {
      if (dry) return false;
      prevent();
      notify('書き出すノートがありません(先にノートを開いてください)', CAUTION);
      return true;
    }
    // 🔴 PDF(#1660)は右の列の「PDF で書き出す」(`export-entry-pdf`)と同じ `services.printNote`
    const svc = ROOT_SERVICES.get(root);
    const run = cmd === 'export-note-pdf' ? svc?.printNote : svc?.exportEntryMarkdown;
    if (run === undefined) {
      if (dry) return false;
      prevent();
      notify('このタブの PKC3 が古いままのため、書き出せません。再読み込みしてください', CAUTION);
      return true;
    }
    if (dry) return true;
    prevent();
    run(lid);
    return true;
  }
  /**
   * 🔴 **マニュアルを別のウィンドウで開く**(#1452 案 1)── 押しボタンはヘルプの面の中にしか無く、
   *   面は開くまで組まれない(`center.ts` は `help` の面のときだけ `render` する)ので、
   *   `SHORTCUT_BUTTON` では「ヘルプを 1 度開いた後」しか押せない。実体は押しボタンと同じ
   *   `services.openManualWindow`(`ROOT_SERVICES` から引く)── 口を 2 つ作らない。
   * ⚠ phase で断らない ── 別のウィンドウは本文に触らないので、編集中こそ押したい(提案の核)。
   * ⚠ 配線が無い版(古いタブ)では、押しボタンと同じ字で断る(`dry` では偽 = 一覧が理由を言う)。
   */
  if (cmd === 'open-manual-window') {
    const open = ROOT_SERVICES.get(root)?.openManualWindow;
    if (open === undefined) {
      if (dry) return false;
      prevent();
      notify(MANUAL_WINDOW_STALE, CAUTION);
      return true;
    }
    if (dry) return true;
    prevent();
    open();
    return true;
  }
  /**
   * 🔴 **スタックの 3 手**(#633 段②)── 押しボタンを持たないので、`view-dual` と同じく
   *   ここで直に投げる。⚠ 断り文は**ここに書かない**ものと**ここで言うもの**を分ける:
   *   満杯・フォルダの断りは reducer が 1 か所で出す(`PIN_SPLIT_ENTRY`)。
   *   ここで言うのは「**対象そのものが無い**」ときだけ ── reducer は lid の無い action を
   *   受け取れないので、ここでしか言えない(`dry` では `false` = パレットが
   *   「いまは押せません ── <note>」を出す)。
   */
  if (cmd === 'stack-push') {
    const lid = dispatcher.getState().selectedLid;
    if (lid === null) {
      if (dry) return false;
      prevent();
      notify('スタックに載せるノートがありません(先にノートを開いてください)', CAUTION);
      return true;
    }
    if (dry) return true;
    prevent();
    dispatcher.dispatch({ type: 'PIN_SPLIT_ENTRY', lid });
    return true;
  }
  if (cmd === 'stack-open' || cmd === 'stack-clear') {
    const st = dispatcher.getState();
    // 🔑 数えるのは帯と同じ口(`knownSplitLids`)── 消えた lid を「載せてある」と数えない
    const stack = knownSplitLids(st.splitLids, st.entryMetas);
    if (stack.length === 0) {
      if (dry) return false;
      prevent();
      notify('スタックに載せてあるノートがありません', CAUTION);
      return true;
    }
    if (dry) return true;
    prevent();
    if (cmd === 'stack-clear') {
      dispatcher.dispatch({ type: 'CLEAR_SPLIT' });
      notify(`スタックから ${String(stack.length)} 件を降ろしました(ノートは消えていません)`);
      return true;
    }
    /**
     * 🔑 **一覧は「載せてある順」= 一番上から**(帯と同じ並び)。`entryPickRows` に
     *   `order` としてスタックを渡す ── 題名で絞る規則と切ったときの断りを**書き直さない**。
     * ⚠ 自分自身は除かない(`selfLid: null`)── 主と同じノートを載せる形は許している
     *   (`split-frames.ts` の `normalizeSplitLids`)。
     * ⚠ 開いている間に別のタブが降ろしても、打つたびに引き直すので一覧は追随する。
     */
    void pickEntryInApp(
      root,
      (query) => {
        const now = dispatcher.getState();
        const lids = knownSplitLids(now.splitLids, now.entryMetas);
        const items = entryPickRows(now.entryMetas, lids, query, null);
        return { items, note: entryPickNote(items.length, entryPickTotal(now.entryMetas, lids, query, null)) };
      },
      { title: 'スタックから開く(選んだ物が一番上に来ます)' },
    ).then((lid) => {
      if (lid === null) return;
      dispatcher.dispatch({ type: 'PIN_SPLIT_ENTRY', lid });
    });
    return true;
  }
  /**
   * 🔴 **`close-pane` は、閉じる物が無ければ「効いていない」と答える**
   * (#1042 段③)。
   *
   * ⚠ 下の共通経路(`SHORTCUT_BUTTON`)は「ボタンが在って `disabled` でなければ
   *   handled」で判定するが、この押しボタンは**面が無いときも `hidden` のまま
   *   DOM に居続ける**(`center.ts`)ので、常に「押せる」と読めてしまう。
   *   選択なし・面なしの本文で `Escape` を押すと、`close-pane` の実体は
   *   `SET_VIEW_MODE 'detail'` を**同じ値で撃ち直すだけ**なのに `handled: true`
   *   を返し、`ke.preventDefault()` だけが起きて**何も変わらないのに Escape が
   *   呑まれる**(ブラウザの既定を含め、以後の聞き手にも渡らない)。
   * 🔑 **「面が在る」も「別ウィンドウである」も、`viewMode !== 'detail'` の
   *   1 つで言える** ── 別ウィンドウは `view=` を持つ間 `viewMode` が必ず
   *   その面を指すよう `deep-link.ts` の `apply()` / `onViewChange` が同期で
   *   揃えている(`view=` が外れた瞬間 `viewMode` も `'detail'` に戻る)ので、
   *   2 つ目の判定を作らずに済む(CLAUDE.md §7)。
   */
  if (cmd === 'close-pane' && dispatcher.getState().viewMode === 'detail') return false;
  /**
   * 🔴 **「すべて置換」は編集中にしか効かない**(#582 段③ 第 2 群の着地前レビュー)。
   * ⚠ 置換の欄は保存した後も開いたまま残る(`REPLACE_IN_BODY` は `phase !== 'editing'` で黙って捨てる)ので、
   *   ボタンが画面に在るだけでは「押せる」と言えない。理由は `keymap.ts` の `note`(編集中に使う)が言う。
   * ⚠ ここは**押せるか**だけ ── 受け手(`replace-all` の本文)には触れない。
   */
  if (cmd === 'replace-all' && dispatcher.getState().phase !== 'editing') return false;
  /**
   * 🔴 **ゴミ箱へ移した直後の「元に戻す」**(#1087)── 押しボタンは知らせの隣に出ている間しか無いので、
   *   `SHORTCUT_BUTTON` ではなく特例で、ボタンの受け手(`ACTIONS['undo-trash']`)をそのまま呼ぶ(戻す実体を 2 つ作らない)。
   * ⚠ 戻せる物が無いときは、`dry` では偽(= 一覧は「いまは押せません ── <理由>」と言う)、鍵では**黙らず**断る
   *   (`undo-dual-move` の「戻せるものがありません」と同じ頭)。
   */
  if (cmd === 'undo-trash') {
    if (currentTrashOffer() === null) {
      if (dry) return false;
      prevent();
      notify('戻せるものがありません(ゴミ箱へ移した直後だけ戻せます)', CAUTION);
      return true;
    }
    if (dry) return true;
    prevent();
    ACTIONS['undo-trash']!(dispatcher, root, ROOT_SERVICES.get(root) ?? ({} as BinderServices), root);
    return true;
  }
  /**
   * 🔴 **2 ペインで移した(コピーした)直後の「元に戻す」**(台帳 #1852 N1 / 依頼 324 A)── `undo-trash` と同じ作り。
   *   押しボタンは知らせの隣に出ている間しか無いので、特例でボタンの受け手(`ACTIONS['undo-dual-move']`)をそのまま呼ぶ(戻す実体を 2 つ作らない)。
   * ⚠ 戻せる物が無いときは、`dry` では偽(一覧は「いまは押せません ── <理由>」と言う)、鍵では**黙らず**断る。
   */
  if (cmd === 'undo-dual-move') {
    if (currentDualMoveOffer() === null) {
      if (dry) return false;
      prevent();
      notify('戻せるものがありません(2 ペインで移した直後だけ戻せます)', CAUTION);
      return true;
    }
    if (dry) return true;
    prevent();
    ACTIONS['undo-dual-move']!(dispatcher, root, ROOT_SERVICES.get(root) ?? ({} as BinderServices), root);
    return true;
  }
  const sel = SHORTCUT_BUTTON[cmd];
  if (sel === undefined) return false;
  const btn = root.querySelector<HTMLElement>(sel);
  if (btn === null) return false;
  // 🔴 行ごと隠してある間は「効かない」(#582 段③。`PALETTE_HIDDEN_OK` の注釈)
  if (!PALETTE_HIDDEN_OK.has(cmd) && btn.closest('[hidden]') !== null) return false;
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
  /**
   * 🔴 **押せないボタンを鍵で撃ったら、理由を言う**(#761)。
   *
   * ⚠ `disabled` のボタンは `click()` が**無反応**なので、直す前は
   *   `Ctrl+N` が**完全に無音**だった ── 鍵は見た目を持たないので、
   *   「押せない見た目」(#715)では**鍵の人に何も届かない**。
   * 🔑 理由は**ボタン自身が持っている**(`setBlocked` が置く)── ここで
   *   phase を読み直すと、同じ問いに答える口が 2 つになる(CLAUDE.md §7)。
   * ⚠ **理由を持たない `disabled` は今までどおり無音**(`nav-back` など)──
   *   あちらは「履歴が無い」だけで、言うことが無い。⚠ ここで一律に
   *   何か言うと、`Alt+←` を連打しただけで字が出続ける。
   */
  if (btn instanceof HTMLButtonElement && btn.disabled) {
    const why = btn.getAttribute(HINT_BLOCKED);
    // ⚠ 戻る / 進む は hover の理由(#1087 L4)を持つが、鍵では今までどおり黙る(上の注釈の連打)
    if (why !== null && why !== '' && !QUIET_WHEN_BLOCKED.has(cmd)) notify(why);
    return true;
  }
  if (focusFieldFirst(cmd, btn, root, notify)) return true;
  btn.click();
  return true;
}

/** 押せないときに鍵で撃っても黙る操作(#761 の連打への配慮。理由はボタンの hover にだけ出す) */
const QUIET_WHEN_BLOCKED: ReadonlySet<string> = new Set(['nav-back', 'nav-forward']);

/**
 * 🔴 **お知らせの節を開く**(ヘルプの「お知らせを開く」と「操作を探す」の**唯一の実体**。§7)。
 * ⚠ `dispatch` は同期なので、`openView` が返った時点で「システム」は描き終わっている ── その後に節を探せる。
 */
function openSystemNotices(dispatcher: Dispatcher, root: HTMLElement): void {
  /**
   * 🔴 **ヘルプから来たときだけ、「← ヘルプへ戻る」を出す**(依頼 67-1。Gemini 裁定 2026-10-13 = 推薦どおり)。
   * ⚠ 来た場所は**押した瞬間の表示**で決める(`viewMode === 'help'`)── 操作を探す・別の入口から開いた回は出さない。
   * ⚠ 読んでいた位置(外側の転がり + マニュアルの転がり)を控える ── 面は隠れると転がりを失うことがあるので、戻るときに書き戻す。
   */
  const fromHelp = dispatcher.getState().viewMode === 'help';
  helpReturn = fromHelp ? helpScrollOf(root) : null;
  openView(dispatcher, 'settings');
  const back = root.querySelector<HTMLElement>('[data-pkc-field="settings-back-to-help"]');
  if (back !== null) back.hidden = !fromHelp;
  if (fromHelp) {
    // ⚠ システムを離れたら畳む ── 次に別の入口から来たとき、古い「戻る」が残らない
    const off = dispatcher.onState((st) => {
      if (st.viewMode === 'settings') return;
      off();
      root
        .querySelector<HTMLElement>('[data-pkc-field="settings-back-to-help"]')
        ?.setAttribute('hidden', '');
      helpReturn = null;
    });
  }
  root
    .querySelector<HTMLElement>('[data-pkc-region="settings-notices-section"]')
    ?.scrollIntoView({ block: 'start' });
}

/** ヘルプを読んでいた位置(依頼 67-1)。⚠ 「ヘルプから来た」ときだけ入る。 */
let helpReturn: { readonly outer: number; readonly manual: number } | null = null;

function helpScrollOf(root: HTMLElement): { outer: number; manual: number } {
  return {
    outer: root.querySelector<HTMLElement>('[data-pkc-region="detail"]')?.scrollTop ?? 0,
    manual: root.querySelector<HTMLElement>('[data-pkc-region="help-manual"]')?.scrollTop ?? 0,
  };
}

/**
 * 🔴 **システムの特定の節を開く**(依頼 61-2 の「システムを開く」)。`openSystemNotices` と同じ形
 * (`openView` は同期で描き終えるので、その後に節を探せる)。
 */
function openSystemRegion(dispatcher: Dispatcher, root: HTMLElement, region: string): void {
  openView(dispatcher, 'settings');
  root
    .querySelector<HTMLElement>(`[data-pkc-region="${region}"]`)
    ?.scrollIntoView({ block: 'start' });
}

/**
 * 🔴 **欄が空なら、欄へ移って理由を言う**(#582 段③。`PALETTE_FIELD_FIRST` の注釈)。
 * @returns 欄へ移した(= ボタンは押さない)か
 */
function focusFieldFirst(
  cmd: string,
  btn: HTMLElement,
  root: HTMLElement,
  notify: (text: string, opts?: StatusOptions) => void,
): boolean {
  const ask = PALETTE_FIELD_FIRST[cmd];
  if (ask === undefined) return false;
  const field = btn.parentElement?.querySelector<HTMLInputElement | HTMLTextAreaElement>(ask.field) ?? null;
  // ⚠ 欄が見つからないときはボタンを押す(受け手が「入力してください」と言う ── 黙らない)
  if (field === null || field.value.trim() !== '') return false;
  /**
   * 🔑 畳んでいるなら先に戻す(`focus-search` と同じ作法。畳んだペインは DOM に残るので、
   *   戻さずに焦点を入れると**見えない欄に入って何も起きない**)。スマホは列が無いので触らない。
   */
  if (ask.pane !== null && !appPhone.isPhone()) {
    const hidden = appPanes.getHidden();
    if (hidden.includes(ask.pane)) {
      applyPaneVisibility(root, appPanes.setHidden(hidden.filter((x) => x !== ask.pane)));
    }
  }
  field.focus();
  notify(ask.say, CAUTION);
  return true;
}

/**
 * 🔴 **メッセージのノートを開く実体は 1 本**(設計 doc §7、段②a / #1017 C5)。
 *
 * ⚠ 押しボタン(`open-messages` の受け手)と、「操作を探す」・左の `>` の一覧の「メッセージを開く」
 *   (`runGlobalCommand`)の**両方がここを通る** ── 開く + 既読の 2 手を 2 か所に書くと、片方だけ
 *   既読にしない日が来る(§7)。
 */
function openMessagesNote(dispatcher: Dispatcher, lid: string): void {
  // 🔴 開き直したときは種類の絞りを「すべて」へ戻す(前に絞ったまま、知らせが見えない画面で開かない。台帳 #1852 束 L1、依頼 266)
  setMessageKindFilter(null);
  dispatcher.dispatch({ type: 'MESSAGES_READ', lid });
  appMessagePost.markRead();
}

/**
 * 🔴 **メッセージ(・処理の記録)を書き出す実体は 1 本**(設計 doc §7、段②a)── バグ報告に貼る用。
 *
 * ⚠ 押しボタン(`export-messages` の受け手。システムの節・メッセージのノートの上の帯)と、「操作を探す」・左の `>` の一覧
 *   (`runGlobalCommand`。**どの画面からでも**押せる ── 台帳 #1852 束 L1、依頼 92-1)の**両方がここを通る**。
 * ⚠ **新しい書き出しの仕組みを作らない**(§7「普通のノートと同じ道具」)── 本文をそのまま `.md` として落とすだけ
 *   (整形・要約はしない)。`lid` で「メッセージ」か「処理の記録」かが決まる(依頼 217 / 265 / 345)。
 */
function exportMessagesNote(dispatcher: Dispatcher, lid: string, services: BinderServices): void {
  const read = services.readBodies;
  const what = titleForMessageLid(lid);
  if (!read) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: 'このタブの PKC3 が古いままのため、書き出せません。再読み込みしてください' });
    return;
  }
  /**
   * 🔴 **書き出したこと・書き出せなかったことを言う**(#1087 の見直し 2026-10-13)── 直す前は成功しても何も言わず、
   *   読めなかったときも黙って終わっていた。
   */
  // 🔴 書けずに控えへ回った節も含める(#1087 M1)
  void appMessagePost
    .withSpool(lid, async () => (await read([lid])).get(lid) ?? '')
    .then((body) => {
      const today = dayStamp(new Date());
      const name = `${what}-${today}.md`;
      downloadBlob(name, new Blob([body], { type: 'text/markdown' }));
      services.showStatus?.(`${what}を書き出しました(${name})`);
    })
    .catch((e: unknown) => {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        // ⚠ 例外の前置き「Error:」は出さない / 次に何をするかを言う(#1087)
        error: `${what}を書き出せませんでした(${errorText(e)})。もう一度押してください`,
      });
    });
}

/**
 * 🔴 **押しボタンから開くときの門**(#1087)。⚠ 直す前は、編集中 / 保護中に「未読 N 件」や「メッセージを開く」を
 *   押すと、reducer が黙って断るうえに、端末の既読の時刻だけ進んでいた(開いていないのに既読)。
 * 🔑 理由は「操作を探す」の側と同じ `blockedActionNote` の 1 か所から引く(§7)。
 */
function openMessagesFromButton(dispatcher: Dispatcher, lid: string): void {
  // ⚠ 断るのは reducer が断る 2 つ(編集中 / 保存に失敗)だけ ── 読み込み中は reducer が通すので、ここも通す
  const phase = dispatcher.getState().phase;
  const why = phase === 'editing' || phase === 'error' ? blockedActionNote(phase) : null;
  if (why !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `いまはメッセージを開けません: ${why}` });
    return;
  }
  openMessagesNote(dispatcher, lid);
}

/**
 * 🔴 **操作の一覧の行を組む口は 1 つ**(#274 段①)。
 *
 * ⚠ 操作のパレット(`openPaletteFor`)と、左の列の探す欄に `>` を打ったときの一覧が
 *   **同じ行を出す** ── 「いま押せるか」の判定(`runGlobalCommand` の dry)・押せない理由・
 *   絞り込み(`paletteRows`)を 2 本に分けると、同じ語に別の答えが出る(§7)。
 * @param target 開いた瞬間に焦点が在った本文の欄(記法の命令が押せるかを決める)。
 *   ⚠ 左の列の欄から呼ぶときは `null`(記法は本文の欄に居ないと押せない)
 */
export function commandRowsFor(
  root: HTMLElement,
  dispatcher: Dispatcher,
  keymap: KeymapStore,
  query: string,
  target: HTMLTextAreaElement | null,
  /** 🔴 「操作を探す」の面から呼んでいるか(左の `>` の一覧は偽)。「選択範囲をコピー」の押せない理由の言い方が変わる。 */
  inPalette = false,
): readonly PaletteRow[] {
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
    if (target !== null && editorCommand(c.id)) {
      ready.add(c.id);
      continue;
    }
    /**
     * 🔴 **「ノートを閉じる」(reading)と「画面を閉じる」(window)も、押せるかを聞く**(#1087 の見直し 2026-10-13)。
     * ⚠ 直す前は全域の命令しか聞かなかったので、ノートを読んでいる最中でも「ノートを閉じる」が**いつも灰色**だった
     *   (`runGlobalCommand` には 2 つとも「押せるか」だけ答える口が在り、選んだ後の実行もそこを通るのに、一覧が先に外していた)。
     */
    // 🔴 `undo-trash` は鍵だけフォルダの表(`filer` / `dual`)に付くが、一覧からはどこからでも呼べる(#1163 依頼 132)── 実体は `runGlobalCommand` の 1 本
    if (!c.contexts.some((ctx) => ctx === 'global' || ctx === 'reading' || ctx === 'window') && c.id !== 'undo-trash')
      continue;
    if (runGlobalCommand(c.id, root, dispatcher, keymap, noop, noop, true)) ready.add(c.id);
  }
  /**
   * ⚠ **自分自身は並べない** ── パレットからパレットを開く行に意味は無い。
   * 🔑 外すのは**ここ 1 か所** ── `ready` の側でも外すと、片方を消しても
   *   もう片方が救うので、**どちらが効いているか分からなくなる**(§1)。
   */
  /**
   * 🔴 **押せない理由は、そのボタン自身から引く**(#791 ④。user 裁定 2026-09-08)。
   *
   * ⚠ 直す前は `keymap.ts` の `note`(静的な字)しか出ておらず、
   *   ①**出口(保存 / キャンセル)を言わない** ②**保存に失敗している保護中でも
   *   「編集中は効きません」と出る**(#516 が直したはずの形)を踏んでいた。
   * 🔑 `SHORTCUT_BUTTON` で当のボタンを引き、`setBlocked` が置いた
   *   `data-pkc-blocked` を読む ── ここで phase を読み直すと**判定が 2 か所**になる(§7)。
   */
  const blockedReason = (id: string): string | null => {
    // ⚠ 「メッセージを開く」は押しボタンを持たない(左の列の同名は別の口)── 理由は
    //   `runGlobalCommand` の断りと同じ `blockedActionNote` から引く(出口まで言う。UX レビュー 2026-10-03)
    //   「字幕ファイル(.srt)で書き出す」(#1447)も同じ(押しボタンを持たない)── 時刻つきの行が無い理由は `note` が言う
    if (id === 'open-messages' || id === 'export-transcript-srt' || id === 'export-note-markdown' || id === 'export-note-pdf' || id === 'open-prev-day-note' || id === 'open-next-day-note') return blockedActionNote(dispatcher.getState().phase);
    // 「選択範囲をコピー」── 控えが無いときの理由(押しボタンを持たない)。左の `>` の一覧では選択が残らないので、呼べる道を言う
    if (id === 'copy-selection-md')
      return inPalette ? SELECTION_FIRST : `${SELECTION_FIRST}(選択してから「操作を探す」を開いてください)`;
    // 「マニュアルを別のウィンドウで開く」(#1452 案 1)── 押せないのは配線が無い版だけ(phase では断らない)
    if (id === 'open-manual-window') return ROOT_SERVICES.get(root)?.openManualWindow === undefined ? MANUAL_WINDOW_STALE : null;
    const sel = SHORTCUT_BUTTON[id];
    if (sel === undefined) return null;
    return root.querySelector(sel)?.getAttribute(HINT_BLOCKED) ?? null;
  };
  /**
   * 🔴 **左の `>` の一覧では、本文の欄が要る操作の理由を「どうすれば呼べるか」で言う**(#1206 D3)。
   * ⚠ 直す前は「2 ペインの編集 / 行の編集にいるときだけ効きます」── 左で打っている限り
   *   その状態は作れず、**行き止まりに読めた**。⚠ 宛先が `null`(左の欄から)のときだけ ──
   *   本文の欄から開いたパレットの理由は変えない。
   * 🔑 「本文の欄が要る」の判定は `editorCommand` **1 つ**(上の `ready` と同じ表)。
   */
  const needsEditorField = target === null ? editorCommand : undefined;
  return paletteRows(
    query,
    keymap.getBindings(),
    ready,
    isMac(),
    blockedReason,
    needsEditorField,
    target !== null,
  ).filter((r) => r.id !== 'open-palette');
}

/**
 * 🔴 **1 面のライブ編集で、左の探す欄へ焦点が移る直前の「打っていた行」**(#582)。
 *
 * ⚠ 探す欄を押すと焦点が外れて行は確定し、`row-source` が DOM から消える ── そのままでは `>` の一覧から
 *   「日付を入れる」などを選んでも書き込む欄が無い。消える前に、どの行の・どの字で・どこに caret が居たかを控える。
 * ⚠ 控えるのは**行が探す欄へ焦点を渡した瞬間だけ**(それ以外の blur では捨てる ── 古い控えで別の場所へ入れない)。
 */
interface LiveRowMemo {
  readonly root: HTMLElement;
  readonly lid: string;
  readonly line: number;
  readonly source: string;
  readonly start: number;
  readonly end: number;
}
let liveRowMemo: LiveRowMemo | null = null;
/** 控えを取り出して捨てる。⚠ `>` の一覧の行を押したら、どの命令でも**まず捨てる**(次の別の操作が古い控えを拾わない)。 */
function takeLiveRowMemo(): LiveRowMemo | null {
  const m = liveRowMemo;
  liveRowMemo = null;
  return m;
}
/** 控えを持ったまま居てよい場所(探す欄と、その一覧の行)。 */
const MEMO_KEEP = '[data-pkc-field="entry-filter"],[data-pkc-action="run-command-row"]';

/**
 * 🔴 **左の `>` の一覧から「打っている場所に入れる」操作を呼ぶ前に、1 面の行を開き直して caret を戻す**(#582)。
 *
 * @returns `true` = 呼び側がそのまま実行してよい(欄が在る / 開き直せた)。`false` = 実行しない(理由は出した。
 *   予約に回ったときは着弾後に `run` を呼ぶ ── 同期とは限らない)
 * ⚠ 控えと違う行が開いたとき(本文が変わった / 別のノート / 面が違う)は `FIELD_CHANGED` で断る。
 *   戻し方は「操作を探す」(`openPaletteFor`)と同じく**範囲を setSelectionRange で戻す**1 本 ── 欄の側(`RowSwap.finishRestore`)が持つ。
 */
function reopenLiveRowThen(env: CommandEnv, id: string, memo: LiveRowMemo | null, run: () => void): boolean {
  if (!CARET_INSERT_TOOLS.has(id)) return true;
  // 欄が在る(2 列の編集など)── 選択が欄に残っているので、そのまま実行する
  if (memo === null || memo.root !== env.root || formatTarget(env.root) !== null) return true;
  // 探す欄が `>` の一覧を出していないなら、この控えは今の操作のものではない(古い控えで行を開かない)
  if (!env.dispatcher.getState().filterQuery.trimStart().startsWith('>')) return true;
  const pane = env.root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]');
  if (pane === null || env.dispatcher.getState().openBody?.lid !== memo.lid) {
    env.dispatcher.dispatch({ type: 'OP_FAILED', error: FIELD_CHANGED });
    return false;
  }
  const detail: RowReopenDetail = {
    line: memo.line,
    source: memo.source,
    start: memo.start,
    end: memo.end,
    done: (ok) => {
      if (ok) run();
      else env.dispatcher.dispatch({ type: 'OP_FAILED', error: FIELD_CHANGED });
    },
  };
  pane.dispatchEvent(new CustomEvent<RowReopenDetail>(ROW_REOPEN_EVENT, { detail }));
  return false;
}

/** 一覧を開いている間に、書き込む欄が組み直されたとき(記法 / 本文の欄へ当てる命令 / 打っている場所に入れる命令で共通)。 */
const FIELD_CHANGED = '書き込む欄が変わったので入れませんでした(もう一度選んでから実行してください)';

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
  /** 🔴 画面へ 1 行出す口(#522)。⚠ optional にしない ── 落とすと「押しても何も言わない」に戻る。 */
  notify: (text: string, opts?: StatusOptions) => void,
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
  /**
   * 🔴 **範囲を戻す先は、焦点が欄に無くても引く**(#582 段③ 第 3 群の着地前レビュー)。
   *
   * ⚠ 「操作を探す」のボタンをマウスで押すと、焦点はボタンへ移る(`mousedown` の既定を止めてあるが、押し方は他にも在る)。
   *   そのとき `target` は `null` なので、戻さずに押すと**本文の先頭に入り、一覧は押せる顔のまま**だった。
   * 🔑 開いた瞬間の欄の範囲は、焦点を失っても欄に残っている(`selectionStart` は焦点と無関係)── 帯のボタンを直接押したときと同じ欄・同じ範囲。
   * ⚠ 記法(`target`)の「本文の欄に居るときだけ押せる」判定は変えない。ここは範囲を戻す先だけ。
   */
  const restoreField = target ?? formatTarget(root);
  const restoreRange =
    restoreField === null ? null : { start: restoreField.selectionStart, end: restoreField.selectionEnd };
  /**
   * 🔴 **読む面の選択を、開く前に字として控える**(#582 段③「選択範囲をコピー」)。
   * ⚠ 一覧が開くと選択は消える。ここで読むのは**開く操作の同期の中**(まだ選択が残っている間)。閉じたら `finally` で捨てる。
   */
  const selBody = dispatcher.getState().openBody?.body;
  const selHost = viewBodyHost(root);
  const selText = selBody !== undefined && selHost !== null ? selectedMarkdown(selHost, selBody) : null;
  const selMemo: PaletteSelection | null = selText === null ? null : { root, text: selText };
  paletteSelection = selMemo;
  const rows = (query: string) => commandRowsFor(root, dispatcher, keymap, query, target, true);
  /**
   * 🔴 **「操作を探す」も、左の `>` と同じ「最近使った操作」を使う**(#274 Q3 = A)。⚠ 記録は 1 つ
   *   (`appRecentCommands`)── 開くたびに保存を引く(別のタブで使った物も出る)。
   */
  void pickCommandInApp(root, rows, () => appRecentCommands.list()).then((picked) => {
    if (picked === null) return;
    // ⚠ 既定を止める口は要らない(打鍵ではないので) ── 実行だけする
    /**
     * 🔴 **「打っている場所に入れる」操作は、開いたときの範囲を戻してから押す**(#582 段③ 第 3 群)。
     *
     * ⚠ 一覧を閉じた直後の欄は、器が焦点を返す瞬間に選択が `0,0` へ戻っている(上の `range` の注釈と同じ事象)。
     *   画面のボタン(日付 / ノートリンク / テンプレート / 図 / アイコン)は押した瞬間の `selectionStart` を読むので、
     *   戻さずに押すと**本文の先頭に入る**。実ブラウザで、`hello world` の 5 字目で一覧から「日付を入れる」を呼んだら
     *   `@2026-10-12hello world` になった(1 面の行・2 列の欄とも。`insert-date` / `insert-snippet` は第 1 群から登記済みで、同じ穴を持っていた)。
     * 🔑 戻すのは**押す前の 1 回だけ**でよい ── 日付 / ノート / テンプレート / 図 / アイコンは、押した瞬間に範囲を控えてから
     *   自分の小窓を開く(小窓の後に戻すのは各自の仕事。`at` を握っている)ので、小窓をまたいでも先頭には入らない。
     * ⚠ 控えた欄が消えていたら、押さずに理由を出す(組み直された別の欄の先頭へ入れない ── 下の記法と同じ門)。
     * ⚠ 集合は `CARET_INSERT_TOOLS`(`CARET_TOOLS` から全文の道具を除いた物。1 本)。全文の道具(番号 / 完了項目)は範囲を読まず、
     *   これまでどおり押す側が欄を引き直す(欄が消えていても断らない)。
     */
    if (restoreField !== null && restoreRange !== null && CARET_INSERT_TOOLS.has(picked)) {
      if (!restoreField.isConnected) {
        dispatcher.dispatch({ type: 'OP_FAILED', error: FIELD_CHANGED });
        return;
      }
      /**
       * ⚠ 焦点は戻さない(`EDITOR_RUN` の経路と違う所)── 器が閉じるときに既に返しており、各ボタンは挿す前に自分で
       *   `focus()` する。ここに `focus()` を足しても変異試験で SURVIVED(unit・実ブラウザの両方)だったので、書かない。
       */
      restoreField.setSelectionRange(restoreRange.start, restoreRange.end);
    }
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
    if (runGlobalCommand(picked, root, dispatcher, keymap, noop, notify)) {
      // 🔴 実行が**済んだ**ときだけ憶える(左の `>` の一覧と同じ記録。鍵は label ではなく id)
      appRecentCommands.push(picked);
      return;
    }
    /**
     * 🔴 **選んだ行が実行できなかったときは、黙らない**(#1087 の見直し 2026-10-14)。⚠ 直す前は何も言わずに閉じていた
     *   (一覧を描いてから状態が動いて押せなくなった回)。左の `>` の一覧(`runCommandRow`)と同じ字を同じ 1 か所から出す。
     */
    if (!editorCommand(picked)) {
      notify(COMMAND_NOT_READY_NOTE, CAUTION);
      return;
    }
    /**
     * 🔴 **記法を、開いたときの欄へ当てる**(#425 段②-b)。
     *
     * ⚠ **控えた欄が消えていたら、当てずに理由を出す** ── 待っている間に面ごと
     *   組み直されると別の要素になっており、そこへ当てると**選択範囲は先頭**なので
     *   **user が選んでいない所に記法が入る**(本文が静かに壊れる向き)。
     * 🔑 「無言で捨てない」と「間違った所へ書かない」は両立する ── 断り文を出す。
     */
    if (target === null) {
      notify(COMMAND_NOT_READY_NOTE, CAUTION);
      return;
    }
    if (!target.isConnected) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: FIELD_CHANGED });
      return;
    }
    /**
     * 🔴 **記法でない「本文の欄へ当てる命令」も、同じ門を通す**(#766 D-2)。
     * ⚠ 上の 2 つの門(欄が在る / 欄が生きている)は**どちらの命令にも要る** ──
     *   ここで分岐を上へ移すと、計算だけが門を通らない形になる。
     * ⚠ 焦点を返してから当てる ── パレットが閉じた直後の選択は `0,0` なので、
     *   **控えた範囲**(`range`)へ戻してから読む(記法と同じ作法)。
     */
    const runEditor = EDITOR_RUN[picked];
    if (runEditor !== undefined) {
      target.focus();
      if (range !== null) target.setSelectionRange(range.start, range.end);
      runEditor(target, notify);
      appRecentCommands.push(picked);
      return;
    }
    if (applyFormatTo(target, picked, range ?? undefined, notify)) appRecentCommands.push(picked);
  }).finally(() => {
    // 控えは閉じたら捨てる(別の呼び出しが古い選択をコピーしない)。別の開き直しが上書き済みなら触らない
    if (paletteSelection === selMemo) paletteSelection = null;
  });
}

/**
 * 🔴 **左の列の探す欄に `>` を打ったときの、操作の実行**(#274 段①。姿 = D)。
 *
 * ## 実行の道は 1 本
 *
 * 宣言の無い操作は `runGlobalCommand`(鍵・パレットと同じ道)をそのまま呼ぶ ──
 * ⚠ 2 本目の実行経路を作らない(§7)。**宣言のある操作(`KeyCommand.needs`)だけ**、
 * 選んだ後に相手のノートを `pickEntryInApp`(題名で探して選ぶ小窓)で聞いてから実行する。
 */
export interface CommandEnv {
  readonly root: HTMLElement;
  readonly dispatcher: Dispatcher;
  readonly keymap: KeymapStore;
  /** 🔴 画面へ 1 行出す口(#522)。⚠ optional にしない。 */
  readonly notify: (text: string, opts?: StatusOptions) => void;
}

/** 🔴 選んだ操作が、実行する時点で押せなくなっていたときの 1 行(左の `>` の一覧と「操作を探す」が同じ字を出す。1 か所)。 */
export const COMMAND_NOT_READY_NOTE = 'この操作はいま実行できません';

/** 相手のノートが決まったあとに走る実体。 */
export type CommandWithEntry = (lid: string, env: CommandEnv) => void;

/**
 * 🔑 **相手のノートを選んでから実行する操作の実体**(`KeyCommand.needs: 'entry'` と 1:1)。
 *
 * 🔴 2026-10-01 時点で **0 件** ── 既存の「移す」系(フォルダへ移す… / 反対のペインへ移す)は
 * 実行の中で行き先を**自分で聞く**ので、宣言は要らなかった。欄と配線だけ先に用意してある。
 * ⚠ `needs` を足したら、ここにも同じ id を足す(食い違いは
 *   `tests/adapter/command-list.test.ts` が全数で見る)。
 */
export const COMMAND_WITH_ENTRY: Readonly<Record<string, CommandWithEntry>> = {};

/**
 * 一覧の行を実行する。
 * @returns 実行を始めたか(`false` = 受け付けなかった。⚠ 理由は `notify` で言う)
 * @param opts.onDone 実行が**済んだ**ときだけ呼ぶ(相手を選ぶ小窓をやめたときは呼ばない ──
 *   打った字を残して、選び直せるようにする)
 * @param opts.commands / opts.withEntry test が差し替える(既定は本物の表)
 */
export function runCommandRow(
  id: string,
  env: CommandEnv,
  opts: {
    readonly onDone?: () => void;
    readonly commands?: readonly KeyCommand[];
    readonly withEntry?: Readonly<Record<string, CommandWithEntry>>;
  } = {},
): boolean {
  const cmd = (opts.commands ?? KEY_COMMANDS).find((c) => c.id === id);
  if (cmd === undefined) return false;
  if (cmd.needs === 'entry') {
    const exec = (opts.withEntry ?? COMMAND_WITH_ENTRY)[id];
    if (exec === undefined) {
      env.notify(COMMAND_NOT_READY_NOTE, CAUTION);
      return false;
    }
    void pickEntryInApp(
      env.root,
      (query) => {
        const now = env.dispatcher.getState();
        const items = entryPickRows(now.entryMetas, now.order, query, null);
        return {
          items,
          note: entryPickNote(items.length, entryPickTotal(now.entryMetas, now.order, query, null)),
        };
      },
      { title: `${cmd.label}(つなぐ先のノートを選びます)` },
    ).then((lid) => {
      if (lid === null) return;
      exec(lid, env);
      opts.onDone?.();
    });
    return true;
  }
  if (!runGlobalCommand(id, env.root, env.dispatcher, env.keymap, noop, env.notify)) {
    // ⚠ 描いてから状態が動いて押せなくなった回 ── 黙らない(dead click にしない)
    env.notify(COMMAND_NOT_READY_NOTE, CAUTION);
    return false;
  }
  opts.onDone?.();
  return true;
}

/**
 * 🔴 **`>` を打っている間、操作の一覧を描き直す**(#274 段①)。
 *
 * ⚠ 「いま押せるか」は**画面のボタン**で決まる(`commandRowsFor`)ので、打鍵のときだけでなく
 *   **状態が動くたびに**呼ぶ ── 打った後にノートを選ぶと押せる操作が変わる。
 *   ⚠ 描く側が指紋を見て、変わらないなら触らない(矢印で動かしている焦点を消さない)。
 * ⚠ `>` でないとき・器が無い面では何もしない。
 */
export function repaintCommandList(
  root: HTMLElement,
  dispatcher: Dispatcher,
  keymap: KeymapStore,
): void {
  const q = commandQueryOf(dispatcher.getState().filterQuery);
  if (q === null) return;
  const host = root.querySelector<HTMLElement>('[data-pkc-region="command-list"]');
  if (host === null) return;
  /**
   * 🔴 **`>` だけのとき、先頭に「最近使った操作」を出す**(#274)。⚠ 「名前がまだ無いか」の
   *   判定は `splitRecentRows` 1 か所(ここでは見ない)。⚠ 読むたびに保存を引く
   *   (別のタブで使った操作も出る)。
   */
  const { recent, rest } = splitRecentRows(
    q,
    commandRowsFor(root, dispatcher, keymap, q, null),
    appRecentCommands.list(),
  );
  paintCommandList(host, rest, recent);
}


/**
 * 🔴 **「この lid の本文が描けた」を待つ**(#517)。
 *
 * ⚠ **期限つき**。印が来ない環境(器が無い / 描けない)で永久に待つ口を作らない。
 * 🔑 **もう今の lid なら、待たずにその場で返る** ── よくある道
 *   (detail に居て目次を押す)を 1ms も遅くしない。
 * ⚠ 綴りは `detail.ts` の `PAINTED_ATTR` を引く(2 か所に書かない ── §7)。
 */
async function waitPainted(
  detail: HTMLElement | null,
  lid: string | null,
  timeoutMs = 600,
): Promise<void> {
  if (detail === null || lid === null) return;
  /**
   * 🔴 **待つ物が在るときだけ待つ**。
   *
   * ⚠ 器(本文のホスト)が無い面では、描き直しは**起きない** ── そこで待つと
   *   期限いっぱい(600ms)止まるだけで、user から見て**目次が重くなる**。
   *   ⚠ 実際、素の fixture でこれを踏んだ(器を植えない test が全部 600ms 待った)。
   * 🔑 器が在って**印が今の lid でない**ときだけが「描き直しの最中」である。
   */
  const bodyHost = (): HTMLElement | null =>
    detail.querySelector<HTMLElement>(
      `[data-pkc-field="detail-body-host"], ${BODY_HOST_SELECTOR}`,
    );
  const painted = (): boolean => {
    const host = bodyHost();
    return host === null || host.getAttribute(PAINTED_ATTR) === lid;
  };
  if (painted()) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      obs.disconnect();
      resolve();
    };
    const obs = new MutationObserver(() => {
      if (painted()) finish();
    });
    obs.observe(detail, { subtree: true, attributes: true, attributeFilter: [PAINTED_ATTR] });
    const timer = setTimeout(finish, timeoutMs);
    // ⚠ 待ち始めた直後に印が付く回を落とさない(observe の前に済んでいることがある)
    if (painted()) finish();
  });
}

/**
 * 本文へ飛ぶ操作(目次・添付の行)を、編集中に断る文言。
 * 🔑 **1 本にする**(§7)── 目次と添付で別々に書くと、片方だけ言い回しが変わる。
 */
const JUMP_REFUSED_WHILE_EDITING =
  '編集中は本文が表示されていないので移動できません(「編集を保存する」を押すか、システムの「編集の仕方」を「2 ペイン(原文とプレビュー)」にしてください)';

/**
 * 🔴 **目次の行から本文の見出しへ飛ぶ**(#514 / #517)。
 *
 * ⚠ **本文以外の面を開いたままなら、先に本文の面へ戻す**(#514)── 面は hidden で
 *   常駐する(`center.ts`)ので見出しは hidden のまま**見つかる**が、
 *   `display:none` の要素への `scrollIntoView` は**無言の no-op** になる。
 * ⚠ **探すより前に戻す** ── 選択が変わっていた場合、面の切替は骨組みを作り直すので、
 *   先に掴んだ要素は detached になり、また無言に戻る。
 * ⚠ detail に居るときは撃たない ── `SET_VIEW_MODE` は履歴・ゴミ箱の panel を畳む
 *   副作用を持つ(目次を押しただけで履歴が閉じる、を作らない)。
 */
/**
 * @param notFound 見出しが無かったときの断り文(#579 ── 章のリンクは目次と事情が違う:
 *   「まだ出ていない」ではなく「字が変わった」のかもしれない)。省けば目次の文言
 */
async function tocJump(
  dispatcher: Dispatcher,
  target: HTMLElement,
  slug: string,
  notFound?: string,
  flash = false,
  quiet = false,
): Promise<void> {
    if (dispatcher.getState().viewMode !== 'detail') {
      dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    }
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]');
    /**
     * 🔴 **描き直しの完了を待ってから探す**(#517)。
     *
     * ⚠ 本文の描画は worker の promise 越し(`detail.ts`)なので、面を戻した
     *   直後は**見出しがまだ DOM に無い** ── 直す前は、そこで断り文を出して
     *   **もう一度押させて**いた(1 回の押しで届かない = 動線を 1 つ失っている)。
     * 🔑 待つのは「この lid の本文が描けた」印(`PAINTED_ATTR`)である。
     * ⚠ **既に今の lid なら待たない**(下の `waitPainted` が同期で返る)──
     *   よくある道(detail に居て目次を押す)を遅くしない。
     * ⚠ 期限つきにする ── 印が来ない環境(描けない / 器が無い)で
     *   **永久に待つ口を作らない**。期限切れなら、いままでどおり断り文を出す。
     */
    await waitPainted(detail, dispatcher.getState().selectedLid);
    const hit = detail
      ? [...detail.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id]')].find(
          (h) => h.id === slug,
        )
      : undefined;
    if (!hit) {
      // 🔑 推測で飛ぶ呼び方(古い取り込みの `entry:X#<slug>`)は、無ければ何も出さない
      if (quiet) return;
      // ⚠ 文言は phase で分ける ── 編集していないのに「編集中は…」と出すと、
      //   user は別のものを探す(選択を変えた直後の描き直し中はこちらに来る)
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error:
          dispatcher.getState().phase !== 'ready'
            ? JUMP_REFUSED_WHILE_EDITING
            : (notFound ??
              'その見出しが本文にまだ出ていません(描き直しの途中かもしれません、もう一度押してください)'),
      });
      return;
    }
    /**
     * 🔴 **畳んだ章の中なら、開いてから飛ぶ**(#514)── 覆っている畳みだけを開く。
     * ⚠ host は**畳みを管理している器**(`applyHeadingFold` が受けるのと同じ器)で渡す
     *   ── `hit.parentElement` だと `:::` の囲みの中の見出しで**別の器**を渡してしまい、
     *   外の畳みに届かない。
     * 🔴 **綴りは 1 つではない**(#598)── 1 稿目は `detail-body-host` だけを探して
     *   いたが、md を描いた器は**同じ節点の名前が `detail-body` へ上書きされる**ので、
     *   **本文の面では必ず外していた**(= いつも `hit.parentElement` に落ちていた)。
     *   🔑 引く口は `foldHostOf` **1 本**(§7)。
     *   器が無い環境(unit の素の fixture)では parentElement へ落とす。
     */
    const foldHost = foldHostOf(hit) ?? hit.parentElement;
    if (foldHost !== null) revealBlock(foldHost, hit);
    const goHeading = (): void => hit.scrollIntoView({ block: 'start' });
    goHeading();
    // 🔴 長大なノートは、飛び先の周りが描かれて実寸になった後に 1 度だけ合わせ直す(#1467)
    settleJump(hit, goHeading);
    // 🔴 外から来たリンクは**着いた先を光らせる**(#1559)── 本文のリンクや目次は押した user が行き先を知っている
    if (flash) flashCopied(hit);
}

/** 🔴 外から開けるリンクの行き先が見つからないときの理由(#1559)。⚠ ノートは開けている。 */
export const LINK_SECTION_MISSING_MESSAGE =
  'リンクの行が見つかりません(行の日時を直した、または消した可能性があります。ノートは開きました)';

/**
 * 🔴 **外から開けるリンク(`fragment=h/<見出しの id>`)の行き先へ送って光らせる**(#1559)。
 *
 * ⚠ ノートを選んだ後に呼ばれる(`deep-link.ts` の `sectionJump`)。選べていなければ(編集中など)
 *   理由を出す ── 飛び先が無いまま黙ると dead click になる。飛ぶ機構は目次・本文の参照と**同じ `tocJump` 1 本**。
 */
export async function jumpToLinkedSection(
  dispatcher: Dispatcher,
  root: HTMLElement,
  lid: string,
  slug: string,
): Promise<void> {
  if (dispatcher.getState().selectedLid !== lid) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: 'ノートを開けなかったため、リンクの行まで移れませんでした(編集中なら保存してからもう一度開いてください)',
    });
    return;
  }
  await tocJump(dispatcher, root, slug, LINK_SECTION_MISSING_MESSAGE, true);
}

/**
 * 🔴 **添付の行から、本文でそれを使っている最初の場所へ飛んで光らせる**(#1170)。
 *
 * 🔑 道筋は `tocJump` と同じ(面を本文へ戻す → 描き終わりを待つ → 探す → 畳んだ章を開く →
 *   送る)。違うのは**探し方**だけ:見出しの id ではなく、添付の key を持つ
 *   画像 / リンク / 囲みの**最初の 1 つ**。
 * ⚠ **添付を開くのではない**(本文の絵を押す今までどおり)── ここは「どこで使っているか」へ
 *   飛ぶだけ。
 * ⚠ 編集中(1 面)は本文が描かれていない ── 断り文は目次と同じ(`JUMP_REFUSED_WHILE_EDITING`)。
 * ⚠ 見つからない(描き直しの途中 / 本文が書き換わった)ときは理由を出す ── 黙ると dead click。
 */
async function jumpToAssetUse(
  dispatcher: Dispatcher,
  target: HTMLElement,
  key: string,
): Promise<void> {
  if (dispatcher.getState().viewMode !== 'detail') {
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
  }
  const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
  const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]');
  await waitPainted(detail, dispatcher.getState().selectedLid);
  // ⚠ key を属性の選択子に書かない(key に何が入るか分からない ── escape が要らない等値で比べる)
  const hit = detail
    ? [
        ...detail.querySelectorAll<HTMLElement>(
          '.pkc-asset-ref, .pkc-asset-link, [data-pkc-fence-asset-key]',
        ),
      ].find(
        (el) =>
          (el.getAttribute('data-pkc-asset-key') ?? el.getAttribute('data-pkc-fence-asset-key')) ===
          key,
      )
    : undefined;
  if (!hit) {
    if (dispatcher.getState().phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: JUMP_REFUSED_WHILE_EDITING });
    } else {
      dispatcher.dispatch({ type: 'OP_NOTICE', message: '本文に見つかりませんでした' });
    }
    return;
  }
  const foldHost = foldHostOf(hit) ?? hit.parentElement;
  if (foldHost !== null) revealBlock(foldHost, hit);
  scrollSettled(detail!, hit);
  flashCopied(hit);
}

/**
 * 🔴 **画像の読み込みで位置がずれても、飛び先に居続ける**(#1170)。
 *
 * ⚠ 本文の画像は `loading="lazy"` で、読み込むまで高さが無い。**送った後に上の画像が
 *   育つと、飛び先が画面の外へ押し流される**(「飛んだのに見えない」)。
 * 🔑 送った後の短い間だけ、器の中の画像の `load`(捕まえる側で拾う)のたびに送り直す。
 * ⚠ **user が自分で動かしたら手を離す**(wheel / touch / key)── 勝手に引き戻さない。
 * ⚠ 期限つき(永久に聞かない)。
 */
function scrollSettled(host: HTMLElement, el: HTMLElement): void {
  const go = (): void => el.scrollIntoView({ block: 'center' });
  go();
  // 🔴 長大なノートは、飛び先の周りが描かれて実寸になった後に 1 度だけ合わせ直す(#1467)
  settleJump(el, go);
  let done = false;
  const stop = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    host.removeEventListener('load', go, true);
    for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown'])
      host.ownerDocument.removeEventListener(t, stop, true);
  };
  const timer = setTimeout(stop, 1500);
  host.addEventListener('load', go, true);
  for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown'])
    host.ownerDocument.addEventListener(t, stop, true);
}


/**
 * 🔴 **グループを 1 つ動かす**(#857 段③)。⚠ 上へ / 下へで**同じ 1 本**を通す ──
 * 2 本書くと、片方だけ直した日にずれる(§7)。
 *
 * 🔑 **増えるノートの枚数を先に数えて、初回だけ聞く** ── 番号は「動かした先より
 *   上に在る群」全部に要るので、まとめて増えることがある(最大で群の数 − 1 枚)。
 * ⚠ 数えるのも計画も**純関数 1 本**(`planGroupMove`)── ここで規則を書かない。
 */
function moveAppGroup(
  dispatcher: Dispatcher,
  target: HTMLElement,
  services: BinderServices,
  by: -1 | 1,
): void {
  const name = target.getAttribute('data-pkc-group') ?? '';
  if (name === '') return;
  const st = dispatcher.getState();
  // 🔴 **確認の小窓を出す前に断る**(#1087)── 編集中・保存中に「ノートが増えます」と聞いて、OK の後で reducer に断られない
  const refusal = appGroupWriteRefusal(st, '並べ替えられます');
  if (refusal !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: refusal });
    return;
  }
  const tiles = st.launcherTiles ?? [];
  const movable: string[] = [];
  for (const t of tiles)
    if (t.group !== '' && isMovableTile(t) && !movable.includes(t.group)) movable.push(t.group);
  const plan = planGroupMove(movable, st.appGroupOrders, name, by);
  // ⚠ 端では何もしない(reducer も同じ判定を持つが、ここで止めれば小窓すら出さない)
  if (plan.length === 0) return;
  const need = groupsNeedingNote(plan, (n) => hasAppGroupNote(st, n));
  // ⚠ lid は**書く群の数だけ**採る(足りないと reducer が何も書かない)
  const newLids = plan.map(() => generateLid());
  const go = (): void => {
    dispatcher.dispatch({ type: 'MOVE_APP_GROUP', name, by, newLids });
  };
  if (need.length === 0 || services.confirmAppGroupNotes === undefined) {
    go();
    return;
  }
  void services.confirmAppGroupNotes(need).then((ok) => {
    if (ok) go();
  });
}

/**
 * 🔴 **断られた設定は、欄を保存してある値へ戻す**(#1087)。
 * ⚠ 理由は reducer が帯に出すが、欄だけ新しい値のまま残ると「保存した」と読める
 *   (本文が動かないので詳細は描き直されない)。`defaultChecked` / `defaultValue` は
 *   描いたときの保存済みの値(`detail.ts` の添付の設定)。
 * ⚠ 判定は reducer と同じ 1 本(`appTileRefusal`)。
 */
function revertIfRefused(dispatcher: Dispatcher, lid: string, input: HTMLInputElement): void {
  if (appTileRefusal(dispatcher.getState(), lid) === null) return;
  if (input.type === 'checkbox') input.checked = input.defaultChecked;
  else input.value = input.defaultValue;
}

/**
 * 🔴 **色がまだ無い付箋の、色の窓の初めの色**(白 / 灰色に**見える**が、わざと 1 だけずらした値)。
 *
 * ⚠ `<input type="color">` は**値が開いたときから変わらなければ `change` を撃たない**(仕様)。
 *   初めの色を本物の白(`#ffffff`)・灰色(`#808080`)にすると、**白い付箋・灰色の枠を選んでも
 *   何も起きず**、その 2 色だけ付けられない。1 だけずらせば見た目は同じで、**同じ白を選んでも
 *   値が変わる**ので `change` が来る。
 * ⚠ `input` を拾う案は採らない ── 窓の中で色を動かす間に本文を何度も書いてしまう。
 */
const PLACE_FILL_SEED = '#fffffe';
const PLACE_STROKE_SEED = '#7f7f7f';
/** タグの色(#1457)の初めの色。上と同じ理由で、灰色に見えて本物の灰色ではない値。 */
const TAG_COLOR_SEED = '#808081';

/**
 * 🔴 **色を選ぶ窓を 1 つ開く**(#1224 で書いた物を、#530 段④で付箋・線の色と**共有**する)。
 *
 * 🔑 色を選ぶ部品は**これ 1 つ**(`<input type="color">` ── 画面の外の使い捨て 1 つ)。付箋・線の色の
 *   ために別の部品を作らない(Gemini 裁定 A「新しい色の部品は作らない」)。本文の色コードの見本を
 *   押したときと**同じ窓**が開き、同じ作法で撃つ。
 * ⚠ **`change` で 1 回だけ**呼ぶ(`input` のたびに書かない ── 色を探して動かす間は何も書かない)。
 *   窓を閉じただけなら `change` が来ないので呼ばない。選んだ値は `#rrggbb`(ブラウザが返す形)。
 * 🔑 開くたびに前の窓を外して作り直す(使い捨て 1 つ)。押した物の位置に開く(見えず・触れず・場所を取らない)。
 */
function openColorPicker(target: Element, from: string, onPick: (to: string) => void): void {
  const doc = target.ownerDocument;
  doc.querySelector('input[data-pkc-field="color-pick"]')?.remove();
  const input = doc.createElement('input');
  input.type = 'color';
  input.value = from;
  input.setAttribute('data-pkc-field', 'color-pick');
  input.setAttribute('aria-hidden', 'true');
  input.tabIndex = -1;
  // 押した物の位置に(窓がそこへ開く)。見えず・触れず・場所を取らない
  const rect = target.getBoundingClientRect();
  input.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;width:1px;height:1px;` +
    'opacity:0;pointer-events:none;border:0;padding:0;';
  input.addEventListener('change', () => {
    const to = input.value;
    input.remove();
    onPick(to);
  });
  doc.body.append(input);
  try {
    input.showPicker();
  } catch {
    // `showPicker` が無い / 断られる環境は、`click` で開く(どちらも押した直後の動作)
    input.click();
  }
}

/**
 * 🔴 **付箋・線の色と太さを書く受け手の共通部**(#530 段④)。
 *
 * ⚠ 行の座標は `raise-place` と同じ(メニューが運んだ刻印 + frontmatter ぶん)。
 * ⚠ 断るのは **身元(ノートが替わっていないか)と相(編集中でないか)**。編集中は**声に出して断る**
 *   (他の本文の書換と同じ 1 本 ── `phaseBlockReason`)。⚠ 2 重に見る: ここと reducer の門。
 * 🔑 色の窓を開く前に断る(開いても書けない窓を出さない)ので、窓を開く受け手もここを通る。
 */
function placeStyleWrite(
  dispatcher: Dispatcher,
  target: Element,
  doWrite: (lid: string, line: number) => void,
  what: string,
): void {
  const line = menuCarriedBlock(target);
  if (line === null || refuseStaleMenu(dispatcher, target)) return;
  const st = dispatcher.getState();
  if (st.phase !== 'ready') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}、${what}` });
    return;
  }
  const ob = st.openBody;
  if (ob === null) return;
  doWrite(ob.lid, line + frontmatterLineCount(ob.body));
}

/**
 * 🔴 **板・付箋を書き換える受け手の、別のタブ・窓が編集中のノートを断る門**(#1087。追記と同じ門)。
 *
 * ⚠ 通すと、編集中のタブの保存で上書きされ、足した書換は履歴にだけ残る。**断って理由を出す**
 *   (問い合わせが落ちたときも黙らない ── `failedWhat` に「〜できませんでした」を渡す)。
 * 🔑 撃つのは {@link actUnlessEditedElsewhere} の 1 本 ── 板の受け手ごとに門を書かない(§7)。
 *   窓を開く受け手(色 / 位置と大きさ / グループ / テンプレート)は、**選び終えて書く直前**にここを通す
 *   (窓を開く前に確かめても、開いている間に別のタブが編集を始める)。
 * ⚠ ドラッグ移動・付箋 / 線を消す口は通していない(`edited-elsewhere.ts` の注記: 見え方の判断待ち)。
 */
function placeEditedElsewhereGate(
  dispatcher: Dispatcher,
  services: EditLockPort,
  lid: string,
  failedWhat: string,
  fire: () => void,
): void {
  actUnlessEditedElsewhere(
    dispatcher,
    services,
    [lid],
    `${failedWhat}(別のタブの編集を確かめられませんでした)。もう一度押してください`,
    fire,
  );
}

/** 運ばれた札の名前(`fill stroke`)。⚠ 知らない名前は捨てる(受け手が書く札を閉じておく)。 */
function styleKeysOf(target: Element): Array<'fill' | 'stroke'> {
  const raw = target.getAttribute(PLACE_STYLE_KEYS_ATTR) ?? '';
  return raw
    .split(/\s+/)
    .filter((k): k is 'fill' | 'stroke' => k === 'fill' || k === 'stroke');
}

/**
 * 🔴 **板の形を変える受け手を 1 本作る**(#530 案 A)。
 * ⚠ 行の座標は `raise-place` と同じ(メニューが運んだ刻印 + frontmatter ぶん)。
 */
function placeShapeHandler(shape: PlaceShape): ActionHandler {
  return (dispatcher, target, services) => {
    const line = menuCarriedBlock(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    const ob = dispatcher.getState().openBody;
    if (ob === null) return;
    const lid = ob.lid;
    const at = line + frontmatterLineCount(ob.body);
    placeEditedElsewhereGate(dispatcher, services, lid, '形を変えられませんでした', () =>
      dispatcher.dispatch({ type: 'SET_PLACE_SHAPE', lid, line: at, shape }),
    );
  };
}

/**
 * 🔴 **鳴っている所を印にする**(#683 段②a)。
 *
 * ⚠ **器が無ければ何もしない** ── 鳴っていない行では `<audio>` が描かれていない
 *   (押し所も出ていないので、ここへは来ないはずだが、黙って 0 秒を書かない)。
 * 🔑 **どの録音かは渡さない** ── 鳴っているのは常に 1 件なので、state が持つ
 *   (押した所からも採ると、同じ問いに答える口が 2 つになる ── §7)。
 * ⚠ 器は**同じ行の中**だけで探す ── 行を跨ぐと別の録音の位置を取る。
 */
function markTrim(dispatcher: Dispatcher, target: HTMLElement, edge: 'start' | 'end'): void {
  const media = target
    .closest('[data-pkc-capture]')
    ?.querySelector<HTMLMediaElement>('[data-pkc-field="capture-media"]');
  if (!media) return;
  dispatcher.dispatch({ type: 'SET_CAPTURE_TRIM_MARK', edge, ms: media.currentTime * 1000 });
}

/**
 * 🔴 **文字起こしの行頭の時刻を押すと、その位置から再生する**(#1232 段 b)。
 *
 * ⚠ 再生機は**同じ詳細の中**から探す ── 説明の器(`data-pkc-prose`)の親が、再生機(`attachment-media`)の
 *   器と同じ(本体の詳細ペインも、横に留めた枠も)。**ページ全体からは探さない**(別の添付の再生機を動かす)。
 * ⚠ 再生機は**非同期で差す**ので、押した瞬間に無いことがある(添付の中身が読めなかったときは永久に来ない)。
 *   **黙らない** ── 何が起きているかを言う。
 * 🔑 **読み込み前(`readyState` 0)でも、位置を書いて再生まで指示する**(UX レビュー 2026-10-04)──
 *   HTML 仕様では `HAVE_NOTHING` のときの `currentTime` の書込は「既定の再生開始位置」になり、metadata が
 *   届いた時点でそこへ移る。⚠ 実装差で 0 へ戻る相手に備え、metadata が届いたら**位置を 1 回だけ確かめ直す**。
 *   「準備ができてから、もう一度押して」と user に 2 度押させる形は、押した時刻を捨てていた(1 稿目)。
 * ⚠ 動画 webm など長さが取れない録音は、**移れたか分からない**。移れない(`seekable` が空)ときは
 *   先頭から鳴っているので、**そう言う**(「先頭から再生してください」は、もう鳴っている物を押させる字だった)。
 *   ⚠ この判定は metadata が届いた後にだけ当てる(届く前は `duration` も `seekable` も空で、必ず真になる)。
 */
const SEEK_NO_PLAYER = 'プレーヤーがまだ出ていません。添付が読めていないか、読み込みの途中です';
const SEEK_UNSUPPORTED = 'この添付は途中へ移れないので、先頭から再生しています';
/** metadata が届いた後に位置を確かめ直すときの許容(秒)── seek は目標ぴったりには止まらない */
const SEEK_RESEEK_TOLERANCE_S = 0.5;
/**
 * metadata 待ちの再生機ごとの「最後に押された位置(秒)」。
 * ⚠ 押すたびに once の聞き手を積むと、届いた回に**古い押しの聞き手が後から位置を書く**
 *   (2 度押したのに最初の位置へ飛ぶ)。聞き手は 1 本にして、**最新の位置**を読ませる。
 */
const pendingSeek = new WeakMap<HTMLMediaElement, number>();
function seekMedia(dispatcher: Dispatcher, target: HTMLElement): void {
  const raw = target.getAttribute('data-pkc-seek-ms');
  const ms = Number(raw);
  if (raw === null || !Number.isFinite(ms) || ms < 0) return;
  const notice = (message: string): void => {
    dispatcher.dispatch({ type: 'OP_NOTICE', message });
  };
  const media = target
    .closest('[data-pkc-prose]')
    ?.parentElement?.querySelector<HTMLMediaElement>(
      'audio[data-pkc-field="attachment-media"], video[data-pkc-field="attachment-media"]',
    );
  if (!media) {
    notice(SEEK_NO_PLAYER);
    return;
  }
  const at = msToSeconds(ms);
  const loaded = media.readyState >= 1;
  // ⚠ 位置は `play()` の**前**に書く ── 後に書くと、先頭から鳴り始めた直後に飛ぶ(1 瞬だけ先頭の音が出る)
  media.currentTime = at;
  if (!loaded) {
    const listening = pendingSeek.has(media);
    pendingSeek.set(media, at);
    if (!listening) {
      media.addEventListener(
        'loadedmetadata',
        () => {
          const latest = pendingSeek.get(media);
          pendingSeek.delete(media);
          if (latest !== undefined && Math.abs(media.currentTime - latest) > SEEK_RESEEK_TOLERANCE_S) {
            media.currentTime = latest;
          }
        },
        { once: true },
      );
    }
  }
  const played = media.play();
  if (played !== undefined && typeof played.catch === 'function') {
    // ⚠ `AbortError` は「押した直後にもう一度押した」= 次の押しが引き継ぐ。言わない
    played.catch((err: unknown) => {
      if (!(err instanceof DOMException && err.name === 'AbortError')) notice('再生を始められませんでした');
    });
  }
  if (loaded && !Number.isFinite(media.duration) && media.seekable !== undefined && media.seekable.length === 0) {
    notice(SEEK_UNSUPPORTED);
  }
}

/**
 * 🔴 **章の別ウィンドウで押された口を、本体で走らせる**(#1044 段4)。
 *
 * 🔑 受け手は本体で押したときと**同じ `ACTIONS`** ── 窓のために 2 本目を書かない(§7)。
 * ⚠ 走らせてよいのは `CHAPTER_WINDOW_ACTIONS`(読むだけ・よそへ移るだけの口)だけ。
 *   窓の側でも同じ一覧で押し所を残しているが、**門は両側に置く**(出し分けは見せ方であって、
 *   門ではない)。
 * ⚠ 押した要素は**別の document** に居る ── 受け手はその属性を読むだけで、本体の面を
 *   探すときは `root` を使う(`navigateToLink` の注記)。
 */
export function runChapterWindowAction(
  dispatcher: Dispatcher,
  target: HTMLElement,
  services: BinderServices,
  root: HTMLElement,
): boolean {
  const action = target.getAttribute('data-pkc-action') ?? '';
  if (!CHAPTER_WINDOW_ACTIONS.has(action)) return false;
  const handler = ACTIONS[action];
  if (handler === undefined) return false;
  handler(dispatcher, target, services, root);
  return true;
}

/**
 * 🔴 **「図を保存」の番号を数える範囲 = その図を載せているノートの本文の中だけ**(#1087)。
 *   かつては `root`(画面全体)で数えていたので、横に留めた枠など**本文が 2 つ画面に在る**と、
 *   2 つ目のノートの 1 枚目が「2 枚目」の名前で落ちた。持ち主の印が無い面は、描いた本文の器
 *   (`.pkc-md-rendered`)、それも無ければ従来どおり画面全体。
 * ⚠ 受け手の外に置くのは、受け手が**押した図**しか見ないことを保つため(選んだノートは読まない ──
 *   `tests/action-outlets.test.ts` の「対象が要るのに出口が 1 か所」の台帳は、受け手の本文の字で数える)。
 */
function diagramScopeOf(host: HTMLElement, root: HTMLElement): ParentNode {
  return (
    host.closest<HTMLElement>('[data-pkc-entry],[data-pkc-split-lid]') ??
    host.closest<HTMLElement>('.pkc-md-rendered') ??
    root
  );
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
  'navigate-entry-ref': (dispatcher, target, services, root) => {
    navigateToLink(dispatcher, target, target.getAttribute('data-pkc-entry-ref'), root, services);
  },
  /**
   * `@[card](…)` の placeholder。⚠ **解決器は `entry:` と同じ 1 本**
   * (target は `entry:` か `pkc://<cid>/entry/<lid>` のどちらか)。
   */
  'navigate-card-ref': (dispatcher, target, services, root) => {
    navigateToLink(dispatcher, target, target.getAttribute('data-pkc-card-target'), root, services);
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
  'select-entry': (dispatcher, target, services, root) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (!lid) return;
    if (!selectEntryOrExplain(dispatcher, lid, 'ノート', root, services)) return;
    /**
     * 🔴 **フォルダの概要の行なら、左の列もそのフォルダの中へ移す**(#1222。Gemini 裁定
     * 2026-10-01 = A)。
     *
     * > user の物語:フォルダを開くと中央に直下の一覧が出る。その行を押したら、
     * > **そのノートが中央に開き、左の列もそのフォルダの中へ移る**(左の列が別の場所を
     * > 指したままだと、開いたノートの隣が見えない)。サブフォルダの行なら、そのフォルダを選ぶ。
     *
     * ⚠ **新しい action を作らない** ── 開く側は一覧 / フォルダ / かんばんの行と**同じ 1 本**
     *   (編集中の断り・章の下書きの確認・本文ページへ出る、が全部同じ)。概要の器だけが
     *   `data-pkc-overview-scope`(= その概要が属するフォルダ)を運ぶ。
     * ⚠ **開けなかったら左の列は動かさない**(上の `return`。断られたのに場所だけ変わると
     *   画面が食い違う)。⚠ 動かす先は器が運ぶフォルダ ── 概要は常に直下だけなので、
     *   器のフォルダ = 押した行の親である(木から引き直さない)。
     */
    const scope = target
      .closest('[data-pkc-overview-scope]')
      ?.getAttribute('data-pkc-overview-scope');
    if (scope) dispatcher.dispatch({ type: 'SET_SCOPE', lid: scope });
  },
  /**
   * 🔴 **開くときに、いま中央に居るノートと入れ替える**(#809-4)。
   *
   * ⚠ **知らせの隣の「開く」専用**である ── 一覧の行を押したときは今までどおり
   *   ただ開く(押すたびに枠が組み替わるのは、user が頼んでいない動きである)。
   * 🔑 判定(入れ替えられるか)は **reducer が持つ**(`SWAP_OPEN_ENTRY`)──
   *   ここに書くと、`main.ts` と同じで test の届かない所に判断が入る。
   */
  'swap-open': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (lid) dispatcher.dispatch({ type: 'SWAP_OPEN_ENTRY', lid });
  },
  /**
   * 🔴 **録ったものを、その場で鳴らす / やめる**(#683 段①)。
   *
   * ⚠ **借りるのはここではない** ── bytes を借りるのは描画器(`captures.ts`)の
   *   `syncBorrow` で、ここは「**どれを鳴らすか**」を state へ置くだけである。
   *   🔑 そうしないと、同じ面が 2 つ生きている(左のタブ / 別窓)ときに
   *   **2 本同時に鳴りうる**(CLAUDE.md §7:同じ問いに答える口を 2 つ作らない)。
   * ⚠ **編集中でも押せる** ── 聞くのは読むだけの操作で、下書きに 1 バイトも触らない
   *   (`BLOCKABLE_FIELDS` に入れない ── 入れると「動く物まで薄くなる」)。
   */
  'capture-play': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (lid) dispatcher.dispatch({ type: 'SET_CAPTURE_PLAYING', lid });
  },
  /** 🔴 **やめる**(#683 段①)── 器へ返すのは描画器の `syncBorrow` が引き取る。 */
  'capture-stop': (dispatcher) => {
    dispatcher.dispatch({ type: 'SET_CAPTURE_PLAYING', lid: null });
  },
  /**
   * 🔴 **切り出しの端を、いま鳴っている所で決める**(#683 段②a)。
   *
   * ⚠ **時刻は画面の器から読む** ── state は再生位置を持たない(持たせると
   *   1 秒ごとに dispatch が飛んで、面ごと描き直しになる)。
   * 🔑 読む器は**同じ行の中**だけ ── 行を跨いで探すと、別の録音の位置を取る。
   */
  'capture-trim-start': (dispatcher, target) => markTrim(dispatcher, target, 'start'),
  'capture-trim-end': (dispatcher, target) => markTrim(dispatcher, target, 'end'),
  'capture-trim-clear': (dispatcher) => {
    dispatcher.dispatch({ type: 'CLEAR_CAPTURE_TRIM' });
  },
  /**
   * 🔴 **切り出す**(#683 段②a)。⚠ 段取りは `capture-trim.ts` が持つ ──
   *   binder は `data-pkc-action` を撃つだけ(収録・タイマーと同じ規律)。
   * ⚠ **印が揃っていなければ撃たない** ── 描画側も揃うまで口を出さないが、
   *   **門を 2 つ持つのはわざと**である(別窓が印を消した直後に押されうる)。
   */
  'capture-trim-run': (dispatcher, _target, services) => {
    // 🔑 **対象は印が持つ** ── 押した所から採らない(§7:同じ問いに答える口を 2 つ作らない)
    const trim = dispatcher.getState().captureTrim;
    if (trim === null || trim.startMs === null || trim.endMs === null) return;
    if (!services.trimCapture) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'このタブの PKC3 が古いままのため、切り出せません。再読み込みしてください' });
      return;
    }
    services.trimCapture(trim.lid, trim.startMs, trim.endMs);
  },
  /**
   * 🔴 **録った音を文字にする**(#772 段②)。⚠ **対象は押した行が持つ**(`data-pkc-entry`)──
   *   選択中のノートから採らない(一覧のどの行からも押せる。別のノートを開いたまま押せる)。
   * ⚠ 段取り(部品の有無・同時 1 本・編集中の預かり)は `capture-transcribe.ts` が持つ。
   */
  'capture-transcribe': (dispatcher, target, services) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (!lid) return;
    if (!services.transcribeCapture) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'このタブの PKC3 が古いままのため、文字にできません。再読み込みしてください' });
      return;
    }
    services.transcribeCapture(lid);
  },
  /**
   * 🔴 **動画から音だけ / 絵だけを取り出す**(#952 A1)。⚠ **対象は押した行が持つ**(`data-pkc-entry`)──
   *   選択中のノートから採らない(`capture-transcribe` と同じ)。取り出す物は押したボタン自身が運ぶ(`data-pkc-part`)。
   */
  'capture-extract': (dispatcher, target, services) => {
    const lid = target.getAttribute('data-pkc-entry');
    const part = target.getAttribute('data-pkc-part');
    if (!lid || (part !== 'audio' && part !== 'picture')) return;
    if (!services.extractCapture) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'このタブの PKC3 が古いままのため、取り出せません。再読み込みしてください' });
      return;
    }
    services.extractCapture(lid, part);
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
  /**
   * 🔴 **添付の行 → 本文でそれを使っている最初の場所へ飛んで光る**(#1170)。
   * ⚠ 目次の行と同じく情報ペインの中に在るので、スマホでは本文のページへ戻す。
   */
  'jump-to-asset-use': (dispatcher, target) => {
    const key = target.getAttribute('data-pkc-asset-key') ?? '';
    if (key === '') return;
    appPhone.reveal('note');
    void jumpToAssetUse(dispatcher, target, key);
  },
  /**
   * 🔴 **「探す」から送った本文の、前 / 次の当たりへ**(#1102 段①)。
   * ⚠ 端で回る(数で畳むのは描く側 ── 当たりの数は本文の DOM を数えないと分からない)。
   * ⚠ 押した所から何も要らない(塗っているのは 1 つの本文だけ)。
   */
  'search-jump-prev': (dispatcher) => {
    dispatcher.dispatch({ type: 'SEARCH_JUMP_STEP', by: -1 });
  },
  'search-jump-next': (dispatcher) => {
    dispatcher.dispatch({ type: 'SEARCH_JUMP_STEP', by: 1 });
  },
  /** 🔴 **塗りと帯を消す**(#1102 段①)。⚠ `Esc` も同じ 1 本(`tryReading`)。 */
  'search-jump-end': (dispatcher) => {
    dispatcher.dispatch({ type: 'SEARCH_JUMP_END' });
  },
  /**
   * 🔴 **目次から本文の見出しへ飛ぶ**(#493)。
   *
   * ⚠ **`getElementById` を使わない** ── 同じ id は画面の別の面にも在りうる
   *   (マニュアルもヘルプも同じ `makeSlugCounter` で id を刻む)。2026-08-08 に
   *   「id の重複 0 件」という**守れない条件**を書いて踏んだのと同じ場所である。
   *   🔑 **本文の面(`detail`)の中だけ**を見る。
   * ⚠ **属性の選択子で探さない** ── 印は日本語なので `#見出し` は CSS の識別子
   *   として不正になりうる。h1〜h3 を舐めて `id` を等値で比べる(escape が要らない)。
   * ⚠ **見つからなければ理由を出す** ── 1 面の編集中は本文が描かれていないので
   *   飛び先が無い。黙ると「押しても何も起きない」になる(#300 の型)。
   */
  'toc-jump': (dispatcher, target) => {
    const slug = target.getAttribute('data-pkc-toc-slug') ?? '';
    if (slug === '') return;
    /**
     * 🔴 **情報ページの目次を押したら、本文ページへ戻る**(#632 段①)。
     * ⚠ 目次は情報ペインの中に在るので、スマホでは**押した先が見えていない** ──
     *   送ってはいるのに画面が動かない(無言の dead click)。
     */
    appPhone.reveal('note');
    void tocJump(dispatcher, target, slug);
  },
  /**
   * 🔴 **押した結果が見える所を開く**(2026-08-29 の動線レビュー)。
   *
   * ⚠ 左の列を畳んでいると、絞り込みは効いているのに**画面が 1 ドットも動かない**
   *   ── user から見れば**無言の dead click** である(本文の札・情報ペインの札・
   *   フォルダの札の 3 経路とも同じ形だった)。
   * 🔑 だから**畳んでいたら開く** ── 押した人が見たいのは「そのタグのノート」であって、
   *   閉じたままの列ではない。⚠ 開いているときは何もしない(勝手に畳まない)。
   */
  'filter-by-tag': (dispatcher, target) => {
    const tag = target.getAttribute('data-pkc-tag');
    if (!tag) return;
    /**
     * 🔴 **断るなら、絞り込みも起こさない**(着地前レビュー 欠陥 6)。
     * ⚠ 直す前は `SET_ENTRY_FILTER` を**先に**撃っていた ── PC では左の列で
     *   すぐ見えるので食い違わないが、スマホは一覧が画面に無いので
     *   **「できません」と言われたのに、後で見ると絞られている**。
     *   起きたことと言われたことが逆になる形は、無言の dead click より悪い。
     */
    if (!phoneShowList(dispatcher)) return;
    dispatcher.dispatch({ type: 'SET_ENTRY_FILTER', query: tag });
    // 🔴 スマホでは列の保存値を触らない(上の `focus-search` と同じ理由)
    if (appPhone.isPhone()) return;
    const hidden = appPanes.getHidden();
    if (!hidden.includes('sidebar')) return;
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    applyPaneVisibility(
      root,
      appPanes.setHidden(hidden.filter((p) => p !== 'sidebar')),
    );
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
  'toggle-pane': (dispatcher, target) => {
    const id = target.getAttribute('data-pkc-pane');
    if (id === null || !isPaneId(id)) return;
    /**
     * 🔴 **スマホでは列そのものが無いので、押しても何も起きない**(#632 段① の
     *   着地前レビュー 欠陥 3)。
     *
     * ⚠ 直す前は**画面が 1px も動かず、理由も出ず、保存値だけ黙って動いて**いた ──
     *   しかも「操作を探す」は `disabled` を見るだけなので「**押せます**」と出す。
     *   同じ file の `focus-search` に「パレットは『押せる』と嘘をついていた」と
     *   書いてあるのと**同じ嘘**を、新しい入口(`⋯` → 操作を探す)の先に置いていた。
     * 🔑 断って、**保存値も動かさない** ── 動かすと、PC の幅へ戻したときに
     *   身に覚えのない畳みが残る(見えない状態変化)。
     * ⚠ 追記欄(`append`)は**スマホでも効く**(本文との境目は縦に残っている)ので
     *   ここでは断らない ── まとめて断ると、user 指示 2026-08-27 の道が死ぬ。
     */
    if (appPhone.isPhone() && (COLUMN_PANES as readonly string[]).includes(id)) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: 'スマホの画面では一覧・本文・情報を 1 枚ずつ出しているので、ペインは折りたためません',
      });
      return;
    }
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    /**
     * 🔴 **低い窓でこちらが畳んだ追記欄は、押すと「一時的に」出る**(#701)。
     * ⚠ `toggle` で戻すと、その窓ではもう畳まれない(記録には書かないが、窓の高さが
     *   変わるまで開いたまま)── 裁定は「開いたら**送った後は自分で畳み直す**」なので、
     *   `peek` と同じ道を通す(送る / 欄の外で 1 操作 → `refoldPeeked` が畳む)。
     * ⚠ user が自分で畳んだ回(記録に在る)は今までどおり `toggle` ── あちらは
     *   「戻す」を押した人の意図が「出しておきたい」だからである。
     */
    if (id === 'append' && appPanes.isAutoFolded('append') && appPanes.getHidden().includes('append')) {
      if (revealAppendPane(root)) return;
    }
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
   * 🔴 **貼り付け欄は押したときだけ出す**(#1017 段④b。`toggle-replace` と
   * 同じ作法 ── `<details>` は使わない)。開いたら**貼る欄へ focus**。
   */
  'toggle-plan-apply': (_dispatcher, target) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const box = root.querySelector<HTMLElement>('[data-pkc-field="plan-apply-box"]');
    if (!box) return;
    box.hidden = !box.hidden;
    target.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
    if (!box.hidden) root.querySelector<HTMLTextAreaElement>('[data-pkc-field="plan-input"]')?.focus();
  },
  /**
   * 🔴 **「作り直す・初期化する を出す」の開閉**(#1017 段③-1。`toggle-plan-apply` /
   * `toggle-replace` と同じ作法 ── `<details>` は使わない)。
   * ⚠ **開いても focus は動かさない** ── 中は「読んでから押す」ボタン 2 つで、
   *   入力欄が無い(`toggle-plan-apply` と違い、押し込む先が無い)。
   */
  'toggle-container-repair': (_dispatcher, target) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const box = root.querySelector<HTMLElement>('[data-pkc-field="container-repair-box"]');
    if (!box) return;
    box.hidden = !box.hidden;
    setContainerRepairToggle(target, !box.hidden);
  },
  /**
   * 🔴 **全部置換**(#191)。⚠ 判定(編集中か / 何件当たるか)は**reducer 1 か所**。
   * ここでは欄の値を渡すだけ ── binder が「0 件なら押さない」等を持つと二重帳簿になる。
   */
  'replace-all': (dispatcher, target) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    /**
     * 🔴 **開いている行の打ちかけを、置換の前に state へ届ける**(`commit-edit` と同じ手当て)。
     *
     * ⚠ 直す前は届けずに置換していた ── 「操作を探す」や割り当てた鍵から撃つと焦点が行に居るので、
     *   置換で本文が差し替わった瞬間に行が閉じ、**打ちかけの字が消えた**(帯のボタンを押したときは
     *   `mousedown` で先に確定するので起きない)。
     * ⚠ ダイアログが開いている間、行は確定を見送る(`RowSwap.commitActive`)。そのまま `blur` しても
     *   確定しないので、**閉じてから**確定して置換を撃つ(閉じていればすぐ)。
     * ⚠ 欄の値は確定の**後**に読む(待っている間に帯の欄を直されても、押した時点の値ではなく見えている値)。
     */
    whenAppDialogClosed(() => {
      settleRowEditor(root);
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
    });
  },
  /**
   * 🔴 **関係を足す**(#185)。⚠ 相手は**題名で指す**(lid は user に見えない)。
   * ⚠ 見つからない / 曖昧なときは**理由を言う** ── 押して無反応にしない。
   * ⚠ 判定(自分自身・重複・居場所)は **reducer 1 か所**。ここは解決だけ。
   */
  'add-relation': (dispatcher, target) => {
    /**
     * 🔴 **編集中は声に出して断る**(#513)── reducer は `phase !== 'ready'` で
     * 黙って捨てるのに、末尾の欄クリアだけが走って**成功と同じ見た目**になっていた
     * (user の打った字が消え、関係は増えず、理由も出ない)。
     */
    const phase = dispatcher.getState().phase;
    if (phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(phase)}つながりを足してください` });
      return;
    }
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const nameEl = root.querySelector<HTMLInputElement>('[data-pkc-field="relation-target"]');
    const kindEl = root.querySelector<HTMLSelectElement>('[data-pkc-field="relation-kind"]');
    const name = (nameEl?.value ?? '').trim();
    const state = dispatcher.getState();
    const fromLid = state.selectedLid;
    if (fromLid === null) return;
    if (name === '') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'つなぐ先の題名を入れてください' });
      return;
    }
    /**
     * 🔴 **相手は欄の字から 1 件に決める**(#1657、依頼 45 の 3)。同じ題名が複数でも、候補の一覧で選んだ
     *   「題名(フォルダの名前・更新日)」ならそのノートの 1 件に決まる(`resolveRelationTarget`)。
     *   ⚠ どれかを勝手に選ばない ── 題名だけで 2 件以上に合うときは止まる。
     */
    const resolved = resolveRelationTarget(name, state.entryMetas, state.relations, fromLid);
    if (resolved.kind === 'self') {
      // 🔴 いま開いているノート自身の題名は「見つかりません」ではなく、つなげない理由を言う(#1087)
      dispatcher.dispatch({ type: 'OP_FAILED', error: '自分自身にはつなげません' });
      return;
    }
    if (resolved.kind === 'none') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `「${name}」というノートが見つかりません`,
      });
      return;
    }
    if (resolved.kind === 'ambiguous') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `「${name}」が ${resolved.count} 件あります。候補の一覧からフォルダの名前つきの題名を選ぶか、題名を分けてから足してください`,
      });
      return;
    }
    const kind = kindEl?.value ?? '';
    if (!isRelationKind(kind) || kind === STRUCTURAL) return;
    // 🔴 同じ相手・同じ種類が既に在るときは、言う(欄は残す)。⚠ 判定は reducer と同じ 1 本(`hasSameRelation`)
    if (hasSameRelation(state.relations, fromLid, resolved.lid, kind)) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        // 🔴 向きだけが逆のときは、その旨を言う(#1163 依頼 319)── 「関連」は向きを区別しない
        error: hasReverseOnlyRelation(state.relations, fromLid, resolved.lid, kind)
          ? `${relationLabel(kind)}は向きを区別しません。反対向きの同じつながりが既にあります`
          : '既に同じつながりがあります',
      });
      return;
    }
    dispatcher.dispatch({
      type: 'ADD_RELATION',
      id: generateLid(),
      fromLid,
      toLid: resolved.lid,
      kind,
    });
    if (nameEl) nameEl.value = '';
  },
  /** 関係を消す(#185)。⚠ **id で消す**(押した札が持っている)。 */
  'remove-relation': (dispatcher, target) => {
    // 🔴 編集中は声に出して断る(#513)── reducer は黙って捨てる
    const phase = dispatcher.getState().phase;
    if (phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(phase)}つながりを消してください` });
      return;
    }
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
  /**
   * 🔴 **スマホ用画面のページを移る**(#632 段①)。行き先は押したボタンが持つ
   *   (`data-pkc-page`)── ここで推測しない。
   *
   * ⚠ **編集中に本文ページから出るのは断る**(設計 doc §2-6)。`disabled` にしない
   *   のは、触る画面では `title` が読めず**無言の dead click**になるからである
   *   (`selectEntryOrExplain` と同じ形 ── 押させて、理由を画面に出す)。
   * ⚠ 断るのは**出るとき**だけ ── 情報ページから本文へ戻るのは止めない
   *   (戻り先が編集中の本文なので、閉じ込めることになる)。
   */
  'phone-page': (dispatcher, target) => {
    const page = target.getAttribute('data-pkc-page');
    if (page === 'note') {
      appPhone.showNote();
      return;
    }
    const blocked = phaseBlockReason(dispatcher.getState().phase);
    if (blocked !== null) {
      // ⚠ 字は 1 か所から(C11 / #1045)── 直す前は「保存するか**取り消して**から」
      // 🔴 行き先で言い分ける(#1087 の見直し 2026-10-13)── 「情報」を押した人に「戻ってください」と言っていた
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${blocked}${page === 'info' ? '開いてください' : '戻ってください'}` });
      return;
    }
    if (page === 'info') {
      /**
       * 🔴 **タブレットでは同じボタンで閉じる**(#703)── 情報を出している間も「情報」は
       *   出たままなので、もう一度押したら本文へ戻す(片道の操作を作らない)。
       * ⚠ スマホでは情報ページで「情報」そのものが消えるので、この枝には来ない。
       */
      if (appPhone.page() === 'info') appPhone.showNote();
      else appPhone.showInfo(dispatcher.getState().selectedLid);
      return;
    }
    /**
     * 🔴 **一覧へ戻っても、読んでいたノートは開いたまま**(user 裁定 2026-09-02)。
     *
     * ⚠ 直す前は `DESELECT_ENTRY` を撃っていたので、⚠ **戻った瞬間に
     *   「さっきまで読んでいた物」が消えていた** ── 帰り道は「もう一度探す」しか
     *   無く、それは CLAUDE.md の「欠陥の多くは**さっきまでやっていたことが消える**
     *   形で出る」そのものである。裁定は「開いたままにし、一覧の上に
     *   **ノートへ →** を出す」(その行は `paintReturn` が描く)。
     */
    if (page === 'list') appPhone.showList();
  },
  /**
   * 🔴 **左の列にしか無い操作を、本文ページから出す**(#632 段①、設計 doc §2-7)。
   *
   * ⚠ **受け手を 1 つも増やさない** ── 出すのは既存の登記
   *   (`entryMenuActions` = 行の右クリックと同じ字)と `open-palette` だけである。
   *   ⚠ 添付 / 録音 / 画面録画 / 計測(左の列の create-bar に在る 4 つ)は**段③**で足す
   *   ── create-bar との等値 pin を先に書かないと、片方に足した日に静かにずれる。
   */
  'phone-menu': (dispatcher, target, _services, root) => {
    // ⚠ 2 度目の ⋯ は閉じる(片道の操作を作らない ── user 指示 2026-08-23)
    if (contextMenuOpen(root)) {
      closeContextMenu(root);
      return;
    }
    const st = dispatcher.getState();
    const lid = st.selectedLid;
    if (lid === null) return;
    const rect = target.getBoundingClientRect();
    openContextMenu(
      root,
      { x: rect.left, y: rect.bottom },
      /**
       * 🔴 **足すのは真ん中**(着地前レビュー 欠陥 7)── 末尾へ足すと、
       *   `ENTRY_MENU_ACTIONS` が守っている「**消す物をいちばん下**」が黙って壊れる。
       * ⚠ 足す 5 つ:左の列にしか無い道具 4 つ(添付 / 録音 / 画面録画 / 時間を計る)と
       *   操作を探す。4 つとも `selectedLid` を要るのに押し口は一覧の中にしか無く、
       *   スマホでは**戻ると対象が消える**(円環の dead click)。
       */
      // ⚠ `MenuItem` で型を留める ── 追記欄の項目だけが持つ `attrs` を通すため
      withTrailingLast<MenuItem>(
        [
          /**
           * 🔴 **毎日使うものを上へ**(user 裁定 2026-09-02)。
           *
           * ⚠ 直す前は右クリックの 11 項目(印を付ける / 複製 / 書き出す…)が
           *   先頭を占めていて、**添付・録音・画面録画・計測が下**だった ──
           *   スマホでこの 4 つに届く道は ⋯ **しか無い**のに、いちばん遠い。
           * 🔑 並べる順は**使う頻度**であって、実装の由来(既存の登記 → 足した物)
           *   ではない。
           */
          /**
           * 🔴 **system 領域のノート(メッセージ・処理の記録)には、ノートの操作を出さない**
           * (#1038 台帳③ C1 の着地前レビュー)。
           * ⚠ 本文の上の帯は `detail.ts` が system のノートでは出さない(設計 doc §7
           *   「編集・追記・削除・改名・履歴の押し口は system のノートでは出さない」)が、
           *   この ⋯ は **判定を持たずに**全部を並べていた ── 「編集」を足したことで、
           *   メッセージのノートを全文編集に入れられる抜け道になった(reducer でも再現)。
           * 🔑 判定は `detail.ts` と同じ `isSystemMessageLid` 1 か所から引く(§7)。
           */
          ...(isSystemMessageLid(lid)
            ? []
            : [
                ...noteToolActions(),
                /**
                 * 🔴 **本文が届くまで「編集」は押せない**(#1038 台帳③ C1)。
                 * ⚠ ここも `selectedLid` = 開いているノートなので、本文の上のボタンと
                 *   **同じ条件**(`openBody?.lid === lid`)で判定する。
                 */
                ...withEditReady(
                  entryMenuActions({
                    archetype: st.entryMetas.get(lid)?.archetype ?? null,
                    linkedFile: st.linkedFiles.get(lid) ?? null,
                  }),
                  st.openBody?.lid === lid,
                ),
              ]),
        ],
        [
          /**
           * 🔴 **コピーした物**(#678)。⚠ スマホには `Ctrl+Shift+V` が無く、
           *   左の列も見えていない ── **ここが唯一の入口**である。
           * ⚠ 置き場は**追記欄の項目より前** ── 「追記欄を畳む」が
           *   「操作を探す」の直前に在る並び(#701 C)を崩さない。
           */
          {
            action: 'open-copy-history',
            label: 'コピーした物を開く',
            hint: 'この端末で前にコピーした物を出します(押すともう一度コピーされます)',
          },
          /**
           * 🔴 **追記欄を畳む / 戻す**(#701 C)。⚠ スマホには取っ手が 8px しか無く、
           *   畳めることを知る口が無かった ── この面の道具の中で ⋯ に無いのはこれだけだった。
           *   受け手は `toggle-pane`(新しい受け手を作らない)、`data-pkc-pane` は
           *   **この項目だけ**に付ける(`attrs`)。置き場は「操作を探す」の直前 ──
           *   先頭 4 つ(毎日使う道具)と右クリックの並びを崩さない(unit が順番を pin する)。
           * ⚠ 追記欄の出ない種類(フォルダ・添付)では出さない ── 押しても何も起きない。
           */
          ...(isAppendable(st.entryMetas.get(lid)?.archetype)
            ? [
                {
                  action: 'toggle-pane',
                  label: appPanes.getHidden().includes('append') ? '追記欄を戻す' : '追記欄を折りたたむ',
                  hint: appPanes.getHidden().includes('append')
                    ? '本文の下に追記欄を出します'
                    : '本文の下の追記欄を折りたたんで、本文を広く読みます(もう一度で戻ります)',
                  attrs: { 'data-pkc-pane': 'append' },
                },
              ]
            : []),
          {
            action: 'open-palette',
            label: '操作を探す',
            hint: 'できる操作を名前で絞り込んで、その場で実行します',
          },
        ],
      ),
      root.ownerDocument.activeElement,
      { [MENU_LID_ATTR]: lid },
    );
  },
  'open-palette': (dispatcher, _target, services, root) =>
    openPaletteFor(root, dispatcher, appKeymap, (t, o) => services.showStatus?.(t, o)),
  /**
   * 🔴 **左の列に出た操作の一覧の行を押した**(#274 段①。姿 = D)。
   * ⚠ 実行は `runCommandRow` ── 鍵・パレットと同じ `runGlobalCommand` の道(2 本目を作らない)。
   * ⚠ 済んだら欄を空にして、ノートの一覧へ戻す(`>` を残すと、操作を実行した後も
   *   一覧が操作のまま居座る)。⚠ **実行が欄を書き換えていたら触らない**(別の語を消さない)。
   */
  'run-command-row': (dispatcher, target, services, root) => {
    const id = target.closest<HTMLElement>('[data-pkc-command]')?.getAttribute('data-pkc-command');
    if (id === null || id === undefined) return;
    const memo = takeLiveRowMemo();
    const from = dispatcher.getState().filterQuery;
    const env: CommandEnv = { root, dispatcher, keymap: appKeymap, notify: (t, o) => services.showStatus?.(t, o) };
    const exec = (): void => {
      runCommandRow(id, env, {
        onDone: () => {
          // 🔴 実行が**済んだ**ときだけ憶える(相手を選ぶ小窓をやめた回は呼ばれない)。
          //   ⚠ 鍵は label ではなく id(改名で変わらない)
          appRecentCommands.push(id);
          if (dispatcher.getState().filterQuery === from)
            dispatcher.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
        },
      });
    };
    // 🔴 1 面のライブ編集では、探す欄を押した時点で行が消えている ── 開き直して caret を戻してから実行する(#582)
    if (reopenLiveRowThen(env, id, memo, exec)) exec();
  },
  /**
   * 🔴 **コピーした物を選ぶ**(#678)── **もう一度コピーする**(その場へ差し込まない)。
   *
   * ⚠ 差し込むには caret が要るが、メニューを開いた時点で欄から焦点が外れる ──
   *   **開いた場所によって結果が変わる**動線になる。もう一度コピーする形なら
   *   どこから開いても同じで、そのまま貼れる。
   * ⚠ **添字は札が持っている**(`data-pkc-copied`)── ここで推測しない。
   *   無い / 範囲外なら**何もしない**(押した覚えの無い物をクリップボードへ入れない)。
   * ⚠ **写せなかったら言う** ── 黙って終えると、貼ったときに前の物が出て
   *   「押したのに変わらない」になる。
   */
  /** ⚠ 鍵と同じ実体を呼ぶ(口を 2 つ作らない)。 */
  'open-copy-history': (_dispatcher, _target, services, root) => {
    openCopyHistory(root, (t) => services.showStatus?.(t));
  },
  'open-recent': (dispatcher, _target, services, root) => {
    openRecentEntries(root, dispatcher, (t, o) => services.showStatus?.(t, o), services);
  },
  'use-copied': (_dispatcher, target, services) => {
    const raw = target.getAttribute('data-pkc-copied');
    const i = raw === null ? -1 : Number(raw);
    const item = Number.isInteger(i) && i >= 0 ? appCopyHistory.items()[i] : undefined;
    if (item === undefined) return;
    void (item.html === '' ? copyPlainText(item.text) : copyMarkdownAndHtml(item.text, item.html))
      .then((ok) => {
        services.showStatus?.(
          ok
            ? `「${copyLabel(item.text, 24)}」をコピーしました(そのまま貼れます)`
            : 'コピーできませんでした(ブラウザに拒否されました)',
          ok ? undefined : CAUTION,
        );
      });
  },
  /**
   * 🔴 **溜めてから貼る**(#679)── 選んで、並べて、**追記の欄へ**まとめて入れる。
   *
   * > user の言葉 2026-09-03「**ペースト時の一括ペーストや並び替えしてからのペースト
   * > (スクラップのような)**」
   *
   * 🔑 **入れる先は本文ではなく追記の欄**である。⚠ 本文へ直に入れると
   *   「入る前に見る」場所がどこにも無い ── 追記の欄は**既に在る下見**で、
   *   そこで直せるし、追記先(末尾 / 章)も既に選べる(新しい入れ先を作らない)。
   * ⚠ 欄が畳んであっても**開いてから**入れる ── 入れた字が画面のどこにも
   *   無い、という形にしない(#655 ② と同じ作法)。
   * ⚠ 既に打ちかけの字が在れば**空行 1 つで後ろに継ぐ** ── 消さない。
   */
  'paste-many-copied': (_dispatcher, _target, services, root) => {
    const items = appCopyHistory.items();
    void pickScrapInApp(
      root,
      items.map((c) => ({ label: copyLabel(c.text), key: c.text })),
    ).then((keys) => {
      if (keys === null) return;
      const text = joinCopied(pickMarked(items, keys));
      if (text === '') {
        services.showStatus?.('選んだ物が空だったので、何も入れていません');
        return;
      }
      const opened = revealAppendPane(root);
      const input = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]');
      if (input === null) {
        services.showStatus?.('追記の欄が見つかりません(ノートを開いてから押してください)', CAUTION);
        return;
      }
      const prev = input.value.replace(/\s+$/, '');
      input.value = prev === '' ? text : `${prev}\n\n${text}`;
      // ⚠ 欄の高さを合わせている側へ知らせる(値を入れただけでは伸びない)
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      services.showStatus?.(
        `選んだ ${keys.length} 件を追記の欄に入れました(「追記」で本文へ入ります)${openedNote(opened)}`,
      );
    });
  },
  /**
   * 🔴 **全部消す**(#678)── コピーした物が残り続けるのは、user が消したい情報を
   *   持ち続けることである。⚠ 消えたことを言う(無言で終えない)。
   */
  'clear-copy-history': (_dispatcher, _target, services) => {
    appCopyHistory.clear();
    services.showStatus?.('コピーした物を全部消しました');
  },
  'nav-back': (dispatcher) => navigateHistory(dispatcher, 'back'),
  'nav-forward': (dispatcher) => navigateHistory(dispatcher, 'forward'),
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
   * 🔴 **並びの向きを逆にする**(依頼 198)。⚠ 2 ペインの列見出し(`dual-sort`)と同じ
   * `entrySortDesc` 1 本を反転する(面ごとに向きを持たせない)。「自分で並べた順」には向きが無い。
   */
  'toggle-entry-sort-desc': (dispatcher) => {
    const st = dispatcher.getState();
    if (st.entrySort === 'manual') return;
    dispatcher.dispatch({ type: 'SET_ENTRY_SORT', sort: st.entrySort, desc: !st.entrySortDesc });
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
    startEditAt(dispatcher, services, null);
  },
    // ⚠ 第 4 引数の **root** を使う(target ではない)── 追記欄の出口は detail の
  //    兄弟なので、押したボタンから題名欄へは辿れない(P8 段⑲)
  'commit-edit': (dispatcher, _target, _services, root) => {
    settleRowEditor(root);
    renameFromEditorInput(dispatcher, root);
    dispatcher.dispatch({ type: 'COMMIT_EDIT' });
  },
  'cancel-edit': (dispatcher, _target, _services, root) => cancelFromEditor(dispatcher, root),
  /**
   * 🔴 **章の欄を保存する**(#1044 段2)。
   *
   * ⚠ 打ちかけの字は state に無い(`cell-input.ts` と同じ規律)── **箱そのもの**
   *   (`data-pkc-field="section-draft-input"`)から読む。読めなければ何もしない
   *   (箱が既に無い = 何かの理由で先に閉じている。防波堤)。
   * ⚠ **ロックはここで返さない**(#1044 段2、F-B)── `bindEditLockRelease` が
   *   `sectionDraft` を state から直に見て返す(F-A の system command 経由で
   *   `sectionDraft` が閉じたときも同じ 1 か所が返す)。ここで二重に返しても
   *   実害は無い(`releaseEdit` は idempotent ── `store-proxy.ts`)が、
   *   「離れる経路ごとに書く」を増やさない(§7)。
   */
  'save-section-draft': (dispatcher, _target, _services, root) => {
    const lid = dispatcher.getState().sectionDraft?.lid ?? null;
    if (lid === null) return;
    const host = root.querySelector<HTMLElement>(BODY_HOST_SELECTOR);
    const text = host === null ? null : sectionBoxText(host);
    if (text === null) return;
    dispatcher.dispatch({ type: 'SAVE_SECTION_DRAFT', text });
  },
  /**
   * 🔴 **章の編集をやめる**(#1044 段2)。⚠ `cancel-edit` と同じく**聞かない**
   *   (押すこと自体が「捨ててよい」という声である ── 聞くのは「別のノートを
   *   選ぶ」ときだけ、設計 doc §3)。
   * ⚠ **ロックはここで返さない**(#1044 段2、F-B。上の `save-section-draft` と同じ理由)。
   */
  'cancel-section-draft': (dispatcher) => {
    dispatcher.dispatch({ type: 'CANCEL_SECTION_DRAFT' });
  },
  /**
   * 🔴 **コード枠の欄を保存する**(#1044 段3。`save-section-draft` と同じ形)。
   */
  'save-code-draft': (dispatcher, _target, _services, root) => {
    const lid = dispatcher.getState().sectionDraft?.lid ?? null;
    if (lid === null) return;
    const host = root.querySelector<HTMLElement>(BODY_HOST_SELECTOR);
    const text = host === null ? null : codeBoxText(host);
    if (text === null) return;
    dispatcher.dispatch({ type: 'SAVE_CODE_DRAFT', text });
  },
  /**
   * 🔴 **コード枠の編集をやめる**(#1044 段3。`cancel-section-draft` と同じく聞かない)。
   */
  'cancel-code-draft': (dispatcher) => {
    dispatcher.dispatch({ type: 'CANCEL_CODE_DRAFT' });
  },
  /**
   * 🔴 **コード枠の ✎ ── その枠だけを、読む面のその場で編集する**(#1044 段3)。
   *
   * ⚠ ✎ は eligible な枠だけに焼かれる(`markdown-render.ts` の
   *   `interactiveCodeBlocks` + 属性判定)ので、ここは**押せた時点で対象**。
   * ⚠ **横に留めた枠(2 ペイン)は対象外**(章の欄と同じ範囲 ── `state.openBody`
   *   だけを見る)── そこに乗る枠を押しても無言で戻る(押した物と効く先が
   *   食い違う事故を避ける。CLAUDE.md §7)。
   * 🔴 **`tableLineAt` は frontmatter 込みの行を返す**(csv-cell / task と同じ
   *   基準 ── `MENU_TABLE_ATTR` の docstring)。⚠ `startCodeEditAt` /
   *   `OPEN_CODE_DRAFT` が受けるのは**剥がした本文の行**(`bodySourceLineAt` /
   *   `OPEN_SECTION_DRAFT` と同じ基準)なので、**ここで 1 度だけ**引く
   *   (#1044 段3 2巡目の修理、V1)。⚠ 引かずにそのまま渡すと、reducer が
   *   もう一度足して frontmatter の行数だけずれ、frontmatter を持つノートでは
   *   ✎ が必ず「このコード枠を編集できませんでした」に落ちる。
   * 🔴 **行が引けなければ、無言で戻らず理由を出す**(#1044 段3 2巡目の修理、V2)。
   *   ⚠ 直す前はここが無言で return していた ── `body === null` /
   *   `tableLineAt` が `null`(刻印が見つからない)のどちらも、押した user には
   *   「押したのに何も起きない」としか見えない(いちばん静かな dead click)。
   *   ⚠ `[data-pkc-split-lid]` の 1 行は**含めない** ── そちらは「押した物と
   *   効く先が食い違う」を避けるための**意図した**無言(上の注記どおり)。
   */
  'edit-code-block': (dispatcher, target, services, root) => {
    if (target.closest('[data-pkc-split-lid]') !== null) return;
    const st0 = dispatcher.getState();
    const body = st0.openBody?.body ?? null;
    if (body === null) {
      services.showStatus?.('本文が開いていません(ノートを開いてから押してください)', CAUTION);
      return;
    }
    const rawLine = tableLineAt(target, body);
    if (rawLine === null) {
      services.showStatus?.('このコードブロックが見つかりません(本文を開き直してください)', CAUTION);
      return;
    }
    startCodeEditAt(dispatcher, services, root, rawLine - frontmatterLineCount(body));
  },
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
  'schedule-quick-here': (_dispatcher, target) => {
    const date = target.getAttribute('data-pkc-quick-date') ?? '';
    // 🔴 **押した面の欄**を読む(#673 段②)── 予定の面は 2 つ在りうる(下の注記)
    const face = scheduleFaceOf(target);
    const dateEl = face?.querySelector<HTMLInputElement>('[data-pkc-field="schedule-quick-date"]');
    const textEl = face?.querySelector<HTMLInputElement>('[data-pkc-field="schedule-quick-text"]');
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
  /**
   * 🔴 **予定の欄の日付を押すと、本文に日付を差すときと同じ選び方が開く**(#1635 項 2。
   * Gemini 裁定 = #1163 の依頼 36「2-B」)。
   *
   * > 「明日」の予定を入れたい。本文の「日付を入れる」には 今日 / 明日 / 今週末 / 来週 が
   * > 出るのに、予定の欄の日付にはブラウザ標準の入力しか出ない。
   *
   * 🔑 選び方は `pickDateInApp` 1 本(本文の `insert-date` と同じ。近道の表も `DATE_SHORTCUTS`)。
   * ⚠ 欄の値の読み手は `schedule-quick-add` のまま(欄の `.value` に書き戻すだけ)。
   * ⚠ **時刻の欄は出さない**(`withTime: false` ── 予定の欄は日付だけ。打っても捨てる形にしない)。
   * ⚠ **開いた時点の日付は欄の値**(今日とは限らない)。**空のまま「入れる」を押せば欄も空になる**
   *   (`allowEmpty` ── 日付なしで足す道を、マウスだけでも残す)。
   * ⚠ キーボードは変えない: 欄へ Tab で入って数字を打つ / Space で標準のピッカーを開く、は従来どおり
   *   (押下 = `click` だけを受ける。Enter / Space の `click` は日付欄では起きない)。
   */
  'schedule-pick-date': (_dispatcher, target, _services, root) => {
    const face = scheduleFaceOf(target);
    const dateEl = face?.querySelector<HTMLInputElement>('[data-pkc-field="schedule-quick-date"]');
    if (!dateEl) return;
    void pickDateInApp(
      root,
      new Date(),
      DATE_SHORTCUTS,
      (id, now) => (isDateShortcut(id) ? shortcutDate(id, now) : ''),
      { withTime: false, initialDate: dateEl.value, allowEmpty: true },
    ).then((picked) => {
      // ⚠ 面が組み直されても、いま画面に在る欄へ書く(最初に掴んだ欄は外れているかもしれない)
      const now = dateEl.isConnected
        ? dateEl
        : root.querySelector<HTMLInputElement>(
            '[data-pkc-region="schedule"] [data-pkc-field="schedule-quick-date"]',
          );
      if (picked === null || !now) return;
      now.value = picked.date;
      now.focus();
    });
  },
  'schedule-quick-add': (dispatcher, target, services) => {
    // 🔴 **押した面の欄**を読む(#673 段②)── `root` から引くと別の面の空欄を読む
    const face = scheduleFaceOf(target);
    const textEl = face?.querySelector<HTMLInputElement>('[data-pkc-field="schedule-quick-text"]');
    const date =
      face?.querySelector<HTMLInputElement>('[data-pkc-field="schedule-quick-date"]')?.value ?? '';
    const timeEl = face?.querySelector<HTMLInputElement>('[data-pkc-field="schedule-quick-time"]');
    const time = timeEl?.value ?? '';
    // 🔴 日付の無い予定には時刻を付けられない(付ける日が無い)── 黙って捨てず、理由を言って欄を残す(#1163 の依頼 57-4)
    if (time !== '' && date === '') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '時刻を付けるときは、日付も選んでください' });
      return;
    }
    // 🔑 書く口は目盛りのドラッグ作成(`schedule-grid-create`)と**同じ 1 本**(`addScheduleItemChecked`)
    // ⚠ 問い合わせの間に 2 回押されても 1 回しか撃たない(#529 W5-d)。欄は読み取り専用にして、
    //   先打ちした字が成功の「欄を空にする」で黙って消えるのを防ぐ
    if (textEl?.hasAttribute('data-pkc-busy')) return;
    const result = addScheduleItemChecked(dispatcher, services, {
      text: textEl?.value ?? '',
      date,
      ...(time === '' ? {} : { time }),
    });
    // 通ったときだけ欄を空にする(#1051。理由は `addScheduleItem` の中)
    // ⚠ 足した知らせ(日付なしで見えない理由も含む)は `addScheduleItem` が出す ── 別の知らせで上書きすると「元に戻す」が消える
    if (typeof result === 'boolean') {
      if (textEl && result) textEl.value = '';
      if (timeEl && result) timeEl.value = '';
      return;
    }
    if (textEl) {
      textEl.setAttribute('data-pkc-busy', '');
      textEl.readOnly = true;
    }
    void result.then((ok) => {
      if (!textEl) return;
      textEl.removeAttribute('data-pkc-busy');
      textEl.readOnly = false;
      if (ok) {
        textEl.value = '';
        // 時刻は一回ごと(残すと次の予定にも時刻が付く)
        if (timeEl) timeEl.value = '';
      }
    });
  },
  /**
   * 🔴 **連絡先の面から、その場で 1 件足す**(#278 段③。user 裁定 2026-09-04)。
   *
   * > user の物語: 連絡先タブを眺めている。名刺をもらった人を足したい。
   * > いまは足す口が無い ── ノートを作る → 先頭に `---` / `tel:` … と手で書く → 戻る。
   *
   * 🔑 **書く形は取込と同じ 1 本**(`vcfNoteOf`)── frontmatter の鍵の綴りを
   *   ここで 2 度目に書かない(§7)。名前だけなら囲みは書かれない(同じ規則)。
   * ⚠ **電話・メールの妥当性は書く側で弾かない** ── 原値のまま書く。押せない宛先を
   *   字のまま出す規則は `contacts.ts` が持つ(2 か所で判定しない)。
   * ⚠ 欄は**押した面**から引く(`closest`)── 連絡先の面は左のタブと中央の 2 つ在りうる
   *   (`root.querySelector` は先に描かれた左の空欄を読む ── 予定の `scheduleFaceOf` と同型)。
   * ⚠ 面は切り替えない・編集にも入らない(眺めたまま足す ── #300)。
   * 🔴 **一覧は「書込が着いてから」集め直す**(CLAUDE.md §7、2026-08-17 の実測)──
   *   走査は書込の chain の**外**を通るので、待たずに頼むと作る前の一覧が返る。
   */
  'contacts-quick-add': (dispatcher, target, services) => {
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}足してください` });
      return;
    }
    const box = target.closest<HTMLElement>('[data-pkc-field="contacts-quick"]');
    const field = (name: string): HTMLInputElement | null =>
      box?.querySelector<HTMLInputElement>(`[data-pkc-field="contacts-quick-${name}"]`) ?? null;
    const read = (name: string): string => (field(name)?.value ?? '').trim();
    const name = read('name');
    if (name === '') {
      // ⚠ **無言で終わらせない**(欄は出ているのに何も起きない dead click になる)
      dispatcher.dispatch({ type: 'OP_FAILED', error: '名前を入力してください' });
      return;
    }
    const tel = read('tel');
    const email = read('email');
    const org = read('org');
    const { title, body } = vcfNoteOf({
      name,
      tels: tel === '' ? [] : [tel],
      emails: email === '' ? [] : [email],
      orgParts: org === '' ? [] : [org],
      birthday: '',
      notes: [],
      others: [],
    });
    const lid = generateLid();
    dispatcher.dispatch({
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid,
      title,
      body,
      parentLid: null,
      relationId: generateLid(),
      // ⚠ **編集に入らない**(連絡先を眺めたまま足したいので、面を奪わない)
      edit: false,
      // 🔴 **開いているノートも左の探す欄も動かさない**(#1087)── 既定の `CREATE_ENTRY` は選択を新しい物へ動かし、絞りを外す
      keepSelection: true,
    });
    // ⚠ 作れなかった回(lid 衝突 ── reducer が理由を立てる)は欄を消さない(打った字を失わせない)
    if (!dispatcher.getState().entryMetas.has(lid)) return;
    // ⚠ 連絡できない(電話もメールも無い)ノートはこの面に並ばない ── 黙らない
    /**
     * 🔴 **探す欄の語に当たらず一覧に出ないときも、黙らない**(下の else if。#1087 の見直し 2026-10-13)。
     * ⚠ 直す前は欄が空になるだけで、足した人が一覧に出ず、知らせも無かった(「足したのに出てこない」)。
     * 🔑 当たるかの判定は一覧と同じ `matchContact`(2 か所で判定しない)。
     */
    if (tel === '' && email === '')
      dispatcher.dispatch({
        type: 'OP_NOTICE',
        message: `「${title}」を作りました(電話かメールを書くと連絡先に並びます)`,
      });
    else if (
      !matchContact(
        { name: title, org, tels: tel === '' ? [] : [tel], emails: email === '' ? [] : [email] } as unknown as ContactCard,
        // ⚠ 撃った**後**の絞りで見る(撃つ前の値で見ると、絞りが動いた回に実際と逆の知らせが出る)
        dispatcher.getState().filterQuery,
      )
    )
      dispatcher.dispatch({
        type: 'OP_NOTICE',
        message: `「${title}」を足しました(左の探す欄の語に当たらないので、一覧には出ていません)`,
      });
    for (const f of ['name', 'tel', 'email', 'org']) {
      const el = field(f);
      if (el) el.value = '';
    }
    field('name')?.focus();
    // 🔑 一覧は走査の結果から出る ── 作っただけでは並ばないので、着いてから集め直す
    void Promise.resolve(services.settle?.() ?? null).then(() =>
      dispatcher.dispatch({ type: 'REFRESH_CONTACT_SCAN' }),
    );
  },
  'open-today': (dispatcher, _target, services, root) => {
    const st = dispatcher.getState();
    if (st.phase !== 'ready') return;
    if (st.viewMode !== 'detail') dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    const title = todayNoteTitle(new Date());
    const found = findTodayNote(st.entryMetas.values(), title);
    /**
     * 🔴 **「今日」を押したあとのカーソル**(#1087 流れ 29)。
     * - 既に在る → 選んで、本文の下の**追記欄**へ(畳んでいれば一時的に開く ── `append-at-heading` と同じ道)
     * - まだ無い → 作って、**本文**へ(題名は日付のまま。他の作り方は今までどおり題名へ)
     * ⚠ 叶えるのは描く側(`append-box.ts` / `detail.ts`)── 本文の到着や編集欄の組み終えを待つため。
     */
    if (found) {
      requestAppendFocus(found.lid);
      revealAppendPane(root);
      dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: found.lid });
      /**
       * ⚠ 既に今日のノートを開いているとき、`SELECT_ENTRY` は状態を変えない ── 描き直しが来ず、
       *   描く側(`append-box.ts`)が頼みを引き取る機会が無い。その場合だけここで叶える
       *   (描き直しが来た回は、描く側が引き取り済みなので `takeAppendFocus` は偽になり二重に当てない)。
       */
      const now = dispatcher.getState();
      if (
        now.selectedLid === found.lid &&
        appendModeOf(now).kind === 'ready' &&
        takeAppendFocus(found.lid) &&
        !isTouchOnly()
      )
        root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]')?.focus();
      return;
    }
    const lid = generateLid();
    requestBodyFocus(lid);
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
  /**
   * 🔴 **文字起こしの行頭の時刻を押すと、その位置から再生する**(#1232 段 b)。⚠ 本文は書かない(門に載せない)。
   * 🔑 鍵(Enter / Space)は `<span role="button" tabindex="0">` の既存の道に乗る(`onKeydown`)。
   */
  'seek-media': (dispatcher, target) => {
    seekMedia(dispatcher, target);
  },
  /**
   * 🔴 **本文の `@2026-10-15` を押すと、その日のノートを開く**(#1169)。
   *
   * > user の物語:予定に `@日付` と書いた。その日に書き留めたノート(題名が日付)へ
   * > **1 手で**飛びたい。無ければ、その場で作って書き始めたい。
   *
   * 🔑 探し方・作り方は「今日」(`open-today`)と**同じ 1 本**(`findTodayNote` / 題名は日付)。
   * ⚠ 日付を押した時点では**作らない**(打ち間違いの日付でノートが増えない)── 無ければ
   *   画面の下に「○○のノートを作る」を出し、**それを押したとき**に作る(`create-date-note`)。
   */
  'open-date-note': (dispatcher, target, services, root) => {
    openDateNote(dispatcher, target.getAttribute('data-pkc-date'), root, services);
  },
  /** 🔴 画面の下の「○○のノートを作る」── 作って、開く(`open-date-note` の続き)。 */
  'create-date-note': (dispatcher, target, services, root) => {
    createDateNote(dispatcher, target.getAttribute('data-pkc-date'), root, services);
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
    // 🔑 面の切替・作成・編集権は `createAndEdit` 1 本(行の右クリックと同じ経路 ── #215)
    createAndEdit(dispatcher, services, archetype, parent?.lid ?? null);
  },
  /**
   * 🔴 **テンプレートから作る**(#1645 項目 4。Gemini 裁定 = #1163 の依頼 39-4=A「推薦どおり」)。
   *
   * ⚠ 一覧は `insert-snippet` と**同じ走査結果**(`snippetScan`)── 自分のテンプレートだけ並べる
   *   (組み込みの表・図は本文に挿す物で、ノートの中身にならない)。
   * ⚠ 本文は `insertSnippet` で空の本文へ挿した結果を使う(日付などの変数の埋め方を 2 か所に書かない)。
   * ⚠ 入れ先・編集に入る・編集権は `create-entry` と同じ `createAndEdit` 1 本。
   * ⚠ 一覧を開いている間に編集へ入った / 取り込みが始まったなら、作らずに理由を言う。
   * ⚠ 無いときは黙らない ── 作り方を書いた 1 行(`snippetMenuNote`)を出す。
   */
  'create-from-template': (dispatcher, _target, services, root) => {
    const st = dispatcher.getState();
    if (st.phase !== 'ready') return;
    const scan = st.snippetScan;
    const items = scan?.items ?? [];
    if (items.length === 0) {
      dispatcher.dispatch({ type: 'OP_NOTICE', message: snippetMenuNote(scan) });
      return;
    }
    void pickTemplateNoteInApp(root, items, snippetMenuNote(scan)).then((lid) => {
      if (lid === null) return;
      const item = items.find((s) => s.lid === lid);
      if (item === undefined) return;
      const now = dispatcher.getState();
      if (now.phase !== 'ready') {
        dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(now.phase)}ノートを作ってください` });
        return;
      }
      const parent = now.scopeLid === null ? null : (now.entryMetas.get(now.scopeLid) ?? null);
      const body = insertSnippet({ text: '', start: 0, end: 0 }, item.body, new Date()).text;
      createAndEdit(dispatcher, services, 'text', parent?.lid ?? null, body);
    });
  },
  /**
   * 🔴 **このフォルダの中に新しいノートを作る**(#215。行の右クリック / 情報ペイン / 鍵)。
   *
   * ⚠ `create-entry` との違いは**入れ先だけ** ── あちらは「いま見ているフォルダ」、
   *   こちらは「押した行のフォルダ」(中へ入らずに 1 枚置ける)。種類は `text` に固定する
   *   ── 字が「新しい**ノート**を作る」なので、帯の種類の `<select>` を読んで
   *   フォルダやチェックリストができると押した字と食い違う。
   * ⚠ 無言で断らない ── フォルダでない行 / 編集中は理由を出す(`when: 'folder'` で
   *   メニューには出ないが、鍵と情報ペインからは来うる)。
   */
  'create-in-folder': (dispatcher, target, services) => {
    const st = dispatcher.getState();
    const lid = rowLidOrSelected(st, target);
    const meta = lid === null ? undefined : st.entryMetas.get(lid);
    if (meta === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'フォルダの行を選んでから押してください' });
      return;
    }
    if (meta.archetype !== 'folder') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: 'フォルダの行で押してください(ノートの中にはノートを作れません)',
      });
      return;
    }
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}ノートを作ってください` });
      return;
    }
    createAndEdit(dispatcher, services, 'text', meta.lid);
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
  'smart-cond-add': (dispatcher, _target, services, root) => {
    const st = dispatcher.getState();
    const lid = st.scopeLid;
    if (lid === null) return;
    // 🔴 編集中は reducer が黙って捨てる(`SMART_COND`)── 打った字が欄から消えるだけになるので、先に理由を出して欄は残す(#1087)
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}条件を書き換えてください` });
      return;
    }
    const field = root.querySelector<HTMLInputElement>('[data-pkc-field="smart-cond"]');
    // 🔑 **打った字の読み方はどの欄でも同じ**(#637)── `#請求 #未払` で 2 条件
    const longMsg = overlongTagMessage(field?.value ?? '');
    if (longMsg !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: longMsg });
      return;
    }
    const tags = splitTags(field?.value ?? '');
    if (tags.length === 0) {
      // ⚠ **無言で終わらせない**(帯は出ているのに何も起きない dead click になる)
      dispatcher.dispatch({ type: 'OP_FAILED', error: '集める条件にするタグを入力してください' });
      return;
    }
    // 🔴 実体は条件の入れ物(フォルダのノート)の本文を書く ── 別のタブ・窓が編集中なら撃たない(#1087)
    actUnlessEditedElsewhere(dispatcher, services, [lid], SMART_COND_ELSEWHERE_FAILED, () => {
      // 🔑 前の回に入らなかった名前は、この回の字に混ぜない(#640 案 A)
      dispatcher.dispatch({ type: 'CLEAR_REFUSED_TAGS', field: 'smart-cond' });
      for (const tag of tags) dispatcher.dispatch({ type: 'SMART_COND', lid, tag, mode: 'add' });
      // 🔑 通したら欄を空にする(次の 1 つを打てる)── ⚠ 断ったときは残す(撃つ前に断るので、ここへ来ない)。
      //    ⚠ 断りは後から来る ── 入らなかった名前は効果層が `TAGS_REFUSED` で返し、
      //    描く側(`filer.ts`)が欄へ戻す(#640 案 A)
      if (field) field.value = '';
    });
  },
  /**
   * 🔴 **列で引く条件を選ぶ**(#421 段②)。⚠ `<select>` なので **change** で来る
   *   ── binder の `onChange` が `data-pkc-action` を見て呼ぶ。
   * ⚠ **どの条件か**は要素が持つ(`data-pkc-smart-field`)── action を
   *   4 つに割ると、足すたびに 4 か所へ書くことになる(§7)。
   */
  'smart-field': (dispatcher, target, services) => {
    const st = dispatcher.getState();
    const lid = st.scopeLid;
    if (lid === null) return;
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}条件を書き換えてください` });
      return;
    }
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
    actUnlessEditedElsewhere(dispatcher, services, [lid], SMART_COND_ELSEWHERE_FAILED, () =>
      dispatcher.dispatch({ type: 'SMART_FIELD', lid, field: field as SmartField, value }),
    );
  },
  'smart-cond-remove': (dispatcher, target, services) => {
    const st = dispatcher.getState();
    const lid = st.scopeLid;
    const tag = target.getAttribute('data-pkc-tag') ?? '';
    if (lid === null || tag === '') return;
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}条件を書き換えてください` });
      return;
    }
    actUnlessEditedElsewhere(dispatcher, services, [lid], SMART_COND_ELSEWHERE_FAILED, () =>
      dispatcher.dispatch({ type: 'SMART_COND', lid, tag, mode: 'remove' }),
    );
  },
  /**
   * 🔴 **選んだものを、このスマートフォルダから外す**(user 指示 2026-08-23)。
   * ⚠ 実体は「条件のタグを本文から消す」── 入れ物から出すのではない。
   */
  'smart-evict': (dispatcher, _target, services, root) => {
    const st = dispatcher.getState();
    const smartLid = st.scopeLid;
    if (smartLid === null) return;
    // 🔴 reducer の `SMART_TAGS` は編集中に黙って捨てるので、押した所で理由を言う(条件の欄と同じ ── #1087)
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}外してください` });
      return;
    }
    // ⚠ 相手は**いま表に出ている印**だけ(`delete-selected` / `bulk-tag` と同じ規則)
    const rows = new Set(visibleFilerRows(st).map((r) => r.lid));
    const lids = st.selection.filter((lid) => rows.has(lid));
    if (lids.length === 0) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '外すものを選んでください' });
      return;
    }
    void root;
    // 🔴 実体は選んだノートのタグを外す書込 ── 別のタブ・窓が編集中のノートが在れば撃たない(#1087)
    actUnlessEditedElsewhere(
      dispatcher,
      services,
      lids,
      'タグを外せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
      () => dispatcher.dispatch({ type: 'SMART_TAGS', smartLid, lids, mode: 'remove' }),
    );
  },
  'bulk-tag-add': (dispatcher, _target, services, root) =>
    runBulkTag(dispatcher, services, root, 'add'),
  /**
   * 🔴 **いま開いているノートにタグを打つ**(#494)。
   *
   * > user 指摘 2026-08-27:「**直感的にここにタグを打つ!って感じの動作じゃなくて
   * > yamlfrontmatter なのは問題だ。しかも設定動線がよくわからん**」
   *
   * 🔑 **書く口は増やさない** ── まとめて付ける経路(`BULK_TAG`)へ
   *   **相手 1 件**で流す。frontmatter を組み直す規則を 2 つ作ると、片方だけが
   *   #284 系の修理に追随して静かに食い違う(§7)。
   * ⚠ 相手は `scopeLid` ではなく **`selectedLid`**(情報ペインが出しているのは
   *   「いま選んでいる 1 件」である ── `filer` の帯とは別の面)。
   */
  'add-tag': (dispatcher, _target, services, root) => {
    const st = dispatcher.getState();
    const lid = st.selectedLid;
    if (lid === null) return;
    const field = root.querySelector<HTMLInputElement>('[data-pkc-field="tag-add-input"]');
    // 🔴 打っている間に編集が始まったら、黙って欄を空にしない(reducer は捨てるので字だけ消える。#1087)
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}タグを足してください` });
      return;
    }
    /**
     * 🔴 **`#買い物 #家事` と打てば 2 つ付く**(#637。user 裁定 2026-08-31)。
     *
     * ⚠ 直す前はこの欄だけが**割らなかった** ── 本文のタグの行に同じ字を
     *   書けば 2 つになるのに、ここへ打つと **「買い物 #家事」という 1 つの名前**が
     *   できていた(⚠ 先頭の井桁は `normalizeTag` が落とすので、**打った字そのものは
     *   どこにも残らない** ── 2 稿目で実測して訂正した。`#買い物` を grep しても
     *   見つからないので、壊れたノートを探す人が探し当てられない形だった)。
     * 🔑 何個と読むかは `splitTags` 1 か所(§7)── 欄も本文も同じ規則にする。
     * 🔑 **既に壊れた名前は、読むときに繋ぎ直す**(`strandedHashWords`)──
     *   直す前に打った人のノートは、割り方を直しただけでは 1 個のままだからである。
     */
    const longMsg = overlongTagMessage(field?.value ?? '');
    if (longMsg !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: longMsg });
      return;
    }
    const tags = splitTags(field?.value ?? '');
    if (tags.length === 0) {
      // ⚠ **無言で終わらせない**(欄は出ているのに何も起きない dead click になる)
      dispatcher.dispatch({ type: 'OP_FAILED', error: '足すタグを入力してください' });
      return;
    }
    // 🔴 別のタブ・窓が編集中のノートへは撃たない(#1087。追記と同じ門)── 断ったときは欄も残る
    actUnlessEditedElsewhere(
      dispatcher,
      services,
      [lid],
      'タグを足せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
      () => {
        dispatcher.dispatch({ type: 'BULK_TAG', lids: [lid], tags, mode: 'add' });
        // 🔑 通したら欄を空にする(次の 1 つを打てる)── ⚠ 断ったときは残す
        if (field) field.value = '';
      },
    );
  },
  /**
   * 🔴 **その札を外す**(#494)。⚠ 裁定 2026-08-23「**片道の操作を作らない**」──
   * 打てるのに外せないと、間違えて付けたタグを消すために本文を開くことになる。
   * ⚠ 相手のタグは**押した札が持つ**(`data-pkc-tag`)── 打つ欄の中身を読むと、
   *   打ちかけの別の語を消すことになる。
   */
  'untag-entry': (dispatcher, target, services) => {
    const st = dispatcher.getState();
    const lid = st.selectedLid;
    const tag = target.getAttribute('data-pkc-tag') ?? '';
    if (lid === null || tag === '') return;
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}タグを外してください` });
      return;
    }
    // 🔴 別のタブ・窓が編集中のノートへは撃たない(#1087。追記と同じ門)
    actUnlessEditedElsewhere(
      dispatcher,
      services,
      [lid],
      'タグを外せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
      () => dispatcher.dispatch({ type: 'BULK_TAG', lids: [lid], tags: [tag], mode: 'remove' }),
    );
  },
  'bulk-tag-remove': (dispatcher, _target, services, root) =>
    runBulkTag(dispatcher, services, root, 'remove'),
  // 🔴 集計(タグ)の組の「名前を変える」「全部外す」(依頼 65-1)。実体は `queryTagBulk`
  // ⚠ 相手のタグは押した組が運ぶ(`data-pkc-tag`)── `untag-entry` と同じ置き場
  'query-tag-rename': (dispatcher, target, services, root) =>
    void queryTagBulk(dispatcher, services, root, target.getAttribute('data-pkc-tag') ?? '', 'rename'),
  'query-tag-remove': (dispatcher, target, services, root) =>
    void queryTagBulk(dispatcher, services, root, target.getAttribute('data-pkc-tag') ?? '', 'remove'),
  'delete-selected': (dispatcher, _target, services, root) => {
    const st = dispatcher.getState();
    // ⚠ 押した場所は**左の列**なので、相手も左の列の集合(2 ペインの印を巻き込まない)
    // ⚠ 左の列は**カーソルを持たない**(印だけの面)── だから `null`
    const rowsBefore = visibleFilerRows(st);
    const first = operationTargets(rowsBefore, st.selection, null)
      .map((l) => rowsBefore.findIndex((m) => m.lid === l))
      .filter((i) => i >= 0)
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
    deleteFrom(dispatcher, services, root, rowsBefore, st.selection, null, () => {
      // 🔴 消した位置を覚える(#1087)── 続けての ↓ / ↑ が隣の行から入る(`rowAt`)。行が 0 件なら残さない
      const after = dispatcher.getState();
      const now = visibleFilerRows(after);
      if (Number.isFinite(first) && now.length > 0)
        deletedGap.set(root, { scope: after.scopeLid, count: now.length, index: first });
    });
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
  /**
   * 🔴 **列見出しの「全部選ぶ」チェック**(Ctrl+A のマウス版。Gemini 裁定 = #1163 への依頼 62)。
   * ⚠ 実体は Ctrl+A と同じ `dualSelectAll`。全部選んでいるときに押したら**選びを外す**(チェックの作法)。
   */
  'dual-select-all': (dispatcher, target) => {
    const side = dualSide(target);
    if (!side) return;
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}フォルダの操作をしてください` });
      return;
    }
    dispatcher.dispatch({ type: 'DUAL_FOCUS', side });
    const rows = dualPaneRows(st, side);
    const marked = new Set(paneOf(st.dual, side).selection);
    const all = rows.length > 0 && rows.every((m) => marked.has(m.lid));
    if (all) dispatcher.dispatch({ type: 'DUAL_CLEAR_SELECTION', side });
    else dualSelectAll(dispatcher, side);
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
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}名前を変えてください` });
      return;
    }
    /**
     * 🔴 **右クリックのメニューからは、押した行**(#1087 D2)。メニューを開いた行が複数の印の中の 1 つのとき、
     *   印は崩さずに開くので、印の件数では決めない(`MENU_LID_ATTR` が運ぶ)。
     * 🔴 それ以外は **印が優先、無ければカーソルの行**(#1087 の見直し 2026-10-13)── F2 と同じ 1 本(`dualRenameTarget`)。
     */
    const menuLid = target.getAttribute(MENU_LID_ATTR);
    if (menuLid) {
      dispatcher.dispatch({ type: 'DUAL_RENAME_BEGIN', side, lid: menuLid });
      return;
    }
    const picked = dualRenameTarget(st, side);
    if ('error' in picked) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: picked.error });
      return;
    }
    dispatcher.dispatch({ type: 'DUAL_RENAME_BEGIN', side, lid: picked.lid });
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
    // 🔴 足すのを断る理由は 1 本(ノートの口と同じ ── `bookmarkRefusal`)。外すときは通る
    const st = dispatcher.getState();
    const stored = appDualPrefs.getBookmarks();
    /**
     * 🔴 **場所の綴りはコレクションごと**(依頼 328 A)。⚠ 古い綴り(素の lid)で入っている物を外すときは、**入っている綴り**を撃つ
     *   (新しい綴りを撃つと、外したつもりが別の物を足す)。入っていなければ新しい綴りで足す(コレクションの id が無いときだけ素の lid)。
     */
    const key = placeBookmarkIn(stored, st.cid, scope) ?? (st.cid === null ? scope : placeBookmarkKey(st.cid, scope));
    const why = bookmarkRefusal(
      stored,
      liveBookmarks(stored, st.cid, (l) => st.entryMetas.has(l)),
      key,
    );
    if (why !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: why });
      return;
    }
    services.toggleDualBookmark?.(key);
  },
  /**
   * 留めた場所へ移る。⚠ **消えた場所は reducer が弾く**(空の表を出さない)。
   * 🔴 **ノート(入れ物でない物)なら、そのノートのある場所へ移って、その行を選ぶ**(#1377)。
   *   ⚠ 行を選ぶだけだと、別のフォルダを見ているときは**行が表に無い**(押したのに何も見えない)。
   *   ⚠ `SELECT_ENTRY` は撃たない(2 ペインを抜けて本文の画面へ切り替わる ── 帯の外へ連れ出さない)。
   */
  'dual-bookmark-open': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-entry');
    if (lid === null || lid === '') return;
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    const st = dispatcher.getState();
    const meta = st.entryMetas.get(lid);
    if (meta !== undefined && !canEnterScope(meta.archetype)) {
      const parent = resolveCanonicalParents(st.entryMetas, st.relations).get(lid) ?? null;
      /**
       * 🔴 **そのペインの名前の絞りを先に解く**(#1377)。⚠ 絞りが掛かったままだと、移った先で
       *   ノートの行が**絞られて表に無い**(押したのに何も選ばれない)。絞りは `DUAL_SET_FILTER ''` で解ける
       *   (ペインの「名前で絞る」欄と同じ 1 本)。場所へ移る枝は今までどおり触らない。
       */
      dispatcher.dispatch({ type: 'DUAL_SET_FILTER', side, filter: '' });
      /**
       * 🔴 **アプリ共通の探す語も解く**(#1087)。ペインの絞りは `paneFilterOptions` が
       *   「ペインが空なら共通の語に従う」ので、共通の語が残っていると行が表に出ない。
       *   左の列の「作る」(`CREATE_ENTRY`)と同じ作法で `SET_ENTRY_FILTER` を使う。
       * ⚠ 種類の札は解かない ── 2 ペインは札を見ない(台帳 #1852 N1 / 依頼 323 A。`dualListViewOptions`)ので、左の列の札を勝手に外す理由が無い。
       */
      dispatcher.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
      dispatcher.dispatch({ type: 'DUAL_SET_SCOPE', side, lid: parent });
      dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid, mode: 'set' });
      return;
    }
    dispatcher.dispatch({ type: 'DUAL_SET_SCOPE', side, lid });
  },
  /**
   * 🔴 **ノートをブックマークに入れる / 外す**(#1377)。⚠ 右クリックの対(置けるなら外せる)。
   * ⚠ 相手は**メニューを開いた瞬間のノート**(`rowLidOrSelected`)── 選択ではない。
   * ⚠ 満杯なら**理由を声に出して断る**(押しても増えない理由が見えないと壊れて見える)。
   *   数えるのは**このコレクションの生きているもの**だけ ── 消えたノート・別のコレクションの
   *   ノートは保存に残っていても数えない(保存の総数だけは別の上限で止める)。
   */
  'bookmark-note-add': (dispatcher, target, services) => {
    const st = dispatcher.getState();
    const lid = rowLidOrSelected(st, target);
    if (lid === null || st.cid === null || !st.entryMetas.has(lid)) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'ノートが見つかりません' });
      return;
    }
    const key = noteBookmarkKey(st.cid, lid);
    const stored = appDualPrefs.getBookmarks();
    const why = bookmarkRefusal(
      stored,
      liveBookmarks(stored, st.cid, (l) => st.entryMetas.has(l)),
      key,
    );
    if (why !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: why });
      return;
    }
    services.toggleDualBookmark?.(key);
  },
  'bookmark-note-remove': (dispatcher, target, services) => {
    const st = dispatcher.getState();
    const lid = rowLidOrSelected(st, target);
    if (lid === null || st.cid === null) return;
    services.toggleDualBookmark?.(noteBookmarkKey(st.cid, lid));
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
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}コピーしてください` });
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
        error: 'コピーするものを選んでください(行を押すと選べます)',
      });
      return;
    }
    const read = services.readBodies;
    if (!read) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'このタブの PKC3 が古いままのため、コピーできません。再読み込みしてください' });
      return;
    }
    const to = otherSide(side);
    const refusedPlace = notPlaceable(st, paneScope(paneOf(st.dual, to)));
    if (refusedPlace !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: refusedPlace });
      return;
    }
    /**
     * 🔴 **行き先に同じ題名のノートが既にあるか**(Gemini 裁定 = #1163 への依頼 62 の 5)── 数えるのは選んだ物(中身は数えない)。
     * ⚠ 止めない(知らせに添えるだけ)。行き先の絞り込みで隠れている物も数える(見えていなくても在る)。
     */
    const toScopeLid = paneScope(paneOf(st.dual, to));
    const existing = new Set(
      (toScopeLid === null
        ? getRootEntries(st.entryMetas, st.relations)
        : getStructuralChildren(toScopeLid, st.entryMetas, st.relations)
      ).map((m) => m.title),
    );
    const steps = planCopy(
      lids,
      paneScope(paneOf(st.dual, to)),
      st.entryMetas,
      st.relations,
      generateLid,
    );
    // ⚠ 数えるのは**できあがる題名**(同じ場所へのコピーは「のコピー」が付くので、ぶつからない)
    const picked = new Set(lids);
    const sameTitle = steps.filter((x) => picked.has(x.sourceLid) && existing.has(x.title)).length;
    // 🔴 **読む前に、保存の書込が並んでいれば待つ**(#1087)。待たずに読むと、書込が disk に届く前の古い本文で
    //    コピーが作られる(他の読み ── 本文を disk から読む口 ── は待っている。同じ作法に揃える)。
    void Promise.resolve(services.settle?.() ?? null)
      .then(() => read(steps.map((s) => s.sourceLid)))
      .then(
      (bodies) => {
        let missing = 0;
        /**
         * 🔴 **一緒にコピーしたノートへのリンクは、コピー先へ付け替える**(台帳 #1852 N1 / 依頼 115-5 A。Gemini 回答 = 推薦どおり)。
         * ⚠ 直す前は、フォルダごとコピーしても中のノート同士のリンクが**元のノートを指したまま**で、リンクを押すと元が開き、
         *   元を消すとコピー側のリンクが切れた。コピーしなかったノートへのリンクは元のまま(付け替えは写した組の中だけ)。
         * 🔑 書き換えは取り込みと同じ 1 本(`remapEntryLids`)── `entry:<lid>` の lid の部分だけを写す。
         */
        const copied = new Map(steps.map((x) => [x.sourceLid, x.lid] as const));
        for (const step of steps) {
          const raw = bodies.get(step.sourceLid);
          if (raw === undefined) missing += 1;
          const body = raw === undefined ? undefined : remapEntryLids(raw, copied);
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
        /**
         * 🔴 **作れたかを見てから言う**(#1087)。編集中は `CREATE_ENTRY` が黙って捨てられる
         *   (`app-state.ts`。コピーの読み待ちの間に編集へ入った場合)ので、dispatch の後に
         *   実在を数える ── 作れていないのに「コピーしました」と言わない。
         */
        const madeCount = steps.filter((x) => dispatcher.getState().entryMetas.has(x.lid)).length;
        if (madeCount < steps.length) {
          const phase = dispatcher.getState().phase;
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error:
              phase === 'ready'
                ? 'コピーできませんでした(ノートを作れませんでした)'
                : `${phaseBlockReason(phase)}コピーしてください`,
          });
          return;
        }
        /**
         * 🔴 **行き先を名乗る**(#671 の着地前の動線レビュー A、2026-09-04)。
         *
         * ⚠ 直す前は「N 件を写しました」だけで、**どこへ行ったか 1 文字も
         *   出ていなかった** ── 隣の「移す」は
         *   「N 件を『◯◯』へ移しました」と名乗っている(上の `moveEntries`)。
         *   **隣り合う 2 つのボタンで扱いが違った。**
         * 🔴 スマホでは相手のペインが**画面に居ない**ので、ここが唯一の
         *   手がかりである ── 見えない場所へ物が飛び、飛んだ先の名前も
         *   出ないと、探しに行けない。
         * ⚠ 呼び名の作り方は `moveEntries` と**同じ規則**にする(2 か所で
         *   別々の綴りを作らない ── CLAUDE.md §7)。
         */
        const toScope = paneScope(paneOf(st.dual, to));
        const where =
          toScope === null
            ? 'ルート'
            : (dispatcher.getState().entryMetas.get(toScope)?.title ?? 'フォルダ');
        /**
         * 🔴 **成功はエラーの行に出さない / 件数は選んだ数で言う / 印を外す**(#1087 の見直し 2026-10-13)。
         * ⚠ 直す前は成功も `OP_FAILED` で出していたので、「エラー: 3 件を…へコピーしました」と出て、メッセージには「問題」で
         *   積まれていた(隣の「移す」は普通の知らせ)。件数は中身まで数えた数で、選んだ数と合わなかった。印も残ったままで、
         *   もう一度押すと同じ物がもう 1 組できた(「移す」は成功したら外す)。
         * ⚠ 本文を読めなかった分があるときだけは、問題として残す(空で作った物がある)。
         */
        const count = lids.length;
        const head =
          steps.length > count
            ? `${count} 件(中身を含め ${steps.length} 件)を「${where}」へコピーしました`
            : `${count} 件を「${where}」へコピーしました`;
        const notes = [
          ...(sameTitle > 0 ? [`うち ${String(sameTitle)} 件は、同じ題名のノートが既にあります`] : []),
          ...(missing > 0 ? [`うち ${String(missing)} 件は本文を読めず、空で作りました`] : []),
        ];
        const said = notes.length > 0 ? `${head}(${notes.join(' / ')})` : head;
        if (missing > 0) {
          dispatcher.dispatch({ type: 'OP_FAILED', error: said });
        } else {
          /**
           * 🔴 **コピーの後にも「元に戻す」を出す**(台帳 #1852 N1 / 依頼 97-5 A)── 「移す」と同じ作法。押すと作った複製をゴミ箱へ入れる
           *   (`undo-dual-move`)。⚠ 出すのは**作れた複製の lid**(中身を含めた全部)。
           */
          offerDualCopyUndo(
            dispatcher,
            steps.map((x) => x.lid),
            said,
          );
        }
        dispatcher.dispatch({ type: 'DUAL_CLEAR_SELECTION', side });
      },
      () => dispatcher.dispatch({ type: 'OP_FAILED', error: 'コピーできませんでした(本文を読めません)' }),
    );
  },
  /** ⚠ 鍵(`Delete`)と**同じ実体**を押しボタンからも呼ぶ(規則を 2 つ作らない)。 */
  'dual-delete': (dispatcher, target, services, root) => {
    const side = dualSide(target) ?? dispatcher.getState().dual.focus;
    const st = dispatcher.getState();
    const rows = dualPaneRows(st, side);
    const cursor = paneOf(st.dual, side).cursor;
    deleteFrom(dispatcher, services, root, rows, paneOf(st.dual, side).selection, cursor, () => {
      keepDualCursorUnlessMoved(dispatcher, side, rows, cursor);
    });
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
  'dual-move': (dispatcher, target, services) => {
    const st = dispatcher.getState();
    // 🔴 押した所のペインを先に見る(#1087)── `dual-copy` と同じ。焦点だけだと、右のボタンに Tab で焦点を置いて押したとき F5 と F6 で向きが逆になる
    const from = dualSide(target) ?? st.dual.focus;
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
    const refusedPlace = notPlaceable(st, to);
    if (refusedPlace !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: refusedPlace });
      return;
    }
    /**
     * 🔴 **動いた回だけ印を外す**(着地前レビュー R1)。
     * ⚠ `moveEntries` は編集中・全件拒否で**何もせず返る**ので、無条件に外すと
     *   **1 件も動いていないのに 30 件の印が消える** ── user は断りを読んで
     *   保存してから戻り、**選び直し**になる(この面は編集中でも開ける設計なので
     *   必ず踏む筋である)。
     * 🔑 印は「移した結果」に付いていく物であって、**押した事実**に付く物ではない。
     * 🔴 「元に戻す」の出し入れは `moveEntriesOfferingUndo`(移す口 4 つで 1 本)。
     */
    if (moveEntriesOfferingUndo(dispatcher, lids, to, services.showStatus)) {
      /**
       * 🔴 **移した先で、動いてきた行を選んだままにする**(Gemini 裁定 = #1163 の依頼 34 の Q5、#1626)。
       * ⚠ 直す前は元の側の印を外すだけで、移した先には何も選ばれておらず、どの行が動いてきたか分からなかった。
       * 🔑 選ぶのは**いま行き先の親になった物だけ**(断られた・付いていっただけの行は選ばない)。
       *   焦点は動かさない(`DUAL_SELECT_MANY`)。
       */
      const after = dispatcher.getState();
      const parentsNow = resolveCanonicalParents(after.entryMetas, after.relations);
      const arrived = lids.filter((lid) => (parentsNow.get(lid) ?? null) === to);
      // 🔴 1 回の dispatch で置く(数百件を 1 件ずつ撃つと、件数ぶん描き直しが走って画面が固まる)
      if (arrived.length > 0) dispatcher.dispatch({ type: 'DUAL_SELECT_MANY', side: otherSide(from), lids: arrived });
      dispatcher.dispatch({ type: 'DUAL_CLEAR_SELECTION', side: from });
      // 移した行は元のペインから消える ── カーソルは入れ替わりに来た行へ(消した後と同じ規則)
      keepDualCursorAfter(dispatcher, from, rows, pane.cursor);
    }
  },
  /**
   * 🔴 **移した直後の「元に戻す」**(Gemini 裁定 = #1163 への依頼 62 の 4)。口は `status-undo`(出し入れは `status-open.ts`)。
   * ⚠ 新しい書込経路は作らない ── 動く前の親へ向けた `SET_ENTRY_PARENT` を 1 件ずつ撃つ。
   *   移した後に別の場所へ動かした物は戻さない。編集中などで戻せないときは**黙らない**(`undo-trash` と同じ断り)。
   */
  'undo-dual-move': (dispatcher) => {
    const phase = dispatcher.getState().phase;
    if (phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(phase)}戻してください` });
      return;
    }
    const taken = takeDualUndo();
    if (taken === null) return;
    /**
     * 🔴 **コピーした直後の「元に戻す」は、作った複製をゴミ箱へ入れる**(台帳 #1852 N1 / 依頼 97-5 A。Gemini 回答 = 推薦どおり)。
     * ⚠ 直す前は「移す」の後にだけ出て、「コピー」の後には出なかった ── 押し間違えると、作られた複製を自分で探してゴミ箱へ入れることになった。
     * 新しい書込経路は作らない(`DELETE_ENTRIES`)。複製はゴミ箱から戻せる。
     */
    if (taken.created.length > 0) {
      const st = dispatcher.getState();
      const lids = taken.created.filter((l) => st.entryMetas.has(l));
      if (lids.length === 0) {
        dispatcher.dispatch({ type: 'OP_NOTICE', message: '戻せるものがありません(コピーした物がもうありません)' });
        return;
      }
      dispatcher.dispatch({ type: 'DELETE_ENTRIES', lids });
      const gone = lids.filter((l) => !dispatcher.getState().entryMetas.has(l)).length;
      dispatcher.dispatch({
        type: 'OP_NOTICE',
        message:
          gone > 0
            ? `コピーした ${String(gone)} 件をゴミ箱へ入れました(ゴミ箱から戻せます)`
            : '戻せませんでした(コピーした物をゴミ箱へ入れられませんでした)',
      });
      return;
    }
    const moves = taken.moves;
    const st = dispatcher.getState();
    const parents = resolveCanonicalParents(st.entryMetas, st.relations);
    let back = 0;
    // 🔴 元のフォルダが無くなっていて、いちばん上の階層へ戻した件数(台帳 #1852 N1 / 依頼 155 ②。直す前は「元の場所に戻しました」と言っていたが、実際は元の場所ではなかった)
    let toRoot = 0;
    for (const m of moves) {
      if (!st.entryMetas.has(m.lid)) continue;
      if ((parents.get(m.lid) ?? null) !== m.to) continue;
      // 元のフォルダがもう無ければルートへ戻す(居ない親へは入れられない)
      /**
       * 🔴 **入っていたフォルダ全部へ戻す**(台帳 #1852 G1 / 依頼 227 A)── 2 つ以上に入っていたノートは、まだ居るフォルダ全部へ。
       *   1 本目(正準の親)が居なければ、居る中の先頭を 1 本目にする(全部居なければルート)。
       */
      const homes = (m.fromAll ?? (m.from !== null ? [m.from] : [])).filter((f) => st.entryMetas.has(f));
      const first = m.from !== null && homes.includes(m.from) ? m.from : (homes[0] ?? null);
      const parentLid = first;
      const also = homes.filter((f) => f !== first).map((f) => ({ parentLid: f, relationId: generateLid() }));
      const before = dispatcher.getState().relations;
      dispatcher.dispatch({
        type: 'SET_ENTRY_PARENT',
        lid: m.lid,
        parentLid,
        relationId: generateLid(),
        ...(also.length > 0 ? { alsoIn: also } : {}),
      });
      // 🔴 実際に動いた分だけ数える(#1087)── 元の場所がその後このノートの中へ入っていると、輪になるので断られる
      if (dispatcher.getState().relations !== before) {
        back += 1;
        if (m.from !== null && parentLid === null) toRoot += 1;
        // 🔴 移す前の並びの位置へ戻す(依頼 154 ②)。⚠ ほかの物の値は動いていないので、この 1 件の値を戻すだけで元の位置になる
        if (m.entryOrder !== undefined)
          dispatcher.dispatch({ type: 'SET_ENTRY_ORDER', lid: m.lid, entryOrder: m.entryOrder });
      }
    }
    dispatcher.dispatch({
      type: 'OP_NOTICE',
      message:
        back === 0
          ? '戻せるものがありません(移した後に、別の場所へ動かしています)'
          : toRoot === 0
            ? `${String(back)} 件を元の場所に戻しました`
            : toRoot === back
              ? `元のフォルダが無いので、${String(back)} 件をいちばん上の階層に戻しました`
              : `${String(back)} 件を戻しました(うち ${String(toRoot)} 件は元のフォルダが無いので、いちばん上の階層に戻しました)`,
    });
  },
  /**
   * 🔴 **まとめてタグを付けた直後の「元に戻す」**(台帳 #1852 G1 / 依頼 109 A)。口は `status-undo`(出し入れは `status-open.ts`)。
   * ⚠ 新しい書込経路は作らない ── `BULK_TAG`(外す)を、**今回付けたノートだけ**に撃つ(もとから付いていたノートは触らない)。
   *   別のタブが編集中のノートがあれば、タグ付けと同じ門で止める。編集中などで戻せないときは**黙らない**(`undo-trash` と同じ断り)。
   */
  'undo-bulk-tag': (dispatcher, _target, services) => {
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}戻してください` });
      return;
    }
    const groups = (st.tagUndo?.groups ?? [])
      .map((g) => ({ tags: g.tags, lids: g.lids.filter((l) => st.entryMetas.has(l)) }))
      .filter((g) => g.lids.length > 0);
    if (groups.length === 0) {
      dispatcher.dispatch({ type: 'OP_NOTICE', message: '戻せるものがありません(付けたノートがもうありません)' });
      return;
    }
    const all = [...new Set(groups.flatMap((g) => g.lids))];
    actUnlessEditedElsewhere(
      dispatcher,
      services,
      all,
      'タグを外せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
      () => {
        for (const g of groups) dispatcher.dispatch({ type: 'BULK_TAG', lids: g.lids, tags: g.tags, mode: 'remove' });
      },
    );
  },
  /**
   * 🔴 **題名を変えた直後の「元に戻す」**(Gemini 裁定 = #1163 への依頼 45 の 2、#1657)。口は `status-undo`(出し入れは `status-open.ts`)。
   * ⚠ 新しい書込経路は作らない ── 変える前の題名へ向けた `RENAME_ENTRY_TITLE` を 1 手撃つ(添付はファイル名も揃える)。
   *   変えた後にさらに題名を変えていたら戻さず、理由を言う。編集中などで戻せないときは**黙らない**(`undo-trash` と同じ断り)。
   */
  'undo-rename': (dispatcher) => {
    const phase = dispatcher.getState().phase;
    if (phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(phase)}戻してください` });
      return;
    }
    const r = takeRenameUndo();
    if (r === null) return;
    if (dispatcher.getState().entryMetas.get(r.lid)?.title !== r.to) {
      dispatcher.dispatch({
        type: 'OP_NOTICE',
        message: '戻せるものがありません(変えた後に、題名をもう一度変えています)',
      });
      return;
    }
    restoreRenamedTitle(dispatcher, r.lid, r.from, r.withFile);
    dispatcher.dispatch({ type: 'OP_NOTICE', message: `題名を「${r.from}」に戻しました` });
  },
  /**
   * 🔴 **ノートの種類を変える**(台帳 #1852 I2 / 依頼 157。Gemini 回答 = 推薦 ②)。ノート ⇄ ログだけ。
   *
   * 押すと**確認が先に出る**(画面で何が変わるかを言う ── 本文はそのまま・追記の足し方が変わる・もう一度押せば戻る)。
   * ⚠ 書込は `SET_ENTRY_ARCHETYPE` 1 本(reducer が組を検める)── ここは押した行を引いて聞くだけ。
   * ⚠ 編集中などで変えられないときは**黙らない**(`undo-trash` と同じ断り)。
   */
  'change-entry-kind': (dispatcher, target, _services, root) => {
    const st = dispatcher.getState();
    const lid = rowLidOrSelected(st, target);
    const meta = lid === null ? undefined : st.entryMetas.get(lid);
    if (lid === null || meta === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '種類を変えるノートを選んでください(行を押すと選べます)' });
      return;
    }
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}種類を変えてください` });
      return;
    }
    const to = kindChangeTarget(meta.archetype);
    if (to === null) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `「${archetypeLabel(meta.archetype)}」の種類は変えられません(変えられるのはノートとログです)`,
      });
      return;
    }
    void confirmInApp(root, kindChangeQuestion(meta.title, meta.archetype, to), {
      okLabel: `「${archetypeLabel(to)}」に変える`,
      cancelLabel: 'やめる',
    }).then((answer) => {
      if (answer !== 'ok') return;
      dispatcher.dispatch({ type: 'SET_ENTRY_ARCHETYPE', lid, archetype: to });
    });
  },
  'delete-entry': (dispatcher, target, services, root) => {
    // ⚠ 実行中(書出し / 取込)のガードは `refuseWhileBusy` が 1 本で持つ
    // 🔴 **無言で断らない**(P8 段⑲)。`DELETE_ENTRY` は `phase !== 'ready'` で
    //    何も返さないので、直す前は**確認ダイアログまで出してから黙って捨てて**いた
    //    ── user は消したつもりで画面を離れる。detail.ts が確立した
    //    「無言の操作拒否を作らない」に揃える。⚠ confirm より**前**に断る
    const phase = dispatcher.getState().phase;
    if (phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `${phaseBlockReason(phase)}ゴミ箱へ移してください`,
      });
      return;
    }
    /**
     * 🔴 **解決規則は `rowLidOrSelected` の 1 本**(#877)── 属性はボタン自身では
     *   なく「entry を表す要素」(行 / カード)から closest で引き、それも無ければ
     *   **メニューを開いた瞬間の lid**(`MENU_LID_ATTR`)、最後に選んでいるノート。
     *   ⚠ 直す前は closest → `selectedLid` の 2 段しか無く、メニューが開いたまま
     *   `selectedLid` が動くと**別のノート**を消せた(行のメニューは行の中に
     *   居ないので closest が必ず外れ、常に `selectedLid` へ落ちていた)。
     */
    const lid = rowLidOrSelected(dispatcher.getState(), target);
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
    /**
     * 🔴 **確認は出さない。移したあとに「元に戻す」を出す**(#1087 流れ 29。Gemini 裁定 = #1163 への
     *   依頼 29 の回答 Q3)。ゴミ箱へ移すのは戻せる操作なので、毎回の確認は手数だけを増やしていた。
     *   画面の下に「『題名』をゴミ箱へ移しました」と **元に戻す** を数秒出す(`trash-undo.ts`)。
     * ⚠ 上の `phase` の断りは、確認より前ではなく**実行より前**に残している(無言の拒否を作らない)。
     */
    if (!dispatcher.getState().entryMetas.has(lid)) return;
    /**
     * 🔴 **別のタブ・窓が編集中のノートは、ゴミ箱へ移さない**(#1087。追記と同じ門 = `editedElsewhereReason`)。
     * ⚠ 通すと、編集中のタブが保存したときに行が作り直され、ゴミ箱から消えて一覧に戻る(移したつもりで残る)。
     */
    // 🔴 2 ペインの行のメニューから来たとき(側を運んでいる)は、消した後にカーソルと焦点を隣の行へ立てる(#1087 D1)。
    //   立てないと印が 1 つも無いまま焦点が body へ落ち、続けて ↓ / Delete が効かない(鍵の Delete と同じ後始末)。
    const dualSideOfRow = dualSide(target);
    const dualRowsBefore = dualSideOfRow !== null ? dualPaneRows(dispatcher.getState(), dualSideOfRow) : [];
    const dualCursorBefore =
      dualSideOfRow !== null ? paneOf(dispatcher.getState().dual, dualSideOfRow).cursor : null;
    refuseTrashEditedElsewhere(dispatcher, services, [lid], () => {
      const before = dispatcher.getState();
      dispatcher.dispatch({ type: 'DELETE_ENTRY', lid });
      const after = dispatcher.getState();
      if (!after.entryMetas.has(lid))
        offerTrashUndo(
          dispatcher,
          [{ lid, title, order: before.entryMetas.get(lid)?.entryOrder }],
          leftAtRoot(before, after),
          linkedFromText(before, after, lid),
          dualFellBackText(before, after),
        );
      if (dualSideOfRow !== null) {
        const next = keepDualCursorUnlessMoved(dispatcher, dualSideOfRow, dualRowsBefore, dualCursorBefore);
        if (next !== null)
          root
            .querySelector<HTMLElement>(
              `[data-pkc-region="dual-pane"][data-pkc-side="${dualSideOfRow}"] [data-pkc-action="dual-row"][data-pkc-entry="${next}"]`,
            )
            ?.focus();
      }
    });
  },
  /**
   * 🔴 **囲みのコピー ── ⧉ は 1 押し、▾ は形を選ぶ**(#708 段①)。
   *
   * ⚠ **同じ action 名で 2 つの口**を受ける ── 名前を分けると、binder の居ない面
   *   (書き出した HTML / マニュアルの窓)が `copy-md-block` **だけ**を取り除くので、
   *   ▾ が沈黙する飾りとして焼き込まれる(`markdown-render.ts` の註記)。
   * 🔴 **落とす file の名前は「押した表が載っているノート」の題名**(2026-09-05、
   *   動線レビュー 欠陥 1)。⚠ 直す前は `selectedLid` を直に読んでいたので、
   *   **横に留めた枠の表から保存すると、本文(左)のノートの題名**が付いた
   *   (#281 で 1 度直した罠の再発 ── 留めた枠は `data-pkc-entry` ではなく
   *   `data-pkc-split-lid` を焼く)。引き方は `lidOfNode` 1 本。
   * ⚠ 器(`safeName`)は書き出し系と同じ 1 本。
   */
  'copy-md-block': (dispatcher, target, services, root) =>
    handleCopyMdBlock(target, {
      pick: (choices) => pickCopyFormatInApp(root, choices),
      /**
       * 🔴 **指で触る端末に、表の形を変える入口を作る**(#708 裁定②、user 2026-09-06)。
       *
       * ⚠ 右クリックが無い端末では、直す前は**形を変える口が 1 つも無かった**。
       * ⚠ **判定は右クリックと同じ `tableAt`** ── DOM の class で見分けると
       *   書き換える側と別の答えを持つ口が 2 つになる(§7)。
       * 🔑 `null` を返すのは「**そもそも作り変えられない表**」だけ
       *   (閉じていない囲み / ` ```csv-norender ` …)── 押しても何も起きない行を
       *   作らない。⚠ **`:::` の板の中と引用の中は出す**(#743。user 裁定 2026-09-07)。
       *   ⚠ 式が入っている等の「**理由を言って断る**」形は行を出す
       *   (user 裁定 2026-09-04「黙って断らない」)。
       */
      convert: () => {
        const st = dispatcher.getState();
        const ob = st.openBody;
        /**
         * 🔴 **押した所の持ち主が「開いている本文」でなければ、出さない**
         * (着地前レビュー・実装 R1、2026-09-06。**実ブラウザで再現**した)。
         *
         * ⚠ 下の `noteTitle` は `lidOfNode` を通しているのに、**隣に足したこの口だけ
         *   通っていなかった** ── `tableLineAt` も `tableAt` も `ob.body`
         *   (= **主の枠**の本文)を読むので、**留めた枠**(`data-pkc-split-lid`)の
         *   表で押すと、**押した物ではなく主の枠のノート**が書き換わる。
         *   ⚠ 画面では留めた枠が変わらないので、user は自分の操作を疑わない
         *   (押した物と壊れた物が別 ── いちばん気づけない形)。
         * 🔑 右クリックは留めた枠では開かないので、**出さないほうが釣り合う**
         *   (`refuseStaleMenu` に当たる門が ▾ 側には無い、の穴も同時に塞がる)。
         * ⚠ ⧉ のコピーは DOM から読むので**留めた枠でも今までどおり効く** ──
         *   消えるのは「本文を書き換える」1 行だけである。
         */
        if (ob === null || lidOfNode(target, ob.lid) !== ob.lid) return null;
        const line = tableLineAt(target, ob.body);
        const at = line === null ? null : tableAt(ob.body, line);
        if (at === null || line === null) return null;
        const to: TableFormat = at.format === 'markdown' ? 'csv' : 'markdown';
        return {
          label: tableConvertPickLabel(at.format),
          run: () => applyTableFormat(dispatcher, services, line, to),
        };
      },
      /**
       * 🔴 **csv の表の 1 行目を、見出しにする / やめる**(#1662 3)。⚠ 出す条件は `convert` と同じ門
       *   (主の枠の表だけ)+ **csv の囲みだけ**(markdown の表の見出しは形の一部で、切り替えられない)。
       */
      header: () => {
        const ob = dispatcher.getState().openBody;
        if (ob === null || lidOfNode(target, ob.lid) !== ob.lid) return null;
        const line = tableLineAt(target, ob.body);
        const at = line === null ? null : tableAt(ob.body, line);
        if (at === null || line === null || at.format !== 'csv') return null;
        const on = at.rows[0]?.head !== true;
        return {
          label: tableHeaderPickLabel(on),
          run: () => applyTableFormat(dispatcher, services, line, 'csv', on),
        };
      },
      download: downloadBlob,
      noteTitle: () => {
        const st = dispatcher.getState();
        const lid = lidOfNode(target, st.openBody?.lid ?? st.selectedLid);
        return lid === null ? '' : (st.entryMetas.get(lid)?.title ?? '');
      },
      fail: (error) => dispatcher.dispatch({ type: 'OP_FAILED', error }),
      saved: (message) => dispatcher.dispatch({ type: 'OP_NOTICE', message }),
    }),
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
  'insert-date': (_dispatcher, _target, services, root) => {
    const opened = formatTarget(root);
    if (opened === null) {
      sayNoFormatTarget(services);
      return;
    }
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
  'insert-entry-link': (dispatcher, _target, services, root) => {
    const opened = formatTarget(root);
    if (opened === null) {
      sayNoFormatTarget(services);
      return;
    }
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
      const meta = dispatcher.getState().entryMetas.get(lid);
      /**
       * 🔴 **選んでいる間に相手がゴミ箱へ移ったら、挿さずに理由を言う**。
       * ⚠ 直す前は題名を `''` にして `[](entry:…)` を挿していた ── 画面には題名の無い
       *   リンクが出て、押すと「見つかりません」になる(挿した本人は気づけない)。
       */
      if (meta === undefined) {
        dispatcher.dispatch({ type: 'OP_FAILED', error: 'ノートが見つかりません' });
        return;
      }
      const title = meta.title;
      ta.focus();
      // ⚠ 範囲外は `setSelectionRange` が丸める(短くなっていても落ちない)
      ta.setSelectionRange(at.start, at.end);
      insertText(ta, formatEntryLink(title, lid));
    });
  },
  /**
   * 🔴 **添付を本文に入れる**(#1640 ④。依頼 37 = A)。
   *
   * 🔑 作りは `insert-entry-link` と同じ(caret を先に控える / 選ぶ間は引き直す / 挿すのは `insertText` で `Ctrl+Z` で戻せる)。
   *   違いは 2 つ:①候補は**添付のノートだけ** ②挿すのは `[題名](entry:…)` ではなく**添付そのものの 1 行**
   *   (画像は `![名前](asset:…)`、ほかはリンク。組み立ては「参照をコピー」と同じ `formatAssetRef` 1 本)。
   * ⚠ 添付の key とファイル名・種類は**本文の frontmatter** にしか無い ── 選んだ後に `readBodies` で読む。
   *   読めなかった / key が無いときは黙らず理由を出す。
   */
  'insert-attachment': (dispatcher, _target, services, root) => {
    const opened = formatTarget(root);
    if (opened === null) {
      sayNoFormatTarget(services);
      return;
    }
    const at = { start: opened.selectionStart, end: opened.selectionEnd };
    void pickEntryInApp(root, (query) => {
      const st = dispatcher.getState();
      const only = new Map([...st.entryMetas].filter(([, m]) => m.archetype === 'attachment'));
      const items = entryPickRows(only, st.order, query, null);
      const total = entryPickTotal(only, st.order, query, null);
      return {
        items,
        note: total === 0 ? '該当する添付がありません(題名で探しています)' : entryPickNote(items.length, total),
      };
    }).then(async (lid) => {
      if (lid === null) return;
      const body = (await services.readBodies?.([lid]))?.get(lid);
      const meta = body === undefined ? null : readAttachmentMeta(body);
      if (meta === null || meta.assetKey === null || meta.assetKey === '') {
        dispatcher.dispatch({ type: 'OP_FAILED', error: '添付を読めませんでした(もう一度お試しください)' });
        return;
      }
      // ⚠ 欄は引き直す(待つ間に面が組み直されると、最初の節点は繋がっていない)
      const ta = formatTarget(root);
      if (ta === null) return;
      ta.focus();
      ta.setSelectionRange(at.start, at.end);
      insertText(ta, formatAssetRef(meta.name || '', `asset:${meta.assetKey}`, isImageAssetMime(meta.mime)));
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
  'insert-snippet': (dispatcher, _target, services, root) => {
    const opened = formatTarget(root);
    if (opened === null) {
      sayNoFormatTarget(services);
      return;
    }
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
        writeBack(ta, applyFormatSaying(sel, picked.op, (t) => services.showStatus?.(t)));
        return;
      }
      /**
       * 🔴 **UML の雛形**(#528 段①)。⚠ ここでも**組み立てない** ── 表から
       *   雛形を引いて、挿すのは既にある `insertBlock` に渡す(上の注記と同じ理由)。
       * ⚠ 表から消えた id は**黙って落とす**(組み込みの `FormatOp` と同じ作法)──
       *   無い物を挿そうとして欄を空で書き戻すほうが悪い。
       */
      if (picked.kind === 'diagram') {
        const tpl = DIAGRAM_TEMPLATES.find((d) => d.id === picked.id);
        if (tpl !== undefined) writeBack(ta, insertBlock(sel, tpl.block));
        return;
      }
      const item = items.find((s) => s.lid === picked.lid);
      if (item === undefined) return;
      writeBack(ta, insertSnippet(sel, item.body, new Date(), { breakLines: true }));
    });
  },
  /**
   * 🔴 **図を入れる ── 押すと 5 種から選ぶ**(#528 案 B。user 裁定 2026-09-04)。
   *
   * ⚠ 直す前の「図」は `format-text`(`op: 'mermaid'`)で、**必ず `graph TD` が入った**
   *   ── UML の雛形は在るのに、「図」を押した人はそこへ辿り着けなかった。
   * ⚠ 作りは `insert-snippet` と同じ ── **caret を先に控え**、器(`pickDiagramInApp`)が
   *   返ってから**欄を引き直し**、挿すのは既にある `insertBlock` に渡す(ここで組み立てない)。
   * ⚠ 何が並ぶかは `DIAGRAM_CHOICES`(表が正本)── 表から消えた id は**黙って落とす**
   *   (無い物を挿そうとして欄を空で書き戻すほうが悪い)。
   *
   * 🔴 **#950: 選んでいるときは、先に聞かず ```mermaid で囲む。**
   *
   * ⚠ 5 種の一覧は「**空の枠から選んで始める**」ための入口であって、
   *   **既に打った図の下書きを選んで押した人**には無関係の問い(「どの種類?」)
   *   になる ── その内容は既にどの種類か決まっている。⚠ 一覧を出したまま
   *   `insertBlock` を呼ぶと**選んだ字が消える**(#950 の穴そのもの)。
   * 🔑 だから**選択があるときは一覧を出さず**、共通の fence(すべての種類が
   *   同じ ` ```mermaid ` で始まる ── `tests/features/text-ops.test.ts`
   *   「5 つとも mermaid の囲みで始まる」)で直接囲む。
   * ⚠ **囲み方は `applyFormat(sel, 'mermaid')` に任せる**(`wrapAsBlock` を
   *   ここで直に呼ばない)── `text-ops.ts` 自身が「規則は 1 つ、binder は
   *   この関数を呼ぶ」と明記しているのに、ここで `wrapAsBlock` を直書きすると
   *   同じ判定が 2 か所に生える(CLAUDE.md §7。着地前レビュー ③)。
   */
  'insert-diagram': (_dispatcher, _target, services, root) => {
    const opened = formatTarget(root);
    if (opened === null) {
      sayNoFormatTarget(services);
      return;
    }
    if (opened.selectionStart !== opened.selectionEnd) {
      const sel = { text: opened.value, start: opened.selectionStart, end: opened.selectionEnd };
      writeBack(opened, applyFormat(sel, 'mermaid'));
      return;
    }
    const at = { start: opened.selectionStart, end: opened.selectionEnd };
    void pickDiagramInApp(
      root,
      DIAGRAM_CHOICES.map((d) => ({ id: d.id, label: d.label })),
    ).then((id) => {
      if (id === null) return;
      const tpl = DIAGRAM_CHOICES.find((d) => d.id === id);
      if (tpl === undefined) return;
      // ⚠ 欄は引き直す(開いている間に面が組み直されると、最初の節点は繋がっていない)
      const ta = formatTarget(root);
      if (ta === null) return;
      ta.focus();
      // ⚠ 範囲外は `setSelectionRange` が丸める(短くなっていても落ちない)
      ta.setSelectionRange(at.start, at.end);
      const sel = { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
      writeBack(ta, insertBlock(sel, tpl.block));
    });
  },
  /**
   * 🔴 **図案を本文に入れる**(#853 段①、2026-09-13)。
   *
   * > user 指示 2026-09-12:「**マテリアルデザインのアイコンはユーザーのメモ内でも
   * > 使用できるように動線を追加して欲しい**」
   *
   * ⚠ 作りは `insert-diagram` と同じ ── **caret を先に控え**、器が焦点を返した後に
   *   **欄を引き直して**から挿す(器は選択位置までは返さない ── `insert-date` の注記)。
   * ⚠ 入るのは**絵そのものではなく字**(`:home:`)── 保存も検索も原文のままなので、
   *   「home」で引ける(#853 の「検索に引っかかるか」)。
   */
  'insert-icon': (_dispatcher, _target, services, root) => {
    const opened = formatTarget(root);
    if (opened === null) {
      sayNoFormatTarget(services);
      return;
    }
    const at = { start: opened.selectionStart, end: opened.selectionEnd };
    void pickBodyIconInApp(root).then((name) => {
      // ⚠ 空文字は来ない(「なし」を出していない)が、来ても**何もしない**
      //    ── `::` という空の字を本文に入れない
      if (name === null || name === '') return;
      // ⚠ 欄は引き直す(開いている間に面が組み直されると、最初の節点は繋がっていない)
      const ta = formatTarget(root);
      if (ta === null) return;
      // ⚠ `execCommand('insertText')` は**焦点が要る**
      ta.focus();
      // ⚠ 範囲外は `setSelectionRange` が丸める(短くなっていても落ちない)
      ta.setSelectionRange(at.start, at.end);
      insertText(ta, iconShortcodeFor(name));
    });
  },
  'format-text': (_dispatcher, target, services, root) => {
    const op = target.getAttribute('data-pkc-format') as FormatOp | null;
    // ⚠ live の 1 面では活性の行(`row-source`)に効く(`formatTarget` の注記)
    const ta = formatTarget(root);
    if (!op) return;
    if (!ta) {
      sayNoFormatTarget(services);
      return;
    }
    writeBack(
      ta,
      applyFormatSaying(
        { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd },
        op,
        (t) => services.showStatus?.(t),
      ),
    );
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
  'undo-append': (dispatcher, _target, services) => {
    const lid = dispatcher.getState().lastAppend?.lid;
    if (lid === undefined) {
      dispatcher.dispatch({ type: 'UNDO_APPEND' });
      return;
    }
    // 🔴 別のタブ・窓が編集中のノートへは撃たない(#1087。`toggle-task` と同じ門。外す先は押した瞬間の追記のノート)
    actUnlessEditedElsewhere(
      dispatcher,
      services,
      [lid],
      '追記を元に戻せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
      // ⚠ 待っている間に別の追記へ替わっていたら、押していない追記を外さない
      () => {
        if (dispatcher.getState().lastAppend?.lid === lid) dispatcher.dispatch({ type: 'UNDO_APPEND' });
      },
    );
  },
  /**
   * 🔴 **直前の塊の移動を元に戻す**(#684 段①。「片道の操作を作らない」)。
   * ⚠ 口は状態の行の知らせの隣(`shell.ts` の `status-undo`)── 出し入れは `status-open.ts`。
   */
  'undo-move': (dispatcher) => {
    dispatcher.dispatch({ type: 'UNDO_MOVE' });
  },
  /**
   * 🔴 **ゴミ箱へ移した直後の「元に戻す」**(#1087 流れ 29)。口は `status-undo`(出し入れは `status-open.ts`)。
   * ⚠ 編集中などで戻せないときは**黙らない**(`restore-trash` と同じ断り)。
   */
  'undo-trash': (dispatcher) => {
    const phase = dispatcher.getState().phase;
    if (phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(phase)}戻してください` });
      return;
    }
    /**
     * 🔴 **断られるときは、持っている物を手放さない**(#1087、ゴミ箱の見直し)。章の欄が開いている間は
     *   reducer が断る(`UNDO_TRASH` → `sectionDraftBlockedResult`)── 直す前は先に手放してから撃ち、
     *   断られても「ゴミ箱から元に戻しました」を出していた(ノートはゴミ箱に残るのに、戻ったと読める。
     *   しかも「元に戻す」は消えている)。断りの字は reducer が出すので、ここは手放さずに撃つだけ。
     */
    if (dispatcher.getState().sectionDraft !== null) {
      const offer = currentTrashOffer();
      if (offer !== null)
        dispatcher.dispatch({ type: 'UNDO_TRASH', lids: offer.lids, orders: offer.orders });
      return;
    }
    const taken = takeTrashUndo();
    if (taken === null) return;
    // ⚠ 「戻しました」はここでは言わない ── 実際に戻ったとき(`ENTRY_RESTORED`)に reducer が言う
    //   (戻った先のフォルダの題名つき。ゴミ箱の一覧から戻したときと同じ字)
    dispatcher.dispatch({ type: 'UNDO_TRASH', lids: taken.lids, orders: taken.orders });
  },
  /**
   * 🔴 **予定を動かした直後の「元に戻す」**(#855。Gemini 裁定 = #1163 のコメント 6104130726 の 6)。
   * ⚠ 新しい書込経路は作らない ── 動かす前の姿へ向けた `SET_TASK_DATE` / `SET_ENTRY_DATE` を 1 手撃つ。
   *   動かした後に本文が変わっていたら戻さず、理由を言う(行番号の違う別の行を書き換えない)。
   *   口は画面の下の知らせの隣(`shell.ts` の `status-undo`。出し入れは `status-open.ts`)── `UNDO_MOVE`(塊の移動)とは別物。
   */
  'schedule-undo-move': (dispatcher, _target, services) => {
    const result = undoScheduleMove(dispatcher.getState());
    if (result === null) return;
    if ('refusal' in result) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: result.refusal });
      return;
    }
    // 🔴 別のタブ・窓が編集中のノートへは戻さない(#1087。落とす書込と同じ門)。戻す相手は押した瞬間に捕えてある
    const action = result.action;
    const lid = 'lid' in action && typeof action.lid === 'string' ? action.lid : '';
    actUnlessEditedElsewhere(
      dispatcher,
      services,
      lid === '' ? [] : [lid],
      '予定を戻せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
      () => dispatcher.dispatch(action),
    );
  },
  /**
   * 🔴 **最近開いた記録を消す**(#215 残り①)。口は設定の中。
   * ⚠ **画面にも反映する** ── store だけ消すと、いま「最近開いた順」で並べている
   *   一覧が**古い並びのまま**残る(消したのに効いていないように見える)。
   * ⚠ **消えたことを字で言う** ── 押しても何も変わらない画面(既に空のとき)で
   *   無言だと、押せていないのか消えたのか読めない。
   */
  'clear-opened-history': (dispatcher, _target, services) => {
    appOpenedStore.clear();
    dispatcher.dispatch({ type: 'SET_OPENED_AT', openedAt: new Map<string, number>() });
    services.showStatus?.('最近開いたノートの記録を消しました');
  },
  /**
   * 🔴 **検索した語の記録を消す**(#1172)。口は設定の「記録」の中。
   * ⚠ 候補(`<datalist>`)も入れ直す ── store だけ消すと、欄を開いたとき古い語が出る。
   * ⚠ 消えたことを字で言う(最近開いた記録を消すのと同じ)。
   */
  'clear-search-history': (_dispatcher, _target, services, root) => {
    appSearchHistory.clear();
    paintSearchHistory(root);
    services.showStatus?.('検索した語の記録を消しました');
  },
  /**
   * 🔴 **板の付箋の下端の「追記」**(#529 W5-a)── 押すと付箋の下に小さな欄が開く。
   * ⚠ 追記先は**押した付箋のノート**(ボタンの `data-pkc-entry`)── `selectedLid` は読まない
   *   (板では「選んでいるノート」と「付箋のノート」が別物)。書くのは `place-inline-commit` の 1 本。
   */
  'place-append-open': (dispatcher, target) => {
    const hit = placeBlockOf(target);
    const lid = target.getAttribute('data-pkc-entry') ?? '';
    if (hit === null || lid === '') return;
    const meta = dispatcher.getState().entryMetas.get(lid);
    if (meta === undefined || !isAppendable(meta.archetype)) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'このノートには追記できません(追記できるのはノートとログです)' });
      return;
    }
    openPlaceInline(hit.host, hit.block, 'append', lid, '');
  },
  /**
   * 🔴 **付箋の右クリック「題名を直す」**(#529 W5-b)── 付箋の上に題名の欄が開く。
   * 押した付箋は、メニューが運んだ `lid` と開き行の行番号(同じノートを 2 枚置いた回の取り違えを防ぐ)から引く。
   */
  'place-rename-open': (dispatcher, target, _services, root) => {
    if (refuseStaleMenu(dispatcher, target)) return;
    const lid = target.getAttribute('data-pkc-place-lid') ?? '';
    const line = target.getAttribute('data-pkc-place-line');
    const host = viewBodyHost(root);
    if (host === null || lid === '') return;
    const blocks = [...host.querySelectorAll<HTMLElement>('.pkc-place[data-pkc-place-entry]')].filter(
      (b) => b.getAttribute('data-pkc-place-entry') === lid,
    );
    const block = blocks.find((b) => b.getAttribute('data-pkc-place-line') === line) ?? blocks[0];
    const meta = dispatcher.getState().entryMetas.get(lid);
    if (block === undefined || meta === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '付箋のノートが見つかりません(消されたかもしれません)' });
      return;
    }
    openPlaceInline(host, block, 'rename', lid, meta.title);
  },
  'place-inline-commit': (dispatcher, target, services) => {
    void commitPlaceInline(dispatcher, services, target);
  },
  /** 欄を閉じる(字は捨てる ── 確定前なのでノートは 1 バイトも変わらない)。 */
  'place-inline-cancel': (_dispatcher, target) => {
    const host = target.closest<HTMLElement>('[data-pkc-field="detail-body"]');
    if (host === null) return;
    const lid = placeInlineOf(host)?.getAttribute('data-pkc-entry') ?? '';
    closePlaceInline(host);
    // 焦点を付箋の「追記」へ返す(キーボードで来た人が迷子にならない)
    for (const b of host.querySelectorAll<HTMLElement>('[data-pkc-field="place-append"]'))
      if (b.getAttribute('data-pkc-entry') === lid) {
        b.focus();
        break;
      }
  },
  'append-entry': (dispatcher, _target, services, root) => {
    const s = dispatcher.getState();
    const lid = s.selectedLid;
    const archetype = lid ? s.entryMetas.get(lid)?.archetype : undefined;
    if (!lid || !isAppendable(archetype)) return;
    const input = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]');
    const text = input?.value ?? '';
    const noteLid: string = lid;
    /**
     * 🔴 **空のまま押した回は、黙らずに言う**(#1087)。⚠ 直す前は reducer が黙って捨てたので、
     *   押しても何も起きない dead click だった。欄へ焦点を戻し、次にすることを出す
     *   (エラーではないので `OP_FAILED` には載せない ── 注意の知らせ)。
     */
    if (text.trim() === '') {
      input?.focus();
      services.showStatus?.('追記する内容を打ってから、もう一度押してください', CAUTION);
      return;
    }
    /**
     * 🔴 **追記先**(#395 段①)。空 = 末尾。⚠ 字・ノートと同じく**押した時点で読む**(問い合わせの間に
     *   ノートや選択が替わっても、押した物が撃たれる)。印をそのまま渡す ── 行番号に直さない
     *   (effect は disk から読み直すので、行番号は読み直した先で別の場所を指す)。
     */
    const target =
      root.querySelector<HTMLSelectElement>('[data-pkc-field="append-target"]')?.value ?? '';
    /**
     * 🔴 **別のタブ・窓が編集中のノートへは追記しない**(#529 W5-d。Gemini 裁定 Q5 = A)。
     * ⚠ 通すと編集中のタブの保存で上書きされ、足した字は履歴にだけ残る。**断って理由を出し、
     *   欄の字は残す**(撃たないので欄は消えない ── 欄を空にするのは書けたとき)。
     * 🔑 問い合わせは板の付箋の追記と**同じ 1 本**(`editedElsewhereReason`)。
     * ⚠ 字が空の回・口が無い環境・このタブが自分で編集中の回は**問い合わせずに従来どおり同期で撃つ**
     *   (空は reducer が断る。自分の錠は取り直すと手放す)。
     */
    if (text.trim() !== '' && !elsewhereCheckNotNeeded(dispatcher, services, lid)) {
      // ⚠ 問い合わせの間に 2 回押されても 1 回しか撃たない
      if (input?.hasAttribute('data-pkc-busy')) return;
      input?.setAttribute('data-pkc-busy', '');
      // ⚠ 問い合わせの間は欄を読み取り専用にする ── 先打ちした字が、成功の「欄を空にする」で
      //   黙って消えるのを防ぐ(撃つ字は押した時点の物なので、増えた字は撃たれない)
      const wasReadOnly = input?.readOnly ?? false;
      if (input) input.readOnly = true;
      void editedElsewhereReason(dispatcher, services, noteLid)
        .then((why) => {
          if (why !== null) {
            dispatcher.dispatch({ type: 'OP_FAILED', error: why });
            return;
          }
          sendAppend();
        })
        // 🔴 問い合わせが落ちても黙って捨てない(字は欄に残る)
        .catch((e: unknown) => {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            // 🔑 理由は残し(何が起きたかの手がかり)、次にすることを足す(#1087)
            error: `追記できませんでした(別のタブの編集を確かめられませんでした: ${errorText(e)})。欄の字は残っています。もう一度押してください`,
          });
        })
        .finally(() => {
          input?.removeAttribute('data-pkc-busy');
          if (input) input.readOnly = wasReadOnly;
        });
      return;
    }
    sendAppend();
    function sendAppend(): void {
    // ⚠ **空判定をここに持たない**(P8 段⑧ の変異試験で判明)── reducer が
    // 同じ判定を持っており、3 か所(binder / reducer / `appendBlock`)が互いに
    // 救い合って**どれ 1 つ消しても test が緑**だった。判定は下 2 つに寄せる:
    // reducer =「ロックも取らずに断る」、`appendBlock` =「本文を変えない」
    /**
     * 🔴 **追記先**(#395 段①)。空 = 末尾(これまでと同じ)。
     * ⚠ ここでは**印をそのまま渡す** ── 行番号に直さない。effect は disk から
     *   読み直すので、行番号は読み直した先で別の場所を指す。
     */
    /**
     * 🔑 **書いたものが見える所へ入るようにする**(#596 B)。
     *
     * ⚠ 1 稿目は「撃った**後**では遅い(描き直しで `hidden` が付く)」と書いていたが、
     * **外して壊れることを 1 度も見ていなかった**(着地前レビュー ⚠4)── 本文の描き直しは
     * worker の promise 越しなので、同期の「後」との間に描き直しは挟まらない。
     * 🔑 前に置いてあるのは**畳みだけを先に解いておくと、届いた瞬間に見える**からで、
     * 「後では遅い」からではない。
     * ⚠ そのぶん**断られた回でも畳みが開く** ── 空のまま押した回などは、
     * 何も足されないのに章だけ開く。⚠ 実害は「開きすぎ」だけなので受け入れる
     * (閉じ直すのは押し所 1 つ)。
     */
    revealAppendTarget(dispatcher, root, target);
    // 🔴 **着いたら足した所へ送る**(#782 B)── ⚠ 撃つ**前**に張る(着地を見逃さない)
    jumpWhenAppended(dispatcher, root, noteLid, target);
    dispatcher.dispatch({
      type: 'APPEND_TO_ENTRY',
      lid: noteLid,
      text,
      heading: appendHeadingFor(archetype!, new Date()),
      target: target === '' ? null : target,
    });
    }
  },
  /**
   * 🔴 **強制解放**(user 指示 2026-08-03「競合ロックと強制解放も念頭に」)。
   * 返ってこない書込で**永久に追記できなくなる**のを防ぐ最後の出口。
   * ⚠ 押した人が結果を分かっていること ── 確認を出す(確認の無い環境は通す)。
   *
   * 🔴 **章の欄の保存中にも同じボタンが効く**(#1044 段2 4巡目の修理、T1)。
   * ⚠ **新しい action は作らない**(追記の「打ち切る」と同じ `force-release` を
   *   `section-box.ts` からも押す)── `FORCE_RELEASE_LOCK` 自体は両方を解く作りで
   *   よい(reducer 側は変えない)。
   *
   * 🔴 **どちらの箱の断りかは「押されたボタンがどの箱に属するか」で決める**
   *   (#1044 段2 5巡目の修理、U2)。
   *
   * ⚠ 直す前は `bodyLockOf(dispatcher.getState())?.holder === 'section'`(§7 の
   *   `bodyLockOf` ── writeLock → tileWrite → editing → sectionDraft の**固定の
   *   優先順位**)で決めていた。⚠ これは「いま何が握っているか」を答える関数であって
   *   「**どちらの箱を押したか**」には答えていない ── 別のノートで追記の
   *   `writeLock` が生きていると `bodyLockOf` は必ず `'writing'` を返すので、
   *   **章の箱**の「打ち切る」を押しても確認文・console・画面の 1 行・メッセージが
   *   **追記と別のノートの題名**を名乗っていた(押した物と効く先が食い違う。
   *   CLAUDE.md §7「押した物と効く先が食い違う門は口ごとに要る」と同型)。
   * 🔑 `target.closest` で押されたボタンが章の箱({@link SECTION_BOX_REGION})/
   *   コード枠の箱({@link CODE_BOX_REGION})の中に居るかを見る ── どちらでも
   *   なければ追記の箱(3 つしかない。新しい 4 つ目の呼び手が増えたら、
   *   そちらもここへ足す。#1044 段3 でコード枠を足した)。
   */
  'force-release': (dispatcher, target, services, root) => {
    const isSection = target.closest(`[data-pkc-region="${SECTION_BOX_REGION}"]`) !== null;
    const isCode = target.closest(`[data-pkc-region="${CODE_BOX_REGION}"]`) !== null;
    const noun = isSection ? '章' : isCode ? 'コード' : '追記';
    confirmThen(
      root,
      noun +
        'の書き込みを強制的に打ち切ります。書き込みが実際には進んでいた場合、' +
        'このタブの表示が実際の中身より古くなることがあります(開き直すと直ります)。よろしいですか?',
      { okLabel: '書き込みを打ち切る', danger: true },
      dispatcher,
      /**
       * 🔴 **ここだけは門を足さない**(#308)。返ってこない書込で**永久に
       * 追記できなくなる**のを防ぐ最後の脱出口なので、前提で塞ぐと逃げ道が消える。
       * ⚠ 「念のため」で `phase` を見ないこと ── 実害の実測が無いまま塞がない。
       */
      () => null,
      () => {
        /**
         * 🔴 **打ち切ったことを、画面と console の両方に残す**(#723)。
         *
         * ⚠ ここは**最後の脱出口**である ── 押されたということは、その前に
         *   「返ってこない書込」が起きている。⚠ 直す前は**何も残らなかった**ので、
         *   cowork が「編集を終えられなくなった」を 1 回観測しても、
         *   **user がこれを押して抜けたのかどうかすら分からなかった**。
         * 🔑 画面には**何が打ち切られたか**を出す(user が古い表示に気づける)。
         *   console には**そのときの state** を出す(次の報告に貼ってもらう)。
         * ⚠ `OP_FAILED` には載せない ── 失敗ではなく、user が意図して行った操作である
         *   (赤いエラー欄に出すと、押した本人が「壊れた」と読む)。
         */
        const s = dispatcher.getState();
        const lid = isSection || isCode ? (s.sectionDraft?.lid ?? null) : (s.writeLock?.lid ?? null);
        const title = lid === null ? null : (s.entryMetas.get(lid)?.title ?? null);
        const what = title === null ? '待っている書き込みはありませんでした' : `対象: ${title}`;
        // ⚠ 次の報告に貼ってもらうための計器(#723)。smoke が拾うのは `error` だけなので
        //    `warn` は赤にならない(`tests/smoke/helpers.ts` の `msg.type() !== 'error'`)
        console.warn(`[pkc3] ${noun}の書き込みを強制的に打ち切りました`, {
          phase: s.phase,
          writeLockLid: lid,
          lockGen: s.lockGen,
          editingLid: s.openBody?.lid ?? null,
        });
        /**
         * 🔴 **console と同じ知らせを「問題」としてメッセージにも残す**
         * (設計 doc §7、段②b)。⚠ console は開発者しか見ないが、メッセージは
         *   user 自身が取り出せる(バグ報告の材料)── 固定文(state は載せない
         *   ── 本文は入れない前提と同じ理由で、let 変数の生値も混ぜない)。
         */
        appMessagePost.post({
          kind: 'problem',
          source: 'force-release',
          text: `${noun}の書き込みを強制的に打ち切りました`,
        });
        // ⚠ 上で固定文を積んだので、こちらは積まない(`what` に題名が入るので、積むと中身が漏れる)
        services.showStatus?.(
          `${noun}の書き込みを打ち切りました(${what})。表示が実際の中身より古いことがあります。開き直すと直ります`,
          { post: false },
        );
        dispatcher.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
      },
    );
  },
  /**
   * 🔴 **列を飛ばして本題へ行く近道**(#720)。器は `shell.ts` の `skip-links`。
   *
   * ⚠ **hash を書き換えない** ── `<a href="#…">` にすると、PKC3 がディープリンクに
   *   使っているアドレスの断片(`#pkc?entry=…`)が上書きされ、**読み込み直すと別の
   *   ものが開く**。だから押し所は `<button>` で、行き先は `data-pkc-skip` で運ぶ。
   * 🔑 **畳まれている列へは、畳み帯の同じボタンを押して開けてから移る** ──
   *   ここで畳みの規則を書き直すと、判定が 2 か所になる(§7)。押すのは
   *   user が押すのと同じ器である。
   * ⚠ 行き先が無い(面が入れ替わっている)ときは**何もしない** ── 焦点をどこか
   *   別の所へ飛ばすと、user は自分がどこに居るのか分からなくなる。
   */
  'skip-to': (_dispatcher, target, _services, root) => {
    const name = target.getAttribute('data-pkc-skip') ?? '';
    if (name === '') return;
    const region = root.querySelector<HTMLElement>(`[data-pkc-region="${name}"]`);
    if (region === null) return;
    /**
     * ⚠ 畳みは shell の属性が正本(`pane-visibility`)── `offsetParent` で見ない。
     *   happy-dom は版面を組まないので、そちらだと**unit では必ず「畳んでいる」**に
     *   なり、押すたびに畳み帯を叩く別物になる。
     */
    const hidden = (
      root
        .querySelector('[data-pkc-region="shell"]')
        ?.getAttribute('data-pkc-hidden-panes') ?? ''
    ).split(' ');
    if (hidden.includes(name))
      root
        .querySelector<HTMLElement>(`[data-pkc-action="toggle-pane"][data-pkc-pane="${name}"]`)
        ?.click();
    region.focus();
  },
  /** 左の列の**探し方**を切り替える(P8 段⑤)。⚠ 中央のビューとは別の軸。 */
  'set-browse': (dispatcher, target, services) => {
    const mode = target.closest('[data-pkc-browse]')?.getAttribute('data-pkc-browse');
    // ⚠ 並べ替えモードを終えるのは `main.ts` の `setBrowse` 1 か所(上の docstring)
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
  'edit-cell': (dispatcher, target, services) => {
    const line = Number(target.getAttribute('data-pkc-cell-line'));
    const col = Number(target.getAttribute('data-pkc-cell-col'));
    if (!Number.isInteger(line) || line < 0 || !Number.isInteger(col) || col < 0) return;
    const st = dispatcher.getState();
    /**
     * ⚠ **どのノートのセルかは、押した所から引く**(`toggle-task` と同じ理由)──
     *   本文の面は `data-pkc-entry` を持たないので、そのときだけ
     *   「いま開いているノート」へ落ちる。
     */
    const lid = lidOfNode(target, st.openBody?.lid ?? st.selectedLid);
    if (lid === null || lid === undefined) return;
    /**
     * 🔴 **断りは lid で判定する**(C6 / #1043)。⚠ 直す前は `phase` だけを見ており、
     *   編集中は**横に留めた別ノートの升も開けなかった**(押しても無言で戻る)。
     */
    const blocked = bodyWriteBlockReason(st, lid);
    if (blocked !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: blockedWithSuffix(blocked, `表を打ってください`) });
      return;
    }
    // ⚠ 2 度押しで欄を作り直さない(打ちかけの字を捨てない)
    if (target.querySelector('[data-pkc-field="cell-input"]') !== null) return;
    /**
     * 🔴 **欄を開いた時点のその行の中身**(#1087)。⚠ 確定は打ち終わった後 ── 打っている間に別の窓が
     *   上へ行を足していても、書換は「開いた時点の行」と disk 側を突き合わせて断る(別の行の升を書き換えない)。
     */
    const openLine = shownCellLine(st, lid, line);
    if (openLine === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: SHOWN_LINE_LOST });
      return;
    }
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
    /**
     * 🔴 **欄を開いても、表の列幅を動かさない**(#750 I1 の実測で判明、2026-09-06)。
     *
     * ⚠ `<input>` の既定は `size="20"` = **20 字ぶんの幅を要求する** ので、
     *   表の自動レイアウトが**その列を広げる**。CSS の `width: 100%` /
     *   `min-width: 0` では効かない(効くのは最小幅で、列幅を決めるのは**最大幅**)。
     * 🔴 実測(空の表で A2 の欄を開いた):その列が **317px** まで広がり、
     *   隣の升が **115px → 88px** に縮んで、**その升の中心が「＋」ボタンになった**
     *   ── 押すと欄が開かず、**列が増える**(#750 I1 で欄が開いたままになるので、
     *   この食い違いが**普通の状態**になるところだった)。
     * 🔑 `size = 1` にすると要求する幅が 1 字ぶんになり、列幅は開く前と同じままになる
     *   (見える幅は CSS の `width: 100%` が升いっぱいにする)。
     */
    input.size = 1;
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
      /**
       * 🔴 **塊の差し替えで壊されるだけのときは確定しない**(#745 の 2 巡目)。
       *
       * ⚠ `applyBlocks` が表の塊を差し替えると欄が壊れ、そのとき `blur` が飛ぶ。
       *   そこで確定すると、**`Escape` を押しても打ちかけの字が数百ミリ秒後に
       *   ひとりでに戻ってくる**(実測 2026-09-06)。
       * 🔑 印を付けた側(`cell-input.ts`)が**同じ欄を開き直す**ので、
       *   ここで確定させる理由はもう無い ── 打ちかけの字は欄ごと戻る。
       */
      if (input.hasAttribute(HOLD_ATTR)) {
        settled = true;
        return;
      }
      settled = true;
      const value = input.value;
      restore();
      if (value === before) return; // 変わっていなければ撃たない
      /**
       * 🔴 **続けて打つ次の升のために、いま書く行の結果を覚えておく**(`shownCellLine`)。
       * ⚠ 隣の欄は書き戻しを待たずに開くので、画面の行はまだ書く前の物である。
       */
      noteCellWrite(dispatcher.getState(), lid, { line, openLine, col, value });
      /**
       * 🔴 **別のタブ・窓が編集中のノートへは、升の書換も撃たない**(#1087。行・列を消す回と同じ門)。
       * ⚠ 通すと、編集中のタブの保存で上書きされる。**断るときは打った字を知らせに残す**
       *   (欄はもう閉じている ── `typedCellNote`。書換の往復で落ちた回と同じ字)。
       */
      actUnlessEditedElsewhere(
        dispatcher,
        services,
        [lid],
        '表を触れませんでした(別のタブの編集を確かめられませんでした)。もう一度打ってください',
        () => dispatcher.dispatch({ type: 'SET_CSV_CELL', lid, line, openLine, col, value }),
        typedCellNote({ kind: 'csv-cell', value }),
      );
    };
    /**
     * 🔴 **確定して、隣の升の欄をそのまま開く**(#750 I1。user 裁定 2026-09-06)。
     *
     * ⚠ 直す前は `Enter` で欄が閉じるだけだったので、**5 列 3 行を埋めるのに
     *   15 回押し直す**ことになっていた ── 「原文のカンマを数えなくていい」ために
     *   作った動線なのに、埋める作業では押す回数が字数と同じくらい要った。
     * 🔑 `Tab` で**右**、`Shift`+`Tab` で**左**、`Enter` で**下**。
     *   ⚠ 左と上を用意するのは「**片道の操作を作らない**」(user 指示 2026-08-23)──
     *   行き過ぎたときに戻れないと、結局マウスへ手が戻る。
     * ⚠ **行き先が無ければ、いままでどおり閉じる**(表の最後の升 / いちばん下の行)
     *   ── 動かないのに欄だけ残ると「効かない鍵」に見える。
     *
     * ## ⚠ 隣は**すぐには開けない**
     *
     * 確定は `SET_CSV_CELL` → worker を往復 → `applyBlocks` が**表の塊ごと差し替える**
     * ので、いま画面に在る隣の升は**数十ミリ秒後に捨てられる**(#745 と同じ経路)。
     * 🔑 だから `cell-input.ts` に**予約**しておき、差し替えた後に開く。
     * ⚠ ただし**字が変わっていない回は書き戻しが来ない**(`commit()` が撃たない)ので、
     *   その回は**その場で開く** ── 予約だけして待つと、次の無関係な描き直しまで
     *   何も起きない(押したのに動かない、に見える)。
     */
    const moveTo = (dir: 'right' | 'left' | 'down' | 'up'): void => {
      const next = neighborCell(target, dir);
      commit();
      // ⚠ 行き先が無ければ、確定して閉じるだけ(動かない欄を残さない)
      if (next !== null) openCellAt(target.closest<HTMLElement>('.pkc-md-block') ?? target, next);
    };
    input.addEventListener('keydown', (ev) => {
      /**
       * 🔴 **変換中の鍵は IME のもの ── 1 つも横取りしない**
       * (着地前レビュー・動線 D1、2026-09-06。**この PR でいちばん重い**)。
       *
       * ⚠ この欄だけが `isComposing` を見ていなかった ── 画面全体(`:7238`)も
       *   小窓(`app-dialog.ts`)も鍵の一覧(`keymap-panel.ts`)も見ているのに。
       *   🔑 `row-swap.ts` に実測が残っている:**変換中は Enter / Tab / Escape が
       *   全部 `isComposing`** である。
       * 🔴 **直す前より悪くなっていた**:`Enter` の横取りは前からだったが、
       *   前は「欄が閉じて、続きの字がどこにも入らない」だったのに対し、いまは
       *   「**下の升が開いて全選択**され、続きの字が**その升の中身を消して上書きする**」
       *   ── 「打った字が消える」から「**別の升のデータが消える**」へ変わっていた。
       * ⚠ 日本語で表を埋める人は**升 1 つにつき最低 1 回**変換を確定するので、
       *   これは**毎升踏む**。しかも壊れるのは**まだ見ていない隣の升**である。
       */
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        /**
         * 🔴 **確定して、閉じる鍵を残す**(同 D2)。
         * ⚠ `Enter` が「終わり」から「次へ」に変わったので、**1 升だけ直したい人**
         *   (いちばん多い使い方)から**終わり方が消えていた** ── `Escape` は
         *   打った字を捨てるので代わりにならない。
         * 🔑 `Ctrl`(mac は `⌘`)+ `Enter` で、確定して閉じる。
         */
        if (ev.ctrlKey || ev.metaKey) commit();
        else moveTo(ev.shiftKey ? 'up' : 'down');
      } else if (ev.key === 'Tab') {
        /**
         * 🔴 **行き先が無いときは `Tab` を握らない**(着地前レビュー・動線 D2 / 実装 A4)。
         *
         * ⚠ 無条件に握ると、**表から `Tab` で出られなくなる** ── この binder の
         *   別の場所(`onShortcut`)には既にその戒めが書いてある:
         *   「どちらも当たらなければ `preventDefault()` しない ── 常に握ると
         *   **編集欄から `Tab` で出られなくなる**(キーボードだけで使う人の動線を 1 つ殺す)」。
         * 🔑 隣が在るときだけ握り、**表の最後の升では素の `Tab`** に戻す
         *   ── 確定はする(下の `moveTo` が `commit()` する)ので、字は残る。
         */
        if (neighborCell(target, ev.shiftKey ? 'left' : 'right') !== null) ev.preventDefault();
        moveTo(ev.shiftKey ? 'left' : 'right');
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        settled = true;
        restore();
      }
    });
    input.addEventListener('blur', commit);
    /**
     * 🔴 **打っている間だけ、その升の名前(`B2`)を小さく出す**(#1662 4。Gemini 裁定 = #1163 依頼 48 の 4 = A)。
     * 式は `=B2*C2` と書くが、どの列が B でどの行が 2 かは数えるしか無かった。常に出すと表が詰まるので、
     * 欄を開いている間だけ。⚠ 出すのは csv の表だけ(行の番号を焼くのは csv の描画だけ ── markdown の表に式は無い)。
     * ⚠ 欄を閉じると `restore` が升の中身を描いたものに戻すので、名前も一緒に消える。
     */
    const rowAttr = target.getAttribute('data-pkc-cell-row');
    const rowIndex = rowAttr === null ? NaN : Number(rowAttr);
    if (Number.isInteger(rowIndex) && rowIndex >= 0) {
      const tag = target.ownerDocument.createElement('span');
      tag.className = 'pkc-csv-cell-name';
      tag.setAttribute('data-pkc-field', 'cell-name');
      tag.textContent = cellName(rowIndex, col);
      target.replaceChildren(input, tag);
    } else target.replaceChildren(input);
    input.focus();
    input.select();
  },
  /**
   * 🔴 **見出しの升の ✎ を押したら、その見出しを編集する**(#1240。裁定 A)。
   *
   * > 見出しの升は 1 回押すと**並べ替え**(#1150)なので、編集は 2 回押しか、升の右の ✎ から。
   *
   * 🔑 **欄を開く仕事は `edit-cell` の 1 か所のまま**(§7)── ここは「どの升か」を
   *   入っている `th` から引いて渡すだけ。⚠ 判定・断り(編集中 / 字を選んでいる最中 /
   *   2 度押し)は全部 `edit-cell` が持つので、ここへ複製しない。
   */
  'edit-header-cell': (dispatcher, target, services, root) => {
    const cell = target.closest<HTMLElement>('th[data-pkc-action="edit-cell"]');
    if (cell === null) return;
    // ⚠ ✎ を押したのは**明示の意思**なので、残っている字の選択で止めない(2 回押しの `onDblClick` と同じ)
    cell.ownerDocument.getSelection()?.removeAllRanges();
    ACTIONS['edit-cell']!(dispatcher, cell, services, root);
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
  'shape-cell': (dispatcher, target, services) => {
    const line = Number(target.getAttribute('data-pkc-cell-line'));
    const col = Number(target.getAttribute('data-pkc-cell-col'));
    const what = target.getAttribute('data-pkc-cell-what');
    const mode = target.getAttribute('data-pkc-cell-mode');
    if (!Number.isInteger(line) || line < 0 || !Number.isInteger(col) || col < 0) return;
    if ((what !== 'row' && what !== 'col') || (mode !== 'add' && mode !== 'remove')) return;
    const st = dispatcher.getState();
    const lid = lidOfNode(target, st.openBody?.lid ?? st.selectedLid);
    if (lid === null || lid === undefined) return;
    // 🔴 断りは lid で判定する(C6 / #1043)── 別ノートの表は編集中でも触れる。
    const blocked = bodyWriteBlockReason(st, lid);
    if (blocked !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: blockedWithSuffix(blocked, `表を触ってください`) });
      return;
    }
    /**
     * 🔴 **押した時点のその行の中身**(#1087)。⚠ 行番号だけだと、別の窓が上へ行を足したあと、
     *   古い表示から押した「消す」が**1 行上の行**を消す。升を開くのと同じ口(`shownCellLine`)で引く。
     *   引けなければ撃たずに断る。
     */
    const openLine = shownCellLine(st, lid, line);
    if (openLine === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: SHOWN_LINE_LOST });
      return;
    }
    const fire = (): void => {
      // 🔴 続けて押す次の操作のために、いま書く行の結果を覚えておく(升の `Tab` と同じ。`noteShapeWrite`)
      noteShapeWrite(dispatcher.getState(), lid, { line, openLine, col, what, mode });
      dispatcher.dispatch({ type: 'SET_CSV_SHAPE', lid, line, openLine, col, what, mode });
    };
    /**
     * 🔴 **行・列を足す回も消す回も、別のタブ・窓が編集中なら断る**(追記・チェックの切り替えと同じ門。#1087)。
     * ⚠ 通すと編集中のタブの保存で上書きされ、足した行・消した行は履歴にだけ残る(足す回は `append-entry` と同じ)。
     */
    actUnlessEditedElsewhere(dispatcher, services, [lid], '表を触れませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください', fire);
  },
  /**
   * 🔴 **色の見本を押して、本文の色コードを選び直す**(#1224。Gemini 裁定 2026-10-01 Q2 = B)。
   *
   * > user の物語:`#3b82f6` の隣の四角を押す → 色を選ぶ窓が開く → 選ぶ → **本文のそのコードだけ**が
   * > 新しい色の字に変わり、四角も新しい色になる。
   *
   * ⚠ 押せるのは**6 桁小文字の見本だけ**(描く側が `pick-color` を焼くのはその形だけ)。
   * ⚠ **`change` で 1 回だけ撃つ**(`input` のたびに保存しない ── 色を探して動かす間は何も書かない)。
   *   選ぶ窓を閉じたり同じ色を選んだときは**何も書かない**。
   * ⚠ 押す前に**編集中かを見て断る**(開いても書けない窓を出さない)。断り文は他の本文の書換と同じ 1 本
   *   (`bodyWriteBlockReason`)。⚠ 選び終えたときに**もう一度** reducer が見る(待つ間に編集が始まった形)。
   * ⚠ どのノートの行かは**押した所から引く**(`toggle-task` と同じ ── 横に留めた別のノートの見本を
   *   押したとき、開いているノートの同じ行を書き換えない)。
   * 🔑 選ぶ窓(`<input type="color">`)は画面の外の使い捨て 1 つ ── 開くたびに前の物を外して作り直す。
   */
  'pick-color': (dispatcher, target, services) => {
    const line = Number(target.getAttribute('data-pkc-color-line'));
    const nth = Number(target.getAttribute('data-pkc-color-nth'));
    const from = target.getAttribute('data-pkc-color-value') ?? '';
    if (!Number.isInteger(line) || line < 0 || !Number.isInteger(nth) || nth < 0) return;
    // 押して直せるのは 6 桁小文字だけ(描く側が焼くのもその形。属性を書き換えられても書かない)
    if (!isEditableColor(from)) return;
    const st = dispatcher.getState();
    const lid = lidOfNode(target, st.openBody?.lid ?? st.selectedLid);
    if (lid === null || lid === undefined) return;
    const blocked = bodyWriteBlockReason(st, lid);
    if (blocked !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: blockedWithSuffix(blocked, `色を直してください`) });
      return;
    }
    openColorPicker(target, from, (to) => {
      if (!isEditableColor(to) || to === from) return;
      // 🔴 別のタブ・窓が編集中のノートへは撃たない(#1087。`toggle-task` と同じ門。選び終えた時点で確かめる)
      actUnlessEditedElsewhere(
        dispatcher,
        services,
        [lid],
        '色を直せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
        () => dispatcher.dispatch({ type: 'SET_COLOR_CODE', lid, line, nth, from, to }),
      );
    });
  },
  'toggle-task': (dispatcher, target, services, root) => {
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
     * 🔴 **2026-08-30 に同じ罠が再発した** ── #505 の「横に留めた枠」は
     *   `data-pkc-split-lid` を焼くので、`data-pkc-entry` だけを見ていると
     *   **主の枠のノートへ落ちる**。引き方は `lid-of-node.ts` の 1 か所へ寄せた。
     */
    /**
     * 🔴 **板の付箋の中のチェックは、付箋が置いたノートの行**(#529 W5-c)。
     * ⚠ 付箋の枠は `data-pkc-entry` を持たない ── `lidOfNode` に任せると**板のノート自身**へ落ち、
     *   板の同じ行番号を書き換える(いちばん静かなデータ破壊)。だから付箋の枠から先に引く。
     */
    const placedLid = placedTaskLidOf(target);
    const lid = placedLid ?? lidOfNode(target, st.openBody?.lid ?? st.selectedLid);
    if (lid === null || lid === undefined) return;
    /**
     * 🔴 **断りは lid で判定する**(C6 / #1043)。⚠ 直す前は `phase` だけを見ており、
     *   横に留めた別ノートのチェック(この `lid` は上で押した所から引いている)まで、
     *   編集中はどれも押しても効かない dead click になっていた。
     */
    const blocked = bodyWriteBlockReason(st, lid);
    if (blocked !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: blockedWithSuffix(blocked, `チェックしてください`) });
      return;
    }
    /**
     * 🔴 **押した時点のその行の中身を、押した面が見ている本文から引く**(#1087)。
     * ⚠ 行番号だけだと、別の窓が上へ 1 行足したあと、古い表示(横に留めた枠・予定の札)から押した操作が
     *   **押していない項目**を切り替える。面で見ている本文の置き場が違う ── 付箋は抜粋、予定の札は走査、
     *   本文・枠は画面の本文(`shown-line.ts`)。引けなければ撃たずに断る。
     * ⚠ 別のタブの編集を待つ前(= 押した瞬間)に引く ── 待っている間に表示が替わっても、押した物を運ぶ。
     */
    const openLine =
      placedLid !== null
        ? shownPlacedLine(st, placedLid, line)
        : target.closest('article[data-pkc-entry]') !== null
          ? shownCardLine(st, lid, line)
          : shownBodyLine(st, lid, line);
    if (openLine === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: SHOWN_LINE_LOST });
      return;
    }
    /**
     * 🔴 別のタブ・窓が**そのノートを編集中**なら断る(追記・題名と同じ門。押した印は動かさない)。
     * ⚠ 直す前は付箋の中のチェックだけがこの門を通り、普通のチェックと繰り返しの回は素通りだった ──
     *   付けた印は、編集中のタブが保存したときに上書きされて消えていた(#1087)。
     */
    const guarded = (act: () => void, at: string): void => {
      void editedElsewhereReason(dispatcher, services, at)
        .then((why) => {
          if (why !== null) {
            dispatcher.dispatch({ type: 'OP_FAILED', error: why });
            return;
          }
          act();
        })
        // 🔴 問い合わせが落ちても黙らない(追記と同じ作法 ── 押しても何も起きないボタンにしない。#1087)
        .catch(() => {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: 'チェックできませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
          });
        });
    };
    if (placedLid !== null) {
      guarded(() => dispatcher.dispatch({ type: 'TOGGLE_TASK', lid: placedLid, line, openLine }), placedLid);
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
      guarded(() => dispatcher.dispatch({ type: 'MATERIALIZE_REPEAT', lid, line, openLine, date: on }), lid);
      return;
    }
    /**
     * 🔴 **札(予定の一覧・表・かんばん)の ☐ で未完を済みにしたときは、動かしたときと同じ「元に戻す」を出す**
     * (#1654 の 2。Gemini 裁定 = #1163 の依頼 44 の 2)。済みにした札は一覧から消えるので、間違えても戻す口が無かった。
     * ⚠ 本文の面の ☐ には出さない(その場に残るので押し直せる)。済みから戻す押し方にも出さない。
     */
    const isCard = target.closest('article[data-pkc-entry]') !== null;
    const task = isCard ? st.taskScan?.cards.find((c) => c.lid === lid && c.line === line) : undefined;
    guarded(() => {
      if (task !== undefined && !task.done && /^\s*(?:[-*+]|\d+[.)])\s+\[ \]/.test(openLine))
        offerDoneUndo(root, dispatcher, { lid, line, openLine, title: plainTaskTitle(task.text) });
      dispatcher.dispatch({ type: 'TOGGLE_TASK', lid, line, openLine });
    }, lid);
  },
  'toggle-show-archived': (dispatcher) =>
    dispatcher.dispatch({ type: 'TOGGLE_SHOW_ARCHIVED' }),
  /**
   * 板の「完了」を開く / 畳む(2026-08-20。設計 doc §4-4)。
   * ⚠ `toggle-show-archived`(片付けた**ノート**)とは別物 ── 相乗りさせない。
   */
  /**
   * 🔴 **フォルダの面の「中まで全部出す」を入れる / 切る**(#813 段②)。
   * ⚠ **効かせる(state)と憶える(端末)を両方やる** ── 片方だけだと
   *   「押したのに変わらない」か「押したのに次に開くと戻っている」になる。
   */
  'toggle-filer-flatten': (dispatcher, _target, services) => {
    const on = !dispatcher.getState().filerFlatten;
    dispatcher.dispatch({ type: 'SET_FILER_FLATTEN', on });
    services.rememberFilerFlatten?.(on);
  },
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
   * 🔴 **予定の面で、そのノートの予定を隠す / 出す**(#855。Gemini 裁定 = #1163 の依頼 20-A)。
   * 「出すもの」のノートの一覧の 1 行 1 行が押し口で、**どのノートかは行が持つ**(`data-pkc-note-lid`)。
   * ⚠ ノートそのものは隠さない(予定の面から外すだけ)。
   */
  'toggle-schedule-note': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-note-lid');
    if (lid === null || lid === '') return;
    dispatcher.dispatch({ type: 'TOGGLE_SCHEDULE_NOTE', lid });
  },
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
  'set-entry-date': (dispatcher, _target, services, root) => {
    /**
     * 🔴 **編集中は声に出して断る**(#513)── 直す前はピッカーの全手順
     * (開く → 選ぶ → 確定)を完走させてから reducer が黙って捨てていた。
     */
    const phase = dispatcher.getState().phase;
    if (phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(phase)}日付を付けてください` });
      return;
    }
    const lid = dispatcher.getState().selectedLid;
    if (lid === null) return;
    void pickDateInApp(
      root,
      new Date(),
      DATE_SHORTCUTS,
      (id, now) => (isDateShortcut(id) ? shortcutDate(id, now) : ''),
      /**
       * 🔴 **時刻の欄を出さない**(#865、2026-09-13)。
       * ⚠ ノートの日付に時刻は無い(抽出列が `YYYY-MM-DD` だけを受ける)ので、
       *   出すと**打った字が黙って捨てられる**(無言の dead input)。
       * 🔑 捨てるのは正しい ── 捨てる物を打たせるのが間違いだった。
       */
      { withTime: false },
    ).then((picked) => {
      if (picked === null) return;
      // 🔴 別のタブ・窓が編集中のノートへは撃たない(#1087。選び終えた時点で確かめる。押した瞬間の lid を撃つ)
      actUnlessEditedElsewhere(
        dispatcher,
        services,
        [lid],
        '日付を付けられませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
        () => dispatcher.dispatch({ type: 'SET_ENTRY_DATE', lid, date: picked.date }),
      );
    });
  },
  /**
   * 🔴 **置けるなら外せる**(片道を作らない)。
   * ⚠ **ここに phase の門を置かない**(#516 で外した)── `SET_ENTRY_DATE` の
   *   reducer が声に出して断るようになったので、ここで先回りすると
   *   **同じ断り文が 2 か所**になる(片方だけ直すと食い違う ── §7)。
   * 🔑 上の `set-entry-date` に門が残っているのは**別の理由**である ──
   *   あちらは**ピッカーを開く前に止める**ためで、reducer では間に合わない
   *   (#513 の「全手順を完走させてから捨てる」を作り直さない)。
   */
  'clear-entry-date': (dispatcher, _target, services) => {
    const lid = dispatcher.getState().selectedLid;
    if (lid === null) return;
    // 🔴 別のタブ・窓が編集中のノートへは撃たない(#1087。`unschedule-task` の全体の分と同じ門)
    actUnlessEditedElsewhere(
      dispatcher,
      services,
      [lid],
      '日付を外せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
      () => dispatcher.dispatch({ type: 'SET_ENTRY_DATE', lid, date: null }),
    );
  },
  /** 予定の面の「一覧 / 日」(#855 段 A-1)。値は押したボタンの `data-pkc-mode`。 */
  'schedule-mode': (dispatcher, target, services) => {
    const mode = target.getAttribute('data-pkc-mode');
    if (mode !== 'list' && mode !== 'day' && mode !== 'week' && mode !== 'month') return;
    /**
     * 🔴 **左の列の「週」は、別のウィンドウで開く**(#855 段 A-2)。左の列は狭く、7 日を並べると
     *   1 日が読めなくなる ── 左の見せ方(一覧 / 日)は変えない。窓が出なかったときの理由は
     *   開く側(`view-window.ts`)が出す。⚠ 判定は押した面(`data-pkc-browse-pane`)で ──
     *   state ではない(別窓の中央の面は同じ state でも 7 日を並べる)。
     */
    const narrow = target.closest('[data-pkc-browse-pane]') !== null;
    if ((mode === 'week' || mode === 'month') && narrow) {
      if (services.openScheduleWindow === undefined) {
        dispatcher.dispatch({ type: 'OP_FAILED', error: '別のウィンドウを開けませんでした' });
        return;
      }
      services.openScheduleWindow(mode, dispatcher.getState().scheduleDay);
      return;
    }
    // 🔴 狭い面は自分の見せ方(`scheduleNarrowMode`)を持つ ── 中央の見せ方を巻き込まない
    if (narrow && (mode === 'list' || mode === 'day')) {
      dispatcher.dispatch({ type: 'SET_SCHEDULE_NARROW_MODE', mode });
      return;
    }
    dispatcher.dispatch({ type: 'SET_SCHEDULE_MODE', mode });
  },
  /**
   * 🔴 **印刷 ── いま見ている範囲だけを紙に出す**(#855。Gemini 裁定 = #1163 の依頼 30 の Q2)。
   *
   * 範囲の決め方は**見えている物**で決める(見せ方の state を読み直さない ── 狭い面と広い面で持ち主が違う):
   * 「日」「週」「月」の器のうち隠れていないもの、無ければ日ごとの一覧。印は `data-pkc-print-range`、
   * 文書の側の印は `data-pkc-print`(`app.css` 末尾の `@media print` が、この 2 つで「範囲の外」を落とす)。
   * ⚠ 印は紙が済んだら外す(`afterprint`)。外し忘れると、次にノートを刷ったとき予定表が出る。
   * 🔑 ブラウザの印刷を呼ぶだけ ── PDF にするか紙に出すかは user が印刷画面で選ぶ(ノートの「PDF」と同じ)。
   */
  'schedule-print': (_dispatcher, target) => {
    const face = scheduleFaceOf(target);
    if (face === null) return;
    const doc = target.ownerDocument;
    const win = doc.defaultView;
    if (win === null) return;
    const range =
      face.querySelector<HTMLElement>(
        '[data-pkc-region="schedule-monthview"]:not([hidden]), [data-pkc-region="schedule-weekview"]:not([hidden]), [data-pkc-region="schedule-day"]:not([hidden])',
      ) ?? face.querySelector<HTMLElement>('[data-pkc-region="schedule-groups"]');
    if (range === null) return;
    for (const old of doc.querySelectorAll('[data-pkc-print-range]')) old.removeAttribute('data-pkc-print-range');
    range.setAttribute('data-pkc-print-range', '');
    doc.documentElement.setAttribute('data-pkc-print', 'schedule');
    win.addEventListener(
      'afterprint',
      () => {
        doc.documentElement.removeAttribute('data-pkc-print');
        range.removeAttribute('data-pkc-print-range');
      },
      { once: true },
    );
    win.print();
  },
  /**
   * 「週」の曜日の見出しを押したら、その日の「日」へ(#855 段 A-2)。行き先は描画時に焼いてある
   * (`data-pkc-day-to`)。⚠ 空 = 今日(今日に追従する状態)。
   * 🔑 「月」の升目の日付の数字と「ほか N 件」(#855)も**同じ行き先・同じ動き**なのでこの口を使う(口を増やさない)。
   */
  'schedule-week-pick': (dispatcher, target) => {
    const to = target.getAttribute('data-pkc-day-to');
    if (to === null) return;
    dispatcher.dispatch({ type: 'SET_SCHEDULE_MODE', mode: 'day' });
    dispatcher.dispatch({ type: 'SET_SCHEDULE_DAY', date: to === '' ? null : to });
  },
  /**
   * 「日」の ‹ › 今日(#855 段 A-1)。⚠ **行き先の日は描画時に焼いてある**(`data-pkc-day-to`)──
   * binder に「いま見ている日」の別ソース(実時刻)を持たせない(`schedule-nav` と同じ)。
   * 空 = 今日へ戻る。
   */
  'schedule-day-go': (dispatcher, target) => {
    const to = target.getAttribute('data-pkc-day-to');
    if (to === null) return;
    dispatcher.dispatch({ type: 'SET_SCHEDULE_DAY', date: to === '' ? null : to });
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
  'schedule-pick-day': (dispatcher, target) => {
    const date = target.getAttribute('data-pkc-drop-date');
    if (date === null) return;
    /**
     * 🔴 **「日」のときは、押した日を見せる**(#855 段 A-1)。⚠ 一覧のときの「束へ送る」は
     *   「日」には束が無いので何も起きない ── 押しても何も起きない升目にしない。
     * 🔑 見せ方は押した面の state で決める(狭い面 `scheduleNarrowMode` / 広い面 `scheduleMode`)。
     */
    const st = dispatcher.getState();
    // 🔴 **押した面の見せ方**で決める(狭い面は `scheduleNarrowMode`、広い面は `scheduleMode`)
    const narrowFace = target.closest('[data-pkc-browse-pane]') !== null;
    const shown = narrowFace ? st.scheduleNarrowMode : st.scheduleMode;
    if (shown === 'day' || shown === 'week') {
      dispatcher.dispatch({ type: 'SET_SCHEDULE_DAY', date });
      return;
    }
    /**
     * 🔴 **「月」では、小さな月の日を押すとその日の「日」へ移る**(#855)。大きな升目は同じ月を既に全部見せているので、
     *   「束へ送る」(一覧の束は隠れている)も「見ている日を動かす」(升目に印が無い)も、押しても何も起きない。
     *   押した日を読むには「日」へ移るのが最短で、升目の日付の数字・「ほか N 件」(`schedule-week-pick`)と同じ行き先。
     */
    if (shown === 'month') {
      dispatcher.dispatch({ type: 'SET_SCHEDULE_MODE', mode: 'day' });
      dispatcher.dispatch({ type: 'SET_SCHEDULE_DAY', date });
      return;
    }
    // 🔴 **押した面の束**へ送る(#673 段②)── 予定の面は 2 つ在りうる(`scheduleFaceOf`)
    scheduleFaceOf(target)
      ?.querySelector(`[data-pkc-region="schedule-group"][data-pkc-drop-date="${date}"]`)
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
   *
   * 🔴 **いま居るフォルダ(パンくずの最後の段)を押したら、そのフォルダを選ぶ**(#1254 §1)。
   * 入る先がいまの場所なので `SET_SCOPE` は何も変えず、押しても何も起きなかった。
   * 🔑 選び方は**行を押したときと同じ 1 本**(`select-entry` を呼ぶ ── 編集中の断りも、
   *   中央に出る概要も同じ)。⚠ 左の列の場所は動かさない(`SET_SCOPE` を撃たない)。
   * ⚠ 別名の action にしない ── 焼く側(`filer.ts`)は全段を同じ名前で焼いていて、
   *   「いま居る段か」は**ここで state から判る**(判定を焼く側と受ける側の 2 か所に持たない)。
   */
  'enter-folder': (dispatcher, target, services, root) => {
    const lid = target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
    if (lid !== null && lid === dispatcher.getState().scopeLid) {
      ACTIONS['select-entry']!(dispatcher, target, services, root);
      return;
    }
    dispatcher.dispatch({ type: 'SET_SCOPE', lid });
  },
  /**
   * 🔴 **居場所を変える**(2026-08-05、user 報告「フォルダ整理のための導線がない」)。
   * 空値 = ルートへ出す。⚠ 動かす当人は**帯自身**が持っている
   * (`selectedLid` を読み直すと、選び直した直後に別のものを動かす)。
   */
  /*
   * ⚠ ここに在った `move-entry` は **#813(2026-09-09)で外した** ──
   *   焼く所(フォルダの面の「居場所」の `<select>`)が 0 件になったからである
   *   (user 指示「**移動先指定プルダウン邪魔、利便性悪いし整理アプリに移行しよう**」)。
   * 🔑 実体は `moveEntries` **1 本**のままで、残る呼び手は
   *   `move-to-folder`(右クリック / パンくず)と D&D(`moveDropped`)である。
   */
  /**
   * 🔴 **行の名前を、その場で打ち替え始める**(#215。行の右クリック / 情報ペイン / `F2`)。
   *
   * ⚠ 入力欄は **state 駆動**(`ROW_RENAME_BEGIN` → 面が行の題名の所に欄を描く)──
   *   2 ペインの `dual-rename-begin` と同じ作法。確定は `RENAME_ENTRY_TITLE` 1 つ。
   * ⚠ 欄を描くのは**フォルダの面だけ**である。予定・連絡先の行から
   *   押した場合は欄が出ない ── だから**フォルダの面へ切り替えて**出し、それでも出なければ
   *   (絞り込みで行が消えている等)理由を出して畳む。黙って `renamingLid` を立てたまま
   *   終わると、次にその行が出た瞬間に欄が現れる(押していないのに)。
   */
  'rename-entry-begin': (dispatcher, target, services, root) => {
    const st = dispatcher.getState();
    const lid = rowLidOrSelected(st, target);
    if (lid === null || !st.entryMetas.has(lid)) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '名前を変えるノートを選んでください(行を押すと選べます)',
      });
      return;
    }
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}名前を変えてください` });
      return;
    }
    // スマホでは名前の欄が出る一覧が隠れている ── 先に一覧を見せてから始める(#1087 P1)。PC は素通り。
    if (!phoneShowList(dispatcher)) return;
    rowRenameReturn = null;
    dispatcher.dispatch({ type: 'ROW_RENAME_BEGIN', lid });
    const fieldShown = (): boolean =>
      root.querySelector('[data-pkc-field="row-rename"]') !== null;
    /**
     * 🔴 **欄が出なければ、フォルダのタブへ切り替え、それでも出なければその行の親フォルダへ入る**
     *   (#813 段③。以前は「一覧タブへ切り替える」だった)。
     * ⚠ 一覧は階層を見ない平らな並びだったので、**どのフォルダに居る行でも**欄が出た。
     *   フォルダの表は**いま居る場所の直下**の行にしか欄を描けない ── 予定・連絡先・音/動画の行
     *   (別のフォルダに居る)から始めたときは、**親フォルダへ入って**欄を出す
     *   (行き先は `SET_SCOPE` 1 本 = 戻るのはパンくず / `Backspace`)。
     * ⚠ 絞り込みで行が消えているときは入っても出ない ── そのときだけ下の断りを出す。
     */
    if (!fieldShown()) services.setBrowse?.('filer');
    if (!fieldShown()) {
      const parent = getAncestorFolders(lid, st.entryMetas, st.relations)[0] ?? null;
      dispatcher.dispatch({ type: 'SET_SCOPE', lid: parent?.lid ?? null });
      // 🔴 いま居るフォルダ自身の改名なら、打ち終わったら中へ戻る(依頼 85-5)
      rowRenameReturn = lid === st.scopeLid ? { lid, parent: parent?.lid ?? null } : null;
    }
    if (!fieldShown()) {
      rowRenameReturn = null;
      dispatcher.dispatch({ type: 'ROW_RENAME_END' });
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '名前を変える欄は、フォルダのタブの行に出ます(絞り込みで隠れていないか確かめてください)',
      });
    }
  },
  /**
   * 🔴 **入れ先のフォルダを一覧から選んで移す**(#215。行の右クリック / 情報ペイン / `F6`)。
   *
   * ⚠ 相手は **D&D と同じ規則** ── 押した行に印が付いていれば**印の全部**、
   *   付いていなければその 1 件(「選んだつもりの物と動く物が違う」を作らない)。
   *   題名にその件数が出るので、押す前に何件動くかが読める。
   * ⚠ 候補は `listMoveTargets`(自分と自分の子孫を除いたフォルダ)を**全部の相手で
   *   共通に**取る ── `canEnterScope` は使わない(スマートフォルダは中へ入れるが、
   *   手で子を入れることはできない ── `tree.ts` の注記)。
   * ⚠ ルートは**題名を打っていないときだけ**先頭に出す ── 打った後も先頭に居ると、
   *   `Enter`(= 先頭を選ぶ)が打った名前のフォルダではなくルートへ出してしまう。
   * 🔑 器は `pickEntryInApp`(題名で探して選ぶ)を**そのまま**使う ── user に 2 通りの
   *   探し方を覚えさせない。実体は `moveEntries`(帯の `<select>` / D&D と同じ 1 本)。
   */
  'move-to-folder': (dispatcher, target, services, root) => {
    const st = dispatcher.getState();
    const lid = rowLidOrSelected(st, target);
    if (lid === null || !st.entryMetas.has(lid)) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '移すノートを選んでください(行を押すと選べます)',
      });
      return;
    }
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}動かしてください` });
      return;
    }
    // 🔴 いま画面に出ている行の印だけを相手にする(`visibleFilerRows` 1 本 ──
    //   「中まで全部出す」/ 語を打っている間は階層をまたいだ平らな行で採る)
    const marked = visibleSelection(visibleFilerRows(st), st.selection);
    const lids = marked.includes(lid) ? marked : [lid];
    const title =
      lids.length === 1
        ? `「${st.entryMetas.get(lid)?.title ?? ''}」を移す`
        : `${lids.length} 件を移す`;
    void pickEntryInApp(
      root,
      (query) => {
        const now = dispatcher.getState();
        const q = normalizeQuery(query);
        const [first, ...others] = lids;
        const base = first === undefined ? [] : listMoveTargets(first, now.entryMetas, now.relations);
        const allowed = others.map(
          (l) => new Set(listMoveTargets(l, now.entryMetas, now.relations).map((f) => f.lid)),
        );
        const folders = base.filter(
          (f) => allowed.every((s) => s.has(f.lid)) && matchesTitle(f.title, q),
        );
        const items = [
          ...(q === '' ? [{ lid: '', title: 'ルート(いちばん上)', kind: '' }] : []),
          // 🔑 種類の列には**場所**(パンくずの形)を出す ── 同じ名前のフォルダを見分ける
          ...folders.map((f) => ({ lid: f.lid, title: f.title, kind: f.path })),
        ];
        return {
          items,
          note:
            folders.length === 0
              ? q === ''
                ? // 欄が空のときに「欄を空にすると」は誤り。この時はルートの行が出ている
                  'ここに移せるフォルダがありません(「ルート(いちばん上)」へは移せます)'
                : 'あてはまるフォルダがありません(欄を空にするとルートへ出せます)'
              : '',
        };
      },
      { title },
    ).then((to) => {
      if (to === null) return;
      moveEntriesOfferingUndo(dispatcher, lids, to === '' ? null : to, services.showStatus);
    });
  },
  /**
   * 🔴 **並べ替え**(2026-08-06。user 報告 2-10)。⚠ 動かす当人は帯が持つ
   * (`move-entry` と同じ理由 ── 押した瞬間に選択が変わっていても取り違えない)。
   */
  'move-order-up': (dispatcher, target) => moveOrder(dispatcher, target, 'up'),
  'move-order-down': (dispatcher, target) => moveOrder(dispatcher, target, 'down'),
  /**
   * 🔴 **アプリのタイルを 1 つ動かす**(#857 段①)── 掴めない人の道。
   * ⚠ 身元はメニューが写した属性から引く(押したボタンはタイルの中に居ない)。
   */
  'move-tile-up': (dispatcher, target) => moveTile(dispatcher, target, -1),
  'move-tile-down': (dispatcher, target) => moveTile(dispatcher, target, 1),
  /**
   * 🔴 **並べ替えモードへ入る / 出る**(#857 段①b-2)。
   * ⚠ 入口は 2 つ(長押し / 右クリック)だが、**撃つ action は 1 つ**にする ──
   *   器ごとに別の action を作ると、門を足すとき片方だけ通る(CLAUDE.md §7)。
   * 🔑 入るときは、押したタイルに印も付ける(どれを動かすのか画面に残す)。
   */
  'start-tile-reorder': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-tile');
    if (lid !== null && lid !== '') dispatcher.dispatch({ type: 'PICK_APP_TILE', lid });
    dispatcher.dispatch({ type: 'SET_LAUNCHER_REORDER', on: true });
  },
  'end-tile-reorder': (dispatcher) => {
    dispatcher.dispatch({ type: 'SET_LAUNCHER_REORDER', on: false });
  },
  /**
   * 🔴 **添付のファイルを差し替える**(#1163 依頼 212)。ファイルを選ぶ欄を開く ── 差し替え先は**押したボタンが持つ**
   * (`selectedLid` ではない ── 留めた枠でも、その枠のノートに効く)。選んだあとは `change` が受ける。
   */
  'replace-attachment-file': (dispatcher, target, _services, root) => {
    const lid = targetLid(dispatcher, target);
    if (!lid) return;
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="replace-input"]');
    if (input === null) return;
    input.setAttribute('data-pkc-replace-lid', lid);
    input.click();
  },
  'attach-file': (_dispatcher, _target, _services, root) => {
    // 常設の hidden input を開く(動的生成にしない ── smoke の setInputFiles と
    // ブラウザの user-gesture 要件の両方に効く)
    /**
     * 🔴 **押した物から辿らない**(#632 段① の着地前レビュー 欠陥 1)。
     *
     * ⚠ 直す前は `target.closest('[data-pkc-region="shell"]')` だったので、
     *   **`⋯` のメニューから押すと必ず null** になり、`?.` が全部飲んで
     *   **無反応・理由なし**だった(スマホには添付の道が他に 1 本も無い)。
     *   メニューの器は **root の直下**に出るので、押したボタンは shell の中に居ない
     *   ── `context-menu.ts` が自分でそう戒めている当の罠である。
     * 🔑 束ねた `root` から引けば、どこから押しても同じ入力欄に届く。
     */
    root.querySelector<HTMLInputElement>('[data-pkc-field="attach-input"]')?.click();
  },
  /**
   * 🔴 **録音・画面録画**(#413)。⚠ 段取り(帯 / 添付 / 本文への参照)は
   *   `capture.ts` が持つ ── ここは撃つだけ。
   *
   * ⚠ **`BODY_WRITE_ACTIONS` には載せない。** 止めると本文へ参照が入るので
   *   一見この門に載るべきに見えるが、⚠ **忙しい間に「止める」を断ると
   *   マイクが回り続ける** ── 収録は取り直せないので、止められないほうが害が
   *   大きい。⚠ 本文へ入れられない回は `capture.ts` が**理由を出して**畳む
   *   (黙って落とす経路は作っていない)。
   */
  'start-audio-capture': (dispatcher, _target, services) => {
    if (!services.startCapture) return refuseNoCapture(dispatcher);
    services.startCapture('audio');
  },
  'start-screen-capture': (dispatcher, _target, services) => {
    if (!services.startCapture) return refuseNoCapture(dispatcher);
    services.startCapture('screen');
  },
  'stop-capture': (_dispatcher, _target, services) => services.stopCapture?.(),
  'discard-capture': (_dispatcher, _target, services) => services.discardCapture?.(),
  /**
   * 🔴 **タイマー**(#279)。
   * ⚠ **`BODY_WRITE_ACTIONS` には載せない**(収録と同じ理由)── 忙しい間に
   *   「止める」を断ると、⚠ **断られている間も経過が伸びて、記録が実際より
   *   長くなる**。書けない回は `timer.ts` が**預かって、編集を終えたら書く**。
   */
  'start-timer': (dispatcher, _target, services) => {
    if (!services.startTimer) return refuseNoTimer(dispatcher);
    services.startTimer();
  },
  'stop-timer': (_dispatcher, target, services) => {
    const lid = target.getAttribute('data-pkc-timer');
    if (lid !== null) services.stopTimer?.(lid);
  },
  'discard-timer': (_dispatcher, target, services) => {
    const lid = target.getAttribute('data-pkc-timer');
    if (lid !== null) services.discardTimer?.(lid);
  },
  /**
   * 🔴 **鳴った予定を開く**(#280)。⚠ **開いたら片付ける** ── 開いたのに
   *   帯に残っていると、user は「押しても消えない」と読む。
   * ⚠ 選択は既存の `SELECT_ENTRY` を通す(開く経路を 2 本にしない)。
   */
  'open-alarm': (dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-alarm');
    const lid = target.getAttribute('data-pkc-entry');
    const st = dispatcher.getState();
    /**
     * 🔴 **開けないときは理由を言い、帯は残す**(#1087 の見直し 2026-10-13)。
     * ⚠ 直す前は `SELECT_ENTRY` を撃つだけで、別のノートを編集中だと reducer が黙って捨て、
     *   **帯の知らせだけが消えた**(開かず、理由も出ず、もう一度押す所も無い)。
     * 🔑 開く口は `selectEntryOrExplain`(リンクと同じ断り文)。⚠ そのノートを既に開いているなら
     *   選び直さない(編集中のそのノートで「編集を保存するか、編集をやめてから開いて」と言わない)。
     */
    if (lid !== null && st.entryMetas.has(lid) && st.selectedLid !== lid) {
      const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
      if (!selectEntryOrExplain(dispatcher, lid, '予定のノート', root, services)) return;
    }
    if (key !== null) services.dismissAlarm?.(key);
  },
  'dismiss-alarm': (_dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-alarm');
    if (key !== null) services.dismissAlarm?.(key);
  },
  /**
   * 🔴 **絵を押したら、別窓で大きく開く**(#527)。図(mermaid)と
   * **本文に貼った画像**の両方が通る。
   *
   * ⚠ **押し所は絵そのもの** ── ボタンを置くと絵の数だけ常設の物が増える
   *   (#501 と逆向き)。⚠ 押した絵の `src`(ObjectURL)を渡すだけで、
   *   **焼き直さない**。
   * ⚠ 題名は `alt` から採る ── 絵しか無い面で唯一の情報であり、
   *   窓の題名として user に読める(図は種類、画像は user が書いた説明が入る)。
   * 🔑 **どの絵に印を付けるかは `render/view-big.ts` が 1 か所で決める**
   *   (編集の面では付けない ── あちらは原文が開くのが動線)。
   */
  'view-big': (_dispatcher, target, services, root) => {
    const img = target.closest<HTMLImageElement>('img[data-pkc-action="view-big"]');
    if (!img || img.src === '') return;
    const mmd = img.closest<HTMLElement>('[data-pkc-mermaid-src]');
    const chart = img.closest<HTMLElement>('[data-pkc-chart-src]');
    const src = mmd?.getAttribute('data-pkc-mermaid-src') ?? '';
    const csrc = chart?.getAttribute('data-pkc-chart-src') ?? '';
    const diagram =
      src !== ''
        ? { kind: 'mermaid' as const, source: src }
        : csrc !== ''
          ? { kind: 'chart' as const, source: csrc }
          : undefined;

    // 🔴 章ウィンドウなど、別ドキュメントの窓で押されたときはその場で実寸別窓を開く
    if (img.ownerDocument !== root.ownerDocument) {
      services.viewBig?.(
        img.src,
        img.alt || '図',
        diagram,
        img.ownerDocument.defaultView ?? undefined,
      );
      return;
    }

    openLightbox(
      root,
      {
        src: img.src,
        alt: img.alt || '図',
        diagram,
        defaultView: img.ownerDocument.defaultView ?? undefined,
      },
      services,
    );
  },
  'close-lightbox': (_dispatcher, _target, _services, root) => {
    closeLightbox(root);
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
    /**
     * 🔴 **番号とノートは、押した図から引く**(#1044 段4 着地前レビュー)。
     * ⚠ 章の別ウィンドウの図は本体の画面に居ないので、本体の画面で数えると**必ず 1 番目**、
     *   題名は本体で**いま選んでいる**ノートになっていた ── 窓は全文の並びで番号を焼き
     *   (`CHAPTER_DIAGRAM_INDEX_ATTR`)、本文の器にノートを焼く(`lidOfNode` が読む)。
     *   焼いていない面(本体)はこれまでどおり画面の並びで数える。
     */
    const burned = Number(host.getAttribute(CHAPTER_DIAGRAM_INDEX_ATTR) ?? NaN);
    const all = [...diagramScopeOf(host, root).querySelectorAll('[data-pkc-mermaid-src]')];
    const index = Number.isInteger(burned) && burned >= 0 ? burned : Math.max(0, all.indexOf(host));
    // ⚠ 引けなければ `undefined` ── 本体のノートへ落とすのは受け手(`exportDiagram`)の仕事
    //    (この受け手は選択を読まない ── 押した図の持ち主だけを運ぶ)
    const lid = lidOfNode(host, null);
    const done = services.exportDiagram?.(source, index, lid ?? undefined);
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
   * ⚠ **`value` 直代入も `setRangeText` もしない** ── Ctrl+Z の履歴を捨てるので `insertText`(#765)。
   */
  'renumber-lists': (dispatcher, target, services) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const ta = formatTarget(root);
    // 🔴 1 面のライブ編集の欄(`row-source`)は**押した 1 ブロックだけ**を持つ ── 全文の道具を
    //   当てて「揃っています」と言うのは偽。欄が無いのに編集中(行を閉じた間)も同じ行き先を言う。
    if (isLiveBlockField(ta) || (ta === null && dispatcher.getState().phase === 'editing')) {
      services.showStatus?.(RENUMBER_LIVE_NOTE);
      return;
    }
    if (ta === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集中に押してください' });
      return;
    }
    const next = renumberLists(ta.value);
    // ⚠ **変わらなかったことを言う** ── 押して無反応にしない
    if (next === ta.value) {
      services.showStatus?.(
        hasNumberedItems(ta.value) ? '番号はもう揃っています' : 'このノートに番号付きリストはありません',
      );
      return;
    }
    // ⚠ 書くのは `insertText`(取り消しに載る)── 変わった範囲だけを置き換える
    ta.focus();
    // 🔴 カーソルは `replaceChanged` が置いた所(変えた範囲の終わり)のまま ── 末尾へ飛ばさない(#1087)
    replaceChanged(ta, next);
    services.showStatus?.('番号を振り直しました');
  },
  /**
   * 🔴 チェックリスト（Todo）の完了項目整理 (#1108)。
   *
   * 完了した項目（- [x]）を各リストブロックの末尾へ移動する。
   * 効く先は書式パネルと同じ 1 か所(formatTarget)── 2 列でも live でも動く。
   * ⚠ `insertText` で書く(Undo 履歴に載る。`setRangeText` は履歴を捨てる ── #765)。
   */
  'sort-tasks': (dispatcher, target, services) => {
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const ta = formatTarget(root);
    // 🔴 `renumber-lists` と同じ理由(ライブ編集の欄は 1 ブロックだけ)
    if (isLiveBlockField(ta) || (ta === null && dispatcher.getState().phase === 'editing')) {
      services.showStatus?.(SORT_TASKS_LIVE_NOTE);
      return;
    }
    if (ta === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '編集中に押してください' });
      return;
    }
    // 🔴 カーソルのあるリストだけ(台帳 #1852 I2 / 依頼 87-2)。リストの外にカーソルがあれば、これまでどおりすべてのリスト
    const sorted = sortTasksAtCaret(ta.value, caretLineOf(ta.value, ta.selectionStart));
    const next = sorted.text;
    const here = sorted.scope === 'caret';
    if (next === ta.value) {
      services.showStatus?.(
        hasTaskItems(ta.value)
          ? here
            ? 'このリストの完了項目は既に末尾に揃っています'
            : '完了項目は既に末尾に揃っています'
          : 'このノートにチェック項目はありません',
      );
      return;
    }
    // ⚠ 書くのは `insertText`(取り消しに載る)── 変わった範囲だけを置き換える
    ta.focus();
    const before = ta.value;
    const caret = ta.selectionStart ?? before.length;
    replaceChanged(ta, next);
    // 🔴 カーソルは押す前にいた行へ戻す(#1163 の依頼 100-2)── 置き換えた範囲の終わりのままだと、長いノートでいた場所を見失う
    const back = caretAfterReplace(before, ta.value, caret);
    ta.setSelectionRange(back, back);
    services.showStatus?.(here ? 'このリストの完了したチェック項目を末尾へ移動しました' : '完了したチェック項目を末尾へ移動しました');
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
    // 🔴 解決規則は `rowLidOrSelected` の 1 本(#877)── 直す前は常に
    //   `selectedLid` だったので、行のメニューを開いたまま選択が動くと
    //   **別のノートの本文**を写してしまえた(下の `openBody` 一致で本文自体は
    //   守られていたが、`lid` が動けば一致の基準ごとズレる)
    const lid = rowLidOrSelected(st, target);
    // ⚠ 本文は**開いているノートの物**でなければならない(別のノートを写さない)
    const body = st.openBody?.lid === lid ? st.openBody.body : null;
    if (lid === null || body === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '本文を開いてから押してください' });
      return;
    }
    const plain = stripDialect(body);
    if (services.copyText === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'このタブの PKC3 が古いままのため、コピーできません。再読み込みしてください' });
      return;
    }
    /**
     * 🔴 **字は `copyText` に渡す**(2026-08-29 の動線レビュー 欠陥 2)。
     * ⚠ 直す前はここで `showStatus` を撃っていたが、clipboard の `.then` が
     *   **後から「参照をコピーしました(本文に貼れます)」で上書き**していた ──
     *   本文を全部写しているのに**参照を写したと言われる**(実測)。
     */
    services.copyText(plain, '素の Markdown をコピーしました(他のツールに貼れます)');
    void target;
  },
  /**
   * 🔴 **見出しで畳む**(#396)。⚠ 規則も器への当て方も
   *   `render/heading-fold.ts` に在る ── ここは**渡すだけ**。
   * ⚠ 本文の中身は 1 バイトも変わらない(見え方だけ)ので、
   *   `BODY_WRITE_ACTIONS` には**載せない**(取り込み中でも畳んでよい)。
   */
  'toggle-heading-fold': (dispatcher, target) => {
    if (refuseStaleMenu(dispatcher, target)) return;
    /**
     * 🔴 **右クリックからも来る**(#426 段②)── そのとき押したボタンは
     * 器の直下に居るので、`closest` では見出しに当たらない。
     * 🔑 判定は `headingForAction` **1 本**(2 つ目の綴りを生やさない。§7)。
     */
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const heading = headingForAction(root, target);
    if (heading !== null) toggleHeadingFold(heading);
  },
  /**
   * 🔴 **ログの日をまとめて畳む / 戻す**(#1441)。⚠ 規則も当て方も `render/log-days.ts` と
   *   `heading-fold.ts` に在る ── ここは**渡すだけ**。
   * ⚠ 本文は 1 バイトも変わらない(見え方だけ)ので `BODY_WRITE_ACTIONS` には載せない。
   */
  'toggle-log-day': (_dispatcher, target) => {
    const row = target.closest<HTMLElement>('[data-pkc-log-day]');
    if (row !== null) toggleLogDay(row);
  },
  /**
   * 🔴 **長大なコードブロックの折りたたみ／展開切り替え**(#1139)。
   * ⚠ 本文の中身は 1 バイトも変わらない(見え方だけ)ので、
   *   `BODY_WRITE_ACTIONS` には載せない(取り込み中でも操作可能)。
   */
  'toggle-code-collapse': (_dispatcher, target) => {
    const block = target.closest<HTMLElement>('.pkc-md-block[data-pkc-md-block-kind="code"]');
    if (block !== null) toggleCodeCollapse(block);
  },
  /**
   * 🔴 **その章だけを、読む面のその場で編集する**(#1044 段2)。
   *
   * ⚠ **アプリ全体は編集中にならない**(`phase` は `ready` のまま)── 門は
   * `startSectionEditAt` **1 本**(ロック / reducer への委譲)。
   */
  'edit-section': (dispatcher, target, services, root) => {
    const line = menuCarriedLine(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    startSectionEditAt(dispatcher, services, root, line);
  },
  /**
   * 🔴 **その章を、読むだけの別のウィンドウで開く**(#1044 段4。裁定 Q3「読むだけ」)。
   *
   * ⚠ **書けるかどうかには依らない**(編集中・別のタブのロックでも開ける)── 読むだけなので、
   *   本文を 1 バイトも書き換えない。だから `BODY_WRITE_ACTIONS` にも載せない。
   * ⚠ 身元はメニューが運んだ lid(`refuseStaleMenu` が「いま開いているノート」と一致を確かめる)。
   */
  'open-chapter-window': (dispatcher, target, services) => {
    const line = menuCarriedLine(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    const lid = dispatcher.getState().openBody?.lid;
    if (lid === undefined) return;
    services.openChapterWindow?.(lid, line);
  },
  /**
   * 🔴 **その見出しから編集に入る**(#426 段②)。
   *
   * ⚠ 近道(`Ctrl` / `⌘` + クリック)は**そのまま残す** ── #426 の
   * 「既存の操作を移さない。増やすだけ」。🔑 効き先も同じ `START_EDIT` である
   * (別の入口に別の意味を持たせない)。
   */
  'edit-from-heading': (dispatcher, target, services) => {
    const line = menuCarriedLine(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    // 🔑 門は `startEditAt` **1 本**(飛んでいる書込を待つ / 別タブのロック / 返し)
    startEditAt(dispatcher, services, line);
  },
  /**
   * 🔴 **その見出しを追記先にする**(#426 段②)。
   *
   * ⚠ 断り文まで含めて `pickAppendTarget` **1 本**に任せる ── ここで
   * 追記できるかを別に判定すると、近道(`Alt` + クリック)と食い違う日が来る。
   */
  'append-at-heading': (dispatcher, target) => {
    const line = menuCarriedLine(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    pickAppendTarget(dispatcher, root, line);
  },
  /**
   * 🔴 **その章を原文の Markdown でまるごと写す**(#677。user 裁定 2026-09-04)。
   *
   * 範囲は「見出しの行 〜 次の同段以上の見出しの直前」(`chapterSpanOf` ── 畳みと同じ
   * 塊の数え方)。⚠ 写すのは **frontmatter を剥いだ本文**の行 ── 刻印がその座標なので、
   *   全文 body で切ると frontmatter の行数ぶんずれた別の章を写す。
   * ⚠ 見出しが引けなければ理由を出す(押した瞬間にメニューは畳まれるので、黙って
   *   `return` すると dead click になる ── `refuseStaleMenu` と同じ理由)。
   */
  'copy-chapter-md': (dispatcher, target, services) => {
    const line = menuCarriedLine(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const host = root.querySelector<HTMLElement>(BODY_HOST_SELECTOR);
    const heading = host === null ? null : headingAtSourceLine(host, line);
    const ob = dispatcher.getState().openBody;
    if (host === null || heading === null || ob === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '章の範囲を読めませんでした(本文を開き直してください)' });
      return;
    }
    const fmBody = bodyBelowFrontmatter(ob.body);
    const span = chapterSpanOf(host, heading, fmBody.split('\n').length);
    if (span === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '章の範囲を読めませんでした(本文を開き直してください)' });
      return;
    }
    copySourceLines(dispatcher, services, fmBody, span, '章をコピーしました(Markdown の原文)');
  },
  /**
   * 🔴 **その章を指すリンクを写す**(#579。user 裁定 2026-09-04)。
   *
   * 貼れる 1 行は `[題名 / 見出し](entry:<lid>#h/<見出しの id>)`。押すと相手のノートを開いて
   * その見出しまで送る(`navigateToLink` → `tocJump`)。
   * ⚠ id は描画が刻んだ物(`h.id`)を**そのまま読む** ── 自前で slug を計算しない
   *   (計算が 2 か所になると、同名見出しの連番 `-1` で食い違う)。
   * ⚠ 見出しは**入れ子でも拾う**(引用や `:::` の中にも id は刻まれる)── `headingAtSourceLine`
   *   は直下しか見ないので、外れたら刻印で深く探す。
   * ⚠ id の無い見出し(`####` 以下)ではメニューに出ない(`linkable`)が、受け手でも理由を出す。
   */
  'copy-section-ref': (dispatcher, target, services) => {
    const line = menuCarriedLine(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const host = root.querySelector<HTMLElement>(BODY_HOST_SELECTOR);
    const heading = carriedHeading(host, line);
    const st = dispatcher.getState();
    // ⚠ 相手は**開いている本文**(`copy-chapter-md` と同じ)── 見出しは openBody の描画である
    const lid = target.getAttribute(MENU_LID_ATTR) || st.openBody?.lid;
    if (heading === null || lid === undefined || lid === '') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '見出しを読めませんでした(本文を開き直してください)' });
      return;
    }
    if (heading.id === '') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: 'この見出しには参照できる ID が無いので、章の参照を作れません(# 〜 ### の見出しで使えます)',
      });
      return;
    }
    if (services.copyText === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'このタブの PKC3 が古いままのため、コピーできません。再読み込みしてください' });
      return;
    }
    const text = headingPlainText(heading);
    const title = st.entryMetas.get(lid)?.title ?? '';
    const label = title === '' ? text : `${title} / ${text}`;
    services.copyText(
      formatSectionLink(label, lid, heading.id),
      '章へのリンクをコピーしました(本文に貼れます)',
    );
  },
  /**
   * 🔴 **その章 / ログの行を指す、外へ貼れるリンクを写す**(#1559)。
   *
   * 貼れるのは `<アドレス>#pkc?container=…&entry=<lid>&fragment=h/<見出しの id>` ── ブラウザやメールに貼ると、
   * この PKC のそのノートを開いて**その見出しまで送り、光らせる**(`deep-link.ts` → `jumpToLinkedSection`)。
   * ⚠ 本文に貼る「参照」(`copy-section-ref`)とは**別物**。見出しの引き方も id も同じ(`carriedHeading`、描画が刻んだ `h.id`)。
   * ⚠ 組めない / 引けないときは理由を出す(押した瞬間にメニューは畳まれる ── 黙ると dead click)。
   */
  'copy-section-link': (dispatcher, target, services) => {
    const line = menuCarriedLine(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    const root = target.closest<HTMLElement>('[data-pkc-slot="root"]') ?? target.ownerDocument.body;
    const host = root.querySelector<HTMLElement>(BODY_HOST_SELECTOR);
    const heading = carriedHeading(host, line);
    const st = dispatcher.getState();
    const lid = target.getAttribute(MENU_LID_ATTR) || st.openBody?.lid;
    if (heading === null || lid === undefined || lid === '') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '見出しを読めませんでした(本文を開き直してください)' });
      return;
    }
    const row = isLogRowHeading(
      st.entryMetas.get(lid)?.archetype,
      headingLevel(heading),
      headingPlainText(heading),
    );
    const what = row ? 'この行' : 'この章';
    if (heading.id === '') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `この見出しには参照できる ID が無いので、${what}のリンクを作れません(# 〜 ### の見出しで使えます)`,
      });
      return;
    }
    const url = sectionPermalink(st.cid, lid, heading.id);
    if (url === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${what}のリンクを作れませんでした(この PKC のアドレスが読めません)` });
      return;
    }
    if (services.copyText === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'このタブの PKC3 が古いままのため、コピーできません。再読み込みしてください' });
      return;
    }
    services.copyText(url, `${row ? '行' : '章'}のリンクをコピーしました(ブラウザやメールに貼れます)`);
  },
  /**
   * 🔴 **`:::` の塊(囲み / 板)を原文の Markdown でまるごと写す**(#677)。
   *
   * 範囲は「開きの `:::` 〜 閉じの `:::`」(`blockSpanAt`)。板なら座標(`x=` / `y=`)も
   * 開き行に載っているので、そのまま貼れば同じ場所に置かれる。
   * ⚠ 閉じていない塊は**写さずに断る** ── 末尾まで飲んでいるので「塊」の範囲が無い。
   *   理由を出す(user はそこで閉じ忘れに気づける)。
   */
  'copy-block-md': (dispatcher, target, services) => {
    const line = menuCarriedBlock(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    const ob = dispatcher.getState().openBody;
    const fmBody = ob === null ? null : bodyBelowFrontmatter(ob.body);
    const span = fmBody === null ? null : blockSpanAt(fmBody, line);
    if (fmBody === null || span === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'ブロックの範囲を読めませんでした(本文を開き直してください)' });
      return;
    }
    if (span.open) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: 'このブロックは閉じていないのでコピーできません(閉じの ::: を足してください)',
      });
      return;
    }
    const board = isPlaceOpen(fmBody.split('\n')[line] ?? '');
    copySourceLines(
      dispatcher,
      services,
      fmBody,
      span,
      board ? '板をコピーしました(Markdown の原文)' : 'ブロックをコピーしました(Markdown の原文)',
    );
  },
  /**
   * 🔴 **右クリックした所に板を置く**(#676。user 裁定 2026-09-04)。
   *
   * 座標はメニューが運んできた物(`MENU_X_ATTR` / `MENU_Y_ATTR` = 本文の器の左上からの px)。
   * 書くのは `ADD_PLACE` → reducer の門 → `REQUEST_BODY_REWRITE`(`place-add`)── 本文の末尾に
   * 空の塊が足され、再描画でその座標に置かれる。編集中の断りは reducer が出す。
   * ⚠ 座標が読めない形は画面からは起きない(運ぶのは同じ `onContextMenu`)が、
   *   黙って何も起きないを作らない ── 理由を出す。
   */
  'add-place': (dispatcher, target, services) => {
    if (refuseStaleMenu(dispatcher, target)) return;
    const ob = dispatcher.getState().openBody;
    const x = menuCarriedAt(target, MENU_X_ATTR);
    const y = menuCarriedAt(target, MENU_Y_ATTR);
    if (ob === null || x === null || y === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '置く位置を読めませんでした(本文を開き直してください)' });
      return;
    }
    const lid = ob.lid;
    placeEditedElsewhereGate(dispatcher, services, lid, '板を置けませんでした', () =>
      dispatcher.dispatch({ type: 'ADD_PLACE', lid, x, y }),
    );
  },
  /**
   * 🔴 **ほかのノートを板に置く**(#1662 2。Gemini 裁定 = #1163 依頼 48 の 2 = A)── 題名で探して選ぶ小窓で 1 つ選ぶと、
   * `add-place` と同じ座標・同じ門(`ADD_PLACE`)で、そのノートの付箋(`entry=`)を本文の末尾に書く。
   * ⚠ 器は `pickEntryInApp`(「ノートリンクを入れる」と同じ探し方)── user に 2 通りの探し方を覚えさせない。
   *   自分自身は候補から外す(板に自分を置いても何も映らない)。
   * ⚠ 窓が開いている間に別のノートへ移ったら置かない / 選んだノートが消えていたら理由を言う。
   */
  'add-place-note': (dispatcher, target, services, root) => {
    if (refuseStaleMenu(dispatcher, target)) return;
    const ob = dispatcher.getState().openBody;
    const x = menuCarriedAt(target, MENU_X_ATTR);
    const y = menuCarriedAt(target, MENU_Y_ATTR);
    if (ob === null || x === null || y === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '置く位置を読めませんでした(本文を開き直してください)' });
      return;
    }
    const lid = ob.lid;
    void pickEntryInApp(
      root,
      (query) => {
        const st = dispatcher.getState();
        const items = entryPickRows(st.entryMetas, st.order, query, lid);
        return { items, note: entryPickNote(items.length, entryPickTotal(st.entryMetas, st.order, query, lid)) };
      },
      { title: 'ノートを板に置く' },
    ).then((picked) => {
      if (picked === null) return;
      const st = dispatcher.getState();
      if (st.openBody?.lid !== lid) {
        dispatcher.dispatch({ type: 'OP_NOTICE', message: '別のノートに切り替わったので、付箋は置いていません' });
        return;
      }
      if (!st.entryMetas.has(picked)) {
        dispatcher.dispatch({ type: 'OP_FAILED', error: 'ノートが見つかりません(消されたかもしれません)' });
        return;
      }
      placeEditedElsewhereGate(dispatcher, services, lid, '付箋を置けませんでした', () =>
        dispatcher.dispatch({ type: 'ADD_PLACE', lid, x, y, entry: picked }),
      );
    });
  },
  /**
   * 🔴 **テンプレートから板を置く**(#529 W4)── 窓で 1 つ選ぶと、`add-place` と同じ座標・同じ門
   * (`ADD_PLACE`)で書く。「やめる」/ `Escape` なら何もしない。
   * ⚠ 窓が開いている間に別のノートへ移ったら置かない(`ob.lid` を窓の前後で照らす)。
   */
  'add-place-template': (dispatcher, target, services, root) => {
    if (refuseStaleMenu(dispatcher, target)) return;
    const ob = dispatcher.getState().openBody;
    const x = menuCarriedAt(target, MENU_X_ATTR);
    const y = menuCarriedAt(target, MENU_Y_ATTR);
    if (ob === null || x === null || y === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '置く位置を読めませんでした(本文を開き直してください)' });
      return;
    }
    const lid = ob.lid;
    void pickPlaceTemplateInApp(root).then((template) => {
      if (template === null) return;
      if (dispatcher.getState().openBody?.lid !== lid) {
        dispatcher.dispatch({ type: 'OP_NOTICE', message: '別のノートに切り替わったので、板は置いていません' });
        return;
      }
      placeEditedElsewhereGate(dispatcher, services, lid, '板を置けませんでした', () =>
        dispatcher.dispatch({ type: 'ADD_PLACE', lid, x, y, template }),
      );
    });
  },
  /**
   * 🔴 **枠の位置と大きさを数で入れる**(#529 W2)── 窓に**いまの値**を入れて開き、「決める」で
   * `SET_PLACE_RECT`(x= y= w= h= を一度に書く)。「やめる」/ `Escape` なら何も書かない。
   * ⚠ 行の座標は `raise-place` と同じ(メニューが運んだ刻印 + frontmatter ぶん)。
   * ⚠ 窓が開いている間に本文が動いたら、開き行の byte 一致の門(`place-notation.ts`)が断る
   *   (別の枠に書かない)。
   */
  'place-rect': (dispatcher, target, services, root) => {
    const line = menuCarriedBlock(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    const ob = dispatcher.getState().openBody;
    if (ob === null) return;
    const lid = ob.lid;
    const at = line + frontmatterLineCount(ob.body);
    const initial = placeRectOf(ob.body.split('\n')[at] ?? '');
    if (initial === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '板が見つかりません(本文を開き直してください)' });
      return;
    }
    // ⚠ 窓を開いた時点の本文を控える ── reducer の開き行の門は dispatch 時点の本文から行を取り直すので、
    //   窓の間に本文が動く(別のタブ・追記)と、同じ行番号に来た**別の板**へ書いてしまう(着地前レビュー)
    const bodyAtOpen = ob.body;
    void pickPlaceRectInApp(root, initial).then((rect) => {
      if (rect === null) return;
      const now = dispatcher.getState().openBody;
      if (now?.lid !== lid) {
        dispatcher.dispatch({ type: 'OP_NOTICE', message: '別のノートに切り替わったので、位置と大きさは変えていません' });
        return;
      }
      if (now.body !== bodyAtOpen) {
        dispatcher.dispatch({ type: 'OP_NOTICE', message: '開いている間に本文が変わったので、位置と大きさは変えていません(もう一度開いてください)' });
        return;
      }
      // 全部の欄を空のまま決めたら、何も変えない(書換の依頼を出さない)
      if (Object.keys(rect).length === 0) return;
      placeEditedElsewhereGate(dispatcher, services, lid, '位置と大きさを変えられませんでした', () =>
        dispatcher.dispatch({ type: 'SET_PLACE_RECT', lid, line: at, rect }),
      );
    });
  },
  /**
   * 🔴 **右クリックした板を消す**(#676)── 置けるなら消せる(user 指示 2026-08-23)。
   *
   * ⚠ 取り消せない(板の書換は履歴を伸ばさない amend)ので**確認を挟む**(`delete-entry` と
   *   同じ `confirmThen`)。⚠ confirm より**前**に編集中を断る ── 確認まで出してから黙って
   *   捨てる形にしない(`delete-entry` と同じ理由)。
   * ⚠ 行はメニューが運んだ塊の開き行(frontmatter を剥いだ座標)── reducer は生の body の
   *   行番号を受けるので、`frontmatterLineCount` を足して渡す(`bodySourceLineAt` と同じ規律)。
   */
  /**
   * 🔴 **右クリックした板を前へ出す**(#676 段②)── 他の板の z= の最大 + 1 を書く。
   * 確認は要らない(重なりの順が変わるだけで、もう一度別の板を前へ出せば戻る)。
   * ⚠ 行の座標は `remove-place` と同じ(刻印 + frontmatter ぶん)。
   */
  'raise-place': (dispatcher, target, services) => {
    const line = menuCarriedBlock(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    const ob = dispatcher.getState().openBody;
    if (ob === null) return;
    const lid = ob.lid;
    const at = line + frontmatterLineCount(ob.body);
    placeEditedElsewhereGate(dispatcher, services, lid, '板を前へ出せませんでした', () =>
      dispatcher.dispatch({ type: 'RAISE_PLACE', lid, line: at }),
    );
  },
  /**
   * 🔴 **右クリックした板の形を変える**(#530 案 A。user 裁定 2026-09-14)。
   *
   * 🔑 **形の数だけ受け手を書く**(`placeShapeHandler` の 1 本を 5 回呼ぶ)──
   *   ⚠ `Object.fromEntries` で生やすと綴りが**字として file に残らない**ので、
   *   `repo-hygiene` の「受け手がいない action」の全数走査から**見えなくなる**
   *   (受け手は在るのに、在ることを機械が確かめられない = §1 の空振り)。
   * ⚠ 書き忘れは `tests/adapter/place-shape-menu.test.ts` が全数で落とす。
   * 確認は要らない(見た目が変わるだけで、もう一度別の形を選べば戻る ── `raise-place` と同じ)。
   */
  'place-shape-rect': placeShapeHandler('rect'),
  'place-shape-round': placeShapeHandler('round'),
  'place-shape-ellipse': placeShapeHandler('ellipse'),
  'place-shape-diamond': placeShapeHandler('diamond'),
  'place-shape-arrow': placeShapeHandler('arrow'),
  /**
   * 🔴 **右クリックした表の形を変える**(#708 段②。user 裁定 2026-09-04)。
   *
   * 🔑 **向きだけが違う 2 つを 1 本にする**(`moveStackLink` と同じ作法 ── §7)。
   * ⚠ 何をするかの判断は `table-convert.ts` / `body-rewrite.ts` ── ここは
   *   **押した所の行を渡し、断る理由が在れば画面に出す**だけである。
   */
  'table-to-markdown': (dispatcher, target, services) =>
    setTableFormat(dispatcher, target, 'markdown', services),
  'table-to-csv': (dispatcher, target, services) =>
    setTableFormat(dispatcher, target, 'csv', services),
  /**
   * 🔴 **右クリックしたチェックリストを丸ごとそろえる**(#1173)。
   * 🔑 向きだけが違う 2 つを 1 本にする(`table-to-*` と同じ作法 ── §7)。
   */
  /**
   * 🔴 **押したブロックを、ひとつ上・ひとつ下へ動かす**(台帳 #1852 束 S1、依頼 238 の案 B)。
   * ⚠ 座標は項目が運ぶ(右クリック / 長押しで開いた時点の本文のもの)。`MOVE_BLOCK` は画面の本文の行と突き合わせて
   *   書くので、別の窓が動かして行がずれていれば断る(ドラッグで落としたときと同じ門)。
   */
  'move-block-step': (dispatcher, target, services) => {
    if (refuseStaleMenu(dispatcher, target)) return;
    const lid = target.getAttribute(MENU_LID_ATTR) ?? '';
    const start = menuCarriedAt(target, MENU_BLOCK_START_ATTR);
    const end = menuCarriedAt(target, MENU_BLOCK_END_ATTR);
    const toBefore = menuCarriedAt(target, MENU_BLOCK_BEFORE_ATTR);
    if (lid === '' || start === null || end === null || toBefore === null) return;
    actUnlessEditedElsewhere(
      dispatcher,
      services,
      [lid],
      '動かせませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
      () => dispatcher.dispatch({ type: 'MOVE_BLOCK', lid, start, end, toBefore }),
    );
  },
  'task-run-open': (dispatcher, target, services) => setTaskRun(dispatcher, target, 'open', services),
  'task-run-done': (dispatcher, target, services) => setTaskRun(dispatcher, target, 'done', services),
  /**
   * 🔴 **右クリックした画像の大きさ・寄せを書く**(#1640 ③。依頼 37 = A)。
   * 🔑 向きだけが違う 2 つを 1 本にする(`task-run-*` と同じ作法 ── §7)。値は押した項目の属性が運ぶ
   *   (空 = もとに戻す = 札を外す)。
   */
  'image-width': (dispatcher, target, services) => setImageAttr(dispatcher, target, services, 'w'),
  'image-align': (dispatcher, target, services) => setImageAttr(dispatcher, target, services, 'align'),
  /**
   * 🔴 **付箋・線の色を選ぶ**(#530 段④。Gemini 裁定 A)── 右クリックの「塗りの色…」「枠の色…」(線は「色…」)。
   *
   * 🔑 選ぶ窓は**本文の色コードの見本と同じ 1 つ**(`openColorPicker`)── 新しい部品を作らない。
   *   窓を開く前に断る(編集中・別のノートへ替わった後)。`change` で 1 回だけ書く。
   * ⚠ どの札(`fill` / `stroke`)かは**項目が運ぶ**(`PLACE_STYLE_KEYS_ATTR`)── ちょうど 1 つ。
   *   窓の初期値は**いまの色**(無ければ地に近い無彩色)。⚠ 同じ色を選んだときは書かない。
   */
  'place-color': (dispatcher, target, services) => {
    const keys = styleKeysOf(target);
    if (keys.length !== 1) return;
    const key = keys[0]!;
    placeStyleWrite(
      dispatcher,
      target,
      (lid, line) => {
        const ob = dispatcher.getState().openBody;
        const open = ob === null ? '' : (ob.body.split('\n')[line] ?? '');
        const cur = placeStyleAt(open)?.[key] ?? null;
        // ⚠ 窓を開いた時点の本文を控える ── reducer の開き行の門は dispatch 時点の本文から行を取り直すので、
        //   窓の間に別のタブが上の行を増減すると、同じ行番号に来た**別の付箋**を塗ってしまう(#1087)
        const bodyAtOpen = ob?.body ?? null;
        openColorPicker(target, cur ?? (key === 'fill' ? PLACE_FILL_SEED : PLACE_STROKE_SEED), (to) => {
          if (parsePlaceColor(to) === null || to === cur) return;
          const now = dispatcher.getState().openBody;
          if (now?.lid !== lid) {
            dispatcher.dispatch({ type: 'OP_NOTICE', message: '別のノートに切り替わったので、色は変えていません' });
            return;
          }
          if (now.body !== bodyAtOpen) {
            dispatcher.dispatch({ type: 'OP_NOTICE', message: '開いている間に本文が変わったので、色は変えていません(もう一度開いてください)' });
            return;
          }
          placeEditedElsewhereGate(dispatcher, services, lid, '色を直せませんでした', () =>
            dispatcher.dispatch({ type: 'SET_PLACE_STYLE', lid, line, style: { [key]: to } }),
          );
        });
      },
      '色を直してください',
    );
  },
  /**
   * 🔴 **色を外す**(#530 段④。置けるなら外せる)── 札を**消す**(`null`)。付箋は塗りと枠の両方、
   * 線は線の色。⚠ 太さは触らない(線の太さを標準に戻す口は別: `place-line-width`)。
   */
  'place-color-clear': (dispatcher, target, services) => {
    const keys = styleKeysOf(target);
    if (keys.length === 0) return;
    const style: Record<string, null> = {};
    for (const k of keys) style[k] = null;
    placeStyleWrite(
      dispatcher,
      target,
      (lid, line) =>
        placeEditedElsewhereGate(dispatcher, services, lid, '色を直せませんでした', () =>
          dispatcher.dispatch({ type: 'SET_PLACE_STYLE', lid, line, style: style as PlaceStyle }),
        ),
      '色を直してください',
    );
  },
  /**
   * 🔴 **線の太さを選ぶ**(#530 段④)── 項目が運ぶ太さ(整数)を書く。空なら標準へ戻す(`width=` を消す)。
   * ⚠ 読めない太さは**書かない**(属性を書き換えられた形)。
   */
  'place-line-width': (dispatcher, target, services) => {
    const raw = target.getAttribute(PLACE_STYLE_WIDTH_ATTR);
    if (raw === null) return;
    const width = raw === '' ? null : parsePlaceWidth(raw);
    if (raw !== '' && width === null) return;
    placeStyleWrite(
      dispatcher,
      target,
      (lid, line) =>
        placeEditedElsewhereGate(dispatcher, services, lid, '線の太さを直せませんでした', () =>
          dispatcher.dispatch({ type: 'SET_PLACE_STYLE', lid, line, style: { width } }),
        ),
      '線の太さを直してください',
    );
  },
  /**
   * 🔴 **線の矢じりを選ぶ**(#530。Gemini 裁定 2026-10-11 依頼 15)── 項目が運ぶ値(`none` / `end` / `both`)を書く。
   * 🔑 `none` は札を**消す**(`arrow=none` と書き足さない ── `place-line-width` の標準へ戻すと同じ作法)。
   * ⚠ 読めない値は**書かない**(属性を書き換えられた形)。
   */
  'place-line-arrow': (dispatcher, target, services) => {
    const raw = target.getAttribute(PLACE_STYLE_ARROW_ATTR);
    if (raw === null) return;
    const read = parseArrowSpell(raw);
    if (read.kind !== 'ok') return;
    placeStyleWrite(
      dispatcher,
      target,
      (lid, line) =>
        placeEditedElsewhereGate(dispatcher, services, lid, '矢じりを直せませんでした', () =>
          dispatcher.dispatch({
            type: 'SET_PLACE_STYLE',
            lid,
            line,
            style: { arrow: read.arrow === 'none' ? null : read.arrow },
          }),
        ),
      '矢じりを直してください',
    );
  },
  /**
   * 🔴 **付箋の文字の大きさを選ぶ**(#530 段⑤a)── 項目が運ぶ値(`small` / `standard` / `large` / `xlarge`)を書く。
   * 🔑 `standard` は札を**消す**(`size=standard` と書き足さない ── `place-line-arrow` の `none` と同じ作法)。
   * ⚠ 読めない値は**書かない**(属性を書き換えられた形)。
   */
  'place-size': (dispatcher, target, services) => {
    const raw = target.getAttribute(PLACE_STYLE_SIZE_ATTR);
    if (raw === null) return;
    const read = parseSizeSpell(raw);
    if (read.kind !== 'ok') return;
    placeStyleWrite(
      dispatcher,
      target,
      (lid, line) =>
        placeEditedElsewhereGate(dispatcher, services, lid, '文字の大きさを直せませんでした', () =>
          dispatcher.dispatch({
            type: 'SET_PLACE_STYLE',
            lid,
            line,
            style: { size: read.size === 'standard' ? null : read.size },
          }),
        ),
      '文字の大きさを直してください',
    );
  },
  /**
   * 🔴 **付箋をグループにする**(#530 段⑤b。Gemini 裁定 2026-10-11 依頼 19 Q3)── 窓で板の付箋を選び、
   * 「グループにする」で `GROUP_PLACES`(選んだ全部に同じ `group=` を 1 回の書込で書く)。
   * 「やめる」/ `Escape` なら何も書かない。
   * ⚠ 窓に並べるのは**グループに入っていない付箋**だけ(入っている付箋を黙って別のグループへ移さない)。
   * ⚠ 窓が開いている間に本文が動いたら書かない(`place-rect` と同じ ── 同じ行番号に来た別の付箋へ書かない)。
   */
  'place-group': (dispatcher, target, services, root) => {
    placeStyleWrite(
      dispatcher,
      target,
      (lid, line) => {
        const ob = dispatcher.getState().openBody;
        if (ob === null) return;
        const items = placeGroupItems(ob.body).filter((it) => it.group === null);
        if (items.length < 2) {
          // ⚠ 数えるのは「グループに入っていない付箋」── 何枚あっても全部グループ済みなら 0(理由を取り違えない。#1087)
          dispatcher.dispatch({
            type: 'OP_NOTICE',
            message: 'グループに入っていない付箋が 2 枚以上ありません(グループに入っている付箋は、先にグループを解くと選べます)',
          });
          return;
        }
        const bodyAtOpen = ob.body;
        void pickPlaceGroupInApp(root, items, line).then((lines) => {
          if (lines === null) return;
          const now = dispatcher.getState().openBody;
          if (now?.lid !== lid) {
            dispatcher.dispatch({ type: 'OP_NOTICE', message: '別のノートに切り替わったので、グループにはしていません' });
            return;
          }
          if (now.body !== bodyAtOpen) {
            dispatcher.dispatch({ type: 'OP_NOTICE', message: '開いている間に本文が変わったので、グループにはしていません(もう一度開いてください)' });
            return;
          }
          placeEditedElsewhereGate(dispatcher, services, lid, 'グループにできませんでした', () =>
            dispatcher.dispatch({ type: 'GROUP_PLACES', lid, lines }),
          );
        });
      },
      'グループにしてください',
    );
  },
  /**
   * 🔴 **グループを解く**(#530 段⑤b。置けるなら外せる)── 右クリックした付箋の**グループの全員**の
   * `group=` を消す(位置は動かさない)。確認は要らない(もう一度「グループにする…」で戻せる)。
   */
  'place-ungroup': (dispatcher, target, services) => {
    placeStyleWrite(
      dispatcher,
      target,
      (lid, line) =>
        placeEditedElsewhereGate(dispatcher, services, lid, 'グループを解けませんでした', () =>
          dispatcher.dispatch({ type: 'UNGROUP_PLACE', lid, line }),
        ),
      'グループを解いてください',
    );
  },
  /**
   * 🔴 **付箋を回す**(#530 段⑤d)── 項目が運ぶ値(押した結果の角度、0〜359)を書く。
   * 🔑 `0` は札を**消す**(`rotate=0` と書き足さない ── `place-size` の `standard` と同じ作法)。
   * ⚠ 読めない値は**書かない**(属性を書き換えられた形)。
   */
  'place-rotate': (dispatcher, target, services) => {
    const raw = target.getAttribute(PLACE_STYLE_ROTATE_ATTR);
    if (raw === null) return;
    const deg = parsePlaceRotate(raw);
    if (deg === null) return;
    placeStyleWrite(
      dispatcher,
      target,
      (lid, line) =>
        placeEditedElsewhereGate(dispatcher, services, lid, '付箋を回せませんでした', () =>
          dispatcher.dispatch({
            type: 'SET_PLACE_STYLE',
            lid,
            line,
            style: { rotate: deg === 0 ? null : deg },
          }),
        ),
      '付箋の回転を直してください',
    );
  },
  /**
   * 🔴 **線を消す**(#530 段③d)── 右クリックした線の開き行を消す。
   * 🔑 門は `remove-place` と同じ(身元 / phase)。確認は挟まない ── 線は 2 行の宣言で、
   *   消えても繋がれていた付箋は無傷、もう一度掴めば繋がる(板を消す重さとは違う)。
   * ⚠ 行の座標は `remove-place` と同じ(frontmatter を剥いだ行番号を運び、ここで足す)。
   */
  'remove-place-line': (dispatcher, target) => {
    const line = menuCarriedBlock(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}、線を消してください` });
      return;
    }
    const ob = st.openBody;
    if (ob === null) return;
    // 🔴 閉じていない線は消せない ── 押した時点で本当の理由を言う(reducer も同じ関数で見る。#1087)
    if (placeBlockUnclosed(ob.body, line + frontmatterLineCount(ob.body))) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: PLACE_LINE_REMOVE_OPEN_REFUSAL });
      return;
    }
    dispatcher.dispatch({
      type: 'REMOVE_PLACE_LINE',
      lid: ob.lid,
      line: line + frontmatterLineCount(ob.body),
    });
  },
  'remove-place': (dispatcher, target, _services, root) => {
    const line = menuCarriedBlock(target);
    if (line === null || refuseStaleMenu(dispatcher, target)) return;
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}、板の付箋を消してください` });
      return;
    }
    const ob = st.openBody;
    if (ob === null) return;
    const lid = ob.lid;
    // 🔴 閉じていない付箋は消せない ── **確認を出す前に**本当の理由を言う(reducer も同じ関数で見る。#1087)
    if (placeBlockUnclosed(ob.body, line + frontmatterLineCount(ob.body))) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: PLACE_REMOVE_OPEN_REFUSAL });
      return;
    }
    // ⚠ 確認を開いた時点の本文を控える ── 確認の間に別のタブが上の行を増減すると、同じ行番号は**別の付箋**を指す
    const bodyAtOpen = ob.body;
    /**
     * 🔴 履歴に積む回なので「戻せる」と言う(#1087)。置いたノートの付箋は、消えるのが付箋の枠だけで
     * ノート自体は無傷 ── それも言う(開き行に `entry=` が在るかで分ける)。
     */
    const openLine = ob.body.split('\n')[line + frontmatterLineCount(ob.body)] ?? '';
    const placesNote = /\bentry=/.test(openLine);
    confirmThen(
      root,
      placesNote
        ? 'この付箋を本文から消しますか?(置いたノート自体は消えません。履歴から戻せます)'
        : 'この付箋を本文から消しますか?(中に書いた字も消えます。履歴から戻せます)',
      { okLabel: 'この付箋を消す', danger: true },
      dispatcher,
      () => {
        const now = dispatcher.getState();
        if (now.phase !== 'ready') return `${phaseBlockReason(now.phase)}、板の付箋を消してください`;
        if (now.openBody?.lid !== lid) return '別のノートに切り替わったので、板は消していません';
        // 🔴 確認の間に本文が動いたら書かない(`place-rect` / `place-group` と同じ。別の付箋を消さない)
        if (now.openBody.body !== bodyAtOpen)
          return '確認している間に本文が変わったので、付箋は消していません(もう一度消してください)';
        return null;
      },
      () => {
        dispatcher.dispatch({ type: 'REMOVE_PLACE', lid, line: line + frontmatterLineCount(bodyAtOpen) });
      },
    );
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
    // 🔴 編集中などは `CREATE_ENTRY` が黙って空振りする ── 作れないのに「足しました」と言わない(#1087)。
    //    断り文の前置きは `contacts-quick-add` と同じ(`phaseBlockReason`)。欄の字は残す
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}足してください` });
      return;
    }
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
    const lid = generateLid();
    dispatcher.dispatch({
      type: 'CREATE_ENTRY',
      lid,
      title,
      archetype: 'attachment',
      body: `---\nattachment.launcher_url: ${url}\n---\n`,
      edit: false,
      // 🔴 開いているノートも絞りも動かさない(#1087。リンクを足しただけで本文が中央から消えない)
      keepSelection: true,
    });
    // ⚠ 作れなかった回(lid 衝突など ── reducer が理由を立てる)は「足しました」と言わず、欄も消さない(打った字を失わせない)
    if (!dispatcher.getState().entryMetas.has(lid)) return;
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
   * ⚠ **題名の改名の規則を作らない** ── 既存の 1 つを撃つだけ
   *   (`binder.ts` の別の 2 か所と同じ action)。
   * 🔴 **ダウンロードのファイル名も一緒に変える**(#1220 穴②、裁定 A)。⚠ 添付の本文の
   *   `attachment.name:` は編集欄から畳んだので(`attachment-edit-fold.ts`)、**ここが
   *   ファイル名を変えられる唯一の場所**になる。題名は `RENAME_ENTRY_TITLE`(本文に触らない)、
   *   ファイル名は `SET_ATTACHMENT_NAME`(書く直前に disk から読み直し、その 1 行だけを差し替える)
   *   の **2 本を順に撃つ** ── 1 本にまとめると、題名の改名が本文の書込の衝突に巻き込まれる。
   * 🔑 一覧の `F2` / 右クリックの改名も**同じ関数**(`attachment-rename.ts`)で揃える(#1220 F2)。
   */
  'rename-attachment': (dispatcher, target) => {
    // 🔴 **押した欄が対象を持つ**(#848)── 留めた枠でも、その枠のノートを改名する
    const lid = targetLid(dispatcher, target);
    if (!lid || !(target instanceof HTMLInputElement)) return;
    const title = target.value.trim();
    const before = dispatcher.getState().entryMetas.get(lid)?.title ?? '';
    // ⚠ 空にはしない(無題の添付を作らない)── 元の字へ戻す
    if (title === '') {
      target.value = before;
      // 🔴 黙って戻さない(#1087)── 戻した理由を、題名の改名と同じ言い方で出す
      dispatcher.dispatch({ type: 'OP_FAILED', error: '題名を入れてください' });
      return;
    }
    /**
     * 🔴 **字が同じでも、ファイル名が題名と食い違っていれば揃える**(#1264 §1)。
     *
     * ⚠ 直す前は `change`(= 字が変わったとき)だけで動いたので、**一覧の `F2` で題名だけ変えた後**に
     *   この欄を確定しても何も起きず、ファイル名は旧いまま ── 題名とファイル名を揃える道が無かった。
     * 🔑 食い違いの判定は `attachmentFileName` の 1 本(書く規則と同じ)。**揃っていれば何も撃たない**
     *   (欄を離れるたびに書かない = 冪等)。⚠ いまの名前を持たない欄(ファイルを持たないタイル)は
     *   従来どおり題名が変わったときだけ撃つ。
     */
    const known = target.getAttribute(ATTACHMENT_NAME_ATTR) ?? '';
    const want = known === '' ? null : attachmentFileName(title, known);
    const nameDiffers = want !== null && want !== known;
    if (title === before && !nameDiffers) return;
    // 🔴 **一覧の `F2` / 右クリックと同じ 1 本**(#1220 F2)── 題名を先に、ファイル名を後に撃つ
    renameAttachmentAndFile(dispatcher, lid, title);
    // 🔑 描き直しが来るまでの間に欄を離れても、もう一度撃たない(印を先に進める)
    if (want !== null) target.setAttribute(ATTACHMENT_NAME_ATTR, want);
  },
  /**
   * ランチャーのタイル設定(P8 段⑭)。
   * 🔴 **対象は「押した欄」が持つ**(#848、2026-09-13)── 直す前は
   *   `selectedLid` を読んでいたので、**留めた枠に出すと押していないノートが
   *   書き換わる**。だから 2026-09-12 には**出さない**ことで塞いでいた。
   *   いまは `APP_TILE_SAVED` が留めた枠の本文にも追随する(#848 の土台)ので、
   *   **出したうえで、押した物へ撃つ**。
   */
  'toggle-app-tile': (dispatcher, target) => {
    const lid = targetLid(dispatcher, target);
    if (lid && target instanceof HTMLInputElement) {
      dispatcher.dispatch({ type: 'SET_APP_TILE', lid, registered: target.checked });
      revertIfRefused(dispatcher, lid, target);
    }
  },
  'set-app-group': (dispatcher, target) => {
    const lid = targetLid(dispatcher, target);
    if (lid && target instanceof HTMLInputElement) {
      dispatcher.dispatch({ type: 'SET_APP_TILE', lid, group: target.value.trim() });
      revertIfRefused(dispatcher, lid, target);
    }
  },
  'set-app-icon': (dispatcher, target) => {
    const lid = targetLid(dispatcher, target);
    if (lid && target instanceof HTMLInputElement) {
      dispatcher.dispatch({ type: 'SET_APP_TILE', lid, icon: target.value.trim() });
      revertIfRefused(dispatcher, lid, target);
    }
  },
  /**
   * 🔴 **目印を絵から選ぶ**(#770 段②、2026-09-12)。
   *
   * ⚠ **押した物が何かは、押した要素が持つ**(`data-pkc-icon-name`)──
   *   ここで一覧を引き直すと、並べる側と選ぶ側で表が 2 つになる(§7)。
   * 🔑 撃つのは `set-app-icon`(欄に打つ)と**同じ書込** ── 空文字は
   *   reducer が「目印なし」に畳むので、`なし` の口も同じ 1 本で足りる。
   */
  /**
   * 🔴 **リンク先の印を取り込む**(#856 段②。user 裁定 2026-09-12 / 09-13)。
   *
   * 🔑 **通信が始まるのは、ここに来た瞬間だけ**である(押していないのに外へ出ない)。
   * ⚠ 門は 3 つ。どれも**黙って終わらない** ── 押して何も起きないのがいちばん悪い:
   *   ① アドレスが無い(出し分けが壊れている合図)
   *   ② 🔴 設定で「本文の外部画像」を**常にオフ**にしている(裁定 2026-09-13)
   *   ③ 取りに行って取れなかった(理由をそのまま出す)
   * ⚠ **押している間は押せなくする** ── 連打で同じサイトへ何度も出ない
   *   (`render` が組み直せば戻る ── 状態を増やさずに済ませる)。
   */
  'adopt-link-icon': (dispatcher, target, services) => {
    /**
     * 🔴 **飛び先は state から引く ── 押した器から読まない**(2026-09-13、CI の全数門)。
     *
     * ⚠ 1 稿目は `target` の `data-pkc-url` を読んでいた。それだと
     *   `tests/action-outlets.test.ts` の **`OBJECT_LONE`**(対象が要るのに出口が
     *   1 か所しか無い操作)に入る ── **その面を畳むと画面から消える**種類の操作である。
     * ⚠ 器から読むのは「同時に見えている兄弟のうち押した 1 つ」を採るときの作法である。
     *
     * 🔴 **2026-09-13 に「指す先は 1 つ」が成り立たなくなった**(#848)── 添付の設定を
     *   **留めた枠にも出す**ようにしたので、主の枠とは**別のノート**の設定が同時に
     *   画面へ出る。だから *lid* は押した要素から採る(= 兄弟のうち押した 1 つ)。
     * ⚠ ただし **URL は相変わらず器から読まない** ── 飛び先を DOM に持たせると
     *   `OBJECT_LONE` の意味(対象が要るのに出口が 1 か所)が壊れるうえ、
     *   **本文と DOM のどちらが正しいか**が 2 か所になる。本文から引く。
     */
    const st = dispatcher.getState();
    const lid = targetLid(dispatcher, target);
    if (lid === null) return;
    /**
     * 🔑 **本文は lid から引く** ── 主の枠が別のノートを開いていることがあるので、
     *   `openBody` を無条件に読むと**別のノートのアドレス**を取りに行く。
     */
    const body =
      st.openBody?.lid === lid ? st.openBody.body : (st.splitBodies.get(lid) ?? '');
    const url = String(parseFrontmatter(body).meta['attachment.launcher_url'] ?? '');
    if (url === '') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: 'このノートにはリンク先のアドレスがありません',
      });
      return;
    }
    const blocked = externalImageBlockReason(appExternalImages.getMode());
    if (blocked !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: blocked });
      return;
    }
    const go = services.adoptLinkIcon;
    if (go === undefined) return;
    /**
     * 🔴 **連打は `disabled` で止めない**(2026-09-13、動線レビュー)。
     *
     * ⚠ 立てた瞬間、ブラウザは**焦点を持つ要素を外す** ── そのうえ取り込みが通ると
     *   本文が変わって**この箱ごと作り直される**ので、鍵だけで使う人の焦点は
     *   `body` へ落ちて戻らない(画面の先頭から Tab をやり直すことになる)。
     *   ⚠ 面の側の「組み直しても焦点を戻す」仕掛け(`detail.ts` の `refocusPick`)は
     *   **組み直しの時点でもう焦点が外れている**ので間に合わない。
     * 🔑 **止めるのは器ではなく帳簿にする** ── 飛んでいる lid を持てば、
     *   器を 1 ドットも触らずに 2 度目を落とせる(焦点は乗ったままである)。
     */
    if (adoptingLinkIcons.has(lid)) return;
    adoptingLinkIcons.add(lid);
    const btn = target instanceof HTMLButtonElement ? target : null;
    /**
     * 🔴 **押している間、何をしているかを字で言う**(2026-09-13、動線レビュー)。
     *
     * ⚠ 直す前は**薄くなるだけ**だった ── 相手のサイトが遅いと、最大 4 往復を
     *   直列で待つ間、画面は 1 ドットも動かない。user は「押したのに反応が無い」と
     *   受け取って連打するか、別の操作へ移って結果を見失う。
     * ⚠ 字は**起きていること**で書く(user 指示 2026-08-21)。
     * 🔑 戻すのは `finally` ── 取れても取れなくても、必ず元の字に戻す。
     */
    const label = btn?.textContent ?? null;
    if (btn) btn.textContent = '取りに行っています…';
    void go(url)
      .then((got) => {
        if (!got.ok) {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: `リンク先のアイコンを取り込めませんでした: ${got.why}`,
          });
          return;
        }
        /**
         * 🔴 **書けたかどうかを、その場で確かめる**(2026-09-13、着地前レビュー)。
         *
         * ⚠ `SET_APP_TILE` は **`phase !== 'ready'` や別の lid の書込中を黙って捨てる**
         *   (押し直せば済む設定のための作法である)。⚠ ところがここは**取りに行った後**
         *   なので、捨てられると **user から見て「押したのに何も起きない」**になり、
         *   しかも**もう一度押すと通信がもう 1 往復**する。
         * ⚠ 窓は実在する:取りに行っている数百ms〜数秒の間に**別のノートの編集を
         *   始められる**(`START_EDIT` の門は lid 単位だが、`phase` はアプリ全体で 1 つ)。
         * 🔑 受かったかは**この場で読める** ── 受かれば `tileWrite` がこの lid で
         *   1 つ進む。進んでいなければ**捨てられた**ので、黙らずに言う。
         */
        const was = dispatcher.getState().tileWrite;
        const mine = was !== null && was.lid === lid ? was.n : 0;
        dispatcher.dispatch({ type: 'SET_APP_TILE', lid, iconAssetKey: got.assetKey });
        const now = dispatcher.getState().tileWrite;
        if (now !== null && now.lid === lid && now.n === mine + 1) return;
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: 'リンク先のアイコンは取れましたが、ほかの保存が動いているので入れられませんでした(もう一度押してください)',
        });
      })
      .finally(() => {
        adoptingLinkIcons.delete(lid);
        // ⚠ `render` が組み直していれば、この器はもう画面に無い(触っても害は無い)
        if (btn !== null && label !== null) btn.textContent = label;
      });
  },
  'pick-app-icon': (dispatcher, target) => {
    // 🔴 押した絵が「効く先」も持つ(#848)── 表は留めた枠にも出る
    const lid = targetLid(dispatcher, target);
    if (!lid) return;
    const name = target.getAttribute('data-pkc-icon-name');
    // ⚠ 属性が無いときは撃たない(押した物が分からないまま目印を消さない)
    if (name === null) return;
    dispatcher.dispatch({ type: 'SET_APP_TILE', lid, icon: name });
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
    /**
     * 🔴 **字は `copyText` に渡す**(2026-08-29 の動線レビュー 欠陥 2)── ここも
     *   `showStatus` を後から上書きされていた(件数まで出していたのに、user が
     *   読むのは「参照をコピーしました」だった)。
     */
    services.copyText?.(
      out.text,
      out.shown === out.total
        ? `構成 ${out.total} 件をコピーしました`
        : `構成 ${out.total} 件のうち ${out.shown} 件をコピーしました`,
    );
    flashCopied(target);
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
      // 🔴 「まだありません」が偽になる 2 つの道を先に分ける(#1087)── 保存できないブラウザでは
      //    変えた設定がこのタブの中にしか無く、長すぎる設定は在るのに入らない
      const tooLongOnly = settingsTooLongToExport(readSetting);
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: !canPersistSettings(defaultSettingsStorage)
          ? `設定を書き出せません。${SETTINGS_NOT_PERSISTED_TEXT}`
          : tooLongOnly.length > 0
            ? `設定を書き出せません(${tooLongOnly.join('・')} は長すぎるので入りません)`
            : '持ち出せる設定がまだありません(見た目やショートカットキーの割当を変えると入ります)',
      });
      return;
    }
    // 🔑 「今日」は**端末の暦日**(`dayStamp`)── `toISOString` は UTC なので、
    //    日本の 0 時〜9 時に押すと前日の名前になっていた(#709)
    const today = dayStamp(new Date());
    downloadBlob(
      settingsFileName(today),
      new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
    );
    // 🔴 長すぎて入らなかった設定を言う(#1087)── 黙って落とすと「全部持ち出した」と読まれる
    const tooLong = settingsTooLongToExport(readSetting);
    if (tooLong.length > 0) {
      // 🔴 全部入った回は赤くない知らせ(`OP_NOTICE`)、**一部入らなかった回は赤い帯**(`OP_FAILED`)で言う
      //   (台帳 #1852 束 L2、依頼 120-1 A。⚠ 以前は「書き出せた回なので結果」と言っていたが、入らなかった設定が在る回は
      //   取りこぼしを見逃させないほうを取る ── 取り込みで一部書けなかった回と同じ向き)
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `設定を書き出しました。${tooLong.join('・')} は長すぎるので入っていません`,
      });
    }
  },
  /**
   * 🔴 **連絡先を vCard で書き出す**(#278 段③)。
   * 🔑 出るのは**いま見えている分だけ** ── 一覧の描画と**同じ 1 つ**の規則
   *   (`visibleContacts`)を呼ぶ(§7。個人情報なので「画面は 3 件なのに
   *   書き出しは 5 件」を絶対に作らない)。
   * ⚠ 個人情報は**この 1 押しでしか出ない**(バックアップや他の書き出しに
   *   自動で混ぜない ── issue #278「既定は含めない側」)。
   */
  'export-vcards': (dispatcher) => {
    const st = dispatcher.getState();
    const scan = st.contactScan;
    const cards = scan === null ? [] : visibleContacts(scan.cards, st.filterQuery);
    if (cards.length === 0) {
      // ⚠ 無言で空の file を落とさない(export-settings と同じ向き)
      dispatcher.dispatch({ type: 'OP_FAILED', error: '書き出せる連絡先がありません' });
      return;
    }
    const today = dayStamp(new Date()); // 端末の暦日(export-settings と同じ 1 本)
    downloadBlob(
      `連絡先-${today}.vcf`,
      new Blob([buildVcf(cards)], { type: 'text/vcard' }),
    );
    /**
     * ⚠ **何が入っていないかを、押した後にも言う**(2 巡目の動線レビュー 2026-08-28)。
     *   ボタンの説明(`title`)はマウスを乗せたときしか出ないので、触る画面や
     *   字だけ見て押した user には届かない ── そのまま**元の .vcf を捨てる**恐れがある。
     */
    /**
     * ⚠ **途中までしか集めていないことも言う**(#536 ①)── 走査は上限で切るので、
     *   ノートが多い user では「見えている分」が全部ではない。⚠ しかも取り込んだ
     *   連絡先は一覧の**最後尾**に付くので、**新しく取り込んだ分から順に切られる**。
     *   言わないと「全部出た」と思って元の .vcf を捨てる。
     */
    const cut = st.contactScan?.truncated === true ? '(多いので途中まで集めた分です)' : '';
    /**
     * 🔴 **外した宛先の件数は、必ず言う**(#536 ③、2026-08-28)。
     *
     * ⚠ 長すぎる値(1,000 字超)は **card に入る前に外して**ある
     *   (`contact-card.ts` の `CONTACT_LIMITS.wire`)── 途中で切った宛先を
     *   相手の端末に「在るもの」として保存させないためである。
     * 🔴 だが**黙って外すと、それは「静かに失う」そのもの**である ──
     *   user は宛先の欠けた連絡先を渡して、後で相手が連絡できないことに気づく。
     * 🔑 だから**何件で外したかを言う**。⚠ 外したのは**その値だけ**なので、
     *   同じ人の本物の電話番号やメールは**そのまま出ている**(そう読める字にする)。
     */
    const dropped = cards.filter((c) => c.overlong).length;
    const bad =
      dropped > 0
        ? `。⚠ ${dropped} 件で、長すぎる電話・メール(1,000 字超)を外しました`
        : '';
    // 🔴 読めない誕生日は書かない(#1087)── 書かなかった件数を言う
    const noBday = countUnwritableBirthdays(cards);
    const bdayBad = noBday > 0 ? `。${noBday} 件は誕生日の書き方が読めないので、誕生日を書いていません` : '';
    dispatcher.dispatch({
      type: 'OP_NOTICE',
      message: `連絡先 ${cards.length} 件を書き出しました${cut}(名前・所属・電話・メール・誕生日だけです)${bad}${bdayBad}`,
    });
  },
  /**
   * 🔴 **予定を .ics(iCalendar)で書き出す**(#855 段 D)。
   * 🔑 出るのは**いま予定の面が出している分だけ** ── 面の描画と**同じ 1 つ**の口
   *   (`scheduleItemsOf`)を呼ぶ(§7。「出すもの」で隠した分や検索の絞りが、
   *   書き出しだけ効かない、を作らない)。日付のない予定は外の予定表に置き場が無いので出ない。
   * 🔑 繰り返しは規則(RRULE)のまま出し、済ませた回は外す(`materializedDates` ── 面と同じ材料)。
   */
  'export-schedule-ics': (dispatcher) => {
    const st = dispatcher.getState();
    const shown = scheduleItemsOf(st);
    const now = new Date();
    const res = buildIcs(shown.items, {
      stamp: now,
      // 🔑 端末の時刻帯:Asia/Tokyo だけ VTIMEZONE を同梱、他は UTC に直す(`ics.ts` の頭)
      zone: resolveIcsZone(
        (() => {
          try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone;
          } catch {
            return undefined;
          }
        })(),
        (date, time) => {
          const d = new Date(
            Number(date.slice(0, 4)),
            Number(date.slice(5, 7)) - 1,
            Number(date.slice(8, 10)),
            Number(time.slice(0, 2)),
            Number(time.slice(3, 5)),
          );
          return -d.getTimezoneOffset();
        },
      ),
      noteTitle: (lid) => st.entryMetas.get(lid)?.title,
      skip: materializedDates(shown.all),
      // 🔴 アラーム(#855 20-C)── 時刻つきの予定だけ。「なし」= 0
      alarmMinutes: appScheduleNotify.lead(),
    });
    if (res.count === 0) {
      // ⚠ 無言で空の file を落とさない(export-vcards と同じ向き)
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error:
          res.skipped > 0
            ? `書き出せる予定がありません(日付や時刻が読めない予定が ${res.skipped} 件あります)`
            : '書き出せる予定がありません(日付を書いた予定が、いま一覧に出ていません)',
      });
      return;
    }
    downloadBlob(
      `pkc-schedule-${dayStamp(now)}.ics`,
      new Blob([res.text], { type: 'text/calendar' }),
    );
    const bad = res.skipped > 0 ? `。日付や時刻が読めない ${res.skipped} 件は入っていません` : '';
    // 🔴 走査は上限で切るので、ノートが多いと「出ている分」が全部ではない(連絡先の書き出しと同じ言い方)
    // ⚠ 括弧を 2 つ続けないよう、同じ括弧の中に入れる
    const cut = st.taskScan?.truncated === true ? '多いので途中まで集めた分です。' : '';
    dispatcher.dispatch({
      type: 'OP_NOTICE',
      message: `予定 ${res.count} 件を書き出しました(いま一覧に出している分です。${cut}日付のないものは入りません)${bad}`,
    });
  },
  /**
   * 🔴 **当てる**(#414)── ⚠ **下見に出したのと同じ物**を当てる。
   * 🔑 だから `settingsPlanText` を読み直して組み直す ── 別に憶えた配列を当てると、
   *   「見た通りに動かない」が静かに生まれる(§7)。
   */
  'apply-settings': (dispatcher, _target, _services, root) => {
    if (settingsPlanText === null) return;
    const plan = planSettingsImport(settingsPlanText, readSetting, ADAPTER_SETTING_VALIDATORS);
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
    let failed = 0;
    for (const c of plan.changes) {
      try {
        // 🔴 `to` が `null` は「標準に戻す」(依頼 207)── 鍵を消す(読み手は「無い」を既定として扱う)
        if (c.to === null) localStorage.removeItem(c.key);
        else localStorage.setItem(c.key, c.to);
        wrote += 1;
        /**
         * 🔴 **取り込んだこのタブにも、配色・文字の大きさ・紙面をすぐ当てる**(依頼 312。Gemini 裁定 = 推薦 A)。
         * ⚠ `storage` event は書いた側のタブには届かない ── 別のウィンドウが書いたときと**同じ合図**を自分に撃つ
         *   (`watch*FromOtherWindows` が、鍵が合う物だけ当て直す。当て方を 2 本持たない)。
         */
        window.dispatchEvent(new StorageEvent('storage', { key: c.key }));
      } catch {
        // ⚠ 1 件書けなくても残りは当てる(全部捨てるほうが害が大きい)── ただし数えて言う
        failed += 1;
      }
    }
    paintSettingsPlan(root, null);
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="settings-file-input"]');
    if (input !== null) input.value = '';
    /**
     * 🔴 **読み直しが要ることを言う** ── 鍵の割当も紙面も**起動時に読む**ので、
     *   当てただけでは画面が変わらない。⚠ 言わないと「効かなかった」と読まれる。
     */
    // 🔴 入った回は「結果」(`OP_NOTICE`)── `OP_FAILED` で言うと「問題」の未読に数えられた。
    //   書けなかった分が在る回だけ問題として言う
    const appliedNote = settingsAppliedNote(wrote, failed);
    if (failed === 0) dispatcher.dispatch({ type: 'OP_NOTICE', message: appliedNote });
    else dispatcher.dispatch({ type: 'OP_FAILED', error: appliedNote });
  },
  'apply-plan': (dispatcher, _target, services, root) => {
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="plan-input"]');
    if (ta === null) return;
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}適用してください` });
      return;
    }
    const plan = parsePlan(ta.value, st.entryMetas);
    if (!canApplyPlan(plan)) return;
    /** この案で作ったフォルダ(`@名前` → いま作った lid)。 */
    const made = new Map<string, string>();
    let refusedMoves = 0;
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
      const now = dispatcher.getState();
      if (alreadyThere(now, op.lid, parentLid)) continue;
      const before = now.relations;
      dispatcher.dispatch({
        type: 'SET_ENTRY_PARENT',
        lid: op.lid,
        parentLid,
        relationId: generateLid(),
      });
      // 🔴 断られた移動を数える(#1087)── `moveEntries` と同じ見方。直す前は数えずに全件「適用しました」と言っていた
      if (dispatcher.getState().relations === before) refusedMoves += 1;
    }
    // 🔑 当てたら欄を空にする ── 残すと「もう一度押せる」ように見える(二重適用)
    ta.value = '';
    paintPlan(root, dispatcher, '');
    services.showStatus?.(`整理案を適用しました(${plan.ops.length - refusedMoves} 件)`);
    if (refusedMoves > 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `${String(refusedMoves)} 件は移せませんでした(行き先がフォルダではないか、フォルダを自分の中へ入れようとしています)`,
      });
    }
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
    /**
     * 🔴 **ブラウザが言う本当の数も一緒に出す**(#971 段②)。
     * ⚠ この面が数えるのは**添付の合計だけ**なので、これを出さないと
     *   user は**本当の残りを知る道が無い**。
     * ⚠ 添付の集計と**別に**出す ── 足し合わせると「一致しない 2 つの量」が
     *   1 つの数に見える(#454 と同じ型)。
     */
    const quotaEl = root.querySelector<HTMLElement>('[data-pkc-field="storage-quota"]');
    if (quotaEl !== null && services.quotaEstimate !== undefined) {
      void services.quotaEstimate().then(
        (est) => {
          quotaEl.textContent = quotaText(est);
          quotaEl.hidden = false;
        },
        () => {
          quotaEl.textContent = quotaText({});
          quotaEl.hidden = false;
        },
      );
    }
    if (services.storageProfile === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'この環境では容量を数えられません' });
      return;
    }
    sum.textContent = '容量を調べています…';
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
        const trash = root.querySelector<HTMLElement>('[data-pkc-field="storage-profile-trash"]');
        if (trash !== null) {
          trash.textContent = trashNote(lines);
          trash.hidden = lines.length === 0;
        }
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
  /**
   * 🔴 **中身が壊れていないかを調べる**(#971 段③)。
   *
   * ⚠ **時間がかかる** ── 数 GB では分の単位になるので、押した直後に
   *   「調べています」を出し、**終わるまで消さない**(無言で待たせない)。
   * 🔑 読み解きは `features/storage/db-rescue.ts` の 1 本 ── ここは出すだけである。
   */
  'db-check': (dispatcher, _target, services, root) => {
    const sum = root.querySelector<HTMLElement>('[data-pkc-field="db-rescue-summary"]');
    const list = root.querySelector<HTMLElement>('[data-pkc-field="db-rescue-detail"]');
    if (sum === null || list === null) return;
    if (services.checkIntegrity === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'この環境では中身を調べられません' });
      return;
    }
    sum.textContent = '調べています…(中身が多いと数分かかります。閉じずにお待ちください)';
    sum.hidden = false;
    list.textContent = '';
    list.hidden = true;
    void services.checkIntegrity().then(
      (res) => {
        const report = parseQuickCheck(res.rows, res.schema);
        // ⚠ 経過を自前で組み立てない ── 見せ方は `elapsed-text.ts` の 1 本
        //    (2 通りの形で出すと、user は「別の量」と読む。#279)
        sum.textContent = `${integritySummary(report)}(${elapsedText(res.elapsedMs)} かかりました)`;
        // ⚠ 生の行も出す ── こちらの言い換えが外れていても、user が読める材料を残す
        const lines = [...report.brokenTables.map((t) => `本文の表: ${t}`),
          ...report.brokenIndexes.map((i) => `索引: ${i}`),
          ...report.unresolved];
        list.textContent = '';
        for (const l of lines.slice(0, 60)) {
          const li = document.createElement('li');
          li.textContent = l;
          list.append(li);
        }
        list.hidden = lines.length === 0;
        /**
         * 🔴 **問題が出たときは、作り直す・初期化する の箱を開いた状態で出す**
         * (#1017 段③-1、`ui-total-design-2026-09.md` §3.2)。⚠ 結果の表示
         * (`sum` / `list`)と**同じ経路**で `hidden` を外す ── 押し口を
         * 別に探させない。
         */
        if (!report.ok) {
          const repairBox = root.querySelector<HTMLElement>(
            '[data-pkc-field="container-repair-box"]',
          );
          const repairToggle = root.querySelector<HTMLElement>(
            '[data-pkc-action="toggle-container-repair"]',
          );
          if (repairBox) repairBox.hidden = false;
          if (repairToggle) setContainerRepairToggle(repairToggle, true);
        }
      },
      (e: unknown) => {
        sum.textContent = '';
        sum.hidden = true;
        dispatcher.dispatch({ type: 'OP_FAILED', error: `調べられませんでした: ${errorText(e)}` });
      },
    );
  },
  /**
   * 🔴 **保存領域を縮める**(#999。Gemini 裁定 A)。
   *
   * ⚠ **押した user だけが打つ** ── 自動の係はこの口を呼ばない(原文 pin が見張る)。
   * ⚠ **判断はここに無い** ── 押せるか / 空きが足りるか / 順番(書込の列に載せる)/
   *   処理の記録への積みは `StorageVacuum`(`platform/storage/vacuum-run.ts`)が持つ。
   *   ここは**結果の字を画面の知らせへ出すだけ**である。
   * ⚠ 押せない物は画面側が `disabled` にしているが、**それでも来たら理由を言う**
   *   (黙って落とすと dead click になる)。
   */
  'storage-vacuum': (dispatcher, _target, services) => {
    void appStorageVacuum.run().then((r) => {
      // 🔑 成功は一時の知らせ(エラーの行ではない)/ 断りと失敗はエラーの行
      if (r.kind === 'done') services.showStatus?.(r.text);
      else dispatcher.dispatch({ type: 'OP_FAILED', error: r.text });
    });
  },
  /**
   * 🔴 **拾えるだけ取り出す**(#971 段③)。
   *
   * ⚠ **1 回で全部返させない** ── 数 GB を 1 つの応答に載せると heap に載らない。
   * 🔴 **「拾えた件数」を「全部」と読ませない** ── 実測では、壊れているとき
   *   大半の区画が**エラーではなく空**で返る(区切り 100 行で 38/40)。
   *   だから読み飛ばした数を数えて、必ず一緒に出す。
   */
  /**
   * 🔴 **拾ったものを「戻せる形」で書き出す**(#986。user 指示 2026-09-16)。
   *
   * ⚠ すぐ下の `db-rescue` は **人が読む形**(.md 1 枚)である ──
   *   🔴 それを取り込むと**ノートは 1 件**にしかならない
   *   (素の .md は 1 ファイル = 1 ノート)。こちらは**戻すため**の口である。
   *
   * ⚠ **下の口を消さない** ── 壊れているときに
   *   「とりあえず中身を読みたい」は別の要求である
   *   (CLAUDE.md「記法を減らすことは、user の動線を減らすことである」)。
   */
  /**
   * 🔴 **中身を残して、作り直す**(#1006。user 裁定 2026-09-18)。
   *
   * ## user が言っていたこと(こちらの解釈)
   *
   * 壊れているのは **DB の側**なのに、直す口が「**全部捨てる**」しか無かった ──
   * なぜ中身まで捨てさせられるのか。🔑 だから**中身を持ち越す道**を作る。
   *
   * ## ⚠ ここには順番を 1 つも置かない
   *
   * 拾う → zip を落とす → 捨てる → 開き直す → **退避したかを見る** → 書き戻す →
   * 他のタブへ知らせる、の順は `features/storage/container-rebuild.ts` が持つ。
   * 🔑 ここは**聞いて、進み具合を出して、読み込み直す**だけである。
   *
   * ## ⚠ 合言葉は聞かない(「捨てる」との違い)
   *
   * 🔑 こちらは**先に zip が手元へ落ちてから**しか進まないうえ、ノートと添付が
   *   そのまま戻る ── 捨てる側と同じ重さの門を置くと、**推奨したい側が重くなる**。
   * ⚠ ただし**戻らない物は窓で言い切る**(`rebuildExplainMessage`)。
   *
   * ## ⚠ なぜ `recheck` を通していないか
   *
   * 捨てる側(すぐ下)と同じ理由である ── ①効く先は `cid` 1 つ
   * ②**壊れて編集中のまま動けない**ときにこそ要る口なので、`notWhileEditing` で
   * 止めると「**壊れているときだけ作り直せない**」= 趣旨と逆になる。
   */
  'container-rebuild': (dispatcher, _target, services, root) => {
    const sum = root.querySelector<HTMLElement>('[data-pkc-field="container-rebuild-summary"]');
    if (sum === null) return;
    /**
     * 🔴 **2 度目は黙って落とさない ── 走っていると言う**(動線レビュー)。
     * ⚠ 何も出さずに無視すると、**押したのに何も起きない**(この repo が
     *   いちばん嫌う無言の dead click)になる。
     */
    if (rebuildingContainer) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'いま作り直しています(終わるまでお待ちください)' });
      return;
    }
    const rebuild = services.rebuildContainer;
    if (rebuild === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'この環境では作り直せません' });
      return;
    }
    const cid = dispatcher.getState().cid;
    if (cid === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'まだ開いていません' });
      return;
    }
    /**
     * 🔑 **端末に在る添付の件数**(#1005 と同じ口)── `listKeys` は IndexedDB を
     *   直に読むので、**sqlite が壊れていても引ける**。
     * ⚠ 引けなければ `null`(**0 件と混ぜない** ── 「無い」と「数えられない」を
     *   同じ字にすると、失う側の人が安心する)。
     */
    const onDisk = services.rescueAssets;
    const counting: Promise<number | null> =
      onDisk === undefined
        ? Promise.resolve(null)
        : onDisk.listKeys(cid).then(
            (k) => k.length,
            () => null,
          );
    /**
     * ⚠ **窓を出す前から握る** ── 窓が開いている間は `showModal()` が背後を
     *   塞ぐが、**窓を閉じてから走り終わるまで**が無防備だった。
     */
    rebuildingContainer = true;
    void counting
      .then((assetsOnDisk) =>
        confirmInApp(
          root,
          rebuildExplainMessage({ notes: dispatcher.getState().entryMetas.size, assetsOnDisk }),
          { okLabel: 'ノートの保存データを作り直す', cancelLabel: 'やめる' },
        ),
      )
      .then(async (answer) => {
        if (answer !== 'ok') return;
        sum.textContent = '中身を取り出しています…';
        sum.hidden = false;
        try {
          /**
           * ⚠ **進み具合を出す** ── 壊れた DB を舐めるのは秒では終わらないので、
           *   何も出さないと「**固まった**」と読まれて窓を閉じられる
           *   (閉じられると、書き戻す前に止まる)。
           */
          const report = await rebuild(cid, (phase, seen) => {
            sum.textContent =
              phase === 'pick'
                ? `中身を取り出しています… ${seen} 件`
                : `ノートを戻しています… ${seen} 件`;
          });
          const done = rebuildDoneMessage(report);
          sum.textContent = done;
          // 🔴 モーダルを出す前に post する(設計 doc §7、段②a)
          appMessagePost.post({ kind: 'result', source: 'db-rescue-rebuild', text: done });
          // ⚠ **読ませてから読み込み直す**(すぐ reload すると誰も読めない)
          await alertInApp(root, done);
          /**
           * 🔴 **どの結末でも読み込み直す** ── 開き直した先は**別の worker** なので、
           *   いま画面が握っている状態は**もう繋がっていない**。
           */
          services.reloadApp?.();
        } catch (e) {
          /**
           * 🔑 **ここへ来たのは zip を落とす前**である ── だから
           *   「**何も消えていません**」と言える。
           *
           * ⚠ これは**願いではなく、作りで担保している** ── `container-rebuild.ts` は
           *   zip を落とした後の段を**丸ごと try で覆い**、落ちても
           *   `outcome: 'storage-lost'` として**返す**(投げない)。
           *   🔴 直す前は②③が裸で、**捨てた後に落ちてもここへ来ていた** ──
           *   いちばん安心させる字が、いちばん嘘になっていた
           *   (着地前レビューが出した。門は `container-rebuild.test.ts`)。
           * ⚠ ここでは**読み込み直さない**のも正しい ── ①で落ちたなら
           *   この画面の保存は生きている(読み込み直すと、打ちかけを捨てさせる)。
           */
          sum.textContent = '';
          sum.hidden = true;
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: `作り直せませんでした(何も消えていません): ${errorText(e)}`,
          });
        }
      })
      // ⚠ **やめた回も落ちた回も戻す** ── 戻し忘れると、二度と作り直せなくなる
      .finally(() => {
        rebuildingContainer = false;
      });
  },
  /**
   * 🔴 **入れ物ごと捨てて、まっさらにする**(#986 段③。user 裁定 2026-09-16
   * 「ボタンは推奨で作ってよいが、押したら説明と、本当に実行するかを聞くこと」)。
   *
   * ⚠ **押した時点では 1 バイトも消さない。** 窓は 2 枚:
   *   ① **何が消えて何が残るか**の字(押しても消えない)
   *   ② **合言葉を打つ**窓(`RESET_PASSPHRASE`)── ⚠ 打たないと実行に進めない。
   *
   * 🔑 **書き出しを門にしない**(soft-block)── 「拾って書き出した」という印は
   *   **0 件でも立つ**ので、門にすると**いちばん詰まっている人だけ**が
   *   捨てられなくなる。だから①の窓に**拾えた件数をそのまま**出して、
   *   足りるかどうかは user に決めさせる。
   *
   * ⚠ **判断はここに置かない** ── 何をどの順で消すかは
   *   `features/storage/container-reset.ts`、字は同 file の `resetExplainMessage`。
   *
   * ## ⚠ なぜ `confirmThen` の `recheck` を通していないか(着地前レビューの問い)
   *
   * 他の破壊的な口(`purge-trash` など)は「待っている間に前提が崩れたら撃たない」
   * 門(`notWhileEditing`)を通すが、ここは通していない ── **理由を書く**
   * (書かないと、次に読む人が「見落とし」と「意図」を区別できない):
   *
   * 1. **効く先が変わらない** ── 撃つ先は `cid` 1 つで、`cid` を書き換える
   *    reducer は `SYS_BOOTED` しか無い(実行中に別の入れ物へ移らない)。
   * 2. **編集中でも止めない** ── この口が要るのは**壊れて書き込めない**ときで、
   *    そこでは `phase` が `editing` のまま動けなくなっていることがある。
   *    🔴 止めると「**壊れているときだけ捨てられない**」= この機能の趣旨と逆になる。
   * 3. 待っている間の割り込みは、小窓が `showModal()` で塞いでいる
   *    (`isAppDialogOpen()` が近道キーも殺す)。
   */
  'container-reset': (dispatcher, _target, services, root) => {
    const sum = root.querySelector<HTMLElement>('[data-pkc-field="container-reset-summary"]');
    if (sum === null) return;
    const reset = services.resetContainer;
    if (reset === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'この環境では初期化できません' });
      return;
    }
    const cid = dispatcher.getState().cid;
    if (cid === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'まだ開いていません' });
      return;
    }
    const rescued = lastRescueWritten();
    /**
     * 🔴 **端末に在る添付の数を、捨てる前に数える**（#1005）。
     *
     * ⚠ 拾い出しの側だけ見ても「足りているか」は分からない ──
     *   「添付 0 件」が「元から無い人」なのか「**拾えていない人**」なのかを
     *   見分けられない。🔑 `listKeys` は **IndexedDB を直に読む**ので、
     *   sqlite が壊れていてもこの数は引ける。
     * ⚠ 引けなかったときは **`null`**（**0 件と混ぜない** ──
     *   「無い」と「数えられない」を同じ字にすると、**失う側の人が安心する**）。
     */
    const onDisk = services.rescueAssets;
    const counting: Promise<number | null> =
      onDisk === undefined
        ? Promise.resolve(null)
        : onDisk.listKeys(cid).then(
            (k) => k.length,
            () => null,
          );
    void counting
      .then((assetsOnDisk) =>
        confirmInApp(
          root,
          resetExplainMessage({
            notes: dispatcher.getState().entryMetas.size,
            /**
             * 🔴 **大きさは定数から引く**(#996 の教訓 ── 画面に出す字を手で書かない)。
             * ⚠ ここで「約 93MB」と綴ると、一式を焼き直した日に**両方そのまま**で緑になる。
             * ⚠ **DuckDB の一式は書かない**(#1087)── 端末へ入れる口が画面に無く、残るものとして
             *   見せると、入れた覚えのない 35MB が残ると読める。
             */
            keeps: [
              `Office の一式(${OFFICE_PACK_APPROX})`,
              '設定・見た目・ショートカットキーの割り当て・読んだお知らせの記録',
            ],
            rescued: rescued === null ? null : rescued.stats,
            assetsOnDisk,
          }),
          {
            // ⚠ **ここで「捨てる」と書かない** ── まだ消えないことを、ボタンの字で言う
            okLabel: '次へ(まだ消えません)',
            cancelLabel: 'やめる',
          },
        ),
      )
      .then(async (answer) => {
        if (answer !== 'ok') return;
        const typed = await promptInApp(root, {
          title: '本当に初期化しますか',
          label: resetPassphraseLabel(),
          // ⚠ **`initial` を渡さない** ── 渡すと、空のまま受けたときに
          //    `promptInApp` がその字を返す(= 何も打たずに合言葉が通る)
          okLabel: 'ノートの保存データを初期化する',
          // 🔴 danger ── ここが**本当に消える 1 押し**である(1 件削除より重い)
          danger: true,
        });
        // ⚠ 「やめる」は黙って戻る(断りの字を出すと、やめた人を責める形になる)
        if (typed === null) return;
        if (!resetPassphraseOk(typed)) {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: `${RESET_PASSPHRASE} と打たれなかったので、何も消していません`,
          });
          return;
        }
        sum.textContent = 'ノートの保存データを消しています…';
        sum.hidden = false;
        try {
          const report = await reset(cid);
          const done = resetDoneMessage(report);
          sum.textContent = done;
          /**
           * 🔴 モーダルを出す前に post する(設計 doc §7、段②a)。
           * ⚠ **この時点で DB は既に捨てられている**ので、いま書こうとしても
           *   worker には答えられない ── `appMessagePost` の控え(IndexedDB)へ
           *   積まり、読み込み直した先の**新しい** DB へ流し込まれる。
           */
          appMessagePost.post({ kind: 'result', source: 'db-rescue-reset', text: done });
          /**
           * ⚠ **読ませてから読み込み直す** ── すぐ `reload` すると
           *   「消せなかった添付が N 件」を**誰も読めない**。
           */
          await alertInApp(root, done);
          services.reloadApp?.();
        } catch (e) {
          sum.textContent = '';
          sum.hidden = true;
          dispatcher.dispatch({ type: 'OP_FAILED', error: `初期化できませんでした: ${errorText(e)}` });
        }
      });
  },
  /**
   * 🔴 **貼れる 1 行を写す**(#427 段①)。
   *
   * ## ⚠ 押した物が持っていれば、それを使う
   *
   * 情報ペインのボタンは `data-pkc-entry-ref` を**押される前に**載せている
   * (`inspector.ts`)── 押した後に選択が移っても**別のノートの参照**にならないためである。
   *
   * ## 🔴 持っていない相手には、隔の 6 つと同じ規則で組む(2026-08-29)
   *
   * ⚠ 直す前は `closest('[data-pkc-entry-ref]')` **だけ**を見ており、
   *   右クリックのメニューからは**必ず `undefined`** だった
   *   ── メニューのボタンは `data-pkc-action` しか持たず、器は
   *   **root 直下**に出るので `[data-pkc-entry-ref]` の中に居ない。
   *   しかも `return` だけなので**理由も出ない** = 無言の dead click。
   *   ⚠ これは右クリックのメニューの**先頭の 1 行**である。
   * 🔑 #578 で `adopt-external-images` を直したのと**同じ穴**なので、
   *   同じ規則で解く──「押した物の中の行 → 無ければ選んでいるノート」。
   * ⚠ 組み立ては `formatEntryLink` 1 本(§7)── `inspector.ts` が載せる字と
   *   同じ関数であることを `tests/adapter/copy-entry-ref.test.ts` が pin する。
   */
  'copy-entry-ref': (dispatcher, target, services) => {
    const carried = target
      .closest<HTMLElement>('[data-pkc-entry-ref]')
      ?.getAttribute('data-pkc-entry-ref');
    const st = dispatcher.getState();
    // 🔴 解決規則は `rowLidOrSelected` の 1 本(#877)── メニューを開いた瞬間の
    //   lid が読めれば、開いたままの間に `selectedLid` が動いても引きずられない
    const lid = rowLidOrSelected(st, target);
    const meta = lid === null ? undefined : st.entryMetas.get(lid);
    const ref =
      carried ?? (meta === undefined || lid === null ? null : formatEntryLink(meta.title, lid));
    // ⚠ **黙って止めない**(#513 と同じ作法)── 押したのに何も起きないのがいちばん困る
    if (ref === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'ノートを選んでから押してください' });
      return;
    }
    /**
     * ⚠ **光るだけでは、メニューから押した人に届かない**(2026-08-29)。
     * 🔑 `data-pkc-flash` は 700ms の合図だが、右クリックのメニューは
     *   押した瞬間に**畳まれる**(`onCloseMenu`)── 光る相手が消えるので、
     *   成功しても**画面に何も残らない**(dead click と見分けが付かない)。
     * 🔴 **字は `copyText` に渡す**(動線レビュー 欠陥 2)── ここで `showStatus` を
     *   撃っても、clipboard の `.then` が**12ms 後に上書きする**(実測)。
     */
    services.copyText?.(ref, 'ノートの参照をコピーしました(本文に貼れます)');
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
    /**
     * 🔴 **メニューの身元を先に確かめる**(#596 D。着地前レビュー ⚠5)。
     *
     * ⚠ この受け手は**押した時点の `openBody` から取り直す**が、ボタンの**字**は
     *   メニューを組んだ時の枚数で焼かれている ── メニューを出したまま本文が
     *   替わると、「(3 枚)」と書いてあるのに**別のノートの 12 枚**を外へ取りに行き、
     *   そのノートの本文を書き換える。
     * 🔑 同じメニューに載る 3 つと**同じ門**をくぐらせる。
     */
    if (refuseStaleMenu(dispatcher, target)) return;
    /**
     * 🔴 **解決規則を隣と揃える**(#500 案 C。`export-folder` と同じ理由)。
     *
     * ⚠ 直す前は `target.getAttribute('data-pkc-entry')` **だけ**を見ていた ──
     *   右クリックのメニューのボタンは `data-pkc-action` しか持たない(器は
     *   root 直下に出るので `[data-pkc-entry]` の**中に居ない**)ので、
     *   そのままメニューへ出すと **`lid` が `null` = 押しても無言**になる。
     * 🔑 隣の `export-folder` / `write-back-file` / `delete-entry` と同じく、
     *   「押した物の中の行 → 無ければ選んでいるノート」で解く。
     */
    const lid =
      target.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ??
      dispatcher.getState().selectedLid;
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
      /**
       * 🔴 **進行中の字を、まず消す**(#1017 C5)。⚠ 直す前は、1 枚も取れなかった回(下の
       *   `OP_FAILED` だけ)と本文へ当てられなかった回(`blocked`)で「取りに行っています…」が
       *   画面下に**残った**。結果の字が出る回はそれが置き換える(同じ行)ので、先に消して構わない。
       */
      services.showStatus?.('');
      if (adopted.size > 0) {
        /**
         * 🔴 **本文へ当てられないなら「取り込みました」と言わない**(#1051)。
         * ⚠ 取りに行っている数秒の間に、同じノートの編集へ入れる ── 直す前は
         *   reducer が黙って捨てるのに、ここは「取り込みました」と言っていた
         *   (本文は 1 文字も変わらない)。
         * 🔑 判定は reducer と**同じ関数**(§7)。断る字は reducer が出すので、
         *   ここは撃ったうえで**成功の一報と失敗の内訳を出さない**だけにする
         *   (内訳を出すと `error` の 1 枠を上書きし、断りの理由が消える)。
         */
        const blocked = bodyWriteBlockReason(dispatcher.getState(), lid);
        dispatcher.dispatch({
          type: 'ADOPT_EXTERNAL_IMAGES',
          lid,
          adopted: Object.fromEntries(adopted),
        });
        if (blocked !== null) return;
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
    }).catch((e: unknown) => {
      /**
       * 🔴 **例外で落ちた回も、進行中の字を消す**(#1017 C5 Q3)。⚠ 直す前は `void` で投げっぱなしで、
       *   「取りに行っています…」が居座り、理由はどこにも出なかった。
       */
      services.showStatus?.('');
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `外部の画像を取り込めませんでした(${errorText(e)})`,
      });
    });
  },
  /**
   * 🔴 **このノートの外から開けるリンクをコピー**(2026-10-11)。解決規則は `copy-entry-ref` と同じ
   *   (`rowLidOrSelected`)。⚠ 組むのは `deep-link.ts` の `entryPermalink` 1 本 ── `location` を読むのはあちら。
   * ⚠ 組めないときは黙らず理由を出す。
   */
  'copy-entry-link': (dispatcher, target, services) => {
    const st = dispatcher.getState();
    const lid = rowLidOrSelected(st, target);
    if (lid === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'ノートを選んでから押してください' });
      return;
    }
    const url = entryPermalink(st.cid, lid);
    if (url === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'このノートのリンクを作れませんでした(この PKC のアドレスが読めません)' });
      return;
    }
    services.copyText?.(url, 'ノートのリンクをコピーしました(この PKC を使っている自分のブラウザで開けます。別の人には、ノートを書き出して渡してください。ブックマークするときは、このリンクを開き直してから登録します)');
    flashCopied(target);
  },
  /**
   * 🔴 **添付の外から開けるリンクをコピー**(2026-10-11)。key は押した要素(添付の詳細のボタン)が
   *   持っていればそれ、無ければ(右クリック)**開いている添付ノートの本文**から引く。
   */
  'copy-asset-link': (dispatcher, target, services) => {
    const st = dispatcher.getState();
    let key = target.closest<HTMLElement>('[data-pkc-asset-key]')?.getAttribute('data-pkc-asset-key') ?? null;
    // 🔴 持ち主の添付ノート(同じ file を 2 つのノートに付けると key が同じ ── リンクに持ち主を載せる)
    let owner: string | null =
      target.closest<HTMLElement>('[data-pkc-asset-owner]')?.getAttribute('data-pkc-asset-owner') ?? null;
    if (key === null || key === '') {
      const lid = rowLidOrSelected(st, target);
      owner = lid;
      // ⚠ 本文は**開いているノートの物**でなければならない(別の添付の key を写さない)
      const body = lid !== null && st.openBody?.lid === lid ? st.openBody.body : null;
      key = body === null ? null : readAttachmentMeta(body).assetKey || null;
      if (body === null) {
        dispatcher.dispatch({ type: 'OP_FAILED', error: 'ノートを開き終わってからもう一度押してください' });
        return;
      }
    }
    const url = key === null ? null : assetPermalink(st.cid, key, owner);
    if (url === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'この添付のリンクを作れませんでした(添付の実体が見つかりません)' });
      return;
    }
    services.copyText?.(url, '添付のリンクをコピーしました(ブラウザやメールに貼れます)');
    flashCopied(target);
  },
  'copy-asset-ref': (_dispatcher, target, services) => {
    // ⚠ 渡すのは**貼れる 1 行**(`![名前](asset:key)`)── 裸の `asset:key` を
    //    渡していた頃は、貼っても markdown としてはただの文字列だった(段⑱)。
    //    組み立ては描画側(`asset-ref-format.ts` 経由)。ここでは組み立て直さない
    const ref = target
      .closest<HTMLElement>('[data-pkc-asset-ref]')
      ?.getAttribute('data-pkc-asset-ref');
    if (!ref) return;
    services.copyText?.(ref, '添付の参照をコピーしました(本文に貼れます)');
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
  /**
   * 🔴 **書庫の中を見る**(#818)。⚠ 出るのは zip の添付にだけ
   *   (`isZipAttachment` ── 押せるのに必ず失敗する口を作らない)。
   */
  'browse-archive': (dispatcher, target, services, root) => {
    const key = target.getAttribute('data-pkc-asset-key');
    if (key === null || key === '') return;
    void browseArchive(
      root,
      services,
      key,
      target.getAttribute('data-pkc-asset-name') ?? 'zip ファイル',
      // 🔴 **押した瞬間の選択**を控える(別の窓で選んでいる間に動きうる)
      dispatcher.getState().selectedLid,
      // ⚠ 組めずに投げた回も**黙って終わらせない**(押して無反応にしない)
    ).catch(() => services.showStatus?.('zip ファイルの一覧を作れませんでした', CAUTION));
  },
  'download-asset': (dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-key');
    const name = target.getAttribute('data-pkc-asset-name') ?? 'download';
    if (!key) return;
    /**
     * 🔴 **本文のリンク(`.pkc-asset-link`)だけ別の道**(#1163 依頼 55 の 1・2)。⚠ 添付のノートの「添付をダウンロード」ボタンは
     *   同じ action を使うが、そちらは**必ず保存**する(PDF も保存できる道を残す)── 見分けは押した物の class。
     */
    if (target.classList.contains('pkc-asset-link') && services.openAssetLink) {
      services.openAssetLink(key, name, targetLid(dispatcher, target) ?? undefined);
      return;
    }
    services.downloadAsset?.(key, name);
  },
  /**
   * 🔴 **画像を別窓で見る**(#192)。⚠ 開けなかったとき(popup 阻止)の後始末は
   *   呼ばれる側が持つ ── ここで持つと、経路が増えたときに片方だけ古くなる。
   */
  'view-asset': (dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-key');
    const name = target.getAttribute('data-pkc-asset-name') ?? '添付';
    // ⚠ MIME を**押した要素から**運ぶ ── 開く側で引き直すと、開くまでに
    //    選択が移った場合に**別の添付の種類**で開いてしまう
    const mime = target.getAttribute('data-pkc-asset-mime') ?? '';
    // 🔴 押した添付のノート(属性が無ければ選択へ落ちる ── 他の口と同じ作法)
    const lid = targetLid(dispatcher, target);
    if (key) services.viewAsset?.(key, name, mime, lid ?? undefined);
  },
  /** 🔴 **画像に描き込む**(#683 段③)。判断は `image-draw.ts`、窓は `image-draw-window.ts`。 */
  'draw-on-image': (dispatcher, target, services) => {
    const key = target.getAttribute('data-pkc-asset-key');
    const name = target.getAttribute('data-pkc-asset-name') ?? '画像';
    const mime = target.getAttribute('data-pkc-asset-mime') ?? '';
    // 🔴 押した添付のノート(置き場のフォルダを引く起点。属性が無ければ選択へ落ちる ── 他の口と同じ作法)
    const lid = targetLid(dispatcher, target);
    if (key) services.drawOnImage?.(key, name, mime, lid ?? undefined);
  },
  'dismiss-notices': (_dispatcher, _target, services) => {
    services.dismissNotices?.();
  },
  // 🔴 **直前の取込を取り消す**(#535 ②)── 消す規則も件数も実体側(`import-undo.ts`)
  'undo-import': (_dispatcher, _target, services) => {
    services.undoImport?.();
  },
  /**
   * 🔴 **段組みを回す**(#522 / #426 段②)。
   *
   * 🔑 **`Alt+C` と同じ関数を呼ぶだけ**(`cycleReadColumns`)── 段数の決め方も、
   *   効かない幅のときの断り文も、あちらが 1 か所で持っている。
   * ⚠ ここで数え直すと、鍵と右クリックで**別の段数**が出る(CLAUDE.md §7)。
   */
  'cycle-read-columns': (_dispatcher, _target, services, root) => {
    cycleReadColumns(root, (text) => services.showStatus?.(text));
  },
  /**
   * 🔴 **いま読んでいるノートを横へ留める**(#505 段②)。
   *
   * ⚠ 押し所は**本文の右クリック**なので、対象は `selectedLid` である
   * (行から押すと、その行が選ばれてしまって**同じ物が 2 枚並ぶ**)。
   * ⚠ **断り文はここに書かない** ── 満杯・フォルダの理由は reducer が 1 か所で
   * 出す(2 か所に規則を置かない。CLAUDE.md §7)。
   */
  'pin-split': (dispatcher, target) => {
    /**
     * 🔴 **押した物が身元を持っていれば、それを載せる**(#633 段①)。
     *
     * ⚠ 直す前は**いつでも `selectedLid`** だったので、帯の札を押しても
     *   「いま選んでいるノート」が載っていた ── 札の名前と起きることが食い違う。
     * 🔑 帯の札は**もう載っている物を一番上へ上げる**ために押す(裁定④)。
     * ⚠ 本文の右クリックから来たときは身元を持たないので、今までどおり
     *   `selectedLid` に落ちる(**同じ受け手 1 つ**のまま ── §7)。
     */
    const own = target.closest<HTMLElement>('[data-pkc-lid]')?.getAttribute('data-pkc-lid');
    const lid = own !== null && own !== undefined && own !== '' ? own : dispatcher.getState().selectedLid;
    if (lid === null) return;
    dispatcher.dispatch({ type: 'PIN_SPLIT_ENTRY', lid });
  },
  /**
   * 🔴 **いまのスタックを「スタック」のノートとして保存する**(#633 段③。帯の「保存…」)。
   *
   * ⚠ 題名は聞く(`promptInApp`)── 既定は「スタック M/D」。⚠ 本文は**いまの並びの順**で
   *   `stackBody` が組む(上から順 = 帯の左から)。
   * 🔴 **読んでいる本文を退かさない** ── `CREATE_ENTRY` は既定で選択を新しい物へ動かすので、
   *   `keepSelection: true` で作り、できた物へは知らせの「開く」で行ける(#668 A の口)。
   * ⚠ 空のスタックは保存しない / 編集中は断る(帯のボタンも `disabled` だが、鍵からも来る)。
   */
  'stack-save': (dispatcher, _target, _services, root) => {
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}、スタックを保存してください` });
      return;
    }
    const lids = knownSplitLids(st.splitLids, st.entryMetas);
    if (lids.length === 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: 'スタックに載せてあるノートがありません(先に載せてください)',
      });
      return;
    }
    const now = new Date();
    const initial = `スタック ${String(now.getMonth() + 1)}/${String(now.getDate())}`;
    void promptInApp(root, {
      title: 'スタックを保存する',
      label: `${String(lids.length)} 件の並びを、リンクの箇条書きのノートとして保存します。題名:`,
      initial,
      okLabel: 'スタックを保存する',
    }).then((title) => {
      if (title === null) return;
      // ⚠ 開いている間に降ろされていることがある ── 保存するのは**押した時点ではなく決めた時点**の並び
      const cur = dispatcher.getState();
      const items = knownSplitLids(cur.splitLids, cur.entryMetas).map((lid) => ({
        lid,
        title: cur.entryMetas.get(lid)?.title ?? '',
      }));
      if (items.length === 0) {
        dispatcher.dispatch({ type: 'OP_FAILED', error: 'スタックが空になったので保存しませんでした' });
        return;
      }
      const lid = generateLid();
      dispatcher.dispatch({
        type: 'CREATE_ENTRY',
        lid,
        title,
        archetype: STACK_ARCHETYPE,
        body: stackBody(items),
        edit: false,
        keepSelection: true,
      });
      dispatcher.dispatch({
        type: 'OP_NOTICE',
        message: `「${title}」に ${String(items.length)} 件の並びを保存しました`,
        open: lid,
      });
    });
  },
  /**
   * 🔴 **保存したスタックを載せる**(#633 段③「このスタックを載せる」)。
   * ⚠ 対象は押した行(情報ペインのボタンは `data-pkc-entry` を持つ)か、無ければ選んでいるノート。
   *   積み方(上に積む・見つからない物を数える)は reducer(`LOAD_STACK`)が 1 か所で持つ。
   */
  'stack-load': (dispatcher, target) => {
    // 🔴 解決規則は `rowLidOrSelected` の 1 本(#877)
    const lid = rowLidOrSelected(dispatcher.getState(), target);
    if (lid === null) return;
    dispatcher.dispatch({ type: 'LOAD_STACK', lid });
  },
  /**
   * 🔴 **保存したスタックの中の 1 行を上 / 下へ**(#633 段④)。
   *
   * ⚠ どのノートの行かは**押した所から引く**(`lidOfNode` ── 横の枠なら `data-pkc-split-lid`、
   *   主の枠なら開いているノート。`toggle-task` と同じ引き方)。行番号は押し所に焼いた
   *   **原文の行**(`data-pkc-line`)。門(編集中 / byte 一致)は reducer と `body-rewrite.ts` が持つ。
   */
  'stack-link-up': (dispatcher, target, services) => moveStackLink(dispatcher, target, 'up', services),
  'stack-link-down': (dispatcher, target, services) => moveStackLink(dispatcher, target, 'down', services),
  /** 🔴 **外す**(#505 段②)。⚠ 置けるなら外せる ── 枠の中の `× 外す` が押す。 */
  'unsplit-entry': (dispatcher, target) => {
    const lid = target.closest<HTMLElement>('[data-pkc-lid]')?.getAttribute('data-pkc-lid');
    if (lid === null || lid === undefined || lid === '') return;
    dispatcher.dispatch({ type: 'UNPIN_SPLIT_ENTRY', lid });
  },
  /**
   * 🔴 **アプリは 2 回押すと開く**(#857 段①b。user 裁定 2026-09-13
   * 「開くのはダブルタップに変更」)。
   *
   * ## なぜ 1 回でやめたか
   *
   * タイルは**掴んで並べ替えられる**(段①)ので、掴もうとして数 px 動かして
   * 離すとブラウザは drag を始めず、**ただの押し**になる。⚠ 直す前はそれで
   * **別のウィンドウが開き、中央に読んでいた本文まで入れ替わった**
   * ── user は並べ替えたかっただけなので、窓を閉じてノートを探し直すことになる。
   *
   * ## ⚠ ネイティブの `dblclick` に頼らない
   *
   * フォルダの 2 回押し(`maybeDoubleOpen`)と**同じ理由**である ── ブラウザは
   * 「同じ node を 2 回」でしか `dblclick` を出さないが、この一覧は書込の ack で
   * **丸ごと組み直る**(`launcher.ts` は `textContent = ''` から描く)。
   * 🔑 だから**同じ lid への連続押し**で見る ── node が入れ替わっても lid は同じ。
   *
   * 🔑 1 回目は**印を付ける**(`PICK_APP_TILE`)── 無反応にしない。
   *   entry を持つタイルは右の列にも出す(判定の正本は `tileSelectsEntry` 1 本)。
   */
  'open-tile': (dispatcher, target, services, root) => {
    const lid = target.closest('[data-pkc-tile]')?.getAttribute('data-pkc-tile');
    if (lid === null || lid === undefined || lid === '') return;
    /**
     * 🔴 **並べ替え中は開かない**(#857 段①b-2。user 裁定 2026-09-13)。
     * ⚠ 並べ替えている最中に別のウィンドウが開くと、**中央に読んでいた本文まで
     *   入れ替わる**(段①b でこれを止めたのと同じ事故が、モード中は 2 回押しで
     *   起きてしまう)。⚠ **印は付ける** ── 押しても何も起きないのは無反応に見える。
     * ⚠ `pressedTileAgain` を**通さない** ── 通すと「1 回目」が記録され、
     *   モードを抜けた直後の 1 タップが**いきなり窓を開く**。
     */
    if (dispatcher.getState().launcherReorder) {
      dispatcher.dispatch({ type: 'PICK_APP_TILE', lid });
      return;
    }
    if (!pressedTileAgain(root, lid)) {
      dispatcher.dispatch({ type: 'PICK_APP_TILE', lid });
      // ⚠ 組み込みは entry を持たない ── 立てると右の列が「見つからない」になる
      const tile = dispatcher.getState().launcherTiles?.find((t) => t.lid === lid);
      if (tile !== undefined && tileSelectsEntry(tile))
        dispatcher.dispatch({ type: 'SELECT_ENTRY', lid });
      return;
    }
    services.openTile?.(lid);
  },
  /**
   * 🔴 **その 1 回だけ、右クリックで選んだ開き方で開く**(#884 段②。user 要望
   *   2026-09-13「デフォルト選択の他に右クリックからの起動が選べるとなお良い」)。
   *
   * ⚠ **設定は書き換えない** ── `services.setAppOpenTarget` を呼ばない。次に
   *   ふつうにタイルを押したときは、また設定どおりの開き方に戻る
   *   (`tests/adapter/tile-open-target-menu.test.ts` が「選んだ後、設定は
   *   変わっていない」を見る)。
   * ⚠ **`open-tile` の「並べ替え中は開かない」/「1 回目は印を付けるだけ」を
   *   通さない** ── メニューから選ぶのは「掴もうとして離れた」誤操作ではなく、
   *   user が明示にこの項目を選んだ操作である。二重の待ちを作らない。
   * ⚠ 綴りの検めは実体側(`isAppOpenTarget`)── `setAppOpenTarget` と同じ作法
   *   (binder は `data-pkc-open-target` の値をそのまま渡す)。
   */
  'open-tile-as': (_dispatcher, target, services) => {
    const lid = target.getAttribute('data-pkc-tile');
    const openTarget = target.getAttribute(TILE_OPEN_TARGET_ATTR);
    if (lid === null || lid === '' || openTarget === null || openTarget === '') return;
    services.openTileAs?.(lid, openTarget);
  },
  /**
   * 🔴 **マニュアルの窓を開く**(#645)。⚠ ヘルプの中の口(`help.ts`)と
   *   アプリの一覧のタイル(`tiles.ts` の `builtin:manual`)は、どちらも
   *   最後は同じ 1 本(`platform/manual-window.ts`)へ落ちる。
   */
  'open-manual-window': (dispatcher, _target, services) => {
    // ⚠ **無言で終えない** ── 配線が落ちた版でも、押した手応えは返す
    if (services.openManualWindow === undefined) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: MANUAL_WINDOW_STALE });
      return;
    }
    services.openManualWindow();
  },
  /**
   * 🔑 **作る種類の一覧を開く / 閉じる**(P10 の分割ボタン)。
   * ⚠ `<details>` を使わない ── この repo は「主要な導線を畳まない」を規律に持ち、
   *   shell に `<details>` が 0 件であることを test で pin している。
   * 🔑 **例外が 1 つ在る**(#855。Gemini 裁定 = #1163 の依頼 10-A):予定表の「出すもの」(3 つの絞りを畳んだ小さな
   *   枠)は `<details>` で作る。主要な導線ではなく、既定で隠している絞りの出し入れだけを畳む物で、
   *   shell(`buildShell`)の骨組みには入らない ── 面が描いたときにだけ在る。
   */
  'toggle-create-menu': (_dispatcher, target, _services, root) => {
    const menu = root.querySelector<HTMLElement>('[data-pkc-region="create-menu"]');
    if (!menu) return;
    const open = menu.hidden;
    menu.hidden = !open;
    target.setAttribute('aria-expanded', open ? 'true' : 'false');
    /**
     * 🔑 **開いたら、先頭の押せる項目へ焦点を移す**(#1054 段②-3。OS のメニューと同じ)。
     * ⚠ 直す前は焦点が `▼` に残ったので、開いた直後の `↓` が一覧の中へ届かなかった
     *   (`onCreateMenuKey` は焦点が項目の中に在るときだけ矢印を握る)。
     * ⚠ 押せない項目(編集中の「種類」「今日」)は飛ばす ── 焦点が当たらない。
     */
    if (open) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  },
  /**
   * 🔑 **作る種類を選ぶ**(P10)。押した種類を「いま作るもの」にして、
   * **本体のボタンの文言・図案**と **`Ctrl+N` の対象**を同時に切り替える。
   * ⚠ 保持場所は `<select>` 1 か所 ── ボタンの属性と select が食い違うと、
   *   押した種類と出来るものが別になる(いちばん困る形)。
   * 🔴 **端末側にも覚える**(#1045)── 次に起動したとき `shell.ts` がここを読む。
   *
   * 🔴 **選ぶと、その場で作る**(#1054 段②。裁定 #1054 コメント 5837587559)。
   * ⚠ 直す前は「次の `create-entry` の対象を変えるだけ」で、作るには
   *   もう一押し(本体のボタン)が要った ── OS 風の合成メニューでは、種類を
   *   選ぶ**その 1 手**が「作る」を兼ねる。⚠ 入れ先は `create-entry` 自身と
   *   **同じ規則**(いま見ているフォルダの中。`createAndEdit` を再利用する ──
   *   §7「同じ判定を 2 か所に書かない」)。
   */
  'pick-create-kind': (dispatcher, target, services, root) => {
    const archetype = target.getAttribute('data-pkc-archetype');
    if (!archetype) return;
    appCreateKind.set(archetype);
    const select = root.querySelector<HTMLSelectElement>('[data-pkc-field="create-kind"]');
    if (select) select.value = archetype;
    const run = root.querySelector<HTMLElement>('[data-pkc-field="create-run"]');
    if (run) {
      run.setAttribute('data-pkc-archetype', archetype);
      const label = run.querySelector('[data-pkc-field="label"]');
      // ⚠ 文言は**選んだ項目の文言**をそのまま使う(表を 2 つ持たない)
      const picked = target.querySelector('[data-pkc-field="label"]')?.textContent ?? archetype;
      if (label) label.textContent = `+ ${picked}`;
      // 🔴 hover の説明も選んだ種類の名前にする(押せない理由が付いていれば残す)
      run.setAttribute(HINT_BASE, createHintOf(picked));
      setBlocked(run, run.getAttribute(HINT_BLOCKED));
      const icon = run.querySelector('[data-pkc-icon]');
      // ⚠ `textContent` で書かない ── 絵は CSS の `::before` が出すので、器の字を
      //    書き換えても 1 ドットも変わらない。差し替えるのは名前(`data-pkc-symbol`)
      // 🔴 `setIcon` を直に呼ばない ── 絵の既定 tone(種類の絵は全部 `kind`)へ
      //    戻り、「作る」の色が黙って消える(#1054 段①-2 の着地前レビュー)
      if (icon) {
        const action = run.getAttribute('data-pkc-action') ?? 'create-entry';
        setActionIcon(icon, action, ARCHETYPE_ICONS[archetype] ?? 'dot');
      }
    }
    const menu = root.querySelector<HTMLElement>('[data-pkc-region="create-menu"]');
    if (menu) menu.hidden = true;
    root
      .querySelector('[data-pkc-field="create-pick"]')
      ?.setAttribute('aria-expanded', 'false');
    const st = dispatcher.getState();
    const parent = st.scopeLid === null ? null : (st.entryMetas.get(st.scopeLid) ?? null);
    createAndEdit(dispatcher, services, archetype, parent?.lid ?? null);
  },
  /**
   * 🔴 **対象は、押したボタンが持つ**(2026-09-12、#770 段②の着地前レビュー B)。
   *
   * ⚠ 直す前は 3 本とも `selectedLid` だけを見ていた ── **留めた枠**(横に並べた枠)は
   *   選択と関係なく「その 1 件」を出す面なので、そこで押すと**主の枠のノート**が
   *   開いていた。🔴 「ノートを渡して起動」は**確認に出る題名まで別のノート**になる。
   * 🔑 `download-asset` / `open-office` と同じ作法へ寄せた(`detail.ts` が
   *   `data-pkc-target-lid` を載せる)。⚠ 属性が無い版でも壊れないよう、
   *   **属性 → 無ければ `selectedLid`** の順で読む。
   */
  'launch-asset': (dispatcher, target, services) => {
    const lid = targetLid(dispatcher, target);
    if (lid) services.launchAsset?.(lid, { sameOrigin: false });
  },
  'launch-asset-raw': (dispatcher, target, services) => {
    const lid = targetLid(dispatcher, target);
    if (lid) services.launchAsset?.(lid, { sameOrigin: true });
  },
  /**
   * 🔴 **目次を見せて起動**(#195 / C-5 段①)。⚠ ボタンは**まだ許していないとき
   * だけ**出る(許してあれば普通の「起動」で口が開く ── `detail.ts`)。
   */
  'launch-asset-extension': (dispatcher, target, services) => {
    const lid = targetLid(dispatcher, target);
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
  // 🔴 取り込みをやめる(台帳 #1852 束 T1、依頼 156 ②)。判断と文言は実体(`OfficePackInstaller`)が持つ
  'cancel-office-install': (_dispatcher, _target, services) => {
    services.cancelOfficeInstall?.();
  },
  'choose-office-pack': (_dispatcher, target) => {
    target
      .closest('[data-pkc-region="settings-office"]')
      ?.querySelector<HTMLInputElement>('[data-pkc-field="office-pack-input"]')
      ?.click();
  },
  /**
   * 🔴 **消す前に確認を出す**(#1363 項目 5)── 一式は約 100MB あり、ダウンロードし直すには時間が掛かる。
   * ⚠ 大きさは定数から引く(手で綴ると、一式を焼き直した日に字だけ古くなる)。
   * ⚠ `answer !== 'ok'`(やめる / Esc / 背面を押した)なら**何も消さない**。
   */
  'remove-office-pack': (_dispatcher, _target, services, root) => {
    void confirmInApp(
      root,
      `Office の一式(${OFFICE_PACK_APPROX})を消します。もう一度ダウンロードすれば戻ります。`,
      { okLabel: '消す', cancelLabel: 'やめる', danger: true },
    ).then((answer) => {
      if (answer !== 'ok') return;
      services.removeOfficePack?.();
    });
  },
  /**
   * 🔴 **音声認識の部品を入れる / やめる / 消す**(#772 段②)。⚠ **どの部品かは押した
   *   ボタンが持つ**(`data-pkc-part`)── 2 択を 1 つの受け手で扱う。
   * ⚠ 判断も文言も `AsrPackInstaller` が持つ(binder は渡すだけ)。
   */
  'install-asr-part': (_dispatcher, target, services) => {
    const id = target.getAttribute('data-pkc-part');
    if (id) services.installAsrPart?.(id);
  },
  'cancel-asr-install': (_dispatcher, _target, services) => {
    services.cancelAsrInstall?.();
  },
  'remove-asr-part': (_dispatcher, target, services) => {
    const id = target.getAttribute('data-pkc-part');
    if (id) services.removeAsrPart?.(id);
  },
  /**
   * 🔴 **Office の設定を初期状態に戻す**(#634)。⚠ 引数を採らない ──
   * 消すのは決まった 1 鍵(`pkc3-office-profile`)だけである。
   */
  'reset-office-profile': (_dispatcher, _target, services) => {
    services.resetOfficeProfile?.();
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
  /**
   * 🔴 **ブラウザの AI に許した範囲を取り消す**(#1407)。
   * ⚠ 許可は**期限なし**で憶えるので、外す出口がここに無いと二度と外せない。
   */
  'revoke-agent': (_dispatcher, target, services) => {
    const scope = target.getAttribute('data-pkc-agent-scope');
    // 🔴 組み込み先のページの AI の行は origin を持つ(同じ範囲でも台帳が別)
    const origin = target.getAttribute('data-pkc-agent-origin');
    if (scope !== null && scope !== '') {
      if (origin !== null && origin !== '') services.revokeAgent?.(scope, origin);
      else services.revokeAgent?.(scope);
    }
  },
  /**
   * 🔴 **「システム」の目次から節へ飛ぶ / 「上へ」で目次へ戻る**(#1017 段⓪)。
   * ⚠ 行き先の `data-pkc-section` は `settings.ts` の `buildToc` が焼く(綴りは 1 か所)。
   *   `top` は実在する id ではなく「目次へ戻る」の合図である。
   */
  'system-jump': (_dispatcher, target) => {
    const id = target.getAttribute('data-pkc-target');
    if (id === null || id === '') return;
    const pane = target.closest<HTMLElement>('[data-pkc-view-pane="settings"]');
    if (pane === null) return;
    const dest =
      id === 'top'
        ? pane.querySelector<HTMLElement>('[data-pkc-region="settings-toc"]')
        : pane.querySelector<HTMLElement>(`[data-pkc-section="${CSS.escape(id)}"]`);
    dest?.scrollIntoView({ block: 'start' });
  },
  /**
   * 🔴 **ヘルプの「お知らせを開く」→ システムの「お知らせ」へ**(#1017 段③-2。
   *   裁定 2026-09-20 6 巡目「お知らせの入口はシステムへ移す。ヘルプにも
   *   リンク 1 行を残す」)。
   *
   * ⚠ `dispatch` は同期(`Dispatcher.dispatch`)なので、`openView` が返った時点で
   *   `CenterRouter.render` が既に「システム」を描いている ── `system-jump` と
   *   違い、押した時点ではまだ settings pane に居ないので `root` から探す。
   */
  'open-system-notices': (dispatcher, target, services, root) => {
    openSystemNotices(dispatcher, root);
    // 🔴 お知らせのカードから押したときは、カードをしまう(読んだことにはしない)。スマホではカードが画面いっぱいに出ていて、
    //   しまわないと一覧が下に隠れたままになる(台帳 #1852 束 L2、依頼 80-2)
    if (target.closest('[data-pkc-region="announce"]') !== null) services.hideAnnounce?.();
  },
  /**
   * 🔴 **「← ヘルプへ戻る」**(依頼 67-1)── ヘルプから「お知らせを開く」で来たときだけ出る。
   * 読んでいた位置へ戻す(`helpReturn`。位置を控えていない回は先頭のまま)。
   */
  'back-to-help': (dispatcher, _target, _services, root) => {
    const keep = helpReturn;
    helpReturn = null;
    openView(dispatcher, 'help');
    root
      .querySelector<HTMLElement>('[data-pkc-field="settings-back-to-help"]')
      ?.setAttribute('hidden', '');
    if (keep === null) return;
    const restore = (): void => {
      const outer = root.querySelector<HTMLElement>('[data-pkc-region="detail"]');
      if (outer !== null) outer.scrollTop = keep.outer;
      const manual = root.querySelector<HTMLElement>('[data-pkc-region="help-manual"]');
      if (manual !== null) manual.scrollTop = keep.manual;
    };
    restore();
    /**
     * 🔴 **手放してあったマニュアルは、入れ直しが終わってから位置を書く**(5 分離れていた回。`HELP_MANUAL_IDLE_MS`)。
     * ⚠ 入れ直しは非同期で、描き終えるまでは本文が「読み込んでいます…」の 1 行しか無い ── いま書いても高さが足りず
     *   0 に丸められ、描き終えた後は先頭のままになる。だから描き終えた合図(`HELP_MANUAL_DRAWN_EVENT`)でもう 1 度書く。
     */
    const loading = root.querySelector<HTMLElement>(
      '[data-pkc-region="help-manual"][data-pkc-manual-loading]',
    );
    // ⚠ 聞き耳は**器そのもの**に張る(器は捨てないので、1 回で外れる `once` なら外し忘れは残らない)
    if (loading !== null) loading.addEventListener(HELP_MANUAL_DRAWN_EVENT, restore, { once: true });
  },
  /**
   * 🔴 **Office の添付の画面から、一式を取り込む場所(システム → 保存領域 → Office 表示)へ**(依頼 61-2)。
   * ⚠ 新しい仕組みを作らない ── `open-storage-check` と同じ形。
   */
  'open-system-office': (dispatcher, _target, _services, root) =>
    openSystemRegion(dispatcher, root, 'settings-office'),
  /**
   * 🔴 **保存が止まった断り書きから、「システム」の「保存領域の点検」へ**(#1010 B)。
   *
   * ⚠ 新しい仕組みを作らない ── `open-system-notices` と同じ形(`openView` は同期で
   *   「システム」を描き終えるので、その後に飛び先の節を探せる)。
   * ⚠ 飛び先は点検の節(`db-rescue`)。断り書きが「点検で『作り直す・初期化する のボタンを出す』を
   *   押し」と案内する入口がそこにある。
   */
  'open-storage-check': (dispatcher, _target, _services, root) => {
    openView(dispatcher, 'settings');
    root
      .querySelector<HTMLElement>('[data-pkc-region="db-rescue"]')
      ?.scrollIntoView({ block: 'start' });
  },
  /**
   * 🔴 **メッセージ(system 領域のノート)を開く**(設計 doc §7、段②a)。
   *
   * ⚠ `select-entry` を使い回さない ── あちらは `entryMetas.has(lid)` を通るので
   *   system のノートでは黙って no-op になる(#7「開く / 処理の記録を開く」)。
   * 🔑 開くのは「既読にする唯一の入口」でもある(§7「既読」)── state 側は
   *   `MESSAGES_READ` reducer が `error` / `messagesUnread` を消し、
   *   端末側は `appMessagePost.markRead()` が既読の時刻を進める(2 か所に
   *   同じ役目を持たせない ── 前者は state、後者は localStorage)。
   */
  'open-messages': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-message-lid');
    if (lid === null || lid === '') return;
    openMessagesFromButton(dispatcher, lid);
  },
  /**
   * 🔴 **メッセージの保管件数を選ぶ**(設計 doc §7、段②a)。
   * ⚠ 選べる値以外は `setMessageCap` が黙って無視する(壊れた値を書かせない)。
   * ⚠ `set-theme` と同じ受け方(`<select>` でもボタンでも通す ── #1038 段J)。
   */
  /**
   * 🔴 **メッセージを種類で絞る**(台帳 #1852 束 L1、依頼 266)── 画面に出す物を絞るだけ(disk の本文・書き出しは変えない)。
   * 本文の読み直しは「既読にしない」`MESSAGES_BODY_REFRESH`(絞った本文は `store-effects.ts` が作る)。
   */
  'set-message-filter': (dispatcher, target) => {
    setMessageKindFilter(messageFilterOfAttr(target.getAttribute('data-pkc-message-filter')));
    dispatcher.dispatch({ type: 'MESSAGES_BODY_REFRESH', lid: SYSTEM_MESSAGE_LID });
  },
  'set-message-cap': (_dispatcher, target) => {
    const raw =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-message-cap-value');
    const n = raw === null ? NaN : Number(raw);
    if (MESSAGE_CAP_OPTIONS.includes(n)) setMessageCap(n);
  },
  /**
   * 🔴 **メッセージを書き出す**(設計 doc §7、段②a)── バグ報告に貼る用。
   * ⚠ **新しい書き出しの仕組みを作らない**(§7「普通のノートと同じ道具」)──
   *   本文をそのまま `.md` として落とすだけ(整形・要約はしない)。
   */
  'export-messages': (dispatcher, target, services) => {
    exportMessagesNote(dispatcher, target.getAttribute('data-pkc-message-lid') ?? SYSTEM_MESSAGE_LID, services);
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
    if (format) {
      services.setPageFormat?.(format);
      // 🔴 効いたことを言う(#1650 項目 3。Gemini 裁定 = #1163 の依頼 42-3 B)。設定の画面が中央を占めていて本文は隠れたまま
      if (isPageFormat(format))
        services.showStatus?.(`読み幅を「${plainChoiceLabel(pageFormatSpec(format).label)}」にしました`);
    }
  },
  /**
   * 🔴 **本文の置き場所**(#722)。⚠ `set-page-format` と**同じ受け方**
   *   (`<select>` でもボタンでも通す)── 3 本目の作法を作らない。
   */
  'set-prose-align': (_dispatcher, target, services) => {
    const align =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-prose-align-value');
    if (align) {
      services.setProseAlign?.(align);
      // 🔴 効いたことを言う(#1650 項目 3)── `set-page-format` と同じ
      if (isProseAlign(align))
        services.showStatus?.(`本文の置き場所を「${plainChoiceLabel(proseAlignSpec(align).label)}」にしました`);
    }
  },
  /**
   * 🔴 **SQL の欄に打った**(#681 段②)。⚠ **走らせない** ── 重い問い合わせを
   *   打鍵ごとに投げない(走らせるのは `run-sql` だけ)。
   */
  'set-sql-text': (dispatcher, target) => {
    if (target instanceof HTMLTextAreaElement)
      dispatcher.dispatch({ type: 'SET_SQL_TEXT', sql: target.value });
  },
  /** 🔴 **走らせる**(#681 段②)。⚠ 字の門も engine の門も、判定は呼ばれた先に在る。 */
  'run-sql': (dispatcher) => {
    dispatcher.dispatch({ type: 'RUN_SQL' });
  },
  /**
   * 🔴 **調べる相手を選ぶ**(#681 段③ の 2 つ目、#854 段②)。
   * ⚠ `<select>` でもボタンでも通す(`set-prose-align` と同じ受け方)。
   * ⚠ **名前も一緒に渡す** ── 画面に出すのは lid ではなく file の名前である。
   */
  'set-sql-source': (dispatcher, target, services, root) => {
    const lid =
      target instanceof HTMLSelectElement
        ? target.value
        : (target.getAttribute('data-pkc-sql-source') ?? '');
    /**
     * 🔴 **「手持ちのファイルを開く…」は選択ではなく操作**(#854 段②)。
     * ⚠ ここで `SET_SQL_SOURCE` を投げると、実体の無い lid を開こうとして
     *   必ず断られる ── 代わりに隠した `<input type=file>` を開く。
     * ⚠ **選び所は即座に元へ戻す** ── 戻さないと、file 選択画面を閉じた
     *   (選ばなかった)後も選び所が「手持ちのファイルを開く…」のまま**居座る**
     *   (次に何か別の理由で描き直るまで、画面が実体と食い違う)。
     */
    if (lid === SQL_PICK_LOCAL_FILE_VALUE) {
      if (target instanceof HTMLSelectElement) {
        target.value = dispatcher.getState().sqlPage.guest?.lid ?? '';
      }
      const input = root.querySelector<HTMLInputElement>('[data-pkc-field="sql-file-input"]');
      // ⚠ 前に「足す」で開いて選ばずに閉じた印が残っていても、**置き換え**として開く
      input?.removeAttribute('data-pkc-sql-pick');
      input?.click();
      return;
    }
    /**
     * 🔴 **「もう 1 つ足す…」の中の 2 種類**(#918 段⑦。Gemini 裁定 2026-10-01 = 設問 1 は A)。
     *
     * ⚠ どちらも**選び所の値を元へ戻す** ── 足しても 1 件目は変わらないので、選び所は
     *   1 件目を指したままでなければならない(戻さないと「足す…」で居座る)。
     * 🔑 手持ちの file は `pickSqlLocalFile` と**同じ file 選択画面**を使う(新しい部品を作らない)。
     *   違いは**足すか置き換えるか**だけなので、隠した `<input>` に印を付けて見分ける。
     */
    if (lid === SQL_ADD_LOCAL_FILE_VALUE) {
      if (target instanceof HTMLSelectElement) {
        target.value = dispatcher.getState().sqlPage.guestChosen;
      }
      const input = root.querySelector<HTMLInputElement>('[data-pkc-field="sql-file-input"]');
      input?.setAttribute('data-pkc-sql-pick', 'add');
      input?.click();
      return;
    }
    const addLid = addSourceLidOf(lid);
    if (addLid !== null) {
      const st0 = dispatcher.getState();
      if (target instanceof HTMLSelectElement) target.value = st0.sqlPage.guestChosen;
      const addName = st0.entryMetas.get(addLid)?.title ?? '';
      dispatcher.dispatch({ type: 'ADD_SQL_SOURCE', lid: addLid, name: addName });
      // 🔴 足した相手が電波の要る形でも、選んだ直後に言う(`#992 ①` と同じ 1 本)
      const addNote = duckDbNetworkNoteOf(addName);
      if (addNote !== null) services.showStatus?.(addNote);
      return;
    }
    /**
     * 🔴 **名前は state から引く。画面の字は最後の手段**(2026-09-15、#682 段②)。
     *
     * ⚠ 直す前は `selectedOptions[0].textContent` だけを見ていた ── つまり
     *   **user に見える名前の出どころが DOM** だった(§7「同じ問いに答える口を
     *   2 つ作らない」の、いちばん気づけない形)。
     * 🔴 実害は「相手を選び直したとき」に出る:名前だけが**前の相手のまま**飛ぶと、
     *   画面は新しい相手を指しているのに、案内文も、拡張子で決まる振る舞い
     *   (#682 の「どのエンジンで引けるか」)も**前の相手の物**になる。
     * ⚠ そして `lid` は正しいので、**どの test も落ちない**(状態は整合して見える)。
     * 🔑 添付なら `entryMetas`、いま開いている手持ちの file なら `sqlPage.guest` が
     *   名前を持っている ── どちらも**選ぶ前から分かっている**。
     * ⚠ 画面の字へ落ちるのは、その 2 つが答えられないときだけ
     *   (押し所から来た `data-pkc-sql-source-name` の道も同じ)。
     */
    const st = dispatcher.getState();
    const known =
      st.entryMetas.get(lid)?.title ?? (st.sqlPage.guest?.lid === lid ? st.sqlPage.guest.name : undefined);
    const shown =
      target instanceof HTMLSelectElement
        ? (target.selectedOptions[0]?.textContent ?? '')
        : (target.getAttribute('data-pkc-sql-source-name') ?? '');
    const name = known ?? shown;
    dispatcher.dispatch({ type: 'SET_SQL_SOURCE', lid, name });
    /**
     * 🔴 **電波が要る相手は、選んだ直後に言う**(#992 ①)。⚠ 判定は
     *   `duckDbNetworkNoteOf` 1 か所 ── 手持ちの file を選んだ道(`sql-file-input`)も同じ関数を呼ぶ。
     */
    const note = duckDbNetworkNoteOf(name);
    if (note !== null) services.showStatus?.(note);
  },
  /**
   * 🔴 **足した相手を外す**(#918 段⑦)。⚠ 片道にしない ── 足せるなら外せる。
   * ⚠ lid は押し所の `data-pkc-sql-source` から読む(画面の字を見ない)。
   */
  'remove-sql-source': (dispatcher, target) => {
    const lid = target.getAttribute('data-pkc-sql-source') ?? '';
    if (lid !== '') dispatcher.dispatch({ type: 'REMOVE_SQL_SOURCE', lid });
  },
  /**
   * 🔴 **どのエンジンで引くかを選ぶ**(#682 段②。user 裁定 2026-09-15 = §9 は A)。
   * ⚠ **知らない字は捨てる** ── 選び所は `<select>` だが、`data-pkc-action` は
   *   誰でも付けられるので、受ける側で必ず検める(知らない値で reducer を汚さない)。
   */
  'set-sql-engine': (dispatcher, target) => {
    const want =
      target instanceof HTMLSelectElement ? target.value : (target.getAttribute('data-pkc-sql-engine') ?? '');
    if (want !== 'sqlite' && want !== 'duckdb') return;
    dispatcher.dispatch({ type: 'SET_SQL_ENGINE', engine: want });
  },
  /**
   * 🔴 **答えをノートへ書き出す**(#681 段③ の 3 つ目)。
   *
   * ⚠ この面は**別の窓**で開くので、ノートを作っても**その窓には何も起きない** ──
   *   だから作った後に**題名を画面へ返す**(`SQL_SAVED`)。返さないと、押した user には
   *   **押せなかった**ように見える(CLAUDE.md「押した後どうなるか」)。
   * ⚠ **本文の組み立ては `sql-to-note.ts`** が持つ(ここは呼ぶだけ)── 柵の長さや
   *   升の逃がし方をここに書くと、判定が 2 か所になる(§7)。
   * ⚠ **編集の面へ入らない**(`edit: false`)── 打っている途中の SQL を退かさない。
   */
  /**
   * 🔴 **調べている相手の構造を、ノート 1 枚にする**(#918 段①。user 要望 2026-09-14)。
   *
   * ⚠ **答えが無くても押せる**(`sql-to-note` との違い)── 構造は**打つ前**に要る物である。
   * ⚠ **中身は 1 文字も出ない**(表・列・型・鍵・繋がり・行数だけ)。
   * 🔑 id をここで作るのは `sql-to-note` と同じ作法 ── 純粋な reducer も effect も乱数を持たない。
   */
  /**
   * 🔴 **つながり図を開く / 閉じる**(#918 段⑤。裁定 2026-09-15 = この窓の中)。
   * ⚠ 採るのは effect の仕事 ── ここは合図を投げるだけである。
   */
  'sql-er-toggle': (dispatcher) => {
    dispatcher.dispatch({ type: 'SQL_ER_TOGGLE' });
  },
  /**
   * 🔴 **図の四角(表の名前)を押した**(#918 段⑤c)── `SELECT * FROM 表` を足す。
   * ⚠ 名前は**要素が持つ**(`data-pkc-name`)── state から引き直すと、
   *   描いた図と押した先が食い違いうる(描き直しの最中に押されたとき)。
   */
  'sql-er-table': (dispatcher, target) => {
    const table = target.getAttribute('data-pkc-name') ?? '';
    if (table === '') return;
    dispatcher.dispatch({ type: 'SQL_ER_PRESS', press: { kind: 'table', table } });
  },
  /**
   * 🔴 **図の列を押した**(#918 段⑤c / 段⑤d-1)。
   * ⚠ **「繋ぐ」が入のときは、選ぶ列に足すのではなく「繋ぎ先」を選ぶ**
   *   ── 押し所の名前(`data-pkc-action`)は同じまま、受け手の中身だけ振り分ける
   *   (CLAUDE.md §10「置き換えたのに気づけない性質」を作らないため、ここに 1 か所へ寄せる)。
   */
  'sql-er-column': (dispatcher, target) => {
    const table = target.getAttribute('data-pkc-name') ?? '';
    const column = target.getAttribute('data-pkc-col') ?? '';
    if (table === '' || column === '') return;
    if (dispatcher.getState().sqlPage.er.connecting) {
      dispatcher.dispatch({ type: 'SQL_ER_PICK', table, column });
      return;
    }
    dispatcher.dispatch({ type: 'SQL_ER_PRESS', press: { kind: 'column', table, column } });
  },
  /**
   * 🔴 **図の繋がり(線の札)を押した**(#918 段⑤c)── `JOIN` を足す。
   * ⚠ 4 つとも要る ── 1 つでも欠けたら**押しても何も起きない**ので、
   *   その場合は何も投げない(理由は `erSql` が言える形にならないため)。
   * ⚠ 自分で引いた線の札は**別の受け手**(`sql-er-unlink`)を持つ ──
   *   宣言された外部キーとは `data-pkc-action` の綴りで分けてある(消せる/消せない)。
   */
  'sql-er-link': (dispatcher, target) => {
    const from = target.getAttribute('data-pkc-from') ?? '';
    const fromColumn = target.getAttribute('data-pkc-fromcol') ?? '';
    const to = target.getAttribute('data-pkc-to') ?? '';
    const toColumn = target.getAttribute('data-pkc-tocol') ?? '';
    if (from === '' || to === '') return;
    dispatcher.dispatch({
      type: 'SQL_ER_PRESS',
      press: { kind: 'link', link: { from, fromColumn, to, toColumn } },
    });
  },
  /**
   * 🔴 **「繋ぐ」モードの入切**(#918 段⑤d-1)。
   */
  'sql-er-connect-toggle': (dispatcher) => {
    dispatcher.dispatch({ type: 'SQL_ER_CONNECT_TOGGLE' });
  },
  /**
   * 🔴 **自分で引いた線の札を押した**(#918 段⑤d-1)── 消す。
   * ⚠ 4 つとも要る(`sql-er-link` と同じ理由)。
   */
  'sql-er-unlink': (dispatcher, target) => {
    const from = target.getAttribute('data-pkc-from') ?? '';
    const fromColumn = target.getAttribute('data-pkc-fromcol') ?? '';
    const to = target.getAttribute('data-pkc-to') ?? '';
    const toColumn = target.getAttribute('data-pkc-tocol') ?? '';
    if (from === '' || to === '') return;
    dispatcher.dispatch({ type: 'SQL_ER_UNLINK', link: { from, fromColumn, to, toColumn } });
  },
  'sql-schema-to-note': (dispatcher) => {
    const state = dispatcher.getState();
    if (state.sqlPage.running) return;
    // 🔑 **編集中は断って理由を出す**(`sql-to-note` と同じ ── 黙って捨てない)
    // ⚠ 字は `blockedActionNote` の 1 か所から(C11b / #1045)── 手書きの
    //   「編集中は書き出せません(…終えてから押してください)」は `error` の相
    //   (保存に失敗して止まった)でも同じ字を出していた(#516 と同じ形)。
    if (state.phase !== 'ready') {
      dispatcher.dispatch({
        type: 'SQL_SAVE_FAILED',
        error: blockedActionNote(state.phase) ?? '',
      });
      return;
    }
    dispatcher.dispatch({
      type: 'SQL_SCHEMA_TO_NOTE',
      lid: generateLid(),
      relationId: generateLid(),
    });
  },
  /**
   * 🔴 **前に打った字を一覧から選ぶ**(#918 段②a。user 裁定 2026-09-14
   *   「履歴ボタンを 1 つ足す」)。
   *
   * ⚠ 指で触る端末には `↑` `↓` が**無い** ── ここが唯一の入口である。
   * ⚠ 2 度目の押しは**閉じる**(片道の操作を作らない ── user 指示 2026-08-23)。
   * 🔑 器は右クリックの menu を使い回す ── 一覧を出す仕組みを 2 つ持たない(§7)。
   */
  'sql-history-menu': (dispatcher, target, _services, root) => {
    if (contextMenuOpen(root)) {
      closeContextMenu(root);
      return;
    }
    const { history } = dispatcher.getState().sqlPage;
    if (history.length === 0) return;
    const rect = target.getBoundingClientRect();
    openContextMenu(
      root,
      { x: rect.left, y: rect.bottom },
      history.map((sql, at) => ({
        action: 'sql-history-pick',
        /**
         * ⚠ **長い字は折り返さず切る** ── 1 件で画面を埋めると、
         *   「新しい順に並んでいる」という一覧の値打ちが消える。
         * ⚠ 改行は字にすると**行が伸びる**ので、`⏎` 1 文字へ畳む。
         */
        label: sqlMenuLabel(sql),
        attrs: { 'data-pkc-sql-history-at': String(at) },
      })),
      target,
    );
  },
  /**
   * 🔴 **答えを file へ書き出す**(#918 段④。user 要望 2026-09-14「`copy to` 使えないし」)。
   *
   * 🔑 押し所は 1 つ、形は一覧から ── 帯にボタンを 3 つ並べない。
   * ⚠ 2 度目の押しは**閉じる**(片道の操作を作らない ── user 指示 2026-08-23)。
   */
  'sql-export-menu': (dispatcher, target, _services, root) => {
    if (contextMenuOpen(root)) {
      closeContextMenu(root);
      return;
    }
    const p = dispatcher.getState().sqlPage;
    // ⚠ まだ答えが無い回は何もしない(押せる印は renderer 側が消しているが、鍵からも来うる)
    if (p.ranSql === '' || p.columns.length === 0) return;
    const rect = target.getBoundingClientRect();
    openContextMenu(
      root,
      { x: rect.left, y: rect.bottom },
      // 🔴 Parquet は DuckDB で引いた読む SQL の答えのときだけ並ぶ(`sqlExportChoices` の 1 本 ── #918 段⑥)
      sqlExportChoices(sqlEngineOf(p), p.ranSql).map((kind) => ({
        action: 'sql-export-pick',
        label: sqlExportLabel(kind),
        attrs: { 'data-pkc-sql-export': kind },
      })),
      target,
    );
  },
  'sql-export-pick': (dispatcher, target) => {
    const kind = asSqlExportChoice(target.getAttribute('data-pkc-sql-export'));
    // ⚠ 読めない印は黙って捨てる(器を作り直す前の押しが飛んでくる)
    if (kind === null) return;
    const p = dispatcher.getState().sqlPage;
    if (p.ranSql === '' || p.columns.length === 0) return;
    const name = sqlExportFileName(new Date(), p.guest?.name ?? null, kind);
    /**
     * 🔴 **Parquet は字ではなく DuckDB の器が書く**(#918 段⑥)── ここで file は作らず、依頼を出す。
     * ⚠ 終わりを言う(`SQL_SAVED` / `SQL_SAVE_FAILED`)のは effect 層 ── ここで言うと、まだ書けていないのに
     *   「書き出しました」と出る。
     */
    if (kind === 'parquet') {
      dispatcher.dispatch({ type: 'SQL_EXPORT_PARQUET', fileName: name });
      return;
    }
    /**
     * ⚠ **字は heap に長く置かない**(不可侵指示 2026-07-27)── 作ってすぐ `Blob` へ移し、
     *   `downloadBlob` が寿命の終端で `ObjectURL` を revoke する。
     */
    downloadBlob(
      name,
      new Blob([sqlExportFileText(p.columns, p.rows, kind)], { type: sqlExportMime(kind) }),
    );
    /**
     * 🔴 **書き出したことを画面で言う**(#681 段③ の 3 つ目と同じ理由)。
     * ⚠ この面は**別の窓**なので、落ちた file は窓の中に 1 ドットも出ない ──
     *   言わないと「押せなかった」に見える。
     */
    dispatcher.dispatch({ type: 'SQL_SAVED', title: name, kind: 'file', capped: countCappedCells(p.rows) });
  },
  'sql-history-pick': (dispatcher, target) => {
    const at = Number(target.getAttribute('data-pkc-sql-history-at') ?? '');
    // ⚠ 読めない印は黙って捨てる(器を作り直す前の押しが飛んでくる)
    if (!Number.isInteger(at)) return;
    dispatcher.dispatch({ type: 'SQL_HISTORY_PICK', at });
  },
  /**
   * 🔴 **答えの表のコピー 2 つ**(依頼 63-1)── ⧉(`table`)は表計算に貼る形、
   * 「本文に貼る形でコピー」(`embed`)は打った SQL の `sql embed` の囲み。
   * ⚠ 押しても画面が変わらないので、渡ったら光り、渡らなければ理由を出す(`finishCopy` = 他のコピーと同じ 1 本)。
   * ⚠ 読むのは `state.sqlPage`(答えの全部の行)── 画面の表は窓で描くので、DOM を読むと見えている行しか渡らない。
   */
  'sql-copy': (dispatcher, target) => {
    const p = dispatcher.getState().sqlPage;
    // ⚠ 答えが無い回は何もしない(押せない印は renderer 側が畳んでいるが、鍵からも来うる)
    if (p.ranSql === '' || p.columns.length === 0) return;
    const kind = target.getAttribute('data-pkc-copy-kind');
    if (kind === 'table') finishCopy(dispatcher, target, copyPlainText(sqlAnswerTsv(p.columns, p.rows)));
    else if (kind === 'embed') finishCopy(dispatcher, target, copyPlainText(sqlEmbedFence(p.ranSql)));
  },
  'sql-to-note': (dispatcher) => {
    const state = dispatcher.getState();
    const p = state.sqlPage;
    // ⚠ まだ答えが無い回は何もしない(押せる印は renderer 側が消しているが、鍵からも来うる)
    if (p.ranSql === '' || p.columns.length === 0) return;
    /**
     * 🔴 **編集中は作れないので、そう言う**(#681 の着地前レビュー F1)。
     *
     * ⚠ この面は aside なので**編集中でも開ける** ── ところが `CREATE_ENTRY` は
     *   `phase !== 'ready'` を**黙って捨てる**ので、直す前は押しても
     *   **画面が 1 ドットも動かなかった**(user には「壊れている」と
     *   「押せていない」の区別が付かない)。
     * 🔑 一覧の行を押したときと**同じ作法**にする ── 断って、理由を画面へ出す。
     * ⚠ 字は `blockedActionNote` の 1 か所から(C11b / #1045。理由は隣の
     *   `sql-schema-to-note` と同じ)。
     */
    if (state.phase !== 'ready') {
      dispatcher.dispatch({
        type: 'SQL_SAVE_FAILED',
        error: blockedActionNote(state.phase) ?? '',
      });
      return;
    }
    /**
     * 🔴 **どこを調べた答えかを、題名と本文の両方に残す**(#837 K3)。
     * ⚠ 画面では名札を出しているのに、**いちばん長く残るノート**から
     *   その情報だけが落ちていた ── 1 週間後に同じ SQL を走らせて断られる。
     */
    const where = p.guest?.name ?? null;
    const title = sqlNoteTitle(new Date(), where);
    const lid = generateLid();
    dispatcher.dispatch({
      type: 'CREATE_ENTRY',
      archetype: 'text',
      lid,
      title,
      body: sqlNoteBody({
        sql: p.ranSql,
        columns: p.columns,
        rows: p.rows,
        truncated: p.truncated,
        where,
        // 🔴 切ってある升の数(`sqlNoteBody` が末尾で言う)
        capped: countCappedCells(p.rows),
      }),
      parentLid: null,
      relationId: generateLid(),
      edit: false,
    });
    /**
     * ⚠ **作れた回だけ言う** ── 作れないのに「書き出しました」と出すと嘘になる。
     * ⚠ ここまで来て作れないのは lid の衝突だけ(上で phase は見た)なので、
     *   理由を出す(黙って戻らない)。
     */
    if (!dispatcher.getState().entryMetas.has(lid)) {
      dispatcher.dispatch({
        type: 'SQL_SAVE_FAILED',
        error: '書き出せませんでした(もう一度押してください)',
      });
      return;
    }
    dispatcher.dispatch({ type: 'SQL_SAVED', title, kind: 'note', capped: countCappedCells(p.rows) });
  },
  /**
   * 🔴 **開く場所**(#826)。⚠ `set-prose-align` と同じ受け方(`<select>` でもボタンでも通す)。
   */
  'set-open-place': (_dispatcher, target, services) => {
    const place =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-open-place-value');
    if (place) services.setOpenPlace?.(place);
  },
  /**
   * 🔴 **アプリの開き方**(#884 段①)。⚠ `set-open-place` と同じ受け方
   *   (`<select>` でもボタンでも通す)── 同じことをする 2 つの口で作法を分けない。
   */
  'set-app-open-target': (_dispatcher, target, services) => {
    const value =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-app-open-target-value');
    if (value) services.setAppOpenTarget?.(value);
  },
  /**
   * 🔴 **グループの見出しを押して畳む / 開く**(#857 段④)。
   * ⚠ 名前が空なら何もしない ── 名前の無い群は見出しを持たないので、
   *   畳むと**開く口が画面から消える**(片道の操作を作らない)。
   */
  'toggle-app-group': (_dispatcher, target, services) => {
    const group = target.getAttribute('data-pkc-group') ?? '';
    if (group !== '') services.toggleAppGroup?.(group);
  },
  /**
   * 🔴 **すべて畳む / すべて開く**(#857 段④)。
   *
   * 🔑 **名前は画面から採る** ── 畳む口(`toggle-app-group`)を持っている見出しが、
   *   そのまま「いま畳める群」の一覧である。数え直す口を 2 つ目に作らない
   *   (CLAUDE.md §7「同じ問いに答える口が 2 つあると、片方だけ壊れる」)。
   * ⚠ **面へスコープする** ── 一覧(`launcher-list`)の中だけを見る。document 全体を
   *   走ると、別の面に同じ名前の押し所が生えた日に静かに巻き込む(§1)。
   */
  /**
   * 🔴 **グループの目印を選ぶ**(#857 段②)。
   *
   * ⚠ 押した所から要るのは**群の名前だけ** ── どのノートに書くかは reducer が
   *   探す(在れば使い、無ければ作る)。ここで探すと、探す口が 2 つになる(§7)。
   * 🔑 **`newLid` は呼び側が採る**(reducer は純関数 ── 乱数を持たない)。
   *   ⚠ 使われないこともある(既に在るとき / 「なし」を押して作らないとき)が、
   *   採るだけなら副作用は無い。
   */
  'pick-app-group-icon': (dispatcher, target, services) => {
    const name = target.getAttribute('data-pkc-group') ?? '';
    if (name === '') return;
    /**
     * ⚠ **いま付いている絵を渡す** ── `appGroupIcons` は state が持っている
     *   (描画と同じ物を見るので、画面と小窓が食い違わない)。
     * ⚠ 絵文字を直に貼った群は `symbol` を持たない ── そのときは空で渡す
     *   (表の中に該当が無いので、「なし」に枠が付く)。
     */
    const now = appGroupIconName(dispatcher.getState(), name);
    void services.pickAppGroupIcon?.(name, now).then((picked) => {
      // ⚠ `null` = やめた(何もしない)/ `''` = 「なし」(外す)── 混ぜない
      if (picked === null) return;
      dispatcher.dispatch({
        type: 'SET_APP_GROUP_ICON',
        name,
        icon: picked === '' ? null : picked,
        newLid: generateLid(),
      });
    });
  },
  /**
   * 🔴 **グループを 1 つ上へ / 下へ**(#857 段③)。
   *
   * ⚠ **最初の 1 回だけ聞く** ── 番号は「動かした先より上に在る群」全部に要るので、
   *   グループ用のノートが**まとめて増える**ことがある(最大で群の数 − 1 枚)。
   *   黙って増やすと、数日後にサイドバーで見覚えのない題名を見つけることになる。
   * 🔑 2 回目からは何も出ない(もう番号が付いているので、増えるノートが 0 枚になる)。
   * ⚠ `newLids` は**書く群の数だけ**採る(足りないと reducer が何も書かない)。
   */
  'move-app-group-up': (dispatcher, target, services) => moveAppGroup(dispatcher, target, services, -1),
  'move-app-group-down': (dispatcher, target, services) => moveAppGroup(dispatcher, target, services, 1),
  /**
   * 🔴 **並べ替えをやめて名前順へ戻す**(#857 段③)。
   * ⚠ 押し所は**番号が在るときだけ**出る(`appGroupMenuActions`)ので、ここへ来た
   *   時点で 1 つ以上在る ── ⚠ それでも reducer 側でも見る(押し所の出し分けは
   *   **見せ方**であって、門ではない)。
   */
  'reset-app-group-order': (dispatcher, _target, services) => {
    const count = appGroupOrderCount(dispatcher.getState());
    // ⚠ 押し所は番号が在るときだけ出るが、門は両側に置く(出し分けは**見せ方**である)
    if (count === 0) return;
    const go = (): void => {
      dispatcher.dispatch({ type: 'RESET_APP_GROUP_ORDER' });
    };
    if (services.confirmResetAppGroupOrder === undefined) {
      go();
      return;
    }
    void services.confirmResetAppGroupOrder(count).then((ok) => {
      if (ok) go();
    });
  },
  'toggle-all-app-groups': (_dispatcher, target, services) => {
    const list = target.closest('[data-pkc-field="launcher-list"]');
    if (!list) return;
    const groups = [...list.querySelectorAll('[data-pkc-action="toggle-app-group"]')].map(
      (el) => el.getAttribute('data-pkc-group') ?? '',
    );
    /**
     * ⚠ ここで**間引かない** ── 空の名前も 0 件も、判定は
     *   `toggleAllFolded` 1 か所が持つ(`features/launcher/group-fold.ts`)。
     * 🔑 ここに同じ `if` を書くと、**守っているつもりの死んだ枝**が増える
     *   (畳む口は名前の付いた群にしか出ないので、ここの間引きは一度も効かない)。
     */
    services.toggleAllAppGroups?.(groups);
  },
  'set-editor-mode': (_dispatcher, target, services) => {
    // ⚠ `set-theme` と同じ受け方(`<select>` でもボタンでも通す)
    const mode =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-editor-mode-value');
    if (mode) services.setEditorMode?.(mode);
  },
  /**
   * 🔴 **文字の大きさ**(#504)。⚠ `set-theme` / `set-editor-mode` と**同じ受け方**
   *   (`<select>` でもボタンでも通す)── 3 本目の作法を作らない。
   * 🔑 当てるのは `documentElement`(`applyPageFormat` と同じ先)。
   */
  'set-text-scale': (_dispatcher, target) => {
    const v =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-text-scale-value');
    if (v !== null && isTextScale(v)) chooseTextScale(document.documentElement, v);
  },
  /**
   * 🔴 **本文の段組み**(#505 段①)。⚠ 当てる先は `text-scale` と同じ
   *   `document.documentElement` ── CSS が `:root[...]` で読む。
   */
  'set-read-columns': (_dispatcher, target, services) => {
    const v =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-read-columns-value');
    if (v !== null && isReadColumns(v)) {
      chooseReadColumns(document.documentElement, v);
      // 🔴 効いたことを言う(#1650 項目 3)── 設定の画面が中央を占めていて本文は隠れたまま
      services.showStatus?.(`本文の段組みを「${plainChoiceLabel(readColumnsSpec(v).label)}」にしました`);
    }
  },
  /**
   * 🔴 **段の境界線の濃さ**(#525)。⚠ 既定は現行そのままなので、
   * 選ばない user の見え方は 1 バイトも変わらない。
   */
  'set-column-rule': (_dispatcher, target) => {
    const v =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-column-rule-value');
    if (v !== null && isColumnRule(v)) chooseColumnRule(document.documentElement, v);
  },
  /**
   * 🔴 **本文の中のタグの見せ方**(#550 段③)。⚠ user が「バッジ化して表示が必要」と
   * 言っているので既定は札だが、**その場で「文字のまま」へ戻せる** ── 決めるのは user
   * (user 指示 2026-08-28「正直変更はユーザーに委ねて欲しい」)。
   */
  /**
   * 🔴 **絞り込みを外す**(#536 ②)。⚠ 行き止まりに説明を貼るのではなく、
   * **その場で進める道**を出すための受け手である(CLAUDE.md「片道の操作を作らない」)。
   * 🔑 撃つのは既存の `SET_ENTRY_FILTER` ── 絞りの正本は 1 つのままにする(§7)。
   */
  'clear-entry-filter': (dispatcher) => {
    /**
     * 🔴 **絞りは 2 種類ある**(2026-08-29)── 語(`filterQuery`)と種類の札
     *   (`kindFilter`)。⚠ 語だけ空にすると、**種類で 0 件になっている user が
     *   押しても何も起きない**(この口を出す条件は「どちらかが在る」なので、
     *   片方だけ消すと dead click を作る)。
     * ⚠ 種類が空のときに `CLEAR_KIND_FILTER` を撃っても reducer が同じ state を返すので、
     *   余計な描画にはならない。
     */
    dispatcher.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
    dispatcher.dispatch({ type: 'CLEAR_KIND_FILTER' });
  },
  /**
   * 🔴 **タグに色を付ける**(#1457)── 色を選ぶ窓は付箋・線と同じ 1 つ(`openColorPicker`)。
   * ⚠ ノートの本文は書かない(色は器のデータ)ので、編集中でも通す。
   * ⚠ 色が未設定のタグの初めの色は、灰色に見える「わざと 1 ずらした値」(窓は値が変わらないと
   *   `change` を撃たないので、本物の灰色にすると、その 1 色だけ選べない)。
   */
  'tag-color-pick': (_dispatcher, target, services) => {
    const tag = target.getAttribute('data-pkc-tag') ?? '';
    if (tag === '') return;
    openColorPicker(target, currentTagColor(tag) ?? TAG_COLOR_SEED, (to) =>
      services.setTagColor?.(tag, to),
    );
  },
  'tag-color-clear': (_dispatcher, target, services) => {
    const tag = target.getAttribute('data-pkc-tag') ?? '';
    if (tag !== '') services.setTagColor?.(tag, null);
  },
  'set-tag-badge': (_dispatcher, target) => {
    const v =
      target instanceof HTMLSelectElement
        ? target.value
        : target.getAttribute('data-pkc-tag-badge-value');
    if (v !== null && isTagBadge(v)) chooseTagBadge(document.documentElement, v);
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
  'restore-draft': (_dispatcher, _target, services) => {
    services.restoreDraft?.();
  },
  'discard-draft': (_dispatcher, _target, services) => {
    services.discardDraft?.();
  },
  /**
   * 「開く」で編集に入るかの設定(user 裁定 2026-08-18)。
   * ⚠ `set-notices-enabled` と同じ作法 ── checkbox の `checked` をそのまま渡す。
   */
  'set-open-in-edit': (_dispatcher, target, services) => {
    if (target instanceof HTMLInputElement) services.setOpenInEdit?.(target.checked);
  },
  /**
   * 🔴 **`.ics` に入れるアラームの時間**(#855 20-C)。⚠ 選べる値以外は `setLead` が既定へ丸める。
   * 保存は端末の好み(`schedule-notify.ts`)── state は動かさない。
   */
  'set-schedule-lead': (_dispatcher, target) => {
    if (target instanceof HTMLSelectElement) appScheduleNotify.setLead(Number(target.value));
  },
  /**
   * 🔴 **予定表の週の始まり**(#1163 の依頼 191)。⚠ 選べる値以外は `normalizeWeekStart` が既定(日曜)へ倒す。
   * 保存は端末の好み(`schedule-week-start.ts`)。描き直しは店が知らせる(状態は動かさない)。
   */
  'set-schedule-week-start': (_dispatcher, target) => {
    if (target instanceof HTMLSelectElement)
      appScheduleWeekStart.set(normalizeWeekStart(target.value));
  },
  /** 🔴 **次に開いたとき、見逃した予定を知らせるか**(#855 20-C)。⚠ 押した後の値を保存する。 */
  'set-schedule-missed': (_dispatcher, target) => {
    if (target instanceof HTMLInputElement) appScheduleNotify.setMissedOn(target.checked);
  },
  /**
   * 🔴 **見逃した予定の知らせから、予定表へ移る**(#855 20-C)。⚠ 開いたら片付ける(`open-alarm` と同じ ──
   * 開いたのに残っていると「押しても消えない」と読まれる)。移る口は左のタブの切替 1 本(`setBrowse`)。
   */
  'open-missed-schedule': (_dispatcher, _target, services, root) => {
    services.setBrowse?.('schedule');
    dismissMissedLine(root);
  },
  /** 🔴 **「見逃した予定」の知らせを閉じる**(#855 20-C)。本文にも予定にも触れない。 */
  'dismiss-missed': (_dispatcher, _target, _services, root) => {
    dismissMissedLine(root);
  },
  'set-alarm-enabled': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setAlarmEnabled?.(target.checked);
  },
  'set-voice-boost': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setVoiceBoost?.(target.checked);
  },
  'set-voice-level': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setVoiceLevel?.(target.checked);
  },
  'set-voice-crossfeed': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setVoiceCrossfeed?.(target.checked);
  },
  'set-phone-links': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setPhoneLinks?.(target.checked);
  },
  'set-date-links': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setDateLinks?.(target.checked);
  },
  'set-relative-days': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setRelativeDays?.(target.checked);
  },
  'set-color-swatch': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setColorSwatch?.(target.checked);
  },
  'set-missing-links': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setMissingLinks?.(target.checked);
  },
  'set-code-collapse': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setCodeCollapse?.(target.checked);
  },
  'set-inline-code-copy': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setInlineCodeCopy?.(target.checked);
  },
  'set-pdf-reader': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setPdfReader?.(target.checked);
  },
  'set-notices-enabled': (_dispatcher, target, services) => {
    // ⚠ checkbox の**押した後**の値を渡す(binder は state を持たない)
    if (target instanceof HTMLInputElement) services.setNoticesEnabled?.(target.checked);
  },
  'set-too-narrow-enabled': (_dispatcher, target, services) => {
    // ⚠ `set-notices-enabled` と同じ作法 ── checkbox の `checked` をそのまま渡す
    if (target instanceof HTMLInputElement) services.setTooNarrowEnabled?.(target.checked);
  },
  'next-announce': (_dispatcher, _target, services) => {
    services.nextAnnounce?.();
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
  'export-markdown-folder': (_dispatcher, _target, services) => {
    services.exportMarkdownFolder?.();
  },
  'export-portable': (_dispatcher, _target, services) => {
    services.exportPortable?.();
  },
  'export-entry-pdf': (dispatcher, target, services) => {
    // 🔴 解決規則は `rowLidOrSelected` の 1 本(#877)── 隣の 2 つと揃える
    //   (片方だけ `selectedLid` 固定だと「A を刷って B を消す」が成立する)
    const lid = rowLidOrSelected(dispatcher.getState(), target);
    if (lid) services.printNote?.(lid);
  },
  'export-entry-docx': (dispatcher, target, services) => {
    // 🔴 解決規則は `export-entry` と**同じ**(#877。隣に並ぶボタンなので、
    //   片方だけ `selectedLid` 固定だと「A を Word にして B を消す」が成立する)
    const lid = rowLidOrSelected(dispatcher.getState(), target);
    if (lid) services.exportEntryDocx?.(lid);
  },
  'export-entry-pptx': (dispatcher, target, services) => {
    // 🔴 解決規則は隣の 3 つ(`export-entry` / `-docx` / `-pdf`)と**同じ**(#877)
    const lid = rowLidOrSelected(dispatcher.getState(), target);
    if (lid) services.exportEntryPptx?.(lid);
  },
  'export-entry': (dispatcher, target, services) => {
    // 🔴 解決規則は `delete-entry` と**同じ**(review M-3 / #877)── 隣に並べる
    // ボタンなので、片方だけ `selectedLid` 固定だと filer / sidebar の行に
    // 並べた瞬間に「A を書き出して B を削除する」が成立する
    const lid = rowLidOrSelected(dispatcher.getState(), target);
    if (lid) services.exportEntry?.(lid);
  },
  /**
   * 🔴 **予定から外す**(#498。user 指摘 2026-08-27
   * 「**予定表に出てくる消せない予定がキモい / 動線が直感的ではない**」)。
   *
   * ⚠ 直す前、外す道は「**掴んで『日付なし』へ落とす**」だけだった ──
   *   発見できないうえ、**繰り返しは掴むと断られる**ので外せなかった。
   *
   * 🔑 **書込は落とす経路と同じ 1 本**(§7)── ここで別の書き方をしない:
   *   - 行の予定 … `SET_TASK_DATE`(`date: null` = 記法ごと剥がす)
   *   - ノート 1 件の予定 … `SET_ENTRY_DATE`(frontmatter の `date:` を消す)
   *
   * ⚠ **単位は札の属性から読む** ── `data-pkc-whole-note` が在れば後者である
   *   (`patchTaskCard` が焼いている)。⚠ 行番号は**札ではなく中の印**に在る
   *   (札にも置くと `[data-pkc-task-line]` を押す既存の経路に当たる、2026-08-23 の罠)。
   */
  'unschedule-task': (dispatcher, target, services, root) => {
    const st = dispatcher.getState();
    const card = target.closest<HTMLElement>('[data-pkc-entry]');
    const lid = card?.getAttribute('data-pkc-entry') ?? '';
    if (card === null || lid === '') return;
    // 🔴 別のタブ・窓が編集中のノートへは撃たない(#1087。`toggle-task` と同じ門。押した瞬間の値は捕えてある)
    const failed =
      '予定を外せませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください';
    if (card.hasAttribute('data-pkc-whole-note')) {
      actUnlessEditedElsewhere(dispatcher, services, [lid], failed, () => {
        const now = dispatcher.getState();
        const was = now.entryMetas.get(lid)?.date ?? null;
        const refused = bodyWriteBlockReason(now, lid) !== null;
        dispatcher.dispatch({ type: 'SET_ENTRY_DATE', lid, date: null });
        // 🔴 × にも「元に戻す」(#1632。Gemini 裁定 = #1163 の依頼 35 Q2-A)── 日付なしへ落としたときと同じ口。
        //    ⚠ 断られた回(編集中など)・元から日付が無い回は出さない(`offerMoveUndo` が同じ姿は出さない)
        if (!refused && now.entryMetas.has(lid))
          offerMoveUndo(root, dispatcher, {
            target: { kind: 'entry', lid },
            before: { date: was, time: null, timeEnd: null, until: null, text: '' },
            after: { date: null, time: null, timeEnd: null, until: null, text: '' },
            verb: 'moved',
          });
      });
      return;
    }
    const raw = card
      .querySelector('[data-pkc-task-line]')
      ?.getAttribute('data-pkc-task-line');
    const line = Number(raw);
    // ⚠ 読めなければ**何もしない**(当てずっぽうで別の行を書き換えない)
    if (raw === null || raw === undefined || !Number.isInteger(line)) return;
    // 🔴 札が焼かれた時点の行の中身を添える(#1087)。引けなければ撃たずに断る
    const openLine = shownCardLine(st, lid, line);
    if (openLine === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: SHOWN_LINE_LOST });
      return;
    }
    /**
     * ⚠ **`until` も外す** ── 記法まるごと消えるので、期間だけ残すと
     *   「頼んでいない指示」になる(落とす経路と同じ渡し方)。
     */
    actUnlessEditedElsewhere(dispatcher, services, [lid], failed, () => {
      const now = dispatcher.getState();
      const refused = bodyWriteBlockReason(now, lid) !== null;
      const scanned = now.taskScan?.cards.find((c) => c.lid === lid && c.line === line);
      dispatcher.dispatch({ type: 'SET_TASK_DATE', lid, line, openLine, date: null, until: null });
      /**
       * 🔴 × にも「元に戻す」(#1632。Gemini 裁定 = #1163 の依頼 35 Q2-A)。毎週の予定を間違えて外すと
       * 規則ごと消えるので、戻す口が無いのは片道だった。日付なしへ落としたときと同じ口を使う。
       * ⚠ 断られた回(編集中など)・札が走査に居ない回は出さない。
       * ⚠ 繰り返しの札の日は「その回の日」なので、戻し先は**規則の行を読んだ姿**(開始日・刻み)にする。
       */
      if (refused || scanned === undefined) return;
      const before = slotOfCard(scanned);
      const rule = scanned.repeat === null ? null : readLineDate(openLine);
      offerMoveUndo(root, dispatcher, {
        target: { kind: 'task', lid, line },
        before,
        after: { date: null, time: null, timeEnd: null, until: null, text: before.text },
        verb: 'moved',
        ...(rule === null || scanned.repeat === null
          ? {}
          : {
              restore: {
                date: rule.date,
                time: rule.time,
                timeEnd: rule.timeEnd,
                until: rule.until,
                repeat: scanned.repeat,
              },
            }),
      });
    });
  },
  /**
   * 🔴 **札の「繰り返す…」を押した ── 刻みの一覧を出す**(#855 段 0 の 3 つ目。
   * user 裁定 2026-09-13「札を右クリック →『繰り返す』」)。
   *
   * ⚠ **2 段にする** ── 刻み 4 つ + やめるを行のメニューへ直に並べると、
   *   ノートの操作(削除 / 書き出す …)に毎回 5 行が割り込む。
   * ⚠ **`MENU_OPENERS` に載せてある** ── 載せないと、同じ 1 回のクリックで
   *   ここが開き `onCloseMenu` が閉じるので、**押しても何も出ない**
   *   (`phone-menu` が踏んだのと同じ罠)。
   * 🔑 身元は**押したボタン自身**から読む ── メニューの器は root の直下に出るので、
   *   `closest` では札まで辿れない(`context-menu.ts` の戒め)。
   */
  /**
   * 🔴 **帯に入りきらず畳んだ操作を、名前つきで出す**(#1621。「⋯」)。
   * 🔑 長押しのメニューと**同じ口・同じ項目の組み方**(`barTileMenuItems`)── 畳んだ物だけを渡す。
   * ⚠ 畳んだ物は DOM に残っている(見た目だけ隠す)ので、項目の字・図案・受け手の属性は
   *   そのまま読める。
   */
  'open-bar-more': (_dispatcher, target, _services, root) => {
    const bar = target.closest('[data-pkc-region]');
    if (bar === null) return;
    const items = barTileMenuItems(bar, `button[${OVERFLOW_ATTR}]`);
    if (items.length === 0) return;
    const r = target.getBoundingClientRect();
    openContextMenu(root, { x: r.left, y: r.bottom }, items, target);
  },
  /**
   * 🔴 **予定の札の「⋯」から、右クリックと同じメニューを開く**(台帳 #1852 束 S1、依頼 128-2 A)。
   * 🔑 メニューの組み立ては `contextmenu` の受け手(`onContextMenu`)**1 本**に任せる ── 札の上で右クリックしたときと
   *   同じ項目・同じ「先に選んでから出す」門を通る(項目の一覧を 2 か所に書かない。§7)。
   *   ⚠ 合成した `contextmenu` は、スマホの長押しのメニュー抑止(`suppressTouchTaskMenu`)を通さない印を立てて送る。
   */
  'open-task-menu': (_dispatcher, target) => {
    const card = target.closest<HTMLElement>('article[data-pkc-entry]');
    if (card === null) return;
    const r = target.getBoundingClientRect();
    taskMenuFromButton = true;
    try {
      card.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom }),
      );
    } finally {
      taskMenuFromButton = false;
    }
  },
  'open-repeat-menu': (_dispatcher, target, _services, root) => {
    const lid = target.getAttribute('data-pkc-entry') ?? '';
    const raw = target.getAttribute('data-pkc-task-line');
    const line = Number(raw);
    if (lid === '' || raw === null || !Number.isInteger(line)) return;
    const cur = target.getAttribute('data-pkc-task-repeat');
    const r = target.getBoundingClientRect();
    openContextMenu(
      root,
      // ⚠ **押した項目の真下**に出す(右クリックの座標はもう持っていない)
      { x: r.left, y: r.bottom },
      repeatMenuActions(isRepeatUnit(cur) ? cur : null),
      root.ownerDocument.activeElement,
      // 🔑 どの行かは**全項目**に要る(`carry` はそのための仕組み)
      { 'data-pkc-entry': lid, 'data-pkc-task-line': raw },
    );
  },
  /**
   * 🔴 **刻みを付け替える**(#855 段 0 の 3 つ目)。
   * ⚠ **日付は渡さない** ── 渡すと、繰り返しの回の札では**開始日がその回の日へ
   *   ずれる**(札に焼いてあるのは回の日である)。判断は reducer と
   *   `rewriteLineDate` が持つ。
   * ⚠ 知らない綴りなら**何もしない**(当てずっぽうで本文を書き換えない)。
   */
  'set-task-repeat': (dispatcher, target, services) => {
    const lid = target.getAttribute('data-pkc-entry') ?? '';
    const raw = target.getAttribute('data-pkc-task-line');
    const line = Number(raw);
    if (lid === '' || raw === null || !Number.isInteger(line)) return;
    const key = target.getAttribute(REPEAT_ATTR);
    if (key === null) return;
    // ⚠ 空文字は「やめる」── 属性に `null` は書けないので、こちらで戻す
    if (key !== '' && !isRepeatUnit(key)) return;
    // 🔴 札が焼かれた時点の行の中身を添える(#1087)。引けなければ撃たずに断る
    const openLine = shownCardLine(dispatcher.getState(), lid, line);
    if (openLine === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: SHOWN_LINE_LOST });
      return;
    }
    // 🔴 別のタブ・窓が編集中のノートへは撃たない(#1087。`toggle-task` と同じ門)
    actUnlessEditedElsewhere(
      dispatcher,
      services,
      [lid],
      '繰り返しを変えられませんでした(別のタブの編集を確かめられませんでした)。もう一度押してください',
      () =>
        dispatcher.dispatch({
          type: 'SET_TASK_REPEAT',
          lid,
          line,
          openLine,
          repeat: key === '' ? null : key,
        }),
    );
  },
  'export-entry-html': (dispatcher, target, services) => {
    // 🔴 解決規則は隣の `export-entry` / `delete-entry` と**同じ**(#877)── 揃えないと
    //    「A を書き出して B を削除する」が成立する(review M-3 と同じ形)
    const lid = rowLidOrSelected(dispatcher.getState(), target);
    if (lid) services.exportEntryHtml?.(lid);
  },
  'export-entry-markdown': (dispatcher, target, services) => {
    // 🔴 解決規則は隣の `export-entry-html` と**同じ**(#877)── 揃えないと「A を書き出して B を削除する」が成立する
    const lid = rowLidOrSelected(dispatcher.getState(), target);
    if (lid) services.exportEntryMarkdown?.(lid);
  },
  /**
   * 🔴 **このノートを別の窓で開く**(#685 段②)。
   * ⚠ 解決規則は隣の `export-entry` / `delete-entry` と**同じ**(#877)── 揃えないと
   *   「A を書き出して B を開く」が成立する。
   * ⚠ **同期に呼ぶ**(`window.open` は gesture の中でしか通らない)。
   */
  'open-note-window': (dispatcher, target, services) => {
    const lid = rowLidOrSelected(dispatcher.getState(), target);
    if (lid === null) {
      // 🔑 無言で終わらせない(押した人に理由が要る)
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '別のウィンドウで開くノートがありません(先にノートを開いてください)',
      });
      return;
    }
    // 🔴 消えたノートの行(探す面に残った行など)は開かない ── 無い lid の窓を開かない
    if (!dispatcher.getState().entryMetas.has(lid)) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'そのノートは見つかりません' });
      return;
    }
    // 🔴 **「探す」の行は、探した語を運ぶ**(#1102 段①)── 受け側が当たった所へ送って塗る。
    //   ⚠ 語を持たない口(一覧の ⋯ など)は今までどおり `undefined`
    const find = target.getAttribute(FIND_ATTR);
    /**
     * 🔴 **スマホでは何が起きるかを 1 行で言う**(#1659 ②、Gemini 裁定 = 案 C)。⚠ スマホには小さな窓が無く、
     *   押すと PKC3 全体が別のタブで開く ── 言わないと「ノートが開く」と読まれる。
     * ⚠ **開く前に撃つ** ── `window.open` は gesture の中でしか通らず、その前に挟めるのは同期の dispatch だけ。
     *   塞がれたときの案内は開く側が後から出すので、この 1 行はそれに上書きされる(正しい向き)。
     */
    if (appPhone.isPhone()) dispatcher.dispatch({ type: 'OP_NOTICE', message: PHONE_NOTE_WINDOW_NOTICE });
    // 🔑 語を持たない口は、左の列の欄の語を運ぶ(依頼 70-C2)── 「探す」の行の語が先
    services.openNoteWindow?.(
      lid,
      find === null || find === ''
        ? leftFilterFind(dispatcher.getState().filterQuery)
        : find,
    );
    /**
     * 🔴 **読んでいたノートへ戻す**(#685 動線レビュー 欠陥 2)。
     * ⚠ **開いた後に撃つ** ── `window.open` は gesture の中でしか通らないので、
     *   その前に別の仕事を挟まない。
     * ⚠ 編集中の `SELECT_ENTRY` は reducer が落とす ── 下書きは巻き込まない。
     */
    const prev = target.getAttribute(MENU_PREV_LID_ATTR);
    if (prev !== null && prev !== '' && prev !== lid) {
      dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: prev });
    }
  },
  'export-folder': (dispatcher, target, services) => {
    // 🔴 解決規則は隣の `export-entry` / `delete-entry` と**同じ**(#877)── 揃えないと
    //    「A を書き出して B を削除する」が成立する(review M-3 と同じ形)
    const lid = rowLidOrSelected(dispatcher.getState(), target);
    if (lid) services.exportFolder?.(lid);
  },
  'purge-orphan-assets': (_dispatcher, _target, services) => {
    services.purgeOrphanAssets?.();
  },
  'import-file': (dispatcher, target) => {
    /**
     * 🔴 **選ばせる前に断る**(#535 ③)。
     *
     * ⚠ 直す前は picker を開き、user が file を選び終わった**後で**
     *   `importVcfFiles` / `importMarkdownFiles` が「編集を保存するか、編集をやめてから」と断っていた
     *   ── **選ぶ手間が丸ごと無駄**になる。これは #513 で右ペインの日付ピッカーに
     *   ついて直したのと**同じ形**である(そちらは「開く → 選ぶ → 確定」を完走させて
     *   から捨てていた)。
     * 🔑 重い手順(ピッカー・ダイアログ)を始めさせる口では、**始める前に**見る ──
     *   reducer / 実行部の門は残す(そちらは別経路からの到達を守っている)。
     *
     * 🔴 **章の欄が開いている間も同じく断る**(#1044 段2 2巡目の修理、R2)。
     * ⚠ 章の欄は `phase` を `ready` のまま保つ(設計 doc §3)ので、上の phase
     *   検査だけでは通ってしまう ── `reloadSnapshot` 側は待つだけに直したので
     *   データは壊れないが、**選んで終わるまで画面に何も反映されない**のは
     *   「選ばせる前に断る」の主旨(選ぶ手間を無駄にしない)に反する。
     * 🔑 文言は手で書かない ── `SECTION_DRAFT_NOTE`(章の欄の断り文はここ 1 か所。
     *   `refusal-words.test.ts` C11b が手書きの前置きを禁じているのと同じ理由)。
     */
    const st = dispatcher.getState();
    if (st.sectionDraft !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: SECTION_DRAFT_NOTE });
      return;
    }
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}取り込んでください` });
      return;
    }
    target
      .closest('[data-pkc-region="shell"]')
      ?.querySelector<HTMLInputElement>('[data-pkc-field="import-input"]')
      ?.click();
  },
  // ── P5b: 履歴 / ゴミ箱 ──
  'show-history': (dispatcher, target) => {
    // 🔴 **無言で断らない**(P8 段⑲)── `SHOW_HISTORY` は `phase !== 'ready'` で
    //    何も返さず、押しても panel も理由も出なかった
    const phase = dispatcher.getState().phase;
    if (phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `${phaseBlockReason(phase)}履歴を開いてください`,
      });
      return;
    }
    /**
     * 🔴 **効く先はここで解決する**(#891)── 隣の 15 件と同じ `rowLidOrSelected`。
     * ⚠ 直す前はここが `target` を**1 つも受け取っておらず**、reducer が
     *   `selectedLid` を直に読んでいた ── 行のメニューを開いたまま `Alt+←` を
     *   押すと、**A の履歴を見るはずが B の履歴が開く**(#877 と同じ引き金で、
     *   行のメニュー 16 件のうちここだけが残っていた)。
     */
    const lid = rowLidOrSelected(dispatcher.getState(), target);
    if (lid === null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'ノートを選んでから開いてください' });
      return;
    }
    dispatcher.dispatch({ type: 'SHOW_HISTORY', lid });
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
      dispatcher.dispatch({ type: 'OP_FAILED', error: 'このタブの PKC3 が古いままのため、送れません。再読み込みしてください' });
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
            error: `「${where}」へ送れませんでした(送り先のウィンドウが閉じているかもしれません)`,
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
  /**
   * 🔴 **くらべる相手を選ぶ**(#1231 段①)。⚠ **読むだけ**(`BODY_WRITE_ACTIONS` に載せない)。
   * 版を相手にするときの読みは reducer の event(`REQUEST_REVISION_BODY`)が運ぶ。
   * PC のファイルだけは **handle が state に居ない**ので、ここで `services.readLinkedFile` を呼ぶ。
   * ⚠ 返りは**選んだ時の版・相手と照らされる**(reducer の `REVISION_COMPARE_LOADED`)── 遅れて着いても上書きしない。
   */
  'set-revision-compare': (dispatcher, target, services) => {
    if (!(target instanceof HTMLSelectElement)) return;
    const value = target.value;
    dispatcher.dispatch({ type: 'SET_REVISION_COMPARE', value });
    const pv = dispatcher.getState().revisionPreview;
    if (value !== 'file' || pv === null || pv.compare.kind !== 'file' || pv.compare.load.state !== 'loading')
      return;
    const { lid, revId } = pv;
    const done = (r: string | LinkedFileTooLarge | null): void =>
      dispatcher.dispatch({
        type: 'REVISION_COMPARE_LOADED',
        lid,
        previewRevId: revId,
        against: 'file',
        text: typeof r === 'string' ? r : null,
        // 🔴 大きすぎて読まなかったときだけ理由を載せる(「ファイルを読めませんでした」と言い分ける)
        ...(r !== null && typeof r === 'object' ? { tooLarge: true as const } : {}),
      });
    const read = services.readLinkedFile;
    // ⚠ 読む口が無い環境では「読めませんでした」で終える(「読んでいます…」のまま止めない)
    if (read === undefined) {
      done(null);
      return;
    }
    void read(lid).then(done, () => done(null));
  },
  'restore-revision': (dispatcher, target, services) => {
    // 前進変異(復元前に現状が履歴に積まれる)なので confirm は要らない ──
    // 「復元の取り消し」も履歴から戻れる
    const revId = target.getAttribute('data-pkc-rev-id');
    /**
     * 🔴 **題名だけが変わった復元の「元に戻す」**(台帳 #1852 G1 / 依頼 229 B)。本文は同じで版が積まれていないので、
     * 版は戻さず、戻す前の題名へ向けた `RENAME_ENTRY_TITLE` を 1 手撃つ(`undo-rename` と同じ書込経路)。
     */
    const undoTitle = target.getAttribute('data-pkc-undo-title');
    if (undoTitle !== null) {
      const stU = dispatcher.getState();
      if (stU.phase !== 'ready') {
        dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(stU.phase)}戻してください` });
        return;
      }
      const lidU = stU.restoreUndo?.lid ?? stU.selectedLid;
      if (lidU === null || lidU === undefined || !stU.entryMetas.has(lidU)) return;
      restoreRenamedTitle(dispatcher, lidU, undoTitle, false);
      dispatcher.dispatch({ type: 'OP_NOTICE', message: `題名を「${undoTitle}」に戻しました` });
      return;
    }
    if (!revId) return;
    /**
     * 🔴 **編集中は声に出して断る**(#319)。⚠ 直す前は reducer の
     * `phase !== 'ready'` が**黙って捨てて**いたので、押しても 1 ドットも
     * 変わらず理由も出なかった ── P8 段⑲ で潰した「無言の操作拒否」。
     * 🔑 断り文は**この file の既存 8 か所と同じ型**へ流し込む
     *   (「文言は押した場所と対で pin する」── 面ごとに書き分けない)。
     */
    const phase = dispatcher.getState().phase;
    if (phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(phase)}復元してください` });
      return;
    }
    const restore = (): void => {
      dispatcher.dispatch({
        type: 'RESTORE_REVISION',
        revId,
        ...(target.getAttribute('data-pkc-undo') === '1' ? { fromUndo: true as const } : {}),
      });
    };
    /**
     * 🔴 **別のタブ・窓が編集中なら断る**(#1087。追記・チェックの切り替えと同じ門 = `editedElsewhereReason`)。
     * ⚠ 直す前は通していた ── 「前の版に戻しました」と出るのに、編集中のタブが保存するとそちらの字で上書きされ、
     *   こちらの画面は黙ってその版へ変わっていた(戻した版は履歴にだけ残る)。
     */
    const lid = dispatcher.getState().selectedLid;
    if (lid === null) {
      restore();
      return;
    }
    void editedElsewhereReason(dispatcher, services, lid).then((reason) => {
      if (reason !== null) {
        dispatcher.dispatch({ type: 'OP_FAILED', error: reason });
        return;
      }
      /**
       * 🔴 **確かめている間に別のノートへ移ったら戻さない**(#1087)。reducer は版を**いま選んでいるノート**へ
       *   当てるので、通すと別のノートの本文と題名が、押したノートの古い版で上書きされていた。
       */
      if (dispatcher.getState().selectedLid !== lid) {
        dispatcher.dispatch({ type: 'OP_FAILED', error: RESTORE_TARGET_MOVED_TEXT });
        return;
      }
      restore();
    });
  },
  'write-back-file': (dispatcher, target, services) => {
    // 🔴 解決規則は `rowLidOrSelected` の 1 本(#877)
    const lid = rowLidOrSelected(dispatcher.getState(), target);
    if (lid) services.writeBackFile?.(lid);
  },
  /**
   * 🔴 **パソコンのフォルダ**(#215 段①②)。⚠ 4 つとも**押された先を伝えるだけ**。
   * ⚠ 「フォルダを選ぶ…」は **user の操作の流れの中で**呼ぶ(OS の選択は gesture が要る ──
   *   `await` を挟まずに `pick()` へ渡す)。
   */
  'pc-pick-folder': (_dispatcher, _target, services) => void services.localFolder?.pick(),
  'pc-cut-folder': (_dispatcher, _target, services) => services.localFolder?.cut(),
  // 🔴 「更新」(#1264 §2 欠陥 4-a)── 同じ handle で一覧を読み直す。名前と種類だけ(`getFile()` は呼ばない)
  'pc-refresh-folder': (_dispatcher, _target, services) => void services.localFolder?.refresh(),
  'pc-more': (_dispatcher, _target, services) => void services.localFolder?.more(),
  // 🔴 フォルダの行は押しても中へ入らない ── 無言にせず理由を状態の行へ(場所は動かさない)
  'pc-dir-note': (dispatcher) => dispatcher.dispatch({ type: 'OP_NOTICE', message: PC_DIRECTORY_NOTE }),
  'pc-open-file': (_dispatcher, target, services) => {
    const raw = target.getAttribute('data-pkc-pc-index');
    const index = raw === null ? NaN : Number(raw);
    if (Number.isInteger(index)) void services.localFolder?.open(index);
  },
  /**
   * 🔴 **ゴミ箱を開くときは、左の列を「フォルダ」にしておく**(#1648)。ゴミ箱の一覧はフォルダの面の下に
   *   出るので、別のタブに居るまま `SHOW_TRASH` だけ撃つと開いても見えない。見つからないノートの知らせの隣の
   *   「ゴミ箱を開く」(`status-trash`)は別のタブから押される。⚠ 同じタブなら `setBrowse` は何も変えない。
   */
  'show-trash': (dispatcher, _target, services) => {
      services.setBrowse?.('filer');
      dispatcher.dispatch({ type: 'SHOW_TRASH' });
    },
  /**
   * 🔴 **右の列 / 右クリックの「ゴミ箱を開く」**(#1646 の 1)。⚠ ゴミ箱の口はフォルダの一覧にしか無いので、
   *   先に左の列を「フォルダ」へ移してから開く(`show-trash` は一覧に居るときの口 ── 別の受け手)。
   *   `SHOW_TRASH` は読むだけで編集中でも通る(下書きに触れない)。
   */
  'open-trash': (dispatcher, _target, services) => {
    services.setBrowse?.('filer');
    dispatcher.dispatch({ type: 'SHOW_TRASH' });
  },
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
  /**
   * 🔴 **ノートの小窓の「× 閉じる」**(#1659 ③)。門は Esc と**同じ**(`noteWindowHasTyping` / 編集中は閉じない)
   * ── 片方にだけ門が在ると、押し方で打ちかけが消える。閉じ方は `close-pane` と同じ `services.closeNoteWindow`。
   */
  'close-note-window': (dispatcher, _target, services, root) => {
    const st = dispatcher.getState();
    if (services.isNoteWindow?.() !== true) return;
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}閉じてください` });
      return;
    }
    if (noteWindowHasTyping(root, st)) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: '打ちかけの字が残っています。足すか消してから閉じてください' });
      return;
    }
    const closed = services.closeNoteWindow?.() ?? 'not-a-window';
    if (closed === 'refused') dispatcher.dispatch({ type: 'OP_FAILED', error: CLOSE_NOTE_WINDOW_REFUSED });
  },
  'restore-trash': (dispatcher, target) => {
    const revId = target.getAttribute('data-pkc-rev-id');
    const entryLid = target.getAttribute('data-pkc-trash-lid');
    if (!revId || !entryLid) return;
    // 🔴 **編集中は声に出して断る**(#319。理由は `restore-revision` と同じ)
    const phase = dispatcher.getState().phase;
    if (phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(phase)}戻してください` });
      return;
    }
    dispatcher.dispatch({ type: 'RESTORE_TRASH', entryLid, revId });
  },
  'purge-trash': (dispatcher, target, _services, root) => {
    /**
     * ⚠ **一括・不可逆**(revision の物理削除)── 受けボタンの字も**何が起きるか**に
     *   する。⚠ 直す前は `whenAbsent: false` で「確認が無い環境では通さない」と
     *   倒していたが、**その状態そのものが無くなった**(器はいつでも作れる)。
     */
    // 🔴 編集中は、確認を出す前に断る(確認に「はい」と答えてから断られる形をやめる)
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}空にしてください` });
      return;
    }
    /**
     * 🔴 **行の「完全に消す」から来た回は、その 1 件だけ**(台帳 #1852 G2 / 依頼 301 A)。行は `data-pkc-trash-lid` を持つ ──
     * 持たない見出しの「ゴミ箱を空にする」は全部。確認は先に出す(戻せない)。
     */
    const onlyLid = target.getAttribute('data-pkc-trash-lid');
    if (onlyLid !== null) {
      const item = st.trashPanel?.items.find((t) => t.entryLid === onlyLid);
      confirmThen(
        root,
        `「${item?.title ?? '(無題)'}」を完全に消します(履歴も消え、元に戻せません)。よろしいですか?`,
        { okLabel: '完全に消す', danger: true },
        dispatcher,
        notWhileEditing(dispatcher, '消してください'),
        () => dispatcher.dispatch({ type: 'PURGE_TRASH', lid: onlyLid }),
      );
      return;
    }
    const n = st.trashPanel?.items.length ?? null;
    confirmThen(
      root,
      n === null || n === 0
        ? 'ゴミ箱を空にします(捨てたノートの履歴も消え、元に戻せません)。よろしいですか?'
        : `ゴミ箱の ${n} 件を空にします(それぞれの履歴も消え、元に戻せません)。よろしいですか?`,
      { okLabel: 'ゴミ箱を空にする', danger: true },
      dispatcher,
      notWhileEditing(dispatcher, '空にしてください'),
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
 * 🔴 **本文の塊を運ぶ**(#684 段①)。⚠ `PKC_DRAG` とは別の型 ── あちらは「ノートを
 *   フォルダへ移す」、こちらは「**同じノートの中で行を並べ替える**」。混ぜると、塊を
 *   フォルダの行へ落としたときにノートを移そうとする(予定の札と同じ理由)。
 * 荷物は `lid start end`(生の body の行番号)。掴んだ行そのものは reducer が画面の本文から
 * 捕える(`MOVE_PLACE` の開き行と同じ ── 呼び側に本文を持たせない)。
 */
const PKC_BLOCK_DRAG = 'application/x-pkc-block';
/**
 * 本文の塊の落とし先の印(#684)── 塊の**上辺 / 下辺**に線を出す(`app.css`)。
 * ⚠ `data-pkc-dropping`(枠を光らせる)とは別 ── 塊全体が光ると「中へ入る」に見える。
 */
const DROP_EDGE_ATTR = 'data-pkc-drop-edge';
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
/**
 * 🔴 **アプリのタイルを運ぶ**(#857 段①)。
 *
 * ⚠ **`PKC_DRAG` を流用しない** ── あちらは「ノートをフォルダへ移す」で、
 *   フォルダの行・パンくず・本文・2 ペインの地が**全部受ける**。タイルを
 *   そこへ落としたときに**ノートが移る**(予定の札・本文の塊と同じ理由で別の型)。
 * 荷物は `lid` 1 つ。行き先(群と、どのタイルの手前か)は**落とした座標**から決める。
 */
const PKC_TILE_DRAG = 'application/x-pkc-tile';

/**
 * 🔴 **鍵 → ボタン**の橋。⚠ **export しているのは、畳んだときの不変条件を
 * 1 か所で検めるため**(#582 §6)。
 *
 * 🔑 守る主張は「**畳んでも、押せる口が DOM から消えない**」である ──
 * いまそれが成り立っているのは **CSS で列を落として DOM に残す**実装のおかげで、
 * ⚠ 「畳んだペインを unmount する」最適化が入ると**静かに全部死ぬ**
 * (鍵を押しても無反応になり、しかも**どの test も鳴らない**)。
 * だから `tests/adapter/pane-visibility.test.ts` が**開いた状態と畳んだ状態で
 * 同じ数だけ解決すること**を見る。
 */
export const SHORTCUT_BUTTON: Readonly<Record<string, string>> = {
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
  // 🔴 並べ替えも押しボタンをそのまま押す(#1163 依頼 153)。⚠ 帯(`order-nudge`)に限る ── 行や⋯メニューの同名ボタンは押した行の lid を持つ
  'move-order-up': '[data-pkc-field="order-nudge"] [data-pkc-action="move-order-up"]',
  'move-order-down': '[data-pkc-field="order-nudge"] [data-pkc-action="move-order-down"]',
  'open-recent': '[data-pkc-action="open-recent"]',
  'create-entry': '[data-pkc-field="create-run"]',
  'edit-entry': '[data-pkc-action="start-edit"]',
  'toggle-replace': '[data-pkc-action="toggle-replace"]',
  // ⚠ 近道は**ボタンをそのまま押す** ── 帯が無い(閲覧中の)面では何も起きない
  'insert-date': '[data-pkc-action="insert-date"]',
  'insert-entry-link': '[data-pkc-action="insert-entry-link"]',
  'insert-snippet': '[data-pkc-action="insert-snippet"]',
  'toggle-sidebar': '[data-pkc-action="toggle-pane"][data-pkc-pane="sidebar"]',
  'toggle-inspector': '[data-pkc-action="toggle-pane"][data-pkc-pane="inspector"]',
  // 🔴 追記欄も同じ形で押す(#609)── 3 面で押し方を変えない
  'toggle-append': '[data-pkc-action="toggle-pane"][data-pkc-pane="append"]',
  'view-query': '[data-pkc-action="set-view"][data-pkc-view="query"]',
  /**
   * 🔴 **開いているノートを別のウィンドウで開く**(#690 I5)── 「操作を探す」と
   *   近道の両方の受け手。⚠ **情報ペインのボタンに限る** ── 右クリック / ⋯ の
   *   同名ボタンは押した行の lid を持つので、document 順で先に当たると
   *   **選んでいる物と違うノート**が開く。
   * ⚠ ノートを選んでいない間は情報ペインに帯が無い(`shape === 'empty'`)ので、
   *   「操作を探す」は「いまこの操作のボタンが画面に出ていません」と正しく言う。
   */
  'open-note-window': '[data-pkc-field="inspector-actions"] [data-pkc-action="open-note-window"]',
  // 🔴 外から開けるリンク(2026-10-11)── 情報ペインのボタンに限る(`open-note-window` と同じ理由)
  'copy-entry-link': '[data-pkc-field="inspector-actions"] [data-pkc-action="copy-entry-link"]',
  'open-settings': '[data-pkc-action="set-view"][data-pkc-view="settings"]',
  'open-flags': '[data-pkc-action="set-view"][data-pkc-view="flags"]',
  'open-help': '[data-pkc-action="set-view"][data-pkc-view="help"]',
  /**
   * 🔴 **別のウィンドウ・面を閉じる**(#1042 C3)── `center.ts` の「× 閉じる」を
   * そのまま撃つ。⚠ `close-pane` の文脈は `global` ではなく `window`(下の
   * `keymap.match(ke, 'window')` から呼ばれる)── `openPaletteFor` の
   * `rows()` は `contexts.includes('global')` を先に見て素通しするので、
   * ここに載っていても「操作を探す」には出ない(意図どおり)。
   */
  'close-pane': '[data-pkc-action="close-pane"]',
  /**
   * 🔴 **名前で呼べなかった「高」の操作 18 件**(#582 段③ 第 1 群。🟣 Gemini の回答 = #1163 の依頼 16)。
   *
   * 🔑 **命令 id = 押しボタンの `data-pkc-action`** ── 受け手は画面のボタンそのもの(押し方を増やさない)。
   *   「押せるか」もボタン次第:画面に無い間(別の面にいる / ノートを選んでいない)は押せず、理由は
   *   `keymap.ts` の `note` が言う。⚠ 全部、押した点から何も読まない(`ACTIONS` の受け手を読んで確かめた:
   *   読むのは `target` ならボタン自身の属性 / `root` から引く欄だけ)。
   * ⚠ `hidden` の中のボタンは「押せない」と読む(例外 2 件 = `PALETTE_HIDDEN_OK`)、
   *   先に欄へ字を入れる物は `PALETTE_FIELD_FIRST`(どちらも下)。
   */
  'add-relation': '[data-pkc-action="add-relation"]',
  'add-tag': '[data-pkc-action="add-tag"]',
  'append-entry': '[data-pkc-action="append-entry"]',
  'attach-file': '[data-pkc-action="attach-file"]',
  'clear-entry-date': '[data-pkc-action="clear-entry-date"]',
  'open-today': '[data-pkc-action="open-today"]',
  'refresh-query': '[data-pkc-action="refresh-query"]',
  'stack-save': '[data-pkc-action="stack-save"]',
  'copy-note-md': '[data-pkc-action="copy-note-md"]',
  'copy-note-rich': '[data-pkc-action="copy-note-rich"]',
  // ⚠ 「操作を探す」からの実行は `runGlobalCommand` が直に撃つ(どの画面からでも ── 台帳 #1852 束 L1)。この行は「受け手の押しボタン」の登記
  'export-messages': '[data-pkc-action="export-messages"]',
  'export-settings': '[data-pkc-action="export-settings"]',
  'schedule-quick-add': '[data-pkc-action="schedule-quick-add"]',
  'schedule-today': '[data-pkc-action="schedule-today"]',
  'export-schedule-ics': '[data-pkc-action="export-schedule-ics"]',
  'toggle-show-done': '[data-pkc-action="toggle-show-done"]',
  'toggle-show-archived': '[data-pkc-action="toggle-show-archived"]',
  'toggle-show-undated': '[data-pkc-action="toggle-show-undated"]',
  /**
   * 🔴 **名前で呼べなかった「高」の操作 第 2 群**(#582 段③。第 1 群と同じ作法 ── 命令 id = 押しボタンの
   *   `data-pkc-action`、受け手は画面のボタンそのもの)。⚠ 全部、押した点から何も読まない
   *   (`ACTIONS` の受け手を 1 件ずつ読んで確かめた:読むのは「ボタン自身の属性」か「`root` / 親から引く欄」だけ)。
   * ⚠ 見送った 3 件のうち `insert-diagram` / `insert-icon` は第 3 群(下)で足した。残りの `dual-delete` は
   *   `filer-trash`(鍵あり・2 ペインでも効く)が同じ実体を通している(`docs/development/operation-unregistered-2026-10.md`)。
   */
  'renumber-lists': '[data-pkc-action="renumber-lists"]',
  'sort-tasks': '[data-pkc-action="sort-tasks"]',
  'run-sql': '[data-pkc-action="run-sql"]',
  'sql-er-toggle': '[data-pkc-action="sql-er-toggle"]',
  'sql-schema-to-note': '[data-pkc-action="sql-schema-to-note"]',
  'sql-to-note': '[data-pkc-action="sql-to-note"]',
  'start-audio-capture': '[data-pkc-action="start-audio-capture"]',
  'start-screen-capture': '[data-pkc-action="start-screen-capture"]',
  'start-timer': '[data-pkc-action="start-timer"]',
  'clear-selection': '[data-pkc-action="clear-selection"]',
  'show-trash': '[data-pkc-action="show-trash"]',
  'hide-trash': '[data-pkc-action="hide-trash"]',
  'replace-all': '[data-pkc-action="replace-all"]',
  'search-jump-next': '[data-pkc-action="search-jump-next"]',
  'search-jump-prev': '[data-pkc-action="search-jump-prev"]',
  // ⚠ 2 ペインは**焦点の在る側**のタブ(左右に同じボタンが居る。順に当てると、いつも左になる)
  'dual-tab-add': '[data-pkc-region="dual-pane"][data-pkc-focused] [data-pkc-action="dual-tab-add"]',
  'clear-kind-filter': '[data-pkc-action="clear-kind-filter"]',
  'toggle-filer-flatten': '[data-pkc-action="toggle-filer-flatten"]',
  'db-check': '[data-pkc-action="db-check"]',
  'storage-profile': '[data-pkc-action="storage-profile"]',
  'contacts-quick-add': '[data-pkc-action="contacts-quick-add"]',
  'export-vcards': '[data-pkc-action="export-vcards"]',
  'add-url-tile': '[data-pkc-action="add-url-tile"]',
  'pc-pick-folder': '[data-pkc-action="pc-pick-folder"]',
  'hide-history': '[data-pkc-action="hide-history"]',
  /**
   * 🔴 **第 3 群:打っている場所に入れる 2 件**(#582 段③)。第 2 群では「一覧を閉じた直後に位置が先頭へ戻る」ので見送った。
   *   いまは `openPaletteFor` が開いたときの範囲を戻してから押す(`CARET_TOOLS` の物は全部)ので撃てる。
   *   ⚠ 受け手は画面のボタンそのもの(`insert-date` などと同じ)。選んだ範囲があれば図は囲み、無ければ種類を聞く(ボタンの作り)。
   */
  'insert-diagram': '[data-pkc-action="insert-diagram"]',
  'insert-icon': '[data-pkc-action="insert-icon"]',
  /**
   * 🔴 **録音・録画の最中と切り出し、検索の帯 7 件 第 4 群**(#582 段③。第 1〜3 群と同じ作法 ── 命令 id = 押しボタンの
   *   `data-pkc-action`、受け手は画面のボタンそのもの)。⚠ 切り出しの端は、受け手が**押したボタンと同じ行**の再生器から
   *   時刻を読む(`markTrim`)── ボタンは再生中の 1 行にしか居ないので、順に当てても別の行を指さない。
   * ⚠ 見送った 1 件:`discard-capture`(収録を残さずにやめる)は取り消せない。収録中の帯に常に出ているので、名前で呼ぶ意味も薄い。
   */
  'stop-capture': '[data-pkc-action="stop-capture"]',
  'capture-stop': '[data-pkc-action="capture-stop"]',
  'capture-trim-start': '[data-pkc-action="capture-trim-start"]',
  'capture-trim-end': '[data-pkc-action="capture-trim-end"]',
  'capture-trim-run': '[data-pkc-action="capture-trim-run"]',
  'capture-trim-clear': '[data-pkc-action="capture-trim-clear"]',
  'search-jump-end': '[data-pkc-action="search-jump-end"]',
};

/**
 * 🔴 **ボタンが `hidden` の中に居るなら「いまは効かない」と読む**(#582 段③)。例外は下の 2 つだけ。
 *
 * ⚠ 器は在る(描き直しで使い回す / 面は `hidden` で常駐する)が、**見えていない間は押しても意味が無い**:
 *   - 別の左のタブへ移った後の予定の面(**実ブラウザで測った**:タブを移しても予定の欄は DOM に残り、
 *     `hidden` の中で「押せます」と出ていた)
 *   - 日付が無ければ「日付を外す」/ 済み・片付け・日付なしが 0 件なら「出す・隠す」の切替は**行ごと隠してある**。
 *     隠れたまま `click()` すると**見えない切替が動く**
 * 🔑 判定は DOM の `hidden` 属性 1 つ(描く側が「出さない」を表す唯一の印)。
 * ⚠ 例外 = 添付 / 今日のノート:同じボタンを**閉じたメニューの中にも**持つ(`shell.ts`)ので、
 *   `hidden` の中の物が先に当たっても撃てる(メニューは開かなくてよい)。
 */
const PALETTE_HIDDEN_OK: ReadonlySet<string> = new Set(['attach-file', 'open-today']);

/**
 * 🔴 **先に欄へ字を入れる操作は、欄が空なら「欄へ移る」** (#582 段③)。
 *
 * ⚠ 押しボタンは**欄の中身を読んで**動く(タグ・つなぐ先・追記・予定の字)。名前で呼んだだけでは
 *   欄は空なので、ボタンをそのまま押すと「入力してください」と出るだけで**欄はどこにあるか分からない**。
 * 🔑 だから空のときだけ、欄を見える所へ出して焦点を入れる(字が入っていればボタンをそのまま押す ──
 *   ボタンと同じ action が走る)。欄は**ボタンと同じ親**の中に在る(`querySelector` の範囲を狭めて、
 *   別の面の同名の欄を拾わない)。
 */
const PALETTE_FIELD_FIRST: Readonly<
  Record<string, { readonly field: string; readonly pane: PaneId | null; readonly say: string }>
> = {
  'add-tag': { field: '[data-pkc-field="tag-add-input"]', pane: 'inspector', say: '足すタグをここに入れてから、「タグを足す」を押してください' },
  'add-relation': { field: '[data-pkc-field="relation-target"]', pane: 'inspector', say: 'つなぐ先の題名をここに入れてから、「つながりを足す」を押してください' },
  'append-entry': { field: '[data-pkc-field="append-input"]', pane: 'append', say: '追記する字をここに書いてから、「本文に追記する」を押してください' },
  'schedule-quick-add': { field: '[data-pkc-field="schedule-quick-text"]', pane: null, say: '予定の字をここに書いてから、「予定を足す」を押してください' },
  // 第 2 群(#582 段③)── 欄はボタンと同じ親の中に居る
  'replace-all': { field: '[data-pkc-field="replace-find"]', pane: null, say: '探す語をここに入れてから、「すべて置換」を押してください' },
  'contacts-quick-add': { field: '[data-pkc-field="contacts-quick-name"]', pane: null, say: '足す連絡先の名前をここに入れてから、「連絡先を足す」を押してください' },
  'add-url-tile': { field: '[data-pkc-field="launcher-add-url"]', pane: null, say: '足すリンクのアドレスをここに入れてから、「リンクを足す」を押してください' },
};

/** 整える 5 つ(#1233)。⚠ 命令 id(`keymap.ts`)→ 整え方(`text-tidy.ts`)。 */
const TIDY_COMMANDS: ReadonlyMap<string, TidyOp> = new Map<string, TidyOp>([
  ['tidy-join-lines', 'join-lines'],
  ['tidy-to-halfwidth', 'to-halfwidth'],
  ['tidy-kana-to-fullwidth', 'kana-to-fullwidth'],
  ['tidy-squeeze-blank-lines', 'squeeze-blank-lines'],
  ['tidy-strip-bullets', 'strip-bullets'],
]);

const FORMAT_OF: Readonly<Record<string, FormatOp>> = {
  'format-bold': 'bold',
  'format-italic': 'italic',
  'format-link': 'link',
  // 🔴 帯に出していない 4 つ(#425 段②-a)── 鍵だけが入口である
  'format-highlight': 'highlight',
  'format-ruby': 'ruby',
  'format-emdot': 'emdot',
  'format-strike': 'strike',
  /**
   * 🔴 **#950 段②**: 帯には既にボタンが在るが、「操作を探す」からは
   *   1 つも呼べなかった 3 つ ── 鍵は付けない(`defaults: []`。
   *   `tests/features/keymap.test.ts` の `KEYLESS`)。帯のボタンで
   *   マウスから完結できるので、鍵の枠は増やさない。
   */
  'format-table': 'table',
  'format-codeblock': 'codeblock',
  'format-math': 'math',
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
/**
 * 🔴 **記法ではないが、開いている本文の欄へ当てる命令**(#766 D-2、2026-09-08)。
 *
 * ⚠ 「操作を探す」の行は、これまで **①受け手のボタンを持つ**か
 *   **②記法(`FORMAT_OF`)** のどちらかだった ── その場で計算はどちらでもない。
 * 🔑 **判定の口は 1 つにする**(`editorCommand`)── 表を 2 つ持っても
 *   「この命令は本文の欄へ当てるか」に答える場所が 2 つになると、
 *   片方だけ直して「出るのに押せない」が静かに生まれる(CLAUDE.md §7)。
 */
const EDITOR_RUN: Readonly<Record<string, (ta: HTMLTextAreaElement, notify: (t: string) => void) => void>> = {
  /**
   * 🔴 **いまカーソルの在る行を計算して、行の終わりに答えを入れる**(#766 D-2)。
   * ⚠ 規則は打っているときと**同じ 1 か所**(`calcLineAction`)── 別の判定を作ると、
   *   `Enter` で計算できる式とパレットで計算できる式が食い違う。
   * ⚠ 挿すのは `insertText`(= `execCommand`)── `setRangeText` だと
   *   **取り消しの履歴が切れる**(#765 で実測した)。
   */
  'inline-calc': (ta, notify) => {
    const action = calcLineAction(ta.value, ta.selectionStart, rowTextAbove(ta));
    /**
     * 🔴 **頼まれて押したときは黙らない**(#1087)── 打っているとき(Enter)に式でない行で黙るのは正しいが、
     *   ここは user が「計算して」と明示した。何も起きないと、押したのに効かないボタンになる。
     */
    if (action === null) {
      notify('計算できませんでした(この行に計算できる式がありません)');
      return;
    }
    if (action.kind === 'why') {
      notify(action.text);
      return;
    }
    ta.setSelectionRange(action.at, action.at);
    insertText(ta, action.text);
  },
  /** 🔴 字下げ(#1166)── 当て方は `runIndent` 1 か所。何も変わらなければ静かに何もしない。 */
  indent: (ta) => {
    runIndent(ta, 1, true);
  },
  outdent: (ta) => {
    runIndent(ta, -1, true);
  },
  /**
   * 🔴 行を前後の行と入れ替える(#1213、`Alt+↑` / `Alt+↓`)── 当て方は `runSwap` 1 か所。
   * 端では何も書かない(キーは握る ── mac の `Option+↑↓`(段落の頭 / 末へ)を出さない)。
   * 🔴 ただし**黙らない**(#1254 §1)── 動かせなかった理由を 1 行で言う(`swapRefusedNote`)。
   */
  'move-line-up': (ta, notify) => {
    if (!runSwap(ta, -1)) notify(swapRefusedNote(ta));
  },
  'move-line-down': (ta, notify) => {
    if (!runSwap(ta, 1)) notify(swapRefusedNote(ta));
  },
  /**
   * 🔴 **カーソルの在る表の列幅を揃える**(#1171)。
   * ⚠ 書くのは `insertText`(取り消しの履歴を切らない ── #765)。表の行だけを
   *   選んで差し替え、**カーソルは同じ升へ戻す**(`alignMdTable` が位置を返す)。
   * ⚠ 1 面のライブ編集(`row-source`)は**押した 1 行だけ**が欄に入っていて表が
   *   見えないので、揃えずに行き先を言う(自動で全文編集へ切り替えない)。
   */
  'align-table': (ta, notify) => {
    if (ta.getAttribute('data-pkc-field') === 'row-source') {
      notify(ALIGN_TABLE_LIVE_NOTE);
      return;
    }
    const done = alignMdTable(ta.value, ta.selectionStart);
    if ('reason' in done) {
      notify(done.reason === 'outside' ? '表の外です' : 'もう揃っています');
      return;
    }
    ta.setSelectionRange(done.from, done.to);
    insertText(ta, done.insert);
    ta.setSelectionRange(done.caret, done.caret);
  },
  /**
   * 🔴 **選んだ字を整える 5 つ**(#1233)── 当て方は `runTidy` 1 か所(下の `TIDY_COMMANDS` が
   * 命令 id と整え方を 1:1 で持つ)。⚠ 5 本を手で並べ直さず、表から作る。
   */
  ...Object.fromEntries(
    [...TIDY_COMMANDS].map(([id, op]) => [
      id,
      (ta: HTMLTextAreaElement, notify: (t: string) => void) => runTidy(ta, op, notify),
    ]),
  ),
};

/**
 * 🔴 **選んだ字を整えて、欄へ当てる、唯一の口**(#1233)── 鍵・「操作を探す」が同じ関数を通る(§7)。
 *
 * ⚠ 書くのは **`insertText`(= `execCommand`)で置き換える範囲だけ** ── `ta.value =` で
 *   全文を代入すると**取り消しの履歴が切れる**(#765)。字下げ(`runIndent`)と同じ作法。
 * ⚠ 選んでいない / もう整っているときは**何も書かず**、理由を 1 行で言う(無言にしない)。
 */
function runTidy(ta: HTMLTextAreaElement, op: TidyOp, notify: (t: string) => void): void {
  const res = tidySelection(
    { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd },
    op,
  );
  if (res.kind === 'none') {
    notify(TIDY_NOTES[res.reason]);
    return;
  }
  const { edit } = res;
  ta.setSelectionRange(edit.from, edit.to);
  insertText(ta, edit.insert);
  ta.setSelectionRange(edit.start, edit.end);
}

/**
 * 🔴 **短縮語 + `Tab` の展開 / 次の `${…}` 印への移動**(#196 / B-2 段②)。2 列の本文の欄と、
 * 1 面の行の入力欄の**両方**がこの 1 本を通る(判定を 2 か所に書かない)。
 *
 * ⚠ **短縮語が先、印が後** ── 短縮語はカーソルのすぐ手前(いま打った字)、印は本文の先に在る。
 *   逆にすると、後ろに印が残るノートで短縮語を打った瞬間に、展開されずに遠くへ飛ぶ。
 * ⚠ 何も当たらなければ `false`(呼び側は既定を止めない ── 2 列は焦点移動、1 面の行は行の確定)。
 *
 * @returns 展開した / 印を選んだ = `true`
 */
function runSnippetTab(
  ta: HTMLTextAreaElement,
  items: readonly SnippetItem[],
): boolean {
  const collapsed = ta.selectionStart === ta.selectionEnd;
  const hit = collapsed ? abbrBeforeCaret(ta.value, ta.selectionStart, items) : null;
  if (hit !== null) {
    writeBack(
      ta,
      insertSnippet({ text: ta.value, start: hit.start, end: ta.selectionEnd }, hit.item.body, new Date()),
    );
    return true;
  }
  // ⚠ 次の印は**選択の終わりから**探す(いま選んでいる印をもう一度選ばない)
  const slot = nextSnippetSlot(ta.value, ta.selectionEnd);
  if (slot === null) return false;
  ta.setSelectionRange(slot.start, slot.end);
  return true;
}

/**
 * 🔴 **字下げを欄へ当てる、唯一の口**(#1166)── `Tab` の経路・鍵(`Ctrl+]` / `Ctrl+[`)・
 * 「操作を探す」の 3 つが同じ関数を通る(§7)。
 *
 * ⚠ 書くのは **`insertText`(= `execCommand`)で行の範囲だけ**を置き換える ──
 *   `ta.value =` で全文を代入すると**取り消しの履歴が切れる**(#765 で実測)。
 * @param explicit 鍵 / 操作を探す(普通の 1 行にも効く)。`Tab` は `false`
 * @returns 何か書いたら `true`。⚠ `false` なら**何も触っていない**(`Tab` は握らない)
 */
function runIndent(ta: HTMLTextAreaElement, dir: 1 | -1, explicit: boolean): boolean {
  const res = indentLines(
    { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd },
    dir,
    { explicit },
  );
  if (res === null) return false;
  ta.setSelectionRange(res.from, res.to);
  insertText(ta, res.insert);
  ta.setSelectionRange(res.start, res.end);
  return true;
}

/**
 * 🔴 **行の入れ替えを欄へ当てる、唯一の口**(#1213)── 鍵(`Alt+↑` / `Alt+↓`)・
 * 「操作を探す」の両方が同じ関数を通る(§7)。
 *
 * ⚠ 書くのは **`insertText`(= `execCommand`)で入れ替える行の範囲だけ**を置き換える ──
 *   `ta.value =` で全文を代入すると**取り消しの履歴が切れる**(#765)。字下げ(`runIndent`)と同じ作法。
 * @returns 何か書いたら `true`。`false` は端で動かせなかった(何も触っていない)
 */
function runSwap(ta: HTMLTextAreaElement, dir: 1 | -1): boolean {
  const res = swapLines({ text: ta.value, start: ta.selectionStart, end: ta.selectionEnd }, dir);
  if (res === null) return false;
  ta.setSelectionRange(res.from, res.to);
  insertText(ta, res.insert);
  ta.setSelectionRange(res.start, res.end);
  return true;
}

/**
 * 🔴 **行を動かせなかったときの 1 行**(#1254 §1。無言の止まりを無くす)。
 * ⚠ **押した場所で字を分ける** ── 1 画面編集の行の欄は 1 つの塊の原文だけが入っていて、
 *   端に居るのは「隣の塊が在る」場合でも起きる(欄の端 = 塊の端)。全文編集の端とは
 *   言うべき行き先が違う(前者は全文編集へ、後者はもう動かせない)。
 */
const SWAP_LIVE_NOTE = 'ここでは隣の行とは入れ替えません(「全文を編集」なら動かせます)';
const SWAP_EDGE_NOTE = 'これ以上は動かせません';

function swapRefusedNote(ta: HTMLTextAreaElement): string {
  return ta.getAttribute('data-pkc-field') === 'row-source' ? SWAP_LIVE_NOTE : SWAP_EDGE_NOTE;
}

/** 字下げの 2 命令(`keymap.ts` の id)。1 面の行の欄はこの 2 つだけ `EDITOR_RUN` を通す。 */
const INDENT_COMMANDS: ReadonlyMap<string, 1 | -1> = new Map([
  ['indent', 1],
  ['outdent', -1],
]);

/** 行の入れ替えの 2 命令(#1213)。字下げと同じく、1 面の行の欄はこの 2 つも `EDITOR_RUN` を通す。 */
const SWAP_COMMANDS: ReadonlySet<string> = new Set(['move-line-up', 'move-line-down']);

/** 🔑 画面のボタンの字(「全文を編集」)を引いて書く ── `detail.ts` の編集ボタンと同じ字。 */
const ALIGN_TABLE_LIVE_NOTE = '表の列幅を揃えるには、「全文を編集」に切り替えてください';
const RENUMBER_LIVE_NOTE = '番号を振り直すには、「全文を編集」に切り替えてください';
const SORT_TASKS_LIVE_NOTE = '完了項目を末尾へ移すには、「全文を編集」に切り替えてください';
/** 1 面のライブ編集の行の欄(押した 1 ブロックだけが入っている)か。 */
function isLiveBlockField(ta: HTMLTextAreaElement | null): boolean {
  // 🔴 本文の全部を開いている欄(「全文を編集」)は全文の欄 ── 本文全体の道具を当ててよい(台帳 #1852 I2)
  return ta !== null && ta.getAttribute('data-pkc-field') === 'row-source' && !ta.hasAttribute('data-pkc-row-whole');
}

/** 🔑 「この命令は本文の欄へ当てるか」に答える口は**ここ 1 つ**(§7)。 */
function editorCommand(cmd: string): boolean {
  return FORMAT_OF[cmd] !== undefined || EDITOR_RUN[cmd] !== undefined;
}

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
  /** 🔴 起きたことを画面の下の 1 行で言う口(#950 ③。「表」が 1 列になったとき)。 */
  say?: (text: string) => void,
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
    applyFormatSaying(
      {
        text: ta.value,
        start: range?.start ?? ta.selectionStart,
        end: range?.end ?? ta.selectionEnd,
      },
      op,
      say,
    ),
  );
  return true;
}

/**
 * 🔴 **記法を当てて、起きたことを言う**(#950 ③)。⚠ 書式の帯 / 鍵 / パレット / 雛形の一覧は
 *   **全部ここを通す**(口が 4 つあり、片方だけ言うと「ボタンでは出るのに鍵では無言」になる)。
 * 🔑 言うのは「区切りの無い文章を選んで**表**を押し、1 列の表になった」ときだけ。
 *   字は消えず表になるので、止めずに**知らせるだけ**にする。
 */
function applyFormatSaying(
  sel: TextSelection,
  op: FormatOp,
  say: ((text: string) => void) | undefined,
): TextSelection {
  if (op === 'table' && tableOpMadeSingleColumn(sel)) say?.(SINGLE_COLUMN_TABLE_NOTE);
  return applyFormat(sel, op);
}

/**
 * 🔴 **caret へ書き込む道具は、押しても焦点を奪わない**(user 報告 2026-08-28)。
 *
 * > 「**インライン編集モードで雛形などの挿入ボタンを押しても何もおこらない /
 * >  no-op 系動作か雛形のモーダルかなんかを描画しようとして
 * >  インライン編集位置からフォーカスが外れてしまっている?**」
 *
 * 🔑 **user の見立てが当たっていた。** live の 1 面では、`mousedown` の既定動作が
 * 入力欄の焦点を外す → `blur` が行の確定を走らせる → **`row-source` が DOM から消える**
 * → `click` の時点で `formatTarget` が書き込む先を見つけられず、**無言で return** する。
 * (`row-swap.ts` の `mousedown → blur(= 確定) → click` の注記と同じ順序である)
 *
 * ⚠ **2 列の面では起きない** ── `editor-body` は行と違って消えないので、焦点を
 *   失っても選択位置が残る。だから「2 列で試すと動く」= **面によって違う**形だった。
 *
 * 🔴 **漏れた理由は「1 つずつ足していた」こと。** `format-text` と `insert-date`
 *   (2026-08-23)は名指しで足されたが、**同じ形の `insert-entry-link` / `insert-snippet`
 *   / `renumber-lists` は足されていなかった** ── CLAUDE.md「片側を直したら、対称の
 *   反対側を必ず疑う」を踏んでいる。
 * 🔑 だから**名指しの `||` をやめて集合にし**、「`formatTarget` を呼ぶ handler は
 *   全部ここに居る」ことを `tests/adapter/caret-tools.test.ts` が**全数で**見る
 *   ── 次に道具を足した人が、黙って漏らせない形にした。
 */
export const CARET_TOOLS: ReadonlySet<string> = new Set([
  'format-text',
  'insert-date',
  'insert-entry-link',
  // ⚠ 2026-10-17(#1640 ④): 添付を入れる ── 同じく編集中の本文へ挿す
  'insert-attachment',
  'insert-snippet',
  // ⚠ 2026-09-04(#528 案 B): 図の一覧 ── 同じく編集中の本文へ挿す
  'insert-diagram',
  // ⚠ 2026-09-13(#853 段①): 図案の表 ── 同じく編集中の本文へ挿す
  'insert-icon',
  'renumber-lists',
  'sort-tasks',
]);

/**
 * 🔴 **「操作を探す」から呼ぶとき、開いたときの範囲を戻してから押す命令**(#582 段③ 第 3 群)。
 * 押した瞬間に欄の `selectionStart` を読んで、その位置へ入れる道具だけ。
 * ⚠ 全文の道具(`renumber-lists` / `sort-tasks`)は範囲を読まない ── 戻す必要が無く、欄が消えていても押す側が引き直すので、断らない。
 * ⚠ `format-text` は一覧に登記が無い(記法は `FORMAT_OF` の別の道)── 入れない。
 */
export const CARET_INSERT_TOOLS: ReadonlySet<string> = new Set(
  [...CARET_TOOLS].filter((id) => id !== 'renumber-lists' && id !== 'sort-tasks' && id !== 'format-text'),
);

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
  /**
   * 🔴 **外部リンクを初めて押したときの案内を、言ったか**(依頼 69-B2)。
   * ⚠ **test は自分で `new PopupHintStore(...)` して渡す**(`openInEdit` と同じ作法)。
   */
  popupHint: PopupHintStore = appPopupHint,
): () => void {
  // 🔑 押しボタンを持たない命令が services を引く口(#1452 案 1。`runGlobalCommand` の特例)
  ROOT_SERVICES.set(root, services);
  /**
   * 🔴 **予定の札を落として動かす書込の門**(#1087)── 落とす経路は下の `run()` を通らないので、
   *   書出し / 取込の実行中の断り(`refuseWhileBusy` と同じ字)と、別のタブの編集の断りをここで掛ける。
   */
  setScheduleWriteGate(dispatcher, (lids, failed, act) => {
    if (services.busy?.() === true) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '書き出し / 取り込みが実行中です。完了してから操作してください',
      });
      return;
    }
    actUnlessEditedElsewhere(dispatcher, services, lids, failed, act);
  });
  /**
   * 🔴 **画面へ 1 行出す口**(#522)。⚠ **エラーの欄ではない** ──
   * `main.ts` が優先順位(エラー > 一時の知らせ > 常設)を持っているので、
   * 成功の一報を `OP_FAILED` に載せない(載せると赤い意味の欄に出る)。
   * ⚠ 配線が無い環境(test)では黙る ── 押しても落ちない。
   */
  const tellUser = (text: string, opts?: StatusOptions): void =>
    // ⚠ 種類が無いときは字だけを渡す(呼び出しの形を変えない ── 受け口を偽物にした test が引数の組で見ている)
    opts === undefined ? services.showStatus?.(text) : services.showStatus?.(text, opts);
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
    if (refuseWithoutNote(action, dispatcher)) return;
    // 🔴 2 ペインの右クリックの一部の項目は、押したときにその行を選ぶ(`MENU_SELECT_FIRST_ATTR`)
    if (el.hasAttribute(MENU_SELECT_FIRST_ATTR)) {
      const lid = el.getAttribute(MENU_LID_ATTR) ?? '';
      if (lid === '' || !selectEntryOrExplain(dispatcher, lid, 'ノート', root, services)) return;
    }
    /**
     * 🔴 **押す前から**見せていたときだけ畳み直す(#655 ①)── `append-at-heading`
     *   自身が開いた回に、その直後のここで畳んでしまわない(開いた瞬間に消える)。
     */
    const peekedBefore = appPanes.isPeeking();
    handler(dispatcher, el, services, root);
    /**
     * ⚠ 右クリックの「ここに追記する」(`append-at-heading`)は**欄を使う操作**である
     *   (#724 ①)。メニューの項目は root 直下に居るので `refoldAppendAfterAction` の
     *   「欄の外の 1 操作」に数えられ、追記先を選び直した**その瞬間に欄が消えて**いた。
     */
    if (peekedBefore && action !== 'append-at-heading') refoldAppendAfterAction(root, el);
    if (DUAL_REBUILDS_CLICKED.has(action)) {
      const side = dualSide(el);
      if (side !== null) carryDualFocus(side);
    }
  };
  /**
   * 🔴 **長押しで印を足す**(#687 D-1)── 指だけの端末の Ctrl クリック。
   * ⚠ 判定と時計は `long-press.ts` が持ち、ここは**撃つ物**と**捨てる物**だけを
   *   決める:発火 = `DUAL_SELECT toggle`(Ctrl クリックと同じ action)、
   *   直後の `click` / `contextmenu` / 待っている間の `dragstart` は下の 3 か所で捨てる。
   * ⚠ 側と lid は**押した行から辿る**(`dualSide`)── 他の `dual-row` の経路と同じ。
   */
  const longPress = installLongPress(root, (row) => {
    /**
     * 🔴 **アプリのタイルの長押しは「並べ替えモード」**(#857 段①b-2。
     * user 裁定 2026-09-13「長押しで並べ替えモード」)。
     *
     * ⚠ **指だけの端末には入口が 1 つも無かった** ── 掴んで落とすのも
     *   右クリックの「上へ / 下へ」も、どちらもマウスが要る。
     * 🔑 掴んだ 1 枚に**印も付ける** ── どれを長押ししたのか画面に残らないと、
     *   「入ったこと」だけ分かって「何を動かすのか」が分からない。
     * ⚠ 断るときの理由は reducer が出す(絞り込み中 / 編集中)── ここでは
     *   受けるだけにして、**無言の dead press を作らない**。
     */
    /**
     * 🔴 **グループの見出しの長押しは「目印を選ぶ」メニュー**(#857 段②。
     * 着地前の動線レビュー)。
     *
     * ⚠ 右クリックにしか口が無いと、**指だけの端末には入口が 1 つも無い** ──
     *   すぐ下のタイルと同じ理由である。
     * 🔑 **右クリックと同じメニューを出す**(別の口を作らない)── 位置は
     *   見出しの外形から採る(長押しには座標が無い ── `open-repeat-menu` と同じ作法)。
     */
    if (row.getAttribute('data-pkc-action') === 'toggle-app-group') {
      const groupName = row.getAttribute('data-pkc-group') ?? '';
      if (groupName === '') return;
      const box = row.getBoundingClientRect();
      openContextMenu(
        root,
        { x: box.left, y: box.bottom },
        appGroupMenuActions(hasAppGroupOrder(dispatcher.getState())),
        row,
        { 'data-pkc-group': groupName },
      );
      return;
    }
    /**
     * 🔴 **3 つの帯(作る / ノート全体 / 2 ペインの操作)のタイルは、長押しで
     * その帯の全操作を名前つきで一覧する**(#1054 段②)。
     *
     * ⚠ **図案だけのタイル**なので、指だけの端末には名前を読む手段が無い
     *   (hover の `title` は指には出ない)。⚠ 位置は押した物の外形から採る
     *   (長押しには座標が無い ── `toggle-app-group` と同じ作法)。
     */
    if (row.hasAttribute(BAR_TILE_ATTR)) {
      const bar = row.closest('[data-pkc-region]');
      if (bar === null) return;
      const items = barTileMenuItems(bar);
      if (items.length === 0) return;
      const box = row.getBoundingClientRect();
      openContextMenu(root, { x: box.left, y: box.bottom }, items, row);
      return;
    }
    const tile = row.getAttribute('data-pkc-tile');
    if (tile !== null) {
      dispatcher.dispatch({ type: 'PICK_APP_TILE', lid: tile });
      dispatcher.dispatch({ type: 'SET_LAUNCHER_REORDER', on: true });
      return;
    }
    const side = dualSide(row);
    const lid = row.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
    if (side !== null && lid !== null)
      dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid, mode: 'toggle' });
  });
  const onClick = (ev: Event) => {
    /**
     * 🔴 **読んでいる本文を、押した所から扱う 2 つの道**(#395 段③ / #495)。
     *
     * > user の物語: 長い議事録を読んでいて、この 1 行だけ直したい。
     * > いまは「編集」を押してから、もう一度その行を探して押す(2 手)。
     *
     * 🔴 **早期 return より前に置く**(2 稿目。test が拾った)── 下の 1 行は
     *   `[data-pkc-action]` の中でなければ降りるが、**本文の段落は action を
     *   持たない**。後ろに置くと、この動線は**1 度も走らない**。
     * ⚠ **素のクリックの意味は変えない** ── PKC3 は browse-first(「開く = 閲覧」は
     *   2026-08-18 の裁定)。修飾キーを押しているときだけである。
     */
    const me2 = ev as MouseEvent;
    /**
     * 🔴 **予定表の「出すもの」は、枠の外を押したら閉じる**(#855。複数のチェックを続けて付けるあいだは開いたまま)。
     * ⚠ 閉じるのは**押した物がその枠の外**のときだけ ── 中(見出し・チェック・字・余白)と脇の 1 行は触らない。
     */
    for (const open of root.querySelectorAll<HTMLDetailsElement>(
      'details[data-pkc-field="schedule-fold"][open]',
    )) {
      const inside =
        open.contains(ev.target as Node | null) ||
        (ev.target as HTMLElement | null)?.closest?.('[data-pkc-field="schedule-fold-note"]') != null;
      if (!inside) open.open = false;
    }
    /**
     * 🔴 **Ctrl(⌘)は「その地点から編集」/ Alt は「追記先」**(#495。
     * user 裁定 2026-08-27)。
     *
     * > 「見出しを押したら編集とかは、**Ctrl+クリックで、その地点から編集**にすれば
     * > 良いと思う。**見出しにこだわる必要はない**」
     * > 「センターペインの**追記位置指定は Alt+クリック**にしましょう、さっき指定した
     * > **Ctrl+クリックをデフォのその場からの編集 IN 導線**に変更してください」
     *
     * ⚠ **Ctrl と ⌘ を畳む**のは `features/keymap.ts` の `Chord.mod` と**同じ規則**
     *   ── 分けると「mac だけ効かない近道」が必ず生まれる(正本の注記)。
     *   mac の `Ctrl+クリック` はブラウザが `contextmenu` にするので、
     *   そちらは `⌘` が受け持つ(この分岐へは来ない)。
     * ⚠ **`Ctrl+Alt` は AltGr** ── どちらの分岐も相手の修飾キーを**外す**
     *   (その組で奪うと、記号が打てない配列の人のクリックを壊す)。
     */
    const modOnly = (me2.ctrlKey || me2.metaKey) && !me2.altKey && !me2.shiftKey;
    const altOnly = me2.altKey && !me2.ctrlKey && !me2.metaKey && !me2.shiftKey;
    if (modOnly || altOnly) {
      const line = bodySourceLineAt(dispatcher, ev.target);
      if (line !== null) {
        ev.preventDefault();
        /*
         * 🔴 **編集に入る口は `startEditAt` の 1 本**(#426 段② の門)── 直に `START_EDIT` を
         *   撃つと、別のタブとの編集ロックも、飛んでいる書込を待つのも飛ばす。⚠ #495 で
         *   Ctrl+クリックを「その地点から編集」にしたとき、ここだけ直撃ちに戻っていた
         *   (#1044 の調査で判明)── 別のタブで編集中のノートにも入れ、チェックを押した
         *   直後だと押す前の本文が欄に出た(#288 と同じ形)。
         */
        if (modOnly) startEditAt(dispatcher, services, line);
        else pickAppendTarget(dispatcher, root, line);
        return;
      }
    }
    /**
     * 🔴 **名前を打ち替えている欄の中のクリックは、行の押下に流さない**(#215)。
     * ⚠ 欄は `select-entry` の行の中に在るので、流すと**2 回押し**に数えられて
     *   フォルダの行では**中へ入ってしまう**(打っている最中に面が変わる)。
     */
    if (ev.target instanceof HTMLInputElement && ev.target.matches('[data-pkc-field="row-rename"]'))
      return;
    /**
     * 🔴 **指で触る端末では、チェックリストの行の字も印を動かす**(#706 ①)。
     * ⚠ `[data-pkc-action]` の解決より**前**に置く ── 行の字は action を持たないので、
     *   後ろに置くと `!el` で捨てられる。判定は `touchTaskBoxAt` 1 か所。
     */
    const taskBox = touchTaskBoxAt(ev, root);
    if (taskBox !== null) {
      run('toggle-task', taskBox);
      return;
    }
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-pkc-action]',
    );
    /**
     * 🔴 **一覧の「何も無い所」を押したら、開いているノートを閉じる**(#1032)。
     *
     * ⚠ **戻る道が画面に 1 つも無かった** ── ノートを 1 件でも選ぶと、
     *   中央は**そのノート**になり、コレクションの操作(閲覧用 HTML / 持ち歩ける
     *   HTML 1 枚 / Markdown / 構成をコピー)へは**読み込み直す以外に戻れなかった**。
     *   「選択を解除」が外すのは**印**(まとめて操作する側)だけで、
     *   開いているノート(`selectedLid`)には触らない。
     * 🔑 **新しい字を 1 つも出さない直し** ── いま**何も起きない**場所
     *   (行と行の間・表の下の余白)が戻り道になる。
     *   ⚠ 「片道の操作を作らない」(founding ④)の直しであって、機能追加ではない。
     * ⚠ **押し所の上では何もしない** ── `[data-pkc-action]` を持つ物
     *   (行・ボタン・選択欄)に当たっていたら、下の本来の処理へ落とす。
     * 🔴 **見るのは「左の列の器」(`browse-host`)であって、表そのものではない**
     *   (2026-09-21、実ブラウザで実測して直した)。
     * ⚠ 1 稿目は行を持つ器(`filer-table` / `dual-table` / 「一覧」の `entry-list`)を
     *   見ていたが、**表は中身の高さしか無い** ── 実測で高さ **53px**(見出し + 1 行)、
     *   その下の **126px** は表の外だった。つまり user が「何も無い所」と思って押す
     *   場所は**ほとんど表の外**で、この直しは実ブラウザでは**ほぼ効かなかった**
     *   (unit は器へ直に click を撃てるので緑のままだった ── CLAUDE.md §2
     *   「経路が一度も通っていない」)。
     * 🔑 だから器は**左の列そのもの**にする ── タブが何であれ同じ場所である。
     * ⚠ 押し所の上では何もしない(上の `!el` の条件)ので、器の中に在る
     *   並べ替えの帯・移動の帯・タブは**そのまま効く**。
     */
    if (!el) {
      /**
       * 🔴 **「出すもの」の見出し・チェックの字・枠の余白・脇の 1 行は、「何も無い所」ではない**(#855)。
       * ⚠ 除かないと、押した瞬間に読んでいるノートが閉じる(これらは `data-pkc-action` を持たない:
       *   チェック本体だけが持つ)。
       */
      if (
        (ev.target as HTMLElement | null)?.closest(
          '[data-pkc-field="schedule-fold"],[data-pkc-field="schedule-fold-note"]',
        )
      )
        return;
      const host = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
        '[data-pkc-region="browse-host"]',
      );
      if (host !== null && host !== undefined && root.contains(host)) {
        const st0 = dispatcher.getState();
        if (st0.phase === 'ready' && st0.selectedLid !== null)
          dispatcher.dispatch({ type: 'DESELECT_ENTRY' });
      }
      return;
    }
    if (!root.contains(el)) return;
    /**
     * 🔴 **表の升の中のリンクは、リンクとして働く**(#708 段④、着地前レビュー・動線 ③)。
     *
     * ⚠ 升そのものが `edit-cell` の印を持つので、升の中の `<a>` を押すと
     *   **`closest` が升まで登って、リンクではなく入力欄が開く**。
     *   実害:表にリンクを並べるのは markdown の表のいちばん普通の使い方なのに、
     *   **そこだけリンクが死ぬ**(しかも開かない理由はどこにも出ない)。
     * 🔑 ノートへのリンク・添付・タグは `<a>` 自身が印を持つので `closest` が
     *   そちらを先に拾う ── 落ちていたのは**印を持たない `<a>`**
     *   (外部リンク / 同じノートの中の飛び先 / 脚注)だけである。
     * ⚠ 升を打ちたいときは、リンクでない所を押す(csv の升と同じ)。
     */
    if (el.getAttribute('data-pkc-action') === 'edit-cell') {
      const link = (ev.target as HTMLElement | null)?.closest<HTMLElement>('a[href]');
      if (link != null && el.contains(link)) return;
      /**
       * 🔴 **見出しの升は、1 回押しでは編集欄を開かない**(#1240)。
       *
       * ⚠ 見出しの 1 回押しは**並べ替え**(`table-sort.ts`)── 同じ押しで欄まで開くと、
       *   開いたばかりの欄が並べ替えで壊れる / 欄が開くのに並べ替えも走る。
       *   見出しは**2 回押し**(下の `onDblClick`)か升の右の ✎ から開く。
       * 🔑 判定は `opensOnSinglePress` 1 か所(升の種類で決める ── 受け手の順番に頼らない)。
       *   ✎ 自身は升ではない(`button`)ので、ここでは止まらない。
       *   ⚠ 鍵(Enter / Space)の受け口(`onKeydown`)も同じ関数を通る。
       */
      if (!opensOnSinglePress(el)) return;
    }
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
    // 🔴 予定の日付の欄: ブラウザ標準のピッカーは開かせず、近道つきの選び方だけを出す(#1635 項 2)
    if (el.getAttribute('data-pkc-action') === 'schedule-pick-date') ev.preventDefault();
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
     * 🔴 **フォルダ面の中だけ**(着地前レビュー 4)。`select-entry` は
     * 5 か所に在る(filer / kanban / calendar / query / inspector)ので、
     * 面で切らないと:
     * - kanban / calendar / query の `Ctrl` クリックが**画面に出ない印**を増やす
     *   (帯だけが数える)
     * - `Shift` の範囲は `filerRows` の並びで採るので、**目で見た並びと
     *   違う集合**になる(フォルダの面でなければ `[]` になり、
     *   `preventDefault` 済みなので**選択すら起きない**)
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
    /**
     * 🔴 **長押しの直後の `click` は捨てる**(#687 D-1)。
     * ⚠ 指を離すとブラウザは `click` を撃つ ── 下へ流すと `set` が走って
     *   **足したばかりの印が 1 件に戻り**、さらに `maybeDoubleOpen` が
     *   「1 回目」を数えて、次のタップでフォルダへ入る。**両方を素通りさせない**。
     */
    /**
     * ⚠ **タイルも同じ**(#857 段①b-2)── 長押しで並べ替えモードへ入った直後に
     *   `click` が流れると `open-tile` が「1 回目」を数え、指を離しただけで
     *   **次のタップが窓を開く**。受け口の名前を 2 つ数え上げて捨てる。
     */
    const pressedAction = el.getAttribute('data-pkc-action');
    if (
      (pressedAction === 'dual-row' ||
        pressedAction === 'open-tile' ||
        /**
         * ⚠ **見出しも捨てる**(#857 段②)── 足さないと、長押しでメニューが
         *   出たうえに、**指を離した瞬間にそのグループが畳まれる**
         *   (押した物と効く先が食い違う)。
         */
        pressedAction === 'toggle-app-group' ||
        /**
         * 🔴 **3 つの帯のタイルも捨てる**(#1054 段②)── 足さないと、長押しで
         *   メニューが出た直後に指を離した `click` がタイル自身の action を
         *   撃ち、**メニューを開いたのに本体まで実行される**(例: 添付の
         *   タイルを長押しすると、メニューが出たうえでファイル選択も開く)。
         *   ⚠ **action 名を数え上げない** ── 帯のタイルは全部この 1 属性で
         *   捨てられる(§7「同じ判定を 1 か所へ」の逆 = 判定を増やさない形)。
         */
        el.hasAttribute(BAR_TILE_ATTR) ||
        /**
         * 🔴 **開いたばかりのメニューの中も捨てる**(#1054 段②-2、F3a。
         *   実ブラウザの touch smoke で判明)。
         *
         * ⚠ **`ev.target` から辿る `el` は「押した物」ではない** ── 合成
         *   `click` の的は、指を置いた瞬間の要素ではなく **`click` を撃つ
         *   その瞬間に (x, y) に在る物**で決まる(実機の仕様。unit の
         *   手撃ち `dispatchEvent('click', …)` はこの的を再現しない)。
         *   長押しで開くメニューは**押した場所の真下**に出るので、指を離した
         *   合図がメニューの**先頭の項目**に**着地して、そのまま実行してしまう**
         *   ── 実測(#1054 段②-2): `dual-preview-toggle` を長押しすると
         *   メニューは正しく出るのに、直後の合成 `click` が同じ名前を持つ
         *   メニューの複製(`role="menuitem"`)を撃ち、`aria-pressed` が
         *   **メニューを閉じて選ぶ前に**反転していた。
         * 🔑 だから「押した物の名前」ではなく「**いま開いているメニューの中か**」
         *   で判定する ── 的が変わっても、消費窓の外にある**次の**タップ
         *   (新しい `pointerdown` が窓を閉じているので `swallowsClick()` が
         *   すでに偽)は素通りする ── 意図して押すメニュー項目は殺さない。
         */
        el.closest('[data-pkc-region="context-menu"]') !== null) &&
      longPress.swallowsClick()
    ) {
      ev.preventDefault();
      return;
    }
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
        // 🔴 編集中は reducer が黙って落とす(素のクリックは `selectEntryOrExplain` が理由を出す)── 同じく理由を出す
        const phaseNow = dispatcher.getState().phase;
        if (phaseNow !== 'ready') {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: `${phaseBlockReason(phaseNow)}フォルダの操作をしてください`,
          });
          return;
        }
        dispatcher.dispatch(
          me.shiftKey
            ? { type: 'SELECT_RANGE', lid }
            : { type: 'TOGGLE_SELECT', lid },
        );
        return;
      }
    }
    const action = el.getAttribute('data-pkc-action');
    // ⚠ 行を素で押したときだけ「もう一度押した」を数える(修飾つきは印の話)
    // ⚠ **フォルダ面の中だけ**(上と同じ理由 ── kanban / calendar / query /
    //    inspector の `select-entry` まで拾うと、見えていない判定が誤って走る)
    if (inFiler && action === 'select-entry') {
      const lid = el.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
      if (lid !== null) maybeDoubleOpen(lid);
    }
    // ⚠ 2 ペインも**同じ 2 クリック**でフォルダへ入る・ノートを別窓へ開く
    //   (規則は 1 本 ── ただし入る先はそのペインなので、撃つ action だけが違う)
    if (action === 'dual-row') {
      const side = dualSide(el);
      const lid = el.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
      if (side !== null && lid !== null) maybeDoubleOpen(lid, side);
    }
    run(action, el);
  };
  /**
   * ⚠ 書式パネルのボタンは **focus を奪わない**。奪うと押すたびに編集欄が
   * focus を失って画面がちらつく(選択位置自体は残るので壊れはしない)。
   */
  const onMousedown = (ev: Event) => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-action]');
    const act = el?.getAttribute('data-pkc-action');
    if (act !== null && act !== undefined && CARET_TOOLS.has(act)) ev.preventDefault();
    /**
     * 🔴 **「操作を探す」のボタンも焦点を奪わない**(#582 段③ 第 3 群の着地前レビュー)。奪うと、開いたときの焦点が本文の欄でなくなり、
     *   本文の欄に居るときだけ押せる記法・計算が灰色になる。押したあとの焦点は器が決める(閉じるとき、開いたときの欄へ返す)。
     */
    if (act === 'open-palette') ev.preventDefault();
  };
  const onInput = (ev: Event) => {
    if (isEditorBody(ev.target)) {
      /**
       * 🔴 **畳んだ設定の行を、打った字の前へ 1 byte も変えずに戻す**(#1220 穴②)。
       *
       * ⚠ 添付ノートの 2 列の編集欄は**説明だけ**を持つ(設定の行は欄の属性)。
       *   ここで繋がないと、state の本文が説明だけになり、**保存すると設定の行が消える**。
       * ⚠ 属性が無い欄(普通のノート)は今までどおり**欄の字そのまま**。
       */
      const head = ev.target.getAttribute(HIDDEN_HEAD_ATTR);
      dispatcher.dispatch({
        type: 'UPDATE_OPEN_BODY',
        body: head === null ? ev.target.value : joinHiddenHead(head, ev.target.value),
      });
      return;
    }
    const el = ev.target;
    // 🔴 置換の帯の「探す語」を打つたびに件数を出し直す(#1646 の 2)
    if (el instanceof HTMLInputElement && el.getAttribute('data-pkc-field') === 'replace-find') {
      paintReplaceCount(root, dispatcher);
      return;
    }
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
     * 🔴 **探す面の欄**(#680)。⚠ 左の列の欄(`entry-filter`)とは**別の語**へ写す ──
     *   面で打った語で本体の一覧が絞られると、別窓の面から本体が動いて驚く。
     * ⚠ 打鍵ごとに写す(state が正)。worker を叩くのは effect が 300ms 止まってから。
     */
    if (
      el instanceof HTMLInputElement &&
      el.getAttribute('data-pkc-field') === 'search-page-input'
    ) {
      dispatcher.dispatch({ type: 'SET_SEARCH_PAGE_QUERY', query: el.value });
      return;
    }
    /**
     * 🔴 **SQL の欄**(#681 段②)。⚠ **打つそばから state へ写す**(`change` を待たない)
     *   ── 面を切り替えて戻っても打ちかけが残るのは、これが state に在るからである。
     * 🔑 受け手は `ACTIONS` の 1 つ(`set-sql-text`)── ここで dispatch を書き直さない
     *   (§7 同じ判定を 2 か所に置かない)。
     * ⚠ ここは**許可リスト**である(`onChange` の注記と同じ)── `data-pkc-action` を
     *   付けただけでは `input` では呼ばれない。⚠ 外すと**無言の dead click** になる
     *   (打っても字が state に届かず、押しても空の SQL を走らせる)。
     */
    if (
      el instanceof HTMLTextAreaElement &&
      el.getAttribute('data-pkc-field') === 'sql-input'
    ) {
      run(el.getAttribute('data-pkc-action'), el);
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
    // 🔴 「大文字と小文字を区別」を切り替えたら件数を出し直す(#1646 の 2)
    if (el.getAttribute('data-pkc-field') === 'replace-case') {
      paintReplaceCount(root, dispatcher);
      return;
    }
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
     * 🔴 **探した語は、確定したときに憶える**(#1172)── Enter か、欄を離れたとき。
     * ⚠ 1 字ごとに撃たない(`input`)── 途中の「ほげ」「ほげほ」が全部候補に並ぶ。
     * ⚠ 2 字未満は `push` が積まない。⚠ 欄の絞り込み自体(`SET_ENTRY_FILTER`)は
     *   `input` が既に撃っているので、ここでは dispatch しない。
     */
    if (field === 'entry-filter') {
      appSearchHistory.push(el.value);
      paintSearchHistory(root);
      return;
    }
    /**
     * 🔴 **設定ファイルを選んだら、下見を出す**(#414)── ⚠ **当てない**。
     * ⚠ 読み込みは非同期なので、`change` の中で待つ(押し口は別に在る)。
     */
    if (field === 'settings-file-input') {
      const f = el.files?.[0] ?? null;
      // 🔴 **読む前に値を戻す**(#1087)── 適用の後でしか戻さないと、「読めない」と出た後に file を直して
      //   同じ名前で選び直しても `change` が発火せず、古い表示のままになる。File は掴んであるので戻してよい
      el.value = '';
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
      if (files.length === 0) return;
      /**
       * 🔴 **編集中に添付したら、打っていた所(カーソルの位置)に入れる**(#1163 依頼 55 の 3。Gemini の裁定 = 推薦どおり B)。
       *
       * ⚠ 直す前は「編集中なのでまだ入れていません。編集を終えると本文のいちばん下に入れます」と預かり、貼り付けた
       *   スクリーンショットだけがカーソルの位置に入った ── 同じ「編集中に入れる」で、入る場所が入れ方によって違った。
       * 🔑 入れ方は貼り付けと同じ道(`insertPasted`)── 資産に置いて、参照の行を打っていた所へ差す(Undo に載る)。
       *   ⚠ 編集中は添付のノートを作らない(`CREATE_ENTRY` が編集中は黙殺される ── 貼り付けと同じ事情)。
       *   画像は `![名前](asset:…)`、ほかの種類は `[名前](asset:…)` で入る。
       * ⚠ 編集中でないとき・編集欄が無いとき・差し込む口が無い環境は、今までどおり添付(`attachFiles`)。
       */
      const into = dispatcher.getState().phase === 'editing' ? formatTarget(root) : null;
      if (into !== null && services.pasteImages) insertPasted(files, into);
      else services.attachFiles?.(files);
    } else if (field === 'import-input') {
      // ⚠ 添付と同じく**全件**渡す ── md は複数選択できる(1 件ずつ entry に
      // なる)。PKC2 の書出しが複数来たときに断るのは import-file.ts の仕事で、
      // ここで 1 件目だけ拾って黙って落とさない
      const files = el.files ? [...el.files] : [];
      el.value = ''; // 同じファイルの再選択でも change が発火するように
      if (files.length > 0) services.importFiles?.(files);
    } else if (field === 'replace-input') {
      // 🔴 添付のファイルの差し替え(#1163 依頼 212)── 1 件だけ。同じファイルをもう一度選べるよう値は戻す
      const file = el.files?.[0] ?? null;
      const lid = el.getAttribute('data-pkc-replace-lid') ?? '';
      el.value = '';
      el.removeAttribute('data-pkc-replace-lid');
      if (file && lid !== '') services.replaceAttachmentFile?.(lid, file);
    } else if (field === 'office-pack-input') {
      // ⚠ **1 件だけ**(一式は zip 1 本)。複数選ばれても先頭で決める ──
      //    2 本目を黙って捨てるのではなく、そもそも 1 本しか意味を持たない
      const file = el.files?.[0] ?? null;
      el.value = ''; // 同じファイルの再選択でも change が発火するように
      if (file) services.installOfficePackFromFile?.(file);
    } else if (field === 'sql-file-input') {
      /**
       * 🔴 **SQL の相手として、手持ちのファイルを選んだ**(#854 段②)。
       * ⚠ **1 件だけ**(調べる相手は 1 つ)── `office-pack-input` と同じ作法。
       * ⚠ **値は必ず空へ戻す**(#854 段②)── 戻さないと、同じ file をもう一度
       *   選んでも `change` が発火せず、「押しても選び直せない」という
       *   dead click になる(user 裁定「毎回選び直す」を、同じ file でも守る)。
       */
      const file = el.files?.[0] ?? null;
      el.value = '';
      // 🔴 「もう 1 つ足す…」から開いた回は**足す**(#918 段⑦)。⚠ 印は読んだら必ず外す
      const adding = el.getAttribute('data-pkc-sql-pick') === 'add';
      el.removeAttribute('data-pkc-sql-pick');
      if (file) {
        services.pickSqlLocalFile?.(file, adding);
        // 🔴 添付を選んだ道(`set-sql-source`)と同じ知らせ(#992 ①)
        const note = duckDbNetworkNoteOf(file.name);
        if (note !== null) services.showStatus?.(note);
      }
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
    if (ke.isComposing || ke.keyCode === 229) return;
    /**
     * 🔴 **板の付箋の上の欄**(#529 W5)── Enter で確定 / Esc でやめる。
     * ⚠ 追記は **Shift+Enter が改行**。題名は 1 行なので改行は入れない。
     * ⚠ `isComposing` は上で弾き済みだが、Safari は変換を確定した Enter が `isComposing: false` で
     *   届く(`keyCode` 229)── 日本語で書く人が打ち終わる前に飛ばないよう、これも見る。
     */
    if (field === 'place-inline-input') {
      const mode = (ke.target as HTMLElement).closest('[data-pkc-field="place-inline"]')?.getAttribute('data-pkc-mode');
      if (ke.key === 'Enter' && ke.keyCode !== 229 && (mode === 'rename' || !ke.shiftKey)) {
        ke.preventDefault();
        run('place-inline-commit', ke.target as HTMLElement);
      } else if (ke.key === 'Escape') {
        ke.preventDefault();
        ke.stopPropagation();
        run('place-inline-cancel', ke.target as HTMLElement);
      }
      return;
    }
    /**
     * 🔴 **その場で足す欄は Enter で足せる**(#1087。タグの欄 #494 と同じ作法)──
     *   直す前は欄が `<form>` の外で受け手も無く、Enter は**黙って捨てられて**いた
     *   (打った後にボタンを探させる)。押すのはボタンと**同じ 1 つの action**。
     * ⚠ Safari は変換を確定した Enter が `isComposing: false` で届く(`keyCode` 229)── これも見る。
     */
    const quickAdd = field === null ? undefined : QUICK_ADD_ENTER.get(field);
    if (quickAdd !== undefined) {
      if (ke.key === 'Enter' && ke.keyCode !== 229 && !ke.shiftKey && !ke.ctrlKey && !ke.metaKey && !ke.altKey) {
        ke.preventDefault();
        run(quickAdd, ke.target as HTMLElement);
      }
      return;
    }
    // 🔴 添付の改名欄の Enter = 確定(#1264 §1)── 字が同じでもファイル名を揃える
    if (ke.key === 'Enter' && field === 'attachment-rename') {
      commitAttachmentName(ke.target);
      return;
    }
    /**
     * 🔴 **SQL は `Ctrl`(mac は Command)+ `Enter` で走る**(#681 段②)。
     *
     * ⚠ **素の `Enter` は握らない** ── 打つのは**何行にもなる問い合わせ**なので、
     *   改行を奪うと 2 行目が書けなくなる(表の升 `:5131` と同じ判断)。
     * 🔑 走らせるのはボタンと**同じ 1 つの action**(`RUN_SQL`)──
     *   ここで判定を増やさない(§7)。断る門は reducer に 1 か所だけ在る。
     */
    if (
      ke.key === 'Enter' &&
      (ke.ctrlKey || ke.metaKey) &&
      !ke.altKey &&
      !ke.shiftKey &&
      field === 'sql-input'
    ) {
      ke.preventDefault();
      dispatcher.dispatch({ type: 'RUN_SQL' });
      return;
    }
    /**
     * 🔴 **打つ所を道具にする**(#918 段②a。user 要望 2026-09-14「打つ所がお粗末」)。
     *
     * ⚠ **握るのは 3 つだけ**(`↑` / `↓` / `Tab`)── 増やすほど、
     *   ふつうの編集が効かなくなる。
     */
    if (field === 'sql-input' && ke.target instanceof HTMLTextAreaElement) {
      const ta = ke.target;
      const plain = !ke.ctrlKey && !ke.metaKey && !ke.altKey;
      /**
       * 🔴 **Tab で字下げ**。⚠ **`Shift`+`Tab` は握らない** ── 鍵盤だけで使う人の
       *   **逃げ道**である(握ると、この欄から二度と出られなくなる)。
       * ⚠ `Esc` でも外れる(下)── 逃げ道を 2 つ置く。
       * 🔑 差し込みは `insertText` を通す ── **元に戻す(Undo)が効く**形を壊さない。
       */
      if (ke.key === 'Tab' && plain && !ke.shiftKey) {
        ke.preventDefault();
        insertText(ta, '  ');
        return;
      }
      /**
       * 🔑 **この欄から出る**(`Shift`+`Tab` と対の逃げ道)。
       *
       * ⚠ **メニューが出ている間は握らない** ── `Escape` は別の聞き手
       *   (`onMenuKey`)が**メニューを閉じる**のにも使う。ここで焦点まで外すと、
       *   「右クリックを取り消しただけ」のつもりの user が**打っていた所を失う**
       *   (CLAUDE.md「欠陥の多くは『さっきまでやっていたことが消える』形で出る」)。
       * 🔑 判定は `onMenuKey` と**同じ口**(`contextMenuOpen`)で聞く ──
       *   2 つ目の数え方を作らない(§7)。
       */
      if (ke.key === 'Escape' && plain && !ke.shiftKey && !contextMenuOpen(root)) {
        ke.preventDefault();
        ta.blur();
        return;
      }
      /**
       * 🔴 **前に打った字を戻す / 進む**。
       * ⚠ **1 行目で `↑`、最後の行で `↓`** のときだけ握る ── でないと
       *   **複数行の中を上下に動けなくなる**(打つのは何行にもなる問い合わせである)。
       * ⚠ 選んでいる途中(範囲選択)は握らない(選び直しの邪魔をしない)。
       */
      if ((ke.key === 'ArrowUp' || ke.key === 'ArrowDown') && plain && !ke.shiftKey) {
        const at = ta.selectionStart ?? 0;
        const to = ta.selectionEnd ?? 0;
        if (at !== to) return;
        const back = ke.key === 'ArrowUp';
        const onFirst = lineStart(ta.value, at) === 0;
        const onLast = ta.value.indexOf('\n', at) === -1;
        if (back ? !onFirst : !onLast) return;
        ke.preventDefault();
        dispatcher.dispatch({ type: 'SQL_HISTORY_STEP', back });
        return;
      }
    }
    /**
     * 🔴 **その場で計算する**(#764。user 裁定 2026-09-06「**PKC2と同じで！**」)。
     *
     * `2+3=` まで打って `Enter` を押すと、その場が `2+3=5` になって改行する。
     *
     * ⚠ **改行は止めない** ── 答えを差し込んだうえで、下の引用の継ぎ足しと
     *   ブラウザ既定の改行にそのまま渡す(`Enter` の意味を奪わない)。
     * ⚠ **選んでいる字があるときは撃たない** ── その `Enter` は
     *   「選んだ所を改行で置き換える」であって、計算の合図ではない
     *   (撃つと `insertText` が**選んだ字を答えで置き換えて消す**)。
     * 🔑 規則は `features/markdown/inline-calc.ts` の 1 か所 ── ここは当てるだけ。
     *
     * 🔴 **効く欄は 3 つ**(2026-09-07、着地前の動線レビュー):
     *   2 列の全文欄(`editor-body`)/ ライブの行(`row-source`)/
     *   **追記欄(`append-input`)**。
     *   ⚠ 追記欄を落としていたのは**裁定と食い違っていた** ── PKC2 は
     *   `isInlineCalcTarget` で追記の欄を名指しで許しており、素の `Enter` を
     *   計算に使っている(送るのは `Ctrl`+`Enter` なので取り合わない)。
     *   ⚠ 追記欄は「開かずに済ませる」いちばん短い動線で、家計や作業ログの
     *   ような**数を書く用途そのもの**である。
     * 🔴 **引用の継ぎ足し(下)とは欄の集合が違う**ので、同じ `if` に相乗りさせない
     *   ── 相乗りさせると、追記欄で引用の継ぎ足しまで始まる(§7)。
     */
    if (
      ke.key === 'Enter' &&
      // ⚠ Safari は変換を確定した Enter が `isComposing: false` で届く(`keyCode` 229)── 確定の Enter で答えを挿さない(#1087)
      ke.keyCode !== 229 &&
      !ke.shiftKey &&
      !ke.ctrlKey &&
      !ke.altKey &&
      !ke.metaKey &&
      (field === 'editor-body' || field === 'row-source' || field === 'append-input' || field === SECTION_BOX_INPUT_FIELD) &&
      ke.target instanceof HTMLTextAreaElement &&
      ke.target.selectionStart === ke.target.selectionEnd
    ) {
      const ta = ke.target;
      /**
       * 🔴 **計算の入口は `resolveInlineCalc` 1 つ**(#1230)── 上の行の `名前 = 数` を
       * 引く式と `合計=` も、今までの `2+3=` と同じ口を通る(別の判定を作ると、
       * `Enter` で計算できる行とパレットで計算できる行が食い違う ── §7)。
       */
      // ⚠ コード・数式の中の `2+3=` は user の字そのもの ── 貼付(`pasteText`)と同じく計算しない
      // 🔴 1 面の編集の行は、その行より上の本文も読む(`基本単価 = 3200` や `合計=` が別の段落に在っても動く。#1852 I2 / 依頼 78-2)
      const above = rowTextAbove(ta);
      const res = insideCodeOrMath(ta.value, ta.selectionStart) ? null : resolveInlineCalc(ta.value, ta.selectionStart, above);
      if (res !== null && res.tooManyDigits) {
        // 🔴 桁が多すぎて正しく出せない答えは挿さない(直す前は末尾の違う値・丸めた値・指数の字が黙って入った。依頼 114-5)
        services.showStatus?.(CALC_TOO_MANY_DIGITS);
      } else if (res !== null) {
        /**
         * 🔴 **`insertText` で挿す**(= `execCommand('insertText')`)。
         *
         * ⚠ **`setRangeText` では取り消せない**(2026-09-07 実測)── 答えを
         *   挿した後に `Ctrl`+`Z` を 6 回押しても `1200*1.1=1320` で止まり、
         *   **自分で打った字にも戻れなかった**(取り消しの履歴ごと切れる)。
         *   🔑 `insertText` なら履歴に載るので、押した分だけ戻せる。
         * ⚠ 挿す位置を指定しない ── `insertText` は**カーソルの所**へ挿し、
         *   カーソルは発火の条件からして `=` の直後に在る。位置を渡すと
         *   `execCommand` の道と fallback の道で挿し先が食い違う余地ができる(§7)。
         */
        /**
         * 🔴 **全角で打っていたら、式ごと半角へ直す**(#773。user 裁定 2026-09-07
         * 「**全角入力時は計算式を含めて半角化して欲しい**」)。
         *
         * ⚠ 差し替えも `insertText` で撃つ ── `setRangeText` だと**取り消しの
         *   履歴が切れる**(#765 で実測した)。
         * ⚠ 全角と半角は**1 字 → 1 字**なので、差し替えてもカーソルは `＝` の
         *   直後(= 元の位置)のままである ── だから次の 1 手がそのまま使える。
         */
        if (res.halfWidth !== null) {
          ta.setSelectionRange(res.halfWidth.from, res.halfWidth.to);
          insertText(ta, res.halfWidth.text);
        }
        // ⚠ 普通の数字にならない答え(`1e21` 以上など)は何も挿さない
        const shown = formatCalcResult(res.value);
        if (shown !== null) insertText(ta, shown);
      } else {
        /**
         * 🔴 **計算にならなかったら、理由を 1 行だけ出す**(#766 A-2、2026-09-08)。
         *
         * ⚠ 直す前は**発火したときしか痕跡が無かった** ── `1,2+3=` も `2^3=` も
         *   `50%=` も**無音**なので、3 回試して 3 回とも黙られると
         *   「この機能は効かない」と思ってやめる。
         * 🔑 出す条件は `explainCalcMiss` が持つ(**数と記号だけの行**に限る)──
         *   `締切=` のような普通の文では 1 度も出ない。
         * ⚠ **`OP_FAILED` に載せない**(あれはエラーの行)── 一時の知らせへ出す。
         * ⚠ **`Enter` は止めない** ── 理由を出すだけで、改行はそのまま通す
         *   (打っている手を止めない)。
         */
        const why = explainCalcMiss(ta.value, ta.selectionStart, above);
        if (why !== null) services.showStatus?.(why);
      }
    }
    /**
     * 🔴 **引用(`>`)を書き続けられるようにする**(#396)。
     *
     * ⚠ **IME ガードの直後**に置く ── 変換確定の Enter で引用を継ぎ足したら、
     *   日本語で書く人は毎回踏む。
     * ⚠ 修飾キーが付いた Enter は**別の意味**(確定 / 送信)なので触らない。
     * 🔑 規則は `features/markdown/quote-assist.ts` の 1 か所 ── ここは当てるだけ。
     * 🔑 **2 列の全文欄でも、ライブの行の欄でも効く**(どちらも Enter は
     *   その欄の中で改行する)。
     * 🔴 **リスト(`- ` / `1. ` / `- [ ] `)の継ぎ足しも同じ関数が決める**(#1167)──
     *   だから**欄の集合も同じ**(追記欄には入れない。追記欄の Enter は
     *   計算にだけ使い、送るのは `Ctrl`+`Enter`)。⚠ 上の計算が先に答えを挿すので、
     *   ここで読む `ta.value` / `selectionStart` は**挿した後**の値である
     *   (`- 2+3=` → `- 2+3=5` の行末から続く)。
     */
    if (
      ke.key === 'Enter' &&
      // ⚠ 上の計算と同じ理由(Safari の変換確定の Enter)── 確定で `> ` / `- ` を継ぎ足さない(#1087)
      ke.keyCode !== 229 &&
      !ke.shiftKey &&
      !ke.ctrlKey &&
      !ke.altKey &&
      !ke.metaKey &&
      // 🔴 章だけを編集する欄(`SECTION_BOX_INPUT_FIELD`)も同じ(#1163 依頼 150。箇条書きの章で Enter を押しても `- ` が続かなかった)
      (field === 'editor-body' || field === 'row-source' || field === SECTION_BOX_INPUT_FIELD) &&
      ke.target instanceof HTMLTextAreaElement &&
      // 🔴 範囲を選んでいるときは普通の Enter(選んだ字を改行に置き換える)に任せる ── 規則は caret の行しか見ないので、
      //   空の `> ` / `- ` の行から下へ選んで押すと、選んだ範囲を置き換えずに記号だけ消していた(#1087 調査 7)
      ke.target.selectionStart === ke.target.selectionEnd
    ) {
      const ta = ke.target;
      const r = quoteOnEnter(ta.value, ta.selectionStart);
      /**
       * 🔴 **書き込みは `insertText`(`execCommand`)で行う**(#765、2026-09-07)。
       *
       * ⚠ ここは長らく `setRangeText` で、注釈には「`value` 直代入は Ctrl+Z の
       *   履歴を捨てる」と書いてあった ── **`setRangeText` も同じく捨てる**。
       *   実測(実ブラウザ):`> ひきよう` で `Enter` を押すと、以後
       *   **`Ctrl`+`Z` を 8 回押しても 1 文字も戻らない**(継ぎ足した `> ` も、
       *   自分で打った `ひきよう` も)。
       * 🔴 直す理由は**この PR が約束を配るから**である ── #764 のお知らせと
       *   マニュアルは「出た答えは `Ctrl`+`Z` で戻せます」と書くが、引用の行では
       *   直後にここが走るので、**答えごと戻せなくなっていた**。
       * ⚠ `exit`(引用をやめる)は**範囲を消す**ので、消す所を選んでから撃つ ──
       *   空文字の `insertText` は選択を消し、取り消しにも載る(実測)。
       */
      if (r.kind === 'continue') {
        ev.preventDefault();
        insertText(ta, r.insert);
        return;
      }
      if (r.kind === 'exit') {
        ev.preventDefault();
        ta.setSelectionRange(r.from, r.to);
        insertText(ta, r.text);
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
      /**
       * 🔴 **見出しの升は Enter / Space でも編集欄を開かない**(#1240)── 見出しは
       *   `tabindex="0"` を持つ(並べ替えのため)ので、ここへ入って `edit-cell` を撃っていた。
       *   並べ替えは見出し自身の鍵の受け手が受ける。判定は `opensOnSinglePress` 1 か所。
       */
      if (
        el?.getAttribute('tabindex') === '0' &&
        el.hasAttribute('data-pkc-action') &&
        opensOnSinglePress(el)
      ) {
        // ⚠ Space は既定でページを送る ── 押した先が動くほうが正しい
        ke.preventDefault();
        run(el.getAttribute('data-pkc-action'), el);
        return;
      }
    }
    /**
     * 🔴 **タグの欄は Enter で足せる**(#494)。
     *
     * ⚠ **これが無いと、user 指摘そのものが直らない** ── 「ここに打つ!って感じ」で
     *   打った後に**押すボタンを探させる**のでは、動線は 1 手も減っていない。
     * ⚠ **変換中の Enter では撃たない** ── 日本語のタグを打つ人は毎回踏む。
     *   🔑 ただし `isComposing` は**この関数の入口で弾き済み**(上の `if (ke.isComposing) return;`)
     *   ── ここで書き足すと **no-op** になる(変異試験 T2 が SURVIVED で教えた。
     *   CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」)。
     *   守りは `tests/adapter/inspector-tag-input.test.ts` が**振る舞いで**留めている。
     * ⚠ 欄の中だけ ── 画面全体の近道にしない(`append-input` と同じ作法)。
     */
    /**
     * 🔴 **3 つの欄とも Enter で足せる**(#639)── 欄と操作の対は `TAG_INPUT_ADD`
     *   1 か所だけが持つ(候補の口も同じ表から引く)。
     * ⚠ 直す前はこの `if` が `tag-add-input` を**直書き**していたので、
     *   帯の欄と条件の欄では **Enter が無音で捨てられて**いた。
     */
    const tagAdd = field === null ? undefined : TAG_INPUT_ADD.get(field);
    if (tagAdd !== undefined) {
      if (ke.key === 'Enter' && !ke.shiftKey && !ke.ctrlKey && !ke.metaKey) {
        ke.preventDefault();
        run(tagAdd, ke.target as HTMLElement);
      }
      return;
    }
    // 追記欄: 既定は Ctrl/Cmd+Enter(欄の中だけ ── 画面全体の近道にしない)
    if (field === 'append-input') {
      if (keymap.match(ke, 'append') === 'append-send') {
        ke.preventDefault();
        run('append-entry', ke.target as HTMLElement);
        return;
      }
      /**
       * 🔴 **付箋の窓は、追記欄に焦点が乗ったまま開く**(#1042 段②。裁定:
       * `docs/development/touch-and-unity-design-2026-09.md` §11 Q3)。
       *
       * ⚠ `typing` の門(下の `onShortcut`)は `<textarea>` に焦点があると
       *   `Escape` を丸ごと止めるので、**1 回目の `Escape` が無反応**になっていた
       *   (開いた直後に閉じようとした user から見て、押しても何も起きない)。
       * 🔑 **何も打っていないときだけ**ここで拾って窓を閉じる ── 一文字でも
       *   打っていたら**今までどおり何もしない**(下書きを Escape 1 発で
       *   消さない。CLAUDE.md §10「置き換えの作法」と同じ向き:入力中の Escape を
       *   奪うのは、native の `<textarea>` が持たない挙動を足すことになる)。
       * ⚠ **付箋でない窓では何もしない** ── `services.closeNoteWindow` は
       *   `heldNoteWindow` を見て判断する(`main.ts`)ので、本体タブでは
       *   常に `'not-a-window'`/`undefined` を返し、ここは黙って通過する。
       * ⚠ **`'refused'`(ブラウザが閉じなかった)も黙らない**(#1042 段④)──
       *   `close-pane` と同じ理由を出す(`CLOSE_VIEW_WINDOW_REFUSED`)。
       */
      if (
        ke.key === 'Escape' &&
        ke.target instanceof HTMLTextAreaElement &&
        ke.target.value === '' &&
        // 🔴 欄は空でも、章の欄が開いていれば閉じない(#1087)
        !noteWindowHasTyping(root, dispatcher.getState())
      ) {
        const closed = services.closeNoteWindow?.() ?? 'not-a-window';
        if (closed !== 'not-a-window') {
          ke.preventDefault();
          if (closed === 'refused')
            dispatcher.dispatch({ type: 'OP_FAILED', error: CLOSE_NOTE_WINDOW_REFUSED });
        }
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
      // 🔴 字下げ(#1166)は `Tab` が行の保存なので、鍵(`Ctrl+]` / `Ctrl+[`)で受ける。
      //   行の入れ替え(#1213 `Alt+↑↓`)も同じ門 ── 欄の中の行だけ動かす(塊はまたがない)
      if (rowCmd !== null && (INDENT_COMMANDS.has(rowCmd) || SWAP_COMMANDS.has(rowCmd))) {
        ke.preventDefault();
        // 🔴 動かせなかったとき(#1254 §1)は `align-table` と同じ口で 1 行言う。
        //   ⚠ 字下げは何も変わらなければ静かでよい(`notify` を持たない)ので、渡しても鳴らない
        EDITOR_RUN[rowCmd]!(ke.target as HTMLTextAreaElement, (t) => services.showStatus?.(t));
        return;
      }
      /**
       * 🔴 **user が鍵を割り当てた「表の列幅を揃える」を、1 面の行で押したとき**(#1171)。
       * ⚠ ここは書式の近道だけを通す門なので、何も言わずに素通りすると
       *   「鍵を割り当てたのに何も起きない」になる ── 行き先を言う(`EDITOR_RUN` と同じ口)。
       */
      if (
        rowCmd === 'align-table' ||
        rowCmd === 'inline-calc' ||
        (rowCmd !== null && TIDY_COMMANDS.has(rowCmd))
      ) {
        ke.preventDefault();
        EDITOR_RUN[rowCmd]!(ke.target as HTMLTextAreaElement, (t) => services.showStatus?.(t));
        return;
      }
      if (rowCmd === null || FORMAT_OF[rowCmd] === undefined) return;
      ke.preventDefault();
      // 🔑 当て方は `applyFormatTo` 1 か所(§7 ── パレットも同じ口を通る)
      applyFormatTo(ke.target as HTMLTextAreaElement, rowCmd, undefined, (t) =>
        services.showStatus?.(t),
      );
      return;
    }
    /**
     * 🔴 **章の欄にも書式の近道を効かせる**(#1044 段2。`row-source` と同じ形 ──
     *   2 本目の実装を書かない)。⚠ 書式のボタンの帯は出さない(設計 doc §3)が、
     *   近道は**全文編集と同じ表**(`FORMAT_OF` / `applyFormatTo`)を通す。
     *   `Escape` はここでは受けない(別の裁定待ち)。
     * 🔴 **`Ctrl+S` / `Ctrl+Enter` は「章を保存する」/「コードを保存する」を押したのと同じ**(#1087)。
     *   ⚠ 直す前は受けず、`preventDefault` もしないのでブラウザの「ページを保存」が開いた。
     *   押すのは**同じ箱の保存ボタン**(新しい経路を作らない。保存中は `disabled` なので二重に撃たない)。
     */
    if (
      (field === SECTION_BOX_INPUT_FIELD || field === CODE_BOX_INPUT_FIELD) &&
      (ke.ctrlKey || ke.metaKey) &&
      !ke.altKey &&
      !ke.shiftKey &&
      (ke.key === 's' || ke.key === 'S' || ke.key === 'Enter')
    ) {
      ke.preventDefault();
      const saveAction = field === SECTION_BOX_INPUT_FIELD ? 'save-section-draft' : 'save-code-draft';
      (ke.target as HTMLElement)
        .closest(`[data-pkc-region="${field === SECTION_BOX_INPUT_FIELD ? SECTION_BOX_REGION : CODE_BOX_REGION}"]`)
        ?.querySelector<HTMLButtonElement>(`[data-pkc-action="${saveAction}"]`)
        ?.click();
      return;
    }
    // 🔴 `Tab` だけは下の本文と同じ表・テンプレート・字下げの門へ通す(#1163 依頼 150)。⚠ 当たらなければ素通し(焦点は今までどおり出ていく)
    if (field === SECTION_BOX_INPUT_FIELD && ke.key !== 'Tab') {
      const sectionCmd = keymap.match(ke, 'row');
      if (sectionCmd === null || FORMAT_OF[sectionCmd] === undefined) return;
      ke.preventDefault();
      applyFormatTo(ke.target as HTMLTextAreaElement, sectionCmd, undefined, (t) =>
        services.showStatus?.(t),
      );
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
    /**
     * 🔴 表の編集アシスト (Tab / Shift+Tab)(#1093)。
     * 表のセル内ならセル移動や行追加を行う。
     * ⚠ 表の外なら通常の短縮語・印移動・通常の焦点移動へ通す。
     * ⚠ **ライブの行の欄(`row-source`)はここへ来ない**(上の `field === 'row-source'` の門が必ず `return` する)。
     *   行の欄の `Tab` は「行を確定する」で、セルは動かない(`row-swap.ts`)── 届かない枝は置かない(#1087 B-1)。
     */
    if (
      (field === 'editor-body' || field === SECTION_BOX_INPUT_FIELD) &&
      ke.key === 'Tab' &&
      !ke.ctrlKey &&
      !ke.altKey &&
      !ke.metaKey &&
      ke.target instanceof HTMLTextAreaElement
    ) {
      const ta = ke.target;
      const res = tableOnTab(ta.value, ta.selectionStart, ke.shiftKey);
      if (res !== null) {
        ke.preventDefault();
        if (res.kind === 'insert-row') {
          ta.setSelectionRange(res.insertPos, res.insertPos);
          insertText(ta, res.text);
          ta.setSelectionRange(res.start, res.end);
        } else {
          ta.setSelectionRange(res.start, res.end);
        }
        return;
      }
    }

    if ((field === 'editor-body' || field === SECTION_BOX_INPUT_FIELD) && ke.key === 'Tab' && !ke.shiftKey) {
      const ta = ke.target as HTMLTextAreaElement;
      const plainTab = !ke.ctrlKey && !ke.altKey && !ke.metaKey;
      // 🔑 短縮語 → 次の印の判定は `runSnippetTab` 1 か所(1 面の行の `Tab` も同じ口を通る)
      if (runSnippetTab(ta, dispatcher.getState().snippetScan?.items ?? [])) {
        ke.preventDefault();
        return;
      }
      /**
       * 🔴 **リストの行 / 複数行の選択の `Tab` は字下げ**(#1166)。
       * ⚠ **短縮語・印・表より後ろ**に置く ── 雛形を呼ぶ `Tab` と表のセル移動を奪わない。
       * ⚠ 握るのは**リストの項目か複数行のときだけ**(`indentLines` が `null` を返したら
       *   何もしない = 焦点が出ていく。意図した出口 ── 上の戒めのとおり常に握らない)。
       */
      if (plainTab && runIndent(ta, 1, false)) {
        ke.preventDefault();
        return;
      }
    }
    // 🔴 `Shift`+`Tab` は**戻せる字下げがあるときだけ**握る(無ければ焦点が前へ出る)。
    //   ⚠ 表のセルは上の `tableOnTab` が先に取っている
    if (
      (field === 'editor-body' || field === SECTION_BOX_INPUT_FIELD) &&
      ke.key === 'Tab' &&
      ke.shiftKey &&
      !ke.ctrlKey &&
      !ke.altKey &&
      !ke.metaKey &&
      runIndent(ke.target as HTMLTextAreaElement, -1, false)
    ) {
      ke.preventDefault();
      return;
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
    // 🔴 記法でない「本文の欄へ当てる命令」(#766 D-2)── 鍵の側でも同じ口を通す
    const runEditor = cmd === null ? undefined : EDITOR_RUN[cmd];
    if (cmd === 'commit-edit') {
      ke.preventDefault();
      // ⚠ 近道キーも同じ規則に乗せる(ボタンだけ止めても意味が無い)
      if (refuseWhileBusy('commit-edit', dispatcher, services)) return;
      renameFromEditorInput(dispatcher, root);
      dispatcher.dispatch({ type: 'COMMIT_EDIT' });
    } else if (field === 'editor-body' && runEditor !== undefined) {
      // 🔑 **本文だけ**(題名で計算しても意味が無い)。⚠ `isComposing` は上で弾き済み
      ke.preventDefault();
      runEditor(ke.target as HTMLTextAreaElement, (t) => services.showStatus?.(t));
    } else if (field === 'editor-body' && op !== undefined && cmd !== null) {
      // 🔑 **キーボードは近道**(業務画面の作法 ── user 指示 2026-08-03)。
      // 本文だけ。題名に太字を入れても意味が無い。⚠ `isComposing` は上で弾き済み
      ke.preventDefault();
      // 🔑 当て方は `applyFormatTo` 1 か所(§7 ── パレットも同じ口を通る)
      applyFormatTo(ke.target as HTMLTextAreaElement, cmd, undefined, (t) =>
        services.showStatus?.(t),
      );
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
          /**
           * 🔴 **事情は `why` として渡す**(#666 の着地前レビュー 1)。
           *
           * ⚠ 1 稿目はここで `OP_FAILED` を撃っていたが、**user は一度も読めなかった**
           *   ── `attachFiles` は非同期なので、この行が出た**あと**に
           *   `CREATE_ENTRY` が走り、その reducer が **`error: null`** を書く。
           *   ⚠ `capture.ts` の同じ注記が既にこれを戒めている(踏み直した)。
           * 🔑 いまは取込の知らせと**同じ 1 行**に出る ──
           *   「編集欄が閉じたため、打っていた所へは差せませんでした。「猫.png」を
           *   本文のいちばん下に入れました」。
           */
          services.attachFiles(
            [...files],
            '編集欄が閉じたため、打っていた所へは差せませんでした。',
          );
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
  const routeFiles = (
    files: readonly File[],
    target: EventTarget | null,
    /** 🔴 落とした所(#684 段④)。⚠ 貼付・ボタンの経路は渡さない(= いちばん下)。 */
    at?: DroppedAt,
  ): boolean => {
    if (files.length === 0) return false;
    /**
     * 🔴 **落とした `.md` / `.vcf` は「取り込む」と同じ結果にする**(#535 ①)。
     *
     * ⚠ 直す前は**添付**になっていた ── スマホから出した `contacts.vcf` を
     *   窓へ落とすのはいちばん自然な手なのに、**連絡先は 1 件も増えず、
     *   要らない添付が 1 つ残る**。🔑 「取り込めなかった」ではなく
     *   「**別のことが起きた**」ので、user は自分が何を間違えたのか分からない。
     *
     * 🔑 **判定は取込の振り分けと同じ関数**(`isMarkdownFileName` /
     *   `isVcfFileName`)── ここで拡張子を書き直すと、
     *   「落として入る物」と「選んで入る物」が食い違う(CLAUDE.md §7)。
     *
     * ⚠ **全部がその 2 種のときだけ**倒す ── 画像と混ざっていたら、
     *   これまでどおり添付にする(`importFiles` は混在を断るので、
     *   ここで倒すと**落としただけで断り文が出る**)。
     * ⚠ 添付したい人の道は残っている ── 「添付」ボタンから選べば添付になる。
     *   その旨は取込の帯が言う(片道にしないための対は #535 ② の「取り消す」)。
     *
     * 🔴 **編集中は倒さない**(着地前に自分の diff を読み直して見つけた回帰)。
     * ⚠ 取込は `phase !== 'ready'` を**断る**ので、倒すと編集中に `.md` を落とした人は
     *   「編集を保存するか、編集をやめてから取り込んでください」を読まされる ── **これまでは
     *   添付できていた**ので、動線を 1 つ奪うことになる。
     * 🔑 だから**取込が受けられるときだけ**倒し、そうでなければ**これまでどおり**添付。
     *
     * 🔴 **章の欄が開いている間も倒さない**(#1044 段2 3巡目の修理、S3)。
     * ⚠ 章の欄は `phase` を `ready` のまま保つ(設計 doc §3)ので、上の
     *   `phase === 'ready'` だけでは素通りする ── 直す前は章の欄を開いたまま
     *   `.md` を落とすと**取込へ倒れ、`importMarkdownFiles` の phase 検査
     *   (`phase !== 'ready'`)も素通りして新しい entry を作っていた**。
     *   `hasUnsavedTyping` は `phase === 'editing' || sectionDraft !== null` を
     *   1 か所で見る(§7 と同じ判定を 2 か所に書かない)。
     * ⚠ **倒さなかった回は添付へ落ちる**(このすぐ下 ── `isBodyInput` / 添付欄)。
     *   添付は `bodyWriteBlockReason` の門(R11)を通るので、章の欄が開いている
     *   ノートへ落とすと `SECTION_DRAFT_NOTE` で断られ、理由が出る(無言にならない)。
     * ⚠ **`phase === 'ready'` は残す**(`initializing` / `error` の扱いを変えない)──
     *   `hasUnsavedTyping` 単独では `editing` しか phase を見ないので、
     *   `phase === 'ready'` と組み合わせて初めて元の 4 相の分け方(ready のみ倒す)
     *   と一致する。
     */
    const routeSt = dispatcher.getState();
    if (
      services.importFiles &&
      routeSt.phase === 'ready' &&
      !hasUnsavedTyping(routeSt) &&
      files.every(
        (f) =>
          isMarkdownFileName(f.name) ||
          isVcfFileName(f.name) ||
          isIcsFileName(f.name) ||
          // 🔴 バックアップ(`.pkc3-full.zip` など)も(#1632)── 添付にすると「元に戻したつもりが zip が増えただけ」
          //    になり、成功したように見える。取り込みには確認(取り込む / やめる)が出るので、落としただけでは入れ替わらない
          isBackupFileName(f.name),
      )
    ) {
      services.importFiles([...files]);
      return true;
    }
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
      // ⚠ `why` は空(事情が無い)── 落とした所だけを渡す
      services.attachFiles([...leftover], undefined, at);
      handled = true;
    }
    return handled;
  };

  /** 直近に「Markdown に直しました」を残した時刻(束ねる用)。 */
  let lastPasteMessageAt: number | null = null;

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
    /**
     * 🔴 **コード・数式の中では何も変換しない**(#1087)── fence の中へ表を貼ると fence が入れ子に、
     *   HTML を貼ると `**` やリンクの形が入り、選んだ字へ URL を貼ると `[字](URL)` になっていた。
     *   コードの中の字は user の字そのものなので、素の貼付に任せる(判定は `code-context.ts` の 1 本)。
     */
    if (insideCodeOrMath(target.value, target.selectionStart ?? 0)) return false;
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
    const source = services.pasteSource?.() ?? DEFAULT_PASTE_SOURCE;
    /**
     * 🔴 **選んだ字へ URL を貼ると `[選んだ字](URL)` にする**(#1165)。
     *
     * ⚠ **HTML / RTF の変換より先に見る** ── Slack などのコピーは `text/html` に
     *   `<a>` を、`text/plain` に URL を載せる。HTML が先に当たると、選んだ字が
     *   **消えて**リンク文字列に置き換わる(「選んだ字をリンクにしたい」の逆)。
     * ⚠ **設定「変換しない」では何もしない** ── `choosePaste` が「1 種類だけ
     *   書き換わると設定の字が嘘になる」と言っているのと同じ理由である
     *   (判定の許可は `source !== 'plain'` の 1 行 ── ここで渡す)。
     * 🔑 パーマリンク(内部リンク)が当たったときは**そちらが勝つ**(上の判定)。
     * 🔑 差すのは `insertText` ── **1 回の Undo で選んだ字へ戻る**。
     */
    if (permalink === null) {
      const from = {
        text: target.value,
        start: target.selectionStart ?? 0,
        end: target.selectionEnd ?? 0,
      };
      const linked = linkifyPastedUrl(from, plain, source !== 'plain');
      if (linked !== null) {
        insertText(target, linked.text.slice(from.start, linked.end));
        return true;
      }
    }
    /**
     * 🔴 **どれを読むかは設定が決める**(user 指示 2026-08-25)。
     * ⚠ **順番をここに書かない** ── 判定は `choosePaste` の 1 か所である
     *   (呼び側で条件を足すと「経路ごとに挙動が違う」形になる。CLAUDE.md §7)。
     * 🔑 変換の口は**遅延**で渡す ── 設定が「変換しない」のとき 1MB の HTML を
     *   解析しない(押した瞬間に止まらないための作法)。
     */
    const chosen = choosePaste({
      source,
      sizes: { html: html.length, rtf: rtf.length, plain: plain.length },
      convert: {
        permalink: () => permalink,
        html: () => convertPastedHtml({ html, plain }),
        /** ⚠ 変換せず囲みにする(設定「ウェブページの形をそのまま」)。 */
        htmlFence: () => pastedHtmlFence(html),
        rtf: () => convertPastedRtf({ rtf, plain }),
        /**
         * ⚠ **最後の手**(#708 段③)── HTML も RTF も使えなかったときだけ、
         *   タブ区切りの平文を表の囲みにする。判定は `table-convert.ts` の 1 か所。
         */
        plainTable: () => tsvFenceFromPlain(plain),
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
    /**
     * 🔴 **Markdown に直して貼ったときだけ、メッセージへ 1 件残す**(#1379)。
     * ⚠ 対象は HTML / リッチテキストから起こした物だけ(平文・パーマリンク・
     *   そのまま囲む・タブ表は「直した」ではない)。⚠ **字は固定** ── 貼った中身を含めない。
     * ⚠ 続けて貼ったときは束ねる(`PASTE_MESSAGE_COALESCE_MS` 以内は 1 件)。
     * ⚠ **差し込みに成功した後で呼ぶ**(資産化を待つ間に欄が閉じたら、「貼りました」は嘘になる)。
     */
    const leaveConverted = (): void => {
      if (converted === null || (chosen.attempt.used !== 'html' && chosen.attempt.used !== 'rtf')) return;
      const now = Date.now();
      if (lastPasteMessageAt !== null && now - lastPasteMessageAt < PASTE_MESSAGE_COALESCE_MS) return;
      lastPasteMessageAt = now;
      services.leaveMessage?.({ kind: 'result', source: '貼り付け', text: pasteConvertedMessage() });
    };

    const adopt = services.adoptUrls;
    const urls = adopt ? adoptableUrls(text) : [];
    // 変換もせず、逃がすものも無い ── **何も足せない**ので既定に任せる
    if (converted === null && urls.length === 0) return false;
    // ⚠ 逃がすものが無い(= 資産にする口が無い環境も含む)ときは、その場で差す
    if (urls.length === 0) {
      // ⚠ 囲みは行頭から差す(行の途中だと柵が柵として読まれない ── #708 段③)
      insertBlockText(target, text);
      leaveConverted();
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
      insertBlockText(into, r.text);
      leaveConverted();
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
    // 🔴 **ファイル(PDF など)をコピーして貼ったときも、ドロップと同じ行き先へ**(#1652 6。Gemini 裁定 A)。
    //   ⚠ 直す前は画像しか拾わず、エクスプローラーでコピーした PDF を貼っても何も起きず何も出なかった。
    const files = filesOf(ce.clipboardData);
    /**
     * 🔴 **文字も一緒に来ていたら、画像にしない**(Excel の範囲は表の HTML・文字・表の絵が同時に来る)。
     *   画像だけを拾うと表が消える。画像だけのクリップボード(スクショ)は今までどおり画像へ。
     */
    // ⚠ ウェブの画像 1 枚のコピーは file と `<img>` だけの HTML が来る ── それは画像として扱う
    //   (字の無い HTML を「文字」と数えると、同じ絵が 2 回入る道に戻る)
    const html = ce.clipboardData?.getData('text/html') ?? '';
    const htmlHasText =
      /<table[\s>]/i.test(html) ||
      html.replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '').trim() !== '';
    const plain = ce.clipboardData?.getData('text/plain') ?? '';
    // 🔑 Mac のファイルのコピーは、ファイル名の字も一緒に来る ── 字がファイル名だけなら「字」と数えない
    const namesOnly =
      files.length > 0 &&
      !htmlHasText &&
      plain
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
        .every((l) => files.some((f) => f.name === l.trim()));
    const hasText = htmlHasText || (plain.trim() !== '' && !namesOnly);
    // ⚠ 字も来ているなら、これまでどおり字の貼付に委ねる(表の絵 + 表の HTML のような組を壊さない)
    if (!hasText && routeFiles(files, ce.target)) {
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
  /**
   * 🔴 **待っているタブに薄い枠を出す**(依頼 79-4。Gemini の回答「推薦どおり」= B)── 切り替わることを先に見せる
   *   (勝手に画面が動いたように見えない)。待つ時間は変えない。枠の見た目は `app.css` の `data-pkc-tab-hover`。
   */
  const TAB_HOVER_ATTR = 'data-pkc-tab-hover';
  const clearTabHoverMark = (): void => {
    root.querySelectorAll(`[${TAB_HOVER_ATTR}]`).forEach((el) => el.removeAttribute(TAB_HOVER_ATTR));
  };
  const cancelTabHover = (): void => {
    if (hoverTab === null) return;
    clearTimeout(hoverTab.timer);
    hoverTab = null;
    clearTabHoverMark();
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
        tab.setAttribute(TAB_HOVER_ATTR, '');
        hoverTab = {
          mode,
          timer: setTimeout(() => {
            hoverTab = null;
            clearTabHoverMark();
            services.setBrowse?.(mode);
          }, TAB_HOVER_MS),
        };
      }
      // ⚠ 光っている落とし先は消す(タブの上に居る間は「そこへ入る」ではない)
      clearDropTarget();
      return;
    }
    cancelTabHover();
    /**
     * 🔴 **アプリのタイル**(#857 段①)── 落とし先は**群の中**の、タイルの前 / 後。
     * ⚠ 受けられない所では `preventDefault` を**呼ばない**(線を出してから断らない)。
     */
    if (de.dataTransfer?.types?.includes(PKC_TILE_DRAG) === true) {
      const to = tileDropTargetOf(de);
      if (to === null) {
        clearDropTarget();
        return;
      }
      e.preventDefault();
      de.dataTransfer.dropEffect = 'move';
      markDropEdge(to.mark, to.edge);
      return;
    }
    /**
     * 🔴 **本文の塊**(#684 段①)── 落とし先は**同じノートの本文**の塊の前 / 後。
     * ⚠ 自分の中(`start..end+1`)へは受けない(`dropEffect` は既定の `none` のまま = 印も
     *   出ない)── 落としても 1 byte も変わらない所に「入る」と見せない。
     * ⚠ 別のノートの本文へも受けない ── 段①は「本文の中で並べ替える」である。
     * ⚠ `getData` は dragover では読めない(ブラウザの保護)── 掴んだ物は `blockDrag` で持つ。
     */
    if (de.dataTransfer?.types?.includes(PKC_BLOCK_DRAG) === true) {
      const drop = bodyDropAt(de);
      if (drop !== null && blockDrag !== null && drop.lid !== blockDrag.lid) {
        /**
         * 🔴 **別のノートの本文へ持っていく**(#684 段③)── 横に留めた枠との間で、
         *   段① と同じ「前 / 後」の線が出る。
         * ⚠ 本文に入れられない種類へは受けない(線を出してから断らない ── 段④ と同じ規律)。
         */
        if (canPutIntoBody(drop.lid)) {
          e.preventDefault();
          de.dataTransfer.dropEffect = 'move';
          markDropTarget(drop.el, DROP_EDGE_ATTR, drop.edge);
          return;
        }
        clearDropTarget();
        return;
      }
      if (
        drop === null ||
        blockDrag === null ||
        drop.lid !== blockDrag.lid ||
        (drop.toBefore >= blockDrag.start && drop.toBefore <= blockDrag.end + 1)
      ) {
        /**
         * 🔴 **一覧の行へ落とすと、そのノートの末尾へ持っていく**(#684 段③)。
         * ⚠ 一覧の行は**落とした所を持たない**ので、行き先は末尾である(そう言う)。
         * ⚠ 掴んだ塊のノート自身の行へは受けない(同じ本文の中は段① の仕事)。
         */
        const row = blockDrag === null ? null : blockRowTarget(de.target);
        if (row !== null && row.lid !== blockDrag!.lid && canPutIntoBody(row.lid)) {
          e.preventDefault();
          de.dataTransfer.dropEffect = 'move';
          markDropTarget(row.el);
          return;
        }
        clearDropTarget();
        return;
      }
      e.preventDefault();
      de.dataTransfer.dropEffect = 'move';
      markDropTarget(drop.el, DROP_EDGE_ATTR, drop.edge);
      return;
    }
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
      /**
       * 🔴 **行の上半分 / 下半分は「並べ替え」**(#215)── 落とす前に線で見せる。
       * ⚠ フォルダの行の**真ん中**は今までどおり「中へ入れる」(下の `dropTargetOf`)──
       *   判定は `reorderTargetOf` 1 か所(落とす側と同じ関数)。
       */
      const edge = reorderTargetOf(de);
      if (edge !== null) {
        e.preventDefault();
        de.dataTransfer.dropEffect = 'move';
        markDropEdge(edge.row, edge.edge);
        return;
      }
      const drop = dropTargetOf(de.target);
      if (drop === undefined) {
        /**
         * 🔴 **一覧の行を本文へ落とすとリンクになる**(#684 段②)── フォルダの行でも
         *   パンくずでもない所なら、読んでいる本文の塊の前 / 後を落とし先にする(段①と同じ線)。
         * ⚠ `copy` ── 元のノートは動かない(移す操作ではない)。掴んだ側の印もそのまま。
         */
        const body = bodyDropAt(de);
        if (body !== null) {
          e.preventDefault();
          de.dataTransfer.dropEffect = 'copy';
          markDropTarget(body.el, DROP_EDGE_ATTR, body.edge);
          return;
        }
        // ⚠ **光ったままにしない**(着地前レビュー 5)── フォルダの上を通ってから
        //    別の行で離すと、user は「そこへ入った」と読む(実際は何も動かない)
        clearDropTarget();
        return; // 落とせない場所 ── 既定(受け取らない)のまま
      }
      /**
       * 🔴 **掴んだ物すべてにとって「自分 / 自分の配下」の行き先は光らせない**(落としてから断らない)。
       * ⚠ 一部の物だけがそうなら、残りは動くので光らせる(落とせば動かない物だけ断る)。
       */
      if (
        drop.lid !== null &&
        noteDragSubtrees !== null &&
        noteDragSubtrees.length > 0 &&
        noteDragSubtrees.every((sub) => sub.has(drop.lid!))
      ) {
        clearDropTarget();
        return;
      }
      e.preventDefault();
      de.dataTransfer.dropEffect = 'move';
      markDropTarget(drop.el);
      return;
    }
    if (de.dataTransfer?.types?.includes('Files') !== true) return;
    e.preventDefault();
    de.dataTransfer.dropEffect = 'copy';
    /**
     * 🔴 **外から落とす file も、本文の塊の前 / 後に線が出る**(#684 段④)。
     *
     * > issue の要件:「落とす先には必ず『落とせる』印を出す ── 出さないと、
     * > 落ちなかったときに理由が分かりません」
     *
     * ⚠ 線が出ない所(面の外・fence の中・畳んだ塊)へ落としても**これまでどおり
     *   本文のいちばん下**へ入る ── 受けないのではなく、入る所が違う。
     * 🔑 線を出すか決める判定は、書く直前の門と**同じ 1 本**(`bodyDropAt`)。
     */
    const at = bodyDropAt(de);
    if (at === null || !canPutIntoBody(at.lid)) {
      clearDropTarget();
      return;
    }
    markDropTarget(at.el, DROP_EDGE_ATTR, at.edge);
  };
  /**
   * 🔴 **その本文へ行が入るか**(#684 段③④㋑)── 塊を持っていくときも、外から
   *   file を落とすときも**同じ 1 本**である。
   *
   * ⚠ **本文に入れられない種類**(フォルダ / 添付 / スタック)へは入らない ──
   *   線を出してから「入れられません」と言うのは、issue の要件(落とせる印を出す)の
   *   裏返しである。🔑 判定は `isAppendable` **1 か所**(断る側と同じ関数 ── §7)。
   *
   * 🔴 **「いま開いているノートか」は見ない**(#684 ㋑、2026-09-09 に外した)。
   * ⚠ 外す前は file だけ `lid === selectedLid` を要求していた ── 入れ先が
   *   `selectedLid` 固定だったので、**横に留めた枠**へ線を出すと「そこへ入る」という
   *   守れない約束になったためである。🔑 いまは `attach.ts` が**落とした本文のノート**
   *   へ入れる(`elsewhere`)ので、その理由ごと消えた ── 塊・一覧の行と同じ扱いになる。
   * ⚠ **判定を 2 本に戻さない**:片方だけ条件が増えると、印の出る所と書く所が割れる
   *   (CLAUDE.md §7「同じ問いに答える口が 2 つ」)。
   */
  const canPutIntoBody = (lid: string): boolean =>
    isAppendable(dispatcher.getState().entryMetas.get(lid)?.archetype);
  /**
   * 🔴 **ここを読む所は 3 つではなく 2 つである**(#809-5 の記録、2026-09-11)。
   *
   * ⚠ **一覧の行 → 本文**(段②、`INSERT_LINES`)だけは、わざとこの門を通していない。
   *   次に読む人が「3 か所目を足し忘れている」と読んで**揃えにいく**のを止めるために、
   *   理由をここに置く(CLAUDE.md §7「同じ判定が複数の場所にある」の**例外の記録**):
   *
   * | 落とすもの | この門を通すか | なぜ |
   * |---|---|---|
   * | **塊**(段①③) | 🟢 通す | 行ごと**移す**ので、入れられない種類へ持っていくと元から消える |
   * | **外の file**(段④) | 🟢 通す | 添付を作って本文へ**書き足す** ── 追記そのものである |
   * | **一覧の行**(段②) | 🔴 **通さない** | 入るのは**リンクの 1 行の字**だけで、元は 1 つも動かない |
   *
   * 🔑 **判定を足すと、動線が 1 つ消える** ── フォルダ・添付・スタックの本文も
   *   **画面に出て、編集できる**(`detail.ts` は `attachment` と stack 以外に分岐を
   *   持たない)ので、いまは落とすと線が出て、実際に 1 行入る。
   *   ⚠ これを揃えるのは**こちら側の一貫性のため**であって、user のためではない
   *   (CLAUDE.md「判定は『誰のための削除か』1 つ」)。
   * ⚠ だから**種類を増やしたとき**も、ここへは足さない ── 足すべきは
   *   `APPENDABLE_ARCHETYPES`(`features/flavor/append-spec.ts`)の 1 か所だけである。
   */
  /**
   * 🔴 **一覧の行(どのノートでも)**(#684 段③)。
   *
   * ⚠ **`data-pkc-drop` では引けない** ── あれは「**ノートを入れる先**」の印なので
   *   **フォルダと入れ物にしか付いていない**(`filer.ts` / `dual-filer.ts`)。
   *   塊の持っていき先は**普通のノート**なので、そこだけを見ると
   *   **落とせる相手が 1 件も無い**(実ブラウザの smoke がそう落ちた)。
   * 🔑 だから行そのもの(`data-pkc-entry`)を引き、**一覧の表の中**に限る ──
   *   情報ペインのボタンなども `data-pkc-entry` を名乗るので、面で絞らないと
   *   別の物に当たる(CLAUDE.md §1「面へスコープする」)。
   */
  const blockRowTarget = (target: EventTarget | null): { el: HTMLElement; lid: string } | null => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-entry]');
    if (!el || !root.contains(el)) return null;
    /**
     * ⚠ 左の列の行は「フォルダ」(`filer-table`)/ 2 ペイン(`dual-table`)の**2 つ**が持つ。
     * 🔴 行を持つ器を 1 つ落とすと、**その面の user だけ無言で落とせない**
     *   (2026-09-09 の UX レビューが、「一覧」の器を落とした 1 稿目で実際に踏んだ)。
     */
    if (el.closest(ROW_HOST_SELECTOR) === null) return null;
    const lid = el.getAttribute('data-pkc-entry');
    if (lid === null || lid === '') return null;
    /**
     * ⚠ **印は行そのものへ**(着地前レビュー 💭-3)── 行の中の選択欄も `data-pkc-entry` を
     *   名乗るので、そのまま印を付けると**チェックボックスだけが光る**。
     */
    return { el: el.closest<HTMLElement>('tr, li') ?? el, lid };
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
     * 🔴 **アプリのタイルを落としたら、その順に並ぶ**(#857 段①)。
     * ⚠ どこへ入るかの規則は `planTileMove`(純関数)── ここは座標を渡すだけ。
     *   断る理由も reducer が声に出す(落とすまで phase を見ない)。
     */
    if (de.dataTransfer?.types?.includes(PKC_TILE_DRAG) === true) {
      const to = tileDropTargetOf(de);
      clearDropTarget();
      if (to === null) return;
      e.preventDefault();
      const lid = de.dataTransfer.getData(PKC_TILE_DRAG);
      // ⚠ 自分の手前 / 自分の直後は「動いていない」── 計画側が空を返す(ここでは弾かない)
      if (lid === '') return;
      dispatcher.dispatch({
        type: 'MOVE_APP_TILE',
        lid,
        target: { kind: 'edge', group: to.group, anchor: to.anchor, edge: to.edge },
      });
      return;
    }
    /**
     * 🔴 **本文の塊を落としたら、その塊が動く**(#684 段①)。
     * ⚠ 書くのは reducer(`MOVE_BLOCK`)→ `line-move.ts` ── ここは座標を渡すだけ。
     *   編集中の断りも reducer が声に出す(落とすまで phase を見ない)。
     * ⚠ 荷物の lid と落とし先の lid が違えば何もしない(dragover が受けていないので
     *   普段はここへ来ない ── 来ても別のノートを書かない)。
     */
    if (de.dataTransfer?.types?.includes(PKC_BLOCK_DRAG) === true) {
      const drop = bodyDropAt(de);
      const row = drop === null ? blockRowTarget(de.target) : null;
      clearDropTarget();
      if (drop === null && row === null) return;
      e.preventDefault();
      const [lid, rawStart, rawEnd] = (de.dataTransfer.getData(PKC_BLOCK_DRAG) || '').split(' ');
      const start = Number(rawStart);
      const end = Number(rawEnd);
      if (lid === undefined || !Number.isInteger(start) || !Number.isInteger(end)) return;
      /**
       * 🔴 **別のノートへ持っていく**(#684 段③)── 本文の上なら**落とした所**へ、
       *   一覧の行なら**そのノートの末尾**へ。
       * ⚠ 書くのは effect(`REQUEST_BLOCK_HANDOFF`)── **入れてから切る**ので、
       *   入らなかった回に元の本文が消えることはない。
       */
      const toLid = drop === null ? row!.lid : drop.lid;
      if (toLid !== lid) {
        if (!canPutIntoBody(toLid)) return;
        /**
         * 🔴 **別のタブ・窓が編集中のノートへは持っていかない**(#1087。追記と同じ門 = `editedElsewhereReason`)。
         * ⚠ 通すと、元からは既に切ってあるのに、行き先は編集中のタブの保存で上書きされ、
         *   塊が**両方の本文から消えて履歴にだけ残る**。元と先の**両方**を確かめる(元が編集中なら、
         *   切った結果が上書きされて塊が二重になる)。
         */
        const handoff = {
          type: 'HANDOFF_BLOCK',
          fromLid: lid,
          start,
          end,
          toLid,
          toBefore: drop === null ? null : drop.toBefore,
          ...(drop === null ? {} : { anchor: drop.anchor }),
        } as const;
        actUnlessEditedElsewhere(
          dispatcher,
          services,
          [toLid, lid],
          'ブロックを移せませんでした(別のタブの編集を確かめられませんでした)。もう一度ドラッグしてください',
          () => dispatcher.dispatch(handoff),
        );
        return;
      }
      if (drop === null) return;
      dispatcher.dispatch({ type: 'MOVE_BLOCK', lid, start, end, toBefore: drop.toBefore });
      return;
    }
    /**
     * 🔴 **落としたら、その行の日付が変わる**(双方向の出口。マウス = HTML5 drag)。
     * ⚠ 空文字の落とし先は「日付なし」= **外す**(消すのではない)。
     * 🔑 **判定は `dropTaskCard`(`schedule-drag.ts`)1 本**(#855 決1)── 指で
     *   掴む `installScheduleDrag` からも同じ関数を呼ぶ(CLAUDE.md §7「口を
     *   2 つ作らない」/「落とし先の判定は 1 本に保つ」)。
     */
    if (de.dataTransfer?.types?.includes(PKC_TASK_DRAG) === true) {
      const drop = dateTargetOf(de.target);
      clearDropTarget();
      if (drop === null) return;
      e.preventDefault();
      // 🔴 荷物を読むのは `decodeTaskDrag` 1 つ(掴んだ時点の行の中身も、ここで戻る。#1087)
      const grabbed = decodeTaskDrag(de.dataTransfer.getData(PKC_TASK_DRAG) || '');
      if (grabbed === null) return;
      dropTaskCard(dispatcher, grabbed, drop.date, root);
      return;
    }
    if (de.dataTransfer?.types?.includes(PKC_DRAG) === true) {
      // 🔴 行の上半分 / 下半分に落としたら**並べ替え**(#215)── 中へ入れるのではない
      const edge = reorderTargetOf(de);
      if (edge !== null) {
        clearDropTarget();
        e.preventDefault();
        const dragged = (de.dataTransfer.getData(PKC_DRAG) || '').split(' ').filter((x) => x !== '');
        reorderDropped(dragged, edge.row.getAttribute('data-pkc-entry') ?? '', edge.edge);
        return;
      }
      const drop = dropTargetOf(de.target);
      clearDropTarget();
      if (drop === undefined) {
        /**
         * 🔴 **本文へ落としたら、その行のリンクが入る**(#684 段②)。
         * ⚠ 字は `formatEntryLink` 1 本(手で書くリンクと同じ綴り)。複数の行は改行区切りの
         *   1 塊 ── 「元に戻す」は無いが、入った物は本文の 1 塊なので ⠿ で掴んで動かせる。
         * ⚠ 題名が無い(消えた)lid は入れない ── 押せない字を本文に残さない。
         * ⚠ 掴んだ側の印(一覧 / 2 ペインの選択)は触らない ── 移していないので外す理由が無い。
         */
        const at = bodyDropAt(de);
        if (at === null) return;
        e.preventDefault();
        const metas = dispatcher.getState().entryMetas;
        const lines = (de.dataTransfer.getData(PKC_DRAG) || '')
          .split(' ')
          .filter((x) => x !== '' && metas.has(x))
          .map((x) => formatEntryLink(metas.get(x)!.title, x));
        if (lines.length === 0) return;
        // 🔴 落とした所の目印を渡す(#1087)── 書く直前に disk 側と突き合わせ、別の窓が行を足していれば断る
        // 🔴 別のタブ・窓が編集中のノートへは入れない(#1087。追記と同じ門)── 断ると赤い字で理由が出る
        actUnlessEditedElsewhere(
          dispatcher,
          services,
          [at.lid],
          'リンクを入れられませんでした(別のタブの編集を確かめられませんでした)。もう一度ドロップしてください',
          () => dispatcher.dispatch({ type: 'INSERT_LINES', lid: at.lid, toBefore: at.toBefore, lines, anchor: at.anchor }),
        );
        return;
      }
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
        if (lids.length > 0) {
          const smartLid = drop.lid;
          // 🔴 実体は落としたノートへタグを付ける書込 ── 別のタブ・窓が編集中のノートが在れば撃たない(#1087)
          actUnlessEditedElsewhere(
            dispatcher,
            services,
            lids,
            'タグを付けられませんでした(別のタブの編集を確かめられませんでした)。もう一度ドロップしてください',
            () => {
              // 🔴 集め直しの結果を待って、集まらなかった分を言う(依頼 325 A)。購読は書く前に張る(結果が先に届いても取りこぼさない)
              watchSmartDrop(dispatcher, smartLid, lids);
              dispatcher.dispatch({ type: 'SMART_TAGS', smartLid, lids, mode: 'add' });
            },
          );
        }
        return;
      }
      const before = dispatcher.getState().relations;
      const from = dragFromSide;
      // 🔴 落とす前の行とカーソルを控える(#1087 D3)── 立て直しは F6 と同じ規則(消えた行が居た位置の行へ)
      const rowsBefore = from !== null ? dualPaneRows(dispatcher.getState(), from) : [];
      const cursorBefore = from !== null ? paneOf(dispatcher.getState().dual, from).cursor : null;
      moveDropped(lids, drop.lid);
      if (from !== null && dispatcher.getState().relations !== before) {
        dispatcher.dispatch({ type: 'DUAL_CLEAR_SELECTION', side: from });
        keepDualCursorAfter(dispatcher, from, rowsBefore, cursorBefore);
        carryDualFocus(from);
      }
      return;
    }
    /**
     * 🔴 **落とした所へ入れる**(#684 段④)── 読む面の本文の上なら、その塊の前 / 後。
     * ⚠ **印は必ず外す**(受けない回も)── 通ってから別の所で離すと
     *   「そこへ入った」と読む(段①②と同じ作法)。
     */
    const at = bodyDropAt(de);
    clearDropTarget();
    const files = filesOf(de.dataTransfer);
    if (files.length === 0) return;
    // ⚠ 受け手がいなくても止める(上の理由 ── 遷移で編集が飛ぶ)
    e.preventDefault();
    routeFiles(
      files,
      de.target,
      at === null || !canPutIntoBody(at.lid)
        ? undefined
        : { lid: at.lid, toBefore: at.toBefore, body: at.body, anchor: at.anchor },
    );
  };
  /**
   * 🔴 **掴んだものを運ぶ**(#240 段④)。
   * ⚠ 掴んだ行に**印が付いていれば印ごと**運ぶ(付いていなければその 1 件だけ)──
   *   「選んだつもりの物と動く物が違う」を作らない。
   */
  const onDragStart = (e: Event): void => {
    const de = e as DragEvent;
    /**
     * 🔴 **指で長押しを待っている行は、掴ませない**(#687 D-1)。
     * ⚠ 行は `draggable` なので、指で押さえている間にブラウザが drag を始めると、
     *   **印を足すつもりの指が行を運び出す**。⚠ Android の drag が 500ms より
     *   先に始まるかは実機でしか決まらない ── 先なら止まり、後なら drag が勝つ
     *   (そのときは印が付いた行を運ぶ形になる)。
     * ⚠ マウスは時計が掛からない(`pendingTouch` は指だけ)ので、これまでどおり掴める。
     */
    const pressedRow = (de.target as HTMLElement | null)?.closest<HTMLElement>(LONG_PRESS_ROW);
    if (pressedRow !== null && pressedRow !== undefined && longPress.pendingTouch(pressedRow)) {
      e.preventDefault();
      return;
    }
    /**
     * 🔴 **アプリのタイルを掴んだ**(#857 段①)── 荷物は `lid` 1 つ。
     * ⚠ `draggable` が付くのは**動かせるタイルだけ**(組み込みには付かない)なので、
     *   ここは「付いている物を運ぶ」だけでよい ── 種別の判定を 2 か所に置かない(§7)。
     */
    const tileEl = (de.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-pkc-tile][draggable="true"]',
    );
    if (tileEl !== null && tileEl !== undefined && de.dataTransfer) {
      /**
       * 🔴 **指で押さえている間は掴ませない**(#857 段①b-2)── 2 ペインの行と
       * **同じ門**(すぐ上)。⚠ 指で長押しを待っている最中に drag が始まると、
       * 並べ替えモードへ入るつもりの指が**タイルを運び出す**。
       */
      if (longPress.pendingTouch(tileEl)) {
        e.preventDefault();
        return;
      }
      const lid = tileEl.getAttribute('data-pkc-tile');
      if (lid === null || lid === '') {
        e.preventDefault(); // 指す物が無いタイルは掴ませない
        return;
      }
      blockDrag = null;
      dragFromSide = null;
      de.dataTransfer.setData(PKC_TILE_DRAG, lid);
      de.dataTransfer.effectAllowed = 'move';
      return;
    }
    /**
     * 🔴 **本文の塊の口(⠿)を掴んだ**(#684 段①)── 荷物は `lid start end`(生の body)。
     * ⚠ 範囲は口が原文で決めて載せている(`block-grip.ts`)── ここで数え直さない。
     * ⚠ `blockDrag` は dragover が「自分の中か」を見るために持つ(`getData` は dragover で
     *   読めない)。⚠ 掴むたびに決め直す(古い掴みを残さない ── `dragFromSide` と同じ)。
     * 🔑 drag 像は**塊そのもの**にする ── 口だけが飛ぶと、何を運んでいるか読めない。
     */
    const grip = (de.target as HTMLElement | null)?.closest<HTMLElement>(
      `[data-pkc-field="${BLOCK_GRIP_FIELD}"]`,
    );
    blockDrag = null;
    noteDragSubtrees = null;
    if (grip !== null && grip !== undefined && de.dataTransfer) {
      const lid = grip.getAttribute(BLOCK_LID_ATTR);
      const start = Number(grip.getAttribute(BLOCK_START_ATTR));
      const end = Number(grip.getAttribute(BLOCK_END_ATTR));
      if (lid === null || lid === '' || !Number.isInteger(start) || !Number.isInteger(end)) {
        e.preventDefault(); // 指す物が無い口は掴ませない(空の荷物でノートの行を運ぶ経路へ落とさない)
        return;
      }
      blockDrag = { lid, start, end };
      dragFromSide = null;
      de.dataTransfer.setData(PKC_BLOCK_DRAG, `${lid} ${String(start)} ${String(end)}`);
      de.dataTransfer.effectAllowed = 'move';
      const block = grippedBlock(grip);
      if (block !== null && typeof de.dataTransfer.setDragImage === 'function')
        de.dataTransfer.setDragImage(block, 0, 0);
      return;
    }
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
        // 🔴 掴んだ時点の行の中身(#1087)。⚠ 空白を含むので 5 つ目に URI 符号化して載せる(取れなければ空 = 落とす側で断る)
        const grabbedRaw = line === '' ? '' : (shownCardLine(dispatcher.getState(), lid, Number(line)) ?? '');
        de.dataTransfer.setData(
          PKC_TASK_DRAG,
          encodeTaskDrag({ lid, line, from, repeat: every, ...(grabbedRaw === '' ? {} : { rawLine: grabbedRaw }) }),
        );
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
    noteDragSubtrees = lids.map((l) => collectSubtreeLids(l, st.entryMetas, st.relations));
    /**
     * 🔴 **`copyMove`**(#684 段②。実ブラウザの smoke が拾った)。
     *
     * ⚠ 直す前は `'move'` だけだった。本文の上は「リンクを写す」なので `dropEffect = 'copy'`
     *   を返すが、HTML5 D&D は **`effectAllowed` に無い効果を返した drop を取り消す** ──
     *   Chromium は `dragover` を受けて線まで出しておきながら、**`drop` を 1 度も撃たなかった**
     *   (`dragend` だけ飛ぶ。unit の stub は効果の許しを検めないので緑だった)。
     * 🔑 フォルダへ落とす側は `move` のまま許されるので、これまでの動きは変わらない。
     */
    de.dataTransfer.effectAllowed = 'copyMove';
  };
  const onDragEnd = (): void => {
    // ⚠ **待っている面の切替も畳む**(#402 ③)── 離した後に面が変わると、
    //    user から見て「勝手に画面が動いた」になる
    cancelTabHover();
    clearDropTarget();
    blockDrag = null;
    noteDragSubtrees = null;
  };
  /**
   * 🔴 **窓の外へ抜けたら印を消す**(#684 段④、着地前レビュー C)。
   *
   * ⚠ **外から来た荷物には `dragend` が飛ばない**(掴んだ元が OS 側)── 段①② は
   *   ページの中で掴むので `onDragEnd` が拾っていたが、**外の file を線付きで受けるのは
   *   段④ が初めて**である。塊の上に線を出したまま窓の外で離す(または Esc で捨てる)と、
   *   **線が本文に残って消せない**(「そこへ入った」と読ませる)。
   * ⚠ `dragleave` は要素をまたぐたびに飛ぶので、**窓の外へ出た回だけ**畳む
   *   ── 判定は `relatedTarget`(次に入る要素。窓の外なら `null`)。
   */
  const onDragLeave = (e: Event): void => {
    const to = (e as DragEvent).relatedTarget;
    if (to === null || !root.contains(to as Node)) {
      cancelTabHover();
      clearDropTarget();
    }
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
  /**
   * 🔴 **本文の上の落とし先**(#684)── 乗せている塊の**上半分なら前、下半分なら後**。
   *
   * ⚠ 受ける器は**読む面の本文**(`detail-body` / `split-body`)だけ。
   *   添付の説明も `detail-body` を名乗るが、描けた印(`PAINTED_ATTR`)を持たないので外れる。
   *   板の面(`.pkc-board-host`)も外す ── 板は自分の掴みを持つ。
   * ⚠ 本文の下の地(面の余白)に落としたら**最後の塊の後**。塊の間の余白なら縦の位置で近い塊。
   * 🔑 「前 / 後」を原文の行へ写す規則は 1 つ:前 = その塊の開き行、後 = その塊の終わり + 1。
   *   ⚠ `:::` の塊の `-end` は開き行なので、終わりは `blockSpanAt` で取る(囲みの中へ入れない)。
   * 🔑 fence / `:::` の中・frontmatter へは受けない ── 判定は書く側と**同じ 1 本**
   *   (`insertionBlocked`)。
   *
   * @returns `null` = 本文の上ではない / 受けない所
   */
  const BODY_DROP_HOST = `${BODY_HOST_SELECTOR}, [data-pkc-field="split-body"]`;
  const bodyDropAt = (
    de: DragEvent,
  ): {
    host: HTMLElement;
    lid: string;
    el: HTMLElement;
    edge: 'before' | 'after';
    toBefore: number;
    /**
     * 🔴 いま読んだ本文(#684 段④)── 添付は**落としてから書くまで待つ**うえ、
     *   その間に画面の本文はいったん捨てられる(`DropCursor.body` の注記)。
     *   落とした時の本文をここで渡して、書く側はそれを基底にする。
     */
    body: string;
    /**
     * 🔴 **落とした塊の開き行**(行番号 + その字)── #684 段④。
     * ⚠ 待ってから書く経路(添付)は、行番号だけでは**段落の途中へ刺さる**
     *   ── 書く直前に disk 側で突き合わせる目印である。
     */
    anchor: { line: number; text: string };
  } | null => {
    const target = de.target as HTMLElement | null;
    if (target === null || !root.contains(target)) return null;
    let host = target.closest<HTMLElement>(BODY_DROP_HOST);
    let ground = false;
    if (host === null) {
      /**
       * 面の地 ── その面の本文の器の外なら、**最後の塊の後**として受ける。
       *
       * 🔴 **上も受ける**(#809-1、2026-09-09。user 推薦 A)。
       * ⚠ 直す前は `de.clientY < host.bottom` で**器より上を捨てて**いた ──
       *   つまり留めた枠の**題名**(「さきの予定」)や `← 左で開く` の帯へ落とすと
       *   線が出ず、写真は**中央のノートのいちばん下**へ入った。
       * 🔴 **枠 1 つの中で、数 px 上か下かで行き先のノートが変わる**のに、
       *   外したことが画面に 1 ドットも出ない ── いちばん気づけない外し方である。
       * 🔑 だから**その枠のどこへ落としても、その枠のノートへ入れる**
       *   (狙った枠に入るのが、覚え直しがいちばん少ない)。
       */
      const pane = target.closest<HTMLElement>(
        '[data-pkc-region="split-frame"], [data-pkc-view-pane="detail"]',
      );
      host = pane?.querySelector<HTMLElement>(BODY_DROP_HOST) ?? null;
      if (host === null) return null;
      ground = true;
    }
    if (!host.hasAttribute(PAINTED_ATTR) || host.classList.contains('pkc-board-host')) return null;
    const st = dispatcher.getState();
    const lid = lidOfNode(host, st.openBody?.lid ?? st.selectedLid);
    const body = lid === null ? null : screenBodyOf(st, lid);
    if (lid === null || body === null) return null;
    const blocks = [...host.children].filter(
      (c): c is HTMLElement => c instanceof HTMLElement && !c.hidden && c.hasAttribute('data-pkc-source-line'),
    );
    if (blocks.length === 0) return null;
    let el: HTMLElement;
    let edge: 'before' | 'after' = 'after';
    if (ground) {
      el = blocks[blocks.length - 1]!;
    } else if (target === host) {
      // 塊の間の余白 ── 縦の位置で最初に「下端がまだ下」の塊を採る。無ければ最後の塊の後
      el = blocks.find((b) => de.clientY < b.getBoundingClientRect().bottom) ?? blocks[blocks.length - 1]!;
      const r = el.getBoundingClientRect();
      edge = de.clientY < r.top + r.height / 2 ? 'before' : 'after';
    } else {
      let cur: Element | null = target;
      while (cur !== null && cur.parentElement !== host) cur = cur.parentElement;
      if (!(cur instanceof HTMLElement) || !blocks.includes(cur)) return null;
      el = cur;
      const r = el.getBoundingClientRect();
      edge = de.clientY < r.top + r.height / 2 ? 'before' : 'after';
    }
    const line = Number(el.getAttribute('data-pkc-source-line'));
    if (!Number.isInteger(line) || line < 0) return null;
    const fm = frontmatterLineCount(body);
    let toBefore = line;
    if (edge === 'after') {
      const span = blockSpanAt(bodyBelowFrontmatter(body), line);
      const end = span !== null ? span.end : Number(el.getAttribute('data-pkc-source-end'));
      toBefore = (Number.isInteger(end) && end >= line ? end : line) + 1;
    }
    toBefore += fm;
    if (insertionBlocked(body, toBefore)) return null;
    const rows = body.split('\n');
    const anchorLine = line + fm;
    const text = rows[anchorLine];
    if (text === undefined) return null;
    return { host, lid, el, edge, toBefore, body, anchor: { line: anchorLine, text } };
  };
  /** 掴んでいる本文の塊(`dragstart` で決め、`dragend` で捨てる)。`null` = 塊は掴んでいない。 */
  let blockDrag: { lid: string; start: number; end: number } | null = null;
  /**
   * 掴んでいるノート / フォルダごとの「自分と配下ぜんぶ」(`dragstart` で決め、`dragend` で捨てる)。
   * ⚠ `getData` は dragover で読めない(ブラウザの保護)── 「自分の中へ」を光らせないために持つ。
   * `null` = ノートは掴んでいない。
   */
  let noteDragSubtrees: ReadonlySet<string>[] | null = null;
  /**
   * 落とし先の印。⚠ **属性名と値まで**持つ(#684)── 塊の前 / 後は同じ要素に別の値で出る
   * (`data-pkc-drop-edge="before"|"after"`)ので、要素だけ見て早期 return すると
   * 上半分から下半分へ動いても線が動かない。関数は 1 組のまま(2 つ目を書かない)。
   */
  let dropMark: { el: HTMLElement; attr: string; value: string } | null = null;
  const markDropTarget = (el: HTMLElement, attr = 'data-pkc-dropping', value = ''): void => {
    if (dropMark !== null && dropMark.el === el && dropMark.attr === attr && dropMark.value === value)
      return;
    clearDropTarget();
    dropMark = { el, attr, value };
    el.setAttribute(attr, value);
  };
  /**
   * 並べ替えの落とし先の印(#215)。⚠ 属性名 `data-pkc-drop-edge` は本文の D&D(#684)と
   * 同じ綴りを使う。
   *
   * ⚠ **2026-09-12 に訂正** ── ここには「CSS の規則はフォルダの表の行に限ってある」と
   *   書いてあったが、`app.css` には **総称の `[data-pkc-drop-edge]`** が在り、
   *   どの要素にも線が出る(`filer-table` の `tr`→`td` は、`tr` に `box-shadow` が
   *   描かれないための**迂回**であって、限定ではない)。
   *   🔑 実測:アプリのタイル(`<button>`)には**そのまま線が出る**(実ブラウザで確認)。
   */
  let edgeMark: HTMLElement | null = null;
  const markDropEdge = (el: HTMLElement, edge: 'before' | 'after'): void => {
    if (edgeMark === el && el.getAttribute('data-pkc-drop-edge') === edge) return;
    clearDropTarget();
    edgeMark = el;
    el.setAttribute('data-pkc-drop-edge', edge);
  };
  // ⚠ 消すのは 1 本 ── 中へ入れる印と並べ替えの印を**別々に消し忘れない**
  const clearDropTarget = (): void => {
    dropMark?.el.removeAttribute(dropMark.attr);
    dropMark = null;
    edgeMark?.removeAttribute('data-pkc-drop-edge');
    edgeMark = null;
  };
  /**
   * 🔴 **並べ替えの落とし先**(#215)── フォルダの表の行の**上半分 / 下半分**。
   *
   * ⚠ フォルダ(とスマートフォルダ)の行は真ん中の帯(25〜75%)を「中へ入れる」に残す ──
   *   端だけを並べ替えにする。ノートの行は上下 2 分。
   * ⚠ 器の高さが測れない環境(happy-dom の素の要素)では `null` ── 「並べ替えの
   *   つもりで中へ入れた」を作らない側へ倒す。
   * 🔑 `dragover` と `drop` が**同じ関数**で判定する(光った所と落ちる所が食い違わない)。
   */
  const reorderTargetOf = (de: DragEvent): { row: HTMLElement; edge: 'before' | 'after' } | null => {
    const row = (de.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-pkc-region="filer-table"] tbody [data-pkc-entry]',
    );
    if (!row || !root.contains(row)) return null;
    /**
     * 🔴 **「中まで全部出す」の間は、行の上下端を並べ替えにしない**(#813 段②)。
     * ⚠ 並べ替えは**同じフォルダの中の兄弟**だけが対象(`reorderDropped`)── 階層を
     *   またいだ平らな並びで端へ落としても、動くのは別のフォルダの物ばかりで
     *   「並べ替えられるのは同じフォルダの中だけ」と断られる(光るのに効かない線)。
     * 🔑 `null` を返せば、フォルダの行は**行全体が「中へ入れる」**、ノートの行は落とせない
     *   ── 掴んでフォルダへ移す道(と、パンくずへ落として出す道)は今までどおり効く。
     */
    if (filerFlattenNow(dispatcher.getState())) return null;
    /**
     * 🔴 **並べ替えは「自分で並べた順」のときだけ**(#1087)。題名順などでは落とした後に断られる
     *   (`reorderDropped`)のに、線が光って受けていた ── 光る所と効く所を揃える。
     * 🔑 `null` なら、フォルダの行は行全体が「中へ入れる」のまま効く(移す道は残る)。
     */
    if (dispatcher.getState().entrySort !== 'manual') return null;
    const r = row.getBoundingClientRect();
    if (!(r.height > 0)) return null;
    const y = (de.clientY - r.top) / r.height;
    if (row.hasAttribute('data-pkc-drop') && y >= 0.25 && y <= 0.75) return null;
    return { row, edge: y < 0.5 ? 'before' : 'after' };
  };
  /**
   * 🔴 **アプリのタイルの落とし先**(#857 段①)── 群と「どのタイルの手前か」。
   *
   * 🔑 規則はフォルダの行と**同じ形**(要素の上半分 / 下半分)だが、
   *   ⚠ **`reorderTargetOf` は使い回せない** ── あちらは行き先を
   *   `[data-pkc-region="filer-table"] tbody` に固定しており、器も意味も違う
   *   (あちらは「兄弟の間」、こちらは「**群の中**」で、群は落とす先にもなる)。
   * ⚠ 器の高さが測れない環境(happy-dom の素の要素)は **そのタイルの手前**へ倒す
   *   ── タイルの上に居るのに「落ちない」を作らない。
   *   ⚠ **2026-09-12 に訂正**:1 稿目はここに「群の末尾へ倒す」と書いてあったが、
   *   実際は `edge` が `'before'` になるので**手前**である(倒す向きが真逆だった)。
   * 🔑 `dragover` と `drop` が**同じ関数**で判定する(光った所と落ちる所が割れない)。
   */
  const tileDropTargetOf = (
    de: DragEvent,
  ): { group: string; anchor: string; mark: HTMLElement; edge: 'before' | 'after' } | null => {
    const t = de.target as HTMLElement | null;
    const tile = t?.closest<HTMLElement>('[data-pkc-tile][draggable="true"]');
    if (!tile || !root.contains(tile)) return null;
    /**
     * ⚠ **受けるのはタイルの上だけ**(動線レビュー D9、2026-09-12 に直した)。
     * 1 稿目は「群の器の余白は末尾」という枝を持っていたが、⚠ **その余白は 0px** ──
     * 器は `flex-direction: column` で `padding` も `gap` も持たず、タイルが
     * **隙間なく埋めている**ので、この枝は**一度も通らない**(しかも枠を光らせる
     * CSS も無かった = 通っても何も出ない)。
     * 🔑 **末尾はいちばん下のタイルの下半分**で表せる(下を見よ)ので、枝は要らない。
     */
    const grid = tile.closest<HTMLElement>('[data-pkc-tile-group]');
    if (!grid) return null;
    const group = grid.getAttribute('data-pkc-tile-group') ?? '';
    const r = tile.getBoundingClientRect();
    const edge: 'before' | 'after' = r.height > 0 && de.clientY - r.top > r.height / 2 ? 'after' : 'before';
    const lid = tile.getAttribute('data-pkc-tile');
    if (lid === null || lid === '') return null;
    /**
     * 🔑 **見たものをそのまま渡す** ── 「この下へ」を*次の兄弟の手前*へ読み替えない。
     * ⚠ 1 稿目はそれをやっていたので、**画面の順**(絞り込みで間が抜ける)と
     *   **`sortTiles` の順**という 2 つの真実ができていた(§7)。
     */
    return { group, anchor: lid, mark: tile, edge };
  };
  /**
   * 落としたものを動かす。⚠ **断る理由を出す**(無言の操作拒否を作らない)──
   * フォルダを自分の子孫へ落とす等、reducer が黙って捨てる形が在る。
   */
  const moveDropped = (lids: readonly string[], parentLid: string | null): void =>
    void moveEntriesOfferingUndo(dispatcher, lids, parentLid, services.showStatus);
  /**
   * 🔴 **落とした行の前 / 後へ並べ替える**(#215)。
   *
   * 🔑 規則は既存の `MOVE_ENTRY_ORDER`(隣と入れ替える)を**着くまで撃つ** ── 並びの
   *   規則(`reorderSibling` / `entryOrder` の交換)を 2 本にしない。1 段ごとに state を
   *   読み直すので、同値の `entryOrder` でも着く(端で動かなければ抜ける)。
   * ⚠ 動かせるのは**同じフォルダの中の行だけ**(帯の上へ / 下へと同じ規則)── 別の
   *   フォルダの物が混じっていたら、その件数を言う(黙って捨てない)。
   * ⚠ 「手動の順」で並べているときだけ ── 題名順などで見ているときに `entryOrder` を
   *   動かしても**画面は 1 ドットも変わらない**(押したのに何も起きない、を作らない)。
   * ⚠ 複数を落としたら**元の並びのまま**入れる ── 前へなら見えている順に 1 件ずつ
   *   行き先の直前へ、後ろへなら逆順に直後へ。
   */
  const reorderDropped = (
    lids: readonly string[],
    targetLid: string,
    edge: 'before' | 'after',
  ): void => {
    const st = dispatcher.getState();
    if (st.phase !== 'ready') {
      dispatcher.dispatch({ type: 'OP_FAILED', error: `${phaseBlockReason(st.phase)}並べ替えてください` });
      return;
    }
    if (st.entrySort !== 'manual') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '並べ替えは「自分で並べた順」のときだけ効きます(探す欄の隣の「一覧の並び順」を「自分で並べた順」にしてください)',
      });
      return;
    }
    const siblings = listSiblings(targetLid, st.entryMetas, st.relations).map((m) => m.lid);
    const movable = siblings.filter((l) => l !== targetLid && lids.includes(l));
    if (movable.length === 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error:
          '並べ替えられるのは同じフォルダの中の行だけです(別のフォルダへ動かすなら、フォルダの行の真ん中へドロップしてください)',
      });
      return;
    }
    const seq = edge === 'before' ? movable : [...movable].reverse();
    // 🔴 動いた件だけ数える(もう収まっている物を「並べ替えました」と言わない)
    let moved = 0;
    for (const lid of seq) if (stepTo(lid, targetLid, edge)) moved += 1;
    const skipped = lids.filter((l) => l !== targetLid && !movable.includes(l)).length;
    if (skipped > 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `${skipped} 件は別のフォルダの物なので並べ替えていません`,
      });
    }
    if (moved > 0) services.showStatus?.(`${moved} 件を並べ替えました`);
  };
  /** 1 件を `targetLid` の直前 / 直後まで、隣との入れ替えで運ぶ。 */
  const stepTo = (lid: string, targetLid: string, edge: 'before' | 'after'): boolean => {
    let moved = false;
    // ⚠ 上限は兄弟の数 ── 端で動かなくなった回は state が変わらないので抜ける
    for (let guard = 0; guard < 100000; guard += 1) {
      const now = dispatcher.getState();
      const sib = listSiblings(lid, now.entryMetas, now.relations).map((m) => m.lid);
      const i = sib.indexOf(lid);
      const j = sib.indexOf(targetLid);
      if (i < 0 || j < 0) return moved;
      const want = edge === 'before' ? (i < j ? j - 1 : j) : i < j ? j : j + 1;
      if (i === want) return moved;
      dispatcher.dispatch({ type: 'MOVE_ENTRY_ORDER', lid, direction: i < want ? 'down' : 'up' });
      if (dispatcher.getState().entryMetas === now.entryMetas) return moved;
      moved = true;
    }
    return moved;
  };
  /**
   * 🔴 **フォルダは 2 クリックで開き、ノートは 2 クリックで別のウィンドウへ**
   * (フォルダ: #240 段①。user 指示 2026-08-17「フォルダをダブルクリックで開くように
   * 変更」。ノート: #1042 C14。裁定 2026-09-25 Q5 = A「入れる」)。
   *
   * ⚠ **ネイティブの `dblclick` に頼らない。** ブラウザは「同じ node を 2 回」
   * 押したときにしか `dblclick` を出さないので、**2 回のクリックの間に行が
   * 作り直されると出ない** ── この面は保存の ack や別タブの更新で表を組み直すので、
   * 実 user も「開かない」を踏む(実ブラウザ smoke で実際に落ちた)。
   * 🔑 だから**同じ lid への連続押し**で見る ── node が入れ替わっても lid は同じ。
   * ⚠ 1 クリック目(= 選ぶ)は `onClick` が撃っている。ここは**現在地だけ**動かす。
   *
   * 🔑 **フォルダ表 / 2 ペインは判定が 1 か所**(この関数)── フォルダ
   * (スマートフォルダ含む)なら「中へ入る」、それ以外(ノート)は
   * `open-note-window` と同じ経路で別のウィンドウ(付箋)を開く。
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
  const maybeDoubleOpen = (lid: string, dual: DualSide | null = null): void => {
    const key = `${dual ?? 'filer'}:${lid}`;
    const now = Date.now();
    const again = lastRowClick.key === key && now - lastRowClick.at <= DOUBLE_MS;
    lastRowClick = { key, at: now };
    if (!again) return;
    lastRowClick = { key: '', at: 0 }; // 3 回目を「もう一度」と数えない
    // 🔑 「中へ入れるか」の判定は `canEnterScope` 1 か所(スマートフォルダも入れる)
    if (canEnterScope(dispatcher.getState().entryMetas.get(lid)?.archetype)) {
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
      return;
    }
    /**
     * 🔴 **フォルダでなければ、別のウィンドウ(付箋)で開く**(#1042 C14)。
     * ⚠ `open-note-window` の受け手(`services.openNoteWindow`)と**同じ経路**を
     *   そのまま呼ぶ ── ポップアップ遮断時の代替・同じノートの 2 枚目を作らない
     *   判定は、そちら 1 本に既に在る(2 つ目の「窓を開く作法」を作らない。CLAUDE.md
     *   §10「置き換えの作法」)。⚠ **同期に呼ぶ** ── `window.open` は gesture の
     *   中でしか通らない。
     */
    services.openNoteWindow?.(lid, leftFilterFind(dispatcher.getState().filterQuery));
  };
  /**
   * 🔴 **右クリックで、その行にできることを出す**(#426 段①)。
   *
   * ## ⚠ 先に**選んでから**出す(これを外すと別のノートを消す)
   *
   * `delete-entry` などは「押した行」ではなく **`state` が持つ選んでいるノート**に
   * 効く(`binder.ts` の handler は `target` から lid を読まない)。
   * 🔴 だから**右クリックした行を先に選ぶ**。⚠ そして
   * **選べなかったら行の操作は出さない** ── 出すと
   * **さっきまで選んでいた別のノートに効く**(編集中は選択が断られるので、
   * これは実際に起きる)。
   * 🔑 断る判定と理由は `selectEntryOrExplain` **1 か所**が持っている ──
   *   ここで書き写さない(§7)。理由は既に画面へ出ているので、黙って閉じてよい。
   *
   * ## ⚠ ブラウザ既定を奪う場面を最小にする(CLAUDE.md §10)
   *
   * **選択範囲 / リンク / 図**の上では**奪わない** ── そこで既定を消すと
   * 「コピー」「画像を保存」が**代わりも無いまま消える**。
   */
  const onContextMenu = (ev: MouseEvent): void => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    /**
     * 🔴 **長押し中 / 直後の行では、メニューを出さない**(#687 D-1)。
     * ⚠ Android は長押しで `contextmenu` を撃つ ── 既定を残すと **OS のメニュー**が、
     *   下へ流すと**この面のメニュー**が、足したばかりの印の上に重なる。
     *   長押しの意味は「印を足す」1 つにする(2 つ同時に起きる操作を作らない)。
     * ⚠ マウスの右クリックは `pointerType === 'mouse'` なので時計が掛からず、
     *   ここは通らない(これまでどおりメニューが出る)。
     */
    const pressed = target.closest(LONG_PRESS_TARGETS);
    if (pressed !== null && longPress.holds(pressed)) {
      ev.preventDefault();
      return;
    }
    // 🔴 指で長押しした予定の札は、ドラッグだけにする(メニューは札の「⋯」から)── 依頼 128-2 A
    if (suppressTouchTaskMenu(ev, target)) {
      ev.preventDefault();
      return;
    }

    /**
     * ⚠ 既定を残す場面 ── ここで返すと、ブラウザのメニューがそのまま出る。
     *
     * 🔴 **いまこの 1 行は、実は何も止めていない**(2026-08-27、変異試験 N2 が
     *   SURVIVED で教えた)── 段① が出すのは**行の上だけ**で、本文のリンクや図は
     *   `[data-pkc-entry]` の外なので、**下の行の判定がどのみち返す**。
     * ⚠ だから「これが無いと既定を奪う」とは**書かない**
     *   (CLAUDE.md「これが無いと壊れる、と書く前に外して壊れるのを見る」)。
     * 🔑 **残してあるのは段②のため** ── 押した物ごとにメニューを出すようになると、
     *   本文の上でも受けることになり、**そのとき初めてこの門が効く**。
     *   ⚠ 消すと、段② を書く人が**同じ穴を作り直す**(「コピー」「画像を保存」が
     *   代わりも無いまま消える)。
     */
    /**
     * 🔴 **本文の添付の画像だけは、大きさ・寄せのために受ける**(#1640 ③)。
     * ⚠ リンクの中の画像・原文の行が引けない画像・編集中の欄は今までどおりブラウザ既定のまま(「画像を保存」を奪わない)。
     */
    const imageEl = target.closest('img.pkc-asset-ref[data-pkc-asset-key]');
    const imageOb = dispatcher.getState().openBody;
    const imageHit =
      imageEl !== null &&
      imageEl.closest('a[href]') === null &&
      imageEl.closest('[data-pkc-field="detail-body"]') !== null
        ? imageAt(imageEl, imageOb?.body ?? null)
        : null;
    if (target.closest('a[href], img, input, textarea, [contenteditable="true"]') !== null && imageHit === null) return;
    const sel = root.ownerDocument.getSelection();
    if (sel !== null && !sel.isCollapsed && sel.rangeCount > 0) {
      // ⚠ **選択範囲の中で押したときだけ**残す(別の場所の選択は関係ない)
      const range = sel.getRangeAt(0);
      if (range.intersectsNode(target)) return;
    }

    /**
     * 🔴 **アプリのタイルの上で右クリック**(#857 段①)── 「上へ / 下へ」。
     *
     * ⚠ **行の一覧を出さない** ── タイルは `data-pkc-entry` を持たないので
     *   下の判定には当たらないが、当たっていたら「削除」が出て**添付ごと消える**
     *   所だった(押した物と効く先が食い違う ── #677 と同じ型)。
     * 🔑 身元は `carry` でボタン自身へ写す ── メニューの器は root の直下に出るので、
     *   押したボタンは**タイルの中に居ない**(`context-menu.ts` の戒め)。
     */
    /**
     * 🔴 **グループの見出しの上で右クリック**(#857 段②)── 「目印を選ぶ…」。
     *
     * ⚠ **タイルのメニューを出さない** ── 押した物(見出し)と効く先(その群)が
     *   違うので、「上へ / 下へ」が混ざると押した物と効く先が食い違う(#677 の型)。
     * 🔑 身元(群の名前)は `carry` でボタン自身へ写す ── メニューの器は root の
     *   直下に出るので、押したボタンは**見出しの中に居ない**(`context-menu.ts` の戒め)。
     * ⚠ **絞り込み中は見出しが押し所ではない**(段④ の仕上げ)ので、この枝も
     *   自然に当たらない ── 出す条件を 2 か所に書かない。
     */
    const groupHit = target.closest('[data-pkc-action="toggle-app-group"]');
    if (groupHit !== null) {
      const groupName = groupHit.getAttribute('data-pkc-group') ?? '';
      if (groupName !== '') {
        ev.preventDefault();
        openContextMenu(
          root,
          { x: ev.clientX, y: ev.clientY },
          appGroupMenuActions(hasAppGroupOrder(dispatcher.getState())),
          root.ownerDocument.activeElement,
          { 'data-pkc-group': groupName },
        );
        return;
      }
    }

    /**
     * 🔴 **タイルかどうかは `draggable` で決めない**(#1087)。左の絞り込み中は掴ませない(`draggable` を付けない)ので、
     *   `draggable` で探すと**絞り込み中だけブラウザの右クリックが出た**。開き方の 2 項目は絞り込みに関係なく出し、
     *   並べ替えの項目は掴めるとき(= 絞り込み中でない)だけ足す。
     */
    const tileHit = target.closest('[data-pkc-tile][data-pkc-tile-kind]');
    const tileKind = tileHit?.getAttribute('data-pkc-tile-kind') ?? '';
    if (tileHit !== null && ![...BUILTIN_KINDS].some((k) => k === tileKind)) {
      const tileLid = tileHit.getAttribute('data-pkc-tile') ?? '';
      if (tileLid !== '') {
        ev.preventDefault();
        openContextMenu(
          root,
          { x: ev.clientX, y: ev.clientY },
          // ⚠ 出口も同じメニューに置く(#857 段①b-2)── 入口だけ作らない
          // 🔴 その 1 回だけの開き方(#884 段②)── いまの設定を先頭 2 項目に足す
          tileHit.getAttribute('draggable') === 'true'
            ? tileMenuActions(dispatcher.getState().launcherReorder, currentAppOpenTarget())
            : tileOpenTargetMenuActions(currentAppOpenTarget()),
          root.ownerDocument.activeElement,
          { 'data-pkc-tile': tileLid },
        );
        return;
      }
    }

    /**
     * 🔴 **組み込みアプリのタイルの右クリック**(依頼 69-B4)── 出すのは「開き方」の 2 項目だけ。
     * ⚠ 組み込みは並べ替えられない(掴めない)ので、並べ替えの項目は出さない(勧めてから断らない)。
     * ⚠ 出すのは**開き方が効くタイルだけ**(別窓で開く面のタイル = `isViewMode`)。マニュアル・Office・
     *   「自分のパソコンで動かす」は開き方を持たない(窓の作りが固定 / zip を落とすだけ)ので、
     *   押しても何も変わらない選択肢を置かない。
     * ⚠ 印は「ブラウザのタブ」に付ける ── 組み込みの面は設定の開き方に従わず、ふだんはいつもタブで開く。
     */
    const builtinHit = target.closest('[data-pkc-tile][data-pkc-tile-kind]:not([draggable="true"])');
    if (builtinHit !== null) {
      const tileLid = builtinHit.getAttribute('data-pkc-tile') ?? '';
      const kind = builtinHit.getAttribute('data-pkc-tile-kind') ?? '';
      if (tileLid !== '' && isViewMode(kind)) {
        ev.preventDefault();
        openContextMenu(
          root,
          { x: ev.clientX, y: ev.clientY },
          tileOpenTargetMenuActions('tab'),
          root.ownerDocument.activeElement,
          { 'data-pkc-tile': tileLid },
        );
        return;
      }
    }

    /**
     * 🔴 **板どうしを繋ぐ線の上で右クリック**(#530 段③d)── 「この線を消す」。
     *
     * ⚠ 掴んで繋げる(`place-connect.ts`)なら、**画面から外せなければならない**(片道にしない)。
     *   本文を開いて `:::format{.pkc-line …}` を探す道しか無いと、間違えて引いた線が戻せない。
     * 🔑 押さえるのは**線の道の上だけ**(`place-line-hits` の太い透明の線)── 板の外の普通の本文は
     *   これまでどおり本文のメニューになる。⚠ **主の枠の本文だけ**(留めた枠の線は別のノートの行を
     *   指すので、板のメニューと同じく受けない)。
     * 🔑 行は線の層が焼いた `data-pkc-line-decl`(生の body 基準)から**frontmatter ぶんを引いて**
     *   運ぶ(受け手 `remove-place-line` が足し戻す ── `remove-place` と同じ座標系)。
     */
    const lineHit = target.closest<Element>('[data-pkc-field="place-line-hits"] path');
    const lineBody = lineHit?.closest('[data-pkc-field="detail-body"]') ?? null;
    const lineOb = dispatcher.getState().openBody;
    if (lineHit !== null && lineBody !== null && lineOb !== null) {
      const decl = Number(lineHit.getAttribute('data-pkc-line-decl'));
      const rel = decl - frontmatterLineCount(lineOb.body);
      if (Number.isInteger(decl) && rel >= 0) {
        ev.preventDefault();
        // 🔑 色・太さの項目は**線の開き行そのもの**から決める(いまの太さと同じ物を出さない)
        const lineStyle = placeStyleAt(lineOb.body.split('\n')[decl] ?? '');
        openContextMenu(
          root,
          { x: ev.clientX, y: ev.clientY },
          placeLineMenuActions({
            stroke: lineStyle?.written.stroke === true,
            width: lineStyle?.width ?? null,
            widthWritten: lineStyle?.written.width === true,
            arrow: lineStyle?.arrow ?? 'none',
          }),
          root.ownerDocument.activeElement,
          { [MENU_LID_ATTR]: lineOb.lid, [MENU_BLOCK_ATTR]: String(rel) },
        );
        return;
      }
    }

    /**
     * 🔴 **読む本文の中の `[data-pkc-entry]` は「行」ではない**(#677)。
     *
     * ⚠ 板の題名札(`place-board.ts` の `ensureCard`)は `select-entry` のために lid を
     *   持っている。ここで行と読むと `selectEntryOrExplain` が**そのノートへ切り替えて**
     *   板が消え、出るのは**別ノートの行メニュー**になる(押した物と効く先が食い違う)。
     * 🔑 読む本文の中の物は下の本文の枝で受ける(板の上なら「この付箋をコピー」が出る)。
     */
    const hit = target.closest('[data-pkc-entry]');
    const row = hit !== null && hit.closest('[data-pkc-field="detail-body"]') !== null ? null : hit;
    const lid = row?.getAttribute('data-pkc-entry') ?? null;
    if (row === null || lid === null || lid === '') {
      /**
       * 🔴 **本文の上でも受ける**(#426 段② / #522)。
       *
       * ⚠ 段① は**行の上だけ**だったので、本文を右クリックしても何も出なかった。
       *   user 指示 2026-08-28(#522)は「段組の切替を**コンテキストメニュー**に
       *   用意したい」なので、**読んでいる面**で受ける。
       *
       * 🔑 **出す物は行と別の一覧**(`BODY_MENU_ACTIONS`)── 行を押したのは
       *   「このノートに何かする」、本文を押したのは「**いま読んでいる見え方を
       *   変える**」である。行の一覧をそのまま出すと、押した物と効く先が食い違う。
       *
       * 🔴 **「読んでいる本文」に限る**(実物の DOM を読んで直した)。
       * ⚠ `[data-pkc-region="detail"]` は**中央の器**であって、その中には
       *   設定 / フラグ / ヘルプ / 集計 / 2 ペインの面も**同居している**
       *   (`center.ts` の `pane()` が `data-pkc-view-pane` で並べる)。
       *   面で切ると、**設定画面を右クリックしても段組みのメニューが出る**。
       * 🔑 だから見るのは**本文そのもの**(`detail-body`)── そこに書かれた字を
       *   読んでいる人にだけ、読み方を変える口を出す。
       * ⚠ 地の上・他の面ではこれまでどおり出さない(奪って何も出さない場所を増やさない)。
       *
       * ⚠ **ライブエディタ(`editor-live`)には出さない** ── そこも段組みは
       *   効く(`columnScroller` が両方を見る)が、あそこは **contenteditable** なので、
       *   奪うと**綴りの候補・切り取り・貼り付け**が消える(CLAUDE.md §10)。
       *   🔑 編集中の近道は `Alt+C` が持っている ── **代わりが在るので奪わない**。
       * ⚠ **編集中は出ない** ── そのとき本文は `textarea` で、上の除外が当たる。
       * ⚠ リンク・図・選択範囲も同じく上の除外が当たる ── 段① が置いた門は、
       *   **ここで初めて効き始める**(段① の test がそう予告している)。
       */
      if (target.closest('[data-pkc-field="detail-body"]') === null) return;
      ev.preventDefault();
      /**
       * 🔴 **外部の画像は、ここでだけ数えられる**(#500 案 C)。
       *
       * ⚠ `detail-body` に描かれているのは `openBody`(主の枠)である ──
       *   横に留めた枠は `split-body` なので、ここには当たらない。
       * 🔑 だから枚数は `openBody` から数えてよい。⚠ 数え方は情報ペインと
       *   **同じ関数**(`externalImageUrls`)を使う ── 別の規則を書くと、
       *   「右ペインには出るのにメニューには出ない」が静かに生まれる(§7)。
       */
      const ob = dispatcher.getState().openBody;
      /**
       * 🔴 **見出し・本文の項目に近道の字を添える**(#587 改善 C 案 2)。
       * 🔑 何を添えるかは `menuShortcutFor` 1 か所 ── ここは mac かどうかと、
       *   **いまの割当**(`appKeymap`)を渡すだけ(user が割当を変えれば字も変わる)。
       */
      const withShortcut = <T extends { readonly action: string }>(
        a: T,
      ): T & { readonly shortcut: string } => ({
        ...a,
        shortcut: menuShortcutFor(a.action, { mac: isMac(), chord: (id) => chordHint(id, appKeymap) }),
      });
      const body = bodyMenuActions({
        externalImages: ob ? externalImageUrls(ob.body).length : 0,
      }).map(withShortcut);
      /**
       * 🔴 **見出しの上なら、見出しの 3 つを頭へ足す**(#426 段② の残り)。
       *
       * ⚠ **差し替えない** ── 見出しは本文の中に在るので、いまも本文のメニューが
       *   出ている。差し替えると**見出しの上でだけ段組みを切り替えられなくなる**
       *   (在る動線を 1 つ失う)。
       * 🔑 行は `bodySourceLineAt` **1 本**で引く ── `Ctrl` / `Alt` の近道と
       *   同じ関数なので、「近道では入れるのにメニューからは入れない」が生まれない。
       * ⚠ 見出しが `host` の直下でないときは足さない ── 畳みの計算(`foldSpans`)が
       *   直下の塊だけを数えているので、拾っても**押して何も起きない**。
       */
      const host = target.closest<HTMLElement>('[data-pkc-field="detail-body"]');
      const heading = target.closest('h1,h2,h3,h4,h5,h6');
      /**
       * 🔴 **行は「押した所」ではなく「見出し」から引く**(着地前レビュー ⚠4)。
       *
       * ⚠ 実物の見出しの**先頭ピクセルは畳みのボタン**である(`applyHeadingFold` が
       *   描画のたびに `prepend` する)。押した所から引くと `OWN_MEANING` に当たって
       *   `null` になり、**帯の上で右クリックしたときだけ 3 つが消える** ──
       *   user から見て同じ「見出しを右クリックした」なのに結果が違う。
       * 🔑 見出し自身は `OWN_MEANING` ではないので、そのまま渡せば当たる。
       *   ⚠ リンク・図は**手前の門**(`:6084`)で既に降りているので、
       *   ここで見出しへ寄せてもブラウザ既定は奪わない。
       */
      const line = heading === null ? null : bodySourceLineAt(dispatcher, heading);
      /**
       * 🔴 **押しても何も起きない口は 1 つずつ畳む**(着地前レビュー ⚠7 / 動線 ⚠2 ⚠6)。
       *
       * ⚠ 1 稿目は「入れ子の見出しでは 3 つとも出さない」だったが、その理由
       *   (畳みの計算が本文の直下しか数えない)は**畳みにしか当たっていなかった** ──
       *   引用の中の見出しでも `Ctrl`+クリックは編集に入れるので、メニューだけ
       *   出さないのは「近道では入れるのにメニューからは入れない」を自分で作る。
       * ⚠ 追記は 2 つの条件が要る:①`text` / `textlog` だけ(`appendModeOf`)
       *   ②追記先の一覧が **`#`〜`###` しか数えない**(`append-target.ts`)ので、
       *   `####` 以下で出すと**押した見出しではなく上の `###`** が追記先になる。
       */
      const level = heading === null ? 0 : headingLevel(heading);
      /**
       * 🔑 **章として切り出せる見出しか**(#1044 段2 / 段4)── 本文の直下の `#`〜`###`
       *   (`append-target.ts` の `scanHeadings` が数えるのはそこまで)。章の欄と章の窓で
       *   **同じ 1 つ**を使う(写しを 2 つ持たない)。
       */
      const chapterable = heading !== null && heading.parentElement === host && level >= 1 && level <= 3;
      /**
       * 🔴 **`:::` の塊の上なら「この塊をコピー」を足す**(#677)。
       *
       * ⚠ 見出しと**排他にしない** ── `:::` の中の見出しを右クリックしたら、見出しの物と
       *   塊の物が**両方**要る(どちらかを落とすと、その場所でだけ動線が 1 つ消える)。
       * ⚠ 判定は原文で行う(`directiveBlockAt`)── 座標は刻印と同じ「frontmatter を
       *   剥いだ本文」なので、全文 body ではなく `bodyBelowFrontmatter` を渡す。
       */
      const block =
        host === null || ob === null ? null : directiveBlockAt(host, target, bodyBelowFrontmatter(ob.body));
      /**
       * 🔴 **表の上なら「形を変える」を足す**(#708 段②)。
       *
       * 🔑 **どの表かは押した塊から引く** ── 描画が塊へ焼いた `data-pkc-source-line`
       *   (markdown の表なら見出しの行、csv なら囲みの柵の行)に frontmatter の行数を
       *   足せば**原文の行番号**になる(`place-board.ts` の `lineOffset` と同じ規律)。
       * ⚠ **形を決めるのは原文の側**(`tableAt`)── DOM の class で見分けると、
       *   書き換える側(`body-rewrite.ts`)と**別の答えを持つ口が 2 つ**になる(§7)。
       * ⚠ 表でなければ 1 つも足さない(押しても何も起きない口を作らない)。
       */
      const tableLine = tableLineAt(target, ob?.body ?? null);
      const table = tableLine === null || ob === null ? null : tableAt(ob.body, tableLine);
      /**
       * 🔴 **チェック項目の字の上なら「リストをそろえる」を足す**(#1173)。
       * ⚠ `input`(箱そのもの)の上は**手前の門が既定のメニューを残して**ここへ来ない。
       *   行番号は**この項目にだけ**載せる(`attrs`。表と同じ作法)。
       */
      const taskLines = taskRunLinesAt(target, host);
      // 🔴 ブロックを上下へ 1 つ動かす(台帳 #1852 束 S1、依頼 238 の案 B)。指で⠿を掴めない端末の道
      const steps = host === null || ob === null ? null : blockStepsAt(host, target, ob.body);
      const items = [
        ...(heading === null || line === null
          ? []
          : headingMenuActions({
              folded: isHeadingFolded(heading),
              foldable: heading.parentElement === host,
              appendable: level >= 1 && level <= 3 && appendModeOf(dispatcher.getState()).kind === 'ready',
              // 🔴 章の参照(#579)── 描画が id を刻んだ見出しだけ(`#`〜`###`)
              linkable: heading.id !== '',
              // 🔴 ログの日時の見出しは「行」と呼ぶ(#1559)── 判定は `isLogRowHeading` 1 本
              logRow: isLogRowHeading(
                ob === null ? undefined : dispatcher.getState().entryMetas.get(ob.lid)?.archetype,
                level,
                headingPlainText(heading),
              ),
              /**
               * 🔴 **章だけ編集(#1044 段2)**。⚠ `appendable` は使えない
               *   (append-mode の可否は archetype に依存するが、章だけ編集はどの
               *   archetype でも成り立つ ── `edit-from-heading` と同じ)。
               *   条件は「host の直下」(= `foldable` と同じ、append-target.ts の
               *   `scanHeadings` が引用の中の見出しを見出しと認めないのと同じ理由)+
               *   `#`〜`###`(`scanHeadings` が数える段はそこまで)。
               */
              sectionEditable: chapterable,
              /**
               * 🔴 **章を別のウィンドウで(#1044 段4)**。⚠ 章の範囲を章の欄と**同じ関数**で
               *   決めるので、出す見出しも**同じ条件**にする(書けるかどうかには依らない ──
               *   `sectionEditable` も書ける状態を見ていない、形だけの条件である)。
               */
              chapterWindow: chapterable,
              // 🔴 近道の字を右に添える(#587 C 案 2)── 見出しの項目だけ(塊 / 板 / 本文には無い)
            }).map(withShortcut)),
        ...(block === null ? [] : blockMenuActions({
          board: block.board,
          shape: block.shape,
          styled: block.styled,
          size: block.size,
          group: block.group,
          groupable: block.groupable,
          rotate: block.rotate,
          rotated: block.rotated,
          front: block.front,
        })),
        /**
         * 🔴 **表の形を変える**(#708 段②)。⚠ 行番号は**この項目にだけ**載せる
         *   (`attrs`)── `carry` に混ぜると、表と関係の無い項目まで同じ属性を持ち、
         *   受け手が取り違える(`context-menu.ts` の `attrs` の註記)。
         */
        ...(table === null || tableLine === null
          ? []
          : tableMenuActions({ from: table.format }).map((a) => ({
              ...a,
              attrs: { [MENU_TABLE_ATTR]: String(tableLine) },
            }))),
        ...(taskLines === null
          ? []
          : taskRunMenuActions().map((a) => ({
              ...a,
              attrs: { [MENU_TASK_LINES_ATTR]: taskLines.join(',') },
            }))),
        ...(steps === null
          ? []
          : blockStepMenuActions({ up: steps.up !== null, down: steps.down !== null }).map((a) => ({
              ...a,
              attrs: {
                ...(a.attrs ?? {}),
                [MENU_BLOCK_START_ATTR]: String(steps.start),
                [MENU_BLOCK_END_ATTR]: String(steps.end),
                [MENU_BLOCK_BEFORE_ATTR]: String((a.attrs?.[BLOCK_STEP_DIR_ATTR] === 'up' ? steps.up : steps.down) ?? ''),
              },
            }))),
        /**
         * 🔴 **画像の上なら、大きさ・寄せを頭に足す**(#1640 ③)。⚠ 行と鍵は**この項目にだけ**載せる
         *   (`attrs`。表・チェックリストと同じ作法)── 画像と関係の無い項目に持たせると、受け手が取り違える。
         */
        ...(imageHit === null
          ? []
          : imageMenuActions(imageHit.attrs).map((a) => ({
              ...a,
              attrs: {
                ...(a.attrs ?? {}),
                [MENU_IMAGE_LINE_ATTR]: String(imageHit.line),
                [MENU_IMAGE_KEY_ATTR]: imageHit.key,
                [MENU_IMAGE_NTH_ATTR]: String(imageHit.nth),
              },
            }))),
        /**
         * 🔴 **付箋の上なら「題名を直す」を頭に足す**(#529 W5-b)。⚠ 置いたノートが居る付箋だけ
         *   (「(見つかりません)」の付箋・自分自身を置いた塊では出さない ── 押しても直せない口を出さない)。
         *   相手は**押した付箋のノート**で、板のノート(`MENU_LID_ATTR`)ではない。
         */
        ...placeRenameItem(dispatcher, target),
        // 🔴 板を置く口は**いつも**出す(#676)── 押した座標は下の carry が運ぶ
        ADD_PLACE_ACTION,
        ADD_PLACE_NOTE_ACTION,
        ADD_PLACE_TEMPLATE_ACTION,
        ...body,
      ];
      /**
       * 🔴 **身元は常に運ぶ**(着地前レビュー ⚠5)。⚠ 1 稿目は見出しのときだけ
       * 積んでいたので、**本文を右クリックしたときは lid を運んでいなかった** ──
       * そこに載る `adopt-external-images` は**外へ通信して本文を書き換える**ので、
       * 取り違えの実害がいちばん大きい。行は見出しのときだけ、塊の開き行は塊のときだけ。
       */
      const carry: Record<string, string> = { [MENU_LID_ATTR]: ob?.lid ?? '' };
      if (line !== null) carry[MENU_LINE_ATTR] = String(line);
      if (block !== null) carry[MENU_BLOCK_ATTR] = String(block.line);
      if (host !== null) {
        // 🔴 押した所を**器の座標**へ写して運ぶ(#676)── 受け手はメニューの器の中に居るので、
        //    押した瞬間の座標はここでしか読めない。負は 0 で止める(描画は負を捨てる)
        const r = host.getBoundingClientRect();
        carry[MENU_X_ATTR] = String(Math.max(0, Math.round(ev.clientX - r.left - host.clientLeft + host.scrollLeft)));
        carry[MENU_Y_ATTR] = String(Math.max(0, Math.round(ev.clientY - r.top - host.clientTop + host.scrollTop)));
      }
      openContextMenu(root, { x: ev.clientX, y: ev.clientY }, items, root.ownerDocument.activeElement, carry);
      return;
    }

    /**
     * 🔴 **2 ペインの表の行なら、右クリックしても 2 ペインを抜けない**(#1045 C9)。
     *
     * ⚠ ここより下(既存の枝)は `selectEntryOrExplain` → `SELECT_ENTRY` を撃つ。
     *   `leavesOnSelect('dual')` は `true`(`ASIDE_PANES` に `dual` が在り、
     *   `STAY_ON_SELECT` は `sql` だけ)なので、それを撃つと中央が
     *   本文の面へ切り替わる ── **左クリックは 2 ペインに残る**のに
     *   (`dual-row` action → `DUAL_SELECT`)、右クリックだけ画面ごと切り替わっていた。
     * 🔑 だから**先に**分岐する:押した行が 2 ペインの表(`dual-table`)の中なら、
     *   `SELECT_ENTRY` の代わりに**左クリックと同じ** `DUAL_SELECT` を撃つ。
     * ⚠ `ASIDE_PANES` / `STAY_ON_SELECT` / `leavesOnSelect` は触らない ──
     *   フォルダのタブ(`filer-table`)の行は `dual-table` の中に居ないので
     *   ここには来ない(そちらの「押すと中央へ出る」動きは変えない)。
     */
    if (row.closest('[data-pkc-region="dual-table"]') !== null) {
      ev.preventDefault();
      /**
       * 🔑 側は**左クリックと同じ決め方**(`dualSide`)── 押した所から辿る
       *   (`data-pkc-side` は行そのものにも、面の器にも在る)。⚠ 在り得ない形の
       *   防波堤 ── `dual-row` の左クリックが `if (side && lid)` で何もしないのと
       *   同じく、ここも無ければ何もしない(表の行は必ず持つ)。
       */
      const side = dualSide(target as HTMLElement);
      if (side === null) return;
      /**
       * 🔑 **選択は動かさない**(= 2 ペインを抜けない)。左クリックと**同じ 1 本**を
       *   撃つ(`mode: 'set'`)── reducer 自身が知らない lid を no-op で捨てるので、
       *   下の「見つからない」チェックより先に撃っても安全(順序に意味を持たせない)。
       */
      /**
       * 🔴 **複数の印の中の行を右クリックしたら、印は崩さない**(#1087 D2)。印をまとめて操作したい
       *   user が右クリックで 1 件に絞られると、メニューの「ゴミ箱へ移す」が 1 件にしか効かない。
       *   カーソルだけ押した行へ動かす(印の外の行なら従来どおり、その 1 件を選ぶ)。
       */
      if (paneOf(dispatcher.getState().dual, side).selection.includes(lid))
        dispatcher.dispatch({ type: 'DUAL_SET_CURSOR', side, lid });
      else dispatcher.dispatch({ type: 'DUAL_SELECT', side, lid, mode: 'set' });
      const st = dispatcher.getState();
      if (!st.entryMetas.has(lid)) {
        // ⚠ 無言で終わらせない(`selectEntryOrExplain` と同じ字)
        dispatcher.dispatch({ type: 'OP_FAILED', error: 'ノートが見つかりません' });
        closeContextMenu(root);
        return;
      }
      if (st.phase === 'editing') {
        // 🔑 編集中は既存の枝(#690 ④ A′、下の docstring)と**同じ扱い** ──
        //   出すのは「別のウィンドウで開く」だけ(`MENU_PREV_LID_ATTR` は付けない ──
        //   選択を動かしていないので戻す相手が居ない)。
        openContextMenu(
          root,
          { x: ev.clientX, y: ev.clientY },
          editingRowMenuActions(),
          root.ownerDocument.activeElement,
          { [MENU_LID_ATTR]: lid },
        );
        return;
      }
      /**
       * 🔴 **3 つだけ、この行からは出さない**(#1045 C9 / #1038 台帳③ C1。
       *   着地前の自己監査で判明)。
       *
       * ⚠ 3 つとも「選択が押した行に揃っている」ことを前提に書かれているが、
       *   この分岐は選択を動かさない(`selectedLid` / `openBody` / `st.selection` は
       *   押した行を指さない)。そのまま出すと**押した物と効く先が食い違う**
       *   (CLAUDE.md 不可侵「絶対に作らない」)。
       * - `move-to-folder`:「印に入っていれば印の全部を動かす」を
       *   **左の列の `st.selection` / `visibleFilerRows`**(左のフォルダ絞り)で
       *   判定する。2 ペインの印は別の場所(`state.dual.panes[side].selection`)に在るので、
       *   左に古い印が残っていて偶然この lid を含むと**押していないノートまで動く**。
       * - `copy-plain-markdown`:`st.openBody?.lid === lid` を要求する
       *   (本文は右クリックで読み直さない、§7)。この分岐は選ばないので
       *   ほぼ常に不一致 ──「押せるのに必ず失敗する」(#500 案 C の docstring
       *   「押せるのに必ず失敗するのは、出ない(畳んである)より悪い」)になる。
       * - `start-edit`(#1038 台帳③ C1):`START_EDIT` の reducer は
       *   `openBody.lid === selectedLid` を要求する(`app-state.ts` の
       *   `case 'START_EDIT'`)。この分岐は `openBody` も `selectedLid` も
       *   動かさないので、押すと**選んでいた別のノート**(または何も選んでいなければ
       *   無言)が編集に入る ── これも押した物と効く先が食い違う。
       * 🔑 3 つとも「選ぶ側(=2 ペインを抜ける)」へ倒す理由が無い ── 移すも写すも編集も、
       *   フォルダのタブへ切り替えれば同じボタンで行える。
       */
      /**
       * 🔴 **「名前を変える」は 2 ペインの改名へつなぐ**(#1045 C9、取り込み時に直した)。
       * ⚠ 行の `rename-entry-begin` は左の列の行に入力欄(`row-rename`)を出す作りで、
       *   2 ペインの表はそれを描かない ── そのまま出すと**押せるのに断られる**。
       * 🔑 2 ペインには自前の改名(`dual-rename-begin` = 下の列の「名前」)が在り、
       *   「その面で選ばれている 1 件」を打ち替える。上の `DUAL_SELECT` がちょうど
       *   押した行 1 件を選んでいるので、**同じ行がその場で打ち替わる**。
       *   側は `data-pkc-side` で運ぶ(メニューは root 直下に出るので、押した所からは辿れない)。
       */
      const archetype = st.entryMetas.get(lid)?.archetype ?? null;
      const items = entryMenuActions({
        archetype,
        linkedFile: st.linkedFiles.get(lid) ?? null,
        /**
         * 🔴 **ノートのブックマーク**(#1377)。⚠ 帯が見えるのは**この面だけ**なので、
         *   ここだけが `bookmarked` を渡す(他の 3 か所は渡さない = 出さない)。
         * ⚠ フォルダ(入れる物)は渡さない ── 場所は列の頭の ☆ で入れる(口を 2 つにしない)。
         */
        ...(archetype !== null && st.cid !== null && !canEnterScope(archetype)
          ? { bookmarked: appDualPrefs.getBookmarks().includes(noteBookmarkKey(st.cid, lid)) }
          : {}),
      })
        .filter(
          (a) =>
            a.action !== 'move-to-folder' &&
            a.action !== 'copy-plain-markdown' &&
            // 🔴 `copy-asset-link` も同じ理由(添付の key は `openBody.lid === lid` の本文からしか引けない ──
            //   この分岐は `selectedLid` / `openBody` を動かさないので、押しても必ず断られる)
            a.action !== 'copy-asset-link' &&
            a.action !== 'start-edit',
        )
        .map((a): MenuItem =>
          a.action === 'rename-entry-begin'
            ? { ...a, action: 'dual-rename-begin', attrs: { 'data-pkc-side': side } }
            : a.action === 'delete-entry'
              ? // 🔴 側を運ぶ(#1087 D1)── 消した後にカーソルを立てる先のペインを知るため
                { ...a, attrs: { ...a.attrs, 'data-pkc-side': side } }
              : DUAL_MENU_SELECT_FIRST.has(a.action)
              ? { ...a, attrs: { [MENU_SELECT_FIRST_ATTR]: '' } }
              : a,
        );
      openContextMenu(
        root,
        { x: ev.clientX, y: ev.clientY },
        items,
        root.ownerDocument.activeElement,
        // ⚠ `MENU_PREV_LID_ATTR` は付けない ── 選択を動かしていないので戻す相手が居ない
        //   (直上の編集中の枝と同じ理由)。
        { [MENU_LID_ATTR]: lid },
      );
      return;
    }

    ev.preventDefault();
    /**
     * 🔴 **書いている最中でも、「別の窓で開く」だけは出す**(#690 ④ A′、
     *   user 裁定 2026-09-04)。
     *
     * ⚠ 直す前は編集中の行の右クリックが**必ず断られ**(下の `selectEntryOrExplain`)、
     *   右の情報のボタンも全部 `disabled` ── 書きながら別のノートを参照するには
     *   **下書きを閉じるしか無かった**。付箋は中央を動かさないので、断る理由が無い。
     * 🔑 **行は選ばない**(`SELECT_ENTRY` を撃たない)── 下書きも中央のノートも
     *   動かさない。lid は**メニューのボタン自身に `data-pkc-entry` として載せる**ので、
     *   受け手(`open-note-window`)は「押した行のノート」という**いつもの規則**で拾う
     *   (規則を 2 本にしない ── §7)。
     * ⚠ `MENU_PREV_LID_ATTR` は付けない ── 戻す相手が居ない(何も動かしていない)。
     * ⚠ 情報ペインのボタンは**有効にしない** ── 編集中に選ばれているのは
     *   書いているノート自身なので、押すと同じノートの窓がもう 1 枚出るだけである。
     */
    if (dispatcher.getState().phase === 'editing') {
      if (!dispatcher.getState().entryMetas.has(lid)) {
        // ⚠ 無言で終わらせない(`selectEntryOrExplain` と同じ字)
        dispatcher.dispatch({ type: 'OP_FAILED', error: 'ノートが見つかりません' });
        closeContextMenu(root);
        return;
      }
      openContextMenu(
        root,
        { x: ev.clientX, y: ev.clientY },
        editingRowMenuActions(),
        root.ownerDocument.activeElement,
        { 'data-pkc-entry': lid },
      );
      return;
    }
    // 🔑 **選び直す前**の現在地を控える(`open-note-window` が戻す ── 上の
    //    `MENU_PREV_LID_ATTR`)。⚠ 順番が主張である:`selectEntryOrExplain` の
    //    後だと、控えるのは**押した行そのもの**になって何も戻らない
    const prevLid = dispatcher.getState().selectedLid;
    const marksBefore = dispatcher.getState().selection;
    // 🔴 選べなければ出さない(理由は `selectEntryOrExplain` が画面へ出している)
    if (!selectEntryOrExplain(dispatcher, lid, 'ノート', root, services)) {
      closeContextMenu(root);
      return;
    }
    /**
     * 🔴 **印を付けた行を右クリックしても、印は消さない**(#215)。
     *
     * ⚠ `SELECT_ENTRY` は「これだけを相手にする」の意味で印を 1 件へ戻す(#240 段②)。
     *   ところが右クリックは**選ぶ操作ではなく、できることを見る操作**である ── 3 件に印を
     *   付けてから「移す…」を出そうと右クリックした瞬間に印が 1 件になると、
     *   **押した数と動く数が食い違う**(OS のファイラは、選んだ物の上で右クリックしても
     *   選択を崩さない)。
     * 🔑 押した行が印の中に居るときだけ、他の印を戻す(印の外の行を右クリックしたら、
     *   これまでどおりその 1 件になる ── `TOGGLE_SELECT` は既存の口、規則を増やさない)。
     */
    if (marksBefore.length > 1 && marksBefore.includes(lid)) {
      for (const m of marksBefore) {
        if (m !== lid) dispatcher.dispatch({ type: 'TOGGLE_SELECT', lid: m });
      }
    }
    /**
     * 🔴 **条件つきの 2 つを、この 1 件で判定する**(#500 案 C)。
     *
     * ⚠ 材料は `entryMetas` と `linkedFiles` だけ ── **本文は読まない**
     *   (右クリックで worker を叩く経路を増やさない)。
     * ⚠ `selectEntryOrExplain` を通った**後**に読む ── 選び直した結果の state を
     *   見ないと、1 つ前のノートの種類で判定することになる。
     */
    const st = dispatcher.getState();
    /**
     * 🔴 **予定の札の上なら、「繰り返す…」を頭へ足す**(#855 段 0 の 3 つ目。
     * user 裁定 2026-09-13「札を右クリック →『繰り返す』」)。
     *
     * ⚠ **差し替えない** ── 札はノートの行なので、ノートの操作(削除 / 書き出す)も
     *   要る(見出しのメニューと同じ作法)。
     * ⚠ 出す条件は **2 つ**:①行の予定であること(`data-pkc-whole-note` が無い ──
     *   ノート 1 件の予定は frontmatter の `date:` で、**繰り返しの記法が無い**)
     *   ②**行番号が読めること**(読めない札に出すと、押しても無言になる)。
     * ⚠ **①は、いまの札の作りでは②に含まれている**(2026-09-13 に実測。変異試験 M12 が
     *   SURVIVED で教えた)── `task-card.ts` は `line === null` の札に
     *   `data-pkc-task-line` を**1 つも置かない**ので、①を外しても今日は壊れない。
     *   🔑 それでも残すのは、**①と②が別の問いだから**である ── ②は「行番号が
     *   読めるか」、①は「そもそも行の予定か」。frontmatter の行を指す番号を札へ
     *   焼く日が来たら、**①だけが止める**。⚠ その日のために、①だけが鳴る場面を
     *   test に持たせてある(`schedule-view.test.ts`)。
     * 🔑 行番号は**札ではなく中の印**に在る(2026-08-23 の罠 ── 札に置くと
     *   `[data-pkc-task-line]` を押す既存の経路に当たる)。
     * ⚠ 身元は**その項目だけ**に焼く(`attrs`)── `carry` へ入れると
     *   「削除」「書き出す」にも行番号が付き、読み手が取り違える(#701 の戒め)。
     */
    const taskLine = row.hasAttribute('data-pkc-whole-note')
      ? null
      : (row.querySelector('[data-pkc-task-line]')?.getAttribute('data-pkc-task-line') ?? null);
    const repeatable = taskLine !== null && Number.isInteger(Number(taskLine));
    /**
     * 🔴 **「編集」に近道の字を添え、本文が届くまで押せなくする**(#1038 台帳③ C1)。
     * ⚠ 添える手は既存の見出し・本文のメニューと**同じ関数**(`menuShortcutFor`。
     *   #587 改善 C 案 2)── `start-edit` は `edit-entry` の割当へ読み替わる。
     *   ⚠ 上の分岐(`row === null`)が同じ形の `withShortcut` を持つが、
     *   `if` の中の `const` なのでここには見えない ── 同じ 1 行をここでも組む。
     * ⚠ `st` は直前の `selectEntryOrExplain` の**後**の値 ── 本文はここではまだ
     *   届いていないことがある(worker からの非同期読み)ので、上のボタンと
     *   同じ条件(`openBody.lid === lid`)で押せるかを決める。
     */
    const withRowShortcut = <T extends { readonly action: string }>(
      a: T,
    ): T & { readonly shortcut: string } => ({
      ...a,
      shortcut: menuShortcutFor(a.action, { mac: isMac(), chord: (id) => chordHint(id, appKeymap) }),
    });
    const rows = withEditReady(
      entryMenuActions({
        archetype: st.entryMetas.get(lid)?.archetype ?? null,
        linkedFile: st.linkedFiles.get(lid) ?? null,
      }).map(withRowShortcut),
      st.openBody?.lid === lid,
    );
    const items = repeatable
      ? [
          {
            ...TASK_REPEAT_MENU_ACTION,
            attrs: {
              'data-pkc-entry': lid,
              'data-pkc-task-line': taskLine,
              // ⚠ いまの刻み ── 無ければ空(`repeatMenuActions` が `null` と読む)
              'data-pkc-task-repeat': row.getAttribute('data-pkc-task-repeat') ?? '',
            },
          },
          ...rows,
        ]
      : rows;
    openContextMenu(
      root,
      { x: ev.clientX, y: ev.clientY },
      items,
      root.ownerDocument.activeElement,
      /**
       * 🔴 **開いた瞬間の lid を必ず運ぶ**(#877)。
       *
       * ⚠ 直す前はここに `MENU_LID_ATTR` が無く、行の各ボタンは**行の中に
       *   居ない**(器は root 直下)ので、受け手は `rowLidOrSelected` の②③
       *   (`.closest` → `selectedLid`)しか読めなかった。メニューを開いたまま
       *   `Alt+←` 等で `selectedLid` が動くと、③が**別のノート**を指す ──
       *   「A の削除」を押したつもりで **B が消える**。
       * 🔑 `MENU_PREV_LID_ATTR`(戻す相手)とは別物 ── こちらは
       *   「どのノートに効かせるか」、あちらは「どこへ戻すか」。
       */
      {
        [MENU_LID_ATTR]: lid,
        ...(prevLid === null || prevLid === lid ? {} : { [MENU_PREV_LID_ATTR]: prevLid }),
      },
    );
  };
  /**
   * ⚠ **触った瞬間に閉じる。ただし、押した物の実行より後で。**
   *
   * 🔴 **`queueMicrotask` では駄目だった**(2026-08-27、実ブラウザで踏んだ)。
   * ⚠ microtask の checkpoint は「全部の listener が終わった後」ではなく
   *   **listener 1 本ごと**に走る ── だから
   *   `onCloseMenu` → **メニューが DOM から消える** → `onClick`(委譲)
   *   の順になり、委譲の `if (!el || !root.contains(el)) return;` に当たって
   *   **押しても何も起きなかった**(理由も出ない = 無言の dead click)。
   * ⚠ 症状は「メニューは閉じるのに操作だけ起きない」で、
   *   **閉じるほうは動いているので、配線が切れているように見えない**。
   *
   * 🔑 だから**登録の順で解く** ── この listener は `onClick` の**後**に
   *   登録してあるので、同じ泡立ちの中で**委譲が先、片づけが後**になる。
   *   ⚠ 遅らせる必要はもう無いので、**その場で閉じる**(1 拍置くと、
   *   閉じるまでの間に押せてしまう窓が開く)。
   * ⚠ **登録の順が意味を持つ**ので、下の `addEventListener` を並べ替えないこと。
   */
  const onCloseMenu = (ev: Event): void => {
    /**
     * 🔴 **押した物がメニューを開くボタンなら、閉じない**(#632 段①)。
     *
     * ⚠ 直す前、⋯ は**押しても何も出なかった** ── メニューはこれまで
     *   `contextmenu` からしか開かなかったので、`click` で開く口は
     *   **同じ 1 回のクリックで、上の `onClick` が開き、ここが閉じる**。
     *   ⚠ 症状は「押しても無反応」で、**開いていること自体を誰も見られない**。
     * ⚠ `queueMicrotask` で遅らせても直らない ── microtask の checkpoint は
     *   listener 1 本ごとに走るので、ここより**先**に片づけが来る
     *   (2026-08-27 に `onCloseMenu` を作ったときの docstring と同じ罠)。
     * 🔑 開く側は自分で toggle するので、2 度目の ⋯ は閉じる。
     */
    /**
     * 🔴 **長押しの尻尾の `click` では閉じない**(#857 段②。実ブラウザの smoke が掘った)。
     *
     * ⚠ 長押しでメニューを開く口を足したとき、**捨てる一覧**(`onClick` の
     *   `pressedAction` の並び)には足したが、**ここには足していなかった** ──
     *   結果、長押しでメニューが出た直後、**指を離した合図で選ぶ前に閉じていた**。
     * ⚠ 右クリックで無事だったのは、**右ボタンの離しが `click` を撃たない**からで、
     *   穴が無かったのではなく**踏む経路が無かっただけ**である(指はボタン 0 なので撃つ)。
     *
     * 🔑 **`MENU_OPENERS` に名前を足さない。** あれは「**押すとメニューが開くボタン**」の
     *   一覧で、見出しの押しは**畳む**のであってメニューを開かない ── 足すと
     *   「メニューが出ている間に見出しを押しても閉じない」という別の穴になる。
     * 🔑 代わりに**事実そのもの**を聞く:この `click` は、いま終わった長押しの尻尾か。
     *   ⚠ こう書けば、次に長押しでメニューを開く口が増えても**足し忘れが起きない**
     *   (手で並べる一覧を 2 本目にしない ── CLAUDE.md §7)。
     */
    if (longPress.swallowsClick()) return;
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-action]');
    if (el !== null && el !== undefined && MENU_OPENERS.has(el.getAttribute('data-pkc-action') ?? ''))
      return;
    closeContextMenu(root);
  };
  /**
   * 🔴 **作る種類の一覧(`create-menu`)は、押したらどこでも閉じる**
   * (#1054 段②)。⚠ `▼` 自身の押しだけは除く ── `toggle-create-menu` の
   * 受け手が自分で開閉するので、ここまで閉じると**開いた直後に自分で閉じる**
   * (`onCloseMenu` と同じ罠、CLAUDE.md §1 の「同じ 1 回のクリックで開き、閉じる」)。
   * ⚠ **`onClick` より後に登録する** ── 先に登録すると、選んだ種類を作る前に
   *   メニューが消え、`pick-create-kind` が `target` を見失う。
   */
  const onCloseCreateMenu = (ev: Event): void => {
    const menu = root.querySelector<HTMLElement>('[data-pkc-region="create-menu"]');
    if (menu === null || menu.hidden) return;
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-action]');
    if (el?.getAttribute('data-pkc-action') === 'toggle-create-menu') return;
    menu.hidden = true;
    root.querySelector('[data-pkc-field="create-pick"]')?.setAttribute('aria-expanded', 'false');
  };
  /**
   * 🔴 **焦点が一覧の外へ出たら閉じる**(#1087)。Tab で最後の項目の次へ進むと、一覧が開いたまま
   * 焦点だけが背後へ抜けていた(右クリックのメニューは同じ場面で閉じる ── `context-menu.ts`)。
   * ⚠ 焦点は**返さない**(出ていった先が user の行き先)。⚠ 行き先が `▼` 自身 / 一覧の中なら閉じない
   *   (`▼` を押すと焦点が項目から `▼` へ移る ── 閉じ開きは `toggle-create-menu` が持つ)。
   * ⚠ 行き先が無い(`relatedTarget` が null: 空白を押した / 窓を離れた)ときは何もしない ── 外を押す道は `onCloseCreateMenu`。
   */
  const onCreateMenuFocusOut = (ev: FocusEvent): void => {
    const menu = root.querySelector<HTMLElement>('[data-pkc-region="create-menu"]');
    if (menu === null || menu.hidden) return;
    const to = ev.relatedTarget;
    if (!(to instanceof Node) || menu.contains(to)) return;
    const pick = root.querySelector<HTMLElement>('[data-pkc-field="create-pick"]');
    if (pick !== null && pick.contains(to)) return;
    // 焦点が出たのが一覧か `▼` のときだけ(別の所の focusout では閉じない)
    const from = ev.target;
    if (!(from instanceof Node) || !(menu.contains(from) || pick?.contains(from) === true)) return;
    menu.hidden = true;
    pick?.setAttribute('aria-expanded', 'false');
  };
  /**
   * 🔴 **`create-menu` の中の鍵盤操作**(#1054 段②)。
   * ⚠ `ArrowUp`/`ArrowDown`/`Home`/`End` は**この帯の中だけ**握る ──
   *   `Enter`/`Space` は素の `<button>` が既に持っている(何も書かない)。
   * ⚠ `Escape` は `onMenuKey`(右クリックのメニュー)と**同じ形**(1 段だけ閉じ、
   *   `▼` へ焦点を返す)だが、対象の region が違うので**同じ関数を使い回さない**
   *   (`contextMenuOpen` は `[data-pkc-region="context-menu"]` しか見ない)。
   */
  const onCreateMenuKey = (ev: KeyboardEvent): void => {
    if (!root.isConnected) return;
    const menu = root.querySelector<HTMLElement>('[data-pkc-region="create-menu"]');
    if (menu === null || menu.hidden) return;
    const pick = root.querySelector<HTMLElement>('[data-pkc-field="create-pick"]');
    /**
     * 🔴 **開いている間の `Escape` は、焦点がどこに在っても一覧を閉じるだけ**
     * (#1054 段②-3。user 目線レビューで判明)。
     * ⚠ 直す前は「焦点が項目の中に在るとき」だけ閉じていた ── マウスで `▼` を
     *   押して開くと焦点は `▼` に在るので、`Escape` は**一覧を閉じず**、後ろの
     *   `onShortcut` の `deselect-entry` へ流れて**読んでいたノートの選択だけ外れた**。
     *   ⚠ 項目の中で押した場合も、閉じた後に同じ `Escape` が `onShortcut` へ流れて
     *   選択を外していた(`onMenuKey` と同じ罠)。
     * 🔑 `onMenuKey` と同じく `stopImmediatePropagation` ── この聞き手は `onShortcut` より
     *   **前に**登録されているので、1 回の `Escape` は 1 段だけ閉じる。
     */
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      menu.hidden = true;
      pick?.setAttribute('aria-expanded', 'false');
      pick?.focus();
      return;
    }
    const t = ev.target;
    if (!(t instanceof HTMLElement) || !menu.contains(t)) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) return;
    /**
     * 🔴 **押せない項目は飛ばす**(#1054 段②-2)。⚠ 編集中は「種類」と「今日」が
     *   `disabled` になる(上の `BLOCKABLE_FIELDS`)── 素通りさせると、矢印が
     *   押せない項目の上で止まり、そこだけ `Enter` が無反応になる。
     */
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (items.length === 0) return;
    ev.preventDefault();
    if (ev.key === 'Home') {
      items[0]?.focus();
      return;
    }
    if (ev.key === 'End') {
      items[items.length - 1]?.focus();
      return;
    }
    const idx = items.indexOf(root.ownerDocument.activeElement as HTMLButtonElement);
    const dir = ev.key === 'ArrowDown' ? 1 : -1;
    const next = idx === -1 ? 0 : (idx + dir + items.length) % items.length;
    items[next]?.focus();
  };
  /**
   * 🔴 **予定表の「出すもの」は Esc で閉じる**(#855)。`onCreateMenuKey` と同じ形 ── 開いている間の Esc は
   * 枠を閉じて焦点を見出しへ返すだけで、同じ Esc が後ろの `deselect-entry` へ流れて読んでいるノートを閉じない。
   */
  const onFoldKey = (ev: KeyboardEvent): void => {
    if (!root.isConnected || ev.key !== 'Escape') return;
    const open = root.querySelector<HTMLDetailsElement>('details[data-pkc-field="schedule-fold"][open]');
    if (open === null) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    open.open = false;
    open.querySelector<HTMLElement>('summary')?.focus();
  };
  const onMenuKey = (ev: KeyboardEvent): void => {
    /**
     * 🔴 **`root` が外れていたら何もしない**(#1042 followup。regression 修理)。
     *
     * ⚠ `onShortcut` はこの門を最初から持っていた(「test が root を作り直しても、
     *   古い binder の handler が生き残って二重に作らないため」)が、**同じ
     *   `document` に付く `onMenuKey` には無かった** ── CLAUDE.md §7
     *   「片側を直したら、対称の反対側を必ず疑う」を破っていた。
     * 🔑 これが load-bearing になったのは C3 が `stopImmediatePropagation()` を
     *   足した日から。⚠ **直す前の実害**:test file がメニューを開いたまま
     *   `it()` を終える(= `bindActions` の unbind を呼ばない)と、その
     *   古い(切り離された)`root` を握った `onMenuKey` が `document` に residual で
     *   残り続ける。以後**同じ file の残り全部の `Escape`** で
     *   `contextMenuOpen(oldRoot)` が(そのまま消えない開いたメニューにより)
     *   永久に真を返し、`stopImmediatePropagation()` が**現在のテストの
     *   `onShortcut` も含めて後続の聞き手を丸ごと黙らせる**
     *   (`tests/adapter/row-organize.test.ts` の「Esc なら変えずに閉じる」等が
     *   これで壊れていた)。
     */
    if (!root.isConnected) return;
    if (!contextMenuOpen(root)) return;
    /**
     * 🔴 **右クリックのメニューも ↑↓ / Home / End で項目を移れる**(#1087)。`onCreateMenuKey` と同じ形 ──
     *   押せない項目は飛ばし、端は回る。焦点が項目の外に在るときは握らない。
     */
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) {
      const menu = root.querySelector<HTMLElement>('[data-pkc-region="context-menu"]');
      const t = ev.target;
      if (menu === null || !(t instanceof HTMLElement) || !menu.contains(t)) return;
      const items = [...menu.querySelectorAll<HTMLButtonElement>('button[data-pkc-action]:not(:disabled)')];
      if (items.length === 0) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (ev.key === 'Home') items[0]?.focus();
      else if (ev.key === 'End') items[items.length - 1]?.focus();
      else {
        const idx = items.indexOf(root.ownerDocument.activeElement as HTMLButtonElement);
        const dir = ev.key === 'ArrowDown' ? 1 : -1;
        items[idx === -1 ? 0 : (idx + dir + items.length) % items.length]?.focus();
      }
      return;
    }
    if (ev.key !== 'Escape') return;
    closeContextMenu(root);
    /**
     * 🔴 **この 1 段だけを閉じ、後続の `document` の keydown 聞き手には渡さない**
     * (#1042 C3)。⚠ `deselect-entry` は `contextMenuOpen(root)` を見て**譲る**が、
     *   その判定は**このメニューが閉じた後**に走る(`onShortcut` は `onMenuKey` より
     *   後に登録される)ので、素通しすると同じ 1 回の Escape で
     *   「メニューも閉じ、ノートも閉じる」になってしまう(1 段だけ閉じる、の破り)。
     * 🔑 `stopPropagation` では足りない ── 同じ `document` に付いた**別の聞き手**
     *   (`onShortcut`)を止めるには `stopImmediatePropagation` が要る。
     */
    ev.stopImmediatePropagation();
  };
  /**
   * 🔴 **張ったら、外す手も同時に作る**(#876、2026-09-13)。
   *
   * ⚠ 直す前は `addEventListener` と `removeEventListener` を**手で 2 か所に並べて**
   *   いたので、**7 件が外されないまま残っていた**(`paste` / drag の 6 つ)。
   *   ⚠ `removeEventListener` は**参照が一致しないと黙って何もしない**ので、
   *   例外も警告も出ない ── 機械の門を置いて初めて数が出た。
   * 🔑 だから**並べるのをやめる** ── ここを通せば、外し忘れは**構造から消える**
   *   (CLAUDE.md §7「同じ判定が 2 か所に生えたら、規則を 1 つに寄せる」)。
   * ⚠ `Document` も受ける ── 近道の鍵は `root` ではなく文書に張るためである。
   */
  const undo: Array<() => void> = [];
  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Document,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
    capture?: boolean,
  ): void => {
    // ⚠ ここだけ型を緩める ── `Document` と `HTMLElement` で event の表が別なので。
    //    渡す物は上の型で留めてあるので、緩むのは**器の側だけ**である。
    const t = target as HTMLElement;
    t.addEventListener(type, handler, capture);
    undo.push(() => {
      t.removeEventListener(type, handler, capture);
    });
  };

  listen(root, 'contextmenu', onContextMenu);
  listen(root, 'click', onClick);
  /**
   * 🔴 **外部リンクを初めて押したら、1 度だけ「開かないときは」を言う**(依頼 69-B2)。
   * ⚠ リンクは止めない(`preventDefault` しない)── 開く人の動線を変えない。
   * ⚠ 言ったことは先に憶える(`tellUser` が落ちても 2 度目を言わない)。
   */
  const onExternalLink = (ev: Event): void => {
    if (popupHint.shown() || !isExternalNewTabLink(ev.target)) return;
    popupHint.setShown(true);
    tellUser(POPUP_HINT_TEXT);
  };
  listen(root, 'click', onExternalLink);
  /**
   * 🔴 **升を 2 回押すと、編集欄を開く**(#1240)── 見出しの升の入口。
   *
   * ⚠ 見出しは 1 回押しが並べ替えなので、編集は 2 回押しか ✎ から。本文の升は
   *   1 回押しで既に開いている(欄が在れば `edit-cell` が何もしない)。
   *   ⚠ `cell-input.ts` の `pressCellToEdit`(確定後の隣の升 / 描き直し後の開き直し)も
   *   この経路を通る ── `click()` は見出しで開かないので。
   * ⚠ **字を選んでいる最中の門を通すため、選択を先に畳む** ── 2 回押しは**語を選ぶ**ので、
   *   そのまま `edit-cell` へ渡すと「選択中は開かない」に当たる。欄の中の 2 回押し
   *   (語を選びたい)は触らない。
   */
  const onDblClick = (ev: Event): void => {
    const t = ev.target as HTMLElement | null;
    if (t === null || t.closest('[data-pkc-field="cell-input"]') !== null) return;
    const el = t.closest<HTMLElement>('[data-pkc-action="edit-cell"]');
    /**
     * 🔴 **ふつうの付箋をダブルクリックすると、その場で字を直す欄が開く**(#1662 1。Gemini 裁定 = #1163 依頼 48 の 1 = A)。
     * ⚠ 付箋の中の押せる物(升・リンク・ボタン・チェック・掴む口・欄)の上では開かない ── それぞれの受け手を奪わない。
     * ⚠ 置いたノートの付箋(`data-pkc-place-entry`)は対象外(あちらは「追記」「題名を直す」)。
     */
    if (el === null) {
      const sticky = t.closest<HTMLElement>('.pkc-place:not([data-pkc-place-entry])');
      if (sticky !== null && root.contains(sticky)) {
        const hot = t.closest(
          'a[href], button, input, textarea, select, [data-pkc-action], [data-pkc-field="place-inline"], [data-pkc-field="place-grip"]',
        );
        if (hot === null || !sticky.contains(hot)) {
          ev.preventDefault();
          sticky.ownerDocument.getSelection()?.removeAllRanges();
          openPlaceTextEditor(dispatcher, sticky);
        }
      }
      return;
    }
    if (!root.contains(el)) return;
    const link = t.closest<HTMLElement>('a[href]');
    if (link !== null && el.contains(link)) return;
    el.ownerDocument.getSelection()?.removeAllRanges();
    /**
     * 🔴 **見出しの 2 回押しは、欄を開く前に並べ替えを元へ戻す**(#1264 欠陥 5)。
     * ⚠ 見出しの 1 回押しは並べ替えなので、2 回押しの 1 回目・2 回目で行が 2 回動いてから欄が開く
     *   (Esc でやめると降順の ▼ が残る)。**編集したいだけ**の user には余計な動きなので、欄を開く
     *   **前**に none へ戻す(1 回目の ▲▼ も消える)。本文の升(`td`)は並べ替えを持たないので触らない。
     * 🔑 判定は `opensOnSinglePress` の裏返し(= 見出しの升)1 か所 ── `th` かどうかを別に書かない。
     */
    if (!opensOnSinglePress(el)) {
      const table = el.closest('table');
      if (table !== null) resetTableSort(table);
    }
    run('edit-cell', el);
  };
  listen(root, 'dblclick', onDblClick);
  /**
   * 🔴 **アプリ内リンクの中ボタン(ホイール押し)は、空のタブを開かせない**。
   *
   * ⚠ 中ボタンは `click` ではなく `auxclick` で届く ── `onClick` の `preventDefault` が効かず、
   *   ブラウザが `entry:…` / `pkc://…` を新しいタブで開こうとして**空白のタブ**ができていた。
   * 🔑 止めるだけにする(ノートへ移る動作は通常のクリックに任せる ── 中ボタンで本体の画面を
   *   動かすと、新しいタブを期待した user の手元が変わる)。他の `<a>`(外部 URL)は触らない。
   */
  const onAuxClick = (ev: Event): void => {
    if ((ev as MouseEvent).button !== 1) return;
    const a = (ev.target as HTMLElement | null)?.closest?.<HTMLAnchorElement>('a[href]');
    if (a == null || !root.contains(a)) return;
    if (/^(?:entry:|pkc:\/\/)/i.test(a.getAttribute('href') ?? '')) ev.preventDefault();
  };
  listen(root, 'auxclick', onAuxClick);
  // 🔴 **`onClick` より後に登録する**(上の docstring)── 先に登録すると
  //    メニューが消えてから委譲が走り、押しても無言になる。
  listen(root, 'click', onCloseMenu);
  listen(root, 'click', onCloseCreateMenu);
  listen(root, 'focusout', onCreateMenuFocusOut);
  listen(root.ownerDocument, 'keydown', onCreateMenuKey);
  listen(root.ownerDocument, 'keydown', onFoldKey);
  /**
   * 🔴 **スクロールで閉じるのは、開いた「後に」動いたときだけ**(#875、2026-09-13)。
   *
   * ⚠ 直す前は `onCloseMenu` をそのまま張っていたので、**メニューを開く前に済んだ
   *   スクロールの、遅れて来た通知**でも閉じていた ── 押した器が器の見える範囲から
   *   はみ出していると、クリックの焦点で**ブラウザが真ん中へ寄せる**ためである
   *   (実測:`scrollTop` 0 → 168。`pointerdown` の時点で既に動き終わっている)。
   * 🔴 症状は「**メニューは出るのに、押す間も無く消える**」── 一覧の下のほうの
   *   タイルや見出しで起きるので、**アプリが増えるほど当たる**。
   * 🔑 判定は `context-menu.ts` の 1 か所が持つ ── **どの口から開いても同じに効く**
   *   (見出しのときだけ焦点を止める形にすると、**タイル側が残る** ── §7)。
   */
  const onScrollCloseMenu = (ev: Event): void => {
    // 🔑 メニューの中で送っているだけ(背の低い画面で下の項目へ届かせる)なら閉じない
    if (scrollInsideMenu(root, ev.target)) return;
    if (scrollUnchangedSinceOpen(root, ev.target)) return;
    closeContextMenu(root);
  };
  listen(root, 'scroll', onScrollCloseMenu, true);
  listen(root.ownerDocument, 'keydown', onMenuKey);
  listen(root, 'paste', onPaste);
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
  listen(root, 'dragenter', onDragOver);
  listen(root, 'dragover', onDragOver);
  listen(root, 'drop', onDrop);
  listen(root, 'dragstart', onDragStart);
  listen(root, 'dragend', onDragEnd);
  // 🔴 外から来た荷物は `dragend` を投げない ── 窓の外へ抜けた回はここが印を畳む
  listen(root, 'dragleave', onDragLeave);
  listen(root, 'mousedown', onMousedown);
  listen(root, 'input', onInput);
  listen(root, 'change', onChange);
  // 🔴 本文を打ったり、置換を撃ったりして本文が動いたときも、件数を出し直す(#1646 の 2。同じ字なら DOM に触れない)
  //   ⚠ 配線を組む時点で購読するのはここだけ ── 一部しか持たない仮の dispatcher(test)でも組めるよう、口が在るときだけ繋ぐ
  const onState = (dispatcher as Partial<Dispatcher>).onState;
  if (onState !== undefined) undo.push(onState.call(dispatcher, () => { paintReplaceCount(root, dispatcher); }));
  /**
   * 🔴 **添付の改名欄は、欄を離れたときも確定する**(#1264 §1)。⚠ `change` は字が変わらないと
   *   撃たれないので、**題名だけ別の所で変えた後**にファイル名を揃える道が無かった。
   *   食い違いの判定は `rename-attachment` の 1 本 ── ここは**食い違っているときだけ**呼ぶ
   *   (揃っているのに呼ぶと、書込が走っている最中に「実行中です」と言わせてしまう)。
   */
  const commitAttachmentName = (el: EventTarget | null): void => {
    if (!(el instanceof HTMLInputElement)) return;
    if (el.getAttribute('data-pkc-action') !== 'rename-attachment') return;
    const known = el.getAttribute(ATTACHMENT_NAME_ATTR) ?? '';
    const typed = el.value.trim();
    if (known === '' || typed === '' || attachmentFileName(typed, known) === known) return;
    run('rename-attachment', el);
  };
  listen(root, 'focusout', (ev) => commitAttachmentName(ev.target));
  /**
   * 🔴 **文中の `code` のコピーに失敗したら、画面下に言う**(#1163 依頼 72-2)。
   * ⚠ 字は枠の ⧉ と同じ 1 つ(`copy-md-block.ts` の `COPY_FAILED`)。
   */
  listen(root, INLINE_CODE_COPY_FAILED_EVENT as keyof HTMLElementEventMap, () => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: 'コピーできませんでした' });
  });
  // 見出しの「#」(参照のコピー)も同じ字で言う
  listen(root, HEADING_ANCHOR_COPY_FAILED_EVENT as keyof HTMLElementEventMap, () => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: 'コピーできませんでした' });
  });
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
    if (ke.isComposing || ke.keyCode === 229 || !root.isConnected) return;
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
    // 🔴 画像の拡大も同じ(背後でノートが作られる ── Ctrl+N)。判定は拡大の側の 1 つを読む
    if (isAppDialogOpen() || lightboxOpen(root)) return;
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
    /**
     * 🔴 **左の列の行で名前を打ち替えている欄の鍵は、ここで完結させる**(#215)。
     * `Enter` で確定、`Esc` でやめる。⚠ それ以外の鍵は**入力へ通す**(打てなくなる)。
     * ⚠ 下の `filer` の門より**前**に置く ── 欄はフォルダの表の中に在るので、`Enter` が
     *   「開く」に、`Backspace` が「親へ」に化けると名前が打てない(2 ペインで踏んだ形)。
     */
    if (el instanceof HTMLInputElement && el.matches('[data-pkc-field="row-rename"]')) {
      const lid = el.getAttribute('data-pkc-entry');
      // ⚠ Safari は変換を確定した Enter が `isComposing: false` / `keyCode` 229 で届く ── 確定と取り違えない
      if (ke.key === 'Enter' && ke.keyCode !== 229 && lid !== null) {
        ke.preventDefault();
        commitRowRename(lid, el.value);
        return;
      }
      if (ke.key === 'Escape') {
        ke.preventDefault();
        endRowRename(dispatcher);
        return;
      }
      return;
    }
    /**
     * 🔴 **操作の一覧の行の上で、`↑` `↓` で行を移る**(#274 段①)。
     * ⚠ 先頭から `↑` で探す欄へ戻る ── 降りた手が、打ち直しに戻れないと行き止まりになる。
     * ⚠ `Enter` / `Space` は行(ボタン)の既定が実行する ── ここでは握らない。
     */
    if (
      el instanceof HTMLButtonElement &&
      el.matches('[data-pkc-field="command-row"]') &&
      (ke.key === 'ArrowDown' || ke.key === 'ArrowUp' || ke.key === 'Escape')
    ) {
      /**
       * 🔴 **行の上の `Esc` は、探す欄へ焦点を戻すだけ**(#1206 D4)。⚠ 直す前は行の上で
       *   `Esc` を押すと**閉じる操作へ落ちて、開いている本文が閉じた**(降りた手を戻したかっただけ)。
       *   `>` の字は残す(消すのは探す欄の `Esc` の仕事)── 戻って打ち直せる。
       */
      if (ke.key === 'Escape') {
        ke.preventDefault();
        root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')?.focus();
        return;
      }
      const rows = Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          '[data-pkc-region="command-list"] [data-pkc-field="command-row"]',
        ),
      ).filter((b) => !b.disabled);
      const at = rows.indexOf(el);
      ke.preventDefault();
      if (ke.key === 'ArrowDown') rows[at + 1]?.focus();
      else if (at <= 0)
        root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')?.focus();
      else rows[at - 1]?.focus();
      return;
    }
    /**
     * 🔴 **一覧の絞り込みの欄から、そのまま行へ降りられる**(#1042 C2)。
     * ⚠ 2 ペインの絞り込み(下の `dual-filter`)と**同じ形**── これが無いと
     *   「打って絞る → マウスで行を押す」になり、キーボードだけで完結しない。
     * ⚠ `Escape` は**打った字を消す**だけ(下。#1650)── 本文を閉じる側へは落とさない(C3 の
     *   「入力欄では効かせない」規約)。それ以外の鍵は入力へ通す。
     */
    if (el instanceof HTMLInputElement && el.matches('[data-pkc-field="entry-filter"]')) {
      /**
       * 🔴 **`Esc` は、打った字を消す**(#1650 項目 2。Gemini 裁定 = #1163 の依頼 42-2 A)。
       * ⚠ 吹き出しは「Esc で、打った字を消します」と言うが、直す前は**ブラウザの検索欄の標準の動き**に
       *   頼っていた(`type="search"`)── 標準で消えないブラウザでは吹き出しが偽になる。
       * 🔑 標準の動きと**二重に走らせない**(`preventDefault`)。⚠ 欄も空にする(state だけ空にすると、
       *   打った字が残って見える ── 下の 2 ペインの絞り込みと同じ)。⚠ 変換中の Esc は変換の取り消しなので握らない。
       * ⚠ 字が無いときは何もしない(空の欄の Esc は、これまでどおり他へ流さない)。
       */
      if (ke.key === 'Escape' && !ke.isComposing && el.value !== '') {
        ke.preventDefault();
        el.value = '';
        dispatcher.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
        return;
      }
      /**
       * 🔴 **字が無いときの `Esc` は、探す欄から出る**(#1163 依頼 185 = 案どおり)。
       * ⚠ 直す前は何も起きず、欄に居続けた。🔑 出るだけで、本文は閉じない(次の `Esc` が今までどおり効く)。
       *   `preventDefault` するのはブラウザの検索欄の標準の動きと二重に走らせないため(上と同じ)。
       */
      if (ke.key === 'Escape' && !ke.isComposing && el.value === '') {
        ke.preventDefault();
        el.blur();
        return;
      }
      /**
       * 🔴 **`>` を打っている間は、鍵が操作の一覧に効く**(#274 段①)。
       * ⚠ `Enter` = **押せる先頭の行を実行**(操作のパレットと同じ ── 一覧へ焦点を移して
       *   から押させると、絞って即実行という速さが消える)。⚠ 変換確定の Enter では実行しない。
       * ⚠ `↓` = 先頭の行へ降りる(ノートの一覧と同じ ── 行は押せるボタンなので、
       *   そこから `Enter` / `Space` で実行できる)。
       */
      if (commandQueryOf(el.value) !== null) {
        const rows = (): HTMLButtonElement[] =>
          Array.from(
            root.querySelectorAll<HTMLButtonElement>(
              '[data-pkc-region="command-list"] [data-pkc-field="command-row"]',
            ),
          );
        if (ke.key === 'Enter' && !ke.isComposing) {
          /**
           * 🔴 **`>` だけのときの `Enter` は実行しない。先頭の行へ焦点を移す**(#1206 D8 →
           *   #274 Q2 = C。2026-10-03)。⚠ 直す前の D8 は先頭の行(空の探し語では「ノートを作る」)が
           *   走り、**打った覚えのない新しいノートの編集に入った**ので「何も起きない」にしたが、
           *   今度は**押しても何も起きない**ように見えた ── `↓` と同じく先頭の押せる行へ降りる
           *   (次の `Enter` は、その行(ボタン)の既定が実行する)。⚠ ここでは**実行しない**(D8 は守る)。
           */
          if ((commandQueryOf(el.value) ?? '').trim() === '') {
            const top = rows().find((b) => !b.disabled);
            if (top === undefined) return;
            ke.preventDefault();
            top.focus();
            return;
          }
          const first = rows().find((b) => !b.disabled);
          if (first === undefined) return;
          ke.preventDefault();
          first.click();
          return;
        }
        if (ke.key === 'ArrowDown') {
          const first = rows().find((b) => !b.disabled);
          if (first === undefined) return;
          ke.preventDefault();
          first.focus();
        }
        return;
      }
      if (ke.key === 'ArrowDown') {
        /**
         * 🔴 **降りる先は、フォルダの表の最初の行**(#813 段③-a → ③-b)。
         * ⚠ 直す前は一覧の行しか引かなかったので、**既定のフォルダのタブでは ↓ を押しても
         *   何も起きなかった**。🔑 行は `visibleFilerRows`(描く側と同じ 1 本)から引く ──
         *   DOM の並びを読むと、絞り込み・並べ替えのとき目で見た順と食い違う。
         */
        const first = visibleFilerRows(dispatcher.getState())[0]?.lid ?? null;
        if (first === null) return;
        const target = rowEl(first);
        // ⚠ 隠れている面(予定・連絡先など)の行へは降りない ── 焦点が入らないのに ↓ だけ奪わない
        if (target === null || target.closest('[hidden]') !== null) return;
        ke.preventDefault();
        target.focus();
      }
      return;
    }
    if (!typing && el?.closest('[data-pkc-region="filer-table"]')) {
      const fcmd = keymap.match(ke, 'filer');
      // 🔴 押しっぱなしでは撃たない(#1087)。⚠ 鍵は食う ── 通すと global の同じ鍵(Delete など)へ落ちる
      if (fcmd !== null && ke.repeat && REPEAT_IGNORED_KEYS.has(fcmd)) {
        ke.preventDefault();
        return;
      }
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
      // ⚠ Safari は変換を確定した Enter が `isComposing: false` / `keyCode` 229 で届く ── 確定と取り違えない
      if (ke.key === 'Enter' && ke.keyCode !== 229 && lid !== null) {
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
        // 🔴 押しっぱなしでは撃たない(#1087)。左の列の鍵と同じ表を引く
        if (dcmd !== null && ke.repeat && REPEAT_IGNORED_KEYS.has(dcmd)) {
          ke.preventDefault();
          return;
        }
        if (dcmd !== null && runDualKey(dcmd, dside)) {
          ke.preventDefault();
          return;
        }
      }
    }
    /**
     * 🔴 **`global` は単独で試す**(#1042 C3 / 追補)。
     * ⚠ 以前は `keymap.match(ke, 'global') ?? keymap.match(ke, 'reading')` で
     *   **混ぜて**いたが、`reading` / `window` の優先順を「面が在るか」で
     *   入れ替える必要が出た(下)ので、ここでは分ける。⚠ 動きは変わらない ──
     *   `global` は `contextsOverlap` により `reading` / `window` と**同じ鍵を
     *   名乗れない**(`validateBinding`)ので、`gcmd !== null` の鍵は `reading` /
     *   `window` には元から現れず、下の分岐へ落ちることもない。
     */
    const gcmd = keymap.match(ke, 'global');
    if (gcmd !== null) {
      /**
       * 打鍵中に効かせてよいか。**コマンドが名乗る** + **その和音が文字を打たない**の
       * 両方が要る(着地前レビュー 2)── `open-help` は `F1` のために名乗っているが、
       * 別名の `Alt+5` は mac で `∞` を打つ鍵である。名乗りだけを見ると、
       * **本文に記号が入らずヘルプが開く**。
       */
      const chord = chordOf(ke);
      /**
       * 🔴 **文字を打っている間の `Alt+←` / `Alt+→` は、カーソルの移動に任せる**(#1163 依頼 180。Gemini 裁定 = 案どおり)。
       * ⚠ mac の `Option+←/→` は「単語ごとにカーソルを動かす」キーで、直す前は文章を書くたびにカーソルが動かず
       *   ノートが切り替わった。画面の「戻る」「進む」のボタンはそのまま使える。
       * ⚠ mac 以外は、欄の中の `Alt+←/→` に欄としての働きが無く、素通しするとブラウザが前のページへ戻って
       *   書きかけの画面を離れかねない ── 直す前から止めていたので、これまでどおり止める(`preventDefault` だけして何もしない)。
       */
      if (typing && (gcmd === 'nav-back' || gcmd === 'nav-forward')) {
        if (!isMac()) ke.preventDefault();
        return;
      }
      if (
        typing &&
        !(findCommand(gcmd)?.whileTyping === true && chord !== null && !typesCharacter(chord))
      )
        return;
      /**
       * 🔴 **ヘルプを読んでいる間は `Ctrl+F` をブラウザに返す**
       * (#636。user 指示 2026-08-31「**ヘルプ閲覧中はユーザービリティのために
       * ctrl+f をブラウザに返してください**」)。
       *
       * ⚠ 実測(直す前):ヘルプの面で `Ctrl+F` を押すと
       *   `defaultPrevented === true` / 焦点が `entry-filter` へ移り、**本文の面と
       *   まったく同じ**だった ── つまり**ブラウザの検索は出ず**、畳んでいた左の列が
       *   勝手に開き、焦点がノートの絞り込み欄へ飛ぶ。
       * 🔑 `runGlobalCommand` には**譲る口が既に在る**(`if (!input) return false`)が、
       *   `entry-filter` は器を組むときに 1 度作られ**畳んでも DOM から消えない**
       *   (#583 が実測して直した当の性質)ので、**その行は一度も真にならない**。
       *
       * 🔴 **だから門は呼び側に置く。** `runGlobalCommand` の中で `false` を返すと、
       *   パレットが `dry` でその答えを読み、**「いまは押せません」と誤って断って**
       *   行を `disabled` にする ── 裁定は「Ctrl+F を返す」であって
       *   「操作を消す」ではない。ここで `return` すれば `prevent()` を通らないので、
       *   ブラウザの既定動作(ページ内検索)がそのまま出る。
       * ⚠ **範囲はヘルプだけ。** 設定・フラグ・2 ペインは**操作の面**で、そこで
       *   絞り込みへ飛ぶのは今も筋が通る。
       * 🔑 **覆る条件**:設定やフラグが長い読み物になったら、判定を面の種類ごとではなく
       *   「読む面か」で括り直す。
       */
      if (gcmd === 'focus-search' && dispatcher.getState().viewMode === 'help') return;
      if (runGlobalCommand(gcmd, root, dispatcher, keymap, () => ke.preventDefault(), tellUser))
        return;
    } else if (!typing) {
      /**
       * 🔴 **`reading`(ノートを閉じる)と `window`(面・別窓を閉じる)の優先順は、
       * 「面が在るか」で入れ替える**(#1042 followup、着地前レビュー 指摘 B)。
       *
       * ⚠ **面が在るとき、ノートは見えていない** ── 中央は面(集計・システム・
       *   フラグ・ヘルプ・2 ペイン・SQL など)に占められているので、その裏で
       *   `deselect-entry` が先に効くと、user は**見えていないノートを閉じられ**、
       *   2 回目でようやく面が閉じてコレクションの画面に落ちる ──
       *   **読みに来ていたノートへ戻れない**(直す前の実害)。
       * 🔑 面が在るときは **`window` を先に試す**(1 回目で面が閉じてノートへ戻る、
       *   2 回目でノートが閉じる)。面が無いときは元のとおり **`reading` が先**
       *   (`close-pane` は `hidden` なボタンでも「押せた」ことになるので、先に
       *   試すとノートが開いていても `deselect-entry` に出番が来ない ── #1042 C3)。
       */
      const paneOpen = dispatcher.getState().viewMode !== 'detail';
      const rcmd = keymap.match(ke, 'reading');
      const wcmd = keymap.match(ke, 'window');
      const tryReading = (): boolean => {
        if (rcmd === null) return false;
        /**
         * 🔴 **「探す」の塗りが出ている間の `Esc` は、まず塗りを消すだけ**(#1102 段①)。
         *
         * ⚠ 先に消さないと、付箋の窓では**窓ごと閉じ**、本体ではノートが閉じる ── 当たりを
         *   見ていた user が、塗りを消したいだけの `Esc` で**読んでいた本文を失う**。
         * 🔑 1 回の `Esc` で 1 段だけ(次の `Esc` で今までどおりノートが閉じる)。
         * ⚠ 右クリックのメニューが出ている間は譲る(`deselect-entry` と同じ判定の 1 本)。
         */
        if (
          rcmd === 'deselect-entry' &&
          dispatcher.getState().searchJump != null &&
          !contextMenuOpen(root)
        ) {
          ke.preventDefault();
          dispatcher.dispatch({ type: 'SEARCH_JUMP_END' });
          return true;
        }
        /**
         * 🔴 **付箋のウィンドウでは、`deselect-entry` を撃たずに窓を閉じる**
         * (#1042 followup 指摘 A。裁定:`docs/development/touch-and-unity-design-2026-09.md`
         * §5 Q3「付箋のウィンドウも Escape で閉じます」)。
         *
         * ⚠ **`selectedLid` を空にしてはいけない** ── 付箋の窓では
         *   `heldNoteWindow` が真の間、`main.ts` の題名塗り・台帳の放送
         *   (`noteRegistry.announce`)が `selectedLid` を見て「このノートは
         *   開いています」を保っている。`deselect-entry` を先に撃つと
         *   `selectedLid` が `null` になり、**閉じる前に「開いていません」と
         *   放送してしまう**(#685 の 2 枚目防止を自分で取り下げる ── 窓は
         *   閉じずに空の画面だけが残る、という直す前の症状そのもの)。
         * 🔑 判断は `services.closeNoteWindow` に譲る(binder は `heldNoteWindow`
         *   を持たない ── `main.ts` から渡された関数を呼ぶだけ)。**このウィンドウが
         *   自分で開いた付箋のときだけ** `'closed'` / `'refused'` を返し、
         *   ふつうの本体タブでは `'not-a-window'`/`undefined`(呼ばれない=
         *   今までどおり `deselect-entry` へ進む)。
         * 🔴 **`'refused'`(ブラウザが閉じなかった)でも `deselect-entry` へは
         *   進まない**(#1042 段④)。⚠ 直す前は `=== true`(`'closed'` だけを
         *   拾う boolean)で判定していたので、`'refused'` は `false` 側に
         *   潰れて**黙って** `deselect-entry` に流れていた ── 窓は開いたままなのに
         *   `selectedLid` が空になり、「このノートは開いています」の放送
         *   (`heldNoteWindow` が真の間続く)と画面が食い違う(上の docstring が
         *   名指しで戒めている、まさにその症状)。
         * 🔑 `close-pane` と同じ理由を出す(`CLOSE_VIEW_WINDOW_REFUSED`)。
         */
        /**
         * 🔴 **編集中は閉じない**(#1087)── 本体の `deselect-entry` は `phase === 'ready'` のときだけ
         *   効く(`runGlobalCommand`)。付箋の窓だけこの門を通らず、**書いている最中に `Esc` で
         *   確認も無く窓ごと閉じて**打ちかけが消えていた。
         */
        /**
         * 🔴 **追記欄に字が在る / 章の欄が開いている間も閉じない**(#1087)。⚠ 欄の中の Escape は
         *   「空のときだけ」閉じる門を持つが、欄の外へ焦点を外すとこちらへ来て、打った字ごと窓が閉じた。
         *   付箋の窓では `deselect-entry` へも流さない(`selectedLid` を空にすると窓が空の画面で残る)。
         */
        if (
          rcmd === 'deselect-entry' &&
          dispatcher.getState().phase === 'ready' &&
          noteWindowHasTyping(root, dispatcher.getState()) &&
          services.isNoteWindow?.() === true
        ) {
          ke.preventDefault();
          return true;
        }
        const closed =
          dispatcher.getState().phase === 'ready'
            ? (services.closeNoteWindow?.() ?? 'not-a-window')
            : 'not-a-window';
        if (rcmd === 'deselect-entry' && closed !== 'not-a-window') {
          ke.preventDefault();
          if (closed === 'refused')
            dispatcher.dispatch({ type: 'OP_FAILED', error: CLOSE_NOTE_WINDOW_REFUSED });
          return true;
        }
        return runGlobalCommand(rcmd, root, dispatcher, keymap, () => ke.preventDefault(), tellUser);
      };
      const tryWindow = (): boolean =>
        wcmd !== null &&
        runGlobalCommand(wcmd, root, dispatcher, keymap, () => ke.preventDefault(), tellUser);
      if (paneOpen ? tryWindow() || tryReading() : tryReading() || tryWindow()) return;
    }
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
  // 🔑 属性の値で直接引く(#1087)── 直す前は 1 行探すたびに全行(3,000 件)を配列にして先頭から比べていた
  const rowEl = (lid: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-pkc-region="filer-table"] [data-pkc-entry="${CSS.escape(lid)}"]`);

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
  /**
   * 🔴 **PageUp / PageDown で動く行数**(依頼 337)── 画面に見えている行の数(1 行は重ねる)。
   * ⚠ 行の高さと器の高さは画面から読む(行の高さは種類・折り返しで変わる)。測れない(高さ 0 ── 隠れている面・
   *   DOM に高さを持たない環境)ときは 10 行。⚠ 端では止まる(`rowAt` / `dualRowAt` が丸める)。
   */
  const pageRows = (from: Element | null): number => {
    const row = from?.closest('tr') ?? null;
    const box = from?.closest('[data-pkc-region="browse-host"], [data-pkc-region="dual-pane"]') ?? null;
    const rowH = row?.getBoundingClientRect().height ?? 0;
    const boxH = box?.getBoundingClientRect().height ?? 0;
    if (rowH <= 0 || boxH <= 0) return 10;
    return Math.max(1, Math.floor(boxH / rowH) - 1);
  };

  const rowAt = (st: AppState, delta: number): string | null => {
    const rows = visibleFilerRows(st);
    if (rows.length === 0) return null;
    const cur = focusedRowLid();
    const i = cur === null ? -1 : rows.findIndex((m) => m.lid === cur);
    if (i === -1) {
      /**
       * 🔴 **消した直後は、消した位置の隣から入る**(#1087。2 ペインの D1 と同じ向き)。
       * ⚠ 表は焦点を「表そのもの」へ置く(押していない行に枠を出さない)ので、行の焦点が無い。
       *   先頭 / 末尾から入ると、続けて ↓ / ↑ が一覧の端へ飛んでいた。
       *   行が前後で数え直せる(同じ現在地・消した分だけ減った数)ときだけ使う ── 他の操作を挟んだ古い印は読まない。
       */
      const gap = cur === null ? deletedGap.get(root) : undefined;
      deletedGap.delete(root);
      if (gap !== undefined && gap.scope === st.scopeLid && gap.count === rows.length) {
        const at = delta > 0 ? gap.index : gap.index - 1;
        return rows[Math.min(rows.length - 1, Math.max(0, at))]?.lid ?? null;
      }
      return (delta > 0 ? rows[0] : rows[rows.length - 1])?.lid ?? null;
    }
    deletedGap.delete(root);
    return rows[Math.min(rows.length - 1, Math.max(0, i + delta))]?.lid ?? null;
  };

  /**
   * 🔴 **選んだノートを横の枠(スタック)へ開く**(#1092)。
   *
   * > 「中央のノートは開いたまま、横の枠（スタック）にポンと追加して並べる」
   *
   * ⚠ **スマホなど画面が狭いときは並べられない** ── 無理に開かず、
   *   画面下に「画面が狭いため横に並べられません」と理由を言う。
   * 🔑 中央のノート(`selectedLid`)は動かさない ── 開くのは横の枠(`splitLids`)だけである。
   *   既に載っているノートなら先頭へ繰り上がる(`pinSplitLid` の規約)。
   */
  const openStackNote = (lid: string): boolean => {
    if (root.getAttribute('data-pkc-layout') === 'phone') {
      tellUser('画面が狭いため横に並べられません');
      return true;
    }
    const meta = dispatcher.getState().entryMetas.get(lid);
    if (!meta) return false;
    dispatcher.dispatch({ type: 'PIN_SPLIT_ENTRY', lid });
    const frame = root.querySelector<HTMLElement>(`[data-pkc-split-lid="${lid}"]`);
    if (frame) frame.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
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
    if (!selectEntryOrExplain(dispatcher, lid, 'ノート', root, services)) return false;
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
    // 🔴 入る口は `startEditAt` の 1 本(上の Ctrl+クリックと同じ理由 ── 直撃ちは
    //   別のタブとの編集ロックを飛ばす)
    if (arrived(dispatcher.getState())) {
      startEditAt(dispatcher, services, null);
      return;
    }
    const off = dispatcher.onState((s) => {
      if (s.selectedLid !== lid || s.phase !== 'ready') {
        off();
        return;
      }
      if (!arrived(s)) return;
      off();
      startEditAt(dispatcher, services, null);
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
    // 🔴 添付ならファイル名も揃える(#1220 F2)── 添付の改名欄と同じ関数(`attachment-rename.ts`)
    renameEntryFromRow(dispatcher, lid, value);
    dispatcher.dispatch({ type: 'DUAL_RENAME_END' });
  };
  /** 左の列の行の版(#215)。⚠ 空白だけ / 変わっていない、の判定は reducer が持つ(上と同じ)。 */
  const commitRowRename = (lid: string, value: string): void => {
    renameEntryFromRow(dispatcher, lid, value);
    endRowRename(dispatcher);
  };

  const runDualKey = (cmd: string, side: DualSide): boolean => {
    // 🔴 ゴミ箱へ移した直後の「元に戻す」(`Ctrl+Z`。#1163 依頼 132)── 実体は「操作を探す」と同じ `runGlobalCommand` の 1 本
    if (cmd === 'undo-trash')
      return runGlobalCommand(cmd, root, dispatcher, keymap, () => undefined, tellUser);
    const st = dispatcher.getState();
    /**
     * ⚠ **無言で断らない**(左の列と同じ作法)── `preventDefault` は走るので、
     * 黙ると「押したのに何も起きず、ブラウザの既定まで消えた」になる。
     */
    if (st.phase !== 'ready') {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `${phaseBlockReason(st.phase)}フォルダの操作をしてください`,
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
    // 🔴 先頭 / 末尾 / 1 画面ぶん(依頼 337)── 2 ペインはカーソルだけが動く(↑↓ と同じ)
    if (
      cmd === 'filer-row-first' ||
      cmd === 'filer-row-last' ||
      cmd === 'filer-row-page-up' ||
      cmd === 'filer-row-page-down'
    ) {
      const rows = dualRows(st, side);
      const lid =
        cmd === 'filer-row-first'
          ? (rows[0]?.lid ?? null)
          : cmd === 'filer-row-last'
            ? (rows[rows.length - 1]?.lid ?? null)
            : dualRowAt(
                st,
                side,
                (cmd === 'filer-row-page-down' ? 1 : -1) * pageRows(root.ownerDocument.activeElement),
              );
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
      const picked = dualRenameTarget(st, side);
      if ('error' in picked) {
        // 何も無いときは従来どおり鍵を譲る(`false`)/ 複数のときはボタンと同じ断り
        if (paneOf(st.dual, side).selection.length === 0) return false;
        dispatcher.dispatch({ type: 'OP_FAILED', error: picked.error });
        return true;
      }
      dispatcher.dispatch({ type: 'DUAL_RENAME_BEGIN', side, lid: picked.lid });
      return true;
    }
    if (cmd === 'dual-other-pane') {
      const to = otherSide(side);
      dispatcher.dispatch({ type: 'DUAL_FOCUS', side: to });
      carryDualFocus(to);
      return true;
    }
    if (cmd === 'filer-select-all') return dualSelectAll(dispatcher, side);
    if (cmd === 'filer-parent') {
      const scope = paneScope(paneOf(st.dual, side));
      if (scope === null) return false; // ルートで押しても何も起きない
      const up = getAncestorFolders(scope, st.entryMetas, st.relations)[0] ?? null;
      dispatcher.dispatch({ type: 'DUAL_SET_SCOPE', side, lid: up?.lid ?? null });
      // 🔴 出てきたフォルダにカーソルを立てる(#1087 D4)── 立てないと先頭の行へ飛ぶ。見えていなければ従来どおり。
      if (dualRows(dispatcher.getState(), side).some((m) => m.lid === scope))
        dispatcher.dispatch({ type: 'DUAL_SET_CURSOR', side, lid: scope });
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
    if (cmd === 'filer-open-stack') {
      const lid = dualCursor(st, side) ?? paneOf(st.dual, side).selection[0] ?? null;
      if (lid === null) return false;
      return openStackNote(lid);
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
      const rows = dualRows(st, side);
      const cursor = paneOf(st.dual, side).cursor;
      deleteFrom(dispatcher, services, root, rows, paneOf(st.dual, side).selection, cursor, () => {
        // 焦点も連れて行く(表は組み直されるので、立てたカーソルの行へ)
        if (keepDualCursorUnlessMoved(dispatcher, side, rows, cursor) !== null) carryDualFocus(side);
      });
      return true;
    }
    return false;
  };

  const runFilerKey = (cmd: string): boolean => {
    // 🔴 ゴミ箱へ移した直後の「元に戻す」(`Ctrl+Z`。#1163 依頼 132)── 2 ペインと同じ 1 本(戻す実体を 2 つ作らない)
    if (cmd === 'undo-trash')
      return runGlobalCommand(cmd, root, dispatcher, keymap, () => undefined, tellUser);
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
        error: `${phaseBlockReason(st.phase)}フォルダの操作をしてください`,
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
      const cameFrom = st.scopeLid;
      dispatcher.dispatch({ type: 'SET_SCOPE', lid: up?.lid ?? null });
      // 🔴 出てきたフォルダに焦点を立てる(#1087。2 ペインの D4 と同じ)── 立てないと先頭の行に立ち、Enter が先頭のノートを開く。
      //    見えていなければ(絞り込み等)従来どおり。
      if (dispatcher.getState().scopeLid === (up?.lid ?? null)) focusRow(cameFrom);
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
       * 🔑 印を空にしてから 1 件付ける ── 起点(`selectionAnchor`)もその行に立つので、
       *   続く `Shift` が効く。⚠ 1 回の dispatch で撃つ(`SELECT_ONLY`。2 回撃つと 1 キーで
       *   2 回描き直す ── #1087 の実測)。
       */
      dispatcher.dispatch({ type: 'SELECT_ONLY', lid });
      focusRow(lid);
      return true;
    }
    /**
     * 🔴 **先頭 / 末尾 / 1 画面ぶん**(依頼 337)。送り方は ↑↓ と同じ(印も動く・中央のノートは開き直さない)。
     */
    if (
      cmd === 'filer-row-first' ||
      cmd === 'filer-row-last' ||
      cmd === 'filer-row-page-up' ||
      cmd === 'filer-row-page-down'
    ) {
      const rows = visibleFilerRows(st);
      const lid =
        cmd === 'filer-row-first'
          ? (rows[0]?.lid ?? null)
          : cmd === 'filer-row-last'
            ? (rows[rows.length - 1]?.lid ?? null)
            : rowAt(st, (cmd === 'filer-row-page-down' ? 1 : -1) * pageRows(root.ownerDocument.activeElement));
      if (lid === null) return false;
      dispatcher.dispatch({ type: 'SELECT_ONLY', lid });
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
        dispatcher.dispatch({ type: 'SELECT_ONLY', lid: from });
      }
      dispatcher.dispatch({ type: 'SELECT_RANGE', lid });
      focusRow(lid);
      return true;
    }
    /**
     * 🔴 **F キーは押しボタンと同じ実体を呼ぶ**(#215。2 ペインの `DUAL_KEY_ACTION` と同型)。
     * ⚠ 相手は**焦点の行**(無ければ選んでいるノート)── 受け手は `data-pkc-entry` を
     *   `closest` で辿るので、行そのものを target として渡す。行が無ければ表を渡す
     *   (受け手が `selectedLid` へ落とす)。
     */
    const viaRow = FILER_KEY_ACTION[cmd];
    if (viaRow !== undefined) {
      const lid = focusedRowLid() ?? st.selectedLid;
      const host =
        (lid === null ? null : rowEl(lid)) ??
        root.querySelector<HTMLElement>('[data-pkc-region="filer-table"]');
      if (host === null) return false;
      run(viaRow, host);
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
    if (cmd === 'filer-open-stack') {
      const lid = focusedRowLid() ?? st.selectedLid;
      if (lid === null) return false;
      return openStackNote(lid);
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
    // 🔴 左の列の行の欄も同じ作法(#215)── 他所を押したら確定する
    if (el instanceof HTMLInputElement && el.matches('[data-pkc-field="row-rename"]')) {
      if (dispatcher.getState().renamingLid === null) return;
      const lid = el.getAttribute('data-pkc-entry');
      if (lid !== null) commitRowRename(lid, el.value);
      return;
    }
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
  /**
   * 🔴 **タグの欄に焦点が当たったら、候補を集めてもらう**(#494 段②)。
   *
   * ⚠ **常に集めない** ── 全ノートの frontmatter を舐めるので、タグを打たない人に
   *   毎回払わせない。⚠ **打つたびにも集めない** ── 既に持っていれば reducer が
   *   何もしない(`ASK_TAG_SUGGESTIONS`)。
   * 🔑 **2 つの欄が同じ候補を使う**(§7)── 情報ペインの「その場で打つ」と、
   *   フォルダの面の「まとめて付ける」。別々に集めると、同じ画面で
   *   **候補が食い違う**。
   */
  const onTagFocusIn = (ev: Event): void => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-pkc-field]');
    const field = el?.getAttribute('data-pkc-field');
    if (field === null || field === undefined || !TAG_INPUT_ADD.has(field)) return;
    dispatcher.dispatch({ type: 'ASK_TAG_SUGGESTIONS' });
  };
  listen(root, 'focusin', onTagFocusIn);
  listen(root, 'focusin', onDualFocusIn);
  listen(root, 'focusout', onRenameBlur);
  /**
   * 🔴 **1 面の行が左の探す欄へ焦点を渡すとき、打っていた行を控える**(#582)。
   * ⚠ `blur` を**捕まえる段**(capture)で聴く ── 行自身の `blur` が確定して `row-source` を DOM から外すより前に読むため
   *   (外れた節点の `focusout` は root へ上がらない)。⚠ 探す欄以外へ移るときは**控えを捨てる**。
   */
  listen(
    root,
    'blur',
    (ev) => {
      const ta = ev.target;
      if (!(ta instanceof HTMLTextAreaElement) || ta.getAttribute('data-pkc-field') !== 'row-source') {
        // 探す欄自身の blur(一覧の行を押す途中)は控えを残す。それ以外の場所から焦点が動いたら古い控えは捨てる
        if (!(ta instanceof HTMLElement) || ta.getAttribute('data-pkc-field') !== 'entry-filter') liveRowMemo = null;
        else if (ev.relatedTarget instanceof Element && !ev.relatedTarget.closest(MEMO_KEEP)) liveRowMemo = null;
        return;
      }
      const to = ev.relatedTarget;
      const lineAttr = ta.getAttribute('data-pkc-row-line');
      const line = lineAttr === null ? Number.NaN : Number(lineAttr);
      const lid = dispatcher.getState().openBody?.lid ?? null;
      liveRowMemo =
        to instanceof HTMLElement &&
        to.getAttribute('data-pkc-field') === 'entry-filter' &&
        lid !== null &&
        Number.isInteger(line)
          ? { root, lid, line, source: ta.value, start: ta.selectionStart, end: ta.selectionEnd }
          : null;
    },
    true,
  );
  /**
   * 🔴 **探す欄とその一覧の外を押したら、控えを捨てる**(#582)。
   * ⚠ 本文の余白のように**焦点を持てない所**を押しても blur は飛ばない ── 控えだけが残り、後の `>` が古い行を開いてしまう。
   */
  listen(
    root,
    'mousedown',
    (ev) => {
      if (liveRowMemo !== null && !(ev.target instanceof Element && ev.target.closest(MEMO_KEEP))) liveRowMemo = null;
    },
    true,
  );
  listen(doc, 'keydown', onShortcut);
  /**
   * 🔴 **1 面(既定)の行の入力欄でも、短縮語 + `Tab` と `${…}` の `Tab` 送りを効かせる**(#1087)。
   *
   * ⚠ 行の欄は自分の `keydown`(`row-swap.ts`)が `Tab` を「行の確定」に使い、**対象の欄に直に付いている**。
   *   ここ(`root` の bubble)では**もう確定された後**なので、**捕捉の段**(`capture`)で先に見る。
   * ⚠ **当たるときだけ**握る ── 短縮語が手前に在るか、次の印が在るとき。当たらなければ何もせず、
   *   今までどおり `Tab` は行の確定(次の行へ渡り歩く)になる。確定を奪わない。
   * ⚠ 変換中(`isComposing`)の `Tab` は IME のもの。`Shift`/`Ctrl`/`Alt`/`Cmd` 付きも握らない
   *   (2 列の欄が `Shift`+`Tab` を字下げ戻しに使うのと同じ)。
   */
  const onRowSnippetTab = (ev: Event): void => {
    const ke = ev as KeyboardEvent;
    if (ke.key !== 'Tab' || ke.isComposing || ke.shiftKey || ke.ctrlKey || ke.altKey || ke.metaKey) return;
    const ta = ke.target;
    if (!(ta instanceof HTMLTextAreaElement) || ta.getAttribute('data-pkc-field') !== 'row-source') return;
    if (!runSnippetTab(ta, dispatcher.getState().snippetScan?.items ?? [])) return;
    ke.preventDefault();
    ke.stopPropagation();
  };
  listen(root, 'keydown', onRowSnippetTab, true);
  listen(root, 'keydown', onKeydown);
  // 🔴 波形の上のドラッグ(#1232)── 印は既存の `SET_CAPTURE_TRIM_MARK` に入る
  undo.push(bindWaveDrag(root, dispatcher));
  const teardownLinkPreview = setupLinkPreview(root, dispatcher, services);
  const teardownLightbox = setupLightbox(root);
  return () => {
    // ⚠ 自分が結んだ物だけ外す ── 同じ root に 2 度結んだとき、1 回目の後始末が 2 回目の登録を消さない
    if (ROOT_SERVICES.get(root) === services) ROOT_SERVICES.delete(root);
    setScheduleWriteGate(dispatcher, null);
    /**
     * 🔑 **張った順に、張った物だけを外す**(#876)── 手で並べ直さない。
     * ⚠ かつてここは 19 行の `removeEventListener` で、**7 件足りなかった**。
     */
    teardownLightbox();
    teardownLinkPreview();
    for (const off of undo) off();
    undo.length = 0;
    closeContextMenu(root);
    closeLinkPreview(root);
    closeLightbox(root);
    longPress.dispose();
  };
}
