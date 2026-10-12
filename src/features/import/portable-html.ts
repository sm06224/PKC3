/**
 * 🔴 **PKC3 入り HTML(`.pkc3.html`)を読む**(#1416)── 取り込む側の入口。
 *
 * 書き出し(`features/export/portable-bundle.ts` の `writePortableBundle`)は、アプリの雛形に
 * ① `<head>` の直後の印(`<script type="application/json" data-pkc-bundle>`)
 * ② 最後の `</body>` の直前に DB の中身(`data-pkc-db-image`)と添付(`data-pkc-asset="<key>"`)
 * を差し込む。ここはその**逆**をやる ── 印で PKC3 入り HTML と見分け、差し込まれた要素を取り出す。
 *
 * ## 🔑 見分けは「書き出しが埋める印」で行う(拡張子では行わない)
 *
 * 名前を変えられても読めるように、`<head>` の頭 `PORTABLE_HEAD_SCAN` 字以内の印だけを見る。
 * PKC2 の単一 HTML にこの印は無いので、取り違えない(同じ綴りは雛形のアプリ本体の JS にも
 * 現れるが、そこは頭の範囲の外 ── 書き出し側が「位置で決める」と書いているのと同じ規則)。
 *
 * ## 🔴 要素は「字面」ではなく「位置」で探す
 *
 * 雛形の大半はアプリ本体の JS で、`data-pkc-db-image` などの綴りがその中に**文字列として
 * 現れる**(書き出しの module 自身がそれである)。だから先頭から検索せず、
 * **最後の `</body>` から後ろ向きに**、`</script>` で終わる要素を 1 つずつ辿る。
 * 辿る相手は書き出しが差し込んだ 2 種類だけで、それ以外の要素に当たったら止まる。
 *
 * ⚠ **最後の `</body>` が無い・中身の要素が無いものは断る**(途中で切れたファイルを
 *   「読めたつもりで 0 件」にしない)。
 */
import { PORTABLE_HEAD_SCAN } from '../export/portable-bundle';
import {
  checkImageParts,
  checkImageShapes,
  decodeImagePart,
  decodeImagePartBytes,
  decodeImageParts,
  groupAssetParts,
  IMAGE_PART_BYTES,
  parseBundleTag,
  shapeOfCounts,
  type Base64Shape,
  type PortableBundle,
} from '../portable/bundle';

/** 先頭から読む長さ(バイト)。印は `PORTABLE_HEAD_SCAN` 字以内だが、多バイト文字の分だけ余裕を持つ。 */
export const PORTABLE_SNIFF_BYTES = 16384;

const BUNDLE_TAG_RE = /<script type="application\/json" data-pkc-bundle>([^<]*)<\/script>/;
// 割った版は `data-pkc-db-image="<番号>/<総数>"`、割る前の版は属性の値が無い(#1416 §7-4)
const IMAGE_OPEN_RE =
  /^<script type="application\/octet-stream;base64" data-pkc-db-image(?:="([^"]*)")?>$/;
