# PKC3 Rust/wasm 化 設計 doc(2026-08)

> 位置づけ: 正本 doc `docs/development/pkc3-major-upgrade-design-2026-07.md` の §5(是正)・§7(依存方針)・§11(段階)への追補。
> **裁定済み(user 2026-08-01「君の推奨が良さそうだ。そのまま進めてください」)** ──
> §12 の推奨がそのまま採用された。R0 / R1 は実施済み、**R2 の本番配線は保留**
> (§10.5 ── 判定の数字が harness 間で再現せず、実ブラウザ計測まで持ち越し)。

---

## 0. user 指示(与件・不可侵)

> 「**可能ならコア機能の類はなるべく Rust で wasm 実装してください**」(user 指示 2026-08-01)

継承する不可侵(正本 doc §0.3):

- 「**ゼロコピー、生成とライフサイクル後の速やかな破棄を徹底してください**」(user 指示 2026-07-27)
- 「**私は依存をなくして欲しいと言っただけで、完全になくせとは言っていない。ビルドが静的であれば何も問題ない**」(user 指示 2026-07-27)
- 「**効果が小さいからやらないではなく、積み上げた先に価値があるなら小さかろうが積んでください**」(user 指示 2026-07-27)
- 「**boot 直後とか測ってない?意味ないからね、ソレ**」(user 指示 2026-07-27)
- **CI を長くしない**。PR gate は速い lane 限定、重い検証は nightly へ(user 指示 2026-07-30)
- **流用 + 総合的見直し、丸写し禁止**(user 指示 2026-07-30)

本 doc はこの 6 つを「Rust/wasm をどう入れるか」の設計制約として直接使う。とくに ③(小さくても積む)と ①(ゼロコピー・即破棄)は、後述の**採否基準そのもの**になっている。

---

## 1. 結論(先に)

1. **Rust/wasm を PKC3 の第一級の実装手段として採用する。** ツールチェーンは実測で軽い(cold build 0.67s / warm 27ms / 成果物 21.7KB / `WebAssembly.Module.imports()` = 0)。CI を長くしない要件と衝突しない。wasm-bindgen は**使わない**(cdylib + `#[no_mangle] extern "C"` + 手動マーシャリング)。
2. **ただし「コアを片端から移す」は実測に反する。** 文字列を受け取って文字列を返す O(N) 関数は、**境界を越えた時点で構造的に負ける**(content-hash は実測で wasm が 1.58〜2.30 倍**遅い**)。移して黒字になるのは「**境界 1 往復あたりの仕事量が大きく、中間生成物を JS 側へ出さない**」形だけ。
3. **最初の payload は「diff/patch を移す」ではなく「revision 復元チェーンを wasm 内で回す」。** 現在 20 段復元は境界を 20 回跨ぎ、全文の JS 文字列を 20 個生成している(実測 32ms / p95 55ms)。これを **1 往復・中間生成物ゼロ**に畳むのは、性能だけでなく **user の「ゼロコピー・即破棄」指示に直接応える**唯一の構造変更である。
4. **その前に、Rust ではない取りこぼしを先に回収する(R0)。** `splitLines` の lookbehind 正規表現が `diffLines` の 88% を占めており、手書きスキャンに替えるだけで出力同一のまま 1.56 倍。**ここを直さずに測った wasm の勝敗は対照群が揃っていない**(§3.4)。
5. **markdown-render は移さない。** golden 25 件の byte 一致契約 + markdown-it 内部 API 16 フック + 出口が `innerHTML`。これは技術的難度ではなく**契約の破棄**であり、user 裁定事項(§5-1)。

---

## 2. 採否の枠組み(この doc の全判断はこの 3 条に従う)

### 2.1 黒字条件(3 つ全部を満たすときだけ移す)

| # | 条件 | 根拠 |
|---|---|---|
| B1 | **境界 1 往復あたりの仕事量が大きい** ── 入力 1 バイトあたり O(1) 回程度の処理は負ける | §3.2 の境界固定費 + §3.3 の content-hash 実測(全サイズで wasm 敗北) |
| B2 | **戻り値が小さい、または bytes のまま次段へ渡せる** ── JS 文字列化しない | apply は同一処理でも JS 文字列で返すと 0.55–0.64x(敗北)、bytes のままなら 1.29–1.56x(勝利) |
| B3 | **状態を持たない**(module を捨てられる) | linear memory は縮まない(§6.4)。捨てられない module は高水位が worker に常駐する |

### 2.2 棄却してよい理由は 3 つだけ(user 指示③ の運用)

「効果が小さいから」は棄却理由にしてはならない。棄却できるのは:

- **① 実測で逆効果**(数字で JS より遅い / メモリが増える)
- **② 処方が誤り**(遅さの原因が言語ではない ── 呼び出し回数・アルゴリズム・DOM)
- **③ 呼ばれていない**(本番の呼び出し元が無い)

§5 の「やらないこと」はすべてこの 3 つのいずれかに紐づけてある。紐づかないものは「小さくても積む」側へ回す。

### 2.3 「ゼロコピー」の解釈(重要 ── 擁護論に使わない)

sqlite-wasm の linear memory と Rust module の linear memory は**別のメモリで、共有できない**。したがって Rust 化は「ゼロコピーに近づく」どころか、素朴にやると**コピーを 2 回増やす**(sqlite→JS string→Uint8Array→Rust の 3 コピー。現状の TS は JS string を直読みで 1 コピー)。

→ user の「ゼロコピー」指示は「**巨大な中間生成物を作るな・持ち続けるな**」と読む。この解釈では ③ の復元チェーン(20 個の全文文字列を 0 個にする)が指示に**正面から応える**一方、「Rust にするとゼロコピーになる」という言い方は**成り立たない**。以後この doc では Rust 化の根拠にゼロコピーを使わない。

---

## 3. 実測(数字と手法。未実測は明記)

### 3.1 手法と限界(先に明示 ── これを読まずに数字を引用しない)

- **すべて Node での計測であり、ブラウザ実測ではない。** 絶対値はブラウザに移らない。信頼するのは**向きと構成比**。「起動が速くなる」「操作が軽くなる」は本 doc の数字では主張できない ── P3/P5 で実ブラウザの計測が別途要る。
- ハーネスは全て scratchpad 内(`/tmp/.../scratchpad/` 配下の `bench/` `rswasm/` `wasm-spike/` `wasm-ci/` `rustwasm/`)。**PKC3 の作業ツリーは無変更**で実施。
- 計測機は 4 vCPU / Xeon 2.80GHz / 15GB(GitHub `ubuntu-latest` と同クラス)。CI の秒数はほぼ転記可能。
- **調査ごとに fixture とハーネスが違う**。§3.4 の合成推定はそれを跨いだ**推定**であり、実測ではない。

### 3.2 境界の固定費と従量費(全判定の基準線)

依存ゼロの Rust cdylib を実際にビルドして計測(raw wasm、wasm-bindgen なし):

| 項目 | 実測 |
|---|---|
| 空 export の呼び出し `pkc_noop` | **3.64 ns/call**(呼び出し自体は無視できる) |
| wasm 呼び出し 1 回(ハーネス床 2ns 差引後) | 7 ns |
| `alloc` + `free` | 16 ns |
| **完全往復の固定費**(`"a\n"` を渡して返す) | **337 ns** |
| 入力 `encodeInto` → wasm memory(1MB) | ascii **100us** / ja **874us** |
| 出力 `TextDecoder.decode`(1MB) | ascii **568us** / ja **4.98ms** ← **支配的** |
| 参考: 200KB の文字列→wasm→文字列 1 往復 | **3.34ms**(`encode`+`set`)→ **0.875ms**(`encodeInto` 直書き) |

