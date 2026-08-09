# Office 系 wasm の選定と配布・キャッシュ機構(2026-08)

> Issue #88(将来要望 → 2026-08-08 に着手 go)の「wasm の選定からスタート」の成果物。
> 裁定待ちの選定 doc である。調査は web(候補の一次情報)と repo(配布・キャッシュの現状)の
> 2 本を並列で行い、突き合わせた。

## 0. user 指示(2026-08-08。出典タグ付き = 不可侵)

> **wasmの選定からスタートしてください。デカイはずだから、一度ローカルに落としたら
> ユーザー任意でアップデートするまでは毎回のCDNからのロードをしないようにしてください。
> その辺りは他のwasmも同じ扱いになるようにしておいてください。以前にトライした時は
> pptの表示レイアウトが崩れるしWMFだっけか?Windowsの図形貼付が表示できないトラブルが
> あった。そこも含めてやりたいよね。PKCが単独でファイル閲覧・編集も備えれば、
> あっという間にOnenoteのクソ部分を超えたと俺は思う。シンプルにOnenoteは
> シームレス体験が壊れてるんだわ**

評価軸(この指示から確定):
1. **pptx のレイアウト忠実度**(過去に崩れた)
2. **WMF/EMF(Windows 図形貼付)の表示**(過去に出なかった)
3. 編集 + 往復保全(開いて保存しただけで書式が落ちない)
4. 完全ローカル動作・self-host 可・初回 DL 後はローカルキャッシュ
5. サイズは判断理由にしない(「予算度外視」「配る量は気にしない。効くのは定常」)
6. ライセンス(商用・再配布)
7. メンテの活発さ

## 0.1 user 指示(2026-08-08 追加。出典タグ付き = 不可侵)

> **見た目と編集性能が ms office に近ければ近いほど良い。日本語は絶対なのでよろしく**

評価軸に**筆頭 2 本**が加わった(§0 の 7 軸より上位):

- **A. 日本語が実用水準か** ── 豆腐(□)にならない / 行組版が崩れない / **日本語で入力できる**。
  ⚠ どれか 1 つでも欠ければ**その候補は落ちる**(「絶対」は妥協点を持たない)
- **B. MS Office への近さ** ── 見た目(UI と組版結果)と編集の応答

## 1. 候補の総括(2026-08-08 調査。詳細な出典は §6)

| 候補 | pptx 忠実度 | WMF/EMF | 編集+往復 | ライセンス | 備考 |
|---|---|---|---|---|---|
| **ZetaOffice / LibreOffice WASM** | ◎ 本物のレイアウトエンジン | ◎ コアに WMF/EMF/EMF+ 実装 | ○ 編集可(UNO API) | zetajs=MIT / コア=MPL-2.0 | ⚠ **COOP/COEP + SharedArrayBuffer 必須**(§2)。約 50MB(未検証) |
| OnlyOffice client-side(x2t wasm + sdkjs) | ◎ OOXML ネイティブ | △ コアに実装あり、**wasm 配線は未検証** | ◎ 往復は最良クラス | 🔴 **AGPL-3.0**(組込側にソース公開義務) | client-side 完結の実証 repo が複数在る |
| Collabora Online WASM | ─ | ─ | ─ | MPL | ✗ **server 必須の部品** → 除外 |
| pptx-viewer-core + emf-converter(ChristopherVR) | 高忠実を**自己申告** | ◎ EMF+ 300+ record、OffscreenCanvas 対応 | ○ 往復保存を主張 | Apache-2.0 | ⚠ 実質単独作者・第三者検証なし。2026-08 現在活発 |
| docx-preview / mammoth / SheetJS / Univer | docx・xlsx 単能 | ✗(ほぼ全滅) | ✗〜△ | Apache/BSD | 軽量閲覧レーンの部品。**EMF を軒並み落とす** |

- 旧形式(doc/xls/ppt)をネイティブで開けるのは LibreOffice エンジンだけ。x2t は OOXML への変換入力。
- 「wasm 化された libwmf / libemf2svg」の実用パッケージは npm に流通していない(発見できず)。

## 2. 🔴 突き合わせで見つかった成立条件(web 調査単体では見えなかった)

**ZetaOffice は COOP/COEP ヘッダ + SharedArrayBuffer 必須**(LibreOffice core README.wasm で確認)。
一方 PKC3 の配布は GitHub Pages で、**カスタムヘッダ不可 → COOP/COEP なし**が設計上の確定事項
(`docs/development/pkc3-major-upgrade-design-2026-07.md:229`、`storage-worker.ts:43` の
`crossOriginIsolated: false` 実測)。**そのままでは本命候補が動かない。**

回避策 = **service worker によるヘッダ注入**(coi-serviceworker 型。PKC3 は自前 SW を持つので
`sw-source.ts` に足せる)。ただし:
- COEP を `require-corp` にすると**外部画像(同意制)が CORP 無しで全滅**する。
  `credentialless` なら回避できる見込み(Chromium 系は対応)── **実機検証が要る**
- sandbox iframe(html fence)や blob: URL との相互作用も検証対象
- この検証は smoke(実ブラウザ 2 種)で行える

## 2.1 🔴 COOP/COEP の実機検証(2026-08-08。私の実測)

§2 の「そのままでは本命候補が動かない」に対する検証。**両方とも成立した**。