const ASSET_OPEN_RE =
  /^<script type="application\/octet-stream;base64" data-pkc-asset="([A-Za-z0-9._-]{1,128})" data-pkc-asset-mime="([^"]*)"(?: data-pkc-asset-part="([^"]*)")?>$/;
const SCRIPT_CLOSE = '</script>';
const BASE64_BODY_RE = /^[A-Za-z0-9+/=\s]*$/;

/** 取り出せなかった理由(画面にそのまま出す文)。 */
export class PortableHtmlError extends Error {}

/**
 * 頭の字から PKC3 入り HTML の印を読む。**読めなければ `null`**(= PKC3 入り HTML ではない)。
 * ⚠ 範囲は `PORTABLE_HEAD_SCAN` 字までに絞る ── 広げると、アプリ本体の JS の中の同じ綴りに当たる。
 */
export function sniffPortableHtml(headText: string): PortableBundle | null {
  const m = BUNDLE_TAG_RE.exec(headText.slice(0, PORTABLE_HEAD_SCAN));
  return m === null ? null : parseBundleTag(m[1]);
}

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

export interface PortableHtmlParts {
  readonly bundle: PortableBundle;
  /** DB の中身(sqlite の画像)。 */
  readonly image: Uint8Array;
  /** 添付(key → 中身)。 */
  readonly assets: Map<string, Blob>;
}

/** 後ろ向きに辿る 1 要素。 */
interface ScanEl {
  readonly isImage: boolean;
  /** DB の中身は `data-pkc-db-image` の値、添付は `data-pkc-asset-part` の値(割る前の版は空)。 */
  readonly mark: string;
  readonly key: string;
  readonly mime: string;
  /** 中身の位置(全文の先頭からの字数)。 */
  readonly from: number;
  readonly to: number;
  /** base64 の字。全文を持つ読み方では辿りで入れる。窓で読む方では空で、復号の直前に読む。 */
  body: string;
  /** 窓で読む方だけ: 辿りの間に測った形(復号を遅らせても、壊れ方の判定は遅らせないため)。 */
  shape: Base64Shape | undefined;
}

type ScanStep =
  | { readonly t: 'more' } // 窓の外にまたがっている ── 前を足して、同じ位置からやり直す
  | { readonly t: 'stop' } // 差し込み領域の外に当たった
  | { readonly t: 'el'; readonly el: ScanEl; readonly next: number };

/**
 * 辿りが読む「窓」。全文を字で持つ読み方(`readPortableHtml`)は字、窓で読む読み方(`readPortableHtmlBlob`)は bytes。
 * 🔴 **辿りの規則(`scanStep`)は 1 つ** ── 窓の持ち方が違うだけで、どの要素が差し込みで、どこで止まり、何を壊れとして断るかは同じ。
 *   窓で読む方が字にしないのは、base64 の本体(数 MB)を字にして捨てると、ファイルと同じ量の字が回収されないまま常駐するため(#1416 の実測)。
 */
interface Hay {
  at(i: number): number;
  /** `<` の最後の位置(`from` 以前)。無ければ -1。 */
  lastLt(from: number): number;
  /** `>` の最初の位置(`from` 以降)。無ければ -1。 */
  firstGt(from: number): number;
  /** [end - 9, end) が `</script>` か。 */
  closeBefore(end: number): boolean;
  /** 開きタグの字(短い)。 */
  tag(from: number, to: number): string;
  /** [from, to) が base64(と空白)だけか。字を持つ読み方は字も返す。窓で読む読み方は形(`shape`)を返す。 */
  body(from: number, to: number): { ok: boolean; text: string; shape?: Base64Shape };
}

/** 字の窓(全文を持つ読み方)。 */
function textHay(text: string): Hay {
  return {
    at: (i) => text.charCodeAt(i),
    lastLt: (from) => text.lastIndexOf('<', from),
    firstGt: (from) => text.indexOf('>', from),
    closeBefore: (end) => text.slice(end - SCRIPT_CLOSE.length, end) === SCRIPT_CLOSE,
    tag: (from, to) => text.slice(from, to),
    body: (from, to) => {
      const t = text.slice(from, to);
      return { ok: BASE64_BODY_RE.test(t), text: t };
    },
  };
}

// base64 の本体の 1 byte の種類(0 = base64 でも空白でもない / 1 = base64 の字 / 2 = 空白 / 3 = `=`)
// ⚠ 空白は正規表現の `\s` の latin1 の範囲(TAB LF VT FF CR SP NBSP)── 字で読む方(`BASE64_BODY_RE`)と同じ集合
const BYTE_KIND = (() => {
  const k = new Uint8Array(256);
  for (let c = 0x30; c <= 0x39; c++) k[c] = 1;
  for (let c = 0x41; c <= 0x5a; c++) k[c] = 1;
  for (let c = 0x61; c <= 0x7a; c++) k[c] = 1;
  k[0x2b] = 1;
  k[0x2f] = 1;
  k[0x3d] = 3;
  for (const c of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0]) k[c] = 2;
  return k;
})();

const LATIN1 = new TextDecoder('latin1');

