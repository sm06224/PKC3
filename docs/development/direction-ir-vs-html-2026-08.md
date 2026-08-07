# 方向の裁定 doc ── PKC IR / 変換基盤 と「安全な HTML + script 埋め込み」

作成: 2026-08-06 / 状態: ✅ **裁定済み(§0.5)。実装 go** / 対象: PKC3
前提: PKC2 は read-only 参照。本 doc の PKC3 側の記述は実地(`file:line`)で確認したもの。

> user 指示 2026-08-06:
> 「**PKC-Markdown と PKC IR、IR を通した変換基盤をサブエージェントを駆使して実装し、
> 文書エンジンとしても活用するのが本来の思想。必要なら wasm で実装しても良いくらいと
> 思ってる / ただし、昨今は HTML を吐き出す AI なども多いことから、初期よりも
> PKC-Markdown の必然性は薄れてる / HTML やダイナミックな表現が可能なスクリプトの
> 実行を安全に埋め込むなど、そちらの方が欲しくなりつつある / いずれにしても
> サブエージェントを駆使してしっかり実装を分担して実施願います。**」

調査は 19 エージェント(規約の実像 / PKC2 の実地 / PKC3 の現状 / 埋め込みの安全性 /
外の相場 → 3 案を独立設計 → 3 レンズで敵対的検証 → wasm の当たり所 → 統合)。

---

## 0. 結論(先出し)

1. **3 案(IR-first / HTML-first / hybrid)はいずれも敵対的検証で fatal が出た。**
   だから「3 案のどれか」は推奨しない。推奨は **3 案の salvage を合成した第 4 の形**(§3)。
2. **方向に依らず要る仕事が 7 件ある**(§1)。**ここは裁定を待たずに着手できる。**
   うち 2 件は現在の PKC3 の実害で、1 件は**不可侵指示への現在進行の抵触**。
3. user が答えるべき問いは **3 つだけ**(§2)。
4. 「PKC-Markdown の必然性は薄れた」には **半分同意し、半分に反証がある**(§4)。

🔑 **先に 1 つ事実の訂正**: 「文書エンジン」という語は PKC2 の doc に **1 件も無い**。
規約側の対応物は「中央集権 IR」= IR から **6 形式**への射影表(HTML / docx / LaTeX /
Org / Pandoc MD / Anki)である。**pptx / PDF / EPUB は列すら無く、PKC3 が既に持つ
export 3 種(pkc3-html / pkc3-archive / pkc3-markdown-zip)も表に載っていない。**
そして **PKC3 に `src/features/ast/` は 1 行も存在しない**(IR 層は未着手)。
逆に **HTML / script 側は既に資産がある**(`html-sandbox.ts` / launcher 一式)──
ご意向の後者は**ゼロから建てる話ではなく、既定値と規律を直す話**である。

---

## 0.5 🔴 裁定記録(user 裁定 2026-08-06)

> user:「**推奨があっています / PKC-Markdown は正規形を iR のために残す必要がなければ、
> 縮小したバージョンで実装 OK / 外部画像は、要は追跡用のソースを csp するということか、
> ユーザー同意取る形ではいかんのか? / 設定で自動、常に確認、常にオフをとりましょう。**」
> ── 追って訂正:「**自動じゃねえや / 常にオン / 常に確認 / 常にオフだわ**」
> (3 つの名前を**対称**にする。以下その表記に統一)

| # | 裁定 |
|---|---|
| **Q1** 走査の 1 パス化 | **(b) 1 パスに畳むまで**(骨組み = sidecar は作らない)。推奨どおり |
| **Q2** docx を戻すか | **保留**。推奨どおり |
| **Q3** 箱を第一級に昇格 | **昇格させない**。推奨どおり |
| **付帯** 外部画像 | 🔴 **全面禁止ではなく「設定で 3 択」**(**常にオン / 常に確認 / 常にオフ**)。user の指摘どおり、同意を取る形にする |
| **新規** PKC-Markdown の縮小 | 🔴 **正規形を IR のために残す必要がなければ、縮小版で実装してよい** ── ⚠ **2026-08-07 の裁定で「やらない」に確定した**(下記) |

### 付帯裁定の中身 ── 外部画像は「設定 3 択 + 同意」

user の問い「要は追跡用のソースを csp するということか」への答え: **そうである**。
箱の CSP が `img-src *` なので、**1×1 の追跡画像**が素通りする。ノートを開いた瞬間に
相手のサーバへ「今これを読んだ」+ 接続元が届く。

🔑 **全面禁止(私の当初案)は棄却された。**正当に外部画像を使う箱まで壊れるので、
**同意を取る**のが正しい。実装の形:

| 設定 | 振る舞い |
|---|---|
| **常にオン** | 今と同じ(箱の中で外部画像が読める) |
| **常に確認**(既定にする) | 箱を**まず外部画像なしで描く** → 外部画像の参照があれば「このノートは外部の画像を N 件読み込もうとしています」と出す → 許可したらその箱だけ描き直す |
| **常にオフ** | 一切読まない(案内だけ出す) |

