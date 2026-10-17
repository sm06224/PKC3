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
const { thumbWanted, pickNext, currentChange, readFraction, scrollDelta } = self.PkcPdfPageList;
const pageEdit = self.PkcPdfPageEdit;
const editStage = self.PkcPdfEditStage;
const hl = self.PkcPdfHighlight;
const nt = self.PkcPdfNotes;

/** 見えている頁の前後に、この数だけ先に描く。 */
const RADIUS = 2;
/** 同時に持つ頁の上限(縮小して一度に何十頁も見えるときの歯止め)。 */
const MAX_LIVE = 16;
const SCALE_MIN = 0.2;
const SCALE_MAX = 5;
/** 1 枚の絵の画素の上限(これを超えるなら解像度を落とす)。 */
const MAX_PIXELS = 16 * 1024 * 1024;
const HEARTBEAT_MS = 3000;
/** ページの一覧の絵の幅(CSS px)。一覧の幅(120px)に収まる小ささ。 */
const THUMB_W = 94;
/** 一覧で見えている頁の前後に、この数だけ先に描く。 */
const THUMB_RADIUS = 3;
/** ページの編集の worker を、使われないまま畳むまでの時間(ms)。保存の直前の確かめと保存の間を跨がせる。 */
const EDIT_IDLE_MS = 30000;
/** ドラッグと見なす動き(px)。これ未満は押しただけ(そのページへ移る)。 */
const DRAG_START_PX = 6;
/** 一覧の絵を同時に持つ上限(100 頁の文書でも、これを超えて持たない)。 */
const THUMB_LIVE = 40;

const token = location.hash.replace(/^#/, '');
const $ = (id) => document.getElementById(id);
const scroller = $('scroller');
const pagesEl = $('pages');
const msgEl = $('msg');
const statusEl = $('status');
const quoteBtn = $('quote');
const listEl = $('plist');
const listBtn = $('toggle-list');
const saveBtn = $('edit-save');
const resetBtn = $('edit-reset');
const extractBtn = $('extract');
const unpickBtn = $('edit-unpick');
const hlBtn = $('hl-apply');
const hlPop = $('hl-pop');
const hlPopBtn = $('hl-remove');
const editNote = $('edit-note');
const editWarn = $('edit-warn');
const editBar = $('edit-bar');
const appendBtn = $('append-pdf');
const noteBtn = $('note-tool');
const penBtn = $('pen-tool');
const nativeBtn = $('open-native');
const notePop = $('note-pop');
const noteEditBtn = $('note-edit');
const noteRemoveBtn = $('note-remove');
const noteInputWrap = $('note-input-wrap');
const noteInput = $('note-input');
const noteTip = $('note-tip');
const appendFile = $('append-file');
const appendMenu = $('append-menu');
const appendFromNote = $('append-from-note');
const appendFromFile = $('append-from-file');
const appendPick = $('append-pick');

const ch = new BroadcastChannel(wire.CHANNEL);
const send = (kind, payload) => ch.postMessage(wire.envelope(kind, token, payload));

/** 窓の下の一言を消すまでの時間(ms)。終わった知らせは、次の操作を待たずに消える(#1663)。 */
const STATUS_HIDE_MS = 5000;
let statusTimer = null;
const setStatus = (text) => {
  statusEl.textContent = text;
  statusEl.title = text;
  if (statusTimer !== null) clearTimeout(statusTimer);
  statusTimer = null;
  // 「…しています…」のような途中の一言は、終わりの一言に替わるまで出し続ける(消すのは終わった知らせだけ)
  if (text === '' || text.endsWith('…')) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    if (statusEl.textContent === text) setStatus('');
  }, STATUS_HIDE_MS);
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
/**
 * 一覧のページの総数 = 元の PDF のページ数 + 足した PDF のページ数(#275 結合)。足したページの通し番号は `total` の次から。
 * 🔑 読む面(中央)には足したページも並ぶ(元の PDF の後ろに続けて読める。足した PDF の貸し出しで描く)。
 * ⚠ 検索・ハイライト・文字の選び(引用)は元の PDF の `total` ページだけ ── 足したページは絵として読むだけ(保存して初めて文字も選べる)。
 */
let grand = 0;
/** 「変更を元に戻す」で捨てた、足した PDF のページ数(案内の分母から引く ── 戻した後に「3 / 5 ページ」と出ないように)。 */
let droppedPages = 0;
/** 足した PDF(#275 結合): `{ first, count, name, blob, lease }`。`first` = 通し番号の先頭 / `lease` = 一覧の絵を描く pdf.js の貸し出し。 */
const added = [];
let blob = null;
/** 本体が教えてくれた添付の名前(保存する PDF の名前の元)。 */
let docName = '';
let ownUrl = null;
/** 「ブラウザの表示で開く」に貸した ObjectURL(1 つ。窓を閉じるときに返す)。 */
let nativeUrl = null;
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
/** 頁 → 描いたときの viewport(ハイライトの座標を PDF ⇄ 窓で行き来する)/ 元の PDF に付いていたハイライト(`getAnnotations`)。 */
const pageVp = [];
const existing = [];
/** 頁 → 元の PDF に付いている付箋(`/Text`。ほかのアプリで付けた物も。外すために押せる印の材料)。 */
const existingNotes = [];
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
/** ページの一覧の絵の置き場。⚠ 読む頁の置き場(`cache`)とは別 ── 小さな絵が読む頁を押し出さない。 */
const thumbCache = new PageCache(THUMB_LIVE, (url) => URL.revokeObjectURL(url));

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
  else if (m.kind === 'edit-result') onEditResult(m.payload);
  else if (m.kind === 'attach-list-result') onAttachList(m.payload);
  else if (m.kind === 'attach-get-result') void onAttachGet(m.payload);
  else if (m.kind === 'quote-result') {
    clearTimer(quoteTimer);
    quoteTimer = null;
    setStatus(typeof m.payload.message === 'string' ? m.payload.message : '');
  }
};

async function onDoc(payload) {
  if (started) return;
  started = true;
  if (typeof payload.name === 'string' && payload.name !== '') {
    document.title = payload.name;
    docName = payload.name;
  }
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
    grand = total;
    droppedPages = 0;
    buildBoxes();
    buildThumbs();
    msgEl.hidden = true;
    ready = true;
    updateEditUi();
    state('ready');
    // 一覧は既定で出す(読む幅を取られたくない人は、帯のボタンで隠せる)── 幅合わせの前に出す(幅が変わるので)
    listBtn.disabled = false;
    nativeBtn.disabled = false;
    setList(true, false);
    $('pagecount').textContent = `/ ${String(grand)}`;
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
  return openBlob(blob);
}

/** Blob の PDF を pdf.js で開く(元の PDF も、足した PDF も同じ道)。 */
async function openBlob(source) {
  try {
    const lib = new URL('./lib/', import.meta.url).href;
    const data = new Uint8Array(await source.arrayBuffer());
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
  disposeAdded();
  disposeEdit();
  cache.clear();
  releaseThumbs();
  document.body.textContent = '';
  ownUrl = URL.createObjectURL(blob);
  const obj = document.createElement('object');
  obj.setAttribute('data-pkc-field', 'pdf-reader-fallback');
  obj.type = 'application/pdf';
  obj.data = ownUrl;
  // 🔴 ブラウザも PDF を出せないときに、黒い空の窓を残さない ── `<object>` の fallback 検出はブラウザ差が大きいので、
  //   中に断り文を置いてブラウザ自身に出させる(別窓 `asset-window.ts` と同じ字)
  const none = document.createElement('p');
  none.setAttribute('data-pkc-field', 'pdf-reader-fallback-note');
  none.textContent =
    'このブラウザでは PDF を表示できません。PKC3 のウィンドウに戻り、添付の「添付をダウンロード」から保存して開いてください';
  obj.append(none);
  document.body.append(obj);
  send('fell-back', {});
}

// ───────── 頁の箱と描き

function buildBoxes() {
  for (let i = 1; i <= total; i += 1) makeBox(i);
}

/** 中央の頁の箱を 1 つ作って並べる(元のページも、足したページも同じ作り)。 */
function makeBox(i) {
  const box = document.createElement('div');
  box.className = 'page';
  box.setAttribute('data-page', String(i));
  boxes[i] = box;
  pagesEl.append(box);
}

function sizeBox(i) {
  const s = sizes[i] || sizes[1];
  boxes[i].style.width = `${String(Math.floor(s.w * scale))}px`;
  boxes[i].style.height = `${String(Math.floor(s.h * scale))}px`;
}

function clearBox(i) {
  layers[i] = undefined;
  pageVp[i] = undefined;
  existing[i] = undefined;
  existingNotes[i] = undefined;
  if (boxes[i]) boxes[i].textContent = '';
}

function resizeAll() {
  for (let i = 1; i <= grand; i += 1) sizeBox(i);
}

function visibleRange() {
  const r = scroller.getBoundingClientRect();
  let first = 0;
  let last = 0;
  for (let i = 1; i <= grand; i += 1) {
    // 外した PDF の箱は畳んである(`hidden`)── 数えない
    if (boxes[i].hidden) continue;
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
  markCurrent(current);
  let want = windowOf(first, last, grand, RADIUS);
  for (const i of [...want]) if (boxes[i].hidden) want.delete(i);
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
    // 元の PDF のページは元の PDF の貸し出しで、足したページはその PDF の貸し出しで描く
    const from = i <= total ? null : addedOf(i);
    if (i > total && from === null) return;
    if (from === null) await lease.use((pdf) => drawPage(pdf, i, i, myGen, null));
    else await from.lease.use((pdf) => drawPage(pdf, i - from.first + 1, i, myGen, from));
  } catch (e) {
    // 内蔵の表示へ退避した後に落ちた依頼(貸し出しが reject した)は、黙って捨てる
    if (!ready) return;
    // 読めていた文書を、アイドルの後に開き直せなかった ── 頁が空のまま残るより、内蔵の表示で読める形にする
    if (e && e.openFailed && i <= total) {
      fallBack();
      return;
    }
    console.warn('page render failed', i, e);
    // 1 頁が描けなくても、他の頁は読める(箱は空のまま残る)
  } finally {
    if (inflight.get(i) === myGen) inflight.delete(i);
  }
}

/** @param local その PDF の中のページ番号 @param i 通し番号(箱・絵の置き場の鍵) */
async function drawPage(pdf, local, i, myGen, owner) {
  const page = await pdf.getPage(local);
  // 描いている間に、その PDF が外された(通し番号は別の PDF に使い回される)── 置かない
  if (myGen !== gen || addedOf(i) !== owner) return;
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
  // 元の PDF に付いているハイライト(外すために押せる印を重ねる材料)。絵には焼き込まれている
  const annots = i > total ? [] : await loadHighlights(page);
  const noteAnnots = i > total ? [] : await loadNotes(page);
  const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  // 🔑 焼いたら canvas は即手放す(絵は PNG の `<img>` が持つ)
  canvas.width = 0;
  canvas.height = 0;
  if (png === null) return;
  const url = URL.createObjectURL(png);
  if (myGen !== gen || !wanted.has(i) || !boxes[i] || addedOf(i) !== owner) {
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
  img.alt = pageName(i);
  img.src = url;
  box.append(img);
  // 足したページは絵として読むだけ(文字の選び・検索・ハイライトは元の PDF の分だけ)
  if (i > total) {
    page.cleanup();
    return;
  }
  pageVp[i] = vp;
  existing[i] = annots;
  existingNotes[i] = noteAnnots;
  paintMarks(i);
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  box.append(layer);
  try {
    // 🔑 行末(`hasEOL`)を span の並びと同じ数え方で控える(検索の一致が、行をまたぐ語を拾い、強調がずれない)
    const eols = [];
    const source = page.streamTextContent().pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          for (const it of chunk.items) if (it.str !== undefined) eols.push(it.hasEOL === true);
          controller.enqueue(chunk);
        },
      }),
    );
    const tl = new pdfjs.TextLayer({
      textContentSource: source,
      container: layer,
      viewport: vp,
    });
    await tl.render();
    // 🔑 span ごとの字を持っておく(検索の強調が、またがる一致を span ごとの範囲へ割り付ける)。
    //    ⚠ 描いている間に箱が作り直された(拡大縮小 / 外れた)なら、持たない
    if (layer.isConnected) {
      // ⚠ 数が合わないときは行末を使わない(ずれた行末で別の span を光らせるより、連結のままのほうがよい)
      const strs = tl.textContentItemsStr;
      layers[i] = { divs: tl.textDivs, strs, eols: eols.length === strs.length ? eols : undefined, marked: new Set() };
      markHits(i);
    }
  } catch {
    // 字の層だけ落ちても絵は読める(選べないだけ)
  }
  page.cleanup();
}

// ───────── ページの一覧(#275 段②-1a)と、ページの編集(段②-1b)

/** 頁 → 一覧の 1 項目(ボタン) / 絵の入れ物 / 行(ボタンと ↻ × を束ねる) / 位置の番号。 */
const thumbItems = [];
const thumbHolders = [];
const thumbCells = [];
const thumbNos = [];
/** 各ページの「選ぶ」チェック(#1626。Ctrl / Shift を押せない端末でも選べる)。 */
const thumbPicks = [];
/** 頁 → 回した角度(0 / 90 / 180 / 270)。一覧の絵はこの角度で描く(読む頁は元のまま)。 */
const thumbRot = [];
/** 頁 → 元の向きでの縦横比(高さ / 幅)。まだ描いていない頁は 1 頁目を借りる。 */
const pageRatio = [];
/** いまの並び(`page-edit.js`)。一覧の見せ方と、保存で作る PDF の元。 */
let items = [];
/**
 * 🔴 **基準の並び** = 最後に保存した並び(まだ保存していなければ元のまま)。「まだ保存していない変更」は
 * これとの違いで見る ── 保存した後も保存ボタンを出し続けると、押し直すたびに同じ PDF の添付が増える。
 */
let baseline = [];
/** 保存を送った並び(返事が来るまでの控え。時間切れの後に遅れて成功の返事が来たとき、基準にする)。 */
/**
 * 送った依頼の控え `{ key, kind, baseline }`(`null` = 送っていない)。`key` = 棚に置いた物の鍵で、本体の返事(`edit-result`)が
 * 同じ鍵を持って返る。🔴 **鍵が合う返事だけ**を受ける ── 時間切れの後に遅れて来た前の依頼の返事で、今の依頼の控え
 * (保存か抜き出しか)・基準・選びを動かさない。`kind` = 'save'(別の PDF として保存)/ 'extract'(選んだページを別の PDF に)、
 * `baseline` = 保存した並び(保存のときだけ)。
 */