/** bytes の窓(窓で読む読み方)。base64 の本体は**字にせず**、1 byte ずつ見て形だけを測る。 */
function bytesHay(bytes: Uint8Array): Hay {
  return {
    at: (i) => bytes[i]!,
    lastLt: (from) => bytes.lastIndexOf(0x3c, from),
    firstGt: (from) => bytes.indexOf(0x3e, from),
    closeBefore: (end) => {
      for (let i = 0; i < SCRIPT_CLOSE.length; i++) {
        if (bytes[end - SCRIPT_CLOSE.length + i] !== SCRIPT_CLOSE.charCodeAt(i)) return false;
      }
      return true;
    },
    tag: (from, to) => LATIN1.decode(bytes.subarray(from, to)),
    body: (from, to) => {
      let chars = 0;
      let firstEq = -1;
      let last1 = 0;
      let last2 = 0;
      for (let i = from; i < to; i++) {
        const c = bytes[i]!;
        const k = BYTE_KIND[c]!;
        if (k === 2) continue;
        if (k === 0) return { ok: false, text: '' };
        if (k === 3 && firstEq < 0) firstEq = chars;
        chars++;
        last2 = last1;
        last1 = c;
      }
      const pad = last1 === 0x3d ? (last2 === 0x3d ? 2 : 1) : 0;
      return { ok: true, text: '', shape: shapeOfCounts(chars, pad, firstEq) };
    },
  };
}

/**
 * 後ろ向きの辿りの 1 歩。`hay` は全文か、その後ろ側の窓。`base` は窓の先頭の全文での位置、`pos` は辿りの現在地(全文での位置)。
 * ⚠ 全文を持つ読み方(`readPortableHtml`)と窓で読む読み方(`readPortableHtmlBlob`)の**両方がこの 1 つを通る**
 *   (どの要素が差し込みで、どこで止まり、何を壊れとして断るか ── 規則を 2 か所に持たない)。
 */
function scanStep(hay: Hay, base: number, pos: number): ScanStep {
  // 窓の先頭に当たった = 前に続きがあるかもしれない(全文なら、そこが本当の先頭 = 止まる)
  const edge: ScanStep = base > 0 ? { t: 'more' } : { t: 'stop' };
  let end = pos - base;
  while (end > 0 && isSpace(hay.at(end - 1))) end--;
  if (end < SCRIPT_CLOSE.length) return edge;
  if (!hay.closeBefore(end)) return { t: 'stop' };
  const closeAt = end - SCRIPT_CLOSE.length;
  // 🔑 中身は base64(`<` を含まない)なので、直前の `<` が開きタグの頭である。
  //   `lastIndexOf('<script')` だと、直前の要素(アプリ本体の JS)の**文字列の中**の同じ綴りに当たる
  const start = hay.lastLt(closeAt - 1);
  if (start < 0) return edge;
  const tagEnd = hay.firstGt(start);
  if (tagEnd < 0 || tagEnd >= closeAt) return { t: 'stop' };
  const tag = hay.tag(start, tagEnd + 1);
  const body = hay.body(tagEnd + 1, closeAt);
  // 差し込まれた要素の中身は base64 だけ。そうでなければ別の要素の終わりに当たっている(止まる)
  const im = IMAGE_OPEN_RE.exec(tag);
  if (!body.ok) {
    // 🔴 印が 番号/総数 の形の DB の中身の要素なのに base64 でない = 壊れた部分。「中身が見つかりません」と言い換えない。
    // ⚠ 印の値が空の形(割る前の版)は**見ない** ── 雛形のアプリ本体の JS が文字列として持つ綴りと同じで、
    //   辿りの終わり(差し込み領域の外)に当たったという合図でしかない
    if (im !== null && /^\d+\/\d+$/.test(im[1] ?? '')) {
      throw new PortableHtmlError(
        `DB の中身の一部が読み取れません(${Number(im[1]!.split('/')[0]) + 1} 個目が base64 の形になっていません)。このファイルは取り込めません`,
      );
    }
    // 🔴 割った添付の部分も同じ ── base64 でない部分を「差し込み領域の外」と読んで、後ろの添付ごと黙って落とさない
    const ap = ASSET_OPEN_RE.exec(tag);
    if (ap !== null && /^\d+\/\d+$/.test(ap[3] ?? '')) {
      throw new PortableHtmlError(
        `添付「${ap[1]!}」の一部が読み取れません(${Number(ap[3]!.split('/')[0]) + 1} 個目が base64 の形になっていません)。このファイルは取り込めません`,
      );
    }
    return { t: 'stop' };
  }
  const from = base + tagEnd + 1;
  const to = base + closeAt;
  const next = base + start;
  const text = body.text;
  const shape = body.shape;
  if (im !== null) {
    return { t: 'el', el: { isImage: true, mark: im[1] ?? '', key: '', mime: '', from, to, body: text, shape }, next };
  }
  const am = ASSET_OPEN_RE.exec(tag);
  if (am === null) return { t: 'stop' }; // 書き出しが差し込んだ 2 種類以外に当たった = 差し込み領域の外
  return {
    t: 'el',
    el: { isImage: false, mark: am[3] ?? '', key: am[1]!, mime: am[2]!, from, to, body: text, shape },
    next,
  };
}

