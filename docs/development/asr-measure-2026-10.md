# #772 段②-0「入れて測る」── 文字起こし部品の実測(2026-10-01)

⚠ **数字と手順だけ。設計の判断は書かない**(段②〔部品を後から取り込む仕組み〕・段③〔字にして追記〕の設計は別 doc)。
製品コード(`src/`)・マニュアル・お知らせは触っていない。probe は `tests/probe/asr-probe.mjs`(1 本)。

- 起点: main `1395a8c9`(worktree の `git log -1` で確認)/ 計った日: 2026-10-01
- 箱: 4 コア / 16GB / Chromium(`/opt/pw-browsers/chromium` = chromium-1194)/ headless
- ⚠ **この箱は混んでいた**: 計測中の load average は **5.5〜7.3**(4 コアに対して。うち 2 割弱は probe 自身)。
  同じ組み合わせを 2 回回した実例(`tiny` / COI あり / 60 秒の音)で 1 回目の処理が **11.3 秒 → 17.9 秒**と
  **5 割ぶれた**。⚠ 秒数は**向きと桁**だけ読む。メモリ(Pss)はぶれが小さい(同じ組み合わせで ±10MB 程度)。

## 1. 取れるか(この箱から。`curl --cacert /root/.ccr/ca-bundle.crt`、TLS 検証は切っていない)

| 取得先 | 何を取ろうとしたか | 結果 |
|---|---|---|
| `huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{tiny,base,small}-q5_1.bin` | whisper.cpp の量子化モデル | 🔴 **403**(CONNECT 段階で proxy が拒否。本文なし) |
| `huggingface.co/Xenova/whisper-base/…` / `onnx-community/whisper-base/…` | ONNX の whisper | 🔴 **403** |
| `cdn-lfs.huggingface.co` / `cdn-lfs.hf.co` / `cas-bridge.xethub.hf.co` / `hf-mirror.com` | HF の配信・ミラー | 🔴 **403** |
| `modelscope.cn` / `registry.npmmirror.com` / `cdn.npmmirror.com` | 国内ミラー | 🔴 **403** |
| `openaipublic.azureedge.net` / `openaipublic.blob.core.windows.net` | OpenAI 本家の重み | 🔴 **403** |
| `cdn.jsdelivr.net` / `unpkg.com` / `esm.sh` | npm の CDN | 🔴 **403** |
| `whisper.ggerganov.com` / `ggml.ggerganov.com` | whisper.cpp のデモ | 🔴 **403** |
| `github.com`(archive / releases)/ `codeload.github.com` / `api.github.com` | whisper.cpp の release・source | 🔴 **403**(proxy は 200 を返したあと GitHub 側の応答が 403。`gh api` は「sessions are bound to their configured repositories」) |
| `raw.githubusercontent.com/<repo>/…` | LICENSE / README(**文字の file**) | 🟢 **200** |
| `registry.npmjs.org`(search / metadata / tarball) | npm の package | 🟢 **200** |
| `pypi.org` / `index.crates.io` / `proxy.golang.org` / `repo1.maven.org` | 他の registry | 🟢 200(**whisper の重みを含む package は探していない**) |

🔑 **取れた経路は npm だけ**。whisper.cpp の **ggml モデル(`ggml-*-q5_1.bin`)は 1 本も取れなかった**
(npm にも載っていない ── `ggml-base` / `ggml-tiny` / `whisper q5_1` などで search し、モデルを同梱する package は
見つからなかった。見つけたのは「実行時に HF から落とす」型だけ)。
→ **whisper.cpp 系は「部品(wasm の本体)の大きさ」までしか実測できていない。モデルを載せた実行は未測定。**

## 2. 候補の大きさ(実測 = 落とした file の bytes。出典を書いた物は二次資料)

### 2-1. transformers.js + ONNX Runtime Web(npm だけで揃った。**実行まで測った**)