**読み方**: 呼び出し回数ではなく**データの marshalling** が効く。とくに**出力の decode が日本語で ASCII の約 10 倍**。これが B2(戻り値を小さく保つ)の実測根拠。

⚠ **手法の訂正(記録)**: 最初の計測で「ja は wasm が 3 倍遅い」と出たが、原因は wasm ではなく JS 側のエンコード戦略(ASCII 楽観パスが日本語で二度打ち、1MB で 9.83ms)だった。修正後 885us。**境界コストを測るつもりでブリッジの下手さを測っていた。**

### 3.3 候補別の実測(PKC3 現行コードに対して)

| 対象 | 呼び出し粒度(file:line) | 実測(JS) | wasm | 判定 |
|---|---|---|---|---|
| `content-hash.ts:8` | 保存ごと + 復元検証。`storage-worker.ts:251 / :400 / :497 / :636`(**worker 内**) | 200KB **0.796ms** | **1.311ms**(encode+set)/ 0.875ms(encodeInto) | **①実測で逆効果** |
| 同(別ハーネス、同一 FNV-1a) | ── | 100 chars 0.920us / 10k 31.3us / 500k 1620us | 2.117us / 54.3us / 2728us | **全サイズで敗北(1.58〜2.30x 遅い)** |
| `diffLines`(`line-patch.ts:139`) | 保存ごと 1 回(`storage-worker.ts:229`) | 200KB 1 行編集 **5.96ms** | ascii 1.79–2.11x 勝 / ja 1.10–1.19x 勝 | **要再測**(§3.4) |
| `applyLinePatch`(`:171`) | 復元 1 段ごと(`storage-worker.ts:221`) | 200KB **2.09ms** | ja: JS 文字列返し **0.55–0.64x 敗** / bytes 返し **1.29–1.56x 勝** | **B2 が分水嶺** |
| **20 段復元**(`storage-worker.ts:611-637` の鎖ループ) | 履歴復元 1 回 | **32ms**(p95 55ms) | 未実測 | **最有力**(§4.2) |
| `renderMarkdown`(`markdown-render.ts`) | 表示のたび(`detail.ts:171` / `:257`)**メインスレッド** | 58KB **19.9ms**(p95 34.9)/ 200KB **76.7ms** / 460KB 173.6ms | ── | **移さない**(§5-1) |
| `relation/tree.ts:31` | filer 1 描画で **2〜3 回**(`filer.ts:59, 81/82, 97`) | 15k entry で 1 描画 **6〜9ms** | ── | **②処方が誤り**(memo 化) |
| `frontmatter.ts` | 1 表示で複数回 | 70KB parse 0.233ms | ── | **粒度が誤り**(B1 不成立) |
| `pkc2-convert.ts:81` | **src に呼び出し元 0**(test のみ) | 未計測 | ── | **③呼ばれていない** |

`renderMarkdown` 21.8ms/render(58KB)の内訳(CPU profile、300 render サンプリング):**PKC 自前コード 44.7% / markdown-it + deps 25.5% / GC 9.3% + RegExp 19.7%(帰属分離できず)**。方言の有無でコストがほぼ変わらない(0.339 vs 0.352 ms/KB。※対照群の「plain CommonMark」は方言を完全には落とせていない)── **支配項は走査そのもの**で、前処理 22 段 + 後処理 12 段 + fence 走査ループ 19 本が独立に全文を走る構造が原因。

### 3.4 ⚠ 対照群が揃っていない(この doc で最も重要な訂正)

`diffLines` を 20,000 行 fixture で分解計測すると:

```
diffLines 全体(現行 = 正規表現 split)   8,405 us
  うち splitLines ×2                      7,424 us  (88%)   ← line-patch.ts:27 の /(?<=\n)/
  Myers + 前後トリム                        982 us  (12%)
手書き charCodeAt スキャンに置換(出力同一を確認)
diffLines 全体                            5,377 us  (1.56x 改善)
```

**§3.3 の「wasm が diff で 1.79–2.11x 勝つ」は、この正規表現を含んだ TS を対照群にした数字である。** Rust 側は当然バイトスキャンで行分割しているので、勝ちの相当部分が「JS の取りこぼし」由来。

**合成推定(⚠ 未実測。fixture もハーネスも異なる 2 つの計測を割ったもの)**: R0 後の TS を対照群にすると ascii は **1.15–1.35x 程度**、ja は **1.0 を割る可能性が高い**。→ **R0 を先に済ませ、同一ハーネスで再測するまで diff 単体の Rust 化は決めない**(§10 R2 のゲート)。

### 3.5 ビルドと成果物(CI 判断の根拠)

| 項目 | 実測 |
|---|---|
| cold build(`rm -rf target`、依存なし)×3 | **0.67 / 0.69 / 0.71s**(別測: 0.415 / 0.406 / 0.387s) |
| warm no-op ×5 | **27ms**(26.7–28.6) |
| incremental(`touch lib.rs`)×3 | 0.64 / 0.64 / 0.70s |
| `.wasm` サイズ opt-level=3 → **z** | 26,881 B → **21,732 B**(gzip 9,562 / base64 28,976) |
| 同、no_std・依存なし 279 行 | **5,405 B**(gzip 2,599) |
| 同、std 版 | 16,665 B |
| trivial crate(FNV 1 個)の std 下限 | **12,290 B** ← 「1 関数だけ Rust」の固定費 |
| **pulldown-cmark 0.12 入り**(lto=fat, opt-z) | **3.87–4.25s** / **202,565 B** |
| `rustup target add wasm32`(cold / 導入済み) | 3.43s / 0.06s |
| `rustup toolchain install <pin>`(cold) | **15.61s** / 661MB |
| `cargo test`(**host** target)cold / warm | 0.37–0.41s / **0.055s** |
| `WebAssembly.Module.imports()` | **0 件**(glue も WASI shim も不要) |
| cold compile + instantiate | 0.44ms + 0.11ms |

**`opt-level = "z"` はサイズも速度も勝った**(21.7KB かつ 6 ケース全部で opt3 比 x0.89–0.96。i-cache 効果と**推測**)。

**再現性(committed artifact 方式を成立させる load-bearing な実測)**:`strip = true` / incremental 無効 / release で、target 全消し × 5 回すべて同一ハッシュ。**別の絶対パスでも同一**。⚠ ただし **rustc のバージョンが違うとバイトが変わる**(`1.93.0` = 5,585 B / `1.94.1` = 5,405 B)。runner イメージ既定は **Rust 1.97.1、wasm ターゲット未導入** ── **`rust-toolchain.toml` の pin は必須**。

### 3.6 未実測(明記)

- **ブラウザでの実測全般**(boot・定常・long task)。§3 は全て Node。
- **20 段復元の wasm 版**(§4.2 の本命)── 実装していないので数字は無い。
- R0 後の TS を対照群にした diff の再測(§3.4 は推定)。
- **zstd を Rust で `wasm32-unknown-unknown` へビルドできるか**(P5、§10 R3)── crate 選定も含め未検証。
- serde / serde_json を入れた場合のビルド時間・サイズ(桁が変わる想定、未実測)。
- GitHub Actions の artifact 転送時間(この環境では測れない)。
- pulldown-cmark 版の**実行時挙動**(サイズとビルド時間のみ実測)。

