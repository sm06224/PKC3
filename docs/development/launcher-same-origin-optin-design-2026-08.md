# ランチャー: 「同じオリジンで動かす」隠しオプトイン ── 設計(2026-08-03)

> user 指示 2026-08-03(原文)
> **「元々、同じオリジンで動かす動線はオプトインでした / ほしい時は欲しいから、
> 隠しオプトイン、警告ありの導線を作れませんか？ / どうしてもダメなら、諦める」**

**結論から: 作れます。諦める必要はありません。** ただし裁定を仰ぎたい点が 3 つあり、
とくに ①「いま何が動かなくて困っているか」で設計が大きく変わります。

この doc は **裁定のための材料**です。実装は裁定の後(doc-first)。

---

## 0. 先に訂正 ── PKC2 の「オプトイン」は**この導線のことではなかった**

user の記憶にある 3 択の同意ダイアログは実在します。文言も実物のまま残っています:

```
🔓 全権アクセスの確認
「<拡張タイトル>」は trusted(同一オリジン)実行を要求しています。
許可すると、このアプリは PKC2 のコンテナ全体(全エントリ・アセット・保存データ)へ
直接アクセスできます。配布元を信頼できる場合のみ許可してください。
```
選択肢は上から「🔒 サンドボックスで開く(推奨)」/「🔓 全権で開く」/「キャンセル」
(`PKC2/src/adapter/ui/extension-host-runtime.ts:248-273`)。

⚠ **ただしこれが出るのは `pkc_extension` の印が付いた添付だけ**です。
**`registered_as_app` だけの添付をランチャーのタイルから開く経路には、同意も
sandbox も入っていませんでした** ── `window.open` した popup へ
`win.document.write(添付の HTML)` を直書きしており、**無警告の全権**です
(`PKC2/src/adapter/ui/action-binder.ts:3334-3342`, `10871-10880`)。

つまり **PKC2 のランチャーのタイルは「オプトインの全権」ではなく「既定で全権」**
でした。PKC3 が今回塞いだのはまさにその経路です。
「元に戻す」ではなく「**PKC2 の拡張ホストが持っていた同意の作法を、
ランチャーのタイルに初めて適用する**」という位置づけになります。

なお PKC2 の同意は **一切保存されません**。in-memory の Set で、コード自身が
「永続 grant は v2.2 予約のため**毎起動確認**(最も安全)とする」と書いています
(`extension-host-runtime.ts:296-299`)。取り消し導線が無いのは、
**取り消す対象を作らなかった**からです。

---

## 1. 実測 ── オプトインは**何を買うのか**

対照群を揃えて計測しました(`allow-same-origin` **以外は全部同じ**。sandbox 属性は
出荷中の `LAUNCHER_APP_SANDBOX`、iframe は出荷と同じ `srcdoc`、親はアプリと同一 origin、
アプリを一度 boot して OPFS `.pkc3` が実在する状態)。

### 落ちるもの(= オプトインが買うもの)

| 能力 | 隔離(既定) | 全権 |
|---|---|---|
| cookie / localStorage / sessionStorage | `SecurityError: …lacks the 'allow-same-origin' flag` | OK |
| IndexedDB(`open` / `databases()` 列挙) | `SecurityError` | OK(`pkc3-assets` が見える) |
| OPFS `navigator.storage.getDirectory()` | `SecurityError` | OK(`root = .pkc3`) |
| Cache Storage | `SecurityError` | OK(`pkc3:%2F:7b5129b92dac` が見える) |
| Web Locks / SharedWorker / ServiceWorker | `SecurityError` | OK |
| fetch(同一 origin の相対 URL) | `TypeError: Failed to fetch` | OK `status=200` |
| 親の DOM / localStorage / OPFS | `SecurityError: Blocked a frame with origin "null"` | OK |

### 落ちないもの(= オプトインでは買えない ── **既に動く**)

