/**
 * PDF を読む別窓の本体(#275 段①)。設計は `host.html` の冒頭と `docs/development/shell-pdf-design-2026-08.md`。
 *
 * 流れ: `hello` を放送 → 本体が貸した URL を `doc` で受ける → `fetch` で Blob を取って `loaded` を返す
 * (ここで本体は URL を返す。⚠ 窓の寿命まで握らせない)→ pdf.js で開く → 見えている頁の前後 2 頁を
 * **PNG の `<img>` に焼いて**置く → 選んだ字は `quote` で本体へ送る(ノートへ書くのは本体)。
 *
 * 🔴 規律(不可侵指示):
 *   - 重い解析は **pdf.js の worker**(窓の中。窓を閉じれば worker も消える)
 *   - 頁は**描いたら焼く**。外れた頁の ObjectURL は **その場で revoke**(`page-cache.js`)
 *   - bytes は**複製しない**(Blob を握り、worker へは transfer)
 *   - 読めなかったら**黙って内蔵の表示へ退避**し、本体へ 1 行知らせる(`fell-back`)
 *   - 🔴 **使われない間は pdf.js の worker を畳む**(`doc-lease.js`。60 秒。描いた頁の絵・字の層・検索用の本文は残り、
 *     まだ描いていない頁を描くときだけ黙って開き直す)
 * ⚠ 画面の字に pdf.js / worker などの内部語を出さない。
 */
const wire = self.PkcPdfWire;
const { PageCache, windowOf } = self.PkcPdfPageCache;
const { DocLease } = self.PkcPdfDocLease;
const textHits = self.PkcPdfTextHits;

/** 見えている頁の前後に、この数だけ先に描く。 */
const RADIUS = 2;
/** 同時に持つ頁の上限(縮小して一度に何十頁も見えるときの歯止め)。 */
const MAX_LIVE = 16;
const SCALE_MIN = 0.2;
const SCALE_MAX = 5;
/** 1 枚の絵の画素の上限(これを超えるなら解像度を落とす)。 */
const MAX_PIXELS = 16 * 1024 * 1024;
const HEARTBEAT_MS = 3000;

