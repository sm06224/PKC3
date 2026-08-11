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

/**
 * 🔴 **既定の取得元**(#88 / O6-a)。
 *
 * `https://<user>.github.io/office-pack/` ── PKC3 本体と**同じ origin** なので
 * CORS が起きない。⚠ 別 origin にしてはいけない(`fetchPackFromBase` が弾く)。
 *
 * ## 🔴 相対 path で書いてはいけない(2026-08-11 に実際に踏んだ)
 *
 * 最初は `'../office-pack/'` と書いていた ── 「本体は `/PKC3/` に在る」という
 * **決めつけ**である。実際には配信が 2 つあり、深さが違う:
 *
 * | 開いている場所 | `'../office-pack/'` の解決先 | |
 * |---|---|---|
 * | `/PKC3/`(リリース) | `/office-pack/` | ✓ |
 * | `/PKC3/dev/`(main の HEAD) | `/PKC3/office-pack/` | ✗ **404** |
 *
 * user が最初に試したのは `/dev/` だったので、**いきなり 404 を踏んだ**。
 * 🔑 **深さに依存しない書き方**にする ── origin 直下の絶対 path なら、
 * `/PKC3/` でも `/PKC3/dev/` でも同じ場所を指す。
 *
 * ⚠ 帰結: 配布物は **origin の直下**に置く必要がある(GitHub Pages の
 * `<user>.github.io/office-pack/` はまさにその形)。別の置き方をする人は
 * 「ファイルから入れる」を使う ── そちらは CORS の外なので必ず通る。
 */
export const DEFAULT_PACK_BASE = '/office-pack/';

/** 配る側が置く目録(`pack.json`)。⚠ **取る側はこれに従う**(名前を書き写さない)。 */
export interface PackManifest {
  readonly version: string;
  readonly files: readonly string[];
  /** `fonts/…ttf` の形。⚠ 1 本も無い目録は受け付けない(日本語が豆腐になる)。 */
  readonly fonts: readonly string[];
  readonly totalBytes: number;
}

/**
 * 目録を検める。**壊れた目録を「読めた」と言わない。**
 *
 * ⚠ 404 の HTML を `res.json()` に食わせると throw するが、Pages は 404 に
 * `index.html` を返す設定もありうる ── その場合 JSON として読めることがある。
 * だから**形まで見る**(CLAUDE.md「沈黙を成功と読まない」)。
 */
export function parsePackManifest(v: unknown): PackManifest {
  const m = (typeof v === 'object' && v !== null ? v : {}) as Partial<PackManifest>;
  const fonts = Array.isArray(m.fonts) ? m.fonts.filter((f) => typeof f === 'string') : [];
  const files = Array.isArray(m.files) ? m.files.filter((f) => typeof f === 'string') : [];
  if (files.length === 0) {
    throw new OfficePackError('取得元の目録(pack.json)が読めません ── 配布元が違う可能性があります。');
  }
  if (fonts.length < MIN_FONT_COUNT) {
    throw new OfficePackError(
      '取得元の目録に日本語フォントが 1 つもありません。'
        + 'この一式では日本語が豆腐になるため受け付けません。',
    );
  }
  return {
    version: typeof m.version === 'string' && m.version !== '' ? m.version : 'unknown',
    files,
    fonts,
    totalBytes: typeof m.totalBytes === 'number' ? m.totalBytes : 0,
  };
}

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
