/**
 * **Office(LO wasm)の中でコピーしたとき、外のクリップボードがどうなるか**を測る probe(#121 の「測る」)。
 *
 * 既知(2026-10-04 時点)は「LO の中で `Ctrl+C` → 外を読むと**空**(2/2)/ 外で置いた物は
 * 何もしなければ維持される(対照群 2/2)」だけで、n=2・1 つの箱・字 1 種だった。
 * ここは**どの出し方 × どの中身**で空になるかを、各 n=3 で割る:
 *
 * | 腕 | 外で種を置く | LO の中でやること | その後 |
 * |---|---|---|---|
 * | `C`  | ✅ | **何もしない**(字を打つだけ。対照群) | 外を読む |
 * | `C2` | ✅ | 右クリックしてメニューを開き `Escape` で閉じる(**コピーしない**。B2 の対照群) | 外を読む |
 * | `B0` | ✅ | **何も選ばずに** `Ctrl+C`(依頼文の腕に無い追加の対照) | 外を読む |
 * | `B1` | ✅ | 字を全部選んで **`Ctrl+C`** | 外を読む |
 * | `B2` | ✅ | 字を全部選んで **右クリック → メニューの「コピー」を押す** | 外を読む |
 * | `B2k` | ✅ | 同じ右クリック → メニューを**近道キー `y`**(`コピー(Y)`)で選ぶ(B2 の別の出し方) | 外を読む |
 * | `B2w` | ✅ | `B2` と同じ手順の後、**2 秒待ってから版面(canvas)の中の無害な位置(右下寄り)へ `mouse.move` を 1 回**(#1344 の判別用。⚠ 既定では回さない ── `PKC3_ARMS=B2w` と名指ししたときだけ) | 外を読む |
 * | `B3` | ✅ | **画像**を `Shift+→` で選んで(段落先頭の 1 文字として)`Ctrl+C` | 外を読む |
 * | `B3c` | ✅ | **画像を左クリックで選んで**(枠の取っ手が出る)`Ctrl+C`(B3 の別の選び方。押す) | 外を読む |
 * | `B4` | ✅ | **表**を選んで `Ctrl+C` | 外を読む |
 * | `B5` | ✅ | 字を全部選んで **ツールバーの「コピー」ボタンを左クリック**(ポインタ起源・popup なし) | 外を読む |
 * | `B6` | ✅ | 字を全部選んで **メニューバー `Alt+E`(編集)→ 近道キー `y`(`コピー(Y)`)**。キーだけ | 外を読む |
 * | `B7` | ✅ | 字を全部選んで **`Ctrl+Insert`**(キー起源・別の accelerator) | 外を読む |
 * | `B8` | ✅ | 字を全部選んで**何もコピーしない**(`B1`〜`B7` の「LO の中の観測」の**陰性対照**) | 外を読む |
 *
 * 🔴 **`B1` が `B1'`(`B5`〜`B7` の陽性対照)を兼ねる** ── 同じ回の中で同じ手順(`Control+a` → `Control+c`)を
 * 回し直すだけなので、別名の腕は作らない。
 *
 * ## #121「右クリックの『コピー』だと host へ書き込み依頼が 0 件」を割る 3 腕(B5〜B7)
 *
 * 仮説 **H1** = `.uno:Copy` は実行され `QtClipboard::setContents` も呼ばれるが、Qt wasm が Clipboard API を呼ばない。
 * 仮説 **H2** = メニュー経由では `.uno:Copy` 自体が実行されていない(popup の選択がネストした Yield の後に dispatch される)。
 *
 * 🔴 **予測(回す前に書いた。結果の後から規則を変えない)**:
 *
 * | 腕 | 起源 | H1 なら host への write 依頼 | H2 なら host への write 依頼 |
 * |---|---|---|---|
 * | `B5` ツールバーのボタン | ポインタ(popup なし) | **0 件** | **来る** |
 * | `B6` メニューバー → 近道キー | キー(popup あり) | **0 件** | **0 件** |
 * | `B7` `Ctrl+Insert` | キー(別の accelerator) | 来るか不明 | **来る** |
 * | `B1`(= `B1'`) `Ctrl+C` | キー | **来る** | **来る** |
 *
 * 読み方: `B5` が来て `B2`(既存)/ `B6` が来なければ **H2** に寄る。`B5` も来なければ **H1** に寄る。
 *
 * ### 「コピーが LO の中で実行されたか」の観測(列 `loPaste` / `pasteBtn`)
 *
 * write 依頼が 0 件でも、LO の**中**のクリップボードに入っていれば「実行はされた(Qt → ブラウザの間で消えた)」= H1 寄り、
 * 入っていなければ H2 寄り。観測は 2 本(**どちらも版面の画素の集合が入れ替わったか**で見る。何が入ったかは言えない):
 *
 *   ① `loPaste` … 腕の後に `ArrowRight` → `Ctrl+End` → `Ctrl+V` して**本文の版面**が変わったか。
 *   ② `pasteBtn` … ツールバーの**「貼り付け」ボタン**(LO の中が空のときは灰色)の領域が、腕の前後で変わったか。
 *      (外へ種を置いた後も灰色のままであることを、先に画面で確かめてある = 外の値には反応しない)
 *
 * 🔴 **①は外の種で満たされうる**(LO の `Ctrl+V` が外の `OUTSIDE-…` を読んで貼れば、コピーしていなくても変わる)。
 *   だから**陰性対照 `B8`(選ぶだけで何もコピーしない)で、①②が「変わらない」ことを見る**。
 *   `B8` で①が変わるなら、①は読まない(②だけで読む)。`B8` で②が変わるなら、②も読まない。
 *   予測: `B8` は ①②とも**変わらない**、`B1` は ①②とも**変わる**。
 *
 * ### 判定不能の追加規則(回す前に書いた)
 *
 *   ⑧ `B5`: ボタンの位置に**そもそもボタンが無い**(コピーボタンの領域が、ポインタを乗せる前後で**1 ビットも変わらない**)回は
 *      「当たったか不明」として**数に入れる/入れないを分ける**(`landUnknown` に別立て。write 依頼 0 件を「実行されない」と読まない)。
 *   ⑨ `B6`: `Alt+E` を **3 回まで**押し直し、**メニューの窓が増えなかった**回は判定不能(開いていない回に `y` を押すと字が入る)。
 *   ⑩ `B6` / `B7`: 選択が版面に出なかった回は判定不能(既存の ④)。
 *
 * 全部 **n=3**(判定不能は数に入れず、上限 +2 回まで回し足す)。
 *
 * ## 何を読むか(読みは書かない ── 数と字だけ出す)
 *
 * - `after.text` / `after.types` … 頁の `navigator.clipboard.readText()` / `read()` が返した物
 * - `emptied` … `readText()` が空文字だったか(**空 = 種が消えた**)
 * - `afterOtherPage` … 同じ origin の**別の頁**(空の頁)を前面に出して読み直した値
 * - `hostWrites` … LO の worker が host へ送った **書き込みの依頼**(`BroadcastChannel`
 *   `pkc3-clipboard` を横から聞く)と、host が実際に呼んだ `navigator.clipboard.write` の
 *   **成否**(頁の `write` を包んで採る)。⚠ これは製品コードを変えずに採る**傍受**である
 * - `clipTrace` … page の console のうち `PKC3-CLIP` / `PKC3-MENU` / `PKC3-UEV` を含む行を `[+<ms>]` 付きで**直近 3000 行**
 *   (🔴 **ring** ── 溢れたら**古い行を落とす**。頭取りだと、起動時の大量の行で枠を使い切り、肝心の popup 付近が落ちる)
 *   (`patch-lo-clip-trace.py` / `patch-lo-menu-trace.py` / `patch-lo-uev-trace.py` の計装が出す。名前は `clip` のままだが**全部入る**。
 *   既存の `console` は 40 行で `PKC3-SCHED` に埋まるので別に持つ)。
 *   ⚠ `PKC3-UEV` の行は 160 字で切らず **4000 字**まで残す(`emscripten_log` の C stack は改行入りの 1 message)。
 *   改行は残し、**非 ASCII の行(1 message の中の 1 行)は捨てる**(stack は ASCII)
 * - `faults[].stack` … `memory access out of bounds` / `RuntimeError` / `Aborted(` の `pageerror` の stack
 *   (非 ASCII の行は捨て、1 行 200 字・全体 4000 字で切る。`RuntimeError: unreachable` の出所を読むため)
 *
 * ## 判定不能の規則(回す**前**に書いてある。結果の後から緩めない)
 *
 * 次のどれかなら、その回は**数に入れない**(`verdict: 判定不能(…)`):
 *   ① 文書が開かなかった ② 外へ種を置けなかった / 置いた直後に読み戻せなかった
 *   ③ **字を打っても版面が変わらなかった**(入力が LO に届いていない。SKILL §4 の対照群)
 *   ④ 選ぶ腕(B1〜B4)で、**選択が版面に出なかった**(Ctrl+C の前に版面が変わらない)
 *   ⑤ `B2` / `B2k` / `B2w` / `C2` で**メニューが開かなかった**(窓の数が増えない ── 続く鍵は字として入る)
 *   ⑥ **コピーの前に** `memory access out of bounds` が出た(修飾キーの経路が死ぬ。SKILL §14)
 *   ⑦ 版面が固まった / 回の締切を超えた
 * 判定不能の回は数に入れず、**判定できた回が n 回になるまで回し足す**(上限は +2 回。足りなければ表の `valid` が n 未満になる)。
 *
 * ## 押すことについて(SKILL §14)
 *
 * 版面を**クリック**すると、LO が落ちる(`memory access out of bounds` / `unreachable`)回がある
 * (SKILL §14 は 2026-08-30 の実測で 10 回中 5 回)。だから**押さずに済む腕は押さない**
 * (開いた直後の caret は本文の先頭に在る ── 字は押さずに打てる / `B0` `B1` `B3` `B4` はキーだけで選ぶ)。
 * 押す腕は `C2` / `B2`(右クリック + メニューの項目)/ `B3c`(画像を左クリック)で、
 * `C2` が「押しただけでコピーしない」群である。⚠ 落ちた回は `faults` に時刻を出す
 * (コピーの**後**に落ちた回は、外の値には影響しないので判定不能にしない ── `faultsAtRead` で見分ける)。
 *
 * ## 使い方
 *
 *   python3 build/office-wasm/make-clipboard-fixtures.py /tmp/fx          # 自作の .odt 3 つ
 *   node build/office-wasm/make-pages-bundle.mjs <LO 展開先> /tmp/pack    # SKILL §1〜§3
 *   node build/office-wasm/clipboard-probe.mjs /tmp/pack /tmp/fx out.json [回数=3]
 *
 *   PKC3_ARMS=C,B1,B2   腕を絞る(既定は全部)
 *   PKC3_N_START=<n>    回の番号の開始(既定 1)。判定不能の回を埋め合わせるとき、前と番号を被せない
  PKC3_DIST=<dir>     `office/host.html` を配る場所(既定 `public` ── host.html は静的なので build 不要)
 *   PKC3_SHOTDIR=<dir>  各段の版面を PNG で残す。⚠ **自作の fixture を開いたときだけ**渡すこと
 *                       (機密資料の取り扱い 6 ── 渡さなければ撮れない形)
 *   PKC3_CTX_X / PKC3_CTX_Y   右クリックする比(既定 0.27 / 0.31 = text.odt の 1 行目の字の上)
 *
 * ⚠ 1 回ごとに Chromium を起こし直す(前の回の状態を持ち越さない)。
 */

