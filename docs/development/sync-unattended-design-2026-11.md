# 端末間の同期 段 4 ── 人がファイルを運ばない無人同期(スマホ・別のブラウザを含む)の設計案

> user 指示(2026-11-21):「スマホや異なるブラウザ間も含め、人間がファイルを運ばずに同期できる道(自動・無人同期)もオプションで提供したい」
> 「段 4 として保留していた WebDAV / S3 互換(またはそれ以外の無人同期方式)を『実施する前提』に切り替え、
> ① 静的 GitHub Pages からの CORS / COOP・COEP の制約、② 認証情報(鍵)の安全な保持方法、③ 自動同期のタイミングと競合時の扱い
> を調べて設計案を出してください(P2P は両端末同時起動が要るため優先度は下げて構いません)」

- 状態: **設計案(実装前・裁定待ち)**。#2000 の段 4。段 1〜3 は着地済み / 着地中(設計 doc `pkc3-major-upgrade-design-2026-07.md` §12.1)。
- 調べた日: 2026-11-21。ブラウザ・各社の API は変わりやすいので、着手時に出典を確かめ直す。**未確認**と書いた所は一次資料を読めていない。

## 0. 結論(推薦)

1. **段 3 の「同期フォルダ」の型をそのまま通信の先へ広げる**。同期の判定(段 1・2 の核)と「端末ごとの出し箱」(段 3)はそのまま使い、
   「フォルダ」の代わりに**遠くの置き場**(`RemoteBox`: 一覧 / 読む / 自分のファイルを書く / 自分のファイルを消す)を差し込む。新しく作るのは置き場の口と鍵の扱いだけ。
2. **最初の置き場は S3 互換(Cloudflare R2 を案内の既定)と WebDAV**。どちらもバックエンド無しで GitHub Pages から `fetch` で届き、
   トークンの期限切れが無いので**無人で回り続けられる**。S3 互換は条件付き書き込み(`If-Match` / `If-None-Match`)が確実に効く。
3. **2 段目に Dropbox**(OAuth の PKCE で長く使える refresh token が出る ── 大手で唯一、バックエンド無しで無人同期が続けられる)。
   OneDrive は refresh token が 24 時間固定なので任意。**Google ドライブは見送り**(ブラウザだけのアプリには refresh token が出ず、無人同期にならない)。
4. **P2P(WebRTC)は見送り**(両端末の同時起動・接続情報の受け渡しが要る。user の裁定どおり優先度を下げる)。
5. 鍵は**端末の中で暗号化して保存**(既定)+ 任意でパスフレーズ。**中身もエンドツーエンドで暗号化**(クラウド事業者の置き場では既定オン)。
6. 既定オフ・設定(フラグは使わない)・入口は設定「端末間の同期」がオンのときだけ ── 段 1〜3 の約束を引き継ぐ。

## 1. 静的 GitHub Pages からの CORS / COOP・COEP

### 1.1 PKC3 の側(実装を読んだ結果)

| 項目 | いまの実装 | 通信への影響 |
|---|---|---|
| COOP | `same-origin`(SW が文書の応答に付ける。`src/adapter/platform/sw/coi-headers.ts`) | **ポップアップの OAuth が壊れる**(開いた窓との `window.opener` が切れる)。直すには `same-origin-allow-popups` が要るが、分離(`crossOriginIsolated`)が外れて Office・SQLite の前提が崩れるので**変えない** |
| COEP | `credentialless`(同上) | 縛るのは **no-cors の読み込みだけ**。`fetch(url, { mode: 'cors' })` は CORS で判定されるので、相手が CORS を返せば読める |
| SW の fetch | 外の origin は**素通し**(`sw-source.ts` の `if (url.origin !== self.location.origin) return;`) | 通信を SW が書き換えたり保存したりしない(確認済み) |
| CSP | 文書全体の `connect-src` は無い(箱の中の iframe だけ `connect-src 'none'`) | 本体からの fetch は止まらない。⚠ 置き場の host を絞る CSP を足すかは別の論点 |
| クエリ | URL のクエリはフラグ扱い(CLAUDE.md §2-8。`tests/features/flags.test.ts`) | OAuth の戻り(`?code=…&state=…`)を本体で受けると、この規則に当たる → **専用の静的な受け口ページ**で受ける(§1.4) |

