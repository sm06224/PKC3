# 実物の RTF(独立した産み手が書いたもの)

🔴 **自分で書いた fixture は、実装と同じ盲点を持つ**(CLAUDE.md §1)。
だからここには**別の産み手が実際に出力した RTF** を置く。

| file | 何 |
|---|---|
| `libreoffice-ai-answer.source.html` | 生成 AI の回答を模した HTML(見出し / 箇条書き / 表 / コード / リンク / 飾り) |
| `libreoffice-ai-answer.rtf` | それを **LibreOffice 24.2 が RTF へ書き出した実物** |

## 作り直し方

```
soffice --headless --convert-to 'rtf:Rich Text Format' --outdir . libreoffice-ai-answer.source.html
```

⚠ `libreoffice-writer` が要る(`libreoffice-core` だけだと filter が無い)。

## 🔴 この 1 本が暴いた欠陥(2026-08-25。自作 fixture では 1 件も出なかった)

| 何 | 実物はどう書いていたか |
|---|---|
| **日本語の太字が丸ごと落ちる** | `<b>` を **`\ab`**(複合文字側の属性)で書く。`\b` しか読んでいなかった |
| **コードが 1 つも囲まれない** | `Courier New` を **`\fnil\fprq0`**(等幅の宣言なし)で書く |
| **表とふつうの文が丸ごとコードになる** | `\plain` が**フォントを戻していなかった**ので、コード段落の等幅が後ろへ持ち越された |
| **行内コードが平文になる** | 行内コードは**文字スタイル `\cs18`(名前 `Source Text`)**で書く |
| **見出しが `# **題**` になる** | 見出しのスタイルが太字を持つ(二重に掛かる) |
| **表の見出し行が空になる** | `\trhdr` は書かず、**スタイル名 `Table Heading`** で表す |
| **リンクが `[:字:underline:](url)` になる** | リンクのスタイルが下線を持つ(二重に掛かる) |