const token = location.hash.replace(/^#/, '');
const $ = (id) => document.getElementById(id);
const scroller = $('scroller');
const pagesEl = $('pages');
const msgEl = $('msg');
const statusEl = $('status');
const quoteBtn = $('quote');

const ch = new BroadcastChannel(wire.CHANNEL);
const send = (kind, payload) => ch.postMessage(wire.envelope(kind, token, payload));

const setStatus = (text) => {
  statusEl.textContent = text;
  statusEl.title = text;
};
const state = (s) => {
  document.body.setAttribute('data-pkc-pdf-state', s);
};

let pdfjs = null;
/** 解析 worker を握る貸し出し(`doc-lease.js`)。⚠ 文書(`PDFDocumentProxy`)はここ越しにしか触らない。 */
let lease = null;
/** 読めて、頁が並んでいる間だけ true(内蔵の表示へ退避したら false)。 */
let ready = false;
let total = 0;
let blob = null;
let ownUrl = null;
let started = false;
let scale = 1;
let fitMode = true;
/** 世代。拡大縮小で進み、古い描きの結果は捨てる。 */
let gen = 0;
/** 頁 → 基準(倍率 1)の大きさ。まだ読んでいない頁は 1 頁目を借りる。 */
const sizes = [];
const boxes = [];
/** 頁 → 文字の層の持ち物(`divs` = span / `strs` = span ごとの字 / `marked` = 強調で作り替えた span の番号)。 */
const layers = [];
/** 頁 → いま描いている世代。 */
const inflight = new Map();
let wanted = new Set();
let current = 1;

/** 本体の返事を待つ時計(`wire.DOC_TIMEOUT_MS` / `wire.QUOTE_TIMEOUT_MS`)。 */
let docTimer = null;
let quoteTimer = null;
const clearTimer = (h) => {
  if (h !== null) clearTimeout(h);
};

const cache = new PageCache(MAX_LIVE, (url) => URL.revokeObjectURL(url));

// ───────── 文書を受け取る

ch.onmessage = (ev) => {
  const m = wire.parse(ev.data, token);
  if (m === null) return;
  if (m.kind === 'doc') {
    clearTimer(docTimer);
    docTimer = null;
    void onDoc(m.payload);
  }
  else if (m.kind === 'focus-request') window.focus();
  else if (m.kind === 'quote-result') {
    clearTimer(quoteTimer);
    quoteTimer = null;
    setStatus(typeof m.payload.message === 'string' ? m.payload.message : '');
  }
};

async function onDoc(payload) {
  if (started) return;
  started = true;
  if (typeof payload.name === 'string' && payload.name !== '') document.title = payload.name;
  if (typeof payload.url !== 'string') {
    state('failed');
    msgEl.textContent = wire.DOC_FAILED;
    send('load-failed', { reason: 'no-url' });
    return;
  }
  try {
    const res = await fetch(payload.url);
    if (!res.ok) throw new Error(`status ${String(res.status)}`);
    blob = await res.blob();
  } catch (e) {
    state('failed');
    msgEl.textContent = wire.DOC_FAILED;
    send('load-failed', { reason: String(e) });
    return;
  }
  // 🔑 Blob を握った ── 本体は貸した URL をここで返す
  send('loaded', {});
  await openPdf();
}

// ───────── 開く(だめなら内蔵の表示へ)

async function openPdf() {
  try {
    pdfjs = await import('./lib/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;
    lease = new DocLease({
      open: openDoc,
      // 🔑 解析 worker を terminate する(常駐メモリを返す)。⚠ `destroy()` は文書(`PDFDocumentProxy`)ではなく
      //    **読み込みの課題(`loadingTask`)**に在る ── 文書に `destroy` は無く、呼ぶと TypeError になる
      //    (貸し出しは畳む途中の例外を握りつぶすので、worker が残るだけで**何も鳴らない**。実際に踏んだ)
      close: (doc) => doc.loadingTask.destroy(),
    });
    await lease.use(async (doc) => {
      total = doc.numPages;
      if (!(total >= 1)) throw new Error('no pages');
      const first = await doc.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      sizes[1] = { w: vp.width, h: vp.height };
      first.cleanup();
    });
    buildBoxes();
    msgEl.hidden = true;
    ready = true;
    state('ready');
    $('pagecount').textContent = `/ ${String(total)}`;
    fitWidth();
  } catch {
    fallBack();
  }
}

/**
 * 文書を開く(貸し出しが呼ぶ。最初の 1 回と、アイドルで畳んだ後の開き直し)。
 * ⚠ Blob は窓が握り続けているので、開き直すたびに bytes を取り直せる(transfer で worker へ渡す = 複製しない)。
 * ⚠ 開けなかったら `openFailed` を付けて投げる(読めていた文書の開き直しに失敗したら、内蔵の表示へ退避する)。
 */
async function openDoc() {
  try {
    const lib = new URL('./lib/', import.meta.url).href;
    const data = new Uint8Array(await blob.arrayBuffer());
    return await pdfjs.getDocument({
      data,
      cMapUrl: `${lib}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${lib}standard_fonts/`,
      wasmUrl: `${lib}wasm/`,
    }).promise;
  } catch (e) {
    const err = new Error(`open failed: ${String(e)}`);
    err.openFailed = true;
    throw err;
  }
}

/** 内蔵の表示へ。⚠ 断り文は出さない(読めない PDF でも user は読める)。 */
function fallBack() {
  if (blob === null) return;
  state('fell-back');
  ready = false;
  // 🔑 文書(= 解析 worker)を握っていれば畳む。待っている依頼は貸し出しが reject する
  if (lease !== null) lease.dispose();
  cache.clear();
  document.body.textContent = '';
  ownUrl = URL.createObjectURL(blob);
  const obj = document.createElement('object');
  obj.setAttribute('data-pkc-field', 'pdf-reader-fallback');
  obj.type = 'application/pdf';
  obj.data = ownUrl;
  document.body.append(obj);
  send('fell-back', {});
}

// ───────── 頁の箱と描き

function buildBoxes() {
  for (let i = 1; i <= total; i += 1) {
    const box = document.createElement('div');
    box.className = 'page';
    box.setAttribute('data-page', String(i));
    boxes[i] = box;
    pagesEl.append(box);
  }
}

function sizeBox(i) {
  const s = sizes[i] || sizes[1];
  boxes[i].style.width = `${String(Math.floor(s.w * scale))}px`;
  boxes[i].style.height = `${String(Math.floor(s.h * scale))}px`;
}

function clearBox(i) {
  layers[i] = undefined;
  if (boxes[i]) boxes[i].textContent = '';
}

function resizeAll() {
  for (let i = 1; i <= total; i += 1) sizeBox(i);
}

function visibleRange() {
  const r = scroller.getBoundingClientRect();
  let first = 0;
  let last = 0;
  for (let i = 1; i <= total; i += 1) {
    const b = boxes[i].getBoundingClientRect();
    if (b.bottom >= r.top && b.top <= r.bottom) {
      if (first === 0) first = i;
      last = i;
    } else if (first !== 0) break;
  }
  return first === 0 ? [current, current] : [first, last];
}

function refresh() {
  if (!ready) return;
  const [first, last] = visibleRange();
  // 「いまの頁」= 窓の上 3 分の 1 の線にかかる頁
  const r = scroller.getBoundingClientRect();
  const line = r.top + r.height / 3;
  current = first;
  for (let i = first; i <= last; i += 1) {
    const b = boxes[i].getBoundingClientRect();
    if (b.top <= line && b.bottom >= line) current = i;
  }
  if (document.activeElement !== $('pageno')) $('pageno').value = String(current);
  let want = windowOf(first, last, total, RADIUS);
  if (want.size > MAX_LIVE) {
    // 縮小して一度に多く見えるとき: いまの頁に近い順に MAX_LIVE 頁だけ
    want = new Set([...want].sort((a, b) => Math.abs(a - current) - Math.abs(b - current)).slice(0, MAX_LIVE));
  }
  wanted = want;
  for (const i of cache.retain(want)) clearBox(i);
  for (const i of want) {
    if (!cache.has(i) && inflight.get(i) !== gen) void renderPage(i);
  }
}

async function renderPage(i) {
  const myGen = gen;
  inflight.set(i, myGen);
  try {
    // 🔑 描いている間は「飛んでいる依頼」── その間は解析 worker を畳まない(`doc-lease.js`)
    await lease.use((pdf) => drawPage(pdf, i, myGen));
  } catch (e) {
    // 内蔵の表示へ退避した後に落ちた依頼(貸し出しが reject した)は、黙って捨てる
    if (!ready) return;
    // 読めていた文書を、アイドルの後に開き直せなかった ── 頁が空のまま残るより、内蔵の表示で読める形にする
    if (e && e.openFailed) {
      fallBack();
      return;
    }
    console.warn('page render failed', i, e);
    // 1 頁が描けなくても、他の頁は読める(箱は空のまま残る)
  } finally {
    if (inflight.get(i) === myGen) inflight.delete(i);
  }
}

async function drawPage(pdf, i, myGen) {
  const page = await pdf.getPage(i);
  if (myGen !== gen) return;
  const vp = page.getViewport({ scale });
  sizes[i] = { w: vp.width / scale, h: vp.height / scale };
  sizeBox(i);
  if (!wanted.has(i)) {
    page.cleanup();
    return;
  }
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  while (dpr > 1 && vp.width * dpr * vp.height * dpr > MAX_PIXELS) dpr -= 0.5;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width * dpr));
  canvas.height = Math.max(1, Math.floor(vp.height * dpr));
  await page.render({
    canvas,
    viewport: vp,
    transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
  }).promise;
  const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  // 🔑 焼いたら canvas は即手放す(絵は PNG の `<img>` が持つ)
  canvas.width = 0;
  canvas.height = 0;
  if (png === null) return;
  const url = URL.createObjectURL(png);
  if (myGen !== gen || !wanted.has(i)) {
    URL.revokeObjectURL(url);
    page.cleanup();
    return;
  }
  for (const e of cache.put(i, url)) clearBox(e);
  const box = boxes[i];
  clearBox(i);
  box.style.setProperty('--total-scale-factor', String(scale));
  const img = document.createElement('img');
  img.setAttribute('data-pkc-field', 'pdf-page-image');
  img.alt = `${String(i)} 頁`;
  img.src = url;
  box.append(img);
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  box.append(layer);
  try {
    const tl = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: layer,
      viewport: vp,
    });
    await tl.render();
    // 🔑 span ごとの字を持っておく(検索の強調が、またがる一致を span ごとの範囲へ割り付ける)。
    //    ⚠ 描いている間に箱が作り直された(拡大縮小 / 外れた)なら、持たない
    if (layer.isConnected) {
      layers[i] = { divs: tl.textDivs, strs: tl.textContentItemsStr, marked: new Set() };
      markHits(i);
    }
  } catch {
    // 字の層だけ落ちても絵は読める(選べないだけ)
  }
  page.cleanup();
}