---

## 4. やること

### 4.1 R0(前提工事。Rust ではない ── 先にやる)

Rust の勝敗を測る前に、対照群を正しくする。**いずれも出力 byte 一致を維持する内部変更**:

1. **`splitLines` の脱正規表現**(`line-patch.ts:27`)── `charCodeAt` スキャンへ。実測 1.56x、出力同一を確認済み。
2. **markdown パイプラインのパス統合** ── 19 本の独立 fence 走査を 1 回の lex に畳み、sentinel 後処理 12 段を 1 パスへ。**golden 25 件の byte 一致が安全網として働く、唯一「安全に実行できる」最適化**。200KB 76.7ms のメインスレッド占有はここが実害。
3. **`relation/tree` の memo 化** ── filer 1 描画で 2〜3 回走っている再計算を 1 回に(`filer.ts:59, 81/82, 97`)。

**完了条件**: 各項目で「現行 / 変更後」を同一ハーネス・同一 fixture で測り、向きと百分率(分母を明記)を報告。golden / line-patch test が byte 一致で green。

### 4.2 R1–R2(Rust/wasm の本体)

**R1: 境界基盤 + 最小 payload。** §6 の契約、§7 のパリティ機構、§8 の CI を、最小の 1 関数と一緒に着地させる。基盤は R2 以降・P5・P7 の積み上げ先があるので、**payload が小さくても積む**(user 指示③)。

**R2: revision 復元チェーンを wasm 内で回す(本命)。**

現状(`storage-worker.ts:611-637`):

```
for (i = tip → target)  state = materialize(rows[i], state)   // 20 回
  → 境界跨ぎ 20 回 / 全文の JS 文字列を 20 個生成(GC 任せ)/ 実測 32ms(p95 55ms)
```

提案:

```
patches[] (小さい・JSON) + tip body (大きい) を 1 回だけ wasm へ渡す
  → wasm 内で bytes のまま 20 段適用(中間生成物は linear memory 内で即上書き・即 free)
  → 最終 body だけ 1 回 JS 文字列化
  → contentHash64Hex(state) は従来どおり JS 側・UTF-16 のまま(§5-2 の永続契約に触らない)
```

- **B1 成立**: 境界 1 往復に対し仕事は 20 パス。「入力 1 バイトあたり O(1)」の棄却基準を構造的に外れる。
- **B2 成立**: 出力は最終 body 1 本のみ(decode コストを 20 分の 1 に)。
- **B3 成立**: 状態を持たない(呼び出し内で完結)。
- **user の「即破棄」指示に直接応える**: 今日は全文文字列 20 個を GC 任せで撒いている。

**事前登録する成功条件(測る前に固定する)**:

| 指標 | 判定 |
|---|---|
| 20 段復元の所要(ja / ascii 両方、同一 fixture、R0 後の TS が対照群) | **向き**を報告。TS を下回ったら **①実測で逆効果**として棄却 |
| worker の RSS 高水位(復元前 / 復元中 / 復元後 60s) | 復元後に戻ること。戻らなければ §6.4 の instance 破棄を必須化 |
| 出力 byte 一致 | 22+ ケース + 乱択 fuzz で TS と完全一致(非 ASCII / CRLF / 末尾改行なしを必須次元に含める) |
| PR gate 増分 | ≤ 0.1s(実測 0.055–0.077s の見込み) |

**diff 単体(`diffLines`)は R2 のスコープに入れない。** §3.4 の再測で勝ちが確認できたら R2 の crate に**追加**する(同一 crate なので固定費 12–22KB は償却済み)。負けたら載せない ── 棄却理由は「①実測で逆効果」。

### 4.3 R3 以降(将来の黒字候補。着手は user の明示 go)

| 候補 | なぜ黒字条件を満たすか | 段階 |
|---|---|---|
| **圧縮(zstd)** | 探索を伴い入力 1 バイトあたり O(1) を超える。出力は小さい(B2)。正本 doc §11 P5 は現在「zstd-wasm 系」の**外部依存**を前提にしており、Rust で持てば依存を増やさずに済む(user 指示「なるべく Rust」に最も素直に合致) | P5 |
| **全文検索インデックス構築** | 小さい入力から長く回る。マージは境界を跨がない | P7 |
| **画像・添付の変換** | 同上。バイト入出力で文字列を跨がない | P7 以降 |

いずれも**現時点で未実測**。P5/P6 で「速い、安い、必要十分」の判断に入る時点で §2.1 の 3 条に当ててから決める。

---

## 5. やらないこと(理由 + 将来やる場合の条件)

| # | 対象 | 棄却理由(§2.2 の分類) | 将来やる条件 |
|---|---|---|---|
| 1 | **`markdown-render.ts` の Rust 化**(4,214 行) | **②処方が誤り + 契約の破棄**。(a) golden 25 件が **byte 一致**を要求(`markdown-golden.test.ts`。markdown-it は 14.3.0 に pin)── pulldown-cmark / comrak は escape・typographer・linkify・属性順すべて別で byte 一致しない (b) markdown-it 内部 API に **16 箇所フック**(inline rule 7 / core rule 2 / renderer override 6 / plugin 1。`markdown-render.ts:76, 262, 296, 308, 408, 561, 628, 679, 705, 762, 920, 1111, 1162, 1256, 1302, 1383`) (c) 出口が `detail.ts:171` の `innerHTML =` ── wasm で HTML 文字列を速く組んでも、直後に「linear memory → JS string → ブラウザの HTML パーサ再パース」が必ず入り、**最も重い DOM 構築は 1ms も減らない** | **R0-2(パス統合)を終えてなお 200KB で 30ms 超のメインスレッド占有が残り**、かつ **golden byte 一致契約の破棄を user が明示裁定した**とき。そのときも「移植」ではなく「**PKC-Markdown 前処理を単一 lexer として書き直す**」として別 doc で裁定を仰ぐ |
| 2 | **`content-hash.ts`** | **①実測で逆効果**(全サイズで 1.58–2.30x 遅い、§3.3)**+ 永続契約**。`content-hash.ts:12` は `charCodeAt` = **UTF-16 コードユニット**を回しており、Rust の UTF-8 バイトとは日本語で必ず値が違う(実測: `'日本語'` → JS `5406374eb7fb3549` / wasm `805f5ce7ad9992bc`)。この値は **DB の `content_hash` 列に永続化済み**(`storage-worker.ts:251 / :400 / :497` で書き `:636` で読む)── 移した瞬間、既存 DB 全行が「知らない hash」になり、`:636` の整合性検証が全 entry で不一致 → 履歴復元が全滅、`maintainChain` の skip も全外れ | **なし(現状維持が最適)**。ただし**恒久ルール**を設ける ── 「**UTF-16 依存の値が永続化されている関数は言語を替えない。替えるなら schema migration + `user_version` bump が前提**」。R0 の一環で `content-hash.ts` の docblock にこの制約を 1 行明記する(実装を替える人が最初に読む場所に置く) |
| 3 | `app-state.ts` / `dispatcher.ts` | **②処方が誤り**。dispatch ごとに境界を越える。状態は JS 側にしか置けない | なし(構造的) |
| 4 | `adapter/ui/render/*` | **②処方が誤り**。wasm から DOM を触れない。結局 JS に戻るだけ | なし(構造的) |
| 5 | `features/import/pkc2-convert.ts` | **③呼ばれていない**(src に呼び出し元 0、test のみ)+ **F4 の高水位を作る当人**(container 丸ごとの一発 alloc は linear memory の高水位を押し上げ、以後 worker に常駐する) | なし。P6 で本番導線が付いても、**一度きりの処理に常駐メモリを払う理由がない** |
| 6 | `frontmatter.ts` / `csv-table.ts` / `code-highlight.ts` | **②処方が誤り(粒度)**。1 表示で複数回・fence 単位。往復固定費 337ns〜(200KB read-only で 0.875ms)に対し仕事が小さすぎ B1 不成立 | **R0-2 で単一 lexer に畳まれ、1 表示 1 往復になったとき**、その lexer 全体として §2.1 に当て直す |
| 7 | `relation/tree.ts` | **②処方が誤り**。2.07ms は言語のせいではなく**同一計算を 1 描画で 2〜3 回している**せい | memo 化後に 15k 規模で再測し、なお描画のボトルネックなら再評価 |
| 8 | `protocol.ts` / `store-client.ts` | **②処方が誤り**。postMessage 境界そのもの。境界に境界を足す | なし(構造的) |
| 9 | **sqlite 自体の Rust 化**(rusqlite / libsqlite3-sys) | **②処方が誤り**。`@sqlite.org/sqlite-wasm` と **OPFS SAHPool VFS を捨てる**話になり、P2 の成果(非 Atomics SAHPool 実機確認・journal 実測選定・SAH リース)を丸ごと作り直す。しかも §2.3 のとおり「1 メモリ化」は**別 module を捨てられなくする**(B3 と両立しない) | なし(P2 裁定済み) |
| 10 | **wasm-bindgen / serde / 外部 crate** | **②処方が誤り**。生 wasm で imports 0 / build 0.67s / 21.7KB が成立している。crate を入れると供給網が二重化し(dependabot cargo + `cargo audit`)、CI を長くしない要件と衝突する | **「なぜ自前で書けないか」を doc に書いて user 裁定**を得たときのみ。pulldown-cmark 級(202KB、build 3.9–4.2s)は可搬 HTML の base64 を **+23%** 押し上げるので特に慎重に |
| 11 | **1 関数だけのための crate 追加** | **①実測で逆効果**。std 版の固定費が **12,290 B**(FNV 1 個の trivial crate) | なし。**crate は 1 つに集約**する(§6.1) |

