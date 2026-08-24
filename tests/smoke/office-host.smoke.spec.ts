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
 * @param opts.alienPack 目録に `cui/ui/querydialog.ui` を入れる(= 非 ODF を保存できる
 *   一式。#225)。⚠ 既定は**入れない** ── 古い一式のほうが既定である
 */
async function seedFakePack(
  page: import('@playwright/test').Page,
  opts: { badFont?: string; breakWasm?: boolean; alienPack?: boolean } = {},
): Promise<void> {
  await page.evaluate(async ({ badFont, breakWasm, alienPack }) => {
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
              window.__files = window.__files || {};
              window.__files[p] = String(data);
              // ⚠ 保存の判定は size と mtime の両方を見る ── 書くたびに進める
              window.__mtimes = window.__mtimes || {};
              window.__mtimes[p] = (window.__mtimes[p] || 0) + 1000;
              if (p.indexOf('registrymodifications.xcu') !== -1) {
                window.__xcu = String(data);
                window.__order.push('xcu');
              }
            },
            // ⚠ **stub は本物の意味論を真似る**: 無い file は throw(#159 の退避が
            //    「file がまだ無い」を静かに飛ばせることを、本物と同じ形で確かめる)
            readFile: function (p) {
              window.__files = window.__files || {};
              if (!(p in window.__files)) throw new Error('ENOENT: ' + p);
              return window.__files[p];
            },
            // 保存を捉える経路(#205)を実際に走らせるための最小の FS。
            //  これが無いと armSaveWatch は積まれても一度も通らない
            //  (CLAUDE.md 検証の規律 2「弱いのではなく走っていない」)。
            //  stub は本物の意味論を真似る: open が返す stream は path を持ち
            //  (FS.getPath(node) 由来)、stat().mtime は Date である
            open: function (p) {
              window.__files = window.__files || {};
              if (!(p in window.__files)) throw new Error('ENOENT: ' + p);
              return { path: p, position: 0 };
            },
            close: function () {},
            read: function (stream, buf, off, len, pos) {
              var bytes = new TextEncoder().encode(window.__files[stream.path]);
              var n = Math.min(len, bytes.length - pos);
              if (n <= 0) return 0;
              buf.set(bytes.subarray(pos, pos + n), off);
              return n;
            },
            stat: function (p) {
              window.__files = window.__files || {};
              if (!(p in window.__files)) throw new Error('ENOENT: ' + p);
              var bytes = new TextEncoder().encode(window.__files[p]);
              window.__mtimes = window.__mtimes || {};
              return { size: bytes.length, mtime: new Date(window.__mtimes[p] || 1) };
            },
            rename: function (a, b) {
              window.__files[b] = window.__files[a];
              delete window.__files[a];
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

    // ⚠ **worker としても走れる形**にする ── 下の test が、host が emscripten へ
    //    渡したのと**同じ script**から実 Worker を起こして中を見る
    const sofficeJs = [
      "self.__selfUrl = (typeof document !== 'undefined' && document.currentScript)",
      "  ? document.currentScript.src : self.location.href;",
      'self.soffice_entry = function () {};',
      "if (typeof window === 'undefined') {",
      '  self.onmessage = function (ev) {',
      '    if (ev.data && ev.data.copy) {',
      '      // 🔑 LO と**同じ形**で呼ぶ(実測: text/plain の Blob 1 件)',
      "      var item = new ClipboardItem({ 'text/plain': new Blob([ev.data.copy], { type: 'text/plain' }) });",
      '      navigator.clipboard.write([item]).then(',
      "        function () { self.postMessage({ wrote: 'resolved' }); },",
      "        function (e) { self.postMessage({ wrote: 'rejected: ' + String(e && e.message) }); },",
      '      );',
      '      return;',
      '    }',
      '    var made;',
      '    try { made = !!new ClipboardItem({}); } catch (e) { made = String(e && e.message).slice(0, 60); }',
      '    self.postMessage({',
      "      clipboardItem: typeof ClipboardItem,",
      "      clipboard: typeof (self.navigator && self.navigator.clipboard),",
      '      made: made,',
      '    });',
      '  };',
      '}',
    ].join('\n');
    await put('files', 'soffice.js', new Blob([sofficeJs]));
    await put('files', 'qtloader.js', new Blob([qtLoaderJs]));
    /**
     * 🔴 **目録は「非 ODF を保存できるか」の判定材料でもある**(#225)。
     *
     * ⚠ 囮(古い一式にも在る 3 つ)を**必ず一緒に**入れる ── 入れないと、
     * 判定を部分一致へ書き戻す変異が**この検査を素通りする**。
     */
    const CFG = '/instdir/share/config/soffice.cfg';
    const uiNames = [
      CFG + '/vcl/ui/querydialog.ui',
      CFG + '/modules/scalc/ui/recalcquerydialog.ui',
      CFG + '/sfx/ui/safemodequerydialog.ui',
    ];
    if (alienPack) uiNames.push(CFG + '/cui/ui/querydialog.ui');
    await put(
      'files',
      'soffice.data.js.metadata',
      new Blob([
        JSON.stringify({
          files: uiNames.map((n, i) => ({ filename: n, start: i, end: i + 1 })),
        }),
      ]),
    );
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
      want: `${Math.round(4 * k)},0,${Math.round((Math.round(r.width) - 8) * k)},${Math.round((Math.round(r.height) - 30) * k)};`,
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

/**
 * 🔴 **user プロファイルを再読み込みの向こうへ残す**(#159)。
 *
 * LO の設定(`registrymodifications.xcu`)は MEMFS に在り、再読み込みで消える ──
 * UI 言語を変えても再起動で既定へ戻る(実機レポート #8 で確定)。
 * host が localStorage へ退避・復元する。
 *
 * ⚠ 観測点は 3 つとも「file / storage の中身そのもの」── 「呼んだ」では、
 * 中身を壊す形(幾何の重複 / 壊れた XML の書き戻し)が通ってしまう。
 */
test('🔴 保存済みの設定が boot で書き戻り、幾何だけ今の器で上書きされる(#159)', async ({ page }) => {
  await page.goto('/office/host.html');
  await seedFakePack(page);
  await page.evaluate(() => {
    // 前セッションの退避を再現: user が変えた設定(ooLocale)+ **古い幾何**
    localStorage.setItem('pkc3-office-profile', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<oor:items xmlns:oor="http://openoffice.org/2001/registry">',
      '<item oor:path="/org.openoffice.Office.Linguistic/General">',
      '<prop oor:name="UILocale" oor:op="fuse"><value>en-US</value></prop></item>',
      '<item oor:path="/org.openoffice.Setup/Office/Factories/x">',
      '<prop oor:name="ooSetupFactoryWindowAttributes" oor:op="fuse">',
      '<value>9999,9999,9999,9999;4;0,0,0,0;</value></prop></item>',
      '</oor:items>',
    ].join(''));
  });
  await page.reload();
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });

  const seen = await page.evaluate(() => {
    const w = window as unknown as { __xcu?: string; __order: string[] };
    return { xcu: w.__xcu ?? '', order: w.__order };
  });
  // ① user の設定が戻っている
  expect(seen.xcu, '退避した設定が書き戻っていない').toContain('UILocale');
  expect(seen.xcu).toContain('en-US');
  // ② 🔴 幾何は**保存時のものを捨てて**今の器で仕込む(古い幾何は窓を壊す)
  expect(seen.xcu, '保存時の古い幾何が残っている').not.toContain('9999,9999');
  expect(seen.xcu).toContain('ooSetupFactoryWindowAttributes');
  // ⚠ 幾何 prop は seed の 9 面ぶん**だけ**(重複が在ると「後の item が勝つ」という
  //    未検証の順序意味論に賭けることになる ── 賭けを作らないことを pin する)
  expect(seen.xcu.split('ooSetupFactoryWindowAttributes').length - 1).toBe(9);
  // ③ 起動より前に書いている
  expect(seen.order, '設定を起動より後に書いている').toEqual(['xcu', 'callMain']);
});

test('🔴 LO が書いた設定が pagehide で localStorage へ残る(#159)', async ({ page }) => {
  await page.goto('/office/host.html');
  await seedFakePack(page);
  await page.reload();
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });

  const saved = await page.evaluate(() => {
    const w = window as unknown as { __lo: { FS: { writeFile: (p: string, d: string) => void } } };
    // 空振り防止 ── 退避はまだ無い(seed 直後の中身は基準線として除外されている)
    const before = localStorage.getItem('pkc3-office-profile');
    // LO が設定を書いたことを再現(fake FS は中身を保持し readFile で返す)
    w.__lo.FS.writeFile(
      '/instdir/user/registrymodifications.xcu',
      '<oor:items><item><prop oor:name="PKC3_TEST_MARKER"/></item></oor:items>',
    );
    window.dispatchEvent(new Event('pagehide'));
    return { before, after: localStorage.getItem('pkc3-office-profile') };
  });
  expect(saved.before, '書く前から退避が在る = この test は何も測っていない').toBeNull();
  expect(saved.after ?? '', '閉じる前の退避が動いていない').toContain('PKC3_TEST_MARKER');
});