import { createServer } from 'node:http';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { armWatchdog } from './probe-watchdog.mjs';

const PACK = resolve(process.argv[2] ?? '');
const FX = resolve(process.argv[3] ?? '');
const OUT = process.argv[4] ?? '';
const ROUNDS = Number(process.argv[5] ?? 3);
const DIST = resolve(process.env.PKC3_DIST ?? 'public');
const SHOTDIR = process.env.PKC3_SHOTDIR ?? '';
const CTX_X = Number(process.env.PKC3_CTX_X ?? '0.27');
const CTX_Y = Number(process.env.PKC3_CTX_Y ?? '0.31');
/** `B2w` が mouse.move を打つ canvas の比(右下寄り。本文の字には当たらない。⚠ canvas の**外**は Qt の event が立たず対照にならない)。 */
const NUDGE_X = 0.9;
const NUDGE_Y = 0.9;
const ROUND_SEC = Number(process.env.PKC3_ROUND_SEC ?? 240);
/** 判定不能の回の埋め合わせに回し足すとき、種の名前が前と被らないよう開始番号を変える。 */
const N_START = Number(process.env.PKC3_N_START ?? 1);
const ALL_ARMS = ['C', 'B0', 'B1', 'C2', 'B2', 'B2k', 'B3', 'B3c', 'B4', 'B5', 'B6', 'B7', 'B8', 'B2w', 'B2f'];
/**
 * 既定では回さない腕(#1344 の判別用。マウスで popup を選んだ後の 10〜12 秒の停止が、次の Qt 入力で動き出すかを見る)。
 * ⚠ `ALL_ARMS` に入れるのは**名指しで選べるように**するため ── 入れても既定の回(全部)には混ぜない
 *   (既存の腕の回数と所要を変えない)。
 */
const OPT_IN_ARMS = ['B2w', 'B2f'];
/**
 * `B2f` が `Control+a` の後に右クリックまで待つ ms(#1344 の競合を狙う腕)。🔑 Ctrl+A の後、LO は status update の
 * user event を ~200 件 post し、main loop はその 1 件ごとに `ProcessEvent` → `emscripten_promise_await`(handler thread への
 * proxy 待ち)で止まる。その窓に DOM event(別の promising な計算)を入れると、main が Qt の stack に載っていないまま
 * メニューの loop が止まり、proxy の戻りで main が門なしで起きて内側の frame を踏む(2026-10-05 の読み)。
 */
