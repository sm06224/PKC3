/**
 * 🔴 **操作 → 出口の対応表を、崩さないように留める**(#582 の研究 R1 / R7)。
 *
 * ## なぜ要るか
 *
 * PKC3 には受け手が **196 種**(2026-09-05 実測。起票時は 181)あるのに、
 * 「**この操作は画面のどこから押せるか**」を
 * 答える物が **1 つも無かった**。⚠ だから届いていない操作が静かに溜まる ──
 * #500 で「右ペインが唯一の入口」の 6 種が**畳むと画面ごと消える**ことが分かった。
 *
 * 🔑 表を出すのは `scripts/action-outlets.mjs`。ここは**その表が崩れたら鳴る**側である。
 *
 * ## ⚠ 数え方を 2 度まちがえている(2026-08-29。**両方この test が生まれた理由**)
 *
 * 1. **表の外まで走っていた** ── `ACTIONS` の**末尾まで**走査したので、別の表の
 *    `format-bold` / `open-settings` など **19 種**まで拾い、**204 種**と出した
 *    (真は当時 **183**。⚠ この 2 つは 2026-08-29 の数であって、いまの数ではない)。
 *    ⚠ 名前が**それらしい**ので気づけない ── 気づけたのは
 *    「一意 197 / 総数 204」という**内部の食い違い**を数えたからである。
 * 2. 🔴 **同じ綴りが表の中と外の両方に在る**(`insert-snippet` / `insert-entry-link`)。
 *    ⚠ だから「先頭から探して最初に当たった本文」を読むと、**呼び側によって違う本文**を掴む
 *    ── 生成した一覧と検査した一覧が **1 件だけ**食い違った。
 * 🔑 だから本文を切るのは `handlers()` **1 か所**にした(§7)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- CI script は素の .mjs(ビルド対象外)
import { codeOnlyForScan, handlers, receivers, report } from '../scripts/action-outlets.mjs';

interface Row { action: string; screens: string[]; key: boolean }
interface Report { receivers: number; withScreen: number; unresolved: string[]; rows: Row[] }
const r = (): Report => (report as () => Report)();
const bodies = (): Map<string, string> => (handlers as () => Map<string, string>)();
const names = (): string[] => (receivers as () => string[])();

/**
 * 対象(選んだノート / 押した行)を読むか。⚠ 判定は 1 か所に書く。
 *
 * 🔴 **注釈を落としてから当てる**(2026-09-12、#770 段② で踏んだ)。
 * ⚠ 受け手の本文は**次の受け手の手前まで**を切るので、**次の受け手に付けた
 *   docstring** もその中に入る ── そこに `selectedLid` という**字**を書いた瞬間、
 *   **隣の受け手**(`pick-create-kind`)が「対象を読む」と数えられて、下の
 *   等値 pin が落ちた。⚠ 実行する行は 1 行も変わっていないのに、である。
 * 🔑 CLAUDE.md §1「自分の解説コメントに満たされる」── **見るのは実行する行**。
 *   ⚠ この file は #738 で**出口の走査**に同じ直しを当てている(`codeOnlyForScan`)。
 *   同じ罠が**本文の走査**にも在った。
 */
const OBJECT = /selectedLid|data-pkc-entry|data-pkc-lid|multiSelected/;
const readsObject = (body: string): boolean => OBJECT.test(codeOnlyForScan(body));

/**
 * 🔴 **`ACTIONS` の**外**にしか無い綴り**。⚠ これが受け手に混ざったら、
 * 走査が表の終端を越えている(1 の再発)。
 */
const OUTSIDE_ONLY: readonly string[] = ['format-bold', 'open-settings', 'toggle-sidebar'];

/**
 * 🔴 **出口を静的に追えないもの**(変数で `data-pkc-action` を配る経路)。
 *
 * ⚠ **等値で pin する** ── 件数だけだと、同じ数だけ入れ替わっても気づけない。
 * 🔑 増えたら「**また静的に追えない出口を足した**」という合図
 * (減ったら、直したぶんをこの表から消すこと ── 消さないと落ちる = 忘れられない)。
 */
