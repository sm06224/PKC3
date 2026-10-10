---
name: office-oracle
description: PKC の Office(LibreOffice wasm)を手元に立てて、文書が本当に開くかを測る手順。「Office で開かない」「LO wasm」「#199」「#238」「docx が空のまま」「実機でしか確かめられない」という文脈で必ず使う。⚠ 「この箱では確かめられない」と書く前に必ずここを読む。
---

# Office(LO wasm)のオラクルを手元に立てる

> 🔴 **2026-08-17 に確立。** それまで「実機でしか確かめられない」と書いていたが、
> **手元で立つ**。user 指摘「**githubから引っぱればいいじゃん**」で分かった。
>
> 事故の記録(日付・issue つき)は 3 本:[`reference/build-incidents.md`](reference/build-incidents.md)(取得・焼き・配布・詰め込み)/
> [`reference/probe-log.md`](reference/probe-log.md)(probe の実測と読み方)/
> [`reference/patch-notes.md`](reference/patch-notes.md)(LO / Qt / Emscripten への patch。時系列)。ここは手順。

## まず「取れない」と書く前に

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

🔑 Qt / LO の上流 source(`raw.githubusercontent.com`)も取れる(2026-10-05)。「取れない」と 2 回続けて誤った結論を書いた経緯(2026-08-17)は
`reference/build-incidents.md`「「取れない」と 2 回続けて誤った結論を書いた」と「Qt / LO の上流 source は raw.githubusercontent.com から取れる」。

## 一式を引く(85MB / 実測 1.4 秒)

```bash
curl -sSL --cacert /root/.ccr/ca-bundle.crt -o /tmp/lo-wasm-qt6.zip \
  https://github.com/sm06224/PKC3/releases/download/lo-wasm-dev/lo-wasm-qt6.zip
sha256sum /tmp/lo-wasm-qt6.zip   # release の digest と突き合わせる
```

tag と資産名は `mcp__github__get_release_by_tag`(MCP は通る)で引く。
⚠ tag は**使い回される**(release の説明にそう書いてある)ので、**digest で同一性を言う**。

### 調査用の焼きは別の tag へ出る

`office-wasm-build.yml` は**調査用のスイッチが入ると別の tag へ出す**。`lo-wasm-dev` を引いて「焼いたはずの物が入っていない」と読まない
(`reference/build-incidents.md`「調査用の焼きは `lo-wasm-dev` に出ない」)。

| 渡したスイッチ | tag |
|---|---|
| なし(配布用) | `lo-wasm-dev` |
| `profiling_funcs: true` | **`lo-wasm-names`** |
| `safe_heap: true` | `lo-wasm-safeheap` |
| 両方 | `lo-wasm-safeheap-names` |

🔑 tag は **`lo-wasm` + flag ごとの接尾辞**(`-safeheap` → `-names` → `-imetrace` → … → `-uevtrace` の順)で、**全部 OFF のときだけ `lo-wasm-dev`**。
**tag を推測しない** ── `mcp__github__get_release_by_tag` の body(「run NNN / commit SHA」)でその run の物かを確かめてから zip を落とす
(`reference/build-incidents.md`「tag 名は flag から合成される」)。

🔑 **検算は 1 つ: 落とした一式の `build-info.json` の `run_id` が、自分が回した run と一致するか。**
`profiling_funcs` / `safe_heap` の値もそこに書いてある ── **引いた先ではなく、
落とした物で確かめる**。

⚠ **workflow の artifact(`actions/artifacts/.../zip`)からは取れない** ── 落とし先が
`*.blob.core.windows.net` で、この箱のプロキシが **403 CONNECT** で塞ぐ(実測)。
🔑 **release 資産の経路(`github.com/.../releases/download/...`)だけが通る**ので、
「artifact が取れない = 手元で確かめられない」と読まない(上の「まず「取れない」と書く前に」の「取り方を数え上げる」)。

### 🔴 名前が本当に入っているかを、使う前に確かめる

`profiling_funcs` の焼きは**名前 section が末尾に付く**ので、先頭 40MB を見ても 0 件である
(⚠ そこで「名前が入っていない」と読みかける)。**末尾から探す**:

```bash
python3 - <<'EOF'
import os
p='/tmp/lo-named/pack/soffice.wasm'; sz=os.path.getsize(p)
f=open(p,'rb'); f.seek(max(0, sz-60_000_000)); tail=f.read()
for s in (b'SfxDispatcher', b'basctl', b'ScriptDocument', b'sfx2'):
    print(s.decode(), tail.count(s))
EOF
```

