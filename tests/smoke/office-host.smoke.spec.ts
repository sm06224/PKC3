/**
 * smoke(#117): Office の別窓(`public/office/host.html`)の**素の DOM 契約**。
 *
 * 🔴 この file は bundle されない生 HTML なので、**unit がひとつも届かない**。
 * 実際、2026-08-12 の実機調査で見つかった 3 件は全部「誰も見ていない場所」だった:
 *
 * | 症状 | 正体 |
 * |---|---|
 * | 版面の脇に「読み込んでいます…」が透けて出続ける | `#msg` の `hidden` が効かない(CSS 特異度) |
 * | 版面の上でドラッグすると上部バーの文字が選ばれる | `user-select` が既定のまま |
 * | LO が abort しても**見た目は正常**なまま操作を飲み込む | 異常終了を誰も検知していない |
 *
 * ## 148MB を持ち込まずに、**起動経路まで**通す
 *
 * ⚠ 「一式が無いから後半は検査できない」で止めると、LO を読み込んでからの全部
 * (フォントの書き込み・展開した package の受け渡し・異常終了の配線)が
 * **どの test からも実行されない**まま残る ── 実際、最初の変異試験で生き延びた
 * 1 件はそこだった。🔑 host.html が読むのは **IDB の中身**だけなので、
 * `qtLoad` と `soffice_entry` を名乗る数十バイトの偽物で足りる(`seedFakePack`)。
 *
 * ⚠ **platform で挙動が変わる assert を書かない。** キーの握り潰しは mac と
 * それ以外で分岐する ── CI は Linux、user は不明なので、**両方で同じ答えになる
 * 組み合わせだけ**を見る(下の表)。
 */
import { test, expect } from '@playwright/test';
import { collectPageErrors } from './helpers';

/** ページの script が組み上がったこと(= 最初の描画が終わった)を待つ。 */
async function ready(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/office/host.html');
  // ⚠ `#msg` は最初から在るので、それだけでは「script が走った」証拠にならない。
  //    script が必ず通る場所 ── 上部バーの状態が初期値から動くこと ── を待つ
  await expect
    .poll(async () => page.locator('#status').textContent(), { timeout: 15_000 })
    .not.toBe('準備中…');
}

/**
 * 🔴 **分離が足りないだけのときに、user が自力で抜けられる。**
 *
 * COOP/COEP は Pages がヘッダを返せないので service worker が被せている ──
 * その SW がまだこの文書を制御していない初回訪問では `crossOriginIsolated` が
 * false になり、以前は「この環境では Office を動かせません」と**環境のせいに**
 * していた。⚠ 実際には**もう一度開けば動く**。
 *
 * ⚠ ここだけ **plain server**(ヘッダを何も足さない = 本番と同じ条件)を見る。
 * 既定の `vite preview` は自分で COOP/COEP を返すので、**この状態を作れない**。
 */
test('🔴 分離が足りないだけなら、読み直す導線を出す', async ({ page }, testInfo) => {
  const plain = testInfo.config.metadata?.plainBaseURL;
  if (typeof plain !== 'string') throw new Error('plainBaseURL が config に無い');

  await page.goto(`${plain}/office/host.html`);
  await expect(page.locator('#status')).toHaveText('失敗', { timeout: 15_000 });
  // 空振り防止 ── **この条件が本当に成り立っているか**(分離だけが欠けている)
  await expect(page.locator('#msg')).toContainText('cross-origin isolation');
  expect(
    await page.evaluate(() => typeof (WebAssembly as { Suspending?: unknown }).Suspending),
    'JSPI まで無い環境では「読み直せば直る」は嘘になる(この spec の前提が崩れている)',
  ).toBe('function');

  await expect(page.locator('#msg button'), '読み直す導線が無い(user が抜けられない)').toHaveCount(
    1,
  );
});

test('🔴 覆い(#msg)は hidden で本当に消える', async ({ page }) => {
  const errors = collectPageErrors(page);
  await ready(page);

  /**
   * 🔴 id セレクタ(1,0,0)の `display:grid` は UA の `[hidden]{display:none}`
   * (0,1,0)に勝つ。だから `msgEl.hidden = true` を書いても**消えなかった**
   * (実測: `{"msgHiddenAttr":true,"msgComputedDisplay":"grid"}`)。
   * ⚠ 「属性が付いたか」を見る test は**この欠陥を 1 件も検出できない** ──
   * 見るのは **computed display** である。
   */
  const display = await page.evaluate(() => {
    const el = document.getElementById('msg');
    if (!el) throw new Error('#msg が無い');
    el.hidden = true;
    return getComputedStyle(el).display;
  });
  expect(display, '#msg[hidden] が効いていない(版面の脇に文字が透ける)').toBe('none');

  expect(errors).toEqual([]);
});