let pending = null;
/** 選んだページ(元のページ番号。#275 段②-1c)と、Shift+クリックの起点。 */
let selected = new Set();
let selAnchor = 0;
/** 頁 → 並びの中の位置(1 始まり)。0 = 外してある。 */
const posByPage = [];
/** 一覧の枠の中に見えている頁(IntersectionObserver が教える)。 */
const thumbVisible = new Set();
let thumbWantedSet = new Set();
/** 描きたい頁を**並びの位置**で持つ(並べ替えると、頁番号の近さは見えている近さと別になる)。 */
let thumbWantedPos = new Set();
/** 一覧の中央の**位置**。 */
let thumbCenter = 1;
let thumbObserver = null;
let thumbDraining = false;
/** 描けなかった頁(同じ頁を描き直し続けない。一覧を隠すと忘れる)。 */
const thumbFailed = new Set();
let listOn = false;
/** いま光らせている頁(0 = どこも光らせていない)。 */
let marked = 0;
/** Tab で止まる項目(`tabindex=0` は 1 つだけ)。 */
let tabStop = 1;

/** 一覧の絵の入れ物の高さ。回してあれば縦横を入れ替える。 */
function holderHeight(i) {
  const r = pageRatio[i] || sizes[1].h / sizes[1].w;
  return Math.round(THUMB_W * (thumbRot[i] % 180 === 0 ? r : 1 / r));
}

function buildThumbs() {
  items = pageEdit.fresh(total);
  baseline = items.slice();
  for (let i = 1; i <= total; i += 1) makeThumbCell(i);
  // 編集の上のバーは「変えていない」で始める(印も `off` で置く ── 窓の外から読める)
  updateEditUi();
}

/** 通し番号 `i` のページの呼び名(読み上げの字)。足したページは、どの PDF の何ページ目かを言う。 */
function pageName(i) {
  if (i <= total) return `${String(i)} ページ`;
  const a = addedOf(i);
  return a === null ? `${String(i)} ページ` : `「${a.name}」の ${String(i - a.first + 1)} ページ`;
}

/** 一覧の 1 項目(絵 + ↻ × ↑ ↓)を作って一覧に置く。元のページも足したページも同じ作り。 */
function makeThumbCell(i) {
  const name = pageName(i);
  thumbRot[i] = 0;
  posByPage[i] = i;
  const cell = document.createElement('div');
  cell.className = 'thumb-cell';
  cell.setAttribute('data-thumb-cell', String(i));
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'thumb';
  item.setAttribute('data-pkc-field', 'pdf-page-thumb');
  item.setAttribute('data-thumb', String(i));
  // 🔑 Tab の止まり先は 1 つ(いまの頁)。項目の間は矢印で動く(`listEl` の keydown)
  item.tabIndex = i === 1 ? 0 : -1;
  const holder = document.createElement('span');
  holder.className = 'thumb-img';
  holder.style.height = `${String(holderHeight(i))}px`;
  const no = document.createElement('span');
  no.className = 'thumb-no';
  no.textContent = String(i);
  item.append(holder, no);
  // 足したページは、どの PDF から来たかを絵の下に小さく言う(元のページは何も足さない)
  const from = i > total ? addedOf(i) : null;
  if (from !== null) {
    const src = document.createElement('span');
    src.className = 'thumb-src';
    src.setAttribute('data-pkc-field', 'pdf-page-source');
    src.textContent = from.name;
    src.title = from.name;
    item.append(src);
  }
  // ↻(右へ 90° 回す)と ×(このページを外す)。Tab の止まり先にしない(キーは項目で R / Delete)
  const turn = document.createElement('button');
  turn.type = 'button';
  turn.className = 'thumb-act thumb-turn';
  turn.setAttribute('data-pkc-field', 'pdf-page-rotate');
  turn.setAttribute('data-thumb-page', String(i));
  turn.setAttribute('aria-label', `${name}を右へ回す`);
  turn.title = '右へ 90° 回す';
  turn.tabIndex = -1;
  turn.textContent = '↻';
  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'thumb-act thumb-drop';
  drop.setAttribute('data-pkc-field', 'pdf-page-remove');
  drop.setAttribute('data-thumb-page', String(i));
  drop.setAttribute('aria-label', `${name}を外す`);
  drop.title = 'このページを外す';
  drop.tabIndex = -1;
  drop.textContent = '×';
  // ↑ ↓(ドラッグできない端末でも並べ替えられる)。Tab の止まり先にしない(キーは項目で Alt+↑↓)
  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'thumb-act thumb-up';
  up.setAttribute('data-pkc-field', 'pdf-page-up');
  up.setAttribute('data-thumb-page', String(i));
  up.setAttribute('aria-label', `${name}を 1 つ上へ`);
  up.title = '1 つ上へ';
  up.tabIndex = -1;
  up.textContent = '↑';
  const down = document.createElement('button');
  down.type = 'button';
  down.className = 'thumb-act thumb-down';
  down.setAttribute('data-pkc-field', 'pdf-page-down');
  down.setAttribute('data-thumb-page', String(i));
  down.setAttribute('aria-label', `${name}を 1 つ下へ`);
  down.title = '1 つ下へ';
  down.tabIndex = -1;
  down.textContent = '↓';
  // 選ぶチェック(#1626)。Ctrl / ⌘ / Shift +クリックと同じ「選びを切り替える」を、押すだけの 1 つにする(キーを押せない端末向け)
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'thumb-act thumb-pick';
  pick.setAttribute('data-pkc-field', 'pdf-page-pick');
  pick.setAttribute('data-thumb-page', String(i));
  pick.setAttribute('aria-label', `${name}を選ぶ`);
  pick.setAttribute('aria-pressed', 'false');
  pick.title = '抜き出すページに選ぶ / 選びを外す';
  pick.tabIndex = -1;
  pick.textContent = '☐';
  cell.append(item, turn, drop, up, down, pick);
  thumbPicks[i] = pick;
  thumbItems[i] = item;
  thumbHolders[i] = holder;
  thumbCells[i] = cell;
  thumbNos[i] = no;
  paintThumbLabel(i);
  listEl.append(cell);
}

function clearThumb(i) {
  if (thumbHolders[i]) thumbHolders[i].textContent = '';
}

/** 絵を全部返して、見張りも止める(隠したとき / 窓を閉じるとき / 内蔵の表示へ退避するとき)。 */
function releaseThumbs() {
  if (thumbObserver !== null) {
    thumbObserver.disconnect();
    thumbObserver = null;
  }
  thumbVisible.clear();
  thumbWantedSet = new Set();
  thumbWantedPos = new Set();
  thumbFailed.clear();
  for (const i of thumbCache.map.keys()) clearThumb(i);
  thumbCache.clear();
}

function watchThumbs() {
  if (typeof IntersectionObserver !== 'function') {
    // 見張りが無い環境: 先頭の数枚だけ描く(全部は描かない)
    for (let i = 1; i <= Math.min(grand, 8); i += 1) thumbVisible.add(i);
    scheduleThumbs();
    return;
  }
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const n = Number(e.target.getAttribute('data-thumb'));
        if (e.isIntersecting) thumbVisible.add(n);
        else thumbVisible.delete(n);
      }
      if (thumbVisible.size > 0) {
        // 位置で数える(並べ替えた後は、頁番号の真ん中と見えている真ん中が別になる)
        const all = [...thumbVisible].map((p) => posByPage[p]).filter((k) => k > 0);
        if (all.length > 0) thumbCenter = Math.round((Math.min(...all) + Math.max(...all)) / 2);
      }
      scheduleThumbs();
    },
    { root: listEl, rootMargin: '120px 0px' },
  );
  for (let i = 1; i <= grand; i += 1) thumbObserver.observe(thumbItems[i]);
}

