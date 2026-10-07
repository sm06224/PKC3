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

### 🔴 調査用の焼きは **`lo-wasm-dev` に出ない**(2026-08-30 に踏みかけた)

`office-wasm-build.yml` は**調査用のスイッチが入ると別の tag へ出す**。
⚠ `lo-wasm-dev` を引いて「焼いたはずの物が入っていない」と読むのが罠である ──
実際、名前つきの焼きが成功した直後に `lo-wasm-dev` を引いたら
**別 run(前の焼き)の中身**が返ってきた。

| 渡したスイッチ | tag |
|---|---|
| なし(配布用) | `lo-wasm-dev` |
| `profiling_funcs: true` | **`lo-wasm-names`** |
| `safe_heap: true` | `lo-wasm-safeheap` |
| 両方 | `lo-wasm-safeheap-names` |

### 🔴 tag 名は flag から**合成される** ── 推測せず、release の本文で run を確かめる(2026-10-04)

上の表は 2 つだけだが、実際は `office-wasm-build.yml` が **flag ごとの接尾辞をこの順で連ねる**
(`SAFE_SUFFIX`、1045〜1054 行):`-safeheap` → `-names`(`profiling_funcs`)→ `-imetrace` → `-savetrace` →
`-idlestrace` → `-schedtrace` → `-cliptrace`(`clip_trace`)→ `-menutrace`(`menu_trace`)→ `-uevtrace`(`uev_trace`)。
tag は **`lo-wasm` + 接尾辞**(例: `lo-wasm-names-cliptrace-menutrace`)で、**全部 OFF のときだけ `lo-wasm-dev`**。
⚠ 2026-10-04 に **`lo-wasm-dev-menutrace`**(`dev` に接尾辞を足した形)を引いて **404** を踏んだ ──
`dev` は「全部 OFF」の名前であって、接尾辞の前置きではない。
🔑 **tag を推測しない。** `mcp__github__get_release_by_tag` の body(「run NNN / commit SHA」)で
**その run の物か**を確かめてから zip を落とす(落とした後は上の `build-info.json` の `run_id`)。

🔑 **検算は 1 つ: 落とした一式の `build-info.json` の `run_id` が、自分が回した run と一致するか。**
`profiling_funcs` / `safe_heap` の値もそこに書いてある ── **引いた先ではなく、
落とした物で確かめる**。

⚠ **workflow の artifact(`actions/artifacts/.../zip`)からは取れない** ── 落とし先が
`*.blob.core.windows.net` で、この箱のプロキシが **403 CONNECT** で塞ぐ(実測)。
🔑 **release 資産の経路(`github.com/.../releases/download/...`)だけが通る**ので、
「artifact が取れない = 手元で確かめられない」と読まない(§0 の「取り方を数え上げる」)。

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

## 9. 🔴 「保存できたか」の判定(2026-08-24、#225 で確立)

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
**対照群も開かない** ── §0)。

## 10. 🔴 その一式が非 ODF を保存できるか(#225)

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

## 13. 🔴 probe は固まる ── 締切と、計器の選び方(2026-08-30)

### 13.1 全体の締切を張る

⚠ **Playwright の `page.evaluate()` に既定の締切は無い。** 版面(LO wasm)が 100% で
回り続けると `await` は**永久に返らない**。🔴 そして固まった `await` は例外を投げないので
**`finally` も走らない** ── JSON が 1 バイトも書かれず、**何段目で止まったのかも残らない**。

実測(`open-doc-probe` の貼り付けの門): 経過 **4h58m** / renderer の CPU 時間 **5h00m** /
RSS **1.07 GB** / log **0 byte**。⚠ 完了通知には **exit code 0** と出た
(`node …; echo "exit=$?"` の形だったため ── CLAUDE.md §6)。

🔑 機構は `build/office-wasm/probe-watchdog.mjs`:

```js
import { armWatchdog } from './probe-watchdog.mjs';
const wd = armWatchdog({ result, out: OUT, limitSec: LIMIT_SEC + 600, browser: () => browser });
wd.mark('観測ループ');   // 落ちたとき段の名前が出る
wd.disarm();             // 正常に終わったら止める
```

⚠ **`result.error` だけに書かない** ── 閉じると待っていた `await` が reject し、
probe 自身の `catch` が上書きして末尾がもう一度 JSON を書く(実測で踏んだ)。
だから `timedOutError` / `timedOutPhase` という**自分の欄**を持つ。
⚠ 閉じる猶予は 3 秒 ── 即座に `process.exit` すると **chrome が 2 個残る**。

