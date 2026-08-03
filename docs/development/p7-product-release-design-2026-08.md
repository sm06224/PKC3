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
| ⑤ | **更新通知**(新しい版があります) | ④ の上 |
| ⑥ | **マニュアル + 移行ガイド**(PKC2 → PKC3) | 実装が固まってから書く |
| ⑦ | **v3.0.0 release**(SBOM 添付は既存、provenance attestation を足す)→ product URL 稼働 | 最後 |

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
