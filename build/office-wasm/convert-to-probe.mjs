/**
 * 🔴 **書き出しフィルタがどの層で落ちるかを、UI を触らずに割る**(#225)。
 *
 * ## なぜこの形か
 *
 * 実機で「`.docx` で保存すると **一般的な I/O エラー**」が 2 レポート連続で出た。
 * 一方 `.odt` は PKC が渡した文書でも通る ── つまり **alien format(非 ODF)への
 * 書き出し**が落ちている。⚠ ところが**この箱では LO を actuate できない**
 * (合成 focus では入力先が決まらない。2026-08-13 / 08-16 に実測済み)ので、
 * 「保存を押す」形の probe は**何も測れない**。
 *
 * 🔑 そこで **命令行の `--convert-to`** を使う。UI を 1 度も触らずに書き出しフィルタ
 * だけを走らせられる。⚠ この経路が一式に在ることは先に確かめてある
 * (`soffice.wasm` の文字列: `convert-to` / `--outdir` / ` using filter : ` /
 * `no export filter for`)。
 *
 * ## 🔴 対照群を同じ回で回す
 *
 * 先に **`--convert-to odt`(native)** を打つ。odt すら出来ない回は
 * 「`--convert-to` がこの一式で効かない」であって、**docx の判定は全部無意味**である
 * (2026-08-13 の教訓「効くはずの一手を手順の先頭に置く」)。
 *
 * ## 結果の読み方(この 1 手で表が埋まる)
 *
 * | 結果 | 意味 |
 * |---|---|
 * | odt も出来ない | 経路が効いていない ── 判定不能(推薦を取り下げる) |
 * | doc も落ちる | alien 共通経路(sfx2 の別形式保存)。OOXML は無関係 |
 * | doc は通り rtf が落ちる | UNO filter service を通す経路 |
 * | doc / rtf は通り docx だけ落ちる | **OOXML / oox / zip 層**(#199 と同じ層) |
 * | 全部通る | 命令行と GUI の保存経路が違う ── 原因は GUI 側(実機へ回す) |
 *
 * ## 🔴 2026-08-17 の実測(この probe を書いて回した結果)
 *
 * **`odt`(対照群)も `docx` も、120 秒で出力が 1 バイトも出なかった。**
 * `booted: true` / `called: true` / `/work` に入力は在る / `fsScan` の hits 0 件 ──
 * つまり **`--convert-to` はこの一式では出力を作らない**(命令行の変換経路が
 * 効いていない)。⚠ したがって「docx だけ落ちる」等の切り分けは**この probe では
 * 出せない**。⚠ 対照群を置いていなければ「docx が落ちた」と**誤って**書いていた。
 *
 * ⚠ 途中で 1 度**自分の harness に騙された** ── 差し込みを
 * `` `…/work/${'INPUT'}…` `` と書いたためテンプレートがその場で評価され、
 * 実際には `/work/INPUT`(拡張子なし)を変換させていた。出力の名前が違うので
 * 「出来ていない」と読めてしまう。**入力の実在を `/work` の一覧で確かめる**まで
 * 気づけなかった(CLAUDE.md §3「NOT-APPLIED を合格と読まない」の probe 版)。
 *
 * 🔑 **残しておく理由**: 一式を焼き直したとき(`--enable-sal-log` を入れる等)、
 * この probe を 1 本走らせれば「命令行の経路が生きたか」が 2 分で分かる。
 *
 * ## 使い方
 *
 *   bash build/office-wasm/fetch-and-run.sh --fetch-only   # 一式を /tmp/lo-wasm へ
 *   node build/office-wasm/convert-to-probe.mjs /tmp/lo-wasm out.json
 *
 * ⚠ **入力は自作の素の text**(機密資料の取り扱い 4「自作の対照群で言い直す」)。
 * ⚠ **撮影の口を持たない** ── この probe は画素を 1 枚も撮らない(rule 6)。
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const PACK = process.argv[2] ?? '/tmp/lo-wasm';
const OUT = process.argv[3] ?? '';
/** 試す書式。⚠ **odt が対照群**なので先頭から動かさない。 */
const FORMATS = (process.env.PKC3_FORMATS ?? 'odt,doc,rtf,docx').split(',');
/** 1 形式あたりの待ち(ms)。⚠ boot が重いので短くしない。 */
const LIMIT_MS = Number(process.env.PKC3_CONVERT_TIMEOUT_MS ?? 180_000);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.metadata': 'application/json',
  '.data': 'application/octet-stream', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
};

/**
 * 自作の入力。⚠ **zip を作らない** ── 素の text なら「入力の読み込み」で
 * 落ちる可能性を消せる(見たいのは**書き出し**の側である)。
 */
const INPUT_NAME = 'pkc3-convert-probe.txt';
const INPUT_TEXT = 'PKC3 convert probe\nline two\nline three\n';