// ───────── 拡大縮小 / 頁送り

function applyScale(next) {
  const anchor = current;
  scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, next));
  gen += 1;
  cache.clear();
  for (let i = 1; i <= total; i += 1) clearBox(i);
  resizeAll();
  boxes[anchor].scrollIntoView({ block: 'start' });
  refresh();
}

function fitWidth() {
  fitMode = true;
  applyScale((scroller.clientWidth - 24) / sizes[1].w);
}

function zoomBy(factor) {
  fitMode = false;
  applyScale(scale * factor);
}

function goPage(n) {
  if (total < 1 || !Number.isFinite(n)) return;
  const p = Math.max(1, Math.min(total, Math.floor(n)));
  boxes[p].scrollIntoView({ block: 'start' });
  refresh();
}

$('zoom-out').addEventListener('click', () => zoomBy(1 / 1.25));
$('zoom-in').addEventListener('click', () => zoomBy(1.25));
$('zoom-fit').addEventListener('click', () => {
  if (total >= 1) fitWidth();
});
$('prev').addEventListener('click', () => goPage(current - 1));
$('next').addEventListener('click', () => goPage(current + 1));
$('pageno').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') goPage(Number($('pageno').value));
});
let ticking = false;
scroller.addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    refresh();
  });
});
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    if (fitMode && total >= 1) fitWidth();
  }, 200);
});

