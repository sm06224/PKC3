/**
 * 🔴 **操作の全数台帳を、崩れたら鳴るようにする**(#582 段①)。
 *
 * ## ⚠ 段①の題は「4 つの登記簿を寄せる」だったが、実測で的を外していた
 *
 * 5 つの登記簿(71 id)の**重なりは 1 件だけ**(`cycle-read-columns`)── つまり
 * **重複ではなく分割**なので、寄せても消える重複が無い(「三つの似た行 > 早すぎる helper」)。
 *
 * 🔴 **本当の穴は「操作の id 空間が 2 つある」こと**だった:
 *
 * | | 数 |
 * |---|---|
 * | `data-pkc-action` の受け手 | 183 |
 * | 登記簿の id | 71 |
 * | 両方に在る | **30** |
 * | 受け手の表の外に在る登記 | **41**(うち橋で繋がっているのは 15) |
 * | どの登記簿にも無い受け手 | **153** |
 *
 * 🔑 だから台帳の仕事は「寄せる」ではなく **2 つの空間を突き合わせて、
 * 繋がっていない分を名指しする**ことである ── R7(一貫性の検査)の足場。
 *
 * ## ⚠ 数え方を 2 度まちがえた(この test が生まれた理由)
 *
 * 1. `classify()` は **`Map`** を返すのに `kinds[id]` と書いたので、
 *    **183 件が揃って `null`** になっていた ── 数字が出ないので空振りに見えない。
 * 2. 「出口を受け手だけで探したから `toggle-sidebar` が 0 件に見える」と書きかけたが、
 *    🔴 **それも誤り**だった ── 実測すると走査を広げても **1 件も増えない**。
 *    ボタンの綴りは `toggle-pane` + `data-pkc-pane` なので、鍵の id は
 *    **どちらの走査でも当たらない**。🔑 誤読を直したのは**橋**のほうである。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- CI script は素の .mjs(ビルド対象外)
import { registries, summary, table } from '../scripts/operation-table.mjs';

interface Row {
  id: string;
  receiver: boolean;
  books: string[];
  label: string | null;
  arg: string | null;
  screens: string[];
  bridge: string | null;
}
interface Summary {
  total: number;
  receivers: number;
  registered: number;
  both: number;
  outsideActionsTable: { id: string; bridge: string | null }[];
  unbridged: string[];
  unregistered: number;
  scanned: number;
  sharedBooks: { id: string; books: string[] }[];
  perBook: Record<string, number>;
}
const s = (): Summary => (summary as () => Summary)();
const rows = (): Row[] => (table as () => Row[])();
const reg = (): Record<string, { id: string }[]> =>
  (registries as () => Record<string, { id: string }[]>)();

/**
 * 🔴 **押し所へ辿る道が、この走査から見えない登記**。
 *
 * ⚠ **件数をここに書かない**(2026-09-13 に直した ── 「26 件」と書いてあったが
 *   実際は 34 件だった)。🔑 **一覧そのものが正本**である
 *   ── 数を 2 か所に書くと、足した日に片方が嘘になる(CLAUDE.md §7)。
 *
 * ⚠ **「押せない」ではない** ── 専用の listener で受けている物が居る。
 * 🔑 **身元で pin する**(件数ではなく)── 同じ数だけ取り違えても件数は合う。
 * 🔑 減らしたら**ここから消す**ので、直したことを忘れられない。
 */
const UNBRIDGED: readonly string[] = [
  'append-send',
  /**
   * 🔴 #1032「ノートを閉じる」── **押し所を作らないのが、この直しの中身**である。
   * ⚠ 戻り道が 1 つも無かったのを直すのに、**新しい字を画面に出さない**形を採った:
   *   マウスは「一覧の何も無い所を押す」(`data-pkc-action` を持たない)、
   *   キーボードは近道の設定で user が鍵を割り当てる。
   * 🔑 だから「押し所へ辿れない」は**狙いどおり**であって、抜けではない。
   */
  'deselect-entry',
  'dual-copy-to-other',
  'dual-mark',
  'dual-move-to-other',
  'dual-new-folder',
  'dual-new-note',
  'dual-other-pane',
  'dual-preview',
  'dual-rename',
  'edit-all',
  // ⚠ 2026-09-05(#215): 左の列の行の鍵 3 つ ── `runFilerKey` の `FILER_KEY_ACTION` で受ける
  'filer-rename',
  'filer-move',
  'filer-new-in-folder',
  'filer-extend-down',
  'filer-extend-up',
  'filer-open',
  'filer-parent',
  'filer-row-down',
  'filer-row-up',
  'filer-select-all',
  'filer-trash',
  'focus-search',
  /**
   * ⚠ 2026-09-08(#766 D-2): その場で計算する。**押しボタンを持たない** ──
   *   書式の帯は 14 個で横に長く、これ以上増やせない(D-3 を退けた理由)ので、
   *   記法(`FORMAT_OF`)と同じ「本文の欄へ当てる命令」の継ぎ目(`EDITOR_RUN`)で受ける。
   * 🔑 だから `SHORTCUT_BUTTON` には載らない ── 「辿れない」のは意図である。
   */
  'inline-calc',
  'redo',
  'row-cancel',
  'row-commit',
  /**
   * ⚠ 2026-09-05(#633 段②): スタックの 3 手。押しボタンを持たない(帯は載せていないと
   *   出ない)ので `runGlobalCommand` の特例で受ける ── `view-dual` と同じ「辿れない」形。
   */
  'stack-clear',
  'stack-open',
  'stack-push',
  'toggle-focus-mode',
  'undo',
  'view-detail',
  'view-dual',
  // ⚠ 2026-09-09(#681 段②)── SQL の面も押しボタンを持たない(組み込みタイルから別窓)
  'view-sql',
];

