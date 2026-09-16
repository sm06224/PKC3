/**
 * P6d 段①: ZIP の書出し(依存ゼロ)。全書出し形式の土台。
 *
 * 🔑 **1 個の巨大バッファを作らない**(user 指示 2026-07-27「ゼロコピー、生成と
 * ライフサイクル後の速やかな破棄を徹底」、不可侵)。PKC2 の書出しは container 全体を
 * 1 個の文字列に組み立てており、実測 +293MB 常駐していた。
 *
 * ここでは **部品を並べるだけ**にする:
 * - `new Blob([a, b, c])` は**部品の参照を持つだけ**で中身をコピーしない
 * - asset は `AssetBlobStore.get()` が返す **IDB の Blob をそのまま**部品にする
 *   ── 既にディスク側の実体を指しているので heap に載らない
 * - JSON も**丸ごと文字列にしない**。`{"entries":[` / 1 件ぶん / `,` … と
 *   小さな文字列の部品として積む(呼び出し側が `addStored` に配列で渡す)
 *
 * ⚠ **CRC-32 と長さだけは中身を舐めないと出せない**。ただし舐めるのは
 * `blob.stream()` 経由で 1 件ずつでよく、**同時に heap に載るのは 1 チャンク**。
 * local header に CRC を書く必要があるので「舐める → 組む」の 2 パスになるが、
 * IDB の Blob を 2 回読むだけで常駐は増えない
 * (data descriptor を使えば 1 パスにできるが、**reader 側が local header の
 * 署名とサイズを検査する**設計なので素直な形を採る)。
 *
 * ## reader と対で作る
 * 🔑 `features/import/zip-reader.ts` と**同じ repo で対**にあることが要点。
 * PKC2 は writer と reader を別々に書いて食い違わせていた(拡張子ストリップの
 * 正規表現 / `compact` と `compacted` の綴り / bit 11 を書くが読まない)。
 * **round-trip test を最初から回す**ことで構造的に避ける。
 */
import { crc32Update } from '../import/zip-reader';
import { u32bytes, u64bytes } from './zip-int';

const LOCAL_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
/** ZIP64 の追加情報(extra field)の id。 */
const ZIP64_EXTRA_ID = 0x0001;
/** UTF-8 の名前(bit 11)。⚠ reader は**見ない**が、他のツールのために立てる。 */
const FLAG_UTF8 = 0x0800;
/**
 * 🔴 **ZIP32 の欄に入る上限**(#971 段④)。
 *
 * ⚠ 2026-09-16 まで、ここを超えると**書き出しごと断っていた** ── user の DB が
 *   4GB を超えたとき、**持ち出す道がそれで塞がった**。いまは超えたぶんだけ
 *   **ZIP64 の欄へ逃がす**(断らない)。
 * 🔑 **超えたときだけ ZIP64 にする** ── 小さい書庫は 1 バイトも形が変わらないので、
 *   古い版の PKC も、素の解凍ソフトも、これまでどおり読める。
 */
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
/** ZIP64 を使う record が名乗る版(使わない record は 20 のまま)。 */
const VERSION_ZIP64 = 45;
const VERSION_BASE = 20;

/** 書ける部品(小さな文字列 か、コピーしたくない Blob)。 */
export type ZipPart = string | Blob;

export class ZipWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipWriteError';
  }
}

