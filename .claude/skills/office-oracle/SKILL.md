---
name: office-oracle
description: PKC の Office(LibreOffice wasm)を手元に立てて、文書が本当に開くかを測る手順。「Office で開かない」「LO wasm」「#199」「#238」「docx が空のまま」「実機でしか確かめられない」という文脈で必ず使う。⚠ 「この箱では確かめられない」と書く前に必ずここを読む。
---

# Office(LO wasm)のオラクルを手元に立てる

> 🧊 **Office は凍結中**(`CLAUDE.md` §2-11、user 指示 2026-10-25)。LO / Qt の patch・焼き直し・office-pack の配布・probe の調査を新しく始めない。ここは**配布済みの一式で動いている入口が壊れたときのバグ修正**と、過去の調べ物の参照にだけ使う。

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
詳細(経緯・実測・手順)は [`reference/oracle-details.md`](reference/oracle-details.md) の同名の節へ移した。

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
詳細(経緯・実測・手順)は [`reference/oracle-details.md`](reference/oracle-details.md) の同名の節へ移した。

## 🔴 「保存できたか」の判定(2026-08-24、#225 で確立)
詳細(経緯・実測・手順)は [`reference/oracle-details.md`](reference/oracle-details.md) の同名の節へ移した。

## 🔴 その一式が非 ODF を保存できるか(#225)
詳細(経緯・実測・手順)は [`reference/oracle-details.md`](reference/oracle-details.md) の同名の節へ移した。

## probe は固まる ── 締切と、計器の選び方
詳細(経緯・実測・手順)は [`reference/oracle-details.md`](reference/oracle-details.md) の同名の節へ移した。

## 版面を押すと 2 回に 1 回落ちる ── 「押した後の結論」は全部弱い
詳細(経緯・実測・手順)は [`reference/oracle-details.md`](reference/oracle-details.md) の同名の節へ移した。

## コピーの後に外のクリップボードがどうなるか(#121)
詳細(経緯・実測・手順)は [`reference/oracle-details.md`](reference/oracle-details.md) の同名の節へ移した。

## 焼く・待つ・配る
詳細(経緯・実測・手順)は [`reference/oracle-details.md`](reference/oracle-details.md) の同名の節へ移した。

## LO / Qt / Emscripten に patch を足す・読むとき
詳細(経緯・実測・手順)は [`reference/oracle-details.md`](reference/oracle-details.md) の同名の節へ移した。

## 🔴 `wasm-function[60973]` を名前に直す ── 焼き直さない(2026-09-08、#631)
詳細(経緯・実測・手順)は [`reference/oracle-details.md`](reference/oracle-details.md) の同名の節へ移した。

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
