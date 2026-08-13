/**
 * #134 を**手元で踏んで、範囲外のアドレスを名指しする**。
 *
 * ## 何を追っているか
 *
 * 検証レポート #5(実機 macOS / Chrome 151)で、**モードレスダイアログを閉じると
 * `memory access out of bounds` で停止**が **5/5** で再現した。⚠ この例外は
 * メインスレッドで wasm が**直接トラップ**した `RuntimeError` なので
 * `lineno` / `colno` を持たない ── #124 で使った「名前を出す仕掛け」は効かない。
 *
 * 🔑 `-sSAFE_HEAP=1` で焼いた一式(tag `lo-wasm-safeheap`)なら、
 * 範囲外に触った**その瞬間**に止まり、生成された `SAFE_HEAP_INDEX` が
 *
 *     segmentation fault storing 4 bytes at address 12345678
 *
 * まで出す。**トラップより手前**なので、`abort` の stack がまだ生きている。
 *
 * ## ⚠ 「座標を打たない」は**取り下げた**(実測で崩れた)
 *
 * 初稿は「ショートカットだけで届く」と書いていたが、**届かなかった** ──
 * `Ctrl+N`(新規文書)と普通の文字入力は通るのに、**`F5`(Navigator)も
 * `Ctrl+H`(検索と置換)もダイアログを 1 枚も開かない**(実測、両方 1/1)。
 * レポート #5 が**メニューをマウスで開いていた**のはそのためだったと分かる。
 *
 * 🔑 いまはメニューを**座標でクリック**する。座標は screenshot から採ったので、
 * **viewport を固定する**({@link VIEWPORT})── 変えると全部ずれる。
 * ⚠ 上流の LO がメニューの並びを変えたら当たらなくなるが、そのときは
 *   `landed` が false になるので、**黙って「落ちない」にはならない**。
 *
 * | 手 | 何が起きるはず |
 * |---|---|
 * | `Ctrl+N` | Start Center → **Writer の新規文書** |
 * | 文字を打つ | ⚠ **対照群** ── キーが LO に届いていることの証拠 |
 * | Tools メニュー → Word Count | モードレスのダイアログが出る |
 * | `Escape` | 閉じる ── **ここで落ちる**(実測 1/1) |
 *
 * ## 実測(2026-08-13、この probe で採った)
 *
 * | 一式 | 結果 |
 * |---|---|
 * | **`lo-wasm-dev`(配布)** | `RuntimeError: memory access out of bounds` ── レポート #5 と同じ |
 * | `lo-wasm-safeheap` | `null function or function signature mismatch` ── ⚠ **segfault は 0 件**。SAFE_HEAP はこの不具合を捕まえない |
 *
 * ## ⚠ 沈黙を成功と読まない
 *
 * 「落ちなかった」は 2 通りある ── **直っている**のと、**キーが届いていない**の。
 *
 * 🔴 **判定はピクセルで採る**(2026-08-13、初稿で間違えた)。1 稿目は
 * 「Qt の `.qt-window` が 1 枚増えたか」で見ていたが、**LO は Start Center の窓を
 * そのまま Writer に作り替える**ので枚数は 1 のまま ── `Ctrl+N` が**完全に効いて
 * いた**のに「キーが届いていない」と読むところだった。⚠ `.qt-window` の
 * `textContent` も、screen reader を有効にしていないと `Enable Screen Reader` の
 * まま動かない ── **どちらも観測点として死んでいた**。
 *
 * 🔑 助かったのは screenshot を見たからである(`boot-probe.mjs` が 1 日溶かして
 * 得た教訓「**数える前に、まず見る**」)。canvas しか無い相手には、絵を突き合わせる
 * のが唯一素直な観測点である。
 *
 * 🔴 **ただし絵は放っておいても変わる**(2 稿目でこれに引っかかった)。Writer には
 * **点滅するカーソル**が在るので、1 枚ずつ比べると `Ctrl+H` が**何もしていない**のに
 * 「絵が変わった = 届いた」と読む ── 実際に読んだ。⚠ **「変わった」は届いた証拠に
 * ならない。** 変わらないものが在る場所でしか使えない。
 * 🔑 だから **1 手につき数枚を間隔をあけて撮り、hash の集合**で比べる。点滅は
 * 2 状態を往復するだけなので集合に収まり、**集合ごと入れ替わったときだけ**
 * 「届いた」と言える。
 *
 * ⚠ そして**対照群を置く**(`landed` が常に true を返す作りでないことの検品)──
 * 手順の先頭に「**ただの文字を 1 つ打つ**」を入れる。これが届かないなら、
 * その回はキーが LO に届いていないので、以降の判定は全部無意味である。
 *
 * 使い方:
 *   node dialog-crash-probe.mjs <配信ディレクトリ> [出力 JSON]
 *
 * ⚠ **SAFE_HEAP は数倍遅い。** 既定の待ちは boot-probe より長くしてある。
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(process.argv[2] ?? '.');
const OUT = process.argv[3] ?? '';
const SHOTS = join(ROOT, `__shots-${process.env.PKC3_PROBE_SUITE ?? 'dialog'}`);
/** ⚠ SAFE_HEAP 込みの起動。素で 1.8 秒でも、ここでは数分を見込む。 */
const BOOT_TIMEOUT_MS = Number(process.env.PKC3_BOOT_TIMEOUT_MS ?? 900_000);
/** 1 手ごとの落ち着き待ち。⚠ 短いと「キーが届いていない」を「落ちない」と読む。 */
const SETTLE_MS = Number(process.env.PKC3_SETTLE_MS ?? 20_000);
/** 1 手あたり撮る枚数。⚠ **点滅を集合に収める**ため 1 枚では足りない。 */
const SHOT_SAMPLES = Number(process.env.PKC3_SHOT_SAMPLES ?? 4);
/** 撮る間隔。⚠ カーソルの点滅周期(およそ 500ms)をまたぐ長さにする。 */
const SHOT_GAP_MS = Number(process.env.PKC3_SHOT_GAP_MS ?? 700);
/**
 * 🔴 **固定する。** メニューの座標を screenshot から採っているので、
 * ここを変えると `STEPS` の `at` が全部ずれる。
 */