🟢 **2026-08-30 に 14 / 14 へ配り終えた**(#625)。⚠ 配る前に穴が 1 つあった ──
**`disarm()` を書き忘れると、仕事が終わっているのに締切まで生き残り、
良い JSON の上に偽の「時間切れ」を書いて `exit 2`** する(実測)。
`timer.unref()` で無害にしてある(固まる回は browser の socket が event loop を
生かすので守りは落ちない ── 対照群 2 本で両方向を確認済み)。

### 🔑 実際に鳴った(同じ日、#121 の調査中)

```
keys-4 exit=2 経過=843秒
時間切れ(840 秒)。段 「貼り付けの門」 で戻らなかった
phases: 一式を IDB へ入れる(0s) → 観測ループ(1s) → 貼り付けの門(7s)
```

固まっていた相手も名指しできた ── **renderer が 102% CPU / 1,128 MB**。

### 13.2 🔴 **保存を見たいなら `save-existing-probe` を使う**

同じ一式・同じ文書で、保存が通った回を数えた(2026-08-30):

| 計器 | 保存が通った |
|---|---|
| **`save-existing-probe.mjs`** | 🟢 **6 / 6** |
| `open-doc-probe.mjs`(打鍵の門) | 🔴 **4 / 11** |

⚠ 打鍵そのものは **11/11 で画面に出る**(`landedWhileTyping: true`)── 落ちるのは
**保存の一手だけ**で、しかも **3 秒以内に起きるか、30 秒経っても起きないかの二値**である。

⚠ 外した仮説を 2 つ記録しておく(同じ道を 2 度歩かないため):
**①「`Ctrl+S` の後の待ちが 6 秒固定で早すぎる」** → 6 秒に戻しても見えた。外れ。
**②「`Ctrl+S` の直前の `Escape` が殺している」** → 外しても落ちた(1/3)。外れ。

🔑 だから**保存が絡む判定は `save-existing-probe` で採る**。
`open-doc-probe` の門は、保存に依らない観測点(版面が変わったか)なら信用できる。

### 13.3 🔴 **版面で採る**(保存に依らない判定。2026-08-30 に入れた)

`PKC3_FRAMES=1` を渡すと、貼り付けの門が **file と版面の 2 つ**を出す:

```bash
PKC3_PASTE=1 PKC3_PASTE_VIA=keys|menu|browser PKC3_FRAMES=1 \
  node build/office-wasm/open-doc-probe.mjs <pack> <doc> out.json 240
```

- `paste.verdict` … **file の中に字が在るか**(保存が来ないと判定不能)
- `paste.screen.verdict` … **版面が変わったか**(何が入ったかは言えない)

⚠ **2 つは別のことを主張する。** 実測(3 腕 × 4 回)では、保存が来なかった 4 回のうち
**3 回は版面の計器だけが答えられた** ── file だけなら丸ごと読めない回である。

### 13.4 🔴 固まった回を「できなかった」と読まない

門を 3 か所(押した後 / 打鍵の後 / 貼る直前)置いて、`page.evaluate('1')` を
**8 秒で競走**させる。返らなければ `paste.wedgedAt` を立てて**両方の判定を
「判定不能(版面が固まった)」で塗る**。⚠ 片方だけ塗ると、もう片方の古い値が
結果として読まれる。

⚠ **撮る所も競走させる**(20 秒)── 固まった版面では `screenshot` も返らない。
返す `null` は `swapped()` が「採れていない」と読むので、そのまま判定不能へ倒れる。

🔴 **ただしこの門は万能ではない。** 実測で「**`evaluate` は返るのに、`Ctrl+S` も
`Ctrl+V` も効かない**」状態が在った(打鍵は版面に出ている)── **JS の息はあるが
文書が命令を処理しない**。この形は上の門を素通りするので、
**保存が来なかった回は、それ自体を「読めない回」の印として数える**。

## 14. 🔴 **版面を押すと 2 回に 1 回落ちる ── だから「押した後の結論」は全部弱い**

実測(2026-08-30、LO 26.8 / 自作 8.8KB `.odt` / 各 10 回):

| 腕 | 何をするか | `memory access out of bounds` |
|---|---|---|
| ① 何もしない | 開いて 60 秒待つ | 🟢 **0 / 10** |
| ② 位置だけ採る | shadow root を歩いて矩形を採る(**押さない**) | 🟢 **0 / 10** |
| 🔴 ③ **押す** | ②の後、版面を 1 回クリック | 🔴 **5 / 10** |

fault は**押す段の開始から 0.65〜0.72 秒後**に揃って出る。

### 🔴 落ちた後は「半分だけ生きている」── これがいちばん誤読を生む

| | |
|---|---|
| 素の字を打つ | 🟢 **5 / 5 で版面に出る** |
| `Ctrl+S` / `Ctrl+V` | 🔴 **0 / 5** |
| `Ctrl+S` を `down` / `press` / `up` に**分けて**撃つ | 🔴 **0 / 3** |
| `Alt+E`(メニュー) | 🔴 開かない |

つまり**修飾キーを伴う入力だけが死ぬ**。⚠ 版面は描き続けるので、
**「動いている」ように見えたまま、保存もコピーも効かない**。
🟢 host は気づいており、帯が **`停止`** になる(落ちなかった回は `表示中 (3.8 秒)`)。

### 🔑 だから測り方が変わる

1. 🔴 **押す必要がないなら押さない。** メニューは `Alt+キー` で**押さずに開く**
   (`PKC3_MENU_NO_CLICK=1`)。打鍵も、開いた直後は caret が本文の先頭に在るので
   **押さずに打てる**(`PKC3_WORDCOUNT=1` はそれで測っている)
2. 🔴 **押す腕の結論は、必ず「押しただけの群」と比べる。**
   ⚠ **2 回や 3 回では基準線(50%)と区別できない** ── 過去に
   「`Edit Macros...` は 2/2 で落ちる」と書いたが、**基準線が未知のときの 2 回**である
3. 🔴 **`Ctrl` や `Alt` が効かない回を「その機能が無い」と読まない。**
   まず**素の字**を 1 つ打って、版面が変わるかを見る ── 変わるなら
   **落ちた後の状態**であって、機能の話ではない
4. ⚠ **落ちたかは console の `pageerror` で見る**(`memory access out of bounds`)。
   ⚠ `faults` の欄が 0 でも、console には出ていることがある

### ⚠ 「クリックしなくても落ちる」は、この箱では再現しない

押さない腕は 2 種類 30 回で **0 件**。⚠ 実機(macOS / DPR 2)を否定するものではない ──
**「この箱では」と限定して**書くこと。

### ⚠ メニューは 1 回押しただけでは開かない

`Alt+キー` は**開かない回が多い**(押し直しが要る)。⚠ そして
**開いていない回に項目の鍵を押すと、その字が本文に入る** ──
実際に `Alpha beta gamma` が `iAlpha beta gamma` になった(16 → 17 文字)。
🔑 `PKC3_MENU_TRIES=n` で開くまで押し直し、**開いていない回は項目を押さない**。

## 16. コピーの後に外のクリップボードがどうなるか(#121)

`build/office-wasm/clipboard-probe.mjs <pack> <fixtures> out.json [n]` ── 外へ種を置き、LO の中でコピーし
(`Ctrl+C` / 右クリックのメニュー / 画像 / 表)、外を読み直す。fixture は
`make-clipboard-fixtures.py <dir>` が自作する。腕・判定不能の規則・読み方は probe の先頭に書いてある。
⚠ 一式は §1〜§3 のとおり `make-pages-bundle.mjs` で組む。⚠ ディスクの空きが少ない箱では
`Response.blob()` が `net::ERR_FAILED` で落ちる(probe は `arrayBuffer()` で入れる)。

## 11. ⚠ 焼きは 1 本ずつ投げる

2 本同時に dispatch したら**片方が 4 時間 11 分**かかった(単独なら 29〜33 分)。
runner を奪い合うので、**2 本が 2 倍ではなく 8 倍**になる。

### 🔴 焼きの所要は「cache が当たるか」で **8 倍**違う ── flag の有無では読めない(2026-10-04 / 訂正 2026-10-05)

| 焼き | 所要(観測点) |
|---|---|
| 計装 flag(`profiling_funcs` / `clip_trace` / `menu_trace` / `uev_trace`)つき、続けて焼いた回 | **23〜35 分**(run 37222907850 = 23 分 / run 37246370234 = 29 分) |
| flag 全 OFF(配布用、tag `lo-wasm-dev`)── 2026-10-04 | 🔴 **3h49m**(run 37205634760、make 14:02→17:51Z) |
| flag 全 OFF(配布用)── 2026-10-05、計装つきの焼きの直後 | 🟢 **35 分**(run 37250135375、01:07→01:42Z) |

⚠ 2026-10-04 の版のこの節は「**flag を全部外すと Qt6 の cache も外れて約 4 時間**」と書いていた ──
🔴 **翌日の実測で外れた**(同じ flag 全 OFF が 35 分)。4 時間だったのは **flag のせいではなく、
その日の cache が別の理由で外れていた**(何が鍵かは未確定 ── 推測を書かない)。
🔑 **読み方**:所要は **cache が当たるか**で決まり、それは事前には読めない。だから
① 焼いたら **run の `make` step の時刻**で「暖かかったか」を記録する(23〜35 分 = 当たり / 3〜4 時間 = 外れ)
② check-in は **45 分**で張り、外れていたら 45 分ごとに再 arm する(待っている間は別の仕事をする)
③ 「検証は計装つき → OK なら配布用」の **2 段**はそのまま正しい ── 理由は速さではなく
**計装の印で直りを読んでから配る**ためである。

### 🔴 `qtbase-patch-*.py` を足す・変えると **Qt を焼き直す**(数時間)(2026-10-05)

Qt の cache 鍵は **`hashFiles('build/office-wasm/qt-wasm-configure.args', 'build/office-wasm/qtbase-patch-*.py')`**
(`office-wasm-build.yml` の `key:`。`qt-…` と `ccache-lo-qt6-…` の 2 種)。
`patch-lo-*.py` は **LO の** patch なので Qt の cache は当たったまま(23〜35 分)。
🔑 だから **Qt 側の直しは 1 焼きに束ねる** ── 2 本を別々に焼くと **Qt を 2 回建てる**。
⚠ 束ねる前に `qtbase-patch-*.py` の既存の名前を `ls` する(足した file も**変えた file も**鍵を動かす)。

⚠ **2026-10-07 訂正: 鍵に hash は無い**(`office-wasm-build.yml` の :267 は `ccache-lo-qt6-nd-${{ inputs.qt_ref }}-${{ github.sha }}`。
`-nd-` の depend mode を切った鍵で、Qt の patch を触っても LO の ccache は復元される)。下の段落は 2026-10-05 時点の記述として残す。
🔴 **`ccache-lo-qt6-…` は LO の compile cache である ── 同じ hash を含むので、Qt の patch を触ると
LO 側もほぼ全量 compile になる**(2026-10-05 実測、#1344)。上の「Qt を焼き直す」は **Qt だけではない**。
観測点:run 37267668276(main 4e57bd4f、`qtbase-patch-asyncify-nested.py` を足した直後)──
Qt host 15 分 + Qt wasm 11 分 + **LO make 3 時間 37 分**(06:00:56Z → 09:38:22Z)、**合計 4 時間 15 分**。
`ccache を復元` step は **1 秒で終わっている**(= 何も復元していない)。
鍵は `office-wasm-build.yml` 255 行
`ccache-lo-qt6-${{ inputs.qt_ref }}-${{ hashFiles('build/office-wasm/qt-wasm-configure.args', 'build/office-wasm/qtbase-patch-*.py') }}-${{ github.sha }}`、
`restore-keys` も**同じ hash までしか遡らない**(`CCACHE_DEPEND` の罠のため**意図的** ── 同 file 240〜247 行のコメント)。
🔑 **qtbase patch の変更は 1 回の焼きに束ねる**(v1 → v2 のように 2 回焼くと **8 時間半**)。
🔑 見込みは **「Qt 26 分 + LO 3.6 時間」**と書く(Qt だけの 26 分と書くと、待つ時間を桁で外す)。
⚠ 上の 2026-10-04 の「flag 全 OFF の焼きが 3h49m」は、この鍵が動いた(`qtbase-patch-backspace` などの追加)ことが
**原因だった可能性**があるが、**未確認**(推測。その run の cache 復元が一致だったかを見れば決着する)。

🔑 Qt の patch の一覧(2026-10-07 時点で 6 本):`asyncify-nested`(#1344)/ `backspace`(#433)/ `ime-panel` / `inputcontext` /
`ecmastring-threadsafe`(#1394。`qcore_wasm.cpp` の関数内 static な `emscripten::val` を、main と pthread の両方から
呼ばれても `invalid handle` にならないよう毎回 `module_property` を取る形へ。test は `tests/office-ecmastring-threadsafe-patch.test.ts`)/
`wake-async`(#1408。`wakeEventDispatcherThread()` の resume の依頼を、別スレッドからは `runOnMainThreadAsync` に ──
同期だと main の SolarMutex の busy-wait と相互待ちになる。Qt 6.10 も別スレッドからの起こしは非同期(main からも非同期だが、ここでは main は従来どおり同期のまま)。⚠ `asyncify-nested` の**後**にしか当たらない
(錨が 3 行)。test は `tests/office-wake-async-patch.test.ts`)。

🔑 **emsdk への patch**(Qt の patch ではない。本数の pin に載らない名前 `emsdk-patch-*`):`build/office-wasm/emsdk-patch-proxying.py`(#1408)。
emscripten 4.0.10 の `system/lib/pthread/proxying.c` の `emscripten_proxy_finish` を、`pthread_cond_signal` → `pthread_mutex_unlock`
の順へ(`cancel_ctx` も同じ順。5.0.5 の #26582 と同じ。unlock の後だと、待つ側が先に起きて捨てた condvar を signal しに行って固まる)。
workflow は patch の後に **cache の `libc-mt*.a` / `libc_optz-mt*.a` を消す**(proxying.c は libc の archive に入っていて、cache に在れば作り直されない。
消せば最終 link が build する)。make の後に「patch より新しいか」を診断で出す。test は `tests/office-proxying-patch.test.ts`。

### 🔴 JSPI の suspend は **LIFO で起こす** ── Emscripten の C stack は 1 本(2026-10-05、#1344 v1 → v2)

1. **Emscripten 4.0.10 `src/lib/libasync.js` の JSPI(`ASYNCIFY=2`)は、export を
   `Asyncify.makeAsyncFunction` = `WebAssembly.promising(original)` で包むだけ**で、C の shadow stack pointer の
   **保存も復元もしない**(2026-10-05 に raw.githubusercontent.com から読んだ)。
   🔴 だから **suspend した stack が 2 本在るとき、外側を先に起こすと、外側の関数の return が sp を内側の frame より
   上へ戻し、以後の呼び出しが内側の frame を踏む**。起こす順は **LIFO**(内側が JS へ戻ってから外側)でなければならない。
2. 🔑 **壊れ方の署名**:`RuntimeError: operation does not support unaligned accesses`(V8 の unaligned atomic の trap)が、
   **壊れた object の atomic store を踏む所**(#1344 では `QEventLoop::exit(int)` ← `QMenu::hideEvent`)で出る。
   **その数 ms 前に外側が返っている**(`PKC3-UEV wait-out`)。
   この署名を見たら **「壊れた番地 = LIFO 違反」を第一容疑**にする。観測点:run 37267668276 の probe
   (scratchpad 121k)、B2 / B2w の **9 回全部**。
3. 🔴 **v2 の焼き(run 37303396759)で同じ署名が再発した**(B2w 8 round 中 2 round。B2 / B2k / C は全部通った)。
   trap round の uev trace:項目を押した瞬間に **LO main loop(`ImplYield`、nest=1)の `wait-out` が `exec-ret` より前**に返り、
   直後の dispatch がメニューを閉じに行って落ちる。通った round は `exec-ret` → `PKC3-CLIP` → `wait-out` の順。
   = **メニューの計算が生きている間に main loop が起こされる**経路が、Qt 側の LIFO では閉じない。
4. 🔑 **構造(焼いた soffice.js と LO 0c031979 の原文で実測)**。推測ではなく、次の grep で数える:
   - promising export = `grep -o 'exportPattern=/[^/]*/' soffice.js` → **3 種**:`main` / `_emscripten_check_mailbox`(proxy queue の口)/
     `qstdweb::EventListener` の invoker(**DOM event の口** ── だから pointer の callback は main と別の計算として suspend できる)。
   - Suspending import = `grep -o '\w*\.isAsync=true' soffice.js` + `function __asyncjs__\w+` → **5 種**:`__asyncjs__qt_asyncify_suspend_js` /
     `emscripten_promise_await` / `emscripten_sleep` / `fd_sync` / `emscripten_idb_*`。
   - 🔴 LO `vcl/qt5/QtInstance.cxx`(JSPI 構成 `HAVE_EMSCRIPTEN_JSPI && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD`)は
     **`ProcessEvent` を `eventHandlerThread` へ proxy し、main thread は `emscripten_promise_await` で止まる**。`DoYield` の枝 B は逆向き
     (handler thread → main へ proxy。main は mailbox の計算の中で `ImplYield` → Qt の wait)。
   - だから **main thread の 1 本の shadow stack の上に、main / mailbox / DOM event の計算が、Qt の suspend と `promise_await` の
     2 種類の止まり方で積み重なる**。Qt 側の LIFO(v2)も sp の門(v3)も **Qt 側の起こし**しか見ていない ──
     `promise_await` の起こしは Emscripten の promise が直に起こすので、下で止まっている計算を踏みうる。
5. **v3(PR #1356)= sp の門**:suspend で `stackSave()` を控え、tick で同じ値へ戻るまで起こさない(Gemini Q2c)。
   `stackSave` が無ければ門なし(1 度 warn)。250 周戻らなければ `PKC3-UEV sp-defer … dir=above|unwound` を出し 100 ms に間引く。
   ⚠ **`dir=unwound`(sp が top.sp より高い = 上書きされた後)は直っていない** ── trap が診断つきの hang に変わるだけ。
   v3 の JS を v2 の一式に当てた probe は 44 round 通ったが **門が閉じた回は 0** ── 「普段を変えない」は言えても「trap を止めた」は**言えない**。
   残る手(Qt の patch で `promise_await` も同じ stack に載せる / LO の proxy をやめる / Emscripten 側)は #1344 コメント 5998799530 で Gemini に問うた。
6. 経緯と置き場:PR #1350(v1。全部起こす)→ PR #1353(v2。LIFO)→ PR #1356(v3。sp の門)。patch は
   `build/office-wasm/qtbase-patch-asyncify-nested.py`、test は `tests/office-asyncify-nested-patch.test.ts`
   (偽 `setTimeout` の台に**原本 / v1 / v2** を同じ場面で回す形 ── **対照群を 2 つ**持つ。v3 で shadow stack の模型を足した)。
   ⚠ 変異試験で**普段の経路**を通していなかった件は `mutation-testing` §3.15、模型の「止まり直し」は §3.16。

### 🔑 **JS だけの差分は、焼かずに「焼いた一式の soffice.js」へ当てて probe で検める**(2026-10-05、#1344 v3。焼き 4 h × 2 を省いた)

Qt の `EM_JS` / `EM_ASYNC_JS` の本文は **焼いた `soffice.js` に字のまま(minify 済み)入っている**。だから patch の差分が JS だけなら、
焼かずに次で検められる:

1. `grep -o 'function __asyncjs__qt_asyncify_suspend_js(){.\{0,400\}' soffice.js` で **元の字を取り出す**(minify 後の形。`{resolve,wake:false}` のように短くなる)。
2. node で `s.split(old).length - 1 === 1` を assert してから置換、`new Function('Module','stackSave','Asyncify','setTimeout', <置換後の範囲>)` で**構文だけ**検める。
3. pack は `cp -al 121l/pack 121m/pack`(hardlink。100 MB を写さない)→ `rm 121m/pack/soffice.js` → 書く(**link を消してから**書く ── 消さずに書くと元の pack も変わる)。
4. 同じ probe(`clipboard-probe.mjs`)を回す。🔑 観測の `console.error('PKC3-UEV …')` を JS に足せば **clipTrace が拾う**
   (`PKC3-(CLIP|MENU|UEV)` を含む行だけ残る ── 印の字はこの 3 つから選ぶ)。
   ⚠ 普段の経路(depth 1)の suspend / wake まで出すと ring 3000 行が溢れる ── **depth ≥ 2 のときだけ**出す。
5. ⚠ **C++ の差分が 1 行でも在れば使えない**(そのときは焼く)。v3 が検められたのは C++ が v2 のままだったから。

実測:v2 の一式(run 37303396759)に v3 の JS を当てて C 5/5 / B2 5/5 / B2w 17/17。**焼きなら 4 時間 × 2 本**。
⚠ ただし「再現しない」は「直した」ではない ── trap は v2 で 2/8、その後 v2 + 観測で 0/12、v3 で 0/22。
**門が閉じた回(`sp-defer`)が 0 件**なので、v3 は trap の経路を 1 度も踏んでいない。
🔑 **統計で言えるのは「普段の経路を変えない」まで**。「止めた」と書くには、門が閉じた回が 1 件以上要る。

### 🔑 **Emscripten の library JS も、焼いた `soffice.js` を置換して直せる**(2026-10-05、#1344 (a')。PR #1358)

上の節は Qt の `EM_JS` だが、**LO にも Qt にも無い関数**(`_emscripten_promise_await` = Emscripten の `src/lib/libpromise.js`)も同じ ──
`--js-library` で上書きするには LO の link 行へ手を入れる必要が在り、`--post-js` では `wasmImports` に束ねられた後になる。
**焼けた `soffice.js` の字を置換する**のがいちばん確実で、手元で検めた置換(121q)と workflow の置換が**同じ script**になる。
道具は `build/office-wasm/patch-soffice-js-promise-await.mjs`(錨 = minify 後の字 1 字違わず / 印 `pkc3PaGuard`)。

🔴 **当てる先は「配る一式」である**(`workdir/installation/LibreOffice/emscripten/soffice.js`。zip はここから作る)。
`instdir/program/soffice.js` を直しても **`make instsetoo_native` が集め直す**ので、集める前に当てると素通りする ──
1 稿目はまさにその順で書いてあり、着地前レビューが拾った(CLAUDE.md §8「tripwire は直した結果が届いたかに置く」の実例)。
🔑 **集めた後に当てて、同じ file で印の出現回数を数える**(minify 後は 1 行なので `grep -c` では数えられない ── `grep -o | wc -l`)。

🔴 **錨が無いときだけでなく、`stackSave` の定義が無いときも落とす**。置換後の JS は `typeof stackSave` で保険を掛けるが、
それは**実行時に名前が届かなかったとき**の保険であって、焼いた物の検品ではない ── 検品で素通りさせると「門が黙って無くなる」形になる。
`var stackSave=()=>_emscripten_stack_get_current();` を script が要求し、fixture にも同じ 1 行を実物から写してある。

🔑 **置換は「足すだけ」にして、それを test で pin する**(足した字を抜くと錨そのものに戻る / `out.replace(REPLACEMENT, ANCHOR) === ORIG`)。
元の関数の動きを 1 字も変えていないことが、「対照 = 原文」の主張の土台になる。

#### 🔑 `PKC3-UEV pa-defer` の読み方

| 行 | 意味 |
|---|---|
| `pa-defer n=1 sp=… want=… dir=above` | proxy の結果が返ったが、**上に別の計算の frame が生きている**(sp が控えより低い)ので起こさなかった。**門が効いた回** |
| `pa-defer n=250 … dir=above` | 約 1 秒(250 周)戻らない。以後 100 ms に間引く。⚠ 1 秒を超えて続くなら、上の計算が終わらない(メニューが開いたまま等)── 異常ではない |
| `pa-defer … dir=unwound` | sp が控えより**高い**= 自分の frame がもう無い。起こさない。⚠ これが出たら**別の欠陥**(v3 の `sp-defer dir=unwound` と同じ向き)── 門は守るが原因は直っていない |
| `pa-defer end n=N` | 上が返って起こした。`n=1` の対が 1 つ在ること |

🔑 **「止めた」と書けるのは `pa-defer n=1` → `end` の対が 1 件以上在り、その回の faults が 0 のとき**(121q: 18 round 中 3 round で対、faults 0)。
対が 0 件の緑は「経路を踏んでいない」でしかない(上の節と同じ)。

#### 🔴 競合の再現は、**構成を変えずに回す**(2026-10-05、腕 B2f の空振り)

競合(proxy の待ちの窓に右クリックが入る)を**狙う腕**(`B2f`: `Control+a` の 150 ms 後に右クリック)を足したが、対照・門とも **10/10 で窓に当たらなかった**。
再現したのは**最初に trap が出たのと同じ構成**(4 腕 × 3 round、`C,B2,B2w,B2k`)を**そのまま**回した回(121r: trace で経路を確定 / 121q: 門が待った)。
🔑 競合は「時刻しだい」なので、**狙って当てるより、当たった構成を変えずに回数を足す**ほうが安い。
⚠ 構成を変えて 0 件になった回を「直った」と読まない ── 変えたのは窓のほうである。

### 🔑 trace の ring は「腕の頭」を流す ── 見たい瞬間が ring の外に出ることがある(2026-10-05)

`clipTrace` は **直近 3000 行**。メニューを開くと LO が **post ~180 → dispatch ~196** を一度に出すので、trap round の ring は
腕の開始から 6 秒後で始まっていて、**メニューが開いた瞬間が見えなかった**。
🔑 見たい瞬間が決まっているなら、(a) 印を減らす(`post-stack` を落とす / depth ≥ 2 だけ)か (b) 腕の中で `clipTrace` を**区切る**
(`PKC3-MENU` の行で ring を切り直す)。⚠ 件数の表(`dispatch 10539`)は ring の外を数えていない ── **何行見たか**も添える。

### 🔑 Qt / LO の上流 source は **raw.githubusercontent.com から取れる**(2026-10-05 実測)

`curl -sSL --cacert /root/.ccr/ca-bundle.crt https://raw.githubusercontent.com/qt/qtbase/6.9/src/corelib/kernel/qeventdispatcher_wasm.cpp`
が **200 / 22 KB**。🔑 **「Qt 側は読めない」と書く前に取る**(§0 の「取れない」と同じ向き)。
#1344 では Qt の dispatcher の `qt_asyncify_resume_js` の **`suspendId` 照合**(入れ子 suspend で
**外側の frame の起こしを捨てる**)を、**この file の 20 行**で確定できた。
⚠ scratchpad に置いた写しは**箱が作り直されると消える** ── 根拠にするなら
**fixture として test に入れる**(`tests/fixtures/qtbase/qeventdispatcher_wasm.cpp`)。
⚠ 枝(`6.9`)は焼きの `qt_ref` と**揃える**(違う枝を読んで確定すると、焼いた物と別の source を根拠にする)。

### 🔴 配布は **2 段**。PKC3 の焼きだけでは user に届かない(2026-10-04)

1. PKC3 `office-wasm-build.yml` → prerelease **`lo-wasm-dev`**
2. 🔴 **office-pack repo の `pages.yml` を `workflow_dispatch`**(inputs `pkc3_ref=main` / `lo_tag=lo-wasm-dev`、約 3 分)
   → https://sm06224.github.io/office-pack/pack.json の **`version`** に焼いた run 番号が載る

🔑 **「配った」と書く前に、pack.json の `version` を読む**(観測点:run 37222905517 の dispatch の後 →
`lo-0c031979e70b-run37205634760`。`run` の後ろが **1 段目の焼きの run** と一致して初めて届いている)。
⚠ 1 段目だけで「配りました」と書くのは、CLAUDE.md §4 の「焼けた」と「届いた」の間を数えない誤りと同じ型である。

### 🔴 LO の直しは **「文書が開くか」を最初の門にする**(2026-10-04、#121 / PR #1342 → #1343)

PR #1342(`patch-lo-yield-proxy-guard.py`:main thread の入れ子 `Yield` で user event を dispatch しない)は
**unit・変異試験・コンパイルを全部通った**のに、焼いたら **文書が 1 件も開かなかった**
(run 37239228503 の probe:全腕が判定不能、「印」が**起動 7 秒**で出ていた)。
原因:**読み込み中の入れ子 `Yield` も user event を処理しており、それが進行に必要**だった ──
検査は「止めたい経路が止まるか」しか見ておらず、**止めてはいけない経路**(読み込み)を 1 つも通っていなかった。
🔑 **probe の判定表には、まず対照群 C(文書が開いて、外へ字が出る)を置く** ── C が落ちた回は
**他の腕の結果を 1 つも読まない**(§6、CLAUDE.md §4「対照群が届かない回は判定不能」)。
🔑 **直しは「広い門」より「落ちる 1 か所だけ」** ── PR #1343 は `ImplHandleExtTextInput` の**1 か所**を
Emscripten のときだけ `break` にした。広い門は、**計装で見えていない経路まで一緒に止める**。
⚠ #1342 は revert した(`patch-lo-yield-proxy-guard.py` は main に無い)。

### 🔴 同じ上流 file を触る patch は、**どの順でも出力が同一**であることを test で pin する(2026-10-05)

`patch-lo-ime-nowait.py` と `patch-lo-idles-trace.py` は**同じ `winproc.cxx`** を触る。
⚠ 「include は無ければ足す」と書くと、**当てる順で出力が変わる**(先に当てた側が足した include を
後の側が「在る」と見て足さない、またはその逆 ── 出力が当てた順に依る)。
🔑 **include は無条件に足し、印を付ける**(在るかを見ない)。そのうえで次の 3 つを test で pin する:
①**錨が交わらない**(2 つの patch の置換前の字が重ならない)②**挿入点が別**
③ **両順(A→B / B→A)で出力が同一**(`diff -r` が 0)。形は `tests/office-ime-nowait-patch.test.ts`。
⚠ 片方の patch を単独で test するだけでは、**もう片方が先に当たった版**を 1 度も通らない
(§2 の「通っていない経路」と同型)。

### 🔴 #1393 / #1396 の LO 側の直し 3 本(2026-10-07。⚠ 焼く前 ── 効くかは未測定)

JSPI の Qt backend では、レイアウトの Idle(`InterimItemWindow::m_aLayoutIdle`)が dispose / entry 操作の**途中**に main スレッドから割り込める。
`~Task` の後しか見ない #117 の直しは、この途中を塞いでいない。**別の file・別の主張**なので 3 本に分けた(1 patch = 1 主張):

| patch | 触る所 | 主張 | 印 |
|---|---|---|---|
| `patch-lo-layout-guard.py` | `InterimItemWindow::Layout()` の `Stop()` の直後 | dispose 中(`m_xContainer` 無し)は返す | `PKC3-LAYOUTGUARD:` を出す |
| `patch-lo-hscroll-hdl.py` | `~SalInstanceScrolledWindow()` | 上流の戻し忘れ(横の `ScrollHdl`)を戻す | 出さない(停止の有無で見る) |
| `patch-lo-viewdata-gone.py` | `SvTreeListBox::getPreferredDimensions` | view data の無い entry / model の無い箱を飛ばす | `PKC3-VIEWDATAGONE:` を出す |

🔑 焼いて停止の回に `PKC3-VIEWDATAGONE` が **0 回**のまま落ちたら、3 本目の推測(view data が無い瞬間)が外れている ──
`m_pModel` null か `m_pImpl` null(`iconview.cxx:144`)側へ門を足す(#1396 のコメントの「覆る条件」)。
test は `tests/office-layout-guard-patch.test.ts` / `office-hscroll-hdl-patch.test.ts` / `office-viewdata-gone-patch.test.ts`
(fixture は上流 `7f96a38cf750` の file そのままの抜粋)。

### 🔴 #1393 形 B の門 `patch-lo-tooltip-guard.py`(2026-10-07。⚠ 焼く前 ── 門は**ぶら下がりを捕まえない**)

閉じている最中に `ToolTip::maShowTimer` が main スレッドへ SolarMutex なしで発火し、`ToolTip::DoShow()`(`SlsToolTip.cxx`)が
`GetPageObjectLayouter()` を null 検査なしで使って `PageObjectLayouter::GetBoundingBox` で落ちる(30 回に 1 回)。
`!pWindow` の検査の直後に 5 つ見る門を足し、当たればそのツールチップ 1 回だけ出さず返る。印は `PKC3-TOOLTIPGUARD: DoShow skipped why=N`(**20 回まで**。上限は印だけ)。

| `why=` | 見るもの |
|---|---|
| 1 | `pWindow->isDisposed()` |
| 2 | `!pWindow->IsReallyVisible()` |
| 3 | `!mpDescriptor` |
| 4 | `!mpDescriptor->GetPage()` |
| 5 | `!…GetPageObjectLayouter()` |

🔑 **次の焼きの読み方**: 1〜5 のどれかが出て落ちない → 門が効いた(出た番号が「空だった物」)。
🔴 **どれも 0 回のまま落ちる → 門は原因に届いていない**(解放済みの `SdPage` / `PageObjectLayouter` を指したままの**ぶら下がり**は、null でも破棄済みでもないので素通りする)。
そのときは timer を dispose で止める側へ直す。害は「そのツールチップが 1 回出ない」だけ。
test は `tests/office-tooltip-guard-patch.test.ts`(fixture は上流 `d6226c1a` の `SlsToolTip.cxx` の抜粋。当て済みは **SKIP(exit 0)**)。

### 🔴 #1402 の印と null 門 `patch-lo-grip-guard.py`(2026-10-07。⚠ 直しではなく**主に印**)

Impress を開くと約 3 % で `SalGraphics::DrawPolyLine`(非 virtual の wrapper)← `OutputDevice::DrawPolygon(tools::Polygon)`(hairline)←
`SplitWindow::ImplDrawGrip` で落ちる。塗り(`DrawPolyPolygon`)が main スレッドへ hop する間に `mpGraphics` が変わりうるのに、縁を引く直前で誰も再検査しない
(`vcl/source/outdev/polygon.cxx`)。縁の直前に ① `mpGraphics` が null なら縁を引かず返る ② `before gfx=… dev=… stackfree=…` を **100 回まで**出し、
`DrawPolyLine` から戻ったら `after` を出す(旗が立った回だけ)。

🔑 **次の焼きの読み方**: `mpGraphics null after fill` が出る → null 門が効いた / `before` が出て `after` が出ないまま落ちる → 落ちたのは `DrawPolyLine` の中
(`gfx=` が前の回と違うかを見る)/ `before` が出ず落ちる → この経路ではない。
🔴 **解放済みの `SalGraphics` を指したままの `mpGraphics` は直せない**(null 門は素通りする)── 停止が残るのは想定内で、印が目的。
test は `tests/office-grip-guard-patch.test.ts`(fixture は上流 `d6226c1a` の `polygon.cxx` の抜粋)。

### 🔴 #1393 / #1396 / #117 の原因側の直し `patch-lo-timer-mutex.py`(2026-10-07。⚠ 焼く前 ── 🟡 推測。塞ぐのは**半分だけ**)

JSPI かつ PROXY_TO_PTHREAD でない wasm では、`QtTimer::timeoutActivated()`(`vcl/qt5/QtTimer.cxx`)が **SolarMutex を取らずに** main スレッドで走る
(上流が前処理で `SolarMutexGuard` を外し「too brittle」の TODO を書いている)。`Scheduler::CallbackTaskScheduling` は task の走査・`UpdateMinPeriod()`・`pTask` の選択を
mutex なしで進め、`pTask->Invoke()` の周りでだけ取る(`scheduler.cxx` の 407-417 / 522-533 / 611)。その間に LO のスレッドが窓を dispose し Task を delete すると、
解放済みの Idle(`null function or function signature mismatch`)/ 破棄中の `InterimItemWindow::Layout` / dispose 後のツールチップの timer になる、という読み。
直しは `#if` の**偽の側**(`#else`)で mutex を**待たずに**試す:`IsCurrentThread()` が真(main が持っている = `QtYieldMutex` の借りている状態)なら今まで通り /
`tryToAcquire()` が偽(LO のスレッドが持っている)なら `m_aTimer.start(1)` で 1 ms 後に張り直して返る / 取れたら RAII で `release()`。
印は `PKC3-TIMERMUTEX: skipped #N … t=<ms>` / `ran under mutex (skipped so far N) ran=M t=<ms>`(どちらも最初の 20 回 + 100 回ごと。上限は印だけ ── skip の累計 `N` で 1 ms の再武装の頻度を読む)。
🔑 `t=` は `steady_clock` の ms(wasm ではページ開始から)。#1408(最初の Tab の直後に無言で固まる、1/30)で、固まった後に **skip の行が続く = LO スレッドが鍵を持ったまま戻らない** /
**止まる = main の timer が返っていない** を読み分けるため(以前の 1000 回ごとでは 372 → 1000 の間が無音だった)。🔴 鍵の所有者の thread id は上流に読み出し口が無く(`m_nThreadId` は private)出せない。

🔑 **次の焼きの読み方**(印は各 patch の `PKC3-*` の回数):
`PKC3-TASKGONE` / `PKC3-LAYOUTGUARD` / `PKC3-TOOLTIPGUARD` / `PKC3-VIEWDATAGONE` が **0 に近づく** → 原因は「走査と選択 → `Invoke`」の間だった(この直しが効いた)。
**減らない** → LO のスレッド自身が mutex を手放す所(`EmscriptenLightweightRunInMainThread` / `QtInstance.cxx` の `DoYield` の枝 B)が残っている ── この直しはそこを塞がない。
`PKC3-TIMERMUTEX: skipped` が 1 回も出ないなら、この直しは効く場面に 1 度も入っていない。
test は `tests/office-timer-mutex-patch.test.ts`(fixture は上流 `d6226c1a` の `QtTimer.cxx` の全文。当て済みは **SKIP(exit 0)**)。

### 🔴 #1408 の印 `patch-lo-yield-wait.py`(2026-10-07。⚠ 焼く前 ── **直しではなく印**。行き先は 🟡 推測)

Impress の読み込み中(約 13 秒)に 1/30 で無言で固まる。直前まで timer は鍵を取れずに skip し続け、その後 `m_aTimer.start(1)` 自体が止まる = main の event loop が回らない。
候補は、main の別の入口が `QtYieldMutex::doAcquire`(`vcl/qt5/QtInstance.cxx`)の main の枝で、LO スレッドの鍵を `m_InMainCondition.wait`(述語つき・無期限)で待ったまま戻らないこと。
`wait` の**外側の前後**に `PKC3-YIELDWAIT: enter #N t=<ms> held_by_lo=1 wake=<0/1> closure=<0/1>` と
`leave #M (enter #N) t=<ms> waited=<ms> closure=<0/1>` を足す(連番は enter / leave で別。**3000 回までは毎回**、その後 100 回ごと、
`waited` が 100 ms を超えた leave は必ず)。`held_by_lo` は `tryToAcquire` が偽の枝なので構成上いつも 1。
🔑 **読み方**: 固まった run の最後の行が `enter #N` で同じ N の `leave` が無い = **main はその wait で止まっている**(決め手)。
leave が出た後に無音なら、main は別の所で止まっている(この印は指さない)。⚠ 3000 回目より後に固まれば enter は 100 回に 1 回しか出ない ──
最後の leave の `#M` と timer の最後の行(`PKC3-TIMERMUTEX: skipped #N … t=`)の時刻を突き合わせて読む。
test は `tests/office-yield-wait-patch.test.ts`(fixture は上流 `d6226c1a` の `QtInstance.cxx` の 95〜205 行 = `tests/fixtures/office-lo/QtYieldMutex.excerpt.cxx`。
手元の stub harness では compile と enter/leave の出方を確かめた ── 本物の header ではまだ)。

### 🔴 #1402 の閉じた直後の停止 ── 計装 3 本 `patch-lo-surface-trace.py` / `patch-lo-sdpr-trace.py` / `patch-lo-gfxdata-trace.py`(2026-10-07。⚠ 焼く前 ── **直しではなく印**。行き先は 🟡 推測)

Office を閉じた直後に、本体スレッドが `ThumbnailView::Paint` ← `createPixelProcessor2DFromOutputDevice` で `memory access out of bounds`(先の grip-guard とは別の経路)。
候補は 2 つ: ① `QtSvpSalFrame::DoHandleResizeEvent`(`vcl/qt5/QtSvpSalFrame.cxx`)が **main で SolarMutex なしに** 新しい cairo surface へ差し替えて古い物を捨てる間に、
本体が `GetGraphicsData()` で受け取った生の `pSurface` を `CairoPixelProcessor2D` の ctor が読む ② `OutputDevice::GetSystemGfxData`(`vcl/source/outdev/outdev.cxx`)が
`ApplyFullDamage()`(SolarMutex を手放す hop)の**後**に `mpGraphics` を読み直す間に、`WindowOutputDevice::AcquireGraphics` の奪取で null にされる。

| patch | 当て先 / 印 | 内容 |
|---|---|---|
| `patch-lo-surface-trace.py` | `QtSvpSalFrame.cxx` / `PKC3-SURFACE:` | `resize before`(作った後・差し替えの前)/ `resize after`(`m_pSurface.reset` の後)/ `resize destroy old=X`(`copySource` の後 = 古い surface が捨てられる直前)。毎回出す(頻度が低い) |
| `patch-lo-sdpr-trace.py` | `processor2dtools.cxx` / `PKC3-SDPR:` | `enter #N outdev= type=`(**`HasMirroredGraphics()` の前**)と `made #N outdev= valid=`(ctor の直後)。300 回まで毎回・以後 50 回ごと・**2 秒空いたら必ず・`outdev` が前回出した物と変わったら必ず・前の呼び出しから 100 ms 空いたら必ず**(閉じた直後の連続描画の先頭と相手の入れ替わりを拾う) |
| `patch-lo-gfxdata-trace.py` | `outdev.cxx` / `PKC3-GFXDATA:` | `ApplyFullDamage` の前後で `mpGraphics` が**変わったときだけ** `gfx changed before= after=`(0 行なら変わっていない)+ 🔴 **after が null なら空の `SystemGraphicsData()` を返して落ちない**(門)+ 返す直前の `surface outdev= gfx= surface=`(300 回まで毎回・50 回ごと・2 秒空いたら必ず・**`pSurface` が前回出した値と変わったら必ず** = resize の直後の最初の読み) |

🔑 **次の焼きの読み方**: `t=` は 3 本とも同じ `steady_clock` の ms。
`PKC3-SDPR: enter #N` があって `made #N` が無いまま落ちる → 落ちたのは `HasMirroredGraphics()` か ctor の中 / `surface=X` が `PKC3-SURFACE: resize destroy old=X` の `t=` より**後**に読まれている → 捨てた surface を読んだ(①)/
`gfx changed … after=(nil)` が出る → ② が当たり、門が効いた(落ちる回が減る)/ どれも出ずに落ちる → 候補が外れ。
🔴 **直らないもの**: 門は null のときだけ。`pSurface` が差し替えで捨てられた物を指す競合(①)は印だけで直さない。出ない形は 1 つだけ: 同じ `outdev` / 同じ `pSurface` への呼び出しが 100 ms 未満の間隔で続く塊の**途中**(50 回の倍数でも前回の出力から 2 秒未満でもない回)で落ちたとき。そのときは最後の行の `t=` と落ちた時刻の差で読む。
test は `tests/office-surface-trace-patch.test.ts` / `office-sdpr-trace-patch.test.ts` / `office-gfxdata-trace-patch.test.ts`(fixture は上流 `d6226c1a` の抜粋 `tests/fixtures/office-lo/{QtSvpSalFrame,processor2dtools,outdev}.excerpt.cxx`。
3 本の `pPkc3Ms`(`steady_clock` の ms)が一致することは `tests/office-trace-clock-parity.test.ts` が見る。共有の道具は `tests/helpers/office-lo-patch.ts` ── 当てた後の関数を**型だけ stub に替えて g++ でコンパイルして走らせる**(`-Wall -Wextra -Werror`。g++ が無い箱では skip。本物の LO の header ではない)。
`PKC3_LO_UP=<上流 d6226c1a の木>` を渡すと実 file にも当たる)。ヘルパー関数を作らない(lambda を関数の中に置く)ので `check-patch-scope.py` の SPECS / FIXES には載せていない(grip-guard / timer-mutex と同じ)。

## 12. 🔴 詰め込みの命令行は **128 KiB** で切れる(2026-08-30、#591)

焼きが `make` の 15 分で落ち、こう出た:

```
make[1]: *** [static/CustomTarget_emscripten_fs_image.mk:1985: … ] Error 127
```

⚠ **`Error 127` を「command not found」と読まない。** 実体は
**`/bin/sh: Argument list too long`** で、make はこれを 127 で報告する。

### なぜ起きるか

上流の recipe は `--preload $(shell cat $^)` と書く ── **make が展開する**ので
**数千の path が recipe の行にそのまま並ぶ**。recipe は `&&` / `||` を含むので
make は `/bin/sh -c "<行まるごと>"` で起動する = **行全体が 1 引数**。

🔑 ここで効くのは `ARG_MAX`(約 2MB)ではなく **`MAX_ARG_STRLEN` = 128 KiB**
(1 引数の上限)である。⚠ **この違いを知らないと「件数が少ないから関係ない」と
読み違える**(実際に 1 度そう判断して、正解を自分で潰した)。

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

### 直っている形(`patch-lo-fsimage-cmdline.py`)

    --preload $(shell cat $^)   →   --preload $$(cat $^)

展開を **make から shell へ移す** ── recipe の行が短いままなので、上限が
`ARG_MAX`(約 2MB)側になる。⚠ 語の分割は変わらない(`$(shell …)` の出力も
shell が分割していた)。

### 🔑 手元で確かめる(30 秒。焼かなくてよい)

```bash
cd /tmp && for n in 129000 133000; do
  printf 'all:\n\t@cd . && /bin/true %s || echo fallback\n' "$(head -c $n < /dev/zero | tr '\0' x)" > Mk
  make -f Mk >/dev/null 2>&1; echo "$n -> exit=$?"
done
# 129000 -> exit=0 / 133000 -> exit=2(`Argument list too long` / Error 127)
```

⚠ **診断の grep はこの行を拾わない** ── `Argument list too long` には
`error:` も `***` も無い。だから workflow の診断に「**落ちた行の手前 80 行**」を
出す段を置いてある(2026-08-30)。**型に当たらないエラーこそ読みたい。**

## 15. 🔴 `wasm-function[60973]` を名前に直す ── 焼き直さない(2026-09-08、#631)

> ⚠ **「名前つきで焼き直すしかない」と書こうとした瞬間に、ここを読む。**
> #117 / #88 / #431 は、その思い込みで**焼き 1 本(30 分〜4 時間)待ち**のまま止まっていた。

配っている一式には **name section が 0 件**なので、停止のスタックは
`wasm-function[60973]` という**番号だけ**で出る。🔑 だが
**`--profiling-funcs` は名前の節を足すだけ**で、関数の並びも offset も動かさない ──
つまり**名前つき一式の表を引けば、配布一式の番号がそのまま名前になる**。

```bash
# ① 名前つき一式を落とす(§1 と同じ手順。tag に -names が付いているもの)
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

### 落ちる形(全部わざとそうしてある)

| 渡したもの | どうなるか |
|---|---|
| **配布一式**(name section 0 件) | ✗ で止まる。⚠ 黙って「名前なし」を並べると、渡した人が「名前が付いていない関数だ」と誤読する |
| name section は在るが**関数名の副節が無い** | ✗ で止まる |
| **`lo_sha` が違う / 7 文字未満** | ✗ で止まる(上の反例をそのまま踏むため) |
| `build-info.json` が無い | ✗ で止まる(どの枝か分からないまま引かない) |
| **引けなかった番号が 1 件でもある** | 引けた分は刷ってから ✗(穴を黙って読ませない) |

検めているのは `tests/office-wasm-names.test.ts`(自作の wasm を組む ── 実物に依存すると
手元でも CI でも走らない)。変異試験 **9/9 KILLED**(2026-09-08)。
