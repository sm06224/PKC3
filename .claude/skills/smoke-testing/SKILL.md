---
name: smoke-testing
description: PKC3 の実ブラウザ検証(tests/smoke、Playwright)を書く・直す・回す手順。視覚や実 DOM 挙動を持つ変更を入れるとき、smoke が CI だけで落ちるとき、観測点の置き方に迷うときに使う。「smoke」「実ブラウザ」「Playwright」「CI だけ落ちる」「視覚テスト」という文脈で必ず使う。
---

# 実ブラウザ検証(PKC3 smoke)

`vitest` / `happy-dom` の pass は**生成の正しさ**しか示さない。画面に本当にそう出るかは
実ブラウザでしか分からない ── そのための最小の lane が `tests/smoke` である。

```bash
# 🟢 既定はこちら ── **触った spec だけ**(4〜20 秒)
npm run test:smoke -- tests/smoke/<触った>.smoke.spec.ts

# 🔴 全量(33 spec)。**ここぞ**のときだけ ── 手元でも CI でも 4〜6 分かかる
npm run test:smoke
```

⚠ **smoke は `vite preview` で `dist/` を配信する。** source を直しただけでは
検査対象に**届かない** ── 必ず `npm run build` を挟む。

## 🔴 フルを乱発しない(user 指示 2026-08-19)

> 「**フルスモークを乱発しないように / イタズラに時間とトークンを消費します /
> ここぞと言うときに使いましょう**」

実測(2026-08-19): 狙い撃ち 1〜3 spec = **4〜20 秒** / CI のフル = **4〜6 分**
(観測 3 回: 4m03s / 6m11s / 5m19s)。⚠ この日は同じ branch 系で **8 回 push した
= フルが 8 回回った**。多くは **1 spec しか触っていない**変更だった。

🔑 **いちばん効くのは「push をまとめる」** ── **push 1 回 = フル 1 回**である。
1 commit ごとに投げず、手元で緑にしてからまとめて 1 回にする。

**フルを回してよい「ここぞ」は 3 つだけ**:

1. **共有面**を触った(boot / renderer / storage / CSS / shell)── どの spec に効くか読めない
2. **CI のフルが落ちた**ので手元で再現したい
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

## 書くときの約束

- `tests/smoke/helpers.ts` を使う: `gotoApp` / `createEntry` / `clickReal` /
  `collectPageErrors` / `expectReachable` / `expectImageRendered`。
  `clickReal` は `elementFromPoint` で「その座標で実際に見えて最前面にある」ことを
  確かめてから実マウスで押す ── **dead click / occlusion の検出力はここに在る**。
  ⚠ `clickReal` は再描画で node が差し替わる競合を 3 回まで retry するが、
  **「見えている位置に本当に在るか」の検証は毎回やる**(検出力は下げていない)
- **spec の最後に `expect(errors, errors.join('\n')).toEqual([])`**
  (pageerror / console.error 0 件)
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