| 確かめたこと | 結果 |
|---|---|
| isolation 下で PKC3 が動くか | **smoke 100 件中 98 件が緑**(dist を COOP/COEP つきで配って全量) |
| ⚠ 空振り防止: 本当に isolation が効いていたか | メイン・**blob: worker の両方**で `crossOriginIsolated: true` / SAB 確保 / `Atomics` 動作を確認 |
| GitHub Pages でヘッダを付けられるか | **SW 注入で成立**(初回は非 isolated → SW が制御を握って再読込 → `crossOriginIsolated: true`) |
| 外部画像(同意制)が生きるか | 生存(COEP は `credentialless`) |

**代償が 1 つ**: SAB が使えるようになると **sqlite が別の OPFS 経路(asyncer VFS)を試して失敗し、
`console.error` を出す**(落ちた 2 件はこれ 1 原因。データと機能は無事)。起動のたびに
余計な取得と worker 生成が走るので、**isolation を入れるなら先に塞ぐ**。

⚠ **`credentialless` は Chromium 系のみ。** Safari / Firefox では `require-corp` になり、
そちらは **CORP を持たない外部画像が全滅**する。isolation を採るなら対応ブラウザの線引きが要る。

## 3. 推薦 ── 🔴 **2026-08-08 に覆した。§3.1 を読むこと**

> ⚠ 以下は**日本語要件を知る前**の推薦である。記録として残すが、**採用しない**。
> 覆した理由と現在の推薦は §3.1。


**ZetaOffice(LibreOffice WASM + zetajs)を self-host で本命とする。
ただし「選定の完了」= 次の 2 点の実機検証を先に通すこと。**

1. **COOP/COEP を SW 注入で成立させられるか**(credentialless で外部画像・sandbox iframe が
   生きるか。smoke で pin)
2. **WMF 入りの実ファイルが wasm ビルドで表示されるか**(user が過去に崩れた実物での受入試験。
   コア機能が wasm ビルドで削られていないかの確認)

理由:
- 評価軸 1・2(pptx 忠実度・WMF)を「JS 再実装」ではなく**本物のレイアウトエンジン +
  20 年物のメタファイル実装**で正面から満たす現存唯一の選択肢
- 旧形式(doc/xls/ppt)もネイティブで開ける唯一の選択肢
- MIT + MPL でライセンスが軽い(AGPL の OnlyOffice と違い、組込先のソース公開義務が無い)。
  ビルドソース公開済みで self-build 可 = CDN 有償化の人質にならない
- 50MB 級のサイズは「予算度外視」+「初回 DL 後ローカルキャッシュ」の指示に合致

**覆る条件**(どれかが判明したら再選定):
- 検証 1 が不成立(COOP/COEP が PKC3 の配布・既存機能と両立しない)→ フルエンジン案自体が
  不成立。軽量レーン(§4)単独へ
- 検証 2 が不成立(wasm ビルドで WMF が出ない)→ OnlyOffice client-side へ乗り換え検討。
  **ただし AGPL-3.0 の受け入れ裁定が必要**
- ZetaOffice のベータ終了後の配布条件が self-build の維持コスト許容外 → 同上
- 軽量レーンの pptx-viewer-core + emf-converter が実ファイル受入試験で申告通りと確認 →
  **閲覧に限っては** 50MB 無しで軸 1・2 を満たせるため、閲覧=軽量 / 編集=ZetaOffice の
  2 段構成に変更しうる

段構え: **P① 閲覧(view-only)を先に着地 → P② 編集**。編集は往復保全の受入試験
(開いて保存しただけのファイルが壊れない)を必須 gate とする。

## 3.1 🔴 推薦(2026-08-08 に差し替え)── **OnlyOffice client-side**。ただし裁定 2 件が要る

**ZetaOffice / LibreOffice WASM は日本語要件で落ちる。** 一次ソースで確認した:

| 事実 | 一次ソース |
|---|---|
| LOWA は **Qt 5.15.2**(allotropia fork)を使う | `static/README.wasm.md`「We're using Qt 5.15.2 with Emscripten 4.0.10」+ `distro-configs/LibreOfficeWASM32.conf` の `--enable-qt5` |
| その wasm プラグインに **`qwasminputcontext.cpp` が無い**(SOURCES 全 16 件を確認) | `allotropia/qtbase@5.15.2+wasm` `src/plugins/platforms/wasm/wasm.pro` |
| wasm の IME 対応は **Qt6 で入った** | `qt/qtbase@6.8` に `qwasminputcontext.cpp`(`compositionStart/Update/End`)が在る |
| 同梱フォント 27 種に **CJK がゼロ** | `zeta-24-2` の `external/more_fonts/Module_more_fonts.mk`(実際に全数を読んだ) |
| 置換表の MS 明朝 / MS ゴシックの**置換先が同梱に 1 つも無い**。游ゴシックは表に載っていない | `officecfg/registry/data/org/openoffice/VCL.xcu` |

⚠ つまり**素の LOWA では日本語が打てない**。VCL 側は `inputMethodEvent` を実装しているが、
プラットフォームプラグインが投げないので**呼ばれない**。回避するには canvas に透明な入力要素を
重ね、合成中プレビュー・確定・キー操作の UNO 化・undo 粒度・選択との整合を**全部自作**する
── PKC3 のライブエディタで最も苦労した領域を、**カーソル座標を UNO 経由でしか取れない**
より不利な条件でもう一度やることになる。加えて軸 B(MS Office への近さ)でも、見た目は
**LibreOffice そのもの**で MS Office 風ではない。**2 つの筆頭軸の両方で負ける。**

