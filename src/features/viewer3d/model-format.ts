/**
 * 🔴 **3D モデルの形式判定と「外へ取りに行かない」検査**(v4.0 Phase 3 / PR-12、ビジョン 1-B)。
 *
 * 添付の 3D ビューア(`detail.ts` の添付プレビュー)と ` ```3d ` の囲みの両方が、ここ 1 本で判定する
 * (CLAUDE.md §7「同じ判定を複数の場所に書かない」)。
 *
 * ## 守ること
 *
 * - **ローカル完結**: 3D モデルの中に書かれた参照(glTF の `buffers[].uri` / `images[].uri`)が
 *   `http:` / `https:` / `//` / 相対パスなら**読む前に断る**。読み込み中の URL も `isAllowedLocal3dUrl` で
 *   1 件ずつ検める(adapter の `LoadingManager.setURLModifier`)── 二段で塞ぐ。
 * - **ブラウザの MIME を信じすぎない**: `.obj` / ASCII の `.stl` は `text/plain`、`.glb` は
 *   `application/octet-stream` や空文字で渡ってくる。拡張子と中身の先頭(`sniff3dModelFormat`)で補う。
 *
 * ⚠ **pure module**。browser API を使わない。
 */

/** 扱える 3D モデルの形式。 */
export type Model3dFormat = 'glb' | 'gltf' | 'stl' | 'obj';

/** 画面に出す形式の名前(ツールバーの表示)。 */
export const MODEL3D_FORMAT_LABEL: Readonly<Record<Model3dFormat, string>> = {
  glb: 'GLB',
  gltf: 'glTF',
  stl: 'STL',
  obj: 'OBJ',
};

/** MIME → 形式。⚠ 小文字・パラメータ(`;charset=…`)を落としてから引く。 */
const MIME_FORMAT: Readonly<Record<string, Model3dFormat>> = {
  'model/gltf-binary': 'glb',
  'model/gltf+json': 'gltf',
  'model/stl': 'stl',
  'model/x.stl-binary': 'stl',
  'model/x.stl-ascii': 'stl',
  'application/sla': 'stl',
  'application/vnd.ms-pki.stl': 'stl',
  'model/obj': 'obj',
};

/** 拡張子 → 形式。 */
const EXT_FORMAT: Readonly<Record<string, Model3dFormat>> = {
  glb: 'glb',
  gltf: 'gltf',
  stl: 'stl',
  obj: 'obj',
};

function normalizeMime(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0]!.trim().toLowerCase();
}

