/**
 * **PKC から Office へ文書を渡して「開けるか」を測る** probe(#199 / #156)。
 *
 * `host.html?await-doc=1` の実経路(BroadcastChannel `pkc3-office` で bytes を渡す)を
 * そのまま踏み、次の 3 つだけを見る:
 *   ① host の放送(ready-for-document / painted)
 *   ② **開けたか** ── Qt の器の中の題名に「渡した名前」と `LibreOffice` が**両方**出たか
 *   ③ メインスレッドの応答(`evaluate` が返るか = 「固まる」そのもの)
 *
 * ⚠ **`painted` を「開けた」と読まない** ── canvas が 1 枚出ただけで、Start Center でも出る。
 * ⚠ **題名を document 全体から拾わない** ── host 自身が上の帯に file 名を出しているので、
 *   拾うと LO が 1 画素も描く前に「開けた」と言う(2026-08-15 に実際に踏んだ)。
 * ⚠ `document.title` は**この面では動かない**(常に host の題名)── 観測点として死んでいる。
 * ⚠ `locked`(LO の `.~lock` file)も**死んだ観測点**(2026-08-15 実測)── 開けた文書でも
 *   出ないので、これで「開いた」を判定してはいけない。生きているのは**窓の題名**だけである。
 * 🔴 **`Module` の未 export のシンボルを読むと LO が死ぬ。** emscripten は未 export の名前に
 *   `abort()` する getter を仕込むので、`lo.PThread` を**読んだ瞬間**に
 *   `Aborted('PThread' was not exported…)` → `RuntimeError: unreachable` で runtime ごと落ちる
 *   (調査で実際に踏み、5 秒ごとの観測が 5 秒ごとに対象を殺していた)。
 *   ⚠ 触ってよいのは `FS` / `HEAPU8` / `calledRun`。**素性の分からない名前は
 *   `Object.getOwnPropertyDescriptor` で見る**(getter を発火させない)。
 *
 * 使い方:
 *   node build/office-wasm/open-doc-probe.mjs <pack ディレクトリ> <文書|none> [出力.json] [秒]
 *   PKC3_SHOT=/path/shot.png  を付けると最後に 1 枚撮る
 *
 * 門(⚠ **既定では何もしない**。付けた回だけ走る):
 *   PKC3_REDRAW=1        打鍵が版面に出るか + 保存した中身に入るか(#154)
 *     PKC3_REDRAW_ENTRY=click|dblclick|tab   PKC3_REDRAW_X / _Y  押す比
 *   PKC3_PASTE=1         コピーと貼り付けが効くか(#121)
 *     PKC3_PASTE_VIA=keys|menu|browser       近道キー / `編集` メニュー /
 *                                            🔴 **ブラウザのクリップボードを跨ぐ**(#121 の残り)
 *     PKC3_MENU_SHOT=/path.png               🔑 コピーの**後**の `編集` を撮る
 *                                            (`形式を選択して貼り付け` の灰色 = #121 の肝)
 *     PKC3_PRE_PASTE_SHOT=/path.png          貼る直前(選択が畳めたか)
 *   PKC3_MENU_OPEN=<キー> メニューを 1 つ開いて撮るだけ(例 `Alt+i`)
 *     PKC3_MENU_ITEM=<キー>                  項目まで選ぶ(⚠ **日本語 UI の近道キー**)
 *     PKC3_MENU_SHOT=/path.png
 *
 * 🔴 **`Alt+キー` でメニューを開くと、この一式は 4 割の回で落ちる**(2026-08-28 実測)。
 *   `memory access out of bounds` が出て LO が止まり、**メニューは開かない**。
 *
 *   | 開き方 | 実測 |
 *   |---|---|
 *   | `Alt+キー`(この門) | 🔴 **17 回中 7 件(41%)が fault** |
 *   | **クリック**(`dialog-crash-probe.mjs`) | ✅ **12 回開いて 0 件** |
 *
 *   ⚠ もし本当に 41% なら 12 回無事な確率は 0.2% なので、**この差は本物**である。
 *   🔑 **落ちた回は「メニューが開かない」と見分けがつかない**(相関 17/17)──
 *   だから `before` / `opened` を必ず読み、**開かなかった回の絵を「効かなかった」と
 *   読まない**こと(#146 の撮影で実際に 3 回中 1 回踏んだ)。
 *   🔑 **user はメニューをクリックで開く**ので、これは user が踏む道ではない ──
 *   ⚠ **「26.8 の不具合」として報告しない**(経路が違う)。
 *   🔑 落ちて困るなら**クリックで開く**(座標は `dialog-crash-probe.mjs` の `SUITES`)。
 *   PKC3_IME=1 / PKC3_STACKS=1 / PKC3_POKE / PKC3_PTHREAD / PKC3_DIST
 *
 * ⚠ **近道キーは日本語 UI の綴りで指定する** ── `コピー(Y)` / `貼り付け(P)` /
 *   `画像(I)` のように、英語の頭文字とは違う。英語のつもりで書くと**別の項目を叩いて**
 *   「効かなかった」に見える。
 *
 * ⚠ `dist/` を配るので **先に `npm run build`** すること。
 */

import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { armWatchdog } from './probe-watchdog.mjs';
import { join, extname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const PACK = resolve(process.argv[2]);
const DOC = process.argv[3] === 'none' ? '' : resolve(process.argv[3]);
const OUT = process.argv[4] ?? '';
const LIMIT_SEC = Number(process.argv[5] ?? 180);
const DIST = resolve(process.env.PKC3_DIST ?? 'dist');
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
      const f = p.startsWith('/office-pack/')
        ? join(PACK, p.slice('/office-pack/'.length))
        : join(DIST, p);
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
const safeLine = (s) => (/[^\x20-\x7e]/.test(s) ? null : s.slice(0, 140));
/**
 * 🔴 **例外は「行ごと」に濾す**(2026-08-24)。
 *
 * ⚠ 直す前は `safeLine(String(e))` を 1 回掛けていたので、**例外の文言に
 *   非 ASCII が 1 文字でも混ざると全部捨てて `'error'` だけが残った** ──
 *   自分のハーネスの誤りを、自分で直せない形である(実際 1 回転溶かした)。
 * 🔑 規律(**非 ASCII の行は丸ごと捨てる**)はそのままに、**行単位**で当てる ──
 *   Playwright の例外は 1 行目が ASCII の要約で、本文が混じるのは call log の側である。
 */
const safeErr = (e) => {
  for (const line of String(e).split('\n')) {
    const t = safeLine(line.trim());
    if (t !== null && t !== '') return t;
  }
  return 'error';
};

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
// `none` = 文書を渡さない(Start Center)。⚠ 対照群 ── 「起動そのもの」と
// 「文書を渡した起動」のどちらが壊れているかは、これが無いと分けられない。
const NO_DOC = process.argv[3] === 'none';
const b64 = NO_DOC ? '' : (await readFile(DOC)).toString('base64');
// ⚠ 名前は**実ファイルのもの**を渡す ── 1 巡目は全部 `doc.docx` 固定で渡しており、
//   平文の対照群まで docx として読ませていた(対照群が対照群になっていなかった)。
const NAME = NO_DOC ? '' : basename(DOC);
const SHOT = process.env.PKC3_SHOT ?? '';
/** 🔴 開いた状態で IME の門を読むか(#156 段②)。⚠ 既定は読まない。 */
const IME = process.env.PKC3_IME === '1';
/**
 * 🔴 **焦点を 1 度動かして、診断属性を採り直させる**(#156、2026-08-29)。
 *
 * ⚠ `data-pkc-ime` は `QWasmInputContext::updateInputElement()` の中でしか
 * 書かれず、そこを `update()` から呼ぶ hunk は 2026-08-16 に外してある
 * (文書を開くと固まる退行の原因だった)。だから素で読むと
 * **「最後に `updateInputElement()` が走った時点の値」**しか返らない ──
 * `accept0` は「いまも偽」ではなく **判定不能**である(CLAUDE.md §4「計器が古い値を返す」)。
 *
 * 🔑 ところが `updateInputElement()` は **`setFocusObject()` からも呼ばれる**
 * (`qtbase-patch-ime-panel.py` が外した hunk の直上にそう書いてある)。
 * つまり**焦点を 1 度動かせば採り直される** ── Qt を焼き直さずに新しい値が読める。
 *
 * ## 🔴 対照群を必ず置く ── 検索バー
 *
 * ⚠ 「焦点を動かしたのに `accept0` のまま」は 2 通りに読めてしまう:
 *   (a) 受付可否が本当に偽 / (b) **この採り直しの経路ごと死んでいる**。
 * 🔑 `Ctrl+F` の検索バーは**本物の入力欄**なので、そこで `accept1` にならなければ
 * (b) である ── つまり**この計器では何も言えない**と分かる(それも読める信号である)。
 *
 * ⚠ **検索バーが実際に開いたことを版面の絵で確かめる**(開かなかった回の値を読まない)。
 *
 * ## 🔴 実測(2026-08-29)── **(b) だった。この門はもう回さなくてよい**
 *
 * 一式 `lo-63426ccd1d7c-run33196326615`(直し `patch-lo-ime-update.py` 入り)、
 * 文書が開き(`docOpen` / `loTitle`)、`landed: true` / `caretInBody: true` の回:
 *
 * | 段 | `data-pkc-ime` |
 * |---|---|
 * | キャレットが本文に在る | `obj1-win1-panel1-accept0` |
 * | **検索バーを開いた**(`findOpened: true`) | 🔴 `accept0` |
 * | 本文へ戻した | `accept0` |
 *
 * 🔑 **対照群が答えを出した** ── 検索バーは本物の入力欄なのに `accept0` のまま。
 * つまり **(b) 採り直しの経路ごと死んでいる**。
 * ⚠ 読みは「LO wasm は**全部を 1 枚の Qt ウィジェットに描く**ので、文書内で焦点が
 * 動いても Qt の焦点オブジェクトは変わらず、`setFocusObject()` が発火しない」──
 * 実際 `obj1-win1-panel1` は起動から最後まで**4 回とも 1 バイト違わなかった**。
 * ⚠ **これは推測である**(1 枚のウィジェットであることを直に観測してはいない)が、
 * どちらに転んでも結論は同じ:**この計器では受付可否を読めない**。
 *
 * 🔑 残る道は `patch-lo-ime-update.py` の docstring が挙げている
 * 「`QWasmInputContext::update()` の中で値と**呼ばれた回数**を素の C++ 変数に書き、
 * `EMSCRIPTEN_KEEPALIVE` で JS から読む」計器だけ ── ⚠ **qtbase の patch なので
 * Qt を host + wasm から焼き直す(数時間)**。しかもそれが答えるのは
 * 「門が開いたか」までで、**実 IME で候補窓が出るか**は実機でしか分からない
 * (#438 の Q3 がその依頼である)。
 */
const IME_REFOCUS = process.env.PKC3_IME_REFOCUS === '1';
/**
 * 🔴 **スレッドの内訳を読む**(#199 の「次の一手 ①」)。⚠ **既定では何もしない。**
 * ⚠ `PKC3_IME` とは別の口である ── あちらは版面を押して打つので、
 *   「詰まっている最中」を見たいこちらと**混ぜてはいけない**。
 */
const PTHREAD = process.env.PKC3_PTHREAD === '1';
/**
 * 🔴 **全 worker の stack を 1 枚撮る**(#199 の「次の一手 ②」)。⚠ 既定では何もしない。
 * ⚠ `PKC3_PTHREAD` の内訳が**死んだ観測点**だったので足した(下の実装を参照)。
 */
const STACKS = process.env.PKC3_STACKS === '1';
/**
 * 🔴 **打鍵が「その場で版面に出るか」を測るか**(#154 段①)。⚠ 既定は測らない。
 *
 * 実機レポート #7(2/2): Impress は**打っている間、画面が更新されない** ──
 * `Escape` を押してメニューを開いた瞬間に、打った字がいっぺんに現れる。
 * ⚠ issue が「Impress 固有」と書いた自信度は **60%**(同一の腕で Writer と
 * 比べていない)ので、まず**対照群を揃える**のがこの門の仕事である。
 * ⚠ `PKC3_IME` とは**同時に使わない**(どちらも版面を押して打つので混ざる)。
 */
const REDRAW = process.env.PKC3_REDRAW === '1';
const PASTE = process.env.PKC3_PASTE === '1';
/** ⚠ `qt-window` は shadow root の中にも生えるので、**潜って**数える。 */
const COUNT_QT_WINDOWS = () => {
  let n = 0;
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.classList && el.classList.contains('qt-window')) n += 1;
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return n;
};