/**
 * ⚠ **2026-08-29 に 2 件減らした** ── `calendar-nav` / `calendar-today` は
 *   #292 段⑤ で中央のカレンダーを外したときの**取り残し**で、`src` 全体に
 *   焼く所が **0 件**、しかも `schedule-nav` / `schedule-today` と本体が同じだった。
 * 🔑 `repo-hygiene` は**逆向き(焼いたのに受け手が無い)しか見ない**ので鳴らなかった
 *   ── この表が、その向きの計器である。
 */
const UNRESOLVED: readonly string[] = [
  /**
   * ⚠ **2026-10-02(#772 段②)で 3 件増えた** ── 音声認識の部品を入れる / やめる / 消す。
   * 🔑 押し所は設定の節が `button(action, label, field)` の**ヘルパーで組む**ので、静的な
   *   `data-pkc-action="install-asr-part"` が source のどこにも無い(`install-office-pack` と同じ ──
   *   出口は在るが、字では追えない)。
   */
  'cancel-asr-install',
  // 台帳 #1852 束 T1(依頼 156 ②)── Office 一式の取り込みをやめる。押し所は設定の節の `button()` ヘルパーで組む(`cancel-asr-install` と同じ)
  'cancel-office-install',
  // #952 仕上げ ▾ の項目 ── メニューの項目として動的に組む(binder が MenuItem の attrs で焼く)ので、静的な data-pkc-action が source に無い
  'capture-process',
  // #1038 A1 選んだノートの書き出し ── 「書き出す ▾」(open-selection-export)の項目として動的に組む(binder が MenuItem で焼く)
  'export-selection-archive',
  'export-selection-html',
  'export-selection-portable',
  'install-asr-part',
  'remove-asr-part',
  'choose-office-pack',
  'dual-back',
  'dual-bookmark',
  'dual-forward',
  'install-office-pack',
  // ⚠ 2026-10-17(#1163 依頼 153): `move-order-down` / `move-order-up` はここから外れた ── 鍵と「操作を探す」から呼べるようにして、
  //   `binder.ts` の `SHORTCUT_BUTTON` に押し口の選択子(`data-pkc-action="move-order-up"`)が静的に載ったため(出口が字で追えるようになった)
  /**
   * ⚠ 2026-10-17(#1621)で 1 件増えた ── 左のペインの「⋯」。押し口は `bar-overflow.ts` が
   *   `BAR_MORE_ACTION` という**定数**で組むので、静的な `data-pkc-action="open-bar-more"` が source のどこにも無い。
   */
  'open-bar-more',
  /**
   * ⚠ **2026-10-02(#215 段①②)で 4 件増えた** ── パソコンのフォルダの押し口(選ぶ / 切る /
   *   さらに表示 / 行を押して取り込む)。⚠ 2026-10-02(#1264 §2)で「更新」(`pc-refresh-folder`)が 1 件増えた。🔑 押し所は `pc-folder.ts` が `button(action, …)` という
   *   **変数の引数**で組むので、静的な `data-pkc-action="pc-…"` が source のどこにも無い
   *   (`set-app-icon` と同じ ── 出口は在るが、字では追えない)。
   * ⚠ 2026-10-25(#215 / #432)で 3 件増えた ── サブフォルダへ入る(`pc-enter-dir`)/ パンくずで戻る(`pc-crumb`)/
   *   Office のファイルを選んで開く(`pc-open-office-file`)。同じく `button(action, …)` で組む。
   *   (旧 `pc-dir-note` は `pc-enter-dir` に替わった。)
   */
  'pc-crumb',
  'pc-cut-folder',
  'pc-enter-dir',
  'pc-more',
  'pc-open-file',
  'pc-open-office-file',
  // ⚠ 2026-10-11(#582 段③ 第 2 群): `pc-pick-folder` は「操作を探す」の受け手(`SHORTCUT_BUTTON`)に字で書かれたので、出口を静的に追えるようになり、この表から抜けた。
  'pc-refresh-folder',
  'remove-office-pack',
  'reset-office-profile',
  'set-app-group',
  'set-app-icon',
  /**
   * ⚠ **2026-09-14(#918 段②a)で 1 件増えた** ── 履歴の一覧から 1 件選ぶ。
   * 🔑 押し所は `openContextMenu` が**その場で組む**ので、静的な
   *   `data-pkc-action="sql-history-pick"` が source のどこにも無い
   *   (`set-app-icon` / `move-order-up` と同じ ── 出口は在るが、字では追えない)。
   */
  /**
   * ⚠ **2026-09-14(#918 段④)で 1 件増えた** ── 書き出す形を選ぶ。
   * 🔑 `sql-history-pick` と同じ理由 ── `openContextMenu` が**その場で組む**ので、
   *   静的な `data-pkc-action="sql-export-pick"` が source のどこにも無い。
   */
  'sql-export-pick',
  'sql-history-pick',
  'toggle-todo',
  /**
   * ⚠ 2026-10-15(#1087): 以前ここに居た `undo-trash` は、命令として登記して `runGlobalCommand` が字で受けるようになったので外した(静的に追えるようになった)。
   * ⚠ 2026-10-18(台帳 #1852 N1 / 依頼 324 A): `undo-dual-move`(2 ペインで移した直後の「元に戻す」)も同じ理由で外した ── 命令として登記し、`runGlobalCommand` が字で受ける。
   */
  /**
   * ⚠ **2026-10-17(#1163 依頼 45 の 2、#1657)で 1 件増えた** ── 題名を変えた直後の「元に戻す」(`undo-rename`)。
   * 🔑 `undo-move` と同じ器(`paintStatusUndo` が `data-pkc-action` を実行時に書き換える)ので、静的な字が source に無い。
   */
  'undo-rename',
  /**
   * ⚠ **2026-10-17(台帳 #1852 G1 / 依頼 109 A)で 1 件増えた** ── まとめてタグを付けた直後の「元に戻す」(`undo-bulk-tag`)。
   * 🔑 `undo-move` と同じ器(`paintStatusUndo` が `data-pkc-action` を実行時に書き換える)ので、静的な字が source に無い。
   */
  'undo-bulk-tag',
  /**
   * ⚠ **2026-10-18(台帳 #1852 Q1 / 依頼 98-2)で 1 件増えた** ── スタックを全部降ろした直後の「元に戻す」(`undo-stack-clear`)。
   * 🔑 `undo-move` と同じ器(`paintStatusUndo` が `data-pkc-action` を実行時に書き換える)ので、静的な字が source に無い。
   */
  'undo-stack-clear',
  /**
   * ⚠ **2026-10-18(台帳 #1852 束 R1)で 1 件増えた** ── 章・見出しへ飛んだ直後の「元の位置へ戻る」(`undo-jump`)。
   * 🔑 `undo-move` と同じ器(`paintStatusUndo` が `data-pkc-action` を実行時に書き換える)ので、静的な字が source に無い。
   */
  'undo-jump',
  /**
   * ⚠ **2026-10-18(台帳 #1852 P1 / 依頼 362)で 1 件増えた** ── AI の書き足しの直後の「書き足しを元に戻す」(`undo-agent-append`)。
   * 🔑 `undo-move` と同じ器(`paintStatusUndo` が `data-pkc-action` を実行時に書き換える)ので、静的な字が source に無い。
   */
  'undo-agent-append',
  'view-big',
];

