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
    const nameBytes = enc.encode(e.name);
    const nonAscii = [...nameBytes].some((b) => b > 0x7e || b < 0x20);
    const flags = e.flags ?? (nonAscii ? 0x800 : 0);
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
      ...u16(0), // extra
      ...nameBytes,
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
      ...u16(0), // extra
      ...u16(0), // comment
      ...u16(0), // disk
      ...u16(0), // internal attrs
      ...u32(e.isDirectory ? 0x10 : 0), // external attrs
      ...u32(offset),
      ...nameBytes,
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

export const bytesOf = (text: string): Uint8Array => enc.encode(text);