⚠ **順序が本体**である ── 「読んでから聞く」では**要求そのものが漏洩**なので意味がない。
**描く前に止める**しかない。したがって既定の箱は `img-src 'self' data: blob:` で焼き、
**許可された箱だけ**を広い policy で焼き直す。

⚠ **これは flag ではなく settings** である(user 指示「設定で」/ 不可侵「flags は最大 15 個
+ 正規設定と分離する」)。flag 枠を食わない。

⚠ **制御点は箱の CSP 1 か所**にする ── §1 C6 で「host CSP を置けば交差で閉じる」と
書いたが、**それをやると設定の『常にオン』が効かなくなる**(host が閉じたものは箱側で開けない)。
**host CSP に `img-src` を書いてはいけない。**同じ判定を 2 か所に置かない。

⚠ **確認の粒度**(私が選んだ既定。違えば変える):**ノート単位・そのセッションのあいだ記憶**。
host 単位にすると「どの host を許したか」を user が判断できない(追跡 host は無名である)。

### 「縮小版で実装 OK」の扱い

> 🔴 **2026-08-07 に確定した ── 縮小はやらない**(user 裁定。不可侵)
>
> 「**記法の縮小と簡単に言うが、ユーザーの動線を縮小することを忘れるなよ**」
>
> **記法 1 つ = user の書き方 1 つ**。落とせば「書けたものが書けなくなる」ので、
> 段数・維持コストと交換してよい物ではない。全数調査
> (`notation-shrink-survey-2026-08.md` §0.0)も同じ結論に着いていた ──
> 縮小案は 3 レンズすべてに反駁され、**買える物が無く失う物だけが具体的**だった。
>
> **買ってよいのは「記法を 1 つも失わない整理」だけ**: 本文に無い記法の段を
> **素通り**させる(出力は 1 バイトも変えない)/ 判定を 1 か所へ寄せる /
> 釣り合いの崩れを直して**落ちていた動線を戻す**。

以下は 2026-08-06 時点の記述(記録として残す)。

**記法を削ってよい**という裁定が出た。ただし**何を削るかは別の設計 doc**にする ──
削る対象・移行(既存ノートの読み替え)・goldens の扱いを決めないと、
「削ったら過去のノートが読めない」を作る。本 doc の §2 Q1 (b) は
**記法の縮小と独立**(走査の畳み込みだけ)なので、先にそちらを進められる。

---

## 1. 交わり ── 方向に依らず要る仕事(裁定を待たずに着手可)

選定基準: 3 案すべてが段として持つ、または 3 案いずれの前提でも今日の PKC3 に欠けている。

### C0. 箱(iframe)の定常が見える計器を作る ── 他の全段の前提

今日の計器は箱に対して **3 重に盲目**:

- `performance.memory.usedJSHeapSize` と DOM 数は **main frame のみ**(`tests/bench/run-app-session.mjs:257-261`)
- `URL.createObjectURL` の差し替えも main frame のみ(同 :122-131)
- **fixture に html fence が 0 件**
- `performance.measureUserAgentSpecificMemory` は使えない ── `crossOriginIsolated` が false
  で、これは事故ではなく **OPFS SAHPool を選んだ設計の帰結**

**deliverable**: 箱 0/4/8/30 個の fixture と「生きている箱の数 / srcdoc 総 bytes /
起きている frame 数」の観測点。加えて **「打鍵が止まってから画面が変わるまで」の
中央値と p95** を今日の数字として 1 枚出す(現ハーネスは `sleep(600)` で待つだけで
**latency を 1 度も記録していない**)。
⚠ この段は**判定しない**。「今日の表が出た」が着地。

#### 🔴 実測して確定した「取れるもの / 取れないもの」(2026-08-06。箱 8 個で probe)

| 観測点 | 可否 | 実測 |
|---|---|---|
| **箱ごとの DOM ノード数** | ✅ 取れる | playwright が 9 frame(main + 箱 8)を見て、**8 箱すべてで `evaluate` 成功** |
| **箱ごとの heap** | ❌ **取れない** | 8 箱が**全部同じ値**(`4231814`)を返す。`performance.memory` は**プロセス単位 + 量子化**なので**箱ごとに帰属できない** |
| `measureUserAgentSpecificMemory` | ❌ 使えない | `crossOriginIsolated: false` を実測で確認(OPFS SAHPool を選んだ設計の帰結) |
| **CDP `Performance.getMetrics`** | ✅ 取れる | `Documents: 22` / `Frames: 34` / `Nodes: 1421` / `JSHeapUsedSize: 5054360` |
| **生きている箱の数** | ✅ 取れる | CDP の target 一覧に `iframe:about:srcdoc` × 8(SW と asset worker 2 本も見える) |

🔑 **heap より良い指標が見つかった** ── **`Documents` / `Frames` の件数**である。
「箱が DOM から外れたのに回収されていない」状態はここに残るので、**C3(箱の寿命)が
本当に効いたかを直接測れる**。heap の帰属より、この方が知りたいことに近い。