/** 命令行を投げて結果を見る 1 枚。⚠ `callMain` は 1 度しか呼べないので形式ごとに開き直す。 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>convert probe</title>
<style>html,body{margin:0;height:100%}#screen{width:100%;height:100%}</style></head>
<body><div id="screen"></div>
<script src="soffice.js"></script><script src="qtloader.js"></script>
<script>
window.__probe = { booted: false, called: false, exit: null, err: null, out: null };
(async function () {
  try {
    const p = new URLSearchParams(location.search);
    const fmt = p.get('fmt') || 'odt';
    const inst = window.__lo = await window.qtLoad({
      qt: {
        entryFunction: window.soffice_entry,
        containerElements: [document.getElementById('screen')],
        onExit: function (d) { window.__probe.exit = (d && d.code !== undefined) ? d.code : 'exit'; },
      },
    });
    window.__probe.booted = true;
    const FS = inst.FS;
    try { FS.mkdir('/work'); } catch (e) { /* 既に在る */ }
    FS.writeFile('/work/__INPUT__', new TextEncoder().encode(window.__input));
    window.__probe.called = true;
    // ⚠ callMain は event loop に入ったまま戻らないことがある ── 後ろに何も置かない
    // 🔴 アプリと同じ引数で起こす(#158 の --language=ja を含める)。
    //    ⚠ 落とすと repo-hygiene の検査が止める ── その guard は正しい:
    //    probe がアプリと違う構成で起動していたら、測っているものが別物になる
    //    ⚠ ここはテンプレート literal の中なので **バッククォートを書かない**
    //      (書くと文字列がそこで終わり、build も lint も落ちる ── source-editing)
    var args = ['--language=ja', '--convert-to', fmt, '--outdir', '/work', '/work/__INPUT__'];
    inst.callMain(args);
  } catch (e) {
    window.__probe.err = String(e).slice(0, 300);
  }
})();
</script></body></html>`
  /**
   * 🔴 **差し込みは replace でやる**(2026-08-17 に踏んだ)。テンプレート literal の
   * 中に `${'INPUT'}` と書くと **その場で評価されて文字列 `INPUT` になる** ので、
   * 後段の `replace` は 1 度も当たらない ── 実際 `/work/INPUT`(拡張子なし)を
   * 変換させており、**出力の名前が違うので「出来ていない」と読み違えた**。
   * ⚠ CLAUDE.md §3「NOT-APPLIED を合格と読まない」の probe 版である。
   */
  .replace(/__INPUT__/g, INPUT_NAME);

const server = await new Promise((ok) => {
  const s = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const head = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    };
    if (path === '/' || path === '/probe.html') {
      res.writeHead(200, { ...head, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    readFile(join(PACK, path))
      .then((b) => {
        res.writeHead(200, { ...head, 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
        res.end(b);
      })
      .catch(() => {
        res.writeHead(404, head);
        res.end('not found');
      });
  });
  s.listen(0, '127.0.0.1', () => ok(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const PROFILE = `${tmpdir()}/pkc3-convert-${process.pid}`;
const browser = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1000, height: 700 },
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  executablePath: process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium',
});

/** ⚠ 非 ASCII の行は丸ごと捨てる(本文が混じる唯一の経路 ── 機密の取り扱い 3)。 */
const safeLine = (s) => (/[^\x20-\x7e]/.test(s) ? null : s.slice(0, 200));

const result = {
  pack: await readFile(join(PACK, 'build-info.json'), 'utf-8').then(JSON.parse).catch(() => null),
  input: { name: INPUT_NAME, bytes: INPUT_TEXT.length },
  runs: [],
};

for (const fmt of FORMATS) {
  const page = await browser.newPage();
  const lines = [];
  page.on('console', (m) => {
    const t = safeLine(`[${m.type()}] ${m.text()}`);
    if (t && lines.length < 60) lines.push(t);
  });
  page.on('pageerror', (e) => {
    const t = safeLine(`[pageerror] ${String(e)}`);
    if (t) lines.push(t);
  });
  const run = { fmt, booted: false, called: false, out: null, err: null, ms: 0 };
  const t0 = Date.now();
  try {
    await page.addInitScript((text) => {
      window.__input = text;
    }, INPUT_TEXT);
    await page.goto(`${base}/probe.html?fmt=${encodeURIComponent(fmt)}`, { waitUntil: 'commit' });
    /**
     * 観測点は **MEMFS に出来た file**(size > 0)。
     * ⚠ 「console に何か出た」を判定に使わない ── 出ない造りである可能性がある
     *   (この一式は `SAL_WARN` を焼いていない)。console は**診断**として添えるだけ。
     */
    for (;;) {
      const state = await page
        .evaluate(
          (want) => {
            const p = window.__probe ?? {};
            let out = null;
            try {
              const lo = window.__lo;
              if (lo && lo.FS) {
                const s = lo.FS.stat(want);
                out = { size: s.size };
              }
            } catch {
              out = null;   // まだ出来ていない(ENOENT)
            }
            return { booted: !!p.booted, called: !!p.called, err: p.err ?? null, exit: p.exit ?? null, out };
          },
          `/work/${INPUT_NAME.replace(/\.txt$/, '')}.${fmt}`,
        )
        .catch(() => null);
      if (state) {
        run.booted = state.booted;
        run.called = state.called;
        run.err = state.err;
        run.exit = state.exit;
        if (state.out && state.out.size > 0) {
          run.out = state.out;
          break;
        }
      }
      if (Date.now() - t0 > LIMIT_MS) break;
      await page.waitForTimeout(2000);
    }
  } catch (e) {
    run.err = safeLine(String(e)) ?? 'error';
  }
  run.ms = Date.now() - t0;
  /**
   * 🔴 **出来ていないときは「どこにも無い」ことを確かめる**(観測点の取り違えを潰す)。
   * ⚠ 出力先を `--outdir` で指定していても、上流が cwd や `/tmp` へ書く可能性は
   *   **確かめていない**。だから探す先を 1 つに決め打ちせず、**全部見る**。
   */
  run.fsScan = await page
    .evaluate((stem) => {
      const lo = window.__lo;
      if (!lo || !lo.FS) return { error: 'FS が無い' };
      const FS = lo.FS;
      const hits = [];
      const errors = [];
      const walk = (dir, depth) => {
        if (depth > 2 || hits.length > 40) return;
        let names;
        try {
          names = FS.readdir(dir);
        } catch (e) {
          errors.push(`${dir}: ${String(e).slice(0, 60)}`);
          return;
        }
        for (const n of names) {
          if (n === '.' || n === '..') continue;
          const path = dir === '/' ? `/${n}` : `${dir}/${n}`;
          let st;
          try {
            st = FS.stat(path);
          } catch (e) {
            errors.push(`${path}: ${String(e).slice(0, 40)}`);
            continue;
          }
          // ⚠ `isDir` が無い実装もある ── mode のビットで見る(S_IFDIR = 0o040000)
          const isDir = (st.mode & 0o170000) === 0o040000;
          if (!isDir && n.includes(stem)) hits.push({ path, size: st.size });
          if (isDir) walk(path, depth + 1);
        }
      };
      walk('/', 0);
      // 🔴 **空振り防止** ── `/work` が読めているかを別に返す(hits が空でも、
      //    走査そのものが死んでいるのか「本当に無い」のかを区別する)
      let work;
      try {
        work = FS.readdir('/work').filter((n) => n !== '.' && n !== '..');
      } catch (e) {
        work = { error: String(e).slice(0, 60) };
      }
      return { hits, errors: errors.slice(0, 5), work };
    }, INPUT_NAME.replace(/\.txt$/, ''))
    .catch((e) => ({ error: String(e).slice(0, 80) }));
  // 🔑 診断: 成功 / 失敗の 1 行は上流が出す(`using filter :` / `no export filter for`)
  run.filterLine = lines.find((l) => l.includes('using filter')) ?? null;
  run.noFilterLine = lines.find((l) => l.includes('no export filter')) ?? null;
  run.console = lines.slice(0, 20);
  result.runs.push(run);
  await page.close();
}

/**
 * 🔴 **対照群が届いていない回は、以降の判定を無効にする**(2026-08-13 の教訓)。
 * ⚠ 「docx だけ落ちた」と読む前に、**native が出来たこと**を確かめる。
 */
const control = result.runs.find((r) => r.fmt === 'odt');
result.controlOk = control?.out !== null && control?.out !== undefined;
result.verdict = !result.controlOk
  ? '判定不能 ── 対照群(odt)が出来ていない。この経路自体が効いていない'
  : result.runs
        .filter((r) => r.fmt !== 'odt')
        .every((r) => r.out)
    ? '全部通る ── 命令行の経路は健全。GUI の保存経路が原因(実機へ回す)'
    : result.runs.find((r) => r.fmt === 'doc' && !r.out)
      ? 'doc も落ちる ── alien 共通経路(OOXML は無関係)'
      : result.runs.find((r) => r.fmt === 'rtf' && !r.out)
        ? 'rtf が落ちる ── UNO filter service を通す経路'
        : 'docx だけ落ちる ── OOXML / oox / zip 層(#199 と同じ層)';

const text = JSON.stringify(result, null, 2);
if (OUT) await writeFile(OUT, text);
console.log(text);

await browser.close().catch(() => {});
server.close();
// ⚠ **profile を残さない**(機密資料の取り扱い 5)
await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
