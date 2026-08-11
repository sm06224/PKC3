# PKC3

[PKC2](https://github.com/sm06224/PKC2) の後継となるメジャーバージョンアップ。
ストレージ(wasm-sqlite)の刷新を最重点に、PKC2 の成果である可搬式埋め込み形式・
エクスポート形式・PKC-Markdown・基本機能を維持する。

ブラウザだけで動くノートアプリ(PWA)。サーバーに何も送らない ──
データは OPFS 上の SQLite と IndexedDB に置かれる。

## 使う

- 📖 **[マニュアル](./docs/manual.md)** ── 作る・書く・書き出す・取り込む・更新
- 🚚 **[PKC2 からの移行ガイド](./docs/migration-from-pkc2.md)** ── 何がどう変わるか、何が落ちるか

## 対応ブラウザ

**フル機能は Chromium 系(Chrome / Edge)。** それ以外は**部分機能**で動きます
(user 裁定 2026-08-10「ブラウザ的にはどれか一つがフル機能使えて、それ以外は部分機能対応と
しましょう」)。⚠ **落ちるのは Office 表示だけ**で、ノートを書く・読む・書き出す・
取り込むといった本体機能はどこでも動きます。

| 機能 | Chrome / Edge | Firefox | Safari | 必要な土台 |
|---|:---:|:---:|:---:|---|
| ノートの作成・編集・閲覧 | ✅ | ✅ | ✅ | ─ |
| 保存(OPFS SAHPool + SQLite) | ✅ | ✅ | ✅ | OPFS |
| 添付(IndexedDB Blob) | ✅ | ✅ | ✅ | IndexedDB |
| 図(Mermaid → PNG ラスタ) | ✅ | ✅ | ✅ | OffscreenCanvas |
| 書き出し / 取り込み(zip) | ✅ | ✅ | ✅ | ─ |
| 印刷・PDF | ✅ | ✅ | ✅ | ─ |
| オフライン(PWA) | ✅ | ✅ | ✅ | Service Worker |
| 外部画像(同意つき) | ✅ | ✅ | ✅ | ─(分離が無い環境でも通常どおり出ます) |
| **Office 表示・編集**(LibreOffice wasm) | ✅ | ⚠️ | ❌ | **JSPI** + SharedArrayBuffer |

凡例: ✅ 動く / ⚠️ 環境や版に依存(下記) / ❌ 動かない

### なぜそうなるか

- **Office は JSPI(WebAssembly の Promise 統合)を要求します。** この LibreOffice は
  `--enable-emscripten-jspi` で焼いており、Qt6 の wasm plugin が DOM を直に触るため
  worker へ逃がせません([経緯](./docs/development/office-wasm-selection-2026-08.md))。
  **手元で確認できたのは Chromium(141)のみ**です ── Firefox / Safari は
  JSPI の対応状況に依存し、**未検証**です(推測で ✅ とは書きません)。
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

## 開発

- **現況**: P7(v3.0.0 = Pages product + PWA 仕上げ)
- **設計 doc(founding doc)**: [`docs/development/pkc3-major-upgrade-design-2026-07.md`](./docs/development/pkc3-major-upgrade-design-2026-07.md)
- **P7 設計 doc**: [`docs/development/p7-product-release-design-2026-08.md`](./docs/development/p7-product-release-design-2026-08.md)
- PKC2 リポジトリは参照のみ(read-only)。PKC3 の開発はすべて本リポジトリで行う

```bash
npm run dev        # Vite dev server
npm run build      # Vite build → dist/
npm test           # vitest run
npm run test:smoke # playwright(実ビルドを preview して検品)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src tests build scripts
```
