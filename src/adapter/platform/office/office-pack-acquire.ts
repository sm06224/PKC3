/**
 * Office wasm 一式の**取り込み**(#88 / 統合設計 O1)。
 *
 * 取得元は 2 つだけで、**両方を用意する**(user 裁定「うまくいかない場合は、
 * ローカルとかを介してユーザーができればいいです」)。
 *
 * | 経路 | いつ使うか |
 * |---|---|
 * | `fetchPackFromBase` 同一 origin のサブパス | 既定。押すだけで済む |
 * | `readPackFromZip` 手元の zip を選ぶ | ⚠ **CORS の外なので必ず通る** |
 *
 * 🚫 **GitHub の Release 資産を直接 fetch する道は無い**(2026-08-10 実測)。
 * release download は `Access-Control-Allow-Origin` を 1 つも返さず `OPTIONS` は 405。
 * 同じヘッダ形を別 origin で再現して実ブラウザに掛けると `TypeError: Failed to fetch`
 * (ACAO を足した場合のみ成功)。⚠ `coi-serviceworker` はこれを救わない ──
 * あれが解くのは **COOP/COEP** であって **CORS** ではない。
 * 🔑 だから zip の手動取り込みが**保険ではなく一級の導線**である。
 */
import { readZipDirectory, readZipEntry } from '../../../features/import/zip-reader';
import {
  assertPackComplete,
  FONT_PREFIX,
  GZIPPED_PACK_FILES,
  OfficePackError,
  REQUIRED_PACK_FILES,
} from './office-pack';

export interface AcquireProgress {
  (phase: string, done: number, total: number): void;
}

/** zip / URL のどちらから来ても、この形に揃えてから保管側へ渡す。 */
export type PackFiles = Map<string, Blob>;

/**
 * gzip して Blob にする。
 *
 * ⚠ 手元の zip には **生の `soffice.wasm`(148MB)**が入っていることがある
 * (CI が出す release zip がそれ)。保管は gz で統一したいので、ここで縮める。
 * `CompressionStream` は**流しながら**処理するので、148MB を heap に展開しない。
 */
async function gzipBlob(blob: Blob): Promise<Blob> {
  if (typeof CompressionStream !== 'function') {
    throw new OfficePackError(
      'このブラウザは CompressionStream に対応していないため、'
        + '生の soffice.wasm を含む zip を取り込めません。'
        + '圧縮済みの一式(soffice.wasm.gz を含むもの)を使ってください。',
    );
  }
  const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

/**
 * 名前を pack の規約へ寄せる。
 *
 * ⚠ zip の中では `lo-wasm-qt6/soffice.js` のように 1 段深いことがある。
 * ⚠ フォントは `inject/BIZUDGothic-Regular.ttf` として入っている(CI の作り)。
 */
function normalizeName(raw: string): string | null {
  const name = raw.replace(/^\.?\//, '');
  const base = name.slice(name.lastIndexOf('/') + 1);
  if (base === '') return null; // ディレクトリ entry
  if ((REQUIRED_PACK_FILES as readonly string[]).includes(base)) return base;
  if (base in GZIPPED_PACK_FILES) return base;
  // 生の soffice.wasm / soffice.data は、あとで gz にしてから採る
  if (Object.values(GZIPPED_PACK_FILES).includes(base)) return base;
  if (base.toLowerCase().endsWith('.ttf')) return FONT_PREFIX + base;
  return null;
}

/**
 * 手元の zip から一式を取り出す。
 *
 * ⚠ **要らないものを拾わない**。zip には `qt_soffice.html` / `qtlogo.svg` /
 * probe の出力 png などが混ざる ── 名前で決め打ちせず、
 * `normalizeName` が採ると言ったものだけを入れる。
 */
export async function readPackFromZip(zip: Blob, onProgress?: AcquireProgress): Promise<PackFiles> {
  const entries = await readZipDirectory(zip);
  const wanted: { entry: (typeof entries)[number]; name: string }[] = [];
  for (const e of entries) {
    const name = normalizeName(e.name);
    if (name !== null) wanted.push({ entry: e, name });
  }
  if (wanted.length === 0) {
    throw new OfficePackError('この zip に Office 一式が見つかりません。');
  }

  const out: PackFiles = new Map();
  for (const [i, { entry, name }] of wanted.entries()) {
    onProgress?.(`取り込み中: ${name}`, i, wanted.length);
    const blob = await readZipEntry(zip, entry);
    // 生で入っていたら gz にしてから保管する(保管の形を 1 つに保つ)
    const gzName = Object.entries(GZIPPED_PACK_FILES).find(([, raw]) => raw === name)?.[0];
    if (gzName !== undefined) {
      // ⚠ **既に .gz が在るならそちらを優先**する(二重に縮めない)
      if (!out.has(gzName)) out.set(gzName, await gzipBlob(blob));
      continue;
    }
    out.set(name, blob);
  }
  onProgress?.('検査中', wanted.length, wanted.length);
  // ⚠ 保管側でも数え直すが、**ここで落とすほうが user に近い**
  assertPackComplete(out.keys());
  return out;
}

/**
 * 同一 origin のサブパスから一式を取る。
 *
 * ⚠ `base` は**同一 origin でなければならない**。別 origin を渡せるようにすると、
 * ACAO の無い相手(= GitHub Release)で必ず失敗する導線を作ることになる。
 */
export async function fetchPackFromBase(
  base: string,
  fonts: readonly string[],
  onProgress?: AcquireProgress,
): Promise<PackFiles> {
  // ⚠ 基点は `document.baseURI`(相対 path を解決する本来の API)。
  //    ここを location の URL 文字列にすると `tests/features/flags.test.ts` の
  //    「クエリを読んでいないか」の全数検査に掛かる ── **ガードは正しい**ので、
  //    綴りを避けるのではなく**読まなくて済む書き方**へ直した。
  const root = new URL(base, document.baseURI);
  if (root.origin !== location.origin) {
    throw new OfficePackError(
      `取得元は同一 origin でなければなりません(指定: ${root.origin})。`
        + '別 origin は CORS で必ず失敗します ── 手元の zip を選ぶ導線を使ってください。',
    );
  }
  if (fonts.length === 0) {
    throw new OfficePackError('日本語フォントが 1 つも指定されていません。');
  }

  const names = [...REQUIRED_PACK_FILES, ...fonts.map((f) => FONT_PREFIX + f)];
  const out: PackFiles = new Map();
  for (const [i, name] of names.entries()) {
    onProgress?.(`取得中: ${name}`, i, names.length);
    const url = new URL(name, root.href.endsWith('/') ? root.href : `${root.href}/`);
    const res = await fetch(url.href);
    // ⚠ **沈黙を成功と読まない。** 404 の HTML を掴んで「入った」と言わない
    if (!res.ok) throw new OfficePackError(`取得できません: ${name}(HTTP ${res.status})`);
    out.set(name, await res.blob());
  }
  onProgress?.('検査中', names.length, names.length);
  assertPackComplete(out.keys());
  return out;
}