#### 🔴 `Frames` / `Documents` の意味を確定させた ── そして前の段の読みを訂正する

⚠ **訂正**: この節は最初「箱 8 個で `Frames: 34` は**回収漏れの可能性**」と書いた。
**それは誤読だった。** 測り直した結果:

| 段 | Documents | Frames | 箱(DOM) | playwright frames |
|---|---|---|---|---|
| ① boot 直後 | 5 | 2 | 0 | 0 |
| ② 箱 6 個 | 12 | 14 | 6 | 6 |
| ③ 箱を全部消す(本文を書き換え) | **18** | **26** | **0** | **0** |
| ④ **`HeapProfiler.collectGarbage` を強制** | **2** | **1** | 0 | 0 |
| ⑤ もう一度 6 個 | 8 | 13 | 6 | 6 |

読み方:

1. `Documents` / `Frames` は **累積カウンタではなく「まだ renderer が保持している数」**。
   ③ で箱を消したのに**増えた**のは、外れた箱が**まだ回収されていない**からである
2. ④ **GC を強制すると 2 / 1 まで落ちる** → 箱は**回収可能**で、**回収が遅いだけ**。
   つまり **漏れてはいない**
3. 箱 1 個 ≈ **Documents +1 / Frames +2**(iframe 要素とその文書)

🔑 **したがって C0 の計測手法は「GC を強制してから読む」** ── さもないと
**「まだ回収されていない」を「漏れている」と読む**。私は現に 1 度そう読んだ。
⚠ この 1 行が C3(箱の寿命規律)の判定を左右する ── GC 前の数字で「LRU が効いた」と
言えてしまうし、逆に「漏れている」とも言えてしまう。**どちらも嘘になる。**
⚠ 対照群は「箱 0 個 + GC 後」を毎回取る(baseline が 2 / 1 であることを確かめる)。

⚠ したがって C0 の表は「**箱の常駐メモリ**」ではなく「**生きている箱の数 / Documents /
Frames / Nodes / srcdoc 総 bytes / 打鍵→反映**」で作る。**heap は箱に帰属できないことを
表に明記する** ── 測れないまま「横ばい」を美点として読むのが、この repo が繰り返し
踏んだ罠である。

### C1. 箱の受け口を 1 本にする + `event.source` 判定(丸写しの是正)

- resize の受け口は `event.source` も `event.origin` も見ず、**形だけ**を検査
  (`src/features/markdown/html-sandbox.ts:143-160`)
- id は content の FNV-1a base36 = **文書側から計算できる** →
  **箱 A が同一文書の箱 B の高さを 0px にできる**(内容を隠せる)
- 同じ判定の第 2 実装が書き出し HTML にあり、escape が `CSS.escape` ではない
  (`src/features/export/pkc3-html.ts:345`)
- 🔑 移すべき規律は**同じ repo に実測付きで在る** ── 「判定は
  `event.source === iframe.contentWindow` **だけ**にする / `e.origin` は使わない
  (両方向に嘘をつく)」(`src/features/launcher/app-shell.ts:233`, `:319`)
- 🔴 **不可侵「丸写し禁止」への現在進行の抵触**: `html-sandbox.ts:1` のヘッダは PKC2 の
  履歴のまま、同 :135 は「`rendered-viewer.ts` でも wire する」と指示するが
  **PKC3 にその file は存在しない**(実配線は `src/main.ts:789` の 1 か所)

**測り方**: ① smoke「箱 A が箱 B の高さを 0px にできない」を pin(**今はできる**)
② parity test は**両向き**で書く ── 「A が受けるものは B も受ける」だけでなく
**「A が拒むものは B も拒む」**(片向きだと現在の差異が通る)③ 変異試験。

### C2. 実行の既定値 ── 取り込んだ箱は「押して動かす」

