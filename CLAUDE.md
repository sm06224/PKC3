# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository (PKC3).

## Language Policy

- Internal reasoning MUST be in American English
- Final output MUST be in Japanese

## 会話・提示ルール(user 確立、PKC2 から継承。必ず遵守)

- **AskUserQuestion ツールは使わない**。質問・確認は必ず会話文で行う
- **成果物は GitHub URL(rendered)で提示**。diff の貼り付けでは伝わらない
- **doc-first**: 実装前に設計 doc → GitHub URL で提示 → user 裁定 → 実装
- **意図を読む**: user の発言が事実と食い違っていても、関連する実態を探して会話で聞き返す

## 方針(founding。user 裁定 2026-07-30)

> **北極星: 速く、安く、必要十分、利便性最大。「最強のノートアプリにするんだー」**

- **正本 doc** = `docs/development/pkc3-major-upgrade-design-2026-07.md`(P0 裁定済み・実装 go。
  §12 が裁定記録)。まずこれを読む
- 🚫 **PKC2(sm06224/PKC2)は read-only 参照のみ。手を出さない**(user 指示 2026-07-30)。
  実測・設計の根拠 doc 群は PKC2 側にある(正本 doc §13 にリンク)
- **流用 + 総合的見直し。丸写し禁止**(user 指示 2026-07-30)── 古い設計・積み上げで
  遅くなる実装を持ち込まない。PKC2 はそれで失敗した
- **全 body = PKC-Markdown、アーキタイプ = フレーバー**(見せ方・編集の仕方)。
  JSON 文字列 body を作らない
- **storage**: wasm-sqlite(OPFS SAHPool・専用 worker)+ IDB Blob のハイブリッド。
  ゼロコピー・生成物のライフサイクル終端での即破棄(user 指示 2026-07-27、不可侵)
- **flags は最大 15 個(CI test で pin)+ 各 flag に畳む条件の宣言必須。正規設定(settings)と
  分離する**(user 指示 2026-07-30)
- **新機能を盛り込みすぎない**。将来領域(フォーム→ダッシュボード・帳票 / Graph API・OneNote)は
  正本 doc §10 の拡張点のみ。着手は user の明示 go
- **PKC3 export は PKC2 にインポートしない**(一方通行、user 裁定 2026-07-30)。
  import は PKC2 全形式を受理して新スキーマへ変換
- **計測規律は PKC2 から継承**: boot 窓だけで定常を語らない / 対照群を揃える /
  persistent profile で測る / fixture のゼロ件次元は「測っていない次元」/
  倍率より向き・百分率は分母を書く

## プロセス指示(user 指示 2026-07-30。必ず遵守)

- **必要な時にやる**: 常時監視・儀式的な定期実行はしない。予約・監視は「未完の作業が
  残っているとき」だけ張り、着地したら畳む
- **CI を長くしない**(PKC2 の「CI 長すぎ問題」の再発防止): PR gate は**速い lane に限定**
  (typecheck / lint / unit / build ── 目標 5 分以内、workflow の timeout 10 分 = tripwire)。
  重い検証(視覚テスト全量・ベンチ・全 matrix・カバレッジ集計)は main push / nightly /
  手動 dispatch に逃がす。**gate を足すときは「これは PR で走る必要があるか」を毎回問う**
- **品質はサブエージェント・スキルで守る**: 実装 PR は着地前に code review(サブエージェント)を
  回す。性能の主張は perf-measurement の規律(測ってから言う)。視覚を持つ変更は視覚テスト
- **視覚テスト**: PKC2 の視覚テスト資産(playwright-visual / visual-parity / shinsatsu)を
  **遅くなりすぎないように改修して**使う。UI 実装が始まる P3 で導入 ──
  PR gate には最小 smoke(数 spec・秒オーダー)のみ、全量は nightly

## Build & Development Commands

```bash
npm run dev        # Vite dev server
npm run build      # Vite build → dist/(マルチファイル)
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src tests
```

## 段階(正本 doc §11)

P1 bootstrap → P2 計測 + sqlite core → P3 app 層の総合的見直し + リーン集約 →
P4 assets → P5 revisions → P6 import/export → P7 v3.0.0(Pages product + PWA 仕上げ)。
各段階が単独で着地し、単独で計測できる。「効果が小さい」は棄却理由にしない。

## 検証の規律(2026-08-02 に確立。P6c〜P6f の実測から)

> **通っている test は、何も保証していないかもしれない。**
> この期間にレビューが見つけた欠陥は、**ほぼ全部「test が緑のまま壊れていた」**。

- 🔴 **着地前に変異試験を回す**。実装を意図的に壊し、test が落ちることを確かめる
  (`cp` でバックアップ、`git checkout` は使わない)。落ちなければ、その test は
  **その機構を守っていない**。実績: 1 PR あたり 1〜3 件が生き残り、その多くが
  「既に壊れているのに鳴っていない」だった
  - ⚠ **変異自体を疑う**。発火しない形で当てて素通りしたことがある
  - ⚠ 「添付が ZIP に入るか」のような**下流の結果**だけを見る test は、別経路が
    救って変異を見逃す。**壊れる当の振る舞い**(書き換えが起きるか等)を直接見る
