# PKC3

[PKC2](https://github.com/sm06224/PKC2) の後継となるメジャーバージョンアップ。
ストレージ(wasm-sqlite)の刷新を最重点に、PKC2 の成果である可搬式埋め込み形式・
エクスポート形式・PKC-Markdown・基本機能を維持する。

ブラウザだけで動くノートアプリ(PWA)。サーバーに何も送らない ──
データは OPFS 上の SQLite と IndexedDB に置かれる。

## 使う

- 📖 **[マニュアル](./docs/manual.md)** ── 作る・書く・書き出す・取り込む・更新
- 🚚 **[PKC2 からの移行ガイド](./docs/migration-from-pkc2.md)** ── 何がどう変わるか、何が落ちるか

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