// ───────── 文書内検索

let textsPromise = null;
let hitList = [];
let hitIndex = -1;
let hitQuery = '';

function loadTexts() {
  if (textsPromise === null) {
    // 🔑 本文を集めている間は「飛んでいる依頼」(解析 worker を畳まない)。集め終えれば、検索は文書を要らない
    textsPromise = lease
      .use(async (pdf) => {
        const out = [];
        for (let i = 1; i <= total; i += 1) {
          const p = await pdf.getPage(i);
          const tc = await p.getTextContent();
          out[i] = tc.items.map((it) => (typeof it.str === 'string' ? it.str : '')).join('');
          p.cleanup();
        }
        return out;
      })
      .catch((e) => {
        // 開き直せなかった等 ── 次の検索でやり直せるように覚えない
        textsPromise = null;
        throw e;
      });
  }
  return textsPromise;
}

/**
 * 頁 `i` の文字の層へ、検索の一致を強調する。
 * 🔑 一致は**連結した本文**で取り、またがる span ごとに**その span の中の範囲**だけを `<mark>` にする
 * (`text-hits.js`)。⚠ span の字そのものは変えない(選んで引く字は同じ)。
 */
function markHits(i) {
  const L = layers[i];
  if (!L) return;
  unmarkLayer(L);
  if (hitQuery === '') return;
  for (const [k, list] of textHits.rangesBySpan(L.strs, hitQuery)) {
    const div = L.divs[k];
    const str = L.strs[k];
    div.textContent = '';
    let pos = 0;
    for (const [from, to] of list) {
      if (from > pos) div.append(str.slice(pos, from));
      const m = document.createElement('mark');
      m.className = 'hit';
      m.textContent = str.slice(from, to);
      div.append(m);
      pos = to;
    }
    if (pos < str.length) div.append(str.slice(pos));
    L.marked.add(k);
  }
}

/** 強調で作り替えた span を、元の字 1 つに戻す。 */
function unmarkLayer(L) {
  for (const k of L.marked) L.divs[k].textContent = L.strs[k];
  L.marked.clear();
}