| 部品 | 取得 | bytes(raw) | 備考 |
|---|---|---|---|
| `@huggingface/transformers@4.3.0` の `dist/transformers.web.js` | npm tarball 2,246,252 | **1,146,742**(min 版 450,131) | ⚠ 単体では動かない(`onnxruntime-web/webgpu` と `onnxruntime-common` を bare import) |
| ORT-web wasm(**transformers が名指しする dev 版 `1.31.0-dev.20260914-8d85527a0`**) | npm | `ort-wasm-simd-threaded.wasm` **14,264,838**(gzip -9 で 3,667,699)/ `.asyncify.wasm` **26,861,777**(gzip 6,596,873)/ `.jsep.wasm` 28,352,885 / `.jspi.wasm` 16,811,691 | transformers の既定は **asyncify**(CDN `cdn.jsdelivr.net` から取る。この箱は 403 なので自前配信に差し替えて測った)。素の wasm(14.3MB)でも動いた |
| ORT-web の js | 同上 | `ort.webgpu.bundle.min.mjs` 117,929 / `ort-wasm-simd-threaded[.asyncify].mjs` 24,381 / 53,057 | |
| モデル `Xenova/whisper-tiny`(q8)| npm `sts-whisper-tiny@1.0.0`(⚠ **第三者が HF の Xenova 変換を npm に再梱包した物**)| tarball **28,694,719** / 展開後 **45,209,522** | encoder 10,124,910 + decoder 30,727,765 + tokenizer 等 |
| モデル `Xenova/whisper-base`(q8)| `sts-whisper-base@1.0.0` | tarball **52,236,560** / 展開後 **81,270,976** | encoder 23,200,850 + decoder 53,707,539(gzip しても 35.9MB ── ほぼ縮まない)|
| モデル `Xenova/whisper-small`(q8)| `sts-whisper-small@1.0.0` | tarball **165,623,913** / 展開後 **253,468,391** | encoder 92,324,809 + decoder 156,780,950 |

→ **base で一式を配ると**: ORT wasm 14.3〜26.9MB + モデル 81.3MB + js 約 1.3MB = 概ね **97〜110MB(raw)**。small なら **約 270〜285MB**。
⚠ 3 モデルとも **多言語**(`whisper-tiny` / `-base` / `-small`。`.en` ではない)。

### 2-2. whisper.cpp の wasm 版

| 部品 | 取得 | bytes(raw) | 備考 |
|---|---|---|---|
| `@transcribe/shout@1.0.7` | npm tarball 1,057,741 | `shout.wasm.js` **1,547,886**(wasm を JS に内蔵。gzip 546,957)/ `shout.wasm_no-simd.js` 1,407,838 | SIMD 版と **非 SIMD 版の両方を同梱**。MIT |
| `@fugood/node-whisper-wasm@1.2.0-rc.0` | npm tarball 2,242,179 | `whisper-node.wasm` 4,183,189 / `whisper-node.threads.wasm` 4,374,807 | 1 スレ版と pthread 版の両方。COI + SAB があれば pthread 版へ自動で切替(README) |
| `@timur00kh/whisper.wasm@0.1.1` | npm tarball 1,504,565 | `libmain-*.js` 約 1.37〜1.39MB | |
| `whisper-web-transcriber@0.2.5` | npm tarball 1,550,351 | `libstream.js` 1,488,978 | **`.en` 専用**(tiny.en / base.en とその q5_1) |
| `@remotion/whisper-web@4.0.532` | npm tarball 504,196 | `main.js` 1,420,950 | ⚠ license が **UNLICENSED**(package.json)|
| **モデル `ggml-{tiny,base,small}-q5_1.bin`** | 🔴 **取れなかった**(§1)| **未確認** | 二次資料: `@timur00kh/whisper.wasm` の `ModelManager` の表(`dist/index.es.js` の `size:`。単位の記載なし)に **tiny-q5_1 = 31 / base-q5_1 = 57 / small-q5_1 = 182**、`whisper-web-transcriber` の README に `tiny-en-q5_1 31MB` / `base-en-q5_1 57MB`。⚠ **どちらも 1 次(HF の実 file)では確かめていない** |
| 参考: 非量子化(whisper.cpp 公式 README / models/README.md、raw.githubusercontent から取得)| — | tiny **75 MiB** / base **142 MiB** / small **466 MiB** | 実行時メモリ(同 README の表): tiny ~273MB / base ~388MB / small ~852MB。q5 系で書いてあるのは `large-v2-q5_0` 1.1GiB・`large-v3-q5_0` 1.1GiB・`large-v3-turbo-q5_0` 547MiB だけ |

