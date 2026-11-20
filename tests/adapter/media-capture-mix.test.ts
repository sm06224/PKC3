/**
 * 🔴 **画面録画に共有の音とマイクを混ぜる**(#1985 項目 3。user 裁定 2026-11-20 案 A)。
 *
 * 守る主張:
 * 1. 混ぜた経路: 器へ渡る stream は「映像 + 混ぜ場の音」(共有の音そのものでも、マイクそのものでもない)
 * 2. 🔴 どの終わり方(止める / 捨てる / 共有停止 / 器が作れない)でも `AudioContext.close()` と**全 track の stop**
 *    (共有 + マイク + 混ぜた物)── ブラウザのマイク表示を残さない
 * 3. 退避: マイク拒否(知らせ 1 度)/ 共有に音が無い(マイクだけ)/ AudioContext 無し(共有そのまま)/ 設定が切(マイクを頼まない)
 * 4. 250MB の切り分けでも**同じ混ぜた stream**を使い、`AudioContext` を作り直さない
 */
/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { startCapture, type CaptureDeps } from '../../src/adapter/platform/media-capture';

type FTrack = MediaStreamTrack & { fire: () => void; stopped: () => boolean };
function track(kind: 'audio' | 'video'): FTrack {
  let stopped = false;
  const ls: Array<() => void> = [];
  return {
    kind,
    stop: () => {
      stopped = true;
    },
    addEventListener: (_t: string, fn: () => void) => ls.push(fn),
    fire: () => ls.forEach((f) => f()),
    stopped: () => stopped,
  } as unknown as FTrack;
}
class FStream {
  constructor(readonly tracks: FTrack[]) {}
  getTracks(): FTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks(): FTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

function fakeAudioContext(): { AC: typeof AudioContext; made: () => FCtx[] } {
  const made: FCtx[] = [];
  class FCtx {
    closed = 0;
    sources: FStream[] = [];
    destTrack = track('audio');
    close(): Promise<void> {
      this.closed += 1;
      return Promise.resolve();
    }
    createMediaStreamDestination(): { stream: FStream } {
      return { stream: new FStream([this.destTrack]) };
    }
    createMediaStreamSource(s: FStream): { connect: () => void } {
      this.sources.push(s);
      return { connect: () => undefined };
    }
    constructor() {
      made.push(this);
    }
  }
  return { AC: FCtx as unknown as typeof AudioContext, made: () => made };
}

function recorder(): { Recorder: typeof MediaRecorder; streams: FStream[]; push: (n: number) => void } {
  const streams: FStream[] = [];
  let cur: { ondataavailable: ((e: BlobEvent) => void) | null } | null = null;
  class R {
    state = 'inactive';
    mimeType = 'video/webm';
    ondataavailable: ((e: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(s: FStream) {
      streams.push(s);
      cur = this;
    }
    start(): void {
      this.state = 'recording';
    }
    stop(): void {
      this.state = 'inactive';
      this.onstop?.();
    }
  }
  return {
    Recorder: R as unknown as typeof MediaRecorder,
    streams,
    push: (n) => cur!.ondataavailable?.({ data: new Blob(['x'.repeat(n)]) } as BlobEvent),
  };
}

const OPTS = { partBytes: 1_000_000, maxMs: 12 * 3600_000 };

function setup(over: {
  displayAudio?: boolean;
  mic?: 'ok' | 'denied' | 'missing' | 'none';
  noAC?: boolean;
  noMS?: boolean;
}) {
  const dv = track('video');
  const da = track('audio');
  const display = new FStream(over.displayAudio === false ? [dv] : [dv, da]);
  const micTrack = track('audio');
  const mic = new FStream([micTrack]);
  const ac = fakeAudioContext();
  const rec = recorder();
  const calls: { display: unknown[]; mic: unknown[] } = { display: [], mic: [] };
  const mode = over.mic ?? 'ok';
  const deps: CaptureDeps = {
    getDisplayMedia: async (c) => {
      calls.display.push(c);
      return display as unknown as MediaStream;
    },
    ...(mode === 'none'
      ? {}
      : {
          getUserMedia: async (c) => {
            calls.mic.push(c);
            if (mode === 'denied') throw Object.assign(new Error('x'), { name: 'NotAllowedError' });
            if (mode === 'missing') throw Object.assign(new Error('x'), { name: 'NotFoundError' });
            return mic as unknown as MediaStream;
          },
        }),
    Recorder: rec.Recorder,
    ...(over.noAC === true ? { AudioContext: undefined } : { AudioContext: ac.AC }),
    MediaStream: (over.noMS === true ? undefined : FStream) as unknown as typeof MediaStream,
  };
  return { deps, dv, da, micTrack, display, mic, ac, rec, calls };
}

async function start(
  s: ReturnType<typeof setup>,
  o: { mixMic?: boolean; partBytes?: number } = {},
) {
  const notices: string[] = [];
  const ends: string[] = [];
  const h = await startCapture('screen', s.deps, {
    ...OPTS,
    partBytes: o.partBytes ?? OPTS.partBytes,
    mixMic: o.mixMic ?? true,
    onNotice: (t) => notices.push(t),
    onEnd: (r) => ends.push(r),
  });
  return { h, notices, ends };
}

describe('混ぜた経路', () => {
  it('器へ渡る stream は 映像 + 混ぜ場の音(共有・マイクそのものではない)。マイクはエコー除去つきで頼む', async () => {
    const s = setup({});
    await start(s);
    const rs = s.rec.streams[0]!;
    expect(rs.getVideoTracks()).toEqual([s.dv]);
    expect(rs.getAudioTracks()).toEqual([s.ac.made()[0]!.destTrack]);
    expect(rs.getAudioTracks()).not.toContain(s.da);
    expect(rs.getAudioTracks()).not.toContain(s.micTrack);
    // 混ぜ場へ入ったのは共有とマイクの 2 本
    expect(s.ac.made()[0]!.sources).toEqual([s.display, s.mic]);
    expect(s.calls.mic[0]).toEqual({ audio: { echoCancellation: true, noiseSuppression: true } });
    // 共有はシステム音声を勧める指定つきで頼む
    expect(s.calls.display[0]).toMatchObject({ video: true, audio: true, systemAudio: 'include' });
  });

  it('止めたら混ぜ場を閉じ、共有・マイク・混ぜた物の track を全部止める', async () => {
    const s = setup({});
    const { h } = await start(s);
    s.rec.push(3);
    await h.stop();
    expect(s.ac.made()[0]!.closed).toBe(1);
    for (const t of [s.dv, s.da, s.micTrack, s.ac.made()[0]!.destTrack]) expect(t.stopped()).toBe(true);
  });

  it('捨てても同じ(閉じる・全部止める)', async () => {
    const s = setup({});
    const { h } = await start(s);
    h.discard();
    expect(s.ac.made()[0]!.closed).toBe(1);
    for (const t of [s.dv, s.da, s.micTrack]) expect(t.stopped()).toBe(true);
  });

  it('共有の「停止」(ended)でも閉じる・マイクも止める。⚠ マイクだけが抜けても録画は続く', async () => {
    const s = setup({});
    const { h, ends } = await start(s);
    s.micTrack.fire();
    expect(ends).toEqual([]);
    expect(s.ac.made()[0]!.closed).toBe(0);
    s.dv.fire();
    expect(ends).toEqual(['shared-ended']);
    expect(s.ac.made()[0]!.closed).toBe(1);
    expect(s.micTrack.stopped()).toBe(true);
    await h.stop();
    expect(s.ac.made()[0]!.closed).toBe(1);
  });

  it('器を作れなくて投げる回も、混ぜ場とマイクを残さない', async () => {
    const s = setup({});
    s.deps = {
      ...s.deps,
      Recorder: class {
        constructor() {
          throw new Error('nope');
        }
      } as unknown as typeof MediaRecorder,
    };
    await expect(start(s)).rejects.toThrow();
    expect(s.ac.made()[0]!.closed).toBe(1);
    for (const t of [s.dv, s.da, s.micTrack]) expect(t.stopped()).toBe(true);
  });

  it('切り分けても同じ混ぜた stream を渡し、AudioContext を作り直さない', async () => {
    const s = setup({});
    const { h } = await start(s, { partBytes: 5 });
    s.rec.push(6); // 5 を超える → 切って次の器
    expect(s.rec.streams.length).toBe(2);
    expect(s.rec.streams[1]).toBe(s.rec.streams[0]);
    expect(s.ac.made().length).toBe(1);
    expect(s.ac.made()[0]!.closed).toBe(0);
    await h.stop();
    expect(s.ac.made()[0]!.closed).toBe(1);
  });
});

describe('退避', () => {
  it('マイク拒否: 共有そのままで録り、知らせは 1 度。共有の track は止まる', async () => {
    const s = setup({ mic: 'denied' });
    const { h, notices } = await start(s);
    expect(s.rec.streams[0]).toBe(s.display);
    expect(s.ac.made().length).toBe(0);
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('マイクが使えない');
    await h.stop();
    expect(s.dv.stopped() && s.da.stopped()).toBe(true);
  });

  it('マイクが無い(NotFound)・口そのものが無い回も同じ退避', async () => {
    for (const mic of ['missing', 'none'] as const) {
      const s = setup({ mic });
      const { notices } = await start(s);
      expect(s.rec.streams[0]).toBe(s.display);
      expect(notices.length).toBe(1);
    }
  });

  it('共有に音が無い: マイクだけを録る(映像 + マイクの音)。音声共有の案内を 1 度', async () => {
    const s = setup({ displayAudio: false });
    const { h, notices } = await start(s);
    const rs = s.rec.streams[0]!;
    expect(rs.getVideoTracks()).toEqual([s.dv]);
    expect(rs.getAudioTracks()).toEqual([s.micTrack]);
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('音声を共有');
    await h.stop();
    expect(s.micTrack.stopped()).toBe(true);
  });

  it('共有に音が無く、マイクも使えない: 映像だけ(従来どおり)', async () => {
    const s = setup({ displayAudio: false, mic: 'denied' });
    const { notices } = await start(s);
    expect(s.rec.streams[0]).toBe(s.display);
    expect(notices.length).toBe(1);
  });

  it('AudioContext が無い: 共有そのまま(従来どおり)で、マイクは止める。知らせ 1 度', async () => {
    const s = setup({ noAC: true });
    const { h, notices } = await start(s);
    expect(s.rec.streams[0]).toBe(s.display);
    expect(notices.length).toBe(1);
    await h.stop();
    expect(s.micTrack.stopped()).toBe(true);
  });

  it('設定が切: マイクを頼まず、AudioContext も作らず、知らせも出さない', async () => {
    const s = setup({});
    const { h, notices } = await start(s, { mixMic: false });
    expect(s.calls.mic.length).toBe(0);
    expect(s.ac.made().length).toBe(0);
    expect(s.rec.streams[0]).toBe(s.display);
    expect(notices).toEqual([]);
    await h.stop();
  });

  it('混ぜ場を作る途中で投げたら、共有のまま録りマイクと混ぜ場をその場で止める', async () => {
    const s = setup({});
    s.deps = {
      ...s.deps,
      AudioContext: class {
        close(): Promise<void> {
          return Promise.resolve();
        }
        createMediaStreamDestination(): never {
          throw new Error('boom');
        }
      } as unknown as typeof AudioContext,
    };
    const { h, notices } = await start(s);
    expect(s.rec.streams[0]).toBe(s.display);
    expect(s.micTrack.stopped()).toBe(true);
    expect(notices.length).toBe(1);
    await h.stop();
  });

  it('getDisplayMedia が TypeError で断る実装なら、指定なしでやり直す(許可の拒否はやり直さない)', async () => {
    const s = setup({});
    const seen: unknown[] = [];
    s.deps = {
      ...s.deps,
      getDisplayMedia: async (c) => {
        seen.push(c);
        if ('systemAudio' in (c as object)) throw new TypeError('unknown');
        return s.display as unknown as MediaStream;
      },
    };
    await start(s);
    expect(seen).toEqual([
      { video: true, audio: true, systemAudio: 'include' },
      { video: true, audio: true },
    ]);
    const s2 = setup({});
    let n = 0;
    s2.deps = {
      ...s2.deps,
      getDisplayMedia: async () => {
        n += 1;
        throw Object.assign(new Error('x'), { name: 'NotAllowedError' });
      },
    };
    await expect(start(s2)).rejects.toThrow();
    expect(n).toBe(1);
  });
});
