# ランチャー: アプリに保存領域を貸す(隔離したまま)── 設計(2026-08-03)

> user 回答 2026-08-03(原文)
> **「アプリが状態を保存できない」1 点です / 毎回聞かれずに使い続けたいです /
> バックアップ復元時にオプトインパラメータをそのまま取り込むかどうかを警告有りで
> 聞くべきでは？」**

前の doc(`launcher-same-origin-optin-design-2026-08.md`)は「同一オリジンの
隠しオプトイン」を検討したものだが、**user の回答で結論が変わった**。この doc が
そちらを置き換える(前の doc は判断の経緯として残す)。

---

## 0. なぜ設計が変わったか

user の 2 つの要求は、**同一オリジンでは両立しない**:

| 要求 | 同一オリジン | 保存領域を貸す |
|---|---|---|
| ① アプリが状態を保存できる | ○ | ○ |
| ② 毎回聞かれずに使い続けたい | **✗ 安全に作れない** | ○ |

②が同一オリジンで作れない理由は 1 行で言える ──
**許可の置き場が同じ origin にしかなく、許可されたアプリが自分の許可記録を
書き換えられる**から。PKC2 も同じ結論に達しており、コード自身が
「永続 grant は v2.2 予約のため**毎起動確認**(最も安全)とする」と書いている
(`PKC2/src/adapter/ui/extension-host-runtime.ts:296-299`)。

そして①だけなら、**実測上 `allow-same-origin` は要らない**。opaque origin で
落ちるのは「この origin の保管庫」だけで、計算・描画・ダウンロード・印刷・popup は
1 つも欠けていない(前 doc §1)。

🔑 **したがって: 隔離したまま、PKC3 がアプリ専用の保存領域を貸す。**
アプリは origin を持たないので、許可記録にも他のアプリのデータにもノート本体にも
手が届かない ── だから**恒久的に許してよい(= 二度と聞かない)**。

---

## 1. 実測 ── 成立する。ただし素朴に作るとデータが消える

Playwright + 同梱 Chromium で、外殻(blob:・アプリ origin)が IDB から seed を読み、
srcdoc に prelude を焼き込んでから iframe を生成する形で計測した。

### 1-1. ✅ 同期の `localStorage` は差し替えられる

```
{"seedSeen":"[]","before":null,"after":"v",
 "shim":{"ownDesc":"{\"enumerable\":true,\"configurable\":true}",
         "nativeAccess":"SecurityError: …lacks the 'allow-same-origin' flag.",
         "bareResolves":true,"globalThisResolves":true}}
→ 開き直し: {"syncRead":"v","syncReadJa":"こんにちは","length":2,"readAtLine1":true}
```

`localStorage` は opaque frame でも **window の own accessor(`configurable: true`)**
なので `Object.defineProperty(window, 'localStorage', { value: shim })` が通る。
裸の `localStorage` も `globalThis.localStorage` も shim を指し、**`await` 抜きの
1 行目で読める**。→ **アプリを書き換えずに動く**。

### 1-2. 🔴 素のオブジェクトでは使い物にならない ── Proxy が必須

本物 / Proxy 版 / 素のオブジェクト版を同じ battery で叩いた差分:

| | 本物 | Proxy | 素のオブジェクト |
|---|---|---|---|
| `ls.a`(ドット読み) | `"1"` | `"1"` | **`undefined`** |
| `ls.foo = 1` → `getItem('foo')` | `"1"` | `"1"` | **`null`** |
| `Object.keys` | `a,foo,b` | `a,b,foo` | **`getItem,setItem,…`** |
| `JSON.stringify` | `{"a":"1",…}` | 一致 | **`{"foo":1}`** |
| `'a' in ls` / `ls[1]` / `delete ls.a` | ○ | ○ | **全滅** |
| `[object Storage]` / `instanceof Storage` | ○ | ✗ | ✗ |