/**
 * 🔴 **名前で呼べるはずなのに、まだ登記していない操作**(#582 段②-1)。
 *
 * ## なぜ身元で pin するか
 *
 * ⚠ ここは **2026-09-13 まで件数だけ**(`unregistered: 204`)を見ていた ──
 *   だから押し所を足した人は**数字を 1 つ上げてコメントを 1 行足す**だけで通り、
 *   実測で **2 週間に +51 件**増えた(153 → 204)。
 * 🔑 身元で pin すると、**その id をここへ書き足す**ことになる ── 書けば
 *   「名前で呼べない操作をまた 1 つ増やした」が diff に出る。
 *   `UNBRIDGED` と同じ作法である(等値 pin の既知リストは、直したら消さないと落ちる)。
 *
 * ## なぜ 2 つに割るか
 *
 * 🔑 **こちらは「段③ の在庫」である。** `scripts/action-scope-survey.mjs` の仕分けで
 *   `N`(押した所から何も要らない)/ `E` / `P2`(state に「いまのそれ」が在る)/ `V` は、
 *   **押した 1 つを指さなくても実行できる** ── つまりパレットから撃てる。
 * ⚠ 下の `UNREGISTERED_POINT`(`P1` = 真の点)は指さないと始められないので、
 *   登記しても**パレットからは撃てない**。混ぜると「在庫がいくつか」が読めなくなる。
 *
 * ⚠ **この一覧は減る方向にしか動かないのが望ましい** ── 増やすなら、
 *   なぜ名前で呼べないままにするのかを 1 行添えること。
 */
