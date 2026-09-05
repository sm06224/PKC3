/**
 * smoke 共通 helper(P3-8)。
 * - boot 待ちは DOM 契約 `[data-pkc-boot="ready"]`(main.ts が boot 完了で刻む)
 * - クリックは「その座標で実際に見えて・最前面にある」ことを elementFromPoint で
 *   確認してから実マウスで行う(happy-dom では検証できない層 ── visual parity 規約)
 * - pageerror / console.error は各 spec の最後に 0 件を assert する
 *   (⚠ 2026-09-05 に **`console.info` / `console.log`** も数えるようにした ──
 *    アプリの束から出たものだけ。理由は `collectPageErrors` の中に書いた)
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { consoleOrigin, firstAppFrame, isAppOrigin, rawFrame } from './page-errors';

export async function gotoApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({
    timeout: 15_000,
  });
}

/**
 * 🔴 **store の往復を数える**(2026-09-05)。
 *
 * ⚠ **待ちを伸ばすための道具ではない。** 面のための走査は 2026-09-05 から
 *   書込の列に載っている(`REQUEST_TASK_SCAN` ほか ── 保存を追い越して
 *   保存前の中身を集めるのを止めた)。だから「編集を開いた**直後**に
 *   雛形が届いている」は、もう成り立たない ── 届くのは
 *   **並んでいる書込が着地した後**である(実測で 36ms 後)。
 * 🔑 だから spec は**アプリ自身の合図**を待つ ── 「その走査が返ってきた」を
 *   worker への往復そのもので見る(CLAUDE.md §4「観測点は配線そのもの」)。
 * ⚠ **`gotoApp` の前に呼ぶ**(init script なので、後から仕掛けても間に合わない)。
 * ⚠ 空振り防止に「1 度でも往復を見たか」を併せて見る ── 綴りが変われば
 *   `waitFor` は**必ず時間切れになる**(黙って通らない)。
 */
export async function recordStoreOps(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    if (w.__pkcStoreOps !== undefined) return;
    const seen: string[] = [];
    w.__pkcStoreOps = seen;
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, msg: unknown, ...rest: unknown[]) {
      const op = (msg as { req?: { op?: string } } | null)?.req?.op;
      const id = (msg as { id?: unknown } | null)?.id;
      if (typeof op === 'string') {
        // ⚠ 当たったら外す ── 外さないと応答 1 件ごとに全部走る(O(n²))
        const onMsg = (e: MessageEvent): void => {
          if ((e.data as { id?: unknown } | null)?.id !== id) return;
          seen.push(op);
          this.removeEventListener('message', onMsg);
        };
        this.addEventListener('message', onMsg);
      }
      return (orig as (...a: unknown[]) => unknown).call(this, msg, ...(rest as []));
    } as typeof Worker.prototype.postMessage;
  });
}

/**
 * 🔑 **ここまでの記録を捨てる**(着地前レビュー 2-E)。
 * ⚠ 「この後 1 回」を待つために使う ── **回数を当てない**。
 *   `2` のような当て番号は、間に 1 回増えた日に**理由の読めない赤**になる。
 */
export async function resetStoreOps(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = (window as unknown as { __pkcStoreOps?: string[] }).__pkcStoreOps;
    if (seen !== undefined) seen.length = 0;
  });
}

/** `recordStoreOps` を仕掛けた頁で、その op が **n 回**返るまで待つ。 */
export async function waitForStoreOp(page: Page, op: string, n = 1): Promise<void> {
  await page.waitForFunction(
    ([name, want]) => {
      const seen = (window as unknown as { __pkcStoreOps?: string[] }).__pkcStoreOps;
      if (seen === undefined) return false;
      return seen.filter((o) => o === name).length >= (want as number);
    },
    [op, n] as [string, number],
    { timeout: 15_000 },
  );
}