test('🔴 版面の上のドラッグで、ページの文字が選ばれない', async ({ page }) => {
  await ready(page);
  const sel = await page.evaluate(() => ({
    body: getComputedStyle(document.body).userSelect,
    // ⚠ 停止の理由は**写せる**ままにする(user がこちらへ貼れないと調査が進まない)
    msg: getComputedStyle(document.getElementById('msg') as HTMLElement).userSelect,
  }));
  expect(sel.body).toBe('none');
  expect(sel.msg, '停止の理由が選択できない(user が貼れない)').toBe('text');
});

/**
 * 🔴 **異常終了が見えること。** LO が abort しても最後のフレームが残るので、
 * user からは「固まった」としか分からない ── 以降の調査が全部止まる。
 */
test('🔴 wasm の異常終了は画面に出る(そして無関係な例外では出ない)', async ({ page }) => {
  await ready(page);

  // ① 無関係な例外では**出さない**。⚠ ここが無いと、拡張機能の例外ひとつで
  //    動いている版面に「停止しました」を被せる test になる
  await page.evaluate(() =>
    window.dispatchEvent(new ErrorEvent('error', { message: 'TypeError: x is not a function' })),
  );
  expect(await page.locator('#status').textContent()).not.toBe('停止');

  // ② wasm 由来なら出す
  await page.evaluate(() =>
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'RuntimeError: function signature mismatch' }),
    ),
  );
  await expect(page.locator('#status')).toHaveText('停止');
  await expect(page.locator('#msg')).toContainText('Office が停止しました');
  // 🔑 **理由をそのまま見せる**(丸めると再現条件が集まらない)
  await expect(page.locator('#msg .why')).toContainText('function signature mismatch');
  // 死んだ版面は触れない ── 生きているものと見分けが付かないのが問題だった
  expect(
    await page.evaluate(
      () => getComputedStyle(document.getElementById('screen') as HTMLElement).pointerEvents,
    ),
  ).toBe('none');
  // 読み直す導線が在る(user が自力で抜けられる)
  await expect(page.locator('#msg button')).toHaveCount(1);
});

/**
 * 🔴 ブラウザに横取りされる修飾キーを LO へ通す。
 *
 * ⚠ **platform 非依存な組み合わせだけ**を見る:
 *
 * | 組み合わせ | mac | それ以外 | 見るか |
 * |---|---|---|---|
 * | `Ctrl+S` | 握り潰す | `preventDefault` | ✅ どちらも「既定を止める」 |
 * | `Meta+C` | クリップボードなので触らない | 修飾キーでないので触らない | ✅ どちらも「止めない」 |
 * | `Ctrl+Alt+S` | AltGr の巻き添えを避けて素通し | 同じ | ✅ |
 * | `Ctrl+C` | 握り潰す | クリップボードなので触らない | ❌ 分岐する |
 */
test('🔴 ブラウザに盗られるキーだけ止める(クリップボードと AltGr は触らない)', async ({
  page,
}) => {
  await ready(page);
  const r = await probeKeys(page);
  // Ctrl+S を止めないと、Chrome の「ページを保存」が出て LO まで届かない
  expect(r.ctrlS.prevented, 'Ctrl+S がブラウザに盗られている').toBe(true);
  // 🔑 **止めるのは既定だけ。** Qt のハンドラには届かせる(届かないと LO が保存できない)
  expect(r.ctrlS.reached, 'Qt まで届かなくなっている(LO が受け取れない)').toBe(true);
  // ⚠ keydown を止めると `copy` / `paste` event が発火しない = クリップボードが死ぬ
  expect(r.metaC.prevented, 'クリップボードのキーを止めている').toBe(false);
  // ⚠ Windows の AltGr は ctrl+alt で届く ── 潰すと `@` が打てなくなる
  expect(r.altGr.prevented, 'AltGr を潰している').toBe(false);
  expect(r.plain.prevented).toBe(false);
});