const UNREGISTERED_NAMEABLE: readonly string[] = [
  'add-place', 'add-relation', 'add-tag', 'add-url-tile', 'adopt-external-images',
  'adopt-link-icon', 'allow-external-images', 'append-entry', 'apply-plan', 'apply-settings',
  'apply-update', 'attach-file', 'bulk-tag-add', 'bulk-tag-remove', 'capture-stop',
  /**
   * ⚠ **2026-09-14(#683 段②a)で 4 件増やした** ── 録った音の前後を削る
   *   (印を付ける 2 つ・消す・切り出す)。⚠ **名前で呼べないままにする理由**:
   *   印は**いま鳴っている所**の時刻なので、**鳴らしていなければ意味を持たない**
   *   ── パレットから「ここから」と呼んでも、何時何分が入るのか決まらない。
   * 🔑 `capture-play` / `capture-stop` と同じ扱いである(並びを揃えた)。
   */
  'capture-trim-clear', 'capture-trim-end', 'capture-trim-run', 'capture-trim-start',
  'choose-office-pack', 'clear-copy-history', 'clear-entry-date', 'clear-entry-filter',
  'clear-kind-filter', 'clear-opened-history', 'clear-selection', 'close-pane',
  /**
   * ⚠ **2026-09-17(#986 段③)** ── 入れ物ごと捨てる。
   * 🔑 **名前で呼べないままにする理由**:取り消せない操作を、パレットから
   *   1 語で呼べる所に置かない(押し所は設定の中の 1 つだけ)。
   */
  /**
   * ⚠ **2026-09-18(#1006)** ── 中身を残して、入れ物だけ作り直す。
   * 🔑 名前で呼べないままにする理由はすぐ下と同じ(押し所は設定の中の 1 つだけ)。
   */
  'container-rebuild',
  'container-reset',
  'contacts-quick-add', 'copy-block-md', 'copy-chapter-md', 'copy-note-md', 'copy-note-rich',
  'copy-section-ref', 'copy-selection-md', 'db-check',
  'delete-selected', 'deny-external-images',
  'discard-capture', 'dismiss-announce', 'dismiss-notices', 'dismiss-update', 'dual-back',
  'dual-bookmark', 'dual-copy', 'dual-delete', 'dual-focus', 'dual-forward', 'dual-mkdir',
  'dual-mknote', 'dual-move', 'dual-preview-toggle', 'dual-rename-begin', 'dual-row',
  'dual-sort', 'dual-tab-add', 'dual-tab-close', 'end-tile-reorder', 'enter-folder',
  'export-settings', 'export-vcards', 'force-release', 'format-text', 'hide-history',
  'hide-revision-preview', 'hide-trash', 'insert-diagram', 'insert-icon', 'install-office-pack',
  'launch-asset', 'launch-asset-extension', 'launch-asset-raw', 'move-order-down',
  'move-order-up', 'mute-announce', 'next-announce', 'open-manual-window',
  /**
   * ⚠ **2026-09-21(#1017 段③-2)で 1 件増やした** ── ヘルプの「お知らせを開く」。
   *   🔑 押した所から**何も要らない**(`open-manual-window` と同じ仕分け ──
   *   行き先は固定で、鍵も持たない)。
   */
  'open-system-notices', 'open-today',
  'paste-many-copied', 'phone-menu', 'phone-page', 'pick-app-icon', 'pick-create-kind',
  /**
   * ⚠ **2026-09-14(#530 案 A)で 5 件増やした** ── 板の形(四角 / 角丸 / 丸 /
   *   ひし形 / 矢印)。⚠ **名前で呼べないままにする理由**:押し口は
   *   **板の右クリック**だけで、`menuCarriedBlock` が運ぶ**その板の行**が要る
   *   ── パレットから「ひし形にする」と呼んでも、どの板かが決まらない。
   * 🔑 同じ理由で `raise-place` / `remove-place` も未登記である(並びを揃えた)。
   */
  'place-shape-arrow', 'place-shape-diamond', 'place-shape-ellipse', 'place-shape-rect',
  'place-shape-round',
  'purge-trash', 'raise-place', 'refresh-query', 'remove-office-pack', 'remove-place',
  'rename-attachment', 'renumber-lists', 'replace-all', 'reset-app-group-order', 'reset-flags',
  'reset-office-profile', 'retry-persist', 'run-sql', 'schedule-nav', 'schedule-quick-add',
  'schedule-today', 'select-entry', 'set-alarm-enabled', 'set-app-group', 'set-app-icon',
  'set-app-open-target', 'set-browse', 'set-column-rule', 'set-editor-mode', 'set-entry-date',
  'set-entry-sort', 'set-external-images', 'set-flag', 'set-notices-enabled', 'set-open-in-edit',
  'set-open-place', 'set-page-format', 'set-paste-source', 'set-phone-links', 'set-prose-align',
  'set-query-key', 'set-read-columns', 'set-sql-engine', 'set-sql-source', 'set-sql-text', 'set-tag-badge',
  'set-text-scale', 'set-theme', 'set-too-narrow-enabled', 'set-view', 'set-voice-boost',
  'show-trash', 'skip-to',
  'smart-cond-add', 'smart-evict', 'smart-field',
  /**
   * ⚠ **2026-09-14(#918 段②a)で 1 件増やした** ── 前に打った SQL の一覧を出す
   *   (`sql-history-menu`)。⚠ **名前で呼べないままにする理由**:この面の中だけの
   *   憶え(20 件・読み込み直すと消える)を開く口で、**面を開いていないと意味が無い**。
   *   🔑 撃つ相手(`sql-history-pick`)のほうは `UNREGISTERED_POINT` に居る。
   */
  'sql-history-menu',
  /**
   * ⚠ **2026-09-14(#918 段④)で 2 件増やした** ── 答えを file へ書き出す
   *   (出す口 `sql-export-menu` と、形を選ぶ口 `sql-export-pick`)。
   *   ⚠ **名前で呼べないままにする理由**:どちらも「**いま出ている答え**」に効くので、
   *   SQL の面を開いて走らせていないと意味が無い(`sql-to-note` と同じ仕分け)。
   */
  'sql-export-menu', 'sql-export-pick', 'sql-schema-to-note', 'sql-to-note',
  /**
   * ⚠ **2026-09-15(#918 段⑤)で 1 件増やした** ── つながり図を開く / 閉じる。
   *   ⚠ **名前で呼べないままにする理由**:SQL の面を開いていないと出す先が無い
   *   (`sql-schema-to-note` と同じ仕分け)。🔑 押した 1 つは要らないので、
   *   こちら(在庫)の側である ── 図の中の 3 つは `UNREGISTERED_POINT` に居る。
   */
  'sql-er-toggle',
  /**
   * ⚠ **2026-09-16(#918 段⑤d-1)で 1 件増やした** ── 「繋ぐ」モードの入切
   *   (外部キーの宣言が無い DB でも、自分でキーどうしを繋げるようにする)。
   *   ⚠ **名前で呼べないままにする理由**:`sql-er-toggle` と同じ ── つながり図の
   *   帯にしか無い押し所で、SQL の面を開いていないと出す先が無い。
   */
  'sql-er-connect-toggle',
  'stack-save',
  'start-audio-capture', 'start-edit', 'start-screen-capture', 'start-tile-reorder',
  'start-timer', 'stop-capture', 'storage-profile', 'swap-open', 'table-to-csv',
  'table-to-markdown', 'toggle-all-app-groups', 'toggle-app-tile',
  /**
   * ⚠ **2026-09-21(#1017 段③-1)** ── 「作り直す・初期化する を出す」の開閉。
   * 🔑 `toggle-plan-apply` と同じ仕分け(N・押した所から何も要らない。開くか
   *   閉じるかは `container-repair-box` の `hidden` だけで決まる)。
   */
  'toggle-container-repair', 'toggle-create-menu',
  'toggle-kind-filter', 'toggle-pane',
  /**
   * ⚠ **2026-09-21(#1017 段④b)** ── 貼り付け欄の開閉(「整理案を適用」)。
   * 🔑 `toggle-pane` / `toggle-heading-fold` と同じ仕分け(N・押した所から
   *   何も要らない。開くか閉じるかは `plan-apply-box` の `hidden` だけで決まる)。
   */
  'toggle-plan-apply', 'toggle-show-archived', 'toggle-show-done',
  'toggle-show-undated', 'toggle-todo', 'undo-append', 'undo-import', 'undo-move', 'use-copied',
  /**
   * ⚠ **2026-09-21(設計 doc §7、段②a)で 3 件増やした** ── メッセージを開く /
   *   保管件数を選ぶ / 書き出す。🔑 押し所は状態の行の 1 個所と「システム」の
   *   節の中にしか無く、鍵も持たない(`system-jump` / `set-prose-align` と同じ仕分け)。
   */
  'export-messages', 'open-messages', 'set-message-cap',
];

