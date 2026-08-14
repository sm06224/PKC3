/**
 * **canvas の I/O を、どの層がどう拾っているか**を解剖する(user 指摘 2026-08-14
 * 「IO がまともに拾えていないと思っているから、拾うためのレイヤーがどうなって
 * いるのかを聞いている」)。
 *
 * ## 何を測るか(3 つ。混ぜない)
 *
 * ① **登録**: Qt が **どの要素に / どの event を / どの相で** 登録したか。
 *    `EventTarget.prototype.addEventListener` を **Qt が読み込まれる前に**包んで記録する。
 *    ⚠ これが「拾う層」の実体である ── 想像ではなく一覧で出す。
 * ② **配送**: 実際にクリックしたとき、どの event が どの要素へ 何個 飛んだか。
 *    `composedPath()[0]` まで採る(shadow root を跨ぐので `target` だけでは足りない)。
 * ③ **効いたか**: メニューの項目を押した結果、**窓が 1 枚増えたか**(ダイアログが出たか)。
 *
 * ## ⚠ この probe は **host.html を迂回する**(結果の読み方に効く)
 *
 * `qt_soffice.html` を直接配信するので、host.html がやっている
 * **窓の幾何の仕込み**(`seedWindowSize`)が効かない。
 * 🔴 **DPR 2 で窓が半分に見えるのはその副作用である** ── host.html 側は
 * `devicePixelRatio` を掛けており(同 file に実測表が在る: DPR 2 で
 * `2800,1600` を書くと 1400x800 ぴったり)、**実 user 経路では起きない**。
 * 実測(この probe、DPR 2): 窓 583x624 ── host.html の注記の
 * 「仕込まない」行(551x654・真ん中に小さく浮く)と同じ形である。
 * 🔑 だから **DPR を変えて比べてよいのは「登録」と「配送」だけ**で、
 * **幾何と当たり判定は実 user 経路(host.html 経由)で測り直す**必要がある。
 *
 * ## ⚠ 合成イベントと実機の差(判っている分)
 *
 * | | 手元(CDP) | 実機の手 |
 * |---|---|---|
 * | `isTrusted` | **true**(ブラウザの入力経路を通る) | true |
 * | 押してから離すまで | 既定 0ms | 50〜150ms |
 * | 押す前の hover | 無い(`--style human` で足す) | 必ず在る |
 * | `pointerType` | mouse | mouse |
 *
 * 使い方:
 *   node build/office-wasm/io-layer-probe.mjs <配信ディレクトリ> [出力 JSON]
 *   PKC3_DPR=2 PKC3_CLICK_STYLE=human node …
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(process.argv[2] ?? '.');
const OUT = process.argv[3] ?? '';
const DPR = Number(process.env.PKC3_DPR ?? 1);
/** `fast` = 押して即離す / `human` = hover してから、間を空けて離す。 */
const STYLE = process.env.PKC3_CLICK_STYLE ?? 'fast';
const SHOTS = join(ROOT, `__shots-io-dpr${DPR}-${STYLE}`);
const VIEWPORT = { width: 1280, height: 720 };
/** メニューの座標(1280x720 の screenshot から採った ── `dialog-crash-probe` と同じ)。 */
const TOOLS_MENU = [472, 37];
const WORD_COUNT = [83, 121];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.metadata': 'application/json',
  '.data': 'application/octet-stream',
};

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
          res.writeHead(path === '/favicon.ico' ? 204 : 404, head);
          res.end('');
        });
    });
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}

/** 窓と canvas を shadow root 越しに数える(幾何と当たり判定に効く CSS つき)。 */
const SURVEY = `(() => {
  const out = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      const isWin = el.classList && el.classList.contains('qt-window');
      if (el.tagName === 'CANVAS' || isWin) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out.push({
          kind: el.tagName === 'CANVAS' ? 'canvas' : 'qt-window',
          cls: (el.className || '').toString().slice(0, 30),
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          // 🔴 当たり判定に効くもの
          pointerEvents: cs.pointerEvents,
          zIndex: cs.zIndex,
          position: cs.position,
          touchAction: cs.touchAction,
          // ⚠ canvas は「見た目の大きさ」と「画素の大きさ」が別。DPR がここに出る
          attrW: el.tagName === 'CANVAS' ? el.width : null,
          attrH: el.tagName === 'CANVAS' ? el.height : null,
          // 🔴 **題名で見分ける**。窓の数では「メニューが閉じてダイアログが開いた」を
          //    「何も起きなかった」と区別できない(実際に取り違えた)
          title: isWin ? (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) : null,
        });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return out;
})()`;