/**
 * 🔴 **「対象があるときだけ意味があるのに、出口が 1 か所しか無い」操作**。
 *
 * ⚠ その面を畳む・狭くすると **画面から消える**。#500 で 6 種にだけ 2 本目の道を作ったが、
 *   全体では **30 種**在る ── 置き場の規則が無いまま足し算で埋めてきた実体である。
 * 🔑 **#582(操作体系の再設計)の結論が出るまで、ここを増やさない。**
 *   ⚠ 増えたらこの test が落ちる = 「体系の外でまた 1 つ足した」と分かる。
 */
const OBJECT_LONE: readonly string[] = [
  /**
   * 🔴 **2026-09-12 に 7 件減った**(#770 段②)。⚠ **減った理由が 2 通りある**ので分けて書く:
   *
   * | 落ちたもの | なぜ |
   * |---|---|
   * | `bulk-tag-add` / `cycle-read-columns` / `retry-persist` / `stack-save` | 🔴 **最初から嘘だった** ── 実行する行は対象を 1 つも読んでおらず、**注釈の字**(`selectedLid` / `data-pkc-entry`)に満たされて数えられていた |
   * | `launch-asset` / `launch-asset-raw` / `launch-asset-extension` | 🟢 **直した** ── 押したボタンが対象を持つようになった(`data-pkc-target-lid`) |
   *
   * 🔴 **2026-09-13 にさらに 3 件減った**(#848)── `toggle-app-tile` /
   *   `rename-attachment` / `pick-app-icon` が **押した欄から対象を採る**ようになった。
   * ⚠ **これは「出口を増やした」ではない** ── 画面に足した口は 0 個で、
   *   変えたのは「効く先を何で決めるか」だけである(`selectedLid` → `data-pkc-target-lid`)。
   * 🔑 だから #582 の「増やさない」に触れていない ── **触れていないことを字で残す**
   *   (残さないと、次に読む人が「体系の外で足した」と読む)。
   *
   * 🔑 上の 4 件は**この日まで誰も気づかなかった** ── 上の `readsObject` が
   *   注釈を落とすようになって初めて出た(CLAUDE.md §1「自分の解説コメントに満たされる」)。
   * ⚠ つまりこの台帳は **4 件ぶん多く見えていた**(30 → 実際は 26)。
   */
  'add-relation',
  'add-tag',
  'append-entry',
  /**
   * ⚠ **これは「また 1 つ足した」ではない**(#826、2026-09-09)── 出口は #818 から
   *   ずっと**添付の詳細の 1 か所**のままで、画面には 1 つも足していない。
   * 🔑 ここに入ったのは**受け手の形が変わった**からである ── 別の窓で選ぶ間に
   *   user がノートを移れるようになったので、**押した瞬間の選択**を控える必要ができ、
   *   受け手が `dispatcher.getState()` を読むようになった(= 対象を要る側に分類される)。
   * ⚠ だから #582 の「増やさない」に触れていない。⚠ **触れていないことを字で残す** ──
   *   残さないと、次に読む人が「体系の外で足した 1 つ」と読む。
   */
  'browse-archive',
  /**
   * ⚠ **2026-09-09(#683 段①)に足した。** ⚠ #582 の「増やさない」に**触れていない** ──
   *   ここが止めたい害は「**その面を畳む・狭くすると画面から消える**」ことだが、
   *   録ったものの面は **入口が 2 つ**在る(左の列のタブ / 組み込みタイルの別窓)。
   * 🔑 この台帳が 1 と数えるのは**出口の file 数**であって画面の数ではない ──
   *   `captures.ts` 1 本を左の列と中央の器が**両方**描くので、file では 1、
   *   画面では 2 になる(不可侵指示「面を 1 つ足すたびに ①左に置き場 ②別窓
   *   ③塞がれたら①へ戻す」を満たしている)。
   * ⚠ **触れていないことを字で残す** ── 残さないと、次に読む人が
   *   「体系の外で足した 1 つ」と読む(`browse-archive` と同じ扱い)。
   */
  'capture-play',
  // ⚠ 2026-10-02(#772 段②): 「音/動画」の行の「文字にする」。出口は行の中の 1 か所だけ
  //   (`capture-play` と同じ ── 押した行の lid が要る)。名前で呼べない理由も同じ。
  'capture-transcribe',
  // ⚠ 2026-10-17(#952 A1): 動画の行の「音だけ取り出す」「絵だけ取り出す」。出口は行の中の 1 か所だけ
  //   (`capture-transcribe` と同じ ── 押した行の lid が要る。取り出す物は押したボタンが運ぶ)。名前で呼べない理由も同じ。
  'capture-extract',
  // ⚠ 2026-10-25(#952 A2〜B6・#674): 「音/動画」の行の仕上げの道具(静止区間をまとめる・チャプター・雑音を減らす…)。
  //   出口は行の中の 1 か所だけ(`capture-extract` と同じ ── 押した行の lid が要る。どの道具かは押したボタンが運ぶ)。
  // #952 仕上げ ▾: 行のボタンは 1 つ(open-capture-process)に畳み、道具の一覧はメニューの項目として開いた先で組む(出口は一覧の 1 か所)
  'open-capture-process',
  'clear-entry-date',
  // ⚠ 2026-10-26(#283): ノートの担当を付ける / 外す。出口は情報ペインの「担当」の行 1 か所だけ(`clear-entry-date` と
  //   同じ形 ── 日付の隣の同じ作り。効く先は選んでいるノート)。⚠ 「#582 の増やさない」に触れていない理由も同じ:
  //   画面に足したのは、既にある情報ペインの行 1 つで、別の面を作っていない。
  'clear-entry-owner',
  'set-entry-owner',
  'deliver-to-extension',
  'dual-bookmark-open',
  'dual-bookmark-remove',
  'dual-crumb',
  // ⚠ `dual-row` は 2026-09-04(#687 D-1)に長押し(`long-press.ts`)が 2 つ目の出口になったので外した
  // ⚠ `edit-cell` は 2026-09-05(#708 段④)に markdown の表の升(`markdown-render.ts`)が
  //    2 つ目の出口になったので外した(csv の表は `csv-table.ts`)
  // ⚠ `enter-folder` は 2026-10-18(台帳 #1852 束 N2 / 依頼 85-6)にフォルダの概要の「ほか N 件を左のペインで開く」
  //    (`folder-overview.ts`)が 2 つ目の出口になったので外した(1 つ目はパンくず `filer.ts`)
  'insert-entry-link',
  // ⚠ `move-entry` は #813(2026-09-09)で受け手ごと外した ── プルダウンを消したので
  //    焼く所が 0 件になった(残る口は `move-to-folder` と D&D)
  // ⚠ `navigate-entry-ref` は 2026-09-27(#1044 段4)に章の別ウィンドウの「元のウィンドウで開く」
  //    (`chapter-window.ts`)が 2 つ目の出口になったので外した
  'open-alarm',
  /**
   * ⚠ **2026-09-13(#855 段 0 の 3 つ目)に足した 2 件**(下の `set-task-repeat` と 1 組)。
   *   ⚠ #582 の「増やさない」に**触れていない** ── ここが止めたい害は
   *   「**その面を畳む・狭くすると画面から消える**」ことだが、この 2 つの出口は
   *   **予定の札そのもの**である。
   * 🔑 札を描くのは `render/task-card.ts` **1 本**で、それを使う `render/schedule.ts` を
   *   **左の列の「予定」タブ**と**別窓**(`ViewMode` の `schedule`)が**両方**描く ──
   *   file では 1、画面では 2 になる(`capture-play` と同じ形)。
   * ⚠ 実測(2026-09-13):`createTaskCard` を呼ぶのは `schedule.ts` **1 か所だけ**
   *   ── かんばんは #292 段⑤ で `VIEW_MODES` ごと外れているので、
   *   「2 つの面が同じ札を出す」は**もう成り立たない**(`task-card.ts` の頭を直した)。
   * ⚠ **触れていないことを字で残す** ── 残さないと、次に読む人が
   *   「体系の外で足した 2 つ」と読む(`browse-archive` / `capture-play` と同じ扱い)。
   */
  'open-repeat-menu',
  /**
   * 🔴 **台帳 #1852 束 S1(依頼 128-2 A)で足した 1 件** ── 予定の札の「⋯」。`open-repeat-menu` と同じく、
   *   出口は**予定の札そのもの**(`task-card.ts` 1 本。左の列の「予定」タブと別窓の両方が描く)。
   *   ⚠ #582 の「増やさない」に触れていない(札を畳む・狭くすると消える害は、この札の側が持つ)。
   */
  'open-task-menu',
  /**
   * 🔴 **スマホ用画面の 2 つは「1 か所しかない」が設計である**(#632 段①)。
   *
   * ⚠ 出口はどちらも**本文ページの帯**(`shell.ts` の `phone-bar`)1 か所しか無い ──
   *   スマホでは一覧も情報も見えていないので、**そこ以外に置ける場所が無い**。
   * 🔑 増やす向きの話ではないので、#582 の「増やさない」pin とは意味が違う ──
   *   ここに載っているのは「対象が要るのに 1 か所」という**計器の分類**であって、
   *   不具合ではない。⚠ 逆に 2 か所目ができたら、それは
   *   「同じ操作に 2 通りの経路」を作った合図なので、ここで気づく。
   */
  'phone-menu',
  'phone-page',
  /**
   * ⚠ **2026-10-02(#1224 段②)に足した。** 本文の色コードの見本を押して色を選び直す口である。
   * 🔑 #582 の「増やさない」が止めたいのは「**その面を畳む・狭くすると画面から消える**」害だが、
   *   出口は**本文そのもの**(`markdown-render.ts` が焼く 1 本)で、本文は主の枠・横に留めた枠・
   *   ノートの別ウィンドウのどこでも同じ描き方で出る(畳んで消える面ではない)。`edit-cell` /
   *   `shape-cell` と同じ形 ── 対象(どの行の何番目か)は押した見本が運ぶ。
   * ⚠ **触れていないことを字で残す**(残さないと、次に読む人が「体系の外で足した 1 つ」と読む)。
   */
  'pick-color',
  // ⚠ 2026-10-11(#529 W5): 板の付箋の下端の「追記」と、その欄の「やめる」。出口は**付箋の中の 1 か所**だけ
  //   (押した付箋のノートがボタン自身の `data-pkc-entry` / 欄の `data-pkc-entry` で決まる)。⚠ #582 の「増やさない」に
  //   触れていないとは言わない ── 新しい押し口を 2 つ足した(確定の `place-inline-commit` は押した欄から何も読まないので数えない)。
  //   名前で呼べない理由は `docs/development/operation-unregistered-2026-10.md` に在る。
  'place-append-open',
  'place-inline-cancel',
  /**
   * ⚠ **2026-10-14(#1087)で 1 件増えた** ── 履歴の「この版に戻す」(`restore-revision`)。
   * 🔑 **画面に足した口は 0 個**。この操作は前から選んでいるノートを戻していた(reducer の `RESTORE_REVISION` が
   *   `selectedLid` を読む)が、受け手は読んでいなかったので数えられていなかった。別のタブが編集中かを問うために
   *   受け手が `selectedLid` を読むようになり、走査に見えるようになっただけである。
   */
  'restore-revision',
  /**
   * ⚠ **2026-09-12(#770 段②)に足した。** 目印を**絵から選ぶ**口である。
   * 🔑 **新しい行き止まりを 1 つ作ったのではない** ── すぐ下の `set-app-icon` と
   *   **同じ対象・同じ置き場**(添付の詳細面の「アプリとして登録」の中)で、
   *   既に在る欄の**隣に足した** 2 本目の入り方である。
   * ⚠ それでもここに載るのは正しい ── その面を畳めば**欄ごと**消えるからで、
   *   #582 が置き場の規則を決めるとき、この 3 行(`set-app-group` / `set-app-icon` /
   *   これ)は**まとめて**動く。
   */
  /**
   * 🟢 **`pin-split` は 2026-09-02 に 2 本目の道ができた**(#633 段①)──
   *   本文の上の**スタックの帯**の札から押せる(= 一番上へ上げる)。
   */
  'set-entry-date',
  // ⚠ 上の `open-repeat-menu` と 1 組(2 段目の受け手。理由はそちらに書いた)
  'set-task-repeat',
  'shape-cell',
  /**
   * ⚠ **2026-09-09(#809-4)に足した。** ⚠ #582 の「増やさない」に**触れていない** ──
   *   ここが止めたい害は「**その面を畳む・狭くすると画面から消える**」ことだが、
   *   これは**状態の行の隣**(`shell.ts`)に出る押し口で、状態の行は畳めない。
   * 🔑 そして**出るのは直前の 1 手の直後だけ**である ── user が「どこから押すか」を
   *   探す種類の操作ではない(探す先が 1 か所しか無いことが害になる形ではない)。
   * ⚠ 中身は `select-entry` から**名前を変えただけ**(入れ替えを足した)──
   *   操作を 1 つ増やしたのではない。
   */
  'swap-open',
  /**
   * ⚠ **2026-10-26(#1233)に足した 2 件**(テキスト整形の面の「開いているノートを読み込む」「このノートの本文を置き換える」)。
   *   ⚠ #582 の「増やさない」に**触れていない** ── 出口はこの面の 1 か所だが、この面は**別窓(アプリの窓)の中の道具**で、
   *   「面を畳む・狭くすると画面から消える」害が無い(面を閉じれば、読み込む相手も置き換える相手も一緒に無くなる)。
   * 🔑 対象は「いま開いているノート」(`state.selectedLid`)で、押した瞬間の選択と読み込んだときの本文を突き合わせて
   *   食い違えば断る ── 受け手が state を読むので、この台帳に入る(`swap-open` と同じ)。
   */
  'textlab-apply-note',
  'textlab-load-note',
  /**
   * ⚠ **2026-10-26(#1231)に足した 1 件**(差分マージの「開いているノート」)。⚠ #582 の「増やさない」に**触れていない** ──
   *   出口は左右それぞれの側の中の 1 か所だが、この面は**別窓(アプリの窓)の中の道具**で、面を閉じれば相手も一緒に無くなる。
   * 🔑 対象は「いま開いているノート」(`state.selectedLid`)で、受け手が state を読むので、この台帳に入る(`textlab-load-note` と同じ)。
   */
  'diff-use-open',
  'storage-profile',
  'unschedule-task',
  /**
   * ⚠ **この計器は「出口の数」を file で数える**(`scripts/action-outlets.mjs` の
   *   `where = 相対 path`)。`unsplit-entry` は 2026-09-02 に
   *   **本文の上のスタックの帯**にも口ができたが、⚠ 帯も枠も同じ
   *   `split-view.ts` なので、**この表からは 1 か所のまま**に見える。
   *
   * 🟢 **user から見た片道は #633 段①で閉じている** ── 直す前は「× 降ろす」が
   *   **枠の中にしか無かった**ので、幅で枠が畳まれると**降ろす口が画面から消えて**
   *   いた(#584)。帯の札の × は**枠が 1 つも出ていなくても**押せる。
   * 🔑 だから行は残す(計器の定義に嘘をつかない)が、**残っている理由は
   *   「まだ片道だから」ではない** ── 次に読む人がそう読まないように書いておく。
   */
  'unsplit-entry',
  'untag-entry',
  /**
   * 🔴 **2026-10-25 に 2 件増えた**(#683 ①)── 計った時間の一覧の「名前を直す」(`timer-run-rename`。
   *   「名前を外す」も同じ action)と「消す」(`timer-run-delete`)。押し所は行ごとに 1 か所(`render/timers.ts`)。
   * 🔑 片道ではない ── 消した直後に画面の下の「元に戻す」が出て、名前は「名前を直す / 外す」で往復できる。
   *   対象(ノートと行)は押した行の `data-pkc-entry` / `data-pkc-run-line` が運ぶ(開いているノートではない)。
   */
  'timer-run-delete',
  'timer-run-rename',
];