const FAST_MS = Number(process.env.PKC3_FAST_MS ?? 150);
/**
 * ツールバーの「コピー」ボタンの位置(**canvas の比**)。🔑 見つけ方: 自作の `text.odt` を開いて字を全部選んだ版面の PNG
 * (1280x800)に、ツールバー 1 段目の `切り取り(はさみ)/ コピー(2 枚の紙)/ 貼り付け(クリップボード)` が並ぶ。
 * 6 倍に拡大して**コピー(2 枚の紙)の中心**を読むと page 座標 (308, 102)。canvas は (8, 60) 1272x736 なので
 * 比 = ((308-8)/1272, (102-60)/736) = (0.236, 0.057)。⚠ 窓の大きさが変わると指す先がずれる ── 押した座標は `row.pressed` に残す。
 */
const TB_COPY_X = Number(process.env.PKC3_TB_COPY_X ?? '0.236');
const TB_COPY_Y = Number(process.env.PKC3_TB_COPY_Y ?? '0.057');
const ARMS = (process.env.PKC3_ARMS ?? ALL_ARMS.filter((a) => !OPT_IN_ARMS.includes(a)).join(',')).split(',').filter((a) => ALL_ARMS.includes(a));
/** 腕 → 開く文書。`C` / `B1` / `B2` / `C2` は字だけ、`B3` は画像、`B4` は表。 */
const DOC_OF = { C: 'text.odt', B0: 'text.odt', B1: 'text.odt', C2: 'text.odt', B2: 'text.odt', B2k: 'text.odt', B2w: 'text.odt', B2f: 'text.odt', B3: 'image.odt', B3c: 'image.odt', B4: 'table.odt', B5: 'text.odt', B6: 'text.odt', B7: 'text.odt', B8: 'text.odt' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.metadata': 'application/json',
  '.gz': 'application/gzip',
  '.ttf': 'font/ttf',
  '.data': 'application/octet-stream',
};

