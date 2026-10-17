/**
 * 🔴 **「操作を探す」の各行の右端に出す場面の名前**(#582 段③。🟣 Gemini の回答 = #1163 の依頼 16 の補足)。
 *
 * ## なぜ要るか
 *
 * 行が 137 を超え、名前だけでは「それが何の場面の操作か」が読めない
 * (「ここを始まりにする」が録音の切り出しだと分かるのは、録音を知っている人だけ)。
 * ⚠ **見出しの節は作らない** ── 絞り込みが探し方の主役で、節を挟むと打った字の結果が読みにくくなる。
 * 場面の名前は**行の右端に薄く 1 語**だけ置く。
 *
 * ## 🔴 出どころは 1 か所(この表)
 *
 * 場面は命令 id から引く。⚠ 操作表(`scripts/operation-table.mjs`)の `scope` / `book` は
 * 「効く先が何か」(ノート / 集まり / 画面 …)の分類で、**画面の場面名**(予定 / 録音 / SQL …)とは軸が違う
 * ので、そこからは導かない。**命令を足したら、この表にも足す** ──
 * 足し忘れは `tests/features/palette-scene.test.ts` が全数で落とす(KEY_COMMANDS の全 id が 1 つずつ持つ)。
 *
 * ## 🔴 場面の名前は用語集の語だけ
 *
 * `SCENES` の字は `ui-terms.ts` の `STANDARD_TERMS` / `TYPE_TERMS` に在る語に限る
 * (test が突き合わせる)。造語の場面名を画面に出さない。
 *
 * 🔑 **pure module**。DOM も時計も持たない。
 */

/** 場面の名前の一覧(画面に出る字そのもの)。⚠ 用語集の語だけ。 */
export const SCENES = [
  'ノート',
  '編集',
  '2 ペイン',
  '予定',
  '録音',
  'SQL',
  '検索',
  '連絡先',
  'スタック',
  'ゴミ箱',
  '画面',
  'システム',
  'アプリ',
] as const;

export type Scene = (typeof SCENES)[number];

const NOTE: Scene = 'ノート';
const EDIT: Scene = '編集';
const PANE2: Scene = '2 ペイン';
const SCHEDULE: Scene = '予定';
const RECORD: Scene = '録音';
const SQL: Scene = 'SQL';
const SEARCH: Scene = '検索';
const CONTACT: Scene = '連絡先';
const STACK: Scene = 'スタック';
const TRASH: Scene = 'ゴミ箱';
const SCREEN: Scene = '画面';
const SYSTEM: Scene = 'システム';
const APP: Scene = 'アプリ';

