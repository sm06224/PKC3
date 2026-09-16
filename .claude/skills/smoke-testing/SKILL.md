---
name: smoke-testing
description: PKC3 の実ブラウザ検証(tests/smoke、Playwright)を書く・直す・回す手順。視覚や実 DOM 挙動を持つ変更を入れるとき、smoke が CI だけで落ちるとき、観測点の置き方に迷うときに使う。「smoke」「実ブラウザ」「Playwright」「CI だけ落ちる」「視覚テスト」という文脈で必ず使う。
---

# 実ブラウザ検証(PKC3 smoke)

`vitest` / `happy-dom` の pass は**生成の正しさ**しか示さない。画面に本当にそう出るかは
実ブラウザでしか分からない ── そのための最小の lane が `tests/smoke` である。

```bash
# 🟢 既定はこちら ── **触った物から引く**(#820)。読めない物が 1 件でも
#    混じったら自分でフルへ倒れる(表に無い file / CSS / smoke の土台 / src の外)
npm run smoke:pick

# 🟢 引く先が分かっているなら直に ── **触った spec だけ**(4〜20 秒)
npm run test:smoke -- tests/smoke/<触った>.smoke.spec.ts

# 🔴 全量(95 spec / 499 test ── 実数は tests/repo-hygiene.test.ts が pin)。
#    **着地の直前に 1 回だけ**。2026-09-09 実測: 手元 headless_shell・`workers: 4` で
#    約 7 分(`workers: 1` だった頃は 13.2 分)
npm run test:smoke
```

### 🔴 CI の全量は **押したときだけ**(user 指示 2026-09-09。不可侵)

> 「**自動CIにフルスモークテスト入ってない？/ 自動実行は禁止したはず /
> 約束では全て任意起動のはず**」

⚠ かつては `ci.yml` の `smoke` job が **PR / main への push のたび**に全量を
3 shard で回していた ── 手元を `smoke:pick` で引く形に直しても、
**CI が毎 push でフル**なら user の言う o(n²) は消えない。

> 🔴 **2026-09-11 に、夜も畳んだ**(user 指示。不可侵):
> 「**フルスモークCIを自動起動しないように設定しろ**」
>
> ⚠ **`schedule` も「押していない」側である。** 直す前は夜(18:00 UTC)に
> 全量が **2 周**しており、しかも上の検査には私が書いた carve-out
> (「⚠ `schedule` は落とさない」)まで在った ── **目的ではなく対象で書いた誤り**。

| 回す場所 | 引き金 | 中身 |
|---|---|---|
| **PR gate**(`ci.yml`) | push / PR で自動 | 型 / lint / unit / build / 検品 ── **smoke は 0 件** |
| 🔴 **`Smoke (手動)`**(`smoke.yml`) | **Run workflow を押したときだけ** | 全量・3 shard。入力で `browser: both`(2 つのブラウザを突き合わせる唯一の場)/ `kind: product` |
| **`Nightly`**(`nightly.yml`) | 夜 18:00 UTC / 手動 | 🔴 **全量 smoke は無い** ── product の焼きと検品 / Rust wasm の等価性 / probe |

🔑 **1 件も減っていない ── 起動する条件だけが変わった**(夜の 2 つは
`smoke.yml` の入力になった)。
⚠ `on:` に `push` / `pull_request` / **`schedule`** を足すと
`tests/workflow-steps.test.ts` が全数走査で落とす(**file 名ではなく引き金**を見る)。

### 🔴 対象範囲の smoke は**サブエージェント**に回させる(user 指示 2026-09-11。不可侵)

> 「**基本的には単体テストを自分で行い、サブエージェントに対象範囲のみの
> スモークテストをさせろ / UI導線のテストをフルスモークで誤魔化すな**」

| 誰が | 何を |
|---|---|
| **自分** | 単体 / typecheck / lint / build / 変異試験 |
| 🔴 **`pkc3-smoker`**(**worktree 隔離**) | 名指しした spec だけの実ブラウザ smoke |
| **自分が押す** | 全量 ── **着地の直前の 1 回**だけ |

⚠ 隔離が要る理由は 1 つ:**`npm run build` が `dist/` を書き換える**ので、
依頼者のツリーで並走させると**検査対象が入れ替わる**(すぐ下の「走っている最中に
build しない」の、エージェント版である)。

#### 🔴 頼み方は「spec 名」ではなく「動線」で書く

⚠ **全量が緑でも、新しく作った動線に検査が 1 つも無ければ緑である** ── 全量は
**回帰の網**であって、「その変更で何が変わるかを考えた証拠」ではない。
実際それで外した(2026-08-22、#300 ── レビュー 3 巡 + 全量緑のまま
「**動線がクソだ**」と言われた。**占有が不便**を見る検査がどこにも無かった)。

> ❌「`layout.smoke.spec.ts` を回して」
> ✅「**ノートを開く → 帯の『編集』を押す → 打つ → 『保存』を押す**、が素通りするか。
>    それを通る spec を引いて、**引いた理由**と**引かなかったが迷った物**を返して」

⚠ 返ってきた報告に「**迷って落とした物**」が 1 件も無ければ、範囲を考えていない合図。
🔑 動線そのものの良し悪しは `pkc3-ux-reviewer`(read-only)── **対で回す**。

⚠ **smoke は `vite preview` で `dist/` を配信する。** source を直しただけでは
検査対象に**届かない** ── 必ず `npm run build` を挟む。

### 🔴 逆向きの罠 ── **走っている最中に build しない**(2026-08-29 に踏んだ)

同じ事実(`dist/` を配る)の**裏側**である。⚠ smoke が走っている間に
`npm run build` を回すと、**配信中の `dist/` が入れ替わる**。