/**
 * 🔴 mac だけの分岐 ── **`navigator.platform` を差し替えて実際に通す**。
 *
 * ⚠ 「CI が Linux だから mac 側は見ない」で済ませると、user 報告の本体
 * (`Ctrl+S` で本文に `s` が入る)を**誰も守らない**。実機は mac だった。
 *
 * mac では Qt が **Cmd を Control へ読み替える**ので、`Ctrl+英字` は LO の
 * どの割り当てにも当たらず**ただの文字**として入る。ところが LO のメニューは
 * `Ctrl+C` と表示するので user は Ctrl を押す ── だから **Qt にも渡さない**。
 */
/**
 * 🔴 **止めすぎない。** 初稿は「クリップボード以外は全部 preventDefault」と書いて
 * **`Cmd+A`(全選択)を壊した** ── 直す前は動いていた機能である(実機で確認された)。
 *
 * 🔑 押さえるのは**ブラウザが実際に横取りするキーだけ**。`a` / `z` / `b` は
 * ブラウザが盗らないので、こちらが触る理由が無い。
 */
test('🔴 ブラウザが盗らないキーには触らない(Cmd+A / Ctrl+A を殺さない)', async ({
  browser,
}) => {
  for (const mac of [false, true]) {
    const ctx = await browser.newContext();
    if (mac) {
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      });
    }
    const page = await ctx.newPage();
    try {
      await ready(page);
      const r = await probeKeys(page);
      // ⚠ mac の修飾キーは Cmd、それ以外は Ctrl ── **その platform の「全選択」**を見る
      const selectAll = mac ? r.metaA : r.ctrlA;
      expect(selectAll.prevented, `全選択を握り潰している(mac=${String(mac)})`).toBe(false);
      expect(selectAll.reached, `全選択が Qt に届いていない(mac=${String(mac)})`).toBe(true);
      // 対照 ── 盗られるキーは今も止めている(緩めすぎていない)
      expect(r.ctrlS.prevented || r.metaS.prevented, '盗られるキーまで通している').toBe(true);
    } finally {
      await ctx.close();
    }
  }
});

test('🔴 mac では Ctrl+英字 を Qt にも渡さない(文字だけが残るため)', async ({ browser }) => {
  const ctx = await browser.newContext();
  // ⚠ ページの script より**先に**効かせる(判定は読み込み時に 1 回だけ走る)
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
  });
  const page = await ctx.newPage();
  try {
    await ready(page);
    const r = await probeKeys(page);
    expect(r.ctrlC.prevented, 'mac の Ctrl+C が本文に `c` を入れる').toBe(true);
    expect(r.ctrlC.reached, 'Qt に渡っている(文字が入る)').toBe(false);
    // ⚠ mac の修飾キーは Cmd。こちらは**クリップボードなので触らない**
    expect(r.metaC.prevented, 'mac のクリップボードを止めている').toBe(false);
    expect(r.altGr.prevented).toBe(false);
  } finally {
    await ctx.close();
  }
});

/**
 * 🔴 **偽の一式を IDB に仕込んで、起動経路を実際に通す。**
 *
 * ⚠ ここが無いと、host.html の**後半(LO を読み込んでからの全部)は
 * どの test からも実行されない** ── フォントの書き込み・展開した 148MB の解放・
 * 異常終了の配線が、壊れても緑のままになる(実際、変異試験で `onExit` の
 * 変異だけが生き延びた)。
 *
 * 🔑 148MB は要らない。host.html が読むのは **IDB の中身**だけなので、
 * `qtLoad` と `soffice_entry` を名乗る数十バイトの script で足りる。
 *
 * @param opts.badFont この名前のフォントで `FS.writeFile` を投げさせる(D-4 の検査)
 * @param opts.breakWasm `instantiateWasm` を実際に走らせて失敗させる(D-3 の検査)
 */