/**
 * 🔑 2 ペイン(split)で開く仕込み(#104 第 2 弾で既定が live になった)。
 * 全文 textarea(`editor-body`)を**入力の道具**に使う spec は、最初の goto の
 * **前に**これを呼ぶ。⚠ ここで試すのは「設定として支持される構成」──
 * 既定(live)の顔は live-editor.smoke.spec.ts が守る。
 */
export async function useSplitEditor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // ⚠ init script は**全 frame**で走る ── sandbox 化された html fence の
    //   iframe(allow-same-origin 無し)では localStorage を**読むだけで throw**
    //   し、pageerror として計上される(fence-render smoke で実際に踏んだ)
    try {
      localStorage.setItem('pkc3.editor-mode', 'split');
    } catch {
      /* sandbox の frame ── アプリの設定とは無関係なので黙って流す */
    }
  });
}

/**
 * 🔑 **一覧タブで開く仕込み**(#240 段⑤ で既定が**フォルダ**になった)。
 *
 * 左の列の行(`[data-pkc-region="entry-list"]`)を掴む spec は、最初の `goto` の
 * **前に**これを呼ぶ ── 既定はもうフォルダなので、呼ばないと一覧の面は `hidden` である。
 * ⚠ 既定(フォルダ)の顔は `organize.smoke.spec.ts` が守る ── ここで既定を
 * 上書きするのは「一覧でも同じことができる」を確かめるためであって、
 * **既定を試験から隠すためではない**(`useSplitEditor` と同じ理由づけ)。
 */
export async function useListBrowse(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('pkc3.browse', 'list');
    } catch {
      /* sandbox の frame ── アプリの設定とは無関係なので黙って流す */
    }
  });
}

/**
 * 🔴 **既知の常在ノイズ(名指しの等値リスト)。**
 *
 * cross-origin isolation(`COOP` + `COEP: credentialless`)を入れた 2026-08-10 から
 * 出るようになった 2 行。**PKC3 が使う VFS は `opfs-sahpool` だけ**なのに、
 * sqlite-wasm は **SharedArrayBuffer が在ると**別系統の「OPFS asyncer」VFS
 * (`opfs` / `opfs-wl`)も自動で登録しに行き、この環境では失敗して console.error を出す。
 * ⚠ **機能は壊れていない**(SAHPool で動く)。増えたのはノイズだけである。
 *
 * ## 握り潰しではなく「名指し」にした理由と、試して駄目だった道
 *
 * sqlite-wasm は worker の URL に `<vfs 名>-disable` が在れば登録を飛ばす
 * (`urlParams.has(vfsName + "-disable")`)。そこで worker URL に query を付けようとしたが:
 * - `new Worker(new URL('./storage-worker.ts?…', import.meta.url))` → **Vite が query を落とす**
 * - 関数へ切り出す → **Vite が worker を bundle しなくなり、アプリが起動しない**
 * - `?worker&url` + 変数渡し → query は残ったが、**SW の cache 照合が query 付き URL と
 *   合わず、オフラインで storage ごと死んだ**(entry 0 件)
 * 🔑 3 つ目で「直しに行くほうが壊れる」と分かったので、**発生源は上流に残し、
 * こちらは等値で名指しする**。⚠ 等値なので、**文言が 1 文字でも変われば落ちる** ──
 * 「いつの間にか別のエラーが混ざる」ことは防げている。
 * 🔑 消せる条件: sqlite-wasm 側で不要 VFS を登録しない手段が API として入るか、
 * Vite が worker URL の query を保つようになったとき。
 */
const KNOWN_CONSOLE_NOISE: readonly string[] = [
  'console.error: opfs: Error initializing OPFS asyncer: Event',
  'console.error: opfs-wl: Error initializing OPFS asyncer: Event',
];

