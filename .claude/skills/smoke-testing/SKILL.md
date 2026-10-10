---
name: smoke-testing
description: PKC3 の実ブラウザ検証(tests/smoke、Playwright)を書く・直す・回す手順。視覚や実 DOM 挙動を持つ変更を入れるとき、smoke が CI だけで落ちるとき、観測点の置き方に迷うときに使う。「smoke」「実ブラウザ」「Playwright」「CI だけ落ちる」「視覚テスト」という文脈で必ず使う。
---

# 実ブラウザ検証(PKC3 smoke)

`vitest` / `happy-dom` の pass は**生成の正しさ**しか示さない。画面に本当にそう出るかは
実ブラウザでしか分からない ── そのための最小の lane が `tests/smoke` である。

> この file は**手順と判断の表**。事故の記録(日付・issue つき)は `reference/` の 3 本に在る ──
> [`incidents.md`](reference/incidents.md)(並走・負荷・落ち方)/
> [`observation.md`](reference/observation.md)(観測点の置き方)/
> [`spec-edits.md`](reference/spec-edits.md)(spec を足す・直すときの数え上げ)。

```bash
# 🟢 既定はこちら ── **触った物から引く**(#820)。読めない物が 1 件でも
#    混じったら自分でフルへ倒れる(表に無い file / CSS / smoke の土台 / src の外)
npm run smoke:pick

# 🟢 引く先が分かっているなら直に ── **触った spec だけ**(4〜20 秒)
npm run test:smoke -- tests/smoke/<触った>.smoke.spec.ts

# 🔴 全量(spec 数は tests/repo-hygiene.test.ts が pin)。**着地の直前に 1 回だけ**。
#    `workers: 2`(playwright.config.ts ── 4 は箱に多すぎた)で手元 約 8〜13 分(箱の負荷で動く)
npm run test:smoke
```

⚠ smoke は `vite preview` で `dist/` を配信する。source を直しただけでは検査対象に**届かない** ──
必ず `npm run build` を挟む。

## 1. 誰がいつ回すか

規律の正本は CLAUDE.md。ここは**どう押すか**だけを書く。

- 全量の smoke は**押したときだけ**回る(CI の自動起動は無い): CLAUDE.md「test は使い所を選ぶ」の
  2026-09-09 追記・2026-09-11 追記(user 指示)。経緯は
  [incidents.md](reference/incidents.md)「CI の全量を『押したときだけ』にした経緯」
- 既定の回し方(単体は自分 / 範囲を切った smoke は `pkc3-smoker` / 全量は自分が押す)と
  「UI 導線を全量 smoke で誤魔化さない」: CLAUDE.md「既定の回し方」(user 指示 2026-09-11)
- フルを乱発しない・フルは 1 PR に 1 回・測って閉じると言えるなら名指しでよい:
  CLAUDE.md「test は使い所を選ぶ」(user 指示 2026-08-19 / 2026-09-09 / 2026-09-12)

| 回す場所 | 引き金 | 中身 |
|---|---|---|
| **PR gate**(`ci.yml`) | push / PR で自動 | 型 / lint / unit / build / 検品 ── **smoke は 0 件** |
| 🔴 **`Smoke (手動)`**(`smoke.yml`) | **Run workflow を押したときだけ** | 全量・3 shard。入力で `browser: both`(2 つのブラウザを突き合わせる唯一の場)/ `kind: product` |
| **`Nightly`**(`nightly.yml`) | 夜 18:00 UTC / 手動 | 🔴 **全量 smoke は無い** ── product の焼きと検品 / Rust wasm の等価性 / probe |

⚠ `on:` に `push` / `pull_request` / **`schedule`** を足すと
`tests/workflow-steps.test.ts` が全数走査で落とす(**file 名ではなく引き金**を見る)。

| 誰が | 何を |
|---|---|
| **自分** | 単体 / typecheck / lint / build / 変異試験 |
| 🔴 **`pkc3-smoker`**(**worktree 隔離**) | 名指しした spec だけの実ブラウザ smoke |
| **自分が押す** | 全量 ── **着地の直前の 1 回**だけ |