- ```` ```html ```` は無印で `sandbox="allow-scripts"` の iframe として**必ず描かれる**
  (`markdown-render.ts:156-197`, `:247` → `html-sandbox.ts:124-129`)
- 箱の CSP は `img-src * data: blob:`(`html-sandbox.ts:70`)。`connect-src 'none'` は
  fetch を止めるが **`new Image().src` は明示的に許可**されている ── 設計コメント
  (同 :12-17)の「外部 fetch 禁止」は **img を見落としている**
- 取り込みの形式判定は先頭が `<` なら html(`src/features/import/detect-format.ts:91`)

つまり **取り込んだノートを開くだけで、任意の第三者に「この user がこれを今読んだ」
+ IP が飛ぶ。** 3 案とも箱を維持する以上、ここは方向に依らない。

**deliverable**: provenance(自筆 / 取込)を実行の既定値の入力にする。取込由来は既定で
姿見 + 明示操作で起動。自筆は視界で走る。
**測り方**: ①「`-norender` を知らない書き手が意図せず実行させる経路」の件数を 0 で pin
(経路を 1 本足すと 1 になることを確認)② 取込 fixture で「開いただけでは外向き要求が
0 件」を smoke で pin ── **外向き img を必ず観測点に入れる**(今の隔離検査は到達しか
見ておらず**持ち出しを見ていない**)。
**flag**: `boxes.autorun` 1 個。畳む条件「誤爆報告が 2 週間 0 かつ C0 の指標が悪化 0」。
⚠ 登記所 `src/features/flags.ts` は**存在しない**ので、この段で作る(現在 flag は 0 個 / 上限 15)。

### C3. 箱の寿命規律 ── ただし差分反映の帳簿を壊さない形で

箱には「描いたら焼く」に相当する規律が無く、`loading="lazy"` は初回を遅らせるだけ。
一度読んだ箱の script は**文書を閉じるまで走り続ける**。

🔴 **ただし敵対的検証で fatal 1 件**: iframe を DOM から外すと `apply-blocks` の
`intact()` が総数不一致で落ち、次の反映が `replaceAll` になる ── **本文丸ごと再構築**
= scroll 喪失 + 図の再 hydrate + ObjectURL 総取替。しかも **html fence を持つ文書だけ**で
起きるので現 fixture では**永久に見えない**。
→ **「捨てて作り直す」ではなく「高さ 0 に畳む / srcdoc を空にする」**から始める。
⚠ **箱は焼けない**(不透明 origin は canvas に描けない見込み。**未確認**)ので、
「焼く対象外」の例外を明示して寿命規律で代替する。
**測り方**: 常駐(箱 N 個の傾き)と**再 mount 1 回の主スレッド占有**の**両側**。
片側だけで LRU を入れると「もっさり」に振り替わる。⚠ 判定に long task 件数を使わない
(この機械は 50ms 未満を落とすので既に 0 本)── 使うのは心拍の最大の空きと打鍵→反映。

### C4. 隔離の対照表を箱経路に当てる + 素のまま起動の穴を実測する

- launcher 側には **12 観測点の実測表**がある(`app-sandbox-shim.ts:9-40`)が、
  **fence 経路にこれを見る test は 0 件**(`fence-render.smoke.spec.ts` は高さだけ)
- 🔴 **launcher の素のまま起動(`allow-same-origin`)が今日到達可能**
  (`app-shell.ts:110`, `:280`)。この面では `caches` が読める。SW は hash 付き生成物を
  **cache-first** で返し(`sw-source.ts:272-275`、`MATCH.ignoreVary` は `:129`)、
  activate の自己修復は**件数比較**なので**既存キーの上書きは修復に引っかからない**。
  同意は「このタブを閉じるまで」なのに、成立すれば **build が変わるまでの恒久コード実行**
- launcher の外殻に CSP は **0 行**

**測り方**: nightly。PR gate には入れない。
⚠ **上記 cache 汚染はコード読みで成立を読んだだけで、実機で実行していない。**
実測して成立するなら「塞ぐ」か「raw モードを落とす」かの裁定が要る。

### C5. PUA sentinel の漏れ test(現在 0 件)

PKC3 は `html: false`(`markdown-render.ts:50`)を **PUA sentinel(U+E110〜U+E16B)で
意図的に迂回**している。ところが **`tests/` に PUA を名指す assert は 0 件**。
方言の是非と無関係な **XSS / データ破壊の境界 test** であり、3 案いずれでも要る
(HTML-first は legacy を凍結するので**なおさら**)。
⚠ 入力側で本文由来の PUA を落としているかは**未確認** ── test の形を決める前に確かめる。

### C6. host 側の CSP と innerHTML の出所

🔴 **実測して分かった:このままでは着手できない**(2026-08-06。候補 CSP を当てて全 smoke を回した)。

**host に CSP を置くと、`srcdoc` の箱の中の script が全部止まる。**

```
Refused to execute inline script because it violates the following
Content Security Policy directive: "script-src 'self' 'wasm-unsafe-eval'"
```

CSP は **`srcdoc` の子へ継承され、複数の policy は交差する(厳しい側が勝つ)**。
箱は自前の meta CSP で `script-src 'unsafe-inline'` を許しているが、**親の
`script-src 'self'` が箱の中でも効く**ので、箱の高さ通知 script も launcher の
アプリも動かなくなる。実測: **候補 CSP を当てると smoke 83 → 77 passed / 6 failed**
(`fence-render` 1 件 = 箱の高さが 0 のまま + `launcher` 5 件)。

⚠ **逃げ道が無い** ── `frame-src` は継承を制御しない。継承は仕様であり opt-out できない。
したがって選べるのは:

| 案 | 何が起きるか |
|---|---|
| **(a) host の `script-src` に `'unsafe-inline'` を足す** | 箱は動くが、**CSP の主目的(混ざった script を止める)が消える** |
| **(b) 箱を `srcdoc` で配るのをやめる**(実 URL / blob:) | 親の policy を継承しなくなる。**= §2 Q3 の「昇格」そのもの**(裁定待ち) |
| **(c) host に CSP を置かない**(現状) | 今日の姿勢を保つ。CSP で買えるものは買えない |

🔑 **C6 は Q3 と構造的に結合している** ── 「host に CSP を置く」は
**箱の配り方を変えない限り成立しない**。これは本 doc の初版が持っていなかった情報である
(§8 で `frame-ancestors` / `sandbox` / XFO の限界は挙げたが、**継承**は挙げていなかった)。

⚠ **もう 1 つ、meta では買えないものが増えた**: **`Content-Security-Policy-Report-Only`
は meta に無い**。つまり「まず報告だけ」ができないので、当てて壊れないかを**実測で
確かめるしかない**(今回そうした)。

🔑 **副産物の発見(裁定に効く)**: 継承が交差するということは、host に
`img-src 'self' data: blob:` を置くと、**箱の `img-src *` が交差で閉じる** ──
つまり **C2 の「取り込んだ箱から外へ IP が飛ぶ」穴が、goldens を 1 バイトも動かさずに
塞げる**(index.html は golden ではない)。⚠ ただし**振る舞いの変化は C2 と同じ**
(箱の中の遠隔画像が読めなくなる)なので、**付帯裁定の対象は「goldens が動くか」
ではなく「その振る舞いを変えてよいか」**である ── ここは user 裁定を仰ぐ。

以下は初版の記述(効能の見立ては変わらない):


- `index.html` に CSP は **0 行** / `innerHTML` は src 内 11 箇所 / Trusted Types は 0 hit
- ⚠ **効能を過大に書かない**: innerHTML に入るのは自前描画器の出力で、本文由来の生タグは
  `html: false` でゼロ。だから Trusted Types policy は「素通し関数」になり、
  **実効的な検査は増えない**。pin すべきは「違反 0」ではなく
  **「policy へ入る文字列の出所が全部 PKC3 の描画器であること」**
- ⚠ meta CSP で**買えないもの**を doc に書き分ける: `frame-ancestors` / `sandbox` は
  meta では無効、`X-Frame-Options` は Pages ではヘッダを打てない。clickjacking の緩和は
  **同意 UI 側**(`window.top !== window` のとき全権導線を出さない)に置く
**測り方**: 違反 0 を pin し、**故意に 1 件入れて 1 件出ること**を毎回確認(空振り検品)。

### 交わりの着手順

`C0` → `C1` `C5` `C6`(数字を待たずに着地可)→ `C2` → `C3`(C0 の数字が出てから)→ `C4`(nightly)。
各段は単独で着地し単独で計測できる。⚠ **wave map にしない** ── PKC2 は 16 PR stack と
儀式の掛け算で着地できなくなり、Phase γ 68 PR を凍結した。

---

## 2. 分水嶺 ── user が答える 3 問

### Q1. markdown の走査を畳む工事(R0-2)を、どこまでやるか

前処理と後処理が独立に全文を走る構造が支配項。`markdown-render.ts` は **4,589 行**で、
**PKC2 の 4,191 行を既に超えている**。

| 選択肢 | 買う物 | 代償 |
|---|---|---|
| **(a) やらない** | goldens 25 件が 1 バイトも動かない。定常は既に long task 0 本 / heap 横ばい | 200KB 級の走査コストが永久に残る |
| **(b) 1 パスに畳むまで**(推奨) | 「安全に実行できる最適化」。goldens が唯一の安全網として効く | L 1 段。⚠ **合格線を先に数字で決めないと、PKC2 と同じく「後から解釈で通せる gate」になる** |
| **(c) 骨組み(sidecar)まで** | 4 収穫(source-ranges / link-scan / 見出し / frontmatter)が 1 つに。Q2 の docx と全文検索の土台 | 打鍵の静穏ごとに worker 境界を越える物量が inline token 数に比例して増える(**未計測**) |

### Q2. Office 出口(docx)を PKC3 に戻すか

PKC3 の export は 3 種で Office は 0。移植候補 doc 自身が「落ちているのは意図ではなく漏れ」
と書いている。

- **戻す** ── IR / 骨組みを正当化する**唯一の外部需要**になる。代償: inline の表現力が
  要る(平坦な run 列では足りない)→ 骨組みが育つ / 新規 runtime 依存 /
  **worker で動くかは未確認**(`DOMParser` 系の制約)
- **戻さない** ── 帳票は「HTML + 印刷(paged CSS)」に一本化。**PKC2 に対する明確な
  機能後退として記録する。** 5 年後に戻す判断が来たときのコストは、その間に増えた
  不透明な HTML 島のぶん上がる

### Q3. 箱(HTML / script)を「第一級」に昇格させるか

- **昇格させる(実 URL 配布 + 能力宣言 fence)** ── AI が吐く SPA 的 HTML が素の意味論で
  動く(pushState / 相対 fetch / 非 hash アンカー)。**代償: 隔離の根拠が
  「srcdoc なら構造的に不可能」から「ヘッダが正しければ安全」へ格下げされる**
  (設計 doc 自身が user 裁定事項として挙げている)。Pages はヘッダを打てないので出所は
  SW だけ、SW は `skipWaiting` を呼ばない設計なので「居ない窓」が常在する
- **昇格させない(推奨。fence の枠内の安全側是正 = §1 C1〜C4)** ── 今日の隔離を保ったまま
  最も危険な既定(取込の自動実行 / `img-src *`)を閉じる。pushState 型の島は動かないまま

🔴 **付帯裁定**: 既定 CSP を締める(`img-src *` → `'self' data: blob:`)と CSP 文字列が
出力 HTML に出るので **goldens 25 件が 1 度だけ動く**。user 裁定 2026-08-01
「golden byte 一致契約は捨てない / 捨てるなら別 doc で改めて裁定」に照らし、
**「1 度だけ、安全上の理由で動かす」を認めるか**を明示的にお答えいただきたい。

---

## 3. 推奨

### 「交わり先行 + Q1=(b) まで / Q2=保留 / Q3=昇格させない」

3 案すべてに fatal が出たので、そのままの形ではどれも推奨しない。以下は salvage の合成。

1. **IR-first の fatal を構造的に回避できる。** IR-first の核「goldens byte 一致を
   受入条件にすれば flag なしで legacy を消せる」は、**PKC2 が 2026-05 の migration plan で
   一字一句同じことを宣言して失敗した当の設計**である(byte-equivalent を 50+ fixture で
   assert すると事前登録し、着地したのは「semantic equivalent / fixture 31 件 / tag 集合の
   包含」)。**Q1 を (b) で止めれば HTML serializer を作らないので、この fatal は発生しない。**
2. **HTML-first の fatal を買わない。** 実 URL 島は fail-closed → fail-open の格下げで、
   対照実験に「実 URL + `sandbox` 属性維持 + ヘッダ無し」という**第 3 の腕が無い**
   (設計 doc の表は 2 腕)。かつ pushState の実測は **fragment 変更のみ**で、
   **壊れている当のもの(path router)が直る証拠になっていない。**
3. **hybrid の fatal を切り落とせる。** hybrid が棄却された理由は主に包装(9 段束ね)と
   S5(未計測のまま旧 4 収穫を消して退路を断つ)/ S6(FTS の書き込みが**殺せない常駐
   storage worker** に落ちる ── SAHPool は実質単一接続)/ S8(export 3 種のうち markdown を
   parse するのは pkc3-html だけなので「byte 一致 = 骨組みが十分」が**算術的に空**)。
   推奨形はこの 3 段を落とす。
4. **交わりは 3 案の salvage の交点にきれいに重なる。** 3 レンズすべてが独立に C1 / 箱の
   計器 / 箱の寿命 / host CSP / PUA test を拾っており、**ここに fatal は 1 件も出ていない**。

**推奨形が要求する flag: 1 個**(`boxes.autorun`)。骨組みも IR も入れないので
`markdown.use_ir` 型の第 2 経路は生えない。

---

## 4. 「PKC-Markdown の必然性は薄れた」への回答

### 同意する部分

1. **「AI は formal 形(`:::strong[X]`)の方が emit しやすい」は陳腐化した。**
2. **「HTML pass-through を一切受け付けない」原則は、規約自身が既に破っている。**
   `html` fence は無印で iframe レンダリングされ `allow-scripts` で script が走る。
3. **「HTML 直書きは markdown らしさが失われる」も自壊している** ── PKC2 の v4 spec は
   同じ doc の中で「複雑 layout は html fence で」と書いている。
4. **人が直読みする artifact は HTML が強い**(⚠ 一次記事は 403 で読めていない = **未確認**)。

### 留保する部分(反証は在る)

1. **北極星の「安く」に直撃する。** 同一情報で HTML は output token が 2〜4 倍、生成も
   2〜4 倍遅い。output token は主要 API で input の 3〜5 倍高い(**二次情報・未確認**)。
2. **PKC3 の実測が「方言をやめれば速くなる」を支持していない。** `renderMarkdown` の
   支配項は方言の有無ではなく**走査そのもの**で、0.339 vs 0.352 ms/KB。
   **速さを理由に方言を削る根拠は repo 内に無い。**
3. **2026 の agent の部分更新機構はプレーンテキスト前提**(str_replace 型 / hashline。
   **未確認**)。PKC3 の内側もテキスト前提(revision の逆向きパッチは行単位、
   ライブエディタは塊単位)。
4. **「Rust/wasm 化」は「IR を捨てる」と同方向ではない。** Astro の Rust 製 markdown
   processor は MDAST / HAST の plugin system を自前で持ち、**IR は Rust 側へ移った**
   (**未確認**)。Typst の preview も vector IR に依存している。
5. **HTML 正本の部分更新コストは PKC3 の中で既に顕在化している。** 302KB の HTML を
   丸ごと作り直すと scroll が飛び図が焼き直しになる ── だから深さ 0 の境界で塊に切っている。
   **これは HTML 正本の代償の前払いである。**
6. 🔴 **「HTML を正本にした文書システム」の実運用例を 1 件も見つけられなかった。**
   反証を探したが実勢はすべて「markdown / IR 正本 + HTML は view」だった。
   **この空白そのものが所見。**

### 結論

薄れたのは **(a) formal 形の surface syntax の必然性** と **(b)「HTML を一切通さない」原則**。
薄れていないのは **(1) body がプレーンテキストである地位**(diff / merge / AI の部分修復 /
検索 / 監査が全部これに載る)、**(2) 形式の揺れと意味の変更を分離できる性質**、
**(3) HTML が入力に増えるほど必要になる 1 本の hub**。

したがって user の関心(HTML / 安全な script)は **body 形式の変更ではなく
「body の中の安全な HTML 島」** として着地させるのが、不可侵にも実勢にも整合する。
**その島の実装は既に `html-sandbox` として在る** ── 新規に建てる話ではなく、
**既定値と規律を直す話**である。

---

## 5. 安全な HTML + script 埋め込みの具体形(2026 に新規で作るなら)

相場は「別 origin / site の sandboxed iframe + strict CSP + Trusted Types」。

| 相場の要素 | PKC3 の現在地(実地確認) |
|---|---|
| opaque origin | **ある**(`allow-same-origin` なし) |
| srcdoc の escape | **ある**(`& " < >` 全部)= 属性脱出は構造的に不可能 |
| 本文の生 HTML | **通さない**(`html: false`)── 今日の XSS 姿勢の土台はこの 1 行 |
| 箱内 CSP | ある。ただし `script-src 'unsafe-inline'` のみ / **`img-src *`** |
| 別 site 配信 | ない(単一 HTML 可搬と両立しない) |
| Trusted Types / Sanitizer | ない(TT は Chromium 中心、Sanitizer は Baseline でない。**未確認**) |
| launcher 外殻の CSP | **0 行** |
| host の CSP | **0 行** |