/**
 * 🔴 **スマホの幅ではお知らせが画面いっぱいに出る**(user 裁定 2026-09-02
 * 「**全画面でだせばいいじゃん。不要ならみんな設定するでしょ？**」)。
 *
 * ⚠ だから 720px 以下の spec は、**先に畳まないと他の面に 1 つも触れない**
 *   (押し口は在るが、カードの下である)。`gotoApp` の直後に呼ぶ。
 * 🔑 全画面そのものと「今後は出さない」で出なくなることは
 *   `phone.smoke.spec.ts` の専用 test が見る ── ここで畳むのは
 *   **それ以外の主張を測るため**であって、カードを試験から隠すためではない。
 * ⚠ **出ていることを先に確かめる** ── 出ていない回に黙って通すと、
 *   「畳んだから触れた」のか「最初から出ていない」のか読めなくなる。
 */
export async function dismissAnnounce(page: Page): Promise<void> {
  const band = page.locator('[data-pkc-region="announce"]');
  await expect(band, '起動時にお知らせが出ていない(台の前提が崩れた)').toBeVisible({
    timeout: 10_000,
  });
  await clickReal(page, '[data-pkc-action="dismiss-announce"]');
  await expect(band, '閉じても残っている').toBeHidden();
}

export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  /**
   * 🔴 **例外に「どこから / いつ」を 1 行だけ添える**(#387)。
   *
   * ⚠ `toEqual([])` は「**何か例外が出た**」としか言わない ── #387 は
   *   **2 度観測しても原因に 1 歩も近づいていない**(2026-08-25 / 2026-08-27。
   *   どちらも同じ 1 行だけが残った)。
   * ⚠ 「流れの途中で出た」のと「最後の assert が済んだ後に出た」のは
   *   **別の話**なのに、いまの赤はどちらも同じに見える ── だから経過も添える。
   * 🔴 **console 側にも「どの面から出たか」を添える**(#561、2026-08-29)。
   *   ⚠ 1 稿目はここに「添えるのは `pageerror` だけ ── console は等値で名指しして
   *   いるので飾ると外れなくなる」と書いていたが、**外し方の順番を変えれば両立する**
   *   (等値の照合を**飾る前**にやる)。
   * ⚠ これが無いと**箱の中とアプリの区別が付かない** ── #561 は
   *   `<svg> attribute width: …` が **sandbox の `srcdoc` から**出ていたのに、
   *   赤の 1 行はアプリの例外とまったく同じ顔をしていた。
   */
  const t0 = Date.now();
  page.on('pageerror', (e) => {
    /**
     * 🔴 **名指しできなくても stack を捨てない**(#387、2026-08-29)。
     * ⚠ 4 度観測して 4 度とも `@ path:line` が付かなかった ── そのとき
     *   「stack が空」なのか「`<anonymous>` だけ」なのかが**区別できていない**。
     * 🔑 名指しできた回はこれまでどおり、できなかった回だけ**採れた 1 行**を添える。
     */
    const named = firstAppFrame(e.stack);
    const where = named !== '' ? named : rawFrame(e.stack);
    errors.push(`pageerror: ${e.message}${where} (+${Date.now() - t0}ms)`);
  });
  page.on('console', (msg) => {
    /**
     * 🔴 **`info` / `log` も数える(アプリの束から出たものだけ)**(#710、2026-09-05)。
     *
     * ⚠ 直す前はここが `msg.type() !== 'error'` で**全部捨てて**いたので、
     *   製品が `console.info` を**描画のたびに**出していても誰も気づけなかった ──
     *   実測(smoke 全量 1 回・全種を採った):`[PKC2009]` **9 行** /
     *   `[PKC2007]` **1 行**が `markdown-worker` の chunk から出ていた(#710 で出所を止めた)。
     * 🔑 **`info` / `log` に製品の使い道は 1 つも無い**(`src` を全数 grep して 0 件)
     *   ので、出たら赤にしてよい ── 「知らせる」なら画面の帯(`status`)が正しい出口である。
     * ⚠ **`warn` は数えない。** 残っている 1 本(`Scripts may close only the windows
     *   that were opened by them.`)は**ブラウザが出す**もので、`closeViewWindow` が
     *   「閉じられる窓か」を**実際に閉じてみて**確かめる設計の副産物である
     *   (`view-window.ts` に対照群つきの実測が在る)。⚠ ここで名指しの一覧へ足すと、
     *   後から来た本物の warn まで黙る ── だから**種類ごと外す**。
     * ⚠ 出所は **http(s) だけ**(`isAppOrigin`)── `about:srcdoc` の箱の中は
     *   fixture が描く相手であって、アプリの主張ではない(#561)。
     */
    const kind = msg.type();
    if (kind !== 'error') {
      if (kind !== 'info' && kind !== 'log') return;
      if (!isAppOrigin(msg.location())) return;
      errors.push(
        `console.${kind}: ${msg.text()}${consoleOrigin(msg.location())} (+${Date.now() - t0}ms)`,
      );
      return;
    }
    const line = `console.error: ${msg.text()}`;
    // ⚠ **等値**で外す(部分一致にしない)── 部分一致にすると、同じ前置きを持つ
    //    別のエラーまで黙って消える
    if (KNOWN_CONSOLE_NOISE.includes(line)) return;
    // 🔑 **外した後に飾る** ── 等値の名指し(上)は素の行に当てる
    errors.push(`${line}${consoleOrigin(msg.location())} (+${Date.now() - t0}ms)`);
  });
  return errors;
}