const VIEWPORT = { width: 1280, height: 720 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.metadata': 'application/json',
  '.data': 'application/octet-stream',
};

/**
 * shadow root を越えて Qt の面を数える。
 * ⚠ `querySelectorAll` は境界を越えない ── 越えないと**永遠に 0 枚**で、
 *   動いている LibreOffice を「起動しない」と報告する(`boot-probe.mjs` の教訓)。
 */
const DEEP_FN = `(root) => {
  const canvases = [];
  const windows = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.tagName === 'CANVAS') canvases.push(el);
      if (el.classList && el.classList.contains('qt-window')) windows.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  if (root) walk(root);
  return {
    canvases: canvases.length,
    windows: windows.length,
    titles: windows.map((w) => (w.textContent || '').trim().slice(0, 40)),
  };
}`;

/** COOP/COEP を必ず付ける ── SharedArrayBuffer(= LO の -pthread)に要る。 */
function serve() {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      const head = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store',
      };
      readFile(join(ROOT, path))
        .then((buf) => {
          res.writeHead(200, {
            ...head,
            'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
          });
          res.end(buf);
        })
        .catch(() => {
          // ⚠ favicon の 404 は常在ノイズになる(本物のエラーがそこに紛れる)
          res.writeHead(path === '/favicon.ico' ? 204 : 404, head);
          res.end(path === '/favicon.ico' ? '' : 'not found');
        });
    });
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}

/**
 * 踏む手順。
 * ⚠ **`control` の手は「届いているか」を確かめるためだけに在る** ── これが
 *   届かない回は、以降の「落ちなかった」に意味が無い(空振りである)。
 */
const OPEN_DOC = [
  { id: 'new-doc', key: 'Control+n', why: 'Start Center → Writer の新規文書', control: true, wait: 12_000 },
  { id: 'type-text', type: 'hello world test', why: '⚠ 対照群 ── ただの文字。届いている証拠', control: true },
];

/**
 * 踏む筋。⚠ 座標は 1280x720 の screenshot から採った({@link VIEWPORT})。
 *
 * ⚠ **1 回の走りは 1 つの主張**にする(「回すものの粒度」)。既定は #134 の再現で、
 *   同根が疑われるものは `PKC3_PROBE_SUITE` で明示的に選ぶ。
 */