## 3. ライセンス(実際に読んだ file)

| 物 | ライセンス | 読んだ所 |
|---|---|---|
| whisper.cpp 本体 | **MIT**(Copyright 2023-2026 The ggml authors)| `raw.githubusercontent.com/ggml-org/whisper.cpp/master/LICENSE` |
| OpenAI Whisper(コードと**重み**) | **MIT**(Copyright 2022 OpenAI)。README に「code and model weights are released under the MIT License」| 同 repo の `LICENSE` と `README.md` 160 行目 |
| ONNX Runtime | **MIT**(Microsoft)| repo の `LICENSE`。⚠ npm の `onnxruntime-web` tarball には **LICENSE file が入っていない**(`package.json` の `license: MIT` のみ)|
| transformers.js | **Apache-2.0** | npm tarball 内の `LICENSE` |
| `@transcribe/shout` | **MIT**(Copyright 2024 thurti)| tarball 内の `LICENSE` |
| `@timur00kh/whisper.wasm` | **MIT**(2025-2026 Timur Kh)| tarball 内の `LICENSE` |
| `@fugood/node-whisper-wasm` / `whisper-web-transcriber` | MIT | `package.json` の `license`(LICENSE file は未読)|
| `@remotion/whisper-web` | **UNLICENSED** | `package.json` |
| `sts-whisper-{tiny,base,small}`(ONNX 重みの再梱包)| `package.json` は **Apache-2.0**。⚠ **LICENSE file は入っていない** | 同梱の `package.json`。上流の OpenAI は MIT と明記しており、再梱包側の表記と**食い違う**(HF の model card は取れず未確認)|

## 4. 実測(transformers.js 4.3.0 + ORT-web dev + Xenova/whisper-* q8、標準の wasm CPU)

測り方(probe が毎回これを行う): まっさらな profile / loopback の自前 http サーバーで配信(**回線の時間は入らない**)/
推論は **module Worker の中** / 音は ffmpeg の flite で作った**英語の合成音声 60 秒**(16kHz mono)/ 処理は 2 回続けて計る
(1 回目が warm-up を含む)/ `chunk_length_s: 30, stride_length_s: 5` / `device: 'wasm'` / `dtype: 'q8'`。
Pss は **Chromium の profile を握る全プロセスの合計**(`tests/helpers/proc-memory.mjs` の `profileMemoryMb`)。
「何も載せていない 1 ページ」の Pss(下表の blank)が **265MB**(`tiny` の COI なし 1 件だけ 185MB と低く出た。
ぶれの幅として読む)。