**OnlyOffice client-side(x2t wasm + sdkjs)を推す。**

| 軸 | 根拠(一次ソース) |
|---|---|
| 豆腐にならない | `ONLYOFFICE/core-fonts` に **takao-gothic**(TakaoGothic / TakaoPGothic / TakaoExGothic)。glyph 単位の fallback 機構(`common/libfont/character.js` の `IsUseNoSquaresMode` / `__fonts_ranges`)を持つ |
| **日本語で打てる** | `sdkjs/common/text_input2.js` が `["input","compositionstart","compositionupdate","compositionend"]` を listen し、**キャレット位置へ入力要素を移動**(候補窓が正しい位置に出る)。`Begin_CompositeInput` / `Replace_CompositeText` / `Set_CursorPosInCompositeText` を持つ |
| MS Office への近さ | OOXML ネイティブ設計。UI はリボン風。DOCX の font slot(ascii/hAnsi/**eastAsia**/cs)を実装 |
| 配る量 | x2t.wasm 9.7MB / sdk-all.js 9.9MB / fonts.wasm 3.6MB ── LOWA の約 250MB に対し **1.5 桁小さい**(⚠ 判断理由にはしない。事実として記録) |

**⚠ 欠けているもの(user の裁定が要る)**:

1. 🔴 **縦書きが未対応**(`DocumentServer#3738` open)/ 🔴 **ルビが出ない、しかも
   ベース文字ごと消える**(`#1152` open・confirmed-bug・2021 年から)。
   **縦書きかルビを扱う文書があるなら、OnlyOffice も落ちる。**
2. 🔴 **AGPL-3.0**。PKC3 は `package.json` が `"private": true` で LICENSE を持たない。
   組み込むと**組込先のソース公開義務**が生じうる ── これは技術ではなく**事業の判断**である。

そのほか判明した弱点(裁定には要らないが記録):**明朝が 1 本も無い**(ゴシックに落ちる)/
禁則テーブルに**小書き仮名・長音符「ー」・中黒が無い**(MS Word の日本語標準禁則より弱い。
行頭に「っ」「ー」が来うる)/ shaping の言語タグが `"en"` 固定 / 和文と欧文の別フォント指定が
UI から出せない(`#3497` open)/ 共同編集 × IME に現役の confirmed-bug(`#3720`。
PKC3 は共同編集をしないので該当しない見込み)。

**覆る条件**: ①縦書き・ルビが要件に入る ②AGPL を受け入れない ── どちらかなら
**フルエンジンは両方落ちる**。その場合は「閲覧は軽量レーン(§4)+ 編集は OS の Office へ
渡す(`ms-word:` は既に allowlist に在る)」へ方針転換する。

**未検証のまま残る最大の穴**: OnlyOffice client-side で **ＭＳ 明朝 / 游ゴシック指定の実 docx を
開き、MS Word と行数・改ページを突き合わせた実測が世の中に無い**。採用が決まったら
**最初にやるのはこれ**(user の実ファイルでの受入試験)。

## 3.2 🔴 3 択の比較表(2026-08-08。user 「どっちがいいのか決められない / 比較表を示せる?」)

判断が要るのは engine ではなく**この 3 択**である。⚠ 「実測なし」は**私が確かめていない**の意。