---

## 6. 境界の契約(実装前に固定する)

### 6.1 crate 構成と ABI

```
rust/
  rust-toolchain.toml   # channel = "1.94.1"(完全固定) + targets = ["wasm32-unknown-unknown"]
  Cargo.toml            # workspace。外部依存 0 を既定とする
  Cargo.lock            # commit(--locked で使う)
  core/                 # 純ロジック。host で cargo test できる(cold 0.37s / warm 0.055s)
  wasm/                 # cdylib。#[no_mangle] extern "C" と手動マーシャリングだけ
```

- **crate は 1 つに集約**(固定費 5.4–22KB を償却)。core / wasm を分ける理由は実測 ── `cargo test` は **host target** で走るので `rustup target add` も pin も不要になり、nightly の検証が安く済む。
- `[profile.release]`: `opt-level = "z"` / `lto = true` / `codegen-units = 1` / `panic = "abort"`(→ §6.5 で条件付き変更)/ **`strip = true`**(再現ビルドの必須条件)。
- **`#![no_std]` を既定**とする(5,405 B vs std 16,665 B の実測差)。⚠ ただし allocator は自前になる ── **bump allocator で free しない設計は §6.4 を悪化させるので禁止**。推奨は「**呼び出しごとに arena をリセットする**」形(呼び出し終端で確実に全解放 = user の「即破棄」指示を allocator レベルで満たす)。**未実測** ── R1 で高水位を probe して確かめる。

**ABI**(調査で実装・検証済みの形):

```
pkc_alloc(len: u32) -> ptr        # 入力バッファ確保
pkc_free(ptr: u32, cap: u32)      # 明示解放
pkc_<op>(...) -> ptr              # 結果は ptr 先頭 8 byte のヘッダ [len:u32][cap:u32] + 本体
```

JS 側は `DataView` でヘッダを読む(**alignment 制約なし**)。glue コードは 1 ファイル(`bridge.ts`)に閉じ、それ以外に生成コードを持たない。

### 6.2 入力(ゼロコピー規律)

- **必ず `TextEncoder.encodeInto` で wasm memory へ直書き**。中間 `Uint8Array` を作らない(200KB 往復 3.34ms → 0.875ms、中間コピー 1 本削減で約半減)。
- **確保戦略はトレードオフが実在する**(1MB × 200 回の実測):

| 戦略 | ascii 速度 / 高水位 | ja 速度 / 高水位 |
|---|---|---|
| 3x 先確保(1 encode) | 94.5us / **7.7MB** | **872us** / 4.8MB |
| **適応**(1x → 比率再見積) | **76.3us** / **3.7MB** | 1.39ms / 3.8MB |
| encode+set(2 copy) | 440us / 3.7MB | 1.98ms / 3.6MB |

→ **既定は適応版**(メモリ安全性の指示を優先)。ja の diff 全体が 6.95ms → 8.02ms(R0 前の TS 8.25ms とほぼ並ぶ)まで劣化するので、**ここは §12 の裁定事項**。

- `memory.buffer` は grow で detach するので、**JS 側で `Uint8Array` view を跨いで保持しない**(毎回 `new Uint8Array(memory.buffer)` を取り直す)。

### 6.3 出力(B2 の実装形)

- **戻り値を JS 文字列にしてよいのは「小さい出力」だけ**(パッチ・ハッシュ・件数)。
- **大きい出力は bytes のまま次段へ渡す**か、**wasm 内に留めて最後に 1 回だけ文字列化**する。日本語 decode は 4.98ms/MB。
- 結果バッファは **JS 側の `finally` で必ず `pkc_free`**。ptr を呼び出しの外へ持ち出さない(持ち出したら所有権の追跡が始まり、即破棄が守れなくなる)。

### 6.4 メモリのライフサイクル(user 不可侵指示の実装点)

**wasm linear memory は縮まない**(実測: `WebAssembly.Memory.prototype.shrink` は**仕様に存在しない**)。

```
instantiate 直後                  1.06 MB
1MB alloc + free 後               2.13 MB
64MB を 1 回 alloc + free 後     66.19 MB
その後 1MB の小さい仕事に戻る    66.19 MB   ← 戻らない
小さい alloc を 50 回            66.19 MB   ← 戻らない
```

**Rust の `drop` は走り、free もされている。それでも host には返らない。** これは「Rust レベルでは即破棄を満たしつつブラウザレベルで破る」最悪の形であり、PKC2 の +293MB 常駐と**同型の穴**。

**規律(3 段)**:

1. **高水位を作る仕事を wasm に載せない**(§5-5 の pkc2-convert が該当)。
2. **module は状態を持たない**(B3)。sqlite worker とは**別 module**にする ── sqlite は DB 接続を持つので捨てられない。
3. **高水位が閾値を超えたら instance ごと捨てて作り直す**。実測で有効:

```
128MB spike(instance 生存中)   rss 175.4 MB
instance を捨てて gc              rss  47.5 MB   ← 返る
新しい instance                   linear memory 1.06 MB   ← 初期値
```

  compile 済み `WebAssembly.Module` は使い回せる(instantiate は 0.11ms)。**閾値と再生成は実装 + test で pin する**(R1 の完了条件)。

⚠ **受容する代償**: 2 と 3 を採ると §2.3 の 3 コピーが確定する。**この 2 つは同時には解けない** ── メモリ安全性(user 不可侵)を優先し、コピー数は受容する。

### 6.5 エラーと panic(「無言で壊れない」規律の維持)

現状の TS はここが強い ── `line-patch.ts:179/183/189` は `patch: copy overruns source` / `patch: source not fully consumed` と**読める message** で throw し、`storage-worker.ts:631` は `revision restore failed (chain broken)`、`:637` は `revision restore failed (integrity check): ${req.id}` と**文脈 id 付き**で throw する。docblock にも「壊れたパッチから『それらしい本文』を作らない」と明記されている。

wasm の素の挙動はこれに真っ向から反する(実測):

```
caught : RuntimeError / message: "unreachable"
stack  : at pkcwasm.wasm._RNvCs...rust_panic (wasm://wasm/...:wasm-function[17]:0x207a)
```

**panic message(`index out of bounds: ...`)はどこにも出ない。** 行番号なし、source map なし。さらに危険なことに、

```
noop after panic  -> 7          ← 成功して返る
alloc after panic -> 1114120    ← ポインタが返る
```

**`panic = "abort"` は wasm では instance を毒さない。**途中まで変異した状態のまま続行しうる。

**契約(R1 の必須要件。これが無いなら着地させない)**:

1. **予期される失敗は panic にしない。** 全 export は `status: i32`(0 = ok)を返し、message は結果バッファに載せる。TS 側は同じ文言で `Error` を投げ直す ── **既存の message 文字列と文脈 id を維持**する(test で pin)。
2. **panic はバグとしてのみ扱う。** panic hook を JS import(`pkc_panic(ptr, len)`)へ配線し、message + 文脈 id を必ず出す。⚠ これで `imports()` が 0 → 1 になる。**意図的な取引**として記録する(glue は依然として不要)。
3. **panic 後の instance は毒された扱いにする** ── JS 側でフラグを立て、以後の呼び出しを拒否して instance を捨て、**その復元/保存はセッション中 TS 実装へフォールバック**する。可視エラーは維持する(黙って結果を返さない)。
4. `panic = "abort"` を維持するか `unwind` + hook にするかは実装時に決める。**hook 側で message を出せることを test で pin できれば abort でよい**(未実測)。

### 6.6 flag 予算(15 個)を消費しない

wasm / TS の切替は **flag にしない**。理由 ──

- PKC3 は sqlite で既に wasm に**ハード依存**しているので、「wasm が使えない環境」への capability fallback は存在しない。TS 実装は **oracle**(§7)であって capability fallback ではない。
- 実行時のフォールバックは §6.5-3 の**毒フラグ(実行時の障害検出)**で足り、これは設定でも flag でもない。

→ **flags 上限 15 の予算を 1 個も使わない**(user 指示 2026-07-30 の遵守)。

---

## 7. パリティ検証(TS を oracle にして恒久的に守る)

### 7.1 構造的ジレンマを先に認める

**TS 実装を消すと比較対象が消える。**差分テストを回し続けるには TS を残すしかなく、それは**保守が 2 倍**になる。これは回避できない ── **受容する**。ただしコストを最小化する規律を置く:

- **TS が正、wasm が従。** 挙動を変えるときは **TS を先に直し、golden を更新し、その後 wasm を合わせる**。逆順を禁止する(wasm 側だけ直すと oracle が oracle でなくなる)。
- TS 実装は §6.5-3 の**毒後フォールバック先**でもあるので、死んだコードではない。

### 7.2 4 層

| 層 | 内容 | 走る場所 | 実測コスト |
|---|---|---|---|
| **L1 contract test** | **出荷する `.wasm` そのもの**を読み、export 名一覧(ABI)と基本挙動を pin。別 crate の成果物を取り違えて置いたら export 不一致で即落ちる | `npm test` に相乗り(**新規 step 0**) | 4 test / **9ms**(compile+instantiate 0.50–0.67ms) |
| **L2 golden vector** | TS で生成した入出力ペアを fixture として commit。TS と wasm の**両方**が通す。**非 ASCII / CRLF / 末尾改行なし / 空文字列 / 巨大行 を必須次元**にする(「fixture のゼロ件次元は測っていない次元」) | `npm test` | 既存 `tests/features/line-patch.test.ts` に相乗り |
| **L3 differential fuzz** | 乱択 property test。TS と wasm の出力が **byte 一致**すること。seed を固定して失敗を再現可能に。既存の `tests/adapter/storage-worker.test.ts` の fuzz(checkpoint/amend をランダムに交ぜて全世代 byte 一致)と同じ型 | **nightly** | 未実測 |
| **L4 byte parity** | pin した toolchain で `rust/` から再ビルドし、committed `.wasm` と **sha256 一致** | **nightly**(`heavy` と並列 = wall-clock 増ゼロ) | build 0.4–0.7s + toolchain 15.6s |

L1–L2 が PR 粒度で「取り違え・入れ忘れ」を止め、L3–L4 が 24h 以内に「別物」「退行」を暴く。

### 7.3 移植で発見済みの TS 側の潜在バグ(R0 で直す)

`line-patch.ts:46-47` ── 両方空のとき `maxD = 0` → `size = 1` の `Int32Array` に対し `v[offset + k + 1]` = `v[1]` を読み `undefined` になる。`undefined >= 0` が false になるので**偶然**置換フォールバックへ落ちて正解が出ている。Rust は境界検査で panic するため移植時に明示的に畳んだ。**動いてはいるが意図した動作ではない** ── R0 で TS 側も明示的に畳む(oracle が偶然に依存していてはならない)。

---

## 8. CI 戦略(PR gate を遅くしない)

### 8.1 方式: ビルド済み `.wasm` を commit + 3 層検証

**PR gate に Rust を入れない。** 現状の gate は 52 秒(run `30687464154` の step 実測。最大は `playwright install chromium` の 27s)、予算は目標 300s / timeout 600s(`ci.yml:12`)で残量は約 240 秒 ── **間に合わないのではなく、足す理由が無い**。

**cargo を gate に入れない理由(実測 2 点)**:

1. **pin しないと検証の意味がない。** 手元 1.94.1 と runner 既定 1.97.1 で**バイトが違う**(1.93.0 = 5,585 B / 1.94.1 = 5,405 B)。pin なしの再ビルドが検証しているのは「出荷物」ではなく「その日の runner での再ビルド」。pin すると **+15.6s**。
2. **critical path にネットワークが 2 本増える**(`rustup target add` / `cargo fetch`)。5.4KB の成果物のために flake 源を倍にするのは割に合わない。⚠ `Swatinem/rust-cache` を使っても **661MB の toolchain 本体はキャッシュされない**。

**別 job 分離(rust job → artifact → verify)も却下**: `npm run build` が `.wasm` を必要とするので直列化し、checkout / setup を二重払いする(+30〜45s、**見積もり**)。これは `ci.yml:24-26` が playwright について既に明文で却下した「PKC2 のセットアップ税」と同型。