| 組み合わせ | ORT wasm | threads(実効)| import | 読み込み | 60 秒の音: 1 回目 / 2 回目 | Pss: 読み込み直後 | Pss: 推論中の最大 | Pss: worker を terminate した +10 秒 |
|---|---|---|---|---|---|---|---|---|
| tiny / COI あり | asyncify 26.9MB | 2 | 66ms | 1.8 s | **11.3 s / 13.2 s**(再走: 18.0 s / 13.7 s)| 794MB | **1,169MB** | 303MB |
| tiny / COI なし | asyncify | 1 | 59ms | 2.1 s | 16.9 s / 15.2 s | 714MB | 1,172MB | 212MB |
| base / COI あり | asyncify | 2 | 63ms | 2.7 s | **28.8 s / 24.3 s** | 928MB | **1,653MB** | 299MB |
| base / COI なし | asyncify | 1 | 78ms | 3.5 s | **33.7 s / 31.6 s** | 1,009MB | 1,650MB | 296MB |
| base / COI あり / 素の wasm(14.3MB)| plain | 2 | 68ms | 2.4 s | 34.8 s / 24.7 s | 759MB | 1,629MB | 295MB |
| base / COI あり / threads=4 | asyncify | 4 | 62ms | 3.4 s | 54.2 s / 29.7 s ⚠ | 934MB | 1,656MB | 299MB |
| base / COI あり / **無音 60 秒** | asyncify | 2 | 65ms | 2.4 s | 8.3 s / 7.4 s | 978MB | 1,648MB | 301MB |
| small / COI あり | asyncify | 2 | 78ms | **5.0 s** | **63.8 s / 59.7 s** | 1,447MB | **3,632MB** | 292MB |
| small / COI なし | asyncify | 1 | 87ms | 3.6 s | **82.0 s / 81.9 s** | 1,444MB | 3,589MB | 298MB |

読み取りの注意(事実だけ):
- **COI なし(SharedArrayBuffer なし)でも動いた**。ORT が threads を 1 に落とす。処理時間は base で 28.8 → 33.7 秒(+17%)、small で 63.8 → 82.0 秒(+29%)、tiny で +50%(ぶれの幅と同程度)。
- **threads=4 は速くならなかった**(1 回目 54 秒は混んだ箱の影響を含む。2 回目 29.7 秒でも 2 threads の 24.3 秒より遅い)。
- **60 秒の音を字にするのに、base で 24〜34 秒 / small で 60〜82 秒 / tiny で 11〜18 秒**(この箱・この混み具合で。base は**音の長さの 0.4〜0.6 倍**の時間がかかった)。
- **推論中の最大 Pss は、読み込み直後より高い**(tiny で +375MB、base で +725MB、small で +2,185MB)。⚠ **同じ model なら COI の有無・wasm の種類・threads が違ってもほぼ同じ値**(base は 1,629〜1,656MB)。
- **worker を terminate すると Pss は blank + 30〜35MB まで戻った**(+3 秒では blank + 115〜120MB、+10 秒で戻る。`tiny` の COI なし 212MB は blank が低く出た回)。
- **無音 60 秒は 7〜8 秒で終わるが、出力は `" you you you"`**(Whisper が無音に字を出す既知の癖。VAD 無しの素の呼び出し)。
- 合成英語音声での一致(単語列の編集距離で出した**参考値**。⚠ きれいな合成音 1 本・英語だけ): tiny **約 3.3%** の誤り / base **0%** / small **約 0.5%**。
- `navigator.gpu` は headless の Chromium でも `true` だったが、**WebGPU 経路(`jsep`)では走らせていない**(全部 `device: 'wasm'`)。

### 要件

| 要件 | 結果 |
|---|---|
| **SharedArrayBuffer / COI(cross-origin isolated)**| ORT-web: **要らない**(無くても動く。上の表の「COI なし」)。⚠ 速さに効くのは 2 threads 化だけで、base で +17% 程度。whisper.cpp 系: **要る**(`@transcribe/transcriber` README「Your browser must support `SharedArrayBuffer`」/ `@remotion/whisper-web` も SAB 必須 / `@fugood` は無ければ 1 スレ版へ自動で落ちる)。⚠ **whisper.cpp 系の実行は未測定なので、この「要る」は README の記述**|
| **wasm SIMD** | ORT-web 1.31 dev の npm package の wasm は **全部 `simd-threaded`**(非 SIMD の build は同梱されていない)→ SIMD の無い環境では動かない見込み(⚠ SIMD を切った環境で**走らせてはいない**。この Chromium は SIMD を切れない)。whisper.cpp 系: `@transcribe/shout` は **SIMD 版と非 SIMD 版を両方同梱**。`whisper.wasm` の README も「SIMD 128 を使う」 |
| 配信ヘッダ | COI を使うなら `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`(probe の `--coi on` が付けるのはこの 2 つと `Cross-Origin-Resource-Policy: same-origin`)|