- 🔴 **stub は本物の意味論を真似る**。stub が実装より正しいとバグが隠れる
  (fake の `getRevision` が保存形をそのまま返し、本物が materialize する食い違いを
  隠していた ── 「鎖のまま往復する」test が壊れた実装でも通った)
- 🔴 **fixture のゼロ件の次元は「測っていない次元」**。本文が短いと逆向きパッチが
  一度も生まれず、パッチ経路を壊す変異が素通りした。**その次元が非ゼロか**を
  test 自身に assert させる(`expect(chain.some((r) => r.kind === 'patch')).toBe(true)`)
- 🔴 **空振りを直したら「今度は何に救われていないか」を問う**(2026-08-02、P7 段① で
  2 ラウンド連続で踏んだ)。1 巡目「`.js` が 1 件でもある」は `sw.js`(public の静的
  コピー)に救われ、**アプリ本体を消しても緑**だった。直して「index.html の参照を突合」に
  したら、2 巡目は**空振り防止のガード自体**が `manifest.webmanifest` / `icon.svg`
  (Vite が書き換えない public の静的参照)に満たされ、`--base /` にすると
  **やはり本体を消しても緑**だった。⚠ **救い手が変わっただけ**である。
  規律:(1)「それらしいものが在るか」ではなく「**参照されているものが実在するか**」で
  書く (2) ガードは**代替物で満たせない条件**にする(「参照が 1 件でもある」ではなく
  「**hash 付き生成物への参照が 1 件でもある**」)(3) **検品する側・test する側も
  変異試験の対象**にする ── 検品が壊れると「通った」という事実だけが残る
- 🔴 **tripwire は上限だけでなく下限も置く**。取り違え・欠落は**縮む方向**にも起きる
  ── size cap しか無いと、entry chunk を **0 バイト**にしても「配る量が減った」だけで
  通る(実証)。**件数を数える検査も同型** ── `--sourcemap inline` は `.map` を 1 件も
  出さないので、4.3MB の map を出荷しながら「map 0 件」と報告した
- 🔴 **shell の `&&` と `||` は同順位・左結合**。CI の条件付き実行を
  `[ -f X ] && cmd || true` と書くと `(([ -f X ] && cmd) || true)` になり、
  **「無いとき」ではなく「失敗したとき」も飛ばす**。実証: 検品が `✗` を出した直後に
  deploy 行へ到達し **step は exit 0**(不良物を配って job は green)。`if [ -f X ]; then cmd; fi` と書く
- 🔴 **判定を増やさない。誤差の向きを決めて、両側に使い回さない**。
  「どれを含めるか」は false-keep 側(広く拾う)、「どこを書き換えるか」は
  誤爆しない側(狭く当てる)── 片方の規則をもう片方に流用すると、誤差が
  **データ欠損の向き**へ反転する。同じ判定が 2 か所に生えたら、**規則を 1 つに寄せ、
  「A が keep するものは B にも必ず入る」parity test** を置く
  (実例: `features/asset/asset-ref-scan.ts` / `frontmatter.ts` の原文 splice)
  - ⚠ **同じ「参照を拾う」でも、場所によって受け方を変える**(2026-08-02、
    `scripts/dist-inspect.mjs`)。**構造化された場所**(HTML 属性 / JSON field)は
    散文が混じらないので緩く、**コードの中**は狭く当てる ── 出荷 bundle には
    ``…invoked from`,`client-level…`` のような散文が実在し、「hash らしき形」で拾うと
    `sqlite3-vfs-opfs.js` / `markdown-it-footnote.js` を誤検知して
    **release を偽の理由で止める**。形ではなく**構文**(`new URL(…)` / `import(…)`)で拾う
- 🔴 **壊れを検出する材料を捨てない**。`content_hash` のような照合材料を落とすと、
  誤りが**自己証明されて固定される**(書込側が計算し直すので以後の検査も通る)。
  ⚠ **検査を書いただけでは足りない** ── 材料が実際に届いていることを pin する
  (optional な field は writer が代入を落としても tsc が黙る = 全件で無効化される)
- ⚠ **環境の性質をアプリの不具合と読み違えない**。この headless Chromium は
  **非 ASCII の `<a download>` 名を丸ごと捨てて `"download"` にする**。実データの
  題名はほぼ日本語なので、`download.suggestedFilename()` を観測点にすると必ず詰まる
  ── **アプリが制御している値**(属性そのもの)を見る
- **worker は node で動く**(`tests/adapter/storage-worker.test.ts` の手法:
  `self` / `postMessage` を差して実物を dynamic import、`:memory:` fallback)。
  「worker の中だから unit では届かない」は誤り ── smoke 1 本に頼ると、
  向き・題名・上限の変異が誰にも守られない
- 🔴 **整形ツールを既存 file に掛けない**。`npx prettier` を掛けて `main.ts` を
  全面リフォーマット(302 行差分)し、リポジトリで唯一 double quote の file にした。
  diff が読めなくなり、次に触る PR が全部 conflict する
- 🔴 **制御文字をソースに生バイトで埋めない**(``'\u007f'`` と書く)。
  「正規表現に書かない」と注意書きしている当の file で 3 度踏んだので、
  `npm test` の `tests/repo-hygiene.test.ts` が機械的に止める