⚠ 隔離が要る理由は 1 つ:**`npm run build` が `dist/` を書き換える**ので、依頼者のツリーで
並走させると**検査対象が入れ替わる**。

### 頼み方は「spec 名」ではなく「動線」で書く

> ❌「`layout.smoke.spec.ts` を回して」
> ✅「**ノートを開く → 帯の『編集』を押す → 打つ → 『保存』を押す**、が素通りするか。
>    それを通る spec を引いて、**引いた理由**と**引かなかったが迷った物**を返して」

⚠ 返ってきた報告に「**迷って落とした物**」が 1 件も無ければ、範囲を考えていない合図。
🔑 動線そのものの良し悪しは `pkc3-ux-reviewer`(read-only)── **対で回す**。
全量が緑でも、新しい動線に検査が無ければ緑である(実例:
[incidents.md](reference/incidents.md)「全量が緑でも、新しく作った動線に検査が 1 つも無かった」)。

## 2. 触る範囲を決める ── 引く・数える・作り直す(#820)

⚠ **`--only-changed` は使えない。** playwright のそれは **spec の import グラフ**を
追うが、smoke は `dist/` を配って動くので **spec と `src` の間に辺が無い** ──
実測で `src` を 1 file 触ると **0 本**しか選ばれない(spec を触れば 11 本)。
🔴 **製品を直したときだけ何も走らない**、という最悪の外し方である。

**① 引く** ── `npm run smoke:pick`

```bash
node scripts/pick-smoke.mjs              # 引いた spec の名前を出すだけ
node scripts/pick-smoke.mjs --run        # そのまま走らせる(= npm run smoke:pick)
node scripts/pick-smoke.mjs src/a.ts     # file を直に渡す
```

表は `tests/smoke/smoke-map.json`(**どの spec がどの `src` を動かしたか**)。
⚠ **迷ったらフルへ倒れる**のが仕様である ── 倒れ損なう向きだけが本当の欠陥なので、
`tests/pick-smoke.test.ts` はそちらだけを厚く見ている。
⚠ **表が言えるのは「あの日の版で動かした」だけ** ── 「これから動かしうる」は言えない
(TIA の定石)。だから**着地の 1 回はフルのまま**にする。

**② 数える** ── `npm run smoke:budget`

所要はほぼ**起動の数**で決まる(実測 **1 起動 ≒ 1.63 秒**、`workers: 1` のとき)。
⚠ assert を 1 つ足すのはほぼ 0 秒、起動を 1 つ足すと**以後すべての回に積まれる**。
🔑 だから **新しく起動する test を足すのではなく、既に在る道中に assert を足す**。
上限は `scripts/smoke-budget.mjs` の `BOOT_BUDGET`(`tests/smoke-budget.test.ts` が pin)。
⚠ **上げてよい。ただし理由を 1 行書く** ── 黙って上げると、何も守らない数字になる。

