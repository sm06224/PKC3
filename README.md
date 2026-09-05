# PKC3

[PKC2](https://github.com/sm06224/PKC2) の後継となるメジャーバージョンアップ。
ストレージ(wasm-sqlite)の刷新を最重点に、PKC2 の成果である可搬式埋め込み形式・
エクスポート形式・PKC-Markdown・基本機能を維持する。

ブラウザだけで動くノートアプリ(PWA)。サーバーに何も送らない ──
データは OPFS 上の SQLite と IndexedDB に置かれる。

## 使う

| | どこ | 中身 |
|---|---|---|
| **製品版** | <https://sm06224.github.io/PKC3/> | いちばん新しい**安定タグ**の中身 |
| **開発版** | <https://sm06224.github.io/PKC3/dev/> | `main` の先頭。新しい代わりに壊れていることがある |

⚠ **2 つは別のデータを持ちません** ── 同じ origin なので、同じ OPFS / IndexedDB を
見ます。片方で作ったノートはもう片方にも出ます。
⚠ 製品版はタグを出したときだけ更新されます。**開発版と離れることがあります**。

- 📖 **[マニュアル](./docs/manual.md)** ── 作る・書く・書き出す・取り込む・更新
- 📜 **[変更のあゆみ](./CHANGELOG.md)** ── アプリのお知らせに出した内容(全部)
- 🚚 **[PKC2 からの移行ガイド](./docs/migration-from-pkc2.md)** ── 何がどう変わるか、何が落ちるか

## 対応ブラウザ

**フル機能は Chromium 系(Chrome / Edge)。** それ以外は**部分機能**です
(user 裁定 2026-08-10「ブラウザ的にはどれか一つがフル機能使えて、それ以外は部分機能対応と
しましょう」)。

🔴 **この表は「確かめたか」を書きます。**「仕様上は動くはず」を ✅ にはしません ──
自動検証(smoke / probe)は **Chromium の 2 つのビルドだけ**で回しており、
Firefox / Safari では**一度も走らせていない**からです。

| 機能 | Chrome / Edge | Firefox | Safari | 必要な土台 |
|---|:---:|:---:|:---:|---|
| ノートの作成・編集・閲覧 | ✅ | ❓ | ❓ | ─ |
| 保存(OPFS SAHPool + SQLite) | ✅ | ❓ | ❓ | OPFS の同期アクセスハンドル |
| 添付(IndexedDB Blob) | ✅ | ❓ | ❓ | IndexedDB |
| 図(Mermaid → PNG ラスタ) | ✅ | ❓ | ❓ | canvas(**主スレッド**。理由は下記) |
| グラフ(chart → PNG ラスタ) | ✅ | ❓ | ❓ | OffscreenCanvas(ワーカー) |
| 書き出し / 取り込み(zip) | ✅ | ❓ | ❓ | ─ |
| 印刷・PDF | ✅ | ❓ | ❓ | ─ |
| オフライン(PWA) | ✅ | ❓ | ❓ | Service Worker |
| 外部画像(同意つき) | ✅ | ❓ | ❓ | ─(分離が無い環境でも通常どおり出ます) |
| **Office 表示・編集**(LibreOffice wasm) | ✅ | ❌ | ❌ | **JSPI** + SharedArrayBuffer |

凡例: ✅ 実際に動かして確かめた / ❓ **未検証**(動かないという意味ではありません) /
❌ 土台が無いので動かない(理由は下記)

### なぜそうなるか

- **Office は JSPI(WebAssembly の Promise 統合)を要求します。** この LibreOffice は
  `--enable-emscripten-jspi` で焼いており、Qt6 の wasm plugin が DOM を直に触るため
  worker へ逃がせません([経緯](./docs/development/office-wasm-selection-2026-08.md))。
  **手元で確認できたのは Chromium(141)のみ**です。
- **`SharedArrayBuffer` に cross-origin isolation が要ります。** PKC3 は
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless`
  を返します。⚠ `require-corp` ではなく `credentialless` を選んだのは、
  **`require-corp` だと CORP を返さない外部画像が全部消える**からです(実測):

  | COEP | 分離 | SharedArrayBuffer | 外部画像(CORP 無し) |
  |---|:---:|:---:|:---:|
  | (なし) | ✕ | ✕ | OK |
  | `require-corp` | ✓ | ✓ | **ブロック** |
  | **`credentialless`** | **✓** | **✓** | **OK** |

  Safari は `credentialless` に未対応のため、分離が成立せず Office が動きません。
  外部画像は分離が無ければ普通に出ます。
- **Office は既定では入っていません。** 使う人が設定画面で明示的に有効化したときだけ、
  約 77MB の一式を 1 回だけ取得して IndexedDB に置き、以降はローカルから起動します
  ([設計](./docs/development/office-wasm-integration-design-2026-08.md))。
  ⚠ 一式を配っているのは**別のリポジトリの Pages**(`sm06224/office-pack`)ですが、
  置き場は `https://sm06224.github.io/office-pack/` ── PKC3 本体と**同じ origin** です。
  だから CORS が起きません(別 origin に置くと `fetchPackFromBase` が弾きます)。
  ⚠ 参照は **origin 直下の絶対 path** で書いてあります ── 相対 path にすると
  `/PKC3/` と `/PKC3/dev/` で深さが違い、開発版だけ 404 になります(2026-08-11 に踏みました)。
- **図(mermaid)とグラフ(chart)は土台が違います。** chart.js は canvas に描くので
  `OffscreenCanvas` で**丸ごとワーカーへ逃がせます**が、mermaid は SVG を吐くうえに
  レイアウトで DOM を要求するので**主スレッドから外せません**。どちらも結果は
  **PNG に焼いて IndexedDB に置き**、画面には `<img>` 1 枚として出します
  (user 指示 2026-08-03「描いたら焼く」)。

## 開発

- **現況**: v3.2.0 を 2026-08-29 に公開済み(`package.json` の版と同じ。tag は
  `v3.0.0` 2026-08-03 / `v3.1.0` 2026-08-19 / `v3.2.0` 2026-08-29)。以降の是正・機能追加は
  `main` へ積んでいます(**製品版のタグと `main` は離れます** ── 上の表を参照)
- **設計 doc(founding doc)**: [`docs/development/pkc3-major-upgrade-design-2026-07.md`](./docs/development/pkc3-major-upgrade-design-2026-07.md)
- **残件の台帳は GitHub Issues** ── doc に「やることの一覧」は置きません
  (user 指示 2026-08-15。doc に書いてよいのは**設計と根拠**だけ)
- PKC2 リポジトリは参照のみ(read-only)。PKC3 の開発はすべて本リポジトリで行う

```bash
npm run dev        # Vite dev server
npm run build      # Vite build → dist/
npm test           # vitest run
npm run test:smoke # playwright(実ビルドを preview して検品)
npm run build:portable # 持ち歩ける HTML 1 枚の雛形(dist-portable/pkc3.html)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src tests build scripts
```

### CI

| いつ | 何を |
|---|---|
| PR / main push | `audit`(依存の脆弱性監査 ── prod 依存の high 以上で止める)/ `verify`(型 / lint / unit / build / 生成物の検品)/ `smoke`(実ブラウザ。spec を 3 つの shard に割って並列)── 3 種を**並列**に。どれも 10 分の timeout が速度予算の tripwire |
| nightly | smoke を**2 つの Chromium ビルド**で / 図の全数(マニュアルの 22 種が焼けるか)/ product ビルドの検品と smoke(PR gate が触らない成果物)/ Rust wasm の再ビルド一致 / probe 6 本(`Probe — store` / `Probe — sahpool` / `Probe — sidebar` / `Probe — editor / live` / `Probe — editor / split` / `Probe — schedule`)/ 赤い間は issue に積む |
| tag(`v*`)または `workflow_dispatch` | release(SBOM / provenance / `pkc3-dist.zip` ── 中に `portable-template.html` も入る)→ Pages の `/` が入れ替わる |