**差分として書く「新しく作るならこう」**

1. 受け口を `event.source` 同一性 1 本に。`origin` は使わない(実測で両方向に嘘をつく)
2. 既定 CSP を締める(`img-src 'self' data: blob:` + `form-action 'none'`)。
   **遠隔画像が要る箱だけ opt-in**(安全の極性を逆にしない)
3. 能力宣言は fence の属性にするが、**policy の入力に provenance を必須**にし、
   **取込由来の宣言は昇格に使えない**(never widen)。未知 token は**無視ではなく拒否**
   (無視すると緩い側に落ちる)
4. 能力の軸を **「eval できるか」と「遠隔へ送れるか」で必ず分ける**。
   eval を許した箱に遠隔送信を許さない(難読化された持ち出しが静的にも人にも判定できない)
5. host に CSP。**meta で買えないものを doc に書き分ける**
6. 箱の寿命規律(§1 C3 の手で)
7. launcher の素のまま起動を実測して裁定する

**採らない**: QuickJS-wasm(常駐 500KB〜1MB + V8 比 10〜50 倍が定常に乗る。iframe で
隔離できているものに足す理由が無い)/ ShadowRealm(Stage 2.7)/ Sanitizer API 単独 /
別 site 配信 / 実 URL 配布(採るなら**第 3 の腕**を先に測る)。