/**
 * 役割メニューの中の項目を押す(P7b 段⑨b)。
 *
 * ⚠ **メニューを開いてから押す**。畳んだ結果 `clickReal` が
 * 「閉じたメニューの中は見えない」で落ちるのは**正しい** ── 実際の user も
 * 開かなければ押せない。ここでその動線を再現する。
 * ⚠ 開けるかどうかも観測点である(`summary` が押せなければここで落ちる)。
 */
/**
 * 🔑 新規作成の**実際の導線**(P8)。種類は `<select>` で選び、`新規` を押す。
 * ⚠ 封印中の種類(`features/sealed.ts`)は選べない ── 選ぼうとすると
 * playwright が落ちるので、それ自体が「封印が効いている」の観測点になる。
 */
export async function createEntry(page: Page, archetype: string): Promise<void> {
  // 🔴 **user と同じ手順**(P10 で分割ボタンへ)── ▼ を押して種類を選び、本体を押す。
  // ⚠ `selectOption` だけでは足りない ── 本体のボタンが `data-pkc-archetype` を持ち、
  //    binder はそちらを先に見るので、select だけ変えると別の種類が出来る
  await clickReal(page, '[data-pkc-field="create-pick"]');
  await clickReal(page, `[data-pkc-region="create-menu"] [data-pkc-archetype="${archetype}"]`);
  await clickReal(page, '[data-pkc-field="create-run"]');
}

/**
 * 🔴 **再描画で node が差し替わるのは正常**(2026-08-05、CI と full run で実際に落ちた)。
 *
 * 情報ペインもファイラのパンくずも、値が変わると作り直される。保存の直後は worker から
 * 時刻が遅れて届くので、その瞬間に触ると `scrollIntoViewIfNeeded` が
 * `Element is not attached to the DOM` / `element is not stable` で落ち、
 * `boundingBox()` は **`toBeVisible()` を通った直後でも null** を返す
 * (= その間に外れた ── 面積 0 の要素はそもそも `toBeVisible()` で落ちる)。
 * 遅い機械ほど当たりやすい(手元 3/3 緑・CI 赤 / 単独緑・全量赤 を両方踏んだ)。
 */
function isRerenderRace(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes('not attached to the DOM') ||
    msg.includes('element is not stable') ||
    msg.includes('boundingBox が無い')
  );
}

/**
 * ⚠ **retry で誤魔化さない**。差し替わったら**やり直す**が、「見えている位置に
 * 本当に在るか」の検証は**毎回**やる ── dead click / occlusion の検出力は
 * 1 ミリも下げない。⚠ 回数を切る ── 永遠に作り直され続ける(= 本物の不具合)なら
 * 落ちるべき。
 */