const NO_END_BODY =
  'ファイルが最後まで書き込まれていません(終わりの </body> が見つかりません)。' +
  '書き出し直すか、バックアップ(.pkc3-full.zip)から取り込んでください';
const NO_IMAGE =
  'ファイルの中に、ノートの中身が見つかりません。書き出し直すか、バックアップ(.pkc3-full.zip)から取り込んでください';

/** 割って焼いた 1 件の添付(文書の順の要素)を 1 つの Blob にする。読んだ字は要素から手放す。 */
function decodeAssetRun(els: readonly ScanEl[]): Blob {
  const first = els[0]!;
  const key = first.key;
  try {
    // 読んだ要素は配列から手放す。割る前の版の 1 本物(1 要素)も同じ口で読む
    const bytes = decodeImageParts(
      els.map((e) => () => {
        const b = e.body;
        e.body = '';
        return b;
      }),
      `添付「${key}」の中身`,
    );
    // 空の 1 要素 = 0 バイトの添付(割る前の版もそのまま取り込んでいた)
    return new Blob(bytes === null ? [] : [bytes as unknown as BlobPart], { type: first.mime });
  } catch (e) {
    throw assetDecodeError(e, key);
  }
}

/** 添付の復号の失敗 → 画面に出す断り文。⚠ 全文で読む方・窓で読む方の**両方がこの 1 つ**を通る。 */
function assetDecodeError(e: unknown, key: string): PortableHtmlError {
  return new PortableHtmlError(
    e instanceof Error && /個目|空の部分/.test(e.message)
      ? `${e.message}。このファイルは取り込めません`
      : `埋め込まれた添付が読み取れない形になっています: ${key}`,
  );
}

/** DB の中身の要素の印が、1 つの画像として揃っているかを見る。揃っていなければ断る。 */
function assertImageMarks(imageEls: readonly ScanEl[]): void {
  const broken = checkImageParts(imageEls.map((p) => p.mark));
  if (broken !== null) throw new PortableHtmlError(`${broken}。このファイルは取り込めません`);
}

/** DB の中身の要素(文書の順)を 1 本の bytes にする。揃っていない・空なら断る。 */
function decodeImage(imageEls: readonly ScanEl[]): Uint8Array {
  assertImageMarks(imageEls);
  let image: Uint8Array | null;
  try {
    // 読んだ要素は配列から手放す
    image = decodeImageParts(
      imageEls.map((p) => () => {
        const b = p.body;
        p.body = '';
        return b;
      }),
    );
  } catch (e) {
    throw new PortableHtmlError(
      e instanceof Error && /個目|空の部分/.test(e.message)
        ? `${e.message}。このファイルは取り込めません`
        : '埋め込まれた中身が読み取れない形になっています',
    );
  }
  if (image === null || image.byteLength === 0) throw new PortableHtmlError(NO_IMAGE);
  return image;
}

/**
 * `decodeImage` の窓で読む版: 要素を 1 つ読んでは、その場で 1 本の bytes の自分の置き場へ復号する(base64 の字を全部は持たない)。
 * 断る形は辿りで測った形(`checkImageShapes`)で `decodeImage` と同じ文で断る。
 */