素のオブジェクト版は **15 項目中 15 不一致**。Proxy(`ownKeys` +
`getOwnPropertyDescriptor` の両方)が必須。`[object Storage]` と `instanceof` は
`Object.setPrototypeOf(target, Storage.prototype)` で直る(⚠ prototype の getter を
素通しさせると `TypeError: Illegal invocation` になるので、get trap で全部 shadow する)。

残る差は **列挙順**と、`for...in` に本物は prototype の `length`/`getItem` まで混ざる点だけ。

### 1-3. 🔴 **「閉じる直前にまとめて書く」は成立しない**(ここが設計の核心)

```
20 件書いた直後にタブを閉じた:
  debounce 250ms → 永続 **0 / 20**
  debounce 0     → 永続 **8 / 20**   ← write-through でも落ちる
pagehide flush の効果(close は runBeforeUnload: true で測り直し):
  none / pagehide / pagehide+syncLS  → **全部 0 / 20**
```

`beforeunload` は sandbox でも発火する(実測)。**それでも救えない** ── 子が
pagehide で postMessage しても、受け手の外殻も同時に落ちるので task が捌かれない。

損失窓を切り分けると:

```
debounce 0 固定、最後の書込から N ms 後に閉じる:
  waitMs=0   → IDB 6/20  ・ 同期 localStorage **20/20**
  waitMs=30  → IDB 20/20 ・ 同期 localStorage 20/20
```

→ **postMessage の配送は落ちていない**。落ちるのは **IDB commit の非同期部分だけ**
(損失窓 < 30ms)。そして**外殻が受信ハンドラの中で同期に書けば、損失窓は消える**。

🔑 **だから永続先は IndexedDB ではなく、外殻が使える「本物の `localStorage`」にする。**
外殻は blob: = アプリ origin なので本物の localStorage が使える。
同期に書けるので**タブを閉じた瞬間でも取りこぼさない**。

### 1-4. 🔴 全量スナップショットを送る設計は O(N²)

```
80 回の setItem(合計 5MB): 総時間 980ms
  最初の 5 回 0.1〜0.6ms → 最後の 5 回 26〜40ms(データが育つほど遅くなる)
  累計 clone バイト数: 212,336,640(= 5MB の 40 倍)
対照: 本物の localStorage で同じ ~5MB → 29ms
```

→ **差分(op/key/value)だけを送る**。全量スナップショットは送らない。

### 1-5. 🔴 2 タブ同時起動で**データが消える**

```
A で fromA=1、B で fromB=2 → 永続後: {"fromB":"2"}   ← fromA が消える
```

各タブが開いた時点の seed を持った独立のメモリ像を持ち、書込のたびに全量を送るため、
**片方の書込が丸ごと上書きされる**。user から見ると「片方のタブの作業が消えた」= データ消失。
→ **差分プロトコルにすれば解消する**(キー単位で当たるので、別キーは共存する)。

### 1-6. 🔴 なりすまし ── `event.origin` は使えない

外殻の `message` ハンドラに 3 方向から攻撃を打った(① アプリが `allow-popups` で
開いた popup から `opener.parent` 経由 ② 外殻に生えた別の sandboxed iframe から
③ 外殻自身の `window.postMessage`):

```
{"origin":"null",                  "okSource":true,  "reason":"setItem", "keys":"legit"}
{"origin":"http://localhost:45732","okSource":false, "reason":"attack3", "keys":"PWNED3"}
{"origin":"null",                  "okSource":false, "reason":"attack2", "keys":"PWNED"}
{"origin":"null",                  "okSource":false, "reason":"attack1", "keys":"PWNED1"}
→ accepted: 1 / snapshot: {"legit":"1"}
```

- **3 通とも外殻まで届く**。攻撃 1(popup → `opener.parent`)は実在する経路
- **`event.origin` は判定に使えない** ── 正規も攻撃 1・2 も一律 `"null"`、
  逆に攻撃 3(外殻自身)は**アプリ origin を名乗る**。
  「アプリ origin なら信用」は**自己なりすましを通す**