### 8.2 差分案(実ファイルに対して)

**`.github/workflows/ci.yml`** ── 追加 1 step、**実測 +0.06s**:

```diff
       - run: npm ci
+      # Rust/wasm は committed artifact(rust/ で作り src/wasm/ に置く)。
+      # PR gate に Rust は入れない ── ソース ↔ .wasm の対応だけを Node で照合する。
+      #   実測: 0.055–0.077s(cargo を入れると pin なしで +3.6〜7.1s、pin ありで +19〜23s)
+      #   ⚠ runner 既定の rustc は 1.97.1 で、pin しない再ビルドは手元とバイトが違う
+      #     (実測: 1.93.0 → 5,585B / 1.94.1 → 5,405B)。gate 側の再ビルドは
+      #     「出荷するバイト」の検証にならない。
+      # 出荷バイトの挙動 pin は tests/wasm/*.test.ts が npm test に相乗り(+9ms)、
+      # ソースからのバイト等価性は nightly.yml の wasm-parity job が担保する。
+      - name: wasm lock (rust ソース ↔ committed .wasm)
+        run: node scripts/wasm-lock.mjs check
       - name: Audit (prod deps, high+, blocking)
         run: npm audit --audit-level=high --omit=dev
```

**`.github/workflows/nightly.yml`** ── `heavy` と**並列**の job を追加(wall-clock 増ゼロ):

```diff
+  wasm-parity:
+    runs-on: ubuntu-latest
+    timeout-minutes: 15
+    steps:
+      - uses: actions/checkout@v7
+      - name: Rust toolchain (rust-toolchain.toml の pin を導入)
+        working-directory: rust
+        run: rustup show
+      - uses: Swatinem/rust-cache@v2
+        with: { workspaces: rust }
+      - name: Rebuild from source
+        working-directory: rust
+        run: cargo build --release --locked --target wasm32-unknown-unknown -p pkc3-core-wasm
+      - name: Byte parity (committed == rebuilt)
+        run: |
+          a=$(sha256sum src/wasm/pkc3_core.wasm | cut -d' ' -f1)
+          b=$(sha256sum rust/target/wasm32-unknown-unknown/release/pkc3_core_wasm.wasm | cut -d' ' -f1)
+          [ "$a" = "$b" ] || { echo "::error::committed .wasm が rust/ のソースと一致しない ── scripts/build-wasm.sh を回して commit し直すこと"; exit 1; }
+      - name: Rust unit tests (host target ── wasm target 不要)
+        working-directory: rust
+        run: cargo test --locked -p pkc3-core
+      - name: Clippy
+        working-directory: rust
+        run: cargo clippy --locked --all-targets -- -D warnings
+      - name: Differential fuzz (TS oracle vs wasm)
+        run: npx vitest run tests/wasm/differential.nightly.test.ts
```

**`vite.config.ts`** ── 1 行追加(⚠ **実測で踏んだ罠**):

```diff
   build: {
     target: 'es2022',
     sourcemap: true,
+    // .wasm は絶対に base64 インライン化しない。既定 4096B を跨ぐと dist の形が
+    // 変わり(実測: 3,000B の wasm は dist から消えて data URI になった)、
+    // base64 文字列 + デコード後バッファの二重保持でゼロコピー方針にも反する
+    assetsInlineLimit: (filePath) => (filePath.endsWith('.wasm') ? false : undefined),
   },
```

`pages.yml` / `release.yml` / `dependabot.yml` は**無改変**(外部 crate 0 を保つ限り cargo ecosystem も `cargo audit` も不要 ── §5-10)。

### 8.3 「生成物の取り違え」を止める仕組み(size budget = tripwire 思想の継承)

```
src/wasm/pkc3_core.wasm        # commit する成果物
src/wasm/pkc3_core.lock.json   # { source, wasm, toolchain, size, builtAt }
scripts/build-wasm.sh          # cargo build → src/wasm/ へ copy → lock 更新
scripts/wasm-lock.mjs          # check | write(Node のみ)
```

- lock は**人間可読**。レビューアは binary を読めないが、**ハッシュとサイズの変化は読める**。
- 負例(Rust ソースだけ編集して再ビルドし忘れ)で確実に exit 1 することを実測確認済み:
  `wasm-lock FAIL: rust source changed but .wasm was not rebuilt  lock=3c2bc4ad… / now=d327bf03…`
- **git の膨らみは非問題(実測)**: 198KB の `.wasm` を 10 世代改版して `.git` は 648KB(単純合計 1,978KB)。5.4KB を 100 世代で 400KB。

### 8.4 Vite 統合(実測で確認済み)

- worker 内 `import wasmUrl from './wasm/pkc3_core.wasm?url'` → `dist/assets/pkc3_core-<hash>.wasm` として emit、worker chunk は `new URL('pkc3_core-<hash>.wasm', self.location.href)` で解決。
- これは PKC3 の実物 `dist/assets/storage-worker-D8n74yNt.js` 内の `new URL('sqlite3-BVKGSWc-.wasm', self.location.href)` と**完全に同じ形**。`base: './'` と整合し、Pages の `/` と `/dev/` 両方で動く ── **sqlite と同じ流儀に乗れる**。
- dev server も `Content-Type: application/wasm` を返す(実測)ので `compileStreaming(fetch(url))` が dev / prod 両方で通る。
- ⚠ **罠(実測)**: vitest の happy-dom 環境では `import.meta.url` が `http://` になり、`fileURLToPath(new URL('../src/wasm/x.wasm', import.meta.url))` が `TypeError: The URL must be of scheme file` で落ちる。→ **`readFileSync(resolve(process.cwd(), 'src/wasm/pkc3_core.wasm'))` を使う**(置換で 4 test 全 pass を確認)。

### 8.5 P7(可搬 HTML)への影響

単一 HTML では **base64 焼き込み + `WebAssembly.compile(bytes)`**(streaming は使えない)。既に sqlite が base64 で 1,153,004 B を強制している前提で、追加分:

| 追加する core | base64 追加 | sqlite base64 比 |
|---|---|---|
| no_std 最小(5.4KB) | +7,208 B | **+0.6%** |
| std 版(16.7KB) | +22,220 B | +1.9% |
| pulldown-cmark 込み(202KB) | +270,088 B | **+23%** |

Node での参考値(decode / compile): no_std 0.01ms / 0.4ms、pulldown 0.17ms / 1.7ms、sqlite 0.53ms / **7.5ms**。

⚠ **限界の明記**: これは Node の decode + compile 単体であって、**ブラウザの boot 実測でも定常の体感でもない**。ここで言えるのは「**桁として sqlite に埋もれる**」だけ。「起動が速い/遅い」を主張するなら P7 で実ブラウザの計測が要る。

---

## 9. 未解決の運用課題

- **`rust-toolchain.toml` の pin 更新**: pin を上げると `.wasm` のバイトが必ず変わる(lock 更新 + 再 commit が要る)。dependabot は cargo crate を見るが **rustc の pin は見ない**。→ プロセス指示「常時監視・儀式的な定期実行はしない」に従い、**既定は「上げる必要が出たときに上げる」**。定期タスクは作らない。
- **host `cargo test` を PR gate に入れるか**: 入れるなら target 追加も pin も不要で **+0.4〜1s**(実測 cold 0.37–0.41s)。本 doc は「L1 contract test が出荷バイトを直接叩き、wasm-lock が再ビルド漏れを塞ぐので PR では不要」と判断して nightly に置いた。1 秒なら払う、という判断もありうる(§12)。

