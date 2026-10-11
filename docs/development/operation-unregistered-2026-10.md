# 名前で呼べない操作(未登記)の全数分類(#582 段③の下準備)

> 出どころ:`node scripts/operation-table.mjs --unregistered`(2026-10-11、base `b1d8d9eb`)が出す 295 件のうち、
> 押した点を指さなくても呼べる側(`nameable` = 仕分けが `P1` でない)**219 件**(分類の後に #1562 で 1 件増えて **220**)を、場面で分けて「名前で呼ぶ意味」を付けた。
> 手順と結論は `docs/development/operation-model-2026-08.md` §5.3「未登記 219 件の分類」。この file は**その全数表**である。

## 読み方

- **場面と 高/低 は、人が付けた分類**(機械が出すのは id・仕分け・押し所だけ)。高/低は意見であって、user の裁定ではない。
- **高** = 開いているノート・いま見ている面に対する日常の操作で、押す所を指さずに呼べる。**低** = ①確認画面・カード・帯の中のボタン ②押した物(行・項目・値)が対象を運ぶ ③部品を取るなど名前で呼ばせたくない ④登録済みの別 id が同じ実体を通している。
- **画面の字**は押し所の周りから機械で拾った候補を、人が読んで直した。`(…)` は「字が動的で、いまの画面の字を引けていない」こと。正本は画面。
- **押し所**は `outlets()` と同じ綴り 5 通りで探した最初の 2 か所まで。

## 場面ごとの件数

| 場面 | 件数 | 高 | 低 | 高の例 / 低の例 |
|---|---|---|---|---|
| ノートの整理 | 28 | 8 | 20 | つながりを足す / タグを足す / 本文に追記する ／ 低: この整理案を適用 / タグを付ける |
| コピー・書き出し | 11 | 5 | 6 | Markdown をコピー / 書式付きでコピー / 選択範囲をコピー ／ 低: このブロックをコピー / この章をコピー |
| 予定 | 11 | 6 | 5 | 予定を足す / 今月に戻る/今日 / 片付けたノート ／ 低: (前の日/次の日) / やること ほか |
| SQL | 12 | 4 | 8 | SQL を実行 / 構造を見る / 構造をノートへ書き出す ／ 低: ○○ を外す / どのエンジンで実行するか |
| 本文の整形 | 5 | 4 | 1 | 図を入れる / アイコンを入れる / 番号を振り直す ／ 低: (整形バーの書式ボタン) |
| 録音・録画・時間 | 10 | 3 | 7 | 録音する / 画面を録画する / 時間を計る ／ 低: 再生をやめる / 選んだ範囲を消す |
| ゴミ箱・選択 | 5 | 3 | 2 | 選択を解除 / ゴミ箱を閉じる / ゴミ箱を開く ／ 低: まとめてゴミ箱へ移す / ゴミ箱を空にする |
| 検索・置換 | 4 | 3 | 1 | すべて置換 / ›(次の一致へ) / ‹(前の一致へ) ／ 低: ×(一致の表示を閉じる) |
| 2 ペインファイラ | 15 | 2 | 13 | ゴミ箱 / タブを足す ／ 低: (戻る) / (ブックマーク) |
| 表示の切り替え・絞り | 11 | 2 | 9 | 種類の絞りを外す / 中まで全部出す ／ 低: 絞りを外す / (閲覧の切り替え) |
| 保存領域・保守 | 5 | 2 | 3 | ノートの保存データを確認する / 容量を調べる ／ 低: ノートの保存データを作り直す / ノートの保存データを初期化する |
| 連絡先 | 2 | 2 | 0 | 連絡先を足す / vCard で書き出す |
| 設定 | 33 | 1 | 32 | お知らせを開く ／ 低: コピーの履歴を消す / 最近開いた記録を消す |
| アプリ | 12 | 1 | 11 | リンクを足す(一覧の「+」) ／ 低: 並べ替えを終える / アプリを開く |
| 取り込み・外部 | 8 | 1 | 7 | PC のフォルダを選ぶ ／ 低: 外部画像を取り込む / リンク先のアイコンを取り込む |
| 履歴・版 | 3 | 1 | 2 | 履歴を閉じる ／ 低: この版を閉じる / いまの本文と比べる |
| 確認画面・カード・帯の中のボタン | 18 | 0 | 18 | (なし) ／ 低: 外部の画像をこのノートで読み込む / 設定を適用 |
| 板 | 14 | 0 | 14 | (なし) ／ 低: ここに板を置く / テンプレートから板を置く… |
| 部品を取る | 7 | 0 | 7 | (なし) ／ 低: (取り込み中のやめる) / (Office の部品を選ぶ) |
| 章・コードの編集箱 | 4 | 0 | 4 | (なし) ／ 低: コードの編集をやめる / 章の編集をやめる |
| スマホ幅専用 | 2 | 0 | 2 | (なし) ／ 低: このノートの操作を開く / ← 一覧へ戻る ほか |
| **合計** | **220** | **48** | **172** | |

## ノートの整理

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `add-relation` | 高 | つながりを足す | `src/adapter/ui/render/inspector.ts:1400` | 開いているノートへの日常操作(足す先の入力は開いた先で聞く) |
| `add-tag` | 高 | タグを足す | `src/adapter/ui/render/inspector.ts:1216` | 同上 |
| `append-entry` | 高 | 本文に追記する | `src/adapter/ui/render/append-box.ts:173` | 追記は主要動線(開かずに済ませる道)。追記欄の字を読む |
| `attach-file` | 高 | 添付する | `src/adapter/ui/render/shell.ts:627`<br>`src/adapter/ui/render/shell.ts:632` | ファイルを選ぶ入口。作る操作と並ぶ日常操作 |
| `clear-entry-date` | 高 | 日付を外す | `src/adapter/ui/render/inspector.ts:1132`<br>`src/adapter/ui/render/inspector.ts:1125` | 開いているノートの日付を外す(片道にしない操作) |
| `open-today` | 高 | 今日のノートを開く | `src/adapter/ui/render/browse.ts:116`<br>`src/adapter/ui/render/shell.ts:613` | 日付ノートの日常の入口 |
| `refresh-query` | 高 | 集計を数え直す | `src/adapter/ui/render/query.ts:127` | 集計ノートの更新 |
| `stack-save` | 高 | スタックを保存… | `src/adapter/ui/render/split-view.ts:340` | スタックの保存。名前入力を開く |
| `apply-plan` | 低 | この整理案を適用 | `src/adapter/ui/render/inspector.ts:1711` | 整理案を見たあとの確認ボタン |
| `bulk-tag-add` | 低 | タグを付ける | `src/adapter/ui/render/filer.ts:511` | 複数選択してから使う(選択が前提) |
| `bulk-tag-remove` | 低 | タグを外す | `src/adapter/ui/render/filer.ts:513` | 同上 |
| `enter-folder` | 低 | (フォルダへ入る) | `src/adapter/ui/render/filer.ts:886`<br>`src/adapter/ui/render/filer.ts:904` | 押した行(フォルダ)を指す |
| `move-order-down` | 低 | (下へ) | `src/adapter/ui/render/filer.ts:572(綴りを組み立てる)` | 押した行を 1 つ動かす(並べ替えの行ボタン) |
| `move-order-up` | 低 | (上へ) | `src/adapter/ui/render/filer.ts:572(綴りを組み立てる)` | 同上 |
| `pick-create-kind` | 低 | (作る種類を選ぶ) | `src/adapter/ui/render/browse.ts:115`<br>`src/adapter/ui/render/shell.ts:571` | 選んだ種類を押した項目から読む。種類ごとの作成は別に登録済み |
| `rename-attachment` | 低 | (添付の名前欄) | `src/adapter/ui/render/detail.ts:3379` | 入力欄の値を読む |
| `select-entry` | 低 | (ノートを選ぶ) | `src/adapter/ui/render/captures.ts:629`<br>`src/adapter/ui/render/contacts.ts:230` | 押した行を指す(行そのもの) |
| `set-entry-date` | 低 | (日付の欄) | `src/adapter/ui/render/inspector.ts:1129`<br>`src/adapter/ui/render/inspector.ts:1124` | 入力欄の値を読む |
| `set-query-key` | 低 | グループ化する項目 | `src/adapter/ui/render/query.ts:116` | 選んだ値を読む |
| `table-to-csv` | 低 | CSV の表にする | `src/features/entry-actions.ts:1085` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `table-to-markdown` | 低 | Markdown の表にする | `src/features/entry-actions.ts:1086` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `task-run-done` | 低 | このリストをすべて完了にする | `src/features/entry-actions.ts:1108` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `task-run-open` | 低 | このリストをすべて未完了に戻す | `src/features/entry-actions.ts:1107` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `toggle-create-menu` | 低 | 作る種類を選ぶ | `src/adapter/ui/render/shell.ts:544` | メニューの親。種類ごとの作成が本体 |
| `toggle-plan-apply` | 低 | 整理案を適用 | `src/adapter/ui/render/inspector.ts:1665` | 整理案のパネルの開閉 |
| `toggle-todo` | 低 | (チェック欄) | `(いまの画面に押し所が無い。src/features/sealed.ts の封印)` | 押したチェックを指す |
| `undo-append` | 低 | 追記を元に戻す | `src/adapter/ui/render/append-box.ts:148` | 追記直後の知らせに付く一時ボタン |
| `undo-move` | 低 | 移動を元に戻す | `src/adapter/ui/render/shell.ts:1019` | 移動直後の知らせに付く一時ボタン |

## コピー・書き出し

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `copy-note-md` | 高 | Markdown をコピー | `src/adapter/ui/render/detail.ts:2153` | 開いているノートをコピー |
| `copy-note-rich` | 高 | 書式付きでコピー | `src/adapter/ui/render/detail.ts:2155` | 同上 |
| `copy-selection-md` | 高 | 選択範囲をコピー | `src/adapter/ui/render/detail.ts:2157` | 選択範囲をコピー |
| `export-messages` | 高 | メッセージを書き出す | `src/adapter/ui/render/settings/messages.ts:76` | バグ報告の取り出し口。探す人が居る |
| `export-settings` | 高 | 設定を書き出す | `src/adapter/ui/render/commands.ts:408` | 設定の持ち出し |
| `copy-block-md` | 低 | このブロックをコピー | `src/features/entry-actions.ts:941`<br>`src/features/entry-actions.ts:948` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `copy-chapter-md` | 低 | この章をコピー | `src/features/entry-actions.ts:814`<br>`src/features/entry-actions.ts:894` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `copy-section-link` | 低 | 章のリンクをコピー | `src/features/entry-actions.ts:826`<br>`src/features/entry-actions.ts:900` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `copy-section-ref` | 低 | 章の参照をコピー | `src/features/entry-actions.ts:821`<br>`src/features/entry-actions.ts:898` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `paste-many-copied` | 低 | 選んで、並べて、追記の欄へ入れる | `src/adapter/ui/actions/copy-history-menu.ts:56` | コピー履歴のメニューの中の項目 |
| `use-copied` | 低 | もう一度コピーする | `src/adapter/ui/actions/copy-history-menu.ts:48` | コピー履歴メニューの項目 |

## 板

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `add-place` | 低 | ここに板を置く | `src/features/entry-actions.ts:1049` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `add-place-template` | 低 | テンプレートから板を置く… | `src/features/entry-actions.ts:1057` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-color` | 低 | 色… | `src/features/entry-actions.ts:974`<br>`src/features/entry-actions.ts:975` | 色を選ぶ入力が要る |
| `place-color-clear` | 低 | 色を外す | `src/features/entry-actions.ts:979`<br>`src/features/entry-actions.ts:1025` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-line-width` | 低 | 線を太くする/細くする/標準に戻す | `src/features/entry-actions.ts:1028`<br>`src/features/entry-actions.ts:1031` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-rect` | 低 | 位置と大きさ… | `src/features/entry-actions.ts:953` | 数値を入れる窓が要る |
| `place-shape-arrow` | 低 | 矢印にする | `src/features/entry-actions.ts:932` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-shape-diamond` | 低 | ひし形にする | `src/features/entry-actions.ts:931` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-shape-ellipse` | 低 | 楕円にする | `src/features/entry-actions.ts:930` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-shape-rect` | 低 | 四角にする | `src/features/entry-actions.ts:928` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-shape-round` | 低 | 角丸にする | `src/features/entry-actions.ts:929` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `raise-place` | 低 | 前へ出す | `src/features/entry-actions.ts:951` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `remove-place` | 低 | この板を消す | `src/features/entry-actions.ts:985` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `remove-place-line` | 低 | この線を消す | `src/features/entry-actions.ts:998` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |

## 予定

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `schedule-quick-add` | 高 | 予定を足す | `src/adapter/ui/render/schedule.ts:742` | 予定の日常操作 |
| `schedule-today` | 高 | 今月に戻る/今日 | `src/adapter/ui/render/schedule.ts:662` | 予定面を今日へ |
| `export-schedule-ics` | 高 | 予定を .ics で書き出す | `src/adapter/ui/render/schedule.ts:777` | 予定面の書き出し(連絡先の vCard と同じ置き場。分類の後、#1562 で足した) |
| `toggle-show-archived` | 高 | 片付けたノート | `src/adapter/ui/render/schedule.ts:776` | 予定面の表示の切り替え |
| `toggle-show-done` | 高 | 済んだ行 | `src/adapter/ui/render/schedule.ts:774` | 同上 |
| `toggle-show-undated` | 高 | 日付のない項目 | `src/adapter/ui/render/schedule.ts:772` | 同上 |
| `schedule-day-go` | 低 | (前の日/次の日) | `src/adapter/ui/render/schedule-day.ts:58`<br>`src/adapter/ui/render/schedule-week.ts:65` | 日表示の前後。押したボタンが向きを運ぶ |
| `schedule-mode` | 低 | やること ほか | `src/adapter/ui/render/schedule.ts:687` | 予定面の表示の切り替え(押した見出しが運ぶ) |
| `schedule-nav` | 低 | (前へ/次へ/今月) | `src/adapter/ui/render/schedule.ts:653`<br>`src/adapter/ui/render/schedule.ts:396` | 押したボタンが向きを運ぶ |
| `schedule-undo-move` | 低 | 元に戻す | `src/adapter/ui/render/schedule-undo.ts:126` | 動かした直後の知らせに付く一時ボタン |
| `schedule-week-pick` | 低 | (週の日の見出し) | `src/adapter/ui/render/schedule-week.ts:146` | 押した日を指す |

## 本文の整形

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `insert-diagram` | 高 | 図を入れる | `src/adapter/ui/render/format-bar.ts:251` | 本文への挿入。整形バーの日常操作 |
| `insert-icon` | 高 | アイコンを入れる | `src/adapter/ui/render/format-bar.ts:172` | 同上 |
| `renumber-lists` | 高 | 番号を振り直す | `src/adapter/ui/render/format-bar.ts:191` | 本文の整え。整形バーの日常操作 |
| `sort-tasks` | 高 | 完了した項目を末尾へ移す | `src/adapter/ui/render/format-bar.ts:213` | 本文の整え。整形バーの日常操作 |
| `format-text` | 低 | (整形バーの書式ボタン) | `src/adapter/ui/render/format-bar.ts:40` | 書式の種類を押したボタンから読む。書式ごとの命令が既に別に在る |

## SQL

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `run-sql` | 高 | SQL を実行 | `src/adapter/ui/render/sql.ts:248` | SQL の面の主操作 |
| `sql-er-toggle` | 高 | 構造を見る | `src/adapter/ui/render/sql.ts:329` | SQL 面の表示切り替え |
| `sql-schema-to-note` | 高 | 構造をノートへ書き出す | `src/adapter/ui/render/sql.ts:304` | SQL の結果をノートにする |
| `sql-to-note` | 高 | ノートへ書き出す | `src/adapter/ui/render/sql.ts:261` | 同上 |
| `remove-sql-source` | 低 | ○○ を外す | `src/adapter/ui/render/sql.ts:672` | 押した対象(行)を指す |
| `set-sql-engine` | 低 | どのエンジンで実行するか | `src/adapter/ui/render/sql.ts:280` | 選んだ値を読む |
| `set-sql-source` | 低 | 調べる対象 | `src/adapter/ui/render/sql.ts:271` | 選んだ値を読む |
| `set-sql-text` | 低 | 打つ SQL | `src/adapter/ui/render/sql.ts:207` | 入力欄の値を読む |
| `sql-er-connect-toggle` | 低 | 列をつなぐ | `src/adapter/ui/render/sql-er.ts:105` | ER 図の中の編集モード |
| `sql-export-menu` | 低 | ファイルへ書き出す(メニューを開く) | `src/adapter/ui/render/sql.ts:354` | メニューの親。項目ごとが本体 |
| `sql-export-pick` | 低 | (書き出し形式の項目) | `(src/adapter/ui/render/sql.ts のメニュー項目。綴りを静的に追えない)` | メニューの項目。押した項目が形式を運ぶ |
| `sql-history-menu` | 低 | 履歴から選ぶ(メニューを開く) | `src/adapter/ui/render/sql.ts:339` | メニューの親。項目ごとが本体 |

## 録音・録画・時間

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `start-audio-capture` | 高 | 録音する | `src/adapter/ui/render/shell.ts:645`<br>`src/adapter/ui/render/shell.ts:649` | 日常操作(作る操作の並び) |
| `start-screen-capture` | 高 | 画面を録画する | `src/adapter/ui/render/shell.ts:652`<br>`src/adapter/ui/render/shell.ts:656` | 同上 |
| `start-timer` | 高 | 時間を計る | `src/adapter/ui/render/shell.ts:667`<br>`src/adapter/ui/render/shell.ts:671` | 日常操作 |
| `capture-stop` | 低 | 再生をやめる | `src/adapter/ui/render/captures.ts:665` | 再生中にしか出ないボタン |
| `capture-trim-clear` | 低 | 選んだ範囲を消す | `src/adapter/ui/render/captures.ts:584` | 切り出しの範囲指定の途中 |
| `capture-trim-end` | 低 | ここを終わりにする | `src/adapter/ui/render/captures.ts:555` | 同上(再生位置を読む) |
| `capture-trim-run` | 低 | この範囲を切り出す | `src/adapter/ui/render/captures.ts:571` | 同上(範囲が決まってから) |
| `capture-trim-start` | 低 | ここを始まりにする | `src/adapter/ui/render/captures.ts:541` | 同上 |
| `discard-capture` | 低 | 収録を残さずにやめる | `src/adapter/ui/render/shell.ts:1110` | 収録中にしか出ないボタン(取り消せない) |
| `stop-capture` | 低 | 収録を止める | `src/adapter/ui/render/shell.ts:1107` | 収録中にしか出ない(止めるキー/ボタンが画面に常に在る) |

## ゴミ箱・選択

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `clear-selection` | 高 | 選択を解除 | `src/adapter/ui/render/filer.ts:487` | まとめ操作の選択を外す |
| `hide-trash` | 高 | ゴミ箱を閉じる | `src/adapter/ui/render/filer.ts:1204` | ゴミ箱の開閉 |
| `show-trash` | 高 | ゴミ箱を開く | `src/adapter/ui/render/filer.ts:1192` | ゴミ箱の開閉 |
| `delete-selected` | 低 | まとめてゴミ箱へ移す | `src/adapter/ui/render/filer.ts:482` | 選択が前提。確認を伴う |
| `purge-trash` | 低 | ゴミ箱を空にする | `src/adapter/ui/render/filer.ts:1210` | 取り消せない。確認を伴う |

## 検索・置換

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `replace-all` | 高 | すべて置換 | `src/adapter/ui/render/shell.ts:857` | 検索置換の実行 |
| `search-jump-next` | 高 | ›(次の一致へ) | `src/adapter/ui/render/search-jump.ts:240` | 検索で一致を巡る日常操作(帯の中だが探す人が居る) |
| `search-jump-prev` | 高 | ‹(前の一致へ) | `src/adapter/ui/render/search-jump.ts:238` | 同上 |
| `search-jump-end` | 低 | ×(一致の表示を閉じる) | `src/adapter/ui/render/search-jump.ts:242` | 検索の一致帯の中のボタン |

## 表示の切り替え・絞り

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `clear-kind-filter` | 高 | 種類の絞りを外す | `src/adapter/ui/render/kind-bar.ts:128` | 種類の絞りを解除。絞りが掛かった状態からの日常操作 |
| `toggle-filer-flatten` | 高 | 中まで全部出す | `src/adapter/ui/render/filer.ts:957` | ファイラの表示の切り替え |
| `clear-entry-filter` | 低 | 絞りを外す | `src/adapter/ui/render/captures.ts:202`<br>`src/adapter/ui/render/contacts.ts:168` | 絞りが掛かっているときだけ出る欄内のボタン |
| `set-browse` | 低 | (閲覧の切り替え) | `src/adapter/ui/render/shell.ts:315` | 選んだ値を押したボタンから読む |
| `set-entry-sort` | 低 | 一覧の並び順 | `src/adapter/ui/render/shell.ts:431` | 選んだ値を読む |
| `set-view` | 低 | (画面の切り替えボタン) | `src/adapter/ui/render/collection-bar.ts:160` | 行き先の面を押したボタンから読む。面ごとの命令は別に在る |
| `smart-cond-add` | 低 | 条件に足す | `src/adapter/ui/render/filer.ts:373` | 絞りの条件欄の中のボタン |
| `smart-evict` | 低 | ここから外す | `src/adapter/ui/render/filer.ts:387` | 絞りの条件欄の中のボタン |
| `smart-field` | 低 | ○○で絞る | `src/adapter/ui/render/filer.ts:339` | 入力欄の値を読む |
| `toggle-kind-filter` | 低 | ○○の絞り | `src/adapter/ui/render/kind-bar.ts:141` | 種類を押したボタンから読む。種類ごとの絞りは別設計 |
| `toggle-pane` | 低 | ペインを折りたたむ/戻す | `src/adapter/ui/render/pane-visibility.ts:298`<br>`src/adapter/ui/render/shell.ts:808` | 押したペインを運ぶ。ペインごとの命令は登録済み |

## 保存領域・保守

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `db-check` | 高 | ノートの保存データを確認する | `src/adapter/ui/render/commands.ts:542` | 保存領域の点検。保守の入口として探す人が居る |
| `storage-profile` | 高 | 容量を調べる | `src/adapter/ui/render/commands.ts:479` | 保存領域の測定。探す人が居る |
| `container-rebuild` | 低 | ノートの保存データを作り直す | `src/adapter/ui/render/commands.ts:341` | 保存データを作り直す。確認つきの保守 |
| `container-reset` | 低 | ノートの保存データを初期化する | `src/adapter/ui/render/commands.ts:364` | 取り消せない全消去。パレットに置かない |
| `storage-vacuum` | 低 | 縮める | `src/adapter/ui/render/commands.ts:272` | 保守。確認や待ちを伴う |

## 連絡先

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `contacts-quick-add` | 高 | 連絡先を足す | `src/adapter/ui/render/contacts.ts:94` | 連絡先の面の日常操作 |
| `export-vcards` | 高 | vCard で書き出す | `src/adapter/ui/render/contacts.ts:190` | 連絡先の面の書き出し |

## 2 ペインファイラ

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `dual-delete` | 高 | ゴミ箱 | `src/adapter/ui/render/dual-filer.ts:224` | 同上 |
| `dual-tab-add` | 高 | タブを足す | `src/adapter/ui/render/dual-filer.ts:1124` | 2 ペインのタブ操作 |
| `dual-back` | 低 | (戻る) | `src/adapter/ui/render/dual-filer.ts:672` | 同じ実体を、登録済みの別の id(dual-… の命令)が既に通している |
| `dual-bookmark` | 低 | (ブックマーク) | `src/adapter/ui/render/dual-filer.ts:674` | 2 ペインの中。動的描画 |
| `dual-copy` | 低 | コピー | `src/adapter/ui/render/dual-filer.ts:172` | 同じ実体を、登録済みの別の id(dual-… の命令)が既に通している |
| `dual-focus` | 低 | (ペインを選ぶ) | `src/adapter/ui/render/dual-filer.ts:615`<br>`src/adapter/ui/render/dual-filer.ts:627` | 押した側のペインを指す |
| `dual-forward` | 低 | (進む) | `src/adapter/ui/render/dual-filer.ts:673` | 同じ実体を、登録済みの別の id(dual-… の命令)が既に通している |
| `dual-mkdir` | 低 | フォルダ | `src/adapter/ui/render/dual-filer.ts:204` | 同じ実体を、登録済みの別の id(dual-… の命令)が既に通している |
| `dual-mknote` | 低 | ノート | `src/adapter/ui/render/dual-filer.ts:216` | 同じ実体を、登録済みの別の id(dual-… の命令)が既に通している |
| `dual-move` | 低 | 移す | `src/adapter/ui/render/dual-filer.ts:188` | 同じ実体を、登録済みの別の id(dual-… の命令)が既に通している |
| `dual-preview-toggle` | 低 | プレビュー | `src/adapter/ui/render/dual-filer.ts:236` | 同じ実体を、登録済みの別の id(dual-… の命令)が既に通している |
| `dual-rename-begin` | 低 | 名前 | `src/adapter/ui/render/dual-filer.ts:196` | 同じ実体を、登録済みの別の id(dual-… の命令)が既に通している |
| `dual-row` | 低 | (行) | `src/adapter/ui/actions/long-press.ts:52`<br>`src/adapter/ui/render/dual-filer.ts:1240` | 押した行を指す |
| `dual-sort` | 低 | (列の見出し) | `src/adapter/ui/render/dual-filer.ts:1219` | 列と向きを押した見出しから読む |
| `dual-tab-close` | 低 | ○○のタブを閉じる | `src/adapter/ui/render/dual-filer.ts:1104` | 押したタブを指す |

## アプリ

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `add-url-tile` | 高 | リンクを足す(一覧の「+」) | `src/adapter/ui/render/launcher.ts:129` | アプリ一覧へ足す日常操作 |
| `end-tile-reorder` | 低 | 並べ替えを終える | `src/adapter/ui/render/launcher.ts:258`<br>`src/features/entry-actions.ts:649` | 並べ替え中にしか出ない |
| `launch-asset` | 低 | アプリを開く | `src/adapter/ui/render/detail.ts:3286` | 開いている添付アプリを開く(添付詳細の中) |
| `launch-asset-extension` | 低 | ノート一覧を見せて開く | `src/adapter/ui/render/detail.ts:3318` | 開き方の選択肢の 1 つ(設定値の揺れ) |
| `launch-asset-raw` | 低 | ノートを渡して開く | `src/adapter/ui/render/detail.ts:3298` | 同上 |
| `pick-app-icon` | 低 | (アイコンを選ぶ) | `src/adapter/ui/render/detail.ts:4411` | 選択肢を押した所から読む |
| `reset-app-group-order` | 低 | すべて名前順に戻す | `src/features/entry-actions.ts:553` | 並べ直しの取り消し(アプリ一覧の中) |
| `set-app-group` | 低 | (アプリのグループ欄) | `src/adapter/ui/render/detail.ts:4321` | 入力欄の値を読む |
| `set-app-icon` | 低 | (アプリのアイコン欄) | `src/adapter/ui/render/detail.ts:4322` | 入力欄の値を読む |
| `start-tile-reorder` | 低 | タイルを並べ替える | `src/features/entry-actions.ts:650` | 並べ替えモードへ入る。モード中にしか意味が無い |
| `toggle-all-app-groups` | 低 | グループを全部開く/畳む | `src/adapter/ui/render/launcher.ts:323` | 押した一覧の中の群を読む(一覧の外からは撃てない) |
| `toggle-app-tile` | 低 | アプリとして登録 | `src/adapter/ui/render/detail.ts:4290` | チェック欄の値を読む(アプリ登録はノート単位の詳細欄) |

## 取り込み・外部

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `pc-pick-folder` | 高 | PC のフォルダを選ぶ | `src/adapter/ui/render/pc-folder.ts:113` | 取り込みの入口(ブラウザの選択を開く) |
| `adopt-external-images` | 低 | 外部画像を取り込む | `src/adapter/ui/render/inspector.ts:1518`<br>`src/features/entry-actions.ts:709` | ノートごとの一度きりの整理。情報ペイン/メニューから届く |
| `adopt-link-icon` | 低 | リンク先のアイコンを取り込む | `src/adapter/ui/render/detail.ts:4334` | 外へ取りに行く一度きりの操作。詳細欄の中 |
| `pc-cut-folder` | 低 | (PC フォルダの切り取り) | `src/adapter/ui/render/pc-folder.ts:152` | PC フォルダの面の中。動的描画 |
| `pc-dir-note` | 低 | (PC フォルダのノート) | `src/adapter/ui/render/pc-folder.ts:201` | 同上 |
| `pc-more` | 低 | (PC フォルダのメニュー) | `src/adapter/ui/render/pc-folder.ts:183` | 同上 |
| `pc-refresh-folder` | 低 | 更新 | `src/adapter/ui/render/pc-folder.ts:136` | PC フォルダの面の中 |
| `undo-import` | 低 | 取り込みを元に戻す | `src/adapter/ui/actions/import-undo.ts:65` | 取り込み直後の知らせに付く一時ボタン |

## 設定

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `open-system-notices` | 高 | お知らせを開く | `src/adapter/ui/render/help.ts:626` | ヘルプからお知らせを開く入口 |
| `clear-copy-history` | 低 | コピーの履歴を消す | `src/adapter/ui/actions/copy-history-menu.ts:63`<br>`src/adapter/ui/render/settings/copy-history.ts:52` | 履歴の削除(取り消せない確認つきの設定欄) |
| `clear-opened-history` | 低 | 最近開いた記録を消す | `src/adapter/ui/render/settings/opened-history.ts:33` | 履歴の削除(設定欄) |
| `clear-search-history` | 低 | 検索した語の記録を消す | `src/adapter/ui/render/settings/search-history.ts:29` | 履歴の削除(設定欄) |
| `reset-flags` | 低 | すべて既定に戻す | `src/adapter/ui/render/flags.ts:159` | 開発者向けの画面の中 |
| `set-alarm-enabled` | 低 | 予定の時刻になったら音で知らせる | `src/adapter/ui/render/settings/alarm-enabled.ts:24` | チェック欄の値を押した欄から読む |
| `set-app-open-target` | 低 | アプリの開き方 | `src/adapter/ui/render/settings/app-open-target.ts:31` | 選んだ値を押した欄から読む |
| `set-code-collapse` | 低 | 長いコードブロックを最初から折りたたむ | `src/adapter/ui/render/settings/code-collapse.ts:25` | チェック欄の値を押した欄から読む |
| `set-color-swatch` | 低 | 色見本を出す | `src/adapter/ui/render/settings/color-swatch.ts:22` | 同上 |
| `set-column-rule` | 低 | 段の罫線 | `src/adapter/ui/render/settings/column-rule.ts:31` | 選んだ値を押した欄から読む |
| `set-date-links` | 低 | @日付 を押すと、その日のノートを開く | `src/adapter/ui/render/settings/date-links.ts:21` | チェック欄の値を読む |
| `set-editor-mode` | 低 | 編集の仕方 | `src/adapter/ui/render/settings/editor-mode.ts:34` | 選んだ値を読む |
| `set-external-images` | 低 | 外部画像の扱い | `src/adapter/ui/render/settings/external-images.ts:38` | 選んだ値を読む |
| `set-flag` | 低 | (フラグ欄) | `src/adapter/ui/render/flags.ts:121` | 開発者向け。選んだ値を読む |
| `set-inline-code-copy` | 低 | 本文の小さなコードを押すとコピー | `src/adapter/ui/render/settings/inline-code-copy.ts:20` | チェック欄の値を読む |
| `set-message-cap` | 低 | メッセージの保存件数 | `src/adapter/ui/render/settings/messages.ts:66` | 選んだ値を読む |
| `set-missing-links` | 低 | 見つからないリンクを薄く見せる | `src/adapter/ui/render/settings/missing-links.ts:27` | チェック欄の値を読む |
| `set-notices-enabled` | 低 | 起動したときにお知らせを出す | `src/adapter/ui/render/settings/notices.ts:37` | チェック欄の値を読む |
| `set-open-in-edit` | 低 | 開いたら、そのまま編集に入る | `src/adapter/ui/render/settings/open-in-edit.ts:23` | チェック欄の値を読む |
| `set-open-place` | 低 | 別ウィンドウで開く/同じ画面で開く | `src/adapter/ui/render/settings/open-place.ts:31` | 選んだ値を読む |
| `set-page-format` | 低 | ページ設定 | `src/adapter/ui/render/settings/page-format.ts:24` | 選んだ値を読む |
| `set-paste-source` | 低 | 貼り付けで読み取る形 | `src/adapter/ui/render/settings/paste-source.ts:37` | 選んだ値を読む |
| `set-pdf-reader` | 低 | PDF を PKC3 のビューアで開く | `src/adapter/ui/render/settings/pdf-reader.ts:22` | チェック欄の値を読む |
| `set-phone-links` | 低 | 電話番号を押せるようにする | `src/adapter/ui/render/settings/phone-links.ts:30` | チェック欄の値を読む |
| `set-prose-align` | 低 | 本文の揃え | `src/adapter/ui/render/settings/prose-align.ts:30` | 選んだ値を読む |
| `set-read-columns` | 低 | 読む段の数 | `src/adapter/ui/render/settings/read-columns.ts:91` | 選んだ値を読む(段の切り替えは別に登録済み) |
| `set-relative-days` | 低 | @日付 の右に今日からの日数を添える | `src/adapter/ui/render/settings/relative-days.ts:47` | チェック欄の値を読む |
| `set-tag-badge` | 低 | 本文のタグの見せ方 | `src/adapter/ui/render/settings/tag-badge.ts:32` | 選んだ値を読む |
| `set-text-scale` | 低 | 文字の大きさ | `src/adapter/ui/render/settings/text-scale.ts:28` | 選んだ値を読む |
| `set-theme` | 低 | 配色 | `src/adapter/ui/render/settings/theme.ts:18` | 選んだ値を読む(配色の切り替えは値ごとの命令にできるが別設計) |
| `set-too-narrow-enabled` | 低 | 狭い画面のときに断り書きを出す | `src/adapter/ui/render/settings/too-narrow.ts:30` | チェック欄の値を読む |
| `set-voice-boost` | 低 | 再生するとき声を聞き取りやすく整える | `src/adapter/ui/render/settings/voice-boost.ts:22` | チェック欄の値を読む |
| `toggle-container-repair` | 低 | 作り直す・初期化するボタンを表示 | `src/adapter/ui/render/commands.ts:300` | 保守の画面の中の表示切り替え |

## 履歴・版

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `hide-history` | 高 | 履歴を閉じる | `src/adapter/ui/render/detail.ts:4193` | 履歴を開閉する。開く側は既に登録済み |
| `hide-revision-preview` | 低 | この版を閉じる | `src/adapter/ui/render/detail.ts:4122` | 版のプレビュー中にしか出ない |
| `set-revision-compare` | 低 | いまの本文と比べる | `src/adapter/ui/render/detail.ts:4132` | 選んだ値を読む |

## 確認画面・カード・帯の中のボタン

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `allow-external-images` | 低 | 外部の画像をこのノートで読み込む | `src/adapter/ui/render/external-images.ts:172` | 外部画像の確認帯の中のボタン(許可の確認) |
| `apply-settings` | 低 | 設定を適用 | `src/adapter/ui/render/commands.ts:443` | 設定の読み込み画面の確定ボタン(確認画面の中) |
| `apply-update` | 低 | 新しいバージョンに切り替える | `src/adapter/ui/render/update-card.ts:27` | 更新のお知らせカードの中のボタン |
| `close-lightbox` | 低 | 閉じる (Esc) | `src/adapter/ui/render/lightbox.ts:38`<br>`src/adapter/ui/render/lightbox.ts:73` | 拡大表示を閉じる(Esc で足りる) |
| `create-date-note` | 低 | ○○のノートを作る | `src/adapter/ui/render/shell.ts:1030` | 知らせの隣に出る一時ボタン(日付は知らせが運ぶ) |
| `deny-external-images` | 低 | 外部の画像を読み込まない | `src/adapter/ui/render/external-images.ts:176` | 外部画像の確認帯の中のボタン |
| `discard-draft` | 低 | 消す | `src/adapter/ui/render/draft-offer.ts:121` | 下書きの提案カードの中のボタン |
| `dismiss-announce` | 低 | お知らせを閉じる | `src/adapter/ui/render/announce.ts:169`<br>`src/adapter/ui/render/announce.ts:268` | お知らせカードの中のボタン |
| `dismiss-notices` | 低 | 結果の欄を閉じる | `src/adapter/ui/render/notices.ts:49` | 結果の欄の中のボタン |
| `dismiss-update` | 低 | あとで切り替える | `src/adapter/ui/render/update-card.ts:32` | 更新カードの中のボタン |
| `force-release` | 低 | 書き込みを打ち切る | `src/adapter/ui/render/append-box.ts:193`<br>`src/adapter/ui/render/code-box.ts:121` | 書き込み中の箱にだけ出る非常ボタン |
| `mute-announce` | 低 | 今後はお知らせを出さない | `src/adapter/ui/render/announce.ts:236` | お知らせカードの中のボタン |
| `next-announce` | 低 | 次のお知らせを出す | `src/adapter/ui/render/announce.ts:159`<br>`src/adapter/ui/render/announce.ts:268` | お知らせカードの中のボタン |
| `open-storage-check` | 低 | ノートの保存データの確認を開く | `src/adapter/ui/render/shell.ts:1043` | 保存が止まった断り書きの隣の一時ボタン |
| `restore-draft` | 低 | 戻す | `src/adapter/ui/render/draft-offer.ts:116` | 下書きの提案カードの中のボタン |
| `retry-persist` | 低 | ノートを保存し直す | `src/adapter/ui/render/detail.ts:2167` | 保存失敗の帯の中のボタン |
| `skip-to` | 低 | (本文へ移動) | `src/adapter/ui/render/shell.ts:1223` | アクセシビリティの先頭リンク |
| `swap-open` | 低 | そのノートを開く | `src/adapter/ui/render/shell.ts:1007` | 知らせの隣の一時ボタン(開く先は知らせが運ぶ) |

## 部品を取る

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `cancel-asr-install` | 低 | (取り込み中のやめる) | `src/adapter/ui/render/asr-pack-panel.ts:206` | 部品の取り込みの途中でしか出ない |
| `choose-office-pack` | 低 | (Office の部品を選ぶ) | `src/adapter/ui/render/office-pack-panel.ts:195` | 部品を取る入口の一部。ファイル選択の中 |
| `install-asr-part` | 低 | (部品ごとの取り込み) | `src/adapter/ui/render/asr-pack-panel.ts:188` | 数十〜数百 MB の部品を取る(押したボタンが部品を運ぶ)。#772 段②で未登記と判断済み |
| `install-office-pack` | 低 | 配布元から取り込む | `src/adapter/ui/render/office-pack-panel.ts:182` | 数十〜数百 MB の部品を取る。#772 段②と同じ判断 |
| `remove-asr-part` | 低 | (部品を消す) | `src/adapter/ui/render/asr-pack-panel.ts:192` | 部品を取る/消す操作(押したボタンが部品を運ぶ) |
| `remove-office-pack` | 低 | (Office の部品を消す) | `src/adapter/ui/render/office-pack-panel.ts:197` | 同上 |
| `reset-office-profile` | 低 | (Office の設定を初期化) | `src/adapter/ui/render/office-pack-panel.ts:209` | Office の窓の中の保守 |

## 章・コードの編集箱

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `cancel-code-draft` | 低 | コードの編集をやめる | `src/adapter/ui/render/code-box.ts:84`<br>`src/adapter/ui/render/code-box.ts:120` | コード欄の編集箱の中のボタン |
| `cancel-section-draft` | 低 | 章の編集をやめる | `src/adapter/ui/render/section-box.ts:79`<br>`src/adapter/ui/render/section-box.ts:166` | 章の編集箱の中のボタン |
| `save-code-draft` | 低 | コードを保存する | `src/adapter/ui/render/code-box.ts:80`<br>`src/adapter/ui/render/code-box.ts:119` | コード欄の編集箱の中のボタン |
| `save-section-draft` | 低 | 章を保存する | `src/adapter/ui/render/section-box.ts:75`<br>`src/adapter/ui/render/section-box.ts:165` | 章の編集箱の中のボタン |

## スマホ幅専用

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `phone-menu` | 低 | このノートの操作を開く | `src/adapter/ui/render/shell.ts:937` | スマホ幅専用の画面操作 |
| `phone-page` | 低 | ← 一覧へ戻る ほか | `src/adapter/ui/render/shell.ts:756`<br>`src/adapter/ui/render/shell.ts:916` | スマホ幅専用。押したボタンが行き先を運ぶ |

