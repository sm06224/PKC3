# P7: v3.0.0 ── Pages プロダクト版 + PWA 仕上げ

> **status**: **裁定済み・実装 go**
> **裁定**: user「あなたが良いと思う方で良いです / とても良い提案です」(2026-08-02)
> ── §5 の 4 点は Claude 判断に委任。採った側を §5 に記録
> **前提**: P6 完了(#34〜#48)。取込・書出し・履歴の復元まで着地済み
> **正本**: `pkc3-major-upgrade-design-2026-07.md` §8(配信)/ §11(段階表の P7)

## 0. いま何が「宣言だけ」になっているか

P1 で骨格を置いたまま P7 まで来たので、**宣言はあるが実体が無い**ものが 3 つある。
これは P6f で潰したのと同じ構図(`file_handlers` を宣言しながら受け口が無い =
manifest が嘘をついている)なので、まずここを列挙する。

| # | 宣言 | 実体 | いま user に起きること |
|---|---|---|---|
| 1 | `manifest.webmanifest` の `file_handlers`(`.md` / `.markdown`) | **`launchQueue` を読むコードがゼロ** | md をダブルクリックすると PKC3 が起動して**何も起きない**(空のアプリが開く) |
| 2 | `sw.js` を登録している | `fetch` が pass-through | **オフラインで一切動かない**。PWA として install できるのに、機内モードで開くと白紙 |
| 3 | Pages の product URL | 初回 release が無く placeholder | `/` が placeholder のまま |

⚠ 1 と 2 は「install できてしまう」ぶん、**何も無いより悪い**。
install した user は「オフラインで使える」「md を開ける」と期待する。

---

## 1. 🔴 素の `.md` を受ける経路が無い(1 の前提)

`file_handlers` を実装するには「md を 1 件受け取って entry にする」経路が要る。
いまの取込は **PKC2 形式の 8 種だけ**で、素の markdown の受理器は無い。

- `detect-format.ts` は `pkc2-*` の manifest / slot を見て判別する ── md は「不明」で断られる
- P6d 段④ で **書き出す**側(md ZIP)は作ったが、**読む**側は作っていない

### 提案: `readPlainMarkdown`(受理器 1 個)

| 決めごと | 内容 |
|---|---|
| 題名 | frontmatter の `title` → 先頭 `# 見出し` → ファイル名(拡張子を落とす)の順 |
| archetype | frontmatter の `archetype` があれば採用(白名単のみ)、無ければ `text` |
| 本文 | **原文のまま**(frontmatter も含めて丸ごと)。⚠ 再構築しない ── P6d 段④ で踏んだ規律 |
| 添付 | 相対パス参照(`assets/…`)は**解決しない**。単一 md は添付を持ってこないので、参照は原文のまま残し「画像は含まれていません」と件数で言う |
| 複数選択 | `launchQueue` は複数ファイルを渡せる ── 1 件ずつ entry を作る |

🔑 **md ZIP の逆ではない**。md ZIP は「フォルダごと」だが、これは「1 ファイル」。
フォルダ取込(`assets/` の解決込み)は**別の段**にする ── 混ぜると
「どっちの経路で壊れたか」が分からなくなる。

---

## 2. Service Worker の cache 戦略

### 2-1. 何を precache するか

現状のビルド生成物:

| ファイル | サイズ | precache |
|---|---|---|
| `index.html` | 0.5KB | ✅ |
| `manifest.webmanifest` / `icon.svg` | 0.8KB | ✅ |
| `assets/index-*.js` | 304KB | ✅ |
| `assets/sqlite3-*.wasm` | 848KB | ✅ **必須**(無いと storage が起動しない) |
| `assets/storage-worker-*.js` | 228KB | ✅ |
| `assets/sqlite3-worker1-*.js` | 208KB | ✅ |
| `assets/sqlite3-opfs-async-proxy-*.js` | 32KB | ✅ |
| `assets/*.js.map` | **3.2MB** | ❌ 論外 |

→ precache 合計 **約 1.6MB**。

🔴 **`.map` を product で配るのをやめる**。いま `vite.config.ts` は `sourcemap: true` 固定で、
**生成物の 3.2MB(全体の 2/3)が map**。dev 版では要るが product では要らない
── 「速く、安く」に真っ向から反する。`VITE_PKC_KIND` で切り分ける。

### 2-2. 戦略

- **precache**: build 時にファイル一覧を SW へ焼き込む(Vite plugin で生成)。
  ⚠ 手書きの一覧は**必ず腐る** ── ハッシュ付きファイル名なので、
  ビルドのたびに変わる。生成しない選択肢は無い
- **navigation**: network-first → 失敗したら cache。
  ⚠ cache-first にすると**新しい版が永久に届かない**(PWA の定番事故)
- **assets(ハッシュ付き)**: cache-first。名前が変われば別 URL なので陳腐化しない
- **cache 名に build id を入れ、activate で古い cache を消す**。
  ⚠ 消さないと OPFS とは別に**ブラウザの cache が無限に積み上がる**

### 2-3. 🔴 更新の届き方を user に見せる

新しい版を precache し終えたら「新しい版があります(再読込)」と出す。
⚠ **黙って次回起動で切り替える**のは避ける ── 「直したはずのバグが直っていない」
という報告の原因になり、こちらからは再現できない。

🔴 **黙って*今すぐ*切り替えるのはもっと悪い**(段⑤ で判明)。`install` で
`skipWaiting()` を呼ぶと、user が何もしていないのに `activate` が走って
**旧 build の cache がその場で消える** ── 開いたままの旧タブが後から旧 hash の
chunk を取りに行く経路で取り零す(Pages は deploy でツリーごと差し替わるので、
消えた cache の先に実体も無い)。交代は **user が押したときだけ**。
そして **押したタブだけ**を再読込する(`clients.claim()` は全タブに
`controllerchange` を投げるので、無条件に再読込すると別タブの下書きを巻き込む)。

---

## 3. 検証(何をどう確かめるか)

| 対象 | 見方 |
|---|---|
| オフライン | smoke で `context.setOffline(true)` → reload → **entry が読める**ところまで。⚠ 「SW が登録された」で止めない ── 登録されていても cache が空なら白紙 |
| md ハンドラ | `launchQueue` は実ブラウザの install が要るので smoke では直接踏めない。**受け口の関数を直接呼ぶ** unit + 「manifest の宣言と受け口の存在が一致する」parity test |
| precache 一覧 | **生成物と一致するか**を build 後に検査(手書きに退化したら落ちる) |
| `.map` を配らない | product ビルドの生成物に `.map` が無いことを assert |

🔑 parity test の形は P6f で確立したもの ──
**「manifest が宣言する拡張子は、受理器が実際に受ける」**を規則そのものに対して assert する。
宣言と実体がずれる事故は、この期間だけで 2 回起きている。

---

## 4. 段取り(各段が単独で着地)

| 段 | 内容 | なぜこの順か |
|---|---|---|
| ① | ✅ **product ビルドから `.map` を外す** + size の tripwire を Pages 用に読み替え | 1 行に近く、以降の全計測の前提が変わる |
| ② | ✅ **素の md 受理器**(`readPlainMarkdown`)+ 取込導線 | ③ の前提。単体で価値がある(md を drag&drop できる) |
| ③ | ✅ **`launchQueue` の受け口** ── 宣言と実体を一致させる | ② が無いと書けない |
| ④ | ✅ **SW の precache**(生成 + navigation network-first + 旧 cache 掃除)+ オフライン smoke | 独立 |
| ⑤ | ✅ **更新通知**(新しい版があります) | ④ の上 |
| ⑥ | ✅ **マニュアル + 移行ガイド**(PKC2 → PKC3) | 実装が固まってから書く |
| ⑦ | 🟡 **v3.0.0 release**(SBOM 添付は既存、provenance attestation を足す)→ product URL 稼働 | 最後。**仕込みは完了・tag は user の go 待ち** |
| ⑧ | ✅ **レビューで「範囲外」として残した露出を塞ぐ** | ⑤〜⑦ の積み残し |

⚠ ⑥ は「実装が固まってから」。先に書くと**嘘のマニュアル**になる。

### 段① 実装記録(2026-08-02 着地)

| kind | ファイル | 配る量 | map |
|---|---|---|---|
| product | 9 件 | **1610.9 KB** | 0 件 / 0.0 KB |
| dev | 12 件 | 1611.1 KB | 3 件 / **3227.3 KB** |

🔑 **配る量の差は 0.2 KB しかない**。捨てたのは product の配信量 3.2MB だけで、
調査手段(`/dev/` の map)は 1 バイトも失っていない。

⚠ **「差は `sourceMappingURL` の行だけ」ではない**(レビュー M-1 → L-1 で実測、
当初の記述は誤り)。`BUILD_KIND`(`import.meta.env.VITE_PKC_KIND`)が bundle に
焼き込まれるので、**entry chunk だけが別物**になる:

| 生成物 | dev | product | 中身 |
|---|---|---|---|
| entry chunk | `index-BBeB4SpM.js` 308,519 B | `index-BR29g7kI.js` 308,492 B | **別**(下記) |
| `storage-worker-BlwWKbLI.js` | 231,638 B | 231,586 B | map コメントを除けば**完全一致** |
| `sqlite3-worker1-d88FnpHp.js` | 210,772 B | 210,719 B | 同上 |
| `sqlite3-opfs-async-proxy-D_xnb1D8.js` | 32,289 B | 32,289 B | 同上 |
| `sqlite3-BVKGSWc-.wasm` | 864,752 B | 864,752 B | 完全一致 |

entry chunk の内訳: dev は末尾に `sourceMappingURL` 行 43 B を持ち、コード部は
**product のほうが 16 B 長い**(刻印 `` `product` `` のぶん)。content hash が変わるので
**file 名も別**になる ── worker 3 本と wasm は kind をまたいで同名・同内容である。

🔴 **product のスタックトレースを dev の map で読み替えることはできない**。理由は
「カラムが十数ずれる」ではなく(bundle は 1 行ではなく 198 行、大半のマーカーは
ズレ 0)、**縮小識別子の付番が丸ごとずれる**こと ── 刻印が 1 個増えた結果
`i={frontmatter:…}` が `i=\`product\`,a={frontmatter:…}` になり、**198 行中 71 行**が別物になる。
運用は「**`/dev/` の URL で再現してもらい、dev 自身の map で読む**」であって、
「product の trace を dev の map に流し込む」ではない。

🔑 それでも **PR gate に product ビルドを足さない**根拠は成立する ── 根拠は
「同じコードだから」ではなく「**配る量が kind でほぼ変わらない(0.2 KB 差)から
cap の tripwire は dev ビルド 1 回で効く**」である(CI を長くしない・user 指示 2026-07-30)。

⚠ ただし **product bundle は PR gate が一度もビルドしない別成果物**になる。
Pages の `/` に出るのはこちらなので、**nightly でビルド → 検品 → smoke** まで通す。

検査は 2 段構え ──
`tests/build-config.test.ts` が **config の意図**を、`scripts/check-dist.mjs` が
**実物のファイル一覧と中身**を見る。plugin が map を足す経路は config を読んでも分からない。

### 🔴 検査そのものが空振りしていた ── **2 ラウンドとも**

| 巡 | 空振りしていた検査 | 何に救われていたか | 実証 |
|---|---|---|---|
| 1 | `walk` が sub dir へ降りない変異 | ── | 配る量 1.7 KB・map 0 件で **product 側が全部通った** |
| 1 | 「entry の `.js` が 1 件でもある」 | `sw.js`(public の静的コピー) | `rm dist/assets/index-*.js` しても **`✓ ok`** |
| 2 | 「index.html の `./` 参照」 | `manifest.webmanifest` / `icon.svg`(Vite が書き換えない `public/` 静的参照) | `--base /` でビルドすると entry が `/assets/…` になり走査対象外 → **entry を消しても `✓ ok`** |
| 2 | cap(上限)だけを見る | ── | entry chunk を **0 バイト**にしても `✓ ok`(取り違えは**縮む方向**にも起きる) |

🔑 **救い手が変わっただけだった。** 1 巡目の教訓「それらしいファイルが在るかで書かない」を
守った結果が 2 巡目の穴で、**空振り防止のガード自体が代替物に満たされていた**
(「参照が 1 件でもあるか」は `public/` の静的参照で満たせる)。

いまの形:
- **前方** ── index.html が指す先 / bundle が `new URL(…)` などで名指しする生成物が実在するか
- **後方** ── hash 付き生成物のうち**誰からも参照されていない**ものが無いか
- **空振りガード** ── index.html が **hash 付き生成物**を 1 つも参照していなければ落とす
  (`public/` の静的参照では満たせない)
- **下限** ── 0 バイトの出荷物 / 配る量が床を割ったら落とす

### 🔴 参照は「形」ではなく「構文」で拾う ── 誤検知は release を偽の理由で止める

「hash らしき 8 文字 + `.js`」という**形**で拾う実装は、出荷 bundle の**コメントや
API 名の中に既にある**名前を誤検知した(実証済み: `sqlite3-vfs-opfs.js` /
`sqlite3-worker1-promiser.js` / `markdown-it-footnote.js` ── いずれも実在)。
上流のコメント整形ひとつで Pages deploy が止まる。

→ `new URL(…)` / `import(…)` / `from …` の中の文字列リテラルだけを見る。さらに
**場所で受け方を変える**:

| 場所 | 規則 | 理由 |
|---|---|---|
| HTML 属性 / manifest の JSON field | 緩く(外部 URL と拡張子だけ見る) | 構造化されていて散文が混じらない |
| コードの中 | 狭く(`./` `../` `/` 始まりか hash 付き名のみ) | 散文が混じる ── 実物に `` …invoked from`,`client-level… `` がある |

⚠ **片方の規則をもう片方に流用しない**(CLAUDE.md「誤差の向きを決めて、両側に使い回さない」)。

### 🔴 件数を数える検査は、埋め込まれた実体を見落とす

`--sourcemap inline` は `.map` を 1 件も出さない ── 4.3MB の base64 map を出荷しながら
script は「map 0 件」と報告した(レビュー M-2 で実証)。しかも落ちたのは size cap の枝で、
その文言は **「cap を引き上げてよい」という誤った処方**を出していた。
`sourceMappingURL=data:` を中身から探し、inline も map として数える。

### 🔴 shell の `&&` と `||` は同順位・左結合

`pages.yml` の product 検品を `[ -f X ] && node X || true` と書いていた。これは
`(([ -f X ] && node X) || true)` と解釈され、**「script が無いとき」ではなく
「検品が失敗したとき」も飛ばす**。実証: 検品が `✗ product に map が 3 件ある` を
出した直後に `cp -r ../product/dist/. _site/` へ到達し、**step は exit 0**
── map 3.2MB を載せたまま Pages `/` に deploy されて job は green になる。
`if [ -f X ]; then node X; fi` と書く。

### 段② 実装記録(2026-08-02 着地)

`src/features/import/plain-markdown.ts`(純関数)+ `import-markdown.ts`(書込)+
`import-file.ts`(振り分け)。既存の PKC2 経路には**合流させていない** ──
1 ファイル = 1 entry で、asset / relation / 履歴には触らない。

🔴 **拡張子で決める。中身では決めない。** どんなテキストも markdown として妥当なので、
中身判定は必ず誤る。`file_handlers` も拡張子で宣言しているので、**宣言と実体を
同じ規則で揃える**のが要点である。parity test は両方向で縛った ──
「manifest が宣言する拡張子を受理器が受ける」だけでなく
「受理器が受ける拡張子を manifest が宣言している」も見る(片側だけだと
**file_handlers から開けないのに受理器だけが対応している**状態が通る)。

⚠ **変異試験で 2 件生き残り、どちらも fixture のゼロ次元だった**:

| 生き残った変異 | 何が測られていなかったか |
|---|---|
| 拡張子ではなく MIME で振り分ける | fixture が全部 `text/markdown` を持っていた ── 実機の OS ピッカーと `launchQueue` は `.md` に **MIME を付けない**ことが多く、そのままだと実機だけ PKC2 経路に落ちて断られる |
| 抽出列(status / date / archived)を殺す | assert が「`undefined` ではない」だった ── `null` を素通しする実装でも通る |

前者は smoke でも `mimeType: ''` で渡している(ここを `text/markdown` で埋めると
「MIME で振り分ける」実装でも緑になる)。

#### 🔴 レビューで 4 件 ── うち 1 件は「この受理器の中心規則が丸ごと死んでいた」

| # | 何が壊れていたか | 実証 |
|---|---|---|
| H-1 | **CRLF の md では「先頭見出しを題名にする」規則が死んでいた**。`split('\n')` が残す `\r` に `.` も `$` もマッチしないため、`# 見出し\r` は**どうやってもマッチしない** | `# 会議メモ\r\n…` → 題名がファイル名 `2026-08-02` に落ちる。Windows / `autocrlf` の md 全部 |
| M-1 | 閉じフェンスの**長さ**を見ていなかった(1 文字比較)── CommonMark は「閉じは開き以上」 | ```` で開いて ``` で閉じる文書(= markdown を説明する文書)で**コードブロックの中の見出しが題名になった** |
| M-2 | archetype の白名単が「**フレーバー登録の有無**」だった | `folder` / `generic` / `opaque` は一級の archetype なのにフレーバーが text fallback → **自分の md ZIP export を取り込み直すとフォルダがノートに化け**、事実に反する「未知」注意が出た |
| M-3 | 未解決参照の走査が**両方向に外れて**いた | 参照形式リンク・HTML `<img>` を**取りこぼし**(= 黙って画像が壊れる側)、fence / 行内コード / エスケープの中を**数えて**嘘の警告 |

🔑 **H-1 が見逃されていた理由が本質的**。CRLF の test は書いてあったが、
**frontmatter 付き**の入力だった ── `parseFrontmatter` が body の CRLF を LF に
正規化して**救ってしまう**。「CRLF を試した」という外見だけがあって、
**壊れている側(frontmatter 無し + CRLF)は一度も通っていなかった**。
fixture のゼロ次元は、こういう形でも生じる。

🔑 M-1 / M-3 は**同じ判定が 2 か所に生えていた**ことが原因なので、
`features/markdown/link-scan.ts` に規則を 1 本に寄せた(CLAUDE.md)。
書出し側(`export/pkc3-markdown-zip.ts`)の走査 ── fence の長さ・3 スペース字下げの
閉じ・行内コードが空行を越えない・`\]` エスケープ ── は**元から正しかった**ので、
そちらを共有基盤にして取込側が乗る形にしている。役割分担は
「**どこが宛先か**は共有、**その宛先をどうするか**は consumer が狭く決める」。

⚠ 寄せた副産物として、**書出し側の穴も 1 つ塞がった**: 参照形式リンク
(`[y]: asset:k`)と HTML の `src` は `](…)` ではないので書き換えられず、
**添付は ZIP に入るのにリンクだけ `asset:` のまま残って**いた(外では開けない)。

#### 🔴 走査が O(n²) だった + 行末を `\n` だけで見ていた(user 指摘)

> 「split で `\n` って、大丈夫? 他の改行コードとかバッファ食い過ぎたりとか」

両方とも実在した。**測ってから**直した(3MB の md、行内コードの多い本文):

| | 前 | 後 |
|---|---|---|
| `scanLinks`(行内コード多め 3MB) | **74,762 ms** | **53 ms** |
| `firstHeading`(見出しが先頭 3MB) | 214 ms | 3.7 ms |
| `firstHeading`(CR のみ 3MB) | 見出しを拾えない | 3.8 ms で拾う |

原因は 2 つ:
1. **`text.slice(i)` を位置ごとに作って `^` で当てていた** ── 残り全体のコピーが
   毎回走る。sticky(`y`)正規表現 + `lastIndex` に置換
2. **空行探索(`indexOf('\n\n', i)`)を毎回やり直していた** ── 空行の無い本文では
   バッククォート 1 個ごとに残り全体を舐める。`i` は単調前進なのでキャッシュできる。
   ⚠ **この 2 番目は元の書出し側にも同型で在った**(走査を 1 本に寄せたので同時に直った)

`firstHeading` は `split('\n')` で**全行を配列にしてから 1 行目を見て**いた ──
見出しは普通いちばん上にあるので、行境界を都度探して見つけ次第抜ける形にした。

**行末は `\n` だけではない。** CommonMark の line ending は `\n` / `\r` / `\r\n` の 3 つで、
markdown-it も `\r\n?` を `\n` に正規化してから parse する ── ここで `\n` だけを見ると
**描画は正しいのに走査だけがずれる**(fence の中を書き換える / 見出しを拾えない)。
`firstHeading` の行分割・`scanLinks` の行頭判定・閉じ fence・空行判定を 3 種すべてに対応させた。

⚠ 退行の tripwire として、1MB を 3 秒以内で走査する test を置いた
(絶対値ではなく**桁**を見る ── O(n²) に戻れば秒オーダーになる)。

導線側で直したもの: ボタンの名前が「PKC2 を取込」のままだと**実態と食い違う**ので
「取込」に、`accept` に `.md` / `.markdown` を追加(⚠ ここが無いと**受理器が動いても
ファイルを選べない**)、`multiple` を有効化(md は複数選択 = 1 件ずつ entry)。
混在(md + PKC2)と PKC2 の複数選択は**断る** ── 「md だけ入って PKC2 が黙って
落ちた」を作らない。

### 段③ 実装記録(2026-08-02 着地)

`adapter/platform/launch-queue.ts`(受け口)+ `main.ts` の配線。
OS から md をダブルクリック → `window.launchQueue` → **段② の取込規則**へ流す。

🔴 **受け口は `startApp` の解決後に張る。** ⚠ 当初「`await` より前に張らないと
取りこぼす」と書いて自前バッファを持ったが、**仕様の読み違いだった**(review H3):

> LaunchParams are **buffered indefinitely** until they are consumed. Crucially, if any
> LaunchParams are buffered into a LaunchQueue **before** a call to `setConsumer()`, they
> will be **immediately passed into the consumer afterwards**.
> ── [WICG/web-app-launch](https://github.com/WICG/web-app-launch/blob/main/launch_handler.md)

ブラウザが既に無期限にバッファしている。早く張って自前バッファへ吸い出すと、
**取りこぼしの責任がブラウザからアプリへ移る**だけで、boot が失敗すればファイルは
消える(再読込でも戻らない)。自前バッファ(約 40 行 + その test)を捨てた。

🔑 **受け口は配線だけを持つ。** 何を受けるか(拡張子)も、どう entry にするかも
`import-file.ts` / `plain-markdown.ts` がすでに規則を持っている ── 受け口が独自の
判定を持つと、宣言と実体がまた 3 つに割れる。返り値の `AppHandle.importFiles` は
**binder に配ったものと同じ関数**である(2 経路にしない)。

parity は 3 者で縛った ── manifest の `accept` / `MARKDOWN_EXTENSIONS` / 受け口を
通って届くファイル。`action` が `./` であること(別 URL を開くと受け口に届かない)も見る。

#### 🔴 レビューで設計ごと 3 件 ── 「断る」がデータ消失だった

| # | 何が壊れていたか | 実証 |
|---|---|---|
| H1 | **配線が丸ごと無防備**。`launch.deliverTo(app.importFiles)` を消しても **918/918 green** ── 機能が production で死んでいても PR gate は緑 | 変異で実証 |
| H2 | **編集中・整理中の launch でファイルが失われる**。OS の launch は**一発限り**で picker が出ないのに「もう一度選び直してください」と断っていた | 実 `importFiles` を繋ぐと `written = ["一通目"]`、二通目は消えた |
| H3 | 「await より前に張らないと取りこぼす」は**仕様に反する** ── ブラウザが無期限にバッファしている | 仕様文(上記)|

対処:
- **断らない経路を用意した** ── `whenPhaseReady`(ready まで待つ)+ `AssetGate.queued`
  (断らずに順番待ち)。⚠ **user のクリック起点は今までどおり断る**(選び直せるので、
  待たされるより「いま整理中です」の方が分かる)。取込の**本体は 1 本**のまま
  (`runImport`)── 2 本に分けると片方だけ直す事故が必ず起きる
- **配線をソース本文で pin した**。`bootstrap()` は実 storage と実 window を要求し、
  PWA を install した実ブラウザも CI に無いので、実行 test では守れない。
  形の検査は脆いが**無検査よりは事故の桁を止める**(size cap と同じ位置づけ)──
  「受け口を張っているか」「断らない版を渡しているか」「`startApp` の**後**か」の 3 点
- **`launch_handler: focus-existing` を宣言した**(review M-5)。未宣言だと既定は
  `auto` = UA 任せで、desktop は新 window を作りうる ── その window は
  `acquireWriterLease` の Web Lock を取れず「別のタブで開いています…」のまま止まり、
  **ファイルはそこで死ぬ**
- フォルダ handle を**アプリの言葉で**断る(仕様の `files` は `FileSystemHandle[]`。
  そのまま `getFile()` を呼ぶと `getFile is not a function` が user に出る)
- `setConsumer` が投げても boot を道連れにしない(投げると「起動に失敗しました」の
  表示にすら到達せず**白画面**になる)

⚠ 変異試験は 2 巡で計 30 件・最終生存 0。1 巡目の 3 件は**すべて「重ねたガード」**で、
`flush()` 側の同じ判定に救われていた ── 消しても誰も気づかない枝なので削った。
2 巡目は「`phase` を見ずに解決する」が生き残った ── 編集中の**打鍵ひとつ**で
取込が走って draft を壊す変異で、「編集を終えたら流れる」だけを見る test では
救われていた(状態変化が 1 回しか起きない fixture だった)。

### 段④ 実装記録(2026-08-03 着地)

`src/adapter/platform/sw/sw-source.ts`(SW の中身を作る純関数)+ `build/sw-plugin.ts`
(生成物の一覧を集めて `sw.js` を出す Vite plugin)。手書きの `public/sw.js` は削除。

🔑 **規則の写しを 2 つ持たない**。SW は別の実行文脈なのでアプリの module を import
できないが、かといって手書きの一覧は**必ず腐る**(hash 付き名はビルドのたびに変わる)。
文字列を返す純関数にして、**test は生成した文字列を実際に評価する**(偽の worker
global の上で `install` / `activate` / `fetch` を発火させ、どの Response が返るかを見る)
── 文字列一致で見ると「それらしい形」に救われる。

#### 🔴 単体は全部緑なのに、実ブラウザだけ白紙になった

オフライン smoke を書いたら**落ちた**。原因は `Vary`:

- precache は `addAll` で入るので request に **`Origin` が無い**
- 実際の module script は `crossorigin` 付きで **`Origin` を送る**
- 応答が `Vary: Origin` を持つと(`vite preview` が実際に付ける)照合が外れる

→ `caches.match(req, { ignoreVary: true })`。**stub にも `Vary` の意味論を入れて**
unit で pin した(入れないと、実機でしか壊れない形を test で作れない)。

⚠ この形は「オフラインで entry が読めるところまで見る」smoke が無ければ
**発見できなかった** ── 「SW が登録された」で止めていたら緑のまま出荷していた。

#### そのほか踏んだもの

- **テンプレートの中でバッククォートを書かない**。生成ソースはテンプレートリテラル
  なので、コメント 1 個のバッククォートが**文字列を閉じ**、config の読込ごと落ちる
- **`sw.js` の一覧が生成物と一致するか**を `check-dist.mjs` が突合する
  (doc §3 の「手書きに退化したら落ちる」)。⚠ 生成器が空を吐いても**それ自体は
  誰も気づかない** ── plugin の一覧を空にする変異は unit を全部素通りし、
  この突合だけが捕まえた
- **stderr 0 行の規律**で 1 件 ── Vite の native config loader が拡張子なし import に
  警告を出していた。隠さず `allowImportingTsExtensions` で原因を消した

変異試験 19 件・生存 0(SW 13 / 検品 5 / plugin 1)。

#### レビュー指摘の反映(H-1 / H-2 / M-1〜M-3)

| # | 何が壊れていたか | どう直したか |
|---|---|---|
| H-1 | **CacheStorage は origin 単位で、scope 単位ではない**。`/`(product)と `/dev/` は同じ origin にあるので、前置きだけで「自分以外」を消すと**別 scope の precache まで消える** ── `/` を 1 回開いただけで `/dev/` がオフラインで開かなくなる | cache 名を `pkc3:<scope>:<build>` にして**欄で比較**。⚠ `/` は `/dev/` の接頭辞なので `startsWith` では分けられない。実ブラウザで実証: ① `/dev/` 起動後 `{"pkc3:%2Fdev%2F:…":8}` ② `/` も起動後は両方在る ③ オフラインで `/dev/` が `ready` |
| H-2 | オフライン smoke が**オフラインを作れていなかった**。`context.setOffline(true)` は**ページ由来の要求しか止めない** ── SW 自身の `fetch()` は素通りするので、precache から `.wasm` を外す変異が**緑のまま通った** | `context.route('**/*', (r) => r.abort('internetdisconnected'))`。同じ変異が**落ちる**ことを確認 |
| M-1 | build id が `GITHUB_SHA` だった ── product のバイト列が 1 バイトも変わらなくても main への push のたびに `sw.js` が変わり、**全 user が 1.6MB を再取得して再 precache**(北極星「速く、安く」に直接反する) | **配る物の一覧から**作る(`buildIdFor`)。precache 一覧は hash 付き名を含むので「一覧が同じ = 配る物が同じ」。実証: `GITHUB_SHA` を変えた 2 回のビルドで `sw.js` の md5 が一致 |
| M-2 | その `buildIdFor` を誰も pin していない | `vite.config.ts` から export し `tests/build-config.test.ts` が性質(順序非依存 / 一覧が変われば変わる / 環境変数に依らない)を pin |
| M-3 | `public/` の静的 file が precache から漏れる | plugin が `configResolved` で `publicDir` を捕まえ、再帰列挙して一覧に足す。`public/robots.txt` を置いて突合まで通ることを確認 |

#### 🔴 2 ラウンド目の変異試験で見つけた「stub が実装より緩い」

`caches.match(req, { cacheName })` を、fake の `caches` が**無視して全 cache を舐めて**
いた。本物は **その cache だけ**を見て、無ければ `undefined` を返す ── stub が緩い分だけ
「自分の cache 以外は覗かない」test は `cacheName` の有無を**一切見分けられず**、
空振りしていた。本物の意味論に合わせたら、`MATCH` から `cacheName` を外す変異が落ちる。

もう 1 件、**前置き検査が別の検査に救われて**いた。他人の cache を表す fixture が
`someone-else`(欄が足りず長さ検査に救われる)と `other:%2F:old`(scope 欄がずれて
救われる)しか無く、**前置き検査を丸ごと外しても両方 pass した**。前置きは 5 文字なので、
撃ち抜けるのは「**同じ長さの別前置き + 自分と同形の後ろ**」だけ ── `pkc2:%2F:old` を
足した(同 origin の兄弟 product という、実際に在りうる形でもある)。

2 ラウンド目の変異試験 16 件・生存 0(SW 純関数 4 / 生成 SW 7 / precache 規則 2 / build 設定 3)。

### 段⑤ 実装記録(2026-08-03 着地)

`src/adapter/platform/sw/update-prompt.ts`(いつ案内を出すか)+
`src/adapter/ui/render/update-card.ts`(面と、押されたときの動き)+
SW 側の `message` 受け口。

#### 🔴 自動で交代させない ── 交代は**旧 build の cache を消す**

段④ の SW は `install` で `skipWaiting()` を呼んでいた。これだと user が何も
していないのに新 SW が `activate` し、**その場で旧 build の cache が消える**。
開いたままの旧タブが後から旧 hash の chunk を取りに行く経路
(`main.ts` の `initStorage` は memory fallback を受け入れず **worker ごと作り直す**
── `new Worker(new URL('./storage-worker.ts', import.meta.url))` が走る)で取り零す。
Pages は deploy でツリーごと差し替わるので、**消えた cache の先に実体も無い**。

→ `install` では交代しない。アプリが `SKIP_WAITING` を送ったときだけ交代する。

⚠ **残る露出**(review M-4 で比較対象の誤りを指摘され、書き直した)。比べるべきは
「SW が無い素の静的 deploy」ではなく「**押す前の状態**」である ── 押す前は旧 cache が
旧タブを守っており、押すとその保護が `clients.claim()` と cache 削除で**全タブぶん**消える:

1. タブ B が lease 待ち(「別のタブで開いています…」)で止まる ── **storage worker は未生成**
2. タブ A が「再読込」 → 新 SW が activate → 旧 build の cache 削除 + claim
3. タブ B は `requested === false` なので再読込しない。見張りは `startApp` 解決後にしか
   張られないので**案内も出ない**
4. タブ A が閉じてタブ B が lease を取る → hash 付き URL で worker 生成 → 新 cache に無い
   → network → Pages はツリーごと差し替わっていて 404 → **タブ B は起動不能**

**この窓はまだ塞いでいない。** 塞ぐなら「lease 待ちのタブにも案内を出す」か
「worker の URL を hash 無しにする」だが、どちらも段⑤ の範囲を越える ──
書いてあるのは「**自動交代よりは明確に良いが、無害ではない**」という事実である。

#### 押したタブだけを再読込する

`clients.claim()` は **全タブに** `controllerchange` を投げる。無条件に再読込すると
**別タブで編集中の下書きを巻き込んで消す** ── 「このタブが頼んだか」を持って分ける。
再読込は 1 回だけ(`controllerchange` は複数回来うる)。

#### 配線は実物でしか確かめられない

unit は「アプリ側の判断」と「SW 側の応答」を別々に見ているだけで、**その 2 つが
つながっているか**は誰も見ていない(P7 段③ review H-1 と同じ穴)。
`tests/smoke/update.smoke.spec.ts` が **実際に別 build の `sw.js` を配る** ──
`dist/sw.js` の build id を書き換えて reload し、案内が出る → 押す → 交代 → 再読込 →
**新 build の cache になり旧 build の cache が消えている** → **ノートは残っている**
まで見る(5.4s)。⚠ 生成物を書き換えるので `finally` で必ず戻す。

#### 🔴 変異試験で「smoke から観測できない政策」が露見した

「押したら案内が消える」を `main.ts` に直書きしていたら、**変異が生き残った** ──
押した後は再読込が走るので、消えていなくても次のページには無い。
`createUpdatePrompt` として取り出し、unit で pin した。
**取り出す判断の根拠が「テストできるようになるから」だったのは、これが初めて**である。

変異試験 14 件・生存 0(SW 2 / 案内の判断 6 / 面と動き 4 / 配線 2)。
うち 5 件は smoke でしか落ちない(配線)、6 件は unit でしか落ちない(観測不能)。

#### レビュー指摘の反映(H-1 / H-2 / M-1〜M-4 / L)

| # | 何が壊れていたか | どう直したか |
|---|---|---|
| H-1 | **交代するまで precache が無限に積み上がる**。`install` の `skipWaiting()` を外した結果、user が押すまで `activate` が走らない = **掃除も走らない**。実 Chromium で計測: 4 デプロイ後に cache 5 本・**13.50MB**(+2.65MB / デプロイ、上限なし)。main への push ごとに deploy されるので「あとで」を押し続ける user に効く。⚠ quota は **OPFS(SQLite 本体)と共用**、`storage.persist()` は未実装 ── **ノート消失に接続する** | `install` でも掃除する。ただし**使用中の cache は消せない**ので、`activate` した worker が `pkc3-active:<scope>:<build>` という**印**を残し、installing 側はそれを見て「自分でも active でもない残骸」だけ消す。⚠ 印が無い(旧版が active)ときは**何も消さない**。上限 2 本に収束することを test で直接見る |
| H-2 | **2 回目の deploy 以降、押しても沈黙する**。`offer()` が worker を真偽値ラッチで**恒久的に掴む**ため、次の deploy でその worker が `redundant` になっても出し直さず、押すと死んだ worker へ送る。⚠ Chromium は redundant への `postMessage` を**黙って捨てる**(例外も出ない)ので、そのセッションでは二度と更新できないまま兆候が出ない | ラッチを**worker の同一性**に変え、別の worker が来たら出し直す。押された時点で `registration.waiting` を**読み直す**。⚠ 面ごと消すのもやめた ── 交代が成立しないと「押したのに何も起きず、導線だけ無くなった」になる。「切り替えています…」を残す |
| M-1 | **「あとで」の配線を誰も見ていない**。`dismissUpdate` を `apply()` に変異させても **993 unit + 17 smoke が全緑** ── 「あとで」が「再読込」として動き、未保存の下書きを巻き込んでも気づかない | smoke に「あとで」を押す段を追加。⚠ 観測点は「**再読込が起きていない**」(面が消えるだけでは足りない) |
| M-2 | **「再読込」が未保存の下書きを確認なしで捨てる**。本文は AppState にしか無く(永続は `PERSIST_ENTRY` のみ)、`beforeunload` も無い。案内は editor の隣に出る常設面 ── 同リポジトリの `delete-entry` / `purge-trash` は confirm を持つのに、ここだけ無かった | 編集中なら聞く(`isEditing` / `confirmDiscard` を注入)。⚠ 断られたら**何も変えない**(面も pending もそのまま = 押し直せる) |
| M-3 | `waiting` 側の `container.controller` ガードに**負のテストが無く**、外す変異が全緑で生存(`installing` 側にしか無かった) | 「待機中の worker が在っても制御されていなければ出さない」を追加 |
| M-4 | doc の「露出を増やしていない」の**比較対象が誤り**。比べるべきは「SW 無しの静的 deploy」ではなく「**押す前の状態**」 | §2-3 に**塞いでいない窓**(lease 待ちのタブが起動不能になる 4 段)を明記した |
| L-1 | attach 時の即時 `check()` は**到達不能**(実ブラウザ計測: `installed` に達した worker は `installing` から外れて `waiting` に入る)。対応する test も現実に起きない状態を作っていた | 即時 `check()` を削除。窓は `waiting` を見る行が拾う ── test も実態に合わせた |
| L-5 | `message` handler に `event.waitUntil` が無い(`skipWaiting()` 完了前に SW が終了しうる) | `event.waitUntil(self.skipWaiting())`。⚠ stub にも `waitUntil` を持たせないと**囲っているか見分けられない** |

⚠ **stub が本物より緩かった**のもここで直した。`FakeRegistration` が
「`installed` に達すると `installing` から外れて `waiting` に入り、直前の waiting は
`redundant` になる」を真似ていなかった ── 真似ないと **H-2 の形を test で作れない**。

反映後の変異試験 19 件・生存 0(H-1 7 / H-2 3 / M-2 5 / M-3 1 / 配線 3)。

#### round-2 review の反映 ── **1 巡目の修正が 2 巡目の穴を作った**

| # | 何が壊れていたか | どう直したか |
|---|---|---|
| H-1 | **1 巡目の H-1 修正が smoke の観測点を空振りにした**。増えた印(`pkc3-active:…`)だけで `endsWith(':smoketest0000')` が満たされる ── 実証: 更新後の precache を **8 → 1 エントリ**にしても、update smoke / offline smoke / unit 46 件が**全部緑**(オフライン不可の版を配れる) | cache 名を**丸ごと**突合し、**エントリ数の下限**も見る(下限は sw.js の一覧から取る ── 定数だと配る物が減っても気づかない)。さらに **更新後にオフラインで再読込して読めるまで**見る(offline smoke は初回 install 経路しか通らない) |
| M-1 | `install` と `activate` は互いを知らないので、deploy が交代と重なると**掃除が進行中の install の cache を消す**(逆向きもある)。結末は「**precache ゼロの build が active**」── 無兆候・自己修復なし・503 の案内文が嘘になる | `activate` が**自分の precache が欠けていたら入れ直す**。⚠ 失敗しても activate は止めない(止めると「SW が activate できない」というもっと分からない壊れ方) |
| M-2 | 別タブが先に交代を済ませていると、このタブの「再読込」が**永久に詰む**。`waiting` が null になる理由を「まだ来ていない」としか想定しておらず、**「もう終わった」でも null になる** ── 1 巡目の H-2 修正(面を残す)によって、無反応が「**嘘の進行表示**」に変わっていた | 頼む相手が居なければ**素直に読み直す**(すでに新しい版が active なのだから) |
| M-3 | 「attestation の対象が配る物そのものである」が空振り。`subject-path` を `README.md` に置換しても**全緑**(`pkc3-dist.zip` の語が `zip -r` / `npm sbom >` / `gh release create` の行にも在る) | **attest step の中だけ**を切り出して突合。さらに「attest する集合 = release に添付する集合」を assert |
| M-4 | attestation が担保するのは **release zip** で、Pages の `/` に出るのは `pages.yml` が別 job で独立にビルドした `_site/` ── 「配る物そのものに」は Pages 経路では成立していない | 成立範囲を workflow のコメントに明記(担保しているのは release zip の出所) |
| M-5 | **RC を product として配る**。git の既定 `v:refname` は prerelease を**上位に**並べるので `head -1` が `v3.0.0-rc1` になる(実証)。段⑦ が `-rc` を正式に扱えるようにしたので**今回新たに到達可能**になった | `pages.yml` で prerelease を除外。⚠ 綴りは `release.yml` の判定と**同じ集合**であることを test で pin |
| M-6 | 「全 8 形式」が 1 つ足りず、parity test は**別の母集団**(ZIP だけの 8)を数えていた ── `detectPkc2Format` が `'html'` を返さなくしても緑 | 受理形式そのもの(`Pkc2Format`)を数えて **9 形式**に訂正 |
| M-7 | マニュアルの事実誤り 2 件(「**本文をクリック**で編集」= そんな経路は無い / 「このノートを書き出す」= 実文言は「**書き出す**」)。`detail.ts` の文言は**1 つも縛られていなかった** | doc を訂正し、詳細画面の文言も pin |
| M-8 | 削除の確認が「**元に戻せません**」と言うが、P5b でゴミ箱と復元が着地しており**嘘**。マニュアルは「戻せます」と書いてあり、**どちらか一方が嘘**の状態で、user を怖がらせる側が出荷されていた | 文言を「ゴミ箱から戻せます」に。doc と矛盾しないことを test で pin |
| L-1 | 段⑤ 自身の文言(「再読込」「あとで」)が parity 対象外 ── 改名しても全緑 | 案内カードの文言も pin |
| L-3 | **tag push では `ci.yml` が走らない**(trigger は main への push と PR だけ)── CI を通っていない commit に tag を打てば不一致のまま出荷できる | release job で typecheck / lint / test を build より前に走らせる。⚠「CI を長くしない」は PR gate の話 |
| L-4 | D&D の「無い」ことの主張が `binder.ts` だけを見ていた | **src 全体**を走査 |
| L-5 | 「閲覧用 HTML も落ちた件数を出す」が嘘(件数を出すのは md ZIP だけ) | doc を訂正 |
| L-6 | SW 登録を boot の**前**に移した影響が未計測。`register` は precache 1.6MB の取得を始めるので、初回訪問で boot の wasm / worker chunk と帯域を奪い合う | **成功側と失敗側の両方から呼ぶ**ことで、競合させずに「boot が失敗しても次回オフラインで開ける」を保つ |

⚠ **1 巡目の修正が 2 巡目の穴を作った**のが 2 件(H-1 の印が smoke を空振りにした /
H-2 の「面を残す」が無反応を嘘の進行表示に変えた)。**直した箇所の周りを次に見る**、が教訓。

round-2 反映後の変異試験 22 件・生存 0。
⚠ うち 2 件は 1 巡目で生き残り、どちらも**変異か検査の側の問題**だった:
- 「交代のときに precache も失われる」変異は**自己修復に直されて**素通りした(発火しない形)
  ── 修復そのものを痩せさせる形に変えたら落ちた
- 「ready の印を消す」変異は、順序検査が `indexOf` の **`-1`** で素通りしていた
  ── 順序を見る前に**両方が在ること**を assert する形にした(検査する側も変異の対象)
⚠ うち 2 件は 1 巡目で生き残った:
- 「断られたのに pending を捨てる」は、test が**新しい prompt を作って**押し直していたので救われた
  ── **同じ prompt を**押し直す形に変えた
- 「編集中の確認を配線しない」は `main.ts` の配線で、unit からは届かない ── smoke へ回した

### 段⑥ 実装記録(2026-08-03 着地)

[`docs/manual.md`](../manual.md) と [`docs/migration-from-pkc2.md`](../migration-from-pkc2.md)。
README から両方へ導線。

#### 🔴 doc は「書いた時」ではなく「次に読む時」に正しくないと意味がない

マニュアルは**実装への主張の束**であり、主張は黙って腐る(PKC2 は「廃止済み flag への
言及」「変わった手順」で実際に腐らせた)。`tests/docs-parity.test.ts` が
**一覧・数・語彙**を突合する ── 作成ボタン / ビュー / 上部ボタンの文言、
描画できる fence 言語、受理する md 拡張子、履歴の保持件数、書き出す拡張子、
受理する PKC2 形式の件数、relation の kind。

⚠ **全部は縛れない**(散文は機械では読めない)。縛っていない主張が嘘になる可能性は
残るので、doc 側に「**いま動くものだけを書く**」と明記した。

#### 書きながら見つけた「マニュアルが実装より進んでいた」2 件

| 書いていたこと | 実態 |
|---|---|
| 「ファイルをドラッグ&ドロップ」 | **drop を受ける実装は無い**(取込・添付ともボタン) |
| 「詳細画面の添付から」 | `+添付` は**サイドバー上部**(create-bar) |

→ doc を実態に合わせた。ドラッグ&ドロップは「**無い**」ことの主張なので、
実装した瞬間に嘘になる ── binder が `drop` を受けたら落ちる test を置いた。

> 🔑 **2026-08-18(#250)に、その test が実際に落ちた。** スクショの貼付と一緒に
> file の drop を足したところ、狙いどおり「マニュアルの記述を直すこと」で止まった。
> ⚠ 以後この test は**向きが裏返っている**(受ける実装が消えたら落ちる)ので、
> 「ここに『無い』ことの pin が在る」と読まないこと。

#### 🔴 parity test 自身の変異試験で 1 件生き残った

「マニュアルに `**<ボタン文言>**` が在るか」だけでは、**`バックアップ` を `保存` に
改名する変異が生き残った** ── マニュアル §2 の「書く → **保存**」(編集ボタンの話)に
**たまたま救われて**いた。散文は何にでも当たる。
→ **期待する文言の一覧を literal で pin し、等値で比べる**(包含だと足したものが素通りする)。
改名したらそこが落ちる = マニュアルも直せ、という合図になる。

変異試験 9 件・生存 0(ボタン 3 / 語彙 3 / 数 2 / 「無い」ことの主張 1)。

### 段⑦ 実装記録(2026-08-03。**tag は user の go 待ち**)

仕込みは完了。**`v3.0.0` の tag を打つところだけ user の裁定を待つ** ──
tag は release を作り Pages の `/` を placeholder から製品へ差し替える、
**外向きで戻せない操作**である(段⑦ の他の部分は戻せる)。

| 何を | どうしたか |
|---|---|
| 版 | `3.0.0-dev` → **`3.0.0`**(`package.json` / `release-meta.ts` の両方) |
| provenance | `actions/attest-build-provenance@v3` を release workflow に追加。対象は **`pkc3-dist.zip` と `pkc3-sbom.cdx.json`**(配る物そのもの) |
| 権限 | `id-token: write` + `attestations: write`(どちらか欠けると attest step が落ちる) |
| tag の突合 | **build より前**に `v<tag>` と `package.json` を突合して落とす |

#### 🔴 版は 3 か所に居る

`package.json`(SBOM と npm が名乗る)/ `release-meta.ts`(画面下の status に出る)/
**release tag**(Pages の `/` が何を配るかを決める)。**1 か所だけ上げるのは必ず起きる**ので
`tests/release-meta.test.ts` が前 2 つを機械で縛り、tag との突合は workflow が
**build より前**に行う ── 後ろに置くと、食い違ったままビルドして検品まで通り、
最後の release 作成でようやく落ちる(時間を捨てるうえ、「配ったものと名乗る版が違う」
provenance を作りかける)。

#### ⚠ attestation は「何も証明しない形」で通る

`subject-path` を書き忘れても step 自体は成功する。だから test が
**subject-path の存在と対象名**まで見る ── 権限 2 つ、対象 2 つ、順序 2 つを pin した。

#### ⚠ 変異試験で「変異が発火していなかった」

「版の突合を build の後ろへ動かす」変異を、**block の前にダミー step を挿す**形で
書いてしまい、順序が変わっていないのに「生き残り」と出た。CLAUDE.md の
「**変異自体を疑う**」に該当 ── block を実際に切り貼りして順序が反転したことを
assert してから流し直したら、落ちた。

変異試験 9 件・生存 0(版 3 / attestation 4 / 順序 2)。

### 段⑧ 実装記録(2026-08-03 着地)

段⑤〜⑦ のレビューで「その段の範囲を越える」として**記録だけして残した**ものを塞ぐ。
⚠ 記録しただけで放置すると、次に読む人には「検討済み = 問題なし」に見える。

#### 🔴 boot 前に交代されたタブが起動不能になる(段⑤ round-1 M-4)

1. タブ B が lease 待ち(「別のタブで開いています…」)で止まる ── **storage worker は未生成**
2. タブ A が「再読込」 → 新 SW が activate → 旧 build の cache 削除 + `clients.claim()`
3. B は「押していないタブは再読込しない」(段⑤ の設計)ので留まる。見張りは
   `startApp` 解決後にしか張られないので**案内も出ない**
4. A が閉じて B が lease を取る → **旧 build の hash 付き URL** で worker 生成 →
   新 cache に無い → network → Pages はツリーごと差し替わっていて 404 → **起動不能**

→ `src/adapter/platform/sw/preboot-swap.ts`。**boot が終わっていないタブは、交代に
気づいたら黙って読み直す**。⚠ 安全なのは「まだ何も持っていない」から ── 下書きも
選択も無い。boot 済みのタブを勝手に読み直すのは段⑤ が禁じたこと。
⚠ **初回インストールと区別する** ── 初回の SW も `claim()` するので
`controllerchange` は来る。**登録時点で制御されていたか**で分ける
(区別しないと**初めて開いた人のページが必ず 1 回リロードする**)。

#### 🔴 Pages が配る物に provenance が付いていなかった(段⑦ round-2 M-4)

`release.yml` が attest するのは同 job でビルドした `pkc3-dist.zip` だが、product URL に
出るのは `pages.yml` が**同じ tag を別 job で独立にビルドし直した** `_site/` だった ──
同じ入力でも**別の成果物**なので、「配る物そのものに attestation を付ける」は
Pages 経路で成立していない。round-2 では doc を直すだけにしたが、それは**説明を
実態に合わせただけ**で、user が触る物は検証できないままだった。

→ `pages.yml` が **release の zip を落として展開し、そのまま配る**。
**user が触る物 = attest した物**になり、副産物として product の再ビルド
(`npm ci` + build)が丸ごと消える。⚠ 配る直前にもう一度検品する
(`check-dist.mjs product _site`)── 展開の取り違え(空 / 別物)はここでしか捕まらない。
そのために検品 CLI が**検品先を引数で受ける**ようになった。

⚠ **引数を無視する変異が全緑で生き残った**(`tests/dist-inspect.test.ts` は
純関数しか見ない)── `dist/` を見て「✓ ok」と言いながら別物を配れるので、
`tests/check-dist-cli.test.ts` を足して CLI の I/O を直接見る。

#### 🔴 `release: published` は**そもそも発火しない**(round-3 review M-1)

GitHub Actions は **既定の `GITHUB_TOKEN` が起こしたイベントで新しい run を開始しない**。
`release.yml` は `GH_TOKEN: ${{ github.token }}` で release を作るので、`pages.yml` の
`release: types: [published]` は**この経路では一度も走らない** ── 気づかないと
「**tag を打ったのに `/` が placeholder のまま、次の main push まで製品が出ない**」になる。
段⑧ 途中で入れた「draft で作ってから公開する」修正も、**走らない経路のための修正**だった。

→ `release.yml` の最後で `gh workflow run pages.yml --ref main` を叩く(`actions: write` が要る)。
⚠ draft → 公開の順序は**人が手で release を公開する経路**では効き続けるので残す。

#### 🔴 `gh` の失敗が「release が無い」に化けて、site root を消していた(round-3 review H-2)

`[ -n "$TAG" ] && gh … | grep -q …` は構文としては正しく `A && (B|C)` に parse されるが、
pipefail が無いので **`gh` の失敗が `grep` の 1 に化ける** ── API 障害でも
「安定 release がまだ無い」として placeholder 分岐へ落ちていた。
⚠ その分岐は `_site/index.html` **しか**書かないので、`sw.js` / `manifest.webmanifest` /
`icon.svg` が site root から**消える**。navigation は network-first なので SW を持つ
既存 user にも placeholder が届き、`/sw.js` の 404 は**登録解除の合図**として扱われる
(オフライン能力ごと落ちる)。

→ **placeholder を配ってよいのは「安定 tag が 1 つも無いとき」だけ**。
tag が在るのに配れないなら **job を落として前回の deploy を残す**。

#### 塞がずに残すもの(bounded だと確かめたうえで)

| # | 何 | なぜ残すか |
|---|---|---|
| L-2 | 移行期間中は積み上がりが止まらない(印を書くのは marker 対応 build の activate だけ) | 全タブを閉じれば waiting が activate するので、実務上 1 セッションで収束する |
| L-7 | 廃止した scope の cache が回収されない(`/dev/` を畳んでも `pkc3:%2Fdev%2F:*` が残る) | scope をまたぐ削除は H-1 で**禁じた**もの。scope の廃止は手作業なので、そのとき手で消す |
| L-8 | ダイアログ抑止中は編集中に更新を適用できない(`confirm` が `false` を返す) | 編集を抜ければ復帰する。「聞かずに捨てる」より安全側 |

変異試験 12 件・生存 0(preboot 5 / 配線 3 / Pages 3 / 検品 CLI 1)。
⚠ うち 1 件は**変異が発火していなかった**(変数名だけ変える形にしたので、
呼び出しが残って原文検査が素通り)── 撃ち抜ける形に置き換えた。

---

## 5. 裁定(2026-08-02、user 委任 → 採った側)

| # | 論点 | 採った側 | なぜ |
|---|---|---|---|
| 1 | 素の md 受理器 | **足す** | `file_handlers` を宣言している以上、無ければ manifest が嘘。宣言を外す側に倒すと「md を開ける」という user 指示 9 を捨てることになる ── 指示は生きているので、実体の側を合わせる |
| 2 | product の sourcemap | **外す** | 生成物の 2/3 が map。「速く、安く」に真っ向から反する。本番のスタックトレースは **dev 版 URL で再現**してもらう(`/dev/` は同じ commit を map つきで焼いたもの ── 捨てているのは product の配信量だけで、調査手段は失わない) |
| 3 | 更新通知 | **「再読込」ボタンを出す** | status に 1 行だと**読まれない**。押せば直る問題を、押せない形で伝えない |
| 4 | フォルダ取込 | **別の段** | 単一 md と混ぜると「どっちの経路で壊れたか」が分からなくなる。P6c で 8 形式を 1 つずつ着地させたのと同じ理由 |

⚠ 2 について: `/dev/` にだけ map を置く形にするので、**dev 版のビルドは product と
同じ commit**でなければならない ── Pages workflow は同じ commit から両方を作ること。

🔴 ただし「**同じコード**」にはならない(段① 実装記録の実測)。`BUILD_KIND` の刻印で
entry chunk だけは中身も content hash も変わる。したがって運用は「product の trace を
dev の map に流し込む」ではなく「**`/dev/` の URL で再現してもらい、dev 自身の map で
読む**」である。ここを取り違えると「dev では再現しない」ではなく
「**map の指す場所が嘘だと気づかない**」という、より悪い調査状況になる

## 6. 参照

- `pkc3-major-upgrade-design-2026-07.md` §8(配信)/ §11(段階表)
- `p6d-export-design-2026-08.md`(md ZIP ── 書く側。読む側は本 doc §1)
- `CLAUDE.md`「検証の規律」(宣言と実体のずれを parity test で縛る)