/**
 * 🔴 **真の点 ── 押した 1 つを指さないと始められない操作**(#582 段②-1)。
 *
 * ⚠ **登記していないのは欠陥ではない。** パレットは「名前で呼ぶ」口なので、
 *   「どのセルか」「どの日か」「どの履歴の行か」が要る操作は、そこから撃てない。
 * 🔑 それでも**身元で持つ**理由は 2 つ:
 *   ① 上の在庫との境目を機械で見張る(仕分けが変わったら落ちる)
 *   ② 受け手が増えたとき、**どちらの箱に入れたか**を書かせる
 */
const UNREGISTERED_POINT: readonly string[] = [
  'append-at-heading', 'browse-archive', 'capture-play', 'copy-asset-ref', 'copy-md-block',
  'deliver-to-extension', 'discard-timer', 'dismiss-alarm', 'download-asset',
  'dual-bookmark-open', 'dual-bookmark-remove', 'dual-crumb', 'dual-tab-activate', 'edit-cell',
  'edit-from-heading', 'export-diagram', 'filter-by-tag', 'move-app-group-down',
  'move-app-group-up', 'move-tile-down', 'move-tile-up', 'navigate-asset-ref',
  'navigate-card-ref', 'navigate-entry-ref', 'open-alarm', 'open-office', 'open-repeat-menu',
  'open-tile', 'open-tile-as', 'pick-app-group-icon', 'preview-revision', 'remove-relation',
  'restore-revision', 'restore-trash', 'revoke-extension', 'revoke-same-origin',
  'schedule-pick-day', 'schedule-quick-here', 'set-task-repeat', 'shape-cell',
  'smart-cond-remove',
  /**
   * ⚠ **2026-09-15(#918 段⑤)で 3 件増やした** ── つながり図の中の押し所
   *   (四角の表の名前 / 列 / 線の札)。🔑 **押した 1 つでしか対象が決まらない**
   *   ので、登記してもパレットからは撃てない(`edit-cell` と同じ仕分け)。
   */
  'sql-er-column', 'sql-er-link', 'sql-er-table',
  /**
   * ⚠ **2026-09-16(#918 段⑤d-1)で 1 件増やした** ── 自分で引いた線の札を消す。
   *   🔑 **押した 1 つ**(どの線か)でしか対象が決まらないので、こちらの箱にする
   *   (`sql-er-link` と同じ仕分け)。
   */
  'sql-er-unlink',
  /**
   * ⚠ **2026-09-14(#918 段②a)で 1 件増やした** ── 履歴の一覧から 1 件選ぶ。
   *   🔑 **真の点である** ── 並んだ兄弟(前に打った字)のうち**押した 1 つ**で
   *   どれかが決まり、state に「いまのその 1 件」は無い。
   */
  'sql-history-pick', 'stack-link-down', 'stack-link-up', 'stop-timer',
  /**
   * ⚠ **2026-09-20(#1017 段⓪)で 1 件増やした** ── 「システム」の目次から節へ飛ぶ。
   *   🔑 同時に見えている兄弟(目次の行)のうち**押した 1 つ**でしか対象が決まらない
   *   (`toc-jump` と同じ仕分け)。
   */
  'system-jump', 'toc-jump',
  'toggle-app-group', 'toggle-heading-fold', 'toggle-task', 'unschedule-task', 'unsplit-entry',
  'untag-entry', 'view-asset', 'view-big',
];