**③ 作り直す** ── `smoke-map.yml` を押す(#993)か、手元で `npm run smoke:record && npm run smoke:map`

🟢 Actions の `smoke-map.yml`(`workflow_dispatch` のみ)が同じ 3 手を CI で回して表を commit する。
`pick-smoke` が「表に無い割合」を言ったら押す(2026-10-02 の作り直しで 19.7% → 2.5%)。

```bash
npm run build                 # ⚠ smoke は dist を配る
npm run smoke:record          # PKC3_SMOKE_COVERAGE=1 で全量(記録つき)
npm run smoke:map             # coverage-smoke/ → tests/smoke/smoke-map.json
```

⚠ **記録は既定では取らない**(取ること自体が遅くする)。表が古くなると引く側が
「表に無い」でフルへ倒れる ── 安全側だが、**規律が道具の側で成立しなくなる**
(2026-09-16 に 7 日で 19.7% が漏れていた)。鳴る条件は `tests/pick-smoke.test.ts`。

**フルを回してよい「ここぞ」は 3 つだけ**:

1. **共有面**を触った(boot / renderer / storage / CSS / shell)── どの spec に効くか読めない
2. **CI のフルが落ちた**ので手元で再現したい(手で押した `Smoke (手動)`)
3. **着地直前の最後の 1 回**

🔑 **いちばん効くのは「push をまとめる」**(push 1 回 = 検品 1 回)。
⚠ 変異試験の smoke は、その変異が殺されるはずの **1 spec に絞る**。コストは「実行回数」ではなく
**`build` + smoke の対の回数**で数える。

## 3. 並走・負荷の規則

| やってはいけない | 症状 | 規則 | 実例 |
|---|---|---|---|
| smoke が**走っている最中に `npm run build`** | `gotoApp` が落ち、アプリの赤に見える | 背景で smoke 中は build しない(`npm test` / `tsc` / lint / 変異試験の vitest は `dist` を触らないので安全)。回す前に「いま `dist` を触る仕事が動いていないか」を 1 度見る。その回は**判定不能**(結果を読まない)。落ちた log は再実行の前に控える | incidents「走っている最中に build した」 |
| smoke を**同時に 2 本** | `ERR_CONNECTION_REFUSED`(製品の不具合と同じ顔) | 1 本ずつ。背景の完了通知を待ってから次を起動(`sleep` でポーリングしない) | incidents「同時に 2 本走らせた」 |
| **他の worktree と同じ port** | 他人の `dist` を相手に緑も赤も出る / `EADDRINUSE` | 下の port の規則 | incidents「他人の `vite preview` を黙って使い回した」「並行に回すときにポートを分けなかった」 |
| 重い作業(build / 全量 unit / 別の smoke)と**並べてフル** | 負荷でだけ 2〜3 件落ちる | 重い物は**同時に 1 つ**(エージェントの数ではなく重い物の数)。落ちたら**結果を読む前に単独で回し直す**。緑なら「負荷で出た」と記録して**捨てない**。同じ runner に SendMessage で「落ちた spec だけ単独で」を足す | incidents「port を分けても、CPU は分けられない」 |

port の規則(並行に回す・変異試験で回す):

```bash
PKC3_SMOKE_PORT=<他と被らない番号> CI=1 npx playwright test -c tests/smoke/playwright.config.ts <spec>
```

- `CI=1` は、既に上がっている preview を**使い回させない**ため
- `PKC3_SMOKE_PORT` / `PKC3_PLAIN_PORT` / `PKC3_SUBPATH_PORT` の **3 つを agent ごとに固有**にし、
  **10 刻み**(4825x / 4826x …)で帯ごと渡す(config は `PORT + 1` / `PORT + 2` も握る)。
  投げる相手にも番号を指定して渡す(任せると既定に戻る)
- 回す前に `ss -ltnp | grep <port>` で自分以外が listen していないことを 1 行見る。他人の preview は止めない
- 同じ port を続けて使うと `EADDRINUSE`(`TIME_WAIT`)── 落ちた log に `EADDRINUSE` が**無い**ことを見てから赤緑を書く
- 検算:**build した直後に、dist に在るはずの字が画面に出るか**を最初の 1 assert にする

## 4. ブラウザが 2 つある

`tests/smoke/playwright.config.ts` は同梱の `/opt/pw-browsers/chromium`(フル Chromium)を
優先し、無ければ playwright 既定に落ちる ── **CI は後者 = `chromium_headless_shell`**。
この 2 つは**実挙動が違う**。

```bash
# CI と同じバイナリで回す
PKC3_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  npx playwright test --config tests/smoke/playwright.config.ts <grep>
```

| 事象 | `chromium` | `chromium_headless_shell` |
|---|---|---|
| `window.print()` | `beforeprint` のみ | **`beforeprint` + `afterprint` を同期発火** |
| CSP が止めた要求の `request` イベント | 5 秒待っても来ないことがある | assert より先に来る |
| 非 ASCII の `<a download>` 名 | — | **丸ごと捨てて `"download"` にする** |

🔴 **実ブラウザ依存の挙動に触れる spec は、両方のバイナリで通してから push する。**
「CI だけで落ちる」を環境のせいにして test 側だけ緩めない(実例:
[incidents.md](reference/incidents.md)「環境差の調査が本物のバグを見つけた」)。

## 5. spec を書く・直すときの合図

「unit で届く物は unit に置く」。**unit が原理的に届かない層**は smoke でしか守れない:

| happy-dom に**無い**もの | 帰結(その経路を unit は 1 度も実行しない) |
|---|---|
| `document.execCommand` | `insertText` 系は**必ず fallback を通る** ── 本命の経路も、fallback との**意味論の差**も unit からは見えない(#250) |
| `ClipboardEvent` / `DragEvent` の実体 | fake を渡すので「こちらが渡した形」しか試していない |
| `caretPositionFromPoint` | 座標 → caret(ライブエディタの行選択) |
| 実 IME の composition | 確定の `input` が `isComposing: true` で来る等 |
| 実 BroadcastChannel / Web Locks / OPFS | 多重タブの合成(#177 / #253) |
| ブラウザの取り消し履歴(`Ctrl+Z`) | 「取り消せます」と**約束したのに誰も見ていない**状態になりやすい(#250) |

🔑 **user に約束した文(マニュアル・お知らせ)を、この表に照らす。**
「取り消せます」「順番どおり入ります」は unit では書けない ── そこが smoke の出番である。

次の**合図**が出たら、書く前に該当の節を開く(実例と数え落とした grep は
[spec-edits.md](reference/spec-edits.md)):

| 合図 | 手順(要点) | spec-edits の節 |
|---|---|---|
| 要素・属性の**器を替えた** | 消える属性(`x1` / `x2` / `points` / `value` / `textContent` / `innerText`)を **`tests/smoke` も範囲に入れて** grep で数える。読み方を 1 か所の小関数へ寄せる。tsc も unit も CI も鳴らない | 器を替えたら、smoke の読み手を grep で数える |
| **押し口を足した** | 同じ区画の既存の押し口がどこまで押されているかを読み、揃える。壊れる口(作り直す / 捨てる)は最後まで押さず「押しただけでは何も起きない」「やめるで戻る」を見る。並びは `.nth(0)` / `.nth(1)` を**画面の字**(`toHaveText`)で見る(件数だけでは並べ替えで落ちない) | 押し口を足したら、「押す」検査まで足す |
| **座標・余白を押す**検査 | 押す前に前提を assert する(下の snippet)。器の高さを `boundingBox()` で 1 度測る | unit の click は「その場所が実在するか」を確かめない |
| 動作が**配線の両端**にまたがる | まず unit の側を直す(封筒を組む口を 1 か所に / 本物どうしを繋ぐ unit を 1 本 / stub は判定ごと写す)。smoke は「user の画面に出たか」 | 両端をまたぐ配線は… |
| 台が毎回消している**前処理**(お知らせ / 同意 / 初回の案内)を触る | その状態を通る user(= 初回)が居るなら、**その 1 本を別 test に**し、前処理を外して状態を作り直す。前提(未読に戻せたこと)を先に確かめる | 台の「お約束の前処理」が、いちばん大事な 1 回を消していないか |
| **押し方を変えた**(1 回 → 2 回 など) | spec の押しを**数え方 2 通り**で数える:①セレクタの字 ②変数に入れてから `.click()`(変数を 1 つずつ定義まで辿る。名前で決めない)。**直した数を書く前に、範囲を切った smoke を 1 回通す** | 「押し方」を変えたら、spec の押しを数え方 2 通りで数える |
| 押した後に**確認の小窓**を足した | `grep -rn 'data-pkc-action="<足した押し所>"' tests/smoke/*.spec.ts` で数え、**1 件ごと**に `clickReal` の直後に `answerAppDialog` が在るかを見る。ただ答えず**何が出たかを assert**。やめた側も見る。起動は増やさない | 確認の小窓を足したら、その押し所を押している smoke を同じ commit で直す |
| 返ってきた報告の **sha** | どの sha で測ったかが書いてない数字は使えない(worktree の版ずれ。手順は `subagent-scale`) | 同上「版ずれ」 |

```ts
// ⚠ 「何も無い所」を押すつもりなら、そこが本当に何も無いことを**その場で**確かめる
const under = await page.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x as number, y as number);
  return el?.closest('[data-pkc-action]') === null ? 'blank' : 'action';
}, [x, y]);
expect(under, '押そうとした所に押し所が在る(前提が崩れている)').toBe('blank');
```

## 6. 観測点の選び方

主張が違えば観測点も違う。実例(数値・コード・変異で殺した記録)は
[observation.md](reference/observation.md)。

| 見たい物 | 観測点 | 避ける物 | observation の節 |
|---|---|---|---|
| 印刷 | `beforeprint`(印刷が始まる瞬間)。`afterprint` で消える作りなら消える前に測る。規則は `setViewportSize(794×1123)` でも見る(`emulateMedia` だけでは幅が変わらない) | 「押した直後」 | 環境差に強い側へ寄せる / 印刷は版面が紙の幅になる |
| 通信を「止めた」 | アプリ自身の信号(確認の帯が出た)+ 応答が返らないこと。「試行が起きない」を主張するなら `request` | `request` / `requestfailed` の到着時期 | ネットワークの event を… |
| 2 つの面の一致 | 各観測点に「直す前はこうだった」(bare)を書き、片方が bare でないことを先に見る | 両面とも壊れていても一致する比較 | 空振り防止は「素のままの値」で置く |
| 時間・競合でしか出ない | 配線(`Worker.prototype.postMessage` を包んだ**命令列**)。記録の前に配列を空にする。空振り防止に `toContain` | reload までの数百 ms に賭ける観測 | 時間に依存する観測点は… |
| 絵・状態が揃うこと | 「そのもの」を待つ(`waitForFunction(img.complete && naturalHeight > 0)` / `expect.poll` / `vi.waitFor`)。待ちきれないなら下の assert が落ちる形にする | `domcontentloaded` の直後 / 固定の `setTimeout` | `domcontentloaded` は絵を待たない… |
| 計算後の style | `getClientRects().length > 0`(箱が在る)と対にする | `display: none` でも残る `break-after` 等の単独 | 計算後の style だけを見ない |
| 疑似要素(`::after` / `::before`) | `display` / `content` / 画素。親の下線は**親**の `textDecorationLine` | 疑似要素の `text-decoration` の計算値 | `::after` / `::before` の… |
| 見た目の飾り | CSS の `::before` / `::after` の `content`。`th.textContent` が足す前と同じことを unit で見る | 飾りを字として足す(コピーに混ざる) | 飾りを字として足さない… |
| DOM の消滅 | 「消された枝の中に居たか」(`querySelectorAll` で数える)。`addInitScript` では `observe(document, …)` | `removedNodes` の直下だけを `matches` | DOM の消滅を見るなら… |
| 遷移のある値(opacity 等) | 対照群で「遷移が走り切った」を観測してから読む | `expect.poll` の最初の一読 / `waitForTimeout` | `expect.poll` は「最初の一読で…」 |
| 押す前後の見た目 | 測る前に `page.mouse.move(0, 0)` + 押していない兄弟と比べる | 押した後もマウスが上に居る(`:hover`) | 押す前と押した後で… |
| 追加した診断 | わざと落として字を読む。待つ assert は「待つ前」と「待ち切った後」の 2 つを採る | 書いただけ | 診断は「書いただけ」では… |
| 画面の案内 | 画面に出ている手本を**読んで、それを走らせる** | 手で打った字 | 自分で字を打つと… |
| 取り消し(`Ctrl+Z`) | `insertText` に載せる。押す回数は固定せず 8 回押して履歴に「打った字」が出ることを見る | `value` 直代入 / `setRangeText`(履歴を切る) | `setRangeText` は… |
| `<audio>.duration` | 見たい物だけを読む器をその場で作る(`onloadedmetadata`)。画面の器の値も併記。長さは `<audio>`、音は `decodeAudioData` | `readyState >= 1` の画面の器 | 鳴らしている `<audio>` の… |
| canvas しか無い相手(LO wasm) | 絵の hash を**集合**で(間隔をあけて 4 枚)+ 対照群を手順の先頭に + まず screenshot + `page.mouse.click`。観測点の生死は**窓ごと**に書く | 窓の枚数 / 絵 1 枚ずつの hash / `el.focus()` | canvas しか無い相手… |
| 目次・リンクの飛び先 | 中身を足した / 減らした面は sticky の下に入らないか実ブラウザで 1 度(`scroll-margin-top`) | happy-dom | 一覧を最後の節へ足すと… |

## 7. 書くときの約束

- `tests/smoke/helpers.ts` を使う: `gotoApp` / `createEntry` / `clickReal` /
  `collectPageErrors` / `expectReachable` / `expectImageRendered`。
  `clickReal` は `elementFromPoint` で「その座標で実際に見えて最前面にある」ことを
  確かめてから実マウスで押す ── **dead click / occlusion の検出力はここに在る**。
  ⚠ `clickReal` は再描画で node が差し替わる競合を 3 回まで retry するが、
  **「見えている位置に本当に在るか」の検証は毎回やる**(検出力は下げていない)
- **spec の最後に `expect(errors, errors.join('\n')).toEqual([])`**(pageerror / console.error 0 件)。
  実例は [incidents.md](reference/incidents.md)「`errors` が製品と無関係に落ちた」:
  - 囲み(html / svg)は打鍵で入れず `fill` で一度に入れる(途中の閉じていない属性で箱が `console.error` を出す)。
    直すのは**入れ方**であって検査ではない
  - SQL の面を触る spec は、DuckDB の worker の既知の 1 行を `tests/smoke/helpers.ts` の
    `KNOWN_CONSOLE_NOISE` の形で**等値で名指し**して外す(部分一致にしない。`consoleOrigin` を付ける**前**の素の行に当てる)
  - 赤には出所が付く(`consoleOrigin`)── ` @ about:srcdoc` は箱の中、` @ /assets/….js:118` はアプリ本体
- `emulateMedia` / `setViewportSize` を触る spec は**独立の spec file にする** ── 他の spec の assert を汚す
- 押すと**面が閉じる**ボタン(`× 閉じる` 等)を押す spec は、`clickReal(...).catch(e => { if (!String(e).includes('closed')) throw e; })`
  のあと `expect.poll(() => win.isClosed())` で見る(`.catch(() => {})` と書かない)。別の主張なら閉じない道で離れる。
  実例 → incidents「押した結果その面が閉じるボタンは…」
- 長い筋書きの中の `{ timeout }` は per-test(30 秒)より長くしても使い切れない ── 足りなければ
  `test.setTimeout(…)` を test の頭に置く(incidents「per-test の timeout より長い…」)
- `<input>` を使い回す口(`setInputFiles`)は、**1 件ずつ取り込めたことを観測してから**次を渡す(待ちを伸ばしても直らない)
- `page.goto('/#…')` は path が同じなら入り直しではない ── 起動時の経路を見たいなら `page.reload()`
- **PR gate の総量を増やさない**(CLAUDE.md「CI を長くしない」。user 指示 2026-07-30)。重い検証は押したときだけの口へ

## 8. 落ちたときの読み方 ── flake に見えるものが製品の穴だったことがある

1. **単独で 3〜5 回**回す(`npx playwright test … <grep>`)── 単独で緑・全量で赤なら、状態の持ち越しか再描画の競合
2. **CI のバイナリで**回す
3. 再現したら、**test を緩める前にアプリ側を疑う**
4. 直したら、**確定的に鳴る unit** を足す ── smoke は確率的にしか落ちない。
   ⚠ ただし「字面の位置」で pin すると、位置を保ったまま挙動を壊す変異
   (`DOMContentLoaded` で包む等)が生き延びる ── **実行して観測する**

実例(`external-images` が CI で 3 回に 1 回落ちた、原因は製品)→
[incidents.md](reference/incidents.md)「flake に見えたものが製品の穴だった」。
