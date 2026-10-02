/**
 * 録った音を **16kHz / mono の PCM** に直す(#772 段②)。
 *
 * ⚠ `AudioContext` は**メインスレッドにしか無い**(`decodeAudioData` は worker で使えない)ので、
 * ここはメインで呼ぶ。ただし**復号そのものはブラウザの内部で非同期に走る**(メインを塞がない)。
 * 🔑 コンテキストを **16kHz で作る**と、`decodeAudioData` が**その標本化率へ再標本化**する
 * (自前で再標本化しない)。
 *
 * ⚠ **作ったコンテキストは必ず閉じる**(閉じないと、1 回押すたびに音の経路が 1 つ残る)。
 * ⚠ 読めない音(壊れた file / 対応していない形)は**例外**で返す ── 呼び側が理由を言う。
 */
import { ASR_SAMPLE_RATE } from '@features/asr/asr-parts';
import { mixToMono } from '@features/asr/asr-pcm';

interface DecodeContext {
  decodeAudioData(buf: ArrayBuffer): Promise<{
    readonly numberOfChannels: number;
    getChannelData(i: number): Float32Array;
  }>;
  close(): Promise<void>;
}

export interface AsrDecodeDeps {
  /** 16kHz のコンテキストを作る(test が差し替える)。無ければ `null`。 */
  readonly create?: () => DecodeContext | null;
}

function defaultCreate(): DecodeContext | null {
  const g = globalThis as unknown as {
    AudioContext?: new (o: { sampleRate: number }) => DecodeContext;
    webkitAudioContext?: new (o: { sampleRate: number }) => DecodeContext;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  return Ctor === undefined ? null : new Ctor({ sampleRate: ASR_SAMPLE_RATE });
}

export async function decodeToMono16k(blob: Blob, deps: AsrDecodeDeps = {}): Promise<Float32Array> {
  const ctx = (deps.create ?? defaultCreate)();
  if (ctx === null) throw new Error('このブラウザは音を読み取る仕組みを持っていません');
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const channels: Float32Array[] = [];
    for (let i = 0; i < decoded.numberOfChannels; i++) channels.push(decoded.getChannelData(i));
    return mixToMono(channels);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
