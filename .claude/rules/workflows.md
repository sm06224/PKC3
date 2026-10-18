---
paths: [".github/**", "scripts/**", "build/**"]
---

# workflow・スクリプト・ビルドを触るときの規律

正本の 10 型は `CLAUDE.md` §6。ここは `.github/**`・`scripts/**`・`build/**` を変更するときの要点。

## 1. 手元と CI の環境差

- **ブラウザバイナリの差**:
  - 手元は `/opt/pw-browsers/chromium`（フル Chromium）、CI は `chromium_headless_shell` が動くことがある。
  - `window.print()` はフル Chromium では `beforeprint` のみ、`headless_shell` では `beforeprint` + `afterprint` を同期発火する。印刷やブラウザ固有挙動の smoke は `beforeprint` 時点で観測するなど両環境で成立する形にする。
- **`$GITHUB_ENV` のスコープ**:
  - GitHub Actions で `$GITHUB_ENV` に書いた変数は以降の全 step に効く。特定の step にだけ効かせたい環境変数（`PKC3_CHROMIUM` 等）は step の `env:` で渡す。
- **CI の自動実行制限**:
  - フル smoke（`smoke.yml`）は手動（`workflow_dispatch`）のみ。`on:` に `push` / `pull_request` / `schedule` を足してはならない（`tests/workflow-steps.test.ts` が検査）。

## 2. shell と CI の終了コード・プロセス管理

- **終了コードを消さない**:
  - `cmd | tail -40` や `{ cmd > out.log 2>&1; echo "done"; }` は最後のコマンドの終了コード（`0`）を返してしまう。ログを絞るときはファイルに書き出し、コマンド自体の終了コードを保持する。
  - CI の条件付き実行に `[ -f X ] && cmd || true` を使わない（`cmd` の失敗まで握り潰す）。`if [ -f X ]; then cmd; fi` と書く。
- **`pkill` / `pgrep` の自己巻き込み防止**:
  - `pkill -f "pattern"` や `/proc/*/cmdline` 走査は、実行中のシェル自身のコマンドラインにマッチして `exit 144` で自爆することがある。ポート番号（`ss -ltnp`）で引くか、`$$` と `$PPID` を除外する。

## 3. 上流資産（LibreOffice wasm 等）と配布物の検品

- **ファイル実在ではなくビルド登録を読む**:
  - 上流の同梱対象を数えるときはファイルシステムの存在ではなく、`UIConfig_*.mk` 等のビルド登録を読み、実際に生成された `soffice.data.js.metadata` と集合で突合する。
- **配布検品（`pages.yml` / `check-dist.mjs`）の後方互換**:
  - `pages.yml` は `/` に過去の安定 release tag の zip、`/dev/` に `main` HEAD を配置する。
  - 新しい生成物検査を `check-dist.mjs` に追加するときは、過去の release zip 検品まで赤くして `/dev/` 配信を止めないよう、新規要求はフラグで opt-in にするか `main` ビルド側にのみ適用する。
