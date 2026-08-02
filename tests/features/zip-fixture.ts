/**
 * test 用の ZIP writer(合成 fixture)。
 *
 * ⚠ **reader と実装を共有しない**(crc32 だけは reader の実装を借りる ── そこは
 * 「同じ値を出すこと」自体が検証対象ではないため)。writer を別に書くことで、
 * reader が「自分が書いたものしか読めない」状態を避ける。
 */
import { crc32 } from '../../src/features/import/zip-reader';

export interface FixtureEntry {
  name: string;
  bytes: Uint8Array;
  /** 0 = store(既定)/ 8 = deflate。 */
  method?: number;
  /** general purpose flag(bit 11 = UTF-8 名。既定は名前に応じて立てる)。 */
  flags?: number;
  /** CRC を意図的に壊す(破損検知の test 用)。 */
  corruptCrc?: boolean;
  isDirectory?: boolean;
  /**
   * 名前を**生バイト**で書く(name の代わり)。
   * 妥当な UTF-8 でない名前(CP932 等)を作るために要る ── 「decode 結果が
   * ASCII か」ではなく「バイトが妥当な UTF-8 か」を見る判定の検証に使う。
   */
  rawName?: Uint8Array;
  /**
   * local header / 中央ディレクトリの extra フィールド。
   * ⚠ **長さが違ってよい**(Info-ZIP は実際に違う: LH 28 / CD 24)。
   * データ開始位置を CD の extra 長で計算する実装はここで落ちる
   * ── 常に 0 の fixture では原理的に pin できなかった箇所(review M1/M2)。
   */
  localExtra?: Uint8Array;
  centralExtra?: Uint8Array;
}

const enc = new TextEncoder();

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function u16(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** 最小限だが**仕様どおり**の ZIP を組む(local header + CD + EOCD)。 */
export async function buildZip(
  entries: readonly FixtureEntry[],
  opts: { comment?: string } = {},
): Promise<Blob> {
  const local: number[] = [];
  const central: number[] = [];

  for (const e of entries) {
    const method = e.method ?? 0;
    const raw = e.bytes;
    const data = method === 8 ? await deflateRaw(raw) : raw;
    const nameBytes = e.rawName ?? enc.encode(e.name);
    const nonAscii = [...nameBytes].some((b) => b > 0x7e || b < 0x20);
    const flags = e.flags ?? (nonAscii ? 0x800 : 0);
    const lExtra = e.localExtra ?? new Uint8Array(0);
    const cExtra = e.centralExtra ?? new Uint8Array(0);
    const crc = e.corruptCrc ? (crc32(raw) ^ 0xffff) >>> 0 : crc32(raw);
    const offset = local.length;

    local.push(
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(flags),
      ...u16(method),
      ...u16(0), // time
      ...u16(0), // date
      ...u32(crc),
      ...u32(data.length),
      ...u32(raw.length),
      ...u16(nameBytes.length),
      ...u16(lExtra.length),
      ...nameBytes,
      ...lExtra,
      ...data,
    );

    central.push(
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(flags),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(data.length),
      ...u32(raw.length),
      ...u16(nameBytes.length),
      ...u16(cExtra.length),
      ...u16(0), // comment
      ...u16(0), // disk
      ...u16(0), // internal attrs
      ...u32(e.isDirectory ? 0x10 : 0), // external attrs
      ...u32(offset),
      ...nameBytes,
      ...cExtra,
    );
  }

  const comment = enc.encode(opts.comment ?? '');
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(comment.length),
    ...comment,
  ];
  return new Blob([new Uint8Array([...local, ...central, ...eocd])]);
}

/**
 * ⚠ 戻り型は **`Uint8Array<ArrayBuffer>`**(素の `Uint8Array` にしない)。
 * 素だと `ArrayBufferLike` に広がり、`new Blob([...])` に渡せない
 * (`SharedArrayBuffer` かもしれない扱いになる)── 呼び出し側で毎回
 * cast する羽目になる。
 */
export const bytesOf = (text: string): Uint8Array<ArrayBuffer> => enc.encode(text);