---

## 10. 段階と完了条件

| 段階 | 内容 | 完了条件(DoD) | 正本 doc の段階 |
|---|---|---|---|
| **R0** | **Rust ではない前提工事**: ① `splitLines` 脱正規表現 ② markdown パス統合 ③ `relation/tree` memo 化 ④ `line-patch.ts:46-47` の暗黙フォールバックを明示化 ⑤ `content-hash.ts` に UTF-16 制約を docblock 明記 | 各項目で同一ハーネス・同一 fixture の「現行 / 変更後」を提示(向き + 百分率、分母明記)。golden 25 件と line-patch test が **byte 一致で green**。②は 200KB のメインスレッド占有を再測 | P3 |
| **R1** | **境界基盤 + 最小 payload**: `rust/` workspace / `scripts/build-wasm.sh` / `wasm-lock.mjs` / L1 contract test / nightly `wasm-parity` / vite 設定 / `bridge.ts`(§6.1–6.3)/ panic hook(§6.5)/ instance 破棄機構(§6.4) | PR gate 増分 **≤ 0.1s(実測値で報告)**。nightly でバイト一致。**panic が message + 文脈 id を出すことを test で pin**。**高水位超過で instance を捨て RSS が戻ることを probe で pin**。`imports()` が panic hook の 1 件だけであることを test で pin。**flags を 1 個も増やしていないこと** | P3〜P5 の間 |
| **R2** | **revision 復元チェーンを wasm 内で回す**(§4.2)。`diffLines` 単体は §3.4 の再測結果次第で追加 | §4.2 の事前登録した 4 指標をすべて報告。**ja / ascii 両方**。TS を下回ったら棄却(基盤 R1 は残す)。L2 golden + L3 nightly fuzz が green(非 ASCII / CRLF / 末尾改行なしを含む) | P5 |
| **R3** | **圧縮(zstd)を Rust で持つか外部 wasm を使うか**の実測選定 | ビルド可否(**未検証**)/ 圧縮率 / 速度 / サイズを対照群付きで提示。外部依存を増やす場合は §5-10 の裁定を経る | P5 |
| **R4** | 全文検索インデックス構築 / 添付変換 | 着手は user の明示 go。§2.1 の 3 条に当ててから | P7 以降 |

**「効果が小さい」は棄却理由にしない**(user 指示③)。R1 の基盤は payload が小さくても積む ── 積み上げ先が R2/R3/R4 として本 doc に書かれているため。

---

## 10.5 R1/R2 の実施結果(2026-08-01。**事前登録した指標で判定**)

### R1: 基盤 ── ✅ 着地

| 項目 | 実測 |
|---|---|
| crate(`rust/pkc-core`、外部依存 0) | ✅ |
| `.wasm` サイズ | **14,610 B** |
| ビルド | **0.40s**(warm 0.00s)。`scripts/build-wasm.sh` で `src/adapter/platform/wasm/` へ出す |
| 再現性 | **同一バイト**(target 全消し → 2 回ビルドで同一 sha256)。rustc は `rust-toolchain.toml` で 1.94.1 に pin |
| `WebAssembly.Module.imports()` | **0 件**(glue も WASI shim も無し ── test で pin) |
| PR gate 増分 | **0**(cargo を走らせない。commit 済み `.wasm` を parity test が直接読む) |
| parity | TS を oracle に **10 ケース群 / ランダム 300 本の鎖**で byte 一致(ja / CRLF / 絵文字 / 末尾改行なし / full 混在 / 空 を必須次元として**宣言的に pin**) |
| F4 対策(高水位) | **実装済み** ── 32MB 超で instance を作り直してメモリを捨てる(Module は保持するので再生成は同期)。実測: 36MB の本文を通しても **1.1MB 据え置き**(対策前は 206MB が居座った)。test で pin |
| 安全性 | 境界検査を全て `checked_add` + スライス `get()` に(review H1 ── wasm32 の `usize` は 32bit で wrap し、素朴な検査は巨大長で**すり抜けて UB になっていた**)。生ポインタを触るのは入口 1 回だけ |
| 値域の門番 | 橋が ops を検証し、u32 で潰れる値・小数は **wasm に渡さず TS へ委譲**(review M1 ── 渡すと「TS は throw / wasm はそれらしい本文」の分岐ができる) |

### R2: 復元チェーンの wasm 化 ── ⏸ **本番配線は保留(数字が再現しない)**

出力は TS と完全一致した(parity 全 green)。**速度の判定が harness 間で再現しない**:

| ja 2500 行(約 100KB) | 5 段 | 20 段 | 50 段 |
|---|---|---|---|
| 初回計測(揮発 harness) | 97% 悪化 | **15% 悪化** | 13% 悪化 |
| review の独立再測 | 13–30% 悪化 | **17–27% 改善** | 32–36% 改善 |
| 再測(v2 橋 + repo 内 harness、TS 先) | 83% 悪化 | **19% 悪化** | 2% 短縮 |
| 同(wasm 先 ── 実行順の影響を見る) | 54% 悪化 | **13% 悪化** | 7% 短縮 |

ascii は一貫して wasm の勝ち(30–46% 短縮)。**割れているのは ja の 20 段**で、
同じ fixture・同じ手法でも harness をまたぐと符号が変わる。

**判断: 数字が割れている以上、これを根拠に構造を決めない。**
- 絶対値はいずれも 1 桁 ms で、**体感差を生む領域ではない**(この時点で「どちらでも
  user 体験は変わらない」が確定している)
- §3.1 のとおり**全て Node 実測でブラウザ実測ではない**。user 指示「boot 直後とか
  測ってない?意味ないからね」に照らせば、**構造を変える根拠には実機の数字が要る**
- したがって本番経路は TS のまま(単純・境界なし・毒/フォールバック面なし)。
  **P5c-3 の probe(実ブラウザ)で測り直してから再訪する**

⚠ 手法の教訓(review M3): 初回の判定は **scratchpad の揮発 harness** で測ったため
第三者が再現できなかった。harness を `tests/bench/restore-chain-bench.mjs` として
**repo に固定**した(fixture・段の形・順序切替つき)。以後この種の判定は
「再現できる形で残す」ことを条件にする。

⚠ 実測で否定された仮説(記録): 「原因は出力 decode が支配項」は **20 段以上では
成り立たない**(review の分解計測: wasm 本体 77% / decode 14% / encode 4%)。
decode が支配するのは 5 段以下だけで、段数が増えると §2.1 の B1 が予測したとおり
償却される。§10.5 初版の記述はこの点で誤っていた。

**残したもの**: crate / 橋 / parity test / ビルドスクリプト / pin / bench harness。
**本番の import は 0** なので、製品 bundle に `.wasm` は入らない。

**この結果自体が枠組みの妥当性の検証になっている**: 「なるべく Rust」を素直に実行して最有力候補から手を付けたら、実測が止めた。§2.1 の黒字条件(B1/B2)は後知恵ではなく、**この判定を事前に予告していた**。

---

## 11. 反対弁論で出た穴(握りつぶさず記録。対策 or 受容の判断付き)

