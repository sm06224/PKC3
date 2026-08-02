/**
 * P6c 段①: ZIP の読取り(依存ゼロ)。
 *
 * 全 8 形式の土台。**形式知識をまったく持たない純機構**なので、合成 ZIP fixture
 * だけで単独に pin できる。設計は `docs/development/p6c-zip-import-design-2026-08.md` §2。
 *
 * ## 依存を増やさない
 * - store(method 0)は自前(EOCD 探索 → 中央ディレクトリ走査 → `Blob.slice`)
 * - deflate(method 8)は `DecompressionStream('deflate-raw')` ── **raw** であって
 *   `'deflate'` ではない(ZIP は zlib ヘッダを持たない)
 *
 * ## 名前の文字コード ── 問いは「decode 結果が ASCII か」ではない
 * 🔑 **バイト列が妥当な UTF-8 か**を見る(review H-1/H-2 で判定が逆向きだった)。
 * Info-ZIP(Linux / macOS の `zip`)は **UTF-8 の名前を bit 11 を立てずに書く**ので、
 * 「bit 11 が無い かつ 非 ASCII なら拒否」は**正しい ZIP を丸ごと拒否**する ──
 * しかも deflate 対応の動機だった「ZIP ツールで再梱包したファイル」がまさにそれ。
 * 逆に bit 11 さえ立っていれば壊れたバイトが U+FFFD で黙って通っていた。
 * `fatal: true` の 1 か所で両方向が正しくなる(CP932 等は妥当な UTF-8 でないので断る)。
 *
 * ## メモリ ── CRC 検証はコピーを作らずに行う
 * store は slice を **stream で舐めて検証し、slice(view)をそのまま返す**。
 * deflate は展開しながら CRC を計算する。どちらもピークは「返す 1 件」に有界
 * (review M-6: 素朴に `new Blob([bytes])` すると store で 2 部、deflate で 3 部になる)。
 * 検証が常時走るので `verifyCrc` の逃げ道は**持たない** ── 逃げ道はサイズ照合まで
 * 一緒に落として「他人の entry の中身が返る」経路を開けていた(review M-5)。
 *
 * ## 断る条件(すべて可視・黙って落とさない)
 * ZIP64 / method が 0・8 以外 / 暗号化 / 分割書庫 / CD 署名不正 / EOCD なし /
 * CRC 不一致 / サイズ不一致 / 名前が妥当な UTF-8 でない / 目次と件数の不整合。
 * **skip して欠落させる選択はしない**。
 *
 * ## この層がやらないこと
 * - **名前の無害化**(`..` / 絶対パス / null バイト)── 呼び出し側の責務。
 *   ZIP パスを FS に書かないので traversal 自体は無害だが、key として使う側が
 *   検査する(段②の `pkc2-package.ts` が `assets/<key>.bin` の key を検査する)
 * - **重複名の解決** ── `readZipDirectory` は重複をそのまま返す。素朴に Map 化すると
 *   **後勝ち**になるので、呼び出し側が「先勝ち + warning」か「断る」かを決めること
 *   (段②は manifest / container / asset key の重複を**断る**)
 */

/** ZIP として読めなかった理由を持つ失敗(呼び出し側が可視で断るために使う)。 */
export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipReadError';
  }
}