async function seedFakePack(
  page: import('@playwright/test').Page,
  opts: { badFont?: string; breakWasm?: boolean } = {},
): Promise<void> {
  await page.evaluate(async ({ badFont, breakWasm }) => {
    const gz = async (s: string): Promise<Blob> =>
      new Response(
        new Blob([s]).stream().pipeThrough(new CompressionStream('gzip')),
      ).blob();

    const qtLoaderJs = `
      window.qtLoad = async function (cfg) {
        window.__cfg = cfg;
        // ⚠ 本物と同じ順で呼ぶ ── 展開した package はここで受け取られる
        window.__pkg = cfg.getPreloadedPackage();
        if (${String(Boolean(breakWasm))}) {
          // 本物と同じ経路(gz を解いて instantiateStreaming)。中身が wasm でないので必ず失敗する
          cfg.instantiateWasm({}, function () { window.__okCalled = true; });
          return new Promise(function () {});   // ⚠ 本物同様、解決も棄却もしない
        }
        var c = document.createElement('canvas');
        c.width = 320; c.height = 200;
        cfg.qt.containerElements[0].appendChild(c);
        window.__written = [];
        window.__order = [];
        // ⚠ **stub は本物の意味論を真似る**(CLAUDE.md)。MEMFS は親ディレクトリが
        //    無ければ ENOENT を投げる ── そこを緩めると「先に作る」を消す変異が素通りする
        var made = {};
        var bad = ${JSON.stringify(badFont ?? '__none__')};
        return {
          FS: {
            mkdirTree: function (p) { made[p] = true; },
            mkdir: function (p) { made[p] = true; },
            writeFile: function (p, data) {
              var dir = p.slice(0, p.lastIndexOf('/'));
              if (!made[dir]) throw new Error('ENOENT: no such directory, ' + dir);
              if (p.indexOf(bad) !== -1) throw new Error('ENOENT');
              window.__written.push(p);
              if (p.indexOf('registrymodifications.xcu') !== -1) {
                window.__xcu = String(data);
                window.__order.push('xcu');
              }
            },
          },
          callMain: function (a) { window.__args = a; window.__order.push('callMain'); },
        };
      };
    `;

    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('pkc3-office-pack', 1);
      r.onupgradeneeded = (): void => {
        if (!r.result.objectStoreNames.contains('files')) r.result.createObjectStore('files');
        if (!r.result.objectStoreNames.contains('meta')) r.result.createObjectStore('meta');
      };
      r.onsuccess = (): void => res(r.result);
      r.onerror = (): void => rej(r.error);
    });
    const put = (store: string, key: string, val: unknown): Promise<void> =>
      new Promise((res, rej) => {
        const t = db.transaction(store, 'readwrite');
        t.objectStore(store).put(val, key);
        t.oncomplete = (): void => res();
        t.onerror = (): void => rej(t.error);
      });

    await put('files', 'soffice.js', new Blob(['window.soffice_entry = function () {};']));
    await put('files', 'qtloader.js', new Blob([qtLoaderJs]));
    await put('files', 'soffice.data.js.metadata', new Blob(['{}']));
    await put('files', 'soffice.wasm.gz', await gz('not a wasm module'));
    await put('files', 'soffice.data.gz', await gz('fake package bytes'));
    // ⚠ **フォントを 0 件にしない** ── 0 件の次元は「測っていない次元」である
    await put('files', 'fonts/Good.ttf', new Blob(['font-a']));
    await put('files', 'fonts/Bad.ttf', new Blob(['font-b']));
    await put('meta', 'pack', {
      version: 'fake',
      installedAt: 1,
      source: 'file',
      totalBytes: 6,
      files: [{ name: 'soffice.js' }, { name: 'fonts/Good.ttf' }, { name: 'fonts/Bad.ttf' }],
    });
    db.close();
  }, opts);
}

test('🔴 偽の一式で起動経路が通り、フォントが 1 本こけても起動は続く', async ({ page }) => {
  // ⚠ 仕込みは**ページを開いてから**(IDB は origin に紐づく)。
  //    一度開いて仕込み、読み直してから本番の経路を走らせる
  await page.goto('/office/host.html');
  await seedFakePack(page, { badFont: 'Bad.ttf' });
  await page.reload();

  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });
  // 覆いが本当に退いている(B-2 が起動経路でも効いている)
  expect(
    await page.evaluate(
      () => getComputedStyle(document.getElementById('msg') as HTMLElement).display,
    ),
  ).toBe('none');

  const written = await page.evaluate(() => (window as unknown as { __written: string[] }).__written);
  // 🔑 **こけた 1 本を飛ばして、残りは入っている**(以前は 1 本で起動ごと落ちた)
  expect(written.some((p) => p.endsWith('Good.ttf')), '正常なフォントが入っていない').toBe(true);
  expect(written.some((p) => p.endsWith('Bad.ttf'))).toBe(false);
  // 展開した package は受け取られている(この次元が 0 だと下の解放の検査も無意味になる)
  expect(await page.evaluate(() => (window as unknown as { __pkg?: ArrayBuffer }).__pkg?.byteLength))
    .toBeGreaterThan(0);

  /**
   * 🔴 **展開した 148MB を抱えたままにしない**(不可侵: 生成物は寿命終端で破棄)。
   *
   * 🔑 観測できる ── `getPreloadedPackage` は `dataBuf` を掴む閉包なので、
   * 手放していれば**もう一度呼ぶと null が返る**。
   * ⚠ `__pkg` を持っているのは test 側であって、ページ側ではない。
   */
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __cfg: { getPreloadedPackage: () => unknown } }).__cfg
          .getPreloadedPackage() === null,
    ),
    '展開した package を抱えたまま(窓を閉じるまで 148MB 常駐する)',
  ).toBe(true);
});