| # | 穴 | 判断 | 参照 |
|---|---|---|---|
| F1 | **hash の UTF-16/UTF-8 非互換が永続データを壊す**。`'日本語'` で JS `5406374e…` / wasm `805f5ce7…`。`content_hash` は DB 列 | **対策 = 移さない**(§5-2)。加えて**恒久ルール**化 + docblock 明記(R0-⑤)。R2 の設計は hash を JS 側・UTF-16 のまま残すことで**構造的に回避** | §5-2 |
| F2 | **日本語では UTF-8 が仕事量を増やす**(100 UTF-16 chars = 228 UTF-8 bytes)。content-hash は全サイズで wasm 敗北 | **受容 + 基準化**。B1(境界 1 往復あたりの仕事量)として §2.1 に組み込み済み。「入力 1 バイトあたり O(1) の処理は負ける」を棄却基準に採用 | §2.1 |
| F3 | **ゼロコピー指示と矛盾する ── 素朴にやると 3 コピー** | **受容 + 解釈の確定**(§2.3)。「Rust 化するとゼロコピーに近づく」を**擁護論に使わない**ことを doc に明記。指示は「巨大な中間生成物を作るな」と読む | §2.3 |
| F4 | **linear memory は縮まない**(`shrink` は仕様に無い)。64MB を 1 回使うと 66MB が常駐。PKC2 の +293MB と同型 | **対策 3 段**(§6.4)。①高水位を作る仕事を載せない ②stateless module ③閾値超過で instance ごと破棄(実測: 175.4→47.5MB)。**test/probe で pin することを R1 の DoD にする**。代償(3 コピー確定)は受容 | §6.4 |
| F5 | **panic の可観測性が壊滅**。message が出ない、行番号なし、**panic 後も alloc が成功する**(instance が毒されない) | **対策必須**(§6.5)。status code / panic hook / 毒フラグ + TS フォールバック。**これが無いなら着地させない**(R1 の DoD) | §6.5 |
| F6 | **hot spot は Myers ではなく `splitLines`**(88%)。**wasm 抜き・境界抜きで 1.56x** | **対策 = R0 を先にやる**。加えて §3.4 で「既存の wasm 勝敗は対照群が揃っていない」と明記し、R2 のゲートを事前登録 | §3.4 / §4.1 |
| F7 | **markdown-render は移してはいけない**(価値は parser でなく PKC 固有層、出口が `innerHTML`) | **受容 = やらない**(§5-1)。将来条件を明記 | §5-1 |
| F9 | **`npm test` が単独で走らなくなる**(ビルド済み `.wasm` の存在がテストの前提になる)/ **供給網の二重化** / **パリティ検証に出口がない(TS を残すと保守 2 倍)** | **一部対策・一部受容**。① `.wasm` を commit するので「テストの前に何かをビルドする」必要は生じない(単独実行性は維持)②外部 crate 0 を既定にすることで dependabot cargo / `cargo audit` を不要にする(§5-10)③**保守 2 倍は受容**。ただし TS は毒後フォールバック先でもある(§7.1)。「TS が正、wasm が従」の順序規律で最小化 | §7.1 / §5-10 |
| F10 | **12KB の固定費**(trivial crate)+ base64 の 33% | **対策 = crate を 1 つに集約 + `#![no_std]` 既定**(5,405 B)。「1 関数だけ Rust」を明示的に禁止(§5-11)。P7 影響は sqlite 比 +0.6%(§8.5) | §6.1 / §8.5 |

---

## 12. 裁定記録(2026-08-01 ── **起草者の推奨どおり全件採用**)

> user 裁定: 「なるほど。**君の推奨が良さそうだ。そのまま進めてください**」(2026-08-01)

| # | 論点 | 選択肢 | 採用(= 起草者の推奨) |
|---|---|---|---|
| 1 | **本 doc の枠組み全体**(§2 の黒字条件と棄却 3 分類) | 採用 / 修正 | 採用 |
| 2 | **R0 を R1 より先にやること**(Rust の前に JS の取りこぼしを回収) | 先にやる / 並行 / 後回し | **先にやる**。対照群が揃わないまま Rust の勝敗を測ると「間違った勝利宣言」をする |
| 3 | **最初の payload を「復元チェーン」にすること**(diff 単体ではなく) | 採用 / diff 単体 / 別候補 | 復元チェーン。B1–B3 を構造的に満たす唯一の現行候補 |
| 4 | **入力 marshalling 戦略**(§6.2): 適応版(メモリ 3.7MB / ja 1.39ms)か 3x 先確保(4.8MB / ja 872us)か | 適応 / 3x / 実装時に再測して決める | **適応**(メモリ安全性の不可侵指示を優先)。ただし ja で TS とほぼ並ぶので、R2 の再測で判断し直す余地を残す |
| 5 | **markdown の byte 一致 golden 契約**を将来捨てる余地があるか(§5-1 の将来条件) | 捨てない / R0-2 後に再議 | **捨てない**。捨てるなら別 doc で改めて裁定 |
| 6 | **host `cargo test` を PR gate に入れるか**(+0.4〜1s) | 入れる / nightly のみ | nightly のみ(§9) |
| 7 | **外部 crate 0 を既定にすること**(§5-10) | 採用 / 個別判断 | 採用。crate 追加は「なぜ自前で書けないか」を doc に書いて都度裁定 |

---

## 13. 参照

- 正本: `docs/development/pkc3-major-upgrade-design-2026-07.md`(§0 不可侵 / §5 是正 / §7 依存方針 / §11 段階 / §12 裁定記録)
- `docs/development/p5c-revision-delta-design-2026-08.md`(逆向き差分チェーン ── R2 の対象)
- `docs/development/p2-storage-core-log-2026-07.md`(SAHPool / journal の実測 ── §5-9 の「捨てられない資産」)
- 現行コード: `src/features/revision/line-patch.ts` / `src/adapter/platform/storage/content-hash.ts` / `src/adapter/platform/storage/storage-worker.ts` / `src/features/markdown/markdown-render.ts`
- 計測ハーネス(scratchpad、揮発): `bench/`(profile・attribution)/ `rswasm/` / `wasm-spike/`(crate 560 行 + harness 8 本、71 アサーション全 pass・22 ケース byte 一致)/ `wasm-ci/`(`guard/wasm-lock.mjs` はそのまま `scripts/` に置ける完成品)/ `rustwasm/`
- PKC2(read-only 参照): 計測規律 `PKC2:.claude/skills/perf-measurement/SKILL.md`(⚠ PKC3 には無い)、`docs/development/storage-default-layout-decision-2026-07-26.md`

---

## 付記(調査中に観測した異常)

調査中、`/home/user/PKC3` の worktree が一時的に dirty になった(`src/adapter/platform/storage/storage-worker.ts` / `tests/adapter/storage-worker.test.ts`)。**本調査による変更ではない**(調査は PKC3 を読み出しのみ)── 同じツリーで**並行していた P5c review の反映作業**によるもので、`439567c` として commit 済み。

⚠ この観測自体が教訓である: **計測と実装を同じ worktree で並行させると、計測対象のコードが測定中に変わりうる**。§3 の数字は「その時点の HEAD 近傍」であり、R0 後の再測(§3.4 のゲート)は**単独で走らせる**こと。

⚠ この commit により `storage-worker.ts` の行番号が動いている。調査時点の `:391 / :488 / :609` は**現在それぞれ `:400 / :497 / :636`**。本 doc の引用はすべて `439567c` 時点の実ファイルで再確認した値を使っている。