/**
 * 🔴 **打った字が「保存した中身」に入っているか**(#154 の次の一手 ①、2026-08-25)。
 *
 * ⚠ 版面の絵が変わったかは「**打った字が出た**」ではない ── 選択の色でも
 * モードの変化でも変わる。だから**保存して中身を見る**:
 *
 * | 結果 | 読み方 |
 * |---|---|
 * | 入っている | **入力は LO に届いている** ── 残るのは描画の話 |
 * | 入っていない | **そもそも届いていない** ── 描画ではなく入力の話 |
 *
 * 🔴 **中身は 1 バイトも外へ出さない**(機密資料の取り扱い 3)。
 * 返すのは「**こちらが打った字が在るか**」の真偽と、読めた大きさだけである ──
 * だから user の資料に対して回しても、中身を持ち出さない。
 *
 * ⚠ ODF は zip なので、`content.xml` を**箱の中で伸長してから**探す
 * (deflate されるので生バイト検索では当たらない)。
 * ⚠ 探すのは**空白を落とした形**でも見る ── ODF は書いた字を
 * `<text:s/>` などで割ることがあるので、素の一致だけだと取りこぼす。
 */
/**
 * 🔴 **保存が済んだかを、固定の待ちではなく `mtime` で見る**(2026-08-30)。
 *
 * ⚠ 直す前は `Ctrl+S` のあと **6 秒固定**で読んでいたが、それでは**早すぎる回がある** ──
 * 同じ一式を `save-existing-probe.mjs` で測ると、**12 秒後**には
 * `size 8814 → 9782` / `mtime` も動いていた(2026-08-30 実測)。
 * 🔴 早く読むと「打った字が保存に入っていない」= **対照群が届いていない**と出て、
 * その回の判定が丸ごと無意味になる(#121 で実際にそう読みかけた)。
 */
const WORK_STAT = `(() => {
  const lo = window.__lo;
  if (!lo || !lo.FS) return null;
  let name = null;
  try {
    for (const n of lo.FS.readdir('/work')) {
      if (n === '.' || n === '..') continue;
      name = n;
    }
  } catch (e) { return null; }
  if (name === null) return null;
  try {
    const st = lo.FS.stat('/work/' + name);
    return { name: name, size: st.size, mtimeMs: +st.mtime };
  } catch (e) { return null; }
})()`;

const TYPED_IN_SAVED = (needle) => `(async () => {
  const lo = window.__lo;
  if (!lo || !lo.FS) return { err: 'no FS' };
  let name = null;
  try {
    for (const n of lo.FS.readdir('/work')) {
      if (n === '.' || n === '..') continue;
      name = n;
    }
  } catch (e) { return { err: String(e).slice(0, 80) }; }
  if (name === null) return { err: 'empty /work' };
  let bytes;
  try { bytes = lo.FS.readFile('/work/' + name); }
  catch (e) { return { err: String(e).slice(0, 80) }; }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // EOCD を末尾から探す(コメント無しなら末尾 22 バイト)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { err: 'no eocd', size: bytes.length };
  let off = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  let hit = null;
  for (let k = 0; k < count; k += 1) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const nm = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nlen));
    if (nm === 'content.xml') hit = { method: method, csize: csize, lho: lho };
    off += 46 + nlen + elen + clen;
  }
  if (hit === null) return { err: 'no content.xml', size: bytes.length };
  const lnlen = dv.getUint16(hit.lho + 26, true);
  const lelen = dv.getUint16(hit.lho + 28, true);
  const start = hit.lho + 30 + lnlen + lelen;
  const raw = bytes.subarray(start, start + hit.csize);
  let xml;
  try {
    if (hit.method === 0) {
      xml = new TextDecoder().decode(raw);
    } else {
      const ds = new DecompressionStream('deflate-raw');
      const buf = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
      xml = new TextDecoder().decode(new Uint8Array(buf));
    }
  } catch (e) { return { err: 'inflate: ' + String(e).slice(0, 60), size: bytes.length }; }
  const needle = ${JSON.stringify(needle)};
  const bare = needle.split(' ').join('');
  const stripped = xml.split(' ').join('');
  // 🔑 **件数も返す**(#121 の貼り付け ── 「在るか」では 1 回と 2 回が割れない)。
  //    ⚠ 空白を落とした形のほうが多く当たることがあるので、多いほうを採る。
  const tally = (hay, pin) => {
    if (pin.length === 0) return 0;
    let n = 0;
    for (let i = hay.indexOf(pin); i >= 0; i = hay.indexOf(pin, i + pin.length)) n += 1;
    return n;
  };
  const n1 = tally(xml, needle);
  const n2 = tally(stripped, bare);
  return {
    size: bytes.length,
    xmlChars: xml.length,
    // 🔑 返すのは真偽と件数だけ ── 中身は出さない
    found: n1 > 0 || n2 > 0,
    count: n1 > n2 ? n1 : n2,
  };
})()`;
/**
 * 編集可能要素と、パッチが書く診断(`obj1-win1-panel1-accept0` の形)。
 * ⚠ 読み方は `ime-probe.mjs` と**同じ 1 つ**にする(2 か所で別々に決めない)。
 * ⚠ ここは template literal なので**逆引用符を書かない**。
 */
const IME_DEEP = `(() => {
  const inputs = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      const t = el.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || el.isContentEditable) {
        const r = el.getBoundingClientRect();
        inputs.push({ tag: t, id: el.id || null, w: Math.round(r.width), h: Math.round(r.height),
          focused: el === document.activeElement,
          inputmode: el.getAttribute('inputmode'),
          ime: el.getAttribute('data-pkc-ime') });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const ae = document.activeElement;
  return { inputs, active: ae ? (ae.tagName + (ae.id ? '#' + ae.id : '')) : null };
})()`;
/**
 * 🔴 **計装の出口を MEMFS から読む**(#156 段③、`patch-lo-ime-trace.py` と対)。
 *
 * ⚠ LO 側の文脈から DOM を触れないので、計装は **libc だけ**で
 *   `/tmp/pkc3-ime.log` へ追記している ── ここはその file を読むだけ。
 * 🔑 返り値で 3 つを見分ける:
 *     `null`   = 計装の入っていない一式(= この焼きでは測っていない)
 *     `[]`     = 計装は在るが **1 行も出ていない**(呼ばれていない)
 *     `[...]`  = 出た行
 * ⚠ ここは template literal なので**逆引用符を書かない**。
 */