/** 中央ディレクトリの 1 件(bytes はまだ読んでいない)。 */
export interface ZipEntry {
  name: string;
  /** 圧縮方式(0 = store / 8 = deflate)。 */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  /** local header の**ファイル先頭からの**位置(前置バイトぶんを解決済み)。 */
  localHeaderOffset: number;
  /** ディレクトリ entry(名前が `/` 終わり、または外部属性のディレクトリ bit)。 */
  isDirectory: boolean;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

/** EOCD は可変長コメント(最大 65535)を持つので、末尾からこの幅を後方走査する。 */
const EOCD_MAX_SCAN = 65557;

/** ZIP64 の印(32bit に収まらない値のプレースホルダ)。 */
const U32_MAX = 0xffffffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** 逐次更新(初期値は `0xffffffff`)。streaming 検証のために公開している。 */
export function crc32Update(state: number, bytes: Uint8Array): number {
  let c = state;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return c;
}

export function crc32(bytes: Uint8Array): number {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

/**
 * ZIP の目次(中央ディレクトリ)を読む。**bytes は 1 バイトも読まない** ──
 * 名前と offset だけを持ち帰り、本体は `readZipEntry` が 1 件ずつ切り出す。
 */
export async function readZipDirectory(zip: Blob): Promise<ZipEntry[]> {
  if (zip.size < 22) throw new ZipReadError('ZIP として小さすぎます(EOCD が入らない)');

  const tailLen = Math.min(zip.size, EOCD_MAX_SCAN);
  const tailStart = zip.size - tailLen;
  const tail = new DataView(await zip.slice(tailStart).arrayBuffer());
  // ⚠ 署名の一致だけで採らない(review H-3)── EOCD signature と同じ 4 バイトは
  // 本体にもコメントにも偶然現れる。**comment 長が残りバイトと一致する**ものだけを
  // 候補にする。これが無いと、ZIP ですらないバイナリが「空 ZIP」として通る
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (
      tail.getUint32(i, true) === EOCD_SIG &&
      tail.getUint16(i + 20, true) === tail.byteLength - i - 22
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new ZipReadError('ZIP の終端(EOCD)が見つかりません ── 壊れているか ZIP ではありません');
  }
  // ZIP64 は locator が EOCD の直前に置かれる。**実装せずに名指しで断る**
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIG) {
    throw new ZipReadError('ZIP64 形式には対応していません(4GB 超 / 65535 件超)');
  }
  // 分割書庫(マルチディスク)── 2 枚目以降は原理的に読めないので、
  // 「読めた気になって欠落する」前に断る
  if (tail.getUint16(eocd + 4, true) !== 0 || tail.getUint16(eocd + 6, true) !== 0) {
    throw new ZipReadError('分割された ZIP(マルチディスク)には対応していません');
  }

  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === U32_MAX || cdOffset === U32_MAX) {
    throw new ZipReadError('ZIP64 形式には対応していません(4GB 超 / 65535 件超)');
  }

  // ZIP の**前にバイトが付いている**ことがある(自己解凍書庫など)。CD の offset は
  // ZIP 部分の先頭からの相対値なので、EOCD の実位置から前置量を逆算する
  // (review M-7: 足さないと「壊れています」という**嘘の診断**になる)
  const eocdAbs = tailStart + eocd;
  const prefix = eocdAbs - cdSize - cdOffset;
  if (prefix < 0 || cdOffset + cdSize + prefix > zip.size) {
    throw new ZipReadError('ZIP の中央ディレクトリが範囲外を指しています(壊れています)');
  }

  const cdStart = cdOffset + prefix;
  const cdBuf = await zip.slice(cdStart, cdStart + cdSize).arrayBuffer();
  if (cdBuf.byteLength >= 4 && new DataView(cdBuf).getUint32(0, true) === ZIP64_EOCD_SIG) {
    throw new ZipReadError('ZIP64 形式には対応していません');
  }
  const cd = new DataView(cdBuf);
  const raw = new Uint8Array(cdBuf);
  const utf8 = new TextDecoder('utf-8', { fatal: true });

