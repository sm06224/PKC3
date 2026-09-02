# スタックの設計(#633)── 生きているスタックは端末(splitLids)、保存は本文リンク列の新フレーバー stack

> **user 裁定 2026-08-30(逐語)**:「**A3. その仕組みをスタックにしろ、スタックからすぐ呼び出せるようにしろ、スタックをグループとして参照のみのフォルダとして保存する機能もつけろ、スタックをセットした時の一番上が横の表示対象とする。細かいデザインは任せる**」

> ⚠ 本 doc は **doc-first** の設計案(実装していない)。3 つの角度(user の動線 / 実装最小 / 互換とリスク)で並列に出した案を、src と調査 doc(`docs/development/survey-2026-09-02-mobile-stack.md`)の事実で突き合わせて 1 つに統合したもの。**§4 の設問に user の裁定が出るまで実装に入らない。**

## 0. 決まっていること / この doc が決めること

| | |
|---|---|
| ✅ 裁定済み | ①順序を持つ束(スタック)②すぐ呼び出す口 ③参照のみのフォルダとして保存 ④一番上が横の表示対象。「細かいデザインは任せる」 |
| ⬜ この doc が決める(§2) | 生きているスタックの正本と保存場所 / 「参照のみ」の意味(元を消したら)/ 一番上の変え方 / 片道を作らない / 上限 / 自分自身と編集中 / 呼び出しの口 / 保存の器(3 系統目を作らない) |
| 🔴 user の裁定(§4) | 見え方・言葉の設問だけ |

⚠ 前提(2026-09-02 時点): 横に留めた並び(`splitLids`)は **PR #649 で localStorage に残るようになった**(それまで一度も永続していなかった)。狭い窓での見え方は #632 に従う。

## 1. 要約(3 案の食い違いと、どの事実で決めたか)