function scheduleThumbs() {
  if (!listOn || !ready) return;
  const visiblePos = new Set();
  thumbVisible.forEach((p) => {
    if (posByPage[p] > 0) visiblePos.add(posByPage[p]);
  });
  thumbWantedPos = thumbWanted(visiblePos, items.length, THUMB_RADIUS, THUMB_LIVE, thumbCenter);
  thumbWantedSet = new Set([...thumbWantedPos].map((k) => items[k - 1].page));
  for (const i of thumbCache.retain(thumbWantedSet)) clearThumb(i);
  void drainThumbs();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 描く頁を 1 枚ずつ(読む頁の描きを先にして、その合間に)。 */
async function drainThumbs() {
  if (thumbDraining) return;
  thumbDraining = true;
  try {
    for (;;) {
      if (!listOn || !ready) break;
      // 読んでいる頁の描きが先 ── 終わるまで待つ
      if (inflight.size > 0) {
        await sleep(60);
        continue;
      }
      const at = pickNext(
        thumbWantedPos,
        (k) => thumbCache.has(items[k - 1].page) || thumbFailed.has(items[k - 1].page),
        thumbCenter,
      );
      if (at === null) break;
      const i = items[at - 1].page;
      // 元の PDF のページは元の PDF の貸し出しで、足したページはその PDF の貸し出しで描く
      const from = i <= total ? null : addedOf(i);
      if (i > total && from === null) {
        // 外した PDF のページ(貸し出しは返してある)── 描かない
        thumbFailed.add(i);
        continue;
      }
      try {
        if (from === null) await lease.use((pdf) => drawThumb(pdf, i, i, null));
        else await from.lease.use((pdf) => drawThumb(pdf, i - from.first + 1, i, from));
      } catch (e) {
        // 描いている間に、その PDF が外された(通し番号は別の PDF に使い回される)── 失敗に数えない
        if (i > total && addedOf(i) !== from) continue;
        thumbFailed.add(i);
        if (!ready) break;
        // 元の PDF を開き直せないときだけ内蔵の表示へ。足した PDF が開けないのは、その PDF のページの絵が出ないだけ
        if (e && e.openFailed && from === null) {
          fallBack();
          break;
        }
      }
      // 🔑 1 枚ごとにメインスレッドを返す(入力と描画を止めない)
      await sleep(0);
    }
  } finally {
    thumbDraining = false;
  }
}

/** @param local その PDF の中のページ番号 @param i 通し番号(一覧の状態の鍵) @param owner 描く PDF(元の PDF = null) */
async function drawThumb(pdf, local, i, owner) {
  const page = await pdf.getPage(local);
  try {
    if (!listOn || !thumbWantedSet.has(i) || addedOf(i) !== owner) return;
    // 🔑 回してあるページは、その向きで描く(一覧の絵が、保存で作る PDF の向きと同じになる)
    const turn = thumbRot[i];
    const native = page.getViewport({ scale: 1 });
    pageRatio[i] = native.height / native.width;
    const rotation = (page.rotate + turn) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: (THUMB_W * dpr) / base.width, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    await page.render({ canvas, viewport: vp }).promise;
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    // 🔑 焼いたら canvas は即手放す(絵は PNG の `<img>` が持つ)
    canvas.width = 0;
    canvas.height = 0;
    // 🔴 絵にできなかった頁は**失敗として投げる**(呼び側が `thumbFailed` に覚える)── 黙って返すと、
    //    持ってもいない・失敗にも数えない頁が「次に描く頁」に選ばれ続け、描き直しが止まらない
    if (png === null) throw new Error('thumb toBlob failed');
    const url = URL.createObjectURL(png);
    // 描いている間に回された絵は置かない(古い向き)── 次の周回で描き直される
    if (!listOn || !thumbWantedSet.has(i) || thumbRot[i] !== turn || addedOf(i) !== owner) {
      URL.revokeObjectURL(url);
      return;
    }
    for (const e of thumbCache.put(i, url)) clearThumb(e);
    const holder = thumbHolders[i];
    holder.textContent = '';
    holder.style.height = `${String(holderHeight(i))}px`;
    const img = document.createElement('img');
    img.setAttribute('data-pkc-field', 'pdf-page-thumb-image');
    img.alt = '';
    img.src = url;
    holder.append(img);
  } finally {
    page.cleanup();
  }
}

/** Tab の止まり先を `n` の項目だけにする(roving tabindex)。 */
function setTabStop(n) {
  if (tabStop >= 1 && tabStop !== n) thumbItems[tabStop].tabIndex = -1;
  thumbItems[n].tabIndex = 0;
  tabStop = n;
}

/** いまの頁の項目を光らせる(`aria-current`。見た目は host.html の `.thumb[aria-current]`)。 */
function markCurrent(n) {
  const ch = currentChange(marked, n, grand);
  if (ch === null) return;
  if (ch.off !== null) thumbItems[ch.off].removeAttribute('aria-current');
  thumbItems[ch.on].setAttribute('aria-current', 'true');
  marked = ch.on;
  // 一覧の中で操作している最中は、Tab の止まり先を奪わない
  if (!listEl.contains(document.activeElement)) setTabStop(ch.on);
  // 読み進めて光る頁が一覧の外へ出たら、最小限だけ動かして見えるところに置く
  if (listOn) thumbItems[ch.on].scrollIntoView({ block: 'nearest' });
}

/**
 * 一覧を出す / 隠す。出し入れで読む幅が変わるので、「幅に合わせる」の最中なら合わせ直す。
 * @param {boolean} on
 * @param {boolean} refit  幅を合わせ直すか(最初の 1 回は、この後すぐ合わせるので false)
 */
function setList(on, refit) {
  listOn = on;
  document.body.setAttribute('data-pkc-pdf-list', on ? 'on' : 'off');
  listBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (on) {
    watchThumbs();
    thumbItems[current].scrollIntoView({ block: 'center' });
  } else {
    releaseThumbs();
  }
  if (refit && fitMode && total >= 1) fitWidth();
}

listBtn.addEventListener('click', () => {
  if (ready) setList(!listOn, true);
});
// 矢印 / Home / End で項目の間を動く(Enter / Space は項目のボタンが押されて、その頁へ移る)。
// 🔑 動く順は**いまの並び**(並べ替えた後は、見えている順)。Alt+↑↓ は並べ替え、R は回す、Delete は外す
// (ドラッグと同じ関数 `editMove` / `editRotate` / `editRemove` を通る)。
listEl.addEventListener('keydown', (ev) => {
  const el = ev.target instanceof Element ? ev.target.closest('[data-thumb]') : null;
  if (el === null) return;
  const page = Number(el.getAttribute('data-thumb'));
  const at = posByPage[page] - 1;
  if (at < 0) return;
  const plain = !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey;
  if (ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
    ev.preventDefault();
    void editMove(page, at + (ev.key === 'ArrowUp' ? -1 : 1), true);
    return;
  }
  if (plain && (ev.key === 'r' || ev.key === 'R')) {
    ev.preventDefault();
    void editRotate(page, true);
    return;
  }
  if (plain && ev.key === 'Delete') {
    ev.preventDefault();
    void editRemove(page, true);
    return;
  }
  // 選ぶ(#275 段②-1c): Ctrl/⌘+Space = このページの選びを切り替える / Ctrl/⌘+A = 全部 / Shift+↑↓ = 範囲を広げる / Esc = 外す
  const mod = (ev.ctrlKey || ev.metaKey) && !ev.altKey;
  if (mod && !ev.shiftKey && ev.key === ' ') {
    ev.preventDefault();
    keyPickedAt = Date.now();
    void pickToggle(page);
    return;
  }
  if (mod && !ev.shiftKey && (ev.key === 'a' || ev.key === 'A')) {
    ev.preventDefault();
    void pickAll();
    return;
  }
  if (ev.key === 'Escape' && plain && selected.size > 0) {
    ev.preventDefault();
    pickClear();
    return;
  }
  if (ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
    const toPos = Math.max(0, Math.min(items.length - 1, at + (ev.key === 'ArrowDown' ? 1 : -1)));
    ev.preventDefault();
    void pickRange(page, items[toPos].page, true);
    return;
  }
  let to = at;
  if (ev.key === 'ArrowDown') to = at + 1;
  else if (ev.key === 'ArrowUp') to = at - 1;
  else if (ev.key === 'Home') to = 0;
  else if (ev.key === 'End') to = items.length - 1;
  else return;
  ev.preventDefault();
  to = Math.max(0, Math.min(items.length - 1, to));
  const next = items[to].page;
  setTabStop(next);
  thumbItems[next].focus();
});
// Ctrl/⌘+Space を離したときにボタンの「押した」が続けて来ないようにする(来ると選びが 2 度切り替わる)
listEl.addEventListener('keyup', (ev) => {
  if (ev.key === ' ' && (ev.ctrlKey || ev.metaKey)) ev.preventDefault();
});
listEl.addEventListener('click', (ev) => {
  // ドラッグを離した直後のクリックは、押したことにしない
  if (Date.now() - dragEndedAt < 80) return;
  // キーで選びを切り替えた直後に、同じキーから来る「押した」は数えない(マウスの押下は `detail` が 1 以上)
  if (ev.detail === 0 && Date.now() - keyPickedAt < 500) return;
  const t = ev.target instanceof Element ? ev.target : null;
  if (t === null) return;
  const rm = t.closest('[data-pkc-field="pdf-source-remove"]');
  if (rm !== null) {
    removeSourceOf(addedByFirst(Number(rm.getAttribute('data-source-first'))));
    return;
  }
  const gh = t.closest('[data-pkc-field="pdf-page-restore"]');
  if (gh !== null) {
    void editRestore(Number(gh.getAttribute('data-thumb-restore')));
    return;
  }
  const act = t.closest('.thumb-act');
  if (act !== null) {
    const which = Number(act.getAttribute('data-thumb-page'));
    const field = act.getAttribute('data-pkc-field');
    if (field === 'pdf-page-rotate') void editRotate(which, true);
    else if (field === 'pdf-page-up') void editMove(which, posByPage[which] - 2, true);
    else if (field === 'pdf-page-down') void editMove(which, posByPage[which], true);
    else if (field === 'pdf-page-pick') void pickToggle(which);
    else void editRemove(which, true);
    return;
  }
  const el = t.closest('[data-thumb]');
  if (el === null) return;
  const n = Number(el.getAttribute('data-thumb'));
  setTabStop(n);
  // 🔑 Ctrl/⌘+クリック = 選びを切り替える / Shift+クリック = 起点から範囲を選ぶ(どちらもそのページへは移らない)。
  //    ふつうのクリックはこれまでどおりそのページへ移るだけで、選びは動かさない(読みながら選べる)
  if (ev.ctrlKey || ev.metaKey) {
    void pickToggle(n);
    return;
  }
  if (ev.shiftKey) {
    void pickRange(selAnchor >= 1 && posByPage[selAnchor] > 0 ? selAnchor : n, n, false);
    return;
  }
  goPage(n);
});
// 一覧から出たら、Tab の止まり先をいまの頁へ戻す(操作の最中は動かさなかった分)
listEl.addEventListener('focusout', (ev) => {
  if (!(ev.relatedTarget instanceof Node) || !listEl.contains(ev.relatedTarget)) {
    if (marked >= 1) setTabStop(marked);
  }
});

// ───────── ページの編集(#275 段②-1b)── 並べ替え・回す・外す → 「別の PDF として保存」
//
// 🔴 画面で触るのは**並びの計画**(`items`、`page-edit.js`)だけで、読む頁(中央)は元の PDF のまま動かさない。
// 保存を押したときだけ、窓の中の使い捨ての worker(`edit-worker.js`)が**新しい PDF**を作り、
// OPFS の棚へ置いて本体へ知らせる(本体が新しい添付にする)。元の PDF は書き換えない。
// 設計 doc: `docs/development/pdf-page-ops-design-2026-10.md`。

/** 元の PDF にある、保存で引き継がれない物(最初の編集のときに pdf.js に尋ねる)。 */
let editInfo = { outlines: false, form: false, signature: false };
/** 編集できる形かの答え(最初の編集のとき 1 回だけ確かめる)。'ok' / 'encrypted' / 'unreadable' */
let editVerdict = null;
let editLease = null;
let saving = false;
let editTimer = null;
let dragEndedAt = 0;
let keyPickedAt = 0;

const PREPARING = 'ページの編集を準備しています…';
const SAVED_NOTE = '保存しました。PKC3 のウィンドウの下の知らせで「そのノートを開く」を押すと新しい PDF が開きます';
const EXTRACTED_NOTE = '選んだページを新しい PDF にしました。PKC3 のウィンドウの下の知らせで「そのノートを開く」を押すと開きます';
const EDIT_MESSAGES = {
  encrypted: 'パスワードで守られた PDF は、編集できません(読むことはできます)',
  unreadable: 'この PDF はページを編集できない形です',
  worker: 'ページの編集を始められませんでした。もう一度試してください',
  leaked: '外したページ・選ばなかったページの内容を含めずには作れませんでした。保存していません',
  'bad-highlight': '外そうとしたハイライトが PDF の中に見つかりませんでした。保存していません',
};

function codeError(code) {
  const e = new Error(`pdf-edit: ${code}`);
  e.pkcCode = code;
  return e;
}

/**
 * ページ編集用の worker を 1 本立てる(`DocLease` が握る)。
 * 🔴 畳むときに**待っている依頼を必ず reject する**(`kill`)── 捨てると `await` が永久に返らない。
 * ⚠ bytes は transfer で渡し、結果も transfer で受ける(複製しない)。
 */
function openEditWorker() {
  const worker = new Worker(new URL('./edit-worker.js', import.meta.url));
  const pending = new Map();
  let seq = 0;
  let dead = false;
  const kill = (code) => {
    if (dead) return;
    dead = true;
    worker.terminate();
    for (const p of pending.values()) p.reject(codeError(code));
    pending.clear();
  };
  worker.onmessage = (ev) => {
    const m = ev.data;
    const p = pending.get(m.id);
    if (p === undefined) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m);
    else p.reject(codeError(m.code));
  };
  worker.onerror = () => kill('worker');
  return {
    kill,
    call(msg, transfer) {
      return new Promise((resolve, reject) => {
        if (dead) {
          reject(codeError('worker'));
          return;
        }
        seq += 1;
        pending.set(seq, { resolve, reject });
        worker.postMessage({ ...msg, id: seq }, transfer);
      });
    },
  };
}

/**
 * worker へ 1 件頼む。bytes は Blob から**この都度**読み、worker へ渡して手放す(transfer = 複製しない)。
 * @param opts.blob  読む PDF(省略時は元の PDF)── 足す PDF を確かめるとき(`check`)に差す
 * @param opts.extras  後ろに足す PDF の Blob(`build` のとき。`job.sources` と同じ数・順)
 */
async function callEdit(op, job, opts) {
  if (editLease === null) {
    editLease = new DocLease({ open: openEditWorker, close: (h) => h.kill('closed'), idleMs: EDIT_IDLE_MS });
  }
  const mine = editLease;
  const buf = await (opts && opts.blob ? opts.blob : blob).arrayBuffer();
  const extras = await Promise.all(((opts && opts.extras) || []).map((b) => b.arrayBuffer()));
  try {
    return await mine.use((h) => h.call({ op, bytes: buf, job, extras }, [buf, ...extras]));
  } catch (e) {
    const code = e && e.pkcCode;
    if (
      code !== 'encrypted' &&
      code !== 'unreadable' &&
      code !== 'bad-job' &&
      code !== 'leaked' &&
      code !== 'bad-highlight'
    ) {
      // 立ち上がらなかった / 落ちた worker は握り直す(死んだものを貸し続けない)
      mine.dispose();
      if (editLease === mine) editLease = null;
      throw codeError('worker');
    }
    throw e;
  }
}

function disposeEdit() {
  clearTimer(editTimer);
  editTimer = null;
  if (editLease !== null) editLease.dispose();
  editLease = null;
}

/**
 * 元の PDF にあるもの(しおり / 入力欄 / 電子署名)を pdf.js に尋ねる。
 * ⚠ パスワード(暗号化)はここで尋ねない ── pdf-lib が読み込みの前に断る(`edit-core.js`)のが唯一の判定で、
 *   二重に持つと、片方だけが古くなる(§7)。
 */
async function inspectDoc(doc) {
  const out = { outlines: false, form: false, signature: false };
  try {
    const o = await doc.getOutline();
    out.outlines = Array.isArray(o) && o.length > 0;
  } catch {
    // 尋ねられなくても編集は止めない(言わない字が増えるだけ)
  }
  try {
    const f = await doc.getFieldObjects();
    if (f !== null && typeof f === 'object') {
      const fields = Object.values(f).flat();
      out.signature = fields.some((x) => x && x.type === 'signature');
      out.form = fields.some((x) => x && x.type !== 'signature');
    }
  } catch {
    // 尋ねられなくても編集は止めない(言わない字が増えるだけ)
  }
  return out;
}

/** 編集できる形かを確かめる。@returns 'ok' / 'encrypted' / 'unreadable' / 'worker' */
async function checkEditable() {
  try {
    const info = await lease.use(inspectDoc);
    editInfo = info;
  } catch (e) {
    if (ready && e && e.openFailed) fallBack();
    return 'worker';
  }
  try {
    await callEdit('check');
    return 'ok';
  } catch (e) {
    const code = e && e.pkcCode;
    return code === 'encrypted' || code === 'unreadable' ? code : 'worker';
  }
}

/** 編集してよいか(最初の 1 回だけ確かめ、答えを使い回す)。@returns `true` / 断ったら理由を窓の下に出して `false` */
async function canEdit() {
  if (!ready || saving) return false;
  if (editVerdict === null) {
    setStatus(PREPARING);
    const v = await checkEditable();
    // 立ち上がらなかった回は覚えない(次の操作でもう一度試す)
    if (v !== 'worker') editVerdict = v;
    if (!ready) return false;
    if (v === 'ok') {
      if (statusEl.textContent === PREPARING) setStatus('');
      return true;
    }
    setStatus(EDIT_MESSAGES[v]);
    return false;
  }
  if (editVerdict === 'ok') return true;
  setStatus(EDIT_MESSAGES[editVerdict]);
  return false;
}

/** 項目の読み上げの字(並びの位置と、選んでいるかを言う)。 */
function paintThumbLabel(p) {
  const k = posByPage[p];
  const name = pageName(p);
  let label = k === p || k === 0 ? `${name}へ` : `${name}へ(いま ${String(k)} 番目)`;
  if (selected.has(p)) label += '(選択中)';
  thumbItems[p].setAttribute('aria-label', label);
}

/** 並びを画面に映す: 行の順・外した行の隠し・位置の番号・回した絵の描き直し・上のバー。 */
function applyItems(focusPage) {
  posByPage.fill(0);
  items.forEach((it, k) => {
    posByPage[it.page] = k + 1;
  });
  // 外したページは選びから落ちる(外した後に「選んだページ」へ入っていると、user が思っていない物を抜き出す)
  selected = pageEdit.pruneSel(selected, items);
  const frag = document.createDocumentFragment();
  // 足した PDF の見出し: 前の置き場から外し、いまの並びで先に出るページの前へ置き直す
  for (const a of added) if (a.headEl) a.headEl.remove();
  const headAt = new Map(pageEdit.sourceHeadings(items, added).map((h) => [h.page, h.k]));
  items.forEach((it, k) => {
    const p = it.page;
    thumbCells[p].hidden = false;
    const head = headAt.get(p);
    if (head !== undefined) frag.append(headingOf(added[head]));
    frag.append(thumbCells[p]);
    thumbNos[p].textContent = pageEdit.thumbNoText(p, k + 1, total);
    paintSelected(p);
    paintThumbLabel(p);
    if (thumbRot[p] !== it.rot) {
      // 回した(または元に戻した)ページは、新しい向きで描き直す
      thumbRot[p] = it.rot;
      clearThumb(p);
      thumbCache.drop(p);
      thumbFailed.delete(p);
      thumbHolders[p].style.height = `${String(holderHeight(p))}px`;
    }
  });
  for (let p = 1; p <= grand; p += 1) {
    if (posByPage[p] > 0) continue;
    thumbCells[p].hidden = true;
    thumbCells[p].removeAttribute('data-pkc-selected');
    if (thumbPicks[p]) {
      thumbPicks[p].textContent = '☐';
      thumbPicks[p].setAttribute('aria-pressed', 'false');
    }
    thumbVisible.delete(p);
    frag.append(thumbCells[p]);
  }
  // 並べ替えで要素を動かすと焦点が外れる ── 動かしたページへ戻す
  listEl.append(frag);
  renderRemoved();
  if (items.length > 0) {
    if (focusPage !== undefined && posByPage[focusPage] > 0) {
      setTabStop(focusPage);
      thumbItems[focusPage].focus();
    } else if (!(posByPage[tabStop] > 0)) {
      setTabStop(posByPage[marked] > 0 ? marked : items[0].page);
    }
  }
  updateEditUi();
  scheduleThumbs();
}

/** 外したページの置き場(一覧の最後。薄い枠のページごとに「戻す」)。`applyItems` が毎回作り直す。 */
let removedEl = null;
function renderRemoved() {
  if (removedEl === null) {
    removedEl = document.createElement('div');
    removedEl.className = 'removed-list';
    removedEl.setAttribute('data-pkc-field', 'pdf-removed-list');
  }
  // 足したのを取り消した PDF のページは、もう無いので戻せない(数えない)
  const gone = pageEdit.removedPages(items, grand, (p) => p <= total || addedOf(p) !== null);
  removedEl.textContent = '';
  removedEl.hidden = gone.length === 0;
  if (gone.length > 0) {
    const head = document.createElement('div');
    head.className = 'removed-head';
    head.textContent = '外したページ';
    removedEl.append(head);
    for (const p of gone) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'thumb-ghost';
      b.setAttribute('data-pkc-field', 'pdf-page-restore');
      b.setAttribute('data-thumb-restore', String(p));
      b.setAttribute('aria-label', `${pageName(p)}を戻す`);
      b.title = 'このページを元の並びに戻す';
      const no = document.createElement('span');
      no.textContent = String(p);
      const act = document.createElement('span');
      act.className = 'thumb-ghost-act';
      act.textContent = '戻す';
      b.append(no, act);
      removedEl.append(b);
    }
  }
  listEl.append(removedEl);
}