  const entries: ZipEntry[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cd.byteLength) {
      throw new ZipReadError('ZIP の中央ディレクトリが途中で切れています');
    }
    if (cd.getUint32(pos, true) !== CD_SIG) {
      throw new ZipReadError('ZIP の中央ディレクトリの署名が不正です(壊れています)');
    }
    const flags = cd.getUint16(pos + 8, true);
    const method = cd.getUint16(pos + 10, true);
    const crc = cd.getUint32(pos + 16, true);
    const compressedSize = cd.getUint32(pos + 20, true);
    const uncompressedSize = cd.getUint32(pos + 24, true);
    const nameLen = cd.getUint16(pos + 28, true);
    const extraLen = cd.getUint16(pos + 30, true);
    const commentLen = cd.getUint16(pos + 32, true);
    const externalAttrs = cd.getUint32(pos + 38, true);
    const localHeaderOffset = cd.getUint32(pos + 42, true);
    // ⚠ 可変長ぶんまで含めて境界を見る(review H-4)── `subarray` は範囲外を
    // **黙って clamp** するので、CD が名前の途中で切れていると名前が静かに縮む
    // (最後の 1 件は次の CD 署名検査にも掛からないので素通りする)
    if (pos + 46 + nameLen + extraLen + commentLen > cd.byteLength) {
      throw new ZipReadError('ZIP の中央ディレクトリが途中で切れています');
    }

    if (flags & 0x1) throw new ZipReadError('暗号化された ZIP には対応していません');
    if (compressedSize === U32_MAX || uncompressedSize === U32_MAX || localHeaderOffset === U32_MAX) {
      throw new ZipReadError('ZIP64 形式には対応していません(4GB 超のファイル)');
    }

    // 🔑 bit 11 は**見ない**。妥当な UTF-8 かどうかだけで決める(冒頭の解説参照)
    let name: string;
    try {
      name = utf8.decode(raw.subarray(pos + 46, pos + 46 + nameLen));
    } catch {
      throw new ZipReadError(
        'ZIP 内のファイル名の文字コードを判別できません(UTF-8 として読めません)',
      );
    }

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      crc32: crc,
      localHeaderOffset: localHeaderOffset + prefix,
      // ディレクトリ判定は名前と外部属性の**両方**(作り手によって片方しか立たない
      // ── python は名前だけ / Info-ZIP は両方)
      isDirectory: name.endsWith('/') || (externalAttrs & 0x10) !== 0,
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  // 件数を使い切った後に余りがあれば、EOCD の件数が中身と食い違っている ──
  // 素通りさせると **entry が黙って消える**(review H-3)
  if (pos !== cd.byteLength) {
    throw new ZipReadError('ZIP の目次と件数が合いません(壊れています)');
  }
  return entries;
}

/** stream を舐めて CRC とサイズを検証する(**中身は溜めない**)。 */
async function verifyStream(
  stream: ReadableStream<Uint8Array>,
  entry: ZipEntry,
): Promise<void> {
  let state = 0xffffffff;
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    state = crc32Update(state, value);
    size += value.byteLength;
  }
  assertIntegrity((state ^ 0xffffffff) >>> 0, size, entry);
}

function assertIntegrity(actualCrc: number, actualSize: number, entry: ZipEntry): void {
  if (actualSize !== entry.uncompressedSize) {
    throw new ZipReadError(
      `ZIP のファイルサイズが目次と違います(${entry.name}: ${actualSize} ≠ ${entry.uncompressedSize})`,
    );
  }
  if (actualCrc !== entry.crc32) {
    // PKC2 はここを検証しておらず、asset だけ壊れた ZIP が無言で欠けた添付になった。
    // ⚠ 「entry の出所が違う」でも同じ症状になる(別 ZIP の entry を渡した等)ので、
    // user のデータを一方的に疑う文面にしない
    throw new ZipReadError(
      `ZIP のファイルが壊れています(CRC 不一致: ${entry.name})── または entry の出所が違います`,
    );
  }
}

/**
 * entry 1 件の中身を Blob で取り出す。**CRC とサイズは必ず検証する**。
 *
 * ⚠ base64 を経由しない。store は `Blob.slice`(view であってコピーではない)を
 * stream で検証してそのまま返し、deflate は展開しながら検証する ──
 * どちらもピークは「返す 1 件」に有界。
 */
