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
  decodeImageParts,
  groupAssetParts,
  parseBundleTag,
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

/**
 * PKC3 入り HTML の全文から、DB の中身と添付を取り出す。
 * @throws {PortableHtmlError} 印が無い / 最後まで書き込まれていない / 中身が読み取れない
 */
export function readPortableHtml(text: string): PortableHtmlParts {
  const bundle = sniffPortableHtml(text.slice(0, PORTABLE_SNIFF_BYTES));
  if (bundle === null) {
    throw new PortableHtmlError('PKC3 入り HTML ではありません(先頭の目印が見つかりません)');
  }
  let pos = text.lastIndexOf('</body>');
  if (pos < 0) {
    throw new PortableHtmlError(
      'ファイルが最後まで書き込まれていません(終わりの </body> が見つかりません)。' +
        '書き出し直すか、バックアップ(.pkc3-full.zip)から取り込んでください',
    );
  }
  // 後ろ向きに辿るので、DB の中身の要素は**文書の逆順**で集まる(最後に並べ直す)
  const imageParts: Array<{ mark: string; body: string }> = [];
  const assetEls: Array<{ key: string; mime: string; mark: string; body: string }> = [];
  for (;;) {
    let end = pos;
    while (end > 0 && isSpace(text.charCodeAt(end - 1))) end--;
    if (end < SCRIPT_CLOSE.length || text.slice(end - SCRIPT_CLOSE.length, end) !== SCRIPT_CLOSE) break;
    const closeAt = end - SCRIPT_CLOSE.length;
    // 🔑 中身は base64(`<` を含まない)なので、直前の `<` が開きタグの頭である。
    //   `lastIndexOf('<script')` だと、直前の要素(アプリ本体の JS)の**文字列の中**の同じ綴りに当たる
    const start = text.lastIndexOf('<', closeAt - 1);
    if (start < 0) break;
    const tagEnd = text.indexOf('>', start);
    if (tagEnd < 0 || tagEnd >= closeAt) break;
    const tag = text.slice(start, tagEnd + 1);
    const body = text.slice(tagEnd + 1, closeAt);
    // 差し込まれた要素の中身は base64 だけ。そうでなければ別の要素の終わりに当たっている(止まる)
    const im = IMAGE_OPEN_RE.exec(tag);
    if (!BASE64_BODY_RE.test(body)) {
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
      break;
    }
    if (im !== null) {
      imageParts.push({ mark: im[1] ?? '', body });
    } else {
      const am = ASSET_OPEN_RE.exec(tag);
      if (am === null) break; // 書き出しが差し込んだ 2 種類以外に当たった = 差し込み領域の外
      assetEls.push({ key: am[1]!, mime: am[2]!, mark: am[3] ?? '', body });
    }
    pos = start;
  }
  imageParts.reverse();
  assetEls.reverse();
  // 🔑 添付は**文書の順に塊にし、後ろの塊から**読む(同じ key が 2 度あれば後ろが勝つ ── 割る前の版と同じ)
  const assets = new Map<string, Blob>();
  const runs = groupAssetParts(assetEls);
  for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r]!;
    const first = assetEls[run.start]!;
    const els = assetEls.slice(run.start, run.start + run.count);
    const key = first.key;
    if (assets.has(key)) {
      for (const e of els) e.body = '';
      continue;
    }
    if (run.broken !== null) {
      throw new PortableHtmlError(`${run.broken}。このファイルは取り込めません`);
    }
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
      assets.set(key, new Blob(bytes === null ? [] : [bytes as unknown as BlobPart], { type: first.mime }));
    } catch (e) {
      throw new PortableHtmlError(
        e instanceof Error && /個目|空の部分/.test(e.message)
          ? `${e.message}。このファイルは取り込めません`
          : `埋め込まれた添付が読み取れない形になっています: ${key}`,
      );
    }
  }
  const broken = checkImageParts(imageParts.map((p) => p.mark));
  if (broken !== null) {
    throw new PortableHtmlError(`${broken}。このファイルは取り込めません`);
  }
  let image: Uint8Array | null;
  try {
    // 読んだ要素は配列から手放す(残すのはファイル全体の文字列の切り出しだけ)
    image = decodeImageParts(
      imageParts.map((p, i) => () => {
        const b = p.body;
        imageParts[i] = { mark: p.mark, body: '' };
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
  if (image === null || image.byteLength === 0) {
    throw new PortableHtmlError(
      'ファイルの中に、ノートの中身が見つかりません。書き出し直すか、バックアップ(.pkc3-full.zip)から取り込んでください',
    );
  }
  return { bundle, image, assets };
}