interface Staged {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

/**
 * 🔑 **ZIP64 へ切り替える境目**(既定は本物の上限)。
 *
 * ⚠ **test のための seam である。** 4GB の書庫を実際に作らずに ZIP64 の経路を
 *   通すために、境目だけを下げられるようにしてある ── **出るバイトの組み方は
 *   1 行も変わらない**(変わるのは「いつ切り替えるか」だけ)。
 * ⚠ 既定の値そのものは `tests/features/zip64.test.ts` が等値で pin する
 *   (seam を足した日に既定が下がっていたら、それは事故である)。
 */
export interface Zip64Thresholds {
  /** これを超える大きさ / 位置は 8 バイトの欄へ逃がす(既定 `0xffffffff`)。 */
  readonly size?: number;
  /** これを超える件数は 8 バイトの欄へ逃がす(既定 `0xffff`)。 */
  readonly count?: number;
}

const enc = new TextEncoder();

function u16(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
/** ⚠ 綴りは `zip-int.ts` の 1 本だけ ── 読む側と**同じ物**を使う(CLAUDE.md §7)。 */
const u32 = u32bytes;
const u64 = u64bytes;

/**
 * 部品を舐めて CRC と長さを出す。**同時に heap に載るのは 1 チャンクだけ**。
 * 文字列はその場でバイト化する(小さい前提 ── 大きいものは Blob で渡すこと)。
 */
async function measure(parts: readonly ZipPart[]): Promise<{ crc: number; size: number; bytes: ZipPart[] }> {
  let state = 0xffffffff;
  let size = 0;
  const bytes: ZipPart[] = [];
  for (const p of parts) {
    if (typeof p === 'string') {
      const b = enc.encode(p);
      state = crc32Update(state, b);
      size += b.byteLength;
      bytes.push(new Blob([b]));
      continue;
    }
    // ⚠ `arrayBuffer()` で丸ごと起こさない ── stream で舐める
    const reader = p.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      state = crc32Update(state, value);
      size += value.byteLength;
    }
    bytes.push(p); // **元の Blob をそのまま部品にする**(コピーしない)
  }
  return { crc: (state ^ 0xffffffff) >>> 0, size, bytes };
}

/**
 * store(method 0)固定の ZIP を組む。
 *
 * ⚠ **deflate は使わない**。asset は既に圧縮済みの形式が大半で、text は
 * 「小さくする」より**再入(ZIP-in-ZIP)を view のまま扱える**方が価値がある
 * ── PKC2 も store 固定で、その性質が段④ のゼロコピー再入を成立させていた。
 * 縮めたいなら外側で gzip する(HTTP の Content-Encoding と同じ発想)。
 */
export class ZipWriter {
  private readonly parts: ZipPart[] = [];
  private readonly staged: Staged[] = [];
  private offset = 0;
  private readonly names = new Set<string>();
  private closed = false;
  private readonly maxSize: number;
  private readonly maxCount: number;

  constructor(thresholds: Zip64Thresholds = {}) {
    this.maxSize = thresholds.size ?? U32_MAX;
    this.maxCount = thresholds.count ?? U16_MAX;
  }

  /** この書庫が ZIP64 の欄を使ったか(検査と診断のため)。 */
  get usedZip64(): boolean {
    return this.zip64;
  }
  private zip64 = false;

  /**
   * 1 ファイル追加する。`parts` は連結した結果が中身になる。
   * @throws 同名だけは**断る**(reader が「後勝ちで片方を静かに捨てる」形にしない)。
   *   ⚠ 大きさと件数では**もう断らない** ── 超えたぶんは ZIP64 の欄へ逃がす(#971 段④)
   */
  async add(name: string, parts: readonly ZipPart[]): Promise<void> {
    if (this.closed) throw new ZipWriteError('閉じた ZIP には追記できません');
    if (name === '') throw new ZipWriteError('名前が空のファイルは書けません');
    // ⚠ 同名を許すと reader が「後勝ちで片方を静かに捨てる」形になる ── 出さない
    if (this.names.has(name)) {
      throw new ZipWriteError(`同じ名前のファイルを 2 回書こうとしました: ${name}`);
    }
    const nameBytes = enc.encode(name);
    const { crc, size, bytes } = await measure(parts);
    // ⚠ 名前を確保するのは**成功が確定してから**(review L-3)── measure が投げた
    // 後に名前だけ残ると、同じ名前での再試行が誤って「重複」と断られる
    this.names.add(name);

    /**
     * 🔴 **4GB を超えたら断らない ── 8 バイトの欄へ逃がす**(#971 段④)。
     *
     * ⚠ local header には**位置の欄が無い**ので、ここで逃がすのは**大きさだけ**
     *   (位置は中央ディレクトリ側で逃がす)。
     * ⚠ 逃がすときは 4 バイトの欄を **`0xffffffff` の印**で埋める ── そうしないと
     *   読み手は「追加情報を見る合図」を受け取れない。
     */
    const bigSize = size > this.maxSize;
    if (bigSize) this.zip64 = true;
    const extra = bigSize
      ? [
          ...u16(ZIP64_EXTRA_ID),
          ...u16(16), // この後ろの長さ(大きさ 2 つ)
          ...u64(size), // uncompressed
          ...u64(size), // compressed(store なので同じ)
        ]
      : [];

    const header = new Uint8Array([
      ...u32(LOCAL_SIG),
      ...u16(bigSize ? VERSION_ZIP64 : VERSION_BASE),
      ...u16(FLAG_UTF8),
      ...u16(0), // store
      ...u16(0), // time
      ...u16(0), // date
      ...u32(crc),
      ...u32(bigSize ? U32_MAX : size), // compressed = uncompressed(store)
      ...u32(bigSize ? U32_MAX : size),
      ...u16(nameBytes.length),
      ...u16(extra.length),
      ...nameBytes,
      ...extra,
    ]);
    this.staged.push({ nameBytes, crc, size, offset: this.offset });
    this.parts.push(new Blob([header]), ...bytes);
    this.offset += header.byteLength + size;
    if (this.offset > this.maxSize) this.zip64 = true;
    if (this.staged.length > this.maxCount) this.zip64 = true;
  }