async function decodeImageBlob(blob: Blob, imageEls: readonly ScanEl[]): Promise<Uint8Array> {
  let total: number | null;
  try {
    total = checkImageShapes(imageEls.map((p) => p.shape!));
  } catch (e) {
    throw new PortableHtmlError(
      e instanceof Error && /個目|空の部分/.test(e.message)
        ? `${e.message}。このファイルは取り込めません`
        : '埋め込まれた中身が読み取れない形になっています',
    );
  }
  if (total === null || total === 0) throw new PortableHtmlError(NO_IMAGE);
  const out = new Uint8Array(total);
  for (let k = 0; k < imageEls.length; k++) {
    const e = imageEls[k]!;
    const bytes = k < imageEls.length - 1 ? IMAGE_PART_BYTES : total - k * IMAGE_PART_BYTES;
    const raw = await readBytes(blob, e.from, e.to);
    out.set(
      e.shape!.chars === raw.length ? decodeImagePartBytes(raw, bytes) : decodeImagePart(LATIN1.decode(raw), bytes),
      k * IMAGE_PART_BYTES,
    );
  }
  return out;
}

/**
 * PKC3 入り HTML の全文から、DB の中身と添付を取り出す。
 * ⚠ 全文を字として持つ読み方。**大きいファイルは `readPortableHtmlBlob`**(取り込みの道はそちら)。
 * @throws {PortableHtmlError} 印が無い / 最後まで書き込まれていない / 中身が読み取れない
 */
export function readPortableHtml(text: string): PortableHtmlParts {
  const bundle = sniffPortableHtml(text.slice(0, PORTABLE_SNIFF_BYTES));
  if (bundle === null) {
    throw new PortableHtmlError('PKC3 入り HTML ではありません(先頭の目印が見つかりません)');
  }
  let pos = text.lastIndexOf('</body>');
  if (pos < 0) throw new PortableHtmlError(NO_END_BODY);
  // 後ろ向きに辿るので、DB の中身の要素は**文書の逆順**で集まる(最後に並べ直す)
  const imageEls: ScanEl[] = [];
  const assetEls: ScanEl[] = [];
  const hay = textHay(text);
  for (;;) {
    const step = scanStep(hay, 0, pos);
    if (step.t !== 'el') break;
    (step.el.isImage ? imageEls : assetEls).push(step.el);
    pos = step.next;
  }
  imageEls.reverse();
  assetEls.reverse();
  // 🔑 添付は**文書の順に塊にし、後ろの塊から**読む(同じ key が 2 度あれば後ろが勝つ ── 割る前の版と同じ)
  const assets = new Map<string, Blob>();
  const runs = groupAssetParts(assetEls);
  for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r]!;
    const els = assetEls.slice(run.start, run.start + run.count);
    const key = els[0]!.key;
    if (assets.has(key)) {
      for (const e of els) e.body = '';
      continue;
    }
    if (run.broken !== null) {
      throw new PortableHtmlError(`${run.broken}。このファイルは取り込めません`);
    }
    assets.set(key, decodeAssetRun(els));
  }
  return { bundle, image: decodeImage(imageEls), assets };
}

/**
 * 🔴 **窓で読む読み方の窓(字数 = bytes 数)。**
 *
 * `file.text()` で全文を 1 つの字にすると、全文が UTF-16 に復号されるので、実測(Chromium、乱数の添付 300MB の
 * `.pkc3.html` = 432MB)で **renderer がファイルの約 4.5 倍(2.1GB)**まで膨らみ、復号の間(約 9 秒)
 * 約 1GB を抱え続けた。窓なら、辿りの間に持つ字は窓の分(この大きさ + 1 要素)、復号の間は 1 件の添付の分だけである。
 */
export const WINDOW_CHARS = 8 * 1024 * 1024;

/**
 * [from, to) を字にする。🔑 **latin1(1 byte = 1 字)**で復号する ── 字の位置と bytes の位置が 1 対 1 になり、
 * 窓を bytes の位置で切れる。差し込み領域は ASCII(開きタグと base64)だけなので、UTF-8 の多バイト字が入る
 * 雛形の側がどう読めても、取り出すものは変わらない。
 */
