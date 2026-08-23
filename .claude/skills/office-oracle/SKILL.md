---
name: office-oracle
description: PKC の Office(LibreOffice wasm)を手元に立てて、文書が本当に開くかを測る手順。「Office で開かない」「LO wasm」「#199」「#238」「docx が空のまま」「実機でしか確かめられない」という文脈で必ず使う。⚠ 「この箱では確かめられない」と書く前に必ずここを読む。
---

# Office(LO wasm)のオラクルを手元に立てる

> 🔴 **2026-08-17 に確立。** それまで「実機でしか確かめられない」と書いていたが、
> **手元で立つ**。user 指摘「**githubから引っぱればいいじゃん**」で分かった。

## 0. まず「取れない」と書く前に

⚠ 2026-08-17 に **2 回続けて誤った結論**を書いた:

1. 「Pages から取れない(`000`)/ git にも pack は無い」→ **原理的に測れない**と書いた
2. その後 `/tmp` の残骸で立ったので「**実物が残っていたから立った**」と書いた
   ── つまり「**次からは取れない**」と読める形で残した

**どちらも誤り。** 正しくは **release 資産を curl で引ける**。
🔑 **「取れない」と結論する前に、取り方を数え上げる** ── この箱では:

| 経路 | 結果 |
|---|---|
| `https://<user>.github.io/...`(Pages) | ❌ `000`(proxy が止める) |
| `https://github.com`(web UI の root) | ❌ `400` |
| `https://api.github.com/...`(直叩き) | ❌ 「GitHub access is not enabled for this session」 |
| `https://raw.githubusercontent.com/...` | ✅ **200** |
| **`https://github.com/<o>/<r>/releases/download/<tag>/<asset>`** | ✅ **`-L` で `release-assets.githubusercontent.com` へ追従して 200/206** |

⚠ **`--cacert /root/.ccr/ca-bundle.crt` を渡す。** 渡さずに 1 回叩いて
「駄目だ」と書いたのが 1 つ目の誤りである。

## 1. 一式を引く(85MB / 実測 1.4 秒)

```bash
curl -sSL --cacert /root/.ccr/ca-bundle.crt -o /tmp/lo-wasm-qt6.zip \
  https://github.com/sm06224/PKC3/releases/download/lo-wasm-dev/lo-wasm-qt6.zip
sha256sum /tmp/lo-wasm-qt6.zip   # release の digest と突き合わせる
```

tag と資産名は `mcp__github__get_release_by_tag`(MCP は通る)で引く。
⚠ tag は**使い回される**(release の説明にそう書いてある)ので、**digest で同一性を言う**。

## 2. 🔴 フォントを足す(足さないと弾かれる)

release の zip に **`.ttf` は 1 つも入っていない**。`assertPackComplete` が
「日本語フォントが 1 つも入っていません」で**受理しない**(意図的な門 ── 豆腐を防ぐ)。

```bash
python3 - <<'PY'
import zipfile, shutil
shutil.copyfile('/tmp/lo-wasm-qt6.zip', '/tmp/lo-pack.zip')
z = zipfile.ZipFile('/tmp/lo-pack.zip', 'a', zipfile.ZIP_STORED)
z.write('/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf', 'fonts/ipag.ttf')
z.close()
PY
```

⚠ `fonts/` の下でなくてもよい(`normalizeName` が `.ttf` を見て `fonts/` を付ける)。

## 3. 🔴 目録(`pack.json`)を手で書かない

**2026-08-17 の判定不能はこれが原因だった。** 手書きの `pack.json` を置いて probe から
読ませたら、対照群(`.odt`)まで **120 秒 canvas 0 枚**で、何も言えなくなった。

🔑 **アプリの正規の口に zip を渡す** ── 設定 → Office 一式 →「ファイルから入れる」:

```js
await page.click('[data-pkc-action="set-view"][data-pkc-view="settings"]');
await page.setInputFiles('[data-pkc-field="office-pack-input"]', ZIP);
// ⚠ 進捗の字ではなく**状態の行**で待つ(進捗は途中で消える)
// '[data-pkc-field="office-pack-status"]' が「入っています」になるまで
```

⚠ 配る側は **COI ヘッダが要る**(`Cross-Origin-Opener-Policy: same-origin` /
`Cross-Origin-Embedder-Policy: credentialless`)。`vite preview` は付ける。
自前の server で配るなら**自分で付ける** ── 付け忘れると `crossOriginIsolated` が
false になり、そもそも動かない。⚠ **`crossOriginIsolated` を最初に印字して確かめる。**

## 4. 🔴 観測点 ── 「窓が立った」と「中身が出た」は別

⚠ ここで 2 回間違えた。

- **canvas の有無では区別できない。** 空の窓にも canvas は在る(1272x656)
- **`document.querySelectorAll('canvas')` では 1 枚も見えない** ──
  Qt 6 の canvas は **shadow root の中**(`host.html` 自身が「#88 §3.11 で 1 日溶かした罠」
  と書いている)。shadow を潜って拾う
