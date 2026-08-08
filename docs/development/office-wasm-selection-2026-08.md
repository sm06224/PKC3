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