async function readChars(blob: Blob, from: number, to: number): Promise<string> {
  return new TextDecoder('latin1').decode(await blob.slice(from, to).arrayBuffer());
}

/** 最後の `</body>` の位置。無ければ -1。後ろから窓ずつ探す。 */
async function lastIndexOfBodyClose(blob: Blob): Promise<number> {
  const needle = '</body>';
  let end = blob.size;
  for (;;) {
    const from = Math.max(0, end - WINDOW_CHARS);
    const i = (await readChars(blob, from, end)).lastIndexOf(needle);
    if (i >= 0) return from + i;
    if (from === 0) return -1;
    end = from + needle.length - 1; // 窓の継ぎ目にまたがる綴りを落とさない
  }
}

/** [from, to) を bytes にする。 */
async function readBytes(blob: Blob, from: number, to: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(from, to).arrayBuffer());
}

/**
 * 最後の `</body>` から後ろ向きに辿って、差し込まれた要素(文書の順)を集める。
 * 🔴 窓は**字にしない**(bytes のまま)。base64 の本体を字にして捨てると、ファイルと同じ量の字が回収されないまま
 * 常駐した(実測: 432MB のファイルで renderer の JS ヒープが約 480MB)。本体は 1 byte ずつ見て形だけを測る。
 */
async function scanBlob(
  blob: Blob,
  bodyClose: number,
): Promise<{ imageEls: ScanEl[]; assetEls: ScanEl[] }> {
  const imageEls: ScanEl[] = [];
  const assetEls: ScanEl[] = [];
  let pos = bodyClose;
  let base = Math.max(0, pos - WINDOW_CHARS);
  let win = await readBytes(blob, base, pos);
  let hay = bytesHay(win);
  for (;;) {
    const step = scanStep(hay, base, pos);
    if (step.t === 'more') {
      // 窓にまたがる要素 ── 前を足してやり直す。足す量は窓の大きさ以上(大きい 1 要素にも倍々で届く)
      base = Math.max(0, base - Math.max(WINDOW_CHARS, pos - base));
      win = await readBytes(blob, base, pos);
      hay = bytesHay(win);
      continue;
    }
    if (step.t === 'stop') break;
    (step.el.isImage ? imageEls : assetEls).push(step.el);
    pos = step.next;
  }
  // 後ろ向きに辿ったので逆順で集まっている(文書の順へ並べ直す)
  return { imageEls: imageEls.reverse(), assetEls: assetEls.reverse() };
}

/** 添付 1 件。中身は**開くまで復号しない**(`open` を呼んだ分だけ、その 1 件の分が要る)。 */
export interface LazyPortableAsset {
  readonly mime: string;
  /** 復号後の bytes 数。⚠ 読まずに分かる(辿りで測った形から出す)。 */
  readonly size: number;
  /** 窓で読み直して復号し、Blob にする。呼ぶたびに作り直す。 */
  open(): Promise<Blob>;
}

export interface PortableHtmlLazyParts {
  readonly bundle: PortableBundle;
  /** DB の中身(sqlite の画像)。 */
  readonly image: Uint8Array;
  /** 添付(key → 開くまで読まない中身)。 */
  readonly assets: Map<string, LazyPortableAsset>;
}

/**
 * 1 件の添付(文書の順の要素の塊)を開く口。🔴 **base64 の字を 1 件ぶん持たない** ──
 * 要素(`IMAGE_PART_BYTES` ごと)を 1 つ読み、その場で bytes にして Blob へ足し、字を手放す。
 * 足し方は `new Blob([これまで, 今の要素])` ── これまでの Blob は**参照のまま**繋がるので、
 * JS 側が同時に持つのは要素 1 つ分の字と bytes だけである(添付が何百 MB でも変わらない)。
 */