## 5. 測れなかった物(この箱では測れない)と、その理由

| 測れなかった物 | 理由 |
|---|---|
| **whisper.cpp wasm の実行(読み込み秒・Pss・60 秒の処理秒)** | ggml のモデルが取れない(HF が 403)。部品(wasm)だけでは起動しない。出典のある数字は 1 つだけ: `whisper.wasm` の README「tiny / base で実時間の 2〜3 倍(**60 秒の音を 20〜30 秒**)・最大 120 秒・small まで」(⚠ 1 次の主張。こちらでは未検証)|
| **日本語の当たり具合(誤り率)** | 人の日本語の音声が箱に無い(`espeak-ng` / `espeak` / `flite` / `pico2wave` のコマンドは無し。ffmpeg の `flite` filter は**英語だけ**)。⚠ 英語の合成音声は**日本語の代わりにならない** |
| ggml `q5_1` の実際の大きさ(base / small) | §2-2。二次資料の 57MB / 182MB だけ |
| 実機(特に Mac / Windows の標準ブラウザ)の速さ・メモリ | この箱は Linux の Chromium だけ。Safari / Firefox / Edge は無い |
| **WebGPU 経路の速さ** | headless の箱に GPU が無い(`navigator.gpu` は真だが、アダプタの実在は確かめていない) |
| SIMD の無い環境で動くか | Chromium は SIMD を切れない |
| 長い音(30 分〜)の常駐・処理時間 | 60 秒しか測っていない。chunk を増やしたときにメモリが増え続けるかは未測定 |
| 実際の録音(マイク・会議・雑音・複数人)| 合成の 1 話者のみ |
| 取得の時間(回線)| loopback 配信なので読み込み秒に入っていない |
| 読み込みの**2 回目以降**(HTTP / Cache Storage が温まった後)| 毎回まっさらな profile で、初回だけ |

## 6. 実機向け指示プロンプトの下書き(cowork / user の実機へ。型は `.claude/skills/cowork-verification/SKILL.md`)

> **これは下書きです。投げる前に、手順 0 の「版の確定」を実際のコマンド出力で確かめてください。**

