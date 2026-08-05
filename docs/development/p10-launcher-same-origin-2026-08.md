# ランチャー ── 素のまま起動する(2026-08-05)

> user 指示 2026-08-05:
> 「**ランチャーが貧相。同一ドメインで動かしたい HTML アセットが javascript が
> 動かなくて死ぬ**」/「**HTML アセットの詳細画面から起動できない**」

## 1. まず診断 ── JavaScript は動いている

実測(実 Chromium で出荷経路をそのまま再現)で分かったこと:

- `allow-scripts` は**付いている**。inline script / inline module / blob Worker /
  WASM / `crypto.subtle` は**すべて動く**
- CSP はランチャー経路に**存在しない**
- 死因は **不透明オリジン**(`self.origin === "null"`)である

sandbox に `allow-same-origin` が無いので origin が `null` になり、次が
**1 行目で同期に throw** する:

| 呼び出し | 結果 |
|---|---|
| `indexedDB.open(...)` | `SecurityError: access to the Indexed Database API is denied` |
| `document.cookie`(読み書き) | `SecurityError` |
| `window.caches` / `navigator.serviceWorker` | `SecurityError`(**プロパティを読むだけ**で) |
| `navigator.storage.getDirectory()` | `SecurityError` |
| `new SharedWorker(...)` / `new Worker('w.js')` | `SecurityError` |
| `history.pushState(..., '/route/42')` | `SecurityError` |
| `fetch` / XHR / 動的 `import`(相対 URL) | CORS で失敗(`origin "null"`) |

つまり **`try/catch` を書いていない普通のアプリは 1 行目で止まり、真っ白になる**。
user の「javascript が動かなくて死ぬ」は正確な報告だった ── 動いてはいるが、
最初に触る API が例外を投げるので**動いていないのと同じ**である。

⚠ ここは test が「現状を正しい姿として pin」していた
(`launcher.smoke.spec.ts` が `idb: 'blocked'` を green で assert)。
壊れているものを守っていたので、その pin も書き換える。

## 2. 決めたこと

**起動の仕方を 2 つにする。既定は今のまま、素のままは別の導線にする。**

| | 囲いの中(既定) | 素のまま(同一オリジン) |
|---|---|---|
| sandbox | `allow-same-origin` **無し** | **有り** |
| origin | `null` | PKC3 と同じ |
| IndexedDB / cookie / caches | 死ぬ | 動く |
| 保存 | 貸した localStorage(名前空間つき) | **本物の localStorage**(名前空間なし) |
| PKC3 の中身 | 届かない | **届く**(下記) |
| 導線 | ランチャーのタイル / 詳細の「起動」 | 詳細の「**素のまま起動**」のみ |
| 確認 | 無し | **1 回目に確認**(セッション中は覚える) |

### なぜタイルからは素のままにしないか

タイルは**一覧から 1 クリックで押せる**場所である。素のままは「このアプリに
PKC3 の中身を触らせる」判断なので、**対象の素性が見えている画面**(詳細)から
だけ入れる。マニュアルにも同じ理由で書く。

### なぜ許可を保存しないか

🔴 **許可の記録を置ける場所が、許可される対象そのものだから**である。
素のままで動くアプリは localStorage / IndexedDB / OPFS に手が届くので、
**自分の許可記録を自分で書ける**。だから:

- **保存しない**(次のセッションでは必ずもう一度聞く)
- ただし**セッション中は覚える**(主スレッドの JS の変数)── アプリからは
  参照が無い(`opener` は切ってあり、`parent` は外殻で止まる)ので**書き換えられない**
- ⚠ 前の設計 doc は「毎回聞く」だったが、それでは使い物にならない。
  「セッション中は覚える / 保存はしない」は**偽造できない範囲での妥協**である

### 残る危険(measured / unmeasured を分けて書く)

- 🔴 **PKC3 の保存領域に届く**(measured。前 doc §1 の対照実測):
  `localStorage` 全体(`pkc3.theme` も上書きできる)/ IndexedDB の
  `pkc3-assets`(添付の bytes)/ OPFS の sqlite ファイル
- 🔴 **`pkc3-writer` の lease を取れる** → 本体のタブが読み取り専用に落ちる(measured)
- ⚠ **frame は自分の `sandbox` 属性を書き換えられる**(unmeasured。ただし
  同一オリジンで既に全権なので、この段では意味が変わらない)
- ⚠ **service worker のキャッシュ汚染が再読込を越えて残りうる**(unmeasured。
  前 doc §6 の指摘をそのまま引き継ぐ)
- ⚠ **貸した保管庫が使われない** ── 素のままでは本物の localStorage を使うので、
  囲いの中で貯めた内容(`pkc3.app.<lid>.*`)は**見えない**。
  行き来すると別の保存先になる(マニュアルに書く)

## 3. 詳細画面からの起動(user 指示 ⑤)

添付の詳細に**起動の導線が 1 つも無かった**(あるのは ダウンロード / 参照をコピー /
アプリとして登録 のみ)。HTML の添付は preview も出ない(`text/html` は
「preview 無し」に落ちる)ので、**詳細画面から中身に触る方法が無かった**。

- **「起動」** … 囲いの中で開く。⚠ **「アプリとして登録」は要らない** ──
  登録はランチャーに並べるための設定で、開けることとは別である
- **「素のまま起動」** … 上記の確認つき

⚠ どちらも `isAppMime`(`text/html` / `application/xhtml+xml` / mime 無し)の
添付にだけ出す。SVG / PDF / XML は対象外(前からの判断を継ぐ)。

## 4. 実装の要点

- `app-shell.ts` に `sameOrigin` を足す。sandbox の token 表を **2 つ**持ち、
  どちらを使ったかを外殻の `data-pkc-field="launcher-mode"` に出す(観測できる形)
- 素のままでは**保管庫の shim を入れない**(本物が生きているので差し替え不要。
  shim 自身も「本物が生きていれば何もしない」と書いてある)
- `launchTile(tile, deps, opts)` に `sameOrigin` を通す。確認は **deps 側**
  (`confirmSameOrigin`)── 純関数のまま test できる
- 詳細の導線は `launch-asset` / `launch-asset-raw` の 2 action。
  ⚠ 起動には tile 相当の情報(lid / title / assetKey)が要るが、**登録の有無に
  依存しない**ので詳細側で組む

## 5. test で pin すること

- 既定の sandbox に `allow-same-origin` が**無い**(退行の逆向きを止める)
- 素のままの sandbox に**有る**
- 素のままでは shim を**入れない** / 囲いの中では**入れる**
- 確認が `false` を返したら**開かない**(fail closed)
- セッション中の 2 回目は**聞かない**、が **保存はしない**
  (別のセッション相当の呼び出しでは聞く)
- 詳細画面に 2 つの導線が出る / `isAppMime` 以外には出ない
- ⚠ `launcher.smoke.spec.ts` の `idb: 'blocked'` は**囲いの中の期待値**として残す
  (素のままの経路は別に見る)