test('⚠ 壊れた退避は書き戻さず、素で始める(起動を落とさない)(#159)', async ({ page }) => {
  await page.goto('/office/host.html');
  await seedFakePack(page);
  await page.evaluate(() => {
    // ⚠ 壊し方は「**根は正しく、中で壊れている**」形にする(閉じタグの不一致)。
    //    根から壊す(`oor:` 未宣言 等)と root の検査が先に拾ってしまい、
    //    parsererror の検査は**この test では 1 度も通らない**(変異試験 M4 が
    //    2 度目にそれで生き延びた ── 「分岐を書いたら分岐の数だけ走らせる」)。
    localStorage.setItem(
      'pkc3-office-profile',
      '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
        + '<item>BROKEN_TEST_MARKER</wrong>',
    );
  });
  await page.reload();
  // 🔴 起動そのものが通る(壊れた XML で die しない)
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });
  const xcu = await page.evaluate(() => (window as unknown as { __xcu?: string }).__xcu ?? '');
  // ⚠ 観測点は「壊れた字面が残るか」では**足りない** ── DOMParser は壊れた XML でも
  //    部分木を返すので、壊れた断片は serialize 結果に**そもそも現れない**(変異試験
  //    M4 が最初この形で生き延びた)。実害は「**壊れた退避を土台に使う**」ことなので、
  //    ① parsererror 要素を LO へ書いていない ② 素の骨組み(XML 宣言つき)で
  //    始め直している、の 2 点で見る ── 復元経路の serialize 出力は宣言を持たないため、
  //    宣言の有無が「土台を捨てたか」の判別になる。
  expect(xcu, '壊れた退避を LO へ書き戻している(起動ごと壊しうる)').not.toContain('BROKEN_TEST_MARKER');
  expect(xcu, 'parsererror 要素ごと LO へ書いている(壊れた退避を土台にした)').not.toContain('parsererror');
  expect(xcu.startsWith('<?xml'), '壊れた退避を土台に使っている(素の骨組みで始まっていない)').toBe(true);
  // 素の骨組みで始まっている(幾何は入る)
  expect(xcu).toContain('ooSetupFactoryWindowAttributes');
});

/**
 * 🔴 **worker に `ClipboardItem` を生やしてから emscripten に渡す**(#124)。
 *
 * LO のコピーは pthread(Worker)の中で `val::global("ClipboardItem")` を掴んで
 * `val::new_()` する。⚠ worker にそれは無く、`val::global` は例外ではなく
 * `undefined` を返すので、生成コードの `new func(...)` が
 * `TypeError: func is not a constructor` になり **その pthread が死ぬ** ──
 * 版面は生きたまま保存とメニューだけが無反応になる。
 *
 * 🔑 **観測点は「worker の中」でなければ意味がない。** メインスレッドには
 * `ClipboardItem` が在るので、こちらで `typeof` を見ても**必ず通ってしまう**。
 * だから host が emscripten へ渡したのと**同じ script から実 Worker を起こす**。
 */
test('🔴 emscripten へ渡す script は、worker で ClipboardItem を持っている', async ({ page }) => {
  await page.goto('/office/host.html');
  await seedFakePack(page);
  await page.reload();
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });

  const seen = await page.evaluate(async () => {
    const url = (window as unknown as { __selfUrl?: string }).__selfUrl;
    if (!url) throw new Error('__selfUrl が無い(fake の soffice.js が動いていない)');
    // 空振り防止 ── **blob から読ませている**こと(素の path なら shim を通らない)
    const isBlob = url.startsWith('blob:');
    const w = new Worker(url);
    const got = await new Promise<Record<string, unknown>>((res, rej) => {
      const t = setTimeout(() => rej(new Error('worker が返事をしない')), 10_000);
      w.onmessage = (e): void => {
        clearTimeout(t);
        res(e.data as Record<string, unknown>);
      };
      w.onerror = (e): void => {
        clearTimeout(t);
        rej(new Error(`worker error: ${e.message}`));
      };
      w.postMessage('ask');
    });
    w.terminate();
    return {
      isBlob,
      clipboardItem: String(got.clipboardItem),
      clipboard: String(got.clipboard),
      made: got.made,
    };
  });

  expect(seen.isBlob, 'blob から読ませていない(shim を通す経路になっていない)').toBe(true);
  expect(seen.clipboardItem, 'worker に ClipboardItem が無い(コピーで pthread が死ぬ)').toBe(
    'function',
  );
  // 🔑 **`new` できること**まで見る ── 名前が在るだけでは `val::new_()` は通らない
  expect(seen.made, 'ClipboardItem を new できない').toBe(true);
  expect(seen.clipboard, 'worker に navigator.clipboard が無い').toBe('object');
});