async function withRerenderRetry<T>(page: Page, run: () => Promise<T>): Promise<T> {
  const ATTEMPTS = 3;
  for (let i = 1; ; i += 1) {
    try {
      return await run();
    } catch (e) {
      if (!isRerenderRace(e) || i >= ATTEMPTS) throw e;
      // 差し替わった直後は次の描画がまだ来ていることがある ── 1 フレーム待つ
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
  }
}

/**
 * 実クリック: 中心座標の最前面要素が target(またはその子孫)であることを
 * 確認してから page.mouse.click。dead click / occlusion / zero-height を検出する。
 */
export async function clickReal(page: Page, target: Target): Promise<void> {
  await withRerenderRetry(page, async () => {
    const { x, y } = await reachableOnce(page, target);
    await page.mouse.click(x, y);
  });
}

/**
 * 🔴 **塊を開くクリック = Ctrl(⌘)+クリック**(#495。user 裁定 2026-08-27)。
 *
 * > 「見出しを押したら編集とかは、**Ctrl+クリックで、その地点から編集**にすれば
 * > 良いと思う。**見出しにこだわる必要はない**」
 *
 * ⚠ **`clickReal` と同じ検出力**(dead click / occlusion / 座標)を使う ──
 *   規則を 2 本書くと、片方だけ緩んで気づかない(`expectReachable` と同じ理由)。
 * 🔑 `ControlOrMeta` は Playwright が**走っている OS で畳んでくれる**修飾キー
 *   ── 実装側の `ctrlKey || metaKey`(`Chord.mod`)と同じ向きである。
 */
export async function modClickReal(page: Page, target: Target): Promise<void> {
  await withRerenderRetry(page, async () => {
    const { x, y } = await reachableOnce(page, target);
    await page.keyboard.down('ControlOrMeta');
    try {
      await page.mouse.click(x, y);
    } finally {
      await page.keyboard.up('ControlOrMeta');
    }
  });
}

/** 🔴 **追記の入り先を指すクリック = Alt+クリック**(#495)。 */
export async function altClickReal(page: Page, target: Target): Promise<void> {
  await withRerenderRetry(page, async () => {
    const { x, y } = await reachableOnce(page, target);
    await page.keyboard.down('Alt');
    try {
      await page.mouse.click(x, y);
    } finally {
      await page.keyboard.up('Alt');
    }
  });
}

/**
 * 「その座標で実際に見えていて、最前面である」ことだけを確かめる(押さない)。
 *
 * 🔑 `<select>` のように**押すと OS の一覧が開いてしまう**部品は、これで届くことを
 * 確かめてから `selectOption` で操作する ── 検出力(dead click / occlusion)は
 * `clickReal` と**同じ規則**を使う。⚠ 規則を 2 本書くと、片方だけ緩んで気づかない。
 *
 * @returns 中心座標
 */
export async function expectReachable(
  page: Page,
  target: Target,
): Promise<{ x: number; y: number }> {
  return withRerenderRetry(page, () => reachableOnce(page, target));
}

/**
 * 押したい相手 ── **選択子でも Locator でもよい**(2026-08-27、#419)。
 *
 * 🔴 **選択子を文字列で組み立てさせない**ため。行の相手は `data-pkc-entry="<lid>"` で
 *   識別するが、**lid には引用符が入りうる**(実際に `shell.ts` の選択子の組み立てが
 *   それで壊れた)── 組み立てた選択子は**壊れるか、別の行に当たる**。
 * 🔑 Locator を受ければ、**そもそも選択子を組み立てる必要が無い**
 *   (`.last()` や `.nth(i)` をそのまま渡せる)。
 */
export type Target = string | Locator;

const asLocator = (page: Page, t: Target): Locator =>
  typeof t === 'string' ? page.locator(t).first() : t;

const nameOf = (t: Target): string => (typeof t === 'string' ? t : String(t));

async function reachableOnce(page: Page, target: Target): Promise<{ x: number; y: number }> {
  const el = asLocator(page, target);
  const name = nameOf(target);
  await expect(el).toBeVisible();
  await el.scrollIntoViewIfNeeded(); // fold 下の要素を「覆われている」と誤診しない
  const box = await el.boundingBox();
  expect(box, `${name} に boundingBox が無い(画面に出ていない)`).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  // 判定は「target 自身か、その子孫がヒット」のみ。祖先ヒットを許すと
  // pointer-events:none 等の dead click が素通りする(binder は ev.target から
  // closest するため、祖先ヒットでは target のハンドラに届かない ── review #2)
  /**
   * ⚠ **要素そのものを渡す**(`document.querySelector(sel)` で引き直さない)。
   *   引き直すと ①選択子の組み立てが壊れる相手を扱えない ②`.last()` を測ったのに
   *   **`querySelector` は先頭を返す**ので、**別の要素で当たり判定していた**
   *   (箱は最後の行・判定は最初の行、という食い違いが原理的に起こりうる)。
   */
  /**
   * 🔴 **箱を測った後に面が作り直されると、古い座標で当て判定してしまう**
   * (2026-08-28、#494 のフル smoke で実際に踏んだ)。
   *
   * ⚠ `boundingBox()` と `evaluate()` は**別々に locator を解決する** ── その間に
   *   情報ペインが作り直されると(保存の直後に worker から更新時刻が遅れて届く
   *   ── この file の `isRerenderRace` が書いているとおり)、`node` は**新しい要素**
   *   なのに `x, y` は**古い箱**のものになる。すると
   *   `elementFromPoint` は別の物を返し、**「覆われている」という嘘の診断**が出る。
   * 🔑 だから `evaluate` の中で**その node 自身の箱も一緒に採る**。ずれていたら
   *   「覆われている」ではなく**作り直された**と読み、`withRerenderRetry` に回す。
   * ⚠ **検出力は 1 ミリも下げない** ── 箱が動いていないのに当たらない場合は、
   *   これまでどおり落ちる(本物の occlusion / dead click はそちら)。
   * ⚠ `boundingBox()` のほうを捨てて `getBoundingClientRect` 一本にはしない ──
   *   あちらは iframe の中の要素でも**頁の座標**を返す(`evaluate` は frame の座標)。
   */
  const probe = await el.evaluate(
    (node, { px, py }) => {
      const at = document.elementFromPoint(px, py);
      const r = (node as Element).getBoundingClientRect();
      return {
        hit: !!(at && (at === node || node.contains(at))),
        box: { x: r.x, y: r.y, w: r.width, h: r.height },
        at: at === null ? '(無し)' : `${at.tagName}${at.getAttribute('data-pkc-field') ?? ''}`,
      };
    },
    { px: x, py: y },
  );
  /**
   * ⚠ **大きさだけでなく位置も見る** ── 作り直しでいちばん多いのは
   *   「同じ大きさの物が**隣へずれる**」形である(札が 1 枚増減しただけで起きる)。
   *   大きさだけ比べると、その回を**本物の occlusion として落としてしまう**。
   */
  const moved =
    Math.abs(probe.box.x - box!.x) > 1 ||
    Math.abs(probe.box.y - box!.y) > 1 ||
    Math.abs(probe.box.w - box!.width) > 1 ||
    Math.abs(probe.box.h - box!.height) > 1;
  if (!probe.hit && moved) {
    // ⚠ 文言は `isRerenderRace` が拾う形にする(retry の合図)
    throw new Error(
      `${name}: 測った後に element is not stable` +
        `(${box!.x},${box!.y} ${box!.width}x${box!.height} → ` +
        `${probe.box.x},${probe.box.y} ${probe.box.w}x${probe.box.h})`,
    );
  }
  expect(
    probe.hit,
    `${name} の中心 (${x},${y}) が別要素に覆われている / 届かない(そこに在るのは ${probe.at})`,
  ).toBe(true);
  return { x, y };
}

/**
 * 画像が **実際に読み込まれて描画されている**ことを確かめる。
 *
 * `src` 属性が blob: になった瞬間と、画像が decode されて面積を持つ瞬間は違う ──
 * `![alt](asset:…)` は decode 前に alt テキストでボックスを持つので、
 * 「toBeVisible → src を assert → boundingBox」は **src 設定直後にレイアウトが
 * 一度潰れる窓**を踏みうる(CI で実際に踏んだ)。`naturalWidth` は decode 完了で
 * しか立たないので、これを待ってから面積を見る(assert は弱めず強めている)。
 */
export async function expectImageRendered(page: Page, selector: string): Promise<void> {
  const img = page.locator(selector).first();
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(
      () =>
        img.evaluate(
          (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth,
        ),
      { message: `${selector} が decode されない(blob: を差したのに読めていない)` },
    )
    .toBeTruthy();
  const box = await img.boundingBox();
  expect(box, `${selector} が画面に出ていない`).not.toBeNull();
  expect(box!.height).toBeGreaterThan(0);
}

/**
 * 🔴 **アプリ自身の確認ダイアログに答える**(#299 段②)。
 *
 * ⚠ `page.on('dialog')` は**もう使えない** ── `window.confirm` を捨てたので
 *   ブラウザのダイアログは 1 度も開かない。**ページの中の要素**を押す。
 * 🔑 これが差し替えの取り分でもある ── native のモーダルはレンダラを止めるので、
 *   CDP から見ると「画面が固まった」と区別が付かなかった(#299)。
 *
 * @returns 確認に出ていた文言(件数などを突き合わせるため)
 */
export async function answerAppDialog(page: Page, answer: 'ok' | 'cancel'): Promise<string> {
  const body = page.locator('[data-pkc-field="dialog-body"]');
  await expect(body, '確認のダイアログが出ていない').toBeVisible();
  const message = (await body.textContent()) ?? '';
  await clickReal(page, `[data-pkc-field="dialog-${answer === 'ok' ? 'ok' : 'cancel'}"]`);
  await expect(body, 'ダイアログが閉じていない').toBeHidden();
  return message;
}

/**
 * 🔴 **中央の面を「アドレスから」開く**(#300 段③、2026-08-22)。
 *
 * ⚠ 直す前、smoke は**アプリの一覧のタイルを押して**面を開いていた。
 * 段③ で**タイルは別窓を開く**ようになった(user 要望「センターペインを占有するな」)
 * ので、その手は**この窓の面を変えない** ── 18 spec が一斉に落ちた。
 *
 * 🔑 面そのものの振る舞い(カレンダーのセル / 2 ペインの移動)を見る spec は、
 * **開き方を測っていない**。だからディープリンク(段②)で開く ──
 * ⚠ `location.hash` を書くだけで**読み直しは起きない**(`hashchange` を購読して
 * いるので効く)。読み直すと lease を取り直すぶん遅く、揺れも増える。
 *
 * ⚠ **タイルが窓を開くこと自体**は `launcher.smoke.spec.ts` が見る ──
 * こちらで兼ねると「面が出た = タイルが効いた」と誤読する。
 */
export async function openViewPane(page: Page, view: 'dual' | 'query'): Promise<void> {
  /**
   * ⚠ **空振り防止**(着地前レビュー 8、2026-08-22)── **既に開いていたら
   * この helper は何も検めていない**。同じ断片を書いても `hashchange` は飛ばない
   * ので、代入は no-op になり、`toBeVisible` は最初から真で通る。
   */
  await expect(
    page.locator(`[data-pkc-view-pane="${view}"]`),
    '既に開いている(この helper は何も検めていない)',
  ).toBeHidden();
  await page.evaluate((v) => {
    location.hash = `#pkc?view=${v}`;
  }, view);
  await expect(page.locator(`[data-pkc-view-pane="${view}"]`)).toBeVisible({ timeout: 15_000 });
}