const IME_TRACE = `(() => {
  try {
    const lo = globalThis.__lo;
    if (!lo || !lo.FS) return null;
    const raw = lo.FS.readFile('/tmp/pkc3-ime.log', { encoding: 'utf8' });
    // ⚠ **ここで '\\n' と書いてはいけない** ── この原文は template literal の中に
    //   在るので、escape は**組み立てる側で解決されて実改行になる**
    //   (= 開いた ' が閉じないまま改行 = SyntaxError)。2026-08-24 に踏んだ。
    return String(raw).split(String.fromCharCode(10)).filter((l) => l.length > 0);
  } catch (e) {
    // ⚠ **大文字小文字を潰してから見る**(2026-08-24 に踏んだ)── 実際に飛ぶのは
    //    ErrnoError: No such file or directory で、小文字の 'no such file' とは一致しない。
    //    🔑 ここを外すと「計装が入っていない(null)」が「読もうとして落ちた(ERR)」に化け、
    //    **対照群の意味が逆に読める**(実際 #199 の対照群で 1 度読み違えた)。
    //    ⚠⚠ この注釈に**逆引用符を書かない** ── ここは template literal の中である。
    const msg = String(e).toLowerCase();
    return msg.indexOf('enoent') >= 0 || msg.indexOf('no such file') >= 0
      ? null
      : ['ERR ' + String(e).slice(0, 80)];
  }
})()`;
/**
 * 版面(いちばん大きい canvas)の位置。⚠ Qt 6 の canvas は **shadow root の中**なので
 * 潜って拾う(`host.html` が「1 日溶かした罠」と書いている当のもの)。
 * ⚠ **2 つの門で同じものを使う** ── 別々に書くと、片方だけ直す事故が起きる。
 * ⚠ ここは template literal なので**逆引用符も escape も書かない**(下の検査を参照)。
 */
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
/**
 * 🔴 **詰まっている最中のスレッドの内訳**(#199 の「次の一手 ①」、2026-08-24)。
 *
 * ⚠ **`PKC3_PTHREAD=1` を渡した回だけ読む** ── 既定の使い方を変えない。
 * 🔴 **未 export の名前は「読んだ瞬間に abort する getter」である**(この file の頭)。
 *   だから値を取る前に **`getOwnPropertyDescriptor` で見る** ── 記述子を見るのは
 *   getter を発火させない。⚠ `lo.PThread` と素で書いた瞬間、計装の入っていない
 *   一式では **LO ごと死ぬ**(調査で実際に踏み、5 秒ごとの観測が 5 秒ごとに対象を殺した)。
 * ⚠ 触るのは **`runningWorkers` / `unusedWorkers` の列挙だけ**
 *   (`patch-lo-memory.py` が出しているのはそこまで)。
 * 🔑 返り値で 3 つを見分ける:
 *     `null`   = この一式は `PThread` を出していない(= 測っていない)
 *     `{...}`  = 読めた
 *     `{err}`  = 読もうとして落ちた(**空と混ぜない**)
 */
const PTHREADS = `(() => {
  try {
    const lo = globalThis.__lo;
    if (!lo) return null;
    const d = Object.getOwnPropertyDescriptor(lo, 'PThread');
    // ⚠ 記述子が getter なら**触らない**(発火させると abort する)
    if (!d || d.get !== undefined || d.value === undefined || d.value === null) return null;
    const P = d.value;
    const names = (v) => {
      if (!v) return null;
      const arr = Array.isArray(v) ? v : (typeof v.values === 'function' ? Array.from(v.values()) : null);
      if (arr === null) return null;
      return arr.map((w) => {
        try { return typeof w.name === 'string' && w.name.length > 0 ? w.name : '(名前なし)'; }
        catch (e) { return '(読めない)'; }
      });
    };
    const run = names(P.runningWorkers);
    const idle = names(P.unusedWorkers);
    const ed = Object.getOwnPropertyDescriptor(lo, 'ENV');
    const env = !ed || ed.get !== undefined || !ed.value ? null : {
      VCL_NO_THREAD_SCALE: ed.value.VCL_NO_THREAD_SCALE ?? null,
      VCL_NO_THREAD_IMPORT: ed.value.VCL_NO_THREAD_IMPORT ?? null,
      MAX_CONCURRENCY: ed.value.MAX_CONCURRENCY ?? null,
    };
    return {
      running: run === null ? null : run.length,
      unused: idle === null ? null : idle.length,
      runningNames: run,
      unusedNames: idle,
      env,
    };
  } catch (e) {
    return { err: String(e).slice(0, 120) };
  }
})()`;

/**
 * 🔴 **渡す原文を、走らせる前に構文として検める**(2026-08-24 に踏んだ)。
 *
 * ⚠ `IME_TRACE` は**書いた日から一度も成立していなかった** ── 原文の中に
 *   `'\n'` と書いたが、これらは template literal の中に在るので**組み立てる側で
 *   実改行に解決され**、開いた `'` が閉じないまま改行していた。
 * ⚠ 症状は「IME ブロックが 1 つのエラーで畳まれる」だけで、**どの一手で落ちたかが
 *   出ない** ── 押す・打つ・`Ctrl+A` の対照群は 1 度も走っていなかったのに、
 *   出力は「測ったが取れなかった」と見分けが付かなかった。
 * 🔑 だから**名前を付けて先に落とす** ── 原文が壊れているのか、相手の頁で
 *   取れなかったのかを、出力だけで区別できるようにする。
 */
/**
 * 🔴 **idle 錠の待ちの計装を読む**(#199。`patch-lo-idles-trace.py` が書く)。
 *
 * 🔑 3 行の意味:
 *   `idles:wait a=<IsUseSystemEventLoop> b=<IsMainThread>` ── ⚠ **前提を実測で出す**
 *   `idles:woke` ── 出なければ、そこで永久に止まっている
 *   `execute:call` ── 🔑 **対照群**。0 件の回は計装が効いていないので、その回は 1 つも読まない
 *   `execute:doexec` ── `DoExecute()` が返ってきた。⚠ **出ないこと自体が答え**(中で回り続けている)
 *   `execute:loop` / `execute:set` ── vcl 側の待ちループが回った / 条件を立てた(各先頭 5 回)
 * ⚠ **ここで '\n' と書いてはいけない**(組み立て側で実改行に解決される。2026-08-24 に踏んだ)。
 */
const IDLES_TRACE = `(() => {
  try {
    const lo = globalThis.__lo;
    if (!lo || !lo.FS) return null;
    const raw = lo.FS.readFile('/tmp/pkc3-idles.log', { encoding: 'utf8' });
    return String(raw).split(String.fromCharCode(10)).filter((l) => l.length > 0);
  } catch (e) {
    // ⚠ **大文字小文字を潰してから見る**(2026-08-24 に踏んだ)── 実際に飛ぶのは
    //    ErrnoError: No such file or directory で、小文字の 'no such file' とは一致しない。
    //    🔑 ここを外すと「計装が入っていない(null)」が「読もうとして落ちた(ERR)」に化け、
    //    **対照群の意味が逆に読める**(実際 #199 の対照群で 1 度読み違えた)。
    //    ⚠⚠ この注釈に**逆引用符を書かない** ── ここは template literal の中である。
    const msg = String(e).toLowerCase();
    return msg.indexOf('enoent') >= 0 || msg.indexOf('no such file') >= 0
      ? null
      : ['ERR ' + String(e).slice(0, 80)];
  }
})()`;

for (const [name, src] of Object.entries({ IME_DEEP, IME_TRACE, CANVAS_BOX, PTHREADS, IDLES_TRACE })) {
  try {
    new Function(`return ${src}`);
  } catch (e) {
    throw new Error(`evaluate の原文 ${name} が構文として成立していない`, { cause: e });
  }
}
const docBytes = NO_DOC ? 0 : (await readFile(DOC)).length;
const result = { doc: { bytes: docBytes }, events: [], console: [], imeConsole: [], samples: [] };
const profile = `${tmpdir()}/pkc3-open-doc-${process.pid}`;
const browser = await chromium.launchPersistentContext(profile, {
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  executablePath: '/opt/pw-browsers/chromium',
});
const page = await browser.newPage();
/**
 * 🔴 **クリップボードの許可は、跨ぐ腕のときだけ与える**(#121、2026-08-29)。
 *
 * ⚠ 常に与えると **他の腕の環境まで変わる** ── `keys` / `menu` は LO の中で閉じており、
 * 許可の有無に依らないはずなのに、「許可を与えたら通った」を後から切り分けられなくなる
 * (CLAUDE.md「1 度の実験が 2 つを主張していた」)。
 * 🔑 与えないと `writeText()` は**拒まれる**(headless の既定は prompt)ので、
 * この腕だけは与える ── ⚠ そのうえで「固まった / 拒まれた」は**判定不能**として読む。
 */
if (process.env.PKC3_PASTE_VIA === 'browser') {
  try {
    await browser.grantPermissions(['clipboard-read', 'clipboard-write']);
    result.clipboardPermission = 'granted';
  } catch (e) {
    result.clipboardPermission = safeErr(e);
  }
}
/**
 * 🔴 **console の行に「いつ出たか」を添える**(#117 / #199。2026-08-29 に穴を踏んだ)。
 *
 * ⚠ `events` は `dt` を持つのに **console は時刻なしの配列**だったので、
 * `memory access out of bounds` が出ても **起動中か / クリックか / 打鍵か**が
 * 分からなかった ── つまり「クリックで落ちる」(#117 の題)の再現かどうかを
 * **書けなかった**。CLAUDE.md §4「計器の名前が範囲より広い」の時間版である。
 *
 * 🔑 **`events` と同じ時間軸に載せる** ── 別の起点で測ると、2 つの配列を
 * 突き合わせられない(一式を IDB へ積む時間ぶんズレる)。
 * ⚠ 計測窓に入る前に出た行は `[pre]` と書く ── **0ms と区別する**
 * (「準備中に出た」も読める信号である)。
 */
