# Office の保存先を PKC にする(#205 / #88 の O4・O5)── 2026-08-16

> 🔴 **user 指示 2026-08-16(不可侵)**:
> 「**全て PKC を動線にしたい / PKC をストレージとして使用するイメージです**」
>
> ⚠ **1 稿目はこれを読み違えた。** 「Office から見えるファイルシステムが PKC である」
> (= LO の中へ `/pkc` をマウントする)と読み、WORKERFS の焼き直しまで設計した。
> user の訂正(同日):
>
> > 「**新規作成時の保存のみを PKC のストレージに載せてしまい、それ以降は PKC 側から
> > 呼び出しをするイメージです**」
>
> 🔑 **開く動線は PKC が持つ**(いまの「添付を Office で開く」がそれ)。
> Office の中の Open ダイアログを PKC 化する必要は**無い**。
> ⚠ したがって **FS のマウントも焼き直しも要らない** ── 要るのは
> **保存の出口を PKC へ向けること**だけである。

## 0. 何を決めたいか

**Office で保存したものが PKC のノートとして残ること。** 開く側は PKC の一覧・フォルダが持つ
(いまの動線のまま)。⚠ ここで決めるのは**保存の出口**であって、Office の中の UI ではない。

## 1. 事実(実測。推測ではない)

### 1-1. いま保存は wasm の中で完結して消える

| 手 | 観測(2026-08-15、配布中と同版で 2 回) |
|---|---|
| Ctrl+S(新規文書) | LO 内蔵の Save ダイアログ。`Look in: /home/web_user`、ツリーは `Computer` と `web_user` **のみ** |
| Enter | MEMFS の木が 37 → 38 件。**`/home/web_user/Untitled 1.odt`(8,666 B)が出現** |
| Ctrl+Shift+S | 同じダイアログ・同じ行き先 |

🔴 **ブラウザのダウンロードの口はコードに無い** ── `showSaveFilePicker` / `showOpenFilePicker` は
`soffice.js` / `qtloader.js` / **`soffice.wasm` 本体**のいずれにも **0 件**
(空振り防止の対照群として `registrymodifications` / `web_user` は同じ grep でヒットする)。
→ **窓を閉じれば消える。**

### 1-2. PKC → Office の往路はコピー、復路は無い

```
IDB Blob → main.ts で Uint8Array 化(heap に載る)→ BroadcastChannel(構造化複製)
        → host.html が FS.writeFile('/work/<name>') → LO
```
復路は 1 本も無い。`planSaveBack`(純関数)は**呼び出し元 0 件**のまま全 test 緑だった。

### 1-3. 🔴 いまの一式に積んである FS は **MEMFS だけ**(2026-08-16 実測)

配布中の `soffice.js` を数えた:

| | 件数 |
|---|---|
| `MEMFS` | 1 |
| `WORKERFS` | **0** |
| `IDBFS` | **0** |
| `NODEFS` | **0** |
| `FS.mount` | 1 |
| `createLazyFile` | 1 |

🔑 **`FS` は JS から触れる**(`host.html` が既に `FS.writeFile('/work/…')` を呼んでいる)。
→ **JS 側で独自の FS を登録することは、焼き直さなくてもできる**(WORKERFS 自身も純 JS)。

### 1-4. ⚠ ただし FS の read は**同期**である

Emscripten の FS は `stream_ops.read` が同期。PKC の bytes は **IDB(非同期)**なので、
**そのままでは遅延読み込みができない**。WORKERFS が Blob を扱えるのは
`FileReaderSync` を使うからで、**それは worker の中でしか使えない**。

## 2. 何を作ればよいか(訂正後の範囲)

**保存の出口を PKC へ向ける。それだけ。**

| Office 側の操作 | PKC 側で起きるべきこと |
|---|---|
| 新規作成 → 保存 / 別名で保存 | **新しい添付ノートになる**(題名は LO が付けた file 名) |
| PKC から開いた添付 → 上書き保存 | **そのノートが更新される**(旧版は台帳に残す = 設計済みの案 B) |
| 開く | 🚫 **触らない** ── PKC の一覧・フォルダから開く(いまの動線) |

🚫 **やらないこと(1 稿目で設計してしまったもの)**:
- LO の中へ `/pkc` をマウントする(WORKERFS / 独自 FS / 全部 MEMFS へ載せる)
- そのための焼き直し

⚠ ただし §1-3・§1-4 の実測は**捨てない** ── 将来 LO の Open を PKC 化したくなったとき、
「**いまの一式には MEMFS しか無い**」「**FS は JS から触れるが read は同期**」は
そのまま出発点になる(同じ調査を 2 度やらないため残す)。

## 3. どうやって保存を捉えるか(#209 の方式監査で確定)

⚠ **この節は 2 度書き直している。** 1 稿目「transfer で親へ渡す」→ 2 稿目「polling +
IDB の Blob」→ 本稿。どちらも**測る前に書いた後条件**だった(CLAUDE.md §1)。
判定の全文は **#209**。

> **検知 = UNO の文書イベント / staging = OPFS に `Uint8Array` / 放送 = 鍵だけ /
> polling は使わない。**