### 1.2 置き場ごとの CORS

| 置き場 | GitHub Pages から直に届くか | user がする設定 | 根拠 |
|---|---|---|---|
| **S3 互換**(AWS S3 / R2 / MinIO) | 届く | バケットの CORS: 許す origin = `https://<user>.github.io`、Methods = `GET, PUT, HEAD, DELETE`、Headers = `authorization, content-type, x-amz-*, if-match, if-none-match`、**Expose = `ETag`**(無いと JS から ETag が読めない)。PKC3 は設定の雛形を画面とマニュアルで渡す | [AWS: CORS](https://docs.aws.amazon.com/AmazonS3/latest/dev/cors-troubleshooting.html) / [AWS SDK: ETag の expose](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/cors.html) / [R2 + aws4fetch](https://developers.cloudflare.com/r2/examples/aws/aws4fetch) |
| **WebDAV**(Nextcloud) | 素の状態では**届かない**(CORS を返さない。#3131 が長く開いている) | 「WebAppPassword」アプリを入れ、許す origin を登録 | [nextcloud/server#3131](https://github.com/nextcloud/server/issues/3131) / [WebAppPassword](https://apps.nextcloud.com/apps/webapppassword) |
| **WebDAV**(Apache mod_dav などの一般) | 設定しだい | **OPTIONS(事前確認)には認証を求めない**(401 を返すと事前確認が必ず失敗する)。`Access-Control-Allow-Methods` に `PROPFIND, PUT, DELETE, MOVE`、`-Headers` に `Authorization, Depth, Destination, If-Match` を明記 | [WebKit #45943](https://bugs.webkit.org/show_bug.cgi?id=45943) / [mod_dav](https://httpd.apache.org/docs/mod/mod_dav.html) |
| **Dropbox** | 届く | 開発者(= PKC3 の配布者)が App Console で app key を作り、受け口ページの URL を登録。user はログインするだけ | [Dropbox: offline access](https://dropbox.tech/developers/using-oauth-2-0-with-offline-access) |
| OneDrive | 届く | Entra に SPA 型の受け口を登録(SPA 型でないと cross-origin のトークン交換を断られる) | [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/1608608/cross-origin-token-redemption-is-permitted-only-fo) |
| Google ドライブ | 一部 | ブラウザだけのアプリには refresh token が出ない → 無人にならない | [Google: how user authz works](https://developers.google.com/identity/oauth2/web/guides/how-user-authz-works) |

- ⚠ `Authorization` は `Access-Control-Allow-Headers: *` に含まれない ── 名前で書いてもらう([MDN](https://developer.mozilla.org/docs/Web/HTTP/Headers/Access-Control-Allow-Headers))。
- ⚠ 雛形は「許す origin」を **PKC3 を開いている origin**(`location.origin`)で埋めて出す(user の GitHub Pages / 独自ドメインのどちらでも合う)。
- 🔑 つながらないとき、ブラウザは CORS の失敗を JS に「理由なしの失敗」としてしか返さない ── 画面は「置き場の CORS の設定を確かめてください(雛形)」と
  **設定の場所と雛形**を言う(黙って止まらない)。接続の確認ボタン(1 回だけ一覧を取る)を置く。

### 1.3 COEP の下で読めることの確認(実装時の検査)

- `fetch` は既定で `mode: 'cors'` ── COEP(`credentialless`)は効かない([MDN: COEP](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy) / [Chrome: credentialless](https://developer.chrome.com/blog/coep-credentialless-origin-trial))。
- 実装時の smoke: 手元に CORS を返す作り物の S3 / WebDAV(Node の小さなサーバ)を立て、**分離された画面から**読み書きできること、CORS を返さないときに理由つきで止まることを実ブラウザで見る。

### 1.4 OAuth(Dropbox・OneDrive)の受け口

- ポップアップは COOP で壊れるので **画面ごと移る方式(redirect)+ PKCE**。
- 戻り先は**本体ではなく専用の静的ページ**(`oauth-return.html`): `code` と `state` を受け、`state` を確かめて `BroadcastChannel` / `sessionStorage` で本体へ渡し、
  クエリの無い本体の URL へ戻す。本体はクエリを読まない(フラグの規則を守る。抜け穴を作らない)。⚠ この方式自体は実機で未確認(**未確認**)。

## 2. 鍵(認証情報)の安全な持ち方

### 2.1 何から守るか

| 脅威 | 守れるか | どうするか |
|---|---|---|
| 端末のディスク・ブラウザのデータを丸ごと写された | ○ | 鍵は **取り出せない(non-extractable)暗号鍵** で暗号化して IndexedDB に置く。暗号鍵そのものは IndexedDB の外へ出ない([WebCrypto の structured clone](https://lists.w3.org/Archives/Public/public-webcrypto/2012Dec/0024.html)) |
| バックアップ・設定ファイル・差分ファイル・メッセージに混ざる | ○ | **どこにも書き出さない**(`SKIPPED_KEYS` と同じ扱い + 書き出しの検査に「鍵の置き場の名前が出ない」を足す) |
| **同じ origin の別のページ**(`https://<user>.github.io` は**同じ user の全部の repo のページで共有**) | △ | 取り出せない鍵でも**使う(復号を呼ぶ)ことはできる**。🔴 画面で注意を出し、**独自ドメインか同期専用の公開先**を勧める |
| アプリ自身の XSS | △ | 同上。HTML の箱(`html-sandbox.ts`)は既に外へ出られない(`connect-src 'none'`)。鍵を読むのは同期の係だけにする |
| 置き場の事業者が中身を読む | ○ | **中身をエンドツーエンドで暗号化**(§2.3) |
| 鍵が漏れたときの被害 | ○ | **最小の権限**: R2 はバケット限定の API トークン、S3 は 1 つの接頭辞だけの IAM、Dropbox は App folder、WebDAV はアプリ用パスワード |

### 2.2 推薦する持ち方

1. 既定: 鍵(アクセスキー・アプリ用パスワード・refresh token)を **AES-GCM で暗号化**し、暗号鍵は取り出せない `CryptoKey` として同じ IndexedDB に置く。
   起動したら自動で使える(無人同期が回る)。
2. 任意: **パスフレーズで包む**(PBKDF2-SHA256。WebCrypto の標準だけで組める。Argon2 は WebCrypto に無い ── [WICG proposals#59](https://github.com/WICG/proposals/issues/59))。
   このときは開くたびに 1 度パスフレーズを入れる(入れるまで同期は待つ)。
3. 任意・後回し: WebAuthn PRF で鍵を作る(Safari 18 以降などで対応だが、端末をまたぐと不安定との報告 ── [caniuse](https://caniuse.com/mdn-api_credentialscontainer_create_publickey_option_extensions_prf) / [Apple forums](https://developer.apple.com/forums/thread/774112))。前提にはしない。
4. **外す道を必ず置く**(片道にしない): 「この置き場との接続を外す」で鍵を消し、Dropbox なら token の失効も呼ぶ。
5. ブラウザが消す: Safari は `navigator.storage.persist()` に対応(17 以降。許すかは判定しだい ── [WebKit](https://webkit.org/?p=14403))。鍵が消えたら「接続し直す」を出すだけ(ノートは消えない)。

### 2.3 中身の暗号化(エンドツーエンド)

- 差分ファイル(zip)を作った**後**に AES-256-GCM で暗号化して置く。データ鍵は乱数で作り、パスフレーズから作った鍵で包んで置き場に置く
  (全端末で同じパスフレーズを入れる)。IV はファイルごとに乱数、ファイル名・端末 id・連番を AAD に入れて差し替えを見破る。
- 費用: 暗号化はブラウザの内蔵(WebCrypto)で、通信に比べて小さい(実測は実装時)。増えるのは 1 ファイルあたり数十バイト。
- 失う物: 置き場の側でのプレビュー。パスフレーズを失うと戻せない → **回復用の鍵を書き出す画面**を置く。
- 推薦: S3 互換・Dropbox では**既定オン**、自前の WebDAV では任意。

## 3. 自動同期のタイミングと競合

### 3.1 いつ回すか

- ブラウザの背景実行(Background Sync / Periodic Background Sync)は **Chromium だけ**で、Periodic はインストール済み PWA が前提
  ([caniuse](https://caniuse.com/wf-periodic-background-sync) / [web.dev](https://web.dev/articles/web-apps/periodic-background-sync))。
  iOS には背景実行の口が無い(**未確認**の一般知識)。→ **画面が開いている間だけ回す**(段 3 と同じ)。
- 回す合図: 起動時 / 画面に戻ったとき(`visibilitychange`)/ 通信が戻ったとき(`online`)/ 保存の後(30〜60 秒まとめて)/ 画面に出ている間の定期(既定 5 分)/ 「今すぐ同期」。
- 失敗が続けば間隔を延ばす(段 3 の `backoffMinutes`。上限 60 分)。通信が無い間は回さない。データ節約(`saveData`)なら間隔を延ばす(対応状況は**未確認**)。
- ワークスペースごとに 1 つ(Web Locks ── Safari 15.4+ / Firefox 96+ / Chromium。[caniuse](https://caniuse.com/wf-web-locks))。

### 3.2 置き場の形(段 3 と同じ「端末ごとの出し箱」)

```
<置き場>/pkc3/<ワークスペースの同期 ID>/
  pkc3-<端末 id A>.pkc3-diff.zip(.enc)   ← A だけが書く
  pkc3-<端末 id B>.pkc3-diff.zip(.enc)   ← B だけが書く
  keyring.json                           ← 中身の暗号化のデータ鍵(パスフレーズで包む。E2E のときだけ)
```

- **共有して書き換えるファイルを作らない** ── 書き込みがぶつからない。自分のファイルの上書きは `If-Match: <前に書いた ETag>`(S3 / R2 / MinIO で原子的 ──
  [AWS 2024-11](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes) / [R2](https://developers.cloudflare.com/r2/api/s3/conditional-operations/))。
  412(合わない)= **同じ端末 id の別の端末が書いた**(DB の複製)→ 段 3 と同じく書かずに止まり、手で同期したときに確認する。
  ⚠ Backblaze B2 は `If-None-Match` を送らない回避が要るという二次情報がある(**未確認**)── 雛形の対象から外すか、条件なしで書いて ETag で後から確かめる。
- 変わったかは ETag で見る(段 3 の「大きさ・更新日時」の代わり)。一覧は S3 の ListObjectsV2(2020-12 から強い整合 ──
  [AWS](https://aws.amazon.com/about-aws/whats-new/2020/12/amazon-s3-now-delivers-strong-read-after-write-consistency-automatically-for-all-applications))/
  WebDAV の PROPFIND(Depth 1、`getetag`)。R2 の一覧の整合は**未確認**。
- 「ワークスペースの同期 ID」: 最初に置き場をつないだ端末が乱数で作り、他の端末は「この置き場の、どのワークスペースとそろえるか」を選ぶ(段 2 の対応づけ = `pairs` と同じ確認)。
- 古い端末のファイル: 180 日以上更新が無い端末を設定に並べ、「この端末のファイルを消す」で消せる(自動では消さない)。

### 3.3 競合

- 判定は段 1・2 の核そのまま(内容の指紋の三者比較。**時計は使わない**)。両方で変えたら**両方残す**(競合のコピー)。消した側と変えた側は消さない。
- 段 3 で入れた、相手ごとの記録(`peerBases`)・全件の頼み(`want`)・確認済みの対応(`pairs`)をそのまま使う。
- 無人の回は確認を出さない(初めての相手・端末 id の重複は「今すぐ同期」で確認)── 段 3 と同じ。

## 4. 段階(1 段 = 1 PR)

| 段 | 中身 | 規模 |
|---|---|---|
| 4a | 置き場の口(`RemoteBox`)で段 3 の `SyncFolder` を一般化(フォルダも同じ口に載せ替え)。鍵の保管(暗号化 + 任意のパスフレーズ)。**S3 互換**(SigV4 の署名。依存は小さな実装か `aws4fetch`)・CORS の雛形・接続の確認。作り物のサーバで smoke | L |
| 4b | 中身の暗号化(E2E)と回復用の鍵 | M |
| 4c | **WebDAV**(PROPFIND / PUT / DELETE。Nextcloud の案内) | M |
| 4d | **Dropbox**(PKCE + 受け口ページ + App folder + token の失効)。配布者の app key の登録が要る | M |
| 4e(任意) | OneDrive(24 時間ごとにログインし直す前提) | M |
| 見送り | Google ドライブ(無人にならない)・remoteStorage(事業者が少ない)・P2P(同時起動が要る) | - |

## 5. 裁定が要る点(画面で何が起きるか)

| # | 論点 | 選択肢 | 推薦 |
|---|---|---|---|
| 1 | 最初の通信先 | A: S3 互換 + WebDAV / B: Dropbox から / C: 両方同時 | **A**(無人で回り続けられ、バックエンドも app 登録も要らない。user が持つ置き場を使える) |
| 2 | 鍵の持ち方 | A: 端末で暗号化して保存(開けば自動で回る)/ B: 開くたびにパスフレーズ / C: 毎回入力 | **A を既定、B を任意**(C は無人にならない) |
| 3 | 中身の暗号化 | A: クラウド事業者では既定オン / B: いつも任意 / C: しない | **A**(パスフレーズと回復用の鍵が要る) |
| 4 | 同じ origin の注意 | 設定に「同じ GitHub Pages の他のページからも鍵が使える。独自ドメインを勧める」を出すか | **出す** |
| 5 | Dropbox(4d)を作るか | 配布者が Dropbox の開発者登録をして app key を埋める必要がある | **4a〜4c の後に作る** |
| 6 | OAuth の戻り口 | A: 専用の静的ページ / B: 本体のクエリで受ける | **A**(クエリをフラグ以外に使わない規則を守る) |

## 6. リスク・未確認

- OAuth の redirect が COOP の下で問題なく動くか(仕様からの推論。実機で確かめる)。
- R2 の一覧の整合、B2・Wasabi の条件付き書き込み、ownCloud・Synology の CORS(**未確認**)。
- iOS の Safari で画面が隠れた直後に通信が切られる時間(同期の途中で切れても、段 1〜3 の 1 回の tx・ファイル単位の上書きで壊れない作りにする)。
- 置き場の料金(R2 の外向き転送が無料かは**未確認**)。
- 同じ origin を共有する他の repo のページからの読み取り(§2.1)── 独自ドメインでない限り根本では防げない。

## 7. 出典(2026-11-21 に確認。Google・Dropbox の一次文書は本文を取得できず、検索の抜粋で確かめた範囲)

- COEP / COOP: [MDN COEP](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy) / [MDN COOP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cross-Origin-Opener-Policy) / [Chrome: credentialless](https://developer.chrome.com/blog/coep-credentialless-origin-trial) / [Google: GIS と COOP](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)
- CORS の `Authorization`: [MDN Access-Control-Allow-Headers](https://developer.mozilla.org/docs/Web/HTTP/Headers/Access-Control-Allow-Headers)
- WebDAV: [nextcloud/server#3131](https://github.com/nextcloud/server/issues/3131) / [WebAppPassword](https://apps.nextcloud.com/apps/webapppassword) / [Nextcloud フォーラム](https://help.nextcloud.com/t/access-nextcloud-data-from-an-external-web-app-single-page-application/141866) / [WebKit #45943](https://bugs.webkit.org/show_bug.cgi?id=45943) / [rclone serve webdav](https://rclone.org/commands/rclone_serve_webdav)
- S3 互換: [AWS CORS](https://docs.aws.amazon.com/AmazonS3/latest/dev/cors-troubleshooting.html) / [AWS SDK の ETag](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/cors.html) / [AWS 条件付き書き込み 2024-08](https://aws.amazon.com/about-aws/whats-new/2024/08/amazon-s3-conditional-writes) / [同 2024-11](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes) / [R2 条件付き操作](https://developers.cloudflare.com/r2/api/s3/conditional-operations/) / [R2 + aws4fetch](https://developers.cloudflare.com/r2/examples/aws/aws4fetch) / [MinIO 互換表](https://docs.min.io/aistor/developers/s3-api-compatibility/) / [B2 の CORS](https://www.backblaze.com/docs/cloud-storage-enable-cors-with-the-s3-compatible-api) / [B2 の条件付き書き込み(二次情報)](https://lists.proxmox.com/pipermail/pbs-devel/2025-July/014234.html) / [S3 の強い整合](https://aws.amazon.com/about-aws/whats-new/2020/12/amazon-s3-now-delivers-strong-read-after-write-consistency-automatically-for-all-applications)
- Dropbox: [offline access](https://dropbox.tech/developers/using-oauth-2-0-with-offline-access) / [secret 無しの refresh](https://www.dropboxforum.com/discussions/101000014/using-refresh-token-without-client-secret/584036) / [SDK README](https://cdn.jsdelivr.net/npm/dropbox@10.46.0/README.md) / [CORS の事前確認の回避の不具合](https://www.dropboxforum.com/discussions/101000042/cors-pre-flight-workaround-is-giving-us-400-errors/672538) / [rev による更新](https://www.dropboxforum.com/discussions/101000014/dropbox-api-conflicted-copy/324605)
- Google ドライブ: [appdata](https://developers.google.com/workspace/drive/api/guides/appdata) / [ブラウザだけのアプリと refresh token](https://developers.google.com/identity/oauth2/web/guides/how-user-authz-works)
- OneDrive: [SPA の refresh token は 24 時間](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens) / [App folder](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder) / [If-Match](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession)
- remoteStorage: [IETF draft](https://datatracker.ietf.org/doc/draft-dejong-remotestorage/)
- 鍵: [WebCrypto の鍵の保存](https://lists.w3.org/Archives/Public/public-webcrypto/2012Dec/0024.html) / [WebKit の SW での DataCloneError](https://bugs.webkit.org/show_bug.cgi?id=183167) / [PasswordCredential は Chromium だけ](https://caniuse.com/mdn-api_passwordcredential) / [WebAuthn PRF](https://caniuse.com/mdn-api_credentialscontainer_create_publickey_option_extensions_prf) / [Argon2 は WebCrypto に無い](https://github.com/WICG/proposals/issues/59) / [github.io は別々の site](https://github.blog/2013-04-09-yummy-cookies-across-domains/) / [Safari の persist](https://webkit.org/?p=14403) / [ITP の 7 日](https://webkit.org/blog/11338/cname-cloaking-and-web-privacy/)
- タイミング: [Periodic Background Sync](https://caniuse.com/wf-periodic-background-sync) / [web.dev](https://web.dev/articles/web-apps/periodic-background-sync) / [Web Locks](https://caniuse.com/wf-web-locks)