実測(名前つき): `SfxDispatcher` **47** / `basctl` **1806** / `ScriptDocument` **285** /
`sfx2` **1356**。⚠ 名前なしのビルドはここが**全部 0** になる。

### 🔴 `fetch-and-run.sh` は**古い一式を黙って使い回す**(2026-08-30 に踏みかけた)

`bash build/office-wasm/fetch-and-run.sh --fetch-only` は便利だが、
**5 つの file が揃っていれば取得を飛ばす**(`have_all`)。⚠ **焼き直した直後に走らせると、
前の一式のまま probe が回る** ── 直した症状がそのまま再現し、
**存在しない不具合を追う**ことになる。

🔑 **焼き直した後は必ず `--force` を付ける**:

```bash
bash build/office-wasm/fetch-and-run.sh --force --fetch-only
```

⚠ そして**取れたのが新しい物かを数で確かめる** ── 日付は当てにならない
(unzip は zip 内の時刻を書く)。目録の**総数**が動く:

```bash
python3 -c "
import json; d=json.load(open('/tmp/lo-wasm/soffice.data.js.metadata'))
print('総数', len(d['files']))"
```

実測: テンプレートを入れる前 **1,993** → 入れた後 **2,027**(#591)。
⚠ **この 1 行を先に走らせる**のが「どのビルドを見ているか」の確定である
(`cowork-verification` skill が外部へ頼むときに要求しているのと同じことを、
**自分の harness にも当てる**)。

## 🔴 フォントを足す(足さないと弾かれる)

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

## 🔴 目録(`pack.json`)を手で書かない

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

## 🔴 観測点 ── 「窓が立った」と「中身が出た」は別

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

## 🔴 腕を変えるときは、前の窓を閉じる

⚠ 対照群の Office 窓を**閉じずに**次の腕へ進んだら、**新しい窓が開かず**
(既存を再利用)、`waitForEvent('page')` が null になって **本体タブを観測していた** ──
「描かなかった」が製品の話ではなく**観測点の話**になっていた。

🔑 毎回 `ctx.pages()` を走査して `office/host.html` の窓を**閉じてから**押し、
開いた窓も **URL で掴む**(page event に頼らない)。

## 対照群を必ず置く

- **`.odt`**(#199 が「無傷」と言う側)を**毎回先に**回す ──
  届かない回は、以降の判定が全部無意味
- 「同じ中身・同じ画像で入れ物だけ違う」対を作ると、引き金が割れる
  (native `soffice` で `--convert-to odt` / `docx` すれば作れる。
  ⚠ この箱には `libreoffice-core` しか無いので **`libreoffice-writer` を入れる**)

引き金が割れた実測表(docx + DrawingML が空になり、VML のみ・odt は開く。2026-08-17、#199 / #238)は
`reference/probe-log.md`「2026-08-17 に、この手順で割れたこと」。

## 🔴 配った一式の**中身**を読む(「入っていない」と書く前に)

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

## 🔴 「保存できたか」の判定(2026-08-24、#225 で確立)

**`save-existing-probe.mjs <pack> <doc> <out.json> <秒>`** で測る。

```bash
PKC3_FRAMES=1 PKC3_ACCEPT='Alt+e' \
  node build/office-wasm/save-existing-probe.mjs /tmp/lo-x-pack /tmp/probe.docx /tmp/out.json 300
```

- ⚠ **`PKC3_FRAMES=1` を渡さないと `actuated` が `null`** = その回は**判定不能**
- `PKC3_ACCEPT=<鍵>` … 非 ODF は「標準のファイル形式ではありません」と**訊かれる**ので、
  答えないと保存は始まらない。🔑 **`Alt+e` は形式に依らず「この形式のままにする」**
  (Writer / Calc / Impress の 7 形式で同じだった ── 訳文の綴りが 1 つだから)
- `saveTrace` は**答える前**、`saveTraceAfterAccept` は**答えた後**。片方だけ見て
  「保存できた」と読まない

### 🔴 判定は 3 点で採る(**大きさだけを見ない**)

| 見るもの | なぜ |
|---|---|
| **mtime が動いたか** | ⚠ **`.xls` は大きさが 1 バイトも動かない**(BIFF は区画の大きさが決まっている) |
| `medium:commit a=1` | 実装側が「行き先へ移した」と言っている(`PKC3_SAVE_TRACE=1` の焼きのみ) |
| PKC が取り込んだか | `steps[].saved` ── 下流まで届いた証拠 |

⚠ **最初の打鍵(`actuators[0].landed`)が `false` の回は、保存の失敗として数えない。**
実測(9 形式スイープ): 届いた回は **8/8** で保存でき、届かなかった回は **3/3** で
保存されない ── 分かれ方が**形式ではなく計器と一致**していた。回し直せば通る。
🔑 非対称でよい:**保存が走った証拠は、どの打鍵が効いたかに依らず読める**が、
**走らなかったことは、入力が届いた対照群が無いと言えない**。
⚠ Impress は遅い ── `timeout` を 900 / probe の秒を 600 にしないと**probe ごと殺され**、
`Target page … has been closed` になる(それは「保存できない」ではない)。

### 対照群の file を作る(native の LibreOffice で)

```bash
export HOME=/tmp/fx-home; mkdir -p $HOME
soffice --headless --convert-to rtf  --outdir /tmp/fx /tmp/fx/seed.odt
soffice --headless --convert-to xlsx --outdir /tmp/fx /tmp/fx/seed.ods
```

⚠ **`--convert-to "rtf:"` と書かない**(末尾のコロンで `Error: no export filter`)。
⚠ `libreoffice-writer` / `-calc` / `-impress` が入っていること(`libreoffice-core` だけだと
**対照群も開かない** ── 上の「まず「取れない」と書く前に」)。

## 🔴 その一式が非 ODF を保存できるか(#225)

**`cui/ui/querydialog.ui` が詰め込まれているか**の 1 点で決まる。無い一式では、
非 ODF の保存が例外になり「一般的な I/O エラー」に化ける(押すまで分からない)。

```bash
python3 -c "
import json;d=json.load(open('<pack>/soffice.data.js.metadata'))
print(sum(1 for f in d['files'] if f['filename'].endswith('/cui/ui/querydialog.ui')))"
```

🔴 **完全一致で見る。** `grep -c "querydialog.ui"` は**古い一式でも 1 件返す** ──
`vcl/ui/querydialog.ui` / `recalcquerydialog.ui` / `safemodequerydialog.ui` に
満たされる(実測: 古い一式 4 つは完全一致 0 件 / 部分一致 3 件)。

## probe は固まる ── 締切と、計器の選び方

| やること | 手順 | 記録(`reference/probe-log.md`「probe は固まる」) |
|---|---|---|
| 全体の締切を張る | Playwright の `page.evaluate()` に既定の締切は無く、固まった `await` は例外も `finally` も出さない(JSON が 1 バイトも書かれない)。`build/office-wasm/probe-watchdog.mjs` の `armWatchdog({ result, out: OUT, limitSec: LIMIT_SEC + 600, browser: () => browser })` を張り、段ごとに `wd.mark('段の名前')`、正常に終わったら `wd.disarm()`。`result.error` だけに書かない(`timedOutError` / `timedOutPhase` という自分の欄を持つ) | 「全体の締切を張る」(2026-08-30、#625) |
| 保存を見たい | **`save-existing-probe.mjs` を使う**。`open-doc-probe.mjs` の打鍵の門は保存が通らない回が多く(打鍵そのものは画面に出る)、保存が絡む判定には使えない。保存に依らない観測点(版面が変わったか)なら信用できる | 「保存を見たいなら `save-existing-probe` を使う」 |
| 保存に依らない判定 | `PKC3_FRAMES=1` で `paste.screen.verdict`(版面が変わったか)を採る。`paste.verdict`(file の中に字が在るか)とは**別の主張** | 「版面で採る」 |
| 固まった回を「できなかった」と読まない | 門を 3 か所(押した後 / 打鍵の後 / 貼る直前)に置き、`page.evaluate('1')` を 8 秒で競走。返らなければ `paste.wedgedAt` を立て、**両方の判定を「判定不能(版面が固まった)」で塗る**。撮る所も競走(20 秒)。`evaluate` は返るのに `Ctrl+S` / `Ctrl+V` が効かない形は門を素通りする ── **保存が来なかった回は、それ自体を「読めない回」の印として数える** | 「固まった回を「できなかった」と読まない」 |

## 版面を押すと 2 回に 1 回落ちる ── 「押した後の結論」は全部弱い

押す腕は 10 回中 5 回で `memory access out of bounds`(押す段の開始から 0.65〜0.72 秒後)、押さない腕は 0 回(2026-08-30、LO 26.8、`reference/probe-log.md`「版面を押すと 2 回に 1 回落ちる」)。
落ちた後は**半分だけ生きている**(素の字は版面に出るが、修飾キーを伴う入力 `Ctrl+S` / `Ctrl+V` / `Alt+E` は死ぬ)ので「動いている」ように見える。

1. 🔴 **押す必要がないなら押さない。** メニューは `Alt+キー` で押さずに開く(`PKC3_MENU_NO_CLICK=1`)。開いた直後の caret は本文の先頭なので押さずに打てる(`PKC3_WORDCOUNT=1`)
2. 🔴 **押す腕の結論は、必ず「押しただけの群」と比べる。** 2 回や 3 回では基準線(50%)と区別できない
3. 🔴 **`Ctrl` や `Alt` が効かない回を「その機能が無い」と読まない。** まず素の字を 1 つ打って版面が変わるかを見る ── 変わるなら落ちた後の状態であって、機能の話ではない
4. ⚠ 落ちたかは console の `pageerror` で見る(`faults` の欄が 0 でも console には出ていることがある)
5. ⚠ メニューは 1 回押しただけでは開かない。`PKC3_MENU_TRIES=n` で開くまで押し直し、**開いていない回は項目を押さない**(項目の鍵がそのまま本文に入る)
6. ⚠ 「クリックしなくても落ちる」はこの箱では再現しない(30 回で 0 件)。実機(macOS / DPR 2)を否定するものではない ── **「この箱では」と限定して書く**

## コピーの後に外のクリップボードがどうなるか(#121)

`build/office-wasm/clipboard-probe.mjs <pack> <fixtures> out.json [n]` ── 外へ種を置き、LO の中でコピーし
(`Ctrl+C` / 右クリックのメニュー / 画像 / 表)、外を読み直す。fixture は
`make-clipboard-fixtures.py <dir>` が自作する。腕・判定不能の規則・読み方は probe の先頭に書いてある。
⚠ 一式は上の「一式を引く」〜「目録(`pack.json`)を手で書かない」のとおり `make-pages-bundle.mjs` で組む。⚠ ディスクの空きが少ない箱では
`Response.blob()` が `net::ERR_FAILED` で落ちる(probe は `arrayBuffer()` で入れる)。

## 焼く・待つ・配る

### ⚠ 焼きは 1 本ずつ投げる

2 本同時に dispatch したら**片方が 4 時間 11 分**かかった(単独なら 29〜33 分)。
runner を奪い合うので、**2 本が 2 倍ではなく 8 倍**になる。

### 焼きの所要は「cache が当たるか」で決まる ── flag の有無では読めない

- 事前には読めない(同じ flag 全 OFF が 35 分のことも 3h49m のこともあった。`reference/build-incidents.md`「焼きの所要は「cache が当たるか」で 8 倍違う」、2026-10-04 / 訂正 2026-10-05)
- 焼いたら **run の `make` step の時刻**で「暖かかったか」を記録する(23〜35 分 = 当たり / 3〜4 時間 = 外れ)
- check-in は **45 分**で張り、外れていたら 45 分ごとに再 arm する(待つ間は別の仕事)
- 「検証は計装つき → OK なら配布用」の 2 段は、速さのためではなく**計装の印で直りを読んでから配る**ため

### `qtbase-patch-*.py` を足す・変える

- **Qt 側の直しは 1 焼きに束ねる**(別々に 2 回焼くと Qt を 2 回建てる)。束ねる前に `ls build/office-wasm/qtbase-patch-*.py` で既存の名前を見る
- 見込みは「Qt 26 分 + LO 3.6 時間」と書く(Qt だけの 26 分と書くと待つ時間を桁で外す)
- ⚠ cache 鍵の記述は 2026-10-05 → 2026-10-07 で訂正されている(`reference/build-incidents.md`「`qtbase-patch-*.py` を足す・変えると Qt を焼き直す」を最後まで読む)

### 🔴 配布は **2 段**。PKC3 の焼きだけでは user に届かない(2026-10-04)

1. PKC3 `office-wasm-build.yml` → prerelease **`lo-wasm-dev`**
2. 🔴 **office-pack repo の `pages.yml` を `workflow_dispatch`**(inputs `pkc3_ref=main` / `lo_tag=lo-wasm-dev`、約 3 分)
   → https://sm06224.github.io/office-pack/pack.json の **`version`** に焼いた run 番号が載る

🔑 **「配った」と書く前に、pack.json の `version` を読む**(観測点:run 37222905517 の dispatch の後 →
`lo-0c031979e70b-run37205634760`。`run` の後ろが **1 段目の焼きの run** と一致して初めて届いている)。
⚠ 1 段目だけで「配りました」と書くのは、CLAUDE.md §4 の「焼けた」と「届いた」の間を数えない誤りと同じ型である。

### 🔴 詰め込みの命令行は **128 KiB** で切れる(2026-08-30、#591)

`make` の 15 分で `Error 127` が出たら、それは `command not found` ではなく **`/bin/sh: Argument list too long`**(1 引数の上限 `MAX_ARG_STRLEN` = 128 KiB)。
詰め込みの一覧(`.mk`)を足す**前**に余裕を数える。直っている形は `patch-lo-fsimage-cmdline.py`(`--preload $(shell cat $^)` → `--preload $$(cat $^)`)。
原因・手元で 30 秒で確かめる式・診断の置き方は `reference/build-incidents.md`「詰め込みの命令行は 128 KiB で切れる」。

### 余裕を数える(足す前に)

```bash
python3 -c "
import json; d=json.load(open('<pack>/soffice.data.js.metadata'))
n=[f['filename'].lstrip('/') for f in d['files']]
b=sum(len(x)+1 for x in n)
print(f'{len(n):,} file / {b:,} byte / 128KiB まで残り {131072-b:,}')"
```

実測(LO 47104c82): **1,993 file = 130,251 byte ── 残り 821 byte しか無い**。
⚠ **1 file 平均 65 byte なので、13 file 足せば溢れる。**

## LO / Qt / Emscripten に patch を足す・読むとき

各 patch の経緯・印・読み方は `reference/patch-notes.md`(時系列)。型だけここに置く:

| 型 | 手順 | 記録 |
|---|---|---|
| LO の直しの最初の門 | probe の判定表にまず**対照群 C(文書が開いて外へ字が出る)**を置く。C が落ちた回は他の腕の結果を 1 つも読まない。直しは「広い門」より**落ちる 1 か所だけ**(広い門は計装で見えていない経路まで止める) | `patch-notes.md`「LO の直しは「文書が開くか」を最初の門にする」。⚠ **そこで扱う `patch-lo-yield-proxy-guard.py`(PR #1342)は revert 済みで main に無い**(2026-10-04) |
| JSPI の suspend は **LIFO** で起こす | 壊れ方の署名 `RuntimeError: operation does not support unaligned accesses` を見たら「壊れた番地 = LIFO 違反」を第一容疑にする(外側の `wait-out` が内側の frame より先に返っている) | `patch-notes.md`「JSPI の suspend は LIFO で起こす」(2026-10-05、#1344) |
| 「止めた」と書ける条件 | **門が閉じた回**(`sp-defer` / `pa-defer n=1` → `end` の対)が 1 件以上あり、その回の faults が 0。対が 0 件の緑は「経路を踏んでいない」でしかない。統計で言えるのは「普段の経路を変えない」まで | `patch-notes.md`「`PKC3-UEV pa-defer` の読み方」/ `probe-log.md`「JS だけの差分は…」 |
| JS だけの差分 | **焼かずに**、焼いた `soffice.js` の字を置換して probe で検める(`cp -al` で pack を写し、hardlink を消してから書く)。⚠ C++ の差分が 1 行でも在れば使えない(そのときは焼く) | `probe-log.md`「JS だけの差分は、焼かずに…」(2026-10-05、#1344 v3) |
| Emscripten の library JS | 当てる先は**配る一式**(`workdir/installation/LibreOffice/emscripten/soffice.js`)。集めた**後**に当て、同じ file で印の出現回数を数える(`grep -o \| wc -l`)。置換は「足すだけ」にして test で pin | `patch-notes.md`「Emscripten の library JS も…」(PR #1358) |
| 同じ上流 file を触る patch | include は無条件に足して印を付け、**錨が交わらない / 挿入点が別 / 両順(A→B / B→A)で出力が同一**を test で pin する | `patch-notes.md`「同じ上流 file を触る patch は…」 |
| 競合・trap の再現 | 狙って当てるより、**当たった構成を変えずに回数を足す**。見たい瞬間が `clipTrace` の ring(直近 3000 行)の外に出ることがある ── 何行見たかも添える | `probe-log.md`「競合の再現は、構成を変えずに回す」「trace の ring は…」 |
| 「⚠ 焼く前」の patch(印か直しか) | 各 patch の `PKC3-*` の印の回数で次の焼きを読む。**0 回のまま落ちる = 門は原因に届いていない**。直しではなく印の patch もある(節ごとに明記) | `patch-notes.md` の 2026-10-07 / 2026-10-08 の節(#1393 / #1396 / #1402 / #1408 / #1429) |

## 🔴 `wasm-function[60973]` を名前に直す ── 焼き直さない(2026-09-08、#631)

> ⚠ **「名前つきで焼き直すしかない」と書こうとした瞬間に、ここを読む。**
> #117 / #88 / #431 は、その思い込みで**焼き 1 本(30 分〜4 時間)待ち**のまま止まっていた。

配っている一式には **name section が 0 件**なので、停止のスタックは
`wasm-function[60973]` という**番号だけ**で出る。🔑 だが
**`--profiling-funcs` は名前の節を足すだけ**で、関数の並びも offset も動かさない ──
つまり**名前つき一式の表を引けば、配布一式の番号がそのまま名前になる**。

```bash
# ① 名前つき一式を落とす(「一式を引く」と同じ手順。tag に -names が付いているもの)
# ② 番号を直に渡す
python3 build/office-wasm/wasm-names.py \
  --wasm /tmp/lo-names/soffice.wasm \
  --lo-sha "$(jq -r .build.lo_sha /tmp/lo-pack/pack.json)" \
  60973 198121 235333

# ③ スタックの字をそのまま食わせる(`wasm-function[N]` を拾って、出た順に返す)
python3 build/office-wasm/wasm-names.py --wasm /tmp/lo-names/soffice.wasm \
  --lo-sha "$(jq -r .build.lo_sha /tmp/lo-pack/pack.json)" --stack crash.txt
```

| 番号 | 名前(#117 で実証) |
|---|---|
| 60973 | `Scheduler::CallbackTaskScheduling()` |
| 198121 | `QtTimer::timeoutActivated()` |
| 235333 | `void doActivate<false>(QObject*, int, void**)` |

### 🔴 使える条件は 1 つ ── `lo_sha` が同じであること

**反例が実測済み**:番号 **39465** は `63426ccd1d7c` では `vcl::Window::ToTop(ToTopFlags)`、
`95e83feb2e85` では `ImplBorderWindow::GetOptimalSize()` である。

🔑 だからこの道具は **`--lo-sha` を必須**にし、名前つき一式に同梱された
`build-info.json` の `lo_sha` と**突き合わせてからしか引かない**
(食い違い / `build-info.json` が無い / 7 文字未満 ── どれでも**落ちる**)。

⚠ **記録には「番号 + `lo_sha`」を対で書く。** 番号だけの記録は、枝が 1 つ動いた瞬間に
**それらしい嘘**になる ── しかも名前が出てしまうので、**誰も検算しない**。

(渡したものが落ちる形 ── 配布一式・関数名の副節なし・`lo_sha` 違い・`build-info.json` なし・引けない番号 ── と、検めている test は
`reference/probe-log.md`「`wasm-function[N]` を名前に直す」。)

## 自己点検(Office の結論を書く前に)

- [ ] 「取れない」「確かめられない」と書く前に、取り方(上の表)を数え、`--cacert` を渡した
- [ ] 落とした一式の `build-info.json` の `run_id` が、自分が回した run と一致した(引いた先ではなく落とした物で確かめた)
- [ ] 焼き直した後は `fetch-and-run.sh --force`、目録の総数が動いたことを見た
- [ ] 対照群(`.odt`)を先に回し、届いた回だけを読んだ。窓は腕ごとに閉じた
- [ ] `crossOriginIsolated` を最初に印字した。観測点は「窓が立った」ではなく「中身が出た」
- [ ] 保存の判定は 3 点(mtime / `medium:commit` / PKC が取り込んだか)。`PKC3_FRAMES=1` を渡した
- [ ] wasm の「在る / 無い」は UTF-16LE でも数えた。「在る」は「リンクされた」までしか言わない
- [ ] 押す腕の結論は「押しただけの群」と比べた。判定不能の回から結果を読んでいない
- [ ] 配ったと書く前に `pack.json` の `version` を読んだ(焼けた ≠ 届いた)
