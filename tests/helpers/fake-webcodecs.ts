/**
 * 🔴 **WebCodecs の偽物**(#683 段②b-2)。`VideoEncoder` / `VideoDecoder` の**本物の意味論**を写す。
 *
 * ⚠ stub を本物より甘くしない(CLAUDE.md 型 3「stub は本物の意味論を真似る」):
 *   - 復号器は**最初の chunk がキーフレームでなければ error**(差分は前が無いと絵にならない)
 *   - 符号化器は `keyFrame: true` を頼まれた 1 枚目**と頼まれた枚**だけキーフレームを返す(頼まないと差分)
 *   - 出力は**非同期**(`setTimeout`)・待ち行列の大きさ(`decodeQueueSize` / `encodeQueueSize`)が見える
 *   - `VideoFrame` は `close()` されるまで**生きている**(同時に生きている数を数える)
 *
 * 中身の印:映像フレームの添字は `tests/helpers/webm-video-fixture.ts` の `framePayload`
 * (先頭 3 バイト = VP8 の frame tag、続く 2 バイト = 添字)と同じ置き方で読み書きする。
 * 作り直した物は末尾に `0xEE` を付ける(元のバイトと見分ける)。
 */
import type { CodecApi, DecoderLike, EncodedOut, EncoderLike, FrameLike } from '../../src/adapter/platform/video/video-codec';

export interface FakeOptions {
  /** n 枚目(0 起点)の `encode` で例外を投げる。 */
  readonly throwAtEncode?: number;
  /** n 枚目の符号化で非同期の error を返す。 */
  readonly errorAtEncode?: number;
  /** n 枚目の復号で非同期の error を返す。 */
  readonly errorAtDecode?: number;
  /** n 枚目の符号化出力を**黙って落とす**(渡した数と戻った数が合わなくなる)。 */
  readonly dropAtEncode?: number;
  /** 符号化の出力を遅らせる(ミリ秒)── 背圧が無いとフレームが溜まる形を作る。 */
  readonly encodeDelayMs?: number;
  /** 復号の出力を遅らせる(ミリ秒)。 */
  readonly decodeDelayMs?: number;
  /** 検出用の 1 枚が復号で 0 枚しか戻らない(`configure` は通るが動かない環境)。 */
  readonly decoderSilent?: boolean;
  /** 検出の符号化で error。 */
  readonly encoderBroken?: boolean;
}

export interface FakeStats {
  created: number;
  closed: number;
  live: number;
  maxLive: number;
  encoders: number;
  decoders: number;
  encodeCalls: { index: number; keyFrame: boolean | undefined }[];
  decodeCalls: { index: number; type: 'key' | 'delta' }[];
  probeFrames: number;
  encoderClosed: number;
  decoderClosed: number;
}

class FakeFrame implements FrameLike {
  closed = false;
  constructor(
    readonly timestamp: number,
    readonly index: number,
    private readonly stats: FakeStats,
  ) {
    stats.created += 1;
    stats.live += 1;
    if (stats.live > stats.maxLive) stats.maxLive = stats.live;
  }
  close(): void {
    // 本物の `VideoFrame.close()` は 2 回呼んでも害が無い ── 数え間違えないよう 1 回だけ数える
    if (this.closed) return;
    this.closed = true;
    this.stats.closed += 1;
    this.stats.live -= 1;
  }
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function fakeCodecApi(opts: FakeOptions = {}): { api: CodecApi; stats: FakeStats } {
  const stats: FakeStats = {
    created: 0,
    closed: 0,
    live: 0,
    maxLive: 0,
    encoders: 0,
    decoders: 0,
    encodeCalls: [],
    decodeCalls: [],
    probeFrames: 0,
    encoderClosed: 0,
    decoderClosed: 0,
  };
  let encodeCount = 0;
  let decodeCount = 0;

  const api: CodecApi = {
    createEncoder(init): EncoderLike {
      stats.encoders += 1;
      let pending = 0;
      let closed = false;
      const jobs: Promise<void>[] = [];
      return {
        get encodeQueueSize(): number {
          return pending;
        },
        configure: () => {},
        encode(frame, options): void {
          const f = frame as FakeFrame;
          const n = encodeCount;
          encodeCount += 1;
          stats.encodeCalls.push({ index: f.index, keyFrame: options?.keyFrame });
          if (opts.throwAtEncode === n) throw new Error('encode が投げた');
          const key = options?.keyFrame === true;
          pending += 1;
          const ts = f.timestamp;
          const idx = f.index;
          jobs.push(
            (async () => {
              await tick(opts.encodeDelayMs ?? 0);
              pending -= 1;
              if (closed) return;
              if (opts.encoderBroken === true || opts.errorAtEncode === n) {
                init.error(new Error('encode の error'));
                return;
              }
              if (opts.dropAtEncode === n) return;
              // 本物の VP8 符号化器は、最初の 1 枚は頼まなくてもキーフレームにする。この偽物は**頼まれないと差分**にする
              // (頼み忘れが緑のまま通らないように ── 頼んだ 1 枚だけがキーフレーム)
              const type: 'key' | 'delta' = key ? 'key' : 'delta';
              const out: EncodedOut = {
                type,
                timestamp: ts,
                data: Uint8Array.of(type === 'key' ? 0x10 : 0x11, 0, 0, idx & 0xff, (idx >> 8) & 0xff, 0xee),
              };
              init.output(out);
            })(),
          );
        },
        async flush(): Promise<void> {
          await Promise.all(jobs);
        },
        close(): void {
          closed = true;
          stats.encoderClosed += 1;
        },
      };
    },
    createDecoder(init): DecoderLike {
      stats.decoders += 1;
      let pending = 0;
      let gotKey = false;
      let closed = false;
      const jobs: Promise<void>[] = [];
      return {
        get decodeQueueSize(): number {
          return pending;
        },
        configure: () => {},
        decode(chunk): void {
          const n = decodeCount;
          decodeCount += 1;
          const idx = chunk.data[3]! | (chunk.data[4]! << 8);
          stats.decodeCalls.push({ index: idx, type: chunk.type });
          pending += 1;
          jobs.push(
            (async () => {
              await tick(opts.decodeDelayMs ?? 0);
              pending -= 1;
              if (closed) return;
              if (chunk.type === 'key') gotKey = true;
              if (!gotKey) {
                init.error(new Error('キーフレームの前に差分が来た'));
                return;
              }
              if (opts.errorAtDecode === n) {
                init.error(new Error('decode の error'));
                return;
              }
              if (opts.decoderSilent === true) return;
              init.output(new FakeFrame(chunk.timestamp, idx, stats));
            })(),
          );
        },
        async flush(): Promise<void> {
          await Promise.all(jobs);
        },
        close(): void {
          closed = true;
          stats.decoderClosed += 1;
        },
      };
    },
    makeProbeFrame(): FrameLike {
      stats.probeFrames += 1;
      return new FakeFrame(0, 0, stats);
    },
  };
  return { api, stats };
}