const SUITES = {
  /** #134 本体 ── モードレスを閉じると落ちる。 */
  dialog: [
    ...OPEN_DOC,
    { id: 'tools-menu', at: [472, 37], why: 'Tools メニューを開く', control: false },
    { id: 'word-count', at: [83, 121], why: 'Word Count…(モードレス)を開く', control: false },
    { id: 'escape', key: 'Escape', why: '🔴 閉じる ── ここで落ちる(実測 1/1)', control: false },
  ],
  /**
   * #134 の「同じ根かもしれないもの」── `Tools → Spelling` は**開いた瞬間**に死ぬ
   * (レポート #5、1/1)。⚠ 同根なら同じ直しで消えるはずなので、突き合わせる。
   */
  spelling: [
    ...OPEN_DOC,
    { id: 'tools-menu', at: [472, 37], why: 'Tools メニューを開く', control: false },
    { id: 'spelling', at: [67, 13], why: '🔴 Spelling…(開いた瞬間に死ぬ)', control: false, wait: 20_000 },
    { id: 'escape', key: 'Escape', why: '開けたなら閉じてみる', control: false },
  ],
  /**
   * #135 ── `Ctrl+T`(表の挿入)。⚠ **#134 とは別の根**である
   * (空の自動書式一覧を添字 `-1` で読む / `patch-lo-instable.py`)。
   *
   * 🔑 `Ctrl+T` を選ぶのは、**キーが LO まで届く**ことが分かっているからである
   * (`F5` / `Ctrl+H` は届かない)。メニュー座標を踏まずに済む。
   * ⚠ 症状は「落ちる」ではなく**タブごと固まる**ので、screenshot も JS も
   *   通らなくなる ── 停止画面すら出ない。
   */
  table: [
    ...OPEN_DOC,
    {
      id: 'insert-table',
      key: 'Control+t',
      why: '🔴 表の挿入 ── ここで固まる(直す前 2/2)',
      control: false,
      wait: 15_000,
    },
    { id: 'escape', key: 'Escape', why: '開けたなら閉じてみる', control: false },
  ],
  /**
   * #145 ── Start Center から **Impress** を開く。
   *
   * ⚠ `OPEN_DOC` を**使わない**唯一の suite である ── 見たいのは
   * 「Start Center の項目が生きているか」なので、先に Writer を開くと
   * **Start Center が消えて**押せない。
   *
   * 🔴 **初稿は「Writer を開いて `Ctrl+W` で戻る」形にして間違えた**(2026-08-13)。
   * `Ctrl+W` は Start Center へ**戻らず**、しかもメニューとツールバーが消えた
   * **半壊の Writer** が残る。私のクリックは「Impress Presentation」ではなく
   * **本文の上**に落ちており、拾った `null function or function signature mismatch` は
   * **Impress とは無関係**だった(それ自体は別の実バグ ── #117 へ)。
   * ⚠ `controlsLanded: true` に騙された ── あれは「画面が変わった」しか見ておらず、
   * **「Start Center に戻った」を確かめていない**。
   *
   * 🔑 だから対照群は **Start Center の面から出ない一手**にする ──
   * `Templates` は中央の面を差し替えるだけで、左の `Create:` 一覧はそのまま残る。
   * これが届いていれば「座標が Start Center に当たっている」が言える。
   * ⚠ 座標は 1280x720 の Start Center から採った。
   */
  impress: [
    {
      id: 'templates',
      at: [100, 241],
      why: '⚠ 対照群 ── Start Center の中で面が変わる(押せている証拠。面から出ない)',
      control: true,
      wait: 8_000,
    },
    {
      id: 'new-impress',
      at: [152, 435],
      why: '🔴 Impress Presentation ── 直す前は無反応(2/2)',
      control: false,
      wait: 25_000,
    },
  ],
};

const SUITE = process.env.PKC3_PROBE_SUITE ?? 'dialog';
const STEPS = SUITES[SUITE];
if (!STEPS) {
  console.error(`ERROR: 知らない suite: ${SUITE}(${Object.keys(SUITES).join(' / ')})`);
  process.exit(2);
}