/**
 * 🔴 **worker のコピーを、こちらで本物のクリップボードへ書く**(#130)。
 *
 * ⚠ worker には `navigator.clipboard` が**存在しない**(`WorkerNavigator` に無い)。
 * `document` も無いので `copy` event の経路も使えない ── **worker から system
 * clipboard へ触る手段は 1 つも無い**。だから放送で host 側へ回す。
 *
 * 🔑 **観測点は「system clipboard に本当に載ったか」**。worker の Promise が
 * 解決しただけでは足りない ── この shim は**失敗しても resolve する**ので、
 * 解決だけ見ると**橋を外しても通ってしまう**。
 */
test('🔴 worker のコピーが system clipboard に載る', async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  try {
    await page.goto('/office/host.html');
    await seedFakePack(page);
    await page.reload();
    await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });

    const text = `橋-${String(Date.now())}`;
    const wrote = await page.evaluate(async (payload) => {
      const url = (window as unknown as { __selfUrl?: string }).__selfUrl;
      if (!url) throw new Error('__selfUrl が無い');
      const w = new Worker(url);
      const t0 = performance.now();
      const got = await new Promise<string>((res, rej) => {
        const t = setTimeout(() => rej(new Error('worker が返事をしない')), 15_000);
        w.onmessage = (e): void => {
          clearTimeout(t);
          res(String((e.data as { wrote?: string }).wrote));
        };
        w.postMessage({ copy: payload });
      });
      w.terminate();
      return { got, ms: performance.now() - t0 };
    }, text);
    expect(wrote.got, 'worker 側の write が解決していない').toBe('resolved');
    /**
     * 🔴 **返事が来ていることを、時間で見る。**
     *
     * shim は返事が来なくても 5 秒で諦めて resolve する(LO を hang させないため)。
     * ⚠ つまり **返事を返さない実装でも「解決した」だけは通る** ── 実際、変異試験で
     * そこだけ生き延びた。user から見ると**コピーのたびに 5 秒固まる**。
     * 🔑 桁が 3 つ違う(数 ms 対 5000ms)ので、時間で見分けられる。
     */
    expect(wrote.ms, 'コピーの返事が返っていない(諦めの待ちで解決している)').toBeLessThan(1500);

    // 🔴 **ここが本体**。橋を外すと、上は通るがここで落ちる
    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 })
      .toBe(text);
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

/**
 * 🔴 **生存通知に「窓が表に居たか」が載っている**(#135)。
 *
 * 本体は「4 秒来なければ固まった」と判定するが、⚠ **背面タブの `setInterval` は
 * 絞られる**(5 分ほどで 1 分に 1 回)ので、その物差しは**窓が表に居たときにしか
 * 当てられない**。載っていなければ本体は保守側(70 秒)へ倒れ、
 * **ハングに気づくのが 17 倍遅くなる** ── しかも誰も落ちない。
 *
 * ⚠ **`host.html` は bundle されない生 HTML** なので unit が 1 つも届かない。
 * ここで実物を走らせて、**放送に実際に届いていること**を見る
 * (CLAUDE.md「材料が実際に届いていることを pin する」)。
 *
 * 🔴 **表と裏の両方を見る。** 表だけ見ると、`{ visible: true }` を**べた書き**した
 * 実装が素通りする ── 変異試験で実際に生き延びた(M12)。値が
 * `document.visibilityState` から来ていることは、**裏で false になる**ことでしか
 * 示せない。⚠ 裏は property の差し替えで作る(実際に背面へ回すと**タイマーごと
 * 絞られて**、この test が測りたいものではなくなる)。
 */
async function firstBeats(
  page: import('@playwright/test').Page,
): Promise<{ pkc3Office?: string; payload?: { visible?: unknown } }[]> {
  // ⚠ 一式は要らない ── 生存通知は起動経路より手前で始まる
  return page.evaluate(
    () =>
      new Promise<{ pkc3Office?: string; payload?: { visible?: unknown } }[]>((resolve) => {
        const got: { pkc3Office?: string; payload?: { visible?: unknown } }[] = [];
        // ⚠ 同じ名前の**別 instance** なら自分のページの放送も届く
        const ch = new BroadcastChannel('pkc3-office');
        ch.onmessage = (e): void => {
          const d = e.data as { pkc3Office?: string; payload?: { visible?: unknown } };
          if (d.pkc3Office === 'alive') got.push(d);
          // 2 発めまで見る ── 初回だけ手で送っている作りに救われないため
          if (got.length >= 2) {
            ch.close();
            resolve(got);
          }
        };
      }),
    // 1.5 秒間隔なので 2 発で 3 秒強
  );
}

test('🔴 生存通知が「窓が表に居たか」を運ぶ', async ({ page }) => {
  await page.goto('/office/host.html');
  const beats = await firstBeats(page);

  expect(beats.length, '生存通知が 2 発来ていない').toBeGreaterThanOrEqual(2);
  for (const b of beats) {
    // 🔑 **型まで見る。** 欠けていると本体側で `=== true` が false に落ち、
    //    黙って保守側の物差し(70 秒)へ倒れる
    expect(typeof b.payload?.visible, '生存通知に visible が無い').toBe('boolean');
  }
  expect(beats[beats.length - 1]?.payload?.visible).toBe(true);
});

test('🔴 裏に居るときは、そう名乗る(値がべた書きでない)', async ({ page }) => {
  // ⚠ **読み込みより前**に差し替える ── host は最初の 1 発をその場で撃つ
  await page.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
  });
  await page.goto('/office/host.html');
  // 空振り防止 ── 差し替えが本当に効いているか(効いていなければこの test は無意味)
  expect(await page.evaluate(() => document.visibilityState)).toBe('hidden');

  const beats = await firstBeats(page);
  expect(beats.length).toBeGreaterThanOrEqual(2);
  for (const b of beats) {
    expect(b.payload?.visible, '裏に居るのに「表」と名乗っている').toBe(false);
  }
});