---

## 6. wasm の判定表

判定枠組みは既決(B1 境界 1 往復あたりの仕事量 / B2 戻り値が小さいか bytes のまま次段へ /
B3 状態を持たない。「効果が小さいから」は棄却理由にしてはならない)。

| 候補 | 判定 | 理由 |
|---|---|---|
| markdown parse | **やらない** | goldens byte 一致契約 + markdown-it 内部 16 フックの再実装 + .wasm 202KB。出口が `innerHTML` なので**最も重い DOM 構築は 1ms も減らない**。先に R0-2 |
| IR 変換 | **候補にすらならない** | 移す対象が存在しない(`src/features/ast/` 無し)。出力が大量の JS 文字列で B2 不成立。常駐 IR は B3 と衝突 |
| diff / patch | **保留(既決)** | 出力 byte 一致は green だが**速度の符号が harness 間で反転**(+17〜27% / −13〜19%) |
| content-hash | **恒久的にやらない** | 全サイズで wasm が 1.58〜2.30 倍**遅い** + UTF-16 依存値が DB に永続化済み |
| ZIP の CRC-32 | **wasm より先にワーカー移送** | 329 MB/s で B1・B2・B3 を素で満たす唯一の候補だが、ワーカーに出せば占有が 1/3 ではなく **0** になる |
| 圧縮(zstd) | 今はやらない | 「何を縮めたいか」の要求が doc に無い(買い手が未定義) |
| 添付取込 | やらない | すべて native API で既にワーカー。定常 long task 0 本。**native C++ を置き換える逆行** |
| 図のラスタ化 / 検索索引 / sqlite 本体 | やらない | 順に:DOM を要求 / FTS5 は既に wasm / OPFS SAHPool の成果を捨てる |