- **効くのは `event.source === iframe.contentWindow` の同一性判定だけ**(3 通とも弾けた)

### 1-7. 容量 ── ノート本体と同じ財布を食う

```
5,242,880 バイト書込 → usage 2,903,212 → 8,155,474(+5,252,262、全部 indexedDB)
quota 957,353,097(≒957MB)なので今回の増分は 0.55%
対照: 本物の localStorage は 5,177,344 バイトで QuotaExceededError
```

→ **shim には 5MB の壁が無い**(実測 err: null)。「QuotaExceededError を捕まえて
古いデータを捨てる」型のアプリは**エラーが来ないので永久に捨てず**、静かに食い続ける。
→ **shim 側で上限を持ち、`QuotaExceededError` を同期で投げる**。

### 1-8. shim で覆える範囲の**境界**

| | opaque での実測 | shim で覆えるか |
|---|---|---|
| `localStorage` | `SecurityError` | ✅ 覆える |
| `sessionStorage` | `SecurityError` | ✅ 覆える(タブ単位なので**メモリだけ** ── 往復不要) |
| `indexedDB.open()` | `SecurityError`(**同期 throw**) | ❌ **救えない** |
| `caches` / `cookie` / OPFS / Web Locks / SharedWorker | `SecurityError` | ❌ 覆わない |
| `navigator.storage.estimate()` | `TypeError` | ❌(アプリは自分の使用量を測れない) |

**IndexedDB を使うアプリはこの手では救えない。** localStorage は「値が文字列・
キーが有限・同期」だから偽装できたのであって、IDB は非同期 + カーソル +
トランザクション + 構造化クローン + version change なので同じ手口が成立しない。

### 1-9. その他、実装時に踏む罠(全部実測で踏んだ)

- 🔴 **`</script>` を含む文字列を `JSON.stringify` でインライン script に埋めると
  その場で script が閉じる**(`JSON.stringify` は `<` を escape しない)。
  外殻に埋めたアプリ HTML の `</script>` が外殻自身の script を切り、
  全 test が「外殻が初期化されない」で 10 秒 timeout した。
  **必ず `.replace(/</g, '\\u003c')` を通す**
- 🔴 **shim を文書の先頭に素朴に前置すると quirks mode に落ちる**
  (実測: `preludeBeforeDoctype` → `BackCompat` / `preludeAfterDoctype` → `CSS1Compat`)。
  **`<!doctype …>` の直後に挿す**
- ⚠ **アプリが自分で作った入れ子 iframe / popup には shim が継がれない**
  (中は素の opaque origin で `SecurityError`)。「アプリを書き換えずに」の範囲では塞げない
- ⚠ **5MB のデータを持つアプリは起動のたびに 5,681,773 文字の srcdoc を組む**
  (外殻の組立 33.8ms、`window.open` からアプリ 1 行目まで 167ms)。
  同期に見せるには全量を焼き込むしかないので、**データ量に比例して起動が重くなる**

---

## 2. 設計

### 2-1. 形

