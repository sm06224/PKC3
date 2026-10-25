/**
 * 🔴 **webm の先頭だけから、長さ(`Duration`)を読む**(#952 着地前レビュー ⚠3)。
 *
 * 声の仕上げは 48kHz の PCM を丸ごと持つので、**復号の前に**長すぎる録音を断る(復号してから断ると、断る前にメモリを使い切る)。
 * 長さが分かるのは `Info` に `Duration` が書かれているとき ── `MediaRecorder` が作ったそのままの webm には無い
 * (#952 A3 以降の録音・録画は書き足してある)。書かれていなければ `null` を返し、呼び手が大きさ(byte)の目安に落とす。
 *
 * 触るのは `Segment` 直下の `Info` だけ。`Cluster`(音・映像の中身)へは降りない。単位は `TimestampScale`(既定 1ms)の目盛り数。
 *
 * ⚠ `features/` 層なので browser API を持たない。例外は投げない(壊れた先頭は `null`)。
 */
import { readId, readSizeAt, readUint } from './ebml';

const ID_EBML_HEAD = '1a45dfa3';
const ID_SEGMENT = '18538067';
const ID_INFO = '1549a966';
const ID_CLUSTER = '1f43b675';
const ID_TIMESTAMP_SCALE = '2ad7b1';
const ID_DURATION = '4489';

/** 先頭 `bytes` から `Duration` をミリ秒で返す。読めない・書かれていない・先頭が足りないなら `null`。 */
export function webmDurationMs(bytes: Uint8Array): number | null {
  const head = readId(bytes, 0);
  if (head === null || head.id !== ID_EBML_HEAD) return null;
  const headSize = readSizeAt(bytes, head.length);
  if (headSize === null || headSize.value === null) return null;
  const segPos = head.length + headSize.length + headSize.value;
  const seg = readId(bytes, segPos);
  if (seg === null || seg.id !== ID_SEGMENT) return null;
  const segSize = readSizeAt(bytes, segPos + seg.length);
  if (segSize === null) return null;
  let p = segPos + seg.length + segSize.length;
  while (p < bytes.length) {
    const id = readId(bytes, p);
    if (id === null) return null;
    const size = readSizeAt(bytes, p + id.length);
    if (size === null) return null;
    const body = p + id.length + size.length;
    if (id.id === ID_CLUSTER) return null; // Info は Cluster より前にしか無い
    if (size.value === null) return null;
    if (id.id !== ID_INFO) {
      p = body + size.value;
      continue;
    }
    const end = body + size.value;
    if (end > bytes.length) return null;
    let scaleNs = 1_000_000;
    let ticks: number | null = null;
    let q = body;
    while (q < end) {
      const cid = readId(bytes, q);
      if (cid === null) return null;
      const csz = readSizeAt(bytes, q + cid.length);
      if (csz === null || csz.value === null) return null;
      const cb = q + cid.length + csz.length;
      if (cb + csz.value > end) return null;
      if (cid.id === ID_TIMESTAMP_SCALE) {
        const v = readUint(bytes.subarray(cb, cb + csz.value));
        if (v !== null && v > 0) scaleNs = v;
      } else if (cid.id === ID_DURATION) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset + cb, csz.value);
        if (csz.value === 8) ticks = dv.getFloat64(0, false);
        else if (csz.value === 4) ticks = dv.getFloat32(0, false);
      }
      q = cb + csz.value;
    }
    if (ticks === null || !Number.isFinite(ticks) || ticks < 0) return null;
    return (ticks * scaleNs) / 1_000_000;
  }
  return null;
}