function lazyAsset(blob: Blob, els: readonly ScanEl[], total: number | null): LazyPortableAsset {
  const mime = els[0]!.mime;
  const n = els.length;
  return {
    mime,
    size: total ?? 0,
    async open(): Promise<Blob> {
      let acc: Blob | null = null;
      if (total !== null) {
        for (let k = 0; k < n; k++) {
          const e = els[k]!;
          const bytes = k < n - 1 ? IMAGE_PART_BYTES : total - (n - 1) * IMAGE_PART_BYTES;
          const raw = await readBytes(blob, e.from, e.to);
          // 空白の混ざらない形(書き出しはこれ)は字にせず bytes のまま復号する。空白が混ざっていれば字にして畳む
          const part =
            e.shape!.chars === raw.length
              ? decodeImagePartBytes(raw, bytes)
              : decodeImagePart(LATIN1.decode(raw), bytes);
          acc = new Blob(acc === null ? [part as unknown as BlobPart] : [acc, part as unknown as BlobPart]);
        }
      }
      // 空の 1 要素 = 0 バイトの添付(割る前の版もそのまま取り込んでいた)
      return new Blob(acc === null ? [] : [acc], { type: mime });
    },
  };
}

/**
 * ファイルを窓で読んで、DB の中身と添付の**目録**を返す。添付の復号は**開くまでしない**(`LazyPortableAsset.open`)。
 * 何を取り出し何を断るかは `readPortableHtml` と同じ ── 断り文・断る順番も同じ
 * (復号が断る形は、辿りで測った形(`checkImageShapes`)で同じ所で断る)。
 * @throws {PortableHtmlError} `readPortableHtml` と同じ
 */
export async function openPortableHtmlBlob(blob: Blob): Promise<PortableHtmlLazyParts> {
  const bundle = sniffPortableHtml(
    new TextDecoder().decode(await blob.slice(0, PORTABLE_SNIFF_BYTES).arrayBuffer()),
  );
  if (bundle === null) {
    throw new PortableHtmlError('PKC3 入り HTML ではありません(先頭の目印が見つかりません)');
  }
  const bodyClose = await lastIndexOfBodyClose(blob);
  if (bodyClose < 0) throw new PortableHtmlError(NO_END_BODY);

  // ① 辿る ── 要素の位置と印と形だけを控える(字は窓の分しか持たず、辿りが終われば手放す)
  const { imageEls, assetEls } = await scanBlob(blob, bodyClose);

  // ② 添付は**文書の順に塊にし、後ろの塊から**目録にする(`readPortableHtml` と同じ順・同じ規則)
  const assets = new Map<string, LazyPortableAsset>();
  const runs = groupAssetParts(assetEls);
  for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r]!;
    const els = assetEls.slice(run.start, run.start + run.count);
    const key = els[0]!.key;
    if (assets.has(key)) continue; // 同じ key は後ろが勝つ ── 読まずに捨てる
    if (run.broken !== null) {
      throw new PortableHtmlError(`${run.broken}。このファイルは取り込めません`);
    }
    let total: number | null;
    try {
      total = checkImageShapes(
        els.map((e) => e.shape!),
        `添付「${key}」の中身`,
      );
    } catch (e) {
      throw assetDecodeError(e, key);
    }
    assets.set(key, lazyAsset(blob, els, total));
  }
  // DB の中身は、揃っていないものを読む前に断る(`decodeImage` も同じ検査をする ── 順番は `readPortableHtml` と同じ)
  assertImageMarks(imageEls);
  return { bundle, image: await decodeImageBlob(blob, imageEls), assets };
}

/**
 * `readPortableHtml` と同じ結果を、**ファイルを窓で読んで**返す(添付は全部 Blob にして返す)。
 * 取り込みの道は `openPortableHtmlBlob`(確認の後まで復号しない)── こちらは全件を開いて確かめたい側(test)のために残す。
 * @throws {PortableHtmlError} `readPortableHtml` と同じ
 */
export async function readPortableHtmlBlob(blob: Blob): Promise<PortableHtmlParts> {
  const lazy = await openPortableHtmlBlob(blob);
  const assets = new Map<string, Blob>();
  for (const [key, a] of lazy.assets) assets.set(key, await a.open());
  return { bundle: lazy.bundle, image: lazy.image, assets };
}