describe('操作の全数台帳(#582 段①)', () => {
  it('数が動いたら鳴る', () => {
    const x = s();
    expect({
      total: x.total,
      receivers: x.receivers,
      registered: x.registered,
      both: x.both,
      outsideActionsTable: x.outsideActionsTable.length,
      unregistered: x.unregistered,
    }).toEqual({
      // ⚠ 2026-09-21(#1032): 「ノートを閉じる」(`deselect-entry`)で登記 +1 / total +1。
      //   受け手は増えない ── 押し所を作らない直しなので、マウスの側は「一覧の
      //   何も無い所を押す」(`data-pkc-action` を持たない)である
      // ⚠ 2026-09-16(#971 段③): 壊れを調べる / 拾い出す(`db-check` / `db-rescue`)で
      //   受け手 +2(登記は増えない ── 押し口は設定の中にしか無く、鍵も持たない)
      // ⚠ 2026-09-13(#884 段①): アプリの開き方(`set-app-open-target`)で受け手 +1
      //   (登記は増えない ── 押し口は設定の欄にしか無く、鍵も持たない)
      // ⚠ 2026-09-13(#853 段①): 本文へ図案を入れる(`insert-icon`)で受け手 +1
      //   (登記は増えない ── 押し口は書式パネルにしか無く、鍵も持たない)
      // ⚠ 2026-09-13(#856 段②): リンク先の印を取り込む(`adopt-link-icon`)で受け手 +1
      //   (登記は増えない ── 押し口は添付の設定の中にしか無く、鍵も持たない)
      // ⚠ 2026-09-13(#857 段④): グループを畳む(`toggle-app-group`)で受け手 +1
      //   (登記は増えない ── 押し口は見出しの中にしか無く、鍵も持たない)
      // ⚠ 2026-09-13(#855 段 0 の 3 つ目): 札の繰り返し(`open-repeat-menu` /
      //   `set-task-repeat`)で受け手 +2(登記は増えない ── 押し口は札の右クリックの
      //   中にしか無く、鍵も持たない)
      // ⚠ 2026-09-13(#857 段①b-2): 並べ替えモードの出入り(`start-tile-reorder` /
      //   `end-tile-reorder`)で受け手 +2(登記は増えない ── 押し口はタイルの右クリックと
      //   一覧の「完了」だけで、鍵も持たない)
      // ⚠ 2026-08-31: `open-manual-window`(#645)で 1 増えた
      // ⚠ 2026-09-02: `phone-page` / `phone-menu`(#632 段①)で 2 増えた
      // ⚠ 2026-09-04: 小窓・板・章コピー・図の一覧・断り書きの設定など(#690 #677 #676 #528 #687 #278)で 8 増えた(229 → 237。別 worktree の合算 ── #724 ③で実測に合わせた)
      // ⚠ 2026-09-05: 塊の移動の「元に戻す」`undo-move`(#684 段①)で受け手が 1 増えた
      // ⚠ 2026-09-05(#215): 行の右クリックからの整理 3 つ(`rename-entry-begin` / `move-to-folder` /
      //    `create-in-folder`)── 受け手 +3、`ENTRY_MENU_ACTIONS` にも載るので registered / both も +3
      // ⚠ 2026-09-05(#215): 鍵 `filer-rename` / `filer-move` / `filer-new-in-folder` で登記 +3
      //    (受け手の表の外 ── `runFilerKey` が `FILER_KEY_ACTION` で受ける)
      // ⚠ 2026-09-05(#579): `copy-section-ref`(見出しの右クリック ── 登記簿の外の受け手)で +1
      // ⚠ 2026-09-05(#633 段②): スタックの鍵 3 件(`stack-push` / `stack-open` / `stack-clear`)で
      //    登記が 3 増えた(受け手は増えない ── `runGlobalCommand` の特例で受ける)
      // ⚠ 2026-09-05(#633 段③): 保存したスタック ── 受け手 `stack-save`(帯の「保存…」)と
      //    `stack-load`(行のメニュー / 情報ペイン、登記あり)で受け手 +2 / 登記 +1
      // ⚠ 2026-09-05(#633 段④): 入れ物の中の「上へ / 下へ」(`stack-link-up` / `stack-link-down`)で
      //    受け手 +2(登記は増えない ── 押した行が要る P1 なので、名前だけでは呼べない)
      // ⚠ 2026-09-05(#720): スキップリンク `skip-to` の受け手で +1
      // ⚠ 2026-09-05(#708 段②): 表の形を変える 2 つ(`table-to-markdown` / `table-to-csv`)で
      //    受け手 +2 ── 登記は増えない(本文の右クリックにだけ出る。`BODY_MENU_ACTIONS` には
      //    入れていない ── あちらは「読んでいる見え方を変える」物の表である)
      // ⚠ 2026-09-08(#766 D-2): その場で計算する ── 登記 +1(押し所は持たない。
      //    記法と同じ「本文の欄へ当てる命令」の継ぎ目で受けるので、受け手は増えない)
      // ⚠ 2026-09-08(#722): 本文の置き場所(`set-prose-align`)で受け手 +1
      //   ── 設定の選択欄が受ける。鍵は割り当てない(設定で選ぶ物なので登記も増えない)
      // ⚠ 2026-09-09(#679): まとめて貼る(`paste-many-copied`)で受け手 +1
      //   ── コピーした物のメニューにだけ出る(登記は増えない)
      // ⚠ 2026-09-09(#818): 書庫の中を見る(`browse-archive`)で受け手 +1
      //   ── 添付の行にだけ出る(登記は増えない)
      // ⚠ 2026-09-09(#826): 開く場所(`set-open-place`)で受け手 +1
      //   ── 設定の選択欄が受ける(`set-prose-align` と同じ形。登記は増えない)
      // ⚠ 2026-09-09(#681 段②): SQL の面 ── 受け手 +2(`set-sql-text` / `run-sql`)。
      //   登記は増えない(面そのものは `set-view` で開く。欄と押し所はその面の中にしか無い)
      // ⚠ 2026-09-09(#681 段②): 鍵 `view-sql` で登記 +1(受け手は増えない ──
      //   `runGlobalCommand` の特例で受ける。押しボタンを持たない面である)
      // ⚠ 2026-09-09(#681 段③): 答えをノートへ(`sql-to-note`)で受け手 +1
      //   ── SQL の面の中にしか無い押し所(登記は増えない。`run-sql` と同じ)
      // ⚠ 2026-09-09(#681 段③): 調べる相手(`set-sql-source`)で受け手 +1
      //   ── SQL の面の中の選択欄(登記は増えない)
      // ⚠ 2026-09-09(#278 段②): 本文の電話番号(`set-phone-links`)で受け手 +1
      //   ── 設定の checkbox が受ける(`set-alarm-enabled` と同じ形。登記は増えない)
      // ⚠ 2026-09-09(#683 段①): 録ったものの面 ── 受け手 +2
      //   (`capture-play` / `capture-stop`)。登記は増えない ── 面そのものは
      //   `set-browse` / `set-view` で開き、押し所はその面の中にしか無い
      // ⚠ 2026-09-09(#809-4): 知らせの隣の「開く」が `select-entry` から
      //   `swap-open` へ分かれて受け手 +1(登記は増えない ── 押し口は状態の行の
      //   隣 1 か所で、そこは登記の対象ではない)
      // ⚠ 2026-09-09(#813): 「居場所」のプルダウンを外して `move-entry` の受け手が
      //   消え、受け手 −1(登記は動かない ── 押し口は面の中にしか無かった)
      // ⚠ 2026-09-11(#215 残り①): 最近開いた記録を消す(`clear-opened-history`)で
      //   受け手 +1(登記は増えない ── 押し口は設定の面の中にしか無い)
      // ⚠ 2026-09-12(#770 段②): タイルの目印を絵から選ぶ(`pick-app-icon`)で
      //   受け手 +1(登記は増えない ── 押し所は添付の詳細面の中にしか無い。
      //   `set-app-icon` と同じ置き場である)
      // ⚠ 2026-09-12(#857 段①): タイルの「上へ / 下へ」(`move-tile-up` /
      //   `move-tile-down`)で受け手 +2 ── 登記は増えない(押した 1 枚が要る P1 で、
      //   名前だけでは呼べない。`stack-link-up` / `stack-link-down` と同じ仕分け)
      // ⚠ 2026-09-13(#857 段④の仕上げ): すべて畳む / すべて開く
      //   (`toggle-all-app-groups`)で受け手 +1 ── 登記は増えない(押し所は
      //   アプリの一覧の中にしか無く、`toggle-app-group` と同じ置き場である)
      // ⚠ 2026-09-13(#857 段②): グループの目印を選ぶ(`pick-app-group-icon`)で
      //   受け手 +1 ── 登記は増えない(押し所は見出しの右クリックの中にしか無い)
      // ⚠ 2026-09-13(#857 段③): グループの「上へ / 下へ」で受け手 +2 ──
      //   登記は増えない(押し所は見出しのメニューの中にしか無い)
      // ⚠ 2026-09-13(#857 段③): 「名前順に戻す」で受け手 +1 ── 登記は増えない。
      //   🔑 仕分けは **N(名詞)** ── 全部の群に効くので、どの見出しを押したかに依らない
      //   (押し所は見出しのメニューに在るが、**効く先は target で決まらない**)
      // ⚠ 2026-09-13(#884 段②): その場だけの開き方(`open-tile-as`)で受け手 +1
      //   ── 登記は増えない(押し所はタイルの右クリックの中にしか無い)
      // ⚠ 2026-09-14(#530 案 A): 板の形 5 つ(`place-shape-*`)で受け手 +5
      //   (登記は増えない ── 押し口は板の右クリックの中にしか無く、鍵も持たない)
      // ⚠ 2026-09-14(#683 段②a): 録った音の前後を削る 4 つ(`capture-trim-*`)で
      //   受け手 +4 ── 登記は増えない。🔑 押し所は**鳴らしている行の中**にしか無く、
      //   印は「いま鳴っている所」の時刻なので、名前だけでは呼べない
      //   (`capture-play` / `capture-stop` と同じ仕分け)
      // ⚠ 2026-09-14(#772 段① B): 聞くときだけ音を整える(`set-voice-boost`)で
      //   受け手 +1 ── 登記は増えない(押し口は設定の checkbox にしか無く、鍵も持たない。
      //   `set-alarm-enabled` / `set-phone-links` と同じ形)
      // ⚠ 2026-09-14(#918 段①): 構造をノートへ(`sql-schema-to-note`)で受け手 +1
      //   ── 登記は増えない(押し所は SQL の面の中にしか無く、鍵も持たない。
      //   `run-sql` / `sql-to-note` と同じ仕分け)
      // ⚠ 2026-09-14(#918 段②a): 履歴の一覧(`sql-history-menu` / `sql-history-pick`)で
      //   受け手 +2 ── 登記は増えない(押し所は SQL の面の中にしか無く、鍵も持たない)。
      //   🔑 2 つに割れているのは**出す口**と**選ぶ口**が別だから ── 選ぶ口は
      //   メニューの中に並ぶので「押した 1 つ」でしか対象が決まらない(P1)。
      // ⚠ 2026-09-14(#918 段④): 答えを file へ(`sql-export-menu` / `sql-export-pick`)で
      //   受け手 +2 ── 登記は増えない。🔑 こちらの選ぶ口は**閉じた 3 つ**なので `E`
      //   (履歴の選ぶ口が `P1` なのと違う ── 並ぶ物が user の打った字ではない)。
      // ⚠ 2026-09-15(#918 段⑤): つながり図(`sql-er-toggle` / `-table` / `-column` /
      //   `-link`)で受け手 +4 ── 登記は増えない。🔑 開く口は SQL の面の中にしか
      //   無く、図の中の 3 つは**押した 1 つ**でしか対象が決まらない(P1)
      // ⚠ 2026-09-15(#682 段②): どのエンジンで引くか(`set-sql-engine`)で受け手 +1
      //   ── 登記は増えない(押し口は SQL の面の中にしか無く、鍵も持たない。
      //   すぐ隣の `set-sql-source` と同じ扱い)
      // ⚠ 2026-09-15(#950): 帯には在ったが「操作を探す」から呼べなかった 3 つ
      //   (`format-table` / `format-codeblock` / `format-math`)を `KEY_COMMANDS` へ
      //   登記した ── 受け手は増えない(帯のボタンが既に受けている。橋は `FORMAT_OF`)。
      //   registered / outsideActionsTable / total が +3(受け手ではないので
      //   both / receivers / unregistered は動かない)。
      // ⚠ 2026-09-16(#918 段⑤d-1): 「繋ぐ」モード(`sql-er-connect-toggle` /
      //   `sql-er-unlink`)で受け手 +2 ── 登記は増えない(押し所はつながり図の
      //   帯 / 札にしか無く、鍵も持たない。`sql-er-toggle` / `sql-er-link` と同じ仕分け)。
      // ⚠ 2026-09-16(#986 壊れても戻せる): 「拾って、戻せる形で書き出す」
      //   (`db-rescue-archive`)で受け手 +1 ── 登記は増えない
      //   (押し所は設定の中にしか無く、鍵も持たない ── すぐ隣の
      //   `db-rescue` / `db-check` と同じ仕分け)。
      // ⚠ 2026-09-17(#986 段③): 「中身を捨てる」(`container-reset`)で受け手 +1
      //   ── 登記は増えない。🔑 **わざと名前で呼べないままにする**:
      //   取り消せない操作なので、パレットから 1 語で呼べる所に置かない
      //   (押し所は設定の中の 1 つだけ。すぐ上の `db-rescue` 3 つと同じ仕分け)。
      // ⚠ 2026-09-18(#1006): 「中身を残して、作り直す」(`container-rebuild`)で受け手 +1
      //   ── 登記は増えない。🔑 **名前で呼べないままにする**:拾い出してから
      //   入れ物を作り直すので、パレットから 1 語で呼べる所に置かない
      //   (押し所は設定の中の 1 つだけ。すぐ下の `container-reset` と同じ仕分け)。
      // ⚠ 2026-09-20(#1017 段⓪): 「システム」の目次から節へ飛ぶ(`system-jump`)で
      //   受け手 +1(登記は増えない ── 押し口は「システム」の中にしか無く、鍵も持たない)。
      // ⚠ 2026-09-21(設計 doc §7、段②a): メッセージ(`open-messages` / `set-message-cap` /
      //   `export-messages`)で受け手 +3 ── 登記は増えない(押し口は状態の行と
      //   「システム」の中にしか無く、鍵も持たない)。
      // ⚠ 2026-09-21(#1017 段④b): 専用の取り出しボタン 2 つ(`db-rescue-archive` /
      //   `db-rescue`)を退役させて受け手 −2、貼り付け欄の開閉(`toggle-plan-apply`)で
      //   受け手 +1 ── net で受け手 −1(登記は動かない ── 3 つとも登記の外)。
      // ⚠ 2026-09-21(#1017 段③-1): 「作り直す・初期化する を出す」の開閉
      //   (`toggle-container-repair`)で受け手 +1 ── 登記は増えない(押し所は
      //   設定の中の 1 つだけ。`toggle-plan-apply` と同じ仕分け)。
      // ⚠ 2026-09-21(#1017 段③-2): これまでのお知らせの入口(`open-system-notices`)で
      //   受け手 +1 ── 登記は増えない(押し口はヘルプの中にしか無く、鍵も持たない。
      //   `system-jump` と同じ仕分け)。
      total: 325,
      receivers: 272,
      registered: 89,
      both: 36,
      outsideActionsTable: 53,
      unregistered: 236,
    });
  });

  /**
   * 🔴 **登記簿は「分割」である** ── 同じ id が 2 冊に載るのは、意図して
   *   **同じ操作を 2 つの面から出している**ときだけ。
   * ⚠ 2026-09-04: `open-note-window` が 2 件目になった(#685、user 裁定)──
   *   行の右クリックと**本文の右クリック**の両方から出す。
   */
  it('🔴 登記簿をまたぐ id は、名指しの 2 件だけ', () => {
    expect(s().sharedBooks).toEqual([
      { id: 'cycle-read-columns', books: ['key', 'body'] },
      // ⚠ 2026-09-04(#690 I5): 鍵(Alt+Shift+W)と「操作を探す」から届くように
      //    `KEY_COMMANDS` にも登記した ── 受け手は情報ペインのボタン 1 つ(橋は `SHORTCUT_BUTTON`)
      { id: 'open-note-window', books: ['key', 'entry', 'body'] },
    ]);
  });

  it('登記簿の内訳が動いたら鳴る', () => {
    // ⚠ 2026-09-04: 本文のメニューが 2 → 3(`open-note-window`)
    // ⚠ 2026-09-04(#690 I5): 鍵が 52 → 53(`open-note-window` を「操作を探す」に出すため)
    // ⚠ 2026-09-05(#215): 行の右クリックが 12 → 15(名前を変える / 移す… / この中に新しいノートを作る)
    // ⚠ 2026-09-05(#215): 鍵が 53 → 56(左の列の行の F2 / F6 / Shift+F4)
    // ⚠ 2026-09-05(#633 段②): 鍵が 56 → 59(スタックの 3 手)
    // ⚠ 2026-09-05(#633 段③): 行のメニューが 15 → 16(`stack-load`)
    // ⚠ 2026-09-08(#766 D-2): 鍵が 59 → 60(その場で計算する)
    // ⚠ 2026-09-09(#681 段②): 鍵が 61 → 62(SQL の面へ)
    // ⚠ 2026-09-15(#950): 鍵が 62 → 65(`format-table` / `format-codeblock` / `format-math`。
    //    どれも `defaults: []` ── 帯に既にボタンが在るので鍵は増やさない)
    // ⚠ 2026-09-21(#1017 段④a): `settings` 5 → 1、新しい 6 本目 `collectionPane` 4 ──
    //    書き出し 4 つが「設定」から右の列(何も選んでいないとき)へ移った。合計は不変。
    // ⚠ 2026-09-21(#1032): 「ノートを閉じる」で `key` 65 → 66(鍵の既定は持たない ──
    //    近道の設定とパレットに行として出て、鍵は user が割り当てる)
    expect(s().perBook).toEqual({
      key: 66,
      entry: 16,
      body: 3,
      collection: 2,
      collectionPane: 4,
      settings: 1,
    });
  });

  it('🔴 押し所へ辿れない登記を、身元で pin する', () => {
    expect([...s().unbridged].sort()).toEqual([...UNBRIDGED].sort());
  });

  it('橋で繋がっている登記は、選択子か記法として辿れる', () => {
    const outside = s().outsideActionsTable.filter((r) => r.bridge !== null);
    // ⚠ 2026-09-15(#950): +3(`format-table` / `format-codeblock` / `format-math`。
    //    橋は `FORMAT_OF` = 'format'、下の全数がそのまま見ている)
    expect(outside.length).toBe(18);
    // ⚠ **中身まで見る** ── `bridge` が空文字でも「繋がっている」に数えないため
    for (const r of outside) {
      expect(r.bridge === 'format' || (r.bridge ?? '').startsWith('button:[')).toBe(true);
    }
  });

  it('🔴 空振り防止: 受け手は全員 種別を持ち、登記は全員 字を持つ', () => {
    const all = rows();
    // ⚠ `classify()` が `Map` であることを踏んだ所 ── 全件 null なら 183 件落ちる
    expect(all.filter((r) => r.receiver && r.arg === null)).toEqual([]);
    expect(all.filter((r) => r.books.length > 0 && r.label === null)).toEqual([]);
    // ⚠ 登記簿が空になったら「未登記が増えた」ではなく**ここ**が落ちる
    for (const [name, list] of Object.entries(reg())) {
      expect(list.length, `${name} が空`).toBeGreaterThan(0);
    }
  });

  it('🔴 id 空間が混ざり始めたら鳴る(いまは 0 件)', () => {
    /**
     * ⚠ 走査を「全 id」へ広げたとき、**1 件も増えなかった**(実測 2026-08-30)。
     *   `toggle-sidebar` のボタンの綴りは `toggle-pane` + `data-pkc-pane` なので、
     *   鍵の id は**どちらの走査でも当たらない** ── 2 つの id 空間は
     *   **橋(`SHORTCUT_BUTTON`)でしか繋がっていない**。
     * 🔑 だからここは 0 件を pin する:**増えたら**、鍵の id が
     *   `data-pkc-action` として直接使われ始めた合図である(混ざると、
     *   同じ操作が 2 つの名前を持ち、台帳が二重に数える)。
     */
    expect(rows().filter((r) => !r.receiver && r.screens.length > 0)).toEqual([]);
    // ⚠ 対照群 ── 受け手の側では出口が実際に見つかっている(走査そのものは生きている)
    expect(rows().filter((r) => r.receiver && r.screens.length > 0).length).toBeGreaterThan(100);
    /**
     * 🔴 **走査の範囲そのものを見る**(変異試験 M3 が SURVIVED で教えた)。
     * ⚠ 上の 2 行だけだと、走査を受け手だけに戻したとき
     *   `!receiver && screens>0` が**空虚に真**になり、**検査ごと消える**。
     */
    expect(s().scanned).toBe(s().total);
  });

  /**
   * 🔴 **未登記を、件数ではなく身元で pin する**(#582 段②-1)。
   *
   * ⚠ 直す前は `unregistered: 204` という**数だけ**だったので、押し所を足した人は
   *   数字を 1 つ上げれば通った ── 実測で 2 週間に **+51 件**増えた。
   * 🔑 身元にすると、増やす人は**その id を書き足す**ことになる。
   */
  it('🔴 名前で呼べない操作を、身元で pin する', () => {
    const un = rows().filter((r) => r.receiver && r.books.length === 0);
    /**
     * 🔴 **空振り防止 ── 数え方が 2 つに割れていないこと。**
     * ⚠ ここで自分で数え直しているので、`summary()` 側の絞り込みを壊しても
     *   この test だけは緑になりうる(CLAUDE.md §7「同じ問いに答える口が 2 つ」)。
     */
    expect(un.length, '未登記の数え方が summary と食い違っている').toBe(s().unregistered);
    expect([...un.map((r) => r.id)].sort()).toEqual(
      [...UNREGISTERED_NAMEABLE, ...UNREGISTERED_POINT].sort(),
    );
  });

  /**
   * 🔴 **2 つの箱の境目は、仕分け(`classify`)と一致していること。**
   *
   * ⚠ これが無いと、在庫(名前で呼べる側)を**黙って「真の点」へ移して**
   *   減らせてしまう ── 数だけ見ていると「進んだ」に見える。
   */
  it('🔴 在庫と「真の点」を取り違えていない', () => {
    const argOf = new Map(rows().map((r) => [r.id, r.arg]));
    expect(
      UNREGISTERED_NAMEABLE.filter((id) => argOf.get(id) === 'P1'),
      '名前で呼べる側に、真の点(P1)が混じっている',
    ).toEqual([]);
    expect(
      UNREGISTERED_POINT.filter((id) => argOf.get(id) !== 'P1'),
      '「真の点」の箱に、指さなくても呼べる操作が混じっている',
    ).toEqual([]);
    // ⚠ 空振り防止 ── どちらかを空にしても上の 2 つは通る
    expect(UNREGISTERED_NAMEABLE.length, '在庫が空').toBeGreaterThan(100);
    expect(UNREGISTERED_POINT.length, '「真の点」が空').toBeGreaterThan(10);
  });
});