async function main() {
  const server = await serve();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const tag = `/tmp/pkc3-lo-dialog-${process.pid}`;
  await mkdir(SHOTS, { recursive: true });

  // ⚠ **どのブラウザで踏んだかを必ず残す**(CLAUDE.md: CI と手元で別のバイナリ)
  const bundled = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';
  const executablePath = existsSync(bundled) ? bundled : undefined;

  const result = {
    ok: false,
    base,
    suite: SUITE,
    pack: ROOT,
    browser: executablePath ?? 'playwright default',
    steps: [],
  };
  const consoleAll = [];
  const pageErrors = [];
  /** 🔑 SAFE_HEAP の断定。`abort()` は console.error と pageerror の両方に出る。 */
  const faults = [];
  const noteFault = (text) => {
    // ⚠ `null function or function signature mismatch` も拾う ── SAFE_HEAP つきで
    //    踏むとこちらになる(同じ「でたらめなポインタ」の別の顔)
    if (
      /segmentation fault|alignment fault|memory access out of bounds|signature mismatch|Aborted\(/.test(
        text,
      )
    ) {
      faults.push(text.slice(0, 1200));
    }
  };

  const browser = await chromium.launchPersistentContext(tag, {
    headless: true,
    viewport: VIEWPORT,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(executablePath ? { executablePath } : {}),
  });

  let page;
  try {
    page = await browser.newPage();
    page.on('console', (m) => {
      const line = `[${m.type()}] ${m.text()}`.slice(0, 1200);
      consoleAll.push(line);
      noteFault(line);
    });
    page.on('pageerror', (e) => {
      // ⚠ **stack まで残す** ── #134 で欲しいのは「どこで」である
      const text = `${String(e)}\n${e?.stack ?? ''}`.slice(0, 4000);
      pageErrors.push(text);
      noteFault(text);
    });

    const t0 = Date.now();
    await page.goto(`${base}/qt_soffice.html`, { waitUntil: 'commit' });
    result.isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);

    const outcome = await page
      .waitForFunction(
        (fnSrc) => {
          const screen = document.querySelector('#screen');
          if (!screen) return 'no-shell';
          if (eval(fnSrc)(screen).canvases > 0) return 'painted';
          const status = document.querySelector('#qtstatus');
          if ((status?.textContent ?? '').includes('Application exit')) return 'exited';
          return false;
        },
        DEEP_FN,
        { timeout: BOOT_TIMEOUT_MS, polling: 1000 },
      )
      .then((h) => h.jsonValue())
      .catch((e) => `timeout: ${String(e).slice(0, 200)}`);

    result.outcome = outcome;
    result.bootMs = Date.now() - t0;

    // ⚠ **`return` で抜けない。** finally は走るが、その先の JSON 出力を飛ばして
    //    しまう ── 起動しなかった回こそ、console と screenshot が要る
    const look = async () =>
      page.evaluate((fnSrc) => eval(fnSrc)(document.querySelector('#screen')), DEEP_FN);

    // 起動直後は描き足しが続く ── 落ち着かせてから触る
    if (outcome === 'painted') await page.waitForTimeout(SETTLE_MS);

    result.beforeAny = await look().catch((e) => ({ error: String(e).slice(0, 200) }));

    /**
     * 🔑 **間隔をあけて数枚撮り、hash の集合を返す。**
     * ⚠ 1 枚では**点滅するカーソル**を「変化」と読む(上の注記)。
     */
    const shootSet = async (name) => {
      const set = [];
      for (let k = 0; k < SHOT_SAMPLES; k += 1) {
        const buf = await page
          .screenshot({ path: join(SHOTS, `${name}${k === 0 ? '' : `-${k}`}.png`) })
          .catch(() => null);
        if (buf) set.push(createHash('sha1').update(buf).digest('hex').slice(0, 12));
        if (k + 1 < SHOT_SAMPLES) await new Promise((r) => setTimeout(r, SHOT_GAP_MS));
      }
      return set;
    };
    /** 集合が**まるごと**入れ替わったか(重なりが 1 つも無いか)。 */
    const changed = (a, b) =>
      a.length > 0 && b.length > 0 && !b.some((h) => a.includes(h));
    /**
     * 🔴 **`el.focus()` では足りない。実際にクリックする**(3 稿目で判明)。
     *
     * `Ctrl+N` のあと、以降のキーが 1 つも届かなくなった ── **ただの文字すら**
     * 入らない(対照群がそれを教えた)。canvas を `focus()` しても、Qt は
     * 自前の focus 管理と IME 用の隠し入力を持っているので、**合成の focus では
     * 入力先が決まらない**。user がやることと同じ ── **押す**。
     * ⚠ 版面の中を狙う(左 40% / 上下中央)。端はツールバーや sidebar に当たる。
     */
    const refocus = async () => {
      const box = await page
        .evaluate(() => {
          const walk = (node) => {
            for (const el of node.querySelectorAll('*')) {
              if (el.tagName === 'CANVAS') {
                const r = el.getBoundingClientRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height };
              }
              const found = el.shadowRoot ? walk(el.shadowRoot) : null;
              if (found) return found;
            }
            return null;
          };
          return walk(document.querySelector('#screen') ?? document.body);
        })
        .catch(() => null);
      if (!box) return null;
      await page.mouse.click(box.x + box.w * 0.4, box.y + box.h * 0.5).catch(() => {});
      return box;
    };

    let prev = await shootSet('00-booted');
    result.quiet = prev;

    for (const [i, step] of (outcome === 'painted' ? [...STEPS.entries()] : [])) {
      const before = faults.length;
      // ⚠ **メニュー操作の前にクリックし直さない** ── 開いたメニューが閉じてしまう。
      //    focus を当て直すのはキー入力の手だけ(`Ctrl+N` のあと窓が作り替わるため)
      if (!step.at) result.focused = await refocus();
      if (step.at) await page.mouse.click(step.at[0], step.at[1]).catch(() => {});
      else if (step.type) await page.keyboard.type(step.type, { delay: 120 }).catch(() => {});
      else await page.keyboard.press(step.key).catch(() => {});
      // ⚠ 落ちると evaluate 自体が通らなくなる ── 待ちは page 越しに使わない
      await new Promise((r) => setTimeout(r, step.wait ?? SETTLE_MS));
      const afterLook = await look().catch((e) => ({ error: String(e).slice(0, 200) }));
      const shots = await shootSet(`${String(i + 1).padStart(2, '0')}-${step.id}`);
      result.steps.push({
        ...step,
        after: afterLook,
        shots,
        newFaults: faults.slice(before),
        // 🔑 **空振りの検出** ── 集合ごと入れ替わったときだけ「届いた」
        landed: changed(prev, shots),
      });
      prev = shots;
      if (faults.length > before) break; // 落ちたらそこで止める(以降は無意味)
    }
    // 🔴 **対照群が届いていなければ、この回の判定は全部無意味である**
    const controls = result.steps.filter((s) => s.control);
    result.controlsLanded = controls.length > 0 && controls.every((s) => s.landed === true);

    result.faults = faults;
    // 🔴 **「落ちた」を成功と呼ぶ probe** である ── 再現できたら ok
    result.reproduced = faults.length > 0;
    // ⚠ 「落ちなかった」を結論にしてよいのは、**対照群が届いていて、かつ
    //    ダイアログを実際に開けた**回だけである。それ以外は空振り
    result.dialogsOpened = result.steps.filter((s) => !s.control && s.landed === true).length;
    result.ok = result.reproduced || (result.controlsLanded && result.dialogsOpened > 0);
  } finally {
    await page?.screenshot({ path: join(SHOTS, '99-final.png') }).catch(() => {});
    result.console = consoleAll.slice(-150);
    result.pageErrors = pageErrors.slice(0, 10);
    await browser.close().catch(() => {});
    server.close();
  }

  const text = JSON.stringify(result, null, 2);
  console.log(text);
  if (OUT) await writeFile(OUT, text);
  // ⚠ 再現しなかったら**落とす**。沈黙を成功と読まない ──
  //    ただし「直った」のか「キーが届いていない」のかは `landed` を見て判断する
  if (!result.ok) process.exitCode = 1;
}

await main();