  /** 中央ディレクトリと EOCD を足して閉じる。**ここでもコピーしない**。 */
  finish(): Blob {
    // ⚠ 封じる ── finish 後に add すると中央ディレクトリの後ろにデータが付いた
    // 壊れた ZIP ができる(review L-4)
    this.closed = true;
    const cd: number[] = [];
    for (const s of this.staged) {
      /**
       * 🔴 **中央ディレクトリでは、大きさと位置の両方を逃がしうる**。
       *
       * ⚠ 追加情報の中の**並び順は決まっている**(大きさ → 圧縮後 → 位置 → ディスク)
       *   ── 前の物を飛ばして後ろだけ書くことはできない。store なので
       *   「大きさ」と「圧縮後」は必ず一緒に出入りする。
       */
      const bigSize = s.size > this.maxSize;
      const bigOffset = s.offset > this.maxSize;
      const payload: number[] = [];
      if (bigSize) payload.push(...u64(s.size), ...u64(s.size));
      if (bigOffset) payload.push(...u64(s.offset));
      const extra =
        payload.length > 0
          ? [...u16(ZIP64_EXTRA_ID), ...u16(payload.length), ...payload]
          : [];
      cd.push(
        ...u32(CD_SIG),
        ...u16(extra.length > 0 ? VERSION_ZIP64 : VERSION_BASE), // version made by
        ...u16(extra.length > 0 ? VERSION_ZIP64 : VERSION_BASE), // version needed
        ...u16(FLAG_UTF8),
        ...u16(0), // store
        ...u16(0),
        ...u16(0),
        ...u32(s.crc),
        ...u32(bigSize ? U32_MAX : s.size),
        ...u32(bigSize ? U32_MAX : s.size),
        ...u16(s.nameBytes.length),
        ...u16(extra.length), // extra
        ...u16(0), // comment
        ...u16(0), // disk
        ...u16(0), // internal attrs
        ...u32(0), // external attrs
        ...u32(bigOffset ? U32_MAX : s.offset),
        ...s.nameBytes,
        ...extra,
      );
    }

    /**
     * 🔴 **終端も、入りきらなければ ZIP64 の record を先に置く**(#971 段④)。
     *
     * ⚠ 並びは **[中身][中央ディレクトリ][ZIP64 終端][位置札][終端]** である ──
     *   位置札(locator)は**終端のすぐ前**に在ることが読み手の約束なので、
     *   間に何も挟まない。
     */
    const count = this.staged.length;
    const cdOffset = this.offset;
    const bigEnd =
      count > this.maxCount || cd.length > this.maxSize || cdOffset > this.maxSize;
    if (bigEnd) this.zip64 = true;

    const zip64End: number[] = bigEnd
      ? [
          ...u32(ZIP64_EOCD_SIG),
          ...u64(44), // この欄より後ろの長さ
          ...u16(VERSION_ZIP64), // version made by
          ...u16(VERSION_ZIP64), // version needed
          ...u32(0), // disk
          ...u32(0), // cd start disk
          ...u64(count), // このディスクの件数
          ...u64(count), // 全部の件数
          ...u64(cd.length),
          ...u64(cdOffset),
          ...u32(ZIP64_LOCATOR_SIG),
          ...u32(0), // ZIP64 終端が在るディスク
          ...u64(cdOffset + cd.length), // ZIP64 終端の位置
          ...u32(1), // ディスクの総数
        ]
      : [];

    const eocd = [
      ...u32(EOCD_SIG),
      ...u16(0), // disk
      ...u16(0), // cd start disk
      ...u16(count > this.maxCount ? U16_MAX : count),
      ...u16(count > this.maxCount ? U16_MAX : count),
      ...u32(cd.length > this.maxSize ? U32_MAX : cd.length),
      ...u32(cdOffset > this.maxSize ? U32_MAX : cdOffset),
      ...u16(0), // comment length
    ];
    return new Blob(
      [...this.parts, new Uint8Array(cd), new Uint8Array(zip64End), new Uint8Array(eocd)],
      { type: 'application/zip' },
    );
  }

  /** 書いた件数(0 件の ZIP を黙って出さないための確認用)。 */
  get count(): number {
    return this.staged.length;
  }
}