/** 外したページを 1 ページだけ戻す(「変更を元に戻す」と違い、注釈やほかの編集は残る)。 */
async function editRestore(page) {
  if (!(await canEdit())) return;
  if (posByPage[page] > 0 || !thumbCells[page]) return;
  items = pageEdit.restorePage(items, page);
  applyItems(page);
}

/** まだ保存していない変更があるか(基準 = 最後に保存した並びと、最後に保存したハイライト)。 */
function isDirty() {
  return !pageEdit.sameArrangement(items, baseline) || isHlDirty();
}

/** 上のバーと、窓の上の案内(編集中の 1 行 + 引き継がれない物の行)。 */
function updateEditUi() {
  const arrangeDirty = !pageEdit.sameArrangement(items, baseline);
  const dirty = isDirty();
  const picked = pageEdit.pickSelected(items, selected).length;
  const showBar = dirty || picked > 0;
  document.body.setAttribute('data-pkc-pdf-edited', showBar ? 'on' : 'off');
  saveBtn.hidden = !dirty;
  editBar.hidden = !showBar;
  saveBtn.disabled = !dirty || !pageEdit.canSave(items) || saving;
  // 🔴 選んだページが 0 件では押せない(0 ページの PDF は作らない)
  extractBtn.disabled = !ready || saving || !pageEdit.canExtract(items, selected);
  appendBtn.disabled = !ready || saving;
  noteBtn.disabled = !ready || saving;
  penBtn.disabled = !ready || saving;
  resetBtn.hidden = !dirty;
  resetBtn.disabled = saving;
  unpickBtn.hidden = picked < 1;
  unpickBtn.disabled = saving;
  const notes = [];
  if (arrangeDirty) notes.push(pageEdit.noteLine(items.length, grand - droppedPages));
  if (isMarkDirty()) {
    const c = hlCounts();
    notes.push(hl.note(c.added, c.removed, !arrangeDirty && !isAnnDirty()));
  }
  if (isAnnDirty()) {
    const c = annCounts();
    notes.push(nt.note(c.notes, c.strokes, !arrangeDirty));
  }
  if (picked > 0) notes.push(pageEdit.pickNote(picked));
  editNote.textContent = notes.join(' ');
  // 引き継がれない物の行は、元にあるものがあるときだけ(無ければ行ごと出さない)。
  // 保存する・抜き出すのどちらでも同じ(新しい文書へ写す道は同じ ── 設計 doc §2)
  const warn = (dirty && items.length > 0) || picked > 0 ? pageEdit.warnLine(editInfo) : '';
  editWarn.textContent = warn;
  editWarn.hidden = warn === '';
  syncBarHeight();
}

/** 案内の高さを測って、下の面(一覧 / 読む面 / 案内)の top を合わせる ── 折り返しても重ならない。 */
function syncBarHeight() {
  document.body.style.setProperty('--edit-bar-h', `${String(editBar.hidden ? 0 : editBar.offsetHeight)}px`);
}
if (typeof ResizeObserver === 'function') new ResizeObserver(syncBarHeight).observe(editBar);

/** 上の帯の高さを測って、下の面の top を合わせる(帯が 2 行に折り返しても、読む面に重ならない)。 */
function syncTopBar() {
  const h = $('bar').offsetHeight;
  if (h > 0) document.body.style.setProperty('--bar-h', `${String(h)}px`);
}
if (typeof ResizeObserver === 'function') new ResizeObserver(syncTopBar).observe($('bar'));

/** ↻ ── 右へ 90° 回す。 */
async function editRotate(page, focus) {
  if (!(await canEdit())) return;
  const at = posByPage[page] - 1;
  if (at < 0) return;
  items = pageEdit.rotateAt(items, at);
  applyItems(focus ? page : undefined);
}

/** × ── このページを外す。焦点は同じ位置の次のページへ。 */
async function editRemove(page, focus) {
  if (!(await canEdit())) return;
  const at = posByPage[page] - 1;
  if (at < 0) return;
  items = pageEdit.removeAt(items, at);
  const next = items.length === 0 ? undefined : items[Math.min(at, items.length - 1)].page;
  applyItems(focus ? next : undefined);
}

/** 並べ替え(ドラッグも Alt+↑↓ もこの 1 本)。`to` = 取り出した後の並びの位置(0 始まり)。 */
async function editMove(page, to, focus) {
  if (!(await canEdit())) return;
  const at = posByPage[page] - 1;
  if (at < 0) return;
  const next = pageEdit.moveTo(items, at, to);
  if (next.every((it, k) => it === items[k])) return;
  items = next;
  applyItems(focus ? page : undefined);
}

// ───────── 別の PDF を足す(#275 結合)
//
// 選んだ PDF のページを、一覧の最後に「まだ保存していない変更」として並べる。並べ替え・回す・外す・選ぶは元のページと同じ
// (通し番号の `page` で動く)。保存は「別の PDF として保存」の 1 本 ── `edit-core.js` が足した PDF からも、残すページだけを写す。
// 🔴 読めない(PDF でない / パスワード付き)ときは、何も変えずに窓の下で言う。

/** 通し番号 `i` が属する足した PDF(元の PDF のページなら `null`)。 */
function addedOf(i) {
  for (const a of added) if (i >= a.first && i < a.first + a.count) return a;
  return null;
}

function disposeAdded() {
  for (const a of added) a.lease.dispose();
}

/** 一覧の見出しの `data-source-first`(通し番号の先頭)から、足した PDF を引く。 */
function addedByFirst(first) {
  return added.find((a) => a.first === first) || null;
}

/**
 * 足した PDF の見出し(一覧の、その PDF の最初のページの前)。「会議B.pdf(3 ページ)」と、× = この PDF のページをすべて外す。
 * 作るのは 1 回だけ ── 置き場所は `applyItems` が毎回決める(並べ替えた後は、いまの並びで先に出るページの前)。
 */
function headingOf(a) {
  if (a.headEl) return a.headEl;
  const el = document.createElement('div');
  el.className = 'src-head';
  el.setAttribute('data-pkc-field', 'pdf-source-heading');
  el.setAttribute('data-source-first', String(a.first));
  const label = document.createElement('span');
  label.className = 'src-head-label';
  label.textContent = pageEdit.headingText(a.name, a.count);
  label.title = a.name;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'src-head-drop';
  x.setAttribute('data-pkc-field', 'pdf-source-remove');
  x.setAttribute('data-source-first', String(a.first));
  x.setAttribute('aria-label', `「${a.name}」のページをすべて外す`);
  x.title = 'この PDF のページをすべて外す';
  x.textContent = '×';
  el.append(label, x);
  a.headEl = el;
  return el;
}

/**
 * 保存前に足した PDF を捨てた扱いにする(貸し出しを返し、`added` から外し、中央の箱と一覧の項目を片づける)。
 * 🔑 **末尾の PDF なら通し番号を取り戻す**(箱も項目も作り直さず消す ── 足し直したページが「4 ページ目」から始まる)。
 *    途中の PDF は番号を飛ばしたまま畳む(後ろの PDF の番号を振り直さない)── 案内の分母から引く。
 */
function dropAddedView(a) {
  a.dropped = true;
  a.lease.dispose();
  const k = added.indexOf(a);
  if (k >= 0) added.splice(k, 1);
  if (a.headEl) a.headEl.remove();
  const end = a.first + a.count - 1;
  for (let i = a.first; i <= end; i += 1) {
    clearBox(i);
    cache.drop(i);
    thumbCache.drop(i);
    clearThumb(i);
    thumbVisible.delete(i);
    thumbFailed.delete(i);
  }
  if (end !== grand) {
    droppedPages += a.count;
    for (let i = a.first; i <= end; i += 1) boxes[i].hidden = true;
    return;
  }
  for (let i = a.first; i <= end; i += 1) {
    if (thumbObserver !== null) thumbObserver.unobserve(thumbItems[i]);
    boxes[i].remove();
    thumbCells[i].remove();
  }
  for (const arr of [thumbItems, thumbHolders, thumbCells, thumbNos, thumbPicks, thumbRot, pageRatio, boxes, posByPage, layers, pageVp, existing, sizes]) {
    if (arr.length > a.first) arr.length = a.first;
  }
  grand = a.first - 1;
  // 消した項目を指していた印を外す(次の描画で選び直される)
  if (tabStop > grand) tabStop = 0;
  if (marked > grand) marked = 0;
  if (selAnchor > grand) selAnchor = 0;
  if (current > grand) current = grand;
  $('pagecount').textContent = `/ ${String(grand)}`;
}

/**
 * 足した PDF のページを**全部**外す(別の場所へ動かしたページも)。保存していない PDF は足したこと自体を取り消す
 * (`added` からも外す ── bytes は送らない)。保存した PDF のページを外したときは、ふつうの「外す」と同じ(元に戻せる)。
 */
function removeSourceOf(a) {
  if (a === null || !ready || saving) return;
  const k = added.indexOf(a);
  if (k < 0) return;
  const r = pageEdit.removeSource(items, added, k);
  items = r.items;
  const saved = baseline.some((it) => it.page >= a.first && it.page < a.first + a.count);
  if (!saved) dropAddedView(a);
  applyItems();
  refresh();
  setStatus(`「${a.name}」のページをすべて外しました`);
}

// ───────── 足し方を選ぶ(「添付から選ぶ…」/「パソコンのファイルを選ぶ…」)

function hideAppendMenu() {
  appendMenu.hidden = true;
  appendPick.hidden = true;
  appendPick.textContent = '';
  appendBtn.setAttribute('aria-expanded', 'false');
  clearTimer(attachTimer);
  attachTimer = null;
}

function showAppendMenu() {
  const r = appendBtn.getBoundingClientRect();
  // 押したボタンの右端にそろえる(ボタンは帯の右寄りに在る ── 左端にそろえると、一覧が出たとき窓の外へはみ出す)
  appendMenu.style.right = `${String(Math.max(4, Math.floor(document.documentElement.clientWidth - r.right)))}px`;
  appendMenu.style.top = `${String(Math.floor(r.bottom + 4))}px`;
  appendPick.hidden = true;
  appendPick.textContent = '';
  appendMenu.style.left = '';
  appendMenu.hidden = false;
  keepAppendMenuOnScreen();
  appendBtn.setAttribute('aria-expanded', 'true');
}

/**
 * 🔴 一覧が窓の左外へはみ出さないようにする。上のバーが狭い窓で折り返すと「PDF を足す」が 2 段目の
 *   左端へ移り、右端そろえのままだと一覧が左へはみ出して押せなくなる(1100px の窓で実測、x=-16.8)。
 *   ⚠ 一覧の中身(添付の候補)が後から増えて幅が変わったときも、ここを呼び直す。
 */
function keepAppendMenuOnScreen() {
  if (appendMenu.hidden) return;
  const m = appendMenu.getBoundingClientRect();
  if (m.left < 4) {
    appendMenu.style.right = 'auto';
    appendMenu.style.left = '4px';
  }
}

appendBtn.addEventListener('click', () => {
  if (!ready || saving) return;
  if (appendMenu.hidden) showAppendMenu();
  else hideAppendMenu();
});
// 外を押したら閉じる(メニューの中と「PDF を足す」自身は除く)/ Esc でも閉じる
document.addEventListener('pointerdown', (ev) => {
  if (appendMenu.hidden) return;
  const t = ev.target instanceof Node ? ev.target : null;
  if (t !== null && (appendMenu.contains(t) || appendBtn.contains(t))) return;
  hideAppendMenu();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !appendMenu.hidden) {
    hideAppendMenu();
    appendBtn.focus();
  }
});

appendFromFile.addEventListener('click', () => {
  hideAppendMenu();
  if (!ready || saving) return;
  appendFile.value = '';
  appendFile.click();
});
appendFile.addEventListener('change', () => {
  const file = appendFile.files && appendFile.files[0];
  appendFile.value = '';
  if (file) void appendPdf(file);
});

/** 本体の返事を待つ時計(`wire.ATTACH_TIMEOUT_MS`)と、いま借りようとしている添付の鍵。 */
let attachTimer = null;
let attachWanted = null;

appendFromNote.addEventListener('click', () => {
  if (!ready || saving) return;
  appendPick.hidden = false;
  appendPick.textContent = '';
  const wait = document.createElement('div');
  wait.className = 'append-note';
  wait.textContent = '添付の PDF を探しています…';
  appendPick.append(wait);
  keepAppendMenuOnScreen();
  clearTimer(attachTimer);
  attachTimer = setTimeout(() => {
    attachTimer = null;
    appendPick.textContent = '';
    const msg = document.createElement('div');
    msg.className = 'append-note';
    msg.textContent = pageEdit.attachRefusal('no-reply');
    appendPick.append(msg);
  }, wire.ATTACH_TIMEOUT_MS);
  send('attach-list', {});
});

/** 本体が教えてくれた、この collection の PDF の添付の一覧を、メニューの下に並べる。 */
function onAttachList(payload) {
  if (appendMenu.hidden || appendPick.hidden) return;
  clearTimer(attachTimer);
  attachTimer = null;
  appendPick.textContent = '';
  const list = Array.isArray(payload.items) ? payload.items : [];
  if (payload.ok !== true || list.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'append-note';
    msg.textContent = pageEdit.attachRefusal(payload.ok === true ? 'empty' : 'failed');
    appendPick.append(msg);
    keepAppendMenuOnScreen();
    return;
  }
  for (const it of list) {
    if (typeof it.key !== 'string' || typeof it.name !== 'string') continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'append-item';
    b.setAttribute('data-pkc-field', 'pdf-append-attachment');
    b.setAttribute('data-attach-key', it.key);
    b.textContent = pageEdit.attachLabel(it.name, typeof it.size === 'number' ? it.size : null);
    b.title = it.name;
    b.addEventListener('click', () => {
      if (!ready || saving) return;
      attachWanted = { key: it.key, name: it.name };
      hideAppendMenu();
      setStatus(`「${it.name}」を読み込んでいます…`);
      clearTimer(attachTimer);
      attachTimer = setTimeout(() => {
        attachTimer = null;
        attachWanted = null;
        setStatus(pageEdit.attachRefusal('no-reply'));
      }, wire.ATTACH_TIMEOUT_MS);
      send('attach-get', { key: it.key });
    });
    appendPick.append(b);
  }
  keepAppendMenuOnScreen();
}