/** ある画面座標で、shadow root を貫いて**実際に当たる**要素。 */
const HIT = (x, y) => `(() => {
  const path = document.elementsFromPoint(${x}, ${y});
  const top = path[0];
  const deep = (el) => {
    let cur = el, guard = 0;
    while (cur && cur.shadowRoot && guard++ < 8) {
      const inner = cur.shadowRoot.elementFromPoint(${x}, ${y});
      if (!inner || inner === cur) break;
      cur = inner;
    }
    return cur;
  };
  const d = top ? deep(top) : null;
  const name = (el) => el ? (el.tagName + (el.id ? '#' + el.id : '') +
    (el.className ? '.' + el.className.toString().split(' ')[0] : '')) : null;
  return { top: name(top), deep: name(d), pathLen: path.length,
    path: path.slice(0, 4).map(name) };
})()`;

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  await mkdir(SHOTS, { recursive: true });

  const browser = await chromium.launchPersistentContext(`/tmp/pkc3-io-${process.pid}`, {
    headless: true,
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: '/opt/pw-browsers/chromium',
  });

  const result = { dpr: DPR, style: STYLE, base, steps: [] };
  const page = await browser.newPage();

  /**
   * 🔴 **Qt より先に仕掛ける。** `addEventListener` を包んで「誰が何を登録したか」を
   * 全部記録する ── これが「拾う層」の実体である。
   * ⚠ `addInitScript` は**新しい document ごと**に走る(遷移しても効く)。
   */
  await page.addInitScript(() => {
    const W = /** @type {any} */ (window);
    W.__io = { adds: [], events: [], errors: [] };
    const name = (t) => {
      if (t === window) return 'window';
      if (t === document) return 'document';
      if (t && t.tagName) {
        return (
          t.tagName +
          (t.id ? `#${t.id}` : '') +
          (t.className && typeof t.className === 'string' && t.className
            ? `.${t.className.split(' ')[0]}`
            : '')
        );
      }
      if (t && t.host) return `shadowRoot(${t.host.tagName ?? ''})`;
      return Object.prototype.toString.call(t);
    };
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      try {
        W.__io.adds.push({
          target: name(this),
          type: String(type),
          capture: opts === true || !!(opts && opts.capture),
          passive: !!(opts && opts.passive),
        });
      } catch (e) {
        W.__io.errors.push(String(e));
      }
      return orig.call(this, type, fn, opts);
    };
    // ② 配送 ── **capture 相**で覗く(Qt より先に見えるが、止めない)
    const WATCH = [
      'pointerdown', 'pointerup', 'pointermove', 'pointercancel',
      'mousedown', 'mouseup', 'click', 'contextmenu', 'wheel',
      'keydown', 'keyup', 'focusin', 'focusout',
    ];
    for (const t of WATCH) {
      orig.call(
        window,
        t,
        (ev) => {
          if (!W.__io.recording) return;
          const p = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
          W.__io.events.push({
            type: ev.type,
            target: name(ev.target),
            // 🔑 shadow root を跨ぐので、**実際に当たった最深部**を採る
            deep: p.length ? name(p[0]) : null,
            x: Math.round(ev.clientX ?? -1),
            y: Math.round(ev.clientY ?? -1),
            buttons: ev.buttons ?? null,
            trusted: ev.isTrusted,
            pointerType: ev.pointerType ?? null,
          });
        },
        true,
      );
    }
  });

  /**
   * ⚠ **時刻を付ける。** 「fault がどの段で出たか」が分からないと、
   * 「メニューが効かない」の原因を取り違える(Qt の配送か / LO の実行か)。
   */
  const t0 = Date.now();
  const consoleLines = [];
  const stamp = (s) => `+${String(Date.now() - t0).padStart(6)}ms ${s}`;
  const faults = [];
  const note = (s) => {
    consoleLines.push(stamp(s.slice(0, 300)));
    if (/RuntimeError|Aborted\(|memory access out of bounds|signature mismatch|sent an error!/.test(s)) {
      faults.push({ at: Date.now() - t0, text: s.slice(0, 300) });
    }
  };
  page.on('console', (m) => note(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => note(`[pageerror] ${String(e)}`));

  try {
    await page.goto(`${base}/qt_soffice.html`, { waitUntil: 'commit' });
    await page.waitForFunction(
      () => {
        const s = document.querySelector('#screen');
        if (!s) return false;
        const walk = (n) => {
          for (const e of n.querySelectorAll('*')) {
            if (e.tagName === 'CANVAS') return true;
            if (e.shadowRoot && walk(e.shadowRoot)) return true;
          }
          return false;
        };
        return walk(s);
      },
      null,
      { timeout: 600_000, polling: 1000 },
    );
    await page.waitForTimeout(15_000);

    // ① 登録の一覧(Qt が何を拾っているか)
    result.registrations = await page.evaluate(() => {
      const W = /** @type {any} */ (window);
      const byTarget = {};
      for (const a of W.__io.adds) {
        const k = `${a.target}`;
        byTarget[k] = byTarget[k] ?? [];
        const tag = `${a.type}${a.capture ? '(capture)' : ''}${a.passive ? '(passive)' : ''}`;
        if (!byTarget[k].includes(tag)) byTarget[k].push(tag);
      }
      return { total: W.__io.adds.length, byTarget };
    });
    result.steps.push({ at: 'booted', ms: Date.now() - t0, survey: await page.evaluate(SURVEY) });
    await page.screenshot({ path: join(SHOTS, '00-booted.png') });

    /** 押し方を 2 通り用意する(合成と実機の差を、こちら側で作る)。 */
    const click = async (x, y) => {
      if (STYLE === 'human') {
        // ⚠ 実機は必ず「動いて、止まって、押して、少し待って、離す」
        await page.mouse.move(x - 40, y - 30);
        await page.mouse.move(x - 12, y - 8, { steps: 4 });
        await page.mouse.move(x, y, { steps: 3 });
        await page.waitForTimeout(250);
        await page.mouse.down();
        await page.waitForTimeout(90);
        await page.mouse.up();
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.up();
      }
    };

    // Writer を開く(Start Center の Writer Document)
    await page.evaluate(() => {
      (/** @type {any} */ (window)).__io.recording = true;
      (/** @type {any} */ (window)).__io.events.length = 0;
    });
    await click(133, 341);
    await page.waitForTimeout(12_000);
    result.steps.push({
      at: 'writer',
      ms: Date.now() - t0,
      events: await page.evaluate(() => (/** @type {any} */ (window)).__io.events.slice()),
      survey: await page.evaluate(SURVEY),
    });
    await page.screenshot({ path: join(SHOTS, '01-writer.png') });

    // 🔴 メニューを開く
    await page.evaluate(() => {
      (/** @type {any} */ (window)).__io.events.length = 0;
    });
    await click(TOOLS_MENU[0], TOOLS_MENU[1]);
    await page.waitForTimeout(3000);
    const openedSurvey = await page.evaluate(SURVEY);
    result.steps.push({
      at: 'menu-open',
      ms: Date.now() - t0,
      events: await page.evaluate(() => (/** @type {any} */ (window)).__io.events.slice()),
      survey: openedSurvey,
      // 🔑 メニューの項目の座標に、**何が当たるか**
      hitAtItem: await page.evaluate(HIT(WORD_COUNT[0], WORD_COUNT[1])),
    });
    await page.screenshot({ path: join(SHOTS, '02-menu-open.png') });

    // 🔴 項目を選ぶ
    await page.evaluate(() => {
      (/** @type {any} */ (window)).__io.events.length = 0;
    });
    await click(WORD_COUNT[0], WORD_COUNT[1]);
    await page.waitForTimeout(6000);
    const afterSurvey = await page.evaluate(SURVEY);
    result.steps.push({
      at: 'menu-pick',
      ms: Date.now() - t0,
      events: await page.evaluate(() => (/** @type {any} */ (window)).__io.events.slice()),
      survey: afterSurvey,
    });
    await page.screenshot({ path: join(SHOTS, '03-menu-pick.png') });

    // ③ 効いたか ── 窓が増えたか(ダイアログが出たか)
    const wins = (s) => s.filter((e) => e.kind === 'qt-window');
    result.windowsBefore = wins(openedSurvey).length;
    result.windowsAfter = wins(afterSurvey).length;
    result.titlesAfter = wins(afterSurvey).map((w) => w.title);
    /**
     * 🔴 **命令が実行されたか**を題名で見る。
     * ⚠ 1 稿目は「窓が増えたか」で見ていたが、**メニューが閉じてダイアログが開くと
     *    数が変わらない** ── 効いているのに「効いていない」と読んだ(実際にやった)。
     */
    result.dialogOpened = result.titlesAfter.some((t) => /Word Count/i.test(t ?? ''));
  } finally {
    result.console = consoleLines.slice(-40);
    result.faults = faults;
    await page.screenshot({ path: join(SHOTS, '99-final.png') }).catch(() => {});
    await browser.close().catch(() => {});
    server.close();
  }

  const text = JSON.stringify(result, null, 1);
  console.log(text);
  if (OUT) await writeFile(OUT, text);
}

await main();
