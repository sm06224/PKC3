# smoke の観測点の置き方 ── 実例 ── 事故の記録

> 手順は [`../SKILL.md`](../SKILL.md)。ここは事故の記録(日付・issue つき)。
> 🔑 読む条件:「何を見れば『届いた』と言えるか」を決めるとき / 緑のはずの検査が変異で SURVIVED したとき /
> 計器(probe)が嘘の値を返した疑いがあるとき。

## 目次

- 環境差に強い側へ寄せる(`beforeprint`)
- ネットワークの event を「飛んだ / 止まった」の判定に使わない
- 空振り防止は「素のままの値」で置く
- 時間に依存する観測点は、負荷でしか出ない不具合を捕まえない(2026-08-18、#258)
- `domcontentloaded` は絵を待たない / 固定の `setTimeout` は観測点ではない(2026-10-03、#1066 / #1319)
- 計算後の style だけを見ない
- `::after` / `::before` の `text-decoration` は、親の下線を映さない(2026-10-02、#1225 / #1239)
- 飾りを字として足さない ── `textContent` に乗ると、コピーに混ざる(2026-10-02、#1150)
- DOM の消滅を見るなら、枝ごと消える形を数える(2026-08-22、#270)
- 印刷は版面が紙の幅になる
- 一覧を最後の節へ足すと、目次から飛んだときの着地点が変わる(2026-09-21)
- canvas しか無い相手(LO wasm)を触る(2026-08-13 / 2026-08-14)
- 鳴らしている `<audio>` の `duration` は、読み終わるまで「途中の値」である(2026-09-14、#683 段②a)
- `expect.poll` は「最初の一読で当たれば通る」(2026-08-27)
- 診断は「書いただけ」では効いているか分からない(2026-08-27、#489)
- 自分で字を打つと、画面の案内が嘘でも通る(2026-09-16、#682 段④c)
- 押す前と押した後で見た目を比べると、`:hover` が答えてしまう(2026-09-25、#1054)
- `setRangeText` は `Ctrl`+`Z` の履歴を切る(2026-09-07、#765)

## 環境差に強い側へ寄せる(`beforeprint`)

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

## ネットワークの event を「飛んだ / 止まった」の判定に使わない

CSP が止めた試行も `page.on('request')` に**上がる**(応答は 1 度も返らない)。
到着の時期はビルドで違う ── どちらに寄せても片方で落ちる。

正しい観測点は **①アプリ自身の信号**(確認の帯が出た = 箱の中で違反が実際に起きた証拠)
\+ **②応答が返らないこと**の 2 つ。⚠ ②だけでは空振りでも通る。
⚠ 逆に「**試行そのものが起きない**」を主張する test では `request` が正しい観測点 ──
**主張が違えば観測点も違う**。

## 空振り防止は「素のままの値」で置く

2 つの面を突き合わせる test は、**両面とも壊れていても一致する**。
だから各観測点に「**直す前はこうだった**」を書き、**片方がその値でないこと**を先に見る。

```ts
{ name: '注意書きの枠の太さ', sel: '.pkc-section-callout', prop: 'border-left-width', bare: '0px' }
// → まず app 側が bare でないことを assert してから、両面を toEqual で比べる
```

## 時間に依存する観測点は、負荷でしか出ない不具合を捕まえない(2026-08-18、#258)

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

## `domcontentloaded` は絵を待たない / 固定の `setTimeout` は観測点ではない(2026-10-03、#1066 / #1319)

- `read-columns.smoke` の別窓の絵:`win.waitForLoadState('domcontentloaded')` の直後に `naturalHeight` を読んでいた ──
  混んだ箱で **0** のまま読んで 1/519 落ちた(単独では緑)。🔑 待つのは「絵が読めた」そのもの
  (`waitForFunction(() => img.complete && img.naturalHeight > 0, …, { timeout })`)。待ちきれなければ下の assert が落ちる形にする
  (`.catch(() => undefined)` で黙らせて**通さない**)。
- unit でも同じ族:`attach-intake.test.ts` の `UNDO_APPEND` の後の `setTimeout(100)` が負荷でだけ間に合わない(#1319)。
  🔑 「時間」で待つ検査は、混んだ箱(runner 2 本 + レビュー 2 本)で**だけ**落ちる ── 落ちた回は製品ではなく観測点を疑い、
  **状態が変わるまで待つ**(`vi.waitFor` / `expect.poll`)形へ直す。⚠ ただし「負荷でだけ落ちる」は**単独で回して緑**を見てから言う。

## 計算後の style だけを見ない

`display: none` を併せると**改頁は消える**のに、計算後の `break-after` は `'page'` の
まま残る。**`getClientRects().length > 0`(箱が在る)と対にする**。

## `::after` / `::before` の `text-decoration` は、親の下線を映さない(2026-10-02、#1225 / #1239)

「下線が消えた」を見る変異が、`getComputedStyle(el, '::after').textDecorationLine` では
**SURVIVED に見えた**。疑似要素の `text-decoration` の計算値は、**親から伝播した下線を反映しない**
(自分に宣言した分しか出ない)ので、親の下線を消しても消さなくても同じ値になる。
目的:**器の字では見られない物の観測点を、取り違えない**こと。
🔑 疑似要素を見るときは **`display` / `content` / 画素**で見る
(`getComputedStyle(el, '::after').display` / `.content`、または `page.screenshot` の clip の画素)。
⚠ 親の下線そのものを見たいなら、**親**の `textDecorationLine` を見る(疑似要素ではなく)。

## 飾りを字として足さない ── `textContent` に乗ると、コピーに混ざる(2026-10-02、#1150)

表の見出しの並べ替えの矢印 `↕` を、**見出しの字として**足した。user がセルをコピーすると
**「題名↕」が貼られる**。CI は smoke を回さないので **2 週間気づかれず**、
2 本の implementer の**全量 smoke が独立に**拾った。
(CLAUDE.md §10「器を替えても、**読み取れる値**が変わる」の実例である。)
目的:**見た目の飾りが、データ(`textContent` / コピー / 検索)へ入らない**こと。
🔑 手順:飾りは **CSS の `::before` / `::after` の `content`** で足す。
🔑 検算:飾りを足したら、**`th.textContent` が足す前と同じ**であることを unit で見る
(ついでに「`::after` の `content` に矢印が在る」を 1 本 ―― 上の「`::after` / `::before` の `text-decoration`」の観測点で)。

## DOM の消滅を見るなら、枝ごと消える形を数える(2026-08-22、#270)

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

## 印刷は版面が紙の幅になる

`emulateMedia({media:'print'})` **だけでは viewport 幅が変わらない**。
紙で効く規則を見るには `setViewportSize({width:794,height:1123})`(A4 縦)が要る ──
その幅で**狭幅の上書きが発火する**ことも込みで見る。

## 一覧を最後の節へ足すと、目次から飛んだときの着地点が変わる(2026-09-21)

「お知らせ」節の末尾に一覧を足したら、その節の見出しが**先頭ぴったり**に
寄れるようになり、sticky の帯(35px)の**下に隠れて**「上へ」が押せなくなった
(内容が短かった base では起きない)。

🔑 直しは `h3[data-pkc-section] { scroll-margin-top: 40px }`。
**中身を足した / 減らした面**では、目次やリンクの飛び先が sticky の下に
入らないかを実ブラウザで 1 度見る ── happy-dom は `scroll-margin-top` も
sticky の重なりも再現しない。

## canvas しか無い相手(LO wasm)を触る(2026-08-13 / 2026-08-14)

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

## 鳴らしている `<audio>` の `duration` は、読み終わるまで「途中の値」である(2026-09-14、#683 段②a)

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

## `expect.poll` は「最初の一読で当たれば通る」(2026-08-27)

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

## 診断は「書いただけ」では効いているか分からない(2026-08-27、#489)

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

## 自分で字を打つと、画面の案内が嘘でも通る(2026-09-16、#682 段④c)

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

## 押す前と押した後で見た目を比べると、`:hover` が答えてしまう(2026-09-25、#1054)

「押すと地の色が変わる」を `clickReal()` の前後の `backgroundColor` で見たら、
**押している見た目の規則を丸ごと消しても緑**だった(変異試験が SURVIVED)。
`clickReal()` は `page.mouse.click(x, y)` なので、**押した後もマウスがその上に残り**、
`button:hover` の地だけで「前と違う」が成り立っていた(CLAUDE.md §4
「観測点が放っておいても変わる」の smoke 版)。

🔑 直し方は 2 つ組:
1. **測る前にマウスを外す**(`await page.mouse.move(0, 0)`)
2. **押していない兄弟と比べる**(同じ帯の別のボタンと地が違うこと)── 1 だけだと、
   外した先がたまたま別の状態を作っても気づけない

## `setRangeText` は `Ctrl`+`Z` の履歴を切る(2026-09-07、#765)

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
