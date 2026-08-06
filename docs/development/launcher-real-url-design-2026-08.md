# ランチャーを実 URL で配る(調査 doc 1-7 / §8-1 の設計)

> 2026-08-06。**実装前の設計 doc**(doc-first)。裁定が要る点は §6。
>
> 対象: `docs/development/user-reports-2026-08-05.md` の
> **1-7「ランチャー:アプリ内のページ内アンカーでアプリが消える」**(L)と、
> その §8-1「ランチャーを作り直すか」。

---

## 1. いまの形と、壊れているところ

取り込んだ HTML の添付は、**信頼できる自前の外殻**を `window.open` で開き、その中の
`<iframe sandbox="allow-scripts …">` の **`srcdoc`** に添付を入れて走らせている
(`allow-same-origin` を付けないので不透明オリジン = PKC3 の保存内容に届かない)。

隔離は正しい。壊れているのは **document URL が `about:srcdoc` である**ことから来る
2 つで、どちらも**アプリ側の書き方では回避できない**:

| 症状 | 原因 | 現状の手当て |
|---|---|---|
| `<a href="#sec">` を押すと**アプリが消える** | `<base href="…/pkc3-app/">` があるので `…/pkc3-app/#sec` へ**本当に遷移**し、行き先は SPA fallback = PKC3 の index.html(不透明オリジンでは起動できず真っ白) | `app-anchor-shim.ts` が prelude でページ内リンクだけを捌く |
| **pushState を使う router が動かない** | 解決後の URL(base 基準)が document URL(`about:srcdoc`)と一致しないので `SecurityError` | 無い(**動かないまま**) |
| 相対 `fetch` が 200 で嘘を返す | 同上。base が SPA fallback を指す | 無い |

⚠ `<base>` を外すと相対 URL が全部落ちる(`about:srcdoc` は opaque path なので
`new URL(相対, base)` が `TypeError`)── **base を焼くか外すかの二択では直らない**。

---

## 2. 案 A:実 URL で配り、隔離は CSP ヘッダで掛ける

`srcdoc` をやめ、**Service Worker が持つ専用スコープ**から添付の HTML を
`text/html` として返す。iframe の `src` はその URL を指す。

```
<deployment>/pkc3-app/<token>/            ← SW が組み立てて返す(添付の HTML + prelude)
<deployment>/pkc3-app/<token>/assets/x.js ← アプリの相対 URL がここへ解決する
```

- **document URL と base が一致する**ので、アンカー・hash router・pushState が
  **素の意味論**で動く(`<base>` も anchor shim も要らなくなる)
- 隔離は **`Content-Security-Policy: sandbox allow-scripts …`** ヘッダで掛ける
  (`allow-same-origin` を書かない = 不透明オリジン)

### 2-1. 🔴 実測(2026-08-06。フル Chromium / 静的サーバで対照実験)

| 観測点 | ① `CSP: sandbox`(案 A) | ② ヘッダ無し(対照群) |
|---|---|---|
| `self.origin` | **null** | `http://localhost:46001` |
| `parent.document` | **blocked** | 読める |
| `localStorage` | **SecurityError** | ok |
| `indexedDB.open()` | **SecurityError** | ok |
| `document.cookie` | **SecurityError** | ok |
| `history.pushState` | **ok**(`…/app.html#pushed`) | ok |
| `<a href="#sec">` クリック | **ok**(同じ文書のまま、スクロールした) | ok |

⚠ ①は**いまの `srcdoc` と同じ隔離**(不透明オリジン・親 DOM 不可)を保ったまま、
**pushState と アンカーが動く**。②は「ヘッダが隔離を作っている」ことの確認
(iframe に入れただけでは隔離されない ── ここを測らないと、ヘッダの綴りを
間違えても「動いた」で通してしまう)。

計測スクリプトは `scratchpad/csp-sandbox-probe/`(serve.py + probe.mjs)。

---

## 3. 設計(案 A の中身)

### 3-1. 誰が HTML を組むか ── **main スレッド**(SW ではない)

添付に貸す保存領域(`localStorage` の名前空間)の**現在値**は
**main スレッドしか読めない**。しかも shim は「アプリの 1 行目から**同期に**読める」
ことを要件にしている(P8 段⑭。非同期にすると `localStorage` を素で読むアプリが
1 行目で落ちる)。したがって:

