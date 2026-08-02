# PKC2 の実体 fixture(2026-08-02 生成)

**PKC2 の writer を直接動かして作った本物の書出し。** 合成 fixture では出せない
性質(日本語ファイル名 / 内側 ZIP の実バイト列 / manifest の実際の field 集合)を
ここで検証する。

⚠ **PKC2 のソースは一切変更していない**。ビルド産物(`dist/pkc2.html`)は
生成後に `git checkout` で復元済み。

## 作り直す手順

```bash
cd /path/to/PKC2 && npm run build        # dist/ が汚れる
cd /path/to/PKC2 && npx tsx <gen-fixtures.ts>   # ← cwd は PKC2(@features/* の path alias 解決のため)
cd /path/to/PKC2 && git checkout -- dist/       # 元に戻す
```

生成スクリプトは PKC2 の `buildPackageZip` / `buildTextBundle` /
`buildTextsContainerBundle` / `buildTextlogsContainerBundle` /
`buildMixedContainerBundle` / `buildFolderExportBundle` / `buildEntryBundle` を
実データ形の container(フォルダ階層 + 共有添付 + 履歴 + 各 archetype)に対して呼ぶ。

⚠ **top-level await は使えない**(tsx が cjs 出力にするため)── `async function main()` で包む。

## 中身

| ファイル | 形式 | 段 |
|---|---|---|
| `package.pkc2.zip` | `pkc2-package` | ② |
| `single.text.zip` | `pkc2-text-bundle` | ③前半 |
| `single.textlog.zip` | `pkc2-textlog-bundle` | ③後半 |
| `texts-container.zip` | `pkc2-texts-container-bundle` | ④ |
| `textlogs-container.zip` | `pkc2-textlogs-container-bundle` | ④ |
| `mixed-container.zip` | `pkc2-mixed-container-bundle` | ④ |
| `folder-export-v1.zip` | `pkc2-folder-export-bundle`(v1) | ⑤ |
| `folder-export-v2.zip` | `pkc2-folder-export-bundle`(v2、`.entry.zip` 入り) | ⑤ |
| `single.entry.zip` | `pkc2-entry-bundle` | ⑥(**未受理**) |

## 旧版の writer が要るので実体を作れないもの

- 2026-04-12 以前の mtime 0/0 な `.pkc2.zip`
- `folders[]` を持たない旧 `.folder-export.zip`
- legacy inline `data` 入り attachment

→ 合成 fixture で代替したまま。