/**
 * 🔴 **保存が PKC へ届く**(#205 段 A)── 窓の側の**端から端まで**。
 *
 * ⚠ この経路は unit では届かない部分が 3 つある(hook の装着 / OPFS への
 * 書き出し / 放送)。⚠ そして「積んだ」ことを見るだけの test は無意味である
 * ── `armSaveWatch` を呼ぶだけなら、hook が空でも通る(CLAUDE.md §2)。
 * 🔑 だから観測点は **①棚に bytes が入ったこと**と**②鍵の放送が届いたこと**の 2 つ。
 *
 * ⚠ 保存の形は 2 通りある(実測):既存 path の上書き = **rename**、
 * 新規保存 = 最終 path へ直接 **write + close**。**両方**を当てる。
 */
test('🔴 Office の保存が、棚に置かれて鍵が放送される(新規 = close / 上書き = rename)', async ({
  page,
}) => {
  await page.goto('/office/host.html');
  await seedFakePack(page);
  // ⚠ **前の test の残骸を消す**(棚は origin 共有 ── 残っていると数が合わない)
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('pkc3-office-stage', { recursive: true }).catch(() => {});
  });
  /**
   * 🔴 **合言葉(lid)を預けた状態で開く**(2026-08-16、着地前レビュー R3)。
   * ⚠ この中段 ── 窓が `document` の payload から token を覚え、staging の meta に
   * 載せるところ ── には test が 1 件も無く、**主機能を殺す変異が 3 本生き延びて**
   * いた(全部の保存が「新規ノート」になり、元のノートは二度と更新されない)。
   */
  await page.addInitScript(() => {
    const ch = new BroadcastChannel('pkc3-office');
    ch.onmessage = (ev: MessageEvent): void => {
      const d = ev.data as { pkc3Office?: string };
      if (d?.pkc3Office !== 'ready-for-document') return;
      ch.postMessage({
        pkc3Office: 'document',
        payload: {
          name: '報告書.odt',
          bytes: new TextEncoder().encode('ORIGINAL'),
          token: 'lid-TEST',
        },
      });
    };
  });
  await page.goto('/office/host.html?name=%E5%A0%B1%E5%91%8A%E6%9B%B8.odt&await-doc=1');
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });
  // 空振り防止 ── 文書が実際に流し込まれたか(流れていなければ token も検査できない)
  expect(
    await page.evaluate(() => (window as unknown as { __loDocPath?: string }).__loDocPath),
    '文書が流し込まれていない ── この test は合言葉を検査できていない',
  ).toBe('/work/報告書.odt');

  const got = await page.evaluate(async () => {
    const w = window as unknown as {
      __lo: {
        FS: {
          writeFile(p: string, d: string): void;
          open(p: string): unknown;
          close(s: unknown): void;
          rename(a: string, b: string): void;
          mkdirTree(p: string): void;
        };
      };
    };
    const seen: Array<{ key: string; name: string; size: number }> = [];
    const ch = new BroadcastChannel('pkc3-office');
    ch.onmessage = (ev: MessageEvent): void => {
      const d = ev.data as { pkc3Office?: string; payload?: { key: string; name: string; size: number } };
      if (d?.pkc3Office === 'saved' && d.payload) seen.push(d.payload);
    };

    // ⚠ stub は本物と同じく親ディレクトリを要求する(MEMFS の ENOENT)
    w.__lo.FS.mkdirTree('/home/web_user');
    w.__lo.FS.mkdirTree('/work');
    // ① **開いた文書以外**の新規保存 = 最終 path へ直接 write して close
    w.__lo.FS.writeFile('/home/web_user/無題 1.odt', 'NEW-DOC-BYTES');
    w.__lo.FS.close(w.__lo.FS.open('/home/web_user/無題 1.odt'));
    // ② **開いた当の文書**の上書き = temp へ書いて rename で置換
    w.__lo.FS.writeFile('/work/lu42.tmp', 'OVERWRITTEN-BYTES!!');
    w.__lo.FS.rename('/work/lu42.tmp', '/work/報告書.odt');

    // 静穏(700ms)+ 見張り(500ms)を越えるまで待つ
    const t0 = Date.now();
    while (seen.length < 2 && Date.now() - t0 < 12_000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    ch.close();

    // 棚の中身を読む(本体のタブが引き取るのと同じ場所)
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('pkc3-office-stage', { create: true });
    const files: Record<string, string> = {};
    for await (const [name, handle] of (
      dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }
    ).entries()) {
      files[name] = await (await handle.getFile()).text();
    }
    return { seen, files };
  });

  // ── ①「保存された」が 2 通、鍵つきで届く ─────────────────────────
  expect(got.seen.map((s) => s.name).sort(), '保存の放送が届いていない').toEqual([
    '報告書.odt',
    '無題 1.odt',
  ]);
  for (const s of got.seen) {
    expect(s.key, '鍵が空 ── 引き取る側が棚を引けない').not.toBe('');
    expect(s.size, '大きさが 0').toBeGreaterThan(0);
  }

  // ── ② 棚に **bytes そのもの**が入っている(放送だけでは届いていない)──
  const bins = Object.entries(got.files).filter(([n]) => n.endsWith('.bin'));
  expect(bins.length, '棚に bytes が置かれていない').toBe(2);
  expect(bins.map(([, v]) => v).sort(), '棚の中身が保存した bytes でない').toEqual([
    'NEW-DOC-BYTES',
    'OVERWRITTEN-BYTES!!',
  ]);
  // 🔑 meta は **`.json` が commit の印**(`.bin` を先に閉じてから置く)
  const metas = Object.entries(got.files).filter(([n]) => n.endsWith('.json'));
  expect(metas.length).toBe(2);
  const byName = new Map<string, { key: string; name: string; token?: string; v: number }>();
  for (const [, text] of metas) {
    const m = JSON.parse(text) as { key: string; name: string; size: number; v: number; token?: string };
    expect(m.v).toBe(1);
    expect(got.files[`${m.key}.bin`], 'meta が指す bytes が無い').toBeDefined();
    byName.set(m.name, m);
  }
  // ── ③ 🔴 **合言葉は「開いた当の文書」にだけ付く**(レビュー R2 / R3)──────
  expect(
    byName.get('報告書.odt')?.token,
    '開いた文書の保存に合言葉が付いていない ── 上書き保存が新しいノートを増やす',
  ).toBe('lid-TEST');
  expect(
    byName.get('無題 1.odt')?.token ?? '',
    '別の文書の保存に合言葉が付いた ── 開いていたノートが別物に差し替わる',
  ).toBe('');
  // ⚠ temp を拾っていない(拾うと「保存」として親へ流れる)
  expect(
    metas.map(([, t]) => (JSON.parse(t) as { name: string }).name),
    'LO の temp を保存として拾っている',
  ).not.toContain('lu42.tmp');
});

