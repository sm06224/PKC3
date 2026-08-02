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

const LOCAL_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** UTF-8 の名前(bit 11)。⚠ reader は**見ない**が、他のツールのために立てる。 */
const FLAG_UTF8 = 0x0800;
/** ZIP32 の上限。超えたら**断る**(黙って壊れた ZIP を出さない)。 */
const U32_MAX = 0xffffffff;
const MAX_ENTRIES = 0xffff;

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

const enc = new TextEncoder();

function u16(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

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

  /**
   * 1 ファイル追加する。`parts` は連結した結果が中身になる。
   * @throws 同名 / 4GB 超 / 65535 件超 は**断る**(reader が読めないものを出さない)
   */
  async add(name: string, parts: readonly ZipPart[]): Promise<void> {
    if (this.closed) throw new ZipWriteError('閉じた ZIP には追記できません');
    if (name === '') throw new ZipWriteError('名前が空のファイルは書けません');
    // ⚠ 同名を許すと reader が「後勝ちで片方を静かに捨てる」形になる ── 出さない
    if (this.names.has(name)) {
      throw new ZipWriteError(`同じ名前のファイルを 2 回書こうとしました: ${name}`);
    }
    if (this.staged.length >= MAX_ENTRIES) {
      throw new ZipWriteError(`ZIP に入る件数の上限(${MAX_ENTRIES})を超えました`);
    }
    const nameBytes = enc.encode(name);
    const { crc, size, bytes } = await measure(parts);
    // ⚠ 名前を確保するのは**成功が確定してから**(review L-3)── measure が投げた
    // 後に名前だけ残ると、同じ名前での再試行が誤って「重複」と断られる
    this.names.add(name);
    if (size > U32_MAX) {
      throw new ZipWriteError(`4GB を超えるファイルは書けません(ZIP64 未対応): ${name}`);
    }

    const header = new Uint8Array([
      ...u32(LOCAL_SIG),
      ...u16(20), // version needed
      ...u16(FLAG_UTF8),
      ...u16(0), // store
      ...u16(0), // time
      ...u16(0), // date
      ...u32(crc),
      ...u32(size), // compressed = uncompressed(store)
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0), // extra
      ...nameBytes,
    ]);
    this.staged.push({ nameBytes, crc, size, offset: this.offset });
    this.parts.push(new Blob([header]), ...bytes);
    this.offset += header.byteLength + size;
    if (this.offset > U32_MAX) {
      throw new ZipWriteError('ZIP 全体が 4GB を超えました(ZIP64 未対応)');
    }
  }

  /** 中央ディレクトリと EOCD を足して閉じる。**ここでもコピーしない**。 */
  finish(): Blob {
    // ⚠ 封じる ── finish 後に add すると中央ディレクトリの後ろにデータが付いた
    // 壊れた ZIP ができる(review L-4)
    this.closed = true;
    const cd: number[] = [];
    for (const s of this.staged) {
      cd.push(
        ...u32(CD_SIG),
        ...u16(20), // version made by
        ...u16(20), // version needed
        ...u16(FLAG_UTF8),
        ...u16(0), // store
        ...u16(0),
        ...u16(0),
        ...u32(s.crc),
        ...u32(s.size),
        ...u32(s.size),
        ...u16(s.nameBytes.length),
        ...u16(0), // extra
        ...u16(0), // comment
        ...u16(0), // disk
        ...u16(0), // internal attrs
        ...u32(0), // external attrs
        ...u32(s.offset),
        ...s.nameBytes,
      );
    }
    const eocd = [
      ...u32(EOCD_SIG),
      ...u16(0), // disk
      ...u16(0), // cd start disk
      ...u16(this.staged.length),
      ...u16(this.staged.length),
      ...u32(cd.length),
      ...u32(this.offset),
      ...u16(0), // comment length
    ];
    return new Blob([...this.parts, new Uint8Array(cd), new Uint8Array(eocd)], {
      type: 'application/zip',
    });
  }

  /** 書いた件数(0 件の ZIP を黙って出さないための確認用)。 */
  get count(): number {
    return this.staged.length;
  }
}
