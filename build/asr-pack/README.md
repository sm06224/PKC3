# asr-pack: 音声認識の部品を作る(#772)

PKC3 の「音声・動画を文字にする」が端末へ取り込む**部品一式**(`/asr-pack/`)を作る script 群。
取る側は `src/features/asr/asr-parts.ts`(ファイル一覧を確かめる正本)と
`src/adapter/platform/asr/asr-pack-acquire.ts`、配布する側の置き場は同一オリジンの **`/asr-pack/`**
(別 repo `sm06224/asr-pack` の GitHub Pages。office-pack と同じ形で、`build/office-wasm/README.md` を見てください)。
契約と実測は `docs/development/asr-measure-2026-10.md` §8。

⚠ **この directory の依存は PKC3 本体の `package.json` に混ぜない。**
`build/oss-notices-plugin.ts` は本体の `dependencies` を「使っている OSS」として数えるため、混ぜると
アプリ本体の「使っている OSS」に、配布する物へ入らない物が載る。専用の `package.json`(と `package-lock.json`)を置いた。

## 出来上がり(`--out <dir>`、既定 `dist-asr-pack/`。生成物なので追わない)

```
pack.json                       ファイル一覧(version / build / runtime / models)
runtime/transformers.mjs        transformers.js(web 版)+ onnxruntime-web を 1 枚の ESM に束ねた物
runtime/ort-wasm.mjs            ORT の ort-wasm-simd-threaded.mjs
runtime/ort-wasm.wasm           ORT の ort-wasm-simd-threaded.wasm(14.3MB)
models/Xenova/whisper-base/…    軽い(段 2 の出力を置く)
models/Xenova/whisper-small/…   正確(同上)
LICENSES/                       同梱するライセンス(collect-licenses.mjs)
bundle-info.json                何を束ねたか(make-pack が build へコピーする)
```

`pack.json` の `version` は**内容由来**(`(path, sha256)` を path 順に並べた列の sha256 の先頭 12 桁)。
日時・run id・tag は入れない(使い回す名前は、中身が入れ替わっても変わらない)。人が読む素性は `build`
(transformers / ORT のバージョン・HF の宣言・日時・run id)にあり、`readAsrPack` は読み飛ばす。

## script

| script | 何をするか |
|---|---|
| `bundle-runtime.mjs` | esbuild で `transformers.web.js` を 1 枚に束ねる(`onnxruntime-web/webgpu` と `onnxruntime-common` を ORT の webgpu bundle へ向ける)。ORT の wasm / loader をコピーする。**束ねた出力に裸の指定子が残っていたら止まる**。ORT のバージョンが transformers の名指しと違っても止まる |
| `collect-licenses.mjs` | 束ねに入った package(とその依存の閉包)の LICENSE を `LICENSES/` へ。上流の全文(whisper / transformers.js / onnxruntime + ThirdPartyNotices)を取得して URL と sha256 を `SOURCES.json` へ。重みの配布元(HF)が宣言するライセンスと sha を `MODELS.json` へ |
| `make-pack.mjs` | `runtime/` と `models/<modelId>/` を数えて `pack.json` を書く(sha256 は流して出す) |
| `check-pack.mjs` | 組み上がった一式の検品。門ごとに別の文言で落ちる(門の一覧はファイルの冒頭)。`--strict-model-license` で「重みのライセンスが取れていない」も赤にする |

```bash
cd build/asr-pack && npm ci --ignore-scripts          # asr 用の依存(sharp / onnxruntime-node の postinstall は要らない)
cd ../.. && npm ci                                    # PKC3 の root(check / make が src の正本を vite で読むため)
node build/asr-pack/bundle-runtime.mjs   --out dist-asr-pack
node build/asr-pack/collect-licenses.mjs --out dist-asr-pack
# ← ここで models/<modelId>/… を置く(段 2)
node build/asr-pack/make-pack.mjs        --out dist-asr-pack
node build/asr-pack/check-pack.mjs       --out dist-asr-pack --strict-model-license
```