**wasm を置く場所の規律**: **使い捨て計算ワーカー**に置けば instance は worker の kill で
消えるので「linear memory は縮まない」が自動的に解決する。常駐 storage worker に置く場合は
**instance 単位の破棄機構と抱き合わせでしか許されない**。

🔴 **doc の前提 1 件が既に古い**: rust-wasm doc は `renderMarkdown` を「メインスレッド」と
書くが、今は読む面も編集面も**ワーカー**である(2026-08-06 に読む面も移した)。
**「main が markdown で詰まっているから wasm」は現在の実測では支持されない。**

---

## 7. やらないと決めるもの

**IR / 変換基盤側**: `canonicalize` / `semanticHash` / round-trip 契約(3 通りに書かれた
強さを 1 つに決める作業ごと捨てる。PKC2 の `isCanonical()` は引数を捨てて `true` を返す
stub が 3 ヶ月以上残り、test がそれを緑で固定していた)/ inline の tree(22 inline ×
17 block の union)/ IR の永続化・交換形式としての公開 / 既定 OFF + silent catch の
第 2 描画経路 / PKC2 の bridge 層・shield sentinel・二重 decompose / pptx / LaTeX /
PDF-native / EPUB / Org / Anki / Pandoc 中継 / 「semantic 等価」test / 全文検索(FTS)。

