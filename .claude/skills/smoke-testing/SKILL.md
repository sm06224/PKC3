---
name: smoke-testing
description: PKC3 の実ブラウザ検証(tests/smoke、Playwright)を書く・直す・回す手順。視覚や実 DOM 挙動を持つ変更を入れるとき、smoke が CI だけで落ちるとき、観測点の置き方に迷うときに使う。「smoke」「実ブラウザ」「Playwright」「CI だけ落ちる」「視覚テスト」という文脈で必ず使う。
---

# 実ブラウザ検証(PKC3 smoke)

`vitest` / `happy-dom` の pass は**生成の正しさ**しか示さない。画面に本当にそう出るかは
実ブラウザでしか分からない ── そのための最小の lane が `tests/smoke` である。

```bash
npm run test:smoke                                    # 全量(PR gate と同じ)
npx playwright test --config tests/smoke/playwright.config.ts <grep>
```

⚠ **smoke は `vite preview` で `dist/` を配信する。** source を直しただけでは
検査対象に**届かない** ── 必ず `npm run build` を挟む。

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

### ④ 計算後の style だけを見ない

`display: none` を併せると**改頁は消える**のに、計算後の `break-after` は `'page'` の
まま残る。**`getClientRects().length > 0`(箱が在る)と対にする**。

### ⑤ 印刷は版面が紙の幅になる

`emulateMedia({media:'print'})` **だけでは viewport 幅が変わらない**。
紙で効く規則を見るには `setViewportSize({width:794,height:1123})`(A4 縦)が要る ──
その幅で**狭幅の上書きが発火する**ことも込みで見る。

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