⚠ ネットワークが proxy 越しの環境(この開発環境)は `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<CA bundle>` を付ける
(Node の `fetch` は既定で環境の proxy を見ない)。⚠ HF の API はその環境からは 403 になることがある。
`collect-licenses` は止まらず `MODELS.json` に「取れなかった」と残し、`check-pack` は警告を出す
(**配布前の検品は `--strict-model-license`**。Actions では取れる)。上流の全文が取れないときだけ
`--allow-offline`(止まらず記録する)。

## 段(2026-10-02 の計画。各段が単独で着地する)

| 段 | 何をするか | 状態 |
|---|---|---|
| **0** | **157MB のダミーの通過実験**:small の `decoder_model_merged_quantized.onnx` は 1 ファイルで **157MB**。GitHub Pages の 1 ファイル 100MB の制限を、Actions から直接配布する Pages が**越えられるか**を、ダミー(`truncate -s 157000000`)で `pack.json` ごと配布して、取る側(取り込み)が最後まで読めるかを見る。⚠ 制限を超えるなら**分割**(`*.part1` …)を取る側へ足す必要がある(いまは未実装)| 未 |
| **1** | **この directory の script**(束ね / ライセンス / `pack.json` / 検品)。手元で作れて検品まで通る | ✅ 本 PR |
| **2** | **重みの変換**:transformers.js **3.7.6** の `scripts/convert.py` で `openai/whisper-base` / `-small` を ONNX にして `--quantize`(q8)。出力を `models/Xenova/whisper-{base,small}/…` に置く。下の下書き | 未 |
| **3** | **Actions の workflow**(`sm06224/asr-pack` の `pages.yml`)。PKC3 の ref を checkout して上の script を回し、Pages へ配布する(office-pack の `pages.yml` と同じ型。組み立ての正本は PKC3 に 1 つだけ置く) | 未 |
| **4** | 本番の取り込み(PKC3 の画面から)を実ブラウザで通し、日本語の認識の精度を実機で測る | 未 |

### 段 2 の下書き(変換を Actions で回す手順)

- 変換は **transformers.js 3.7.6**(`scripts/convert.py`)を使う。⚠ 4.x の束ね(本 directory)とは**別のバージョン**でよい。
  変換は重みの形式を作るだけ。実行側(4.3.0 + ORT 1.31.0-dev)が **Xenova の q8 の重み**を読むことは
  `docs/development/asr-measure-2026-10.md` §4 で通してあるが、**3.7.6 の `convert.py` が同じ名前・形で出す**ことは未確認(段 2 で実走して確かめる)。
- 呼び方の骨子(未検証。段 2 で実走して直す): `python -m scripts.convert --quantize --model_id openai/whisper-base`
  (small も同じ)。出力の `onnx/*_quantized.onnx` と config / tokenizer 一式を `models/Xenova/whisper-<size>/` へ。
  取り込み側が使うのは `encoder_model_quantized.onnx` / `decoder_model_merged_quantized.onnx`。実際に
  どの名前が出るかを**出力を見て**確かめ、`.onnx` の合計が `modelBytes`(`asr-parts.ts`)の半分以上であること(`check-pack` の `reader` 門が見る)。
- runner(`ubuntu-latest`)は **4 CPU / 16GB / 14GB disk**。small の変換は重いので、**base と small を別の job に分ける**
  (1 job = 1 主張。落ちたとき名前で言える)。disk は 14GB なので、HF の cache を job ごとに消す。
- 変換後の重みのライセンス:`LICENSES/MODELS.json` の宣言を**人が見て**から配布する(`--strict-model-license` は「取れたこと」しか見ない。
  OpenAI の GitHub は MIT、HF の model card は別の種別を宣言していることがある)。

## 束ねの実測(2026-10-02、esbuild 0.25.12)

`runtime/transformers.mjs` = **567,150 byte**(`docs/development/asr-measure-2026-10.md` §8 の実測 567,126 との差 24 byte は
esbuild のバージョンの差と見られる)。`ort-wasm.mjs` 24,381 / `ort-wasm.wasm` 14,264,838。

⚠ `runtime/ort-wasm.mjs`(上流の物を**そのまま**コピーする)には `import("module")` / `import("worker_threads")` がある。
Emscripten の **Node 専用の枝**(ブラウザでは実行されない)。裸の指定子の検品は、**こちらが束ねた**
`transformers.mjs` にだけ掛ける(上流の物の中身までは直さない)。