3 案の食い違いは 8 つで、全部 src / 調査 doc の事実で決めた(意見で決めた物は無い)。①保存の器(案1 smart の frontmatter `smart-lids` / 案2・3 新フレーバー `stack` = 本文が `- [題名](entry:lid)` の列)→ stack。根拠: smart-flavor.ts:5-13 と tree.ts:159-161 が「手で子を入れられない・中身が 2 種類になる害」を smart 自身で戒める / smart-spec.ts:490 の「落とす = 相手の本文にタグを書く」は参照のみと逆向き / storage-worker.ts:1863-1880 findBacklinks は本文の `entry:` 字面で引くので本文リンク列なら参照元が無料、frontmatter の lid 列には出ない / app-state.ts:4641-4643 refreshSmartHits は条件が空の入れ物の lid を保存のたびに落とす(smart-lids は緑のまま壊れる型)/ EntryMeta(entry-meta.ts:10-14)は body を持たないので、フォルダ タブで「中へ入れる」判定(tree.ts:162)に使えるのは archetype だけ = text + frontmatter 印では「フォルダとして」が成立しない。②フォルダ タブに出すか(案2 は出さない)→ 逐語「フォルダとして保存」で出す。③積める上限(10/8/20)→ 20。同型の dual-bookmarks.ts:27-33(参照だけ・順序つき・帯+×・断る)が 20 で、定数の理由を 2 つ作らない。枠 3 は「器を割る数」(split-frames.ts:45-51)で別の主張なので据え置き。④セットの意味(案3 全置換 / 案1・2 上に積む)→ 積む。全置換は保存していない並びを黙って失う片道(CLAUDE.md「さっきまでやっていたことが消える」)。⑤呼び出し(案1 Alt+7 で回す / 案2・3 一覧)→ Alt+7 は一覧(pickEntryInApp は rows 関数を受け題名だけ直書き app-dialog.ts:605-614、回すは N 回押す)、Alt+8 載せる(view-dual 型 binder.ts:1789-1803)。⑥消えたノートを帯から降ろすとき言うか → 言う(store-effects.ts:835-854 は無言。dead click を作らない)。⑦「← 左で開く」(案3 のみ)→ 入れる(select-entry は data-pkc-entry を読む既存受け手 binder.ts:2104。調査 split #31 の無言の代わり)。⑧鍵を cid で分けるか → 段①では分けない(settings-file.test.ts:73-93 の全数 pin が動的鍵で落ちる。自己修復在り)。残る user 設問は見え方・言葉の 4 つだけ。段は 5 つで、段①だけで #584 が閉じる。

## 2. 決めたこと(推薦 1 つ + 理由 + 覆る条件)

### 2-1. 生きているスタック(いま横に出ている並び)の正本と保存場所

- **推薦**: 既存の AppState.splitLids + localStorage 'pkc3.split-lids' をそのまま使う(新 state・新鍵・flag を作らない)。並びの意味だけ「先頭 = 一番上」に変える
- **理由**: 順序つき参照列を reducer(app-state.ts:4038-4102)/ 描画(split-view.ts:198-209)/ 復元(main.ts:2934-2953、PR #649)/ 削除追随(:4441)/ 自己修復(store-effects.ts:835-854)まで揃えて持つ唯一の機構。#505 裁定「ノートごとではなく画面の設定」(split-store.ts:4-7)を覆さない。settings-file.ts:75 が lid を運ばない理由を明記
- **これが分かったら覆る**: user が設問①で「別の端末でも開いた瞬間から同じ帯」を選ぶ(→ 正本を container の settings 表へ移す。#505 を覆す提案として別に出す)

### 2-2. 「参照のみのフォルダとして保存」を既存のどれに乗せるか(案1 smart frontmatter / 案2・3 新フレーバー)

- **推薦**: 新フレーバー `stack`(呼び名「スタック」)。本文 = `- [題名](entry:lid)` の箇条書き、順序 = 出現順。relations に順序列は足さず、smart にも混ぜない
- **理由**: smart-flavor.ts:5-13「この入れ物に手で子を入れることはできない / 中身が 2 種類になる害」+ tree.ts:159-161 同旨 / smart-spec.ts:490 落とす = 相手の本文にタグを書く(参照のみと逆)/ storage-worker.ts:1863-1880 findBacklinks は本文の `entry:` を LIKE + bodyLinksTo で引く → 本文リンク列なら参照元が無料、frontmatter の lid 列は出ない / app-state.ts:4641-4643 refreshSmartHits は条件が空の入れ物の lid を保存のたびに落とす / body-links.ts:69-84 出てきた順・重複畳み / entry-ref-format.ts:32 組み立て 1 本 / place-notation.ts:5-9 の前例「関係テーブルではなく本文の記法に書く」/ schema.ts:159-168 relations に順序列無し、whiteboard doc:56-70 列追加は旧ビルドで黙って欠損 / flavor/index.ts:48-51 未知 archetype は text fallback。⚠ whiteboard doc:42 の「新しいエントリタイプ = この 1 件」は批評どおり「都度 user の言葉が要る」と読み、#633 逐語「フォルダとして保存する機能もつけろ」をその言葉と読む(EntryMeta は body を持たないので、フォルダ タブで中へ入れる判定に使えるのは archetype だけ = 新 archetype 以外に「フォルダとして」を満たす形が無い)
- **これが分かったら覆る**: user が「ノートの種類を増やすな」と言う(→ text + frontmatter `stack: true` に倒す。そのときフォルダ タブには出ず、「このスタックを載せる」だけが残る ── 動線が 1 つ減るので、その旨を明記して聞く)

### 2-3. 並びの意味と横の表示対象(裁定④)

- **推薦**: 先頭 = 一番上。横に出るのは先頭から `fittingSplitFrames` が入ると言う枚数(上限 3 枠 = SPLIT_FRAME_MAX 4 − 主 1 は据え置き)。先頭は必ず出る。狭い窓は後ろから畳む(既存規則)ので下の物から消える
- **理由**: split-view.ts:200-204 `show = want.slice(0, fit-1)` は先頭から取るので、push の向きを先頭へ変えるだけで④が成立し判定を 1 つも増やさない / split-frames.ts:45-51 枠上限は READ_COLUMN_CHOICES と揃えた「器を割る数」で、積む数とは別の主張 / #505「任意分割 ── 2 固定にしない」を覆さない
- **これが分かったら覆る**: user が「横は常に 1 枚でよい」と言う(→ slice(0,1)。#505 の裁定を覆すので会話で確認。3 枚並べる動線を落とすので代わり = 帯で切り替える、を manual に書く)

### 2-4. 載せる操作の意味(既に在る物を載せ直したとき)

- **推薦**: 先頭へ積む。既在なら先頭へ上がる(いまは「並びを動かさない」)。載せる / 呼び出す / 上げる の 3 つが `pinSplitLid` 1 関数の同じ規則になる
- **理由**: split-frames.ts:101-106 が末尾追加・既在は同じ参照。「並びを動かさない」理由は「押し直しで場所が飛ぶ」だったが、帯に並びが見えるので解ける。raise を別 op にしない(§7)
- **これが分かったら覆る**: user が「載せ直しても順は動かないでほしい」と言う(→ 既在は同じ参照に戻し、上げるのは帯の札だけ = RAISE を別 op にする)

### 2-5. 一番上をどう変えるか(掴んで並べ替え / 押して上げる)

- **推薦**: 押して上げる(帯の札を押す = PIN_SPLIT_ENTRY と同じ 1 action)。D&D は作らない
- **理由**: 1 押しで済み、指でも効き(#632)、掴む仕掛けは PKC_DRAG(binder.ts:4917)と place-drag の 2 つで新しい drop 判定を足さない。dual-bookmarks.ts / dual-filer.ts の「帯 1 本 + 押す」前例。「マウスだけで完結し、キーボードは近道」(founding)
- **これが分かったら覆る**: cowork 実機で「並べ替えが常態(3 回以上)」が出る(→ 札の右クリックに「1 つ上へ / 1 つ下へ」。D&D にはしない)

### 2-6. 積める上限と超えたときの挙動

- **推薦**: STACK_MAX = 20。21 件目は「スタックに載せられるのは 20 件までです(1 つ降ろしてから載せてください)」で断り、古い物を黙って落とさない。帯は 1 行固定・横 scroll。畳んだ枚数の帯(sayIfDropped)は min(want, 3) − shown で数える(20 件積んで「17 枚畳みました」と言わせない)
- **理由**: dual-bookmarks.ts:27-33 が同型(参照だけ・順序つき・帯+×・断る)で 20、理由「手違いの検出」── 定数の根拠を 2 つ作らない / app-state.ts:4051-4062 満杯の断り文の型 / split-view.ts:219-229 sayIfDropped は want − shown で数えている
- **これが分かったら覆る**: 帯の実測で 20 札が 1 行に収まらず主領域を食う(→ 12 = MAX_TABS へ下げる)

### 2-7. 「参照のみ」の意味 ── 元のノートを消したら

- **推薦**: 生きているスタック: いまどおり自動で降りる(app-state.ts:4441 / effect null)が、黙らずに「「X」はノートが見つからないので降ろしました」を状態行に 1 行出す。保存した入れ物: 本文のリンク行は残り、一覧からは消え(filerRows が entryMetas で落とす)、ゴミ箱から戻せば戻る。載せるときは「N 件を載せました(M 件は見つかりません)」。メンバーの本文は 1 バイトも書かない
- **理由**: split-state.test.ts:164 が削除時の自動解除を pin / store-effects.ts:847 は無言 UNPIN(dead click の型)/ filer-list.ts:70-76 消えた lid を落とす / inspector.ts:494-495「(見つかりません)」の言い方 / storage-worker.ts:2186-2197, 2501-2507 削除は残し purge で消す寿命
- **これが分かったら覆る**: user が「札に『(見つかりません)』で残してほしい」と言う(→ dual-bookmarks.ts:19-21 の作法へ)

### 2-8. 保存した入れ物を開いたとき横の枠が変わるか(案3 の設問①)

- **推薦**: 押すまで動かない。入れ物を開くだけでは横の枠は変わらず、「このスタックを載せる」を押した瞬間に上に積まれる。セット = 上に積む(重複は畳む。上限超過は件数で言う)、全置換にしない
- **理由**: CLAUDE.md「さっきまでやっていたことが消える」/ #505「横の枠は user が留める・外すときだけ変わる」/ 「全部降ろす」があれば置換相当は 2 手で作れる(積むは置換の上位互換)
- **これが分かったら覆る**: user が「セット = 入れ替え」を望む(→ confirmInApp を 1 枚挟んで置換)

### 2-9. 呼び出しの口(裁定②)

- **推薦**: 帯の札(マウス)+ KEY_COMMANDS 3 件: `stack-open`「スタックを開く」Alt+7(pickEntryInApp を題名引数化して流用。行 = 生きているスタック上から + 保存した入れ物。ノートを選ぶと先頭へ、入れ物を選ぶと上に積む)/ `stack-push`「いま読んでいるノートをスタックに載せる」Alt+8(runGlobalCommand の view-dual 型で直に投げる)/ `stack-clear`「横に載せた物を全部降ろす」(既定の鍵は置かずパレット行だけ ── 空 defaults が keymap の検めを通らなければ Alt+9)。パレット行は KEY_COMMANDS から自動
- **理由**: palette-rows.ts:118-133 パレットは KEY_COMMANDS 全走査でノートを並べられない / app-dialog.ts:605-614 pickEntryInApp は rows 関数を受け題名だけ直書き / keymap.ts:323-463 Alt+1〜6・[ ] \ 使用済、Alt+7/8/9/0 未使用、REFUSED(:925-937)に無い / keymap.ts:872-879 Alt+数字は打鍵中止まる(manual §10 3549-3551 の注記が既に在る)/ binder.ts:1789-1803 view-dual が「ボタンの無い面は直に投げる」前例 / #584 コメント: 対象を取る操作(P1)はパレットに載らない → 「全部降ろす」だけ載せる
- **これが分かったら覆る**: #632 のスマホ用画面に Alt が無い(→ 帯が唯一の口になるので「帯を畳まない」をあちらに引き渡す)

### 2-10. 自分自身と編集中の扱い

- **推薦**: 自分自身は載せられる(据え置き)。一番上が主と同じなら同じ物が 2 枚(現状どおり)。編集中でも載せる / 上げる / 降ろす / セットは効く(state だけ、本文を書かない)。「保存…」だけ編集中は disabled + title「編集を終えてから」
- **理由**: split-frames.ts:78-82 主の lid を捨てない意図 / PIN/UNPIN reducer(app-state.ts:4038-4078)は phase を見ない / split-view.test.ts:236-261 編集中も枠は残る(user 裁定 2026-08-28)/ CREATE_ENTRY は ready 限定(:3284)/ inspector.ts:166-185 #513 の「押せるのに無言」禁止
- **これが分かったら覆る**: 編集中にチップを押して主の枠が動く経路が 1 つでも見つかる(SELECT_ENTRY は editing で無視 :1869 なので想定外)

### 2-11. 判定を 1 か所へ寄せる(§7)

- **推薦**: ①順序・上限の純関数(pin=先頭へ既在なら上げる / unpin / normalize(STACK_MAX))は features/split-frames.ts 1 file ②何枚出すかは SplitView.render の slice 1 か所 ③帯も一覧も `knownSplitLids(state.splitLids, entryMetas)` ④「参照で集める器か」= `collectsByReference(archetype)`(smart || stack)1 関数 → canEnterScope / filerRows / smartScanFor / renderSmartBar / refreshSmartHits の skip / 落とす判定が引く ⑤リンクの読み = bodyLinkTargets、組み立て = formatEntryLink ⑥入れ物の書換(段④)= BodyRewrite に link-append / link-remove / link-move を足し REQUEST_BODY_REWRITE 1 本 ⑦行メニューの条件 = entry-actions.ts の WHEN 表に 'stack' 1 行(情報ペインと右クリックへ自動)
- **理由**: tree.ts:162 canEnterScope / filer-list.ts:53-76 smart 分岐 1 か所 / app-state.ts:301-305 smartScanFor / filer.ts:217-240 renderSmartBar / app-state.ts:4607-4660 refreshSmartHits / body-rewrite.ts の kind 列 / entry-actions.ts:50-60 WHEN, :77-88 entryMenuActions
- **これが分かったら覆る**: 無し(規律)

### 2-12. 保存した入れ物の中身をフォルダ タブでどう出すか(worker を触るか)

- **推薦**: 触らない。SET_SCOPE → smartScanFor が stack でも REQUEST_SMART_SCAN を出し、effect が同じ enqueue の列で getBody → bodyLinkTargets → SMART_SCANNED { lids: 本文順, total, listed: true }。SmartHitState に `listed` を足し、refreshSmartHits は listed を skip、renderSmartBar は archetype で分けて「N 件 / このスタックを載せる」を出す
- **理由**: store-effects.ts:582-650 REQUEST_SMART_SCAN は既に本文を読んでから worker を呼ぶ形(isSmartEmpty 短絡)/ filerRows は opts.smartLids の順を保つ / refreshSmartHits(:4641-4643)は spec が空だと lid を落とすので skip が要る(変異試験の第 1 号)
- **これが分かったら覆る**: 入れ物が 100 件超で開くたびの getBody が重いと実測で出る(→ worker の bindUpsert に body_links 列を additive で足す。schema.ts:12-27 の作法)

### 2-13. 行の右クリック(一覧)に「スタックに載せる」を出すか

- **推薦**: 段①では出さない。理由は entry-actions.ts:185-193 のまま(行を右クリックすると選ばれるので主と同じ物が 2 枚並ぶ)。代わりは Alt+8 と、段⑤の「行を帯へ落とす」
- **理由**: entry-actions.ts:185-197 / tests/features/entry-actions.test.ts:58-80 ENTRY_ACTION_LABELS 等値と inspector の parity pin
- **これが分かったら覆る**: user が「一覧から直接載せたい」と言う(→ WHEN 表に足す。情報ペインにも同じ字が自動で出る)

### 2-14. 端末鍵 'pkc3.split-lids' を cid で分けるか

- **推薦**: 段①では分けない。lid は epoch36+counter で衝突はまず無く、本文 null で自己修復する
- **理由**: settings-file.test.ts:73-93 鍵の全数走査と等値 pin(動的鍵で落ちる)/ store-effects.ts:835-854 自己修復 / 調査 split #13/#15
- **これが分かったら覆る**: PKC2 由来の取り込み lid で別ノートが横に出る報告が来る(→ 鍵に cid を含め、走査 pin と併せて直す)

### 2-15. 帯の置き場(DOM)

- **推薦**: 本文の面の上端 1 行。⚠ view-pane の中ではなく区画 detail の先頭(view-pane の兄)に置き、空なら DOM に置かない
- **理由**: read-columns.ts:259/327 が pane.getBoundingClientRect を段の高さに使うので、pane の中に置くと段が溢れる / split-view.test.ts:57-96「既定は 1 枠」は pane の印と送りの持ち主を見る(外なら触らない)/ pane-visibility.test.ts:36 PANES は 3 つ(帯を pane にしない)/ split-view.ts:19-22「留めていなければ器も印も出さない」と同じ門
- **これが分かったら覆る**: user が設問②で B(本文の下)を選ぶ

### 2-16. 作る種類(▼)に「スタック」を足すか(段④)

- **推薦**: 足す(空の入れ物を作って行を落とせる)。ただし段④
- **理由**: 「置けるなら外せる」の対 ── 帯の「保存…」からしか作れないと中身は保存の瞬間で固まり、直すには本文を開くしかない。shell.ts:110-124 CREATE_BUTTONS の 1 表 + archetype-label.ts + flavor/index.ts の 3 か所
- **これが分かったら覆る**: user が「空のスタックが並ぶのは嫌」と言う(→ 「保存…」からだけ)

### 2-17. 旧ビルドが core record / 端末の鍵を読んだら何が見えるか

- **推薦**: container: archetype 'stack' の entry 1 件。旧ビルドは text fallback で普通のノートとして開き、本文は押せるリンクの箇条書き、種別の札は綴り 'stack' がそのまま出る、チップは dot、中へは入れない。旧ビルドで本文を直しても markdown のまま。schema / relations / entry_order / DB_SCHEMA_VERSION は不変。端末: 'pkc3.split-lids' の形(空白区切り)は変えない。旧ビルド(v3.2.x)は normalizeSplitLids で 3 件に切って書き戻すので 4 件目以降が消える(端末の設定。お知らせに 1 行)
- **理由**: flavor/index.ts:48-51 / archetype-label.ts:24-44 / icons.ts:301 未知は dot / split-frames.ts:85-94, 162-170
- **これが分かったら覆る**: 無し ── 段③着地前に旧ビルドの読み方を再現する pin(differential-save-retirement の型)を置く

### 2-18. フラグで段階導入するか

- **推薦**: しない。載せていなければ画面は 1 バイトも変わらないので、既定 = 今の挙動を満たす
- **理由**: flags.ts「既定は必ず今の挙動」/ split-view.ts:19-22 の門
- **これが分かったら覆る**: user が「まず試したい」と言う(→ 帯の表示だけを flag に)

## 3. 捨てるもの / 出さないものと、代わりに何ができるか

> 🔑 検算: 行ごとに「代わり」が書けている(書けない行 = 動線を 1 つ減らしている)。

| 出さない / 捨てる | 代わりに何ができるか |
|---|---|
| 「留めた順に左から並び、先に留めた物が残る」(末尾追加・FIFO) | 新しく載せた物が主のすぐ隣に来て、古い物は下(右)へ。どれでも帯の札を押せば一番上に上がる(今までは外して留め直すしか無かった動線が、押す 1 回になる) |
| 「同じノートをもう一度留めても並びは動かない」(split-frames.ts:101-103) | もう一度載せる = 一番上へ動く(= 呼び出す)。場所が飛ぶのを嫌った理由は、帯に並びが見えることで解ける |
| 断り文「横に並べられるのは 3 件までです」(留め 3 件が上限) | 20 件まで載る。横に出るのは入る枚数(最大 3)で、出ていない物も帯に札で残り、押せば出る |
| 幅で畳まれた枠に「× 外す」が無い(#584 の片道) | 帯の札の × で、枠が見えていなくても降ろせる。枠の中の「× 降ろす」もそのまま残す |
| 枠の「× 外す」の字 | 「× 降ろす」(同じ受け手 unsplit-entry。title「横に並べるのをやめる(ノートは消えません)」は残す) |
| 「幅が足りないので…N 枚畳みました」の N がスタックの長さぶん出る | 表示上限 3 に対してだけ数える。どれが横に出ているかは帯の札の印(data-pkc-shown)で常に見える |
| 留めた枠の見出しの Ctrl+クリック(無言 no-op。据え置き) | 枠の帯の「← 左で開く」で主の枠に開いて編集(select-entry) |
| 留めた枠の中の右クリック(ブラウザ既定のまま。据え置き) | 降ろす・上げる・左で開くは帯に在る。要るなら段④で札の右クリック(1 つ上へ / 1 つ下へ / 降ろす) |
| 消えたノートを帯から降ろすとき黙って降ろす(現状) | 降ろしたことを状態行に 1 行言う。保存した入れ物のリンクは残り、ゴミ箱から戻せば戻る |
| 本文の右クリックの字「このノートを横に留める」(設問③で user が選べば残す) | 「このノートをスタックに載せる」+ 説明の欄(C-3 着地後)。押す場所は同じ |
| 生きているスタックは別の端末に運ばない(SKIPPED_KEYS のまま) | 「保存…」で作った入れ物はノートなので別の端末にも出て、そこで「このスタックを載せる」1 押しで同じ横並びになる |
| 保存した入れ物の中の並べ替え(段③では UI 無し) | 本文を開いて行を入れ替えれば変わる(記法どおり)。段④で「上へ / 下へ」を入れ物の帯に足す |
| 保存時に題名を聞く器(promptInApp は無い) | 「スタック 2026-09-02 18:30」の既定題名で作り、既存の改名で直す。作った直後にその入れ物を選んでおく |
| (今も無い)一覧の行・情報ペインから載せる口(段①) | Alt+8(いま読んでいる物)と、段⑤の「行を帯へ落とす」(主の枠を動かさずに載せる唯一の道)。行の右クリックに置かない理由は entry-actions.ts:185-193 のまま |
| スマホの幅では横の枠が出ない(#632 の裁定に従う) | 帯(1 行)と Alt+7 の一覧は残し、選んだ物は「左で開く」で本文に出す。詳細は #632 へ引き渡す |
| Alt+7 の一覧に × を置かない(pickEntryInApp の行は 1 押し = 選ぶ) | 降ろすのは帯の札の × / 全部降ろすはパレット。一覧は「呼び出す」専用にして 2 つの意味を混ぜない |

## 4. 🔴 user に決めていただきたいこと(画面の言葉)

⚠ 調べれば決まるものは §2 で決めた。ここに残るのは**見え方・言葉・好み**だけ。

### 設問 1: いま横に出している並び(本文の上の帯)は、同じノート一式を別のパソコン / スマホで開いたときにも、開いた瞬間から同じ並びで出てほしいですか? それとも帯はその端末だけで、別の端末では「保存した入れ物」(フォルダ タブの星つき)を開いて「このスタックを載せる」を押せば同じ並びになる、でよいですか?

- (①) A: この端末だけ。別の端末では帯は空で始まり、フォルダ タブの「スタック 9/2」のような入れ物を開いて「このスタックを載せる」を押すと同じ並びになる
- (②) B: 別の端末でも、開いた瞬間から同じ帯が出る(並びをノート一式の中に持つ。その端末の画面が狭いと、入らない分は帯に残って横には出ない)

**推薦**: A。#505 の裁定「ノートごとではなく画面の設定」がそのまま生き、保存した入れ物が端末をまたぐ役を持つ。B は「画面の広さと関係のない並びが復活する」という #505 の反対理由に当たるうえ、正本が 2 か所になる

### 設問 2: スタックに 1 件でも載っている間、本文の上に 1 行の帯が出ます: [議事録 ×][資料 B ×][資料 A ×] … 右端に「保存…」。いちばん左(= 一番上)は濃く出て、札を押すとその物が右の枠に来て、× で降ります。新しく載せた物は本文の「すぐ隣」に来て、それまで隣に在った物は右へずれます(今までは右端に足されて隣は動きませんでした)。何も載せていなければ帯は出ず、画面は今までどおりです。この見え方でよいですか?

- (①) A: 本文の上に 1 行の帯、新しく載せた物が本文のすぐ隣(裁定④「一番上が横の表示対象」の形)
- (②) B: 帯は本文の下(追記欄の上)に出す。並びは A と同じ
- (③) C: 帯は A の場所、ただし新しく載せた物は今までどおり右端に足す(隣は動かない。そのときは「一番上」= 右端の意味になり、帯の並びも右が上)

**推薦**: A。帯の役目は「畳まれた枠を降ろす」「上げる」で、押すのは読んでいる最中なので本文の上が近い(左の列は畳まれると消える = #609 の穴と同じ)。並びは裁定④の逐語から決まる。高さは 1 行固定・横 scroll で #300 型の占有にしない

### 設問 3: 本文を右クリックしたときの字を「このノートを横に留める」から「このノートをスタックに載せる」に変えてよいですか(押して起きることは同じ: 右の枠に出て、帯に札が増えます)。枠の「× 外す」も「× 降ろす」になります。右クリックの説明欄(#651 で着地済み)には「一番上に載って横の枠に出ます。上の帯に並び、押せば一番上へ戻せます」と出します

- (①) A: 字を「スタックに載せる」「× 降ろす」に変え、説明も出す(マニュアル・お知らせも同じ字に)
- (②) B: 字は今のまま(「横に留める」「× 外す」)、説明の欄だけ出す。帯の名前だけ「スタック」
- (③) C: 字も説明も今のまま(帯だけ足す)

**推薦**: A。帯の名前(スタック)と押す字が同じ語でないと、帯に並んだ物と押した物の対応が読めない

### 設問 4: 「保存…」で作った入れ物は、左の列の「フォルダ」タブに星つきの入れ物として並び、開くと載せた順にノートが並びます(スマートフォルダの隣)。開いただけでは横の枠は変わらず、その帯の「このスタックを載せる」を押した瞬間に、いま横に出ている物の上に積まれます(いまの並びは下に残ります)。この動きでよいですか?

- (①) A: 押すまで動かない。押すと上に積まれ、いま横に出ている物は下に残る(全部入れ替えたければ先に「全部降ろす」)
- (②) B: 押すと入れ替わる(いま横に出ている物は消える。保存していない並びは戻らない)

**推薦**: A。B は「さっきまでやっていたことが消える」片道になる。A なら B は 2 手で作れる

## 5. 段(単独で着地・計測できる順)

| 段 | 大きさ | 単独で着地 | 単独で測る観測点 |
|---|---|---|---|
| 段① 生きているスタック ── 先頭 = 一番上(pin は先頭追加・既在なら上げる)/ STACK_MAX 20 と枠 3 を分ける / 帯(札 = pin-split、× = unsplit-entry、印 data-pkc-shown、右端「保存…」は段③まで hidden)/ 枠の帯に「× 降ろす」「← 左で開く」/ sayIfDropped を表示上限で数える / 消えたノートを降ろすとき 1 行言う / manual §「横に並べて読む」書き直し / お知らせ 1 件 ── #584 がここで閉じる | M | ✅ | smoke(split-frames.smoke.spec): 資料 A → B の順に載せる → 主の隣の枠は B / 窓を 1000px に狭めて枠が畳まれても帯の × で降ろせる(枠が DOM に無い lid に対して撃つ = #584 の当の経路。localStorage も減る)/ 4 件目を載せると主の隣に出て帯の 4 札のうち先頭 3 つに印 / reload 後も帯と横の枠が同じ(既存 :283 を流用)。unit: pin が先頭へ・既在は上がる(件数は増えない対照群)/ 21 件目の断り文 / 20 件積んで幅十分なら「畳みました」を言わない / 何も載せていなければ帯の要素が DOM に 0 件(split-view.test「既定は 1 枠」が緑のまま) |
| 段② すぐ呼び出す ── Alt+7「スタックを開く」(pickEntryInApp を題名引数化)/ Alt+8「いま読んでいるノートをスタックに載せる」/ パレット「横に載せた物を全部降ろす」/ manual §10 の 2 行 | S | ✅ | smoke(keymap.smoke.spec): Alt+7 で器が開き行が生きているスタックの順、Enter でその物が主の隣へ / Alt+8 で選んでいるノートが先頭に載る / パレットに 3 行が出て、空なら「いまは押せません ── 載せてあるノートがありません」。unit: paletteRows に 3 行、runGlobalCommand の dry が押せる / 押せないを正しく返す。docs-parity「既定の割当がマニュアルに全部載っている」が緑 |
| 段③ 保存した入れ物 ── フレーバー stack(本文 = リンクの並び、seed は空の説明 1 行)/ 帯の「保存…」= CREATE_ENTRY(edit:false、既定題名、parentLid = いま見ているフォルダ)/ フォルダ タブで中へ入る(collectsByReference)/ 中の並びは本文順(effect が本文を読んで SMART_SCANNED listed)/ 入れ物の帯「このスタックを載せる」= 上に積む / 見つかりません の数 / 旧ビルドの読み方 pin / お知らせ 1 件 | M | ✅ | unit: 「保存…」で archetype stack・本文が N 行の `- [題名](entry:lid)`(スタック順)の entry ができ、selectedLid は動かず本文は退かない / SET_SCOPE で SMART_SCANNED が本文順の lids を持ち worker を呼ばない / 載せると splitLids の先頭 N 件 = 本文順、いままでの並びが後ろに残る / 載っているノートを保存しても入れ物から消えない(refreshSmartHits skip の対照群 ── 変異試験の第 1 号)/ メンバーの本文は byte 同一 / 旧ビルド相当: 同じ record を text fallback で描いて `a[href^=entry:]` が N 本、canEnterScope が偽。smoke: 入れ物に入ると行が本文順、「このスタックを載せる」で右の枠が 1 行目のノートになる。書き出して別の空 DB に取り込み、同じ順で N 件並ぶ |
| 段④ 入れ物の双方向 ── 行を落とすと本文に +1 行(link-append)/ ここから外す(link-remove、fence 内は触らない)/ 上へ・下へ(link-move)/ 作る種類(▼)に「スタック」/ 「保存…」で既存の入れ物へ上書き / 札の右クリック(1 つ上へ・下へ・降ろす) | M | ✅ | unit(body-rewrite.test): link-append で入れ物の本文 +1 行・相手の本文 byte 同一 / link-remove で −1 行(fence の中の同じ字は消さない対照群)/ link-move で隣と交換。smoke(organize / dual-filer): ノートを星つきの入れ物に落とす → 一覧に 1 行増え、落としたノートの情報ペインの「参照元」に入れ物が出る / 「ここから外す」で消える。docs-parity の pick-create-kind 等値が新しい表で緑 |
| 段⑤ 一覧 / フォルダの行を帯へ落として載せる(data-pkc-drop='stack'、複数印は印の全部)── 主の枠を動かさずに載せる唯一の道 | S | ✅ | smoke: 一覧の行を帯へ落とすと主の枠は動かず、落とした物が一番上に出る(対照群: フォルダの行へ落とすと今までどおり移動 / 上限超過は件数で断る) |

## 6. 落ちる test(実装前に持っておく一覧)

- tests/features/split-frames.test.ts:43「同じ物を 2 度留めても増えず、並びも動かない」── 新規則(既在なら先頭へ)と正面から食い違う(期待値を裏返し、対照群「件数は増えない」を残す)
- tests/features/split-frames.test.ts:48-57 / :69-72 ── SPLIT_PINNED_MAX(3)を積める上限として import。STACK_MAX(20)へ分けると数と名前が動く(「横に出るのは 3」は :106-145 の fittingSplitFrames 側が守り続ける)
- tests/adapter/split-state.test.ts:107-118 ── 満杯の断り文と SPLIT_PINNED_MAX を pin。上限と文言(「横に並べられるのは」→「スタックに載せられるのは」)が変わる。manual.md:1695-1697 の「3 件まで」も道連れ
- tests/smoke/split-frames.smoke.spec.ts:189(#608「3 件留めて 2 枠なら先に留めた 2 つが残る」)と :78 の並びの assert ── 先頭 = 上では後に載せた側が残るので落ちる(期待値を裏返す)。:283(reload)は緑のはず
- tests/adapter/split-view.test.ts:470-560(#608 面の幅で畳む)── 期待値が「先に留めた側が残る」向きで書かれていれば落ちる(件数だけを見ている it は通る)。:314-430(#606 帯)は sayIfDropped の数え方を変えると動くので「20 件・幅十分 → 言わない」の対照群を先に置く
- tests/adapter/split-view.test.ts:57-96「既定は 1 枠」── 帯を view-pane の中に常設すると落ちる。守るべき条件(空なら DOM に置かない・pane の外に置く)として使う
- tests/features/entry-actions.test.ts:262-270 ── 「説明を持たない項目 = BODY_MENU_ACTIONS 全件」の等値 pin。pin-split に説明を足すと落ちる(C-3 着地後に cycle-read-columns だけが残る形へ)。:58-80 ENTRY_ACTION_LABELS 等値 / :219「出る項目は 1 つ残らず説明を持つ」/ :42 受け手 ── 段③で 'stack-load' 行を WHEN 表に足すと 3 つとも道連れ
- tests/adapter/inspector-titles.test.ts:155「情報ペインの説明と右クリックの説明が一致する」── 段③の 'stack-load' は両面へ自動で配られるが、字と説明を同時に足さないと落ちる
- tests/adapter/body-context-menu.test.ts:125「出るのは本文用の一覧」── 字を「スタックに載せる」へ変える(設問③ A)と、manual.md:1644 / 1685 と一緒に道連れ
- tests/docs-parity.test.ts:861「既定の割当と名前がマニュアルに全部載っている」── Alt+7 / Alt+8 を manual §10(3537-3548)に足さないと落ちる / :935「存在しないメニューを名乗らない」の等値 pin ── 帯の説明で「メニュー」と書かない / :1212 DROPPED ── お知らせを足すと上限 10 で 1 件落として一覧に足す / :398 ENTRY_ACTION_LABELS 突合 / :111 pick-create-kind 等値(段④で「スタック」を足したとき)
- tests/adapter/announce.test.ts:819 KNOWN ── お知らせを 1 件足すごとに 1 行足す(段①・段③)
- tests/operation-table.test.ts:119 sharedBooks(cycle-read-columns だけ)/ :123 perBook { key: 52 … } ── KEY_COMMANDS に 3 件足すと 55、'pin-split' を鍵の表にも置くならまたぐ id が 2 件になる
- tests/action-scope-survey.test.ts:63-70 ── 受け手を 1 つ残らず仕分け + 件数 {P1:40,…} の等値。新受け手(stack-open E / stack-push E / stack-clear E / stack-save E / stack-load P1)を scripts/action-scope-survey.mjs に仕分けしないと落ちる
- tests/action-outlets.test.ts:80 OBJECT_LONE(:101 'pin-split' / :109 'unsplit-entry')── 帯が 2 本目の出口になるので表から消す(消さないと落ちる = 直したことを忘れられない形)。新 action は文字列リテラルで書き UNRESOLVED(:56)を増やさない
- tests/repo-hygiene.test.ts:172「画面に書いた data-pkc-action に受け手が全部いる」── 帯・器・入れ物の帯の新 action に binder の受け手を先に置かないと落ちる(守ってくれる側)
- tests/adapter/bootstrap-wiring.test.ts:461-472 ── main.ts の原文 pin(loadSplitLids → saveSplitLids の順、`let lastSplit = dispatcher.getState().splitLids;`)。state 名を変えないので落ちないが、配線に触るなら道連れ
- tests/features/settings-file.test.ts:73-93「仕分けていない鍵が在る」── 鍵名を変えない限り緑。cid 付きの動的な鍵にすると走査で落ちる(段①で変えない根拠)
- tests/features/flavor.test.ts(registeredArchetypes の全数)── 'stack' を登録したら extract を smart-flavor.ts:37-51 と同型で返す(NO_EXTRACT を返すと落ちる)
- tests/adapter/archetype-label.test.ts:17 ARCHETYPES は手書き 7 件 ── 落ちないが 'stack' を ARCHETYPE_LABELS と test の両方に足す / tests/adapter/icons.test.ts:104 ── ARCHETYPE_ICONS の全 key にチップの色が要る(stack の図案と CSS を同時に足す)
- tests/adapter/smart-folder.test.ts:90「ふつうのフォルダでは頼まない」/ :175「条件が空なら条件を選んでくださいと出す」/ :382「スマートフォルダでないものに列の条件を書かない」── 判定を collectsByReference へ寄せるときの対照群。stack の帯で「条件を選んでください」を出すと :175 の型が stack 側で嘘になる
- tests/features/keymap.test.ts:169(既定の検め)/ :181(id 重複)── Alt+7 / Alt+8 は未使用なので通る前提だが、足したら全数で確かめる。stack-clear の既定を空にするなら :169 が空 defaults を受けるかを先に見る
- tests/smoke/layout.smoke.spec.ts(collection-bar の等値)/ tests/adapter/pane-visibility.test.ts:36(PANES 3 つ)── 落ちない設計。落ちたら帯を設計と違う所に置いている合図

## 7. リスク

- refreshSmartHits(app-state.ts:4641-4643)は spec が空の入れ物の lid を保存のたびに落とす ── stack が smartHits を使うなら `listed` の skip が無いと「載っているノートを保存した瞬間に入れ物から消える」(緑のまま壊れる型)。段③の変異試験の第 1 号にする
- CREATE_ENTRY は既定で編集に入る ── 「保存…」で作った物を開いて本文を退かすと #300 の型。edit:false で作り selectedLid を動かさないことを smoke で見る
- 帯を pane の中に置くと read-columns.ts:259/327 が pane の高さを段の高さに使い、段が溢れる ── 区画 detail の先頭(pane の兄)に置く。実測で確かめる
- 札の押下は幅が足りず枠が 1 つも出ない窓では画面が変わらない(dead click に見える)── 帯の印(data-pkc-shown)が動くことで手応えを出し、「← 左で開く」を置く。#632 のスマホ用画面ではあちらの設計に従う(帯を畳まない)
- 帯は ≤720px の 1 列版面でも 1 行(約 26px)食う ── #588 の縦の潰れを 1 行ぶん悪化させうる。#632 の縦の予算表に「載せているときだけ +1 行」を載せる
- 端末鍵 'pkc3.split-lids' が cid で分かれていない(調査 split #13/#15)── PR #649 で永続が成立した今日から顕在化しうる。自己修復頼み。報告が来たら鍵に cid を含める
- 旧ビルド(v3.2.x)を同じ端末で開くと 3 件に切って書き戻し、4 件目以降が消える(端末の設定)── お知らせに 1 行
- 順序の意味が変わる(末尾追加 → 先頭追加)── PR #649 以降に留めた既存 user の並びは 1 件目が同じ物なので見え方は同じだが、「次に載せた物が隣に来る」は変化。お知らせで言う
- bodyLinkTargets は fence の中の `entry:` も拾う(body-links.ts に fence skip 無し)── 入れ物の本文は機械が書くので実害は小さいが、段④の link-remove は箇条書きのリンク行だけを対象にし fence 内は触らない(対照群を test に置く)
- 新フレーバー追加の裁定範囲(whiteboard doc:42「この 1 件」)── #633 逐語を go と読んでいる。違えば text + frontmatter の印に倒すが、そのときフォルダ タブには出ない(動線 1 つ減)ので段③の入口で 1 行確かめる
- 変異試験の型: 帯の × は畳まれた枠(DOM に無い)に対して撃つ it を置く(#584 の当の経路)/ 「既在なら上げる」は push の test が救わない形(先頭でない物を載せ直す)で見る / sayIfDropped の数え直しは「20 件・幅十分」の対照群が無いと殺せない
- 2 タブで同時に載せ / 降ろしたときの localStorage の勝ち負け(最後に書いた側)は未測(調査 split 未確認事項)── 段①の smoke に別タブで書いた後の順を 1 件足す
- stack-clear の既定の鍵を空にできるかは keymap の検め(keymap.test.ts:169)で先に見る ── 通らなければ Alt+9
- create-entry の組み立ては dualCreate(binder.ts:265-286)と左の列の handler で別々に CREATE_ENTRY を組んでいる ── 「保存…」で 3 か所目を書くと §7 の型。段③では lid / relationId / parentLid の組み立てを helper に寄せてから足す
- 保存した入れ物の本文の `[題名]` は保存時点の字のまま(entry: の lid で飛ぶので壊れない)── 帯の札は entryMetas から引くので改名に追随する。「参照をコピー」と同じ性質としてマニュアルに 1 行

## 8. 根拠(file:line)

- src/features/split-frames.ts:45-51(SPLIT_FRAME_MAX 4 / SPLIT_PINNED_MAX 3 = 器を割る数、READ_COLUMN_CHOICES と揃えた理由)/ :78-94 normalizeSplitLids と「主と同じ lid は捨てない」/ :101-106 pinSplitLid(末尾追加・既在は同じ参照・満杯は足さない)/ :109-111 unpinSplitLid / :116-126 knownSplitLids / :144-160 fittingSplitFrames(SPLIT_FRAME_MAX で頭打ち)/ :162-170 空白区切りの保存形
- src/adapter/ui/render/split-view.ts:19-22(既定は 1 枠、器も印も出さない)/ :198-209 render: show = want.slice(0, fit-1)「減らすのは後ろから」/ :219-229 sayIfDropped(want − shown)/ :274-292 frameHost(「× 外す」は枠の中にだけ)
- src/adapter/platform/split-store.ts:4-7(#505「ノートごとではなく画面の設定」の引用)/ :14 KEY 'pkc3.split-lids'(cid で分けていない)
- src/main.ts:2934-2953(PR #649: loadSplitLids → SPLIT_RESTORED → 復元後の state を起点に saveSplitLids)
- src/adapter/state/app-state.ts:4038-4070 PIN(フォルダ断り・満杯の文言・phase を見ない)/ :4071-4078 UNPIN / :4090-4102 SPLIT_RESTORED(知らない lid を落とさない)/ :4441 削除で unpin / :1869 SELECT_ENTRY は editing で無視 / :3282-3290 CREATE_ENTRY は ready 限定 / :1086-1096 CREATE_ENTRY の形(body / edit / parentLid / relationId)
- src/adapter/state/store-effects.ts:582-650 REQUEST_SMART_SCAN(同じ enqueue の列で getBody → isSmartEmpty 短絡 → worker)/ :835-854 REQUEST_SPLIT_BODY(本文 null で無言 UNPIN)
- src/adapter/state/app-state.ts:87-100 SmartHitState(spec 必須)/ :301-305 smartScanFor(archetype 1 か所)/ :3250-3270 SET_SCOPE / :4607-4660 refreshSmartHits(needsRescan skip → matchesSmartTags で当て直し、空 spec は落とす)
- src/features/flavor/smart-flavor.ts:1-13(手で子を入れられない / 中身が 2 種類になる害)/ :37-51 seed / src/features/smart/smart-spec.ts:25-29(平らな key のみ)/ :140-190 SmartSpec・isSmartEmpty / :490-516 smartWriteError(落とす = 相手の本文にタグを書く)
- src/adapter/platform/storage/storage-worker.ts:1863-1880 findBacklinks(本文の `entry:` を LIKE + bodyLinksTo で引く ── 本文リンク列なら参照元が無料)/ :2186-2197, 2501-2507 削除は残し purge で消す
- src/features/entry-ref/body-links.ts:60-84 bodyLinkTargets(出てきた順・重複畳み・fence skip 無し)/ src/features/entry-ref/entry-ref-format.ts:32 formatEntryLink
- src/core/model/entry-meta.ts:10-14(EntryMeta は archetype を持ち body を持たない)/ src/features/relation/tree.ts:155-163 canEnterScope(archetype 1 か所)/ src/features/relation/filer-list.ts:53-76(smart 分岐 1 か所、smartLids の順を保つ)
- src/features/flavor/index.ts:21-51(registry と text fallback、registeredArchetypes)/ src/features/flavor/archetype-label.ts:18-44(知らない綴りはそのまま)/ src/adapter/ui/render/icons.ts:296-310(未知は dot)/ src/adapter/ui/render/shell.ts:110-124 CREATE_BUTTONS
- src/features/entry-actions.ts:50-60 WHEN 表 / :77-88 entryMenuActions(両面へ hint ごと配る)/ :181-198 BODY_MENU_ACTIONS と行メニューに置かない理由 / :343 ENTRY_ACTION_HINTS / src/adapter/ui/render/context-menu.ts:38,77(main では hint は native title ── C-3 は未着地)
- src/adapter/ui/actions/binder.ts:1789-1803 runGlobalCommand(view-dual: ボタンの無い面は直に投げる)/ :2104 select-entry(data-pkc-entry を読む)/ :4332-4343 pin-split / unsplit-entry / :4917 PKC_DRAG / :6130-6133 smart への drop / :4940 SHORTCUT_BUTTON
- src/features/keymap.ts:323-476(Alt+1〜6 / [ ] \ 使用済、toggle-append の 1 件で鍵とパレット)/ :872-879 typesCharacter / :925-937 REFUSED(Alt+7/8/9/0 は無い)/ src/features/palette/palette-rows.ts:118-133
- src/adapter/ui/render/app-dialog.ts:605-614 pickEntryInApp(rows 関数を受ける、題名だけ直書き)/ src/features/relation/dual-bookmarks.ts:27-33(MAX_BOOKMARKS 20 = 手違いの検出、超えたら断る)
- src/adapter/ui/render/filer.ts:217-240 renderSmartBar(smartHits を読み「条件を選んでください」)/ src/adapter/ui/render/read-columns.ts:259, 287, 327(pane の rect を段の幅・高さに使う)/ src/styles/app.css:5255-5303(split の規則は留めたときだけ当たる)
- src/features/notice/notice-log.ts:37, 49(NOTICE_SHOW_MAX / KEEP_MAX 10)/ src/features/markdown/body-rewrite.ts:40-144(kind の列)
- docs/manual.md:1636-1650(本文の右クリック表)/ :1677-1702(横に並べて読む: 3 件まで・憶えます・× 外す)/ :2159-2166(スマートフォルダは並べ替えできない)/ :3535-3552(§10 鍵の表と Alt+数字の注記)
- docs/development/whiteboard-bucket-design-2026-08.md:38-50(新エントリタイプは「この 1 件」/ 新エントリタイプ = 新フレーバー)/ :56-70(relations 列追加は旧ビルドで黙って欠損)/ docs/development/group-and-task-model-2026-08.md:84-90(グループ = 表紙を持つタグ)
- scratchpad survey-2026-09-02-mobile-stack.md: split #1-36(とくに #2 順序 / #13 cid / #25 畳まれた枠に外す口が無い / #30-31 枠内の右クリック・Ctrl+クリック無言)/ group #13-15(smart は入れる = タグを書く・順序無し)/ #26(板の位置は本文の記法)/ #28-31(本文リンク 1 文法・参照元自動・消えた先の断り)/ #45(relations 列追加は危険)/ #49(結論: 本文リンク列 + PIN_SPLIT_ENTRY)/ 批評「調査どうしの食い違い」末尾(フレーバー追加は都度 user の言葉)/「#633 に効く事実 3 つ」
- tests: tests/features/split-frames.test.ts:20,43,48-57,69-72 / tests/adapter/split-state.test.ts:11,107-118,164 / tests/adapter/split-view.test.ts:57-96,236-261,314-430,470-560 / tests/smoke/split-frames.smoke.spec.ts:78,189,283 / tests/features/entry-actions.test.ts:42,58-80,219,262-270 / tests/adapter/inspector-titles.test.ts:155 / tests/adapter/body-context-menu.test.ts:125 / tests/docs-parity.test.ts:111,117,398,861,935,1212 / tests/adapter/announce.test.ts:819 / tests/operation-table.test.ts:119,123 / tests/action-scope-survey.test.ts:63-70 + scripts/action-scope-survey.mjs:43-50 / tests/action-outlets.test.ts:56,80,101,109 / tests/repo-hygiene.test.ts:172 / tests/adapter/bootstrap-wiring.test.ts:461-472 / tests/features/settings-file.test.ts:73-93 / tests/features/flavor.test.ts:6 / tests/adapter/archetype-label.test.ts:17 / tests/adapter/icons.test.ts:104 / tests/adapter/smart-folder.test.ts:90,175,382 / tests/features/keymap.test.ts:169,181 / tests/adapter/pane-visibility.test.ts:36
- GitHub #633 本文(裁定 A3 逐語・設計で答える 5 問)/ #633 コメント 2026-09-02(PR #649 着地)/ #584 コメント 2026-08-30(unsplit は P1 でパレットに置けない)/ #505 本文(任意分割・憶えるのは画面の設定)/ #632 本文(狭い窓は別設計)── 本文はタスク指示の逐語から。⚠ この箱では GitHub API を引いていない
- CLAUDE.md: 面は映すだけにしない・片道を作らない(2026-08-23)/ 判定は 1 か所へ(§7)/ 不変条件 5 旧ビルドの読み方 / 推薦を出したら決めるところまでやる(2026-08-19)/ 見え方を変える判断は user のもの(2026-08-28)/ 設問は画面で何が起きるかで書く(2026-08-21)

## 9. 関連

- Issue **#633**(本体)/ #584(片道 ── 段①で閉じる)/ #505 / #283 / #550 / #632 / #604
- 調査: `docs/development/survey-2026-09-02-mobile-stack.md`(`split` / `group` の 2 本 + 批評)
- 同型の既存機構: `dual-bookmarks.ts`(参照だけ・順序つき・帯 + × ・上限 20)