1. main が `buildLauncherAppShell` 相当で **HTML を組む**(seed を焼き込む)
2. main が **IDB に置く**(`pkc3-app-docs` ストア。鍵 = token)
3. main が `window.open('<deployment>/pkc3-app/<token>/')`
4. SW が `fetch` を捕まえて IDB から読み、**CSP ヘッダ付き**で返す
5. タブが閉じたら main が **IDB から消す**(生成物の寿命終端での即破棄 ──
   user 指示 2026-07-27 不可侵)

⚠ **SW のメモリに持たない**。SW はいつでも kill されるので、
「postMessage で渡してメモリに置く」形は**開いた瞬間に消えうる**。IDB なら
SW が作り直されても読める。

### 3-2. 落ちたときの姿

| 状況 | どうするか |
|---|---|
| SW が未登録(初回起動直後 / `file://` / 無効化) | **今の `srcdoc` の形へ落ちる**。⚠ 経路を 2 本持つのではなく、「実 URL が使えないなら今日の形」という**縮退**として持つ |
| token が IDB に無い(掃除済み / 別セッション) | 「もう一度開いてください」の 1 行を返す(白紙にしない) |
| 添付が消えている | 同上(理由を変える) |

### 3-3. 外殻(`window.open` で開く自前の HTML)はどうなるか

**残す。** 外殻は保存の受け口(`postMessage` → `localStorage`)と、上限の超過や
落ちたことの 1 行を出す場所を持っている。iframe の `src` が変わるだけ。

### 3-4. 消えるもの

- `<base>` の焼き込み(実 URL になるので不要)
- `app-anchor-shim.ts` のページ内リンク処理(素の意味論で動く)
  ── ⚠ **例外の 1 行を出す部分は残す**(あちらは URL の形と無関係)
- ⚠ 消すのは**縮退経路が要らなくなったときだけ**。SW 無しで `srcdoc` に落ちる限り、
  両方が要る(=「消える」のは実 URL 経路の中だけ)

---

## 4. 危ないところ(実装前に決めておく)

1. 🔴 **同一オリジンから untrusted な HTML を配る**ことになる。ヘッダを 1 語
   間違えれば、取り込んだ他人の HTML が **PKC3 の保存内容に届く**(いま塞いでいる穴)。
   → **smoke で `self.origin === 'null'` と `parent.document` 不可を必ず見る**
   (今の launcher smoke が既に持っている観測点を、実 URL 経路にも当てる)
2. **SW の precache に混ぜない**。`pkc3-app/` は動的応答なので、precache 一覧にも
   navigation fallback にも入れてはならない(入れると index.html を返して白紙になる)
3. **token は推測できない値**にする(添付の lid を URL に出さない ── 他のタブから
   同じ URL を開けると、貸した保存領域の名前空間に別のアプリが乗れる)
4. **掃除**: タブが閉じたら消す + 起動時に古い token を全部消す(前回異常終了ぶん)
5. `/dev/` と `/`(base './')の両方で動くこと ── 基点は配信ディレクトリから
   組む(2026-08-06 の minor m-10 で直した `launcherAppBase` と同じ規則)

---

## 5. 段取り

| 段 | 内容 | 分量 |
|---|---|---|
| ① | IDB の `app-docs` ストア(置く / 読む / 消す / 全消し)+ unit | S |
| ② | SW の `fetch` 経路(`pkc3-app/<token>/`)+ CSP ヘッダ + 縮退 + unit | M |
| ③ | 起動の配線(組む → 置く → 開く → 閉じたら消す)+ unit | M |
| ④ | smoke: 隔離(origin / parent)+ アンカー + pushState + 縮退 | M |
| ⑤ | `<base>` と anchor shim を実 URL 経路から外す + マニュアル | S |

---

## 6. 🔴 user の裁定が要る点

1. **やるか**(調査 doc §8-1 は案 A を推奨、案 B は「動かないことを正直に書く」)。
   ⚠ 実測は案 A を支持している(§2-1)── 隔離を保ったまま、いま動かないものが動く
2. **同一オリジンから untrusted HTML を配ることを受け入れるか**。
   隔離はヘッダ 1 本に依存する(実測済み・smoke で pin する)が、
   「srcdoc なら構造的に不可能」だった性質を「ヘッダが正しければ安全」に**格下げ**する
3. 案 B(現状維持 + 正直に書く)を選ぶ場合: pushState 型の router は動かないままで、
   その旨をマニュアルと詳細画面に出す(1 時間程度)