/**
 * 🔴 **2 回目の保存が同じノートを指す**(#217。cowork 実機 2026-08-16 で 1/1 再現)。
 *
 * ⚠ 上の test は「**PKC が渡した添付**の保存に合言葉が付く」ところまでしか見ていない。
 * ところが窓の中で**新規に作った文書**(Start Center → 別名で保存)は合言葉を持たないので、
 * 本体がノートを作った後に**窓へ返さないと 2 回目もまた新規のノートになる** ──
 * user から見ると「保存するたびにノートが増える」。
 *
 * 🔑 観測点は棚の meta の `token` である ── **1 回目は空、2 回目は本体が返した lid**。
 * ⚠ 「`adopted` を送った」だけを見る test にはしない(窓が受けていなくても通る)。
 */
test('🔴 取り込んだ側が返した合言葉を窓が覚え、2 回目の保存は同じノートを指す(#217)', async ({
  page,
}) => {
  await page.goto('/office/host.html');
  await seedFakePack(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('pkc3-office-stage', { recursive: true }).catch(() => {});
  });
  // ⚠ **文書を渡さずに**開く = 窓の中で新規に作る場合と同じ(合言葉が無い状態)
  await page.goto('/office/host.html');
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });

  const got = await page.evaluate(async () => {
    const w = window as unknown as {
      __lo: {
        FS: {
          writeFile(p: string, d: string): void;
          open(p: string): unknown;
          close(s: unknown): void;
          mkdirTree(p: string): void;
        };
      };
    };
    const seen: Array<{ key: string; name: string }> = [];
    const ch = new BroadcastChannel('pkc3-office');
    ch.onmessage = (ev: MessageEvent): void => {
      const d = ev.data as { pkc3Office?: string; payload?: { key: string; name: string } };
      if (d?.pkc3Office === 'saved' && d.payload) seen.push(d.payload);
    };
    const waitFor = async (n: number): Promise<void> => {
      const t0 = Date.now();
      while (seen.length < n && Date.now() - t0 < 12_000) {
        await new Promise((r) => setTimeout(r, 200));
      }
    };

    w.__lo.FS.mkdirTree('/home/web_user');
    // ── 1 回目:合言葉なしで届く(本体は新しいノートを作る)
    w.__lo.FS.writeFile('/home/web_user/無題 1.odt', 'FIRST-SAVE');
    w.__lo.FS.close(w.__lo.FS.open('/home/web_user/無題 1.odt'));
    await waitFor(1);
    const first = seen[0]?.key ?? '';

    // ── 本体が「その保存はこのノートになった」と返す
    ch.postMessage({ pkc3Office: 'adopted', payload: { key: first, token: 'lid-ADOPTED' } });
    await new Promise((r) => setTimeout(r, 300));

    // ── 2 回目:**同じ path** をもう一度保存する
    w.__lo.FS.writeFile('/home/web_user/無題 1.odt', 'SECOND-SAVE!');
    w.__lo.FS.close(w.__lo.FS.open('/home/web_user/無題 1.odt'));
    await waitFor(2);
    ch.close();

    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('pkc3-office-stage', { create: true });
    const metas: Record<string, string> = {};
    for await (const [name, handle] of (
      dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }
    ).entries()) {
      if (name.endsWith('.json')) metas[name] = await (await handle.getFile()).text();
    }
    return { seen, first, metas };
  });

  // 空振り防止 ── 2 回とも保存として拾えていないと、合言葉は検査できない
  expect(got.seen.length, '保存が 2 回拾えていない ── この test は合言葉を検査できていない')
    .toBe(2);
  expect(got.first, '1 回目の鍵が空').not.toBe('');

  const metaOf = (key: string): { token?: string; win?: string } => {
    const text = got.metas[`${key}.json`];
    expect(text, `棚に ${key} の meta が無い`).toBeDefined();
    return JSON.parse(text!) as { token?: string; win?: string };
  };
  expect(metaOf(got.first).token ?? '', '1 回目は合言葉なしのはず(まだノートが無い)').toBe('');
  expect(
    metaOf(got.seen[1]!.key).token ?? '',
    '2 回目に合言葉が付いていない ── 保存のたびにノートが増える',
  ).toBe('lid-ADOPTED');

  /**
   * 🔴 **鍵が本当に一意である**(着地前レビュー 2026-08-16)。
   *
   * ⚠ `office-save-stage.js` は「`randomUUID` が在れば使う」と書いてあるのに、
   * **呼び元が渡していなかった**ので `'o' + Date.now() + '-0'` に落ちていた
   * (= ミリ秒の解像度 / 連番は常に 0)。返事を鍵で弁別するガードは、この一意性の
   * 上に乗っている。🔑 **字面ではなく、出た鍵の形で見る**(呼び元を消せば落ちる)。
   */
  for (const s of got.seen) {
    expect(s.key, `鍵が時刻由来のまま(${s.key})── 同じミリ秒の保存とぶつかる`)
      .toMatch(/^o[0-9a-f]{32}$/);
  }

  /**
   * 🔴 **どの窓が置いたかを載せる**(#217)。⚠ 引き取る側が「同じ文書の保存」を
   * `path` で束ねる**前提**なので、無いと編集明けの一括取り込みでノートが増える。
   */
  const winA = metaOf(got.first).win ?? '';
  expect(winA, '窓の id が meta に載っていない').not.toBe('');
  expect(metaOf(got.seen[1]!.key).win, '同じ窓なのに id が違う').toBe(winA);
});

/**
 * 🔴 **返事は「その鍵の保存」にだけ効く**(#217)。⚠ 放送は**全窓に届く**ので、
 * 別の窓の保存に対する返事を自分の対応表へ入れると、**関係のないノートへ上書き**する。
 *
 * ⚠ **初稿は「保存の前に、身に覚えのない鍵を投げる」形だった**(2026-08-16 の
 * 着地前レビューで潰れた)── そのときは対応表が**空**なので、
 * 「対応表を引かずに**直前の path** へ当てる」型の変異が**素通りする**。
 * 🔑 だから **当てる先が 2 つ実在する**状態を作り、**片方の鍵にだけ**返事を出して、
 * **もう片方が空のまま**であることを見る。これなら「直前へ当てる」も
 * 「全部へ当てる」も殺せる。
 */