function clearMarks() {
  for (const L of layers) if (L) unmarkLayer(L);
}

async function search(q) {
  if (!ready) return;
  clearMarks();
  hitQuery = q.trim().toLowerCase();
  hitList = [];
  hitIndex = -1;
  if (hitQuery === '') {
    $('hits').textContent = '';
    return;
  }
  $('hits').textContent = '探しています…';
  let texts;
  try {
    texts = await loadTexts();
  } catch (e) {
    // 読めていた文書を開き直せなかった(内蔵の表示へ退避する)/ もう退避済み
    $('hits').textContent = '';
    if (ready && e && e.openFailed) fallBack();
    return;
  }
  for (let i = 1; i <= total; i += 1) {
    const t = (texts[i] || '').toLowerCase();
    let at = t.indexOf(hitQuery);
    while (at !== -1 && hitList.length < 5000) {
      hitList.push(i);
      at = t.indexOf(hitQuery, at + hitQuery.length);
    }
  }
  if (hitList.length === 0) {
    $('hits').textContent = '見つかりません';
    return;
  }
  for (let i = 1; i <= total; i += 1) if (cache.has(i)) markHits(i);
  stepHit(1);
}

function stepHit(delta) {
  if (hitList.length === 0) return;
  hitIndex = (hitIndex + delta + hitList.length) % hitList.length;
  $('hits').textContent = `${String(hitIndex + 1)} / ${String(hitList.length)} 件(${String(hitList[hitIndex])} 頁)`;
  goPage(hitList[hitIndex]);
}

$('query').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const q = $('query').value;
  if (q.trim().toLowerCase() === hitQuery && hitList.length > 0) stepHit(ev.shiftKey ? -1 : 1);
  else void search(q);
});
$('hit-next').addEventListener('click', () => {
  const q = $('query').value;
  if (q.trim().toLowerCase() !== hitQuery) void search(q);
  else stepHit(1);
});
$('hit-prev').addEventListener('click', () => {
  const q = $('query').value;
  if (q.trim().toLowerCase() !== hitQuery) void search(q);
  else stepHit(-1);
});

// ───────── 字を選ぶ → ノートへ引く

/** 最後に選んだ字(`null` = 選んでいない)。 */
let lastSel = null;

document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  const text = sel === null ? '' : sel.toString();
  if (sel === null || sel.rangeCount === 0 || text.trim() === '') {
    // ボタンを押す間に選びが消える環境でも、押した結果は残す
    if (document.activeElement === quoteBtn) return;
    lastSel = null;
    quoteBtn.disabled = true;
    return;
  }
  const node = sel.getRangeAt(0).startContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  const box = el === null ? null : el.closest('[data-page]');
  if (box === null || !pagesEl.contains(box)) return;
  lastSel = { text, page: Number(box.getAttribute('data-page')) };
  quoteBtn.disabled = false;
});

quoteBtn.addEventListener('click', () => {
  if (lastSel === null) return;
  const refusal = wire.checkQuote(lastSel.text);
  if (refusal !== null) {
    setStatus(refusal);
    return;
  }
  setStatus('ノートへ引いています…');
  // 🔴 返事が来なければ、「引いています…」のまま固まらず断る(本体のリロード / 閉じ)
  clearTimer(quoteTimer);
  quoteTimer = setTimeout(() => {
    quoteTimer = null;
    setStatus(wire.QUOTE_NO_REPLY);
  }, wire.QUOTE_TIMEOUT_MS);
  send('quote', { text: lastSel.text, page: lastSel.page });
});

// ───────── 生死

send('hello', {});
// 🔴 本体が文書を渡してこなければ、「読み込んでいます…」のまま固まらず断る(窓の F5 / 本体の不在)
docTimer = setTimeout(() => {
  docTimer = null;
  if (started) return;
  state('failed');
  msgEl.textContent = wire.DOC_FAILED;
}, wire.DOC_TIMEOUT_MS);
setInterval(() => send('alive', {}), HEARTBEAT_MS);
window.addEventListener('pagehide', () => {
  send('closed', {});
  cache.clear();
  if (ownUrl !== null) URL.revokeObjectURL(ownUrl);
  if (lease !== null) lease.dispose();
});