/**
 * 🔴 **LO の窓を器いっぱいで開かせる**(2026-08-12 に実物の LO で確かめた)。
 *
 * 既定では窓が器より小さく出る ── そして狭い窓は、項目の多いメニューを
 * **多段カラムに折り返して画面全体を塗りつぶす**(「クリックしたら画面が壊れた」)。
 *
 * ⚠ **単位は device px**。実測で、同じ 1400x800 の器に CSS px を書くと
 * DPR 2 では 700x624 の窓になった(半分)。`devicePixelRatio` を掛けて 2800x1600 を
 * 書いて初めてぴったりになる。**ここを間違えると「直したのに小さい」になる。**
 */
test('🔴 窓の大きさを、器の device px で仕込んでから起動する', async ({ browser }) => {
  /**
   * ⚠ **DPR 2 で回す。** 既定(DPR 1)では device px と CSS px が同じ値になるので、
   * **取り違えても通ってしまう** ── 実機(mac / DPR 2)で起きた欠陥が
   * CI で 1 件も鳴らない、いちばん質の悪い形になる。
   */
  const ctx = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  try {
  expect(await page.evaluate(() => window.devicePixelRatio), 'DPR が 1 のまま = 取り違えを検出できない').toBe(2);
  await page.goto('/office/host.html');
  await seedFakePack(page);
  await page.reload();
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });

  const seen = await page.evaluate(() => {
    const w = window as unknown as { __xcu?: string; __order: string[] };
    const r = (document.getElementById('screen') as HTMLElement).getBoundingClientRect();
    const k = window.devicePixelRatio || 1;
    // ⚠ **客域 = 器 − 装飾**(Qt が枠 8px と疑似タイトルバー 22px を外側に描く)。
    //    器をそのまま渡すと窓が下へ 30px はみ出し、LO のステータスバーが画面外へ落ちる
    return {
      xcu: w.__xcu ?? '',
      order: w.__order,
      want: `0,0,${Math.round((Math.round(r.width) - 8) * k)},${Math.round((Math.round(r.height) - 30) * k)};`,
      naive: `0,0,${Math.round(r.width * k)},${Math.round(r.height * k)};`,
    };
  });
  // ⚠ **書かれた値そのもの**を見る(「書いた」だけでは、CSS px のままでも通る)
  expect(seen.xcu, `器 − 装飾 の device px が入っていない(want ${seen.want})`).toContain(seen.want);
  // 🔑 **器をそのまま渡していないこと**まで見る(装飾ぶんを引き忘れた形を殺す)
  expect(seen.xcu, '器の寸法をそのまま渡している(窓が装飾ぶんはみ出す)').not.toContain(seen.naive);
  expect(seen.xcu).toContain('ooSetupFactoryWindowAttributes');
  // 起動を待つ Start Center も対象(文書を開かない道が抜けやすい)
  expect(seen.xcu).toContain('com.sun.star.frame.StartModule');
  // 🔑 **順番**。`callMain` の後に書いても、設定はもう読まれている
  expect(seen.order, '窓の大きさを起動より後に書いている').toEqual(['xcu', 'callMain']);
  } finally {
    await ctx.close();
  }
});

/**
 * ⚠ **器が測れないときは、大きさを頼まない。**
 *
 * 🔑 `0,0,0,0` を書くと LO は**潰れた窓**を開く ── 既定の小さい窓よりはるかに悪い。
 * 「書かない」ほうが正しい場面が在る、という判断そのものを検査する。
 */