export async function readZipEntry(zip: Blob, entry: ZipEntry): Promise<Blob> {
  if (entry.isDirectory) throw new ZipReadError(`ディレクトリの中身は読めません: ${entry.name}`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipReadError(
      `未対応の圧縮方式です(method=${entry.method}): ${entry.name} ── store か deflate のみ扱えます`,
    );
  }
  // store は「圧縮後 = 圧縮前」が method 0 の定義。食い違いは目次の壊れ
  if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) {
    throw new ZipReadError(
      `ZIP の目次が壊れています(${entry.name}: store なのにサイズが一致しません)`,
    );
  }

  // local header は可変長(名前 + extra)。**サイズは中央ディレクトリを正とする**
  // (data descriptor 使用時は local header の size が 0 になる)。
  // ⚠ local header の extra 長は **CD の extra 長と違ってよい**(Info-ZIP は実際に
  // 違う)── local 側の値でデータ開始位置を出すこと
  if (entry.localHeaderOffset + 30 > zip.size) {
    throw new ZipReadError(`ZIP のヘッダが範囲外です: ${entry.name}`);
  }
  const lh = new DataView(
    await zip.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer(),
  );
  if (lh.getUint32(0, true) !== LOCAL_SIG) {
    throw new ZipReadError(`ZIP のヘッダ署名が不正です: ${entry.name}`);
  }
  const start =
    entry.localHeaderOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const end = start + entry.compressedSize;
  if (end > zip.size) {
    throw new ZipReadError(`ZIP のデータが範囲外です(壊れています): ${entry.name}`);
  }

  const slice = zip.slice(start, end); // ← コピーしない

  if (entry.method === 0) {
    // 舐めて検証し、**view をそのまま返す**(コピーを 1 部も作らない)
    await verifyStream(slice.stream(), entry);
    return slice;
  }

  // ZIP の deflate は **raw**(zlib ヘッダなし)── 'deflate' だと必ず失敗する。
  // 展開しながら CRC を取る(全量を Uint8Array に起こしてから測らない)
  let state = 0xffffffff;
  let size = 0;
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      state = crc32Update(state, chunk);
      size += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  let out: Blob;
  try {
    out = await new Response(
      slice.stream().pipeThrough(new DecompressionStream('deflate-raw')).pipeThrough(tap),
    ).blob();
  } catch (e) {
    const detail = e instanceof Error && e.message ? `: ${e.message}` : '';
    throw new ZipReadError(
      `ZIP の圧縮データが壊れています(${entry.name})── 展開できませんでした${detail}`,
    );
  }
  assertIntegrity((state ^ 0xffffffff) >>> 0, size, entry);
  return out;
}

/** テキストとして読む(manifest.json / container.json / body.md 用)。 */
export async function readZipText(zip: Blob, entry: ZipEntry): Promise<string> {
  return (await readZipEntry(zip, entry)).text();
}

/**
 * bytes の在り処 =(どの ZIP の・どの entry か)。
 *
 * ⚠ **`ZipEntry` は自分がどの Blob に属するかを持たない**。段④(batch)では
 * 内側 ZIP の entry を**外側の Blob から**読もうとして必ず壊れる ── offset は
 * 内側基準なので、外側の別位置を読んで CRC 不一致か「壊れた ZIP」になる。
 * 受け渡しは必ずこの組で行い、読み手は `readAssetSource` だけを使う。
 */
export interface AssetSource {
  zip: Blob;
  entry: ZipEntry;
  /**
   * 中身が **base64 テキスト**である(`pkc2-entry-bundle` の `assets/<key>`)。
   *
   * ⚠ text/textlog bundle は同じ `assets/` に**生バイト**を書く ── 同じ ZIP の
   * 中で格納形式が 2 通りある(実物で確認、2026-08-02)。読み手が取り違えると
   * **base64 の文字列そのものが添付として保存される**(開けないファイルができ、
   * しかも「壊れている」とは見えない)ので、在り処と一緒に運ぶ。
   */
  base64?: true;
}

/** `AssetSource` の中身を読む(ネストしていても正しい Blob から読む)。 */
export async function readAssetSource(src: AssetSource): Promise<Blob> {
  return readZipEntry(src.zip, src.entry);
}