describe('操作 → 出口の対応表(#582)', () => {
  it('⚠ 空振り防止 ── 受け手の表を、表の中だけ読めている', () => {
    const got = names();
    expect(got.length, '受け手を 1 つも読めていない').toBeGreaterThan(100);
    for (const outside of OUTSIDE_ONLY) {
      expect(got, `表の外の ${outside} まで拾っている(終端を切れていない)`).not.toContain(outside);
    }
    expect(new Set(got).size, '受け手の名前が重複している(終端の切り方が壊れた)').toBe(got.length);
    // 🔑 本文も同じ数だけ切れている(片方だけ壊れるのを防ぐ)
    expect(bodies().size, '本文の切り出しが受け手と揃っていない').toBe(got.length);
  });

  /**
   * 🔴 **コメントは出口ではない**(2026-09-05、#738)。
   *
   * ⚠ 直す前は原文をそのまま読んでいたので、**docstring に
   *   `data-pkc-action` の綴りを書いただけで、その file が出口として数えられた** ──
   *   #735 の直しで「csv の升にはこの印が付く」と**説明を書いた**瞬間に、下の
   *   「出口が 1 か所」の一覧が動いて赤くなった(**説明が台帳を動かした**)。
   * 🔑 見るのは 2 つ:①落とす規則が docstring を空にすること
   *   ②**実物で**、説明しか書いていない file が出口に数えられていないこと。
   * ⚠ ②が本体である ── ①だけだと「規則は在るが呼ばれていない」を見逃す。
   */
  it('🔴 コメントに書いた印を、出口として数えない (#738)', () => {
    // ① 規則そのもの(docstring の 3 つの書き出しを全部空にする)
    expect(
      codeOnlyForScan(['/**', ' * data-pkc-action="x"', ' */', '// data-pkc-action="y"'].join('\n')).trim(),
      'docstring を落とせていない',
    ).toBe('');
    // ⚠ 実行する字は残す(落としすぎると本物の出口が消える)
    expect(codeOnlyForScan('el.setAttribute("data-pkc-action", "z");')).toContain('data-pkc-action');
    /**
     * ② 実物 ── `copy-md-block.ts` は**自分の名前の説明**を docstring に持つが、
     *    そこから出口を作ってはいない(押す口を作るのは `markdown-render.ts` 側)。
     */
    const where = r().rows.find((x) => x.action === 'copy-md-block')?.screens ?? [];
    // 空振り防止 ── 出口が 1 つも読めていないなら、下は何も見ていない
    expect(where.length, 'copy-md-block の出口が 1 つも読めていない').toBeGreaterThan(0);
    expect(
      where,
      'コメントしか無い file を出口に数えている(説明を書くと台帳が動く)',
    ).not.toContain('adapter/ui/actions/copy-md-block.ts');
  });

  /**
   * 🔴 **メニューを開く受け手は、`MENU_OPENERS` に載っていなければならない**
   *   (#918 段④、2026-09-14。**同じ罠を 2 回踏んだので機械の門にした**)。
   *
   * ⚠ 載せないと、**同じ 1 回のクリック**でメニューが開き、続けて `onCloseMenu` が
   *   閉じる ── user から見ると**押しても何も出ない**(無言の dead click)。
   * ⚠ `phone-menu` が一度踏み、#918 段②a(`sql-history-menu`)と段④
   *   (`sql-export-menu`)でも**2 回とも踏んだ** ── 手で並べる一覧なので、
   *   次に開く口を足す人も必ず忘れる(CLAUDE.md §7)。
   * 🔑 だから**受け手の本文から数える** ── `openContextMenu(` を呼ぶ受け手を全数で拾い、
   *   一覧と**集合で**突き合わせる。
   * ⚠ 注釈は落としてから当てる(説明に綴りを書いた瞬間、自分の字で満たされる ── §1)。
   */
  it('🔴 メニューを開く受け手は、1 つ残らず MENU_OPENERS に在る', () => {
    const src = readFileSync('src/adapter/ui/actions/binder.ts', 'utf8');
    const list = /const MENU_OPENERS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(src);
    expect(list, 'MENU_OPENERS の一覧が読めない(綴りが変わった)').not.toBeNull();
    const declared = new Set([...(list?.[1] ?? '').matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!));
    const opens = [...bodies()]
      .filter(([, body]) => (codeOnlyForScan as (s: string) => string)(body).includes('openContextMenu('))
      .map(([action]) => action)
      .sort();
    // ⚠ 空振り防止 ── 切り出しが壊れたら 0 件になって「全部載っている」と読める
    expect(opens.length, 'メニューを開く受け手が 1 つも見つからない(切り出しが壊れた)').toBeGreaterThanOrEqual(3);
    expect([...opens].filter((a) => !declared.has(a)), 'MENU_OPENERS に載っていない').toEqual([]);
  });

  it('🔴 静的に追えない出口の顔ぶれが変わっていない', () => {
    expect([...r().unresolved].sort()).toEqual([...UNRESOLVED].sort());
  });

  it('🔴 「対象が要るのに出口が 1 か所」の顔ぶれが変わっていない(#582 が決まるまで増やさない)', () => {
    const h = bodies();
    const got = r()
      .rows.filter((x) => x.screens.length === 1 && readsObject(h.get(x.action) ?? ''))
      .map((x) => x.action)
      .sort();
    expect(got).toEqual([...OBJECT_LONE].sort());
  });

  it('⚠ ほとんどの操作には画面の出口が在る(空振り防止の下限)', () => {
    const x = r();
    expect(x.withScreen / x.receivers, '画面の出口が見つかる割合が落ちすぎ').toBeGreaterThan(0.8);
  });
});