test('🔴 返事は、その鍵の文書にだけ効く(隣の文書へ漏れない)(#217)', async ({ page }) => {
  await page.goto('/office/host.html');
  await seedFakePack(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('pkc3-office-stage', { recursive: true }).catch(() => {});
  });
  await page.goto('/office/host.html');
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });

  const got = await page.evaluate(async () => {
    const w = window as unknown as {
      __lo: { FS: {
        writeFile(p: string, d: string): void; open(p: string): unknown;
        close(s: unknown): void; mkdirTree(p: string): void;
      } };
    };
    const seen: Array<{ key: string; name: string }> = [];
    const ch = new BroadcastChannel('pkc3-office');
    ch.onmessage = (ev: MessageEvent): void => {
      const d = ev.data as { pkc3Office?: string; payload?: { key: string; name: string } };
      if (d?.pkc3Office === 'saved' && d.payload) seen.push(d.payload);
    };
    const waitFor = async (n: number): Promise<void> => {
      const t0 = Date.now();
      while (seen.length < n && Date.now() - t0 < 12_000) {
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    const save = (name: string, body: string): void => {
      w.__lo.FS.writeFile(`/home/web_user/${name}`, body);
      w.__lo.FS.close(w.__lo.FS.open(`/home/web_user/${name}`));
    };

    w.__lo.FS.mkdirTree('/home/web_user');
    // ── 2 つの文書を保存する(= 当てる先が 2 つ実在する)
    save('あ.odt', 'DOC-A-1');
    await waitFor(1);
    save('い.odt', 'DOC-B-1');
    await waitFor(2);
    const keyA = seen.find((s) => s.name === 'あ.odt')?.key ?? '';
    const keyB = seen.find((s) => s.name === 'い.odt')?.key ?? '';

    // ⚠ **あ の鍵にだけ**返事を出す(い は名乗られていない)
    ch.postMessage({ pkc3Office: 'adopted', payload: { key: keyA, token: 'lid-ONLY-A' } });
    await new Promise((r) => setTimeout(r, 300));

    // ── どちらも 2 回目を保存する
    save('あ.odt', 'DOC-A-2');
    await waitFor(3);
    save('い.odt', 'DOC-B-2');
    await waitFor(4);
    ch.close();

    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('pkc3-office-stage', { create: true });
    const metas: Record<string, string> = {};
    for await (const [name, handle] of (
      dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }
    ).entries()) {
      if (name.endsWith('.json')) metas[name] = await (await handle.getFile()).text();
    }
    return { seen, keyA, keyB, metas };
  });

  // 空振り防止 ── 4 回とも拾えていないと、漏れの有無は検査できない
  expect(got.seen.length, '保存が 4 回拾えていない ── この test は漏れを検査できていない')
    .toBe(4);
  expect(got.keyA, 'あ の 1 回目の鍵が取れていない').not.toBe('');
  expect(got.keyB, 'い の 1 回目の鍵が取れていない').not.toBe('');

  const tokenOf = (key: string): string => {
    const text = got.metas[`${key}.json`];
    expect(text, `棚に ${key} の meta が無い`).toBeDefined();
    return (JSON.parse(text!) as { token?: string }).token ?? '';
  };
  const second = (name: string): string =>
    got.seen.filter((s) => s.name === name)[1]?.key ?? '';

  expect(tokenOf(got.keyA), '1 回目は合言葉なしのはず').toBe('');
  expect(tokenOf(got.keyB), '1 回目は合言葉なしのはず').toBe('');
  expect(
    tokenOf(second('あ.odt')),
    '名乗られた文書に合言葉が付いていない',
  ).toBe('lid-ONLY-A');
  expect(
    tokenOf(second('い.odt')),
    '隣の文書へ合言葉が漏れた ── 無関係なノートの中身を上書きする',
  ).toBe('');

  /**
   * 🔴 **窓の id は「名前」ではない**(#220-4)。ここは **名前が 2 つ違う保存**を
   * 同じ窓で採っている唯一の面なので、`record.win = String(meta.name)` のような
   * 取り違えを殺せるのはここだけである(もう 1 つの smoke は同名を 2 回保存する
   * ので、名前を入れても値が一致してしまう)。
   */
  const winOf = (key: string): string => {
    const text = got.metas[`${key}.json`];
    expect(text, `棚に ${key} の meta が無い`).toBeDefined();
    return (JSON.parse(text!) as { win?: string }).win ?? '';
  };
  expect(winOf(got.keyA), '窓の id が meta に載っていない').not.toBe('');
  expect(
    winOf(got.keyB),
    '窓の id が文書ごとに違う ── 名前など「文書の属性」を入れている',
  ).toBe(winOf(got.keyA));
});

/**
 * 🔴 **返事の行き先は「その鍵の path」**(#220-3)。
 *
 * ⚠ この面は**合言葉を持つ窓**(= PKC から添付を渡して開いた窓)で、**別の文書**の
 * 返事を受ける形である。既存の test はどちらか片方しか作れていなかった:
 *   - `adopted` を送る 2 本は**文書を渡さずに**開く(`__loDocPath` が無い)
 *   - 文書を渡す 1 本は `adopted` を 1 度も送らない
 * → `tokens.remember(put.key, window.__loDocPath || hit.path)` という変異が全緑で通る。
 * 実害は「**添付 A を上書き保存すると B のノートの実体が A の中身で置き換わる**」。
 *
 * 🔑 観測点は棚の meta の `token` を **2 つの文書について**見ること ──
 * 片方だけ見ると、取り違えても半分は正しく見える。
 */