/** ファイル名の拡張子(小文字・点なし)。拡張子が無ければ空文字。 */
function extOf(fileName: string | null | undefined): string {
  const name = (fileName ?? '').trim();
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = name.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 🔴 **3D モデルかどうか・どの形式かの正本**。
 *
 * 1. MIME が 3D の種類を名乗っていれば、それに従う。
 * 2. 名乗っていなければ(`text/plain` / `application/octet-stream` / 空文字 / 拡張子を知らない種類)、
 *    拡張子(大文字小文字は無視)で決める。
 * 3. どちらでも分からなければ `null`(3D ではない)。
 */
export function detect3dModelFormat(
  mime?: string | null,
  fileName?: string | null,
): Model3dFormat | null {
  const byMime = MIME_FORMAT[normalizeMime(mime)];
  if (byMime !== undefined) return byMime;
  return EXT_FORMAT[extOf(fileName)] ?? null;
}

/** 先頭の数バイトを ASCII として読む(範囲外は空)。 */
function asciiAt(bytes: Uint8Array, start: number, len: number): string {
  let s = '';
  const end = Math.min(bytes.length, start + len);
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/**
 * 🔑 **中身の先頭から形式を言い当てる**(名前も MIME も手がかりにならないとき ── ` ```3d ` の
 *   `asset:鍵` は名前を持たない)。
 *
 * @param head 先頭の塊(数 KB で足りる)。
 * @param totalSize ファイル全体の大きさ(バイナリ STL の長さの整合を見る)。
 */
export function sniff3dModelFormat(head: Uint8Array, totalSize: number = head.length): Model3dFormat | null {
  if (head.length >= 4 && asciiAt(head, 0, 4) === 'glTF') return 'glb';
  // バイナリ STL: 80 バイトの見出し + 三角形の数(u32 LE)+ 50 バイト × 数
  if (head.length >= 84) {
    const count = head[80]! | (head[81]! << 8) | (head[82]! << 16) | (head[83]! * 0x1000000);
    if (count > 0 && 84 + count * 50 === totalSize) return 'stl';
  }
  const text = asciiAt(head, 0, Math.min(head.length, 4096)).replace(/^\uFEFF/, '');
  const trimmed = text.trimStart();
  if (/^solid\b/i.test(trimmed) && /\bfacet\b/i.test(trimmed)) return 'stl';
  if (trimmed.startsWith('{') && /"asset"\s*:/.test(trimmed)) return 'gltf';
  // OBJ: 行頭の `v ` / `f ` / `o ` / `g ` / `mtllib` / `#`(コメント)だけで組まれた字
  if (/^(?:#[^\n]*\n|\s*\n)*\s*(?:v|vn|vt|f|o|g|mtllib|usemtl|s)\s/m.test(trimmed) && /^v\s+-?[\d.]/m.test(trimmed)) {
    return 'obj';
  }
  return null;
}

/**
 * 🔴 **読み込み中に許す URL**(`LoadingManager.setURLModifier` が 1 件ずつ聞く)。
 *
 * - `data:` は**安全なバイナリ・画像の種類だけ**(`javascript:` / `text/html` / `image/svg+xml` / 種類なしは断る)。
 * - `blob:` は**呼び側が明示的に許した物だけ**(この画面で自分が作った URL)。
 * - それ以外(`http:` / `https:` / `//` / 相対パス / `file:` …)はすべて断る。
 */
export function isAllowedLocal3dUrl(url: string, allowedBlobUrls?: ReadonlySet<string>): boolean {
  const u = url.trim();
  const lower = u.toLowerCase();
  if (lower.startsWith('blob:')) return allowedBlobUrls?.has(u) ?? false;
  if (!lower.startsWith('data:')) return false;
  const comma = lower.indexOf(',');
  if (comma < 0) return false;
  const head = lower.slice(5, comma);
  const mime = head.split(';')[0]!.trim();
  return SAFE_DATA_MIMES.has(mime);
}

/** `data:` に許す種類。⚠ SVG は script を持てるので入れない。 */
const SAFE_DATA_MIMES: ReadonlySet<string> = new Set([
  'application/octet-stream',
  'application/gltf-buffer',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
]);

/** 外部参照の理由文。⚠ 長い URL はそのまま出さず、先頭だけにする。 */
function refLabel(uri: string): string {
  const s = uri.length > 60 ? `${uri.slice(0, 57)}…` : uri;
  return s;
}

/**
 * 🔴 **`.gltf`(JSON)の中の参照を、読む前に検める**。
 *
 * `buffers[].uri` / `images[].uri` に `data:` 以外(外部 URL・相対パスの `.bin` / 画像)があれば断る。
 * `uri` の無い項目(GLB の BIN 塊・`bufferView` の画像)は問題ない。
 */
export function validateLocalGltfJson(jsonText: string): { ok: true } | { ok: false; reason: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: 'glTF の JSON が読めません(書式が正しくありません)' };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, reason: 'glTF の JSON の形が違います' };
  }
  const d = doc as { buffers?: unknown; images?: unknown };
  for (const [field, label] of [
    ['buffers', 'データ'],
    ['images', '画像'],
  ] as const) {
    const list = d[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { ok: false, reason: `glTF の ${field} の形が違います` };
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue;
      const uri = (item as { uri?: unknown }).uri;
      if (uri === undefined) continue;
      if (typeof uri !== 'string') return { ok: false, reason: `glTF の ${field} の uri が文字列ではありません` };
      if (!isAllowedLocal3dUrl(uri)) {
        return {
          ok: false,
          reason:
            `外部の${label}(${refLabel(uri)})を参照しているため表示しません。` +
            '外部のファイルやネットワークからは読み込みません。データを埋め込んだ GLB 形式で添付してください',
        };
      }
    }
  }
  return { ok: true };
}

/**
 * GLB の JSON 塊を取り出す(読む前に `validateLocalGltfJson` へ通すため)。
 * 形が壊れていれば `null`。
 */
export function extractGlbJson(bytes: Uint8Array): string | null {
  if (bytes.length < 20 || asciiAt(bytes, 0, 4) !== 'glTF') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkLen = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  if (chunkType !== 0x4e4f534a /* 'JSON' */ || 20 + chunkLen > bytes.length) return null;
  return new TextDecoder().decode(bytes.subarray(20, 20 + chunkLen));
}
