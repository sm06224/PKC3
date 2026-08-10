/**
 * Office wasm 一式(pack)の**定義**(#88 / 統合設計 O1)。
 *
 * 🔑 **「一式とは何か」を 1 か所に持つ。** 2026-08-10 に、配布物を組む側で
 * `soffice.data.js.metadata`(データパッケージの索引)を入れ忘れ、
 * **builder は正常終了したのにブラウザで 404 → run dependency が解けず永久に起動しない**
 * という壊れ方をした。必要 file の一覧が 2 か所にあると、片方だけ直る。
 * ⚠ したがって取得側・保管側・起動側は**全部この定数を見る**。
 */

/** 起動に不可欠な file。1 つでも欠けたら pack として受け付けない。 */
export const REQUIRED_PACK_FILES = [
  'soffice.js',
  'qtloader.js',
  'soffice.data.js.metadata',
  'soffice.wasm.gz',
  'soffice.data.gz',
] as const;

/** 日本語フォントの置き場(pack 内の相対 path の前置き)。 */
export const FONT_PREFIX = 'fonts/';

/**
 * 🔴 **CJK フォントは「あれば良い」ではなく必須**(user 指示「日本語は絶対」)。
 * LO の同梱フォントは 128 file / 51.2MiB あるのに **CJK が 1 つも無い**ので、
 * 入れ忘れると日本語が**全部豆腐**になる。⚠ 豆腐は例外を出さずに描かれるので、
 * **入っていること自体を機械で止める**しかない(「ゼロ件の次元」を残さない)。
 */
export const MIN_FONT_COUNT = 1;

/** gz で保管する file と、その元の名前。 */
export const GZIPPED_PACK_FILES: Readonly<Record<string, string>> = {
  'soffice.wasm.gz': 'soffice.wasm',
  'soffice.data.gz': 'soffice.data',
};

export interface OfficePackFileMeta {
  /** pack 内の相対 path(`soffice.js` / `fonts/BIZUDGothic-Regular.ttf`)。 */
  readonly name: string;
  readonly bytes: number;
  /** 小文字 hex の SHA-256。**壊れを検出する材料なので落とさない**。 */
  readonly sha256: string;
}

export interface OfficePackMeta {
  /** 取り込んだ版(release の tag 等)。分からなければ `'unknown'`。 */
  readonly version: string;
  readonly installedAt: number;
  /** `url` = 同一 origin から取得 / `file` = 手元の zip を選んだ。 */
  readonly source: 'url' | 'file';
  readonly totalBytes: number;
  readonly files: readonly OfficePackFileMeta[];
}

export class OfficePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficePackError';
  }
}

/** pack 内のフォント名だけを取り出す。 */
export function fontNames(names: Iterable<string>): string[] {
  return [...names].filter((n) => n.startsWith(FONT_PREFIX) && n.toLowerCase().endsWith('.ttf'));
}

/**
 * 「一式として成立しているか」を判定する。**取得側と保管側の両方から呼ぶ。**
 *
 * ⚠ 出力側でも数え直すのが要点である ── 入力を検めただけでは、
 * コピーし忘れ(= 実際に踏んだ metadata 404)を止められない。
 */
export function assertPackComplete(names: Iterable<string>): void {
  const have = new Set(names);
  const missing = REQUIRED_PACK_FILES.filter((f) => !have.has(f));
  if (missing.length > 0) {
    throw new OfficePackError(`Office 一式に足りない file があります: ${missing.join(', ')}`);
  }
  const fonts = fontNames(have);
  if (fonts.length < MIN_FONT_COUNT) {
    throw new OfficePackError(
      '日本語フォント(fonts/*.ttf)が 1 つも入っていません。'
        + 'この一式では日本語が豆腐になるため受け付けません。',
    );
  }
}

/** 小文字 hex の SHA-256。 */
export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