| | **A. OnlyOffice を組み込む** | **B. LibreOffice を組み込む** | **C. 閲覧だけ自前 + 編集は OS の Office へ渡す** |
|---|---|---|---|
| **日本語が豆腐にならない** | ○ Takao ゴシック同梱 + 字形 fallback | ✗→△ **CJK ゼロ**。注入すれば出るが、wasm は字形 fallback しないという実機報告あり | ◎ 閲覧は自前描画 / 編集は本物の Office |
| **日本語で入力できる** | ○ canvas 上の IME 実装が製品に在る | ✗ **Qt5 wasm に IME の入口が無い**。透明入力欄 + UNO で**自作**が必要 | ◎ 本物の Office |
| **縦書き** | ✗ 未対応(#3738 open) | ○ 組版機構は wasm 像に同梱(**実動作は実測なし**) | ◎ |
| **ルビ** | ✗ 出ない上に**元の文字ごと消える**(#1152 open・2021 から) | ○ 同上(**実測なし**) | ◎ |
| **禁則** | △ 小書き仮名・長音符「ー」・中黒がテーブルに無い | ○ 日本語組版の設定 UI ごと同梱(**実測なし**) | ◎ |
| **見た目が MS Office に近い** | ○ リボン風 UI・OOXML ネイティブ | ✗ **LibreOffice そのもの** | ◎ 本物 |
| **外部画像を失うか** | **失わない**(isolation 不要。ビルドフラグに `-pthread` 無し) | isolation が要る。`credentialless` なら Chromium では生存、**`require-corp` なら全滅** | 失わない |
| **対応ブラウザ** | 制限なし | `credentialless` は **Chromium 系のみ** | 制限なし |
| **ライセンス** | 🔴 **AGPL-3.0**(ソース公開義務。商用ライセンス購入で外せる可能性 ── **未確認**) | ○ MIT + MPL-2.0 | ○ 各部品 Apache/BSD |
| **配る量** | 約 23MB(x2t 9.7 + sdk 9.9 + fonts 3.6) | 約 250MB | 数 MB |
| **起動** | 実測なし | cold start 20〜90 秒(第三者・**手順の記載なし**) | 即時 |
| **実装量** | **L**(配線が主。engine は既製) | **XL**(250MB 配布 + フォント注入 + fontconfig 別名表 + **IME 自作** + isolation + sqlite の穴塞ぎ) | **M**(閲覧部品の寄せ集め + EMF) |
| **いちばんの穴** | 日本語文書で MS Word と行数・改ページが合うかの**実測が世の中に無い** | **誰も wasm で日本語を実運用していない**(issue すら 0 件) | **編集がアプリ内で完結しない** |

**決まり方(この順に見れば決まる)**:

1. **縦書き・ルビを使う文書があるか** → **ある**なら A は落ちる(B か C)
2. **AGPL を受け入れられるか**(または商用ライセンスを買うか)→ **否**なら A は落ちる(B か C)
3. 1・2 を両方クリアするなら **A**
4. A が落ちたとき、B と C の差は「**日本語入力を自作する覚悟**」── B は日本語 IME を
   canvas の上に自前で作る工程が必ず要る(PKC3 のライブエディタで最も難しかった部分の再演)。
   それを負わないなら **C**

**私の推薦: A → 落ちたら C。B は採らない。**
理由 ── B は user の 2 つの筆頭軸(**日本語**・**MS Office への近さ**)で**両方負けている**うえ、
実装量が最大で、しかも一番難しい部分(IME)が**未踏**である。B の唯一の勝ち筋は縦書き・ルビだが、
それも wasm での実動作は誰も確かめていない ── **確実な負けと不確実な勝ちの交換**になる。

**⚠ 1 と 2 は user にしか答えられない。** 1 は「その文書を書くか」、2 は事業判断である。

## 3.3 🔴 将来性・実績・組版の実装状況(2026-08-09)── **推薦を再度差し替える**

> user「onlyoffice 自体は縦書き対応を今後開発していくんじゃないの? / 未来があるというか
> libre より活発だし、eu での導入実績があると思ってるけど、どうなのか?」

**この問いが正しかった。調べた結果、§3.1 の推薦(A. OnlyOffice)を取り下げる。**
ただし**見立てとは逆向き**に動いた。

### (1) 縦書き・ルビが実装される見込み: **低**

| 事実 | 一次ソース |
|---|---|
| **ルビは未実装**。`CRuby::fromXML` が**空実装**、2 つ目の overload は `ReadTillEnd` で丸ごと読み飛ばし、`toXML` は `<w:ruby/>` を返す。`rubyBase`(親文字)はどこにもパースされない | `ONLYOFFICE/core` `OOXML/DocxFormat/Logic/RunContent.cpp`(**私が直接確認**) |
| 縦書きも未実装。列挙定数 `textdirection_TBRLV` が在るだけで、`textDirection` が内部形式へ渡るのは**表セルだけ** | `sdkjs/word/Editor/Styles.js` / `core` の BinaryWriter |
| 公式 ROADMAP(8.0〜10.0)に vertical / CJK 組版の記載が**ゼロ**。一方 **RTL には 9.x〜10.0 で継続投資**している | `ONLYOFFICE/DocumentServer/ROADMAP.md` |
| 正本 issue #1546(縦書き)は **4 年 8 か月 open**、assignee / milestone / PR なし。#1152(ルビ)は `confirmed-bug` のまま **5 年 7 か月** |  GitHub |
| CJK 系で 3 年以上 open が **5 件**(うち 4 件は開発元が `confirmed-bug` 認定済み) | GitHub |
| CJK 要望の実装実績: #487(CJK 行間)は報告から修正まで **86 か月** | GitHub |

🔑 **「活発だからいずれ実装される」は成立しない** ── 同じ開発元が RTL には投資して CJK 組版には
一項目も割いていない。これは手が回っていないのではなく**優先順位の選択**である。

### (2) ブラウザ内で動かすこと自体を、開発元が断っている

- x2t の WebAssembly 化提案(`DocumentServer#731`、CryptPad が動く実証つきで 2019 起票)は
  **開発元の返信なしで "closed as not planned"**。公式 ROADMAP にも WebAssembly の記載なし
- したがって client-side 構成は**第三者 fork**(cryptpad / xwiki-labs)に乗ることになる

### (3) その開発元は、いま fork と係争中

2026-03、EU ベンダー 12 社(Nextcloud / IONOS / Proton / Open-Xchange / XWiki ほか)が
ONLYOFFICE を fork して **Euro-Office** を発表。ONLYOFFICE は AGPL 違反を主張し、
**8 年続いた Nextcloud との提携を停止**(FSF / Software Freedom Conservancy は fork 側の解釈を支持)。
⚠ **AGPL のコードを組み込む判断が、権利者が現に fork 相手と争っている状況で行われる**ことになる。

### (4) EU 実績は逆だった

- 独の主権ワークプレイス **openDesk のオフィス部品は Collabora = LibreOffice 系**(ONLYOFFICE ではない)
- 第三者・政府ソースで裏が取れた規模: LibreOffice 系 = シュレスヴィヒ＝ホルシュタイン州
  **約 30,000 台** / デンマーク デジタル省 / openDesk。ONLYOFFICE = **リヨン市 4,000〜8,000 席**(実在の確かな実績)。他は自社の事例紹介
- 開発の量: LibreOffice/core は直近 24 か月で **21,088 commits / 著者 430 名**(昨日もコミット)、
  ONLYOFFICE は sdkjs 7,530 + core 3,817 / 著者 40・23 名(**公開ブランチの先端は 2 つとも 2026-05-26 で停止**
  ── リリース単位でまとめて公開する運用と見られるが、**現在の中身が見えない**)

### (5) 逆に、LibreOffice が部分的に生き返った

- §3.1 で「日本語が打てない」と判定した原因は **Qt 5.15.2 に IME の入口が無い**ことだった。
  **Qt 6.8 の wasm には合成処理が実装されている**(`compositionStart/Update/End` / preedit。**私が直接確認**)
- TDF が 2026-05-27 に **Qt6 + WebAssembly のブラウザ版**を公式戦略として発表(二次情報。
  一次の TDF blog は egress ブロックで未読)
- ⚠ **まだ届いていない**: `distro-configs/LibreOfficeWASM32.conf` は本日時点の master でも
  **`--enable-qt5`**(**私が直接確認**)。発表どおりプロトタイプ段階

### 🔴 差し替え後の推薦

**A(OnlyOffice を組み込む)は採らない。** 理由を 1 行で:
**土台を開発元が否定していて(#731 not planned)、その開発元が fork 相手と係争中で、
かつ日本語組版(縦書き・ルビ)は実装の痕跡が一次情報のどこにも無い。**

**B(LibreOffice)は「待つ」。** 唯一の致命傷(IME)は **Qt のバージョン問題**であり、
公式の進む先がそのまま解決になる。ライセンスも MPL で軽い。ただし**今日は使えない**。

**⚠ C(閲覧だけ自前)も無条件には推せない。** user の過去の失敗そのもの
(「ppt の表示レイアウトが崩れる / WMF が表示できない」)が、まさに軽量レーンの弱点である。
**採否を決める前に実ファイルで受入試験をする** ── これが次の一手。

**次の一手(裁定不要・すぐできる)**: user が過去に崩れた **実物の ppt/pptx と WMF 貼付文書**を
fixture にして、軽量レーン(pptx-viewer-core + emf-converter)に通し、**崩れるかどうかを見る**。
⚠ WMF が 1 つも入っていない fixture で「表示できた」と言わない(ゼロ件の次元は測っていない次元)。

## 3.4 🔴 裁定(user 指示 2026-08-09。出典タグ付き = 不可侵)と、そこから決まる形

> **qt6 のブラウザ版を先取りする方針で閲覧優先で実装 / 可能なら独自ビルドしてしまえ**

- 採るのは **B(LibreOffice)**。ただし TDF の到着を待たず**先取り**する
- **閲覧を先に出す**(編集は後)
- **自前ビルドしてよい**(「可能なら」= 実現性は測って判断する)

### 3.4.1 ⚠ **一度読み違えた**(2026-08-09)── ページ画像に焼く案は user が却下

私は「閲覧だけなら Qt を外し、ページを PNG に焼いて出す」と提案した。**user 却下**:

> **その導線はダメです / PDF を閲覧したいわけじゃない**

🔑 **ページを画像に焼いた時点で、それは PDF ビューアと同じもの**である ── 文字が選べず、
検索できず、**編集へ繋がらない**。「図は描いたら焼く」は**図**の規律であって、
**文書に適用してはいけない**(図は絵だが、文書は文字である)。
⚠ 閲覧のためだけに Qt を外すと、**編集へ繋がる道ごと捨てる**ことになる。

### 3.4.2 出すもの ── **本物の LibreOffice の面**を、まず閲覧モードで

- **Qt6 で建てる**: Qt5 では日本語が打てない。編集を後から乗せるなら最初から Qt6 で建てる
  = user 指示の「**先取り**」
- **閲覧を先に出す**: 閲覧なら IME が要らないので、**ビルドさえ通れば出せる**
- **自前ビルドの見返り**: 配布されている LOWA は Qt5 で、**CJK フォントも入っていない**。
  自分で焼けば**両方とも建てた時点で解決する**

### 3.4.3 自前ビルドの実現性(この箱の実測)

| | 実測値 |
|---|---|
| 空きディスク | **28 GB**(書込 149 MB/s) |
| CPU / メモリ | **4 コア** / 15 GB |
| emscripten | **未導入**(emsdk の取得から) |

LibreOffice の wasm ビルドは数十 GB 規模なので、**この箱で完結させるのは苦しい**。
現実的な線は **CI(大きめの runner)で焼いて生成物だけ持ち込む**形。
⚠ ただし PR gate は「速い lane に限定」(プロセス指示)なので、**engine のビルドは
PR gate に載せない** ── nightly / 手動 dispatch / 別リポジトリの release artifact にする。

## 3.5 🔴 Qt6 + WASM の自前ビルド ── 手順と関門(2026-08-09)

**結論: 道は既に上流に通っている。ゼロから作るのではなく、experimental な経路を叩き起こす。**

### 3.5.1 一次ソースで確認した事実(私が実物を読んだ)

| 事実 | 場所 |
|---|---|
| **Qt6 × Emscripten の分岐が upstream master に在る** | `configure.ac:14293-14297`(`libqwasm.a` / `wasm_shell.html` を探して無ければ `AC_MSG_ERROR`)、`:14313`(`-lQt6BundledPcre2 -lQt6BundledZLIB -lqwasm -sGL_ENABLE_GET_PROC_ADDRESS`) |
| **呼び方の制約** | `configure.ac:12691` ── `DISABLE_DYNLOADING=TRUE`(wasm は常にそう)かつ GUI 付きなら **VCL プラグインはちょうど 1 個**。`--enable-qt6` を足すだけでは `R="qt5 qt6"` で落ちる |
| 🔴 **リンクに最大 64GB RAM** | `static/README.wasm.md:87`「This way the LO WASM possibly needs 64GB RAM」。同じ場所に回避策(`-s WASM_BIGINT=1` / `ASSERTIONS=1` / `-g3` で WASM の書き直しを避ける)も書いてある |
| **Qt6 wasm は IME を持つ** | `qtbase@6.5/6.8/6.10/6.11` に `qwasminputcontext.cpp` が在る(5.15 は **404**) |
| CJK フォントは **1 つも無い** | `external/more_fonts/Module_more_fonts.mk`(全 27 種を確認) |

**正しい configure の呼び方**:
```
--with-distro=LibreOfficeWASM32 --disable-qt5 --enable-qt6
(QT6DIR は wasm 版 Qt6 の prefix)
```

### 3.5.2 関門(重い順)

1. 🔴 **リンク時のメモリ** ── 公式が最大 64GB と言っている。**この箱は 15GB**、GitHub の
   標準 runner も 16GB。→ **大きい runner か自前マシンが要る**。README の回避策を
   先に試す価値はある
2. **Qt6 は host build が追加で要る**(Qt5 には無かった要件)── 「同じ版の Qt をホスト用に
   1 回、wasm 用にもう 1 回」。ビルド時間が単純に増える
3. **distro-config も CI も無い** ── 上流が壊れても誰も気づかない経路。**自分で config を
   持ち、自分で CI を張る**必要がある(⚠ PR gate には載せない ── プロセス指示)
4. **取りこぼしを自分で直す** ── `EMSCRIPTEN_INTEL_GCC.mk` の `gb_EMSCRIPTEN_QTDEFS` が
   `ifeq ($(ENABLE_QT5),TRUE)` になっており **Qt6 に適用されない**
5. **thread build → COOP/COEP 必須** ── LO 側が `-pthread -s USE_PTHREADS=1` を要求する
   (`EMSCRIPTEN_INTEL_GCC.mk`)ので Qt も `-feature-thread`。→ §2.1 で**成立を実機確認済み**

⚠ **emsdk の食い違いは関門ではない**: LOWA は 4.0.10、Qt 6.10/6.11 の推奨は 4.0.7 で
**同じ major.minor**。しかも Qt 公式が「ソースからビルドするなら表の値は*最低*版」と明記。
LO は Qt を CMake 経由で consume しないので、Qt 側の版一致 `FATAL_ERROR` も発火しない。

### 3.5.3 CJK フォントを焼き込む(自前ビルドの本当の見返り)

`external/more_fonts` に CJK は無いので、**5 か所**を足す(`fonts_noto_sans` が雛形):
`download.lst` / `UnpackedTarball_noto_cjk_jp.mk`(新規)/ `ExternalPackage_noto_cjk_jp.mk`(新規)/
`Module_more_fonts.mk` / `Repository.mk` の `gb_Helper_optional(MORE_FONTS, ...)`。
wasm は `--with-fonts` が既定 ON なので、これで `ooo_fonts` 経由で `soffice.data` に入る。

⚠ **`soffice.data` は eager preload** ── Noto Sans CJK JP のフル OTF は 1 ウェイト約 16MB。
**サブセット必須**(可変フォント or 常用漢字サブセット)。
⚠ フォント置換表(`VCL.xcu`)の ＭＳ 明朝 / ＭＳ ゴシックの置換先も同梱に無いので、
`fc_local.conf` に別名を足すか置換表を触る必要がある(§3.1 の表を参照)。

### 3.5.4 「動く」証拠

`QTBUG-136687`「Wasm LibreOffice no longer gets keyboard input events」── **Qt6 dev に対して
ビルドされた LibreOffice wasm** の不具合報告で、再現手順が「スタートセンターで Writer を
クリックして x を打つ」。Qt 6.9.1 / 6.10.0 で Fixed。
⚠ 二次情報(`bugreports.qt.io` は egress ブロックで原文未読)。**この 1 点は自分の目で
確認できていない**。

### 3.5.5 次の一手

1. **この箱で toolchain だけ先に通す** ── emsdk 4.0.10 + Qt 6.11 の host build と wasm build。
   Qt だけなら LO より桁違いに軽いので、ここで**半分の不確実性が消える**
2. **LibreOffice のリンクは大きいマシンへ** ── 64GB の壁。README の回避策を当てて
   どこまで下がるかを測ってから機材を決める
3. **CJK フォントのサブセットを先に作る**(ビルドと独立に進む)
4. ⚠ 上流(TDF の Jonathan Clark / Michael Weghorn ら)と衝突しないよう、着手前に gerrit を
   見る ── **本セッションからは `gerrit.libreoffice.org` に到達できない**

## 3.6 🔴 実際に建てた記録(2026-08-09)── Qt6 側は**通った**。詰まりはネットワーク

**やったこと**(この開発コンテナ。4 コア / 15GB RAM / 空き 28GB):

| 段 | 結果 |
|---|---|
| emsdk **4.0.10** 導入 | ✅ `emcc 4.0.10` |
| qtbase **6.11** 取得 | ✅ 実物のツリーに `qwasminputcontext.cpp` / `.h` が在ることを確認 |
| Qt6 **host** ビルド | ✅ `moc` / `Qt6CoreTools` / `Qt6GuiTools` / `Qt6WidgetsTools` |
| Qt **6.11.3** **wasm** ビルド(`-feature-thread`) | ✅ `libqwasm.a` + `wasm_shell.html` |
| LibreOffice `configure` が Qt6 を受理 | ✅ `ENABLE_QT6=TRUE` / `ENABLE_QT5=` / `VCL_PLUGIN_INFO= qt6` |
| `make` | ❌ **外部 tarball を取れない** |

🔑 **「distro-config も CI も無い experimental な経路」が生きていることを、外から確認した。**

### 詰まった場所 ── コードではなく egress ポリシー

```
https://dev-www.libreoffice.org/src/libabw-0.1.4.tar.xz
Proxy tunneling failed: Forbidden
```
LibreOffice は外部依存 tarball 約 100 件をこのホストから取る。**このコンテナからは到達不可**
(実測: `curl` が 000、プロキシは CONNECT に 403)。ディスクでも CPU でもメモリでもない。
→ **ビルドは CI へ出す**。手順は `.github/workflows/office-wasm-build.yml`(`workflow_dispatch` のみ。
⚠ PR gate には載せない)。

### 手順に必ず要る 3 行(実際に踏んだ罠)

1. 🔴 **`moc` / `rcc` / `uic` は host の道具**で cross build の install に入らない。
   LibreOffice の configure は `$QT6DIR/libexec` と `$QT6DIR/bin` しか見ない
   (`configure.ac:14354-14357`)ので、**host から繋がないと落ちる**
2. **host を `-no-gui` で建ててはいけない** ── wasm 側の Gui/Widgets が host の
   `Qt6GuiTools` / `Qt6WidgetsTools` を参照する
3. **`-xcb` を強制しない** ── xcb の dev が無いと feature condition 違反で configure が落ちる。
   host は道具を配るだけなので画面は要らない
   (ほかに Perl の `Archive::Zip`、`flex` / `gperf` / `nasm` / `xsltproc` が不足していた)

### 机上の予測が実測で裏付けられた / 覆された点

- ✅ **emsdk の版ズレは関門ではない** ── Qt 6.11 推奨 4.0.7 に対し 4.0.10 で configure が通り、
  出たのは `WARNING: Using Emscripten version 4.0.10 with this Qt` **1 行だけ**
- ❌ **「この箱の制約はディスクと RAM」という見立ては外れた** ── 実際に止めたのは**ネットワーク**。
  ディスクは 23GB 残っていた

### 残る最大の未知 → **解けた**(run 31307638176)

**リンク時のメモリ**(公式 README が「possibly needs 64GB RAM」)は**杞憂だった**。
標準 runner(16GB)で `make` が完走し、`/usr/bin/time -v` の **peak RSS は 4.95 GB**。
`soffice.data` 87.6MB も生成された。落ちたのは**最後の `soffice.js` のリンクだけ**である。

## 3.7 🔴 Qt6 経路の欠落と、それを **2h40m 待たずに** 検証する方法(2026-08-09)

### 症状と原因

`wasm-ld: undefined symbol: FT_Outline_Transform`(ほか `FT_*` 多数、すべて
`libcairo-lo.a(cairo-ft-font.c.o)` 由来)。

`RepositoryExternal.mk` を読むと `gb_LinkTarget__use_cairo` は **`freetype_headers`
しか取っていない**(ヘッダのみ・libs 無し)。Qt5 のリンク行には
`-lQt5FontDatabaseSupport` が在って Qt 側の freetype で解決されるが、
**Qt6 のリンク行(`configure.ac:14313`)にはフォント系が 1 つも無い**。
上流の Qt6 × Emscripten はまだ誰も最後まで通していない、という状況証拠でもある。

直し: `vcl/Library_vclplug_qt6.mk` の `use_externals` に **`freetype`** を並べる
(`build/office-wasm/patch-qt6-freetype.py`)。`gb_LinkTarget__use_freetype` は
`SYSTEM_FREETYPE` 分岐の**外**で定義されているので Emscripten でも有効で、
`FREETYPE_LIBS` をリンク行へ足す。

⚠ **最初は `use_static_libraries` で足そうとして誤った。** `StaticLibrary_freetype` が
建つのは `COM=MSC` のときだけ(`external/freetype/Module_freetype.mk`)で、Emscripten では
ExternalProject である。上流の `vcl/Library_vcl.mk` の条件が `WNT-TRUE` なのには理由がある。

### 🔑 **`gb_DEBUG_STATIC=1` で、ビルドせずにリンク構成を検める**

user 指示「無策で頭から回すの違くない?」への答え。**1 語変えて 3 時間回す**のではなく、
gbuild に**実行ファイルへ集まる externals を印字させる**:

```bash
make gb_DEBUG_STATIC=1 -n Executable_soffice_bin > /tmp/dbgstatic.log 2>&1
grep -o "expand_executable externals for Executable/soffice.js: .*" /tmp/dbgstatic.log
```

`solenv/gbuild/static.mk` の `gb_LinkTarget__expand_executable` が
**transitive に集めた externals を実行ファイルへ当て直す**ので、この 1 行が
「リンク行に何が載るか」の答えになる。`make` は tarball が無くて途中で止まるが、
**印字は parse 時に出る**ので止まってよい ── 所要 **4 分**。

実測(2026-08-09):

| | soffice.js の externals 末尾 |
|---|---|
| パッチ **有** | `… wpd wpg xmlsec **freetype** qt6` |
| パッチ **無**(対照群) | `… wpd wpg xmlsec qt6` |

⚠ **対照群を取ること** ── `freetype_headers` は cairo 経由で元から在るので、
「freetype という字がある」だけでは効果を主張できない。外して消えることまで見る。

⚠ **この検証が示すのは「`FREETYPE_LIBS` がリンク行に載る」ところまで**である。
リンクが通ることまでは示していない(`FT_*` 以外の未定義が残っている可能性は消えない)。
主張の範囲を超えて読まない。

## 4. 軽量閲覧レーン(本命の保険 / 併走候補)

docx = docx-preview、xlsx = SheetJS(+UI が要るなら Univer)、pptx = pptx-viewer-core、
WMF/EMF = emf-converter(OffscreenCanvas 対応 = worker 規律にそのまま乗る)。
すべて Apache/BSD 系。⚠ pptx の忠実度・往復は単独作者の自己申告なので、
採用前に**user の実ファイルでの受入試験が必須**。旧形式(ppt/doc/xls)は開けない
(SheetJS の .xls を除く)。

## 5. 配布・キャッシュ機構(「他の wasm も同じ扱い」の設計)

### 現状(repo 調査で確認)

- **同梱資産(sqlite wasm / mermaid chunk)は既に user 方式で動いている**:
  SW precache + hash 付き cache-first + 更新カード(user が押したときだけ交代、
  `skipWaiting` 不使用)。= 「初回だけ取得、任意アップデートまでローカル」は同梱分については実現済み
- 外部 CDN への参照は現在 **0 件**(全 self-host)。CSP も無い(制約は CDN 側の CORS のみ)

### 新設するもの: `wasm-pack-store`(同梱しない巨大 wasm 用)

- **IDB Blob store**(`pkc3-assets` / `pkc3-diagram-cache` と同型の 3 例目)に
  `{bytes(Blob), version, sha256, url, fetchedAt}` を保存
- 取得は 1 回だけ。以後は store から読む。**sha256 照合を必須**とする
  (「壊れを検出する材料を捨てない」── 照合材料が実際に届いていることも pin)
- **更新は user 任意のみ**: settings に独立節(「外部の画像」と同格 ── 「外へ何が伝わるか」系)を
  設け、「確認 → 取得 → 差し替え」を明示操作にする。自動更新はしない
- 消費側は WorkerLease(遅延起動 / ジョブのバッファ / アイドル kill)── Office wasm は
  「計算のワーカー」なので不可侵指示の対象。kill 後の再 spawn は store から読み直す
  (network に行かない ── これがローカル置き場の役割)
- SW は触らない(外部 origin 素通しのまま)。Cache API 案は不採用
  (SW の掃除規約 `pkc3:` prefix と欄が混ざる。IDB Blob の前例 2 件と同型で書ける方を採る)
- quota: OPFS(ノート本体)と共用なので、**上限と削除導線**を必ず付ける
  (diagram-cache の 32MB 上限 + LRU が型。wasm は LRU でなく明示削除)

### 見せ方(#88 の不可侵指示との整合)

- スライド・シートの表示は「**描いたら焼く**」(PNG `<img>` 1 枚、鍵 = 原文 + テーマ + 幅 + DPR、
  bytes は IDB Blob、ObjectURL は寿命終端で revoke)
- 受け渡しは transfer(ゼロコピー)。数十 MB のファイルを heap に丸ごと持たない
- Office 用の**別モードを作らない** ── 既存の添付 preview の器
  (`[data-pkc-field="attachment-preview"]`)に出す

## 6. 出典(選定調査の一次情報)

- ZetaOffice: allotropia/zetajs(GitHub, MIT)/ LibreOffice core `static/README.wasm.md`
  (COOP/COEP + SAB 必須、`-sPROXY_TO_PTHREAD`)/ LibreOffice 開発ブログ
  「Supporting metafile formats: WMF/EMF/EMF+」(2022-04)
- OnlyOffice: cryptpad/onlyoffice-x2t-wasm / electroluxcode/onlyoffice-web-comp
  (v9 ベース、client-side 完結、AGPL-3.0)/ baotlake/office-website(ZIZIYI)/
  ONLYOFFICE core `DesktopEditor/raster/Metafile/` / License FAQ(AGPL)
- Collabora: FOSDEM 2024「Collabora Online WASM」(server 断時フォールバック部品)
- 軽量系: ChristopherVR/pptx-viewer(2.3.2, 2026-08-07)+ emf-converter(2.0.2, 2026-07,
  OffscreenCanvas 対応)/ aiden0z/pptx-renderer(**EMF ベクタ未実装と README 明記**)/
  VolodymyrBaydalka/docxjs(docx-preview 0.4.0)/ SheetJS(npm 0.18.5 で凍結)/
  dream-num/univer(Slides は「開発中・本番不可」と公式明記)/ Luckysheet(2022 停止 → 除外)
- 未検証のまま残る項目: ZetaOffice の実サイズ・ベータ後の価格・日本語 IME/フォント品質、
  OnlyOffice wasm ビルドでの WMF 表示・旧 ppt 変換の有効性、pptx-viewer-core の忠実度の実力

## 7. 次の一手(裁定後)

1. 検証ハーネス: COOP/COEP SW 注入の smoke(外部画像・sandbox iframe・storage worker が
   生きることを 2 ブラウザで pin)
2. 受入試験: user の実ファイル(崩れた実績のある ppt/pptx、WMF 貼付文書)を fixture 化
   (⚠ fixture のゼロ件次元 ── WMF が 1 つも入っていない fixture で「表示できた」と言わない)
3. `wasm-pack-store` の実装(選定と独立に着手可能 ── どの wasm を選んでも要る)