/** 選んだ添付の bytes を借りられた(貸された URL から取る)── あとは「パソコンのファイル」と同じ道で足す。 */
async function onAttachGet(payload) {
  const want = attachWanted;
  if (want === null || payload.key !== want.key) return;
  attachWanted = null;
  clearTimer(attachTimer);
  attachTimer = null;
  if (payload.ok !== true || typeof payload.url !== 'string') {
    setStatus(pageEdit.attachRefusal('failed'));
    return;
  }
  let file = null;
  try {
    const res = await fetch(payload.url);
    if (!res.ok) throw new Error(`status ${String(res.status)}`);
    file = new File([await res.blob()], want.name, { type: 'application/pdf' });
  } catch {
    setStatus(pageEdit.attachRefusal('failed'));
  }
  // 🔑 Blob を握った(または取れなかった)── 本体は貸した URL をここで返す
  send('attach-got', { key: want.key });
  if (file !== null) await appendPdf(file);
}

/** 選んだ PDF の読めるかを確かめて、ページを一覧の最後に足す。読めなければ何も変えない。 */
async function appendPdf(file) {
  if (!(await canEdit())) return;
  let count = 0;
  try {
    const res = await callEdit('check', undefined, { blob: file });
    count = res.pages;
  } catch (e) {
    setStatus(pageEdit.appendRefusal(e && e.pkcCode));
    return;
  }
  // 確かめている間に保存が始まった / 窓が畳まれたら足さない(送る中身と画面がずれる)
  if (!ready || saving || !(count >= 1)) return;
  const entry = {
    first: grand + 1,
    count,
    name: file.name,
    blob: file,
    // 一覧の絵を描くための pdf.js(使われない間は畳む。元の PDF と同じ貸し出し)
    lease: new DocLease({ open: () => openBlob(file), close: (doc) => doc.loadingTask.destroy() }),
  };
  added.push(entry);
  grand += count;
  for (let i = entry.first; i < entry.first + count; i += 1) {
    makeThumbCell(i);
    // 中央の読む面にも並べる(元の PDF の後ろに続けて読める)
    makeBox(i);
    sizeBox(i);
    if (thumbObserver !== null) thumbObserver.observe(thumbItems[i]);
  }
  $('pagecount').textContent = `/ ${String(grand)}`;
  items = pageEdit.appendPages(items, entry.first, count);
  // 足したページが見えるように、一覧を出して末尾へ寄せる
  if (!listOn) setList(true, true);
  applyItems();
  thumbItems[entry.first].scrollIntoView({ block: 'nearest' });
  setStatus(pageEdit.appendedNote(file.name, count));
}

// ───────── ページを選ぶ(#275 段②-1c)

/** 選んでいるか(`data-pkc-selected`。見た目は host.html)と、読み上げの字。 */
function paintSelected(p) {
  if (selected.has(p)) thumbCells[p].setAttribute('data-pkc-selected', 'true');
  else thumbCells[p].removeAttribute('data-pkc-selected');
  const pick = thumbPicks[p];
  if (pick) {
    pick.textContent = selected.has(p) ? '☑' : '☐';
    pick.setAttribute('aria-pressed', selected.has(p) ? 'true' : 'false');
  }
  paintThumbLabel(p);
}

/** 選びを `next` に取り替えて、変わったページだけ描き直す。 */
function setSelection(next) {
  const before = selected;
  selected = next;
  for (let p = 1; p <= grand; p += 1) {
    if (before.has(p) !== next.has(p)) paintSelected(p);
  }
  updateEditUi();
}

/** 選ぶ操作の入口。最初の 1 回だけ、編集できる形かを確かめる(抜き出しも同じ道で新しい文書を作るので)。 */
async function canPick() {
  // 🔴 保存・抜き出しを作っている間は選びを動かさない(送った中身と、画面の選びがずれる)
  if (saving) return false;
  const ok = await canEdit();
  return ok && !saving && posByPage.length > 0;
}

async function pickToggle(page) {
  if (!(await canPick()) || !(posByPage[page] > 0)) return;
  selAnchor = page;
  setSelection(pageEdit.toggleSel(selected, page));
}

/** `from` から `to` までを選ぶ(起点は動かさない)。`extend` = 今の選びに足す(Shift+↑↓)/ そうでなければ取り替える(Shift+クリック)。 */
async function pickRange(from, to, extend) {
  if (!(await canPick())) return;
  if (!(posByPage[from] > 0) || !(posByPage[to] > 0)) return;
  if (!(selAnchor >= 1)) selAnchor = from;
  const anchor = extend ? selAnchor : from;
  const range = pageEdit.rangeSel(items, posByPage[anchor] > 0 ? anchor : from, to);
  setSelection(range);
  if (extend) {
    setTabStop(to);
    thumbItems[to].focus();
  }
}

async function pickAll() {
  if (!(await canPick())) return;
  setSelection(new Set(items.map((it) => it.page)));
}

function pickClear() {
  if (saving || selected.size === 0) return;
  setSelection(new Set());
}

unpickBtn.addEventListener('click', () => {
  if (!saving) pickClear();
});

resetBtn.addEventListener('click', () => {
  if (!ready || saving) return;
  items = baseline.slice();
  // 保存前に足した PDF は捨てた扱い(基準に 1 枚も無い物だけ)── 一覧からは消え、案内の分母にも数えない
  for (const a of [...added].reverse()) {
    if (baseline.some((it) => it.page >= a.first && it.page < a.first + a.count)) continue;
    dropAddedView(a);
  }
  marks = hlBase.marks.slice();
  removals = new Map(hlBase.removals);
  notes = hlBase.notes.slice();
  strokes = hlBase.strokes.slice();
  noteRemovals = new Map(hlBase.noteRemovals);
  hideHlPop();
  hideNoteInput();
  repaintMarks();
  applyItems();
  setStatus('');
});

// ───────── ドラッグで並べ替える

/** ドラッグの控え(`null` = していない)。 */
let drag = null;

/** ポインタの高さから、取り出した後の並びの何番目に入るか(0 始まり)。ドラッグ中のページ自身は数えない。 */
function dropSlot(y) {
  let slot = 0;
  for (const it of items) {
    if (it.page === drag.page) continue;
    const r = thumbCells[it.page].getBoundingClientRect();
    if (r.top + r.height / 2 < y) slot += 1;
  }
  return slot;
}

/** 入る場所に線を出す(`slot` = null で消す)。 */
function showDrop(slot) {
  for (const c of listEl.querySelectorAll('[data-pkc-drop]')) c.removeAttribute('data-pkc-drop');
  if (slot === null) return;
  const others = items.filter((it) => it.page !== drag.page);
  if (others.length === 0) return;
  if (slot < others.length) thumbCells[others[slot].page].setAttribute('data-pkc-drop', 'before');
  else thumbCells[others[others.length - 1].page].setAttribute('data-pkc-drop', 'after');
}

function endDrag() {
  if (drag !== null && drag.active) {
    thumbCells[drag.page].removeAttribute('data-pkc-dragging');
    try {
      listEl.releasePointerCapture(drag.id);
    } catch {
      // 既に離れている
    }
  }
  showDrop(null);
  listEl.removeAttribute('data-pkc-pdf-dragging');
  drag = null;
}

listEl.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || !ready || saving || !(ev.target instanceof Element)) return;
  if (ev.target.closest('.thumb-act') !== null) return;
  const cell = ev.target.closest('.thumb-cell');
  if (cell === null) return;
  drag = {
    page: Number(cell.getAttribute('data-thumb-cell')),
    x: ev.clientX,
    y: ev.clientY,
    id: ev.pointerId,
    active: false,
  };
});
listEl.addEventListener('pointermove', (ev) => {
  if (drag === null || ev.pointerId !== drag.id) return;
  if (!drag.active) {
    if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) < DRAG_START_PX) return;
    drag.active = true;
    try {
      listEl.setPointerCapture(ev.pointerId);
    } catch {
      // 取れなくても、枠の中での動きは追える
    }
    thumbCells[drag.page].setAttribute('data-pkc-dragging', 'true');
    listEl.setAttribute('data-pkc-pdf-dragging', 'true');
  }
  // 枠の端に寄ったら、一覧を動かして遠くのページへ届くようにする
  const r = listEl.getBoundingClientRect();
  if (ev.clientY < r.top + 28) listEl.scrollTop -= 14;
  else if (ev.clientY > r.bottom - 28) listEl.scrollTop += 14;
  showDrop(dropSlot(ev.clientY));
});
listEl.addEventListener('pointerup', (ev) => {
  if (drag === null || ev.pointerId !== drag.id) return;
  const d = drag;
  const slot = d.active ? dropSlot(ev.clientY) : -1;
  endDrag();
  if (!d.active) return;
  dragEndedAt = Date.now();
  void editMove(d.page, slot, false);
});
listEl.addEventListener('pointercancel', () => {
  if (drag !== null) endDrag();
});

// ───────── 保存(別の PDF として)

saveBtn.addEventListener('click', () => {
  void saveEdited();
});
extractBtn.addEventListener('click', () => {
  void extractSelected();
});

/** 「別の PDF として保存」── いまの並び全部を新しい PDF にする。 */
async function saveEdited() {
  if (!ready || saving || !pageEdit.canSave(items) || !isDirty()) return;
  await submitBuild(items.slice(), pageEdit.outputName(docName), 'save');
}

/**
 * 「選んだページを別の PDF にする」(#275 段②-1c)── 選んだページだけを、いまの並びと向きのまま新しい PDF にする。
 * 🔴 作り方は保存と**同じ 1 本**(新しい文書へ写す道 ── 外したページの中身が file に残らない。`edit-core.js` の `build`)で、
 *    作った後にページ数を読み直す門も同じ。選ばなかったページの中身が残っていたら、渡さずに断る。
 * ⚠ 並びの基準(`baseline`)は動かさない ── 抜き出しは「並びを保存した」ことにならない。
 */
async function extractSelected() {
  if (!ready || saving) return;
  const picked = pageEdit.pickSelected(items, selected);
  if (picked.length < 1) return;
  await submitBuild(picked, pageEdit.extractName(docName), 'extract');
}

/** 新しい PDF を作って棚へ置き、本体へ知らせる(保存も抜き出しもここを通る)。@param list 新しい PDF にするページ(`items` の形) */
async function submitBuild(list, name, kind) {
  saving = true;
  lateOk = false;
  updateEditUi();
  setStatus('保存しています…');
  try {
    // 🔑 最初の編集のときに確かめてあるが、保存の直前にも通す(確かめていない経路から来ても断れる)
    if (editVerdict === null) {
      const v = await checkEditable();
      if (v !== 'worker') editVerdict = v;
      if (v !== 'ok') {
        setStatus(EDIT_MESSAGES[v]);
        saving = false;
        updateEditUi();
        return;
      }
    } else if (editVerdict !== 'ok') {
      setStatus(EDIT_MESSAGES[editVerdict]);
      saving = false;
      updateEditUi();
      return;
    }
    // 渡すのは**ページ番号の並びと回す角度・ハイライトの座標と色・外す注釈の id だけ**(bytes は別に transfer)
    const order = list.map((it) => it.page);
    const hlJob = hl.toJob(marks, removals, order);
    const annJob = nt.toJob(notes, strokes, (id) => hl.colorOf(id).rgb, order);
    // 外す付箋は、外すハイライトと同じ列に `kind: 'note'` で並べる(worker が種類に合う注釈だけを外す)
    hlJob.removals = hlJob.removals.concat(nt.removalsJob(noteRemovals, order));
    // 足した PDF は、ページが 1 枚でも残っている物だけ送る(送るのも transfer)
    const mine = pageEdit.sourcesFor(list, added);
    const res = await callEdit(
      'build',
      { ...pageEdit.toJob(list), ...hlJob, ...annJob, sources: mine.sources },
      { extras: mine.used.map((k) => added[k].blob) },
    );
    const dir = await editStage.openDir();
    if (dir === null) {
      setStatus('この端末の保存領域を使えないため、保存できません');
      saving = false;
      updateEditUi();
      return;
    }
    const staged = await editStage.stageBytes({
      dir,
      bytes: new Uint8Array(res.bytes),
      name,
    });
    // 🔴 返事が来なければ、「保存しています…」のまま固まらず断る(本体のリロード / 閉じ)
    clearTimer(editTimer);
    editTimer = setTimeout(() => {
      editTimer = null;
      saving = false;
      lateOk = true;
      setStatus(wire.EDIT_NO_REPLY);
      updateEditUi();
    }, wire.EDIT_TIMEOUT_MS);
    // 返事(`edit-result`)が来るまで `saving` のまま
    pending = {
      key: staged.key,
      kind,
      baseline: kind === 'save' ? list : null,
      // 保存した時点のハイライト(できたら、これが新しい基準になる)
      hlBase:
        kind === 'save'
          ? {
              marks: marks.slice(),
              removals: new Map(removals),
              notes: notes.slice(),
              strokes: strokes.slice(),
              noteRemovals: new Map(noteRemovals),
            }
          : null,
    };
    send('edited', { key: staged.key });
  } catch (e) {
    const code = e && e.pkcCode;
    setStatus(EDIT_MESSAGES[code] || '保存できませんでした。もう一度押してください');
    saving = false;
    updateEditUi();
  }
}

/**
 * 本体の返事(新しい添付ができた / できなかった)。
 * 🔴 できたら、**保存した並びを基準にする**(保存ボタンを隠す)── 押し直して同じ PDF の添付を増やさせない。
 * 🔴 時間切れの後に**遅れて**届いた返事は、今の状態の字を上書きしない(基準だけ直す ── 添付はできているので)。
 */
let lateOk = false;
function onEditResult(payload) {
  // 🔴 鍵が合わない返事(前の依頼の遅い返事 / 控えが無い)は捨てる
  if (!pageEdit.replyMatches(pending, payload)) return;
  const ok = payload.ok === true;
  if (!saving) {
    // 時間切れの後の遅い返事: 成功なら基準だけ直し、字は「確かめられませんでした」のときだけ置き換える
    if (lateOk && ok) {
      const kind = pending.kind;
      if (kind === 'save' && pending.baseline !== null) baseline = pending.baseline;
      if (kind === 'save' && pending.hlBase !== null) hlBase = pending.hlBase;
      if (kind === 'extract') selected = new Set();
      pending = null;
      lateOk = false;
      if (kind === 'extract') clearPaintedSelection();
      if (statusEl.textContent === wire.EDIT_NO_REPLY) setStatus(kind === 'extract' ? EXTRACTED_NOTE : SAVED_NOTE);
      updateEditUi();
    }
    return;
  }
  clearTimer(editTimer);
  editTimer = null;
  saving = false;
  lateOk = false;
  if (ok && pending.kind === 'save' && pending.baseline !== null) {
    baseline = pending.baseline;
    if (pending.hlBase !== null) hlBase = pending.hlBase;
    setStatus(SAVED_NOTE);
  } else if (ok && pending.kind === 'extract') {
    // 🔴 抜き出せたら選びを外す ── 押し直して同じ PDF の添付を増やさせない(保存で基準を直すのと同じ向き)。並びの基準は動かさない
    selected = new Set();
    clearPaintedSelection();
    setStatus(EXTRACTED_NOTE);
  } else {
    setStatus(typeof payload.message === 'string' && payload.message !== '' ? payload.message : '保存できませんでした。もう一度押してください');
  }
  pending = null;
  updateEditUi();
}

