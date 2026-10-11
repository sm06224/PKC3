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
import { parseBundleTag, type PortableBundle } from '../portable/bundle';

/** 先頭から読む長さ(バイト)。印は `PORTABLE_HEAD_SCAN` 字以内だが、多バイト文字の分だけ余裕を持つ。 */
export const PORTABLE_SNIFF_BYTES = 16384;

const BUNDLE_TAG_RE = /<script type="application\/json" data-pkc-bundle>([^<]*)<\/script>/;
const IMAGE_OPEN = '<script type="application/octet-stream;base64" data-pkc-db-image>';
const ASSET_OPEN_RE =
  /^<script type="application\/octet-stream;base64" data-pkc-asset="([A-Za-z0-9._-]{1,128})" data-pkc-asset-mime="([^"]*)">$/;
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

/** base64 を小分けにして復号する(巨大な中間文字列を 1 本作らない)。 */
function decodeBase64Chunked(b64: string): Uint8Array {
  // 空白・改行を除く(混ざると、小分けの境目が 4 字の倍数からずれて、`atob` が黙って部分復号する)
  const text = /\s/.test(b64) ? b64.replace(/\s+/g, '') : b64;
  // 3 の倍数ごとに区切るので、4 字の倍数で切る
  const STEP = 4 * 262144;
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < text.length; i += STEP) {
    const bin = atob(text.slice(i, i + STEP));
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    parts.push(bytes);
    total += bytes.length;
  }
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

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
  let image: Uint8Array | null = null;
  const assets = new Map<string, Blob>();
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
    if (!BASE64_BODY_RE.test(body)) break;
    if (tag === IMAGE_OPEN) {
      if (image !== null) {
        throw new PortableHtmlError('中身(DB)が 2 つ入っています。このファイルは取り込めません');
      }
      try {
        image = decodeBase64Chunked(body);
      } catch {
        throw new PortableHtmlError('埋め込まれた中身が読み取れない形になっています');
      }
    } else {
      const am = ASSET_OPEN_RE.exec(tag);
      if (am === null) break; // 書き出しが差し込んだ 2 種類以外に当たった = 差し込み領域の外
      const [, key, mime] = am;
      if (!assets.has(key!)) {
        try {
          assets.set(key!, new Blob([decodeBase64Chunked(body) as unknown as BlobPart], { type: mime! }));
        } catch {
          throw new PortableHtmlError(`埋め込まれた添付が読み取れない形になっています: ${key!}`);
        }
      }
    }
    pos = start;
  }
  if (image === null || image.byteLength === 0) {
    throw new PortableHtmlError(
      'ファイルの中に、ノートの中身が見つかりません。書き出し直すか、バックアップ(.pkc3-full.zip)から取り込んでください',
    );
  }
  return { bundle, image, assets };
}