`new Worker(blob:)` / `WebAssembly` / `crypto.subtle` / `crypto.randomUUID` /
`parent.postMessage` / `<a download>`(実際に発火)/ `window.open` / `print()` /
`history.pushState` / `location.hash` / `BroadcastChannel` の生成 ── **全部 OK**。

🔑 **オプトインが買うものは 1 種類しかありません ── 「この origin の保管庫に
手が届くこと」**。エラー文言が機械的に 2 系統(`lacks the 'allow-same-origin' flag`
= 自 origin の資源 / `Blocked a frame with origin "null"` = 親 origin の資源)しか
出ないことが、それを裏付けています。**「アプリとして成り立つか」に
`allow-same-origin` は要りません。**

### ⚠ ついでに見つかった、origin を渡さずに直せる穴

`clipboard.writeText` が効かないのは sandbox ではなく **Permissions Policy** でした。
iframe に `allow="clipboard-write"` を足すと**隔離側でも OK** になります。
出荷中の外殻は `allow` 属性を持たないので(`src/features/launcher/app-shell.ts:90`)、
取り込んだアプリの「コピー」ボタンは origin と無関係に死んでいます。
**これは別 PR で直します**(混ぜると scope drift)。

### 🔴 `allow-same-origin` は「一段緩める」ではない

全権側では、中の script が `frameElement` を取って**自分の sandbox 属性を書き換え
られました**(`allow-top-navigation` の追加に成功)。Chrome 自身も
`An iframe which has both allow-scripts and allow-same-origin for its sandbox
attribute can escape its sandboxing.` と警告を出します。
**だから文言は「全権」で統一します ── 「少しだけ許す」とは書けません。**

### ⚠ 観測点の注意(前回踏んだので明記)

`location.origin` は**両方向に嘘をつきます**。`about:srcdoc` の iframe は
隔離の有無に関わらず `"null"`、sandbox 継承 popup は逆に本物の origin
(`http://localhost:45732`)を返しながら localStorage は `SecurityError`。
**判定に使ってはいけません。** 使うのは `self.origin` と親 DOM 到達可否です。

---

## 2. 推奨する形 ── **保存しない全権起動**

| 論点 | 決定 | 理由 |
|---|---|---|
| 既定 | **1 文字も変えない**。タイルのクリックは永久に隔離側、確認も出ない | 何もしなければ安全側 |
| 入口 | 添付の本文に **`attachment.same_origin: ask`** を手書き | 配管ゼロ(`tiles.ts:76` が既に frontmatter を読む)。添付も普通に編集できる。**本文なので履歴に残る** |
| 起動 | **詳細画面の専用ボタン**。タイルからは到達できない | 「毎日押している場所」と「危険な場所」を物理的に分ける |
| 対象 | `isContentKey(assetKey)` が真のものだけ | 64MB 超と PKC2 由来の旧 key を機械的に落とす(差し替えを検出できないから) |
| 束縛 | **起動直前に自分で計算した SHA-256** と asset key の照合 | bytes はどのみち読むので追加 I/O ゼロ。**判定と実行が同じ 1 読取に乗る**ので TOCTOU が構造的に起きない |
| 同意 | `confirm` 1 枚、**fail closed**(`?? false`) | 既存の重い操作(ゴミ箱を空にする / 添付整理)と同じ倒し方 |
| 保存 | **しない**。grant も期限も一覧も作らない | 下記 §3 |
| 取消 | ① 窓を閉じる ② **frontmatter の 1 行を消す** | 書いた場所で消せる。新 UI ゼロ |

**畳む条件**: 4 か所(`tiles.ts` の 1 行 / `ACTIONS` の 1 行 /
`buildLauncherAppShell` の第 3 引数 / `launchTileSameOrigin`)を消せば完全に元へ戻る。
データに残るのは frontmatter の死んだ 1 行だけ(未知キーは無視される)。

### 警告文(案。実際に画面に出る文)