test('🔴 合言葉を持つ窓でも、返事は「その鍵の文書」に着く(#220-3)', async ({ page }) => {
  await page.goto('/office/host.html');
  await seedFakePack(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('pkc3-office-stage', { recursive: true }).catch(() => {});
  });
  // 合言葉つきで添付を流し込む(= PKC の「Office で開く」と同じ状態)
  await page.addInitScript(() => {
    const ch = new BroadcastChannel('pkc3-office');
    ch.onmessage = (ev: MessageEvent): void => {
      const d = ev.data as { pkc3Office?: string };
      if (d?.pkc3Office !== 'ready-for-document') return;
      ch.postMessage({
        pkc3Office: 'document',
        payload: {
          name: '報告書.odt',
          bytes: new TextEncoder().encode('ORIGINAL'),
          token: 'lid-TEST',
        },
      });
    };
  });
  await page.goto('/office/host.html?name=%E5%A0%B1%E5%91%8A%E6%9B%B8.odt&await-doc=1');
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });
  // 空振り防止 ── 文書が流れていなければ「取り違えない」ことは検査できない
  expect(
    await page.evaluate(() => (window as unknown as { __loDocPath?: string }).__loDocPath),
    '文書が流し込まれていない ── この test は取り違えを検査できていない',
  ).toBe('/work/報告書.odt');

  const got = await page.evaluate(async () => {
    const w = window as unknown as {
      __lo: { FS: {
        writeFile(p: string, d: string): void; open(p: string): unknown;
        close(s: unknown): void; rename(a: string, b: string): void; mkdirTree(p: string): void;
      } };
    };
    const seen: Array<{ key: string; name: string }> = [];
    const ch = new BroadcastChannel('pkc3-office');
    ch.onmessage = (ev: MessageEvent): void => {
      const d = ev.data as { pkc3Office?: string; payload?: { key: string; name: string } };
      if (d?.pkc3Office === 'saved' && d.payload) seen.push(d.payload);
    };
    const waitFor = async (n: number): Promise<void> => {
      const t0 = Date.now();
      while (seen.length < n && Date.now() - t0 < 12_000) {
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    w.__lo.FS.mkdirTree('/home/web_user');
    w.__lo.FS.mkdirTree('/work');

    // ① 窓の中で**新しい文書**を保存(合言葉を持たない)
    w.__lo.FS.writeFile('/home/web_user/無題 1.odt', 'NEW-1');
    w.__lo.FS.close(w.__lo.FS.open('/home/web_user/無題 1.odt'));
    await waitFor(1);
    const keyNew = seen[0]?.key ?? '';

    // ② **その鍵にだけ**返事を出す(本体が新しいノートを作ったときと同じ)
    ch.postMessage({ pkc3Office: 'adopted', payload: { key: keyNew, token: 'lid-NEW' } });
    await new Promise((r) => setTimeout(r, 400));

    // ③ 2 つの文書を**それぞれ**もう一度保存する
    w.__lo.FS.writeFile('/home/web_user/無題 1.odt', 'NEW-2');
    w.__lo.FS.close(w.__lo.FS.open('/home/web_user/無題 1.odt'));
    await waitFor(2);
    w.__lo.FS.writeFile('/work/lu99.tmp', 'OVERWRITTEN');
    w.__lo.FS.rename('/work/lu99.tmp', '/work/報告書.odt');
    await waitFor(3);
    ch.close();

    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('pkc3-office-stage', { create: true });
    const metas: Record<string, string> = {};
    for await (const [name, handle] of (
      dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }
    ).entries()) {
      if (name.endsWith('.json')) metas[name] = await (await handle.getFile()).text();
    }
    return { seen, keyNew, metas };
  });

  // 空振り防止 ── 3 回とも拾えていないと、行き先は検査できない
  expect(got.seen.length, '保存が 3 回拾えていない').toBe(3);
  expect(got.keyNew, '新しい文書の鍵が取れていない').not.toBe('');

  const tokenOf = (key: string): string => {
    const text = got.metas[`${key}.json`];
    expect(text, `棚に ${key} の meta が無い`).toBeDefined();
    return (JSON.parse(text!) as { token?: string }).token ?? '';
  };
  const keyOf = (name: string, nth: number): string =>
    got.seen.filter((s) => s.name === name)[nth]?.key ?? '';

  // ① 返事は**その文書**へ着く
  expect(
    tokenOf(keyOf('無題 1.odt', 1)),
    '返事が新しい文書に着いていない ── 保存のたびにノートが増える',
  ).toBe('lid-NEW');
  // ② **開いた添付**の合言葉は変わらない(ここが取り違えの実害)
  expect(
    tokenOf(keyOf('報告書.odt', 0)),
    '開いた添付の合言葉が別の文書の返事で書き換わった ── 別のノートの中身が置き換わる',
  ).toBe('lid-TEST');
});

/**
 * 🔴 **表示言語を変えたのに「すぐに再起動」が効かない**(#160)。
 *
 * 実機レポート #8(1/1): UI 言語を変えると LO は再起動ダイアログを出すが、
 * `すぐに再起動(R)` を押しても**何も起きない**。死んでいるのは LO の canvas の中の
 * ボタンなので、こちらからは書き換えられない ── **こちら側に効く道**を出す。
 *
 * ⚠ 判断(どの設定を見るか)は `office-restart-watch.js` の unit が守っている。
 * 🔑 ここが守るのは**配線**である ── 判断が正しくても、窓が呼んでいなければ
 * user には何も届かない(`host.html` は bundle されないので unit が届かない)。
 *
 * ⚠ **対照群を先に置く。** 「時間が経てば出る」帯なら、この検査は何も言っていない。
 */
test('🔴 表示言語を変えたら、開き直す導線を出す', async ({ page }) => {
  const XCU = '/instdir/user/registrymodifications.xcu';
  await page.goto('/office/host.html');
  await seedFakePack(page);
  await page.reload();
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });

  // 空振り防止 ── 起動時に設定 file が実在する(= 基準を採れている前提が成り立つ)
  expect(
    await page.evaluate((p) => {
      const w = window as unknown as { __files?: Record<string, string> };
      return typeof w.__files?.[p];
    }, XCU),
    '設定 file が仕込まれていない(この spec の前提が崩れている)',
  ).toBe('string');

  // 🔴 **対照群** ── 何もしなければ、見張りの間隔(3 秒)を過ぎても帯は出ない
  await page.waitForTimeout(4000);
  await expect(page.locator('#restart'), '何もしていないのに帯が出ている').toBeHidden();

  // LO が UI 言語を書いた形にする(実物と同じ path / name の item)
  await page.evaluate((p) => {
    const w = window as unknown as { __files: Record<string, string> };
    const cur = w.__files[p];
    // ⚠ 上で「在ること」を確かめてから来ているので、ここで無いのは前提の崩れ
    if (typeof cur !== 'string') throw new Error('設定 file が消えている: ' + p);
    w.__files[p] = cur.replace(
      '</oor:items>',
      '<item oor:path="/org.openoffice.Office.Linguistic/General">'
        + '<prop oor:name="UILocale" oor:op="fuse"><value>en-US</value></prop>'
        + '</item></oor:items>',
    );
  }, XCU);

  await expect(page.locator('#restart'), '言語を変えても帯が出ない').toBeVisible({
    timeout: 10_000,
  });
  // ⚠ **失うものが書いてあること** ── 押してから知るのでは遅い
  await expect(page.locator('#restart')).toContainText('保存していない変更は失われます');
  await expect(page.locator('#restart button'), '押す先が無い').toHaveText('開き直す');
});

