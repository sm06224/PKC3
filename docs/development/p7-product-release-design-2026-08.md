# P7: v3.0.0 ── Pages プロダクト版 + PWA 仕上げ

> **status**: **裁定済み・実装 go**
> **裁定**: user「あなたが良いと思う方で良いです / とても良い提案です」(2026-08-02)
> ── §5 の 4 点は Claude 判断に委任。採った側を §5 に記録
> **前提**: P6 完了(#34〜#48)。取込・書出し・履歴の復元まで着地済み
> **正本**: `pkc3-major-upgrade-design-2026-07.md` §8(配信)/ §11(段階表の P7)

## 0. いま何が「宣言だけ」になっているか

P1 で骨格を置いたまま P7 まで来たので、**宣言はあるが実体が無い**ものが 3 つある。
これは P6f で潰したのと同じ構図(`file_handlers` を宣言しながら受け口が無い =
manifest が嘘をついている)なので、まずここを列挙する。

| # | 宣言 | 実体 | いま user に起きること |
|---|---|---|---|
| 1 | `manifest.webmanifest` の `file_handlers`(`.md` / `.markdown`) | **`launchQueue` を読むコードがゼロ** | md をダブルクリックすると PKC3 が起動して**何も起きない**(空のアプリが開く) |
| 2 | `sw.js` を登録している | `fetch` が pass-through | **オフラインで一切動かない**。PWA として install できるのに、機内モードで開くと白紙 |
| 3 | Pages の product URL | 初回 release が無く placeholder | `/` が placeholder のまま |

⚠ 1 と 2 は「install できてしまう」ぶん、**何も無いより悪い**。
install した user は「オフラインで使える」「md を開ける」と期待する。

---

## 1. 🔴 素の `.md` を受ける経路が無い(1 の前提)

`file_handlers` を実装するには「md を 1 件受け取って entry にする」経路が要る。
いまの取込は **PKC2 形式の 8 種だけ**で、素の markdown の受理器は無い。

- `detect-format.ts` は `pkc2-*` の manifest / slot を見て判別する ── md は「不明」で断られる
- P6d 段④ で **書き出す**側(md ZIP)は作ったが、**読む**側は作っていない

### 提案: `readPlainMarkdown`(受理器 1 個)

| 決めごと | 内容 |
|---|---|
| 題名 | frontmatter の `title` → 先頭 `# 見出し` → ファイル名(拡張子を落とす)の順 |
| archetype | frontmatter の `archetype` があれば採用(白名単のみ)、無ければ `text` |
| 本文 | **原文のまま**(frontmatter も含めて丸ごと)。⚠ 再構築しない ── P6d 段④ で踏んだ規律 |
| 添付 | 相対パス参照(`assets/…`)は**解決しない**。単一 md は添付を持ってこないので、参照は原文のまま残し「画像は含まれていません」と件数で言う |
| 複数選択 | `launchQueue` は複数ファイルを渡せる ── 1 件ずつ entry を作る |

🔑 **md ZIP の逆ではない**。md ZIP は「フォルダごと」だが、これは「1 ファイル」。
フォルダ取込(`assets/` の解決込み)は**別の段**にする ── 混ぜると
「どっちの経路で壊れたか」が分からなくなる。

---

## 2. Service Worker の cache 戦略

### 2-1. 何を precache するか

現状のビルド生成物:

| ファイル | サイズ | precache |
|---|---|---|
| `index.html` | 0.5KB | ✅ |
| `manifest.webmanifest` / `icon.svg` | 0.8KB | ✅ |
| `assets/index-*.js` | 304KB | ✅ |
| `assets/sqlite3-*.wasm` | 848KB | ✅ **必須**(無いと storage が起動しない) |
| `assets/storage-worker-*.js` | 228KB | ✅ |
| `assets/sqlite3-worker1-*.js` | 208KB | ✅ |
| `assets/sqlite3-opfs-async-proxy-*.js` | 32KB | ✅ |
| `assets/*.js.map` | **3.2MB** | ❌ 論外 |

→ precache 合計 **約 1.6MB**。

🔴 **`.map` を product で配るのをやめる**。いま `vite.config.ts` は `sourcemap: true` 固定で、
**生成物の 3.2MB(全体の 2/3)が map**。dev 版では要るが product では要らない
── 「速く、安く」に真っ向から反する。`VITE_PKC_KIND` で切り分ける。

### 2-2. 戦略

- **precache**: build 時にファイル一覧を SW へ焼き込む(Vite plugin で生成)。
  ⚠ 手書きの一覧は**必ず腐る** ── ハッシュ付きファイル名なので、
  ビルドのたびに変わる。生成しない選択肢は無い
- **navigation**: network-first → 失敗したら cache。
  ⚠ cache-first にすると**新しい版が永久に届かない**(PWA の定番事故)
- **assets(ハッシュ付き)**: cache-first。名前が変われば別 URL なので陳腐化しない
- **cache 名に build id を入れ、activate で古い cache を消す**。
  ⚠ 消さないと OPFS とは別に**ブラウザの cache が無限に積み上がる**

### 2-3. 🔴 更新の届き方を user に見せる

新しい版を precache し終えたら「新しい版があります(再読込)」と出す。
⚠ **黙って次回起動で切り替える**のは避ける ── 「直したはずのバグが直っていない」
という報告の原因になり、こちらからは再現できない。

---

## 3. 検証(何をどう確かめるか)

| 対象 | 見方 |
|---|---|
| オフライン | smoke で `context.setOffline(true)` → reload → **entry が読める**ところまで。⚠ 「SW が登録された」で止めない ── 登録されていても cache が空なら白紙 |
| md ハンドラ | `launchQueue` は実ブラウザの install が要るので smoke では直接踏めない。**受け口の関数を直接呼ぶ** unit + 「manifest の宣言と受け口の存在が一致する」parity test |
| precache 一覧 | **生成物と一致するか**を build 後に検査(手書きに退化したら落ちる) |
| `.map` を配らない | product ビルドの生成物に `.map` が無いことを assert |

🔑 parity test の形は P6f で確立したもの ──
**「manifest が宣言する拡張子は、受理器が実際に受ける」**を規則そのものに対して assert する。
宣言と実体がずれる事故は、この期間だけで 2 回起きている。

---

## 4. 段取り(各段が単独で着地)

| 段 | 内容 | なぜこの順か |
|---|---|---|
| ① | ✅ **product ビルドから `.map` を外す** + size の tripwire を Pages 用に読み替え | 1 行に近く、以降の全計測の前提が変わる |
| ② | **素の md 受理器**(`readPlainMarkdown`)+ 取込導線 | ③ の前提。単体で価値がある(md を drag&drop できる) |
| ③ | **`launchQueue` の受け口** ── 宣言と実体を一致させる | ② が無いと書けない |
| ④ | **SW の precache**(生成 + navigation network-first + 旧 cache 掃除)+ オフライン smoke | 独立 |
| ⑤ | **更新通知**(新しい版があります) | ④ の上 |
| ⑥ | **マニュアル + 移行ガイド**(PKC2 → PKC3) | 実装が固まってから書く |
| ⑦ | **v3.0.0 release**(SBOM 添付は既存、provenance attestation を足す)→ product URL 稼働 | 最後 |

⚠ ⑥ は「実装が固まってから」。先に書くと**嘘のマニュアル**になる。

### 段① 実装記録(2026-08-02 着地)

| kind | ファイル | 配る量 | map |
|---|---|---|---|
| product | 9 件 | **1610.9 KB** | 0 件 / 0.0 KB |
| dev | 12 件 | 1611.1 KB | 3 件 / **3227.3 KB** |

🔑 **配る量の差は 0.2 KB しかない**。捨てたのは product の配信量 3.2MB だけで、
調査手段(`/dev/` の map)は 1 バイトも失っていない。

⚠ **「差は `sourceMappingURL` の行だけ」ではない**(レビュー M-1 で実測、当初の記述は誤り)。
`BUILD_KIND`(`import.meta.env.VITE_PKC_KIND`)が bundle に焼き込まれるので:

| | dev | product |
|---|---|---|
| entry chunk | `index-BBeB4SpM.js` 308,519 B | `index-BR29g7kI.js` 308,492 B |
| 内訳 | `sourceMappingURL` 行 +42 B | 刻印 `` `product` `` −16 B(実質) |
| content hash | **別**(= file 名が別) | |

したがって **product のスタックトレースを dev の map で読み替えることはできない**
── 縮小 bundle は実質 1 行で、刻印のぶんカラムが十数ずれる(同一マーカーで
+12〜+16、しかも一定ではない)。運用は「**`/dev/` の URL で再現してもらい、
dev 自身の map で読む**」であって、「product の trace を dev の map に流し込む」ではない。

🔑 それでも **PR gate に product ビルドを足さない**根拠は成立する ── 根拠は
「同じコードだから」ではなく「**配る量が kind でほぼ変わらない(0.2 KB 差)から
cap の tripwire は dev ビルド 1 回で効く**」である(CI を長くしない・user 指示 2026-07-30)。

⚠ ただし **product bundle は PR gate が一度もビルドしない別成果物**になる。
Pages の `/` に出るのはこちらなので、**nightly でビルド → 検品 → smoke** まで通す。

検査は 2 段構え ──
`tests/build-config.test.ts` が **config の意図**を、`scripts/check-dist.mjs` が
**実物のファイル一覧と中身**を見る。plugin が map を足す経路は config を読んでも分からない。

### 🔴 検査そのものが空振りしていた(レビューで 2 件)

| # | 空振りしていた検査 | 何に救われていたか | 実証 |
|---|---|---|---|
| 1 | `walk` が sub dir へ降りない変異 | ── | 配る量 1.7 KB・map 0 件で **product 側が全部通った** |
| 2 | 「entry の `.js` が 1 件でもある」 | `sw.js`(public の静的コピー) | `rm dist/assets/index-*.js` しても **`✓ ok`**(起動不能な生成物が通過) |

規律: **「それらしいファイルが在るか」で書かない。「参照されているものが実在するか」で書く。**
前者は代替物に救われるが、後者は救われない。いまは
① `index.html` が指す先 ② bundle が名指しする hash 付き生成物(worker / wasm)
の 2 方向で実在を突き合わせ、**参照が 0 件なら「走査が空振りしている」として落とす**。

### 🔴 件数を数える検査は、埋め込まれた実体を見落とす

`--sourcemap inline` は `.map` を 1 件も出さない ── 4.3MB の base64 map を出荷しながら
script は「map 0 件」と報告した(レビュー M-2 で実証)。しかも落ちたのは size cap の枝で、
その文言は **「cap を引き上げてよい」という誤った処方**を出していた。
`sourceMappingURL=data:` を中身から探し、inline も map として数える。

### 🔴 shell の `&&` と `||` は同順位・左結合

`pages.yml` の product 検品を `[ -f X ] && node X || true` と書いていた。これは
`(([ -f X ] && node X) || true)` と解釈され、**「script が無いとき」ではなく
「検品が失敗したとき」も飛ばす**。実証: 検品が `✗ product に map が 3 件ある` を
出した直後に `cp -r ../product/dist/. _site/` へ到達し、**step は exit 0**
── map 3.2MB を載せたまま Pages `/` に deploy されて job は green になる。
`if [ -f X ]; then node X; fi` と書く。

---

## 5. 裁定(2026-08-02、user 委任 → 採った側)

| # | 論点 | 採った側 | なぜ |
|---|---|---|---|
| 1 | 素の md 受理器 | **足す** | `file_handlers` を宣言している以上、無ければ manifest が嘘。宣言を外す側に倒すと「md を開ける」という user 指示 9 を捨てることになる ── 指示は生きているので、実体の側を合わせる |
| 2 | product の sourcemap | **外す** | 生成物の 2/3 が map。「速く、安く」に真っ向から反する。本番のスタックトレースは **dev 版 URL で再現**してもらう(`/dev/` は同じコードで map つき ── 捨てているのは product の配信量だけで、調査手段は失わない) |
| 3 | 更新通知 | **「再読込」ボタンを出す** | status に 1 行だと**読まれない**。押せば直る問題を、押せない形で伝えない |
| 4 | フォルダ取込 | **別の段** | 単一 md と混ぜると「どっちの経路で壊れたか」が分からなくなる。P6c で 8 形式を 1 つずつ着地させたのと同じ理由 |

⚠ 2 について: `/dev/` にだけ map を置く形にするので、**dev 版のビルドは product と
同じコード**でなければならない(map だけが違う)。ここがずれると「dev では再現しない」
という最悪の調査状況になる ── Pages workflow は同じ commit から両方を作ること

## 6. 参照

- `pkc3-major-upgrade-design-2026-07.md` §8(配信)/ §11(段階表)
- `p6d-export-design-2026-08.md`(md ZIP ── 書く側。読む側は本 doc §1)
- `CLAUDE.md`「検証の規律」(宣言と実体のずれを parity test で縛る)