test('🔴 器が測れないときは、窓の大きさを頼まない(潰れた窓を作らない)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    // ⚠ ページの script より**先に**効かせる(器の大きさは起動中に読まれる)
    await ctx.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const st = document.createElement('style');
        st.textContent = '#screen{position:static !important;width:0 !important;height:0 !important}';
        document.head.appendChild(st);
      });
    });
    await page.goto('/office/host.html');
    await seedFakePack(page);
    await page.reload();
    await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });

    // 空振り防止 ── 器が本当に 0 になっていること
    expect(
      await page.evaluate(
        () => (document.getElementById('screen') as HTMLElement).getBoundingClientRect().width,
      ),
      'この test の前提(器が測れない)が成り立っていない',
    ).toBeLessThan(1);
    expect(
      await page.evaluate(() => (window as unknown as { __xcu?: string }).__xcu),
      '器が 0 なのに大きさを頼んでいる(潰れた窓になる)',
    ).toBeUndefined();
  } finally {
    await ctx.close();
  }
});

test('🔴 LO 側の異常終了(onExit crashed)が画面に出る', async ({ page }) => {
  await page.goto('/office/host.html');
  await seedFakePack(page);
  await page.reload();
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });

  // 🔴 **実機で実際に来た形**(2026-08-12 の調査ログ)
  await page.evaluate(() => {
    // ⚠ 本体への放送も受ける ── 同じ名前の別 instance には届く(自分だけ届かない)
    const heard: unknown[] = [];
    (window as unknown as { __heard: unknown[] }).__heard = heard;
    new BroadcastChannel('pkc3-office').onmessage = (e): void => {
      heard.push(e.data);
    };
    const cfg = (window as unknown as { __cfg: { qt: { onExit: (d: unknown) => void } } }).__cfg;
    cfg.qt.onExit({ text: "'HEAPU8' was not exported", crashed: true });
  });
  await expect(page.locator('#status')).toHaveText('停止');
  await expect(page.locator('#msg .why')).toContainText('HEAPU8');

  /**
   * 🔑 **本体へも知らせる。** 再現条件は user の手元にしか無いので、
   * 窓の中だけで完結させると集まらない(調査レポートの指摘)。
   */
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (window as unknown as { __heard: { pkc3Office?: string }[] }).__heard.map(
          (m) => m.pkc3Office,
        ),
      ),
    )
    .toContain('crashed');
});

/**
 * 🔴 **「死んだ」より先に「効かなくなった」が来る**(検証レポート #3)。
 *
 * LO のスレッドが 1 本落ちると、**版面は生きたまま保存とメニューだけが通らなくなる**。
 * ⚠ メニューは開いて項目もハイライトされるので、**user は壊れたことに気づけない** ──
 * そして保存が黙って失敗する。abort ではないので停止の面は出ない。
 *
 * ## ⚠ 本文は `e.message` に入っていない
 *
 * emscripten の `worker.onerror` は ErrorEvent を **`throw e` で投げ直す**ので、
 * window の error は `message = "Uncaught #<ErrorEvent>"` になり、
 * **中身は `e.error.message` 側**に入る。だからこの test の外側の message には
 * 手がかりを 1 文字も入れていない ── 片方しか見ない実装は必ず落ちる。
 */
test('🔴 スレッドが落ちて命令が通らなくなったら、そう出す(停止とは別に)', async ({ page }) => {
  await page.goto('/office/host.html');
  await seedFakePack(page);
  await page.reload();
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });

  const heard = await page.evaluate(() => {
    const got: unknown[] = [];
    (window as unknown as { __heard: unknown[] }).__heard = got;
    new BroadcastChannel('pkc3-office').onmessage = (e): void => {
      got.push(e.data);
    };
    // ⚠ 実機と同じ形 ── 外側は素の "Uncaught #<ErrorEvent>"、中身に本文
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'Uncaught #<ErrorEvent>',
        error: new ErrorEvent('error', {
          message: 'Uncaught TypeError: func is not a constructor',
        }),
      }),
    );
    return got;
  });
  void heard;

  await expect(page.locator('#status')).toHaveText('不安定');
  await expect(page.locator('#warn')).toBeVisible();
  // 🔑 **失うものを先に言う。** 「不安定」だけでは user は保存を試み続ける
  await expect(page.locator('#warn')).toContainText('保存');
  await expect(page.locator('#warn button')).toHaveCount(1);

  // 🔴 **停止とは別物**。版面は触れるまま(本文を読んで写せる状態を残す)
  expect(
    await page.evaluate(
      () => getComputedStyle(document.getElementById('screen') as HTMLElement).pointerEvents,
    ),
    '版面を触れなくしている(停止と取り違えている)',
  ).not.toBe('none');
  await expect(page.locator('#msg')).toBeHidden();

  await expect
    .poll(async () =>
      page.evaluate(() =>
        (window as unknown as { __heard: { pkc3Office?: string }[] }).__heard.map(
          (m) => m.pkc3Office,
        ),
      ),
    )
    .toContain('degraded');
});