**箱 / 実行側**: QuickJS-wasm / ShadowRealm / 別 site 配信 / Sanitizer API 単独 /
fence と launcher の**機構**の 1 本化(要求が逆。共有するのは方針の表だけ)/ 実 URL 配布。

**方向側**: body 形式を HTML に寄せること(**不可侵に抵触**)/ 文書本体を structured
output で縛ること / markdown-render・content-hash の wasm 化(既決)。

---

## 8. 未計測・未確認の一覧(この doc が推測で語っている所)

**測っていない**: ① 実ブラウザでの wasm 実測が 1 件も無い ② **箱の常駐が 1 バイトも
測られていない** ③ **「打鍵→反映」の latency を記録するハーネスが無い**(Q1 の判定器が
まだ存在しない)④ 確定 1 回 150ms の内訳が未分解 ⑤ worker の spawn コスト
⑥ 骨組みを worker 境界で渡す構造化複製の増分(Q1 (c) の主要リスク)⑦ 箱の再 mount 1 回の
主スレッド占有 ⑧ 図のラスタ 1 枚の所要 ⑨ ZIP の CRC をワーカーへ出した end-to-end
⑩ PR gate 内の goldens 25 件の実行時間 ⑪ IR の計測は PKC3 にも PKC2 にも 0 件。

**確かめていない(コード読み / 二次情報のみ)**: ⑫ **launcher 素のまま起動 → SW cache
汚染が boot を越える**(成立をコードから読んだが**実機未実行**)⑬ iframe の自己
ナビゲーションを CSP で止められない / WebRTC は CSP の外 ⑭ **箱は焼けない**
⑮ 実 URL の第 3 の腕が opaque origin を保つか ⑯ pushState の実測は fragment のみ
⑰ `docx` / `pptxgenjs` が worker で動くか ⑱ 入力側で本文由来の PUA を落としているか
⑲ frame 単位の heap を CDP で取れるか ⑳ 前処理の段数が cite 元と食い違う(doc は 22 段、
私の数え方は 19)㉑ 二次情報依拠のもの(Anthropic の記事本文 403 / Astro の一次設計 doc
403 / TT・Sanitizer の Baseline 状況 / output token の価格比 / Claude artifacts の隔離)。

---

## 9. 不可侵指示への抵触の申告(隠さない)

1. 🔴 **「流用 + 総合的見直し。丸写し禁止」に現在進行で抵触している。**
   `html-sandbox.ts:1` は PKC2 の履歴ヘッダのまま、:135 は PKC3 に存在しない
   `rendered-viewer.ts` への wire を指示。**§1 C1 がこれを正す段。**
2. **「新機能を盛り込みすぎない / 将来領域は正本 doc §10 の拡張点のみ」に抵触する可能性。**
   正本 doc §11 の P0〜P7 に「IR」「HTML の第一級化」「全文検索」は**どの段にも無い**。
   §2 の Q1〜Q3 はいずれも **doc-first で user 裁定を要する方向転換**である。
3. **「図は描いたら焼く」の精神に触る。** 箱は焼けない(**未確認**)ので、本 doc は
   「箱は焼く対象外」という例外を明示的に作り、寿命規律で代替する。
4. **golden byte 一致契約に 1 度だけ触る**(§2 Q3 の付帯裁定)。
5. **「全 body = PKC-Markdown、JSON 文字列 body を作らない」**: 推奨形はここに触らない。
   HTML-first の字義(body に HTML / 別列)は**抵触する**ので採らない。
6. **「重い処理はワーカーへ」との摩擦 2 点**: (a) HTML 入力を IR で受ける設計は
   `DOMParser` が worker で使えないため main thread に残る ── 推奨形はやらない。
   (b) 全文検索の索引書き込みは SAHPool の単一接続ゆえ**常駐 storage worker** に落ちる
   ── 推奨形では別裁定へ。
7. **flag 予算**: 推奨形は 1 個(`boxes.autorun`)。登記所は存在しないので最初の flag を
   入れる段で作る(現在 0 個 / 上限 15)。