### 3-1. 検知 ── FS hook(`FS.rename` + `FS.close`)

⚠ **#209 は「検知 = UNO の文書イベント」を選んだが、段 0 の probe で覆った**(2026-08-16)。
理由は綺麗さではなく **動かない** ── **listener を登録すると、保存のたびに窓が死ぬ**。

実測(known-good の pack、計 7 走):

| 走 | Ctrl+S | JS が呼ばれた |
|---|---|---|
| listener 無し(対照群) | ✅ 保存成功 | — |
| `unoObject` を作るが**登録しない** | ✅ 保存成功 | 0 |
| **登録する**(global / model / 新旧いずれも) | 🔴 **固まる(178 秒 復帰なし)** | **0** |

`Aborted(Assertion failed: invalid handle: 292)` / `RuntimeError: unreachable`。
🔑 裏方(`acquire` / `queryInterface`)の印は**登録時に 11 回・Ctrl+S 以降 0 回** ──
**abort は listener の中身ではなく、JS オブジェクトに手が届く前**に起きている。
🔑 装着自体は全段できており、**合成 broadcast は新旧 2 経路とも届く**(配達路は生きている)。
壊すのは「JS で UNO を実装したこと」ではなく「**listener として登録したこと**」。

🔴 **これで `invalid handle` の abort は 3 件目**である ── ① LO 側から
`QInputMethod::show()` を呼ぶ ② Qt の `update()` から `updateInputElement()` を呼ぶ(#156)
③ UNO listener の登録。**この一式では「LO のスレッド文脈から JS/embind のオブジェクトへ
触る」経路が全部死ぬ**(emval の handle 表は realm ごと)。設計の前提として残す。

**したがって FS hook を包む**(polling ではない):

- 包むのは **`FS.rename` と `FS.close` の 2 つ**。⚠ **両方要る** ── 実測で**形が違う**:
  - 既存 path の上書き: temp へ write → **`rename`** で置換
  - 新規保存: **最終 path へ直接 `write` + `close`**(rename ではない)
  - → `rename` だけ見ると**新規を落とし**、`close` だけ見ると**temp を拾う**
- 判定は **O(1)**: `/work` と `/home/web_user` の node を覚え、`stream.node.parent` の
  **ポインタ比較**。⚠ `FS.getPath` は木を遡るので使わない
- **静穏化して畳む**(最後の `close`/`rename` から ~300ms)── 同じ path に `close` が
  3〜4 回来るので、畳まないと **1 回の保存が 4 通の放送**になる
- ⚠ `.tmp` を除外。⚠ 名前は UI 言語で変わる(`--language=ja` なので `無題 1.odt` ──
  **非 ASCII + 空白**)
- 費用: boot 126 回で **上乗せ合計 1.57ms**、保存 1 回で 0.4〜0.7ms。⚠ hook の中は
  同期の軽い記録だけ(呼び元は pthread で syscall は main へ proxy = 重いと worker が止まる)

🔴 **`addDocumentEventListener` を製品コードに書かないことを test で pin する** ──
この結論をコードに残さないと、次に読む人が「UNO のほうが判定 0 個で綺麗」を根拠に戻す。

🚫 **1 秒 polling も採らない**(#209): 範囲の矛盾が原理的に解けない(既存 path は元の場所へ
書かれる)/ 定常コストが LO と同じスレッドに乗る(`PROXY_TO_PTHREAD = 0`)/ 前例 0 件。

### 3-2. staging ── OPFS に `Uint8Array`

🔴 **`Blob` を境界の向こうへ渡さない**(実測。32MiB を書いた直後に窓を閉じる):

| 経路 | chrome | headless_shell |
|---|---|---|
| IDB **Blob**(`tx.oncomplete` 待ち) | **ERR 4/4** | **ERR 3/3** |
| IDB **Uint8Array** | ok 4/4 | ok 3/3 |
| OPFS(`close()` 待ち) | ok 4/4 | ok 3/3 |
| BC で **Uint8Array** | ok 4/4 | ok 3/3 |
| BC で **Blob** | **ERR 4/4** | — |

🔑 **Blob は「後で bytes を出す」借用証書で、発行者が生きている間しか換金できない**
(Chromium の正体は `ERR_SOURCE_DIED_IN_TRANSIT`。256,000 B 以下は IPC 同梱なので落ちない
= **サイズで挙動が変わる**)。
⚠ **`tx.oncomplete` は bytes 耐久化の証拠にならない**(Blob 値のとき)。

⚠ **2 稿目の「BroadcastChannel は黙ってコピーするから危ない」も誤り** ──
**その黙ったコピーこそが安全性の正体**である(送信側が生きている瞬間に済む)。
🚫 **BC を避ける理由に「bytes が壊れる」を使わない。**

**OPFS を選ぶ理由は耐久性ではなく、常駐メモリの形だけ** ── slice 単位で書けるので
ピークが平ら(IDB は 1 個の値として渡すので structured clone でもう 1 部要る)。
🔑 **覆る条件**: 扱う文書が十分小さいと決まる / Safari の `createWritable` が使えない
→ **IDB + `Uint8Array` のほうが単純で同じだけ安全**(技術が 1 つ減る)。

### 3-3. staging が「あった方がよい中継」ではなく必須である理由

**sqlite の `assets` 行を書けるのは writer リース保持タブだけ**(SAHPool は実質単一接続。
`writer-lease.ts`)。**LO の窓は絶対に書けない** → bytes を LO 窓が置き、meta を
リース保持タブが確定させる、**2 相コミットの staging** である。
⚠ **この理由を定義の隣に書く**(書かないと次に読む人が「ただの中継」と読んで消す)。

### 3-4. 守る境界(乗り換えを安くする保険。全文は #209)

- **B1** 「保存をどう検知したか」を **1 module に閉じ**、外へ出す型は
  `{ path, name, bytes: Uint8Array }` **だけ**。⚠ `Module` / `FS` / UNO の型を 1 つも外へ出さない
- **B2** 「staged bytes がどこに居るか」を 1 module に閉じ、`stage` / `drain` / `discard` だけ公開
- **B3** 🔴 realm または寿命の境界を越える bytes は**必ず `Uint8Array`**
- **B4** staging の存在理由(writer リース)を定義の隣に書く
- **B5** drain は**冪等**、入口は 3 つ(鍵の放送 / 窓が閉じた / **起動時**)
  → 取りこぼしが**遅延にしか**ならない
- **B6** bytes は sqlite worker に通さない
- **B7** 「user の文書か」の判定を**本番に 0 個**にする

### 3-5. どのノートへ戻すか

🔑 **開いたときに覚え、窓に預けて返させる** ── いま `office-open.ts` は `assetKey` を
その場で捨てている。⚠ 窓は `noopener` で handle が無く、**PKC タブを再読込すると
対応表が消える**(窓は別 process なので生き残る)。だから**親の記憶に依存しない**形にする。
⚠ token 無しの保存が来たら**新規の添付ノート**として扱う(新規作成と同じ道)。

## 4. 段階(#205 にぶら下げる)

| 段 | 中身 | 量 |
|---|---|---|
| **0** | 🔴 **UNO の probe 1 本**(`documentEventOccured` が実際に呼ばれるか)── 実装より先 | S |
| **A** | 検知(UNO の購読)+ staging(OPFS へ `Uint8Array`)+ 鍵の放送 | M |
| **B** | 受け手の配線 + token → ノートの解決。⚠ `degraded` の取りこぼしも同時に直す | M |
| **C** | 既存添付の更新(`planSaveBack` を effect へ繋ぐ ── 純関数は既存) | M |
| **D** | 新規作成 → 新しい添付ノート(`attachOne` を切り出して再利用) | S〜M |
| **E** | 版の台帳の面(純関数は既存、UI が 0 件) | L |
| **F** | お知らせ・マニュアル・R6 の記述訂正 | S |

⚠ **焼き直しは要らない**(UNO も FS も配布物に在る)。

## 5. 危ないところ

1. **放送は全タブに届く** ── holder(writer リース保持タブ)だけが引き取る +
   **staging の claim を 1 トランザクション**にして、二重に塞ぐ
2. **`host.html` は bundle されないので unit が 1 件も届かない**。⚠ ただし判断を素の JS へ
   出せば unit は届き、偽 pack の stub に `readdir`/`stat` を足せば **smoke も走る**。
   実 LO の probe が要るのは「**本当に拾えるか**」の 1 点だけ
3. **観測点**は「放送を出した」ではなく「**添付の key が変わり、本文の `asset:` が
   新しい key を指した**」まで見る(`planSaveBack` が 0 呼び出しで 2,000+ tests 緑だった前例)
4. **窓の使い回し**(`location.replace`)は**未保存を無警告で捨てる** ── 書き戻しを足すと
   「読み物を差し替えた」から「**編集を捨てた**」へ意味が変わる
5. 🔴 **窓が drain 途中で閉じると staging に孤児が残る** ── 債務ではなく**恒久的な運用条件**。
   起動時 sweep で吸収する(B5)

## 6. 隣の話(別 issue)

> 🔑 user 指示 2026-08-16:「**面倒なのが PKC 側のフォルダ動線なので、そこら辺の補強は
> 必要だと思います / 部分ワークスペースをローカルの FSA をアタッチするような VSCode じみた
> 操作はできませんが、そういうこともしたいな**」

**開く側が PKC の責務になる**以上、フォルダの動線が弱いと保存の出口を直しても使いにくいままである。
⚠ ただし**この doc の範囲ではない** ── 別 issue で扱う(将来の向きとして
「ローカル FS を部分ワークスペースとして attach する」も記録する)。

## 7. 参照

- 実測と経路の全数: #205
- 保存の設計(既存。⚠ `:202` の「実装済み」は誤り): `office-save-back-design-2026-08.md`
- ⚠ 逃げ道 R6「LO の別名保存で端末へ書き出し」は**成立しない**(§1-1):
  `office-wasm-integration-design-2026-08.md:189-195` は訂正が要る
