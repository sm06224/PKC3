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

## 3. 推薦

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