/** 選びの印を全部消す(`selected` を空にした後に呼ぶ)。 */
function clearPaintedSelection() {
  for (let p = 1; p <= grand; p += 1) paintSelected(p);
}

// 🔴 まだ保存していない変更があるまま窓を閉じる / 読み込み直すときだけ、ブラウザの確認を出す(変更が無ければ何も出さない)
window.addEventListener('beforeunload', (ev) => {
  if (!isDirty()) return;
  ev.preventDefault();
  ev.returnValue = '';
});

// ───────── 拡大縮小 / 頁送り

function applyScale(next) {
  const anchor = current;
  // 🔴 読んでいた位置(そのページの何割の所か)を控え、大きさが変わった後も同じ所を出す(#1663)
  let frac = null;
  if (boxes[anchor] && !boxes[anchor].hidden) {
    const r = boxes[anchor].getBoundingClientRect();
    frac = readFraction(scroller.getBoundingClientRect().top, r.top, r.height);
  }
  scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, next));
  gen += 1;
  cache.clear();
  for (let i = 1; i <= grand; i += 1) clearBox(i);
  resizeAll();
  if (!boxes[anchor].hidden) {
    if (frac === null) {
      boxes[anchor].scrollIntoView({ block: 'start' });
    } else {
      const r = boxes[anchor].getBoundingClientRect();
      scroller.scrollTop += scrollDelta(scroller.getBoundingClientRect().top, r.top, r.height, frac);
    }
  }
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
  const p = Math.max(1, Math.min(grand, Math.floor(n)));
  if (boxes[p].hidden) return;
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
/** 一致の数を上限で止めたか(止めたなら件数の字は「N 件以上」)。 */
let hitsCapped = false;
const HIT_CAP = 5000;

