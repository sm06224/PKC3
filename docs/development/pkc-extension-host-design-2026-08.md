# PKC-Extension(pkc-ext)── 拡張とホストが話す口(C-5 / #195)

**Status**: 設計。user go は 2026-08-25(「**B-2 と C-5 両方 go でいいよ**」)。
**正本 doc** §10 の将来領域に対する明示 go として受け取っている。
**前提** C-4(#189)は着地済み(`src/adapter/transport/`)。

> ⚠ この doc に書くのは**設計と根拠**だけである。やること(残件)は #195 に置く
> (user 指示 2026-08-15「ファイルをただ置いておくのはやめろ」)。

---

## §1 何のためか ── user から見た 1 行

> **ランチャーで開いたアプリが、いま PKC3 に在るノートを見て働けるようにする。**

いま(2026-08-25)ランチャーのアプリは**完全に孤立している**。隔離は正しく効いて
いるが、ノートを 1 件も見られないので、**「PKC3 の中で動く道具」ではなく
「PKC3 が置いてあるだけの別アプリ」**である。

⚠ 逆に言うと、**孤立していること自体は欠陥ではない**(それが安全の土台である)。
足すのは「**穴**」ではなく「**戸口**」── 何が通るかを user が決められる形にする。

---

## §2 🔴 まず訂正 ── C-4 の「上に載せる」ではない

#195 に「既に在る受け口の上に載せます」と書いたが、**向きが逆だった**(2026-08-25 訂正)。

| | 誰が誰に | PKC3 の役 | 実体 |
|---|---|---|---|
| **C-4**(#189) | 親 → PKC3 | **子**(iframe に入れられる側) | `transport/message-bridge.ts` |
| **C-5**(pkc-ext) | PKC3 → 拡張 | **親(host)** | これから作る |

🔑 **口そのものは共有できない。共有するのは判定の層**である ──
`transport/protocol.ts`(封筒の検査 / `originAllowed` の fail-closed /
`roughSize` / 毎分の上限)は**そのまま使う**。同じ問いに答える口を 2 つ作らない
(CLAUDE.md §7)。

---

## §3 🔑 いちばん大きな発見 ── **器はもう在る**

PKC2 の pkc-ext の主要 5 file は **1,680 行**である(`extension-channel.ts` 382 /
`record-offer-handler.ts` 468 / `extension-host-runtime.ts` 531 /
`pkc-extension-startup.ts` 131 / `render-for-extension.ts` 168 ── 2026-08-25 に
`wc -l` で数えた。ほかに `action-binder` / `renderer` / `attachment-presenter` /
`main.ts` に散っている分がある)。⚠ その**大半は隔離と導線の仕組み**で、
**PKC3 は既に持っている**(P8 段⑭〜⑯、`features/launcher/`)。

> ⚠ `transport/protocol.ts` の表にある「10 file / 2,117 行」は **PKC2 の
> message transport(v1 + v2)** の規模であって、pkc-ext の規模ではない
> ── 取り違えないこと(2026-08-25 に一度取り違えかけた)。

| PKC2 が pkc-ext のために作ったもの | PKC3 の現状 |
|---|---|
| Tier S sandbox(`allow-same-origin` を付けない) | ✅ `app-shell.ts` ── **同じ規律が既定**。事故の修理として確立済み |
| popup shell + `document.write` | ✅ 外殻 HTML を組んで `window.open`(`document.write` は使わない) |
| 子 → 外殻の判定(window identity) | ✅ **`event.source === frame.contentWindow` だけ**で判定(`event.origin` は両方向に嘘をつく、と実測つきで明記) |
| 🔴 **Tier S は永続化できない**(「将来 host 経由 API」のまま**空いていた**) | ✅ **解決済み** ── `app-storage-shim.ts` が localStorage を貸す(2MB 上限 / lid ごとの名前空間 / **使用量は信頼側が数える**) |
| capability → sandbox トークンの写像 | ⚠ 未実装(`allow="clipboard-write"` だけ手当てされている) |
| projection / deliver / write の口 | ❌ **無い** ← **これが C-5 の本体** |

🔑 つまり C-5 は「拡張ホストを作る」ではなく、
**既に隔離して開いているアプリに、名前付きの口を 1 つ足す**仕事である。

---

## §4 経路 ── 3 段になる(避けられない)

```
拡張(iframe / opaque origin)
   │ postMessage(判定は event.source の同一性だけ)
   ▼
外殻の窓(PKC3 origin。window.open で開いた別窓)
   │ BroadcastChannel
   ▼
本体タブ(store の lease を握っている)
   │ StorePort
   ▼
sqlite worker
```

⚠ **短くできない。** 理由は 2 つとも実測に基づく:

1. **外殻は `noopener` で開く** ── `opener` を残すと同じ context group に居座り、
   実測で **743.9MB → 5.8MB(99% 減)**の差が出た(`office-window.ts`)。
   だから窓の handle は持てず、**BroadcastChannel** で話す(office の窓と同じ形)
2. **store の lease は本体タブが握る** ── OPFS SAHPool は 1 つの持ち主しか許さない。
   外殻の窓から直に読ませることはできない(「保存は本体タブ経由です」と
   既に user へ出している形と同じ)

🔑 **既に同じ形が 1 つ動いている**(Office の書き戻し)。**2 本目を別の形で作らない。**

---

## §5 引き継ぐ規律(PKC2 が正しくやっていた 4 つ)

1. 🔴 **既定で流れるのはメタ情報だけ。** `projection` に **body / assets / revisions を
   載せない**(PKC2 は spec に MUST と書いていた)。これが封じ込めの本体である
2. 🔴 **実体は user の送付ジェスチャでのみ流れる。拡張から取りに行く口は無い**
   (pull 経路 MUST NOT)── 「送るという操作そのものが同意」
3. 🔴 **書き戻しは名前付き op の小さな語彙 + host 側の検証。**
   1 件でも不正なら**全体拒否**(部分適用しない)
4. 🔴 **新規作成だけは同意を挟む**(PKC2 の `propose`)── 既存の編集と信頼の質が違う

⚠ 4 は PKC3 では**既に持っている** ── C-4 の `pkc.createEntry` が
「**外から増えたことを黙って起こさない**」ために帯を出す形になっている。同じ口を使う。

---

## §6 持ち込まないもの(PKC2 が自分で困っていた形)

| 持ち込まない | 理由 |
|---|---|
| **封筒 2 形式の並列稼働**(v1 平坦 / v2 JSON-RPC) | PKC2 は `isV2Envelope()` で毎回選び分けていた。PKC3 は既に 1 形式(CLAUDE.md §7) |
| **語彙の膨張** | write op が 9 種まで育ち、さらに `propose` / `structure-plan`(DSL)/ `purge-orphan-assets` が生えた。⚠ **段① で全部作らない** |
| **`document.write` の popup shell** | PKC3 は外殻 HTML を組む形で置き換え済み |
| **「Tier S は保存できない」** | PKC3 は貸す(§3)。**PKC2 の制約を仕様として持ち込まない** |
| **同じ markdown を面ごとに別経路で描く** | PKC2 の構造問題(自己診断済み)。拡張へ渡すのは**描いた結果ではなくデータ**にする |

---

## §7 決めたこと(裁定点)

### A. 拡張は「別の archetype」にしない

ランチャーのアプリ(HTML 添付)**そのもの**が拡張になる。⚠ 3 系統目の束ね方を
作らない(#348 の判断と同じ向き)。**「口を開けるか」は添付の設定 1 つ**で決まる。

### B. 既定は OFF。flag ではなく**そのアプリの設定**

⚠ **flag(15 枠)を使わない** ── これは「開発中の切替」ではなく
**user がアプリごとに決めること**である(正規設定と flag を分ける、user 指示 2026-07-30)。
🔑 ただし**面**は要る:どのアプリに口を開けたかを**設定の面で一覧**し、いつでも切れる。

### C. 段① は **projection の読みだけ**。書き戻しは段②

⚠ C-4 も同じ順で作った(段① は読みだけ、書きは許可の管理が揃ってから)。
**同じ順にする**(前例を割らない)。

### D. 拡張が受け取る `projection` の中身

**`listEntryMetas` が返すもの**(lid / title / archetype / 日付 / 印 / 大きさ)。
🔑 **新しい形を作らない** ── 常駐の集約がそのまま projection である。
⚠ **body は 1 バイトも入れない。**

---

## §8 段取り(#195 に置く)

| 段 | 中身 | 見積り |
|---|---|---|
| ① | 外殻 ↔ 本体タブの channel(BroadcastChannel)+ `projection` の押し出し + 設定の面 | M |
| ② | user のジェスチャで**実体を 1 件渡す**(deliver)── 情報ペインから「このアプリへ送る」 | M |
| ③ | 書き戻し(名前付き op / 全体拒否 / 帯に出す) | M |

⚠ 各段が**単独で着地し、単独で user に届く**(正本 doc §11 の規律)。

---

## §9 これが分かったら覆る

- **§4 の 3 段**:本体タブ以外から store を読める道が見つかったら、経路は短くなる
- **§7 A**:user が「拡張は別物として並べたい」と言ったら、archetype を分ける
- **§7 C**:段① を配って「読めるだけでは使えない」と分かったら、②③ を前倒しする