```
┌─ 新しいタブ ─────────────────────────────────┐
│ 外殻(blob:・アプリ origin・**自前の HTML**)          │
│   ・起動前に localStorage から seed を読む            │
│   ・srcdoc の <!doctype> 直後に prelude を焼き込む     │
│   ・message を受ける: source 同一性のみで判定          │
│   ・受信ハンドラの中で**同期に**永続する               │
│  ┌─ iframe sandbox(allow-same-origin **なし**)──┐ │
│  │ prelude: localStorage / sessionStorage を差替 │ │
│  │ 取り込んだアプリ(無改変)                      │ │
│  └───────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

### 2-2. 決定

| 論点 | 決定 | 根拠 |
|---|---|---|
| オプトイン | **要らない。既定で貸す・一度も聞かない** | アプリは origin を持たないまま。貸すのは**そのアプリ専用の名前空間**だけで、ノートにも他アプリにも届かない(§1-8) |
| 永続先 | **本物の `localStorage`**(外殻が同期に書く) | IDB は非同期で**閉じた瞬間に落ちる**(§1-3、20 件中 8 件しか残らない) |
| 名前空間 | `pkc3.app.<appId>.<key>`。`appId` は **entry の lid** | データは「このアプリ」に付く。⚠ 添付を差し替えると引き継がれる(§4) |
| プロトコル | **差分**(`set` / `remove` / `clear` の 1 件ずつ) | 全量送信は O(N²)(§1-4)、かつ 2 タブでデータが消える(§1-5) |
| 判定 | `event.source === iframe.contentWindow` **のみ** | `event.origin` は両方向に嘘をつく(§1-6) |
| 上限 | shim 側で **1 アプリ 2MB**、超えたら同期に `QuotaExceededError` | 本物の意味論に寄せる(§1-7)。ノート本体の財布を守る |
| 覆う API | `localStorage`(往復)/ `sessionStorage`(メモリのみ) | IDB は救えないと**正直に言う**(§1-8) |
| shim の作り | **Proxy** + `Object.setPrototypeOf(target, Storage.prototype)` | 素のオブジェクトは 15/15 不一致(§1-2) |

### 2-3. やらないこと

- **IndexedDB の偽装** ── 成立しない。アプリ側の書き換えが要る
- **`storage` イベント** ── 2 タブ間の同期通知。差分プロトコルにすれば
  データは消えないので、まずは無しで着地させる
- **アプリデータのアーカイブ同梱** ── §3 の裁定次第
- **同一オリジンのオプトイン** ── ①が保存だけなら不要。必要になったら
  前の doc の「保存しない・毎回確認」の形で別途

---

## 3. 復元・取込での扱い(user 提案の反映)

> **「バックアップ復元時にオプトインパラメータをそのまま取り込むかどうかを
> 警告有りで聞くべきでは？」**

**正しい指摘で、前の doc の穴だった**(危険として挙げておきながら対処を書いていなかった)。
この設計ではオプトイン自体が無くなるので、対象は次の 2 つに変わる:

1. **アプリの保存データを書出しに含めるか / 復元で取り込むか**
2. **将来オプトインを足したときの、その印の扱い**

方針は同じで **「既定は取り込まない + 件数と題名をまとめて 1 回聞く」**。
復元のたびにダイアログが並ぶと実質「全部 OK」を押させることになるので、**まとめて 1 回**。

※ この節は調査中(取込経路の実装確認待ち)。確定したらここを埋める。

---

## 4. 🔴 なお正直に言うべきこと

- **データは lid に付く**。添付を差し替えても保存データは引き継がれる ──
  「前のアプリのデータを次のアプリが読む」経路が残る。ただし読めるのは
  **そのタイルの領域だけ**で、ノートにも他アプリにも届かない
- **2 タブで `storage` イベントは飛ばない**。片方の変更がもう片方の画面に反映されない
  (データは消えないが、見え方は本物と違う)
- **列挙順が本物と違う**。`for...in` の prototype キーも出ない。
  これに依存するアプリは挙動が変わる
- **IndexedDB を使うアプリは動かないまま**。`indexedDB.open()` が**同期に**
  `SecurityError` を投げるので、`try/catch` の無いアプリはそこで止まる
- **アプリが自分で開いた iframe / popup の中は素の opaque origin**
- **データ量に比例して起動が重くなる**(5MB で 167ms)
- **アプリは外部へ通信できる**(実測は環境要因で落ちたが、実ネットでは通る想定)。
  持ち出せるのは**自分の領域の中身だけ**だが、「保存したものが外へ出ない」とは言えない

※ §5(悪用の検討)と §3 の詳細は調査の戻り待ち。