```
🔓 全権で開きます ──「<題名>」

このアプリは PKC3 と同じ資格で動きます。許可すると、このアプリは

  ・すべてのノートの中身(OPFS の SQLite 本体)
  ・すべての添付ファイル(IndexedDB)
  ・アプリ本体のキャッシュ(次に開いたときの PKC3 そのもの)

を読み書きできます。読むだけでなく、消すことも、書き換えることもできます。
一度許すと、この窓を閉じるまで止められません。

自分で作ったもの・出どころが確実なものだけ許可してください。
```

---

## 3. 🔴 永続 grant を**作らない**理由(ここが設計の核心)

「毎回聞かれずに使いたい」なら永続 grant がほしくなります。**しかし置き場が
同一オリジンにしかありません** ── sqlite も IndexedDB も localStorage も、
**許可された側が書けます**。つまり:

> 一度でも許可すると、そのアプリは**自分の許可記録を自分で書ける**。

精緻な取り消し UI を作ると、**実際より安全だと思わせる分だけ有害**です。
PKC2 が「毎起動確認(最も安全)」と書いて永続 grant を v2.2 送りにしたのは、
おそらく同じ結論に達したためです。

⚠ 加えて、`settings` 表は DDL に在るだけで op が **0 件**です。ここを通すと
P7b の残り全部より大きい実装になります。

---

## 4. 束縛先の検討(なぜ hash か)

| 束縛先 | 判定 | 根拠 |
|---|---|---|
| entry の **lid** | ✗ | lid → frontmatter → asset_key → bytes の**二段の可変な間接**。本文編集(`detail.ts:117-142` で attachment も編集できる)/ 履歴復元 / ゴミ箱復元で、lid そのままで中身が入れ替わる。lid は `Date.now().toString(36)` + セッション内カウンタで、暗号的に一意ですらない |
| **asset key** 単体 | △ | content-addressed(`ast-<sha256hex>`)だが、**書き手の規律**であって読み手は一度も検証しない。64MB 超は乱数採番、PKC2 旧 key も有効なまま |
| **起動直前に自分で計算した SHA-256** | ○ | 期待値(key)と実測(bytes の hash)を突き合わせる。IDB `pkc3-assets` を書き換えられた場合に**その場で検出**できる |

⚠ ただし hash 照合が捕まえるのは「IDB の bytes が key と食い違う」だけです。
**本文編集で `asset_key` の行き先ごと差し替える経路は検出できません**。
これは「隠しオプトイン + 毎回確認」であることで代替します(毎回、題名を見て押す)。

### ⚠ 出荷中のコードで見つかった、関連する取りこぼし

アーカイブの書出しは manifest に asset の `hash` を書いているのに、**復元側が
それを捨てています**(`pkc3-archive.ts:262-270` で書き、`:571-576` で落とす)。
取込は ZIP の bytes から key を計算し直すので、**ZIP 内の bytes を差し替えても
「key と bytes は一致」で無警告に通ります**。CLAUDE.md の
「壊れを検出する材料を捨てない」に照らして**別 issue**です(この設計とは独立)。

---

## 5. 実装の段取り(裁定後。各段が単独で着地)

| 段 | 中身 | 単独で着地 |
|---|---|---|
| **0** | ✅ 済 ── `launcher-app-shell.test.ts` の空振り修理。`sandbox="…"` の `toContain` は**前方一致**なので、組み立て側で ` allow-same-origin` を足しても緑だった。**生成物**に禁止語を当てる形にし、変異で確認 | 機能変更ゼロ |
| **1** | `buildLauncherAppShell(title, html, opts?)` + `🔓 ` 前置 + 警告文の定数を**同じ file に**置く(危険を作る定数と危険の宣言を同居させる)。呼び出し側はまだ無い | 既定は不変 |
| **2** | `launchTileSameOrigin` を**別関数**として追加(既定経路の変異試験が新経路に救われるのを防ぐ)。順序 = confirm(同期・`window.open` より前)→ 空窓 → `readBlob` → `text()` **1 回** → sha256 → key と照合 → **同じ text** を器へ | UI から到達不能 |
| **3** | `tiles.ts` に `same_origin: 'ask'`(**`'ask'` 以外は無視** ── 未知値を将来の強い権限として解釈しない)。詳細画面にボタン 1 個。`main.ts` で `sha256Hex` と `confirm` を注入 | ここで初めて到達可能 |
| **4**(別 PR) | nightly smoke(対照群: 隔離側 = blocked / 全権側 = OPEN)+ `allow="clipboard-write"` の修理 | PR gate に載せない |