実際に踏んだ形(#382 の再現を回しながら、別件の build を挟んだ):

```
run2: 10:51:11 → 10:57:12 に実行
      ⚠ その間の 10:52:59 に npm run build ── dist を差し替えた
落ちた: page.goto('/') が net::ERR_HTTP_RESPONSE_CODE_FAILURE
```

🔑 **症状は「アプリの赤」の顔をして出る**(`gotoApp` が落ちるので、
どの spec が落ちるかは**その瞬間に走っていたもの**次第)── だから
**製品の間欠不具合と見分けがつかない**。

⚠ **その回は「判定不能」である。結果を読まない**(CLAUDE.md §4
「計器の対照群が崩れた回を、結果として数えない」)。

🔑 **規律**:
- **背景で smoke を回している間は `npm run build` を叩かない**
  (⚠ `npm test` / `tsc` / `lint` / 変異試験の vitest は `dist` を触らないので安全)
- 回す前に「いま `dist` を触る仕事が動いていないか」を 1 度確かめる
- ⚠ 落ちた回の log は**再実行の前に控える**(2026-08-29 の #561 の教訓と同じ)

## 🔴 フルを乱発しない(user 指示 2026-08-19)

> 「**フルスモークを乱発しないように / イタズラに時間とトークンを消費します /
> ここぞと言うときに使いましょう**」

実測(2026-08-19): 狙い撃ち 1〜3 spec = **4〜20 秒** / CI のフル = **4〜6 分**
(観測 3 回: 4m03s / 6m11s / 5m19s)。⚠ この日は同じ branch 系で **8 回 push した
= フルが 8 回回った**。多くは **1 spec しか触っていない**変更だった。

🔑 **いちばん効くのは「push をまとめる」** ── **push 1 回 = フル 1 回**である。
1 commit ごとに投げず、手元で緑にしてからまとめて 1 回にする。

### 🔴 引く・数える・作り直す(#820。user 指摘 2026-09-09)

> 「**最近、フルスモークが多すぎる / なぜフルで流すのか？ / 改修一件で増えるテストが
> 毎ターンの負荷に積み上がる / o(n2)のテストケース広がりを回避するための方策を**」

⚠ **`--only-changed` は使えない。** playwright のそれは **spec の import グラフ**を
追うが、smoke は `dist/` を配って動くので **spec と `src` の間に辺が無い** ──
実測で `src` を 1 file 触ると **0 本**しか選ばれない(spec を触れば 11 本)。
🔴 **製品を直したときだけ何も走らない**、という最悪の外し方である。

#### ① 引く ── `npm run smoke:pick`

```bash
node scripts/pick-smoke.mjs              # 引いた spec の名前を出すだけ
node scripts/pick-smoke.mjs --run        # そのまま走らせる(= npm run smoke:pick)
node scripts/pick-smoke.mjs src/a.ts     # file を直に渡す
```

表は `tests/smoke/smoke-map.json`(**どの spec がどの `src` を動かしたか**)。
⚠ **迷ったらフルへ倒れる**のが仕様である ── 倒れ損なう向きだけが本当の欠陥なので、
`tests/pick-smoke.test.ts` はそちらだけを厚く見ている。

#### ② 数える ── `npm run smoke:budget`

所要はほぼ**起動の数**で決まる(実測 **1 起動 ≒ 1.63 秒**、`workers: 1` のとき)。
⚠ assert を 1 つ足すのはほぼ 0 秒、起動を 1 つ足すと**以後すべての回に積まれる**。

🔑 だから **新しく起動する test を足すのではなく、既に在る道中に assert を足す**。
上限は `scripts/smoke-budget.mjs` の `BOOT_BUDGET`(`tests/smoke-budget.test.ts` が pin)。
⚠ **上げてよい。ただし理由を 1 行書く** ── 黙って上げると、何も守らない数字になる。

#### ③ 作り直す ── `npm run smoke:record && npm run smoke:map`

```bash
npm run build                 # ⚠ smoke は dist を配る
npm run smoke:record          # PKC3_SMOKE_COVERAGE=1 で全量(記録つき)
npm run smoke:map             # coverage-smoke/ → tests/smoke/smoke-map.json
```

⚠ **記録は既定では取らない**(取ること自体が遅くする)。表が古くなっても
**引く側が「表に無い」でフルへ倒れる**ので、腐り方は安全側である。
🔑 ただし**古い表は引きすぎず・引かなすぎる**ので、spec を大きく足したら作り直す。

⚠ **表が言えるのは「あの日の版で動かした」だけ** ── 「これから動かしうる」は
言えない(TIA の定石)。だから**着地の 1 回はフルのまま**にする。

**フルを回してよい「ここぞ」は 3 つだけ**:

1. **共有面**を触った(boot / renderer / storage / CSS / shell)── どの spec に効くか読めない
2. **CI のフルが落ちた**ので手元で再現したい(夜 / 手で押した `Smoke (手動)`)
3. **着地直前の最後の 1 回**

⚠ **変異試験の smoke は、その変異が殺されるはずの 1 spec に絞る。**
`build` + smoke の**対**で回るので、1 変異あたりのコストが跳ね上がる。
🔑 コストは「実行回数」ではなく **`build` + smoke の対の回数**で数える。

## 🔴 ブラウザが 2 つある

`tests/smoke/playwright.config.ts` は同梱の `/opt/pw-browsers/chromium`(フル Chromium)を
優先し、無ければ playwright 既定に落ちる ── **CI は後者 = `chromium_headless_shell`**。
この 2 つは**実挙動が違う**。

```bash
# CI と同じバイナリで回す
PKC3_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  npx playwright test --config tests/smoke/playwright.config.ts <grep>
```

実際に食い違った例(全部この repo で踏んだ):

| 事象 | `chromium` | `chromium_headless_shell` |
|---|---|---|
| `window.print()` | `beforeprint` のみ | **`beforeprint` + `afterprint` を同期発火** |
| CSP が止めた要求の `request` イベント | 5 秒待っても来ないことがある | assert より先に来る |
| 非 ASCII の `<a download>` 名 | — | **丸ごと捨てて `"download"` にする** |

🔴 **実ブラウザ依存の挙動に触れる spec は、両方のバイナリで通してから push する。**

⚠ そして**環境差の調査が本物のバグを見つけることがある** ── `afterprint` の
同期発火を追ったら「読み込み中の blob URL を revoke して**紙から画像が落ちる**」
実バグが出た。`chromium` では `afterprint` が来ないので永久に露見しなかった。
**「CI だけで落ちる」を環境のせいにして test 側だけ緩めない。**

## 🔴 **器を替えたら、smoke の読み手を `grep` で数える**(2026-09-15、#530 段③c)

⚠ CLAUDE.md §10 の「器を替えると**読み取れる値が変わる**」は、
**smoke でこそ静かに壊れる**。理由は 1 つ ── **鳴る計器が 1 つも無い**:

| | この壊れ方を拾えるか |
|---|---|
| `npx tsc` | 🚫 **鳴らない**(`getAttribute` の戻りは器に依らず `string \| null`) |
| `npm test`(unit) | 🚫 **鳴らない**(smoke は `npm test` に入っていない) |
| CI の `verify` | 🚫 **鳴らない**(2026-09-09 から全量 smoke は押したときだけ) |
| 🟢 **対象範囲の smoke** | **ここだけ**が拾う |

実例:線の器を `<line>` → `<path>` へ替え、読み手を直したつもりで
**2 か所を読み残した**。⚠ `<path>` に `x1` は無いので `getAttribute('x1')` は
`null` を返し、`Number(null)` は **0** になる ── 「板を動かしたら線も動く」を見る
`.poll(… ).not.toBe(x1Before)` は **永久に 0 と 0 を比べる**形になっていた。
⚠ **同じ file の 30 行上に、自分で「器が `<path>` なので `x1` はもう無い」と
書いてあった**(書いた本人が、その 2 行下で読み残した)。

🔑 **手順は 2 つ**:
1. **替えた器で消える属性を `grep` で数える**(`x1` / `x2` / `points` / `value` /
   `textContent` / `innerText`)── ⚠ **`tests/smoke` も範囲に入れる**(`src` と
   `tests/*.test.ts` だけ見ると、smoke の残骸がまるごと残る)
2. **読み方を 1 か所へ寄せる**(`startOf(l)` のような小さな関数)──
   ⚠ 寄せないと、次に 1 本足す人が `getAttribute('x1')` を手で書く

## 🔴 「unit では原理的に届かない層」を先に数える

smoke は高いので、**unit で届く物は unit に置く**。逆に、**unit が原理的に届かない層**は
smoke でしか守れない ── 書く前にここを数えると、spec が「念のため」で増えない。

happy-dom に**無い**もの(= その経路を unit は 1 度も実行しない):

| 無いもの | 帰結 |
|---|---|
| `document.execCommand` | `insertText` 系は**必ず fallback を通る** ── 本命の経路も、fallback との**意味論の差**も unit からは見えない(#250) |
| `ClipboardEvent` / `DragEvent` の実体 | fake を渡すので「こちらが渡した形」しか試していない |
| `caretPositionFromPoint` | 座標 → caret(ライブエディタの行選択) |
| 実 IME の composition | 確定の `input` が `isComposing: true` で来る等 |
| 実 BroadcastChannel / Web Locks / OPFS | 多重タブの合成(#177 / #253) |
| ブラウザの取り消し履歴(`Ctrl+Z`) | 「取り消せます」と**約束したのに誰も見ていない**状態になりやすい(#250) |

🔑 **user に約束した文(マニュアル・お知らせ)を、この表に照らす。**
「取り消せます」「順番どおり入ります」は unit では書けない ── そこが smoke の出番である。

### 🔴 **両端をまたぐ配線**は、unit が両側とも緑でも繋がっていないことがある

⚠ 上の表は「happy-dom に無いもの」だが、これは**別の型**である ── 道具は揃っているのに、
**unit が原理的に片端しか見ていない**。

実例(2026-08-25、#195 C-5 段①。**smoke が 3 件拾って unit は 1 件も拾えなかった**):

| 何が起きたか | なぜ unit は緑だったか |
|---|---|
| 🔴 港に合図(`nonce`)を添えていなかった ── 受け側は**黙って捨てる** | ホスト側の test は「何でも掴む受け側の stub」と、受け側の test は「手で封筒を組むホスト役」と話していた ── **どちらも相手の綴りを 1 度も見ていない** |
| 🔴 相手の挨拶が、こちらが繋ぐ**前**に飛ぶ | 各 test は自分の側の順番しか持たない ── **2 つの実物が同時に走る時間**は unit に無い |
| 🔴 許可を憶えても画面が変わらない(指紋が state しか見ていない) | 台帳の test は台帳を、描画の test は state を見る ── **その間の配線**は誰も通らない |

🔑 **書くべき test は 2 つある。smoke を足す前に、まず unit の側を直す**:

1. **封筒・合図・綴りは組む口を 1 か所にする**(`portHandoffMessage()` の形)──
   2 か所で組めば、いつか必ずずれる
2. 🔴 **本物どうしを繋ぐ unit を 1 本置く** ── 実物 A が投げた物を、実物 B が受ける。
   ⚠ **間に立つ役は「そのまま流す通り道」にする**(封筒を 1 バイトも作らせない)──
   作らせた瞬間、また片端しか見ていない test になる
3. そのうえで **smoke は「user の画面に出たか」**を見る(港が繋がったか、ではない)

⚠ **stub は本物より甘くしない**(CLAUDE.md §3 の**受け側版**)。この件の受け側 stub は
`tag` も `nonce` も見ずに何でも掴んでいた ── **甘い stub は、欠陥をそのまま隠す**。
🔑 判定を持つ相手を模すときは、**その判定ごと写す**。

## 🔴 台の「お約束の前処理」が、**いちばん大事な 1 回**を消していないか(2026-09-04、#685)

⚠ どの spec も冒頭で `dismissAnnounce(page)` を呼ぶ。⚠ その結果、
**起動したときのお知らせが出たままの状態**を **1 本も通っていなかった**。

そこに欠陥が在った ── 新しい機能を初めて押した user は、
**お知らせを読んで押しに行く**ので、その時点でまだ未読である。
420px の窓ではお知らせが**面いっぱい**に出て帯まで覆うため、
**押したのに、頼んだ物が 1 つも見えない**。🔴 **いちばん印象に残る回**が、
まるごとそれだった。

🔑 **前処理は「読みやすくするため」に入れる ── そのぶん、消した状態は
誰も見ていない。** 新しい動線を足したら、次の 3 つを自分に問う:

1. **台が毎回消しているもの**は何か(お知らせ / 同意 / 初回の案内)
2. その状態で**この動線を通る user が居るか**(居るなら、それが**初回**である)
3. 居るなら、**その 1 本を別の test にする**(前処理を外して、状態を作り直す)

⚠ 状態を作り直すときは**前提を先に確かめる** ── この件では
`localStorage.removeItem('pkc3.notices.seen')` の後に
「**別のタブではお知らせが出る**」を見てから「付箋では出ない」を見た。
それが無いと、未読に戻せていない回で**空振りのまま緑**になる。

## 観測点の置き方

### ① 環境差に強い側へ寄せる

「押した直後」ではなく「**印刷が始まる瞬間(`beforeprint`)**」── どちらのビルドでも
成立する点はどこかを探す。`afterprint` で状態が消える作りなら、消える前に測る。

```ts
// 「全体を印刷」の箱は afterprint で捨てられる ── beforeprint の瞬間に測る
return new Promise((resolve, reject) => {
  addEventListener('beforeprint', () => resolve(read()), { once: true });
  btn.click();
  setTimeout(() => reject(new Error('beforeprint が来なかった')), 5000);
});
```

### ② ネットワークの event を「飛んだ / 止まった」の判定に使わない

CSP が止めた試行も `page.on('request')` に**上がる**(応答は 1 度も返らない)。
到着の時期はビルドで違う ── どちらに寄せても片方で落ちる。

正しい観測点は **①アプリ自身の信号**(確認の帯が出た = 箱の中で違反が実際に起きた証拠)
\+ **②応答が返らないこと**の 2 つ。⚠ ②だけでは空振りでも通る。
⚠ 逆に「**試行そのものが起きない**」を主張する test では `request` が正しい観測点 ──
**主張が違えば観測点も違う**。

### ③ 空振り防止は「素のままの値」で置く

2 つの面を突き合わせる test は、**両面とも壊れていても一致する**。
だから各観測点に「**直す前はこうだった**」を書き、**片方がその値でないこと**を先に見る。

```ts
{ name: '注意書きの枠の太さ', sel: '.pkc-section-callout', prop: 'border-left-width', bare: '0px' }
// → まず app 側が bare でないことを assert してから、両面を toEqual で比べる
```

### 🔴 ③-b 時間に依存する観測点は、**負荷でしか出ない不具合**を捕まえない(2026-08-18、#258)

「フォルダの中に作る → 読み込み直す → まだ中に居る」は**証拠にならなかった**。
作成を 2 手(行を書く → ack → 辺を書く)に戻す変異を当てても **smoke は緑のまま**
── reload まで数百 ms あるので、2 手目が間に合ってしまう。
⚠ 元の不具合は**全量実行のときだけ**落ちた形なので、**時間で決まる観測点では
永久に捕まらない**(単独では通り、CI の混んだ回だけ赤くなる = flake に見える)。

🔑 **配線そのものを見る。** worker への命令列を採れば、時間に依らず確定する:

```ts
await page.addInitScript(() => {
  const w = window as unknown as { __ops?: string[] };
  w.__ops = [];
  const orig = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (this: Worker, data: unknown, ...rest: unknown[]) {
    const req = (data as { req?: { op?: string; parent?: unknown } } | null)?.req;
    if (req?.op) w.__ops!.push(req.op === 'upsertEntry' && req.parent ? 'upsertEntry+parent' : req.op);
    return (orig as (d: unknown, ...r: unknown[]) => void).call(this, data, ...rest);
  } as typeof Worker.prototype.postMessage;
});
// … 操作 …
const ops = await page.evaluate(() => (window as unknown as { __ops: string[] }).__ops.slice());
expect(ops, 'この test は空振り').toContain('upsertEntry+parent'); // ⚠ 空振り防止
expect(ops, '2 手に割れている').not.toContain('setEntryParent');
```

⚠ **記録を採る前に配列を空にする**(前の操作の命令が混ざると、どちらの操作の話か読めない)。
🔑 同型の先例: 2026-08-17「読みが書きを追い越す」も、`postMessage` を包んで
**命令の順番を記録**したことで推測が事実に変わった。

### ④ 計算後の style だけを見ない

`display: none` を併せると**改頁は消える**のに、計算後の `break-after` は `'page'` の
まま残る。**`getClientRects().length > 0`(箱が在る)と対にする**。

### 🔴 ④-b DOM の消滅を見るなら、**枝ごと消える形**を数える(2026-08-22、#270)

`MutationObserver` の `removedNodes` に載るのは、**観測している node の直下の子**である。
アプリが `region.textContent = ''` で**器ごと**捨てると、載るのは**器 1 つ**で、
中の行は 1 件も載らない。

⚠ だから「行が消えたか」を `el.matches('tr[data-pkc-entry]')` で照合する probe は、
**建て直しが原理的に映らない**。実際に踏んだ:1 稿目の trail は
`row-removed 0 件` を出し続け、**「組み直しは起きていない」と読み違えて
仮説を取り下げかけた**(真相は起きていた)。

🔑 **消された枝の中に居たか**で数える:

```js
const inside = el.matches?.('tr[data-pkc-entry]')
  ? 1
  : (el.querySelectorAll?.('tr[data-pkc-entry]').length ?? 0);
if (inside > 0) trail.push(['rows-detached', at(), inside]);
```

⚠ `addInitScript` の中では **`document.documentElement` はまだ `null`** ──
`observe(document.documentElement, …)` は例外を投げる。`observe(document, …)` にする。
🔑 投げた例外は `collectPageErrors` に拾われるので、**全 run が「別の理由で」赤**になり、
本来見たかった失敗と見分けが付かなくなる(8 回まるごと捨てた)。

### ⑤ 印刷は版面が紙の幅になる

`emulateMedia({media:'print'})` **だけでは viewport 幅が変わらない**。
紙で効く規則を見るには `setViewportSize({width:794,height:1123})`(A4 縦)が要る ──
その幅で**狭幅の上書きが発火する**ことも込みで見る。

### ⑥ canvas しか無い相手(LO wasm)を触る

`build/office-wasm/dialog-crash-probe.mjs` が実例。DOM が無いので観測点が乏しく、
**素直に見えるやり方が 3 つとも外れた**(2026-08-13):

| やったこと | なぜ外れたか |
|---|---|
| `.qt-window` の**枚数**を数える | LO は Start Center の窓を**そのまま Writer に作り替える**ので 1 のまま |
| `.qt-window` の**枚数**(その 2、2026-08-14) | メニューが閉じる(−1)とダイアログが開く(+1)が**相殺して 0** ── **効いているのに「効かなかった」**と読む |
| `.qt-window` の `textContent`(**主窓では**) | screen reader を入れていないと `Enable Screen Reader` から動かない |
| 絵の hash を **1 枚ずつ**比べる | **点滅するカーソル**で毎回変わる ── 何もしないキーが「届いた」になる |

🔴 **観測点の生死は「窓」ごとに違う**(2026-08-14 に判明。上の表を鵜呑みにして踏んだ)。
`textContent` は **LO の主窓では死んでいる**が、**Qt のダイアログ窓では題名が読める** ──
`io-layer-probe.mjs` は `/Word Count/i` で判定して実際に結果を出した(登録一覧に
`DIV.title-bar` が挙がっており、ダイアログ側は題名バーが DOM に在ると読める。
⚠ 主窓側の機構までは追っていない)。
🔑 **「この観測点は死んでいる」と書くときは、どの面でかまで書く。**

🔴 **新しい probe を書く前に、この表を読む。** 2026-08-14 に、**前日 自分で書いた注記を
新しい probe で 2 件とも踏んだ**(枚数の相殺 / textContent)。

使えたのは 3 つ:

1. **絵の hash を集合で比べる** ── 間隔(700ms 程度)をあけて 4 枚撮り、
   **集合ごと入れ替わったときだけ**「届いた」。点滅は 2 状態なので集合に収まる
2. 🔴 **対照群を手順の先頭に置く** ── 「ただの文字を打つ」。これが届いていない回は
   **以降の判定が全部無意味**(`controlsLanded` として結果に出す)
3. ⚠ **まず screenshot を見る** ── 上の 1・2 に気づいたのは絵を見たからである

⚠ **`el.focus()` では Qt に入力が入らない。** Qt は自前の focus 管理と IME 用の
隠し入力を持つので、合成 focus では入力先が決まらない ── **`page.mouse.click` で
実際に押す**。⚠ ただし**メニューを開いた直後に押し直さない**(メニューが閉じる)。

⚠ **ダイアログのショートカットは届かないことがある** ── LO wasm では `Ctrl+N` と
文字入力は通るのに `F5` / `Ctrl+H` は 1 枚も開かなかった。**メニューを座標でクリック**
するしかない。座標は screenshot から採るので **viewport を固定する**。

⚠ **wasm のスタックに名前が無いときは `--profiling-funcs`** で焼き直す
(name section だけが載る。実行は遅くならない)。⚠ `-sSAFE_HEAP=1` は**別物**で、
JS の heap view 越しの load/store しか見ない ── wasm 内部の参照は捕まえない。

## 🔴 **鳴らしている `<audio>` の `duration` は、読み終わるまで「途中の値」である**(2026-09-14、#683 段②a)

⚠ **5 回赤くして、そのたびに製品を疑った。** 実体は**計器**だった。

録音を切り出した file の長さを、**画面に出ている器**から読んでいた:

```ts
await expect.poll(() => player.evaluate((el: HTMLMediaElement) => el.readyState)).toBeGreaterThanOrEqual(1);
const info = await player.evaluate((el: HTMLMediaElement) => ({ duration: el.duration }));
```

🔴 **`readyState >= 1`(メタデータまで読めた)では足りない。** その器は
`autoplay` で**鳴らしながら読んでいる**ので、そこで返る `duration` は
**最後の block の時刻**であって、①最後の 1 packet の長さ ②頭と尻の札
(opus の `CodecDelay` / `DiscardPadding`)が**まだ効いていない**。

実測(同じ file、2 通りの録音で完全に一致):

| 最後の block の時刻 | 器が答えた `duration` | 本当の長さ |
|---|---|---|
| 2100ms | **2.10** | 2.00 |
| 2040ms | **2.04** | 2.00 |

⚠ **緑の回も 2.04 で、2.00 ではなかった** ── つまり**緑の側も間違った値を読んでいた**。
🔑 「赤い回だけおかしい」ではなく「**全部おかしくて、たまたま許容に入る回があった**」。
⚠ だから **1 回の緑を「直った」と読んではいけない**(この件では 4 回中 1 回赤という
出方をして、原因が 5 回目まで分からなかった)。

🔑 **直し:見たい物だけを読む器を、その場で 1 つ作る。**

```ts
const probe = document.createElement('audio');
probe.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/webm' }));
const duration = await new Promise<number>((res) => {
  probe.onloadedmetadata = (): void => res(probe.duration);
  probe.onerror = (): void => res(Number.NaN);
  setTimeout(() => res(Number.NaN), 5000);
});
```

⚠ 見たいのは「**作った file が頼んだ長さか**」であって、
**画面の器の読み込み具合**ではない ── 2 つを混ぜると、製品の欠陥と
計器の途中経過が同じ 1 つの数字になる(§「計器の名前が範囲より広い」の音版)。
🔑 画面の器の値も**捨てずに併記する**(`screenDuration`)── 次に同じ形で
外したとき、**2 つ並んでいれば 1 回で分かる**。

### ⚠ そして **`decodeAudioData` は端の札を見ない**

同じ file を復号すると、`CodecDelay` を引かない**生の長さ**が返る
(実測 2.16 / 2.13)。🔑 だから **長さは `<audio>.duration`、音が入っているかは復号**、
と**計器を分ける** ── 片方で両方を測ろうとすると、必ずどちらかで嘘になる。

## 🔴 `expect.poll` は「最初の一読で当たれば通る」(2026-08-27)

遷移(`transition`)のある値を `expect.poll` で読むと、**変わり始めの値をそのまま採る**。

実例(#486):畳みの印を `opacity 0 → 1` の 0.12 秒で出す形にしたところ、

- 素の 1 読み(`expect(await opacity()).toBe(1)`)は **必ず落ちる**(途中の 0.0x を読む)
- `expect.poll` に変えたら通った ── ⚠ **だが「畳んでいる間は出す」門を外す変異が
  生き延びた**(SURVIVED)。薄れ始めの `1` を採って通っていたから
- ⚠ **時間で待つ**(`waitForTimeout(300)`)のも同じ穴 ── 「たぶん終わった」でしかない

🔑 **対照群で「遷移が走り切った」を観測してから読む。**

```ts
// ⚠ 逃げ先は「畳んでいない側」── そちらが濃くなった時点で、
//    pointer は離れ、遷移は走り切った、が**観測できている**
await mark1.hover();
await expect.poll(() => barPx(mark1)).toBeGreaterThan(thin);
expect(await barPx(mark2)).toBe(...);   // ← ここで初めて読む
```

⚠ **逃げ先の選び方に注意** ── 畳んだ側の配下は `hidden` になるので、
**そこに在る要素へは hover できない**(1 稿目はそれで詰まった)。

## 🔴 診断は「書いただけ」では効いているか分からない(2026-08-27、#489)

落ちた回に状態を添える診断を足したら、**わざと落として字を読む**まで済んでいない。

```bash
# 実装の分岐を強制して、診断が本当に出るかを見る
python3 -c "...期待する分岐を必ず通す変異..."
npm run build && npm run test:smoke -- <spec>   # → 失敗メッセージを目で読む
```

実例:「添付は作るが本文へ書かない」分岐を強制したら

```
待つ前:       添付 0 件 / 参照 0 件 / 状態「」
待ち切った後: 添付 1 件 / 参照 0 件 / 状態「…本文には入れていません」
```

🔑 **`添付 0 → 1` で「段が割れる」ことが確認できた** ── 読まずに配っていたら、
次の赤で「結局なにも分からない」を繰り返していた。

⚠ **待つ assert では「待つ前」と「待ち切った後」の 2 つを採る** ──
待つ前の状態は**5 秒前の姿**でしかなく、**遅れて届いた回と永久に届かない回が
同じ字**になる。差そのものが手掛かりである。
⚠ 元の失敗は `cause` で残す(診断で**置き換えない**)。

## 🔴 **per-test の timeout より長い `{ timeout }` は、使い切れない**(2026-09-16、#682 段④c)

`playwright.config.ts` の per-test は **30 秒**である。ところが長い筋書きの中に
**`{ timeout: 60_000 }` を 2 か所**書いてあった ── 🔴 **その 60 秒には
原理的に到達しない**(先に test ごと落ちる)。

⚠ 落ち方は「**待ちが足りないように見える**」形になるので、読み手は
**待ちを伸ばす方向へ直しにいく**(そして直らない)。実際この日も
「60 秒待って返らなかった」ではなく「**30.2 秒で test 時間切れ**」だった。

🔑 **中の `{ timeout }` を伸ばす前に、その test の持ち時間を見る。**
足りないなら `test.setTimeout(…)` を**その test の頭に**置く
(同じ file の別の test が既にそうしている、が探す手がかりになる)。

## 🔴 `setInputFiles` を**続けて撃たない** ── 後の 1 件が黙って消える(2026-09-16、#682 段④c)

添付を 3 件、待たずに続けて渡したら **3 件目だけ添付にならなかった**
(左の一覧は 2 件、状態の行は 2 件目の名前。**page error は 0 件**)。

⚠ 受け口(`binder.ts`)は `el.files` を読んだ直後に **`el.value = ''`** で空にし、
その先の `attachFiles` は**非同期**である ── つまり
**飛んでいる取り込みと次の `setInputFiles` が重なると、片方が落ちる**。

🔑 **1 件ずつ、取り込めたことを観測してから次を渡す**:

```ts
await page.setInputFiles('[data-pkc-field="attach-input"]', { name: 'a.xlsx', ... });
await expect(sidebar, 'a.xlsx が添付として取り込まれていない').toContainText('a.xlsx');
await page.setInputFiles('[data-pkc-field="attach-input"]', { name: 'b.parquet', ... });
await expect(sidebar, 'b.parquet が添付として取り込まれていない').toContainText('b.parquet');
```

⚠ **待ちを伸ばして直そうとしない** ── 消えた 1 件は**永久に来ない**ので、
どれだけ待っても同じである(この日は 25 秒 retry してから落ちた)。
⚠ 同じ形は **1 つの `<input>` を使い回す口**全部に在る(取り込み・設定の読み込み)。

## 🔴 **自分で字を打つと、画面の案内が嘘でも通る**(2026-09-16、#682 段④c)

`.parquet` を引く筋書きで `page.fill(…, 'SELECT * FROM parquet …')` と**手で打って**
いたら、**画面の手本が `FROM csv …`(打つと英語で断られる字)のまま**でも緑だった。

🔑 **画面に出ている手本を読んで、それを走らせる**:

```ts
const example = (await page.locator('[data-pkc-field="sql-example"]').textContent()) ?? '';
expect(example, '手本がいまの相手の名前で書かれていない').toContain('FROM parquet');
await page.fill('[data-pkc-field="sql-input"]', example.replace(/^例:\s*/u, ''));
```

⚠ 一般形:**「画面がこう言っている」と「そのとおりにすると動く」は別の主張**である。
手で打つ smoke は後者しか見ていない ── **前者が嘘になった日に、誰も鳴らない**。

## 書くときの約束

- `tests/smoke/helpers.ts` を使う: `gotoApp` / `createEntry` / `clickReal` /
  `collectPageErrors` / `expectReachable` / `expectImageRendered`。
  `clickReal` は `elementFromPoint` で「その座標で実際に見えて最前面にある」ことを
  確かめてから実マウスで押す ── **dead click / occlusion の検出力はここに在る**。
  ⚠ `clickReal` は再描画で node が差し替わる競合を 3 回まで retry するが、
  **「見えている位置に本当に在るか」の検証は毎回やる**(検出力は下げていない)
- **spec の最後に `expect(errors, errors.join('\n')).toEqual([])`**
  (pageerror / console.error 0 件)
  - 🔴 **囲み(html / svg)を打鍵で入れない ── `fill` で一度に入れる**
    (#561、2026-08-29)。分割編集の下書きは**打鍵の途中でも描かれる**ので、
    `width="9` まで打って手が止まると、**閉じていない属性のまま**箱(`srcdoc`)へ届き、
    ブラウザが `console.error` を出す ── 上の `toEqual([])` が**製品と無関係に**落ちる。
    ⚠ **間欠にしか見えない**(打鍵の速さは環境で変わる)。
    ⚠ 直すのは**入れ方**であって検査ではない ── 名指しで外すと、
    「箱の中で本当に絵が壊れた」をもう見られなくなる
  - 🔑 **赤には出所が付く**(`consoleOrigin`)── ` @ about:srcdoc` なら**箱の中**、
    ` @ /assets/….js:118` なら**アプリ本体**である。⚠ `page.on('console')` は
    **子 frame の分も上がる**ので、これが無いと 2 つが同じ顔になる
- `emulateMedia` / `setViewportSize` を触る spec は**独立の spec file にする** ──
  他の spec の assert を汚す
- **PR gate の総量を増やさない**(user 指示 2026-07-30「CI を長くしない」)。
  重い検証は nightly へ

## 🔴 flake に見えるものが製品の穴だったことがある

2026-08-07、`external-images` の smoke が CI で落ちた。手元でも CI と同じバイナリで
**3 回に 1 回**再現した ── 原因は test ではなく**製品**だった:箱(iframe)の
CSP 違反の見張りが **user の中身より後ろ**に登録されていたので、解析中に画像を要求する
中身では違反を取り逃していた。帯が出なければ**その箱の画像は二度と同意できない**。

規律:
1. **単独で 3〜5 回**回す(`npx playwright test … <grep>`)
2. **CI のバイナリで**回す
3. 再現したら、**test を緩める前にアプリ側を疑う**
4. 直したら、**確定的に鳴る unit** を足す ── smoke は確率的にしか落ちない。
   ⚠ ただし「字面の位置」で pin すると、位置を保ったまま挙動を壊す変異
   (`DOMContentLoaded` で包む等)が生き延びる ── **実行して観測する**

## 落ちたときの読み方

1. **単独で再現するか**(3〜5 回)── 単独で緑・全量で赤なら、状態の持ち越しか
   再描画の競合を疑う
2. **CI のバイナリで再現するか**
3. 再現したら上の節へ ── **test を緩める前にアプリ側を疑う**

## 🔴 **押した結果その面が閉じる**ボタンは、click の ack が返らない(2026-08-22)

`× 閉じる` がアプリの窓を**窓ごと閉じる**ようになった(#300 段③)ので、
`clickReal(win, …)` が `mouse.click: Target page, context or browser has been closed`
で落ちることがある ── **押せなかったのではなく、押せた結果**である。

⚠ **手元は緑・CI は赤**だった:手元はフル chromium、PR gate は
`chromium_headless_shell`(§ CI と手元で別のブラウザ)。タイミングだけの差なので、
**手元で 1 回通しても再現しない**。

🔑 書き方は 2 つ。**どちらも「握り潰さない」のが肝**である:

```ts
// (a) 閉じる系だけ許す ── 押せた証拠は「閉じたこと」で見る
await clickReal(win, '[data-pkc-action="close-pane"]').catch((e: unknown) => {
  if (!String(e).includes('closed')) throw e;   // ボタンが無い等はそのまま投げる
});
await expect.poll(() => win.isClosed(), { timeout: 10_000 }).toBe(true);

// (b) そもそも閉じない道で離れる ── 別の主張を見たいときはこちら
await win.keyboard.press('Alt+1');              // 本文の面へ(窓は残る)
```

⚠ `.catch(() => {})` と**書かない** ── ボタンが消えた日に「押せた」と読む。
⚠ (b) を使うのは「窓が閉じること」以外を見たいときだけ ── 窓を閉じる主張は
(a) でしか見られない。

⚠ **同じ罠を 1 セッションで 2 度踏んだ** ── 1 度目は
`app-window-status.smoke.spec.ts` を書いていて `session closed` で落ち、
帰り道を `Alt+1` に変えて避けた(= (b))。2 度目は `launcher.smoke.spec.ts` が
**CI でだけ**落ちた。🔑 **「押すと消えるもの」を押す test を書いたら、この節へ戻る。**


## 🔴 `page.goto('/#…')` は「入り直し」ではない ── 同じ path なら読み直しは起きない

(2026-09-04、#689 の着地前レビューが実測)

断片だけが違う URL へ `goto` しても、**path が同じなら同一文書内の断片移動**である。

| 書いたつもり | 実際に走るもの |
|---|---|
| 「その URL の窓として**入り直す**」 | `hashchange` → 購読しているコードだけ |
| 直後の `data-pkc-boot="ready"` 待ち | **前の `goto` の時点で既に attach 済み** = どんな実装でも通る(空振り) |

🔑 **起動時の経路を見たいなら `page.reload()` を使う**(または別 path から入る)。
⚠ そして**コメントが嘘になる**のが本当の害である ── 次に読む人は
「起動時の経路はここで見ている」と信じて、二重に検査を足さない。

⚠ 併せて疑う:`gotoApp(page)` の後に `page.goto(<同じ origin の断片違い>)` を
書いた spec は、全部この形である。


## 🔴 `setRangeText` は `Ctrl`+`Z` の履歴を切る(2026-09-07、#765)

repo のコメントは長らく「**`value` 直代入は Ctrl+Z の履歴を捨てる**」と書いており、
`setRangeText` は安全に読めた。⚠ **実測すると同じだった**:

| 押した回数 | 欄の字(`> ひきよう` で `Enter` を押した後) |
|---|---|
| 1〜3 | 打った字が 1 文字ずつ戻る |
| **4〜8** | 🔴 **`> ひきよう\n> ` から 1 文字も戻らない** |

🔑 **undo に載せたいなら `insertText`**(`src/adapter/ui/render/row-swap.ts` ──
中身は `document.execCommand('insertText')`)。範囲を消す / 置き換えるときは
**先に `setSelectionRange` で選んでから**撃つ(空文字の `insertText` は選択を消し、
取り消しにも載る ── これも実測)。

🔴 **この差は unit では原理的に見えない**:
- happy-dom に**取り消しの履歴が無い**
- `execCommand` も無いので、unit は**必ず fallback を通る**(CLAUDE.md §2)

⚠ だから「取り消せます」と**お知らせやマニュアルで約束する**なら、
**smoke で押して確かめる**。押す回数は固定しない ── 粒度はブラウザが決める:

```ts
const seen: string[] = [];
for (let i = 0; i < 8; i += 1) {
  await page.keyboard.press('Control+z');
  seen.push(await ta.inputValue());
}
expect(seen, `取り消しで打った字へ戻れない: ${JSON.stringify(seen)}`).toContain('打った字');
```

## 🔴 「押し方」を変えたら、spec の押しを**数え方 2 通り**で数える(2026-09-13、#857 段①b-1)

⚠ タイルを「1 回で開く」→「2 回で開く」へ変えた日に、**直し漏れを 3 か所出した**。
しかも私は commit 本文に「**実ブラウザは 6 か所が 1 回で開く前提だったので直した**」と
書いていた ── **回さずに書いた数字**である。

🔑 原因は 1 つ:**grep がセレクタの字面しか見ていなかった**。

| spec の中の押し方 | 私の grep に当たったか |
|---|---|
| `clickReal(page, '[data-pkc-tile-kind="url"]')` | 🟢 当たる(セレクタが字で在る) |
| `await clickReal(page, builtinTile('dual'))` | 🟢 当たる |
| 🔴 **`const tile = page.locator(USER_TILES); … await tile.click()`** | ❌ **当たらない** |

⚠ 3 か所目は**変数に入れてから押している**ので、押している行にセレクタの字が 1 つも無い。
⚠ そして `page.locator(...)` と `.click()` は**離れた行**に在るので、1 行の grep では繋がらない。

🔑 **だから 2 通りで数える**(どちらか片方では必ず落とす):

```bash
# ① セレクタの字で押しているもの
grep -n "clickReal(page, .*tile\|clickReal(page, builtinTile" tests/smoke/*.spec.ts
# ② 🔴 変数に入れてから押しているもの ── `.click()` を全部出して、
#    その変数が何を指しているかを目で追う(行だけでは決まらない)
grep -n "\.click()" tests/smoke/<触った>.smoke.spec.ts
```

⚠ **②は件数が多い**(この file は 14 件)が、**多いことが理由で飛ばすと今回になる**。

🔴 **そして「一覧に出ていた」と「見た」は別である**(同じ日に**2 度目**を踏んだ)。
⚠ 1 度目の直しのとき、②の一覧には `await after.click()` が**ちゃんと出ていた** ──
私はそれを見たうえで、**変数の名前(`after`)から中身を推し量って飛ばした**。
🔑 だから手順は「一覧を出す」で終わらせない:**出た `.click()` の変数を 1 つずつ
定義まで辿る**(`grep -n "const <名前> ="`)。⚠ **名前では決まらない** ──
`tile` / `after` / `dualIcon` はどれも同じ面の物を指しうる。

🔑 そして**いちばん確かな数え方は「回すこと」**である ── 押し方を変えたら、
**直した数を書く前に**範囲を切った smoke を 1 回通す。
⚠ 「N か所直した」は**観測点の無い過去形**なので、CLAUDE.md の
「済んだと書くときは観測点を 1 つ挙げる」に当たる ── 挙げられないなら
**「直します」と未来形で書く**(未来形は嘘にならない)。

## 🔴 **確認の小窓を足したら、その押し所を押している smoke を同じ commit で直す**(2026-09-13、#857 段③)

⚠ 1 つ上は「**押し方**を変えた」話だが、こちらは「**押した後に段を 1 つ足した**」話である。
害はこちらのほうが静かで、**2 時間ほど誰も気づかなかった**。

何をしたか:「すべて名前順に戻す」に**押す前に聞く小窓**を足した(`confirmResetAppGroupOrder`)。
⚠ spec は押した直後に並びを見ていたので、**小窓が出たまま止まって必ず落ちる** ──
実測 **20 回中 20 回**。

🔴 **鳴る計器が 1 つも無かった**:

| 計器 | なぜ鳴らないか |
|---|---|
| `npm test`(unit) | 小窓は `main.ts` の service なので、reducer の test には出ない |
| typecheck / lint | 型は合っている(service の形は変えていない) |
| 🔴 **CI** | **全量 smoke を回さない**(user 指示 2026-09-11)── PR gate に smoke が無い |
| 投げた smoke エージェント | **worktree が小窓を足す前の版**だった(下の「⚠ 版ずれ」) |

🔑 **だから手順にする(思い出すのではなく、機械的に)**:

```bash
# 小窓を出す service を足した / 変えたら、その押し所の名前で smoke を数える
grep -rn 'data-pkc-action="<足した押し所>"' tests/smoke/*.spec.ts
```

出た **1 件ごとに**、その `clickReal(...)` の**直後**に `answerAppDialog(page, …)` が
在るかを見る。⚠ **同じ test の別の場所に在るのでは足りない**
(`launcher.smoke.spec.ts` は同じ test の 30 行上で 2 回呼んでいたので、
「`answerAppDialog` が在るか」だけの grep では**素通りする**)。

🔑 そして**ただ答えさせるだけにしない ── 何が出たかを assert する**:

```ts
const ask = await answerAppDialog(page, 'cancel');
expect(ask, '確認が「まとめて」効くことを言っていない').toContain('まとめて');
```

⚠ 小窓を**黙って閉じるだけ**の spec は、次に文面を変えた人を 1 ミリも止めない。
🔑 **やめた側も見る**(「やめたのに変わってしまった」)── 押した後の段が 2 つに割れたのだから、
**検査も 2 つに割れていなければ動線を覆えていない**。

⚠ **起動は増やさない** ── 既に在る道中に assert を足すだけで足りる(`smoke-budget` の規律)。

### ⚠ この件が 2 時間も見つからなかった理由の半分は**版ずれ**である

最初に調べたエージェントは、**小窓を足す前の版**で測っていた。だから
① 当の spec が落ちることに気づかず ② その後の「レースが再現しない」も**別の版の話**になった。
🔑 手順は `.claude/skills/subagent-scale/SKILL.md` の
「**worktree の HEAD が branch の先端より古いことがある**」に在る(ここには書かない)。
🔑 こちら側で足すのは 1 つだけ:**返ってきた報告に、どの sha で測ったかが
書いてあるか**を必ず見る ── 書いていない数字は、**どの版の話か決まらない**ので使えない。