let t0 = 0;
/** 行頭に付ける時刻。⚠ **ASCII だけ**(非 ASCII を捨てる `safeLine` と同じ規律)。 */
const stamp = () => (t0 === 0 ? '[pre]' : `[+${Date.now() - t0}ms]`);
page.on('console', (m) => {
  const t = safeLine(`[${m.type()}] ${m.text()}`);
  if (t === null) return;
  // 🔴 **計装の行は別の箱へ採る**(#156 段③)。⚠ 下の一般の箱は 60 行で打ち切る
  //    ので、起動時の洪水に**押し出される** ── 「出ていない」と「採らなかった」が
  //    見分けられなくなる(CLAUDE.md §4「観測点が別の物に満たされる」の器版)。
  //    🔑 本命は MEMFS の log(`result.ime.trace`)で、こちらはその控えである。
  if (t.includes('PKC3-IME') && result.imeConsole.length < 200) result.imeConsole.push(t);
  if (result.console.length < 60) result.console.push(`${stamp()}${t}`);
});
page.on('pageerror', (e) => {
  const t = safeLine(`[pageerror] ${String(e)}`);
  if (t) result.console.push(`${stamp()}${t}`);
});
page.on('crash', () => result.console.push(`${stamp()}[crash] page crashed`));

/**
 * 🔴 **全体の締切**(2026-08-30。**5 時間固まって学んだ**)。実体は
 * `probe-watchdog.mjs` に在る ── ⚠ **13 本ある probe のうち締切を持つのは
 * この 1 本だけ**だったので、写さずに寄せた。
 *
 * ⚠ `LIMIT_SEC`(第 5 引数)が縛るのは**観測ループだけ**である。その後ろの門
 * (`PKC3_PASTE` / `PKC3_REDRAW` …)は `await page.evaluate(…)` を素で呼ぶので、
 * **版面が 100% で回り続けると永久に返らない** ── Playwright の `evaluate` に
 * 既定の締切は無く、**固まった `await` は例外を投げないので `finally` も走らない**。
 */
const HARD_SEC = Number(process.env.PKC3_HARD_LIMIT_SEC ?? LIMIT_SEC + 600);
const wd = armWatchdog({ result, out: OUT, limitSec: HARD_SEC, browser: () => browser });
const mark = (name) => wd.mark(name);

/**
 * 🔑 **`Ctrl+S` を押し、`/work` の file が動くまで待つ。**
 *
 * ⚠ 返り値は待った ms(動かなければ `null`)── **「保存できなかった」ではなく
 * 「見えなかった」**として読むこと。上限は `PKC3_SAVE_WAIT_MS`(既定 30 秒)。
 */
const pressSaveAndWait = async () => {
  const before = await page.evaluate(WORK_STAT).catch(() => null);
  await page.keyboard.press('Control+s');
  const capMs = Number(process.env.PKC3_SAVE_WAIT_MS ?? 30_000);
  const t0 = Date.now();
  for (;;) {
    await page.waitForTimeout(1_500);
    const now = await page.evaluate(WORK_STAT).catch(() => null);
    if (before !== null && now !== null
        && (now.mtimeMs !== before.mtimeMs || now.size !== before.size)) {
      // ⚠ 書き終えた直後に読むと途中の姿を掴みうる ── 1 呼吸置く
      await page.waitForTimeout(1_500);
      return Date.now() - t0;
    }
    if (Date.now() - t0 > capMs) return null;
  }
};