function loadTexts() {
  if (textsPromise === null) {
    // 🔑 本文を集めている間は「飛んでいる依頼」(解析 worker を畳まない)。集め終えれば、検索は文書を要らない
    textsPromise = lease
      .use(async (pdf) => {
        const out = [];
        for (let i = 1; i <= total; i += 1) {
          const p = await pdf.getPage(i);
          const tc = await p.getTextContent();
          // 🔑 字と「行末か」を span ごとに持つ(文字の層の span と同じ数え方 = `str` を持つ項目だけ)。
          //    行末は欧文では空白・日本語どうしの間では無しとして突き合わせる(`text-hits.js`)
          const strs = [];
          const eols = [];
          for (const it of tc.items) {
            if (typeof it.str !== 'string') continue;
            strs.push(it.str);
            eols.push(it.hasEOL === true);
          }
          out[i] = { strs, eols };
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
  for (const [k, list] of textHits.rangesBySpan(L.strs, hitQuery, L.eols)) {
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
  // 作り直した頁が、いま見ている一致の頁なら、その一致を濃くし直す
  if (hitIndex >= 0 && hitList[hitIndex] === i) paintCurrentHit();
}

/** いま見ている一致の印(`mark.hit`)。その頁にまだ印が無い(描けていない)ときは `null`。 */
function currentHitMark() {
  if (hitIndex < 0 || hitIndex >= hitList.length) return null;
  const page = hitList[hitIndex];
  let nth = 0;
  for (let j = 0; j < hitIndex; j += 1) if (hitList[j] === page) nth += 1;
  const box = boxes[page];
  const marks = box ? box.querySelectorAll('mark.hit') : [];
  const L = layers[page];
  if (marks.length === 0 || !L) return null;
  // 一致の番号と印の番号は同じではない(`text-hits.js` の `markIndexOfHits`)
  const at = textHits.markIndexOfHits(L.strs, hitQuery, L.eols);
  const k = at.length > 0 ? at[Math.min(nth, at.length - 1)] : nth;
  return marks[Math.min(k, marks.length - 1)];
}

/** いま見ている一致だけ濃く塗る(`mark.hit.cur`。ほかの一致は元の黄色のまま)。 */
function paintCurrentHit() {
  for (const m of pagesEl.querySelectorAll('mark.hit.cur')) m.classList.remove('cur');
  const m = currentHitMark();
  if (m !== null) m.classList.add('cur');
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
  hitsCapped = false;
  let capped = false;
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
    const pg = texts[i];
    if (!pg) continue;
    const room = HIT_CAP - hitList.length;
    const n = textHits.countHits(pg.strs, hitQuery, pg.eols, room + 1);
    if (n > room) capped = true;
    for (let c = 0; c < Math.min(n, room); c += 1) hitList.push(i);
  }
  hitsCapped = capped;
  if (hitList.length === 0) {
    // 🔴 字が 1 つも無い PDF(スキャンした画像だけ)では、探しても必ず「見つかりません」になる ──
    //   「字が無い」と「その語が無い」を言い分ける(後者だけが探し直して意味のある話)
    let anyText = false;
    for (let i = 1; i <= total; i += 1) {
      if (texts[i] && texts[i].strs.some((t) => t.trim() !== '')) {
        anyText = true;
        break;
      }
    }
    $('hits').textContent = anyText ? '見つかりません' : 'この PDF には探せる字がありません(スキャンした画像のようです)';
    return;
  }
  for (let i = 1; i <= total; i += 1) if (cache.has(i)) markHits(i);
  stepHit(1);
}

function stepHit(delta) {
  if (hitList.length === 0) return;
  hitIndex = (hitIndex + delta + hitList.length) % hitList.length;
  const page = hitList[hitIndex];
  $('hits').textContent = `${String(hitIndex + 1)} / ${String(hitList.length)} 件${hitsCapped ? '以上' : ''}(${String(page)} ページ)`;
  goPage(page);
  /*
   * 🔴 一致した字そのものが見える所まで送る(#1087 の見直し 2026-10-13)。直す前はページの先頭へ送るだけで、
   *   同じページに一致が 3 件あると「次の一致」を押しても数字だけ変わって画面が動かなかった。
   *   ⚠ そのページの何番目の一致かを数え、その一致の先頭を含む印(mark.hit)へ送る。一致の番号と印の番号は
   *   同じではない(一致が span をまたげば印は複数、隣り合う一致は 1 つの印になる ── `text-hits.js` の
   *   `markIndexOfHits`)。まだ描けていないページ(印が無い)は今までどおりページの先頭のまま。
   */
  const m = currentHitMark();
  if (m !== null) m.scrollIntoView({ block: 'center' });
  paintCurrentHit();
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

/** 最後に選んだ字(`null` = 選んでいない)。`range` = 選びの複製(ボタンを押す間に選びが消えても、位置を読める)。 */
let lastSel = null;
const swatches = [];

/** 「ノートへ引用する」「ハイライト」と色のボタンは、字を選んだときだけ押せる(同じ選びから、どれもできる)。 */
function setSelButtons(on) {
  quoteBtn.disabled = !on;
  hlBtn.disabled = !on;
  // 色のボタンは、字を選んだときと、ペンを選んでいる間も押せる(同じ 4 色)
  for (const b of swatches) b.disabled = !(on || tool === 'pen');
}

const isBarButton = (el) => el === quoteBtn || el === hlBtn || swatches.includes(el);

document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  const text = sel === null ? '' : sel.toString();
  if (sel === null || sel.rangeCount === 0 || text.trim() === '') {
    // ボタンを押す間に選びが消える環境でも、押した結果は残す
    if (isBarButton(document.activeElement)) return;
    lastSel = null;
    setSelButtons(false);
    return;
  }
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  const box = el === null ? null : el.closest('[data-page]');
  if (box === null || !pagesEl.contains(box)) return;
  lastSel = {
    text,
    page: Number(box.getAttribute('data-page')),
    range: typeof range.cloneRange === 'function' ? range.cloneRange() : null,
  };
  setSelButtons(true);
});

quoteBtn.addEventListener('click', () => {
  if (lastSel === null) return;
  const refusal = wire.checkQuote(lastSel.text);
  if (refusal !== null) {
    setStatus(refusal);
    return;
  }
  setStatus('ノートへ引用しています…');
  // 🔴 返事が来なければ、「引いています…」のまま固まらず断る(本体のリロード / 閉じ)
  clearTimer(quoteTimer);
  quoteTimer = setTimeout(() => {
    quoteTimer = null;
    setStatus(wire.QUOTE_NO_REPLY);
  }, wire.QUOTE_TIMEOUT_MS);
  send('quote', { text: lastSel.text, page: lastSel.page });
});

// ───────── ハイライト(#275 段②-2b/c)── 字を選んで色を付ける・付いたハイライトを外す
//
// 🔴 画面で触るのは**計画**(`marks` = 付ける / `removals` = 外す元のハイライト)だけで、PDF は保存を押すまで書き換えない。
// 保存は**ページの編集と同じ 1 本**(`submitBuild` → `edit-worker.js` → 棚 → 本体)── 別の保存経路を作らない。
// 設計 doc: `docs/development/pdf-annotation-design-2026-10.md`。座標の計算は `highlight.js`(取り出して test できる形)。

/** 付けたハイライト `{ uid, page(元のページ番号), color, quads }`。保存した後も、この窓の間は残す(窓の絵には焼かれていない)。 */
let marks = [];
/** 外すと決めた、元の PDF に付いていたハイライト `Map<"頁:id", { page, id }>`。 */
let removals = new Map();
/** 最後に保存した時点の `marks` / `removals`。「まだ保存していない変更」はこれとの違いで見る。 */
let hlBase = { marks: [], removals: new Map(), notes: [], strokes: [], noteRemovals: new Map() };
/** 選んだ色(窓を閉じるまで覚える)。 */
let hlColor = hl.DEFAULT_COLOR;
/** ペンの色(窓を閉じるまで覚える)。既定は濃い色 ── ハイライトの黄(薄い)では線が読みにくい。丸いボタンで選べば替わる。 */
let penColor = hl.PEN_DEFAULT_COLOR;
let uidSeq = 0;
/** 「ハイライトを外す」を出している対象(`null` = 出していない)と、そのときの読む面の位置。 */
let hlTarget = null;
let hlPopScroll = 0;

function isMarkDirty() {
  return !hl.sameMarks(marks, hlBase.marks) || !hl.sameRemovals(removals, hlBase.removals);
}

/** 付箋とペンに、まだ保存していない変更があるか(付けた・直した・外した)。 */
function isAnnDirty() {
  return (
    !nt.sameUids(notes, hlBase.notes) ||
    !nt.sameStrokes(strokes, hlBase.strokes) ||
    !hl.sameRemovals(noteRemovals, hlBase.noteRemovals)
  );
}

function isHlDirty() {
  return isMarkDirty() || isAnnDirty();
}

/** 案内に出す数(付箋: 付けた / 外した、ペンの線: 書いた / 外した)。 */
function annCounts() {
  // 🔴 外したページに付いた物は、保存した PDF に入らない ── 案内の数から除く(保存前の案内が実際より多く言わない)
  const kept = (list) => pageEdit.onKeptPages(list, items);
  const n = nt.diffCount(kept(notes), kept(hlBase.notes));
  let goneExisting = 0;
  for (const [k, v] of noteRemovals) if (!hlBase.noteRemovals.has(k) && pageEdit.isKept(items, v.page)) goneExisting += 1;
  return {
    notes: { added: n.added, removed: n.removed + goneExisting },
    strokes: nt.diffCount(kept(strokes), kept(hlBase.strokes)),
  };
}

/** 案内に出す数: 保存した状態に無い付けた数 / 保存した状態から外した数。 */
function hlCounts() {
  // 🔴 外したページに付いた物は数えない(上の `annCounts` と同じ)
  const live = pageEdit.onKeptPages(marks, items);
  const baseLive = pageEdit.onKeptPages(hlBase.marks, items);
  const has = new Set(live.map((m) => `${String(m.uid)}:${m.color}`));
  const baseHas = new Set(baseLive.map((m) => `${String(m.uid)}:${m.color}`));
  const uids = new Set(live.map((m) => m.uid));
  let removed = 0;
  for (const b of baseLive) if (!uids.has(b.uid)) removed += 1;
  for (const [k, v] of removals) if (!hlBase.removals.has(k) && pageEdit.isKept(items, v.page)) removed += 1;
  return { added: [...has].filter((k) => !baseHas.has(k)).length, removed };
}

/** 元の PDF のそのページに付いているハイライト(外すために押せる印の材料)。読めなければ 0 件(外せないだけ)。 */
async function loadHighlights(page) {
  try {
    const type = pdfjs.AnnotationType?.HIGHLIGHT ?? 9;
    const list = await page.getAnnotations();
    return list
      .filter((a) => a.annotationType === type && typeof a.id === 'string' && hl.parseAnnotId(a.id) !== null)
      .map((a) => ({ id: a.id, quads: quadsOfAnnotation(a) }));
  } catch {
    return [];
  }
}

function quadsOfAnnotation(a) {
  const q = a.quadPoints ? Array.from(a.quadPoints) : [];
  if (q.length >= 8 && q.length % 8 === 0) {
    const out = [];
    for (let k = 0; k < q.length; k += 8) out.push(q.slice(k, k + 8));
    return out;
  }
  const r = a.rect;
  return [[r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]]];
}

const cssRgb = (rgb) => `rgb(${rgb.map((c) => String(Math.round(c * 255))).join(',')})`;

/** 4 点(PDF の座標)を囲む、窓の座標の長方形を `<div>` にする。 */
function quadBox(vp, q) {
  const xs = [];
  const ys = [];
  for (let k = 0; k < 8; k += 2) {
    const p = vp.convertToViewportPoint(q[k], q[k + 1]);
    xs.push(p[0]);
    ys.push(p[1]);
  }
  const el = document.createElement('div');
  el.style.left = `${String(Math.min(...xs))}px`;
  el.style.top = `${String(Math.min(...ys))}px`;
  el.style.width = `${String(Math.max(...xs) - Math.min(...xs))}px`;
  el.style.height = `${String(Math.max(...ys) - Math.min(...ys))}px`;
  return el;
}

/**
 * 頁 `i` に、ハイライトの層を重ねる(絵の上・字の層の下)。
 * 付けたハイライトは色つきで見せる(絵は焼き直さない)。元から付いているハイライトは絵に焼かれているので**透明**で重ね
 * (押せる印)、外すと決めたものだけ薄く覆って破線で囲む。⚠ 層は `pointer-events: none` ── 字を選ぶ邪魔をしない
 * (押したかどうかは、下の `click` が長方形の位置で調べる)。
 */
function paintMarks(i) {
  const box = boxes[i];
  const vp = pageVp[i];
  if (!box || !vp) return;
  const old = box.querySelector(':scope > .hl-layer');
  if (old !== null) old.remove();
  const img = box.querySelector(':scope > img');
  if (img === null) return;
  const layer = document.createElement('div');
  layer.className = 'hl-layer';
  layer.setAttribute('data-pkc-field', 'pdf-highlight-layer');
  for (const e of existing[i] || []) {
    const gone = removals.has(`${String(i)}:${e.id}`);
    for (const q of e.quads) {
      const el = quadBox(vp, q);
      el.setAttribute('data-pkc-field', 'pdf-highlight-existing');
      el.setAttribute('data-hl-id', e.id);
      if (gone) el.setAttribute('data-pkc-removed', 'true');
      layer.append(el);
    }
  }
  for (const m of marks) {
    if (m.page !== i) continue;
    for (const q of m.quads) {
      const el = quadBox(vp, q);
      el.setAttribute('data-pkc-field', 'pdf-highlight-new');
      el.setAttribute('data-hl-uid', String(m.uid));
      el.setAttribute('data-hl-color', m.color);
      el.style.backgroundColor = cssRgb(hl.colorOf(m.color).rgb);
      layer.append(el);
    }
  }
  img.after(layer);
  paintNotes(i);
}

/** いま絵になっている頁のハイライトの層を作り直す。 */
function repaintMarks() {
  for (let i = 1; i <= total; i += 1) paintMarks(i);
}

/** 選んだ範囲を、頁ごとの `{ page, quads }` にする(頁にまたがる選びは頁ごとに分ける)。 */
function marksFromRange(range) {
  if (range === null || typeof range.getClientRects !== 'function') return [];
  const rects = [...range.getClientRects()].map((r) => ({
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
  }));
  const out = [];
  for (let i = 1; i <= total; i += 1) {
    const vp = pageVp[i];
    const box = boxes[i];
    if (!vp || !box) continue;
    const b = box.getBoundingClientRect();
    const got = hl.quadsOnPage(
      rects,
      { left: b.left, top: b.top, width: b.width, height: b.height },
      { width: vp.width, height: vp.height },
      (x, y) => vp.convertToPdfPoint(x, y),
    );
    if (got !== null) out.push({ page: i, quads: got.quads });
  }
  return out;
}

const HL_NOT_READ = 'ハイライトを付ける範囲を読み取れませんでした。字を選び直してください';

/** 「ハイライト」── 選んだ字に、いまの色で付ける。同じ範囲に付け直したときは、重ねずに色を取り替える。 */
async function addHighlight() {
  if (!ready || saving || lastSel === null) return;
  // 🔑 位置は await の前に読む(選びの複製から。待っている間に画面が動いても、押した瞬間の範囲)
  const made = marksFromRange(lastSel.range);
  if (made.length === 0) {
    setStatus(HL_NOT_READ);
    return;
  }
  if (made.some((m) => isRemovedPage(m.page))) {
    setStatus(REMOVED_PAGE_NO_TOOL);
    return;
  }
  if (!(await canEdit())) return;
  if (saving) return;
  for (const m of made) {
    const same = marks.find((o) => o.page === m.page && hl.sameQuads(o.quads, m.quads));
    if (same !== undefined) {
      // 同じ範囲 ── 色だけ取り替える(新しい uid にして、保存した状態との違いとして数える)
      marks = marks.map((o) => (o === same ? { ...o, uid: (uidSeq += 1), color: hlColor } : o));
    } else {
      uidSeq += 1;
      marks.push({ uid: uidSeq, page: m.page, color: hlColor, quads: m.quads });
    }
  }
  repaintMarks();
  updateEditUi();
  setStatus('ハイライトを付けました。「別の PDF として保存」で新しい PDF になります');
}

/** 丸いボタンの「押されている」を、いま選んでいる道具の色に合わせる(ペンの間はペンの色、それ以外はハイライトの色)。 */
function syncSwatches() {
  const cur = tool === 'pen' ? penColor : hlColor;
  for (const b of swatches) b.setAttribute('aria-pressed', b.getAttribute('data-hl-color') === cur ? 'true' : 'false');
}

function setHlColor(id) {
  // 🔑 ペンを選んでいる間の色は、ハイライトの色とは別に覚える(ペンの既定の濃い色を、ハイライトの選びで動かさない)
  if (tool === 'pen') penColor = hl.colorOf(id).id;
  else hlColor = hl.colorOf(id).id;
  syncSwatches();
}

/** 色のボタンを作って、「ノートへ引用する」の手前に並べる(色の正本は `highlight.js` の `COLORS` ── 窓の色もここから引く)。 */
function buildSwatches() {
  for (const c of hl.COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.disabled = true;
    b.setAttribute('data-pkc-field', 'pdf-highlight-color');
    b.setAttribute('data-hl-color', c.id);
    b.setAttribute('aria-label', `${c.label}色`);
    b.title = `${c.label}色で付ける`;
    b.style.backgroundColor = cssRgb(c.rgb);
    b.addEventListener('click', () => setHlColor(c.id));
    quoteBtn.before(b);
    swatches.push(b);
  }
  // ⚠ `tool` はこの下で宣言する(まだ触れない)── 最初はハイライトの色を押されている印にする
  for (const b of swatches) b.setAttribute('aria-pressed', b.getAttribute('data-hl-color') === hlColor ? 'true' : 'false');
}
buildSwatches();
hlBtn.addEventListener('click', () => {
  void addHighlight();
});

// ── 付いたハイライトを押す → 「ハイライトを外す」

function hideHlPop() {
  hlTarget = null;
  hlPop.hidden = true;
  hideNotePop();
}

function showHlPop(el, x, y) {
  const field = el.getAttribute('data-pkc-field');
  const page = Number(el.closest('.page').getAttribute('data-page'));
  if (field === 'pdf-highlight-new') {
    hlTarget = { kind: 'new', page, uid: Number(el.getAttribute('data-hl-uid')) };
    hlPopBtn.textContent = 'ハイライトを外す';
  } else {
    const id = el.getAttribute('data-hl-id') ?? '';
    hlTarget = { kind: 'existing', page, id };
    hlPopBtn.textContent = removals.has(`${String(page)}:${id}`) ? 'ハイライトを外すのをやめる' : 'ハイライトを外す';
  }
  hlPop.hidden = false;
  hlPopScroll = scroller.scrollTop;
  const w = hlPop.offsetWidth;
  const h = hlPop.offsetHeight;
  hlPop.style.left = `${String(Math.max(4, Math.min(x + 6, window.innerWidth - w - 4)))}px`;
  hlPop.style.top = `${String(Math.max(4, Math.min(y + 6, window.innerHeight - h - 4)))}px`;
}

/** 押し下げた位置(ドラッグで字を選んだ後の click と、ただ押した click を見分ける)。 */
let hlDown = null;
pagesEl.addEventListener('pointerdown', (ev) => {
  hlDown = { x: ev.clientX, y: ev.clientY };
});

pagesEl.addEventListener('click', (ev) => {
  if (!ready) return;
  // 付箋 / ペンの道具を選んでいる間は、ハイライトの「外す」を出さない(押した位置は道具が使う)。
  // ただし付箋の印は道具を選んだままでも押せる(「直す / 外す」を出す)
  if (tool !== null) {
    const m = ev.target instanceof Element ? ev.target.closest('.note-layer > div') : null;
    hideHlPop();
    if (m !== null) showNotePopFor(m, ev.clientX, ev.clientY);
    return;
  }
  // 🔑 見分けは**選びの有無ではなく動き**で ── 付けた直後の字は選ばれたままなので、その上を押した click でも「外す」を出す。
  //    ドラッグで字を選んだ後の click(押した位置から動いている)と、ダブルクリック(単語を選ぶ)は、押したことにしない
  const moved = hlDown !== null && Math.hypot(ev.clientX - hlDown.x, ev.clientY - hlDown.y) > 4;
  if (moved || ev.detail >= 2) {
    hideHlPop();
    return;
  }
  const t = ev.target instanceof Element ? ev.target : null;
  const box = t === null ? null : t.closest('.page');
  if (box === null) {
    hideHlPop();
    return;
  }
  // 付箋の印 / ペンの線を押したときは、そちらの「直す / 外す」(ハイライトの「外す」は出さない)
  const mark = t.closest('.note-layer > div');
  if (mark !== null) {
    hideHlPop();
    showNotePopFor(mark, ev.clientX, ev.clientY);
    return;
  }
  const stroke = strokeUnder(box, ev.clientX, ev.clientY);
  if (stroke !== null) {
    hideHlPop();
    showNotePop({ kind: 'stroke', uid: stroke.uid }, ev.clientX, ev.clientY);
    return;
  }
  const hit = [...box.querySelectorAll(':scope > .hl-layer > div')].filter((el) => {
    const r = el.getBoundingClientRect();
    return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
  });
  if (hit.length === 0) {
    hideHlPop();
    return;
  }
  // 重なっていたら、いちばん上(後から付けた物)
  showHlPop(hit[hit.length - 1], ev.clientX, ev.clientY);
});
// 読み進めたら畳む(押した場所から離れる)。⚠ ほんの少しの動き(押した直後の位置合わせ)では畳まない
scroller.addEventListener('scroll', () => {
  if ((hlTarget !== null || noteTarget !== null) && Math.abs(scroller.scrollTop - hlPopScroll) > 8) hideHlPop();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  hideHlPop();
  // 字を入れていないときの Esc は、選んでいる道具をやめる
  if (tool !== null && noteDraft === null) setTool(null);
});

hlPopBtn.addEventListener('click', () => {
  void removeTarget();
});

async function removeTarget() {
  const t = hlTarget;
  hideHlPop();
  if (t === null || !ready || saving) return;
  if (t.kind === 'new') {
    marks = marks.filter((m) => m.uid !== t.uid);
    setStatus('ハイライトを外しました');
  } else {
    if (!(await canEdit())) return;
    if (saving) return;
    const key = `${String(t.page)}:${t.id}`;
    if (removals.has(key)) {
      removals.delete(key);
      setStatus('ハイライトを外すのをやめました');
    } else {
      removals.set(key, { page: t.page, id: t.id });
      setStatus('ハイライトを外します。「別の PDF として保存」で新しい PDF から消えます');
    }
  }
  repaintMarks();
  updateEditUi();
}

// ───────── ブラウザの表示で開く(同じ PDF をブラウザ標準の表示で別のタブに)

nativeBtn.addEventListener('click', () => {
  if (blob === null) return;
  // 🔑 URL は 1 つだけ作って使い回す。⚠ 返すのは窓を閉じるとき(`pagehide`)── 開いた先のタブが読み終えるまで要る
  if (nativeUrl === null) nativeUrl = URL.createObjectURL(blob);
  const w = window.open(nativeUrl, '_blank');
  if (w === null) setStatus('ブラウザの表示を開けませんでした。ブラウザのポップアップを許可してから、もう一度押してください');
});

// ───────── 付箋とペン(#275)── ページのどこかを押して付箋を付ける・なぞって線を書く
//
// 🔴 ハイライトと**同じ作り**: 画面で触るのは計画(`notes` / `strokes` / 外す元の付箋 `noteRemovals`)だけで、PDF は保存を押すまで
// 書き換えない。保存はページの編集と同じ 1 本(`submitBuild`)で、新しい PDF に PDF 本来の注釈(`/Text` と `/Ink`)として入る。
// 座標の計算は `notes.js`(取り出して test できる形)。

/** 付けた付箋 `{ uid, page, rect(PDF の座標), text }` / 書いた線 `{ uid, page, color, pts(PDF の座標) }` / 外す元の付箋 `Map<"頁:id", { page, id }>`。 */
let notes = [];
let strokes = [];
let noteRemovals = new Map();
/** 選んでいる道具(`null` / 'note' / 'pen')。 */
let tool = null;
/** 字を入れている付箋(`null` = 入れていない)。 */
let noteDraft = null;
/** 「直す / 外す」を出している対象(`null` = 出していない)。 */
let noteTarget = null;

/** 元の PDF のそのページに付いている付箋(読めなければ 0 件)。字の無い付箋(返信・吹き出しだけ)は対象にしない。 */
async function loadNotes(page) {
  try {
    const type = pdfjs.AnnotationType?.TEXT ?? 1;
    const list = await page.getAnnotations();
    return list
      .filter((a) => a.annotationType === type && typeof a.id === 'string' && hl.parseAnnotId(a.id) !== null && !a.inReplyTo)
      .map((a) => ({ id: a.id, rect: Array.from(a.rect), text: String(a.contentsObj?.str ?? a.contents ?? '') }))
      .filter((n) => n.text.trim() !== '');
  } catch {
    return [];
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 頁 `i` に、押さえの層(道具を選んでいる間だけ見える)・ペンの線の層・付箋の印の層を重ねる(`paintMarks` から呼ぶ)。 */
function paintNotes(i) {
  const box = boxes[i];
  const vp = pageVp[i];
  if (!box || !vp) return;
  for (const c of ['tool-layer', 'ink-layer', 'note-layer']) {
    const old = box.querySelector(`:scope > .${c}`);
    if (old !== null) old.remove();
  }
  const pressLayer = document.createElement('div');
  pressLayer.className = 'tool-layer';
  pressLayer.setAttribute('data-pkc-field', 'pdf-tool-layer');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ink-layer');
  svg.setAttribute('data-pkc-field', 'pdf-ink-layer');
  svg.setAttribute('viewBox', `0 0 ${String(vp.width)} ${String(vp.height)}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.width = '100%';
  svg.style.height = '100%';
  for (const s of strokes) {
    if (s.page !== i) continue;
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('data-pkc-field', 'pdf-ink');
    line.setAttribute('data-ink-uid', String(s.uid));
    line.setAttribute('data-hl-color', s.color);
    line.setAttribute('points', s.pts.map((p) => vp.convertToViewportPoint(p[0], p[1]).join(',')).join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', cssRgb(hl.colorOf(s.color).rgb));
    line.setAttribute('stroke-width', String(nt.PEN_WIDTH * (vp.scale ?? scale)));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    svg.append(line);
  }
  const layer = document.createElement('div');
  layer.className = 'note-layer';
  layer.setAttribute('data-pkc-field', 'pdf-note-layer');
  const place = (el, rect) => {
    const b = nt.viewportBox(rect, (x, y) => vp.convertToViewportPoint(x, y));
    el.style.left = `${String(b.left)}px`;
    el.style.top = `${String(b.top)}px`;
    el.style.width = `${String(b.width)}px`;
    el.style.height = `${String(b.height)}px`;
  };
  for (const e of existingNotes[i] || []) {
    const el = document.createElement('div');
    el.setAttribute('data-pkc-field', 'pdf-note-existing');
    el.setAttribute('data-note-id', e.id);
    el.setAttribute('data-note-text', e.text);
    if (noteRemovals.has(`${String(i)}:${e.id}`)) el.setAttribute('data-pkc-removed', 'true');
    place(el, e.rect);
    layer.append(el);
  }
  for (const n of notes) {
    if (n.page !== i) continue;
    const el = document.createElement('div');
    el.setAttribute('data-pkc-field', 'pdf-note-new');
    el.setAttribute('data-note-uid', String(n.uid));
    el.setAttribute('data-note-text', n.text);
    place(el, n.rect);
    layer.append(el);
  }
  box.append(pressLayer, svg, layer);
}

/** 道具を選ぶ / やめる(同じ道具をもう一度押すとやめる)。 */
function setTool(next) {
  const to = tool === next ? null : next;
  tool = to;
  cancelNoteInput();
  hideHlPop();
  if (to === null) document.body.removeAttribute('data-pkc-pdf-tool');
  else document.body.setAttribute('data-pkc-pdf-tool', to);
  noteBtn.setAttribute('aria-pressed', to === 'note' ? 'true' : 'false');
  penBtn.setAttribute('aria-pressed', to === 'pen' ? 'true' : 'false');
  setSelButtons(lastSel !== null);
  syncSwatches();
  if (to === 'note') setStatus('付箋を付けたい場所を押してください');
  else if (to === 'pen') setStatus('ページの上をなぞって線を書けます。色は右の丸いボタンで選びます');
  else setStatus('');
}
noteBtn.addEventListener('click', () => {
  if (ready && !saving) setTool('note');
});
penBtn.addEventListener('click', () => {
  if (ready && !saving) setTool('pen');
});

/**
 * 🔴 **足したページを押したときの理由**。足したページには押さえの層(`tool-layer`)も字の層も作らない
 * (`paintNotes` / `paintMarks` は元の PDF のページだけ)ので、付箋・ペンを選んで押しても
 * **何も起きず、理由も出なかった**。窓の下に理由を言う。
 * ⚠ ハイライトは字を選ぶ道具で、足したページには字の層が無く**選べない**(ボタンが押せないまま)── その押しは
 *   ここでは捉えられないので、字は道具を選んでいる間の押しにだけ出す。
 */
const ADDED_PAGE_NO_TOOL = '足したページには付箋・ペン・ハイライトを付けられません(保存した PDF なら付けられます)';
/** 外したページへ付けようとした断り(保存した PDF に入らないページへ付けても、消えるだけ)。 */
const REMOVED_PAGE_NO_TOOL = pageEdit.REMOVED_PAGE_REFUSAL;
/** 元の PDF のページで、いまの並びから外してあるか(一覧が出来る前は偽)。 */
function isRemovedPage(page) {
  return page >= 1 && page <= total && posByPage[page] === 0;
}
pagesEl.addEventListener('pointerdown', (ev) => {
  if (!ready || saving || tool === null || ev.button !== 0) return;
  const t = ev.target instanceof Element ? ev.target : null;
  if (t === null) return;
  const box = t.closest('.page');
  if (box === null) return;
  const no = Number(box.getAttribute('data-page'));
  if (isRemovedPage(no)) {
    // 🔴 外したページ: 押さえの層の上でも断る(ペンの線・付箋の欄を出さない ── 下の道具の処理は `isRemovedPage` で手を引く)
    setStatus(REMOVED_PAGE_NO_TOOL);
    return;
  }
  if (t.classList.contains('tool-layer') || no <= total) return;
  setStatus(ADDED_PAGE_NO_TOOL);
});

// ── 付箋: 押した場所に字の欄を出す

function placeFixed(el, x, y) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${String(Math.max(4, Math.min(x, window.innerWidth - w - 4)))}px`;
  el.style.top = `${String(Math.max(4, Math.min(y, window.innerHeight - h - 4)))}px`;
}

function openNoteInput(draft, value, x, y) {
  hideHlPop();
  noteDraft = draft;
  noteInput.value = value;
  noteInputWrap.hidden = false;
  placeFixed(noteInputWrap, x, y);
  noteInput.focus();
}

function hideNoteInput() {
  noteDraft = null;
  noteInputWrap.hidden = true;
}

/** 字の欄をやめる(付けない)。 */
function cancelNoteInput() {
  if (noteDraft === null) return;
  hideNoteInput();
}

pagesEl.addEventListener('click', (ev) => {
  if (!ready || saving || tool !== 'note') return;
  const t = ev.target instanceof Element ? ev.target : null;
  if (t === null || !t.classList.contains('tool-layer')) return;
  const box = t.closest('.page');
  if (box === null) return;
  const page = Number(box.getAttribute('data-page'));
  const vp = pageVp[page];
  if (!vp || isRemovedPage(page)) return;
  const b = box.getBoundingClientRect();
  const at = nt.clientToViewport(ev.clientX, ev.clientY, b, { width: vp.width, height: vp.height });
  // 🔑 場所は押した瞬間に PDF の座標へ直す(字を入れている間に拡大縮小しても、押した場所のまま)
  const rect = nt.noteRect(at[0], at[1], (x, y) => vp.convertToPdfPoint(x, y));
  openNoteInput({ kind: 'new', page, rect }, '', ev.clientX, ev.clientY);
});

noteInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    // 🔴 日本語入力の変換を確定する Enter では付けない
    if (ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    void commitNote();
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    cancelNoteInput();
  }
});
// 欄の外を押したら、字が入っていれば付ける(入っていなければやめる)── 打った字を黙って捨てない
noteInput.addEventListener('blur', () => {
  if (noteDraft !== null) void commitNote();
});

async function commitNote() {
  const d = noteDraft;
  if (d === null) return;
  const text = nt.cleanText(noteInput.value);
  hideNoteInput();
  if (text === null || !ready || saving) return;
  if (!(await canEdit())) return;
  if (saving) return;
  uidSeq += 1;
  if (d.kind === 'new') {
    notes = nt.addNote(notes, { uid: uidSeq, page: d.page, rect: d.rect, text });
    setStatus('付箋を付けました。「別の PDF として保存」で新しい PDF になります');
  } else if (d.kind === 'edit-new') {
    if (!notes.some((n) => n.uid === d.uid)) return;
    notes = nt.editNote(notes, d.uid, text, uidSeq);
    setStatus('付箋を直しました');
  } else {
    // 元の PDF に付いていた付箋を直す = それを外して、同じ場所に直した付箋を付ける
    noteRemovals.set(`${String(d.page)}:${d.id}`, { page: d.page, id: d.id });
    notes = nt.addNote(notes, { uid: uidSeq, page: d.page, rect: d.rect, text });
    setStatus('付箋を直しました。「別の PDF として保存」で新しい PDF になります');
  }
  repaintMarks();
  updateEditUi();
}

// ── 付箋の印に重ねると字が出る

pagesEl.addEventListener('mouseover', (ev) => {
  const t = ev.target instanceof Element ? ev.target.closest('.note-layer > div') : null;
  if (t === null) return;
  noteTip.textContent = t.getAttribute('data-note-text') ?? '';
  noteTip.hidden = false;
  const r = t.getBoundingClientRect();
  placeFixed(noteTip, r.left, r.bottom + 4);
});
pagesEl.addEventListener('mouseout', (ev) => {
  const t = ev.target instanceof Element ? ev.target.closest('.note-layer > div') : null;
  if (t !== null) noteTip.hidden = true;
});

// ── 付箋の印 / ペンの線を押す → 「直す / 外す」

function hideNotePop() {
  noteTarget = null;
  notePop.hidden = true;
  noteTip.hidden = true;
}

function showNotePop(target, x, y) {
  noteTarget = target;
  const removed = target.kind === 'note-existing' && noteRemovals.has(`${String(target.page)}:${target.id}`);
  noteEditBtn.hidden = target.kind === 'stroke' || removed;
  noteRemoveBtn.textContent = removed ? '外すのをやめる' : '外す';
  noteTip.hidden = true;
  notePop.hidden = false;
  hlPopScroll = scroller.scrollTop;
  placeFixed(notePop, x + 6, y + 6);
}

function showNotePopFor(mark, x, y) {
  const page = Number(mark.closest('.page').getAttribute('data-page'));
  const text = mark.getAttribute('data-note-text') ?? '';
  if (mark.getAttribute('data-pkc-field') === 'pdf-note-new') {
    showNotePop({ kind: 'note-new', page, uid: Number(mark.getAttribute('data-note-uid')), text }, x, y);
  } else {
    const id = mark.getAttribute('data-note-id') ?? '';
    const e = (existingNotes[page] || []).find((n) => n.id === id);
    if (e === undefined) return;
    showNotePop({ kind: 'note-existing', page, id, text, rect: e.rect }, x, y);
  }
}

/** 押した位置の下にある、書いた線(いちばん上 = 後から書いた物)。 */
function strokeUnder(box, cx, cy) {
  const page = Number(box.getAttribute('data-page'));
  const vp = pageVp[page];
  if (!vp) return null;
  const b = box.getBoundingClientRect();
  const at = nt.clientToViewport(cx, cy, b, { width: vp.width, height: vp.height });
  // 線の太さの半分 + 押しやすさの余裕(窓の px)
  const tol = (nt.PEN_WIDTH * (vp.scale ?? scale)) / 2 + 5;
  for (let k = strokes.length - 1; k >= 0; k -= 1) {
    const s = strokes[k];
    if (s.page !== page) continue;
    if (nt.strokeHit(s.pts.map((p) => vp.convertToViewportPoint(p[0], p[1])), at[0], at[1], tol)) return s;
  }
  return null;
}

noteEditBtn.addEventListener('click', () => {
  const t = noteTarget;
  hideNotePop();
  if (t === null || t.kind === 'stroke' || !ready || saving) return;
  const mark = pagesEl.querySelector(
    t.kind === 'note-new'
      ? `[data-pkc-field="pdf-note-new"][data-note-uid="${String(t.uid)}"]`
      : `[data-pkc-field="pdf-note-existing"][data-note-id="${t.id}"]`,
  );
  const r = mark === null ? { left: 80, bottom: 80 } : mark.getBoundingClientRect();
  const draft = t.kind === 'note-new' ? { kind: 'edit-new', uid: t.uid } : { kind: 'edit-existing', page: t.page, id: t.id, rect: t.rect };
  openNoteInput(draft, t.text, r.left, r.bottom + 4);
});

noteRemoveBtn.addEventListener('click', () => {
  void removeNoteTarget();
});

async function removeNoteTarget() {
  const t = noteTarget;
  hideNotePop();
  if (t === null || !ready || saving) return;
  if (t.kind === 'stroke') {
    strokes = strokes.filter((s) => s.uid !== t.uid);
    setStatus('線を外しました');
  } else if (t.kind === 'note-new') {
    notes = nt.removeNote(notes, t.uid);
    setStatus('付箋を外しました');
  } else {
    if (!(await canEdit())) return;
    if (saving) return;
    const key = `${String(t.page)}:${t.id}`;
    if (noteRemovals.has(key)) {
      noteRemovals.delete(key);
      setStatus('付箋を外すのをやめました');
    } else {
      noteRemovals.set(key, { page: t.page, id: t.id });
      setStatus('付箋を外します。「別の PDF として保存」で新しい PDF から消えます');
    }
  }
  repaintMarks();
  updateEditUi();
}

// ── ペン: ページの上をなぞる

/** なぞっている線 `{ id, page, box, vp, pts(窓の座標), line(<polyline>) }`(`null` = なぞっていない)。 */
let pen = null;

pagesEl.addEventListener('pointerdown', (ev) => {
  if (!ready || saving || tool !== 'pen' || ev.button !== 0) return;
  const t = ev.target instanceof Element ? ev.target : null;
  if (t === null || !t.classList.contains('tool-layer')) return;
  const box = t.closest('.page');
  const page = box === null ? 0 : Number(box.getAttribute('data-page'));
  const vp = pageVp[page];
  const svg = box === null ? null : box.querySelector(':scope > .ink-layer');
  if (!vp || svg === null || isRemovedPage(page)) return;
  try {
    t.setPointerCapture(ev.pointerId);
  } catch {
    // 取れなくても、枠の中での動きは追える
  }
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', cssRgb(hl.colorOf(penColor).rgb));
  line.setAttribute('stroke-width', String(nt.PEN_WIDTH * (vp.scale ?? scale)));
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  svg.append(line);
  pen = { id: ev.pointerId, page, box, vp, pts: [], line };
  penPoint(ev);
  ev.preventDefault();
});

function penPoint(ev) {
  const b = pen.box.getBoundingClientRect();
  pen.pts.push(nt.clientToViewport(ev.clientX, ev.clientY, b, { width: pen.vp.width, height: pen.vp.height }));
  pen.line.setAttribute('points', pen.pts.map((p) => p.join(',')).join(' '));
}

pagesEl.addEventListener('pointermove', (ev) => {
  if (pen === null || ev.pointerId !== pen.id) return;
  penPoint(ev);
});

async function penEnd(ev, cancelled) {
  if (pen === null || ev.pointerId !== pen.id) return;
  const p = pen;
  pen = null;
  p.line.remove();
  if (cancelled || p.pts.length === 0) return;
  // 🔑 PDF の座標へは離した瞬間に直す(確かめを待つ間に拡大縮小しても、書いた場所のまま)
  const pts = nt.strokeToPdf(p.pts, (x, y) => p.vp.convertToPdfPoint(x, y));
  if (!(await canEdit())) return;
  if (saving) return;
  uidSeq += 1;
  strokes = strokes.concat([{ uid: uidSeq, page: p.page, color: penColor, pts }]);
  repaintMarks();
  updateEditUi();
  setStatus('線を書きました。「別の PDF として保存」で新しい PDF になります');
}
pagesEl.addEventListener('pointerup', (ev) => {
  void penEnd(ev, false);
});
pagesEl.addEventListener('pointercancel', (ev) => {
  void penEnd(ev, true);
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
  releaseThumbs();
  if (ownUrl !== null) URL.revokeObjectURL(ownUrl);
  if (nativeUrl !== null) URL.revokeObjectURL(nativeUrl);
  if (lease !== null) lease.dispose();
  disposeAdded();
  disposeEdit();
});