```
普段使いのつもりで、自由に触ってください。「あれ?」と思ったことは、些細でもテスト項目に無くても
全部書き留めてください。それがいちばん欲しい収穫です。

【やってほしいこと】あなたのパソコンで「声を字にする部品」を動かして、速さ・メモリ・日本語の当たり具合を測る。
PKC の画面は使いません(部品だけを手元で動かす小さな試験です)。

【手順 0: どの版を見ているか確かめる】
 1. リポジトリの `wip/772-asr-measure` を取得し、`git log -1 --format=%H` の出力を最初に貼ってください。
 2. `node -v`(22 以上)と、`navigator.hardwareConcurrency` と、使うブラウザ名・版を貼ってください。

【準備】(落とすものは repo に入れません。作業用の場所に置いてください)
 - 部品: `npm install @huggingface/transformers@4.3.0`(作業用の空の場所で)
 - モデル: `npm pack sts-whisper-base@1.0.0` と `npm pack sts-whisper-small@1.0.0` を展開(`package/models/Xenova/…`)
 - 音声: **日本語の人の声 1〜3 分**(自分の声か、普段の録音)。
   `ffmpeg -i 元.m4a -ar 16000 -ac 1 -c:a pcm_s16le 日本語.wav`
   ⚠ 中身は誰にも見せない音声でよい(結果の本文は貼らず、**当たり具合の感想だけ**書いてください)。

【測ること】(この 3 つだけは必ず。残りは触る中で気づいたら)
 1. `node tests/probe/asr-probe.mjs --transformers <dist> --ort <dist> --models <models> --wav 日本語.wav --model base --lang japanese --coi on --port 47871`
    を `--model base` と `--model small` の 2 回。出力の JSON(`loadMs` / `runMs` / `pssMb` / `audioSec` / `env`)をそのまま貼ってください。
    ⚠ Pss は Linux 専用の計器です。Mac / Windows では `pssMb` が 0 や空になります ──
    その場合は **アクティビティモニタ(Mac)/ タスクマネージャ(Windows)で、ブラウザの全プロセスのメモリ合計を、
    「処理の直前」「処理中の最大」「終わって 10 秒後」の 3 点で**読んで書いてください。
 2. `text1`(字になった日本語)を**人が読んで**、次を 1 つ選んでください:
    「ほぼそのまま読める / 少し直せば使える / 直すより打ち直したほうが速い」。
    固有名詞・数字・言い間違いの扱いで気になった点を 3 行まで。
 3. 同じ音を、ブラウザの「他のタブを閉じた状態」と「普段どおり 10 タブ開いた状態」で 1 回ずつ回して、
    `runMs` の差を書いてください(体感が悪くなるかの目安です)。

【やらなくてよいこと】
 - 部品の中身(ソース)を読むこと。実挙動だけ見てください。
 - 英語の音声での確認(こちらの箱で済んでいます)。
 - WebGPU 経路(`--variant` は既定のまま)。

【報告の様式】
 - 版の確定(手順 0)→ 測ること 1(JSON)→ 2(感想 1 つ + 3 行)→ 3(秒数 2 つ)の順。
 - 「確かめて書いた」ことと「たぶんそう」を区別して書いてください。
 - **その他、気づいたこと(自由)**: ここは空でも欄ごと残してください。
 - 結果がこちらに返ったら決まること: 日本語の当たり具合で「base で足りるか small が要るか」、
   および実機の処理秒・メモリで「バックグラウンドで走らせてよい重さか」。
```

## 7. 再現の手順(この数字を出した手順)

```bash
# 作業場所(repo の外)。落とした物は repo に入れない
S=<scratch>/asr; mkdir -p $S/app $S/pkg && cd $S
echo '{"name":"asr-app","private":true,"type":"module"}' > app/package.json
npm install --prefix app --ignore-scripts @huggingface/transformers@4.3.0     # ORT-web は dev 版が一緒に入る
for m in tiny base small; do npm pack sts-whisper-$m@1.0.0 --pack-destination . ; done   # 各 28.7MB / 52.2MB / 165.6MB
#  → 各 tgz を pkg/sts-whisper-<m>/ に展開し、pkg/models/Xenova/whisper-<m> へ symlink
# 音(英語の合成。日本語は作れない)
ffmpeg -f lavfi -i "flite=textfile=speech.txt:voice=slt" -ar 16000 -ac 1 -c:a pcm_s16le raw.wav
ffmpeg -i raw.wav -t 60 -c:a pcm_s16le speech-60s.wav
# 1 組み合わせ(port は 47871〜47873)
PKC3_CHROMIUM=/opt/pw-browsers/chromium node tests/probe/asr-probe.mjs \
  --transformers $S/app/node_modules/@huggingface/transformers/dist \
  --ort $S/app/node_modules/onnxruntime-web/dist \
  --models $S/pkg/models --wav $S/speech-60s.wav \
  --model base --coi on --threads 0 --variant asyncify --port 47871
```

⚠ 上の表は probe の**初稿**(`--lang` 引数と `URLSearchParams` の import を足す前)で回した。足した後の版で `tiny` / COI あり を 1 回だけ再走し、動くことを確かめた(表の「再走」)。
⚠ probe は `tests/probe/*.mjs` の型(`@playwright/test` の `chromium` + `tests/helpers/proc-memory.mjs`)。**CI には載せていない**(重い・外から取る物がある)。
⚠ `--variant plain` は ORT の素の wasm(14.3MB)、`asyncify` は transformers の既定(26.9MB)。