try {
  // 一式を IDB へ(PKC が入れる形と同じ)
  await page.goto(`${base}/office/host.html`, { waitUntil: 'domcontentloaded' });
  mark('一式を IDB へ入れる');
  result.staged = await page.evaluate(async () => {
    const { fetch, indexedDB } = globalThis;
    /**
     * 🔴 **足りない file は、名前で言う**(2026-08-29 に 1 回転溶かした)。
     * ⚠ `(await fetch(...)).json()` は 404 の空 body で
     * `SyntaxError: Unexpected end of JSON input` を投げる ── その字面は
     * **何が無いのか 1 文字も言わない**ので、「probe が壊れた」と読んでしまう
     * (実際は「渡した一式に `pack.json` が無い」= 引数の取り違えだった)。
     * 🔑 計器は**落ちた理由を名前で言う**(CLAUDE.md §6「shell と CI が
     * 『失敗した』を食べる」の evaluate 版)。
     */
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
    for (const n of names) {
      const b = await (await grab(`/office-pack/${n}`)).blob();
      bytes += b.size;
      await put('files', n, b);
    }
    await put('meta', 'pack', {
      version: m.version,
      installedAt: Date.now(),
      source: 'url',
      totalBytes: bytes,
      files: names.map((n) => ({ name: n })),
    });
    return { count: names.length, version: m.version };
  });

  // 送り手を仕込む(PKC の実経路 = 放送で bytes を渡す)
  await page.addInitScript(({ doc, name }) => {
    const ch = new globalThis.BroadcastChannel('pkc3-office');
    globalThis.__probeEvents = [];
    ch.onmessage = (ev) => {
      const d = ev.data;
      if (!d || !d.pkc3Office) return;
      globalThis.__probeEvents.push({ t: Date.now(), type: d.pkc3Office });
      if (d.pkc3Office === 'ready-for-document') {
        const raw = globalThis.atob(doc);
        const u8 = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) u8[i] = raw.charCodeAt(i);
        ch.postMessage({ pkc3Office: 'document', payload: { name, bytes: u8 } });
      }
    };
  }, { doc: b64, name: NAME });

  t0 = Date.now();
  await page.goto(NO_DOC ? `${base}/office/host.html` : `${base}/office/host.html?await-doc=1&name=${encodeURIComponent(NAME)}`, { waitUntil: 'commit' });

  /**
   * 🔴 **止まった相手を「外から突いて」みる**(#199 の 4 巡目、2026-08-24)。
   *
   * 4 巡目で分かったのは「`QtInstance::DoYield` の**枝 A**(Qt スレッド自身)に入り、
   * `ImplYield()` から**戻ってこない**」ところまでである(`yield:enter a=1` は出るが
   * `yield:ret` が出ない / 対照群は 5 往復)。⚠ **戻らない理由は 2 通り**:
   *   ① 待っている event が**永久に来ない**(誰も起こさない)
   *   ② ループの中で**何かを掴んだまま**動けない(本物の deadlock)
   *
   * 🔑 **①なら、外から本物の入力を入れれば動き出す。** ②なら何をしても動かない。
   * だから `PKC3_POKE=<秒>` を渡した回だけ、その秒数のあとに
   * **実ブラウザの mouse / key を版面へ入れて**、その後も測り続ける。
   * ⚠ 既定では突かない ── 既存の測り方(放っておくとどうなるか)を汚さない。
   * ⚠ 突いた時刻を `result.poked` に残す(「突く前に開いた」と混ぜないため)。
   */
  const POKE_SEC = Number(process.env.PKC3_POKE ?? 0);
  let poked = false;

  let deadStreak = 0;
  mark('観測ループ');
  for (let i = 0; i * 5 < LIMIT_SEC; i += 1) {
    await page.waitForTimeout(5_000);
    if (POKE_SEC > 0 && !poked && (Date.now() - t0) / 1000 >= POKE_SEC) {
      poked = true;
      result.poked = { atSec: Math.round((Date.now() - t0) / 1000) };
      try {
        /**
         * 🔴 **突きが「届いた」ことを、突き自身に証明させる**(対照群の代わり)。
         *
         * ⚠ 詰まった回は版面が凍っているので、**絵が変わったか**では届いたか分からない
         * (届いても変わらない)。🔑 だから **頁の DOM が event を受け取ったか**を数える
         * ── capture 段で数えれば、Qt が食う前に通る。
         * ⚠ ここが 0 なら**突きが届いていない**ので、その回は「動かなかった」と読まない
         * (CLAUDE.md「対照群が届かない回は判定不能」)。
         */
        await page.evaluate(() => {
          const w = globalThis;
          w.__pkc3Poke = { down: 0, key: 0, move: 0 };
          w.addEventListener('mousedown', () => { w.__pkc3Poke.down += 1; }, true);
          w.addEventListener('keydown', () => { w.__pkc3Poke.key += 1; }, true);
          w.addEventListener('mousemove', () => { w.__pkc3Poke.move += 1; }, true);
        });
        await page.mouse.move(640, 400);
        await page.mouse.click(640, 400);
        await page.keyboard.press('Shift');
        await page.mouse.move(660, 420);
        await page.waitForTimeout(1000);
        result.poked.seen = await page.evaluate(() => globalThis.__pkc3Poke ?? null);
      } catch (e) {
        result.poked.err = safeErr(e);
      }
    }
    let alive = false;
    let canvas = 0;
    let title = null;
    let msg = null;
    try {
      const r = await Promise.race([
        page.evaluate((NAME_IN_PAGE) => {
          const walk = (n) => {
            let w = 0;
            for (const e of n.querySelectorAll('*')) {
              if (e.tagName === 'CANVAS') w = Math.max(w, e.width);
              if (e.shadowRoot) w = Math.max(w, walk(e.shadowRoot));
            }
            return w;
          };
          const m = document.getElementById('msg');
          /**
           * **判定は面の中でやり、外へは真偽だけ出す。**
           * ⚠ 題名は UI が日本語なので、外で ASCII 濾過すると**丸ごと消える**
           *   (実測: 1 巡目は題名が常に null で「死んだ観測点」だった)。
           */
          /**
           * ⚠ **`textContent` は shadow 境界を越えない。** 1 稿目は `qt-window` の
           *   textContent を見ていたので、題名バーが入れ子の shadow root に在る
           *   この面では**常に空**だった(= 死んだ観測点。自作の対照群を写真で
           *   確かめて気づいた)。葉の要素まで降りて集める。
           */
          /**
           * ⚠ **host 自身の帯を数えない。** 2 稿目は document 全体の葉を集めたので、
           *   host が出している `Office <名前>` に満たされて **5 秒で「開けた」**と
           *   言った(LO はまだ 1 画素も描いていない)── §1 の「代替物に満たされる」。
           * 🔑 見るのは **Qt の器の中だけ**、しかも**名前と LibreOffice の両方**。
           */
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
          /**
           * 🔑 **LO が本当に開いたか**は、LO 自身が作る**ロック file** で分かる
           * (`.~lock.<名前>#`)。⚠ 名前はこちらが付けた `doc.docx` なので中身に触れない。
           * ⚠ 窓の題名は**この面では死んでいる**(実測: 常に長さ 13 で変わらない)。
           */
          let work;
          try {
            work = globalThis.__lo.FS.readdir('/work').filter((n) => n !== '.' && n !== '..');
          } catch {
            work = ['(読めない)'];
          }
          const geom = [];
          const wg = (node) => {
            for (const el of node.querySelectorAll('*')) {
              if (el.classList && el.classList.contains('qt-window')) {
                const r = el.getBoundingClientRect();
                geom.push(`${Math.round(r.width)}x${Math.round(r.height)}`);
              }
              if (el.shadowRoot) wg(el.shadowRoot);
            }
          };
          wg(document);
          return {
            canvas: walk(document),
            docOpen: all.includes(NAME_IN_PAGE),
            loTitle: /LibreOffice/i.test(all),
            titleLen: document.title.length,
            windows: titles.length,
            wrote: !!(globalThis.__loDocPath),
            work,
            geom,
            locked: work.some((n) => n.startsWith('.~lock')),
            msg: m && !m.hidden ? (m.textContent ?? '').slice(0, 100) : null,
            events: globalThis.__probeEvents ?? [],
          };
        }, NAME),
        new Promise((_, rej) => setTimeout(() => rej(new Error('unresponsive')), 4000)),
      ]);
      alive = true;
      canvas = r.canvas;
      title = { docOpen: r.docOpen, loTitle: r.loTitle, windows: r.windows, wrote: r.wrote, locked: r.locked, work: r.work, geom: r.geom };
      msg = r.msg === null ? null : safeLine(r.msg);
      result.events = r.events.map((e) => ({ dt: e.t - t0, type: e.type }));
    } catch {
      alive = false;
    }
    deadStreak = alive ? 0 : deadStreak + 1;
    /**
     * 🔴 **詰まっている最中に読む**(#199)。⚠ 開いた後ではなく**各サンプル**で採る ──
     *   開かない文書が相手なので、「開いた」を待つと**一度も読めない**。
     * ⚠ メインスレッドが応答しない回は `alive` が偽なので、そこでは読まない
     *   (読もうとしても `evaluate` が返らない)。
     */
    let threads;
    if (PTHREAD && alive) {
      try {
        threads = await Promise.race([
          page.evaluate(PTHREADS),
          new Promise((_, rej) => setTimeout(() => rej(new Error('unresponsive')), 4000)),
        ]);
      } catch {
        threads = { err: 'unresponsive' };
      }
    }
    result.samples.push({
      atSec: Math.round((Date.now() - t0) / 1000),
      alive,
      canvas,
      title,
      msg,
      ...(threads === undefined ? {} : { threads }),
    });
    // 🔑 「開けた」= Qt が窓の題名を差し替えたとき(Writer / Calc / Impress の名が出る)
    // 🔑 「開けた」= 窓の題名に**渡した名前**が出たとき(名前はこちらが付けた `doc.docx`)
    // 🔑 名前だけでは足りない(host の帯に出る)── **Qt の器の中で**両方が揃った時
    if (alive && title && title.docOpen && title.loTitle) {
      result.opened = { atSec: Math.round((Date.now() - t0) / 1000), ...title };
      break;
    }
    if (deadStreak >= 6) {
      result.frozen = { fromSec: result.samples[result.samples.length - 6].atSec };
      break;
    }
  }
  /**
   * 🔴 **開いた状態で IME の門を読む**(#156 の「次にやること ②」、2026-08-23)。
   *
   * ⚠ `ime-probe.mjs` は**文書を開かずに**読むので、そこの `accept0` は
   * 「VCL が `SetInputContext` を呼ぶ理由が無い」だけかもしれず、
   * **パッチの失敗の証拠でも成功の証拠でもない**(#156 本文)。
   * 🔑 ここは**開いたことを確かめてから**読むので、その曖昧さが消える。
   *
   * ⚠ 版面を 1 度**押してから**読む ── VCL が `WA_InputMethodEnabled` を立てるのは
   * 「ここは文字を入れる場所だ」と言うときだけなので、caret が要る。
   * ⚠ **既定では何もしない**(`PKC3_IME=1` を渡した回だけ)── 既存の使い方を変えない。
   */
  const canvasBox = () => page.evaluate(CANVAS_BOX);

  /**
   * 🔴 **版面の絵を「集合」で採る**(CLAUDE.md §4、2026-08-13 の教訓)。
   *
   * ⚠ **1 枚ずつ比べない** ── 点滅するカーソルだけで「変わった」になる。
   * 間隔をあけて数枚採り、**集合ごと入れ替わったときだけ**「変わった」と言う。
   * ⚠ 撮れない回は `null` を返す(空配列にしない ── 空だと `every` が真になって
   * 「変わった」と誤読する)。
   */
  const framesOf = async (clip, n = 5) => {
    const set = new Set();
    for (let i = 0; i < n; i += 1) {
      const png = IME || REDRAW ? await page.screenshot({ clip }) : null;
      if (png === null) return null;
      set.add(createHash('sha256').update(png).digest('hex').slice(0, 16));
      await page.waitForTimeout(400);
    }
    return [...set];
  };
  /** 2 つの集合が**丸ごと**入れ替わったか(片方でも採れていなければ `null`)。 */
  const swapped = (a, b) => (a === null || b === null ? null : b.every((h) => !a.includes(h)));

  if (IME && result.opened) {
    mark('IME の門');
    try {
      const box = await canvasBox();
      result.ime = { clicked: false, before: await page.evaluate(IME_DEEP) };
      /**
       * 🔴 **どの一手で何行出たかを分ける**(#156 段③)。
       *
       * ⚠ log に印を書き込めない(JS から MEMFS へ追記する口を増やすと、
       *   計装の出口が 2 か所になる ── CLAUDE.md §7)。
       * 🔑 代わりに**節目ごとに行数を採る** ── 差が「その一手で出た行」である。
       *   これが無いと、起動中に出た行と押した後に出た行が混ざって読めない。
       */
      const traceLen = async () => {
        const t = await page.evaluate(IME_TRACE);
        return Array.isArray(t) ? t.length : null;
      };
      result.ime.marks = { opened: await traceLen() };
      if (box) {
        /**
         * 🔴 **対照群 ── 打鍵が版面に届いたか**(CLAUDE.md §4、2026-08-13 の教訓)。
         *
         * ⚠ これが無いと `accept0` を読めない ── 合成クリックが caret を置けて
         *   いなければ、健全なビルドでも `accept0` を返す(#156 本文の
         *   「🔴 まだ言えないこと」がそれ)。
         * ⚠ **1 枚ずつ比べない** ── 点滅するカーソルだけで「変わった」になる。
         *   間隔をあけて数枚採り、**集合ごと入れ替わったときだけ**「届いた」と言う。
         * ⚠ 撮れない回は `null` を返す(空配列にしない ── 空だと `every` が
         *   真になって「届いた」と誤読する)。
         */
        const clip = { x: box.x, y: box.y, width: box.w, height: box.h };
        const frames = (n = 5) => framesOf(clip, n);
        /**
         * 🔴 **操作にも時刻を付ける**(#117。2026-08-29)。
         *
         * ⚠ console に時刻を付けただけでは、まだ**どの操作の話か**は言えない ──
         * 「起動より後」までしか絞れない。🔑 押した / 打った瞬間を同じ時間軸に
         * 置いて初めて、`memory access out of bounds` を**操作に帰属**できる。
         */
        result.ime.at = { click: Date.now() - t0 };
        await page.mouse.click(box.x + box.w * 0.4, box.y + box.h * 0.35);
        result.ime.clicked = true;
        await page.waitForTimeout(3000);
        result.ime.marks.clicked = await traceLen();
        const beforeFrames = await frames();
        result.ime.at.type = Date.now() - t0;
        await page.keyboard.type('a', { delay: 120 });
        await page.waitForTimeout(3000);
        result.ime.marks.typed = await traceLen();
        const afterFrames = await frames();
        /**
         * 🔴 **キャレットが「本文」に入ったかを分ける**(#156 段③ の前段、2026-08-23)。
         *
         * ⚠ 上の `landed`(版面が変わった)は **「打鍵が届いた」までしか言えない** ──
         *   工具帯の強調でも版面は変わる。ところが `accept0` を読むには
         *   **本文にキャレットが在ること**が前提である(VCL は「ここは文字を入れる
         *   場所だ」と言うときだけ `SetInputContext` を呼ぶ)。
         * 🔑 **LO 自身の近道で分ける** ── `Ctrl+A`(すべて選択)は
         *   **本文にキャレットが在るときだけ**版面を大きく変える(選択の色が乗る)。
         *   ⚠ これも集合で採る(点滅するカーソルで誤判定しない)。
         * ⚠ **これが偽なら `accept0` は読めない** ── 健全なビルドでも
         *   キャレットが無ければ `accept0` を返す(#156 本文の「まだ言えないこと」)。
         */
        result.ime.at.selectAll = Date.now() - t0;
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(2500);
        result.ime.marks.selectedAll = await traceLen();
        const selFrames = await frames();
        result.ime.caretInBody = swapped(afterFrames, selFrames);
        result.ime.landed = swapped(beforeFrames, afterFrames);
        result.ime.frames = { before: beforeFrames?.length ?? null, after: afterFrames?.length ?? null };
        if (IME_REFOCUS) {
          /** 診断属性だけ抜く(入力要素は 1 つなので、書かれている物を拾う)。 */
          const attr = (deep) => (Array.isArray(deep?.inputs)
            ? (deep.inputs.find((i) => typeof i.ime === 'string')?.ime ?? null) : null);
          const r = { atCaret: attr(await page.evaluate(IME_DEEP)) };
          const beforeFind = await frames();
          await page.keyboard.press('Control+f');
          await page.waitForTimeout(2500);
          const afterFind = await frames();
          // ⚠ 開かなかった回の値は読まない(判定不能として残す)
          r.findOpened = swapped(beforeFind, afterFind);
          r.findBar = attr(await page.evaluate(IME_DEEP));
          await page.keyboard.press('Escape');
          await page.waitForTimeout(1500);
          await page.mouse.click(box.x + box.w * 0.4, box.y + box.h * 0.35);
          await page.waitForTimeout(2500);
          r.backInBody = attr(await page.evaluate(IME_DEEP));
          result.ime.refocus = r;
        }
      }
      result.ime.after = await page.evaluate(IME_DEEP);
      // 🔑 最後にまとめて読む(console の取りこぼしに左右されない本命の出口)
      result.ime.trace = await page.evaluate(IME_TRACE);
    } catch (e) {
      result.ime = { err: safeErr(e) };
    }
  }

  /**
   * 🔴 **打鍵が「その場で」版面に出るか**(#154 段①)。
   *
   * 実機は「打っている間は何も変わらず、`Escape` を押した瞬間に**いっぺんに**現れる」。
   * 🔑 だから 2 つを別々に測る ── **打った直後**に変わったか(`landedWhileTyping`)と、
   * **`Escape` の後**に変わったか(`revealedAfterEscape`)。
   *
   * | 読み方 | `landedWhileTyping` | `revealedAfterEscape` |
   * |---|---|---|
   * | 健全(その場で出る) | `true` | 何でもよい |
   * | 🔴 #154 の症状 | **`false`** | **`true`** |
   * | 打鍵が届いていない | `false` | `false` ← ⚠ **判定不能**(以降は読めない) |
   *
   * ⚠ **3 行目が要る。** これを分けないと「届いていない」を「描いていない」と読む
   * (2026-08-13 に、対照群を置かずに存在しない結論を書きかけたのと同じ型)。
   * ⚠ 入れ物だけ違う対(`.odt` / `.odp`)を**同じ腕で**回して初めて
   * 「Impress 固有」が言える ── 片方だけ回して結論を書かない。
   */
  if (REDRAW && result.opened) {
    mark('打鍵の門');
    try {
      const box = await canvasBox();
      result.redraw = { clicked: false };
      if (box) {
        const clip = { x: box.x, y: box.y, width: box.w, height: box.h };
        /**
         * ⚠ 版面の**中ほど**を押す(端は枠や定規に当たる)。
         *
         * 🔴 **入り方はアプリで違う**(2026-08-25 に踏んだ)。Writer は 1 回押せば
         * 本文にカーソルが入るが、**Impress は 1 回では枠を選ぶだけ**で、
         * 字を打つには**ダブルクリック**が要る。
         * ⚠ ここを揃えると「Impress には入力が届かない」という**存在しない結論**が出る
         * ── 届いていないのは LO ではなく**この probe の入り方**である。
         * 🔑 だから回数を外から選べるようにし、**結果に何回押したかを併記する**
         *   (どの入り方で測ったか分からない数字は読めない)。
         */
        const entry = process.env.PKC3_REDRAW_ENTRY ?? 'click';
        if (entry === 'tab') {
          /**
           * 🔑 **位置に依らない入り方。** 押す座標に枠が無ければ、
           * どれだけ押しても字は入らない ── それは LO の話ではなく
           * **こちらの座標の話**である。Impress は `Tab` で枠を順に選び、
           * `F2` で中へ入れるので、**版面のどこに枠があっても届く**。
           */
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
          await page.keyboard.press('Tab');
          await page.waitForTimeout(800);
          await page.keyboard.press('F2');
        } else {
          /**
           * ⚠ **押す所は器の比で決まる ── アプリで意味が違う**(2026-08-25 に踏んだ)。
           * Writer は版面が器のほとんどを占めるので 0.4 / 0.35 で本文に当たるが、
           * **Impress は左にスライド一覧、右にサイドバーが在る**ので、同じ比が
           * **枠の外**に落ちる。⚠ そこで打っても字が入らないのは当たり前で、
           * それを「Impress には届かない」と読むと**存在しない結論**になる。
           * 🔑 だから外から選べるようにし、**結果に押した比を併記する**。
           */
          const fx = Number(process.env.PKC3_REDRAW_X ?? '0.4');
          const fy = Number(process.env.PKC3_REDRAW_Y ?? '0.35');
          result.redraw.at = { x: fx, y: fy };
          await page.mouse.click(box.x + box.w * fx, box.y + box.h * fy, {
            clickCount: entry === 'dblclick' ? 2 : 1,
          });
        }
        result.redraw.clicked = true;
        result.redraw.entry = entry;
        await page.waitForTimeout(3000);
        const before = await framesOf(clip);
        // ⚠ 1 文字では足りない ── 見えていても気づけない。**目に見える量**を打つ
        await page.keyboard.type('HELLO 12345', { delay: 120 });
        await page.waitForTimeout(3000);
        const typed = await framesOf(clip);
        // 🔑 実機で「いっぺんに現れた」引き金と**同じ一手**(Escape)を打つ
        await page.keyboard.press('Escape');
        await page.waitForTimeout(2500);
        const escaped = await framesOf(clip);
        /**
         * 🔴 **陰の対照群 ── 何も打たない間は変わらないこと。**
         *
         * ⚠ これが無いと「変わった」が何も言っていない ── 版面が放っておいても
         * 変わるなら(点滅・再描画・時計)、上の 2 つは**時間が経った証拠**でしかない
         * (CLAUDE.md §4「観測点が放っておいても変わるなら、変化は届いた証拠にならない」)。
         * ⚠ `idleChanged` が `true` の回は、**この probe の結果を 1 つも読まない**。
         */
        await page.waitForTimeout(2500);
        const idle = await framesOf(clip);
        /**
         * 🔴 **保存して、打った字が中身に入っているかを見る**(#154 の次の一手 ①)。
         *
         * ⚠ 対の 2 本(`.odt` / `.odp`)は**どちらも ODF** なので、非 ODF の
         *   「形式を保ちますか」ダイアログは出ない ── 1 度の実験で 2 つを
         *   主張しないための選び方である(#225 で測ってある)。
         * ⚠ `Escape` の**後**に保存する ── 実機の症状は「Escape でいっぺんに
         *   現れる」なので、その一手を挟んだ後の状態を保存の対象にする。
         */
        result.redraw.saveWaitedMs = await pressSaveAndWait();
        try {
          result.redraw.saved = await page.evaluate(TYPED_IN_SAVED('HELLO 12345'));
        } catch (e) {
          result.redraw.saved = { err: safeErr(e) };
        }
        result.redraw.landedWhileTyping = swapped(before, typed);
        result.redraw.revealedAfterEscape = swapped(typed, escaped);
        result.redraw.idleChanged = swapped(escaped, idle);
        result.redraw.frames = {
          before: before?.length ?? null,
          typed: typed?.length ?? null,
          escaped: escaped?.length ?? null,
          idle: idle?.length ?? null,
        };
      }
    } catch (e) {
      result.redraw = { err: safeErr(e) };
    }
  }
  /**
   * 🔴 **メニューを 1 つ開いて 1 枚撮る**(`PKC3_MENU_OPEN=<キー>` の回だけ)。
   *
   * 🔑 上流の一式を上げたときに「**その面が変わったか**」を見るための、いちばん安い口である
   *   (#146 のファイル選択のように、**構造の話なので普通は変わらない**ものを、
   *   それでも 1 度は見ておくため)。
   * ⚠ 項目まで選ぶなら `PKC3_MENU_ITEM=<キー>` を足す ── **日本語 UI の近道キー**で
   *   指定する(`コピー(Y)` のように、英語の頭文字とは違う)。
   * ⚠ **開いたことを数で残す**(`windows`)── 開いていない回の絵を読まないため。
   */
  if (process.env.PKC3_MENU_OPEN && result.opened) {
    const tour = {};
    result.menuTour = tour;
    try {
      const box = await canvasBox();
      if (box) {
        await page.mouse.click(box.x + box.w * 0.4, box.y + box.h * 0.35);
        await page.waitForTimeout(2000);
        tour.before = await page.evaluate(COUNT_QT_WINDOWS);
        await page.keyboard.press(process.env.PKC3_MENU_OPEN);
        await page.waitForTimeout(2500);
        tour.opened = await page.evaluate(COUNT_QT_WINDOWS);
        if (process.env.PKC3_MENU_ITEM) {
          await page.keyboard.press(process.env.PKC3_MENU_ITEM);
          await page.waitForTimeout(6000);
          tour.afterItem = await page.evaluate(COUNT_QT_WINDOWS);
        }
        if (process.env.PKC3_MENU_SHOT) {
          await page.screenshot({ path: process.env.PKC3_MENU_SHOT });
          tour.shot = process.env.PKC3_MENU_SHOT;
        }
      }
    } catch (e) {
      tour.err = safeErr(e);
    }
  }
  /**
   * 🔴 **コピーと貼り付けが効くか**(#121、`PKC3_PASTE=1` の回だけ)。
   *
   * ⚠ 実機の報告は「右クリック → Copy → 右クリック → Paste で**何も起きない**」で、
   *   Edit メニューの `Paste Special` が**グレーアウト** = LO の中のクリップボードが
   *   空、というものだった。⚠ だが「効かない」の原因候補は 3 つあり
   *   (主スレッド閉塞 / 権限 / 実装が無い)、**どれも版面の見た目では割れない**。
   *
   * 🔑 だから観測点は**保存した中身の件数**にする(`TYPED_IN_SAVED` を件数付きにした)──
   *   1 回打った字が、貼った後に **2 回**在れば貼れている。
   *
   * ⚠ **順番に意味がある。** 全選択したまま貼ると、貼れても**選択を置き換える**ので
   *   件数が 1 のまま = 「効かなかった」と区別できない。だから `End` で選択を畳んでから貼る。
   *
   * 読み方(⚠ **対照群が崩れた回は 1 つも読まない**):
   *
   * | 観測 | 読み方 |
   * |---|---|
   * | `typed.count !== 1` / `typed.size === base.size` | 🔴 **判定不能** ── 入力か保存が届いていない |
   * | `copied.count === 0` | 🔴 `Ctrl+C` が**文字として入って選択を潰した**(近道が LO に届いていない) |
   * | `pasted.count === 2` | ✅ **貼れた** |
   * | `pasted.count === 1` | コピーか貼り付けのどちらかが効いていない |
   * | `hungAt` が非 null | 🔴 **主スレッドが返ってこない**(候補 1 の裏取り) |
   */
  if (PASTE && result.opened) {
    mark('貼り付けの門');
    const NEEDLE = 'ZULU9';
    const paste = { clicked: false, hungAt: null };
    result.paste = paste;
    /** ⚠ 保存が走らなかった回を「入っていない」と読まないための読み口。 */
    const readSaved = async (label) => {
      try {
        return await page.evaluate(TYPED_IN_SAVED(NEEDLE));
      } catch (e) {
        paste.hungAt = paste.hungAt ?? label;
        return { err: safeErr(e) };
      }
    };
    /** ⚠ 保存の後は長めに待つ ── 落ちたのではなく**遅い**だけのことがある。 */
    const save = async () => {
      paste.saveWaitedMs = await pressSaveAndWait();
    };
    try {
      const box = await canvasBox();
      if (box) {
        const fx = Number(process.env.PKC3_REDRAW_X ?? '0.4');
        const fy = Number(process.env.PKC3_REDRAW_Y ?? '0.35');
        paste.at = { x: fx, y: fy };
        await page.mouse.click(box.x + box.w * fx, box.y + box.h * fy);
        paste.clicked = true;
        await page.waitForTimeout(2500);
        // 🔑 **基準** ── 打つ前の大きさ。保存が走ったかを、これとの差で見る
        paste.base = await readSaved('base');
        await page.keyboard.type(NEEDLE, { delay: 120 });
        await page.waitForTimeout(1500);
        await save();
        // 🔑 **対照群** ── ここが 1 でなければ、以降は全部読めない
        paste.typed = await readSaved('typed');
        const via = process.env.PKC3_PASTE_VIA ?? 'keys';
        paste.via = via;
        /**
         * ⚠ **全選択するのは「LO の中でコピーする腕」だけ**(#121、2026-08-29)。
         * `browser` の腕は LO の中の字をコピーしないので、ここで全選択すると
         * **貼り付けが対照群の字を置き換えて消す** ── 対照群ごと壊れる。
         */
        if (via !== 'browser') {
          await page.keyboard.press('Control+a');
          await page.waitForTimeout(800);
        }
        /**
         * 🔴 **コピーの出し方を選べるようにする**(#121 の手順は**メニュー**である)。
         *
         * ⚠ 実機の報告は「右クリック → Copy」で、`Ctrl+C` ではない ── そして
         *   `編集` メニューの `貼り付け(特殊)` が**グレーアウト**していた、が肝の観測だった。
         *   ⚠ **近道とメニューは別の経路**なので、片方で測って両方を語れない
         *   (2026-08-25 の「同じ手順で回したは、同じ物を触ったではない」と同じ形)。
         * 🔑 `PKC3_PASTE_VIA=menu` で**メニューの近道キー**(`Alt+E` = `編集(E)`)から出す ──
         *   座標を当てずに済むので、器の大きさが変わっても指す先がずれない。
         * ⚠ **開いたことを別に数える**(`menuWindows`)── 開いていない回を
         *   「コピーが効かなかった」と読まないため。
         */
        const countWindows = () => page.evaluate(COUNT_QT_WINDOWS);
        /**
         * 🔑 **項目は近道キーで選ぶ**(座標を当てない)。実測した `編集` メニューの綴りは
         *   `コピー(Y)` / `貼り付け(P)` である ── 日本語 UI なので `C` / `V` ではない。
         *   ⚠ ここを英語のつもりで書くと、**別の項目を叩いて**「効かなかった」に見える。
         */
        const menuPick = async (accel) => {
          const before = await countWindows();
          await page.keyboard.press('Alt+e');
          await page.waitForTimeout(2500);
          const opened = await countWindows();
          await page.keyboard.press(accel);
          await page.waitForTimeout(2000);
          return { before, opened, picked: accel };
        };
        if (via === 'menu') {
          paste.menuCopy = await menuPick('y');
          await page.waitForTimeout(1500);
          /**
           * 🔴 **#121 の肝の観測点** ── コピーの**後**に `編集` を開き直して、
           *   `形式を選択して貼り付け` が**灰色のままか**を見る。
           * ⚠ 実機では灰色 = 「LO の中のクリップボードが空」だった。
           *   コピーの前は灰色で**当たり前**なので、**後**で見ないと何も言えない。
           */
          if (process.env.PKC3_MENU_SHOT) {
            await page.keyboard.press('Alt+e');
            await page.waitForTimeout(2500);
            await page.screenshot({ path: process.env.PKC3_MENU_SHOT });
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1200);
          }
        } else if (via === 'browser') {
          /**
           * 🔴 **ブラウザのクリップボードを跨ぐ**(#121 の残り 1 手。2026-08-29)。
           *
           * ⚠ `keys` / `menu` の 2 本は **LO 1 インスタンスの中で閉じている**ので、
           * `navigator.clipboard` を 1 度も跨がない ── #121 の候補 1(主スレッド閉塞)と
           * 候補 2(`clipboard-read` の権限)が当たる**当の経路を踏んでいない**。
           * 🔑 この腕は「**別のアプリで写した字を LO へ貼る**」を作る:
           *   外(ホストの頁)から `writeText` で種を置き、LO へ `Ctrl+V` する。
           *
           * ⚠ **固まる形で失敗しうる** ── #121 は「頁から `writeText()` を呼んだだけで
           *   レンダラが 45 秒フリーズ(2 回再現)」と記録している。だから
           *   **頁の中と Node の両方**に締切を置き、固まった回は
           *   「貼れていない」ではなく **判定不能**として読む。
           */
          const seedJs = `(async () => {
            const late = new Promise((r) => setTimeout(() => r({ hung: 'in-page' }), 20000));
            const w = navigator.clipboard.writeText(${JSON.stringify('OUTSIDE7')})
              .then(() => ({ ok: true }), (e) => ({ err: String(e).slice(0, 120) }));
            return await Promise.race([w, late]);
          })()`;
          paste.seed = await Promise.race([
            page.evaluate(seedJs).catch((e) => ({ err: safeErr(e) })),
            new Promise((r) => setTimeout(() => r({ hung: 'node' }), 30000)),
          ]);
        } else {
          await page.keyboard.press('Control+c');
        }
        await page.waitForTimeout(2500);
        await save();
        // 🔑 0 なら Ctrl+C が文字として入っている(選択を潰した)
        paste.copied = await readSaved('copied');
        // ⚠ 選択を畳んでから貼る ── 選んだまま貼ると件数が動かない
        /**
         * 🔴 **選択を確実に畳む**(2026-08-28 に踏んだ)。
         *
         * ⚠ `End` 1 つでは畳めない回がある ── メニューを閉じた直後は、その一手が
         *   メニュー側に食われることがある。畳めていないまま貼ると、貼れていても
         *   **同じ字を同じ字で置き換える**ので件数が動かない = 「貼れていない」に見える
         *   (実測: 件数 1 のまま、大きさだけ +32 バイト動いた)。
         * 🔑 `ArrowRight`(選択を右端へ畳む)→ `Control+End`(文末へ)の 2 手にし、
         *   **貼る直前の版面を 1 枚撮る**(`PKC3_PRE_PASTE_SHOT`)── 状態表示に
         *   `選択中` が残っていれば、その回の件数は読まない。
         */
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(600);
        await page.keyboard.press('Control+End');
        await page.waitForTimeout(900);
        if (process.env.PKC3_PRE_PASTE_SHOT) {
          await page.screenshot({ path: process.env.PKC3_PRE_PASTE_SHOT });
        }
        if (via === 'menu') {
          paste.menuPaste = await menuPick('p');
        } else {
          // ⚠ `browser` も近道キーで貼る ── 問いは**橋**であって、メニューではない
          await page.keyboard.press('Control+v');
        }
        await page.waitForTimeout(2500);
        await save();
        paste.pasted = await readSaved('pasted');
        const t = paste.typed?.count ?? null;
        const c = paste.copied?.count ?? null;
        const v = paste.pasted?.count ?? null;
        paste.controlLanded = t === 1 && paste.base?.size !== paste.typed?.size;
        if (via === 'browser') {
          /**
           * 🔑 数えるのは**外から置いた字**である(打った字ではない)。
           * ⚠ 対照群(`controlLanded`)は打った字のままで良い ── それが崩れた回は
           *   保存も打鍵も届いていないので、どのみち読めない。
           */
          paste.outside = await (async () => {
            try {
              return await page.evaluate(TYPED_IN_SAVED('OUTSIDE7'));
            } catch (e) {
              paste.hungAt = paste.hungAt ?? 'outside';
              return { err: safeErr(e) };
            }
          })();
          const o = paste.outside?.count ?? null;
          paste.verdict = !paste.controlLanded
            ? '判定不能(打鍵か保存が届いていない)'
            : paste.seed?.hung
              ? `判定不能(クリップボードへ書く所で固まった: ${paste.seed.hung})`
              : paste.seed?.err
                ? `判定不能(クリップボードへ書けなかった: ${paste.seed.err})`
                : o !== null && o >= 1
                  ? '外から貼れた'
                  : o === 0
                    ? '外からは貼れていない'
                    : `読めない件数: ${String(o)}`;
        } else {
          paste.verdict = !paste.controlLanded
            ? '判定不能(打鍵か保存が届いていない)'
            : c === 0
              ? 'Ctrl+C が文字として入った'
              : v === 2
                ? '貼れた'
                : v === 1
                  ? '貼れていない'
                  : '読めない件数: ' + String(v);
        }
      }
    } catch (e) {
      paste.err = safeErr(e);
    }
  }
  /**
   * 🔴 **詰まっている相手を「名前で」言う ── 全 worker の stack を 1 枚撮る**
   * (#199 の「次の一手 ②」、2026-08-24)。
   *
   * ⚠ **`PKC3_STACKS=1` を渡した回だけ**。既定の使い方を変えない。
   * 🔑 ここが要るのは、①(`PThread` の内訳)が**死んだ観測点**だったからである ──
   *   詰まった回と開いた回で **`running:2 / unused:14` が完全に同じ**だった
   *   (2026-08-24 実測。対照群つき)。数では言えないので、**中身**を見る。
   * ⚠ 名前が読めるのは `profiling_funcs: true` で焼いた一式だけ ── 素の一式では
   *   `$funcNNNN` になる。**それでも「止まっているか / どこに居るか」は分かる**ので、
   *   まず機構が通ることを確かめる。
   * 🔑 返り値で 3 つを見分ける:
   *     `{ workers: 0 }`      = worker が 1 つも見えない(機構が通っていない)
   *     `{ err: ... }`        = 撮ろうとして落ちた
   *     `{ frames: [...] }`   = 撮れた
   * ⚠ **1 本ずつ時限を切る** ── futex で寝ている worker は `Debugger.pause` に
   *   応じないことがある。応じない 1 本のために全部を失わない。
   */
  if (STACKS) {
    /**
     * ⚠ **Playwright は worker に CDP を張れない**(2026-08-24 実測:
     *   `browser.newCDPSession(worker)` は `expected Page or Frame` で断る)。
     * 🔑 だから **target 越しに送る** ── 頁の session から `Target.attachToTarget`
     *   して `sessionId` を貰い、`Target.sendMessageToTarget` で包んで渡す
     *   (返事は `Target.receivedMessageFromTarget` で戻る)。
     * ⚠ この 2 つは deprecated なので、**無ければ無いと書く**(黙って 0 件にしない)。
     */
    const shot = { workers: page.workers().length, stacks: [] };
    try {
      const cdp = await browser.newCDPSession(page);
      const waiters = new Map();
      let seq = 0;
      cdp.on('Target.receivedMessageFromTarget', (e) => {
        let msg;
        try { msg = JSON.parse(e.message); } catch { return; }
        const key = `${e.sessionId}:${msg.id}`;
        const w = waiters.get(key);
        if (w) { waiters.delete(key); w(msg); }
        if (msg.method === 'Debugger.paused') {
          const p = waiters.get(`${e.sessionId}:paused`);
          if (p) { waiters.delete(`${e.sessionId}:paused`); p(msg.params); }
        }
      });
      const call = (sessionId, method, params = {}) => {
        seq += 1;
        const id = seq;
        const done = new Promise((ok) => waiters.set(`${sessionId}:${id}`, ok));
        return cdp
          .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
          .then(() => Promise.race([done, new Promise((ok) => setTimeout(() => ok(null), 4000))]));
      };
      /**
       * 🔴 **メインスレッドも撮る**(#199 の 4 巡目、2026-08-24)。
       *
       * 3 巡目で「vcl の待ちループには入っているが `Application::Yield()` から
       * 戻ってこない」ところまで確定した(`execute:loop` が 1 回で止まり
       * `execute:set` が 0 件 / 対照群は 5 往復)。⚠ 残るのは
       * **Yield の中のどこで止まっているか**で、それはメインの stack にしか出ない。
       *
       * 🔑 worker と違い、頁の session は**そのまま** `Debugger.pause` できる
       * (`Target.sendMessageToTarget` で包む必要が無い)。
       * ⚠ **必ず resume する** ── 止めたままだと、この後の `page.evaluate`
       *   (計装の読み出し)が**永久に返らない**。
       * ⚠ 3 値で読む: `null` = 止まらなかった(**JS を 1 行も実行していない**
       *   = ブラウザの event 待ちに落ちている)/ `[]` = 枠が空 / 中身あり = そこに居る。
       * ⚠ 名前が読めるのは `profiling_funcs: true` で焼いた一式だけ。
       */
      try {
        const mainPaused = new Promise((ok) => {
          cdp.once('Debugger.paused', (ev) => ok(ev));
        });
        await cdp.send('Debugger.enable');
        await cdp.send('Debugger.pause');
        const ev = await Promise.race([
          mainPaused,
          new Promise((ok) => setTimeout(() => ok(null), 4000)),
        ]);
        shot.main =
          ev === null
            ? null
            : (ev.callFrames ?? []).slice(0, 25).map((f) => ({
                fn: String(f.functionName ?? '').slice(0, 80),
                url: String(f.url ?? '').slice(-40),
              }));
        await cdp.send('Debugger.resume').catch(() => {});
        await cdp.send('Debugger.disable').catch(() => {});
      } catch (e) {
        shot.mainErr = safeErr(e);
      }

      const { targetInfos } = await cdp.send('Target.getTargets');
      const workers = targetInfos.filter((t) => t.type === 'worker' || t.type === 'shared_worker');
      shot.targets = workers.length;
      for (const [i, t] of workers.entries()) {
        const one = { i, type: t.type };
        try {
          const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: false });
          one.attached = true;
          await call(sessionId, 'Debugger.enable');
          const paused = new Promise((ok) => waiters.set(`${sessionId}:paused`, ok));
          await call(sessionId, 'Debugger.pause');
          const ev = await Promise.race([paused, new Promise((ok) => setTimeout(() => ok(null), 4000))]);
          // ⚠ **応じなかった回は `null`**(空配列にしない ── 「寝ている」と「枠が無い」は別)
          one.frames =
            ev === null
              ? null
              : (ev.callFrames ?? []).slice(0, 20).map((f) => ({
                  fn: String(f.functionName ?? '').slice(0, 80),
                  url: String(f.url ?? '').slice(-40),
                }));
          await call(sessionId, 'Debugger.resume');
          await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        } catch (e) {
          one.err = safeErr(e);
        }
        shot.stacks.push(one);
      }
      await cdp.detach().catch(() => {});
    } catch (e) {
      shot.err = safeErr(e);
    }
    result.stacks = shot;
  }

  // 🔑 **計装はまとめて最後に読む**(出口を 1 つにする ── 2026-08-10 の教訓)。
  //    ⚠ `null`(この焼きに計装が無い)と `[]`(在るが 1 行も出ていない)を混ぜない。
  mark('計装を読む');
  result.idlesTrace = await page.evaluate(IDLES_TRACE).catch((e) => ({ err: String(e).slice(0, 80) }));

  if (SHOT) {
    try { await page.screenshot({ path: SHOT }); } catch { /* 固まっていたら撮れない */ }
  }
} catch (e) {
  result.error = safeErr(e);
} finally {
  wd.disarm();
  const text = JSON.stringify(result, null, 1);
  if (OUT) await writeFile(OUT, text);
  else console.log(text);
  await browser.close();
  server.close();
  /**
   * 🔴 **profile を残さない**(#220 の併走で判明。機密資料の取り扱い 5)。
   * ⚠ 開いた文書の痕跡(cache / IDB / 一時 file)がここに入る ── 兄弟の
   * `save-existing-probe.mjs` は消しているのに、こちらは残していた
   * (「片側を直したら対称の反対側を疑う」の 1 件)。
   */
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
