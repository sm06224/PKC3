# 名前で呼べない操作(未登記)の全数分類(#582 段③の下準備)

> 出どころ:`node scripts/operation-table.mjs --unregistered`(2026-10-11、base `b1d8d9eb`)が出す 295 件のうち、
> 押した点を指さなくても呼べる側(`nameable` = 仕分けが `P1` でない)**219 件**(分類の後に #1562 で 1 件、#530 の矢じり `place-line-arrow` で 1 件、#530 段⑤a の文字の大きさ `place-size` で 1 件、#530 段⑤b のグループ `place-group` / `place-ungroup` で 2 件、#529 W5 の付箋の上で書く 4 つで 4 件、#530 段⑤d の回転 `place-rotate` で 1 件増えて **229**。第 1 群で 18 件を登記して **211**、第 2 群で 26 件を登記して **185**、第 3 群で 2 件を登記して **183**)を、場面で分けて「名前で呼ぶ意味」を付けた。
> 手順と結論は `docs/development/operation-model-2026-08.md` §5.3「未登記 219 件の分類」。この file は**その全数表**である。

## 読み方

- **場面と 高/低 は、人が付けた分類**(機械が出すのは id・仕分け・押し所だけ)。高/低は意見であって、user の裁定ではない。
- **高** = 開いているノート・いま見ている面に対する日常の操作で、押す所を指さずに呼べる。**低** = ①確認画面・カード・帯の中のボタン ②押した物(行・項目・値)が対象を運ぶ ③部品を取るなど名前で呼ばせたくない ④登録済みの別 id が同じ実体を通している。
- **画面の字**は押し所の周りから機械で拾った候補を、人が読んで直した。`(…)` は「字が動的で、いまの画面の字を引けていない」こと。正本は画面。
- **押し所**は `outlets()` と同じ綴り 5 通りで探した最初の 2 か所まで。

## 場面ごとの件数

| 場面 | 件数 | 高 | 低 | 高の例 / 低の例 |
|---|---|---|---|---|
| ノートの整理 | 20 | 0 | 20 | (第 1 群で登記した ── 下の「登記した 18 件」) ／ 低: この整理案を適用 / タグを付ける |
| コピー・書き出し | 7 | 0 | 7 | (第 1 群で 4 件を登記した) ／ 低: 選択範囲をコピー / このブロックをコピー / この章をコピー |
| 予定 | 5 | 0 | 5 | (第 1 群で登記した) ／ 低: (前の日/次の日) / やること ほか |
| SQL | 8 | 0 | 8 | (第 2 群で 4 件を登記した) ／ 低: ○○ を外す / どのエンジンで実行するか |
| 本文の整形 | 3 | 0 | 3 | (第 2 群で 2 件を登記した) ／ 低: 図を入れる / アイコンを入れる / (整形バーの書式ボタン) |
| 録音・録画・時間 | 7 | 0 | 7 | (第 2 群で 3 件を登記した) ／ 低: 再生をやめる / 選んだ範囲を消す |
| ゴミ箱・選択 | 2 | 0 | 2 | (第 2 群で 3 件を登記した) ／ 低: まとめてゴミ箱へ移す / ゴミ箱を空にする |
| 検索・置換 | 1 | 0 | 1 | (第 2 群で 3 件を登記した) ／ 低: ×(一致の表示を閉じる) |
| 2 ペインファイラ | 14 | 0 | 14 | (第 2 群で 1 件を登記した) ／ 低: ゴミ箱 / (戻る) / (ブックマーク) |
| 表示の切り替え・絞り | 9 | 0 | 9 | (第 2 群で 2 件を登記した) ／ 低: 絞りを外す / (閲覧の切り替え) |
| 保存領域・保守 | 3 | 0 | 3 | (第 2 群で 2 件を登記した) ／ 低: ノートの保存データを作り直す / ノートの保存データを初期化する |
| 連絡先 | 0 | 0 | 0 | (第 2 群で 2 件とも登記した) |
| 設定 | 32 | 0 | 32 | (第 2 群で 1 件を登記した) ／ 低: コピーの履歴を消す / 最近開いた記録を消す |
| アプリ | 11 | 0 | 11 | (第 2 群で 1 件を登記した) ／ 低: 並べ替えを終える / アプリを開く |
| 取り込み・外部 | 7 | 0 | 7 | (第 2 群で 1 件を登記した) ／ 低: 外部画像を取り込む / リンク先のアイコンを取り込む |
| 履歴・版 | 2 | 0 | 2 | (第 2 群で 1 件を登記した) ／ 低: この版を閉じる / いまの本文と比べる |
| 確認画面・カード・帯の中のボタン | 18 | 0 | 18 | (なし) ／ 低: 外部の画像をこのノートで読み込む / 設定を適用 |
| 板 | 14 | 0 | 14 | (なし) ／ 低: ここに板を置く / テンプレートから板を置く… |
| 部品を取る | 7 | 0 | 7 | (なし) ／ 低: (取り込み中のやめる) / (Office の部品を選ぶ) |
| 章・コードの編集箱 | 4 | 0 | 4 | (なし) ／ 低: コードの編集をやめる / 章の編集をやめる |
| スマホ幅専用 | 2 | 0 | 2 | (なし) ／ 低: このノートの操作を開く / ← 一覧へ戻る ほか |
| **合計** | **176** | **0** | **176** | |

## ノートの整理

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
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
| `copy-selection-md` | 低 | 選択範囲をコピー | `src/adapter/ui/render/detail.ts:2157` | 🔴 第 1 群で登記を試みて外した:一覧を開いた瞬間に本文の選択が消え、ボタン自身も押せなくなる(実ブラウザで測った)。選択を運ぶ設計が別に要る。第 3 群でも見送り:消えるのは本文の欄の範囲ではなく、読む面の中の選択なので、欄の範囲を戻す仕組みでは運べない |
| `copy-block-md` | 低 | このブロックをコピー | `src/features/entry-actions.ts:941`<br>`src/features/entry-actions.ts:948` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `copy-chapter-md` | 低 | この章をコピー | `src/features/entry-actions.ts:814`<br>`src/features/entry-actions.ts:894` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `copy-section-link` | 低 | 章のリンクをコピー | `src/features/entry-actions.ts:826`<br>`src/features/entry-actions.ts:900` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `copy-section-ref` | 低 | 章の参照をコピー | `src/features/entry-actions.ts:821`<br>`src/features/entry-actions.ts:898` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `paste-many-copied` | 低 | 選んで、並べて、追記の欄へ入れる | `src/adapter/ui/actions/copy-history-menu.ts:56` | コピー履歴のメニューの中の項目 |
| `use-copied` | 低 | もう一度コピーする | `src/adapter/ui/actions/copy-history-menu.ts:48` | コピー履歴メニューの項目 |

## 登記した 18 件(#582 段③ 第 1 群、2026-10-11)

🟣 Gemini の回答(#1163 の依頼 16)「**場面ごとに 1 群ずつ足す**」の第 1 群 ── 上の 3 場面の「高」のうち 18 件を、
「操作を探す」と左の `>` の一覧に登記した(`KEY_COMMANDS`。鍵は付けない)。命令 id は押しボタンの
`data-pkc-action` と同じ綴りで、受け手は画面のボタンそのもの(`binder.ts` の `SHORTCUT_BUTTON`)。
**上の全数表(`高` / `低` の行)からは外した**(残る 1 件 `copy-selection-md` は上の表に 低 として置いた)(`tests/operation-table.test.ts` が「表の行 = 未登記の在庫」で突き合わせる)。

| 操作 | 状態 | 画面の字(元の表) | 一覧の字 | 押し所 |
|---|---|---|---|---|
| `add-relation` | 登記済み | つながりを足す | (下記) | `src/adapter/ui/render/inspector.ts:1400` |
| `add-tag` | 登記済み | タグを足す | (下記) | `src/adapter/ui/render/inspector.ts:1216` |
| `append-entry` | 登記済み | 本文に追記する | (下記) | `src/adapter/ui/render/append-box.ts:173` |
| `attach-file` | 登記済み | 添付する | (下記) | `src/adapter/ui/render/shell.ts:627`<br>`src/adapter/ui/render/shell.ts:632` |
| `clear-entry-date` | 登記済み | 日付を外す | (下記) | `src/adapter/ui/render/inspector.ts:1132`<br>`src/adapter/ui/render/inspector.ts:1125` |
| `open-today` | 登記済み | 今日のノートを開く | (下記) | `src/adapter/ui/render/browse.ts:116`<br>`src/adapter/ui/render/shell.ts:613` |
| `refresh-query` | 登記済み | 集計を数え直す | (下記) | `src/adapter/ui/render/query.ts:127` |
| `stack-save` | 登記済み | スタックを保存… | (下記) | `src/adapter/ui/render/split-view.ts:340` |
| `copy-note-md` | 登記済み | Markdown をコピー | (下記) | `src/adapter/ui/render/detail.ts:2153` |
| `copy-note-rich` | 登記済み | 書式付きでコピー | (下記) | `src/adapter/ui/render/detail.ts:2155` |
| `export-messages` | 登記済み | メッセージを書き出す | (下記) | `src/adapter/ui/render/settings/messages.ts:76` |
| `export-settings` | 登記済み | 設定を書き出す | (下記) | `src/adapter/ui/render/commands.ts:408` |
| `schedule-quick-add` | 登記済み | 予定を足す | (下記) | `src/adapter/ui/render/schedule.ts:742` |
| `schedule-today` | 登記済み | 今月に戻る/今日 | (下記) | `src/adapter/ui/render/schedule.ts:662` |
| `export-schedule-ics` | 登記済み | 予定を .ics で書き出す | (下記) | `src/adapter/ui/render/schedule.ts:777` |
| `toggle-show-archived` | 登記済み | 片付けたノート | (下記) | `src/adapter/ui/render/schedule.ts:776` |
| `toggle-show-done` | 登記済み | 済んだ行 | (下記) | `src/adapter/ui/render/schedule.ts:774` |
| `toggle-show-undated` | 登記済み | 日付のない項目 | (下記) | `src/adapter/ui/render/schedule.ts:772` |

- 🔑 一覧の字(`keymap.ts` の `label`)は押しボタンの字と同じ(`tests/adapter/palette-scene-batch.test.ts` が source から引いて突き合わせる)。**違うのは 5 件**:
  `toggle-show-*` の 3 件(画面の字は件数つきの「済み(3)」「片付けたもの(2)」「日付のないもの(5)」で、一覧に出すには「出す・隠す」の動詞が要る。頭の語は画面と同じ)/
  `attach-file`(画面は帯の「添付」と、`⋯` のメニューの「添付する」の 2 つ ── 後者に合わせた)。
  ⚠ 元の表の `schedule-today` の「今月に戻る/今日」は、後ろの「今日」が日・週の表示の `schedule-day-go` のボタンなので、`schedule-today` の字は「今月に戻る」だけである。
- 🔑 押せる条件は**ボタンが画面に在るか**:別の画面にいる間 / ノートを選んでいない間は、一覧が「いまは押せません ── 〜のときだけ効きます」と言う。
  行ごと隠してある間(日付が無い / 済み・片付け・日付なしが 0 件)も押せない。

## 登記した 26 件(#582 段③ 第 2 群、2026-10-11)

第 1 群と同じ作法(命令 id = 押しボタンの `data-pkc-action`、受け手は画面のボタンそのもの = `SHORTCUT_BUTTON`、鍵なし)で、残りの「高」のうち 26 件を登記した。
**登記する前に 1 件ずつ実ブラウザで「一覧から呼ぶと、画面のボタンと同じことが起きる」を確かめた**(確かめられなかった 3 件は下の「足さなかった 3 件」)。

| 操作 | 状態 | 画面の字(元の表) | 押し所 |
|---|---|---|---|
| `renumber-lists` | 登記済み | 番号を振り直す | `src/adapter/ui/render/format-bar.ts:191` |
| `sort-tasks` | 登記済み | 完了した項目を末尾へ移す | `src/adapter/ui/render/format-bar.ts:213` |
| `run-sql` | 登記済み | SQL を実行 | `src/adapter/ui/render/sql.ts:248` |
| `sql-er-toggle` | 登記済み | 構造を見る | `src/adapter/ui/render/sql.ts:329` |
| `sql-schema-to-note` | 登記済み | 構造をノートへ書き出す | `src/adapter/ui/render/sql.ts:304` |
| `sql-to-note` | 登記済み | ノートへ書き出す | `src/adapter/ui/render/sql.ts:261` |
| `start-audio-capture` | 登記済み | 録音する | `src/adapter/ui/render/shell.ts:645`<br>`src/adapter/ui/render/shell.ts:649` |
| `start-screen-capture` | 登記済み | 画面を録画する | `src/adapter/ui/render/shell.ts:652`<br>`src/adapter/ui/render/shell.ts:656` |
| `start-timer` | 登記済み | 時間を計る | `src/adapter/ui/render/shell.ts:667`<br>`src/adapter/ui/render/shell.ts:671` |
| `clear-selection` | 登記済み | 選択を解除 | `src/adapter/ui/render/filer.ts:487` |
| `hide-trash` | 登記済み | ゴミ箱を閉じる | `src/adapter/ui/render/filer.ts:1204` |
| `show-trash` | 登記済み | ゴミ箱を開く | `src/adapter/ui/render/filer.ts:1192` |
| `replace-all` | 登記済み | すべて置換 | `src/adapter/ui/render/shell.ts:857` |
| `search-jump-next` | 登記済み | ›(次の一致へ) | `src/adapter/ui/render/search-jump.ts:240` |
| `search-jump-prev` | 登記済み | ‹(前の一致へ) | `src/adapter/ui/render/search-jump.ts:238` |
| `clear-kind-filter` | 登記済み | 種類の絞りを外す | `src/adapter/ui/render/kind-bar.ts:128` |
| `toggle-filer-flatten` | 登記済み | 中まで全部出す | `src/adapter/ui/render/filer.ts:957` |
| `db-check` | 登記済み | ノートの保存データを確認する | `src/adapter/ui/render/commands.ts:542` |
| `storage-profile` | 登記済み | 容量を調べる | `src/adapter/ui/render/commands.ts:479` |
| `contacts-quick-add` | 登記済み | 連絡先を足す | `src/adapter/ui/render/contacts.ts:94` |
| `export-vcards` | 登記済み | vCard で書き出す | `src/adapter/ui/render/contacts.ts:190` |
| `dual-tab-add` | 登記済み | タブを足す | `src/adapter/ui/render/dual-filer.ts:1124` |
| `add-url-tile` | 登記済み | リンクを足す(一覧の「+」) | `src/adapter/ui/render/launcher.ts:129` |
| `pc-pick-folder` | 登記済み | PC のフォルダを選ぶ | `src/adapter/ui/render/pc-folder.ts:113` |
| `open-system-notices` | 登記済み | お知らせを開く | `src/adapter/ui/render/help.ts:626` |
| `hide-history` | 登記済み | 履歴を閉じる | `src/adapter/ui/render/detail.ts:4193` |

- 🔑 一覧の字(`keymap.ts` の `label`)は画面のボタンの字。**違うのは 4 件**:`start-audio-capture`(画面は帯の「録音」とメニューの「録音する」の 2 つ ── 後者)/ `start-screen-capture`(同じく「画面を録画する」)/ `search-jump-next`・`search-jump-prev`(画面は「›」「‹」だけで、読み上げ名の「次の一致へ」「前の一致へ」)/ `sort-tasks`(元の表の「完了した項目を末尾へ移す」は機械が拾った候補で、画面の字は「完了項目を末尾へ」)。
- 🔑 押せる条件は**ボタンが画面に在るか**(第 1 群と同じ)。例外が 2 つ:`open-system-notices` は押しボタンがヘルプの中にしか無いので、`open-manual-window` と同じ特例で、ヘルプの押し口と同じ `openSystemNotices` を直に呼ぶ(「設定」のボタンが出ている間だけ押せる。編集中も開ける)/ `dual-tab-add` は左右に同じボタンが居るので、**焦点の在る側**のボタンを引く(`[data-pkc-focused]`)。
- 🔑 欄が先に要る 3 件(`replace-all` の探す語 / `contacts-quick-add` の名前 / `add-url-tile` のアドレス)は、欄が空ならその欄へ移る(`PALETTE_FIELD_FIRST`)。
- 🔑 録音・録画・時間は、ノートを開いていないと**ボタンが押せる顔のまま**、押すと画面のボタンと同じ断り(「ノートを開いてから押してください」)が出る。灰色にはならない(ボタン自身が押せるため)。
- 🔑 検索の「次へ / 前へ」は、本文に当たりの送り(帯)が出ている間だけ呼べる。帯は①「探す」の行から開いたノートの別ウィンドウ ②左の探す欄に語を入れたままノートを選んだとき(主ウィンドウ)に出る(`SEARCH_JUMP_START` の起点は `main.ts` と `startSearchJumpFromField`)。出ていない間は灰色。実ブラウザでは①で確かめた。

### 足さなかった 3 件(第 2 群の時点)

- `insert-diagram` / `insert-icon`:→ **第 3 群(下)で登記した**。打っている場所に入れる操作で、一覧を閉じた直後の位置が先頭に戻る(実ブラウザで、`hello world` の 5 字目で呼んだらアイコンが先頭に入った / 選んでいた範囲は読めず、図の種類を聞かれた)ので、第 2 群では見送った。
- `dual-delete`:`filer-trash`(ゴミ箱へ移す)が同じ実体を通っている。**いまも登記していない**。

## 登記した 2 件(#582 段③ 第 3 群、2026-10-12)

第 2 群で見送った「打っている場所に入れる」2 件(`insert-diagram` 図を入れる / `insert-icon` アイコンを入れる)を、同じ作法(命令 id = 押しボタンの `data-pkc-action`、受け手は書式の帯のボタンそのもの = `SHORTCUT_BUTTON`、鍵なし)で登記した。

| 操作 | 状態 | 画面の字 | 押し所 |
|---|---|---|---|
| `insert-diagram` | 登記済み | 図を入れる | `src/adapter/ui/render/format-bar.ts:251` |
| `insert-icon` | 登記済み | アイコンを入れる | `src/adapter/ui/render/format-bar.ts:172` |

- 🔑 **直した物**:「操作を探す」を閉じた直後の本文の欄は、選択が先頭(0,0)へ戻っている。`openPaletteFor` が一覧を開いたときの範囲を控え、`CARET_TOOLS` に居る命令(8 件。書式の帯のうち、本文の欄の範囲を読む物)は、**実行の前に欄へ焦点と範囲を戻す**ようにした。
  控えた欄が組み直されて消えていたら、押さずに理由を出す(別の欄の先頭へ入れない)。
- 🔴 **同じ穴は、前から登記済みの 3 件にも在った**(実ブラウザで測った。`hello world` の 5 字目で一覧から呼ぶ。1 面の行・2 列の欄の両方):
  日付を入れる → `@2026-10-12hello world`(先頭)/ テンプレートを入れる → 表が先頭に入った。ノートリンクを入れるも同じ作りなので、同じ門で直った(実ブラウザでも確かめた ── 下の smoke)。
- 🔑 小窓(日付 / ノート / テンプレート / 図 / アイコン)をまたぐ分は、各ボタンが押した瞬間に範囲を控えて小窓の後で戻す作りが既に在った。足りなかったのは「押す前に、一覧が閉じて潰れた範囲を戻す」ところだけである。
- ⚠ **見送った 1 件**:`copy-selection-md`(選択範囲をコピー)。こちらの選択は**本文の欄ではなく、読む面(描画した本文)の中の選択**で、一覧を開いた瞬間に消え、ボタン自身の押せる条件も選択に依る。欄の範囲を戻す仕組みでは運べない(別の設計が要る)。
- 🔑 **マウスで「操作を探す」のボタンを押して開く道**(着地前レビューが見つけた)も同じ穴だった:ボタンへ焦点が移り、開いたときの欄が無くなって範囲を戻せず、先頭に入った(1 面のライブ編集では行が確定して消え、小窓も開かなかった)。直しは 2 つ ── ボタンの `mousedown` で焦点を奪わない / 焦点が欄に無くても、画面の本文の欄(`formatTarget`)の範囲を戻す先に使う。
- 🔑 左の探す欄の `>` の一覧から呼ぶ道(実ブラウザで測った):2 列の編集では、欄の選択が残るので打っていた場所に入る(直しは不要)。1 面のライブ編集では、探す欄を押した時点で行が確定して消え、「日付を入れる」を選んでも何も起きなかった(小窓も開かない)。直しは、行が探す欄へ焦点を渡す瞬間に「どの行・どの字・どこにカーソル」を控え、`>` から「打っている場所に入れる」操作を選んだとき、行を開き直してカーソルを戻してから実行する(`binder.ts` の `reopenLiveRowThen` / `row-swap.ts` の `reopenAt`)。開き直した行の原文が控えと違えば(本文が変わった・別のノート)、入れずに「書き込む欄が変わった」で断る。表の行・箇条書きの項目を開いていた場合も、同じ行・項目を探して開き直す(`row-swap.ts` の `subElementAtLine`)。⚠ **既知の限界**:打った結果が複数行で、確定のときに塊が分かれたり合体したりした場合は、控えた原文と合わず断る(入れない・本文は壊れない側)。キーボードで探す欄へ移る道は、行を開いている間は Ctrl+F が探す欄へ移らない(実ブラウザで測った)ので、この控えが要るのはマウスで探す欄を押した場合だけ。

## 板

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `add-place` | 低 | ここに板を置く | `src/features/entry-actions.ts:1049` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `add-place-template` | 低 | テンプレートから板を置く… | `src/features/entry-actions.ts:1057` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-append-open` | 低 | 追記 | `src/adapter/ui/render/place-inline.ts:50` | 押した付箋のノートがボタン自身に載る。どの付箋かが決まらないと呼べない |
| `place-color` | 低 | 色… | `src/features/entry-actions.ts:974`<br>`src/features/entry-actions.ts:975` | 色を選ぶ入力が要る |
| `place-color-clear` | 低 | 色を外す | `src/features/entry-actions.ts:979`<br>`src/features/entry-actions.ts:1025` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-inline-cancel` | 低 | やめる | `src/adapter/ui/render/place-inline.ts:127` | 付箋の上の欄の中のボタン(欄が開いていないと意味が無い) |
| `place-inline-commit` | 低 | 追記する/題名を直す | `src/adapter/ui/render/place-inline.ts:123` | 付箋の上の欄の中のボタン(欄が開いていないと意味が無い) |
| `place-group` | 低 | グループにする… | `src/features/entry-actions.ts:1043` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-line-arrow` | 低 | 矢じりなし/終わりに付ける/両端に付ける | `src/features/entry-actions.ts:1067` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-line-width` | 低 | 線を太くする/細くする/標準に戻す | `src/features/entry-actions.ts:1028`<br>`src/features/entry-actions.ts:1031` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-rect` | 低 | 位置と大きさ… | `src/features/entry-actions.ts:953` | 数値を入れる窓が要る |
| `place-rename-open` | 低 | 題名を直す | `src/features/entry-actions.ts:1093` | 右クリックした付箋のノートを、押した項目が運ぶ(どの付箋かが決まらないと呼べない) |
| `place-rotate` | 低 | 右に回す/左に回す/回転を解く | `src/features/entry-actions.ts:1063` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-shape-arrow` | 低 | 矢印にする | `src/features/entry-actions.ts:932` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-shape-diamond` | 低 | ひし形にする | `src/features/entry-actions.ts:931` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-shape-ellipse` | 低 | 楕円にする | `src/features/entry-actions.ts:930` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-shape-rect` | 低 | 四角にする | `src/features/entry-actions.ts:928` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-shape-round` | 低 | 角丸にする | `src/features/entry-actions.ts:929` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-size` | 低 | 文字の大きさ: 小/標準/大/特大 | `src/features/entry-actions.ts:1025` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `place-ungroup` | 低 | グループを解く | `src/features/entry-actions.ts:1041` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `raise-place` | 低 | 前へ出す | `src/features/entry-actions.ts:951` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `remove-place` | 低 | この板を消す | `src/features/entry-actions.ts:985` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |
| `remove-place-line` | 低 | この線を消す | `src/features/entry-actions.ts:998` | 右クリックした位置・行・塊を、押した項目が運ぶ(仕分けは N だが実は点を指す) |

## 予定

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `schedule-day-go` | 低 | (前の日/次の日) | `src/adapter/ui/render/schedule-day.ts:58`<br>`src/adapter/ui/render/schedule-week.ts:65` | 日表示の前後。押したボタンが向きを運ぶ |
| `schedule-mode` | 低 | やること ほか | `src/adapter/ui/render/schedule.ts:687` | 予定面の表示の切り替え(押した見出しが運ぶ) |
| `schedule-nav` | 低 | (前へ/次へ/今月) | `src/adapter/ui/render/schedule.ts:653`<br>`src/adapter/ui/render/schedule.ts:396` | 押したボタンが向きを運ぶ |
| `schedule-undo-move` | 低 | 元に戻す | `src/adapter/ui/render/schedule-undo.ts:126` | 動かした直後の知らせに付く一時ボタン |
| `schedule-week-pick` | 低 | (週の日の見出し) | `src/adapter/ui/render/schedule-week.ts:146` | 押した日を指す |

## 本文の整形

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `format-text` | 低 | (整形バーの書式ボタン) | `src/adapter/ui/render/format-bar.ts:40` | 書式の種類を押したボタンから読む。書式ごとの命令が既に別に在る |

## SQL

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
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
| `delete-selected` | 低 | まとめてゴミ箱へ移す | `src/adapter/ui/render/filer.ts:482` | 選択が前提。確認を伴う |
| `purge-trash` | 低 | ゴミ箱を空にする | `src/adapter/ui/render/filer.ts:1210` | 取り消せない。確認を伴う |

## 検索・置換

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `search-jump-end` | 低 | ×(一致の表示を閉じる) | `src/adapter/ui/render/search-jump.ts:242` | 検索の一致帯の中のボタン |

## 表示の切り替え・絞り

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
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
| `container-rebuild` | 低 | ノートの保存データを作り直す | `src/adapter/ui/render/commands.ts:341` | 保存データを作り直す。確認つきの保守 |
| `container-reset` | 低 | ノートの保存データを初期化する | `src/adapter/ui/render/commands.ts:364` | 取り消せない全消去。パレットに置かない |
| `storage-vacuum` | 低 | 縮める | `src/adapter/ui/render/commands.ts:272` | 保守。確認や待ちを伴う |

## 連絡先

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|

## 2 ペインファイラ

| 操作 | 名前で呼ぶ意味 | 画面の字 | 押し所 | 理由 |
|---|---|---|---|---|
| `dual-delete` | 低 | ゴミ箱 | `src/adapter/ui/render/dual-filer.ts:224` | 🔴 第 2 群で登記しなかった:`filer-trash`(ゴミ箱へ移す。鍵あり、文脈は 2 ペインでも効く)が同じ実体(`dual-delete`)を通している |
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

