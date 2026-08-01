/**
 * P6c 段①: ZIP の読取り(依存ゼロ)。
 *
 * 全 8 形式の土台。**形式知識をまったく持たない純機構**なので、合成 ZIP fixture
 * だけで単独に pin できる。設計は `docs/development/p6c-zip-import-design-2026-08.md` §2。
 *
 * ## 依存を増やさない
 * - store(method 0)は自前(EOCD 探索 → 中央ディレクトリ走査 → `Blob.slice`)
 * - deflate(method 8)は `DecompressionStream('deflate-raw')` ── **raw** であって
 *   `'deflate'` ではない(ZIP は zlib ヘッダを持たない)。PKC3 は既に `'gzip'` で
 *   同じ API を使っているので、bundle も依存も 1 バイト増えない
 *
 * ## PKC2 の reader から直した 3 点(設計 doc §2-2)
 * - **入力は `Blob`**(`File` ではない)── ZIP-in-ZIP で内側を Blob 化して
 *   **同じ reader を再入**できる。これが無いと内側を全量展開する羽目になる
 * - **general purpose flag を読む** ── bit 11(UTF-8 名)が立っていないのに
 *   名前が非 ASCII なら、文字コードを推測せず**断る**(mojibake を作らない)
 * - **CRC-32 を検証する** ── PKC2 は検証しておらず、破損検知が `JSON.parse` の
 *   失敗頼みだった。asset だけ壊れた ZIP が**無言で欠けた添付**になる
 *
 * ## 断る条件(すべて可視・黙って落とさない)
 * ZIP64 / method が 0・8 以外 / 暗号化(flag bit 0)/ CD signature 不正 /
 * EOCD なし / CRC 不一致 / 名前の文字コードが判別できない。
 * **skip して欠落させる選択はしない** ── 取り込めなかったことが分かる方が良い。
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
  /** local header の先頭(データ本体はヘッダ長ぶん後ろ)。 */
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

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ASCII_ONLY = /^[\x20-\x7e]*$/;

/**
 * ZIP の目次(中央ディレクトリ)を読む。**bytes は 1 バイトも読まない** ──
 * 名前と offset だけを持ち帰り、本体は `readEntry` が 1 件ずつ切り出す。
 */
export async function readZipDirectory(zip: Blob): Promise<ZipEntry[]> {
  if (zip.size < 22) throw new ZipReadError('ZIP として小さすぎます(EOCD が入らない)');

  const tailLen = Math.min(zip.size, EOCD_MAX_SCAN);
  const tail = new DataView(await zip.slice(zip.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) {
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

  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === U32_MAX || cdOffset === U32_MAX) {
    throw new ZipReadError('ZIP64 形式には対応していません(4GB 超 / 65535 件超)');
  }
  if (cdOffset + cdSize > zip.size) {
    throw new ZipReadError('ZIP の中央ディレクトリが範囲外を指しています(壊れています)');
  }

  const cdBuf = await zip.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  if (cdBuf.byteLength >= 4 && new DataView(cdBuf).getUint32(0, true) === ZIP64_EOCD_SIG) {
    throw new ZipReadError('ZIP64 形式には対応していません');
  }
  const cd = new DataView(cdBuf);
  const raw = new Uint8Array(cdBuf);

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

    if (flags & 0x1) throw new ZipReadError('暗号化された ZIP には対応していません');
    if (compressedSize === U32_MAX || uncompressedSize === U32_MAX || localHeaderOffset === U32_MAX) {
      throw new ZipReadError('ZIP64 形式には対応していません(4GB 超のファイル)');
    }

    const nameBytes = raw.subarray(pos + 46, pos + 46 + nameLen);
    // ⚠ **flag bit 11 を読む**(PKC2 は読まずに常に UTF-8 decode していた)。
    // 立っていないのに非 ASCII なら CP437/CP932 等でありうる ── 推測して
    // 文字化けさせるより、判別できないと言う方が良い
    const name = new TextDecoder('utf-8', { fatal: false }).decode(nameBytes);
    if (!(flags & 0x800) && !ASCII_ONLY.test(name)) {
      throw new ZipReadError(
        'ZIP 内のファイル名の文字コードを判別できません(UTF-8 の印が無く、ASCII でもありません)',
      );
    }

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      crc32: crc,
      localHeaderOffset,
      // ディレクトリ判定は名前と外部属性の両方(作り手によってどちらかしか立たない)
      isDirectory: name.endsWith('/') || (externalAttrs & 0x10) !== 0,
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * entry 1 件の中身を Blob で取り出す。
 *
 * ⚠ **base64 を経由しない**。store は `Blob.slice`(view であってコピーではない)、
 * deflate は `DecompressionStream` の streaming。ピークは「その 1 件」に有界。
 *
 * @param verifyCrc CRC-32 を検証する(既定 true)。検証するには一度 bytes を
 *   読む必要があるので、巨大 asset で明示的に外せるようにしてある ── ただし
 *   **外すと壊れた bytes を黙って取り込む**ので、外すのは呼び出し側の宣言。
 */
export async function readZipEntry(
  zip: Blob,
  entry: ZipEntry,
  opts: { verifyCrc?: boolean } = {},
): Promise<Blob> {
  if (entry.isDirectory) throw new ZipReadError(`ディレクトリの中身は読めません: ${entry.name}`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipReadError(
      `未対応の圧縮方式です(method=${entry.method}): ${entry.name} ── store か deflate のみ扱えます`,
    );
  }

  // local header は可変長(名前 + extra)。**サイズは中央ディレクトリを正とする**
  // (data descriptor 使用時は local header の size が 0 になる)
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
  const verify = opts.verifyCrc !== false;

  if (entry.method === 0) {
    if (!verify) return slice;
    const bytes = new Uint8Array(await slice.arrayBuffer());
    assertCrc(bytes, entry);
    return new Blob([bytes]);
  }

  // ZIP の deflate は **raw**(zlib ヘッダなし)── 'deflate' だと必ず失敗する
  let out: Uint8Array<ArrayBuffer>;
  try {
    const stream = slice.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    out = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    throw new ZipReadError(
      `ZIP の展開に失敗しました(${entry.name}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (verify) assertCrc(out, entry);
  return new Blob([out]);
}

function assertCrc(bytes: Uint8Array, entry: ZipEntry): void {
  if (bytes.byteLength !== entry.uncompressedSize) {
    throw new ZipReadError(
      `ZIP のファイルサイズが目次と違います(${entry.name}: ${bytes.byteLength} ≠ ${entry.uncompressedSize})`,
    );
  }
  const actual = crc32(bytes);
  if (actual !== entry.crc32) {
    // PKC2 はここを検証しておらず、asset だけ壊れた ZIP が無言で欠けた添付になった
    throw new ZipReadError(
      `ZIP のファイルが壊れています(CRC 不一致: ${entry.name})`,
    );
  }
}

/** テキストとして読む(manifest.json / container.json / body.md 用)。 */
export async function readZipText(zip: Blob, entry: ZipEntry): Promise<string> {
  return (await readZipEntry(zip, entry)).text();
}