各段の**変異試験**は必須:段1「`opts` を無視して常に付ける」/ 段2「confirm を消す」
「`?? false` を `?? true`」「hash 照合を消す」「`text()` を 2 回読む」/
段3「`'ask'` 判定を緩める」「`isContentKey` を常に true」── 全部落ちること。
⚠ 「窓が開いたか」ではなく「**照合が起きるか**」「**器に何が入ったか**」を直接見る。

---

## 6. 🔴 なお残る危険(「安全になりました」とは書けない)

- **柵ごと外れる**。全権側は自分の sandbox 属性を書き換えられる(実測)
- **再読込をまたいでアプリ本体が入れ替わりうる**。SW は hash 付き生成物を
  **cache-first で返し network に問い合わせない**(`sw-source.ts:272-275`)。
  掃除は build 交代時の activate のみで、install で `skipWaiting` しないので、
  user が「更新」を押すまで居座る。⚠ **汚染そのものは未実測(推測)** ──
  実測済みなのは Cache Storage が開くことまで。**着地前に 1 度実測する**
- **開いた後は止められない**。窓を閉じるまで遮断手段が無く、閉じても書かれたものは残る
- **ノートの読み出しは確実**。改竄は通常の編集と見分けがつかない。
  `pkc3-writer` lock を握られると本体タブが実質 read-only になる
- **`confirm` 1 枚では 3 秒待機もチェックボックスも置けない**(`<dialog>` は
  PKC3 にまだ 1 つも無い)。警告を読まずに押す人は守れない
- **`🔓` の印は弱い**。同一オリジンなので中の script が `document.title` を書き換えられる
- **警告文が storage 構成に依存する**。storage を動かす PR で文言が嘘になるが、
  機械的に検出する術が無い

---

## 7. user に裁定をお願いしたい 3 点

### ① 🔴 そもそも入れるか ── **いま何が動かなくて困っているか**

実測(§1、対照群つき)では、隔離側でも Worker / WebAssembly / crypto /
`<a download>` / `window.open` / `print` / `postMessage` は **1 つも欠けていません**。
落ちるのは **「この origin の保管庫」1 種類だけ**です。

困りごとが「**アプリが状態を保存できない**」1 点なら、origin を渡さずに済む道が
あります(PKC3 が名前空間を切った保存領域を postMessage で貸す)。
**具体的に何が動かなかったかを教えてください** ── それで設計が変わります。

### ② 🔴 「1 回きり」で足りるか

「ほしい時は欲しい」が「**毎回聞かれずに使い続けたい**」の意味なら、この案は
使われません。ただし §3 のとおり、永続 grant は **許可された側が自分の許可記録を
書ける**ので、安全には作れません。**その場合は「できません」と正直に返す分岐**です。

### ③ 入口を frontmatter にしてよいか

他人のバックアップに `same_origin: ask` が混ざって届きえます
(**権限は付きません・ボタンが 1 個出るだけ**ですが、社会工学の足がかりにはなります)。
代案は「隠さず詳細画面に常設」か「入口を作らない」。

⚠ **URL パラメータは採りません** ── URL は共有され、ブックマークされ、
他人に踏ませられます。「隠し」の入口として最悪の性質です。