/**
 * ⚠ **abort のほうが重い。** 両方に当たる文言が来たら停止として扱う ──
 * 逆にすると、死んでいる版面を「不安定」と言って触らせ続けることになる。
 */
test('🔴 停止と不安定を取り違えない', async ({ page }) => {
  await page.goto('/office/host.html');
  await seedFakePack(page);
  await page.reload();
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });

  await page.evaluate(() =>
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'Uncaught #<ErrorEvent>',
        error: new ErrorEvent('error', {
          // ⚠ 両方の signature を含む
          message: "Aborted('PThread' was not exported) — worker sent an error!",
        }),
      }),
    ),
  );
  await expect(page.locator('#status')).toHaveText('停止');
  await expect(page.locator('#warn')).toBeHidden();
});

test('🔴 本体を読み込めないときも、宙吊りにならず画面に出る', async ({ page }) => {
  await page.goto('/office/host.html');
  await seedFakePack(page, { breakWasm: true });
  await page.reload();

  /**
   * ⚠ ここは `qtLoad` が**解決も棄却もしない**経路である(本物と同じ)。
   * `await` の先の catch には入らないので、`instantiateWasm` の失敗を
   * その場で出せていなければ **「起動中…」のまま永久に止まる**。
   */
  await expect(page.locator('#status')).toHaveText('停止', { timeout: 15_000 });
  await expect(page.locator('#msg')).toContainText('本体を読み込めません');
  expect(
    await page.evaluate(() => (window as unknown as { __okCalled?: boolean }).__okCalled),
    '失敗したのに ok() を呼んでいる',
  ).toBeUndefined();
});

/**
 * キーを 1 つ投げて **2 つ**観測する。
 *
 * - `prevented` … ブラウザの既定を止めたか(`Ctrl+S` の「ページを保存」など)
 * - `reached` … **後から登録された listener に届いたか**(= Qt が受け取れるか)
 *
 * 🔑 この 2 つは別の主張である。片方だけ見ると、「既定を止める」つもりで
 * **LO のショートカットごと殺した**変更が素通りする。
 */
interface KeyProbe {
  readonly prevented: boolean;
  readonly reached: boolean;
}

async function probeKeys(page: import('@playwright/test').Page): Promise<{
  ctrlS: KeyProbe;
  metaS: KeyProbe;
  ctrlC: KeyProbe;
  metaC: KeyProbe;
  ctrlA: KeyProbe;
  metaA: KeyProbe;
  altGr: KeyProbe;
  plain: KeyProbe;
}> {
  return page.evaluate(() => {
    const hit = (init: KeyboardEventInit): { prevented: boolean; reached: boolean } => {
      let reached = false;
      const spy = (): void => {
        reached = true;
      };
      // ⚠ ページ側の listener は capture で先に登録済み。こちらは後なので、
      //    `stopImmediatePropagation` されれば呼ばれない
      window.addEventListener('keydown', spy);
      const alive = window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      );
      window.removeEventListener('keydown', spy);
      return { prevented: !alive, reached };
    };
    return {
      ctrlS: hit({ key: 's', ctrlKey: true }),
      metaS: hit({ key: 's', metaKey: true }),
      ctrlC: hit({ key: 'c', ctrlKey: true }),
      metaC: hit({ key: 'c', metaKey: true }),
      ctrlA: hit({ key: 'a', ctrlKey: true }),
      metaA: hit({ key: 'a', metaKey: true }),
      altGr: hit({ key: '@', ctrlKey: true, altKey: true }),
      plain: hit({ key: 'a' }),
    };
  });
}