/**
 * 🔴 **保存できない形式は、押す前に伝える**(#225)。
 *
 * 実測(2026-08-23、同じ本文から作った 4 つを同じ腕で): `.odt` は 8,289 → 9,192 B で
 * 保存でき、`.rtf` / `.doc` / `.docx` は **1 バイトも動かず**「一般的な I/O エラー」。
 * ⚠ user から見ると **編集してから全部失う**形になる。
 *
 * ⚠ 判断(どの形式が保存できるか)は `office-format.js` の unit が守っている。
 * 🔑 ここが守るのは**配線**である ── 判断が正しくても窓が呼んでいなければ届かない。
 * 🔴 **対照群(`.odt`)を必ず置く** ── 何にでも出る帯なら、この検査は何も言っていない。
 */
async function openWithDoc(
  page: import('@playwright/test').Page,
  name: string,
  opts: { alienPack?: boolean } = {},
): Promise<void> {
  await page.goto('/office/host.html');
  await seedFakePack(page, { alienPack: opts.alienPack });
  await page.addInitScript((docName) => {
    const ch = new BroadcastChannel('pkc3-office');
    ch.onmessage = (ev: MessageEvent): void => {
      const d = ev.data as { pkc3Office?: string };
      if (d?.pkc3Office !== 'ready-for-document') return;
      ch.postMessage({
        pkc3Office: 'document',
        payload: { name: docName, bytes: new TextEncoder().encode('PKC3'), token: 'lid-TEST' },
      });
    };
  }, name);
  await page.goto(`/office/host.html?name=${encodeURIComponent(name)}&await-doc=1`);
  await expect(page.locator('#status')).toContainText('表示中', { timeout: 15_000 });
  // 空振り防止 ── 文書が実際に流し込まれたか(流れていなければ何も検査できない)
  expect(
    await page.evaluate(() => (window as unknown as { __loDocPath?: string }).__loDocPath),
    '文書が流し込まれていない ── この test は配線を検査できていない',
  ).toBe(`/work/${name}`);
}

test('🔴 保存できない形式(.docx)は、開いた時点で伝える', async ({ page }) => {
  await openWithDoc(page, 'a.docx');
  // 帯 ── 開いた瞬間の合図(閉じられる)
  await expect(page.locator('#nosave'), '保存できない形式なのに帯が出ない').toBeVisible();
  await expect(page.locator('#nosave')).toContainText('保存できません');
  await expect(page.locator('#nosave')).toContainText('.docx');
  // 印 ── 状態(いつ見ても同じ場所に在る)
  await expect(page.locator('#ro'), '上部バーの印が出ていない').toBeVisible();

  // 🔑 帯は閉じられる / ⚠ **印は消えない**(状態は残る)
  await page.locator('#nosave button').click();
  await expect(page.locator('#nosave')).toBeHidden();
  await expect(page.locator('#ro'), '帯を閉じたら印まで消えている').toBeVisible();
});

test('🔴 対照群 ── 保存できる形式(.odt)では何も出さない', async ({ page }) => {
  await openWithDoc(page, 'a.odt');
  await expect(page.locator('#nosave'), '保存できるのに断りが出ている').toBeHidden();
  await expect(page.locator('#ro'), '保存できるのに印が出ている').toBeHidden();
});

/**
 * 🔴 **同じ `.docx` でも、入っている一式で答えが変わる**(#225)。
 *
 * 確認ダイアログ(`cui/ui/querydialog.ui`)を持つ一式では非 ODF も保存できる ──
 * そこで断りを出すと**嘘**になる。⚠ 逆に、持っていない一式で黙ると
 * **user は編集を失う**。だから判定は形式だけでは決まらない。
 *
 * 🔑 上の 2 本(古い一式で断る / ODF では黙る)と**対で読む** ── 3 本そろって
 * 初めて「形式と一式の両方を見ている」と言える。
 * ⚠ 偽の一式の目録には**囮**(古い一式にも在る 3 つの `*querydialog.ui`)が
 * 必ず入っている ── 判定を部分一致へ書き戻すと、この検査が落ちる。
 */
test('🔴 確認ダイアログを持つ一式なら、.docx でも断らない', async ({ page }) => {
  await openWithDoc(page, 'a.docx', { alienPack: true });
  await expect(page.locator('#nosave'), '保存できる一式なのに断りが出ている').toBeHidden();
  await expect(page.locator('#ro'), '保存できる一式なのに印が出ている').toBeHidden();
});

/**
 * 🔴 **判定の口が無い版が読まれたら、断る側へ倒れる**(#225)。
 *
 * `host.html` と `office-format.js` は**別の file**として同じ origin から読まれる ──
 * ブラウザに古い `office-format.js` が残っていると、`packSavesAlien` が**無い**まま
 * `isSavable` だけが在る、という組み合わせが実際に起こりうる。
 *
 * ⚠ そのとき `packAlienOk` は初期値のままになる。**初期値が `true` だと、
 * 保存できない一式で黙る**(= user が編集を失う)。
 * 🔑 だから初期値は `false` でなければならず、**それをここで確かめる**
 * (この検査が無いと、初期値を裏返す変異が生き延びる ── 実際に生き延びた)。
 */
test('🔴 office-format.js に判定の口が無い版が読まれたら、断る側へ倒れる', async ({ page }) => {
  // 古い版を再現する ── `packSavesAlien` だけ落とし、`isSavable` は残す
  await page.route('**/office/office-format.js', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace('packSavesAlien: packSavesAlien,', '');
    // 空振り防止 ── 本当に落とせたか(綴りが変わったら落とせていない)
    expect(body, 'packSavesAlien を落とせていない').not.toContain('packSavesAlien: packSavesAlien');
    expect(body, 'isSavable まで落としている').toContain('isSavable: isSavable');
    await route.fulfill({ status: 200, contentType: 'application/javascript', body });
  });
  // ⚠ **保存できる一式**を渡す ── それでも判定できないので断る、が正しい
  await openWithDoc(page, 'a.docx', { alienPack: true });
  await expect(page.locator('#nosave'), '判定できないのに黙っている').toBeVisible();
  await expect(page.locator('#ro'), '判定できないのに印が出ていない').toBeVisible();
});