- 🔑 **版面のスクショで見る。** 空の窓は PNG が **8KB 台**、中身が出た窓は **52〜61KB**
  ── はっきり分かれるので、これを判定に使える(そのうえで**画像を実際に見る**)

```js
const deep = () => { const out = [];
  (function walk(n){ for (const el of n.querySelectorAll('*')) {
    if (el.tagName === 'CANVAS') out.push(`${el.width}x${el.height}`);
    if (el.shadowRoot) walk(el.shadowRoot); } })(document);
  return out; };
```

## 5. 🔴 腕を変えるときは、前の窓を閉じる

⚠ 対照群の Office 窓を**閉じずに**次の腕へ進んだら、**新しい窓が開かず**
(既存を再利用)、`waitForEvent('page')` が null になって **本体タブを観測していた** ──
「描かなかった」が製品の話ではなく**観測点の話**になっていた。

🔑 毎回 `ctx.pages()` を走査して `office/host.html` の窓を**閉じてから**押し、
開いた窓も **URL で掴む**(page event に頼らない)。

## 6. 対照群を必ず置く

- **`.odt`**(#199 が「無傷」と言う側)を**毎回先に**回す ──
  届かない回は、以降の判定が全部無意味
- 「同じ中身・同じ画像で入れ物だけ違う」対を作ると、引き金が割れる
  (native `soffice` で `--convert-to odt` / `docx` すれば作れる。
  ⚠ この箱には `libreoffice-core` しか無いので **`libreoffice-writer` を入れる**)

## 7. 2026-08-17 に、この手順で割れたこと(#199 / #238)

| 中身 | 入れ物 | 画像の書き方 | native LO | LO wasm |
|---|---|---|---|---|
| 文字だけ | docx | ─ | ✅ | ✅ |
| 図あり | odt | ODF | ✅ | ✅ |
| 図あり | docx | DrawingML(PKC) | ✅ | ❌ 空 |
| 図あり | docx | DrawingML(**LO 自身**) | ✅ | ❌ 空 |
| 図あり | docx | DrawingML + VML 代替(`mc:AlternateContent`) | ✅ | ❌ 空 |
| 図あり | docx | **VML のみ** | ✅ | ✅ |

🔑 **「docx + 画像」ではなく「docx + DrawingML」**が引き金である。

## 8. 🔴 配った一式の**中身**を読む(「入っていない」と書く前に)

CLAUDE.md §8 の「**コードが読む path と、配ったものの中身を全数で突き合わせる**」を
この一式でやる手順。#135 / #144 / #145 はどれも「入っているはず」で外した。

`soffice.data`(101MB の 1 本)は **`soffice.data.js.metadata` が目録**である ──
`{filename, start, end}` の一覧なので、**名前の全数**はここだけで読める:

```bash
unzip -o -q /tmp/lo-wasm-qt6.zip soffice.data.js.metadata soffice.data -d /tmp/lo-pack
python3 - <<'PY'
import json
meta = json.load(open('/tmp/lo-pack/soffice.data.js.metadata'))
by = {f['filename']: (f['start'], f['end']) for f in meta['files']}
blob = open('/tmp/lo-pack/soffice.data', 'rb')
def read(n):
    s, e = by[n]; blob.seek(s); return blob.read(e - s)
print(len(by), 'files')
print(read('/instdir/share/registry/writer.xcd')[:200])
PY
```

見る所は 3 段。**1 段でも欠ければ動かない**ので、3 つとも見る:

| 段 | 場所 | 何が分かる |
|---|---|---|
| ① 定義 | `share/registry/*.xcd` | フィルタが**宣言されているか**(`FilterService` の名前もここ) |
| ② 登録 | `program/services/services.rdb` | その実装が **UNO に登録されているか** |
| ③ 実体 | `soffice.wasm` | コードが**リンクされているか** |

⚠ **`program/services.rdb`(8KB)と `program/services/services.rdb`(190KB)は別物**。
前者には数件しか無いので、そちらだけ見て「登録されていない」と書かない。

### 🔴 wasm を grep するときは **UTF-16 でも探す**

⚠ LO の `OUString` リテラルは **UTF-16LE** で焼かれる。ASCII で grep すると
**在るものが 0 件に見える**:

```
document.xml        ascii=  0   utf16le=  4
word/document.xml   ascii=  0   utf16le=  2
```

🔑 2026-08-23 に #225 でこれを踏みかけた ── ASCII の 0 件を「Word の書き出しが
入っていない」と読むところだった(実際は**入っている**)。
`OString` / `const char[]` は ASCII なので、**両方で数える**:

```python
data = open('soffice.wasm', 'rb').read()
print(data.count(s.encode()), data.count(s.encode('utf-16-le')))
```

⚠ そして**在る / 無いは「リンクされたか」までしか言わない** ── 動くかは別である。
名前が在るのに落ちるなら、原因は**実行時**(#225 の docx がまさにこれ)。