function serve() {
  return new Promise((ok) => {
    const s = createServer((req, res) => {
      const p = (req.url ?? '/').split('?')[0];
      const head = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store',
      };
      // 🔑 「別の頁から読む」用の空の頁(LO を起こさない)。⚠ host の頁と同じ origin
      if (p === '/__reader.html') {
        res.writeHead(200, { ...head, 'Content-Type': MIME['.html'] });
        res.end('<!doctype html><title>reader</title><p>reader');
        return;
      }
      const f = p.startsWith('/office-pack/') ? join(PACK, p.slice('/office-pack/'.length)) : join(DIST, p);
      readFile(f)
        .then((b) => {
          res.writeHead(200, { ...head, 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' });
          res.end(b);
        })
        .catch(() => {
          res.writeHead(404, head);
          res.end();
        });
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}

/** 制御文字や非 ASCII の混入で JSON を汚さない(console は外の文字列である)。 */
const safeLine = (s) => (/[^\x20-\x7e]/.test(s) ? null : s.slice(0, 160));
/** 直近 `max` 件だけ残す ring。溢れたら古い物から落とす(頭取りではない)。 */
const pushRing = (arr, item, max) => {
  arr.push(item);
  if (arr.length > max) arr.shift();
};
/**
 * `PKC3-UEV` の行用。`emscripten_log` の C stack は**改行入りの 1 message**なので、`safeLine` では(改行が
 * 範囲外なので)丸ごと捨てられる。1 行ずつ見て、**非 ASCII の行だけ捨て**、残りを改行で繋いで 4000 字で切る。
 * 何も残らなければ null。
 */
const safeUevLine = (s) => {
  const kept = [];
  for (const line of s.split('\n')) {
    const t = line.trimEnd();
    if (t !== '' && !/[^\x20-\x7e]/.test(t)) kept.push(t);
  }
  return kept.length === 0 ? null : kept.join('\n').slice(0, 4000);
};
const safeErr = (e) => {
  for (const line of String(e).split('\n')) {
    const t = safeLine(line.trim());
    if (t !== null && t !== '') return t;
  }
  return 'error';
};

/**
 * `pageerror` の stack を残す(1 件 ≤ 4000 字)。⚠ `safeLine` と同じ作法で、**非 ASCII の行は行ごと捨てる**
 * (本文らしき物が混じる唯一の経路)。1 行は 200 字で切る。
 */
const safeStack = (e) => {
  const raw = e && typeof e === 'object' && typeof e.stack === 'string' ? e.stack : '';
  const kept = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t !== '' && !/[^\x20-\x7e]/.test(t)) kept.push(t.slice(0, 200));
  }
  return kept.join('\n').slice(0, 4000);
};

/** ⚠ `qt-window` は shadow root の中にも生えるので、**潜って**数える。 */
const COUNT_QT_WINDOWS = `(() => {
  let n = 0;
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.classList && el.classList.contains('qt-window')) n += 1;
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return n;
})()`;

/** 版面(いちばん大きい canvas)の位置。⚠ Qt 6 の canvas は shadow root の中。 */
const CANVAS_BOX = `(() => {
  let best = null;
  const walk = (n) => { for (const el of n.querySelectorAll('*')) {
    if (el.tagName === 'CANVAS' && el.width > 0) {
      const r = el.getBoundingClientRect();
      if (!best || r.width > best.w) best = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  return best;
})()`;

/** qt-window(メニュー・ダイアログ)の矩形を全部。右クリックのメニューを探すのに使う。 */
const QT_WINDOW_RECTS = `(() => {
  const out = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.classList && el.classList.contains('qt-window')) {
        const r = el.getBoundingClientRect();
        out.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return out;
})()`;

/**
 * 🔴 **傍受**(製品コードは変えない)。頁が開く**前**に差す。
 *
 * ① `pkc3-clipboard` の放送を**横から聞く** ── LO の worker が host へ送る「書いてくれ」の依頼
 *    (`clip: 'write'`)と「読んでくれ」の依頼(`clip: 'read'`)を数える。型と大きさだけ採る。
 * ② 頁の `navigator.clipboard.write` / `writeText` を**包む** ── host が実際に呼んだ回数と成否
 *    (`ok` / `err`)。⚠ 包むのは呼び出しの前後を採るだけで、引数も返り値も変えない。
 * ⚠ 受け取った中身は**型・大きさ・先頭 60 字**だけ残す(自作 fixture の字なので出してよい)。
 */
const SPY = `(() => {
  const W = globalThis;
  W.__clip = { bc: [], writes: [], texts: [] };
  const t0 = Date.now();
  const dec = (buf) => { try { return new TextDecoder().decode(buf).slice(0, 60); } catch (e) { return null; } };
  try {
    const ch = new BroadcastChannel('pkc3-clipboard');
    ch.addEventListener('message', (ev) => {
      const d = ev.data;
      if (!d || d.reply || !d.clip) return;
      W.__clip.bc.push({
        dt: Date.now() - t0,
        clip: d.clip,
        kind: d.kind ?? null,
        parts: Array.isArray(d.parts)
          ? d.parts.map((p) => ({
              type: p.type,
              bytes: p.buf ? p.buf.byteLength : null,
              head: /^text\\//.test(p.type) && p.buf ? dec(p.buf) : null,
            }))
          : null,
      });
    });
  } catch (e) { W.__clip.bcErr = String(e).slice(0, 80); }
  const cb = navigator.clipboard;
  if (!cb) { W.__clip.noClipboard = true; return; }
  const ow = cb.write.bind(cb);
  cb.write = async (items) => {
    const rec = { dt: Date.now() - t0, kind: 'write', items: [] };
    W.__clip.writes.push(rec);
    try {
      for (const it of items || []) {
        const one = { types: Array.from(it.types || []), sizes: {} };
        for (const t of one.types) {
          try { const b = await it.getType(t); one.sizes[t] = b.size; } catch (e) { one.sizes[t] = 'ERR'; }
        }
        rec.items.push(one);
      }
    } catch (e) { rec.spyErr = String(e).slice(0, 80); }
    try {
      const r = await ow(items);
      rec.ok = true;
      return r;
    } catch (e) {
      rec.err = (e && e.name ? e.name : 'Error') + ':' + String(e && e.message ? e.message : e).slice(0, 100);
      throw e;
    }
  };
  const ot = cb.writeText.bind(cb);
  cb.writeText = async (s) => {
    const rec = { dt: Date.now() - t0, kind: 'writeText', len: String(s).length, head: String(s).slice(0, 60) };
    W.__clip.writes.push(rec);
    try { const r = await ot(s); rec.ok = true; return r; }
    catch (e) { rec.err = (e && e.name ? e.name : 'Error') + ':' + String(e && e.message ? e.message : e).slice(0, 100); throw e; }
  };
})()`;

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const result = {
  how: {
    harness: 'build/office-wasm/clipboard-probe.mjs',
    rounds: ROUNDS,
    arms: ARMS,
    read: 'page.evaluate(navigator.clipboard.readText() / read()) ── Office の host 頁そのもの(外のブラウザ側)',
    seed: 'page.evaluate(navigator.clipboard.writeText("OUTSIDE-<腕>-<n>"))',
    permissions: ['clipboard-read', 'clipboard-write'],
    keys: {
      type: "keyboard.type('Q', delay 120) → BackSpace(caret を先頭へ戻す)",
      B0: 'Control+c(選択なし。caret は先頭)',
      B1: 'Control+a → Control+c',
      B2: `Control+a → mouse.click(button=right, canvas の比 ${CTX_X}/${CTX_Y}) → メニュー(開いた窓)の上端から 40px 下の「コピー(Y)」を mouse.click(left)`,
      B2k: `同じ右クリック → keyboard.press('y')(コピー(Y))`,
      B2w: `B2 と同じ → 2 秒待つ → 版面の中(canvas の右下寄り ${NUDGE_X}/${NUDGE_Y})へ mouse.move を 1 回(押さない)→ 外を読む`,
      B2f: `Control+a → ${FAST_MS} ms 待つだけで右クリック(status update の burst の最中に DOM event を入れる。#1344 の競合狙い)→ B2 と同じ「コピー(Y)」の click`,
      C2: `mouse.click(button=right, canvas の比 ${CTX_X}/${CTX_Y}) → Escape`,
      B3: 'Shift+ArrowRight(先頭の段落の画像 1 枚を選ぶ)→ Control+c',
      B3c: 'mouse.click(left, canvas の比 0.30/0.40 = 画像の上)→ Control+c',
      B4: 'Control+a ×2(セル → 表)→ Control+c',
      B5: `Control+a → mouse.click(left, canvas の比 ${TB_COPY_X}/${TB_COPY_Y} = ツールバーの「コピー」ボタン)`,
      B6: "Control+a → Alt+e(開くまで最大 3 回)→ 'y'(`コピー(Y)`)",
      B7: 'Control+a → Control+Insert',
      B8: 'Control+a → (何もコピーしない)',
    },
    doc: DOC_OF,
    dist: DIST,
    pack: PACK,
    chromium: process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium',
  },
  rounds: [],
};
let current = null;
const wd = armWatchdog({ result, out: OUT, limitSec: ARMS.length * ROUNDS * ROUND_SEC + 300, browser: () => current });

const flush = async () => {
  const text = JSON.stringify(result, null, 1);
  if (OUT) await writeFile(OUT, text);
};

/** 1 回(= 1 腕 × 1 回)。⚠ 戻り値は表の 1 行。 */
async function oneRound(arm, n) {
  const docName = DOC_OF[arm];
  const docB64 = (await readFile(join(FX, docName))).toString('base64');
  const seed = `OUTSIDE-${arm}-${n}`;
  const row = { arm, n, doc: docName, seed, steps: [], faults: [], console: [], clipTrace: [] };
  const profile = `${tmpdir()}/pkc3-clip-${process.pid}-${arm}-${n}`;
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium',
  });
  current = ctx;
  const t0 = Date.now();
  const step = (name, extra = {}) => row.steps.push({ at: Date.now() - t0, name, ...extra });
  const page = await ctx.newPage();
  try {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  } catch (e) {
    row.permissionErr = safeErr(e);
  }
  page.on('console', (m) => {
    const t = safeLine(`[${m.type()}] ${m.text()}`);
    // ⚠ `clipTrace` は `PKC3-CLIP`(コピー)/ `PKC3-MENU`(popup メニューの選択)/ `PKC3-UEV`(user event)の**全部**が入る(名前は据え置き)
    //    `PKC3-UEV` だけ 4000 字まで残す(C stack は改行入り)。他は従来どおり 160 字
    const tu = m.text().includes('PKC3-UEV') ? safeUevLine(`[${m.type()}] ${m.text()}`) : t;
    if (tu !== null && /PKC3-(CLIP|MENU|UEV)/.test(m.text())) pushRing(row.clipTrace, `[+${Date.now() - t0}ms]${tu}`, 3000);
    if (t !== null && row.console.length < 40) row.console.push(`[+${Date.now() - t0}ms]${t}`);
  });
  page.on('pageerror', (e) => {
    const t = safeLine(`[pageerror] ${String(e)}`);
    if (t !== null && row.console.length < 40) row.console.push(`[+${Date.now() - t0}ms]${t}`);
    if (/memory access out of bounds|RuntimeError|Aborted\(/.test(String(e))) {
      // 🔑 `stack` は捨てない(`RuntimeError: unreachable` の出所を、名前つきの一式で読む)
      row.faults.push({ at: Date.now() - t0, text: safeErr(e), stack: safeStack(e) });
    }
  });
  page.on('requestfailed', (r) => {
    const t = safeLine(`[requestfailed] ${r.url().replace(base, '')} ${r.failure()?.errorText ?? ''}`);
    if (t !== null && row.console.length < 40) row.console.push(`[+${Date.now() - t0}ms]${t}`);
  });
  const alive = () =>
    Promise.race([
      page.evaluate('1').then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), 8000)),
    ]);
  const lastStep = () => (row.steps.length ? row.steps[row.steps.length - 1].name : 'start');
  /** 判定不能の理由を 1 つ立てる(最初の 1 つだけ残す)。 */
  const undecidable = (why) => {
    row.undecidable = row.undecidable ?? why;
  };
  const shot = async (label) => {
    if (!SHOTDIR) return;
    await mkdir(SHOTDIR, { recursive: true });
    try {
      await page.screenshot({ path: join(SHOTDIR, `${arm}-${n}-${label}.png`) });
    } catch {
      /* 固まっていたら撮れない */
    }
  };
  const canvasBox = () => page.evaluate(CANVAS_BOX);
  /** 版面を「集合」で採る(点滅する caret だけで「変わった」にしない。CLAUDE.md §4)。 */
  const framesOf = async (clip, k = 4) => {
    const set = new Set();
    for (let i = 0; i < k; i += 1) {
      const png = await Promise.race([
        page.screenshot({ clip }),
        new Promise((r) => setTimeout(() => r(null), 20000)),
      ]);
      if (png === null) return null;
      set.add(createHash('sha256').update(png).digest('hex').slice(0, 16));
      await page.waitForTimeout(400);
    }
    return [...set];
  };
  const swapped = (a, b) => (a === null || b === null ? null : b.every((h) => !a.includes(h)));
  /** 外のクリップボードを読む(頁の中で締切を張る)。 */
  const readOutside = (pg = page) =>
    Promise.race([
      pg.evaluate(`(async () => {
        const late = new Promise((r) => setTimeout(() => r({ hung: 'in-page' }), 15000));
        const go = (async () => {
          const o = { focus: document.hasFocus() };
          try { o.text = await navigator.clipboard.readText(); } catch (e) { o.textErr = String(e && e.name || e).slice(0, 60); }
          try {
            const items = await navigator.clipboard.read();
            o.types = items.map((it) => Array.from(it.types));
          } catch (e) { o.readErr = String(e && e.name || e).slice(0, 60); }
          return o;
        })();
        return await Promise.race([go, late]);
      })()`),
      new Promise((r) => setTimeout(() => r({ hung: 'node' }), 25000)),
    ]).catch((e) => ({ err: safeErr(e) }));
  const seedOutside = () =>
    Promise.race([
      page.evaluate(`(async () => {
        const late = new Promise((r) => setTimeout(() => r({ hung: 'in-page' }), 15000));
        const w = navigator.clipboard.writeText(${JSON.stringify(seed)}).then(() => ({ ok: true }), (e) => ({ err: String(e && e.name || e).slice(0, 60) }));
        return await Promise.race([w, late]);
      })()`),
      new Promise((r) => setTimeout(() => r({ hung: 'node' }), 25000)),
    ]).catch((e) => ({ err: safeErr(e) }));

  try {
    step('一式を IDB へ');
    await page.goto(`${base}/office/host.html`, { waitUntil: 'domcontentloaded' });
    row.staged = await page.evaluate(async () => {
      const { fetch, indexedDB } = globalThis;
      const grab = async (path) => {
        const r = await fetch(path);
        if (!r.ok) throw new Error(`${path} が取れない(HTTP ${r.status})`);
        return r;
      };
      const m = await (await grab('/office-pack/pack.json')).json();
      const names = [...m.files, ...m.fonts];
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('pkc3-office-pack', 1);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains('files')) r.result.createObjectStore('files');
          if (!r.result.objectStoreNames.contains('meta')) r.result.createObjectStore('meta');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const put = (s, k, v) =>
        new Promise((res, rej) => {
          const t = db.transaction(s, 'readwrite');
          t.objectStore(s).put(v, k);
          t.oncomplete = () => res();
          t.onerror = () => rej(t.error);
        });
      let bytes = 0;
      for (const nm of names) {
        // ⚠ `Response.blob()` ではなく `arrayBuffer()` → `new Blob`。ディスクの空きが少ない箱
        //   (実測: 空き 2.2GB)では大きい `blob()` が `net::ERR_FAILED` で落ちる(`arrayBuffer()` は通る)
        const b = new globalThis.Blob([await (await grab(`/office-pack/${nm}`)).arrayBuffer()]);
        bytes += b.size;
        await put('files', nm, b);
      }
      await put('meta', 'pack', {
        version: m.version,
        installedAt: Date.now(),
        source: 'url',
        totalBytes: bytes,
        files: names.map((nm) => ({ name: nm })),
      });
      return { count: names.length, version: m.version, crossOriginIsolated: globalThis.crossOriginIsolated };
    });

    // 文書の送り手 + 傍受(頁が開く前に差す)
    await page.addInitScript(SPY);
    await page.addInitScript(({ doc, name }) => {
      const ch = new globalThis.BroadcastChannel('pkc3-office');
      ch.onmessage = (ev) => {
        const d = ev.data;
        if (!d || !d.pkc3Office) return;
        if (d.pkc3Office === 'ready-for-document') {
          const raw = globalThis.atob(doc);
          const u8 = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i += 1) u8[i] = raw.charCodeAt(i);
          ch.postMessage({ pkc3Office: 'document', payload: { name, bytes: u8 } });
        }
      };
    }, { doc: docB64, name: docName });

    step('文書を渡して開く');
    await page.goto(`${base}/office/host.html?await-doc=1&name=${encodeURIComponent(docName)}`, { waitUntil: 'commit' });
    // 開いた = Qt の器の中の題名に「渡した名前」と LibreOffice が両方出た(host の帯は数えない)
    let opened = null;
    for (let i = 0; i < 40 && opened === null; i += 1) {
      await page.waitForTimeout(3000);
      try {
        const r = await Promise.race([
          page.evaluate((NAME) => {
            const titles = [];
            const wt = (node) => {
              for (const el of node.querySelectorAll('*')) {
                if (el.shadowRoot) wt(el.shadowRoot);
                else if (el.children.length === 0) titles.push(el.textContent ?? '');
              }
            };
            const screen = document.getElementById('screen');
            if (screen) wt(screen);
            const all = titles.join(' ');
            return { docOpen: all.includes(NAME), loTitle: /LibreOffice/i.test(all) };
          }, docName),
          new Promise((_, rej) => setTimeout(() => rej(new Error('unresponsive')), 4000)),
        ]);
        if (r.docOpen && r.loTitle) opened = { atMs: Date.now() - t0 };
      } catch {
        /* 次の回で */
      }
      if (row.faults.length) break;
    }
    row.opened = opened;
    if (opened === null) {
      undecidable('文書が開かなかった');
      return row;
    }
    await page.bringToFront();
    await page.waitForTimeout(3000);
    step('開いた', { crossOriginIsolated: row.staged.crossOriginIsolated });
    await shot('1-opened');
    if (!(await alive())) {
      undecidable('版面が固まった(開いた直後)');
      return row;
    }
    const box = await canvasBox();
    row.canvas = box;
    if (!box) {
      undecidable('canvas が見つからない');
      return row;
    }
    const clip = { x: box.x, y: box.y, width: box.w, height: box.h };

    // ① 外へ種を置く → 読み戻す(置けたか)
    step('種を置く');
    row.seedWrite = await seedOutside();
    const back = await readOutside();
    row.seedBack = { text: back.text ?? null, focus: back.focus ?? null, err: back.textErr ?? back.hung ?? back.err ?? null };
    if (row.seedWrite.ok !== true || back.text !== seed) {
      undecidable(`外へ種を置けなかった(write=${JSON.stringify(row.seedWrite)} / 読み戻し=${JSON.stringify(row.seedBack)})`);
      return row;
    }

    // ② 対照 ── 字を打って版面が変わったか(入力が LO に届いているか)。押さない
    step('打鍵の対照');
    const f0 = await framesOf(clip);
    await page.keyboard.type('Q', { delay: 120 });
    await page.waitForTimeout(1500);
    const f1 = await framesOf(clip);
    row.typedArrived = swapped(f0, f1);
    await page.keyboard.press('Backspace'); // caret を先頭へ戻す(以降の選び方が先頭前提)
    await page.waitForTimeout(800);
    await shot('2-typed');
    if (row.typedArrived !== true) {
      undecidable('字を打っても版面が変わらなかった(入力が LO に届いていない)');
      return row;
    }
    if (!(await alive())) {
      undecidable('版面が固まった(打鍵の後)');
      return row;
    }

    // ③ コピーの直前の外の値
    row.before = (await readOutside()).text ?? null;
    row.hostWritesBefore = await page.evaluate('globalThis.__clip.writes.length');

    // ④ 腕ごとの手
    const ctxClick = async () => {
      const before = await page.evaluate(COUNT_QT_WINDOWS);
      const x = box.x + box.w * CTX_X;
      const y = box.y + box.h * CTX_Y;
      row.pressed = { x: Math.round(x), y: Math.round(y), button: 'right' };
      await page.mouse.click(x, y, { button: 'right' });
      await page.waitForTimeout(2500);
      const opened = await page.evaluate(COUNT_QT_WINDOWS);
      row.menu = { before, opened, rects: await page.evaluate(QT_WINDOW_RECTS) };
      await shot('4-menu');
      return opened > before;
    };
    let selected = null;
    // LO の中の「貼り付け」ボタンの領域(ツールバーのコピーの右隣。canvas の比で切る)
    const pasteBtnClip = { x: Math.round(box.x + box.w * 0.25), y: Math.round(box.y + box.h * 0.04), width: 28, height: 33 };
    let pasteBtnBefore = null;
    step(`腕 ${arm}`);
    if (arm === 'C') {
      await page.waitForTimeout(2500);
    } else if (arm === 'B0') {
      await page.keyboard.press('Control+c');
      row.copyKey = 'Control+c';
    } else if (arm === 'B1') {
      const a = await framesOf(clip);
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(1000);
      selected = swapped(a, await framesOf(clip));
      await shot('3-selected');
      row.selectedOnScreen = selected;
      // LO の中の「貼り付け」ボタン(空のとき灰色)の領域を、腕の手の**前**に採る(選んだ腕すべて)
      pasteBtnBefore = await framesOf(pasteBtnClip, 3);
      if (selected === true) {
        await page.keyboard.press('Control+c');
        row.copyKey = 'Control+c';
      }
    } else if (arm === 'B3') {
      const a = await framesOf(clip);
      await page.keyboard.press('Shift+ArrowRight');
      await page.waitForTimeout(1000);
      selected = swapped(a, await framesOf(clip));
      await shot('3-selected');
      row.selectedOnScreen = selected;
      // LO の中の「貼り付け」ボタン(空のとき灰色)の領域を、腕の手の**前**に採る(選んだ腕すべて)
      pasteBtnBefore = await framesOf(pasteBtnClip, 3);
      if (selected === true) {
        await page.keyboard.press('Control+c');
        row.copyKey = 'Control+c';
      }
    } else if (arm === 'B3c') {
      const a = await framesOf(clip);
      const x = box.x + box.w * 0.3;
      const y = box.y + box.h * 0.4;
      row.pressed = { x: Math.round(x), y: Math.round(y), button: 'left' };
      await page.mouse.click(x, y);
      await page.waitForTimeout(1500);
      selected = swapped(a, await framesOf(clip));
      await shot('3-selected');
      row.selectedOnScreen = selected;
      // LO の中の「貼り付け」ボタン(空のとき灰色)の領域を、腕の手の**前**に採る(選んだ腕すべて)
      pasteBtnBefore = await framesOf(pasteBtnClip, 3);
      if (selected === true) {
        await page.keyboard.press('Control+c');
        row.copyKey = 'Control+c';
      }
    } else if (arm === 'B4') {
      const a = await framesOf(clip);
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(600);
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(1000);
      selected = swapped(a, await framesOf(clip));
      await shot('3-selected');
      row.selectedOnScreen = selected;
      // LO の中の「貼り付け」ボタン(空のとき灰色)の領域を、腕の手の**前**に採る(選んだ腕すべて)
      pasteBtnBefore = await framesOf(pasteBtnClip, 3);
      if (selected === true) {
        await page.keyboard.press('Control+c');
        row.copyKey = 'Control+c';
      }
    } else if (['B5', 'B6', 'B7', 'B8'].includes(arm)) {
      // 4 腕とも「字を全部選ぶ」までは B1 と同じ(押さない・キーだけ)。違うのは**コピーの出し方**だけ。
      const a = await framesOf(clip);
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(1000);
      selected = swapped(a, await framesOf(clip));
      row.selectedOnScreen = selected;
      // LO の中の「貼り付け」ボタン(空のとき灰色)の領域を、腕の手の**前**に採る(選んだ腕すべて)
      pasteBtnBefore = await framesOf(pasteBtnClip, 3);
      await shot('3-selected');
      if (selected === true) {
        if (arm === 'B5') {
          // ツールバーの「コピー」ボタン。押す前にボタン領域の画素を採り、押した後(ポインタが乗ったまま)と比べる
          const x = box.x + box.w * TB_COPY_X;
          const y = box.y + box.h * TB_COPY_Y;
          row.pressed = { x: Math.round(x), y: Math.round(y), button: 'left', ratio: { x: TB_COPY_X, y: TB_COPY_Y } };
          const copyBtnClip = { x: Math.round(x - 14), y: Math.round(y - 14), width: 28, height: 28 };
          const bBefore = await framesOf(copyBtnClip, 3);
          await page.mouse.move(x, y);
          await page.waitForTimeout(600);
          await shot('3b-hover');
          await page.mouse.click(x, y);
          await page.waitForTimeout(1500);
          row.copyBtnChanged = swapped(bBefore, await framesOf(copyBtnClip, 3));
          row.copyKey = 'toolbar:click';
        } else if (arm === 'B6') {
          // メニューバー 編集(E)(`Alt+e`)→ 近道キー `y`(`コピー(Y)`。`切り取り(C)` と取り違えない ── SKILL §14)
          const before = await page.evaluate(COUNT_QT_WINDOWS);
          let opened = before;
          let tries = 0;
          for (let t = 0; t < 3; t += 1) {
            await page.keyboard.press('Alt+e');
            await page.waitForTimeout(2500);
            tries = t + 1;
            opened = await page.evaluate(COUNT_QT_WINDOWS);
            if (opened > before) break;
          }
          row.menu = { before, opened, tries };
          row.menuOpened = opened > before;
          await shot('4-menu');
          // 🔴 開いていない回に `y` を押さない(字が本文に入って選択を潰す。open-doc-probe の実測)
          if (row.menuOpened) {
            await page.keyboard.press('y');
            row.copyKey = 'menu:Alt+e,y';
            await page.waitForTimeout(1000);
            row.menuWindowsAfterClick = await page.evaluate(COUNT_QT_WINDOWS);
          }
        } else if (arm === 'B7') {
          await page.keyboard.press('Control+Insert');
          row.copyKey = 'Control+Insert';
        } else {
          row.copyKey = null; // B8 = 何もしない(陰性対照)
          await page.waitForTimeout(1500);
        }
      }
    } else if (arm === 'C2') {
      const menuOpen = await ctxClick();
      row.menuOpened = menuOpen;
      if (menuOpen) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1500);
      }
    } else if (arm === 'B2' || arm === 'B2k' || arm === 'B2w') {
      const a = await framesOf(clip);
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(1000);
      selected = swapped(a, await framesOf(clip));
      row.selectedOnScreen = selected;
      // LO の中の「貼り付け」ボタン(空のとき灰色)の領域を、腕の手の**前**に採る(選んだ腕すべて)
      pasteBtnBefore = await framesOf(pasteBtnClip, 3);
      await shot('3-selected');
      if (selected === true) {
        const menuOpen = await ctxClick();
        row.menuOpened = menuOpen;
        if (menuOpen) {
          if (arm === 'B2k') {
            // 近道キーは日本語 UI の綴り(`コピー(Y)`。`切り取り(C)` と取り違えない)
            row.copyKey = 'menu:y';
            await page.keyboard.press('y');
            await page.waitForTimeout(1000);
            row.menuWindowsAfterClick = await page.evaluate(COUNT_QT_WINDOWS);
          } else {
            // 開いた窓(canvas ではない qt-window)の上端から 40px 下 = 「コピー」の行(版面で確認した値)
            const m = row.menu.rects.filter((r) => !(r.w === Math.round(box.w) && r.h === Math.round(box.h))).pop();
            const cx = m.x + 60;
            const cy = m.y + 40;
            row.copyClick = { x: cx, y: cy, menu: m };
            row.copyKey = 'menu:click';
            await page.mouse.click(cx, cy);
            await page.waitForTimeout(1000);
            row.menuWindowsAfterClick = await page.evaluate(COUNT_QT_WINDOWS);
            if (arm === 'B2w') {
              // 🔑 #1344 の判別用: popup を選んだ後の user event の停止が「次の Qt 入力」で動くか。
              //    2 秒待ってから、**canvas の中**(右下寄り。本文の字には当たらない所)へ 1 回動かす。押さない。
              //    ⚠ 外(canvas の外の余白)に打つと Qt の event が立たない ── 外へ打った 1 稿目は対照にならなかった
              //    (「次の Qt 入力」で止まりが動くかを見たいので、Qt に届く場所でなければならない)。
              await page.waitForTimeout(2000);
              const nx = Math.round(box.x + box.w * NUDGE_X);
              const ny = Math.round(box.y + box.h * NUDGE_Y);
              row.nudge = { x: nx, y: ny, afterClickMs: 3000, insideCanvas: nx > box.x && nx < box.x + box.w && ny > box.y && ny < box.y + box.h };
              await page.mouse.move(nx, ny);
            }
          }
        }
      }
    } else if (arm === 'B2f') {
      // 🔴 #1344 の競合を狙う腕(2026-10-05): Ctrl+A の直後(FAST_MS)に右クリック。status update の burst の最中、
      //    main loop が `ProcessEvent` の promise_await で止まっている窓へ DOM event を入れる。
      //    ⚠ 選択の印は測れない(メニューが版面を覆う前に frames を比べる時間が無い)── メニューが開いた = 右クリックが
      //    届いた、とし、選択の有無は copy の結果(CLIPTEXT が外へ出るか)で見る。
      pasteBtnBefore = await framesOf(pasteBtnClip, 3);
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(FAST_MS);
      row.fastMs = FAST_MS;
      const menuOpen = await ctxClick();
      row.menuOpened = menuOpen;
      selected = menuOpen ? true : null;
      if (menuOpen) {
        const m = row.menu.rects.filter((r) => !(r.w === Math.round(box.w) && r.h === Math.round(box.h))).pop();
        const cx = m.x + 60;
        const cy = m.y + 40;
        row.copyClick = { x: cx, y: cy, menu: m };
        row.copyKey = 'menu:click';
        await page.mouse.click(cx, cy);
        await page.waitForTimeout(1000);
        row.menuWindowsAfterClick = await page.evaluate(COUNT_QT_WINDOWS);
      }
    }
    await page.waitForTimeout(3000);
    await shot('5-after');
    if (pasteBtnBefore !== null) {
      const pasteBtnAfter = await framesOf(pasteBtnClip, 3);
      row.pasteBtn = { changed: swapped(pasteBtnBefore, pasteBtnAfter), clip: pasteBtnClip };
    }

    // ⑤ コピーの後の外
    step('外を読む');
    const faultBeforeCopy = row.faults.length > 0;
    if (!(await alive())) {
      undecidable('版面が固まった(コピーの後)');
    }
    const after = await readOutside();
    row.after = { text: after.text ?? null, types: after.types ?? null, focus: after.focus ?? null, errs: [after.textErr, after.readErr, after.hung, after.err].filter(Boolean) };
    row.emptied = after.text === '' ? true : after.text === undefined ? null : false;
    row.faultsAtRead = row.faults.length;
    /**
     * 🔑 **別の頁からも読む**(同じ origin の空の頁を前面に出して `readText()`)。
     * ⚠ 「外」は host の頁(書いた側)とは限らない ── PKC 本体のタブは別の頁である。
     *   書いた頁と読む頁が同じだと、頁の中の状態で満たされうるので、**読む頁を変えた値**も採る。
     */
    try {
      const other = await ctx.newPage();
      await other.goto(`${base}/__reader.html`, { waitUntil: 'domcontentloaded' });
      await other.bringToFront();
      const o = await readOutside(other);
      row.afterOtherPage = { text: o.text ?? null, types: o.types ?? null, focus: o.focus ?? null, errs: [o.textErr, o.readErr, o.hung, o.err].filter(Boolean) };
      await other.close();
      await page.bringToFront();
    } catch (e) {
      row.afterOtherPage = { err: safeErr(e) };
    }
    const clipLog = await page.evaluate('globalThis.__clip');
    // host の窓の下の行(`setStatus` の出し先)。コピーが外へ届かなかったとき user に見える唯一の面(#121)
    row.hostStatus = await page.evaluate("(document.getElementById('status') || {}).textContent ?? null");
    row.hostWrites = {
      bc: clipLog.bc,
      calls: clipLog.writes.slice(row.hostWritesBefore),
      callsTotal: clipLog.writes.length,
    };

    // ⑤' 参考の観測 ── LO の**中**へ貼ってみる(コピーが LO の中で効いたかの傍証。外の判定とは別)。
    //    ⚠ 外を読み終えた後にやる(貼る操作が外の値を変えるので)。選んだ腕だけ。
    if (selected === true) {
      step('LO の中へ貼る');
      const g0 = await framesOf(clip);
      const bcBefore = (await page.evaluate('globalThis.__clip.bc.length'));
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(500);
      await page.keyboard.press('Control+End');
      await page.waitForTimeout(500);
      const g1 = await framesOf(clip);
      await page.keyboard.press('Control+v');
      await page.waitForTimeout(2500);
      const g2 = await framesOf(clip);
      const bcAfter = await page.evaluate('globalThis.__clip.bc.slice(' + bcBefore + ')');
      row.loPaste = { changed: swapped(g1, g2), bcDuringPaste: bcAfter.map((m) => ({ clip: m.clip, kind: m.kind })) };
      void g0;
      await shot('6-lopaste');
    }

    // ⑥ 判定不能の規則(⑥ コピーの前の fault / ④ 選択が出ない / ⑤ メニューが開かない)
    if (faultBeforeCopy) undecidable('コピーの前後で memory access out of bounds が出た(修飾キーの経路が死ぬ。SKILL §14)');
    if (['B1', 'B3', 'B3c', 'B4', 'B2', 'B2k', 'B2w', 'B5', 'B6', 'B7', 'B8'].includes(arm) && selected !== true) undecidable('選択が版面に出なかった');
    if (['B2', 'B2k', 'B2w', 'B2f', 'C2'].includes(arm) && row.menuOpened !== true) undecidable('右クリックのメニューが開かなかった(窓の数が増えない)');
    if (arm === 'B6' && row.menuOpened !== true) undecidable('メニューバーの編集(Alt+e)を 3 回押してもメニューが開かなかった(窓の数が増えない。y は押していない)');
    // ⑧ B5: ポインタを乗せる前後でコピーボタンの領域が 1 ビットも変わらない = そこにボタンが無い(当たったか不明)。判定不能とは別に数える
    if (arm === 'B5' && row.copyBtnChanged !== true) row.landUnknown = true;
    return row;
  } catch (e) {
    row.error = safeErr(e);
    undecidable(`例外(${lastStep()}): ${row.error}`);
    return row;
  } finally {
    await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
    current = null;
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

try {
  wd.mark('ラウンド');
  for (const arm of ARMS) {
    // 判定不能の回は数に入れないので、判定できた回が ROUNDS になるまで回し足す(上限は +2 回)
    let valid = 0;
    for (let n = N_START; valid < ROUNDS && n < N_START + ROUNDS + 2; n += 1) {
      wd.mark(`${arm}-${n}`);
      // 回の締切(固まった evaluate は例外を投げないので、外から競走させる)
      // 🔴 **締切の timer は回が終わったら必ず止める** ── 止めないと 240 秒後に**次の回の browser を
      //    閉じる**(1 稿目で踏んだ: C2 以降の 18 回が `Target page … has been closed` になった)
      let deadline = null;
      const r = await Promise.race([
        oneRound(arm, n),
        new Promise((res) => {
          deadline = setTimeout(() => {
            if (current) current.close().catch(() => {});
            res({ arm, n, undecidable: `回の締切(${ROUND_SEC} 秒)を超えた`, timedOut: true });
          }, ROUND_SEC * 1000);
        }),
      ]);
      clearTimeout(deadline);
      r.verdict = r.undecidable
        ? `判定不能(${r.undecidable})`
        : r.emptied === true
          ? '外が空になった'
          : r.emptied === false
            ? `外は空ではない(text=${JSON.stringify(r.after?.text)})`
            : '読めなかった';
      if (!r.undecidable) valid += 1;
      result.rounds.push(r);
      await flush();
      process.stderr.write(`${arm}-${n}: ${r.verdict}\n`);
    }
  }
  /** 腕 × 回の表。判定不能は数に入れない。 */
  result.table = ARMS.map((arm) => {
    const rs = result.rounds.filter((r) => r.arm === arm);
    const valid = rs.filter((r) => !r.undecidable);
    return {
      arm,
      rounds: rs.length,
      valid: valid.length,
      undecidable: rs.length - valid.length,
      emptied: valid.filter((r) => r.emptied === true).length,
      keptSeed: valid.filter((r) => r.emptied === false && r.after?.text === r.seed).length,
      replacedByLo: valid.filter((r) => r.emptied === false && r.after?.text !== r.seed).length,
      otherPageEmptied: valid.filter((r) => r.afterOtherPage?.text === '').length,
      // 🔑 #121 の列: host への write 依頼(`navigator.clipboard.write` / `writeText` を host が呼んだ回数が 1 以上の回)
      hostWriteRounds: valid.filter((r) => (r.hostWrites?.calls?.length ?? 0) > 0).length,
      // LO の中のクリップボードに入ったか(2 本の観測。B8 = 陰性対照で変わらないことを先に見る)
      loPasteChanged: valid.filter((r) => r.loPaste?.changed === true).length,
      pasteBtnChanged: valid.filter((r) => r.pasteBtn?.changed === true).length,
      landUnknown: valid.filter((r) => r.landUnknown === true).length,
      faultRounds: valid.filter((r) => r.faults.length > 0).length,
    };
  });
} catch (e) {
  result.error = safeErr(e);
} finally {
  wd.disarm();
  await flush();
  if (!OUT) console.log(JSON.stringify(result, null, 1));
  server.close();
  process.exit(0);
}