/** 命令 id → 場面。⚠ `KEY_COMMANDS` の全 id を 1 つずつ(余りも欠けも test が落とす)。 */
export const COMMAND_SCENE: Readonly<Record<string, Scene>> = {
  // ノート ── 開いているノートそのものへの操作
  'create-entry': NOTE,
  'edit-entry': NOTE,
  'deselect-entry': NOTE,
  'copy-entry-link': NOTE,
  'add-relation': NOTE,
  'add-tag': NOTE,
  'append-entry': NOTE,
  'attach-file': NOTE,
  'clear-entry-date': NOTE,
  'open-today': NOTE,
  'open-prev-day-note': NOTE,
  'open-next-day-note': NOTE,
  'open-recent': NOTE,
  'open-copy-history': NOTE,
  'open-note-window': NOTE,
  'move-order-up': NOTE,
  'move-order-down': NOTE,
  'hide-history': NOTE,
  'copy-note-md': NOTE,
  'copy-note-rich': NOTE,
  'copy-selection-md': NOTE,
  'export-note-markdown': NOTE,
  'export-note-pdf': NOTE,
  'export-transcript-srt': NOTE,
  'append-send': NOTE,
  // 編集 ── 本文の欄の中の操作
  'insert-date': EDIT,
  'inline-calc': EDIT,
  'insert-entry-link': EDIT,
  'insert-snippet': EDIT,
  'insert-diagram': EDIT,
  'insert-icon': EDIT,
  'renumber-lists': EDIT,
  'sort-tasks': EDIT,
  'commit-edit': EDIT,
  'cancel-edit': EDIT,
  'row-commit': EDIT,
  'row-cancel': EDIT,
  'edit-all': EDIT,
  undo: EDIT,
  redo: EDIT,
  'format-bold': EDIT,
  'format-italic': EDIT,
  'format-highlight': EDIT,
  'format-ruby': EDIT,
  'format-emdot': EDIT,
  'format-strike': EDIT,
  'format-link': EDIT,
  'format-table': EDIT,
  'format-codeblock': EDIT,
  'format-math': EDIT,
  indent: EDIT,
  outdent: EDIT,
  'move-line-up': EDIT,
  'move-line-down': EDIT,
  'align-table': EDIT,
  'tidy-join-lines': EDIT,
  'tidy-to-halfwidth': EDIT,
  'tidy-kana-to-fullwidth': EDIT,
  'tidy-squeeze-blank-lines': EDIT,
  'tidy-strip-bullets': EDIT,
  // 2 ペイン ── フォルダの一覧と 2 ペイン
  'filer-open': PANE2,
  'filer-open-stack': PANE2,
  'filer-parent': PANE2,
  'filer-trash': PANE2,
  'filer-select-all': PANE2,
  'filer-row-down': PANE2,
  'filer-row-up': PANE2,
  'filer-extend-down': PANE2,
  'filer-extend-up': PANE2,
  'filer-row-first': PANE2,
  'filer-row-last': PANE2,
  'filer-row-page-up': PANE2,
  'filer-row-page-down': PANE2,
  'filer-rename': PANE2,
  'filer-move': PANE2,
  'filer-new-in-folder': PANE2,
  'dual-mark': PANE2,
  'dual-copy-to-other': PANE2,
  'dual-move-to-other': PANE2,
  'dual-rename': PANE2,
  'dual-new-folder': PANE2,
  'dual-new-note': PANE2,
  'dual-other-pane': PANE2,
  'dual-preview': PANE2,
  'dual-tab-add': PANE2,
  'toggle-filer-flatten': PANE2,
  'pc-pick-folder': PANE2,
  // 予定
  'schedule-quick-add': SCHEDULE,
  'schedule-today': SCHEDULE,
  'export-schedule-ics': SCHEDULE,
  'toggle-show-done': SCHEDULE,
  'toggle-show-archived': SCHEDULE,
  'toggle-show-undated': SCHEDULE,
  // 録音(録画・時間を計るを含む)
  'start-audio-capture': RECORD,
  'start-screen-capture': RECORD,
  'start-timer': RECORD,
  'stop-capture': RECORD,
  'capture-stop': RECORD,
  'capture-trim-start': RECORD,
  'capture-trim-end': RECORD,
  'capture-trim-run': RECORD,
  'capture-trim-clear': RECORD,
  // SQL
  'run-sql': SQL,
  'sql-er-toggle': SQL,
  'sql-schema-to-note': SQL,
  'sql-to-note': SQL,
  'view-sql': SQL,
  // 検索 ── 探す欄・置換・一致の帯・絞り
  'focus-search': SEARCH,
  'toggle-replace': SEARCH,
  'replace-all': SEARCH,
  'search-jump-next': SEARCH,
  'search-jump-prev': SEARCH,
  'search-jump-end': SEARCH,
  'clear-kind-filter': SEARCH,
  // 連絡先
  'contacts-quick-add': CONTACT,
  'export-vcards': CONTACT,
  // スタック
  'stack-save': STACK,
  'stack-push': STACK,
  'stack-open': STACK,
  'stack-clear': STACK,
  // ゴミ箱
  'show-trash': TRASH,
  'hide-trash': TRASH,
  'undo-trash': TRASH,
  // 画面 ── 中央の切り替え・ペインの畳み・戻る/進む
  'close-pane': SCREEN,
  'view-detail': SCREEN,
  'view-query': SCREEN,
  'view-dual': SCREEN,
  'refresh-query': SCREEN,
  'cycle-read-columns': SCREEN,
  'clear-selection': SCREEN,
  'toggle-sidebar': SCREEN,
  'toggle-inspector': SCREEN,
  'toggle-append': SCREEN,
  'toggle-focus-mode': SCREEN,
  'nav-back': SCREEN,
  'nav-forward': SCREEN,
  // システム ── 設定・フラグ・メッセージ・ヘルプ・保存領域
  'open-settings': SYSTEM,
  'open-flags': SYSTEM,
  'open-palette': SYSTEM,
  'open-help': SYSTEM,
  'open-messages': SYSTEM,
  'open-manual-window': SYSTEM,
  'open-system-notices': SYSTEM,
  'export-messages': SYSTEM,
  'export-settings': SYSTEM,
  'db-check': SYSTEM,
  'storage-profile': SYSTEM,
  // アプリ
  'add-url-tile': APP,
};

/** 命令 id の場面。表に無ければ `null`(呼び側は何も出さない ── test が「無い id は 0 件」を見る)。 */
export function sceneOf(id: string): Scene | null {
  return COMMAND_SCENE[id] ?? null;
}
